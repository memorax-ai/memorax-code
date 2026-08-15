import { createHash } from "node:crypto";
import { retrieveAutomaticMemoryContext } from "../../memory/automatic-retrieval.js";
import {
  createAutomaticMemoryWritebackRuntime,
  type AutomaticMemoryWritebackEnqueue,
  type AutomaticMemoryWritebackRejectionReason,
  type AutomaticMemoryWritebackRuntime,
} from "../../memory/automatic-writeback.js";
import type {
  DshTurnDiscardCommand,
  DshTurnStartCommand,
  DshWritebackCommand,
  MemoryHookTurnDiscardResult,
  MemoryHookTurnStartResult,
} from "../../memory/hook-command.js";
import type { MemoryDiagnosticLogger, MemoryObservabilityHook } from "../../memory/observability.js";
import {
  createMemoryTurnCoordinator,
  type MemoryTurnCoordinator,
  type MemoryTurnState,
} from "../../memory/turn-coordinator.js";
import {
  createRepositoryMemorySessionRuntime,
  resolvedRepoMemoryWorktree,
  type ConfiguredRepositoryMemoryResult,
  type RepositoryMemorySessionRuntime,
} from "../../memory/repository-session.js";
import type { RepositoryMemoryScopeFailureReason } from "../../repository/scope.js";
import { traceContextFromDshHookBody, type TraceContext } from "../../trace/context.js";
import {
  markCurrentDshTurnOutcome,
  readOpenDshTurn,
  recordDshTraceEvent,
  tracePromptAttestation,
  traceTurnEventId,
  writeCurrentDshTurn,
  type DshTurnOutcome,
  type TracePromptAttestation,
} from "../../trace/store.js";

type DshMemoryHookTurnStart = Omit<DshTurnStartCommand, "version" | "client"> & {
  createdAt: number;
  traceContext?: TraceContext;
};

type DshMemoryHookWritebackRequest = Omit<DshWritebackCommand, "version" | "client"> & {
  traceContext?: TraceContext;
};

type DshMemoryHookWritebackSkipReason =
  | "missing_session_id"
  | "turn_id_missing"
  | "user_text_missing"
  | "assistant_text_missing"
  | "prompt_mismatch"
  | "turn_metadata_missing"
  | "turn_metadata_mismatch"
  | "config_missing"
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
  memoryObservability?: MemoryObservabilityHook;
  memoraxCodeHome?: string;
  repositoryMemorySession?: RepositoryMemorySessionRuntime;
  turnCoordinator?: MemoryTurnCoordinator;
};

export type DshMemoryHookRuntime = {
  recordTurnStart(command: DshTurnStartCommand): Promise<MemoryHookTurnStartResult>;
  writeback(command: DshWritebackCommand): Promise<DshMemoryHookWritebackResult>;
  discardTurn(command: DshTurnDiscardCommand): Promise<MemoryHookTurnDiscardResult>;
  size(): number;
  close(): void;
};

const DSH_MEMORY_TURN_CLIENT = "dsh" as const;

// The coordinator entry is only read with allowStale: true on the recovery
// path, which skips the 30-minute current-turn TTL entirely. A recovery is a
// crash/restart fallback, not an indefinite replay credential, so it still
// gets its own (much wider) hard deadline.
export const DSH_TURN_RECOVERY_WINDOW_MS = 24 * 60 * 60 * 1000;

