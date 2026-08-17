export const MEMORY_HOOK_COMMAND_VERSION = 1;
export const MEMORY_HOOK_CLIENT = "dsh";

const TURN_SCOPED_EVENT_TYPES = new Set([
  "step/start",
  "step/end",
  "assistant/chunk",
  "assistant/message",
  "tool/call",
  "tool/result",
]);

export function createTurnStartCommand(input) {
  return {
    version: MEMORY_HOOK_COMMAND_VERSION,
    client: MEMORY_HOOK_CLIENT,
    sessionId: requiredString(input?.sessionId, "sessionId"),
    turn: positiveSafeInteger(input?.turn, "turn"),
    startSeq: nonNegativeSafeInteger(input?.startSeq, "startSeq"),
    cwd: requiredString(input?.cwd, "cwd"),
    prompt: requiredString(input?.prompt, "prompt"),
  };
}

export function createWritebackCommand(input) {
  const sessionId = requiredString(input?.sessionId, "sessionId");
  const turn = positiveSafeInteger(input?.turn, "turn");
  const startSeq = nonNegativeSafeInteger(input?.startSeq, "startSeq");
  const endSeq = nonNegativeSafeInteger(input?.endSeq, "endSeq");
  const cwd = requiredString(input?.cwd, "cwd");
  const sessionHeader = sessionHeaderValue(input?.sessionHeader, sessionId, cwd);
  const events = exactTurnWindow(input?.events, { turn, startSeq, endSeq });
  return {
    version: MEMORY_HOOK_COMMAND_VERSION,
    client: MEMORY_HOOK_CLIENT,
    sessionId,
    turn,
    startSeq,
    endSeq,
    cwd,
    sessionHeader: structuredClone(sessionHeader),
    events: structuredClone(events),
  };
}

export function createSkillReminderCommand(input) {
  return {
    version: MEMORY_HOOK_COMMAND_VERSION,
    client: MEMORY_HOOK_CLIENT,
    sessionId: requiredString(input?.sessionId, "sessionId"),
    turn: positiveSafeInteger(input?.turn, "turn"),
    cwd: requiredString(input?.cwd, "cwd"),
    content: requiredString(input?.content, "content"),
    triggers: skillReminderTriggers(input?.triggers),
  };
}

/**
 * Select and verify the exact persisted interval after readFrom(). Later Turns
 * may already be durable, so only the inclusive requested suffix is returned.
 */
export function exactTurnWindow(events, expected) {
  if (!Array.isArray(events)) throw new TypeError("DSH persisted events must be an array");
  const turn = positiveSafeInteger(expected?.turn, "turn");
  const startSeq = nonNegativeSafeInteger(expected?.startSeq, "startSeq");
  const endSeq = nonNegativeSafeInteger(expected?.endSeq, "endSeq");
  if (endSeq < startSeq) throw new Error("DSH turn endSeq precedes startSeq");

  const selected = [];
  for (const event of events) {
    if (!record(event) || !Number.isSafeInteger(event.seq) || event.seq < 0) {
      throw new Error("DSH persisted event has an invalid sequence number");
    }
    if (event.seq > endSeq) break;
    selected.push(event);
  }
  const expectedLength = endSeq - startSeq + 1;
  if (selected.length !== expectedLength) {
    throw new Error("DSH persisted turn interval is incomplete");
  }
  for (let index = 0; index < selected.length; index += 1) {
    if (selected[index].seq !== startSeq + index) {
      throw new Error("DSH persisted turn interval is not contiguous");
    }
  }

  const first = selected[0];
  const last = selected.at(-1);
  if (first.type !== "turn/start" || first.data?.turn !== turn) {
    throw new Error("DSH persisted turn interval has no matching start boundary");
  }
  if (last.type !== "turn/end" || last.data?.turn !== turn) {
    throw new Error("DSH persisted turn interval has no matching end boundary");
  }
  for (let index = 1; index < selected.length - 1; index += 1) {
    const event = selected[index];
    if (event.type === "turn/start" || event.type === "turn/end") {
      throw new Error("DSH persisted turn interval contains a nested turn boundary");
    }
    if (TURN_SCOPED_EVENT_TYPES.has(event.type) && event.data?.turn !== turn) {
      throw new Error("DSH persisted turn event belongs to another turn");
    }
  }
  return selected;
}

function sessionHeaderValue(value, sessionId, cwd) {
  if (!record(value)) throw new TypeError("DSH sessionHeader must be an object");
  if (value.id !== sessionId) throw new Error("DSH sessionHeader id does not match sessionId");
  if (value.cwd !== cwd) throw new Error("DSH sessionHeader cwd does not match cwd");
  return value;
}

function requiredString(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`DSH ${name} must be a non-empty string`);
  }
  return value.trim();
}

function positiveSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`DSH ${name} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`DSH ${name} must be a non-negative safe integer`);
  }
  return value;
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function skillReminderTriggers(value) {
  if (!Array.isArray(value) || value.length === 0
    || value.some((trigger) => trigger !== "cadence" && trigger !== "post_compaction")) {
    throw new TypeError("DSH triggers must be a non-empty array of supported reminder triggers");
  }
  return [...new Set(value)];
}
