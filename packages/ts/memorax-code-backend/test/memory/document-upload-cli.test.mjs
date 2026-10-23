import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile, truncate } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { runMemoryCli } from "../../dist/memory/cli.js";

const inputId = "12345678-1234-4234-8234-123456789abc";
async function fixture(t, fetchImpl) {
  const root = await mkdtemp(join(tmpdir(), "memorax-document-upload-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "workspace");
  await mkdir(cwd);
  return { root, options: { cwd, env: { MEMORAX_CODE_HOME: join(root, "state"),
    MEMORAX_CODE_MEMORAX_ENDPOINT: "http://memorax.test", MEMORAX_CODE_MEMORAX_USER_ID: "test-user",
    MEMORAX_CODE_MEMORAX_API_KEY: "synthetic-test-key" }, fetchImpl } };
}
const uploadArgs = path => ["add", "--document-file", path, "--document-id", "policy", "--input-id", inputId, "--expected-revision", "0"];
const accepted = () => Response.json({ success: true, data: { task_id: "task-1", status: "accepted", data: null, document_id: "policy", input_id: inputId, revision: null } }, { status: 202 });

for (const extension of ["pdf", "docx", "xlsx", "pptx"]) {
  test(`document upload sends complete ${extension} bytes with explicit identity and no local path`, async t => {
    const calls = [];
    const { root, options } = await fixture(t, async (url, init) => {
      const request = JSON.parse(init.body.get("request"));
      const file = init.body.get("file");
      calls.push({ url, init, request, name: file.name, bytes: Buffer.from(await file.arrayBuffer()) });
      return accepted();
    });
    const path = join(root, `private-file.${extension}`);
    const bytes = Buffer.from([0, 255, 32, 13, 10, 128]);
    await writeFile(path, bytes);
    const result = await runMemoryCli(uploadArgs(path), options);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.receipt.status, "accepted");
    assert.equal(result.receipt.revision, null);
    assert.equal(result.receipt.pending, true);
    assert.equal(result.receipt.task_id, "task-1");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "http://memorax.test/v1/memories/add");
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.headers["x-request-id"], inputId);
    assert.equal(calls[0].init.headers["Content-Type"], undefined);
    assert.deepEqual(calls[0].request, { user_id: "test-user@workspace", document_id: "policy", input_id: inputId,
      expected_revision: 0, memory_output_language: "zh", content_type: "document", async_mode: true });
    assert.deepEqual(calls[0].bytes, bytes);
    assert.equal(calls[0].name.includes(root), false);
  });
}

test("document upload rejects unsupported files, oversized files and ambiguous identity without dispatch", async t => {
  let calls = 0;
  const { root, options } = await fixture(t, async () => { calls++; return accepted(); });
  const path = join(root, "input.pdf");
  await writeFile(path, "pdf");
  for (const args of [
    uploadArgs(path).filter((_x, i) => i !== 5 && i !== 6),
    [...uploadArgs(path), "--memory", "mixed"],
    [...uploadArgs(path), "--memory-file", path],
    [...uploadArgs(path), "--content-type", "code"],
    uploadArgs(path).map(x => x === inputId ? "not-a-uuid" : x),
    [...uploadArgs(path), "--sha256", "invalid"],
  ]) assert.equal((await runMemoryCli(args, options)).ok, false);
  const unsupported = join(root, "input.exe");
  await writeFile(unsupported, "file");
  assert.equal((await runMemoryCli(uploadArgs(unsupported), options)).ok, false);
  await writeFile(path, "");
  assert.equal((await runMemoryCli(uploadArgs(path), options)).ok, false);
  const directory = join(root, "directory.pdf");
  await mkdir(directory);
  assert.equal((await runMemoryCli(uploadArgs(directory), options)).ok, false);
  await truncate(path, 150 * 1024 * 1024 + 1);
  assert.equal((await runMemoryCli(uploadArgs(path), options)).ok, false);
  assert.equal(calls, 0);
});

