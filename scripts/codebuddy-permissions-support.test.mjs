import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { fixtureModel } from "./codebuddy-native-support.mjs";
import { selectNativeTurnContent } from "./codebuddy-native-content-check.mjs";
import { assertInitializedModel, assertNativeInterruption, assertPermissionDenialResult, assertPermissionDenialTerminal,
  assertPermissionInitializations, assertPermissionWritebacks, assertToolLineage,
  CodeBuddyControlSession, createPermissionReport, inflightCommand, inflightWorkerScript,
  modelToolResult, nativePrompt, permissionArguments, permissionCases, permissionInvocation, permissionModelTurn, selectCanceledToolTurn, selectInterruptOutcome, selectInterruptRecovery,
  summarizePermissionDenial, summarizeToolFailure } from "./codebuddy-permissions-support.mjs";

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
    close(code = 0, signal = null) { child.stdout.end(); child.stderr.end(); child.emit("close", code, signal); } };
}
const rejects = (fn, code) => assert.throws(fn, (error) => error.nativeCode === code && error.message === code);

test("permission invocation preserves the three-argument CodeBuddy entry and accepts explicit client routing", () => {
  const args = ["/isolated/package", "/isolated/client command", "2.159.0"];
  const expected = { client: "codebuddy", packageRoot: args[0], command: args[1], expectedVersion: args[2] };
  assert.deepEqual(permissionInvocation(args), expected);
  assert.deepEqual(permissionInvocation([...args, "codebuddy"]), expected);
  assert.deepEqual(permissionInvocation([args[0], args[1], "2.137.1", "workbuddy"]),
    { ...expected, client: "workbuddy", expectedVersion: "2.137.1" });
});

test("permission invocation rejects unknown clients, incomplete arguments and unpinned WorkBuddy versions", () => {
  for (const client of ["claude", "other", "WORKBUDDY", ""]) {
    rejects(() => permissionInvocation(["package", "command", "2.137.1", client]), "NATIVE_CLIENT_INVALID");
  }
  for (const args of [[], ["package"], ["package", "command"], ["package", "command", "2.159.0", "codebuddy", "extra"],
    ["package", "", "2.159.0"]]) {
    rejects(() => permissionInvocation(args), "EXPECTED_INSTALLED_PACKAGE_CODEBUDDY_PATH_AND_VERSION");
  }
  for (const version of ["latest", "2.137", "^2.137.1", "2.137.1-extra"]) {
    rejects(() => permissionInvocation(["package", "command", version, "workbuddy"]), "EXPECTED_EXACT_WORKBUDDY_RUNTIME_VERSION");
  }
});

test("WorkBuddy interrupt diagnostics require an explicit single-case flag after its positional client", () => {
  const args = ["package", "command", "2.147.0", "workbuddy"];
  for (const interruptCase of ["user-inflight-interrupt", "user-wait-interrupt"]) {
    assert.deepEqual(permissionInvocation([...args, "--interrupt-case", interruptCase]), {
      client: "workbuddy", packageRoot: "package", command: "command", expectedVersion: "2.147.0", interruptCase,
    });
    rejects(() => permissionInvocation([...args.slice(0, 3), "codebuddy", "--interrupt-case", interruptCase]),
      "EXPECTED_INSTALLED_PACKAGE_CODEBUDDY_PATH_AND_VERSION");
  }
  for (const extra of [["--interrupt-case"], ["--interrupt-case", "user-wait-interrupt", "extra"],
    ["--interrupt-case", "user-wait-interrupt", "--interrupt-case", "user-inflight-interrupt"],
    ["--interrupt-case", "user-wait-interrupt", "--interrupt-case", "user-wait-interrupt"]]) {
    rejects(() => permissionInvocation([...args, ...extra]), "EXPECTED_INSTALLED_PACKAGE_WORKBUDDY_PATH_AND_VERSION");
  }
  for (const extra of [["--other", "user-wait-interrupt"], ["--interrupt-case", "unknown"],
    ["--interrupt-case", "policy-allow"], ["--interrupt-case", "user-cancel"], ["--interrupt-case", ""],
    ["--interrupt-case", undefined], ["--interrupt-case", " user-wait-interrupt "]]) {
    rejects(() => permissionInvocation([...args, ...extra]), "EXPECTED_WORKBUDDY_INTERRUPT_CASE");
  }
  rejects(() => permissionInvocation([...args.slice(0, 3), "--interrupt-case", "user-wait-interrupt"]), "NATIVE_CLIENT_INVALID");
});

test("permission case selection preserves CodeBuddy six, WorkBuddy four and each strict diagnostic alone", () => {
  const codebuddy = permissionCases();
  assert.deepEqual(codebuddy, [
    { id: "policy-allow", preallowed: true, writes: true },
    { id: "user-allow", decision: "allow", writes: true },
    { id: "user-deny", decision: "deny", writes: false },
    { id: "user-cancel", decision: "cancel", interrupted: true, writes: false },
    { id: "user-inflight-interrupt", decision: "allow", inflight: true, interrupted: true, nativeInterrupt: true, writes: false },
    { id: "user-wait-interrupt", interrupted: true, nativeInterrupt: true, writes: false },
  ]);
  assert.deepEqual(permissionCases("codebuddy"), codebuddy);
  assert.deepEqual(permissionCases("workbuddy"), codebuddy.slice(0, 4));
  for (const testCase of codebuddy.slice(4)) {
    assert.deepEqual(permissionCases("workbuddy", testCase.id), [testCase]);
    rejects(() => permissionCases("codebuddy", testCase.id), "EXPECTED_WORKBUDDY_INTERRUPT_CASE");
  }
  for (const invalid of [null, "", "user-cancel", "unknown", ["user-wait-interrupt"]]) {
    rejects(() => permissionCases("workbuddy", invalid), "EXPECTED_WORKBUDDY_INTERRUPT_CASE");
  }
  rejects(() => permissionCases("unknown"), "NATIVE_CLIENT_INVALID");
  codebuddy[0].id = "mutated";
  assert.equal(permissionCases()[0].id, "policy-allow");
});

test("permission reports preserve CodeBuddy defaults and bound WorkBuddy evidence to the bundled runtime", () => {
  const codebuddy = createPermissionReport(undefined, "test-platform");
  const workbuddy = createPermissionReport("workbuddy", "test-platform");
  assert.equal(codebuddy.suite, "native_codebuddy_permissions");
  assert.equal(workbuddy.suite, "native_workbuddy_permissions");
  assert.equal(codebuddy.desktopUIValidated, undefined);
  assert.equal(codebuddy.excludedCases, undefined);
  assert.equal(codebuddy.diagnosticOnly, undefined);
  assert.equal(codebuddy.interruptCase, undefined);
  assert.equal(workbuddy.desktopUIValidated, false);
  assert.equal(workbuddy.loginFlowValidated, false);
  for (const report of [codebuddy, workbuddy]) {
    assert.equal(report.status, "FAIL");
    assert.equal(report.platform, "test-platform");
    assert.equal(report.paidModelRequests, 0);
    assert.equal(report.modelQualityEvaluated, false);
    assert.equal(report.nativeInterruptSemanticsValidated, false);
    assert.equal(report.interruptedTraceReconciliationValidated, false);
    assert.deepEqual(report.cases, []);
    for (const excluded of ["desktop approval UI", "late approval after cancellation", "interrupted trace reconciliation",
      "OS sandbox or privilege enforcement", "LLM automatic approval quality", "background Repo Memory permissions"]) {
      assert.ok(report.excludes.includes(excluded));
    }
  }
  assert.deepEqual(workbuddy.excludes, [...codebuddy.excludes, "desktop startup environment", "standalone CodeBuddy CLI"]);
  assert.deepEqual(workbuddy.excludedCases.map((entry) => entry.id), ["user-inflight-interrupt", "user-wait-interrupt"]);
  assert.ok(workbuddy.excludedCases.every((entry) => entry.status === "NOT_RUN" && entry.reason.includes("strict manual diagnostic only")));
  assert.equal(workbuddy.diagnosticOnly, undefined);
  assert.equal(workbuddy.interruptCase, undefined);
  assert.match(workbuddy.scope, /explicit runtime interrupts are separate diagnostics/);
  codebuddy.cases.push({ id: "fixture", status: "PASS" });
  assert.deepEqual(createPermissionReport().cases, []);
  rejects(() => createPermissionReport("unknown"), "NATIVE_CLIENT_INVALID");
});

