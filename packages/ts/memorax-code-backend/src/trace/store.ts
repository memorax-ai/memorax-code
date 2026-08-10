import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  ClaudeTurnActivity,
  ClaudeTurnTokenUsage,
} from "../clients/claude/transcript-turn.js";
import type { CodexTurnActivity, CodexTurnTokenUsage } from "../clients/codex/rollout-turn.js";
import {
  TRACE_CLEANUP_DEBOUNCE_MS,
  TRACE_CURRENT_TURN_TTL_MS,
  clientTraceConfigFromEnv,
  clientTracePaths,
  memoraxCodeHomeForTrace,
  type ClientTraceConfig,
} from "./config.js";
import {
  isTraceClient,
  traceContextFromCurrentTurnRecord,
  traceContextJson,
  type TraceClient,
  type TraceContext,
  type TraceRelatedTurn,
} from "./context.js";
import { appendRepairingJsonl } from "../shared/jsonl-append.js";

export type TraceTurnOutcome = "completed" | "interrupted";
export type TraceCurrentTurnState = "open" | TraceTurnOutcome;
export type CodexTurnOutcome = TraceTurnOutcome;
export type CodexCurrentTurnState = TraceCurrentTurnState;
export type TraceTurnActivity = CodexTurnActivity | ClaudeTurnActivity;
export type TraceTurnTokenUsage = CodexTurnTokenUsage | ClaudeTurnTokenUsage;

export type TraceEventInput = Readonly<{
  eventId?: string;
  memoraxCodeHome?: string;
  env?: Record<string, string | undefined>;
  config?: ClientTraceConfig;
  traceContext: TraceContext | undefined;
  type: string;
  source?: string;
  operation?: string;
  ok?: boolean;
  outcome?: TraceTurnOutcome;
  relatedTurns?: TraceRelatedTurn[];
  activities?: TraceTurnActivity[];
  usage?: TraceTurnTokenUsage;
  sessionTurnIndex?: number;
  request?: unknown;
  response?: unknown;
  error?: string;
  now?: () => Date;
}>;

export type CodexTraceEventInput = TraceEventInput;
export type ClaudeTraceEventInput = TraceEventInput;
export type TraceEventWriteResult =
  | { written: true; path: string }
  | { written: false; reason: string };

export type TraceCurrentTurnOptions = Readonly<{
  memoraxCodeHome?: string;
  env?: Record<string, string | undefined>;
  config?: ClientTraceConfig;
  client?: TraceClient;
  expectedSessionId?: string;
  allowStale?: boolean;
  now?: () => Date;
}>;

export type CodexCurrentTurnOptions = Omit<TraceCurrentTurnOptions, "client">;
export type ClaudeCurrentTurnOptions = Omit<TraceCurrentTurnOptions, "client">;
export type TraceCurrentTurnReadOptions = TraceCurrentTurnOptions & Readonly<{
  client: TraceClient;
}>;

export type TraceRetentionOptions = Readonly<{
  memoraxCodeHome?: string;
  env?: Record<string, string | undefined>;
  config?: ClientTraceConfig;
  client: TraceClient;
  now?: () => Date;
}>;

export type CodexTraceRetentionOptions = Omit<TraceRetentionOptions, "client">;
export type ClaudeTraceRetentionOptions = Omit<TraceRetentionOptions, "client">;

type ExistingTraceJson = Record<string, unknown> & {
  created_at?: unknown;
  updated_at?: unknown;
  codex?: unknown;
  claude?: unknown;
};

const eventCounters = new Map<string, number>();
const lastCleanupByRoot = new Map<string, number>();
const currentTurnPathOperations = new Map<string, Promise<unknown>>();
const traceEventPathOperations = new Map<string, Promise<unknown>>();
const eventIdsByPath = new Map<string, Set<string>>();

export async function recordTraceEvent(
  input: TraceEventInput,
): Promise<TraceEventWriteResult> {
  const client = input.traceContext?.client;
  if (!client) return { written: false, reason: "missing_trace_context" };
  if (!isTraceClient(client)) return { written: false, reason: "unsupported_client" };
  return recordTraceEventForClient(client, input);
}

