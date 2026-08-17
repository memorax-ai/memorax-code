import type {
  AutomaticMemoryWritebackClient,
  AutomaticMemoryWritebackEnqueue,
  AutomaticMemoryWritebackOptions,
  AutomaticMemoryWritebackRejectionReason,
} from "./automatic-writeback.js";
import type { ConfiguredRepositoryMemoryResult } from "./repository-session.js";
import {
  repositoryMemoryScopeCanUpgradeFromDegradedGit,
  repositoryMemoryScopesMatch,
  type RepositoryMemoryScope,
  type RepositoryMemoryScopeFailureReason,
} from "../repository/scope.js";
import type { TraceContext } from "../trace/context.js";

export type MemoryTurnClient = AutomaticMemoryWritebackClient;

export type MemoryTurnKey = Readonly<{
  client: MemoryTurnClient;
  sessionId: string;
  clientTurnId: string;
}>;

export type MemoryTurnStart = MemoryTurnKey & Readonly<{
  cwd?: string;
  workspaceKind?: string;
  transcriptPath?: string;
  eventStartSeq?: number;
  createdAt: number;
  sessionTurnIndex?: number;
  traceContext?: TraceContext;
  repositoryMemory: ConfiguredRepositoryMemoryResult;
}>;

export type MemoryTurnState = Omit<MemoryTurnStart, "repositoryMemory"> & Readonly<{
  repositoryScope?: RepositoryMemoryScope;
  repositoryScopeError?: string;
  repositoryScopeReason?: "config_missing" | RepositoryMemoryScopeFailureReason;
}>;

export type MemoryTurnWritebackSkipReason =
  | "turn_metadata_mismatch"
  | "config_missing"
  | RepositoryMemoryScopeFailureReason
  | AutomaticMemoryWritebackRejectionReason;

export type MemoryTurnMetadataDisposition = "consumed" | "retained" | "absent";

export type MemoryTurnWritebackResult =
  | { scheduled: true; metadataDisposition: MemoryTurnMetadataDisposition }
  | {
    scheduled: false;
    reason: MemoryTurnWritebackSkipReason;
    metadataDisposition: Exclude<MemoryTurnMetadataDisposition, "consumed">;
  };

export type MemoryTurnCompletion = Readonly<{
  key: MemoryTurnKey;
  metadata?: MemoryTurnState;
  resolveRepositoryMemory: () => Promise<ConfiguredRepositoryMemoryResult>;
  userText: string;
  assistantText: string;
  writeback: Omit<AutomaticMemoryWritebackOptions, "userText" | "assistantText" | "repositoryScope">;
}>;

export type MemoryTurnDiscardReason = "interrupted" | "rolled_back";

export type MemoryTurnCoordinatorOptions = {
  automaticWriteback: AutomaticMemoryWritebackEnqueue;
  now?: () => number;
  ttlMs?: number;
  maxEntries?: number;
  cleanupIntervalMs?: number;
};

export type MemoryTurnCoordinator = {
  recordTurnStart(input: MemoryTurnStart): MemoryTurnState;
  getTurn(key: MemoryTurnKey): MemoryTurnState | undefined;
  latestTurn(input: {
    client: MemoryTurnClient;
    sessionId: string;
    excludeClientTurnId?: string;
  }): MemoryTurnState | undefined;
  discardTurn(key: MemoryTurnKey, reason: MemoryTurnDiscardReason): boolean;
  completeMaterializedTurn(input: MemoryTurnCompletion): Promise<MemoryTurnWritebackResult>;
  pruneExpired(): void;
  size(client?: MemoryTurnClient): number;
  close(): void;
};

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 256;
const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 1000;

