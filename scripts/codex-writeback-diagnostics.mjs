import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { join } from "node:path";

const reasons = new Set([
  "missing_session_id", "non_materialized_session", "turn_id_missing", "turn_metadata_mismatch",
  "config_missing", "transcript_unavailable", "transcript_session_mismatch", "turn_not_found",
  "user_prompt_missing", "assistant_message_missing", "runtime_closed", "disabled", "session_missing",
  "workspace_scope_missing", "workspace_scope_unavailable", "workspace_scope_mismatch",
  "effective_user_id_invalid", "user_prompt_empty", "assistant_text_empty", "decision_error", "duplicate_pending",
]);
const errorCodes = new Set([
  "HOOK_RUNTIME_FAILED", "HOOK_BACKEND_CONNECTION_INVALID", "HOOK_BACKEND_START_TIMEOUT",
  "HOOK_BACKEND_START_SPAWN_FAILED", "HOOK_BACKEND_START_INTERRUPTED", "HOOK_BACKEND_START_FAILED",
  "HOOK_BACKEND_RECOVERY_FAILED", "HOOK_BACKEND_REQUEST_TIMEOUT", "HOOK_BACKEND_REQUEST_FAILED",
  "HOOK_BACKEND_HTTP_REJECTED", "WRITEBACK_DISPATCH_REJECTED", "WRITEBACK_DISPATCH_FAILED",
  "MEMORAX_HTTP_ERROR", "MEMORAX_INVALID_JSON", "MEMORAX_TIMEOUT", "MEMORAX_TRANSPORT_ERROR",
  "MEMORAX_RESPONSE_REJECTED", "MEMORAX_INVALID_RESPONSE",
  ...[...reasons].map((reason) => `WRITEBACK_${reason.toUpperCase()}`),
]);
const backendEvents = new Set([
  "memory_hook.turn_start", "memory_hook.turn_start_skipped", "memory_hook.writeback", "memory.automatic_writeback",
]);
const maxEntries = 40;
const maxLogBytes = 256 * 1024;
const hash = (value, length) => createHash("sha256").update(value).digest("hex").slice(0, length);
const known = (value, values) => values.includes(value) ? value : "unknown";
const number = (value, maximum = 3_600_000) => Number.isInteger(value) && value >= 0 && value <= maximum ? value : undefined;
const bounded = (entries) => ({ entries: entries.slice(-maxEntries), truncated: entries.length > maxEntries });
const hasIdentity = ({ threadId, turnId }) => typeof threadId === "string" && threadId.length > 0
  && typeof turnId === "string" && turnId.length > 0;

export function summarizeHookEvents(events, identity) {
  if (!hasIdentity(identity)) return { available: false };
  const entries = [];
  for (const event of events) {
    if (!["hook/started", "hook/completed"].includes(event?.method)) continue;
    const { threadId, turnId, run } = event.params ?? {};
    if (threadId !== identity.threadId || (turnId != null && turnId !== identity.turnId) || !run) continue;
    entries.push({
      phase: event.method === "hook/started" ? "started" : "completed",
      correlation: turnId === identity.turnId ? "turn" : "session",
      event: known(run.eventName, ["sessionStart", "userPromptSubmit", "stop", "subagentStart", "subagentStop", "interrupt"]),
      handler: known(run.handlerType, ["command", "prompt", "agent", "mcpTool"]),
      source: known(run.source, ["plugin", "system", "user", "project", "sessionFlags"]),
      mode: known(run.executionMode, ["sync", "async"]),
      status: known(run.status, ["running", "completed", "failed", "blocked", "stopped"]),
      order: number(run.displayOrder), durationMs: number(run.durationMs),
      entryCounts: Object.fromEntries(["warning", "stop", "feedback", "context", "error"].map((kind) =>
        [kind, Array.isArray(run.entries) ? run.entries.filter((entry) => entry?.kind === kind).length : 0])),
    });
  }
  return { available: true, ...bounded(entries) };
}

// backendDebug writes space-separated key=JSON values, not a JSON object.
// Consume every field, including quoted spaces, so embedded markers cannot become fields.
function parseDebugFields(text) {
  const token = /([A-Za-z][A-Za-z0-9_]*)=((?:"(?:\\.|[^"\\])*"|[^ "\r\n])+)(?: |$)/gy;
  const fields = Object.create(null);
  let offset = 0;
  while (offset < text.length) {
    token.lastIndex = offset;
    const match = token.exec(text);
    if (!match || Object.hasOwn(fields, match[1])) return undefined;
    try { fields[match[1]] = JSON.parse(match[2]); } catch { return undefined; }
    offset = token.lastIndex;
  }
  return fields;
}

