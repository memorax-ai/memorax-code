import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { collectCursorAppShellOutputDiagnostics } from "./cursor-app-diagnostics.mjs";

const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_FIELDS = 32_768;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const USER_FIELDS = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 24, 25, 26]);
// Native Stop can abort the composer controller before submitting the explicit user reason.
const CANCELLATION_REASONS = new Set(["user_stopped_generation", "composer_abort_controller_aborted"]);
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
  return value;
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
          if (Object.hasOwn(endStreamObject(data), "error")) fail("CURSOR_APP_CONNECT_REMOTE_ERROR");
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
function optionalText(source, number) { return source.has(number) ? text(source, number) : ""; }
function unsigned(source, number, max = 0xffff_ffff, required = false) {
  const value = single(source, number, 0, required) ?? 0n;
  if (value < 0n || value > BigInt(max)) fail("CURSOR_APP_PROTO_FIELD");
  return Number(value);
}
function diagnosticInt32(source, number) {
  try {
    const value = single(source, number, 0, false);
    if (value === undefined) return undefined;
    if (value <= 0x7fff_ffffn) return Number(value);
    if (value >= 0xffff_ffff_8000_0000n) return Number(value - 0x1_0000_0000_0000_0000n);
  } catch { /* Invalid diagnostic fields must not replace the native failure. */ }
  return undefined;
}
function diagnosticText(source, number) {
  try {
    const value = single(source, number, 2, false);
    if (value === undefined) return { status: "absent" };
    if (value.length > 64 * 1024) return { status: "oversized" };
    return { status: "present", text: utf8.decode(value) };
  } catch { return { status: "invalid" }; }
}
function repeated(source, number, decode) {
  return (source.get(number) ?? []).map(({ wire, value }) => {
    if (wire !== 2) fail("CURSOR_APP_PROTO_FIELD");
    return decode(value);
  });
}
function hookContexts(source, number) {
  return repeated(source, number, (value) => {
    const entry = fields(value);
    return { hookEventName: text(entry, 1), content: text(entry, 2) };
  });
}
function requestContext(value) {
  const context = fields(value);
  return { hooksAdditionalContext: optionalText(context, 25), agentSkills: repeated(context, 29, (value) => {
    const skill = fields(value), decodeText = (bytes) => text(fields(field(1, bytes)), 1);
    return { fullPath: text(skill, 1), content: optionalText(skill, 2), description: optionalText(skill, 3),
      ...(skill.has(4) ? { parseError: text(skill, 4) } : {}), disableModelInvocation: boolean(skill, 8),
      environments: repeated(skill, 5, decodeText), disabledEnvironments: repeated(skill, 6, decodeText) };
  }) };
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
  return { prompt, userMessageId, ...(user.has(21) ? { userHookAdditionalContexts: hookContexts(user, 21) } : {}) };
}

