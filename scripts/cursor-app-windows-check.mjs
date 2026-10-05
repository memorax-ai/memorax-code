import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { projectNativeReport, readReleaseManifest } from "./cursor-app-container-check.mjs";
import { selectCursorWindowsRelease, verifyCursorWindowsInstalledApp, withVerifiedCursorWindowsInstaller } from "./cursor-app-windows-artifact.mjs";
import { windowsRuntimePaths } from "./cursor-app-windows-runtime.mjs";

const exec = promisify(execFile);
const scripts = dirname(fileURLToPath(import.meta.url));
const gitDirectory = "C:\\Program Files\\Git\\cmd";
function check(value, code) { if (!value) throw Object.assign(new Error(code), { code }); }
function safeCode(error) {
  return /^CURSOR_(?:APP|CONTAINER)_[A-Z0-9_]{1,100}$/.test(error?.code ?? "") ? error.code : "CURSOR_APP_WINDOWS_CHECK_FAILED";
}

export function windowsCheckEnvironment(root, nodePath, systemRoot = "C:\\Windows") {
  const { env } = windowsRuntimePaths({ root, nodePath, systemRoot,
    packageRoot: win32.join(root, "candidate", "node_modules", "@memorax", "memorax-code"),
    appPath: win32.join(root, "home", "AppData", "Local", "Programs", "Cursor", "Cursor.exe") });
  return { ...env, PATH: `${env.PATH};${gitDirectory}`, npm_config_cache: win32.join(root, "npm-cache"),
    GITHUB_ACTIONS: "true", RUNNER_OS: "Windows" };
}