test("single-case WorkBuddy reports remain strict diagnostics without claiming default acceptance", () => {
  for (const interruptCase of ["user-inflight-interrupt", "user-wait-interrupt"]) {
    const report = createPermissionReport("workbuddy", "test-platform", interruptCase);
    assert.equal(report.status, "FAIL");
    assert.equal(report.suite, "native_workbuddy_interrupt_diagnostic");
    assert.equal(report.diagnosticOnly, true);
    assert.equal(report.interruptCase, interruptCase);
    assert.equal(report.excludedCases, undefined);
    assert.equal(report.nativeInterruptSemanticsValidated, false);
    assert.equal(report.interruptedTraceReconciliationValidated, false);
    assert.equal(report.desktopUIValidated, false);
    assert.equal(report.loginFlowValidated, false);
    assert.deepEqual(report.cases, []);
    assert.match(report.scope, /excluded from default permission acceptance/);
    rejects(() => createPermissionReport("codebuddy", "test-platform", interruptCase), "EXPECTED_WORKBUDDY_INTERRUPT_CASE");
  }
  rejects(() => createPermissionReport("workbuddy", "test-platform", "unknown"), "EXPECTED_WORKBUDDY_INTERRUPT_CASE");
});

test("WorkBuddy generic denial matches its complete native projection without weakening CodeBuddy", () => {
  const generic = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";
  const reason = "FIXTURE_DENIAL_REASON";
  assert.equal(assertPermissionDenialResult(` ${generic} `, { client: "workbuddy", reason }), "native_generic_denial");
  rejects(() => assertPermissionDenialResult(generic, { reason }), "PERMISSION_NATIVE_DENIAL_RESULT_MISSING");
  for (const client of ["codebuddy", "workbuddy"]) {
    assert.equal(assertPermissionDenialResult(`Error: ${reason}`, { client, reason }), "supplied_denial_reason");
    for (const text of [undefined, "", "Permission denied", generic.slice(0, 80), `${generic} Unexpected suffix`, `Unexpected prefix ${generic}`]) {
      rejects(() => assertPermissionDenialResult(text, { client, reason }), "PERMISSION_NATIVE_DENIAL_RESULT_MISSING");
    }
    rejects(() => assertPermissionDenialResult(generic, { client, reason: "" }), "PERMISSION_DENIAL_REASON_INVALID");
  }
  rejects(() => assertPermissionDenialResult(generic, { client: "unknown", reason }), "NATIVE_CLIENT_INVALID");
  const diagnostic = summarizePermissionDenial(`private-path ${generic}`, "private-reason");
  assert.equal(diagnostic.nativeGenericDenialIncluded, true);
  assert.equal(diagnostic.nativeGenericDenialExact, false);
  assert.equal(diagnostic.suppliedReasonObserved, false);
  assert.ok(!JSON.stringify(diagnostic).includes("private"));
  assert.deepEqual(summarizePermissionDenial(undefined, reason), { textBytes: null,
    suppliedReasonObserved: false, nativeGenericDenialExact: false, nativeGenericDenialIncluded: false });
});

test("generic denial requires the exact native completed terminal's tool name, ID and input", () => {
  const terminal = { type: "result", subtype: "success", is_error: false, session_id: identity.sessionId,
    permission_denials: [{ tool_name: tool.name, tool_use_id: tool.id, tool_input: structuredClone(tool.input) }] };
  assertPermissionDenialTerminal(terminal, identity.sessionId, tool);
  for (const mutate of [
    (event) => { event.type = "assistant"; },
    (event) => { event.session_id = "foreign"; },
    (event) => { event.is_error = true; },
    (event) => { event.subtype = "error_during_execution"; },
    (event) => { event.terminal_reason = "aborted_tools"; },
    (event) => { delete event.permission_denials; },
    (event) => { event.permission_denials = []; },
    (event) => { event.permission_denials.push(structuredClone(event.permission_denials[0])); },
    (event) => { event.permission_denials[0].tool_name = "Bash"; },
    (event) => { event.permission_denials[0].tool_use_id = "foreign"; },
    (event) => { event.permission_denials[0].tool_input.file_path = "foreign.txt"; },
    (event) => { event.permission_denials[0].tool_input.content = "foreign content"; },
  ]) {
    const event = structuredClone(terminal);
    mutate(event);
    rejects(() => assertPermissionDenialTerminal(event, identity.sessionId, tool), "PERMISSION_NATIVE_DENIAL_IDENTITY_MISMATCH");
  }
  for (const invalid of [undefined, {}, { ...tool, id: undefined }, { ...tool, name: "" }, { ...tool, input: null }]) {
    rejects(() => assertPermissionDenialTerminal(terminal, identity.sessionId, invalid), "PERMISSION_NATIVE_DENIAL_IDENTITY_MISMATCH");
  }
});

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
  rejects(() => assertPermissionInitializations([{ ...init, session_id: "foreign" }], identity.sessionId), "PERMISSION_NATIVE_INIT_MISMATCH");
});

test("permission arguments preserve installed discovery and choose the native stream JSON channel", () => {
  const sessionId = "07d512a8-93e0-48c1-b747-e27672c95630";
  const args = permissionArguments({ sessionId });
  for (const [flag, value] of [["--input-format", "stream-json"], ["--output-format", "stream-json"],
    ["--permission-mode", "default"], ["--model", fixtureModel], ["--setting-sources", "user"],
    ["--session-id", sessionId]]) assert.equal(args[args.indexOf(flag) + 1], value);
  assert.equal(args.filter((arg) => arg === "--session-id").length, 1);
  assert.equal(args.includes("--strict-mcp-config"), true);
  for (const flag of ["--permission-prompt-tool", "--dangerously-skip-permissions", "-y", "--no-session-persistence", "--plugin-dir", "--resume", "--continue"]) {
    assert.equal(args.includes(flag), false);
  }
  const allowed = permissionArguments({ sessionId, allowedTool: "Write" });
  assert.deepEqual(allowed, [...args, "--allowedTools", "Write"]);
});

