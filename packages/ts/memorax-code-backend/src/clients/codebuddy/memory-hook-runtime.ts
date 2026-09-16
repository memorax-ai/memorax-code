import {
  readCodeBuddyInterruptedTranscriptTurn,
  readCodeBuddyTranscriptTurn,
  type CodeBuddyInterruptedTurn,
  type CodeBuddyTurn,
  type CodeBuddyTurnFailureReason,
} from "./jsonl-history.js";
import type { AutomaticMemoryWritebackRejectionReason } from "../../memory/automatic-writeback.js";
import { createHarnessMemoryRuntime, type HarnessMemoryRuntimeOptions } from "../../memory/harness-runtime.js";
import type { CodeBuddyTurnStartCommand, CodeBuddyWritebackCommand, WorkBuddyTurnStartCommand, WorkBuddyWritebackCommand, MemoryHookTurnStartResult } from "../../memory/hook-command.js";
import type { MemoryTurnCoordinator, MemoryTurnWritebackSkipReason } from "../../memory/turn-coordinator.js";
import type { RepositoryMemoryScopeFailureReason } from "../../repository/scope.js";
import { traceContextFromCodeBuddyHookBody, type TraceContext } from "../../trace/context.js";
import {
  markCurrentTraceTurnOutcome,
  readOpenTraceTurn,
  recordTraceEvent,
  traceTurnEventId,
  type TraceEventWriteResult,
} from "../../trace/store.js";

type NativeTurnStartCommand = CodeBuddyTurnStartCommand | WorkBuddyTurnStartCommand;
type NativeWritebackCommand = CodeBuddyWritebackCommand | WorkBuddyWritebackCommand;

type Options = HarnessMemoryRuntimeOptions & {
  client?: "codebuddy" | "workbuddy";
  captureCodingTurns?: boolean;
  transcriptReadAttempts?: number;
  transcriptRetryDelayMs?: number;
};
type SkipReason = "missing_session_id" | "turn_id_missing" | "non_materialized_session" | "config_missing" | CodeBuddyTurnFailureReason | RepositoryMemoryScopeFailureReason | AutomaticMemoryWritebackRejectionReason | MemoryTurnWritebackSkipReason;
export type CodeBuddyMemoryHookWritebackResult = { ok: true; scheduled: true } | { ok: true; scheduled: false; reason: SkipReason };
export type CodeBuddyMemoryHookRuntime = { recordTurnStart(command: NativeTurnStartCommand): Promise<MemoryHookTurnStartResult>; writeback(command: NativeWritebackCommand): Promise<CodeBuddyMemoryHookWritebackResult>; size(): number; close(): void };

export function createCodeBuddyMemoryHookRuntime(options: Options = {}): CodeBuddyMemoryHookRuntime {
  const client = options.client ?? "codebuddy";
  const now = options.now ?? (() => Date.now());
  const memory = createHarnessMemoryRuntime({
    client,
    retrievalSource: `${client}_hook_retrieval`,
    writebackSource: `${client}_hook_writeback`,
    diagnosticPrefix: `${client}_memory_hook`,
    traceFailureEvent: `${client}_trace.write_failed`,
    turnStartTraceSource: `${client}-hook`,
    deduplicateRetrieval: false,
  }, options);
  const coordinator = memory.turnCoordinator;
  return {
    async recordTurnStart(command) {
      if (command.client !== client) throw new Error("memory Hook client mismatch");
      // Interrupted turns may never emit Stop. Reconcile before the new turn
      // replaces the session's current trace identity.
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
      if (command.client !== client) throw new Error("memory Hook client mismatch");
      const entry = coordinator.getTurn({ client, sessionId: command.sessionId, clientTurnId: command.turnId });
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
        userTimestamp: transcript.turn.userTimestamp,
        assistantTimestamp: transcript.turn.assistantTimestamp,
        traceContext: traceContextFromCodeBuddyHookBody(command),
        ...(transcript.turn.events && transcript.turn.sessionTurnIndex ? {
          codingTurn: {
            client,
            sessionId: command.sessionId,
            turnId: command.turnId,
            turnIndex: transcript.turn.sessionTurnIndex,
            events: transcript.turn.events,
            outcome: "completed",
            closedAt: new Date(transcript.turn.assistantTimestamp ?? now()).toISOString(),
          },
        } : {}),
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
  const request = { ...input, captureCodingEvents: options.captureCodingTurns };
  let result = await readCodeBuddyTranscriptTurn(request);
  for (let i = 1; i < attempts && !result.ok && ["transcript_unavailable", "turn_not_found", "user_prompt_missing", "assistant_message_missing"].includes(result.reason); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, options.transcriptRetryDelayMs ?? 100));
    result = await readCodeBuddyTranscriptTurn(request);
  }
  return result;
}