export function windowsInstallerCommand(installerPath, appDirectory) {
  check([installerPath, appDirectory].every((value) => typeof value === "string" && win32.isAbsolute(value)
    && !/[\0\r\n"]/.test(value)), "CURSOR_APP_WINDOWS_ARGUMENTS");
  const quote = (value) => `'${value.replaceAll("'", "''")}'`;
  const args = ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/MERGETASKS=!runcode", `/DIR="${appDirectory}"`];
  // On Windows, Start-Process -Wait waits for the installer and its descendants.
  const script = `$ErrorActionPreference='Stop'; try { $installer=Start-Process -FilePath ${quote(installerPath)} `
    + `-ArgumentList ${args.map(quote).join(",")} -Wait -PassThru; `
    + `[ordered]@{status='exited';exitCode=$installer.ExitCode;nativeErrorCode=$null} | ConvertTo-Json -Compress; exit $installer.ExitCode `
    + `} catch { $native=$null; $current=$_.Exception; for($i=0;$i -lt 8 -and $null -ne $current;$i++) { `
    + `if($current -is [ComponentModel.Win32Exception]) { $native=$current.NativeErrorCode; break }; $current=$current.InnerException }; `
    + `[ordered]@{status='launch-error';exitCode=$null;nativeErrorCode=$native} | ConvertTo-Json -Compress; exit 1 }`;
  return ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
}

export function projectWindowsInstallerOutcome(stdout, error) {
  const integer = (value) => Number.isInteger(value) && value >= -2147483648 && value <= 2147483647;
  let status = "invalid-output";
  if (error?.code === "ABORT_ERR") status = "aborted";
  else if (error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") status = "output-overflow";
  else if (error?.code === "ETIMEDOUT" || (error?.killed === true && error.signal === "SIGKILL")) status = "timeout";
  else {
    try {
      const value = typeof stdout === "string" && Buffer.byteLength(stdout) <= 4096 ? JSON.parse(stdout) : null;
      if (value && Object.keys(value).sort().join(",") === "exitCode,nativeErrorCode,status"
        && ((value.status === "exited" && integer(value.exitCode) && value.nativeErrorCode === null)
          || (value.status === "launch-error" && value.exitCode === null && (value.nativeErrorCode === null || integer(value.nativeErrorCode))))) {
        return { status: value.status, exitCode: value.exitCode, nativeErrorCode: value.nativeErrorCode };
      }
    } catch { /* Never include raw PowerShell output or exception text. */ }
    if (error) status = "powershell-exit";
  }
  return { status, exitCode: integer(error?.code) ? error.code : null, nativeErrorCode: null };
}

export async function runWindowsCheck(candidatePath, reportPath, { releaseManifest, channel, nodeMajor = "24", signal } = {}) {
  let root, output, artifact, installerOutcome, nativeStarted = false, cleanupFailed = false;
  let report = { status: "FAIL", client: "cursor", kind: "app-native-session-flows", platform: "win32", stage: "windows-preflight", evidence: {} };
  try {
    // This uses the fresh hosted runner account, not a private Windows logon profile.
    check(process.platform === "win32" && process.arch === "x64" && process.env.GITHUB_ACTIONS === "true"
      && process.env.RUNNER_OS === "Windows", "CURSOR_APP_WINDOWS_RUNNER");
    check(nodeMajor === "24" && process.versions.node.split(".")[0] === nodeMajor, "CURSOR_APP_WINDOWS_NODE");
    check(typeof candidatePath === "string" && typeof reportPath === "string"
      && !/[\0\r\n]/.test(candidatePath + reportPath), "CURSOR_APP_WINDOWS_ARGUMENTS");
    const candidate = resolve(candidatePath), destination = resolve(reportPath);
    const candidateInfo = await lstat(candidate);
    check(candidateInfo.isFile() && !candidateInfo.isSymbolicLink(), "CURSOR_APP_WINDOWS_CANDIDATE");
    await mkdir(destination, { recursive: true, mode: 0o700 });
    const outputInfo = await lstat(destination);
    check(outputInfo.isDirectory() && !outputInfo.isSymbolicLink() && (await readdir(destination)).length === 0,
      "CURSOR_APP_WINDOWS_OUTPUT");
    output = await realpath(destination);
    const release = selectCursorWindowsRelease(releaseManifest, channel);
    root = await realpath(await mkdtemp(join(tmpdir(), "memorax-cursor-windows-ci-")));
    const env = windowsCheckEnvironment(root, process.execPath, process.env.SystemRoot);
    await mkdir(env.HOME, { mode: 0o700 }); await mkdir(env.TMPDIR, { mode: 0o700 });
    const git = join(gitDirectory, "git.exe"), gitInfo = await lstat(git);
    check(gitInfo.isFile() && !gitInfo.isSymbolicLink(), "CURSOR_APP_WINDOWS_GIT");
    report.stage = "windows-installation";
    const npmUserConfig = join(root, "empty-user.npmrc"), npmGlobalConfig = join(root, "empty-global.npmrc");
    await writeFile(npmUserConfig, "", { flag: "wx", mode: 0o600 });
    await writeFile(npmGlobalConfig, "", { flag: "wx", mode: 0o600 });
    const npm = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
    for (const [prefix, target] of [["candidate", candidate], ["probe", "playwright-core@1.58.2"]]) {
      try {
        await exec(process.execPath, [npm, "install", "--prefix", join(root, prefix), "--ignore-scripts", "--no-audit", "--no-fund",
          "--package-lock=false", "--registry=https://registry.npmjs.org/", "--userconfig", npmUserConfig, "--globalconfig", npmGlobalConfig, target],
        { cwd: root, env, timeout: 180_000, signal, maxBuffer: 1024 * 1024, windowsHide: true });
      } catch { check(false, prefix === "candidate" ? "CURSOR_APP_WINDOWS_CANDIDATE_INSTALL" : "CURSOR_APP_WINDOWS_PROBE_INSTALL"); }
    }
    const packageRoot = join(root, "candidate", "node_modules", "@memorax", "memorax-code");
    report.stage = "windows-package-smoke";
    try {
      await exec(process.execPath, [join(scripts, "cursor-npm-package-smoke.mjs"), packageRoot],
        { cwd: root, env, timeout: 180_000, signal, maxBuffer: 1024 * 1024, killSignal: "SIGKILL", windowsHide: true });
    } catch {
      cleanupFailed = true;
      check(false, "CURSOR_APP_WINDOWS_PACKAGE_SMOKE");
    }
    report.stage = "windows-acquisition";
    await withVerifiedCursorWindowsInstaller({ release, root, signal }, async ({ installerPath, confirmProcessesClosed }) => {
      let installerClosed = false;
      artifact = { installerSignatureVerified: true, publisherVerified: true, appIdentityVerified: false, appArchitectureVerified: false };
      try {
        report.stage = "windows-app-installation";
        const appDirectory = join(env.LOCALAPPDATA, "Programs", "Cursor");
        try {
          const result = await exec(join(env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
            windowsInstallerCommand(installerPath, appDirectory),
            { cwd: root, env, timeout: 300_000, signal, maxBuffer: 64 * 1024, killSignal: "SIGKILL", windowsHide: true });
          installerOutcome = projectWindowsInstallerOutcome(result.stdout);
          check(installerOutcome.status === "exited" && installerOutcome.exitCode === 0, "CURSOR_APP_WINDOWS_INSTALLER_EXIT");
          installerClosed = true;
        } catch (error) {
          installerOutcome ??= projectWindowsInstallerOutcome(error.stdout, error);
          check(false, "CURSOR_APP_WINDOWS_INSTALLER_EXIT");
        }
        report.stage = "windows-app-verification";
        const installed = await verifyCursorWindowsInstalledApp({ release, root, profileRoot: env.HOME, appDirectory, signal });
        artifact.appIdentityVerified = installed.appIdentityVerified;
        artifact.appArchitectureVerified = installed.appArchitectureVerified;
        artifact.appSignatureVerified = installed.authenticodeVerified;
        report.stage = "windows-native";
        const nativeOutput = join(root, "native-report");
        nativeStarted = true;
        let executionError;
        try {
          await exec(process.execPath, [join(scripts, "cursor-app-native-check.mjs"), packageRoot,
            join(appDirectory, "Cursor.exe"), release.version, join(root, "probe", "node_modules", "playwright-core"), nativeOutput, nodeMajor],
          { cwd: root, env, timeout: 10 * 60_000, signal, maxBuffer: 1024 * 1024, killSignal: "SIGKILL", windowsHide: true });
        } catch (error) { executionError = error; }
        const path = join(nativeOutput, "report.json"), info = await lstat(path);
        check(info.isFile() && !info.isSymbolicLink() && info.size <= 64 * 1024, "CURSOR_APP_WINDOWS_REPORT");
        report = projectNativeReport(JSON.parse(await readFile(path, "utf8")),
          { expectedVersion: release.version, nodeMajor, platform: "win32" });
        check(!executionError && report.status === "PASS", "CURSOR_APP_WINDOWS_NATIVE_EXIT");
      } catch (error) {
        if (error.cleanupErrorCode) cleanupFailed = true;
        throw error;
      } finally {
        if (installerClosed && !cleanupFailed && (!nativeStarted || report.evidence.cleanup === true)) confirmProcessesClosed();
      }
    });
  } catch (error) {
    report.status = "FAIL";
    report.errorCode ??= safeCode(error);
    if (error.cleanupErrorCode) {
      cleanupFailed = true;
      report.artifactCleanupError = safeCode({ code: error.cleanupErrorCode });
      report.cleanupError ??= report.artifactCleanupError;
    }
  } finally {
    if (root && !cleanupFailed && (!nativeStarted || report.evidence.cleanup === true)) {
      try { await rm(root, { recursive: true, force: true }); }
      catch { cleanupFailed = true; report.cleanupError = "CURSOR_APP_WINDOWS_STATE_CLEANUP"; }
    } else if (root) cleanupFailed = true;
    if (cleanupFailed) { report.status = "FAIL"; report.cleanupError ??= "CURSOR_APP_WINDOWS_CLEANUP"; }
    if (artifact) report.windows = artifact;
    if (installerOutcome) report.windowsInstaller = installerOutcome;
    if (output) await writeFile(join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const abort = new AbortController();
  process.once("SIGINT", () => abort.abort()); process.once("SIGTERM", () => abort.abort());
  try {
    check(process.argv.length === 7, "CURSOR_APP_WINDOWS_ARGUMENTS");
    const report = await runWindowsCheck(process.argv[2], process.argv[3], { releaseManifest: await readReleaseManifest(process.argv[4]),
      channel: process.argv[5], nodeMajor: process.argv[6], signal: abort.signal });
    console.log(JSON.stringify(report, null, 2));
    if (report.status !== "PASS") process.exitCode = 1;
  } catch (error) { console.error(safeCode(error)); process.exitCode = 1; }
}
