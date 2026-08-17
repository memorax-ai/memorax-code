import { isRecord } from "../../shared/record.js";

export type DshSessionTurn = Readonly<{
  sessionId: string;
  turn: number;
  startSeq: number;
  endSeq: number;
  userPrompt: string;
  assistantReply: string;
  outcome: string;
}>;

export type DshSessionTurnFailureReason =
  | "session_header_invalid"
  | "session_identity_mismatch"
  | "workspace_identity_mismatch"
  | "subagent_session"
  | "interval_length_mismatch"
  | "event_invalid"
  | "event_sequence_mismatch"
  | "turn_boundary_mismatch"
  | "turn_identity_mismatch"
  | "turn_not_completed"
  | "unknown_required_event"
  | "user_prompt_missing"
  | "assistant_message_missing";

type DshSessionTurnValidationFailureReason = Exclude<
  DshSessionTurnFailureReason,
  "turn_not_completed"
>;

export type DshSessionTurnResult =
  | { ok: true; turn: DshSessionTurn }
  | { ok: false; reason: DshSessionTurnValidationFailureReason }
  | { ok: false; reason: "turn_not_completed"; outcome: string };

type DshSessionTurnInput = Readonly<{
  sessionId: string;
  turn: number;
  startSeq: number;
  endSeq: number;
  cwd: string;
  sessionHeader: Readonly<Record<string, unknown>>;
  events: readonly unknown[];
}>;

const DSH_SESSION_FORMAT_VERSION = 0;
// Mirrors the supported DSH persistence catalog. Events outside this
// vocabulary are safe to skip only when their envelope explicitly says so.
const KNOWN_SESSION_EVENT_TYPES = new Set([
  "agent-preset/selected",
  "agent/inbox/spliced",
  "approval/asked",
  "approval/decided",
  "approval/policy",
  "turn/start",
  "turn/end",
  "step/start",
  "step/end",
  "user/message",
  "assistant/chunk",
  "assistant/message",
  "command/done",
  "command/run",
  "compaction/end",
  "compaction/prune",
  "compaction/start",
  "compaction/summary",
  "feedback/record",
  "goal/change",
  "hook/invoked",
  "hook/result",
  "llm/retry",
  "llm/retry-started",
  "permission/preset",
  "plan/mode",
  "tool/call",
  "tool/code-dispatch",
  "tool/code-dispatch-start",
  "tool/result",
  "todo/write",
  "request/header",
  "request/context",
  "sandbox/mode",
  "schedule/change",
  "session/end-seed",
  "session/title",
  "session/title-llm-request",
  "subagent/descriptor",
  "tool-workflow/agent-end",
  "tool-workflow/agent-start",
  "tool-workflow/run-end",
  "tool-workflow/run-start",
  "web/deepseek-search-llm-request",
]);
const TURN_IDENTITY_REQUIRED_EVENT_TYPES = new Set([
  "turn/start",
  "turn/end",
  "assistant/message",
]);

