import { readFile } from "node:fs/promises";

type JsonRecord = Record<string, unknown>;

export type ClaudeTurnTokenUsage = {
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

export type ClaudeTurnActivity = Readonly<{
  index: number;
  type: "memory_cli_search" | "memory_cli_add";
}>;

export type ClaudeTranscriptMemoryActivity = Readonly<{
  promptId: string;
  index: number;
  occurrence: number;
  type: ClaudeTurnActivity["type"];
  toolUseId: string;
  terminalRecordId?: string;
  timestamp?: string;
  ok?: boolean;
  itemCount?: number;
}>;

export type ClaudeTranscriptTurn = {
  sessionId: string;
  promptId: string;
  sessionTurnIndex: number;
  userPrompt: string;
  assistantReply: string;
  activities: ClaudeTurnActivity[];
  usage?: ClaudeTurnTokenUsage;
};

export type ClaudeTranscriptTurnFailureReason =
  | "transcript_unavailable"
  | "transcript_session_mismatch"
  | "turn_not_found"
  | "turn_ambiguous"
  | "user_prompt_missing"
  | "assistant_message_missing";

export type ClaudeTranscriptTurnResult =
  | { ok: true; turn: ClaudeTranscriptTurn }
  | { ok: false; reason: ClaudeTranscriptTurnFailureReason; error?: string };

export type ClaudeInterruptedTranscriptTurn = ClaudeTranscriptTurn & {
  interruptedAt?: string;
};

export type ClaudeInterruptedTranscriptTurnFailureReason =
  | Exclude<ClaudeTranscriptTurnFailureReason, "assistant_message_missing">
  | "turn_not_interrupted";

export type ClaudeInterruptedTranscriptTurnResult =
  | { ok: true; turn: ClaudeInterruptedTranscriptTurn }
  | {
    ok: false;
    reason: ClaudeInterruptedTranscriptTurnFailureReason;
    error?: string;
  };

export async function readClaudeTranscriptTurn(input: {
  transcriptPath: string;
  sessionId: string;
  promptId: string;
}): Promise<ClaudeTranscriptTurnResult> {
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
  return claudeTranscriptTurnFromJsonLines(transcript, input);
}

export async function readClaudeInterruptedTranscriptTurn(input: {
  transcriptPath: string;
  sessionId: string;
  promptId: string;
}): Promise<ClaudeInterruptedTranscriptTurnResult> {
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
  return claudeInterruptedTranscriptTurnFromJsonLines(transcript, input);
}

export function claudeTranscriptTurnFromJsonLines(
  transcript: string,
  input: { sessionId: string; promptId: string },
): ClaudeTranscriptTurnResult {
  const requested = requestedTranscriptRecords(transcript, input.sessionId);
  if (!requested.ok) return requested;
  const records = requested.records;

  const promptRecords = records.filter((record) => (
    promptIdFromRecord(record) === input.promptId && isInteractiveUserRecord(record)
  ));
  if (promptRecords.length === 0) return { ok: false, reason: "turn_not_found" };
  const sessionTurnIndex = interactivePromptIndex(records, input.promptId);
  const recordsByUuid = indexRecordsByUuid(records);

  const candidates: Array<{
    branch: ClaudePromptBranch;
    userPrompt: string;
    assistantReply?: string;
    activities: ClaudeTurnActivity[];
    usage?: ClaudeTurnTokenUsage;
  }> = [];
  let ambiguousBranch = false;
  for (const record of records) {
    if (!isCompletedAssistantRecord(record)) continue;
    const assistantReply = completedAssistantReply(record);
    const branch = promptBranch(record, recordsByUuid);
    if (branch.ambiguous) {
      ambiguousBranch = true;
      continue;
    }
    if (branch.promptId === input.promptId && branch.userPrompt) {
      const usage = aggregateClaudeUsage(branch.assistantMessages);
      candidates.push({
        branch,
        userPrompt: branch.userPrompt,
        ...(assistantReply ? { assistantReply } : {}),
        activities: claudeMemoryActivities(branch.assistantMessages),
        ...(usage ? { usage } : {}),
      });
    }
  }

  const terminalCandidates = maximalTerminalLineages(candidates);
  if (ambiguousBranch || terminalCandidates.length > 1) {
    return { ok: false, reason: "turn_ambiguous" };
  }
  const candidate = terminalCandidates[0];
  if (candidate?.assistantReply && sessionTurnIndex !== undefined) {
    return {
      ok: true,
      turn: {
        sessionId: input.sessionId,
        promptId: input.promptId,
        sessionTurnIndex,
        userPrompt: candidate.userPrompt,
        assistantReply: candidate.assistantReply,
        activities: candidate.activities,
        ...(candidate.usage ? { usage: candidate.usage } : {}),
      },
    };
  }
  if (!promptRecords.some((record) => visibleUserPrompt(record))) {
    return { ok: false, reason: "user_prompt_missing" };
  }
  return { ok: false, reason: "assistant_message_missing" };
}

export function claudeInterruptedTranscriptTurnFromJsonLines(
  transcript: string,
  input: { sessionId: string; promptId: string },
): ClaudeInterruptedTranscriptTurnResult {
  const requested = requestedTranscriptRecords(transcript, input.sessionId);
  if (!requested.ok) return requested;
  const records = requested.records;
  const promptRecords = records.filter((record) => (
    promptIdFromRecord(record) === input.promptId && isInteractiveUserRecord(record)
  ));
  if (promptRecords.length === 0) return { ok: false, reason: "turn_not_found" };
  const sessionTurnIndex = interactivePromptIndex(records, input.promptId);
  const recordsByUuid = indexRecordsByUuid(records);

  const candidates: Array<{
    userPrompt: string;
    assistantReply: string;
    activities: ClaudeTurnActivity[];
    usage?: ClaudeTurnTokenUsage;
    interruptedAt?: string;
  }> = [];
  let ambiguousBranch = false;
  for (const record of records) {
    if (!interruptionMarker(record)) continue;
    const prompt = promptOnBranch(record, recordsByUuid, input.promptId);
    if (prompt.ambiguous) {
      ambiguousBranch = true;
      continue;
    }
    if (!prompt.userPrompt || !prompt.assistantMessages) continue;
    if (prompt.assistantMessages.some((message) => message.stop_reason === "end_turn")) continue;
    const usage = aggregateClaudeUsage(prompt.assistantMessages);
    const interruptedAt = transcriptRecordTimestamp(record);
    candidates.push({
      userPrompt: prompt.userPrompt,
      assistantReply: interruptedAssistantReply(prompt.assistantMessages),
      activities: claudeMemoryActivities(prompt.assistantMessages),
      ...(usage ? { usage } : {}),
      ...(interruptedAt ? { interruptedAt } : {}),
    });
  }

  if (ambiguousBranch || candidates.length > 1) {
    return { ok: false, reason: "turn_ambiguous" };
  }
  const candidate = candidates[0];
  if (candidate && sessionTurnIndex !== undefined) {
    return {
      ok: true,
      turn: {
        sessionId: input.sessionId,
        promptId: input.promptId,
        sessionTurnIndex,
        ...candidate,
      },
    };
  }
  if (!promptRecords.some((record) => visibleUserPrompt(record))) {
    return { ok: false, reason: "user_prompt_missing" };
  }
  return { ok: false, reason: "turn_not_interrupted" };
}

export function claudeTranscriptMemoryActivitiesFromJsonLines(
  transcript: string,
  input: { sessionId: string; includeAuthority?: boolean },
): ClaudeTranscriptMemoryActivity[] {
  const requested = requestedTranscriptRecords(transcript, input.sessionId);
  if (!requested.ok) return [];
  const records = requested.records;
  const recordsByUuid = indexRecordsByUuid(records);
  const terminals = new Map<string, ClaudePromptBranch[]>();
  const interrupted = new Map<string, ClaudePromptBranch[]>();
  for (const record of records) {
    if (isMemoryActivityTerminalAssistantRecord(record)) {
      const branch = promptBranch(record, recordsByUuid);
      if (!branch.ambiguous && branch.promptId && branch.userPrompt) {
        const candidates = terminals.get(branch.promptId) ?? [];
        candidates.push(branch);
        terminals.set(branch.promptId, candidates);
      }
      continue;
    }
    if (!interruptionMarker(record)) continue;
    const branch = promptBranch(record, recordsByUuid);
    if (branch.ambiguous
      || !branch.promptId
      || !branch.userPrompt
      || branch.assistantMessages.some((message) => message.stop_reason === "end_turn")) {
      continue;
    }
    const candidates = interrupted.get(branch.promptId) ?? [];
    candidates.push(branch);
    interrupted.set(branch.promptId, candidates);
  }

  const activities: ClaudeTranscriptMemoryActivity[] = [];
  const promptIds = new Set([...terminals.keys(), ...interrupted.keys()]);
  for (const promptId of promptIds) {
    const terminalBranches = maximalTerminalLineages(
      (terminals.get(promptId) ?? []).map((branch) => ({ branch })),
    ).map((candidate) => candidate.branch);
    const interruptedBranches = interrupted.get(promptId) ?? [];
    const branch = terminalBranches.length === 1
      ? terminalBranches[0]
      : terminalBranches.length === 0 && interruptedBranches.length === 1
        ? interruptedBranches[0]
        : undefined;
    if (!branch) continue;
    activities.push(...claudeMemoryActivityDetails(
      promptId,
      branch,
      input.includeAuthority === true,
    ));
  }
  return activities;
}

function requestedTranscriptRecords(
  transcript: string,
  sessionId: string,
):
  | { ok: true; records: JsonRecord[] }
  | {
    ok: false;
    reason: "transcript_unavailable" | "transcript_session_mismatch";
    error?: string;
  } {
  const parsed = transcriptRecords(transcript);
  if (!parsed.ok) {
    return {
      ok: false,
      reason: "transcript_unavailable",
      error: "Claude transcript contains an invalid completed JSONL record.",
    };
  }
  const records = requestedSessionRecords(parsed.records, sessionId);
  return records
    ? { ok: true, records }
    : { ok: false, reason: "transcript_session_mismatch" };
}

function indexRecordsByUuid(records: JsonRecord[]): Map<string, JsonRecord> {
  const indexed = new Map<string, JsonRecord>();
  for (const record of records) {
    const uuid = stringValue(record.uuid);
    if (uuid) indexed.set(uuid, record);
  }
  return indexed;
}

function requestedSessionRecords(
  records: JsonRecord[],
  requestedSessionId: string,
): JsonRecord[] | undefined {
  let requestedSessionStart: number | undefined;
  for (const [index, record] of records.entries()) {
    const sessionId = sessionIdFromRecord(record);
    if (!sessionId) continue;
    if (requestedSessionStart === undefined) {
      if (sessionId === requestedSessionId) requestedSessionStart = index;
      continue;
    }
    if (sessionId !== requestedSessionId) return undefined;
  }
  return requestedSessionStart === undefined
    ? undefined
    : records.slice(requestedSessionStart);
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
      // Claude may append while the file is being read; only an unterminated tail can be incomplete.
      if (records.length > 0 && index === lines.length - 1 && !transcript.endsWith("\n")) continue;
      return { ok: false };
    }
  }
  return { ok: true, records };
}

