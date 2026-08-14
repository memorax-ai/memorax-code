import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { createBackendForwarder, postBackend } from "../src/backend-forwarder.mjs";

test("postBackend posts the command and returns the parsed response", async (t) => {
  const received = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      received.push({ url: req.url, headers: req.headers, body: JSON.parse(body) });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const result = await postBackend("/memory/turn-start", {
    version: 1,
    client: "dsh",
    sessionId: "s",
    turnId: "dsh-0-1",
    prompt: "hello",
  }, { backendUrl: `http://127.0.0.1:${port}`, token: "secret" });

  assert.equal(result.ok, true);
  assert.equal(received.length, 1);
  assert.equal(received[0].url, "/memory/turn-start");
  assert.equal(received[0].headers["x-memorax-code-backend-token"], "secret");
  assert.equal(received[0].body.client, "dsh");
});

test("postBackend swallows connection failures and returns an error result", async () => {
  const result = await postBackend("/memory/writeback", { version: 1 }, {
    backendUrl: "http://127.0.0.1:1",
    timeoutMs: 200,
  });
  assert.equal(result.ok, false);
  assert.equal(typeof result.error, "string");
});

test("postBackend returns an error when the backend URL is missing", async () => {
  const result = await postBackend("/memory/turn-start", { version: 1 }, {});
  assert.equal(result.ok, false);
  assert.equal(result.error, "backend URL is not configured");
});

test("createBackendForwarder returns a forward function bound to the connection", async (t) => {
  const received = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      received.push(JSON.parse(body));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, additionalContext: "ctx" }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const forwarder = createBackendForwarder({
    backendUrl: `http://127.0.0.1:${port}`,
    token: undefined,
    timeoutMs: 1000,
  });
  const result = await forwarder.forward("/memory/turn-start", { version: 1, client: "dsh" });
  assert.equal(result.ok, true);
  assert.equal(result.body.additionalContext, "ctx");
  assert.equal(received[0].client, "dsh");
});
