import { readFileSync } from "node:fs";
import { writeDiagnosticRecord, type DiagnosticWriteResult } from "../../../memorax-code-adapter-common/src/diagnostic-record.mjs";
import type { BackendServiceOptions, BackendServiceResult } from "./contracts.js";
import type { MemoraxCodeLifecycleReport } from "./orchestrator.js";
import { backendServiceHome } from "./lock.js";
import { deploymentFailure, projectDeploymentFailure, type DeploymentFailure } from "../../../memorax-code-adapter-common/src/deployment-failure.mjs";
import { lifecycleAdapterReports, LIFECYCLE_CLIENTS, type LifecycleClientId } from "./client-reports.js";

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
  clientFailures?: ClientDeploymentDiagnostic[];
};

export type ClientDeploymentDiagnostic = {
  client: LifecycleClientId;
  failure: DeploymentFailure & { error: string; impact: string; userAction: string; processState: "running" | "stopped" | "unknown" };
  diagnostic: DiagnosticWriteResult;
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
  const diagnosed = diagnoseBackendReport(report, options);
  if (report.ok || report.action === "uninstall") return diagnosed;
  const clientFailures = lifecycleAdapterReports(report).flatMap(({ client, report: adapter }) => {
    if (adapter.ok !== false) return [];
    const failure = projectDeploymentFailure(adapter.failure)
      ?? projectDeploymentFailure(adapter.pluginInstall?.failure)
      ?? projectDeploymentFailure(adapter.pluginStatus?.failure)
      ?? deploymentFailure(undefined, "deploy", { failureReason: "unknown" });
    const state = report.backend?.processState === "stopped" ? "stopped"
      : report.backend?.ok && report.backend.alreadyRunning !== false
        && (report.action !== "stop" || report.backend.skipped) ? "running" : "unknown";
    return [diagnoseClientDeployment(client.id, failure, report.action, options, state)];
  });
  return clientFailures.length ? { ...diagnosed, clientFailures } : diagnosed;
}