async function recordTraceEventForClient(
  client: TraceClient,
  input: TraceEventInput,
): Promise<TraceEventWriteResult> {
  if (input.traceContext && input.traceContext.client !== client) {
    return { written: false, reason: "client_mismatch" };
  }
  const env = input.env ?? process.env;
  const memoraxCodeHome = input.memoraxCodeHome ?? memoraxCodeHomeForTrace(env);
  const config = input.config ?? clientTraceConfigFromEnv(client, traceEnv(env, memoraxCodeHome));
  if (!config.enabled) return { written: false, reason: "disabled" };
  const traceContext = input.traceContext;
  if (!traceContext?.sessionId) return { written: false, reason: "missing_trace_context" };

  const now = input.now?.() ?? new Date();
  const paths = clientTracePaths(client, memoraxCodeHome);
  await pruneExpiredTraceSessions(paths.root, config, now, { debounce: true }).catch(() => undefined);

  const sessionDir = paths.sessionDir(traceContext.sessionId);
  await mkdir(sessionDir, { recursive: true });
  const eventsPath = paths.eventsJsonl(traceContext.sessionId);
  if (await exceedsMaxFileBytes(eventsPath, config.maxFileBytes)) {
    await writeMaxFileWarningEvent({
      input,
      config,
      now,
      sessionDir,
      eventsPath,
    }).catch(() => undefined);
    return { written: false, reason: "max_file_bytes" };
  }

  await writeTraceJson(paths.traceJson(traceContext.sessionId), traceContext, config, now);
  const explicitEventId = normalizedString(input.eventId)?.slice(0, 200);
  const eventId = explicitEventId || nextEventId(sessionDir, now);
  const event = buildTraceEvent(input, config, now, eventId);
  const appended = await appendJsonlEvent(eventsPath, event, explicitEventId);
  if (!appended) return { written: false, reason: "duplicate_event" };
  return { written: true, path: eventsPath };
}

export async function recordCodexTraceEvent(
  input: CodexTraceEventInput,
): Promise<TraceEventWriteResult> {
  return recordTraceEventForClient("codex", input);
}

export async function recordClaudeTraceEvent(
  input: ClaudeTraceEventInput,
): Promise<TraceEventWriteResult> {
  return recordTraceEventForClient("claude", input);
}

export function traceTurnEventId(
  traceContext: TraceContext | undefined,
  type: "turn_start" | "turn_end" | "turn_materialized",
): string | undefined {
  if (!traceContext?.sessionId || !traceContext.turnId) return undefined;
  const digest = createHash("sha256")
    .update(`${traceContext.client}\u0000${traceContext.sessionId}\u0000${traceContext.turnId}\u0000${type}`)
    .digest("hex")
    .slice(0, 32);
  return `trace-${type.replaceAll("_", "-")}-${digest}`;
}

export async function writeCurrentTraceTurn(
  traceContext: TraceContext | undefined,
  options: TraceCurrentTurnOptions = {},
): Promise<{ written: true } | { written: false; reason: string }> {
  const client = options.client ?? traceContext?.client;
  if (!client) return { written: false, reason: "missing_trace_context" };
  if (!isTraceClient(client)) return { written: false, reason: "unsupported_client" };
  if (traceContext && traceContext.client !== client) {
    return { written: false, reason: "client_mismatch" };
  }
  const env = options.env ?? process.env;
  const memoraxCodeHome = options.memoraxCodeHome ?? memoraxCodeHomeForTrace(env);
  const config = options.config ?? clientTraceConfigFromEnv(client, traceEnv(env, memoraxCodeHome));
  if (!config.enabled) return { written: false, reason: "disabled" };
  if (!traceContext?.sessionId) return { written: false, reason: "missing_trace_context" };
  const paths = clientTracePaths(client, memoraxCodeHome);
  const capturedAt = (options.now?.() ?? new Date()).toISOString();
  const record = `${JSON.stringify({
    schema_version: "1",
    turn_state: "open",
    trace: traceContextJson({
      ...traceContext,
      capturedAt,
    }),
  }, null, 2)}\n`;
  await mkdir(paths.root, { recursive: true });
  await mkdir(paths.sessionDir(traceContext.sessionId), { recursive: true });
  await Promise.all([
    serializeCurrentTurnPath(paths.currentTurnPath, () => writeFile(paths.currentTurnPath, record, "utf8")),
    serializeCurrentTurnPath(
      paths.sessionCurrentTurnPath(traceContext.sessionId),
      () => writeFile(paths.sessionCurrentTurnPath(traceContext.sessionId), record, "utf8"),
    ),
  ]);
  return { written: true };
}

