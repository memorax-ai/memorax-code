import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { writeDiagnosticRecord } from "../../../memorax-code-adapter-common/src/diagnostic-record.mjs";
import { defaultMemoraxCodeHome } from "../config/memorax-code.js";
import { memoryWritebackEnabled } from "../provider/memorax/config.js";
import { fileErrorFields } from "./cli-diagnostics.js";

type AddFailure = {
  error: string; errorCode?: string; errorKind?: string;
  httpStatus?: number; retryAfterMs?: number; systemCode?: string;
};

export type BackgroundWritebackContext = {
  memoraxCodeHome?: string;
  env?: Record<string, string | undefined>;
  client: string;
  sessionId?: string;
  turnId?: string;
};

// Only confirmed failures are listed. Missing/incomplete assistant output,
// interruptions, subagents, compaction, duplicates and buffering are normal.
const REJECTIONS: Record<string, { stage: string; error: string }> = {
  transcript_unavailable: { stage: "content-read", error: "The native transcript could not be read." },
  malformed_transcript: { stage: "content-validation", error: "The native transcript contains malformed records." },
  transcript_session_mismatch: { stage: "correlation", error: "The native transcript belongs to a different session." },
  transcript_path_mismatch: { stage: "correlation", error: "The completion transcript differs from the registered transcript." },
  turn_metadata_mismatch: { stage: "correlation", error: "The completion does not match the registered Turn metadata." },
  turn_ambiguous: { stage: "correlation", error: "The native transcript contains ambiguous matching Turns." },
  turn_id_missing: { stage: "correlation", error: "The completion has no native Turn identity." },
  message_identity_mismatch: { stage: "correlation", error: "The native messages do not match the requested session and parent lineage." },
  session_identity_mismatch: { stage: "correlation", error: "The native event interval belongs to a different session." },
  workspace_identity_mismatch: { stage: "correlation", error: "The native session workspace conflicts with the completion workspace." },
  turn_identity_mismatch: { stage: "correlation", error: "The native event interval names a different Turn." },
  turn_boundary_mismatch: { stage: "content-validation", error: "The native event interval has invalid Turn boundaries." },
  session_header_invalid: { stage: "content-validation", error: "The native session header is invalid." },
  interval_length_mismatch: { stage: "content-validation", error: "The native event interval is incomplete." },
  event_invalid: { stage: "content-validation", error: "The native event interval contains an invalid event." },
  event_sequence_mismatch: { stage: "content-validation", error: "The native event interval is not contiguous." },
  unknown_required_event: { stage: "content-validation", error: "The native event interval uses an unsupported required event." },
  workspace_scope_unavailable: { stage: "scope", error: "The workspace memory scope could not be verified." },
  workspace_scope_missing: { stage: "scope", error: "The completed Turn has no verified workspace memory scope." },
  workspace_scope_mismatch: { stage: "scope", error: "The completion workspace conflicts with its registered memory scope." },
  effective_user_id_invalid: { stage: "configuration", error: "The configured MemoraX user identity is invalid." },
  config_missing: { stage: "configuration", error: "The MemoraX connection configuration is incomplete." },
  decision_error: { stage: "enqueue", error: "The completed Turn could not be prepared for automatic writeback." },
};

export function recordWritebackRejection(reason: string, context: BackgroundWritebackContext): void {
  try {
    // OpenCode also uses this reason for an interrupted Turn after cached
    // metadata expires. Its unchanged result cannot prove a writeback fault.
    if (context.client === "opencode" && reason === "turn_metadata_mismatch") return;
    const failure = Object.hasOwn(REJECTIONS, reason) ? REJECTIONS[reason] : undefined;
    if (!failure || !memoryWritebackEnabled(context.env ?? process.env)) return;
    record(context, {
      ...failure,
      errorCode: `WRITEBACK_${reason.toUpperCase()}`,
      failureReason: reason,
      impact: "This completion was not queued for automatic memory writeback.",
      userAction: failure.stage === "configuration"
        ? "Run memorax-code setup and verify the MemoraX connection configuration."
        : failure.stage === "scope"
          ? "Start a new session in the intended workspace and check that its repository metadata is readable."
          : "Retry after the client finishes saving this Turn; if it persists, share the diagnostic and client version.",
    });
  } catch { /* Reporting must never change the Hook outcome. */ }
}

export function recordAutomaticAddFailure(
  failure: AddFailure | undefined,
  context: BackgroundWritebackContext,
  unexpected?: unknown,
): void {
  try {
    // Provider request failures carry fixed safe messages and machine fields.
    // Pre-dispatch rejections lack that contract; never store their raw error.
    const remote = failure?.errorCode && failure.errorKind;
    const rejected = failure && !remote;
    record(context, {
      stage: remote ? failure.errorKind === "response" ? "response" : "request" : "dispatch",
      errorCode: remote ? failure.errorCode! : rejected ? "WRITEBACK_DISPATCH_REJECTED" : "WRITEBACK_DISPATCH_FAILED",
      error: remote ? failure.error : rejected
        ? "Automatic Add was rejected before the request could be sent."
        : "Automatic writeback failed before its dispatch completed.",
      impact: remote
        ? "MemoraX acceptance of this automatic Add could not be confirmed; earlier parts may already have been accepted."
        : "Automatic Add was not completed; earlier parts may already have been accepted.",
      userAction: rejected ? "Check the MemoraX connection configuration and workspace scope; share the diagnostic if rejection persists."
        : failure?.httpStatus === 401 || failure?.httpStatus === 403 ? "Check the configured MemoraX API key and account permissions."
        : failure?.httpStatus === 429 ? "Check account limits and the indicated retry delay."
        : failure?.errorKind === "response" ? "Check the endpoint and service compatibility; share this diagnostic if the response remains invalid."
        : "Check the MemoraX endpoint, network and service availability. Verify Add acceptance before repeating it.",
      ...(!failure ? fileErrorFields(unexpected) : {}),
      ...(remote && failure.systemCode ? { systemCode: failure.systemCode } : {}),
      ...(remote && failure.httpStatus !== undefined ? { httpStatus: failure.httpStatus } : {}),
      ...(remote && failure.retryAfterMs !== undefined ? { retryAfterMs: failure.retryAfterMs } : {}),
    });
  } catch { /* Diagnostic storage cannot reject or retry a writeback. */ }
}

function record(
  context: BackgroundWritebackContext,
  failure: {
    stage: string; errorCode: string; error: string; impact: string; userAction: string;
    failureReason?: string; systemCode?: string; httpStatus?: number; retryAfterMs?: number;
  },
): void {
  writeDiagnosticRecord(context.memoraxCodeHome ?? defaultMemoraxCodeHome(context.env), {
    source: "automatic-writeback",
    operation: "memory.writeback",
    ...failure,
    version: packageVersion(),
    runtimeVersion: process.version,
    platform: process.platform,
    client: context.client,
    ...(context.sessionId ? { sessionHash: identityHash(context.sessionId) } : {}),
    ...(context.turnId ? { turnHash: identityHash(context.turnId) } : {}),
  });
}

function packageVersion(): string {
  try {
    const version: unknown = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
    return typeof version === "string" && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version) ? version : "unknown";
  } catch { return "unknown"; }
}

function identityHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}
