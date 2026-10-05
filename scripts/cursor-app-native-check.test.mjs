import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { collectCursorAppStopDiagnostics, projectCursorAppSandboxDiagnostics } from "./cursor-app-diagnostics.mjs";

const source = (await readFile(new URL("./cursor-app-native-check.mjs", import.meta.url), "utf8")).replaceAll("\r\n", "\n");

test("actual candidate command keeps only macOS cleanup stop outside the sandbox and preserves outcomes", async () => {
  const body = source.split("async function command(")[1]?.split("\nasync function ownedProcessesRemain(")[0];
  const cliBody = source.split("  cli = ")[1]?.split(";\n")[0];
  assert.ok(body);
  assert.ok(cliBody);
  const privateCanary = "private-stop-path-token-canary";
  const failure = { ok: false, action: "stop", backend: { ok: false, errorCode: "BACKEND_STOP_TIMEOUT",
    stage: "wait_stopped", processState: "running", state: { path: privateCanary }, error: privateCanary } };
  const modes = ["failed-stop", "successful-stop", "invalid-json", "failed-start", "failed-status", "failed-restart", "timeout", "overflow"];
  for (const [isMacos, mode] of [false, true].flatMap((isMacos) => modes.map((mode) => [isMacos, mode]))) {
    const action = ["failed-start", "failed-status", "failed-restart"].includes(mode) ? mode.slice(7) : "stop";
    const report = {}, kills = [], timers = [], env = { HOME: "/owned/home", MEMORAX_CODE_HOME: "/owned/state", CURSOR_HOME: "/owned/cursor" };
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null });
    let closed = false, collected = false;
    const close = (exitCode, signal = null) => {
      if (closed) return;
      closed = true; child.exitCode = exitCode; child.signalCode = signal;
      child.stdout.end(); child.stderr.end(); child.emit("close", exitCode, signal);
    };
    child.kill = (signal) => { kills.push(signal); queueMicrotask(() => close(null, signal)); };
    function startCommand(route, file, args, options) {
      assert.equal(route, isMacos && action === "stop" ? "controller" : "owned");
      assert.equal(file, "/owned/node");
      assert.deepEqual(Array.from(args), [join("/owned/package", "bin/memorax-code.mjs"), action,
        "--home", env.MEMORAX_CODE_HOME, "--cursor-home", env.CURSOR_HOME, "--port", "18787", "--clients", "cursor", "--json"]);
      assert.equal(options.cwd, join("/owned", "workspace")); assert.equal(options.env === env, true);
      assert.deepEqual(Array.from(options.stdio), ["ignore", "pipe", "pipe"]);
      assert.equal(options.shell, undefined);
      queueMicrotask(() => {
        child.stderr.write(privateCanary);
        if (mode === "timeout") { timers[0](); return; }
        if (mode === "overflow") { child.stdout.write("x".repeat(1024 * 1024 + 1)); return; }
        child.stdout.write(mode === "invalid-json" ? privateCanary : JSON.stringify(mode === "successful-stop" ? { ok: true } : failure));
        close(mode === "successful-stop" || mode === "invalid-json" ? 0 : 1);
      });
      return child;
    }
    const command = runInNewContext(`(async function command(${body})`, {
      process: { execPath: "/owned/node" }, packageRoot: "/owned/package", root: "/owned", env, report, join, once,
      macos: isMacos ? {} : undefined,
      collectCursorAppStopDiagnostics(value) { collected = true; return collectCursorAppStopDiagnostics(value); },
      check(value, code) {
        if (action === "stop") assert.equal(collected, true, "stop JSON is projected before checking the exit");
        if (!value) throw Object.assign(new Error(code), { code });
      },
      setTimeout(callback, timeout) { assert.equal(timeout, 30000); timers.push(callback); return callback; },
      clearTimeout(timer) { assert.equal(timer, timers[0]); timers.length = 0; },
      spawn: (...args) => startCommand("controller", ...args),
      spawnOwned: (...args) => startCommand("owned", ...args),
    }, { timeout: 100 });
    const cli = runInNewContext(cliBody, { command, env, backendPort: 18787 }, { timeout: 100 });
    const code = `CURSOR_APP_CANDIDATE_${action.toUpperCase()}`;
    if (mode === "successful-stop") assert.equal((await cli(action)).ok, true);
    else await assert.rejects(cli(action), { code });
    assert.equal(timers.length, 0);
    assert.deepEqual(kills, ["timeout", "overflow"].includes(mode) ? ["SIGKILL"] : []);
    if (mode === "successful-stop" || action !== "stop") assert.equal(report.candidateStop, undefined);
    else {
      assert.ok(report.candidateStop);
      assert.equal(report.candidateStop.timedOut, mode === "timeout");
      assert.equal(report.candidateStop.outputOverflow, mode === "overflow");
      if (mode === "failed-stop") assert.equal(report.candidateStop.backend.errorCode, "BACKEND_STOP_TIMEOUT");
      if (mode === "invalid-json") assert.equal(report.candidateStop.jsonStatus, "invalid");
      assert.equal(JSON.stringify(report).includes(privateCanary), false);
    }
  }
});

