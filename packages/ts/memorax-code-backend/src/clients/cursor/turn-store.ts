import { readdirSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { withJsonFileLockAsync } from "../../../../memorax-code-adapter-common/src/config-utils.mjs";
import { readJsonRuntimeRecord, writePrivateJsonRecord } from "../../../../memorax-code-adapter-common/src/runtime-record.mjs";
import type { MemoryTurnState } from "../../memory/turn-coordinator.js";
import type { RepositoryMemoryScope } from "../../repository/scope.js";
import { cursorTextDigest, type CursorContinuationBaseline } from "./database-turn.js";
import { validCursorCompactionState, type CursorCompactionState } from "./compaction.js";

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const DIGEST = /^[0-9a-f]{64}$/;
const MAX_RECORD_BYTES = 1024 * 1024;
const MAX_RETIRED_TURNS = 8192;

export type CursorStoredTurn = {
  turnId: string;
  cwd?: string;
  workspaceKind?: string;
  createdAt: number;
  promptDigest: string;
  transcriptPath?: string;
  databasePath: string;
  continuation?: CursorContinuationBaseline;
  retryUntil?: number;
  responseDigest?: string;
  responseObservedAt?: number;
  stopStatus?: "completed" | "aborted" | "error";
  state: "open" | "blocked" | "interrupted" | "accepted";
  reason?: string;
  metadata?: Pick<MemoryTurnState, "repositoryScope" | "repositoryScopeReason">;
};

export type CursorSessionRecord = {
  version: 2;
  client: "cursor";
  sessionId: string;
  repositoryScope?: RepositoryMemoryScope;
  compaction?: CursorCompactionState;
  // Never recycle generation identities after completion or replacement.
  retiredTurnIds: string[];
  diagnosticKeys?: string[];
  active?: CursorStoredTurn;
};

export function cursorTurnStatePath(home: string, sessionId: string): string {
  return join(home, "runtime", "cursor", "turns", `${cursorTextDigest(sessionId)}.json`);
}

export async function withCursorSessionRecord<T>(
  input: { home: string; sessionId: string; lockTimeoutMs?: number },
  operation: (record: CursorSessionRecord, save: () => void) => Promise<T>,
): Promise<T> {
  if (!UUID.test(input.sessionId)) throw new Error("Invalid Cursor session identity");
  const path = cursorTurnStatePath(input.home, input.sessionId);
  return await withJsonFileLockAsync(path, async () => {
    try {
      if (statSync(path).size > MAX_RECORD_BYTES) throw new Error("Cursor turn state exceeds its size limit");
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
    }
    const stored = readJsonRuntimeRecord(path);
    const record: CursorSessionRecord = stored.status === "absent"
      ? { version: 2, client: "cursor", sessionId: input.sessionId, retiredTurnIds: [] }
      : stored.status === "present" && validRecord(stored.value, input.sessionId)
        ? stored.value
        : invalidRecord();
    return await operation(record, () => {
      if (!validRecord(record, input.sessionId)
        || Buffer.byteLength(JSON.stringify(record)) > MAX_RECORD_BYTES) invalidRecord();
      writePrivateJsonRecord(path, record, { durableBoundary: input.home });
    });
  }, { timeoutMs: input.lockTimeoutMs ?? 1000, retryMs: 10 });
}

export function retireCursorGeneration(record: CursorSessionRecord): void {
  if (!record.active) return;
  if (record.retiredTurnIds.length >= MAX_RETIRED_TURNS) {
    throw new Error("Cursor session generation history is full");
  }
  record.retiredTurnIds.push(record.active.turnId);
}

function validRecord(value: unknown, sessionId: string): value is CursorSessionRecord {
  if (!isRecord(value) || !keys(value, ["version", "client", "sessionId", "repositoryScope", "compaction", "retiredTurnIds", "diagnosticKeys", "active"])
    || value.version !== 2 || value.client !== "cursor" || value.sessionId !== sessionId
    || !Array.isArray(value.retiredTurnIds) || value.retiredTurnIds.length > MAX_RETIRED_TURNS
    || !value.retiredTurnIds.every((id) => typeof id === "string" && UUID.test(id))
    || new Set(value.retiredTurnIds).size !== value.retiredTurnIds.length
    || (value.diagnosticKeys !== undefined && (!Array.isArray(value.diagnosticKeys)
      || value.diagnosticKeys.length > 64 || !value.diagnosticKeys.every(digest)))
    || (value.repositoryScope !== undefined && !validScope(value.repositoryScope))
    || (value.compaction !== undefined && !validCursorCompactionState(value.compaction))) return false;
  return value.active === undefined || (validTurn(value.active) && !value.retiredTurnIds.includes(value.active.turnId));
}

function validTurn(value: unknown): value is CursorStoredTurn {
  if (!isRecord(value)
    || !keys(value, ["turnId", "cwd", "workspaceKind", "createdAt", "promptDigest", "transcriptPath", "databasePath", "continuation", "retryUntil", "responseDigest", "responseObservedAt", "stopStatus", "state", "reason", "metadata"])
    || typeof value.turnId !== "string" || !UUID.test(value.turnId)
    || (value.cwd !== undefined && (typeof value.cwd !== "string" || !value.cwd.trim() || !isAbsolute(value.cwd)))
    || (value.workspaceKind !== undefined && value.workspaceKind !== "projectless")
    || !timestamp(value.createdAt) || !digest(value.promptDigest)
    || typeof value.databasePath !== "string" || !isAbsolute(value.databasePath) || value.databasePath.includes("\0")
    || (value.retryUntil !== undefined && !timestamp(value.retryUntil))
    || (value.transcriptPath !== undefined && typeof value.transcriptPath !== "string")
    || (value.responseDigest !== undefined && !digest(value.responseDigest))
    || (value.responseObservedAt !== undefined && !timestamp(value.responseObservedAt))
    || (value.stopStatus !== undefined && (typeof value.stopStatus !== "string" || !["completed", "aborted", "error"].includes(value.stopStatus)))
    || typeof value.state !== "string" || !["open", "blocked", "interrupted", "accepted"].includes(value.state)
    || (value.reason !== undefined && (typeof value.reason !== "string" || !/^[a-z_]+$/.test(value.reason)))) return false;
  if (value.continuation !== undefined && !validBaseline(value.continuation)) return false;
  if (value.metadata !== undefined) {
    if (!isRecord(value.metadata) || !keys(value.metadata, ["repositoryScope", "repositoryScopeReason"])
      || (value.metadata.repositoryScope !== undefined && !validScope(value.metadata.repositoryScope))
      || (value.metadata.repositoryScopeReason !== undefined && (typeof value.metadata.repositoryScopeReason !== "string" || ![
        "config_missing", "workspace_scope_unavailable", "effective_user_id_invalid", "workspace_scope_mismatch",
      ].includes(value.metadata.repositoryScopeReason)))) return false;
  } else if (value.state === "open" || value.state === "blocked") return false;
  return true;
}

function validBaseline(value: unknown): value is CursorContinuationBaseline {
  return isRecord(value) && keys(value, ["requestId", "userMessageId", "userMessageRef", "promptDigest", "precedingTurnIds", "steps"])
    && typeof value.requestId === "string" && UUID.test(value.requestId)
    && typeof value.userMessageId === "string" && UUID.test(value.userMessageId)
    && typeof value.userMessageRef === "string" && DIGEST.test(value.userMessageRef)
    && digest(value.promptDigest)
    && Array.isArray(value.precedingTurnIds) && value.precedingTurnIds.length <= 8192
    && value.precedingTurnIds.every(digest)
    && Array.isArray(value.steps) && value.steps.length <= 8192
    && value.steps.every((step) => isRecord(step) && keys(step, ["id", "contentHash"])
      && digest(step.id) && digest(step.contentHash));
}

export function cursorPendingSessions(home: string): { sessionId: string; turnId: string; retryUntil: number }[] {
  try {
    // Retained terminal sessions must not hide pending work during restart recovery.
    return readdirSync(join(home, "runtime", "cursor", "turns")).flatMap((name) => {
      if (!/^[0-9a-f]{64}\.json$/.test(name)) return [];
      const path = join(home, "runtime", "cursor", "turns", name);
      try {
        if (statSync(path).size > MAX_RECORD_BYTES) return [];
        const stored = readJsonRuntimeRecord(path);
        if (stored.status !== "present" || !isRecord(stored.value)
          || typeof stored.value.sessionId !== "string" || !UUID.test(stored.value.sessionId)
          || !validRecord(stored.value, stored.value.sessionId)
          || cursorTurnStatePath(home, stored.value.sessionId) !== path) return [];
        const turn = stored.value.active;
        return turn?.state === "open" && turn.stopStatus === "completed"
          && turn.responseDigest && turn.retryUntil ? [{ sessionId: stored.value.sessionId, turnId: turn.turnId, retryUntil: turn.retryUntil }] : [];
      } catch { return []; }
    });
  } catch { return []; }
}

function validScope(value: unknown): value is RepositoryMemoryScope {
  if (!isRecord(value) || !keys(value, ["schemaVersion", "baseUserId", "effectiveUserId", "repositoryKey", "repositorySlug", "repositoryName", "identitySource", "scopeKind", "fallbackReason", "boundWorkspaceRoot"])
    || value.schemaVersion !== "workspace-memory-scope.v1"
    || !["baseUserId", "effectiveUserId", "repositoryKey", "repositorySlug", "repositoryName"].every((key) => (
      typeof value[key] === "string" && (value[key] as string).length > 0
    ))
    || typeof value.identitySource !== "string" || !["origin-remote", "git-common-dir", "workspace-directory", "general"].includes(value.identitySource)
    || typeof value.scopeKind !== "string" || !["git-repository", "local-directory", "general"].includes(value.scopeKind)
    || (value.fallbackReason !== undefined && value.fallbackReason !== "git_metadata_invalid")
    || (value.boundWorkspaceRoot !== undefined && typeof value.boundWorkspaceRoot !== "string")) return false;
  return true;
}

function keys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function digest(value: unknown): boolean {
  return typeof value === "string" && DIGEST.test(value);
}

function timestamp(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidRecord(): never {
  throw new Error("Cursor turn state is invalid or unavailable");
}
