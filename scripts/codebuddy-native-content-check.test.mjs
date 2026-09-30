import assert from "node:assert/strict";
import { test } from "node:test";
import { assertNativeReadText, assertNativeToolCalls, matchesNativeModel, selectNativeBashStdout, selectNativeTurnContent,
  summarizeNativeCompletion, summarizeWritebackTrace, toolResult } from "./codebuddy-native-content-check.mjs";

const identity = { sessionId: "session-fixture", prompt: "Native prompt.", finalText: "Native answer." };
const user = () => ({ id: "user-prompt", type: "message", role: "user", sessionId: identity.sessionId,
  timestamp: "2026-09-30T01:00:00.000Z", content: [{ type: "input_text", text: identity.prompt }] });
const assistant = () => ({ id: "assistant-final", type: "message", role: "assistant", parentId: "user-prompt",
  status: "completed", timestamp: "2026-09-30T01:00:01.000Z", content: [{ type: "output_text", text: identity.finalText }] });
const fails = (records, code, options = identity) => assert.throws(() => selectNativeTurnContent(records, options),
  (error) => error.nativeCode === code && error.message === code);

test("CodeBuddy native model identity accepts only the exact raw or custom-local model ID", () => {
  const expected = "fixture-model";
  assert.equal(matchesNativeModel(expected, expected), true);
  assert.equal(matchesNativeModel(`custom-local:${expected}`, expected), true);
  for (const actual of [undefined, null, 7, "", "unknown", "other", "custom-local:other",
    ` ${expected}`, `${expected} `, `prefix:${expected}`, `custom-local:custom-local:${expected}`, `${expected}-other`]) {
    assert.equal(matchesNativeModel(actual, expected), false);
  }
  for (const invalid of [undefined, null, 7, "", " ", " fixture-model "]) {
    assert.equal(matchesNativeModel(invalid, invalid), false);
  }
});

test("CodeBuddy native oracle selects the exact CLI-observed prompt and final, not the latest turn", () => {
  const laterUser = { ...user(), id: "later-user", parentId: "assistant-final", content: [{ type: "input_text", text: "Later prompt." }] };
  const laterAssistant = { ...assistant(), id: "later-final", parentId: laterUser.id, content: [{ type: "output_text", text: "Later answer." }] };
  const selected = selectNativeTurnContent([user(), assistant(), laterUser, laterAssistant], identity);
  assert.equal(selected.sessionId, identity.sessionId);
  assert.deepEqual(selected.user, { id: "user-prompt", content: identity.prompt, timestamp: Date.parse("2026-09-30T01:00:00.000Z") });
  assert.deepEqual(selected.assistant, { id: "assistant-final", content: identity.finalText, timestamp: Date.parse("2026-09-30T01:00:01.000Z") });
  assert.deepEqual(selected.lineage.map((record) => record.id), ["user-prompt", "assistant-final"]);
});

test("CodeBuddy native oracle preserves full Unicode paragraphs and excludes tool and reasoning content", () => {
  const prompt = "\u7b2c\u4e00\u6bb5 \ud83e\uddea\n\nMiddle: caf\u00e9 and \u65e5\u672c\u8a9e.\n\nLast paragraph.";
  const finalText = "\u786e\u8ba4\u3002\n\nKeep every paragraph.\n\nDone.";
  const first = { ...user(), content: [{ type: "input_text", text: prompt }] };
  const call = { id: "call", type: "function_call", role: "assistant", parentId: first.id, name: "Bash", arguments: "TOOL_INPUT_CANARY" };
  const result = { id: "result", type: "function_call_result", parentId: call.id, output: "TOOL_OUTPUT_CANARY" };
  const reasoning = { id: "reasoning", type: "reasoning", parentId: result.id, content: [{ type: "output_text", text: "REASONING_RECORD_CANARY" }] };
  const last = { ...assistant(), parentId: reasoning.id, content: [
    { type: "reasoning_text", text: "REASONING_BLOCK_CANARY" }, { type: "input_text", text: "WRONG_ROLE_CANARY" },
    { type: "output_text", text: finalText }, { type: "function_call_result", text: "TOOL_BLOCK_CANARY" },
  ] };
  const selected = selectNativeTurnContent([first, call, result, reasoning, last], { ...identity, prompt, finalText });
  assert.equal(selected.user.content, prompt);
  assert.equal(selected.assistant.content, finalText);
  assert.deepEqual(selected.lineage.map((record) => record.id), [first.id, call.id, result.id, reasoning.id, last.id]);
});

