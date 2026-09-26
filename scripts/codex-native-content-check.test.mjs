import assert from "node:assert/strict";
import { test } from "node:test";
import { assertCompleteText, assertNoForeignContent, assertSearchResult, assertSkillReferenceContract,
  assertWritebackMessages, expectedSearchAnswer, redactExpectedFixtureText, selectNativeTurnContent } from "./codex-native-content-check.mjs";

const paragraphs = ["第一段：完整保留 Unicode 🧪 与开头。", "第二段：中间内容不能被遗漏，café。", "第三段：末尾仍必须存在。"];
const content = paragraphs.join("\n\n");
test("coverage permits extra context around and between complete ordered paragraphs", () => {
  assert.equal(assertCompleteText(`Before\n${paragraphs.join("\n\nExtra context\n\n")}\nAfter`, content).additionalContentObserved, true);
  assert.equal(assertCompleteText(content, content).additionalContentObserved, false);
});
test("coverage rejects empty and incorrectly typed payload text", () => {
  for (const actual of ["", "  ", null, 42, {}, [content]]) assert.throws(() => assertCompleteText(actual, content), /NATIVE_CONTENT_EMPTY_OR_INVALID/);
});
test("coverage rejects a missing middle paragraph, truncation, and reordered content", () => {
  for (const actual of [[paragraphs[0], paragraphs[2]].join("\n\n"), content.slice(0, -4), [...paragraphs].reverse().join("\n\n")]) {
    assert.throws(() => assertCompleteText(actual, content), /NATIVE_CONTENT_INCOMPLETE/);
  }
});
test("expected redaction only normalizes the known API canary and fixture path UUIDs", () => {
  const known = "12345678-abcd-1234-abcd-1234567890ab";
  const unknown = "87654321-dcba-4321-dcba-ba0987654321";
  const apiKey = "sk_fixtureCanaryOnlyAbcdefghijklmnop";
  const path = `C:\\Temp\\memorax-${known}\\npm`;
  const native = `${path}\\skills\\SKILL.md\n\nKeep this middle paragraph and ${unknown}.\n\nTest credential: ${apiKey}`;
  const expected = redactExpectedFixtureText(native, { apiKey, paths: [path] });
  assert.equal(expected, `C:\\Temp\\memorax-[REDACTED:OPAQUE_ID]\\npm\\skills\\SKILL.md\n\nKeep this middle paragraph and ${unknown}.\n\nTest credential: [REDACTED:API_KEY]`);
  assert.equal(redactExpectedFixtureText(`prefix${known} ${known}suffix`, { apiKey, paths: [path] }), `prefix${known} ${known}suffix`);
  assertCompleteText(expected, expected);
  for (const actual of [native, expected.replace(unknown, "[REDACTED:OPAQUE_ID]"),
    expected.replace("Keep this middle paragraph and ", ""), expected.replace("\\skills\\SKILL.md", ""), expected.slice(0, -3)]) {
    assert.throws(() => assertCompleteText(actual, expected), /NATIVE_CONTENT_INCOMPLETE/);
  }
});
test("writeback structure rejects missing messages, wrong roles and non-text content", () => {
  const valid = [{ role: "user", content, timestamp: 1 }, { role: "assistant", content: "Answer", timestamp: 2 }];
  assertWritebackMessages(valid);
  for (const messages of [[], [valid[0]], [{ ...valid[0], role: "system" }, valid[1]],
    [valid[0], { ...valid[1], content: { text: "Answer" } }], [valid[0], { ...valid[1], content: "" }]]) {
    assert.throws(() => assertWritebackMessages(messages), /NATIVE_MESSAGE/);
  }
});
test("writeback structure permits additional valid context messages after the required pair", () => {
  const messages = [{ role: "user", content, timestamp: 1 }, { role: "assistant", content: "Answer", timestamp: 2 },
    { role: "user", content: "Additional context", timestamp: 3 }];
  assertWritebackMessages(messages);
  assertCompleteText(messages[0].content, content);
  assert.throws(() => assertWritebackMessages([...messages, { role: "tool", content: "Wrong role", timestamp: 4 }]), /NATIVE_MESSAGE_STRUCTURE_INVALID/);
});

test("foreign source controls inspect every message while allowing same-source additional context", () => {
  const messages = [{ role: "user", content }, { role: "assistant", content: "Answer" },
    { role: "user", content: "Additional local context" }];
  assertNoForeignContent(messages, ["Other workspace question", "Other workspace answer"]);
  for (const mutated of [
    [...messages, { role: "user", content: "Other workspace question" }, { role: "assistant", content: "Other workspace answer" }],
    [{ ...messages[0], content: `${content}\nOther workspace answer\nExtra context` }, ...messages.slice(1)],
  ]) assert.throws(() => assertNoForeignContent(mutated, ["Other workspace question", "Other workspace answer"]), /NATIVE_FOREIGN_CONTENT/);
});