export async function writeCurrentCodexTurn(
  traceContext: TraceContext | undefined,
  options: CodexCurrentTurnOptions = {},
): Promise<{ written: true } | { written: false; reason: string }> {
  return writeCurrentTraceTurn(traceContext, { ...options, client: "codex" });
}

export async function writeCurrentClaudeTurn(
  traceContext: TraceContext | undefined,
  options: ClaudeCurrentTurnOptions = {},
): Promise<{ written: true } | { written: false; reason: string }> {
  return writeCurrentTraceTurn(traceContext, { ...options, client: "claude" });
}

export async function readCurrentTraceTurn(
  options: TraceCurrentTurnReadOptions,
): Promise<
  | { ok: true; traceContext: TraceContext }
  | { ok: false; reason: "disabled" | "missing" | "invalid" | "stale" | "session_mismatch" }
> {
  const current = await readCurrentTraceTurnRecord(options);
  return current.ok
    ? { ok: true, traceContext: current.traceContext }
    : current;
}

export async function readCurrentCodexTurn(
  options: CodexCurrentTurnOptions = {},
): Promise<
  | { ok: true; traceContext: TraceContext }
  | { ok: false; reason: "disabled" | "missing" | "invalid" | "stale" | "session_mismatch" }
> {
  return readCurrentTraceTurn({ ...options, client: "codex" });
}

export async function readCurrentClaudeTurn(
  options: ClaudeCurrentTurnOptions = {},
): Promise<
  | { ok: true; traceContext: TraceContext }
  | { ok: false; reason: "disabled" | "missing" | "invalid" | "stale" | "session_mismatch" }
> {
  return readCurrentTraceTurn({ ...options, client: "claude" });
}

export async function readOpenTraceTurn(
  options: TraceCurrentTurnReadOptions,
): Promise<
  | { ok: true; traceContext: TraceContext }
  | { ok: false; reason: "disabled" | "missing" | "invalid" | "stale" | "session_mismatch" }
  | { ok: false; reason: "closed"; outcome: TraceTurnOutcome }
> {
  const current = await readCurrentTraceTurnRecord(options);
  if (!current.ok) return current;
  if (current.turnState !== "open") {
    return { ok: false, reason: "closed", outcome: current.turnState };
  }
  return { ok: true, traceContext: current.traceContext };
}

export async function readOpenCodexTurn(
  options: CodexCurrentTurnOptions = {},
): Promise<
  | { ok: true; traceContext: TraceContext }
  | { ok: false; reason: "disabled" | "missing" | "invalid" | "stale" | "session_mismatch" }
  | { ok: false; reason: "closed"; outcome: CodexTurnOutcome }
> {
  return readOpenTraceTurn({ ...options, client: "codex" });
}

export async function readOpenClaudeTurn(
  options: ClaudeCurrentTurnOptions = {},
): Promise<
  | { ok: true; traceContext: TraceContext }
  | { ok: false; reason: "disabled" | "missing" | "invalid" | "stale" | "session_mismatch" }
  | { ok: false; reason: "closed"; outcome: TraceTurnOutcome }
> {
  return readOpenTraceTurn({ ...options, client: "claude" });
}

