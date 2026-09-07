import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createBackendState } from "../../dist/app/state.js";
import { createBackendServer } from "../../dist/server.js";
import { listen } from "../support/helpers.mjs";

test("Backend close is idempotent and waits for observability drain", async () => {
  const memoraxCodeHome = await mkdtemp(join(tmpdir(), "memorax-code-backend-shutdown-drain-"));
  let notifyDrainStarted;
  let releaseDrain;
  const drainStarted = new Promise((resolve) => {
    notifyDrainStarted = resolve;
  });
  const server = createBackendServer(
    createBackendState("127.0.0.1", { sessionHome: memoraxCodeHome }),
    {
      memoryObservability: {
        recordEvent() {},
        drain() {
          notifyDrainStarted();
          return new Promise((resolve) => {
            releaseDrain = resolve;
          });
        },
      },
    },
  );
  await listen(server);
  try {
    const closeSettled = new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    const first = server.shutdown();
    const second = server.shutdown();
    assert.equal(first, second);
    await drainStarted;

    let settled = false;
    void closeSettled.then(() => {
      settled = true;
    });
    await Promise.resolve();
    assert.equal(settled, false);

    releaseDrain();
    await Promise.all([first, closeSettled]);
    assert.equal(settled, true);
  } finally {
    releaseDrain?.();
    await rm(memoraxCodeHome, { recursive: true, force: true });
  }
});

test("Backend shutdown completes when observability drain exceeds its deadline", async () => {
  const memoraxCodeHome = await mkdtemp(join(tmpdir(), "memorax-code-shutdown-stalled-drain-"));
  let notifyDrainStarted;
  let releaseDrain;
  let drainCalls = 0;
  const drainStarted = new Promise((resolve) => {
    notifyDrainStarted = resolve;
  });
  const drainBlocked = new Promise((resolve) => {
    releaseDrain = resolve;
  });
  const server = createBackendServer(
    createBackendState("127.0.0.1", { sessionHome: memoraxCodeHome }),
    {
      shutdownTimeoutMs: 100,
      memoryObservability: {
        recordEvent() {},
        drain() {
          drainCalls += 1;
          notifyDrainStarted();
          return drainBlocked;
        },
      },
    },
  );
  await listen(server);
  try {
    const shuttingDown = server.shutdown();
    await within(drainStarted, "shutdown did not reach observability drain");
    await within(shuttingDown, "shutdown waited indefinitely for a stalled drain");
    assert.equal(drainCalls, 1);
    assert.equal(server.listening, false);
    assert.strictEqual(server.shutdown(), shuttingDown);
  } finally {
    releaseDrain();
    await server.shutdown();
    await rm(memoraxCodeHome, { recursive: true, force: true });
  }
});

test("Backend shutdown force-closes an unfinished request without granting later phases a new deadline", async (t) => {
  const memoraxCodeHome = await mkdtemp(join(tmpdir(), "memorax-code-shutdown-stalled-request-"));
  let drainCalls = 0;
  const server = createBackendServer(
    createBackendState("127.0.0.1", { sessionHome: memoraxCodeHome, authToken: "" }),
    {
      shutdownTimeoutMs: 100,
      memoryObservability: {
        recordEvent() {},
        async drain() {
          drainCalls += 1;
        },
      },
    },
  );
  const forceClose = t.mock.method(server, "closeAllConnections");
  const url = await listen(server);
  const requestStarted = new Promise((resolve) => server.once("request", resolve));
  const unfinished = request(`${url}/memory/turn-start`, {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": "100" },
  });
  const requestFailed = new Promise((resolve) => unfinished.once("error", resolve));
  unfinished.write("{");
  try {
    const incoming = await within(requestStarted, "unfinished request did not reach the Backend");
    assert.equal(incoming.complete, false);
    const socket = incoming.socket;
    const socketClosed = new Promise((resolve) => socket.once("close", resolve));

    await within(server.shutdown(), "shutdown did not finish after the request deadline");
    await within(socketClosed, "shutdown left the unfinished request socket open");
    const error = await within(requestFailed, "unfinished request was not interrupted");
    assert.equal(error.code, "ECONNRESET");
    assert.equal(forceClose.mock.callCount(), 1);
    assert.equal(socket.destroyed, true);
    assert.equal(server.listening, false);
    assert.equal(drainCalls, 0, "later drains must not run after the shared deadline is exhausted");
  } finally {
    unfinished.destroy();
    server.closeAllConnections();
    await server.shutdown();
    await rm(memoraxCodeHome, { recursive: true, force: true });
  }
});

