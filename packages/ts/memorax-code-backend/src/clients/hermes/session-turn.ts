import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";

export type HermesSessionTurn = Readonly<{
  sessionId: string;
  turnId: string;
  userPrompt: string;
  assistantReply: string;
  userMessageTimestamp: number;
  assistantMessageTimestamp: number;
}>;

export type HermesSessionTurnFailureReason =
  | "hermes_home_missing"
  | "state_db_unreadable"
  | "state_db_unavailable"
  | "session_missing"
  | "subagent_session"
  | "user_message_missing"
  | "assistant_reply_missing"
  | "turn_not_completed";

export type HermesSessionTurnResult =
  | { ok: true; turn: HermesSessionTurn }
  | { ok: false; reason: HermesSessionTurnFailureReason; outcome?: string };

export type HermesSessionTurnInput = Readonly<{
  sessionId: string;
  turnId: string;
  prompt?: string;
  cwd: string;
  completed: boolean;
  interrupted: boolean;
  failed: boolean;
  hermesHome?: string;
  turnStartedAt?: number;
  now?: number;
}>;

type HermesMessageRow = Readonly<{
  id: number;
  role: string;
  content: string;
  timestamp: number;
}>;

export async function hermesSessionTurn(input: HermesSessionTurnInput): Promise<HermesSessionTurnResult> {
  const receiptTime = input.now ?? Date.now();
  const hermesHome = resolveHermesHome(input.hermesHome);
  if (!existsSync(hermesHome)) return { ok: false, reason: "hermes_home_missing" };
  const dbPath = join(hermesHome, "state.db");
  if (!existsSync(dbPath)) return { ok: false, reason: "state_db_unreadable" };

  let DatabaseSync: typeof import("node:sqlite").DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    return { ok: false, reason: "state_db_unavailable" };
  }

  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(dbPath, {
      readOnly: true,
      timeout: 5_000,
    });
  } catch {
    return { ok: false, reason: "state_db_unreadable" };
  }
  try {
    return readHermesSessionTurn(database, input, receiptTime);
  } finally {
    try {
      database.close();
    } catch {
      // Closing a failed connection is best effort.
    }
  }
}

function readHermesSessionTurn(
  database: DatabaseSync,
  input: HermesSessionTurnInput,
  receiptTime: number,
): HermesSessionTurnResult {
  const session = readSessionRow(database, input.sessionId);
  if (!session) return { ok: false, reason: "session_missing" };
  if (nonEmptyString(session.parent_session_id)) return { ok: false, reason: "subagent_session" };

  const rows = readMessageRows(database, input.sessionId);
  if (rows.length === 0) return { ok: false, reason: "user_message_missing" };

  const receiptTimeSeconds = receiptTime / 1000;
  const turnStartedAtSeconds = input.turnStartedAt === undefined
    ? undefined
    : input.turnStartedAt / 1000;
  let userIndex = -1;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row.role !== "user") continue;
    if (row.timestamp > receiptTimeSeconds + 60) continue;
    if (turnStartedAtSeconds !== undefined && row.timestamp < turnStartedAtSeconds - 300) {
      continue;
    }
    if (input.prompt && row.content !== input.prompt) continue;
    userIndex = index;
    break;
  }
  if (userIndex < 0) return { ok: false, reason: "user_message_missing" };

  const userRow = rows[userIndex];
  let assistantReply: string | undefined;
  let assistantTimestamp = 0;
  for (let index = userIndex + 1; index < rows.length; index += 1) {
    const row = rows[index];
    if (row.role === "user") break;
    if (row.role !== "assistant") continue;
    const text = row.content.trim();
    if (!text) continue;
    assistantReply = text;
    assistantTimestamp = row.timestamp;
  }

  if (!input.completed) {
    const outcome = input.interrupted
      ? "interrupted"
      : input.failed
        ? "failed"
        : "unknown";
    return { ok: false, reason: "turn_not_completed", outcome };
  }
  if (assistantReply === undefined) return { ok: false, reason: "assistant_reply_missing" };

  return {
    ok: true,
    turn: {
      sessionId: input.sessionId,
      turnId: input.turnId,
      userPrompt: userRow.content,
      assistantReply,
      userMessageTimestamp: userRow.timestamp,
      assistantMessageTimestamp: assistantTimestamp,
    },
  };
}

function readSessionRow(
  database: DatabaseSync,
  sessionId: string,
): { parent_session_id: string | null } | undefined {
  try {
    const rows = database.prepare(
      "SELECT parent_session_id FROM sessions WHERE id = ?",
    ).all(sessionId) as Array<{ parent_session_id: unknown }>;
    return rows.length === 1 ? { parent_session_id: stringOrNull(rows[0].parent_session_id) } : undefined;
  } catch {
    return undefined;
  }
}

function readMessageRows(database: DatabaseSync, sessionId: string): HermesMessageRow[] {
  try {
    return database.prepare(
      "SELECT id, role, content, timestamp "
      + "FROM messages WHERE session_id = ? AND active = 1 "
      + "ORDER BY timestamp, id",
    ).all(sessionId) as HermesMessageRow[];
  } catch {
    return [];
  }
}

function resolveHermesHome(hermesHome: string | undefined): string {
  const value = hermesHome ?? process.env.HERMES_HOME ?? join(homedir(), ".hermes");
  return resolve(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}