import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { assertCursorAppNativeContent, assertCursorAppNativeSubagent, assertCursorAppWriteback, assertCursorAppWritebacks } from "./cursor-app-native-content-check.mjs";

const sessionId = "11111111-1111-4111-8111-111111111111";
const generationId = "22222222-2222-4222-8222-222222222222";
const userMessageId = "33333333-3333-4333-8333-333333333333";

function field(number, value) {
  const bytes = Buffer.from(value);
  assert.ok(number < 16 && bytes.length < 128);
  return Buffer.concat([Buffer.from([number * 8 + 2, bytes.length]), bytes]);
}

function emittedTurn() {
  const blob = (bytes) => ({ blobId: createHash("sha256").update(bytes).digest(), bytes });
  const user = blob(Buffer.concat([field(1, "Synthetic question\n\u4e2d\u6587"), field(2, userMessageId)]));
  const answer = blob(field(1, field(1, "Synthetic answer\n\ud83e\uddea")));
  const turn = blob(field(1, Buffer.concat([field(1, user.blobId), field(2, answer.blobId), field(3, generationId)])));
  return { conversationStateBytes: field(8, turn.blobId), kvWrites: [user, answer, turn] };
}

async function fixture(t, { stateEncoding = "base64", blobEncoding = "hex", composerEncoding = "text", unique = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), "memorax-cursor-app-content-"));
  const databasePath = join(root, "state.vscdb");
  const database = new DatabaseSync(databasePath);
  t.after(async () => { database.close(); await rm(root, { recursive: true, force: true }); });
  database.exec(`CREATE TABLE cursorDiskKV (key TEXT${unique ? " PRIMARY KEY" : ""}, value BLOB)`);
  const put = (key, value) => database.prepare("INSERT OR REPLACE INTO cursorDiskKV (key, value) VALUES (?, ?)").run(key, value);
  const emitted = emittedTurn();
  const composer = { composerId: sessionId, latestChatGenerationUUID: generationId,
    conversationState: stateEncoding === "hex" ? emitted.conversationStateBytes.toString("hex")
      : `~${emitted.conversationStateBytes.toString("base64")}` };
  const writeComposer = (value = composer) => put(`composerData:${sessionId}`, composerEncoding === "blob"
    ? Buffer.from(JSON.stringify(value)) : JSON.stringify(value));
  writeComposer();
  for (const { blobId, bytes } of emitted.kvWrites) {
    put(`agentKv:blob:${blobId.toString("hex")}`, blobEncoding === "hex" ? bytes.toString("hex") : bytes);
  }
  return { database, databasePath, root, put, composer, writeComposer,
    input: { databasePath, sessionId, generationId, ...emitted } };
}

function rejects(input, code) {
  assert.throws(() => assertCursorAppNativeContent(input), (error) => {
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    assert.equal(error.cause, undefined);
    return true;
  });
}

for (const stateEncoding of ["hex", "base64"]) {
  for (const blobEncoding of ["hex", "blob"]) {
    test(`native oracle matches exact ${stateEncoding} state and ${blobEncoding} content-addressed blobs`, async (t) => {
      const f = await fixture(t, { stateEncoding, blobEncoding });
      const before = await readFile(f.databasePath);
      assert.deepEqual(assertCursorAppNativeContent(f.input), { composerMatched: true, stateMatched: true, blobCount: 3 });
      assert.deepEqual(await readFile(f.databasePath), before);
    });
  }
}

test("native oracle accepts UTF-8 SQLite BLOB composer JSON and hexadecimal letter case", async (t) => {
  const f = await fixture(t, { composerEncoding: "blob", stateEncoding: "hex" });
  f.writeComposer({ ...f.composer, conversationState: f.composer.conversationState.toUpperCase() });
  for (const { blobId, bytes } of f.input.kvWrites) f.put(`agentKv:blob:${blobId.toString("hex")}`, bytes.toString("hex").toUpperCase());
  assert.equal(assertCursorAppNativeContent(f.input).blobCount, 3);
});

test("native oracle reads committed WAL content without modifying a concurrent writer", async (t) => {
  const f = await fixture(t);
  f.database.exec("PRAGMA journal_mode = WAL");
  f.writeComposer();
  f.database.exec("BEGIN IMMEDIATE");
  f.writeComposer({ ...f.composer, latestChatGenerationUUID: userMessageId });
  try { assert.equal(assertCursorAppNativeContent(f.input).stateMatched, true); }
  finally { f.database.exec("ROLLBACK"); }
  assert.equal(assertCursorAppNativeContent(f.input).stateMatched, true);
});

