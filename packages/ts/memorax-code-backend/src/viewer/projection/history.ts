import { memoryViewerEventKey } from "./event-identity.js";
import type { MemoryViewerEvent } from "../model.js";

/**
 * Marks a retained start without an end as interrupted only when a different
 * Turn demonstrably started later in the same client session.
 *
 * This is a Viewer-only projection. It does not synthesize a trace event or
 * change transcript and writeback authority.
 */
export function foldMemoryViewerSupersededTurnStarts(
  allEvents: readonly MemoryViewerEvent[],
): MemoryViewerEvent[] {
  const endedTurns = new Set<string>();
  const startsBySession = new Map<string, Map<string, number>>();
  for (const event of allEvents) {
    if (!event.sessionId || !event.turnId) continue;
    const turnKey = viewerTurnKey(event);
    if (event.type === "turn_end") {
      endedTurns.add(turnKey);
      continue;
    }
    if (event.type !== "turn_start") continue;
    const startedAt = Date.parse(event.timestamp);
    if (!Number.isFinite(startedAt)) continue;
    const sessionKey = JSON.stringify([event.client, event.sessionId]);
    const starts = startsBySession.get(sessionKey) ?? new Map<string, number>();
    const current = starts.get(turnKey);
    if (current === undefined || startedAt < current) starts.set(turnKey, startedAt);
    startsBySession.set(sessionKey, starts);
  }

  const interruptedTurns = new Set<string>();
  for (const starts of startsBySession.values()) {
    const latestStartedAt = Math.max(...starts.values());
    for (const [turnKey, startedAt] of starts) {
      if (!endedTurns.has(turnKey) && startedAt < latestStartedAt) {
        interruptedTurns.add(turnKey);
      }
    }
  }
  if (interruptedTurns.size === 0) return [...allEvents];
  return allEvents.map((event) => (
    event.type === "turn_start"
      && !event.turnOutcome
      && interruptedTurns.has(viewerTurnKey(event))
      ? { ...event, turnOutcome: "interrupted" }
      : event
  ));
}

export function foldMemoryViewerTurnMaterializations(
  allEvents: readonly MemoryViewerEvent[],
): MemoryViewerEvent[] {
  const byOriginalEventKey = new Map<string, MemoryViewerEvent>();
  for (const event of allEvents) {
    if (event.type === "turn_materialized" && event.originalEventId) {
      byOriginalEventKey.set(memoryViewerEventKey({
        id: event.originalEventId,
        client: event.client,
        ...(event.sessionId ? { sessionId: event.sessionId } : {}),
      }), event);
    }
  }
  return allEvents
    .filter((event) => event.type !== "turn_materialized")
    .map((event) => {
      if (event.type !== "turn_end") return event;
      const materialized = byOriginalEventKey.get(event.eventKey);
      if (!materialized) return event;
      const answer = materialized.answer ?? event.answer;
      return {
        ...event,
        ...(materialized.turnOutcome ? { turnOutcome: materialized.turnOutcome } : {}),
        ...(answer ? { answer, content: answer } : {}),
        ...(materialized.details === undefined ? {} : { details: materialized.details }),
      };
  });
}

function viewerTurnKey(
  event: Pick<MemoryViewerEvent, "client" | "sessionId" | "turnId">,
): string {
  return JSON.stringify([event.client, event.sessionId, event.turnId]);
}
