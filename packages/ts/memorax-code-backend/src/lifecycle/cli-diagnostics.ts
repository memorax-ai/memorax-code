import { readFileSync } from "node:fs";
import { writeDiagnosticRecord, type DiagnosticWriteResult } from "../../../memorax-code-adapter-common/src/diagnostic-record.mjs";
import type { BackendServiceOptions, BackendServiceResult } from "./contracts.js";
import type { MemoraxCodeLifecycleReport } from "./orchestrator.js";
import { backendServiceHome } from "./lock.js";

type LifecycleFailureSummary = {
  errorCode: string;
  stage: string;
  error: string;
  systemCode?: string;
  failureReason?: BackendServiceResult["failureReason"];
  recordReason?: string;
  httpStatus?: number;
  impact: string;
  userAction: string;
  processState: NonNullable<BackendServiceResult["processState"]>;
  cleanupErrorCode?: string;
  cleanupSystemCode?: string;
};

export type LifecycleCliReport = MemoraxCodeLifecycleReport & {
  failure?: LifecycleFailureSummary;
  diagnostic?: DiagnosticWriteResult;
};

const STAGE_MESSAGES: Record<string, string> = {
  lock: "Backend lifecycle authority could not be acquired.",
  resolve_connection: "Backend connection configuration could not be resolved.",
  read_state: "Backend process state could not be read or validated.",
  resolve_token: "Backend authentication configuration could not be used.",
  prepare_runtime: "Backend runtime directory or log could not be prepared.",
  spawn: "Backend process could not be started.",
  persist_pid: "Backend process state could not be saved.",
  health: "Backend did not become ready within the startup deadline.",
  persist_token: "Backend authentication record could not be saved.",
  persist_connection: "Backend connection authority could not be saved.",
  verify_ownership: "Backend process ownership could not be verified.",
  terminate: "The verified Backend process could not be terminated.",
  wait_stopped: "Backend process did not stop within the shutdown deadline.",
  cleanup_pid: "Backend process state could not be removed.",
};

const REASON_MESSAGES: Record<NonNullable<BackendServiceResult["failureReason"]>, string> = {
  http_error: "The health endpoint returned an unsuccessful HTTP status.",
  invalid_response: "The health endpoint returned an invalid response.",
  not_ready: "The health endpoint reported that the Backend was not ready.",
  identity_mismatch: "The health response did not match the expected Backend identity.",
  transport: "The health request failed before a valid response was received.",
  timeout: "The health request timed out.",
  deadline: "The startup deadline expired before a health check could run.",
  health_conflict: "The health response conflicts with the recorded Backend identity.",
  process_mismatch: "The process command does not match the recorded Backend identity.",
  process_not_found: "The recorded process was not found during the ownership check.",
  process_probe_inconclusive: "The process command could not be verified.",
  invalid_state: "The recorded Backend identity is invalid.",
  unknown: "The failure cause could not be determined from the available evidence.",
};

export function diagnoseLifecycleReport(
  report: MemoraxCodeLifecycleReport,
  options: BackendServiceOptions,
): LifecycleCliReport {
  // This boundary owns failed Backend lifecycle operations. Adapter-only
  // failures must keep their client identity and must not become Backend errors.
  const backend = report.backend;
  if (report.ok || report.action === "uninstall" || !backend || backend.ok || backend.skipped) return report;
  const stage = backend.stage ?? "lifecycle";
  const errorCode = backend.errorCode ?? "BACKEND_LIFECYCLE_FAILED";
  const processState = backend.processState ?? "unknown";
  const failure: LifecycleFailureSummary = {
    errorCode,
    stage,
    // Existing reports may include private paths and raw exception text.
    // Persist only fixed summaries and the service's safe machine fields.
    error: errorCode === "BACKEND_LIFECYCLE_LOCK_TIMEOUT"
      ? "Timed out waiting for Backend lifecycle authority."
      : STAGE_MESSAGES[stage] ?? "Backend lifecycle operation failed.",
    ...(backend.systemCode ? { systemCode: backend.systemCode } : {}),
    ...(backend.failureReason ? { failureReason: backend.failureReason } : {}),
    ...(backend.recordReason ? { recordReason: backend.recordReason } : {}),
    ...(backend.httpStatus === undefined ? {} : { httpStatus: backend.httpStatus }),
    processState,
    impact: processState === "not-started"
      ? "No new Backend process was started."
      : processState === "stopped"
        ? "The Backend process is stopped."
        : processState === "running"
          ? "The Backend process remains running; the requested operation did not complete."
          : "Backend readiness or shutdown could not be confirmed; check status before retrying.",
    userAction: recoveryAction(errorCode, stage, backend),
    ...(backend.cleanupErrorCode ? { cleanupErrorCode: backend.cleanupErrorCode } : {}),
    ...(backend.cleanupSystemCode ? { cleanupSystemCode: backend.cleanupSystemCode } : {}),
  };
  const diagnostic = writeDiagnosticRecord(backendServiceHome(options), {
    source: "memorax-code",
    operation: `backend.${report.action}`,
    ...failure,
    version: packageVersion(),
    runtimeVersion: process.version,
    platform: process.platform,
  });
  return { ...report, failure, diagnostic };
}

