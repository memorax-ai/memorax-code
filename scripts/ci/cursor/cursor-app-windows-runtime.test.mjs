import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { promisify } from "node:util";
import test from "node:test";
import { auditWindowsProcesses, hasOwnedWindowsProcesses, projectWindowsProcessAuditDiagnostics,
  stopWindowsApp, waitForWindowsProcessesExit, windowsRuntimePaths, windowsShellCommand } from "./cursor-app-windows-runtime.mjs";

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
      assert.ok(args.at(-1).includes("Get-CimInstance Win32_Process -Property ProcessId,ExecutablePath,CommandLine"));
      assert.ok(args.at(-1).includes("ConvertTo-Json -InputObject @("));
      assert.doesNotMatch(args.at(-1), /-Filter|-Query|Where-Object/);
      assert.doesNotMatch(args.at(-1), /Stop-Process|taskkill/);
      assert.equal(settings.env, options.env);
      assert.equal(settings.timeout, 0);
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
    [{ code: "ETIMEDOUT" }, "QUERY_FAILED"],
    [{ killed: true, signal: "SIGTERM" }, "QUERY_FAILED"],
    [{ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", killed: true }, "QUERY_OUTPUT_OVERFLOW"],
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

const auditOptions = { appPath: paths.appPath, packageRoot: paths.packageRoot, stateHome: "C:\\owned state",
  selfPid: 123, env: windowsRuntimePaths(paths).env };
const ownedRows = [{ ProcessId: 124, CommandLine: '"C:\\owned app\\Cursor.exe" --type=renderer', ExecutablePath: paths.appPath }];

function auditScenario(t, steps) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const state = { time: 0, calls: 0, sleeps: [], kills: 0 };
  const execute = () => {
    const step = steps[state.calls++];
    assert.ok(step, "unexpected process query");
    if (step.timeout) {
      const child = new EventEmitter();
      child.exitCode = null; child.signalCode = null;
      let reject;
      const pending = new Promise((resolve, fail) => { reject = fail; });
      pending.child = child;
      child.kill = (signal) => {
        state.kills++;
        child.signalCode = signal;
        reject(Object.assign(new Error("private-canary"), { killed: true, signal, stdout: "private-canary" }));
        queueMicrotask(() => child.emit("close", null, signal));
      };
      queueMicrotask(() => {
        const before = state.kills;
        state.time += step.timeout - 1; t.mock.timers.tick(step.timeout - 1);
        assert.equal(state.kills, before, "query must retain its remaining deadline");
        state.time++; t.mock.timers.tick(1);
        assert.equal(state.kills, before + 1, "query must stop at its deadline");
      });
      return pending;
    }
    state.time += step.elapsed ?? 0;
    return step.error ? Promise.reject(Object.assign(new Error("private-canary"), step.error))
      : Promise.resolve({ stdout: step.stdout ?? JSON.stringify(step.owned ? ownedRows : []), stderr: "" });
  };
  return { state, run: () => waitForWindowsProcessesExit(auditOptions, { execute, now: () => state.time,
    sleep: async (ms) => { state.sleeps.push(ms); state.time += ms; t.mock.timers.tick(ms); } }) };
}

test("Windows process exit accepts only a complete clear snapshot and retains successful audit metrics", async (t) => {
  const { run, state } = auditScenario(t, [{ owned: true, elapsed: 12 }, { elapsed: 8 }]);
  const result = await run();
  assert.equal(state.calls, 2);
  assert.deepEqual(state.sleeps, [200]);
  assert.deepEqual(result, { attempts: 2, elapsedMs: 220, timeoutCount: 0, firstFailure: "none", finalStatus: "clear",
    lastQuery: { elapsedMs: 8, timedOut: false, exitCode: 0, signal: "none", stdoutBytes: 2, stderrBytes: 0 } });
});

test("Windows process exit retries one confirmed timeout and retains its history on success", async (t) => {
  const { run, state } = auditScenario(t, [{ timeout: 30000 }, { owned: true, elapsed: 20 }, { elapsed: 10 }]);
  const result = await run();
  assert.equal(state.calls, 3);
  assert.deepEqual(state.sleeps, [200, 200]);
  assert.equal(result.firstFailure, "timeout");
  assert.equal(result.timeoutCount, 1);
  assert.equal(result.finalStatus, "clear");
  assert.equal(result.elapsedMs, 30430);
  assert.equal(result.lastQuery.timedOut, false);
  assert.doesNotMatch(JSON.stringify(result), /private-canary|ProcessId|CommandLine|C:\\/);
});

test("Windows process exit caps the second query by the remaining shared budget", async (t) => {
  const { run, state } = auditScenario(t, [{ timeout: 30000 }, { timeout: 29800 }]);
  await assert.rejects(run(), (error) => {
    assert.equal(error.code, "CURSOR_APP_WINDOWS_PROCESS_QUERY_TIMEOUT");
    assert.equal(error.windowsProcessAudit.attempts, 2);
    assert.equal(error.windowsProcessAudit.elapsedMs, 60000);
    assert.equal(error.windowsProcessAudit.timeoutCount, 2);
    assert.equal(error.windowsProcessAudit.finalStatus, "timeout");
    assert.equal(error.windowsProcessAudit.lastQuery.elapsedMs, 29800);
    assert.equal(error.windowsProcessAudit.lastQuery.signal, "SIGKILL");
    assert.doesNotMatch(JSON.stringify(error), /private-canary/);
    return true;
  });
  assert.equal(state.calls, 2);
  assert.deepEqual(state.sleeps, [200]);
});

test("Windows process exit fails on non-timeout errors without retrying", async (t) => {
  for (const [step, firstFailure, suffix] of [
    [{ error: { code: 1, stderr: "private-canary CimException" } }, "cim", "QUERY_CIM_FAILED"],
    [{ error: { code: 1, stderr: "private-canary CommandNotFoundException" } }, "command-not-found", "QUERY_COMMAND_NOT_FOUND"],
    [{ error: { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", killed: true } }, "overflow", "QUERY_OUTPUT_OVERFLOW"],
    [{ error: { killed: true, signal: "SIGTERM" } }, "query-failed", "QUERY_FAILED"],
    [{ error: { code: "ETIMEDOUT" } }, "query-failed", "QUERY_FAILED"],
    [{ error: { code: "ENOENT" } }, "query-failed", "QUERY_FAILED"],
    [{ stdout: "private-canary" }, "invalid-json", "JSON_INVALID"],
    [{ stdout: "null" }, "invalid-rows", "ROWS_INVALID"],
    [{ stdout: JSON.stringify([...ownedRows, { ProcessId: "private-canary" }]) }, "invalid-rows", "ROWS_INVALID"],
    [{ stdout: " ".repeat(4 * 1024 * 1024) + "[]" }, "overflow", "QUERY_OUTPUT_OVERFLOW"],
  ]) await t.test(firstFailure + " " + suffix, async (t) => {
    const { run, state } = auditScenario(t, [step]);
    await assert.rejects(run(), (error) => {
      assert.equal(error.code, "CURSOR_APP_WINDOWS_PROCESS_" + suffix);
      assert.equal(error.message, error.code);
      assert.equal(error.windowsProcessAudit.firstFailure, firstFailure);
      assert.equal(error.windowsProcessAudit.finalStatus, "failed");
      assert.equal(error.windowsProcessAudit.attempts, 1);
      assert.equal(error.windowsProcessAudit.timeoutCount, 0);
      assert.doesNotMatch(JSON.stringify(error), /private-canary|ProcessId|CommandLine/);
      return true;
    });
    assert.equal(state.calls, 1);
    assert.deepEqual(state.sleeps, []);
  });
});

test("Windows process exit does not retry or swallow a CIM failure after a timeout", async (t) => {
  const { run, state } = auditScenario(t, [{ timeout: 30000 }, { error: { code: 1, stderr: "CimException" } }]);
  await assert.rejects(run(), (error) => {
    assert.equal(error.code, "CURSOR_APP_WINDOWS_PROCESS_QUERY_CIM_FAILED");
    assert.equal(error.windowsProcessAudit.firstFailure, "timeout");
    assert.equal(error.windowsProcessAudit.finalStatus, "failed");
    assert.equal(error.windowsProcessAudit.timeoutCount, 1);
    return true;
  });
  assert.equal(state.calls, 2);
});

test("Windows process exit includes polling delays in the budget and never passes a late snapshot", async (t) => {
  for (const owned of [false, true]) await t.test(String(owned), async (t) => {
    const { run, state } = auditScenario(t, [{ owned: true, elapsed: 29000 }, { owned: true, elapsed: 29000 }, { owned, elapsed: 1600 }]);
    await assert.rejects(run(), (error) => {
      assert.equal(error.code, "CURSOR_APP_WINDOWS_PROCESS_AUDIT_TIMEOUT");
      assert.equal(error.windowsProcessAudit.elapsedMs, 60000);
      assert.equal(error.windowsProcessAudit.finalStatus, "budget");
      return true;
    });
    assert.equal(state.calls, 3);
    assert.deepEqual(state.sleeps, [200, 200]);
  });
});

test("Windows process exit retains the 25-query limit including a timeout retry", async (t) => {
  for (const withTimeout of [false, true]) await t.test(String(withTimeout), async (t) => {
    const steps = Array.from({ length: 25 }, () => ({ owned: true }));
    if (withTimeout) steps[0] = { timeout: 30000 };
    const { run, state } = auditScenario(t, steps);
    await assert.rejects(run(), (error) => {
      assert.equal(error.code, "CURSOR_APP_CLEANUP_DESCENDANTS");
      assert.equal(error.windowsProcessAudit.attempts, 25);
      assert.equal(error.windowsProcessAudit.finalStatus, "owned-remains");
      assert.equal(error.windowsProcessAudit.timeoutCount, Number(withTimeout));
      return true;
    });
    assert.equal(state.calls, 25);
    assert.equal(state.sleeps.length, 24);
  });
});

test("Windows process timeout waits for close before starting its retry", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0, time = 0, reject;
  const child = new EventEmitter();
  child.kill = () => { reject(Object.assign(new Error("private-canary"), { killed: true })); };
  const first = new Promise((resolve, fail) => { reject = fail; });
  first.child = child;
  const pending = waitForWindowsProcessesExit(auditOptions, { now: () => time,
    execute: () => ++calls === 1 ? first : Promise.resolve({ stdout: "[]" }),
    sleep: async (ms) => { time += ms; } });
  time = 30000; t.mock.timers.tick(30000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  child.emit("close", null, "SIGKILL");
  const result = await pending;
  assert.equal(calls, 2);
  assert.equal(result.firstFailure, "timeout");
  assert.equal(result.finalStatus, "clear");
});

test("Windows process exit bounds an unconfirmed close and failed termination by the shared budget", async (t) => {
  for (const behavior of ["missing-close", "kill-false", "kill-throws", "cim-before-close"]) await t.test(behavior, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let calls = 0, time = 0, kills = 0, finished = false, reject;
    const child = new EventEmitter();
    child.exitCode = null;
    child.kill = () => {
      kills++;
      if (behavior === "kill-throws") throw new Error("private-canary");
      if (behavior === "kill-false") return false;
      reject(Object.assign(new Error("private-canary"), { killed: true }));
      return true;
    };
    const first = new Promise((resolve, fail) => { reject = fail; });
    first.child = child;
    const pending = waitForWindowsProcessesExit(auditOptions, { now: () => time,
      execute: () => { calls++; return first; }, sleep: () => assert.fail("must not retry before close") });
    const failure = pending.then(() => assert.fail("incomplete query must not pass"), (error) => { finished = true; return error; });
    if (behavior === "cim-before-close") reject(Object.assign(new Error("private-canary"), { code: 1, stderr: "CimException" }));
    await new Promise((resolve) => setImmediate(resolve));
    time = 30000; t.mock.timers.tick(30000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(finished, false);
    time = 59999; t.mock.timers.tick(29999);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(finished, false);
    time = 60000; t.mock.timers.tick(1);
    const error = await failure;
    assert.equal(error.code, "CURSOR_APP_WINDOWS_PROCESS_" + (behavior === "kill-throws" ? "QUERY_FAILED"
      : behavior === "cim-before-close" ? "QUERY_CIM_FAILED" : "QUERY_TIMEOUT"));
    assert.equal(error.windowsProcessAudit.elapsedMs, 60000);
    assert.equal(error.windowsProcessAudit.attempts, 1);
    assert.equal(error.windowsProcessAudit.lastQuery.exitCode, behavior === "cim-before-close" ? 1 : null);
    assert.equal(calls, 1);
    assert.equal(kills, behavior === "cim-before-close" ? 0 : 1);
    assert.doesNotMatch(JSON.stringify(error), /private-canary/);
  });
});

test("Windows process exit caps the last poll delay to the remaining budget", async (t) => {
  const { run, state } = auditScenario(t, [{ owned: true, elapsed: 29000 }, { owned: true, elapsed: 29000 }, { owned: true, elapsed: 1500 }]);
  await assert.rejects(run(), (error) => {
    assert.equal(error.code, "CURSOR_APP_WINDOWS_PROCESS_AUDIT_TIMEOUT");
    assert.equal(error.windowsProcessAudit.elapsedMs, 60000);
    return true;
  });
  assert.equal(state.calls, 3);
  assert.deepEqual(state.sleeps, [200, 200, 100]);
});

test("Windows process query deadline kills and closes only its held helper child", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0, time = 0, closed = false;
  const execute = () => {
    if (++calls > 1) { assert.equal(closed, true); return Promise.resolve({ stdout: "[]" }); }
    const pending = promisify(execFile)(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { encoding: "utf8" });
    pending.child.once("close", () => { closed = true; });
    t.after(() => { if (!closed) pending.child.kill("SIGKILL"); });
    return pending;
  };
  const pending = waitForWindowsProcessesExit(auditOptions, { execute, now: () => time,
    sleep: async (ms) => { time += ms; } });
  time = 30000; t.mock.timers.tick(30000);
  const result = await pending;
  assert.equal(closed, true);
  assert.equal(calls, 2);
  assert.equal(result.timeoutCount, 1);
  assert.equal(result.finalStatus, "clear");
});

test("Windows process audit projection rejects extra, oversized, and malformed diagnostic fields", () => {
  const projected = projectWindowsProcessAuditDiagnostics({ attempts: 26, elapsedMs: Infinity, timeoutCount: 3,
    firstFailure: { toString: "private-canary" }, finalStatus: "private-canary", command: "private-canary",
    lastQuery: { elapsedMs: -1, timedOut: "true", exitCode: 0x100000000, signal: "private-canary",
      stdoutBytes: 4194305, stderrBytes: "12", stdout: "private-canary", rows: ownedRows } });
  assert.deepEqual(projected, { attempts: 0, elapsedMs: 0, timeoutCount: 0, firstFailure: "query-failed", finalStatus: "failed",
    lastQuery: { elapsedMs: 0, timedOut: false, exitCode: null, signal: "other", stdoutBytes: 0, stderrBytes: 0 } });
  assert.deepEqual(projectWindowsProcessAuditDiagnostics(projected), projected);
  assert.doesNotMatch(JSON.stringify(projected), /private-canary|ProcessId|CommandLine/);
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
