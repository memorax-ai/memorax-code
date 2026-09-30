import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { fixtureModel } from "./codebuddy-native-support.mjs";
import { assertInitializedModel, assertNativeInterruption, assertPermissionInitializations, assertToolLineage,
  CodeBuddyControlSession, inflightCommand, inflightWorkerScript,
  modelToolResult, nativePrompt, permissionArguments, selectCanceledToolTurn, summarizeToolFailure } from "./codebuddy-permissions-support.mjs";

const tool = { id: "fixture-call", name: "Write", input: { file_path: "fixture.txt", content: "fixture marker" } };
const identity = { sessionId: "session-fixture", prompt: "Synthetic permission prompt", tool };
const user = () => ({ id: "user", type: "message", role: "user", sessionId: identity.sessionId,
  content: [{ type: "input_text", text: identity.prompt }] });
const call = () => ({ id: "tool-call", type: "function_call", parentId: "user", callId: tool.id, name: tool.name,
  arguments: JSON.stringify(tool.input), status: "completed" });
const result = (status = "completed") => ({ id: "tool-result", type: "function_call_result", parentId: "tool-call",
  callId: tool.id, name: tool.name, output: { type: "text", text: "Fixture tool result" }, status });
const interruption = () => ({ id: "interrupt", type: "message", role: "assistant", status: "incomplete", parentId: "tool-result",
  content: [{ type: "output_text", text: "Interrupted by user" }], providerData: { skipRun: true } });
const approval = () => ({ type: "control_request", request_id: "perm_fixture_1", request: {
  subtype: "can_use_tool", tool_name: tool.name, tool_use_id: tool.id, input: tool.input } });
function fixture(options) {
  const child = new EventEmitter(), sent = [];
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new Writable({ write(chunk, _encoding, done) { sent.push(JSON.parse(chunk.toString())); done(); } });
  const control = new CodeBuddyControlSession(child, options);
  return { child, sent, control,
    emit(event) { child.stdout.write(`${JSON.stringify(event)}\n`); },
    close(code = 0) { child.stdout.end(); child.stderr.end(); child.emit("close", code, null); } };
}
const rejects = (fn, code) => assert.throws(fn, (error) => error.nativeCode === code && error.message === code);

test("permission initialize matches the local model catalog and its exact alias", () => {
  for (const currentModelId of [fixtureModel, `custom-local:${fixtureModel}`]) {
    for (const id of [fixtureModel, `custom-local:${fixtureModel}`]) {
      assertInitializedModel({ currentModelId, models: [{ id: "unrelated" }, { id }] });
    }
  }
  for (const initialized of [undefined, {}, { currentModelId: fixtureModel, models: [] },
    { currentModelId: fixtureModel, models: [null, { id: "other" }] },
    { currentModelId: fixtureModel, models: "invalid" },
    { currentModelId: "custom-local:other", models: [{ id: fixtureModel }] },
    { currentModelId: fixtureModel, models: [{ id: `custom-local:custom-local:${fixtureModel}` }] }]) {
    rejects(() => assertInitializedModel(initialized), "PERMISSION_INITIALIZED_MODEL_MISMATCH");
  }
});

test("permission init may repeat but every event must match the same model, session and permission mode", () => {
  const init = { type: "system", subtype: "init", session_id: identity.sessionId, model: fixtureModel, permissionMode: "default" };
  assertPermissionInitializations([init], identity.sessionId);
  assertPermissionInitializations([init, { ...init, model: `custom-local:${fixtureModel}` }, init,
    { type: "result", session_id: identity.sessionId }], identity.sessionId);
  for (const patch of [{ session_id: "foreign" }, { session_id: undefined }, { model: "unknown" },
    { model: "custom-local:other" }, { permissionMode: "bypassPermissions" }, { permissionMode: undefined }]) {
    rejects(() => assertPermissionInitializations([init, { ...init, ...patch }], identity.sessionId), "PERMISSION_NATIVE_INIT_MISMATCH");
  }
  for (const events of [undefined, [], [{ type: "result" }]]) {
    rejects(() => assertPermissionInitializations(events, identity.sessionId), "PERMISSION_NATIVE_INIT_MISMATCH");
  }
  rejects(() => assertPermissionInitializations([init], ""), "PERMISSION_NATIVE_INIT_MISMATCH");
});

