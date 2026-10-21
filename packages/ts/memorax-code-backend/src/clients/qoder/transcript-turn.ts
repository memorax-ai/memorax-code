import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parseNativeMessageTimestamp } from "../../shared/message-time.js";
import { isRecord } from "../../shared/record.js";

export const MAX_QODER_TRANSCRIPT_BYTES = 32 * 1024 * 1024;

export type QoderTranscriptTurn = Readonly<{
  userPrompt: string;
  assistantReply: string;
  userTimestamp?: number;
  assistantTimestamp?: number;
  cwd: string;
}>;

export type QoderTranscriptTurnFailureReason =
  | "transcript_unavailable" | "transcript_too_large" | "transcript_changed"
  | "malformed_transcript" | "transcript_session_mismatch" | "transcript_workspace_mismatch"
  | "turn_not_found" | "turn_metadata_mismatch" | "turn_chain_invalid"
  | "turn_branch_mismatch" | "turn_order_mismatch" | "turn_ambiguous" | "sidechain_unsupported"
  | "user_prompt_missing" | "assistant_message_missing";

export type QoderTranscriptTurnResult =
  | { ok: true; turn: QoderTranscriptTurn }
  | { ok: false; reason: QoderTranscriptTurnFailureReason; error?: string };

type NativeRecord = Record<string, unknown>;
type Failure = Extract<QoderTranscriptTurnResult, { ok: false }>;
type Identity = { sessionId: string; turnId: string; afterTurnId?: string };

export async function readQoderTranscriptTurn(input: Identity & {
  transcriptPath: string;
}): Promise<QoderTranscriptTurnResult> {
  let bytes: Buffer;
  try {
    const file = await open(input.transcriptPath, "r");
    try {
      const before = await file.stat();
      if (!before.isFile()) return failure("transcript_unavailable");
      if (before.size > MAX_QODER_TRANSCRIPT_BYTES) return failure("transcript_too_large");
      const chunks: Buffer[] = [];
      let size = 0;
      // The inclusive limit also detects growth beyond the bound after stat.
      for await (const chunk of file.createReadStream({ end: MAX_QODER_TRANSCRIPT_BYTES, autoClose: false })) {
        const buffer = chunk as Buffer;
        size += buffer.length;
        if (size > MAX_QODER_TRANSCRIPT_BYTES) return failure("transcript_too_large");
        chunks.push(buffer);
      }
      const after = await file.stat();
      if (before.size !== after.size || size !== after.size || before.mtimeMs !== after.mtimeMs) {
        return failure("transcript_changed");
      }
      bytes = Buffer.concat(chunks, size);
    } finally {
      await file.close();
    }
  } catch (error) {
    return { ok: false, reason: "transcript_unavailable", error: error instanceof Error ? error.message : String(error) };
  }
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return failure("malformed_transcript"); }
  return selectTurn(text, input);
}

