import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { connect as connectHttp2, constants as http2Constants } from "node:http2";
import { connect, createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { startCursorAgentMock } from "./cursor-app-mock-server.mjs";

const agentPath = "/agent.v1.AgentService/Run";
const requestId = "11111111-1111-4111-8111-111111111111";
const conversationId = "22222222-2222-4222-8222-222222222222";
const userMessageId = "33333333-3333-4333-8333-333333333333";
const prompt = "Synthetic Cursor prompt\nSecond line";
const answer = "Synthetic Cursor answer\nSecond line";

function varint(value) {
  const bytes = [];
  do { bytes.push((value & 127) | (value > 127 ? 128 : 0)); value = Math.floor(value / 128); } while (value);
  return Buffer.from(bytes);
}
function scalar(number, value) { return Buffer.concat([varint(number * 8), varint(value)]); }
function field(number, value) {
  const bytes = Buffer.from(value);
  return Buffer.concat([varint(number * 8 + 2), varint(bytes.length), bytes]);
}
function runMessage(state = Buffer.alloc(0), { text = prompt, session = conversationId, userId = userMessageId } = {}) {
  const user = Buffer.concat([field(1, text), field(2, userId)]);
  return field(1, Buffer.concat([field(1, state), field(2, field(1, field(1, user))), field(5, session)]));
}
function acknowledgement(id, failed = false) {
  return field(3, Buffer.concat([scalar(1, id), field(3, failed ? field(1, field(1, "private-error-canary")) : Buffer.alloc(0))]));
}
function readResult(id, bytes, failed = false) {
  const result = Buffer.concat([bytes === undefined ? Buffer.alloc(0) : field(1, bytes),
    failed ? field(2, field(1, "private-error-canary")) : Buffer.alloc(0)]);
  return field(3, Buffer.concat([scalar(1, id), field(2, result)]));
}
function readRequest(id, blobId) { return field(4, Buffer.concat([scalar(1, id), field(2, field(1, blobId))])); }
function identity(number) { return `${number.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`; }
function frame(message, compression = "identity") {
  const bytes = compression === "gzip" ? gzipSync(message) : message;
  const header = Buffer.alloc(5);
  header[0] = compression === "gzip" ? 1 : 0;
  header.writeUInt32BE(bytes.length, 1);
  return Buffer.concat([header, bytes]);
}
async function mock(t, options) {
  const server = await startCursorAgentMock({ answer, ...options });
  t.after(() => server.close());
  return server;
}
async function waitFor(predicate) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "local mock condition timed out");
    await delay(5);
  }
}
function openRun(t, server, { compression = "identity", headers = {}, url = server.url } = {}) {
  const client = connectHttp2(url);
  const clientErrors = [];
  client.on("error", (error) => clientErrors.push(error.code));
  t.after(() => client.destroy());
  const request = client.request({ ":method": "POST", ":path": agentPath,
    "content-type": "application/connect+proto", "x-request-id": requestId,
    "connect-content-encoding": compression, ...headers });
  const frames = [];
  let pending = Buffer.alloc(0), status;
  request.on("response", (response) => { status = response[":status"]; });
  request.on("error", (error) => clientErrors.push(error.code));
  request.on("data", (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 5 && pending.length >= 5 + pending.readUInt32BE(1)) {
      const length = pending.readUInt32BE(1);
      frames.push({ flags: pending[0], body: pending.subarray(5, 5 + length) });
      pending = pending.subarray(5 + length);
    }
  });
  const done = new Promise((resolve) => request.once("end", () => { request.end(); resolve(); }));
  return { client, request, frames, done, clientErrors, get status() { return status; },
    send(message) { request.write(frame(message, compression)); } };
}
async function ancillary(server, path, method = "POST", { includeHeaders = false } = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(`${server.url}${path}`, { method,
      headers: { authorization: "synthetic-header-canary", "content-type": "application/json" } }, (response) => {
      let body = "";
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, body,
        ...(includeHeaders ? { headers: response.headers } : {}) }));
      response.on("error", reject);
    });
    request.on("error", reject);
    request.end(method === "POST" ? '{"value":"synthetic-body-canary"}' : undefined);
  });
}
async function fragmentPreface(t, server) {
  const sockets = new Set();
  const proxy = createServer((downstream) => {
    const upstream = connect({ host: "127.0.0.1", port: Number(new URL(server.url).port) });
    for (const socket of [upstream, downstream]) { sockets.add(socket); socket.on("error", () => {}); }
    downstream.once("close", () => upstream.destroy());
    upstream.pipe(downstream);
    downstream.once("data", async (first) => {
      downstream.pause();
      for (const byte of first.subarray(0, 24)) { upstream.write(Buffer.from([byte])); await delay(1); }
      upstream.write(first.subarray(24));
      downstream.pipe(upstream);
      downstream.resume();
    });
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => proxy.close(resolve));
  });
  return `http://127.0.0.1:${proxy.address().port}`;
}
function assertFailed(server, stream, code, { writes = 1, acks = 0 } = {}) {
  assert.equal(server.runs[0]?.completed, false);
  assert.equal(server.runs[0]?.kvWriteCount, writes);
  assert.equal(server.runs[0]?.kvAckCount, acks);
  assert.equal(stream.frames.filter((entry) => entry.flags === 0).length, writes);
  assert.deepEqual(JSON.parse(stream.frames.at(-1).body), { error: { code: "invalid_argument", message: code } });
  assert.deepEqual(server.errors, [code]);
}
async function completedRun(t, server, { prior = [], session = conversationId, text = prompt, expectedAnswer = answer } = {}) {
  const index = server.runs.length;
  const stream = openRun(t, server, { headers: { "x-request-id": identity(index + 10) }, compression: "gzip" });
  const state = Buffer.concat([scalar(10, 1), ...prior.map((run) => field(8, run.turnBlobId))]);
  stream.send(runMessage(state, { session, text, userId: identity(index + 100) }));
  const reads = prior.flatMap((run) => run.kvWrites);
  for (const [index, read] of reads.entries()) {
    await waitFor(() => stream.frames.length === index + 1);
    assert.deepEqual(stream.frames[index], { flags: 0, body: readRequest(index + 1, read.blobId) });
    assert.equal(server.runs.at(-1).kvWriteCount, 0);
    stream.send(readResult(index + 1, read.bytes));
  }
  for (let index = 0; index < 3; index++) {
    await waitFor(() => stream.frames.length === reads.length + index + 1);
    stream.send(acknowledgement(reads.length + index + 1));
  }
  await stream.done;
  const run = server.runs.at(-1);
  assert.equal(run.completed, true);
  assert.deepEqual(run.kvWrites.map((write) => write.id), [reads.length + 1, reads.length + 2, reads.length + 3]);
  assert.deepEqual(stream.frames, [
    ...reads.map((read, index) => ({ flags: 0, body: readRequest(index + 1, read.blobId) })),
    ...run.kvWrites.map((write) => ({ flags: 0, body: write.message })),
    { flags: 0, body: field(3, run.conversationStateBytes) },
    { flags: 0, body: field(1, field(1, field(1, expectedAnswer))) },
    { flags: 0, body: field(1, field(14, Buffer.alloc(0))) }, { flags: 2, body: Buffer.from("{}") },
  ]);
  return run;
}

