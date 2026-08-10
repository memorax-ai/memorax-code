import { UNCLASSIFIED_PROJECT_ID } from "../../memory/project.js";
import { memoryViewerEventTurnIds } from "./turn-reference.js";
import type {
  MemoryViewerActivitySummary,
  MemoryViewerEvent,
  MemoryViewerProjectSessionCatalogEntry,
} from "../model.js";

export function memoryViewerActivitySummary(
  allEvents: MemoryViewerEvent[],
): MemoryViewerActivitySummary {
  let recalledCount = 0;
  let addCount = 0;
  let searchCount = 0;
  for (const event of allEvents) {
    if (event.type === "memory_retrieve" || event.type === "memory_cli_search") {
      searchCount += 1;
      recalledCount += event.itemCount ?? event.results?.length ?? 0;
    }
    if (event.type === "memory_cli_add" || event.type === "memory_writeback") addCount += 1;
  }
  return {
    activityCount: allEvents.length,
    recalledCount,
    addCount,
    searchCount,
  };
}

export function memoryViewerActivityProjection(allEvents: MemoryViewerEvent[]): {
  eventActivityOrder: Map<string, number>;
  projectSessions: MemoryViewerProjectSessionCatalogEntry[];
} {
  type ActivityTurn = {
    firstOrder: number;
    firstTimestamp: string;
    startOrder?: number;
    startTimestamp?: string;
  };
  const turns = new Map<string, ActivityTurn>();
  for (const event of allEvents) {
    if (!event.sessionId) continue;
    const order = timestampOrder(event.timestamp);
    for (const turnId of memoryViewerEventTurnIds(event)) {
      const key = `${event.client}\u0000${event.sessionId}\u0000${turnId}`;
      const current = turns.get(key);
      if (!current) {
        turns.set(key, {
          firstOrder: order,
          firstTimestamp: event.timestamp,
          ...(event.type === "turn_start" && Number.isFinite(order)
            ? { startOrder: order, startTimestamp: event.timestamp }
            : {}),
        });
        continue;
      }
      if (Number.isFinite(order)
        && (!Number.isFinite(current.firstOrder) || order < current.firstOrder)) {
        current.firstOrder = order;
        current.firstTimestamp = event.timestamp;
      }
      if (event.type === "turn_start"
        && Number.isFinite(order)
        && (current.startOrder === undefined || order < current.startOrder)) {
        current.startOrder = order;
        current.startTimestamp = event.timestamp;
      }
    }
  }

  const eventActivityOrder = new Map<string, number>();
  const entries = new Map<string, {
    value: MemoryViewerProjectSessionCatalogEntry;
    lastSeenOrder: number;
  }>();
  for (const event of allEvents) {
    let turn: ActivityTurn | undefined;
    if (event.sessionId) {
      for (const turnId of memoryViewerEventTurnIds(event)) {
        const candidate = turns.get(`${event.client}\u0000${event.sessionId}\u0000${turnId}`);
        if (!candidate) continue;
        const candidateOrder = candidate.startOrder ?? candidate.firstOrder;
        const turnOrder = turn ? turn.startOrder ?? turn.firstOrder : Number.NEGATIVE_INFINITY;
        if (!turn || candidateOrder > turnOrder) turn = candidate;
      }
    }
    const activityOrder = turn?.startOrder ?? turn?.firstOrder ?? timestampOrder(event.timestamp);
    const activityTimestamp = turn?.startTimestamp ?? turn?.firstTimestamp ?? event.timestamp;
    eventActivityOrder.set(event.eventKey, activityOrder);
    const projectId = event.projectId ?? UNCLASSIFIED_PROJECT_ID;
    const key = `${event.client}\u0000${projectId}\u0000${event.sessionId ?? ""}`;
    const current = entries.get(key);
    if (!current) {
      entries.set(key, {
        value: {
          client: event.client,
          projectId,
          ...(event.sessionId ? { sessionId: event.sessionId } : { unscoped: true }),
          eventCount: 1,
          lastSeenAt: activityTimestamp,
        },
        lastSeenOrder: activityOrder,
      });
      continue;
    }
    const lastSeenAt = activityOrder >= current.lastSeenOrder
      ? activityTimestamp
      : current.value.lastSeenAt;
    entries.set(key, {
      value: {
        ...current.value,
        eventCount: current.value.eventCount + 1,
        lastSeenAt,
      },
      lastSeenOrder: Math.max(current.lastSeenOrder, activityOrder),
    });
  }
  return {
    eventActivityOrder,
    projectSessions: [...entries.values()]
      .map((entry) => entry.value)
      .sort((left, right) => (
        left.projectId.localeCompare(right.projectId)
          || left.client.localeCompare(right.client)
          || timestampOrder(right.lastSeenAt) - timestampOrder(left.lastSeenAt)
          || (left.sessionId ?? "").localeCompare(right.sessionId ?? "")
      )),
  };
}

function timestampOrder(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}
