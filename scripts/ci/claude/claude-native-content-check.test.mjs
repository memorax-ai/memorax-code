import assert from "node:assert/strict";
import { test } from "node:test";
import { assertExactText, assertNativeReadText, assertNativeTurnTrace, selectNativeMemoraxPlugin, selectNativeTurnContent, selectNativeTurnTrace } from "./claude-native-content-check.mjs";

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

function turnTrace({ turnId = `claude-start:${"a".repeat(64)}`, prompt = identity.prompt } = {}) {
  const trace = { client: "claude", session_id: identity.sessionId, native_request_id: "prompt-fixture", turn_id: turnId };
  return [
    { type: "turn_start", trace: { ...trace }, ok: true, request: { prompt } },
    { type: "turn_end", trace: { ...trace }, ok: true, outcome: "completed" },
    ...["search", "add"].map((operation) => ({ type: `memory_cli_${operation}`, trace: { ...trace }, ok: true })),
  ];
}

const traceSelection = (prompt = identity.prompt) => ({ sessionId: identity.sessionId, promptId: "prompt-fixture", user: { content: prompt } });

test("Claude trace correlation preserves the raw fixture prompt and binds each Skill to its occurrence", () => {
  // Local trace strings are captured verbatim; only outbound QA redacts this fixture canary.
  const prompt = "Check sk_nativeFixtureOnlyAbcdefghijklmnop before continuing.";
  const events = turnTrace({ prompt });
  for (const skillType of [undefined, "memory_cli_search", "memory_cli_add"]) {
    assert.equal(assertNativeTurnTrace(events, traceSelection(prompt), { skillType }), events[0].trace.turn_id);
  }
  assert.throws(() => assertNativeTurnTrace(events, traceSelection(prompt.replace(/sk_\w+/, "[REDACTED:API_KEY]"))),
    { nativeCode: "NATIVE_HOOK_PROMPT_CORRELATION_MISSING" });
});

test("Claude trace correlation distinguishes reused prompt IDs without borrowing another occurrence", () => {
  const nextPrompt = "A later prompt with the same native prompt ID.";
  const first = turnTrace(), second = turnTrace({ turnId: `claude-start:${"b".repeat(64)}`, prompt: nextPrompt });
  const unrelated = first.map((event) => ({ ...event, trace: { ...event.trace, client: "codex" } }));
  const foreign = first.map((event) => ({ ...event, trace: { ...event.trace, session_id: "foreign-session" } }));
  const events = [...first, ...unrelated, ...second, ...foreign];
  for (const [prompt, turnId] of [[identity.prompt, first[0].trace.turn_id], [nextPrompt, second[0].trace.turn_id]]) {
    assert.equal(assertNativeTurnTrace(events, traceSelection(prompt), { skillType: "memory_cli_search" }), turnId);
  }
  assert.throws(() => assertNativeTurnTrace([...first, ...turnTrace({ turnId: second[0].trace.turn_id })], traceSelection()),
    { nativeCode: "NATIVE_HOOK_PROMPT_CORRELATION_MISSING" }, "identical prompts with distinct occurrences remain ambiguous");
});

