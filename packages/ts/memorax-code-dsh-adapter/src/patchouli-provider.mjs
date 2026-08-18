import {
  createSkillReminderCommand,
  createTurnStartCommand,
  createWritebackCommand,
} from "./protocol.mjs";
import { loadDshPersonalContext } from "./personal-context.mjs";

export const PATCHOULI_PROVIDER_ID = "memorax-code";
const AGENT_LOOP_SOURCE = "dsh-patchouli-agent-loop";
const DEFAULT_WRITEBACK_DRAIN_TIMEOUT_MS = 4_000;
const MAX_REMINDER_TRACE_TIMEOUT_MS = 1_000;

/** Register MemoraX as a Patchouli provider backed by the existing local Backend. */
export function mountPatchouliProvider(ctx, patchouli, dependencies) {
  const assertEnabled = dependencies?.assertEnabled;
  const backendClient = dependencies?.backendClient;
  const loadPersonalContext = dependencies?.loadPersonalContext ?? loadDshPersonalContext;
  const scheduleRepoMemoryBuild = dependencies?.scheduleRepoMemoryBuild;
  const intervalTurns = dependencies?.intervalTurns;
  const isReminderDue = dependencies?.isReminderDue;
  const memoryReminderContext = nonEmptyString(dependencies?.memoryReminderContext);
  const personalMemoryReminderContext = nonEmptyString(dependencies?.personalMemoryReminderContext);
  const debug = dependencies?.debug ?? process.env.MEMORAX_CODE_DSH_DEBUG === "1";
  const drainTimeoutMs = positiveInteger(
    dependencies?.drainTimeoutMs,
    DEFAULT_WRITEBACK_DRAIN_TIMEOUT_MS,
  );
  if (typeof backendClient?.recordTurnStart !== "function"
    || typeof backendClient?.writebackTurn !== "function") {
    throw new TypeError("memorax-code Patchouli provider requires a Backend client");
  }
  if (typeof assertEnabled !== "function") {
    throw new TypeError("memorax-code Patchouli provider requires runtime enablement authority");
  }
  if (typeof loadPersonalContext !== "function") {
    throw new TypeError("memorax-code Patchouli provider requires a personal context loader");
  }
  if (!positiveSafeIntegerValue(intervalTurns)) {
    throw new TypeError("memorax-code Patchouli provider requires a positive reminder interval");
  }
  if (typeof isReminderDue !== "function") {
    throw new TypeError("memorax-code Patchouli provider requires a reminder policy");
  }
  if (!memoryReminderContext || !personalMemoryReminderContext) {
    throw new TypeError("memorax-code Patchouli provider requires reminder context");
  }
  if (typeof patchouli?.register !== "function") {
    throw new TypeError("memorax-code Patchouli provider requires ctx.patchouli");
  }

  const retrievalLifetime = new AbortController();
  const writebackLifetime = new AbortController();
  const sessions = new Map();
  const writebackTails = new Map();
  const pendingReminderTraces = new Set();
  const pendingWritebacks = new Set();
  let accepting = true;
  let disposal;

  const unregister = patchouli.register({
    id: PATCHOULI_PROVIDER_ID,
    filter: routesMemoraxCall,
    async retrieve(request, context = {}) {
      if (!accepting) return null;
      const input = retrievalInput(request);
      const signal = context.signal
        ? AbortSignal.any([context.signal, retrievalLifetime.signal])
        : retrievalLifetime.signal;
      const state = sessionState(sessions, input.sessionId);
      await confirmPendingContext({
        backendClient,
        ctx,
        debug,
        events: input.session.events,
        pendingReminderTraces,
        state,
      });
      if (!runtimeEnabled(assertEnabled, ctx, debug)) return null;

      const turn = turnState(state, input);
      let recallContext;
      if (input.step === 1 && !turn.retrievalAttempted) {
        turn.retrievalAttempted = true;
        await reconcileInterruptedTurn({
          backendClient,
          ctx,
          debug,
          input,
          signal,
          state,
          writebackTails,
        });
        if (input.prompt) {
          try {
            const response = await backendClient.recordTurnStart(
              createTurnStartCommand(input),
              { signal },
            );
            signal.throwIfAborted();
            turn.turnStartRecorded = true;
            turn.repoMemoryWorktree = nonEmptyString(response?.repoMemoryWorktree);
            if (turn.repoMemoryWorktree && typeof scheduleRepoMemoryBuild === "function") {
              try {
                scheduleRepoMemoryBuild(turn.repoMemoryWorktree);
              } catch (error) {
                debugFailure(ctx, debug, "Repo Memory scheduling", error);
              }
            }
            recallContext = nonEmptyString(response?.additionalContext);
          } catch (error) {
            debugFailure(ctx, debug, "retrieval", error);
          }
        }
      }
      signal.throwIfAborted();
      if (!accepting || !runtimeEnabled(assertEnabled, ctx, debug)) return null;

      const personalContext = await collectPersonalContext({
        ctx,
        debug,
        input,
        intervalTurns,
        isReminderDue,
        loadPersonalContext,
        memoryReminderContext,
        personalMemoryReminderContext,
        repoMemoryWorktree: turn.repoMemoryWorktree,
        signal,
        state: state.personal,
      });
      if (!accepting || !runtimeEnabled(assertEnabled, ctx, debug)) {
        personalContext?.discard();
        return null;
      }
      const text = [recallContext, personalContext?.context].filter(Boolean).join("\n\n");
      if (!text) {
        personalContext?.commit();
        return null;
      }
      if (personalContext) {
        if (state.pendingContext) {
          personalContext.discard();
          return recallContext ? { text: recallContext } : null;
        }
        state.pendingContext = {
          cwd: input.cwd,
          personalContext,
          text,
          turn: input.turn,
          turnStartRecorded: turn.turnStartRecorded,
        };
      }
      return { text };
    },
    async update(request, context = {}) {
      if (!accepting) return { status: "ignored", reason: "provider-disposed" };
      const input = writebackInput(request);
      const state = sessionState(sessions, input.sessionId);
      await confirmPendingContext({
        backendClient,
        ctx,
        debug,
        events: input.events,
        pendingReminderTraces,
        state,
      });
      discardPendingContext(state, input.turn);
      state.turns.delete(input.turn);
      if (input.outcome !== "completed") {
        return { status: "ignored", reason: "turn-not-completed" };
      }

      const callerSignal = context.signal;
      const pending = enqueueWriteback(writebackTails, input.sessionId, async () => {
        const signal = callerSignal
          ? AbortSignal.any([callerSignal, writebackLifetime.signal])
          : writebackLifetime.signal;
        signal.throwIfAborted();
        return await backendClient.writebackTurn(
          createWritebackCommand(input),
          { signal },
        );
      });
      trackPending(pendingWritebacks, pending);
      return await pending ?? { status: "accepted" };
    },
  });

  return async () => {
    if (disposal) return await disposal;
    disposal = (async () => {
      accepting = false;
      await unregister();
      retrievalLifetime.abort(new Error("memorax-code Patchouli provider disposed"));
      await Promise.all([
        waitForPending(pendingWritebacks, drainTimeoutMs),
        waitForPending(pendingReminderTraces, MAX_REMINDER_TRACE_TIMEOUT_MS),
      ]);
      writebackLifetime.abort(new Error("memorax-code Patchouli provider disposed"));
      for (const state of sessions.values()) discardPendingContext(state);
      sessions.clear();
      writebackTails.clear();
    })();
    return await disposal;
  };
}

