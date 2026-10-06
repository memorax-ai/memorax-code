import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { isDeepStrictEqual } from "node:util";

const maxBytes = 1024 * 1024, maxEvents = 4096;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const readStatuses = ["present", "absent", "unavailable", "unsafe", "oversized", "invalid"];
const reasons = new Set([
  "database_runtime_unavailable", "database_path_invalid", "database_unavailable", "database_session_missing",
  "database_state_missing", "database_blob_missing", "database_replaced", "database_snapshot_too_large",
  "database_native_format_invalid", "native_generation_pending", "native_turn_pending", "native_final_response_pending",
  "native_prompt_mismatch", "native_turn_ambiguous", "native_turn_replaced", "native_response_ambiguous",
  "native_user_unavailable", "native_turn_unsupported", "native_user_unsupported", "native_step_unsupported",
  "native_continuation_prefix_changed", "native_continuation_replaced", "database_or_workspace_changed",
  "conflicting_stop_events", "conflicting_response_events", "response_digest_invalid", "start_missing",
  "turn_state_unavailable", "workspace_scope_unavailable", "workspace_scope_mismatch", "config_missing",
  "effective_user_id_invalid", "interrupted", "generation_replaced", "already_accepted_locally", "disabled",
  "native_user_simulated", "native_user_steer", "native_user_external_text", "native_user_empty",
  "continuation_user_unbound", "completion_event_missing", "response_digest_missing", "decision_error",
]);
const record = (value) => Boolean(value && typeof value === "object" && !Array.isArray(value));
const enumValue = (value, allowed, missing = "absent") => value === undefined ? missing : allowed.includes(value) ? value : "other";
const count = (value) => Number.isSafeInteger(value) && value >= 0 && value <= maxEvents ? value : 0;
const launchMarkers = {
  sandboxInitializationFailed: /sandbox_(?:init|apply|initialize)\s*[:(]|Failed to initialize sandbox|sandbox::Seatbelt/,
  seatbeltApplyDenied: /sandbox_apply: Operation not permitted\b/,
  helperSandboxInitializationFailed: /Failed to initialize sandbox\./,
  sandboxPolicyDeserializeFailed: /SandboxSerializer: Failed to deserialize policy:/,
  sandboxCompiledPolicyFailed: /SandboxSerializer: Failed to apply compiled policy:/,
  sandboxSourcePolicyFailed: /SandboxSerializer: Failed to initialize sandbox with source mode policy:/,
  sandboxPolicyPermissionDenied: /SandboxSerializer: Failed to (?:deserialize policy|apply compiled policy|initialize sandbox with source mode policy):[^\r\n]{0,256}Operation not permitted(?:\r?\n|$)/,
  sandboxPipeLengthReadFailed: /SeatbeltExec: buffer length read failed(?=:|\r?\n|$)/,
  sandboxPipeBodyReadFailed: /SeatbeltExec: buffer read failed(?=:|\r?\n|$)/,
  processSingletonFailed: /Failed to create a ProcessSingleton|Failed to create.*SingletonSocket/,
  networkServiceCrashed: /Network service crashed/,
  gpuProcessFailed: /GPU process isn't usable|GPU process launch failed/,
  machRegistrationFailed: /bootstrap_(?:check_in|register).*failed/,
  readOnlyFilesystem: /Read-only file system|\bEROFS\b/,
  permissionDenied: /Operation not permitted|Permission denied|\bEACCES\b|\bEPERM\b/,
};

export function projectCursorAppLaunchDiagnostics(value) {
  return {
    spawned: value?.spawned === true, debugEndpointSeen: value?.debugEndpointSeen === true,
    exitCode: Number.isInteger(value?.exitCode) && value.exitCode >= 0 && value.exitCode <= 255 ? value.exitCode : null,
    signal: value?.signal == null ? "none" : enumValue(value.signal,
      ["none", "SIGABRT", "SIGBUS", "SIGILL", "SIGKILL", "SIGSEGV", "SIGTERM", "SIGTRAP", "other"], "none"),
    spawnError: value?.spawnError == null ? "none" : enumValue(value.spawnError,
      ["none", "ENOENT", "EACCES", "ENOEXEC", "other"], "none"),
    markers: Object.fromEntries(Object.keys(launchMarkers).map((key) => [key, value?.markers?.[key] === true])),
  };
}

export function collectCursorAppLaunchDiagnostics(value) {
  const log = typeof value?.log === "string" ? value.log.slice(-maxBytes) : "";
  return projectCursorAppLaunchDiagnostics({ ...value,
    markers: Object.fromEntries(Object.entries(launchMarkers).map(([key, pattern]) => [key, pattern.test(log)])) });
}

const shellCliEnums = {
  errorCode: ["MEMORY_INPUT_INVALID", "MEMORY_INPUT_UNREADABLE", "MEMORY_ADD_DISABLED", "MEMORY_CONFIG_MISSING",
    "MEMORY_SCOPE_UNAVAILABLE", "MEMORY_SCOPE_MISMATCH", "MEMORY_CLI_INTERNAL", "MEMORAX_HTTP_ERROR",
    "MEMORAX_INVALID_JSON", "MEMORAX_TIMEOUT", "MEMORAX_TRANSPORT_ERROR", "MEMORAX_RESPONSE_REJECTED", "MEMORAX_INVALID_RESPONSE"],
  stage: ["input", "configuration", "scope", "request", "response", "internal"],
  systemCode: ["ENOENT", "EACCES", "EPERM", "ENOSPC", "EROFS", "ENOTDIR", "EISDIR", "EMFILE", "ENOTFOUND", "EAI_AGAIN",
    "ECONNREFUSED", "ECONNRESET", "EPIPE", "ENETUNREACH", "EHOSTUNREACH", "ETIMEDOUT", "ESOCKETTIMEDOUT",
    "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET",
    "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID",
    "ERR_TLS_CERT_ALTNAME_INVALID", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
    "ERR_SSL_WRONG_VERSION_NUMBER", "ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE"],
};
const shellOutputMarkers = {
  unsupportedNodeVersion: /memorax-code: MemoraX Code requires Node\.js 20 or newer;/,
  nodeModuleNotFound: /(?:^|\r?\n)(?:Error \[ERR_MODULE_NOT_FOUND\]:|Error: Cannot find module )/,
  commandNotFound: /(?:^|\r?\n)env: (?:memorax-cli|node): No such file or directory(?:\r?\n|$)/,
  permissionDenied: launchMarkers.permissionDenied,
};

function projectShellOutputDiagnostics(value) {
  return {
    stdoutStatus: enumValue(value?.stdoutStatus, ["absent", "present", "invalid", "oversized", "other"]),
    stderrStatus: enumValue(value?.stderrStatus, ["absent", "present", "invalid", "oversized", "other"]),
    cliJson: enumValue(value?.cliJson, ["absent", "valid", "invalid", "oversized", "unmatched", "other"]),
    ...Object.fromEntries(Object.entries(shellCliEnums).map(([key, allowed]) =>
      [key, value?.cliJson === "valid" ? enumValue(value[key], [...allowed, "absent", "other"]) : "absent"])),
    markers: Object.fromEntries(Object.keys(shellOutputMarkers).map((key) => [key, value?.markers?.[key] === true])),
  };
}

export function collectCursorAppShellOutputDiagnostics(value) {
  const read = (part) => {
    if (part === undefined || part?.status === "absent") return { status: "absent" };
    if (["invalid", "oversized"].includes(part?.status)) return { status: part.status };
    if (part?.status !== "present" || typeof part.text !== "string") return { status: "invalid" };
    return Buffer.byteLength(part.text) > 64 * 1024 ? { status: "oversized" } : { status: "present", text: part.text };
  };
  const stdout = read(value?.stdout), stderr = read(value?.stderr);
  let result, cliJson = stdout.status === "present" ? "absent" : stdout.status;
  if (stdout.text?.trim()) {
    try {
      const parsed = JSON.parse(stdout.text);
      if (record(parsed) && parsed.ok === false && ["memory.search", "memory.add"].includes(parsed.action)) {
        result = parsed; cliJson = "valid";
      } else cliJson = "unmatched";
    } catch { cliJson = "invalid"; }
  }
  return projectShellOutputDiagnostics({ stdoutStatus: stdout.status, stderrStatus: stderr.status, cliJson,
    ...Object.fromEntries(Object.keys(shellCliEnums).map((key) => [key, result?.[key]])),
    markers: Object.fromEntries(Object.entries(shellOutputMarkers).map(([key, pattern]) => [key, pattern.test(stderr.text ?? "")])) });
}

export function projectCursorAppShellDiagnostics(value) {
  return {
    rejectionKind: enumValue(value?.rejectionKind, [2, 3, 4, 5, 7, "absent", "other"]),
    approvalClicked: value?.approvalClicked === true,
    ...(value?.rejectionKind === 2 && Number.isInteger(value.exitCode)
      && value.exitCode >= -0x8000_0000 && value.exitCode <= 0x7fff_ffff ? { exitCode: value.exitCode } : {}),
    ...(value?.rejectionKind === 2 && value.output !== undefined ? { output: projectShellOutputDiagnostics(value.output) } : {}),
  };
}

export function collectCursorAppShellDiagnostics(run) {
  const result = run?.execRejection, approval = run?.shellApproval;
  if (run?.error !== "CURSOR_APP_EXEC_REJECTED" || result?.kind !== "shell"
    || typeof result.toolCallId !== "string" || !uuid.test(result.toolCallId)
    || approval?.toolCallId !== result.toolCallId || typeof approval.clicked !== "boolean") return undefined;
  return projectCursorAppShellDiagnostics({ rejectionKind: result.rejectionKind,
    approvalClicked: approval.clicked, exitCode: result.exitCode, output: result.output });
}

const stopBackendEnums = {
  errorCode: ["BACKEND_SERVICE_STATE_READ_FAILED", "BACKEND_SERVICE_STATE_INVALID", "BACKEND_SERVICE_STATE_UNSUPPORTED",
    "BACKEND_OWNERSHIP_UNVERIFIED", "BACKEND_TERMINATE_FAILED", "BACKEND_STOP_TIMEOUT", "BACKEND_SERVICE_STATE_CLEANUP_FAILED"],
  stage: ["read_state", "verify_ownership", "terminate", "wait_stopped", "cleanup_pid"],
  failureReason: ["health_conflict", "process_mismatch", "process_not_found", "process_probe_inconclusive", "invalid_state", "unknown"],
  systemCode: ["EACCES", "EPERM", "ENOENT", "ENOTDIR", "EISDIR", "EROFS", "EBUSY", "EIO", "ENOEXEC", "E2BIG", "ENOMEM",
    "EINVAL", "ENAMETOOLONG", "ELOOP", "ESRCH", "EAGAIN", "ETIMEDOUT", "ECONNREFUSED", "ECONNRESET"],
  processState: ["not-started", "stopped", "running", "unknown"],
};

export function projectCursorAppStopDiagnostics(value) {
  return {
    exitCode: Number.isInteger(value?.exitCode) && value.exitCode >= 0 && value.exitCode <= 255 ? value.exitCode : null,
    signal: value?.signal == null ? "none" : enumValue(value.signal,
      ["none", "SIGABRT", "SIGBUS", "SIGILL", "SIGKILL", "SIGSEGV", "SIGTERM", "SIGTRAP", "other"], "none"),
    timedOut: value?.timedOut === true, outputOverflow: value?.outputOverflow === true,
    jsonStatus: enumValue(value?.jsonStatus, ["absent", "valid", "invalid", "oversized", "other"]),
    actionMatched: value?.actionMatched === true, ok: value?.ok === true,
    backend: { present: value?.backend?.present === true, ok: value?.backend?.ok === true,
      ...Object.fromEntries(Object.entries(stopBackendEnums).map(([key, allowed]) =>
        [key, enumValue(value?.backend?.[key], [...allowed, "absent", "other"])])) },
    cursorAdapter: { present: value?.cursorAdapter?.present === true, ok: value?.cursorAdapter?.ok === true },
  };
}

export function collectCursorAppStopDiagnostics({ stdout, exitCode, signal, timedOut, outputOverflow } = {}) {
  let result, jsonStatus = "absent";
  if (typeof stdout === "string" && stdout.length) {
    if (Buffer.byteLength(stdout) > maxBytes) jsonStatus = "oversized";
    else {
      try { result = JSON.parse(stdout); jsonStatus = record(result) ? "valid" : "invalid"; }
      catch { jsonStatus = "invalid"; }
    }
  }
  const backend = record(result?.backend) ? result.backend : {}, cursorAdapter = record(result?.cursorAdapter) ? result.cursorAdapter : {};
  return projectCursorAppStopDiagnostics({ exitCode, signal, timedOut, outputOverflow, jsonStatus,
    actionMatched: result?.action === "stop", ok: result?.ok === true,
    backend: { ...Object.fromEntries(Object.keys(stopBackendEnums).map((key) => [key, backend[key]])),
      present: record(result?.backend), ok: backend.ok === true },
    cursorAdapter: { present: record(result?.cursorAdapter), ok: cursorAdapter.ok === true } });
}

export function projectCursorAppDiagnostics(value) {
  const store = record(value?.turnStore) ? value.turnStore : {}, trace = record(value?.trace) ? value.trace : {};
  return {
    turnStore: {
      readStatus: readStatuses.includes(store.readStatus) ? store.readStatus : "unavailable",
      versionMatched: store.versionMatched === true, clientMatched: store.clientMatched === true,
      sessionMatched: store.sessionMatched === true, activePresent: store.activePresent === true,
      turnMatched: store.turnMatched === true, state: enumValue(store.state, ["open", "blocked", "interrupted", "accepted", "absent", "other"]),
      stopStatus: enumValue(store.stopStatus, ["completed", "aborted", "error", "absent", "other"]),
      reason: store.reason === undefined || store.reason === "absent" ? "absent" : reasons.has(store.reason) ? store.reason : "other",
      responseDigestPresent: store.responseDigestPresent === true, metadataPresent: store.metadataPresent === true,
      retryUntilPresent: store.retryUntilPresent === true,
    },
    trace: {
      readStatus: readStatuses.includes(trace.readStatus) ? trace.readStatus : "unavailable",
      eventCount: count(trace.eventCount), turnStartCount: count(trace.turnStartCount), completedCount: count(trace.completedCount),
      interruptedCount: count(trace.interruptedCount), materializedCount: count(trace.materializedCount),
    },
  };
}

export function isCursorAppDiagnostics(value) {
  return isDeepStrictEqual(value, projectCursorAppDiagnostics(value));
}

async function readBounded(home, parts) {
  let file;
  try {
    let path = home;
    for (const part of [undefined, ...parts.slice(0, -1)]) {
      if (part !== undefined) path = join(path, part);
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink()) return { readStatus: "unsafe" };
    }
    path = join(path, parts.at(-1));
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink()) return { readStatus: "unsafe" };
    if (before.size > maxBytes) return { readStatus: "oversized" };
    file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const info = await file.stat();
    if (!info.isFile() || info.ino !== before.ino || info.dev !== before.dev) return { readStatus: "unsafe" };
    if (info.size > maxBytes) return { readStatus: "oversized" };
    const bytes = Buffer.alloc(info.size);
    let position = 0;
    while (position < bytes.length) {
      const { bytesRead } = await file.read(bytes, position, bytes.length - position, position);
      if (!bytesRead) return { readStatus: "invalid" };
      position += bytesRead;
    }
    try { return { readStatus: "present", text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) }; }
    catch { return { readStatus: "invalid" }; }
  } catch (error) {
    return { readStatus: error?.code === "ENOENT" ? "absent" : error?.code === "ELOOP" ? "unsafe" : "unavailable" };
  } finally { await file?.close().catch(() => undefined); }
}

