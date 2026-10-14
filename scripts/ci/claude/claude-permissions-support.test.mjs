import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { ClaudeControlSession, inflightScript, permissionArguments, selectInterruptedTurn, summarizePermissionToolResult } from "./claude-permissions-support.mjs";

function fixture(options) {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  const session = new ClaudeControlSession(child, options);
  return { child, session, emit: (event) => child.stdout.write(`${JSON.stringify(event)}\n`) };
}
function permission() {
  return { type: "control_request", request_id: "native-approval", request: { subtype: "can_use_tool", tool_name: "Write",
    tool_use_id: "native-call", input: { file_path: "isolated-marker.txt", content: "fixture" } } };
}
function transcript() {
  const identity = { sessionId: "native-session", userType: "external", isSidechain: false, promptId: "native-prompt" };
  const call = { type: "tool_use", id: "native-call", name: "Write", input: { file_path: "marker.txt", content: "fixture" } };
  return {
    input: { sessionId: identity.sessionId, interruptionUuid: "interrupt", prompt: "Try the isolated tool.", toolCall: call },
    records: [
      { ...identity, uuid: "user", parentUuid: null, type: "user", message: { role: "user", content: "Try the isolated tool." } },
      { ...identity, uuid: "assistant", parentUuid: "user", type: "assistant", message: { role: "assistant", content: [call], stop_reason: "tool_use" } },
      { ...identity, uuid: "result", parentUuid: "assistant", type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: call.id, is_error: true, content: "Interrupted" }] } },
      { ...identity, uuid: "attachment", parentUuid: "result", type: "attachment", attachment: {} },
      { ...identity, uuid: "interrupt", parentUuid: "attachment", type: "user", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user for tool use]" }] } },
    ],
  };
}

test("permission process keeps strict isolated client routing and only explicitly preallows a fixture tool", () => {
  const args = permissionArguments();
  for (const flag of ["--input-format", "--output-format", "--model", "--permission-prompt-tool", "--setting-sources", "--strict-mcp-config"])
    assert.ok(args.includes(flag));
  assert.equal(args[args.indexOf("--permission-mode") + 1], "default");
  assert.ok(!args.includes("--allowedTools") && !args.includes("--dangerously-skip-permissions"));
  assert.deepEqual(permissionArguments({ allowedTool: "Write" }).slice(-2), ["--allowedTools", "Write"]);
});

for (const [platform, root, expectedRoot] of [
  ["win32", "C:\\ci\\fixture space '$`\\tick\\user-inflight", "C:/ci/fixture space '$`/tick/user-inflight"],
  ["linux", String.raw`/tmp/fixture space '$\tick/user-inflight`, String.raw`/tmp/fixture space '$\tick/user-inflight`],
  ["darwin", "/tmp/fixture space '$`tick/user-inflight", "/tmp/fixture space '$`tick/user-inflight"],
]) test(`inflight script preserves fixture effects with portable ${platform} paths`, () => {
  const marker = "fixture ' \" $ ` \\user\nmarker", pid = 123;
  const writes = [], timers = [];
  const script = inflightScript({ startedPath: `${root}-started.json`, markerPath: `${root}.txt`, marker }, platform);
  runInNewContext(script, {
    require(name) {
      assert.equal(name, "node:fs");
      return { writeFileSync: (...args) => writes.push(["write", ...args]), renameSync: (...args) => writes.push(["rename", ...args]) };
    },
    process: { pid },
    setTimeout: (callback, ms) => timers.push({ callback, ms }),
  }, { timeout: 1000 });
  assert.deepEqual(writes, [
    ["write", `${expectedRoot}-started.json.tmp`, JSON.stringify({ pid, marker })],
    ["rename", `${expectedRoot}-started.json.tmp`, `${expectedRoot}-started.json`],
  ]);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 60_000);
  timers[0].callback();
  assert.deepEqual(writes[2], ["write", `${expectedRoot}.txt`, marker]);
  assert.equal(writes.length, 3);
});

test("tool failure diagnostics retain only fixed error signatures and a leading exit code", () => {
  const content = "Exit code 1\r\nC:\\private\\fixture.js\nSyntaxError: Invalid Unicode escape sequence\nsecret-token";
  assert.deepEqual(summarizePermissionToolResult({ is_error: true, content }), {
    isError: true, contentSupported: true, textBytes: Buffer.byteLength(content), exitCode: 1,
    signatures: ["syntax_error", "invalid_unicode_escape"],
  });
  const output = JSON.stringify(summarizePermissionToolResult({ is_error: true, content,
    command: "private command", toJSON() { throw new Error("Must not serialize native result"); } }));
  for (const value of ["private", "fixture.js", "secret-token", "command"]) assert.ok(!output.includes(value));
});