test("native oracle does not create a missing database and suppresses SQLite errors", async (t) => {
  const f = await fixture(t);
  const missing = join(f.root, "private-missing-database");
  rejects({ ...f.input, databasePath: missing }, "CURSOR_APP_DATABASE_READ_FAILED");
  await assert.rejects(stat(missing), { code: "ENOENT" });
  const invalid = join(f.root, "private-invalid-database");
  await writeFile(invalid, "private invalid database contents");
  rejects({ ...f.input, databasePath: invalid }, "CURSOR_APP_DATABASE_READ_FAILED");
});

test("native oracle rejects missing and duplicate composer rows", async (t) => {
  const f = await fixture(t, { unique: false });
  f.database.prepare("DELETE FROM cursorDiskKV WHERE key = ?").run(`composerData:${sessionId}`);
  rejects(f.input, "CURSOR_APP_DATABASE_COMPOSER_MISSING");
  f.writeComposer();
  f.writeComposer();
  rejects(f.input, "CURSOR_APP_DATABASE_ROW_AMBIGUOUS");
});

test("native oracle requires exact stored composer and generation identities", async (t) => {
  const f = await fixture(t);
  for (const [field, code] of [["composerId", "CURSOR_APP_DATABASE_SESSION_MISMATCH"],
    ["latestChatGenerationUUID", "CURSOR_APP_DATABASE_GENERATION_MISMATCH"]]) {
    for (const value of [undefined, null, userMessageId, "private identity"]) {
      f.writeComposer({ ...f.composer, [field]: value });
      rejects(f.input, code);
    }
  }
});

test("native oracle rejects malformed composer rows without including their contents", async (t) => {
  const f = await fixture(t);
  for (const value of [null, 7, "private not-json", "null", "[]", Buffer.from([0xc3, 0x28])]) {
    f.put(`composerData:${sessionId}`, value);
    rejects(f.input, "CURSOR_APP_DATABASE_COMPOSER_INVALID");
  }
});

test("native oracle strictly decodes native state instead of accepting permissive Buffer encodings", async (t) => {
  const f = await fixture(t);
  for (const value of [undefined, null, {}, "0", "0g", "42 00", "~YQ", "~YQ=", "~YQ==\n", "~YR==", "~_w==", "~%%%="]) {
    f.writeComposer({ ...f.composer, conversationState: value });
    rejects(f.input, "CURSOR_APP_DATABASE_STATE_ENCODING");
  }
});

test("native oracle rejects empty, truncated and changed state even with unchanged blobs", async (t) => {
  const f = await fixture(t);
  for (const bytes of [Buffer.alloc(0), f.input.conversationStateBytes.subarray(0, -1), Buffer.from([0])]) {
    f.writeComposer({ ...f.composer, conversationState: `~${bytes.toString("base64")}` });
    rejects(f.input, "CURSOR_APP_DATABASE_STATE_MISMATCH");
  }
});

test("native oracle requires every emitted blob rather than only an intact state reference", async (t) => {
  const f = await fixture(t);
  for (const write of f.input.kvWrites) {
    const key = `agentKv:blob:${write.blobId.toString("hex")}`;
    f.database.prepare("DELETE FROM cursorDiskKV WHERE key = ?").run(key);
    rejects(f.input, "CURSOR_APP_DATABASE_BLOB_MISSING");
    f.put(key, write.bytes);
  }
});

test("native oracle rejects duplicate blob rows", async (t) => {
  const f = await fixture(t, { unique: false });
  const { blobId, bytes } = f.input.kvWrites[0];
  f.put(`agentKv:blob:${blobId.toString("hex")}`, bytes);
  rejects(f.input, "CURSOR_APP_DATABASE_ROW_AMBIGUOUS");
});

