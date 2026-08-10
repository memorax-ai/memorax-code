import {
  completeMemoryWritebackTask,
  memoryText,
  memoryWritebackTaskEventKey,
  memoryWritebackTaskOutcome,
  memoryWritebackTaskOutcomeForStatus,
  nonNegativeInteger,
  projectMemoryWritebackTasks,
  stringArray,
  type MemoryWritebackTaskCompletion,
  type MemoryWritebackTaskProjectionRecord,
} from "../../memory/writeback-task-projection.js";
import type { MemoryViewerEvent } from "../model.js";

export {
  memoryText,
  nonNegativeInteger,
  stringArray,
};

export function pendingMemoryViewerWritebacks(
  eventsToCheck: readonly MemoryViewerEvent[],
): MemoryViewerEvent[] {
  const tasks = new Map(projectMemoryWritebackTasks(
    eventsToCheck.flatMap(memoryViewerWritebackProjectionRecord),
  ).map((task) => [memoryWritebackTaskEventKey(task), task]));
  return eventsToCheck.filter((event) => {
    const task = tasks.get(memoryViewerWritebackEventKey(event));
    return task?.accepted === true && task.completion.outcome === "pending";
  });
}

export function completeMemoryViewerWriteback(
  event: MemoryViewerEvent,
  status: { status: string; memory?: unknown; memoryKnown?: boolean; error?: string | null },
): MemoryViewerEvent {
  return applyMemoryWritebackTaskCompletion(
    event,
    completeMemoryWritebackTask(status),
    false,
  );
}

export function foldMemoryViewerWritebackStatuses(
  allEvents: readonly MemoryViewerEvent[],
): MemoryViewerEvent[] {
  const tasks = new Map(projectMemoryWritebackTasks(
    allEvents.flatMap(memoryViewerWritebackProjectionRecord),
  ).map((task) => [memoryWritebackTaskEventKey(task), task]));
  return allEvents
    .filter((event) => event.type !== "memory_writeback_status")
    .map((event) => {
      const task = tasks.get(memoryViewerWritebackEventKey(event));
      return task?.statusEventId
        ? applyMemoryWritebackTaskCompletion(event, task.completion, true)
        : event;
    });
}

export function memoryViewerWritebackOutcome(
  value: unknown,
): MemoryViewerEvent["writebackOutcome"] | undefined {
  return memoryWritebackTaskOutcome(value);
}

export function writebackOutcomeForStatus(
  status: string,
  result: { memoryKnown?: boolean; savedMemoryCount?: number } = {},
): NonNullable<MemoryViewerEvent["writebackOutcome"]> {
  return memoryWritebackTaskOutcomeForStatus(status, result);
}

function memoryViewerWritebackProjectionRecord(
  event: MemoryViewerEvent,
): MemoryWritebackTaskProjectionRecord[] {
  if (
    (event.type === "memory_writeback" || event.type === "memory_cli_add")
    && event.taskId
    && event.writebackStatus
  ) {
    return [{
      kind: "task",
      eventId: event.id,
      timestamp: event.timestamp,
      client: event.client,
      ...(event.sessionId ? { sessionId: event.sessionId } : {}),
      ...(event.turnId ? { turnId: event.turnId } : {}),
      ok: event.ok,
      taskId: event.taskId,
      status: event.writebackStatus,
    }];
  }
  if (event.type !== "memory_writeback_status" || !event.writebackStatus) return [];
  if (!event.originalEventId && (!event.sessionId || !event.taskId)) return [];
  return [{
    kind: "status",
    eventId: event.id,
    timestamp: event.timestamp,
    client: event.client,
    ...(event.sessionId ? { sessionId: event.sessionId } : {}),
    ...(event.turnId ? { turnId: event.turnId } : {}),
    ...(event.taskId ? { taskId: event.taskId } : {}),
    ...(event.originalEventId ? { originalEventId: event.originalEventId } : {}),
    completion: completeMemoryWritebackTask({
      status: event.writebackStatus,
      outcome: event.writebackOutcome,
      savedMemoryCount: event.savedMemoryCount,
      savedMemoryIds: event.savedMemoryIds,
      savedMemories: event.savedMemories,
      error: event.error,
    }),
  }];
}

function memoryViewerWritebackEventKey(event: MemoryViewerEvent): string {
  return memoryWritebackTaskEventKey({
    eventId: event.id,
    client: event.client,
    ...(event.sessionId ? { sessionId: event.sessionId } : {}),
  });
}

function applyMemoryWritebackTaskCompletion(
  event: MemoryViewerEvent,
  completion: MemoryWritebackTaskCompletion,
  replaceError: boolean,
): MemoryViewerEvent {
  const base = replaceError
    ? (({ error: _previousError, ...remaining }) => remaining)(event)
    : event;
  return {
    ...base,
    ok: completion.ok,
    writebackStatus: completion.status,
    writebackOutcome: completion.outcome,
    ...(completion.savedMemories?.length ? {
      content: completion.savedMemories.join("\n\n"),
      savedMemories: completion.savedMemories,
    } : {}),
    ...(completion.savedMemoryIds?.length ? {
      savedMemoryIds: completion.savedMemoryIds,
    } : {}),
    ...(completion.savedMemoryCount === undefined ? {} : {
      savedMemoryCount: completion.savedMemoryCount,
    }),
    ...(completion.error ? { error: completion.error } : {}),
  };
}
