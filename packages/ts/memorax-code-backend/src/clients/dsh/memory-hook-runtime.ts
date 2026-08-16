import {
  type AutomaticMemoryWritebackRejectionReason,
} from "../../memory/automatic-writeback.js";
import { retrieveAutomaticMemoryContext } from "../../memory/automatic-retrieval.js";
import type {
  DshTurnStartCommand,
  DshWritebackCommand,
  MemoryHookTurnStartResult,
} from "../../memory/hook-command.js";
import type {
  MemoryDiagnosticLogger,
  MemoryObservabilityHook,
} from "../../memory/observability.js";
import {
  resolvedRepoMemoryWorktree,
  type ConfiguredRepositoryMemoryResult,
  type RepositoryMemorySessionRuntime,
} from "../../memory/repository-session.js";
import {
  type MemoryTurnCoordinator,
  type MemoryTurnState,
} from "../../memory/turn-coordinator.js";
import type { RepositoryMemoryScopeFailureReason } from "../../repository/scope.js";
import {
  dshSessionEventTurn,
  type DshSessionTurn,
  type DshSessionTurnFailureReason,
} from "./session-turn.js";
import {
  traceContextFromDshSessionEventLog,
  traceContextFromDshTurnStart,
  type TraceContext,
} from "../../trace/context.js";
import {
  markCurrentTraceTurnOutcome,
  recordTraceEvent,
  traceTurnEventId,
  writeCurrentTraceTurn,
  type TraceTurnOutcome,
} from "../../trace/store.js";

export type DshMemoryHookWritebackSkipReason =
  | "turn_metadata_mismatch"
  | "config_missing"
  | DshSessionTurnFailureReason
  | RepositoryMemoryScopeFailureReason
  | AutomaticMemoryWritebackRejectionReason;

export type DshMemoryHookWritebackResult =
  | { ok: true; scheduled: true }
  | { ok: true; scheduled: false; reason: DshMemoryHookWritebackSkipReason };

export type DshMemoryHookRuntimeOptions = {
  diagnosticLogger?: MemoryDiagnosticLogger;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  maxEntries?: number;
  memoryObservability?: MemoryObservabilityHook;
  memoraxCodeHome?: string;
  repositoryMemorySession: RepositoryMemorySessionRuntime;
  turnCoordinator: MemoryTurnCoordinator;
};

export type DshMemoryHookRuntime = {
  recordTurnStart(command: DshTurnStartCommand): Promise<MemoryHookTurnStartResult>;
  writeback(command: DshWritebackCommand): Promise<DshMemoryHookWritebackResult>;
  close(): void;
};

const DSH_MEMORY_TURN_CLIENT = "dsh" as const;

