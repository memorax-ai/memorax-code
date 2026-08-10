import { randomUUID } from "node:crypto";
import {
  readIncrementalJsonlProjection,
} from "../shared/incremental-jsonl-projection.js";
import type {
  MemoryObservabilityEvent,
  MemoryObservabilityHook,
} from "./observability.js";
import {
  memoryProjectFromUnknown,
  resolveMemoryProject,
  type MemoryProjectIdentity,
} from "./project.js";
import { clientTracePaths } from "../trace/config.js";
import {
  isTraceClient,
  type TraceClient,
} from "../trace/context.js";

export type MemoryWritebackTaskOutcome =
  | "pending"
  | "saved"
  | "skipped"
  | "failed"
  | "completed";

export type MemoryWritebackTaskCompletionInput = Readonly<{
  status: string;
  memory?: unknown;
  memoryKnown?: boolean;
  outcome?: unknown;
  savedMemoryCount?: unknown;
  savedMemoryIds?: unknown;
  savedMemories?: unknown;
  error?: string | null;
}>;

export type MemoryWritebackTaskCompletion = Readonly<{
  status: string;
  outcome: MemoryWritebackTaskOutcome;
  ok: boolean;
  savedMemoryCount?: number;
  savedMemoryIds?: readonly string[];
  savedMemories?: readonly string[];
  error?: string;
}>;

type MemoryWritebackTaskRecordBase = Readonly<{
  eventId: string;
  timestamp: string;
  client?: TraceClient;
  sessionId?: string;
  turnId?: string;
  memoryProject?: MemoryProjectIdentity;
}>;

export type MemoryWritebackTaskProjectionRecord =
  | (MemoryWritebackTaskRecordBase & Readonly<{
    kind: "task";
    ok: boolean;
    taskId: string;
    status: string;
  }>)
  | (MemoryWritebackTaskRecordBase & Readonly<{
    kind: "status";
    taskId?: string;
    originalEventId?: string;
    completion: MemoryWritebackTaskCompletion;
  }>);

export type MemoryWritebackTask = MemoryWritebackTaskRecordBase & Readonly<{
  accepted: boolean;
  taskId: string;
  completion: MemoryWritebackTaskCompletion;
  statusEventId?: string;
}>;

export type PendingMemoryWritebackTask = MemoryWritebackTask & Readonly<{
  client: TraceClient;
  sessionId: string;
}>;

export type MemoryWritebackTaskProjection = Readonly<{
  client: TraceClient;
  observabilityHook: MemoryObservabilityHook;
  listPending(): Promise<PendingMemoryWritebackTask[]>;
  clear(): void;
}>;

const LIVE_TASK_CAPACITY = 1_024;
const PENDING_WRITEBACK_STATUSES = new Set([
  "accepted",
  "processing",
  "queued",
  "pending",
  "unknown",
]);

export function createMemoryWritebackTaskProjection(options: {
  memoraxCodeHome: string;
  client: TraceClient;
}): MemoryWritebackTaskProjection {
  const client = options.client;
  const liveTasks = new Map<string, MemoryWritebackTaskProjectionRecord>();
  return {
    client,
    observabilityHook: {
      recordEvent(event) {
        const projected = projectLiveWritebackTask(event);
        if (!projected || projected.client !== client) return;
        liveTasks.set(memoryWritebackTaskEventKey(projected), projected);
        while (liveTasks.size > LIVE_TASK_CAPACITY) {
          const oldest = liveTasks.keys().next().value;
          if (typeof oldest !== "string") break;
          liveTasks.delete(oldest);
        }
      },
    },
    async listPending() {
      const historical = await readMemoryWritebackTaskHistory(
        options.memoraxCodeHome,
        client,
      );
      const merged = new Map<string, MemoryWritebackTaskProjectionRecord>();
      for (const record of [...historical, ...liveTasks.values()]) {
        merged.set(memoryWritebackTaskEventKey(record), record);
      }
      return pendingMemoryWritebackTasks(
        [...merged.values()].sort(compareMemoryWritebackTaskRecords),
      ).filter((task): task is PendingMemoryWritebackTask => (
        task.client === client && Boolean(task.sessionId)
      ));
    },
    clear() {
      liveTasks.clear();
    },
  };
}

