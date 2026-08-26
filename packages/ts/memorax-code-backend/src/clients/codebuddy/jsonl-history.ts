import { readFile } from "node:fs/promises";

export type CodeBuddyHistoryRecord = Readonly<Record<string, unknown>>;
export type CodeBuddyTurn = Readonly<{
  sessionId: string;
  turnId: string;
  sessionTurnIndex?: number;
  userPrompt: string;
  assistantReply: string;
  activities: readonly CodeBuddyActivity[];
}>;
export type CodeBuddyActivity = Readonly<{ kind: "tool"; name: string; input?: string; output?: string }>;
export type CodeBuddyTurnFailureReason =
  | "transcript_unavailable" | "malformed_transcript" | "turn_not_found"
  | "user_prompt_missing" | "assistant_message_missing" | "turn_ambiguous";
export type CodeBuddyTurnResult = { ok: true; turn: CodeBuddyTurn } | { ok: false; reason: CodeBuddyTurnFailureReason; error?: string };

const RECORD_OFFSET = Symbol("codebuddyRecordOffset");
type ParsedHistoryRecord = CodeBuddyHistoryRecord & { [RECORD_OFFSET]?: number };

export async function readCodeBuddyTranscriptTurn(input: {
  transcriptPath: string; sessionId: string; turnId: string; prompt?: string;
}): Promise<CodeBuddyTurnResult> {
  let text: string;
  try { text = await readFile(input.transcriptPath, "utf8"); }
  catch (error) { return { ok: false, reason: "transcript_unavailable", error: error instanceof Error ? error.message : String(error) }; }
  return codeBuddyTranscriptTurnFromJsonLines(text, input);
}

export function codeBuddyTranscriptTurnFromJsonLines(
  text: string,
  input: { sessionId: string; turnId: string; prompt?: string },
): CodeBuddyTurnResult {
  const records = parseJsonLines(text);
  if (!records) return { ok: false, reason: "malformed_transcript" };
  const hasSessionMarkers = records.some((record) => Boolean(stringField(record, "sessionId")));
  const session = records.filter((record) => hasSessionMarkers
    ? stringField(record, "sessionId") === input.sessionId
    : true);
  const users = session.filter((record) => record.role === "user" && visibleUserPrompt(record));
  const matching = users.filter((record) => {
    const prompt = visibleUserPrompt(record);
    return Boolean(prompt && (!input.prompt || prompt === input.prompt));
  });
  const boundary = turnBoundary(input);
  const bounded = boundary === undefined
    ? matching
    : matching.filter((record) => (record[RECORD_OFFSET] ?? Number.MAX_SAFE_INTEGER) >= boundary);
  // WorkBuddy can materialize the user record before invoking UserPromptSubmit.
  // In that race the provisional boundary is already past every matching user
  // record. Use the latest matching record, while retaining branch validation
  // below so forks and incomplete turns still fail closed.
  const provisional = boundary !== undefined
    && bounded.length === 0
    && matching.length > 0
    && matching.every((record) => (record[RECORD_OFFSET] ?? Number.MAX_SAFE_INTEGER) < boundary)
    ? matching
    : [];
  const candidates = bounded.length > 0 ? bounded : provisional;
  if (candidates.length === 0) return { ok: false, reason: "user_prompt_missing" };
  const latest = candidates[candidates.length - 1];
  const userId = stringField(latest, "id");
  if (!userId) return { ok: false, reason: "turn_not_found" };
  const branch = records.filter((record) => record.role === "assistant" && record.status === "completed" && belongsTo(record, userId, records));
  if (branch.length !== 1) return { ok: false, reason: branch.length > 1 ? "turn_ambiguous" : "assistant_message_missing" };
  const assistant = branch[0];
  const reply = assistantText(assistant);
  if (!reply) return { ok: false, reason: "assistant_message_missing" };
  return {
    ok: true,
    turn: {
      sessionId: input.sessionId,
      turnId: input.turnId,
      userPrompt: visibleUserPrompt(latest)!,
      assistantReply: reply,
      activities: activitiesBetween(records, userId, assistant),
      sessionTurnIndex: users.indexOf(latest) + 1,
    },
  };
}

