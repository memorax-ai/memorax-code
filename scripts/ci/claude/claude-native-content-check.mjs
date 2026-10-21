function check(condition, code) {
  if (!condition) throw Object.assign(new Error(code), { nativeCode: code });
}

export function assertExactText(actual, expected, code = "NATIVE_CONTENT_MISMATCH") {
  check(typeof expected === "string" && expected.length > 0, "NATIVE_EXPECTED_CONTENT_INVALID");
  check(typeof actual === "string" && actual === expected, code);
}

export function assertNativeReadText(actual, expected) {
  check(typeof actual === "string" && typeof expected === "string" && expected.length > 0, "NATIVE_SKILL_REFERENCE_INVALID");
  const lines = actual.split(/\r?\n/).map((line) => line.match(/^ *(\d+)\t(.*)$/)).filter(Boolean);
  const expectedLines = expected.split(/\r?\n/);
  check(lines.length === expectedLines.length && lines.every((line, index) =>
    Number(line[1]) === index + 1 && line[2] === expectedLines[index]), "NATIVE_SKILL_REFERENCE_INCOMPLETE");
}

export function selectNativeMemoraxPlugin(plugins) {
  check(Array.isArray(plugins) && plugins.every((plugin) => plugin && typeof plugin === "object"
    && !Array.isArray(plugin) && typeof plugin.name === "string" && plugin.name.length > 0), "NATIVE_PLUGIN_LIST_INVALID");
  const matches = plugins.filter((plugin) => plugin.name === "memorax-code-claude-adapter");
  check(matches.length === 1, "NATIVE_INSTALLED_PLUGIN_NOT_LOADED");
  check(typeof matches[0].path === "string" && matches[0].path.length > 0, "NATIVE_INSTALLED_PLUGIN_PATH_MISSING");
  return matches[0];
}

// This oracle follows the CLI-observed final UUID, not the product parser or the
// latest transcript entry. It intentionally supports only this fixture's turns.
export function selectNativeTurnContent(records, { sessionId, assistantUuid, prompt, answer }) {
  check(typeof sessionId === "string" && sessionId.length > 0
    && typeof assistantUuid === "string" && assistantUuid.length > 0, "NATIVE_TRANSCRIPT_IDENTITY_MISSING");
  check(Array.isArray(records), "NATIVE_TRANSCRIPT_RECORDS_INVALID");
  const nodes = records.filter((record) => ["user", "assistant", "attachment"].includes(record?.type));
  check(nodes.length > 0 && nodes.every((record) => record.sessionId === sessionId),
    "NATIVE_TRANSCRIPT_SESSION_MISMATCH");
  const byUuid = new Map();
  for (const record of nodes) {
    check(typeof record.uuid === "string" && record.uuid.length > 0 && !byUuid.has(record.uuid),
      "NATIVE_TRANSCRIPT_UUID_INVALID");
    byUuid.set(record.uuid, record);
  }
  const assistant = byUuid.get(assistantUuid);
  check(assistant?.type === "assistant" && assistant.message?.role === "assistant"
    && assistant.message.stop_reason === "end_turn" && assistant.isSidechain !== true,
  "NATIVE_TRANSCRIPT_FINAL_MISSING");
  const lineage = [], visited = new Set();
  let current = assistant, user;
  while (current) {
    check(!visited.has(current.uuid) && current.isSidechain !== true, "NATIVE_TRANSCRIPT_LINEAGE_INVALID");
    visited.add(current.uuid);
    lineage.push(current);
    if (current.type === "user" && current.isMeta !== true && current.message?.role === "user"
      && !(Array.isArray(current.message.content)
        && current.message.content.some((part) => part?.type === "tool_result"))) {
      user = current;
      break;
    }
    check(typeof current.parentUuid === "string" && byUuid.has(current.parentUuid), "NATIVE_TRANSCRIPT_PARENT_MISSING");
    current = byUuid.get(current.parentUuid);
  }
  check(user && user.userType === "external" && typeof user.promptId === "string" && user.promptId.length > 0
    && user.origin?.kind !== "task-notification" && user.promptSource !== "system"
    && !user.interruptedMessageId, "NATIVE_TRANSCRIPT_PROMPT_ID_MISSING");
  const userText = visibleText(user.message.content), assistantText = visibleText(assistant.message.content);
  assertExactText(userText, prompt, "NATIVE_TRANSCRIPT_PROMPT_MISMATCH");
  assertExactText(assistantText, answer, "NATIVE_TRANSCRIPT_ANSWER_MISMATCH");
  return { sessionId, promptId: user.promptId, lineage,
    user: { uuid: user.uuid, content: userText, timestamp: nativeTimestamp(user.timestamp) },
    assistant: { uuid: assistant.uuid, content: assistantText, timestamp: nativeTimestamp(assistant.timestamp) } };
}

function visibleText(content) {
  if (typeof content === "string") return content;
  check(Array.isArray(content), "NATIVE_TRANSCRIPT_CONTENT_INVALID");
  return content.filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text).join("\n\n");
}

function nativeTimestamp(value) {
  const timestamp = typeof value === "string" && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value)
    : Number.isSafeInteger(value) ? value : NaN;
  check(Number.isSafeInteger(timestamp) && timestamp >= 0, "NATIVE_TRANSCRIPT_TIMESTAMP_INVALID");
  return timestamp;
}
