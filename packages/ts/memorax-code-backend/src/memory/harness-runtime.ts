import { retrieveAutomaticMemoryContext } from "./automatic-retrieval.js";
import type { CodingSessionSourceTurn } from "../coding-sessions/coding-turn.js";
import {
  createCodingSessionUploadRuntime,
  type CodingSessionUploadEnqueue,
} from "../coding-sessions/upload.js";
import {
  createAutomaticMemoryWritebackRuntime,
  type AutomaticMemoryWritebackEnqueue,
  type AutomaticMemoryWritebackRuntime,
  type AutomaticMemoryWritebackTiming,
} from "./automatic-writeback.js";
import type { MemoryHookTurnStartResult } from "./hook-command.js";
import type {
  MemoryDiagnosticLogger,
  MemoryObservabilityHook,
  MemoryObservabilitySource,
} from "./observability.js";
import {
  claimQuotaNotice,
  createPendingQuotaNoticeRuntime,
  type PendingQuotaNoticeRuntime,
  type QuotaNoticeClaimer,
} from "./quota-notice.js";
import {
  createRepositoryMemorySessionRuntime,
  resolvedRepoMemoryWorktree,
  type ConfiguredRepositoryMemoryResult,
  type RepositoryMemorySessionRuntime,
  type RepositoryMemorySessionRequest,
} from "./repository-session.js";
import {
  createMemoryTurnCoordinator,
  type MemoryTurnClient,
  type MemoryTurnCoordinator,
  type MemoryTurnStart,
  type MemoryTurnState,
  type MemoryTurnWritebackResult,
} from "./turn-coordinator.js";
import type { TraceContext } from "../trace/context.js";
import { recordTraceEvent, traceTurnEventId, writeCurrentTraceTurn } from "../trace/store.js";

export type HarnessMemoryRuntimeOptions = {
  automaticWriteback?: AutomaticMemoryWritebackEnqueue;
  captureCodingTurns?: boolean;
  codingSessionUpload?: CodingSessionUploadEnqueue;
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
};

export type HarnessMemoryDefinition = Readonly<{
  client: MemoryTurnClient;
  retrievalSource: MemoryObservabilitySource;
  writebackSource: MemoryObservabilitySource;
  diagnosticPrefix: string;
  traceFailureEvent: string;
  turnStartTraceSource?: string;
  deduplicateRetrieval: boolean;
  quotaNotices?: boolean;
}>;

export type HarnessTurnStart = Omit<MemoryTurnStart, "client" | "clientTurnId" | "repositoryMemory"> & Readonly<{
  // Uncorrelated start observations may update trace, but cannot register a
  // writable Turn or trigger retrieval.
  clientTurnId?: string;
  prompt: string;
  repositoryMemory?: ConfiguredRepositoryMemoryResult;
  retrievalTraceContext?: TraceContext;
  // Native event boundaries may distinguish retrieval attempts within one Turn.
  retrievalKeySuffix?: string;
  // Replaces the default request when live prompt text is not trace authority.
  traceRequest?: Record<string, unknown>;
  diagnosticFields?: Record<string, unknown>;
  // Publish the registered state synchronously, before trace or retrieval can
  // yield to a concurrent completion.
  onTurnRegistered?: (turn: MemoryTurnState) => void;
}>;

// Only client-specific materializers may supply completion content. A terminal
// Hook signal or a trace record alone does not establish this input.
export type HarnessTurnCompletion = Readonly<AutomaticMemoryWritebackTiming & {
  sessionId: string;
  clientTurnId: string;
  metadata?: MemoryTurnState;
  userText: string;
  assistantText: string;
  codingTurn?: CodingSessionSourceTurn;
  traceContext?: TraceContext;
  resolveRepositoryMemory: () => Promise<ConfiguredRepositoryMemoryResult>;
}>;

export type HarnessMemoryRuntime = ReturnType<typeof createHarnessMemoryRuntime>;

