import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { win32 } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { projectNativeReport } from "./cursor-app-container-check.mjs";
import { projectWindowsInstallerOutcome, runWindowsCheck,
  windowsCheckEnvironment, windowsInstallerCommand } from "./cursor-app-windows-check.mjs";

test("Windows wrapper builds a clean environment with only the hosted Git directory added", () => {
  const env = windowsCheckEnvironment("C:\\owned root", "C:\\node\\node.exe", "D:\\Windows");
  assert.equal(env.HOME, "C:\\owned root\\home");
  assert.equal(env.LOCALAPPDATA, "C:\\owned root\\home\\AppData\\Local");
  assert.equal(env.SystemRoot, "D:\\Windows");
  assert.equal(env.RUNNER_OS, "Windows");
  assert.equal(env.GITHUB_ACTIONS, "true");
  assert.equal(env.npm_config_cache, "C:\\owned root\\npm-cache");
  assert.equal(env.PATH, "C:\\owned root\\candidate\\node_modules\\.bin;C:\\node;D:\\Windows\\System32;D:\\Windows;D:\\Windows\\System32\\WindowsPowerShell\\v1.0;D:\\Program Files\\PowerShell\\7;C:\\Program Files\\Git\\cmd");
  for (const key of ["NODE_OPTIONS", "NODE_PATH", "GITHUB_TOKEN", "GH_TOKEN", "CURSOR_API_KEY", "VSCODE_PORTABLE",
    "npm_config_userconfig", "MEMORAX_CODE_MEMORAX_API_KEY"]) assert.equal(Object.hasOwn(env, key), false);
});

test("the Windows wrapper does not run on a developer desktop or another platform", async () => {
  if (process.platform === "win32" && process.arch === "x64" && process.env.GITHUB_ACTIONS === "true"
    && process.env.RUNNER_OS === "Windows") return;
  const report = await runWindowsCheck("never-read", "never-write");
  assert.equal(report.status, "FAIL");
  assert.equal(report.errorCode, "CURSOR_APP_WINDOWS_RUNNER");
  assert.deepEqual(report.evidence, {});
});

test("Windows installer invocation is silent, prevents automatic App start and waits for descendants", () => {
  const args = windowsInstallerCommand("C:\\owned ' installer\\CursorUserSetup.exe", "C:\\owned app\\Cursor", "C:\\owned ' private\\installer.log");
  assert.deepEqual(args.slice(0, -1), ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"]);
  const script = Buffer.from(args.at(-1), "base64").toString("utf16le");
  assert.match(script, /Start-Process -FilePath 'C:\\owned '' installer\\CursorUserSetup\.exe'/);
  assert.match(script, /'\/VERYSILENT','\/SUPPRESSMSGBOXES','\/NORESTART','\/MERGETASKS=!runcode','\/DIR="C:\\owned app\\Cursor"','\/LOG="C:\\owned '' private\\installer\.log"'/);
  assert.match(script, /-Wait -PassThru;/);
  assert.match(script, /status='exited';exitCode=\$installer\.ExitCode;nativeErrorCode=\$null/);
  assert.doesNotMatch(script, /ExecutionPolicy|RunAs|no-sandbox/i);
  for (const invalid of ["relative", "C:\\a\0b", "C:\\a\r\nb", 'C:\\a"b']) {
    assert.throws(() => windowsInstallerCommand(invalid, "C:\\app", "C:\\private\\installer.log"), { code: "CURSOR_APP_WINDOWS_ARGUMENTS" });
    assert.throws(() => windowsInstallerCommand("C:\\installer.exe", "C:\\app", invalid), { code: "CURSOR_APP_WINDOWS_ARGUMENTS" });
  }
});

test("the real encoded installer script distinguishes installer exit from launch error without private output", (t) => {
  const available = spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "exit 0"], { encoding: "utf8", timeout: 10000 });
  if (available.error?.code === "ENOENT") return t.skip("PowerShell is not installed");
  assert.equal(available.status, 0);
  const args = windowsInstallerCommand("C:\\owned ' \u5b89\u88c5\\CursorUserSetup.exe", "C:\\owned app\\Cursor", "C:\\owned ' private\\installer.log");
  for (const kind of ["exited", "launch-error"]) {
    const script = `function Start-Process {
param([string]$FilePath, [string[]]$ArgumentList, [switch]$Wait, [switch]$PassThru)
if ($FilePath -cne 'C:\\owned '' \u5b89\u88c5\\CursorUserSetup.exe' -or -not $Wait -or -not $PassThru) { throw 'FIXTURE_ARGUMENTS' }
if (($ArgumentList -join '|') -cne '/VERYSILENT|/SUPPRESSMSGBOXES|/NORESTART|/MERGETASKS=!runcode|/DIR="C:\\owned app\\Cursor"|/LOG="C:\\owned '' private\\installer.log"') { throw 'FIXTURE_FLAGS' }
${kind === "exited" ? "[pscustomobject]@{ ExitCode=7 }" : "throw [ComponentModel.Win32Exception]::new(5, 'private-canary')"}
}
${Buffer.from(args.at(-1), "base64").toString("utf16le")}`;
    const result = spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, kind === "exited" ? 7 : 1);
    assert.deepEqual(JSON.parse(result.stdout), { status: kind, exitCode: kind === "exited" ? 7 : null, nativeErrorCode: kind === "exited" ? null : 5 });
    assert.equal(result.stderr, "");
    assert.equal(result.stdout.includes("private-canary"), false);
  }
});

