import { readFile } from "node:fs/promises";

type JsonRecord = Record<string, unknown>;

export type CodexTurnTokenUsage = {
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
};

export type CodexRepoMemoryOperation =
  | "repo-build"
  | "repo-read"
  | "repo-update";

export type CodexTurnActivity =
  | Readonly<{
    index: number;
    type: "repo_memory_operation";
    operation: CodexRepoMemoryOperation;
  }>
  | Readonly<{
    index: number;
    type: "memory_cli_search" | "memory_cli_add";
  }>;

export type CodexRolloutTurn = {
  sessionId: string;
  turnId: string;
  userPrompt: string;
  assistantReply: string;
  activities: CodexTurnActivity[];
  usage?: CodexTurnTokenUsage;
};

export type CodexRolloutTurnFailureReason =
  | "transcript_unavailable"
  | "transcript_session_mismatch"
  | "turn_metadata_mismatch"
  | "turn_not_found"
  | "user_prompt_missing"
  | "assistant_message_missing";

export type CodexRolloutTurnResult =
  | { ok: true; turn: CodexRolloutTurn }
  | { ok: false; reason: CodexRolloutTurnFailureReason; error?: string };

export type CodexInterruptedRolloutTurn = CodexRolloutTurn & {
  interruptedAt?: string;
  sessionTurnIndex?: number;
};

export type CodexInterruptedRolloutTurnFailureReason =
  | Exclude<CodexRolloutTurnFailureReason, "assistant_message_missing">
  | "turn_not_interrupted"
  | "turn_rolled_back";

export type CodexInterruptedRolloutTurnResult =
  | { ok: true; turn: CodexInterruptedRolloutTurn }
  | { ok: false; reason: CodexInterruptedRolloutTurnFailureReason; error?: string };

export async function readCodexRolloutTurn(input: {
  transcriptPath: string;
  sessionId: string;
  turnId: string;
}): Promise<CodexRolloutTurnResult> {
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
  return codexRolloutTurnFromJsonLines(transcript, input);
}

export async function readCodexInterruptedRolloutTurn(input: {
  transcriptPath: string;
  sessionId: string;
  turnId: string;
}): Promise<CodexInterruptedRolloutTurnResult> {
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
  return codexInterruptedRolloutTurnFromJsonLines(transcript, input);
}

export function codexRolloutTurnFromJsonLines(
  transcript: string,
  input: { sessionId: string; turnId: string },
): CodexRolloutTurnResult {
  const scan = scanCodexRolloutTurn(transcript, input.turnId);
  if (!codexRolloutSessionMatches(scan, input.sessionId)) {
    return { ok: false, reason: "transcript_session_mismatch" };
  }
  if (scan.turnMetadataMismatch) return { ok: false, reason: "turn_metadata_mismatch" };
  if (!scan.targetSeen) return { ok: false, reason: "turn_not_found" };
  if (!scan.userPrompt) return { ok: false, reason: "user_prompt_missing" };
  if (!scan.assistantReply) return { ok: false, reason: "assistant_message_missing" };
  return {
    ok: true,
    turn: rolloutTurnFromScan(scan, input, scan.userPrompt, scan.assistantReply),
  };
}

export function codexInterruptedRolloutTurnFromJsonLines(
  transcript: string,
  input: { sessionId: string; turnId: string },
): CodexInterruptedRolloutTurnResult {
  const scan = scanCodexRolloutTurn(transcript, input.turnId);
  if (!codexRolloutSessionMatches(scan, input.sessionId)) {
    return { ok: false, reason: "transcript_session_mismatch" };
  }
  if (scan.turnMetadataMismatch) return { ok: false, reason: "turn_metadata_mismatch" };
  if (!scan.targetSeen) return { ok: false, reason: "turn_not_found" };
  if (!scan.userPrompt) return { ok: false, reason: "user_prompt_missing" };
  if (!scan.interrupted) return { ok: false, reason: "turn_not_interrupted" };
  if (scan.rolledBack) return { ok: false, reason: "turn_rolled_back" };
  const sessionTurnIndex = sessionTurnIndexFromScan(scan, input.turnId);
  return {
    ok: true,
    turn: {
      ...rolloutTurnFromScan(scan, input, scan.userPrompt, scan.visibleAssistantMessages.join("\n\n")),
      ...(scan.interruptedAt ? { interruptedAt: scan.interruptedAt } : {}),
      ...(sessionTurnIndex === undefined ? {} : { sessionTurnIndex }),
    },
  };
}