test("permission arguments preserve installed discovery and choose the native stream JSON channel", () => {
  const args = permissionArguments();
  for (const [flag, value] of [["--input-format", "stream-json"], ["--output-format", "stream-json"],
    ["--permission-mode", "default"], ["--model", fixtureModel], ["--setting-sources", "user"]]) assert.equal(args[args.indexOf(flag) + 1], value);
  assert.equal(args.includes("--strict-mcp-config"), true);
  for (const flag of ["--permission-prompt-tool", "--dangerously-skip-permissions", "-y", "--no-session-persistence", "--plugin-dir"]) {
    assert.equal(args.includes(flag), false);
  }
  const allowed = permissionArguments({ allowedTool: "Write" });
  assert.deepEqual(allowed.slice(-2), ["--allowedTools", "Write"]);
});

test("control initialize and user input use correlated native wire objects", async () => {
  const f = fixture();
  const initialized = f.control.request({ subtype: "initialize" });
  assert.deepEqual(f.sent[0], { type: "control_request", request_id: "native-control-1", request: { subtype: "initialize" } });
  f.emit({ type: "control_response", response: { subtype: "success", request_id: "native-control-1", response: { currentModelId: fixtureModel } } });
  assert.deepEqual(await initialized, { currentModelId: fixtureModel });
  f.control.prompt("\u4e2d\u6587 \ud83e\uddea", "session-fixture");
  assert.deepEqual(f.sent[1], { type: "user", session_id: "session-fixture", parent_tool_use_id: null,
    message: { role: "user", content: "\u4e2d\u6587 \ud83e\uddea" } });
  f.close();
  await f.control.finish();
});

test("permission decisions use allowed/reason and cannot accidentally send Claude SDK behavior", async () => {
  for (const response of [{ allowed: true, updatedInput: tool.input }, { allowed: false, reason: "fixture denied", interrupt: false },
    { allowed: false, reason: "fixture canceled", interrupt: true }]) {
    const f = fixture();
    f.emit(approval());
    const event = await f.control.wait((event) => event.type === "control_request");
    rejects(() => f.control.respond(event, { behavior: "allow", updatedInput: tool.input }), "CODEBUDDY_CONTROL_PERMISSION_RESPONSE_INVALID");
    f.control.respond(event, response);
    assert.deepEqual(f.sent[0], { type: "control_response", response: { subtype: "success", request_id: event.request_id, response } });
    rejects(() => f.control.respond(event, response), "CODEBUDDY_CONTROL_PERMISSION_NOT_PENDING");
    f.close();
  }
});

test("pending interruption does not fabricate an outbound control_cancel_request", async () => {
  const f = fixture();
  f.emit(approval());
  const pending = f.control.request({ subtype: "interrupt", session_id: "session-fixture", reason: "fixture cancellation" });
  f.emit({ type: "control_response", response: { subtype: "success", request_id: "native-control-1",
    response: { session_id: "session-fixture", interrupted: true } } });
  assert.equal((await pending).interrupted, true);
  const terminal = { type: "result", subtype: "success", is_error: false, terminal_reason: "aborted_tools", session_id: "session-fixture", result: "" };
  f.emit(terminal);
  assertNativeInterruption(await f.control.wait((event) => event.type === "result"), "session-fixture");
  assert.equal(f.control.events.some((event) => event.type === "control_cancel_request"), false);
  f.control.prompt("Independent recovery", "session-fixture");
  assert.equal(f.sent.at(-1).message.content, "Independent recovery");
  f.close();
});

test("control parser preserves split UTF-8 and ignores private stderr payloads", async () => {
  const f = fixture();
  const event = { type: "assistant", message: { content: [{ type: "text", text: "\u4e2d\u6587 \ud83e\uddea" }] } };
  for (const byte of Buffer.from(`${JSON.stringify(event)}\n`)) f.child.stdout.write(Buffer.from([byte]));
  f.child.stderr.write("private-path-and-key-canary");
  assert.deepEqual(await f.control.wait((event) => event.type === "assistant"), event);
  assert.equal(JSON.stringify(f.control.events).includes("canary"), false);
  f.close();
});

test("malformed, duplicate and unrelated control messages fail with fixed codes", () => {
  for (const [events, code] of [
    [[{ type: "control_response", response: { request_id: "foreign", subtype: "success" } }], "CODEBUDDY_CONTROL_RESPONSE_ID_MISMATCH"],
    [[approval(), approval()], "CODEBUDDY_CONTROL_REQUEST_ID_INVALID"],
    [[{ ...approval(), request: { ...approval().request, tool_use_id: "" } }], "CODEBUDDY_CONTROL_PERMISSION_INVALID"],
    [[{ ...approval(), request: { ...approval().request, subtype: "unexpected_private_callback" } }], "CODEBUDDY_CONTROL_PERMISSION_INVALID"],
    [[{ type: "control_request", request_id: "", request: approval().request }], "CODEBUDDY_CONTROL_REQUEST_ID_INVALID"],
    [[[]], "CODEBUDDY_CONTROL_INVALID_EVENT"],
  ]) {
    const f = fixture();
    for (const event of events) f.emit(event);
    assert.equal(f.control.failure, code);
    rejects(() => f.control.prompt("next"), code);
    f.close();
  }
  const f = fixture();
  f.child.stdout.write("private-invalid-json-canary\n");
  assert.equal(f.control.failure, "CODEBUDDY_CONTROL_INVALID_JSON");
  f.close();
});

