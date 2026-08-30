import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import test from "node:test";
import {
  startBackendAutomaticUpdateScheduler,
} from "../../dist/lifecycle/automatic-update-scheduler.js";

const STARTED_AT = Date.parse("2026-08-30T08:00:00.000Z");
const RETRY_INTERVAL_MS = 15 * 60 * 1_000;

test("managed Backend schedules the next automatic update without a client Session event", () => {
  let now = STARTED_AT;
  let updateState = automaticUpdateState({
    nextCheckAt: new Date(STARTED_AT + 60_000).toISOString(),
  });
  const timers = fakeTimers();
  const children = [];
  const spawns = [];
  const packageRoot = "/installed/memorax-code";
  const memoraxCodeHome = "/state/memorax-code";
  const scheduler = startBackendAutomaticUpdateScheduler({
    env: {},
    memoraxCodeHome,
    packageRoot,
    packageVersion: "0.1.9",
  }, {
    existsSync: () => true,
    now: () => now,
    readAutomaticUpdateState: () => updateState,
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

  assert.ok(scheduler);
  assert.equal(spawns.length, 0);
  assert.equal(timers.pending[0].delay, 60_000);

  now += 60_000;
  timers.runNext();
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].command, process.execPath);
  assert.deepEqual(spawns[0].args, [
    join(packageRoot, "bin", "memorax-code.mjs"),
    "update",
    "--automatic",
    "--home",
    memoraxCodeHome,
  ]);
  assert.equal(spawns[0].options.detached, true);
  assert.equal(spawns[0].options.env.MEMORAX_CODE_AUTOMATIC_UPDATE_PROCESS, "1");
  assert.equal(children[0].unrefCalled, true);

  updateState = automaticUpdateState({
    nextCheckAt: new Date(now + RETRY_INTERVAL_MS).toISOString(),
  });
  children[0].emit("close", 1, null);
  assert.equal(timers.pending[0].delay, RETRY_INTERVAL_MS);

  scheduler.close();
  assert.equal(timers.pending.length, 0);
});

test("Backend started by an update suppresses only its immediate recursive check", () => {
  let now = STARTED_AT;
  let updateState = { status: "absent" };
  const timers = fakeTimers();
  let spawnCount = 0;
  const scheduler = startBackendAutomaticUpdateScheduler({
    env: { MEMORAX_CODE_AUTOMATIC_UPDATE_PROCESS: "1" },
    memoraxCodeHome: "/state/memorax-code",
    packageRoot: "/installed/memorax-code",
    packageVersion: "0.1.10",
  }, {
    existsSync: () => true,
    now: () => now,
    readAutomaticUpdateState: () => updateState,
    readSetupCompletionRecord: () => setupCompletion("0.1.9"),
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    spawnProcess() {
      spawnCount += 1;
      return new FakeChild();
    },
  });

  assert.ok(scheduler);
  assert.equal(spawnCount, 0);
  assert.equal(timers.pending[0].delay, RETRY_INTERVAL_MS);

  now += RETRY_INTERVAL_MS;
  updateState = automaticUpdateState({
    installedVersion: "0.1.10",
    nextCheckAt: new Date(now + 45 * 60 * 1_000).toISOString(),
  });
  timers.runNext();

  assert.equal(spawnCount, 0);
  assert.equal(timers.pending[0].delay, 45 * 60 * 1_000);
  scheduler.close();
});

test("explicit automatic-update opt-out prevents the Backend scheduler", () => {
  const timers = fakeTimers();
  const scheduler = startBackendAutomaticUpdateScheduler({
    env: { MEMORAX_CODE_AUTO_UPDATE: "false" },
    memoraxCodeHome: "/state/memorax-code",
    packageRoot: "/installed/memorax-code",
    packageVersion: "0.1.9",
  }, {
    existsSync: () => true,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });

  assert.equal(scheduler, undefined);
  assert.equal(timers.pending.length, 0);
});

function setupCompletion(completedByVersion = "0.1.9") {
  return {
    status: "valid",
    record: {
      version: 1,
      state: "complete",
      completedAt: "2026-08-30T07:00:00.000Z",
      completedByVersion,
    },
  };
}

function automaticUpdateState({
  installedVersion = "0.1.9",
  nextCheckAt,
}) {
  return {
    status: "valid",
    record: {
      version: 1,
      checkedAt: "2026-08-30T07:00:00.000Z",
      nextCheckAt,
      installedVersion,
      targetVersion: installedVersion,
      channel: "latest",
      outcome: "up-to-date",
    },
  };
}

function fakeTimers() {
  const pending = [];
  return {
    pending,
    setTimeout(callback, delay) {
      const handle = {
        callback,
        delay,
        cleared: false,
        unref() {},
      };
      pending.push(handle);
      return handle;
    },
    clearTimeout(handle) {
      handle.cleared = true;
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
