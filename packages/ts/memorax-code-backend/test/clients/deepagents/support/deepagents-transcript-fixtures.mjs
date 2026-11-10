export const SESSION_ID = "session-deepagents-exact";
export const THREAD_ID = "thread-deepagents-real";
export const PROMPT_ID = "prompt-deepagents-exact";

// Mirrors dcode's TranscriptRecord (extra="forbid"):
// schema_version, sequence, record_id, timestamp, thread_id, agent_id, role,
// message_id, content, name.
export function record({
  sequence,
  role,
  content,
  threadId = THREAD_ID,
  recordId = `${role}-${sequence}`,
  messageId = null,
  name = null,
  timestamp = null,
  agentId = null,
}) {
  return {
    schema_version: 1,
    sequence,
    record_id: recordId,
    ...(timestamp === null ? {} : { timestamp }),
    thread_id: threadId,
    agent_id: agentId,
    role,
    message_id: messageId,
    content,
    name,
  };
}

export function jsonLines(records) {
  return `${records.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}
