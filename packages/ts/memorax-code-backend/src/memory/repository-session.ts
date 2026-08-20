import {
  memoraxConfigFromEnv,
  type MemoraxAdapterConfig,
} from "../provider/memorax/config.js";
import {
  repositoryMemoryScopeCanUpgradeFromDegradedGit,
  repositoryMemoryScopeContainsWorkspace,
  repositoryMemoryScopeKind,
  repositoryMemoryScopesMatch,
  resolveRepositoryMemoryScope,
  type RepositoryMemoryScope,
  type RepositoryMemoryScopeFailureReason,
} from "../repository/scope.js";
import type { MemoryHookClient } from "./hook-command.js";

export type ConfiguredRepositoryMemory = Readonly<{
  config: MemoraxAdapterConfig;
  scope?: RepositoryMemoryScope;
}>;

export type ConfiguredRepositoryMemoryResult =
  | { ok: true; memory: ConfiguredRepositoryMemory }
  | {
    ok: false;
    reason: "config_missing" | RepositoryMemoryScopeFailureReason;
    error: string;
  };

export function resolvedRepoMemoryWorktree(
  result: ConfiguredRepositoryMemoryResult,
): string | undefined {
  if (!result.ok || !result.memory.scope) return undefined;
  return repositoryMemoryScopeKind(result.memory.scope) === "git-repository"
    ? result.memory.scope.boundWorkspaceRoot
    : undefined;
}

type RepositoryMemorySessionBinding = {
  scope: RepositoryMemoryScope;
  mismatch: boolean;
};

export type RepositoryMemorySessionRequest = {
  client: MemoryHookClient;
  sessionId?: string;
  workspaceRoot?: string;
  workspaceKind?: string;
  requireBoundScope?: boolean;
  memoraxCodeHome?: string;
  env?: Record<string, string | undefined>;
};

export type RepositoryMemorySessionRuntime = {
  resolve(input: RepositoryMemorySessionRequest): Promise<ConfiguredRepositoryMemoryResult>;
  close(): void;
};

export type RepositoryMemorySessionScopeUpgrade = Readonly<{
  client: MemoryHookClient;
  sessionId: string;
  previousScope: RepositoryMemoryScope;
  currentScope: RepositoryMemoryScope;
}>;

export type RepositoryMemorySessionRuntimeOptions = {
  onScopeUpgrade?: (upgrade: RepositoryMemorySessionScopeUpgrade) => void;
};

const sessionScopes = new WeakMap<object, Map<string, RepositoryMemorySessionBinding>>();
const scopeResolutionQueues = new WeakMap<object, Map<string, Promise<void>>>();

export function createRepositoryMemorySessionRuntime(
  options: RepositoryMemorySessionRuntimeOptions = {},
): RepositoryMemorySessionRuntime {
  const owner = {};
  return {
    async resolve(input) {
      return await resolveConfiguredRepositoryMemoryForSession({
        owner,
        onScopeUpgrade: options.onScopeUpgrade,
        ...input,
      });
    },
    close() {
      sessionScopes.delete(owner);
      scopeResolutionQueues.delete(owner);
    },
  };
}

export async function resolveConfiguredRepositoryMemory(input: {
  workspaceRoot?: string;
  workspaceKind?: string;
  memoraxCodeHome?: string;
  env?: Record<string, string | undefined>;
}): Promise<ConfiguredRepositoryMemoryResult> {
  const sourceEnv = input.env ?? process.env;
  const env = input.memoraxCodeHome ? { ...sourceEnv, MEMORAX_CODE_HOME: input.memoraxCodeHome } : sourceEnv;
  const configResult = memoraxConfigFromEnv(env);
  if (!configResult.ok) return { ok: false, reason: "config_missing", error: configResult.error };
  const scopeResult = await resolveRepositoryMemoryScope({
    workspaceRoot: input.workspaceRoot,
    workspaceKind: input.workspaceKind,
    baseUserId: configResult.config.userId,
  });
  if (!scopeResult.ok) return scopeResult;
  return { ok: true, memory: { config: configResult.config, scope: scopeResult.scope } };
}

