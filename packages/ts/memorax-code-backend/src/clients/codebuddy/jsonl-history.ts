import { readFile } from "node:fs/promises";
import { parseNativeMessageTimestamp } from "../../shared/message-time.js";
import { codingEventText, codingToolOutputText, type CodingSessionNativeSource, type CodingSessionProjectionVersion, type CodingSessionSourceTurn, type ResponseItem } from "../../coding-sessions/coding-turn.js";
import type { NativeCodingSessionTurnRef } from "../../coding-sessions/contracts.js";
import { readNativeTranscriptSnapshot } from "../../shared/native-transcript-snapshot.js";
import { codeBuddyPromptDigest, parseCodeBuddyTurnId } from "./turn-id.js";

export type CodeBuddyHistoryRecord = Readonly<Record<string, unknown>>;
export type CodeBuddyTurn = Readonly<{
  sessionId: string;
  turnId: string;
  sessionTurnIndex?: number;
  userPrompt: string;
  assistantReply: string;
  userTimestamp?: number;
  assistantTimestamp?: number;
  activities: readonly CodeBuddyActivity[];
  items?: readonly ResponseItem[];
  source?: CodingSessionNativeSource;
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
  captureCodingItems?: boolean;
  projectionVersion?: CodingSessionProjectionVersion;
  endBytes?: number;
}): Promise<CodeBuddyTurnResult> {
  try {
    if (!input.captureCodingItems && input.endBytes === undefined) {
      return codeBuddyTranscriptTurnFromJsonLines(await readFile(input.transcriptPath, "utf8"), input);
    }
    const snapshot = await readNativeTranscriptSnapshot(input);
    const result = codeBuddyTranscriptTurnFromJsonLines(snapshot.text, input);
    return result.ok ? {
      ok: true,
      turn: { ...result.turn, source: { transcriptPath: input.transcriptPath, endBytes: snapshot.endBytes } },
    } : result;
  }
  catch (error) { return { ok: false, reason: "transcript_unavailable", error: error instanceof Error ? error.message : String(error) }; }
}

