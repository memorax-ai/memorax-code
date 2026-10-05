import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_FIELDS = 32_768;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const USER_FIELDS = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 24, 25, 26]);
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function fail(code) { throw Object.assign(new Error(code), { code }); }
function bytes(value) {
  if (!(value instanceof Uint8Array)) fail("CURSOR_APP_PROTO_BYTES");
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}
function endStreamObject(data) {
  let value;
  try { value = JSON.parse(utf8.decode(data)); } catch { fail("CURSOR_APP_CONNECT_END_STREAM"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("CURSOR_APP_CONNECT_END_STREAM");
}

export function createConnectDecoder({ compression = "identity", maxFrameBytes = MAX_FRAME_BYTES } = {}) {
  if (!["identity", "gzip"].includes(compression)) fail("CURSOR_APP_CONNECT_COMPRESSION");
  if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1 || maxFrameBytes > MAX_FRAME_BYTES) fail("CURSOR_APP_CONNECT_FRAME_TOO_LARGE");
  let pending = Buffer.alloc(0), terminal = false;
  return {
    push(chunk) {
      const input = bytes(chunk);
      if (terminal && input.length) fail("CURSOR_APP_CONNECT_TRAILING_DATA");
      pending = Buffer.concat([pending, input]);
      const messages = [];
      while (pending.length >= 5) {
        if (terminal) fail("CURSOR_APP_CONNECT_TRAILING_DATA");
        const flags = pending[0], length = pending.readUInt32BE(1);
        if (![0, 1, 2].includes(flags)) fail("CURSOR_APP_CONNECT_FLAGS");
        if (length > maxFrameBytes) fail("CURSOR_APP_CONNECT_FRAME_TOO_LARGE");
        if (pending.length < length + 5) break;
        let data = pending.subarray(5, length + 5);
        pending = pending.subarray(length + 5);
        if (flags === 1) {
          if (compression !== "gzip") fail("CURSOR_APP_CONNECT_COMPRESSION");
          try { data = gunzipSync(data, { maxOutputLength: maxFrameBytes }); }
          catch (error) {
            fail(error.code === "ERR_BUFFER_TOO_LARGE" ? "CURSOR_APP_CONNECT_FRAME_TOO_LARGE" : "CURSOR_APP_CONNECT_COMPRESSION");
          }
        }
        if (flags === 2) {
          endStreamObject(data);
          terminal = true;
          if (pending.length) fail("CURSOR_APP_CONNECT_TRAILING_DATA");
        } else messages.push(Buffer.from(data));
      }
      return messages;
    },
    finish() {
      if (pending.length) fail("CURSOR_APP_CONNECT_TRUNCATED");
      terminal = true;
    },
  };
}

export function encodeConnectEnvelope(message, { endStream = false } = {}) {
  const data = bytes(message);
  if (data.length > MAX_FRAME_BYTES) fail("CURSOR_APP_CONNECT_FRAME_TOO_LARGE");
  if (endStream) endStreamObject(data);
  const header = Buffer.alloc(5);
  header[0] = endStream ? 2 : 0;
  header.writeUInt32BE(data.length, 1);
  return Buffer.concat([header, data]);
}

function fields(value) {
  const data = bytes(value), result = new Map();
  if (data.length > MAX_FRAME_BYTES) fail("CURSOR_APP_PROTO_TOO_LARGE");
  let offset = 0, count = 0;
  function varint() {
    let value = 0n;
    for (let index = 0; index < 10; index++) {
      if (offset >= data.length) fail("CURSOR_APP_PROTO_TRUNCATED");
      const byte = data[offset++];
      if (index === 9 && byte > 1) fail("CURSOR_APP_PROTO_VARINT");
      value |= BigInt(byte & 127) << BigInt(index * 7);
      if (!(byte & 128)) return value;
    }
    fail("CURSOR_APP_PROTO_VARINT");
  }
  while (offset < data.length) {
    if (++count > MAX_FIELDS) fail("CURSOR_APP_PROTO_TOO_LARGE");
    const tag = varint(), number = Number(tag >> 3n), wire = Number(tag & 7n);
    if (tag > 0xffff_ffffn || number === 0) fail("CURSOR_APP_PROTO_TAG");
    let value;
    if (wire === 0) value = varint();
    else {
      const length = wire === 1 ? 8n : wire === 5 ? 4n : wire === 2 ? varint() : undefined;
      if (length === undefined) fail("CURSOR_APP_PROTO_WIRE");
      if (length > BigInt(data.length - offset)) fail("CURSOR_APP_PROTO_TRUNCATED");
      value = data.subarray(offset, offset + Number(length));
      offset += Number(length);
    }
    const values = result.get(number) ?? [];
    values.push({ wire, value });
    result.set(number, values);
  }
  return result;
}

function single(source, number, wire, required = true) {
  const values = source.get(number);
  if (!values && !required) return undefined;
  if (values?.length !== 1 || values[0].wire !== wire) fail("CURSOR_APP_PROTO_FIELD");
  return values[0].value;
}
function text(source, number) {
  try { return utf8.decode(single(source, number, 2)); }
  catch (error) {
    if (error.code?.startsWith("CURSOR_APP_")) throw error;
    fail("CURSOR_APP_PROTO_UTF8");
  }
}
function identity(value) {
  if (typeof value !== "string" || !UUID.test(value)) fail("CURSOR_APP_RUN_IDENTITY");
  return value;
}
function boolean(source, number) {
  const value = single(source, number, 0, false) ?? 0n;
  if (value > 1n) fail("CURSOR_APP_PROTO_FIELD");
  return value === 1n;
}
function references(state) {
  return (state.get(8) ?? []).map(({ wire, value }) => {
    if (wire !== 2 || value.length < 1 || value.length > 64) fail("CURSOR_APP_PROTO_REFERENCE");
    return Buffer.from(value);
  });
}
function userMessage(data) {
  const user = fields(data);
  if ([...user.keys()].some((number) => !USER_FIELDS.has(number))
    || boolean(user, 5) || boolean(user, 24) || user.has(18) || user.has(19)) fail("CURSOR_APP_RUN_UNSUPPORTED");
  const prompt = text(user, 1), userMessageId = identity(text(user, 2));
  if (!prompt.trim()) fail("CURSOR_APP_RUN_PROMPT");
  return { prompt, userMessageId };
}

// Minimal agent.v1 wire contract from the official Cursor App 3.21.18 bundle.
// Unknown request context is retained as bytes, never treated as prompt content.
export function decodeAgentClientMessage(message, { requestId } = {}) {
  const outer = fields(message);
  if (outer.size !== 1) fail("CURSOR_APP_PROTO_FIELD");
  const number = [...outer.keys()][0], body = single(outer, number, 2);
  if (number === 7) {
    fields(body);
    return { type: "heartbeat" };
  }
  if (number === 3) {
    const ack = fields(body);
    if ([...ack.keys()].some((number) => ![1, 3].includes(number))) fail("CURSOR_APP_CLIENT_MESSAGE_UNSUPPORTED");
    const id = single(ack, 1, 0), result = fields(single(ack, 3, 2));
    if (id < 1n || id > 0xffff_ffffn) fail("CURSOR_APP_KV_ID");
    const error = single(result, 1, 2, false);
    if (error !== undefined) fields(error);
    return { type: "kvAck", id: Number(id), ...(error === undefined ? {} : { error: "CURSOR_APP_KV_WRITE_FAILED" }) };
  }
  if (number !== 1) fail("CURSOR_APP_CLIENT_MESSAGE_UNSUPPORTED");
  identity(requestId);
  const run = fields(body), conversationId = identity(text(run, 5));
  const conversationStateBytes = Buffer.from(single(run, 1, 2));
  const turnRefs = references(fields(conversationStateBytes)), action = fields(single(run, 2, 2));
  if (!action.has(1) || [...action.keys()].some((number) => ![1, 11, 15, 17].includes(number))) fail("CURSOR_APP_RUN_UNSUPPORTED");
  const userAction = fields(single(action, 1, 2));
  if ([...userAction.keys()].some((number) => ![1, 2, 3].includes(number))) fail("CURSOR_APP_RUN_UNSUPPORTED");
  const userMessageBytes = Buffer.from(single(userAction, 1, 2));
  return { type: "run", requestId, conversationId, ...userMessage(userMessageBytes), userMessageBytes, conversationStateBytes, turnRefs };
}

function varint(value) {
  const output = [];
  for (let remaining = BigInt(value);;) {
    const byte = Number(remaining & 127n);
    remaining >>= 7n;
    output.push(byte | (remaining ? 128 : 0));
    if (!remaining) return Buffer.from(output);
  }
}
function scalar(number, value) { return Buffer.concat([varint(number * 8), varint(value)]); }
function field(number, value) {
  const data = typeof value === "string" ? Buffer.from(value) : bytes(value);
  return Buffer.concat([varint(number * 8 + 2), varint(data.length), data]);
}

export function createCompletedTurn(run, { answer, firstKvId = 1 } = {}) {
  if (typeof answer !== "string" || !answer.trim() || Buffer.from(answer).toString("utf8") !== answer) fail("CURSOR_APP_RESPONSE_TEXT");
  if (!Number.isInteger(firstKvId) || firstKvId < 1 || firstKvId > 0xffff_fffd) fail("CURSOR_APP_KV_ID");
  if (run?.type !== "run") fail("CURSOR_APP_RUN_IDENTITY");
  identity(run.requestId);
  identity(run.conversationId);
  const user = userMessage(run.userMessageBytes);
  if (user.prompt !== run.prompt || user.userMessageId !== run.userMessageId) fail("CURSOR_APP_RUN_IDENTITY");
  references(fields(run.conversationStateBytes));
  const kvWrites = [];
  function blob(value) {
    const data = Buffer.from(value), blobId = createHash("sha256").update(data).digest();
    const id = firstKvId + kvWrites.length;
    const message = field(4, Buffer.concat([scalar(1, id), field(3, Buffer.concat([field(1, blobId), field(2, data)]))]));
    if (message.length > MAX_FRAME_BYTES) fail("CURSOR_APP_PROTO_TOO_LARGE");
    kvWrites.push({ id, blobId, bytes: data, message });
    return blobId;
  }
  const userBlobId = blob(run.userMessageBytes), stepBlobId = blob(field(1, field(1, answer)));
  const turnBlobId = blob(field(1, Buffer.concat([field(1, userBlobId), field(2, stepBlobId), field(3, run.requestId)])));
  // The service sends these through Run and waits for real KV acknowledgements.
  // Only the App writes the returned graph and checkpoint to its native store.
  const conversationStateBytes = Buffer.concat([run.conversationStateBytes, field(8, turnBlobId)]);
  return {
    kvWrites, conversationStateBytes, turnBlobId,
    checkpointMessage: field(3, conversationStateBytes),
    textMessage: field(1, field(1, field(1, answer))),
    turnEndedMessage: field(1, field(14, Buffer.alloc(0))),
  };
}
