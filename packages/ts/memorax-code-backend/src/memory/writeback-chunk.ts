import { createHash } from "node:crypto";
import {
  memoryWritebackChunkConfig,
  memoryWritebackChunkEnabled,
} from "../provider/memorax/config.js";

const CODE_CHUNK_GROUP_ID_PREFIX = "memory-writeback-chunk:v1:";

export type WritebackMessage = {
  role: "user" | "assistant";
  content: string;
};

export type MemoryWritebackAddPart = {
  idempotencyKey: string;
  messages: WritebackMessage[];
  chunk?: {
    group_id: string;
    index: number;
    count: number;
  };
};

export type MemoryWritebackChunkDecision = {
  idempotencyKey: string;
  messages: WritebackMessage[];
};

export function memoryWritebackAddParts(
  decision: MemoryWritebackChunkDecision,
  env: Record<string, string | undefined>,
): MemoryWritebackAddPart[] {
  if (!memoryWritebackChunkEnabled(env)) {
    return [{ idempotencyKey: decision.idempotencyKey, messages: decision.messages }];
  }
  const config = memoryWritebackChunkConfig(env);
  const payloads = chunkWritebackMessages(decision.messages, config);
  if (payloads.length <= 1) {
    return [{ idempotencyKey: decision.idempotencyKey, messages: payloads[0] ?? decision.messages }];
  }
  const groupId = codeChunkGroupId(decision.idempotencyKey);
  return payloads.map((messages, index) => ({
    idempotencyKey: `${decision.idempotencyKey}:part:${index}`,
    messages,
    chunk: {
      group_id: groupId,
      index,
      count: payloads.length,
    },
  }));
}

function codeChunkGroupId(idempotencyKey: string): string {
  return `${CODE_CHUNK_GROUP_ID_PREFIX}${createHash("sha256").update(idempotencyKey).digest("hex")}`;
}

export function writebackMessagesContentChars(messages: WritebackMessage[]): number {
  return messages.reduce((total, message) => total + message.content.length, 0);
}

function chunkWritebackMessages(
  messages: WritebackMessage[],
  config: { maxChars: number; overlapRatio: number },
): WritebackMessage[][] {
  const turns = writebackMessageTurns(messages);
  const payloads: WritebackMessage[][] = [];
  let current: WritebackMessage[] = [];
  const flushCurrent = () => {
    if (current.length > 0) {
      payloads.push(current);
      current = [];
    }
  };
  const appendCurrent = (payload: WritebackMessage[]) => {
    if (payload.length === 0) return;
    if (current.length > 0 && writebackMessagesContentChars([...current, ...payload]) > config.maxChars) {
      flushCurrent();
    }
    current.push(...payload);
  };

  for (const turn of turns) {
    const userChunks = turn.user ? chunkWritebackMessage(turn.user, config) : [];
    const assistantChunks = turn.assistants.flatMap((message) => chunkWritebackMessage(message, config));
    const needsDedicatedPayloads = userChunks.length > 1 || assistantChunks.length > turn.assistants.length;
    if (!needsDedicatedPayloads) {
      appendCurrent([...userChunks, ...assistantChunks]);
      continue;
    }
    flushCurrent();
    if (userChunks.length > 1) {
      if (assistantChunks.length === 0) {
        for (const userChunk of userChunks) payloads.push([userChunk]);
        continue;
      }
      for (const userChunk of userChunks.slice(0, -1)) payloads.push([userChunk]);
      payloads.push([userChunks[userChunks.length - 1], assistantChunks[0]]);
      for (const assistantChunk of assistantChunks.slice(1)) payloads.push([assistantChunk]);
      continue;
    }
    if (assistantChunks.length === 0) {
      if (userChunks.length === 1) payloads.push(userChunks);
      continue;
    }
    if (userChunks.length === 1) {
      payloads.push([userChunks[0], assistantChunks[0]]);
      for (const assistantChunk of assistantChunks.slice(1)) payloads.push([assistantChunk]);
      continue;
    }
    for (const assistantChunk of assistantChunks) payloads.push([assistantChunk]);
  }
  flushCurrent();
  return payloads.filter((payload) => payload.length > 0);
}

function writebackMessageTurns(messages: WritebackMessage[]): Array<{ user?: WritebackMessage; assistants: WritebackMessage[] }> {
  const turns: Array<{ user?: WritebackMessage; assistants: WritebackMessage[] }> = [];
  for (const message of messages) {
    if (message.role === "user") {
      turns.push({ user: message, assistants: [] });
      continue;
    }
    const turn = turns[turns.length - 1] ?? { assistants: [] };
    if (turns.length === 0) turns.push(turn);
    turn.assistants.push(message);
  }
  return turns;
}

function chunkWritebackMessage(
  message: WritebackMessage,
  config: { maxChars: number; overlapRatio: number },
): WritebackMessage[] {
  return splitTextWithOverlap(message.content, config.maxChars, config.overlapRatio)
    .map((content) => ({ role: message.role, content }))
    .filter((part) => part.content.trim());
}

function splitTextWithOverlap(text: string, maxChars: number, overlapRatio: number): string[] {
  if (text.length <= maxChars) return [text];
  const overlap = Math.min(Math.floor(maxChars * overlapRatio), Math.floor(maxChars / 2));
  const step = Math.max(1, maxChars - overlap);
  const chunks: string[] = [];
  for (let start = 0; start < text.length;) {
    const end = Math.min(text.length, start + maxChars);
    chunks.push(text.slice(start, end));
    if (end >= text.length) break;
    start += step;
  }
  return chunks;
}
