import { dirname, join, resolve } from "node:path";
import { closeSync, constants, fstatSync, lstatSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { projectSetupFailure } from "./setup-diagnostics.mjs";
import { projectDeploymentFailure } from "./memorax-code-adapter-common/src/deployment-failure.mjs";
import { writeDiagnosticRecord } from "./memorax-code-adapter-common/src/diagnostic-record.mjs";

const STAGES = {
  version_check: "The npm registry version check failed.",
  install: "The npm package installation failed.",
  setup_state: "Setup completion authority could not be validated.",
  reconcile: "The installed package could not complete setup reconciliation.",
  update_lock: "Automatic update authority could not be acquired or released.",
  update_state: "The next automatic update check could not be saved.",
  transition_lock: "Package transition authority could not be acquired or released.",
  transition_read: "The pending package transition could not be validated.",
  transition_write: "Package transition state could not be safely saved.",
  retire: "The old Backend could not be verified as retired.",
  restore: "The installed Backend could not be restored.",
  verify: "The restored Backend could not be verified.",
  consume: "The completed package transition could not be consumed.",
  unknown: "The package update could not be completed.",
};
const CODE_MESSAGES = {
  PACKAGE_TRANSITION_PENDING: "An earlier package transition is still pending.",
  PACKAGE_TRANSITION_NOT_RETIRED: "The old Backend has not completed retirement.",
  PACKAGE_TRANSITION_STALE: "The package transition is outside the unattended restoration window.",
  PACKAGE_TRANSITION_REPLACED: "The package transition changed during the operation.",
  PACKAGE_TRANSITION_PID_REMAINS: "Managed Backend process authority remains after stop.",
  PACKAGE_TRANSITION_DURABILITY_UNCERTAIN: "Package transition state was written, but crash durability could not be confirmed.",
  PACKAGE_TRANSITION_COMMAND_INVALID_JSON: "The Backend command returned invalid JSON.",
  PACKAGE_TRANSITION_COMMAND_NOT_OK: "The Backend command did not report success.",
};
const CODES = new Set([
  "UPDATE_FAILED", "UPDATE_VERSION_CHECK_FAILED", "UPDATE_VERSION_RESPONSE_INVALID",
  "UPDATE_INSTALL_FAILED", "UPDATE_RECONCILE_FAILED", "UPDATE_STATE_WRITE_FAILED",
  "UPDATE_SETUP_STATE_INVALID", "PACKAGE_TRANSITION_FAILED", "PACKAGE_TRANSITION_PENDING",
  "PACKAGE_TRANSITION_DURABILITY_UNCERTAIN", "PACKAGE_TRANSITION_PID_REMAINS",
  "PACKAGE_TRANSITION_REPLACED", "PACKAGE_TRANSITION_NOT_RETIRED", "PACKAGE_TRANSITION_STALE",
  "PACKAGE_TRANSITION_COMMAND_FAILED", "PACKAGE_TRANSITION_COMMAND_INVALID_JSON",
  "PACKAGE_TRANSITION_COMMAND_NOT_OK", "JSON_FILE_LOCK_TIMEOUT", "JSON_FILE_LOCK_RELEASE_FAILED",
  ...["PACKAGE_TRANSITION_RECORD", "SETUP_COMPLETION_RECORD"].flatMap((prefix) =>
    ["INVALID", "UNSUPPORTED", "ABSENT"].map((suffix) => `${prefix}_${suffix}`)),
]);
const SYSTEM_CODES = new Set([
  "E401", "E403", "E404", "E429",
  "EACCES", "EPERM", "ENOENT", "ENOTDIR", "EISDIR", "ENOSPC", "EDQUOT", "EROFS",
  "EMFILE", "ENFILE", "EBUSY", "EEXIST", "EIO", "ENOEXEC", "EAGAIN", "ELOOP",
  "E2BIG", "ENOMEM", "EINVAL", "ESRCH",
  "ENAMETOOLONG", "ETIMEDOUT", "ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN",
  "EPIPE", "ENETUNREACH", "EHOSTUNREACH", "ESOCKETTIMEDOUT", "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT",
  "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID", "ERR_TLS_CERT_ALTNAME_INVALID", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "ERR_SSL_WRONG_VERSION_NUMBER",
]);
const RECORD_REASONS = new Set([
  "unreadable", "malformed_json", "invalid_record", "invalid_version", "invalid_state",
  "unknown_fields", "unknown_or_missing_fields", "invalid_transition_id", "invalid_started_at",
  "invalid_source_version", "invalid_retired_at", "invalid_completed_at", "invalid_completed_by_version",
  "invalid_pid", "missing_instance_id", "invalid_instance_id", "invalid_host", "invalid_port",
  "invalid_url", "invalid_log_path", "invalid_token_path", "invalid_token", "invalid_created_at", "invalid_rotated_at",
]);
const FAILURE_REASONS = new Set([
  "invalid_response", "invalid_version", "missing_entrypoint", "setup_mismatch",
  "http_error", "not_ready", "identity_mismatch", "transport", "timeout", "deadline",
  "health_conflict", "process_mismatch", "process_not_found", "process_probe_inconclusive",
  "invalid_state", "unknown",
]);
const SIGNALS = new Set(["SIGTERM", "SIGKILL", "SIGINT", "SIGABRT", "SIGHUP"]);
const BACKEND_STAGES = new Set([
  "lock", "resolve_connection", "read_state", "resolve_token", "prepare_runtime", "spawn",
  "persist_pid", "health", "persist_token", "persist_connection", "verify_ownership",
  "terminate", "wait_stopped", "cleanup_pid", "lifecycle",
]);
const BACKEND_CODES = new Set([
  "BACKEND_LIFECYCLE_FAILED", "BACKEND_LIFECYCLE_LOCK_TIMEOUT", "BACKEND_LIFECYCLE_LOCK_FAILED",
  "BACKEND_CONNECTION_RESOLUTION_FAILED", "BACKEND_TOKEN_CONFIG_FAILED", "BACKEND_SERVICE_PREPARE_FAILED",
  "BACKEND_SPAWN_FAILED", "BACKEND_SPAWN_PID_MISSING", "BACKEND_SERVICE_STATE_READ_FAILED",
  "BACKEND_SERVICE_STATE_WRITE_FAILED", "BACKEND_SERVICE_STATE_CLEANUP_FAILED", "BACKEND_TOKEN_WRITE_FAILED",
  "BACKEND_HEALTH_NOT_READY", "BACKEND_CONNECTION_WRITE_FAILED", "BACKEND_OWNERSHIP_UNVERIFIED",
  "BACKEND_TERMINATE_FAILED", "BACKEND_STOP_TIMEOUT",
  ...["BACKEND_CONNECTION_AUTHORITY", "BACKEND_SERVICE_STATE", "BACKEND_PID_RECORD", "BACKEND_TOKEN_RECORD"].flatMap((prefix) =>
    ["INVALID", "UNSUPPORTED", "ABSENT"].map((suffix) => `${prefix}_${suffix}`)),
]);
const OPERATIONS = new Set(["update", "update.automatic", "update.recover", "install.retire", "install.restore"]);
const RELAY_PATH = "MEMORAX_CODE_UPDATE_DIAGNOSTIC_PATH";
const RELAY_NONCE = "MEMORAX_CODE_UPDATE_DIAGNOSTIC_NONCE";
const RELAY_MAX_BYTES = 256 * 1024;

export class UpdateFailure extends Error {
  constructor(code, stage, fields = {}) {
    const safeStage = Object.hasOwn(STAGES, stage) ? stage : "unknown";
    super(Object.hasOwn(CODE_MESSAGES, code) ? CODE_MESSAGES[code] : STAGES[safeStage]);
    this.name = "UpdateFailure";
    this.code = CODES.has(code) ? code : "UPDATE_FAILED";
    this.stage = safeStage;
    const error = fields.error;
    const command = fields.commandResult ?? error?.command;
    const systemCode = systemErrorCode(error) ?? systemErrorCode(command?.error)
      ?? (SYSTEM_CODES.has(fields.systemCode) ? fields.systemCode : undefined);
    if (systemCode) this.systemCode = systemCode;
    if (Number.isInteger(fields.httpStatus) && fields.httpStatus >= 100 && fields.httpStatus <= 599) this.httpStatus = fields.httpStatus;
    const recordReason = fields.recordReason ?? error?.reason;
    if (RECORD_REASONS.has(recordReason)) this.recordReason = recordReason;
    if (FAILURE_REASONS.has(fields.failureReason)) this.failureReason = fields.failureReason;
    const exitCode = command?.exitCode ?? command?.status;
    if (Number.isInteger(exitCode) && exitCode >= 0 && exitCode <= 255) this.commandExitCode = exitCode;
    if (SIGNALS.has(command?.signal)) this.commandSignal = command.signal;
    const children = lifecycleDiagnostics(command);
    if (children.length) this.children = children;
  }
}

export function updateFailure(error, code, stage, fields = {}) {
  if (error instanceof UpdateFailure) return error;
  if (error instanceof AggregateError && error.code === "JSON_FILE_LOCK_RELEASE_FAILED"
    && error.errors.length === 2 && error.cause === error.errors[0] && error.cause !== error
    && error.errors[1]?.code === "JSON_FILE_LOCK_RELEASE_FAILED") {
    const primary = updateFailure(error.errors[0], code, stage, fields);
    // Keep the first follow-up failure if state persistence also failed.
    primary.recovery ??= updateFailure(error.errors[1], "UPDATE_FAILED", fields.lockStage ?? stage);
    return primary;
  }
  return new UpdateFailure(CODES.has(error?.code) ? error.code : code, stage, { ...fields, error });
}

export function reportUpdateFailure(error, { home, version, operation = "update", stage = "unknown", code = "UPDATE_FAILED", write = console.error } = {}) {
  const failure = updateFailure(error, code, stage);
  if (failure.children?.length) {
    // The local lifecycle command already recorded these failures. Derive
    // paths from the authorized home, never from command output.
    for (const { fields, diagnostic } of failure.children) {
      printFailure(fields, { ...diagnostic, ...(diagnostic.recorded ? { path: join(resolve(home), "runtime", "diagnostics", `${diagnostic.id}.json`) } : {}) }, write);
      relayUpdateDiagnostic({ fields, diagnostic });
    }
    if (failure.recovery) reportUpdateFailure(failure.recovery, { home, version, operation, write });
    return { children: failure.children };
  }
  const fields = updateFailureFields(failure, version ?? packageVersion(), operation);
  const diagnostic = writeDiagnosticRecord(home, fields);
  printFailure(fields, diagnostic, write);
  relayUpdateDiagnostic({ fields, diagnostic });
  return { failure: fields, diagnostic };
}

function updateFailureFields(failure, version, operation) {
  const fields = {
    source: "memorax-code-update",
    operation: OPERATIONS.has(operation) ? operation : "update",
    version: typeof version === "string" && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version) ? version : "unknown",
    runtimeVersion: process.version, platform: process.platform,
    errorCode: failure.code, stage: failure.stage, error: CODE_MESSAGES[failure.code] ?? STAGES[failure.stage],
    impact: ["version_check", "setup_state"].includes(failure.stage)
      ? "This check did not install a replacement package."
      : "Package or Backend changes may already have occurred; verify local state before retrying.",
    userAction: [401, 403].includes(failure.httpStatus)
      ? "Check npm registry authentication and package access, then retry the update."
      : failure.httpStatus === 429 ? "Wait before retrying the npm registry request."
        : failure.stage === "version_check"
      ? "Check npm registry access and configuration, then retry the update."
      : "Run memorax-code status. Inspect any pending package transition before retrying or running memorax-code update --recover.",
  };
  for (const key of ["systemCode", "recordReason", "failureReason", "commandExitCode", "commandSignal", "httpStatus"]) {
    if (failure[key] !== undefined) fields[key] = failure[key];
  }
  if (failure.recovery instanceof UpdateFailure) {
    fields.recoveryErrorCode = failure.recovery.code;
    fields.recoveryStage = failure.recovery.stage;
    if (failure.recovery.systemCode) fields.recoverySystemCode = failure.recovery.systemCode;
  }
  return fields;
}

