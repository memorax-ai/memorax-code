import type { AutomaticMemoryWritebackRejectionReason } from "../../memory/automatic-writeback.js";
import {
  createHarnessMemoryRuntime,
  type HarnessMemoryRuntimeOptions,
} from "../../memory/harness-runtime.js";
import type {
  MemoryHookTurnStartResult,
  TraeTurnStartCommand,
  TraeWritebackCommand,
} from "../../memory/hook-command.js";
import type { MemoryDiagnosticLogger } from "../../memory/observability.js";
import type {
  MemoryTurnCoordinator,
  MemoryTurnState,
  MemoryTurnWritebackSkipReason,
} from "../../memory/turn-coordinator.js";
import type { RepositoryMemoryScopeFailureReason } from "../../repository/scope.js";
import { traceContextFromTraeHookBody, type TraceContext } from "../../trace/context.js";
import {
  markCurrentTraceTurnOutcome,
  recordTraceEvent,
  traceTurnEventId,
} from "../../trace/store.js";

export type TraeMemoryHookWritebackSkipReason =
  | "turn_metadata_mismatch"
  | "interrupted"
  | "config_missing"
  | RepositoryMemoryScopeFailureReason
  | AutomaticMemoryWritebackRejectionReason
  | MemoryTurnWritebackSkipReason;

export type TraeMemoryHookWritebackResult =
  | { ok: true; scheduled: true }
  | { ok: true; scheduled: false; reason: TraeMemoryHookWritebackSkipReason };

export type TraeMemoryHookRuntimeOptions = HarnessMemoryRuntimeOptions;

export type TraeMemoryHookRuntime = {
  recordTurnStart(command: TraeTurnStartCommand): Promise<MemoryHookTurnStartResult>;
  writeback(command: TraeWritebackCommand): Promise<TraeMemoryHookWritebackResult>;
  size(): number;
  close(): void;
};

const TRAE_MEMORY_TURN_CLIENT = "trae" as const;

export function createTraeMemoryHookRuntime(
  options: TraeMemoryHookRuntimeOptions = {},
): TraeMemoryHookRuntime {
  const now = options.now ?? (() => Date.now());
  const memory = createHarnessMemoryRuntime({
    client: TRAE_MEMORY_TURN_CLIENT,
    retrievalSource: "trae_hook_retrieval",
    writebackSource: "trae_hook_writeback",
    diagnosticPrefix: "trae_memory",
    traceFailureEvent: "trae_trace.write_failed",
    turnStartTraceSource: "trae-hook",
    deduplicateRetrieval: true,
  }, options);
  const { turnCoordinator } = memory;
  const interruptedTurns = new Set<string>();
  const activeTurns = new Map<string, MemoryTurnState>();
  const turnStartOperations = new Map<string, Promise<MemoryHookTurnStartResult>>();
  const runtimeTurnLimit = positiveInteger(options.maxEntries, 256);

  const runtime: TraeMemoryHookRuntime = {
    async recordTurnStart(command) {
      turnCoordinator.pruneExpired();
      const commandKey = traeRuntimeTurnKey(command.sessionId, command.turnId);
      if (interruptedTurns.has(commandKey)) return { ok: true };
      const previous = activeTurns.get(command.sessionId) ?? turnCoordinator.latestTurn({
        client: TRAE_MEMORY_TURN_CLIENT,
        sessionId: command.sessionId,
        excludeClientTurnId: command.turnId,
      });
      if (previous && previous.clientTurnId !== command.turnId) {
        await interruptPreviousTurn(turnCoordinator, previous, options, now);
        rememberBounded(
          interruptedTurns,
          traeRuntimeTurnKey(previous.sessionId, previous.clientTurnId),
          runtimeTurnLimit,
        );
      }
      const createdAt = now();
      const traceContext = traceContextFromTraeHookBody(command, new Date(createdAt).toISOString());
      return await memory.recordTurnStart({
        sessionId: command.sessionId,
        clientTurnId: command.turnId,
        cwd: command.cwd,
        workspaceKind: command.workspaceKind,
        createdAt,
        traceContext,
        prompt: command.prompt,
        onTurnRegistered(turn) {
          activeTurns.delete(command.sessionId);
          activeTurns.set(command.sessionId, turn);
          while (activeTurns.size > runtimeTurnLimit) {
            const oldestSessionId = activeTurns.keys().next().value;
            if (typeof oldestSessionId !== "string") break;
            activeTurns.delete(oldestSessionId);
          }
        },
      });
    },

    async writeback(command) {
      turnCoordinator.pruneExpired();
      const commandKey = traeRuntimeTurnKey(command.sessionId, command.turnId);
      const activeTurn = activeTurns.get(command.sessionId);
      if (
        interruptedTurns.has(commandKey)
        || (activeTurn && activeTurn.clientTurnId !== command.turnId)
      ) {
        rememberBounded(interruptedTurns, commandKey, runtimeTurnLimit);
        return { ok: true, scheduled: false, reason: "interrupted" };
      }
      const key = traeTurnKey(command.sessionId, command.turnId);
      const entry = turnCoordinator.getTurn(key) ?? activeTurn;
      const traceContext = entry?.traceContext ?? traceContextFromTraeHookBody(command);
      const repositoryMemory = await memory.resolveRepositoryMemory(command);
      await recordCompletedTurn(traceContext, command, options, now);
      const completed = await memory.completeTurn({
        sessionId: command.sessionId,
        clientTurnId: command.turnId,
        metadata: entry,
        resolveRepositoryMemory: async () => repositoryMemory,
        userText: command.prompt,
        assistantText: command.lastAssistantMessage,
        traceContext,
      });
      await recordMaterializedTurn(traceContext, command, options);
      if (activeTurn?.clientTurnId === command.turnId) activeTurns.delete(command.sessionId);
      options.diagnosticLogger?.("trae_memory.writeback", {
        scheduled: completed.scheduled,
        ...(!completed.scheduled ? { reason: completed.reason } : {}),
        sessionId: command.sessionId,
        turnId: command.turnId,
        metadataDisposition: completed.metadataDisposition,
      });
      return completed.scheduled
        ? { ok: true, scheduled: true }
        : { ok: true, scheduled: false, reason: completed.reason };
    },

    size() {
      return memory.size();
    },

    close() {
      interruptedTurns.clear();
      activeTurns.clear();
      turnStartOperations.clear();
      memory.close();
    },
  };

  return {
    ...runtime,
    recordTurnStart(command) {
      return queueSessionTurnStart(
        turnStartOperations,
        command.sessionId,
        () => runtime.recordTurnStart(command),
      );
    },
  };
}

