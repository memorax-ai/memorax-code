import { createHash } from "node:crypto";
import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve as resolvePath } from "node:path";
import { memoryViewerEventKey } from "../projection/event-identity.js";
import { claudeTranscriptMemoryActivitiesFromJsonLines } from "../../clients/claude/transcript-turn.js";
import {
  resolveMemoryProject,
  type MemoryProjectIdentity,
} from "../../memory/project.js";
import type { MemoryViewerEvent } from "../model.js";

type TranscriptFile = Readonly<{
  path: string;
  sessionId: string;
  size: number;
  modifiedAtMs: number;
  changedAtMs: number;
  inode: number;
}>;

type CachedTranscript = Readonly<{
  observedSize: number;
  modifiedAtMs: number;
  changedAtMs: number;
  inode: number;
  events: MemoryViewerEvent[];
  projectionTruncated?: boolean;
}>;

type TranscriptParserState = Readonly<{
  activeTurnId: string;
  activeSessionId: string;
  activeProject?: MemoryProjectIdentity;
  activeTurnLineage?: TranscriptTurnLineage;
}>;

type TranscriptTurnLineage = Readonly<{
  turnId: string;
  sessionId: string;
  project?: MemoryProjectIdentity;
}>;

type TranscriptProjection = {
  identity: typeof resolveMemoryProject;
  files: Map<string, CachedTranscript>;
  values: MemoryViewerEvent[];
  refresh?: Promise<MemoryViewerEvent[]>;
};

const projections = new Map<string, TranscriptProjection>();
const EMPTY_TRANSCRIPT_HISTORY: readonly MemoryViewerEvent[] = Object.freeze([]);
const MAX_TRANSCRIPT_FILES = 250;
const MAX_TRANSCRIPT_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TRANSCRIPT_REFRESH_BYTES = 64 * 1024 * 1024;
const MAX_TRANSCRIPT_EVENTS_PER_FILE = 2_000;
const MAX_TRANSCRIPT_RETAINED_EVENTS = 4_000;
const MAX_TRANSCRIPT_RETAINED_BYTES = 32 * 1024 * 1024;

export function claudeLocalProjectsRoot(
  env: Record<string, string | undefined> = process.env,
): string {
  const claudeHome = env.CLAUDE_CONFIG_DIR?.trim()
    || env.CLAUDE_HOME?.trim()
    || join(homedir(), ".claude");
  return join(resolvePath(claudeHome), "projects");
}

export async function readClaudeLocalTranscriptHistory(
  projectsRoot: string | false | undefined,
  resolveProject: typeof resolveMemoryProject = resolveMemoryProject,
): Promise<readonly MemoryViewerEvent[]> {
  if (typeof projectsRoot !== "string" || !projectsRoot.trim()) {
    return EMPTY_TRANSCRIPT_HISTORY;
  }
  const normalizedRoot = resolvePath(projectsRoot.trim());
  let projection = projections.get(normalizedRoot);
  if (projection && projection.identity !== resolveProject) projection = undefined;
  if (!projection) {
    projection = { identity: resolveProject, files: new Map(), values: [] };
    projections.set(normalizedRoot, projection);
  }
  if (projection.refresh) return projection.refresh;
  const refresh = refreshProjection(projection, normalizedRoot, resolveProject);
  projection.refresh = refresh;
  try {
    return await refresh;
  } finally {
    if (projection.refresh === refresh) projection.refresh = undefined;
  }
}

export function clearClaudeLocalTranscriptProjections(): void {
  projections.clear();
}

