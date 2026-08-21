import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type AutomaticMemoryWritebackRejectionReason,
} from "../../memory/automatic-writeback.js";
import { retrieveAutomaticMemoryContext } from "../../memory/automatic-retrieval.js";
import type {
  HermesTurnStartCommand,
  HermesWritebackCommand,
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
import type {
  MemoryTurnCoordinator,
  MemoryTurnState,
} from "../../memory/turn-coordinator.js";
import type { RepositoryMemoryScopeFailureReason } from "../../repository/scope.js";
import {
  hermesSessionTurn,
  type HermesSessionTurn,
  type HermesSessionTurnFailureReason,
} from "./session-turn.js";
import {
  traceContextFromHermesHookBody,
  traceContextFromHermesStateDb,
  type TraceContext,
} from "../../trace/context.js";
import {
  markCurrentTraceTurnOutcome,
  recordTraceEvent,
  traceTurnEventId,
  writeCurrentTraceTurn,
  type TraceTurnOutcome,
} from "../../trace/store.js";

export type HermesMemoryHookWritebackSkipReason =
  | "turn_metadata_mismatch"
  | "config_missing"
  | HermesSessionTurnFailureReason
  | RepositoryMemoryScopeFailureReason
  | AutomaticMemoryWritebackRejectionReason;

export type HermesMemoryHookWritebackResult =
  | { ok: true; scheduled: true }
  | { ok: true; scheduled: false; reason: HermesMemoryHookWritebackSkipReason };

export type HermesMemoryHookRuntimeOptions = {
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

export type HermesMemoryHookRuntime = {
  recordTurnStart(command: HermesTurnStartCommand): Promise<MemoryHookTurnStartResult>;
  writeback(command: HermesWritebackCommand): Promise<HermesMemoryHookWritebackResult>;
  close(): void;
};

const HERMES_MEMORY_TURN_CLIENT = "hermes" as const;

/**
 * Resolve the Hermes profile home for writeback materialization. The
 * environment wins; otherwise the managed adapter state records the home that
 * installation used (for example via ``--hermes-home``), which the inherited
 * Backend environment may not carry.
 */
function resolvedHermesHome(options: HermesMemoryHookRuntimeOptions): string | undefined {
  const fromEnv = options.env?.HERMES_HOME;
  if (fromEnv !== undefined && fromEnv.trim()) return fromEnv;
  const memoraxCodeHome = options.memoraxCodeHome?.trim()
    || options.env?.MEMORAX_CODE_HOME?.trim()
    || join(homedir(), ".memorax-code");
  try {
    const state = JSON.parse(
      readFileSync(join(memoraxCodeHome, "adapters", "hermes", "state.json"), "utf8"),
    );
    return typeof state?.hermesHome === "string" && state.hermesHome.trim()
      ? state.hermesHome
      : undefined;
  } catch {
    return undefined;
  }
}

export function createHermesMemoryHookRuntime(
  options: HermesMemoryHookRuntimeOptions,
): HermesMemoryHookRuntime {
  const now = options.now ?? (() => Date.now());
  const { repositoryMemorySession, turnCoordinator } = options;
  const retrievalTurns = new Set<string>();
  const retrievalTurnLimit = positiveInteger(options.maxEntries, 256);

  return {
    async recordTurnStart(command) {
      turnCoordinator.pruneExpired();
      const createdAt = now();
      const traceContext = traceContextFromHermesHookBody(
        command,
        new Date(createdAt).toISOString(),
      );
      const repositoryMemory = await resolveHookRepositoryMemory(command, options, repositoryMemorySession);
      turnCoordinator.recordTurnStart({
        client: HERMES_MEMORY_TURN_CLIENT,
        sessionId: command.sessionId,
        clientTurnId: command.turnId,
        cwd: command.cwd,
        createdAt,
        traceContext,
        repositoryMemory,
      });
      options.diagnosticLogger?.("hermes_memory.turn_start", {
        sessionId: command.sessionId,
        turnId: command.turnId,
        cacheSize: turnCoordinator.size(HERMES_MEMORY_TURN_CLIENT),
        workspace: repositoryMemory.ok ? repositoryMemory.memory.scope?.repositorySlug : undefined,
        workspaceScopeReason: repositoryMemory.ok ? undefined : repositoryMemory.reason,
      });
      await recordHermesTraceBestEffort("hermes_memory.turn_start_event", recordTraceEvent({
        eventId: traceTurnEventId(traceContext, "turn_start"),
        memoraxCodeHome: options.memoraxCodeHome,
        env: options.env,
        traceContext,
        type: "turn_start",
        source: "hermes-pre-llm-call",
        operation: "query",
        ok: true,
        request: {
          turn_id: command.turnId,
        },
      }), options.diagnosticLogger);
      await recordHermesTraceBestEffort("hermes_memory.current_turn_write", writeCurrentTraceTurn(
        traceContext,
        {
          client: "hermes",
          memoraxCodeHome: options.memoraxCodeHome,
          env: options.env,
          now: () => new Date(now()),
        },
      ), options.diagnosticLogger);

      const repoMemoryWorktree = resolvedRepoMemoryWorktree(repositoryMemory);
      const retrievalKey = JSON.stringify([command.sessionId, command.turnId]);
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
        memoryObservabilitySource: "hermes_native_retrieval",
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
      const key = hermesTurnKey(command.sessionId, command.turnId);
      const entry = turnCoordinator.getTurn(key);
      if (entry && entry.cwd !== command.cwd) {
        return skippedWriteback(command, "turn_metadata_mismatch", options);
      }
      const materialized = await hermesSessionTurn({
        sessionId: command.sessionId,
        turnId: command.turnId,
        ...(command.prompt ? { prompt: command.prompt } : {}),
        cwd: command.cwd,
        completed: command.completed,
        interrupted: command.interrupted,
        failed: command.failed,
        hermesHome: resolvedHermesHome(options),
        turnStartedAt: entry?.createdAt,
        now: now(),
      });
      if (!materialized.ok) {
        if (materialized.reason === "turn_not_completed") {
          const traceContext = traceContextFromHermesStateDb(command);
          await recordHermesTurnEnd(options, traceContext, {
            outcome: "interrupted",
            nativeOutcome: materialized.outcome ?? "unknown",
            turnId: command.turnId,
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

      const traceContext = traceContextFromHermesStateDb(command);
      await recordHermesTurnEnd(options, traceContext, {
        outcome: "completed",
        nativeOutcome: "completed",
        turnId: command.turnId,
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
          client: HERMES_MEMORY_TURN_CLIENT,
          sessionKey: command.sessionId,
          env: options.env ?? process.env,
          fetchImpl: options.fetchImpl,
          memoryObservability: options.memoryObservability,
          memoryObservabilitySource: "hermes_native_writeback",
          traceContext,
        },
      });
      if (!writeback.scheduled) {
        return skippedWriteback(command, writeback.reason, options, writeback.metadataDisposition);
      }
      options.diagnosticLogger?.("hermes_memory.writeback", {
        scheduled: true,
        metadataDisposition: writeback.metadataDisposition,
        sessionId: command.sessionId,
        turnId: command.turnId,
        outcome: "completed",
        promptChars: materialized.turn.userPrompt.length,
        assistantChars: materialized.turn.assistantReply.length,
        contentSource: "hermes_state_db",
      });
      return { ok: true, scheduled: true };
    },
    close() {
      retrievalTurns.clear();
    },
  };
}

async function recordHermesTurnEnd(
  options: HermesMemoryHookRuntimeOptions,
  traceContext: TraceContext | undefined,
  details: {
    outcome: TraceTurnOutcome;
    nativeOutcome: string;
    turnId: string;
    turn?: HermesSessionTurn;
  },
): Promise<void> {
  const eventId = traceTurnEventId(traceContext, "turn_end");
  const recorded = await recordHermesTraceBestEffort("hermes_memory.turn_end_event", recordTraceEvent({
    eventId,
    memoraxCodeHome: options.memoraxCodeHome,
    env: options.env,
    traceContext,
    type: "turn_end",
    source: "hermes-state-db",
    operation: "reply",
    ok: true,
    outcome: details.outcome,
    request: {
      turn_id: details.turnId,
      native_outcome: details.nativeOutcome,
    },
  }), options.diagnosticLogger);
  if (!recorded || (!recorded.written && recorded.reason !== "duplicate_event")) return;
  if (details.turn && eventId) {
    await recordHermesTraceBestEffort("hermes_memory.turn_materialized_event", recordTraceEvent({
      eventId: traceTurnEventId(traceContext, "turn_materialized"),
      memoraxCodeHome: options.memoraxCodeHome,
      env: options.env,
      traceContext,
      type: "turn_materialized",
      source: "hermes-state-db",
      operation: "reply",
      ok: true,
      outcome: details.outcome,
      request: {
        original_event_id: eventId,
        turn_id: details.turnId,
        prompt: details.turn.userPrompt,
      },
      response: {
        assistantMessage: details.turn.assistantReply,
      },
    }), options.diagnosticLogger);
  }
  await recordHermesTraceBestEffort("hermes_memory.current_turn_close", markCurrentTraceTurnOutcome(
    traceContext,
    details.outcome,
    {
      client: "hermes",
      memoraxCodeHome: options.memoraxCodeHome,
      env: options.env,
    },
  ), options.diagnosticLogger);
}

async function recordHermesTraceBestEffort<T>(
  label: string,
  promise: Promise<T>,
  diagnosticLogger?: MemoryDiagnosticLogger,
): Promise<T | undefined> {
  try {
    return await promise;
  } catch (error) {
    diagnosticLogger?.("hermes_trace.write_failed", {
      label,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

function hermesTurnKey(sessionId: string, turnId: string) {
  return {
    client: HERMES_MEMORY_TURN_CLIENT,
    sessionId,
    clientTurnId: turnId,
  } as const;
}

async function resolveHookRepositoryMemory(
  command: HermesTurnStartCommand,
  options: HermesMemoryHookRuntimeOptions,
  repositoryMemorySession: RepositoryMemorySessionRuntime,
): Promise<ConfiguredRepositoryMemoryResult> {
  return await repositoryMemorySession.resolve({
    client: HERMES_MEMORY_TURN_CLIENT,
    sessionId: command.sessionId,
    workspaceRoot: command.cwd,
    memoraxCodeHome: options.memoraxCodeHome ?? options.env?.MEMORAX_CODE_HOME,
    env: options.env,
  });
}

async function resolveCurrentHookRepositoryMemory(
  entry: MemoryTurnState | undefined,
  command: HermesWritebackCommand,
  options: HermesMemoryHookRuntimeOptions,
  repositoryMemorySession: RepositoryMemorySessionRuntime,
): Promise<ConfiguredRepositoryMemoryResult> {
  return await repositoryMemorySession.resolve({
    client: HERMES_MEMORY_TURN_CLIENT,
    sessionId: command.sessionId,
    workspaceRoot: command.cwd,
    // Hermes state.db rows remain native authority after a Backend restart,
    // when the in-memory binding is gone.
    requireBoundScope: entry !== undefined,
    memoraxCodeHome: options.memoraxCodeHome ?? options.env?.MEMORAX_CODE_HOME,
    env: options.env,
  });
}

function skippedWriteback(
  command: HermesWritebackCommand,
  reason: HermesMemoryHookWritebackSkipReason,
  options: HermesMemoryHookRuntimeOptions,
  metadataDisposition: "consumed" | "retained" | "absent" = "retained",
): HermesMemoryHookWritebackResult {
  options.diagnosticLogger?.("hermes_memory.writeback", {
    scheduled: false,
    reason,
    metadataDisposition,
    sessionId: command.sessionId,
    turnId: command.turnId,
  });
  return { ok: true, scheduled: false, reason };
}

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}