test("CodeBuddy native oracle follows native original input instead of expanded Skill instructions", () => {
  const prompt = "/memorax-code explain <user_query>literal tags</user_query>";
  const first = { ...user(), content: [{ type: "input_text", text: "Expanded Skill instructions.", providerData: { content: prompt } }] };
  assert.equal(selectNativeTurnContent([first, assistant()], { ...identity, prompt }).user.content, prompt);
  for (const original of ["wrong prompt", "", " ", null, 7, [prompt]]) {
    first.content[0].providerData.content = original;
    fails([first, assistant()], typeof original === "string" && original.trim() ? "NATIVE_TRANSCRIPT_PROMPT_MISMATCH"
      : "NATIVE_TRANSCRIPT_ORIGINAL_INPUT_INVALID", { ...identity, prompt });
  }
});

test("CodeBuddy native oracle unwraps the native user_query envelope without Hook context", () => {
  const first = { ...user(), content: [{ type: "input_text",
    text: `<system-reminder>HOOK_CONTEXT_CANARY</system-reminder>\n<user_query>\n${identity.prompt}\n</user_query>` }] };
  assert.equal(selectNativeTurnContent([first, assistant()], identity).user.content, identity.prompt);
  for (const text of [`<user_query>${identity.prompt}`, `</user_query>${identity.prompt}<user_query>`,
    `<user_query>${identity.prompt}</user_query><user_query>extra</user_query>`]) {
    fails([{ ...first, content: [{ type: "input_text", text }] }, assistant()], "NATIVE_TRANSCRIPT_PROMPT_WRAPPER_INVALID");
  }
});

test("CodeBuddy native oracle preserves literal user_query tags in an exact unwrapped prompt", () => {
  const prompt = "Explain <user_query>literal tags</user_query>.";
  const first = { ...user(), content: [{ type: "input_text", text: prompt }] };
  assert.equal(selectNativeTurnContent([first, assistant()], { ...identity, prompt }).user.content, prompt);
});

test("CodeBuddy native oracle joins complete visible blocks in their recorded order", () => {
  const prompt = "First.\n\nMiddle.\n\nLast.";
  const first = { ...user(), content: [
    { type: "input_text", text: "First.\n" }, { type: "output_text", text: "WRONG_TYPE_CANARY" }, { type: "input_text", text: "Middle.\n\nLast." },
  ] };
  const last = { ...assistant(), content: [{ type: "output_text", text: "First.\n" }, { type: "output_text", text: "Middle.\n\nLast." }] };
  const selected = selectNativeTurnContent([first, last], { ...identity, prompt, finalText: prompt });
  assert.equal(selected.user.content, prompt);
  assert.equal(selected.assistant.content, prompt);
});

test("CodeBuddy native oracle rejects missing identity and malformed inputs with stable error codes", () => {
  for (const sessionId of [undefined, null, "", " "]) fails([user(), assistant()], "NATIVE_TRANSCRIPT_IDENTITY_MISSING", { ...identity, sessionId });
  for (const value of [undefined, null, "", " ", 7]) {
    fails([user(), assistant()], "NATIVE_EXPECTED_CONTENT_INVALID", { ...identity, prompt: value });
    fails([user(), assistant()], "NATIVE_EXPECTED_CONTENT_INVALID", { ...identity, finalText: value });
  }
  for (const records of [undefined, {}, [], [null], [[]], [7]]) fails(records, "NATIVE_TRANSCRIPT_RECORDS_INVALID");
});