test("ordinary HTTP/1 ancillary services share the local port and retain only route metadata", async (t) => {
  const server = await mock(t);
  for (const path of ["/auth/full_stripe_profile", "/aiserver.v1.DashboardService/GetMe",
    "/aiserver.v1.AiService/AvailableModels", "/aiserver.v1.ServerConfigService/GetServerConfig"]) {
    assert.deepEqual(await ancillary(server, `${path}?secret=synthetic-query-canary`), { status: 200, body: "{}" });
  }
  assert.deepEqual(await ancillary(server, "/synthetic-path-canary"), { status: 404, body: "{}" });
  assert.deepEqual(server.requests.at(-1), { method: "POST", path: "<unknown>", protocol: "http/1.1" });
  assert.equal(server.requests.length, 5);
  assert.equal(JSON.stringify({ requests: server.requests, errors: server.errors }).includes("canary"), false);
  assert.deepEqual(server.errors, []);
  assert.equal(server.ancillaryRequestCount, 5);
  assert.equal(server.unsupportedRpcCount, 1);
});

test("known ancillary services accept browser preflights with fixed CORS headers", async (t) => {
  const server = await mock(t);
  const preflight = await ancillary(server, "/auth/full_stripe_profile", "OPTIONS", { includeHeaders: true });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.body, "");
  assert.equal(preflight.headers["access-control-allow-origin"], "*");
  assert.equal(preflight.headers["access-control-allow-methods"], "GET, POST, OPTIONS");
  assert.equal(preflight.headers["access-control-allow-headers"], "content-type, authorization");
  const response = await ancillary(server, "/auth/full_stripe_profile", "GET", { includeHeaders: true });
  assert.equal(response.headers["access-control-allow-origin"], "*");
  assert.equal(response.status, 200);
  assert.deepEqual(server.errors, []);
});