export function createDshMemoryHookRuntime(
  options: DshMemoryHookRuntimeOptions,
): DshMemoryHookRuntime {
  const now = options.now ?? (() => Date.now());
  const { repositoryMemorySession, turnCoordinator } = options;
  const retrievalTurns = new Set<string>();
  const retrievalTurnLimit = positiveInteger(options.maxEntries, 256);

  return {
    async recordTurnStart(command) {
      turnCoordinator.pruneExpired();
      const createdAt = now();
      const traceContext = traceContextFromDshTurnStart(
        command,
        new Date(createdAt).toISOString(),
      );
      const repositoryMemory = await resolveHookRepositoryMemory(command, options, repositoryMemorySession);
      turnCoordinator.recordTurnStart({
        client: DSH_MEMORY_TURN_CLIENT,
        sessionId: command.sessionId,
        clientTurnId: String(command.turn),
        cwd: command.cwd,
        eventStartSeq: command.startSeq,
        createdAt,
        traceContext,
        repositoryMemory,
      });
      options.diagnosticLogger?.("dsh_memory.turn_start", {
        sessionId: command.sessionId,
        turn: command.turn,
        startSeq: command.startSeq,
        cacheSize: turnCoordinator.size(DSH_MEMORY_TURN_CLIENT),
        workspace: repositoryMemory.ok ? repositoryMemory.memory.scope?.repositorySlug : undefined,
        workspaceScopeReason: repositoryMemory.ok ? undefined : repositoryMemory.reason,
      });
      await recordDshTraceBestEffort("dsh_memory.turn_start_event", recordTraceEvent({
        eventId: traceTurnEventId(traceContext, "turn_start"),
        memoraxCodeHome: options.memoraxCodeHome,
        env: options.env,
        traceContext,
        type: "turn_start",
        source: "dsh-cordis",
        operation: "query",
        ok: true,
        request: {
          start_seq: command.startSeq,
        },
      }), options.diagnosticLogger);
      await recordDshTraceBestEffort("dsh_memory.current_turn_write", writeCurrentTraceTurn(
        traceContext,
        {
          client: "dsh",
          memoraxCodeHome: options.memoraxCodeHome,
          env: options.env,
          now: () => new Date(now()),
        },
      ), options.diagnosticLogger);

      const repoMemoryWorktree = resolvedRepoMemoryWorktree(repositoryMemory);
      const retrievalKey = JSON.stringify([command.sessionId, command.turn, command.startSeq]);
      if (retrievalTurns.has(retrievalKey)) {
        return {
          ok: true,
          ...(repoMemoryWorktree ? { repoMemoryWorktree } : {}),
        };
      }
      retrievalTurns.add(retrievalKey);
      while (retrievalTurns.size > retrievalTurnLimit) {
        const oldest = retrievalTurns.values().next().value;
        if (typeof oldest !== "string") break;
        retrievalTurns.delete(oldest);
      }
      const retrieval = await retrieveAutomaticMemoryContext({
        diagnosticLogger: options.diagnosticLogger,
        env: options.env ?? process.env,
        fetchImpl: options.fetchImpl,
        memoryObservability: options.memoryObservability,
        memoryObservabilitySource: "dsh_native_retrieval",
        query: command.prompt,
        repositoryMemory,
        sessionKey: command.sessionId,
        traceContext,
      });
      return {
        ok: true,
        ...(repoMemoryWorktree ? { repoMemoryWorktree } : {}),
        ...(retrieval.context ? { additionalContext: retrieval.context } : {}),
      };
    },
    async writeback(command) {
      turnCoordinator.pruneExpired();
      const key = dshTurnKey(command.sessionId, command.turn);
      const entry = turnCoordinator.getTurn(key);
      if (
        entry
        && (entry.eventStartSeq !== command.startSeq || entry.cwd !== command.cwd)
      ) return skippedWriteback(command, "turn_metadata_mismatch", options);
      const materialized = dshSessionEventTurn(command);
      if (!materialized.ok) {
        if (materialized.reason === "turn_not_completed") {
          const traceContext = traceContextFromDshSessionEventLog(command);
          await recordDshTurnEnd(options, traceContext, {
            outcome: "interrupted",
            nativeOutcome: materialized.outcome,
            startSeq: command.startSeq,
            endSeq: command.endSeq,
          });
          const discarded = turnCoordinator.discardTurn(key, "interrupted");
          return skippedWriteback(
            command,
            materialized.reason,
            options,
            discarded ? "consumed" : "absent",
          );
        }
        return skippedWriteback(command, materialized.reason, options);
      }

      const traceContext = traceContextFromDshSessionEventLog(command);
      await recordDshTurnEnd(options, traceContext, {
        outcome: "completed",
        nativeOutcome: materialized.turn.outcome,
        startSeq: materialized.turn.startSeq,
        endSeq: materialized.turn.endSeq,
        turn: materialized.turn,
      });

      const writeback = await turnCoordinator.completeMaterializedTurn({
        key,
        metadata: entry,
        resolveRepositoryMemory: () => resolveCurrentHookRepositoryMemory(
          entry,
          command,
          options,
          repositoryMemorySession,
        ),
        userText: materialized.turn.userPrompt,
        assistantText: materialized.turn.assistantReply,
        writeback: {
          client: DSH_MEMORY_TURN_CLIENT,
          sessionKey: command.sessionId,
          env: options.env ?? process.env,
          fetchImpl: options.fetchImpl,
          memoryObservability: options.memoryObservability,
          memoryObservabilitySource: "dsh_native_writeback",
          traceContext,
        },
      });
      if (!writeback.scheduled) {
        return skippedWriteback(command, writeback.reason, options, writeback.metadataDisposition);
      }
      options.diagnosticLogger?.("dsh_memory.writeback", {
        scheduled: true,
        metadataDisposition: writeback.metadataDisposition,
        sessionId: command.sessionId,
        turn: command.turn,
        startSeq: command.startSeq,
        endSeq: command.endSeq,
        outcome: materialized.turn.outcome,
        promptChars: materialized.turn.userPrompt.length,
        assistantChars: materialized.turn.assistantReply.length,
        contentSource: "dsh_session_event_interval",
      });
      return { ok: true, scheduled: true };
    },
    close() {
      retrievalTurns.clear();
    },
  };
}