test("native oracle rejects malformed and mismatched blobs without exposing their contents", async (t) => {
  const f = await fixture(t);
  const { blobId, bytes } = f.input.kvWrites[0];
  const key = `agentKv:blob:${blobId.toString("hex")}`;
  for (const value of [null, 7, "0", "gg", "00\n", "private blob content"]) {
    f.put(key, value);
    rejects(f.input, "CURSOR_APP_DATABASE_BLOB_ENCODING");
  }
  for (const value of [Buffer.alloc(0), Buffer.from([0]), bytes.subarray(0, -1), "0000"]) {
    f.put(key, value);
    rejects(f.input, "CURSOR_APP_DATABASE_BLOB_MISMATCH");
  }
});

test("native oracle validates expected identities and bytes before opening the database", async (t) => {
  const f = await fixture(t);
  for (const value of [undefined, "", "relative/state.vscdb", `${f.databasePath}\n`]) {
    rejects({ ...f.input, databasePath: value }, "CURSOR_APP_DATABASE_PATH");
  }
  for (const field of ["sessionId", "generationId"]) {
    for (const value of [undefined, "", "private invalid identity", `${sessionId}\n`]) {
      rejects({ ...f.input, [field]: value }, "CURSOR_APP_DATABASE_EXPECTED_IDENTITY");
    }
  }
  for (const value of [undefined, "state", Buffer.alloc(0)]) {
    rejects({ ...f.input, conversationStateBytes: value }, "CURSOR_APP_DATABASE_EXPECTED_STATE");
  }
  for (const value of [undefined, {}, []]) rejects({ ...f.input, kvWrites: value }, "CURSOR_APP_DATABASE_EXPECTED_BLOBS");
});

test("native oracle rejects malformed, incorrectly addressed and duplicate expected blobs", async (t) => {
  const f = await fixture(t);
  const write = f.input.kvWrites[0];
  for (const value of [null, {}, { ...write, blobId: "not bytes" }, { ...write, blobId: Buffer.alloc(31) },
    { ...write, bytes: "not bytes" }, { ...write, bytes: Buffer.alloc(0) }]) {
    rejects({ ...f.input, kvWrites: [value] }, "CURSOR_APP_DATABASE_EXPECTED_BLOB");
  }
  rejects({ ...f.input, kvWrites: [{ ...write, bytes: Buffer.from("private wrong content") }] },
    "CURSOR_APP_DATABASE_EXPECTED_BLOB_HASH");
  rejects({ ...f.input, kvWrites: [write, write] }, "CURSOR_APP_DATABASE_EXPECTED_BLOB_DUPLICATE");
});

async function subagentFixture(t, options) {
  const f = await fixture(t, options);
  const child = { composerId: userMessageId,
    subagentInfo: { parentComposerId: sessionId, subagentTypeName: "memorax-repo-memory" } };
  const parent = { ...f.composer, subagentComposerIds: [userMessageId] };
  const writeChild = (value = child) => f.put(`composerData:${userMessageId}`, JSON.stringify(value));
  f.writeComposer(parent);
  writeChild();
  return { ...f, parent, child, writeChild,
    input: { databasePath: f.databasePath, parentSessionId: sessionId, childSessionId: userMessageId } };
}

function rejectsSubagent(input, code) {
  assert.throws(() => assertCursorAppNativeSubagent(input), (error) => {
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    assert.equal(error.cause, undefined);
    return true;
  });
}

test("native subagent oracle requires both persisted links without modifying the database", async (t) => {
  const f = await subagentFixture(t);
  const before = await readFile(f.databasePath);
  assert.deepEqual(assertCursorAppNativeSubagent(f.input), { parentLinked: true, childLinked: true });
  assert.deepEqual(await readFile(f.databasePath), before);
  f.put(`composerData:${userMessageId}`, Buffer.from(JSON.stringify(f.child)));
  assert.deepEqual(assertCursorAppNativeSubagent(f.input), { parentLinked: true, childLinked: true });
});

test("native subagent oracle rejects missing and duplicate parent or child rows", async (t) => {
  const f = await subagentFixture(t, { unique: false });
  f.database.prepare("DELETE FROM cursorDiskKV WHERE key = ?").run(`composerData:${sessionId}`);
  f.writeComposer(f.parent);
  for (const [id, value] of [[sessionId, f.parent], [userMessageId, f.child]]) {
    f.database.prepare("DELETE FROM cursorDiskKV WHERE key = ?").run(`composerData:${id}`);
    rejectsSubagent(f.input, "CURSOR_APP_DATABASE_COMPOSER_MISSING");
    f.put(`composerData:${id}`, JSON.stringify(value));
    f.put(`composerData:${id}`, JSON.stringify(value));
    rejectsSubagent(f.input, "CURSOR_APP_DATABASE_ROW_AMBIGUOUS");
    f.database.prepare("DELETE FROM cursorDiskKV WHERE key = ?").run(`composerData:${id}`);
    f.put(`composerData:${id}`, JSON.stringify(value));
  }
});

