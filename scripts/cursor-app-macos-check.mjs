import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { projectNativeReport, readReleaseManifest } from "./cursor-app-container-check.mjs";
import { runMacosIsolationProof, projectMacosNetworkDiagnostic } from "./cursor-app-macos-isolation-check.mjs";
import { selectCursorMacosRelease, withCursorMacosApp } from "./cursor-app-macos-artifact.mjs";

const exec = promisify(execFile);
const scripts = dirname(fileURLToPath(import.meta.url));
function check(value, code) { if (!value) throw Object.assign(new Error(code), { code }); }
function safeCode(error) {
  return /^CURSOR_(?:APP|CONTAINER)_[A-Z0-9_]{1,100}$/.test(error?.code ?? "") ? error.code : "CURSOR_APP_MACOS_CHECK_FAILED";
}

export function macosCheckEnvironment(root, nodePath) {
  return { PATH: `${posix.dirname(nodePath)}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: posix.join(root, "home"),
    CFFIXED_USER_HOME: posix.join(root, "home"), TMPDIR: posix.join(root, "tmp"), TMP: posix.join(root, "tmp"), TEMP: posix.join(root, "tmp"),
    npm_config_cache: posix.join(root, "npm-cache"), GITHUB_ACTIONS: "true", RUNNER_OS: "macOS", LANG: "en_US.UTF-8" };
}

export async function runMacosCheck(candidatePath, reportPath, { releaseManifest, channel, nodeMajor = "24", signal } = {}) {
  let root, output, artifact, nativeStarted = false, cleanupFailed = false;
  let report = { status: "FAIL", client: "cursor", kind: "app-native-session-flows", platform: "darwin", stage: "macos-preflight", evidence: {} };
  try {
    // A network-only sandbox and isolated HOME do not prove Keychain isolation.
    // This entrypoint is restricted to the workflow's fresh hosted macOS runner.
    check(process.platform === "darwin" && process.arch === "arm64" && process.env.GITHUB_ACTIONS === "true"
      && process.env.RUNNER_OS === "macOS", "CURSOR_APP_MACOS_RUNNER");
    check(nodeMajor === "24" && process.versions.node.split(".")[0] === nodeMajor, "CURSOR_APP_MACOS_NODE");
    check(typeof candidatePath === "string" && typeof reportPath === "string"
      && !/[\0\r\n]/.test(candidatePath + reportPath), "CURSOR_APP_MACOS_ARGUMENTS");
    const candidate = resolve(candidatePath), destination = resolve(reportPath);
    const candidateInfo = await lstat(candidate);
    check(candidateInfo.isFile() && !candidateInfo.isSymbolicLink(), "CURSOR_APP_MACOS_CANDIDATE");
    await mkdir(destination, { recursive: true, mode: 0o700 });
    const outputInfo = await lstat(destination);
    check(outputInfo.isDirectory() && !outputInfo.isSymbolicLink() && (await readdir(destination)).length === 0,
      "CURSOR_APP_MACOS_OUTPUT");
    output = await realpath(destination);
    const release = selectCursorMacosRelease(releaseManifest, channel);
    const proof = await runMacosIsolationProof({ signal });
    if (proof.status !== "PASS") report.networkIsolationFailure = projectMacosNetworkDiagnostic(proof.diagnostic);
    check(proof.status === "PASS", proof.errorCode ?? "CURSOR_APP_MACOS_PROOF_FAILED");
    report.evidence.networkIsolation = true;
    root = await realpath(await mkdtemp(join(tmpdir(), "memorax-cursor-macos-ci-")));
    const env = macosCheckEnvironment(root, process.execPath);
    await mkdir(env.HOME, { mode: 0o700 }); await mkdir(env.TMPDIR, { mode: 0o700 });
    const npmConfig = join(root, "empty.npmrc");
    await writeFile(npmConfig, "", { flag: "wx", mode: 0o600 });
    const npm = join(dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js");
    for (const [prefix, target] of [["candidate", candidate], ["probe", "playwright-core@1.58.2"]]) {
      await exec(process.execPath, [npm, "install", "--prefix", join(root, prefix), "--ignore-scripts", "--no-audit", "--no-fund",
        "--package-lock=false", "--registry=https://registry.npmjs.org/", "--userconfig", npmConfig, "--globalconfig", npmConfig, target],
      { cwd: root, env, timeout: 180_000, signal, maxBuffer: 1024 * 1024 });
    }
    report.stage = "macos-acquisition";
    await withCursorMacosApp({ release, root, signal }, async ({ appPath, evidence }) => {
      artifact = evidence;
      const nativeOutput = join(root, "native-report");
      nativeStarted = true;
      let executionError;
      try {
        await exec(process.execPath, [join(scripts, "cursor-app-native-check.mjs"),
          join(root, "candidate/node_modules/@memorax/memorax-code"), appPath, release.version,
          join(root, "probe/node_modules/playwright-core"), nativeOutput, nodeMajor],
        { cwd: root, env, timeout: 10 * 60_000, signal, maxBuffer: 1024 * 1024, killSignal: "SIGKILL" });
      } catch (error) { executionError = error; }
      const path = join(nativeOutput, "report.json"), info = await lstat(path);
      check(info.isFile() && !info.isSymbolicLink() && info.size <= 64 * 1024, "CURSOR_APP_MACOS_REPORT");
      report = projectNativeReport(JSON.parse(await readFile(path, "utf8")),
        { expectedVersion: release.version, nodeMajor, platform: "darwin" });
      check(!executionError && report.status === "PASS", "CURSOR_APP_MACOS_NATIVE_EXIT");
    });
  } catch (error) {
    report.status = "FAIL";
    report.errorCode ??= safeCode(error);
    if (error.cleanupErrorCode) { cleanupFailed = true; report.cleanupError = safeCode({ code: error.cleanupErrorCode }); }
  } finally {
    // A busy mounted App or unverified descendant must remain for runner teardown.
    if (root && !cleanupFailed && (!nativeStarted || report.evidence.cleanup === true)) {
      try { await rm(root, { recursive: true, force: true }); }
      catch { cleanupFailed = true; report.cleanupError = "CURSOR_APP_MACOS_STATE_CLEANUP"; }
    } else if (root) cleanupFailed = true;
    if (cleanupFailed) { report.status = "FAIL"; report.cleanupError ??= "CURSOR_APP_MACOS_CLEANUP"; }
    if (artifact) report.macos = artifact;
    if (output) await writeFile(join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const abort = new AbortController();
  process.once("SIGINT", () => abort.abort()); process.once("SIGTERM", () => abort.abort());
  try {
    check(process.argv.length === 7, "CURSOR_APP_MACOS_ARGUMENTS");
    const report = await runMacosCheck(process.argv[2], process.argv[3], { releaseManifest: await readReleaseManifest(process.argv[4]),
      channel: process.argv[5], nodeMajor: process.argv[6], signal: abort.signal });
    console.log(JSON.stringify(report, null, 2));
    if (report.status !== "PASS") process.exitCode = 1;
  } catch (error) { console.error(safeCode(error)); process.exitCode = 1; }
}