type ClaudePromptBranch = Readonly<{
  promptId?: string;
  userPrompt?: string;
  assistantMessages: JsonRecord[];
  records: JsonRecord[];
  ambiguous: boolean;
}>;

function maximalTerminalLineages<T extends Readonly<{ branch: ClaudePromptBranch }>>(
  candidates: readonly T[],
): T[] {
  const indexesByRecord = new Map<JsonRecord, number[]>();
  const indexesByUuid = new Map<string, number[]>();
  for (const [index, candidate] of candidates.entries()) {
    const terminal = candidate.branch.records[0];
    if (!terminal) continue;
    indexesByRecord.set(terminal, [...(indexesByRecord.get(terminal) ?? []), index]);
    const uuid = stringValue(terminal.uuid);
    if (uuid) indexesByUuid.set(uuid, [...(indexesByUuid.get(uuid) ?? []), index]);
  }

  const superseded = new Set<number>();
  for (const [descendantIndex, candidate] of candidates.entries()) {
    for (const ancestor of candidate.branch.records.slice(1)) {
      const ancestorUuid = stringValue(ancestor.uuid);
      const indexes = new Set([
        ...(indexesByRecord.get(ancestor) ?? []),
        ...(ancestorUuid ? indexesByUuid.get(ancestorUuid) ?? [] : []),
      ]);
      for (const ancestorIndex of indexes) {
        if (ancestorIndex !== descendantIndex) superseded.add(ancestorIndex);
      }
    }
  }
  return candidates.filter((candidate, index) => (
    Boolean(candidate.branch.records[0]) && !superseded.has(index)
  ));
}