async function refreshProjection(
  projection: TranscriptProjection,
  projectsRoot: string,
  resolveProject: typeof resolveMemoryProject,
): Promise<MemoryViewerEvent[]> {
  const files = await discoverTranscriptFiles(projectsRoot);
  const activePaths = new Set(files.map((file) => file.path));
  let changed = false;
  let allowBackfill = false;
  for (const path of projection.files.keys()) {
    if (activePaths.has(path)) continue;
    projection.files.delete(path);
    changed = true;
    allowBackfill = true;
  }

  let remainingBytes = MAX_TRANSCRIPT_REFRESH_BYTES;
  for (const file of files) {
    const cached = projection.files.get(file.path);
    const unchanged = cached
      && cached.observedSize === file.size
      && cached.modifiedAtMs === file.modifiedAtMs
      && cached.changedAtMs === file.changedAtMs
      && cached.inode === file.inode;
    if (unchanged && (!allowBackfill || cached.projectionTruncated !== true)) {
      continue;
    }
    if (remainingBytes <= 0) continue;

    const bytesToRead = Math.min(file.size, MAX_TRANSCRIPT_FILE_BYTES);
    if (bytesToRead > remainingBytes) continue;
    const rangeStart = Math.max(0, file.size - bytesToRead);

    let buffer: Buffer;
    try {
      buffer = await readFileRange(file.path, rangeStart, file.size);
    } catch {
      if (cached) {
        projection.files.delete(file.path);
        changed = true;
        allowBackfill = true;
      }
      continue;
    }
    remainingBytes -= buffer.byteLength;
    const parsed = projectTranscriptChunk(
      buffer,
      resolveProject,
      initialParserState(file.sessionId),
      rangeStart > 0,
    );
    const events = parsed.events.slice(-MAX_TRANSCRIPT_EVENTS_PER_FILE);
    projection.files.set(file.path, {
      observedSize: file.size,
      modifiedAtMs: file.modifiedAtMs,
      changedAtMs: file.changedAtMs,
      inode: file.inode,
      events,
      projectionTruncated: false,
    });
    if (!sameTranscriptEvents(events, cached?.events)) {
      changed = true;
      allowBackfill = true;
    }
  }

  if (changed) {
    projection.values = retainTranscriptProjectionEvents(projection);
  }
  return projection.values;
}

function retainTranscriptProjectionEvents(
  projection: TranscriptProjection,
): MemoryViewerEvent[] {
  const candidates = [...projection.files.values()]
    .flatMap((file) => file.events)
    .sort(compareEvents);
  const retained: MemoryViewerEvent[] = [];
  let retainedBytes = 0;
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const event = candidates[index];
    if (!event || retained.length >= MAX_TRANSCRIPT_RETAINED_EVENTS) break;
    const eventBytes = transcriptEventRetainedBytes(event);
    if (retainedBytes + eventBytes > MAX_TRANSCRIPT_RETAINED_BYTES) break;
    retained.push(event);
    retainedBytes += eventBytes;
  }
  const retainedEvents = new Set(retained);
  for (const [path, cached] of projection.files) {
    const events = cached.events.filter((event) => retainedEvents.has(event));
    const projectionTruncated = events.length !== cached.events.length;
    if (projectionTruncated || cached.projectionTruncated === true) {
      projection.files.set(path, { ...cached, events, projectionTruncated });
    }
  }
  return retained.reverse();
}

function transcriptEventRetainedBytes(event: MemoryViewerEvent): number {
  return 256 + Buffer.byteLength([
    event.eventKey,
    event.timestamp,
    event.projectId ?? "",
    event.projectLabel ?? "",
    event.content,
  ].join("\u0000"));
}

function sameTranscriptEvents(
  current: readonly MemoryViewerEvent[],
  cached: readonly MemoryViewerEvent[] | undefined,
): boolean {
  return cached !== undefined
    && current.length === cached.length
    && current.every((event, index) => {
      const previous = cached[index];
      return previous !== undefined
        && event.eventKey === previous.eventKey
        && event.timestamp === previous.timestamp
        && event.projectId === previous.projectId
        && event.projectLabel === previous.projectLabel
        && event.content === previous.content
        && event.ok === previous.ok
        && event.turnOutcome === previous.turnOutcome;
    });
}