test("tool failure diagnostics handle native text blocks without treating unknown values as success", () => {
  assert.deepEqual(summarizePermissionToolResult({ content: [{ type: "text", text: "Exit code 127\nbash: node: command not found\n" }] }), {
    isError: null, contentSupported: true, textBytes: 44, exitCode: 127, signatures: ["command_not_found"],
  });
  assert.deepEqual(summarizePermissionToolResult({ is_error: false, content: "unclassified failure" }), {
    isError: false, contentSupported: true, textBytes: 20, exitCode: null, signatures: [],
  });
  for (const content of [undefined, null, {}, [{ type: "image", source: "private" }]]) {
    assert.deepEqual(summarizePermissionToolResult({ content }), {
      isError: null, contentSupported: false, textBytes: 0, exitCode: null, signatures: [],
    });
  }
});

test("tool failure diagnostics reject embedded, malformed and out-of-range exit codes", () => {
  for (const content of ["private output\nExit code 1", "Exit code -1", "Exit code 256", "Exit code 1000",
    "Exit code 01", "Exit code 1.5", "Exit code 1 private", "Exit code NaN"]) {
    assert.equal(summarizePermissionToolResult({ content }).exitCode, null);
  }
  assert.equal(summarizePermissionToolResult({ content: "Exit code 0" }).exitCode, 0);
  assert.equal(summarizePermissionToolResult({ content: "Exit code 255\n" }).exitCode, 255);
});

test("control protocol correlates requests and responses while preserving split UTF-8 events", async () => {
  const { child, session, emit } = fixture();
  const initialized = session.request({ subtype: "initialize", hooks: null });
  const request = JSON.parse(child.stdin.read().toString());
  emit({ type: "control_response", response: { subtype: "success", request_id: request.request_id, response: { current_permission_mode: "default" } } });
  assert.deepEqual(await initialized, { current_permission_mode: "default" });
  const bytes = Buffer.from(`${JSON.stringify({ type: "assistant", text: "caf\u00e9" })}\n`);
  const split = bytes.indexOf(Buffer.from("\u00e9")) + 1;
  child.stdout.write(bytes.subarray(0, split));
  child.stdout.write(bytes.subarray(split));
  assert.equal((await session.wait((event) => event.type === "assistant")).text, "caf\u00e9");
  emit(permission());
  const approval = await session.wait((event) => event.type === "control_request");
  session.respond(approval, { behavior: "allow", updatedInput: approval.request.input });
  assert.equal(JSON.parse(child.stdin.read().toString()).response.request_id, approval.request_id);
  assert.throws(() => session.respond(approval, { behavior: "allow" }), { nativeCode: "CLAUDE_CONTROL_PERMISSION_NOT_PENDING" });
  session.endInput();
  assert.throws(() => session.prompt("late"), { nativeCode: "CLAUDE_CONTROL_IS_CLOSED" });
});

test("control cancellation consumes exactly the pending native request", async () => {
  const { session, emit } = fixture();
  emit(permission());
  emit({ type: "control_cancel_request", request_id: "native-approval" });
  assert.equal(session.permissions.get("native-approval").status, "canceled");
  assert.throws(() => session.respond(session.events[0], { behavior: "allow" }), { nativeCode: "CLAUDE_CONTROL_PERMISSION_NOT_PENDING" });
  emit({ type: "control_cancel_request", request_id: "unrelated" });
  await assert.rejects(session.wait(() => true), { nativeCode: "CLAUDE_CONTROL_CANCEL_ID_MISMATCH" });
});

for (const [name, value, expected] of [
  ["malformed JSON", "{private secret\n", "CLAUDE_CONTROL_INVALID_JSON"],
  ["primitive JSON", "null\n", "CLAUDE_CONTROL_INVALID_EVENT"],
  ["unmatched response", `${JSON.stringify({ type: "control_response", response: { request_id: "foreign", subtype: "success" } })}\n`, "CLAUDE_CONTROL_RESPONSE_ID_MISMATCH"],
  ["malformed permission", `${JSON.stringify({ type: "control_request", request_id: "id", request: { subtype: "can_use_tool", input: null } })}\n`, "CLAUDE_CONTROL_PERMISSION_INVALID"],
]) test(`control driver rejects ${name} without exposing native data`, async () => {
  const { child, session } = fixture();
  child.stdout.write(value);
  await assert.rejects(session.wait(() => true), { message: expected, nativeCode: expected });
});

