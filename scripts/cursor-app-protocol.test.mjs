import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { gzipSync } from "node:zlib";
import {
  completeToolExecution, createCompletedTurn, createConnectDecoder, createGetBlobMessage, createToolExecution,
  decodeAgentClientMessage, encodeConnectEnvelope,
} from "./cursor-app-protocol.mjs";

const requestId = "11111111-1111-4111-8111-111111111111";
const conversationId = "22222222-2222-4222-8222-222222222222";
const userMessageId = "33333333-3333-4333-8333-333333333333";
const prompt = "A synthetic native prompt\nSecond line";
const answer = "A synthetic native answer\nSecond line";

function varint(value) {
  const bytes = [];
  for (let remaining = BigInt(value);;) {
    const byte = Number(remaining & 127n);
    remaining >>= 7n;
    bytes.push(byte | (remaining ? 128 : 0));
    if (!remaining) return Buffer.from(bytes);
  }
}
function scalar(number, value) { return Buffer.concat([varint(number * 8), varint(value)]); }
function field(number, value) {
  const bytes = Buffer.from(value);
  return Buffer.concat([varint(number * 8 + 2), varint(bytes.length), bytes]);
}
function message(...fields) { return Buffer.concat(fields); }
function frame(bytes, flags = 0) {
  const header = Buffer.alloc(5);
  header[0] = flags;
  header.writeUInt32BE(bytes.length, 1);
  return Buffer.concat([header, bytes]);
}
function fixture({ user, state = Buffer.alloc(0), session = conversationId, action, extraRun } = {}) {
  const userBytes = user ?? message(field(1, prompt), field(2, userMessageId), scalar(4, 1));
  const body = message(field(1, state), field(2, action ?? field(1, field(1, userBytes))), field(5, session), extraRun ?? Buffer.alloc(0));
  return { bytes: field(1, body), userBytes, state };
}
function run(options) { return decodeAgentClientMessage(fixture(options).bytes, { requestId }); }
function hash(bytes) { return createHash("sha256").update(bytes).digest(); }

test("Connect decoder accepts split headers, split messages and coalesced frames", () => {
  const decoder = createConnectDecoder();
  const wire = message(frame(Buffer.from("first")), frame(Buffer.from("second")));
  const output = [];
  for (const byte of wire) output.push(...decoder.push(Buffer.from([byte])));
  decoder.finish();
  assert.deepEqual(output.map((value) => value.toString()), ["first", "second"]);
  const coalesced = createConnectDecoder();
  assert.deepEqual(coalesced.push(wire), output);
  coalesced.finish();
});

test("Connect gzip decoding is explicit and bounds compressed and decompressed payloads", () => {
  const bytes = Buffer.from("synthetic frame");
  const decoder = createConnectDecoder({ compression: "gzip", maxFrameBytes: 128 });
  assert.deepEqual(decoder.push(frame(gzipSync(bytes), 1)), [bytes]);
  assert.deepEqual(decoder.push(frame(bytes)), [bytes]);
  decoder.finish();
  assert.throws(() => createConnectDecoder().push(frame(gzipSync(bytes), 1)), /CURSOR_APP_CONNECT_COMPRESSION/);
  assert.throws(() => createConnectDecoder({ compression: "br" }), /CURSOR_APP_CONNECT_COMPRESSION/);
  assert.throws(() => createConnectDecoder({ compression: "gzip" }).push(frame(Buffer.from("not gzip"), 1)), /CURSOR_APP_CONNECT_COMPRESSION/);
  assert.throws(() => createConnectDecoder({ maxFrameBytes: 8 }).push(frame(bytes)), /CURSOR_APP_CONNECT_FRAME_TOO_LARGE/);
  assert.throws(() => createConnectDecoder({ compression: "gzip", maxFrameBytes: 64 }).push(frame(gzipSync(Buffer.alloc(1024)), 1)), /CURSOR_APP_CONNECT_FRAME_TOO_LARGE/);
});