test("control errors, timeout and premature process exit reject bounded pending requests", async () => {
  for (const [action, code] of [
    [(f) => f.emit({ type: "control_response", response: { request_id: "native-control-1", subtype: "error", error: "private diagnostic" } }),
      "CODEBUDDY_CONTROL_REQUEST_REJECTED"],
    [(f) => f.close(3), "CODEBUDDY_CONTROL_EXITED_DURING_REQUEST"],
    [() => {}, "CODEBUDDY_CONTROL_REQUEST_TIMEOUT"],
  ]) {
    const f = fixture({ requestTimeout: 5 });
    const request = f.control.request({ subtype: "initialize" });
    const rejection = assert.rejects(request, (error) => error.nativeCode === code && error.message === code);
    action(f);
    await rejection;
    assert.equal(f.control.pending.size, 0);
    f.close();
  }
});

test("control output limit, truncated JSON and nonzero exit cannot report completion", async () => {
  const f = fixture({ outputLimit: 8 });
  f.child.stderr.write("private-long-output");
  assert.equal(f.control.failure, "CODEBUDDY_CONTROL_OUTPUT_LIMIT");
  f.close();
  await assert.rejects(f.control.finish(), { nativeCode: "CODEBUDDY_CONTROL_OUTPUT_LIMIT" });
  const truncated = fixture();
  truncated.child.stdout.write('{"type":');
  truncated.close();
  await new Promise((done) => setImmediate(done));
  await assert.rejects(truncated.control.finish(), { nativeCode: "CODEBUDDY_CONTROL_TRUNCATED_JSON" });
  const nonzero = fixture();
  nonzero.close(7);
  await assert.rejects(nonzero.control.finish(), { nativeCode: "CODEBUDDY_CONTROL_PROCESS_FAILED" });
});

test("native interrupted result is not a normal success, a denial, or Claude's terminal format", () => {
  const event = { type: "result", subtype: "success", is_error: false, terminal_reason: "aborted_tools", session_id: identity.sessionId };
  assert.equal(assertNativeInterruption(event, identity.sessionId), "aborted_tools");
  for (const patch of [{ terminal_reason: undefined }, { terminal_reason: "aborted_streaming" }, { terminal_reason: "end_turn" },
    { is_error: true, subtype: "error_during_execution" }, { session_id: "foreign" }, { type: "assistant" }]) {
    rejects(() => assertNativeInterruption({ ...event, ...patch }, identity.sessionId), "PERMISSION_NATIVE_INTERRUPTION_RESULT_MISSING");
  }
});

test("permission cancellation requires its exact native denial terminal and matching tool identity", () => {
  const event = { type: "result", subtype: "error_during_execution", is_error: true, session_id: identity.sessionId,
    errors: ["Permission denied for tool(s): Write"],
    permission_denials: [{ tool_name: tool.name, tool_use_id: tool.id, tool_input: tool.input }] };
  const options = { permissionCancellationTool: tool };
  assert.equal(assertNativeInterruption(event, identity.sessionId, options), "permission_denied_interrupt");
  rejects(() => assertNativeInterruption(event, identity.sessionId), "PERMISSION_NATIVE_INTERRUPTION_RESULT_MISSING");
  for (const patch of [{ type: "assistant" }, { session_id: "foreign" }, { is_error: false }, { subtype: "success" },
    { terminal_reason: "aborted_tools" }, { result: "" }, { errors: undefined }, { errors: [] },
    { errors: ["Permission denied for tool(s): Bash"] }, { errors: ["Permission denied for tool(s): Write, Bash"] },
    { errors: ["Permission denied for tool(s): Write", "private failure canary"] },
    { errors: ["private failure canary"] }, { permission_denials: undefined }, { permission_denials: [] },
    { permission_denials: [...event.permission_denials, ...event.permission_denials] },
    ...[{ tool_name: "Bash" }, { tool_use_id: "foreign" }, { tool_input: { ...tool.input, content: "other" } }]
      .map((denial) => ({ permission_denials: [{ ...event.permission_denials[0], ...denial }] }))]) {
    rejects(() => assertNativeInterruption({ ...event, ...patch }, identity.sessionId, options),
      "PERMISSION_NATIVE_INTERRUPTION_RESULT_MISSING");
  }
  for (const invalid of [null, {}, { ...tool, id: "" }, { ...tool, name: "" }, { ...tool, input: undefined }]) {
    rejects(() => assertNativeInterruption(event, identity.sessionId, { permissionCancellationTool: invalid }),
      "PERMISSION_NATIVE_INTERRUPTION_RESULT_MISSING");
  }
  rejects(() => assertNativeInterruption(undefined, identity.sessionId, options), "PERMISSION_NATIVE_INTERRUPTION_RESULT_MISSING");
});

