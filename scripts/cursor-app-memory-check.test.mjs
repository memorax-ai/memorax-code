import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { assertCursorAppMemoryOperation, assertCursorAppSkillReference } from "./cursor-app-memory-check.mjs";

const query = "Verify the full \u4e2d\u6587 query.";
const memory = "Preserve exact \u03bb content and the final \u2713.";
const reason = "Keep the verified parser invariant.";
const scope = { apiKey: "synthetic-secret", baseUserId: "synthetic-user", workspaceName: "synthetic workspace" };
const identity = { baseUserId: scope.baseUserId, effectiveUserId: `${scope.baseUserId}@${scope.workspaceName}`,
  workspace: scope.workspaceName, scopeKind: "local-directory", workspaceScope: "bound" };

function fixture(operation, sessionId = "memorax-cli") {
  const timestamp = 1_780_000_000_000;
  const hash = createHash("sha256").update(`procedural\n${reason}\n${memory}`).digest("hex").slice(0, 16);
  return { ...scope, operation, query, memory, reason, sessionId,
    request: { method: "POST", path: `/v1/memories/${operation}`, authorization: `Token ${scope.apiKey}`,
      body: operation === "search" ? { query, user_id: identity.effectiveUserId, top_k: 6, k_dense: 6, k_sparse: 6 }
        : { messages: [{ role: "user", content: memory, timestamp }], user_id: identity.effectiveUserId,
          memory_output_language: "zh", content_type: "code", mode: "pre_summarized", session_id: sessionId, async_mode: true, timestamp,
          metadata: { source: "memorax-code", tags: ["memorax-code"], source_detail: "memorax_code_memory_cli",
            memory_type: "procedural", memorax_code_memory_reason: reason,
            memorax_code_memory_scope: "workspace-name.v1", memorax_code_base_user_id: scope.baseUserId,
            memorax_code_workspace: scope.workspaceName, idempotency_key: `memory-cli:${sessionId}:${hash}`,
            memorax_code_session_id: sessionId } } },
    result: { ...identity, ok: true, action: `memory.${operation}`, provider: "memory.memorax",
      ...(operation === "search" ? { query,
        answer: `<memories>\n  <facts memory_type="procedural">\n   - ${memory}\n  </facts>\n</memories>`,
        items: [{ id: "fixture-memory", memory, score: 0.95, metadata: { memory_type: "procedural" } }] } : {}),
      receipt: { accepted: true, receipt_id: operation === "search" ? "memorax:native-search" : "memorax:cursor-app-ci-task" } },
  };
}

function rejects(input, code) {
  assert.throws(() => assertCursorAppMemoryOperation(input), (error) => error.code === code && error.message === code);
}

function reference(operation) {
  return `# MemoraX Code Coding Memory ${operation === "search" ? "Search" : "Add"}\n`
    + "On Windows PowerShell, use `memorax-cli.cmd`; on macOS and Linux, use `memorax-cli`.\n"
    + `memorax-cli ${operation} --json\nmemorax-cli.cmd ${operation} --json\n`;
}

test("Cursor Skill references preserve POSIX and Windows executable names", () => {
  for (const operation of ["search", "add"]) {
    for (const platform of ["linux", "darwin", "win32"]) {
      assert.equal(assertCursorAppSkillReference(reference(operation), operation, platform),
        platform === "win32" ? "memorax-cli.cmd" : "memorax-cli");
    }
  }
});

test("invalid Skill references expose only the fixed Cursor error", () => {
  for (const text of [undefined, "", reference("add"), reference("search").replaceAll("memorax-cli.cmd", "memorax-cli.ps1")]) {
    assert.throws(() => assertCursorAppSkillReference(text, "search", "linux"),
      { code: "CURSOR_APP_SKILL_REFERENCE", message: "CURSOR_APP_SKILL_REFERENCE" });
  }
  assert.throws(() => assertCursorAppSkillReference(reference("search"), "search", "unknown"),
    { code: "CURSOR_APP_SKILL_REFERENCE" });
});

test("Search checks the complete request, result, receipt and local workspace scope", () => {
  assertCursorAppMemoryOperation(fixture("search"));
});

test("explicit Add preserves the default CLI session separately from native trace identity", () => {
  const input = fixture("add");
  delete input.sessionId;
  assertCursorAppMemoryOperation(input);
});

test("explicitly selected Add session is checked exactly", () => {
  assertCursorAppMemoryOperation(fixture("add", "synthetic-native-session"));
  const input = fixture("add", "synthetic-native-session");
  delete input.sessionId;
  rejects(input, "CURSOR_APP_EXPLICIT_ADD_PAYLOAD");
});

test("memory transport rejects missing requests, wrong operations and leaked credentials", () => {
  for (const operation of ["search", "add"]) {
    for (const mutate of [
      (input) => { delete input.request; },
      (input) => { input.request.method = "GET"; },
      (input) => { input.request.path += "?unexpected=1"; },
      (input) => { input.request.authorization = "Bearer synthetic-secret"; },
    ]) {
      const input = fixture(operation);
      mutate(input);
      rejects(input, "CURSOR_APP_MEMORY_TRANSPORT");
    }
  }
});

test("Search rejects truncated queries, wrong namespace and extra provider fields", () => {
  for (const mutate of [
    (body) => { body.query = query.slice(0, -1); },
    (body) => { body.user_id = scope.baseUserId; },
    (body) => { body.top_k = 5; },
    (body) => { body.k_dense = 0; },
    (body) => { delete body.k_sparse; },
    (body) => { body.session_id = "synthetic-native-session"; },
    (body) => { body.metadata = { client: "cursor" }; },
    (body) => { body.private_path = "/synthetic/private/transcript"; },
  ]) {
    const input = fixture("search");
    mutate(input.request.body);
    rejects(input, "CURSOR_APP_SEARCH_PAYLOAD");
  }
});

