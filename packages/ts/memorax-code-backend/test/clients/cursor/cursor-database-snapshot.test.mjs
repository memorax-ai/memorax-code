import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { test } from "node:test";
import { readCursorCompactionSnapshot, readCursorDatabaseSnapshot } from "../../../dist/clients/cursor/database-snapshot.js";
import { databaseFixture, nativeCompactionFields, nativeField, nativeMessage } from "./support/database-fixtures.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const read = (f) => readCursorDatabaseSnapshot(f);
const failure = (reason, retryable = false) => ({ ok: false, reason, retryable });

test("Cursor reads exact native user and public assistant text without Hook, tool or thinking text", async () => {
  const f = await databaseFixture();
  try {
    const requestId = randomUUID(), userMessageId = randomUUID();
    const native = f.write({ latestGenerationId: requestId, stateExtra: [nativeField(100, "Future state metadata excluded")], turns: [{
      requestId, userMessageId, prompt: "  Synthetic question\n",
      extra: [nativeField(9, "Server extension excluded"), nativeField(9, "Another extension excluded"), nativeField(10, "Opaque extension excluded")],
      user: { extra: [nativeField(21, nativeMessage(nativeField(1, "sessionStart"), nativeField(2, "Hook context excluded")))] },
      steps: [{ type: "thinkingMessage", text: "Private reasoning excluded" }, { type: "toolCall", text: "Tool output excluded" }, { type: "assistantMessage", text: "  Exact final reply\n" }],
    }] });
    const before = { hash: digest(await readFile(f.databasePath)), mtime: (await stat(f.databasePath)).mtimeMs };
    const result = await read(f);
    assert.equal(result.ok, true);
    assert.equal(result.snapshot.latestGenerationId, requestId);
    assert.equal(result.snapshot.stateHash, digest(native.state));
    const turn = result.snapshot.turns[0];
    assert.equal(turn.id, native.turnRefs[0].toString("hex"));
    assert.equal(turn.requestId, requestId);
    assert.equal(turn.userMessageId, userMessageId);
    assert.equal(turn.userMessageRef, native.userRefs[0].toString("hex"));
    assert.equal(turn.userPrompt, "  Synthetic question\n");
    assert.deepEqual(turn.steps.map(({ type, text }) => ({ type, ...(text === undefined ? {} : { text }) })), [
      { type: "thinkingMessage" }, { type: "toolCall" }, { type: "assistantMessage", text: "  Exact final reply\n" },
    ]);
    assert.ok(turn.steps.every((step) => /^[a-f0-9]{64}$/.test(step.contentHash)));
    assert.equal(JSON.stringify(result).includes("excluded"), false);
    assert.deepEqual({ hash: digest(await readFile(f.databasePath)), mtime: (await stat(f.databasePath)).mtimeMs }, before);
  } finally { await f.cleanup(); }
});

