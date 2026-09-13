import { writeDiagnosticRecord } from "./memorax-code-adapter-common/src/diagnostic-record.mjs";
import { deploymentFailure } from "./memorax-code-adapter-common/src/deployment-failure.mjs";

const SYSTEM_CODES = new Set([
  "EACCES", "EPERM", "ENOENT", "ENOTDIR", "EISDIR", "ENOSPC", "EDQUOT", "EROFS",
  "EMFILE", "ENFILE", "EBUSY", "EEXIST", "EIO", "ENOEXEC", "EAGAIN", "ELOOP",
  "ENAMETOOLONG", "ETIMEDOUT", "ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN",
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
  const details = [failure.systemCode, failure.failureReason, failure.credentialReason, failure.recordReason,
    failure.httpStatus === undefined ? undefined : `HTTP ${failure.httpStatus}`].filter(Boolean).join(", ");
  const lines = [
    `[${failure.errorCode}] ${failure.stage}: ${failure.error}${details ? ` (${details})` : ""}`,
    ...(failure.processState ? [`Process state: ${failure.processState}`] : []),
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