test("completed and denied tool proof matches exact call, input and native result status", () => {
  assert.deepEqual(assertToolLineage([user(), call(), result()], tool), { toolResultRecorded: true });
  assert.deepEqual(assertToolLineage([user(), call(), result("incomplete")], tool, { denied: true }), { toolResultRecorded: true });
  for (const records of [[user(), { ...call(), name: "Bash" }, result()], [user(), { ...call(), arguments: "{}" }, result()],
    [user(), call(), call(), result()]]) rejects(() => assertToolLineage(records, tool), "PERMISSION_TRANSCRIPT_TOOL_MISMATCH");
  rejects(() => assertToolLineage([user(), { ...call(), arguments: "{" }, result()], tool), "PERMISSION_TRANSCRIPT_TOOL_ARGUMENTS_INVALID");
  rejects(() => assertToolLineage([user(), call()], tool), "PERMISSION_TRANSCRIPT_RESULT_COUNT_MISMATCH");
  rejects(() => assertToolLineage([user(), call(), result("incomplete")], tool), "PERMISSION_TRANSCRIPT_RESULT_STATUS_MISMATCH");
  rejects(() => assertToolLineage([user(), call(), { ...result(), parentId: "user" }], tool), "PERMISSION_TRANSCRIPT_RESULT_LINEAGE_MISMATCH");
});

test("canceled transcript requires native tool ancestry without inventing an optional result", () => {
  const noResult = selectCanceledToolTurn([user(), call()], identity);
  assert.equal(noResult.toolResultRecorded, false);
  const complete = selectCanceledToolTurn([user(), call(), result("incomplete"), interruption()], identity);
  assert.equal(complete.toolResultRecorded, true);
  assert.deepEqual(complete.lineage.map((record) => record.id), ["user", "tool-call", "tool-result", "interrupt"]);
  const next = { ...user(), id: "next-user", parentId: "interrupt", content: [{ type: "input_text", text: "Independent recovery" }] };
  const final = { ...interruption(), id: "next-answer", parentId: next.id, status: "completed" };
  assert.equal(selectCanceledToolTurn([user(), call(), result("incomplete"), interruption(), next, final], identity).lineage.length, 4);
});

test("canceled transcript rejects completed answers/results, foreign sessions and later-prompt calls", () => {
  rejects(() => selectCanceledToolTurn([user(), call(), result()], identity), "PERMISSION_TRANSCRIPT_RESULT_STATUS_MISMATCH");
  rejects(() => selectCanceledToolTurn([user(), call(), result("incomplete"), { ...interruption(), status: "completed" }], identity),
    "PERMISSION_CANCELED_TRANSCRIPT_HAS_COMPLETED_ANSWER");
  rejects(() => selectCanceledToolTurn([user(), { ...call(), sessionId: "foreign" }], identity), "PERMISSION_TRANSCRIPT_IDENTITY_INVALID");
  rejects(() => selectCanceledToolTurn([user(), call(), call()], identity), "PERMISSION_TRANSCRIPT_IDENTITY_INVALID");
  const next = { ...user(), id: "next", parentId: "user", content: [{ type: "input_text", text: "Other prompt" }] };
  rejects(() => selectCanceledToolTurn([user(), next, { ...call(), parentId: "next" }], identity), "PERMISSION_TRANSCRIPT_TOOL_MISMATCH");
  rejects(() => selectCanceledToolTurn([user(), { ...call(), parentId: "missing" }], identity), "PERMISSION_TRANSCRIPT_TOOL_MISMATCH");
  rejects(() => selectCanceledToolTurn([user(), { ...user(), id: "ambiguous" }, call()], identity), "PERMISSION_TRANSCRIPT_PROMPT_MISMATCH");
  rejects(() => selectCanceledToolTurn([user(), { ...call(), parentId: "tool-call" }], identity), "PERMISSION_TRANSCRIPT_TOOL_MISMATCH");
});