test("Search rejects incomplete or foreign tool JSON, items and receipts", () => {
  for (const mutate of [
    (result) => { result.ok = false; },
    (result) => { result.action = "memory.add"; },
    (result) => { result.provider = "memory.foreign"; },
    (result) => { result.query += "foreign"; },
    (result) => { result.answer = result.answer.replace("\u2713", ""); },
    (result) => { result.items = []; },
    (result) => { result.items.push(result.items[0]); },
    (result) => { result.items[0].id = "foreign-memory"; },
    (result) => { result.items[0].memory = memory.slice(0, -1); },
    (result) => { result.items[0].score = 0.9; },
    (result) => { result.items[0].metadata = { type: "procedural" }; },
    (result) => { result.receipt.accepted = false; },
    (result) => { result.receipt.receipt_id = "memorax:foreign"; },
  ]) {
    const input = fixture("search");
    mutate(input.result);
    rejects(input, "CURSOR_APP_SEARCH_RESULT");
  }
});

test("both operation results reject mismatched, general or fallback scope", () => {
  for (const operation of ["search", "add"]) {
    for (const mutate of [
      (result) => { result.baseUserId = "foreign"; },
      (result) => { result.effectiveUserId = scope.baseUserId; },
      (result) => { result.workspace += "other"; },
      (result) => { result.scopeKind = "general"; },
      (result) => { result.workspaceScope = "unavailable"; },
      (result) => { result.workspaceScopeFallbackReason = "git_metadata_invalid"; },
    ]) {
      const input = fixture(operation);
      mutate(input.result);
      rejects(input, "CURSOR_APP_MEMORY_RESULT_SCOPE");
    }
  }
});

test("Add rejects truncated content, incorrect roles and extra messages", () => {
  for (const mutate of [
    (body) => { body.messages = []; },
    (body) => { body.messages.push({ ...body.messages[0] }); },
    (body) => { body.messages[0].content = memory.replace("\u2713", ""); },
    (body) => { body.messages[0].role = "assistant"; },
    (body) => { body.messages[0].timestamp += 1; },
    (body) => { delete body.messages[0].timestamp; },
    (body) => { body.messages[0].private_path = "/synthetic/private/transcript"; },
  ]) {
    const input = fixture("add");
    mutate(input.request.body);
    rejects(input, "CURSOR_APP_EXPLICIT_ADD_PAYLOAD");
  }
});

test("Add rejects automatic metadata, wrong session and wrong scope", () => {
  for (const mutate of [
    (body) => { body.session_id = "synthetic-native-session"; },
    (body) => { body.user_id = scope.baseUserId; },
    (body) => { body.async_mode = false; },
    (body) => { body.memory_output_language = "en"; },
    (body) => { delete body.content_type; },
    (body) => { body.content_type = "dialogue"; },
    (body) => { delete body.mode; },
    (body) => { body.mode = "default"; },
    (body) => { body.metadata.source = "other"; },
    (body) => { body.metadata.tags = []; },
    (body) => { body.metadata.source_detail = "automatic"; },
    (body) => { body.metadata.memory_type = "semantic"; },
    (body) => { body.metadata.memorax_code_memory_reason = reason.slice(0, -1); },
    (body) => { body.metadata.memorax_code_session_id = "foreign"; },
    (body) => { body.metadata.memorax_code_base_user_id = "foreign"; },
    (body) => { body.metadata.memorax_code_workspace = "foreign"; },
    (body) => { body.metadata.memorax_code_memory_scope = "general.v1"; },
    (body) => { body.metadata.idempotency_key = "automatic:cursor:foreign"; },
    (body) => { body.metadata.memorax_code_branch_id = "foreign"; },
  ]) {
    const input = fixture("add");
    mutate(input.request.body);
    rejects(input, "CURSOR_APP_EXPLICIT_ADD_PAYLOAD");
  }
});

test("Add requires a finite integer timestamp", () => {
  for (const timestamp of [undefined, NaN, Infinity, 0, -1, 1.5, "1780000000000"]) {
    const input = fixture("add");
    input.request.body.timestamp = timestamp;
    rejects(input, "CURSOR_APP_EXPLICIT_ADD_TIMESTAMP");
  }
});

test("Add rejects nonaccepted or foreign tool JSON receipts", () => {
  for (const mutate of [
    (result) => { result.ok = false; },
    (result) => { result.action = "memory.search"; },
    (result) => { result.provider = "memory.foreign"; },
    (result) => { delete result.receipt; },
    (result) => { result.receipt.accepted = false; },
    (result) => { result.receipt.receipt_id = "memorax:native-search"; },
  ]) {
    const input = fixture("add");
    mutate(input.result);
    rejects(input, "CURSOR_APP_EXPLICIT_ADD_RESULT");
  }
});

test("invalid expected fixtures fail without exposing raw values", () => {
  const input = fixture("search");
  input.operation = "private-path-or-secret";
  rejects(input, "CURSOR_APP_MEMORY_OPERATION");
  for (const field of ["apiKey", "baseUserId", "workspaceName", "query", "memory", "sessionId"]) {
    const invalid = fixture("search");
    invalid[field] = undefined;
    if (field === "sessionId") invalid[field] = "";
    rejects(invalid, "CURSOR_APP_MEMORY_FIXTURE");
  }
});
