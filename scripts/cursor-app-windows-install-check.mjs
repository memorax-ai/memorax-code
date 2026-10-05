import { execFile } from "node:child_process";
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, win32 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { resolveLatest } from "./cursor-app-release.mjs";
import { prepareCursorWindowsControllerDirectory, selectCursorWindowsRelease } from "./cursor-app-windows-artifact.mjs";

const executeFile = promisify(execFile);
const prefix = "CURSOR_APP_WINDOWS_INSTALL_";
const controllerSources = ["cursor-app-windows-isolation-check.ps1", "cursor-app-windows-owned-session.cs",
  "cursor-app-windows-wfp.cpp", "cursor-app-windows-isolation-probe.mjs", "cursor-app-windows-installed.mjs",
  "cursor-app-windows-artifact.mjs", "cursor-app-windows-authenticode.ps1", "cursor-app-release.mjs",
  "cursor-app-apt.mjs", "fixtures/cursor-app/provenance.json"];
function failure(suffix) { const code = prefix + suffix; return Object.assign(new Error(code), { code }); }
function check(value, suffix) { if (!value) throw failure(suffix); }
function safeCode(code) { return /^CURSOR_(?:APP_WINDOWS_(?:INSTALL|ARTIFACT)|RELEASE)_[A-Z0-9_]{1,80}$/.test(code ?? "") ? code : prefix + "FAILED"; }

export async function prepareInstallController(root, { prepareDirectory = prepareCursorWindowsControllerDirectory } = {}) {
  const bundle = join(root, "controller"), runtime = join(root, "prepare-runtime");
  await mkdir(bundle, { mode: 0o700 }); await mkdir(runtime, { mode: 0o700 });
  await prepareDirectory({ directory: bundle, runtimeDirectory: runtime });
  for (const relative of controllerSources) {
    const target = join(bundle, relative);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(fileURLToPath(new URL(relative, import.meta.url)), target);
  }
  const node = join(bundle, "node.exe");
  await copyFile(process.execPath, node);
  const artifact = await import(pathToFileURL(join(bundle, "cursor-app-windows-artifact.mjs")).href);
  return { root: bundle, node, coordinator: join(bundle, "cursor-app-windows-isolation-check.ps1"),
    useInstaller: artifact.withVerifiedCursorWindowsInstaller };
}

export function installationEvidence(value, release) {
  check(value?.schemaVersion === 1 && value.kind === "restricted-installer-proof" && value.platform === "win32"
    && ["PASS", "FAIL"].includes(value.status) && value.nativeAcceptance === false
    && value.appLaunchRequested === false && value.externalProbes === false, "REPORT");
  const keys = ["processHandlesClosed", "wfpObjectsRemoved", "userRemoved", "ownedFilesRemoved", "profileRemoved"];
  check(value.cleanup?.bounded === true && keys.every((key) => typeof value.cleanup[key] === "boolean"), "REPORT");
  const clean = keys.every((key) => value.cleanup[key]);
  if (value.status !== "PASS") {
    const error = failure("COORDINATOR_FAILED");
    error.processesClosed = clean;
    error.diagnostic = {
      stage: ["guard", "setup", "fixtures", "baseline", "firewall", "restricted", "install-profile", "install-run",
        "installed-app-verification", "cleanup"].includes(value.stage) ? value.stage : "unknown",
      errorCode: /^CURSOR_APP_WINDOWS_[A-Z0-9_]{1,80}$/.test(value.errorCode ?? "") ? value.errorCode : prefix + "FAILED",
      cleanup: Object.fromEntries(keys.map((key) => [key, value.cleanup[key]])),
    };
    if (["node-lookup", "probe-directory", "node-preflight", "controller-directory", "controller-runtime",
      "wfp-build", "account-create", "account-acl"].includes(value.setupStep)) error.diagnostic.setupStep = value.setupStep;
    for (const [key, pattern] of [["sessionErrorCode", /^CURSOR_APP_WINDOWS_SESSION_[A-Z0-9_]{1,80}$/],
      ["sessionCleanupErrorCode", /^CURSOR_APP_WINDOWS_SESSION_[A-Z0-9_]{1,80}$/],
      ["installedVerifierErrorCode", /^CURSOR_APP_WINDOWS_ARTIFACT_[A-Z0-9_]{1,80}$/]]) {
      if (pattern.test(value[key] ?? "")) error.diagnostic[key] = value[key];
    }
    if (["CURSOR_APP_WINDOWS_SESSION_PROFILE_CREATE", "CURSOR_APP_WINDOWS_SESSION_PROFILE_EXISTS"].includes(value.sessionErrorCode)
      && Number.isSafeInteger(value.sessionNativeHResult) && value.sessionNativeHResult > 0 && value.sessionNativeHResult <= 0xffffffff) {
      error.diagnostic.sessionNativeHResult = value.sessionNativeHResult;
    }
    throw error;
  }
  const required = ["freshStandardUser", "baselineFixturesReachable", "parentChildGrandchildSameSid", "allowedLoopback",
    "deniedLoopback", "controllerStillReachesDenied", "filtersSurviveEngineClose", "udpDenied", "mappedIpv6Denied"];
  check(clean && value.stage === "done" && required.every((key) => value.evidence?.[key] === true)
    && value.counts?.processLevels === 3 && value.counts.verifiedTokens === 6 && value.counts.deniedAttempts === 18
    && value.installation?.installerStarted === true && value.installation.profileLoaded === true
    && value.installation.installerExitCode === 0 && value.installation.jobEmpty === true
    && ["appIdentityVerified", "appArchitectureVerified", "authenticodeVerified", "publisherVerified"]
      .every((key) => value.installation[key] === true), "REPORT");
  return { channel: release.channel, version: release.version, commitSha: release.commitSha, status: "PASS",
    installerExecuted: true, installerExitCode: 0, profileLoaded: true, jobEmpty: true,
    appIdentityVerified: true, appArchitectureVerified: true, authenticodeVerified: true, publisherVerified: true,
    isolationVerified: true, cleanupVerified: true };
}