type CodexRolloutTurnScan = {
  authoritySessionId?: string;
  authoritySource?: string;
  ambiguousSessionMetadata: boolean;
  composite: boolean;
  targetSeen: boolean;
  turnMetadataMismatch: boolean;
  userPrompt?: string;
  assistantReply?: string;
  visibleAssistantMessages: string[];
  interrupted: boolean;
  interruptedAt?: string;
  rolledBack: boolean;
  targetTokenUsage: CodexTurnTokenUsage;
  targetTokenSnapshotSeen: boolean;
  targetActivityGroups: CodexTurnActivityCandidate[][];
  orderedTurnIds: string[];
  turnContextIds: Set<string>;
  userMessageTurnIds: Set<string>;
};

function scanCodexRolloutTurn(transcript: string, targetTurnId: string): CodexRolloutTurnScan {
  let authoritySessionId: string | undefined;
  let ambiguousSessionMetadata = false;
  let composite = false;
  let firstNonBlankLineSeen = false;
  let targetBoundarySeen = false;
  let activeTurnId: string | undefined;
  let targetSeen = false;
  let turnMetadataMismatch = false;
  let userPrompt: string | undefined;
  let assistantReply: string | undefined;
  const visibleAssistantMessages: string[] = [];
  let responseItemUserPrompt: string | undefined;
  let responseItemAssistantReply: string | undefined;
  let interrupted = false;
  let interruptedAt: string | undefined;
  let rolledBack = false;
  let awaitingTargetSuccessor = false;
  let latestTokenUsage: CodexTurnTokenUsage | undefined;
  let targetTokenUsage = emptyTokenUsage();
  let targetTokenSnapshotSeen = false;
  let authoritySource: string | undefined;
  const targetActivityGroups: CodexTurnActivityCandidate[][] = [];
  const orderedTurnIds: string[] = [];
  const seenTurnIds = new Set<string>();
  const turnContextIds = new Set<string>();
  const userMessageTurnIds = new Set<string>();

  const observeTurn = (turnId: string | undefined, source: "turn_context" | "task_started"): void => {
    activeTurnId = turnId;
    if (!turnId || seenTurnIds.has(turnId)) return;
    seenTurnIds.add(turnId);
    orderedTurnIds.push(turnId);
    if (source === "turn_context") turnContextIds.add(turnId);
  };

  for (const line of transcript.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const authorityHeaderCandidate = !firstNonBlankLineSeen;
    firstNonBlankLineSeen = true;
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
      if (authorityHeaderCandidate) {
        authoritySessionId = nonBlankString(payload.id);
        authoritySource = stringValue(payload.source)?.toLowerCase();
      } else {
        const importedSessionId = nonBlankString(payload.id);
        if (importedSessionId && importedSessionId === authoritySessionId) continue;
        composite = true;
        if (targetBoundarySeen || !importedSessionId) {
          ambiguousSessionMetadata = true;
        }
      }
      continue;
    }
    if (record.type === "turn_context") {
      const turnId = stringValue(payload.turn_id) ?? stringValue(payload.turnId);
      observeTurn(turnId, "turn_context");
      if (turnId === targetTurnId) {
        targetSeen = true;
        targetBoundarySeen = true;
      }
      continue;
    }
    if (record.type === "response_item") {
      if (activeTurnId === targetTurnId) {
        const activities = activityCandidatesFromResponseItem(payload);
        if (activities.length > 0) targetActivityGroups.push(activities);
        if (stringValue(payload.type) === "message") {
          const role = stringValue(payload.role);
          const message = responseItemMessageText(payload.content, role);
          const authoritativeMessage = role === "user"
            || (role === "assistant" && payload.phase === "final_answer");
          if (authoritativeMessage && message) {
            const responseTurnId = responseItemTurnId(payload);
            if (responseTurnId && responseTurnId !== activeTurnId) {
              turnMetadataMismatch = true;
              continue;
            }
            if (role === "user") {
              userMessageTurnIds.add(activeTurnId);
              responseItemUserPrompt = message;
            } else {
              responseItemAssistantReply = message;
            }
          }
        }
      }
      continue;
    }
    if (record.type !== "event_msg") continue;

    const eventType = stringValue(payload.type);
    if (eventType === "task_started") {
      const startedTurnId = stringValue(payload.turn_id) ?? stringValue(payload.turnId);
      if (awaitingTargetSuccessor && startedTurnId && startedTurnId !== targetTurnId) {
        awaitingTargetSuccessor = false;
      }
      observeTurn(startedTurnId, "task_started");
      if (activeTurnId === targetTurnId) {
        targetSeen = true;
        targetBoundarySeen = true;
      }
      continue;
    }
    if (eventType === "task_complete") {
      const completedTurnId = stringValue(payload.turn_id) ?? stringValue(payload.turnId);
      if (completedTurnId === targetTurnId) {
        targetSeen = true;
        assistantReply ??= nonBlankString(payload.last_agent_message) ?? nonBlankString(payload.lastAgentMessage);
      }
      if (completedTurnId && completedTurnId === activeTurnId) activeTurnId = undefined;
      continue;
    }
    if (eventType === "turn_aborted") {
      const abortedTurnId = stringValue(payload.turn_id) ?? stringValue(payload.turnId);
      if (abortedTurnId === targetTurnId) {
        targetSeen = true;
        interrupted = stringValue(payload.reason) === "interrupted";
        interruptedAt = rolloutRecordTimestamp(record, payload);
        awaitingTargetSuccessor = interrupted;
      }
      if (abortedTurnId && abortedTurnId === activeTurnId) activeTurnId = undefined;
      continue;
    }
    if (eventType === "thread_rolled_back") {
      if (awaitingTargetSuccessor) rolledBack = true;
      continue;
    }
    if (eventType === "token_count") {
      const snapshot = tokenUsageSnapshot(payload);
      if (!snapshot) continue;
      if (activeTurnId === targetTurnId) {
        targetTokenSnapshotSeen = true;
        const previous = latestTokenUsage ?? emptyTokenUsage();
        if (!tokenUsageDecreased(previous, snapshot)) {
          targetTokenUsage = addTokenUsageDelta(targetTokenUsage, previous, snapshot);
        }
      }
      latestTokenUsage = snapshot;
      continue;
    }
    if (eventType === "user_message") {
      if (activeTurnId) userMessageTurnIds.add(activeTurnId);
      if (activeTurnId !== targetTurnId) continue;
      userPrompt = nonBlankString(payload.message) ?? userPrompt;
      continue;
    }
    if (activeTurnId !== targetTurnId) continue;
    if (eventType === "agent_message") {
      const message = nonBlankString(payload.message);
      if (!message) continue;
      if (payload.phase === "commentary" || payload.phase === "final_answer") {
        visibleAssistantMessages.push(message);
      }
      if (payload.phase === "final_answer") assistantReply = message;
    }
  }

  return {
    authoritySessionId,
    authoritySource,
    ambiguousSessionMetadata,
    composite,
    targetSeen,
    turnMetadataMismatch,
    userPrompt: responseItemUserPrompt ?? userPrompt,
    assistantReply: responseItemAssistantReply ?? assistantReply,
    visibleAssistantMessages,
    interrupted,
    interruptedAt,
    rolledBack,
    targetTokenUsage,
    targetTokenSnapshotSeen,
    targetActivityGroups,
    orderedTurnIds,
    turnContextIds,
    userMessageTurnIds,
  };
}