export async function readCodeBuddyArchiveSource(
  ref: NativeCodingSessionTurnRef,
): Promise<CodingSessionSourceTurn | undefined> {
  if (ref.client !== "codebuddy" && ref.client !== "workbuddy") return undefined;
  const result = await readCodeBuddyTranscriptTurn({
    ...ref.source, sessionId: ref.sessionId, turnId: ref.turnId, captureCodingItems: true,
    projectionVersion: ref.projectionVersion,
  });
  if (!result.ok || !result.turn.items || result.turn.sessionTurnIndex !== ref.turnIndex) return undefined;
  return { ...ref, items: result.turn.items };
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
  input: { sessionId: string; turnId: string; captureCodingItems?: boolean; projectionVersion?: CodingSessionProjectionVersion },
): CodeBuddyTurnResult {
  const selected = selectCodeBuddyTurnBranch(text, input);
  if (!selected.ok) return selected;
  const branch = selected.records.filter((record) => record.role === "assistant" && record.status === "completed");
  if (branch.length !== 1) return { ok: false, reason: branch.length > 1 ? "turn_ambiguous" : "assistant_message_missing" };
  const assistant = branch[0];
  const reply = assistantText(assistant);
  if (!reply) return { ok: false, reason: "assistant_message_missing" };
  // A timestamp is optional in supported transcripts; only the selected
  // native record supplies it, never its tools or a different completed branch.
  const assistantTimestamp = parseNativeMessageTimestamp(assistant.timestamp);
  return {
    ok: true,
    turn: {
      sessionId: input.sessionId,
      turnId: input.turnId,
      userPrompt: selected.userPrompt,
      assistantReply: reply,
      ...(selected.userTimestamp !== undefined ? { userTimestamp: selected.userTimestamp } : {}),
      ...(assistantTimestamp !== undefined ? { assistantTimestamp } : {}),
      activities: turnActivities(selected.records),
      sessionTurnIndex: selected.sessionTurnIndex,
      ...(selected.eventRecords ? {
        items: completedResponseItems(selected.eventRecords, selected.user, assistant, selected.userPrompt, reply, input.projectionVersion ?? 2),
      } : {}),
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
  eventRecords?: ParsedHistoryRecord[];
  user: ParsedHistoryRecord;
  userPrompt: string;
  userTimestamp?: number;
  sessionTurnIndex: number;
}>;

function selectCodeBuddyTurnBranch(
  text: string,
  input: { sessionId: string; turnId: string; captureCodingItems?: boolean },
): { ok: true } & SelectedCodeBuddyTurnBranch | {
  ok: false;
  reason: "malformed_transcript" | "turn_not_found" | "user_prompt_missing" | "turn_ambiguous";
} {
  const identity = parseCodeBuddyTurnId(input);
  if (!identity) return { ok: false, reason: "turn_not_found" };
  const parsed = parseJsonLines(text, input.captureCodingItems);
  if (!parsed) return { ok: false, reason: "malformed_transcript" };
  const { records } = parsed;
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
  const branch = recordsInBranch(records, userId);
  const parentIds = new Set([userId, ...branch.flatMap((record) => stringField(record, "id") ?? [])]);
  return {
    ok: true,
    records: branch,
    user,
    ...(parsed.eventRecords ? {
      eventRecords: parsed.eventRecords.filter((record) => parentIds.has(stringField(record, "parentId") ?? "")),
    } : {}),
    userPrompt,
    userTimestamp: parseNativeMessageTimestamp(user.timestamp),
    sessionTurnIndex: users.indexOf(user) + 1,
  };
}

function parseJsonLines(text: string, captureCodingItems = false): {
  records: ParsedHistoryRecord[];
  eventRecords?: ParsedHistoryRecord[];
} | undefined {
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
    // rawLine already includes CR when the delimiter is CRLF; only LF is missing.
    const newlineBytes = newline >= 0 ? 1 : 0;
    byteOffset += Buffer.byteLength(rawLine, "utf8") + newlineBytes;
    cursor = newline >= 0 ? newline + 1 : text.length;
  }
  const byId = new Map<string, CodeBuddyHistoryRecord>();
  const withoutId: CodeBuddyHistoryRecord[] = [];
  const byEvent = captureCodingItems ? new Map<string | ParsedHistoryRecord, ParsedHistoryRecord>() : undefined;
  for (const record of records) {
    const id = stringField(record, "id");
    if (id) byId.set(id, record);
    else withoutId.push(record);
    // WorkBuddy can reuse one native node ID for text and multiple tool calls.
    // Ancestry uses the latest node; collection retains distinct event snapshots.
    byEvent?.set(id ? JSON.stringify([id, stringField(record, "type"), stringField(record, "callId")]) : record, record);
  }
  return { records: [...withoutId, ...byId.values()], ...(byEvent ? { eventRecords: [...byEvent.values()] } : {}) };
}

function visibleUserPrompt(record: CodeBuddyHistoryRecord): string | undefined {
  // WorkBuddy preserves the original input here before expanding a Slash
  // command into Skill instructions. Only transcripts without it use legacy text.
  const originals: string[] = [];
  for (const item of Array.isArray(record.content) ? record.content : []) {
    if (!item || typeof item !== "object" || item.type !== "input_text") continue;
    const providerData: unknown = item.providerData;
    if (!providerData || typeof providerData !== "object" || Array.isArray(providerData) || !("content" in providerData)) continue;
    // Invalid originals must not authorize the expanded text. Correlation below
    // still requires the exact prompt digest, byte boundary, and native lineage.
    if (typeof providerData.content !== "string" || !providerData.content.trim()) return undefined;
    originals.push(providerData.content);
  }
  if (originals.length > 0) return originals.join("\n").trim();

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
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const text = (value as Record<string, unknown>).text;
    return typeof text === "string" ? text : undefined;
  }
  if (!Array.isArray(value)) return undefined;
  const parts = value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const text = (item as Record<string, unknown>).text;
    return typeof text === "string" ? [text] : [];
  });
  return parts.join("\n") || undefined;
}