export async function runRestrictedInstaller(context, { root, environment, controller, execute = executeFile } = {}) {
  const descriptor = join(root, "release.json"), reportPath = join(root, "install-report.json");
  await writeFile(descriptor, JSON.stringify(context.release), { flag: "wx", mode: 0o600 });
  const powershell = "C:\\Program Files\\PowerShell\\7", system = "C:\\Windows";
  const env = { SystemRoot: system, WINDIR: system, COMSPEC: win32.join(system, "System32", "cmd.exe"),
    SystemDrive: "C:", ProgramFiles: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)",
    ProgramW6432: "C:\\Program Files", PATH: `${dirname(controller.node)};${powershell};${system}\\System32`,
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    PSModulePath: `${powershell}\\Modules;${system}\\System32\\WindowsPowerShell\\v1.0\\Modules`,
    HOME: root, USERPROFILE: root, APPDATA: join(root, "AppData", "Roaming"),
    LOCALAPPDATA: join(root, "AppData", "Local"), TEMP: root, TMP: root };
  for (const key of ["GITHUB_ACTIONS", "RUNNER_ENVIRONMENT", "RUNNER_OS", "ImageOS", "GITHUB_RUN_ID", "RUNNER_TEMP", "COMPUTERNAME"]) {
    if (typeof environment[key] === "string") env[key] = environment[key];
  }
  let result, commandError, close, mustClose = execute === executeFile;
  try {
    const pending = execute(win32.join(powershell, "pwsh.exe"), ["-NoLogo", "-NoProfile", "-NonInteractive", "-File",
      controller.coordinator, "-ReportPath", reportPath, "-InstallerPath", context.installerPath,
      "-InstallerSha256", context.artifact.observedSha256, "-ReleasePath", descriptor], {
      cwd: root, env, windowsHide: true, encoding: "utf8", timeout: 540_000, maxBuffer: 4096, killSignal: "SIGKILL",
    });
    if (pending?.child) {
      mustClose = true;
      close = new Promise((done) => pending.child.once("close", () => done(true)));
    }
    result = await pending;
  } catch (error) { commandError = error; }
  let timer;
  const closed = !mustClose || (close && await Promise.race([close, new Promise((done) => {
    timer = setTimeout(() => done(false), 5000);
  })]));
  clearTimeout(timer);
  check(closed, "PROCESS_CLEANUP");
  const output = result ?? commandError;
  check(output && output.stdout === "" && output.stderr === "" && !output.killed
    && (output.code === undefined || output.code === 0 || output.code === 1), "COORDINATOR_EXIT");
  const stat = await lstat(reportPath);
  check(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 16384, "REPORT");
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  try {
    const evidence = installationEvidence(report, context.release);
    check(!commandError, "COORDINATOR_EXIT");
    context.confirmProcessesClosed();
    return evidence;
  } catch (error) {
    if (error.processesClosed === true) context.confirmProcessesClosed();
    throw error;
  }
}

