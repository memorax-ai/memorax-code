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

  function handleTurnEnd(state, _data) {
    const userText = state.userText;
    const assistantText = state.assistantText;
    const turn = state.turn;
    state.turn = undefined;
    state.userText = undefined;
    state.assistantText = undefined;
    state.turnStarted = false;
    if (!userText || !assistantText || turn === undefined) return;
    dispatchWriteback(state, turn, userText, assistantText);
  }

  function dispatchTurnStart(state) {
    const body = buildTurnStartCommand(state);
    if (!body) return;
    void dispatch("/memory/turn-start", body).then((result) => {
      const additionalContext = stringValue(result?.body?.additionalContext);
      if (additionalContext) pendingContext.set(state.sessionId, additionalContext);
    }).catch((error) => {
      debug("turn-start dispatch failed", error instanceof Error ? error.message : String(error));
    });
  }

  function dispatchWriteback(state, turn, userText, assistantText) {
    const body = buildWritebackCommand(state, turn, userText, assistantText);
    if (!body) return;
    void dispatch("/memory/writeback", body).catch((error) => {
      debug("writeback dispatch failed", error instanceof Error ? error.message : String(error));
    });
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

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function nonNegativeInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
