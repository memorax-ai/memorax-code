import {
  readClaudeInterruptedTranscriptTurn,
  readClaudeTranscriptTurn,
  type ClaudeInterruptedTranscriptTurn,
  type ClaudeTranscriptTurn,
  type ClaudeTranscriptTurnFailureReason,
  type ClaudeTranscriptTurnResult,
} from "./transcript-turn.js";
import { retrieveAutomaticMemoryContext } from "../../memory/automatic-retrieval.js";
import {
  claimQuotaNotice,
  createPendingQuotaNoticeRuntime,
  type PendingQuotaNoticeRuntime,
  type QuotaNoticeClaimer,
} from "../../memory/quota-notice.js";
import {
  createAutomaticMemoryWritebackRuntime,
  type AutomaticMemoryWritebackEnqueue,
  type AutomaticMemoryWritebackRejectionReason,
  type AutomaticMemoryWritebackRuntime,
} from "../../memory/automatic-writeback.js";
import type {
  ClaudeTurnStartCommand,
  ClaudeWritebackCommand,
  MemoryHookTurnStartResult,
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
import type { RepositoryMemoryScopeFailureReason } from "../../repository/scope.js";
import { traceContextFromClaudeHookBody, type TraceContext } from "../../trace/context.js";
import {
  markCurrentClaudeTurnOutcome,
  readOpenClaudeTurn,
  recordClaudeTraceEvent,
  traceTurnEventId,
  writeCurrentClaudeTurn,
  type TraceEventWriteResult,
} from "../../trace/store.js";

type ClaudeMemoryHookTurnStart = Omit<ClaudeTurnStartCommand, "version" | "client"> & {
  createdAt: number;
  traceContext?: TraceContext;
};

type ClaudeMemoryHookWritebackRequest = Omit<ClaudeWritebackCommand, "version" | "client"> & {
  traceContext?: TraceContext;
};

type ClaudeMemoryHookWritebackSkipReason =
  | "missing_session_id"
  | "prompt_id_missing"
  | "non_materialized_session"
  | "turn_metadata_mismatch"
  | "config_missing"
  | ClaudeTranscriptTurnFailureReason
  | RepositoryMemoryScopeFailureReason
  | AutomaticMemoryWritebackRejectionReason;

export type ClaudeMemoryHookWritebackResult =
  | { ok: true; scheduled: true }
  | { ok: true; scheduled: false; reason: ClaudeMemoryHookWritebackSkipReason };

export type ClaudeMemoryHookRuntimeOptions = {
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
  transcriptReadAttempts?: number;
  transcriptRetryDelayMs?: number;
};

export type ClaudeMemoryHookRuntime = {
  recordTurnStart(command: ClaudeTurnStartCommand): Promise<MemoryHookTurnStartResult>;
  writeback(command: ClaudeWritebackCommand): Promise<ClaudeMemoryHookWritebackResult>;
  size(): number;
  close(): void;
};

const CLAUDE_MEMORY_TURN_CLIENT = "claude-code" as const;
const DEFAULT_TRANSCRIPT_READ_ATTEMPTS = 6;
const DEFAULT_TRANSCRIPT_RETRY_DELAY_MS = 100;

export function createClaudeMemoryHookRuntime(
  options: ClaudeMemoryHookRuntimeOptions = {},
): ClaudeMemoryHookRuntime {
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
  const automaticRetrievalPrompts = new Set<string>();
  const automaticRetrievalPromptLimit = positiveInteger(options.maxEntries, 256);

  return {
    async recordTurnStart(command) {
      const turn = turnStartFromCommand(command, now());
      if (!turn.sessionId || !turn.promptId || !turn.transcriptPath) {
        options.diagnosticLogger?.("claude_memory_hook.turn_start_skipped", {
          reason: !turn.sessionId
            ? "missing_session_id"
            : !turn.promptId
              ? "prompt_id_missing"
              : "non_materialized_session",
          sessionId: turn.sessionId,
          promptId: turn.promptId,
        });
        return { ok: true };
      }
      await reconcilePreviousInterruptedTurn(turnCoordinator, turn, options, now);
      turnCoordinator.pruneExpired();
      const repositoryMemory = await resolveHookRepositoryMemory(turn, options, repositoryMemorySession);
      const repoMemoryWorktree = resolvedRepoMemoryWorktree(repositoryMemory);
      turnCoordinator.recordTurnStart({
        client: CLAUDE_MEMORY_TURN_CLIENT,
        sessionId: turn.sessionId,
        clientTurnId: turn.promptId,
        cwd: turn.cwd,
        workspaceKind: turn.workspaceKind,
        transcriptPath: turn.transcriptPath,
        createdAt: turn.createdAt,
        traceContext: turn.traceContext,
        repositoryMemory,
      });
      options.diagnosticLogger?.("claude_memory_hook.turn_start", {
        sessionId: turn.sessionId,
        promptId: turn.promptId,
        cacheSize: turnCoordinator.size(CLAUDE_MEMORY_TURN_CLIENT),
        workspace: repositoryMemory.ok ? repositoryMemory.memory.scope?.repositorySlug : undefined,
        workspaceScopeReason: repositoryMemory.ok ? undefined : repositoryMemory.reason,
      });
      await recordTraceBestEffort("claude_memory_hook.turn_start_event", recordClaudeTraceEvent({
        eventId: traceTurnEventId(turn.traceContext, "turn_start"),
        memoraxCodeHome: options.memoraxCodeHome,
        env: options.env,
        traceContext: turn.traceContext,
        type: "turn_start",
        source: "unknown",
        operation: "query",
        ok: true,
        request: {
          prompt: turn.prompt,
          cwd: turn.cwd,
          transcriptPath: turn.transcriptPath,
        },
      }), options.diagnosticLogger);
      await recordTraceBestEffort("claude_memory_hook.current_turn_write", writeCurrentClaudeTurn(
        turn.traceContext,
        {
          memoraxCodeHome: options.memoraxCodeHome,
          env: options.env,
          now: () => new Date(now()),
        },
      ), options.diagnosticLogger);
      const processTurnStart = claimAutomaticRetrievalPrompt(
        automaticRetrievalPrompts,
        automaticRetrievalPromptLimit,
        turn.sessionId,
        turn.promptId,
      );
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
        memoryObservabilitySource: "claude_hook_retrieval",
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
      if (!request.sessionId) return skipped("missing_session_id");
      if (!request.lastAssistantMessage) return skipped("assistant_message_missing");
      const coordinatorKey = request.promptId
        ? claudeTurnKey(request.sessionId, request.promptId)
        : undefined;
      const entry = coordinatorKey ? turnCoordinator.getTurn(coordinatorKey) : undefined;
      const transcriptPath = request.transcriptPath ?? entry?.transcriptPath;
      if (!transcriptPath) return skipped("non_materialized_session");
      const traceContext = traceContextForWriteback(request, entry);
      if (!request.promptId) {
        await recordClaudeTurnEnd(options, traceContext, request.lastAssistantMessage);
        return skipped("prompt_id_missing");
      }

      const transcript = await readExactTranscriptTurnWithRetry({
        transcriptPath,
        sessionId: request.sessionId,
        promptId: request.promptId,
      }, options);
      const turnEndRecord = await recordClaudeTurnEnd(
        options,
        traceContext,
        request.lastAssistantMessage,
        transcript.ok ? transcript.turn : undefined,
      );
      if (!transcript.ok) {
        options.diagnosticLogger?.("claude_memory_hook.writeback", {
          scheduled: false,
          reason: transcript.reason,
          sessionId: request.sessionId,
          promptId: request.promptId,
          error: transcript.error,
        });
        return skipped(transcript.reason);
      }
      if (turnEndRecord && !turnEndRecord.written && turnEndRecord.reason === "duplicate_event") {
        await recordClaudeTurnMaterialization(options, traceContext, transcript.turn);
      }
      recordAssistantConsistencyDiagnostic(
        transcript.turn.assistantReply,
        request.lastAssistantMessage,
        request,
        options.diagnosticLogger,
      );
      const writeback = await turnCoordinator.completeMaterializedTurn({
        key: claudeTurnKey(request.sessionId, request.promptId),
        metadata: entry,
        resolveRepositoryMemory: () => resolveCurrentHookRepositoryMemory(
          entry,
          request,
          options,
          repositoryMemorySession,
        ),
        userText: transcript.turn.userPrompt,
        assistantText: transcript.turn.assistantReply,
        writeback: {
          client: CLAUDE_MEMORY_TURN_CLIENT,
          sessionKey: request.sessionId,
          env: options.env ?? process.env,
          fetchImpl: options.fetchImpl,
          memoryObservability: options.memoryObservability,
          memoryObservabilitySource: "claude_hook_writeback",
          traceContext,
        },
      });
      if (!writeback.scheduled) {
        options.diagnosticLogger?.("claude_memory_hook.writeback", {
          scheduled: false,
          reason: writeback.reason,
          metadataDisposition: writeback.metadataDisposition,
          sessionId: request.sessionId,
          promptId: request.promptId,
        });
        return skipped(writeback.reason);
      }
      options.diagnosticLogger?.("claude_memory_hook.writeback", {
        scheduled: true,
        metadataDisposition: writeback.metadataDisposition,
        sessionId: request.sessionId,
        promptId: request.promptId,
        promptChars: transcript.turn.userPrompt.length,
        assistantChars: transcript.turn.assistantReply.length,
        contentSource: "claude_transcript",
      });
      return { ok: true, scheduled: true };
    },
    size() {
      return turnCoordinator.size(CLAUDE_MEMORY_TURN_CLIENT);
    },
    close() {
      automaticRetrievalPrompts.clear();
      if (ownsTurnCoordinator) turnCoordinator.close();
      if (ownsRepositoryMemorySession) repositoryMemorySession.close();
      automaticWritebackRuntime?.close?.();
      if (ownsPendingQuotaNotice) pendingQuotaNotice.close();
    },
  };
}

async function readExactTranscriptTurnWithRetry(
  input: { transcriptPath: string; sessionId: string; promptId: string },
  options: ClaudeMemoryHookRuntimeOptions,
): Promise<ClaudeTranscriptTurnResult> {
  const attempts = positiveInteger(options.transcriptReadAttempts, DEFAULT_TRANSCRIPT_READ_ATTEMPTS);
  const retryDelayMs = nonNegativeInteger(options.transcriptRetryDelayMs, DEFAULT_TRANSCRIPT_RETRY_DELAY_MS);
  let result: ClaudeTranscriptTurnResult = { ok: false, reason: "turn_not_found" };
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    result = await readClaudeTranscriptTurn(input);
    if (result.ok || !transientTranscriptFailure(result.reason) || attempt === attempts) return result;
    await new Promise<void>((resolve) => setTimeout(resolve, retryDelayMs));
  }
  return result;
}

