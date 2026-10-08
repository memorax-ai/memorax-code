import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { connect as connectHttp2, constants as http2Constants } from "node:http2";
import { connect, createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { startCursorAgentMock } from "./cursor-app-mock-server.mjs";
import { collectCursorAppShellDiagnostics } from "./cursor-app-diagnostics.mjs";

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
function runMessage(state = Buffer.alloc(0), { text = prompt, session = conversationId, userId = userMessageId, context, parts,
  prepend = [], modelId, requestedModelId, subagentTypeName } = {}) {
  const user = Buffer.concat([field(1, text), field(2, userId)]);
  const action = Buffer.concat([field(1, Buffer.concat([field(1, user), ...(context === undefined ? [] : [field(2, context)]),
    ...prepend.map((bytes) => field(4, bytes))])),
    ...(parts === undefined ? [] : [field(17, parts)])]);
  return field(1, Buffer.concat([field(1, state), field(2, action), field(5, session),
    ...(modelId === undefined ? [] : [field(3, field(1, modelId))]),
    ...(requestedModelId === undefined ? [] : [field(9, field(1, requestedModelId))]),
    ...(subagentTypeName === undefined ? [] : [field(11, subagentTypeName)])]));
}
function skillsReference(bytes, { byteLength = bytes.length, dynamic } = {}) {
  return Buffer.concat([field(3, createHash("sha256").update(bytes).digest()), scalar(4, byteLength),
    ...(dynamic === undefined ? [] : [field(9, dynamic)])]);
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
function execTaskResult(id, toolCallId, agentId) {
  return field(2, Buffer.concat([scalar(1, id), field(15, toolCallId),
    field(28, field(1, Buffer.concat([field(1, agentId), scalar(4, 1)])))]));
}
const taskStep = { kind: "task", subagentType: "memorax-repo-memory", model: "inherit", background: true,
  description: "Synthetic Repo Memory job", prompt: "Exact delegated synthetic Repo Memory job\nclaim fixture ticket" };
const taskModel = "synthetic-parent-model", childSession = "44444444-4444-4444-8444-444444444444";
function managedSubagent() {
  return Buffer.concat([field(1, "/synthetic/.cursor/agents/memorax-repo-memory.md"), field(2, taskStep.subagentType),
    field(3, "Installed definition"), field(5, "inherit"), field(6, "Exact installed worker instructions"), scalar(8, 1)]);
}
async function pendingTask(t, options = {}) {
  const server = await mock(t, { answers: ["Parent answer", "Child answer"], toolSteps(run, results) {
    return run.subagentTypeName ? undefined : results.length ? undefined : taskStep;
  }, ...options });
  const parent = openRun(t, server);
  parent.send(runMessage(Buffer.alloc(0), { requestedModelId: taskModel, context: field(22, managedSubagent()) }));
  await waitFor(() => server.runs[0]?.pendingTool?.kind === "task" && parent.frames.length === 2);
  return { server, parent, run: server.runs[0], pending: { ...server.runs[0].pendingTool } };
}
async function finishWrites(stream, run) {
  await waitFor(() => run.kvWriteCount === 1);
  for (const [index, write] of run.kvWrites.entries()) {
    await waitFor(() => run.kvWriteCount === index + 1);
    assert.equal(run.completed, false);
    assert.equal(run.kvAckCount, index);
    stream.send(acknowledgement(write.id));
  }
  await stream.done;
  assert.equal(run.completed, true);
  assert.equal(run.kvAckCount, run.kvWrites.length);
  assert.equal(run.kvWriteCount, run.kvWrites.length);
  assert.equal(run.error, undefined);
}
function taskNotification(state, toolCallId, { taskId = childSession, subagentId = childSession, kind = 2,
  status = 1, reason = 1, session = conversationId, modelId = taskModel } = {}) {
  const detail = Buffer.concat([field(1, taskId), scalar(2, kind), scalar(3, status), field(4, "private-title-canary"),
    field(5, "private-detail-canary"), field(6, "/private/output-canary"), scalar(8, reason),
    field(9, subagentId), field(10, toolCallId)]);
  return field(1, Buffer.concat([field(1, state), field(2, field(12, field(1, detail))), field(3, field(1, modelId)), field(5, session)]));
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
async function completedRun(t, server, { prior = [], session = conversationId, text = prompt, expectedAnswer = answer, prepend } = {}) {
  const index = server.runs.length;
  const stream = openRun(t, server, { headers: { "x-request-id": identity(index + 10) }, compression: "gzip" });
  const state = Buffer.concat([scalar(10, 1), ...prior.map((run) => field(8, run.turnBlobId))]);
  stream.send(runMessage(state, { session, text, userId: identity(index + 100), prepend }));
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

function assertFailure(server, stream, code, run = server.runs.at(-1)) {
  assert.equal(server.errors.at(-1), code);
  assert.deepEqual(JSON.parse(stream.frames.at(-1).body), { error: { code: "invalid_argument", message: code } });
  if (run) assert.equal(run.completed, false);
  assert.equal(JSON.stringify(server.errors).includes("canary"), false);
}

test("ancillary HTTP routes expose only metadata while Agent transport validation fails closed", async (t) => {
  const server = await mock(t);
  const preflight = await ancillary(server, "/auth/full_stripe_profile", "OPTIONS", { includeHeaders: true });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.body, "");
  assert.equal(preflight.headers["access-control-allow-origin"], "*");
  assert.equal(preflight.headers["access-control-allow-methods"], "GET, POST, OPTIONS");
  assert.equal(preflight.headers["access-control-allow-headers"], "content-type, authorization");
  for (const path of ["/auth/full_stripe_profile", "/aiserver.v1.DashboardService/GetMe",
    "/aiserver.v1.AiService/AvailableModels", "/aiserver.v1.ServerConfigService/GetServerConfig"]) {
    assert.deepEqual(await ancillary(server, path + "?secret=private-canary"), { status: 200, body: "{}" });
  }
  assert.deepEqual(await ancillary(server, "/private-path-canary"), { status: 404, body: "{}" });
  for (const path of ["/agent.v1.AgentService/UpdateConversationMetadata",
    "/agent.v1.AgentService/GetNewChatNudgeParameterizedModelPicker", "/aiserver.v1.AnalyticsService/SubmitLogs"]) {
    const stream = openRun(t, server, { headers: { ":path": path } });
    await stream.done;
    assert.equal(stream.status, 404);
  }
  assert.deepEqual(server.errors, []);
  assert.equal(server.ancillaryRequestCount, 9);
  assert.equal(server.unsupportedRpcCount, 4);
  assert.equal(JSON.stringify(server.requests).includes("canary"), false);
  assert.deepEqual(await ancillary(server, agentPath), { status: 404, body: "{}" });
  assert.deepEqual(server.errors, ["CURSOR_AGENT_HTTP2_REQUIRED"]);
  for (const [name, headers, code] of [
    ["missing identity", { "x-request-id": undefined }, "CURSOR_AGENT_REQUEST_ID_INVALID"],
    ["malformed identity", { "x-request-id": "private-canary" }, "CURSOR_AGENT_REQUEST_ID_INVALID"],
    ["content type", { "content-type": "application/json" }, "CURSOR_AGENT_ENCODING_INVALID"],
    ["compression", { "connect-content-encoding": "br" }, "CURSOR_AGENT_ENCODING_INVALID"],
    ["method", { ":method": "GET" }, "CURSOR_MOCK_METHOD_INVALID"],
    ["version", { ":path": "/agent.v2.AgentService/Run" }, "CURSOR_AGENT_ROUTE_INVALID"],
    ["neighbor RPC", { ":path": "/agent.v1.AgentService/GetNewChatNudgeParameterizedModelPickerExtra" }, "CURSOR_AGENT_ROUTE_INVALID"],
  ]) await t.test(name, async (t) => {
    const stream = openRun(t, server, { headers });
    await stream.done;
    assertFailure(server, stream, code);
    assert.equal(stream.frames.length, 1);
    assert.equal(server.runs.length, 0);
  });
});

test("fragmented h2c and gzip require sequential native KV acknowledgements", async (t) => {
  const server = await mock(t), url = await fragmentPreface(t, server);
  const stream = openRun(t, server, { compression: "gzip", url });
  const state = scalar(10, 1), wire = frame(runMessage(state), "gzip");
  for (const [start, end] of [[0, 1], [1, 3], [3, 9], [9, wire.length]]) {
    stream.request.write(wire.subarray(start, end));
    await delay(3);
  }
  await waitFor(() => stream.frames.length === 1);
  stream.send(field(7, Buffer.alloc(0)));
  await delay(20);
  assert.equal(stream.frames.length, 1);
  assert.equal(server.runs[0].kvAckCount, 0);
  await finishWrites(stream, server.runs[0]);
  const run = server.runs[0];
  assert.deepEqual([run.requestId, run.conversationId, run.userMessageId, run.prompt],
    [requestId, conversationId, userMessageId, prompt]);
  assert.deepEqual(run.conversationStateBytes, Buffer.concat([state, field(8, run.turnBlobId)]));
  assert.deepEqual([run.kvWriteCount, run.kvAckCount, run.kvReadCount, run.kvReadResultCount], [3, 3, 0, 0]);
  assert.deepEqual(stream.frames, [
    ...run.kvWrites.map((write) => ({ flags: 0, body: write.message })),
    { flags: 0, body: field(3, run.conversationStateBytes) },
    { flags: 0, body: field(1, field(1, field(1, answer))) },
    { flags: 0, body: field(1, field(14, Buffer.alloc(0))) }, { flags: 2, body: Buffer.from("{}") },
  ]);
  assert.equal(stream.status, 200);
  assert.deepEqual(stream.clientErrors, []);
  assert.deepEqual(server.errors, []);
});

test("session history survives fresh connections and excludes failed or cross-session turns", async (t) => {
  const answers = [answer, "Second synthetic answer", answer, "Restarted synthetic answer"];
  const server = await mock(t, { answers });
  const first = await completedRun(t, server);
  const second = await completedRun(t, server, { prior: [first], expectedAnswer: answers[1] });
  const isolated = await completedRun(t, server, { session: identity(500) });
  const resumed = await completedRun(t, server, { prior: [first, second], expectedAnswer: answers[3] });
  assert.deepEqual(server.runs.map((run) => run.kvReadCount), [0, 3, 0, 6]);
  assert.deepEqual(server.runs.map((run) => run.kvReadResultCount), [0, 3, 0, 6]);
  assert.deepEqual(server.runs.map((run) => run.turnRefs.length), [0, 1, 0, 2]);
  assert.ok(server.runs.every((run) => run.kvWriteCount === 3 && run.kvAckCount === 3));
  assert.notEqual(first.userMessageId, second.userMessageId);
  assert.equal(first.prompt, second.prompt);
  assert.equal(first.prompt, isolated.prompt);
  assert.notDeepEqual(first.turnBlobId, isolated.turnBlobId);
  assert.deepEqual(first.kvWrites[1].bytes, isolated.kvWrites[1].bytes);
  assert.deepEqual(resumed.turnRefs, [first.turnBlobId, second.turnBlobId]);
  for (const [index, refs] of [[], [first.turnBlobId], [second.turnBlobId, first.turnBlobId],
    [first.turnBlobId, first.turnBlobId], [first.turnBlobId, isolated.turnBlobId], [Buffer.alloc(32)]].entries()) {
    const stream = openRun(t, server, { headers: { "x-request-id": identity(600 + index) } });
    stream.send(runMessage(Buffer.concat(refs.map((ref) => field(8, ref)))));
    await stream.done;
    assertFailure(server, stream, "CURSOR_AGENT_HISTORY_MISMATCH", null);
    assert.equal(stream.frames.length, 1);
    assert.equal(server.runs.length, 4);
  }
  const extra = openRun(t, server, { headers: { "x-request-id": identity(700) } });
  extra.send(runMessage(Buffer.alloc(0), { session: identity(701) }));
  await extra.done;
  assert.equal(server.errors.at(-1), "CURSOR_AGENT_ANSWER_EXHAUSTED");
});

test("run identities and session locks reject concurrent work and release failed continuations", async (t) => {
  const server = await mock(t), first = openRun(t, server);
  first.send(runMessage());
  await waitFor(() => first.frames.length === 1);
  for (const [id, code] of [[requestId, "CURSOR_AGENT_DUPLICATE_RUN"], [identity(600), "CURSOR_AGENT_CONVERSATION_BUSY"]]) {
    const other = openRun(t, server, { headers: { "x-request-id": id } });
    other.send(runMessage());
    await other.done;
    assert.equal(server.errors.at(-1), code);
    assert.equal(server.runs.length, 1);
  }
  first.send(acknowledgement(1, true));
  await first.done;
  const completed = await completedRun(t, server);
  const failed = openRun(t, server, { headers: { "x-request-id": identity(800) } });
  failed.send(runMessage(field(8, completed.turnBlobId)));
  for (const [index, write] of completed.kvWrites.entries()) {
    await waitFor(() => failed.frames.length === index + 1);
    failed.send(readResult(index + 1, write.bytes));
  }
  await waitFor(() => failed.frames.length === 4);
  failed.send(acknowledgement(4, true));
  await failed.done;
  const recovered = await completedRun(t, server, { prior: [completed] });
  assert.deepEqual(recovered.turnRefs, [completed.turnBlobId]);
  assert.equal(recovered.kvReadResultCount, 3);
  assert.equal(server.runs[0].completed, false);
  assert.equal(server.runs[2].completed, false);
});

test("KV failures never publish a completed graph", async (t) => {
  for (const phase of ["read", "write"]) for (const fault of ["unknown", "duplicate", "failed", "missing", "wrong-type", "timeout"]) {
    await t.test(phase + " " + fault, async (t) => {
      const server = await mock(t, { timeoutMs: fault === "timeout" ? 250 : 15000 });
      const prior = phase === "read" ? await completedRun(t, server) : undefined;
      const stream = openRun(t, server, { headers: { "x-request-id": identity(600) } });
      stream.send(runMessage(prior ? field(8, prior.turnBlobId) : Buffer.alloc(0)));
      await waitFor(() => stream.frames.length === 1);
      const id = fault === "unknown" ? 999 : 1;
      const response = phase === "read" ? readResult(id, prior.kvWrites[0].bytes, fault === "failed")
        : acknowledgement(id, fault === "failed");
      if (fault === "missing") stream.request.end();
      else if (fault === "wrong-type") stream.send(phase === "read" ? acknowledgement(id) : readResult(id, Buffer.from("private-canary")));
      else if (fault === "duplicate") stream.request.write(Buffer.concat([frame(response), frame(response)]));
      else if (fault !== "timeout") stream.send(response);
      await stream.done;
      const code = fault === "timeout" ? "CURSOR_AGENT_TIMEOUT" : fault === "wrong-type" ? "CURSOR_AGENT_KV_RESULT_MISMATCH"
        : phase === "read" ? { unknown: "CURSOR_AGENT_UNKNOWN_KV_READ", duplicate: "CURSOR_AGENT_DUPLICATE_KV_READ",
          failed: "CURSOR_AGENT_KV_READ_REJECTED", missing: "CURSOR_AGENT_KV_READ_MISSING" }[fault]
          : { unknown: "CURSOR_AGENT_UNKNOWN_ACK", duplicate: "CURSOR_AGENT_DUPLICATE_ACK",
            failed: "CURSOR_AGENT_KV_REJECTED", missing: "CURSOR_AGENT_ACK_MISSING" }[fault];
      const run = server.runs.at(-1);
      assertFailure(server, stream, code);
      assert.equal(run.kvWriteCount, phase === "read" ? 0 : 1);
      assert.equal(stream.frames.filter((entry) => entry.flags === 0).length, 1);
    });
  }
});

test("coalesced final ACK faults and post-completion traffic cannot conceal another operation", async (t) => {
  for (const [name, payload, after, end, code] of [
    ["duplicate final ACK", frame(acknowledgement(3)), false, false, "CURSOR_AGENT_DUPLICATE_ACK"],
    ["remote terminal error", Buffer.concat([Buffer.from([2, 0, 0, 0, 12]), Buffer.from('{"error":{}}')]), false, false, "CURSOR_APP_CONNECT_REMOTE_ERROR"],
    ["later Run", frame(runMessage()), true, false, "CURSOR_AGENT_DUPLICATE_RUN"],
    ["later Exec", frame(execControl(1)), true, false, "CURSOR_AGENT_MESSAGE_AFTER_COMPLETION"],
    ["later KV", frame(acknowledgement(3)), true, false, "CURSOR_AGENT_MESSAGE_AFTER_COMPLETION"],
    ["truncated", Buffer.from([0, 0]), true, true, "CURSOR_APP_CONNECT_TRUNCATED"],
    ["heartbeat", frame(field(7, Buffer.alloc(0))), true, true, undefined],
  ]) await t.test(name, async (t) => {
    const server = await mock(t), stream = openRun(t, server, { endRequestOnResponse: false });
    stream.send(runMessage());
    for (const id of [1, 2]) {
      await waitFor(() => server.runs[0]?.kvWriteCount === id);
      stream.send(acknowledgement(id));
    }
    await waitFor(() => server.runs[0]?.kvWriteCount === 3);
    if (after) {
      stream.send(acknowledgement(3));
      await stream.done;
      assert.equal(server.runs[0].completed, true);
      stream.request.write(payload);
    } else stream.request.write(Buffer.concat([frame(acknowledgement(3)), payload]));
    if (end) stream.request.end();
    if (code) await waitFor(() => server.errors.length === 1);
    else await new Promise((resolve) => stream.request.once("close", resolve));
    assert.equal(server.runs[0].completed, code === undefined);
    assert.deepEqual(server.errors, code ? [code] : []);
  });
});

test("current Skill context, Read/Read/Shell and history require every native result and close", async (t) => {
  const steps = [{ kind: "read", path: "/synthetic/skill/SKILL.md" },
    { kind: "read", path: "/synthetic/skill/references/memory.md" },
    { kind: "shell", command: "memorax-cli search synthetic", workingDirectory: "/synthetic/workspace", timeoutMs: 1000 }];
  const part = field(1, field(1, steps[0].path)), hook = "Exact sessionStart hook";
  const server = await mock(t, { toolSteps(run, results) {
    if (run.requestId !== requestId) return;
    assert.equal(run.contextKvReadResultCount, 1);
    assert.equal(run.inputRequestContext.agentSkills[0].fullPath, steps[0].path);
    if (!run.requestContextCloseCount) return { kind: "requestContext" };
    assert.equal(run.requestContext.hooksAdditionalContext, hook);
    return steps[results.length];
  } });
  const stream = openRun(t, server);
  stream.send(runMessage(Buffer.alloc(0), { parts: skillsReference(part, { dynamic: field(25, "initial context") }) }));
  await waitFor(() => stream.frames.length === 1);
  assert.deepEqual(stream.frames[0].body, readRequest(1, createHash("sha256").update(part).digest()));
  stream.send(readResult(1, part));
  await waitFor(() => server.runs[0].requestContextRequestCount === 1);
  const run = server.runs[0];
  stream.send(execContextResult(2, field(25, hook)));
  await waitFor(() => run.requestContextResultCount === 1);
  assert.equal(run.requestContext, undefined);
  assert.equal(run.execRequestCount, 0);
  stream.send(execControl(2));
  for (const [index, step] of steps.entries()) {
    await waitFor(() => run.execRequestCount === index + 1);
    const tool = { ...run.pendingTool };
    stream.send(execControl(tool.id, "heartbeat"));
    stream.send(step.kind === "read" ? execReadResult(tool.id, step.path, "Native skill\n")
      : execShellResult(tool.id, step.command, step.workingDirectory, '{"synthetic":true}\n'));
    await waitFor(() => run.execResultCount === index + 1);
    assert.deepEqual([run.execCloseCount, run.toolResults.length, run.kvWriteCount], [index, index, 0]);
    stream.send(execControl(tool.id));
  }
  await finishWrites(stream, run);
  assert.deepEqual([run.execRequestCount, run.execResultCount, run.execCloseCount], [3, 3, 3]);
  assert.deepEqual([run.requestContextRequestCount, run.requestContextResultCount, run.requestContextCloseCount], [1, 1, 1]);
  assert.equal(run.inputRequestContext.hooksAdditionalContext, "initial context");
  assert.deepEqual(run.requestContext.agentSkills, []);
  assert.equal(run.kvWrites.length, 6);
  assert.deepEqual(run.kvWrites.map((write) => write.id), [6, 7, 8, 9, 10, 11]);
  assert.ok(run.kvWrites.slice(1, 4).every((write) => write.bytes[0] === 18));
  const resumed = await completedRun(t, server, { prior: [run] });
  assert.equal(resumed.kvReadResultCount, 6);
  assert.equal(resumed.inputRequestContext, undefined);
  assert.equal(resumed.contextKvReadCount, 0);
  assert.deepEqual(server.errors, []);
});

test("referenced Skill and subagent catalogs validate their exact bytes before tool planning", async (t) => {
  for (const kind of ["skills", "subagents"]) for (const mode of ["valid", "empty", "missing", "hash", "length", "typed", "conflict"]) {
    await t.test(kind + " " + mode, async (t) => {
      const number = kind === "skills" ? 3 : 5, complete = kind === "skills" ? 43 : 42;
      const bytes = mode === "empty" ? Buffer.alloc(0) : mode === "typed" ? scalar(1, 1)
        : field(1, kind === "skills" ? field(1, "/synthetic/SKILL.md") : managedSubagent());
      let planned = 0;
      const server = await mock(t, { toolSteps() { planned++; } }), stream = openRun(t, server);
      const dynamic = Buffer.concat([field(25, "initial hook"), scalar(complete, 1)]);
      const parts = Buffer.concat([field(number, createHash("sha256").update(bytes).digest()),
        scalar(number + 1, bytes.length + Number(mode === "length")), field(9, dynamic)]);
      stream.send(runMessage(Buffer.alloc(0), { parts, context: mode === "conflict" ? scalar(complete, 1) : undefined }));
      await waitFor(() => stream.frames.length === 1);
      stream.send(readResult(1, mode === "missing" ? undefined : mode === "hash" ? Buffer.alloc(bytes.length) : bytes));
      const run = server.runs[0];
      if (["valid", "empty"].includes(mode)) {
        await finishWrites(stream, run);
        const catalog = kind === "skills" ? run.inputRequestContext.agentSkills : run.customSubagents;
        assert.equal(catalog.length, mode === "empty" ? 0 : 1);
        assert.equal(run.inputRequestContext.hooksAdditionalContext, "initial hook");
        assert.equal(planned, 1);
        assert.deepEqual(server.errors, []);
      } else {
        await stream.done;
        assertFailure(server, stream, mode === "missing" ? "CURSOR_AGENT_KV_READ_MISSING"
          : mode === "typed" ? "CURSOR_APP_PROTO_FIELD" : mode === "conflict"
            ? "CURSOR_AGENT_CONTEXT_CONFLICT" : "CURSOR_AGENT_KV_READ_MISMATCH");
        assert.equal(run.kvWriteCount, 0);
        assert.equal(planned, 0);
      }
    });
  }
});

test("native Exec rejects mismatched, duplicated and incomplete handshakes before persistence", async (t) => {
  for (const [name, responses, code] of [
    ["unknown id", (id) => [execReadResult(id + 1, "/synthetic/skill", "content")], "CURSOR_AGENT_EXEC_UNKNOWN"],
    ["wrong path", (id) => [execReadResult(id, "/other", "content")], "CURSOR_APP_EXEC_IDENTITY"],
    ["wrong kind", (id) => [execShellResult(id, "command", "/synthetic", "")], "CURSOR_APP_EXEC_IDENTITY"],
    ["close before result", (id) => [execControl(id)], "CURSOR_AGENT_EXEC_RESULT_MISSING"],
    ["throw", (id) => [execControl(id, "error")], "CURSOR_AGENT_EXEC_THROWN"],
    ["duplicate result", (id) => [execReadResult(id, "/synthetic/skill", "content"), execReadResult(id, "/synthetic/skill", "content"), execControl(id)], "CURSOR_AGENT_EXEC_DUPLICATE"],
    ["duplicate close", (id) => [execReadResult(id, "/synthetic/skill", "content"), execControl(id), execControl(id)], "CURSOR_AGENT_EXEC_DUPLICATE"],
    ["missing close", (id) => [execReadResult(id, "/synthetic/skill", "content")], "CURSOR_AGENT_TIMEOUT"],
    ["heartbeats", (id) => Array(33).fill(execControl(id, "heartbeat")), "CURSOR_AGENT_EXEC_HEARTBEAT_LIMIT"],
  ]) await t.test(name, async (t) => {
    const server = await mock(t, { timeoutMs: name === "missing close" ? 150 : 15000,
      toolSteps: () => ({ kind: "read", path: "/synthetic/skill" }) });
    const stream = openRun(t, server);
    stream.send(runMessage());
    await waitFor(() => server.runs[0]?.pendingTool);
    stream.request.write(Buffer.concat(responses(server.runs[0].pendingTool.id).map((message) => frame(message))));
    await stream.done;
    assertFailure(server, stream, code);
    assert.equal(server.runs[0].kvWriteCount, 0);
    assert.equal(server.runs[0].toolResults.length, 0);
  });
});

test("expected Shell denial completes only its matching rejected result, close and four ACKs", async (t) => {
  const step = { kind: "shell", command: "printf synthetic > denied-marker", workingDirectory: "/synthetic", timeoutMs: 1000, expectRejection: true };
  for (const mode of ["denied", "executed", "other failure", "wrong identity", "missing close"]) await t.test(mode, async (t) => {
    const server = await mock(t, { timeoutMs: mode === "missing close" ? 150 : 15000,
      toolSteps: (_run, results) => results.length ? undefined : step });
    const stream = openRun(t, server);
    stream.send(runMessage());
    await waitFor(() => server.runs[0]?.pendingTool);
    const run = server.runs[0], tool = { ...run.pendingTool };
    stream.send(mode === "executed" ? execShellResult(tool.id, step.command, step.workingDirectory, "")
      : execShellRejected(tool.id, step.command, step.workingDirectory, {
        variant: mode === "other failure" ? 5 : 4, execId: mode === "wrong identity" ? identity(99) : tool.toolCallId,
      }));
    if (mode === "denied") {
      await waitFor(() => run.execResultCount === 1);
      assert.deepEqual([run.execCloseCount, run.toolResults.length, run.kvWriteCount], [0, 0, 0]);
      stream.send(execControl(tool.id));
      await finishWrites(stream, run);
      assert.deepEqual(run.toolResults, [{ kind: "shell", command: step.command, workingDirectory: step.workingDirectory, rejected: true }]);
      assert.deepEqual([run.execRequestCount, run.execResultCount, run.execCloseCount, run.kvAckCount], [1, 1, 1, 4]);
      assert.equal(run.cancelled, false);
      assert.equal(server.firstShellFailure, undefined);
    } else {
      await stream.done;
      assertFailure(server, stream, mode === "missing close" ? "CURSOR_AGENT_TIMEOUT"
        : mode === "wrong identity" ? "CURSOR_APP_EXEC_IDENTITY" : "CURSOR_APP_EXEC_REJECTED");
      assert.equal(run.kvWriteCount, 0);
    }
  });
});

test("the first failed Shell retains redacted approval and exit evidence across retry", async (t) => {
  const server = await mock(t, { toolSteps: () => ({ kind: "shell", command: "synthetic", workingDirectory: "/synthetic", timeoutMs: 1000 }) });
  for (const index of [0, 1]) {
    const stream = openRun(t, server, { headers: { "x-request-id": identity(index + 10) } });
    stream.send(runMessage());
    await waitFor(() => server.runs[index]?.pendingTool);
    const run = server.runs[index], tool = run.pendingTool;
    if (!index) run.shellApproval.clicked = true;
    const output = JSON.stringify({ ok: false, action: "memory.search", errorCode: "MEMORY_SCOPE_UNAVAILABLE",
      stage: "scope", error: "private-canary" });
    stream.send(field(2, Buffer.concat([scalar(1, tool.id), field(15, tool.toolCallId), field(2, field(2,
      Buffer.concat([scalar(3, index ? 1 : 127), field(5, output), field(6, "private-canary: Operation not permitted")])))])));
    await stream.done;
    assert.equal(server.firstShellFailure, server.runs[0]);
    const diagnostic = collectCursorAppShellDiagnostics(server.firstShellFailure);
    assert.equal(server.firstShellFailure.shellApproval.clicked, true);
    assert.equal(diagnostic.exitCode, 127);
    assert.equal(diagnostic.output.errorCode, "MEMORY_SCOPE_UNAVAILABLE");
    assert.equal(diagnostic.output.markers.permissionDenied, true);
    assert.equal(JSON.stringify(diagnostic).includes("canary"), false);
    assertFailure(server, stream, "CURSOR_APP_EXEC_REJECTED");
    assert.equal(run.kvWriteCount, 0);
  }
});

test("Task binds native child/model identity, failed no-bundle finish and one matching completion notification", async (t) => {
  const commands = ["node helper claim", "node helper finish"];
  const { server, parent, run, pending } = await pendingTask(t, { toolSteps(run, results) {
    if (!run.subagentTypeName) return results.length ? undefined : taskStep;
    return results.length < 2 ? { kind: "shell", command: commands[results.length], workingDirectory: "/synthetic",
      timeoutMs: 1000, ...(results.length === 1 ? { expectedExitCode: 1 } : {}) } : undefined;
  } });
  for (const [index, changes] of [{ text: "unrelated" }, { modelId: "other" }, { subagentTypeName: "generic" }].entries()) {
    const invalid = openRun(t, server, { headers: { "x-request-id": identity(100 + index) } });
    invalid.send(runMessage(Buffer.alloc(0), { text: taskStep.prompt, session: childSession,
      modelId: taskModel, subagentTypeName: taskStep.subagentType, ...changes }));
    await invalid.done;
    assert.equal(server.errors.at(-1), "CURSOR_AGENT_TASK_CHILD_MISMATCH");
    assert.equal(server.runs.length, 1);
  }
  parent.send(execTaskResult(pending.id, pending.toolCallId, childSession));
  parent.send(execControl(pending.id));
  await finishWrites(parent, run);
  const early = openRun(t, server, { headers: { "x-request-id": identity(120) } });
  early.send(taskNotification(run.conversationStateBytes, pending.toolCallId));
  await early.done;
  assert.equal(server.errors.at(-1), "CURSOR_AGENT_TASK_NOTIFICATION_MISMATCH");
  const child = openRun(t, server, { headers: { "x-request-id": identity(20) } });
  child.send(runMessage(Buffer.alloc(0), { text: taskStep.prompt, session: childSession, userId: identity(21),
    modelId: taskModel, subagentTypeName: taskStep.subagentType }));
  await waitFor(() => server.runs[1]?.pendingTool);
  const worker = server.runs[1];
  assert.deepEqual([worker.parentConversationId, worker.taskToolCallId, worker.modelId, worker.prompt],
    [conversationId, pending.toolCallId, run.modelId, taskStep.prompt]);
  const outputs = ['{"ok":true,"status":"claimed"}', '{"ok":false,"status":"failed","failureReason":"artifact_validation_failed"}'];
  for (const index of [0, 1]) {
    await waitFor(() => worker.execRequestCount === index + 1);
    const tool = { ...worker.pendingTool };
    child.send(index === 0 ? execShellResult(tool.id, commands[index], "/synthetic", outputs[index])
      : field(2, Buffer.concat([scalar(1, tool.id), field(15, tool.toolCallId), field(2, field(2, Buffer.concat([
        field(1, commands[index]), field(2, "/synthetic"), scalar(3, 1), field(5, outputs[index]),
      ])))])));
    child.send(execControl(tool.id));
  }
  await finishWrites(child, worker);
  assert.deepEqual([run.kvWrites.length, worker.kvWrites.length], [4, 5]);
  assert.deepEqual(worker.toolResults.map((result) => result.exitCode), [0, 1]);
  assert.equal(server.firstShellFailure, undefined);
  for (const [index, changes] of [{ subagentId: identity(99) }, { taskId: identity(99) }, { kind: 1 }, { status: 2 },
    { reason: 2 }, { modelId: "other" }, { session: identity(99) }, { tool: identity(99) }, { history: Buffer.alloc(0) }].entries()) {
    const invalid = openRun(t, server, { headers: { "x-request-id": identity(200 + index) } });
    invalid.send(taskNotification(changes.history ?? run.conversationStateBytes, changes.tool ?? pending.toolCallId, changes));
    await invalid.done;
    assert.equal(server.errors.at(-1), changes.history ? "CURSOR_AGENT_HISTORY_MISMATCH" : "CURSOR_AGENT_TASK_NOTIFICATION_MISMATCH");
    assert.equal(server.notifications.length, 0);
  }
  const notice = openRun(t, server, { headers: { "x-request-id": identity(30) } });
  notice.send(taskNotification(run.conversationStateBytes, pending.toolCallId));
  for (const [index, write] of run.kvWrites.entries()) {
    await waitFor(() => notice.frames.length === index + 1);
    assert.deepEqual(notice.frames[index].body, readRequest(index + 1, write.blobId));
    notice.send(readResult(index + 1, write.bytes));
  }
  await notice.done;
  assert.deepEqual([server.runs.length, server.notifications.length, server.notifications[0].kvReadCount], [2, 1, 4]);
  assert.equal(server.notifications[0].completed, true);
  assert.equal(server.notifications[0].kvWriteCount, 0);
  assert.equal(JSON.stringify(server.notifications).includes("private"), false);
  assert.deepEqual(notice.frames.slice(-2), [{ flags: 0, body: field(1, field(14, Buffer.alloc(0))) }, { flags: 2, body: Buffer.from("{}") }]);
  const duplicate = openRun(t, server, { headers: { "x-request-id": identity(31) } });
  duplicate.send(taskNotification(run.conversationStateBytes, pending.toolCallId));
  await duplicate.done;
  assert.equal(server.errors.at(-1), "CURSOR_AGENT_TASK_NOTIFICATION_MISMATCH");
});

test("native Stop rejects the pending Shell and recovers only the same cancelled prompt identity", async (t) => {
  for (const rstCode of [http2Constants.NGHTTP2_CANCEL, http2Constants.NGHTTP2_INTERNAL_ERROR]) await t.test(String(rstCode), async (t) => {
    const { server, stream, run, tool, step, arm } = await pendingShell(t);
    arm();
    assert.throws(arm, { code: "CURSOR_AGENT_CANCELLATION_STATE" });
    stream.request.write(Buffer.concat([frame(cancelAction("composer_abort_controller_aborted")),
      frame(execShellRejected(tool.id, step.command, step.workingDirectory, { execId: tool.toolCallId })), frame(execControl(tool.id))]));
    await waitFor(() => run.cancellation.execClosed);
    assert.equal(run.cancelled, false);
    stream.request.close(rstCode);
    await waitFor(() => run.cancelled || run.error);
    assert.equal(run.cancelled, true);
    assert.equal(run.completed, false);
    assert.deepEqual(run.cancellation, { id: tool.id, toolCallId: tool.toolCallId, rejected: true, execClosed: true,
      actionReceived: true, transportClosed: true, rstCode });
    assert.deepEqual([run.execResultCount, run.execCloseCount, run.kvWriteCount, run.kvAckCount], [0, 0, 0, 0]);
    assert.deepEqual([run.requestContextRequestCount, run.requestContextResultCount, run.requestContextCloseCount], [1, 1, 1]);
    assert.equal(stream.frames.length, 3);
    for (const [index, changes] of [{ session: identity(900) }, { oldId: identity(901) }, { oldPrompt: "changed" },
      { userId: run.userMessageId }].entries()) {
      const invalid = openRun(t, server, { headers: { "x-request-id": identity(910 + index) } });
      invalid.send(runMessage(Buffer.alloc(0), { userId: identity(920), ...changes,
        prepend: [Buffer.concat([field(1, changes.oldPrompt ?? run.prompt), field(2, changes.oldId ?? run.userMessageId)])] }));
      await invalid.done;
      assert.equal(server.errors.at(-1), "CURSOR_AGENT_RECOVERY_MISMATCH");
      assert.equal(server.runs.length, 1);
    }
    const prepend = [Buffer.concat([field(1, run.prompt), field(2, run.userMessageId)])];
    const resumed = await completedRun(t, server, { text: "Synthetic recovery after Stop", prepend });
    assert.deepEqual(resumed.turnRefs, []);
    assert.deepEqual(resumed.kvWrites[0].bytes, resumed.userMessageBytes);
    const next = await completedRun(t, server, { prior: [resumed] });
    assert.deepEqual(next.turnRefs, [resumed.turnBlobId]);
    assert.equal(next.kvReadResultCount, 3);
    const consumed = openRun(t, server, { headers: { "x-request-id": identity(999) } });
    consumed.send(runMessage(next.conversationStateBytes, { userId: identity(998), prepend }));
    await consumed.done;
    assert.equal(server.errors.at(-1), "CURSOR_AGENT_RECOVERY_MISMATCH");
    assert.equal(server.runs.length, 3);
  });
});

test("cancellation is scoped to an unresolved Shell with a completed RequestContext", async (t) => {
  const { server, stream, run, tool, step, arm } = await pendingShell(t);
  for (const value of [undefined, {}, { requestId: identity(90), toolCallId: tool.toolCallId },
    { requestId, toolCallId: identity(91) }]) assert.throws(() => server.armCancellation(value), { code: "CURSOR_AGENT_CANCELLATION_STATE" });
  stream.send(execShellResult(tool.id, step.command, step.workingDirectory, ""));
  await waitFor(() => run.execResultCount === 1);
  assert.throws(arm, { code: "CURSOR_AGENT_CANCELLATION_STATE" });
  const noContext = await pendingShell(t, { context: false });
  assert.throws(noContext.arm, { code: "CURSOR_AGENT_CANCELLATION_STATE" });
  const armed = await pendingShell(t);
  armed.arm();
  const other = openRun(t, armed.server, { headers: { "x-request-id": identity(90) } });
  other.send(cancelAction());
  await other.done;
  assert.equal(armed.run.cancellation.actionReceived, false);
  assert.equal(armed.server.errors.at(-1), "CURSOR_APP_CLIENT_MESSAGE_UNSUPPORTED");
});

test("armed cancellation still fails on execution, mismatched identities, duplicates and incomplete transport", async (t) => {
  for (const [name, messages, code] of [
    ["executed", (p) => [execShellResult(p.tool.id, p.step.command, p.step.workingDirectory, "")], "CURSOR_AGENT_CANCELLATION_EXECUTED"],
    ["wrong id", (p) => [execControl(p.tool.id + 1)], "CURSOR_AGENT_EXEC_UNKNOWN"],
    ["wrong exec", (p) => [execShellRejected(p.tool.id, p.step.command, p.step.workingDirectory, { execId: identity(99) })], "CURSOR_APP_EXEC_IDENTITY"],
    ["wrong command", (p) => [execShellRejected(p.tool.id, "other", p.step.workingDirectory)], "CURSOR_APP_EXEC_IDENTITY"],
    ["other rejection", (p) => [execShellRejected(p.tool.id, p.step.command, p.step.workingDirectory, { variant: 5 })], "CURSOR_APP_EXEC_REJECTED"],
    ["missing result", (p) => [execControl(p.tool.id)], "CURSOR_AGENT_EXEC_RESULT_MISSING"],
    ["duplicate Stop", () => [cancelAction(), cancelAction()], "CURSOR_AGENT_CANCELLATION_DUPLICATE"],
    ["unknown reason", () => [cancelAction("private-canary")], "CURSOR_APP_CLIENT_MESSAGE_UNSUPPORTED"],
    ["no transport", () => [cancelAction()], "CURSOR_AGENT_TIMEOUT"],
  ]) await t.test(name, async (t) => {
    const p = await pendingShell(t, { timeoutMs: name === "no transport" ? 150 : 15000 });
    p.arm();
    p.stream.request.write(Buffer.concat(messages(p).map((message) => frame(message))));
    await p.stream.done;
    assertFailure(p.server, p.stream, code);
    assert.equal(p.run.cancelled, false);
    assert.equal(p.run.kvWriteCount, 0);
  });
  for (const mode of ["unarmed", "missing action", "missing rejection", "missing close", "ordinary close", "disconnect", "truncated"]) {
    await t.test(mode, async (t) => {
      const p = await pendingShell(t), { stream, run, tool, step } = p;
      if (mode !== "unarmed") p.arm();
      if (!["unarmed", "missing action"].includes(mode)) stream.send(cancelAction());
      if (mode !== "unarmed") {
        if (mode !== "missing rejection") stream.send(execShellRejected(tool.id, step.command, step.workingDirectory));
        if (mode !== "missing close") stream.send(execControl(tool.id));
        await waitFor(() => run.error || run.cancellation.execClosed || mode === "missing close" && run.cancellation.rejected);
      }
      if (mode === "truncated") { stream.request.write(Buffer.from([0, 0])); await delay(20); }
      if (mode === "disconnect") stream.client.destroy();
      else stream.request.close(mode === "ordinary close" ? http2Constants.NGHTTP2_NO_ERROR : http2Constants.NGHTTP2_INTERNAL_ERROR);
      await waitFor(() => p.server.errors.length);
      assert.equal(run.cancelled, false);
      assert.equal(run.completed, false);
      assert.equal(run.kvWriteCount, 0);
      assert.throws(p.arm, { code: "CURSOR_AGENT_CANCELLATION_STATE" });
    });
  }
});

test("bounded tool planning preserves fixed errors and rejects unsupported or endless plans", async (t) => {
  for (const [name, toolSteps, code] of [
    ["fixed error", () => { throw { nativeCode: "CURSOR_APP_SKILL_NOT_READ" }; }, "CURSOR_APP_SKILL_NOT_READ"],
    ["unknown error", () => { throw new Error("private-canary"); }, "CURSOR_AGENT_TOOL_PLAN_FAILED"],
    ["unsupported tool", () => ({ kind: "write" }), "CURSOR_APP_EXEC_OPTIONS"],
    ["async callback", async () => { throw new Error("private-canary"); }, "CURSOR_APP_EXEC_OPTIONS"],
    ["missing Task model", () => taskStep, "CURSOR_APP_EXEC_TASK_MODEL"],
  ]) await t.test(name, async (t) => {
    const server = await mock(t, { toolSteps }), stream = openRun(t, server);
    stream.send(runMessage());
    await stream.done;
    assertFailure(server, stream, code);
    assert.equal(server.runs[0].kvWriteCount, 0);
  });
  for (const kind of ["read", "requestContext"]) await t.test(kind + " limit", async (t) => {
    const server = await mock(t, { toolSteps: () => kind === "read" ? { kind, path: "/synthetic/skill" } : { kind } });
    const stream = openRun(t, server);
    stream.send(runMessage());
    const count = kind === "read" ? 8 : 1;
    for (let id = 1; id <= count; id++) {
      await waitFor(() => kind === "read" ? server.runs[0]?.pendingTool?.id === id : server.runs[0]?.requestContextRequestCount === 1);
      stream.request.write(Buffer.concat([frame(kind === "read" ? execReadResult(id, "/synthetic/skill", "content")
        : execContextResult(id, Buffer.alloc(0))), frame(execControl(id))]));
    }
    await stream.done;
    assertFailure(server, stream, kind === "read" ? "CURSOR_AGENT_EXEC_LIMIT" : "CURSOR_AGENT_CONTEXT_DUPLICATE");
    assert.equal(server.runs[0].kvWriteCount, 0);
  });
  for (const options of [{ answers: [] }, { answers: [""] }, { answers: [1] }, { toolSteps: {} }, { timeoutMs: 0 }]) {
    await assert.rejects(startCursorAgentMock({ answer, ...options }), { nativeCode: "CURSOR_MOCK_OPTIONS_INVALID" });
  }
});

test("malformed, excessive and oversized messages fail before Run acceptance", async (t) => {
  const oversized = Buffer.alloc(5);
  oversized.writeUInt32BE(8 * 1024 * 1024 + 1, 1);
  for (const [wire, end, code] of [
    [frame(field(8, Buffer.alloc(0))), false, "CURSOR_APP_CLIENT_MESSAGE_UNSUPPORTED"],
    [Buffer.from([0, 0]), true, "CURSOR_APP_CONNECT_TRUNCATED"],
    [oversized, false, "CURSOR_APP_CONNECT_FRAME_TOO_LARGE"],
    [Buffer.concat(Array(129).fill(frame(field(7, Buffer.alloc(0))))), false, "CURSOR_AGENT_TOO_MANY_MESSAGES"],
    [frame(acknowledgement(1)), false, "CURSOR_AGENT_UNKNOWN_ACK"],
    [frame(readResult(1, Buffer.from("private-canary"))), false, "CURSOR_AGENT_UNKNOWN_KV_READ"],
  ]) await t.test(code, async (t) => {
    const server = await mock(t), stream = openRun(t, server);
    if (end) stream.request.end(wire); else stream.request.write(wire);
    await stream.done;
    assertFailure(server, stream, code);
    assert.equal(server.runs.length, 0);
    assert.equal(stream.frames.length, 1);
  });
});

test("shutdown releases active streams and partial prefaces; idle prefaces expire", async (t) => {
  for (const mode of ["shutdown", "timeout"]) await t.test(mode, async (t) => {
    const server = await mock(t, { timeoutMs: mode === "timeout" ? 50 : 15000 });
    const port = Number(new URL(server.url).port), socket = connect({ host: "127.0.0.1", port });
    socket.on("error", () => {});
    t.after(() => socket.destroy());
    socket.write("PRI");
    const socketClosed = new Promise((resolve) => socket.once("close", resolve));
    if (mode === "shutdown") {
      const stream = openRun(t, server);
      stream.send(runMessage());
      await waitFor(() => stream.frames.length === 1);
      await Promise.all([server.close(), server.close()]);
      assert.equal(server.runs[0].completed, false);
      const probe = createServer();
      await new Promise((resolve, reject) => { probe.once("error", reject); probe.listen(port, "127.0.0.1", resolve); });
      await new Promise((resolve) => probe.close(resolve));
    } else {
      await socketClosed;
      assert.deepEqual(server.connectionErrors, ["CURSOR_MOCK_PREFACE_TIMEOUT"]);
      assert.deepEqual(server.requests, []);
    }
    await socketClosed;
    assert.deepEqual(server.errors, []);
  });
});