function execClient(body) {
  const exec = fields(body), id = unsigned(exec, 1, 0xffff_ffff, true);
  if (!id) fail("CURSOR_APP_EXEC_IDENTITY");
  if ([...exec.keys()].some((number) => ![1, 2, 7, 10, 15, 39, 45].includes(number))) fail("CURSOR_APP_CLIENT_MESSAGE_UNSUPPORTED");
  unsigned(exec, 39, 0x7fff_ffff);
  hookContexts(exec, 45);
  const messages = [2, 7, 10].filter((number) => exec.has(number));
  if (messages.length !== 1) fail("CURSOR_APP_PROTO_FIELD");
  const kind = messages[0] === 7 ? "read" : messages[0] === 10 ? "requestContext" : "shell";
  const resultBytes = Buffer.from(single(exec, messages[0], 2));
  const result = fields(resultBytes), variants = kind === "read" ? [1, 2, 3, 4, 5, 6]
    : kind === "requestContext" ? [1, 2, 3] : [1, 2, 3, 4, 5, 7];
  const selected = variants.filter((number) => result.has(number));
  if (selected.length !== 1) fail("CURSOR_APP_PROTO_FIELD");
  if ([...result.keys()].some((number) => ![...variants, ...(kind === "shell" ? [101, 102, 103] : [])].includes(number))) {
    fail("CURSOR_APP_CLIENT_MESSAGE_UNSUPPORTED");
  }
  const success = fields(single(result, selected[0], 2));
  const identity = { type: "execResult", id, kind, ...(exec.has(15) ? { execId: text(exec, 15) } : {}) };
  if (kind === "shell" && selected[0] === 4) {
    if ([...success.keys()].some((number) => ![1, 2, 3, 4].includes(number))) fail("CURSOR_APP_CLIENT_MESSAGE_UNSUPPORTED");
    optionalText(success, 3);
    boolean(success, 4);
    return { ...identity, error: "CURSOR_APP_EXEC_REJECTED", rejectionKind: 4,
      command: text(success, 1), workingDirectory: text(success, 2) };
  }
  if (selected[0] !== 1) {
    // agent.v1.ShellFailure field 3 is int32, not a code on the other result variants.
    const exitCode = kind === "shell" && selected[0] === 2 ? diagnosticInt32(success, 3) : undefined;
    return { ...identity, error: "CURSOR_APP_EXEC_REJECTED", rejectionKind: selected[0],
      ...(exitCode === undefined ? {} : { exitCode }),
      ...(kind === "shell" && selected[0] === 2 ? { output: collectCursorAppShellOutputDiagnostics({
        stdout: diagnosticText(success, 5), stderr: diagnosticText(success, 6),
      }) } : {}) };
  }
  if (kind === "requestContext") {
    const requestContextBytes = Buffer.from(single(success, 1, 2));
    boolean(success, 2);
    return { ...identity, requestContext: requestContext(requestContextBytes), requestContextBytes };
  }
  if (kind === "read") {
    if (!success.has(2) || success.has(5) || boolean(success, 6) || boolean(success, 8)) fail("CURSOR_APP_EXEC_READ_UNSUPPORTED");
    const content = text(success, 2), outputBlobId = single(success, 7, 2, false);
    if (outputBlobId && !createHash("sha256").update(content).digest().equals(outputBlobId)) fail("CURSOR_APP_EXEC_READ_UNSUPPORTED");
    return { ...identity, path: text(success, 1), content, totalLines: unsigned(success, 3, 0x7fff_ffff),
      fileSize: unsigned(success, 4), resultBytes };
  }
  if (unsigned(success, 3, 0x7fff_ffff) !== 0 || optionalText(success, 4)
    || boolean(result, 102) || unsigned(success, 14) || unsigned(success, 17)) fail("CURSOR_APP_EXEC_SHELL_UNSUPPORTED");
  return { ...identity, command: text(success, 1), workingDirectory: text(success, 2),
    stdout: optionalText(success, 5), stderr: optionalText(success, 6), exitCode: 0, resultBytes };
}

function execControl(body) {
  const control = fields(body);
  if (control.size !== 1) fail("CURSOR_APP_PROTO_FIELD");
  const number = [...control.keys()][0];
  if (![1, 2, 3].includes(number)) fail("CURSOR_APP_CLIENT_MESSAGE_UNSUPPORTED");
  const detail = fields(single(control, number, 2)), id = unsigned(detail, 1, 0xffff_ffff, true);
  if (!id) fail("CURSOR_APP_EXEC_IDENTITY");
  if ([...detail.keys()].some((field) => !(number === 2 ? [1, 2, 3, 4] : [1]).includes(field))) fail("CURSOR_APP_CLIENT_MESSAGE_UNSUPPORTED");
  if (number === 2) for (const field of [2, 3, 4]) optionalText(detail, field);
  return { type: "execControl", id, event: number === 1 ? "close" : number === 2 ? "error" : "heartbeat" };
}

// Minimal agent.v1 wire contract from the official Cursor App 3.21.18 bundle.
// Unknown request context is retained as bytes, never treated as prompt content.
export function decodeAgentClientMessage(message, options = {}) {
  try { return decodeClientMessage(message, options); }
  catch (error) {
    if (error.code === "CURSOR_APP_CLIENT_MESSAGE_UNSUPPORTED") error.wireShape = unsupportedWireShape(message);
    throw error;
  }
}

function unsupportedWireShape(message) {
  const shape = {};
  function layer(name, bytes) {
    const source = fields(bytes), entries = [];
    shape[name] = entries;
    for (const [number, values] of source) for (const { wire } of values) {
      entries.push({ number, wire });
      if (entries.length === 16) return source;
    }
    return source;
  }
  try {
    const outer = layer("outer", message);
    if (outer.has(4)) {
      const action = layer("action", single(outer, 4, 2));
      if (action.has(3)) {
        const cancel = layer("cancel", single(action, 3, 2)), reason = optionalText(cancel, 1);
        shape.cancelReason = CANCELLATION_REASONS.has(reason) ? reason : "other";
      }
    } else if (outer.has(2)) {
      const exec = layer("exec", single(outer, 2, 2)), kind = [2, 7, 10, 14].find((number) => exec.has(number));
      if (kind !== undefined) {
        const result = layer("result", single(exec, kind, 2)), variant = [1, 2, 3, 4, 5, 6, 7, 8, 9].find((number) => result.has(number));
        if (variant !== undefined) layer("detail", single(result, variant, 2));
      }
    } else if (outer.has(5)) {
      const control = layer("exec", single(outer, 5, 2)), variant = [1, 2, 3].find((number) => control.has(number));
      if (variant !== undefined) layer("result", single(control, variant, 2));
    }
  } catch {}
  return shape;
}