function transientTranscriptFailure(reason: ClaudeTranscriptTurnFailureReason): boolean {
  return reason === "transcript_unavailable"
    || reason === "turn_not_found"
    || reason === "user_prompt_missing"
    || reason === "assistant_message_missing";
}

async function resolveHookRepositoryMemory(
  entry: Pick<ClaudeMemoryHookTurnStart, "sessionId" | "cwd" | "workspaceKind">,
  options: ClaudeMemoryHookRuntimeOptions,
  repositoryMemorySession: RepositoryMemorySessionRuntime,
): Promise<ConfiguredRepositoryMemoryResult> {
  return await repositoryMemorySession.resolve({
    client: CLAUDE_MEMORY_TURN_CLIENT,
    sessionId: entry.sessionId,
    workspaceRoot: entry.cwd,
    workspaceKind: entry.workspaceKind,
    memoraxCodeHome: options.memoraxCodeHome ?? options.env?.MEMORAX_CODE_HOME,
    env: options.env,
  });
}

async function resolveCurrentHookRepositoryMemory(
  entry: MemoryTurnState | undefined,
  request: ClaudeMemoryHookWritebackRequest,
  options: ClaudeMemoryHookRuntimeOptions,
  repositoryMemorySession: RepositoryMemorySessionRuntime,
): Promise<ConfiguredRepositoryMemoryResult> {
  return await repositoryMemorySession.resolve({
    client: CLAUDE_MEMORY_TURN_CLIENT,
    sessionId: request.sessionId,
    workspaceRoot: request.cwd ?? entry?.cwd,
    workspaceKind: request.workspaceKind ?? entry?.workspaceKind,
    memoraxCodeHome: options.memoraxCodeHome ?? options.env?.MEMORAX_CODE_HOME,
    env: options.env,
  });
}