export function projectMemoryWritebackTasks(
  records: readonly MemoryWritebackTaskProjectionRecord[],
): MemoryWritebackTask[] {
  const statusByOriginalEvent = new Map<string, MemoryWritebackTaskProjectionRecord & { kind: "status" }>();
  const statusByTask = new Map<string, MemoryWritebackTaskProjectionRecord & { kind: "status" }>();
  for (const record of records) {
    if (record.kind !== "status") continue;
    if (record.originalEventId) {
      statusByOriginalEvent.set(memoryWritebackTaskEventKey({
        ...record,
        eventId: record.originalEventId,
      }), record);
    }
    const key = writebackTaskKey(record);
    if (key) statusByTask.set(key, record);
  }
  return records.flatMap((record): MemoryWritebackTask[] => {
    if (record.kind !== "task") return [];
    const key = writebackTaskKey(record);
    const explicitStatus = statusByOriginalEvent.get(memoryWritebackTaskEventKey(record));
    const status = explicitStatus && (!explicitStatus.taskId || explicitStatus.taskId === record.taskId)
      ? explicitStatus
      : key
        ? statusByTask.get(key)
        : undefined;
    return [{
      eventId: record.eventId,
      timestamp: record.timestamp,
      ...(record.client ? { client: record.client } : {}),
      ...(record.sessionId ? { sessionId: record.sessionId } : {}),
      ...(record.turnId ? { turnId: record.turnId } : {}),
      ...(record.memoryProject ? { memoryProject: record.memoryProject } : {}),
      accepted: record.ok,
      taskId: record.taskId,
      completion: status?.completion ?? completeMemoryWritebackTask({
        status: record.status,
      }),
      ...(status ? { statusEventId: status.eventId } : {}),
    }];
  });
}

export function memoryWritebackTaskEventKey(
  recordValue: Pick<MemoryWritebackTaskRecordBase, "client" | "sessionId" | "eventId">,
): string {
  return JSON.stringify([
    recordValue.client ?? "",
    recordValue.sessionId ?? "",
    recordValue.eventId,
  ]);
}

export function pendingMemoryWritebackTasks(
  records: readonly MemoryWritebackTaskProjectionRecord[],
): MemoryWritebackTask[] {
  return projectMemoryWritebackTasks(records)
    .filter((task) => (
      task.accepted
      && task.completion.ok
      && task.completion.outcome === "pending"
    ));
}

export function completeMemoryWritebackTask(
  input: MemoryWritebackTaskCompletionInput,
): MemoryWritebackTaskCompletion {
  const status = input.status.trim().toLowerCase();
  const savedMemories = uniqueStrings([
    ...stringArray(input.savedMemories),
    ...memoryTexts(input.memory),
  ]);
  const savedMemoryIds = uniqueStrings([
    ...stringArray(input.savedMemoryIds),
    ...memoryAddIds(input.memory),
  ]);
  const reportedMemoryCount = nonNegativeInteger(input.savedMemoryCount)
    ?? memorySavedCount(input.memory);
  const savedMemoryCount = reportedMemoryCount
    ?? (savedMemoryIds.length > 0 ? savedMemoryIds.length : savedMemories.length);
  const outcome = memoryWritebackTaskOutcome(input.outcome)
    ?? memoryWritebackTaskOutcomeForStatus(status, {
      memoryKnown: input.memoryKnown === true,
      savedMemoryCount,
    });
  return {
    status,
    outcome,
    ok: outcome !== "failed",
    ...(savedMemoryCount > 0 ? { savedMemoryCount } : {}),
    ...(savedMemoryIds.length > 0 ? { savedMemoryIds } : {}),
    ...(savedMemories.length > 0 ? { savedMemories } : {}),
    ...(input.error ? { error: input.error.slice(0, 2_000) } : {}),
  };
}

export function memoryWritebackTaskOutcome(
  value: unknown,
): MemoryWritebackTaskOutcome | undefined {
  return value === "pending"
    || value === "saved"
    || value === "skipped"
    || value === "failed"
    || value === "completed"
    ? value
    : undefined;
}

