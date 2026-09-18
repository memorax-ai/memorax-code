import { createHash, randomUUID } from "node:crypto";
import type { MemoryDiagnosticLogger } from "../memory/observability.js";
import type { RepositoryMemorySessionScopeUpgrade } from "../memory/repository-session.js";
import {
  memoraxConfigFromEnv,
  memoraxWritebackEnabled,
  type MemoraxAdapterConfig,
} from "../provider/memorax/config.js";
import { uploadCodingSessionBatch } from "../provider/memorax/coding-session.js";
import type { MemoraxInvocationFailure } from "../provider/memorax/http.js";
import {
  repositoryMemoryScopeCanUpgradeFromDegradedGit,
  type RepositoryMemoryScope,
} from "../repository/scope.js";
import {
  normalizeCodingSessionTurn,
  type CodingSessionSourceTurn,
  type NormalizedCodingTurn,
} from "./coding-turn.js";
import {
  CODING_SESSION_BATCH_MAX_BYTES,
  CODING_SESSION_EVENT,
  type CodingSessionBatch,
} from "./contracts.js";

export type CodingSessionUploadInput = {
  turn: CodingSessionSourceTurn;
  repositoryScope: RepositoryMemoryScope;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
};

export type CodingSessionUploadResult = { accepted: true } | { accepted: false; reason: string };
export type CodingSessionUploadEnqueue = (input: CodingSessionUploadInput) => CodingSessionUploadResult;

type CodingSessionUploadClock = {
  now: () => number;
  setTimeout: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (timer: ReturnType<typeof setTimeout>) => void;
};

export type CodingSessionUploadRuntime = {
  enqueue: CodingSessionUploadEnqueue;
  discardForScopeUpgrade(upgrade: RepositoryMemorySessionScopeUpgrade): number;
  drain(): Promise<void>;
  close(): void;
};

type UploadBuffer = {
  key: string;
  batchId: string;
  client: NormalizedCodingTurn["client"];
  sessionId: string;
  turns: NormalizedCodingTurn[];
  turnKeys: string[];
  bytes: number;
  config: MemoraxAdapterConfig;
  repositoryScope: RepositoryMemoryScope;
  fetchImpl?: typeof fetch;
  timer?: ReturnType<typeof setTimeout>;
  timerGeneration: number;
};

export const CODING_SESSION_UPLOAD_IDLE_MS = 10 * 60 * 1000;
const SUCCESS_CACHE_TTL_MS = 15 * 60 * 1000;
const SUCCESS_CACHE_MAX_ITEMS = 10_000;
const UPLOAD_MAX_ATTEMPTS = 2;
const UPLOAD_RETRY_DELAY_MS = 100;
const UPLOAD_MAX_RETRY_DELAY_MS = 5_000;
const SYSTEM_CLOCK: CodingSessionUploadClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer),
};

