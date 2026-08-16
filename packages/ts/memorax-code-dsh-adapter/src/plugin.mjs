import {
  createTurnStartCommand,
  createWritebackCommand,
} from "./protocol.mjs";

export const PLUGIN_NAME = "memorax-code";
export const RECALL_SOURCE_PLUGIN = "memorax-code-dsh";
// DSH gives the whole app five seconds to dispose; leave time for downstream
// persistence and process cleanup after this plugin's accepted writes drain.
const DEFAULT_WRITEBACK_DRAIN_TIMEOUT_MS = 4_000;

/** Register DSH-native retrieval and durable Turn writeback listeners. */
export function registerMemoraxCodePlugin(ctx, dependencies) {
  const backendClient = dependencies?.backendClient;
  const createUserMessage = dependencies?.createUserMessage;
  const defer = dependencies?.defer ?? queueMicrotask;
  const debug = dependencies?.debug ?? process.env.MEMORAX_CODE_DSH_DEBUG === "1";
  const drainTimeoutMs = positiveInteger(
    dependencies?.drainTimeoutMs,
    DEFAULT_WRITEBACK_DRAIN_TIMEOUT_MS,
  );
  if (typeof backendClient?.recordTurnStart !== "function"
    || typeof backendClient?.writebackTurn !== "function") {
    throw new TypeError("memorax-code DSH plugin requires a Backend client");
  }
  if (typeof createUserMessage !== "function") {
    throw new TypeError("memorax-code DSH plugin requires createUserMessage");
  }
  if (typeof ctx?.sessions?.flush !== "function"
    || typeof ctx?.sessionPersistence?.readFrom !== "function") {
    throw new TypeError("memorax-code DSH plugin requires sessions and sessionPersistence");
  }

  if (typeof backendClient.ensureReady === "function") {
    void Promise.resolve(backendClient.ensureReady())
      .catch((error) => debugFailure(ctx, debug, "Backend recovery", error));
  }

  const turns = new WeakMap();
  const writebackTails = new WeakMap();
  const writebackLifetime = new AbortController();
  const pendingWritebacks = new Set();
  let accepting = true;

  ctx.on("session/event", (session, event) => {
    if (!isMemoryEligibleSession(session) || !accepting) return;
    if (event?.type === "turn/start") {
      const turn = event.data?.turn;
      if (!positiveSafeInteger(turn) || !nonNegativeSafeInteger(event.seq)) return;
      const sessionTurns = turnMap(turns, session);
      if (sessionTurns.has(turn)) {
        sessionTurns.set(turn, { invalid: true });
        return;
      }
      sessionTurns.set(turn, {
        startSeq: event.seq,
        retrievalAttempted: false,
        closed: false,
      });
      return;
    }
    if (event?.type !== "turn/end") return;
    const turn = event.data?.turn;
    if (!positiveSafeInteger(turn) || !nonNegativeSafeInteger(event.seq)) return;
    const state = turns.get(session)?.get(turn);
    if (!state || state.invalid || state.closed || event.seq < state.startSeq) return;
    state.closed = true;
    state.endSeq = event.seq;
    // Wait one microtask so every session/event listener, including the
    // persistence coordinator, has admitted turn/end before the flush barrier.
    const onFailure = (error) => debugFailure(ctx, debug, "writeback", error);
    const pending = deferPromise(defer, () => enqueueWriteback({
      ctx,
      backendClient,
      session,
      turn,
      state,
      signal: writebackLifetime.signal,
      writebackTails,
    }), onFailure)
      .catch(onFailure)
      .finally(() => turns.get(session)?.delete(turn));
    trackPending(pendingWritebacks, pending);
  });

  ctx.on("session/disposed", (session) => {
    turns.delete(session);
  });

  ctx.on("agent/pre-step", async ({ agent, turn, step, signal }, next) => {
    const decision = await next();
    if (decision?.kind !== "enter" || signal?.aborted || !accepting) return decision;
    if (step !== 1 || !isMemoryEligibleSession(agent?.session)) return decision;
    const state = turns.get(agent.session)?.get(turn);
    if (!state || state.invalid || state.closed || state.retrievalAttempted) return decision;
    state.retrievalAttempted = true;
    const prompt = userPrompt(decision.messages);
    const cwd = sessionCwd(agent.session);
    if (!prompt || !cwd) return decision;

    try {
      const command = createTurnStartCommand({
        sessionId: agent.session.id,
        turn,
        startSeq: state.startSeq,
        cwd,
        prompt,
      });
      const response = await backendClient.recordTurnStart(command, { signal });
      if (signal?.aborted || !accepting) return decision;
      const additionalContext = nonEmptyString(response?.additionalContext);
      if (!additionalContext) return decision;
      return {
        kind: "enter",
        messages: [
          ...decision.messages,
          createUserMessage({
            content: [{ type: "text", text: additionalContext }],
            source: { kind: "plugin", plugin: RECALL_SOURCE_PLUGIN, form: "recall" },
          }),
        ],
      };
    } catch (error) {
      debugFailure(ctx, debug, "retrieval", error);
      return decision;
    }
  });

  if (typeof ctx.effect === "function") {
    ctx.effect(() => async () => {
      accepting = false;
      await waitForPending(pendingWritebacks, drainTimeoutMs);
      writebackLifetime.abort(new Error("memorax-code DSH plugin disposed"));
    }, "memorax-code.lifecycle");
  }
}

