import type { RepositoryMemoryScope } from "../../repository/scope.js";
import type { MemoraxAdapterConfig } from "./config.js";
import { requestMemorax, memoraxInvocationFailure } from "./http.js";
import { isRecord } from "../../shared/record.js";

type PreparedDocumentUpload = { file: Blob; filename: string; document_id: string; input_id: string; expected_revision: number; sha256?: string };

const TASK_STATES = new Set(["queued", "parsing", "indexing", "succeeded", "failed", "submission_unknown"]);
export type DocumentReceipt = {
  task_id?: string;
  status: string;
  pending: boolean;
  document_id: string;
  input_id: string;
  expected_revision?: number;
  revision: number | null;
  summary_state?: string;
};
export type DocumentOperationResult = { ok: boolean; receipt?: DocumentReceipt; error?: string; errorCode?: string; httpStatus?: number; waitTimedOut?: boolean; stage?: "input" | "request" | "response" };

function validScope(config: MemoraxAdapterConfig, scope: RepositoryMemoryScope | undefined): scope is RepositoryMemoryScope {
  return Boolean(scope && scope.baseUserId === config.userId && scope.effectiveUserId.trim());
}

export async function uploadMemoraxDocument(
  config: MemoraxAdapterConfig, scope: RepositoryMemoryScope | undefined, input: PreparedDocumentUpload, fetchImpl: typeof fetch = fetch,
): Promise<DocumentOperationResult> {
  if (!validScope(config, scope)) return { ok: false, error: "Document upload scope is invalid", errorCode: "MEMORY_INPUT_INVALID" };
  const identity = { document_id: input.document_id, input_id: input.input_id.toLowerCase(), expected_revision: input.expected_revision };
  const request = { user_id: scope.effectiveUserId, ...identity,
    ...(input.sha256 ? { sha256: input.sha256 } : {}), memory_output_language: config.memoryOutputLanguage ?? "zh",
    content_type: "document", async_mode: true };
  const form = new FormData();
  form.append("request", JSON.stringify(request));
  form.append("file", input.file, input.filename);
  try {
    const response = await requestMemorax({ ...config, timeoutMs: config.uploadTimeoutMs ?? 300_000 }, "/v1/memories/add",
      { method: "POST", body: form, requestId: identity.input_id }, fetchImpl);
    const data = isRecord(response.body) && isRecord(response.body.data) ? response.body.data : {};
    const validRevision = data.revision === null || (Number.isSafeInteger(data.revision)
      && Number(data.revision) > 0 && data.revision === input.expected_revision + 1);
    if (data.status !== "accepted" || typeof data.task_id !== "string" || !data.task_id.trim()
      || data.document_id !== identity.document_id || typeof data.input_id !== "string"
      || data.input_id.toLowerCase() !== identity.input_id || !validRevision) {
      return { ok: false, error: "Document upload receipt is invalid", errorCode: "MEMORAX_INVALID_RESPONSE",
        receipt: { ...identity, revision: null, status: "submission_unknown", pending: true } };
    }
    return { ok: true, receipt: { ...identity, revision: data.revision as number | null, status: "accepted", pending: true, task_id: data.task_id } };
  } catch (error) {
    const failure = memoraxInvocationFailure(error);
    const uncertain = failure.errorKind !== "http" || (failure.httpStatus ?? 0) >= 500;
    return { ...failure, receipt: { ...identity, revision: null, status: uncertain ? "submission_unknown" : "failed", pending: uncertain } };
  }
}

export async function getMemoraxDocumentStatus(
  config: MemoraxAdapterConfig, scope: RepositoryMemoryScope | undefined, taskId: string, fetchImpl: typeof fetch = fetch,
): Promise<DocumentOperationResult> {
  if (!validScope(config, scope) || !taskId.trim() || taskId.length > 200 || /[\r\n]/.test(taskId)) {
    return { ok: false, error: "Document task and scope are required", errorCode: "MEMORY_INPUT_INVALID" };
  }
  try {
    const { body } = await requestMemorax(config,
      `/v1/memories/add/status/${encodeURIComponent(taskId)}?user_id=${encodeURIComponent(scope.effectiveUserId)}`,
      { method: "GET", direct: true }, fetchImpl);
    if (!isRecord(body) || body.task_id !== taskId || typeof body.status !== "string" || !TASK_STATES.has(body.status)
      || typeof body.document_id !== "string" || !body.document_id.trim() || typeof body.input_id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.input_id)
      || !(body.revision === null || (Number.isSafeInteger(body.revision) && Number(body.revision) >= 1))
      || (body.status === "succeeded" && body.revision === null)) {
      return { ok: false, error: "Document task response is invalid", errorCode: "MEMORAX_INVALID_RESPONSE" };
    }
    const failed = body.status === "failed" || body.status === "submission_unknown";
    const receipt: DocumentReceipt = { task_id: taskId, status: body.status,
      pending: body.status !== "succeeded" && body.status !== "failed", document_id: body.document_id,
      input_id: body.input_id.toLowerCase(), revision: body.revision as number | null,
      ...(typeof body.summary_state === "string" && /^[a-z_]{1,40}$/.test(body.summary_state) ? { summary_state: body.summary_state } : {}) };
    const code = isRecord(body.error) && typeof body.error.code === "string" && /^[A-Z0-9_]{1,64}$/.test(body.error.code) ? body.error.code : "DOCUMENT_TASK_FAILED";
    return { ok: !failed, receipt, ...(failed ? { error: `Document task ${body.status}`, errorCode: code } : {}) };
  } catch (error) { return memoraxInvocationFailure(error); }
}
