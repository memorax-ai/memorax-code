import {
  createSkillReminderCommand,
  createTurnStartCommand,
  createWritebackCommand,
} from "./protocol.mjs";
import { loadDshPersonalContext } from "./personal-context.mjs";

export const PLUGIN_NAME = "memorax-code";
export const CONTEXT_SOURCE_PLUGIN = "memorax-code-dsh";
// DSH gives the whole app five seconds to dispose; leave time for downstream
// persistence and process cleanup after this plugin's accepted writes drain.
const DEFAULT_WRITEBACK_DRAIN_TIMEOUT_MS = 4_000;
const MAX_REMINDER_TRACE_TIMEOUT_MS = 1_000;
const MAX_RESUME_RECONCILIATION_WAIT_MS = 12_000;

/** Register DSH-native retrieval and durable Turn writeback listeners. */
export function registerMemoraxCodePlugin(ctx, dependencies) {
  const assertEnabled = dependencies?.assertEnabled;
  const backendClient = dependencies?.backendClient;
  const createUserMessage = dependencies?.createUserMessage;
  const loadPersonalContext = dependencies?.loadPersonalContext ?? loadDshPersonalContext;
  const scheduleRepoMemoryBuild = dependencies?.scheduleRepoMemoryBuild;
  const intervalTurns = dependencies?.intervalTurns;
  const isReminderDue = dependencies?.isReminderDue;
  const memoryReminderContext = nonEmptyString(dependencies?.memoryReminderContext);
  const personalMemoryReminderContext = nonEmptyString(dependencies?.personalMemoryReminderContext);
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
  if (!memoryReminderContext || !personalMemoryReminderContext) {
    throw new TypeError("memorax-code DSH plugin requires reminder context");
  }
  if (typeof ctx?.sessions?.flush !== "function"
    || typeof ctx?.sessionPersistence?.readFrom !== "function") {
    throw new TypeError("memorax-code DSH plugin requires sessions and sessionPersistence");
  }

  const turns = new WeakMap();
  const personalContexts = new WeakMap();
  const pendingContextMessages = new WeakMap();
  const writebackTails = new WeakMap();
  const retrievalLifetime = new AbortController();
  const resumeReconciliations = new WeakMap();
  const writebackLifetime = new AbortController();
  const pendingReminderTraces = new Set();
  const pendingWritebacks = new Set();
  let accepting = true;

  ctx.on("agent/session-start", ({ agent, source }) => {
    const session = agent?.session;
    if (source !== "resume" || !isMemoryEligibleSession(session) || !accepting) return;
    if (resumeReconciliations.has(session)) return;
    const state = recoveredInterruptedTurn(session);
    if (!state) return;
    const onFailure = (error) => debugFailure(ctx, debug, "interrupted Turn recovery", error);
    const pending = enqueueWriteback({
      ctx,
      backendClient,
      session,
      turn: state.turn,
      state,
      signal: writebackLifetime.signal,
      writebackTails,
    })
      .catch(onFailure);
    resumeReconciliations.set(session, pending);
    trackPending(pendingWritebacks, pending);
  });

  ctx.on("session/event", (session, event) => {
    if (!isMemoryEligibleSession(session) || !accepting) return;
    if (event?.type === "user/message") {
      const pendingContext = takePendingContextMessage(
        pendingContextMessages,
        session,
        event.data,
      );
      if (pendingContext) {
        pendingContext.personalContext.commit();
        if (pendingContext.personalContext.triggers.length > 0) {
          trackPending(pendingReminderTraces, recordSkillReminder({
            backendClient,
            ctx,
            cwd: pendingContext.cwd,
            debug,
            personalContext: pendingContext.personalContext,
            session,
            turn: pendingContext.turn,
            turns,
          }));
        }
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
        turnStartRecorded: false,
        closed: false,
      });
      return;
    }
    if (event?.type !== "turn/end") return;
    const turn = event.data?.turn;
    if (!positiveSafeInteger(turn) || !nonNegativeSafeInteger(event.seq)) return;
    discardPendingContextMessages(pendingContextMessages, session, turn);
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
    discardPendingContextMessages(pendingContextMessages, session);
    turns.delete(session);
    resumeReconciliations.delete(session);
  });

  ctx.on("agent/pre-step", async ({ agent, turn, step, signal }, next) => {
    const decision = await next();
    if (decision?.kind !== "enter" || signal?.aborted || !accepting) return decision;
    if (!isMemoryEligibleSession(agent?.session)) return decision;
    const cwd = sessionCwd(agent.session);
    if (!cwd) return decision;
    if (!runtimeEnabled(assertEnabled, ctx, debug)) return decision;

    const retrievalSignal = signal
      ? AbortSignal.any([signal, retrievalLifetime.signal])
      : retrievalLifetime.signal;
    const recallContext = await collectRecallContext({
      backendClient,
      ctx,
      debug,
      decision,
      scheduleRepoMemoryBuild,
      session: agent.session,
      signal: retrievalSignal,
      step,
      turn,
      turns,
      resumeReconciliations,
      cwd,
    });
    if (signal?.aborted || !accepting || !runtimeEnabled(assertEnabled, ctx, debug)) {
      return decision;
    }
    const personalContext = await collectPersonalContext({
      ctx,
      debug,
      intervalTurns,
      isReminderDue,
      loadPersonalContext,
      memoryReminderContext,
      personalContexts,
      personalMemoryReminderContext,
      repoMemoryWorktree: turns.get(agent.session)?.get(turn)?.repoMemoryWorktree,
      session: agent.session,
      signal: retrievalSignal,
      step,
      turn,
    });
    if (signal?.aborted || !accepting || !runtimeEnabled(assertEnabled, ctx, debug)) {
      personalContext?.discard();
      return decision;
    }
    const context = [
      recallContext,
      personalContext?.context,
    ].filter(Boolean).join("\n\n");
    if (!context) {
      personalContext?.commit();
      return decision;
    }
    const contextMessage = createUserMessage({
      content: [{ type: "text", text: context }],
      source: contextSource((personalContext?.triggers.length ?? 0) > 0),
    });
    const result = {
      kind: "enter",
      messages: [
        ...decision.messages,
        contextMessage,
      ],
    };
    if (personalContext) {
      try {
        stagePendingContextMessage(pendingContextMessages, agent.session, {
          context,
          cwd,
          message: contextMessage,
          personalContext,
          turn,
        });
      } catch (error) {
        personalContext.discard();
        throw error;
      }
    }
    return result;
  });

  if (typeof ctx.effect === "function") {
    ctx.effect(() => async () => {
      accepting = false;
      retrievalLifetime.abort(new Error("memorax-code DSH plugin disposed"));
      await Promise.all([
        waitForPending(pendingWritebacks, drainTimeoutMs),
        waitForPending(pendingReminderTraces, MAX_REMINDER_TRACE_TIMEOUT_MS),
      ]);
      writebackLifetime.abort(new Error("memorax-code DSH plugin disposed"));
    }, "memorax-code.lifecycle");
  }
}

