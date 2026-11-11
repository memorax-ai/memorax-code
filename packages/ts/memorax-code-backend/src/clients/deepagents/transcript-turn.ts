import { readFile } from "node:fs/promises";
import { parseNativeMessageTimestamp } from "../../shared/message-time.js";

type JsonRecord = Record<string, unknown>;

export type DeepAgentsTurnTokenUsage = {
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
  cache_creation: {
    ephemeral_1h_input_tokens: number;
    ephemeral_5m_input_tokens: number;
  };
  server_tool_use: {
    web_search_requests: number;
    web_fetch_requests: number;
  };
};

export type DeepAgentsTurnActivity = Readonly<{
  index: number;
  type: "memory_cli_search" | "memory_cli_add";
}>;

export type DeepAgentsTranscriptTurn = {
  sessionId: string;
  promptId: string;
  sessionTurnIndex: number;
  userPrompt: string;
  assistantReply: string;
  userTimestamp?: number;
  assistantTimestamp?: number;
  activities: DeepAgentsTurnActivity[];
  usage?: DeepAgentsTurnTokenUsage;
};

export type DeepAgentsTranscriptTurnFailureReason =
  | "transcript_unavailable"
  | "user_prompt_missing"
  | "assistant_message_missing";

export type DeepAgentsTranscriptTurnResult =
  | { ok: true; turn: DeepAgentsTranscriptTurn }
  | { ok: false; reason: DeepAgentsTranscriptTurnFailureReason; error?: string };

export type DeepAgentsInterruptedTranscriptTurn = DeepAgentsTranscriptTurn & {
  interruptedAt?: string;
};

export type DeepAgentsInterruptedTranscriptTurnFailureReason =
  | DeepAgentsTranscriptTurnFailureReason
  | "turn_not_interrupted";

export type DeepAgentsInterruptedTranscriptTurnResult =
  | { ok: true; turn: DeepAgentsInterruptedTranscriptTurn }
  | { ok: false; reason: DeepAgentsInterruptedTranscriptTurnFailureReason; error?: string };

export type DeepAgentsTranscriptTurnInput = {
  sessionId: string;
  promptId: string;
  prompt?: string;
  lastAssistantMessage?: string;
};

export async function readDeepAgentsTranscriptTurn(
  input: DeepAgentsTranscriptTurnInput & { transcriptPath: string },
): Promise<DeepAgentsTranscriptTurnResult> {
  const transcript = await readTranscript(input.transcriptPath);
  if (!transcript.ok) return transcript;
  return deepAgentsTranscriptTurnFromJsonLines(transcript.text, input);
}

export async function readDeepAgentsInterruptedTranscriptTurn(
  input: DeepAgentsTranscriptTurnInput & { transcriptPath: string },
): Promise<DeepAgentsInterruptedTranscriptTurnResult> {
  const transcript = await readTranscript(input.transcriptPath);
  if (!transcript.ok) return transcript;
  return deepAgentsInterruptedTranscriptTurnFromJsonLines(transcript.text, input);
}

async function readTranscript(path: string): Promise<
  | { ok: true; text: string }
  | { ok: false; reason: "transcript_unavailable"; error: string }
