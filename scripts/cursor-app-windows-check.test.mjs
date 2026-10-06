import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { projectNativeReport } from "./cursor-app-container-check.mjs";
import { projectWindowsInstallerLog, projectWindowsInstallerOutcome, readWindowsInstallerLog, runWindowsCheck,
  windowsCheckEnvironment, windowsInstallerCommand } from "./cursor-app-windows-check.mjs";

const innoLog = (...records) => Buffer.from("\ufeff" + records.map((record) =>
  `2026-10-06 12:34:56.789   ${record.replaceAll("\n", "\r\n" + " ".repeat(26))}\r\n`).join(""));

test("installer file diagnostics retain only fixed operations and the current destination length", () => {
  const destination = `C:\\private-canary\\${"nested\\".repeat(40)}file.js`;
  for (const [action, fileOperation] of [
    ["read the existing file", "read-existing"], ["read the source file", "read-source"],
    ["create a file in the destination directory", "create"], ["copy a file", "copy"],
    ["replace the existing file", "replace"], ["rename a file in the destination directory", "rename"],
  ]) {
    const result = projectWindowsInstallerLog(innoLog("-- File entry --", `Dest filename: ${destination}`,
      `Exception message:\nAn error occurred while trying to ${action}:\n${destination}\nCreateFile failed; code 3.`));
    assert.deepEqual(result, { readStatus: "ok", category: "file", systemErrorCode: 3,
      fileOperation, systemOperation: "CreateFile", destinationPathLength: destination.length });
    assert.equal(JSON.stringify(result).includes("private-canary"), false);
  }
  for (const systemOperation of ["CreateFile", "DeleteFile", "MoveFile", "MoveFileEx"]) {
    assert.deepEqual(projectWindowsInstallerLog(innoLog(`${systemOperation} failed; code 3.`)),
      { readStatus: "ok", category: "file", systemErrorCode: 3, systemOperation });
  }
});

test("installer destination diagnostics never reuse another entry or a partial tail context", () => {
  for (const records of [
    ["Dest filename: C:\\private-canary"],
    ["-- File entry --", "Dest filename: C:\\private-canary", "-- File entry --"],
    ["-- File entry --", "Dest filename: C:\\private-canary", "-- Registry entry --"],
  ]) {
    assert.deepEqual(projectWindowsInstallerLog(innoLog(...records, "CreateFile failed; code 3.")),
      { readStatus: "ok", category: "file", systemErrorCode: 3, systemOperation: "CreateFile" });
  }
  assert.deepEqual(projectWindowsInstallerLog(innoLog("-- File entry --", "Dest filename: C:\\private-canary",
    "Error writing to registry key:\nRegSetValueEx failed; code 5.")),
  { readStatus: "ok", category: "registry", systemErrorCode: 5 });
});

test("installer log projection associates only known error text within the same Inno record", () => {
  for (const [message, category, systemErrorCode, details = {}] of [
    ['Setup was unable to create the directory "C:\\private-canary".\n\nError 5: private-canary', "directory", 5],
    ["Exception message:\nAn error occurred while trying to copy a file:\nC:\\private-canary\nCreateFile failed; code 32.", "file", 32,
      { fileOperation: "copy", systemOperation: "CreateFile" }],
    ["Error writing to registry key:\nHKCU\\private-canary\n\nRegSetValueEx failed; code 5.\nprivate-canary", "registry", 5],
    ["Unable to execute file:\nC:\\private-canary\n\nCreateProcess failed; code 2.\nprivate-canary", "execute", 2],
    ["Exception message:\nprivate-canary", "exception", null],
    ["Error 4294967295: private-canary", "unknown", 4294967295],
  ]) {
    const result = projectWindowsInstallerLog(innoLog(message, "Rolling back changes."));
    assert.deepEqual(result, { readStatus: "ok", category, systemErrorCode, ...details });
    assert.equal(JSON.stringify(result).includes("private-canary"), false);
  }
  for (const records of [
    ["-- File entry --", "Error 5: private-canary"],
    ["-- Registry entry --", "Error 5: private-canary"],
  ]) assert.deepEqual(projectWindowsInstallerLog(innoLog(...records)), { readStatus: "ok", category: "unknown", systemErrorCode: 5 });
  assert.deepEqual(projectWindowsInstallerLog(innoLog("Error writing to registry key:\nHKCU\\private-canary", "Error 5: private-canary")),
    { readStatus: "ok", category: "registry", systemErrorCode: null });
  for (const bytes of [Buffer.from("private-canary Error 5: token"), innoLog("Error 4294967296: private-canary"),
    innoLog("Error -1: private-canary"), innoLog("Command line: private-canary (Error code: 5)"),
    innoLog("-- File entry --", "-- Registry entry --", "Installation process succeeded."),
    innoLog("Rolling back changes.", "DeleteFile failed; code 5.")]) {
    assert.deepEqual(projectWindowsInstallerLog(bytes), { readStatus: "ok", category: "unknown", systemErrorCode: null });
  }
  for (const bytes of [Buffer.from([0xc3, 0x28]), Buffer.from("private-canary", "utf16le")]) {
    assert.deepEqual(projectWindowsInstallerLog(bytes), { readStatus: "invalid-encoding", category: "unknown", systemErrorCode: null });
  }
});

