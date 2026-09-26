// Independent acceptance oracle for the current response-item-first extraction
// contract. This intentionally does not import the product rollout parser.
function check(condition, code) {
  if (!condition) throw Object.assign(new Error(code), { nativeCode: code });
}

export function assertCompleteText(actual, required, code = "NATIVE_CONTENT_INCOMPLETE") {
  check(typeof actual === "string" && actual.trim().length > 0, "NATIVE_CONTENT_EMPTY_OR_INVALID");
  check(typeof required === "string" && required.trim().length > 0, "NATIVE_EXPECTED_CONTENT_EMPTY_OR_INVALID");
  const fragments = required.trim().split(/\r?\n\s*\r?\n/).map((text) => text.trim()).filter(Boolean);
  let offset = 0;
  for (const fragment of fragments) {
    const found = actual.indexOf(fragment, offset);
    check(found >= 0, code);
    offset = found + fragment.length;
  }
  return { requiredFragments: fragments.length, additionalContentObserved: actual.trim() !== required.trim() };
}

export function assertWritebackMessages(messages) {
  check(Array.isArray(messages) && messages.length >= 2, "NATIVE_MESSAGES_INVALID");
  check(messages[0]?.role === "user" && messages[1]?.role === "assistant", "NATIVE_MESSAGE_STRUCTURE_INVALID");
  for (const message of messages) {
    check(["user", "assistant"].includes(message?.role) && typeof message.content === "string" && message.content.trim().length > 0
      && Number.isFinite(message.timestamp), "NATIVE_MESSAGE_STRUCTURE_INVALID");
  }
}

export function selectNativeTurnContent(records, { sessionId, turnId }) {
  check(Array.isArray(records) && records[0]?.type === "session_meta"
    && records[0].payload?.id === sessionId, "NATIVE_CONTENT_SESSION_MISMATCH");
  check(records.filter((record) => record.type === "session_meta").every((record) => record.payload?.id === sessionId),
    "NATIVE_CONTENT_SESSION_MISMATCH");
  let activeTurn, seen = false, userResponse, userEvent, assistantResponse, assistantEvent, completion;
  const nativeTime = (value) => Number.isSafeInteger(value) ? value
    : typeof value === "string" && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;
  const selected = (content, record, source) => ({ content, timestamp: nativeTime(record.timestamp), source });
  for (const record of records) {
    const payload = record.payload ?? {};
    const nativeTurn = payload.turn_id ?? payload.turnId;
    if (record.type === "turn_context" || (record.type === "event_msg" && payload.type === "task_started")) {
      activeTurn = nativeTurn;
      if (activeTurn === turnId) seen = true;
      continue;
    }
    if (record.type === "event_msg" && payload.type === "task_complete") {
      if (nativeTurn === turnId) {
        completion = record;
        const text = payload.last_agent_message ?? payload.lastAgentMessage;
        if (!assistantEvent && typeof text === "string" && text.trim()) assistantEvent = selected(text, record, "task_complete");
      }
      if (nativeTurn === activeTurn) activeTurn = undefined;
      continue;
    }
    if (record.type === "event_msg" && payload.type === "turn_aborted") {
      if (nativeTurn === activeTurn) activeTurn = undefined;
      continue;
    }
    if (activeTurn !== turnId) continue;
    if (record.type === "response_item" && payload.type === "message") {
      const role = payload.role;
      if (role !== "user" && !(role === "assistant" && payload.phase === "final_answer")) continue;
      const type = role === "user" ? "input_text" : "output_text";
      const parts = Array.isArray(payload.content) ? payload.content.filter((part) => part?.type === type
        && typeof part.text === "string" && part.text.trim()).map((part) => part.text) : [];
      if (!parts.length) continue;
      const identity = payload.internal_chat_message_metadata_passthrough;
      check(!(identity?.turn_id ?? identity?.turnId) || (identity.turn_id ?? identity.turnId) === turnId,
        "NATIVE_CONTENT_TURN_MISMATCH");
      const value = selected(parts.join("\n"), record, "response_item");
      if (role === "user") userResponse = value;
      else assistantResponse = value;
    } else if (record.type === "event_msg" && typeof payload.message === "string" && payload.message.trim()) {
      if (payload.type === "user_message") userEvent = selected(payload.message, record, "user_message");
      if (payload.type === "agent_message" && payload.phase === "final_answer") assistantEvent = selected(payload.message, record, "agent_message");
    }
  }
  const user = userResponse ?? userEvent;
  const assistant = assistantResponse ?? assistantEvent;
  check(seen && user && assistant, "NATIVE_CONTENT_RECORDS_MISSING");
  check(Number.isFinite(user.timestamp), "NATIVE_CONTENT_USER_TIMESTAMP_INVALID");
  // Stop may submit before task_complete is persisted; both observed native
  // times are eligible, but neither may come from another Turn or user record.
  const timestamps = [...new Set([assistant.timestamp, completion && nativeTime(completion.timestamp)].filter(Number.isFinite))];
  check(timestamps.length > 0, "NATIVE_CONTENT_ASSISTANT_TIMESTAMP_INVALID");
  return { user, assistant: { ...assistant, timestamps } };
}
