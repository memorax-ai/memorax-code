import type { TraceClient } from "../../trace/context.js";

export type MemoryViewerEventIdentity = Readonly<{
  id: string;
  client?: TraceClient;
  sessionId?: string;
}>;

export function memoryViewerEventKey(event: MemoryViewerEventIdentity): string {
  return JSON.stringify([event.client ?? "codex", event.sessionId ?? "", event.id]);
}
