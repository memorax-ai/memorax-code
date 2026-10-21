import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { runInNewContext } from "node:vm";
import { assertCredentialNotEchoed } from "./codex-lifecycle-assertions.mjs";
import { projectTerminalDisposal } from "./codex-setup-pty-evidence.mjs";

const source = (await readFile(new URL("./codex-setup-pty.mjs", import.meta.url), "utf8"))
  .replace(/^#!.*\n/, "").replace(/^import .*;\r?\n/gm, "");
const fixtureKey = "sk_" + "T".repeat(43);
const privateText = "private-terminal-output /private/fixture/account " + fixtureKey;

// Execute the actual helper with an in-memory node-pty boundary. No client,
// subprocess, signal or real timer is involved in these fault cases.
async function runHelper(options = {}) {
  const logs = [], writes = [], timers = new Map();
  let killCalls = 0, onData, onExit, nextTimer = 0;
  const process = { argv: ["node", "helper.mjs", "/fixture/dependency", "/fixture/entrypoint", options.mode ?? "reuse"],
    platform: options.platform ?? "win32", arch: "x64", env: {}, execPath: "/fixture/node", cwd: () => "/fixture/workspace",
    stdin: { async *[Symbol.asyncIterator]() { yield JSON.stringify({ username: "fixture-user", apiKey: fixtureKey }); } } };
  const terminal = {
    onExit(callback) { onExit = callback; },
    onData(callback) {
      onData = callback;
      queueMicrotask(() => {
        for (const data of options.data ?? ["Checking local setup state..."]) callback(data);
        if (!options.noExit) onExit({ exitCode: options.exitCode ?? 0, signal: options.signal ?? 0 });
        for (const data of options.afterExitData ?? []) callback(data);
      });
    },
    write(value) {
      writes.push(value);
      if (options.writeError) throw Object.assign(new Error(privateText), { code: options.writeError });
    },
    kill() {
      killCalls++;
      if (options.killError) throw Object.assign(new Error(privateText), { code: options.killError });
      if (options.killEmitsExit) onExit({ exitCode: 1, signal: 0 });
    },
  };
  const require = (name) => name === "node-pty/package.json" ? { version: "1.1.0" } : {
    spawn() {
      if (options.spawnError) throw Object.assign(new Error(privateText), { code: options.spawnError });
      return terminal;
    },
  };
  require.resolve = () => "/fixture/dependency/node-pty/package.json";
  await runInNewContext("(async () => {\n" + source + "\n})()", {
    Buffer, process, dirname, join, resolve, stripVTControlCharacters, assertCredentialNotEchoed, projectTerminalDisposal,
    createRequire: () => require, stat: async () => ({ isFile: () => true, mode: 0o755 }), chmod: async () => {},
    console: { log: (value) => logs.push(value) },
    setTimeout(callback, ms) {
      const id = ++nextTimer;
      timers.set(id, { callback, ms });
      if (options.timeout && ms === 110000) queueMicrotask(() => { if (timers.has(id)) callback(); });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
  }, { timeout: 1000 });
  assert.equal(logs.length, 1);
  assert.equal(logs[0].includes(fixtureKey), false);
  assert.equal(logs[0].includes("/private/fixture/account"), false);
  return { report: JSON.parse(logs[0]), exitCode: process.exitCode ?? 0, killCalls, writes, timers, onData, onExit };
}

test("successful Windows exit with failed disposal reports failure and safe disposal cause", async () => {
  const result = await runHelper({ killError: "EBUSY" });
  assert.equal(result.report.status, "FAIL");
  assert.equal(result.exitCode, 1);
  assert.equal(result.report.error, "PTY_RESOURCE_DISPOSE_FAILED");
  assert.deepEqual(result.report.terminalDisposal, { status: "failed", exitObserved: true,
    errorCode: "PTY_RESOURCE_DISPOSE_FAILED", systemCode: "EBUSY" });
  assert.equal(result.report.exitCode, 0);
  assert.equal(result.killCalls, 1);
  assert.equal(result.timers.size, 0);
});

test("functional exit failure remains primary when disposal also fails", async () => {
  const result = await runHelper({ exitCode: 1, killError: "EIO" });
  assert.equal(result.report.error, "UNEXPECTED_TERMINAL_EXIT_CODE");
  assert.equal(result.report.terminalDisposal.errorCode, "PTY_RESOURCE_DISPOSE_FAILED");
  assert.equal(result.report.terminalDisposal.systemCode, "EIO");
  assert.equal(result.report.exitCode, 1);
  assert.equal(result.exitCode, 1);
});

test("normal Windows disposal returns once and retains passing terminal checks", async () => {
  const result = await runHelper();
  assert.equal(result.report.status, "PASS");
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.report.terminalDisposal, { status: "returned", exitObserved: true });
  assert.equal(result.killCalls, 1);
  assert.equal(result.report.credentialNotEchoed, true);
});

for (const platform of ["darwin", "linux"]) {
  test(platform + " exit retires the PID without another kill", async () => {
    const result = await runHelper({ platform, killError: "ESRCH" });
    assert.equal(result.report.status, "PASS");
    assert.equal(result.killCalls, 0);
    assert.deepEqual(result.report.terminalDisposal, { status: "not-required-after-exit", exitObserved: true });
  });
}

test("ESRCH from Windows disposal alone does not establish released resources", async () => {
  const result = await runHelper({ killError: "ESRCH" });
  assert.equal(result.report.status, "FAIL");
  assert.equal(result.report.terminalDisposal.systemCode, "ESRCH");
});

for (const [name, options, expected] of [
  ["unexpected saved-account prompt", { data: ["MemoraX API key:"], noExit: true }, "SAVED_ACCOUNT_UNEXPECTEDLY_REQUESTED_INPUT"],
  ["output limit", { data: ["x".repeat(2 * 1024 * 1024 + 1), privateText], noExit: true }, "TERMINAL_OUTPUT_LIMIT_EXCEEDED"],
  ["deadline", { data: [], timeout: true, noExit: true }, "TERMINAL_CASE_TIMEOUT"],
  ["input write", { data: ["\x1b[6n"], noExit: true, writeError: "EIO" }, "TERMINAL_INPUT_WRITE_FAILED"],
]) {
  test(name + " retains its first failure when kill throws and no exit arrives", async () => {
    const result = await runHelper({ ...options, killError: "EBUSY" });
    assert.equal(result.report.error, expected);
    assert.equal(result.report.status, "FAIL");
    assert.equal(result.exitCode, 1);
    assert.equal(result.report.exitObserved, false);
    assert.equal(result.report.exitCode, undefined);
    assert.equal(result.report.terminalDisposal.status, "failed");
    assert.equal(result.killCalls, 1);
    assert.equal(result.timers.size, 0);
  });
}

test("an abort with successful kill is not disposed a second time in finally", async () => {
  const result = await runHelper({ data: ["MemoraX API key:"], noExit: true, killEmitsExit: true });
  assert.equal(result.report.error, "SAVED_ACCOUNT_UNEXPECTEDLY_REQUESTED_INPUT");
  assert.equal(result.report.terminalDisposal.status, "returned");
  assert.equal(result.report.exitObserved, true);
  assert.equal(result.killCalls, 1);
});

test("spawn failure is preserved without inventing a disposal attempt", async () => {
  const result = await runHelper({ spawnError: "ENOENT" });
  assert.equal(result.report.nativeErrorCode, "ENOENT");
  assert.equal(result.report.terminalDisposal.status, "not-created");
  assert.equal(result.killCalls, 0);
});

test("delayed credential input is cleared before disposal and late output cannot mutate a report", async () => {
  const result = await runHelper({ mode: "cancel", data: ["Username from your existing MemoraX Code setup:", "MemoraX API key:"], exitCode: 1 });
  const before = JSON.stringify(result.report);
  result.onData(privateText);
  result.onExit({ exitCode: 99, signal: 9 });
  assert.equal(result.timers.size, 0);
  assert.equal(result.writes.some((value) => value.includes(fixtureKey)), false);
  assert.equal(JSON.stringify(result.report), before);
});

test("disposal projection accepts only the fixed typed fields", () => {
  assert.deepEqual(projectTerminalDisposal({ status: "failed", exitObserved: true,
    errorCode: privateText, systemCode: "EBUSY", path: privateText, pid: 1234, stdout: privateText }),
  { status: "failed", exitObserved: true, errorCode: "PTY_RESOURCE_DISPOSE_FAILED", systemCode: "EBUSY" });
  assert.deepEqual(projectTerminalDisposal({ status: "failed", exitObserved: false, systemCode: privateText }),
    { status: "failed", exitObserved: false, errorCode: "PTY_RESOURCE_DISPOSE_FAILED" });
  assert.equal(projectTerminalDisposal({ status: privateText, exitObserved: false }), undefined);
  assert.equal(projectTerminalDisposal({ status: "failed", exitObserved: privateText }), undefined);
  assert.equal(projectTerminalDisposal(null), undefined);
});

test("data delivered after exit in the same tick still participates in credential rejection", async () => {
  const result = await runHelper({ afterExitData: [fixtureKey] });
  assert.equal(result.report.status, "FAIL");
  assert.equal(result.report.error, "TERMINAL_DISCLOSED_FIXTURE_CREDENTIAL");
  assert.equal(result.report.terminalDisposal.status, "returned");
  assert.equal(result.exitCode, 1);
});