// Upper bound for the in-memory finalized-turn set below; a cap keeps a
// pathological session from growing the map without bound. Oldest entries are
// evicted first (Map iteration order is insertion order).
const FINALIZED_TURN_LIMIT = 512;

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
  const automaticRetrievalTurns = new Set<string>();
  const automaticRetrievalTurnLimit = positiveInteger(options.maxEntries, 256);
  const writebackLocks = new Map<string, Promise<unknown>>();
  // Turns that reached a terminal state (completed writeback or discard) in
  // this process. Writeback consumes the coordinator entry, so without this
  // set a replayed turn-start for a COMPLETED turn would rebuild the entry and
  // let the replayed writeback schedule a second memory. It is also the
  // in-memory second gate for recovery writebacks (the attestation close on
  // disk is best-effort and can fail silently).
  const finalizedTurns = new Map<string, number>();

  async function materializeDshTurn(
    coordinatorKey: ReturnType<typeof dshTurnKey>,
    request: DshMemoryHookWritebackRequest,
  ): Promise<DshMemoryHookWritebackResult> {
    const entry = turnCoordinator.getTurn(coordinatorKey);
    let metadata: MemoryTurnState | undefined = entry;
    let metadataSource: "coordinator" | "current_turn_trace" = "coordinator";
    let attestedTraceContext: TraceContext | undefined = entry?.traceContext;
    if (entry) {
      if (entry.prompt !== undefined && !dshPromptMatches(entry.prompt, request.userText)) {
        options.diagnosticLogger?.("dsh_memory_hook.writeback", {
          scheduled: false,
          reason: "prompt_mismatch",
          sessionId: request.sessionId,
          turnId: request.turnId,
        });
        return skipped("prompt_mismatch");
      }
    } else {
      // The coordinator entry is gone (evicted by the shared turn cap or a
      // Backend restart). DSH has no transcript file to re-read, but the local
      // current-turn trace written at turn-start still attests that this exact
      // session/turn reached an accepted turn-start. Recover the writeback
      // from that attestation instead of silently dropping it.
      const recoveryKeyForCheck = finalizedTurnKey(request.sessionId, request.turnId);
      if (finalizedTurns.has(recoveryKeyForCheck)) {
        // This exact turn was already recovered (and scheduled) once in this
        // process: the attestation close is best-effort, so the tombstone is
        // what makes a replayed recovery writeback fail closed.
        options.diagnosticLogger?.("dsh_memory_hook.writeback", {
          scheduled: false,
          reason: "turn_metadata_missing",
          metadataSource: "current_turn_trace",
          replayedRecovery: true,
          sessionId: request.sessionId,
          turnId: request.turnId,
        });
        return skipped("turn_metadata_missing");
      }
      const attestation = await readOpenDshTurn({
        memoraxCodeHome: options.memoraxCodeHome,
        env: options.env,
        expectedSessionId: request.sessionId,
        allowStale: true,
      });
      if (!attestation.ok || attestation.traceContext.turnId !== request.turnId) {
        options.diagnosticLogger?.("dsh_memory_hook.writeback", {
          scheduled: false,
          reason: "turn_metadata_missing",
          sessionId: request.sessionId,
          turnId: request.turnId,
        });
        return skipped("turn_metadata_missing");
      }
      // allowStale skips the current-turn TTL, so enforce the recovery window
      // here: an attestation older than DSH_TURN_RECOVERY_WINDOW_MS (or one
      // whose capturedAt cannot be parsed) is not a valid writeback credential.
      const capturedAtMs = Date.parse(attestation.traceContext.capturedAt);
      if (!Number.isFinite(capturedAtMs) || now() - capturedAtMs > DSH_TURN_RECOVERY_WINDOW_MS) {
        options.diagnosticLogger?.("dsh_memory_hook.writeback", {
          scheduled: false,
          reason: "turn_metadata_missing",
          metadataSource: "current_turn_trace",
          attestationExpired: true,
          sessionId: request.sessionId,
          turnId: request.turnId,
        });
        return skipped("turn_metadata_missing");
      }
      // Without an attested cwd there is nothing to bind the recovered turn's
      // repository scope to, and the fallback would be the writeback request's
      // self-reported cwd — the exact trust hole the attestation exists to
      // close. Refuse the recovery instead.
      if (!attestation.traceContext.cwd) {
        options.diagnosticLogger?.("dsh_memory_hook.writeback", {
          scheduled: false,
          reason: "turn_metadata_missing",
          metadataSource: "current_turn_trace",
          attestedCwdMissing: true,
          sessionId: request.sessionId,
          turnId: request.turnId,
        });
        return skipped("turn_metadata_missing");
      }
      // The attestation is only a valid writeback credential when it also pins
      // the started prompt. Without this check the recovery path would accept
      // any userText for an attested turnId; records that predate the
      // prompt attestation field (or carry a torn record) fail closed here.
      if (!attestation.promptAttestation
        || !attestedPromptMatches(attestation.promptAttestation, request.userText)) {
        options.diagnosticLogger?.("dsh_memory_hook.writeback", {
          scheduled: false,
          reason: "prompt_mismatch",
          metadataSource: "current_turn_trace",
          sessionId: request.sessionId,
          turnId: request.turnId,
        });
        return skipped("prompt_mismatch");
      }
      attestedTraceContext = attestation.traceContext;
      metadata = undefined;
      metadataSource = "current_turn_trace";
    }
    // Repository binding comes from what turn-start attested (coordinator
    // entry first, then the trace attestation). The writeback request's own
    // cwd is only a last-resort fallback: a later request must not be able to
    // re-bind an already-started turn to an unrelated workspace.
    const traceContext = traceContextForWriteback(request, entry, attestedTraceContext);
    const writeback = await turnCoordinator.completeMaterializedTurn({
      key: coordinatorKey,
      metadata,
      resolveRepositoryMemory: () => resolveCurrentHookRepositoryMemory(
        request,
        options,
        repositoryMemorySession,
        attestedTraceContext,
      ),
      userText: request.userText,
      assistantText: request.assistantText,
      writeback: {
        client: DSH_MEMORY_TURN_CLIENT,
        sessionKey: request.sessionId,
        env: options.env ?? process.env,
        fetchImpl: options.fetchImpl,
        memoryObservability: options.memoryObservability,
        memoryObservabilitySource: "dsh_hook_writeback",
        traceContext,
      },
    });
    if (!writeback.scheduled) {
      // The writeback was not accepted. Deliberately keep the current-turn
      // attestation OPEN: closing it here would turn a transient rejection
      // (for example a disabled writeback config) into a permanent one,
      // because the retry could no longer recover the turn after the
      // coordinator entry is gone.
      options.diagnosticLogger?.("dsh_memory_hook.writeback", {
        scheduled: false,
        reason: writeback.reason,
        metadataDisposition: writeback.metadataDisposition,
        metadataSource,
        sessionId: request.sessionId,
        turnId: request.turnId,
      });
      return skipped(writeback.reason);
    }
    await recordDshTurnEnd(options, traceContext, request.assistantText);
    // Both paths (coordinator entry and trace recovery) end a terminal turn:
    // record it so a replayed turn-start cannot rebuild the turn and schedule
    // the same memory twice. For the recovery path this is also the
    // in-memory second gate when the best-effort attestation close fails.
    rememberFinalizedTurn(
      finalizedTurns,
      finalizedTurnKey(request.sessionId, request.turnId),
      now(),
    );
    options.diagnosticLogger?.("dsh_memory_hook.writeback", {
      scheduled: true,
      metadataDisposition: writeback.metadataDisposition,
      metadataSource,
      sessionId: request.sessionId,
      turnId: request.turnId,
      promptChars: request.userText.length,
      assistantChars: request.assistantText.length,
      contentSource: "dsh_session_event",
    });
    releaseAutomaticRetrievalTurn(automaticRetrievalTurns, request.sessionId, request.turnId);
    return { ok: true, scheduled: true };
  }

  async function materializeTurnStart(
    coordinatorKey: ReturnType<typeof dshTurnKey>,
    turn: DshMemoryHookTurnStart,
  ): Promise<
    | { ok: true; fresh: false }
    | {
      ok: true;
      fresh: true;
      repositoryMemory: ConfiguredRepositoryMemoryResult;
      repoMemoryWorktree: string | undefined;
    }
  > {
    const existing = turnCoordinator.getTurn(coordinatorKey);
    if (!existing) {
      // Completed/interrupted turns must not restart. Writeback consumes the
      // coordinator entry, so its absence cannot distinguish "never started"
      // from "already finished" — and a DSH reconnect that replays session
      // events re-sends the SAME turnId, which would otherwise rebuild the
      // entry and let the replayed writeback schedule a second memory.
      const finalizationKey = finalizedTurnKey(turn.sessionId, turn.turnId);
      let finalized = finalizedTurns.has(finalizationKey);
      if (!finalized) {
        // After a Backend restart the in-memory set is empty; the on-disk
        // current-turn record still remembers the last finalized turn.
        const onDisk = await readOpenDshTurn({
          memoraxCodeHome: options.memoraxCodeHome,
          env: options.env,
          expectedSessionId: turn.sessionId,
          allowStale: true,
        });
        if (!onDisk.ok && onDisk.reason === "closed" && onDisk.traceContext.turnId === turn.turnId) {
          rememberFinalizedTurn(finalizedTurns, finalizationKey, now());
          finalized = true;
        }
      }
      if (finalized) {
        options.diagnosticLogger?.("dsh_memory_hook.turn_start_after_finalize", {
          sessionId: turn.sessionId,
          turnId: turn.turnId,
          promptChars: turn.prompt.length,
        });
        // Fail silent like every other DSH hook skip: the replayed start is
        // acknowledged (ok:true) but no entry is recorded, so any replayed
        // writeback has nothing to match against.
        return { ok: true, fresh: false };
      }
    }
    if (existing) {
        if (existing.prompt !== undefined && existing.prompt !== turn.prompt) {
          // Self-heal a colliding turnId instead of dead-ending the turn: the
          // newest start wins. Without this the coordinator would keep
          // answering conflicting_turn_start forever, and the writeback for
          // the live turn could never be accepted. The adapter now avoids
          // collisions within a process (incarnation-suffixed turnIds), so a
          // residual conflict means a rebuilt session or adapter restart.
          options.diagnosticLogger?.("dsh_memory_hook.turn_start_conflict_replaced", {
            sessionId: turn.sessionId,
            turnId: turn.turnId,
            previousCreatedAt: existing.createdAt,
          });
          // The replaced incarnation already claimed automatic retrieval under
          // this (sessionId, turnId). Release the claim so the new prompt can
          // claim it again; without this the self-healed turn would silently
          // lose its retrieval context while the stale claim rots in the set.
          releaseAutomaticRetrievalTurn(automaticRetrievalTurns, turn.sessionId, turn.turnId);
          // Close the replaced incarnation's attestation before overwriting
          // it: the new turn's current-turn write below is best-effort, and if
          // it fails the OPEN record would still vouch for the OLD prompt —
          // letting a writeback carrying the old prompt through the recovery
          // path after an eviction/restart.
          await recordDshTurnInterrupted(options, existing.traceContext);
          turnCoordinator.discardTurn(coordinatorKey, "rolled_back");
        } else {
          return { ok: true, fresh: false };
        }
      }
    const repositoryMemory = await resolveHookRepositoryMemory(turn, options, repositoryMemorySession);
    const repoMemoryWorktree = resolvedRepoMemoryWorktree(repositoryMemory);
    turnCoordinator.recordTurnStart({
      client: DSH_MEMORY_TURN_CLIENT,
      sessionId: turn.sessionId,
      clientTurnId: turn.turnId,
      cwd: turn.cwd,
      workspaceKind: turn.workspaceKind,
      prompt: turn.prompt,
      createdAt: turn.createdAt,
      traceContext: turn.traceContext,
      repositoryMemory,
    });
    return { ok: true, fresh: true, repositoryMemory, repoMemoryWorktree };
  }

  async function discardDshTurn(
    key: ReturnType<typeof dshTurnKey>,
    command: DshTurnDiscardCommand,
  ): Promise<MemoryHookTurnDiscardResult> {
    const entry = turnCoordinator.getTurn(key);
    if (!entry) {
      // The coordinator entry is gone (Backend restart or cap eviction), but
      // the on-disk attestation may still be OPEN for this exact turn. Close
      // it now: an open attestation for a discarded turn would let a delayed
      // or replayed writeback pass the recovery check and write a turn the
      // client explicitly abandoned.
      const attestation = await readOpenDshTurn({
        memoraxCodeHome: options.memoraxCodeHome,
        env: options.env,
        expectedSessionId: command.sessionId,
        allowStale: true,
      });
      if (attestation.ok && attestation.traceContext.turnId === command.turnId) {
        await recordDshTurnInterrupted(options, attestation.traceContext);
        releaseAutomaticRetrievalTurn(automaticRetrievalTurns, command.sessionId, command.turnId);
        rememberFinalizedTurn(finalizedTurns, finalizedTurnKey(command.sessionId, command.turnId), now());
        options.diagnosticLogger?.("dsh_memory_hook.turn_discarded", {
          sessionId: command.sessionId,
          turnId: command.turnId,
          metadataSource: "current_turn_trace",
        });
      }
      return { ok: true, discarded: false };
    }
    await recordDshTurnInterrupted(options, entry.traceContext);
    turnCoordinator.discardTurn(key, "interrupted");
    releaseAutomaticRetrievalTurn(automaticRetrievalTurns, command.sessionId, command.turnId);
    rememberFinalizedTurn(finalizedTurns, finalizedTurnKey(command.sessionId, command.turnId), now());
    options.diagnosticLogger?.("dsh_memory_hook.turn_discarded", {
      sessionId: command.sessionId,
      turnId: command.turnId,
    });
    return { ok: true, discarded: true };
  }

  return {
    async recordTurnStart(command) {
      const turn = turnStartFromCommand(command, now());
      if (!turn.sessionId || !turn.turnId || !turn.prompt) {
        options.diagnosticLogger?.("dsh_memory_hook.turn_start_skipped", {
          reason: !turn.sessionId
            ? "missing_session_id"
            : !turn.turnId
              ? "turn_id_missing"
              : "prompt_missing",
          sessionId: turn.sessionId,
          turnId: turn.turnId,
        });
        return { ok: true };
      }
      turnCoordinator.pruneExpired();
      const coordinatorKey = dshTurnKey(turn.sessionId, turn.turnId);
      const materialized = await runSerialized(
        writebackLocks,
        dshTurnLockKey(coordinatorKey),
        () => materializeTurnStart(coordinatorKey, turn),
      );
      if (!materialized.fresh) return { ok: true };
      const { repositoryMemory, repoMemoryWorktree } = materialized;
      const promptAttestation = tracePromptAttestation(turn.prompt);
      options.diagnosticLogger?.("dsh_memory_hook.turn_start", {
        sessionId: turn.sessionId,
        turnId: turn.turnId,
        promptChars: turn.prompt.length,
        cacheSize: turnCoordinator.size(DSH_MEMORY_TURN_CLIENT),
        workspace: repositoryMemory.ok ? repositoryMemory.memory.scope?.repositorySlug : undefined,
        workspaceScopeReason: repositoryMemory.ok ? undefined : repositoryMemory.reason,
      });
      // Both trace writes share the turn's serialization lock with
      // materializeTurnStart / writeback / discard. Writing them unlocked
      // allowed this race: ESC-discard runs mark(turn) against a record that
      // has not been written yet, then the turn-start write lands afterwards
      // and leaves an OPEN attestation for a turn that was already discarded.
      await runSerialized(writebackLocks, dshTurnLockKey(coordinatorKey), async () => {
        await recordTraceBestEffort("dsh_memory_hook.turn_start_event", recordDshTraceEvent({
          eventId: traceTurnEventId(turn.traceContext, "turn_start"),
          memoraxCodeHome: options.memoraxCodeHome,
          env: options.env,
          traceContext: turn.traceContext,
          type: "turn_start",
          source: "unknown",
          operation: "query",
          ok: true,
          request: {
            // Hash only, never the prompt text: with the default
            // captureContent=true the event file would otherwise store the
            // plaintext right next to the hashed attestation, destroying the
            // secret the recovery path's prompt check relies on.
            promptChars: promptAttestation.chars,
            promptSha256: promptAttestation.sha256,
            cwd: turn.cwd,
          },
        }), options.diagnosticLogger);
        await recordTraceBestEffort("dsh_memory_hook.current_turn_write", writeCurrentDshTurn(
          turn.traceContext,
          {
            memoraxCodeHome: options.memoraxCodeHome,
            env: options.env,
            now: () => new Date(now()),
            // Pin the started prompt so the writeback recovery path can verify
            // the userText it is asked to schedule (hash only: the trace file
            // never receives the prompt itself).
            promptAttestation,
          },
        ), options.diagnosticLogger);
        if (!turnCoordinator.getTurn(coordinatorKey)) {
          // A concurrent discard won the lock between materializeTurnStart and
          // this write: the entry is gone but the attestation we just wrote is
          // OPEN. Close it now instead of leaving a replay credential for an
          // abandoned turn.
          await recordDshTurnInterrupted(options, turn.traceContext);
        }
      });
      if (!claimAutomaticRetrievalTurn(
        automaticRetrievalTurns,
        automaticRetrievalTurnLimit,
        turn.sessionId,
        turn.turnId,
      )) {
        return {
          ok: true,
          ...(repoMemoryWorktree ? { repoMemoryWorktree } : {}),
        };
      }
      const retrieval = await retrieveAutomaticMemoryContext({
        diagnosticLogger: options.diagnosticLogger,
        env: options.env ?? process.env,
        fetchImpl: options.fetchImpl,
        memoryObservability: options.memoryObservability,
        memoryObservabilitySource: "dsh_hook_retrieval",
        query: turn.prompt,
        repositoryMemory,
        sessionKey: turn.sessionId,
        traceContext: turn.traceContext,
      });
      return {
        ok: true,
        ...(repoMemoryWorktree ? { repoMemoryWorktree } : {}),
        ...(retrieval.context ? { additionalContext: retrieval.context } : {}),
      };
    },
    async writeback(command) {
      turnCoordinator.pruneExpired();
      const request = writebackRequestFromCommand(command);
      if (!request.sessionId) return skipped("missing_session_id");
      if (!request.turnId) return skipped("turn_id_missing");
      if (!request.userText) return skipped("user_text_missing");
      if (!request.assistantText) return skipped("assistant_text_missing");
      const coordinatorKey = dshTurnKey(request.sessionId, request.turnId);
      return await runSerialized(
        writebackLocks,
        dshTurnLockKey(coordinatorKey),
        () => materializeDshTurn(coordinatorKey, request),
      );
    },
    async discardTurn(command) {
      turnCoordinator.pruneExpired();
      if (!command.sessionId || !command.turnId) return { ok: true, discarded: false };
      const key = dshTurnKey(command.sessionId, command.turnId);
      return await runSerialized(
        writebackLocks,
        dshTurnLockKey(key),
        () => discardDshTurn(key, command),
      );
    },
    size() {
      return turnCoordinator.size(DSH_MEMORY_TURN_CLIENT);
    },
    close() {
      automaticRetrievalTurns.clear();
      writebackLocks.clear();
      if (ownsTurnCoordinator) turnCoordinator.close();
      if (ownsRepositoryMemorySession) repositoryMemorySession.close();
      automaticWritebackRuntime?.close?.();
    },
  };
}

