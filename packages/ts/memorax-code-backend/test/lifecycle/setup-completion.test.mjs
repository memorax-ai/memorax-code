import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  clearSetupCompletionRecord,
  readSetupCompletionRecord,
  SETUP_COMPLETION_RECORD_VERSION,
  SetupCompletionRecordError,
  setupCompletionPath,
  withSetupCompletionLock,
  writeSetupCompletionRecord,
} from "../../../memorax-code-adapter-common/src/setup-completion.mjs";

const COMPLETED_AT = "2026-08-15T08:00:00.000Z";
const COMPLETED_BY_VERSION = "0.1.2";

test("setup completion record distinguishes absent invalid unsupported and valid states", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-setup-completion-state-"));
  const path = setupCompletionPath(home);
  try {
    assert.deepEqual(readSetupCompletionRecord(home), { status: "absent" });

    await mkdir(join(home, "runtime", "setup"), { recursive: true });
    await writeFile(path, "{not-json\n");
    assert.deepEqual(readSetupCompletionRecord(home), {
      status: "invalid",
      reason: "malformed_json",
    });

    await writeRecord(path, {
      version: SETUP_COMPLETION_RECORD_VERSION,
      state: "pending",
      completedAt: COMPLETED_AT,
      completedByVersion: COMPLETED_BY_VERSION,
    });
    assert.deepEqual(readSetupCompletionRecord(home), {
      status: "invalid",
      reason: "invalid_state",
    });

    await writeRecord(path, {
      version: SETUP_COMPLETION_RECORD_VERSION,
      state: "complete",
      completedAt: "2026-08-15",
      completedByVersion: COMPLETED_BY_VERSION,
    });
    assert.deepEqual(readSetupCompletionRecord(home), {
      status: "invalid",
      reason: "invalid_completed_at",
    });

    await writeRecord(path, {
      version: 2,
      state: "complete",
      completedAt: COMPLETED_AT,
      completedByVersion: COMPLETED_BY_VERSION,
    });
    assert.deepEqual(readSetupCompletionRecord(home), {
      status: "unsupported",
      version: 2,
    });

    await writeRecord(path, {
      version: SETUP_COMPLETION_RECORD_VERSION,
      state: "complete",
      completedAt: COMPLETED_AT,
      completedByVersion: COMPLETED_BY_VERSION,
      unexpected: true,
    });
    assert.deepEqual(readSetupCompletionRecord(home), {
      status: "invalid",
      reason: "unknown_fields",
    });

    await writeRecord(path, {
      version: SETUP_COMPLETION_RECORD_VERSION,
      state: "complete",
      completedAt: COMPLETED_AT,
      completedByVersion: COMPLETED_BY_VERSION,
    });
    assert.deepEqual(readSetupCompletionRecord(home), {
      status: "valid",
      record: {
        version: SETUP_COMPLETION_RECORD_VERSION,
        state: "complete",
        completedAt: COMPLETED_AT,
        completedByVersion: COMPLETED_BY_VERSION,
      },
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("setup completion write is private atomic and durability-aware", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-setup-completion-write-"));
  const setupDirectory = join(home, "runtime", "setup");
  const path = setupCompletionPath(home);
  try {
    await mkdir(setupDirectory, { recursive: true });
    if (process.platform !== "win32") await chmod(setupDirectory, 0o777);
    const written = writeSetupCompletionRecord({
      memoraxCodeHome: home,
      completedAt: COMPLETED_AT,
      completedByVersion: COMPLETED_BY_VERSION,
    });

    assert.equal(written.durability, "confirmed");
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), written.record);
    assert.deepEqual(await readdir(setupDirectory), ["setup-completion.json"]);
    if (process.platform !== "win32") {
      assert.equal((await stat(setupDirectory)).mode & 0o777, 0o700);
      assert.equal((await stat(path)).mode & 0o777, 0o600);
    }

    const uncertain = writeSetupCompletionRecord({
      memoraxCodeHome: home,
      completedAt: "2026-08-15T09:00:00.000Z",
      completedByVersion: "0.1.3",
    }, {
      syncDirectory() {
        const error = new Error("directory sync unavailable");
        error.code = "EINVAL";
        throw error;
      },
    });
    assert.equal(uncertain.durability, "uncertain");
    assert.equal(uncertain.durabilityErrorCode, "EINVAL");
    assert.deepEqual(readSetupCompletionRecord(home), {
      status: "valid",
      record: uncertain.record,
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("setup completion mutation fails closed for invalid and unsupported records", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-setup-completion-closed-"));
  const path = setupCompletionPath(home);
  try {
    await mkdir(join(home, "runtime", "setup"), { recursive: true });
    for (const value of [
      { version: 1, state: "pending", completedAt: COMPLETED_AT, completedByVersion: "0.1.2" },
      { version: 2, state: "complete", completedAt: COMPLETED_AT, completedByVersion: "0.2.0" },
    ]) {
      await writeRecord(path, value);
      const before = await readFile(path, "utf8");
      assert.throws(
        () => writeSetupCompletionRecord({
          memoraxCodeHome: home,
          completedAt: COMPLETED_AT,
          completedByVersion: COMPLETED_BY_VERSION,
        }),
        (error) => error instanceof SetupCompletionRecordError,
      );
      let entered = false;
      await assert.rejects(
        withSetupCompletionLock(home, () => {
          entered = true;
        }),
        (error) => error instanceof SetupCompletionRecordError,
      );
      await assert.rejects(
        clearSetupCompletionRecord(home),
        (error) => error instanceof SetupCompletionRecordError,
      );
      assert.equal(entered, false);
      assert.equal(await readFile(path, "utf8"), before);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("setup completion clear is locked and idempotent", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-setup-completion-clear-"));
  const path = setupCompletionPath(home);
  let releaseLock;
  let markLockEntered;
  const lockEntered = new Promise((resolve) => {
    markLockEntered = resolve;
  });
  const holdLock = new Promise((resolve) => {
    releaseLock = resolve;
  });
  try {
    writeSetupCompletionRecord({
      memoraxCodeHome: home,
      completedAt: COMPLETED_AT,
      completedByVersion: COMPLETED_BY_VERSION,
    });
    const holder = withSetupCompletionLock(home, async (state) => {
      assert.equal(state.status, "valid");
      markLockEntered();
      await holdLock;
    }, { timeoutMs: 500, retryMs: 5 });
    await lockEntered;

    const clearing = clearSetupCompletionRecord(home, { timeoutMs: 500, retryMs: 5 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(readSetupCompletionRecord(home).status, "valid");

    releaseLock();
    await holder;
    assert.deepEqual(await clearing, { path, removed: true });
    assert.deepEqual(readSetupCompletionRecord(home), { status: "absent" });
    assert.deepEqual(await clearSetupCompletionRecord(home), { path, removed: false });
    await assert.rejects(access(`${path}.lock`), /ENOENT/);
  } finally {
    releaseLock?.();
    await rm(home, { recursive: true, force: true });
  }
});

test("setup completion lock serializes the full awaited operation", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-setup-completion-lock-"));
  const path = setupCompletionPath(home);
  const order = [];
  let releaseFirst;
  let markFirstEntered;
  const firstEntered = new Promise((resolve) => {
    markFirstEntered = resolve;
  });
  const holdFirst = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  try {
    const first = withSetupCompletionLock(home, async (state) => {
      assert.equal(state.status, "absent");
      order.push("first:start");
      markFirstEntered();
      await holdFirst;
      order.push("first:end");
    }, { timeoutMs: 500, retryMs: 5 });
    await firstEntered;

    const second = withSetupCompletionLock(home, async (state) => {
      assert.equal(state.status, "absent");
      order.push("second");
    }, { timeoutMs: 500, retryMs: 5 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(order, ["first:start"]);

    releaseFirst();
    await Promise.all([first, second]);
    assert.deepEqual(order, ["first:start", "first:end", "second"]);
    await assert.rejects(access(`${path}.lock`), /ENOENT/);
  } finally {
    releaseFirst?.();
    await rm(home, { recursive: true, force: true });
  }
});

async function writeRecord(path, value) {
  await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}