function turnStartFromCommand(
  command: ClaudeTurnStartCommand,
  createdAt: number,
): ClaudeMemoryHookTurnStart {
  return {
    sessionId: command.sessionId,
    promptId: command.promptId,
    cwd: command.cwd,
    workspaceKind: command.workspaceKind,
    transcriptPath: command.transcriptPath,
    prompt: command.prompt,
    createdAt,
    traceContext: traceContextFromClaudeHookBody(command, new Date(createdAt).toISOString()),
  };
}

function writebackRequestFromCommand(
  command: ClaudeWritebackCommand,
): ClaudeMemoryHookWritebackRequest {
  return {
    sessionId: command.sessionId,
    promptId: command.promptId,
    lastAssistantMessage: command.lastAssistantMessage,
    cwd: command.cwd,
    workspaceKind: command.workspaceKind,
    transcriptPath: command.transcriptPath,
    traceContext: traceContextFromClaudeHookBody(command),
  };
}

async function recordClaudeTurnEnd(
  options: ClaudeMemoryHookRuntimeOptions,
  traceContext: TraceContext | undefined,
  assistantMessage: string,
  transcript?: ClaudeTranscriptTurn,
): Promise<TraceEventWriteResult | undefined> {
  const eventId = traceTurnEventId(traceContext, "turn_end");
  const recorded = await recordTraceBestEffort("claude_memory_hook.turn_end_event", recordClaudeTraceEvent({
    eventId,
    memoraxCodeHome: options.memoraxCodeHome,
    env: options.env,
    traceContext,
    type: "turn_end",
    source: "claude-hook",
    operation: "reply",
    ok: true,
    outcome: "completed",
    activities: transcript?.activities,
    usage: transcript?.usage,
    sessionTurnIndex: transcript?.sessionTurnIndex,
    response: {
      assistantMessage,
    },
  }), options.diagnosticLogger);
  if (!recorded || (!recorded.written && recorded.reason !== "duplicate_event")) return recorded;
  await recordTraceBestEffort("claude_memory_hook.current_turn_close", markCurrentClaudeTurnOutcome(
    traceContext,
    "completed",
    {
      memoraxCodeHome: options.memoraxCodeHome,
      env: options.env,
    },
  ), options.diagnosticLogger);
  return recorded;
}