test("private unknown RPC diagnostics retain only bounded service and method paths", async (t) => {
  const server = await mock(t);
  const stream = openRun(t, server, { headers: { ":path": "/aiserver.v1.FixtureService/UnknownMethod?token=private-query-canary" } });
  await stream.done;
  await ancillary(server, "/aiserver.v1.FixtureService/UnknownMethod");
  await ancillary(server, "/private-path-canary/invalid-method");
  await ancillary(server, `/aiserver.v1.FixtureService/${"A".repeat(160)}`);
  assert.deepEqual(server.unknownRpcMethods, ["/aiserver.v1.FixtureService/UnknownMethod"]);
  assert.deepEqual(server.errors, []);
  assert.equal(server.ancillaryRequestCount, 4);
  assert.equal(server.unsupportedRpcCount, 4);
  assert.ok(server.requests.every((request) => request.path === "<unknown>"));
  assert.equal(JSON.stringify({ requests: server.requests, errors: server.errors }).includes("canary"), false);
});

test("HTTP/1 Agent requests and unsupported Agent methods remain fatal transport errors", async (t) => {
  const server = await mock(t);
  assert.deepEqual(await ancillary(server, agentPath), { status: 404, body: "{}" });
  const stream = openRun(t, server, { headers: { ":path": "/agent.v1.AgentService/UnknownMethod" } });
  await stream.done;
  assert.deepEqual(server.errors, ["CURSOR_AGENT_HTTP2_REQUIRED", "CURSOR_AGENT_ROUTE_INVALID"]);
  assert.equal(server.ancillaryRequestCount, 0);
  assert.equal(server.unsupportedRpcCount, 0);
  assert.deepEqual(server.runs, []);
});

test("known metadata, model-picker nudge and log RPCs remain rejected auxiliary requests without accepting their content", async (t) => {
  const server = await mock(t);
  for (const path of ["/agent.v1.AgentService/UpdateConversationMetadata",
    "/agent.v1.AgentService/GetNewChatNudgeParameterizedModelPicker", "/aiserver.v1.AnalyticsService/SubmitLogs"]) {
    const stream = openRun(t, server, { headers: { ":path": path } });
    stream.request.write(frame(field(1, "synthetic-log-payload-canary")));
    await stream.done;
    assert.equal(stream.status, 404);
  }
  assert.deepEqual(server.errors, []);
  assert.deepEqual(server.runs, []);
  assert.equal(server.ancillaryRequestCount, 3);
  assert.equal(server.unsupportedRpcCount, 3);
  assert.equal(JSON.stringify({ requests: server.requests, diagnostics: server.unknownRpcMethods }).includes("canary"), false);
});