test("control driver rejects duplicate permission identity", async () => {
  const { session, emit } = fixture();
  emit(permission()); emit(permission());
  await assert.rejects(session.wait(() => true), { nativeCode: "CLAUDE_CONTROL_REQUEST_ID_INVALID" });
});

for (const stream of ["stdout", "stderr"]) test(`control driver bounds ${stream} bytes`, async () => {
  const { child, session } = fixture({ outputLimit: 8 });
  child[stream].write("\u00e9".repeat(5));
  await assert.rejects(session.wait(() => true), { nativeCode: "CLAUDE_CONTROL_OUTPUT_LIMIT" });
});

test("control driver rejects truncated final frame", async () => {
  const { child, session } = fixture();
  child.stdout.end('{"type":"result"');
  await assert.rejects(session.wait(() => false), { nativeCode: "CLAUDE_CONTROL_TRUNCATED_JSON" });
});

test("control request deadline fails closed and clears pending requests", async () => {
  const { session } = fixture({ requestTimeout: 10 });
  await assert.rejects(session.request({ subtype: "initialize" }), { nativeCode: "CLAUDE_CONTROL_REQUEST_TIMEOUT" });
  assert.equal(session.pending.size, 0);
});

test("control errors and process exit reject outstanding requests without raw details", async () => {
  const { session, emit } = fixture();
  const rejected = session.request({ subtype: "initialize" });
  emit({ type: "control_response", response: { subtype: "error", request_id: "native-control-1", error: "private native details" } });
  await assert.rejects(rejected, { message: "CLAUDE_CONTROL_REQUEST_REJECTED" });
  const second = fixture();
  const interrupted = second.session.request({ subtype: "initialize" });
  second.child.emit("close", 1, null);
  await assert.rejects(interrupted, { nativeCode: "CLAUDE_CONTROL_EXITED_DURING_REQUEST" });
});

test("native interrupted oracle follows exact tool/prompt lineage without inventing interruptedMessageId", () => {
  const { records, input } = transcript();
  const selected = selectInterruptedTurn(records, input);
  assert.equal(selected.promptId, "native-prompt");
  assert.equal(selected.hasInterruptedMessageId, false);
  assert.equal(selected.lineage.length, 5);
});

for (const [name, mutate, code] of [
  ["foreign session", (r) => { r[0].sessionId = "foreign"; }, "CLAUDE_INTERRUPT_TRANSCRIPT_IDENTITY_INVALID"],
  ["duplicate UUID", (r) => { r.push({ ...r[0] }); }, "CLAUDE_INTERRUPT_TRANSCRIPT_IDENTITY_INVALID"],
  ["wrong marker", (r) => { r[4].message.content[0].text = "Interrupted fixture claim"; }, "CLAUDE_INTERRUPT_NATIVE_MARKER_MISSING"],
  ["missing parent", (r) => { r[4].parentUuid = "absent"; }, "CLAUDE_INTERRUPT_PARENT_MISSING"],
  ["cyclic lineage", (r) => { r[3].parentUuid = "interrupt"; }, "CLAUDE_INTERRUPT_LINEAGE_INVALID"],
  ["sidechain", (r) => { r[1].isSidechain = true; }, "CLAUDE_INTERRUPT_LINEAGE_INVALID"],
  ["completed ancestor", (r) => { r[1].message.stop_reason = "end_turn"; }, "CLAUDE_INTERRUPT_COMPLETED_ANCESTOR"],
  ["wrong prompt identity", (r) => { r[4].promptId = "other"; }, "CLAUDE_INTERRUPT_PROMPT_ID_MISMATCH"],
  ["newer external prompt", (r) => { r.push({ ...r[0], uuid: "new-user", parentUuid: "user", promptId: "new-prompt", message: { role: "user", content: "Another prompt" } }); r[1].parentUuid = "new-user"; }, "CLAUDE_INTERRUPT_PROMPT_MISSING"],
  ["task notification prompt", (r) => { r[0].origin = { kind: "task-notification" }; }, "CLAUDE_INTERRUPT_PROMPT_MISSING"],
  ["wrong tool ID", (r) => { r[1].message.content[0].id = "other"; }, "CLAUDE_INTERRUPT_TOOL_MISMATCH"],
  ["missing tool error", (r) => { r[2].message.content[0].is_error = false; }, "CLAUDE_INTERRUPT_TOOL_RESULT_MISSING"],
]) test(`native interrupted oracle rejects ${name}`, () => {
  const { records, input } = transcript();
  const independentInput = structuredClone(input);
  mutate(records);
  assert.throws(() => selectInterruptedTurn(records, independentInput), { nativeCode: code });
});
