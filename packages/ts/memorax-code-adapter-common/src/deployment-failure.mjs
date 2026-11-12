const STAGES = new Set([
  "adapter-load", "discover", "config-read", "config-parse", "config-write",
  "state-read", "state-write", "hooks-read", "hooks-write", "skill-stage",
  "skill-remove", "skill-publish", "runtime-stage", "runtime-publish",
  "plugin-stage", "plugin-publish", "plugin-register", "plugin-list",
  "plugin-install", "plugin-enable", "plugin-disable", "plugin-remove",
  "plugin-write", "helper-write", "native-command", "verify-native", "verify",
  "lock", "cleanup", "deploy",
]);
const REASONS = new Set([
  "not_found", "not_runnable", "timeout", "signal", "exit_status",
  "invalid_response", "invalid_record", "conflict", "not_ready", "unknown",
  "activation_required", "missing_source", "unsupported_version",
  "invalid_configuration", "verification_failed",
  "hook_changed_after_review", "hook_trust_unverified", "hook_metadata_incomplete",
  "hook_discovery_failed", "hook_identity_mismatch", "user_config_layer_invalid",
  "base_config_layer_invalid", "base_config_layer_missing", "base_config_layer_ambiguous",
  "config_version_conflict", "method_unavailable", "native_rejected",
  "stdin_transport", "app_server_exit", "app_server_transport",
]);
const SYSTEM_CODES = new Set([
  "EACCES", "EPERM", "ENOENT", "ENOTDIR", "EISDIR", "ENOSPC", "EDQUOT",
  "EROFS", "EMFILE", "ENFILE", "EBUSY", "EEXIST", "EIO", "EINVAL",
  "ENOEXEC", "EAGAIN", "ELOOP", "ENAMETOOLONG", "ENOTEMPTY", "EXDEV",
  "EPIPE", "ETIMEDOUT", "ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN",
]);
const SIGNALS = new Set(["SIGTERM", "SIGKILL", "SIGINT", "SIGABRT"]);

// Only fixed operation metadata crosses the deployment/report boundary. Native
// output, command arguments, paths, and raw exception text stay outside it.
export function deploymentFailure(error, stage, options = {}) {
  if (error instanceof AggregateError && error.code === "JSON_FILE_LOCK_RELEASE_FAILED"
    && error.errors.length === 2 && error.cause === error.errors[0]
    && error.errors[1]?.code === "JSON_FILE_LOCK_RELEASE_FAILED") {
    options = { ...options, cleanupError: options.cleanupError ?? error.errors[1] };
    error = error.errors[0];
  }
  const existing = projectDeploymentFailure(error?.failure);
  const result = existing ?? {
    stage: STAGES.has(stage) ? stage : "deploy",
    errorCode: codeFor(STAGES.has(stage) ? stage : "deploy"),
  };
  const command = options.commandResult;
  const systemCode = systemCodeOf(command?.error ?? error);
  if (!result.systemCode && systemCode) result.systemCode = systemCode;
  const status = command?.status ?? command?.exitCode;
  if (Number.isInteger(status)) result.commandExitCode = status;
  if (SIGNALS.has(command?.signal)) result.commandSignal = command.signal;
  if (!result.failureReason) {
    const reason = REASONS.has(options.failureReason) ? options.failureReason
      : command && systemCode === "ENOENT" ? "not_found"
        : command && ["ENOEXEC", "EACCES", "EPERM"].includes(systemCode) ? "not_runnable"
          : command && systemCode === "ETIMEDOUT" ? "timeout"
            : result.commandSignal ? "signal"
              : Number.isInteger(status) && status !== 0 ? "exit_status" : undefined;
    if (reason) result.failureReason = reason;
  }
  if (options.cleanupError !== undefined) {
    result.cleanupErrorCode = "CLIENT_CLEANUP_FAILED";
    const cleanupCode = systemCodeOf(options.cleanupError);
    if (cleanupCode) result.cleanupSystemCode = cleanupCode;
  }
  return result;
}

export function attachDeploymentFailure(error, stage, options) {
  if (error && typeof error === "object") {
    try { error.failure = deploymentFailure(error, stage, options); } catch { /* Preserve the original thrown value. */ }
  }
  return error;
}

export function projectDeploymentFailure(value) {
  if (!value || !STAGES.has(value.stage) || value.errorCode !== codeFor(value.stage)) return undefined;
  const result = { stage: value.stage, errorCode: value.errorCode };
  if (SYSTEM_CODES.has(value.systemCode)) result.systemCode = value.systemCode;
  if (REASONS.has(value.failureReason)) result.failureReason = value.failureReason;
  if (Number.isInteger(value.commandExitCode)) result.commandExitCode = value.commandExitCode;
  if (SIGNALS.has(value.commandSignal)) result.commandSignal = value.commandSignal;
  if (value.cleanupErrorCode === "CLIENT_CLEANUP_FAILED") {
    result.cleanupErrorCode = value.cleanupErrorCode;
    if (SYSTEM_CODES.has(value.cleanupSystemCode)) result.cleanupSystemCode = value.cleanupSystemCode;
  }
  return result;
}

function codeFor(stage) {
  return `CLIENT_${stage.toUpperCase().replaceAll("-", "_")}_FAILED`;
}

function systemCodeOf(error) {
  const seen = new Set();
  for (let value = error, depth = 0; value && typeof value === "object" && depth < 8; depth += 1) {
    if (seen.has(value)) break;
    seen.add(value);
    if (SYSTEM_CODES.has(value.code)) return value.code;
    value = value.cause;
  }
}
