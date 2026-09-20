import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  createCodingSessionCursorStore,
} from "../../dist/coding-sessions/cursor-store.js";

const KEY = "a".repeat(64);
const OTHER_KEY = "b".repeat(64);
const MODULE = new URL("../../dist/coding-sessions/cursor-store.js", import.meta.url).href;
const execute = promisify(execFile);

test("cursor metadata survives restart with private permissions and no content copy", async (t) => {
  const { home, store, directory, path } = await fixture(t);
  assert.deepEqual(await store.list(), []);
  assert.equal(store.read(KEY), undefined);
  const original = cursor(home);
  assert.equal(await store.update(KEY, () => ({ state: original, value: "registered" })), "registered");
  assert.deepEqual(createCodingSessionCursorStore(home).read(KEY), original);
  const raw = await readFile(path, "utf8");
  assert.doesNotMatch(raw, /"(?:items|text|content|apiKey|authorization)"/i);
  if (process.platform !== "win32") {
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
  }
  await writeFile(join(directory, "ignored.json"), "{}");
  await writeFile(join(directory, `${OTHER_KEY}.json.tmp`), "{}");
  await mkdir(join(directory, `${OTHER_KEY}.json`));
  assert.deepEqual(await store.list(), [KEY]);
  await store.update(KEY, () => ({ value: undefined }));
  assert.equal(await readFile(path, "utf8"), raw);
});

test("cursor updates serialize across processes and duplicate registration preserves one Turn", async (t) => {
  const { home, store } = await fixture(t);
  await store.update(KEY, () => ({ state: cursor(home), value: undefined }));
  const child = `
    const { createCodingSessionCursorStore } = await import(process.argv[1]);
    const store = createCodingSessionCursorStore(process.argv[2]);
    for (let index = 0; index < 4; index += 1) {
      await store.update(process.argv[3], current => ({
        state: { ...current, lastInteractionAt: current.lastInteractionAt + 1 },
        value: undefined,
      }));
    }
  `;
  await Promise.all([0, 1].map(() => execute(process.execPath,
    ["--input-type=module", "-e", child, MODULE, home, KEY])));
  assert.equal(store.read(KEY).lastInteractionAt, 1_000 + 8);
  const next = nativeTurn(home, 2);
  const register = (current) => current.turns.some((turn) => turn.turnId === next.turnId)
    ? { value: false }
    : { state: { ...current, turns: [...current.turns, next] }, value: true };
  assert.deepEqual((await Promise.all([
    store.update(KEY, register),
    createCodingSessionCursorStore(home).update(KEY, register),
  ])).sort(), [false, true]);
  assert.equal(store.read(KEY).turns.length, 2);
});

test("cursor corruption and unsupported authority fail closed without replacing state", async (t) => {
  const { home, store, path, directory } = await fixture(t);
  await mkdir(directory, { recursive: true });
  const valid = cursor(home);
  const invalid = [
    { ...valid, version: 2 },
    { ...valid, key: OTHER_KEY },
    { ...valid, items: [] },
    { ...valid, connection: "credential-is-not-a-fingerprint" },
    { ...valid, uploadedThrough: 1 },
    { ...valid, turns: [valid.turns[0], valid.turns[0]] },
    { ...valid, turns: [nativeTurn(home, 2), nativeTurn(home, 1)] },
    { ...valid, batch: { id: "batch", turnIds: ["unknown-turn"] } },
    { ...valid, turns: [nativeTurn(home, 1), nativeTurn(home, 2)],
      batch: { id: "batch", turnIds: ["turn-2"] } },
    { ...valid, turns: [{ ...valid.turns[0], source: { transcriptPath: "relative", endBytes: 10 } }] },
    { ...valid, turns: [{ ...valid.turns[0], projectionVersion: 3 }] },
    { ...valid, turns: [{ ...valid.turns[0], projectionVersion: "2" }] },
    { ...valid, repositoryScope: { ...valid.repositoryScope, effectiveUserId: "another-user" } },
    { ...valid, repositoryScope: { ...valid.repositoryScope, raw: "not metadata" } },
    { ...valid, repositoryScope: { ...valid.repositoryScope, scopeKind: "general" } },
  ];
  for (const state of invalid) {
    const raw = JSON.stringify(state);
    await writeFile(path, raw);
    assert.throws(() => store.read(KEY), { code: "coding_session_cursor_invalid" });
    let called = false;
    await assert.rejects(store.update(KEY, () => {
      called = true;
      return { state: valid, value: undefined };
    }), { code: "coding_session_cursor_invalid" });
    assert.equal(called, false);
    assert.equal(await readFile(path, "utf8"), raw);
  }
  await writeFile(path, "{");
  assert.throws(() => store.read(KEY), { code: "coding_session_cursor_unreadable" });
  assert.throws(() => store.read("../escape"), { code: "coding_session_cursor_invalid" });
});