async function recordClaudeTurnMaterialization(
  options: ClaudeMemoryHookRuntimeOptions,
  traceContext: TraceContext | undefined,
  turn: ClaudeTranscriptTurn,
): Promise<void> {
  const originalEventId = traceTurnEventId(traceContext, "turn_end");
  if (!originalEventId) return;
  await recordTraceBestEffort("claude_memory_hook.turn_materialized_event", recordClaudeTraceEvent({
    eventId: traceTurnEventId(traceContext, "turn_materialized"),
    memoraxCodeHome: options.memoraxCodeHome,
    env: options.env,
    traceContext,
    type: "turn_materialized",
    source: "claude-transcript",
    operation: "reply",
    ok: true,
    outcome: "completed",
    activities: turn.activities,
    usage: turn.usage,
    sessionTurnIndex: turn.sessionTurnIndex,
    request: {
      original_event_id: originalEventId,
      prompt: turn.userPrompt,
    },
    response: {
      assistantMessage: turn.assistantReply,
    },
  }), options.diagnosticLogger);
}

async function reconcilePreviousInterruptedTurn(
  turnCoordinator: MemoryTurnCoordinator,
  currentTurn: ClaudeMemoryHookTurnStart,
  options: ClaudeMemoryHookRuntimeOptions,
  now: () => number,
): Promise<void> {
  const candidate = await previousInterruptedTurnCandidate(
    turnCoordinator,
    currentTurn,
    options,
    now,
  );
  if (!candidate) return;
  const transcript = await readClaudeInterruptedTranscriptTurn({
    transcriptPath: candidate.transcriptPath,
    sessionId: candidate.sessionId,
    promptId: candidate.promptId,
  });
  if (!transcript.ok) return;
  await recordClaudeInterruptedTurnEnd(options, candidate.traceContext, transcript.turn);
  turnCoordinator.discardTurn(
    claudeTurnKey(candidate.sessionId, candidate.promptId),
    "interrupted",
  );
  options.diagnosticLogger?.("claude_memory_hook.interrupted_turn_reconciled", {
    sessionId: candidate.sessionId,
    promptId: candidate.promptId,
    assistantChars: transcript.turn.assistantReply.length,
    activityCount: transcript.turn.activities.length,
    sessionTurnIndex: transcript.turn.sessionTurnIndex,
  });
}