function promptBranch(
  terminal: JsonRecord,
  recordsByUuid: Map<string, JsonRecord>,
): ClaudePromptBranch {
  const visited = new Set<string>();
  const assistantMessages: JsonRecord[] = [];
  const branchRecords: JsonRecord[] = [];
  let current: JsonRecord | undefined = terminal;
  while (current) {
    branchRecords.push(current);
    const uuid = stringValue(current.uuid);
    if (uuid) {
      if (visited.has(uuid)) return { assistantMessages, records: branchRecords, ambiguous: true };
      visited.add(uuid);
    }
    const assistantMessage = assistantMessageFromRecord(current);
    if (assistantMessage) assistantMessages.push(assistantMessage);
    const prompt = visibleUserPrompt(current);
    if (prompt) {
      return {
        promptId: promptIdFromRecord(current),
        userPrompt: prompt,
        assistantMessages,
        records: branchRecords,
        ambiguous: false,
      };
    }
    const parentUuid: string | undefined = stringValue(current.parentUuid) ?? stringValue(current.parent_uuid);
    current = parentUuid ? recordsByUuid.get(parentUuid) : undefined;
  }
  return { assistantMessages, records: branchRecords, ambiguous: false };
}

function promptOnBranch(
  assistant: JsonRecord,
  recordsByUuid: Map<string, JsonRecord>,
  promptId: string,
): { userPrompt?: string; assistantMessages?: JsonRecord[]; ambiguous: boolean } {
  const branch = promptBranch(assistant, recordsByUuid);
  if (branch.ambiguous) return { ambiguous: true };
  return branch.promptId === promptId && branch.userPrompt
    ? {
      userPrompt: branch.userPrompt,
      assistantMessages: branch.assistantMessages,
      ambiguous: false,
    }
    : { ambiguous: false };
}

