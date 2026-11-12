import { createHash } from "node:crypto";
import { evaluateJevSearch, JEV_MAX_TEXT_CHARS, type JevSearchInput, type JevSearchResult } from "../provider/jev/adapter.js";
import { jevConfigFromEnv } from "../provider/jev/config.js";
import { memoraxConfigFromEnv } from "../provider/memorax/config.js";
import { repositoryMemoryScopesMatch, repositoryMemoryScopeCanBindGeneralWorkspace, repositoryMemoryScopeCanUpgradeFromDegradedGit, type RepositoryMemoryScope } from "../repository/scope.js";
import type { TurnStartCommand } from "./hook-command.js";
import type { MemoryMaterializedTurn, MemoryTurnDiscardReason, MemoryTurnKey, MemoryTurnState } from "./turn-coordinator.js";

const MAX_RETIRED_TURN_IDS = 256;

type PreviousTurn = NonNullable<JevSearchInput["previousTurn"]>;
type NativeReferences = Pick<MemoryTurnState, "cwd" | "workspaceKind" | "transcriptPath" | "databasePath" | "eventStartSeq">;
type CachedTurn = {
  key: MemoryTurnKey;
  scope?: RepositoryMemoryScope;
  prompt?: string;
  promptDigest?: string;
  references?: NativeReferences;
  previousTurn?: PreviousTurn;
  completed?: PreviousTurn;
  evaluation?: Promise<JevSearchResult>;
  invalid?: true;
  retiredTurnIds?: ReadonlySet<string>;
};

export type MemorySearchGuidanceResult = JevSearchResult | Readonly<{ ok: false; reason: "context_unavailable" }>;
export type MemorySearchGuidanceRuntime = ReturnType<typeof createMemorySearchGuidanceRuntime>;

export function createMemorySearchGuidanceRuntime(options: {
  env?: Record<string, string | undefined>;
  memoraxCodeHome?: string;
  fetchImpl?: typeof fetch;
  maxEntries?: number;
} = {}) {
  const turns = new Map<string, CachedTurn>();
  const maxEntries = Number.isSafeInteger(options.maxEntries) && options.maxEntries! > 0
    ? Math.min(options.maxEntries!, 256) : 256;
  let closed = false;
  const env = () => options.memoraxCodeHome
    ? { ...(options.env ?? process.env), MEMORAX_CODE_HOME: options.memoraxCodeHome }
    : options.env ?? process.env;
  function configured() {
    const result = jevConfigFromEnv(env());
    if (closed || !result.ok) turns.clear();
    return closed ? { ok: false, reason: "disabled" } as const : result;
  }
  function put(key: string, turn: CachedTurn) {
    turns.delete(key);
    turns.set(key, turn);
    while (turns.size > maxEntries) {
      turns.delete(turns.keys().next().value!);
    }
  }
  function currentAccount(scope: RepositoryMemoryScope) {
    const config = memoraxConfigFromEnv(env());
    return config.ok && config.config.userId === scope.baseUserId;
  }
  return {
    isEnabled() { return configured().ok; },
    registerTurn(turn: MemoryTurnState, prompt: string): void {
      if (!configured().ok || !validKey(turn) || typeof prompt !== "string") return;
      const key = sessionKey(turn);
      const previous = turns.get(key);
      if (previous?.retiredTurnIds?.has(digest(turn.clientTurnId))) return;
      const scope = turn.repositoryScopeReason ? undefined : turn.repositoryScope;
      const references = nativeReferences(turn);
      const promptDigest = digest(prompt);
      if (previous?.key.clientTurnId === turn.clientTurnId) {
        if (!previous.invalid && previous.promptDigest === promptDigest
          && sameScope(previous.scope, scope) && sameReferences(previous.references, references)) return;
        put(key, { key: turnKey(turn), invalid: true, retiredTurnIds: previous.retiredTurnIds });
        return;
      }
      const retiredTurnIds = new Set(previous?.retiredTurnIds);
      if (previous) retiredTurnIds.add(digest(previous.key.clientTurnId));
      const historyOverflow = retiredTurnIds.size > MAX_RETIRED_TURN_IDS;
      if (historyOverflow) retiredTurnIds.delete(retiredTurnIds.values().next().value!);
      put(key, {
        key: turnKey(turn), scope, retiredTurnIds,
        ...(scope && prompt.trim() ? { prompt: bounded(prompt), promptDigest, references } : {}),
        // Once retired identities overflow, do not carry QA from a turn that
        // could be an unrecognized replay outside the retained identity window.
        ...(!historyOverflow && scope && sameScope(previous?.scope, scope) && previous?.completed
          ? { previousTurn: previous.completed } : {}),
      });
    },
    discardTurn(input: MemoryTurnKey, reason?: MemoryTurnDiscardReason): void {
      const key = sessionKey(input);
      const current = turns.get(key);
      if (!current || current.key.clientTurnId !== input.clientTurnId) return;
      // Normal generation retirement preserves only already validated QA.
      if (reason === "superseded" && current.completed) return;
      put(key, { key: current.key, invalid: true, retiredTurnIds: current.retiredTurnIds });
    },
    completeTurn(input: MemoryMaterializedTurn): void {
      if (!configured().ok || !input.userText.trim() || !input.assistantText.trim()) return;
      const key = sessionKey(input.key);
      const current = turns.get(key);
      if (!current || current.invalid || !current.scope || current.key.clientTurnId !== input.key.clientTurnId) return;
      if (current?.scope && !sameScope(current.scope, input.repositoryScope)
        && !repositoryMemoryScopeCanBindGeneralWorkspace(current.scope, input.repositoryScope)
        && !repositoryMemoryScopeCanUpgradeFromDegradedGit(current.scope, input.repositoryScope)) return;
      const completed = { user: bounded(input.userText), assistant: bounded(input.assistantText) };
      if (current?.completed) {
        if (current.completed.user !== completed.user || current.completed.assistant !== completed.assistant) {
          put(key, { key: turnKey(input.key), invalid: true, retiredTurnIds: current.retiredTurnIds });
        }
        return;
      }
      put(key, {
        ...current, key: turnKey(input.key), scope: input.repositoryScope, completed,
        previousTurn: undefined,
      });
    },
    async evaluate(command: TurnStartCommand): Promise<MemorySearchGuidanceResult> {
      const enabled = configured();
      if (!enabled.ok) return { ok: false, reason: enabled.reason };
      const unavailable = { ok: false, reason: "context_unavailable" } as const;
      const identity = commandKey(command);
      if (!identity || !validKey(identity) || typeof command.prompt !== "string") return unavailable;
      const key = sessionKey(identity);
      const current = turns.get(key);
      if (!current || current.invalid || current.completed || !current.prompt || !current.scope
        || current.key.clientTurnId !== identity.clientTurnId || current.promptDigest !== digest(command.prompt)
        || !referencesMatchCommand(current.references, command)) return unavailable;
      if (!currentAccount(current.scope)) { turns.clear(); return unavailable; }
      // Retransmitted or concurrent Hook calls share even a failed provider attempt.
      current.evaluation ??= evaluateJevSearch({ currentPrompt: current.prompt,
        ...(current.previousTurn ? { previousTurn: current.previousTurn } : {}),
      }, { env: env(), fetchImpl: options.fetchImpl });
      const result = await current.evaluation;
      if (!configured().ok || turns.get(key) !== current || !currentAccount(current.scope)) return unavailable;
      return result;
    },
    close(): void { closed = true; turns.clear(); },
  };
}