export async function collectCursorAppDiagnostics(input) {
  const { home, sessionId, turnId } = input ?? {};
  if (typeof home !== "string" || !isAbsolute(home) || /[\0\r\n]/.test(home)
    || typeof sessionId !== "string" || sessionId.length !== 36 || !uuid.test(sessionId)
    || typeof turnId !== "string" || turnId.length !== 36 || !uuid.test(turnId)) {
    return projectCursorAppDiagnostics({ turnStore: { readStatus: "invalid" }, trace: { readStatus: "invalid" } });
  }
  const hash = createHash("sha256").update(sessionId).digest("hex");
  const stored = await readBounded(home, ["runtime", "cursor", "turns", hash + ".json"]);
  const events = await readBounded(home, ["debug", "traces", "cursor", "sessions", sessionId, "events.jsonl"]);
  let turnStore = { readStatus: stored.readStatus }, trace = { readStatus: events.readStatus };
  if (stored.readStatus === "present") {
    try {
      const value = JSON.parse(stored.text);
      if (!record(value)) throw new Error();
      const active = record(value.active) ? value.active : {};
      turnStore = { readStatus: "present", versionMatched: value.version === 2, clientMatched: value.client === "cursor",
        sessionMatched: value.sessionId === sessionId, activePresent: record(value.active), turnMatched: active.turnId === turnId,
        state: active.state, stopStatus: active.stopStatus, reason: active.reason,
        responseDigestPresent: typeof active.responseDigest === "string" && /^[a-f0-9]{64}$/.test(active.responseDigest),
        metadataPresent: Object.hasOwn(active, "metadata"), retryUntilPresent: Number.isSafeInteger(active.retryUntil) && active.retryUntil >= 0 };
    } catch { turnStore = { readStatus: "invalid" }; }
  }
  if (events.readStatus === "present") {
    try {
      const lines = events.text.split(/\r?\n/).filter((line) => line.trim());
      if (lines.length > maxEvents) trace = { readStatus: "oversized" };
      else {
        const parsed = lines.map(JSON.parse);
        if (!parsed.every(record)) throw new Error();
        const matching = parsed.filter((event) => event.trace?.client === "cursor"
          && event.trace.session_id === sessionId && event.trace.turn_id === turnId);
        trace = { readStatus: "present", eventCount: parsed.length,
          turnStartCount: matching.filter((event) => event.type === "turn_start").length,
          completedCount: matching.filter((event) => event.type === "turn_end" && event.outcome === "completed").length,
          interruptedCount: matching.filter((event) => event.type === "turn_end" && event.outcome === "interrupted").length,
          materializedCount: matching.filter((event) => event.type === "turn_materialized").length };
      }
    } catch { trace = { readStatus: "invalid" }; }
  }
  return projectCursorAppDiagnostics({ turnStore, trace });
}
