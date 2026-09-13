import {
  removeBackendServiceStateIfOwnedAtPath,
  type BackendServiceState,
} from "./record.js";
import type { BackendServiceResult } from "../contracts.js";
import { backendServiceFailureFields } from "./result.js";

export function clearBackendServiceState(
  path: string,
  state: BackendServiceState,
  action: string,
  prefix = "failed to clear Backend service state",
): BackendServiceResult | undefined {
  const result = removeBackendServiceStateIfOwnedAtPath(path, state);
  if (result.disposition === "removed"
    || (result.disposition === "not_owned" && result.reason === "absent")) {
    return undefined;
  }
  const detail = result.disposition === "io_failed"
    ? result.error
    : "the PID authority was replaced while cleanup was in progress";
  return {
    ok: false,
    action,
    state,
    ...backendServiceFailureFields(
      result.disposition === "io_failed" ? { code: result.errorCode } : undefined,
      "BACKEND_SERVICE_STATE_CLEANUP_FAILED",
      "cleanup_pid",
      "stopped",
    ),
    error: `${prefix}; ${detail}`,
  };
}
