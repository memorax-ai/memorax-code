import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { postBackendCommand } from "../src/backend-command.mjs";

const command = {
  connection: { url: "http://127.0.0.1:8787", token: "test-backend-token" },
  path: "/memory/writeback",
  body: { version: 1, client: "codex", sessionId: "session-1", lastAssistantMessage: " Keep whitespace. " },
  timeoutMs: 1000,
};

test.beforeEach(async (t) => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-hook-command-"));
  command.memoraxCodeHome = home;
  t.after(() => rm(home, { recursive: true, force: true }));
});

test("Backend command sends authenticated JSON and leaves status and body policy to the caller", async () => {
  const response = new Response("not JSON", { status: 413 });
  let calls = 0;
  const result = await postBackendCommand({
    ...command,
    fetchImpl: async (url, request) => {
      calls += 1;
      assert.equal(url.href, "http://127.0.0.1:8787/memory/writeback");
      assert.equal(request.method, "POST");
      assert.deepEqual(request.headers, {
        "content-type": "application/json",
        connection: "close",
        "x-memorax-code-backend-token": "test-backend-token",
      });
      assert.deepEqual(JSON.parse(request.body), command.body);
      return response;
    },
  });
  assert.equal(calls, 1);
  assert.equal(result, response);
  assert.equal(result.status, 413);
  assert.equal(result.bodyUsed, false);
  assert.equal(await result.text(), "not JSON");
});

test("Backend command omits authentication when the resolved connection has no token", async () => {
  await postBackendCommand({
    ...command,
    connection: { url: "http://127.0.0.1:8788" },
    fetchImpl: async (url, request) => {
      assert.equal(url.port, "8788");
      assert.equal(Object.hasOwn(request.headers, "x-memorax-code-backend-token"), false);
      return new Response(null, { status: 204 });
    },
  });
});

test("Backend command preserves caller cancellation and its reason", async () => {
  const controller = new AbortController();
  const reason = new Error("client disabled");
  const result = postBackendCommand({
    ...command,
    signal: controller.signal,
    fetchImpl: async (_url, { signal }) => {
      assert.equal(signal.aborted, false);
      return await new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        controller.abort(reason);
      });
    },
  });
  await assert.rejects(result, (error) => error === reason);
});

test("Backend command applies its deadline even when a caller signal is supplied", async () => {
  const controller = new AbortController();
  await assert.rejects(postBackendCommand({
    ...command,
    timeoutMs: 20,
    signal: controller.signal,
    fetchImpl: async (_url, { signal }) => await new Promise((_resolve, reject) => {
      const guard = setTimeout(() => reject(new Error("request deadline was not applied")), 1000);
      signal.addEventListener("abort", () => {
        clearTimeout(guard);
        reject(signal.reason);
      }, { once: true });
    }),
  }), (error) => error.name === "TimeoutError");
  assert.equal(controller.signal.aborted, false);
  assert.equal((await commandDiagnostics())[0].errorCode, "HOOK_BACKEND_REQUEST_TIMEOUT");
});

test("Backend command propagates transport errors without retrying writeback", async () => {
  let calls = 0;
  const failure = new Error("connection lost after sending request");
  await assert.rejects(postBackendCommand({
    ...command,
    fetchImpl: async () => { calls += 1; throw failure; },
  }), (error) => error === failure);
  assert.equal(calls, 1);
});

test("Hook dispatch failures record one safe diagnostic with Debug off and preserve the response", async () => {
  const response = new Response("private response body", { status: 403 });
  const result = await postBackendCommand({ ...command, fetchImpl: async () => response });
  assert.equal(result, response);
  assert.equal(result.bodyUsed, false);
  const [record] = await commandDiagnostics();
  assert.equal(record.errorCode, "HOOK_BACKEND_HTTP_REJECTED");
  assert.equal(record.httpStatus, 403);
  assert.equal(record.client, "codex");
  assert.match(record.sessionHash, /^[a-f0-9]{24}$/);
  assert.equal(record.operation, "memory.writeback");
  const text = JSON.stringify(record);
  for (const secret of ["test-backend-token", "private response body", "session-1", "Keep whitespace", command.memoraxCodeHome]) {
    assert.equal(text.includes(secret), false);
  }
  assert.equal((await commandDiagnostics()).length, 1);
});

test("Hook transport records only safe system information and preserves the original exception", async () => {
  const failure = Object.assign(new Error("secret request payload and /private/file"), { cause: { code: "ECONNREFUSED" } });
  await assert.rejects(postBackendCommand({ ...command, fetchImpl: async () => { throw failure; } }), (error) => error === failure);
  const [record] = await commandDiagnostics();
  assert.equal(record.errorCode, "HOOK_BACKEND_REQUEST_FAILED");
  assert.equal(record.systemCode, "ECONNREFUSED");
  assert.equal(JSON.stringify(record).includes("secret"), false);
  assert.equal((await commandDiagnostics()).length, 1);
});

test("Hook success, caller cancellation, and unrelated endpoints do not create diagnostics", async () => {
  await postBackendCommand({ ...command, fetchImpl: async () => new Response(null, { status: 204 }) });
  const controller = new AbortController();
  const reason = new Error("turn canceled");
  await assert.rejects(postBackendCommand({
    ...command,
    signal: controller.signal,
    fetchImpl: async () => { controller.abort(reason); throw reason; },
  }), (error) => error === reason);
  await postBackendCommand({ ...command, path: "/health", fetchImpl: async () => new Response(null, { status: 503 }) });
  await postBackendCommand({ ...command, path: "/memory/skill-reminder", fetchImpl: async () => new Response(null, { status: 503 }) });
  assert.deepEqual(await commandDiagnostics(), []);
});

test("unwritable Hook diagnostics preserve rejection and HTTP response without retry", async () => {
  await mkdir(join(command.memoraxCodeHome, "runtime"));
  await writeFile(join(command.memoraxCodeHome, "runtime", "diagnostics"), "blocked");
  const failure = new Error("transport failed");
  let calls = 0;
  await assert.rejects(postBackendCommand({ ...command, fetchImpl: async () => { calls += 1; throw failure; } }), (error) => error === failure);
  assert.equal(calls, 1);
  const response = new Response(null, { status: 500 });
  assert.equal(await postBackendCommand({ ...command, fetchImpl: async () => response }), response);
  assert.equal(response.bodyUsed, false);
});

async function commandDiagnostics() {
  const directory = join(command.memoraxCodeHome, "runtime", "diagnostics");
  const files = await readdir(directory).catch((error) => { if (error.code === "ENOENT") return []; throw error; });
  return await Promise.all(files.map(async (name) => JSON.parse(await readFile(join(directory, name), "utf8"))));
}
