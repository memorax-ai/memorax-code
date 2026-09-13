import { writeDiagnosticRecord } from "./memorax-code-adapter-common/src/diagnostic-record.mjs";
import { deploymentFailure } from "./memorax-code-adapter-common/src/deployment-failure.mjs";

const SYSTEM_CODES = new Set([
  "EACCES", "EPERM", "ENOENT", "ENOTDIR", "EISDIR", "ENOSPC", "EDQUOT", "EROFS",
  "EMFILE", "ENFILE", "EBUSY", "EEXIST", "EIO", "ENOEXEC", "EAGAIN", "ELOOP",
  "ENAMETOOLONG", "ETIMEDOUT", "ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN",
  "EPIPE", "ENETUNREACH", "EHOSTUNREACH", "ESOCKETTIMEDOUT", "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT",
  "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID", "ERR_TLS_CERT_ALTNAME_INVALID", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "ERR_SSL_WRONG_VERSION_NUMBER", "ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE",
]);

const FAILURES = {
  runtime: ["runtime-stage", "SETUP_HOOK_RUNTIME_STAGE_FAILED", "The packaged client Hook runtime could not be staged.", "Check the installed package and runtime directory permissions, then retry setup; the previous active runtime remains authoritative."],
  terminal: ["input", "SETUP_TERMINAL_REQUIRED", "Setup requires an interactive terminal.", "Run memorax-code setup in a terminal, or use the documented existing-account stdin mode."],
  lock: ["lock", "SETUP_LOCK_FAILED", "Setup authority could not be acquired or released.", "Check the setup state directory and whether another setup command is running before retrying."],
  authority: ["setup_state", "SETUP_STATE_INVALID", "The existing setup completion record could not be validated.", "Inspect the private setup completion record before repairing it; preserve existing state while a setup command may be running."],
  spawn: ["spawn", "SETUP_PROCESS_FAILED", "The setup process could not be started or completed.", "Check the Node runtime and installed package; retain this diagnostic if the process keeps failing."],
  config: ["config", "SETUP_CONFIG_FAILED", "MemoraX Code config could not be safely updated or verified.", "Check config.toml and its directory permissions; preserve the existing configuration before repairing it."],
  credential: ["credential", "TRIAL_SETUP_FAILED", "Secure MemoraX credential setup failed.", "Check the reported credential or request failure and retry setup with the same local state."],
  start: ["backend_start", "SETUP_BACKEND_START_FAILED", "Backend startup could not be verified during setup.", "Check memorax-code status and memorax-code logs before retrying setup."],
  stop: ["recovery_stop", "SETUP_RECOVERY_STOP_FAILED", "The recovery stop command failed; setup did not start another Backend.", "Check memorax-code status and resolve the stop failure before retrying setup."],
  status: ["status", "SETUP_STATUS_FAILED", "The setup status command failed.", "Run memorax-code status and resolve the reported failure before retrying setup."],
  readiness: ["readiness", "SETUP_NOT_READY", "Backend or required client readiness could not be verified.", "Check the client readiness details from memorax-code status, then retry setup."],
  connection: ["verify_connection", "SETUP_CONNECTION_NOT_READY", "Setup could not verify the saved local MemoraX configuration.", "Check the saved MemoraX configuration, then rerun memorax-code setup. This check does not test network access."],
  saved_key: ["verify_config", "SETUP_API_KEY_MISMATCH", "The saved API key does not match the supplied setup input.", "Check for concurrent configuration changes and rerun existing-account setup."],
  verify_config: ["verify_config", "SETUP_CONFIG_VERIFICATION_FAILED", "The saved configuration could not be read or parsed for verification.", "Check config.toml and concurrent configuration changes before retrying setup."],
  completion: ["completion", "SETUP_COMPLETION_WRITE_FAILED", "Setup completion could not be recorded.", "Check the setup state directory permissions and free space, then rerun setup to verify completion."],
};