test("permission arguments require an explicit session UUID before native launch", () => {
  rejects(() => permissionArguments(), "PERMISSION_SESSION_ID_INVALID");
  for (const sessionId of [undefined, null, "", "session-fixture", "--continue", " 07d512a8-93e0-48c1-b747-e27672c95630"]) {
    rejects(() => permissionArguments({ sessionId }), "PERMISSION_SESSION_ID_INVALID");
  }
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

test("ordinary control finish still requires a bounded natural exit", async () => {
  const f = fixture({ exitTimeout: 1 });
  try {
    await assert.rejects(f.control.finish(), { nativeCode: "CODEBUDDY_CONTROL_EXIT_TIMEOUT" });
    assert.equal(f.control.inputEnded, true);
    assert.equal(f.control.ended, false);
  } finally { f.close(); }
});

test("interrupt finish reports natural exit without invoking owned cleanup", async () => {
  const f = fixture();
  f.close();
  assert.deepEqual(await f.control.finishAfterInterrupt(() => assert.fail("Unexpected cleanup")),
    { naturalExit: true, forcedCleanup: false });
});

test("interrupt exit timeout stops the owned child without losing native events", async () => {
  const f = fixture({ exitTimeout: 1 });
  const recovered = { type: "result", session_id: identity.sessionId, result: "Recovery fixture" };
  f.emit(recovered);
  let inputCloses = 0, cleanupCalls = 0;
  f.child.stdin.on("finish", () => { inputCloses += 1; });
  assert.deepEqual(await f.control.finishAfterInterrupt(async (child) => {
    cleanupCalls += 1;
    assert.equal(child, f.child);
    assert.equal(f.control.inputEnded, true);
    assert.equal(f.control.ended, false);
    f.close(null, "SIGKILL");
  }), { naturalExit: false, forcedCleanup: true, reason: "CODEBUDDY_CONTROL_EXIT_TIMEOUT" });
  assert.equal(f.control.ended, true);
  assert.equal(inputCloses, 1);
  assert.equal(cleanupCalls, 1);
  assert.deepEqual(f.control.events, [recovered]);
});

test("interrupt finish never tolerates a nonzero or signaled natural exit", async () => {
  for (const [code, signal] of [[7, null], [null, "SIGTERM"], [0, "SIGKILL"]]) {
    const f = fixture();
    f.close(code, signal);
    await assert.rejects(f.control.finishAfterInterrupt(() => assert.fail("Unexpected cleanup")),
      { nativeCode: "CODEBUDDY_CONTROL_PROCESS_FAILED" });
  }
});

test("a natural close racing the interrupt timeout still requires zero exit", async () => {
  for (const code of [0, 7]) {
    const f = fixture();
    const finish = f.control.finish.bind(f.control);
    f.control.finish = async () => {
      f.control.finish = finish;
      f.close(code);
      throw Object.assign(new Error("CODEBUDDY_CONTROL_EXIT_TIMEOUT"), { nativeCode: "CODEBUDDY_CONTROL_EXIT_TIMEOUT" });
    };
    const finished = f.control.finishAfterInterrupt(() => assert.fail("Unexpected cleanup"));
    if (code === 0) assert.deepEqual(await finished, { naturalExit: true, forcedCleanup: false });
    else await assert.rejects(finished, { nativeCode: "CODEBUDDY_CONTROL_PROCESS_FAILED" });
  }
});

test("interrupt finish cannot turn protocol failure on a hanging child into compatibility", async () => {
  const f = fixture({ exitTimeout: 1 });
  f.child.stdout.write("private-invalid-json-canary\n");
  try {
    await assert.rejects(f.control.finishAfterInterrupt(() => assert.fail("Unexpected cleanup")),
      { nativeCode: "CODEBUDDY_CONTROL_INVALID_JSON" });
  } finally { f.close(); }
});

test("interrupt finish checks protocol failures that arrive during cleanup", async () => {
  const f = fixture({ exitTimeout: 1 });
  await assert.rejects(f.control.finishAfterInterrupt(async () => {
    f.child.stdout.write("private-invalid-json-canary\n");
    f.close(null, "SIGKILL");
  }), { nativeCode: "CODEBUDDY_CONTROL_INVALID_JSON" });
});

test("interrupt finish propagates cleanup failure and requires an observed process close", async () => {
  for (const fails of [true, false]) {
    const f = fixture({ exitTimeout: 1 });
    try {
      await assert.rejects(f.control.finishAfterInterrupt(async () => {
        if (fails) throw Object.assign(new Error("FIXTURE_CLEANUP_FAILED"), { nativeCode: "FIXTURE_CLEANUP_FAILED" });
      }), { nativeCode: fails ? "FIXTURE_CLEANUP_FAILED" : "CODEBUDDY_CONTROL_CLEANUP_EXIT_TIMEOUT" });
      assert.equal(f.control.ended, false);
    } finally { f.close(); }
  }
});

test("interrupt finish only recognizes the exact exit-timeout diagnostic code", async () => {
  const f = fixture();
  f.control.finish = async () => { throw Object.assign(new Error("CODEBUDDY_CONTROL_EXIT_TIMEOUT"),
    { nativeCode: "CODEBUDDY_CONTROL_REQUEST_TIMEOUT" }); };
  await assert.rejects(f.control.finishAfterInterrupt(() => assert.fail("Unexpected cleanup")),
    { nativeCode: "CODEBUDDY_CONTROL_REQUEST_TIMEOUT" });
  f.close();
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

const interruptIdentity = { ...identity, answer: "Original permission answer", recoveryPrompt: "Independent recovery prompt",
  recoveryAnswer: "Independent recovery answer" };
const originalAnswer = () => ({ id: "original-answer", type: "message", role: "assistant", parentId: "tool-result",
  status: "completed", content: [{ type: "output_text", text: interruptIdentity.answer }] });
function withRecovery(original) {
  return [...original, { ...user(), id: "recovery-user", parentId: original.at(-1).id,
    content: [{ type: "input_text", text: interruptIdentity.recoveryPrompt }] },
  { id: "recovery-answer", type: "message", role: "assistant", parentId: "recovery-user", status: "completed",
    content: [{ type: "output_text", text: interruptIdentity.recoveryAnswer }] }];
}
function withLateOriginalResults(count = 2, beforeAnswer = 0) {
  const records = withRecovery([user(), call()]).map((record, index) => ({ ...record, sessionId: identity.sessionId,
    providerData: { conversationRequestId: index < 2 ? "original-request" : "recovery-request" } }));
  for (let index = 0; index < count; index += 1) {
    records.push({ ...result("incomplete"), id: `late-result-${index}`, parentId: records.at(-1).id,
      sessionId: identity.sessionId, providerData: { conversationRequestId: "original-request", skipRun: true } });
  }
  const assistant = records.splice(3, 1)[0];
  records.splice(3 + beforeAnswer, 0, assistant);
  for (let index = 3; index < records.length; index += 1) records[index].parentId = records[index - 1].id;
  return records;
}
const lateResultPlacements = [[1, 0], [1, 1], [2, 0], [2, 1], [2, 2]];
const workbuddyInterruptIdentity = { ...interruptIdentity, client: "workbuddy" };
function withWorkBuddyLateResults(count = 2, beforeAnswer = 0) {
  return withLateOriginalResults(count, beforeAnswer).map((record) => {
    if (record.role === "user" || record.type === "function_call_result") delete record.providerData.conversationRequestId;
    return record;
  });
}

test("WorkBuddy alone projects its owner-absent cancellation schema using unique native call and ordered lineage", () => {
  const expected = selectInterruptRecovery(withLateOriginalResults(0), interruptIdentity);
  for (const [count, beforeAnswer] of lateResultPlacements) {
    const records = withWorkBuddyLateResults(count, beforeAnswer), before = structuredClone(records);
    const selected = selectInterruptRecovery(records, workbuddyInterruptIdentity);
    assert.equal(selected.user.content, expected.user.content);
    assert.equal(selected.assistant.content, expected.assistant.content);
    assert.equal(selected.lateOriginalToolResultCount, count);
    assert.deepEqual(selectInterruptOutcome(records, workbuddyInterruptIdentity), {
      outcome: "incomplete", toolResultRecorded: true, lateOriginalToolResultCount: count,
    });
    assert.deepEqual(records, before);
    rejects(() => selectInterruptRecovery(records, interruptIdentity), "PERMISSION_INTERRUPT_REQUEST_OWNER_MISMATCH");
    rejects(() => selectInterruptOutcome(records, interruptIdentity), "PERMISSION_INTERRUPT_REQUEST_OWNER_MISMATCH");
  }
});

test("WorkBuddy's absent-owner compatibility rejects every present owner field and invalid call or answer owner", () => {
  for (const [count, beforeAnswer] of lateResultPlacements) {
    for (const id of ["user", "recovery-user", ...Array.from({ length: count }, (_, index) => `late-result-${index}`)]) {
      for (const key of ["conversationRequestId", "requestId"]) for (const value of [undefined, null, "", 1,
        "foreign-request", "original-request", "recovery-request"]) {
        const records = withWorkBuddyLateResults(count, beforeAnswer);
        records.find((record) => record.id === id).providerData[key] = value;
        rejects(() => selectInterruptRecovery(records, workbuddyInterruptIdentity), "PERMISSION_INTERRUPT_REQUEST_OWNER_MISMATCH");
      }
    }
    for (const id of ["tool-call", "recovery-answer"]) {
      for (const value of [undefined, null, "", 1, " padded "]) {
        const records = withWorkBuddyLateResults(count, beforeAnswer);
        records.find((record) => record.id === id).providerData.conversationRequestId = value;
        rejects(() => selectInterruptRecovery(records, workbuddyInterruptIdentity), "PERMISSION_INTERRUPT_REQUEST_OWNER_MISMATCH");
      }
      const records = withWorkBuddyLateResults(count, beforeAnswer);
      records.find((record) => record.id === id).providerData.requestId = "foreign-request";
      rejects(() => selectInterruptRecovery(records, workbuddyInterruptIdentity), "PERMISSION_INTERRUPT_REQUEST_OWNER_MISMATCH");
    }
    const records = withWorkBuddyLateResults(count, beforeAnswer);
    records.find((record) => record.id === "recovery-answer").providerData.conversationRequestId = "original-request";
    rejects(() => selectInterruptRecovery(records, workbuddyInterruptIdentity), "PERMISSION_INTERRUPT_REQUEST_OWNER_MISMATCH");
  }
});

test("WorkBuddy's call authority rejects reused call IDs, extra original content and out-of-branch content", () => {
  for (const extra of [{ ...call(), id: "other-call", parentId: undefined },
    { ...call(), id: "other-call", callId: "other-call-id", parentId: undefined },
    { ...user(), id: "prior-user", content: [{ type: "input_text", text: "Prior prompt" }] }]) {
    const records = withWorkBuddyLateResults();
    records.unshift({ ...extra, sessionId: identity.sessionId });
    rejects(() => selectInterruptRecovery(records, workbuddyInterruptIdentity), "PERMISSION_INTERRUPT_REQUEST_OWNER_MISMATCH");
  }
  const records = withWorkBuddyLateResults();
  const extra = { ...interruption(), parentId: "tool-call", sessionId: identity.sessionId,
    providerData: { conversationRequestId: "original-request" } };
  records.splice(2, 0, extra);
  records[3].parentId = extra.id;
  rejects(() => selectInterruptRecovery(records, workbuddyInterruptIdentity), "PERMISSION_INTERRUPT_REQUEST_OWNER_MISMATCH");
});

test("WorkBuddy's absent-owner projection retains exact session, tool, result and single-child chain checks", () => {
  for (const [count, beforeAnswer] of lateResultPlacements) {
    for (const id of ["user", "tool-call", "recovery-user", "recovery-answer", "late-result-0"]) {
      const records = withWorkBuddyLateResults(count, beforeAnswer);
      records.find((record) => record.id === id).sessionId = "foreign-session";
      rejects(() => selectInterruptRecovery(records, workbuddyInterruptIdentity), "NATIVE_TRANSCRIPT_SESSION_MISMATCH");
    }
    for (const patch of [{ name: "Bash" }, { callId: "foreign-call" }, { arguments: "{}" }]) {
      const records = withWorkBuddyLateResults(count, beforeAnswer);
      Object.assign(records[1], patch);
      rejects(() => selectInterruptRecovery(records, workbuddyInterruptIdentity), "PERMISSION_TRANSCRIPT_TOOL_MISMATCH");
    }
    for (const patch of [{ callId: "foreign-call" }, { name: "Bash" }, { status: "completed" }, { role: "assistant" },
      { sessionId: undefined }, { providerData: { skipRun: false } }]) {
      const records = withWorkBuddyLateResults(count, beforeAnswer);
      Object.assign(records.find((record) => record.id === "late-result-0"), patch);
      rejects(() => selectInterruptRecovery(records, workbuddyInterruptIdentity), "PERMISSION_INTERRUPT_RECOVERY_TAIL_INVALID");
    }
  }
  for (const mutate of [
    (records) => { records.at(-1).parentId = "recovery-answer"; },
    (records) => { records.at(-1).parentId = "missing-parent"; },
    (records) => { records.splice(3, 0, records.pop()); },
    (records) => { records.push({ ...records.at(-1), id: "third-result", parentId: records.at(-1).id }); },
    (records) => { records.push({ ...call(), id: "recovery-call", callId: "recovery-tool", parentId: records.at(-1).id }); },
    (records) => { records.push({ ...user(), id: "future-user", parentId: records.at(-1).id,
      content: [{ type: "input_text", text: "Future prompt" }] }); },
  ]) {
    const records = withWorkBuddyLateResults();
    mutate(records);
    rejects(() => selectInterruptRecovery(records, workbuddyInterruptIdentity), "PERMISSION_INTERRUPT_RECOVERY_TAIL_INVALID");
  }
});

test("interrupt outcome requires successful independent recovery before classifying absent or incomplete old answers", () => {
  for (const original of [[user(), call()], [user(), call(), result("incomplete")],
    [user(), call(), result("incomplete"), interruption()]]) {
    assert.deepEqual(selectInterruptOutcome(withRecovery(original), interruptIdentity), {
      outcome: "incomplete", toolResultRecorded: original.length > 2, lateOriginalToolResultCount: 0,
    });
  }
  assert.deepEqual(selectInterruptOutcome(withRecovery([user(), call(), result("incomplete"), originalAnswer()]), interruptIdentity), {
    outcome: "completed", toolResultRecorded: true, lateOriginalToolResultCount: 0,
  });
});

test("interrupt outcome rejects missing, incomplete or out-of-order recovery instead of using a transient old turn", () => {
  const original = [user(), call(), result("incomplete"), originalAnswer()];
  rejects(() => selectInterruptOutcome(original, interruptIdentity), "NATIVE_TRANSCRIPT_PROMPT_MISMATCH");
  rejects(() => selectInterruptOutcome(withRecovery(original).slice(0, -1), interruptIdentity), "NATIVE_TRANSCRIPT_FINAL_MISSING");
  const incomplete = withRecovery(original);
  incomplete.at(-1).status = "incomplete";
  rejects(() => selectInterruptOutcome(incomplete, interruptIdentity), "NATIVE_TRANSCRIPT_FINAL_INCOMPLETE");
  const recovered = withRecovery(original);
  rejects(() => selectInterruptOutcome([...recovered.slice(-2), ...original], interruptIdentity), "PERMISSION_INTERRUPT_RECOVERY_ORDER_INVALID");
  rejects(() => selectInterruptOutcome(original, { ...interruptIdentity, recoveryPrompt: identity.prompt,
    recoveryAnswer: interruptIdentity.answer }), "PERMISSION_INTERRUPT_RECOVERY_ORDER_INVALID");
});

test("interrupt recovery retains strict selection without requiring new metadata when no late results exist", () => {
  const records = withRecovery([user(), call()]);
  const selected = selectNativeTurnContent(records, { ...identity, prompt: interruptIdentity.recoveryPrompt,
    finalText: interruptIdentity.recoveryAnswer });
  assert.deepEqual(selectInterruptRecovery(records, interruptIdentity), { ...selected, lateOriginalToolResultCount: 0 });
});

test("interrupt recovery projects only proven original-owned late cancellation results without mutating native records", () => {
  for (const count of [1, 2]) {
    const records = withLateOriginalResults(count), original = structuredClone(records);
    const expected = selectInterruptRecovery(records.slice(0, 4), interruptIdentity);
    assert.deepEqual(selectInterruptRecovery(records, interruptIdentity), { ...expected, lateOriginalToolResultCount: count });
    assert.deepEqual(selectInterruptOutcome(records, interruptIdentity), {
      outcome: "incomplete", toolResultRecorded: true, lateOriginalToolResultCount: count,
    });
    assert.deepEqual(records, original);
    rejects(() => selectNativeTurnContent(records, { ...identity, prompt: interruptIdentity.recoveryPrompt,
      finalText: interruptIdentity.recoveryAnswer }), "NATIVE_TRANSCRIPT_FINAL_INCOMPLETE");
  }
});

test("interrupt recovery requires distinct matching request owners on both prompts, original call and recovery answer", () => {
  for (const [count, beforeAnswer] of lateResultPlacements) {
    for (const id of ["user", "tool-call", "recovery-user", "recovery-answer"]) {
      for (const owner of [undefined, null, "", "foreign-request"]) {
        const records = withLateOriginalResults(count, beforeAnswer);
        records.find((record) => record.id === id).providerData = owner === undefined ? undefined : { conversationRequestId: owner };
        rejects(() => selectInterruptRecovery(records, interruptIdentity), "PERMISSION_INTERRUPT_REQUEST_OWNER_MISMATCH");
      }
    }
    const records = withLateOriginalResults(count, beforeAnswer);
    for (const record of records) record.providerData.conversationRequestId = "same-request";
    rejects(() => selectInterruptRecovery(records, interruptIdentity), "PERMISSION_INTERRUPT_REQUEST_OWNER_MISMATCH");
  }
});

test("interrupt owner diagnostics distinguish absent prompt owners from nonprompt authority conflicts", () => {
  const records = withLateOriginalResults(2);
  for (const record of records) {
    record.providerData.conversationRequestId = record.providerData.conversationRequestId === "original-request"
      ? "private-original-owner" : "private-recovery-owner";
  }
  for (const id of ["user", "recovery-user"]) delete records.find((record) => record.id === id).providerData.conversationRequestId;
  records[0].providerData.requestId = "private-alias";
  const before = structuredClone(records);
  assert.throws(() => selectInterruptRecovery(records, interruptIdentity), (error) => {
    assert.equal(error.nativeCode, "PERMISSION_INTERRUPT_REQUEST_OWNER_MISMATCH");
    const diagnostic = error.interruptRecoveryDiagnostic;
    assert.equal(diagnostic.clause, "request_owner");
    assert.equal(diagnostic.originalPrompt.ownerPresent, false);
    assert.equal(diagnostic.originalPrompt.ownerFieldPresent, false);
    assert.equal(diagnostic.originalPrompt.requestIdAliasPresent, true);
    assert.equal(diagnostic.originalPrompt.requestIdAliasFieldPresent, true);
    assert.equal(diagnostic.recoveryPrompt.ownerPresent, false);
    assert.equal(diagnostic.originalTool.ownerPresent, true);
    assert.equal(diagnostic.recoveryAnswer.ownerPresent, true);
    assert.equal(diagnostic.toolAndAnswerOwnersDistinct, true);
    assert.equal(diagnostic.originalNonPromptCount, diagnostic.originalNonPromptOwnerMatches);
    assert.equal(diagnostic.lateOriginalResultCount, diagnostic.lateOriginalResultOwnerMatches);
    assert.equal(diagnostic.lateOriginalResults.length, 2);
    for (const result of diagnostic.lateOriginalResults) assert.deepEqual(result, {
      sessionMatches: true, ownerFieldPresent: true, ownerPresent: true,
      requestIdAliasFieldPresent: false, requestIdAliasPresent: false,
      matchesOriginalToolOwner: true, matchesRecoveryAnswerOwner: false,
      functionCallResult: true, roleAbsent: true, callIdMatches: true, toolNameMatches: true,
      incomplete: true, skipRun: true,
    });
    assert.equal(JSON.stringify(diagnostic).includes("private"), false);
    assert.equal(JSON.stringify(diagnostic).includes("Synthetic"), false);
    return true;
  });
  assert.deepEqual(records, before);
  const lateResults = records.filter((record) => record.type === "function_call_result");
  delete lateResults[0].providerData.conversationRequestId;
  lateResults[1].providerData.conversationRequestId = "private-conflicting-owner";
  assert.throws(() => selectInterruptRecovery(records, interruptIdentity), (error) => {
    const diagnostic = error.interruptRecoveryDiagnostic;
    assert.equal(error.nativeCode, "PERMISSION_INTERRUPT_REQUEST_OWNER_MISMATCH");
    assert.equal(diagnostic.lateOriginalResults[0].ownerFieldPresent, false);
    assert.equal(diagnostic.lateOriginalResults[0].ownerPresent, false);
    assert.equal(diagnostic.lateOriginalResults[1].ownerFieldPresent, true);
    assert.equal(diagnostic.lateOriginalResults[1].ownerPresent, true);
    assert.ok(diagnostic.lateOriginalResults.every((result) => !result.matchesOriginalToolOwner && !result.matchesRecoveryAnswerOwner));
    assert.equal(JSON.stringify(diagnostic).includes("private"), false);
    return true;
  });
  records.find((record) => record.id === "tool-call").providerData.conversationRequestId = "";
  assert.throws(() => selectInterruptRecovery(records, interruptIdentity), (error) => {
    const diagnostic = error.interruptRecoveryDiagnostic;
    assert.equal(error.nativeCode, "PERMISSION_INTERRUPT_REQUEST_OWNER_MISMATCH");
    assert.equal(diagnostic.originalTool.ownerPresent, false);
    assert.equal(diagnostic.toolAndAnswerOwnersDistinct, false);
    assert.equal(diagnostic.originalNonPromptOwnerMatches, 0);
    assert.equal(diagnostic.lateOriginalResultOwnerMatches, 0);
    return true;
  });
});

test("interrupt recovery requires explicit matching sessions on original and recovery request records in every placement", () => {
  for (const [count, beforeAnswer] of lateResultPlacements) {
    for (const id of ["user", "tool-call", "recovery-user", "recovery-answer"]) {
      const missingSessionCode = id === "user" ? "PERMISSION_TRANSCRIPT_PROMPT_MISMATCH"
        : id === "recovery-user" ? "NATIVE_TRANSCRIPT_SESSION_MISMATCH" : "PERMISSION_INTERRUPT_REQUEST_OWNER_MISMATCH";
      for (const [sessionId, code] of [[undefined, missingSessionCode],
        ["foreign-session", "NATIVE_TRANSCRIPT_SESSION_MISMATCH"]]) {
        const records = withLateOriginalResults(count, beforeAnswer);
        records.find((record) => record.id === id).sessionId = sessionId;
        rejects(() => selectInterruptRecovery(records, interruptIdentity), code);
      }
    }
  }
});

test("interrupt recovery also validates any original assistant owner before projecting its late results", () => {
  const records = withLateOriginalResults(1);
  const interrupted = { ...interruption(), parentId: "tool-call", sessionId: identity.sessionId,
    providerData: { conversationRequestId: "original-request" } };
  records.splice(2, 0, interrupted);
  records[3].parentId = interrupted.id;
  assert.equal(selectInterruptRecovery(records, interruptIdentity).lateOriginalToolResultCount, 1);
  interrupted.providerData.conversationRequestId = "recovery-request";
  rejects(() => selectInterruptRecovery(records, interruptIdentity), "PERMISSION_INTERRUPT_REQUEST_OWNER_MISMATCH");
});

test("interrupt recovery rejects missing or foreign late-result authority, wrong tools and successful results", () => {
  for (const [count, beforeAnswer] of lateResultPlacements) for (let index = 0; index < count; index += 1) {
    for (const patch of [{ callId: "foreign-call" }, { name: "Bash" }, { status: "completed" }, { status: undefined },
      { role: "assistant" }, { sessionId: undefined }, { providerData: undefined },
      { providerData: { skipRun: true } }, { providerData: { conversationRequestId: "recovery-request", skipRun: true } },
      { providerData: { conversationRequestId: "foreign-request", skipRun: true } },
      { providerData: { conversationRequestId: "original-request" } },
      { providerData: { conversationRequestId: "original-request", skipRun: false } }]) {
      const records = withLateOriginalResults(count, beforeAnswer);
      Object.assign(records.find((record) => record.id === `late-result-${index}`), patch);
      rejects(() => selectInterruptRecovery(records, interruptIdentity), "PERMISSION_INTERRUPT_RECOVERY_TAIL_INVALID");
    }
    const foreignSession = withLateOriginalResults(count, beforeAnswer);
    foreignSession.find((record) => record.id === `late-result-${index}`).sessionId = "foreign-session";
    rejects(() => selectInterruptRecovery(foreignSession, interruptIdentity), "NATIVE_TRANSCRIPT_SESSION_MISMATCH");
  }
});

test("interrupt recovery still requires the exact original tool call and complete recovery text", () => {
  for (const patch of [{ name: "Bash" }, { callId: "foreign-call" }, { arguments: "{}" }]) {
    const records = withLateOriginalResults();
    Object.assign(records[1], patch);
    rejects(() => selectInterruptRecovery(records, interruptIdentity), "PERMISSION_TRANSCRIPT_TOOL_MISMATCH");
  }
  const records = withLateOriginalResults();
  records[3].content[0].text = "Different recovery answer";
  rejects(() => selectInterruptRecovery(records, interruptIdentity), "NATIVE_TRANSCRIPT_ANSWER_MISMATCH");
  records[3].status = "incomplete";
  rejects(() => selectInterruptRecovery(records, interruptIdentity), "NATIVE_TRANSCRIPT_FINAL_INCOMPLETE");
});

test("interrupt recovery rejects ambiguous, cyclic, reordered, orphaned or excessive late-result chains", () => {
  for (const [mutate, code] of [
    [(records) => { records.at(-1).id = records.at(-2).id; }, "NATIVE_TRANSCRIPT_ID_INVALID"],
    [(records) => { delete records.at(-1).id; }, "NATIVE_TRANSCRIPT_ID_INVALID"],
    [(records) => { records[4].parentId = records[5].id; }, "PERMISSION_INTERRUPT_RECOVERY_TAIL_INVALID"],
    [(records) => { records[4].parentId = "missing-parent"; }, "PERMISSION_INTERRUPT_RECOVERY_TAIL_INVALID"],
    [(records) => { records[4].parentId = "tool-call"; }, "PERMISSION_TRANSCRIPT_RESULT_COUNT_MISMATCH"],
    [(records) => { records[5].parentId = records[3].id; }, "PERMISSION_INTERRUPT_RECOVERY_TAIL_INVALID"],
    [(records) => { records.splice(3, 0, records.pop()); }, "PERMISSION_INTERRUPT_RECOVERY_TAIL_INVALID"],
    [(records) => { records.push({ ...records.at(-1), id: "third-late-result", parentId: records.at(-1).id }); },
      "PERMISSION_INTERRUPT_RECOVERY_TAIL_INVALID"],
  ]) {
    const records = withLateOriginalResults();
    mutate(records);
    rejects(() => selectInterruptRecovery(records, interruptIdentity), code);
  }
});

test("interrupt recovery rejects malformed cancellation chains before and across the recovery answer", () => {
  for (const beforeAnswer of [1, 2]) for (const [mutate, code] of [
    [(records) => { records.find((record) => record.id === "late-result-0").parentId = "missing-parent"; },
      "NATIVE_TRANSCRIPT_FINAL_MISSING"],
    [(records) => { records.find((record) => record.id === "recovery-answer").parentId = "recovery-user"; },
      "PERMISSION_INTERRUPT_RECOVERY_TAIL_INVALID"],
    [(records) => { records.find((record) => record.id === "late-result-1").parentId = "recovery-user"; },
      "PERMISSION_INTERRUPT_RECOVERY_TAIL_INVALID"],
    [(records) => { records.splice(3, 0, records.pop()); }, "PERMISSION_INTERRUPT_RECOVERY_TAIL_INVALID"],
    [(records) => { records.push({ ...records.find((record) => record.id === "late-result-1"), id: "third-result",
      parentId: records.at(-1).id }); }, "PERMISSION_INTERRUPT_RECOVERY_TAIL_INVALID"],
    [(records) => { records.push({ ...call(), id: "recovery-call", callId: "recovery-tool", parentId: records.at(-1).id }); },
      "PERMISSION_INTERRUPT_RECOVERY_TAIL_INVALID"],
    [(records) => { records.push({ ...user(), id: "future-user", parentId: records.at(-1).id,
      content: [{ type: "input_text", text: "Future prompt" }] }); }, "PERMISSION_INTERRUPT_RECOVERY_TAIL_INVALID"],
  ]) {
    const records = withLateOriginalResults(2, beforeAnswer);
    mutate(records);
    rejects(() => selectInterruptRecovery(records, interruptIdentity), code);
  }
  const split = withLateOriginalResults(2, 1);
  split.find((record) => record.id === "late-result-1").parentId = "late-result-0";
  rejects(() => selectInterruptRecovery(split, interruptIdentity), "PERMISSION_INTERRUPT_RECOVERY_TAIL_INVALID");
});

test("interrupt recovery rejects same-call results appended to the original branch after recovery begins", () => {
  for (const [count, beforeAnswer] of lateResultPlacements) {
    const records = withLateOriginalResults(count, beforeAnswer);
    records.push({ ...records.find((record) => record.id === "late-result-0"), id: "original-late-result", parentId: "tool-call" });
    rejects(() => selectInterruptRecovery(records, interruptIdentity), "PERMISSION_INTERRUPT_RECOVERY_TAIL_INVALID");
  }
});

test("interrupt recovery cannot hide actual recovery activity or a late result across a future-user boundary", () => {
  for (const [extra, code] of [
    [{ ...call(), id: "recovery-call", callId: "recovery-tool", parentId: "recovery-answer" }, "PERMISSION_INTERRUPT_RECOVERY_TAIL_INVALID"],
    [{ ...originalAnswer(), id: "extra-answer", parentId: "recovery-answer" }, "NATIVE_TRANSCRIPT_FINAL_AMBIGUOUS"],
    [{ ...user(), id: "future-user", parentId: "recovery-answer", content: [{ type: "input_text", text: "Future prompt" }] },
      "PERMISSION_INTERRUPT_RECOVERY_TAIL_INVALID"],
  ]) {
    const records = withLateOriginalResults(1);
    records.push(extra);
    rejects(() => selectInterruptRecovery(records, interruptIdentity), code);
  }
  const records = withLateOriginalResults(1);
  const future = { ...user(), id: "future-user", parentId: "recovery-answer", content: [{ type: "input_text", text: "Future prompt" }] };
  records.splice(4, 0, future);
  records[5].parentId = future.id;
  rejects(() => selectInterruptRecovery(records, interruptIdentity), "PERMISSION_INTERRUPT_RECOVERY_TAIL_INVALID");
});

test("interrupt recovery rejects orphaned and self-cyclic content outside either validated branch regardless of owner", () => {
  for (const providerData of [undefined, { conversationRequestId: "foreign-request" },
    { conversationRequestId: "recovery-request" }, { conversationRequestId: "original-request" }]) {
    for (const extra of [
      { ...call(), id: "extra-call", callId: "extra-tool", status: "incomplete" },
      { ...result("incomplete"), id: "extra-result", callId: "extra-tool" },
      { ...originalAnswer(), id: "extra-answer" },
    ]) for (const parentId of ["missing-parent", extra.id]) {
      const records = withLateOriginalResults();
      records.push({ ...extra, parentId, sessionId: identity.sessionId, providerData });
      rejects(() => selectInterruptRecovery(records, interruptIdentity), "PERMISSION_INTERRUPT_RECOVERY_TAIL_INVALID");
      rejects(() => selectInterruptOutcome(records, interruptIdentity), "PERMISSION_INTERRUPT_RECOVERY_TAIL_INVALID");
    }
  }
});

test("interrupt recovery leaves ID-less non-content context records intact", () => {
  const records = withLateOriginalResults();
  records.splice(2, 0, { type: "context", sessionId: identity.sessionId });
  records.push({ type: "context", sessionId: identity.sessionId });
  const original = structuredClone(records);
  assert.equal(selectInterruptRecovery(records, interruptIdentity).lateOriginalToolResultCount, 2);
  assert.deepEqual(records, original);
});

function recoveryDiagnostic(records, expected = interruptIdentity) {
  let diagnostic;
  assert.throws(() => selectInterruptRecovery(records, expected), (error) => {
    assert.equal(error.nativeCode, "PERMISSION_INTERRUPT_RECOVERY_TAIL_INVALID");
    assert.equal(error.message, error.nativeCode);
    diagnostic = error.interruptRecoveryDiagnostic;
    return true;
  });
  return diagnostic;
}

test("interrupt recovery diagnostics distinguish every unchanged tail assertion", () => {
  const cases = [
    ["branch_coverage", (records) => records.push({ ...result("incomplete"), id: "orphan-result", parentId: "missing-parent" })],
    ["tail_shape", (records) => { records.push({ ...records.at(-1), id: "third-result", parentId: records.at(-1).id }); }],
    ["tail_member", (records) => { records.at(-1).status = "completed"; }],
    ["single_child", (records) => { records.at(-1).parentId = "recovery-answer"; }],
    ["terminal_leaf", (records) => records.unshift({ ...user(), id: "other-user", parentId: records.at(-1).id,
      content: [{ type: "input_text", text: "Other prompt" }] })],
  ];
  for (const [clause, mutate] of cases) {
    const records = withLateOriginalResults();
    mutate(records);
    const original = structuredClone(records), diagnostic = recoveryDiagnostic(records);
    assert.equal(diagnostic.clause, clause);
    assert.equal(diagnostic.recordCount, records.length);
    assert.equal(diagnostic.originalBranchCount, 2);
    assert.equal(diagnostic.assistantParentIsRecoveryUser, true);
    assert.deepEqual(records, original);
    if (clause === "branch_coverage") assert.equal(diagnostic.unselectedContentCount, 1);
    if (clause === "tail_shape") assert.equal(diagnostic.tailCount, 3);
    if (clause === "tail_member") assert.equal(diagnostic.member.statusIncomplete, false);
    if (clause === "single_child") assert.equal(diagnostic.member.childCount, 2);
    if (clause === "terminal_leaf") assert.equal(diagnostic.parentChildCount, 1);
  }
});

test("interrupt recovery projects proven original results before or straddling the recovery answer without mutation", () => {
  const expected = selectInterruptRecovery(withLateOriginalResults(0), interruptIdentity);
  for (const [count, beforeAnswer] of [[2, 1], [1, 1], [2, 2]]) {
    const records = withLateOriginalResults(count, beforeAnswer), original = structuredClone(records);
    assert.deepEqual(selectInterruptRecovery(records, interruptIdentity), { ...expected, lateOriginalToolResultCount: count });
    assert.deepEqual(selectInterruptOutcome(records, interruptIdentity), {
      outcome: "incomplete", toolResultRecorded: true, lateOriginalToolResultCount: count,
    });
    assert.deepEqual(records, original);
  }
});

test("interrupt recovery member diagnostics identify field mismatches without leaking native values", () => {
  for (const [field, patch] of [
    ["roleAbsent", { role: "private-role-canary" }], ["toolNameMatches", { name: "private-tool-canary" }],
    ["statusIncomplete", { status: "private-status-canary" }], ["sessionMatches", { sessionId: undefined }],
    ["skipRun", { providerData: { conversationRequestId: "original-request", skipRun: "private-skip-canary" } }],
    ["ownerMatches", { providerData: { conversationRequestId: "private-owner-canary", skipRun: true } }],
  ]) {
    const records = withLateOriginalResults(1);
    Object.assign(records.at(-1), patch, { id: "private-record-id-canary", output: { type: "text", text: "private-result-canary" },
      path: "/private/path-canary", extra: "private-extra-canary" });
    const original = structuredClone(records), diagnostic = recoveryDiagnostic(records);
    assert.equal(diagnostic.clause, "tail_member");
    assert.equal(diagnostic.member[field], false);
    assert.equal(JSON.stringify(diagnostic).includes("canary"), false);
    assert.equal(Object.entries(diagnostic.member).every(([key, value]) => key === "ownerFields"
      || typeof value === "boolean" || Number.isSafeInteger(value)), true);
    assert.deepEqual(records, original);
  }
});

test("tail owner diagnostics expose only field existence, fixed types and native owner equality", () => {
  for (const key of ["conversationRequestId", "requestId"]) for (const [present, value, type, expectedOwner] of [
    [false, undefined, "undefined"], [true, undefined, "undefined"], [true, null, "null"], [true, "", "string"],
    [true, "private-original-canary", "string", "original"], [true, "private-recovery-canary", "string", "recovery"],
    [true, "private-foreign-canary", "string"], [true, 12, "number"], [true, false, "boolean"],
    [true, { private: "private-object-canary" }, "object"], [true, ["private-array-canary"], "array"],
  ]) {
    const records = withLateOriginalResults(1);
    for (const record of records) record.providerData.conversationRequestId = record.providerData.conversationRequestId === "original-request"
      ? "private-original-canary" : "private-recovery-canary";
    const late = records.at(-1);
    late.status = "completed";
    if (present) late.providerData[key] = value;
    else delete late.providerData[key];
    const before = structuredClone(records);
    const diagnostic = recoveryDiagnostic(records);
    assert.equal(diagnostic.clause, "tail_member");
    assert.deepEqual(diagnostic.member.ownerFields[key], { present, type,
      matchesOriginalPrompt: expectedOwner === "original", matchesOriginalTool: expectedOwner === "original",
      matchesRecoveryPrompt: expectedOwner === "recovery", matchesRecoveryAnswer: expectedOwner === "recovery" });
    assert.deepEqual(Object.keys(diagnostic.member.ownerFields), ["conversationRequestId", "requestId"]);
    for (const summary of Object.values(diagnostic.member.ownerFields)) {
      assert.ok(Object.entries(summary).every(([name, item]) => name === "type"
        ? ["undefined", "null", "array", "object", "string", "number", "boolean"].includes(item) : typeof item === "boolean"));
    }
    assert.equal(JSON.stringify(diagnostic).includes("canary"), false);
    assert.deepEqual(records, before);
  }
});

test("interrupt recovery adds no diagnostics to successful results or unrelated native failures", () => {
  for (const records of [withRecovery([user(), call()]), withLateOriginalResults(1), withLateOriginalResults(2)]) {
    assert.equal(Object.hasOwn(selectInterruptRecovery(records, interruptIdentity), "interruptRecoveryDiagnostic"), false);
    records.find((record) => record.id === "recovery-answer").status = "incomplete";
    assert.throws(() => selectInterruptRecovery(records, interruptIdentity), (error) => {
      assert.equal(error.nativeCode, "NATIVE_TRANSCRIPT_FINAL_INCOMPLETE");
      assert.equal(Object.hasOwn(error, "interruptRecoveryDiagnostic"), false);
      return true;
    });
  }
});

test("interrupt outcome rejects foreign identity, mismatched answers, ambiguous completion and wrong native tool", () => {
  for (const [mutate, code] of [
    [(records) => { records[0].sessionId = "foreign"; }, "NATIVE_TRANSCRIPT_SESSION_MISMATCH"],
    [(records) => { records.at(-2).sessionId = "foreign"; }, "NATIVE_TRANSCRIPT_SESSION_MISMATCH"],
    [(records) => { records[3].content[0].text = "Wrong original answer"; }, "NATIVE_TRANSCRIPT_ANSWER_MISMATCH"],
    [(records) => { records.at(-1).content[0].text = "Wrong recovery answer"; }, "NATIVE_TRANSCRIPT_ANSWER_MISMATCH"],
    [(records) => { records.push({ ...originalAnswer(), id: "second-answer" }); }, "NATIVE_TRANSCRIPT_FINAL_AMBIGUOUS"],
    [(records) => { records[1].callId = "foreign-call"; }, "PERMISSION_TRANSCRIPT_TOOL_MISMATCH"],
    [(records) => { records[1].name = "Bash"; }, "PERMISSION_TRANSCRIPT_TOOL_MISMATCH"],
    [(records) => { records[1].arguments = JSON.stringify({ ...tool.input, content: "other" }); }, "PERMISSION_TRANSCRIPT_TOOL_MISMATCH"],
  ]) {
    const records = withRecovery([user(), call(), result("incomplete"), originalAnswer()]);
    mutate(records);
    rejects(() => selectInterruptOutcome(records, interruptIdentity), code);
  }
});

test("permission model routing uses the last user prompt and requires recovery to have been sent", () => {
  const original = { role: "user", content: identity.prompt };
  const recovery = { role: "user", content: [{ type: "text", text: interruptIdentity.recoveryPrompt }] };
  const options = { prompt: identity.prompt, recoveryPrompt: interruptIdentity.recoveryPrompt, recoverySent: false };
  for (const [prompt, expected] of [[identity.prompt, "original"], [interruptIdentity.recoveryPrompt, "recovery"]]) {
    const wrapped = `<system-reminder>Fixture context</system-reminder><user_query>\n${prompt}\n</user_query>`;
    for (const content of [prompt, [{ type: "text", text: prompt }], wrapped, [{ type: "text", text: wrapped }]]) {
      assert.equal(permissionModelTurn({ messages: [{ role: "user", content }] }, { ...options, recoverySent: true }), expected);
    }
  }
  assert.equal(permissionModelTurn({ messages: [original, { role: "assistant", content: interruptIdentity.recoveryPrompt },
    { role: "tool", tool_call_id: tool.id, content: "Fixture result" }] }, options), "original");
  rejects(() => permissionModelTurn({ messages: [original, recovery] }, options), "PERMISSION_RECOVERY_MODEL_REQUEST_BEFORE_PROMPT");
  assert.equal(permissionModelTurn({ messages: [original, recovery] }, { ...options, recoverySent: true }), "recovery");
  assert.equal(permissionModelTurn({ messages: [original] }, { ...options, recoverySent: true }), "original");
  assert.equal(permissionModelTurn({ messages: [recovery, original] }, { ...options, recoverySent: true }), "original");
  for (const messages of [undefined, [], [{ role: "assistant", content: identity.prompt }],
    [original, { role: "user", content: "Unrelated latest prompt" }]]) {
    rejects(() => permissionModelTurn({ messages }, options), "PERMISSION_MODEL_PROMPT_MISMATCH");
  }
  for (const content of [`Prefix ${identity.prompt}`, `${identity.prompt} suffix`, `Prefix ${interruptIdentity.recoveryPrompt}`,
    undefined, null, { text: identity.prompt }, [{ type: "input_text", text: identity.prompt }],
    [{ type: "text", text: identity.prompt }, { type: "image_url", image_url: { url: "fixture" } }],
    `<user_query>${identity.prompt}`, `<user_query>${identity.prompt}</user_query><user_query>Other</user_query>`]) {
    rejects(() => permissionModelTurn({ messages: [original, { role: "user", content }] }, { ...options, recoverySent: true }),
      "PERMISSION_MODEL_PROMPT_MISMATCH");
  }
});

test("permission writeback audit requires exactly one matching Add for each completed turn", () => {
  const original = { prompt: identity.prompt, answer: interruptIdentity.answer };
  const recovery = { prompt: interruptIdentity.recoveryPrompt, answer: interruptIdentity.recoveryAnswer };
  const add = (turn) => ({ path: "/v1/memories/add", body: { session_id: identity.sessionId,
    messages: [{ role: "user", content: turn.prompt }, { role: "assistant", content: turn.answer }] } });
  assertPermissionWritebacks([add(recovery)], { sessionId: identity.sessionId, turns: [recovery] });
  assertPermissionWritebacks([add(original), add(recovery)], { sessionId: identity.sessionId, turns: [original, recovery] });
  for (const [requests, turns, code] of [
    [[add(original), add(recovery)], [recovery], "PERMISSION_LATE_OR_MISSING_WRITEBACK"],
    [[], [recovery], "PERMISSION_LATE_OR_MISSING_WRITEBACK"],
    [[add(original)], [original, recovery], "PERMISSION_LATE_OR_MISSING_WRITEBACK"],
    [[add(original), add(original)], [original, recovery], "PERMISSION_TURN_WRITEBACK_COUNT_MISMATCH"],
    [[add({ ...recovery, prompt: "Wrong prompt" })], [recovery], "PERMISSION_TURN_WRITEBACK_COUNT_MISMATCH"],
    [[add({ ...recovery, answer: "Wrong answer" })], [recovery], "PERMISSION_TURN_WRITEBACK_COUNT_MISMATCH"],
    [[{ ...add(recovery), body: { ...add(recovery).body, session_id: "foreign" } }], [recovery], "PERMISSION_LATE_OR_MISSING_WRITEBACK"],
    [[{ ...add(recovery), path: "/v1/memories/search" }], [recovery], "PERMISSION_LATE_OR_MISSING_WRITEBACK"],
  ]) {
    rejects(() => assertPermissionWritebacks(requests, { sessionId: identity.sessionId, turns }), code);
  }
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