function traceContextForWriteback(
  command: NativeWritebackCommand,
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
  const client = options.client ?? "codebuddy";
  const outcome = turn ? "completed" : failureReason === "assistant_message_missing" ? "interrupted" : undefined;
  const recorded = await recordTraceBestEffort(`${client}_memory_hook.turn_end_event`, recordTraceEvent({
    eventId: traceTurnEventId(traceContext, "turn_end"),
    memoraxCodeHome: options.memoraxCodeHome,
    env: options.env,
    traceContext,
    type: "turn_end",
    source: turn ? `${client}-hook` : `${client}-transcript`,
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
  }), options);
  if (outcome) {
    await recordTraceBestEffort(`${client}_memory_hook.current_turn_close`, markCurrentTraceTurnOutcome(
      traceContext,
      outcome,
      { memoraxCodeHome: options.memoraxCodeHome, env: options.env },
    ), options);
  }
  return recorded;
}

async function recordCodeBuddyTurnMaterialization(
  options: Options,
  traceContext: TraceContext | undefined,
  turn: CodeBuddyTurn,
): Promise<void> {
  const client = options.client ?? "codebuddy";
  const originalEventId = traceTurnEventId(traceContext, "turn_end");
  if (!originalEventId) return;
  await recordTraceBestEffort(`${client}_memory_hook.turn_materialized_event`, recordTraceEvent({
    eventId: traceTurnEventId(traceContext, "turn_materialized"),
    memoraxCodeHome: options.memoraxCodeHome,
    env: options.env,
    traceContext,
    type: "turn_materialized",
    source: `${client}-transcript`,
    operation: "reply",
    ok: true,
    outcome: "completed",
    activities: turn.activities,
    sessionTurnIndex: turn.sessionTurnIndex,
    request: { original_event_id: originalEventId, prompt: turn.userPrompt },
    response: { assistantMessage: turn.assistantReply },
  }), options);
}

async function reconcilePreviousInterruptedTurn(
  coordinator: MemoryTurnCoordinator,
  currentTurn: NativeTurnStartCommand,
  options: Options,
  now: () => number,
): Promise<void> {
  const client = options.client ?? "codebuddy";
  const candidate = await previousInterruptedTurnCandidate(coordinator, currentTurn, options, now);
  if (!candidate) return;
  // Trace and cached metadata only locate the candidate; the native transcript
  // must confirm interruption before we close it and discard pending metadata.
  const transcript = await readCodeBuddyInterruptedTranscriptTurn({
    transcriptPath: candidate.transcriptPath,
    sessionId: candidate.sessionId,
    turnId: candidate.turnId,
  });
  if (!transcript.ok) return;
  await recordCodeBuddyInterruptedTurnEnd(options, candidate.traceContext, transcript.turn);
  coordinator.discardTurn({
    client,
    sessionId: candidate.sessionId,
    clientTurnId: candidate.turnId,
  }, "interrupted");
  options.diagnosticLogger?.(`${client}_memory_hook.interrupted_turn_reconciled`, {
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
  currentTurn: NativeTurnStartCommand,
  options: Options,
  now: () => number,
): Promise<CodeBuddyInterruptedTurnCandidate | undefined> {
  const client = options.client ?? "codebuddy";
  const open = await readOpenTraceTurn({
    client,
    memoraxCodeHome: options.memoraxCodeHome,
    env: options.env,
    expectedSessionId: currentTurn.sessionId,
    allowStale: true,
    now: () => new Date(now()),
  });
  if (!open.ok && open.reason === "closed") return undefined;
  if (open.ok && open.traceContext.turnId && open.traceContext.turnId !== currentTurn.turnId) {
    const turnId = open.traceContext.turnId;
    const cached = coordinator.getTurn({ client, sessionId: currentTurn.sessionId, clientTurnId: turnId });
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
    client,
    sessionId: currentTurn.sessionId,
    excludeClientTurnId: currentTurn.turnId,
  });
  if (!cached) return undefined;
  const transcriptPath = cached.transcriptPath ?? currentTurn.transcriptPath;
  const traceContext = cached.traceContext ?? traceContextFromCodeBuddyHookBody({
    client,
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
  const client = options.client ?? "codebuddy";
  await recordTraceBestEffort(
    `${client}_memory_hook.interrupted_turn_end_event`,
    recordTraceEvent({
      eventId: traceTurnEventId(traceContext, "turn_end"),
      memoraxCodeHome: options.memoraxCodeHome,
      env: options.env,
      traceContext,
      type: "turn_end",
      source: `${client}-transcript`,
      operation: "reply",
      ok: true,
      outcome: "interrupted",
      activities: turn.activities,
      sessionTurnIndex: turn.sessionTurnIndex,
      request: { prompt: turn.userPrompt },
      response: { assistantMessage: turn.assistantReply },
    }),
    options,
  );
  // Closing operational state must not depend on retaining its trace event.
  await recordTraceBestEffort(
    `${client}_memory_hook.interrupted_current_turn_close`,
    markCurrentTraceTurnOutcome(traceContext, "interrupted", {
      memoraxCodeHome: options.memoraxCodeHome,
      env: options.env,
    }),
    options,
  );
}

async function recordTraceBestEffort<T>(
  label: string,
  promise: Promise<T>,
  options: Options,
): Promise<T | undefined> {
  try {
    return await promise;
  } catch (error) {
    options.diagnosticLogger?.(`${options.client ?? "codebuddy"}_trace.write_failed`, {
      label,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}
