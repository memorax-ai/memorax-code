import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { assertBackendReplacement, assertCredentialNotEchoed, assertSetupInputRejection,
  snapshotProtectedConfiguration, assertProtectedConfiguration } from "./codex-lifecycle-assertions.mjs";

function configuration() {
  return { memorax: { user_id: "retained-account-not-system-user", api_key: "synthetic-credential",
    endpoint: "http://127.0.0.1:32123" }, clients: { codex: true, claude: false },
  memory: { writeback: { enabled: false, buffer_max_turns: 8 }, cli: { add_enabled: false } },
  jev: { enabled: false }, runtime: { path: "old-owned-runtime" } };
}

test("preservation permits managed defaults, runtime paths and previously undecided clients to change", () => {
  const original = configuration();
  const expected = snapshotProtectedConfiguration(original);
  const updated = structuredClone(original);
  updated.runtime.path = "new-owned-runtime";
  updated.memory.writeback.buffer_max_turns = 12;
  updated.memory.writeback.chunk_enabled = true;
  updated.clients.cursor = true;
  assert.doesNotThrow(() => assertProtectedConfiguration(updated, expected));
  assert.equal(Object.hasOwn(expected.clients, "cursor"), false);
});

test("each account field is protected independently, without exposing either value on failure", () => {
  const original = configuration();
  const expected = snapshotProtectedConfiguration(original);
  for (const field of ["user_id", "api_key", "endpoint"]) {
    for (const value of [undefined, "", `unexpected-${field}`]) {
      const changed = structuredClone(original);
      changed.memorax[field] = value;
      assert.throws(() => assertProtectedConfiguration(changed, expected), (error) => {
        assert.equal(error.message, `PROTECTED_ACCOUNT_CHANGED_${field.toUpperCase()}`);
        assert.equal(error.actual, false);
        assert.equal(error.expected, true);
        assert.ok(!error.stack.includes(original.memorax.api_key));
        return true;
      });
    }
  }
});

test("explicit client and feature choices cannot become defaults, including during uninstall", () => {
  const original = configuration();
  const expected = snapshotProtectedConfiguration(original);
  for (const mutate of [
    (config) => { config.clients.codex = false; },
    (config) => { config.clients.claude = true; },
    (config) => { delete config.clients.claude; },
    (config) => { config.memory.writeback.enabled = true; },
    (config) => { delete config.memory.writeback.enabled; },
    (config) => { config.memory.cli.add_enabled = true; },
    (config) => { config.jev.enabled = true; },
  ]) {
    const changed = structuredClone(original);
    mutate(changed);
    assert.throws(() => assertProtectedConfiguration(changed, expected), /PROTECTED_(?:CLIENT|FEATURE)_CHOICE_CHANGED/);
  }
});

test("an incomplete account cannot silently become the preservation baseline", () => {
  for (const field of ["user_id", "api_key", "endpoint"]) {
    const incomplete = configuration();
    delete incomplete.memorax[field];
    assert.throws(() => snapshotProtectedConfiguration(incomplete), /PROTECTED_ACCOUNT_FIXTURE_INVALID/);
  }
});

test("invalid setup input requires the public rejection, not an arbitrary process failure", () => {
  const expected = { code: 2, signal: null, killed: false,
    stderr: "memorax-code setup: stdin must contain one non-empty API Key\n",
    stdout: "Usage: memorax-code setup [--existing-account | --reconfigure]\n" };
  assert.doesNotThrow(() => assertSetupInputRejection(expected));
  for (const unexpected of [
    { code: 1, stderr: "TypeError: cannot read properties of undefined\n" },
    { code: 2, stderr: "memorax-code setup: Cannot read properties of undefined\n" },
    { code: 2, signal: "SIGTERM" },
    { code: 2, killed: true },
    { code: 0 },
    { stdout: "" },
  ]) assert.throws(() => assertSetupInputRejection({ ...expected, ...unexpected }));
});

test("masked prompts cannot hide a credential echoed through ANSI styling or repainting", () => {
  const key = "sk_fixture_credential_canary";
  assert.doesNotThrow(() => assertCredentialNotEchoed(`API key: ${"*".repeat(key.length)}\r\n`, key));
  for (const leaked of [key, `${key.slice(0, 8)}\x1b[0m${key.slice(8)}`,
    [...key].join("\x1b[32m"), `${key.slice(0, 8)}\x1b[1C${key.slice(8)}`]) {
    assert.throws(() => assertCredentialNotEchoed(`${"*".repeat(key.length)}\n${leaked}`, key),
      /TERMINAL_DISCLOSED_FIXTURE_CREDENTIAL/);
  }
});

test("package replacement requires a new live identity and retirement of the previous process", () => {
  const before = { pid: 101, instanceId: "old-instance" };
  const after = { pid: 202, instanceId: "new-instance" };
  const health = { ok: true, service: "memorax-code-backend", instanceId: "new-instance" };
  assert.doesNotThrow(() => assertBackendReplacement(before, after, health, false));
  for (const [current, response, alive] of [
    [before, { ...health, instanceId: "old-instance" }, true],
    [{ ...after, instanceId: "old-instance" }, health, false],
    [after, health, true],
    [after, { ...health, instanceId: "old-instance" }, false],
    [after, { ...health, ok: false }, false],
    [after, { ...health, service: "unrelated-service" }, false],
  ]) assert.throws(() => assertBackendReplacement(before, current, response, alive));
});