export function summarizeBackendLog(text, identity) {
  if (!hasIdentity(identity)) return { available: false };
  const entries = [];
  let unparsedLines = 0;
  for (const line of text.split(/\r?\n/)) {
    const match = /^\[memorax-code-backend:debug\] ([a-z_.]+) (.*)$/.exec(line);
    if (!match || !backendEvents.has(match[1])) continue;
    const fields = line.length <= 16_384 ? parseDebugFields(match[2]) : undefined;
    if (!fields) { unparsedLines++; continue; }
    const sessionMatched = match[1] === "memory.automatic_writeback"
      ? fields.sessionKeyHash === hash(identity.threadId, 16) : fields.sessionId === identity.threadId;
    if (!sessionMatched || (fields.turnId != null && fields.turnId !== identity.turnId)) continue;
    const entry = { event: match[1], correlation: fields.turnId === identity.turnId ? "turn" : "session" };
    for (const key of ["scheduled", "accepted", "retrying"]) {
      if (typeof fields[key] === "boolean") entry[key] = fields[key];
    }
    for (const key of ["reason", "skipReason"]) {
      if (fields[key] !== undefined) entry[key] = reasons.has(fields[key]) ? fields[key] : "unknown";
    }
    for (const key of ["attempt", "maxAttempts", "retryDelayMs"]) {
      if (number(fields[key]) !== undefined) entry[key] = fields[key];
    }
    if (number(fields.httpStatus, 599) >= 100) entry.httpStatus = fields.httpStatus;
    entries.push(entry);
  }
  return { available: true, unparsedLines, ...bounded(entries) };
}

export function summarizeDiagnosticHistory(history, identity) {
  if (!hasIdentity(identity) || !Array.isArray(history?.records)) return { available: false };
  const entries = [];
  for (const record of history.records) {
    if (record?.client !== "codex" || !["client-hook", "automatic-writeback"].includes(record.source)) continue;
    if (record.sessionHash !== hash(identity.threadId, 24)
      || (record.turnHash != null && record.turnHash !== hash(identity.turnId, 24))) continue;
    const entry = {
      correlation: record.turnHash ? "turn" : "session", source: record.source,
      operation: known(record.operation, ["hook.runtime", "hook.ensure-backend", "memory.turn-start", "memory.writeback"]),
      errorCode: errorCodes.has(record.errorCode) ? record.errorCode : "unknown",
    };
    if (number(record.httpStatus, 599) >= 100) entry.httpStatus = record.httpStatus;
    if (number(record.commandExitCode, 255) !== undefined) entry.commandExitCode = record.commandExitCode;
    entries.push(entry);
  }
  // The diagnostics CLI returns newest records first, unlike the log/event streams.
  return { available: history.ok === true, incomplete: history.skipped !== 0 || !!history.errorCode
    || history.records.length >= 100, entries: entries.slice(0, maxEntries), truncated: entries.length > maxEntries };
}

async function readLogTail(path) {
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error("DIAGNOSTIC_LOG_NOT_FILE");
    const start = Math.max(0, stat.size - maxLogBytes);
    const buffer = Buffer.alloc(Math.min(stat.size, maxLogBytes));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
    let text = buffer.subarray(0, bytesRead).toString("utf8");
    if (start) text = text.slice(text.indexOf("\n") + 1);
    // A concurrent write may leave an incomplete last record.
    text = text.slice(0, text.lastIndexOf("\n") + 1);
    return { text, truncated: start > 0 };
  } finally { await file.close(); }
}

export async function collectWritebackDiagnostics({ harness, events, threadId, turnId }) {
  const identity = { threadId, turnId };
  if (!hasIdentity(identity)) return { available: false };
  const report = {
    hooks: summarizeHookEvents(events, identity), backend: { available: false }, failures: { available: false },
    matchingMemoryRequests: harness.memoryRequests.filter((request) => request.body?.session_id === threadId).length,
  };
  try {
    const log = await readLogTail(join(harness.stateHome, "runtime", "backend", "backend.log"));
    report.backend = { ...summarizeBackendLog(log.text, identity), tailTruncated: log.truncated };
  } catch { /* Missing diagnostics cannot replace the original test failure. */ }
  try {
    const result = await harness.runProduct(["logs", "--diagnostics", "--limit", "100", "--json"], { timeout: 5000 });
    report.failures = summarizeDiagnosticHistory(JSON.parse(result.stdout), identity);
  } catch { /* Never expose CLI output or exception text. */ }
  return report;
}
