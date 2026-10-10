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
const childId = "33333333-3333-4333-8333-333333333333";
const privateCanary = "private-content-path-token-canary";
const digest = (bytes) => createHash("sha256").update(bytes).digest();

function rejects(action, code) {
  assert.throws(action, (error) => {
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    assert.equal(error.cause, undefined);
    return true;
  });
}

async function fixture(t, { hexState = false, binaryRows = false, unique = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), "memorax-cursor-app-content-"));
  const databasePath = join(root, "state.vscdb"), database = new DatabaseSync(databasePath);
  t.after(async () => { database.close(); await rm(root, { recursive: true, force: true }); });
  database.exec(`CREATE TABLE cursorDiskKV (key TEXT${unique ? " PRIMARY KEY" : ""}, value BLOB)`);
  const put = (key, value) => database.prepare("INSERT OR REPLACE INTO cursorDiskKV (key, value) VALUES (?, ?)").run(key, value);
  const remove = (key) => database.prepare("DELETE FROM cursorDiskKV WHERE key = ?").run(key);
  // Opaque bytes keep this oracle independent of the product's native decoder.
  const kvWrites = ["Synthetic question\n\u4e2d\u6587", "Synthetic answer\n\ud83e\uddea", generationId]
    .map((text) => Buffer.from(text)).map((bytes) => ({ bytes, blobId: digest(bytes) }));
  const conversationStateBytes = Buffer.concat(kvWrites.map((write) => write.blobId));
  const composer = { composerId: sessionId, latestChatGenerationUUID: generationId,
    conversationState: hexState ? conversationStateBytes.toString("hex").toUpperCase()
      : `~${conversationStateBytes.toString("base64")}` };
  const writeComposer = (value = composer, id = sessionId) => put(`composerData:${id}`,
    binaryRows ? Buffer.from(JSON.stringify(value)) : JSON.stringify(value));
  writeComposer();
  for (const { blobId, bytes } of kvWrites) put(`agentKv:blob:${blobId.toString("hex")}`,
    binaryRows ? bytes : bytes.toString("hex").toUpperCase());
  return { root, database, put, remove, composer, writeComposer,
    input: { databasePath, sessionId, generationId, conversationStateBytes, kvWrites } };
}

test("native oracle compares opaque SQLite state and every blob in supported encodings without writing", async (t) => {
  for (const options of [{}, { hexState: true, binaryRows: true }]) {
    const f = await fixture(t, options), before = await readFile(f.input.databasePath);
    assert.deepEqual(assertCursorAppNativeContent(f.input), { composerMatched: true, stateMatched: true, blobCount: 3 });
    assert.deepEqual(await readFile(f.input.databasePath), before);
  }
});

test("native oracle reads committed WAL content during an uncommitted generation change", async (t) => {
  const f = await fixture(t);
  f.database.exec("PRAGMA journal_mode = WAL");
  f.writeComposer();
  f.database.exec("BEGIN IMMEDIATE");
  f.writeComposer({ ...f.composer, latestChatGenerationUUID: childId });
  try { assert.equal(assertCursorAppNativeContent(f.input).stateMatched, true); }
  finally { f.database.exec("ROLLBACK"); }
});

