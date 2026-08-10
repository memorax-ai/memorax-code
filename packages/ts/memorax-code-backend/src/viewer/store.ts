import type { MemoryObservabilityEvent } from "../memory/observability.js";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  clearClaudeLocalTranscriptProjections,
  readClaudeLocalTranscriptHistory,
} from "./history/claude-transcript.js";
import { stripCodexPreambleSegments } from "../clients/codex/effective-prompt.js";
import {
  clearIncrementalJsonlProjections,
  readIncrementalJsonlProjectionSnapshot,
  type IncrementalJsonlProjectionSnapshot,
} from "../shared/incremental-jsonl-projection.js";
import {
  clearMemoryViewerDataProjectionCache,
  clearMemoryViewerDataProjections,
  memoryViewerDataProjectionCacheSize,
  prepareMemoryViewerDataProjectionHistory,
  readMemoryViewerDataProjection,
  shareMemoryViewerDataProjectionValue,
  shouldCacheMemoryViewerDataProjection,
  writeMemoryViewerDataProjection,
} from "./projection/cache.js";
import {
  memoryViewerActivityProjection,
  memoryViewerActivitySummary,
} from "./projection/activity.js";
import { memoryViewerEventKey } from "./projection/event-identity.js";
import { memoryViewerEventTurnIds } from "./projection/turn-reference.js";
import {
  foldMemoryViewerSupersededTurnStarts,
  foldMemoryViewerTurnMaterializations,
} from "./projection/history.js";
import {
  memoryProjectFromUnknown,
  resolveMemoryProject,
  UNCLASSIFIED_PROJECT_ID,
  type MemoryProjectIdentity,
} from "../memory/project.js";
import { sanitizeMemoryViewerDetails } from "./projection/redaction.js";
import {
  earliestMemoryViewerSessionTitleCandidates,
} from "./history/session-title.js";
import { projectMemoryViewerUserData } from "./projection/user.js";
import {
  completeMemoryViewerWriteback,
  foldMemoryViewerWritebackStatuses,
  memoryText,
  memoryViewerWritebackOutcome,
  nonNegativeInteger,
  pendingMemoryViewerWritebacks,
  stringArray,
  writebackOutcomeForStatus,
} from "./projection/writeback-status.js";
import { clientTracePaths, tracePaths } from "../trace/config.js";
import type { TraceClient } from "../trace/context.js";
import type {
  MemoryViewerData,
  MemoryViewerEvent,
  MemoryViewerEventType,
  MemoryViewerProjectCatalogEntry,
  MemoryViewerProjectSessionCatalogEntry,
  MemoryViewerSessionTitleCandidate,
  MemoryViewerTurnReference,
} from "./model.js";

export {
  completeMemoryViewerWriteback,
  memoryViewerEventTurnIds,
  pendingMemoryViewerWritebacks,
};
export type {
  MemoryViewerActivitySummary,
  MemoryViewerData,
  MemoryViewerEvent,
  MemoryViewerEventType,
  MemoryViewerProjectCatalogEntry,
  MemoryViewerProjectSessionCatalogEntry,
  MemoryViewerTurnReference,
} from "./model.js";

export type MemoryViewerHistoryFilter = Readonly<{
  client?: TraceClient;
  includePendingWritebacks?: boolean;
  eventKey?: string;
  sessionId?: string;
  unscopedSession?: boolean;
  projectId?: string;
  rejectProjectFilter?: boolean;
  activeSessionSince?: number;
  includeUserProjection?: boolean;
}>;

export type MemoryViewerStoreDependencies = Readonly<{
  resolveProject?: typeof resolveMemoryProject;
  claudeProjectsRoot?: string | false;
}>;

const CAPACITY = 200;
const TURN_CAPACITY = 50;
export const MEMORY_VIEWER_UNSCOPED_SESSION_FILTER = "__unscoped__";
const events: MemoryViewerEvent[] = [];
let liveEventsVersion = 0;

type CombinedTraceHistory = Readonly<{
  codex: readonly MemoryViewerEvent[];
  claude: readonly MemoryViewerEvent[];
  claudeLocal: readonly MemoryViewerEvent[];
  values: MemoryViewerEvent[];
}>;

type MemoryViewerHistorySnapshot = IncrementalJsonlProjectionSnapshot<MemoryViewerEvent> & Readonly<{
  claudeLocal: readonly MemoryViewerEvent[];
}>;

const combinedTraceHistories = new Map<string, CombinedTraceHistory>();
const EMPTY_MEMORY_VIEWER_HISTORY: readonly MemoryViewerEvent[] = Object.freeze([]);
const claudeTranscriptSources = new Map<string, string | false>();

export function recordMemoryViewerEvent(input: MemoryObservabilityEvent): MemoryViewerEvent {
  const client = memoryViewerClient(input);
  const response = record(input.response);
  const request = record(input.request);
  const items = arrayValue(response?.items);
  const query = searchQuery(request);
  const results = searchResults(items);
  const traceSessionId = sessionId(input.traceContext?.sessionId);
  const traceTurnId = safeMemoryViewerTurnId(input.traceContext?.turnId);
  const turnReferences = client === "claude"
    ? memoryViewerTurnReferences(input.relatedTurns, input.traceContext)
    : [];
  const projectIdentity = memoryProjectFromUnknown(input.traceContext?.memoryProject)
    ?? resolveMemoryProject(input.traceContext?.cwd);
  const writeback = writebackState(input.operation, response);
  const conversation = writebackConversation(input.operation, request);
  const id = memoryViewerEventId(client, input.eventId);
  const event: MemoryViewerEvent = {
    id,
    eventKey: memoryViewerEventKey({
      id,
      client,
      ...(traceSessionId ? { sessionId: traceSessionId } : {}),
    }),
    client,
    type: memoryEventType(input.source, input.operation),
    timestamp: new Date().toISOString(),
    source: input.source,
    operation: input.operation,
    ok: input.ok,
    ...viewerProjectFields(projectIdentity),
    ...(traceSessionId ? { sessionId: traceSessionId } : {}),
    ...(traceTurnId ? { turnId: traceTurnId } : {}),
    ...(turnReferences.length > 0 ? { turnReferences } : {}),
    content: eventContent(input.operation, request, response, items, input.error),
    ...(conversation.prompt ? { prompt: conversation.prompt } : {}),
    ...(conversation.answer ? { answer: conversation.answer } : {}),
    ...(query ? { query } : {}),
    ...(results.length > 0 ? { results } : {}),
    ...(items.length > 0 ? { itemCount: items.length } : {}),
    ...(stringValue(response?.receiptId) ? { receiptId: stringValue(response?.receiptId) } : {}),
    ...(writeback.taskId ? { taskId: writeback.taskId } : {}),
    ...(writeback.status ? { writebackStatus: writeback.status } : {}),
    ...(writeback.status ? { writebackOutcome: writebackOutcomeForStatus(writeback.status) } : {}),
    ...(input.error ? { error: input.error.slice(0, 2000) } : {}),
    details: sanitizeMemoryViewerDetails({ request: input.request, response: input.response }),
  };
  events.push(event);
  while (events.length > CAPACITY) events.shift();
  liveEventsVersion += 1;
  clearMemoryViewerDataProjections();
  return event;
}