async function recordDshTurnEnd(
  options: DshMemoryHookRuntimeOptions,
  traceContext: TraceContext | undefined,
  details: {
    outcome: TraceTurnOutcome;
    nativeOutcome: string;
    startSeq: number;
    endSeq: number;
    turn?: DshSessionTurn;
  },
): Promise<void> {
  const eventId = traceTurnEventId(traceContext, "turn_end");
  const recorded = await recordDshTraceBestEffort("dsh_memory.turn_end_event", recordTraceEvent({
    eventId,
    memoraxCodeHome: options.memoraxCodeHome,
    env: options.env,
    traceContext,
    type: "turn_end",
    source: "dsh-session-event-log",
    operation: "reply",
    ok: true,
    outcome: details.outcome,
    request: {
      start_seq: details.startSeq,
      end_seq: details.endSeq,
      native_outcome: details.nativeOutcome,
    },
  }), options.diagnosticLogger);
  if (!recorded || (!recorded.written && recorded.reason !== "duplicate_event")) return;
  if (details.turn && eventId) {
    await recordDshTraceBestEffort("dsh_memory.turn_materialized_event", recordTraceEvent({
      eventId: traceTurnEventId(traceContext, "turn_materialized"),
      memoraxCodeHome: options.memoraxCodeHome,
      env: options.env,
      traceContext,
      type: "turn_materialized",
      source: "dsh-session-event-log",
      operation: "reply",
      ok: true,
      outcome: details.outcome,
      request: {
        original_event_id: eventId,
        start_seq: details.startSeq,
        end_seq: details.endSeq,
        prompt: details.turn.userPrompt,
      },
      response: {
        assistantMessage: details.turn.assistantReply,
      },
    }), options.diagnosticLogger);
  }
  await recordDshTraceBestEffort("dsh_memory.current_turn_close", markCurrentTraceTurnOutcome(
    traceContext,
    details.outcome,
    {
      client: "dsh",
      memoraxCodeHome: options.memoraxCodeHome,
      env: options.env,
    },
  ), options.diagnosticLogger);
}

async function recordDshTraceBestEffort<T>(
  label: string,
  promise: Promise<T>,
  diagnosticLogger?: MemoryDiagnosticLogger,
): Promise<T | undefined> {
  try {
    return await promise;
  } catch (error) {
    diagnosticLogger?.("dsh_trace.write_failed", {
      label,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

function dshTurnKey(sessionId: string, turn: number) {
  return {
    client: DSH_MEMORY_TURN_CLIENT,
    sessionId,
    clientTurnId: String(turn),
  } as const;
}

async function resolveHookRepositoryMemory(
  command: DshTurnStartCommand,
  options: DshMemoryHookRuntimeOptions,
  repositoryMemorySession: RepositoryMemorySessionRuntime,
): Promise<ConfiguredRepositoryMemoryResult> {
  return await repositoryMemorySession.resolve({
    client: DSH_MEMORY_TURN_CLIENT,
    sessionId: command.sessionId,
    workspaceRoot: command.cwd,
    memoraxCodeHome: options.memoraxCodeHome ?? options.env?.MEMORAX_CODE_HOME,
    env: options.env,
  });
}

async function resolveCurrentHookRepositoryMemory(
  entry: MemoryTurnState | undefined,
  command: DshWritebackCommand,
  options: DshMemoryHookRuntimeOptions,
  repositoryMemorySession: RepositoryMemorySessionRuntime,
): Promise<ConfiguredRepositoryMemoryResult> {
  return await repositoryMemorySession.resolve({
    client: DSH_MEMORY_TURN_CLIENT,
    sessionId: command.sessionId,
    workspaceRoot: command.cwd,
    // DSH's persisted session header and exact event interval remain native
    // authority after a Backend restart, when the in-memory binding is gone.
    requireBoundScope: entry !== undefined,
    memoraxCodeHome: options.memoraxCodeHome ?? options.env?.MEMORAX_CODE_HOME,
    env: options.env,
  });
}

function skippedWriteback(
  command: DshWritebackCommand,
  reason: DshMemoryHookWritebackSkipReason,
  options: DshMemoryHookRuntimeOptions,
  metadataDisposition: "consumed" | "retained" | "absent" = "retained",
): DshMemoryHookWritebackResult {
  options.diagnosticLogger?.("dsh_memory.writeback", {
    scheduled: false,
    reason,
    metadataDisposition,
    sessionId: command.sessionId,
    turn: command.turn,
    startSeq: command.startSeq,
    endSeq: command.endSeq,
  });
  return { ok: true, scheduled: false, reason };
}

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