test("private installer log reads are bounded, regular-file-only and never expose paths or content", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "memorax-installer-log-"));
  try {
    const path = join(root, "private-canary.log");
    assert.deepEqual(await readWindowsInstallerLog(`${path}\0`), { readStatus: "read-error", category: "unknown", systemErrorCode: null });
    assert.deepEqual(await readWindowsInstallerLog(path), { readStatus: "missing", category: "unknown", systemErrorCode: null });
    await mkdir(path);
    assert.equal((await readWindowsInstallerLog(path)).readStatus, "not-regular");
    await rm(path, { recursive: true });
    await writeFile(path, innoLog("CreateFile failed; code 5.\nprivate-canary"));
    assert.deepEqual(await readWindowsInstallerLog(path), { readStatus: "ok", category: "file", systemErrorCode: 5, systemOperation: "CreateFile" });
    await writeFile(path, Buffer.alloc(1024 * 1024 + 1, 0x61));
    assert.deepEqual(await readWindowsInstallerLog(path), { readStatus: "tail", category: "unknown", systemErrorCode: null });
    await writeFile(path, Buffer.from([0xff]));
    assert.equal((await readWindowsInstallerLog(path)).readStatus, "invalid-encoding");
    const target = join(root, "private-canary-target.log"), link = join(root, "private-canary-link.log");
    await writeFile(target, innoLog("CreateFile failed; code 5."));
    try { await symlink(target, link); }
    catch (error) { if (process.platform === "win32" && error.code === "EPERM") return t.diagnostic("Symlink creation requires Windows privileges"); throw error; }
    assert.deepEqual(await readWindowsInstallerLog(link), { readStatus: "not-regular", category: "unknown", systemErrorCode: null });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("large installer logs retain complete tail errors across line and UTF-8 boundaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-installer-tail-"));
  const limit = 1024 * 1024;
  const error = innoLog("Error writing to registry key:\nHKCU\\private-canary\nRegSetValueEx failed; code 5.",
    "Rolling back changes.", "DeleteFile failed; code 32.").subarray(3);
  try {
    const path = join(root, "private-canary.log");
    for (const bytes of [
      Buffer.concat([Buffer.alloc(limit * 2, 0x61), Buffer.from("\n"), error]),
      Buffer.concat([Buffer.alloc(limit, 0x61), Buffer.from("\xc3\xa9\n", "latin1"), error,
        Buffer.alloc(limit - error.length - 2, 0x61)]),
      Buffer.concat([Buffer.alloc(limit, 0x61), Buffer.from("\r\n"), error,
        Buffer.alloc(limit - error.length, 0x61)]),
    ]) {
      await writeFile(path, bytes);
      const result = await readWindowsInstallerLog(path);
      assert.deepEqual(result, { readStatus: "tail", category: "registry", systemErrorCode: 5 });
      assert.equal(JSON.stringify(result).includes("private-canary"), false);
    }
    const partial = innoLog("Exception message:\nCreateFile failed; code 32.\nprivate-canary").subarray(3);
    const harmless = innoLog("-- File entry --", "Rolling back changes.", "DeleteFile failed; code 5.").subarray(3);
    await writeFile(path, Buffer.concat([Buffer.alloc(limit, 0x61), partial, harmless,
      Buffer.alloc(limit - partial.length - harmless.length + 35, 0x61)]));
    assert.deepEqual(await readWindowsInstallerLog(path), { readStatus: "tail", category: "unknown", systemErrorCode: null });
    await writeFile(path, Buffer.concat([Buffer.alloc(limit, 0x61), Buffer.from("\n"), error, Buffer.from([0xff])]));
    assert.deepEqual(await readWindowsInstallerLog(path), { readStatus: "invalid-encoding", category: "unknown", systemErrorCode: null });
  } finally { await rm(root, { recursive: true, force: true }); }
});

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