test("the model-picker auxiliary exception does not permit neighboring Agent RPCs", async (t) => {
  const server = await mock(t);
  for (const path of ["/agent.v1.AgentService/GetNewChatNudgeParameterizedModelPickerExtra",
    "/agent.v2.AgentService/GetNewChatNudgeParameterizedModelPicker"]) {
    const stream = openRun(t, server, { headers: { ":path": path } });
    await stream.done;
    assert.equal(stream.status, 404);
  }
  assert.deepEqual(server.errors, ["CURSOR_AGENT_ROUTE_INVALID", "CURSOR_AGENT_ROUTE_INVALID"]);
  assert.equal(server.ancillaryRequestCount, 0);
  assert.equal(server.unsupportedRpcCount, 0);
  assert.deepEqual(server.runs, []);
});

test("fragmented h2c prefaces and gzip Connect frames complete only after sequential KV acknowledgements", async (t) => {
  const server = await mock(t);
  const url = await fragmentPreface(t, server);
  const stream = openRun(t, server, { compression: "gzip", url });
  const state = scalar(10, 1);
  const wire = frame(runMessage(state), "gzip");
  for (const [start, end] of [[0, 1], [1, 3], [3, 9], [9, wire.length]]) {
    stream.request.write(wire.subarray(start, end));
    await delay(3);
  }
  await waitFor(() => stream.frames.length === 1);
  stream.send(field(7, Buffer.alloc(0)));
  await delay(20);
  assert.equal(stream.frames.length, 1);
  assert.equal(server.runs[0].kvWriteCount, 1);
  assert.equal(server.runs[0].kvAckCount, 0);
  for (const id of [1, 2]) {
    stream.send(acknowledgement(id));
    await waitFor(() => stream.frames.length === id + 1);
    assert.equal(server.runs[0].completed, false);
  }
  stream.send(acknowledgement(3));
  await stream.done;
  const run = server.runs[0];
  assert.equal(run.requestId, requestId);
  assert.equal(run.conversationId, conversationId);
  assert.equal(run.userMessageId, userMessageId);
  assert.equal(run.prompt, prompt);
  assert.deepEqual(run.inputConversationStateBytes, state);
  assert.deepEqual(run.conversationStateBytes, Buffer.concat([state, field(8, run.turnBlobId)]));
  assert.equal(run.kvWriteCount, 3);
  assert.equal(run.kvAckCount, 3);
  assert.equal(run.kvReadCount, 0);
  assert.equal(run.kvReadResultCount, 0);
  assert.equal(run.completed, true);
  assert.deepEqual(stream.frames, [
    ...run.kvWrites.map((write) => ({ flags: 0, body: write.message })),
    { flags: 0, body: field(3, run.conversationStateBytes) },
    { flags: 0, body: field(1, field(1, field(1, answer))) },
    { flags: 0, body: field(1, field(14, Buffer.alloc(0))) }, { flags: 2, body: Buffer.from("{}") },
  ]);
  assert.equal(stream.status, 200);
  assert.deepEqual(stream.clientErrors, []);
  assert.deepEqual(server.errors, []);
  assert.deepEqual(server.requests, [{ method: "POST", path: agentPath, protocol: "h2c" }]);
  assert.deepEqual(await ancillary(server, "/aiserver.v1.AnalyticsService/Batch"), { status: 200, body: "{}" });
});

test("four runs verify per-session history before writes across fresh client connections", async (t) => {
  const answers = [answer, "Second synthetic answer", answer, "Restarted synthetic answer"];
  const server = await mock(t, { answers });
  const first = await completedRun(t, server);
  const second = await completedRun(t, server, { prior: [first], expectedAnswer: answers[1] });
  const isolated = await completedRun(t, server, { session: identity(500) });
  const resumed = await completedRun(t, server, { prior: [first, second], text: "Synthetic prompt after restart", expectedAnswer: answers[3] });
  assert.deepEqual(server.runs.map((run) => run.kvReadCount), [0, 3, 0, 6]);
  assert.deepEqual(server.runs.map((run) => run.kvReadResultCount), [0, 3, 0, 6]);
  assert.deepEqual(server.runs.map((run) => run.turnRefs.length), [0, 1, 0, 2]);
  assert.ok(server.runs.every((run) => run.kvWriteCount === 3 && run.kvAckCount === 3));
  assert.notEqual(first.userMessageId, second.userMessageId);
  assert.notEqual(first.requestId, second.requestId);
  assert.equal(first.prompt, second.prompt);
  assert.equal(first.prompt, isolated.prompt);
  assert.notDeepEqual(first.turnBlobId, isolated.turnBlobId);
  assert.deepEqual(first.kvWrites[1].bytes, isolated.kvWrites[1].bytes);
  assert.deepEqual(resumed.turnRefs, [first.turnBlobId, second.turnBlobId]);
  assert.deepEqual(server.errors, []);
  const extra = openRun(t, server, { headers: { "x-request-id": identity(600) } });
  extra.send(runMessage(Buffer.alloc(0), { session: identity(601) }));
  await extra.done;
  assert.equal(server.runs.length, 4);
  assert.deepEqual(server.errors, ["CURSOR_AGENT_ANSWER_EXHAUSTED"]);
});