function completedResponseItems(
  records: readonly ParsedHistoryRecord[],
  user: ParsedHistoryRecord,
  assistant: ParsedHistoryRecord,
  userPrompt: string,
  assistantReply: string,
  projectionVersion: CodingSessionProjectionVersion,
): ResponseItem[] {
  let userContent = [{ type: "input_text" as const, text: userPrompt }];
  if (projectionVersion !== 1) {
    const inputBlocks = (Array.isArray(user.content) ? user.content : []).filter((block) => (
      block && typeof block === "object" && block.type === "input_text"
    ));
    const originals = inputBlocks.flatMap((block) => (
      block.providerData && typeof block.providerData === "object" && !Array.isArray(block.providerData)
        && typeof block.providerData.content === "string"
        ? [{ type: "input_text" as const, text: block.providerData.content as string }] : []
    ));
    userContent = originals.length ? originals : inputBlocks.flatMap((block) => (
      typeof block.text === "string" ? [{ type: "input_text" as const, text: block.text as string }] : []
    ));
    const match = originals.length ? undefined : userContent.map(({ text }) => text).join("\n").match(/<user_query>([\s\S]*?)<\/user_query>/);
    if (match) {
      const start = match.index! + "<user_query>".length;
      const end = start + match[1].length;
      let offset = 0;
      userContent = userContent.flatMap(({ text }) => {
        const from = Math.max(start, offset);
        const to = Math.min(end, offset + text.length);
        const blockStart = offset;
        offset += text.length + 1;
        return to > from || (text.length === 0 && blockStart >= start && blockStart <= end)
          ? [{ type: "input_text" as const, text: text.slice(from - blockStart, to - blockStart) }] : [];
      });
    }
  }
  const items: ResponseItem[] = [{ type: "message", role: "user", content: userContent }];
  for (const record of records) {
    if (record === assistant || (record[RECORD_OFFSET] ?? 0) > (assistant[RECORD_OFFSET] ?? Infinity)) continue;
    if (record.type === "message" && record.role === "assistant") {
      const text = assistantText(record);
      const content = projectionVersion === 1
        ? [{ type: "output_text" as const, text: text ?? "" }]
        : (Array.isArray(record.content) ? record.content : []).flatMap((block) => (
          block && typeof block === "object" && block.type === "output_text" && typeof block.text === "string"
            ? [{ type: "output_text" as const, text: block.text as string }] : []
        ));
      if (text) items.push({ type: "message", role: "assistant", phase: "commentary", content });
      continue;
    }
    const callId = stringField(record, "callId");
    if (!callId) continue;
    if (record.type === "function_call") {
      const tool = stringField(record, "name") ?? stringField(record, "function");
      if (tool) items.push({ type: "function_call", call_id: callId, name: tool, arguments: codingEventText(record.arguments, projectionVersion) });
    } else if (record.type === "function_call_result") {
      items.push({
        type: "function_call_output", call_id: callId,
        output: projectionVersion === 1 ? codingEventText(contentText(record.output) ?? record.output, 1)
          : codingToolOutputText(typeof record.status === "string" ? { output: record.output, status: record.status } : record.output),
      });
    }
  }
  const finalContent = projectionVersion === 1
    ? [{ type: "output_text" as const, text: assistantReply }]
    : (Array.isArray(assistant.content) ? assistant.content : []).flatMap((block) => (
      block && typeof block === "object" && block.type === "output_text" && typeof block.text === "string"
        ? [{ type: "output_text" as const, text: block.text as string }] : []
    ));
  items.push({ type: "message", role: "assistant", phase: "final_answer", content: finalContent });
  return items;
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
