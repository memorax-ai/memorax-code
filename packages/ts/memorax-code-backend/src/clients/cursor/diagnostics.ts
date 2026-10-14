import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { writeDiagnosticRecord } from "../../../../memorax-code-adapter-common/src/diagnostic-record.mjs";
import { recordWritebackRejection } from "../../memory/background-diagnostics.js";
import { fileErrorFields } from "../../memory/cli-diagnostics.js";
import { memoryWritebackEnabled } from "../../provider/memorax/config.js";

export type CursorFailureContext = {
  memoraxCodeHome: string;
  env?: Record<string, string | undefined>;
  operation: "memory.turn-start" | "memory.pre-compact" | "memory.writeback";
  sessionId: string;
  turnId: string;
  retryExhausted?: boolean;
  error?: unknown;
};

// Pending native content is expected while Cursor is persisting the Turn.
const PENDING = new Set([
  "database_unavailable", "database_session_missing", "database_state_missing", "database_blob_missing",
  "native_generation_pending", "native_turn_pending", "native_final_response_pending",
]);
const FAILURES: Record<string, readonly [stage: string, message: string]> = {
  database_runtime_unavailable: ["content-read", "The Node runtime cannot read the Cursor database."],
  database_path_invalid: ["configuration", "The Cursor database path is invalid."],
  database_unavailable: ["content-read", "The Cursor database could not be opened or read."],
  database_session_missing: ["content-read", "The matching Cursor session has not been saved to the database."],
  database_state_missing: ["content-read", "The matching Cursor session state is missing."],
  database_blob_missing: ["content-read", "The Cursor database is missing a referenced native record."],
  database_replaced: ["correlation", "The Cursor database changed during the read."],
  database_snapshot_too_large: ["content-validation", "The Cursor native state exceeds the supported size limit."],
  database_native_format_invalid: ["content-validation", "The Cursor database contains an unsupported or malformed native format."],
  native_generation_pending: ["content-read", "The Cursor database has not saved the matching generation."],
  native_turn_pending: ["content-read", "The Cursor database has not saved the matching Turn."],
  native_final_response_pending: ["content-read", "The matching final reply is not yet available in the Cursor database."],
  native_prompt_mismatch: ["correlation", "The native user prompt does not match the registered Cursor Turn."],
  native_turn_ambiguous: ["correlation", "Multiple native Cursor Turns match the requested identity."],
  native_turn_replaced: ["correlation", "The matching Cursor Turn is no longer the active native Turn."],
  native_response_ambiguous: ["correlation", "Multiple native replies match the Cursor response identity."],
  native_user_unavailable: ["content-validation", "The native Cursor Turn has no usable user identity or prompt."],
  native_turn_unsupported: ["content-validation", "The native Cursor Turn format is unsupported."],
  native_user_unsupported: ["content-validation", "The native Cursor user record format is unsupported."],
  native_step_unsupported: ["content-validation", "The native Cursor Turn contains an unsupported step."],
  native_continuation_prefix_changed: ["correlation", "The native Cursor continuation changed previously observed steps."],
  native_continuation_replaced: ["correlation", "The native Cursor continuation replaced its observed predecessor."],
  database_or_workspace_changed: ["correlation", "The Cursor database or workspace conflicts with the registered Turn."],
  conflicting_stop_events: ["correlation", "The Cursor completion events conflict."],
  conflicting_response_events: ["correlation", "The Cursor response events disagree on the final reply."],
  response_digest_invalid: ["correlation", "The Cursor response identity is invalid."],
  start_missing: ["correlation", "The Cursor completion has no registered Turn start."],
  turn_state_unavailable: ["state", "The private Cursor session state could not be read, locked, validated or saved."],
  workspace_scope_unavailable: ["scope", "The Cursor memory scope could not be verified."],
  workspace_scope_mismatch: ["scope", "The Cursor workspace conflicts with its registered memory scope."],
  config_missing: ["configuration", "The MemoraX connection configuration is incomplete."],
  effective_user_id_invalid: ["configuration", "The configured MemoraX user identity is invalid."],
};

// Unknown reasons, ordinary interruptions/replacements and intentionally
// excluded simulated, steer, external or empty user content stay silent.
export function recordCursorFailure(reason: string, context: CursorFailureContext): boolean {
  try {
    const writeback = context.operation === "memory.writeback";
    if (writeback && !memoryWritebackEnabled(context.env ?? process.env)) return false;
    if (PENDING.has(reason) && writeback && !context.retryExhausted) return false;
    if (writeback && recordWritebackRejection(reason, { ...context, client: "cursor" })) return true;
    const failure = Object.hasOwn(FAILURES, reason) ? FAILURES[reason] : undefined;
    if (!failure) return false;
    const exhausted = PENDING.has(reason) && context.retryExhausted;
    const [stage, message] = failure;
    return writeDiagnosticRecord(context.memoraxCodeHome, {
      source: writeback ? "automatic-writeback" : "client-hook",
      operation: context.operation, client: "cursor", stage,
      errorCode: exhausted ? "CURSOR_NATIVE_CONTENT_TIMEOUT" : `CURSOR_${reason.toUpperCase()}`,
      error: exhausted ? "Cursor native content was still unavailable when the bounded retry period ended." : message,
      failureReason: reason,
      impact: writeback ? reason === "turn_state_unavailable"
        ? "Automatic memory writeback acceptance could not be confirmed because the private Turn state is unavailable."
        : "This completion was not queued for automatic memory writeback."
        : context.operation === "memory.pre-compact" ? "Personal memory restoration after this compaction could not be prepared."
          : "Cursor Turn registration, continuation binding or personal memory restoration did not complete normally.",
      userAction: stage === "state" ? "Check the MemoraX state directory permissions and free disk space; retry after other Hook activity finishes."
        : reason === "database_runtime_unavailable" ? "Run MemoraX Code with a supported Node runtime that provides node:sqlite, then restart the Backend."
        : stage === "scope" ? "Start a new conversation in the intended workspace and verify its repository metadata."
        : stage === "configuration" ? "Run memorax-code setup and verify the Cursor database and MemoraX configuration."
        : "Check the Cursor version and selected database profile. If it persists, share this diagnostic without the native conversation database.",
      version: packageVersion(), runtimeVersion: process.version, platform: process.platform,
      sessionHash: identityHash(context.sessionId), turnHash: identityHash(context.turnId),
      ...fileErrorFields(context.error),
    }).recorded;
  } catch { return false; }
}

function identityHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function packageVersion(): string {
  try {
    const value: unknown = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")).version;
    return typeof value === "string" && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(value) ? value : "unknown";
  } catch { return "unknown"; }
}