test("CodeBuddy native oracle rejects foreign sessions and a sessionless selected user", () => {
  for (const patch of [{ sessionId: "foreign" }, { sessionId: null }, { sessionId: "" }]) {
    fails([{ ...user(), ...patch }, assistant()], "NATIVE_TRANSCRIPT_SESSION_MISMATCH");
    fails([user(), { ...assistant(), ...patch }], "NATIVE_TRANSCRIPT_SESSION_MISMATCH");
  }
  fails([{ ...user(), sessionId: undefined }, assistant()], "NATIVE_TRANSCRIPT_SESSION_MISMATCH");
  fails([user(), assistant(), { type: "metadata", sessionId: "foreign" }], "NATIVE_TRANSCRIPT_SESSION_MISMATCH");
});

test("CodeBuddy native oracle permits inherited session identity only through the exact parent chain", () => {
  const call = { id: "call", type: "function_call", parentId: "user-prompt" };
  const last = { ...assistant(), parentId: call.id };
  assert.equal(selectNativeTurnContent([user(), call, last], identity).assistant.id, last.id);
  fails([user(), { ...call, sessionId: "foreign" }, last], "NATIVE_TRANSCRIPT_SESSION_MISMATCH");
});

test("CodeBuddy native oracle rejects duplicate or invalid record IDs instead of replacing records", () => {
  fails([user(), assistant(), assistant()], "NATIVE_TRANSCRIPT_ID_INVALID");
  fails([user(), assistant(), { id: "user-prompt", type: "metadata" }], "NATIVE_TRANSCRIPT_ID_INVALID");
  for (const id of [undefined, null, "", " ", 7]) {
    fails([{ ...user(), id }, assistant()], "NATIVE_TRANSCRIPT_ID_INVALID");
    fails([user(), { ...assistant(), id }], "NATIVE_TRANSCRIPT_ID_INVALID");
  }
  fails([user(), { type: "function_call_result", parentId: "user-prompt" }, assistant()], "NATIVE_TRANSCRIPT_ID_INVALID");
});

test("CodeBuddy native oracle rejects ambiguous matching users and completed branches", () => {
  fails([user(), assistant(), { ...user(), id: "duplicate-prompt" }], "NATIVE_TRANSCRIPT_PROMPT_AMBIGUOUS");
  for (const content of [identity.finalText, "A different final."]) {
    fails([user(), assistant(), { ...assistant(), id: "other-final", content: [{ type: "output_text", text: content }] }],
      "NATIVE_TRANSCRIPT_FINAL_AMBIGUOUS");
  }
  fails([user(), assistant(), { ...assistant(), id: "partial-branch", status: "incomplete" }], "NATIVE_TRANSCRIPT_FINAL_AMBIGUOUS");
});

test("CodeBuddy native oracle rejects unfinished replies and tool-only completion", () => {
  for (const status of [undefined, null, "incomplete", "cancelled", "completed "]) {
    fails([user(), { ...assistant(), status }], "NATIVE_TRANSCRIPT_FINAL_INCOMPLETE");
  }
  fails([user()], "NATIVE_TRANSCRIPT_FINAL_MISSING");
  fails([user(), { ...assistant(), type: "function_call" }], "NATIVE_TRANSCRIPT_FINAL_MISSING");
  fails([user(), assistant(), { id: "late-tool", type: "function_call", parentId: "assistant-final" }], "NATIVE_TRANSCRIPT_FINAL_INCOMPLETE");
});

