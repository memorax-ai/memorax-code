import {
  createTurnStartCommand,
  createWritebackCommand,
} from "./protocol.mjs";
import { loadDshPersonalContext } from "./personal-context.mjs";

export const PLUGIN_NAME = "memorax-code";
export const CONTEXT_SOURCE_PLUGIN = "memorax-code-dsh";
// DSH gives the whole app five seconds to dispose; leave time for downstream
// persistence and process cleanup after this plugin's accepted writes drain.
const DEFAULT_WRITEBACK_DRAIN_TIMEOUT_MS = 4_000;

/** Register DSH-native retrieval and durable Turn writeback listeners. */
export function registerMemoraxCodePlugin(ctx, dependencies) {
  const assertEnabled = dependencies?.assertEnabled;
  const backendClient = dependencies?.backendClient;
  const createUserMessage = dependencies?.createUserMessage;
  const loadPersonalContext = dependencies?.loadPersonalContext ?? loadDshPersonalContext;
  const scheduleRepoMemoryBuild = dependencies?.scheduleRepoMemoryBuild;
  const intervalTurns = dependencies?.intervalTurns;
  const isReminderDue = dependencies?.isReminderDue;
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
  if (typeof assertEnabled !== "function") {
    throw new TypeError("memorax-code DSH plugin requires runtime enablement authority");
  }
  if (typeof createUserMessage !== "function") {
    throw new TypeError("memorax-code DSH plugin requires createUserMessage");
  }
  if (typeof loadPersonalContext !== "function") {
    throw new TypeError("memorax-code DSH plugin requires a personal context loader");
  }
  if (!positiveSafeInteger(intervalTurns)) {
    throw new TypeError("memorax-code DSH plugin requires a positive reminder interval");
  }
  if (typeof isReminderDue !== "function") {
    throw new TypeError("memorax-code DSH plugin requires a reminder policy");
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
  const personalContexts = new WeakMap();
  const writebackTails = new WeakMap();
  const writebackLifetime = new AbortController();
  const pendingWritebacks = new Set();
  let accepting = true;

  ctx.on("session/event", (session, event) => {
    if (!isMemoryEligibleSession(session) || !accepting) return;
    if (event?.type === "compaction/end") {
      if (event.data && typeof event.data === "object" && event.data.error === undefined) {
        personalContextState(personalContexts, session).compactionGeneration += 1;
      }
      return;
    }
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
    if (!isMemoryEligibleSession(agent?.session)) return decision;
    const cwd = sessionCwd(agent.session);
    if (!cwd) return decision;
    if (!runtimeEnabled(assertEnabled, ctx, debug)) return decision;

    const [recallContext, personalContext] = await Promise.all([
      collectRecallContext({
        backendClient,
        ctx,
        debug,
        decision,
        scheduleRepoMemoryBuild,
        session: agent.session,
        signal,
        step,
        turn,
        turns,
        cwd,
      }),
      collectPersonalContext({
        ctx,
        debug,
        intervalTurns,
        isReminderDue,
        loadPersonalContext,
        personalContexts,
        session: agent.session,
        signal,
        step,
        turn,
        cwd,
      }),
    ]);
    if (signal?.aborted || !accepting || !runtimeEnabled(assertEnabled, ctx, debug)) {
      personalContext?.discard();
      return decision;
    }
    const context = [
      recallContext,
      personalContext?.profileContext,
      personalContext?.procedureContext,
    ].filter(Boolean).join("\n\n");
    if (!context) {
      personalContext?.commit();
      return decision;
    }
    const result = {
      kind: "enter",
      messages: [
        ...decision.messages,
        createUserMessage({
          content: [{ type: "text", text: context }],
          source: { kind: "plugin", plugin: CONTEXT_SOURCE_PLUGIN, form: "context" },
        }),
      ],
    };
    personalContext?.commit();
    return result;
  });

  if (typeof ctx.effect === "function") {
    ctx.effect(() => async () => {
      accepting = false;
      await waitForPending(pendingWritebacks, drainTimeoutMs);
      writebackLifetime.abort(new Error("memorax-code DSH plugin disposed"));
    }, "memorax-code.lifecycle");
  }
}

async function collectRecallContext(options) {
  if (options.step !== 1) return undefined;
  const state = options.turns.get(options.session)?.get(options.turn);
  if (!state || state.invalid || state.closed || state.retrievalAttempted) return undefined;
  state.retrievalAttempted = true;
  const prompt = userPrompt(options.decision.messages);
  if (!prompt) return undefined;

  try {
    const command = createTurnStartCommand({
      sessionId: options.session.id,
      turn: options.turn,
      startSeq: state.startSeq,
      cwd: options.cwd,
      prompt,
    });
    const response = await options.backendClient.recordTurnStart(command, { signal: options.signal });
    if (options.signal?.aborted) return undefined;
    const repoMemoryWorktree = nonEmptyString(response?.repoMemoryWorktree);
    if (repoMemoryWorktree && typeof options.scheduleRepoMemoryBuild === "function") {
      try {
        options.scheduleRepoMemoryBuild(repoMemoryWorktree);
      } catch (error) {
        debugFailure(options.ctx, options.debug, "Repo Memory scheduling", error);
      }
    }
    return nonEmptyString(response?.additionalContext);
  } catch (error) {
    debugFailure(options.ctx, options.debug, "retrieval", error);
    return undefined;
  }
}

async function collectPersonalContext(options) {
  const state = personalContextState(options.personalContexts, options.session);
  const firstObservation = !state.observed;
  const compactionGeneration = state.compactionGeneration;
  const includeProfile = firstObservation
    || state.appliedCompactionGeneration < compactionGeneration;
  const includeProcedure = firstObservation
    || (options.step === 1
      && state.lastProcedureTurn !== options.turn
      && options.isReminderDue(options.turn, options.intervalTurns));
  if (!includeProfile && !includeProcedure) return undefined;
  if (state.lastAttempt?.turn === options.turn
    && state.lastAttempt?.compactionGeneration === compactionGeneration) return undefined;
  const attempt = { turn: options.turn, compactionGeneration };
  state.lastAttempt = attempt;

  try {
    const result = await options.loadPersonalContext({
      cwd: options.cwd,
      includeProfile,
      includeProcedure,
    }, { signal: options.signal });
    options.signal?.throwIfAborted();
    return {
      profileContext: nonEmptyString(result?.profileContext),
      procedureContext: nonEmptyString(result?.procedureContext),
      commit() {
        state.observed = true;
        if (includeProfile) state.appliedCompactionGeneration = compactionGeneration;
        if (includeProcedure) state.lastProcedureTurn = options.turn;
      },
      discard() {
        if (state.lastAttempt === attempt) state.lastAttempt = undefined;
      },
    };
  } catch (error) {
    if (options.signal?.aborted && state.lastAttempt === attempt) {
      state.lastAttempt = undefined;
    }
    debugFailure(options.ctx, options.debug, "personal context", error);
    return undefined;
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

function personalContextState(personalContexts, session) {
  let state = personalContexts.get(session);
  if (!state) {
    state = {
      observed: false,
      compactionGeneration: 0,
      appliedCompactionGeneration: 0,
    };
    personalContexts.set(session, state);
  }
  return state;
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

function runtimeEnabled(assertEnabled, ctx, debug) {
  try {
    assertEnabled();
    return true;
  } catch (error) {
    debugFailure(ctx, debug, "runtime authority", error);
    return false;
  }
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
