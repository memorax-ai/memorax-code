import { MEMORY_HOOK_COMMAND_VERSION } from "./config.mjs";

export function createSessionBridge({ dispatch, debug = () => {} }) {
  const sessions = new Map();
  const pendingContext = new Map();

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
      });
    },
    onSessionEvent(session, event) {
      const sessionId = stringValue(session?.id);
      const state = sessionId ? sessions.get(sessionId) : undefined;
      if (!state || !isRecord(event)) return;
      switch (event.type) {
        case "turn/start":
          state.turn = nonNegativeInteger(event.data?.turn);
          state.userText = undefined;
          state.assistantText = undefined;
          state.turnStarted = false;
          break;
        case "user/message":
          handleUserMessage(state, event.data);
          break;
        case "assistant/message":
          handleAssistantMessage(state, event.data);
          break;
        case "turn/end":
          handleTurnEnd(state, event.data);
          break;
        default:
          break;
      }
    },
    onSessionDisposed(session) {
      const sessionId = stringValue(session?.id);
      if (!sessionId) return;
      sessions.delete(sessionId);
      pendingContext.delete(sessionId);
    },
    takePendingContext(sessionId) {
      const key = stringValue(sessionId);
      if (!key) return undefined;
      const context = pendingContext.get(key);
      pendingContext.delete(key);
      return context;
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
      if (!userText || !assistantText) return;
      dispatchWriteback(state, turn, userText, assistantText);
    } else if (turnStarted) {
      dispatchTurnDiscard(state, turn);
    }
  }

  function dispatchTurnStart(state) {
    const body = buildTurnStartCommand(state);
    if (!body) return;
    void enqueue(state, () => dispatch("/memory/turn-start", body)).then((result) => {
      if (!result?.ok) {
        debug("turn-start dispatch rejected", resultFailureMessage(result));
        return;
      }
      const additionalContext = stringValue(result?.body?.additionalContext);
      if (additionalContext) pendingContext.set(state.sessionId, additionalContext);
    }).catch((error) => {
      debug("turn-start dispatch failed", errorMessage(error));
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