test("native oracle rejects missing, ambiguous, malformed and mismatched persisted content", async (t) => {
  const f = await fixture(t, { unique: false }), composerKey = `composerData:${sessionId}`;
  const check = (suffix) => rejects(() => assertCursorAppNativeContent(f.input), `CURSOR_APP_DATABASE_${suffix}`);
  f.remove(composerKey);
  check("COMPOSER_MISSING");
  f.writeComposer();
  f.writeComposer();
  check("ROW_AMBIGUOUS");
  for (const [value, suffix] of [
    [privateCanary, "COMPOSER_INVALID"], [Buffer.from([0xc3, 0x28]), "COMPOSER_INVALID"],
    [JSON.stringify({ ...f.composer, composerId: childId }), "SESSION_MISMATCH"],
    [JSON.stringify({ ...f.composer, latestChatGenerationUUID: childId }), "GENERATION_MISMATCH"],
    ...["0g", "~YQ", "~YR=="].map((conversationState) =>
      [JSON.stringify({ ...f.composer, conversationState }), "STATE_ENCODING"]),
    [JSON.stringify({ ...f.composer, conversationState: `~${f.input.conversationStateBytes.subarray(0, -1).toString("base64")}` }), "STATE_MISMATCH"],
  ]) {
    f.remove(composerKey);
    f.put(composerKey, value);
    check(suffix);
  }
  f.remove(composerKey);
  f.writeComposer();
  for (const { blobId, bytes } of f.input.kvWrites) {
    const key = `agentKv:blob:${blobId.toString("hex")}`;
    f.remove(key);
    check("BLOB_MISSING");
    for (const [value, suffix] of [[privateCanary, "BLOB_ENCODING"], [bytes.subarray(0, -1), "BLOB_MISMATCH"]]) {
      f.put(key, value);
      check(suffix);
      f.remove(key);
    }
    f.put(key, bytes);
  }
  const { blobId, bytes } = f.input.kvWrites[0];
  f.put(`agentKv:blob:${blobId.toString("hex")}`, bytes);
  check("ROW_AMBIGUOUS");
});

test("native oracle validates expected identity and content addresses before opening SQLite", async (t) => {
  const f = await fixture(t), write = f.input.kvWrites[0];
  for (const [change, suffix] of [
    [{ databasePath: "relative/private" }, "PATH"],
    [{ sessionId: `${sessionId}\n` }, "EXPECTED_IDENTITY"],
    [{ generationId: privateCanary }, "EXPECTED_IDENTITY"],
    [{ conversationStateBytes: Buffer.alloc(0) }, "EXPECTED_STATE"],
    [{ kvWrites: [] }, "EXPECTED_BLOBS"],
    [{ kvWrites: [{ ...write, blobId: Buffer.alloc(31) }] }, "EXPECTED_BLOB"],
    [{ kvWrites: [{ ...write, bytes: Buffer.alloc(0) }] }, "EXPECTED_BLOB"],
    [{ kvWrites: [{ ...write, bytes: Buffer.from(privateCanary) }] }, "EXPECTED_BLOB_HASH"],
    [{ kvWrites: [write, write] }, "EXPECTED_BLOB_DUPLICATE"],
  ]) rejects(() => assertCursorAppNativeContent({ ...f.input, ...change }), `CURSOR_APP_DATABASE_${suffix}`);
  const missing = join(f.root, privateCanary);
  rejects(() => assertCursorAppNativeContent({ ...f.input, databasePath: missing }), "CURSOR_APP_DATABASE_READ_FAILED");
  await assert.rejects(stat(missing), { code: "ENOENT" });
  await writeFile(missing, privateCanary);
  rejects(() => assertCursorAppNativeContent({ ...f.input, databasePath: missing }), "CURSOR_APP_DATABASE_READ_FAILED");
});