export async function resolveConfiguredRepositoryMemoryForSession(
  input: RepositoryMemorySessionRequest & RepositoryMemorySessionRuntimeOptions & { owner: object },
): Promise<ConfiguredRepositoryMemoryResult> {
  const sourceEnv = input.env ?? process.env;
  const env = input.memoraxCodeHome ? { ...sourceEnv, MEMORAX_CODE_HOME: input.memoraxCodeHome } : sourceEnv;
  const configResult = memoraxConfigFromEnv(env);
  if (!configResult.ok) return { ok: false, reason: "config_missing", error: configResult.error };

  const sessionId = input.sessionId?.trim();
  if (!sessionId) {
    return await resolveConfiguredRepositoryMemory({
      workspaceRoot: input.workspaceRoot,
      workspaceKind: input.workspaceKind,
      memoraxCodeHome: input.memoraxCodeHome,
      env,
    });
  }

  const bindingKey = JSON.stringify([input.client, sessionId]);
  return await withScopeResolution(input.owner, `session:${bindingKey}`, async () => {
    let scopes = sessionScopes.get(input.owner);
    if (!scopes) {
      scopes = new Map();
      sessionScopes.set(input.owner, scopes);
    }
    const cached = scopes.get(bindingKey);
    if (cached?.scope.baseUserId === configResult.config.userId && cached.mismatch) {
      return repositoryScopeMismatch();
    }
    const cachedScope = cached?.scope.baseUserId === configResult.config.userId ? cached.scope : undefined;
    if (input.requireBoundScope === true && !cachedScope) {
      return {
        ok: false,
        reason: "workspace_scope_unavailable",
        error: "memory scope authority is unavailable for this session",
      };
    }
    const workspaceKind = input.workspaceKind?.trim().toLowerCase();
    let workspaceRoot = input.workspaceRoot?.trim() ? input.workspaceRoot : undefined;
    if (
      cachedScope
      && repositoryMemoryScopeKind(cachedScope) === "local-directory"
      && workspaceKind !== "projectless"
      && await repositoryMemoryScopeContainsWorkspace(cachedScope, workspaceRoot)
    ) {
      workspaceRoot = cachedScope.boundWorkspaceRoot;
    }
    if (!workspaceRoot && cachedScope?.boundWorkspaceRoot) workspaceRoot = cachedScope.boundWorkspaceRoot;
    const effectiveWorkspaceKind = input.workspaceKind
      ?? (cachedScope && repositoryMemoryScopeKind(cachedScope) === "codex-projectless"
        ? "projectless"
        : undefined);
    if (!workspaceRoot && effectiveWorkspaceKind?.trim().toLowerCase() !== "projectless") {
      return {
        ok: false,
        reason: "workspace_scope_unavailable",
        error: "a session workspace is required for workspace-scoped memory",
      };
    }

    const scopeResult = await resolveRepositoryMemoryScope({
      workspaceRoot,
      workspaceKind: effectiveWorkspaceKind,
      baseUserId: configResult.config.userId,
    });
    if (!scopeResult.ok) return scopeResult;
    if (cached?.scope.baseUserId === configResult.config.userId) {
      if (!repositoryMemoryScopesMatch(cached.scope, scopeResult.scope)) {
        if (repositoryMemoryScopeCanUpgradeFromDegradedGit(cached.scope, scopeResult.scope)) {
          input.onScopeUpgrade?.({
            client: input.client,
            sessionId,
            previousScope: cached.scope,
            currentScope: scopeResult.scope,
          });
          cached.scope = scopeResult.scope;
          return { ok: true, memory: { config: configResult.config, scope: scopeResult.scope } };
        }
        cached.mismatch = true;
        return repositoryScopeMismatch();
      }
      return { ok: true, memory: { config: configResult.config, scope: cached.scope } };
    }
    scopes.set(bindingKey, { scope: scopeResult.scope, mismatch: false });
    return { ok: true, memory: { config: configResult.config, scope: scopeResult.scope } };
  });
}

function repositoryScopeMismatch(): ConfiguredRepositoryMemoryResult {
  return {
    ok: false,
    reason: "workspace_scope_mismatch",
    error: "memory scope changed for this session; start a new session for the other workspace",
  };
}

async function withScopeResolution<T>(owner: object, key: string, fn: () => Promise<T>): Promise<T> {
  let queues = scopeResolutionQueues.get(owner);
  if (!queues) {
    queues = new Map();
    scopeResolutionQueues.set(owner, queues);
  }
  const previous = queues.get(key) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const current = new Promise<void>((resolveCurrent) => {
    release = resolveCurrent;
  });
  const tail = previous.then(() => current);
  queues.set(key, tail);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (queues.get(key) === tail) queues.delete(key);
  }
}
