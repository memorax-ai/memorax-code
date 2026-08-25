import { retrieveAutomaticMemoryContext } from "../../memory/automatic-retrieval.js";
import type {
  KimiTurnStartCommand,
  KimiWritebackCommand,
  MemoryHookTurnStartResult,
} from "../../memory/hook-command.js";
import {
  resolvedRepoMemoryWorktree,
  type RepositoryMemorySessionRuntime,
} from "../../memory/repository-session.js";
import type { MemoryDiagnosticLogger, MemoryObservabilityHook } from "../../memory/observability.js";
import type { AutomaticMemoryWritebackRejectionReason } from "../../memory/automatic-writeback.js";
import type { RepositoryMemoryScopeFailureReason } from "../../repository/scope.js";
import type { MemoryTurnCoordinator } from "../../memory/turn-coordinator.js";
import { readKimiWireTurn, type KimiWireTurnFailureReason } from "./wire-turn.js";
import { traceContextFromKimiHookBody, type TraceContext } from "../../trace/context.js";
import {
  clearKimiOperationalTurn,
  readKimiOperationalTurn,
  writeKimiOperationalTurn,
} from "./operational-turn.js";
import {
  markCurrentTraceTurnOutcome,
  readCurrentTraceTurn,
  recordTraceEvent,
  traceTurnEventId,
  writeCurrentTraceTurn,
} from "../../trace/store.js";

const MAX_AUTOMATIC_RETRIEVAL_PROMPTS = 256;

export type KimiMemoryHookRuntimeOptions = {
  diagnosticLogger?: MemoryDiagnosticLogger;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  memoryObservability?: MemoryObservabilityHook;
  memoraxCodeHome?: string;
  repositoryMemorySession: RepositoryMemorySessionRuntime;
  turnCoordinator: MemoryTurnCoordinator;
};

export type KimiMemoryHookWritebackResult =
  | { ok: true; scheduled: true }
  | {
    ok: true;
    scheduled: false;
    reason: KimiWireTurnFailureReason | RepositoryMemoryScopeFailureReason
      | AutomaticMemoryWritebackRejectionReason | "config_missing" | "turn_metadata_mismatch";
  };

export type KimiMemoryHookRuntime = {
  recordTurnStart(command: KimiTurnStartCommand): Promise<MemoryHookTurnStartResult>;
  writeback(command: KimiWritebackCommand): Promise<KimiMemoryHookWritebackResult>;
  close(): void;
};

