import { homedir } from "node:os";
import type { MemoryDiagnosticLogger } from "../memory/observability.js";
import {
  hasMeaningfulMemoryPayloadText,
  redactMemoryPayloadText,
} from "../memory/payload-redaction.js";

export type CodingSessionClient = "codex" | "claude-code" | "opencode" | "codebuddy" | "workbuddy";

export type CodingTurnEvent =
  | Readonly<{
    type: "user_message";
    content: string;
  }>
  | Readonly<{
    type: "assistant_message";
    phase: "progress" | "final";
    content: string;
  }>
  | Readonly<{
    type: "tool_call";
    callId: string;
    tool: string;
    arguments: string;
  }>
  | Readonly<{
    type: "tool_result";
    callId: string;
    status: "success" | "error";
    output: string;
  }>;

export type CodingSessionSourceTurn = Readonly<{
  client: CodingSessionClient;
  sessionId: string;
  turnId: string;
  turnIndex: number;
  events: readonly CodingTurnEvent[];
  outcome: "completed";
  closedAt: string;
  repositorySlug?: string;
}>;

export type NormalizedCodingTurnEvent =
  | Readonly<{
    index: number;
    type: "user_message";
    content: string;
  }>
  | Readonly<{
    index: number;
    type: "assistant_message";
    phase: "progress" | "final";
    content: string;
  }>
  | Readonly<{
    index: number;
    type: "tool_call";
    call_id: string;
    tool: string;
    arguments: string;
  }>
  | Readonly<{
    index: number;
    type: "tool_result";
    call_id: string;
    status: "success" | "error";
    output: string;
  }>;

type UnindexedNormalizedCodingTurnEvent = NormalizedCodingTurnEvent extends infer Event
  ? Event extends Readonly<{ index: number }>
    ? Omit<Event, "index">
    : never
  : never;

export type NormalizedCodingTurn = Readonly<{
  schema_version: 1;
  client: CodingSessionClient;
  session_id: string;
  turn_id: string;
  turn_index: number;
  events: readonly NormalizedCodingTurnEvent[];
  outcome: "completed";
  closed_at: string;
  redaction_version: 1;
  repository_slug?: string;
  truncation?: Readonly<{
    original_event_count: number;
    truncated_text_fields: number;
  }>;
}>;

export const CODING_TURN_MAX_BYTES = 2 * 1024 * 1024;
const CODING_TURN_TEXT_MAX_CHARS = 128_000;
const CODING_TURN_MAX_EVENTS = 512;
const BINARY_CONTENT_OMITTED = "[BINARY_CONTENT_OMITTED]";