test("Cursor snapshots expose edit replacement and Continue lineage without guessing generations", async () => {
  const f = await databaseFixture();
  try {
    const oldGeneration = randomUUID(), editedGeneration = randomUUID(), resumedGeneration = randomUUID(), userMessageId = randomUUID();
    const old = f.write({ latestGenerationId: oldGeneration, turns: [{ requestId: oldGeneration, userMessageId, prompt: "Old question" }] });
    const oldResult = await read(f);
    const edited = f.write({ latestGenerationId: editedGeneration, turns: [{ requestId: editedGeneration, userMessageId, prompt: "Edited question" }] });
    const editedResult = await read(f);
    assert.equal(editedResult.snapshot.turns[0].requestId, editedGeneration);
    assert.notEqual(edited.turnRefs[0].toString("hex"), old.turnRefs[0].toString("hex"));
    assert.notEqual(editedResult.snapshot.stateHash, oldResult.snapshot.stateHash);
    const previousSteps = edited.stepRefs[0];
    f.write({ latestGenerationId: resumedGeneration, turns: [{ requestId: editedGeneration, userRef: edited.userRefs[0], stepRefs: [...previousSteps, f.step({ text: "Resumed final answer" })] }] });
    const resumed = await read(f);
    assert.equal(resumed.snapshot.latestGenerationId, resumedGeneration);
    assert.equal(resumed.snapshot.turns[0].requestId, editedGeneration);
    assert.equal(resumed.snapshot.turns[0].userMessageRef, editedResult.snapshot.turns[0].userMessageRef);
    assert.deepEqual(resumed.snapshot.turns[0].steps.slice(0, 1), editedResult.snapshot.turns[0].steps);
    // Fresh generation metadata can coexist with stale native state. The reader
    // exposes both; only runtime correlation may decide whether to accept them.
    f.write({ latestGenerationId: resumedGeneration, turns: edited.turnRefs });
    const stale = await read(f);
    assert.equal(stale.snapshot.stateHash, editedResult.snapshot.stateHash);
    assert.equal(stale.snapshot.latestGenerationId, resumedGeneration);
  } finally { await f.cleanup(); }
});

test("Cursor preserves unsupported historical turns without blessing their content or dropping trailing turns", async () => {
  const f = await databaseFixture();
  try {
    const cases = [
      [{ simulated: true }, "native_user_simulated"], [{ steer: true }, "native_user_steer"],
      [{ extra: [nativeField(18, Buffer.alloc(32, 1))] }, "native_user_external_text"],
      [{ extra: [nativeField(99, "future content")] }, "native_user_unsupported"],
    ];
    for (const [user, reason] of cases) {
      f.write({ turns: [{ requestId: randomUUID(), user }, { requestId: randomUUID(), prompt: "Ordinary later question" }] });
      const result = await read(f);
      assert.equal(result.ok, true);
      assert.equal(result.snapshot.turns[0].reason, reason);
      assert.equal(result.snapshot.turns[0].userPrompt, undefined);
      assert.equal(result.snapshot.turns[1].userPrompt, "Ordinary later question");
    }
    const shell = f.blob(nativeField(2, nativeMessage()));
    const unknown = f.blob(nativeField(12, nativeMessage()));
    f.write({ turns: [{ requestId: randomUUID() }, shell, unknown] });
    const result = await read(f);
    assert.deepEqual(result.snapshot.turns.map(({ type }) => type), ["agent", "shell", "unknown"]);
    assert.equal(result.snapshot.turns[2].reason, "native_turn_unsupported");
  } finally { await f.cleanup(); }
});

test("Cursor missing native records are retryable; malformed identities and wire data fail closed", async () => {
  const f = await databaseFixture();
  try {
    assert.deepEqual(await read(f), failure("database_session_missing", true));
    f.writeComposer({});
    assert.deepEqual(await read(f), failure("database_state_missing", true));
    const native = f.write({ turns: [{ requestId: randomUUID() }] });
    f.deleteBlob(native.stepRefs[0][0]);
    assert.deepEqual(await read(f), failure("database_blob_missing", true));
    for (const composer of [
      { conversationState: "~%%%" }, { conversationState: "xyz" },
      { conversationState: "~", latestChatGenerationUUID: "not-an-id" },
      { conversationState: "~", composerId: randomUUID() },
      { conversationState: `~${Buffer.from([0x42, 0x20, 1]).toString("base64")}` },
      { conversationState: `~${nativeField(8, false).toString("base64")}` },
    ]) {
      f.writeComposer(composer);
      assert.deepEqual(await read(f), failure("database_native_format_invalid"));
    }
    f.write({ turns: [{ requestId: "not-an-id" }, { requestId: randomUUID(), prompt: "Later eligible question" }] });
    const unsupportedIdentity = await read(f);
    assert.equal(unsupportedIdentity.snapshot.turns[0].reason, "native_turn_unsupported");
    assert.equal(unsupportedIdentity.snapshot.turns[0].requestId, undefined);
    assert.equal(unsupportedIdentity.snapshot.turns[1].userPrompt, "Later eligible question");
    f.write({ turns: [{ requestId: randomUUID(), user: { extra: [nativeField(5, 2)] } }] });
    assert.deepEqual(await read(f), failure("database_native_format_invalid"));
  } finally { await f.cleanup(); }
});