test("Connect framing rejects invalid flags, truncation and data after a terminal envelope", () => {
  for (const flags of [3, 4, 128]) {
    assert.throws(() => createConnectDecoder().push(frame(Buffer.alloc(0), flags)), /CURSOR_APP_CONNECT_FLAGS/);
  }
  for (const bytes of [Buffer.from([0]), frame(Buffer.from("truncated")).subarray(0, 8)]) {
    const decoder = createConnectDecoder();
    decoder.push(bytes);
    assert.throws(() => decoder.finish(), /CURSOR_APP_CONNECT_TRUNCATED/);
  }
  for (const body of ["bad json", "[]", "null"]) {
    assert.throws(() => createConnectDecoder().push(frame(Buffer.from(body), 2)), /CURSOR_APP_CONNECT_END_STREAM/);
  }
  const terminal = frame(Buffer.from("{}"), 2);
  const decoder = createConnectDecoder();
  assert.deepEqual(decoder.push(terminal), []);
  decoder.finish();
  assert.throws(() => decoder.push(Buffer.from([0])), /CURSOR_APP_CONNECT_TRAILING_DATA/);
  assert.throws(() => createConnectDecoder().push(message(terminal, terminal)), /CURSOR_APP_CONNECT_TRAILING_DATA/);
});

test("Connect encoder emits binary and end-stream envelopes without implicit compression", () => {
  assert.deepEqual(encodeConnectEnvelope(Buffer.from([10, 0])), Buffer.from([0, 0, 0, 0, 2, 10, 0]));
  assert.deepEqual(encodeConnectEnvelope(Buffer.from("{}"), { endStream: true }), frame(Buffer.from("{}"), 2));
  assert.throws(() => encodeConnectEnvelope(Buffer.from("invalid"), { endStream: true }), /CURSOR_APP_CONNECT_END_STREAM/);
});

test("explicit Connect terminal errors are rejected without exposing remote details", () => {
  const terminal = encodeConnectEnvelope(Buffer.from(JSON.stringify({ error: {
    code: "aborted", message: "private-terminal-error-canary",
  } })), { endStream: true });
  for (const input of [terminal, message(frame(Buffer.from("synthetic message")), terminal)]) {
    assert.throws(() => createConnectDecoder().push(input), (error) => error.code === "CURSOR_APP_CONNECT_REMOTE_ERROR"
      && error.message === "CURSOR_APP_CONNECT_REMOTE_ERROR");
  }
});

test("Run decoding binds real request, conversation and user identities and preserves native bytes", () => {
  const oldTurn = Buffer.alloc(32, 7);
  const state = message(field(8, oldTurn), scalar(10, 1), field(35, "synthetic retained field"));
  const input = fixture({ state, extraRun: scalar(32, 0) });
  assert.deepEqual(decodeAgentClientMessage(input.bytes, { requestId }), {
    type: "run", requestId, conversationId, userMessageId, prompt,
    userMessageBytes: input.userBytes, conversationStateBytes: state, turnRefs: [oldTurn],
  });
  const exactPrompt = "\ufeffSynthetic \u4e2d\u6587\r\nunchanged";
  assert.equal(run({ user: message(field(1, exactPrompt), field(2, userMessageId)) }).prompt, exactPrompt);
});

test("Run decoding fails closed for absent, conflicting or malformed native identities", () => {
  for (const value of [undefined, "", "not-a-uuid", `${requestId}\n`]) {
    assert.throws(() => decodeAgentClientMessage(fixture().bytes, { requestId: value }), /CURSOR_APP_RUN_IDENTITY/);
  }
  assert.throws(() => run({ session: "" }), /CURSOR_APP_RUN_IDENTITY/);
  assert.throws(() => run({ user: message(field(1, prompt), field(2, "wrong")) }), /CURSOR_APP_RUN_IDENTITY/);
  assert.throws(() => run({ user: message(field(1, prompt), field(2, userMessageId), field(2, userMessageId)) }), /CURSOR_APP_PROTO_FIELD/);
  assert.throws(() => decodeAgentClientMessage(message(fixture().bytes, fixture().bytes), { requestId }), /CURSOR_APP_PROTO_FIELD/);
  assert.throws(() => run({ extraRun: field(5, conversationId) }), /CURSOR_APP_PROTO_FIELD/);
});

