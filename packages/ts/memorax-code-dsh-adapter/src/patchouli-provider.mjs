import {
  createTurnStartCommand,
  createWritebackCommand,
} from "./protocol.mjs";

export const PATCHOULI_PROVIDER_ID = "memorax-code";
const AGENT_LOOP_SOURCE = "dsh-patchouli-agent-loop";
const DEFAULT_WRITEBACK_DRAIN_TIMEOUT_MS = 4_000;

/** Register MemoraX as a Patchouli provider backed by the existing local Backend. */
export function mountPatchouliProvider(ctx, patchouli, dependencies) {
  const backendClient = dependencies?.backendClient;
  const debug = dependencies?.debug ?? process.env.MEMORAX_CODE_DSH_DEBUG === "1";
  const drainTimeoutMs = positiveInteger(
    dependencies?.drainTimeoutMs,
    DEFAULT_WRITEBACK_DRAIN_TIMEOUT_MS,
  );
  if (typeof backendClient?.recordTurnStart !== "function"
    || typeof backendClient?.writebackTurn !== "function") {
    throw new TypeError("memorax-code Patchouli provider requires a Backend client");
  }
  if (typeof patchouli?.register !== "function") {
    throw new TypeError("memorax-code Patchouli provider requires ctx.patchouli");
  }

  const retrievalLifetime = new AbortController();
  const writebackLifetime = new AbortController();
  const retrievalTurns = new Map();
  const writebackTails = new Map();
  const pendingWritebacks = new Set();
  let accepting = true;
  let disposal;

  const unregister = patchouli.register({
    id: PATCHOULI_PROVIDER_ID,
    filter: routesMemoraxCall,
    async retrieve(request, context = {}) {
      if (!accepting) return null;
      const input = retrievalInput(request);
      const previousTurn = retrievalTurns.get(input.sessionId);
      if (previousTurn === input.turn) return null;
      retrievalTurns.set(input.sessionId, input.turn);

      const signal = context.signal
        ? AbortSignal.any([context.signal, retrievalLifetime.signal])
        : retrievalLifetime.signal;
      try {
        const response = await backendClient.recordTurnStart(
          createTurnStartCommand(input),
          { signal },
        );
        signal.throwIfAborted();
        const additionalContext = nonEmptyString(response?.additionalContext);
        return additionalContext === undefined ? null : { text: additionalContext };
      } catch (error) {
        debugFailure(ctx, debug, "retrieval", error);
        return null;
      }
    },
    async update(request, context = {}) {
      if (!accepting) return { status: "ignored", reason: "provider-disposed" };
      const input = writebackInput(request);
      if (retrievalTurns.get(input.sessionId) === input.turn) {
        retrievalTurns.delete(input.sessionId);
      }
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
      await waitForPending(pendingWritebacks, drainTimeoutMs);
      writebackLifetime.abort(new Error("memorax-code Patchouli provider disposed"));
      retrievalTurns.clear();
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
      && point === "agent/pre-step"
      && call.meta.attributes?.step === 1)
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
  if (step !== 1) throw new Error("Patchouli retrieval must be the first step of a turn");
  assertEligibleHeader(header, sessionId);
  const start = requiredArray(session.events, "data.session.events").findLast(event => (
    record(event)
    && event.type === "turn/start"
    && event.data?.turn === turn
  ));
  if (!record(start) || !nonNegativeSafeInteger(start.seq)) {
    throw new Error(`Patchouli retrieval has no matching turn/start for turn ${turn}`);
  }
  const prompt = userPrompt(data.messages);
  const cwd = requiredString(header.cwd, "data.session.header.cwd");
  if (!prompt) throw new Error("Patchouli retrieval has no direct user prompt");
  return { sessionId, turn, startSeq: start.seq, cwd, prompt };
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