export function createCodingSessionUploadRuntime(options: {
  enabled: boolean;
  diagnosticLogger?: MemoryDiagnosticLogger;
  clock?: CodingSessionUploadClock;
}): CodingSessionUploadRuntime {
  const clock = options.clock ?? SYSTEM_CLOCK;
  const buffers = new Map<string, UploadBuffer>();
  const pending = new Set<string>();
  const completed = new Map<string, number>();
  const inFlight = new Set<Promise<void>>();
  let accepting = true;
  let closed = false;
  let draining: Promise<void> | undefined;

  const diagnostic: MemoryDiagnosticLogger = (message, fields) => {
    try { options.diagnosticLogger?.(message, fields); } catch { /* Diagnostics cannot change delivery. */ }
  };

  function pruneCompleted(): void {
    const now = clock.now();
    for (const [key, expiresAt] of completed) {
      if (expiresAt > now && completed.size <= SUCCESS_CACHE_MAX_ITEMS) break;
      completed.delete(key);
    }
  }

  function releaseBuffer(buffer: UploadBuffer): void {
    buffers.delete(buffer.key);
    if (buffer.timer !== undefined) clock.clearTimeout(buffer.timer);
  }

  async function send(buffer: UploadBuffer, batch: CodingSessionBatch): Promise<void> {
    let stored = false;
    try {
      for (let attempt = 1; attempt <= UPLOAD_MAX_ATTEMPTS; attempt += 1) {
        const result = await uploadCodingSessionBatch(batch, {
          config: buffer.config,
          repositoryScope: buffer.repositoryScope,
          fetchImpl: buffer.fetchImpl,
        });
        if (result.ok) {
          stored = true;
          diagnostic("coding_sessions.upload.stored", { batchId: batch.batch_id, turnCount: batch.coding_turns.length, bytes: buffer.bytes });
          break;
        }
        const delay = retryDelay(result);
        if (closed || attempt === UPLOAD_MAX_ATTEMPTS || delay === undefined) {
          diagnostic("coding_sessions.upload.failed", { batchId: batch.batch_id, code: result.errorCode, turnCount: batch.coding_turns.length });
          break;
        }
        await new Promise<void>((resolve) => clock.setTimeout(resolve, delay));
        if (closed) break;
      }
    } catch {
      // Never retain request content or raw exceptions in upload diagnostics.
      diagnostic("coding_sessions.upload.failed", { batchId: batch.batch_id, code: "upload_failed", turnCount: batch.coding_turns.length });
    } finally {
      for (const key of buffer.turnKeys) {
        pending.delete(key);
        if (stored && !closed) completed.set(key, clock.now() + SUCCESS_CACHE_TTL_MS);
      }
      pruneCompleted();
    }
  }

  function flush(buffer: UploadBuffer): void {
    if (buffers.get(buffer.key) !== buffer) return;
    releaseBuffer(buffer);
    const batch = Object.freeze(batchFor(buffer, Object.freeze(buffer.turns)));
    const task = send(buffer, batch);
    inFlight.add(task);
    void task.finally(() => inFlight.delete(task));
  }

  function resetIdleTimer(buffer: UploadBuffer): void {
    if (buffer.timer !== undefined) clock.clearTimeout(buffer.timer);
    const generation = ++buffer.timerGeneration;
    buffer.timer = clock.setTimeout(() => {
      if (buffers.get(buffer.key) === buffer && buffer.timerGeneration === generation) flush(buffer);
    }, CODING_SESSION_UPLOAD_IDLE_MS);
    buffer.timer.unref?.();
  }

  function discardForScopeUpgrade(upgrade: RepositoryMemorySessionScopeUpgrade): number {
    let discarded = 0;
    for (const buffer of buffers.values()) {
      if (buffer.client !== upgrade.client || buffer.sessionId !== upgrade.sessionId
        || !repositoryMemoryScopeCanUpgradeFromDegradedGit(buffer.repositoryScope, upgrade.currentScope)) continue;
      releaseBuffer(buffer);
      for (const key of buffer.turnKeys) pending.delete(key);
      diagnostic("coding_sessions.upload.discarded", { reason: "scope_upgraded", turnCount: buffer.turns.length });
      discarded += 1;
    }
    return discarded;
  }

  return {
    enqueue(input) {
      if (!accepting) return { accepted: false, reason: "closed" };
      const env = input.env ?? process.env;
      if (!options.enabled || !memoraxWritebackEnabled(env)) return { accepted: false, reason: "disabled" };
      const configured = memoraxConfigFromEnv(env);
      if (!configured.ok) return { accepted: false, reason: "config_missing" };
      const scope = input.repositoryScope;
      if (!scope || configured.config.userId !== scope.baseUserId || !scope.effectiveUserId.trim() || !scope.repositorySlug.trim()) {
        return { accepted: false, reason: "scope_mismatch" };
      }
      const normalized = normalizeCodingSessionTurn({ ...input.turn, repositorySlug: scope.repositorySlug }, diagnostic);
      if (!normalized) return { accepted: false, reason: "invalid_turn" };
      const key = bufferKey(configured.config, scope, normalized);
      const turnKey = JSON.stringify([key, normalized.turn_id]);
      pruneCompleted();
      // Buffered and in-flight Turns stay reserved until a terminal outcome.
      if (pending.has(turnKey) || completed.has(turnKey)) return { accepted: true };
      const turn = freezeTurn(normalized);
      const turnBytes = Buffer.byteLength(JSON.stringify(turn), "utf8");
      let buffer = buffers.get(key);
      if (buffer && buffer.bytes + turnBytes + 1 > CODING_SESSION_BATCH_MAX_BYTES) {
        flush(buffer);
        buffer = undefined;
      }
      if (!buffer) {
        buffer = {
          key,
          batchId: randomUUID(),
          client: turn.client,
          sessionId: turn.session_id,
          turns: [],
          turnKeys: [],
          bytes: 0,
          config: Object.freeze({ ...configured.config }),
          repositoryScope: Object.freeze({ ...scope }),
          fetchImpl: input.fetchImpl,
          timerGeneration: 0,
        };
        buffer.bytes = Buffer.byteLength(JSON.stringify(batchFor(buffer, [])), "utf8");
        if (buffer.bytes + turnBytes > CODING_SESSION_BATCH_MAX_BYTES) return { accepted: false, reason: "turn_too_large" };
        buffers.set(key, buffer);
      }
      buffer.bytes += turnBytes + (buffer.turns.length > 0 ? 1 : 0);
      buffer.turns.push(turn);
      buffer.turnKeys.push(turnKey);
      pending.add(turnKey);
      if (buffer.bytes === CODING_SESSION_BATCH_MAX_BYTES) flush(buffer);
      else resetIdleTimer(buffer);
      return { accepted: true };
    },
    discardForScopeUpgrade,
    drain() {
      if (!draining) {
        accepting = false;
        for (const buffer of buffers.values()) flush(buffer);
        draining = (async () => {
          while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
        })();
      }
      return draining;
    },
    close() {
      accepting = false;
      closed = true;
      for (const buffer of buffers.values()) {
        releaseBuffer(buffer);
        for (const key of buffer.turnKeys) pending.delete(key);
      }
      completed.clear();
    },
  };
}