> {
  try {
    return { ok: true, text: await readFile(path, "utf8") };
  } catch (error) {
    return {
      ok: false,
      reason: "transcript_unavailable",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Aligns one Hook turn with the `dcode` transcript projection.
 *
 * Upstream projection records expose `thread_id`, `sequence`, `role`, and
 * `content`; they do not carry a prompt id, parent pointer, stop reason, or
 * usage. Stop's `last_assistant_message` is therefore the reply authority.
 */
export function deepAgentsTranscriptTurnFromJsonLines(
  transcript: string,
  input: DeepAgentsTranscriptTurnInput,
): DeepAgentsTranscriptTurnResult {
  const parsed = requestedTranscriptRecords(transcript, input.sessionId);
  if (!parsed.ok) return parsed;
  const records = parsed.records;
  const userTurns = userTurnRecords(records);
  const selected = selectUserTurn(userTurns, input.prompt);
  const userPrompt = selected ? visibleContentText(selected.content) : nonBlank(input.prompt);
  if (!userPrompt) return { ok: false, reason: "user_prompt_missing" };

  const assistantReply = nonBlank(input.lastAssistantMessage)
    ?? assistantTextAfter(records, selected);
  if (!assistantReply) return { ok: false, reason: "assistant_message_missing" };

  const assistantRecords = assistantRecordsAfter(records, selected);
  const sessionTurnIndex = selected
    ? userTurns.findIndex((record) => sameRecord(record, selected)) + 1
    : userTurns.length + 1;
  return {
    ok: true,
    turn: {
      sessionId: input.sessionId,
      promptId: input.promptId,
      sessionTurnIndex,
      userPrompt,
      assistantReply,
      ...(selected && parseNativeMessageTimestamp(selected.timestamp) !== undefined
        ? { userTimestamp: parseNativeMessageTimestamp(selected.timestamp) }
        : {}),
      ...(lastTimestamp(assistantRecords) !== undefined
        ? { assistantTimestamp: lastTimestamp(assistantRecords) }
        : {}),
      activities: deepAgentsMemoryActivities(assistantRecords),
    },
  };
}

export function deepAgentsInterruptedTranscriptTurnFromJsonLines(
  transcript: string,
  input: DeepAgentsTranscriptTurnInput,
): DeepAgentsInterruptedTranscriptTurnResult {
  const parsed = requestedTranscriptRecords(transcript, input.sessionId);
  if (!parsed.ok) return parsed;
  const records = parsed.records;
  const userTurns = userTurnRecords(records);
  // The open turn is the latest user turn when the next UserPromptSubmit
  // reconciles it. No prompt id or parent pointer exists in this projection.
  const selected = userTurns.at(-1);
  const userPrompt = selected ? visibleContentText(selected.content) : nonBlank(input.prompt);
  if (!userPrompt) return { ok: false, reason: "user_prompt_missing" };
  const assistantRecords = assistantRecordsAfter(records, selected);
  const assistantReply = assistantText(assistantRecords);
  if (!assistantReply) return { ok: false, reason: "assistant_message_missing" };
  const interruptedAt = lastTimestamp(assistantRecords);
  return {
    ok: true,
    turn: {
      sessionId: input.sessionId,
      promptId: input.promptId,
      sessionTurnIndex: userTurns.length,
      userPrompt,
      assistantReply,
      ...(selected && parseNativeMessageTimestamp(selected.timestamp) !== undefined
        ? { userTimestamp: parseNativeMessageTimestamp(selected.timestamp) }
        : {}),
      ...(interruptedAt !== undefined ? { assistantTimestamp: interruptedAt } : {}),
      activities: deepAgentsMemoryActivities(assistantRecords),
    },
  };
}

function requestedTranscriptRecords(
  transcript: string,
  sessionId: string,
):
  | { ok: true; records: JsonRecord[] }
  | { ok: false; reason: "transcript_unavailable"; error?: string } {
  const parsed = transcriptRecords(transcript);
  if (!parsed.ok) {
    return {
      ok: false,
      reason: "transcript_unavailable",
      error: "Deep Agents transcript contains an invalid completed JSONL record.",
    };
  }
  const mainRecords = parsed.records.filter((record) => (
    record.agent_id === null || record.agent_id === undefined
  ));
  const threadIds = new Set(
    mainRecords.map((record) => stringValue(record.thread_id)).filter(isString),
  );
  // `session_id` and `thread_id` are different identities upstream. A per-thread
  // projection may therefore have one thread id that never equals the Hook
  // session id. Only contradictory multi-thread files need a deterministic filter.
  const selectedThread = threadIds.has(sessionId)
    ? sessionId
    : threadIds.size === 1
      ? [...threadIds][0]
      : lastThreadId(mainRecords);
  return {
    ok: true,
    records: selectedThread
      ? mainRecords.filter((record) => {
        const threadId = stringValue(record.thread_id);
        return !threadId || threadId === selectedThread;
      })
      : mainRecords,
  };
}

function transcriptRecords(transcript: string):
  | { ok: true; records: JsonRecord[] }
  | { ok: false } {
  const records: JsonRecord[] = [];
  const lines = transcript.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!isRecord(parsed)) return { ok: false };
      records.push(parsed);
    } catch {
      // dcode materializes a snapshot before Hooks run, but an unterminated tail
      // line is still tolerated so a concurrent append cannot fail the Hook.
      if (records.length > 0 && index === lines.length - 1 && !transcript.endsWith("\n")) continue;
      return { ok: false };
    }
  }
  return { ok: true, records };
}

