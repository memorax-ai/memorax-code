import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TextDecoder } from "node:util";

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

class ContentCheckError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function check(condition, code) {
  if (!condition) throw new ContentCheckError(code);
}

function identity(value) { return typeof value === "string" && value.length === 36 && uuid.test(value); }

function hex(value, code) {
  check(typeof value === "string" && /^(?:[0-9a-f]{2})*$/i.test(value), code);
  return Buffer.from(value, "hex");
}

function stateBytes(value) {
  const code = "CURSOR_APP_DATABASE_STATE_ENCODING";
  check(typeof value === "string", code);
  if (!value.startsWith("~")) return hex(value, code);
  const encoded = value.slice(1);
  check(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded), code);
  const decoded = Buffer.from(encoded, "base64");
  check(decoded.toString("base64") === encoded, code);
  return decoded;
}

// Compare Cursor's persisted bytes with the actual mock transport output, not
// the product parser, UI bubbles, Hook text, or retained traces.
export function assertCursorAppNativeContent(input) {
  let database, failed = false;
  try {
    const { databasePath, sessionId, generationId, conversationStateBytes, kvWrites } = input ?? {};
    check(typeof databasePath === "string" && isAbsolute(databasePath) && !/[\0\r\n]/.test(databasePath),
      "CURSOR_APP_DATABASE_PATH");
    check(identity(sessionId) && identity(generationId), "CURSOR_APP_DATABASE_EXPECTED_IDENTITY");
    check(Buffer.isBuffer(conversationStateBytes) && conversationStateBytes.length > 0,
      "CURSOR_APP_DATABASE_EXPECTED_STATE");
    check(Array.isArray(kvWrites) && kvWrites.length > 0, "CURSOR_APP_DATABASE_EXPECTED_BLOBS");
    const ids = new Set();
    for (const write of kvWrites) {
      check(Buffer.isBuffer(write?.blobId) && write.blobId.length === 32
        && Buffer.isBuffer(write.bytes) && write.bytes.length > 0, "CURSOR_APP_DATABASE_EXPECTED_BLOB");
      check(createHash("sha256").update(write.bytes).digest().equals(write.blobId),
        "CURSOR_APP_DATABASE_EXPECTED_BLOB_HASH");
      const id = write.blobId.toString("hex");
      check(!ids.has(id), "CURSOR_APP_DATABASE_EXPECTED_BLOB_DUPLICATE");
      ids.add(id);
    }

    database = new DatabaseSync(databasePath, { readOnly: true });
    database.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 250; BEGIN");
    const rows = database.prepare("SELECT value FROM cursorDiskKV WHERE key = ? LIMIT 2");
    function row(key, missingCode) {
      const matches = rows.all(key);
      check(matches.length > 0, missingCode);
      check(matches.length === 1, "CURSOR_APP_DATABASE_ROW_AMBIGUOUS");
      return matches[0].value;
    }
    const storedComposer = row(`composerData:${sessionId}`, "CURSOR_APP_DATABASE_COMPOSER_MISSING");
    check(typeof storedComposer === "string" || storedComposer instanceof Uint8Array,
      "CURSOR_APP_DATABASE_COMPOSER_INVALID");
    let composer;
    try {
      composer = JSON.parse(typeof storedComposer === "string" ? storedComposer
        : new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(storedComposer));
    } catch { throw new ContentCheckError("CURSOR_APP_DATABASE_COMPOSER_INVALID"); }
    check(composer && typeof composer === "object" && !Array.isArray(composer), "CURSOR_APP_DATABASE_COMPOSER_INVALID");
    check(composer.composerId === sessionId, "CURSOR_APP_DATABASE_SESSION_MISMATCH");
    check(composer.latestChatGenerationUUID === generationId, "CURSOR_APP_DATABASE_GENERATION_MISMATCH");
    check(stateBytes(composer.conversationState).equals(conversationStateBytes), "CURSOR_APP_DATABASE_STATE_MISMATCH");
    for (const { blobId, bytes } of kvWrites) {
      const stored = row(`agentKv:blob:${blobId.toString("hex")}`, "CURSOR_APP_DATABASE_BLOB_MISSING");
      const decoded = typeof stored === "string" ? hex(stored, "CURSOR_APP_DATABASE_BLOB_ENCODING") : stored;
      check(decoded instanceof Uint8Array, "CURSOR_APP_DATABASE_BLOB_ENCODING");
      check(Buffer.from(decoded).equals(bytes), "CURSOR_APP_DATABASE_BLOB_MISMATCH");
    }
    return { composerMatched: true, stateMatched: true, blobCount: kvWrites.length };
  } catch (error) {
    failed = true;
    if (error instanceof ContentCheckError) throw error;
    throw new ContentCheckError("CURSOR_APP_DATABASE_READ_FAILED");
  } finally {
    try { database?.close(); }
    catch { if (!failed) throw new ContentCheckError("CURSOR_APP_DATABASE_CLOSE_FAILED"); }
  }
}

