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
  assert.throws(() => assertCursorAppMemoryOperation(input), { code, message: code });
}

test("Cursor Skill references preserve platform executable names and redact contract errors", () => {
  for (const operation of ["search", "add"]) {
    const reference = `# MemoraX Code Coding Memory ${operation === "search" ? "Search" : "Add"}\n`
      + "On Windows PowerShell, use `memorax-cli.cmd`; on macOS and Linux, use `memorax-cli`.\n"
      + `memorax-cli ${operation} --json\nmemorax-cli.cmd ${operation} --json\n`;
    for (const platform of ["linux", "darwin", "win32"]) {
      assert.equal(assertCursorAppSkillReference(reference, operation, platform),
        platform === "win32" ? "memorax-cli.cmd" : "memorax-cli");
    }
    for (const [text, platform] of [[reference.replaceAll("memorax-cli.cmd", "private-canary"), "linux"],
      [reference, "unknown"]]) {
      assert.throws(() => assertCursorAppSkillReference(text, operation, platform),
        { code: "CURSOR_APP_SKILL_REFERENCE", message: "CURSOR_APP_SKILL_REFERENCE" });
    }
  }
});

test("Search and explicit Add preserve exact payloads, receipts and default or selected CLI session", () => {
  for (const input of [fixture("search"), fixture("add"), fixture("add", "synthetic-native-session")]) {
    assertCursorAppMemoryOperation(input);
  }
  const defaultSession = fixture("add");
  delete defaultSession.sessionId;
  assertCursorAppMemoryOperation(defaultSession);
  const selectedSession = fixture("add", "synthetic-native-session");
  delete selectedSession.sessionId;
  rejects(selectedSession, "CURSOR_APP_EXPLICIT_ADD_PAYLOAD");
});

test("both memory operations require exact transport credentials and bound local workspace result scope", () => {
  for (const operation of ["search", "add"]) {
    for (const change of [{ method: "GET" }, { path: `/v1/memories/${operation}?unexpected=1` },
      { authorization: "Bearer synthetic-secret" }]) {
      const input = fixture(operation);
      Object.assign(input.request, change);
      rejects(input, "CURSOR_APP_MEMORY_TRANSPORT");
    }
    for (const change of [{ baseUserId: "foreign" }, { effectiveUserId: scope.baseUserId }, { workspace: "foreign" },
      { scopeKind: "general" }, { workspaceScope: "unavailable" }, { workspaceScopeFallbackReason: "git_metadata_invalid" }]) {
      const input = fixture(operation);
      Object.assign(input.result, change);
      rejects(input, "CURSOR_APP_MEMORY_RESULT_SCOPE");
    }
  }
});

test("Search rejects truncated or extra request fields and incomplete tool results", () => {
  for (const body of [{ query: query.slice(0, -1) }, { user_id: scope.baseUserId }, { private_path: "/private-canary" }]) {
    const input = fixture("search");
    Object.assign(input.request.body, body);
    rejects(input, "CURSOR_APP_SEARCH_PAYLOAD");
  }
  for (const result of [{ items: [] }, { answer: memory }, { query: "foreign" },
    { receipt: { accepted: false, receipt_id: "memorax:native-search" } }]) {
    const input = fixture("search");
    Object.assign(input.result, result);
    rejects(input, "CURSOR_APP_SEARCH_RESULT");
  }
});

test("Add rejects altered content, automatic metadata, extra fields and invalid timestamps or receipts", () => {
  for (const mutate of [
    (body) => { body.messages[0].content = memory.slice(0, -1); },
    (body) => { body.messages.push({ ...body.messages[0] }); },
    (body) => { body.messages[0].timestamp += 1; },
    (body) => { body.metadata.idempotency_key = "automatic:cursor:foreign"; },
    (body) => { body.metadata.memorax_code_memory_scope = "general.v1"; },
    (body) => { body.private_path = "/private-canary"; },
  ]) {
    const input = fixture("add");
    mutate(input.request.body);
    rejects(input, "CURSOR_APP_EXPLICIT_ADD_PAYLOAD");
  }
  for (const timestamp of [undefined, Infinity, 0, 1.5]) {
    const input = fixture("add");
    input.request.body.timestamp = timestamp;
    rejects(input, "CURSOR_APP_EXPLICIT_ADD_TIMESTAMP");
  }
  const input = fixture("add");
  input.result.receipt.receipt_id = "memorax:native-search";
  rejects(input, "CURSOR_APP_EXPLICIT_ADD_RESULT");
});

test("invalid expectations expose only fixed codes", () => {
  rejects({ ...fixture("search"), operation: "private-canary" }, "CURSOR_APP_MEMORY_OPERATION");
  for (const field of ["apiKey", "baseUserId", "workspaceName", "query", "memory", "sessionId"]) {
    rejects({ ...fixture("search"), [field]: "" }, "CURSOR_APP_MEMORY_FIXTURE");
  }
});
