import { readCodeBuddyTranscriptTurn, type CodeBuddyTurn, type CodeBuddyTurnFailureReason } from "./jsonl-history.js";
import { retrieveAutomaticMemoryContext } from "../../memory/automatic-retrieval.js";
import { createAutomaticMemoryWritebackRuntime, type AutomaticMemoryWritebackEnqueue, type AutomaticMemoryWritebackRejectionReason, type AutomaticMemoryWritebackRuntime } from "../../memory/automatic-writeback.js";
import type { CodeBuddyTurnStartCommand, CodeBuddyWritebackCommand, MemoryHookTurnStartResult } from "../../memory/hook-command.js";
import type { MemoryDiagnosticLogger, MemoryObservabilityHook } from "../../memory/observability.js";
import { createMemoryTurnCoordinator, type MemoryTurnCoordinator, type MemoryTurnWritebackSkipReason } from "../../memory/turn-coordinator.js";
import { createRepositoryMemorySessionRuntime, resolvedRepoMemoryWorktree, type ConfiguredRepositoryMemoryResult, type RepositoryMemorySessionRuntime } from "../../memory/repository-session.js";
import type { RepositoryMemoryScopeFailureReason } from "../../repository/scope.js";
import { traceContextFromCodeBuddyHookBody, type TraceContext } from "../../trace/context.js";
import {
  markCurrentCodeBuddyTurnOutcome,
  recordCodeBuddyTraceEvent,
  traceTurnEventId,
  writeCurrentCodeBuddyTurn,
  type TraceEventWriteResult,
} from "../../trace/store.js";

type Options = {
  automaticWriteback?: AutomaticMemoryWritebackEnqueue;
  diagnosticLogger?: MemoryDiagnosticLogger;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  ttlMs?: number;
  maxEntries?: number;
  cleanupIntervalMs?: number;
  memoryObservability?: MemoryObservabilityHook;
  memoraxCodeHome?: string;
  repositoryMemorySession?: RepositoryMemorySessionRuntime;
  turnCoordinator?: MemoryTurnCoordinator;
  transcriptReadAttempts?: number;
  transcriptRetryDelayMs?: number;
};
type SkipReason = "missing_session_id" | "turn_id_missing" | "non_materialized_session" | "config_missing" | CodeBuddyTurnFailureReason | RepositoryMemoryScopeFailureReason | AutomaticMemoryWritebackRejectionReason | MemoryTurnWritebackSkipReason;
export type CodeBuddyMemoryHookWritebackResult = { ok: true; scheduled: true } | { ok: true; scheduled: false; reason: SkipReason };
export type CodeBuddyMemoryHookRuntime = { recordTurnStart(command: CodeBuddyTurnStartCommand): Promise<MemoryHookTurnStartResult>; writeback(command: CodeBuddyWritebackCommand): Promise<CodeBuddyMemoryHookWritebackResult>; size(): number; close(): void };