test("answer sequences reject invalid fixtures and do not require the legacy answer option", async (t) => {
  for (const answers of [[], "not-an-array", [""], ["  "], [1]]) {
    await assert.rejects(startCursorAgentMock({ answer, answers }), { nativeCode: "CURSOR_MOCK_OPTIONS_INVALID" });
  }
  const server = await mock(t, { answer: undefined, answers: [answer] });
  await completedRun(t, server);
  assert.deepEqual(server.errors, []);
});

test("unknown, missing, reordered, duplicated and cross-session histories fail before GET or SET", async (t) => {
  const server = await mock(t);
  const first = await completedRun(t, server);
  const second = await completedRun(t, server, { prior: [first] });
  const other = await completedRun(t, server, { session: identity(500) });
  for (const [index, refs] of [[], [first.turnBlobId], [second.turnBlobId, first.turnBlobId],
    [first.turnBlobId, first.turnBlobId], [first.turnBlobId, other.turnBlobId], [Buffer.alloc(32, 7)]].entries()) {
    const stream = openRun(t, server, { headers: { "x-request-id": identity(index + 600) } });
    stream.send(runMessage(Buffer.concat(refs.map((ref) => field(8, ref))), { session: index === 5 ? identity(700) : conversationId }));
    await stream.done;
    assert.equal(stream.frames.length, 1);
    assert.equal(stream.frames[0].flags, 2);
    assert.equal(server.errors.at(-1), "CURSOR_AGENT_HISTORY_MISMATCH");
    assert.equal(server.runs.length, 3);
  }
});

test("same-session runs are locked until the previous stream completes or fails", async (t) => {
  const server = await mock(t);
  const first = openRun(t, server);
  first.send(runMessage());
  await waitFor(() => first.frames.length === 1);
  const concurrent = openRun(t, server, { headers: { "x-request-id": identity(600) } });
  concurrent.send(runMessage());
  await concurrent.done;
  assert.deepEqual(server.errors, ["CURSOR_AGENT_CONVERSATION_BUSY"]);
  assert.equal(server.runs.length, 1);
  first.send(acknowledgement(1, true));
  await first.done;
  await completedRun(t, server);
  assert.equal(server.runs[0].completed, false);
  assert.equal(server.runs[1].turnRefs.length, 0);
});