export function memoryWritebackTaskOutcomeForStatus(
  status: string,
  result: { memoryKnown?: boolean; savedMemoryCount?: number } = {},
): MemoryWritebackTaskOutcome {
  const normalized = status.trim().toLowerCase();
  if (PENDING_WRITEBACK_STATUSES.has(normalized)) return "pending";
  if (["failed", "error", "cancelled", "canceled"].includes(normalized)) return "failed";
  if (normalized === "success" || normalized === "completed") {
    if ((result.savedMemoryCount ?? 0) > 0) return "saved";
    if (result.memoryKnown) return "skipped";
    return "completed";
  }
  return "completed";
}

export function memoryText(value: unknown): string {
  const item = record(value);
  if (!item) return "";
  for (const key of ["memory", "summary", "content", "text"]) {
    const text = stringValue(item[key]);
    if (text) return text;
  }
  return "";
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(stringValue).filter(Boolean).slice(0, 1_000)
    : [];
}

export function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

async function readMemoryWritebackTaskHistory(
  memoraxCodeHome: string,
  client: TraceClient,
): Promise<MemoryWritebackTaskProjectionRecord[]> {
  return await readIncrementalJsonlProjection({
    namespace: `memory-writeback-task:${client}`,
    root: clientTracePaths(client, memoraxCodeHome).sessionsRoot,
    filename: "events.jsonl",
    identity: client,
    project(value, sessionDir) {
      const projected = projectTraceWritebackTask(value, sessionDir, client);
      return projected ? { value: projected } : undefined;
    },
    compare: compareMemoryWritebackTaskRecords,
  });
}

function projectLiveWritebackTask(
  event: MemoryObservabilityEvent,
): MemoryWritebackTaskProjectionRecord | undefined {
  if (event.operation !== "writeback") return undefined;
  const state = writebackState(event.response);
  if (!state.taskId || !state.status) return undefined;
  const context = event.traceContext;
  return {
    kind: "task",
    eventId: event.eventId ?? `memory-observability-${randomUUID()}`,
    timestamp: new Date().toISOString(),
    ...(context?.client ? { client: context.client } : {}),
    ...(safeIdentifier(context?.sessionId) ? { sessionId: safeIdentifier(context?.sessionId) } : {}),
    ...(safeIdentifier(context?.turnId) ? { turnId: safeIdentifier(context?.turnId) } : {}),
    ...(context?.memoryProject ? { memoryProject: context.memoryProject } : {}),
    ok: event.ok,
    taskId: state.taskId,
    status: state.status,
  };
}

function projectTraceWritebackTask(
  value: unknown,
  sessionDir: string,
  expectedClient: TraceClient,
): MemoryWritebackTaskProjectionRecord | undefined {
  const raw = record(value);
  if (!raw) return undefined;
  const type = stringValue(raw.type);
  if (
    type !== "memory_writeback"
    && type !== "memory_cli_add"
    && type !== "memory_writeback_status"
  ) {
    return undefined;
  }
  const trace = record(raw.trace);
  const rawClient = stringValue(trace?.client);
  const client = isTraceClient(rawClient) ? rawClient : undefined;
  if (client !== expectedClient) return undefined;
  const sessionId = safeIdentifier(
    stringValue(trace?.session_id)
      || stringValue(trace?.sessionId)
      || sessionDir,
  );
  const turnId = safeIdentifier(stringValue(trace?.turn_id) || stringValue(trace?.turnId));
  const request = record(raw.request);
  const memoryProject = memoryProjectFromUnknown(trace?.memory_project)
    ?? memoryProjectFromUnknown(trace?.memoryProject)
    ?? resolveMemoryProject(stringValue(trace?.cwd) || stringValue(request?.cwd));
  const timestamp = validTimestamp(raw.timestamp);
  const eventId = stringValue(raw.event_id)
    || `${sessionId || "unscoped"}:${type}:${timestamp}`;
  const response = record(raw.response);
  const state = writebackState(response);
  if (type === "memory_writeback_status") {
    const taskId = stringValue(request?.task_id)
      || stringValue(request?.taskId)
      || state.taskId;
    const status = state.status;
    if (!status) return undefined;
    const originalEventId = stringValue(request?.original_event_id ?? request?.originalEventId);
    if (!originalEventId && (!taskId || !sessionId)) return undefined;
    return {
      kind: "status",
      eventId,
      timestamp,
      client,
      ...(sessionId ? { sessionId } : {}),
      ...(turnId ? { turnId } : {}),
      ...(memoryProject ? { memoryProject } : {}),
      ...(taskId ? { taskId } : {}),
      ...(originalEventId ? { originalEventId } : {}),
      completion: completeMemoryWritebackTask({
        status,
        outcome: response?.outcome,
        savedMemoryCount: response?.savedMemoryCount ?? response?.saved_memory_count,
        savedMemoryIds: response?.savedMemoryIds ?? response?.saved_memory_ids,
        savedMemories: response?.savedMemories ?? response?.saved_memories,
        error: stringValue(raw.error) || null,
      }),
    };
  }
  if (!state.taskId || !state.status) return undefined;
  return {
    kind: "task",
    eventId,
    timestamp,
    client,
    ...(sessionId ? { sessionId } : {}),
    ...(turnId ? { turnId } : {}),
    ...(memoryProject ? { memoryProject } : {}),
    ok: raw.ok !== false,
    taskId: state.taskId,
    status: state.status,
  };
}

