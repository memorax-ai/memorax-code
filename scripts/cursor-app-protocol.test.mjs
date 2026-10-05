import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { gzipSync } from "node:zlib";
import {
  createCompletedTurn, createConnectDecoder, decodeAgentClientMessage, encodeConnectEnvelope,
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
  assert.throws(() => decodeAgentClientMessage(field(3, message(scalar(1, 7), field(2, Buffer.alloc(0))))), /CURSOR_APP_CLIENT_MESSAGE_UNSUPPORTED/);
  assert.deepEqual(decodeAgentClientMessage(field(7, Buffer.alloc(0))), { type: "heartbeat" });
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