test("native prompt extraction uses original input or one exact user_query envelope", () => {
  assert.equal(nativePrompt(user().content), identity.prompt);
  assert.equal(nativePrompt([{ type: "input_text", text: "Expanded content", providerData: { content: identity.prompt } }]), identity.prompt);
  assert.equal(nativePrompt([{ type: "input_text", text: `<system-reminder>fixture</system-reminder><user_query>\n${identity.prompt}\n</user_query>` }]), identity.prompt);
  for (const content of [undefined, "not native", [{ type: "output_text", text: identity.prompt }],
    [{ type: "input_text", text: identity.prompt, providerData: { content: null } }],
    [{ type: "input_text", text: `<user_query>${identity.prompt}` }],
    [{ type: "input_text", text: `<user_query>${identity.prompt}</user_query><user_query>other</user_query>` }]]) assert.equal(nativePrompt(content), undefined);
});

test("OpenAI tool results require one matching tool_call_id without accepting another client format", () => {
  assert.equal(modelToolResult({ messages: [{ role: "tool", tool_call_id: tool.id, content: "fixture result" }] }, tool.id), "fixture result");
  assert.equal(modelToolResult({ messages: [{ role: "tool", tool_call_id: tool.id,
    content: [{ type: "text", text: "first" }, { type: "text", text: "last" }] }] }, tool.id), "first\nlast");
  for (const messages of [[], [{ role: "user", content: [{ type: "tool_result", tool_use_id: tool.id, content: "Claude-shaped" }] }],
    [{ role: "tool", tool_call_id: "foreign", content: "wrong" }], Array(2).fill({ role: "tool", tool_call_id: tool.id, content: "duplicate" })]) {
    rejects(() => modelToolResult({ messages }, tool.id), "PERMISSION_MATCHING_NATIVE_TOOL_RESULT_MISSING");
  }
  rejects(() => modelToolResult({ messages: [{ role: "tool", tool_call_id: tool.id, content: { private: "payload" } }] }, tool.id),
    "PERMISSION_TOOL_RESULT_CONTENT_INVALID");
});

for (const [platform, root] of [["win32", "C:\\fixture space\\permissions"], ["linux", "/tmp/fixture space/permissions"], ["darwin", "/tmp/fixture space/permissions"]]) {
  test(`inflight fixture on ${platform} publishes its identity atomically before its delayed file effect`, () => {
    const separator = platform === "win32" ? "\\" : "/";
    const inputs = { executable: `${root}${separator}node`, scriptPath: `${root}${separator}worker.cjs`,
      startedPath: `${root}${separator}started.json`, markerPath: `${root}${separator}marker.txt`, marker: "marker ' $HOME `echo` \\ value" };
    const command = inflightCommand(inputs, platform);
    const normalize = (value) => platform === "win32" ? value.replaceAll("\\", "/") : value;
    const expectedArgs = [inputs.executable, inputs.scriptPath, inputs.startedPath, inputs.markerPath].map(normalize).concat(inputs.marker);
    assert.equal(command, expectedArgs.map((value) => `'${value.replaceAll("'", "'\\''")}'`).join(" "));
    assert.equal(command.includes(" -e "), false);
    const calls = [], timers = [];
    runInNewContext(inflightWorkerScript, { process: { argv: [expectedArgs[0], ...expectedArgs.slice(1)], pid: 4312 },
      require(name) { assert.equal(name, "node:fs"); return { writeFileSync: (...args) => calls.push(["write", ...args]),
        renameSync: (...args) => calls.push(["rename", ...args]) }; }, setTimeout: (callback, ms) => timers.push({ callback, ms }) });
    assert.deepEqual(calls, [["write", `${expectedArgs[2]}.tmp`, JSON.stringify({ pid: 4312, marker: inputs.marker })],
      ["rename", `${expectedArgs[2]}.tmp`, expectedArgs[2]]]);
    assert.equal(timers.length, 1);
    assert.equal(timers[0].ms, 60000);
    timers[0].callback();
    assert.deepEqual(calls.at(-1), ["write", expectedArgs[3], inputs.marker]);
  });
}

test("tool diagnostics project only byte counts and fixed signatures", () => {
  const raw = "private/file/path SyntaxError: Invalid Unicode escape sequence\nAPI_KEY=private-canary\nENOENT\n";
  assert.deepEqual(summarizeToolFailure(raw), { textBytes: Buffer.byteLength(raw), signatures: ["syntax_error", "invalid_unicode_escape", "enoent"] });
  assert.equal(JSON.stringify(summarizeToolFailure(raw)).includes("private"), false);
  assert.deepEqual(summarizeToolFailure("ordinary fixture output"), { textBytes: 23, signatures: [] });
});