export function normalizeCodingSessionTurn(
  turn: CodingSessionSourceTurn,
  diagnosticLogger?: MemoryDiagnosticLogger,
): NormalizedCodingTurn | undefined {
  if (!Number.isSafeInteger(turn.turnIndex) || turn.turnIndex < 1) return undefined;
  const sessionId = boundedIdentifier(turn.sessionId);
  const turnId = boundedIdentifier(turn.turnId);
  const closedAt = normalizedTimestamp(turn.closedAt);
  if (!sessionId || !turnId || !closedAt || turn.outcome !== "completed") return undefined;

  const truncatedFields = new Set<number>();
  const normalizedEvents = turn.events
    .flatMap((event, sourceIndex) => {
      const normalized = normalizeEvent(event, () => truncatedFields.add(sourceIndex));
      return normalized ? [{ event: normalized, sourceIndex }] : [];
    });
  if (normalizedEvents[0]?.event.type !== "user_message") return undefined;
  if (normalizedEvents.filter(({ event }) => event.type === "user_message").length !== 1) return undefined;
  const finalIndexes = normalizedEvents.flatMap(({ event }, index) => (
    event.type === "assistant_message" && event.phase === "final" ? [index] : []
  ));
  if (finalIndexes.length !== 1 || finalIndexes[0] !== normalizedEvents.length - 1) return undefined;

  const candidates = normalizedEvents.length > CODING_TURN_MAX_EVENTS
    ? [normalizedEvents[0], ...normalizedEvents.slice(-(CODING_TURN_MAX_EVENTS - 1))]
    : normalizedEvents;
  const repositorySlug = boundedIdentifier(turn.repositorySlug);
  const envelope = {
    schema_version: 1 as const,
    client: turn.client,
    session_id: sessionId,
    turn_id: turnId,
    turn_index: turn.turnIndex,
    outcome: "completed" as const,
    closed_at: closedAt,
    redaction_version: 1 as const,
    ...(repositorySlug ? { repository_slug: repositorySlug } : {}),
  };
  // Reserve the largest possible truncation marker and event-index width.
  let remaining = CODING_TURN_MAX_BYTES - jsonBytes({
    ...envelope,
    events: [],
    truncation: {
      original_event_count: turn.events.length,
      truncated_text_fields: turn.events.length,
    },
  });
  const first = candidates[0];
  const last = candidates[candidates.length - 1];
  const firstBudget = Math.min(
    eventBytes(first.event),
    Math.max(remaining - eventBytes(last.event), Math.floor(remaining / 2)),
  );
  const user = fitEvent(first.event, firstBudget, () => truncatedFields.add(first.sourceIndex));
  const final = fitEvent(last.event, remaining - firstBudget, () => truncatedFields.add(last.sourceIndex));
  if (!user || !final) return undefined;
  remaining -= eventBytes(user) + eventBytes(final);
  const middle: UnindexedNormalizedCodingTurnEvent[] = [];
  for (let index = candidates.length - 2; index > 0; index -= 1) {
    const candidate = candidates[index];
    const event = fitEvent(candidate.event, remaining, () => truncatedFields.add(candidate.sourceIndex));
    if (event) {
      middle.push(event);
      remaining -= eventBytes(event);
    }
  }
  const events = [user, ...middle.reverse(), final];
  const truncation = events.length < turn.events.length || truncatedFields.size > 0
    ? { original_event_count: turn.events.length, truncated_text_fields: truncatedFields.size }
    : undefined;
  if (truncation) {
    diagnosticLogger?.("coding_turn.truncated", {
      originalEvents: truncation.original_event_count,
      keptEvents: events.length,
      truncatedTextFields: truncation.truncated_text_fields,
    });
  }
  return {
    ...envelope,
    events: events.map((event, index) => ({ ...event, index: index + 1 }) as NormalizedCodingTurnEvent),
    ...(truncation ? { truncation } : {}),
  };
}

export function codingEventText(value: unknown): string {
  if (typeof value === "string") {
    const normalized = value.trim();
    if (!normalized) return "";
    if (isBinaryDataUri(normalized)) return BINARY_CONTENT_OMITTED;
    try {
      return stableJson(JSON.parse(normalized));
    } catch {
      return normalized;
    }
  }
  if (value === undefined) return "";
  return stableJson(value);
}

function normalizeEvent(
  event: CodingTurnEvent,
  onTruncated: () => void,
): UnindexedNormalizedCodingTurnEvent | undefined {
  if (event.type === "user_message" || event.type === "assistant_message") {
    const content = redactSourceText(event.content, true, onTruncated);
    if (!content) return undefined;
    return event.type === "user_message"
      ? { type: "user_message", content }
      : { type: "assistant_message", phase: event.phase, content };
  }
  const callId = boundedEventIdentifier(event.callId, 512);
  if (!callId) return undefined;
  if (event.type === "tool_call") {
    const tool = boundedEventIdentifier(event.tool, 255);
    if (!tool) return undefined;
    return {
      type: "tool_call",
      call_id: callId,
      tool,
      arguments: redactSourceText(event.arguments, false, onTruncated) ?? "",
    };
  }
  return {
    type: "tool_result",
    call_id: callId,
    status: event.status,
    output: redactSourceText(event.output, false, onTruncated) ?? "",
  };
}

