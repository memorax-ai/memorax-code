import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

test("Backend starts isolated writeback reconcilers for Codex and Claude", { concurrency: false }, async () => {
  const memoraxCodeHome = await mkdtemp(join(tmpdir(), "memorax-code-backend-client-reconcilers-"));
  const traces = await Promise.all([
    writePendingWritebackTrace(memoraxCodeHome, "codex", "codex-reconcile-task"),
    writePendingWritebackTrace(memoraxCodeHome, "claude", "claude-reconcile-task"),
  ]);
  const dshTrace = await writePendingWritebackTrace(
    memoraxCodeHome,
    "dsh",
    "dsh-trace-only-task",
  );
  const restoreEnv = withEnv({
    MEMORAX_CODE_CODEX_TRACE_ENABLED: "true",
    MEMORAX_CODE_CLAUDE_TRACE_ENABLED: "true",
    MEMORAX_CODE_DSH_TRACE_ENABLED: "true",
    MEMORAX_CODE_MEMORAX_ENDPOINT: "http://memorax.test",
    MEMORAX_CODE_MEMORAX_API_KEY: "secret",
    MEMORAX_CODE_MEMORAX_USER_ID: "user-1",
    MEMORAX_CODE_MEMORY_WRITEBACK_ENABLED: "true",
  });
  const originalFetch = globalThis.fetch;
  const requests = [];
  let notifyBothPolled;
  const bothPolled = new Promise((resolve) => {
    notifyBothPolled = resolve;
  });
  globalThis.fetch = async (url) => {
    const taskId = new URL(String(url)).pathname.split("/").at(-1);
    requests.push(taskId);
    if (requests.length === 2) notifyBothPolled();
    return new Response(JSON.stringify({
      status: "success",
      memory: {
        summary: `${taskId} memory`,
        events: [{ id: `${taskId}-memory`, event: "ADD" }],
      },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const server = createBackendServer(
    createBackendState("127.0.0.1", { sessionHome: memoraxCodeHome }),
  );
  try {
    await Promise.race([
      bothPolled,
      new Promise((_, reject) => setTimeout(() => reject(new Error("both client tasks were not polled")), 1_000)),
    ]);
    await server.shutdown();

    assert.deepEqual(new Set(requests), new Set([
      "codex-reconcile-task",
      "claude-reconcile-task",
    ]));
    for (const trace of traces) {
      const events = (await readFile(trace.eventsPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.equal(events.length, 2);
      assert.equal(events[1].type, "memory_writeback_status");
      assert.equal(events[1].trace.client, trace.client);
      assert.equal(events[1].response.outcome, "saved");
      assert.equal(events[1].response.savedMemoryCount, 1);
    }
    const dshEvents = (await readFile(dshTrace.eventsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(dshEvents.length, 1, "DSH Trace must not activate reconciliation in this batch");
  } finally {
    await server.shutdown();
    globalThis.fetch = originalFetch;
    restoreEnv();
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

async function writePendingWritebackTrace(memoraxCodeHome, client, taskId) {
  const sessionId = `${client}-reconcile-session`;
  const sessionDir = join(memoraxCodeHome, "debug", "traces", client, "sessions", sessionId);
  const eventsPath = join(sessionDir, "events.jsonl");
  await mkdir(sessionDir, { recursive: true });
  await writeFile(eventsPath, `${JSON.stringify({
    schema_version: "1",
    event_id: `${client}-reconcile-event`,
    type: "memory_cli_add",
    timestamp: "2026-07-28T14:46:04.994Z",
    trace: { client, session_id: sessionId, turn_id: `${client}-reconcile-turn` },
    source: "memory_cli",
    operation: "writeback",
    ok: true,
    request: { payload: { messages: [{ role: "user", content: `${client} pending content` }] } },
    response: { raw: { data: { task_id: taskId, status: "accepted" } } },
  })}\n`, "utf8");
  return { client, eventsPath };
}