export function createKimiMemoryHookRuntime(
  options: KimiMemoryHookRuntimeOptions,
): KimiMemoryHookRuntime {
  const { repositoryMemorySession, turnCoordinator } = options;
  const automaticRetrievalPrompts = new Set<string>();
  return {
    async recordTurnStart(command) {
      const createdAt = Date.now();
      const traceContext = traceContextFromKimiHookBody(command, new Date(createdAt).toISOString());
      turnCoordinator.pruneExpired();
      const repositoryMemory = await repositoryMemorySession.resolve({
        client: "kimi",
        sessionId: command.sessionId,
        workspaceRoot: command.cwd,
        workspaceKind: command.workspaceKind,
        memoraxCodeHome: options.memoraxCodeHome,
        env: options.env,
      });
      turnCoordinator.recordTurnStart({
        client: "kimi",
        sessionId: command.sessionId,
        clientTurnId: command.promptId,
        cwd: command.cwd,
        workspaceKind: command.workspaceKind,
        createdAt,
        traceContext,
        repositoryMemory,
      });
      if (repositoryMemory.ok && repositoryMemory.memory.scope?.boundWorkspaceRoot) {
        writeKimiOperationalTurn(options.memoraxCodeHome, {
          sessionId: command.sessionId,
          promptId: command.promptId,
          cwd: repositoryMemory.memory.scope.boundWorkspaceRoot,
          ...(repositoryMemory.memory.scope.scopeKind === "codex-projectless"
            ? { workspaceKind: "projectless" }
            : {}),
        });
      }
      await recordTraceBestEffort("kimi_memory_hook.turn_start_event", recordTraceEvent({
        eventId: traceTurnEventId(traceContext, "turn_start"),
        memoraxCodeHome: options.memoraxCodeHome,
        env: options.env,
        traceContext,
        type: "turn_start",
        source: "kimi-hook",
        operation: "query",
        ok: true,
        request: { prompt: command.prompt, cwd: command.cwd },
      }), options.diagnosticLogger);
      await recordTraceBestEffort("kimi_memory_hook.current_turn_write", writeCurrentTraceTurn(traceContext, {
        client: "kimi",
        memoraxCodeHome: options.memoraxCodeHome,
        env: options.env,
        now: () => new Date(createdAt),
      }), options.diagnosticLogger);
      const repoMemoryWorktree = resolvedRepoMemoryWorktree(repositoryMemory);
      if (!claimAutomaticRetrievalPrompt(automaticRetrievalPrompts, command.sessionId, command.promptId)) {
        return {
          ok: true,
          ...(repoMemoryWorktree ? { repoMemoryWorktree } : {}),
        };
      }
      const retrieval = await retrieveAutomaticMemoryContext({
        diagnosticLogger: options.diagnosticLogger,
        env: options.env,
        fetchImpl: options.fetchImpl,
        memoryObservability: options.memoryObservability,
        memoryObservabilitySource: "kimi_hook_retrieval",
        query: command.prompt,
        repositoryMemory,
        sessionKey: command.sessionId,
        traceContext,
      });
      options.diagnosticLogger?.("kimi_memory_hook.turn_start", {
        sessionId: command.sessionId,
        retrieved: retrieval.retrieved,
        itemCount: retrieval.itemCount,
      });
      return {
        ok: true,
        ...(repoMemoryWorktree ? { repoMemoryWorktree } : {}),
        ...(retrieval.context ? { additionalContext: retrieval.context } : {}),
      };
    },
    async writeback(command) {
      turnCoordinator.pruneExpired();
      const key = {
        client: "kimi" as const,
        sessionId: command.sessionId,
        clientTurnId: command.promptId,
      };
      const entry = turnCoordinator.getTurn(key);
      const recoveredTraceContext = !entry
        ? await recoverExactCurrentTurnTraceContext(command, options)
        : undefined;
      const materialized = await readKimiWireTurn(command);
      if (!materialized.ok) {
        if ([
          "cancelled",
          "assistant_message_missing",
          "malformed_record",
          "prompt_identity_mismatch",
          "wire_identity_mismatch",
        ].includes(materialized.reason)) {
          clearKimiOperationalTurn(options.memoraxCodeHome, command.sessionId, command.promptId);
        }
        if (materialized.reason === "cancelled") {
          releaseAutomaticRetrievalPrompt(automaticRetrievalPrompts, command.sessionId, command.promptId);
          const traceContext = traceContextForWriteback(command, entry, recoveredTraceContext);
          await recordTurnEnd(options, traceContext, undefined, "interrupted");
          turnCoordinator.discardTurn(key, "interrupted");
        }
        options.diagnosticLogger?.("kimi_memory_hook.writeback", {
          scheduled: false,
          reason: materialized.reason,
          sessionId: command.sessionId,
          turnId: command.turnId,
        });
        return { ok: true, scheduled: false, reason: materialized.reason };
      }
      const traceContext = traceContextForWriteback(command, entry, recoveredTraceContext);
      await recordTurnEnd(options, traceContext, materialized.turn.assistantReply);
      releaseAutomaticRetrievalPrompt(automaticRetrievalPrompts, command.sessionId, command.promptId);
      const writeback = await turnCoordinator.completeMaterializedTurn({
        key,
        metadata: entry,
        resolveRepositoryMemory: () => resolveCurrentKimiRepositoryMemory(
          command,
          entry,
          recoveredTraceContext,
          options,
          repositoryMemorySession,
        ),
        userText: materialized.turn.userPrompt,
        assistantText: materialized.turn.assistantReply,
        writeback: {
          client: "kimi",
          sessionKey: command.sessionId,
          env: options.env ?? process.env,
          fetchImpl: options.fetchImpl,
          memoryObservability: options.memoryObservability,
          memoryObservabilitySource: "kimi_hook_writeback",
          traceContext,
        },
      });
      if (!writeback.scheduled) {
        return { ok: true, scheduled: false, reason: writeback.reason };
      }
      clearKimiOperationalTurn(options.memoraxCodeHome, command.sessionId, command.promptId);
      options.diagnosticLogger?.("kimi_memory_hook.writeback", {
        scheduled: true,
        sessionId: command.sessionId,
        turnId: command.turnId,
        contentSource: "kimi_main_wire",
      });
      return { ok: true, scheduled: true };
    },
    close() {},
  };
}

async function resolveCurrentKimiRepositoryMemory(
  command: KimiWritebackCommand,
  entry: ReturnType<MemoryTurnCoordinator["getTurn"]>,
  recoveredTraceContext: TraceContext | undefined,
  options: KimiMemoryHookRuntimeOptions,
  repositoryMemorySession: RepositoryMemorySessionRuntime,
) {
  const common = {
    client: "kimi" as const,
    sessionId: command.sessionId,
    memoraxCodeHome: options.memoraxCodeHome,
    env: options.env,
  };
  if (entry) {
    return await repositoryMemorySession.resolve({
      ...common,
      workspaceRoot: command.cwd ?? entry.cwd,
      workspaceKind: command.workspaceKind ?? entry.workspaceKind,
      requireBoundScope: true,
    });
  }
  if (!recoveredTraceContext?.cwd && recoveredTraceContext?.workspaceKind?.trim().toLowerCase() !== "projectless") {
    return await repositoryMemorySession.resolve({
      ...common,
      workspaceRoot: command.cwd,
      workspaceKind: command.workspaceKind,
      requireBoundScope: true,
    });
  }
  const recovered = await repositoryMemorySession.resolve({
    ...common,
    workspaceRoot: recoveredTraceContext.cwd,
    workspaceKind: recoveredTraceContext.workspaceKind,
    requireBoundScope: false,
  });
  if (!recovered.ok || (!command.cwd && !command.workspaceKind)) return recovered;
  return await repositoryMemorySession.resolve({
    ...common,
    workspaceRoot: command.cwd ?? recoveredTraceContext.cwd,
    workspaceKind: command.workspaceKind ?? recoveredTraceContext.workspaceKind,
    requireBoundScope: true,
  });
}

