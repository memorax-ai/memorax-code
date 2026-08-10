export const SESSION_ID = "session-claude-exact";
export const PROMPT_ID = "prompt-claude-exact";
export function userRecord({
  uuid,
  parentUuid = null,
  promptId = PROMPT_ID,
  sessionId = SESSION_ID,
  content,
  isMeta = false,
  origin,
  promptSource,
  interruptedMessageId,
  timestamp,
}) {
  return {
    parentUuid,
    isSidechain: false,
    isMeta,
    promptId,
    ...(origin === undefined ? {} : { origin }),
    ...(promptSource === undefined ? {} : { promptSource }),
    ...(interruptedMessageId === undefined ? {} : { interruptedMessageId }),
    ...(timestamp === undefined ? {} : { timestamp }),
    type: "user",
    userType: "external",
    message: { role: "user", content },
    uuid,
    sessionId,
  };
}

export function assistantRecord({
  uuid,
  parentUuid,
  sessionId = SESSION_ID,
  messageId,
  usage,
  stopReason,
  content,
  isSidechain = false,
  timestamp,
}) {
  return {
    parentUuid,
    isSidechain,
    type: "assistant",
    message: {
      role: "assistant",
      content,
      stop_reason: stopReason,
      ...(messageId === undefined ? {} : { id: messageId }),
      ...(usage === undefined ? {} : { usage }),
    },
    uuid,
    sessionId,
    ...(timestamp === undefined ? {} : { timestamp }),
  };
}

export function claudeUsage({
  inputTokens,
  cacheCreationInputTokens = null,
  cacheReadInputTokens = null,
  outputTokens,
  ephemeral1hInputTokens,
  ephemeral5mInputTokens,
  webSearchRequests,
  webFetchRequests,
}) {
  return {
    input_tokens: inputTokens,
    cache_creation_input_tokens: cacheCreationInputTokens,
    cache_read_input_tokens: cacheReadInputTokens,
    output_tokens: outputTokens,
    cache_creation: ephemeral1hInputTokens === undefined || ephemeral5mInputTokens === undefined
      ? null
      : {
        ephemeral_1h_input_tokens: ephemeral1hInputTokens,
        ephemeral_5m_input_tokens: ephemeral5mInputTokens,
      },
    server_tool_use: webSearchRequests === undefined || webFetchRequests === undefined
      ? null
      : {
        web_search_requests: webSearchRequests,
        web_fetch_requests: webFetchRequests,
      },
  };
}

export function jsonLines(records) {
  return records.map((record) => JSON.stringify(record)).join("\n");
}