test("Windows wrapper CLI requires the same five arguments as the other native wrappers", () => {
  const script = fileURLToPath(new URL("./cursor-app-windows-check.mjs", import.meta.url));
  for (const args of [[], ["candidate"], ["candidate", "report", "manifest", "baseline"],
    ["candidate", "report", "manifest", "baseline", "24", "extra"]]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8", timeout: 5000 });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr.trim(), "CURSOR_APP_WINDOWS_ARGUMENTS");
  }
});

function nativeReport() {
  return { status: "PASS", client: "cursor", kind: "app-native-session-flows", platform: "win32", node: "24.20.0",
    version: "3.21.18", stage: "complete", evidence: { agentTransport: true, nativeHooks: true, exactAutomaticAdd: true,
      sameSessionFollowup: true, sessionIsolation: true, workspaceIsolation: true, appResume: true, skillSearch: true, skillAdd: true,
      shellDenied: true, pendingShellInterrupted: true, sameSessionRecovered: true, cleanup: true,
      nativeContent: [3, 6, 3, 9, 15, 21, 4, 3].map((blobCount) => ({ composerMatched: true, stateMatched: true, blobCount })) },
    agent: { runs: 9, ancillaryRequestCount: 5, unsupportedRpcCount: 1, cancelled: [false, false, false, false, false, false, false, true, false], errors: [],
      writes: [3, 3, 3, 3, 6, 6, 4, 0, 3], acknowledgements: [3, 3, 3, 3, 6, 6, 4, 0, 3], historyTurns: [0, 1, 0, 2, 3, 4, 0, 0, 0],
      reads: [0, 3, 0, 6, 9, 15, 0, 0, 0], readResults: [0, 3, 0, 6, 9, 15, 0, 0, 0],
      execRequests: [0, 0, 0, 0, 3, 3, 1, 1, 0], execResults: [0, 0, 0, 0, 3, 3, 1, 0, 0], execCloses: [0, 0, 0, 0, 3, 3, 1, 0, 0],
      contextRequests: [1, 1, 1, 1, 1, 1, 1, 1, 1], contextResults: [1, 1, 1, 1, 1, 1, 1, 1, 1], contextCloses: [1, 1, 1, 1, 1, 1, 1, 1, 1] }, memoryRequestCount: 10 };
}