test("Run decoding rejects unsupported user actions and nonordinary user content", () => {
  assert.throws(() => run({ action: field(2, Buffer.alloc(0)) }), /CURSOR_APP_RUN_UNSUPPORTED/);
  for (const extra of [scalar(5, 1), scalar(24, 1), field(18, Buffer.alloc(32)), field(19, Buffer.alloc(32)), field(27, "agent")]) {
    assert.throws(() => run({ user: message(field(1, prompt), field(2, userMessageId), extra) }), /CURSOR_APP_RUN_UNSUPPORTED/);
  }
  assert.throws(() => run({ user: message(field(1, "  "), field(2, userMessageId)) }), /CURSOR_APP_RUN_PROMPT/);
  assert.throws(() => run({ user: message(field(1, Buffer.from([0xc3, 0x28])), field(2, userMessageId)) }), /CURSOR_APP_PROTO_UTF8/);
  assert.throws(() => run({ state: field(8, Buffer.alloc(0)) }), /CURSOR_APP_PROTO_REFERENCE/);
});

test("protobuf decoding rejects invalid wire values, duplicate oneofs and truncated nested fields", () => {
  for (const bytes of [Buffer.from([0]), Buffer.from([15]), Buffer.from([10, 2, 0]), Buffer.alloc(11, 255)]) {
    assert.throws(() => decodeAgentClientMessage(bytes, { requestId }), /CURSOR_APP_PROTO/);
  }
  assert.throws(() => decodeAgentClientMessage(message(fixture().bytes, field(7, Buffer.alloc(0))), { requestId }), /CURSOR_APP_PROTO_FIELD/);
  assert.throws(() => decodeAgentClientMessage(field(8, Buffer.alloc(0)), { requestId }), /CURSOR_APP_CLIENT_MESSAGE_UNSUPPORTED/);
  assert.throws(() => run({ user: message(scalar(1, 3), field(2, userMessageId)) }), /CURSOR_APP_PROTO_FIELD/);
});

test("KV acknowledgements correlate native IDs and redact native error contents", () => {
  const ack = field(3, message(scalar(1, 7), field(3, Buffer.alloc(0))));
  assert.deepEqual(decodeAgentClientMessage(ack), { type: "kvAck", id: 7 });
  const failed = field(3, message(scalar(1, 8), field(3, field(1, field(1, "synthetic private diagnostic")))));
  assert.deepEqual(decodeAgentClientMessage(failed), { type: "kvAck", id: 8, error: "CURSOR_APP_KV_WRITE_FAILED" });
  assert.throws(() => decodeAgentClientMessage(field(3, field(3, Buffer.alloc(0)))), /CURSOR_APP_PROTO_FIELD/);
  assert.throws(() => decodeAgentClientMessage(field(3, message(scalar(1, 7), field(4, Buffer.alloc(0))))), /CURSOR_APP_CLIENT_MESSAGE_UNSUPPORTED/);
  assert.deepEqual(decodeAgentClientMessage(field(7, Buffer.alloc(0))), { type: "heartbeat" });
});

test("KV reads encode hash references and decode exact bytes without exposing native errors", () => {
  const bytes = Buffer.from([0, 255, 3, 4]), blobId = hash(bytes);
  assert.deepEqual(createGetBlobMessage({ id: 11, blobId }), field(4, message(scalar(1, 11), field(2, field(1, blobId)))));
  assert.deepEqual(decodeAgentClientMessage(field(3, message(scalar(1, 11), field(2, field(1, bytes))))),
    { type: "kvGetResult", id: 11, bytes });
  assert.deepEqual(decodeAgentClientMessage(field(3, message(scalar(1, 12), field(2, Buffer.alloc(0))))),
    { type: "kvGetResult", id: 12 });
  assert.deepEqual(decodeAgentClientMessage(field(3, message(scalar(1, 13), field(2, field(1, Buffer.alloc(0)))))),
    { type: "kvGetResult", id: 13, bytes: Buffer.alloc(0) });
  const failed = field(3, message(scalar(1, 14), field(2, field(2, field(1, "synthetic private diagnostic")))));
  assert.deepEqual(decodeAgentClientMessage(failed), { type: "kvGetResult", id: 14, error: "CURSOR_APP_KV_READ_FAILED" });
});

