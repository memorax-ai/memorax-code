import type { TraceContext, TraceRelatedTurn } from "../trace/context.js";

export type MemoryObservabilitySource =
  | "automatic_retrieval"
  | "automatic_writeback"
  | "codex_hook_writeback"
  | "codex_hook_retrieval"
  | "claude_hook_retrieval"
  | "claude_hook_writeback"
  | "opencode_plugin_retrieval"
  | "memory_cli"
  | "writeback_reconciler"
  | "unknown";

export type MemoryObservabilityOperation = "query" | "retrieve" | "writeback";

export type MemoryObservabilityRelatedTurn = TraceRelatedTurn;

export type MemoryDiagnosticLogger = (
  message: string,
  fields?: Record<string, unknown>,
) => void;

export type MemoryObservabilityEvent = {
  eventId?: string;
  source: MemoryObservabilitySource;
  operation: MemoryObservabilityOperation;
  ok: boolean;
  request?: unknown;
  response?: unknown;
  error?: string;
  relatedTurns?: MemoryObservabilityRelatedTurn[];
  traceContext?: TraceContext;
};

export type MemoryObservabilityHook = {
  recordEvent?: (event: MemoryObservabilityEvent) => void;
  drain?: () => Promise<void>;
};