// npm does not forward an IPC channel to lifecycle hooks. A private, bounded
// per-invocation relay carries only projected diagnostics, never process output.
export async function runUpdateInstallWithDiagnostics(run, env = process.env) {
  let directory;
  let fd;
  let nonce;
  const childEnv = { ...env };
  delete childEnv[RELAY_PATH];
  delete childEnv[RELAY_NONCE];
  try {
    nonce = randomBytes(32).toString("hex");
    directory = mkdtempSync(join(tmpdir(), "memorax-code-update-diagnostics-"));
    const path = join(directory, "diagnostics.jsonl");
    fd = openSync(path, "wx+", 0o600);
    writeSync(fd, `${JSON.stringify({ version: 1, nonce })}\n`);
    childEnv[RELAY_PATH] = path;
    childEnv[RELAY_NONCE] = nonce;
  } catch {
    // A reporting channel failure must not prevent the requested npm command.
  }
  const children = () => {
    try {
      const lines = readRelay(fd, nonce);
      const found = new Map();
      for (const line of lines.slice(1, 65)) {
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.nonce !== nonce) continue;
        const projected = projectUpdateDiagnosticMessage(message);
        if (projected && found.size < 32 && !found.has(projected.diagnostic.id)) found.set(projected.diagnostic.id, projected);
      }
      return [...found.values()];
    } catch { return []; }
  };
  try {
    const result = await run(childEnv);
    if (result.exitCode === 0) return { result };
    const failure = new UpdateFailure("UPDATE_INSTALL_FAILED", "install", { commandResult: result });
    const recorded = children();
    if (recorded.length) failure.children = recorded;
    return { result, failure };
  } catch (error) {
    const failure = updateFailure(error, "UPDATE_INSTALL_FAILED", "install");
    const recorded = children();
    if (recorded.length) failure.children = recorded;
    throw failure;
  } finally {
    try { if (fd !== undefined) closeSync(fd); } catch {}
    try { if (directory) rmSync(directory, { recursive: true, force: true }); } catch {}
  }
}