function routesMemoraxCall(call) {
  if (call?.meta?.source?.type !== "agent-loop"
    || call.meta.source.id !== AGENT_LOOP_SOURCE) return false;
  const point = call.meta.attributes?.point;
  return (call.operation === "retrieve"
      && point === "agent/pre-step")
    || (call.operation === "update" && point === "session/turn-end");
}

function retrievalInput(request) {
  const meta = callMeta(request, "agent/pre-step");
  const data = requiredRecord(request.data, "data");
  const session = requiredRecord(data.session, "data.session");
  const header = requiredRecord(session.header, "data.session.header");
  const sessionId = requiredString(meta.attributes.sessionId, "meta.attributes.sessionId");
  const turn = positiveSafeInteger(meta.attributes.turn, "meta.attributes.turn");
  const step = positiveSafeInteger(meta.attributes.step, "meta.attributes.step");
  assertEligibleHeader(header, sessionId);
  const events = requiredArray(session.events, "data.session.events");
  const start = events.findLast(event => (
    record(event)
    && event.type === "turn/start"
    && event.data?.turn === turn
  ));
  if (!record(start) || !nonNegativeSafeInteger(start.seq)) {
    throw new Error(`Patchouli retrieval has no matching turn/start for turn ${turn}`);
  }
  const prompt = userPrompt(data.messages);
  const cwd = requiredString(header.cwd, "data.session.header.cwd");
  return {
    sessionId,
    turn,
    step,
    startSeq: start.seq,
    cwd,
    prompt,
    session: { header, events },
  };
}