function diagnoseBackendReport(
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

export function diagnoseClientDeployment(
  client: LifecycleClientId,
  evidence: DeploymentFailure,
  action: string,
  options: BackendServiceOptions,
  processState: "running" | "stopped" | "unknown" = "unknown",
): ClientDeploymentDiagnostic {
  const details = projectDeploymentFailure(evidence) ?? deploymentFailure(undefined, "deploy");
  const name = LIFECYCLE_CLIENTS.find((entry) => entry.id === client)!.name;
  const failure = {
    ...details,
    error: `${name}: ${DEPLOYMENT_MESSAGES[details.stage] ?? "client deployment failed."}`,
    processState,
    impact: processState === "running"
      ? `The Backend is running, but ${name} integration did not complete. Some client changes may already be applied.`
      : `${name} integration did not complete. Check Backend and client status before retrying.`,
    userAction: DEPLOYMENT_ACTIONS[details.failureReason ?? ""] ?? (details.failureReason === "not_found"
      ? `Check that ${name} is installed and its runtime can be located, then rerun memorax-code setup.`
      : details.failureReason === "not_runnable"
        ? `Check ${name} executable permissions and runtime availability, then rerun memorax-code setup.`
        : details.failureReason === "timeout"
          ? `Check whether the ${name} command is waiting or stalled, then retry setup after it finishes.`
          : details.cleanupErrorCode
            ? "Preserve existing client files and recovery artifacts; resolve the deployment and cleanup failures before retrying setup."
            : /stage|publish|write|remove/.test(details.stage)
              ? "Check access permissions, available disk space, and the reported filesystem error, then rerun memorax-code setup."
              : `Check the ${name} plugin state and the reported failure, then rerun memorax-code setup.`),
  };
  const diagnostic = writeDiagnosticRecord(backendServiceHome(options), {
    source: "memorax-code", operation: `client.${action}`, client, ...failure,
    version: packageVersion(), runtimeVersion: process.version, platform: process.platform,
  });
  return { client, failure, diagnostic };
}

export function clientDeploymentDiagnosticLines({ client, failure, diagnostic }: ClientDeploymentDiagnostic): string[] {
  return [
    `[${failure.errorCode}] ${client}.${failure.stage}: ${failure.error}`,
    ...([failure.systemCode, failure.failureReason].filter(Boolean).length
      ? [`Cause: ${[failure.systemCode, failure.failureReason].filter(Boolean).join(", ")}`] : []),
    ...(failure.commandExitCode === undefined ? [] : [`Command exit status: ${failure.commandExitCode}`]),
    ...(failure.commandSignal ? [`Command signal: ${failure.commandSignal}`] : []),
    ...(failure.cleanupErrorCode ? [`Cleanup also failed: ${failure.cleanupErrorCode}${failure.cleanupSystemCode ? ` (${failure.cleanupSystemCode})` : ""}`] : []),
    `Impact: ${failure.impact}`, `Next step: ${failure.userAction}`, `Diagnostic: ${diagnostic.id}`,
    diagnostic.recorded ? `Diagnostic file: ${diagnostic.path}`
      : `Diagnostic could not be saved (${diagnostic.recordingError}); keep this error output.`,
  ];
}

const DEPLOYMENT_ACTIONS: Record<string, string> = {
  hook_changed_after_review: "Inspect the current Codex Hooks and review the changed commands before retrying authorization.",
  hook_trust_unverified: "Inspect Codex Hook trust state; authorization was not confirmed after writing configuration.",
  config_version_conflict: "Wait for concurrent Codex configuration edits to finish, then inspect the current configuration and retry Hook authorization.",
  method_unavailable: "Check that the installed Codex version supports the requested plugin configuration operation.",
  user_config_layer_invalid: "Inspect the native Codex user configuration; its base layer could not be validated.",
  base_config_layer_invalid: "Inspect the native Codex base user configuration before retrying Hook authorization.",
  base_config_layer_missing: "Check that Codex exposes its base user configuration before retrying Hook authorization.",
  base_config_layer_ambiguous: "Resolve the multiple base user configuration layers reported by Codex before retrying Hook authorization.",
  hook_metadata_incomplete: "Inspect the Codex plugin and Hook definitions; discovery did not provide the required metadata.",
  hook_identity_mismatch: "Inspect the Codex plugin registration and Hook identity before retrying authorization.",
  hook_discovery_failed: "Inspect the native Codex Hook discovery errors before retrying setup.",
  native_rejected: "Inspect the native Codex command failure before retrying; no specific cause could be established from its safe response fields.",
  stdin_transport: "Check that the Codex app-server runtime can start and accept requests, then retry setup.",
  app_server_exit: "Check why the Codex app-server process exited before retrying setup.",
  app_server_transport: "Check that the Codex app-server runtime is available and communicating, then retry setup.",
};

const DEPLOYMENT_MESSAGES: Record<string, string> = {
  "adapter-load": "the packaged adapter could not be loaded.",
  discover: "client runtime discovery failed.",
  "config-read": "client configuration could not be read.",
  "config-parse": "client configuration could not be parsed.",
  "config-write": "client configuration could not be saved.",
  "state-read": "installation state could not be read.",
  "state-write": "installation state could not be saved.",
  "hooks-read": "Hook configuration could not be read.",
  "hooks-write": "Hook configuration could not be saved.",
  "skill-stage": "the temporary Skill copy could not be prepared.",
  "skill-remove": "the previous Skill directory could not be removed.",
  "skill-publish": "the prepared Skill directory could not be published.",
  "runtime-stage": "the runtime copy could not be prepared.",
  "runtime-publish": "the prepared runtime could not be published.",
  "plugin-stage": "the plugin files could not be prepared.",
  "plugin-publish": "the prepared plugin could not be published.",
  "plugin-register": "the plugin marketplace could not be registered.",
  "plugin-list": "the native plugin list could not be verified.",
  "plugin-install": "the native plugin installation failed.",
  "plugin-enable": "the native plugin could not be enabled.",
  "plugin-disable": "the native plugin could not be disabled.",
  "plugin-remove": "the native plugin could not be removed.",
  "plugin-write": "the plugin loader or registration could not be saved.",
  "helper-write": "the repository helper could not be saved.",
  "native-command": "the native client command failed.",
  "verify-native": "the native client result could not be verified.",
  verify: "the installed integration could not be verified.",
  lock: "client deployment authority could not be acquired or released.",
  cleanup: "deployment cleanup failed.",
};

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
