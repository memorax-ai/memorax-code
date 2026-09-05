import {
  readCodexInterruptedRolloutTurn,
  readCodexRolloutTurn,
  type CodexRolloutTurn,
  type CodexRolloutTurnFailureReason,
} from "./rollout-turn.js";
import type { AutomaticMemoryWritebackRejectionReason } from "../../memory/automatic-writeback.js";
import {
  createHarnessMemoryRuntime,
  type HarnessMemoryRuntime,
  type HarnessMemoryRuntimeOptions,
} from "../../memory/harness-runtime.js";
import { readCodexSessionTurnIndex } from "./session-turn-index.js";
import { resolveCodexWorkspaceRoot } from "./workspace-links.js";
import type {
  MemoryHookTurnStartResult,
  CodexTurnStartCommand,
  CodexWritebackCommand,
} from "../../memory/hook-command.js";
import type { MemoryDiagnosticLogger } from "../../memory/observability.js";
import type {
  MemoryTurnCoordinator,
  MemoryTurnState,
} from "../../memory/turn-coordinator.js";
import type { ConfiguredRepositoryMemoryResult } from "../../memory/repository-session.js";
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

export type CodexMemoryHookRuntimeOptions = HarnessMemoryRuntimeOptions;

export type CodexMemoryHookRuntime = {
  recordTurnStart(command: CodexTurnStartCommand): Promise<MemoryHookTurnStartResult>;
  writeback(command: CodexWritebackCommand): Promise<CodexMemoryHookWritebackResult>;
  size(): number;
  close(): void;
};

const CODEX_MEMORY_TURN_CLIENT = "codex" as const;

export function createCodexMemoryHookRuntime(options: CodexMemoryHookRuntimeOptions = {}): CodexMemoryHookRuntime {
  const now = options.now ?? (() => Date.now());
  const memory = createHarnessMemoryRuntime({
    client: CODEX_MEMORY_TURN_CLIENT,
    retrievalSource: "codex_hook_retrieval",
    writebackSource: "codex_hook_writeback",
    diagnosticPrefix: "memory_hook",
    traceFailureEvent: "codex_trace.write_failed",
    deduplicateRetrieval: true,
  }, options);
  const { turnCoordinator } = memory;

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
        resolveHookRepositoryMemory(turn, options, memory),
        resolveSessionTurnIndex(turn, options.diagnosticLogger),
      ]);
      return await memory.recordTurnStart({
        sessionId: turn.sessionId,
        clientTurnId: turn.turnId,
        cwd: turn.cwd,
        workspaceKind: turn.workspaceKind,
        transcriptPath: turn.transcriptPath,
        createdAt: turn.createdAt,
        sessionTurnIndex,
        traceContext: turn.traceContext,
        prompt: turn.prompt,
        repositoryMemory,
        diagnosticFields: {
          sessionId: turn.sessionId,
          turnId: turn.turnId,
          promptChars: turn.prompt.length,
          sessionTurnIndex,
        },
      });
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
      const writeback = await memory.completeTurn({
        sessionId: request.sessionId,
        clientTurnId: request.turnId,
        metadata: entry,
        resolveRepositoryMemory: () => resolveCurrentHookRepositoryMemory(
          entry,
          request,
          options,
          memory,
          recoveredTraceContext,
        ),
        userText: rollout.turn.userPrompt,
        assistantText: rollout.turn.assistantReply,
        traceContext,
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
      return memory.size();
    },
    close() {
      memory.close();
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
  memory: HarnessMemoryRuntime,
  requireBoundScope = false,
): Promise<ConfiguredRepositoryMemoryResult> {
  const memoraxCodeHome = options.memoraxCodeHome ?? options.env?.MEMORAX_CODE_HOME;
  const registeredWorkspace = memoraxCodeHome
    ? resolveCodexWorkspaceRoot({
      sessionHome: memoraxCodeHome,
      sessionKey: entry.sessionId,
    })
    : undefined;
  const primary = await memory.resolveRepositoryMemory({
    sessionId: entry.sessionId,
    cwd: registeredWorkspace ?? entry.cwd,
    workspaceKind: entry.workspaceKind,
    requireBoundScope,
  });
  if (!primary.ok || !registeredWorkspace || !entry.cwd) return primary;
  return await memory.resolveRepositoryMemory({
    sessionId: entry.sessionId,
    cwd: entry.cwd,
    workspaceKind: entry.workspaceKind,
    requireBoundScope,
  });
}

async function resolveCurrentHookRepositoryMemory(
  entry: MemoryTurnState | undefined,
  request: CodexMemoryHookWritebackRequest,
  options: CodexMemoryHookRuntimeOptions,
  memory: HarnessMemoryRuntime,
  recoveredTraceContext?: TraceContext,
): Promise<ConfiguredRepositoryMemoryResult> {
  if (!entry) {
    if (!recoveredTraceContext) {
      return await resolveHookRepositoryMemory({
        sessionId: request.sessionId!,
        cwd: request.cwd,
        workspaceKind: request.workspaceKind,
      }, options, memory, true);
    }
    const recovered = await resolveHookRepositoryMemory({
      sessionId: request.sessionId!,
      cwd: recoveredTraceContext.cwd,
      workspaceKind: recoveredTraceContext.workspaceKind,
    }, options, memory);
    if (!recovered.ok || (!request.cwd && !request.workspaceKind)) return recovered;
    return await resolveHookRepositoryMemory({
      sessionId: request.sessionId!,
      cwd: request.cwd ?? recoveredTraceContext.cwd,
      workspaceKind: request.workspaceKind ?? recoveredTraceContext.workspaceKind,
    }, options, memory);
  }
  return !request.cwd
    ? await memory.resolveRepositoryMemory({
      sessionId: entry.sessionId,
      workspaceKind: request.workspaceKind ?? entry.workspaceKind,
    })
    : await memory.resolveRepositoryMemory({
      sessionId: entry.sessionId,
      cwd: request.cwd,
      workspaceKind: request.workspaceKind ?? entry.workspaceKind,
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