test("KV reads reject ambiguous results, invalid IDs and malformed references", () => {
  const result = field(2, field(1, Buffer.from("synthetic")));
  for (const body of [message(scalar(1, 1), result, result), message(scalar(1, 1), result, field(3, Buffer.alloc(0))),
    message(scalar(1, 1), field(2, message(field(1, "one"), field(1, "two")))),
    message(scalar(1, 1), field(2, scalar(1, 1)))]) {
    assert.throws(() => decodeAgentClientMessage(field(3, body)), /CURSOR_APP_PROTO_FIELD/);
  }
  assert.throws(() => decodeAgentClientMessage(field(3, message(scalar(1, 1), field(2, field(3, Buffer.alloc(0)))))),
    /CURSOR_APP_CLIENT_MESSAGE_UNSUPPORTED/);
  for (const id of [0, -1, 1.5, 0x1_0000_0000]) {
    assert.throws(() => createGetBlobMessage({ id, blobId: Buffer.alloc(32) }), /CURSOR_APP_KV_ID/);
  }
  for (const id of [0, 0x1_0000_0000]) {
    assert.throws(() => decodeAgentClientMessage(field(3, message(scalar(1, id), result))), /CURSOR_APP_KV_ID/);
  }
  for (const blobId of [Buffer.alloc(0), Buffer.alloc(31), Buffer.alloc(33)]) {
    assert.throws(() => createGetBlobMessage({ id: 1, blobId }), /CURSOR_APP_PROTO_REFERENCE/);
  }
});

test("completion produces the native content graph and preserves prior state without file writes", () => {
  const oldTurn = Buffer.alloc(32, 9);
  const state = message(field(8, oldTurn), scalar(10, 1), field(35, "retained"));
  const input = run({ state });
  const completed = createCompletedTurn(input, { answer, firstKvId: 11 });
  const user = input.userMessageBytes;
  const step = field(1, field(1, answer));
  const turn = field(1, message(field(1, hash(user)), field(2, hash(step)), field(3, requestId)));
  assert.equal(completed.kvWrites.length, 3);
  for (const [index, bytes] of [user, step, turn].entries()) {
    const id = index + 11, blobId = hash(bytes), write = completed.kvWrites[index];
    assert.deepEqual(write, { id, blobId, bytes, message: field(4, message(scalar(1, id), field(3, message(field(1, blobId), field(2, bytes))))) });
  }
  assert.deepEqual(completed.checkpointMessage, field(3, message(state, field(8, hash(turn)))));
  assert.deepEqual(completed.conversationStateBytes, message(state, field(8, hash(turn))));
  assert.deepEqual(completed.turnBlobId, hash(turn));
  assert.deepEqual(completed.textMessage, field(1, field(1, field(1, answer))));
  assert.deepEqual(completed.turnEndedMessage, field(1, field(14, Buffer.alloc(0))));
  assert.deepEqual(input.conversationStateBytes, state);
});

test("completion keeps Unicode exactly and rejects empty answers or invalid KV ID ranges", () => {
  const text = "Fixture \u4e2d\u6587 \ud83e\uddea\nunchanged";
  assert.deepEqual(createCompletedTurn(run(), { answer: text }).textMessage, field(1, field(1, field(1, text))));
  for (const value of ["", "  ", undefined]) {
    assert.throws(() => createCompletedTurn(run(), { answer: value }), /CURSOR_APP_RESPONSE_TEXT/);
  }
  for (const firstKvId of [0, -1, 1.5, 0xffff_fffe]) {
    assert.throws(() => createCompletedTurn(run(), { answer, firstKvId }), /CURSOR_APP_KV_ID/);
  }
});

