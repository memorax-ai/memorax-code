import { MEMORY_HOOK_COMMAND_VERSION } from "./config.mjs";

// Single source of truth for the HTTP paths this adapter calls. The Backend
// transport (transport/http/memory-hook.ts) routes the same strings, and
// test/memory/dsh-adapter-contract.test.mjs fails when either side drifts.
export const MEMORY_HOOK_PATHS = Object.freeze({
  turnStart: "/memory/turn-start",
  writeback: "/memory/writeback",
  turnDiscard: "/memory/turn-discard",
});

// The adapter joins multiple user (or assistant) messages of one turn with
// this delimiter. The Backend's DSH prompt matching mirrors the exact same
// delimiter (PROMPT_DELIMITER in clients/dsh/memory-hook-runtime.ts); the
// contract test pins the two together because a silent mismatch would make
// every writeback fail prompt_mismatch.
export const MESSAGE_JOIN_DELIMITER = "\n\n";

export function createSessionBridge({ dispatch, debug = () => {} }) {
  const sessions = new Map();
  const pendingContext = new Map();
  const pendingRetrieval = new Map();
  // Incarnation counter is PER SESSION, not global: a brand-new second session
  // must keep plain turnIds (only genuinely re-created sessions get the -gN
  // suffix), so "g>=2 means this session was rebuilt" stays diagnosable.
  const sessionIncarnations = new Map();

  return {
    onSessionCreated(session) {
      const sessionId = stringValue(session?.id);
      if (!sessionId) return;
      const firstLiveSeq = nonNegativeInteger(session?.firstLiveSeq, 0);
      const cwd = stringValue(session?.header?.cwd);
      const previous = sessions.get(sessionId);
      if (
        previous
        && previous.firstLiveSeq === firstLiveSeq
        && previous.cwd === cwd
      ) {
        // Duplicate session/created for the SAME live incarnation (event
        // replay, reconnect, plugin reload). Ignoring it is safe and correct:
        // in-flight dispatches stay guarded by the per-dispatch generation
        // token, replayed turn events are already idempotent, and retiring the
        // state here would wrongly discard a live turn and drop its writeback.
        return;
      }
      let generation = 1;
      if (previous) {
        // Same session id re-created with a DIFFERENT identity payload: the
        // old incarnation is dead. Retire it so its in-flight turn-start
        // response cannot leak into the new incarnation, and best-effort
        // discard its started turn on the Backend instead of leaving orphan
        // metadata.
        previous.disposed = true;
        if (previous.turn !== undefined && previous.turnStarted) {
          dispatchTurnDiscard(previous, previous.turn);
        }
        generation = nonNegativeInteger(sessionIncarnations.get(sessionId), 1) + 1;
      } else if (sessionIncarnations.has(sessionId)) {
        // Re-created after a dispose with a matching payload: still a new
        // incarnation, so its turnIds must not reuse the disposed one's.
        generation = nonNegativeInteger(sessionIncarnations.get(sessionId), 1) + 1;
      }
      // Stale pending retrieval/context belong to the previous incarnation.
      pendingContext.delete(sessionId);
      pendingRetrieval.delete(sessionId);
      sessionIncarnations.set(sessionId, generation);
      // Long-lived DSH processes see one session per task; keep the
      // incarnation table bounded or it grows without limit.
      while (sessionIncarnations.size > 512) {
        const oldest = sessionIncarnations.keys().next().value;
        if (oldest === undefined) break;
        sessionIncarnations.delete(oldest);
      }
      sessions.set(sessionId, {
        sessionId,
        cwd,
        firstLiveSeq,
        turn: undefined,
        userText: undefined,
        assistantText: undefined,
        turnStarted: false,
        dispatchTail: undefined,
        generation: 0,
        sessionGeneration: generation,
        disposed: false,
      });
    },
    onSessionEvent(session, event) {
      const sessionId = stringValue(session?.id);
      const state = sessionId ? sessions.get(sessionId) : undefined;
      if (!state || !isRecord(event)) return;
      switch (event.type) {
        case "turn/start": {
          const nextTurn = nonNegativeInteger(event.data?.turn);
          const previousTurn = state.turn;
          const previousTurnStarted = state.turnStarted;
          if (previousTurn !== undefined && (nextTurn === undefined || nextTurn === previousTurn)) {
            // A start without a turn id, or replaying the CURRENT turn's id,
            // can never identify a NEW turn: it is a duplicate/replayed start
            // (reconnect, event replay). Ignore it. Resetting here would clear
            // the accumulated user text and discard the live turn on the
            // Backend, permanently losing that turn's writeback.
            break;
          }
          // Any turn-start response still in flight belongs to a turn that is
          // no longer current; bump the generation so it cannot resolve into
          // pendingContext for whatever turn comes next.
          state.generation += 1;
          // Out-of-order events: the first user/message arrived BEFORE this
          // turn/start, accumulated text, and could not dispatch (no turn id
          // yet). Keep that text instead of dropping the turn's first prompt.
          const carryUndispatchedText = previousTurn === undefined
            && previousTurnStarted
            && state.userText !== undefined;
          state.turn = nextTurn;
          if (!carryUndispatchedText) {
            state.userText = undefined;
            state.assistantText = undefined;
            state.turnStarted = false;
          }
          pendingContext.delete(state.sessionId);
          pendingRetrieval.delete(state.sessionId);
          if (previousTurn !== undefined && previousTurnStarted) {
            dispatchTurnDiscard(state, previousTurn);
          }
          if (carryUndispatchedText) {
            state.turnStarted = false;
            dispatchTurnStart(state);
          }
          break;
        }
        case "user/message":
          handleUserMessage(state, event.data);
          break;
        case "assistant/message":
          handleAssistantMessage(state, event.data);
          break;
        case "turn/end": {
          const eventTurn = nonNegativeInteger(event.data?.turn, undefined);
          if (eventTurn === undefined) {
            if (state.turn !== undefined) break;
          } else if (eventTurn !== state.turn) {
            break;
          }
          handleTurnEnd(state, event.data);
          break;
        }
        default:
          break;
      }
    },
    onSessionDisposed(session) {
      const sessionId = stringValue(session?.id);
      if (!sessionId) return;
      const state = sessions.get(sessionId);
      if (state) {
        state.disposed = true;
        if (state.turn !== undefined && state.turnStarted) {
          dispatchTurnDiscard(state, state.turn);
        }
      }
      // Keep the sessionIncarnations memory: a session re-created after a
      // dispose must get a fresh incarnation suffix even when its identity
      // payload is identical, so its turnIds can never collide with the
      // disposed incarnation's.
      sessions.delete(sessionId);
      pendingContext.delete(sessionId);
      pendingRetrieval.delete(sessionId);
    },
    takePendingContext(sessionId) {
      const key = stringValue(sessionId);
      if (!key) return undefined;
      const context = pendingContext.get(key);
      pendingContext.delete(key);
      return context;
    },
    async waitForPendingContext(sessionId, timeoutMs) {
      const key = stringValue(sessionId);
      if (!key) return undefined;
      const context = pendingContext.get(key);
      if (context !== undefined) {
        pendingContext.delete(key);
        pendingRetrieval.delete(key);
        return context;
      }
      const retrieval = pendingRetrieval.get(key);
      if (!retrieval) return undefined;
      pendingRetrieval.delete(key);
      const additionalContext = await boundedWait(retrieval.promise, timeoutMs);
      if (additionalContext) {
        pendingContext.delete(key);
        return additionalContext;
      }
      return undefined;
    },
    sessionCount() {
      return sessions.size;
    },
  };

  function handleUserMessage(state, data) {
    if (!isDirectUserMessage(data)) return;
    const text = extractMessageText(data);
    if (!text) return;
    state.userText = state.userText
      ? `${state.userText}${MESSAGE_JOIN_DELIMITER}${text}`
      : text;
    if (!state.turnStarted && state.userText) {
      state.turnStarted = true;
      dispatchTurnStart(state);
    }
  }

  function handleAssistantMessage(state, data) {
    if (!isRecord(data) || !isRecord(data.message)) return;
    const text = extractMessageText(data.message);
    if (!text) return;
    state.assistantText = state.assistantText
      ? `${state.assistantText}${MESSAGE_JOIN_DELIMITER}${text}`
      : text;
  }

  function handleTurnEnd(state, data) {
    const userText = state.userText;
    const assistantText = state.assistantText;
    const turn = state.turn;
    const turnStarted = state.turnStarted;
    state.turn = undefined;
    state.userText = undefined;
    state.assistantText = undefined;
    state.turnStarted = false;
    // The turn is over: a turn-start response still in flight for it must not
    // resolve into pendingContext afterwards (it would leak the finished
    // turn's retrieval context into an unrelated later LLM call).
    state.generation += 1;
    if (turn === undefined) return;
    if (turnEndCompleted(data)) {
      if (!userText || !assistantText) {
        if (turnStarted) dispatchTurnDiscard(state, turn);
        return;
      }
      dispatchWriteback(state, turn, userText, assistantText);
    } else if (turnStarted) {
      dispatchTurnDiscard(state, turn);
    }
  }

  function dispatchTurnStart(state) {
    const body = buildTurnStartCommand(state);
    if (!body) return;
    const generation = ++state.generation;
    const deferred = createDeferred();
    pendingRetrieval.set(state.sessionId, deferred);
    void enqueue(state, () => dispatch(MEMORY_HOOK_PATHS.turnStart, body)).then((result) => {
      // Transport failures are always reported, even when the turn already
      // ended: swallowing them behind the generation guard would hide real
      // Backend outages behind ordinary fast-failing turns.
      if (!result?.ok) {
        debug("turn-start dispatch rejected", resultFailureMessage(result));
        deferred.resolve(undefined);
        return;
      }
      if (state.disposed || state.generation !== generation) {
        deferred.resolve(undefined);
        return;
      }
      const bodyError = resultBodyError(result);
      if (bodyError) {
        // HTTP 2xx with a body-level rejection. The current Backend answers
        // turn-start with ok:true (conflicts self-heal server-side), so this
        // branch is contract-drift defense: if a future Backend starts
        // rejecting in the body, the turn must be treated as NOT started
        // instead of silently proceeding to a writeback it would then skip.
        debug("turn-start dispatch rejected", bodyError);
        deferred.resolve(undefined);
        return;
      }
      const additionalContext = stringValue(result?.body?.additionalContext);
      if (additionalContext) pendingContext.set(state.sessionId, additionalContext);
      deferred.resolve(additionalContext);
    }).catch((error) => {
      debug("turn-start dispatch failed", errorMessage(error));
      deferred.resolve(undefined);
    });
  }

  function dispatchWriteback(state, turn, userText, assistantText) {
    const body = buildWritebackCommand(state, turn, userText, assistantText);
    if (!body) return;
    void enqueue(state, () => dispatch(MEMORY_HOOK_PATHS.writeback, body)).then((result) => {
      if (!result?.ok) {
        debug("writeback dispatch rejected", resultFailureMessage(result));
        return;
      }
      // The Backend accepts writeback commands with HTTP 200 and reports
      // skipped scheduling in the body: { ok: true, scheduled: false,
      // reason }. Without reading the body, "accepted" and "silently
      // dropped" (turn_metadata_missing, prompt_mismatch, config_missing)
      // look identical from here, which made every skip invisible.
      const bodyError = resultBodyError(result);
      if (bodyError) {
        debug("writeback dispatch rejected", bodyError);
        return;
      }
      const skip = writebackSkipReason(result);
      if (skip) debug("writeback skipped by backend", skip);
    }).catch((error) => {
      debug("writeback dispatch failed", errorMessage(error));
    });
  }

  function dispatchTurnDiscard(state, turn) {
    const body = buildTurnDiscardCommand(state, turn);
    if (!body) return;
    void enqueue(state, () => dispatch(MEMORY_HOOK_PATHS.turnDiscard, body)).then((result) => {
      if (!result?.ok) {
        debug("turn-discard dispatch rejected", resultFailureMessage(result));
        return;
      }
      const bodyError = resultBodyError(result);
      if (bodyError) {
        debug("turn-discard dispatch rejected", bodyError);
        return;
      }
      // discarded:false means the Backend found no live metadata for the
      // turn (already discarded, evicted, or restarted). Usually benign —
      // discard is best-effort — but still worth a debug line.
      if (result?.body?.discarded === false) {
        debug("turn-discard found no live turn metadata", body.turnId);
      }
    }).catch((error) => {
      debug("turn-discard dispatch failed", errorMessage(error));
    });
  }

  function enqueue(state, operation) {
    const previous = state.dispatchTail
      ? state.dispatchTail.catch(() => undefined)
      : Promise.resolve();
    const current = previous.then(operation);
    state.dispatchTail = current;
    return current;
  }
}

