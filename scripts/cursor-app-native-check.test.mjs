import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";

const source = await readFile(new URL("./cursor-app-native-check.mjs", import.meta.url), "utf8");

test("native CLI and App launch through the same macOS sandbox invocation without a shell", () => {
  const body = source.split("function spawnOwned(")[1]?.split("\nasync function command(")[0];
  assert.ok(body);
  assert.match(source, /const child = spawnOwned\(process\.execPath,/);
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
