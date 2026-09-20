import { createHash, randomUUID } from "node:crypto";
import { createNativeCodingSessionUploadRuntime } from "./native-upload.js";
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
  prepareCodingSessionTurn,
  type CodingSessionSourceTurn,
  type PreparedSessionTurn,
} from "./coding-turn.js";
import {
  CODING_SESSION_BATCH_MAX_BYTES,
  CODING_SESSION_EVENT,
  type CodingSessionBatch,
  type SessionTurnMetadata,
  type CodingSessionUploadInput,
  type CodingSessionUploadResult,
  type CodingSessionUploadEnqueue,
  type NativeCodingSessionTurnRef,
  type CodingSessionInteraction,
} from "./contracts.js";

export type { CodingSessionUploadInput, CodingSessionUploadResult, CodingSessionUploadEnqueue } from "./contracts.js";

type CodingSessionUploadClock = {
  now: () => number;
  setTimeout: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (timer: ReturnType<typeof setTimeout>) => void;
};

export type CodingSessionUploadRuntime = {
  enqueue: CodingSessionUploadEnqueue;
  observeInteraction(input: CodingSessionInteraction): Promise<void>;
  discardForScopeUpgrade(upgrade: RepositoryMemorySessionScopeUpgrade): void;
  drain(): Promise<void>;
  close(): void;
};

type UploadBuffer = {
  key: string;
  batchId: string;
  client: PreparedSessionTurn["client"];
  sessionId: string;
  turns: PreparedSessionTurn[];
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
  memoraxCodeHome?: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  readTurn?: (ref: NativeCodingSessionTurnRef) => Promise<CodingSessionSourceTurn | undefined>;
  diagnosticLogger?: MemoryDiagnosticLogger;
  clock?: CodingSessionUploadClock;
}): CodingSessionUploadRuntime {
  const native = options.readTurn
    ? createNativeCodingSessionUploadRuntime({ ...options, readTurn: options.readTurn })
    : undefined;
  // OpenCode supplies SDK records, not a durable file locator. Its existing
  // best-effort path stays separate until the adapter exposes SDK rereading.
  const sdk = createMemoryBufferedCodingSessionUploadRuntime(options);
  return {
    enqueue: (input) => input.turn.client === "opencode" ? sdk.enqueue(input)
      : native?.enqueue(input) ?? { accepted: false, reason: options.enabled ? "source_reader_unavailable" : "disabled" },
    observeInteraction: (input) => native?.observeInteraction(input) ?? Promise.resolve(),
    discardForScopeUpgrade(upgrade) { void native?.discardForScopeUpgrade(upgrade); sdk.discardForScopeUpgrade(upgrade); },
    async drain() { await Promise.all([native?.drain(), sdk.drain()]); },
    close() { native?.close(); sdk.close(); },
  };
}