test("Run context decodes official Hook and installed Skill fields without scanning arbitrary bytes", () => {
  const skill = message(field(1, "/synthetic/skills/memorax-code/SKILL.md"), field(2, "skill metadata"), field(3, "Synthetic skill"));
  const context = message(field(25, "Exact sessionStart context"), field(29, skill));
  const user = message(field(1, prompt), field(2, userMessageId), field(21,
    message(field(1, "beforeSubmitPrompt"), field(2, "Exact prompt context"))));
  const decoded = run({ action: field(1, message(field(1, user), field(2, context))) });
  assert.deepEqual(decoded.requestContext, { hooksAdditionalContext: "Exact sessionStart context",
    agentSkills: [{ fullPath: "/synthetic/skills/memorax-code/SKILL.md", content: "skill metadata", description: "Synthetic skill",
      disableModelInvocation: false, environments: [], disabledEnvironments: [] }] });
  assert.deepEqual(decoded.userHookAdditionalContexts, [{ hookEventName: "beforeSubmitPrompt", content: "Exact prompt context" }]);
  const fake = run({ extraRun: field(99, context) });
  assert.equal(fake.requestContext, undefined);
  const parts = message(field(3, hash(skill)), scalar(4, skill.length), field(9, context));
  const withParts = run({ action: message(field(1, field(1, fixture().userBytes)), field(17, parts)) });
  assert.deepEqual(withParts.requestContextParts.skillsBlobId, hash(skill));
  assert.deepEqual(withParts.requestContextParts.dynamicContext, decoded.requestContext);
  assert.throws(() => run({ action: field(1, message(field(1, user), field(2, message(field(25, "one"), field(25, "two"))))) }),
    /CURSOR_APP_PROTO_FIELD/);
});

test("Read Exec correlates wire results and persists the native content in a tool step", () => {
  const input = run(), path = "/synthetic/SKILL.md", content = "Native skill\nUnicode \u8bb0\u5fc6";
  const execution = createToolExecution(input, { kind: "read", path }, { id: 4, toolCallId: userMessageId });
  const args = message(field(1, path), field(2, userMessageId));
  assert.deepEqual(execution.execMessage, field(2, message(scalar(1, 4), field(15, userMessageId), field(7, args))));
  const toolArgs = field(1, path), startedTool = message(field(8, field(1, toolArgs)), field(57, userMessageId));
  assert.deepEqual(execution.startedMessage, field(1, field(2, message(field(1, userMessageId), field(2, startedTool)))));
  const success = message(field(1, path), field(2, content), scalar(3, 2), scalar(4, Buffer.byteLength(content)));
  const result = decodeAgentClientMessage(field(2, message(scalar(1, 4), field(7, field(1, success)), scalar(39, 10))));
  const completed = completeToolExecution(execution, result);
  assert.deepEqual(completed.result, { kind: "read", path, content, totalLines: 2, fileSize: Buffer.byteLength(content) });
  const toolSuccess = message(field(1, content), scalar(4, 2), scalar(5, Buffer.byteLength(content)), field(7, path));
  const tool = message(field(8, message(field(1, toolArgs), field(2, field(1, toolSuccess)))), field(57, userMessageId));
  assert.deepEqual(completed.stepBytes, field(2, tool));
  assert.deepEqual(completed.completedMessage, field(1, field(3, message(field(1, userMessageId), field(2, tool)))));
  const turn = createCompletedTurn(input, { answer, toolSteps: [completed.stepBytes], firstKvId: 5 });
  assert.equal(turn.kvWrites.length, 4);
  assert.deepEqual(turn.kvWrites[1].bytes, completed.stepBytes);
  assert.deepEqual(turn.kvWrites[2].bytes, field(1, field(1, answer)));
  assert.deepEqual(turn.kvWrites[3].bytes, field(1, message(field(1, hash(input.userMessageBytes)),
    field(2, hash(completed.stepBytes)), field(2, hash(field(1, field(1, answer)))), field(3, requestId))));
});