function writebackInput(request) {
  const meta = callMeta(request, "session/turn-end");
  const data = requiredRecord(request.data, "data");
  const session = requiredRecord(data.session, "data.session");
  const header = requiredRecord(session.header, "data.session.header");
  const sessionId = requiredString(meta.attributes.sessionId, "meta.attributes.sessionId");
  const turn = positiveSafeInteger(meta.attributes.turn, "meta.attributes.turn");
  const outcome = requiredString(meta.attributes.outcome, "meta.attributes.outcome");
  assertEligibleHeader(header, sessionId);
  const events = requiredArray(data.events, "data.events");
  const first = events[0];
  const last = events.at(-1);
  if (!record(first) || !nonNegativeSafeInteger(first.seq)
    || !record(last) || !nonNegativeSafeInteger(last.seq)) {
    throw new Error("Patchouli writeback requires a persisted turn interval");
  }
  if (first.type !== "turn/start" || first.data?.turn !== turn
    || last.type !== "turn/end" || last.data?.turn !== turn) {
    throw new Error(`Patchouli writeback has invalid boundaries for turn ${turn}`);
  }
  if (last.data?.reason?.kind !== outcome) {
    throw new Error("Patchouli writeback outcome does not match the persisted turn");
  }
  return {
    sessionId,
    turn,
    startSeq: first.seq,
    endSeq: last.seq,
    cwd: requiredString(header.cwd, "data.session.header.cwd"),
    sessionHeader: header,
    events,
    outcome,
  };
}

function sessionState(sessions, sessionId) {
  let state = sessions.get(sessionId);
  if (!state) {
    state = {
      sessionId,
      personal: {
        observed: false,
        appliedCompactionGeneration: 0,
      },
      reconciled: new Set(),
      turns: new Map(),
    };
    sessions.set(sessionId, state);
  }
  return state;
}

function turnState(state, input) {
  let turn = state.turns.get(input.turn);
  if (!turn) {
    turn = {
      startSeq: input.startSeq,
      retrievalAttempted: false,
      turnStartRecorded: false,
    };
    state.turns.set(input.turn, turn);
  } else if (turn.startSeq !== input.startSeq) {
    throw new Error(`Patchouli turn ${input.turn} changed its start sequence`);
  }
  return turn;
}

async function reconcileInterruptedTurn(options) {
  const interrupted = interruptedTurnBefore(options.input.session, options.input.startSeq);
  if (!interrupted || options.state.reconciled.has(interrupted.endSeq)) return;
  try {
    await enqueueWriteback(options.writebackTails, options.input.sessionId, async () => {
      options.signal.throwIfAborted();
      await options.backendClient.writebackTurn(createWritebackCommand({
        sessionId: options.input.sessionId,
        turn: interrupted.turn,
        startSeq: interrupted.startSeq,
        endSeq: interrupted.endSeq,
        cwd: options.input.cwd,
        sessionHeader: options.input.session.header,
        events: interrupted.events,
      }), { signal: options.signal });
    });
    options.state.reconciled.add(interrupted.endSeq);
  } catch (error) {
    debugFailure(options.ctx, options.debug, "interrupted Turn recovery", error);
  }
}