async function discoverTranscriptFiles(projectsRoot: string): Promise<TranscriptFile[]> {
  let projectDirectories;
  try {
    projectDirectories = await readdir(projectsRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const candidates: Array<{ path: string; sessionId: string }> = [];
  for (const directory of projectDirectories) {
    if (!directory.isDirectory()) continue;
    const directoryPath = join(projectsRoot, directory.name);
    let entries;
    try {
      entries = await readdir(directoryPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const sessionId = safeIdentifier(basename(entry.name, ".jsonl"));
      if (sessionId) candidates.push({ path: join(directoryPath, entry.name), sessionId });
    }
  }

  const files: TranscriptFile[] = [];
  for (const candidate of candidates) {
    try {
      const metadata = await stat(candidate.path);
      if (!metadata.isFile()) continue;
      files.push({
        ...candidate,
        size: metadata.size,
        modifiedAtMs: metadata.mtimeMs,
        changedAtMs: metadata.ctimeMs,
        inode: metadata.ino,
      });
    } catch {
      // A live Claude session may rotate a file between directory listing and stat.
    }
  }
  return files
    .sort((left, right) => right.modifiedAtMs - left.modifiedAtMs || left.path.localeCompare(right.path))
    .slice(0, MAX_TRANSCRIPT_FILES);
}

function projectTranscriptChunk(
  buffer: Buffer,
  resolveProject: typeof resolveMemoryProject,
  initialState: TranscriptParserState,
  skipLeadingPartial: boolean,
): { consumedByteLength: number; events: MemoryViewerEvent[]; state: TranscriptParserState } {
  const events: MemoryViewerEvent[] = [];
  const recordTurns = new Map<string, TranscriptTurnLineage>();
  const recordParents = new Map<string, string>();
  const terminalRecords = new Map<string, string>();
  const ambiguousTurns = new Set<string>();
  const partialAnswers = new Map<string, string>();
  let state = initialState;
  let lineStart = 0;
  if (skipLeadingPartial) {
    const newline = buffer.indexOf(0x0a);
    if (newline < 0) return { consumedByteLength: buffer.byteLength, events, state };
    lineStart = newline + 1;
  }
  const completeChunkStart = lineStart;

  let consumedByteLength = lineStart;
  while (lineStart < buffer.byteLength) {
    const newline = buffer.indexOf(0x0a, lineStart);
    if (newline < 0) break;
    const lineEnd = newline > lineStart && buffer[newline - 1] === 0x0d ? newline - 1 : newline;
    const raw = parseRecord(buffer.subarray(lineStart, lineEnd).toString("utf8"));
    consumedByteLength = newline + 1;
    lineStart = newline + 1;
    if (!raw) continue;

    const type = stringValue(raw.type);
    const message = record(raw.message);
    const recordId = safeIdentifier(raw.uuid);
    const messageId = safeIdentifier(message?.id);
    const parentId = safeIdentifier(raw.parentUuid ?? raw.parent_uuid);
    if (parentId) {
      if (recordId) recordParents.set(recordId, parentId);
      if (messageId) recordParents.set(messageId, parentId);
    }
    const inheritedLineage = parentId ? recordTurns.get(parentId) : undefined;
    const declaredSessionId = stringValue(raw.sessionId);
    const sessionId = declaredSessionId
      ? safeIdentifier(declaredSessionId)
      : state.activeSessionId;
    const cwd = stringValue(raw.cwd);
    const project = cwd ? resolveProject(cwd) : state.activeProject;
    const compatibleInheritedLineage = inheritedLineage
      && transcriptLineageMatchesRecord(
        inheritedLineage,
        declaredSessionId,
        sessionId,
        cwd,
        project,
      )
      ? inheritedLineage
      : undefined;
    if (isHiddenRecord(raw)) {
      if (raw.isSidechain !== true && compatibleInheritedLineage) {
        if (recordId) recordTurns.set(recordId, compatibleInheritedLineage);
        if (messageId) recordTurns.set(messageId, compatibleInheritedLineage);
      }
      continue;
    }
    if (type !== "user" && type !== "assistant") continue;
    const timestamp = safeTimestamp(raw.timestamp);
    if (!sessionId || !timestamp) continue;
    state = {
      ...state,
      activeSessionId: sessionId,
      ...(project ? { activeProject: project } : {}),
    };

    if (type === "user") {
      const interruptedMessageId = safeIdentifier(
        raw.interruptedMessageId ?? raw.interrupted_message_id,
      );
      if (interruptedMessageId) {
        const interruptedCandidate = recordTurns.get(interruptedMessageId) ?? inheritedLineage;
        const interruptedLineage = interruptedCandidate
          && transcriptLineageMatchesRecord(
            interruptedCandidate,
            declaredSessionId,
            sessionId,
            cwd,
            project,
          )
          ? interruptedCandidate
          : undefined;
        if (!interruptedLineage) continue;
        if (recordId) recordTurns.set(recordId, interruptedLineage);
        if (messageId) recordTurns.set(messageId, interruptedLineage);
        const interruptedTurnId = interruptedLineage.turnId;
        if (ambiguousTurns.has(interruptedTurnId)) continue;
        const terminalRecord = terminalRecords.get(interruptedTurnId);
        if (terminalRecord) {
          ambiguousTurns.add(interruptedTurnId);
          removeTurnEndEvent(events, interruptedLineage.sessionId, interruptedTurnId);
          continue;
        }
        terminalRecords.set(interruptedTurnId, recordId || interruptedMessageId);
        events.push(turnEndEvent({
          sessionId: interruptedLineage.sessionId,
          turnId: interruptedTurnId,
          timestamp,
          answer: partialAnswers.get(interruptedTurnId) ?? "",
          interrupted: true,
          error: "Claude Code turn was interrupted.",
          project: interruptedLineage.project,
        }));
        if (state.activeTurnId === interruptedTurnId
          && state.activeSessionId === interruptedLineage.sessionId) {
          state = { ...state, activeTurnId: "", activeTurnLineage: undefined };
        }
        continue;
      }
      if (!isInteractiveUserRecord(raw, message) || hasOnlyToolResults(message?.content)) {
        if (recordId && compatibleInheritedLineage) recordTurns.set(recordId, compatibleInheritedLineage);
        if (messageId && compatibleInheritedLineage) recordTurns.set(messageId, compatibleInheritedLineage);
        continue;
      }
      const prompt = visibleText(message?.content);
      const turnId = safeIdentifier(raw.promptId ?? raw.prompt_id)
        || safeIdentifier(raw.uuid);
      if (!prompt || !turnId) continue;
      const lineage: TranscriptTurnLineage = {
        turnId,
        sessionId,
        ...(project ? { project } : {}),
      };
      state = { ...state, activeTurnId: turnId, activeTurnLineage: lineage };
      if (recordId) recordTurns.set(recordId, lineage);
      if (messageId) recordTurns.set(messageId, lineage);
      events.push(turnStartEvent({ sessionId, turnId, timestamp, prompt, project }));
      continue;
    }

    const assistantLineage = parentId
      ? compatibleInheritedLineage
      : state.activeTurnLineage
        && transcriptLineageMatchesRecord(
          state.activeTurnLineage,
          declaredSessionId,
          sessionId,
          cwd,
          project,
        )
        ? state.activeTurnLineage
        : undefined;
    if (!assistantLineage) continue;
    const assistantTurnId = assistantLineage.turnId;
    if (ambiguousTurns.has(assistantTurnId)) continue;
    if (recordId) recordTurns.set(recordId, assistantLineage);
    if (messageId) recordTurns.set(messageId, assistantLineage);
    const answer = visibleText(message?.content);
    if (answer) partialAnswers.set(assistantTurnId, answer);
    if (!isTerminalAssistantRecord(raw, message)) continue;
    const terminalRecord = recordId || `${parentId}\u0000${timestamp}`;
    const previousTerminalRecord = terminalRecords.get(assistantTurnId);
    if (previousTerminalRecord && previousTerminalRecord !== terminalRecord) {
      if (!recordId || !recordDescendsFrom(recordId, previousTerminalRecord, recordParents)) {
        ambiguousTurns.add(assistantTurnId);
        removeTurnEndEvent(events, assistantLineage.sessionId, assistantTurnId);
        continue;
      }
      removeTurnEndEvent(events, assistantLineage.sessionId, assistantTurnId);
    }
    if (previousTerminalRecord === terminalRecord) continue;
    terminalRecords.set(assistantTurnId, terminalRecord);
    const reachedTokenLimit = stringValue(message?.stop_reason) === "max_tokens";
    const interrupted = raw.isApiErrorMessage === true || Boolean(raw.error) || reachedTokenLimit;
    events.push(turnEndEvent({
      sessionId: assistantLineage.sessionId,
      turnId: assistantTurnId,
      timestamp,
      answer,
      interrupted,
      ...(interrupted ? {
        error: reachedTokenLimit
          ? "Claude Code response reached its token limit."
          : "Claude Code recorded an API error.",
      } : {}),
      project: assistantLineage.project,
    }));
  }
  const activityEvents = projectTranscriptMemoryActivities(
    buffer.subarray(completeChunkStart, consumedByteLength).toString("utf8"),
    initialState.activeSessionId,
    events,
    terminalRecords,
  );
  return {
    consumedByteLength,
    events: mergeTranscriptEvents([], [...events, ...activityEvents]),
    state,
  };
}

function projectTranscriptMemoryActivities(
  transcript: string,
  sessionId: string,
  lifecycleEvents: readonly MemoryViewerEvent[],
  acceptedTerminalRecords: ReadonlyMap<string, string>,
): MemoryViewerEvent[] {
  const finalizedTurnScopes = new Set(lifecycleEvents
    .filter((event) => event.type === "turn_end" && event.sessionId === sessionId && event.turnId)
    .map((event) => JSON.stringify([event.sessionId, event.turnId, event.projectId ?? null])));
  const starts = new Map(lifecycleEvents
    .filter((event) => event.type === "turn_start" && event.sessionId === sessionId && event.turnId)
    .map((event) => [event.turnId as string, event]));
  return claudeTranscriptMemoryActivitiesFromJsonLines(transcript, {
    sessionId,
    includeAuthority: true,
  })
    .flatMap((activity): MemoryViewerEvent[] => {
      const turnId = safeIdentifier(activity.promptId);
      const toolUseId = safeIdentifier(activity.toolUseId);
      const terminalRecordId = safeIdentifier(activity.terminalRecordId);
      const start = turnId ? starts.get(turnId) : undefined;
      if (!start
        || !turnId
        || !toolUseId
        || !terminalRecordId
        || acceptedTerminalRecords.get(turnId) !== terminalRecordId
        || activity.ok === undefined) {
        return [];
      }
      const turnScope = JSON.stringify([sessionId, turnId, start.projectId ?? null]);
      if (!finalizedTurnScopes.has(turnScope)) return [];
      const timestamp = safeTimestamp(activity.timestamp)
        || syntheticActivityTimestamp(start.timestamp, activity.index, activity.occurrence);
      if (!timestamp) return [];
      const identity = createHash("sha256")
        .update(JSON.stringify([
          "claude-native-memory-activity-v1",
          sessionId,
          turnId,
          toolUseId,
          activity.occurrence,
          activity.type,
        ]))
        .digest("hex")
        .slice(0, 32);
      const id = `claude-local:${sessionId}:${activity.type}:${identity}`;
      const itemCount = activity.type === "memory_cli_search"
        && activity.ok
        && Number.isSafeInteger(activity.itemCount)
        && (activity.itemCount ?? -1) >= 0
        && (activity.itemCount ?? 101) <= 100
        ? activity.itemCount
        : undefined;
      return [{
        id,
        eventKey: memoryViewerEventKey({ id, client: "claude", sessionId }),
        client: "claude",
        type: activity.type,
        timestamp,
        source: "memory_cli",
        operation: activity.type === "memory_cli_add" ? "writeback" : "query",
        ok: activity.ok,
        ...(start.projectId ? { projectId: start.projectId } : {}),
        ...(start.projectLabel ? { projectLabel: start.projectLabel } : {}),
        ...(start.project ? { project: start.project } : {}),
        sessionId,
        turnId,
        content: activity.type === "memory_cli_add"
          ? "Claude Code invoked memory add."
          : "Claude Code invoked memory search.",
        ...(itemCount === undefined ? {} : { itemCount }),
        ...(activity.ok === false ? { error: "Claude Code recorded a failed memory command." } : {}),
      }];
    });
}

function syntheticActivityTimestamp(
  turnTimestamp: string,
  index: number,
  occurrence: number,
): string {
  const parsed = Date.parse(turnTimestamp);
  return Number.isFinite(parsed)
    ? new Date(parsed + index * 100 + occurrence).toISOString()
    : "";
}

function transcriptLineageMatchesRecord(
  lineage: TranscriptTurnLineage,
  declaredSessionId: string,
  sessionId: string,
  cwd: string,
  project: MemoryProjectIdentity | undefined,
): boolean {
  if (declaredSessionId && sessionId !== lineage.sessionId) return false;
  if (!cwd) return true;
  return project?.projectId === lineage.project?.projectId;
}

function turnStartEvent(input: {
  sessionId: string;
  turnId: string;
  timestamp: string;
  prompt: string;
  project?: MemoryProjectIdentity;
}): MemoryViewerEvent {
  const id = `claude-local:${input.sessionId}:turn_start:${input.turnId}`;
  return {
    id,
    eventKey: memoryViewerEventKey({ id, client: "claude", sessionId: input.sessionId }),
    client: "claude",
    type: "turn_start",
    timestamp: input.timestamp,
    source: "unknown",
    operation: "query",
    ok: true,
    ...projectFields(input.project),
    sessionId: input.sessionId,
    turnId: input.turnId,
    content: input.prompt,
    prompt: input.prompt,
  };
}

function turnEndEvent(input: {
  sessionId: string;
  turnId: string;
  timestamp: string;
  answer: string;
  interrupted: boolean;
  error?: string;
  project?: MemoryProjectIdentity;
}): MemoryViewerEvent {
  const id = `claude-local:${input.sessionId}:turn_end:${input.turnId}`;
  return {
    id,
    eventKey: memoryViewerEventKey({ id, client: "claude", sessionId: input.sessionId }),
    client: "claude",
    type: "turn_end",
    timestamp: input.timestamp,
    source: "unknown",
    operation: "reply",
    ok: !input.interrupted,
    ...projectFields(input.project),
    sessionId: input.sessionId,
    turnId: input.turnId,
    content: input.answer,
    ...(input.answer ? { answer: input.answer } : {}),
    turnOutcome: input.interrupted ? "interrupted" : "completed",
    ...(input.error ? { error: input.error } : {}),
  };
}

function removeTurnEndEvent(
  events: MemoryViewerEvent[],
  sessionId: string,
  turnId: string,
): void {
  const index = events.findIndex((event) => (
    event.type === "turn_end"
    && event.sessionId === sessionId
    && event.turnId === turnId
  ));
  if (index >= 0) events.splice(index, 1);
}

function recordDescendsFrom(
  recordId: string,
  ancestorId: string,
  parents: ReadonlyMap<string, string>,
): boolean {
  const visited = new Set<string>();
  let current = recordId;
  while (current && !visited.has(current)) {
    if (current === ancestorId) return true;
    visited.add(current);
    current = parents.get(current) ?? "";
  }
  return false;
}

function initialParserState(sessionId: string): TranscriptParserState {
  return { activeTurnId: "", activeSessionId: sessionId };
}

function mergeTranscriptEvents(
  current: MemoryViewerEvent[],
  appended: MemoryViewerEvent[],
): MemoryViewerEvent[] {
  if (appended.length === 0) return current;
  const events = new Map(current.map((event) => [event.eventKey, event]));
  for (const event of appended) events.set(event.eventKey, event);
  return [...events.values()].sort(compareEvents).slice(-MAX_TRANSCRIPT_EVENTS_PER_FILE);
}

async function readFileRange(path: string, start: number, end: number): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(Math.max(0, end - start));
    let offset = 0;
    while (offset < buffer.byteLength) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, start + offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

function isHiddenRecord(raw: Record<string, unknown>): boolean {
  return raw.isMeta === true
    || raw.isSidechain === true
    || raw.isCompactSummary === true
    || raw.isVisibleInTranscriptOnly === true;
}

function isInteractiveUserRecord(
  raw: Record<string, unknown>,
  message: Record<string, unknown> | undefined,
): boolean {
  if (raw.userType !== "external" || message?.role !== "user") return false;
  const origin = record(raw.origin);
  return stringValue(origin?.kind).toLowerCase() !== "task-notification"
    && stringValue(raw.promptSource ?? raw.prompt_source).toLowerCase() !== "system"
    && !stringValue(raw.interruptedMessageId ?? raw.interrupted_message_id);
}

function isTerminalAssistantRecord(
  raw: Record<string, unknown>,
  message: Record<string, unknown> | undefined,
): boolean {
  if (message?.role !== "assistant") return false;
  if (raw.isApiErrorMessage === true || raw.error) return true;
  const stopReason = stringValue(message.stop_reason);
  return Boolean(stopReason && stopReason !== "tool_use");
}

function hasOnlyToolResults(value: unknown): boolean {
  return Array.isArray(value)
    && value.length > 0
    && value.every((part) => stringValue(record(part)?.type) === "tool_result");
}

function visibleText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => {
      const block = record(part);
      return stringValue(block?.type) === "text" ? stringValue(block?.text) : "";
    })
    .filter(Boolean)
    .join("\n\n");
}

function projectFields(
  identity: MemoryProjectIdentity | undefined,
): Pick<MemoryViewerEvent, "projectId" | "projectLabel" | "project"> {
  if (!identity) return {};
  return {
    projectId: identity.projectId,
    projectLabel: identity.projectLabel,
    project: identity.projectLabel,
  };
}

function safeIdentifier(value: unknown): string {
  const candidate = stringValue(value);
  if (!candidate || candidate.length > 512 || /[\u0000-\u001f\u007f\\/]/.test(candidate)) return "";
  return candidate;
}

function safeTimestamp(value: unknown): string {
  const candidate = stringValue(value);
  const parsed = Date.parse(candidate);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : "";
}

function parseRecord(line: string): Record<string, unknown> | undefined {
  if (!line.trim()) return undefined;
  try {
    return record(JSON.parse(line));
  } catch {
    return undefined;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function compareEvents(left: MemoryViewerEvent, right: MemoryViewerEvent): number {
  return Date.parse(left.timestamp) - Date.parse(right.timestamp) || left.eventKey.localeCompare(right.eventKey);
}