function readRelay(fd, nonce) {
  const stat = fstatSync(fd);
  if (!stat.isFile() || stat.size > RELAY_MAX_BYTES
    || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)
    || (typeof process.getuid === "function" && stat.uid !== process.getuid())) throw new Error("invalid relay");
  const buffer = Buffer.alloc(stat.size);
  const length = readSync(fd, buffer, 0, buffer.length, 0);
  const lines = buffer.subarray(0, length).toString("utf8").split("\n");
  const header = JSON.parse(lines[0]);
  if (header.version !== 1 || header.nonce !== nonce) throw new Error("invalid relay");
  return lines;
}

function relayUpdateDiagnostic({ fields, diagnostic }) {
  const path = process.env[RELAY_PATH];
  const nonce = process.env[RELAY_NONCE];
  if (!path || !/^[a-f0-9]{64}$/.test(nonce ?? "")) return;
  let fd;
  try {
    const projected = projectUpdateDiagnosticMessage({ type: "memorax-code-diagnostic", version: 1, fields, diagnostic });
    if (!projected) return;
    const line = `${JSON.stringify({ type: "memorax-code-diagnostic", version: 1, nonce, ...projected })}\n`;
    if (Buffer.byteLength(line) > 8192) return;
    const directory = lstatSync(dirname(path));
    const file = lstatSync(path);
    if (!directory.isDirectory() || !file.isFile()
      || (process.platform !== "win32" && (directory.mode & 0o077) !== 0)
      || (typeof process.getuid === "function" && directory.uid !== process.getuid())) return;
    fd = openSync(path, constants.O_RDWR | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd);
    if (opened.ino !== file.ino || opened.dev !== file.dev) return;
    readRelay(fd, nonce);
    if (fstatSync(fd).size + Buffer.byteLength(line) <= RELAY_MAX_BYTES) writeSync(fd, line);
  } catch {
    // The original diagnostic and command outcome remain authoritative.
  } finally {
    try { if (fd !== undefined) closeSync(fd); } catch {}
  }
}

