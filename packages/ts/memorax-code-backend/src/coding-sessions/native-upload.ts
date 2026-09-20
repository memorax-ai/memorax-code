import { createHash, randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import type { MemoryDiagnosticLogger } from "../memory/observability.js";
import type { RepositoryMemorySessionScopeUpgrade } from "../memory/repository-session.js";
import { defaultMemoraxCodeHome, loadMemoraxCodeConfig, memoraxConfigFromEnv, memoraxWritebackEnabled } from "../provider/memorax/config.js";
import { uploadCodingSessionBatch } from "../provider/memorax/coding-session.js";
import {
  repositoryMemoryScopeCanUpgradeFromDegradedGit, repositoryMemoryScopesMatch,
  resolveRepositoryMemoryScope, type RepositoryMemoryScope,
} from "../repository/scope.js";
import { prepareCodingSessionTurn, type CodingSessionSourceTurn, type PreparedSessionTurn } from "./coding-turn.js";
import {
  CODING_SESSION_BATCH_MAX_BYTES, CODING_SESSION_EVENT, type CodingSessionBatch, type SessionTurnMetadata,
  type CodingSessionUploadInput, type CodingSessionUploadResult, type NativeCodingSessionTurnRef, type CodingSessionInteraction,
} from "./contracts.js";
import { createCodingSessionCursorStore, type CodingSessionCursor, type NativeArchiveTurn } from "./cursor-store.js";
export type NativeUploadClock = {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
};

export const CODING_SESSION_UPLOAD_TRIGGER_BYTES = 1024 * 1024;
export const CODING_SESSION_UPLOAD_MAX_TURNS = 50;
export const CODING_SESSION_UPLOAD_IDLE_MIN_TURNS = 5;
export const CODING_SESSION_UPLOAD_SHORT_IDLE_MS = 30 * 60 * 1000;
export const CODING_SESSION_UPLOAD_TAIL_IDLE_MS = 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;
const RETRY_DELAY_MS = 5 * 60 * 1000;

export function createNativeCodingSessionUploadRuntime(options: {
  enabled: boolean;
  memoraxCodeHome?: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  readTurn: (ref: NativeCodingSessionTurnRef) => Promise<CodingSessionSourceTurn | undefined>;
  diagnosticLogger?: MemoryDiagnosticLogger;
  clock?: NativeUploadClock;
}) {
  const env = options.env ?? process.env;
  const clock = options.clock ?? { now: Date.now, setTimeout, clearTimeout };
  const home = options.memoraxCodeHome ?? defaultMemoraxCodeHome(env);
  const store = createCodingSessionCursorStore(home);
  let accepting = true;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sweeping: Promise<void> | undefined;
  let requested = false;
  let draining = false;
  const mutations = new Set<Promise<unknown>>();

  function diagnostic(code: string): void {
    try { options.diagnosticLogger?.("coding_sessions.upload", { code }); } catch { /* Best effort. */ }
  }

  function configured() {
    if (!options.enabled || !memoraxWritebackEnabled(env)) return undefined;
    const value = memoraxConfigFromEnv(env, loadMemoraxCodeConfig(home));
    return value.ok ? value.config : undefined;
  }

  function track<T>(operation: Promise<T>): Promise<T> {
    mutations.add(operation);
    void operation.then(() => mutations.delete(operation), () => mutations.delete(operation));
    return operation;
  }

  function due(state: CodingSessionCursor): boolean {
    if (state.discarded || state.turns.length === 0 || (state.retryAt ?? 0) > clock.now()) return false;
    const idle = Math.max(0, clock.now() - state.lastInteractionAt);
    return Boolean(state.batch) || state.turns.length >= CODING_SESSION_UPLOAD_MAX_TURNS
      || estimatedBytes(state) >= CODING_SESSION_UPLOAD_TRIGGER_BYTES
      || idle >= CODING_SESSION_UPLOAD_TAIL_IDLE_MS
      || (state.turns.length >= CODING_SESSION_UPLOAD_IDLE_MIN_TURNS
        && (draining || idle >= CODING_SESSION_UPLOAD_SHORT_IDLE_MS));
  }

  async function upload(key: string): Promise<void> {
    // Separate locks let new completions persist while one request is in flight.
    await store.withUploadLock(key, async () => {
      let state = store.read(key);
      const config = configured();
      if (closed || !state || !config || state.connection !== connectionKey(config) || !due(state)) return;
      const current = await resolveRepositoryMemoryScope({
        workspaceRoot: state.repositoryScope.boundWorkspaceRoot,
        workspaceKind: state.repositoryScope.scopeKind === "general" ? "projectless" : undefined,
        baseUserId: config.userId,
      });
      if (!current.ok || !repositoryMemoryScopesMatch(state.repositoryScope, current.scope)) {
        diagnostic("scope_mismatch");
        return;
      }
      state = await store.update(key, (latest) => {
        if (!latest || !due(latest)) return { value: undefined };
        if (latest.batch) return { value: latest };
        const selected: NativeArchiveTurn[] = [];
        let bytes = envelopeBytes(latest);
        for (const turn of latest.turns) {
          if (bytes + turn.bytes + (selected.length ? 2 : 0) > CODING_SESSION_BATCH_MAX_BYTES) break;
          bytes += turn.bytes + (selected.length ? 2 : 0);
          selected.push(turn);
          if (bytes >= CODING_SESSION_UPLOAD_TRIGGER_BYTES || selected.length >= CODING_SESSION_UPLOAD_MAX_TURNS) break;
        }
        if (!selected.length) throw new Error("Archive Turn exceeds batch limit");
        const next = { ...latest, batch: { id: randomUUID(), turnIds: selected.map((turn) => turn.turnId) } };
        return { state: next, value: next };
      });
      if (!state?.batch || closed) return;
      const selected = state.turns.slice(0, state.batch.turnIds.length);
      try {
        const turns: PreparedSessionTurn[] = [];
        for (const reference of selected) {
          const source = await options.readTurn({
            client: state.client, sessionId: state.sessionId, turnId: reference.turnId,
            turnIndex: reference.turnIndex, closedAt: reference.closedAt, outcome: "completed", source: reference.source,
          });
          const turn = source && prepareCodingSessionTurn({ ...source, repositorySlug: state.repositoryScope.repositorySlug });
          if (!turn || turn.client !== state.client || turn.session_id !== state.sessionId
            || turn.turn_id !== reference.turnId || turn.turn_index !== reference.turnIndex
            || digest(turn) !== reference.digest) throw new Error("Archive source changed or unavailable");
          turns.push(turn);
        }
        const batch = batchFor(state, turns);
        if (Buffer.byteLength(JSON.stringify(batch), "utf8") > CODING_SESSION_BATCH_MAX_BYTES) throw new Error("Archive batch exceeds limit");
        // Recheck opt-in/account and scope discard after native reads, before sending.
        const active = configured();
        if (closed || !active || connectionKey(active) !== state.connection || store.read(key)?.discarded) return;
        const result = await uploadCodingSessionBatch(batch, {
          config: active, repositoryScope: state.repositoryScope, fetchImpl: options.fetchImpl,
        });
        if (!result.ok) throw new Error("Archive storage unconfirmed");
        const completedBatchId = state.batch.id;
        await store.update(key, (latest) => {
          if (!latest || latest.batch?.id !== completedBatchId || latest.discarded) return { value: undefined };
          const { batch: _batch, retryAt: _retryAt, ...remaining } = latest;
          return { state: {
            ...remaining, uploadedThrough: selected.at(-1)!.turnIndex,
            confirmedTurns: selected.map(({ turnId, turnIndex, digest }) => ({ turnId, turnIndex, digest })),
            turns: latest.turns.slice(selected.length),
          }, value: undefined };
        });
        diagnostic("stored");
        requested = true;
      } catch {
        // Keep the same references and batch ID, including after a lost receipt.
        await store.update(key, (latest) => latest && !latest.discarded
          ? { state: { ...latest, retryAt: clock.now() + RETRY_DELAY_MS }, value: undefined }
          : { value: undefined });
        diagnostic("source_or_upload_unconfirmed");
      }
    });
  }

  function wake(): Promise<void> {
    requested = true;
    if (!sweeping) {
      sweeping = (async () => {
        do {
          requested = false;
          if (!closed && configured()) {
            for (const key of await store.list()) {
              if (closed) break;
              try { await upload(key); } catch { diagnostic("cursor_or_lock_unavailable"); }
            }
          }
        } while (requested && !closed);
      })().catch(() => { diagnostic("cursor_scan_failed"); }).finally(() => {
        sweeping = undefined;
        if (requested && !closed) void wake();
      });
    }
    return sweeping;
  }

  function schedule(): void {
    if (closed || draining || !options.enabled) return;
    timer = clock.setTimeout(() => { void wake().finally(schedule); }, SWEEP_INTERVAL_MS);
    timer.unref?.();
  }
  if (options.enabled) { void wake(); schedule(); }

  return {
    enqueue(input: CodingSessionUploadInput): Promise<CodingSessionUploadResult> {
      return track((async () => {
        if (!accepting) return { accepted: false, reason: "closed" } as const;
        const config = configured();
        if (!config) return { accepted: false, reason: "disabled" } as const;
        const scope = input.repositoryScope;
        if (config.userId !== scope.baseUserId) return { accepted: false, reason: "scope_mismatch" } as const;
        const source = input.turn.source;
        if (input.turn.client === "opencode" || !source || !isAbsolute(source.transcriptPath)
          || !Number.isSafeInteger(source.endBytes) || source.endBytes <= 0) {
          return { accepted: false, reason: "source_unavailable" } as const;
        }
        const turn = prepareCodingSessionTurn({ ...input.turn, repositorySlug: scope.repositorySlug });
        if (!turn) return { accepted: false, reason: "invalid_turn" } as const;
        const connection = connectionKey(config);
        const key = cursorKey(connection, scope, input.turn.client, turn.session_id);
        const reference: NativeArchiveTurn = {
          turnId: turn.turn_id, turnIndex: turn.turn_index, closedAt: turn.closed_at,
          source: { ...source }, digest: digest(turn),
          bytes: Buffer.byteLength(JSON.stringify(turnMetadata(turn))) + Buffer.byteLength(JSON.stringify(turn.items)) - 2,
        };
        const client = input.turn.client;
        try {
          const result = await store.update<CodingSessionUploadResult>(key, (previous) => {
            const state: CodingSessionCursor = previous ?? {
              version: 1, key, connection, client, sessionId: turn.session_id, repositoryScope: { ...scope },
              lastInteractionAt: clock.now(), uploadedThrough: 0, turns: [],
            };
            if (state.discarded) return { value: { accepted: false, reason: "scope_mismatch" } as CodingSessionUploadResult };
            if (reference.turnIndex <= state.uploadedThrough) {
              const confirmed = state.confirmedTurns?.some((item) => item.turnId === reference.turnId
                && item.turnIndex === reference.turnIndex && item.digest === reference.digest);
              return { value: confirmed ? { accepted: true } : { accepted: false, reason: "turn_before_checkpoint" } };
            }
            const existing = state.turns.find((item) => item.turnId === reference.turnId || item.turnIndex === reference.turnIndex);
            if (existing) return { value: existing.turnId === reference.turnId && existing.digest === reference.digest
              ? { accepted: true } : { accepted: false, reason: "source_mismatch" } };
            // Never insert into a batch already frozen for transmission.
            if (state.batch && reference.turnIndex <= state.turns[state.batch.turnIds.length - 1].turnIndex) {
              return { value: { accepted: false, reason: "turn_order_mismatch" } as CodingSessionUploadResult };
            }
            return { state: {
              ...state, turns: [...state.turns, reference].sort((a, b) => a.turnIndex - b.turnIndex), lastInteractionAt: clock.now(),
            }, value: { accepted: true } as CodingSessionUploadResult };
          });
          if (result.accepted) void wake();
          return result;
        } catch {
          diagnostic("cursor_write_failed");
          return { accepted: false, reason: "cursor_unavailable" } as const;
        }
      })());
    },
    observeInteraction(input: CodingSessionInteraction): Promise<void> {
      return track((async () => {
        const config = configured();
        if (!accepting || !config || input.client === "opencode") return;
        const key = cursorKey(connectionKey(config), input.repositoryScope, input.client, input.sessionId);
        try {
          await store.update(key, (state) => state && !state.discarded
            ? { state: { ...state, lastInteractionAt: clock.now() }, value: undefined } : { value: undefined });
        } catch { diagnostic("activity_write_failed"); }
      })());
    },
    discardForScopeUpgrade(upgrade: RepositoryMemorySessionScopeUpgrade): Promise<void> {
      return track((async () => {
        for (const key of await store.list()) {
          try {
            await store.update(key, (state) => state && state.client === upgrade.client && state.sessionId === upgrade.sessionId
              && repositoryMemoryScopeCanUpgradeFromDegradedGit(state.repositoryScope, upgrade.currentScope)
              ? { state: { ...state, discarded: true, turns: [], batch: undefined }, value: undefined } : { value: undefined });
          } catch { diagnostic("scope_discard_failed"); }
        }
      })().catch(() => { diagnostic("scope_discard_failed"); }));
    },
    async drain(): Promise<void> {
      accepting = false;
      draining = true;
      if (timer) clock.clearTimeout(timer);
      await Promise.allSettled([...mutations]);
      await wake();
    },
    close(): void {
      accepting = false;
      closed = true;
      if (timer) clock.clearTimeout(timer);
      // Native references and unconfirmed progress survive process shutdown.
    },
    // Also used for deterministic timer/restart verification without real waits.
    settle(): Promise<void> { return sweeping ?? Promise.resolve(); },
  };
}

function connectionKey(config: { baseUrl: string; apiKey: string; userId: string }): string {
  return createHash("sha256").update(JSON.stringify([config.baseUrl, config.apiKey, config.userId])).digest("hex");
}

function cursorKey(connection: string, scope: RepositoryMemoryScope, client: string, sessionId: string): string {
  return createHash("sha256").update(JSON.stringify([
    connection, scope.baseUserId, scope.effectiveUserId, scope.repositoryKey, scope.scopeKind,
    scope.boundWorkspaceRoot, client, sessionId,
  ])).digest("hex");
}

function turnMetadata(turn: PreparedSessionTurn): SessionTurnMetadata {
  return {
    turn_id: turn.turn_id, turn_index: turn.turn_index, closed_at: turn.closed_at, item_count: turn.items.length,
    ...(turn.truncation ? { truncation: turn.truncation } : {}),
  };
}

function digest(turn: PreparedSessionTurn): string {
  return createHash("sha256").update(JSON.stringify(turn)).digest("hex");
}

function batchFor(state: CodingSessionCursor, turns: PreparedSessionTurn[]): CodingSessionBatch {
  return {
    event: CODING_SESSION_EVENT, schema_version: 2, redaction_version: 1,
    batch_id: state.batch?.id ?? "00000000-0000-0000-0000-000000000000",
    user_id: state.repositoryScope.effectiveUserId, client: state.client, session_id: state.sessionId,
    repository_slug: state.repositoryScope.repositorySlug,
    turns: turns.map(turnMetadata), items: turns.flatMap((turn) => turn.items),
  };
}

function envelopeBytes(state: CodingSessionCursor): number { return Buffer.byteLength(JSON.stringify(batchFor(state, []))); }
function estimatedBytes(state: CodingSessionCursor): number {
  return envelopeBytes(state) + state.turns.reduce((bytes, turn) => bytes + turn.bytes, 0) + Math.max(0, state.turns.length - 1) * 2;
}