export function createCodeBuddyMemoryHookRuntime(options: Options = {}): CodeBuddyMemoryHookRuntime {
  const now = options.now ?? (() => Date.now());
  const automatic = options.turnCoordinator ? undefined : options.automaticWriteback ? { enqueue: options.automaticWriteback, discardForScopeUpgrade: () => 0, drain: async () => undefined, close: () => undefined } : createAutomaticMemoryWritebackRuntime({ diagnosticLogger: options.diagnosticLogger });
  const coordinator = options.turnCoordinator ?? createMemoryTurnCoordinator({ automaticWriteback: automatic!.enqueue, now, ttlMs: options.ttlMs, maxEntries: options.maxEntries, cleanupIntervalMs: options.cleanupIntervalMs });
  const repository = options.repositoryMemorySession ?? createRepositoryMemorySessionRuntime({ onScopeUpgrade: automatic?.discardForScopeUpgrade });
  return {
    async recordTurnStart(command) {
      const memory = await resolveRepository(command, options, repository);
      const traceContext = traceContextFromCodeBuddyHookBody(command, new Date(now()).toISOString());
      coordinator.recordTurnStart({ client: "codebuddy", sessionId: command.sessionId, clientTurnId: command.turnId, cwd: command.cwd, workspaceKind: command.workspaceKind, transcriptPath: command.transcriptPath, createdAt: now(), traceContext, repositoryMemory: memory });
      await recordTraceBestEffort("codebuddy_memory_hook.turn_start_event", recordCodeBuddyTraceEvent({
        eventId: traceTurnEventId(traceContext, "turn_start"),
        memoraxCodeHome: options.memoraxCodeHome,
        env: options.env,
        traceContext,
        type: "turn_start",
        source: "unknown",
        operation: "query",
        ok: true,
        request: { prompt: command.prompt, cwd: command.cwd, transcriptPath: command.transcriptPath },
      }), options.diagnosticLogger);
      await recordTraceBestEffort("codebuddy_memory_hook.current_turn_write", writeCurrentCodeBuddyTurn(traceContext, {
        memoraxCodeHome: options.memoraxCodeHome,
        env: options.env,
        now: () => new Date(now()),
      }), options.diagnosticLogger);
      const repoMemoryWorktree = resolvedRepoMemoryWorktree(memory);
      const retrieval = await retrieveAutomaticMemoryContext({ diagnosticLogger: options.diagnosticLogger, env: options.env ?? process.env, fetchImpl: options.fetchImpl, memoryObservability: options.memoryObservability, memoryObservabilitySource: "codebuddy_hook_retrieval", query: command.prompt, repositoryMemory: memory, sessionKey: command.sessionId, traceContext: traceContextFromCodeBuddyHookBody(command) });
      return { ok: true, ...(repoMemoryWorktree ? { repoMemoryWorktree } : {}), ...(retrieval.context ? { additionalContext: retrieval.context } : {}) };
    },
    async writeback(command) {
      const entry = coordinator.getTurn({ client: "codebuddy", sessionId: command.sessionId, clientTurnId: command.turnId });
      if (!command.sessionId) return { ok: true, scheduled: false, reason: "missing_session_id" };
      if (!command.turnId) return { ok: true, scheduled: false, reason: "turn_id_missing" };
      if (entry?.transcriptPath && entry.transcriptPath !== command.transcriptPath) {
        await recordCodeBuddyTurnEnd(options, traceContextForWriteback(command, entry), undefined, "transcript_path_mismatch");
        return { ok: true, scheduled: false, reason: "transcript_path_mismatch" };
      }
      const traceContext = traceContextForWriteback(command, entry);
      const transcript = await readWithRetry({ transcriptPath: command.transcriptPath, sessionId: command.sessionId, turnId: command.turnId }, options);
      if (!transcript.ok) {
        await recordCodeBuddyTurnEnd(options, traceContext, undefined, transcript.reason);
        return { ok: true, scheduled: false, reason: transcript.reason };
      }
      await recordCodeBuddyTurnEnd(options, traceContext, transcript.turn);
      const memory = await resolveRepository({ ...command, cwd: command.cwd ?? entry?.cwd, workspaceKind: command.workspaceKind ?? entry?.workspaceKind }, options, repository);
      const completed = await coordinator.completeMaterializedTurn({ key: { client: "codebuddy", sessionId: command.sessionId, clientTurnId: command.turnId }, metadata: entry, resolveRepositoryMemory: async () => memory, userText: transcript.turn.userPrompt, assistantText: transcript.turn.assistantReply, writeback: { client: "codebuddy", sessionKey: command.sessionId, env: options.env ?? process.env, fetchImpl: options.fetchImpl, memoryObservability: options.memoryObservability, memoryObservabilitySource: "codebuddy_hook_writeback", traceContext: traceContextFromCodeBuddyHookBody(command) } });
      await recordCodeBuddyTurnMaterialization(options, traceContext, transcript.turn);
      return completed.scheduled ? { ok: true, scheduled: true } : { ok: true, scheduled: false, reason: completed.reason };
    },
    size() { return coordinator.size("codebuddy"); },
    close() { if (!options.turnCoordinator) coordinator.close(); if (!options.repositoryMemorySession) repository.close(); automatic?.close?.(); },
  };
}