export function lifecycleDiagnosticLines(report: LifecycleCliReport): string[] {
  const { failure, diagnostic } = report;
  if (!failure || !diagnostic) return [];
  return [
    `[${failure.errorCode}] backend.${report.action} failed (${failure.stage}).`,
    `${failure.error}${failure.systemCode ? ` (${failure.systemCode})` : ""}`,
    ...(failure.failureReason ? [
      `Last observation: ${REASON_MESSAGES[failure.failureReason]}${failure.httpStatus === undefined ? "" : ` (HTTP ${failure.httpStatus})`}`,
    ] : []),
    ...(failure.recordReason ? [`Record validation: ${failure.recordReason}.`] : []),
    ...(failure.cleanupErrorCode ? [
      `Cleanup also failed: ${failure.cleanupErrorCode}${failure.cleanupSystemCode ? ` (${failure.cleanupSystemCode})` : ""}.`,
    ] : []),
    `Impact: ${failure.impact}`,
    `Next step: ${failure.userAction}`,
    `Diagnostic: ${diagnostic.id}`,
    diagnostic.recorded
      ? `Diagnostic file: ${diagnostic.path}`
      : `Diagnostic could not be saved (${diagnostic.recordingError}); keep this error output.`,
  ];
}

function recoveryAction(code: string, stage: string, backend: BackendServiceResult): string {
  if (backend.cleanupErrorCode) return "Run memorax-code status and inspect retained Backend state before retrying. Do not delete process state or force-stop an unverified process.";
  if (code === "BACKEND_LIFECYCLE_LOCK_TIMEOUT") return "Wait for the other lifecycle command to finish, then retry. If it persists, share this diagnostic.";
  if (stage === "lock" || stage === "prepare_runtime") return "Check that the Backend home and runtime directories are writable directories and that log storage is available.";
  if (stage === "resolve_connection") return "Check the Backend connection configuration and any reported authority record. Preserve the record for inspection before repairing it.";
  if (stage === "resolve_token") return "Check the Backend token and external-access configuration; inspect any reported token record before changing it.";
  if (stage === "read_state" || stage === "cleanup_pid") return "Inspect the reported Backend process record and verify process ownership before repairing or removing that record.";
  if (stage === "spawn") return "Check that the Node executable and packaged Backend entrypoint are available and executable.";
  if (stage === "persist_pid" || stage === "persist_token" || stage === "persist_connection") return "Check Backend state directory permissions and free disk space, then verify memorax-code status before retrying.";
  if (stage === "health") return "Check memorax-code status and memorax-code logs for the Backend startup failure; share this diagnostic if the cause is unclear.";
  if (stage === "verify_ownership") return "Verify the recorded process and Backend identity before retrying. Do not force-stop an unverified process.";
  if (stage === "terminate" || stage === "wait_stopped") return "Check memorax-code status and process permissions before retrying stop; retain the Backend process record while it may still be running.";
  return "Run memorax-code status and share this diagnostic with the maintainer.";
}

function packageVersion(): string {
  try {
    const version: unknown = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
    return typeof version === "string" && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version) ? version : "unknown";
  } catch {
    return "unknown";
  }
}
