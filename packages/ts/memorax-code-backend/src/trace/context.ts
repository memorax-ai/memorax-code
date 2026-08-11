import {
  memoryProjectFromUnknown,
  resolveMemoryProject,
  type MemoryProjectIdentity,
} from "../memory/project.js";

export type TraceContextOrigin =
  | "codex-hook-body"
  | "claude-hook-body"
  | "opencode-hook-body"
  | "current-turn-file"
  | "manual";
export type TraceClient = "codex" | "claude" | "opencode";

export type TraceRelatedTurn = Readonly<{
  turnId?: string;
  requestId?: string;
  nativeRequestId?: string;
  contextOrigin: TraceContextOrigin;
  capturedAt: string;
}>;

export type TraceContext = Readonly<{
  schemaVersion: "1";
  client: TraceClient;
  sessionId: string;
  turnId?: string;
  threadId?: string;
  nativeRequestId?: string;
  requestId?: string;
  transcriptPath?: string;
  cwd?: string;
  memoryProject?: MemoryProjectIdentity;
  workspaceKind?: string;
  contextOrigin: TraceContextOrigin;
  capturedAt: string;
}>;

export function traceContextFromHookBody(
  body: unknown,
  capturedAt = new Date().toISOString(),
): TraceContext | undefined {
  if (!isRecord(body)) return undefined;
  const sessionId = stringField(body, "session_id") ?? stringField(body, "sessionId");
  if (!sessionId) return undefined;
  const cwd = stringField(body, "cwd");
  return pruneTraceContext({
    schemaVersion: "1",
    client: "codex",
    sessionId,
    turnId: stringField(body, "turn_id") ?? stringField(body, "turnId"),
    threadId: stringField(body, "thread_id") ?? stringField(body, "threadId"),
    nativeRequestId: stringField(body, "native_request_id") ?? stringField(body, "nativeRequestId"),
    requestId: stringField(body, "request_id") ?? stringField(body, "requestId"),
    transcriptPath: stringField(body, "transcript_path") ?? stringField(body, "transcriptPath"),
    cwd,
    memoryProject: resolveMemoryProject(cwd),
    workspaceKind: stringField(body, "workspace_kind") ?? stringField(body, "workspaceKind"),
    contextOrigin: "codex-hook-body",
    capturedAt,
  });
}

export function traceContextFromClaudeHookBody(
  body: unknown,
  capturedAt = new Date().toISOString(),
): TraceContext | undefined {
  if (!isRecord(body)) return undefined;
  const sessionId = stringField(body, "session_id") ?? stringField(body, "sessionId");
  if (!sessionId) return undefined;
  const cwd = stringField(body, "cwd");
  return pruneTraceContext({
    schemaVersion: "1",
    client: "claude",
    sessionId,
    turnId: stringField(body, "prompt_id") ?? stringField(body, "promptId"),
    transcriptPath: stringField(body, "transcript_path") ?? stringField(body, "transcriptPath"),
    cwd,
    memoryProject: resolveMemoryProject(cwd),
    workspaceKind: stringField(body, "workspace_kind") ?? stringField(body, "workspaceKind"),
    contextOrigin: "claude-hook-body",
    capturedAt,
  });
}

export function traceContextFromOpenCodeHookBody(
  body: unknown,
  capturedAt = new Date().toISOString(),
): TraceContext | undefined {
  if (!isRecord(body)) return undefined;
  const sessionId = stringField(body, "sessionId");
  const turnId = stringField(body, "userMessageId");
  if (!sessionId || !turnId) return undefined;
  const cwd = stringField(body, "cwd");
  return pruneTraceContext({
    schemaVersion: "1",
    client: "opencode",
    sessionId,
    turnId,
    cwd,
    memoryProject: resolveMemoryProject(cwd),
    workspaceKind: stringField(body, "workspaceKind"),
    contextOrigin: "opencode-hook-body",
    capturedAt,
  });
}

export function traceContextFromCurrentTurnRecord(
  value: unknown,
): TraceContext | undefined {
  if (!isRecord(value)) return undefined;
  const trace = isRecord(value.trace) ? value.trace : value;
  const sessionId = stringField(trace, "session_id") ?? stringField(trace, "sessionId");
  if (!sessionId) return undefined;
  const capturedAt = stringField(trace, "captured_at") ?? stringField(trace, "capturedAt");
  if (!capturedAt || !Number.isFinite(Date.parse(capturedAt))) return undefined;
  const cwd = stringField(trace, "cwd");
  const client = stringField(trace, "client");
  if (!isTraceClient(client)) return undefined;
  return pruneTraceContext({
    schemaVersion: "1",
    client,
    sessionId,
    turnId: stringField(trace, "turn_id") ?? stringField(trace, "turnId"),
    threadId: stringField(trace, "thread_id") ?? stringField(trace, "threadId"),
    nativeRequestId: stringField(trace, "native_request_id") ?? stringField(trace, "nativeRequestId"),
    requestId: stringField(trace, "request_id") ?? stringField(trace, "requestId"),
    transcriptPath: stringField(trace, "transcript_path") ?? stringField(trace, "transcriptPath"),
    cwd,
    memoryProject: memoryProjectFromUnknown(trace.memory_project)
      ?? memoryProjectFromUnknown(trace.memoryProject)
      ?? resolveMemoryProject(cwd),
    workspaceKind: stringField(trace, "workspace_kind") ?? stringField(trace, "workspaceKind"),
    contextOrigin: "current-turn-file",
    capturedAt,
  });
}

export function traceContextJson(context: TraceContext): Record<string, unknown> {
  return pruneRecord({
    client: context.client,
    session_id: context.sessionId,
    turn_id: context.turnId,
    thread_id: context.threadId,
    native_request_id: context.nativeRequestId,
    request_id: context.requestId,
    transcript_path: context.transcriptPath,
    cwd: context.cwd,
    memory_project: context.memoryProject ? {
      project_id: context.memoryProject.projectId,
      project_label: context.memoryProject.projectLabel,
    } : undefined,
    workspace_kind: context.workspaceKind,
    context_origin: context.contextOrigin,
    captured_at: context.capturedAt,
  });
}

function pruneTraceContext(value: TraceContext): TraceContext {
  return pruneRecord(value) as TraceContext;
}

function pruneRecord<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

export function isTraceClient(value: unknown): value is TraceClient {
  return value === "codex" || value === "claude" || value === "opencode";
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