async function interruptPreviousTurn(
  coordinator: MemoryTurnCoordinator,
  previous: MemoryTurnState,
  options: TraeMemoryHookRuntimeOptions,
  now: () => number,
): Promise<void> {
  await recordTraceBestEffort("trae_memory.interrupted_turn_end", recordTraceEvent({
    eventId: traceTurnEventId(previous.traceContext, "turn_end"),
    memoraxCodeHome: options.memoraxCodeHome,
    env: options.env,
    traceContext: previous.traceContext,
    type: "turn_end",
    source: "trae-hook",
    operation: "writeback",
    ok: true,
    outcome: "interrupted",
  }), options.diagnosticLogger);
  await recordTraceBestEffort("trae_memory.interrupted_current_turn", markCurrentTraceTurnOutcome(
    previous.traceContext,
    "interrupted",
    {
      client: "trae",
      memoraxCodeHome: options.memoraxCodeHome,
      env: options.env,
      now: () => new Date(now()),
    },
  ), options.diagnosticLogger);
  coordinator.discardTurn(previous, "interrupted");
}

async function recordCompletedTurn(
  traceContext: TraceContext | undefined,
  command: TraeWritebackCommand,
  options: TraeMemoryHookRuntimeOptions,
  now: () => number,
): Promise<void> {
  await recordTraceBestEffort("trae_memory.turn_end", recordTraceEvent({
    eventId: traceTurnEventId(traceContext, "turn_end"),
    memoraxCodeHome: options.memoraxCodeHome,
    env: options.env,
    traceContext,
    type: "turn_end",
    source: "trae-hook",
    operation: "writeback",
    ok: true,
    outcome: "completed",
    response: { assistant: command.lastAssistantMessage },
  }), options.diagnosticLogger);
  await recordTraceBestEffort("trae_memory.current_turn_close", markCurrentTraceTurnOutcome(
    traceContext,
    "completed",
    {
      client: "trae",
      memoraxCodeHome: options.memoraxCodeHome,
      env: options.env,
      now: () => new Date(now()),
    },
  ), options.diagnosticLogger);
}

async function recordMaterializedTurn(
  traceContext: TraceContext | undefined,
  command: TraeWritebackCommand,
  options: TraeMemoryHookRuntimeOptions,
): Promise<void> {
  await recordTraceBestEffort("trae_memory.turn_materialized", recordTraceEvent({
    eventId: traceTurnEventId(traceContext, "turn_materialized"),
    memoraxCodeHome: options.memoraxCodeHome,
    env: options.env,
    traceContext,
    type: "turn_materialized",
    source: "trae-hook",
    operation: "writeback",
    ok: true,
    request: { prompt: command.prompt },
    response: { assistant: command.lastAssistantMessage },
  }), options.diagnosticLogger);
}

function traeTurnKey(sessionId: string, turnId: string): {
  client: "trae";
  sessionId: string;
  clientTurnId: string;
} {
  return { client: "trae", sessionId, clientTurnId: turnId };
}

function traeRuntimeTurnKey(sessionId: string, turnId: string): string {
  return JSON.stringify([sessionId, turnId]);
}

function rememberBounded(values: Set<string>, value: string, limit: number): void {
  values.add(value);
  trimBounded(values, limit);
}

function trimBounded(values: Set<string>, limit: number): void {
  while (values.size > limit) {
    const oldest = values.values().next().value;
    if (typeof oldest !== "string") return;
    values.delete(oldest);
  }
}

async function recordTraceBestEffort(
  label: string,
  promise: Promise<unknown>,
  diagnosticLogger?: MemoryDiagnosticLogger,
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    diagnosticLogger?.("trae_trace.write_failed", {
      label,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function queueSessionTurnStart(
  operations: Map<string, Promise<MemoryHookTurnStartResult>>,
  sessionId: string,
  operation: () => Promise<MemoryHookTurnStartResult>,
): Promise<MemoryHookTurnStartResult> {
  const previous: Promise<unknown> = operations.get(sessionId) ?? Promise.resolve();
  const queued = previous
    .catch(() => undefined)
    .then(operation);
  operations.set(sessionId, queued);
  const clear = () => {
    if (operations.get(sessionId) === queued) operations.delete(sessionId);
  };
  void queued.then(clear, clear);
  return queued;
}

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