test("native failures capture the current App outcome before cleanup changes process state", () => {
  const capture = source.indexOf("if (app) report.appLaunch = collectCursorAppLaunchDiagnostics(");
  const cleanup = source.indexOf("finally {\n  await stopSandboxDiagnostics();");
  assert.ok(capture > 0 && cleanup > capture);
  assert.match(source, /appLaunchLog = ""; appSpawnError = undefined; appDebugEndpointSeen = false;/);
  assert.match(source, /exitCode: app\.exitCode, signal: app\.signalCode/);
  assert.match(source, /spawnError: appSpawnError, log: appLaunchLog/);
});

test("sandbox stream stops once and preserves the primary failure while checking collector cleanup", async () => {
  const body = source.split("async function stopSandboxDiagnostics() {")[1]?.split("\nasync function startApp() {")[0];
  assert.ok(body);
  for (const [present, appStartPending, closes, throws] of [
    [false, true, true, false], [true, false, true, false], [true, true, true, false],
    [true, true, false, false], [true, false, false, false], [true, true, false, true],
  ]) {
    const report = { status: "FAIL", errorCode: "CURSOR_APP_EXITED" };
    let calls = 0;
    const capture = runInNewContext(`(async function stopSandboxDiagnostics() { ${body})`, {
      report, appStartPending,
      Date: { now: () => 2000 }, projectCursorAppSandboxDiagnostics,
      appSandboxStream: present ? { async stop(endedAt) {
        calls++;
        assert.equal(endedAt, 2000);
        if (throws) throw new Error("private-log-canary");
        return { closed: closes, diagnostics: projectCursorAppSandboxDiagnostics({ status: "collected", reason: "none",
          markers: { sandboxCompiledPolicyFailed: true } }) };
      } } : undefined,
    }, { timeout: 100 });
    await capture();
    await capture();
    assert.equal(calls, present ? 1 : 0);
    assert.equal(report.status, "FAIL"); assert.equal(report.errorCode, "CURSOR_APP_EXITED");
    assert.equal(report.cleanupError, present && !closes ? "CURSOR_APP_SANDBOX_LOG_CLEANUP" : undefined);
    if (present && appStartPending) {
      assert.equal(report.appSandboxLog.status, throws ? "unavailable" : "collected");
      assert.equal(report.appSandboxLog.reason, throws ? "execute-failed" : "none");
    } else assert.equal(report.appSandboxLog, undefined);
    assert.equal(JSON.stringify(report).includes("private-log-canary"), false);
  }
});