export function dshSessionEventTurn(input: DshSessionTurnInput): DshSessionTurnResult {
  const header = validateSessionHeader(input);
  if (header) return { ok: false, reason: header };
  if (
    input.events.length === 0
    || input.endSeq - input.startSeq !== input.events.length - 1
  ) {
    return { ok: false, reason: "interval_length_mismatch" };
  }
  const first = input.events[0];
  const last = input.events[input.events.length - 1];
  if (
    !isRecord(first)
    || first.type !== "turn/start"
    || !isRecord(last)
    || last.type !== "turn/end"
  ) return { ok: false, reason: "turn_boundary_mismatch" };

  const userParts: string[] = [];
  const assistantParts: string[] = [];
  let outcome: string | undefined;

  for (const [index, value] of input.events.entries()) {
    if (!isRecord(value)) return { ok: false, reason: "event_invalid" };
    const type = stringField(value, "type");
    const seq = safeIntegerField(value, "seq", 0);
    if (!type || seq === undefined) {
      return { ok: false, reason: "event_invalid" };
    }
    if (seq !== input.startSeq + index) {
      return { ok: false, reason: "event_sequence_mismatch" };
    }
    if (Object.prototype.hasOwnProperty.call(value, "ignorable") && value.ignorable !== true) {
      return { ok: false, reason: "event_invalid" };
    }
    if (!KNOWN_SESSION_EVENT_TYPES.has(type)) {
      if (value.ignorable === true) continue;
      return { ok: false, reason: "unknown_required_event" };
    }

    const data = isRecord(value.data) ? value.data : undefined;
    const carriesTurn = data ? Object.prototype.hasOwnProperty.call(data, "turn") : false;
    const eventTurn = data && carriesTurn ? safeIntegerField(data, "turn", 1) : undefined;
    if (
      (carriesTurn && eventTurn === undefined)
      || (TURN_IDENTITY_REQUIRED_EVENT_TYPES.has(type) && eventTurn === undefined)
    ) return { ok: false, reason: "event_invalid" };
    if (eventTurn !== undefined && eventTurn !== input.turn) {
      return { ok: false, reason: "turn_identity_mismatch" };
    }
    if (
      (type === "turn/start" && index !== 0)
      || (type === "turn/end" && index !== input.events.length - 1)
    ) {
      return { ok: false, reason: "turn_boundary_mismatch" };
    }

    switch (type) {
      case "turn/start":
        break;
      case "turn/end": {
        const reason = data && isRecord(data.reason) ? stringField(data.reason, "kind") : undefined;
        if (!reason) return { ok: false, reason: "event_invalid" };
        outcome = reason;
        break;
      }
      case "user/message": {
        if (!data) return { ok: false, reason: "event_invalid" };
        const message = messageEnvelope(data, "user");
        if (!message || !validSurfaceOp(value.surfaceOp)) {
          return { ok: false, reason: "event_invalid" };
        }
        if (message.source.kind === "user") {
          if (value.surfaceOp !== "append") {
            return { ok: false, reason: "event_invalid" };
          }
          const text = textContent(message.content);
          if (text === undefined) return { ok: false, reason: "event_invalid" };
          if (text) userParts.push(text);
        }
        break;
      }
      case "assistant/message": {
        if (!data || value.surfaceOp !== "append" || !isRecord(data.message)) {
          return { ok: false, reason: "event_invalid" };
        }
        const message = messageEnvelope(data.message, "assistant");
        if (
          !message
          || message.source.kind !== "model"
          || !stringField(message.source, "provider")
          || !stringField(message.source, "model")
        ) return { ok: false, reason: "event_invalid" };
        const text = textContent(message.content);
        if (text === undefined) return { ok: false, reason: "event_invalid" };
        if (text) assistantParts.push(text);
        break;
      }
    }
  }

  if (!outcome) return { ok: false, reason: "turn_boundary_mismatch" };
  if (outcome !== "completed") {
    return { ok: false, reason: "turn_not_completed", outcome };
  }
  const userPrompt = userParts.join("\n\n").trim();
  if (!userPrompt) return { ok: false, reason: "user_prompt_missing" };
  const assistantReply = assistantParts.join("\n\n").trim();
  if (!assistantReply) return { ok: false, reason: "assistant_message_missing" };
  return {
    ok: true,
    turn: {
      sessionId: input.sessionId,
      turn: input.turn,
      startSeq: input.startSeq,
      endSeq: input.endSeq,
      userPrompt,
      assistantReply,
      outcome,
    },
  };
}

function validateSessionHeader(
  input: DshSessionTurnInput,
): DshSessionTurnValidationFailureReason | undefined {
  const header = input.sessionHeader;
  if (
    header.version !== DSH_SESSION_FORMAT_VERSION
    || safeIntegerField(header, "createdAt", 0) === undefined
  ) return "session_header_invalid";
  if (stringField(header, "id") !== input.sessionId) return "session_identity_mismatch";
  if (stringField(header, "cwd") !== input.cwd) return "workspace_identity_mismatch";
  if (Object.prototype.hasOwnProperty.call(header, "parentSession")) {
    if (!stringField(header, "parentSession")) return "session_header_invalid";
  }
  if (Object.prototype.hasOwnProperty.call(header, "origin")) {
    if (header.origin !== "subagent") return "session_header_invalid";
    return "subagent_session";
  }
  const delegationDepth = optionalSafeIntegerField(header, "delegationDepth", 0);
  if (!delegationDepth.ok) return "session_header_invalid";
  if ((delegationDepth.value ?? 0) > 0) return "subagent_session";
  return undefined;
}

type MessageEnvelope = Readonly<{
  content: readonly unknown[];
  source: Record<string, unknown>;
}>;

function messageEnvelope(value: Record<string, unknown>, role: "user" | "assistant"): MessageEnvelope | undefined {
  if (
    value.role !== role
    || !Array.isArray(value.content)
    || !isRecord(value.source)
    || !stringField(value.source, "kind")
  ) return undefined;
  return { content: value.content, source: value.source };
}

function textContent(content: readonly unknown[]): string | undefined {
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block) || !stringField(block, "type")) return undefined;
    if (block.type !== "text") continue;
    if (typeof block.text !== "string") return undefined;
    if (block.text.trim()) parts.push(block.text);
  }
  return parts.join("\n").trim();
}

function validSurfaceOp(value: unknown): boolean {
  if (value === "append") return true;
  return isRecord(value)
    && Object.keys(value).length === 3
    && value.op === "replace"
    && safeIntegerField(value, "start", 0) !== undefined
    && safeIntegerField(value, "end", 0) !== undefined;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function safeIntegerField(
  record: Record<string, unknown>,
  key: string,
  minimum: number,
): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum
    ? value
    : undefined;
}

function optionalSafeIntegerField(
  record: Record<string, unknown>,
  key: string,
  minimum: number,
): { ok: true; value?: number } | { ok: false } {
  if (!Object.prototype.hasOwnProperty.call(record, key)) return { ok: true };
  const value = safeIntegerField(record, key, minimum);
  return value === undefined ? { ok: false } : { ok: true, value };
}
