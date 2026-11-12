import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { join, resolve } from "node:path";
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
  assert.equal(context.timers.pending[0].delay, RETRY_INTERVAL_MS);
  context.scheduler.close();
});

test("pending transitions bypass the registry deadline but retain failure backoff", () => {
  const context = fixture({
    pending: true,
    state: updateState("0.1.9", STARTED_AT + 8 * 60 * 60 * 1_000),
  });
  assert.equal(context.spawns.length, 1);
  context.children[0].emit("close", 1, null);
  assert.equal(context.spawns.length, 1);
  assert.equal(context.timers.pending[0].delay, RETRY_INTERVAL_MS);

  context.controls.now += RETRY_INTERVAL_MS;
  context.timers.runNext();
  assert.equal(context.spawns.length, 2);
  context.scheduler.close();
});

test("local scheduling checks notice a transition created during the registry throttle", () => {
  const context = fixture({
    state: updateState("0.1.9", STARTED_AT + 8 * 60 * 60 * 1_000),
  });
  assert.equal(context.spawns.length, 0);
  assert.equal(context.timers.pending[0].delay, RETRY_INTERVAL_MS);

  context.controls.pending = true;
  context.controls.now += RETRY_INTERVAL_MS;
  context.timers.runNext();
  assert.equal(context.spawns.length, 1);

  context.controls.pending = false;
  context.children[0].emit("close", 0, null);
  assert.equal(context.timers.pending[0].delay, RETRY_INTERVAL_MS);
  assert.equal(context.spawns.length, 1);
  context.scheduler.close();
});

test("local wakes start the updater for client discovery inside the registry window", () => {
  const context = fixture({
    state: updateState("0.1.9", STARTED_AT + 8 * 60 * 60 * 1_000),
  });
  assert.equal(context.spawns.length, 0);

  for (const expectedSpawns of [1, 2]) {
    assert.equal(context.timers.pending[0].delay, RETRY_INTERVAL_MS);
    context.controls.now += RETRY_INTERVAL_MS;
    context.timers.runNext();
    assert.equal(context.spawns.length, expectedSpawns);
    assert.equal(context.timers.pending.length, 0, "only one updater may run at a time");
    context.children[expectedSpawns - 1].emit("close", 0, null);
  }
  context.scheduler.close();
});

test("a Backend restarted by an activation run waits a full interval before discovery", () => {
  const context = fixture({
    env: { MEMORAX_CODE_AUTOMATIC_UPDATE_PROCESS: "1" },
    state: updateState("0.1.9", STARTED_AT + 8 * 60 * 60 * 1_000),
  });
  assert.equal(context.spawns.length, 0);
  assert.equal(context.timers.pending[0].delay, RETRY_INTERVAL_MS);

  context.controls.now += RETRY_INTERVAL_MS;
  context.timers.runNext();
  assert.equal(context.spawns.length, 1);
  context.scheduler.close();
});

test("the registry deadline still wakes the updater before the next discovery interval", () => {
  const context = fixture({ state: updateState("0.1.9", STARTED_AT + 5 * 60 * 1_000) });
  assert.equal(context.timers.pending[0].delay, 5 * 60 * 1_000);
  context.scheduler.close();
});

test("the first wake after setup completes starts client discovery", () => {
  for (const incompleteWakes of [0, 2]) {
    const context = fixture({
      setup: { status: "absent" },
      state: updateState("0.1.9", STARTED_AT + 8 * 60 * 60 * 1_000),
    });
    for (let wake = 0; wake < incompleteWakes; wake += 1) {
      context.controls.now += RETRY_INTERVAL_MS;
      context.timers.runNext();
    }
    assert.equal(context.spawns.length, 0);
    assert.equal(context.timers.pending[0].delay, RETRY_INTERVAL_MS);

    context.controls.setup = setupCompletion();
    context.controls.now += RETRY_INTERVAL_MS;
    context.timers.runNext();
    assert.equal(context.spawns.length, 1);

    context.children[0].emit("close", 0, null);
    assert.equal(context.spawns.length, 1, "discovery returns to its own interval");
    assert.equal(context.timers.pending[0].delay, RETRY_INTERVAL_MS);
    context.scheduler.close();
  }
});

test("discovery after setup completes leaves the registry deadline in charge", () => {
  const context = fixture({
    setup: { status: "absent" },
    state: updateState("0.1.9", STARTED_AT + RETRY_INTERVAL_MS + 5 * 60 * 1_000),
  });
  context.controls.setup = setupCompletion();
  context.controls.now += RETRY_INTERVAL_MS;
  context.timers.runNext();
  assert.equal(context.spawns.length, 1);

  context.children[0].emit("close", 0, null);
  assert.equal(context.timers.pending[0].delay, 5 * 60 * 1_000);
  context.scheduler.close();
});

test("setup that is not complete never starts the updater", () => {
  for (const setup of [
    { status: "absent" },
    { status: "invalid", reason: "malformed_json" },
    { status: "unsupported", version: 2 },
  ]) {
    for (const nextCheckAtMs of [STARTED_AT - 60_000, STARTED_AT + 8 * 60 * 60 * 1_000]) {
      const context = fixture({ setup, state: updateState("0.1.9", nextCheckAtMs) });
      for (let wake = 0; wake < 3; wake += 1) {
        assert.equal(context.timers.pending[0].delay, RETRY_INTERVAL_MS);
        context.controls.now += RETRY_INTERVAL_MS;
        context.timers.runNext();
      }
      assert.equal(context.spawns.length, 0);
      context.scheduler.close();
    }
  }
});

test("manual and automatic restoration can consume their transition before diagnostic checks", () => {
  for (const env of [
    { MEMORAX_CODE_PACKAGE_REPLACEMENT: "1" },
    { MEMORAX_CODE_AUTOMATIC_UPDATE_PROCESS: "1" },
  ]) {
    const context = fixture({
      env, pending: true,
      state: updateState("0.1.9", STARTED_AT + 8 * 60 * 60 * 1_000),
    });
    assert.equal(context.spawns.length, 0);
    assert.equal(context.timers.pending[0].delay, RETRY_INTERVAL_MS);

    context.controls.pending = false;
    context.controls.now += RETRY_INTERVAL_MS;
    context.timers.runNext();
    assert.equal(context.spawns.length, 0);
    context.scheduler.close();
  }
});

test("explicit automatic-update opt-out prevents the Backend scheduler", () => {
  const context = fixture({ env: { MEMORAX_CODE_AUTO_UPDATE: "false" } });
  assert.equal(context.scheduler, undefined);
  assert.equal(context.timers.pending.length, 0);
});

function fixture({ env = {}, packageVersion = "0.1.9", setup = setupCompletion(), state = updateState(), pending = false } = {}) {
  const packageRoot = resolve("/installed/memorax-code");
  const memoraxCodeHome = resolve("/state/memorax-code");
  const timers = fakeTimers();
  const controls = { now: STARTED_AT, setup, state, pending };
  const children = [];
  const spawns = [];
  const scheduler = startBackendAutomaticUpdateScheduler({
    env,
    memoraxCodeHome,
    packageRoot,
    packageVersion,
  }, {
    existsSync: (path) => path === join(packageRoot, "bin", "memorax-code.mjs")
      || (path === join(memoraxCodeHome, "runtime", "install", "package-transition.json") && controls.pending),
    now: () => controls.now,
    readAutomaticUpdateState: () => controls.state,
    readSetupCompletionRecord: () => controls.setup,
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