function interruptedTurnBefore(session, currentStartSeq) {
  const events = ownedSessionEvents(session)?.filter(event => (
    nonNegativeSafeInteger(event?.seq) && event.seq < currentStartSeq
  ));
  if (!events?.length) return undefined;
  const endIndex = events.findLastIndex(event => (
    event?.type === "turn/start" || event?.type === "turn/end"
  ));
  const end = events[endIndex];
  const turn = end?.data?.turn;
  if (end?.type !== "turn/end"
    || end.data?.reason?.kind !== "interrupted"
    || !positiveSafeIntegerValue(turn)) return undefined;
  const startIndex = events.findLastIndex((event, index) => (
    index < endIndex
    && (event?.type === "turn/start" || event?.type === "turn/end")
  ));
  const start = events[startIndex];
  if (start?.type !== "turn/start"
    || start.data?.turn !== turn
    || !nonNegativeSafeInteger(start.seq)
    || !nonNegativeSafeInteger(end.seq)) return undefined;
  const interval = events.slice(startIndex, endIndex + 1);
  for (let index = 1; index < interval.length; index += 1) {
    if (interval[index].seq !== interval[index - 1].seq + 1) return undefined;
  }
  return { turn, startSeq: start.seq, endSeq: end.seq, events: interval };
}