async function resolveHookRepositoryMemory(
  entry: Pick<DshMemoryHookTurnStart, "sessionId" | "cwd" | "workspaceKind">,
  options: DshMemoryHookRuntimeOptions,
  repositoryMemorySession: RepositoryMemorySessionRuntime,
): Promise<ConfiguredRepositoryMemoryResult> {
  return await repositoryMemorySession.resolve({
    client: DSH_MEMORY_TURN_CLIENT,
    sessionId: entry.sessionId,
    workspaceRoot: entry.cwd,
    workspaceKind: entry.workspaceKind,
    memoraxCodeHome: options.memoraxCodeHome ?? options.env?.MEMORAX_CODE_HOME,
    env: options.env,
  });
}

async function resolveCurrentHookRepositoryMemory(
  request: DshMemoryHookWritebackRequest,
  options: DshMemoryHookRuntimeOptions,
  repositoryMemorySession: RepositoryMemorySessionRuntime,
  attestedTraceContext: TraceContext | undefined,
): Promise<ConfiguredRepositoryMemoryResult> {
  return await repositoryMemorySession.resolve({
    client: DSH_MEMORY_TURN_CLIENT,
    sessionId: request.sessionId,
    // The cwd/workspaceKind attested at turn-start win over the writeback
    // request: a writeback cannot re-bind the turn to another workspace.
    workspaceRoot: attestedTraceContext?.cwd ?? request.cwd,
    workspaceKind: attestedTraceContext?.workspaceKind ?? request.workspaceKind,
    memoraxCodeHome: options.memoraxCodeHome ?? options.env?.MEMORAX_CODE_HOME,
    env: options.env,
  });
}