function visibleUserPrompt(record: JsonRecord): string | undefined {
  if (!isInteractiveUserRecord(record)) return undefined;
  const message = record.message as JsonRecord;
  return visibleMessageText(message.content);
}

function isInteractiveUserRecord(record: JsonRecord): boolean {
  if (record.type !== "user"
    || record.userType !== "external"
    || record.isSidechain === true
    || record.isMeta === true
    || record.isCompactSummary === true
    || record.isVisibleInTranscriptOnly === true) {
    return false;
  }
  const origin = isRecord(record.origin) ? record.origin : undefined;
  if (stringValue(origin?.kind)?.toLowerCase() === "task-notification"
    || stringValue(record.promptSource ?? record.prompt_source)?.toLowerCase() === "system"
    || stringValue(record.interruptedMessageId ?? record.interrupted_message_id)) {
    return false;
  }
  const message = isRecord(record.message) ? record.message : undefined;
  return Boolean(message && message.role === "user");
}

function interactivePromptIndex(
  records: JsonRecord[],
  targetPromptId: string,
): number | undefined {
  const seenPromptIds = new Set<string>();
  let index = 0;
  for (const record of records) {
    if (!visibleUserPrompt(record)) continue;
    const promptId = promptIdFromRecord(record);
    if (!promptId || seenPromptIds.has(promptId)) continue;
    seenPromptIds.add(promptId);
    index += 1;
    if (promptId === targetPromptId) return index;
  }
  return undefined;
}

function interruptionMarker(record: JsonRecord): boolean {
  return record.type === "user"
    && record.isSidechain !== true
    && Boolean(stringValue(record.interruptedMessageId ?? record.interrupted_message_id));
}

