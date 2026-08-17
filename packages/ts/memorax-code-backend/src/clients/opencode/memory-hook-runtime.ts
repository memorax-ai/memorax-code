import {
  createAutomaticMemoryWritebackRuntime,
  type AutomaticMemoryWritebackEnqueue,
  type AutomaticMemoryWritebackRejectionReason,
  type AutomaticMemoryWritebackRuntime,
} from "../../memory/automatic-writeback.js";
import { retrieveAutomaticMemoryContext } from "../../memory/automatic-retrieval.js";
import type {
  MemoryHookTurnStartResult,
  OpenCodeTurnStartCommand,
  OpenCodeWritebackCommand,
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
import { traceContextFromOpenCodeHookBody, type TraceContext } from "../../trace/context.js";
import {
  markCurrentTraceTurnOutcome,
  recordTraceEvent,
  traceTurnEventId,
  writeCurrentTraceTurn,
} from "../../trace/store.js";
import {
  openCodeMessageTurn,
  type OpenCodeMessageTurnFailureReason,
} from "./message-turn.js";

export type OpenCodeMemoryHookWritebackSkipReason =
  | "turn_metadata_mismatch"
  | "interrupted"
  | "config_missing"
  | OpenCodeMessageTurnFailureReason
  | RepositoryMemoryScopeFailureReason
  | AutomaticMemoryWritebackRejectionReason;

export type OpenCodeMemoryHookWritebackResult =
  | { ok: true; scheduled: true }
  | { ok: true; scheduled: false; reason: OpenCodeMemoryHookWritebackSkipReason };

export type OpenCodeMemoryHookRuntimeOptions = {
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

export type OpenCodeMemoryHookRuntime = {
  recordTurnStart(command: OpenCodeTurnStartCommand): Promise<MemoryHookTurnStartResult>;
  writeback(command: OpenCodeWritebackCommand): Promise<OpenCodeMemoryHookWritebackResult>;
  size(): number;
  close(): void;
};

const OPENCODE_MEMORY_TURN_CLIENT = "opencode" as const;

export function createOpenCodeMemoryHookRuntime(
  options: OpenCodeMemoryHookRuntimeOptions = {},
): OpenCodeMemoryHookRuntime {
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
  const retrievalTurns = new Set<string>();
  const retrievalTurnLimit = positiveInteger(options.maxEntries, 256);

  return {
    async recordTurnStart(command) {
      turnCoordinator.pruneExpired();
      const createdAt = now();
      const traceContext = traceContextFromOpenCodeHookBody(command, new Date(createdAt).toISOString());
      const repositoryMemory = await resolveHookRepositoryMemory(
        command,
        options,
        repositoryMemorySession,
      );
      const repoMemoryWorktree = resolvedRepoMemoryWorktree(repositoryMemory);
      turnCoordinator.recordTurnStart({
        client: OPENCODE_MEMORY_TURN_CLIENT,
        sessionId: command.sessionId,
        clientTurnId: command.userMessageId,
        cwd: command.cwd,
        workspaceKind: command.workspaceKind,
        createdAt,
        traceContext,
        repositoryMemory,
      });
      await recordTraceBestEffort("opencode_memory.turn_start_event", recordTraceEvent({
        eventId: traceTurnEventId(traceContext, "turn_start"),
        memoraxCodeHome: options.memoraxCodeHome,
        env: options.env,
        traceContext,
        type: "turn_start",
        source: "opencode-plugin",
        operation: "query",
        ok: true,
        request: {
          prompt: command.prompt,
          cwd: command.cwd,
        },
      }), options.diagnosticLogger);
      await recordTraceBestEffort("opencode_memory.current_turn_write", writeCurrentTraceTurn(
        traceContext,
        {
          client: "opencode",
          memoraxCodeHome: options.memoraxCodeHome,
          env: options.env,
          now: () => new Date(now()),
        },
      ), options.diagnosticLogger);
      options.diagnosticLogger?.("opencode_memory.turn_start", {
        sessionId: command.sessionId,
        userMessageId: command.userMessageId,
        cacheSize: turnCoordinator.size(OPENCODE_MEMORY_TURN_CLIENT),
        workspace: repositoryMemory.ok ? repositoryMemory.memory.scope?.repositorySlug : undefined,
        workspaceScopeReason: repositoryMemory.ok ? undefined : repositoryMemory.reason,
      });

      const retrievalKey = JSON.stringify([command.sessionId, command.userMessageId]);
      if (retrievalTurns.has(retrievalKey)) {
        return {
          ok: true,
          ...(repoMemoryWorktree ? { repoMemoryWorktree } : {}),
        };
      }
      retrievalTurns.add(retrievalKey);
      while (retrievalTurns.size > retrievalTurnLimit) {
        const oldest = retrievalTurns.values().next().value;
        if (typeof oldest !== "string") break;
        retrievalTurns.delete(oldest);
      }
      const retrieval = await retrieveAutomaticMemoryContext({
        diagnosticLogger: options.diagnosticLogger,
        env: options.env ?? process.env,
        fetchImpl: options.fetchImpl,
        memoryObservability: options.memoryObservability,
        memoryObservabilitySource: "opencode_plugin_retrieval",
        query: command.prompt,
        repositoryMemory,
        sessionKey: command.sessionId,
        traceContext,
      });
      return {
        ok: true,
        ...(repoMemoryWorktree ? { repoMemoryWorktree } : {}),
        ...(retrieval.context ? { additionalContext: retrieval.context } : {}),
      };
    },
    async writeback(command) {
      turnCoordinator.pruneExpired();
      const key = openCodeTurnKey(command.sessionId, command.userMessageId);
      const entry = turnCoordinator.getTurn(key);
      const materialized = openCodeMessageTurn(command.messages, command);
      if (!materialized.ok) {
        options.diagnosticLogger?.("opencode_memory.writeback", {
          scheduled: false,
          reason: materialized.reason,
          sessionId: command.sessionId,
          userMessageId: command.userMessageId,
          assistantMessageId: command.assistantMessageId,
        });
        return { ok: true, scheduled: false, reason: materialized.reason };
      }
      if (materialized.turn.outcome === "interrupted") {
        if (!entry) {
          options.diagnosticLogger?.("opencode_memory.writeback", {
            scheduled: false,
            reason: "turn_metadata_mismatch",
            sessionId: command.sessionId,
            userMessageId: command.userMessageId,
            assistantMessageId: command.assistantMessageId,
          });
          return { ok: true, scheduled: false, reason: "turn_metadata_mismatch" };
        }
        const traceContext = entry.traceContext;
        await recordTraceBestEffort("opencode_memory.interrupted_turn_end_event", recordTraceEvent({
          eventId: traceTurnEventId(traceContext, "turn_end"),
          memoraxCodeHome: options.memoraxCodeHome,
          env: options.env,
          traceContext,
          type: "turn_end",
          source: "opencode-plugin",
          operation: "reply",
          ok: true,
          outcome: "interrupted",
          response: {
            assistantMessage: materialized.turn.assistantReply,
          },
        }), options.diagnosticLogger);
        await recordTraceBestEffort(
          "opencode_memory.interrupted_current_turn_close",
          markCurrentTraceTurnOutcome(traceContext, "interrupted", {
            client: "opencode",
            memoraxCodeHome: options.memoraxCodeHome,
            env: options.env,
          }),
          options.diagnosticLogger,
        );
        turnCoordinator.discardTurn(key, "interrupted");
        options.diagnosticLogger?.("opencode_memory.writeback", {
          scheduled: false,
          reason: "interrupted",
          metadataDisposition: "consumed",
          sessionId: command.sessionId,
          userMessageId: command.userMessageId,
          assistantMessageId: command.assistantMessageId,
        });
        return { ok: true, scheduled: false, reason: "interrupted" };
      }
      const traceContext = entry?.traceContext
        ?? traceContextFromOpenCodeHookBody(command, new Date(now()).toISOString());
      await recordTraceBestEffort("opencode_memory.turn_end_event", recordTraceEvent({
        eventId: traceTurnEventId(traceContext, "turn_end"),
        memoraxCodeHome: options.memoraxCodeHome,
        env: options.env,
        traceContext,
        type: "turn_end",
        source: "opencode-plugin",
        operation: "writeback",
        ok: true,
        outcome: materialized.turn.outcome,
        response: {
          content: materialized.turn.assistantReply,
        },
      }), options.diagnosticLogger);
      await recordTraceBestEffort("opencode_memory.current_turn_close", markCurrentTraceTurnOutcome(
        traceContext,
        "completed",
        {
          client: "opencode",
          memoraxCodeHome: options.memoraxCodeHome,
          env: options.env,
        },
      ), options.diagnosticLogger);
      const writeback = await turnCoordinator.completeMaterializedTurn({
        key,
        metadata: entry,
        resolveRepositoryMemory: () => resolveCurrentHookRepositoryMemory(
          entry,
          command,
          options,
          repositoryMemorySession,
        ),
        userText: materialized.turn.userPrompt,
        assistantText: materialized.turn.assistantReply,
        writeback: {
          client: OPENCODE_MEMORY_TURN_CLIENT,
          sessionKey: command.sessionId,
          env: options.env ?? process.env,
          fetchImpl: options.fetchImpl,
          memoryObservability: options.memoryObservability,
          memoryObservabilitySource: "opencode_plugin_writeback",
          traceContext,
        },
      });
      if (!writeback.scheduled) {
        options.diagnosticLogger?.("opencode_memory.writeback", {
          scheduled: false,
          reason: writeback.reason,
          metadataDisposition: writeback.metadataDisposition,
          sessionId: command.sessionId,
          userMessageId: command.userMessageId,
          assistantMessageId: command.assistantMessageId,
        });
        return { ok: true, scheduled: false, reason: writeback.reason };
      }
      options.diagnosticLogger?.("opencode_memory.writeback", {
        scheduled: true,
        metadataDisposition: writeback.metadataDisposition,
        sessionId: command.sessionId,
        userMessageId: command.userMessageId,
        assistantMessageId: command.assistantMessageId,
        promptChars: materialized.turn.userPrompt.length,
        assistantChars: materialized.turn.assistantReply.length,
        contentSource: "opencode_sdk_messages",
      });
      return { ok: true, scheduled: true };
    },
    size() {
      return turnCoordinator.size(OPENCODE_MEMORY_TURN_CLIENT);
    },
    close() {
      retrievalTurns.clear();
      if (ownsTurnCoordinator) turnCoordinator.close();
      if (ownsRepositoryMemorySession) repositoryMemorySession.close();
      automaticWritebackRuntime?.close?.();
    },
  };
}

function openCodeTurnKey(sessionId: string, userMessageId: string) {
  return {
    client: OPENCODE_MEMORY_TURN_CLIENT,
    sessionId,
    clientTurnId: userMessageId,
  } as const;
}

async function resolveHookRepositoryMemory(
  command: OpenCodeTurnStartCommand,
  options: OpenCodeMemoryHookRuntimeOptions,
  repositoryMemorySession: RepositoryMemorySessionRuntime,
): Promise<ConfiguredRepositoryMemoryResult> {
  return await repositoryMemorySession.resolve({
    client: OPENCODE_MEMORY_TURN_CLIENT,
    sessionId: command.sessionId,
    workspaceRoot: command.cwd,
    workspaceKind: command.workspaceKind,
    memoraxCodeHome: options.memoraxCodeHome ?? options.env?.MEMORAX_CODE_HOME,
    env: options.env,
  });
}

async function resolveCurrentHookRepositoryMemory(
  entry: MemoryTurnState | undefined,
  command: OpenCodeWritebackCommand,
  options: OpenCodeMemoryHookRuntimeOptions,
  repositoryMemorySession: RepositoryMemorySessionRuntime,
): Promise<ConfiguredRepositoryMemoryResult> {
  return await repositoryMemorySession.resolve({
    client: OPENCODE_MEMORY_TURN_CLIENT,
    sessionId: command.sessionId,
    workspaceRoot: command.cwd ?? entry?.cwd,
    workspaceKind: command.workspaceKind ?? entry?.workspaceKind,
    requireBoundScope: true,
    memoraxCodeHome: options.memoraxCodeHome ?? options.env?.MEMORAX_CODE_HOME,
    env: options.env,
  });
}

async function recordTraceBestEffort(
  label: string,
  promise: Promise<unknown>,
  diagnosticLogger?: MemoryDiagnosticLogger,
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    diagnosticLogger?.("opencode_trace.write_failed", {
      label,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