test("CodeBuddy native oracle rejects broken, cyclic, and non-native parent lineage", () => {
  for (const patch of [{ parentId: "missing" }, { parentId: undefined }, { parentId: null },
    { parentId: undefined, logicalParentId: "user-prompt" }, { parentId: "assistant-final" }]) {
    fails([user(), { ...assistant(), ...patch }], "NATIVE_TRANSCRIPT_FINAL_MISSING");
  }
  fails([user(), { ...assistant(), parentId: 7 }], "NATIVE_TRANSCRIPT_PARENT_INVALID");
  fails([{ ...user(), parentId: "assistant-final" }, assistant()], "NATIVE_TRANSCRIPT_LINEAGE_INVALID");
  const call = { id: "call", type: "function_call", parentId: "result" };
  const result = { id: "result", type: "function_call_result", parentId: "call" };
  fails([user(), call, result, { ...assistant(), parentId: "result" }], "NATIVE_TRANSCRIPT_FINAL_MISSING");
});

test("CodeBuddy native oracle does not cross a newer user to reuse an older matching prompt", () => {
  const current = { ...user(), id: "current-user", parentId: "user-prompt", content: [{ type: "input_text", text: "Different current prompt." }] };
  fails([user(), current, { ...assistant(), parentId: current.id }], "NATIVE_TRANSCRIPT_FINAL_MISSING");
});

test("CodeBuddy native oracle rejects omitted or reordered paragraphs and extra final content", () => {
  const complete = "First.\n\nMiddle.\n\nLast.";
  for (const actual of ["First.\n\nLast.", "Last.\n\nMiddle.\n\nFirst.", `${complete}\nInjected.`, ` ${complete}`]) {
    fails([{ ...user(), content: [{ type: "input_text", text: actual }] }, assistant()],
      "NATIVE_TRANSCRIPT_PROMPT_MISMATCH", { ...identity, prompt: complete });
    fails([user(), { ...assistant(), content: [{ type: "output_text", text: actual }] }],
      "NATIVE_TRANSCRIPT_ANSWER_MISMATCH", { ...identity, finalText: complete });
  }
});

test("CodeBuddy native oracle rejects empty or malformed content and wrong visible block types", () => {
  for (const content of [undefined, null, "text", [], [{ type: "input_text", text: 7 }], [{ type: "input_text", text: " " }],
    [{ type: "output_text", text: identity.prompt }]]) {
    fails([{ ...user(), content }, assistant()], "NATIVE_TRANSCRIPT_CONTENT_INVALID");
  }
  for (const content of [undefined, null, "text", [], [{ type: "output_text", text: 7 }], [{ type: "output_text", text: " " }],
    [{ type: "input_text", text: identity.finalText }], [{ type: "reasoning", text: identity.finalText }]]) {
    fails([user(), { ...assistant(), content }], "NATIVE_TRANSCRIPT_CONTENT_INVALID");
  }
});

test("CodeBuddy native oracle never fabricates timestamps and validates native values when present", () => {
  const selected = selectNativeTurnContent([{ ...user(), timestamp: undefined }, { ...assistant(), timestamp: undefined }], identity);
  assert.equal(selected.user.timestamp, undefined);
  assert.equal(selected.assistant.timestamp, undefined);
  const timestamp = Date.parse("2026-09-30T01:00:00.000Z");
  assert.equal(selectNativeTurnContent([{ ...user(), timestamp }, assistant()], identity).user.timestamp, timestamp);
  assert.equal(selectNativeTurnContent([user(), { ...assistant(), timestamp: "2026-09-30T09:00:00+08:00" }], identity).assistant.timestamp, timestamp);
  for (const timestamp of [null, "2026-09-30T01:00:00", "invalid", -1, NaN, Infinity]) {
    fails([{ ...user(), timestamp }, assistant()], "NATIVE_TRANSCRIPT_TIMESTAMP_INVALID");
    fails([user(), { ...assistant(), timestamp }], "NATIVE_TRANSCRIPT_TIMESTAMP_INVALID");
  }
});

test("CodeBuddy native oracle errors never include native content or provider data", () => {
  const secret = "PRIVATE_NATIVE_CONTENT_CANARY";
  for (const records of [[user(), { ...assistant(), content: [{ type: "output_text", text: secret }] }],
    [{ ...user(), content: [{ type: "input_text", text: secret, providerData: { content: { private: secret } } }] }, assistant()]]) {
    assert.throws(() => selectNativeTurnContent(records, identity), (error) => {
      assert.equal(error.message, error.nativeCode);
      assert.match(error.nativeCode, /^NATIVE_[A-Z_]+$/);
      assert.ok(!error.message.includes(secret));
      return true;
    });
  }
});