test("invalid KV reads fail without new writes, checkpoints or content", async (t) => {
  for (const kind of ["unknown", "duplicate", "failed", "missing", "empty", "mismatch", "wrong-type", "ended", "timeout"]) {
    await t.test(kind, async (t) => {
      const server = await mock(t, { timeoutMs: kind === "timeout" ? 250 : 15_000 });
      const first = await completedRun(t, server);
      const stream = openRun(t, server, { headers: { "x-request-id": identity(600) } });
      stream.send(runMessage(field(8, first.turnBlobId)));
      await waitFor(() => stream.frames.length === 1);
      if (kind === "duplicate") {
        stream.send(readResult(1, first.kvWrites[0].bytes));
        await waitFor(() => stream.frames.length === 2);
      }
      if (kind === "ended") stream.request.end();
      else if (kind === "wrong-type") stream.send(acknowledgement(1));
      else if (kind !== "timeout") stream.send(readResult(kind === "unknown" ? 999 : 1,
        kind === "missing" ? undefined : kind === "empty" ? Buffer.alloc(0)
          : kind === "mismatch" ? Buffer.from("private-mismatch-canary") : first.kvWrites[0].bytes, kind === "failed"));
      await stream.done;
      const code = { unknown: "CURSOR_AGENT_UNKNOWN_KV_READ", duplicate: "CURSOR_AGENT_DUPLICATE_KV_READ",
        failed: "CURSOR_AGENT_KV_READ_REJECTED", missing: "CURSOR_AGENT_KV_READ_MISSING", empty: "CURSOR_AGENT_KV_READ_MISSING",
        mismatch: "CURSOR_AGENT_KV_READ_MISMATCH", "wrong-type": "CURSOR_AGENT_KV_RESULT_MISMATCH",
        ended: "CURSOR_AGENT_KV_READ_MISSING", timeout: "CURSOR_AGENT_TIMEOUT" }[kind];
      assert.deepEqual(server.errors, [code]);
      const run = server.runs[1];
      assert.equal(run.completed, false);
      assert.equal(run.kvWriteCount, 0);
      assert.equal(run.kvAckCount, 0);
      assert.equal(run.kvReadCount, kind === "duplicate" ? 2 : 1);
      assert.equal(run.kvReadResultCount, kind === "duplicate" ? 1 : 0);
      assert.equal(stream.frames.filter((entry) => entry.flags === 0).length, run.kvReadCount);
      assert.equal(JSON.stringify(server.errors).includes("canary"), false);
    });
  }
});

test("duplicate final GET in one chunk fails before the first new write", async (t) => {
  const server = await mock(t);
  const first = await completedRun(t, server);
  const stream = openRun(t, server, { headers: { "x-request-id": identity(600) } });
  stream.send(runMessage(field(8, first.turnBlobId)));
  for (const index of [0, 1]) {
    await waitFor(() => stream.frames.length === index + 1);
    stream.send(readResult(index + 1, first.kvWrites[index].bytes));
  }
  await waitFor(() => stream.frames.length === 3);
  const last = frame(readResult(3, first.kvWrites[2].bytes));
  stream.request.write(Buffer.concat([last, last]));
  await stream.done;
  assert.deepEqual(server.errors, ["CURSOR_AGENT_DUPLICATE_KV_READ"]);
  assert.equal(server.runs[1].kvReadResultCount, 3);
  assert.equal(server.runs[1].kvWriteCount, 0);
  assert.equal(server.runs[1].completed, false);
});

test("a failed continuation releases its lock without adding an uncompleted turn to history", async (t) => {
  const server = await mock(t);
  const first = await completedRun(t, server);
  const failed = openRun(t, server, { headers: { "x-request-id": identity(600) } });
  failed.send(runMessage(field(8, first.turnBlobId)));
  for (const [index, write] of first.kvWrites.entries()) {
    await waitFor(() => failed.frames.length === index + 1);
    failed.send(readResult(index + 1, write.bytes));
  }
  await waitFor(() => failed.frames.length === 4);
  failed.send(acknowledgement(4, true));
  await failed.done;
  const next = await completedRun(t, server, { prior: [first] });
  assert.equal(server.runs[1].completed, false);
  assert.deepEqual(next.turnRefs, [first.turnBlobId]);
  assert.equal(next.kvReadResultCount, 3);
  assert.deepEqual(server.errors, ["CURSOR_AGENT_KV_REJECTED"]);
});

