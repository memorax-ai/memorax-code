import {
  createAutomaticMemoryWritebackRuntime,
  type AutomaticMemoryWritebackEnqueue,
  type AutomaticMemoryWritebackRejectionReason,
  type AutomaticMemoryWritebackRuntime,
} from "../../memory/automatic-writeback.js";
import { retrieveAutomaticMemoryContext } from "../../memory/automatic-retrieval.js";
import type {
  DshTurnStartCommand,
  DshWritebackCommand,
  MemoryHookTurnStartResult,
} from "../../memory/hook-command.js";
import type { MemoryDiagnosticLogger } from "../../memory/observability.js";
import {
  createRepositoryMemorySessionRuntime,
  resolvedRepoMemoryWorktree,
  type ConfiguredRepositoryMemoryResult,
  type RepositoryMemorySessionRuntime,
} from "../../memory/repository-session.js";
import {
  createMemoryTurnCoordinator,
  type MemoryTurnCoordinator,
  type MemoryTurnState,
} from "../../memory/turn-coordinator.js";
import type { RepositoryMemoryScopeFailureReason } from "../../repository/scope.js";
import {
  dshSessionEventTurn,
  type DshSessionTurnFailureReason,
} from "./session-turn.js";

export type DshMemoryHookWritebackSkipReason =
  | "turn_metadata_mismatch"
  | "config_missing"
  | DshSessionTurnFailureReason
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
  memoraxCodeHome?: string;
  repositoryMemorySession?: RepositoryMemorySessionRuntime;
  turnCoordinator?: MemoryTurnCoordinator;
};

export type DshMemoryHookRuntime = {
  recordTurnStart(command: DshTurnStartCommand): Promise<MemoryHookTurnStartResult>;
  writeback(command: DshWritebackCommand): Promise<DshMemoryHookWritebackResult>;
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
  const retrievalTurns = new Set<string>();
  const retrievalTurnLimit = positiveInteger(options.maxEntries, 256);

  return {
    async recordTurnStart(command) {
      turnCoordinator.pruneExpired();
      const repositoryMemory = await resolveHookRepositoryMemory(command, options, repositoryMemorySession);
      turnCoordinator.recordTurnStart({
        client: DSH_MEMORY_TURN_CLIENT,
        sessionId: command.sessionId,
        clientTurnId: String(command.turn),
        cwd: command.cwd,
        eventStartSeq: command.startSeq,
        createdAt: now(),
        repositoryMemory,
      });
      options.diagnosticLogger?.("dsh_memory.turn_start", {
        sessionId: command.sessionId,
        turn: command.turn,
        startSeq: command.startSeq,
        cacheSize: turnCoordinator.size(DSH_MEMORY_TURN_CLIENT),
        workspace: repositoryMemory.ok ? repositoryMemory.memory.scope?.repositorySlug : undefined,
        workspaceScopeReason: repositoryMemory.ok ? undefined : repositoryMemory.reason,
      });

      const repoMemoryWorktree = resolvedRepoMemoryWorktree(repositoryMemory);
      const retrievalKey = JSON.stringify([command.sessionId, command.turn, command.startSeq]);
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
        // DSH has no first-class TraceClient yet. Forwarding the shared sink
        // would make the current Viewer incorrectly classify this as Codex.
        query: command.prompt,
        repositoryMemory,
        sessionKey: command.sessionId,
      });
      return {
        ok: true,
        ...(repoMemoryWorktree ? { repoMemoryWorktree } : {}),
        ...(retrieval.context ? { additionalContext: retrieval.context } : {}),
      };
    },
    async writeback(command) {
      turnCoordinator.pruneExpired();
      const key = dshTurnKey(command.sessionId, command.turn);
      const entry = turnCoordinator.getTurn(key);
      if (
        entry
        && (entry.eventStartSeq !== command.startSeq || entry.cwd !== command.cwd)
      ) return skippedWriteback(command, "turn_metadata_mismatch", options);
      const materialized = dshSessionEventTurn(command);
      if (!materialized.ok) {
        if (materialized.reason === "turn_not_completed") {
          const discarded = turnCoordinator.discardTurn(key, "interrupted");
          return skippedWriteback(
            command,
            materialized.reason,
            options,
            discarded ? "consumed" : "absent",
          );
        }
        return skippedWriteback(command, materialized.reason, options);
      }

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
          client: DSH_MEMORY_TURN_CLIENT,
          sessionKey: command.sessionId,
          env: options.env ?? process.env,
          fetchImpl: options.fetchImpl,
          // Keep DSH Search/Add out of the two-client Viewer projection until
          // its own trace identity and reconciliation projection are defined.
        },
      });
      if (!writeback.scheduled) {
        return skippedWriteback(command, writeback.reason, options, writeback.metadataDisposition);
      }
      options.diagnosticLogger?.("dsh_memory.writeback", {
        scheduled: true,
        metadataDisposition: writeback.metadataDisposition,
        sessionId: command.sessionId,
        turn: command.turn,
        startSeq: command.startSeq,
        endSeq: command.endSeq,
        outcome: materialized.turn.outcome,
        promptChars: materialized.turn.userPrompt.length,
        assistantChars: materialized.turn.assistantReply.length,
        contentSource: "dsh_session_event_interval",
      });
      return { ok: true, scheduled: true };
    },
    size() {
      return turnCoordinator.size(DSH_MEMORY_TURN_CLIENT);
    },
    close() {
      retrievalTurns.clear();
      if (ownsTurnCoordinator) turnCoordinator.close();
      if (ownsRepositoryMemorySession) repositoryMemorySession.close();
      automaticWritebackRuntime?.close?.();
    },
  };
}

