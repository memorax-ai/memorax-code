import { isRecord } from "../../shared/record.js";

export type OpenCodeMessageTurn = Readonly<{
  sessionId: string;
  userMessageId: string;
  assistantMessageId: string;
  userPrompt: string;
  assistantReply: string;
  outcome: "completed" | "interrupted";
}>;

export type OpenCodeMessageTurnFailureReason =
  | "user_message_not_found"
  | "assistant_message_not_found"
  | "message_identity_mismatch"
  | "assistant_not_completed"
  | "assistant_error"
  | "summary_message"
  | "compaction_message"
  | "user_prompt_missing"
  | "assistant_message_missing";

export type OpenCodeMessageTurnResult =
  | { ok: true; turn: OpenCodeMessageTurn }
  | { ok: false; reason: OpenCodeMessageTurnFailureReason };

export function openCodeMessageTurn(
  messages: readonly unknown[],
  input: {
    sessionId: string;
    userMessageId: string;
    assistantMessageId: string;
  },
): OpenCodeMessageTurnResult {
  const user = messages.find((message) => messageId(message) === input.userMessageId);
  if (!isMessageRecord(user) || user.info.role !== "user") {
    return { ok: false, reason: "user_message_not_found" };
  }
  const assistant = messages.find((message) => messageId(message) === input.assistantMessageId);
  if (!isMessageRecord(assistant) || assistant.info.role !== "assistant") {
    return { ok: false, reason: "assistant_message_not_found" };
  }
  if (
    stringField(user.info, "sessionID") !== input.sessionId
    || stringField(assistant.info, "sessionID") !== input.sessionId
    || !assistantBelongsToTurn(messages, input, assistant)
  ) {
    return { ok: false, reason: "message_identity_mismatch" };
  }
  const assistantTime = isRecord(assistant.info.time) ? assistant.info.time : undefined;
  if (!Number.isFinite(assistantTime?.completed)) {
    return { ok: false, reason: "assistant_not_completed" };
  }
  const assistantError = assistant.info.error;
  const interrupted = isRecord(assistantError) && stringField(assistantError, "name") !== undefined;
  if (assistantError !== undefined && assistantError !== null && !interrupted) {
    return { ok: false, reason: "assistant_error" };
  }
  if (assistant.info.summary === true) {
    return { ok: false, reason: "summary_message" };
  }
  if (hasCompactionPart(user.parts) || hasCompactionPart(assistant.parts)) {
    return { ok: false, reason: "compaction_message" };
  }
  const userPrompt = messageText(user, input.sessionId, input.userMessageId);
  if (!userPrompt) return { ok: false, reason: "user_prompt_missing" };
  const assistantReply = messageText(assistant, input.sessionId, input.assistantMessageId);
  if (!assistantReply && !interrupted) return { ok: false, reason: "assistant_message_missing" };
  return {
    ok: true,
    turn: {
      sessionId: input.sessionId,
      userMessageId: input.userMessageId,
      assistantMessageId: input.assistantMessageId,
      userPrompt,
      assistantReply,
      outcome: interrupted ? "interrupted" : "completed",
    },
  };
}

function assistantBelongsToTurn(
  messages: readonly unknown[],
  input: { sessionId: string; userMessageId: string },
  assistant: OpenCodeMessageRecord,
): boolean {
  return stringField(assistant.info, "parentID") === terminalUserMessageFor(messages, input);
}

function terminalUserMessageFor(
  messages: readonly unknown[],
  input: { sessionId: string; userMessageId: string },
): string | undefined {
  const sessionMessages = messages.filter((message): message is OpenCodeMessageRecord => (
    isMessageRecord(message)
    && stringField(message.info, "sessionID") === input.sessionId
    && messageId(message) !== undefined
  ));
  const startIndex = sessionMessages.findIndex((message) => (
    message.info.role === "user" && messageId(message) === input.userMessageId
  ));
  if (startIndex < 0) return undefined;
  const lineageAssistantIds = new Set<string>();
  let terminalUserMessageId = input.userMessageId;
  let awaitingContinuation = false;

  for (const message of sessionMessages.slice(startIndex + 1)) {
    if (message.info.role === "assistant") {
      if (stringField(message.info, "parentID") === terminalUserMessageId) {
        const id = messageId(message);
        if (id) lineageAssistantIds.add(id);
      }
      continue;
    }
    if (message.info.role !== "user") continue;
    if (hasCompactionPart(message.parts)) {
      const compactionTailId = compactionTailStartId(message, input.sessionId);
      if (!compactionTailId || !lineageAssistantIds.has(compactionTailId) || awaitingContinuation) {
        return undefined;
      }
      awaitingContinuation = true;
      continue;
    }
    if (isCompactionContinuation(message, input.sessionId)) {
      if (!awaitingContinuation) return undefined;
      const id = messageId(message);
      if (!id) return undefined;
      terminalUserMessageId = id;
      awaitingContinuation = false;
      continue;
    }
    break;
  }
  return !awaitingContinuation ? terminalUserMessageId : undefined;
}

type OpenCodeMessageRecord = Readonly<{
  info: Record<string, unknown>;
  parts: readonly unknown[];
}>;

function isMessageRecord(value: unknown): value is OpenCodeMessageRecord {
  return isRecord(value) && isRecord(value.info) && Array.isArray(value.parts);
}

function messageId(value: unknown): string | undefined {
  return isMessageRecord(value) ? stringField(value.info, "id") : undefined;
}

function messageText(
  message: OpenCodeMessageRecord,
  sessionId: string,
  messageId: string,
): string {
  return message.parts
    .flatMap((part): string[] => {
      if (!isRecord(part)
        || part.type !== "text"
        || part.synthetic === true
        || part.ignored === true
        || stringField(part, "sessionID") !== sessionId
        || stringField(part, "messageID") !== messageId) {
        return [];
      }
      const text = stringField(part, "text");
      return text ? [text] : [];
    })
    .join("\n\n")
    .trim();
}

function hasCompactionPart(parts: readonly unknown[]): boolean {
  return parts.some((part) => isRecord(part) && part.type === "compaction");
}

function compactionTailStartId(
  message: OpenCodeMessageRecord,
  sessionId: string,
): string | undefined {
  const id = messageId(message);
  const parts = message.parts.filter((part) => (
    isRecord(part)
    && part.type === "compaction"
    && stringField(part, "sessionID") === sessionId
    && stringField(part, "messageID") === id
  ));
  if (parts.length !== 1 || !isRecord(parts[0])) return undefined;
  return stringField(parts[0], "tail_start_id");
}

function isCompactionContinuation(
  message: OpenCodeMessageRecord,
  sessionId: string,
): boolean {
  const id = messageId(message);
  return message.parts.some((part) => (
    isRecord(part)
    && part.type === "text"
    && part.synthetic === true
    && isRecord(part.metadata)
    && part.metadata.compaction_continue === true
    && stringField(part, "sessionID") === sessionId
    && stringField(part, "messageID") === id
  ));
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" && field.trim() ? field.trim() : undefined;
}
