import { readFile } from "node:fs/promises";
import { codeBuddyPromptDigest, parseCodeBuddyTurnId } from "./turn-id.js";

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
  | "user_prompt_missing" | "assistant_message_missing" | "turn_ambiguous"
  | "transcript_path_mismatch";
export type CodeBuddyTurnResult = { ok: true; turn: CodeBuddyTurn } | { ok: false; reason: CodeBuddyTurnFailureReason; error?: string };
export type CodeBuddyInterruptedTurn = CodeBuddyTurn;
export type CodeBuddyInterruptedTurnFailureReason =
  | Exclude<CodeBuddyTurnFailureReason, "assistant_message_missing" | "transcript_path_mismatch">
  | "turn_not_interrupted";
export type CodeBuddyInterruptedTurnResult =
  | { ok: true; turn: CodeBuddyInterruptedTurn }
  | { ok: false; reason: CodeBuddyInterruptedTurnFailureReason; error?: string };

const RECORD_OFFSET = Symbol("codebuddyRecordOffset");
type ParsedHistoryRecord = CodeBuddyHistoryRecord & { [RECORD_OFFSET]?: number };

export async function readCodeBuddyTranscriptTurn(input: {
  transcriptPath: string; sessionId: string; turnId: string;
}): Promise<CodeBuddyTurnResult> {
  let text: string;
  try { text = await readFile(input.transcriptPath, "utf8"); }
  catch (error) { return { ok: false, reason: "transcript_unavailable", error: error instanceof Error ? error.message : String(error) }; }
  return codeBuddyTranscriptTurnFromJsonLines(text, input);
}

export async function readCodeBuddyInterruptedTranscriptTurn(input: {
  transcriptPath: string; sessionId: string; turnId: string;
}): Promise<CodeBuddyInterruptedTurnResult> {
  let text: string;
  try { text = await readFile(input.transcriptPath, "utf8"); }
  catch (error) { return { ok: false, reason: "transcript_unavailable", error: error instanceof Error ? error.message : String(error) }; }
  return codeBuddyInterruptedTranscriptTurnFromJsonLines(text, input);
}

export function codeBuddyTranscriptTurnFromJsonLines(
  text: string,
  input: { sessionId: string; turnId: string },
): CodeBuddyTurnResult {
  const selected = selectCodeBuddyTurnBranch(text, input);
  if (!selected.ok) return selected;
  const branch = selected.records.filter((record) => record.role === "assistant" && record.status === "completed");
  if (branch.length !== 1) return { ok: false, reason: branch.length > 1 ? "turn_ambiguous" : "assistant_message_missing" };
  const assistant = branch[0];
  const reply = assistantText(assistant);
  if (!reply) return { ok: false, reason: "assistant_message_missing" };
  return {
    ok: true,
    turn: {
      sessionId: input.sessionId,
      turnId: input.turnId,
      userPrompt: selected.userPrompt,
      assistantReply: reply,
      activities: turnActivities(selected.records),
      sessionTurnIndex: selected.sessionTurnIndex,
    },
  };
}

export function codeBuddyInterruptedTranscriptTurnFromJsonLines(
  text: string,
  input: { sessionId: string; turnId: string },
): CodeBuddyInterruptedTurnResult {
  const selected = selectCodeBuddyTurnBranch(text, input);
  if (!selected.ok) return selected;
  const assistants = selected.records.filter((record) => (
    record.role === "assistant"
    && (record.type === "message" || stringField(record, "status") !== undefined)
  ));
  if (assistants.length > 1) return { ok: false, reason: "turn_ambiguous" };
  const assistant = assistants[0];
  if (assistant && assistant.status !== "incomplete") {
    return { ok: false, reason: "turn_not_interrupted" };
  }
  return {
    ok: true,
    turn: {
      sessionId: input.sessionId,
      turnId: input.turnId,
      userPrompt: selected.userPrompt,
      assistantReply: assistant ? assistantText(assistant) ?? "" : "",
      activities: assistant ? turnActivities(selected.records) : [],
      sessionTurnIndex: selected.sessionTurnIndex,
    },
  };
}

type SelectedCodeBuddyTurnBranch = Readonly<{
  records: ParsedHistoryRecord[];
  userPrompt: string;
  sessionTurnIndex: number;
}>;

