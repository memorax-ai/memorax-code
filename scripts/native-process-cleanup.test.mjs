import assert from "node:assert/strict";
import { win32 } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { stopNativeProcessTree as stopCodex } from "./codex-native-support.mjs";
import { stopNativeProcessTree as stopClaude } from "./claude-native-support.mjs";
import { stopNativeProcessTree as stopCodeBuddy } from "./codebuddy-native-support.mjs";
import { stopNativeProcessTree as stopOpenCode } from "./opencode-native-support.mjs";

const pid = 4312;
const helpers = [["Codex", stopCodex], ["Claude", stopClaude], ["CodeBuddy", stopCodeBuddy], ["OpenCode", stopOpenCode]];

function cleanupFixture(implementation, platform = "win32") {
  const env = { SystemRoot: "C:\\Windows" };
  const calls = { probes: [], taskkills: 0, signals: [], waits: 0 };
  const alive = { leader: true, group: true };
  const processAlive = (target) => {
    assert.ok(target === pid || target === -pid);
    calls.probes.push(target);
    return target === pid ? alive.leader : alive.group;
  };
  // Execute the real implementation with synthetic process effects on every host.
  const stop = runInNewContext(`(${implementation.toString()})`, {
    process: { platform, kill(target, signal) {
      calls.signals.push([target, signal]);
      assert.equal(target, -pid);
      assert.equal(signal, "SIGKILL");
      alive.leader = false;
      alive.group = false;
    } },
    processAlive, isAlive: processAlive, join: win32.join,
    async execFileAsync(command, args, options) {
      calls.taskkills += 1;
      assert.equal(platform, "win32");
      assert.equal(command, "C:\\Windows\\System32\\taskkill.exe");
      assert.deepEqual([...args], ["/PID", String(pid), "/T", "/F"]);
      assert.equal(options.env, env);
      assert.equal(options.windowsHide, true);
      assert.equal(options.timeout, 10_000);
      alive.leader = false;
      alive.group = false;
    },
    async waitFor(predicate, code, timeout) {
      calls.waits += 1;
      assert.equal(code, "NATIVE_CHILD_PROCESS_REMAINS");
      assert.equal(timeout, 10_000);
      assert.equal(predicate(), true);
    },
  });
  return { stop: (child) => stop(child, env), calls, alive };
}

for (const [name, implementation] of helpers) {
  for (const [reason, status] of [
    ["zero exit code", { exitCode: 0, signalCode: null }],
    ["nonzero exit code", { exitCode: 7, signalCode: null }],
    ["termination signal", { exitCode: null, signalCode: "SIGTERM" }],
    ["exit code without signal metadata", { exitCode: 0 }],
    ["signal without exit metadata", { signalCode: "SIGKILL" }],
  ]) {
    test(`${name} ignores an exited Windows child with ${reason} even when its PID is reused`, async () => {
      const f = cleanupFixture(implementation);
      await f.stop({ pid, ...status });
      assert.deepEqual(f.calls, { probes: [], taskkills: 0, signals: [], waits: 0 });
      assert.equal(f.alive.leader, true);
    });
  }

  test(`${name} still stops a running Windows child`, async () => {
    const f = cleanupFixture(implementation);
    await f.stop({ pid, exitCode: null, signalCode: null });
    assert.equal(f.calls.taskkills, 1);
    assert.deepEqual(f.calls.signals, []);
    assert.equal(f.alive.leader, false);
  });

  test(`${name} does not mistake a sent signal for a completed Windows exit`, async () => {
    const f = cleanupFixture(implementation);
    await f.stop({ pid, exitCode: null, signalCode: null, killed: true });
    assert.equal(f.calls.taskkills, 1);
    assert.deepEqual(f.calls.signals, []);
    assert.equal(f.alive.leader, false);
  });

  test(`${name} does not treat unknown Windows exit metadata as an exited child`, async () => {
    for (const status of [
      {},
      { exitCode: undefined, signalCode: undefined },
      { exitCode: null, signalCode: undefined },
      { exitCode: undefined, signalCode: null },
    ]) {
      const f = cleanupFixture(implementation);
      await f.stop({ pid, ...status });
      assert.equal(f.calls.taskkills, 1);
      assert.deepEqual(f.calls.signals, []);
      assert.equal(f.alive.leader, false);
    }
  });

  test(`${name} does not revisit a reused Windows PID on cleanup after the child exits`, async () => {
    const f = cleanupFixture(implementation);
    const child = { pid, exitCode: null, signalCode: null };
    await f.stop(child);
    assert.equal(f.calls.taskkills, 1);
    const firstCleanup = structuredClone(f.calls);
    child.exitCode = 0;
    f.alive.leader = true;
    f.alive.group = true;
    await f.stop(child);
    assert.deepEqual(f.calls, firstCleanup);
    assert.equal(f.alive.leader, true);
  });

  for (const platform of ["linux", "darwin"]) {
    test(`${name} still kills surviving ${platform} descendants after their leader exits`, async () => {
      const f = cleanupFixture(implementation, platform);
      f.alive.leader = false;
      await f.stop({ pid, exitCode: 0, signalCode: null });
      assert.deepEqual(f.calls.signals, [[-pid, "SIGKILL"]]);
      assert.equal(f.calls.taskkills, 0);
      assert.equal(f.alive.group, false);
    });
  }
}
