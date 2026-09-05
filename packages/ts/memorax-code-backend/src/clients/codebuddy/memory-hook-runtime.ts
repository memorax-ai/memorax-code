import {
  readCodeBuddyInterruptedTranscriptTurn,
  readCodeBuddyTranscriptTurn,
  type CodeBuddyInterruptedTurn,
  type CodeBuddyTurn,
  type CodeBuddyTurnFailureReason,
} from "./jsonl-history.js";
import type { AutomaticMemoryWritebackRejectionReason } from "../../memory/automatic-writeback.js";
import { createHarnessMemoryRuntime, type HarnessMemoryRuntimeOptions } from "../../memory/harness-runtime.js";
import type { CodeBuddyTurnStartCommand, CodeBuddyWritebackCommand, MemoryHookTurnStartResult } from "../../memory/hook-command.js";
import type { MemoryDiagnosticLogger } from "../../memory/observability.js";
import type { MemoryTurnCoordinator, MemoryTurnWritebackSkipReason } from "../../memory/turn-coordinator.js";
import type { RepositoryMemoryScopeFailureReason } from "../../repository/scope.js";
import { traceContextFromCodeBuddyHookBody, type TraceContext } from "../../trace/context.js";
import {
  markCurrentCodeBuddyTurnOutcome,
  readOpenTraceTurn,
  recordCodeBuddyTraceEvent,
  traceTurnEventId,
  type TraceEventWriteResult,
} from "../../trace/store.js";

type Options = HarnessMemoryRuntimeOptions & {
  transcriptReadAttempts?: number;
  transcriptRetryDelayMs?: number;
};
type SkipReason = "missing_session_id" | "turn_id_missing" | "non_materialized_session" | "config_missing" | CodeBuddyTurnFailureReason | RepositoryMemoryScopeFailureReason | AutomaticMemoryWritebackRejectionReason | MemoryTurnWritebackSkipReason;
export type CodeBuddyMemoryHookWritebackResult = { ok: true; scheduled: true } | { ok: true; scheduled: false; reason: SkipReason };
export type CodeBuddyMemoryHookRuntime = { recordTurnStart(command: CodeBuddyTurnStartCommand): Promise<MemoryHookTurnStartResult>; writeback(command: CodeBuddyWritebackCommand): Promise<CodeBuddyMemoryHookWritebackResult>; size(): number; close(): void };