test("Cursor unknown or mixed step variants never become assistant content", async () => {
  const f = await databaseFixture();
  try {
    for (const stepRef of [
      f.blob(nativeField(7, nativeField(1, "Future content"))),
      f.blob(nativeMessage(nativeField(1, nativeField(1, "Answer")), nativeField(3, nativeField(1, "Thought")))),
      f.blob(nativeField(1, nativeMessage(nativeField(1, "Answer"), nativeField(9, "Future answer field")))),
    ]) {
      f.write({ turns: [{ requestId: randomUUID(), stepRefs: [stepRef] }] });
      const result = await read(f);
      assert.equal(result.ok, true);
      assert.equal(result.snapshot.turns[0].reason, "native_step_unsupported");
      assert.equal(result.snapshot.turns[0].steps[0].type, "unknown");
      assert.equal(result.snapshot.turns[0].steps[0].text, undefined);
    }
  } finally { await f.cleanup(); }
});

test("Cursor accepts binary blob values and hex state, and bounds native record size", async () => {
  const f = await databaseFixture();
  try {
    const userRef = f.blob(nativeMessage(nativeField(1, "Question"), nativeField(2, randomUUID())), { storage: "binary" });
    f.write({ encoding: "hex", turns: [{ requestId: randomUUID(), userRef }] });
    assert.equal((await read(f)).snapshot.turns[0].userPrompt, "Question");
    f.setRow(`composerData:${f.sessionId}`, " ".repeat(16 * 1024 * 1024 + 1));
    assert.deepEqual(await read(f), failure("database_snapshot_too_large"));
    assert.deepEqual(await readCursorDatabaseSnapshot({ databasePath: "relative.db", sessionId: f.sessionId }), failure("database_path_invalid"));
  } finally { await f.cleanup(); }
});

test("Cursor exposes changed blob content even when a reference is reused", async () => {
  const f = await databaseFixture();
  try {
    const native = f.write({ turns: [{ requestId: randomUUID() }] });
    const before = await read(f);
    const changed = nativeField(1, nativeField(1, "Replacement assistant text"));
    f.blob(changed, { ref: native.stepRefs[0][0] });
    const after = await read(f);
    assert.equal(after.snapshot.stateHash, before.snapshot.stateHash);
    assert.equal(after.snapshot.turns[0].steps[0].id, before.snapshot.turns[0].steps[0].id);
    assert.notEqual(after.snapshot.turns[0].steps[0].contentHash, before.snapshot.turns[0].steps[0].contentHash);
  } finally { await f.cleanup(); }
});

test("Cursor database writer contention is bounded and retryable", async () => {
  const f = await databaseFixture();
  try {
    f.write({ turns: [{ requestId: randomUUID() }] });
    f.database.exec("BEGIN EXCLUSIVE");
    const result = await read(f);
    f.database.exec("ROLLBACK");
    assert.deepEqual(result, failure("database_unavailable", true));
    assert.equal((await read(f)).ok, true);
  } finally { await f.cleanup(); }
});


test("Cursor rejects an incompatible SQLite schema without retrying it as delayed content", async () => {
  const f = await databaseFixture();
  try {
    f.database.exec("DROP TABLE cursorDiskKV");
    assert.deepEqual(await read(f), failure("database_native_format_invalid"));
  } finally { await f.cleanup(); }
});

