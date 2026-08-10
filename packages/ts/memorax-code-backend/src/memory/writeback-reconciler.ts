import { createHash } from "node:crypto";
import { backendDebug } from "../shared/debug-log.js";
import { callMemoAddStatus, memoraxConfigFromEnv } from "../provider/memorax/adapter.js";
import { MEMORAX_PROVIDER_ID, memoraxWritebackEnabled } from "../provider/memorax/config.js";
import {
  completeMemoryWritebackTask,
  createMemoryWritebackTaskProjection,
  type MemoryWritebackTaskProjection,
  type PendingMemoryWritebackTask,
} from "./writeback-task-projection.js";
import { clientTraceConfigFromEnv } from "../trace/config.js";
import type { TraceClient } from "../trace/context.js";
import { recordTraceEvent } from "../trace/store.js";

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_MAX_TASKS_PER_RUN = 20;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_MAX_BACKOFF_MS = 60 * 60_000;

type NormalizedAddStatus = Readonly<{
  status: string;
  memory?: unknown;
  memoryKnown: boolean;
  error: string | null;
}>;

type ReconcileCandidateResult = "persisted" | "pending" | "failed";

type ReconcilePolicy = Readonly<{
  retainPending: (tasks: readonly PendingMemoryWritebackTask[]) => void;
  isDue: (task: PendingMemoryWritebackTask) => boolean;
  recordResult: (task: PendingMemoryWritebackTask, result: ReconcileCandidateResult) => void;
}>;

export type MemoryWritebackReconcileReport = Readonly<{
  inspected: number;
  persisted: number;
  pending: number;
  failed: number;
}>;

export type MemoryWritebackReconciler = Readonly<{
  runNow: () => Promise<MemoryWritebackReconcileReport>;
  close: () => Promise<void>;
}>;

export async function reconcileMemoryWritebackStatuses(options: {
  memoraxCodeHome: string;
  client?: TraceClient;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  maxTasks?: number;
  concurrency?: number;
  candidateOffset?: number;
  taskProjection?: MemoryWritebackTaskProjection;
}): Promise<MemoryWritebackReconcileReport> {
  return reconcileMemoryWritebackStatusesWithPolicy(options);
}