test("RequestContext Exec fetches native context without a visible or persisted tool step", () => {
  const execution = createToolExecution(run(), { kind: "requestContext" }, { id: 10, toolCallId: userMessageId });
  assert.deepEqual(execution.execMessage, field(2, message(scalar(1, 10), field(15, userMessageId),
    field(10, message(field(2, conversationId), scalar(7, 0))))));
  assert.equal(execution.startedMessage, undefined);
  const context = message(field(25, "Synthetic sessionStart context"),
    field(29, message(field(1, "/synthetic/SKILL.md"), field(3, "Synthetic Skill"))));
  const decoded = decodeAgentClientMessage(field(2, message(scalar(1, 10), field(10, field(1, field(1, context))))));
  const completed = completeToolExecution(execution, decoded);
  assert.deepEqual(completed.result, { hooksAdditionalContext: "Synthetic sessionStart context", agentSkills: [
    { fullPath: "/synthetic/SKILL.md", content: "", description: "Synthetic Skill", disableModelInvocation: false,
      environments: [], disabledEnvironments: [] },
  ] });
  assert.deepEqual(completed.requestContextBytes, context);
  assert.equal(completed.stepBytes, undefined);
  assert.equal(completed.completedMessage, undefined);
  assert.throws(() => completeToolExecution(execution, { ...decoded, id: 9 }), /CURSOR_APP_EXEC_IDENTITY/);
  const rejected = decodeAgentClientMessage(field(2, message(scalar(1, 10), field(10, field(2, field(1, "private-context-error"))))));
  assert.throws(() => completeToolExecution(execution, rejected), /CURSOR_APP_EXEC_REJECTED/);
  assert.equal(JSON.stringify(rejected).includes("private"), false);
});

test("Shell Exec leaves native approval enabled and preserves exact successful native result bytes", () => {
  const command = "memorax-cli search --query synthetic", workingDirectory = "/synthetic/workspace";
  const execution = createToolExecution(run(), { kind: "shell", command, workingDirectory, timeoutMs: 10_000 },
    { id: 5, toolCallId: userMessageId });
  const args = message(field(1, command), field(2, workingDirectory), scalar(3, 10_000), field(4, userMessageId),
    field(8, scalar(1, 1)), scalar(13, 1), scalar(14, 10_000), scalar(17, 1), field(21, conversationId), field(23, requestId));
  assert.deepEqual(execution.execMessage, field(2, message(scalar(1, 5), field(15, userMessageId), field(2, args))));
  const stdout = "{\"results\":[\"native\"]}\n";
  const nativeResult = field(1, message(field(1, command), field(2, workingDirectory), field(5, stdout), scalar(7, 12)));
  const result = decodeAgentClientMessage(field(2, message(scalar(1, 5), field(2, nativeResult))));
  const completed = completeToolExecution(execution, result);
  assert.deepEqual(completed.result, { kind: "shell", command, workingDirectory, stdout, stderr: "", exitCode: 0 });
  assert.deepEqual(completed.stepBytes, field(2, message(field(1, message(field(1, args), field(2, nativeResult))), field(57, userMessageId))));
  assert.throws(() => completeToolExecution(execution, { ...result, id: 6 }), /CURSOR_APP_EXEC_IDENTITY/);
  assert.throws(() => completeToolExecution(execution, { ...result, command: "changed" }), /CURSOR_APP_EXEC_IDENTITY/);
});

test("Exec control messages bind one ID and redact exceptions", () => {
  for (const [number, event] of [[1, "close"], [2, "error"], [3, "heartbeat"]]) {
    const body = message(scalar(1, 9), ...(number === 2 ? [field(2, "private-error"), field(3, "private-stack")] : []));
    const decoded = decodeAgentClientMessage(field(5, field(number, body)));
    assert.deepEqual(decoded, { type: "execControl", id: 9, event });
    assert.equal(JSON.stringify(decoded).includes("private"), false);
  }
  for (const value of [field(5, message(field(1, scalar(1, 9)), field(3, scalar(1, 9)))),
    field(5, field(1, scalar(1, 0))), field(5, field(4, scalar(1, 9)))]) {
    assert.throws(() => decodeAgentClientMessage(value), /CURSOR_APP_(PROTO|EXEC|CLIENT)/);
  }
});

