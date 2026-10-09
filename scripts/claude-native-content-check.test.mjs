import assert from "node:assert/strict";
import { test } from "node:test";
import { assertExactText, assertNativeReadText, selectNativeMemoraxPlugin, selectNativeTurnContent } from "./claude-native-content-check.mjs";

const identity = { sessionId: "session-fixture", assistantUuid: "assistant-final", prompt: "Native prompt.", answer: "Native answer." };
const user = () => ({ type: "user", sessionId: identity.sessionId, uuid: "user-prompt", parentUuid: null,
  promptId: "prompt-fixture", userType: "external", timestamp: "2026-09-29T01:00:00.000Z", message: { role: "user", content: identity.prompt } });
const assistant = () => ({ type: "assistant", sessionId: identity.sessionId, uuid: identity.assistantUuid,
  parentUuid: "user-prompt", timestamp: "2026-09-29T01:00:01.000Z",
  message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: identity.answer }] } });
const fails = (records, code, options = identity) => assert.throws(() => selectNativeTurnContent(records, options),
  (error) => error.nativeCode === code && error.message === code);

test("Claude native Read oracle requires every installed reference line in order", () => {
  const reference = "# Reference\n\nRun the documented command.\n";
  const numbered = "1\t# Reference\n2\t\n3\tRun the documented command.\n4\t";
  assertNativeReadText(`${numbered}\n\n<system-reminder>Native tool footer.</system-reminder>`, reference);
  assertNativeReadText(numbered.replaceAll("\n", "\r\n"), reference.replaceAll("\n", "\r\n"));
  for (const actual of ["# Reference", numbered.replace("2\t", "4\t"), numbered.replace("3\t", "2\t"),
    numbered.replace("Run the documented command.", "Run a different command."), numbered.split("\n").slice(0, 2).join("\n"),
    `${numbered}\n5\tUnexpected content.`]) {
    assert.throws(() => assertNativeReadText(actual, reference), { nativeCode: "NATIVE_SKILL_REFERENCE_INCOMPLETE" });
  }
});

test("Claude native plugin discovery selects only the exact target beside native built-ins", () => {
  const plugin = { name: "memorax-code-claude-adapter", path: "/fixture/installed-plugin" };
  assert.equal(selectNativeMemoraxPlugin([plugin]), plugin);
  const builtin = { name: "agents-md", path: "native-builtin", source: "builtin" };
  assert.equal(selectNativeMemoraxPlugin([builtin, plugin]), plugin);
  assert.equal(selectNativeMemoraxPlugin([plugin, builtin]), plugin);
});

test("Claude native plugin discovery rejects missing, unrelated-only and duplicate targets", () => {
  const plugin = { name: "memorax-code-claude-adapter", path: "/fixture/installed-plugin" };
  for (const plugins of [[], [{ name: "agents-md", path: "native-builtin" }], [plugin, { ...plugin }],
    [{ name: "memorax-code-claude-adapter-unrelated", path: plugin.path }]]) {
    assert.throws(() => selectNativeMemoraxPlugin(plugins), { nativeCode: "NATIVE_INSTALLED_PLUGIN_NOT_LOADED" });
  }
});

test("Claude native plugin discovery rejects malformed lists and missing target paths", () => {
  for (const plugins of [undefined, {}, "plugins", [null], [[]], [3], [{}], [{ name: "" }]]) {
    assert.throws(() => selectNativeMemoraxPlugin(plugins), { nativeCode: "NATIVE_PLUGIN_LIST_INVALID" });
  }
  for (const path of [undefined, null, 3, ""]) {
    assert.throws(() => selectNativeMemoraxPlugin([{ name: "memorax-code-claude-adapter", path }]),
      { nativeCode: "NATIVE_INSTALLED_PLUGIN_PATH_MISSING" });
  }
});

test("Claude native oracle selects the CLI-observed final and exact prompt, not the latest turn", () => {
  const records = [user(), assistant(), { ...user(), uuid: "later-user", promptId: "later-prompt", parentUuid: identity.assistantUuid,
    message: { role: "user", content: "Another native prompt." } },
  { ...assistant(), uuid: "later-final", parentUuid: "later-user", message: { role: "assistant", stop_reason: "end_turn",
    content: [{ type: "text", text: "Another native answer." }] } }];
  const selected = selectNativeTurnContent(records, identity);
  assert.equal(selected.promptId, "prompt-fixture");
  assert.equal(selected.user.content, identity.prompt);
  assert.equal(selected.assistant.content, identity.answer);
  assert.equal(selected.user.timestamp, Date.parse("2026-09-29T01:00:00.000Z"));
  assert.equal(selected.assistant.timestamp, Date.parse("2026-09-29T01:00:01.000Z"));
});