export function createMemoryBufferedCodingSessionUploadRuntime(options: {
  enabled: boolean;
  diagnosticLogger?: MemoryDiagnosticLogger;
  clock?: CodingSessionUploadClock;
}) {
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
          diagnostic("coding_sessions.upload.stored", { batchId: batch.batch_id, turnCount: batch.turns.length, bytes: buffer.bytes });
          break;
        }
        const delay = retryDelay(result);
        if (closed || attempt === UPLOAD_MAX_ATTEMPTS || delay === undefined) {
          diagnostic("coding_sessions.upload.failed", { batchId: batch.batch_id, code: result.errorCode, turnCount: batch.turns.length });
          break;
        }
        await new Promise<void>((resolve) => clock.setTimeout(resolve, delay));
        if (closed) break;
      }
    } catch {
      // Never retain request content or raw exceptions in upload diagnostics.
      diagnostic("coding_sessions.upload.failed", { batchId: batch.batch_id, code: "upload_failed", turnCount: batch.turns.length });
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
    enqueue(input: CodingSessionUploadInput): CodingSessionUploadResult {
      if (!accepting) return { accepted: false, reason: "closed" };
      const env = input.env ?? process.env;
      if (!options.enabled || !memoraxWritebackEnabled(env)) return { accepted: false, reason: "disabled" };
      const configured = memoraxConfigFromEnv(env);
      if (!configured.ok) return { accepted: false, reason: "config_missing" };
      const scope = input.repositoryScope;
      if (!scope || configured.config.userId !== scope.baseUserId || !scope.effectiveUserId.trim() || !scope.repositorySlug.trim()) {
        return { accepted: false, reason: "scope_mismatch" };
      }
      const normalized = prepareCodingSessionTurn({ ...input.turn, repositorySlug: scope.repositorySlug }, diagnostic);
      if (!normalized) return { accepted: false, reason: "invalid_turn" };
      const key = bufferKey(configured.config, scope, normalized);
      const turnKey = JSON.stringify([key, normalized.turn_id]);
      pruneCompleted();
      // Buffered and in-flight Turns stay reserved until a terminal outcome.
      if (pending.has(turnKey) || completed.has(turnKey)) return { accepted: true };
      const turn = freezeTurn(normalized);
      // The wire payload has two arrays: Turn metadata and flat Responses Items.
      const turnBytes = Buffer.byteLength(JSON.stringify(turnMetadata(turn)), "utf8")
        + Buffer.byteLength(JSON.stringify(turn.items), "utf8") - 2;
      let buffer = buffers.get(key);
      if (buffer && buffer.bytes + turnBytes + 2 > CODING_SESSION_BATCH_MAX_BYTES) {
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
      buffer.bytes += turnBytes + (buffer.turns.length > 0 ? 2 : 0);
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

function batchFor(buffer: UploadBuffer, turns: readonly PreparedSessionTurn[]): CodingSessionBatch {
  const ordered = [...turns].sort((left, right) => left.turn_index - right.turn_index);
  return {
    event: CODING_SESSION_EVENT,
    schema_version: 2,
    redaction_version: 1,
    batch_id: buffer.batchId,
    user_id: buffer.repositoryScope.effectiveUserId,
    client: buffer.client,
    session_id: buffer.sessionId,
    repository_slug: buffer.repositoryScope.repositorySlug,
    turns: Object.freeze(ordered.map((turn) => Object.freeze(turnMetadata(turn)))),
    items: Object.freeze(ordered.flatMap((turn) => turn.items)),
  };
}

function turnMetadata(turn: PreparedSessionTurn): SessionTurnMetadata {
  return {
    turn_id: turn.turn_id,
    turn_index: turn.turn_index,
    closed_at: turn.closed_at,
    item_count: turn.items.length,
    ...(turn.truncation ? { truncation: turn.truncation } : {}),
  };
}

function freezeTurn(turn: PreparedSessionTurn): PreparedSessionTurn {
  return Object.freeze({
    ...turn,
    items: Object.freeze(turn.items.map((item) => {
      if (item.type === "message") {
        item.content.forEach((part) => Object.freeze(part));
        Object.freeze(item.content);
      }
      return Object.freeze(item);
    })),
    ...(turn.truncation ? { truncation: Object.freeze(turn.truncation) } : {}),
  });
}

function bufferKey(config: MemoraxAdapterConfig, scope: RepositoryMemoryScope, turn: PreparedSessionTurn): string {
  const connection = createHash("sha256").update(JSON.stringify([config.baseUrl, config.apiKey])).digest("hex");
  return JSON.stringify([connection, scope.baseUserId, scope.effectiveUserId, scope.repositoryKey, scope.scopeKind, turn.client, turn.session_id]);
}

function retryDelay(failure: MemoraxInvocationFailure): number | undefined {
  const retryable = failure.errorKind === "timeout" || failure.errorKind === "transport"
    || (failure.errorKind === "http" && failure.httpStatus !== undefined
      && (failure.httpStatus === 408 || failure.httpStatus === 429 || failure.httpStatus >= 500));
  return retryable ? Math.min(UPLOAD_MAX_RETRY_DELAY_MS, Math.max(0, failure.retryAfterMs ?? UPLOAD_RETRY_DELAY_MS)) : undefined;
}