async function resolveRepository(command: { sessionId: string; cwd?: string; workspaceKind?: string }, options: Options, repository: RepositoryMemorySessionRuntime): Promise<ConfiguredRepositoryMemoryResult> {
  return repository.resolve({ client: "codebuddy", sessionId: command.sessionId, workspaceRoot: command.cwd, workspaceKind: command.workspaceKind, memoraxCodeHome: options.memoraxCodeHome ?? options.env?.MEMORAX_CODE_HOME, env: options.env });
}
async function readWithRetry(input: { transcriptPath: string; sessionId: string; turnId: string }, options: Options) {
  const attempts = options.transcriptReadAttempts ?? 6;
  let result = await readCodeBuddyTranscriptTurn(input);
  for (let i = 1; i < attempts && !result.ok && ["transcript_unavailable", "turn_not_found", "user_prompt_missing", "assistant_message_missing"].includes(result.reason); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, options.transcriptRetryDelayMs ?? 100));
    result = await readCodeBuddyTranscriptTurn(input);
  }
  return result;
}

function traceContextForWriteback(
  command: CodeBuddyWritebackCommand,
  entry: { traceContext?: TraceContext; cwd?: string; workspaceKind?: string } | undefined,
): TraceContext | undefined {
  return traceContextFromCodeBuddyHookBody({
    ...command,
    cwd: command.cwd ?? entry?.cwd,
    workspaceKind: command.workspaceKind ?? entry?.workspaceKind,
  }) ?? entry?.traceContext;
}

async function recordCodeBuddyTurnEnd(
  options: Options,
  traceContext: TraceContext | undefined,
  turn?: CodeBuddyTurn,
  failureReason?: CodeBuddyTurnFailureReason,
): Promise<TraceEventWriteResult | undefined> {
  const outcome = turn ? "completed" : failureReason === "assistant_message_missing" ? "interrupted" : undefined;
  const recorded = await recordTraceBestEffort("codebuddy_memory_hook.turn_end_event", recordCodeBuddyTraceEvent({
    eventId: traceTurnEventId(traceContext, "turn_end"),
    memoraxCodeHome: options.memoraxCodeHome,
    env: options.env,
    traceContext,
    type: "turn_end",
    source: turn ? "codebuddy-hook" : "codebuddy-transcript",
    operation: "reply",
    ok: Boolean(turn),
    ...(outcome ? { outcome } : {}),
    ...(turn ? {
      activities: turn.activities,
      sessionTurnIndex: turn.sessionTurnIndex,
      request: { prompt: turn.userPrompt },
      response: { assistantMessage: turn.assistantReply },
    } : {
      error: failureReason,
    }),
  }), options.diagnosticLogger);
  if (outcome) {
    await recordTraceBestEffort("codebuddy_memory_hook.current_turn_close", markCurrentCodeBuddyTurnOutcome(
      traceContext,
      outcome,
      { memoraxCodeHome: options.memoraxCodeHome, env: options.env },
    ), options.diagnosticLogger);
  }
  return recorded;
}

async function recordCodeBuddyTurnMaterialization(
  options: Options,
  traceContext: TraceContext | undefined,
  turn: CodeBuddyTurn,
): Promise<void> {
  const originalEventId = traceTurnEventId(traceContext, "turn_end");
  if (!originalEventId) return;
  await recordTraceBestEffort("codebuddy_memory_hook.turn_materialized_event", recordCodeBuddyTraceEvent({
    eventId: traceTurnEventId(traceContext, "turn_materialized"),
    memoraxCodeHome: options.memoraxCodeHome,
    env: options.env,
    traceContext,
    type: "turn_materialized",
    source: "codebuddy-transcript",
    operation: "reply",
    ok: true,
    outcome: "completed",
    activities: turn.activities,
    sessionTurnIndex: turn.sessionTurnIndex,
    request: { original_event_id: originalEventId, prompt: turn.userPrompt },
    response: { assistantMessage: turn.assistantReply },
  }), options.diagnosticLogger);
}

async function recordTraceBestEffort<T>(
  label: string,
  promise: Promise<T>,
  diagnosticLogger?: MemoryDiagnosticLogger,
): Promise<T | undefined> {
  try {
    return await promise;
  } catch (error) {
    diagnosticLogger?.("codebuddy_trace.write_failed", {
      label,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}