test("native subagent oracle validates stored identity, parent and exact managed type", async (t) => {
  const f = await subagentFixture(t);
  for (const composerId of [undefined, null, sessionId, "private mismatched composer"]) {
    f.writeChild({ ...f.child, composerId });
    rejectsSubagent(f.input, "CURSOR_APP_DATABASE_SESSION_MISMATCH");
  }
  for (const subagentInfo of [undefined, null, [], {}, { ...f.child.subagentInfo, parentComposerId: generationId },
    { ...f.child.subagentInfo, parentComposerId: userMessageId }]) {
    f.writeChild({ ...f.child, subagentInfo });
    rejectsSubagent(f.input, "CURSOR_APP_DATABASE_SUBAGENT_PARENT_MISMATCH");
  }
  for (const subagentTypeName of [undefined, null, "explore", "private managed type", "memorax-repo-memory "]) {
    f.writeChild({ ...f.child, subagentInfo: { ...f.child.subagentInfo, subagentTypeName } });
    rejectsSubagent(f.input, "CURSOR_APP_DATABASE_SUBAGENT_TYPE_MISMATCH");
  }
});

test("native subagent oracle rejects absent, malformed or duplicated parent links", async (t) => {
  const f = await subagentFixture(t);
  for (const subagentComposerIds of [undefined, null, {}, [], [generationId], [userMessageId, userMessageId],
    [userMessageId, null], [userMessageId, ""]]) {
    f.writeComposer({ ...f.parent, subagentComposerIds });
    rejectsSubagent(f.input, "CURSOR_APP_DATABASE_SUBAGENT_LINK_MISMATCH");
  }
});

test("native subagent oracle redacts invalid records, inputs and database errors", async (t) => {
  const f = await subagentFixture(t);
  for (const value of [null, 7, "private not-json", "null", "[]", Buffer.from([0xc3, 0x28])]) {
    f.put(`composerData:${userMessageId}`, value);
    rejectsSubagent(f.input, "CURSOR_APP_DATABASE_COMPOSER_INVALID");
  }
  for (const field of ["parentSessionId", "childSessionId"]) {
    for (const value of [undefined, null, "private identity"]) {
      rejectsSubagent({ ...f.input, [field]: value }, "CURSOR_APP_DATABASE_EXPECTED_IDENTITY");
    }
  }
  rejectsSubagent({ ...f.input, childSessionId: sessionId }, "CURSOR_APP_DATABASE_EXPECTED_IDENTITY");
  rejectsSubagent({ ...f.input, databasePath: "private-relative-path" }, "CURSOR_APP_DATABASE_PATH");
  const missing = join(f.root, "private-missing-child-db");
  rejectsSubagent({ ...f.input, databasePath: missing }, "CURSOR_APP_DATABASE_READ_FAILED");
  await assert.rejects(stat(missing), { code: "ENOENT" });
});

function writebackFixture({ sessionId: turnSessionId = sessionId,
  prompt = "Synthetic prompt\n\u8bb0\u5fc6-42 \u00e9",
  answer = "Synthetic answer\n\u8bb0\u5fc6-42 \ud83e\uddea", workspaceName = "synthetic-workspace" } = {}) {
  const apiKey = "synthetic-private-api-key", baseUserId = "synthetic-user";
  const userId = `${baseUserId}@${workspaceName}`;
  const hash = (text) => createHash("sha256").update(text).digest("hex").slice(0, 16);
  const body = {
    messages: [{ role: "user", content: prompt, timestamp: 123 }, { role: "assistant", content: answer, timestamp: 124 }],
    session_id: turnSessionId, user_id: userId,
    metadata: { memorax_code_session_id: turnSessionId, memorax_code_base_user_id: baseUserId,
      memorax_code_workspace: workspaceName, memorax_code_memory_scope: "workspace-name.v1",
      idempotency_key: `automatic:cursor:${hash(userId)}:${turnSessionId}:${hash(prompt)}:${hash(answer)}` },
  };
  return { sessionId: turnSessionId, prompt, answer, apiKey, baseUserId, workspaceName,
    requests: [{ method: "POST", path: "/v1/memories/add", authorization: `Token ${apiKey}`, body }] };
}