test("unknown, duplicate and failed KV acknowledgements never emit a completed turn", async (t) => {
  for (const kind of ["unknown", "duplicate", "failed", "wrong-type"]) {
    await t.test(kind, async (t) => {
      const server = await mock(t);
      const stream = openRun(t, server);
      stream.send(runMessage());
      await waitFor(() => stream.frames.length === 1);
      if (kind === "duplicate") {
        stream.send(acknowledgement(1));
        await waitFor(() => stream.frames.length === 2);
      }
      stream.send(kind === "wrong-type" ? readResult(1, Buffer.from("private-error-canary"))
        : acknowledgement(kind === "unknown" ? 999 : 1, kind === "failed"));
      await stream.done;
      const code = kind === "unknown" ? "CURSOR_AGENT_UNKNOWN_ACK"
        : kind === "duplicate" ? "CURSOR_AGENT_DUPLICATE_ACK" : kind === "wrong-type"
          ? "CURSOR_AGENT_KV_RESULT_MISMATCH" : "CURSOR_AGENT_KV_REJECTED";
      assertFailed(server, stream, code, kind === "duplicate" ? { writes: 2, acks: 1 } : {});
      assert.equal(JSON.stringify(server.errors).includes("private-error-canary"), false);
    });
  }
});

test("an ended request with a missing acknowledgement fails without checkpoint or text", async (t) => {
  const server = await mock(t);
  const stream = openRun(t, server);
  stream.request.end(frame(runMessage()));
  await stream.done;
  assertFailed(server, stream, "CURSOR_AGENT_ACK_MISSING");
});

test("an unacknowledged run times out without completing", async (t) => {
  const server = await mock(t, { timeoutMs: 150 });
  const stream = openRun(t, server);
  stream.send(runMessage());
  await stream.done;
  assertFailed(server, stream, "CURSOR_AGENT_TIMEOUT");
});

test("a duplicated final acknowledgement in the same chunk prevents completion", async (t) => {
  const server = await mock(t);
  const stream = openRun(t, server);
  stream.send(runMessage());
  await waitFor(() => stream.frames.length === 1);
  for (const id of [1, 2]) {
    stream.send(acknowledgement(id));
    await waitFor(() => stream.frames.length === id + 1);
  }
  stream.request.write(Buffer.concat([frame(acknowledgement(3)), frame(acknowledgement(3))]));
  await stream.done;
  assertFailed(server, stream, "CURSOR_AGENT_DUPLICATE_ACK", { writes: 3, acks: 3 });
});

test("client cancellation records an incomplete run and releases its stream", async (t) => {
  const server = await mock(t);
  const stream = openRun(t, server);
  stream.send(runMessage());
  await waitFor(() => stream.frames.length === 1);
  stream.request.close(http2Constants.NGHTTP2_CANCEL);
  await waitFor(() => server.errors.length === 1);
  assert.ok(["CURSOR_AGENT_ACK_MISSING", "CURSOR_AGENT_STREAM_ABORTED"].includes(server.errors[0]));
  assert.equal(server.runs[0].completed, false);
  assert.equal(server.runs[0].kvAckCount, 0);
});

test("duplicate runs are rejected within a stream and across requests", async (t) => {
  for (const secondStream of [false, true]) {
    await t.test(secondStream ? "duplicate request identity" : "duplicate Run message", async (t) => {
      const server = await mock(t);
      const first = openRun(t, server);
      first.send(runMessage());
      await waitFor(() => first.frames.length === 1);
      const duplicate = secondStream ? openRun(t, server) : first;
      duplicate.send(runMessage());
      await duplicate.done;
      assert.equal(server.runs.length, 1);
      assert.equal(server.runs[0].completed, false);
      assert.deepEqual(server.errors, ["CURSOR_AGENT_DUPLICATE_RUN"]);
      assert.equal(duplicate.frames.filter((entry) => entry.flags === 0).length, secondStream ? 0 : 1);
    });
  }
});

