import assert from "node:assert/strict";
import test from "node:test";

import { createHttpBackendClient } from "../src/http-client.mjs";

test("uses the shared Backend authority for both DSH memory endpoints", async () => {
  const requests = [];
  const client = createHttpBackendClient({
    resolveConnection: () => ({ url: "http://127.0.0.1:9123", token: "local-token" }),
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response(JSON.stringify({ ok: true, additionalContext: "memory" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    env: { MEMORAX_CODE_DSH_MEMORY_HOOK_TIMEOUT_MS: "1000" },
  });
  const start = { version: 1, client: "dsh", sessionId: "s", turn: 1 };
  const end = { version: 1, client: "dsh", sessionId: "s", turn: 1, events: [] };

  await client.recordTurnStart(start);
  await client.writebackTurn(end);

  assert.deepEqual(requests.map(({ url }) => url), [
    "http://127.0.0.1:9123/memory/turn-start",
    "http://127.0.0.1:9123/memory/writeback",
  ]);
  assert.deepEqual(JSON.parse(requests[0].init.body), start);
  assert.deepEqual(JSON.parse(requests[1].init.body), end);
  assert.equal(requests[0].init.headers["x-memorax-code-backend-token"], "local-token");
});