function contextSource(isReminder) {
  return isReminder
    ? {
        kind: "plugin",
        plugin: CONTEXT_SOURCE_PLUGIN,
        form: "notice",
        summary: "MemoraX Code",
      }
    : { kind: "plugin", plugin: CONTEXT_SOURCE_PLUGIN };
}

function stagePendingContextMessage(pendingMessages, session, pending) {
  const { message, ...staged } = pending;
  const messageId = nonEmptyString(message?.id);
  if (!messageId) throw new TypeError("memorax-code DSH context message requires an id");
  if (pendingMessages.has(session)) throw new Error("memorax-code DSH context message already pending");
  pendingMessages.set(session, { ...staged, messageId });
}

function takePendingContextMessage(pendingMessages, session, message) {
  const messageId = nonEmptyString(message?.id);
  if (!messageId
    || message?.source?.kind !== "plugin"
    || message.source.plugin !== CONTEXT_SOURCE_PLUGIN) return undefined;
  const pending = pendingMessages.get(session);
  if (!pending
    || pending.messageId !== messageId
    || textContent(message.content) !== pending.context) return undefined;
  pendingMessages.delete(session);
  return pending;
}

function discardPendingContextMessages(pendingMessages, session, turn) {
  const pending = pendingMessages.get(session);
  if (!pending || (turn !== undefined && pending.turn !== turn)) return;
  pendingMessages.delete(session);
  pending.personalContext.discard();
}

