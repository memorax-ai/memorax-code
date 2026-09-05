import assert from "node:assert/strict";
import test from "node:test";
import { postBackendCommand } from "../../memorax-code-adapter-common/src/backend-command.mjs";

const command = {
  connection: { url: "http://127.0.0.1:8787", token: "test-backend-token" },
  path: "/memory/writeback",
  body: { version: 1, client: "codex", sessionId: "session-1", lastAssistantMessage: " Keep whitespace. " },
  timeoutMs: 1000,
};

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
