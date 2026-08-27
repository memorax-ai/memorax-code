import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";

export type KimiWireTurnFailureReason =
  | "wire_unavailable"
  | "wire_identity_mismatch"
  | "malformed_record"
  | "turn_not_completed"
  | "cancelled"
  | "assistant_message_missing"
  | "prompt_identity_mismatch";

export type KimiWireTurnResult =
  | {
    ok: true;
    turn: {
      turnId: string;
      userPrompt: string;
      assistantReply: string;
    };
  }
  | { ok: false; reason: KimiWireTurnFailureReason };

export async function readKimiWireTurn(input: {
  sessionId: string;
  promptId: string;
  turnId: string;
  wirePath: string;
}): Promise<KimiWireTurnResult> {
  const wirePath = await canonicalMainWirePath(input.wirePath, input.sessionId);
  if (!wirePath) return { ok: false, reason: "wire_identity_mismatch" };
  let text: string;
  try {
    text = await readFile(wirePath, "utf8");
  } catch {
    return { ok: false, reason: "wire_unavailable" };
  }
  const parsed = parseJsonl(text);
  if (!parsed.ok) return parsed;
  const materialized = materializeTurn(parsed.records, input.turnId);
  if (!materialized.ok) return materialized;
  if (sha256(materialized.turn.userPrompt) !== input.promptId) {
    return { ok: false, reason: "prompt_identity_mismatch" };
  }
  return materialized;
}

async function canonicalMainWirePath(path: string, sessionId: string): Promise<string | undefined> {
  try {
    const wirePath = await realpath(path);
    const mainDir = dirname(wirePath);
    const agentsDir = dirname(mainDir);
    const sessionDir = dirname(agentsDir);
    if (
      basename(wirePath) !== "wire.jsonl"
      || basename(mainDir) !== "main"
      || basename(agentsDir) !== "agents"
      || basename(sessionDir) !== sessionId
      || relative(sessionDir, wirePath) !== join("agents", "main", "wire.jsonl")
    ) return undefined;
    return wirePath;
  } catch {
    return undefined;
  }
}

function parseJsonl(text: string):
  | { ok: true; records: Record<string, unknown>[] }
  | { ok: false; reason: "malformed_record" } {
  const lines = text.split("\n");
  const records: Record<string, unknown>[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim();
    if (!line) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (isRecord(value)) records.push(value);
    } catch {
      if (index === lines.length - 1 && !text.endsWith("\n")) break;
      return { ok: false, reason: "malformed_record" };
    }
  }
  return { ok: true, records };
}

function materializeTurn(records: Record<string, unknown>[], expectedTurnId: string): KimiWireTurnResult {
  const pending: { userPrompt?: string }[] = [];
  const turns = new Map<string, {
    userPrompt: string;
    assistantParts: string[];
    cancelled: boolean;
    endReason?: string;
  }>();
  for (const record of records) {
    if (record.type === "prompt.accepted") {
      pending.push({});
      continue;
    }
    if (record.type === "turn.prompt" && isRecord(record.origin) && record.origin.kind === "user") {
      const userPrompt = textParts(record.input);
      if (!userPrompt) continue;
      const prompt = pending.find((candidate) => candidate.userPrompt === undefined);
      if (prompt) prompt.userPrompt = userPrompt;
      else pending.push({ userPrompt });
      continue;
    }
    if (record.type === "context.append_loop_event" && isRecord(record.event)) {
      const event = record.event;
      const turnId = stringValue(event.turnId);
      if (!turnId) continue;
      let turn = turns.get(turnId);
      if (event.type === "step.begin" && !turn) {
        const promptIndex = pending.findIndex((candidate) => candidate.userPrompt);
        if (promptIndex < 0) continue;
        const prompt = pending.splice(promptIndex, 1)[0];
        if (!prompt?.userPrompt) continue;
        turn = { userPrompt: prompt.userPrompt, assistantParts: [], cancelled: false };
        turns.set(turnId, turn);
      }
      if (
        turn
        && event.type === "content.part"
        && isRecord(event.part)
        && event.part.type === "text"
        && typeof event.part.text === "string"
        && event.part.text.trim()
      ) turn.assistantParts.push(event.part.text);
      continue;
    }
    if (record.type === "turn.cancel") {
      const turn = turns.get(stringValue(record.turnId) ?? "");
      if (turn) turn.cancelled = true;
      continue;
    }
    if (record.type === "turn.ended") {
      const turn = turns.get(stringValue(record.turnId) ?? "");
      if (turn) turn.endReason = stringValue(record.reason);
    }
  }
  const turn = turns.get(expectedTurnId);
  if (!turn || turn.endReason === undefined) return { ok: false, reason: "turn_not_completed" };
  if (turn.cancelled || turn.endReason === "cancelled") return { ok: false, reason: "cancelled" };
  if (turn.endReason !== "completed") return { ok: false, reason: "turn_not_completed" };
  if (!turn.assistantParts.length) return { ok: false, reason: "assistant_message_missing" };
  return {
    ok: true,
    turn: {
      turnId: expectedTurnId,
      userPrompt: turn.userPrompt,
      assistantReply: turn.assistantParts.join("\n"),
    },
  };
}

function textParts(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .filter((part) => isRecord(part) && part.type === "text" && typeof part.text === "string")
    .map((part) => String(part.text))
    .join("\n")
    .trim();
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