async function collectRecallContext(options) {
  if (options.step !== 1) return undefined;
  const state = options.turns.get(options.session)?.get(options.turn);
  if (!state || state.invalid || state.closed) return undefined;
  if (state.retrievalAttempted) {
    try {
      await waitForAbortable(
        state.retrievalPending,
        options.signal,
        "DSH duplicate Turn retrieval wait aborted",
      );
    } catch {
      // The pre-step boundary handles an aborted caller.
    }
    return undefined;
  }
  state.retrievalAttempted = true;
  const prompt = userPrompt(options.decision.messages);
  if (!prompt) return undefined;

  const pending = (async () => {
    try {
      await waitForResumeReconciliation(
        options.resumeReconciliations.get(options.session),
        options.signal,
      );
      options.signal?.throwIfAborted();
      const command = createTurnStartCommand({
        sessionId: options.session.id,
        turn: options.turn,
        startSeq: state.startSeq,
        cwd: options.cwd,
        prompt,
      });
      const response = await options.backendClient.recordTurnStart(command, { signal: options.signal });
      if (options.signal?.aborted) return undefined;
      state.turnStartRecorded = true;
      state.repoMemoryWorktree = nonEmptyString(response?.repoMemoryWorktree);
      if (state.repoMemoryWorktree && typeof options.scheduleRepoMemoryBuild === "function") {
        try {
          options.scheduleRepoMemoryBuild(state.repoMemoryWorktree);
        } catch (error) {
          debugFailure(options.ctx, options.debug, "Repo Memory scheduling", error);
        }
      }
      return nonEmptyString(response?.additionalContext);
    } catch (error) {
      debugFailure(options.ctx, options.debug, "retrieval", error);
      return undefined;
    }
  })();
  state.retrievalPending = pending;
  try {
    return await pending;
  } finally {
    if (state.retrievalPending === pending) state.retrievalPending = undefined;
  }
}

async function collectPersonalContext(options) {
  const state = personalContextState(options.personalContexts, options.session);
  const projection = reminderProjection(
    options.session,
    options.turn,
    options.intervalTurns,
    options.memoryReminderContext,
    options.personalMemoryReminderContext,
  );
  const firstObservation = !state.observed;
  const compactionGeneration = projection.compactionGeneration;
  const cadenceDue = options.step === 1
    && options.isReminderDue(projection.cadenceTurnCount, options.intervalTurns);
  const postCompactionDue = projection.postCompactionDue;
  const includeProfile = firstObservation
    || state.appliedCompactionGeneration < compactionGeneration;
  const includeProcedure = firstObservation || cadenceDue;
  if (!includeProfile && !includeProcedure) return undefined;
  if (state.lastAttempt?.turn === options.turn
    && state.lastAttempt?.compactionGeneration === compactionGeneration) return undefined;
  const attempt = { turn: options.turn, compactionGeneration };
  state.lastAttempt = attempt;

  let loaded = false;
  let profileContext;
  let procedureContext;
  if (options.repoMemoryWorktree) {
    try {
      const result = await options.loadPersonalContext({
        cwd: options.repoMemoryWorktree,
        includeProfile,
        includeProcedure,
      }, { signal: options.signal });
      options.signal?.throwIfAborted();
      loaded = true;
      profileContext = nonEmptyString(result?.profileContext);
      procedureContext = nonEmptyString(result?.procedureContext);
    } catch (error) {
      if (options.signal?.aborted && state.lastAttempt === attempt) {
        state.lastAttempt = undefined;
      }
      debugFailure(options.ctx, options.debug, "personal context", error);
      if (!cadenceDue && !postCompactionDue) return undefined;
    }
  }
  const triggers = [
    ...(cadenceDue ? ["cadence"] : []),
    ...(postCompactionDue ? ["post_compaction"] : []),
  ];
  const reminderParts = [];
  if (cadenceDue) reminderParts.push(options.memoryReminderContext);
  if (postCompactionDue || (cadenceDue && firstObservation && profileContext)) {
    reminderParts.push(options.personalMemoryReminderContext);
  }
  if (profileContext) reminderParts.push(profileContext);
  if (procedureContext) reminderParts.push(procedureContext);
  return {
    context: reminderParts.join("\n\n"),
    triggers,
    commit() {
      if (loaded) {
        state.observed = true;
        if (includeProfile) state.appliedCompactionGeneration = compactionGeneration;
      }
    },
    discard() {
      if (state.lastAttempt === attempt) state.lastAttempt = undefined;
    },
  };
}