export function listMemoryViewerEvents(): MemoryViewerEvent[] {
  return events.map((event) => structuredClone(event));
}

export async function listMemoryViewerEventsWithHistory(memoraxCodeHome: string): Promise<MemoryViewerEvent[]> {
  return (await listMemoryViewerDataWithHistory(memoraxCodeHome)).events;
}

export async function listMemoryViewerDataWithHistory(
  memoraxCodeHome: string,
  filter: MemoryViewerHistoryFilter = {},
  dependencies: MemoryViewerStoreDependencies = {},
): Promise<MemoryViewerData> {
  const claudeProjectsRoot = claudeTranscriptRoot(dependencies.claudeProjectsRoot);
  observeClaudeTranscriptSource(memoraxCodeHome, claudeProjectsRoot);
  const historicalSnapshot = await readTraceHistory(
    memoraxCodeHome,
    dependencies.resolveProject ?? resolveMemoryProject,
    filter.client,
    claudeProjectsRoot,
  );
  const historical = historicalSnapshot.values;
  const projectionKey = memoryViewerProjectionKey(memoraxCodeHome, filter.client);
  prepareMemoryViewerDataProjectionHistory(projectionKey, historical);
  const filterKey = memoryViewerHistoryFilterKey(filter);
  const cached = readMemoryViewerDataProjection<MemoryViewerData>(
    projectionKey,
    filterKey,
    historical,
    liveEventsVersion,
  );
  if (cached) return structuredClone(cached);
  const merged = new Map<string, MemoryViewerEvent>();
  const liveEvents = filter.client
    ? events.filter((event) => event.client === filter.client)
    : events;
  for (const event of [...historical, ...liveEvents]) merged.set(event.eventKey, event);
  const traceEvents = [...merged.values()];
  const claudeTranscriptAdmission = admitClaudeTranscriptEvents(
    traceEvents,
    historicalSnapshot.claudeLocal,
  );
  const associatedEvents = associateClaudeEventsWithTranscriptTurns(
    coalesceClaudeTranscriptTurns(traceEvents, claudeTranscriptAdmission.events),
    historicalSnapshot.claudeLocal,
    claudeTranscriptAdmission.turnScopes,
  );
  const coalescedEvents = coalesceClaudeTranscriptActivities(associatedEvents);
  const allEvents = foldMemoryViewerSupersededTurnStarts(
    foldMemoryViewerTurnMaterializations(
      foldMemoryViewerWritebackStatuses(coalescedEvents.sort(compareMemoryViewerEvents)),
    ),
  );
  const selectionCatalogEvents = allEvents.filter(memoryViewerEventVisible);
  const catalogEvents = selectionCatalogEvents;
  const catalogWindow = catalogEvents.slice(-CAPACITY);
  const projects = projectCatalog(catalogWindow);
  const projectSessions = projectSessionCatalog(catalogWindow);
  const hasUnclassified = catalogWindow.some((event) => !event.projectId);
  const selectableEvents = filter.includePendingWritebacks
    ? allEvents.filter((event) => memoryViewerEventVisible(event)
      || (event.operation === "writeback" && event.writebackOutcome === "pending"))
    : catalogEvents;
  const activitySelectionProjects = filter.includePendingWritebacks
    ? projectCatalog(selectableEvents)
    : projectCatalog(selectionCatalogEvents);
  const activitySelectionHasUnclassified = filter.includePendingWritebacks
    ? selectableEvents.some((event) => !event.projectId)
    : selectionCatalogEvents.some((event) => !event.projectId);
  const activityProjects = activitySelectionProjects;
  const activityProjection = memoryViewerActivityProjection(selectableEvents);
  const activityProjectSessions = activityProjection.projectSessions;
  const selection = resolveProjectSelection(
    activitySelectionProjects,
    activitySelectionHasUnclassified,
    filter.projectId,
    filter.rejectProjectFilter === true,
  );
  const activeSessionSince = filter.activeSessionSince;
  const scopedEvents = (selection.blockAll ? [] : selectableEvents)
    .filter((event) => !filter.eventKey || event.eventKey === filter.eventKey)
    .filter((event) => !filter.unscopedSession && !filter.sessionId
      ? true
      : filter.unscopedSession
        ? !event.sessionId
        : event.sessionId === filter.sessionId)
    .filter((event) => !selection.projectId
      ? true
      : selection.projectId === UNCLASSIFIED_PROJECT_ID
        ? !event.projectId
        : event.projectId === selection.projectId);
  const explicitSession = Boolean(filter.sessionId || filter.unscopedSession);
  const explicitSessionHasRecentActivity = activeSessionSince !== undefined
    && explicitSession
    && scopedEvents.some((event) => (
      (activityProjection.eventActivityOrder.get(event.eventKey) ?? Number.NEGATIVE_INFINITY) >= activeSessionSince
    ));
  // Active scopes contain complete Turns started inside the window plus recent standalone events.
  // Explicit stale sessions retain historical access.
  const filteredEvents = activeSessionSince === undefined || (explicitSession && !explicitSessionHasRecentActivity)
    ? scopedEvents
    : scopedEvents.filter((event) => (
      (activityProjection.eventActivityOrder.get(event.eventKey) ?? Number.NEGATIVE_INFINITY) >= activeSessionSince
    ));
  const eventWindow = filteredEvents.slice(-CAPACITY);
  const data: MemoryViewerData = {
    events: eventWindow.map((event) => structuredClone(event)),
    turnEvents: completeTurnEventWindow(filteredEvents, TURN_CAPACITY, eventWindow)
      .map((event) => structuredClone(event)),
    activitySummary: memoryViewerActivitySummary(filteredEvents),
    catalogSourceEvents: selectableEvents.slice(-CAPACITY).map((event) => structuredClone(event)),
    sessionTitleCandidates: shareMemoryViewerDataProjectionValue(
      projectionKey,
      `session-titles:${filter.includePendingWritebacks === true}`,
      historical,
      liveEventsVersion,
      () => earliestMemoryViewerSessionTitleCandidates(selectableEvents),
    ),
    projects,
    projectSessions,
    hasUnclassified,
    activityProjects,
    activityProjectSessions,
    ...(filter.includeUserProjection
      ? { userProjection: projectMemoryViewerUserData(filteredEvents) }
      : {}),
    ...(selection.projectId ? { selectedProjectId: selection.projectId } : {}),
    ...(selection.status ? { projectFilterStatus: selection.status } : {}),
  };
  if (shouldCacheMemoryViewerDataProjection(filter, data)) {
    writeMemoryViewerDataProjection(projectionKey, filterKey, historical, liveEventsVersion, data);
  }
  return structuredClone(data);
}