function selectTurn(text: string, input: Identity): QoderTranscriptTurnResult {
  const parsed = parseRecords(text);
  if (!parsed.ok) return parsed;
  const { records, activeLeaf } = parsed;
  const human = records.get(input.turnId);
  if (!human) return failure("turn_not_found");
  if ([...records.values()].some((record) => record.requestSetId === input.turnId && record.uuid !== input.turnId)) {
    return failure("turn_metadata_mismatch");
  }
  if (human.type !== "user" || human.requestSetId !== input.turnId || human.isMeta === true
    || !isRecord(human.origin) || human.origin.kind !== "human"
    || !isRecord(human.message) || human.message.role !== "user") {
    return failure("turn_metadata_mismatch");
  }
  const userPrompt = isRecord(human.humanInput) ? textValue(human.humanInput.text) : undefined;
  if (!userPrompt) return failure("user_prompt_missing");
  const cwd = textValue(human.cwd);
  if (!cwd || !isAbsolute(cwd) || cwd.includes("\0")) return failure("transcript_workspace_mismatch");
  const humanFailure = validateRecord(human, input.sessionId, cwd);
  if (humanFailure) return humanFailure;

  // Delayed human registration may only advance the existing native turn.
  // Opaque request IDs and Hook arrival order cannot establish that ordering.
  if (input.afterTurnId && input.afterTurnId !== input.turnId) {
    const visited = new Set<string>([input.turnId]);
    let ancestorId = textValue(human.parentUuid);
    while (ancestorId) {
      if (visited.has(ancestorId)) return failure("turn_chain_invalid");
      const ancestor = records.get(ancestorId);
      if (!ancestor) return failure("turn_chain_invalid");
      const invalid = validateRecord(ancestor, input.sessionId, cwd);
      if (invalid) return invalid;
      visited.add(ancestorId);
      if (ancestorId === input.afterTurnId) break;
      ancestorId = textValue(ancestor.parentUuid);
    }
    if (ancestorId !== input.afterTurnId) return failure("turn_order_mismatch");
  }

  // The active path proves branch membership, never which request to select.
  // Later human turns may extend it; stop only at the requested exact human.
  if (!activeLeaf || activeLeaf.sessionId !== input.sessionId) return failure("turn_branch_mismatch");
  const activePath = new Set<string>();
  let currentId = textValue(activeLeaf.leafUuid);
  while (currentId) {
    if (activePath.has(currentId)) return failure("turn_chain_invalid");
    const record = records.get(currentId);
    if (!record) return failure("turn_chain_invalid");
    const recordFailure = validateRecord(record, input.sessionId, cwd);
    if (recordFailure) return recordFailure;
    activePath.add(currentId);
    if (currentId === input.turnId) break;
    currentId = textValue(record.parentUuid);
  }
  if (!activePath.has(input.turnId)) return failure("turn_branch_mismatch");

  const children = new Map<string, NativeRecord[]>();
  for (const record of records.values()) {
    const parent = textValue(record.parentUuid);
    if (!parent) continue;
    const siblings = children.get(parent);
    if (siblings) siblings.push(record);
    else children.set(parent, [record]);
  }
  const pending = [human];
  const visited = new Set<string>();
  const terminals: NativeRecord[] = [];
  for (let index = 0; index < pending.length; index += 1) {
    const record = pending[index];
    const uuid = record.uuid as string;
    if (visited.has(uuid)) return failure("turn_chain_invalid");
    visited.add(uuid);
    const recordFailure = validateRecord(record, input.sessionId, cwd);
    if (recordFailure) return recordFailure;
    const descendants = (children.get(uuid) ?? []).filter((child) => (
      child.uuid === input.turnId || !isQueryBoundary(child)
    ));
    if (descendants.length === 0) terminals.push(record);
    else pending.push(...descendants);
  }
  const parallelResults = terminals.length > 1
    ? parallelToolResultLeaves(records, visited, activePath, children) : new Set<string>();
  const completions = terminals.filter((record) => !parallelResults.has(record.uuid as string));
  if (completions.length !== 1) return failure("turn_ambiguous");
  const final = completions[0];
  if (!activePath.has(final.uuid as string)) return failure("turn_branch_mismatch");
  if (final.type !== "assistant" || final.isMeta === true || !isRecord(final.message)
    || final.message.role !== "assistant" || final.message.stop_reason !== "end_turn") {
    return failure("assistant_message_missing");
  }
  const content = final.message.content;
  if (!Array.isArray(content) || content.some((block) => !isRecord(block) || !textValue(block.type)
    || (block.type === "text" && typeof block.text !== "string"))) return failure("malformed_transcript");
  const assistantReply = content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
  if (!assistantReply.trim()) return failure("assistant_message_missing");
  const userTimestamp = parseNativeMessageTimestamp(human.timestamp);
  const assistantTimestamp = parseNativeMessageTimestamp(final.timestamp);
  return { ok: true, turn: {
    userPrompt, assistantReply, cwd,
    ...(userTimestamp === undefined ? {} : { userTimestamp }),
    ...(assistantTimestamp === undefined ? {} : { assistantTimestamp }),
  } };
}

