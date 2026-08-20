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

  assert.deepEqual(result, { status: "not-verified", reason: "status-failed", code: 9 });
  assert.deepEqual(calls, ["start", "status"]);
});

test("reconcile reports unavailable when status is successful but not ready", async () => {
  const result = await reconcileSetup({
    start: async () => succeeded,
    stop: async () => succeeded,
    status: async () => succeeded,
    isReady: async () => false,
  });

  assert.deepEqual(result, { status: "unavailable", reason: "not-ready", recovered: false });
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
  });
  assert.equal(stopCalls, 0);
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