export function setupSystemCode(error) {
  const seen = new Set();
  for (let candidate = error, depth = 0; candidate && typeof candidate === "object" && depth < 8; depth += 1) {
    if (seen.has(candidate)) break;
    seen.add(candidate);
    if (SYSTEM_CODES.has(candidate.code)) return candidate.code;
    candidate = candidate.cause;
  }
}

// Details come only from the config/trial safe projections, never command output
// or a raw Error spread. Local Backend failures reuse their existing record below.
export function reportSetupFailure(kind, { home, version, error, details = {}, commandResult, write = console.error }) {
  const [stage, errorCode, summary, userAction] = FAILURES[kind];
  const systemCode = details.systemCode ?? setupSystemCode(error ?? commandResult?.error);
  const fields = {
    source: "memorax-code-setup", operation: "setup", version,
    runtimeVersion: process.version, platform: process.platform,
    errorCode: details.errorCode ?? errorCode,
    stage: details.stage ? `${stage}.${details.stage}` : stage,
    error: summary,
    impact: kind === "completion"
      ? "Backend and clients may already be enabled, but setup completion was not recorded."
      : "Setup remains incomplete; existing changes may need verification before retrying.",
    userAction: credentialAction(details) ?? userAction,
    ...(systemCode ? { systemCode } : {}),
  };
  for (const key of ["failureReason", "credentialReason", "recordReason", "configState", "cleanupErrorCode", "cleanupSystemCode", "httpStatus", "retryAfterMs"]) {
    if (details[key] !== undefined) fields[key] = details[key];
  }
  if (Number.isInteger(commandResult?.status)) fields.commandExitCode = commandResult.status;
  if (["SIGTERM", "SIGKILL", "SIGINT", "SIGABRT"].includes(commandResult?.signal)) fields.commandSignal = commandResult.signal;
  if (kind === "config") {
    fields.impact = {
      preserved: "This operation did not replace the existing configuration.",
      restored: "The previous configuration was restored.",
      removed: "The unverified new configuration was removed.",
      unknown: "Configuration recovery could not be confirmed; preserve any recovery backup before retrying.",
    }[details.configState] ?? fields.impact;
  }
  const diagnostic = writeDiagnosticRecord(home, fields);
  printFailure(fields, diagnostic, write);
  return { failure: fields, diagnostic };
}

export function printSetupBackendDiagnostic(report, write = console.error) {
  const failure = report?.failure;
  const diagnostic = report?.diagnostic;
  if (report?.backend?.ok !== false || !failure || !diagnostic
    || typeof failure.errorCode !== "string" || typeof failure.stage !== "string"
    || typeof failure.error !== "string" || typeof diagnostic.id !== "string") return false;
  printFailure(failure, diagnostic, write);
  return true;
}

export function printSetupClientDiagnostics(report, write = console.error) {
  let printed = false;
  for (const detail of Array.isArray(report?.clientFailures) ? report.clientFailures : []) {
    if (!CLIENTS.has(detail?.client) || typeof detail.failure?.errorCode !== "string"
      || typeof detail.failure?.stage !== "string" || typeof detail.diagnostic?.id !== "string") continue;
    printFailure({ ...detail.failure, client: detail.client }, detail.diagnostic, write);
    printed = true;
  }
  return printed;
}

const CLIENTS = new Set(["codex", "claude", "dsh", "opencode", "codebuddy", "workbuddy", "trae"]);

