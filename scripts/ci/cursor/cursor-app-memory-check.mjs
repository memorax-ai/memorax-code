import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { assertSearchResult, assertSkillReferenceContract } from "../codex/codex-native-content-check.mjs";

function check(condition, code) {
  if (!condition) throw Object.assign(new Error(code), { code });
}

export function assertCursorAppSkillReference(text, operation, platform) {
  check(["linux", "darwin", "win32"].includes(platform), "CURSOR_APP_SKILL_REFERENCE");
  try { return assertSkillReferenceContract(text, operation, platform); }
  catch { check(false, "CURSOR_APP_SKILL_REFERENCE"); }
}

// These are the isolated canary's default CLI contracts, not product parsers.
export function assertCursorAppMemoryOperation({ request, result, operation, query, memory, reason,
  sessionId = "memorax-cli", apiKey, baseUserId, workspaceName } = {}) {
  check(["search", "add"].includes(operation), "CURSOR_APP_MEMORY_OPERATION");
  check([apiKey, baseUserId, workspaceName, memory, operation === "search" ? query : reason, sessionId]
    .every((value) => typeof value === "string" && value.trim().length > 0), "CURSOR_APP_MEMORY_FIXTURE");
  check(request?.method === "POST" && request.path === `/v1/memories/${operation}`
    && request.authorization === `Token ${apiKey}`, "CURSOR_APP_MEMORY_TRANSPORT");
  const userId = `${baseUserId}@${workspaceName}`;
  check(result?.baseUserId === baseUserId && result.effectiveUserId === userId
    && result.workspace === workspaceName && result.scopeKind === "local-directory"
    && result.workspaceScope === "bound" && result.workspaceScopeFallbackReason === undefined,
  "CURSOR_APP_MEMORY_RESULT_SCOPE");
  if (operation === "search") {
    check(isDeepStrictEqual(request.body, { query, user_id: userId, top_k: 6, k_dense: 6, k_sparse: 6 }),
      "CURSOR_APP_SEARCH_PAYLOAD");
    try { assertSearchResult(result, { query, memory }); }
    catch { check(false, "CURSOR_APP_SEARCH_RESULT"); }
    return;
  }
  const timestamp = request.body?.timestamp;
  check(Number.isSafeInteger(timestamp) && timestamp > 0, "CURSOR_APP_EXPLICIT_ADD_TIMESTAMP");
  const hash = createHash("sha256").update(`procedural\n${reason}\n${memory}`).digest("hex").slice(0, 16);
  // Trace session variables bind scope but do not change the CLI Add session ID.
  check(isDeepStrictEqual(request.body, {
    messages: [{ role: "user", content: memory, timestamp }],
    user_id: userId, memory_output_language: "zh", content_type: "code", mode: "pre_summarized", session_id: sessionId,
    async_mode: true, timestamp,
    metadata: {
      source: "memorax-code", tags: ["memorax-code"], source_detail: "memorax_code_memory_cli",
      memory_type: "procedural", memorax_code_memory_reason: reason,
      memorax_code_memory_scope: "workspace-name.v1", memorax_code_base_user_id: baseUserId,
      memorax_code_workspace: workspaceName, idempotency_key: `memory-cli:${sessionId}:${hash}`,
      memorax_code_session_id: sessionId,
    },
  }), "CURSOR_APP_EXPLICIT_ADD_PAYLOAD");
  check(result.ok === true && result.action === "memory.add" && result.provider === "memory.memorax"
    && result.receipt?.accepted === true && result.receipt.receipt_id === "memorax:cursor-app-ci-task",
  "CURSOR_APP_EXPLICIT_ADD_RESULT");
}