test("Cursor compaction snapshots expose only root and archive identities in a read-only snapshot", async () => {
  const f = await databaseFixture();
  try {
    const first = Buffer.alloc(32, 1), second = Buffer.alloc(32, 2), summary = Buffer.alloc(32, 3);
    const archive = f.summaryArchive({
      summarizedMessageRefs: [first, second], summaryMessageRef: summary,
      summary: "Synthetic summary body must stay private to Cursor",
      extra: [nativeField(99, "Future archive metadata is not memory content")],
    });
    f.write({ turns: [{ requestId: randomUUID(), prompt: "Original user text" }], stateExtra: nativeCompactionFields({
      rootMessageRefs: [summary], archiveRefs: [archive],
    }) });
    // No message blob exists for these refs: this projection reads identities,
    // never root, summarized, or summary message bodies.
    const before = { hash: digest(await readFile(f.databasePath)), mtime: (await stat(f.databasePath)).mtimeMs };
    const identityStat = await stat(f.databasePath, { bigint: true });
    const databaseIdentity = digest(JSON.stringify([await realpath(f.databasePath), String(identityStat.dev), String(identityStat.ino)]));
    assert.deepEqual(await readCursorCompactionSnapshot(f), { ok: true, snapshot: {
      databaseIdentity, rootMessageIds: [summary.toString("hex")], archives: [{
        id: archive.toString("hex"), summaryMessageId: summary.toString("hex"),
        summarizedMessageIds: [first.toString("hex"), second.toString("hex")],
      }],
    } });
    assert.equal((await read(f)).snapshot.turns[0].userPrompt, "Original user text");
    assert.deepEqual({ hash: digest(await readFile(f.databasePath)), mtime: (await stat(f.databasePath)).mtimeMs }, before);
  } finally { await f.cleanup(); }
});

test("Cursor compaction snapshots preserve nested summary lineage and bind the database file", async () => {
  const f = await databaseFixture();
  const other = await databaseFixture({ sessionId: f.sessionId });
  try {
    const id = (n) => Buffer.alloc(32, n).toString("hex");
    f.writeCompaction({ rootMessageIds: [id(1), id(2)] });
    const initial = await readCursorCompactionSnapshot(f);
    assert.deepEqual(initial.snapshot.archives, []);
    const first = f.writeCompaction({ rootMessageIds: [id(3)], archives: [{
      summarizedMessageIds: [id(1), id(2)], summaryMessageId: id(3),
    }] });
    const second = f.writeCompaction({ rootMessageIds: [id(4)], archives: [first.archiveIds[0], {
      summarizedMessageIds: [id(3)], summaryMessageId: id(4),
    }] });
    const current = await readCursorCompactionSnapshot(f);
    assert.equal(current.snapshot.databaseIdentity, initial.snapshot.databaseIdentity);
    assert.deepEqual(current.snapshot.archives.map(({ id }) => id), second.archiveIds);
    assert.deepEqual(current.snapshot.archives[1].summarizedMessageIds, [id(3)]);
    other.writeCompaction({ rootMessageIds: [id(4)] });
    assert.notEqual((await readCursorCompactionSnapshot(other)).snapshot.databaseIdentity, current.snapshot.databaseIdentity);
  } finally { await f.cleanup(); await other.cleanup(); }
});

test("Cursor missing compaction records are retryable and do not block ordinary Add content", async () => {
  const f = await databaseFixture();
  try {
    assert.deepEqual(await readCursorCompactionSnapshot(f), failure("database_session_missing", true));
    f.writeComposer({});
    assert.deepEqual(await readCursorCompactionSnapshot(f), failure("database_state_missing", true));
    f.write({ turns: [{ requestId: randomUUID() }], stateExtra: nativeCompactionFields({ archiveRefs: [Buffer.alloc(32, 4)] }) });
    assert.deepEqual(await readCursorCompactionSnapshot(f), failure("database_blob_missing", true));
    assert.equal((await read(f)).ok, true);
    f.write({ turns: [{ requestId: randomUUID() }], stateExtra: [nativeField(11, Buffer.alloc(0))] });
    const legacy = await readCursorCompactionSnapshot(f);
    assert.equal(legacy.ok, true);
    assert.deepEqual(legacy.snapshot.rootMessageIds, []);
    assert.deepEqual(legacy.snapshot.archives, []);
  } finally { await f.cleanup(); }
});