test("installer outcome projection accepts only fixed statuses and bounded integers", () => {
  for (const exitCode of [-2147483648, 0, 2147483647]) {
    const outcome = { status: "exited", exitCode, nativeErrorCode: null };
    assert.deepEqual(projectWindowsInstallerOutcome(JSON.stringify(outcome)), outcome);
  }
  const native = { status: "launch-error", exitCode: null, nativeErrorCode: 5 };
  assert.deepEqual(projectWindowsInstallerOutcome(JSON.stringify(native), { code: 1 }), native);
  for (const stdout of ["private-canary", "x".repeat(4097), JSON.stringify({ ...native, raw: "private-canary" }),
    JSON.stringify({ ...native, nativeErrorCode: 2147483648 }), JSON.stringify({ ...native, status: "private-canary" })]) {
    assert.deepEqual(projectWindowsInstallerOutcome(stdout), { status: "invalid-output", exitCode: null, nativeErrorCode: null });
  }
  for (const [error, status, exitCode] of [[{ code: 1 }, "powershell-exit", 1], [{ code: "ABORT_ERR" }, "aborted", null],
    [{ code: "ETIMEDOUT" }, "timeout", null], [{ killed: true, signal: "SIGKILL" }, "timeout", null],
    [{ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", killed: true, signal: "SIGKILL" }, "output-overflow", null]]) {
    assert.deepEqual(projectWindowsInstallerOutcome("private-canary", error), { status, exitCode, nativeErrorCode: null });
  }
});

function nativeReport() {
  return { status: "PASS", client: "cursor", kind: "app-native-session-flows", platform: "win32", node: "24.20.0",
    version: "3.21.18", stage: "complete", evidence: { agentTransport: true, nativeHooks: true, exactAutomaticAdd: true,
      sameSessionFollowup: true, sessionIsolation: true, workspaceIsolation: true, appResume: true, skillSearch: true, skillAdd: true,
      shellDenied: true, pendingShellInterrupted: true, sameSessionRecovered: true, repoMemoryWorker: true, cleanup: true,
      nativeContent: [3, 6, 3, 9, 15, 21, 4, 3, 4].map((blobCount) => ({ composerMatched: true, stateMatched: true, blobCount })) },
    agent: { runs: 11, ancillaryRequestCount: 5, unsupportedRpcCount: 1, cancelled: [false, false, false, false, false, false, false, true, false, false, false], errors: [],
      writes: [3, 3, 3, 3, 6, 6, 4, 0, 3, 4, 5], acknowledgements: [3, 3, 3, 3, 6, 6, 4, 0, 3, 4, 5], historyTurns: [0, 1, 0, 2, 3, 4, 0, 0, 0, 0, 0],
      reads: [0, 3, 0, 6, 9, 15, 0, 0, 0, 0, 0], readResults: [0, 3, 0, 6, 9, 15, 0, 0, 0, 0, 0],
      execRequests: [0, 0, 0, 0, 3, 3, 1, 1, 0, 1, 2], execResults: [0, 0, 0, 0, 3, 3, 1, 0, 0, 1, 2], execCloses: [0, 0, 0, 0, 3, 3, 1, 0, 0, 1, 2],
      contextRequests: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], contextResults: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], contextCloses: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1] }, memoryRequestCount: 11 };
}