function interruptedAssistantReply(assistantMessages: JsonRecord[]): string {
  const textSegments: string[] = [];
  const seenByMessageId = new Set<string>();
  for (const message of assistantMessages.slice().reverse()) {
    const text = visibleMessageText(message.content);
    if (!text) continue;
    const messageId = stringValue(message.id);
    const dedupeKey = messageId ? `${messageId}\u0000${text}` : undefined;
    if (dedupeKey && seenByMessageId.has(dedupeKey)) continue;
    if (dedupeKey) seenByMessageId.add(dedupeKey);
    textSegments.push(text);
  }
  return textSegments.join("\n\n");
}

function transcriptRecordTimestamp(record: JsonRecord): string | undefined {
  const timestamp = stringValue(record.timestamp);
  return timestamp && Number.isFinite(Date.parse(timestamp)) ? timestamp : undefined;
}

function claudeMemoryActivityDetails(
  promptId: string,
  branch: ClaudePromptBranch,
  includeAuthority: boolean,
): ClaudeTranscriptMemoryActivity[] {
  const activities: ClaudeTranscriptMemoryActivity[] = [];
  const terminalRecordId = includeAuthority
    ? stringValue(branch.records[0]?.uuid)
    : undefined;
  const seenToolUseIds = new Set<string>();
  let index = 1;
  for (const record of branch.records.slice().reverse()) {
    const message = assistantMessageFromRecord(record);
    if (!message || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (!isRecord(block) || block.type !== "tool_use") continue;
      const toolUseId = stringValue(block.id);
      if (!toolUseId || seenToolUseIds.has(toolUseId)) continue;
      seenToolUseIds.add(toolUseId);
      if (block.name !== "Bash") continue;
      const toolInput = isRecord(block.input) ? block.input : undefined;
      const command = toolInput ? stringValue(toolInput.command) : undefined;
      if (!command) continue;
      const types = memoryCliCommandTypes(command);
      if (types.length === 0) continue;
      const timestamp = canonicalTranscriptActivityTimestamp(record);
      const result = claudeToolResultDetails(
        branch.records,
        toolUseId,
        types.length === 1 && types[0] === "memory_cli_search",
      );
      for (const [occurrence, type] of types.entries()) {
        activities.push({
          promptId,
          index,
          occurrence: occurrence + 1,
          type,
          toolUseId,
          ...(terminalRecordId ? { terminalRecordId } : {}),
          ...(timestamp ? { timestamp } : {}),
          ...(result.ok === undefined ? {} : { ok: result.ok }),
          ...(type === "memory_cli_search" && result.itemCount !== undefined
            ? { itemCount: result.itemCount }
            : {}),
        });
      }
      index += 1;
    }
  }
  return activities;
}

function canonicalTranscriptActivityTimestamp(record: JsonRecord): string | undefined {
  const timestamp = transcriptRecordTimestamp(record);
  return timestamp ? new Date(Date.parse(timestamp)).toISOString() : undefined;
}

function claudeToolResultDetails(
  branchRecords: readonly JsonRecord[],
  toolUseId: string,
  deriveSearchItemCount: boolean,
): Readonly<{ ok?: boolean; itemCount?: number }> {
  const matches: JsonRecord[] = [];
  let failed = false;
  for (const record of branchRecords) {
    const message = isRecord(record.message) ? record.message : undefined;
    if (message?.role !== "user" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (!isRecord(block)
        || block.type !== "tool_result"
        || stringValue(block.tool_use_id ?? block.toolUseId) !== toolUseId) {
        continue;
      }
      matches.push(block);
      if (block.is_error === true) failed = true;
    }
  }
  if (matches.length === 0) return {};
  if (failed) return { ok: false };
  if (!deriveSearchItemCount || matches.length !== 1) return { ok: true };
  const itemCount = safeMemorySearchItemCount(matches[0]?.content);
  return itemCount === undefined ? { ok: true } : { ok: true, itemCount };
}

function memoryCliCommandTypes(command: string): ClaudeTurnActivity["type"][] {
  const activities: ClaudeTurnActivity["type"][] = [];
  for (const segment of shellCommandSegments(command)) {
    const words = shellWords(segment);
    if (!words) continue;
    let executableIndex = 0;
    while (isShellAssignmentWord(words[executableIndex])) executableIndex += 1;
    const executable = words[executableIndex];
    if (!isMemoraxCliExecutable(executable)) continue;
    const operation = words[executableIndex + 1]?.toLowerCase();
    if (operation === "search") activities.push("memory_cli_search");
    if (operation === "add") activities.push("memory_cli_add");
  }
  return activities;
}

