import assert from "node:assert/strict";
import test from "node:test";
import {
  clientHookRuntimeActivationFailed,
  lifecycleLockFailureCode,
  reconcileSetup,
  runtimeAuthorityFailureCode,
} from "../lib/setup-reconcile.mjs";

const succeeded = { status: 0, stdout: "", stderr: "" };

test("reconcile enables a ready setup", async () => {
  const calls = [];
  const events = [];
  const statusResult = { ...succeeded, stdout: "ready" };

  const result = await reconcileSetup({
    start: async () => {
      calls.push("start");
      return succeeded;
    },
    stop: async () => {
      calls.push("stop");
      return succeeded;
    },
    status: async () => {
      calls.push("status");
      return statusResult;
    },
    isReady: async (checked) => {
      calls.push("isReady");
      assert.equal(checked, statusResult);
      return true;
    },
    onEvent: async (event) => events.push(event),
  });

  assert.deepEqual(result, { status: "enabled", reason: "ready", recovered: false });
  assert.deepEqual(calls, ["start", "status", "isReady"]);
  assert.deepEqual(events, [
    { type: "start", attempt: 1 },
    { type: "start-succeeded", recovered: false },
    { type: "status", recovered: false },
    { type: "status-succeeded" },
    { type: "complete", status: "enabled", reason: "ready", recovered: false },
  ]);
});

test("reconcile performs one stop-start recovery for an ordinary start failure", async () => {
  const calls = [];
  const starts = [{ status: 1 }, succeeded];

  const result = await reconcileSetup({
    start: async () => {
      calls.push("start");
      return starts.shift();
    },
    stop: async () => {
      calls.push("stop");
      return succeeded;
    },
    status: async () => {
      calls.push("status");
      return succeeded;
    },
    isReady: async () => {
      calls.push("isReady");
      return true;
    },
  });

  assert.deepEqual(result, { status: "enabled", reason: "ready", recovered: true });
  assert.deepEqual(calls, ["start", "stop", "start", "status", "isReady"]);
});

test("reconcile leaves recovered Backend running when client setup failed", async () => {
  const calls = [];
  const events = [];
  const result = await reconcileSetup({
    start: async () => {
      calls.push("start");
      return {
        status: 1,
        stdout: JSON.stringify({
          ok: false,
          action: "start",
          backend: { ok: true, reason: "workbuddy_adapter_enable_failed_backend_recovered" },
          workbuddyAdapter: { ok: false, action: "enable", error: "EPERM: rename" },
        }),
      };
    },
    stop: async () => { calls.push("stop"); return succeeded; },
    status: async () => { calls.push("status"); return succeeded; },
    isReady: async () => { calls.push("ready"); return true; },
    onEvent: (event) => events.push(event),
  });

  const { commandResult, ...summary } = result;
  assert.deepEqual(summary, { status: "not-verified", reason: "adapter-setup-failed" });
  assert.equal(JSON.parse(commandResult.stdout).backend.ok, true);
  assert.deepEqual(calls, ["start"]);
  assert.equal(events.find((event) => event.type === "start-failed").reason, "adapter-setup-failed");
});

test("reconcile retains recovery when a failure report cannot establish healthy Backend and client failure", async () => {
  for (const report of [
    "not JSON",
    { ok: false, action: "start", backend: { ok: false }, traeAdapter: { ok: false } },
    { ok: false, action: "start", backend: { ok: true, skipped: true }, traeAdapter: { ok: false } },
    { ok: false, action: "start", backend: { ok: true }, unknownAdapter: { ok: false } },
    { ok: false, action: "start", backend: {
      ok: false, errorCode: "BACKEND_HEALTH_NOT_READY",
      error: "BACKEND_SERVICE_STATE_INVALID; client Hook runtime activation failed: legacy text must not override the structured code",
    } },
  ]) {
    const calls = [];
    const starts = [{ status: 1, stdout: typeof report === "string" ? report : JSON.stringify(report) }, succeeded];
    const result = await reconcileSetup({
      start: async () => { calls.push("start"); return starts.shift(); },
      stop: async () => { calls.push("stop"); return succeeded; },
      status: async () => { calls.push("status"); return succeeded; },
      isReady: async () => true,
    });
    assert.deepEqual(calls, ["start", "stop", "start", "status"], JSON.stringify(report));
    assert.equal(result.recovered, true);
  }
});

test("reconcile reports a failed recovery without a second stop", async () => {
  const calls = [];

  const result = await reconcileSetup({
    start: async () => {
      calls.push("start");
      return { status: 7 };
    },
    stop: async () => {
      calls.push("stop");
      return succeeded;
    },
    status: async () => {
      calls.push("status");
      return succeeded;
    },
    isReady: async () => {
      calls.push("isReady");
      return true;
    },
  });

  assert.deepEqual(result, {
    status: "not-verified",
    reason: "start-failed-after-recovery",
    code: 7,
    commandResult: { status: 7 },
  });
  assert.deepEqual(calls, ["start", "stop", "start", "status"]);
});

test("reconcile reports a failed status without running readiness", async () => {
  const calls = [];

  const result = await reconcileSetup({
    start: async () => {
      calls.push("start");
      return succeeded;
    },
    stop: async () => {
      calls.push("stop");
      return succeeded;
    },
    status: async () => {
      calls.push("status");
      return { status: 9 };
    },
    isReady: async () => {
      calls.push("isReady");
      return true;
    },
  });

  assert.deepEqual(result, { status: "not-verified", reason: "status-failed", code: 9, commandResult: { status: 9 } });
  assert.deepEqual(calls, ["start", "status"]);
});