test("request identity, transport and route validation fail before accepting a run", async (t) => {
  for (const [headers, code] of [
    [{ "x-request-id": undefined }, "CURSOR_AGENT_REQUEST_ID_INVALID"],
    [{ "x-request-id": "synthetic-header-canary" }, "CURSOR_AGENT_REQUEST_ID_INVALID"],
    [{ "content-type": "application/json" }, "CURSOR_AGENT_ENCODING_INVALID"],
    [{ "connect-content-encoding": "br" }, "CURSOR_AGENT_ENCODING_INVALID"],
    [{ ":method": "GET" }, "CURSOR_MOCK_METHOD_INVALID"],
    [{ ":path": "/agent.v2.AgentService/Run" }, "CURSOR_AGENT_ROUTE_INVALID"],
  ]) {
    await t.test(code, async (t) => {
      const server = await mock(t);
      const stream = openRun(t, server, { headers });
      await stream.done;
      assert.deepEqual(server.runs, []);
      assert.deepEqual(server.errors, [code]);
      assert.equal(JSON.stringify(server.requests).includes("canary"), false);
      assert.equal(stream.frames.length, 1);
      assert.equal(stream.frames[0].flags, 2);
    });
  }
});

test("malformed, oversized and excessive messages are bounded and rejected", async (t) => {
  const oversized = Buffer.alloc(5);
  oversized.writeUInt32BE(8 * 1024 * 1024 + 1, 1);
  for (const [wire, end, code] of [
    [frame(field(8, Buffer.alloc(0))), false, "CURSOR_APP_CLIENT_MESSAGE_UNSUPPORTED"],
    [Buffer.from([0, 0]), true, "CURSOR_APP_CONNECT_TRUNCATED"],
    [oversized, false, "CURSOR_APP_CONNECT_FRAME_TOO_LARGE"],
    [Buffer.concat(Array.from({ length: 129 }, () => frame(field(7, Buffer.alloc(0))))), false, "CURSOR_AGENT_TOO_MANY_MESSAGES"],
    [frame(acknowledgement(1)), false, "CURSOR_AGENT_UNKNOWN_ACK"],
    [frame(readResult(1, Buffer.from("private-error-canary"))), false, "CURSOR_AGENT_UNKNOWN_KV_READ"],
  ]) {
    await t.test(code, async (t) => {
      const server = await mock(t);
      const stream = openRun(t, server);
      if (end) stream.request.end(wire); else stream.request.write(wire);
      await stream.done;
      assert.deepEqual(server.errors, [code]);
      assert.deepEqual(server.runs, []);
      assert.equal(stream.frames.length, 1);
    });
  }
});

test("close releases active h2 streams and partial-preface sockets and is idempotent", async (t) => {
  const server = await mock(t);
  const stream = openRun(t, server);
  stream.send(runMessage());
  await waitFor(() => stream.frames.length === 1);
  const port = Number(new URL(server.url).port);
  const partial = connect({ host: "127.0.0.1", port });
  partial.on("error", () => {});
  t.after(() => partial.destroy());
  await new Promise((resolve) => partial.once("connect", resolve));
  partial.write("PRI");
  const unrelated = createServer((socket) => socket.end("still available"));
  await new Promise((resolve) => unrelated.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => unrelated.close(resolve)));
  const closed = Promise.all([partial, stream.client].map((socket) => new Promise((resolve) => socket.once("close", resolve))));
  await Promise.all([server.close(), server.close()]);
  await closed;
  const unaffected = await new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port: unrelated.address().port });
    socket.once("data", (chunk) => resolve(chunk.toString()));
    socket.once("error", reject);
  });
  assert.equal(unaffected, "still available");
  const probe = createServer();
  await new Promise((resolve, reject) => { probe.once("error", reject); probe.listen(port, "127.0.0.1", resolve); });
  await new Promise((resolve) => probe.close(resolve));
  assert.equal(server.runs[0].completed, false);
  assert.deepEqual(server.errors, []);
});

test("partial protocol prefaces have a bounded lifetime", async (t) => {
  const server = await mock(t, { timeoutMs: 50 });
  const socket = connect({ host: "127.0.0.1", port: Number(new URL(server.url).port) });
  socket.on("error", () => {});
  t.after(() => socket.destroy());
  socket.write("P");
  await new Promise((resolve) => socket.once("close", resolve));
  assert.deepEqual(server.errors, []);
  assert.deepEqual(server.connectionErrors, ["CURSOR_MOCK_PREFACE_TIMEOUT"]);
  assert.deepEqual(server.requests, []);
});