export function buildTurnId(sessionId, firstLiveSeq, sessionGeneration, turn) {
  const incarnation = nonNegativeInteger(sessionGeneration, 1) >= 2
    ? `-g${nonNegativeInteger(sessionGeneration, 1)}`
    : "";
  return `dsh-${nonNegativeInteger(firstLiveSeq, 0)}${incarnation}-${nonNegativeInteger(turn, 0)}`;
}

export function buildTurnStartCommand(state) {
  const sessionId = stringValue(state?.sessionId);
  const prompt = stringValue(state?.userText);
  if (!sessionId || !prompt || state?.turn === undefined) return undefined;
  return {
    version: MEMORY_HOOK_COMMAND_VERSION,
    client: "dsh",
    sessionId,
    turnId: buildTurnId(sessionId, state.firstLiveSeq, state.sessionGeneration, state.turn),
    prompt,
    ...(stringValue(state?.cwd) ? { cwd: state.cwd } : {}),
  };
}

export function buildWritebackCommand(state, turn, userText, assistantText) {
  const sessionId = stringValue(state?.sessionId);
  const prompt = stringValue(userText);
  const reply = stringValue(assistantText);
  if (!sessionId || !prompt || !reply || turn === undefined) return undefined;
  return {
    version: MEMORY_HOOK_COMMAND_VERSION,
    client: "dsh",
    sessionId,
    turnId: buildTurnId(sessionId, state?.firstLiveSeq, state?.sessionGeneration, turn),
    userText: prompt,
    assistantText: reply,
    ...(stringValue(state?.cwd) ? { cwd: state.cwd } : {}),
  };
}