function printFailure(fields, diagnostic, write) {
  const detail = [fields.systemCode, fields.recordReason, fields.failureReason, fields.credentialReason,
    fields.httpStatus === undefined ? undefined : `HTTP ${fields.httpStatus}`].filter(Boolean).join(", ");
  write(`[MemoraX Code Update]: [${fields.errorCode}] ${fields.client ? `${fields.client}.` : ""}${fields.stage}: ${fields.error}${detail ? ` (${detail})` : ""}`);
  if (fields.commandExitCode !== undefined) write(`Command exit status: ${fields.commandExitCode}`);
  if (fields.commandSignal) write(`Command signal: ${fields.commandSignal}`);
  if (fields.processState) write(`Process state: ${fields.processState}`);
  if (fields.configState) write(`Configuration state: ${fields.configState}`);
  if (fields.retryAfterMs !== undefined) write(`Retry after: ${fields.retryAfterMs} ms`);
  if (fields.cleanupErrorCode) write(`Cleanup also failed: ${fields.cleanupErrorCode}${fields.cleanupSystemCode ? ` (${fields.cleanupSystemCode})` : ""}`);
  if (fields.recoveryErrorCode) write(`Follow-up also failed: [${fields.recoveryErrorCode}] ${fields.recoveryStage}${fields.recoverySystemCode ? ` (${fields.recoverySystemCode})` : ""}`);
  write(`Impact: ${fields.impact}`);
  write(`Next step: ${fields.userAction}`);
  write(`Diagnostic: ${diagnostic.id}`);
  write(diagnostic.recorded ? `Diagnostic file: ${diagnostic.path}`
    : `Diagnostic could not be saved (${diagnostic.recordingError}); keep this error output.`);
}