function batchFor(buffer: UploadBuffer, turns: readonly NormalizedCodingTurn[]): CodingSessionBatch {
  return {
    event: CODING_SESSION_EVENT,
    batch_id: buffer.batchId,
    user_id: buffer.repositoryScope.effectiveUserId,
    client: buffer.client,
    session_id: buffer.sessionId,
    coding_turns: turns,
  };
}

function freezeTurn(turn: NormalizedCodingTurn): NormalizedCodingTurn {
  return Object.freeze({
    ...turn,
    events: Object.freeze(turn.events.map((event) => Object.freeze(event))),
    ...(turn.truncation ? { truncation: Object.freeze(turn.truncation) } : {}),
  });
}

function bufferKey(config: MemoraxAdapterConfig, scope: RepositoryMemoryScope, turn: NormalizedCodingTurn): string {
  const connection = createHash("sha256").update(JSON.stringify([config.baseUrl, config.apiKey])).digest("hex");
  return JSON.stringify([connection, scope.baseUserId, scope.effectiveUserId, scope.repositoryKey, scope.scopeKind, turn.client, turn.session_id]);
}

function retryDelay(failure: MemoraxInvocationFailure): number | undefined {
  const retryable = failure.errorKind === "timeout" || failure.errorKind === "transport"
    || (failure.errorKind === "http" && failure.httpStatus !== undefined
      && (failure.httpStatus === 408 || failure.httpStatus === 429 || failure.httpStatus >= 500));
  return retryable ? Math.min(UPLOAD_MAX_RETRY_DELAY_MS, Math.max(0, failure.retryAfterMs ?? UPLOAD_RETRY_DELAY_MS)) : undefined;
}
