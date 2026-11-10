import {
  readDeepAgentsInterruptedTranscriptTurn,
  readDeepAgentsTranscriptTurn,
  type DeepAgentsInterruptedTranscriptTurn,
  type DeepAgentsTranscriptTurn,
  type DeepAgentsTranscriptTurnFailureReason,
  type DeepAgentsTranscriptTurnResult,
} from "./transcript-turn.js";
import type { AutomaticMemoryWritebackRejectionReason } from "../../memory/automatic-writeback.js";
import {
  createHarnessMemoryRuntime,
  type HarnessMemoryRuntimeOptions,
} from "../../memory/harness-runtime.js";
import type {
  DeepAgentsTurnStartCommand,
  DeepAgentsWritebackCommand,
  MemoryHookTurnStartResult,
} from "../../memory/hook-command.js";
import type { MemoryDiagnosticLogger } from "../../memory/observability.js";
import type {
  MemoryTurnCoordinator,
  MemoryTurnState,
} from "../../memory/turn-coordinator.js";
import type { RepositoryMemoryScopeFailureReason } from "../../repository/scope.js";
import { traceContextFromDeepAgentsHookBody, type TraceContext } from "../../trace/context.js";
import {
  markCurrentTraceTurnOutcome,
  readOpenTraceTurn,
  recordTraceEvent,
  traceTurnEventId,
  type TraceEventWriteResult,
} from "../../trace/store.js";

type DeepAgentsMemoryHookTurnStart = Omit<DeepAgentsTurnStartCommand, "version" | "client"> & {
  createdAt: number;
  traceContext?: TraceContext;
};

type DeepAgentsMemoryHookWritebackRequest = Omit<DeepAgentsWritebackCommand, "version" | "client"> & {
  traceContext?: TraceContext;
};

type DeepAgentsMemoryHookWritebackSkipReason =
  | "missing_session_id"
  | "prompt_id_missing"
  | "non_materialized_session"
  | "turn_metadata_mismatch"
  | "config_missing"
  | DeepAgentsTranscriptTurnFailureReason
  | RepositoryMemoryScopeFailureReason
  | AutomaticMemoryWritebackRejectionReason;

export type DeepAgentsMemoryHookWritebackResult =
  | { ok: true; scheduled: true }
  | { ok: true; scheduled: false; reason: DeepAgentsMemoryHookWritebackSkipReason };

export type DeepAgentsMemoryHookRuntimeOptions = HarnessMemoryRuntimeOptions & {
  transcriptReadAttempts?: number;
  transcriptRetryDelayMs?: number;
};

export type DeepAgentsMemoryHookRuntime = {
  recordTurnStart(command: DeepAgentsTurnStartCommand): Promise<MemoryHookTurnStartResult>;
  writeback(command: DeepAgentsWritebackCommand): Promise<DeepAgentsMemoryHookWritebackResult>;
  size(): number;
  close(): void;
};

const DEEPAGENTS_MEMORY_TURN_CLIENT = "deepagents" as const;
const DEFAULT_TRANSCRIPT_READ_ATTEMPTS = 6;
const DEFAULT_TRANSCRIPT_RETRY_DELAY_MS = 100;