test("native subagent oracle requires matching composer identities and both persisted managed links", async (t) => {
  const f = await fixture(t);
  const parent = { ...f.composer, subagentComposerIds: [childId] };
  const child = { composerId: childId,
    subagentInfo: { parentComposerId: sessionId, subagentTypeName: "memorax-repo-memory" } };
  const input = { databasePath: f.input.databasePath, parentSessionId: sessionId, childSessionId: childId };
  f.writeComposer(parent);
  f.writeComposer(child, childId);
  const before = await readFile(input.databasePath);
  assert.deepEqual(assertCursorAppNativeSubagent(input), { parentLinked: true, childLinked: true });
  assert.deepEqual(await readFile(input.databasePath), before);
  for (const [value, suffix] of [
    [{ ...child, composerId: sessionId }, "SESSION_MISMATCH"],
    [{ ...child, subagentInfo: { ...child.subagentInfo, parentComposerId: generationId } }, "SUBAGENT_PARENT_MISMATCH"],
    [{ ...child, subagentInfo: { ...child.subagentInfo, subagentTypeName: "explore" } }, "SUBAGENT_TYPE_MISMATCH"],
  ]) {
    f.writeComposer(value, childId);
    rejects(() => assertCursorAppNativeSubagent(input), `CURSOR_APP_DATABASE_${suffix}`);
  }
  f.writeComposer(child, childId);
  for (const subagentComposerIds of [[], [generationId], [childId, childId], [childId, null]]) {
    f.writeComposer({ ...parent, subagentComposerIds });
    rejects(() => assertCursorAppNativeSubagent(input), "CURSOR_APP_DATABASE_SUBAGENT_LINK_MISMATCH");
  }
  f.writeComposer(parent);
  f.remove(`composerData:${childId}`);
  rejects(() => assertCursorAppNativeSubagent(input), "CURSOR_APP_DATABASE_COMPOSER_MISSING");
  for (const change of [{ childSessionId: sessionId }, { parentSessionId: privateCanary }]) {
    rejects(() => assertCursorAppNativeSubagent({ ...input, ...change }), "CURSOR_APP_DATABASE_EXPECTED_IDENTITY");
  }
});

function writebackFixture({ sessionId: turnSessionId = sessionId, workspaceName = "project-alpha",
  prompt = "Synthetic prompt\n\u8bb0\u5fc6-42 \u00e9", answer = "Synthetic answer\n\u8bb0\u5fc6-42 \ud83e\uddea",
  scope = "workspace-name.v1" } = {}) {
  const apiKey = "synthetic-private-api-key", baseUserId = "synthetic-user", userId = `${baseUserId}@${workspaceName}`;
  const hash = (text) => digest(text).toString("hex").slice(0, 16);
  const body = {
    messages: [{ role: "user", content: prompt, timestamp: 123 }, { role: "assistant", content: answer, timestamp: 124 }],
    session_id: turnSessionId, user_id: userId,
    metadata: { memorax_code_session_id: turnSessionId, memorax_code_base_user_id: baseUserId,
      memorax_code_workspace: workspaceName, memorax_code_memory_scope: scope,
      idempotency_key: `automatic:cursor:${hash(userId)}:${turnSessionId}:${hash(prompt)}:${hash(answer)}` },
  };
  return { sessionId: turnSessionId, prompt, answer, apiKey, baseUserId, workspaceName, scope,
    requests: [{ method: "POST", path: "/v1/memories/add", authorization: `Token ${apiKey}`, body }] };
}

test("automatic Add preserves exact Unicode content, session, local or Git scope and every idempotency component", () => {
  for (const scope of ["workspace-name.v1", "repository-name.v1"]) {
    const input = writebackFixture({ scope }), before = structuredClone(input);
    assert.deepEqual(assertCursorAppWriteback(input), { automaticAdd: 1 });
    assert.deepEqual(input, before);
    for (const [mutate, suffix] of [
      [(request) => { request.method = "GET"; }, "TRANSPORT"],
      [(request) => { request.path += "?private"; }, "TRANSPORT"],
      [(request) => { request.authorization = "Bearer synthetic-private-api-key"; }, "TRANSPORT"],
      [(request) => { request.body.messages.reverse(); }, "CONTENT"],
      [(request) => { request.body.messages.push({ role: "assistant", content: privateCanary }); }, "CONTENT"],
      [(request) => { request.body.messages[0].role = "system"; }, "CONTENT"],
      [(request) => { request.body.messages[1].role = "tool"; }, "CONTENT"],
      [(request) => { request.body.messages[0].content = input.prompt.normalize("NFD"); }, "CONTENT"],
      [(request) => { request.body.messages[1].content = input.answer.slice(0, -1); }, "CONTENT"],
      [(request) => { request.body.session_id = childId; }, "SESSION"],
      [(request) => { request.body.metadata.memorax_code_session_id = childId; }, "SESSION"],
      [(request) => { request.body.user_id = input.baseUserId; }, "SCOPE"],
      ...["memorax_code_base_user_id", "memorax_code_workspace", "memorax_code_memory_scope"]
        .map((field) => [(request) => { request.body.metadata[field] = privateCanary; }, "SCOPE"]),
    ]) {
      const invalid = structuredClone(input);
      mutate(invalid.requests[0]);
      rejects(() => assertCursorAppWriteback(invalid), `CURSOR_APP_ADD_${suffix}`);
    }
    for (let part = 0; part < 6; part += 1) {
      const invalid = structuredClone(input), metadata = invalid.requests[0].body.metadata;
      const pieces = metadata.idempotency_key.split(":");
      pieces[part] = part === 1 ? "codex" : privateCanary;
      metadata.idempotency_key = pieces.join(":");
      rejects(() => assertCursorAppWriteback(invalid), "CURSOR_APP_ADD_IDEMPOTENCY");
    }
  }
});