async function recordSkillReminder(options) {
  if (typeof options.backendClient.recordSkillReminder !== "function") return;
  const turnState = options.turns.get(options.session)?.get(options.turn);
  if (!turnState?.turnStartRecorded) return;
  try {
    await options.backendClient.recordSkillReminder(createSkillReminderCommand({
      sessionId: options.session.id,
      turn: options.turn,
      cwd: options.cwd,
      content: options.personalContext.context,
      triggers: options.personalContext.triggers,
    }), { signal: AbortSignal.timeout(MAX_REMINDER_TRACE_TIMEOUT_MS) });
  } catch (error) {
    debugFailure(options.ctx, options.debug, "reminder trace", error);
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

function recoveredInterruptedTurn(session) {
  const owned = ownedSessionEvents(session);
  const firstLiveSeq = session?.firstLiveSeq;
  if (!owned || !nonNegativeSafeInteger(firstLiveSeq)) return undefined;
  const ownedSeedLength = firstLiveSeq - (session.header.seedLength ?? 0);
  if (!nonNegativeSafeInteger(ownedSeedLength) || ownedSeedLength > owned.length) return undefined;
  const events = owned.slice(0, ownedSeedLength);
  const endIndex = events.findLastIndex((event) => (
    event?.type === "turn/start" || event?.type === "turn/end"
  ));
  const end = events[endIndex];
  const turn = end?.data?.turn;
  if (end?.type !== "turn/end"
    || end.data?.reason?.kind !== "interrupted"
    || !positiveSafeInteger(turn)
    || !nonNegativeSafeInteger(end.seq)) return undefined;
  const start = events.slice(0, endIndex).findLast((event) => (
    event?.type === "turn/start" || event?.type === "turn/end"
  ));
  if (start?.type !== "turn/start"
    || start.data?.turn !== turn
    || !nonNegativeSafeInteger(start.seq)
    || start.seq > end.seq) return undefined;
  return { turn, startSeq: start.seq, endSeq: end.seq };
}

async function waitForResumeReconciliation(promise, signal) {
  if (!promise) return;
  const timeout = AbortSignal.timeout(MAX_RESUME_RECONCILIATION_WAIT_MS);
  const boundary = signal ? AbortSignal.any([signal, timeout]) : timeout;
  await waitForAbortable(promise, boundary, "DSH interrupted Turn recovery wait aborted");
}

async function waitForAbortable(promise, signal, message) {
  if (!promise) return;
  if (!signal) {
    await promise;
    return;
  }
  signal.throwIfAborted();
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error(message));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export function isMemoryEligibleSession(session) {
  const header = session?.header;
  return typeof session?.id === "string"
    && header !== null
    && typeof header === "object"
    && header.id === session.id
    && header.origin === undefined
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
      appliedCompactionGeneration: 0,
    };
    personalContexts.set(session, state);
  }
  return state;
}

function reminderProjection(
  session,
  turn,
  intervalTurns,
  memoryReminderContext,
  personalMemoryReminderContext,
) {
  const events = ownedSessionEvents(session);
  if (!events) {
    return {
      cadenceTurnCount: turn,
      compactionGeneration: 0,
      postCompactionDue: false,
    };
  }
  let turnsSinceReminder;
  let compactionGeneration = 0;
  let postCompactionDue = false;
  for (const event of events) {
    if (event?.type === "turn/start" && turnsSinceReminder !== undefined) {
      turnsSinceReminder += 1;
    }
    if (isSuccessfulCompaction(event)) {
      compactionGeneration += 1;
      postCompactionDue = true;
    }
    const reminderText = acceptedReminderText(event);
    if (reminderText?.includes(memoryReminderContext)) turnsSinceReminder = 0;
    if (reminderText?.includes(personalMemoryReminderContext)) postCompactionDue = false;
  }
  const cadenceTurnCount = turnsSinceReminder === undefined
    ? 1
    : turnsSinceReminder === 0
      ? 0
      : Math.min(turnsSinceReminder + 1, intervalTurns + 1);
  return { cadenceTurnCount, compactionGeneration, postCompactionDue };
}

function ownedSessionEvents(session) {
  if (!Array.isArray(session?.events)) return undefined;
  const seedLength = session.header?.seedLength ?? 0;
  if (!nonNegativeSafeInteger(seedLength) || seedLength > session.events.length) return undefined;
  return session.events.slice(seedLength);
}

function isSuccessfulCompaction(event) {
  return event?.type === "compaction/end"
    && event.data !== null
    && typeof event.data === "object"
    && event.data.error === undefined;
}

function acceptedReminderText(event) {
  if (event?.type !== "user/message"
    || event.data?.source?.kind !== "plugin"
    || event.data.source.plugin !== CONTEXT_SOURCE_PLUGIN
    || event.data.source.form !== "notice") return undefined;
  return textContent(event.data.content);
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
