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

export function runtimeRecordErrorFields(error: unknown): { errorCode?: string } {
  return error instanceof BackendConnectionAuthorityError || error instanceof RuntimeRecordError
    ? { errorCode: error.code }
    : {};
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