function enqueueWriteback(options) {
  const previous = options.writebackTails.get(options.session) ?? Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(() => captureWriteback(
      options.ctx,
      options.backendClient,
      options.session,
      options.turn,
      options.state,
      options.signal,
    ));
  options.writebackTails.set(options.session, current);
  return current.finally(() => {
    if (options.writebackTails.get(options.session) === current) {
      options.writebackTails.delete(options.session);
    }
  });
}

async function captureWriteback(ctx, backendClient, session, turn, state, signal) {
  signal.throwIfAborted();
  const participated = await ctx.sessions.flush(session);
  if (!participated) throw new Error("DSH session flush had no persistence listener");
  signal.throwIfAborted();
  const persisted = await ctx.sessionPersistence.readFrom(session.id, state.startSeq, signal);
  signal.throwIfAborted();
  const cwd = sessionCwd(session);
  if (!cwd) throw new Error("DSH session has no authoritative cwd");
  const command = createWritebackCommand({
    sessionId: session.id,
    turn,
    startSeq: state.startSeq,
    endSeq: state.endSeq,
    cwd,
    sessionHeader: persisted?.meta,
    events: persisted?.events,
  });
  await backendClient.writebackTurn(command, { signal });
}

export function isMemoryEligibleSession(session) {
  const header = session?.header;
  return typeof session?.id === "string"
    && header !== null
    && typeof header === "object"
    && header.id === session.id
    && header.origin !== "subagent"
    && (header.delegationDepth === undefined || header.delegationDepth === 0);
}

function userPrompt(messages) {
  if (!Array.isArray(messages)) return undefined;
  const parts = [];
  for (const message of messages) {
    if (message?.role !== "user" || message.source?.kind !== "user") continue;
    const text = textContent(message.content);
    if (text) parts.push(text);
  }
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

function textContent(content) {
  if (!Array.isArray(content)) return undefined;
  const parts = content.flatMap((block) => (
    block?.type === "text" && typeof block.text === "string" && block.text.trim()
      ? [block.text.trim()]
      : []
  ));
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function sessionCwd(session) {
  return nonEmptyString(session?.header?.cwd);
}

function turnMap(turns, session) {
  let sessionTurns = turns.get(session);
  if (!sessionTurns) {
    sessionTurns = new Map();
    turns.set(session, sessionTurns);
  }
  return sessionTurns;
}

function positiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function nonNegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function debugFailure(ctx, debug, operation, error) {
  if (!debug) return;
  const detail = error instanceof Error ? error.message : String(error);
  ctx.logger?.warn?.(`memorax-code ${operation} failed: ${detail}`);
}

function deferPromise(defer, operation, onFailure) {
  return new Promise((resolve, reject) => {
    try {
      defer(() => {
        const result = Promise.resolve().then(operation).catch(onFailure);
        resolve(result);
        return result;
      });
    } catch (error) {
      reject(error);
    }
  });
}

function trackPending(pending, promise) {
  pending.add(promise);
  promise.then(
    () => pending.delete(promise),
    () => pending.delete(promise),
  );
}

async function waitForPending(pending, timeoutMs) {
  const accepted = [...pending];
  if (accepted.length === 0) return;
  let timer;
  try {
    await Promise.race([
      Promise.allSettled(accepted),
      new Promise((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