export function startMemoryWritebackReconciler(options: {
  memoraxCodeHome: string;
  client?: TraceClient;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  intervalMs?: number;
  maxTasks?: number;
  concurrency?: number;
  maxBackoffMs?: number;
  now?: () => number;
  taskProjection?: MemoryWritebackTaskProjection;
}): MemoryWritebackReconciler {
  let closed = false;
  let active: Promise<MemoryWritebackReconcileReport> | undefined;
  let candidateOffset = 0;
  const intervalMs = positiveInteger(options.intervalMs, DEFAULT_INTERVAL_MS);
  const maxTasks = positiveInteger(options.maxTasks, DEFAULT_MAX_TASKS_PER_RUN);
  const taskProjection = resolveTaskProjection(options);
  const policy = createReconcileBackoffPolicy({
    now: options.now ?? Date.now,
    baseDelayMs: intervalMs,
    maxDelayMs: Math.max(intervalMs, positiveInteger(options.maxBackoffMs, DEFAULT_MAX_BACKOFF_MS)),
  });
  const runNow = (): Promise<MemoryWritebackReconcileReport> => {
    if (closed) return Promise.resolve(emptyReport());
    if (active) return active;
    active = reconcileMemoryWritebackStatusesWithPolicy({
      ...options,
      maxTasks,
      candidateOffset,
      taskProjection,
    }, policy).finally(() => {
      candidateOffset += maxTasks;
      active = undefined;
    });
    return active;
  };
  const scheduleRun = () => {
    void runNow().catch((error) => {
      backendDebug("memory_writeback_reconciler.run_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };
  scheduleRun();
  const timer = setInterval(scheduleRun, intervalMs);
  timer.unref?.();
  return {
    runNow,
    async close() {
      closed = true;
      clearInterval(timer);
      await active?.catch(() => undefined);
    },
  };
}

async function reconcileMemoryWritebackStatusesWithPolicy(
  options: {
    memoraxCodeHome: string;
    client?: TraceClient;
    env?: Record<string, string | undefined>;
    fetchImpl?: typeof fetch;
    maxTasks?: number;
    concurrency?: number;
    candidateOffset?: number;
    taskProjection?: MemoryWritebackTaskProjection;
  },
  policy?: ReconcilePolicy,
): Promise<MemoryWritebackReconcileReport> {
  const env = { ...(options.env ?? process.env), MEMORAX_CODE_HOME: options.memoraxCodeHome };
  const config = memoraxConfigFromEnv(env);
  const taskProjection = resolveTaskProjection(options);
  if (
    !clientTraceConfigFromEnv(taskProjection.client, env).enabled
    || !config.ok
    || !memoraxWritebackEnabled(env)
  ) {
    return emptyReport();
  }
  const maxTasks = positiveInteger(options.maxTasks, DEFAULT_MAX_TASKS_PER_RUN);
  const concurrency = positiveInteger(options.concurrency, DEFAULT_CONCURRENCY);
  const pendingWritebacks = await taskProjection.listPending();
  policy?.retainPending(pendingWritebacks);
  const dueWritebacks = pendingWritebacks.filter((task) => policy?.isDue(task) ?? true);
  const candidates = rotatedBatch(dueWritebacks, maxTasks, options.candidateOffset ?? 0);
  const queue = [...candidates];
  const report = { inspected: 0, persisted: 0, pending: 0, failed: 0 };
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (;;) {
      const task = queue.shift();
      if (!task) return;
      report.inspected += 1;
      try {
        const raw = await callMemoAddStatus(config.config, task.taskId, options.fetchImpl);
        const status = normalizeAddStatus(raw);
        if (isPendingWritebackStatus(status.status)) {
          report.pending += 1;
          policy?.recordResult(task, "pending");
          continue;
        }
        await persistTerminalWritebackStatus(options.memoraxCodeHome, env, task, status);
        report.persisted += 1;
        policy?.recordResult(task, "persisted");
      } catch (error) {
        report.failed += 1;
        policy?.recordResult(task, "failed");
        backendDebug("memory_writeback_reconciler.status_failed", {
          taskId: task.taskId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  });
  await Promise.all(workers);
  return report;
}

function resolveTaskProjection(options: {
  memoraxCodeHome: string;
  client?: TraceClient;
  taskProjection?: MemoryWritebackTaskProjection;
}): MemoryWritebackTaskProjection {
  return options.taskProjection ?? createMemoryWritebackTaskProjection({
    memoraxCodeHome: options.memoraxCodeHome,
    client: options.client ?? "codex",
  });
}

async function persistTerminalWritebackStatus(
  memoraxCodeHome: string,
  env: Record<string, string | undefined>,
  task: PendingMemoryWritebackTask,
  status: NormalizedAddStatus,
): Promise<void> {
  const completed = completeMemoryWritebackTask({
    status: status.status,
    ...(status.memoryKnown ? { memory: status.memory, memoryKnown: true } : {}),
    error: status.error,
  });
  const capturedAt = new Date().toISOString();
  const recorded = await recordTraceEvent({
    memoraxCodeHome,
    env,
    eventId: terminalEventId(task, completed.status),
    traceContext: {
      schemaVersion: "1",
      client: task.client,
      sessionId: task.sessionId,
      ...(task.turnId ? { turnId: task.turnId } : {}),
      ...(task.memoryProject ? { memoryProject: task.memoryProject } : {}),
      contextOrigin: "manual",
      capturedAt,
    },
    type: "memory_writeback_status",
    source: "writeback_reconciler",
    operation: "writeback",
    ok: completed.ok,
    request: {
      task_id: task.taskId,
      original_event_id: task.eventId,
      provider: MEMORAX_PROVIDER_ID,
    },
    response: {
      taskId: task.taskId,
      status: completed.status,
      outcome: completed.outcome,
      ...(completed.savedMemoryCount === undefined ? {} : { savedMemoryCount: completed.savedMemoryCount }),
      ...(completed.savedMemoryIds?.length ? { savedMemoryIds: completed.savedMemoryIds } : {}),
      ...(completed.savedMemories?.length ? { savedMemories: completed.savedMemories } : {}),
    },
    error: completed.error,
  });
  if (!recorded.written && recorded.reason !== "duplicate_event") {
    throw new Error(`writeback terminal status was not persisted: ${recorded.reason}`);
  }
}

function createReconcileBackoffPolicy(options: {
  now: () => number;
  baseDelayMs: number;
  maxDelayMs: number;
}): ReconcilePolicy {
  const retries = new Map<string, { attempts: number; nextAttemptAt: number }>();
  return {
    retainPending(tasks) {
      const pendingKeys = new Set(tasks.map(reconcileCandidateKey));
      for (const key of retries.keys()) {
        if (!pendingKeys.has(key)) retries.delete(key);
      }
    },
    isDue(task) {
      const key = reconcileCandidateKey(task);
      return (retries.get(key)?.nextAttemptAt ?? 0) <= options.now();
    },
    recordResult(task, result) {
      const key = reconcileCandidateKey(task);
      if (result === "persisted") {
        retries.delete(key);
        return;
      }
      const attempts = (retries.get(key)?.attempts ?? 0) + 1;
      const multiplier = 2 ** Math.min(attempts - 1, 30);
      const delayMs = Math.min(options.maxDelayMs, options.baseDelayMs * multiplier);
      retries.set(key, {
        attempts,
        nextAttemptAt: options.now() + delayMs,
      });
    },
  };
}

function reconcileCandidateKey(task: PendingMemoryWritebackTask): string {
  return JSON.stringify([
    task.client,
    task.sessionId,
    task.eventId,
    task.taskId,
  ]);
}

function normalizeAddStatus(raw: unknown): NormalizedAddStatus {
  const envelope = record(raw);
  const data = record(envelope?.data) ?? envelope;
  const status = typeof data?.status === "string" ? data.status.trim().toLowerCase() : "unknown";
  const error = typeof data?.error === "string" && data.error.trim() ? data.error.trim() : null;
  const hasMemoryField = Boolean(data)
    && (
      Object.prototype.hasOwnProperty.call(data, "memory")
      || Object.prototype.hasOwnProperty.call(data, "memories")
    );
  const memory = data?.memory ?? data?.memories;
  const memoryKnown = hasMemoryField && memory !== null && memory !== undefined;
  return {
    status,
    ...(memoryKnown ? { memory } : {}),
    memoryKnown,
    error,
  };
}

function isPendingWritebackStatus(status: string): boolean {
  return status === "accepted"
    || status === "processing"
    || status === "queued"
    || status === "pending"
    || status === "unknown";
}

function terminalEventId(task: PendingMemoryWritebackTask, status: string): string {
  const digest = createHash("sha256")
    .update(`${task.sessionId}\u0000${task.eventId}\u0000${task.taskId}\u0000${status}`)
    .digest("hex")
    .slice(0, 32);
  return `memory-writeback-status-${digest}`;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function rotatedBatch<T>(items: readonly T[], limit: number, offset: number): T[] {
  if (items.length <= limit) return [...items];
  const start = Number.isSafeInteger(offset) && offset > 0 ? offset % items.length : 0;
  return Array.from({ length: limit }, (_, index) => items[(start + index) % items.length]);
}

function emptyReport(): MemoryWritebackReconcileReport {
  return { inspected: 0, persisted: 0, pending: 0, failed: 0 };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