function writebackState(value: unknown): { taskId: string; status: string } {
  const response = record(value);
  const raw = record(response?.raw) ?? response;
  const data = record(raw?.data);
  return {
    taskId: stringValue(data?.task_id)
      || stringValue(response?.taskId)
      || stringValue(response?.task_id),
    status: (
      stringValue(data?.status)
      || stringValue(response?.status)
      || stringValue(response?.addStatus)
    ).toLowerCase(),
  };
}

function writebackTaskKey(
  recordValue: Pick<MemoryWritebackTaskProjectionRecord, "client" | "sessionId" | "taskId">,
): string | undefined {
  return recordValue.sessionId && recordValue.taskId
    ? JSON.stringify([recordValue.client ?? "", recordValue.sessionId, recordValue.taskId])
    : undefined;
}

function compareMemoryWritebackTaskRecords(
  left: MemoryWritebackTaskProjectionRecord,
  right: MemoryWritebackTaskProjectionRecord,
): number {
  const leftTime = Date.parse(left.timestamp);
  const rightTime = Date.parse(right.timestamp);
  const leftOrder = Number.isFinite(leftTime) ? leftTime : 0;
  const rightOrder = Number.isFinite(rightTime) ? rightTime : 0;
  return leftOrder - rightOrder || left.eventId.localeCompare(right.eventId);
}

function validTimestamp(value: unknown): string {
  const timestamp = stringValue(value);
  return timestamp && Number.isFinite(Date.parse(timestamp))
    ? timestamp
    : new Date().toISOString();
}

function safeIdentifier(value: unknown): string {
  const candidate = stringValue(value);
  if (!candidate || candidate.length > 512) return "";
  if (/[\u0000-\u001f\u007f\\/]/.test(candidate)) return "";
  return candidate;
}

function memoryTexts(value: unknown): string[] {
  const output: string[] = [];
  const visit = (item: unknown, depth: number) => {
    if (depth > 4) return;
    if (typeof item === "string") {
      const text = item.trim();
      if (text) output.push(text);
      return;
    }
    if (Array.isArray(item)) {
      for (const entry of item) visit(entry, depth + 1);
      return;
    }
    const wrapped = record(item);
    if (!wrapped) return;
    const text = memoryText(item);
    if (text) output.push(text);
    for (const key of ["items", "memories", "facts", "samples"]) {
      visit(wrapped[key], depth + 1);
    }
  };
  visit(value, 0);
  return uniqueStrings(output);
}

function memorySavedCount(value: unknown): number | undefined {
  const wrapped = record(value);
  if (!wrapped) return undefined;
  const total = nonNegativeInteger(wrapped.total);
  if (total !== undefined) return total;
  return nonNegativeInteger(record(wrapped.operations)?.ADD);
}

function memoryAddIds(value: unknown): string[] {
  const wrapped = record(value);
  const events = Array.isArray(wrapped?.events) ? wrapped.events : [];
  return uniqueStrings(events
    .map(record)
    .filter((event) => stringValue(event?.event).toUpperCase() === "ADD")
    .map((event) => stringValue(event?.memory_id) || stringValue(event?.id))
    .filter(Boolean));
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