test("native Read must return every reference line in order", () => {
  const reference = "# Reference\n\nComplete \u4e2d\u6587 text.\n";
  const output = reference.split("\n").map((line, index) => `${String(index + 1).padStart(4)}\u2192${line}`).join("\n");
  assertNativeReadText(output, reference);
  assertNativeReadText(output.replaceAll("\n", "\r\n"), reference);
  assert.throws(() => assertNativeReadText(output.replace("Complete", "Omitted"), reference), { nativeCode: "NATIVE_READ_REFERENCE_INCOMPLETE" });
  assert.throws(() => assertNativeReadText(output.replace("   2", "   3"), reference), { nativeCode: "NATIVE_READ_LINES_INVALID" });
  assert.throws(() => assertNativeReadText(reference, reference), { nativeCode: "NATIVE_READ_LINES_INVALID" });
  assert.throws(() => assertNativeReadText(output.split("\n").slice(0, 2).join("\n"), reference), { nativeCode: "NATIVE_READ_REFERENCE_INCOMPLETE" });
});

const bashEnvelope = (command, stdout) => `Command: ${command}\nStdout: ${stdout}\nStderr: (empty)\nExit Code: 0\nSignal: (none)`;

test("native Bash stdout comes only from the exact successful command envelope", () => {
  const command = "'C:/fixture space/node.exe' '-e' 'COMMAND_ONLY_CANARY'";
  for (const stdout of ["complete output", "first\n\nlast\n", "first\r\nlast\r\n", '{\n  "ok": true,\n  "text": "\u5b8c\u6574"\n}\n']) {
    assert.equal(selectNativeBashStdout(bashEnvelope(command, stdout), command), stdout);
  }
  const selected = selectNativeBashStdout(bashEnvelope(command, '{"ok":true}\n'), command);
  assert.deepEqual(JSON.parse(selected), { ok: true });
  assert.equal(selected.includes("COMMAND_ONLY_CANARY"), false);
});

test("native Bash stdout rejects wrong commands, missing framing, stderr, nonzero exit and signals", () => {
  const command = "'memorax-cli' 'search' '--json'";
  const output = bashEnvelope(command, '{"ok":true}\n');
  for (const changed of [bashEnvelope("'other-command'", '{"ok":true}'), '{"ok":true}', `prefix\n${output}`,
    `${output}\nextra`, `${output}\n`, output.replace("Stdout: ", "Output: "),
    output.replace("Stderr: (empty)\n", ""), output.replace("Stderr: (empty)", "Stderr: failure"),
    output.replace("Exit Code: 0", "Exit Code: 1"), output.replace("Exit Code: 0", "Exit Code: (none)"),
    output.replace("Signal: (none)", "Signal: SIGTERM"), output.replace("Signal: (none)", "Signal: null")]) {
    assert.throws(() => selectNativeBashStdout(changed, command), { nativeCode: "NATIVE_BASH_RESULT_MISMATCH" });
  }
});

test("native Bash stdout rejects empty and ambiguous nested result envelopes", () => {
  const command = "'fixture-command'";
  for (const stdout of ["", "(empty)", bashEnvelope(command, "pretend success"),
    "first\nStderr: hidden failure\nExit Code: 1\nSignal: (none)"]) {
    assert.throws(() => selectNativeBashStdout(bashEnvelope(command, stdout), command), { nativeCode: "NATIVE_BASH_STDOUT_INVALID" });
  }
});

