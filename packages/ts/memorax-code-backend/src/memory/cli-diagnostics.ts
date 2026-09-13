import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { writeDiagnosticRecord, type DiagnosticWriteResult } from "../../../memorax-code-adapter-common/src/diagnostic-record.mjs";
import type { TraceContext } from "../trace/context.js";

export type MemoryCliFailureDetails = {
  error?: string;
  errorCode?: string;
  stage?: "input" | "configuration" | "scope" | "request" | "response" | "internal";
  errorKind?: string;
  systemCode?: string;
  httpStatus?: number;
  retryAfterMs?: number;
  userAction?: string;
  impact?: string;
  diagnostic?: DiagnosticWriteResult;
};

const LOCAL_MESSAGES: Record<string, string> = {
  MEMORY_INPUT_INVALID: "The memory command arguments are invalid.",
  MEMORY_INPUT_UNREADABLE: "The memory command input file could not be read.",
  MEMORY_ADD_DISABLED: "Explicit memory Add is disabled by configuration.",
  MEMORY_CONFIG_MISSING: "The MemoraX connection configuration is incomplete.",
  MEMORY_SCOPE_UNAVAILABLE: "The memory workspace scope could not be verified.",
  MEMORY_SCOPE_MISMATCH: "The command workspace conflicts with the current session scope.",
  MEMORY_CLI_INTERNAL: "The memory command failed unexpectedly.",
};

export function diagnoseMemoryCliFailure<T extends MemoryCliFailureDetails & { action: "memory.search" | "memory.add" }>(
  failure: T,
  home: string,
  traceContext?: TraceContext,
  client?: string,
): T & Required<Pick<MemoryCliFailureDetails, "errorCode" | "stage" | "userAction" | "impact" | "diagnostic">> {
  const errorCode = failure.errorCode ?? "MEMORY_INPUT_INVALID";
  const stage = failure.stage ?? (failure.errorKind === "response" ? "response" : failure.errorKind ? "request" : "input");
  const remote = stage === "request" || stage === "response" || stage === "internal";
  const impact = remote
    ? failure.action === "memory.add"
      ? "MemoraX Add acceptance could not be confirmed."
      : "No Search result was returned."
    : "The request was not sent to MemoraX.";
  const userAction = failure.userAction ?? recoveryAction(errorCode, failure);
  // Local validation errors may contain workspace paths or user-supplied values.
  // Store a fixed summary; remote failures have already crossed the safe provider boundary.
  const diagnostic = writeDiagnosticRecord(home, {
    source: "memorax-cli",
    operation: failure.action,
    stage,
    errorCode,
    error: LOCAL_MESSAGES[errorCode] ?? failure.error ?? "MemoraX request failed.",
    impact,
    userAction,
    version: packageVersion(),
    runtimeVersion: process.version,
    platform: process.platform,
    ...(traceContext?.client || client ? { client: traceContext?.client ?? client } : {}),
    ...(traceContext ? { sessionHash: identityHash(traceContext.sessionId) } : {}),
    ...(traceContext?.turnId ? { turnHash: identityHash(traceContext.turnId) } : {}),
    ...(failure.systemCode ? { systemCode: failure.systemCode } : {}),
    ...(failure.httpStatus !== undefined ? { httpStatus: failure.httpStatus } : {}),
    ...(failure.retryAfterMs !== undefined ? { retryAfterMs: failure.retryAfterMs } : {}),
  });
  return { ...failure, errorCode, stage, userAction, impact, diagnostic };
}

export function memoryCliUnexpectedFailure(error: unknown): MemoryCliFailureDetails {
  return {
    error: LOCAL_MESSAGES.MEMORY_CLI_INTERNAL,
    errorCode: "MEMORY_CLI_INTERNAL",
    stage: "internal",
    ...fileErrorFields(error),
  };
}

export function fileErrorFields(error: unknown): { systemCode?: string } {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return typeof code === "string" && ["ENOENT", "EACCES", "EPERM", "ENOSPC", "EROFS", "ENOTDIR", "EISDIR", "EMFILE"].includes(code)
    ? { systemCode: code } : {};
}

function recoveryAction(code: string, failure: MemoryCliFailureDetails): string {
  if (code === "MEMORY_INPUT_INVALID") return "Check the required flags and values for this memory command.";
  if (code === "MEMORY_INPUT_UNREADABLE") return "Check that the input file exists and is readable by this process.";
  if (code === "MEMORY_ADD_DISABLED") return "Check the explicit Add and writeback settings with memorax-cli status.";
  if (code === "MEMORY_CONFIG_MISSING") return "Run memorax-code setup, then check memorax-cli status.";
  if (code.startsWith("MEMORY_SCOPE_")) return "Start a new session in the intended workspace and verify that its repository metadata is readable.";
  if (failure.httpStatus === 401 || failure.httpStatus === 403) return "Check the configured MemoraX API key and account permissions.";
  if (failure.httpStatus === 429) return "Check account limits and retry after the indicated delay, if provided.";
  if (failure.httpStatus !== undefined) return "Check MemoraX service availability and share the diagnostic if the rejection persists.";
  if (failure.systemCode === "ENOTFOUND" || failure.systemCode === "EAI_AGAIN") return "Check the MemoraX endpoint hostname and DNS resolution.";
  if (failure.systemCode === "ECONNREFUSED") return "Check that the MemoraX endpoint or configured proxy is reachable and accepting connections.";
  if (code === "MEMORAX_TIMEOUT") return "Check the connection and service response time. Add may have reached the service before the timeout; verify before repeating it.";
  if (failure.errorKind === "transport") return "Check the MemoraX endpoint, proxy and TLS connection. For Add, verify acceptance before repeating the request.";
  if (failure.errorKind === "response") return "Check the endpoint and service compatibility; share this diagnostic if the response remains invalid.";
  return "Share this diagnostic and the command's operation with the maintainer.";
}

function packageVersion(): string {
  try {
    const version: unknown = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
    return typeof version === "string" && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version) ? version : "unknown";
  } catch {
    return "unknown";
  }
}

function identityHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}
