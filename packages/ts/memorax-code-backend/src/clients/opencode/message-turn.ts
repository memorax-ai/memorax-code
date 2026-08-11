import { isRecord } from "../../shared/record.js";

export type OpenCodeMessageTurn = Readonly<{
  sessionId: string;
  userMessageId: string;
  assistantMessageId: string;
  userPrompt: string;
  assistantReply: string;
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
    || stringField(assistant.info, "parentID") !== input.userMessageId
  ) {
    return { ok: false, reason: "message_identity_mismatch" };
  }
  const assistantTime = isRecord(assistant.info.time) ? assistant.info.time : undefined;
  if (!Number.isFinite(assistantTime?.completed)) {
    return { ok: false, reason: "assistant_not_completed" };
  }
  if (assistant.info.error !== undefined && assistant.info.error !== null) {
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
  if (!assistantReply) return { ok: false, reason: "assistant_message_missing" };
  return {
    ok: true,
    turn: {
      sessionId: input.sessionId,
      userMessageId: input.userMessageId,
      assistantMessageId: input.assistantMessageId,
      userPrompt,
      assistantReply,
    },
  };
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

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" && field.trim() ? field.trim() : undefined;
}