type ClaudeInterruptedTurnCandidate = Readonly<{
  sessionId: string;
  promptId: string;
  transcriptPath: string;
  traceContext: TraceContext;
}>;

async function previousInterruptedTurnCandidate(
  turnCoordinator: MemoryTurnCoordinator,
  currentTurn: ClaudeMemoryHookTurnStart,
  options: ClaudeMemoryHookRuntimeOptions,
  now: () => number,
): Promise<ClaudeInterruptedTurnCandidate | undefined> {
  if (!currentTurn.sessionId || !currentTurn.promptId || !currentTurn.transcriptPath) return undefined;
  const open = await readOpenClaudeTurn({
    memoraxCodeHome: options.memoraxCodeHome,
    env: options.env,
    expectedSessionId: currentTurn.sessionId,
    allowStale: true,
    now: () => new Date(now()),
  });
  if (!open.ok && open.reason === "closed") return undefined;
  if (open.ok && open.traceContext.turnId && open.traceContext.turnId !== currentTurn.promptId) {
    const promptId = open.traceContext.turnId;
    const cached = turnCoordinator.getTurn(claudeTurnKey(currentTurn.sessionId, promptId));
    return {
      sessionId: currentTurn.sessionId,
      promptId,
      transcriptPath: cached?.transcriptPath
        ?? open.traceContext.transcriptPath
        ?? currentTurn.transcriptPath,
      traceContext: cached?.traceContext ?? open.traceContext,
    };
  }
  const cached = turnCoordinator.latestTurn({
    client: CLAUDE_MEMORY_TURN_CLIENT,
    sessionId: currentTurn.sessionId,
    excludeClientTurnId: currentTurn.promptId,
  });
  if (!cached) return undefined;
  const transcriptPath = cached.transcriptPath ?? currentTurn.transcriptPath;
  const traceContext = cached.traceContext ?? traceContextFromClaudeHookBody({
    sessionId: cached.sessionId,
    promptId: cached.clientTurnId,
    cwd: cached.cwd,
    workspaceKind: cached.workspaceKind,
    transcriptPath,
  }, new Date(cached.createdAt).toISOString());
  if (!traceContext) return undefined;
  return {
    sessionId: cached.sessionId,
    promptId: cached.clientTurnId,
    transcriptPath,
    traceContext,
  };
}

