import {
  readCodexInterruptedRolloutTurn,
  readCodexRolloutTurn,
  type CodexRolloutTurn,
  type CodexRolloutTurnFailureReason,
} from "./rollout-turn.js";
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
import { readCodexSessionTurnIndex } from "./session-turn-index.js";
import { resolveCodexWorkspaceRoot } from "./workspace-links.js";
import type {
  MemoryHookTurnStartResult,
  CodexTurnStartCommand,
  CodexWritebackCommand,
} from "../../memory/hook-command.js";
import type { MemoryDiagnosticLogger, MemoryObservabilityHook } from "../../memory/observability.js";
import {
  createMemoryTurnCoordinator,
  type MemoryTurnCoordinator,
  type MemoryTurnState,
} from "../../memory/turn-coordinator.js";
import {
  createRepositoryMemorySessionRuntime,
  resolvedRepoMemoryWorktree,
  type ConfiguredRepositoryMemoryResult,
  type RepositoryMemorySessionRuntime,
} from "../../memory/repository-session.js";
import type {
  RepositoryMemoryScope,
  RepositoryMemoryScopeFailureReason,
} from "../../repository/scope.js";
import { traceContextFromHookBody, type TraceContext } from "../../trace/context.js";
import {
  markCurrentCodexTurnOutcome,
  readCurrentCodexTurn,
  readOpenCodexTurn,
  recordCodexTraceEvent,
  traceTurnEventId,
  writeCurrentCodexTurn,
  type CodexTurnOutcome,
} from "../../trace/store.js";

type CodexMemoryHookTurnStart = Omit<CodexTurnStartCommand, "version" | "client"> & {
  createdAt: number;
  traceContext?: TraceContext;
};

export type CodexMemoryHookTurnState = {
  sessionId: string;
  turnId: string;
  cwd?: string;
  workspaceKind?: string;
  transcriptPath?: string;
  createdAt: number;
  repositoryScope?: RepositoryMemoryScope;
  repositoryScopeError?: string;
  repositoryScopeReason?: "config_missing" | RepositoryMemoryScopeFailureReason;
  sessionTurnIndex?: number;
  traceContext?: TraceContext;
};

type CodexMemoryHookWritebackSkipReason =
  | "missing_session_id"
  | "non_materialized_session"
  | "turn_id_missing"
  | "turn_metadata_mismatch"
  | "config_missing"
  | CodexRolloutTurnFailureReason
  | RepositoryMemoryScopeFailureReason
  | AutomaticMemoryWritebackRejectionReason;

export type CodexMemoryHookWritebackResult =
  | { ok: true; scheduled: true }
  | { ok: true; scheduled: false; reason: CodexMemoryHookWritebackSkipReason };

type CodexMemoryHookWritebackRequest = Omit<CodexWritebackCommand, "version" | "client"> & {
  traceContext?: TraceContext;
};