function turnStartFromCommand(
  command: DshTurnStartCommand,
  createdAt: number,
): DshMemoryHookTurnStart {
  return {
    sessionId: command.sessionId,
    turnId: command.turnId,
    cwd: command.cwd,
    workspaceKind: command.workspaceKind,
    prompt: command.prompt,
    createdAt,
    traceContext: traceContextFromDshHookBody({
      sessionId: command.sessionId,
      turnId: command.turnId,
      cwd: command.cwd,
      workspaceKind: command.workspaceKind,
    }, new Date(createdAt).toISOString()),
  };
}

function writebackRequestFromCommand(
  command: DshWritebackCommand,
): DshMemoryHookWritebackRequest {
  return {
    sessionId: command.sessionId,
    turnId: command.turnId,
    userText: command.userText,
    assistantText: command.assistantText,
    cwd: command.cwd,
    workspaceKind: command.workspaceKind,
    traceContext: traceContextFromDshHookBody({
      sessionId: command.sessionId,
      turnId: command.turnId,
      cwd: command.cwd,
      workspaceKind: command.workspaceKind,
    }),
  };
}

async function recordDshTurnEnd(
  options: DshMemoryHookRuntimeOptions,
  traceContext: TraceContext | undefined,
  assistantText: string,
  details: { outcome?: DshTurnOutcome } = {},
): Promise<void> {
  const outcome = details.outcome ?? "completed";
  await recordTraceBestEffort("dsh_memory_hook.turn_end_event", recordDshTraceEvent({
    eventId: traceTurnEventId(traceContext, "turn_end"),
    memoraxCodeHome: options.memoraxCodeHome,
    env: options.env,
    traceContext,
    type: "turn_end",
    source: "dsh-hook",
    operation: "reply",
    ok: true,
    outcome,
    response: {
      assistantMessage: assistantText,
    },
  }), options.diagnosticLogger);
  const closed = await recordTraceBestEffort("dsh_memory_hook.current_turn_close", markCurrentDshTurnOutcome(
    traceContext,
    outcome,
    {
      memoraxCodeHome: options.memoraxCodeHome,
      env: options.env,
    },
  ), options.diagnosticLogger);
  if (closed && !closed.updated) {
    // The attestation was not closed (not_current_turn / record missing), and
    // recordTraceBestEffort would have swallowed this silently. After a
    // recovery writeback this is the replay gate failing — surface it.
    options.diagnosticLogger?.("dsh_memory_hook.current_turn_close_missed", {
      reason: closed.reason,
      turnId: traceContext?.turnId,
    });
  }
}

