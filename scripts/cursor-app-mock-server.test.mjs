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
function runMessage(state = Buffer.alloc(0)) {
  const user = Buffer.concat([field(1, prompt), field(2, userMessageId)]);
  return field(1, Buffer.concat([field(1, state), field(2, field(1, field(1, user))), field(5, conversationId)]));
}
function acknowledgement(id, failed = false) {
  return field(3, Buffer.concat([scalar(1, id), field(3, failed ? field(1, field(1, "private-error-canary")) : Buffer.alloc(0))]));
}
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

test("known metadata and log RPCs remain rejected auxiliary requests without accepting their content", async (t) => {
  const server = await mock(t);
  for (const path of ["/agent.v1.AgentService/UpdateConversationMetadata", "/aiserver.v1.AnalyticsService/SubmitLogs"]) {
    const stream = openRun(t, server, { headers: { ":path": path } });
    stream.request.write(frame(field(1, "synthetic-log-payload-canary")));
    await stream.done;
    assert.equal(stream.status, 404);
  }
  assert.deepEqual(server.errors, []);
  assert.deepEqual(server.runs, []);
  assert.equal(server.ancillaryRequestCount, 2);
  assert.equal(server.unsupportedRpcCount, 2);
  assert.equal(JSON.stringify({ requests: server.requests, diagnostics: server.unknownRpcMethods }).includes("canary"), false);
});

test("fragmented h2c prefaces and gzip Connect frames complete only after sequential KV acknowledgements", async (t) => {
  const server = await mock(t);
  const url = await fragmentPreface(t, server);
  const stream = openRun(t, server, { compression: "gzip", url });
  const state = field(8, Buffer.alloc(32, 7));
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

test("unknown, duplicate and failed KV acknowledgements never emit a completed turn", async (t) => {
  for (const kind of ["unknown", "duplicate", "failed"]) {
    await t.test(kind, async (t) => {
      const server = await mock(t);
      const stream = openRun(t, server);
      stream.send(runMessage());
      await waitFor(() => stream.frames.length === 1);
      if (kind === "duplicate") {
        stream.send(acknowledgement(1));
        await waitFor(() => stream.frames.length === 2);
      }
      stream.send(acknowledgement(kind === "unknown" ? 999 : 1, kind === "failed"));
      await stream.done;
      const code = kind === "unknown" ? "CURSOR_AGENT_UNKNOWN_ACK"
        : kind === "duplicate" ? "CURSOR_AGENT_DUPLICATE_ACK" : "CURSOR_AGENT_KV_REJECTED";
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