export function npmRegistryFailureFields(stdout) {
  let body;
  try { body = JSON.parse(String(stdout ?? "")); } catch { return {}; }
  const code = body?.error?.code;
  if (!SYSTEM_CODES.has(code)) return {};
  const httpStatus = { E401: 401, E403: 403, E404: 404, E429: 429 }[code];
  return { systemCode: code, ...(httpStatus ? { httpStatus } : {}) };
}

function systemErrorCode(error) {
  const pending = [error];
  const seen = new Set();
  for (let i = 0; i < pending.length && i < 8; i += 1) {
    const item = pending[i];
    if (!item || typeof item !== "object" || seen.has(item)) continue;
    seen.add(item);
    if (SYSTEM_CODES.has(item.code)) return item.code;
    if (item.cause) pending.push(item.cause);
    if (Array.isArray(item.errors)) pending.push(...item.errors.slice(0, 8));
  }
}

export function projectUpdateDiagnosticMessage(message) {
  if (message?.type !== "memorax-code-diagnostic" || message.version !== 1) return undefined;
  const diagnostic = projectDiagnostic(message.diagnostic);
  if (!diagnostic) return undefined;
  const fields = projectSetupFailure(message.fields);
  if (fields) return { fields, diagnostic };
  const value = message.fields;
  if (value?.source === "memorax-code-update" && OPERATIONS.has(value.operation)
    && CODES.has(value.errorCode) && Object.hasOwn(STAGES, value.stage)) {
    const failure = new UpdateFailure(value.errorCode, value.stage, {
      systemCode: value.systemCode, recordReason: value.recordReason,
      failureReason: value.failureReason, httpStatus: value.httpStatus,
      commandResult: { exitCode: value.commandExitCode, signal: value.commandSignal },
    });
    if (CODES.has(value.recoveryErrorCode) && Object.hasOwn(STAGES, value.recoveryStage)) {
      failure.recovery = new UpdateFailure(value.recoveryErrorCode, value.recoveryStage, { systemCode: value.recoverySystemCode });
    }
    return { fields: updateFailureFields(failure, value.version, value.operation), diagnostic };
  }
  const report = message.fields?.client
    ? { clientFailures: [{ client: message.fields.client, failure: message.fields, diagnostic }] }
    : { backend: { ok: false }, failure: message.fields, diagnostic };
  return lifecycleDiagnostics({ stdout: JSON.stringify(report) })[0];
}

