import { readFile } from "node:fs/promises";

type JsonRecord = Record<string, unknown>;

export type CodexSessionTurnIndexFailureReason =
  | "transcript_unavailable"
  | "transcript_session_mismatch"
  | "turn_not_found";

export type CodexSessionTurnIndexResult =
  | { ok: true; sessionTurnIndex: number }
  | { ok: false; reason: CodexSessionTurnIndexFailureReason; error?: string };

export async function readCodexSessionTurnIndex(input: {
  transcriptPath: string;
  sessionId: string;
  turnId: string;
}): Promise<CodexSessionTurnIndexResult> {
  let transcript: string;
  try {
    transcript = await readFile(input.transcriptPath, "utf8");
  } catch (error) {
    return {
      ok: false,
      reason: "transcript_unavailable",
      error: error instanceof Error ? error.message : String(error),
    };
  }
  return codexSessionTurnIndexFromJsonLines(transcript, input);
}

export function codexSessionTurnIndexFromJsonLines(
  transcript: string,
  input: { sessionId: string; turnId: string },
): CodexSessionTurnIndexResult {
  const sessionIds = new Set<string>();
  const orderedTurnIds: string[] = [];
  const seenTurnIds = new Set<string>();
  const turnContextIds = new Set<string>();
  const userMessageTurnIds = new Set<string>();
  let activeTurnId: string | undefined;

  const observeTurn = (turnId: string | undefined, source: "turn_context" | "task_started"): void => {
    activeTurnId = turnId;
    if (!turnId || seenTurnIds.has(turnId)) return;
    seenTurnIds.add(turnId);
    orderedTurnIds.push(turnId);
    if (source === "turn_context") turnContextIds.add(turnId);
  };

  for (const line of transcript.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let record: JsonRecord;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!isRecord(parsed)) continue;
      record = parsed;
    } catch {
      continue;
    }

    const payload = isRecord(record.payload) ? record.payload : {};
    if (record.type === "session_meta") {
      const sessionId = stringValue(payload.id) ?? stringValue(payload.session_id);
      if (sessionId) sessionIds.add(sessionId);
      continue;
    }
    if (record.type === "turn_context") {
      const turnId = stringValue(payload.turn_id) ?? stringValue(payload.turnId);
      observeTurn(turnId, "turn_context");
      continue;
    }
    if (record.type !== "event_msg") continue;
    const eventType = stringValue(payload.type);
    if (eventType === "task_started") {
      observeTurn(stringValue(payload.turn_id) ?? stringValue(payload.turnId), "task_started");
      continue;
    }
    if (eventType === "user_message" && activeTurnId) {
      userMessageTurnIds.add(activeTurnId);
      continue;
    }
    if (eventType === "task_complete") {
      const completedTurnId = stringValue(payload.turn_id) ?? stringValue(payload.turnId);
      if (completedTurnId && completedTurnId === activeTurnId) activeTurnId = undefined;
    }
  }

  if (sessionIds.size !== 1 || !sessionIds.has(input.sessionId)) {
    return { ok: false, reason: "transcript_session_mismatch" };
  }
  const countedTurnIds = orderedTurnIds.filter((turnId) => (
    turnContextIds.has(turnId) || userMessageTurnIds.has(turnId)
  ));
  const sessionTurnIndex = countedTurnIds.indexOf(input.turnId) + 1;
  if (sessionTurnIndex === 0) return { ok: false, reason: "turn_not_found" };
  return { ok: true, sessionTurnIndex };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
