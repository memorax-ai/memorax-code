import { MEMORY_HOOK_COMMAND_VERSION } from "./config.mjs";

export function createSessionBridge({ dispatch, debug = () => {} }) {
  const sessions = new Map();
  const pendingContext = new Map();
  const pendingRetrieval = new Map();

  return {
    onSessionCreated(session) {
      const sessionId = stringValue(session?.id);
      if (!sessionId) return;
      sessions.set(sessionId, {
        sessionId,
        cwd: stringValue(session?.header?.cwd),
        firstLiveSeq: nonNegativeInteger(session?.firstLiveSeq, 0),
        turn: undefined,
        userText: undefined,
        assistantText: undefined,
        turnStarted: false,
        dispatchTail: undefined,
        generation: 0,
        disposed: false,
      });
    },
    onSessionEvent(session, event) {
      const sessionId = stringValue(session?.id);
      const state = sessionId ? sessions.get(sessionId) : undefined;
      if (!state || !isRecord(event)) return;
      switch (event.type) {
        case "turn/start": {
          const previousTurn = state.turn;
          const previousTurnStarted = state.turnStarted;
          state.turn = nonNegativeInteger(event.data?.turn);
          state.userText = undefined;
          state.assistantText = undefined;
          state.turnStarted = false;
          pendingContext.delete(state.sessionId);
          pendingRetrieval.delete(state.sessionId);
          if (previousTurn !== undefined && previousTurnStarted) {
            dispatchTurnDiscard(state, previousTurn);
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
    state.userText = state.userText ? `${state.userText}\n\n${text}` : text;
    if (!state.turnStarted && state.userText) {
      state.turnStarted = true;
      dispatchTurnStart(state);
    }
  }

  function handleAssistantMessage(state, data) {
    if (!isRecord(data) || !isRecord(data.message)) return;
    const text = extractMessageText(data.message);
    if (!text) return;
    state.assistantText = state.assistantText ? `${state.assistantText}\n\n${text}` : text;
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
    void enqueue(state, () => dispatch("/memory/turn-start", body)).then((result) => {
      if (state.disposed || state.generation !== generation) {
        deferred.resolve(undefined);
        return;
      }
      if (!result?.ok) {
        debug("turn-start dispatch rejected", resultFailureMessage(result));
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
    void enqueue(state, () => dispatch("/memory/writeback", body)).then((result) => {
      if (!result?.ok) debug("writeback dispatch rejected", resultFailureMessage(result));
    }).catch((error) => {
      debug("writeback dispatch failed", errorMessage(error));
    });
  }

  function dispatchTurnDiscard(state, turn) {
    const body = buildTurnDiscardCommand(state, turn);
    if (!body) return;
    void enqueue(state, () => dispatch("/memory/turn-discard", body)).then((result) => {
      if (!result?.ok) debug("turn-discard dispatch rejected", resultFailureMessage(result));
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

export function buildTurnId(sessionId, firstLiveSeq, turn) {
  return `dsh-${nonNegativeInteger(firstLiveSeq, 0)}-${nonNegativeInteger(turn, 0)}`;
}

export function buildTurnStartCommand(state) {
  const sessionId = stringValue(state?.sessionId);
  const prompt = stringValue(state?.userText);
  if (!sessionId || !prompt || state?.turn === undefined) return undefined;
  return {
    version: MEMORY_HOOK_COMMAND_VERSION,
    client: "dsh",
    sessionId,
    turnId: buildTurnId(sessionId, state.firstLiveSeq, state.turn),
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
    turnId: buildTurnId(sessionId, state?.firstLiveSeq, turn),
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
    turnId: buildTurnId(sessionId, state?.firstLiveSeq, turn),
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
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function resultFailureMessage(result) {
  if (typeof result?.error === "string" && result.error) return result.error;
  if (typeof result?.status === "number") return `status ${result.status}`;
  return "unknown backend failure";
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