test("upload timeout reports unknown submission and retains its identity without retransmitting", async t => {
  let calls = 0;
  const { root, options } = await fixture(t, async () => { calls++; throw new DOMException("private file text", "TimeoutError"); });
  const path = join(root, "input.pdf");
  await writeFile(path, "pdf");
  const result = await runMemoryCli(uploadArgs(path), options);
  assert.equal(result.ok, false);
  assert.equal(result.receipt.status, "submission_unknown");
  assert.equal(result.receipt.input_id, inputId);
  assert.equal(result.receipt.expected_revision, 0);
  assert.equal(JSON.stringify(result).includes("private file text"), false);
  assert.equal(calls, 1);
});

test("manifest submissions keep per-file success and failure receipts independently", async t => {
  let calls = 0;
  const { root, options } = await fixture(t, async () => { calls++; return accepted(); });
  await writeFile(join(root, "input.pdf"), "pdf");
  const manifest = join(root, "uploads.json");
  await writeFile(manifest, JSON.stringify([
    { path: "missing.docx", document_id: "missing", input_id: "22345678-1234-4234-8234-123456789abc", expected_revision: 0 },
    { path: "input.pdf", document_id: "policy", input_id: inputId, expected_revision: 0 },
  ]));
  const result = await runMemoryCli(["add", "--document-manifest", manifest], options);
  assert.equal(result.ok, false);
  assert.equal(result.results.length, 2);
  assert.equal(result.results[0].ok, false);
  assert.equal(result.results[1].ok, true);
  assert.equal(result.results[1].receipt.input_id, inputId);
  assert.equal(calls, 1);
});

test("removed wait flags reject every Add input before sending a request", async t => {
  let calls = 0;
  const { root, options } = await fixture(t, async () => { calls++; return accepted(); });
  const path = join(root, "input.pdf");
  await writeFile(path, "pdf");
  const snapshot = join(root, "snapshot.txt");
  await writeFile(snapshot, "Full document text");
  const manifest = join(root, "uploads.json");
  await writeFile(manifest, JSON.stringify([{ path: "input.pdf", document_id: "policy", input_id: inputId, expected_revision: 0 }]));
  const commands = [
    uploadArgs(path),
    ["add", "--document-manifest", manifest],
    ["add", "--memory", "Record the policy discussion.", "--type", "episodic", "--reason", "Requested record"],
    ["add", "--content-type", "document", "--memory-file", snapshot, "--document-id", "policy", "--input-id", inputId, "--expected-revision", "0"],
  ];
  for (const command of commands) {
    for (const flags of [["--wait"], ["--wait-timeout-ms", "1000"], ["--poll-interval-ms", "1"], ["--wait=true"], ["--wait-timeout-ms=1000"], ["--poll-interval-ms=1"]]) {
      const result = await runMemoryCli([...command, ...flags], options);
      assert.equal(result.ok, false, flags.join(" "));
      assert.equal(result.errorCode, "MEMORY_INPUT_INVALID");
      assert.equal(result.stage, "input");
      assert.match(result.error, /unsupported add flag/);
    }
  }
  assert.equal(calls, 0);
});

test("add-status is rejected as an unknown command without contacting MemoraX", async t => {
  let calls = 0;
  const { options } = await fixture(t, async () => { calls++; return accepted(); });
  for (const flags of [[], ["--task-id", "task-1"], ["--task-id", "task-1", "--wait"]]) {
    const result = await runMemoryCli(["add-status", ...flags], options);
    assert.equal(result.ok, false);
    assert.match(result.error, /unknown memory command: add-status/);
  }
  assert.equal(calls, 0);
});

test("upload rejection and server uncertainty preserve identity without exposing response bodies or retrying", async t => {
  for (const httpStatus of [400, 401, 409, 429, 500, 503]) {
    let calls = 0;
    const { root, options } = await fixture(t, async () => {
      calls++;
      return Response.json({ error: "private document text" }, { status: httpStatus });
    });
    const path = join(root, "input.pdf");
    await writeFile(path, "pdf");
    const result = await runMemoryCli(uploadArgs(path), options);
    assert.equal(result.ok, false);
    assert.equal(result.httpStatus, httpStatus);
    assert.deepEqual(result.receipt, {
      document_id: "policy", input_id: inputId, expected_revision: 0, revision: null,
      status: httpStatus >= 500 ? "submission_unknown" : "failed", pending: httpStatus >= 500,
    });
    assert.equal(JSON.stringify(result).includes("private document text"), false);
    assert.equal(calls, 1);
  }
});

