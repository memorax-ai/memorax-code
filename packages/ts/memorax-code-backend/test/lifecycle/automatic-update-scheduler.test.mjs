import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import test from "node:test";
import { startBackendAutomaticUpdateScheduler } from "../../dist/lifecycle/automatic-update-scheduler.js";

const STARTED_AT = Date.parse("2026-08-30T08:00:00.000Z");
const RETRY_INTERVAL_MS = 15 * 60 * 1_000;

test("managed Backend schedules the next automatic update without a client Session event", () => {
  const context = fixture({
    state: updateState("0.1.9", STARTED_AT + 60_000),
  });
  assert.ok(context.scheduler);
  assert.equal(context.spawns.length, 0);
  assert.equal(context.timers.pending[0].delay, 60_000);

  context.controls.now += 60_000;
  context.timers.runNext();
  assert.equal(context.spawns.length, 1);
  assert.deepEqual(context.spawns[0].args, [
    join(context.packageRoot, "bin", "memorax-code.mjs"),
    "update",
    "--automatic",
    "--home",
    context.memoraxCodeHome,
  ]);
  assert.equal(context.spawns[0].command, process.execPath);
  assert.equal(context.spawns[0].options.detached, true);
  assert.equal(context.spawns[0].options.env.MEMORAX_CODE_AUTOMATIC_UPDATE_PROCESS, "1");
  assert.equal(context.children[0].unrefCalled, true);

  context.controls.state = updateState("0.1.9", context.controls.now + RETRY_INTERVAL_MS);
  context.children[0].emit("close", 1, null);
  assert.equal(context.timers.pending[0].delay, RETRY_INTERVAL_MS);
  context.scheduler.close();
  assert.equal(context.timers.pending.length, 0);
});

test("Backend started by an update suppresses only its immediate recursive check", () => {
  const context = fixture({
    env: { MEMORAX_CODE_AUTOMATIC_UPDATE_PROCESS: "1" },
    packageVersion: "0.1.10",
    state: { status: "absent" },
  });
  assert.ok(context.scheduler);
  assert.equal(context.spawns.length, 0);
  assert.equal(context.timers.pending[0].delay, RETRY_INTERVAL_MS);

  context.controls.now += RETRY_INTERVAL_MS;
  context.controls.state = updateState("0.1.10", context.controls.now + 45 * 60 * 1_000);
  context.timers.runNext();
  assert.equal(context.spawns.length, 0);
  assert.equal(context.timers.pending[0].delay, 45 * 60 * 1_000);
  context.scheduler.close();
});

test("explicit automatic-update opt-out prevents the Backend scheduler", () => {
  const context = fixture({ env: { MEMORAX_CODE_AUTO_UPDATE: "false" } });
  assert.equal(context.scheduler, undefined);
  assert.equal(context.timers.pending.length, 0);
});

function fixture({ env = {}, packageVersion = "0.1.9", state = updateState() } = {}) {
  const packageRoot = "/installed/memorax-code";
  const memoraxCodeHome = "/state/memorax-code";
  const timers = fakeTimers();
  const controls = { now: STARTED_AT, state };
  const children = [];
  const spawns = [];
  const scheduler = startBackendAutomaticUpdateScheduler({
    env,
    memoraxCodeHome,
    packageRoot,
    packageVersion,
  }, {
    existsSync: () => true,
    now: () => controls.now,
    readAutomaticUpdateState: () => controls.state,
    readSetupCompletionRecord: () => setupCompletion(),
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    spawnProcess(command, args, options) {
      const child = new FakeChild();
      children.push(child);
      spawns.push({ command, args, options });
      return child;
    },
  });
  return { children, controls, memoraxCodeHome, packageRoot, scheduler, spawns, timers };
}

function setupCompletion() {
  return {
    status: "valid",
    record: {
      version: 1,
      state: "complete",
      completedAt: "2026-08-30T07:00:00.000Z",
      completedByVersion: "0.1.9",
    },
  };
}

function updateState(installedVersion = "0.1.9", nextCheckAtMs = STARTED_AT + 60_000) {
  return {
    status: "valid",
    record: {
      version: 1,
      installedVersion,
      nextCheckAt: new Date(nextCheckAtMs).toISOString(),
    },
  };
}

function fakeTimers() {
  const pending = [];
  return {
    pending,
    setTimeout(callback, delay) {
      const handle = { callback, delay, unref() {} };
      pending.push(handle);
      return handle;
    },
    clearTimeout(handle) {
      const index = pending.indexOf(handle);
      if (index >= 0) pending.splice(index, 1);
    },
    runNext() {
      const handle = pending.shift();
      assert.ok(handle, "expected a pending timer");
      handle.callback();
    },
  };
}

class FakeChild extends EventEmitter {
  unrefCalled = false;

  unref() {
    this.unrefCalled = true;
  }
}