function userTurnRecords(records: JsonRecord[]): JsonRecord[] {
  return records
    .filter((record) => record.role === "user" && Boolean(visibleContentText(record.content)))
    .sort(compareSequence);
}

function assistantRecordsAfter(
  records: JsonRecord[],
  userRecord: JsonRecord | undefined,
): JsonRecord[] {
  if (!userRecord) return [];
  const start = sequenceOf(userRecord);
  if (start === undefined) return [];
  const startSequence = start;
  const nextUserSequence = records
    .filter((record) => record.role === "user")
    .map(sequenceOf)
    .filter(isNumber)
    .filter((sequence) => sequence > startSequence)
    .reduce<number | undefined>((minimum, sequence) => (
      minimum === undefined || sequence < minimum ? sequence : minimum
    ), undefined);
  return records
    .filter((record) => {
      const sequence = sequenceOf(record);
      return record.role === "assistant"
        && sequence !== undefined
        && sequence > startSequence
        && (nextUserSequence === undefined || sequence < nextUserSequence);
    })
    .sort(compareSequence);
}

function selectUserTurn(
  userTurns: JsonRecord[],
  prompt: string | undefined,
): JsonRecord | undefined {
  const target = normalizeText(prompt);
  if (target) {
    const exact = userTurns.filter((record) => normalizeText(visibleContentText(record.content)) === target);
    if (exact.length > 0) return exact.at(-1);
    const containing = userTurns.filter((record) => {
      const text = normalizeText(visibleContentText(record.content));
      return Boolean(text) && (text.includes(target) || target.includes(text));
    });
    if (containing.length > 0) return containing.at(-1);
  }
  return userTurns.at(-1);
}

function assistantTextAfter(
  records: JsonRecord[],
  userRecord: JsonRecord | undefined,
): string | undefined {
  return assistantText(assistantRecordsAfter(records, userRecord));
}