const reference = (operation) => `# MemoraX Code Coding Memory ${operation === "search" ? "Search" : "Add"}\n
In Windows PowerShell, use \`memorax-cli.cmd\`; on macOS and Linux, use \`memorax-cli\`. Never invoke \`memorax-cli.ps1\`.
\`memorax-cli ${operation}\` and \`memorax-cli.cmd ${operation}\` are the documented entrypoints.`;
test("installed Skill references select the documented platform executable and reject broken commands", () => {
  for (const operation of ["search", "add"]) {
    const text = reference(operation);
    assert.equal(assertSkillReferenceContract(text, operation, "linux"), "memorax-cli");
    assert.equal(assertSkillReferenceContract(text, operation, "win32"), "memorax-cli.cmd");
    assert.equal(assertSkillReferenceContract(text.replaceAll("\n", "\r\n"), operation, "win32"), "memorax-cli.cmd");
    assert.throws(() => assertSkillReferenceContract(text.replaceAll("memorax-cli", "memorax-cli-NOT-A-REAL-COMMAND"), operation, "linux"),
      /NATIVE_SKILL_REFERENCE_COMMAND_INVALID/);
    assert.throws(() => assertSkillReferenceContract(text.replace(`memorax-cli ${operation}`, `memorax-cli.ps1 ${operation}`), operation, "win32"),
      /NATIVE_SKILL_REFERENCE_OPERATION_INVALID/);
  }
});

function searchFixture() {
  return { ok: true, action: "memory.search", provider: "memory.memorax", query: "Question",
    answer: expectedSearchAnswer("Fixture memory"),
    items: [{ id: "fixture-memory", memory: "Fixture memory", score: 0.95, metadata: { memory_type: "procedural" } }],
    receipt: { accepted: true, receipt_id: "memorax:native-search" } };
}
test("Search validates answer and item fields separately rather than a marker elsewhere in JSON", () => {
  const expected = { query: "Question", memory: "Fixture memory" };
  assertSearchResult(searchFixture(), expected);
  for (const result of [
    { ...searchFixture(), answer: "" },
    { ...searchFixture(), answer: "Fixture memory" },
    { ...searchFixture(), items: [] },
    { ...searchFixture(), items: [{ ...searchFixture().items[0], memory: "" }] },
    { ...searchFixture(), items: [{ ...searchFixture().items[0], id: undefined }] },
    { ...searchFixture(), items: [{ ...searchFixture().items[0], score: "0.95" }] },
    { ...searchFixture(), items: [{ ...searchFixture().items[0], metadata: {} }] },
    { ...searchFixture(), receipt: { accepted: true, receipt_id: "wrong-receipt" } },
  ]) assert.throws(() => assertSearchResult(result, expected), /NATIVE_SEARCH_/);
});

const stamp = (second) => `2026-09-26T00:00:0${second}.000Z`;
const event = (type, second, fields = {}) => ({ timestamp: stamp(second), type: "event_msg", payload: { type, ...fields } });
const response = (role, text, second, fields = {}) => ({ timestamp: stamp(second), type: "response_item",
  payload: { type: "message", role, ...(role === "assistant" ? { phase: "final_answer" } : {}),
    content: [{ type: role === "user" ? "input_text" : "output_text", text }], ...fields } });
function records() { return [
  { type: "session_meta", payload: { id: "session-a" } },
  event("task_started", 0, { turn_id: "turn-a" }),
  event("user_message", 1, { message: "Original prompt" }),
  response("user", "Original prompt", 2), response("user", content, 3),
  response("assistant", "Complete final answer", 4),
  event("task_complete", 5, { turn_id: "turn-a", last_agent_message: "Complete final answer" }),
]; }
const identity = { sessionId: "session-a", turnId: "turn-a" };
test("current contract selects the last user response item and its own timestamp", () => {
  const selected = selectNativeTurnContent(records(), identity);
  assert.equal(selected.user.content, content);
  assert.equal(selected.user.timestamp, Date.parse(stamp(3)));
  assert.deepEqual(selected.assistant.timestamps, [Date.parse(stamp(4)), Date.parse(stamp(5))]);
});
test("current contract falls back to native user and final assistant events", () => {
  const native = records().filter((record) => record.type !== "response_item");
  native.splice(-1, 0, event("agent_message", 4, { phase: "final_answer", message: "Complete final answer" }));
  const selected = selectNativeTurnContent(native, identity);
  assert.equal(selected.user.content, "Original prompt");
  assert.equal(selected.user.source, "user_message");
  assert.equal(selected.assistant.source, "agent_message");
});
test("content selection rejects the wrong session or conflicting message turn", () => {
  assert.throws(() => selectNativeTurnContent(records(), { ...identity, sessionId: "session-b" }), /NATIVE_CONTENT_SESSION_MISMATCH/);
  const conflicting = records();
  conflicting[4].payload.internal_chat_message_metadata_passthrough = { turn_id: "turn-b" };
  assert.throws(() => selectNativeTurnContent(conflicting, identity), /NATIVE_CONTENT_TURN_MISMATCH/);
});
test("content selection does not borrow a later Turn's text or timestamp", () => {
  const native = [...records(), event("task_started", 6, { turn_id: "turn-b" }), response("user", "Foreign prompt", 7), response("assistant", "Foreign answer", 8)];
  assert.equal(selectNativeTurnContent(native, identity).user.content, content);
  assert.throws(() => selectNativeTurnContent(native, { ...identity, turnId: "missing" }), /NATIVE_CONTENT_RECORDS_MISSING/);
});