export function assertCursorAppWriteback(input) {
  try {
    const { requests, sessionId, prompt, answer, apiKey, baseUserId, workspaceName } = input ?? {};
    check(identity(sessionId) && [prompt, answer, apiKey, baseUserId, workspaceName]
      .every((value) => typeof value === "string" && value.trim().length > 0), "CURSOR_APP_ADD_EXPECTED");
    check(Array.isArray(requests) && requests.length === 1, "CURSOR_APP_MEMORY_REQUEST_COUNT");
    const request = requests[0];
    check(request?.method === "POST" && request.path === "/v1/memories/add"
      && request.authorization === `Token ${apiKey}`, "CURSOR_APP_ADD_TRANSPORT");
    const body = request.body, messages = body?.messages;
    check(Array.isArray(messages) && messages.length === 2
      && messages[0]?.role === "user" && messages[0].content === prompt
      && messages[1]?.role === "assistant" && messages[1].content === answer, "CURSOR_APP_ADD_CONTENT");
    const metadata = body.metadata;
    check(body.session_id === sessionId && metadata?.memorax_code_session_id === sessionId, "CURSOR_APP_ADD_SESSION");
    const scopeUserId = `${baseUserId}@${workspaceName}`;
    check(body.user_id === scopeUserId && metadata.memorax_code_base_user_id === baseUserId
      && metadata.memorax_code_workspace === workspaceName
      && metadata.memorax_code_memory_scope === "workspace-name.v1", "CURSOR_APP_ADD_SCOPE");
    const hash = (text) => createHash("sha256").update(text).digest("hex").slice(0, 16);
    check(metadata.idempotency_key === `automatic:cursor:${hash(scopeUserId)}:${sessionId}:${hash(prompt)}:${hash(answer)}`,
      "CURSOR_APP_ADD_IDEMPOTENCY");
    return { automaticAdd: 1 };
  } catch (error) {
    if (error instanceof ContentCheckError) throw error;
    throw new ContentCheckError("CURSOR_APP_ADD_INVALID");
  }
}

export function assertCursorAppWritebacks(input) {
  try {
    const { requests, turns, apiKey, baseUserId, workspaceName } = input ?? {};
    check(Array.isArray(turns) && turns.length > 0, "CURSOR_APP_ADD_EXPECTED");
    check(Array.isArray(requests) && requests.length === turns.length, "CURSOR_APP_MEMORY_REQUEST_COUNT");
    for (let index = 0; index < turns.length; index += 1) {
      const turn = turns[index];
      assertCursorAppWriteback({ requests: [requests[index]], sessionId: turn?.sessionId,
        prompt: turn?.prompt, answer: turn?.answer, apiKey, baseUserId, workspaceName });
    }
    return { automaticAdd: turns.length };
  } catch (error) {
    if (error instanceof ContentCheckError) throw error;
    throw new ContentCheckError("CURSOR_APP_ADD_INVALID");
  }
}