function responseItemTurnId(payload: JsonRecord): string | undefined {
  const metadata = isRecord(payload.internal_chat_message_metadata_passthrough)
    ? payload.internal_chat_message_metadata_passthrough
    : undefined;
  return metadata
    ? stringValue(metadata.turn_id) ?? stringValue(metadata.turnId)
    : undefined;
}

function responseItemMessageText(value: unknown, role: string | undefined): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const expectedType = role === "user" ? "input_text" : role === "assistant" ? "output_text" : undefined;
  if (!expectedType) return undefined;
  const parts = value.flatMap((item): string[] => {
    if (!isRecord(item) || stringValue(item.type) !== expectedType) return [];
    const text = nonBlankString(item.text);
    return text ? [text] : [];
  });
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function codexRolloutSessionMatches(scan: CodexRolloutTurnScan, sessionId: string): boolean {
  return scan.authoritySessionId === sessionId && !scan.ambiguousSessionMetadata;
}

function sessionTurnIndexFromScan(scan: CodexRolloutTurnScan, targetTurnId: string): number | undefined {
  if (scan.composite) return undefined;
  const countedTurnIds = scan.orderedTurnIds.filter((turnId) => (
    scan.turnContextIds.has(turnId) || scan.userMessageTurnIds.has(turnId)
  ));
  const index = countedTurnIds.indexOf(targetTurnId);
  return index === -1 ? undefined : index + 1;
}

function rolloutTurnFromScan(
  scan: CodexRolloutTurnScan,
  input: { sessionId: string; turnId: string },
  userPrompt: string,
  assistantReply: string,
): CodexRolloutTurn {
  return {
    sessionId: input.sessionId,
    turnId: input.turnId,
    userPrompt,
    assistantReply,
    activities: materializeTurnActivities(scan.targetActivityGroups, scan.authoritySource !== "exec"),
    ...(scan.targetTokenSnapshotSeen && !scan.composite ? { usage: scan.targetTokenUsage } : {}),
  };
}

function rolloutRecordTimestamp(record: JsonRecord, payload: JsonRecord): string | undefined {
  const timestamp = stringValue(record.timestamp);
  if (timestamp && Number.isFinite(Date.parse(timestamp))) return timestamp;
  const completedAt = nonNegativeInteger(payload.completed_at ?? payload.completedAt);
  if (completedAt === undefined) return undefined;
  const millis = completedAt < 1_000_000_000_000 ? completedAt * 1000 : completedAt;
  return new Date(millis).toISOString();
}