function lifecycleDiagnostics(command) {
  const backend = backendDiagnostic(command);
  const children = backend ? [backend] : [];
  let report;
  try { report = JSON.parse(String(command?.stdout ?? "")); } catch { return children; }
  const clients = new Set(["codex", "claude", "opencode", "codebuddy", "workbuddy", "trae", "dsh"]);
  for (const entry of Array.isArray(report?.clientFailures) ? report.clientFailures.slice(0, 7) : []) {
    const projected = projectDeploymentFailure(entry?.failure);
    const diagnostic = projectDiagnostic(entry?.diagnostic);
    if (!clients.has(entry?.client) || !projected || !diagnostic) continue;
    const fields = { ...projected, client: entry.client,
      error: "Client deployment did not complete.",
      impact: "Some client changes may already be applied; Backend and client state need verification.",
      userAction: "Inspect the original client diagnostic and rerun memorax-code setup after resolving the deployment failure.",
    };
    if (["running", "stopped", "unknown"].includes(entry.failure.processState)) fields.processState = entry.failure.processState;
    children.push({ fields, diagnostic });
  }
  return children;
}

function projectDiagnostic(value) {
  if (!/^mc-\d{13}-[a-f0-9-]{36}$/.test(value?.id ?? "") || typeof value.recorded !== "boolean") return undefined;
  return { id: value.id, recorded: value.recorded,
    ...(!value.recorded ? { recordingError: SYSTEM_CODES.has(value.recordingError) ? value.recordingError : "DIAGNOSTIC_WRITE_FAILED" } : {}) };
}

function packageVersion() {
  try { return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version; }
  catch { return "unknown"; }
}

function backendDiagnostic(command) {
  let report;
  try { report = JSON.parse(String(command?.stdout ?? "")); } catch { return undefined; }
  const failure = report?.failure;
  const diagnostic = projectDiagnostic(report?.diagnostic);
  if (report?.backend?.ok !== false || !BACKEND_CODES.has(failure?.errorCode)
    || !BACKEND_STAGES.has(failure?.stage) || !diagnostic) return undefined;
  const fields = {
    errorCode: failure.errorCode, stage: failure.stage,
    error: "The Backend lifecycle operation failed.",
    impact: "The requested Backend transition did not complete.",
    userAction: "Run memorax-code status and inspect the original Backend diagnostic before retrying.",
  };
  if (SYSTEM_CODES.has(failure.systemCode)) fields.systemCode = failure.systemCode;
  if (FAILURE_REASONS.has(failure.failureReason)) fields.failureReason = failure.failureReason;
  if (RECORD_REASONS.has(failure.recordReason)) fields.recordReason = failure.recordReason;
  if (["not-started", "stopped", "running", "unknown"].includes(failure.processState)) fields.processState = failure.processState;
  if (Number.isInteger(failure.httpStatus) && failure.httpStatus >= 100 && failure.httpStatus <= 599) fields.httpStatus = failure.httpStatus;
  if (BACKEND_CODES.has(failure.cleanupErrorCode)) fields.cleanupErrorCode = failure.cleanupErrorCode;
  if (SYSTEM_CODES.has(failure.cleanupSystemCode)) fields.cleanupSystemCode = failure.cleanupSystemCode;
  return { fields, diagnostic };
}
