import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { assertBackendReplacement, verifyBackendReplacementState, projectBackendReplacementDiagnostic,
  assertCredentialNotEchoed, assertSetupInputRejection,
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

function replacementFixture() {
  const before = { pid: 103, instanceId: "retired-instance" };
  const after = { pid: 104, instanceId: "current-instance", url: "http://127.0.0.1:32123" };
  const health = { ok: true, service: "memorax-code-backend", instanceId: after.instanceId };
  const f = { before, after, health, livePids: new Set([after.pid]), probeErrors: new Map(), probedPids: [],
    diagnostics: [], fetches: 0, responseOk: true };
  f.probe = (pid) => {
    f.probedPids.push(pid);
    if (f.probeErrors.has(pid)) throw f.probeErrors.get(pid);
    if (!f.livePids.has(pid)) throw Object.assign(new Error("not found"), { code: "ESRCH" });
  };
  f.options = {
    readAfter: async () => { if (f.recordError) throw f.recordError; return f.after; },
    expectedUrl: after.url, probe: f.probe,
    fetchHealth: async () => {
      f.fetches += 1;
      if (f.fetchError) throw f.fetchError;
      return { ok: f.responseOk, json: async () => { if (f.jsonError) throw f.jsonError; return f.health; } };
    },
    observe: (value) => { f.diagnostics.push(value); if (f.observerError) throw f.observerError; },
  };
  f.verify = () => verifyBackendReplacementState(f.before, f.options);
  f.reusePid = () => { f.livePids.delete(f.after.pid); f.after.pid = f.before.pid; f.livePids.add(f.after.pid); };
  return f;
}

test("replacement accepts both a different PID and a reused PID only with a new live health identity", async () => {
  for (const reuse of [false, true]) {
    const f = replacementFixture();
    if (reuse) f.reusePid();
    assert.equal(await f.verify(), f.after);
    assert.equal(f.diagnostics.length, 1);
    assert.deepEqual(f.diagnostics[0], {
      beforePidValid: true, afterPidValid: true, pidChanged: !reuse,
      beforeInstanceValid: true, afterInstanceValid: true, instanceChanged: true,
      endpointMatches: true, healthResponded: true, healthOk: true,
      healthServiceMatches: true, healthInstanceMatches: true,
      previousProcess: reuse ? "alive" : "exited", currentProcess: "alive",
    });
  }
});

test("replacement still rejects unchanged, mismatched, missing and unhealthy instances without exposing identities", async () => {
  for (const reuse of [false, true]) {
    for (const [mutate, code] of [
      [(f) => { f.after.instanceId = f.before.instanceId; }, "INSTANCE_UNCHANGED"],
      [(f) => { f.before.instanceId = " "; }, "INSTANCE_INVALID"],
      [(f) => { delete f.after.instanceId; }, "INSTANCE_INVALID"],
      [(f) => { f.health.instanceId = "private-instance-canary"; }, "HEALTH_IDENTITY_MISMATCH"],
      [(f) => { f.health.ok = false; }, "UNHEALTHY"],
      [(f) => { f.health.service = "private-service-canary"; }, "WRONG_SERVICE"],
      [(f) => { f.health = null; }, "UNHEALTHY"],
      [(f) => { f.responseOk = false; }, "HEALTH_RESPONSE_FAILED"],
      [(f) => { f.after.url = "https://private-endpoint-canary"; }, "ENDPOINT_MISMATCH"],
      [(f) => { f.livePids.delete(f.after.pid); }, "NEW_PROCESS_NOT_ALIVE"],
    ]) {
      const f = replacementFixture();
      if (reuse) f.reusePid();
      mutate(f);
      await assert.rejects(f.verify(), (error) => {
        assert.equal(error.message, "BACKEND_REPLACEMENT_" + code);
        assert.equal(error.actual, false);
        assert.equal(error.expected, true);
        assert.doesNotMatch(JSON.stringify(error), /private-|retired-instance|current-instance/);
        return true;
      });
      assert.equal(f.diagnostics.length, 1);
      assert.doesNotMatch(JSON.stringify(f.diagnostics), /private-|retired-instance|current-instance/);
      if (code === "ENDPOINT_MISMATCH") assert.equal(f.fetches, 0);
    }
  }
  const f = replacementFixture();
  f.livePids.add(f.before.pid);
  await assert.rejects(f.verify(), /BACKEND_REPLACEMENT_OLD_PROCESS_ALIVE/);
});

test("invalid PIDs never reach a process probe", async () => {
  for (const key of ["before", "after"]) {
    for (const value of [undefined, null, 0, -1, 1.5, "104", Number.MAX_SAFE_INTEGER + 1]) {
      const f = replacementFixture();
      f[key].pid = value;
      await assert.rejects(f.verify(), /BACKEND_REPLACEMENT_PID_INVALID/);
      assert.equal(f.probedPids.includes(value), false);
      assert.equal(f.diagnostics[0][key + "PidValid"], false);
    }
  }
});

test("missing replacement records fail with the fixed validation error", async () => {
  for (const key of ["before", "after"]) {
    for (const value of [undefined, null]) {
      const f = replacementFixture();
      f[key] = value;
      await assert.rejects(f.verify(), /BACKEND_REPLACEMENT_PID_INVALID/);
      assert.equal(f.diagnostics.length, 1);
      assert.equal(f.diagnostics[0].pidChanged, "unknown");
      assert.equal(f.diagnostics[0].instanceChanged, "unknown");
    }
  }
});

test("unavailable observations remain unknown and diagnostics precede record, fetch and JSON errors", async () => {
  for (const field of ["recordError", "fetchError", "jsonError"]) {
    const f = replacementFixture(), original = new Error("private-path-and-token-canary");
    f[field] = original;
    await assert.rejects(f.verify(), (error) => error === original);
    const d = f.diagnostics[0];
    assert.equal(f.diagnostics.length, 1);
    assert.equal(d.healthOk, "unknown");
    assert.equal(d.healthInstanceMatches, "unknown");
    assert.equal(d.healthResponded, field === "jsonError" ? true : "unknown");
    if (field === "recordError") {
      assert.equal(d.afterPidValid, "unknown");
      assert.equal(d.pidChanged, "unknown");
      assert.equal(d.previousProcess, "unknown");
      assert.equal(d.currentProcess, "unknown");
      assert.deepEqual(f.probedPids, []);
    }
    assert.doesNotMatch(JSON.stringify(d), /private-|103|104|http/);
  }
});

test("permission and unknown process errors fail closed and retain the first functional error even if export fails", async () => {
  for (const reuse of [false, true]) {
    for (const code of ["EPERM", "EACCES", "UNRECOGNIZED"]) {
      const f = replacementFixture();
      if (reuse) f.reusePid();
      const original = Object.assign(new Error("private-command-canary"), { code });
      f.probeErrors.set(f.before.pid, original);
      f.fetchError = new Error("second-private-error-canary");
      f.observerError = new Error("export-private-error-canary");
      await assert.rejects(f.verify(), (error) => error === original);
      assert.equal(f.diagnostics[0].previousProcess, code === "EPERM" ? "permission_denied" : "unknown");
      assert.doesNotMatch(JSON.stringify(f.diagnostics), /private-|UNRECOGNIZED|EACCES|EPERM/);
    }
  }
  const f = replacementFixture();
  f.observerError = new Error("unavailable diagnostics");
  assert.equal(await f.verify(), f.after);
  const observation = { currentProcess: "alive", previousProcess: "unknown", endpointMatches: true, healthResponded: true };
  assert.throws(() => assertBackendReplacement(f.before, f.after, f.health, observation), /OLD_PROCESS_UNKNOWN/);
});

test("replacement diagnostic projection excludes raw identities, credentials, paths and arbitrary enum strings", () => {
  const canary = "private-diagnostic-canary";
  const projected = projectBackendReplacementDiagnostic({ beforePidValid: true, pidChanged: false,
    pid: 917341, instanceId: canary, token: canary, url: "https://" + canary,
    path: "/private/" + canary, error: new Error(canary), commandLine: canary,
    currentProcess: canary, previousProcess: "permission_denied", healthOk: canary });
  assert.equal(projected.beforePidValid, true);
  assert.equal(projected.pidChanged, false);
  assert.equal(projected.currentProcess, "unknown");
  assert.equal(projected.previousProcess, "permission_denied");
  assert.equal(projected.healthOk, "unknown");
  assert.doesNotMatch(JSON.stringify(projected), /private-|917341|https|commandLine|instanceId|token/);
});

function trackingFixture(source, cursor = false) {
  const extract = (start, end) => {
    const begin = source.indexOf(start), finish = source.indexOf(end, begin);
    assert.ok(begin >= 0 && finish > begin);
    return source.slice(begin, finish);
  };
  const f = replacementFixture();
  const context = {
    stage: "", cleanupStage: "", cleanupTrackedPidIndex: undefined,
    backendPids: new Set([101, 102, f.before.pid, f.after.pid, 105]), backendPort: 32123, port: 32123,
    report: { checks: [] }, portProbes: 0,
    pidPath: () => "synthetic-record", transitionPath: () => "synthetic-transition",
    exists: async (path) => {
      if (path === "synthetic-transition") {
        if (context.transitionError) throw context.transitionError;
        return context.transitionPresent === true;
      }
      return context.pidRecordPresent === true;
    },
    readJson: f.options.readAfter, json: f.options.readAfter,
    process: { kill(pid, signal) { assert.equal(signal, 0); f.probe(pid); } },
    alive: (pid) => { try { f.probe(pid); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; } },
    verifyBackendReplacementState: (before, options) => verifyBackendReplacementState(before, {
      ...options, probe: f.probe, fetchHealth: f.options.fetchHealth,
    }),
    evidence: { observe(key, value) { assert.equal(key, "backendReplacement"); f.diagnostics.push(value); } },
    check: (condition, message) => { if (!condition) throw new Error(message); },
    createTcpServer: () => ({ once() {}, listen(_port, _host, done) {
      context.portProbes += 1;
      if (context.portError) throw context.portError;
      done();
    }, close(done) { done(); } }),
  };
  // Execute real runner tracking and cleanup with injected process, network and state access.
  const body = cursor
    ? extract("async function replaced(", "async function savedAccountSearch(")
      + extract("async function stopped(", "async function stop(")
      + "\n({ verifyBackendReplacement: replaced, assertStopped: stopped });"
    : extract("async function verifyBackendReplacement(", "async function stopAndVerify(")
      + extract("async function assertStopped(", "async function verifyPreserved(")
      + "\n({ verifyBackendReplacement, assertStopped });";
  return Object.assign(f, runInNewContext(body, context), { context });
}

for (const script of ["codex-install-smoke.mjs", "../opencode/opencode-install-smoke.mjs",
  "../claude/claude-install-smoke.mjs", "../codebuddy-workbuddy/codebuddy-lifecycle-check.mjs",
  "../cursor/cursor-lifecycle-check.mjs"]) {
  const source = await readFile(new URL(script, import.meta.url), "utf8"), cursor = script.includes("/cursor/");
  const fixture = () => trackingFixture(source, cursor);

  test(script + ": confirmed retired PID reuse cannot fail final cleanup", async () => {
    const f = fixture();
    await f.verifyBackendReplacement(f.before, "replacement");
    assert.equal(f.context.backendPids.has(f.after.pid), true);
    assert.equal(f.context.report.backendReplacement.instanceChanged, true);
    if (script === "codex-install-smoke.mjs") assert.deepEqual(f.diagnostics, [f.context.report.backendReplacement]);
    f.livePids.clear();
    f.livePids.add(f.before.pid);
    f.probedPids.length = 0;
    await f.assertStopped();
    assert.equal(f.probedPids.includes(f.before.pid), false);
    assert.equal(f.context.portProbes, 1);
    assert.equal(f.context.backendPids.size, 0);
  });

  test(script + ": same-PID replacement keeps the current process tracked until it exits", async () => {
    const f = fixture();
    f.reusePid();
    f.context.backendPids = new Set([f.before.pid]);
    await f.verifyBackendReplacement(f.before, "replacement");
    assert.deepEqual([...f.context.backendPids], [f.after.pid]);
    await assert.rejects(f.assertStopped(), /Backend process remains|BACKEND_REMAINS/);
    assert.deepEqual([...f.context.backendPids], [f.after.pid]);
    f.livePids.clear();
    await f.assertStopped();
    assert.equal(f.context.backendPids.size, 0);
    assert.equal(f.context.portProbes, 1);
  });

  test(script + ": failed replacement verification retains every tracked PID and emits diagnostics", async () => {
    for (const [mutate, expected] of [
      [(f) => f.livePids.add(f.before.pid), /BACKEND_REPLACEMENT_OLD_PROCESS_ALIVE/],
      [(f) => f.probeErrors.set(f.before.pid, { code: "EPERM" }), { code: "EPERM" }],
      [(f) => { f.recordError = { code: "ENOENT" }; }, { code: "ENOENT" }],
      [(f) => f.livePids.delete(f.after.pid), /BACKEND_REPLACEMENT_NEW_PROCESS_NOT_ALIVE/],
      [(f) => { f.health.instanceId = "another-instance"; }, /BACKEND_REPLACEMENT_HEALTH_IDENTITY_MISMATCH/],
      [(f) => { f.reusePid(); f.after.instanceId = f.before.instanceId; }, /BACKEND_REPLACEMENT_INSTANCE_UNCHANGED/],
    ]) {
      const f = fixture(), tracked = [...f.context.backendPids];
      mutate(f);
      await assert.rejects(f.verifyBackendReplacement(f.before, "replacement"), expected);
      assert.deepEqual([...f.context.backendPids], tracked);
      assert.ok(f.context.report.backendReplacement);
    }
  });

  test(script + ": remaining process, record and port failures still fail cleanup", async () => {
    for (const [mutate, expected, portProbes] of [
      [(f) => f.livePids.add(f.after.pid), /Backend process remains|BACKEND_REMAINS/, 0],
      [(f) => { f.context.pidRecordPresent = true; }, /Backend PID record remains|PID_RECORD_REMAINS/, 0],
      [(f) => f.probeErrors.set(f.after.pid, { code: "EPERM" }), { code: "EPERM" }, 0],
      [(f) => { f.context.portError = { code: "EADDRINUSE" }; }, { code: "EADDRINUSE" }, 1],
    ]) {
      const f = fixture();
      await f.verifyBackendReplacement(f.before, "replacement");
      f.livePids.clear();
      const tracked = [...f.context.backendPids];
      mutate(f);
      await assert.rejects(f.assertStopped(), expected);
      assert.deepEqual([...f.context.backendPids], tracked);
      assert.equal(f.context.portProbes, portProbes);
    }
  });

  if (cursor) test("Cursor transition failure preserves tracking after otherwise valid replacement", async () => {
    for (const unreadable of [false, true]) {
      const f = fixture(), tracked = [...f.context.backendPids];
      if (unreadable) f.context.transitionError = { code: "EACCES" }; else f.context.transitionPresent = true;
      await assert.rejects(f.verifyBackendReplacement(f.before), unreadable ? { code: "EACCES" } : /TRANSITION_REMAINS/);
      assert.deepEqual([...f.context.backendPids], tracked);
      assert.equal(f.context.report.backendReplacement.instanceChanged, true);
    }
  });
}