function rejectsWriteback(input, code, oracle = assertCursorAppWriteback) {
  assert.throws(() => oracle(input), (error) => {
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    assert.equal(error.cause, undefined);
    return true;
  });
}

test("writeback oracle matches exactly one Cursor automatic Add with complete Unicode content", () => {
  const input = writebackFixture(), before = structuredClone(input);
  assert.deepEqual(assertCursorAppWriteback(input), { automaticAdd: 1 });
  assert.deepEqual(input, before);
});

test("writeback oracle rejects absent, malformed and extra receiver requests", () => {
  const input = writebackFixture();
  for (const requests of [undefined, null, {}, [], [input.requests[0], input.requests[0]],
    [...input.requests, { method: "POST", path: "/v1/memories/search" }]]) {
    rejectsWriteback({ ...input, requests }, "CURSOR_APP_MEMORY_REQUEST_COUNT");
  }
});

test("writeback oracle requires the exact HTTP method, Add route and Token credential", () => {
  for (const [field, values] of [
    ["method", [undefined, "GET", "post"]],
    ["path", [undefined, "/v1/memories/search", "/v1/memories/add?unexpected=true"]],
    ["authorization", [undefined, "Token private-wrong-key", "Bearer synthetic-private-api-key"]],
  ]) {
    for (const value of values) {
      const input = writebackFixture();
      input.requests[0][field] = value;
      rejectsWriteback(input, "CURSOR_APP_ADD_TRANSPORT");
    }
  }
  rejectsWriteback({ ...writebackFixture(), requests: [null] }, "CURSOR_APP_ADD_TRANSPORT");
});

test("writeback oracle requires exactly two ordered messages with complete roles and text", () => {
  const mutations = [
    (body) => { body.messages = undefined; },
    (body) => { body.messages = []; },
    (body) => { body.messages.pop(); },
    (body) => { body.messages.push({ role: "assistant", content: "private extra content" }); },
    (body) => { body.messages.reverse(); },
    (body) => { body.messages[0] = null; },
    (body) => { body.messages[0].role = "system"; },
    (body) => { body.messages[1].role = "tool"; },
    (body) => { body.messages[0].content = body.messages[0].content.slice(0, -1); },
    (body) => { body.messages[1].content = body.messages[1].content.slice(0, -1); },
    (body) => { body.messages[0].content = body.messages[0].content.normalize("NFD"); },
    (body) => { body.messages[1].content += "\nprivate extra content"; },
  ];
  for (const mutate of mutations) {
    const input = writebackFixture();
    mutate(input.requests[0].body);
    rejectsWriteback(input, "CURSOR_APP_ADD_CONTENT");
  }
  for (const body of [undefined, null, [], "private unexpected body"]) {
    const input = writebackFixture();
    input.requests[0].body = body;
    rejectsWriteback(input, "CURSOR_APP_ADD_CONTENT");
  }
});

test("writeback oracle binds both session identity fields", () => {
  for (const field of ["session_id", "memorax_code_session_id"]) {
    for (const value of [undefined, null, generationId]) {
      const input = writebackFixture(), body = input.requests[0].body;
      (field === "session_id" ? body : body.metadata)[field] = value;
      rejectsWriteback(input, "CURSOR_APP_ADD_SESSION");
    }
  }
  for (const value of [undefined, null, {}]) {
    const input = writebackFixture();
    input.requests[0].body.metadata = value;
    rejectsWriteback(input, "CURSOR_APP_ADD_SESSION");
  }
});

test("writeback oracle rejects cross-user, cross-workspace and wrong scope-version payloads", () => {
  for (const [field, value] of [["user_id", "other-user@synthetic-workspace"],
    ["memorax_code_base_user_id", "other-user"], ["memorax_code_workspace", "other-workspace"],
    ["memorax_code_memory_scope", "repository-name.v1"]]) {
    for (const replacement of [undefined, value]) {
      const input = writebackFixture(), body = input.requests[0].body;
      (field === "user_id" ? body : body.metadata)[field] = replacement;
      rejectsWriteback(input, "CURSOR_APP_ADD_SCOPE");
    }
  }
});