function completeTurnEventWindow(
  allEvents: MemoryViewerEvent[],
  capacity: number,
  requiredEvents: MemoryViewerEvent[] = [],
): MemoryViewerEvent[] {
  const turns = new Map<string, { startedAt: number; firstSeenAt: number }>();
  for (const event of allEvents) {
    if (!event.sessionId) continue;
    const timestamp = Date.parse(event.timestamp);
    const order = Number.isFinite(timestamp) ? timestamp : 0;
    for (const turnId of memoryViewerEventTurnIds(event)) {
      const key = `${event.client}\u0000${event.sessionId}\u0000${turnId}`;
      const current = turns.get(key);
      if (!current) {
        turns.set(key, {
          startedAt: event.type === "turn_start" ? order : Number.NEGATIVE_INFINITY,
          firstSeenAt: order,
        });
        continue;
      }
      current.firstSeenAt = Math.min(current.firstSeenAt, order);
      if (event.type === "turn_start") current.startedAt = order;
    }
  }
  const selected = new Set([...turns.entries()]
    .sort((left, right) => {
      const leftOrder = Number.isFinite(left[1].startedAt) ? left[1].startedAt : left[1].firstSeenAt;
      const rightOrder = Number.isFinite(right[1].startedAt) ? right[1].startedAt : right[1].firstSeenAt;
      return leftOrder - rightOrder || left[0].localeCompare(right[0]);
    })
    .slice(-capacity)
    .map(([key]) => key));
  for (const event of requiredEvents) {
    if (!event.sessionId) continue;
    for (const turnId of memoryViewerEventTurnIds(event)) {
      selected.add(`${event.client}\u0000${event.sessionId}\u0000${turnId}`);
    }
  }
  return allEvents.filter((event) => (
    Boolean(event.sessionId)
      && memoryViewerEventTurnIds(event).some((turnId) => (
        selected.has(`${event.client}\u0000${event.sessionId}\u0000${turnId}`)
      ))
  ));
}

export function clearMemoryViewerEvents(): void {
  events.length = 0;
  liveEventsVersion += 1;
  combinedTraceHistories.clear();
  claudeTranscriptSources.clear();
  clearClaudeLocalTranscriptProjections();
  clearIncrementalJsonlProjections();
  clearMemoryViewerDataProjectionCache();
}

function claudeTranscriptRoot(
  configuredRoot: string | false | undefined,
): string | false {
  return typeof configuredRoot === "string" && configuredRoot.trim()
    ? resolve(configuredRoot.trim())
    : false;
}

function observeClaudeTranscriptSource(
  memoraxCodeHome: string,
  source: string | false,
): void {
  const key = resolve(memoraxCodeHome);
  const previous = claudeTranscriptSources.get(key);
  claudeTranscriptSources.set(key, source);
  if (previous === undefined || previous === source) return;
  clearClaudeLocalTranscriptProjections();
  for (const cacheKey of combinedTraceHistories.keys()) {
    if (cacheKey === key || cacheKey.startsWith(`${key}\u0000`)) {
      combinedTraceHistories.delete(cacheKey);
    }
  }
  clearMemoryViewerDataProjections();
}

export function memoryViewerDataProjectionCount(memoraxCodeHome: string): number {
  return memoryViewerDataProjectionCacheSize(tracePaths(memoraxCodeHome).sessionsRoot);
}

function memoryViewerHistoryFilterKey(filter: MemoryViewerHistoryFilter): string {
  return JSON.stringify([
    filter.client ?? "",
    filter.includePendingWritebacks === true,
    filter.eventKey ?? "",
    filter.sessionId ?? "",
    filter.unscopedSession === true,
    filter.projectId ?? "",
    filter.rejectProjectFilter === true,
    filter.activeSessionSince ?? null,
    filter.includeUserProjection === true,
  ]);
}

export function memoryViewerEventVisible(event: MemoryViewerEvent): boolean {
  return isMemoryViewerEventType(event.type) && event.type !== "memory_writeback_status"
    && event.type !== "turn_materialized";
}

function eventContent(
  operation: MemoryObservabilityEvent["operation"],
  request: Record<string, unknown> | undefined,
  response: Record<string, unknown> | undefined,
  items: unknown[],
  error: string | undefined,
): string {
  if (error) return error;
  if (operation === "writeback") {
    const payload = record(request?.payload);
    const messages = arrayValue(payload?.messages);
    const contents = messages.map((message) => stringValue(record(message)?.content)).filter(Boolean);
    return contents.join("\n\n") || "Memory writeback accepted.";
  }
  const memories = items.map(memoryText).filter(Boolean);
  if (memories.length > 0) return memories.join("\n\n");
  const payload = record(request?.payload);
  return stringValue(payload?.query) || "Memory retrieval completed.";
}