export async function markCurrentTraceTurnOutcome(
  traceContext: TraceContext | undefined,
  outcome: TraceTurnOutcome,
  options: TraceCurrentTurnOptions = {},
): Promise<{ updated: true } | { updated: false; reason: string }> {
  const client = options.client ?? traceContext?.client;
  if (!client) return { updated: false, reason: "missing_trace_context" };
  if (!isTraceClient(client)) return { updated: false, reason: "unsupported_client" };
  if (traceContext && traceContext.client !== client) {
    return { updated: false, reason: "client_mismatch" };
  }
  const env = options.env ?? process.env;
  const memoraxCodeHome = options.memoraxCodeHome ?? memoraxCodeHomeForTrace(env);
  const config = options.config ?? clientTraceConfigFromEnv(client, traceEnv(env, memoraxCodeHome));
  if (!config.enabled) return { updated: false, reason: "disabled" };
  if (!traceContext?.sessionId || !traceContext.turnId) {
    return { updated: false, reason: "missing_trace_context" };
  }
  const paths = clientTracePaths(client, memoraxCodeHome);
  const updated = await Promise.all([
    markCurrentTraceTurnPath(paths.currentTurnPath, traceContext, outcome),
    markCurrentTraceTurnPath(paths.sessionCurrentTurnPath(traceContext.sessionId), traceContext, outcome),
  ]);
  return updated.some(Boolean)
    ? { updated: true }
    : { updated: false, reason: "not_current_turn" };
}

export async function markCurrentCodexTurnOutcome(
  traceContext: TraceContext | undefined,
  outcome: CodexTurnOutcome,
  options: CodexCurrentTurnOptions = {},
): Promise<{ updated: true } | { updated: false; reason: string }> {
  return markCurrentTraceTurnOutcome(traceContext, outcome, { ...options, client: "codex" });
}

export async function markCurrentClaudeTurnOutcome(
  traceContext: TraceContext | undefined,
  outcome: TraceTurnOutcome,
  options: ClaudeCurrentTurnOptions = {},
): Promise<{ updated: true } | { updated: false; reason: string }> {
  return markCurrentTraceTurnOutcome(traceContext, outcome, { ...options, client: "claude" });
}

async function readCurrentTraceTurnRecord(
  options: TraceCurrentTurnReadOptions,
): Promise<
  | { ok: true; traceContext: TraceContext; turnState: TraceCurrentTurnState }
  | { ok: false; reason: "disabled" | "missing" | "invalid" | "stale" | "session_mismatch" }
> {
  const client = options.client;
  if (!isTraceClient(client)) return { ok: false, reason: "invalid" };
  const env = options.env ?? process.env;
  const memoraxCodeHome = options.memoraxCodeHome ?? memoraxCodeHomeForTrace(env);
  const config = options.config ?? clientTraceConfigFromEnv(client, traceEnv(env, memoraxCodeHome));
  if (!config.enabled) return { ok: false, reason: "disabled" };
  const paths = clientTracePaths(client, memoraxCodeHome);
  const now = options.now?.() ?? new Date();
  const expectedSessionId = normalizedString(options.expectedSessionId);
  if (expectedSessionId) {
    const sessionCurrent = await readCurrentTraceTurnPath(
      paths.sessionCurrentTurnPath(expectedSessionId),
      now,
      options.allowStale ?? false,
      client,
    );
    if (sessionCurrent.ok) {
      if (sessionCurrent.traceContext.sessionId !== expectedSessionId) {
        return { ok: false, reason: "session_mismatch" };
      }
      return sessionCurrent;
    }
    if (sessionCurrent.reason !== "missing") return sessionCurrent;

    const globalCurrent = await readCurrentTraceTurnPath(
      paths.currentTurnPath,
      now,
      options.allowStale ?? false,
      client,
    );
    if (!globalCurrent.ok) return globalCurrent;
    if (globalCurrent.traceContext.sessionId !== expectedSessionId) {
      return { ok: false, reason: "session_mismatch" };
    }
    return globalCurrent;
  }

  return await readCurrentTraceTurnPath(
    paths.currentTurnPath,
    now,
    options.allowStale ?? false,
    client,
  );
}

async function readCurrentTraceTurnPath(
  path: string,
  now: Date,
  allowStale: boolean,
  expectedClient: TraceClient,
): Promise<
  | { ok: true; traceContext: TraceContext; turnState: TraceCurrentTurnState }
  | { ok: false; reason: "missing" | "invalid" | "stale" }
> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return { ok: false, reason: "missing" };
  }
  if (!isRecord(raw) || raw.schema_version !== "1" || !isRecord(raw.trace)) {
    return { ok: false, reason: "invalid" };
  }
  const traceContext = traceContextFromCurrentTurnRecord(raw);
  if (!traceContext || traceContext.client !== expectedClient) return { ok: false, reason: "invalid" };
  if (!allowStale && now.getTime() - Date.parse(traceContext.capturedAt) > TRACE_CURRENT_TURN_TTL_MS) {
    return { ok: false, reason: "stale" };
  }
  const turnState = currentTurnState(raw);
  if (!turnState) return { ok: false, reason: "invalid" };
  return {
    ok: true,
    traceContext,
    turnState,
  };
}

async function markCurrentTraceTurnPath(
  path: string,
  expected: TraceContext,
  outcome: TraceTurnOutcome,
): Promise<boolean> {
  return await serializeCurrentTurnPath(path, async () => {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(path, "utf8"));
    } catch {
      return false;
    }
    if (!isRecord(raw) || raw.schema_version !== "1" || !isRecord(raw.trace)) return false;
    const current = traceContextFromCurrentTurnRecord(raw);
    if (
      !current
      || current.client !== expected.client
      || current.sessionId !== expected.sessionId
      || current.turnId !== expected.turnId
    ) {
      return false;
    }
    await writeFile(path, `${JSON.stringify({
      ...raw,
      turn_state: outcome,
    }, null, 2)}\n`, "utf8");
    return true;
  });
}

function currentTurnState(value: unknown): TraceCurrentTurnState | undefined {
  if (!isRecord(value)) return undefined;
  const state = normalizedString(value.turn_state);
  return state === "open" || state === "completed" || state === "interrupted"
    ? state
    : undefined;
}

async function serializeCurrentTurnPath<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const previous = currentTurnPathOperations.get(path) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  currentTurnPathOperations.set(path, current);
  try {
    return await current;
  } finally {
    if (currentTurnPathOperations.get(path) === current) currentTurnPathOperations.delete(path);
  }
}

export async function pruneExpiredTraceSessionsForClient(
  options: TraceRetentionOptions,
): Promise<void> {
  const client = options.client;
  if (!isTraceClient(client)) return;
  const env = options.env ?? process.env;
  const memoraxCodeHome = options.memoraxCodeHome ?? memoraxCodeHomeForTrace(env);
  const config = options.config ?? clientTraceConfigFromEnv(client, traceEnv(env, memoraxCodeHome));
  if (!config.enabled) return;
  const now = options.now?.() ?? new Date();
  const paths = clientTracePaths(client, memoraxCodeHome);
  await pruneExpiredTraceSessions(paths.root, config, now, { debounce: false });
}

export async function pruneExpiredCodexTraceSessions(
  options: CodexTraceRetentionOptions = {},
): Promise<void> {
  return pruneExpiredTraceSessionsForClient({ ...options, client: "codex" });
}

export async function pruneExpiredClaudeTraceSessions(
  options: ClaudeTraceRetentionOptions = {},
): Promise<void> {
  return pruneExpiredTraceSessionsForClient({ ...options, client: "claude" });
}

function buildTraceEvent(
  input: TraceEventInput,
  config: ClientTraceConfig,
  now: Date,
  eventId: string,
): Record<string, unknown> {
  const captureContent = config.captureContent;
  return pruneRecord({
    schema_version: "1",
    event_id: eventId,
    type: input.type,
    timestamp: now.toISOString(),
    trace: input.traceContext ? traceContextJson(input.traceContext) : undefined,
    source: input.source ?? "unknown",
    operation: input.operation,
    ok: input.ok,
    outcome: input.outcome,
    related_turns: input.relatedTurns?.map(relatedTurnJson),
    activities: input.activities,
    usage: input.usage,
    session_turn_index: input.sessionTurnIndex,
    request: input.request === undefined ? undefined : sanitizeTraceValue(input.request, config, captureContent),
    response: input.response === undefined ? undefined : sanitizeTraceValue(input.response, config, captureContent),
    error: input.error ? truncate(input.error, Math.min(config.maxEventChars, 2000)) : undefined,
  });
}

