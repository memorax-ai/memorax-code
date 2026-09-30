function check(condition, code) {
  if (!condition) throw Object.assign(new Error(code), { nativeCode: code });
}

function identifier(value) {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

// This fixture oracle follows native parent IDs and CLI-observed content. It
// intentionally does not import the product parser or use Hook/trace content.
export function selectNativeTurnContent(records, { sessionId, prompt, finalText } = {}) {
  check(identifier(sessionId), "NATIVE_TRANSCRIPT_IDENTITY_MISSING");
  check(typeof prompt === "string" && prompt.trim().length > 0
    && typeof finalText === "string" && finalText.trim().length > 0, "NATIVE_EXPECTED_CONTENT_INVALID");
  check(Array.isArray(records) && records.length > 0 && records.every((record) =>
    record && typeof record === "object" && !Array.isArray(record)), "NATIVE_TRANSCRIPT_RECORDS_INVALID");
  const byId = new Map(), children = new Map();
  for (const record of records) {
    check(record.sessionId === undefined || record.sessionId === sessionId, "NATIVE_TRANSCRIPT_SESSION_MISMATCH");
    if (record.id === undefined) {
      check(record.type !== "message" && record.parentId === undefined, "NATIVE_TRANSCRIPT_ID_INVALID");
      continue;
    }
    check(identifier(record.id) && !byId.has(record.id), "NATIVE_TRANSCRIPT_ID_INVALID");
    byId.set(record.id, record);
    if (record.parentId !== undefined && record.parentId !== null) {
      check(identifier(record.parentId), "NATIVE_TRANSCRIPT_PARENT_INVALID");
      const siblings = children.get(record.parentId) ?? [];
      siblings.push(record);
      children.set(record.parentId, siblings);
    }
  }
  const users = records.filter((record) => record.type === "message" && record.role === "user")
    .map((record) => ({ record, content: userText(record.content, prompt) }))
    .filter(({ content }) => content === prompt);
  check(users.length === 1, users.length > 1 ? "NATIVE_TRANSCRIPT_PROMPT_AMBIGUOUS" : "NATIVE_TRANSCRIPT_PROMPT_MISMATCH");
  const { record: user, content: promptText } = users[0];
  check(user.sessionId === sessionId, "NATIVE_TRANSCRIPT_SESSION_MISMATCH");

  const branch = [], pending = [user.id], visited = new Set([user.id]);
  for (let index = 0; index < pending.length; index += 1) {
    for (const child of children.get(pending[index]) ?? []) {
      check(!visited.has(child.id), "NATIVE_TRANSCRIPT_LINEAGE_INVALID");
      visited.add(child.id);
      // A later user starts a different turn, even when its parent is this final.
      if (child.type === "message" && child.role === "user") continue;
      branch.push(child);
      pending.push(child.id);
    }
  }
  const assistants = branch.filter((record) => record.type === "message" && record.role === "assistant");
  check(assistants.length === 1, assistants.length > 1 ? "NATIVE_TRANSCRIPT_FINAL_AMBIGUOUS" : "NATIVE_TRANSCRIPT_FINAL_MISSING");
  const assistant = assistants[0];
  check(assistant.status === "completed", "NATIVE_TRANSCRIPT_FINAL_INCOMPLETE");
  check((children.get(assistant.id) ?? []).every((record) => record.type === "message" && record.role === "user"),
    "NATIVE_TRANSCRIPT_FINAL_INCOMPLETE");
  const answer = visibleText(assistant.content, "output_text");
  check(answer === finalText, "NATIVE_TRANSCRIPT_ANSWER_MISMATCH");
  const lineage = [], ancestors = new Set();
  let current = assistant;
  while (current !== user) {
    check(current && !ancestors.has(current.id), "NATIVE_TRANSCRIPT_LINEAGE_INVALID");
    ancestors.add(current.id);
    lineage.unshift(current);
    check(identifier(current.parentId) && byId.has(current.parentId), "NATIVE_TRANSCRIPT_PARENT_MISSING");
    current = byId.get(current.parentId);
  }
  lineage.unshift(user);
  return {
    sessionId, lineage,
    user: { id: user.id, content: promptText, timestamp: nativeTimestamp(user.timestamp) },
    assistant: { id: assistant.id, content: answer, timestamp: nativeTimestamp(assistant.timestamp) },
  };
}

function userText(content, prompt) {
  check(Array.isArray(content), "NATIVE_TRANSCRIPT_CONTENT_INVALID");
  const originals = content.filter((part) => part?.type === "input_text" && part.providerData
    && typeof part.providerData === "object" && Object.hasOwn(part.providerData, "content"));
  if (originals.length > 0) {
    check(originals.every((part) => typeof part.providerData.content === "string"
      && part.providerData.content.trim().length > 0), "NATIVE_TRANSCRIPT_ORIGINAL_INPUT_INVALID");
    return originals.map((part) => part.providerData.content).join("\n");
  }
  const text = visibleText(content, "input_text");
  if (text === prompt) return text;
  if (!text.includes("<user_query>") && !text.includes("</user_query>")) return text;
  check(text.split("<user_query>").length === 2 && text.split("</user_query>").length === 2,
    "NATIVE_TRANSCRIPT_PROMPT_WRAPPER_INVALID");
  const start = text.indexOf("<user_query>") + "<user_query>".length, end = text.indexOf("</user_query>");
  check(start <= end, "NATIVE_TRANSCRIPT_PROMPT_WRAPPER_INVALID");
  return text.slice(start, end).trim();
}

function visibleText(content, type) {
  check(Array.isArray(content), "NATIVE_TRANSCRIPT_CONTENT_INVALID");
  const parts = content.filter((part) => part?.type === type);
  check(parts.length > 0 && parts.every((part) => typeof part.text === "string"), "NATIVE_TRANSCRIPT_CONTENT_INVALID");
  const text = parts.map((part) => part.text).join("\n");
  check(text.trim().length > 0, "NATIVE_TRANSCRIPT_CONTENT_INVALID");
  return text;
}

function nativeTimestamp(value) {
  if (value === undefined) return undefined;
  const timestamp = typeof value === "string" && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value)
    : Number.isSafeInteger(value) ? value : NaN;
  check(Number.isSafeInteger(timestamp) && timestamp >= 0, "NATIVE_TRANSCRIPT_TIMESTAMP_INVALID");
  return timestamp;
}

