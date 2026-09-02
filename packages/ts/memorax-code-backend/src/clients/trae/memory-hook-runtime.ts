import {
  createAutomaticMemoryWritebackRuntime,
  type AutomaticMemoryWritebackEnqueue,
  type AutomaticMemoryWritebackRejectionReason,
  type AutomaticMemoryWritebackRuntime,
} from "../../memory/automatic-writeback.js";
import { retrieveAutomaticMemoryContext } from "../../memory/automatic-retrieval.js";
import {
  claimQuotaNotice,
  createPendingQuotaNoticeRuntime,
  type PendingQuotaNoticeRuntime,
  type QuotaNoticeClaimer,
} from "../../memory/quota-notice.js";
import type {
  MemoryHookTurnStartResult,
  TraeTurnStartCommand,
  TraeWritebackCommand,
} from "../../memory/hook-command.js";
import type { MemoryDiagnosticLogger, MemoryObservabilityHook } from "../../memory/observability.js";
import {
  createMemoryTurnCoordinator,
  type MemoryTurnCoordinator,
  type MemoryTurnState,
  type MemoryTurnWritebackSkipReason,
} from "../../memory/turn-coordinator.js";
import {
  createRepositoryMemorySessionRuntime,
  resolvedRepoMemoryWorktree,
  type ConfiguredRepositoryMemoryResult,
  type RepositoryMemorySessionRuntime,
} from "../../memory/repository-session.js";
import type { RepositoryMemoryScopeFailureReason } from "../../repository/scope.js";
import { traceContextFromTraeHookBody, type TraceContext } from "../../trace/context.js";
import {
  markCurrentTraceTurnOutcome,
  recordTraceEvent,
  traceTurnEventId,
  writeCurrentTraceTurn,
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

export type TraeMemoryHookRuntimeOptions = {
  automaticWriteback?: AutomaticMemoryWritebackEnqueue;
  diagnosticLogger?: MemoryDiagnosticLogger;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  claimQuotaNotice?: QuotaNoticeClaimer;
  now?: () => number;
  ttlMs?: number;
  maxEntries?: number;
  cleanupIntervalMs?: number;
  memoryObservability?: MemoryObservabilityHook;
  memoraxCodeHome?: string;
  pendingQuotaNotice?: PendingQuotaNoticeRuntime;
  repositoryMemorySession?: RepositoryMemorySessionRuntime;
  turnCoordinator?: MemoryTurnCoordinator;
};

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
  const pendingQuotaNotice = options.pendingQuotaNotice ?? createPendingQuotaNoticeRuntime({
    claimQuotaNotice: options.claimQuotaNotice,
    diagnosticLogger: options.diagnosticLogger,
    env: options.env,
  });
  const ownsPendingQuotaNotice = options.pendingQuotaNotice === undefined;
  const automaticWritebackRuntime: {
    enqueue: AutomaticMemoryWritebackEnqueue;
    discardForScopeUpgrade?: AutomaticMemoryWritebackRuntime["discardForScopeUpgrade"];
    close?: () => void;
  } | undefined = options.turnCoordinator
    ? undefined
    : options.automaticWriteback
      ? { enqueue: options.automaticWriteback }
      : createAutomaticMemoryWritebackRuntime({
        diagnosticLogger: options.diagnosticLogger,
        queueQuotaNotice: pendingQuotaNotice.queue,
      });
  const turnCoordinator = options.turnCoordinator ?? createMemoryTurnCoordinator({
    automaticWriteback: automaticWritebackRuntime!.enqueue,
    now,
    ttlMs: options.ttlMs,
    maxEntries: options.maxEntries,
    cleanupIntervalMs: options.cleanupIntervalMs,
  });
  const ownsTurnCoordinator = options.turnCoordinator === undefined;
  const repositoryMemorySession = options.repositoryMemorySession ?? createRepositoryMemorySessionRuntime({
    onScopeUpgrade: automaticWritebackRuntime?.discardForScopeUpgrade,
  });
  const ownsRepositoryMemorySession = options.repositoryMemorySession === undefined;
  const retrievalTurns = new Set<string>();
  const interruptedTurns = new Set<string>();
  const activeTurns = new Map<string, MemoryTurnState>();
  const runtimeTurnLimit = positiveInteger(options.maxEntries, 256);

  return {
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
      const repositoryMemory = await resolveHookRepositoryMemory(command, options, repositoryMemorySession);
      const repoMemoryWorktree = resolvedRepoMemoryWorktree(repositoryMemory);
      const turn = turnCoordinator.recordTurnStart({
        client: TRAE_MEMORY_TURN_CLIENT,
        sessionId: command.sessionId,
        clientTurnId: command.turnId,
        cwd: command.cwd,
        workspaceKind: command.workspaceKind,
        createdAt,
        traceContext,
        repositoryMemory,
      });
      activeTurns.delete(command.sessionId);
      activeTurns.set(command.sessionId, turn);
      while (activeTurns.size > runtimeTurnLimit) {
        const oldestSessionId = activeTurns.keys().next().value;
        if (typeof oldestSessionId !== "string") break;
        activeTurns.delete(oldestSessionId);
      }
      await recordTraceBestEffort("trae_memory.turn_start_event", recordTraceEvent({
        eventId: traceTurnEventId(traceContext, "turn_start"),
        memoraxCodeHome: options.memoraxCodeHome,
        env: options.env,
        traceContext,
        type: "turn_start",
        source: "trae-hook",
        operation: "query",
        ok: true,
        request: { prompt: command.prompt, cwd: command.cwd },
      }), options.diagnosticLogger);
      await recordTraceBestEffort("trae_memory.current_turn_write", writeCurrentTraceTurn(
        traceContext,
        {
          client: "trae",
          memoraxCodeHome: options.memoraxCodeHome,
          env: options.env,
          now: () => new Date(now()),
        },
      ), options.diagnosticLogger);

      const retrievalKey = JSON.stringify([command.sessionId, command.turnId]);
      if (retrievalTurns.has(retrievalKey)) {
        return { ok: true, ...(repoMemoryWorktree ? { repoMemoryWorktree } : {}) };
      }
      retrievalTurns.add(retrievalKey);
      trimBounded(retrievalTurns, runtimeTurnLimit);
      const pendingUserNotice = repositoryMemory.ok
        ? await pendingQuotaNotice.claim(repositoryMemory.memory.config)
        : undefined;
      const retrieval = await retrieveAutomaticMemoryContext({
        diagnosticLogger: options.diagnosticLogger,
        claimQuotaNotice: options.claimQuotaNotice ?? claimQuotaNotice,
        env: options.env ?? process.env,
        fetchImpl: options.fetchImpl,
        memoryObservability: options.memoryObservability,
        memoryObservabilitySource: "trae_hook_retrieval",
        query: command.prompt,
        repositoryMemory,
        sessionKey: command.sessionId,
        traceContext,
      });
      const userNotice = [pendingUserNotice, retrieval.userNotice].filter(Boolean).join("\n");
      return {
        ok: true,
        ...(repoMemoryWorktree ? { repoMemoryWorktree } : {}),
        ...(retrieval.context ? { additionalContext: retrieval.context } : {}),
        ...(userNotice ? { userNotice } : {}),
      };
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
      const repositoryMemory = await resolveHookRepositoryMemory(command, options, repositoryMemorySession);
      await recordCompletedTurn(traceContext, command, options, now);
      const completed = await turnCoordinator.completeMaterializedTurn({
        key,
        metadata: entry,
        resolveRepositoryMemory: async () => repositoryMemory,
        userText: command.prompt,
        assistantText: command.lastAssistantMessage,
        writeback: {
          client: "trae",
          sessionKey: command.sessionId,
          env: options.env ?? process.env,
          fetchImpl: options.fetchImpl,
          memoryObservability: options.memoryObservability,
          memoryObservabilitySource: "trae_hook_writeback",
          traceContext,
        },
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
      return turnCoordinator.size(TRAE_MEMORY_TURN_CLIENT);
    },

    close() {
      retrievalTurns.clear();
      interruptedTurns.clear();
      activeTurns.clear();
      if (ownsTurnCoordinator) turnCoordinator.close();
      if (ownsRepositoryMemorySession) repositoryMemorySession.close();
      automaticWritebackRuntime?.close?.();
      if (ownsPendingQuotaNotice) pendingQuotaNotice.close();
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

async function resolveHookRepositoryMemory(
  command: TraeTurnStartCommand | TraeWritebackCommand,
  options: TraeMemoryHookRuntimeOptions,
  repository: RepositoryMemorySessionRuntime,
): Promise<ConfiguredRepositoryMemoryResult> {
  return await repository.resolve({
    client: "trae",
    sessionId: command.sessionId,
    workspaceRoot: command.cwd,
    workspaceKind: command.workspaceKind,
    memoraxCodeHome: options.memoraxCodeHome ?? options.env?.MEMORAX_CODE_HOME,
    env: options.env,
  });
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

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