async function recordClaudeInterruptedTurnEnd(
  options: ClaudeMemoryHookRuntimeOptions,
  traceContext: TraceContext,
  turn: ClaudeInterruptedTranscriptTurn,
): Promise<void> {
  const recorded = await recordTraceBestEffort(
    "claude_memory_hook.interrupted_turn_end_event",
    recordClaudeTraceEvent({
      eventId: traceTurnEventId(traceContext, "turn_end"),
      memoraxCodeHome: options.memoraxCodeHome,
      env: options.env,
      traceContext,
      type: "turn_end",
      source: "claude-transcript",
      operation: "reply",
      ok: true,
      outcome: "interrupted",
      activities: turn.activities,
      usage: turn.usage,
      sessionTurnIndex: turn.sessionTurnIndex,
      request: {
        prompt: turn.userPrompt,
      },
      response: {
        assistantMessage: turn.assistantReply,
      },
      ...(turn.interruptedAt ? { now: () => new Date(turn.interruptedAt as string) } : {}),
    }),
    options.diagnosticLogger,
  );
  if (!recorded || (!recorded.written && recorded.reason !== "duplicate_event")) return;
  await recordTraceBestEffort(
    "claude_memory_hook.interrupted_current_turn_close",
    markCurrentClaudeTurnOutcome(traceContext, "interrupted", {
      memoraxCodeHome: options.memoraxCodeHome,
      env: options.env,
    }),
    options.diagnosticLogger,
  );
}

function recordAssistantConsistencyDiagnostic(
  transcriptText: string,
  hookText: string,
  request: ClaudeMemoryHookWritebackRequest,
  diagnosticLogger?: MemoryDiagnosticLogger,
): void {
  if (transcriptText.trim() === hookText.trim()) return;
  diagnosticLogger?.("claude_memory_hook.assistant_message_mismatch", {
    sessionId: request.sessionId,
    promptId: request.promptId,
    transcriptChars: transcriptText.length,
    hookChars: hookText.length,
  });
}

function claudeTurnKey(sessionId: string, promptId: string) {
  return {
    client: CLAUDE_MEMORY_TURN_CLIENT,
    sessionId,
    clientTurnId: promptId,
  } as const;
}

function claimAutomaticRetrievalPrompt(
  prompts: Set<string>,
  limit: number,
  sessionId: string,
  promptId: string,
): boolean {
  const key = JSON.stringify([sessionId, promptId]);
  if (prompts.has(key)) return false;
  prompts.add(key);
  while (prompts.size > limit) {
    const oldest = prompts.values().next().value;
    if (typeof oldest !== "string") break;
    prompts.delete(oldest);
  }
  return true;
}

function traceContextForWriteback(
  request: ClaudeMemoryHookWritebackRequest,
  entry: MemoryTurnState | undefined,
): TraceContext | undefined {
  if (!entry?.traceContext) return request.traceContext;
  if (!request.traceContext) return entry.traceContext;
  return {
    ...entry.traceContext,
    ...request.traceContext,
    transcriptPath: request.traceContext.transcriptPath ?? entry.traceContext.transcriptPath,
    cwd: request.traceContext.cwd ?? entry.traceContext.cwd,
    memoryProject: request.traceContext.memoryProject ?? entry.traceContext.memoryProject,
    workspaceKind: request.traceContext.workspaceKind ?? entry.traceContext.workspaceKind,
  };
}

function skipped(reason: ClaudeMemoryHookWritebackSkipReason): ClaudeMemoryHookWritebackResult {
  return { ok: true, scheduled: false, reason };
}

async function recordTraceBestEffort<T>(
  label: string,
  promise: Promise<T>,
  diagnosticLogger?: MemoryDiagnosticLogger,
): Promise<T | undefined> {
  try {
    return await promise;
  } catch (error) {
    diagnosticLogger?.("claude_trace.write_failed", {
      label,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}