async function readTraceHistory(
  memoraxCodeHome: string,
  resolveProject: typeof resolveMemoryProject,
  client?: TraceClient,
  claudeProjectsRoot: string | false = false,
): Promise<MemoryViewerHistorySnapshot> {
  const historyCacheRoot = resolve(memoraxCodeHome);
  const projectsByCwd = new Map<string, MemoryProjectIdentity | undefined>();
  const resolveProjectOnce = (cwd: string | undefined): MemoryProjectIdentity | undefined => {
    const key = cwd?.trim() ?? "";
    if (!key) return undefined;
    if (projectsByCwd.has(key)) return projectsByCwd.get(key);
    const identity = resolveProject(key);
    projectsByCwd.set(key, identity);
    return identity;
  };
  const readClient = (traceClient: TraceClient) => readIncrementalJsonlProjectionSnapshot({
    root: clientTracePaths(traceClient, memoraxCodeHome).sessionsRoot,
    filename: "events.jsonl",
    identity: resolveProject,
    project(value, sessionDir) {
      const event = traceEventToViewerEvent(value, sessionDir, resolveProjectOnce, traceClient);
      if (!event) return undefined;
      const retryKey = event.projectId ? "" : traceEventProjectInput(value);
      return { value: event, ...(retryKey ? { retryKey } : {}) };
    },
    refreshEntry(entry) {
      if (!entry.retryKey) return false;
      const identity = resolveProjectOnce(entry.retryKey);
      if (!identity) return false;
      entry.value = { ...entry.value, ...viewerProjectFields(identity) };
      entry.retryKey = undefined;
      return true;
    },
    compare: compareMemoryViewerEvents,
  });
  if (client === "codex") {
    const codex = await readClient("codex");
    return { ...codex, claudeLocal: EMPTY_MEMORY_VIEWER_HISTORY };
  }

  const claudeLocalPromise = readClaudeLocalTranscriptHistory(claudeProjectsRoot, resolveProject);
  if (client === "claude") {
    const [claude, claudeLocal] = await Promise.all([
      readClient("claude"),
      claudeLocalPromise,
    ]);
    return {
      values: combinedTraceHistory(
        `${historyCacheRoot}\u0000client=claude\u0000source=${claudeProjectsRoot || "disabled"}`,
        EMPTY_MEMORY_VIEWER_HISTORY,
        claude.values,
        claudeLocal,
      ),
      complete: claude.complete,
      claudeLocal,
    };
  }

  const [codex, claude, claudeLocal] = await Promise.all([
    readClient("codex"),
    readClient("claude"),
    claudeLocalPromise,
  ]);
  return {
    values: combinedTraceHistory(
      `${historyCacheRoot}\u0000client=all\u0000source=${claudeProjectsRoot || "disabled"}`,
      codex.values,
      claude.values,
      claudeLocal,
    ),
    complete: codex.complete && claude.complete,
    claudeLocal,
  };
}

function combinedTraceHistory(
  cacheKey: string,
  codex: readonly MemoryViewerEvent[],
  claude: readonly MemoryViewerEvent[],
  claudeLocal: readonly MemoryViewerEvent[],
): MemoryViewerEvent[] {
  const cached = combinedTraceHistories.get(cacheKey);
  if (cached?.codex === codex
    && cached.claude === claude
    && cached.claudeLocal === claudeLocal) {
    return cached.values;
  }
  // Native Claude transcripts invalidate this cached identity, but they are
  // admitted only after retained and live Hook trace events are merged.
  const values = [...codex, ...claude].sort(compareMemoryViewerEvents);
  combinedTraceHistories.set(cacheKey, { codex, claude, claudeLocal, values });
  return values;
}

function admitClaudeTranscriptEvents(
  traceEvents: readonly MemoryViewerEvent[],
  localEvents: readonly MemoryViewerEvent[],
): Readonly<{
  turnScopes: ReadonlyMap<string, string | undefined>;
  events: readonly MemoryViewerEvent[];
}> {
  const hookProjectsByTurn = new Map<string, Set<string>>();
  for (const event of traceEvents) {
    if (event.client !== "claude"
      || event.type !== "turn_start"
      || event.id.startsWith("claude-local:")
      || !event.sessionId
      || !event.turnId) {
      continue;
    }
    const key = viewerTurnKey(event.client, event.sessionId, event.turnId);
    const projects = hookProjectsByTurn.get(key) ?? new Set<string>();
    projects.add(event.projectId ?? "");
    hookProjectsByTurn.set(key, projects);
  }
  const turnScopes = new Map<string, string | undefined>();
  for (const [key, projects] of hookProjectsByTurn) {
    if (projects.size !== 1) continue;
    const projectId = projects.values().next().value;
    turnScopes.set(key, projectId || undefined);
  }
  if (turnScopes.size === 0 || localEvents.length === 0) {
    return { turnScopes, events: EMPTY_MEMORY_VIEWER_HISTORY };
  }
  return { turnScopes, events: localEvents.filter((event) => (
    claudeTranscriptEventAdmitted(event, turnScopes)
  )) };
}

function claudeTranscriptEventAdmitted(
  event: MemoryViewerEvent,
  turnScopes: ReadonlyMap<string, string | undefined>,
): boolean {
  if (event.client !== "claude" || !event.sessionId || !event.turnId) return false;
  const key = viewerTurnKey(event.client, event.sessionId, event.turnId);
  if (!turnScopes.has(key)) return false;
  const projectId = turnScopes.get(key);
  return event.projectId === projectId;
}

function coalesceClaudeTranscriptTurns(
  traceEvents: readonly MemoryViewerEvent[],
  localEvents: readonly MemoryViewerEvent[],
): MemoryViewerEvent[] {
  if (localEvents.length === 0) return traceEvents as MemoryViewerEvent[];
  const localByTurn = new Map<string, MemoryViewerEvent[]>();
  for (const event of localEvents) {
    const key = claudeTurnLifecycleKey(event);
    if (!key) continue;
    const candidates = localByTurn.get(key) ?? [];
    candidates.push(event);
    localByTurn.set(key, candidates);
  }
  const suppressed = new Set<MemoryViewerEvent>();
  const coalesced = traceEvents.map((event) => {
    const key = claudeTurnLifecycleKey(event);
    const candidates = key ? localByTurn.get(key) : undefined;
    if (!key || !candidates) return event;
    for (const candidate of candidates) suppressed.add(candidate);
    const matching = event.projectId
      ? candidates.filter((candidate) => candidate.projectId === event.projectId)
      : candidates;
    const local = matching.length === 1 ? matching[0] : undefined;
    if (!local) return event;
    const project = event.projectId ? {} : viewerProjectFields(memoryProjectFromViewerEvent(local));
    if (event.type === "turn_start") {
      const prompt = local.prompt || event.prompt;
      return {
        ...event,
        ...project,
        ...(prompt ? { prompt, content: prompt } : {}),
      };
    }
    const answer = local.answer || event.answer;
    return {
      ...event,
      ...project,
      ...(answer ? { answer, content: answer } : {}),
      ...((local.turnOutcome === "interrupted" || !event.turnOutcome) && local.turnOutcome
        ? { turnOutcome: local.turnOutcome }
        : {}),
    };
  });
  for (const event of localEvents) {
    if (!suppressed.has(event)) coalesced.push(event);
  }
  return coalesced;
}