export function assertNativeToolCalls(lineage, tools) {
  check(Array.isArray(lineage) && Array.isArray(tools), "NATIVE_TOOL_LINEAGE_INVALID");
  for (const tool of tools) {
    const calls = lineage.filter((record) => record.type === "function_call" && record.callId === tool.id);
    const results = lineage.filter((record) => record.type === "function_call_result" && record.callId === tool.id);
    check(calls.length === 1 && calls[0].name === tool.name, "NATIVE_TRANSCRIPT_TOOL_CALL_MISMATCH");
    let input;
    try { input = JSON.parse(calls[0].arguments); }
    catch { check(false, "NATIVE_TRANSCRIPT_TOOL_ARGUMENTS_INVALID"); }
    check(isDeepStrictEqual(input, tool.input), "NATIVE_TRANSCRIPT_TOOL_ARGUMENTS_MISMATCH");
    check(results.length === 1 && results[0].status === "completed" && !results[0].providerData?.error
      && lineage.indexOf(calls[0]) < lineage.indexOf(results[0]), "NATIVE_TRANSCRIPT_TOOL_NOT_COMPLETED");
  }
  check(lineage.filter((record) => record.type === "function_call").length === tools.length
    && lineage.filter((record) => record.type === "function_call_result").length === tools.length,
  "NATIVE_TRANSCRIPT_UNEXPECTED_TOOL");
}

export function assertNativeReadText(output, expected) {
  check(typeof output === "string" && typeof expected === "string", "NATIVE_READ_CONTENT_INVALID");
  const lines = output.replaceAll("\r\n", "\n").split("\n");
  const numbered = lines.map((line) => /^\s*(\d+)\u2192(.*)$/.exec(line));
  check(numbered.every((match, index) => match && Number(match[1]) === index + 1), "NATIVE_READ_LINES_INVALID");
  const text = numbered.map((match) => match[2]).join("\n");
  check(text.replace(/\n$/, "") === expected.replaceAll("\r\n", "\n").replace(/\n$/, ""),
    "NATIVE_READ_REFERENCE_INCOMPLETE");
}

export function toolResult(body, id) {
  const results = body.messages?.filter((message) => message.role === "tool" && message.tool_call_id === id);
  check(results?.length === 1 && typeof results[0].content === "string", "NATIVE_TOOL_RESULT_MISSING");
  return results[0].content;
}
import { isDeepStrictEqual } from "node:util";