test("the trusted collector starts before the sandboxed App and closes on ready, failure and finally", async () => {
  const launch = source.split("async function startApp() {")[1].split("\nasync function openSession(")[0];
  assert.match(launch, /appStartedAt = Date\.now\(\); appStartPending = true;/);
  assert.ok(launch.indexOf("await macos.startMacosSandboxDiagnostics") < launch.indexOf("app = spawnOwned"));
  assert.match(launch, /await assertLoopbackListeners\(\);\n  appStartPending = false;\n  await stopSandboxDiagnostics\(\);\n}/);
  assert.match(source, /await stopSandboxDiagnostics\(\);\n  const run = agent\?\.runs\.at\(-1\);/);
  assert.match(source, /finally \{\n  await stopSandboxDiagnostics\(\);\n  try \{ await stopApp\(\);/);
  assert.equal(source.includes("collectMacosSandboxDiagnostics"), false);
  const beforeSpawn = launch.slice(0, launch.indexOf("  const endpoint = "));
  for (const throws of [false, true]) {
    const report = {};
    let calls = 0;
    await runInNewContext(`(async function() { ${beforeSpawn} })`, {
      report, Date: { now: () => 1000 }, projectCursorAppSandboxDiagnostics,
      macosPaths: { appBundle: "/owned/Cursor.app", home: "/owned/home" },
      macos: { async startMacosSandboxDiagnostics(options) {
        calls++;
        assert.deepEqual(JSON.parse(JSON.stringify(options)), { appBundle: "/owned/Cursor.app", home: "/owned/home", startedAt: 1000 });
        if (throws) throw new Error("private-log-canary");
        return { stop() {} };
      } },
    }, { timeout: 100 })();
    assert.equal(calls, 1);
    assert.equal(report.errorCode, undefined);
    assert.equal(report.cleanupError, throws ? "CURSOR_APP_SANDBOX_LOG_CLEANUP" : undefined);
    assert.equal(JSON.stringify(report).includes("private-log-canary"), false);
  }
});

test("owned native commands and App launch retain the same macOS sandbox invocation without a shell", () => {
  const body = source.split("function spawnOwned(")[1]?.split("\nasync function command(")[0];
  assert.ok(body);
  assert.match(source, /const spawnCommand = macos && args\[0\] === "stop" \? spawn : spawnOwned;/);
  assert.match(source, /app = spawnOwned\(appPath,/);
  for (const sandboxed of [false, true]) {
    const calls = [], options = { env: { HOME: "/owned/home" }, cwd: "/owned/workspace" };
    const spawnOwned = runInNewContext(`(function spawnOwned(${body})`, {
      sandboxProfile: "owned profile",
      macos: sandboxed ? { sandboxInvocation(file, args, profile) {
        assert.equal(profile, "owned profile"); return { file: "/usr/bin/sandbox-exec", args: ["-p", profile, file, ...args] };
      } } : undefined,
      spawn(file, args, actualOptions) { calls.push({ file, args, actualOptions }); return "owned child"; },
    }, { timeout: 100 });
    assert.equal(spawnOwned("/owned/Node", ["an argument with spaces"], options), "owned child");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].actualOptions, options);
    assert.equal(calls[0].file, sandboxed ? "/usr/bin/sandbox-exec" : "/owned/Node");
    assert.deepEqual(Array.from(calls[0].args), sandboxed
      ? ["-p", "owned profile", "/owned/Node", "an argument with spaces"] : ["an argument with spaces"]);
  }
});

test("macOS cleanup uses the read-only owned-path and observed-PID audit without scanning Linux proc", async () => {
  const body = source.split("async function ownedProcessesRemain(")[1]?.split("\nasync function assertLoopbackListeners(")[0];
  const calls = [], observedMacosPids = new Set([234]);
  const audit = runInNewContext(`(async function ownedProcessesRemain(${body})`, {
    process: { pid: 123 }, macosPaths: { appBundle: "/owned/Cursor.app" }, packageRoot: "/owned/package",
    env: { MEMORAX_CODE_HOME: "/owned/state" }, interruption: { marker: "/owned/marker" }, observedMacosPids,
    macos: { auditMacosProcesses(options) { calls.push(options); return true; } },
    readdir() { assert.fail("macOS must not use /proc"); },
  }, { timeout: 100 });
  assert.equal(await audit({ includeBackend: false }), true);
  assert.equal(calls[0].observedPids, observedMacosPids);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ appBundle: "/owned/Cursor.app", packageRoot: "/owned/package",
    stateHome: "/owned/state", marker: "/owned/marker", includeBackend: false, selfPid: 123, observedPids: {} }]);
});

test("macOS cleanup records descendants before browser shutdown and still closes after an audit failure", async () => {
  const body = source.split("async function stopApp(")[1]?.split("\nasync function assertProcessesStopped(")[0];
  assert.ok(body);
  for (const failCapture of [false, true]) {
    const calls = [], observedMacosPids = new Set([200]);
    const error = Object.assign(new Error("audit failed"), { code: "CURSOR_APP_MACOS_PROCESS_AUDIT" });
    const app = { pid: 201, exitCode: null, signalCode: null };
    const stopApp = runInNewContext(`(async function stopApp(${body})`, {
      macos: { async captureMacosDescendants(pid) {
        calls.push("capture"); assert.equal(pid, 201);
        if (failCapture) throw error;
        return new Set([201, 202]);
      } }, app, observedMacosPids, page: {},
      browser: { async close() { calls.push("close"); app.exitCode = 0; } },
      bounded: (promise) => promise,
      once() { assert.fail("an exited owned child must not receive signals"); },
    }, { timeout: 100 });
    if (failCapture) await assert.rejects(stopApp(), (caught) => caught === error);
    else await stopApp();
    assert.deepEqual(calls, ["capture", "close"]);
    assert.deepEqual([...observedMacosPids], failCapture ? [200] : [200, 201, 202]);
  }
});