// The updater consumes this projection over its private child-process channel.
// Never trust free-form summaries or arbitrary metadata from a child message.
export function projectSetupFailure(value) {
  if (value?.source !== "memorax-code-setup" || value.operation !== "setup") return undefined;
  const configStages = ["read", "parse_existing", "transform", "parse_candidate", "prepare_directory", "check_permissions", "write_temp", "backup", "publish", "verify", "cleanup"];
  const credentialStages = ["credential_lock", "credential_load", "identity", "credential_create", "provision", "credential_complete", "retry", "unknown"];
  const credentialCodes = ["TRIAL_SETUP_FAILED", "TRIAL_PROVISION_CLIENT_FAILED", "TRIAL_PROVISION_FLOW_FAILED", "TRIAL_CREDENTIAL_BACKEND_ERROR", "TRIAL_CREDENTIAL_RECORD_INVALID", "JSON_FILE_LOCK_TIMEOUT", "JSON_FILE_LOCK_RELEASE_FAILED"];
  let kind = Object.keys(FAILURES).find((key) => FAILURES[key][0] === value.stage && FAILURES[key][1] === value.errorCode);
  if (configStages.some((stage) => value.stage === `config.${stage}` && value.errorCode === `CONFIG_${stage.toUpperCase()}_FAILED`)) kind = "config";
  if (credentialStages.some((stage) => value.stage === `credential.${stage}`) && credentialCodes.includes(value.errorCode)) kind = "credential";
  if (value.stage === "setup_state" && ["SETUP_COMPLETION_RECORD_INVALID", "SETUP_COMPLETION_RECORD_UNSUPPORTED"].includes(value.errorCode)) kind = "authority";
  if (value.stage === "lock" && ["JSON_FILE_LOCK_TIMEOUT", "JSON_FILE_LOCK_RELEASE_FAILED"].includes(value.errorCode)) kind = "lock";
  if (["command", "invalid_response", "unconfigured", "invalid_json"].some((stage) => value.stage === `verify_connection.${stage}`) && value.errorCode === "SETUP_CONNECTION_NOT_READY") kind = "connection";
  if (["read", "parse"].some((stage) => value.stage === `verify_config.${stage}`) && value.errorCode === "SETUP_CONFIG_VERIFICATION_FAILED") kind = "verify_config";
  if (!kind) return undefined;
  const fields = {
    errorCode: value.errorCode, stage: value.stage, error: FAILURES[kind][2],
    impact: "Setup did not complete; verify the existing Backend and client state before retrying.",
    userAction: FAILURES[kind][3],
  };
  if (SYSTEM_CODES.has(value.systemCode)) fields.systemCode = value.systemCode;
  for (const key of ["recordReason", "failureReason", "credentialReason"]) {
    if (SETUP_REASONS.has(value[key])) fields[key] = value[key];
  }
  if (["preserved", "restored", "removed", "unknown"].includes(value.configState)) fields.configState = value.configState;
  if (Number.isInteger(value.commandExitCode)) fields.commandExitCode = value.commandExitCode;
  if (["SIGTERM", "SIGKILL", "SIGINT", "SIGABRT"].includes(value.commandSignal)) fields.commandSignal = value.commandSignal;
  if (Number.isInteger(value.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599) fields.httpStatus = value.httpStatus;
  if (Number.isFinite(value.retryAfterMs) && value.retryAfterMs >= 0 && value.retryAfterMs <= 3_600_000) fields.retryAfterMs = value.retryAfterMs;
  if (["CONFIG_CLEANUP_FAILED", "CONFIG_ROLLBACK_FAILED", "JSON_FILE_LOCK_RELEASE_FAILED"].includes(value.cleanupErrorCode)) {
    fields.cleanupErrorCode = value.cleanupErrorCode;
    if (SYSTEM_CODES.has(value.cleanupSystemCode)) fields.cleanupSystemCode = value.cleanupSystemCode;
  }
  return fields;
}

const SETUP_REASONS = new Set([
  "unreadable", "malformed_json", "invalid_record", "unknown_fields", "invalid_version", "invalid_state",
  "invalid_completed_at", "invalid_completed_by_version", "not_regular_file", "invalid_toml", "content_mismatch", "type_mismatch", "mode_mismatch", "owner_mismatch",
  "backend_unavailable", "command_failed", "command_timeout", "invalid_namespace", "invalid_response", "invalid_secret", "output_limit", "secret_too_large", "storage_failed", "unsafe_path",
  "missing_fields", "unsupported_version", "invalid_mark_id", "invalid_mark_version", "invalid_app_salt", "invalid_machine_id", "invalid_hostname", "invalid_platform", "invalid_arch", "invalid_mac_hash", "invalid_api_key", "invalid_shape", "invalid_account_id", "invalid_project_id", "invalid_transition",
  "invalid_options", "invalid_credential_state", "identity_generation_failed", "credential_failure", "response_state_mismatch", "client_failure", "retry_failed",
  "transport", "timeout", "aborted", "server_error", "server_rejected", "rate_limit_exceeded", "invalid_request", "invalid_service_url", "tls_unsafe", "response_too_large", "response_contract",
]);

export function reportSetupDeploymentFailure(client, stage, { home, version, error, commandResult, failureReason, write = console.error }) {
  if (!CLIENTS.has(client)) throw new TypeError("Unknown setup client");
  const details = deploymentFailure(error, stage, { commandResult, failureReason });
  const fields = {
    source: "memorax-code-setup", operation: "client.setup", client, ...details,
    version, runtimeVersion: process.version, platform: process.platform,
    error: `${client} integration could not complete the reported deployment step.`,
    impact: "This client integration could not be verified; its existing configuration may require attention.",
    userAction: details.failureReason === "not_found"
      ? "Check that the selected client runtime is installed and discoverable, then retry setup."
      : details.failureReason === "timeout"
        ? "Check whether the client command is waiting or stalled, then retry setup after it finishes."
        : "Check the reported client operation and system error, then rerun memorax-code setup.",
  };
  const diagnostic = writeDiagnosticRecord(home, fields);
  printFailure(fields, diagnostic, write);
  return { failure: fields, diagnostic };
}

function printFailure(failure, diagnostic, write) {
  // An automatic updater has no terminal. Pass the same content-free record
  // identity over its private IPC channel instead of replacing it with an exit code.
  if (process.connected && typeof process.send === "function") {
    try { process.send({ type: "memorax-code-diagnostic", version: 1, fields: failure, diagnostic }, () => {}); } catch { /* The original diagnostic remains available locally. */ }
  }
  const details = [failure.systemCode, failure.failureReason, failure.credentialReason, failure.recordReason,
    failure.httpStatus === undefined ? undefined : `HTTP ${failure.httpStatus}`].filter(Boolean).join(", ");
  const lines = [
    `[${failure.errorCode}] ${failure.stage}: ${failure.error}${details ? ` (${details})` : ""}`,
    ...(failure.processState ? [`Process state: ${failure.processState}`] : []),
    ...(failure.configState ? [`Configuration state: ${failure.configState}`] : []),
    ...(failure.commandExitCode === undefined ? [] : [`Command exit status: ${failure.commandExitCode}`]),
    ...(failure.commandSignal ? [`Command signal: ${failure.commandSignal}`] : []),
    ...(failure.cleanupErrorCode ? [`Cleanup also failed: ${failure.cleanupErrorCode}${failure.cleanupSystemCode ? ` (${failure.cleanupSystemCode})` : ""}`] : []),
    ...(failure.retryAfterMs === undefined ? [] : [`Retry after: ${failure.retryAfterMs} ms`]),
    `Impact: ${failure.impact}`,
    `Next step: ${failure.userAction}`,
    `Diagnostic: ${diagnostic.id}`,
    diagnostic.recorded
      ? `Diagnostic file: ${diagnostic.path}`
      : `Diagnostic could not be saved (${diagnostic.recordingError}); keep this error output.`,
  ];
  for (const line of lines) write(`[MemoraX Code Setup]: ${line}`);
}

function credentialAction(details) {
  if (details.failureReason === "rate_limit_exceeded") return "Wait for the reported retry interval, then rerun setup with the same local state.";
  if (["transport", "timeout", "server_error"].includes(details.failureReason)) return "Check network and proxy availability, then retry setup with the same local state.";
  if (details.stage?.startsWith("credential_")) return "Check the system credential store and its access permissions. Preserve local trial state and retry setup after restoring access.";
  if (details.stage === "identity") return "Check that the operating system provides a stable device identity, then retry setup with the same local state.";
}