async function collectPersonalContext(options) {
  const state = options.state;
  const projection = reminderProjection(
    options.input.session,
    options.input.turn,
    options.intervalTurns,
    options.memoryReminderContext,
    options.personalMemoryReminderContext,
  );
  const firstObservation = !state.observed;
  const compactionGeneration = projection.compactionGeneration;
  const cadenceDue = options.input.step === 1
    && options.isReminderDue(projection.cadenceTurnCount, options.intervalTurns);
  const postCompactionDue = projection.postCompactionDue;
  const includeProfile = firstObservation
    || state.appliedCompactionGeneration < compactionGeneration;
  const includeProcedure = firstObservation || cadenceDue;
  if (!includeProfile && !includeProcedure) return undefined;
  if (state.lastAttempt?.turn === options.input.turn
    && state.lastAttempt?.compactionGeneration === compactionGeneration) return undefined;
  const attempt = { turn: options.input.turn, compactionGeneration };
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
      options.signal.throwIfAborted();
      loaded = true;
      profileContext = nonEmptyString(result?.profileContext);
      procedureContext = nonEmptyString(result?.procedureContext);
    } catch (error) {
      if (options.signal.aborted && state.lastAttempt === attempt) state.lastAttempt = undefined;
      debugFailure(options.ctx, options.debug, "personal context", error);
      if (!cadenceDue && !postCompactionDue) return undefined;
    }
  }
  const triggers = [
    ...(cadenceDue ? ["cadence"] : []),
    ...(postCompactionDue ? ["post_compaction"] : []),
  ];
  const parts = [];
  if (cadenceDue) parts.push(options.memoryReminderContext);
  if (postCompactionDue || (cadenceDue && firstObservation && profileContext)) {
    parts.push(options.personalMemoryReminderContext);
  }
  if (profileContext) parts.push(profileContext);
  if (procedureContext) parts.push(procedureContext);
  return {
    context: parts.join("\n\n"),
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

async function confirmPendingContext(options) {
  const pending = options.state.pendingContext;
  if (!pending || !acceptedPatchouliContext(options.events, pending.text)) return;
  options.state.pendingContext = undefined;
  pending.personalContext.commit();
  if (pending.turnStartRecorded
    && pending.personalContext.triggers.length > 0
    && typeof options.backendClient.recordSkillReminder === "function") {
    const trace = options.backendClient.recordSkillReminder(createSkillReminderCommand({
      sessionId: options.state.sessionId,
      turn: pending.turn,
      cwd: pending.cwd,
      content: pending.personalContext.context,
      triggers: pending.personalContext.triggers,
    }), { signal: AbortSignal.timeout(MAX_REMINDER_TRACE_TIMEOUT_MS) })
      .catch(error => debugFailure(options.ctx, options.debug, "reminder trace", error));
    trackPending(options.pendingReminderTraces, trace);
  }
}

function discardPendingContext(state, turn) {
  const pending = state.pendingContext;
  if (!pending || (turn !== undefined && pending.turn !== turn)) return;
  state.pendingContext = undefined;
  pending.personalContext.discard();
}

function acceptedPatchouliContext(events, expectedText) {
  return events.some(event => acceptedReminderText(event) === expectedText);
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
    return { cadenceTurnCount: turn, compactionGeneration: 0, postCompactionDue: false };
  }
  let turnsSinceReminder;
  let compactionGeneration = 0;
  let postCompactionDue = false;
  for (const event of events) {
    if (event?.type === "turn/start" && turnsSinceReminder !== undefined) turnsSinceReminder += 1;
    if (event?.type === "compaction/end"
      && record(event.data)
      && event.data.error === undefined) {
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

function acceptedReminderText(event) {
  if (event?.type !== "user/message"
    || event.data?.source?.kind !== "plugin"
    || event.data.source.plugin !== AGENT_LOOP_SOURCE) return undefined;
  const text = textContent(event.data.content);
  if (!text) return undefined;
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (payload?.kind !== "patchouli-memory-results" || !Array.isArray(payload.results)) {
    return undefined;
  }
  const result = payload.results.find(candidate => (
    candidate?.pluginId === PATCHOULI_PROVIDER_ID
    && record(candidate.data)
  ));
  return nonEmptyString(result?.data?.text);
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

function callMeta(request, point) {
  const meta = requiredRecord(request?.meta, "meta");
  const source = requiredRecord(meta.source, "meta.source");
  const attributes = requiredRecord(meta.attributes, "meta.attributes");
  if (source.type !== "agent-loop" || source.id !== AGENT_LOOP_SOURCE) {
    throw new Error("Patchouli call does not come from the official agent-loop connector");
  }
  if (attributes.point !== point) throw new Error(`Patchouli call point must be ${point}`);
  return { ...meta, attributes };
}

function assertEligibleHeader(header, sessionId) {
  if (header.id !== sessionId) throw new Error("Patchouli session identity does not match metadata");
  if (header.origin !== undefined
    || (header.delegationDepth !== undefined && header.delegationDepth !== 0)) {
    throw new Error("Patchouli session is delegated and not eligible for MemoraX");
  }
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

function enqueueWriteback(tails, sessionId, operation) {
  const previous = tails.get(sessionId) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  tails.set(sessionId, current);
  return current.finally(() => {
    if (tails.get(sessionId) === current) tails.delete(sessionId);
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

function requiredRecord(value, name) {
  if (!record(value)) throw new TypeError(`Patchouli ${name} must be an object`);
  return value;
}

function requiredArray(value, name) {
  if (!Array.isArray(value)) throw new TypeError(`Patchouli ${name} must be an array`);
  return value;
}

function requiredString(value, name) {
  const result = nonEmptyString(value);
  if (result === undefined) throw new TypeError(`Patchouli ${name} must be a non-empty string`);
  return result;
}

function positiveSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`Patchouli ${name} must be a positive safe integer`);
  }
  return value;
}

function positiveSafeIntegerValue(value) {
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

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function debugFailure(ctx, debug, operation, error) {
  if (!debug) return;
  const detail = error instanceof Error ? error.message : String(error);
  ctx.logger?.warn?.(`memorax-code Patchouli ${operation} failed: ${detail}`);
}