test("Claude trace correlation rejects missing, mismatched and duplicated persisted lifecycle events", () => {
  const cases = [
    ["missing Start", (events) => events.splice(0, 1)],
    ["missing End", (events) => events.splice(1, 1)],
    ["missing native prompt ID", (events) => delete events[0].trace.native_request_id],
    ["foreign native prompt ID", (events) => events[0].trace.native_request_id = "foreign-prompt"],
    ["foreign client", (events) => events[0].trace.client = "codex"],
    ["foreign session", (events) => events[1].trace.session_id = "foreign-session"],
    ["End borrows another occurrence", (events) => events[1].trace.turn_id = `claude-start:${"b".repeat(64)}`],
    ["End has another native prompt ID", (events) => events[1].trace.native_request_id = "foreign-prompt"],
    ["unfinished End", (events) => events[1].outcome = "interrupted"],
    ["duplicate Start", (events) => events.push(structuredClone(events[0]))],
    ["duplicate End", (events) => events.push(structuredClone(events[1]))],
    ["conflicting Start on the same occurrence", (events) => events.push({ ...events[0], request: { prompt: "Another prompt." } })],
  ];
  for (const [label, mutate] of cases) {
    const events = turnTrace();
    mutate(events);
    assert.throws(() => assertNativeTurnTrace(events, traceSelection()),
      { nativeCode: "NATIVE_HOOK_PROMPT_CORRELATION_MISSING" }, label);
  }
  for (const turnId of [undefined, "prompt-fixture", "claude-start:invalid"]) {
    const events = turnTrace();
    events[0].trace.turn_id = turnId;
    assert.throws(() => assertNativeTurnTrace(events, traceSelection()), { nativeCode: "NATIVE_HOOK_OCCURRENCE_ID_INVALID" });
  }
});

for (const skillType of ["memory_cli_search", "memory_cli_add"]) {
  test(`Claude trace correlation rejects missing, duplicate or foreign ${skillType} bindings`, () => {
    for (const [label, mutate] of [
      ["missing Skill event", (events, event) => events.splice(events.indexOf(event), 1)],
      ["duplicate Skill event", (events, event) => events.push(structuredClone(event))],
      ["missing native prompt ID", (events, event) => delete event.trace.native_request_id],
      ["foreign prompt", (events, event) => event.trace.native_request_id = "foreign-prompt"],
      ["foreign occurrence", (events, event) => event.trace.turn_id = `claude-start:${"b".repeat(64)}`],
      ["foreign client", (events, event) => event.trace.client = "codex"],
      ["foreign session", (events, event) => event.trace.session_id = "foreign-session"],
      ["failed Skill", (events, event) => event.ok = false],
    ]) {
      const events = turnTrace();
      mutate(events, events.find((event) => event.type === skillType));
      assert.throws(() => assertNativeTurnTrace(events, traceSelection(), { skillType }),
        { nativeCode: "NATIVE_SKILL_TRACE_BINDING_MISMATCH" }, label);
    }
  });
}

test("Claude interrupted trace selection requires its unique Start without requiring a reconciled End", () => {
  const [start, end] = turnTrace();
  assert.deepEqual(selectNativeTurnTrace([start], traceSelection()), { turnId: start.trace.turn_id, events: [start] });
  assert.throws(() => assertNativeTurnTrace([start], traceSelection()), { nativeCode: "NATIVE_HOOK_PROMPT_CORRELATION_MISSING" });
  const recoveryPrompt = "Complete the independent follow-up.";
  const recovery = turnTrace({ turnId: `claude-start:${"b".repeat(64)}`, prompt: recoveryPrompt });
  end.outcome = "interrupted";
  const events = [start, end, ...recovery];
  assert.deepEqual(selectNativeTurnTrace(events, traceSelection()), { turnId: start.trace.turn_id, events: [start, end] });
  assert.equal(assertNativeTurnTrace(events, traceSelection(recoveryPrompt)), recovery[0].trace.turn_id);
});

test("Claude interrupted trace selection cannot use missing, duplicate or foreign Start identity", () => {
  const [start] = turnTrace();
  for (const events of [[], [start, structuredClone(start)],
    [{ ...start, ok: false }], [{ ...start, request: { prompt: "Different native input." } }],
    [{ ...start, trace: { ...start.trace, native_request_id: "foreign-prompt" } }],
    [{ ...start, trace: { ...start.trace, session_id: "foreign-session" } }],
    [{ ...start, trace: { ...start.trace, client: "codex" } }]]) {
    assert.throws(() => selectNativeTurnTrace(events, traceSelection()), { nativeCode: "NATIVE_HOOK_PROMPT_CORRELATION_MISSING" });
  }
});