function trackingFixture(source) {
  const extract = (start, end) => {
    const begin = source.indexOf(start);
    const finish = source.indexOf(end, begin);
    assert.ok(begin >= 0 && finish > begin);
    return source.slice(begin, finish);
  };
  const before = { pid: 103, instanceId: "retired-instance" };
  const after = { pid: 104, instanceId: "current-instance", url: "http://127.0.0.1:32123" };
  const health = { ok: true, service: "memorax-code-backend", instanceId: after.instanceId };
  const livePids = new Set([after.pid]);
  const probeErrors = new Map();
  const probedPids = [];
  const context = {
    stage: "", cleanupStage: "", cleanupTrackedPidIndex: undefined,
    backendPids: new Set([101, 102, before.pid, after.pid, 105]), backendPort: 32123,
    report: { checks: [] }, portProbes: 0,
    pidPath: () => "synthetic-record", exists: async () => context.pidRecordPresent === true,
    readJson: async () => { if (context.recordError) throw context.recordError; return after; },
    process: { kill(pid, signal) {
      assert.equal(signal, 0);
      probedPids.push(pid);
      if (probeErrors.has(pid)) throw probeErrors.get(pid);
      if (!livePids.has(pid)) throw Object.assign(new Error("not found"), { code: "ESRCH" });
    } },
    URL, AbortSignal: { timeout: () => undefined },
    fetch: async () => ({ ok: true, json: async () => health }),
    assertBackendReplacement,
    check: (condition, message) => { if (!condition) throw new Error(message); },
    createTcpServer: () => ({ once() {}, listen(_port, _host, done) {
      context.portProbes += 1;
      if (context.portError) throw context.portError;
      done();
    }, close(done) { done(); } }),
  };
  // Execute the runners' real tracking logic with no process, network or state access.
  const methods = runInNewContext(
    extract("async function verifyBackendReplacement(", "async function stopAndVerify(")
      + extract("async function assertStopped(", "async function verifyPreserved(")
      + "\n({ verifyBackendReplacement, assertStopped });", context);
  return { ...methods, context, before, after, health, livePids, probeErrors, probedPids };
}

for (const script of ["codex-install-smoke.mjs", "opencode-install-smoke.mjs",
  "claude-install-smoke.mjs", "codebuddy-lifecycle-check.mjs"]) {
  const source = await readFile(new URL(script, import.meta.url), "utf8");

  test(`${script}: confirmed retired PID reuse cannot fail final cleanup`, async () => {
    const f = trackingFixture(source);
    await f.verifyBackendReplacement(f.before, "replacement");
    assert.equal(f.context.backendPids.has(f.after.pid), true);
    f.livePids.clear();
    f.livePids.add(f.before.pid);
    f.probedPids.length = 0;
    await f.assertStopped();
    assert.equal(f.probedPids.includes(f.before.pid), false);
    assert.equal(f.context.portProbes, 1);
    assert.equal(f.context.backendPids.size, 0);
  });

  test(`${script}: failed replacement verification retains every tracked PID`, async () => {
    for (const [mutate, expected] of [
      [(f) => f.livePids.add(f.before.pid), /BACKEND_REPLACEMENT_OLD_PROCESS_ALIVE/],
      [(f) => f.probeErrors.set(f.before.pid, { code: "EPERM" }), { code: "EPERM" }],
      [(f) => { f.context.recordError = { code: "ENOENT" }; }, { code: "ENOENT" }],
      [(f) => f.livePids.delete(f.after.pid), /Updated Backend PID does not identify a live process/],
      [(f) => { f.health.instanceId = "another-instance"; }, /BACKEND_REPLACEMENT_HEALTH_IDENTITY_MISMATCH/],
    ]) {
      const f = trackingFixture(source);
      const tracked = [...f.context.backendPids];
      mutate(f);
      await assert.rejects(f.verifyBackendReplacement(f.before, "replacement"), expected);
      assert.deepEqual([...f.context.backendPids], tracked);
    }
  });

  test(`${script}: remaining process, record and port failures still fail cleanup`, async () => {
    for (const [mutate, expected, portProbes] of [
      [(f) => f.livePids.add(f.after.pid), /An installation Backend process remains after stop/, 0],
      [(f) => { f.context.pidRecordPresent = true; }, /Backend PID record remains after stop/, 0],
      [(f) => f.probeErrors.set(f.after.pid, { code: "EPERM" }), { code: "EPERM" }, 0],
      [(f) => { f.context.portError = { code: "EADDRINUSE" }; }, { code: "EADDRINUSE" }, 1],
    ]) {
      const f = trackingFixture(source);
      await f.verifyBackendReplacement(f.before, "replacement");
      f.livePids.clear();
      const tracked = [...f.context.backendPids];
      mutate(f);
      await assert.rejects(f.assertStopped(), expected);
      assert.deepEqual([...f.context.backendPids], tracked);
      assert.equal(f.context.portProbes, portProbes);
    }
  });
}
