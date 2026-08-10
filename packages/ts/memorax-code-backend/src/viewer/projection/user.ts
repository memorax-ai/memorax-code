import { isTraceClient, type TraceClient } from "../../trace/context.js";
import type {
  MemoryViewerEvent,
  MemoryViewerUserActivity,
  MemoryViewerUserActivityStatus,
  MemoryViewerUserProjection,
} from "../model.js";

export type {
  MemoryViewerUserActivity,
  MemoryViewerUserActivityStatus,
  MemoryViewerUserProjection,
  MemoryViewerUserSummary,
} from "../model.js";

type ClientScopedMemoryViewerEvent = MemoryViewerEvent & Readonly<{
  client?: TraceClient;
}>;

/**
 * Projects raw Viewer events into the deliberately small user-facing summary contract.
 * Conversation, memory, session, turn, and diagnostic fields never cross this boundary.
 */
export function projectMemoryViewerUserData(
  events: readonly ClientScopedMemoryViewerEvent[],
): MemoryViewerUserProjection {
  const turnActivities = projectTurnActivities(events);
  const activities = [
    ...turnActivities,
    ...events.flatMap((event): MemoryViewerUserActivity[] => {
      if (event.type === "memory_retrieve" || event.type === "memory_cli_search") {
        const occurredAt = canonicalUserActivityTimestamp(event.timestamp);
        if (!occurredAt) return [];
        const nativeTranscriptActivity = isClaudeNativeTranscriptMemoryActivity(event);
        return [{
          kind: "search",
          occurredAt,
          source: event.type === "memory_cli_search" ? "assistant" : "automatic",
          status: event.ok ? "completed" : "failed",
          count: event.ok
            ? nativeTranscriptActivity
              ? safeNativeTranscriptSearchItemCount(event)
              : event.itemCount ?? event.results?.length ?? 0
            : 0,
          ...safeProjectFields(event),
        }];
      }
      if (event.type !== "memory_cli_add" && event.type !== "memory_writeback") return [];
      const occurredAt = canonicalUserActivityTimestamp(event.timestamp);
      if (!occurredAt) return [];
      const nativeTranscriptActivity = isClaudeNativeTranscriptMemoryActivity(event);
      return [{
        kind: "add",
        occurredAt,
        source: event.type === "memory_cli_add" ? "assistant" : "automatic",
        status: nativeTranscriptActivity && event.ok ? "unknown" : addStatus(event),
        count: nativeTranscriptActivity && event.ok ? null : addCount(event),
        ...safeProjectFields(event),
      }];
    }),
  ].sort(compareUserActivitiesNewestFirst);

  return {
    activities,
    summary: {
      turnCount: turnActivities.length,
      searchOperationCount: countActivities(activities, "search"),
      searchedMemoryCount: sumActivityCounts(activities, "search"),
      addOperationCount: countActivities(activities, "add"),
      addedMemoryCount: activities
        .filter((activity) => activity.kind === "add" && activity.status === "saved")
        .reduce((total, activity) => total + (activity.count ?? 0), 0),
      processingCount: activities.filter((activity) => activity.status === "processing").length,
      unknownCount: activities.filter((activity) => (
        activity.kind !== "turn"
        && activity.count === null
        && activity.status !== "processing"
        && activity.status !== "failed"
      )).length,
      failedCount: activities.filter((activity) => activity.status === "failed").length,
    },
  };
}

function isClaudeNativeTranscriptMemoryActivity(event: ClientScopedMemoryViewerEvent): boolean {
  return event.client === "claude"
    && event.id.startsWith("claude-local:")
    && (event.type === "memory_cli_search" || event.type === "memory_cli_add");
}

function safeNativeTranscriptSearchItemCount(event: ClientScopedMemoryViewerEvent): number | null {
  return Number.isSafeInteger(event.itemCount)
    && (event.itemCount ?? -1) >= 0
    && (event.itemCount ?? 101) <= 100
    ? event.itemCount as number
    : null;
}