function shellCommandSegments(command: string): string[] {
  const segments: string[] = [];
  let segment = "";
  let quote: "'" | "\"" | "`" | undefined;
  let escaped = false;
  let substitutionDepth = 0;
  const pushSegment = () => {
    if (segment.trim()) segments.push(segment);
    segment = "";
  };

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index] ?? "";
    if (escaped) {
      segment += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      segment += character;
      escaped = true;
      continue;
    }
    if (quote) {
      segment += character;
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === "\"" || character === "`") {
      quote = character;
      segment += character;
      continue;
    }
    if (character === "$" && command[index + 1] === "(") {
      substitutionDepth += 1;
      segment += "$(";
      index += 1;
      continue;
    }
    if (character === ")" && substitutionDepth > 0) {
      substitutionDepth -= 1;
      segment += character;
      continue;
    }
    if (substitutionDepth === 0 && (character === ";" || character === "\n" || character === "\r")) {
      pushSegment();
      if (character === "\r" && command[index + 1] === "\n") index += 1;
      continue;
    }
    if (substitutionDepth === 0
      && ((character === "&" && command[index + 1] === "&")
        || (character === "|" && command[index + 1] === "|"))) {
      pushSegment();
      index += 1;
      continue;
    }
    segment += character;
  }
  pushSegment();
  return segments;
}

function shellWords(segment: string): string[] | undefined {
  const words: string[] = [];
  let word = "";
  let hasWord = false;
  let quote: "'" | "\"" | undefined;
  for (let index = 0; index < segment.length; index += 1) {
    const character = segment[index] ?? "";
    if (quote === "'") {
      if (character === "'") quote = undefined;
      else word += character;
      hasWord = true;
      continue;
    }
    if (quote === "\"") {
      if (character === "\"") {
        quote = undefined;
      } else if (character === "\\"
        && ["\\", "\"", "$", "`", "\n"].includes(segment[index + 1] ?? "")) {
        index += 1;
        word += segment[index] ?? "";
      } else {
        word += character;
      }
      hasWord = true;
      continue;
    }
    if (character === "'" || character === "\"") {
      quote = character;
      hasWord = true;
      continue;
    }
    if (character === "\\") {
      index += 1;
      if (index >= segment.length) return undefined;
      word += segment[index] ?? "";
      hasWord = true;
      continue;
    }
    if (/\s/u.test(character)) {
      if (hasWord) words.push(word);
      word = "";
      hasWord = false;
      continue;
    }
    word += character;
    hasWord = true;
  }
  if (quote) return undefined;
  if (hasWord) words.push(word);
  return words;
}

function isShellAssignmentWord(word: string | undefined): boolean {
  return Boolean(word && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(word));
}

function isMemoraxCliExecutable(word: string | undefined): boolean {
  return isNamedExecutable(word, "memorax-cli");
}

function isNamedExecutable(word: string | undefined, name: string): boolean {
  if (!word) return false;
  const normalized = word.replaceAll("\\", "/");
  if (normalized === name || normalized === `${name}.mjs`) return true;
  const absolute = normalized.startsWith("/") || /^[A-Za-z]:\//u.test(normalized);
  if (!absolute) return false;
  const basename = normalized.slice(normalized.lastIndexOf("/") + 1);
  return basename === name || basename === `${name}.mjs`;
}

function safeMemorySearchItemCount(content: unknown): number | undefined {
  if (typeof content !== "string" || content.length > 2 * 1024 * 1024) return undefined;
  const output = content.trim();
  if (!output) return undefined;
  if (output.startsWith("{")) {
    try {
      const parsed = JSON.parse(output) as unknown;
      if (!isRecord(parsed)
        || parsed.ok !== true
        || parsed.action !== "memory.search"
        || !Array.isArray(parsed.items)
        || parsed.items.length > 100) {
        return undefined;
      }
      return parsed.items.length;
    } catch {
      return undefined;
    }
  }

  const lines = output.split(/\r?\n/u);
  if (lines[0] !== "<memories>" || lines.at(-1) !== "</memories>") return undefined;
  let insideFacts = false;
  let factsGroups = 0;
  let itemCount = 0;
  for (const line of lines.slice(1, -1)) {
    if (!insideFacts && /^ {2}<facts(?: memory_type="[^"\r\n]*")?>$/u.test(line)) {
      insideFacts = true;
      factsGroups += 1;
      continue;
    }
    if (insideFacts && line === "  </facts>") {
      insideFacts = false;
      continue;
    }
    if (insideFacts && /^ {3}-(?:\[[^\]\r\n]+\] | )\S.*$/u.test(line)) {
      itemCount += 1;
      if (itemCount > 100) return undefined;
      continue;
    }
    return undefined;
  }
  return !insideFacts && factsGroups > 0 && itemCount > 0 ? itemCount : undefined;
}