function dshTurnKey(sessionId: string, turn: number) {
  return {
    client: DSH_MEMORY_TURN_CLIENT,
    sessionId,
    clientTurnId: String(turn),
  } as const;
}

async function resolveHookRepositoryMemory(
  command: DshTurnStartCommand,
  options: DshMemoryHookRuntimeOptions,
  repositoryMemorySession: RepositoryMemorySessionRuntime,
): Promise<ConfiguredRepositoryMemoryResult> {
  return await repositoryMemorySession.resolve({
    client: DSH_MEMORY_TURN_CLIENT,
    sessionId: command.sessionId,
    workspaceRoot: command.cwd,
    memoraxCodeHome: options.memoraxCodeHome ?? options.env?.MEMORAX_CODE_HOME,
    env: options.env,
  });
}

async function resolveCurrentHookRepositoryMemory(
  entry: MemoryTurnState | undefined,
  command: DshWritebackCommand,
  options: DshMemoryHookRuntimeOptions,
  repositoryMemorySession: RepositoryMemorySessionRuntime,
): Promise<ConfiguredRepositoryMemoryResult> {
  return await repositoryMemorySession.resolve({
    client: DSH_MEMORY_TURN_CLIENT,
    sessionId: command.sessionId,
    workspaceRoot: command.cwd,
    // DSH's persisted session header and exact event interval remain native
    // authority after a Backend restart, when the in-memory binding is gone.
    requireBoundScope: entry !== undefined,
    memoraxCodeHome: options.memoraxCodeHome ?? options.env?.MEMORAX_CODE_HOME,
    env: options.env,
  });
}

function skippedWriteback(
  command: DshWritebackCommand,
  reason: DshMemoryHookWritebackSkipReason,
  options: DshMemoryHookRuntimeOptions,
  metadataDisposition: "consumed" | "retained" | "absent" = "retained",
): DshMemoryHookWritebackResult {
  options.diagnosticLogger?.("dsh_memory.writeback", {
    scheduled: false,
    reason,
    metadataDisposition,
    sessionId: command.sessionId,
    turn: command.turn,
    startSeq: command.startSeq,
    endSeq: command.endSeq,
  });
  return { ok: true, scheduled: false, reason };
}

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