function claudeTurnLifecycleKey(event: MemoryViewerEvent): string {
  if (event.client !== "claude"
    || !event.sessionId
    || !event.turnId
    || (event.type !== "turn_start" && event.type !== "turn_end")) {
    return "";
  }
  return `${event.sessionId}\u0000${event.turnId}\u0000${event.type}`;
}

function memoryProjectFromViewerEvent(event: MemoryViewerEvent): MemoryProjectIdentity | undefined {
  return event.projectId && event.projectLabel
    ? { projectId: event.projectId, projectLabel: event.projectLabel }
    : undefined;
}

function associateClaudeEventsWithTranscriptTurns(
  traceEvents: MemoryViewerEvent[],
  transcriptEvents: readonly MemoryViewerEvent[],
  admittedTurnScopes: ReadonlyMap<string, string | undefined>,
): MemoryViewerEvent[] {
  if (transcriptEvents.length === 0) return traceEvents;
  const startsBySession = new Map<string, MemoryViewerEvent[]>();
  const endsByTurn = new Map<string, MemoryViewerEvent>();
  for (const event of transcriptEvents) {
    if (event.client !== "claude" || !event.sessionId || !event.turnId) continue;
    if (event.type === "turn_start") {
      const starts = startsBySession.get(event.sessionId) ?? [];
      starts.push(event);
      startsBySession.set(event.sessionId, starts);
    } else if (event.type === "turn_end") {
      endsByTurn.set(viewerTurnProjectKey(
        event.client,
        event.sessionId,
        event.turnId,
        event.projectId,
      ), event);
    }
  }
  for (const starts of startsBySession.values()) starts.sort(compareMemoryViewerEvents);

  let changed = false;
  const associated = traceEvents.map((event) => {
    if (event.client !== "claude"
      || !event.sessionId
      || !event.projectId
      || (event.turnId
        && event.type !== "memory_cli_search"
        && event.type !== "memory_cli_add")) {
      return event;
    }
    const starts = startsBySession.get(event.sessionId);
    if (!starts) return event;
    const references = event.turnReferences ?? [];
    if (references.length === 0) return event;
    const resolvedReferences: MemoryViewerTurnReference[] = references.map((reference): MemoryViewerTurnReference => {
      const owner = transcriptTurnForReference(
        event,
        reference,
        starts,
        endsByTurn,
        admittedTurnScopes,
      );
      if (owner?.turnId) return { ...reference, turnId: owner.turnId };
      const { turnId: _turnId, ...unassociated } = reference;
      return unassociated;
    });
    const turnIds = [...new Set(resolvedReferences
      .map((reference) => safeMemoryViewerTurnId(reference.turnId))
      .filter(Boolean))];
    changed = true;
    const { turnId: _turnId, ...unassociated } = event;
    if (turnIds.length === 0
      || resolvedReferences.some((reference) => !safeMemoryViewerTurnId(reference.turnId))) {
      return { ...unassociated, turnReferences: resolvedReferences };
    }
    return turnIds.length === 1
      ? { ...unassociated, turnId: turnIds[0], turnReferences: resolvedReferences }
      : { ...unassociated, turnReferences: resolvedReferences };
  });
  return changed ? associated : traceEvents;
}

const CLAUDE_NATIVE_ACTIVITY_MATCH_WINDOW_MS = 10 * 60 * 1_000;

function coalesceClaudeTranscriptActivities(
  allEvents: MemoryViewerEvent[],
): MemoryViewerEvent[] {
  const nativeByTurn = new Map<string, MemoryViewerEvent[]>();
  for (const event of allEvents) {
    if (!isClaudeNativeMemoryActivity(event) || !event.sessionId) continue;
    for (const turnId of memoryViewerEventTurnIds(event)) {
      const key = claudeActivityTurnKey(event.sessionId, turnId, event.type);
      const candidates = nativeByTurn.get(key) ?? [];
      candidates.push(event);
      nativeByTurn.set(key, candidates);
    }
  }
  if (nativeByTurn.size === 0) return allEvents;
  for (const candidates of nativeByTurn.values()) candidates.sort(compareMemoryViewerEvents);

  const suppressed = new Set<MemoryViewerEvent>();
  for (const traceEvent of allEvents) {
    if (!isClaudeTraceMemoryActivity(traceEvent) || !traceEvent.sessionId) continue;
    const traceTimes = claudeTraceActivityTimes(traceEvent);
    if (traceTimes.length === 0) continue;
    const candidates = memoryViewerEventTurnIds(traceEvent)
      .flatMap((turnId) => nativeByTurn.get(claudeActivityTurnKey(
        traceEvent.sessionId as string,
        turnId,
        traceEvent.type,
      )) ?? [])
      .filter((candidate) => !suppressed.has(candidate));
    const projectCandidates = traceEvent.projectId
      ? candidates.filter((candidate) => candidate.projectId === traceEvent.projectId)
      : candidates;
    if (!traceEvent.projectId
      && new Set(projectCandidates.map((candidate) => candidate.projectId ?? "")).size > 1) {
      continue;
    }
    const ranked = projectCandidates
      .map((candidate) => ({
        candidate,
        distance: Math.min(...traceTimes.map((traceTime) => (
          Math.abs(Date.parse(candidate.timestamp) - traceTime)
        ))),
      }))
      .filter((entry) => Number.isFinite(entry.distance))
      .sort((left, right) => (
        left.distance - right.distance
          || compareMemoryViewerEvents(left.candidate, right.candidate)
      ));
    const nearest = ranked[0];
    if (!nearest
      || nearest.distance > CLAUDE_NATIVE_ACTIVITY_MATCH_WINDOW_MS) {
      continue;
    }
    suppressed.add(nearest.candidate);
  }
  return suppressed.size === 0
    ? allEvents
    : allEvents.filter((event) => !suppressed.has(event));
}

function claudeTraceActivityTimes(event: MemoryViewerEvent): number[] {
  return [event.timestamp, ...(event.turnReferences ?? []).map((reference) => reference.capturedAt)]
    .map((timestamp) => Date.parse(timestamp))
    .filter(Number.isFinite);
}