function claudeMemoryActivities(
  assistantMessages: JsonRecord[],
): ClaudeTurnActivity[] {
  const activities: ClaudeTurnActivity[] = [];
  const seenToolUseIds = new Set<string>();
  let index = 1;
  for (const message of assistantMessages.slice().reverse()) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (!isRecord(block) || block.type !== "tool_use") continue;
      const toolUseId = stringValue(block.id);
      if (!toolUseId || seenToolUseIds.has(toolUseId)) continue;
      seenToolUseIds.add(toolUseId);
      if (block.name !== "Bash") continue;
      const toolInput = isRecord(block.input) ? block.input : undefined;
      const command = toolInput ? stringValue(toolInput.command) : undefined;
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

type ClaudeUsageCounts = {
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
  ephemeral_1h_input_tokens: number;
  ephemeral_5m_input_tokens: number;
  web_search_requests: number;
  web_fetch_requests: number;
};

const CLAUDE_USAGE_COUNT_FIELDS = [
  "input_tokens",
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
  "output_tokens",
  "ephemeral_1h_input_tokens",
  "ephemeral_5m_input_tokens",
  "web_search_requests",
  "web_fetch_requests",
] as const satisfies ReadonlyArray<keyof ClaudeUsageCounts>;

function aggregateClaudeUsage(
  assistantMessages: JsonRecord[],
): ClaudeTurnTokenUsage | undefined {
  const usageByMessageId = new Map<string, ClaudeUsageCounts>();
  const totals = emptyClaudeUsageCounts();
  for (const message of assistantMessages) {
    const messageId = stringValue(message.id);
    const usage = claudeUsageCounts(message.usage);
    if (!messageId || !usage) return undefined;
    const existing = usageByMessageId.get(messageId);
    if (existing) {
      if (!sameClaudeUsageCounts(existing, usage)) return undefined;
      continue;
    }
    usageByMessageId.set(messageId, usage);
    if (!addClaudeUsageCounts(totals, usage)) return undefined;
  }
  return usageByMessageId.size > 0 ? claudeTokenUsage(totals) : undefined;
}

function claudeUsageCounts(value: unknown): ClaudeUsageCounts | undefined {
  if (!isRecord(value)) return undefined;
  const inputTokens = nonNegativeInteger(value.input_tokens);
  const cacheCreationInputTokens = nullableNonNegativeInteger(value.cache_creation_input_tokens);
  const cacheReadInputTokens = nullableNonNegativeInteger(value.cache_read_input_tokens);
  const outputTokens = nonNegativeInteger(value.output_tokens);
  const cacheCreation = nullableUsageGroup(value.cache_creation, [
    "ephemeral_1h_input_tokens",
    "ephemeral_5m_input_tokens",
  ]);
  const serverToolUse = nullableUsageGroup(value.server_tool_use, [
    "web_search_requests",
    "web_fetch_requests",
  ]);
  if (inputTokens === undefined
    || cacheCreationInputTokens === undefined
    || cacheReadInputTokens === undefined
    || outputTokens === undefined
    || !cacheCreation
    || !serverToolUse) {
    return undefined;
  }
  return {
    input_tokens: inputTokens,
    cache_creation_input_tokens: cacheCreationInputTokens,
    cache_read_input_tokens: cacheReadInputTokens,
    output_tokens: outputTokens,
    ephemeral_1h_input_tokens: cacheCreation.ephemeral_1h_input_tokens,
    ephemeral_5m_input_tokens: cacheCreation.ephemeral_5m_input_tokens,
    web_search_requests: serverToolUse.web_search_requests,
    web_fetch_requests: serverToolUse.web_fetch_requests,
  };
}

function nullableUsageGroup<const Fields extends readonly string[]>(
  value: unknown,
  fields: Fields,
): Record<Fields[number], number> | undefined {
  if (value === null) {
    return Object.fromEntries(fields.map((field) => [field, 0])) as Record<Fields[number], number>;
  }
  if (!isRecord(value)) return undefined;
  const entries = fields.map((field) => [field, nonNegativeInteger(value[field])] as const);
  if (entries.some(([, count]) => count === undefined)) return undefined;
  return Object.fromEntries(entries) as Record<Fields[number], number>;
}

function sameClaudeUsageCounts(left: ClaudeUsageCounts, right: ClaudeUsageCounts): boolean {
  return CLAUDE_USAGE_COUNT_FIELDS.every((field) => left[field] === right[field]);
}

function addClaudeUsageCounts(total: ClaudeUsageCounts, next: ClaudeUsageCounts): boolean {
  for (const field of CLAUDE_USAGE_COUNT_FIELDS) {
    const sum = total[field] + next[field];
    if (!Number.isSafeInteger(sum)) return false;
    total[field] = sum;
  }
  return true;
}

function emptyClaudeUsageCounts(): ClaudeUsageCounts {
  return Object.fromEntries(
    CLAUDE_USAGE_COUNT_FIELDS.map((field) => [field, 0]),
  ) as ClaudeUsageCounts;
}

function claudeTokenUsage(counts: ClaudeUsageCounts): ClaudeTurnTokenUsage {
  return {
    input_tokens: counts.input_tokens,
    cache_creation_input_tokens: counts.cache_creation_input_tokens,
    cache_read_input_tokens: counts.cache_read_input_tokens,
    output_tokens: counts.output_tokens,
    cache_creation: {
      ephemeral_1h_input_tokens: counts.ephemeral_1h_input_tokens,
      ephemeral_5m_input_tokens: counts.ephemeral_5m_input_tokens,
    },
    server_tool_use: {
      web_search_requests: counts.web_search_requests,
      web_fetch_requests: counts.web_fetch_requests,
    },
  };
}

function completedAssistantReply(record: JsonRecord): string | undefined {
  const message = assistantMessageFromRecord(record);
  if (!message || message.stop_reason !== "end_turn") return undefined;
  return visibleMessageText(message.content);
}

function isCompletedAssistantRecord(record: JsonRecord): boolean {
  return assistantMessageFromRecord(record)?.stop_reason === "end_turn";
}

function isMemoryActivityTerminalAssistantRecord(record: JsonRecord): boolean {
  const message = assistantMessageFromRecord(record);
  const stopReason = message ? stringValue(message.stop_reason) : undefined;
  return Boolean(message && (
    (stopReason && stopReason !== "tool_use")
    || record.isApiErrorMessage === true
    || record.error
  ));
}

function assistantMessageFromRecord(record: JsonRecord): JsonRecord | undefined {
  if (record.type !== "assistant"
    || record.isSidechain === true
    || record.isMeta === true
    || record.isCompactSummary === true
    || record.isVisibleInTranscriptOnly === true) {
    return undefined;
  }
  const message = isRecord(record.message) ? record.message : undefined;
  return message?.role === "assistant" ? message : undefined;
}

function visibleMessageText(content: unknown): string | undefined {
  if (typeof content === "string") return nonBlankString(content);
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((part) => isRecord(part) && part.type === "text" ? nonBlankString(part.text) : undefined)
    .filter(isString)
    .join("\n\n")
    .trim();
  return text || undefined;
}

function sessionIdFromRecord(record: JsonRecord): string | undefined {
  return stringValue(record.sessionId) ?? stringValue(record.session_id);
}

function promptIdFromRecord(record: JsonRecord): string | undefined {
  return stringValue(record.promptId) ?? stringValue(record.prompt_id);
}

function nonBlankString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
}

function nullableNonNegativeInteger(value: unknown): number | undefined {
  return value === null ? 0 : nonNegativeInteger(value);
}

function isString(value: string | undefined): value is string {
  return value !== undefined;
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
