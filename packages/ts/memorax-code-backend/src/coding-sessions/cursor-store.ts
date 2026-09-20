import { lstatSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { withJsonFileLockAsync } from "../../../memorax-code-adapter-common/src/config-utils.mjs";
import {
  readJsonRuntimeRecord,
  writePrivateJsonRecord,
} from "../../../memorax-code-adapter-common/src/runtime-record.mjs";
import type { RepositoryMemoryScope } from "../repository/scope.js";
import { CODING_TURN_MAX_BYTES, type CodingSessionProjectionVersion } from "./coding-turn.js";

const MAX_CURSOR_BYTES = 2 * 1024 * 1024;
const HASH = /^[0-9a-f]{64}$/;

export type NativeArchiveTurn = Readonly<{
  turnId: string;
  turnIndex: number;
  closedAt: string;
  source: Readonly<{ transcriptPath: string; endBytes: number }>;
  bytes: number;
  digest: string;
  // Missing on older cursors means the original projection, never the latest.
  projectionVersion?: CodingSessionProjectionVersion;
}>;

export type CodingSessionCursor = Readonly<{
  version: 1;
  key: string;
  connection: string;
  client: "codex" | "claude-code" | "codebuddy" | "workbuddy";
  sessionId: string;
  repositoryScope: RepositoryMemoryScope;
  lastInteractionAt: number;
  uploadedThrough: number;
  confirmedTurns?: Array<Pick<NativeArchiveTurn, "turnId" | "turnIndex" | "digest" | "projectionVersion">>;
  turns: NativeArchiveTurn[];
  batch?: Readonly<{ id: string; turnIds: string[] }>;
  retryAt?: number;
  discarded?: boolean;
}>;

export type CodingSessionCursorStore = Readonly<{
  list(): Promise<string[]>;
  read(key: string): CodingSessionCursor | undefined;
  update<T>(
    key: string,
    operation: (current: CodingSessionCursor | undefined) => {
      state?: CodingSessionCursor;
      value: T;
    },
  ): Promise<T>;
  withUploadLock<T>(key: string, operation: () => Promise<T>): Promise<T>;
}>;

export class CodingSessionCursorError extends Error {
  readonly code: string;

  constructor(reason: "invalid" | "too_large" | "unreadable" | "durability_uncertain") {
    super(reason === "durability_uncertain"
      ? "Coding-session cursor was published but its crash durability is uncertain"
      : `Coding-session cursor is ${reason}`);
    this.name = "CodingSessionCursorError";
    this.code = `coding_session_cursor_${reason}`;
  }
}

export function createCodingSessionCursorStore(home: string): CodingSessionCursorStore {
  const root = resolve(home);
  const directory = join(root, "runtime", "coding-sessions");
  const pathFor = (key: string): string => {
    if (!HASH.test(key)) throw new CodingSessionCursorError("invalid");
    return join(directory, `${key}.json`);
  };

  const read = (key: string): CodingSessionCursor | undefined => {
    const path = pathFor(key);
    try {
      const stat = lstatSync(path);
      if (!stat.isFile()) throw new CodingSessionCursorError("invalid");
      if (stat.size > MAX_CURSOR_BYTES) throw new CodingSessionCursorError("too_large");
    } catch (error) {
      if (isMissing(error)) return undefined;
      if (error instanceof CodingSessionCursorError) throw error;
      throw new CodingSessionCursorError("unreadable");
    }
    const stored = readJsonRuntimeRecord(path);
    if (stored.status !== "present") throw new CodingSessionCursorError("unreadable");
    return validateCursor(stored.value, key);
  };

  return {
    async list() {
      try {
        const entries = await readdir(directory, { withFileTypes: true });
        return entries
          .filter((entry) => entry.isFile() && /^[0-9a-f]{64}\.json$/.test(entry.name))
          .map((entry) => entry.name.slice(0, -5))
          .sort();
      } catch (error) {
        if (isMissing(error)) return [];
        throw new CodingSessionCursorError("unreadable");
      }
    },
    read,
    async update(key, operation) {
      const path = pathFor(key);
      return await withJsonFileLockAsync(path, () => {
        const { state, value } = operation(read(key));
        if (state !== undefined) {
          const next = validateCursor(state, key);
          const written = writePrivateJsonRecord(path, next, { durableBoundary: root });
          if (written.durability !== "confirmed") {
            throw new CodingSessionCursorError("durability_uncertain");
          }
        }
        return value;
      }, { timeoutMs: 500 });
    },
    async withUploadLock(key, operation) {
      // Upload ownership must not prevent a Hook from registering later Turns.
      return await withJsonFileLockAsync(`${pathFor(key)}.upload`, operation, { timeoutMs: 500 });
    },
  };
}

function validateCursor(value: unknown, key: string): CodingSessionCursor {
  if (!fields(value, ["version", "key", "connection", "client", "sessionId", "repositoryScope",
    "lastInteractionAt", "uploadedThrough", "turns"], ["confirmedTurns", "batch", "retryAt", "discarded"])
    || value.version !== 1
    || value.key !== key
    || typeof value.connection !== "string" || !HASH.test(value.connection)
    || typeof value.client !== "string"
    || !["codex", "claude-code", "codebuddy", "workbuddy"].includes(value.client)
    || !text(value.sessionId)
    || !validScope(value.repositoryScope)
    || !integer(value.lastInteractionAt)
    || !integer(value.uploadedThrough)
    || !Array.isArray(value.turns)
    || (value.retryAt !== undefined && !integer(value.retryAt))
    || (value.discarded !== undefined && typeof value.discarded !== "boolean")) {
    throw new CodingSessionCursorError("invalid");
  }
  if (value.confirmedTurns !== undefined) {
    if (!Array.isArray(value.confirmedTurns)
      || value.confirmedTurns.length === 0 || value.confirmedTurns.length > 50) {
      throw new CodingSessionCursorError("invalid");
    }
    let previousConfirmed = 0;
    const confirmedIds = new Set<string>();
    for (const turn of value.confirmedTurns) {
      if (!fields(turn, ["turnId", "turnIndex", "digest"], ["projectionVersion"])
        || !validProjectionVersion(turn.projectionVersion)
        || !text(turn.turnId) || confirmedIds.has(turn.turnId)
        || !integer(turn.turnIndex) || turn.turnIndex <= previousConfirmed
        || turn.turnIndex > value.uploadedThrough
        || typeof turn.digest !== "string" || !HASH.test(turn.digest)) {
        throw new CodingSessionCursorError("invalid");
      }
      previousConfirmed = turn.turnIndex;
      confirmedIds.add(turn.turnId);
    }
    if (previousConfirmed !== value.uploadedThrough) throw new CodingSessionCursorError("invalid");
  }
  let previous = value.uploadedThrough;
  const identities = new Set<string>();
  const turns = value.turns;
  for (const turn of turns) {
    if (!fields(turn, ["turnId", "turnIndex", "closedAt", "source", "bytes", "digest"], ["projectionVersion"])
      || !validProjectionVersion(turn.projectionVersion)
      || !text(turn.turnId) || identities.has(turn.turnId)
      || !integer(turn.turnIndex) || turn.turnIndex <= previous
      || !text(turn.closedAt, 128) || !Number.isFinite(Date.parse(turn.closedAt))
      || !fields(turn.source, ["transcriptPath", "endBytes"])
      || !text(turn.source.transcriptPath) || !isAbsolute(turn.source.transcriptPath)
      || !integer(turn.source.endBytes) || turn.source.endBytes === 0
      || !integer(turn.bytes) || turn.bytes === 0 || turn.bytes > CODING_TURN_MAX_BYTES
      || typeof turn.digest !== "string" || !HASH.test(turn.digest)) {
      throw new CodingSessionCursorError("invalid");
    }
    previous = turn.turnIndex;
    identities.add(turn.turnId);
  }
  if (value.batch !== undefined) {
    const batch = value.batch;
    if (!fields(batch, ["id", "turnIds"]) || !text(batch.id)
      || !Array.isArray(batch.turnIds) || batch.turnIds.length === 0
      || batch.turnIds.length > turns.length
      || batch.turnIds.some((id, index) => id !== turns[index].turnId)) {
      throw new CodingSessionCursorError("invalid");
    }
  }
  if (Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`, "utf8") > MAX_CURSOR_BYTES) {
    throw new CodingSessionCursorError("too_large");
  }
  return value as CodingSessionCursor;
}

function validScope(value: unknown): value is RepositoryMemoryScope {
  if (!fields(value, ["schemaVersion", "baseUserId", "effectiveUserId", "repositoryKey",
    "repositorySlug", "repositoryName", "identitySource", "scopeKind"],
  ["fallbackReason", "boundWorkspaceRoot"])
    || value.schemaVersion !== "workspace-memory-scope.v1"
    || !text(value.baseUserId) || !text(value.repositorySlug)
    || value.repositoryName !== value.repositorySlug
    || value.effectiveUserId !== `${value.baseUserId}@${value.repositorySlug}`
    || typeof value.repositoryKey !== "string" || !HASH.test(value.repositoryKey)
    || (value.boundWorkspaceRoot !== undefined
      && (!text(value.boundWorkspaceRoot) || !isAbsolute(value.boundWorkspaceRoot)))) return false;
  if (value.scopeKind === "general") {
    return value.identitySource === "general" && value.repositorySlug === "General"
      && value.fallbackReason === undefined;
  }
  if (!text(value.boundWorkspaceRoot)) return false;
  if (value.scopeKind === "git-repository") {
    return (value.identitySource === "origin-remote" || value.identitySource === "git-common-dir")
      && value.fallbackReason === undefined;
  }
  return value.scopeKind === "local-directory" && value.identitySource === "workspace-directory"
    && (value.fallbackReason === undefined || value.fallbackReason === "git_metadata_invalid");
}

function fields(value: unknown, required: string[], optional: string[] = []): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}

function text(value: unknown, maxLength = 8_192): value is string {
  return typeof value === "string" && value.trim().length > 0
    && value.length <= maxLength && !value.includes("\0");
}

function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validProjectionVersion(value: unknown): boolean {
  return value === undefined || value === 1 || value === 2;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
