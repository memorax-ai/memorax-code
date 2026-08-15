import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
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