function isClaudeNativeMemoryActivity(event: MemoryViewerEvent): boolean {
  return event.client === "claude"
    && event.id.startsWith("claude-local:")
    && (event.type === "memory_cli_search" || event.type === "memory_cli_add");
}

function isClaudeTraceMemoryActivity(event: MemoryViewerEvent): boolean {
  return event.client === "claude"
    && !event.id.startsWith("claude-local:")
    && (event.type === "memory_cli_search" || event.type === "memory_cli_add");
}

function claudeActivityTurnKey(
  sessionId: string,
  turnId: string,
  type: MemoryViewerEventType,
): string {
  return `${sessionId}\u0000${turnId}\u0000${type}`;
}

function transcriptTurnForReference(
  event: MemoryViewerEvent,
  reference: MemoryViewerTurnReference,
  starts: readonly MemoryViewerEvent[],
  endsByTurn: ReadonlyMap<string, MemoryViewerEvent>,
  admittedTurnScopes: ReadonlyMap<string, string | undefined>,
): MemoryViewerEvent | undefined {
  const capturedAt = Date.parse(reference.capturedAt);
  if (!Number.isFinite(capturedAt) || !event.sessionId || !event.projectId) return undefined;
  const explicitTurnId = safeMemoryViewerTurnId(reference.turnId);
  const candidates: MemoryViewerEvent[] = [];
  for (const [index, start] of starts.entries()) {
    if (!start.turnId || start.projectId !== event.projectId) continue;
    if (!claudeTranscriptEventAdmitted(start, admittedTurnScopes)) continue;
    if (explicitTurnId && start.turnId !== explicitTurnId) continue;
    const startedAt = Date.parse(start.timestamp);
    if (!Number.isFinite(startedAt) || capturedAt < startedAt) continue;
    const end = endsByTurn.get(viewerTurnProjectKey(
      event.client,
      event.sessionId,
      start.turnId,
      start.projectId,
    ));
    const endedAt = end ? Date.parse(end.timestamp) : Number.NaN;
    const nextStart = starts.slice(index + 1).find((candidate) => (
      candidate.projectId === event.projectId
    ));
    const nextStartedAt = Date.parse(nextStart?.timestamp ?? "");
    if (Number.isFinite(endedAt) && capturedAt > endedAt) continue;
    if (!Number.isFinite(endedAt) && Number.isFinite(nextStartedAt) && capturedAt >= nextStartedAt) continue;
    candidates.push(start);
  }
  return candidates.length === 1 ? candidates[0] : undefined;
}

function memoryViewerTurnReferences(
  relatedTurns: unknown,
  traceContext: unknown,
): MemoryViewerTurnReference[] {
  const collect = (values: unknown[]): MemoryViewerTurnReference[] => {
    const output: MemoryViewerTurnReference[] = [];
    const seen = new Set<string>();
    for (const value of values) {
      const raw = record(value);
      const capturedAt = canonicalOptionalMemoryViewerTimestamp(
        raw?.captured_at ?? raw?.capturedAt,
      );
      if (!capturedAt) continue;
      const turnId = safeMemoryViewerTurnId(raw?.turn_id ?? raw?.turnId);
      const key = `${turnId}\u0000${capturedAt}`;
      if (seen.has(key)) continue;
      seen.add(key);
      output.push({ ...(turnId ? { turnId } : {}), capturedAt });
    }
    return output;
  };
  const related = collect(arrayValue(relatedTurns));
  return related.length > 0 ? related : collect(traceContext ? [traceContext] : []);
}

function viewerTurnKey(client: TraceClient, sessionId: string, turnId: string): string {
  return `${client}\u0000${sessionId}\u0000${turnId}`;
}

function viewerTurnProjectKey(
  client: TraceClient,
  sessionId: string,
  turnId: string,
  projectId: string | undefined,
): string {
  return `${viewerTurnKey(client, sessionId, turnId)}\u0000${projectId ?? ""}`;
}
function traceEventProjectInput(value: unknown): string {
  const raw = record(value);
  const trace = record(raw?.trace);
  if (memoryProjectFromUnknown(trace?.memory_project) || memoryProjectFromUnknown(trace?.memoryProject)) return "";
  return stringValue(trace?.cwd) || stringValue(record(raw?.request)?.cwd);
}

function compareMemoryViewerEvents(left: MemoryViewerEvent, right: MemoryViewerEvent): number {
  const leftTime = Date.parse(left.timestamp);
  const rightTime = Date.parse(right.timestamp);
  const leftOrder = Number.isFinite(leftTime) ? leftTime : 0;
  const rightOrder = Number.isFinite(rightTime) ? rightTime : 0;
  return leftOrder - rightOrder || left.eventKey.localeCompare(right.eventKey);
}