test("ordinary manual Add defaults to automatic classification and explicit code remains pre-summarized", async t => {
  const bodies = [];
  const { options } = await fixture(t, async (_url, init) => { bodies.push(JSON.parse(init.body)); return accepted(); });
  const args = ["add", "--memory", "Discussed the reimbursement policy.", "--type", "episodic", "--reason", "Requested record"];
  assert.equal((await runMemoryCli(args, options)).ok, true);
  assert.equal(bodies[0].content_type, "auto");
  assert.equal(bodies[0].mode, "default");
  assert.equal((await runMemoryCli([...args, "--content-type", "code"], options)).ok, true);
  assert.equal(bodies[1].content_type, "code");
  assert.equal(bodies[1].mode, "pre_summarized");
});

test("search preserves source fields in items and shows document provenance in visible text", async t => {
  const item = { content: "Approve travel in advance.", content_type: "document", metadata: { document_id: "travel-policy", document_revision: 3, record_kind: "document_chunk", chunk_index: 0, chunk_count: 1 }, input_id: inputId };
  const { options } = await fixture(t, async () => Response.json({ success: true, data: { data: [item] } }));
  const result = await runMemoryCli(["search", "--query", "travel policy", "--sources", "document"], options);
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.items, [item]);
  assert.match(result.answer, /travel-policy/);
  assert.match(result.answer, /revision.*3/);
});

test("manifest preparation failures retain the explicit document identity", async t => {
  const { root, options } = await fixture(t, async () => accepted());
  const manifest = join(root, "uploads.json");
  await writeFile(manifest, JSON.stringify([{ path: "missing.pdf", document_id: "policy", input_id: inputId, expected_revision: 4 }]));
  const result = await runMemoryCli(["add", "--document-manifest", manifest], options);
  assert.equal(result.results[0].receipt.document_id, "policy");
  assert.equal(result.results[0].receipt.input_id, inputId);
  assert.equal(result.results[0].receipt.expected_revision, 4);
  assert.equal(result.results[0].receipt.pending, false);
});


test("multipart upload stops at the accepted receipt over a real loopback HTTP connection", async t => {
  const received = [];
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      received.push({ method: request.method, url: request.url, requestId: request.headers["x-request-id"], authorization: request.headers.authorization, bytes });
      response.setHeader("Content-Type", "application/json");
      if (request.method === "POST") {
        const body = await new Request("http://localhost", { method: "POST", headers: request.headers, body: bytes }).formData();
        assert.equal(JSON.parse(body.get("request")).user_id, "test-user@workspace");
        assert.deepEqual(Buffer.from(await body.get("file").arrayBuffer()), Buffer.from([0, 255, 13, 10]));
        response.statusCode = 202;
        response.end(JSON.stringify({ success: true, data: { task_id: "task-1", status: "accepted", data: null, document_id: "policy", input_id: inputId, revision: null } }));
      } else { response.statusCode = 405; response.end("{}"); }
    } catch { response.statusCode = 500; response.end("{}"); }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const { root, options } = await fixture(t);
  options.env.MEMORAX_CODE_MEMORAX_ENDPOINT = `http://127.0.0.1:${server.address().port}`;
  const path = join(root, "sample.pdf");
  await writeFile(path, Buffer.from([0, 255, 13, 10]));
  const result = await runMemoryCli(uploadArgs(path), options);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.receipt.status, "accepted");
  assert.equal(result.receipt.pending, true);
  assert.equal(result.receipt.revision, null);
  assert.equal(result.receipt.task_id, "task-1");
  assert.deepEqual(received.map(value => value.method), ["POST"]);
  assert.equal(received[0].url, "/v1/memories/add");
  assert.equal(received[0].requestId, inputId);
  assert.equal(received[0].authorization, "Token synthetic-test-key");
  assert.equal(received[0].bytes.includes(Buffer.from(root)), false);
});

