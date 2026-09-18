import {
  CODING_SESSION_BATCH_MAX_BYTES,
  CODING_SESSION_EVENT,
  type CodingSessionBatch,
} from "../../coding-sessions/contracts.js";
import type { RepositoryMemoryScope } from "../../repository/scope.js";
import { isRecord } from "../../shared/record.js";
import type { MemoraxAdapterConfig } from "./config.js";
import {
  memoraxInvocationFailure,
  postMemoraxJson,
  type MemoraxInvocationFailure,
} from "./http.js";

export async function uploadCodingSessionBatch(
  batch: CodingSessionBatch,
  options: {
    config: MemoraxAdapterConfig;
    repositoryScope: RepositoryMemoryScope;
    fetchImpl?: typeof fetch;
  },
): Promise<{ ok: true } | MemoraxInvocationFailure> {
  const { config, repositoryScope } = options;
  if (!repositoryScope
    || !config.userId.trim()
    || config.userId !== repositoryScope.baseUserId
    || !repositoryScope.effectiveUserId.trim()
    || !repositoryScope.repositorySlug.trim()
    || batch.user_id !== repositoryScope.effectiveUserId) {
    return {
      ok: false,
      error: "Coding Session batch does not match its configured memory scope",
      errorCode: "MEMORAX_CODING_SESSION_SCOPE_MISMATCH",
    };
  }
  if (batch.event !== CODING_SESSION_EVENT
    || !batch.batch_id.trim()
    || !batch.session_id.trim()
    || batch.coding_turns.length === 0
    || batch.coding_turns.some((turn) =>
      turn.client !== batch.client
      || turn.session_id !== batch.session_id
      || !turn.turn_id.trim()
      || (turn.repository_slug !== undefined && turn.repository_slug !== repositoryScope.repositorySlug))) {
    return {
      ok: false,
      error: "Coding Session batch identity is invalid",
      errorCode: "MEMORAX_CODING_SESSION_INVALID_BATCH",
    };
  }

  // Project the event contract rather than forwarding runtime or QA metadata.
  const payload: CodingSessionBatch = {
    event: CODING_SESSION_EVENT,
    batch_id: batch.batch_id,
    user_id: batch.user_id,
    client: batch.client,
    session_id: batch.session_id,
    coding_turns: batch.coding_turns,
  };
  if (Buffer.byteLength(JSON.stringify(payload), "utf8") > CODING_SESSION_BATCH_MAX_BYTES) {
    return {
      ok: false,
      error: "Coding Session batch exceeds its upload byte limit",
      errorCode: "MEMORAX_CODING_SESSION_BATCH_TOO_LARGE",
    };
  }

  try {
    const { body } = await postMemoraxJson(config, "/v1/memories/add", payload, options.fetchImpl ?? fetch);
    const data = isRecord(body) && isRecord(body.data) ? body.data : undefined;
    if (!isRecord(body)
      || body.success !== true
      || data?.event !== CODING_SESSION_EVENT
      || data.batch_id !== batch.batch_id
      || data.status !== "stored") {
      // An ordinary asynchronous Add receipt does not confirm source storage.
      return {
        ok: false,
        error: "MemoraX did not confirm storage of the Coding Session batch",
        errorCode: "MEMORAX_CODING_SESSION_INVALID_RECEIPT",
        errorKind: "response",
      };
    }
    return { ok: true };
  } catch (error) {
    return memoraxInvocationFailure(error);
  }
}