function relatedTurnJson(turn: TraceRelatedTurn): Record<string, unknown> {
  return pruneRecord({
    turn_id: turn.turnId,
    request_id: turn.requestId,
    native_request_id: turn.nativeRequestId,
    context_origin: turn.contextOrigin,
    captured_at: turn.capturedAt,
  });
}

function sanitizeTraceValue(value: unknown, config: ClientTraceConfig, captureContent: boolean): unknown {
  if (!captureContent) return metadataValue(value);
  if (typeof value === "string") return truncate(value, config.maxEventChars);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizeTraceValue(item, config, captureContent));
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (/authorization|api[-_]?key|token|secret/i.test(key)) continue;
    output[key] = sanitizeTraceValue(item, config, captureContent);
  }
  return output;
}

function metadataValue(value: unknown): unknown {
  if (typeof value === "string") {
    return {
      content_mode: "metadata",
      chars: value.length,
      hash: `sha256:${hashText(value)}`,
    };
  }
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return {
      content_mode: "metadata",
      kind: "array",
      count: value.length,
      items: value.slice(0, 20).map(metadataValue),
    };
  }
  const output: Record<string, unknown> = { content_mode: "metadata" };
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (/authorization|api[-_]?key|token|secret/i.test(key)) continue;
    output[key] = metadataValue(item);
  }
  return output;
}

async function writeTraceJson(path: string, context: TraceContext, config: ClientTraceConfig, now: Date): Promise<void> {
  const existing = await readExistingTraceJson(path);
  const existingClient = existing?.[context.client];
  const trace = {
    schema_version: "1",
    client: context.client,
    session_id: context.sessionId,
    created_at: typeof existing?.created_at === "string" ? existing.created_at : now.toISOString(),
    updated_at: now.toISOString(),
    capture: {
      capture_content: config.captureContent,
      max_event_chars: config.maxEventChars,
      max_file_bytes: config.maxFileBytes,
    },
    [context.client]: isRecord(existingClient) ? existingClient : pruneRecord({
      transcript_path: context.transcriptPath,
    }),
  };
  await writeFile(path, `${JSON.stringify(trace, null, 2)}\n`, "utf8");
}

async function readExistingTraceJson(path: string): Promise<ExistingTraceJson | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    return isRecord(value) ? value as ExistingTraceJson : undefined;
  } catch {
    return undefined;
  }
}

async function pruneExpiredTraceSessions(
  root: string,
  config: ClientTraceConfig,
  now: Date,
  options: { debounce: boolean },
): Promise<void> {
  if (options.debounce) {
    const lastCleanup = lastCleanupByRoot.get(root) ?? 0;
    if (now.getTime() - lastCleanup < TRACE_CLEANUP_DEBOUNCE_MS) return;
    if (await hasFreshCleanupMarker(root, now)) return;
  }
  lastCleanupByRoot.set(root, now.getTime());
  const sessionsRoot = join(root, "sessions");
  let entries: string[];
  try {
    entries = await readdir(sessionsRoot);
  } catch {
    return;
  }
  const cutoff = now.getTime() - config.retentionDays * 24 * 60 * 60 * 1000;
  for (const entry of entries) {
    const path = join(sessionsRoot, entry);
    try {
      const info = await stat(path);
      if (!info.isDirectory()) continue;
      const activityMs = await sessionActivityMs(path, info.mtimeMs);
      if (activityMs < cutoff) {
        await rm(path, { recursive: true, force: true });
        eventIdsByPath.delete(join(path, "events.jsonl"));
      }
    } catch {
      // Ignore cleanup races.
    }
  }
  await writeCleanupMarker(root, now).catch(() => undefined);
}

async function exceedsMaxFileBytes(path: string, maxFileBytes: number): Promise<boolean> {
  try {
    return (await stat(path)).size >= maxFileBytes;
  } catch {
    return false;
  }
}