function selectCodeBuddyTurnBranch(
  text: string,
  input: { sessionId: string; turnId: string },
): { ok: true } & SelectedCodeBuddyTurnBranch | {
  ok: false;
  reason: "malformed_transcript" | "turn_not_found" | "user_prompt_missing" | "turn_ambiguous";
} {
  const identity = parseCodeBuddyTurnId(input);
  if (!identity) return { ok: false, reason: "turn_not_found" };
  const records = parseJsonLines(text);
  if (!records) return { ok: false, reason: "malformed_transcript" };
  const session = records.filter((record) => stringField(record, "sessionId") === input.sessionId);
  const users = session.filter((record) => record.role === "user" && visibleUserPrompt(record));
  // The pre-submit byte boundary excludes earlier identical prompts; the digest
  // locates the native user record. Writeback content still comes from the transcript.
  const candidates = users.filter((record) => {
    const prompt = visibleUserPrompt(record);
    return Boolean(
      prompt
      && (record[RECORD_OFFSET] ?? Number.MAX_SAFE_INTEGER) >= identity.boundary
      && codeBuddyPromptDigest(prompt) === identity.promptDigest,
    );
  });
  if (candidates.length === 0) return { ok: false, reason: "user_prompt_missing" };
  if (candidates.length > 1) return { ok: false, reason: "turn_ambiguous" };
  const user = candidates[0];
  const userId = stringField(user, "id");
  const userPrompt = visibleUserPrompt(user);
  if (!userId || !userPrompt) return { ok: false, reason: "turn_not_found" };
  return {
    ok: true,
    records: recordsInBranch(records, userId),
    userPrompt,
    sessionTurnIndex: users.indexOf(user) + 1,
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

function visibleUserPrompt(record: CodeBuddyHistoryRecord): string | undefined {
  const content = messageContentText(record.content, "input_text");
  if (!content) return undefined;
  const match = content.match(/<user_query>([\s\S]*?)<\/user_query>/);
  return (match?.[1] ?? content).trim() || undefined;
}

function assistantText(record: CodeBuddyHistoryRecord): string | undefined {
  return messageContentText(record.content, "output_text")?.trim() || undefined;
}

function messageContentText(value: unknown, expectedType: "input_text" | "output_text"): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const parts = value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const block = item as Record<string, unknown>;
    return block.type === expectedType && typeof block.text === "string" ? [block.text] : [];
  });
  return parts.join("\n") || undefined;
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

function recordsInBranch(records: ParsedHistoryRecord[], userId: string): ParsedHistoryRecord[] {
  // Resolve descendants once; repeated ancestor scans become cubic on long tool chains.
  const childrenByParent = new Map<string, CodeBuddyHistoryRecord[]>();
  for (const record of records) {
    const parentId = stringField(record, "parentId");
    if (!parentId) continue;
    const children = childrenByParent.get(parentId);
    if (children) children.push(record);
    else childrenByParent.set(parentId, [record]);
  }
  const branch = new Set<CodeBuddyHistoryRecord>();
  const pending = [userId];
  const seen = new Set<string>();
  for (let index = 0; index < pending.length; index += 1) {
    const parentId = pending[index];
    if (seen.has(parentId)) continue;
    seen.add(parentId);
    for (const child of childrenByParent.get(parentId) ?? []) {
      branch.add(child);
      const id = stringField(child, "id");
      if (id) pending.push(id);
    }
  }
  // Keep parsed order, including ID-less records and tools on sibling branches.
  return records.filter((record) => branch.has(record));
}

function turnActivities(records: readonly CodeBuddyHistoryRecord[]): CodeBuddyActivity[] {
  const result: CodeBuddyActivity[] = [];
  for (const record of records) {
    const type = stringField(record, "type");
    if (type !== "function_call" && type !== "function_call_result") continue;
    const name = stringField(record, "name") ?? stringField(record, "function") ?? "tool";
    result.push({ kind: "tool", name, ...(contentText(record.arguments) ? { input: contentText(record.arguments) } : {}), ...(contentText(record.output) ? { output: contentText(record.output) } : {}) });
  }
  return result;
}

function stringField(record: CodeBuddyHistoryRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