export function createDeepAgentsMemoryHookRuntime(
  options: DeepAgentsMemoryHookRuntimeOptions = {},
): DeepAgentsMemoryHookRuntime {
  const now = options.now ?? (() => Date.now());
  const memory = createHarnessMemoryRuntime({
    client: DEEPAGENTS_MEMORY_TURN_CLIENT,
    writebackSource: "deepagents_hook_writeback",
    diagnosticPrefix: "deepagents_memory_hook",
    traceFailureEvent: "deepagents_trace.write_failed",
    turnStartTraceSource: "deepagents-hook",
  }, options);
  const { turnCoordinator } = memory;

  return {
    async recordTurnStart(command) {
      const turn = turnStartFromCommand(command, now());
      if (!turn.sessionId || !turn.promptId || !turn.transcriptPath) {
        options.diagnosticLogger?.("deepagents_memory_hook.turn_start_skipped", {
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
      return await memory.recordTurnStart({
        sessionId: turn.sessionId,
        clientTurnId: turn.promptId,
        cwd: turn.cwd,
        workspaceKind: turn.workspaceKind,
        transcriptPath: turn.transcriptPath,
        createdAt: turn.createdAt,
        traceContext: turn.traceContext,
        prompt: turn.prompt,
        diagnosticFields: { sessionId: turn.sessionId, promptId: turn.promptId },
      });
    },
    async writeback(command) {
      turnCoordinator.pruneExpired();
      const request = writebackRequestFromCommand(command);
      if (!request.sessionId) return skipped("missing_session_id");
      if (!request.lastAssistantMessage) return skipped("assistant_message_missing");
      const coordinatorKey = request.promptId
        ? deepAgentsTurnKey(request.sessionId, request.promptId)
        : undefined;
      const entry = coordinatorKey ? turnCoordinator.getTurn(coordinatorKey) : undefined;
      const transcriptPath = request.transcriptPath ?? entry?.transcriptPath;
      if (!transcriptPath) return skipped("non_materialized_session");
      const traceContext = traceContextForWriteback(request, entry);
      if (!request.promptId) {
        await recordDeepAgentsTurnEnd(options, traceContext, request.lastAssistantMessage);
        return skipped("prompt_id_missing");
      }

      const transcript = await readExactTranscriptTurnWithRetry({
        transcriptPath,
        sessionId: request.sessionId,
        promptId: request.promptId,
        lastAssistantMessage: request.lastAssistantMessage,
      }, options);
      const turnEndRecord = await recordDeepAgentsTurnEnd(
        options,
        traceContext,
        request.lastAssistantMessage,
        transcript.ok ? transcript.turn : undefined,
      );
      if (!transcript.ok) {
        options.diagnosticLogger?.("deepagents_memory_hook.writeback", {
          scheduled: false,
          reason: transcript.reason,
          sessionId: request.sessionId,
          promptId: request.promptId,
          error: transcript.error,
        });
        return skipped(transcript.reason);
      }
      if (turnEndRecord && !turnEndRecord.written && turnEndRecord.reason === "duplicate_event") {
        await recordDeepAgentsTurnMaterialization(options, traceContext, transcript.turn);
      }
      // dcode's transcript has no stop reason and may lag at Stop, so the Hook's
      // last_assistant_message is the native reply authority for this turn.
      const writeback = await memory.completeTurn({
        sessionId: request.sessionId,
        clientTurnId: request.promptId,
        metadata: entry,
        resolveRepositoryMemory: () => memory.resolveRepositoryMemory({
          sessionId: request.sessionId,
          cwd: request.cwd ?? entry?.cwd,
          workspaceKind: request.workspaceKind ?? entry?.workspaceKind,
        }),
        userText: transcript.turn.userPrompt,
        assistantText: transcript.turn.assistantReply,
        userTimestamp: transcript.turn.userTimestamp,
        assistantTimestamp: transcript.turn.assistantTimestamp,
        traceContext,
      });
      if (!writeback.scheduled) {
        options.diagnosticLogger?.("deepagents_memory_hook.writeback", {
          scheduled: false,
          reason: writeback.reason,
          metadataDisposition: writeback.metadataDisposition,
          sessionId: request.sessionId,
          promptId: request.promptId,
        });
        return skipped(writeback.reason);
      }
      options.diagnosticLogger?.("deepagents_memory_hook.writeback", {
        scheduled: true,
        metadataDisposition: writeback.metadataDisposition,
        sessionId: request.sessionId,
        promptId: request.promptId,
        promptChars: transcript.turn.userPrompt.length,
        assistantChars: transcript.turn.assistantReply.length,
        contentSource: "deepagents_native_stop_message",
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

async function readExactTranscriptTurnWithRetry(
  input: { transcriptPath: string; sessionId: string; promptId: string; lastAssistantMessage?: string },
  options: DeepAgentsMemoryHookRuntimeOptions,
): Promise<DeepAgentsTranscriptTurnResult> {
  // Stop may arrive before transcript materialization completes. Retry only
  // read/content availability failures; the Stop reply itself stays authoritative.
  const attempts = positiveInteger(options.transcriptReadAttempts, DEFAULT_TRANSCRIPT_READ_ATTEMPTS);
  const retryDelayMs = nonNegativeInteger(options.transcriptRetryDelayMs, DEFAULT_TRANSCRIPT_RETRY_DELAY_MS);
  let result: DeepAgentsTranscriptTurnResult = { ok: false, reason: "user_prompt_missing" };
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    result = await readDeepAgentsTranscriptTurn(input);
    if (result.ok || !transientTranscriptFailure(result.reason) || attempt === attempts) return result;
    await new Promise<void>((resolve) => setTimeout(resolve, retryDelayMs));
  }
  return result;
}

function transientTranscriptFailure(reason: DeepAgentsTranscriptTurnFailureReason): boolean {
  return reason === "transcript_unavailable"
    || reason === "user_prompt_missing"
    || reason === "assistant_message_missing";
}

function turnStartFromCommand(
  command: DeepAgentsTurnStartCommand,
  createdAt: number,
): DeepAgentsMemoryHookTurnStart {
  return {
    sessionId: command.sessionId,
    promptId: command.promptId,
    cwd: command.cwd,
    workspaceKind: command.workspaceKind,
    transcriptPath: command.transcriptPath,
    prompt: command.prompt,
    createdAt,
    traceContext: traceContextFromDeepAgentsHookBody(command, new Date(createdAt).toISOString()),
  };
}

function writebackRequestFromCommand(
  command: DeepAgentsWritebackCommand,
): DeepAgentsMemoryHookWritebackRequest {
  return {
    sessionId: command.sessionId,
    promptId: command.promptId,
    lastAssistantMessage: command.lastAssistantMessage,
    cwd: command.cwd,
    workspaceKind: command.workspaceKind,
    transcriptPath: command.transcriptPath,
    traceContext: traceContextFromDeepAgentsHookBody(command),
  };
}

async function recordDeepAgentsTurnEnd(
  options: DeepAgentsMemoryHookRuntimeOptions,
  traceContext: TraceContext | undefined,
  assistantMessage: string,
  transcript?: DeepAgentsTranscriptTurn,
): Promise<TraceEventWriteResult | undefined> {
  const eventId = traceTurnEventId(traceContext, "turn_end");
  const recorded = await recordTraceBestEffort("deepagents_memory_hook.turn_end_event", recordTraceEvent({
    eventId,
    memoraxCodeHome: options.memoraxCodeHome,
    env: options.env,
    traceContext,
    type: "turn_end",
    source: "deepagents-hook",
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
  // Closing operational state must not depend on retaining its trace event.
  await recordTraceBestEffort("deepagents_memory_hook.current_turn_close", markCurrentTraceTurnOutcome(
    traceContext,
    "completed",
    {
      client: "deepagents",
      memoraxCodeHome: options.memoraxCodeHome,
      env: options.env,
    },
  ), options.diagnosticLogger);
  return recorded;
}

async function recordDeepAgentsTurnMaterialization(
  options: DeepAgentsMemoryHookRuntimeOptions,
  traceContext: TraceContext | undefined,
  turn: DeepAgentsTranscriptTurn,
): Promise<void> {
  const originalEventId = traceTurnEventId(traceContext, "turn_end");
  if (!originalEventId) return;
  await recordTraceBestEffort("deepagents_memory_hook.turn_materialized_event", recordTraceEvent({
    eventId: traceTurnEventId(traceContext, "turn_materialized"),
    memoraxCodeHome: options.memoraxCodeHome,
    env: options.env,
    traceContext,
    type: "turn_materialized",
    source: "deepagents-transcript",
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
  currentTurn: DeepAgentsMemoryHookTurnStart,
  options: DeepAgentsMemoryHookRuntimeOptions,
  now: () => number,
): Promise<void> {
  const candidate = await previousInterruptedTurnCandidate(
    turnCoordinator,
    currentTurn,
    options,
    now,
  );
  if (!candidate) return;
  const transcript = await readDeepAgentsInterruptedTranscriptTurn({
    transcriptPath: candidate.transcriptPath,
    sessionId: candidate.sessionId,
    promptId: candidate.promptId,
  });
  if (!transcript.ok) return;
  await recordDeepAgentsInterruptedTurnEnd(options, candidate.traceContext, transcript.turn);
  turnCoordinator.discardTurn(
    deepAgentsTurnKey(candidate.sessionId, candidate.promptId),
    "interrupted",
  );
  options.diagnosticLogger?.("deepagents_memory_hook.interrupted_turn_reconciled", {
    sessionId: candidate.sessionId,
    promptId: candidate.promptId,
    assistantChars: transcript.turn.assistantReply.length,
    activityCount: transcript.turn.activities.length,
    sessionTurnIndex: transcript.turn.sessionTurnIndex,
  });
}

type DeepAgentsInterruptedTurnCandidate = Readonly<{
  sessionId: string;
  promptId: string;
  transcriptPath: string;
  traceContext: TraceContext;
}>;

async function previousInterruptedTurnCandidate(
  turnCoordinator: MemoryTurnCoordinator,
  currentTurn: DeepAgentsMemoryHookTurnStart,
  options: DeepAgentsMemoryHookRuntimeOptions,
  now: () => number,
): Promise<DeepAgentsInterruptedTurnCandidate | undefined> {
  if (!currentTurn.sessionId || !currentTurn.promptId || !currentTurn.transcriptPath) return undefined;
  const open = await readOpenTraceTurn({
    client: "deepagents",
    memoraxCodeHome: options.memoraxCodeHome,
    env: options.env,
    expectedSessionId: currentTurn.sessionId,
    allowStale: true,
    now: () => new Date(now()),
  });
  if (!open.ok && open.reason === "closed") return undefined;
  if (open.ok && open.traceContext.turnId && open.traceContext.turnId !== currentTurn.promptId) {
    const promptId = open.traceContext.turnId;
    const cached = turnCoordinator.getTurn(deepAgentsTurnKey(currentTurn.sessionId, promptId));
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
    client: DEEPAGENTS_MEMORY_TURN_CLIENT,
    sessionId: currentTurn.sessionId,
    excludeClientTurnId: currentTurn.promptId,
  });
  if (!cached) return undefined;
  const transcriptPath = cached.transcriptPath ?? currentTurn.transcriptPath;
  const traceContext = cached.traceContext ?? traceContextFromDeepAgentsHookBody({
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

async function recordDeepAgentsInterruptedTurnEnd(
  options: DeepAgentsMemoryHookRuntimeOptions,
  traceContext: TraceContext,
  turn: DeepAgentsInterruptedTranscriptTurn,
): Promise<void> {
  await recordTraceBestEffort(
    "deepagents_memory_hook.interrupted_turn_end_event",
    recordTraceEvent({
      eventId: traceTurnEventId(traceContext, "turn_end"),
      memoraxCodeHome: options.memoraxCodeHome,
      env: options.env,
      traceContext,
      type: "turn_end",
      source: "deepagents-transcript",
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
  await recordTraceBestEffort(
    "deepagents_memory_hook.interrupted_current_turn_close",
    markCurrentTraceTurnOutcome(traceContext, "interrupted", {
      client: "deepagents",
      memoraxCodeHome: options.memoraxCodeHome,
      env: options.env,
    }),
    options.diagnosticLogger,
  );
}

function deepAgentsTurnKey(sessionId: string, promptId: string) {
  return {
    client: DEEPAGENTS_MEMORY_TURN_CLIENT,
    sessionId,
    clientTurnId: promptId,
  } as const;
}

function traceContextForWriteback(
  request: DeepAgentsMemoryHookWritebackRequest,
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

function skipped(reason: DeepAgentsMemoryHookWritebackSkipReason): DeepAgentsMemoryHookWritebackResult {
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
    diagnosticLogger?.("deepagents_trace.write_failed", {
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
