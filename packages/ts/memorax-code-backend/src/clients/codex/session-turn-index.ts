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
  const pendingResponseItemUserTurnIds = new Set<string>();
  let activeTurnId: string | undefined;

  const observeTurn = (turnId: string | undefined, source: "turn_context" | "task_started"): void => {
    activeTurnId = turnId;
    if (turnId && source === "turn_context") turnContextIds.add(turnId);
    if (!turnId || seenTurnIds.has(turnId)) return;
    seenTurnIds.add(turnId);
    orderedTurnIds.push(turnId);
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
      if (turnId && pendingResponseItemUserTurnIds.has(turnId)) {
        userMessageTurnIds.add(turnId);
      }
      continue;
    }
    if (record.type === "response_item" && activeTurnId
      && payload.type === "message" && payload.role === "user") {
      const hasUserText = Array.isArray(payload.content) && payload.content.some((item: unknown) => (
        isRecord(item) && item.type === "input_text" && stringValue(item.text) !== undefined
      ));
      if (hasUserText && turnContextIds.has(activeTurnId)) {
        userMessageTurnIds.add(activeTurnId);
      } else if (hasUserText) {
        pendingResponseItemUserTurnIds.add(activeTurnId);
      }
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
    if (eventType === "item_completed" && activeTurnId
      && payload.thread_id === input.sessionId && payload.turn_id === activeTurnId
      && isRecord(payload.item) && payload.item.type === "UserMessage") {
      userMessageTurnIds.add(activeTurnId);
      continue;
    }
    if (eventType === "task_complete" || eventType === "turn_aborted") {
      const endedTurnId = stringValue(payload.turn_id) ?? stringValue(payload.turnId);
      if (endedTurnId && endedTurnId === activeTurnId) activeTurnId = undefined;
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

/** Verify native identity independently of optional prompt/session provenance. */
export function codexHelpfulPromptFromJsonLines(
  transcript: string, input: { sessionId: string; turnId: string },
): { agent_role?: "main" | "subagent"; prompt_origin?: "end_user" | "system" } | undefined {
  // Helpful uses enclosing native turn events as its identity authority. The
  // writeback parser additionally rejects a conflicting user-message ID, while
  // provider assistant IDs remain descriptive metadata.
  const sessionIds = new Set<string>();
  const roles = new Set<"main" | "subagent">();
  const origins = new Set<"end_user" | "system">();
  let active: string | undefined;
  let user = false;
  const observeOrigin = (value: unknown): void => {
    if (value === "end_user" || value === "system") origins.add(value);
  };
  const lines = transcript.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    let record: JsonRecord;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isRecord(parsed)) return undefined;
      record = parsed;
    } catch {
      if (index === lines.length - 1 && !transcript.endsWith("\n")) break;
      return undefined;
    }
    const payload = isRecord(record.payload) ? record.payload : {};
    if (record.type === "session_meta") {
      const sessionId = stringValue(payload.id) ?? stringValue(payload.session_id);
      if (sessionId) sessionIds.add(sessionId);
      if (["cli", "vscode", "exec"].includes(String(payload.source))) roles.add("main");
      else if (isRecord(payload.source) && isRecord(payload.source.subagent)) roles.add("subagent");
    }
    if (record.type === "turn_context" || (record.type === "event_msg" && payload.type === "task_started")) {
      active = stringValue(payload.turn_id) ?? stringValue(payload.turnId);
    }
    if (record.type === "response_item" && active === input.turnId
      && payload.type === "message" && payload.role === "user") {
      const metadata = isRecord(payload.internal_chat_message_metadata_passthrough)
        ? payload.internal_chat_message_metadata_passthrough
        : {};
      const hasUserText = Array.isArray(payload.content) && payload.content.some((item: unknown) => (
        isRecord(item) && item.type === "input_text" && stringValue(item.text) !== undefined
      ));
      if (hasUserText) {
        observeOrigin(metadata.prompt_origin);
        user = true;
      }
    }
    if (record.type === "event_msg" && payload.type === "user_message" && active === input.turnId) {
      const eventTurn = stringValue(payload.turn_id) ?? stringValue(payload.turnId);
      if (eventTurn && eventTurn !== active) return undefined;
      if (stringValue(payload.message)) {
        const origin = payload.prompt_origin ?? (payload.source === "system" ? "system"
          : payload.source === undefined || ["user", "end_user"].includes(String(payload.source)) ? "end_user" : undefined);
        observeOrigin(origin);
        user = true;
      }
    }
    if (record.type === "event_msg" && payload.type === "item_completed"
      && isRecord(payload.item) && payload.item.type === "UserMessage"
      && (active === input.turnId || payload.turn_id === input.turnId)) {
      if (payload.thread_id !== input.sessionId || payload.turn_id !== input.turnId
        || active !== input.turnId) return undefined;
      if (Array.isArray(payload.item.content) && payload.item.content.some((part: unknown) => (
        isRecord(part) && part.type === "text" && stringValue(part.text)
      ))) {
        observeOrigin(payload.item.prompt_origin);
        user = true;
      }
    }
    if (record.type === "event_msg" && ["task_complete", "turn_aborted"].includes(String(payload.type))) active = undefined;
  }
  const agent_role = roles.size === 1 ? [...roles][0] : undefined;
  const prompt_origin = origins.size === 1 ? [...origins][0] : undefined;
  if (sessionIds.size !== 1 || !sessionIds.has(input.sessionId)) return undefined;
  return user ? {
    ...(agent_role ? { agent_role } : {}),
    ...(prompt_origin ? { prompt_origin } : {}),
  } : undefined;
}