function decodeClientMessage(message, { requestId, allowCancellation = false } = {}) {
  const outer = fields(message);
  if (outer.size !== 1) fail("CURSOR_APP_PROTO_FIELD");
  const number = [...outer.keys()][0], body = single(outer, number, 2);
  if (number === 7) {
    fields(body);
    return { type: "heartbeat" };
  }
  if (number === 2) return execClient(body);
  if (number === 5) return execControl(body);
  if (number === 4 && allowCancellation === true) {
    const action = fields(body);
    if (action.size !== 1 || !action.has(3)) fail("CURSOR_APP_CLIENT_MESSAGE_UNSUPPORTED");
    const cancel = fields(single(action, 3, 2));
    if (cancel.size !== 1 || !cancel.has(1) || !CANCELLATION_REASONS.has(text(cancel, 1))) {
      fail("CURSOR_APP_CLIENT_MESSAGE_UNSUPPORTED");
    }
    return { type: "cancelAction" };
  }
  if (number === 3) {
    const ack = fields(body);
    if ([...ack.keys()].some((number) => ![1, 2, 3].includes(number))) fail("CURSOR_APP_CLIENT_MESSAGE_UNSUPPORTED");
    if (ack.has(2) === ack.has(3)) fail("CURSOR_APP_PROTO_FIELD");
    const reading = ack.has(2), id = single(ack, 1, 0), result = fields(single(ack, reading ? 2 : 3, 2));
    if (id < 1n || id > 0xffff_ffffn) fail("CURSOR_APP_KV_ID");
    if ([...result.keys()].some((number) => !(reading ? [1, 2] : [1]).includes(number))) fail("CURSOR_APP_CLIENT_MESSAGE_UNSUPPORTED");
    const error = single(result, reading ? 2 : 1, 2, false);
    if (error !== undefined) fields(error);
    if (reading) {
      const data = single(result, 1, 2, false);
      return { type: "kvGetResult", id: Number(id), ...(data === undefined ? {} : { bytes: Buffer.from(data) }),
        ...(error === undefined ? {} : { error: "CURSOR_APP_KV_READ_FAILED" }) };
    }
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
  const context = single(userAction, 2, 2, false), partsBytes = single(action, 17, 2, false);
  const parts = partsBytes === undefined ? undefined : fields(partsBytes);
  const skillsBlobId = parts && single(parts, 3, 2, false), dynamic = parts && single(parts, 9, 2, false);
  return { type: "run", requestId, conversationId, ...userMessage(userMessageBytes), userMessageBytes, conversationStateBytes, turnRefs,
    ...(context === undefined ? {} : { requestContext: requestContext(context) }),
    ...(parts === undefined ? {} : { requestContextParts: {
      ...(skillsBlobId === undefined ? {} : { skillsBlobId: Buffer.from(skillsBlobId), skillsByteLength: unsigned(parts, 4) }),
      ...(dynamic === undefined ? {} : { dynamicContext: requestContext(dynamic) }),
    } }) };
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

export function createGetBlobMessage({ id, blobId }) {
  if (!Number.isInteger(id) || id < 1 || id > 0xffff_ffff) fail("CURSOR_APP_KV_ID");
  const reference = bytes(blobId);
  if (reference.length !== 32) fail("CURSOR_APP_PROTO_REFERENCE");
  return field(4, Buffer.concat([scalar(1, id), field(2, field(1, reference))]));
}

export function createExecAbortMessage(id) {
  if (!Number.isInteger(id) || id < 1 || id > 0xffff_ffff) fail("CURSOR_APP_EXEC_IDENTITY");
  return field(5, field(1, scalar(1, id)));
}

function toolCall(execution, resultBytes) {
  return Buffer.concat([field(execution.kind === "read" ? 8 : 1, Buffer.concat([field(1, execution.toolArgsBytes),
    ...(resultBytes === undefined ? [] : [field(2, resultBytes)])])), field(57, execution.toolCallId)]);
}
function toolUpdate(execution, toolBytes, completed) {
  return field(1, field(completed ? 3 : 2, Buffer.concat([field(1, execution.toolCallId), field(2, toolBytes)])));
}

export function createToolExecution(run, step, { id, toolCallId }) {
  if (!Number.isInteger(id) || id < 1 || id > 0xffff_ffff) fail("CURSOR_APP_EXEC_IDENTITY");
  identity(toolCallId);
  if (step?.kind === "requestContext" && Object.keys(step).length === 1) {
    return { kind: step.kind, id, toolCallId, execMessage: field(2, Buffer.concat([scalar(1, id), field(15, toolCallId),
      field(10, Buffer.concat([field(2, identity(run.conversationId)), scalar(7, 0)]))])) };
  }
  const validText = (value) => typeof value === "string" && value.trim() && !value.includes("\0")
    && Buffer.byteLength(value) <= 16_384 && Buffer.from(value).toString("utf8") === value;
  let argsBytes, toolArgsBytes;
  if (step?.kind === "read" && validText(step.path) && Object.keys(step).every((key) => ["kind", "path"].includes(key))) {
    toolArgsBytes = field(1, step.path);
    argsBytes = Buffer.concat([toolArgsBytes, field(2, toolCallId)]);
  } else if (step?.kind === "shell" && validText(step.command) && validText(step.workingDirectory)
    && Number.isInteger(step.timeoutMs) && step.timeoutMs > 0 && step.timeoutMs <= 60_000
    && Object.keys(step).every((key) => ["kind", "command", "workingDirectory", "timeoutMs"].includes(key))) {
    argsBytes = Buffer.concat([field(1, step.command), field(2, step.workingDirectory), scalar(3, step.timeoutMs), field(4, toolCallId),
      // No invented command parse or approval bypass: the App owns permission review.
      field(8, scalar(1, 1)), scalar(13, 1), scalar(14, step.timeoutMs), scalar(17, 1),
      field(21, identity(run.conversationId)), field(23, identity(run.requestId))]);
    toolArgsBytes = argsBytes;
  } else fail("CURSOR_APP_EXEC_OPTIONS");
  const execution = { ...step, id, toolCallId, toolArgsBytes };
  return { ...execution, startedMessage: toolUpdate(execution, toolCall(execution), false),
    execMessage: field(2, Buffer.concat([scalar(1, id), field(15, toolCallId), field(step.kind === "read" ? 7 : 2, argsBytes)])) };
}

export function completeToolExecution(execution, message) {
  if (message.type !== "execResult" || message.id !== execution.id || message.kind !== execution.kind
    || message.execId && message.execId !== execution.toolCallId) fail("CURSOR_APP_EXEC_IDENTITY");
  if (message.error) fail("CURSOR_APP_EXEC_REJECTED");
  if (execution.kind === "requestContext") return { result: message.requestContext, requestContextBytes: message.requestContextBytes };
  let result, resultBytes;
  if (execution.kind === "read") {
    if (message.path !== execution.path) fail("CURSOR_APP_EXEC_IDENTITY");
    result = { kind: "read", path: message.path, content: message.content, totalLines: message.totalLines, fileSize: message.fileSize };
    resultBytes = field(1, Buffer.concat([field(1, message.content), scalar(4, message.totalLines), scalar(5, message.fileSize), field(7, message.path)]));
  } else {
    if (message.command !== execution.command || message.workingDirectory !== execution.workingDirectory) fail("CURSOR_APP_EXEC_IDENTITY");
    result = { kind: "shell", command: message.command, workingDirectory: message.workingDirectory,
      stdout: message.stdout, stderr: message.stderr, exitCode: message.exitCode };
    resultBytes = message.resultBytes;
  }
  const toolBytes = toolCall(execution, resultBytes);
  return { result, stepBytes: field(2, toolBytes), completedMessage: toolUpdate(execution, toolBytes, true) };
}

export function createCompletedTurn(run, { answer, firstKvId = 1, toolSteps = [] } = {}) {
  if (typeof answer !== "string" || !answer.trim() || Buffer.from(answer).toString("utf8") !== answer) fail("CURSOR_APP_RESPONSE_TEXT");
  if (!Array.isArray(toolSteps) || toolSteps.length > 8) fail("CURSOR_APP_EXEC_OPTIONS");
  for (const step of toolSteps) { const parsed = fields(step); if (parsed.size !== 1 || !parsed.has(2)) fail("CURSOR_APP_EXEC_OPTIONS"); single(parsed, 2, 2); }
  if (!Number.isInteger(firstKvId) || firstKvId < 1 || firstKvId > 0xffff_fffd - toolSteps.length) fail("CURSOR_APP_KV_ID");
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
  const userBlobId = blob(run.userMessageBytes), stepBlobIds = [...toolSteps.map(blob), blob(field(1, field(1, answer)))];
  const turnBlobId = blob(field(1, Buffer.concat([field(1, userBlobId), ...stepBlobIds.map((id) => field(2, id)), field(3, run.requestId)])));
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