function assistantText(assistantRecords: JsonRecord[]): string | undefined {
  const texts: string[] = [];
  const seen = new Set<string>();
  for (const record of assistantRecords) {
    const text = visibleContentText(record.content);
    if (!text) continue;
    const key = `${stringValue(record.message_id) ?? stringValue(record.record_id) ?? ""}\u0000${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    texts.push(text);
  }
  return texts.length > 0 ? texts.join("\n\n") : undefined;
}

function visibleContentText(content: unknown): string | undefined {
  if (typeof content === "string") return nonBlank(content);
  if (Array.isArray(content)) {
    const text = content
      .map((part) => {
        if (!isRecord(part)) return undefined;
        if (part.type === "text") return nonBlank(part.text);
        if (part.type === "input_text" && part.text !== undefined) return nonBlank(part.text);
        return undefined;
      })
      .filter(isString)
      .join("\n\n")
      .trim();
    return text || undefined;
  }
  if (isRecord(content) && "text" in content) return nonBlank(content.text);
  return undefined;
}

function memoryCliCommandTypes(command: string): DeepAgentsTurnActivity["type"][] {
  const activities: DeepAgentsTurnActivity["type"][] = [];
  const pattern = /(?:^|[;&|\n])\s*(?:[^\s;&|]*[\\/])?memorax-cli(?:\.cmd|\.mjs)?\s+(search|add)\b/giu;
  for (const match of command.matchAll(pattern)) {
    if (match[1]?.toLowerCase() === "search") activities.push("memory_cli_search");
    if (match[1]?.toLowerCase() === "add") activities.push("memory_cli_add");
  }
  return activities;
}

function deepAgentsMemoryActivities(
  assistantRecords: JsonRecord[],
): DeepAgentsTurnActivity[] {
  const activities: DeepAgentsTurnActivity[] = [];
  const seenIds = new Set<string>();
  let index = 1;
  for (const record of assistantRecords.slice().reverse()) {
    const blocks = Array.isArray(record.content)
      ? record.content
      : isRecord(record.content) && Array.isArray(record.content.content) ? record.content.content : [];
    for (const block of blocks) {
      if (!isRecord(block)) continue;
      const toolCall = toolCallFromBlock(block);
      if (!toolCall) continue;
      const toolUseId = toolCall.id ?? stringValue(record.record_id);
      if (!toolUseId || seenIds.has(toolUseId)) continue;
      seenIds.add(toolUseId);
      if (!isShellToolName(toolCall.name)) continue;
      const command = toolCall.command;
      if (!command) continue;
      const types = memoryCliCommandTypes(command);
      if (types.length === 0) continue;
      for (const type of types) {
        activities.push({
          index,
          type,
        });
      }
      index += 1;
    }
  }
  return activities;
}

type DeepAgentsToolCall = {
  id?: string;
  name: string;
  command?: string;
};

function toolCallFromBlock(block: JsonRecord): DeepAgentsToolCall | undefined {
  const type = stringValue(block.type);
  if (type !== "tool_use" && type !== "tool_call" && type !== "function_call") return undefined;
  const name = stringValue(block.name);
  if (!name) return undefined;
  const input = isRecord(block.input)
    ? block.input
    : isRecord(block.args)
      ? block.args
      : isRecord(block.arguments)
        ? block.arguments
        : undefined;
  return {
    ...(stringValue(block.id) ? { id: stringValue(block.id) } : {}),
    name,
    ...(input && stringValue(input.command) ? { command: stringValue(input.command) } : {}),
  };
}

function isShellToolName(name: string): boolean {
  const normalized = name.toLowerCase().replaceAll(/[-_ ]/g, "");
  return normalized === "bash"
    || normalized === "shell"
    || normalized === "terminal"
    || normalized === "runcommand"
    || normalized === "executeshell";
}

function lastTimestamp(records: JsonRecord[]): number | undefined {
  for (const record of records.slice().reverse()) {
    const timestamp = parseNativeMessageTimestamp(record.timestamp);
    if (timestamp !== undefined) return timestamp;
  }
  return undefined;
}

function lastThreadId(records: JsonRecord[]): string | undefined {
  for (const record of records.slice().reverse()) {
    const threadId = stringValue(record.thread_id);
    if (threadId) return threadId;
  }
  return undefined;
}

function sequenceOf(record: JsonRecord): number | undefined {
  const sequence = record.sequence;
  return Number.isSafeInteger(sequence) && Number(sequence) >= 0 ? Number(sequence) : undefined;
}

function compareSequence(left: JsonRecord, right: JsonRecord): number {
  const leftSequence = sequenceOf(left) ?? Number.MAX_SAFE_INTEGER;
  const rightSequence = sequenceOf(right) ?? Number.MAX_SAFE_INTEGER;
  return leftSequence - rightSequence;
}

function sameRecord(left: JsonRecord, right: JsonRecord): boolean {
  if (left === right) return true;
  const leftRecordId = stringValue(left.record_id);
  const rightRecordId = stringValue(right.record_id);
  return Boolean(leftRecordId && rightRecordId && leftRecordId === rightRecordId);
}

function normalizeText(value: string | undefined): string {
  return (value ?? "").trim().replaceAll(/\s+/g, " ");
}

function nonBlank(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function isString(value: string | undefined): value is string {
  return value !== undefined;
}

function isNumber(value: number | undefined): value is number {
  return value !== undefined;
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