test("Backend shutdown flushes a pending writeback before exit", { concurrency: false }, async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-backend-shutdown-writeback-"));
  const memoraxCodeHome = join(root, "home");
  const workspace = fileURLToPath(new URL("../..", import.meta.url));
  const transcriptPath = join(root, "rollout.jsonl");
  await Promise.all([
    mkdir(memoraxCodeHome, { recursive: true }),
    writeFile(transcriptPath, `${[
      {
        timestamp: "2026-07-26T00:00:00.000Z",
        type: "session_meta",
        payload: { id: "session-shutdown-writeback" },
      },
      {
        timestamp: "2026-07-26T00:00:01.000Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "turn-shutdown-writeback" },
      },
      {
        timestamp: "2026-07-26T00:00:01.001Z",
        type: "turn_context",
        payload: { turn_id: "turn-shutdown-writeback" },
      },
      {
        timestamp: "2026-07-26T00:00:02.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "Flush this turn during shutdown." },
      },
      {
        timestamp: "2026-07-26T00:00:03.000Z",
        type: "event_msg",
        payload: {
          type: "agent_message",
          message: "The buffered writeback must reach MemoraX.",
          phase: "final_answer",
        },
      },
    ].map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8"),
  ]);
  const restoreEnv = withEnv({
    MEMORAX_CODE_CODEX_TRACE_ENABLED: "false",
    MEMORAX_CODE_MEMORY_RETRIEVAL_ENABLED: "false",
    MEMORAX_CODE_MEMORY_WRITEBACK_ENABLED: "true",
    MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_ENABLED: "true",
    MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_MAX_TURNS: "8",
    MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_MAX_AGE_MS: "60000",
    MEMORAX_CODE_MEMORAX_ENDPOINT: "http://memorax.test",
    MEMORAX_CODE_MEMORAX_API_KEY: "secret",
    MEMORAX_CODE_MEMORAX_USER_ID: "user-1",
  });
  const originalFetch = globalThis.fetch;
  const memoraxRequests = [];
  globalThis.fetch = async (url, init) => {
    memoraxRequests.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({
      success: true,
      data: { task_id: "shutdown-writeback", status: "queued" },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const server = createBackendServer(
    createBackendState("127.0.0.1", { sessionHome: memoraxCodeHome }),
    { shutdownTimeoutMs: 250 },
  );
  const url = await listen(server);
  try {
    const turnStart = await originalFetch(`${url}/memory/turn-start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: 1,
        client: "codex",
        sessionId: "session-shutdown-writeback",
        turnId: "turn-shutdown-writeback",
        prompt: "Flush this turn during shutdown.",
        cwd: workspace,
        transcriptPath,
      }),
    });
    assert.equal(turnStart.status, 200);

    const writeback = await originalFetch(`${url}/memory/writeback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: 1,
        client: "codex",
        sessionId: "session-shutdown-writeback",
        turnId: "turn-shutdown-writeback",
        lastAssistantMessage: "The buffered writeback must reach MemoraX.",
        transcriptPath,
      }),
    });
    assert.equal(writeback.status, 200);
    assert.deepEqual(await writeback.json(), { ok: true, scheduled: true });
    assert.equal(memoraxRequests.length, 0);

    await server.shutdown();

    assert.equal(memoraxRequests.length, 1);
    assert.equal(memoraxRequests[0].url, "http://memorax.test/v1/memories/add");
    assert.deepEqual(
      memoraxRequests[0].body.messages.map((message) => message.content),
      [
        "Flush this turn during shutdown.",
        "The buffered writeback must reach MemoraX.",
      ],
    );
  } finally {
    await server.shutdown();
    globalThis.fetch = originalFetch;
    restoreEnv();
    await rm(root, { recursive: true, force: true });
  }
});

async function within(promise, message, timeoutMs = 1000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function withEnv(updates) {
  const previous = new Map(Object.keys(updates).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}