export function createCodeBuddyMemoryHookRuntime(options: Options = {}): CodeBuddyMemoryHookRuntime {
  const now = options.now ?? (() => Date.now());
  const memory = createHarnessMemoryRuntime({
    client: "codebuddy",
    retrievalSource: "codebuddy_hook_retrieval",
    writebackSource: "codebuddy_hook_writeback",
    diagnosticPrefix: "codebuddy_memory_hook",
    traceFailureEvent: "codebuddy_trace.write_failed",
    deduplicateRetrieval: false,
  }, options);
  const coordinator = memory.turnCoordinator;
  return {
    async recordTurnStart(command) {
      await reconcilePreviousInterruptedTurn(coordinator, command, options, now);
      const traceContext = traceContextFromCodeBuddyHookBody(command, new Date(now()).toISOString());
      return memory.recordTurnStart({
        sessionId: command.sessionId,
        clientTurnId: command.turnId,
        cwd: command.cwd,
        workspaceKind: command.workspaceKind,
        transcriptPath: command.transcriptPath,
        createdAt: now(),
        traceContext,
        prompt: command.prompt,
        retrievalTraceContext: traceContextFromCodeBuddyHookBody(command),
      });
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
      const repositoryMemory = await memory.resolveRepositoryMemory({ sessionId: command.sessionId, cwd: command.cwd ?? entry?.cwd, workspaceKind: command.workspaceKind ?? entry?.workspaceKind });
      const completed = await memory.completeTurn({
        sessionId: command.sessionId,
        clientTurnId: command.turnId,
        metadata: entry,
        resolveRepositoryMemory: async () => repositoryMemory,
        userText: transcript.turn.userPrompt,
        assistantText: transcript.turn.assistantReply,
        traceContext: traceContextFromCodeBuddyHookBody(command),
      });
      await recordCodeBuddyTurnMaterialization(options, traceContext, transcript.turn);
      return completed.scheduled ? { ok: true, scheduled: true } : { ok: true, scheduled: false, reason: completed.reason };
    },
    size() { return memory.size(); },
    close() { memory.close(); },
  };
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

async function reconcilePreviousInterruptedTurn(
  coordinator: MemoryTurnCoordinator,
  currentTurn: CodeBuddyTurnStartCommand,
  options: Options,
  now: () => number,
): Promise<void> {
  const candidate = await previousInterruptedTurnCandidate(coordinator, currentTurn, options, now);
  if (!candidate) return;
  const transcript = await readCodeBuddyInterruptedTranscriptTurn({
    transcriptPath: candidate.transcriptPath,
    sessionId: candidate.sessionId,
    turnId: candidate.turnId,
  });
  if (!transcript.ok) return;
  await recordCodeBuddyInterruptedTurnEnd(options, candidate.traceContext, transcript.turn);
  coordinator.discardTurn({
    client: "codebuddy",
    sessionId: candidate.sessionId,
    clientTurnId: candidate.turnId,
  }, "interrupted");
  options.diagnosticLogger?.("codebuddy_memory_hook.interrupted_turn_reconciled", {
    sessionId: candidate.sessionId,
    turnId: candidate.turnId,
    assistantChars: transcript.turn.assistantReply.length,
    activityCount: transcript.turn.activities.length,
    sessionTurnIndex: transcript.turn.sessionTurnIndex,
  });
}

type CodeBuddyInterruptedTurnCandidate = Readonly<{
  sessionId: string;
  turnId: string;
  transcriptPath: string;
  traceContext: TraceContext;
}>;

async function previousInterruptedTurnCandidate(
  coordinator: MemoryTurnCoordinator,
  currentTurn: CodeBuddyTurnStartCommand,
  options: Options,
  now: () => number,
): Promise<CodeBuddyInterruptedTurnCandidate | undefined> {
  const open = await readOpenTraceTurn({
    client: "codebuddy",
    memoraxCodeHome: options.memoraxCodeHome,
    env: options.env,
    expectedSessionId: currentTurn.sessionId,
    allowStale: true,
    now: () => new Date(now()),
  });
  if (!open.ok && open.reason === "closed") return undefined;
  if (open.ok && open.traceContext.turnId && open.traceContext.turnId !== currentTurn.turnId) {
    const turnId = open.traceContext.turnId;
    const cached = coordinator.getTurn({ client: "codebuddy", sessionId: currentTurn.sessionId, clientTurnId: turnId });
    return {
      sessionId: currentTurn.sessionId,
      turnId,
      transcriptPath: cached?.transcriptPath
        ?? open.traceContext.transcriptPath
        ?? currentTurn.transcriptPath,
      traceContext: cached?.traceContext ?? open.traceContext,
    };
  }
  const cached = coordinator.latestTurn({
    client: "codebuddy",
    sessionId: currentTurn.sessionId,
    excludeClientTurnId: currentTurn.turnId,
  });
  if (!cached) return undefined;
  const transcriptPath = cached.transcriptPath ?? currentTurn.transcriptPath;
  const traceContext = cached.traceContext ?? traceContextFromCodeBuddyHookBody({
    sessionId: cached.sessionId,
    turnId: cached.clientTurnId,
    cwd: cached.cwd,
    workspaceKind: cached.workspaceKind,
    transcriptPath,
  }, new Date(cached.createdAt).toISOString());
  if (!traceContext) return undefined;
  return {
    sessionId: cached.sessionId,
    turnId: cached.clientTurnId,
    transcriptPath,
    traceContext,
  };
}

async function recordCodeBuddyInterruptedTurnEnd(
  options: Options,
  traceContext: TraceContext,
  turn: CodeBuddyInterruptedTurn,
): Promise<void> {
  const recorded = await recordTraceBestEffort(
    "codebuddy_memory_hook.interrupted_turn_end_event",
    recordCodeBuddyTraceEvent({
      eventId: traceTurnEventId(traceContext, "turn_end"),
      memoraxCodeHome: options.memoraxCodeHome,
      env: options.env,
      traceContext,
      type: "turn_end",
      source: "codebuddy-transcript",
      operation: "reply",
      ok: true,
      outcome: "interrupted",
      activities: turn.activities,
      sessionTurnIndex: turn.sessionTurnIndex,
      request: { prompt: turn.userPrompt },
      response: { assistantMessage: turn.assistantReply },
    }),
    options.diagnosticLogger,
  );
  if (!recorded || (!recorded.written && recorded.reason !== "duplicate_event")) return;
  await recordTraceBestEffort(
    "codebuddy_memory_hook.interrupted_current_turn_close",
    markCurrentCodeBuddyTurnOutcome(traceContext, "interrupted", {
      memoraxCodeHome: options.memoraxCodeHome,
      env: options.env,
    }),
    options.diagnosticLogger,
  );
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