function finalizedTurnKey(sessionId: string, turnId: string): string {
  return JSON.stringify([sessionId, turnId]);
}

function rememberFinalizedTurn(
  finalized: Map<string, number>,
  key: string,
  timestamp: number,
): void {
  finalized.delete(key);
  finalized.set(key, timestamp);
  while (finalized.size > FINALIZED_TURN_LIMIT) {
    const oldest = finalized.keys().next().value;
    if (typeof oldest !== "string") return;
    finalized.delete(oldest);
  }
}

async function recordDshTurnInterrupted(
  options: DshMemoryHookRuntimeOptions,
  traceContext: TraceContext | undefined,
): Promise<void> {
  await recordTraceBestEffort("dsh_memory_hook.turn_end_event", recordDshTraceEvent({
    eventId: traceTurnEventId(traceContext, "turn_end"),
    memoraxCodeHome: options.memoraxCodeHome,
    env: options.env,
    traceContext,
    type: "turn_end",
    source: "dsh-hook",
    operation: "reply",
    ok: true,
    outcome: "interrupted",
  }), options.diagnosticLogger);
  await recordTraceBestEffort("dsh_memory_hook.current_turn_close", markCurrentDshTurnOutcome(
    traceContext,
    "interrupted",
    {
      memoraxCodeHome: options.memoraxCodeHome,
      env: options.env,
    },
  ), options.diagnosticLogger);
}