function traceEventToViewerEvent(
  value: unknown,
  sessionDir: string,
  resolveProject: typeof resolveMemoryProject,
  client: TraceClient,
): MemoryViewerEvent | undefined {
  const raw = record(value);
  const type = memoryViewerEventType(raw?.type);
  if (!raw || !type) return undefined;
  const operation = type === "turn_start"
    ? "query"
    : type === "turn_end" || type === "turn_materialized"
      ? "reply"
      : raw.operation === "writeback"
    ? "writeback"
    : raw.operation === "query"
      ? "query"
      : raw.operation === "retrieve"
        ? "retrieve"
        : undefined;
  if (!operation) return undefined;
  const source = typeof raw.source === "string" ? raw.source as MemoryObservabilityEvent["source"] : "unknown";
  const request = record(raw.request);
  const response = record(raw.response);
  const items = arrayValue(response?.items);
  const query = searchQuery(request);
  const results = searchResults(items);
  const timestamp = canonicalMemoryViewerTimestamp(raw.timestamp);
  const error = stringValue(raw.error);
  const trace = record(raw.trace);
  const turnId = safeMemoryViewerTurnId(stringValue(trace?.turn_id) || stringValue(trace?.turnId));
  const turnReferences = client === "claude"
    ? memoryViewerTurnReferences(raw.related_turns ?? raw.relatedTurns, trace)
    : [];
  const persistedProjectIdentity = memoryProjectFromUnknown(trace?.memory_project)
    ?? memoryProjectFromUnknown(trace?.memoryProject);
  const projectCwd = stringValue(trace?.cwd) || stringValue(request?.cwd);
  // Resolving the persisted cwd rebuilds the process-local project-root index on
  // cold start and verifies any persisted identity before readiness uses it.
  const resolvedProjectIdentity = resolveProject(projectCwd);
  const projectIdentity = resolvedProjectIdentity ?? persistedProjectIdentity;
  const rawTraceSessionId = stringValue(trace?.session_id) || stringValue(trace?.sessionId);
  const traceSessionId = rawTraceSessionId ? sessionId(rawTraceSessionId) : sessionId(sessionDir);
  const writeback = writebackState(operation === "reply" ? "query" : operation, response);
  const persistedOutcome = memoryViewerWritebackOutcome(response?.outcome);
  const savedMemoryCount = nonNegativeInteger(response?.savedMemoryCount ?? response?.saved_memory_count);
  const savedMemoryIds = stringArray(response?.savedMemoryIds ?? response?.saved_memory_ids);
  const savedMemories = stringArray(response?.savedMemories ?? response?.saved_memories);
  const turnOutcome = type === "turn_end" || type === "turn_materialized"
    ? memoryViewerTurnOutcome(raw.outcome) ?? "completed"
    : undefined;
  const writebackMessages = operation === "writeback"
    ? writebackConversation(operation, request)
    : { prompt: "", answer: "" };
  const rawPrompt = stringValue(request?.prompt)
    || stringValue(request?.userPrompt)
    || stringValue(request?.user_prompt);
  const prompt = type === "turn_start" || type === "turn_materialized"
    ? (client === "codex" ? stripCodexPreambleSegments(rawPrompt) : rawPrompt)
    : writebackMessages.prompt;
  const answer = type === "turn_end" || type === "turn_materialized"
    ? stringValue(response?.assistantMessage) || stringValue(response?.assistant_message) || stringValue(response?.answer)
    : writebackMessages.answer;
  const content = type === "turn_start"
    ? prompt || "Turn started."
    : type === "turn_end" || type === "turn_materialized"
      ? answer || (turnOutcome === "interrupted" ? "" : "Turn ended.")
      : eventContent(operation === "reply" ? "query" : operation, request, response, items, error || undefined);
  const eventId = stringValue(raw.event_id) || `${traceSessionId || "unscoped"}:${type}:${timestamp}`;
  const id = persistedMemoryViewerEventId(client, eventId);
  const originalEventId = memoryViewerOriginalEventId(
    request?.original_event_id ?? request?.originalEventId,
    client,
  );
  return {
    id,
    eventKey: memoryViewerEventKey({
      id,
      client,
      ...(traceSessionId ? { sessionId: traceSessionId } : {}),
    }),
    client,
    type,
    timestamp,
    source,
    operation,
    ok: raw.ok !== false,
    ...viewerProjectFields(projectIdentity),
    ...(traceSessionId ? { sessionId: traceSessionId } : {}),
    ...(turnId ? { turnId } : {}),
    ...(turnReferences.length > 0 ? { turnReferences } : {}),
    content,
    ...(turnOutcome ? { turnOutcome } : {}),
    ...(prompt ? { prompt } : {}),
    ...(answer ? { answer } : {}),
    ...(query ? { query } : {}),
    ...(results.length > 0 ? { results } : {}),
    ...(items.length > 0 ? { itemCount: items.length } : {}),
    ...(stringValue(response?.receiptId) ? { receiptId: stringValue(response?.receiptId) } : {}),
    ...(writeback.taskId ? { taskId: writeback.taskId } : {}),
    ...(originalEventId ? { originalEventId } : {}),
    ...(writeback.status ? { writebackStatus: writeback.status } : {}),
    ...(persistedOutcome
      ? { writebackOutcome: persistedOutcome }
      : writeback.status ? { writebackOutcome: writebackOutcomeForStatus(writeback.status) } : {}),
    ...(savedMemoryCount === undefined ? {} : { savedMemoryCount }),
    ...(savedMemoryIds.length > 0 ? { savedMemoryIds } : {}),
    ...(savedMemories.length > 0 ? { savedMemories } : {}),
    ...(error ? { error: error.slice(0, 2000) } : {}),
    details: sanitizeMemoryViewerDetails({ request: raw.request, response: raw.response }),
  };
}

function memoryViewerTurnOutcome(value: unknown): "completed" | "interrupted" | undefined {
  return value === "completed" || value === "interrupted" ? value : undefined;
}

function memoryViewerOriginalEventId(value: unknown, client: TraceClient): string {
  const eventId = stringValue(value);
  if (!eventId) return "";
  return persistedMemoryViewerEventId(client, eventId);
}

function viewerProjectFields(identity: MemoryProjectIdentity | undefined): Pick<MemoryViewerEvent, "projectId" | "projectLabel" | "project"> {
  if (!identity) return {};
  return {
    projectId: identity.projectId,
    projectLabel: identity.projectLabel,
    project: identity.projectLabel,
  };
}

function projectCatalog(allEvents: MemoryViewerEvent[]): MemoryViewerProjectCatalogEntry[] {
  const projects = new Map<string, MemoryViewerProjectCatalogEntry>();
  for (const event of allEvents) {
    if (!event.projectId || !event.projectLabel) continue;
    const current = projects.get(event.projectId);
    projects.set(event.projectId, {
      projectId: event.projectId,
      projectLabel: event.projectLabel,
      eventCount: (current?.eventCount ?? 0) + 1,
      lastSeenAt: !current || Date.parse(event.timestamp) >= Date.parse(current.lastSeenAt)
        ? event.timestamp
        : current.lastSeenAt,
    });
  }
  return [...projects.values()].sort((left, right) => (
    left.projectLabel.localeCompare(right.projectLabel) || left.projectId.localeCompare(right.projectId)
  ));
}

function projectSessionCatalog(allEvents: MemoryViewerEvent[]): MemoryViewerProjectSessionCatalogEntry[] {
  const entries = new Map<string, MemoryViewerProjectSessionCatalogEntry>();
  for (const event of allEvents) {
    const projectId = event.projectId ?? UNCLASSIFIED_PROJECT_ID;
    const key = `${event.client}\u0000${projectId}\u0000${event.sessionId ?? ""}`;
    const current = entries.get(key);
    entries.set(key, {
      client: event.client,
      projectId,
      ...(event.sessionId ? { sessionId: event.sessionId } : { unscoped: true }),
      eventCount: (current?.eventCount ?? 0) + 1,
      lastSeenAt: !current || Date.parse(event.timestamp) >= Date.parse(current.lastSeenAt)
        ? event.timestamp
        : current.lastSeenAt,
    });
  }
  return [...entries.values()].sort((left, right) => (
    left.projectId.localeCompare(right.projectId)
      || left.client.localeCompare(right.client)
      || Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt)
      || (left.sessionId ?? "").localeCompare(right.sessionId ?? "")
  ));
}

