import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { auditWindowsProcesses, hasOwnedWindowsProcesses, stopWindowsApp, windowsRuntimePaths, windowsShellCommand } from "./cursor-app-windows-runtime.mjs";

const paths = { root: "C:\\owned test", appPath: "C:\\owned app\\Cursor.exe",
  packageRoot: "C:\\candidate\\node_modules\\@memorax\\memorax-code", nodePath: "C:\\node\\node.exe" };
const code = (suffix) => ({ code: `CURSOR_APP_WINDOWS_${suffix}` });

test("Windows runtime isolates homes and builds PATH from explicit application and system paths", () => {
  for (const systemRoot of ["C:\\Windows", "D:\\Windows"]) {
    const { home, tmp, resourcesPackage, env } = windowsRuntimePaths({ ...paths, systemRoot });
    assert.equal(home, "C:\\owned test\\home");
    assert.equal(tmp, "C:\\owned test\\tmp");
    assert.equal(resourcesPackage, "C:\\owned app\\resources\\app\\package.json");
    assert.equal(env.SystemRoot, systemRoot);
    assert.equal(env.COMSPEC, systemRoot + "\\System32\\cmd.exe");
    assert.equal(env.HOME, home);
    assert.equal(env.USERPROFILE, home);
    assert.equal(env.APPDATA, home + "\\AppData\\Roaming");
    assert.equal(env.LOCALAPPDATA, home + "\\AppData\\Local");
    assert.equal(env.CURSOR_CONFIG_DIR, home + "\\.cursor");
    assert.equal(env.TEMP, tmp);
    assert.equal(env.MEMORAX_CODE_HOME, "C:\\owned test\\state");
    assert.equal(env.PATH, "C:\\candidate\\node_modules\\.bin;C:\\node;" + systemRoot + "\\System32;"
      + systemRoot + ";" + systemRoot + "\\System32\\WindowsPowerShell\\v1.0;" + systemRoot.slice(0, 2) + "\\Program Files\\PowerShell\\7");
    for (const key of ["CURSOR_API_KEY", "NODE_OPTIONS", "GITHUB_TOKEN"]) assert.equal(env[key], undefined);
  }
  for (const root of ["relative", "C:relative", "C:\\", "\\\\server\\share", "C:\\owned;foreign", "C:\\owned\nsecret", "C:\\owned\\..\\other"]) {
    assert.throws(() => windowsRuntimePaths({ ...paths, root }), code("RUNTIME_ARGUMENTS"));
  }
  for (const override of [{ appPath: "C:\\app\\other.exe" }, { nodePath: "C:\\node\\other.exe" }, { systemRoot: "relative" }]) {
    assert.throws(() => windowsRuntimePaths({ ...paths, ...override }), code("RUNTIME_ARGUMENTS"));
  }
});

test("Windows cleanup audits only owned paths and never kills discovered PIDs", async () => {
  const options = { appPath: paths.appPath, packageRoot: paths.packageRoot, stateHome: "C:\\owned state",
    marker: "C:\\workspace\\cancelled-shell-marker", selfPid: 123, env: windowsRuntimePaths(paths).env };
  for (const [pid, command, executable, includeBackend, expected] of [
    [123, paths.packageRoot, paths.nodePath, true, false],
    [124, '"C:\\owned app\\Cursor.exe" --type=renderer', paths.appPath, false, true],
    [124, 'node "C:\\owned state\\worker.mjs"', paths.nodePath, false, true],
    [124, `node "${paths.packageRoot}\\backend.mjs"`, paths.nodePath, true, true],
    [124, `node "${paths.packageRoot}\\backend.mjs"`, paths.nodePath, false, false],
    [124, 'node "C:\\workspace\\cancelled-shell-marker"', paths.nodePath, false, true],
    [124, 'node "C:\\owned state-other\\worker.mjs"', paths.nodePath, true, false],
    [124, null, null, true, false],
  ]) {
    const rows = [{ ProcessId: pid, CommandLine: command, ExecutablePath: executable }];
    assert.equal(hasOwnedWindowsProcesses(rows, { ...options, includeBackend }), expected);
    assert.equal(await auditWindowsProcesses({ ...options, includeBackend }, async (file, args, settings) => {
      assert.match(file, /\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/);
      assert.ok(args.at(-1).includes("Get-CimInstance Win32_Process"));
      assert.doesNotMatch(args.at(-1), /Stop-Process|taskkill/);
      assert.equal(settings.env, options.env);
      assert.equal(settings.timeout, 30000);
      return { stdout: JSON.stringify(rows) };
    }), expected);
  }
  for (const [stdout, suffix] of [["invalid", "PROCESS_JSON_INVALID"], ["null", "PROCESS_ROWS_INVALID"],
    ['{"error":"private-canary"}', "PROCESS_ROWS_INVALID"], ['[{"ProcessId":"124"}]', "PROCESS_ROWS_INVALID"]]) {
    await assert.rejects(auditWindowsProcesses(options, async () => ({ stdout })), code(suffix));
  }
  const shell = windowsShellCommand([paths.nodePath, "-e", "process.exit(0)", options.marker]);
  const encodedCommand = shell.split(" ").at(-1);
  const row = { ProcessId: 124, ExecutablePath: "C:\\Windows\\powershell.exe", CommandLine: shell };
  assert.equal(hasOwnedWindowsProcesses([row], options), false);
  assert.equal(hasOwnedWindowsProcesses([row], { ...options, encodedCommand }), true);
  assert.equal(hasOwnedWindowsProcesses([{ ...row, CommandLine: shell + "another" }], { ...options, encodedCommand }), false);
});