test("only the exact native user Stop action can be decoded when explicitly enabled", () => {
  for (const reason of ["user_stopped_generation", "composer_abort_controller_aborted"]) {
    const stopped = field(4, field(3, field(1, reason)));
    assert.throws(() => decodeAgentClientMessage(stopped), { code: "CURSOR_APP_CLIENT_MESSAGE_UNSUPPORTED" });
    assert.deepEqual(decodeAgentClientMessage(stopped, { allowCancellation: true }), { type: "cancelAction" });
  }
  for (const value of [
    field(4, field(3, field(1, "new_message_submitted"))),
    field(4, field(3, Buffer.concat([field(1, "user_stopped_generation"), field(3, Buffer.alloc(0))]))),
    field(4, Buffer.concat([field(3, field(1, "user_stopped_generation")), field(11, "private-auth-canary")])),
    field(4, field(2, Buffer.alloc(0))),
  ]) assert.throws(() => decodeAgentClientMessage(value, { allowCancellation: true }),
    { code: "CURSOR_APP_CLIENT_MESSAGE_UNSUPPORTED" });
  assert.throws(() => decodeAgentClientMessage(field(4, field(3, Buffer.concat([
    field(1, "user_stopped_generation"), field(1, "user_stopped_generation"),
  ]))), { allowCancellation: true }), { code: "CURSOR_APP_PROTO_FIELD" });
});

test("unsupported client diagnostics retain only bounded numeric shapes and fixed cancellation reason categories", () => {
  for (const reason of ["composer_abort_controller_aborted", "private-reason-canary"]) {
    const cancel = Buffer.concat([field(1, reason), field(3, Buffer.alloc(0))]);
    assert.throws(() => decodeAgentClientMessage(field(4, field(3, cancel)), { allowCancellation: true }), (error) => {
      assert.equal(error.code, "CURSOR_APP_CLIENT_MESSAGE_UNSUPPORTED");
      assert.deepEqual(error.wireShape, { outer: [{ number: 4, wire: 2 }], action: [{ number: 3, wire: 2 }],
        cancel: [{ number: 1, wire: 2 }, { number: 3, wire: 2 }], cancelReason: reason === "composer_abort_controller_aborted" ? reason : "other" });
      assert.equal(JSON.stringify(error.wireShape).includes("canary"), false);
      return true;
    });
  }
  const unknownExec = field(2, Buffer.concat([scalar(1, 123456), field(2, field(4, Buffer.concat([
    field(1, "private-command-canary"), field(2, "private-cwd-canary"), field(5, "private-unknown-canary"),
  ])))]));
  assert.throws(() => decodeAgentClientMessage(unknownExec), (error) => {
    assert.deepEqual(error.wireShape, { outer: [{ number: 2, wire: 2 }], exec: [{ number: 1, wire: 0 }, { number: 2, wire: 2 }],
      result: [{ number: 4, wire: 2 }], detail: [{ number: 1, wire: 2 }, { number: 2, wire: 2 }, { number: 5, wire: 2 }] });
    assert.equal(JSON.stringify(error.wireShape).includes("canary"), false);
    assert.equal(JSON.stringify(error.wireShape).includes("123456"), false);
    return true;
  });
  const manyFields = field(4, Buffer.concat(Array.from({ length: 32 }, (_, index) => field(index + 20, "private-canary"))));
  assert.throws(() => decodeAgentClientMessage(manyFields, { allowCancellation: true }), (error) => {
    assert.equal(error.wireShape.action.length, 16);
    return true;
  });
});