async function recordTurnEnd(
  options: KimiMemoryHookRuntimeOptions,
  traceContext: TraceContext | undefined,
  assistantMessage: string | undefined,
  outcome: "completed" | "interrupted" = "completed",
): Promise<void> {
  const eventId = traceTurnEventId(traceContext, "turn_end");
  const recorded = await recordTraceBestEffort("kimi_memory_hook.turn_end_event", recordTraceEvent({
    eventId,
    memoraxCodeHome: options.memoraxCodeHome,
    env: options.env,
    traceContext,
    type: "turn_end",
    source: "kimi-hook",
    operation: "reply",
    ok: outcome === "completed",
    outcome,
    ...(assistantMessage ? { response: { assistantMessage } } : {}),
  }), options.diagnosticLogger);
  if (recorded?.written && assistantMessage) {
    await recordTraceBestEffort("kimi_memory_hook.turn_materialized_event", recordTraceEvent({
      eventId: traceTurnEventId(traceContext, "turn_materialized"),
      memoraxCodeHome: options.memoraxCodeHome,
      env: options.env,
      traceContext,
      type: "turn_materialized",
      source: "kimi-main-wire",
      operation: "reply",
      ok: true,
      outcome,
      response: { assistantMessage },
    }), options.diagnosticLogger);
  }
  await recordTraceBestEffort("kimi_memory_hook.current_turn_close", markCurrentTraceTurnOutcome(
    traceContext,
    outcome,
    { client: "kimi", memoraxCodeHome: options.memoraxCodeHome, env: options.env },
  ), options.diagnosticLogger);
}

function traceContextForWriteback(
  command: KimiWritebackCommand,
  entry: ReturnType<MemoryTurnCoordinator["getTurn"]>,
  recovered?: TraceContext,
): TraceContext | undefined {
  const authoritative = entry?.traceContext ?? recovered;
  const request = traceContextFromKimiHookBody(command);
  if (!authoritative) return request;
  return {
    ...authoritative,
    ...(request ?? {}),
    turnId: authoritative.turnId ?? request?.turnId,
    nativeRequestId: request?.nativeRequestId ?? authoritative.nativeRequestId,
    cwd: request?.cwd ?? authoritative.cwd,
    memoryProject: request?.memoryProject ?? authoritative.memoryProject,
    workspaceKind: request?.workspaceKind ?? authoritative.workspaceKind,
  };
}

async function recoverExactCurrentTurnTraceContext(
  command: KimiWritebackCommand,
  options: KimiMemoryHookRuntimeOptions,
): Promise<TraceContext | undefined> {
  const current = await readCurrentTraceTurn({
    client: "kimi",
    memoraxCodeHome: options.memoraxCodeHome,
    env: options.env,
    expectedSessionId: command.sessionId,
    allowStale: true,
  });
  if (current.ok) {
    if (current.traceContext.turnId !== command.promptId) return undefined;
    if (current.traceContext.nativeRequestId && current.traceContext.nativeRequestId !== command.turnId) return undefined;
    return current.traceContext;
  }
  const operational = readKimiOperationalTurn(options.memoraxCodeHome, command.sessionId, command.promptId);
  if (!operational) return undefined;
  return {
    schemaVersion: "1",
    client: "kimi",
    sessionId: operational.sessionId,
    turnId: operational.promptId,
    nativeRequestId: command.turnId,
    cwd: operational.cwd,
    ...(operational.workspaceKind ? { workspaceKind: operational.workspaceKind } : {}),
    contextOrigin: "current-turn-file",
    capturedAt: new Date(operational.updatedAt || Date.now()).toISOString(),
  };
}

async function recordTraceBestEffort(
  label: string,
  promise: Promise<unknown>,
  diagnosticLogger?: MemoryDiagnosticLogger,
): Promise<any> {
  try {
    return await promise;
  } catch (error) {
    diagnosticLogger?.("memory_trace.write_failed", {
      label,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

function claimAutomaticRetrievalPrompt(
  prompts: Set<string>,
  sessionId: string,
  promptId: string,
): boolean {
  const key = kimiRetrievalPromptKey(sessionId, promptId);
  if (prompts.has(key)) return false;
  prompts.add(key);
  while (prompts.size > MAX_AUTOMATIC_RETRIEVAL_PROMPTS) {
    const oldest = prompts.values().next().value;
    if (typeof oldest !== "string") break;
    prompts.delete(oldest);
  }
  return true;
}

function releaseAutomaticRetrievalPrompt(
  prompts: Set<string>,
  sessionId: string,
  promptId: string,
): void {
  prompts.delete(kimiRetrievalPromptKey(sessionId, promptId));
}

function kimiRetrievalPromptKey(sessionId: string, promptId: string): string {
  return JSON.stringify([sessionId, promptId]);
}
