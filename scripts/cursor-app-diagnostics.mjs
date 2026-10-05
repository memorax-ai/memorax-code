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
