import type { MemoryObservabilityEvent } from "../memory/observability.js";
import type { TraceClient } from "../trace/context.js";

export type MemoryViewerEventType =
  | "turn_start"
  | "turn_materialized"
  | "memory_retrieve"
  | "memory_cli_search"
  | "memory_cli_add"
  | "memory_writeback"
  | "memory_writeback_status"
  | "turn_end";

export type MemoryViewerTurnReference = Readonly<{
  turnId?: string;
  capturedAt: string;
}>;

export type MemoryViewerEvent = Readonly<{
  id: string;
  eventKey: string;
  client: TraceClient;
  type: MemoryViewerEventType;
  timestamp: string;
  source: MemoryObservabilityEvent["source"];
  operation: MemoryObservabilityEvent["operation"] | "reply";
  ok: boolean;
  projectId?: string;
  projectLabel?: string;
  project?: string;
  sessionId?: string;
  turnId?: string;
  turnReferences?: readonly MemoryViewerTurnReference[];
  content: string;
  prompt?: string;
  answer?: string;
  query?: string;
  results?: ReadonlyArray<Readonly<{ content: string; score?: number; confidence?: number }>>;
  itemCount?: number;
  receiptId?: string;
  taskId?: string;
  originalEventId?: string;
  turnOutcome?: "completed" | "interrupted";
  writebackStatus?: string;
  writebackOutcome?: "pending" | "saved" | "skipped" | "failed" | "completed";
  savedMemoryCount?: number;
  savedMemoryIds?: readonly string[];
  savedMemories?: readonly string[];
  error?: string;
  details?: unknown;
}>;

export type MemoryViewerProjectCatalogEntry = Readonly<{
  projectId: string;
  projectLabel: string;
  eventCount: number;
  lastSeenAt: string;
}>;

type MemoryViewerProjectSessionCatalogEntryBase = Readonly<{
  client: TraceClient;
  projectId: string;
  eventCount: number;
  lastSeenAt: string;
}>;

export type MemoryViewerProjectSessionCatalogEntry =
  MemoryViewerProjectSessionCatalogEntryBase & (
    | Readonly<{ sessionId: string; unscoped?: false }>
    | Readonly<{ unscoped: true; sessionId?: never }>
  );

export type MemoryViewerActivitySummary = Readonly<{
  activityCount: number;
  recalledCount: number;
  addCount: number;
  searchCount: number;
}>;

export type MemoryViewerSessionTitleCandidate = Readonly<{
  id: string;
  client: MemoryViewerEvent["client"];
  sessionId: string;
  timestamp: string;
  title: string;
}>;

export type MemoryViewerUserActivityStatus =
  | "completed"
  | "saved"
  | "skipped"
  | "processing"
  | "interrupted"
  | "failed"
  | "unknown";

export type MemoryViewerUserActivity = Readonly<{
  kind: "turn" | "search" | "add";
  occurredAt: string;
  source: "client" | "assistant" | "automatic";
  status: MemoryViewerUserActivityStatus;
  count: number | null;
  projectId?: string;
  projectLabel?: string;
}>;

export type MemoryViewerUserSummary = Readonly<{
  turnCount: number;
  searchOperationCount: number;
  searchedMemoryCount: number;
  addOperationCount: number;
  addedMemoryCount: number;
  processingCount: number;
  unknownCount: number;
  failedCount: number;
}>;

export type MemoryViewerUserProjection = Readonly<{
  activities: MemoryViewerUserActivity[];
  summary: MemoryViewerUserSummary;
}>;

export type MemoryViewerData = Readonly<{
  events: MemoryViewerEvent[];
  turnEvents: MemoryViewerEvent[];
  activitySummary: MemoryViewerActivitySummary;
  catalogSourceEvents: MemoryViewerEvent[];
  sessionTitleCandidates: MemoryViewerSessionTitleCandidate[];
  projects: MemoryViewerProjectCatalogEntry[];
  projectSessions: MemoryViewerProjectSessionCatalogEntry[];
  hasUnclassified: boolean;
  activityProjects: MemoryViewerProjectCatalogEntry[];
  activityProjectSessions: MemoryViewerProjectSessionCatalogEntry[];
  userProjection?: MemoryViewerUserProjection;
  selectedProjectId?: string;
  projectFilterStatus?: "resolved" | "invalid" | "missing";
}>;