function traceContextForWriteback(
  request: DshMemoryHookWritebackRequest,
  entry: MemoryTurnState | undefined,
  attestedTraceContext: TraceContext | undefined,
): TraceContext | undefined {
  // The context recorded at turn-start is the turn's canonical provenance;
  // the writeback request may only fill fields the attestation lacks.
  const base = entry?.traceContext ?? attestedTraceContext;
  if (!base) return request.traceContext;
  if (!request.traceContext) return base;
  return {
    ...request.traceContext,
    ...base,
    transcriptPath: base.transcriptPath ?? request.traceContext.transcriptPath,
    cwd: base.cwd ?? request.traceContext.cwd,
    workspaceKind: base.workspaceKind ?? request.traceContext.workspaceKind,
  };
}

function dshTurnKey(sessionId: string, turnId: string) {
  return {
    client: DSH_MEMORY_TURN_CLIENT,
    sessionId,
    clientTurnId: turnId,
  } as const;
}

function dshTurnLockKey(key: { client: string; sessionId: string; clientTurnId: string }): string {
  return JSON.stringify([key.client, key.sessionId, key.clientTurnId.trim()]);
}

async function runSerialized<T>(
  locks: Map<string, Promise<unknown>>,
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const run = previous.then(operation, operation);
  const tail = run.then(() => undefined, () => undefined);
  locks.set(key, tail);
  try {
    return await run;
  } finally {
    if (locks.get(key) === tail) locks.delete(key);
  }
}

