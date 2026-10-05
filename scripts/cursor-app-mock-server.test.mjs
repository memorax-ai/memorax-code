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
function execReadResult(id, path, content) {
  return field(2, Buffer.concat([scalar(1, id), field(7, field(1, Buffer.concat([
    field(1, path), field(2, content), scalar(3, content.split("\n").length), scalar(4, Buffer.byteLength(content)),
  ])))]));
}
function execShellResult(id, command, workingDirectory, stdout, stderr = "") {
  return field(2, Buffer.concat([scalar(1, id), field(2, field(1, Buffer.concat([
    field(1, command), field(2, workingDirectory), field(5, stdout), field(6, stderr),
  ])))]));
}
function execShellRejected(id, command, workingDirectory, { variant = 4, execId } = {}) {
  return field(2, Buffer.concat([scalar(1, id), ...(execId ? [field(15, execId)] : []),
    field(2, field(variant, Buffer.concat([field(1, command), field(2, workingDirectory), field(3, "private-rejection-canary")])))]));
}
function execControl(id, event = "close") {
  return field(5, field(event === "close" ? 1 : event === "heartbeat" ? 3 : 2,
    Buffer.concat([scalar(1, id), ...(event === "error" ? [field(2, "private-exec-error-canary")] : [])])));
}
function execContextResult(id, context) {
  return field(2, Buffer.concat([scalar(1, id), field(10, field(1, field(1, context)))]));
}
function cancelAction(reason = "user_stopped_generation") { return field(4, field(3, field(1, reason))); }
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
function openRun(t, server, { compression = "identity", headers = {}, url = server.url, endRequestOnResponse = true } = {}) {
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
  const done = new Promise((resolve) => request.once("end", () => { if (endRequestOnResponse) request.end(); resolve(); }));
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
async function pendingShell(t, { context = true, timeoutMs = 15_000 } = {}) {
  const step = { kind: "shell", command: "printf synthetic > stop-marker", workingDirectory: "/synthetic/workspace", timeoutMs: 1_000 };
  const server = await mock(t, { timeoutMs, toolSteps(run, results) {
    if (run.requestId !== requestId) return;
    if (context && !run.requestContextCloseCount) return { kind: "requestContext" };
    return results.length ? undefined : step;
  } });
  const stream = openRun(t, server);
  stream.send(runMessage());
  if (context) {
    await waitFor(() => stream.frames.length === 1 && server.runs[0]?.requestContextRequestCount === 1);
    stream.request.write(Buffer.concat([frame(execContextResult(1, Buffer.alloc(0))), frame(execControl(1))]));
  }
  // The client must receive the pending Shell before a test resets its stream.
  await waitFor(() => stream.frames.length === (context ? 3 : 2) && server.runs[0]?.pendingTool?.kind === "shell");
  const run = server.runs[0], tool = { ...run.pendingTool };
  return { server, stream, run, tool, step, arm: () => server.armCancellation({ requestId, toolCallId: tool.toolCallId }) };
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

test("post-completion DATA cannot hide another Run, Exec or KV result or malformed trailing bytes", async (t) => {
  for (const [name, payload, expected, end] of [
    ["Run", frame(runMessage()), "CURSOR_AGENT_DUPLICATE_RUN", false],
    ["Exec", frame(execControl(1)), "CURSOR_AGENT_MESSAGE_AFTER_COMPLETION", false],
    ["KV", frame(acknowledgement(3)), "CURSOR_AGENT_MESSAGE_AFTER_COMPLETION", false],
    ["invalid", Buffer.from([4, 0, 0, 0, 0]), "CURSOR_APP_CONNECT_FLAGS", false],
    ["partial", Buffer.from([0, 0]), "CURSOR_APP_CONNECT_TRUNCATED", true],
    ["excessive heartbeats", Buffer.concat(Array.from({ length: 129 }, () => frame(field(7, Buffer.alloc(0))))), "CURSOR_AGENT_TOO_MANY_MESSAGES", false],
  ]) await t.test(name, async (t) => {
    const server = await mock(t);
    const stream = openRun(t, server, { endRequestOnResponse: false });
    stream.send(runMessage());
    for (let id = 1; id <= 3; id++) {
      await waitFor(() => server.runs[0]?.kvWriteCount === id);
      stream.send(acknowledgement(id));
    }
    await stream.done;
    assert.equal(server.runs[0].completed, true);
    stream.request.write(payload);
    if (end) stream.request.end();
    await waitFor(() => server.errors.length === 1);
    assert.equal(server.runs.length, 1);
    assert.equal(server.runs[0].completed, false);
    assert.equal(server.runs[0].error, expected);
    assert.deepEqual(server.errors, [expected]);
  });
});

test("bounded native client heartbeats after completion and an ordinary request close remain successful", async (t) => {
  const server = await mock(t);
  const stream = openRun(t, server, { endRequestOnResponse: false });
  stream.send(runMessage());
  for (let id = 1; id <= 3; id++) {
    await waitFor(() => server.runs[0]?.kvWriteCount === id);
    stream.send(acknowledgement(id));
  }
  await stream.done;
  stream.send(field(7, Buffer.alloc(0)));
  stream.request.end();
  await new Promise((resolve) => stream.request.once("close", resolve));
  assert.equal(server.runs[0].completed, true);
  assert.deepEqual(server.errors, []);
});

test("a terminal Connect error coalesced with the last KV ACK prevents completion", async (t) => {
  const server = await mock(t);
  const stream = openRun(t, server);
  stream.send(runMessage());
  for (const id of [1, 2]) {
    await waitFor(() => server.runs[0]?.kvWriteCount === id);
    stream.send(acknowledgement(id));
  }
  await waitFor(() => server.runs[0]?.kvWriteCount === 3);
  const terminal = frame(Buffer.from(JSON.stringify({ error: { code: "aborted", message: "private-terminal-canary" } })));
  terminal[0] = 2;
  stream.request.write(Buffer.concat([frame(acknowledgement(3)), terminal]));
  await stream.done;
  assertFailed(server, stream, "CURSOR_APP_CONNECT_REMOTE_ERROR", { writes: 3, acks: 2 });
  assert.equal(JSON.stringify(server.errors).includes("canary"), false);
});

test("native Read and Shell results require matching stream closes before tool persistence and the final answer", async (t) => {
  const steps = [{ kind: "read", path: "/synthetic/skill/SKILL.md" },
    { kind: "read", path: "/synthetic/skill/references/memory.md" },
    { kind: "shell", command: "memorax-cli search synthetic", workingDirectory: "/synthetic/workspace", timeoutMs: 1_000 }];
  const content = ["Synthetic skill\n", "Synthetic reference\n"];
  const seen = [];
  const server = await mock(t, { toolSteps(run, results) {
    if (run.requestId !== requestId) return undefined;
    assert.equal(run.requestId, requestId);
    assert.equal(run.kvWriteCount, 0);
    seen.push([...results]);
    return steps[results.length];
  } });
  const stream = openRun(t, server);
  stream.send(runMessage());
  for (const [index, step] of steps.entries()) {
    await waitFor(() => server.runs[0]?.execRequestCount === index + 1);
    const run = server.runs[0], pending = { ...run.pendingTool };
    assert.equal(pending.id, index + 1);
    assert.equal(pending.kind, step.kind);
    assert.match(pending.toolCallId, /^[a-f0-9-]{36}$/);
    await waitFor(() => stream.frames.length === index * 3 + 2);
    assert.equal(stream.frames[index * 3].body[0], 10, "ToolStarted is sent before Exec");
    assert.equal(stream.frames[index * 3 + 1].body[0], 18, "Exec uses the native channel");
    stream.send(execControl(pending.id, "heartbeat"));
    stream.send(step.kind === "read" ? execReadResult(pending.id, step.path, content[index])
      : execShellResult(pending.id, step.command, step.workingDirectory, '{"synthetic":true}\n'));
    await waitFor(() => run.execResultCount === index + 1);
    assert.deepEqual(run.pendingTool, pending);
    assert.equal(run.execCloseCount, index);
    assert.equal(run.toolResults.length, index);
    assert.equal(run.kvWriteCount, 0);
    stream.send(execControl(pending.id));
  }
  await waitFor(() => server.runs[0]?.kvWriteCount === 1);
  const run = server.runs[0];
  assert.equal(run.pendingTool, undefined);
  assert.equal(run.execRequestCount, 3);
  assert.equal(run.execResultCount, 3);
  assert.equal(run.execCloseCount, 3);
  assert.equal(seen.length, 4);
  assert.deepEqual(run.toolResults, [
    { kind: "read", path: steps[0].path, content: content[0], totalLines: 2, fileSize: Buffer.byteLength(content[0]) },
    { kind: "read", path: steps[1].path, content: content[1], totalLines: 2, fileSize: Buffer.byteLength(content[1]) },
    { kind: "shell", command: steps[2].command, workingDirectory: steps[2].workingDirectory,
      stdout: '{"synthetic":true}\n', stderr: "", exitCode: 0 },
  ]);
  assert.deepEqual(run.kvWrites.map((write) => write.id), [4, 5, 6, 7, 8, 9]);
  for (const [index, write] of run.kvWrites.entries()) {
    await waitFor(() => run.kvWriteCount === index + 1);
    stream.send(acknowledgement(write.id));
  }
  await stream.done;
  assert.equal(run.completed, true);
  assert.equal(run.kvAckCount, 6);
  assert.equal(run.kvWrites.filter((write) => write.bytes.equals(field(1, field(1, answer)))).length, 1);
  assert.equal(run.kvWrites[1].bytes[0], 18, "persisted Read is a native ConversationStep tool call");
  assert.equal(run.kvWrites[2].bytes[0], 18);
  assert.equal(run.kvWrites[3].bytes[0], 18);
  const resumed = await completedRun(t, server, { prior: [run] });
  assert.equal(resumed.kvReadCount, 6);
  assert.equal(resumed.kvReadResultCount, 6);
  assert.equal(resumed.execRequestCount, 0);
  assert.equal(resumed.execResultCount, 0);
  assert.equal(resumed.execCloseCount, 0);
  assert.deepEqual(server.errors, []);
});

test("native context must complete its correlated handshake before Skill tools and is not added to their graph", async (t) => {
  const hook = "Synthetic current sessionStart context", skillPath = "/synthetic/skill/SKILL.md";
  const context = Buffer.concat([field(25, hook), field(29, field(1, skillPath))]);
  const server = await mock(t, { toolSteps(run, results) {
    if (!run.requestContextCloseCount) return { kind: "requestContext" };
    assert.equal(run.requestContext.hooksAdditionalContext, hook);
    assert.equal(run.requestContext.agentSkills[0].fullPath, skillPath);
    return results.length ? undefined : { kind: "read", path: skillPath };
  } });
  const stream = openRun(t, server);
  stream.send(runMessage());
  await waitFor(() => stream.frames.length === 1);
  const run = server.runs[0];
  assert.equal(run.requestContextRequestCount, 1);
  assert.equal(run.pendingTool, undefined);
  assert.equal(run.execRequestCount, 0);
  assert.equal(stream.frames[0].body[0], 18, "context is only a native Exec request, not ToolStarted");
  stream.send(execContextResult(1, context));
  await waitFor(() => run.requestContextResultCount === 1);
  assert.equal(run.requestContext, undefined, "result is not published until its stream closes");
  assert.equal(run.kvWriteCount, 0);
  assert.equal(run.execRequestCount, 0);
  stream.send(execControl(1));
  await waitFor(() => run.pendingTool?.id === 2);
  assert.equal(run.requestContextCloseCount, 1);
  assert.deepEqual(run.requestContextBytes, context);
  stream.request.write(Buffer.concat([frame(execReadResult(2, skillPath, "native skill")), frame(execControl(2))]));
  await waitFor(() => run.kvWriteCount === 1);
  assert.equal(run.toolResults.length, 1);
  assert.equal(run.kvWrites.length, 4);
  assert.deepEqual(run.kvWrites.map((write) => write.id), [3, 4, 5, 6]);
  for (const [index, write] of run.kvWrites.entries()) {
    await waitFor(() => run.kvWriteCount === index + 1);
    stream.send(acknowledgement(write.id));
  }
  await stream.done;
  assert.equal(run.completed, true);
  assert.equal(run.execRequestCount, 1);
  assert.equal(run.execResultCount, 1);
  assert.equal(run.execCloseCount, 1);
  assert.deepEqual(server.errors, []);
});

test("a repeated context request fails instead of silently rebinding the same turn", async (t) => {
  const server = await mock(t, { toolSteps: () => ({ kind: "requestContext" }) });
  const stream = openRun(t, server);
  stream.send(runMessage());
  await waitFor(() => stream.frames.length === 1);
  stream.request.write(Buffer.concat([frame(execContextResult(1, Buffer.alloc(0))), frame(execControl(1))]));
  await stream.done;
  assert.equal(server.runs[0].requestContextCloseCount, 1);
  assert.equal(server.runs[0].kvWriteCount, 0);
  assert.equal(server.runs[0].completed, false);
  assert.deepEqual(server.errors, ["CURSOR_AGENT_CONTEXT_DUPLICATE"]);
});

for (const [name, input, code] of [
  ["unknown result ID", (tool) => execReadResult(tool.id + 1, "/synthetic/skill", "content"), "CURSOR_AGENT_EXEC_UNKNOWN"],
  ["wrong result path", (tool) => execReadResult(tool.id, "/synthetic/other", "content"), "CURSOR_APP_EXEC_IDENTITY"],
  ["wrong result kind", (tool) => execShellResult(tool.id, "command", "/synthetic", "content"), "CURSOR_APP_EXEC_IDENTITY"],
  ["close before result", (tool) => execControl(tool.id), "CURSOR_AGENT_EXEC_RESULT_MISSING"],
  ["native throw", (tool) => execControl(tool.id, "error"), "CURSOR_AGENT_EXEC_THROWN"],
]) {
  test(`native Exec rejects ${name} without writing a final turn`, async (t) => {
    const server = await mock(t, { toolSteps: () => ({ kind: "read", path: "/synthetic/skill" }) });
    const stream = openRun(t, server);
    stream.send(runMessage());
    await waitFor(() => server.runs[0]?.pendingTool);
    stream.send(input(server.runs[0].pendingTool));
    await stream.done;
    const run = server.runs[0];
    assert.equal(run.completed, false);
    assert.equal(run.kvWriteCount, 0);
    assert.equal(run.pendingTool, undefined);
    assert.deepEqual(server.errors, [code]);
    assert.deepEqual(stream.frames.at(-2), { flags: 0, body: field(5, field(1, scalar(1, 1))) });
    assert.equal(JSON.stringify(server.errors).includes("private-exec"), false);
  });
}

test("native Exec missing close times out without publishing even a successful result", async (t) => {
  const server = await mock(t, { timeoutMs: 80, toolSteps: () => ({ kind: "read", path: "/synthetic/skill" }) });
  const stream = openRun(t, server);
  stream.send(runMessage());
  await waitFor(() => server.runs[0]?.pendingTool);
  stream.send(execReadResult(server.runs[0].pendingTool.id, "/synthetic/skill", "content"));
  await stream.done;
  assert.equal(server.runs[0].execResultCount, 1);
  assert.equal(server.runs[0].execCloseCount, 0);
  assert.equal(server.runs[0].toolResults.length, 0);
  assert.equal(server.runs[0].kvWriteCount, 0);
  assert.equal(server.runs[0].completed, false);
  assert.deepEqual(server.errors, ["CURSOR_AGENT_TIMEOUT"]);
  assert.deepEqual(stream.frames.at(-2), { flags: 0, body: field(5, field(1, scalar(1, 1))) });
});

test("private native rejection diagnostics retain only the correlated ID, kind and numeric result case", async (t) => {
  const server = await mock(t, { toolSteps: () => ({ kind: "shell", command: "synthetic command",
    workingDirectory: "/synthetic/workspace", timeoutMs: 1_000 }) });
  const stream = openRun(t, server);
  stream.send(runMessage());
  await waitFor(() => server.runs[0]?.pendingTool);
  stream.send(field(2, Buffer.concat([scalar(1, 1), field(2, field(5, field(1, "private-native-rejection-canary")))])));
  await stream.done;
  assert.deepEqual(server.runs[0].execRejection, { id: 1, kind: "shell", rejectionKind: 5 });
  assert.equal(server.runs[0].completed, false);
  assert.equal(server.runs[0].kvWriteCount, 0);
  assert.deepEqual(server.errors, ["CURSOR_APP_EXEC_REJECTED"]);
  assert.equal(JSON.stringify(server.runs[0].execRejection).includes("canary"), false);
});

test("duplicate result and close frames in one chunk fail before any tool or final graph is committed", async (t) => {
  for (const duplicate of ["result", "close"]) await t.test(duplicate, async (t) => {
    const server = await mock(t, { toolSteps: (_run, results) => results.length ? undefined : { kind: "read", path: "/synthetic/skill" } });
    const stream = openRun(t, server);
    stream.send(runMessage());
    await waitFor(() => server.runs[0]?.pendingTool);
    const id = server.runs[0].pendingTool.id;
    const result = frame(execReadResult(id, "/synthetic/skill", "content")), close = frame(execControl(id));
    stream.request.write(Buffer.concat(duplicate === "result" ? [result, result, close] : [result, close, close]));
    await stream.done;
    assert.equal(server.runs[0].kvWriteCount, 0);
    assert.equal(server.runs[0].toolResults.length, 0);
    assert.equal(server.runs[0].completed, false);
    assert.deepEqual(server.errors, ["CURSOR_AGENT_EXEC_DUPLICATE"]);
  });
});

test("Exec heartbeats are correlated and bounded without extending the run deadline", async (t) => {
  for (const [kind, expected] of [["unknown", "CURSOR_AGENT_EXEC_UNKNOWN"], ["excessive", "CURSOR_AGENT_EXEC_HEARTBEAT_LIMIT"],
    ["ended", "CURSOR_AGENT_EXEC_INCOMPLETE"]]) await t.test(kind, async (t) => {
    const server = await mock(t, { toolSteps: () => ({ kind: "read", path: "/synthetic/skill" }) });
    const stream = openRun(t, server);
    stream.send(runMessage());
    await waitFor(() => server.runs[0]?.pendingTool);
    const id = server.runs[0].pendingTool.id;
    if (kind === "unknown") stream.send(execControl(id + 1, "heartbeat"));
    else if (kind === "excessive") stream.request.write(Buffer.concat(Array.from({ length: 33 }, () => frame(execControl(id, "heartbeat")))));
    else stream.request.end();
    await stream.done;
    assert.equal(server.runs[0].kvWriteCount, 0);
    assert.equal(server.runs[0].completed, false);
    assert.deepEqual(server.errors, [expected]);
  });
});

test("tool planning keeps only explicitly allowed fixed assertion codes and rejects unsupported descriptors", async (t) => {
  for (const [name, toolSteps, expected] of [
    ["fixed assertion", () => { throw Object.assign(new Error("private-plan-canary"), { nativeCode: "CURSOR_APP_SKILL_NOT_READ" }); }, "CURSOR_APP_SKILL_NOT_READ"],
    ...["CURSOR_APP_INTERRUPTION_IDENTITY", "CURSOR_APP_INTERRUPTION_TOOL_EXECUTED"].map((code) =>
      [code, () => { throw Object.assign(new Error("private-plan-canary"), { nativeCode: code }); }, code]),
    ["private exception", () => { throw new Error("private-plan-canary"); }, "CURSOR_AGENT_TOOL_PLAN_FAILED"],
    ["invented code", () => { throw { code: "CURSOR_APP_SKILL_PRIVATE_CANARY" }; }, "CURSOR_AGENT_TOOL_PLAN_FAILED"],
    ["unsupported kind", () => ({ kind: "write", path: "/synthetic" }), "CURSOR_APP_EXEC_OPTIONS"],
    ["approval override", () => ({ kind: "shell", command: "echo synthetic", workingDirectory: "/synthetic", timeoutMs: 10, skipApproval: true }), "CURSOR_APP_EXEC_OPTIONS"],
    ["async callback", async () => undefined, "CURSOR_APP_EXEC_OPTIONS"],
    ["rejected async callback", async () => { throw new Error("private-plan-canary"); }, "CURSOR_APP_EXEC_OPTIONS"],
  ]) await t.test(name, async (t) => {
    const server = await mock(t, { toolSteps });
    const stream = openRun(t, server);
    stream.send(runMessage());
    await stream.done;
    assert.equal(server.runs[0].kvWriteCount, 0);
    assert.equal(server.runs[0].completed, false);
    assert.deepEqual(server.errors, [expected]);
    assert.equal(JSON.stringify(server.errors).includes("canary"), false);
  });
  await assert.rejects(() => startCursorAgentMock({ answer, toolSteps: {} }), /CURSOR_MOCK_OPTIONS_INVALID/);
});

test("tool plans have a finite step budget even if the callback never finishes", async (t) => {
  const server = await mock(t, { toolSteps: () => ({ kind: "read", path: "/synthetic/skill" }) });
  const stream = openRun(t, server);
  stream.send(runMessage());
  for (let index = 0; index < 8; index++) {
    await waitFor(() => server.runs[0]?.execRequestCount === index + 1);
    const { id } = server.runs[0].pendingTool;
    stream.request.write(Buffer.concat([frame(execReadResult(id, "/synthetic/skill", "content")), frame(execControl(id))]));
  }
  await stream.done;
  assert.equal(server.runs[0].execRequestCount, 8);
  assert.equal(server.runs[0].execResultCount, 8);
  assert.equal(server.runs[0].execCloseCount, 8);
  assert.equal(server.runs[0].kvWriteCount, 0);
  assert.deepEqual(server.errors, ["CURSOR_AGENT_EXEC_LIMIT"]);
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

test("an explicitly armed pending Shell accepts only client CANCEL without completing the turn", async (t) => {
  for (const response of ["none", "rejected", "rejected-and-closed"]) await t.test(response, async (t) => {
    const { server, stream, run, tool, step, arm } = await pendingShell(t);
    assert.equal(arm(), undefined);
    assert.throws(arm, { code: "CURSOR_AGENT_CANCELLATION_STATE" });
    stream.send(execControl(tool.id, "heartbeat"));
    if (response !== "none") {
      stream.send(execShellRejected(tool.id, step.command, step.workingDirectory, { execId: tool.toolCallId }));
      await waitFor(() => run.cancellation.rejected);
      if (response === "rejected-and-closed") {
        stream.send(execControl(tool.id));
        await waitFor(() => run.cancellation.execClosed);
      }
    }
    stream.request.close(http2Constants.NGHTTP2_CANCEL);
    await waitFor(() => run.cancelled || run.error);
    assert.deepEqual(server.errors, []);
    assert.equal(run.cancelled, true);
    assert.equal(run.completed, false);
    assert.equal(run.error, undefined);
    assert.equal(run.pendingTool, undefined);
    const { transportEvents, ...evidence } = run.cancellation;
    assert.ok(transportEvents.some((entry) => entry.event === "close" && entry.rstCode === http2Constants.NGHTTP2_CANCEL));
    assert.deepEqual(evidence, { id: tool.id, toolCallId: tool.toolCallId, rejected: response !== "none",
      execClosed: response === "rejected-and-closed", actionReceived: false, transportClosed: true, rstCode: http2Constants.NGHTTP2_CANCEL });
    assert.deepEqual([run.kvWriteCount, run.kvAckCount, run.execRequestCount, run.execResultCount, run.execCloseCount], [0, 0, 1, 0, 0]);
    assert.deepEqual([run.requestContextRequestCount, run.requestContextResultCount, run.requestContextCloseCount], [1, 1, 1]);
    assert.deepEqual(server.errors, []);
    assert.equal(stream.frames.length, 3, "cancellation sends no tool completion, server abort or terminal answer");
    assert.throws(arm, { code: "CURSOR_AGENT_CANCELLATION_STATE" });
    const next = await completedRun(t, server);
    assert.equal(next.turnRefs.length, 0, "cancelled turns are not admitted to completed history");
    assert.equal(next.completed, true);
    assert.deepEqual(server.errors, []);
  });
});

test("a native Stop action is accepted only on its armed stream and still needs a client CANCEL", async (t) => {
  for (const reason of ["user_stopped_generation", "composer_abort_controller_aborted"]) await t.test(reason, async (t) => {
    const { server, stream, run, arm } = await pendingShell(t);
    arm();
    stream.send(cancelAction(reason));
    await waitFor(() => run.cancellation.actionReceived || run.error);
    assert.deepEqual(server.errors, []);
    assert.equal(run.cancellation.actionReceived, true);
    assert.equal(run.cancelled, false);
    assert.equal(run.completed, false);
    assert.deepEqual([run.execResultCount, run.execCloseCount, run.kvWriteCount], [0, 0, 0]);
    stream.request.close(http2Constants.NGHTTP2_CANCEL);
    await waitFor(() => run.cancelled || run.error);
    assert.equal(run.cancelled, true);
    assert.deepEqual(server.errors, []);
    assert.equal(stream.frames.length, 3);
  });
});

test("native Stop with a matching Shell rejection and Exec close permits the observed INTERNAL_ERROR stream reset", async (t) => {
  for (const rstCode of [http2Constants.NGHTTP2_INTERNAL_ERROR, http2Constants.NGHTTP2_CANCEL]) await t.test(String(rstCode), async (t) => {
    const { server, stream, run, tool, step, arm } = await pendingShell(t);
    arm();
    stream.request.write(Buffer.concat([
      frame(cancelAction("composer_abort_controller_aborted")),
      frame(execShellRejected(tool.id, step.command, step.workingDirectory, { execId: tool.toolCallId })),
      frame(execControl(tool.id)),
    ]));
    await waitFor(() => run.cancellation.execClosed);
    assert.equal(run.cancelled, false);
    stream.request.close(rstCode);
    await waitFor(() => run.cancelled || run.error);
    assert.deepEqual(server.errors, []);
    assert.equal(run.cancelled, true);
    assert.equal(run.completed, false);
    assert.equal(run.cancellation.rstCode, rstCode);
    assert.equal(run.cancellation.transportClosed, true);
    assert.deepEqual([run.cancellation.actionReceived, run.cancellation.rejected, run.cancellation.execClosed], [true, true, true]);
    assert.deepEqual([run.execResultCount, run.execCloseCount, run.kvWriteCount, run.kvAckCount], [0, 0, 0, 0]);
    assert.equal(stream.frames.length, 3);
    assert.ok(run.cancellation.transportEvents.every((event) => !event.sessionClosed && !event.sessionDestroyed));
  });
});

test("INTERNAL_ERROR requires all native cancellation evidence and never permits unrelated resets or a closed session", async (t) => {
  for (const kind of ["unarmed", "missing-action", "missing-rejection", "missing-exec-close", "no-error-reset", "unknown-reset", "session-disconnect", "truncated"]) await t.test(kind, async (t) => {
    const { server, stream, run, tool, step, arm } = await pendingShell(t);
    if (kind !== "unarmed") {
      arm();
      const messages = [
        ...(kind === "missing-action" ? [] : [cancelAction()]),
        ...(kind === "missing-rejection" ? [] : [execShellRejected(tool.id, step.command, step.workingDirectory)]),
        ...(kind === "missing-exec-close" ? [] : [execControl(tool.id)]),
      ];
      stream.request.write(Buffer.concat(messages.map((message) => frame(message))));
      await waitFor(() => run.error || (kind === "missing-exec-close" ? run.cancellation.rejected : run.cancellation.execClosed));
    }
    if (!run.error) {
      if (kind === "truncated") { stream.request.write(Buffer.from([0, 0])); await delay(20); }
      if (kind === "session-disconnect") stream.client.destroy(new Error("private-disconnect-canary"), http2Constants.NGHTTP2_INTERNAL_ERROR);
      else stream.request.close(kind === "no-error-reset" ? http2Constants.NGHTTP2_NO_ERROR
        : kind === "unknown-reset" ? http2Constants.NGHTTP2_PROTOCOL_ERROR : http2Constants.NGHTTP2_INTERNAL_ERROR);
    }
    await waitFor(() => server.errors.length === 1);
    assert.equal(run.cancelled, false);
    assert.equal(run.completed, false);
    assert.deepEqual([run.execResultCount, run.execCloseCount, run.kvWriteCount, run.kvAckCount], [0, 0, 0, 0]);
    if (kind === "missing-rejection") assert.deepEqual(server.errors, ["CURSOR_AGENT_EXEC_RESULT_MISSING"]);
    if (kind === "truncated") assert.deepEqual(server.errors, ["CURSOR_APP_CONNECT_TRUNCATED"]);
    assert.throws(arm, { code: "CURSOR_AGENT_CANCELLATION_STATE" });
  });
});

test("cancellation can arm only the exact unresolved Shell after a completed RequestContext", async (t) => {
  const { server, stream, run, tool, step, arm } = await pendingShell(t);
  for (const value of [undefined, null, {}, { requestId: identity(90), toolCallId: tool.toolCallId },
    { requestId, toolCallId: identity(91) }]) {
    assert.throws(() => server.armCancellation(value), { code: "CURSOR_AGENT_CANCELLATION_STATE" });
    assert.equal(run.cancellation, undefined);
  }
  stream.send(execShellResult(tool.id, step.command, step.workingDirectory, "synthetic"));
  await waitFor(() => run.execResultCount === 1);
  assert.throws(arm, { code: "CURSOR_AGENT_CANCELLATION_STATE" });
  stream.send(execControl(tool.id));
  await waitFor(() => run.kvWriteCount === 1);
  assert.throws(arm, { code: "CURSOR_AGENT_CANCELLATION_STATE" });
  const noContext = await pendingShell(t, { context: false });
  assert.throws(noContext.arm, { code: "CURSOR_AGENT_CANCELLATION_STATE" });
  const pendingContext = await mock(t, { toolSteps: () => ({ kind: "requestContext" }) });
  const contextStream = openRun(t, pendingContext);
  contextStream.send(runMessage());
  await waitFor(() => pendingContext.runs[0]?.requestContextRequestCount === 1);
  assert.throws(() => pendingContext.armCancellation({ requestId, toolCallId: tool.toolCallId }),
    { code: "CURSOR_AGENT_CANCELLATION_STATE" });
  const pendingRead = await mock(t, { toolSteps: (run) => run.requestContextCloseCount
    ? { kind: "read", path: "/synthetic/skill" } : { kind: "requestContext" } });
  const readStream = openRun(t, pendingRead);
  readStream.send(runMessage());
  await waitFor(() => pendingRead.runs[0]?.requestContextRequestCount === 1);
  readStream.request.write(Buffer.concat([frame(execContextResult(1, Buffer.alloc(0))), frame(execControl(1))]));
  await waitFor(() => pendingRead.runs[0]?.pendingTool?.kind === "read");
  assert.throws(() => pendingRead.armCancellation({ requestId, toolCallId: pendingRead.runs[0].pendingTool.toolCallId }),
    { code: "CURSOR_AGENT_CANCELLATION_STATE" });
});

test("armed cancellation still rejects execution, unrelated results and malformed protocol messages", async (t) => {
  for (const [name, messages, expected] of [
    ["success", (p) => [execShellResult(p.tool.id, p.step.command, p.step.workingDirectory, "ran")], "CURSOR_AGENT_CANCELLATION_EXECUTED"],
    ["other rejection", (p) => [execShellRejected(p.tool.id, p.step.command, p.step.workingDirectory, { variant: 5 })], "CURSOR_APP_EXEC_REJECTED"],
    ["wrong command", (p) => [execShellRejected(p.tool.id, "other", p.step.workingDirectory)], "CURSOR_APP_EXEC_IDENTITY"],
    ["wrong directory", (p) => [execShellRejected(p.tool.id, p.step.command, "/other")], "CURSOR_APP_EXEC_IDENTITY"],
    ["wrong exec identity", (p) => [execShellRejected(p.tool.id, p.step.command, p.step.workingDirectory, { execId: identity(90) })], "CURSOR_APP_EXEC_IDENTITY"],
    ["wrong ID", (p) => [execShellRejected(p.tool.id + 1, p.step.command, p.step.workingDirectory)], "CURSOR_AGENT_EXEC_UNKNOWN"],
    ["wrong kind", (p) => [execReadResult(p.tool.id, "/synthetic", "content")], "CURSOR_APP_EXEC_IDENTITY"],
    ["close before rejection", (p) => [execControl(p.tool.id)], "CURSOR_AGENT_EXEC_RESULT_MISSING"],
    ["throw", (p) => [execControl(p.tool.id, "error")], "CURSOR_AGENT_EXEC_THROWN"],
    ["duplicate rejection", (p) => Array(2).fill(execShellRejected(p.tool.id, p.step.command, p.step.workingDirectory)), "CURSOR_AGENT_EXEC_DUPLICATE"],
    ["success after rejection", (p) => [execShellRejected(p.tool.id, p.step.command, p.step.workingDirectory),
      execShellResult(p.tool.id, p.step.command, p.step.workingDirectory, "ran")], "CURSOR_AGENT_EXEC_DUPLICATE"],
    ["success after rejected close", (p) => [cancelAction(), execShellRejected(p.tool.id, p.step.command, p.step.workingDirectory),
      execControl(p.tool.id), execShellResult(p.tool.id, p.step.command, p.step.workingDirectory, "ran")], "CURSOR_AGENT_EXEC_DUPLICATE"],
    ["duplicate close", (p) => [execShellRejected(p.tool.id, p.step.command, p.step.workingDirectory), execControl(p.tool.id), execControl(p.tool.id)], "CURSOR_AGENT_EXEC_DUPLICATE"],
    ["unexpected KV ACK", (p) => [acknowledgement(p.tool.id)], "CURSOR_AGENT_UNKNOWN_ACK"],
    ["duplicate Run", () => [runMessage()], "CURSOR_AGENT_DUPLICATE_RUN"],
    ["duplicate Stop action", () => [cancelAction(), cancelAction()], "CURSOR_AGENT_CANCELLATION_DUPLICATE"],
    ["duplicate controller Stop action", () => Array(2).fill(cancelAction("composer_abort_controller_aborted")), "CURSOR_AGENT_CANCELLATION_DUPLICATE"],
    ["mixed Stop actions", () => [cancelAction("composer_abort_controller_aborted"), cancelAction()], "CURSOR_AGENT_CANCELLATION_DUPLICATE"],
    ["other cancellation reason", () => [cancelAction("new_message_submitted")], "CURSOR_APP_CLIENT_MESSAGE_UNSUPPORTED"],
  ]) await t.test(name, async (t) => {
    const pending = await pendingShell(t), { server, stream, run } = pending;
    pending.arm();
    stream.request.write(Buffer.concat(messages(pending).map((message) => frame(message))));
    await stream.done;
    assert.equal(run.cancelled, false);
    assert.equal(run.completed, false);
    assert.equal(run.kvWriteCount, 0);
    assert.deepEqual(server.errors, [expected]);
    assert.throws(pending.arm, { code: "CURSOR_AGENT_CANCELLATION_STATE" });
  });
});

test("expected cancellation never turns an ordinary close, timeout or shutdown into success", async (t) => {
  for (const kind of ["normal-close", "error-close", "session-disconnect", "request-end", "timeout", "action-timeout", "shutdown", "unarmed", "unarmed-rejected", "unarmed-action", "unarmed-controller-action", "truncated"]) await t.test(kind, async (t) => {
    const { server, stream, run, tool, step, arm } = await pendingShell(t, { timeoutMs: ["timeout", "action-timeout", "request-end"].includes(kind) ? 150 : 15_000 });
    if (!kind.startsWith("unarmed")) arm();
    if (kind === "shutdown") await server.close();
    else if (kind === "session-disconnect") stream.client.destroy();
    else if (kind === "unarmed-rejected") stream.send(execShellRejected(tool.id, step.command, step.workingDirectory));
    else if (["unarmed-action", "action-timeout"].includes(kind)) stream.send(cancelAction());
    else if (kind === "unarmed-controller-action") stream.send(cancelAction("composer_abort_controller_aborted"));
    else if (kind === "request-end") stream.request.end();
    else if (kind !== "timeout") {
      if (kind === "truncated") { stream.request.write(Buffer.from([0, 0])); await delay(20); }
      stream.request.close(kind === "normal-close" ? http2Constants.NGHTTP2_NO_ERROR
        : kind === "error-close" ? http2Constants.NGHTTP2_INTERNAL_ERROR : http2Constants.NGHTTP2_CANCEL);
    }
    if (kind !== "shutdown") await waitFor(() => server.errors.length === 1 || run.cancelled);
    assert.equal(run.cancelled, false, JSON.stringify(run.cancellation?.transportEvents));
    assert.equal(run.completed, false);
    assert.equal(run.kvWriteCount, 0);
    if (kind === "session-disconnect") {
      assert.deepEqual(server.errors, ["CURSOR_AGENT_STREAM_ABORTED"]);
      assert.equal(run.cancellation.transportClosed, false);
    }
    if (["timeout", "action-timeout"].includes(kind)) assert.deepEqual(server.errors, ["CURSOR_AGENT_TIMEOUT"]);
    if (kind === "unarmed-rejected") assert.deepEqual(server.errors, ["CURSOR_APP_EXEC_REJECTED"]);
    if (["unarmed-action", "unarmed-controller-action"].includes(kind)) assert.deepEqual(server.errors, ["CURSOR_APP_CLIENT_MESSAGE_UNSUPPORTED"]);
    if (kind === "truncated") assert.deepEqual(server.errors, ["CURSOR_APP_CONNECT_TRUNCATED"]);
    assert.throws(arm, { code: "CURSOR_AGENT_CANCELLATION_STATE" });
  });
});

test("arming one run does not authorize a Stop action on another stream", async (t) => {
  for (const reason of ["user_stopped_generation", "composer_abort_controller_aborted"]) await t.test(reason, async (t) => {
    const { server, run, arm } = await pendingShell(t);
    arm();
    const other = openRun(t, server, { headers: { "x-request-id": identity(90) } });
    other.send(cancelAction(reason));
    await other.done;
    assert.equal(run.cancellation.actionReceived, false);
    assert.equal(run.cancelled, false);
    assert.equal(run.error, undefined);
    assert.deepEqual(server.errors, ["CURSOR_APP_CLIENT_MESSAGE_UNSUPPORTED"]);
  });
});

test("unsupported armed messages expose only private bounded protocol shapes", async (t) => {
  const { server, stream, run, arm } = await pendingShell(t);
  arm();
  stream.send(cancelAction("private-reason-canary"));
  await stream.done;
  assert.deepEqual(run.lastUnsupportedShape, { outer: [{ number: 4, wire: 2 }], action: [{ number: 3, wire: 2 }],
    cancel: [{ number: 1, wire: 2 }], cancelReason: "other" });
  assert.equal(JSON.stringify(run.lastUnsupportedShape).includes("canary"), false);
  assert.deepEqual(server.errors, ["CURSOR_APP_CLIENT_MESSAGE_UNSUPPORTED"]);
  assert.equal(run.cancelled, false);
});

test("unexpected cancellation transport retains only fixed events, numeric reset codes and state flags", async (t) => {
  const { server, stream, run, arm } = await pendingShell(t);
  arm();
  stream.request.close(http2Constants.NGHTTP2_NO_ERROR);
  await waitFor(() => run.cancellation.transportEvents?.some((entry) => entry.event === "close"));
  assert.equal(run.cancelled, false);
  assert.equal(run.completed, false);
  assert.equal(server.errors.length, 1);
  assert.ok(run.cancellation.transportEvents.length <= 8);
  for (const entry of run.cancellation.transportEvents) {
    assert.deepEqual(Object.keys(entry), ["event", "rstCode", "streamClosed", "streamDestroyed", "sessionClosed", "sessionDestroyed", "serverClosed"]);
    assert.ok(["aborted", "error", "close"].includes(entry.event));
    assert.ok(entry.rstCode === null || Number.isInteger(entry.rstCode));
    for (const key of ["streamClosed", "streamDestroyed", "sessionClosed", "sessionDestroyed", "serverClosed"]) assert.equal(typeof entry[key], "boolean");
  }
  assert.equal(run.cancellation.transportEvents.at(-1).rstCode, http2Constants.NGHTTP2_NO_ERROR);
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