async function writeMaxFileWarningEvent(input: {
  input: TraceEventInput;
  config: ClientTraceConfig;
  now: Date;
  sessionDir: string;
  eventsPath: string;
}): Promise<void> {
  const markerPath = join(input.sessionDir, ".max-file-bytes-warning");
  try {
    await writeFile(markerPath, input.now.toISOString(), { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (isNodeErrorCode(error, "EEXIST")) return;
    return;
  }
  const event = buildTraceEvent({
    ...input.input,
    type: "trace_warning",
    source: "trace-store",
    operation: "max_file_bytes",
    ok: false,
    request: undefined,
    response: { reason: "max_file_bytes", max_file_bytes: input.config.maxFileBytes },
    error: undefined,
  }, input.config, input.now, nextEventId(input.sessionDir, input.now));
  await appendJsonlEvent(input.eventsPath, event);
}

async function appendJsonlEvent(
  path: string,
  event: Record<string, unknown>,
  explicitEventId?: string,
): Promise<boolean> {
  return await serializeTraceEventPath(path, async () => {
    const knownEventIds = await traceEventIds(path);
    if (explicitEventId && knownEventIds.has(explicitEventId)) return false;
    await appendRepairingJsonl(path, `${JSON.stringify(event)}\n`);
    const eventId = normalizedString(event.event_id);
    if (eventId) knownEventIds.add(eventId);
    return true;
  });
}

async function traceEventIds(path: string): Promise<Set<string>> {
  const cached = eventIdsByPath.get(path);
  if (cached) return cached;
  const eventIds = new Set<string>();
  let text = "";
  try {
    text = await readFile(path, "utf8");
  } catch {
    eventIdsByPath.set(path, eventIds);
    return eventIds;
  }
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as unknown;
      if (!isRecord(event)) continue;
      const eventId = normalizedString(event.event_id);
      if (eventId) eventIds.add(eventId);
    } catch {
      // appendRepairingJsonl owns incomplete-tail recovery.
    }
  }
  eventIdsByPath.set(path, eventIds);
  return eventIds;
}

async function serializeTraceEventPath<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const previous = traceEventPathOperations.get(path) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  traceEventPathOperations.set(path, current);
  try {
    return await current;
  } finally {
    if (traceEventPathOperations.get(path) === current) traceEventPathOperations.delete(path);
  }
}

async function hasFreshCleanupMarker(root: string, now: Date): Promise<boolean> {
  try {
    const info = await stat(cleanupMarkerPath(root));
    return now.getTime() - info.mtimeMs < TRACE_CLEANUP_DEBOUNCE_MS;
  } catch {
    return false;
  }
}

async function writeCleanupMarker(root: string, now: Date): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(cleanupMarkerPath(root), `${JSON.stringify({ cleaned_at: now.toISOString() })}\n`, "utf8");
}

function cleanupMarkerPath(root: string): string {
  return join(root, ".retention-cleanup.json");
}

async function sessionActivityMs(sessionDir: string, fallbackMs: number): Promise<number> {
  const trace = await readExistingTraceJson(join(sessionDir, "trace.json"));
  const updatedAt = typeof trace?.updated_at === "string" ? Date.parse(trace.updated_at) : NaN;
  const candidates = [fallbackMs, Number.isFinite(updatedAt) ? updatedAt : 0];
  for (const filename of ["trace.json", "events.jsonl"]) {
    try {
      candidates.push((await stat(join(sessionDir, filename))).mtimeMs);
    } catch {
      // Missing trace files should fall back to directory mtime.
    }
  }
  return Math.max(...candidates);
}

function nextEventId(sessionKey: string, now: Date): string {
  const counter = (eventCounters.get(sessionKey) ?? 0) + 1;
  eventCounters.set(sessionKey, counter);
  return `evt_${now.getTime()}_${counter}`;
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}...`;
}

function pruneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function traceEnv(env: Record<string, string | undefined>, memoraxCodeHome: string): Record<string, string | undefined> {
  return { ...env, MEMORAX_CODE_HOME: memoraxCodeHome };
}

function normalizedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === code);
}