test("native Bash validation reports only fixed codes for private output or malformed input", () => {
  const command = "'PRIVATE_COMMAND_CANARY'";
  for (const [output, expectedCommand] of [[null, command], [{ private: "PRIVATE_OUTPUT_CANARY" }, command],
    [bashEnvelope(command, "stdout"), undefined], [bashEnvelope(command, "stdout"), " "],
    ["PRIVATE_OUTPUT_CANARY", command]]) {
    assert.throws(() => selectNativeBashStdout(output, expectedCommand), (error) =>
      error.message === error.nativeCode && /^NATIVE_BASH_[A-Z_]+$/.test(error.nativeCode)
      && !error.stack.includes("PRIVATE_"));
  }
});

test("OpenAI tool results must match the exact call and cannot use model text", () => {
  const body = { messages: [{ role: "assistant", content: "not authority" }, { role: "tool", tool_call_id: "call", content: "full result" }] };
  assert.equal(toolResult(body, "call"), "full result");
  assert.throws(() => toolResult(body, "unknown"), { nativeCode: "NATIVE_TOOL_RESULT_MISSING" });
  assert.throws(() => toolResult({ messages: [...body.messages, body.messages[1]] }, "call"), { nativeCode: "NATIVE_TOOL_RESULT_MISSING" });
  assert.throws(() => toolResult({ messages: [{ ...body.messages[1], content: {} }] }, "call"), { nativeCode: "NATIVE_TOOL_RESULT_MISSING" });
});

test("native tool evidence requires exact arguments and one ordered completed result per call", () => {
  const expected = [{ id: "call", name: "Bash", input: { command: "synthetic command" } }];
  const call = { id: "call-record", callId: "call", type: "function_call", name: "Bash", arguments: JSON.stringify(expected[0].input) };
  const result = { id: "result-record", callId: "call", type: "function_call_result", status: "completed" };
  assertNativeToolCalls([call, result], expected);
  assertNativeToolCalls([], []);
  for (const records of [[call], [call, { ...result, status: "incomplete" }], [call, result, result], [result, call],
    [call, { ...result, providerData: { error: "synthetic failure" } }]]) {
    assert.throws(() => assertNativeToolCalls(records, expected), { nativeCode: "NATIVE_TRANSCRIPT_TOOL_NOT_COMPLETED" });
  }
  assert.throws(() => assertNativeToolCalls([{ ...call, arguments: "{" }, result], expected), { nativeCode: "NATIVE_TRANSCRIPT_TOOL_ARGUMENTS_INVALID" });
  assert.throws(() => assertNativeToolCalls([{ ...call, arguments: "{}" }, result], expected), { nativeCode: "NATIVE_TRANSCRIPT_TOOL_ARGUMENTS_MISMATCH" });
  assert.throws(() => assertNativeToolCalls([{ ...call, name: "Read" }, result], expected), { nativeCode: "NATIVE_TRANSCRIPT_TOOL_CALL_MISMATCH" });
  assert.throws(() => assertNativeToolCalls([call, result], []), { nativeCode: "NATIVE_TRANSCRIPT_UNEXPECTED_TOOL" });
});

const diagnosticOptions = { answer: "Native fixture answer.", model: "native-fixture-model", modelRequests: 1, memoryRequests: 0,
  receiverErrors: [] };