test("unreadable workspace blocks document upload before network dispatch", async t => {
  let calls = 0;
  const { root, options } = await fixture(t, async () => { calls++; return accepted(); });
  const path = join(root, "input.pdf");
  await writeFile(path, "pdf");
  const unavailable = { ...options, cwd: join(root, "unavailable") };
  assert.equal((await runMemoryCli(uploadArgs(path), unavailable)).ok, false);
  assert.equal(calls, 0);
});

test("explicit retries preserve the accepted revision and request identity without claiming completion", async t => {
  for (const expectedRevision of [0, 3]) {
    const requests = [];
    const { root, options } = await fixture(t, async (_url, init) => {
      assert.equal(init.method, "POST");
      requests.push({ body: init.body.get("request"), requestId: init.headers["x-request-id"] });
      return Response.json({ success: true, data: { task_id: "task-1", status: "accepted", data: null,
        document_id: "policy", input_id: inputId, revision: expectedRevision + 1 } }, { status: 202 });
    });
    const path = join(root, "retry.pdf");
    await writeFile(path, "identical document");
    const args = uploadArgs(path);
    args[args.indexOf("--expected-revision") + 1] = String(expectedRevision);
    const acceptedRetry = await runMemoryCli(args, options);
    assert.equal(acceptedRetry.ok, true, acceptedRetry.error);
    assert.equal(acceptedRetry.receipt.task_id, "task-1");
    assert.equal(acceptedRetry.receipt.revision, expectedRevision + 1);
    assert.equal(acceptedRetry.receipt.status, "accepted");
    assert.equal(acceptedRetry.receipt.pending, true);
    const repeated = await runMemoryCli(args, options);
    assert.equal(repeated.ok, true, repeated.error);
    assert.deepEqual(repeated.receipt, acceptedRetry.receipt);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0], requests[1]);
  }
});

test("accepted retry revisions must be the next safe positive document revision", async t => {
  for (const revision of [0, -1, 2, 1.5, "1", Number.MAX_SAFE_INTEGER + 1]) {
    const { root, options } = await fixture(t, async () => Response.json({ success: true, data: {
      task_id: "task-1", status: "accepted", data: null, document_id: "policy", input_id: inputId, revision,
    } }, { status: 202 }));
    const path = join(root, "retry.pdf");
    await writeFile(path, "pdf");
    const result = await runMemoryCli(uploadArgs(path), options);
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, "MEMORAX_INVALID_RESPONSE");
    assert.equal(result.receipt.status, "submission_unknown");
  }
});

test("uppercase input UUIDs use one canonical request identity and accept canonical response identities", async t => {
  for (const receiptInputId of [inputId, inputId.toUpperCase()]) {
    const requests = [];
    const { root, options } = await fixture(t, async (_url, init) => {
      assert.equal(init.method, "POST");
      requests.push({ inputId: JSON.parse(init.body.get("request")).input_id, requestId: init.headers["x-request-id"] });
      return Response.json({ success: true, data: { task_id: "task-1", status: "accepted", data: null,
        document_id: "policy", input_id: receiptInputId, revision: null } }, { status: 202 });
    });
    const path = join(root, "uppercase.pdf");
    await writeFile(path, "pdf");
    const result = await runMemoryCli(uploadArgs(path).map(value => value === inputId ? inputId.toUpperCase() : value), options);
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(requests, [{ inputId, requestId: inputId }]);
    assert.equal(result.receipt.status, "accepted");
    assert.equal(result.receipt.pending, true);
    assert.equal(result.receipt.input_id, inputId);
  }
});

test("manifest input UUID uniqueness is case independent before network submission", async t => {
  let calls = 0;
  const { root, options } = await fixture(t, async () => { calls++; return accepted(); });
  await writeFile(join(root, "input.pdf"), "pdf");
  const manifest = join(root, "uploads.json");
  await writeFile(manifest, JSON.stringify([
    { path: "input.pdf", document_id: "policy", input_id: inputId, expected_revision: 0 },
    { path: "input.pdf", document_id: "policy", input_id: inputId.toUpperCase(), expected_revision: 0 },
  ]));
  const result = await runMemoryCli(["add", "--document-manifest", manifest], options);
  assert.equal(result.ok, false);
  assert.equal(result.results[0].ok, true);
  assert.equal(result.results[1].errorCode, "MEMORY_INPUT_INVALID");
  assert.equal(calls, 1);
});