test("Shell rejection exposes only command identity for a strictly correlated cancellation", () => {
  const command = "printf synthetic > stop-marker", workingDirectory = "/synthetic/workspace";
  const body = message(field(1, command), field(2, workingDirectory), field(3, "private-rejection-reason"), scalar(4, 0));
  const decoded = decodeAgentClientMessage(field(2, message(scalar(1, 9), field(15, userMessageId), field(2, field(4, body)))));
  assert.deepEqual(decoded, { type: "execResult", id: 9, kind: "shell", execId: userMessageId,
    error: "CURSOR_APP_EXEC_REJECTED", rejectionKind: 4, command, workingDirectory });
  assert.equal(JSON.stringify(decoded).includes("private"), false);
  const execution = createToolExecution(run(), { kind: "shell", command, workingDirectory, timeoutMs: 1000 },
    { id: 9, toolCallId: userMessageId });
  assert.throws(() => completeToolExecution(execution, decoded), /CURSOR_APP_EXEC_REJECTED/);
  for (const invalid of [field(1, command), message(body, field(1, "duplicate")),
    message(body, field(5, "unknown")), message(field(1, command), field(2, workingDirectory), scalar(4, 2))]) {
    assert.throws(() => decodeAgentClientMessage(field(2, message(scalar(1, 9), field(2, field(4, invalid))))),
      /CURSOR_APP_(PROTO|CLIENT)/);
  }
});

test("ShellFailure diagnostics retain only an explicitly encoded signed int32 exit code", () => {
  const decode = (detail, variant = 2) => decodeAgentClientMessage(field(2,
    message(scalar(1, 9), field(2, field(variant, detail)))));
  const privateFields = message(field(1, "private-command-canary"), field(2, "private-path-canary"),
    field(5, "private-output-canary"), field(6, "private-error-canary"));
  for (const exitCode of [-0x8000_0000, -1, 0, 1, 127, 0x7fff_ffff]) {
    const result = decode(message(privateFields, scalar(3, BigInt.asUintN(64, BigInt(exitCode)))));
    assert.deepEqual(result, { type: "execResult", id: 9, kind: "shell",
      error: "CURSOR_APP_EXEC_REJECTED", rejectionKind: 2, exitCode });
    assert.equal(JSON.stringify(result).includes("canary"), false);
  }
  for (const invalid of [Buffer.alloc(0), scalar(3, 0x8000_0000), scalar(3, 0xffff_ffff),
    scalar(3, 0xffff_ffff_7fff_ffffn), field(3, "private-exit-canary"), message(scalar(3, 1), scalar(3, 2))]) {
    assert.deepEqual(decode(message(privateFields, invalid)), { type: "execResult", id: 9, kind: "shell",
      error: "CURSOR_APP_EXEC_REJECTED", rejectionKind: 2 });
  }
  for (const variant of [3, 5, 7]) assert.equal(decode(scalar(3, 127), variant).exitCode, undefined);
});

test("Exec decoding rejects failure, ambiguous, binary or truncated tool results safely", () => {
  for (const [kind, number, failures] of [["read", 7, [2, 3, 4, 5, 6]], ["shell", 2, [2, 3, 5, 7]]]) {
    for (const failure of failures) {
      const result = decodeAgentClientMessage(field(2, message(scalar(1, 1), field(number, field(failure, field(1, "private-error"))))));
      assert.deepEqual(result, { type: "execResult", id: 1, kind, error: "CURSOR_APP_EXEC_REJECTED", rejectionKind: failure });
    }
  }
  for (const success of [message(field(1, "/synthetic"), field(2, "truncated"), scalar(6, 1)),
    message(field(1, "/synthetic"), field(5, Buffer.from([1, 2]))),
    message(field(1, "/synthetic"), field(2, "one"), field(2, "two"))]) {
    assert.throws(() => decodeAgentClientMessage(field(2, message(scalar(1, 1), field(7, field(1, success))))), /CURSOR_APP_(EXEC|PROTO)/);
  }
  const empty = field(1, Buffer.alloc(0));
  assert.throws(() => decodeAgentClientMessage(field(2, message(scalar(1, 1), field(2, empty), field(7, empty)))), /CURSOR_APP_PROTO_FIELD/);
  assert.throws(() => createToolExecution(run(), { kind: "write", path: "/synthetic" }, { id: 1, toolCallId: userMessageId }), /CURSOR_APP_EXEC_OPTIONS/);
});
