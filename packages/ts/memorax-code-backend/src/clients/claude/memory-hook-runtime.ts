import { createHash } from "node:crypto";
import {
  captureClaudeTurnStartSnapshot,
  type ClaudeTurnStartCorrelation,
  type ClaudeTurnStartSnapshot,
  readClaudeInterruptedTranscriptTurn,
  readClaudeWritebackTurn,
  readClaudeArchiveSource,
  readClaudeTranscriptTurn,
  type ClaudeCodingSessionTurnResult,
  type ClaudeCodingSessionTurn,
  type ClaudeInterruptedTranscriptTurn,
  type ClaudeTranscriptTurn,
  type ClaudeTranscriptTurnFailureReason,
  type ClaudeTranscriptTurnResult,
} from "./transcript-turn.js";
import type { AutomaticMemoryWritebackRejectionReason } from "../../memory/automatic-writeback.js";
import {
  createHarnessMemoryRuntime,
  type HarnessMemoryRuntimeOptions,
} from "../../memory/harness-runtime.js";
import type {
  ClaudeTurnStartCommand,
  ClaudeWritebackCommand,
  MemoryHookTurnStartResult,
} from "../../memory/hook-command.js";
import type { MemoryDiagnosticLogger } from "../../memory/observability.js";
import type {
  MemoryTurnCoordinator,
  MemoryTurnKey,
  MemoryTurnState,
} from "../../memory/turn-coordinator.js";
import type { RepositoryMemoryScopeFailureReason } from "../../repository/scope.js";
import { traceContextFromClaudeHookBody, type TraceContext } from "../../trace/context.js";
import {
  markCurrentClaudeTurnOutcome,
  readOpenClaudeTurn,
  recordClaudeTraceEvent,
  traceTurnEventId,
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

export type ClaudeMemoryHookRuntimeOptions = HarnessMemoryRuntimeOptions & {
  captureCodingTurns?: boolean;
  transcriptReadAttempts?: number;
  transcriptRetryDelayMs?: number;
};

export type ClaudeMemoryHookRuntime = {
  recordTurnStart(command: ClaudeTurnStartCommand): Promise<MemoryHookTurnStartResult>;
  searchGuidanceTurnKey(command: ClaudeTurnStartCommand): MemoryTurnKey | undefined;
  writeback(command: ClaudeWritebackCommand): Promise<ClaudeMemoryHookWritebackResult>;
  size(): number;
  close(): void;
};

const CLAUDE_MEMORY_TURN_CLIENT = "claude-code" as const;
const DEFAULT_TRANSCRIPT_READ_ATTEMPTS = 6;
const DEFAULT_TRANSCRIPT_RETRY_DELAY_MS = 100;

type ClaudeObservationStatus = {
  settled: boolean;
  pending?: Promise<void>;
};

type ClaudeStartObservation = {
  command: Omit<ClaudeMemoryHookTurnStart, "prompt">;
  key: string;
  correlation?: ClaudeTurnStartCorrelation;
  failure?: ClaudeTranscriptTurnFailureReason;
  guidanceValidated?: boolean;
  status: ClaudeObservationStatus;
  previousStatus?: ClaudeObservationStatus;
};

export function createClaudeMemoryHookRuntime(
  options: ClaudeMemoryHookRuntimeOptions = {},
): ClaudeMemoryHookRuntime {
  const now = options.now ?? (() => Date.now());
  const memory = createHarnessMemoryRuntime({
    client: CLAUDE_MEMORY_TURN_CLIENT,
    writebackSource: "claude_hook_writeback",
    diagnosticPrefix: "claude_memory_hook",
    traceFailureEvent: "claude_trace.write_failed",
    turnStartTraceSource: "claude-hook",
  }, { readCodingSessionTurn: readClaudeArchiveSource, ...options });
  const { turnCoordinator } = memory;
  const starts = new Map<string, ClaudeStartObservation>();
  const accepted = new Map<string, number>();
  const completing = new Map<string, Promise<ClaudeMemoryHookWritebackResult>>();
  const maxEntries = positiveInteger(options.maxEntries, 256);
  function prune() {
    turnCoordinator.pruneExpired();
    for (const [key, value] of starts) {
      if (now() - value.command.createdAt > 24 * 60 * 60 * 1000) starts.delete(key);
    }
    for (const [key, time] of accepted) {
      if (now() - time > 5 * 60 * 1000) accepted.delete(key);
    }
  }

  async function performWriteback(
    command: ClaudeWritebackCommand,
    start: ClaudeStartObservation | undefined,
    materialized?: ClaudeTranscriptTurnResult | ClaudeCodingSessionTurnResult,
  ): Promise<ClaudeMemoryHookWritebackResult> {
    prune();
    const request = writebackRequestFromCommand(command);
    if (!request.sessionId) return skipped("missing_session_id");
    if (!request.lastAssistantMessage) return skipped("assistant_message_missing");
    if (start && request.transcriptPath !== start.command.transcriptPath) return skipped("turn_metadata_mismatch");
    const clientTurnId = start?.key ?? request.promptId;
    const coordinatorKey = clientTurnId
      ? claudeTurnKey(request.sessionId, clientTurnId)
      : undefined;
    const entry = coordinatorKey ? turnCoordinator.getTurn(coordinatorKey) : undefined;
    const transcriptPath = request.transcriptPath ?? entry?.transcriptPath;
    if (!transcriptPath) return skipped("non_materialized_session");
    const traceContext = start
      ? claudeObservationTrace(traceContextForWriteback(request, entry), start.key, request.promptId)
      : traceContextForWriteback(request, entry);
    if (!request.promptId) {
      await recordClaudeTurnEnd(options, traceContext, request.lastAssistantMessage);
      return skipped("prompt_id_missing");
    }

    if (start?.previousStatus?.pending) {
      await start.previousStatus.pending;
    }
    const transcript: ClaudeTranscriptTurnResult | ClaudeCodingSessionTurnResult = materialized ?? (start?.failure ? { ok: false, reason: start.failure } as const
      : await readExactTranscriptTurnWithRetry({
      transcriptPath,
      sessionId: request.sessionId,
      promptId: request.promptId,
      ...(start?.correlation ? { correlation: start.correlation } : {}),
    }, options));
    const turnEndRecord = await recordClaudeTurnEnd(
      options,
      traceContext,
      request.lastAssistantMessage,
      transcript.ok ? transcript.turn : undefined,
      materialized ? "claude-transcript" : "claude-hook",
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
    // The Hook reply is diagnostic evidence only; persisted transcript content
    // remains authoritative even when the two texts differ.
    if (!materialized) recordAssistantConsistencyDiagnostic(
      transcript.turn.assistantReply,
      request.lastAssistantMessage,
      request,
      options.diagnosticLogger,
    );
    const repositoryMemory = await memory.resolveRepositoryMemory({
      sessionId: request.sessionId,
      cwd: request.cwd ?? entry?.cwd,
      workspaceKind: request.workspaceKind ?? entry?.workspaceKind,
    });
    const nativeKey = JSON.stringify([request.sessionId, transcript.turn.nativeUserUuid,
      repositoryMemory.ok ? repositoryMemory.memory.scope : undefined]);
    if (accepted.has(nativeKey)) {
      return { ok: true, scheduled: true };
    }
    const pending = completing.get(nativeKey);
    if (pending) return pending;
    const completion = (async (): Promise<ClaudeMemoryHookWritebackResult> => {
      const writeback = await memory.completeTurn({
        sessionId: request.sessionId,
        clientTurnId,
        nativeTurnId: transcript.turn.nativeUserUuid,
        metadata: entry,
        resolveRepositoryMemory: async () => repositoryMemory,
        userText: transcript.turn.userPrompt,
        assistantText: transcript.turn.assistantReply,
        userTimestamp: transcript.turn.userTimestamp,
        assistantTimestamp: transcript.turn.assistantTimestamp,
        ...(hasCodingItems(transcript.turn) && transcript.turn.closedAt ? {
          codingTurn: {
            client: CLAUDE_MEMORY_TURN_CLIENT,
            sessionId: transcript.turn.sessionId,
            turnId: transcript.turn.nativeUserUuid,
            turnIndex: transcript.turn.sessionTurnIndex,
            items: transcript.turn.items,
            outcome: "completed",
            closedAt: transcript.turn.closedAt,
            source: transcript.turn.source,
          },
        } : {}),
        traceContext,
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
      accepted.set(nativeKey, now());
      while (accepted.size > maxEntries) accepted.delete(accepted.keys().next().value!);
      return { ok: true, scheduled: true };
    })();
    completing.set(nativeKey, completion);
    try { return await completion; } finally { completing.delete(nativeKey); }
  }

  function observeProcessing(
    start: ClaudeStartObservation | undefined,
    completion: Promise<ClaudeMemoryHookWritebackResult>,
  ): Promise<ClaudeMemoryHookWritebackResult> {
    if (start) {
      // Track every concurrent attempt: a fast rejection must not hide a slow Stop.
      const pending = Promise.allSettled([start.previousStatus?.pending, start.status.pending, completion]).then(() => {
        if (start.status.pending !== pending) return;
        delete start.status.pending;
        start.status.settled = true;
      });
      start.status.pending = pending;
    }
    return completion;
  }

  function settlePreviousStart(
    previous: ClaudeStartObservation,
    snapshot: ClaudeTurnStartSnapshot | undefined,
  ): Promise<ClaudeMemoryHookWritebackResult> {
    const input = {
      sessionId: previous.command.sessionId,
      promptId: previous.command.promptId,
      correlation: previous.correlation,
    };
    // Resolve the captured prefix before waiting, so pending work retains only this Turn's result.
    const transcript = !previous.failure && snapshot && previous.correlation
      ? snapshot.writeback(input, {
        captureCodingItems: options.captureCodingTurns,
        onArchiveSkipped: () => options.diagnosticLogger?.("coding_sessions.attachment_skipped", {
          reason: "projection_failed",
        }),
      }) : undefined;
    const interrupted = transcript && !transcript.ok ? snapshot?.interrupted(input) : undefined;
    const completion = (async (): Promise<ClaudeMemoryHookWritebackResult> => {
      await previous.previousStatus?.pending;
      if (transcript?.ok) {
        return performWriteback({
          ...previous.command, version: 1, client: CLAUDE_MEMORY_TURN_CLIENT,
          lastAssistantMessage: transcript.turn.assistantReply,
        }, previous, transcript);
      }
      if (interrupted?.ok) {
        const traceContext = claudeObservationTrace(previous.command.traceContext, previous.key, previous.command.promptId);
        if (traceContext) await recordClaudeInterruptedTurnEnd(options, traceContext, interrupted.turn);
        turnCoordinator.discardTurn(claudeTurnKey(previous.command.sessionId, previous.key), "interrupted");
        return skipped("assistant_message_missing");
      }
      turnCoordinator.discardTurn(claudeTurnKey(previous.command.sessionId, previous.key), "superseded");
      options.diagnosticLogger?.("claude_memory_hook.previous_turn_superseded", {
        sessionId: previous.command.sessionId, promptId: previous.command.promptId,
        metadataDisposition: "discarded",
      });
      return skipped("assistant_message_missing");
    })();
    return observeProcessing(previous, completion);
  }

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
      prune();
      let snapshot = await captureClaudeTurnStartSnapshot(turn);
      let guidanceValidated = false;
      if (snapshot.ok && options.searchGuidance?.isEnabled()) {
        const validation = snapshot.snapshot.validate();
        guidanceValidated = validation.ok;
        if (!validation.ok) snapshot = validation;
      }
      const key = `claude-start:${createHash("sha256").update(JSON.stringify([
        turn.sessionId, turn.promptId, turn.transcriptPath, turn.cwd, turn.workspaceKind,
        snapshot.ok ? snapshot.correlation : ["unavailable", turn.createdAt],
      ])).digest("hex")}`;
      const alias = claudeStartAlias(turn.sessionId, turn.promptId);
      const previous = starts.get(alias);
      const duplicate = previous?.key === key;
      let settlement: Promise<ClaudeMemoryHookWritebackResult> | undefined;
      if (!duplicate) {
        if (previous && !previous.status.settled && !previous.status.pending) {
          const waiting = previous.previousStatus?.pending;
          const pending = settlePreviousStart(previous,
            snapshot.ok && snapshot.correlation.endBytes && previous.command.transcriptPath === turn.transcriptPath
              ? snapshot.snapshot : undefined);
          if (!waiting) settlement = pending;
        } else if (!previous) {
          await reconcilePreviousInterruptedTurn(
            turnCoordinator, turn, options, now, starts, snapshot.ok ? snapshot.snapshot : undefined,
          );
        }
      }
      const { prompt, ...identity } = turn;
      const observation: ClaudeStartObservation = duplicate ? previous : {
        command: identity, key, status: { settled: false },
        ...(snapshot.ok ? { correlation: snapshot.correlation } : { failure: snapshot.reason }),
        ...(previous?.status.pending ? { previousStatus: previous.status } : {}),
      };
      if (guidanceValidated) observation.guidanceValidated = true;
      starts.delete(alias);
      starts.set(alias, observation);
      while (starts.size > maxEntries) starts.delete(starts.keys().next().value!);
      const result = await memory.recordTurnStart({
        sessionId: turn.sessionId,
        clientTurnId: key,
        cwd: turn.cwd,
        workspaceKind: turn.workspaceKind,
        transcriptPath: turn.transcriptPath,
        createdAt: turn.createdAt,
        traceContext: claudeObservationTrace(turn.traceContext, key, turn.promptId),
        prompt,
        diagnosticFields: { sessionId: turn.sessionId, promptId: turn.promptId },
      });
      // Publish this occurrence before waiting: a later start must not be overwritten.
      await settlement;
      return { ...result, claudeTurnKey: key };
    },
    searchGuidanceTurnKey(command) {
      prune();
      const start = starts.get(claudeStartAlias(command.sessionId, command.promptId));
      if (!start || !start.guidanceValidated || start.status.settled || hasPendingPrevious(start) || start.failure || command.claudeTurnKey !== start.key
        || command.transcriptPath !== start.command.transcriptPath
        || createHash("sha256").update(command.prompt.trim()).digest("hex") !== start.correlation?.promptDigest
        || command.cwd !== start.command.cwd
        || command.workspaceKind !== start.command.workspaceKind) return undefined;
      return claudeTurnKey(command.sessionId, start.key);
    },
    async writeback(command) {
      const start = starts.get(claudeStartAlias(command.sessionId, command.promptId));
      return observeProcessing(start, performWriteback(command, start));
    },
    size() {
      return memory.size();
    },
    close() {
      starts.clear();
      accepted.clear();
      memory.close();
    },
  };
}

async function readExactTranscriptTurnWithRetry(
  input: { transcriptPath: string; sessionId: string; promptId: string; correlation?: ClaudeTurnStartCorrelation },
  options: ClaudeMemoryHookRuntimeOptions,
): Promise<ClaudeTranscriptTurnResult | ClaudeCodingSessionTurnResult> {
  // Stop may arrive before transcript writes finish. Retry read/content
  // availability failures, but reject identity mismatches and branch ambiguity.
  const attempts = positiveInteger(options.transcriptReadAttempts, DEFAULT_TRANSCRIPT_READ_ATTEMPTS);
  const retryDelayMs = nonNegativeInteger(options.transcriptRetryDelayMs, DEFAULT_TRANSCRIPT_RETRY_DELAY_MS);
  let result: ClaudeTranscriptTurnResult | ClaudeCodingSessionTurnResult = { ok: false, reason: "turn_not_found" };
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    result = options.captureCodingTurns
      ? await readClaudeWritebackTurn({
        ...input,
        captureCodingItems: true,
        onArchiveSkipped: () => options.diagnosticLogger?.("coding_sessions.attachment_skipped", {
          reason: "projection_failed",
        }),
      })
      : await readClaudeTranscriptTurn(input);
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
  source: "claude-hook" | "claude-transcript" = "claude-hook",
): Promise<TraceEventWriteResult | undefined> {
  const eventId = traceTurnEventId(traceContext, "turn_end");
  const recorded = await recordTraceBestEffort("claude_memory_hook.turn_end_event", recordClaudeTraceEvent({
    eventId,
    memoraxCodeHome: options.memoraxCodeHome,
    env: options.env,
    traceContext,
    type: "turn_end",
    source,
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
  starts: ReadonlyMap<string, ClaudeStartObservation>,
  snapshot: ClaudeTurnStartSnapshot | undefined,
): Promise<void> {
  const candidate = await previousInterruptedTurnCandidate(
    turnCoordinator,
    currentTurn,
    options,
    now,
    starts,
  );
  if (!candidate) return;
  const selection = {
    sessionId: candidate.sessionId,
    promptId: candidate.promptId,
    ...(candidate.observation?.correlation ? { correlation: candidate.observation.correlation } : {}),
  };
  const transcript = snapshot && candidate.transcriptPath === currentTurn.transcriptPath
    ? snapshot.interrupted(selection)
    : await readClaudeInterruptedTranscriptTurn({ transcriptPath: candidate.transcriptPath, ...selection });
  if (!transcript.ok) return;
  await recordClaudeInterruptedTurnEnd(options, candidate.traceContext, transcript.turn);
  turnCoordinator.discardTurn(
    claudeTurnKey(candidate.sessionId, candidate.clientTurnId),
    "interrupted",
  );
  if (candidate.observation) candidate.observation.status.settled = true;
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
  clientTurnId: string;
  observation?: ClaudeStartObservation;
  transcriptPath: string;
  traceContext: TraceContext;
}>;

async function previousInterruptedTurnCandidate(
  turnCoordinator: MemoryTurnCoordinator,
  currentTurn: ClaudeMemoryHookTurnStart,
  options: ClaudeMemoryHookRuntimeOptions,
  now: () => number,
  starts: ReadonlyMap<string, ClaudeStartObservation>,
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
  if (open.ok && open.traceContext.turnId) {
    const clientTurnId = open.traceContext.turnId;
    const observation = [...starts.values()].find((start) => start.key === clientTurnId
      && start.command.sessionId === currentTurn.sessionId);
    const promptId = observation?.command.promptId ?? open.traceContext.nativeRequestId
      ?? (clientTurnId.startsWith("claude-start:") ? undefined : clientTurnId);
    if (!promptId || observation?.status.settled || observation?.failure || hasPendingPrevious(observation)) return undefined;
    const cached = turnCoordinator.getTurn(claudeTurnKey(currentTurn.sessionId, clientTurnId));
    return {
      sessionId: currentTurn.sessionId,
      promptId,
      clientTurnId,
      observation,
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
  const observation = [...starts.values()].find((start) => start.key === cached.clientTurnId
    && start.command.sessionId === currentTurn.sessionId);
  const promptId = observation?.command.promptId ?? cached.traceContext?.nativeRequestId
    ?? (cached.clientTurnId.startsWith("claude-start:") ? undefined : cached.clientTurnId);
  if (!promptId || observation?.status.settled || observation?.failure || hasPendingPrevious(observation)) return undefined;
  const transcriptPath = cached.transcriptPath ?? currentTurn.transcriptPath;
  const traceContext = cached.traceContext ?? traceContextFromClaudeHookBody({
    sessionId: cached.sessionId,
    promptId,
    cwd: cached.cwd,
    workspaceKind: cached.workspaceKind,
    transcriptPath,
  }, new Date(cached.createdAt).toISOString());
  if (!traceContext) return undefined;
  return {
    sessionId: cached.sessionId,
    promptId,
    clientTurnId: cached.clientTurnId,
    observation,
    transcriptPath,
    traceContext,
  };
}

async function recordClaudeInterruptedTurnEnd(
  options: ClaudeMemoryHookRuntimeOptions,
  traceContext: TraceContext,
  turn: ClaudeInterruptedTranscriptTurn,
): Promise<void> {
  await recordTraceBestEffort(
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

function hasPendingPrevious(start: ClaudeStartObservation | undefined): boolean {
  return start?.previousStatus?.pending !== undefined;
}

function claudeStartAlias(sessionId: string, promptId: string): string {
  return JSON.stringify([sessionId, promptId]);
}

function hasCodingItems(turn: ClaudeTranscriptTurn): turn is ClaudeCodingSessionTurn {
  return "items" in turn;
}

function claudeObservationTrace(context: TraceContext | undefined, key: string, promptId: string): TraceContext | undefined {
  return context ? { ...context, turnId: key, nativeRequestId: promptId } : undefined;
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