test("writeback oracle accepts Git scope only when explicitly expected and keeps scope identity exact", () => {
  const input = { ...writebackFixture({ workspaceName: "worker-repository" }), scope: "repository-name.v1" };
  input.requests[0].body.metadata.memorax_code_memory_scope = "repository-name.v1";
  assert.deepEqual(assertCursorAppWriteback(input), { automaticAdd: 1 });
  rejectsWriteback({ ...input, scope: undefined }, "CURSOR_APP_ADD_SCOPE");
  for (const scope of [null, false, "general.v1", "private scope", {}]) {
    rejectsWriteback({ ...input, scope }, "CURSOR_APP_ADD_EXPECTED");
  }
  for (const [field, value] of [["user_id", "other-user@worker-repository"],
    ["memorax_code_base_user_id", "other-user"], ["memorax_code_workspace", "other-repository"],
    ["memorax_code_memory_scope", "workspace-name.v1"]]) {
    const invalid = structuredClone(input), body = invalid.requests[0].body;
    (field === "user_id" ? body : body.metadata)[field] = value;
    rejectsWriteback(invalid, "CURSOR_APP_ADD_SCOPE");
  }
  const invalid = structuredClone(input);
  invalid.requests[0].body.metadata.idempotency_key = "private incorrect idempotency";
  rejectsWriteback(invalid, "CURSOR_APP_ADD_IDEMPOTENCY");
});

test("writeback oracle verifies the Cursor client and every automatic idempotency component", () => {
  for (let part = 0; part < 6; part += 1) {
    const input = writebackFixture(), metadata = input.requests[0].body.metadata;
    const pieces = metadata.idempotency_key.split(":");
    pieces[part] = part === 1 ? "codex" : "private-wrong-component";
    metadata.idempotency_key = pieces.join(":");
    rejectsWriteback(input, "CURSOR_APP_ADD_IDEMPOTENCY");
  }
  const input = writebackFixture();
  delete input.requests[0].body.metadata.idempotency_key;
  rejectsWriteback(input, "CURSOR_APP_ADD_IDEMPOTENCY");
});

test("writeback oracle rejects incomplete expectations and suppresses unexpected error text", () => {
  for (const field of ["sessionId", "prompt", "answer", "apiKey", "baseUserId", "workspaceName"]) {
    for (const value of [undefined, "", " ", 1]) {
      rejectsWriteback({ ...writebackFixture(), [field]: value }, "CURSOR_APP_ADD_EXPECTED");
    }
  }
  const input = writebackFixture();
  Object.defineProperty(input.requests[0], "body", { get() { throw new Error("private receiver failure"); } });
  rejectsWriteback(input, "CURSOR_APP_ADD_INVALID");
});

function writebacksFixture() {
  const first = writebackFixture();
  const turns = [
    { sessionId, workspaceName: "project-alpha", prompt: first.prompt, answer: first.answer },
    { sessionId, workspaceName: "project-alpha", prompt: first.prompt, answer: "Synthetic second answer\n\u8bb0\u5fc6-42 \ud83e\uddea" },
    { sessionId: userMessageId, workspaceName: "project-beta", prompt: first.prompt, answer: first.answer },
    { sessionId, workspaceName: "project-alpha", prompt: "Synthetic resumed prompt\n\u8bb0\u5fc6-42 \u00e9",
      answer: "Synthetic resumed answer\n\u8bb0\u5fc6-42 \ud83e\uddea" },
  ];
  return { requests: turns.map((turn) => writebackFixture(turn).requests[0]), turns,
    apiKey: first.apiKey, baseUserId: first.baseUserId };
}

test("writebacks oracle matches ordered repeated prompts and A/B/A workspace scopes", () => {
  const input = writebacksFixture(), before = structuredClone(input);
  assert.deepEqual(assertCursorAppWritebacks(input), { automaticAdd: 4 });
  assert.deepEqual(input, before);
});