export function createHarnessMemoryRuntime(
  definition: HarnessMemoryDefinition,
  options: HarnessMemoryRuntimeOptions = {},
) {
  const now = options.now ?? (() => Date.now());
  const pendingQuotaNotice = definition.quotaNotices === false ? undefined : options.pendingQuotaNotice ?? createPendingQuotaNoticeRuntime({
    claimQuotaNotice: options.claimQuotaNotice,
    diagnosticLogger: options.diagnosticLogger,
    env: options.env,
  });
  const automaticWriteback: {
    enqueue: AutomaticMemoryWritebackEnqueue;
    discardForScopeUpgrade?: AutomaticMemoryWritebackRuntime["discardForScopeUpgrade"];
    close?: () => void;
  } | undefined = options.turnCoordinator
    ? undefined
    : options.automaticWriteback
      ? { enqueue: options.automaticWriteback }
      : createAutomaticMemoryWritebackRuntime({
        diagnosticLogger: options.diagnosticLogger,
        queueQuotaNotice: pendingQuotaNotice?.queue,
      });
  const codingUpload = options.turnCoordinator
    ? undefined
    : options.codingSessionUpload
      ? { enqueue: options.codingSessionUpload }
      : createCodingSessionUploadRuntime({
        enabled: options.captureCodingTurns === true,
        diagnosticLogger: options.diagnosticLogger,
      });
  const turnCoordinator = options.turnCoordinator ?? createMemoryTurnCoordinator({
    automaticWriteback: automaticWriteback!.enqueue,
    codingSessionUpload: codingUpload?.enqueue,
    now,
    ttlMs: options.ttlMs,
    maxEntries: options.maxEntries,
    cleanupIntervalMs: options.cleanupIntervalMs,
  });
  const repositoryMemorySession = options.repositoryMemorySession ?? createRepositoryMemorySessionRuntime({
    onScopeUpgrade(upgrade) {
      automaticWriteback?.discardForScopeUpgrade?.(upgrade);
      if (codingUpload && "discardForScopeUpgrade" in codingUpload) codingUpload.discardForScopeUpgrade(upgrade);
    },
  });
  const retrievalTurns = new Set<string>();
  const retrievalTurnLimit = positiveInteger(options.maxEntries, 256);

  function resolveRepositoryMemory(input: { sessionId: string; cwd?: string; workspaceKind?: string; requireBoundScope?: boolean; restoreScope?: RepositoryMemorySessionRequest["restoreScope"] }) {
    return repositoryMemorySession.resolve({
      client: definition.client,
      sessionId: input.sessionId,
      workspaceRoot: input.cwd,
      workspaceKind: input.workspaceKind,
      requireBoundScope: input.requireBoundScope,
      restoreScope: input.restoreScope,
      memoraxCodeHome: options.memoraxCodeHome ?? options.env?.MEMORAX_CODE_HOME,
      env: options.env,
    });
  }

  async function recordTraceBestEffort(label: string, operation: Promise<unknown>) {
    try {
      await operation;
    } catch (error) {
      options.diagnosticLogger?.(definition.traceFailureEvent, {
        label: `${definition.diagnosticPrefix}.${label}`,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    turnCoordinator,
    resolveRepositoryMemory,
    async recordTurnStart(input: HarnessTurnStart): Promise<MemoryHookTurnStartResult> {
      validateTraceIdentity(definition.client, input, input.traceContext);
      validateTraceIdentity(definition.client, input, input.retrievalTraceContext);
      const {
        prompt, retrievalTraceContext, retrievalKeySuffix, traceRequest,
        diagnosticFields, onTurnRegistered, repositoryMemory: resolvedMemory, ...turn
      } = input;
      const repositoryMemory = resolvedMemory ?? await resolveRepositoryMemory(input);
      if (turn.clientTurnId) {
        const state = turnCoordinator.recordTurnStart({ ...turn, client: definition.client, clientTurnId: turn.clientTurnId, repositoryMemory });
        onTurnRegistered?.(state);
      }
      if (diagnosticFields) {
        options.diagnosticLogger?.(`${definition.diagnosticPrefix}.turn_start`, {
          ...diagnosticFields,
          cacheSize: turnCoordinator.size(definition.client),
          workspace: repositoryMemory.ok ? repositoryMemory.memory.scope?.repositorySlug : undefined,
          workspaceScopeReason: repositoryMemory.ok ? undefined : repositoryMemory.reason,
        });
      }
      await recordTraceBestEffort("turn_start_event", recordTraceEvent({
        eventId: traceTurnEventId(turn.traceContext, "turn_start"),
        memoraxCodeHome: options.memoraxCodeHome,
        env: options.env,
        traceContext: turn.traceContext,
        type: "turn_start",
        source: definition.turnStartTraceSource ?? "unknown",
        operation: "query",
        ok: true,
        sessionTurnIndex: turn.sessionTurnIndex,
        request: traceRequest ?? { prompt, cwd: turn.cwd, transcriptPath: turn.transcriptPath },
      }));
      const scope = repositoryMemory.ok ? repositoryMemory.memory.scope : undefined;
      // Later hooks may omit the default-chat hint or run in a child directory.
      // Keep the validated General binding in the operational CLI bridge while
      // the event above retains the original native cwd and workspace kind.
      const currentTurnContext = turn.traceContext && scope?.scopeKind === "general"
        ? { ...turn.traceContext, cwd: scope.boundWorkspaceRoot, workspaceKind: "projectless" }
        : turn.traceContext;
      await recordTraceBestEffort("current_turn_write", writeCurrentTraceTurn(currentTurnContext, {
        memoraxCodeHome: options.memoraxCodeHome,
        env: options.env,
        now: () => new Date(now()),
      }));
      const repoMemoryWorktree = resolvedRepoMemoryWorktree(repositoryMemory);
      if (!turn.clientTurnId || (definition.deduplicateRetrieval && !claimRetrievalTurn(retrievalTurns, retrievalTurnLimit, {
        sessionId: turn.sessionId,
        clientTurnId: turn.clientTurnId,
      }, retrievalKeySuffix))) {
        return { ok: true, ...(repoMemoryWorktree ? { repoMemoryWorktree } : {}) };
      }
      const pendingUserNotice = repositoryMemory.ok
        ? await pendingQuotaNotice?.claim(repositoryMemory.memory.config)
        : undefined;
      const retrieval = await retrieveAutomaticMemoryContext({
        diagnosticLogger: options.diagnosticLogger,
        claimQuotaNotice: definition.quotaNotices === false ? undefined : options.claimQuotaNotice ?? claimQuotaNotice,
        env: options.env ?? process.env,
        fetchImpl: options.fetchImpl,
        memoryObservability: options.memoryObservability,
        memoryObservabilitySource: definition.retrievalSource,
        query: prompt,
        repositoryMemory,
        sessionKey: turn.sessionId,
        traceContext: retrievalTraceContext ?? turn.traceContext,
      });
      const userNotice = [pendingUserNotice, retrieval.userNotice].filter(Boolean).join("\n");
      return {
        ok: true,
        ...(repoMemoryWorktree ? { repoMemoryWorktree } : {}),
        ...(retrieval.context ? { additionalContext: retrieval.context } : {}),
        ...(userNotice ? { userNotice } : {}),
      };
    },
    async completeTurn(input: HarnessTurnCompletion): Promise<MemoryTurnWritebackResult> {
      validateTraceIdentity(definition.client, input, input.traceContext);
      return turnCoordinator.completeMaterializedTurn({
        key: { client: definition.client, sessionId: input.sessionId, clientTurnId: input.clientTurnId },
        metadata: input.metadata,
        resolveRepositoryMemory: input.resolveRepositoryMemory,
        userText: input.userText,
        assistantText: input.assistantText,
        ...(input.codingTurn?.client === definition.client
          && input.codingTurn.sessionId === input.sessionId
          && input.codingTurn.turnId === input.clientTurnId
          ? { codingTurn: input.codingTurn } : {}),
        userTimestamp: input.userTimestamp,
        assistantTimestamp: input.assistantTimestamp,
        userTimestampSource: input.userTimestampSource,
        assistantTimestampSource: input.assistantTimestampSource,
        writeback: {
          client: definition.client,
          sessionKey: input.sessionId,
          env: options.env ?? process.env,
          fetchImpl: options.fetchImpl,
          memoryObservability: options.memoryObservability,
          memoryObservabilitySource: definition.writebackSource,
          traceContext: input.traceContext,
        },
      });
    },
    size() {
      return turnCoordinator.size(definition.client);
    },
    close() {
      retrievalTurns.clear();
      if (!options.turnCoordinator) turnCoordinator.close();
      if (!options.repositoryMemorySession) repositoryMemorySession.close();
      automaticWriteback?.close?.();
      if (codingUpload && "close" in codingUpload) codingUpload.close();
      if (!options.pendingQuotaNotice) pendingQuotaNotice?.close();
    },
  };
}

function validateTraceIdentity(
  client: MemoryTurnClient,
  turn: Pick<HarnessTurnStart, "sessionId" | "clientTurnId">,
  context: TraceContext | undefined,
): void {
  if (!context) return;
  const traceClient = client === "claude-code" ? "claude" : client;
  if (
    context.client !== traceClient
    || context.sessionId !== turn.sessionId
    || (context.turnId !== undefined && context.turnId !== turn.clientTurnId)
  ) throw new Error("harness trace identity mismatch");
}

function claimRetrievalTurn(
  turns: Set<string>,
  limit: number,
  turn: Pick<MemoryTurnStart, "sessionId" | "clientTurnId">,
  suffix?: string,
): boolean {
  const key = JSON.stringify([turn.sessionId, turn.clientTurnId, suffix]);
  if (turns.has(key)) return false;
  turns.add(key);
  while (turns.size > limit) {
    const oldest = turns.values().next().value;
    if (typeof oldest !== "string") break;
    turns.delete(oldest);
  }
  return true;
}

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