export function createMemoryTurnCoordinator(options: MemoryTurnCoordinatorOptions): MemoryTurnCoordinator {
  const turns = new Map<string, MemoryTurnState>();
  const now = options.now ?? (() => Date.now());
  const ttlMs = positiveInteger(options.ttlMs, DEFAULT_TTL_MS);
  const maxEntries = positiveInteger(options.maxEntries, DEFAULT_MAX_ENTRIES);
  const cleanupIntervalMs = positiveInteger(options.cleanupIntervalMs, DEFAULT_CLEANUP_INTERVAL_MS);
  const timer = setInterval(() => cleanupExpired(turns, now(), ttlMs), cleanupIntervalMs);
  timer.unref?.();

  return {
    recordTurnStart(input) {
      const state: MemoryTurnState = {
        client: input.client,
        sessionId: input.sessionId,
        clientTurnId: input.clientTurnId,
        cwd: input.cwd,
        workspaceKind: input.workspaceKind,
        transcriptPath: input.transcriptPath,
        eventStartSeq: input.eventStartSeq,
        createdAt: input.createdAt,
        sessionTurnIndex: input.sessionTurnIndex,
        traceContext: input.traceContext,
        ...(input.repositoryMemory.ok && input.repositoryMemory.memory.scope
          ? { repositoryScope: input.repositoryMemory.memory.scope }
          : {}),
        ...(!input.repositoryMemory.ok
          ? {
            repositoryScopeError: input.repositoryMemory.error,
            repositoryScopeReason: input.repositoryMemory.reason,
          }
          : {}),
      };
      turns.set(turnKey(state), state);
      evictOldest(turns, maxEntries);
      return state;
    },
    getTurn(key) {
      return turns.get(turnKey(key));
    },
    latestTurn(input) {
      return [...turns.values()]
        .filter((turn) => (
          turn.client === input.client
          && turn.sessionId === input.sessionId
          && turn.clientTurnId !== input.excludeClientTurnId
        ))
        .sort((left, right) => right.createdAt - left.createdAt)[0];
    },
    discardTurn(key, reason) {
      switch (reason) {
        case "interrupted":
        case "rolled_back":
          return turns.delete(turnKey(key));
      }
    },
    async completeMaterializedTurn(input) {
      const reject = (
        reason: MemoryTurnWritebackSkipReason,
      ): MemoryTurnWritebackResult => ({
        scheduled: false,
        reason,
        metadataDisposition: turnMetadataDisposition(turns, input, false),
      });
      if (input.metadata && turnKey(input.metadata) !== turnKey(input.key)) {
        return reject("turn_metadata_mismatch");
      }
      if (input.metadata?.repositoryScopeReason || (input.metadata && !input.metadata.repositoryScope)) {
        return reject(input.metadata.repositoryScopeReason ?? "workspace_scope_unavailable");
      }
      const current = await input.resolveRepositoryMemory();
      if (!current.ok) return reject(current.reason);
      const currentScope = current.memory.scope;
      if (!currentScope) {
        return reject(input.metadata ? "workspace_scope_mismatch" : "workspace_scope_unavailable");
      }
      let repositoryScope = input.metadata?.repositoryScope ?? currentScope;
      if (
        input.metadata?.repositoryScope
        && !repositoryMemoryScopesMatch(input.metadata.repositoryScope, currentScope)
      ) {
        if (!repositoryMemoryScopeCanUpgradeFromDegradedGit(input.metadata.repositoryScope, currentScope)) {
          return reject("workspace_scope_mismatch");
        }
        repositoryScope = currentScope;
      }
      const acceptance = options.automaticWriteback({
        ...input.writeback,
        userText: input.userText,
        assistantText: input.assistantText,
        repositoryScope,
      });
      if (!acceptance.accepted) {
        return reject(acceptance.reason);
      }
      return {
        scheduled: true,
        metadataDisposition: turnMetadataDisposition(turns, input, true),
      };
    },
    pruneExpired() {
      cleanupExpired(turns, now(), ttlMs);
    },
    size(client) {
      cleanupExpired(turns, now(), ttlMs);
      return client === undefined
        ? turns.size
        : [...turns.values()].filter((turn) => turn.client === client).length;
    },
    close() {
      clearInterval(timer);
      turns.clear();
    },
  };
}

function turnKey(key: MemoryTurnKey): string {
  return JSON.stringify([key.client, key.sessionId, key.clientTurnId.trim()]);
}

function turnMetadataDisposition(
  turns: Map<string, MemoryTurnState>,
  completion: Pick<MemoryTurnCompletion, "key" | "metadata">,
  consume: false,
): Exclude<MemoryTurnMetadataDisposition, "consumed">;
function turnMetadataDisposition(
  turns: Map<string, MemoryTurnState>,
  completion: Pick<MemoryTurnCompletion, "key" | "metadata">,
  consume: true,
): MemoryTurnMetadataDisposition;
function turnMetadataDisposition(
  turns: Map<string, MemoryTurnState>,
  completion: Pick<MemoryTurnCompletion, "key" | "metadata">,
  consume: boolean,
): MemoryTurnMetadataDisposition {
  const key = turnKey(completion.key);
  const current = turns.get(key);
  if (!current) return "absent";
  if (!consume || !completion.metadata || current !== completion.metadata) return "retained";
  turns.delete(key);
  return "consumed";
}

function cleanupExpired(turns: Map<string, MemoryTurnState>, nowMs: number, ttlMs: number): void {
  for (const [key, turn] of turns.entries()) {
    if (nowMs - turn.createdAt > ttlMs) turns.delete(key);
  }
}

function evictOldest(turns: Map<string, MemoryTurnState>, maxEntries: number): void {
  while (turns.size > maxEntries) {
    const oldest = turns.keys().next().value;
    if (typeof oldest !== "string") return;
    turns.delete(oldest);
  }
}

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