type CodexTurnActivityCandidate =
  | Readonly<{
    offset: number;
    type: "repo_memory_operation";
    operation: CodexRepoMemoryOperation;
  }>
  | Readonly<{
    offset: number;
    type: "memory_cli_search" | "memory_cli_add";
  }>;

function activityCandidatesFromResponseItem(payload: JsonRecord): CodexTurnActivityCandidate[] {
  const payloadType = stringValue(payload.type);
  if (payloadType !== "custom_tool_call" && payloadType !== "function_call") return [];
  const input = toolCallInputText(payload.input ?? payload.arguments);
  if (!input) return [];

  const candidates: CodexTurnActivityCandidate[] = [];
  const operationReferencePattern = /[\\/]+plugins[\\/]+cache[\\/]+[^"'`\r\n]*?[\\/]+skills[\\/]+memorax-code[\\/]+references[\\/]+repo-(build|read|update)\.md\b/giu;
  for (const match of input.matchAll(operationReferencePattern)) {
    candidates.push({
      offset: match.index,
      type: "repo_memory_operation",
      operation: `repo-${match[1]}` as CodexRepoMemoryOperation,
    });
  }

  const backgroundJobPattern = /[\\/]+plugins[\\/]+cache[\\/]+[^"'`\r\n]*?[\\/]+hooks[\\/]+repo-memory-job\.mjs\\?["']?\s+start\s+--mode(?:=|\s+)(build|update)\b/giu;
  for (const match of input.matchAll(backgroundJobPattern)) {
    candidates.push({
      offset: match.index,
      type: "repo_memory_operation",
      operation: match[1] === "build" ? "repo-build" : "repo-update",
    });
  }

  const memoryCliPattern = /(?:["']?cmd["']?\s*:\s*\\?["'`]|&&|\|\||;)\s*memorax-cli\s+(search|add)\b/giu;
  for (const match of input.matchAll(memoryCliPattern)) {
    candidates.push({
      offset: match.index,
      type: match[1] === "search" ? "memory_cli_search" : "memory_cli_add",
    });
  }
  return candidates.sort((left, right) => left.offset - right.offset);
}

function materializeTurnActivities(
  groups: CodexTurnActivityCandidate[][],
  includeRepoMemoryOperations: boolean,
): CodexTurnActivity[] {
  const activities: CodexTurnActivity[] = [];
  const seenOperations = new Set<CodexRepoMemoryOperation>();
  let index = 1;
  for (const group of groups) {
    const accepted = group.filter((candidate) => {
      if (candidate.type !== "repo_memory_operation") return true;
      if (!includeRepoMemoryOperations || seenOperations.has(candidate.operation)) return false;
      seenOperations.add(candidate.operation);
      return true;
    });
    if (accepted.length === 0) continue;
    for (const candidate of accepted) {
      if (candidate.type === "repo_memory_operation") {
        activities.push({ index, type: candidate.type, operation: candidate.operation });
      } else {
        activities.push({ index, type: candidate.type });
      }
    }
    index += 1;
  }
  return activities;
}

function toolCallInputText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value === undefined) return undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

const TOKEN_USAGE_FIELDS = [
  "input_tokens",
  "cached_input_tokens",
  "cache_write_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
  "total_tokens",
] as const;

function tokenUsageSnapshot(payload: JsonRecord): CodexTurnTokenUsage | undefined {
  const info = isRecord(payload.info) ? payload.info : undefined;
  const usage = info && isRecord(info.total_token_usage) ? info.total_token_usage : undefined;
  if (!usage) return undefined;
  const snapshot = emptyTokenUsage();
  for (const field of TOKEN_USAGE_FIELDS) {
    const value = nonNegativeInteger(
      usage[field] ?? (field === "cache_write_input_tokens" ? 0 : undefined),
    );
    if (value === undefined) return undefined;
    snapshot[field] = value;
  }
  return snapshot;
}

function addTokenUsageDelta(
  total: CodexTurnTokenUsage,
  previous: CodexTurnTokenUsage,
  current: CodexTurnTokenUsage,
): CodexTurnTokenUsage {
  const next = { ...total };
  for (const field of TOKEN_USAGE_FIELDS) next[field] += current[field] - previous[field];
  return next;
}

function tokenUsageDecreased(previous: CodexTurnTokenUsage, current: CodexTurnTokenUsage): boolean {
  return TOKEN_USAGE_FIELDS.some((field) => current[field] < previous[field]);
}

function emptyTokenUsage(): CodexTurnTokenUsage {
  return {
    input_tokens: 0,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: 0,
  };
}

function nonNegativeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
}

function nonBlankString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
