import { randomUUID } from "node:crypto";
import { linkSync, readFileSync, rmSync, statSync, unlinkSync } from "node:fs";
import {
  readJsonRuntimeRecord,
  RuntimeRecordError,
  writePrivateJsonRecord,
  type RuntimeRecordWriteResult,
  type RuntimeRecordWriteRuntime,
} from "../../../../memorax-code-adapter-common/src/runtime-record.mjs";

export type BackendServiceState = {
  pid: number;
  instanceId: string;
  host: string;
  port: number;
  url: string;
  logPath: string;
  startedAt: string;
};

export type BackendServiceRecord = BackendServiceState & {
  version: 1;
};

export type BackendServiceRecordInvalidReason =
  | "unreadable"
  | "malformed_json"
  | "invalid_record"
  | "invalid_version"
  | "unknown_fields"
  | "invalid_pid"
  | "missing_instance_id"
  | "invalid_instance_id"
  | "invalid_host"
  | "invalid_port"
  | "invalid_url"
  | "invalid_log_path"
  | "invalid_started_at";

export type BackendServiceRecordState =
  | Readonly<{ status: "absent" }>
  | Readonly<{ status: "valid"; record: BackendServiceRecord }>
  | Readonly<{ status: "invalid"; reason: BackendServiceRecordInvalidReason }>
  | Readonly<{ status: "unsupported"; version: number }>;

export type BackendServiceStateRemovalResult =
  | Readonly<{ disposition: "removed" }>
  | Readonly<{ disposition: "not_owned"; reason: "absent" | "replacement" }>
  | Readonly<{ disposition: "io_failed"; error: string; errorCode?: string }>;

export const BACKEND_SERVICE_RECORD_VERSION = 1;
const BACKEND_SERVICE_RECORD_KEYS = new Set([
  "version",
  "pid",
  "instanceId",
  "host",
  "port",
  "url",
  "logPath",
  "startedAt",
]);
const BACKEND_INSTANCE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export class BackendServiceStateError extends RuntimeRecordError {
  constructor(state: Exclude<BackendServiceRecordState, { status: "valid" }>, path: string) {
    super({
      name: "Backend service state",
      path,
      state,
      codePrefix: "BACKEND_SERVICE_STATE",
      recovery: state.status === "unsupported"
        ? "upgrade MemoraX Code or restore a supported service state record"
        : "confirm that no managed Backend owns the recorded process before removing the state file",
    });
    this.name = "BackendServiceStateError";
  }
}

export function readBackendServiceRecordAtPath(path: string): BackendServiceRecordState {
  const state = readJsonRuntimeRecord(path);
  if (state.status !== "present") return state;
  const value = state.value;
  if (value.version !== BACKEND_SERVICE_RECORD_VERSION) {
    if (Number.isSafeInteger(value.version) && (value.version as number) > 0) {
      return { status: "unsupported", version: value.version as number };
    }
    return { status: "invalid", reason: "invalid_version" };
  }
  if (Object.keys(value).some((key) => !BACKEND_SERVICE_RECORD_KEYS.has(key))) {
    return { status: "invalid", reason: "unknown_fields" };
  }
  if (!Number.isSafeInteger(value.pid) || (value.pid as number) <= 0) {
    return { status: "invalid", reason: "invalid_pid" };
  }
  if (!Object.prototype.hasOwnProperty.call(value, "instanceId")) {
    return { status: "invalid", reason: "missing_instance_id" };
  }
  if (typeof value.instanceId !== "string"
    || !BACKEND_INSTANCE_ID_PATTERN.test(value.instanceId)) {
    return { status: "invalid", reason: "invalid_instance_id" };
  }
  const host = nonEmptyString(value.host);
  if (!host) return { status: "invalid", reason: "invalid_host" };
  if (!Number.isSafeInteger(value.port)
    || (value.port as number) <= 0
    || (value.port as number) > 65535) {
    return { status: "invalid", reason: "invalid_port" };
  }
  const url = backendServiceRecordUrl(value.url, value.port as number);
  if (!url) return { status: "invalid", reason: "invalid_url" };
  const logPath = nonEmptyString(value.logPath);
  if (!logPath) return { status: "invalid", reason: "invalid_log_path" };
  const startedAt = timestampValue(value.startedAt);
  if (!startedAt) return { status: "invalid", reason: "invalid_started_at" };
  return {
    status: "valid",
    record: {
      version: BACKEND_SERVICE_RECORD_VERSION,
      pid: value.pid as number,
      instanceId: value.instanceId,
      host,
      port: value.port as number,
      url,
      logPath,
      startedAt,
    },
  };
}

