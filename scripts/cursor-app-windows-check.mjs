import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
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

export function windowsInstallerCommand(installerPath, appDirectory, logPath) {
  check([installerPath, appDirectory, logPath].every((value) => typeof value === "string" && win32.isAbsolute(value)
    && !/[\0\r\n"]/.test(value)), "CURSOR_APP_WINDOWS_ARGUMENTS");
  const quote = (value) => `'${value.replaceAll("'", "''")}'`;
  const args = ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/MERGETASKS=!runcode", `/DIR="${appDirectory}"`, `/LOG="${logPath}"`];
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

const installerLogLimit = 1024 * 1024;

export function projectWindowsInstallerLog(bytes) {
  const result = { readStatus: "ok", category: "unknown", systemErrorCode: null };
  if (bytes.length > installerLogLimit) return { ...result, readStatus: "too-large" };
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.includes("\0")) throw new Error();
  } catch { return { ...result, readStatus: "invalid-encoding" }; }
  // Inno's format is not an API: recognize only fixed error text in one timestamped record.
  // Source: jrsoftware/issrc is-6_4_3, Setup.LoggingFunc.pas and Files/Default.isl.
  const records = text.matchAll(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} {3}([^\r\n]*(?:\r?\n {26}[^\r\n]*)*)/gm);
  let fileEntry = false, destinationPathLength;
  for (const record of records) {
    const message = record[1].replace(/\r?\n {26}/g, "\n");
    if (message === "Rolling back changes.") break;
    if (/^-- .+ entry --$/.test(message)) {
      fileEntry = message === "-- File entry --";
      destinationPathLength = undefined;
    }
    if (fileEntry && /^Dest filename: [^\n]+$/.test(message)) destinationPathLength = message.length - "Dest filename: ".length;
    const category = [
      ["directory", /^Setup was unable to create the directory "/m],
      ["file", /^(?:An error occurred while trying to (?:read the (?:existing|source) file|create a file in the destination directory|copy a file|replace the existing file|rename a file in the destination directory):|(?:CreateFile|DeleteFile|MoveFile|MoveFileEx) failed; code \d+\.)$/m],
      ["registry", /^(?:Error (?:opening|creating|writing to) registry key:|(?:RegSetValueEx|RegCreateKeyEx|RegOpenKeyEx) failed; code \d+\.)$/m],
      ["execute", /^(?:Unable to execute file:|(?:CreateProcess|ShellExecuteEx) failed; code \d+\.)$/m],
      ["exception", /^(?:Exception message:|Fatal exception during installation process \([A-Za-z0-9_]+\):)$/m],
    ].find(([, pattern]) => pattern.test(message))?.[0] ?? "unknown";
    const code = message.match(/^Error (\d{1,10}):[^\n]*$/m)?.[1]
      ?? message.match(/^(?:CreateFile|DeleteFile|MoveFile|MoveFileEx|RegSetValueEx|RegCreateKeyEx|RegOpenKeyEx|CreateProcess|ShellExecuteEx) failed; code (\d{1,10})\.$/m)?.[1];
    const systemErrorCode = code !== undefined && Number(code) <= 4294967295 ? Number(code) : null;
    if (category !== "unknown" || systemErrorCode !== null) {
      const details = {};
      if (category === "file") {
        const fileOperation = [
          ["read-existing", "read the existing file"], ["read-source", "read the source file"],
          ["create", "create a file in the destination directory"], ["copy", "copy a file"],
          ["replace", "replace the existing file"], ["rename", "rename a file in the destination directory"],
        ].find(([, action]) => message.split("\n").includes(`An error occurred while trying to ${action}:`))?.[0];
        const systemOperation = message.match(/^(CreateFile|DeleteFile|MoveFile|MoveFileEx) failed; code \d+\.$/m)?.[1];
        if (fileOperation) details.fileOperation = fileOperation;
        if (systemOperation) details.systemOperation = systemOperation;
        if (destinationPathLength !== undefined) details.destinationPathLength = destinationPathLength;
      }
      return { ...result, category, systemErrorCode, ...details };
    }
  }
  return result;
}

export async function readWindowsInstallerLog(path) {
  let handle;
  let result = { readStatus: "read-error", category: "unknown", systemErrorCode: null };
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) return { ...result, readStatus: "not-regular" };
    handle = await open(path, "r");
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino) return { ...result, readStatus: "changed" };
    const start = Math.max(0, info.size - installerLogLimit), position = start ? start - 1 : 0;
    const bytes = Buffer.alloc(info.size - position);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, position + length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await handle.stat();
    if (length !== bytes.length || after.size !== info.size || after.mtimeMs !== info.mtimeMs) result.readStatus = "changed";
    else {
      // One preceding byte preserves complete boundary lines; discard partial UTF-8 before decoding.
      const newline = start && bytes[0] !== 10 ? bytes.indexOf(10, 1) : -1;
      const offset = !start ? 0 : bytes[0] === 10 ? 1 : newline < 0 ? length : newline + 1;
      result = projectWindowsInstallerLog(bytes.subarray(offset, length));
      if (start && result.readStatus === "ok") result.readStatus = "tail";
    }
  } catch (error) { result.readStatus = error.code === "ENOENT" ? "missing" : "read-error"; }
  finally { try { await handle?.close(); } catch { result = { readStatus: "read-error", category: "unknown", systemErrorCode: null }; } }
  return result;
}

export async function runWindowsCheck(candidatePath, reportPath, { releaseManifest, channel, nodeMajor = "24", signal } = {}) {
  let root, output, artifact, installerOutcome, installerLog, nativeStarted = false, cleanupFailed = false;
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
        const appDirectory = join(env.LOCALAPPDATA, "Programs", "Cursor"), logPath = join(root, "installer.log");
        try {
          const result = await exec(join(env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
            windowsInstallerCommand(installerPath, appDirectory, logPath),
            { cwd: root, env, timeout: 300_000, signal, maxBuffer: 64 * 1024, killSignal: "SIGKILL", windowsHide: true });
          installerOutcome = projectWindowsInstallerOutcome(result.stdout);
          check(installerOutcome.status === "exited" && installerOutcome.exitCode === 0, "CURSOR_APP_WINDOWS_INSTALLER_EXIT");
          installerClosed = true;
        } catch (error) {
          installerOutcome ??= projectWindowsInstallerOutcome(error.stdout, error);
          check(false, "CURSOR_APP_WINDOWS_INSTALLER_EXIT");
        } finally {
          installerLog = await readWindowsInstallerLog(logPath);
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
    if (installerLog && report.status !== "PASS") report.windowsInstallerLog = installerLog;
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