export function buildTurnDiscardCommand(state, turn) {
  const sessionId = stringValue(state?.sessionId);
  if (!sessionId || turn === undefined) return undefined;
  return {
    version: MEMORY_HOOK_COMMAND_VERSION,
    client: "dsh",
    sessionId,
    turnId: buildTurnId(sessionId, state?.firstLiveSeq, state?.sessionGeneration, turn),
  };
}

export function extractMessageText(message) {
  if (!isRecord(message)) return "";
  const blocks = Array.isArray(message.content) ? message.content : [];
  return blocks
    .map((block) => isRecord(block) && block.type === "text" && typeof block.text === "string" ? block.text : "")
    .filter(Boolean)
    .join("\n")
    .trim();
}

export function isDirectUserMessage(message) {
  return isRecord(message) && isRecord(message.source) && message.source.kind === "user";
}

export function turnEndCompleted(data) {
  const reason = isRecord(data) && isRecord(data.reason) ? data.reason : undefined;
  if (!reason) return true;
  return reason.kind === "completed";
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function createDeferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

function boundedWait(promise, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(undefined), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function nonNegativeInteger(value, fallback) {
  // Number(null), Number("") and Number([]) all coerce to 0, which would
  // alias a malformed turn id / firstLiveSeq to turn 0; only genuine numbers
  // or non-empty numeric strings may coerce.
  if (value === null || value === "" || typeof value === "boolean" || typeof value === "object") {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function resultFailureMessage(result) {
  if (typeof result?.error === "string" && result.error) return result.error;
  if (typeof result?.status === "number") return `status ${result.status}`;
  return "unknown backend failure";
}

function resultBodyError(result) {
  const body = result?.body;
  if (!isRecord(body) || body.ok !== false) return undefined;
  if (typeof body.error === "string" && body.error) return body.error;
  return "unknown backend rejection";
}

function writebackSkipReason(result) {
  const body = result?.body;
  if (!isRecord(body) || body.ok !== true) return undefined;
  if (body.scheduled !== false) return undefined;
  if (typeof body.reason === "string" && body.reason) return body.reason;
  return "unknown reason";
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
