import { retrieveAutomaticMemoryContext } from "../../memory/automatic-retrieval.js";
import {
  createAutomaticMemoryWritebackRuntime,
  type AutomaticMemoryWritebackEnqueue,
  type AutomaticMemoryWritebackRejectionReason,
  type AutomaticMemoryWritebackRuntime,
} from "../../memory/automatic-writeback.js";
import type {
  DshTurnDiscardCommand,
  DshTurnStartCommand,
  DshWritebackCommand,
  MemoryHookTurnDiscardResult,
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
import { traceContextFromDshHookBody, type TraceContext } from "../../trace/context.js";
import {
  markCurrentDshTurnOutcome,
  recordDshTraceEvent,
  traceTurnEventId,
  writeCurrentDshTurn,
  type DshTurnOutcome,
} from "../../trace/store.js";

type DshMemoryHookTurnStart = Omit<DshTurnStartCommand, "version" | "client"> & {
  createdAt: number;
  traceContext?: TraceContext;
};

type DshMemoryHookWritebackRequest = Omit<DshWritebackCommand, "version" | "client"> & {
  traceContext?: TraceContext;
};

type DshMemoryHookWritebackSkipReason =
  | "missing_session_id"
  | "turn_id_missing"
  | "user_text_missing"
  | "assistant_text_missing"
  | "prompt_mismatch"
  | "turn_metadata_missing"
  | "turn_metadata_mismatch"
  | "config_missing"
  | RepositoryMemoryScopeFailureReason
  | AutomaticMemoryWritebackRejectionReason;

export type DshMemoryHookWritebackResult =
  | { ok: true; scheduled: true }
  | { ok: true; scheduled: false; reason: DshMemoryHookWritebackSkipReason };

export type DshMemoryHookRuntimeOptions = {
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
};

export type DshMemoryHookRuntime = {
  recordTurnStart(command: DshTurnStartCommand): Promise<MemoryHookTurnStartResult>;
  writeback(command: DshWritebackCommand): Promise<DshMemoryHookWritebackResult>;
  discardTurn(command: DshTurnDiscardCommand): Promise<MemoryHookTurnDiscardResult>;
  size(): number;
  close(): void;
};

const DSH_MEMORY_TURN_CLIENT = "dsh" as const;

export function createDshMemoryHookRuntime(
  options: DshMemoryHookRuntimeOptions = {},
): DshMemoryHookRuntime {
  const now = options.now ?? (() => Date.now());
  const automaticWritebackRuntime: {
    enqueue: AutomaticMemoryWritebackEnqueue;
    discardForScopeUpgrade?: AutomaticMemoryWritebackRuntime["discardForScopeUpgrade"];
    close?: () => void;
  } | undefined = options.turnCoordinator
    ? undefined
    : options.automaticWriteback
      ? { enqueue: options.automaticWriteback }
      : createAutomaticMemoryWritebackRuntime({ diagnosticLogger: options.diagnosticLogger });
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
      const turn = turnStartFromCommand(command, now());
      if (!turn.sessionId || !turn.turnId || !turn.prompt) {
        options.diagnosticLogger?.("dsh_memory_hook.turn_start_skipped", {
          reason: !turn.sessionId
            ? "missing_session_id"
            : !turn.turnId
              ? "turn_id_missing"
              : "prompt_missing",
          sessionId: turn.sessionId,
          turnId: turn.turnId,
        });
        return { ok: true };
      }
      turnCoordinator.pruneExpired();
      const repositoryMemory = await resolveHookRepositoryMemory(turn, options, repositoryMemorySession);
      const repoMemoryWorktree = resolvedRepoMemoryWorktree(repositoryMemory);
      turnCoordinator.recordTurnStart({
        client: DSH_MEMORY_TURN_CLIENT,
        sessionId: turn.sessionId,
        clientTurnId: turn.turnId,
        cwd: turn.cwd,
        workspaceKind: turn.workspaceKind,
        transcriptPath: turn.transcriptPath,
        prompt: turn.prompt,
        createdAt: turn.createdAt,
        traceContext: turn.traceContext,
        repositoryMemory,
      });
      options.diagnosticLogger?.("dsh_memory_hook.turn_start", {
        sessionId: turn.sessionId,
        turnId: turn.turnId,
        promptChars: turn.prompt.length,
        cacheSize: turnCoordinator.size(DSH_MEMORY_TURN_CLIENT),
        workspace: repositoryMemory.ok ? repositoryMemory.memory.scope?.repositorySlug : undefined,
        workspaceScopeReason: repositoryMemory.ok ? undefined : repositoryMemory.reason,
      });
      await recordTraceBestEffort("dsh_memory_hook.turn_start_event", recordDshTraceEvent({
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
      await recordTraceBestEffort("dsh_memory_hook.current_turn_write", writeCurrentDshTurn(
        turn.traceContext,
        {
          memoraxCodeHome: options.memoraxCodeHome,
          env: options.env,
          now: () => new Date(now()),
        },
      ), options.diagnosticLogger);
      if (!claimAutomaticRetrievalTurn(
        automaticRetrievalTurns,
        automaticRetrievalTurnLimit,
        turn.sessionId,
        turn.turnId,
      )) {
        return {
          ok: true,
          ...(repoMemoryWorktree ? { repoMemoryWorktree } : {}),
        };
      }
      const retrieval = await retrieveAutomaticMemoryContext({
        diagnosticLogger: options.diagnosticLogger,
        env: options.env ?? process.env,
        fetchImpl: options.fetchImpl,
        memoryObservability: options.memoryObservability,
        memoryObservabilitySource: "dsh_hook_retrieval",
        query: turn.prompt,
        repositoryMemory,
        sessionKey: turn.sessionId,
        traceContext: turn.traceContext,
      });
      return {
        ok: true,
        ...(repoMemoryWorktree ? { repoMemoryWorktree } : {}),
        ...(retrieval.context ? { additionalContext: retrieval.context } : {}),
      };
    },
    async writeback(command) {
      turnCoordinator.pruneExpired();
      const request = writebackRequestFromCommand(command);
      if (!request.sessionId) return skipped("missing_session_id");
      if (!request.turnId) return skipped("turn_id_missing");
      if (!request.userText) return skipped("user_text_missing");
      if (!request.assistantText) return skipped("assistant_text_missing");
      const coordinatorKey = dshTurnKey(request.sessionId, request.turnId);
      const entry = turnCoordinator.getTurn(coordinatorKey);
      if (!entry) {
        options.diagnosticLogger?.("dsh_memory_hook.writeback", {
          scheduled: false,
          reason: "turn_metadata_missing",
          sessionId: request.sessionId,
          turnId: request.turnId,
        });
        return skipped("turn_metadata_missing");
      }
      if (entry.prompt !== undefined && !dshPromptMatches(entry.prompt, request.userText)) {
        options.diagnosticLogger?.("dsh_memory_hook.writeback", {
          scheduled: false,
          reason: "prompt_mismatch",
          sessionId: request.sessionId,
          turnId: request.turnId,
        });
        return skipped("prompt_mismatch");
      }
      const traceContext = traceContextForWriteback(request, entry);
      await recordDshTurnEnd(
        options,
        traceContext,
        request.assistantText,
      );
      const writeback = await turnCoordinator.completeMaterializedTurn({
        key: coordinatorKey,
        metadata: entry,
        resolveRepositoryMemory: () => resolveCurrentHookRepositoryMemory(
          entry,
          request,
          options,
          repositoryMemorySession,
        ),
        userText: request.userText,
        assistantText: request.assistantText,
        writeback: {
          client: DSH_MEMORY_TURN_CLIENT,
          sessionKey: request.sessionId,
          env: options.env ?? process.env,
          fetchImpl: options.fetchImpl,
          memoryObservability: options.memoryObservability,
          memoryObservabilitySource: "dsh_hook_writeback",
          traceContext,
        },
      });
      if (!writeback.scheduled) {
        options.diagnosticLogger?.("dsh_memory_hook.writeback", {
          scheduled: false,
          reason: writeback.reason,
          metadataDisposition: writeback.metadataDisposition,
          sessionId: request.sessionId,
          turnId: request.turnId,
        });
        return skipped(writeback.reason);
      }
      options.diagnosticLogger?.("dsh_memory_hook.writeback", {
        scheduled: true,
        metadataDisposition: writeback.metadataDisposition,
        sessionId: request.sessionId,
        turnId: request.turnId,
        promptChars: request.userText.length,
        assistantChars: request.assistantText.length,
        contentSource: "dsh_session_event",
      });
      return { ok: true, scheduled: true };
    },
    async discardTurn(command) {
      turnCoordinator.pruneExpired();
      if (!command.sessionId || !command.turnId) return { ok: true, discarded: false };
      const key = dshTurnKey(command.sessionId, command.turnId);
      const entry = turnCoordinator.getTurn(key);
      if (!entry) return { ok: true, discarded: false };
      await recordDshTurnInterrupted(options, entry.traceContext);
      turnCoordinator.discardTurn(key, "interrupted");
      options.diagnosticLogger?.("dsh_memory_hook.turn_discarded", {
        sessionId: command.sessionId,
        turnId: command.turnId,
      });
      return { ok: true, discarded: true };
    },
    size() {
      return turnCoordinator.size(DSH_MEMORY_TURN_CLIENT);
    },
    close() {
      automaticRetrievalTurns.clear();
      if (ownsTurnCoordinator) turnCoordinator.close();
      if (ownsRepositoryMemorySession) repositoryMemorySession.close();
      automaticWritebackRuntime?.close?.();
    },
  };
}

async function resolveHookRepositoryMemory(
  entry: Pick<DshMemoryHookTurnStart, "sessionId" | "cwd" | "workspaceKind">,
  options: DshMemoryHookRuntimeOptions,
  repositoryMemorySession: RepositoryMemorySessionRuntime,
): Promise<ConfiguredRepositoryMemoryResult> {
  return await repositoryMemorySession.resolve({
    client: DSH_MEMORY_TURN_CLIENT,
    sessionId: entry.sessionId,
    workspaceRoot: entry.cwd,
    workspaceKind: entry.workspaceKind,
    memoraxCodeHome: options.memoraxCodeHome ?? options.env?.MEMORAX_CODE_HOME,
    env: options.env,
  });
}

async function resolveCurrentHookRepositoryMemory(
  entry: MemoryTurnState | undefined,
  request: DshMemoryHookWritebackRequest,
  options: DshMemoryHookRuntimeOptions,
  repositoryMemorySession: RepositoryMemorySessionRuntime,
): Promise<ConfiguredRepositoryMemoryResult> {
  return await repositoryMemorySession.resolve({
    client: DSH_MEMORY_TURN_CLIENT,
    sessionId: request.sessionId,
    workspaceRoot: request.cwd ?? entry?.cwd,
    workspaceKind: request.workspaceKind ?? entry?.workspaceKind,
    memoraxCodeHome: options.memoraxCodeHome ?? options.env?.MEMORAX_CODE_HOME,
    env: options.env,
  });
}

function turnStartFromCommand(
  command: DshTurnStartCommand,
  createdAt: number,
): DshMemoryHookTurnStart {
  return {
    sessionId: command.sessionId,
    turnId: command.turnId,
    cwd: command.cwd,
    workspaceKind: command.workspaceKind,
    transcriptPath: command.transcriptPath,
    prompt: command.prompt,
    createdAt,
    traceContext: traceContextFromDshHookBody({
      sessionId: command.sessionId,
      turnId: command.turnId,
      cwd: command.cwd,
      workspaceKind: command.workspaceKind,
      transcriptPath: command.transcriptPath,
    }, new Date(createdAt).toISOString()),
  };
}

function writebackRequestFromCommand(
  command: DshWritebackCommand,
): DshMemoryHookWritebackRequest {
  return {
    sessionId: command.sessionId,
    turnId: command.turnId,
    userText: command.userText,
    assistantText: command.assistantText,
    cwd: command.cwd,
    workspaceKind: command.workspaceKind,
    transcriptPath: command.transcriptPath,
    traceContext: traceContextFromDshHookBody({
      sessionId: command.sessionId,
      turnId: command.turnId,
      cwd: command.cwd,
      workspaceKind: command.workspaceKind,
      transcriptPath: command.transcriptPath,
    }),
  };
}

async function recordDshTurnEnd(
  options: DshMemoryHookRuntimeOptions,
  traceContext: TraceContext | undefined,
  assistantText: string,
  details: { outcome?: DshTurnOutcome } = {},
): Promise<void> {
  const outcome = details.outcome ?? "completed";
  await recordTraceBestEffort("dsh_memory_hook.turn_end_event", recordDshTraceEvent({
    eventId: traceTurnEventId(traceContext, "turn_end"),
    memoraxCodeHome: options.memoraxCodeHome,
    env: options.env,
    traceContext,
    type: "turn_end",
    source: "dsh-hook",
    operation: "reply",
    ok: true,
    outcome,
    response: {
      assistantMessage: assistantText,
    },
  }), options.diagnosticLogger);
  await recordTraceBestEffort("dsh_memory_hook.current_turn_close", markCurrentDshTurnOutcome(
    traceContext,
    outcome,
    {
      memoraxCodeHome: options.memoraxCodeHome,
      env: options.env,
    },
  ), options.diagnosticLogger);
}

async function recordDshTurnInterrupted(
  options: DshMemoryHookRuntimeOptions,
  traceContext: TraceContext | undefined,
): Promise<void> {
  await recordTraceBestEffort("dsh_memory_hook.turn_end_event", recordDshTraceEvent({
    eventId: traceTurnEventId(traceContext, "turn_end"),
    memoraxCodeHome: options.memoraxCodeHome,
    env: options.env,
    traceContext,
    type: "turn_end",
    source: "dsh-hook",
    operation: "reply",
    ok: true,
    outcome: "interrupted",
  }), options.diagnosticLogger);
  await recordTraceBestEffort("dsh_memory_hook.current_turn_close", markCurrentDshTurnOutcome(
    traceContext,
    "interrupted",
    {
      memoraxCodeHome: options.memoraxCodeHome,
      env: options.env,
    },
  ), options.diagnosticLogger);
}

function traceContextForWriteback(
  request: DshMemoryHookWritebackRequest,
  entry: MemoryTurnState | undefined,
): TraceContext | undefined {
  if (!entry?.traceContext) return request.traceContext;
  if (!request.traceContext) return entry.traceContext;
  return {
    ...entry.traceContext,
    ...request.traceContext,
    transcriptPath: request.traceContext.transcriptPath ?? entry.traceContext.transcriptPath,
    cwd: request.traceContext.cwd ?? entry.traceContext.cwd,
    workspaceKind: request.traceContext.workspaceKind ?? entry.traceContext.workspaceKind,
  };
}

function dshTurnKey(sessionId: string, turnId: string) {
  return {
    client: DSH_MEMORY_TURN_CLIENT,
    sessionId,
    clientTurnId: turnId,
  } as const;
}

function dshPromptMatches(startedPrompt: string, userText: string): boolean {
  return userText === startedPrompt || userText.startsWith(startedPrompt);
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

function skipped(reason: DshMemoryHookWritebackSkipReason): DshMemoryHookWritebackResult {
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
    diagnosticLogger?.("dsh_trace.write_failed", {
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
