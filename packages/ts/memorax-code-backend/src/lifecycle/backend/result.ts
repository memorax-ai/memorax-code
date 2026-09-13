import { BackendConnectionAuthorityError } from "../../../../memorax-code-adapter-common/src/backend-connection.mjs";
import {
  RuntimeRecordError,
  type RuntimeRecordWriteResult,
} from "../../../../memorax-code-adapter-common/src/runtime-record.mjs";
import type {
  BackendRuntimeRecordKind,
  BackendRuntimeRecordWarning,
  BackendServiceResult,
} from "../contracts.js";

export type {
  BackendRuntimeRecordKind,
  BackendRuntimeRecordWarning,
  BackendServiceResult,
} from "../contracts.js";

export function runtimeRecordServiceFailure(
  action: string,
  error: unknown,
): BackendServiceResult {
  return {
    ok: false,
    action,
    error: error instanceof Error ? error.message : String(error),
    ...runtimeRecordErrorFields(error),
  };
}

const BACKEND_RECORD_FAILURE_REASONS = new Set([
  "unreadable", "malformed_json", "invalid_record", "invalid_version", "unknown_fields",
  "invalid_pid", "missing_instance_id", "invalid_instance_id", "invalid_host", "invalid_port",
  "invalid_url", "invalid_log_path", "invalid_started_at", "invalid_token_path", "invalid_token",
  "invalid_created_at", "invalid_rotated_at",
]);

export function runtimeRecordErrorFields(error: unknown): Pick<BackendServiceResult, "errorCode" | "recordReason"> {
  if (!(error instanceof BackendConnectionAuthorityError) && !(error instanceof RuntimeRecordError)) return {};
  return {
    errorCode: error.code,
    ...(error.reason && BACKEND_RECORD_FAILURE_REASONS.has(error.reason) ? { recordReason: error.reason } : {}),
  };
}

const BACKEND_SYSTEM_ERROR_CODES = new Set([
  "EACCES", "EPERM", "ENOENT", "ENOTDIR", "EISDIR", "ENOSPC", "EDQUOT",
  "EROFS", "EMFILE", "ENFILE", "EBUSY", "EEXIST", "EIO", "ENOEXEC",
  "E2BIG", "ENOMEM", "EINVAL", "ENAMETOOLONG", "ELOOP", "ESRCH",
  "EAGAIN", "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET",
  "ETIMEDOUT", "EPIPE", "ENETUNREACH", "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);

export function backendServiceFailureFields(
  error: unknown,
  fallbackCode: string,
  stage: string,
  processState: NonNullable<BackendServiceResult["processState"]> = "unknown",
): Pick<BackendServiceResult, "errorCode" | "stage" | "systemCode" | "processState" | "recordReason"> {
  const systemCode = backendServiceSystemCode(error);
  const recordFields = runtimeRecordErrorFields(error);
  return {
    ...recordFields,
    errorCode: recordFields.errorCode ?? fallbackCode,
    stage,
    processState,
    ...(systemCode ? { systemCode } : {}),
  };
}

export function backendServicePreflightFailureFields(
  error: unknown,
): ReturnType<typeof backendServiceFailureFields> {
  const fields = backendServiceFailureFields(error, "BACKEND_CONNECTION_RESOLUTION_FAILED", "resolve_connection");
  return fields.errorCode?.startsWith("BACKEND_TOKEN_")
    ? { ...fields, stage: "resolve_token" }
    : fields;
}

export function backendServiceSystemCode(error: unknown): string | undefined {
  const seen = new Set<object>();
  let candidate = error;
  for (let depth = 0; depth < 8; depth += 1) {
    if (typeof candidate !== "object" || candidate === null || seen.has(candidate)) return undefined;
    seen.add(candidate);
    if ("code" in candidate && typeof candidate.code === "string" && BACKEND_SYSTEM_ERROR_CODES.has(candidate.code)) {
      return candidate.code;
    }
    candidate = "cause" in candidate ? candidate.cause : undefined;
  }
  return undefined;
}

export function runtimeRecordDurabilityWarning(
  record: BackendRuntimeRecordKind,
  result: Pick<
    RuntimeRecordWriteResult<unknown>,
    "durability" | "durabilityErrorCode"
  > | undefined,
): BackendRuntimeRecordWarning | undefined {
  if (result?.durability !== "uncertain") return undefined;
  return {
    code: "BACKEND_RUNTIME_RECORD_DURABILITY_UNCERTAIN",
    record,
    ...(result.durabilityErrorCode ? { errorCode: result.durabilityErrorCode } : {}),
    message: `${runtimeRecordLabel(record)} was installed, but crash durability could not be confirmed`,
  };
}

export function withRuntimeRecordWarnings<T extends BackendServiceResult>(
  result: T,
  warnings: BackendRuntimeRecordWarning[],
): T {
  return warnings.length > 0
    ? { ...result, degraded: true, warnings }
    : result;
}

function runtimeRecordLabel(record: BackendRuntimeRecordKind): string {
  if (record === "pid") return "Backend PID record";
  if (record === "token") return "Backend token record";
  return "Backend connection authority";
}