test("writeback diagnostics correlate only the current CodeBuddy prompt and never expose trace content", () => {
  const identity = { sessionId: "session-fixture", promptHash: "prompt-hash" };
  const trace = { client: "codebuddy", session_id: identity.sessionId, turn_id: "session-fixture:42:prompt-hash" };
  const start = { type: "turn_start", trace };
  const end = { type: "turn_end", trace, ok: false, error: "turn_not_found", request: { prompt: "PRIVATE_TRACE_CANARY" } };
  const summary = summarizeWritebackTrace([start, end,
    { ...end, trace: { ...trace, client: "claude-code" } },
    { ...end, trace: { ...trace, session_id: "another-session" } },
    { ...end, trace: { ...trace, turn_id: "session-fixture:42:another-prompt" } }],
  { [identity.sessionId]: { turnId: trace.turn_id, transcriptPath: "/private/PRIVATE_TRACE_CANARY" } }, identity);
  assert.deepEqual(summary, { turnStarts: 1, turnEnds: 1,
    endings: [{ ok: false, outcome: "other", reason: "turn_not_found" }], pendingForSession: true,
    pendingMatchesPrompt: true, pendingMatchesPromptWithoutLineBreaks: false });
  const unknown = summarizeWritebackTrace([{ ...end, error: "PRIVATE_TRACE_CANARY", outcome: "PRIVATE_TRACE_CANARY" }], {}, identity);
  assert.deepEqual(unknown.endings, [{ ok: false, outcome: "other", reason: "other" }]);
  assert.equal(JSON.stringify([summary, unknown]).includes("PRIVATE_TRACE_CANARY"), false);
});
test("writeback diagnostics recognize the native Hook's line-break-free prompt without exposing either digest", () => {
  const identity = { sessionId: "session-fixture", promptHash: "PRIVATE_ORIGINAL_HASH",
    promptWithoutLineBreaksHash: "PRIVATE_NATIVE_HASH" };
  const trace = { client: "codebuddy", session_id: identity.sessionId, turn_id: "session-fixture:42:PRIVATE_NATIVE_HASH" };
  const summary = summarizeWritebackTrace([{ type: "turn_start", trace },
    { type: "turn_end", trace, ok: false, error: "user_prompt_missing" }],
  { [identity.sessionId]: { turnId: trace.turn_id } }, identity);
  assert.deepEqual(summary, { turnStarts: 1, turnEnds: 1,
    endings: [{ ok: false, outcome: "other", reason: "user_prompt_missing" }], pendingForSession: true,
    pendingMatchesPrompt: false, pendingMatchesPromptWithoutLineBreaks: true });
  assert.equal(JSON.stringify(summary).includes("PRIVATE_"), false);
});
const resultEvent = () => ({ type: "result", subtype: "success", is_error: false, session_id: "native-fixture-session",
  result: diagnosticOptions.answer });
const initEvent = () => ({ type: "system", subtype: "init", model: diagnosticOptions.model });

test("native completion diagnostics distinguish exact success, whitespace and missing results without changing events", () => {
  const events = [initEvent(), resultEvent()], before = structuredClone(events);
  assert.deepEqual(summarizeNativeCompletion(events, diagnosticOptions), {
    resultCount: 1, subtype: "success", terminalReason: "missing", isError: false, sessionPresent: true,
    answerMatches: true, answerTrimMatches: true, resultBytes: Buffer.byteLength(diagnosticOptions.answer),
    initCount: 1, initModelMatches: true, initModelMatchCount: 1, initSessionMatchCount: 0,
    modelRequests: 1, memoryRequests: 0, receiverErrors: [], errorSignatures: [],
  });
  assert.deepEqual(events, before);
  const whitespace = summarizeNativeCompletion([initEvent(), { ...resultEvent(), result: `\n${diagnosticOptions.answer}\n` }], diagnosticOptions);
  assert.equal(whitespace.answerMatches, false);
  assert.equal(whitespace.answerTrimMatches, true);
  assert.equal(whitespace.resultBytes, Buffer.byteLength(diagnosticOptions.answer) + 2);
  assert.deepEqual(summarizeNativeCompletion([], diagnosticOptions), {
    resultCount: 0, subtype: "missing", terminalReason: "missing", isError: null, sessionPresent: false,
    answerMatches: false, answerTrimMatches: false, resultBytes: null, initCount: 0, initModelMatches: false,
    initModelMatchCount: 0, initSessionMatchCount: 0,
    modelRequests: 1, memoryRequests: 0, receiverErrors: [], errorSignatures: [],
  });
});