function parallelToolResultLeaves(
  records: Map<string, NativeRecord>, selected: Set<string>, activePath: Set<string>,
  children: Map<string, NativeRecord[]>,
): Set<string> {
  const callCounts = new Map<string, number>();
  const resultCounts = new Map<string, number>();
  for (const uuid of selected) {
    const message = records.get(uuid)?.message;
    if (!isRecord(message) || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (!isRecord(block)) continue;
      const counts = block.type === "tool_use" ? callCounts : block.type === "tool_result" ? resultCounts : undefined;
      const id = textValue(block.type === "tool_use" ? block.id : block.tool_use_id);
      if (counts && id) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }

  // Qoder links a parallel batch's call blocks in order, but attaches each
  // result to its own call. Only the last result continues the active path.
  const batches = new Map<string, NativeRecord[]>();
  for (const uuid of [...activePath].reverse()) {
    if (!selected.has(uuid)) continue;
    const record = records.get(uuid)!;
    const call = nativeToolCall(record);
    if (!call) continue;
    const batch = batches.get(call.messageId) ?? [];
    batch.push(record);
    batches.set(call.messageId, batch);
  }
  const leaves = new Set<string>();
  for (const batch of batches.values()) {
    if (batch.length < 2) continue;
    const results: NativeRecord[] = [];
    const valid = batch.every((record, index) => {
      const call = nativeToolCall(record)!;
      if (callCounts.get(call.id) !== 1 || resultCounts.get(call.id) !== 1) return false;
      const matches = (children.get(record.uuid as string) ?? []).filter((child) => (
        selected.has(child.uuid as string) && nativeToolResult(child, call.id)
      ));
      if (matches.length !== 1) return false;
      const result = matches[0];
      results.push(result);
      if (index === batch.length - 1) {
        return call.stopReason === "tool_use" && activePath.has(result.uuid as string);
      }
      return call.stopReason == null && batch[index + 1].parentUuid === record.uuid
        && !activePath.has(result.uuid as string) && !children.get(result.uuid as string)?.length;
    });
    if (valid) for (const result of results.slice(0, -1)) leaves.add(result.uuid as string);
  }
  return leaves;
}

function nativeToolCall(record: NativeRecord): { id: string; messageId: string; stopReason: unknown } | undefined {
  if (record.type !== "assistant" || record.isMeta === true || !isRecord(record.message)
    || record.message.role !== "assistant") return undefined;
  const { content, id, stop_reason: stopReason } = record.message;
  if (!textValue(id) || !Array.isArray(content) || content.length !== 1
    || !isRecord(content[0]) || content[0].type !== "tool_use") return undefined;
  const callId = textValue(content[0].id);
  return callId ? { id: callId, messageId: id as string, stopReason } : undefined;
}

function nativeToolResult(record: NativeRecord, callId: string): boolean {
  if (record.type !== "user" || record.isMeta === true || record.origin !== undefined
    || isQueryBoundary(record) || !isRecord(record.message) || record.message.role !== "user") return false;
  const content = record.message.content;
  return Array.isArray(content) && content.length === 1 && isRecord(content[0])
    && content[0].type === "tool_result" && content[0].tool_use_id === callId;
}

function parseRecords(text: string): Failure | {
  ok: true; records: Map<string, NativeRecord>; activeLeaf?: NativeRecord;
} {
  const records = new Map<string, NativeRecord>();
  let activeLeaf: NativeRecord | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let record: unknown;
    try { record = JSON.parse(line); }
    catch { return failure("malformed_transcript"); }
    if (!isRecord(record) || !textValue(record.type)) return failure("malformed_transcript");
    if (record.type === "active-leaf") {
      if (!textValue(record.leafUuid) || !textValue(record.sessionId)) return failure("malformed_transcript");
      activeLeaf = record;
    }
    if (record.uuid === undefined) {
      if (["user", "assistant", "attachment"].includes(record.type as string)) return failure("malformed_transcript");
      continue;
    }
    const uuid = textValue(record.uuid);
    if (!uuid) return failure("malformed_transcript");
    const previous = records.get(uuid);
    if (previous && !isDeepStrictEqual(previous, record)) return failure("turn_ambiguous");
    records.set(uuid, record);
  }
  return { ok: true, records, activeLeaf };
}

function validateRecord(record: NativeRecord, sessionId: string, cwd: string): Failure | undefined {
  if (record.sessionId !== sessionId) return failure("transcript_session_mismatch");
  if (record.cwd !== cwd) return failure("transcript_workspace_mismatch");
  if (record.isSidechain !== false) return failure("sidechain_unsupported");
  return undefined;
}

function isQueryBoundary(record: NativeRecord): boolean {
  return record.type === "user" && (record.humanInput !== undefined || record.requestSetId !== undefined
    || (isRecord(record.origin) && ["human", "task-notification"].includes(record.origin.kind as string)));
}

function textValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function failure(reason: QoderTranscriptTurnFailureReason): Failure {
  return { ok: false, reason };
}