function parseJsonLines(text: string): ParsedHistoryRecord[] | undefined {
  const records: ParsedHistoryRecord[] = [];
  let cursor = 0;
  let byteOffset = 0;
  while (cursor < text.length) {
    const newline = text.indexOf("\n", cursor);
    const lineEnd = newline >= 0 ? newline : text.length;
    const rawLine = text.slice(cursor, lineEnd);
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.trim()) {
      try {
        const parsed: unknown = JSON.parse(line);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          Object.defineProperty(parsed, RECORD_OFFSET, { configurable: false, enumerable: false, value: byteOffset });
          records.push(parsed as ParsedHistoryRecord);
        }
      } catch {
        return undefined;
      }
    }
    const newlineBytes = newline >= 0 ? (rawLine.endsWith("\r") ? 2 : 1) : 0;
    byteOffset += Buffer.byteLength(rawLine, "utf8") + newlineBytes;
    cursor = newline >= 0 ? newline + 1 : text.length;
  }
  const byId = new Map<string, CodeBuddyHistoryRecord>();
  const withoutId: CodeBuddyHistoryRecord[] = [];
  for (const record of records) {
    const id = stringField(record, "id");
    if (id) byId.set(id, record);
    else withoutId.push(record);
  }
  return [...withoutId, ...byId.values()];
}

function turnBoundary(input: { sessionId: string; turnId: string }): number | undefined {
  const prefix = `${input.sessionId}:`;
  if (!input.turnId.startsWith(prefix)) return undefined;
  const remainder = input.turnId.slice(prefix.length);
  const separator = remainder.indexOf(":");
  if (separator < 1) return undefined;
  const boundary = Number(remainder.slice(0, separator));
  return Number.isSafeInteger(boundary) && boundary >= 0 ? boundary : undefined;
}

function visibleUserPrompt(record: CodeBuddyHistoryRecord): string | undefined {
  const content = contentText(record.content);
  if (!content) return undefined;
  const match = content.match(/<user_query>([\s\S]*?)<\/user_query>/);
  return (match?.[1] ?? content).trim() || undefined;
}

function assistantText(record: CodeBuddyHistoryRecord): string | undefined {
  return contentText(record.content)?.trim() || undefined;
}

function contentText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  const parts = value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const text = (item as Record<string, unknown>).text;
    return typeof text === "string" ? [text] : [];
  });
  return parts.join("\n") || undefined;
}

function belongsTo(record: CodeBuddyHistoryRecord, userId: string, records: readonly CodeBuddyHistoryRecord[]): boolean {
  let current: CodeBuddyHistoryRecord | undefined = record;
  const seen = new Set<string>();
  for (let depth = 0; current && depth < 100; depth += 1) {
    const id = stringField(current, "id");
    if (id && seen.has(id)) return false;
    if (id) seen.add(id);
    const parent: string | undefined = stringField(current, "parentId") ?? stringField(current, "logicalParentId");
    if (!parent) return false;
    if (parent === userId) return true;
    current = records.find((candidate) => stringField(candidate, "id") === parent);
  }
  return false;
}

function activitiesBetween(records: readonly CodeBuddyHistoryRecord[], userId: string, assistant: CodeBuddyHistoryRecord): CodeBuddyActivity[] {
  const result: CodeBuddyActivity[] = [];
  for (const record of records) {
    const type = stringField(record, "type");
    if (type !== "function_call" && type !== "function_call_result") continue;
    if (!belongsTo(record, userId, records) || !belongsTo(assistant, userId, records)) continue;
    const name = stringField(record, "name") ?? stringField(record, "function") ?? "tool";
    result.push({ kind: "tool", name, ...(contentText(record.arguments) ? { input: contentText(record.arguments) } : {}), ...(contentText(record.output) ? { output: contentText(record.output) } : {}) });
  }
  return result;
}

function stringField(record: CodeBuddyHistoryRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