test("native completion diagnostics expose duplicate results, changed model and known cancellation enums", () => {
  const diagnostic = summarizeNativeCompletion([{ ...initEvent(), model: "other-model" },
    { ...resultEvent(), terminal_reason: "aborted_tools", result: "" }, resultEvent()], diagnosticOptions);
  assert.equal(diagnostic.resultCount, 2);
  assert.equal(diagnostic.terminalReason, "aborted_tools");
  assert.equal(diagnostic.answerMatches, false);
  assert.equal(diagnostic.initModelMatches, false);
  assert.equal(diagnostic.initModelMatchCount, 0);
  assert.equal(summarizeNativeCompletion([{ ...initEvent(), session_id: resultEvent().session_id }, resultEvent()],
    diagnosticOptions).initSessionMatchCount, 1);
  const repeated = summarizeNativeCompletion([initEvent(), { ...initEvent(), model: `custom-local:${diagnosticOptions.model}` },
    resultEvent()], diagnosticOptions);
  assert.equal(repeated.initModelMatches, true);
  assert.equal(repeated.initModelMatchCount, 2);
  const mismatched = summarizeNativeCompletion([initEvent(), { ...initEvent(), model: "custom-local:other" },
    resultEvent()], diagnosticOptions);
  assert.equal(mismatched.initModelMatches, false);
  assert.equal(mismatched.initModelMatchCount, 1);
});

test("native completion error signatures are fixed hints and never inferred from normal answer text", () => {
  const errors = ["HTTP 401 authentication failed", "model_not_found", "fetch failed: ECONNRESET", "connect ECONNREFUSED",
    "ETIMEDOUT", "invalid_request: bad request", "HTTP 429: rate limit", "SyntaxError: invalid JSON", "AI_TypeValidationError"];
  const diagnostic = summarizeNativeCompletion([{ ...resultEvent(), subtype: "error_during_execution", is_error: true,
    result: undefined, errors }], diagnosticOptions);
  assert.deepEqual(diagnostic.errorSignatures, ["auth", "model_not_found", "connection", "connection_refused", "timeout",
    "invalid_request", "rate_limit", "response_parse", "response_validation"]);
  assert.equal(diagnostic.isError, true);
  assert.equal(diagnostic.subtype, "error_during_execution");
  assert.equal(diagnostic.resultBytes, null);
  assert.deepEqual(summarizeNativeCompletion([{ ...resultEvent(), result: errors.join("\n"), errors }], diagnosticOptions).errorSignatures, []);
  assert.deepEqual(summarizeNativeCompletion([{ ...resultEvent(), is_error: true, errors: ["synthetic unrelated failure", { private: "value" }] }],
    diagnosticOptions).errorSignatures, []);
});

test("native completion diagnostics cannot disclose raw errors, credentials, paths, URLs or unknown enums", () => {
  const secret = "PRIVATE_DIAGNOSTIC_CANARY", path = "/private/native-fixture/home", url = "https://private-fixture.invalid/model";
  const events = [{ ...initEvent(), model: secret }, { ...resultEvent(), subtype: secret, terminal_reason: path,
    session_id: secret, is_error: true, result: `${secret} ${path} ${url}`, errors: [`ECONNREFUSED ${secret} ${url}`],
    errors_info: [{ message: secret, code: secret }], authorization: `Bearer ${secret}` }];
  const diagnostic = summarizeNativeCompletion(events, { ...diagnosticOptions, modelRequests: secret, memoryRequests: -1,
    receiverErrors: [secret, url, "NATIVE_MODEL_CREDENTIAL_MISMATCH", secret] });
  assert.equal(diagnostic.subtype, "other");
  assert.equal(diagnostic.terminalReason, "other");
  assert.equal(diagnostic.modelRequests, null);
  assert.equal(diagnostic.memoryRequests, null);
  assert.deepEqual(diagnostic.receiverErrors, ["other", "NATIVE_MODEL_CREDENTIAL_MISMATCH"]);
  assert.deepEqual(diagnostic.errorSignatures, ["connection_refused"]);
  for (const value of [secret, path, url, "Bearer", "ECONNREFUSED"]) assert.ok(!JSON.stringify(diagnostic).includes(value));
  assert.equal(events[1].subtype, secret);
});