function redactSourceText(value: string, requireMeaningful: boolean, onTruncated: () => void): string | undefined {
  const withoutHome = redactHomePath(String(value ?? ""));
  const text = redactMemoryPayloadText(withoutHome).text;
  const bounded = truncateText(text);
  if (bounded.length < text.length) onTruncated();
  const redacted = bounded.trim();
  if (!redacted) return undefined;
  return !requireMeaningful || hasMeaningfulMemoryPayloadText(redacted) ? redacted : undefined;
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function eventBytes(event: UnindexedNormalizedCodingTurnEvent): number {
  return jsonBytes({ ...event, index: CODING_TURN_MAX_EVENTS }) + 1;
}

function fitEvent(
  event: UnindexedNormalizedCodingTurnEvent,
  budget: number,
  onTruncated: () => void,
): UnindexedNormalizedCodingTurnEvent | undefined {
  const bytes = eventBytes(event);
  if (bytes <= budget) return event;
  const field = "content" in event ? "content" : "arguments" in event ? "arguments" : "output";
  const text = "content" in event ? event.content : "arguments" in event ? event.arguments : event.output;
  const textBudget = budget - (bytes - jsonBytes(text)) - 2;
  if (textBudget < 0) return undefined;
  // Count JSON string bytes once, including escaping and surrogate pairs.
  let used = 0;
  let end = 0;
  for (const character of text) {
    const point = character.codePointAt(0)!;
    const cost = point < 0x20
      ? ([8, 9, 10, 12, 13].includes(point) ? 2 : 6)
      : point === 0x22 || point === 0x5c ? 2
        : point >= 0xd800 && point <= 0xdfff ? 6
          : Buffer.byteLength(character, "utf8");
    if (used + cost > textBudget) break;
    used += cost;
    end += character.length;
  }
  const bounded = text.slice(0, end).trim();
  onTruncated();
  if (field === "content" && !hasMeaningfulMemoryPayloadText(bounded)) return undefined;
  return { ...event, [field]: bounded };
}

function redactHomePath(value: string): string {
  const homes = new Set([
    homedir(),
    process.env.USERPROFILE,
    process.env.HOME,
  ].map((item) => item?.trim()).filter((item): item is string => Boolean(item)));
  let redacted = value;
  for (const home of homes) {
    redacted = redacted.replaceAll(home, "[REDACTED:LOCAL_PATH]");
    redacted = redacted.replaceAll(home.replaceAll("\\", "/"), "[REDACTED:LOCAL_PATH]");
  }
  return redacted;
}

function stableJson(value: unknown): string {
  try {
    return JSON.stringify(sortJsonValue(value));
  } catch {
    return String(value ?? "");
  }
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (typeof value === "string") {
    return isBinaryDataUri(value) ? BINARY_CONTENT_OMITTED : value;
  }
  if (value === null || typeof value !== "object") return value;
  if (isSerializedBuffer(value)) return BINARY_CONTENT_OMITTED;
  const record = value as Record<string, unknown>;
  const mediaPayload = typeof record.type === "string"
    && ["audio", "image", "video"].includes(record.type.toLowerCase());
  return Object.fromEntries(
    Object.entries(record)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => [
        key,
        mediaPayload && ["base64", "blob", "data"].includes(key.toLowerCase())
          ? BINARY_CONTENT_OMITTED
          : sortJsonValue(item),
      ]),
  );
}

function isBinaryDataUri(value: string): boolean {
  return /^data:(?:application\/octet-stream|audio\/|image\/|video\/)[^,]*;base64,/iu.test(value);
}

function isSerializedBuffer(value: object): boolean {
  const record = value as Record<string, unknown>;
  return record.type === "Buffer" && Array.isArray(record.data);
}

function truncateText(value: string): string {
  const truncated = value.slice(0, CODING_TURN_TEXT_MAX_CHARS);
  return /[\uD800-\uDBFF]$/u.test(truncated) ? truncated.slice(0, -1) : truncated;
}

function boundedIdentifier(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? truncateText(normalized).slice(0, 255) : undefined;
}

function boundedEventIdentifier(value: string, maximum: number): string | undefined {
  const normalized = value.trim();
  return normalized && normalized.length <= maximum ? normalized : undefined;
}

function normalizedTimestamp(value: string): string | undefined {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}