export function readBackendServiceStateAtPath(path: string): BackendServiceState | undefined {
  const state = readBackendServiceRecordAtPath(path);
  if (state.status === "absent") return undefined;
  if (state.status !== "valid") throw new BackendServiceStateError(state, path);
  const { version: _version, ...serviceState } = state.record;
  return serviceState;
}

export function writeBackendServiceStateAtPath(
  path: string,
  state: BackendServiceState & { instanceId: string },
  durableBoundary: string,
  runtime?: RuntimeRecordWriteRuntime,
): RuntimeRecordWriteResult<BackendServiceRecord> {
  return writePrivateJsonRecord(path, {
    version: BACKEND_SERVICE_RECORD_VERSION,
    ...state,
  }, {
    ...runtime,
    durableBoundary,
  });
}

export function removeBackendServiceStateIfOwnedAtPath(
  path: string,
  expected: Pick<BackendServiceState, "pid" | "instanceId">,
): BackendServiceStateRemovalResult {
  const current = readBackendServiceRecordAtPath(path);
  if (current.status === "absent") {
    return { disposition: "not_owned", reason: "absent" };
  }
  if (current.status === "invalid" && current.reason === "unreadable") {
    return removalIoFailure("failed to read Backend service state");
  }
  if (current.status !== "valid" || !sameServiceInstance(current.record, expected)) {
    return { disposition: "not_owned", reason: "replacement" };
  }
  const claimPath = `${path}.delete-${randomUUID()}`;
  try {
    linkSync(path, claimPath);
  } catch (error) {
    return isMissingPathError(error)
      ? { disposition: "not_owned", reason: "absent" }
      : removalIoFailure("failed to claim Backend service state", error);
  }
  let result: BackendServiceStateRemovalResult;
  try {
    const pathStat = statSync(path);
    const claimStat = statSync(claimPath);
    if (pathStat.dev !== claimStat.dev || pathStat.ino !== claimStat.ino) {
      result = { disposition: "not_owned", reason: "replacement" };
    } else {
      const claimed = readBackendServiceRecordAtPath(claimPath);
      if (claimed.status !== "valid" || !sameServiceInstance(claimed.record, expected)) {
        result = { disposition: "not_owned", reason: "replacement" };
      } else if (readFileSync(path, "utf8") !== readFileSync(claimPath, "utf8")) {
        result = { disposition: "not_owned", reason: "replacement" };
      } else {
        unlinkSync(path);
        result = { disposition: "removed" };
      }
    }
  } catch (error) {
    result = isMissingPathError(error)
      ? { disposition: "not_owned", reason: "absent" }
      : removalIoFailure("failed to remove Backend service state", error);
  }
  try {
    rmSync(claimPath, { force: true });
  } catch (error) {
    return removalIoFailure("failed to remove Backend service state claim", error);
  }
  return result;
}

function sameServiceInstance(
  record: BackendServiceState,
  expected: Pick<BackendServiceState, "pid" | "instanceId">,
): boolean {
  return record.pid === expected.pid && record.instanceId === expected.instanceId;
}

function removalIoFailure(
  message: string,
  error?: unknown,
): Extract<BackendServiceStateRemovalResult, { disposition: "io_failed" }> {
  const detail = error instanceof Error ? error.message : undefined;
  const errorCode = errorCodeOf(error);
  return {
    disposition: "io_failed",
    error: detail ? `${message}: ${detail}` : message,
    ...(errorCode ? { errorCode } : {}),
  };
}

function isMissingPathError(error: unknown): boolean {
  return errorCodeOf(error) === "ENOENT";
}

function errorCodeOf(error: unknown): string | undefined {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && typeof error.code === "string"
    ? error.code
    : undefined;
}

function backendServiceRecordUrl(value: unknown, port: number): string | undefined {
  const candidate = nonEmptyString(value);
  if (!candidate) return undefined;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:"
      || parsed.username
      || parsed.password
      || (parsed.pathname !== "" && parsed.pathname !== "/")
      || parsed.search
      || parsed.hash
      || Number(parsed.port || "80") !== port) return undefined;
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function timestampValue(value: unknown): string | undefined {
  const candidate = nonEmptyString(value);
  return candidate && Number.isFinite(Date.parse(candidate)) ? candidate : undefined;
}