test("Windows orchestration uses verified artifacts and preserves every native or cleanup failure", async (t) => {
  const source = (await readFile(new URL("./cursor-app-windows-check.mjs", import.meta.url), "utf8")).replaceAll("\r\n", "\n");
  assert.doesNotMatch(source, /cursor-app-windows-isolation|owned-session|runWindowsIsolation|New-LocalUser|WFP/);
  const body = source.split("export async function runWindowsCheck(")[1]?.split("\nif (process.argv[1]")[0];
  assert.ok(body);
  for (const kind of ["success", "missing-runner-temp", "relative-runner-temp", "candidate-failure", "probe-failure", "smoke-failure", "artifact-failure", "installer-failure", "installer-exit-five",
    "installed-failure", "installed-cleanup-failure", "native-failure", "native-exit-with-pass", "native-cleanup-failure",
    "invalid-report", "missing-report", "artifact-cleanup-failure", "state-cleanup-failure"]) {
    await t.test(kind, async () => {
      const calls = [], output = new Map(), abort = new AbortController();
      const invalidTemp = kind.endsWith("runner-temp");
      const error = (code) => Object.assign(new Error("private-canary"), { code });
      const native = nativeReport(); native.privateCanary = "private-canary";
      if (["native-failure", "native-cleanup-failure"].includes(kind)) {
        native.status = "FAIL"; native.stage = "app-start"; native.errorCode = "CURSOR_APP_EXITED";
      }
      if (kind === "native-cleanup-failure") { native.evidence.cleanup = false; native.cleanupError = "CURSOR_APP_CLEANUP_DESCENDANTS"; }
      if (kind === "invalid-report") native.platform = "linux";
      const run = runInNewContext(`(async function runWindowsCheck(${body})`, {
        process: { platform: "win32", arch: "x64", versions: { node: "24.20.0" }, execPath: "C:\\node\\node.exe",
          env: { GITHUB_ACTIONS: "true", RUNNER_OS: "Windows", SystemRoot: "C:\\Windows", GITHUB_TOKEN: "private-canary",
            RUNNER_TEMP: kind === "missing-runner-temp" ? undefined : kind === "relative-runner-temp" ? "relative" : "D:\\a\\_temp" } },
        dirname: win32.dirname, join: win32.join, resolve: win32.resolve, win32, scripts: "C:\\scripts",
        gitDirectory: "C:\\Program Files\\Git\\cmd", windowsCheckEnvironment, windowsInstallerCommand, projectWindowsInstallerOutcome, projectNativeReport,
        check(value, code) { if (!value) throw error(code); }, safeCode: (caught) => /^CURSOR_/.test(caught.code ?? "") ? caught.code : "CURSOR_APP_WINDOWS_CHECK_FAILED",
        async lstat(path) {
          if (kind === "missing-report" && path.endsWith("report.json")) throw error("ENOENT");
          return { isFile: () => true, isDirectory: () => true, isSymbolicLink: () => false, size: 100 };
        },
        async mkdir() {}, async readdir() { return []; }, async realpath(path) { return path; },
        async mkdtemp(prefix) { assert.equal(prefix, "D:\\a\\_temp\\mx-cursor-"); return "C:\\runtime"; },
        async writeFile(path, value) { output.set(path, value); },
        async readWindowsInstallerLog(path) {
          assert.equal(path, "C:\\runtime\\installer.log");
          return { readStatus: "read-error", category: "unknown", systemErrorCode: null };
        },
        async rm(path) { calls.push("remove"); assert.equal(path, "C:\\runtime"); if (kind === "state-cleanup-failure") throw error("EBUSY"); },
        selectCursorWindowsRelease(manifest, channel) {
          assert.equal(manifest, "frozen inventory"); assert.equal(channel, "baseline"); return { version: "3.21.18" };
        },
        async exec(file, args, options) {
          assert.equal(options.env.HOME, "C:\\runtime\\home"); assert.equal(options.env.GITHUB_TOKEN, undefined);
          assert.equal(options.signal, abort.signal);
          if (args[0].endsWith("npm-cli.js")) {
            assert.equal(file, "C:\\node\\node.exe"); assert.equal(args[0], "C:\\node\\node_modules\\npm\\bin\\npm-cli.js");
            const prefix = win32.basename(args[args.indexOf("--prefix") + 1]); calls.push(prefix);
            assert.ok(args.includes("--ignore-scripts") && args.includes("--no-audit") && args.includes("--no-fund"));
            const user = args[args.indexOf("--userconfig") + 1], global = args[args.indexOf("--globalconfig") + 1];
            assert.notEqual(user, global); assert.equal(output.get(user), ""); assert.equal(output.get(global), "");
            if (kind === `${prefix}-failure`) throw error(1);
          } else if (args[0].endsWith("cursor-npm-package-smoke.mjs")) {
            calls.push("smoke"); assert.equal(args[1], "C:\\runtime\\candidate\\node_modules\\@memorax\\memorax-code");
            if (kind === "smoke-failure") throw error("ETIMEDOUT");
          } else if (file.endsWith("powershell.exe")) {
            calls.push("installer"); assert.equal(options.timeout, 300_000);
            assert.deepEqual(Array.from(args), windowsInstallerCommand("C:\\verified\\CursorUserSetup.exe", "C:\\runtime\\home\\AppData\\Local\\Programs\\Cursor", "C:\\runtime\\installer.log"));
            if (kind === "installer-failure") throw error("ETIMEDOUT");
            if (kind === "installer-exit-five") throw Object.assign(error(5), {
              stdout: JSON.stringify({ status: "exited", exitCode: 5, nativeErrorCode: null }),
            });
            return { stdout: JSON.stringify({ status: "exited", exitCode: 0, nativeErrorCode: null }), stderr: "" };
          } else {
            calls.push("native"); assert.equal(file, "C:\\node\\node.exe");
            assert.deepEqual(Array.from(args), ["C:\\scripts\\cursor-app-native-check.mjs", "C:\\runtime\\candidate\\node_modules\\@memorax\\memorax-code",
              "C:\\runtime\\home\\AppData\\Local\\Programs\\Cursor\\Cursor.exe", "3.21.18", "C:\\runtime\\probe\\node_modules\\playwright-core",
              "C:\\runtime\\native-report", "24"]);
            if (kind.startsWith("native-")) throw error(1);
          }
          return { stdout: "", stderr: "" };
        },
        async readFile(path) { assert.equal(path, "C:\\runtime\\native-report\\report.json"); return JSON.stringify(native); },
        async verifyCursorWindowsInstalledApp(options) {
          calls.push("verify-installed"); assert.equal(options.root, "C:\\runtime"); assert.equal(options.profileRoot, "C:\\runtime\\home");
          assert.equal(options.appDirectory, "C:\\runtime\\home\\AppData\\Local\\Programs\\Cursor");
          if (kind.startsWith("installed-")) {
            const caught = error("CURSOR_APP_WINDOWS_ARTIFACT_PACKAGE");
            if (kind === "installed-cleanup-failure") caught.cleanupErrorCode = "CURSOR_APP_WINDOWS_ARTIFACT_PROCESS_CLEANUP";
            throw caught;
          }
          return { appIdentityVerified: true, appArchitectureVerified: true, authenticodeVerified: true };
        },
        async withVerifiedCursorWindowsInstaller(options, callback) {
          calls.push("artifact"); if (kind === "artifact-failure") throw error("CURSOR_APP_WINDOWS_ARTIFACT_SIGNATURE");
          let confirmed = false, caught;
          try { await callback({ installerPath: "C:\\verified\\CursorUserSetup.exe", confirmProcessesClosed() { confirmed = true; calls.push("confirmed"); } }); }
          catch (failure) { caught = failure; }
          if (!confirmed || kind === "artifact-cleanup-failure") {
            caught ??= error("CURSOR_APP_WINDOWS_ARTIFACT_PROCESS_CLEANUP");
            caught.cleanupErrorCode = "CURSOR_APP_WINDOWS_ARTIFACT_PROCESS_CLEANUP";
          }
          if (caught) throw caught;
        },
      }, { timeout: 100 });
      const result = await run("C:\\candidate.tgz", "C:\\report", { releaseManifest: "frozen inventory", channel: "baseline", signal: abort.signal });
      assert.equal(result.status, kind === "success" ? "PASS" : "FAIL");
      assert.equal(JSON.stringify(result).includes("private-canary"), false);
      assert.equal(output.get("C:\\report\\report.json"), `${JSON.stringify(result, null, 2)}\n`);
      const retained = ["smoke-failure", "installer-failure", "installer-exit-five", "installed-cleanup-failure", "native-cleanup-failure", "invalid-report", "missing-report", "artifact-cleanup-failure"].includes(kind);
      assert.equal(calls.includes("remove"), !retained && !invalidTemp);
      if (invalidTemp) {
        assert.equal(result.errorCode, "CURSOR_APP_WINDOWS_RUNNER_TEMP");
        assert.deepEqual(calls, []);
      }
      if (retained || kind === "state-cleanup-failure") assert.ok(result.cleanupError);
      if (kind === "success") assert.deepEqual(calls, ["candidate", "probe", "smoke", "artifact", "installer", "verify-installed", "native", "confirmed", "remove"]);
      if (["candidate-failure", "probe-failure", "smoke-failure", "artifact-failure", "installer-failure", "installer-exit-five", "installed-failure", "installed-cleanup-failure"].includes(kind)) {
        assert.equal(calls.includes("native"), false);
      }
      if (kind === "native-failure") assert.equal(result.errorCode, "CURSOR_APP_EXITED");
      if (kind === "native-exit-with-pass") assert.equal(result.errorCode, "CURSOR_APP_WINDOWS_NATIVE_EXIT");
      if (kind === "installer-failure") assert.deepEqual(result.windowsInstaller, { status: "timeout", exitCode: null, nativeErrorCode: null });
      if (kind === "installer-exit-five") {
        assert.equal(result.errorCode, "CURSOR_APP_WINDOWS_INSTALLER_EXIT");
        assert.deepEqual(result.windowsInstaller, { status: "exited", exitCode: 5, nativeErrorCode: null });
      }
      if (calls.includes("installer") && result.status !== "PASS") {
        assert.deepEqual(result.windowsInstallerLog, { readStatus: "read-error", category: "unknown", systemErrorCode: null });
      } else assert.equal(result.windowsInstallerLog, undefined);
    });
  }
});
