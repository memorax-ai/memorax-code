import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeDiagnosticRecord } from "../diagnostic-record.mjs";

const FAILURES = {
  HOOK_RUNTIME_FAILED: ["runtime", "The client Hook runtime could not be loaded or executed.", "This Hook did not complete.", "Run memorax-code status and repair the client installation if the failure persists."],
  HOOK_BACKEND_CONNECTION_INVALID: ["configuration", "The Hook Backend connection could not be resolved.", "The Hook could not recover the Backend.", "Run memorax-code status and check the Backend connection configuration."],
  HOOK_BACKEND_START_TIMEOUT: ["recovery", "The Hook Backend recovery command timed out.", "Backend availability could not be confirmed before the recovery deadline.", "Run memorax-code status before attempting another recovery."],
  HOOK_BACKEND_START_SPAWN_FAILED: ["recovery", "The Hook Backend recovery command could not be started.", "This Hook did not start a Backend recovery process.", "Check that the configured MemoraX Code command and Node executable exist and can be executed."],
  HOOK_BACKEND_START_INTERRUPTED: ["recovery", "The Hook Backend recovery command terminated by a signal.", "Backend availability could not be confirmed after recovery was interrupted.", "Run memorax-code status before attempting another recovery."],
  HOOK_BACKEND_START_FAILED: ["recovery", "The Hook Backend recovery command failed.", "Backend availability could not be restored by this Hook.", "Run memorax-code start and inspect its diagnostic."],
  HOOK_BACKEND_RECOVERY_FAILED: ["recovery", "The Hook Backend recovery could not complete.", "Backend availability could not be confirmed by this Hook.", "Run memorax-code status and inspect the Backend recovery configuration."],
  HOOK_BACKEND_REQUEST_TIMEOUT: ["request", "The Hook Backend request timed out.", "Backend command acceptance could not be confirmed before the deadline.", "Run memorax-code status and check Backend response time. Do not repeat a writeback solely because its response timed out."],
  HOOK_BACKEND_REQUEST_FAILED: ["request", "The Hook command could not receive a Backend response.", "Backend command acceptance could not be confirmed.", "Run memorax-code status. Do not repeat a writeback solely because its response was unavailable."],
  HOOK_BACKEND_HTTP_REJECTED: ["response", "The Backend returned an unsuccessful HTTP status for a Hook command.", "This Hook command did not complete successfully.", "Run memorax-code status and share this diagnostic if the rejection persists."],
};
const CLIENTS = new Set(["codex", "claude-code", "dsh", "opencode", "codebuddy", "workbuddy", "trae"]);
const OPERATIONS = new Set(["hook.runtime", "hook.ensure-backend", "memory.turn-start", "memory.writeback"]);
const SYSTEM_CODES = new Set(["ENOENT", "ENOEXEC", "EACCES", "EPERM", "ENOSPC", "EROFS", "ENOTDIR", "EISDIR", "EMFILE", "ENAMETOOLONG", "ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND"]);

// Hook diagnostics are local, content-free, and never change the Hook outcome.
export function recordHookFailure({ memoraxCodeHome, client, input, operation, errorCode, error, stage: runtimeStage, httpStatus, commandExitCode, commandSignal, version } = {}) {
  try {
    if (!Object.hasOwn(FAILURES, errorCode) || !OPERATIONS.has(operation)) return;
    const [stage, message, impact, userAction] = FAILURES[errorCode];
    const systemCode = [error?.code, error?.cause?.code].find((code) => SYSTEM_CODES.has(code));
    const sessionHash = identityHash(input?.sessionId ?? input?.session_id);
    const turnHash = identityHash(input?.turnId ?? input?.turn_id ?? input?.promptId ?? input?.prompt_id ?? input?.userMessageId);
    return writeDiagnosticRecord(memoraxCodeHome ?? (process.env.MEMORAX_CODE_HOME?.trim() || join(homedir(), ".memorax-code")), {
      source: "client-hook",
      operation,
      stage: errorCode === "HOOK_RUNTIME_FAILED" && ["input", "runtime-selection", "runtime-import"].includes(runtimeStage) ? runtimeStage : stage,
      errorCode,
      error: message,
      impact,
      userAction,
      version: typeof version === "string" && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version) ? version : "unknown",
      runtimeVersion: process.version,
      platform: process.platform,
      ...(CLIENTS.has(client) ? { client } : {}),
      ...(sessionHash ? { sessionHash } : {}),
      ...(turnHash ? { turnHash } : {}),
      ...(systemCode ? { systemCode } : {}),
      ...(Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? { httpStatus } : {}),
      ...(["SIGTERM", "SIGKILL", "SIGINT", "SIGABRT", "SIGHUP", "SIGQUIT", "SIGSEGV"].includes(commandSignal) ? { commandSignal } : {}),
      ...(Number.isInteger(commandExitCode) && commandExitCode >= 0 && commandExitCode <= 255 ? { commandExitCode } : {}),
    });
  } catch { /* Diagnostics must not interrupt client work, including when storage is unavailable. */ }
}

function identityHash(value) {
  return typeof value === "string" && value.trim()
    ? createHash("sha256").update(value).digest("hex").slice(0, 24)
    : undefined;
}