test("writebacks oracle preserves default local scope while explicitly checking the Git worker parent", () => {
  const input = writebacksFixture();
  const worker = { ...writebackFixture({ workspaceName: "worker-repository", sessionId: generationId }),
    scope: "repository-name.v1" };
  worker.requests[0].body.metadata.memorax_code_memory_scope = worker.scope;
  input.turns.push({ sessionId: worker.sessionId, prompt: worker.prompt, answer: worker.answer,
    workspaceName: worker.workspaceName, scope: worker.scope });
  input.requests.push(worker.requests[0]);
  assert.deepEqual(assertCursorAppWritebacks(input), { automaticAdd: 5 });
  input.requests[0].body.metadata.memorax_code_memory_scope = worker.scope;
  rejectsWriteback(input, "CURSOR_APP_ADD_SCOPE", assertCursorAppWritebacks);
});

test("writebacks oracle rejects workspace B using workspace A scope and idempotency", () => {
  const input = writebacksFixture();
  input.requests[2] = writebackFixture({ ...input.turns[2], workspaceName: input.turns[0].workspaceName }).requests[0];
  rejectsWriteback(input, "CURSOR_APP_ADD_SCOPE", assertCursorAppWritebacks);
});

test("writebacks oracle requires every turn workspace without a global fallback", () => {
  for (let index = 0; index < 4; index += 1) {
    for (const value of [undefined, null, "", " ", 1]) {
      const input = writebacksFixture();
      input.workspaceName = input.turns[index].workspaceName;
      input.turns[index].workspaceName = value;
      rejectsWriteback(input, "CURSOR_APP_ADD_EXPECTED", assertCursorAppWritebacks);
    }
  }
});

test("writebacks oracle rejects missing, extra and late receiver requests", () => {
  const input = writebacksFixture();
  for (const requests of [undefined, null, {}, [], input.requests.slice(0, -1),
    [...input.requests, input.requests[0]], [...input.requests, { method: "POST", path: "/v1/memories/search" }]]) {
    rejectsWriteback({ ...input, requests }, "CURSOR_APP_MEMORY_REQUEST_COUNT", assertCursorAppWritebacks);
  }
});

test("writebacks oracle rejects replaying or reordering turns with the same prompt but different answers", () => {
  for (const reorder of [(requests) => { requests[1] = requests[0]; },
    (requests) => { [requests[0], requests[1]] = [requests[1], requests[0]]; }]) {
    const input = writebacksFixture();
    reorder(input.requests);
    rejectsWriteback(input, "CURSOR_APP_ADD_CONTENT", assertCursorAppWritebacks);
  }
});

test("writebacks oracle rejects cross-session replay and reordering even when message text is identical", () => {
  for (const reorder of [(requests) => { requests[2] = requests[0]; },
    (requests) => { [requests[0], requests[2]] = [requests[2], requests[0]]; }]) {
    const input = writebacksFixture();
    reorder(input.requests);
    rejectsWriteback(input, "CURSOR_APP_ADD_SESSION", assertCursorAppWritebacks);
  }
});

test("writebacks oracle rejects truncated Unicode, mixed turns and an invalid later scope", () => {
  for (const mutate of [
    (body) => { body.messages[1].content = body.messages[1].content.slice(0, -1); },
    (body) => { body.messages[0].content = writebackFixture().prompt; },
  ]) {
    const input = writebacksFixture();
    mutate(input.requests[3].body);
    rejectsWriteback(input, "CURSOR_APP_ADD_CONTENT", assertCursorAppWritebacks);
  }
  const input = writebacksFixture();
  input.requests[3].body.metadata.memorax_code_workspace = "other-workspace";
  rejectsWriteback(input, "CURSOR_APP_ADD_SCOPE", assertCursorAppWritebacks);
});

test("writebacks oracle validates every expectation and keeps errors redacted", () => {
  const input = writebacksFixture();
  for (const turns of [undefined, null, {}, []]) {
    rejectsWriteback({ ...input, turns }, "CURSOR_APP_ADD_EXPECTED", assertCursorAppWritebacks);
  }
  for (const turn of [undefined, null, {}, { ...input.turns[3], sessionId: "private-invalid-session" }]) {
    rejectsWriteback({ ...input, turns: [...input.turns.slice(0, -1), turn] },
      "CURSOR_APP_ADD_EXPECTED", assertCursorAppWritebacks);
  }
  Object.defineProperty(input.turns[3], "answer", { get() { throw new Error("private fixture failure"); } });
  rejectsWriteback(input, "CURSOR_APP_ADD_INVALID", assertCursorAppWritebacks);
});
