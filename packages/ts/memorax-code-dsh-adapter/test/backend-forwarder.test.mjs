import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import {
  DSH_BACKEND_HTTP_ERROR,
  DSH_BACKEND_NOT_CONFIGURED,
  DSH_BACKEND_TIMEOUT,
  DSH_BACKEND_UNREACHABLE,
  DshBackendError,
  createBackendForwarder,
  postBackend,
} from "../src/backend-forwarder.mjs";

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

test("postBackend throws DshBackendError with unreachable code on connection failures", async () => {
  await assert.rejects(
    () => postBackend("/memory/writeback", { version: 1 }, {
      backendUrl: "http://127.0.0.1:59999",
      timeoutMs: 200,
    }),
    (error) => {
      assert.ok(error instanceof DshBackendError);
      assert.equal(error.code, DSH_BACKEND_UNREACHABLE);
      assert.equal(error.name, "DshBackendError");
      return true;
    },
  );
});

test("postBackend throws DshBackendError with timeout code when the backend stalls", async (t) => {
  const server = createServer(() => {});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  t.after(() => new Promise((resolve) => server.close(resolve)));

  await assert.rejects(
    () => postBackend("/memory/turn-start", { version: 1 }, {
      backendUrl: `http://127.0.0.1:${port}`,
      timeoutMs: 100,
    }),
    (error) => {
      assert.ok(error instanceof DshBackendError);
      assert.equal(error.code, DSH_BACKEND_TIMEOUT);
      return true;
    },
  );
});

test("postBackend throws DshBackendError with http_error code on non-2xx responses", async (t) => {
  const server = createServer((req, res) => {
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unavailable" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  t.after(() => new Promise((resolve) => server.close(resolve)));

  await assert.rejects(
    () => postBackend("/memory/writeback", { version: 1 }, {
      backendUrl: `http://127.0.0.1:${port}`,
      timeoutMs: 1000,
    }),
    (error) => {
      assert.ok(error instanceof DshBackendError);
      assert.equal(error.code, DSH_BACKEND_HTTP_ERROR);
      assert.equal(error.status, 503);
      return true;
    },
  );
});

test("postBackend throws DshBackendError when the backend URL is missing", async () => {
  await assert.rejects(
    () => postBackend("/memory/turn-start", { version: 1 }, {}),
    (error) => {
      assert.ok(error instanceof DshBackendError);
      assert.equal(error.code, DSH_BACKEND_NOT_CONFIGURED);
      assert.equal(error.message, "backend URL is not configured");
      return true;
    },
  );
});

test("postBackend refuses to follow redirects", async (t) => {
  const redirects = [];
  const server = createServer((req, res) => {
    redirects.push(req.url);
    res.writeHead(307, { location: "http://127.0.0.1:1/evil" });
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  t.after(() => new Promise((resolve) => server.close(resolve)));

  await assert.rejects(
    () => postBackend("/memory/turn-start", { version: 1 }, {
      backendUrl: `http://127.0.0.1:${port}`,
      token: "secret",
      timeoutMs: 1000,
    }),
    (error) => {
      // The redirect must abort the request instead of forwarding the token
      // header and command body to the redirect target.
      assert.ok(error instanceof DshBackendError);
      assert.equal(error.code, DSH_BACKEND_UNREACHABLE);
      return true;
    },
  );
  assert.deepEqual(redirects, ["/memory/turn-start"]);
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