test("automatic Add rejects incomplete expectations, extra requests and private unexpected errors", () => {
  const input = writebackFixture();
  for (const field of ["sessionId", "prompt", "answer", "apiKey", "baseUserId", "workspaceName", "scope"]) {
    rejects(() => assertCursorAppWriteback({ ...input, [field]: "" }), "CURSOR_APP_ADD_EXPECTED");
  }
  for (const requests of [[], [...input.requests, input.requests[0]]]) {
    rejects(() => assertCursorAppWriteback({ ...input, requests }), "CURSOR_APP_MEMORY_REQUEST_COUNT");
  }
  Object.defineProperty(input.requests[0], "body", { get() { throw new Error(privateCanary); } });
  rejects(() => assertCursorAppWriteback(input), "CURSOR_APP_ADD_INVALID");
});

test("ordered writebacks reject replay, cross-session and cross-workspace reuse, late Add and invalid later turns", () => {
  const first = writebackFixture();
  const fixtures = [first, writebackFixture({ answer: "Second answer" }),
    writebackFixture({ sessionId: childId, workspaceName: "project-beta" }),
    writebackFixture({ prompt: "Resumed prompt", answer: "Resumed answer" }),
    writebackFixture({ sessionId: generationId, workspaceName: "worker-repository", scope: "repository-name.v1" })];
  const input = { apiKey: first.apiKey, baseUserId: first.baseUserId,
    turns: fixtures.map(({ requests, ...turn }) => turn), requests: fixtures.map((turn) => turn.requests[0]) };
  const before = structuredClone(input);
  assert.deepEqual(assertCursorAppWritebacks(input), { automaticAdd: 5 });
  assert.deepEqual(input, before);
  for (const [mutate, code] of [
    [(value) => { value.requests[1] = value.requests[0]; }, "ADD_CONTENT"],
    [(value) => { [value.requests[0], value.requests[1]] = [value.requests[1], value.requests[0]]; }, "ADD_CONTENT"],
    [(value) => { value.requests[2] = value.requests[0]; }, "ADD_SESSION"],
    [(value) => { value.requests[2].body.metadata.memorax_code_workspace = "project-alpha"; }, "ADD_SCOPE"],
    [(value) => { value.requests[4].body.metadata.memorax_code_memory_scope = "workspace-name.v1"; }, "ADD_SCOPE"],
    [(value) => { value.workspaceName = "project-alpha"; delete value.turns[3].workspaceName; }, "ADD_EXPECTED"],
    [(value) => { value.requests.pop(); }, "MEMORY_REQUEST_COUNT"],
    [(value) => { value.requests.push(value.requests[0]); }, "MEMORY_REQUEST_COUNT"],
    [(value) => { value.turns = []; }, "ADD_EXPECTED"],
  ]) {
    const invalid = structuredClone(input);
    mutate(invalid);
    rejects(() => assertCursorAppWritebacks(invalid), `CURSOR_APP_${code}`);
  }
  Object.defineProperty(input.turns[3], "answer", { get() { throw new Error(privateCanary); } });
  rejects(() => assertCursorAppWritebacks(input), "CURSOR_APP_ADD_INVALID");
});