test("Windows process-query diagnostics keep only fixed failure codes", async () => {
  const options = { appPath: paths.appPath, packageRoot: paths.packageRoot, stateHome: "C:\\owned state",
    selfPid: 123, env: windowsRuntimePaths(paths).env };
  for (const [fields, suffix] of [
    [{ code: "ETIMEDOUT" }, "QUERY_TIMEOUT"],
    [{ killed: true, signal: "SIGTERM" }, "QUERY_TIMEOUT"],
    [{ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", killed: true }, "QUERY_FAILED"],
    [{ code: "ENOENT" }, "QUERY_FAILED"],
    [{ code: 1, stderr: "private-canary CommandNotFoundException private-canary" }, "QUERY_COMMAND_NOT_FOUND"],
    [{ code: 1, stderr: "private-canary Microsoft.Management.Infrastructure.CimException private-canary" }, "QUERY_CIM_FAILED"],
    [{ code: 1, stderr: "private-canary unknown failure" }, "QUERY_FAILED"],
  ]) {
    await assert.rejects(auditWindowsProcesses(options, async () => {
      throw Object.assign(new Error("private-canary"), { stdout: "private-canary", ...fields });
    }), { code: "CURSOR_APP_WINDOWS_PROCESS_" + suffix, message: "CURSOR_APP_WINDOWS_PROCESS_" + suffix });
  }
});

test("Windows App tree cleanup ignores exited children even if their PID is reused", async () => {
  const env = windowsRuntimePaths(paths).env;
  for (const status of [{ exitCode: 0 }, { exitCode: 1 }, { signalCode: "SIGTERM" }]) {
    await stopWindowsApp({ pid: 123, ...status }, env, () => assert.fail("must not kill reused PID"));
  }
  let calls = 0;
  await stopWindowsApp({ pid: 123, exitCode: null, signalCode: null }, env, async (file, args, settings) => {
    calls++;
    assert.equal(file, "C:\\Windows\\System32\\taskkill.exe");
    assert.deepEqual(args, ["/PID", "123", "/T", "/F"]);
    assert.equal(settings.env, env);
    assert.equal(settings.timeout, 10000);
  });
  assert.equal(calls, 1);
});

test("Windows App stop failures expose only bounded fixed error codes and snapshots", async () => {
  const env = windowsRuntimePaths(paths).env;
  for (const [fields, suffix] of [
    [{ code: "ETIMEDOUT" }, "TIMEOUT"],
    [{ killed: true, signal: "SIGTERM" }, "TIMEOUT"],
    [{ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", killed: true }, "FAILED"],
    [{ code: "ENOENT" }, "UNAVAILABLE"],
    [{ code: 1 }, "EXIT_1"],
    [{ code: 128 }, "EXIT_128"],
    [{ code: 0xffffffff }, "EXIT_4294967295"],
    ...[-1, 0x100000000, 1.5, NaN, Infinity, "128", "private-canary", null, undefined]
      .map((code) => [{ code }, "FAILED"]),
  ]) {
    await assert.rejects(stopWindowsApp({ pid: 123, exitCode: null, signalCode: null }, env, async () => {
      throw Object.assign(new Error("private-canary"), { stdout: "private-canary", stderr: "private-canary", ...fields });
    }), (error) => {
      assert.equal(error.code, "CURSOR_APP_WINDOWS_APP_STOP_" + suffix);
      assert.equal(error.message, error.code);
      assert.equal(error.windowsAppStop.childExitCode, null);
      assert.equal(JSON.stringify(error).includes("private-canary"), false);
      return true;
    });
  }
});

test("Windows App stop does not swallow command failure if the held child exits meanwhile", async () => {
  const child = { pid: 123, exitCode: null, signalCode: null };
  let snapshot;
  await assert.rejects(stopWindowsApp(child, windowsRuntimePaths(paths).env, async () => {
    child.exitCode = 0;
    throw Object.assign(new Error("private-canary"), { code: 128,
      stderr: 'ERROR: The process "123" not found.\nprivate-canary', stdout: "private-canary" });
  }), (error) => {
    assert.equal(error.code, "CURSOR_APP_WINDOWS_APP_STOP_EXIT_128");
    snapshot = error.windowsAppStop;
    assert.deepEqual(snapshot, { taskkillExitCode: 128, childExitCode: 0, childSignal: "none", timedOut: false,
      outputOverflow: false, markers: { processNotFound: true, accessDenied: false } });
    assert.equal(JSON.stringify(error).includes("private-canary"), false);
    return true;
  });
  assert.equal(child.exitCode, 0);
  child.exitCode = 1;
  child.signalCode = "SIGTERM";
  assert.equal(snapshot.childExitCode, 0);
  assert.equal(snapshot.childSignal, "none");
});

test("Windows Shell commands preserve explicit argv and environment through one fixed encoded shell", () => {
  const command = windowsShellCommand(["memorax-cli.cmd", "add", "--memory", "quote ' and \" with space; $env:SECRET", "\u8bb0\u5fc6"],
    { MEMORAX_CODE_MEMORY_CLI_TRACE_CLIENT: "cursor", FIXTURE: "value'quoted" });
  assert.match(command, /^powershell\.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand [A-Za-z0-9+/=]+$/);
  const decoded = Buffer.from(command.split(" ").at(-1), "base64").toString("utf16le");
  assert.equal(decoded, "$ErrorActionPreference='Stop'; $env:FIXTURE='value''quoted'; $env:MEMORAX_CODE_MEMORY_CLI_TRACE_CLIENT='cursor'; & 'memorax-cli.cmd' 'add' '--memory' 'quote '' and \" with space; $env:SECRET' '\u8bb0\u5fc6'; exit $LASTEXITCODE");
  assert.doesNotMatch(command, /ExecutionPolicy|private-canary/);
});

test("Windows Shell commands reject NUL and invalid explicit environment keys", () => {
  for (const args of [[], [""], ["node.exe", "a\0b"], [12], null]) {
    assert.throws(() => windowsShellCommand(args), code("RUNTIME_ARGUMENTS"));
  }
  for (const environment of [null, [], { "BAD-NAME": "value" }, { VALID: "a\0b" }, { VALID: 1 }]) {
    assert.throws(() => windowsShellCommand(["node.exe"], environment), code("RUNTIME_ARGUMENTS"));
  }
});

test("the actual encoded Windows Shell payload parses as PowerShell without invoking any client", (t) => {
  const available = spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "exit 0"], { encoding: "utf8", timeout: 10000 });
  if (available.error?.code === "ENOENT") return t.skip("PowerShell is not installed");
  assert.equal(available.status, 0);
  const encoded = windowsShellCommand(["memorax-cli.cmd", "--query", "a'b \"c\"; $name\n\u8bb0\u5fc6"], { FIXTURE: "a'b" }).split(" ").at(-1);
  const result = spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `
$text=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encoded}'))
$tokens=$null; $errors=$null
$null=[Management.Automation.Language.Parser]::ParseInput($text,[ref]$tokens,[ref]$errors)
if($errors.Count -ne 0) { exit 1 }
[Console]::WriteLine('PARSE_PASS')`], { encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), "PARSE_PASS");
  assert.equal(result.stderr, "");
});