test("Cursor malformed compaction references fail closed independently of Add turn decoding", async () => {
  const f = await databaseFixture();
  try {
    const message = Buffer.alloc(32, 1), summary = Buffer.alloc(32, 2);
    const validArchive = f.summaryArchive({ summarizedMessageRefs: [message], summaryMessageRef: summary });
    const malformedArchives = [
      f.blob(Buffer.from([0x0a, 0x20, 1])),
      f.summaryArchive({ summarizedMessageRefs: [message] }),
      f.summaryArchive({ summarizedMessageRefs: [], summaryMessageRef: summary }),
      f.summaryArchive({ summarizedMessageRefs: [message, message], summaryMessageRef: summary }),
      f.summaryArchive({ summarizedMessageRefs: [summary], summaryMessageRef: summary }),
      f.summaryArchive({ summarizedMessageRefs: [Buffer.alloc(0)], summaryMessageRef: summary }),
      f.summaryArchive({ summarizedMessageRefs: [message], summaryMessageRef: Buffer.alloc(65) }),
      f.summaryArchive({ summarizedMessageRefs: [message], summaryMessageRef: summary, extra: [nativeField(4, summary)] }),
      f.blob(nativeMessage(nativeField(1, true), nativeField(4, summary))),
    ];
    const invalidStates = [
      [nativeField(1, true)], [nativeField(13, true)],
      nativeCompactionFields({ rootMessageRefs: [message, message] }),
      nativeCompactionFields({ rootMessageRefs: [Buffer.alloc(0)] }),
      nativeCompactionFields({ archiveRefs: [validArchive, validArchive] }),
      nativeCompactionFields({ archiveRefs: [validArchive, f.summaryArchive({
        summarizedMessageRefs: [Buffer.alloc(32, 3)], summaryMessageRef: summary,
      })] }),
      ...malformedArchives.map((ref) => nativeCompactionFields({ archiveRefs: [ref] })),
    ];
    for (const stateExtra of invalidStates) {
      f.write({ turns: [{ requestId: randomUUID(), prompt: "Unaffected native question" }], stateExtra });
      assert.deepEqual(await readCursorCompactionSnapshot(f), failure("database_native_format_invalid"));
      assert.equal((await read(f)).snapshot.turns[0].userPrompt, "Unaffected native question");
    }
  } finally { await f.cleanup(); }
});

test("Cursor compaction bounds root references, archive count and total summarized references", async () => {
  const f = await databaseFixture();
  try {
    const refs = (count, start = 0) => Array.from({ length: count }, (_, index) => {
      const ref = Buffer.alloc(4); ref.writeUInt32BE(start + index); return ref;
    });
    const firstArchive = f.summaryArchive({ summarizedMessageRefs: refs(16_384), summaryMessageRef: Buffer.alloc(32, 1) });
    const secondArchive = f.summaryArchive({ summarizedMessageRefs: refs(16_385, 16_384), summaryMessageRef: Buffer.alloc(32, 2) });
    for (const stateExtra of [
      nativeCompactionFields({ rootMessageRefs: refs(4097) }),
      nativeCompactionFields({ archiveRefs: refs(1025) }),
      nativeCompactionFields({ archiveRefs: [firstArchive, secondArchive] }),
    ]) {
      f.write({ stateExtra });
      assert.deepEqual(await readCursorCompactionSnapshot(f), failure("database_snapshot_too_large"));
      assert.equal((await read(f)).ok, true);
    }
  } finally { await f.cleanup(); }
});