function resolveProjectSelection(
  projects: MemoryViewerProjectCatalogEntry[],
  hasUnclassified: boolean,
  projectId: string | undefined,
  rejectProjectFilter: boolean,
): {
  projectId?: string;
  status?: "resolved" | "invalid" | "missing";
  blockAll?: boolean;
} {
  if (rejectProjectFilter) return { status: "invalid", blockAll: true };
  if (projectId) {
    const exists = projectId === UNCLASSIFIED_PROJECT_ID
      ? hasUnclassified
      : projects.some((project) => project.projectId === projectId);
    return { projectId, status: exists ? "resolved" : "missing", blockAll: !exists };
  }
  return {};
}

function memoryViewerEventType(value: unknown): MemoryViewerEventType | undefined {
  return isMemoryViewerEventType(value) ? value : undefined;
}

function isMemoryViewerEventType(value: unknown): value is MemoryViewerEventType {
  return value === "turn_start"
    || value === "turn_materialized"
    || value === "memory_retrieve"
    || value === "memory_cli_search"
    || value === "memory_cli_add"
    || value === "memory_writeback"
    || value === "memory_writeback_status"
    || value === "turn_end";
}

function memoryEventType(
  source: MemoryObservabilityEvent["source"],
  operation: MemoryObservabilityEvent["operation"],
): MemoryViewerEventType {
  if (source === "memory_cli") return operation === "writeback" ? "memory_cli_add" : "memory_cli_search";
  return operation === "writeback" ? "memory_writeback" : "memory_retrieve";
}

function searchQuery(request: Record<string, unknown> | undefined): string {
  return stringValue(record(request?.payload)?.query) || stringValue(request?.query);
}

function searchResults(items: unknown[]): Array<{ content: string; score?: number; confidence?: number }> {
  return items
    .map((item) => {
      const value = record(item);
      const content = memoryText(item);
      if (!value || !content) return undefined;
      const score = typeof value.score === "number" && Number.isFinite(value.score) ? value.score : undefined;
      const scoreDetails = record(value.score_details);
      const semanticSimilarity = scoreDetails?.semantic_similarity ?? value.semantic_similarity;
      const confidence = typeof semanticSimilarity === "number"
        && Number.isFinite(semanticSimilarity)
        && semanticSimilarity >= 0
        && semanticSimilarity <= 1
        ? semanticSimilarity
        : undefined;
      return {
        content,
        ...(score === undefined ? {} : { score }),
        ...(confidence === undefined ? {} : { confidence }),
      };
    })
    .filter((item): item is { content: string; score?: number; confidence?: number } => Boolean(item));
}

function writebackConversation(
  operation: MemoryObservabilityEvent["operation"],
  request: Record<string, unknown> | undefined,
): { prompt: string; answer: string } {
  if (operation !== "writeback") return { prompt: "", answer: "" };
  const messages = arrayValue(record(request?.payload)?.messages);
  const contentsForRole = (role: "user" | "assistant") => messages
    .map(record)
    .filter((message) => stringValue(message?.role).toLowerCase() === role)
    .map((message) => stringValue(message?.content))
    .filter(Boolean)
    .join("\n\n");
  return {
    prompt: contentsForRole("user"),
    answer: contentsForRole("assistant"),
  };
}

function writebackState(
  operation: MemoryObservabilityEvent["operation"],
  response: Record<string, unknown> | undefined,
): { taskId: string; status: string } {
  if (operation !== "writeback") return { taskId: "", status: "" };
  const raw = record(response?.raw) ?? response;
  const data = record(raw?.data);
  return {
    taskId: stringValue(data?.task_id) || stringValue(response?.taskId),
    status: (
      stringValue(data?.status)
      || stringValue(response?.status)
      || stringValue(response?.addStatus)
    ).toLowerCase(),
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function canonicalMemoryViewerTimestamp(value: unknown): string {
  if (value === undefined || value === null || value === "") return new Date().toISOString();
  return canonicalOptionalMemoryViewerTimestamp(value) ?? new Date(0).toISOString();
}

function canonicalOptionalMemoryViewerTimestamp(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 512) return "";
  const parsed = Date.parse(value.trim());
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : "";
}

export function safeMemoryViewerSessionId(value: unknown): string {
  const candidate = typeof value === "string" ? value.trim() : "";
  if (candidate.length > 512) return "";
  // This value is reserved by the viewer protocol to select events without a session.
  if (!candidate || candidate === MEMORY_VIEWER_UNSCOPED_SESSION_FILTER) return "";
  if (/[\u0000-\u001f\u007f]/.test(candidate)) return "";
  if (/[\\/]/.test(candidate)) return "";
  return candidate;
}

export function safeMemoryViewerTurnId(value: unknown): string {
  const candidate = typeof value === "string" ? value.trim() : "";
  if (!candidate || candidate.length > 512) return "";
  if (/[\u0000-\u001f\u007f\\/]/.test(candidate)) return "";
  return candidate;
}

function sessionId(value: unknown): string {
  return safeMemoryViewerSessionId(value);
}

function memoryViewerClient(input: MemoryObservabilityEvent): TraceClient {
  if (input.traceContext?.client === "claude") return "claude";
  if (input.traceContext?.client === "codex") return "codex";
  if (input.source === "claude_hook_retrieval" || input.source === "claude_hook_writeback") return "claude";
  return "codex";
}

function memoryViewerEventId(client: TraceClient, eventId: string | undefined): string {
  if (eventId) return persistedMemoryViewerEventId(client, eventId);
  return client === "codex"
    ? `memory-viewer:${randomUUID()}`
    : `claude-memory-viewer:${randomUUID()}`;
}

function persistedMemoryViewerEventId(client: TraceClient, eventId: string): string {
  return client === "codex" ? `trace:${eventId}` : `claude-trace:${eventId}`;
}

function memoryViewerProjectionKey(memoraxCodeHome: string, client: TraceClient | undefined): string {
  if (client === "claude") return clientTracePaths("claude", memoraxCodeHome).sessionsRoot;
  const codexSessionsRoot = tracePaths(memoraxCodeHome).sessionsRoot;
  return client === "codex" ? `${codexSessionsRoot}\u0000client=codex` : codexSessionsRoot;
}
