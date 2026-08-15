import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { backendConnectionPath, backendTokenPath } from "../src/config.mjs";
import { apply, name } from "../src/index.mjs";

function recordingCtx() {
  const handlers = {};
  return {
    handlers,
    on(event, handler) {
      handlers[event] = handler;
    },
  };
}

function textMessage(text) {
  return { content: [{ type: "text", text }], source: { kind: "user" } };
}

test("apply tolerates a null or missing plugin config", () => {
  for (const config of [null, undefined, {}]) {
    const ctx = recordingCtx();
    assert.doesNotThrow(() => apply(ctx, config));
    assert.equal(typeof ctx.handlers["session/created"], "function");
    assert.equal(typeof ctx.handlers["session/event"], "function");
    assert.equal(typeof ctx.handlers["session/disposed"], "function");
  }
});

test("the DSH adapter exposes the memorax-dsh plugin name", () => {
  assert.equal(name, "memorax-dsh");
});

test("llm/stream waits for the pending turn-start retrieval before streaming", async (t) => {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      if (req.url === "/memory/turn-start") {
        setTimeout(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, additionalContext: "recalled memory" }));
        }, 40);
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const ctx = recordingCtx();
  apply(ctx, { injectRetrieval: true, backendUrl: `http://127.0.0.1:${port}` });

  const sess = { id: "session-x", header: { cwd: "/repo" }, firstLiveSeq: 1 };
  ctx.handlers["session/created"](sess);
  ctx.handlers["session/event"](sess, { type: "turn/start", data: { turn: 0 } });
  ctx.handlers["session/event"](sess, { type: "user/message", data: textMessage("query") });

  const options = { sessionId: "session-x" };
  const stream = ctx.handlers["llm/stream"](options, async function* () { yield "chunk"; });
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);

  assert.deepEqual(chunks, ["chunk"]);
  assert.equal(options.system, "recalled memory");
});

test("hook dispatches re-resolve the backend authority after apply", async (t) => {
  // Codex round 8, index.mjs:13 — the managed Backend may start AFTER this
  // plugin loads and its token can rotate mid-run. apply() must not freeze the
  // connection: every dispatch re-reads the authority records.
  const home = mkdtempSync(join(tmpdir(), "memorax-dsh-late-authority-"));
  const previousHome = process.env.MEMORAX_CODE_HOME;
  process.env.MEMORAX_CODE_HOME = home;
  t.after(() => {
    if (previousHome === undefined) delete process.env.MEMORAX_CODE_HOME;
    else process.env.MEMORAX_CODE_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  const turnStarts = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      if (req.url === "/memory/turn-start") {
        turnStarts.push({ token: req.headers["x-memorax-code-backend-token"] });
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const writeAuthority = (token) => {
    mkdirSync(join(home, "runtime", "backend"), { recursive: true });
    writeFileSync(backendConnectionPath(home), JSON.stringify({
      version: 1,
      url: `http://127.0.0.1:${port}`,
      tokenPath: backendTokenPath(home),
    }), "utf8");
    writeFileSync(backendTokenPath(home), JSON.stringify({
      version: 1,
      token,
      createdAt: "2026-01-01T00:00:00.000Z",
      ...(token === "token-2" ? { rotatedAt: "2026-02-01T00:00:00.000Z" } : {}),
    }), "utf8");
  };

  // Load the plugin while NO authority record exists yet.
  const ctx = recordingCtx();
  apply(ctx, {});

  const sess = { id: "session-late", header: { cwd: "/repo" }, firstLiveSeq: 1 };
  const startTurn = (turn) => {
    ctx.handlers["session/created"](sess);
    ctx.handlers["session/event"](sess, { type: "turn/start", data: { turn } });
    ctx.handlers["session/event"](sess, { type: "user/message", data: textMessage(`query ${turn}`) });
  };

  // The managed Backend starts late and writes its authority record now.
  writeAuthority("token-1");
  startTurn(0);
  await waitFor(() => turnStarts.length >= 1, "turn-start never reached the late-started Backend");
  assert.equal(turnStarts[0].token, "token-1");

  // Token rotation while DSH keeps running: the next dispatch must pick up
  // the rotated token without reloading the plugin.
  writeAuthority("token-2");
  startTurn(1);
  await waitFor(() => turnStarts.length >= 2, "second turn-start never reached the Backend");
  assert.equal(turnStarts[1].token, "token-2");
});

async function waitFor(predicate, message) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}