test("cursor metadata size is bounded before reading and before atomic publication", async (t) => {
  const { home, store, path, directory } = await fixture(t);
  const original = cursor(home);
  await store.update(KEY, () => ({ state: original, value: undefined }));
  const oversized = { ...original, turns: Array.from({ length: 8_000 }, (_, index) => nativeTurn(home, index + 1)) };
  await assert.rejects(store.update(KEY, () => ({ state: oversized, value: undefined })),
    { code: "coding_session_cursor_too_large" });
  assert.deepEqual(store.read(KEY), original);
  await writeFile(path, " ".repeat(2 * 1024 * 1024 + 1));
  assert.throws(() => store.read(KEY), { code: "coding_session_cursor_too_large" });
  assert.deepEqual(await store.list(), [KEY]);
  assert.equal((await stat(directory)).isDirectory(), true);
});

test("cursor keeps only a bounded proven acknowledgement ending at its checkpoint", async (t) => {
  const { home, store } = await fixture(t);
  const confirmed = (index) => ({ turnId: `turn-${index}`, turnIndex: index, digest: "d".repeat(64) });
  const { batch: _batch, ...initial } = cursor(home);
  const state = { ...initial, uploadedThrough: 4, turns: [nativeTurn(home, 5)],
    confirmedTurns: [confirmed(2), confirmed(4)] };
  await store.update(KEY, () => ({ state, value: undefined }));
  assert.deepEqual(createCodingSessionCursorStore(home).read(KEY).confirmedTurns, state.confirmedTurns);
  for (const confirmedTurns of [
    [], [confirmed(2)], [confirmed(5)], [confirmed(4), confirmed(2)],
    [confirmed(4), confirmed(4)], [{ ...confirmed(4), digest: "invalid" }],
    [{ ...confirmed(4), text: "not metadata" }],
    [{ ...confirmed(4), projectionVersion: 3 }],
    Array.from({ length: 51 }, (_, index) => confirmed(index + 1)),
  ]) {
    await assert.rejects(store.update(KEY, () => ({ state: { ...state, confirmedTurns }, value: undefined })),
      { code: "coding_session_cursor_invalid" });
    assert.deepEqual(store.read(KEY), state);
  }
});

test("upload lock excludes another sender without blocking cursor registration or other sessions", async (t) => {
  const { home, store } = await fixture(t);
  let release;
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const held = store.withUploadLock(KEY, async () => {
    entered();
    await new Promise((resolve) => { release = resolve; });
  });
  await started;
  try {
    await store.update(KEY, () => ({ state: cursor(home), value: undefined }));
    assert.equal(store.read(KEY).sessionId, "session-1");
    assert.equal(await store.withUploadLock(OTHER_KEY, async () => "other-session"), "other-session");
    await assert.rejects(createCodingSessionCursorStore(home).withUploadLock(KEY, async () => {
      assert.fail("second sender must not enter a live upload lock");
    }), { code: "JSON_FILE_LOCK_TIMEOUT" });
  } finally {
    release();
    await held;
  }
  assert.equal(await store.withUploadLock(KEY, async () => "released"), "released");
});

test("directory sync uncertainty reports publication accurately and leaves a recoverable cursor", async (t) => {
  const { home, store } = await fixture(t);
  await store.update(KEY, () => ({ state: cursor(home), value: undefined }));
  const child = `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    const originalRename = fs.renameSync;
    const originalSync = fs.fsyncSync;
    let published = false;
    fs.renameSync = (...args) => { originalRename(...args); published = true; };
    fs.fsyncSync = (...args) => {
      if (published) throw Object.assign(new Error("injected"), { code: "EIO" });
      return originalSync(...args);
    };
    syncBuiltinESMExports();
    const { createCodingSessionCursorStore } = await import(process.argv[1]);
    const store = createCodingSessionCursorStore(process.argv[2]);
    try {
      await store.update(process.argv[3], current => ({
        state: { ...current, retryAt: 42 }, value: undefined,
      }));
      process.exitCode = 1;
    } catch (error) {
      if (error.code !== "coding_session_cursor_durability_uncertain"
        || !error.message.includes("was published")) throw error;
    }
  `;
  await execute(process.execPath, ["--input-type=module", "-e", child, MODULE, home, KEY]);
  assert.equal(store.read(KEY).retryAt, 42);
});

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-archive-cursor-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const directory = join(home, "runtime", "coding-sessions");
  return { home, directory, path: join(directory, `${KEY}.json`), store: createCodingSessionCursorStore(home) };
}

function nativeTurn(home, index) {
  return {
    turnId: `turn-${index}`, turnIndex: index, closedAt: "2026-09-20T00:00:00.000Z",
    source: { transcriptPath: join(home, "native.jsonl"), endBytes: index * 200 },
    bytes: 100, digest: "d".repeat(64),
  };
}

function cursor(home) {
  return {
    version: 1, key: KEY, connection: "c".repeat(64), client: "codex", sessionId: "session-1",
    repositoryScope: {
      schemaVersion: "workspace-memory-scope.v1", baseUserId: "test-user", effectiveUserId: "test-user@workspace",
      repositoryKey: "e".repeat(64), repositorySlug: "workspace", repositoryName: "workspace",
      identitySource: "workspace-directory", scopeKind: "local-directory", boundWorkspaceRoot: home,
    },
    lastInteractionAt: 1_000, uploadedThrough: 0, turns: [nativeTurn(home, 1)],
    batch: { id: "batch-1", turnIds: ["turn-1"] },
  };
}