export async function runWindowsInstallCheck(reportDirectory, { environment = process.env, platform = process.platform,
  arch = process.arch, nodeMajor = process.versions.node.split(".")[0], resolveReleases = resolveLatest,
  prepareController = prepareInstallController, install = runRestrictedInstaller } = {}) {
  const report = { schemaVersion: 1, kind: "restricted-installer-proof", platform: "win32", status: "FAIL", stage: "guard",
    appLaunchRequested: false, nativeAcceptance: false, trustPolicyChanged: false, releases: [], cleanup: { ownedFilesRemoved: false } };
  report.scope = "windows-wfp-user-tcp-allowlist-udp-bind-block";
  report.dnsBrokerIsolation = "not-verified"; report.otherSidBrokerIsolation = "not-enforced";
  let output, root, preserve = false;
  try {
    check(platform === "win32" && arch === "x64" && nodeMajor === "24" && environment.GITHUB_ACTIONS === "true"
      && environment.RUNNER_ENVIRONMENT === "github-hosted" && environment.RUNNER_OS === "Windows"
      && ["win25", "win25-vs2026"].includes(environment.ImageOS) && /^\d+$/.test(environment.GITHUB_RUN_ID ?? ""), "RUNNER");
    check(typeof environment.RUNNER_TEMP === "string" && isAbsolute(environment.RUNNER_TEMP)
      && typeof reportDirectory === "string" && isAbsolute(reportDirectory), "OUTPUT");
    const temp = await realpath(environment.RUNNER_TEMP);
    check(await realpath(dirname(resolve(reportDirectory))) === temp, "OUTPUT");
    await mkdir(reportDirectory, { mode: 0o700 });
    output = await realpath(reportDirectory);
    root = await mkdtemp(join(temp, "cursor-windows-install-"));
    report.stage = "release-resolution";
    const manifest = await resolveReleases();
    const releases = ["baseline", "latest"].map((channel) => selectCursorWindowsRelease(manifest, channel));
    report.stage = "controller-preparation";
    const controller = await prepareController(root);
    for (const release of releases) {
      report.stage = "restricted-installation";
      const entry = { channel: release.channel, version: release.version, commitSha: release.commitSha, status: "FAIL" };
      report.releases.push(entry);
      const scratch = await mkdtemp(join(controller.root, release.channel + "-"));
      const { verification, result } = await controller.useInstaller({ release, root: scratch, platform },
        (context) => install(context, { root: scratch, environment, controller }));
      check(verification.ownedFilesRemoved === true && verification.authenticodeVerified === true
        && verification.publisherVerified === true && verification.version === release.version
        && verification.commitSha === release.commitSha && verification.channel === release.channel, "RECEIPT");
      const booleans = ["installerExecuted", "profileLoaded", "jobEmpty", "appIdentityVerified", "appArchitectureVerified",
        "authenticodeVerified", "publisherVerified", "isolationVerified", "cleanupVerified"];
      check(result?.status === "PASS" && result.channel === release.channel && result.version === release.version
        && result.commitSha === release.commitSha && result.installerExitCode === 0
        && booleans.every((key) => result[key] === true), "RECEIPT");
      Object.assign(entry, { status: "PASS", installerExitCode: 0 }, Object.fromEntries(booleans.map((key) => [key, true])));
    }
    report.status = "PASS"; report.stage = "done";
  } catch (error) {
    report.errorCode = safeCode(error?.code);
    if (error?.diagnostic) report.diagnostic = error.diagnostic;
    if (error?.cleanupErrorCode) { preserve = true; report.cleanupErrorCode = safeCode(error.cleanupErrorCode); }
  } finally {
    if (root && !preserve) {
      try { await rm(root, { recursive: true, force: true }); report.cleanup.ownedFilesRemoved = true; }
      catch { report.status = "FAIL"; report.cleanupErrorCode = prefix + "STATE_CLEANUP"; }
    }
    if (output) await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    check(process.argv.length === 3, "ARGUMENTS");
    const report = await runWindowsInstallCheck(process.argv[2]);
    console.log(JSON.stringify(report));
    if (report.status !== "PASS") process.exitCode = 1;
  } catch (error) { console.error(safeCode(error?.code)); process.exitCode = 1; }
}
