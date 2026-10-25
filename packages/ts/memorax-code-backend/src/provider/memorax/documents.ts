import type { RepositoryMemoryScope } from "../../repository/scope.js";
import type { MemoraxAdapterConfig } from "./config.js";
import { requestMemorax, memoraxInvocationFailure } from "./http.js";
import { isRecord } from "../../shared/record.js";

type PreparedDocumentUpload = { file: Blob; filename: string; document_id: string; input_id: string; expected_revision: number; sha256?: string };

export type DocumentReceipt = {
  task_id?: string;
  status: string;
  pending: boolean;
  document_id: string;
  input_id: string;
  expected_revision?: number;
  revision: number | null;
};
export type DocumentOperationResult = { ok: boolean; receipt?: DocumentReceipt; error?: string; errorCode?: string; httpStatus?: number; stage?: "input" | "request" | "response" };

function validScope(config: MemoraxAdapterConfig, scope: RepositoryMemoryScope | undefined): scope is RepositoryMemoryScope {
  return Boolean(scope && scope.baseUserId === config.userId && scope.effectiveUserId.trim());
}

const DOCUMENT_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  INVALID_TEXT_ENCODING: "MemoraX rejected the document: text must use UTF-8 encoding.",
  INVALID_PARSED_DOCUMENT: "MemoraX rejected the document: unsupported binary content or text control characters.",
  EMPTY_PARSED_DOCUMENT: "MemoraX rejected the document: no non-whitespace text was found.",
  PARSED_DOCUMENT_TOO_LARGE: "MemoraX rejected the document: decoded text exceeds the service character limit.",
  INVALID_FILE_FORMAT: "MemoraX rejected the document: the PDF or Office file format is invalid.",
  FILE_TOO_LARGE: "MemoraX rejected the document: the file exceeds the service size limit.",
  ARCHIVE_TOO_LARGE: "MemoraX rejected the document: the Office archive exceeds the service expansion limit.",
  ENCRYPTED_FILE: "MemoraX rejected the document: encrypted files are not supported.",
  EMPTY_FILE: "MemoraX rejected the document: the file is empty.",
  HASH_MISMATCH: "MemoraX rejected the document: its contents do not match the supplied SHA-256.",
};

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
      { method: "POST", body: form, requestId: identity.input_id, errorMessages: DOCUMENT_ERROR_MESSAGES }, fetchImpl);
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