// The DSH adapter joins the messages of one turn with MESSAGE_JOIN_DELIMITER
// (memorax-code-dsh-adapter/src/session-bridge.mjs) and the prefix match
// below depends on that exact delimiter. The cross-package contract test
// (test/memory/dsh-adapter-contract.test.mjs) fails when either side drifts.
export const PROMPT_DELIMITER = "\n\n";

function dshPromptMatches(startedPrompt: string, userText: string): boolean {
  if (userText === startedPrompt) return true;
  if (!startedPrompt) return false;
  return userText.startsWith(startedPrompt + PROMPT_DELIMITER);
}

// Hash-based mirror of dshPromptMatches for the trace-recovery path: the
// current-turn record stores only sha256(prompt) and prompt.length, never the
// prompt itself. The writeback userText is accepted when it is exactly the
// started prompt, or the started prompt followed by the join delimiter and
// further messages — the same shape the in-memory coordinator accepts.
function attestedPromptMatches(attestation: TracePromptAttestation, userText: string): boolean {
  if (userText.length === attestation.chars) {
    return sha256Hex(userText) === attestation.sha256;
  }
  if (userText.length < attestation.chars + PROMPT_DELIMITER.length) return false;
  if (userText.slice(attestation.chars, attestation.chars + PROMPT_DELIMITER.length) !== PROMPT_DELIMITER) {
    return false;
  }
  return sha256Hex(userText.slice(0, attestation.chars)) === attestation.sha256;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function claimAutomaticRetrievalTurn(
  turns: Set<string>,
  limit: number,
  sessionId: string,
  turnId: string,
): boolean {
  const key = JSON.stringify([sessionId, turnId]);
  if (turns.has(key)) return false;
  turns.add(key);
  while (turns.size > limit) {
    const oldest = turns.values().next().value;
    if (typeof oldest !== "string") break;
    turns.delete(oldest);
  }
  return true;
}

function releaseAutomaticRetrievalTurn(
  turns: Set<string>,
  sessionId: string,
  turnId: string,
): void {
  turns.delete(JSON.stringify([sessionId, turnId]));
}

function skipped(reason: DshMemoryHookWritebackSkipReason): DshMemoryHookWritebackResult {
  return { ok: true, scheduled: false, reason };
}

async function recordTraceBestEffort<T>(
  label: string,
  promise: Promise<T>,
  diagnosticLogger?: MemoryDiagnosticLogger,
): Promise<T | undefined> {
  try {
    return await promise;
  } catch (error) {
    diagnosticLogger?.("dsh_trace.write_failed", {
      label,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