function projectTurnActivities(
  events: readonly ClientScopedMemoryViewerEvent[],
): MemoryViewerUserActivity[] {
  const turns = new Map<string, { start?: ClientScopedMemoryViewerEvent; end?: ClientScopedMemoryViewerEvent }>();
  for (const event of events) {
    if (!event.sessionId || !event.turnId || (event.type !== "turn_start" && event.type !== "turn_end")) continue;
    const key = `${traceClient(event)}\u0000${event.sessionId}\u0000${event.turnId}`;
    const turn = turns.get(key) ?? {};
    if (event.type === "turn_start") turn.start = event;
    else turn.end = event;
    turns.set(key, turn);
  }
  return [...turns.values()].flatMap((turn): MemoryViewerUserActivity[] => {
    const anchor = turn.start ?? turn.end;
    if (!anchor) return [];
    const occurredAt = canonicalUserActivityTimestamp(turn.start?.timestamp)
      ?? canonicalUserActivityTimestamp(turn.end?.timestamp)
      ?? canonicalUserActivityTimestamp(anchor.timestamp);
    if (!occurredAt) return [];
    return [{
      kind: "turn",
      occurredAt,
      source: "client",
      status: turn.end?.turnOutcome === "interrupted"
        || (!turn.end && turn.start?.turnOutcome === "interrupted")
        ? "interrupted"
        : turn.end
          ? "completed"
          : "processing",
      count: null,
      ...safeProjectFields(anchor),
    }];
  });
}

function canonicalUserActivityTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 512) return undefined;
  const parsed = Date.parse(value.trim());
  if (!Number.isFinite(parsed)) return undefined;
  return new Date(parsed).toISOString();
}

function traceClient(event: ClientScopedMemoryViewerEvent): TraceClient {
  return isTraceClient(event.client) ? event.client : "codex";
}

function safeProjectFields(
  event: Pick<MemoryViewerEvent, "projectId" | "projectLabel">,
): Pick<MemoryViewerUserActivity, "projectId" | "projectLabel"> {
  return {
    ...(event.projectId ? { projectId: event.projectId } : {}),
    ...(event.projectLabel ? { projectLabel: event.projectLabel } : {}),
  };
}

function addStatus(event: MemoryViewerEvent): MemoryViewerUserActivityStatus {
  if (!event.ok || event.writebackOutcome === "failed") return "failed";
  if (event.writebackOutcome === "pending") return "processing";
  if (event.writebackOutcome === "saved") return "saved";
  if (event.writebackOutcome === "skipped") return "skipped";
  if (event.writebackOutcome === "completed") return "completed";
  if (event.savedMemoryCount !== undefined) return event.savedMemoryCount > 0 ? "saved" : "skipped";
  return "unknown";
}

function addCount(event: MemoryViewerEvent): number | null {
  if (!event.ok || event.writebackOutcome === "failed") return 0;
  if (event.savedMemoryCount !== undefined) return event.savedMemoryCount;
  if (event.writebackOutcome === "skipped") return 0;
  return null;
}

function compareUserActivitiesNewestFirst(
  left: MemoryViewerUserActivity,
  right: MemoryViewerUserActivity,
): number {
  return timestampOrder(right.occurredAt) - timestampOrder(left.occurredAt);
}

function timestampOrder(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function countActivities(
  activities: readonly MemoryViewerUserActivity[],
  kind: MemoryViewerUserActivity["kind"],
): number {
  return activities.filter((activity) => activity.kind === kind).length;
}

function sumActivityCounts(
  activities: readonly MemoryViewerUserActivity[],
  kind: MemoryViewerUserActivity["kind"],
): number {
  return activities
    .filter((activity) => activity.kind === kind)
    .reduce((total, activity) => total + (activity.count ?? 0), 0);
}