test("native cleanup audits the pending marker Node and Shell without killing discovered processes", async () => {
  const body = source.split("async function ownedProcessesRemain(")[1]?.split("\nasync function assertLoopbackListeners(")[0];
  assert.ok(body);
  const marker = "/owned/workspace/cancelled-shell-marker";
  for (const [argv, includeBackend, expected] of [
    [["/usr/local/bin/node", "-e", "synthetic marker script", marker], true, true],
    [["/bin/sh", "-c", `/usr/local/bin/node -e 'synthetic marker script' '${marker}'`], true, true],
    [["/owned/app/cursor"], false, true],
    [["node", "/owned/package/backend.mjs"], true, true],
    [["node", "/owned/package/backend.mjs"], false, false],
    [["node", "--home", "/owned/state"], true, true],
    [["node", "/unrelated/workspace/cancelled-shell-marker"], true, false],
    [["node", "/owned/state-other/tool.mjs"], true, false],
  ]) {
    const check = runInNewContext(`(async function ownedProcessesRemain(${body})`, {
      process: { pid: 1 }, macos: undefined, dirname, appPath: "/owned/app/cursor", packageRoot: "/owned/package",
      env: { MEMORAX_CODE_HOME: "/owned/state" }, interruption: { marker },
      async readdir(path) { assert.equal(path, "/proc"); return ["1", "2", "self"]; },
      async readFile(path, encoding) {
        assert.equal(path, "/proc/2/cmdline"); assert.equal(encoding, "utf8");
        return argv.join("\0");
      },
    }, { timeout: 100 });
    assert.equal(await check({ includeBackend }), expected);
  }
});

test("actual macOS listener checks fail closed and leave Linux unchanged", async () => {
  const body = source.split("async function assertLoopbackListeners(")[1]?.split("\nfunction assertWriteback()")[0];
  assert.ok(body);
  for (const mode of ["linux", "pass", "fail"]) {
    const report = {}, calls = [];
    const audit = runInNewContext(`(async function assertLoopbackListeners(${body})`, {
      macos: mode === "linux" ? undefined : { async auditMacosListeners(options) {
        calls.push(options);
        if (mode === "fail") throw Object.assign(new Error("listener audit failed"), { code: "CURSOR_APP_MACOS_LISTENER_AUDIT" });
      } }, app: { pid: 200 }, macosPaths: { appBundle: "/owned/Cursor.app" }, packageRoot: "/owned/package",
      env: { MEMORAX_CODE_HOME: "/owned/state" }, backendPort: 18787, debugPort: 9222, process: { pid: 123 }, report,
    }, { timeout: 100 });
    if (mode === "fail") await assert.rejects(audit(), { code: "CURSOR_APP_MACOS_LISTENER_AUDIT" });
    else await audit();
    assert.equal(report.listenerAuditCount, mode === "pass" ? 1 : undefined);
    assert.equal(calls.length, mode === "linux" ? 0 : 1);
    if (calls.length) assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), {
      appPid: 200, appBundle: "/owned/Cursor.app", packageRoot: "/owned/package", stateHome: "/owned/state",
      backendPort: 18787, debugPort: 9222, selfPid: 123,
    });
  }
  for (const [start, end, expected] of [["async function startApp(", "async function openSession(", 1],
    ["async function runTurn(", "async function assertInterrupted(", 1],
    ["async function interruptPendingShell(", "\ntry {", 2]]) {
    const block = source.split(start)[1].split(end)[0];
    assert.equal(block.match(/await assertLoopbackListeners\(\)/g)?.length, expected);
  }
  assert.match(source, /check\(report\.listenerAuditCount === 10, "CURSOR_APP_MACOS_LISTENER_AUDIT_COUNT"\)/);
});