function validKey(key: MemoryTurnKey): boolean {
  return typeof key.sessionId === "string" && Boolean(key.sessionId.trim())
    && typeof key.clientTurnId === "string" && Boolean(key.clientTurnId.trim());
}
function sessionKey(key: MemoryTurnKey): string { return JSON.stringify([key.client, key.sessionId]); }
function turnKey(key: MemoryTurnKey): MemoryTurnKey {
  return { client: key.client, sessionId: key.sessionId, clientTurnId: key.clientTurnId };
}
function bounded(value: string): string { return value.trim().slice(0, JEV_MAX_TEXT_CHARS); }
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function sameScope(left: RepositoryMemoryScope | undefined, right: RepositoryMemoryScope | undefined): boolean {
  return Boolean(left && right && repositoryMemoryScopesMatch(left, right)
    && left.scopeKind === right.scopeKind && left.boundWorkspaceRoot === right.boundWorkspaceRoot);
}
function nativeReferences(turn: NativeReferences): NativeReferences {
  return { cwd: turn.cwd, workspaceKind: turn.workspaceKind, transcriptPath: turn.transcriptPath,
    databasePath: turn.databasePath, eventStartSeq: turn.eventStartSeq };
}
function sameReferences(left: NativeReferences | undefined, right: NativeReferences): boolean {
  return Boolean(left && Object.entries(right).every(([key, value]) => left[key as keyof NativeReferences] === value));
}
function commandKey(command: TurnStartCommand): MemoryTurnKey | undefined {
  const clientTurnId = command.client === "claude-code" ? command.promptId
    : command.client === "opencode" ? command.userMessageId
      : command.client === "dsh" ? String(command.turn) : command.turnId;
  return clientTurnId ? { client: command.client, sessionId: command.sessionId, clientTurnId } : undefined;
}
function referencesMatchCommand(saved: NativeReferences | undefined, command: TurnStartCommand): boolean {
  if (!saved) return false;
  const references = {
    cwd: command.cwd, workspaceKind: "workspaceKind" in command ? command.workspaceKind : undefined,
    transcriptPath: "transcriptPath" in command ? command.transcriptPath : undefined,
    databasePath: "databasePath" in command ? command.databasePath : undefined,
    eventStartSeq: "startSeq" in command ? command.startSeq : undefined,
  };
  return Object.entries(references).every(([key, value]) => saved[key as keyof NativeReferences] === value);
}