export type CodexMemoryHookRuntimeOptions = {
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

export type CodexMemoryHookRuntime = {
  recordTurnStart(command: CodexTurnStartCommand): Promise<MemoryHookTurnStartResult>;
  writeback(command: CodexWritebackCommand): Promise<CodexMemoryHookWritebackResult>;
  size(): number;
  close(): void;
};

const CODEX_MEMORY_TURN_CLIENT = "codex" as const;

export function createCodexMemoryHookRuntime(options: CodexMemoryHookRuntimeOptions = {}): CodexMemoryHookRuntime {
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
  const automaticRetrievalTurns = new Set<string>();
  const automaticRetrievalTurnLimit = positiveInteger(options.maxEntries, 256);

  return {
    async recordTurnStart(command) {
      const turn = turnStateFromCommand(command, now());
      if (!turn.transcriptPath) {
        options.diagnosticLogger?.("memory_hook.turn_start_skipped", {
          reason: "non_materialized_session",
          sessionId: turn.sessionId,
          turnId: turn.turnId,
        });
        return { ok: true };
      }
      await reconcilePreviousInterruptedTurn(turnCoordinator, turn, options, now);
      turnCoordinator.pruneExpired();
      const [repositoryMemory, sessionTurnIndex] = await Promise.all([
        resolveHookRepositoryMemory(turn, options, repositoryMemorySession),
        resolveSessionTurnIndex(turn, options.diagnosticLogger),
      ]);
      const repoMemoryWorktree = resolvedRepoMemoryWorktree(repositoryMemory);
      if (turn.turnId) {
        turnCoordinator.recordTurnStart({
          client: CODEX_MEMORY_TURN_CLIENT,
          sessionId: turn.sessionId,
          clientTurnId: turn.turnId,
          cwd: turn.cwd,
          workspaceKind: turn.workspaceKind,
          transcriptPath: turn.transcriptPath,
          createdAt: turn.createdAt,
          sessionTurnIndex,
          traceContext: turn.traceContext,
          repositoryMemory,
        });
      }
      options.diagnosticLogger?.("memory_hook.turn_start", {
        sessionId: turn.sessionId,
        turnId: turn.turnId,
        promptChars: turn.prompt.length,
        cacheSize: turnCoordinator.size(CODEX_MEMORY_TURN_CLIENT),
        workspace: repositoryMemory.ok ? repositoryMemory.memory.scope?.repositorySlug : undefined,
        workspaceScopeReason: repositoryMemory.ok ? undefined : repositoryMemory.reason,
        sessionTurnIndex,
      });
      await recordTraceBestEffort("memory_hook.turn_start_event", recordCodexTraceEvent({
        eventId: traceTurnEventId(turn.traceContext, "turn_start"),
        memoraxCodeHome: options.memoraxCodeHome,
        env: options.env,
        traceContext: turn.traceContext,
        type: "turn_start",
        source: "unknown",
        operation: "query",
        ok: true,
        sessionTurnIndex,
        request: {
          prompt: turn.prompt,
          cwd: turn.cwd,
          transcriptPath: turn.transcriptPath,
        },
      }), options.diagnosticLogger);
      await recordTraceBestEffort("memory_hook.current_turn_write", writeCurrentCodexTurn(turn.traceContext, {
        memoraxCodeHome: options.memoraxCodeHome,
        env: options.env,
        now: () => new Date(now()),
      }), options.diagnosticLogger);
      const processTurnStart = turn.turnId
        ? claimAutomaticRetrievalTurn(
          automaticRetrievalTurns,
          automaticRetrievalTurnLimit,
          turn.sessionId,
          turn.turnId,
        )
        : false;
      if (!processTurnStart) {
        return {
          ok: true,
          ...(repoMemoryWorktree ? { repoMemoryWorktree } : {}),
        };
      }
      const pendingUserNotice = repositoryMemory.ok
        ? await pendingQuotaNotice.claim(repositoryMemory.memory.config)
        : undefined;
      const retrieval = await retrieveAutomaticMemoryContext({
        diagnosticLogger: options.diagnosticLogger,
        claimQuotaNotice: options.claimQuotaNotice ?? claimQuotaNotice,
        env: options.env ?? process.env,
        fetchImpl: options.fetchImpl,
        memoryObservability: options.memoryObservability,
        memoryObservabilitySource: "codex_hook_retrieval",
        query: turn.prompt,
        repositoryMemory,
        sessionKey: turn.sessionId,
        traceContext: turn.traceContext,
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
      const request = writebackRequestFromCommand(command);
      if (!request.sessionId) return { ok: true, scheduled: false, reason: "missing_session_id" };
      if (!request.lastAssistantMessage) return { ok: true, scheduled: false, reason: "assistant_message_missing" };
      const coordinatorKey = request.turnId
        ? codexTurnKey(request.sessionId, request.turnId)
        : undefined;
      const entry = coordinatorKey ? turnCoordinator.getTurn(coordinatorKey) : undefined;
      const recoveredTraceContext = !entry
        ? await recoverExactCurrentTurnTraceContext(request, options)
        : undefined;
      const transcriptPath = request.transcriptPath
        ?? entry?.transcriptPath
        ?? recoveredTraceContext?.transcriptPath;
      if (!transcriptPath) {
        options.diagnosticLogger?.("memory_hook.writeback", {
          scheduled: false,
          reason: "non_materialized_session",
          sessionId: request.sessionId,
          turnId: request.turnId,
        });
        return { ok: true, scheduled: false, reason: "non_materialized_session" };
      }
      const traceContext = traceContextForWriteback(request, entry, recoveredTraceContext);
      if (!request.turnId) {
        await recordTurnEnd(options, traceContext, request.lastAssistantMessage);
        options.diagnosticLogger?.("memory_hook.writeback", {
          scheduled: false,
          reason: "turn_id_missing",
          sessionId: request.sessionId,
        });
        return { ok: true, scheduled: false, reason: "turn_id_missing" };
      }
      const sessionTurnIndex = entry?.sessionTurnIndex ?? await resolveSessionTurnIndex({
        sessionId: request.sessionId,
        turnId: request.turnId,
        transcriptPath,
      }, options.diagnosticLogger);
      const rollout = await readCodexRolloutTurn({
        transcriptPath,
        sessionId: request.sessionId,
        turnId: request.turnId,
      });
      await recordTurnEnd(
        options,
        traceContext,
        request.lastAssistantMessage,
        {
          rollout: rollout.ok ? rollout.turn : undefined,
          sessionTurnIndex,
        },
      );
      if (!rollout.ok) {
        options.diagnosticLogger?.("memory_hook.writeback", {
          scheduled: false,
          reason: rollout.reason,
          sessionId: request.sessionId,
          turnId: request.turnId,
          error: rollout.error,
        });
        return { ok: true, scheduled: false, reason: rollout.reason };
      }
      const writeback = await turnCoordinator.completeMaterializedTurn({
        key: codexTurnKey(request.sessionId, request.turnId),
        metadata: entry,
        resolveRepositoryMemory: () => resolveCurrentHookRepositoryMemory(
          entry,
          request,
          options,
          repositoryMemorySession,
          recoveredTraceContext,
        ),
        userText: rollout.turn.userPrompt,
        assistantText: rollout.turn.assistantReply,
        writeback: {
          client: CODEX_MEMORY_TURN_CLIENT,
          sessionKey: request.sessionId,
          env: options.env ?? process.env,
          fetchImpl: options.fetchImpl,
          memoryObservability: options.memoryObservability,
          memoryObservabilitySource: "codex_hook_writeback",
          traceContext,
        },
      });
      if (!writeback.scheduled) {
        options.diagnosticLogger?.("memory_hook.writeback", {
          scheduled: false,
          reason: writeback.reason,
          metadataDisposition: writeback.metadataDisposition,
          sessionId: request.sessionId,
          turnId: request.turnId,
        });
        return { ok: true, scheduled: false, reason: writeback.reason };
      }
      options.diagnosticLogger?.("memory_hook.writeback", {
        scheduled: true,
        metadataDisposition: writeback.metadataDisposition,
        sessionId: request.sessionId,
        turnId: request.turnId,
        promptChars: rollout.turn.userPrompt.length,
        assistantChars: rollout.turn.assistantReply.length,
        contentSource: "codex_rollout",
      });
      return { ok: true, scheduled: true };
    },
    size() {
      return turnCoordinator.size(CODEX_MEMORY_TURN_CLIENT);
    },
    close() {
      automaticRetrievalTurns.clear();
      if (ownsTurnCoordinator) turnCoordinator.close();
      if (ownsRepositoryMemorySession) repositoryMemorySession.close();
      automaticWritebackRuntime?.close?.();
      if (ownsPendingQuotaNotice) pendingQuotaNotice.close();
    },
  };
}

async function resolveSessionTurnIndex(input: {
  sessionId?: string;
  turnId?: string;
  transcriptPath?: string;
}, diagnosticLogger?: MemoryDiagnosticLogger): Promise<number | undefined> {
  if (!input.sessionId || !input.turnId || !input.transcriptPath) return undefined;
  const result = await readCodexSessionTurnIndex({
    transcriptPath: input.transcriptPath,
    sessionId: input.sessionId,
    turnId: input.turnId,
  });
  if (!result.ok) {
    diagnosticLogger?.("memory_hook.session_turn_index_unavailable", {
      sessionId: input.sessionId,
      turnId: input.turnId,
      reason: result.reason,
      error: result.error,
    });
    return undefined;
  }
  return result.sessionTurnIndex;
}

async function resolveHookRepositoryMemory(
  entry: Pick<CodexMemoryHookTurnStart, "sessionId" | "cwd" | "workspaceKind">,
  options: CodexMemoryHookRuntimeOptions,
  repositoryMemorySession: RepositoryMemorySessionRuntime,
  requireBoundScope = false,
): Promise<ConfiguredRepositoryMemoryResult> {
  const memoraxCodeHome = options.memoraxCodeHome ?? options.env?.MEMORAX_CODE_HOME;
  const registeredWorkspace = memoraxCodeHome
    ? resolveCodexWorkspaceRoot({
      sessionHome: memoraxCodeHome,
      sessionKey: entry.sessionId,
    })
    : undefined;
  const primary = await repositoryMemorySession.resolve({
    client: CODEX_MEMORY_TURN_CLIENT,
    sessionId: entry.sessionId,
    workspaceRoot: registeredWorkspace ?? entry.cwd,
    workspaceKind: entry.workspaceKind,
    requireBoundScope,
    memoraxCodeHome,
    env: options.env,
  });
  if (!primary.ok || !registeredWorkspace || !entry.cwd) return primary;
  return await repositoryMemorySession.resolve({
    client: CODEX_MEMORY_TURN_CLIENT,
    sessionId: entry.sessionId,
    workspaceRoot: entry.cwd,
    workspaceKind: entry.workspaceKind,
    requireBoundScope,
    memoraxCodeHome,
    env: options.env,
  });
}

async function resolveCurrentHookRepositoryMemory(
  entry: MemoryTurnState | undefined,
  request: CodexMemoryHookWritebackRequest,
  options: CodexMemoryHookRuntimeOptions,
  repositoryMemorySession: RepositoryMemorySessionRuntime,
  recoveredTraceContext?: TraceContext,
): Promise<ConfiguredRepositoryMemoryResult> {
  if (!entry) {
    if (!recoveredTraceContext) {
      return await resolveHookRepositoryMemory({
        sessionId: request.sessionId!,
        cwd: request.cwd,
        workspaceKind: request.workspaceKind,
      }, options, repositoryMemorySession, true);
    }
    const recovered = await resolveHookRepositoryMemory({
      sessionId: request.sessionId!,
      cwd: recoveredTraceContext.cwd,
      workspaceKind: recoveredTraceContext.workspaceKind,
    }, options, repositoryMemorySession);
    if (!recovered.ok || (!request.cwd && !request.workspaceKind)) return recovered;
    return await resolveHookRepositoryMemory({
      sessionId: request.sessionId!,
      cwd: request.cwd ?? recoveredTraceContext.cwd,
      workspaceKind: request.workspaceKind ?? recoveredTraceContext.workspaceKind,
    }, options, repositoryMemorySession);
  }
  return !request.cwd
    ? await repositoryMemorySession.resolve({
      client: CODEX_MEMORY_TURN_CLIENT,
      sessionId: entry.sessionId,
      workspaceKind: request.workspaceKind ?? entry.workspaceKind,
      memoraxCodeHome: options.memoraxCodeHome ?? options.env?.MEMORAX_CODE_HOME,
      env: options.env,
    })
    : await repositoryMemorySession.resolve({
      client: CODEX_MEMORY_TURN_CLIENT,
      sessionId: entry.sessionId,
      workspaceRoot: request.cwd,
      workspaceKind: request.workspaceKind ?? entry.workspaceKind,
      memoraxCodeHome: options.memoraxCodeHome ?? options.env?.MEMORAX_CODE_HOME,
      env: options.env,
    });
}

function turnStateFromCommand(
  command: CodexTurnStartCommand,
  createdAt: number,
): CodexMemoryHookTurnStart {
  return {
    sessionId: command.sessionId,
    turnId: command.turnId,
    prompt: command.prompt,
    cwd: command.cwd,
    workspaceKind: command.workspaceKind,
    transcriptPath: command.transcriptPath,
    createdAt,
    traceContext: traceContextFromHookBody(command, new Date(createdAt).toISOString()),
  };
}

function writebackRequestFromCommand(
  command: CodexWritebackCommand,
): CodexMemoryHookWritebackRequest {
  return {
    sessionId: command.sessionId,
    turnId: command.turnId,
    lastAssistantMessage: command.lastAssistantMessage,
    cwd: command.cwd,
    workspaceKind: command.workspaceKind,
    transcriptPath: command.transcriptPath,
    traceContext: traceContextFromHookBody({
      sessionId: command.sessionId,
      turnId: command.turnId,
      cwd: command.cwd,
      workspaceKind: command.workspaceKind,
      transcriptPath: command.transcriptPath,
    }),
  };
}

async function recordTurnEnd(
  options: CodexMemoryHookRuntimeOptions,
  traceContext: TraceContext | undefined,
  assistantMessage: string,
  details: {
    rollout?: Pick<CodexRolloutTurn, "userPrompt" | "assistantReply" | "activities" | "usage">;
    sessionTurnIndex?: number;
    outcome?: CodexTurnOutcome;
    occurredAt?: string;
  } = {},
): Promise<void> {
  const outcome = details.outcome ?? "completed";
  const eventId = traceTurnEventId(traceContext, "turn_end");
  const recorded = await recordTraceBestEffort("memory_hook.turn_end_event", recordCodexTraceEvent({
    eventId,
    memoraxCodeHome: options.memoraxCodeHome,
    env: options.env,
    traceContext,
    type: "turn_end",
    source: "codex-hook",
    operation: "reply",
    ok: true,
    outcome,
    activities: details.rollout?.activities,
    usage: details.rollout?.usage,
    sessionTurnIndex: details.sessionTurnIndex,
    response: {
      assistantMessage,
    },
    ...(details.occurredAt ? { now: () => new Date(details.occurredAt as string) } : {}),
  }), options.diagnosticLogger);
  if (!recorded || (!recorded.written && recorded.reason !== "duplicate_event")) return;
  if (!recorded.written && details.rollout && eventId) {
    await recordTraceBestEffort("memory_hook.turn_materialized_event", recordCodexTraceEvent({
      eventId: traceTurnEventId(traceContext, "turn_materialized"),
      memoraxCodeHome: options.memoraxCodeHome,
      env: options.env,
      traceContext,
      type: "turn_materialized",
      source: "codex-rollout",
      operation: "reply",
      ok: true,
      outcome,
      activities: details.rollout.activities,
      usage: details.rollout.usage,
      sessionTurnIndex: details.sessionTurnIndex,
      request: {
        original_event_id: eventId,
        prompt: details.rollout.userPrompt,
      },
      response: {
        assistantMessage: details.rollout.assistantReply,
      },
      ...(details.occurredAt ? { now: () => new Date(details.occurredAt as string) } : {}),
    }), options.diagnosticLogger);
  }
  await recordTraceBestEffort("memory_hook.current_turn_close", markCurrentCodexTurnOutcome(
    traceContext,
    outcome,
    {
      memoraxCodeHome: options.memoraxCodeHome,
      env: options.env,
    },
  ), options.diagnosticLogger);
}

async function reconcilePreviousInterruptedTurn(
  turnCoordinator: MemoryTurnCoordinator,
  currentTurn: CodexMemoryHookTurnStart,
  options: CodexMemoryHookRuntimeOptions,
  now: () => number,
): Promise<void> {
  if (!currentTurn.turnId || !currentTurn.transcriptPath) return;
  const candidate = await previousTurnCandidate(turnCoordinator, currentTurn, options, now);
  if (!candidate) return;
  const rollout = await readCodexInterruptedRolloutTurn({
    transcriptPath: candidate.transcriptPath,
    sessionId: candidate.sessionId,
    turnId: candidate.turnId,
  });
  if (!rollout.ok) {
    if (rollout.reason === "turn_rolled_back") {
      turnCoordinator.discardTurn(
        codexTurnKey(candidate.sessionId, candidate.turnId),
        "rolled_back",
      );
      options.diagnosticLogger?.("memory_hook.interrupted_turn_skipped", {
        reason: rollout.reason,
        sessionId: candidate.sessionId,
        turnId: candidate.turnId,
      });
    }
    return;
  }
  await recordTurnEnd(options, candidate.traceContext, rollout.turn.assistantReply, {
    rollout: rollout.turn,
    sessionTurnIndex: candidate.sessionTurnIndex ?? rollout.turn.sessionTurnIndex,
    outcome: "interrupted",
    occurredAt: rollout.turn.interruptedAt,
  });
  turnCoordinator.discardTurn(
    codexTurnKey(candidate.sessionId, candidate.turnId),
    "interrupted",
  );
  options.diagnosticLogger?.("memory_hook.interrupted_turn_reconciled", {
    sessionId: candidate.sessionId,
    turnId: candidate.turnId,
    assistantChars: rollout.turn.assistantReply.length,
    activityCount: rollout.turn.activities.length,
    sessionTurnIndex: candidate.sessionTurnIndex ?? rollout.turn.sessionTurnIndex,
  });
}

type InterruptedTurnCandidate = Readonly<{
  sessionId: string;
  turnId: string;
  transcriptPath: string;
  sessionTurnIndex?: number;
  traceContext: TraceContext;
}>;

async function previousTurnCandidate(
  turnCoordinator: MemoryTurnCoordinator,
  currentTurn: CodexMemoryHookTurnStart,
  options: CodexMemoryHookRuntimeOptions,
  now: () => number,
): Promise<InterruptedTurnCandidate | undefined> {
  const currentTurnId = currentTurn.turnId;
  const currentTranscriptPath = currentTurn.transcriptPath;
  if (!currentTurnId || !currentTranscriptPath) return undefined;
  const current = await readOpenCodexTurn({
    memoraxCodeHome: options.memoraxCodeHome,
    env: options.env,
    expectedSessionId: currentTurn.sessionId,
    allowStale: true,
    now: () => new Date(now()),
  });
  if (!current.ok && current.reason === "closed") return undefined;
  if (current.ok && current.traceContext.turnId && current.traceContext.turnId !== currentTurnId) {
    const cached = turnCoordinator.getTurn(codexTurnKey(currentTurn.sessionId, current.traceContext.turnId));
    return {
      sessionId: currentTurn.sessionId,
      turnId: current.traceContext.turnId,
      transcriptPath: cached?.transcriptPath
        ?? current.traceContext.transcriptPath
        ?? currentTranscriptPath,
      sessionTurnIndex: cached?.sessionTurnIndex,
      traceContext: cached?.traceContext ?? current.traceContext,
    };
  }
  const cached = turnCoordinator.latestTurn({
    client: CODEX_MEMORY_TURN_CLIENT,
    sessionId: currentTurn.sessionId,
    excludeClientTurnId: currentTurnId,
  });
  if (!cached) return undefined;
  const traceContext = cached.traceContext ?? traceContextFromHookBody({
    sessionId: cached.sessionId,
    turnId: cached.clientTurnId,
    cwd: cached.cwd,
    workspaceKind: cached.workspaceKind,
    transcriptPath: cached.transcriptPath ?? currentTranscriptPath,
  }, new Date(cached.createdAt).toISOString());
  if (!traceContext) return undefined;
  return {
    sessionId: cached.sessionId,
    turnId: cached.clientTurnId,
    transcriptPath: cached.transcriptPath ?? currentTranscriptPath,
    sessionTurnIndex: cached.sessionTurnIndex,
    traceContext,
  };
}

function traceContextForWriteback(
  request: CodexMemoryHookWritebackRequest,
  entry: MemoryTurnState | undefined,
  recoveredTraceContext?: TraceContext,
): TraceContext | undefined {
  const authoritativeTraceContext = entry?.traceContext ?? recoveredTraceContext;
  if (!authoritativeTraceContext) return request.traceContext;
  if (!request.traceContext) return authoritativeTraceContext;
  return {
    ...authoritativeTraceContext,
    ...request.traceContext,
    transcriptPath: request.traceContext.transcriptPath ?? authoritativeTraceContext.transcriptPath,
    cwd: request.traceContext.cwd ?? authoritativeTraceContext.cwd,
    workspaceKind: request.traceContext.workspaceKind ?? authoritativeTraceContext.workspaceKind,
  };
}

async function recoverExactCurrentTurnTraceContext(
  request: CodexMemoryHookWritebackRequest,
  options: CodexMemoryHookRuntimeOptions,
): Promise<TraceContext | undefined> {
  if (!request.sessionId || !request.turnId) return undefined;
  const current = await readCurrentCodexTurn({
    memoraxCodeHome: options.memoraxCodeHome,
    env: options.env,
    expectedSessionId: request.sessionId,
    allowStale: true,
  });
  if (!current.ok || current.traceContext.turnId !== request.turnId) return undefined;
  if (
    request.transcriptPath
    && current.traceContext.transcriptPath !== request.transcriptPath
  ) return undefined;
  return current.traceContext;
}

function codexTurnKey(sessionId: string, turnId: string) {
  return {
    client: CODEX_MEMORY_TURN_CLIENT,
    sessionId,
    clientTurnId: turnId,
  };
}

function claimAutomaticRetrievalTurn(
  turns: Set<string>,
  limit: number,
  sessionId: string,
  turnId: string,
): boolean {
  const key = JSON.stringify([sessionId, turnId]);
  if (turns.has(key)) return false;
  turns.add(key);
  while (turns.size > limit) {
    const oldest = turns.values().next().value;
    if (typeof oldest !== "string") break;
    turns.delete(oldest);
  }
  return true;
}

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function recordTraceBestEffort<T>(
  label: string,
  promise: Promise<T>,
  diagnosticLogger?: MemoryDiagnosticLogger,
): Promise<T | undefined> {
  try {
    return await promise;
  } catch (error) {
    diagnosticLogger?.("codex_trace.write_failed", {
      label,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}