test("Windows controller preserves exit failures and confirms closure only from completed installers and native cleanup", async (t) => {
  const source = await readFile(new URL("./cursor-app-windows-check.mjs", import.meta.url), "utf8");
  const body = source.replaceAll("\r\n", "\n").split("export async function runWindowsCheck(")[1].split("\nif (process.argv[1]")[0];
  for (const [kind, retained] of [
    ["success", false], ["candidate", false], ["probe", false], ["smoke", true], ["artifact", false],
    ["installer-exit-five", false], ["installer-timeout", true], ["installer-aborted", true], ["installer-invalid", true],
    ["installed", false], ["installed-cleanup", true], ["native", false], ["native-exit-pass", false],
    ["native-cleanup", true], ["invalid-report", true], ["missing-report", true], ["artifact-cleanup", true], ["state-cleanup", true],
  ]) {
    await t.test(kind, async () => {
      const calls = [], output = new Map();
      const failure = (code) => Object.assign(new Error("private-canary"), { code });
      const native = nativeReport();
      native.privateCanary = "private-canary";
      if (["native", "native-cleanup"].includes(kind)) {
        native.status = "FAIL";
        native.stage = "app-start";
        native.errorCode = "CURSOR_APP_EXITED";
      }
      if (kind === "native-cleanup") native.evidence.cleanup = false;
      if (kind === "invalid-report") native.platform = "linux";
      const run = runInNewContext("(async function runWindowsCheck(" + body + ")", {
        process: { platform: "win32", arch: "x64", versions: { node: "24.20.0" }, execPath: "C:\\node\\node.exe",
          env: { GITHUB_ACTIONS: "true", RUNNER_OS: "Windows", SystemRoot: "C:\\Windows", RUNNER_TEMP: "C:\\temp" } },
        dirname: win32.dirname, join: win32.join, resolve: win32.resolve, win32, scripts: "C:\\scripts",
        gitDirectory: "C:\\Program Files\\Git\\cmd", windowsCheckEnvironment, windowsInstallerCommand,
        projectWindowsInstallerOutcome, projectNativeReport,
        check(value, code) { if (!value) throw failure(code); },
        safeCode: (error) => /^CURSOR_(?:APP|CONTAINER)_[A-Z0-9_]{1,100}$/.test(error.code) ? error.code : "CURSOR_APP_WINDOWS_CHECK_FAILED",
        async lstat(path) {
          if (kind === "missing-report" && path.endsWith("report.json")) throw failure("ENOENT");
          return { isFile: () => true, isDirectory: () => true, isSymbolicLink: () => false, size: 100 };
        },
        async mkdir() {}, async readdir() { return []; }, async realpath(path) { return path; },
        async mkdtemp(prefix) { assert.equal(prefix, "C:\\temp\\mx-cursor-"); return "C:\\runtime"; },
        async writeFile(path, value) { output.set(path, value); },
        async rm() { calls.push("remove"); if (kind === "state-cleanup") throw failure("EBUSY"); },
        selectCursorWindowsRelease: () => ({ version: "3.21.18" }),
        async exec(file, args) {
          const stage = args[0].endsWith("npm-cli.js") ? win32.basename(args[args.indexOf("--prefix") + 1])
            : args[0].endsWith("cursor-npm-package-smoke.mjs") ? "smoke" : file.endsWith("powershell.exe") ? "installer" : "native";
          calls.push(stage);
          if (stage === "installer") {
            const stdout = JSON.stringify({ status: "exited", exitCode: kind === "installer-exit-five" ? 5 : 0, nativeErrorCode: null });
            if (kind.startsWith("installer-")) throw Object.assign(failure({
              "installer-exit-five": 5, "installer-timeout": "ETIMEDOUT", "installer-aborted": "ABORT_ERR",
            }[kind] ?? 1), { stdout: kind === "installer-invalid" ? "private-canary" : stdout });
            return { stdout };
          }
          if (stage === kind || (stage === "native" && kind.startsWith("native-"))) throw failure(1);
          return { stdout: "" };
        },
        async readFile() { return JSON.stringify(native); },
        async verifyCursorWindowsInstalledApp() {
          calls.push("verify-installed");
          if (kind.startsWith("installed")) throw Object.assign(failure("CURSOR_APP_WINDOWS_ARTIFACT_PACKAGE"),
            kind === "installed-cleanup" ? { cleanupErrorCode: "CURSOR_APP_WINDOWS_ARTIFACT_PROCESS_CLEANUP" } : {});
          return { appIdentityVerified: true, appArchitectureVerified: true, authenticodeVerified: true };
        },
        async withVerifiedCursorWindowsInstaller(options, callback) {
          calls.push("artifact");
          if (kind === "artifact") throw failure("CURSOR_APP_WINDOWS_ARTIFACT_SIGNATURE");
          let confirmed = false, caught;
          try {
            await callback({ installerPath: "C:\\verified\\CursorUserSetup.exe",
              confirmProcessesClosed() { confirmed = true; calls.push("confirmed"); } });
          } catch (error) { caught = error; }
          if (!confirmed || kind === "artifact-cleanup") {
            caught ??= failure("CURSOR_APP_WINDOWS_ARTIFACT_PROCESS_CLEANUP");
            caught.cleanupErrorCode = "CURSOR_APP_WINDOWS_ARTIFACT_PROCESS_CLEANUP";
          }
          if (caught) throw caught;
        },
      });
      const report = await run("C:\\candidate.tgz", "C:\\report", { releaseManifest: {}, channel: "baseline" });
      assert.equal(report.status, kind === "success" ? "PASS" : "FAIL");
      assert.equal(Boolean(report.cleanupError), retained);
      assert.equal(calls.includes("remove"), !retained || kind === "state-cleanup");
      assert.equal(JSON.stringify(report).includes("private-canary"), false);
      assert.equal(output.get("C:\\report\\report.json"), JSON.stringify(report, null, 2) + "\n");
      if (kind === "success") assert.deepEqual(calls, ["candidate", "probe", "smoke", "artifact", "installer", "verify-installed", "native", "confirmed", "remove"]);
      if (["candidate", "probe", "smoke", "artifact", "installed", "installed-cleanup"].includes(kind) || kind.startsWith("installer-")) {
        assert.equal(calls.includes("native"), false);
      }
      if (kind === "native") assert.equal(report.errorCode, "CURSOR_APP_EXITED");
      if (kind === "native-exit-pass") assert.equal(report.errorCode, "CURSOR_APP_WINDOWS_NATIVE_EXIT");
      if (kind.startsWith("installer-")) {
        assert.equal(report.errorCode, "CURSOR_APP_WINDOWS_INSTALLER_EXIT");
        assert.equal(calls.includes("confirmed"), kind === "installer-exit-five");
        assert.equal(report.windowsInstaller.status, { "installer-exit-five": "exited", "installer-timeout": "timeout",
          "installer-aborted": "aborted", "installer-invalid": "powershell-exit" }[kind]);
      }
      if (kind === "installer-exit-five") assert.equal(report.windowsInstaller.exitCode, 5);
    });
  }
});
