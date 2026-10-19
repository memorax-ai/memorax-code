import { isDeepStrictEqual } from "node:util";

// Independent acceptance oracle for native user identity and response-owned
// content. This intentionally does not import the product rollout parser.
function check(condition, code) {
  if (!condition) throw Object.assign(new Error(code), { nativeCode: code });
}

export function redactExpectedFixtureText(text, { apiKey, paths }) {
  // Only normalize known synthetic inputs, never arbitrary missing content.
  const uuid = /(?<![A-Za-z0-9])[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}(?![A-Za-z0-9])/gi;
  const pathIds = new Set(paths.flatMap((path) => path.match(uuid) ?? []).map((id) => id.toLowerCase()));
  return text.replaceAll(apiKey, "[REDACTED:API_KEY]")
    .replace(uuid, (id) => pathIds.has(id.toLowerCase()) ? "[REDACTED:OPAQUE_ID]" : id);
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

export function assertNoForeignContent(messages, forbiddenFragments) {
  check(Array.isArray(messages), "NATIVE_MESSAGES_INVALID");
  for (const message of messages) {
    check(typeof message?.content === "string", "NATIVE_MESSAGE_STRUCTURE_INVALID");
    for (const fragment of forbiddenFragments) {
      check(typeof fragment === "string" && fragment.trim().length > 0, "NATIVE_SOURCE_FIXTURE_INVALID");
      check(!message.content.includes(fragment), "NATIVE_FOREIGN_CONTENT");
    }
  }
}

export function assertSkillReferenceContract(text, operation, platform) {
  check(["search", "add"].includes(operation) && typeof text === "string", "NATIVE_SKILL_REFERENCE_INVALID");
  check(text.split(/\r?\n/, 1)[0] === `# MemoraX Code Coding Memory ${operation === "search" ? "Search" : "Add"}`,
    "NATIVE_SKILL_REFERENCE_IDENTITY_MISMATCH");
  const commands = text.match(/\bmemorax-cli[.\w-]*/g) ?? [];
  check(commands.length > 0 && commands.every((command) => ["memorax-cli", "memorax-cli.cmd", "memorax-cli.ps1"].includes(command)),
    "NATIVE_SKILL_REFERENCE_COMMAND_INVALID");
  const guidance = text.match(/Windows PowerShell, use `([^`]+)`; on macOS and Linux, use `([^`]+)`/);
  check(guidance?.[1] === "memorax-cli.cmd" && guidance[2] === "memorax-cli", "NATIVE_SKILL_REFERENCE_PLATFORM_COMMAND_INVALID");
  check(new RegExp(`\\bmemorax-cli(?:\\.cmd)? ${operation}\\b`).test(text)
    && !new RegExp(`\\bmemorax-cli\\.ps1 ${operation}\\b`).test(text), "NATIVE_SKILL_REFERENCE_OPERATION_INVALID");
  return platform === "win32" ? guidance[1] : guidance[2];
}

export function assertSearchResult(result, { query, memory }) {
  check(result?.ok === true && result.action === "memory.search" && result.provider === "memory.memorax"
    && result.query === query, "NATIVE_SEARCH_RESULT_IDENTITY_MISMATCH");
  check(result.answer === expectedSearchAnswer(memory), "NATIVE_SEARCH_ANSWER_MISMATCH");
  check(Array.isArray(result.items) && result.items.length === 1, "NATIVE_SEARCH_ITEMS_MISMATCH");
  const [item] = result.items;
  check(item?.id === "fixture-memory" && item.memory === memory && item.score === 0.95
    && item.metadata?.memory_type === "procedural", "NATIVE_SEARCH_ITEM_FIELDS_MISMATCH");
  check(result.receipt?.accepted === true && result.receipt.receipt_id === "memorax:native-search", "NATIVE_SEARCH_RECEIPT_MISMATCH");
}

export function expectedSearchAnswer(memory) {
  return `<memories>\n  <facts memory_type="procedural">\n   - ${memory}\n  </facts>\n</memories>`;
}

export function selectNativeTurnContent(records, { sessionId, turnId }) {
  check(Array.isArray(records) && records[0]?.type === "session_meta"
    && records[0].payload?.id === sessionId, "NATIVE_CONTENT_SESSION_MISMATCH");
  check(records.filter((record) => record.type === "session_meta").every((record) => record.payload?.id === sessionId),
    "NATIVE_CONTENT_SESSION_MISMATCH");
  let activeTurn, seen = false, assistantResponse, assistantEvent, completion;
  const users = [], legacyUsers = [], modernUsers = [];
  const nativeTime = (value) => Number.isSafeInteger(value) ? value
    : typeof value === "string" && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;
  const selected = (content, record, source) => ({ content, timestamp: nativeTime(record.timestamp), source });
  for (const [index, record] of records.entries()) {
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
    if (record.type === "event_msg" && payload.type === "item_completed" && payload.item?.type === "UserMessage") {
      if (activeTurn !== turnId && nativeTurn !== turnId) continue;
      check(activeTurn === turnId && nativeTurn === turnId && payload.thread_id === sessionId, "NATIVE_CONTENT_TURN_MISMATCH");
      modernUsers.push({ index, item: payload.item });
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
      // Assistant metadata may retain a provider ID; local boundaries select its turn.
      if (role === "user") {
        const identity = payload.internal_chat_message_metadata_passthrough;
        check(!(identity?.turn_id ?? identity?.turnId) || (identity.turn_id ?? identity.turnId) === turnId,
          "NATIVE_CONTENT_TURN_MISMATCH");
      }
      const value = selected(parts.join("\n"), record, "response_item");
      if (role === "user") users.push({ index, value, blocks: textInputBlocks(payload.content, "input_text") });
      else assistantResponse = value;
    } else if (record.type === "event_msg" && typeof payload.message === "string" && payload.message.trim()) {
      if (payload.type === "user_message") {
        legacyUsers.push({ value: selected(payload.message, record, "user_message"),
          identityMatches: (!nativeTurn || nativeTurn === turnId) && (!payload.thread_id || payload.thread_id === sessionId) });
      }
      if (payload.type === "agent_message" && payload.phase === "final_answer") assistantEvent = selected(payload.message, record, "agent_message");
    }
  }
  const user = selectUserResponse(users, legacyUsers, modernUsers);
  const assistant = assistantResponse ?? assistantEvent;
  check(seen && user && assistant, "NATIVE_CONTENT_RECORDS_MISSING");
  check(Number.isFinite(user.timestamp), "NATIVE_CONTENT_USER_TIMESTAMP_INVALID");
  // Stop may submit before task_complete is persisted; both observed native
  // times are eligible, but neither may come from another Turn or user record.
  const timestamps = [...new Set([assistant.timestamp, completion && nativeTime(completion.timestamp)].filter(Number.isFinite))];
  check(timestamps.length > 0, "NATIVE_CONTENT_ASSISTANT_TIMESTAMP_INVALID");
  return { user, assistant: { ...assistant, timestamps } };
}

function textInputBlocks(content, type) {
  // Native CI uses text-only model fixtures. Preserve block boundaries and
  // whitespace when identifying the submitted input, including literal tags.
  if (!Array.isArray(content) || !content.every((part) => part?.type === type && typeof part.text === "string")) return undefined;
  const blocks = content.map((part) => part.text);
  return blocks.some((text) => text.trim()) ? blocks : undefined;
}

function selectUserResponse(users, legacyUsers, modernUsers) {
  let selected;
  if (modernUsers.length) {
    const observed = new Map();
    let boundary = -1;
    for (const { index, item } of modernUsers) {
      check(typeof item.id === "string" && item.id.trim(), "NATIVE_CONTENT_USER_IDENTITY_MISSING");
      const blocks = textInputBlocks(item.content, "text");
      check(blocks, "NATIVE_CONTENT_USER_INPUT_UNSUPPORTED");
      if (observed.has(item.id)) {
        check(isDeepStrictEqual(observed.get(item.id), item.content), "NATIVE_CONTENT_USER_AMBIGUOUS");
        continue;
      }
      const matches = users.filter((user) => user.index > boundary && user.index < index
        && isDeepStrictEqual(user.blocks, blocks));
      check(matches.length === 1, "NATIVE_CONTENT_USER_ASSOCIATION_INVALID");
      selected = matches[0].value;
      observed.set(item.id, item.content);
      boundary = index;
    }
    return selected;
  }
  if (users.length > 1 && legacyUsers.length) {
    let previous = -1;
    for (const event of legacyUsers) {
      check(event.identityMatches, "NATIVE_CONTENT_TURN_MISMATCH");
      const matches = users.filter((user) => user.value.content === event.value.content);
      check(matches.length === 1 && matches[0].index > previous, "NATIVE_CONTENT_USER_ASSOCIATION_INVALID");
      previous = matches[0].index;
      selected = matches[0].value;
    }
    return selected;
  }
  check(users.length <= 1, "NATIVE_CONTENT_USER_AMBIGUOUS");
  return users[0]?.value ?? legacyUsers.at(-1)?.value;
}