test("reconcile reports unavailable when status is successful but not ready", async () => {
  const result = await reconcileSetup({
    start: async () => succeeded,
    stop: async () => succeeded,
    status: async () => succeeded,
    isReady: async () => false,
  });

  assert.deepEqual(result, { status: "unavailable", reason: "not-ready", recovered: false, commandResult: succeeded });
});

test("reconcile does not recover a Hook runtime activation failure", async () => {
  let stopCalls = 0;
  const failed = {
    status: 1,
    stderr: "client Hook runtime activation failed: generation was not accepted",
  };

  const result = await reconcileSetup({
    start: async () => failed,
    stop: async () => {
      stopCalls += 1;
      return succeeded;
    },
    status: async () => succeeded,
    isReady: async () => true,
  });

  assert.equal(clientHookRuntimeActivationFailed(failed), true);
  assert.deepEqual(result, {
    status: "not-verified",
    reason: "hook-runtime-activation-failed",
    commandResult: failed,
  });
  assert.equal(stopCalls, 0);
});

test("reconcile does not recover a runtime authority failure", async () => {
  let stopCalls = 0;
  const failed = {
    status: 1,
    stdout: "BACKEND_TOKEN_RECORD_INVALID",
  };

  const result = await reconcileSetup({
    start: async () => failed,
    stop: async () => {
      stopCalls += 1;
      return succeeded;
    },
    status: async () => succeeded,
    isReady: async () => true,
  });

  assert.equal(runtimeAuthorityFailureCode(failed), "BACKEND_TOKEN_RECORD_INVALID");
  assert.deepEqual(result, {
    status: "not-verified",
    reason: "runtime-authority-failed",
    code: "BACKEND_TOKEN_RECORD_INVALID",
    commandResult: failed,
  });
  assert.equal(stopCalls, 0);
});

test("reconcile does not recover lifecycle lock contention", async () => {
  let stopCalls = 0;
  const failed = {
    status: 1,
    stderr: "BACKEND_LIFECYCLE_LOCK_TIMEOUT",
  };

  const result = await reconcileSetup({
    start: async () => failed,
    stop: async () => {
      stopCalls += 1;
      return succeeded;
    },
    status: async () => succeeded,
    isReady: async () => true,
  });

  assert.equal(lifecycleLockFailureCode(failed), "BACKEND_LIFECYCLE_LOCK_TIMEOUT");
  assert.deepEqual(result, {
    status: "not-verified",
    reason: "lifecycle-lock-timeout",
    code: "BACKEND_LIFECYCLE_LOCK_TIMEOUT",
    commandResult: failed,
  });
  assert.equal(stopCalls, 0);
});

test("reconcile preserves deterministic Backend diagnostics without stop-start recovery", async () => {
  for (const code of [
    "BACKEND_LIFECYCLE_LOCK_FAILED", "BACKEND_SERVICE_PREPARE_FAILED", "BACKEND_SPAWN_FAILED",
    "BACKEND_TOKEN_CONFIG_FAILED", "BACKEND_SERVICE_STATE_WRITE_FAILED",
  ]) {
    const calls = [];
    const failed = { status: 1, stdout: JSON.stringify({
      ok: false, action: "start", backend: { ok: false, errorCode: code },
      diagnostic: { id: "existing-backend-diagnostic", recorded: true },
    }) };
    const result = await reconcileSetup({
      start: async () => { calls.push("start"); return failed; },
      stop: async () => { calls.push("stop"); return succeeded; },
      status: async () => { calls.push("status"); return succeeded; },
      isReady: async () => true,
    });
    assert.deepEqual(calls, ["start"], code);
    assert.equal(result.reason, code === "BACKEND_LIFECYCLE_LOCK_FAILED" ? "lifecycle-lock-failed" : "backend-start-failed");
    assert.equal(result.code, code);
    assert.equal(result.commandResult, failed, "The original diagnostic must remain available for setup output");
  }
});

test("reconcile stops recovery when stop fails and preserves that failure", async () => {
  const calls = [];
  const stopped = { status: 1, stdout: JSON.stringify({
    ok: false, action: "stop", backend: { ok: false, errorCode: "BACKEND_OWNERSHIP_UNVERIFIED" },
    diagnostic: { id: "stop-diagnostic", recorded: true },
  }) };
  const result = await reconcileSetup({
    start: async () => { calls.push("start"); return { status: 1 }; },
    stop: async () => { calls.push("stop"); return stopped; },
    status: async () => { calls.push("status"); return succeeded; },
    isReady: async () => { calls.push("ready"); return true; },
  });
  assert.deepEqual(calls, ["start", "stop"]);
  assert.deepEqual(result, {
    status: "not-verified", reason: "recovery-stop-failed", code: "BACKEND_OWNERSHIP_UNVERIFIED", commandResult: stopped,
  });
  assert.equal(result.commandResult, stopped);
});

test("reconcile has no retained state across consecutive calls", async () => {
  const calls = [];
  const options = {
    start: async () => {
      calls.push("start");
      return succeeded;
    },
    stop: async () => {
      calls.push("stop");
      return succeeded;
    },
    status: async () => {
      calls.push("status");
      return succeeded;
    },
    isReady: async () => {
      calls.push("isReady");
      return true;
    },
  };

  const first = await reconcileSetup(options);
  const second = await reconcileSetup(options);

  assert.deepEqual(first, second);
  assert.deepEqual(first, { status: "enabled", reason: "ready", recovered: false });
  assert.deepEqual(calls, ["start", "status", "isReady", "start", "status", "isReady"]);
});