test("Claude native oracle follows tool and meta lineage without selecting their content", () => {
  const tool = { ...assistant(), uuid: "tool-call", message: { role: "assistant", stop_reason: "tool_use",
    content: [{ type: "text", text: "Intermediate commentary." }, { type: "tool_use", id: "tool-1", name: "Bash", input: {} }] } };
  const result = { ...user(), uuid: "tool-result", parentUuid: tool.uuid,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", content: "Tool canary." }] } };
  const meta = { ...user(), uuid: "meta", parentUuid: result.uuid, isMeta: true,
    message: { role: "user", content: "Hook context canary." } };
  const final = { ...assistant(), parentUuid: meta.uuid };
  final.message.content.unshift({ type: "thinking", thinking: "Reasoning canary." });
  const selected = selectNativeTurnContent([user(), tool, result, meta, final], identity);
  assert.equal(selected.user.content, identity.prompt);
  assert.equal(selected.assistant.content, identity.answer);
  assert.equal(selected.lineage.length, 5);
});

test("Claude native oracle preserves complete multi-paragraph Unicode text", () => {
  const prompt = "\u7b2c\u4e00\u6bb5 \ud83e\uddea\n\nMiddle: caf\u00e9 and \u65e5\u672c\u8a9e.\n\nLast paragraph.";
  const answer = "\u786e\u8ba4\u3002\n\nPreserve the middle.\n\nDone.";
  const first = user(), final = assistant();
  first.message.content = [{ type: "text", text: prompt }];
  final.message.content = [{ type: "text", text: answer }];
  assert.equal(selectNativeTurnContent([first, final], { ...identity, prompt, answer }).user.content, prompt);
  fails([first, final], "NATIVE_TRANSCRIPT_PROMPT_MISMATCH", { ...identity, answer });
});

test("Claude native oracle traverses native attachment UUIDs without using attachment content", () => {
  const attachment = { type: "attachment", uuid: "hook-attachment", parentUuid: "user-prompt", sessionId: identity.sessionId,
    attachment: { type: "hook_additional_context", content: "ATTACHMENT_CONTENT_MUST_STAY_LOCAL" } };
  const final = { ...assistant(), parentUuid: attachment.uuid };
  const selected = selectNativeTurnContent([user(), attachment, final], identity);
  assert.equal(selected.user.content, identity.prompt);
  assert.equal(selected.assistant.content, identity.answer);
  assert.equal(selected.lineage.length, 3);
  fails([user(), { ...attachment, sessionId: "foreign" }, final], "NATIVE_TRANSCRIPT_SESSION_MISMATCH");
});

test("Claude native exact content assertion rejects omission, reordering and injected content", () => {
  const expected = "First.\n\nMiddle.\n\nLast.";
  for (const actual of ["First.\n\nLast.", "Last.\n\nMiddle.\n\nFirst.", `${expected}\nInjected.`, ` ${expected}`, null]) {
    assert.throws(() => assertExactText(actual, expected), { nativeCode: "NATIVE_CONTENT_MISMATCH" });
  }
  assertExactText(expected, expected);
});

test("Claude native oracle rejects missing or foreign native session identity", () => {
  fails([user(), assistant()], "NATIVE_TRANSCRIPT_IDENTITY_MISSING", { ...identity, sessionId: "" });
  fails([user(), assistant()], "NATIVE_TRANSCRIPT_IDENTITY_MISSING", { ...identity, assistantUuid: undefined });
  fails([user(), { ...assistant(), sessionId: "foreign" }], "NATIVE_TRANSCRIPT_SESSION_MISMATCH");
});

test("Claude native oracle rejects missing final, unfinished output and sidechains", () => {
  fails([user(), assistant()], "NATIVE_TRANSCRIPT_FINAL_MISSING", { ...identity, assistantUuid: "unknown" });
  const partial = assistant();
  partial.message.stop_reason = null;
  fails([user(), partial], "NATIVE_TRANSCRIPT_FINAL_MISSING");
  fails([user(), { ...assistant(), isSidechain: true }], "NATIVE_TRANSCRIPT_FINAL_MISSING");
});

test("Claude native oracle rejects broken, cyclic or duplicate native lineage", () => {
  fails([user(), { ...assistant(), parentUuid: "absent" }], "NATIVE_TRANSCRIPT_PARENT_MISSING");
  fails([user(), { ...assistant(), parentUuid: identity.assistantUuid }], "NATIVE_TRANSCRIPT_LINEAGE_INVALID");
  fails([user(), assistant(), assistant()], "NATIVE_TRANSCRIPT_UUID_INVALID");
  fails([user(), { ...assistant(), uuid: undefined }], "NATIVE_TRANSCRIPT_UUID_INVALID");
});

test("Claude native oracle requires an interactive native prompt identity", () => {
  for (const patch of [{ promptId: undefined }, { promptId: "" }, { userType: undefined }, { userType: "internal" }, { origin: { kind: "task-notification" } },
    { promptSource: "system" }, { interruptedMessageId: "interrupted" }]) {
    fails([{ ...user(), ...patch }, assistant()], "NATIVE_TRANSCRIPT_PROMPT_ID_MISSING");
  }
  fails([{ ...user(), isSidechain: true }, assistant()], "NATIVE_TRANSCRIPT_LINEAGE_INVALID");
});

test("Claude native oracle stops at the nearest visible prompt even if an older prompt matches", () => {
  const older = { ...user(), uuid: "older-user" };
  const current = { ...user(), parentUuid: older.uuid, promptId: "current-prompt",
    message: { role: "user", content: "A different current prompt." } };
  fails([older, current, assistant()], "NATIVE_TRANSCRIPT_PROMPT_MISMATCH");
});

test("Claude native oracle requires timestamps from both selected native records", () => {
  for (const timestamp of [undefined, "2026-09-29T01:00:00", "not-a-date", -1, NaN]) {
    fails([{ ...user(), timestamp }, assistant()], "NATIVE_TRANSCRIPT_TIMESTAMP_INVALID");
    fails([user(), { ...assistant(), timestamp }], "NATIVE_TRANSCRIPT_TIMESTAMP_INVALID");
  }
  const timestamp = Date.parse("2026-09-29T01:00:00.000Z");
  assert.equal(selectNativeTurnContent([{ ...user(), timestamp }, assistant()], identity).user.timestamp, timestamp);
});

test("Claude native oracle errors never include private native content", () => {
  const records = [user(), assistant()];
  records[1].message.content = [{ type: "text", text: "PRIVATE_FIXTURE_CANARY" }];
  assert.throws(() => selectNativeTurnContent(records, identity), (error) => {
    assert.equal(error.message, "NATIVE_TRANSCRIPT_ANSWER_MISMATCH");
    assert.equal(error.nativeCode, error.message);
    return true;
  });
});
