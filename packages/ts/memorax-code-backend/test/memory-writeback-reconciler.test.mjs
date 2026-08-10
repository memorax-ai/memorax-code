import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  reconcileMemoryWritebackStatuses,
  startMemoryWritebackReconciler,
} from "../dist/memory/writeback-reconciler.js";
import {
  createMemoryWritebackTaskProjection,
} from "../dist/memory/writeback-task-projection.js";
import {
  clearMemoryViewerEvents,
  listMemoryViewerDataWithHistory,
  recordMemoryViewerEvent,
} from "../dist/viewer/store.js";

const MEMORAX_ENV = {
  MEMORAX_CODE_MEMORAX_ENDPOINT: "http://memorax.test",
  MEMORAX_CODE_MEMORAX_API_KEY: "test-secret",
  MEMORAX_CODE_MEMORAX_USER_ID: "test-user",
};

test.beforeEach(() => clearMemoryViewerEvents());

test("writeback reconciler does not poll when its local persistence contract is disabled", async () => {
  const cases = [
    {
      label: "writeback disabled",
      env: { ...MEMORAX_ENV, MEMORAX_CODE_MEMORAX_WRITEBACK_ENABLED: "false" },
    },
    {
      label: "Codex trace disabled",
      env: { ...MEMORAX_ENV, MEMORAX_CODE_CODEX_TRACE_ENABLED: "false" },
    },
    {
      label: "Claude trace disabled",
      client: "claude",
      env: { ...MEMORAX_ENV, MEMORAX_CODE_CLAUDE_TRACE_ENABLED: "false" },
    },
  ];
  for (const current of cases) {
    const memoraxCodeHome = await mkdtemp(join(tmpdir(), "memorax-code-writeback-disabled-"));
    const eventsPath = await writePendingWriteback(memoraxCodeHome, {
      client: current.client,
      sessionId: `session-${current.label.replaceAll(" ", "-")}`,
      eventId: `writeback-${current.label.replaceAll(" ", "-")}`,
      taskId: `task-${current.label.replaceAll(" ", "-")}`,
    });
    let requestCount = 0;

    const report = await reconcileMemoryWritebackStatuses({
      memoraxCodeHome,
      client: current.client,
      env: current.env,
      fetchImpl: async () => {
        requestCount += 1;
        throw new Error(`${current.label} must not poll MemoraX writeback status`);
      },
    });

    assert.deepEqual(report, { inspected: 0, persisted: 0, pending: 0, failed: 0 }, current.label);
    assert.equal(requestCount, 0, current.label);
    assert.equal((await readFile(eventsPath, "utf8")).trim().split("\n").length, 1, current.label);
  }
});

test("writeback reconciler persists terminal status and remains idempotent after restart", async () => {
  const memoraxCodeHome = await mkdtemp(join(tmpdir(), "memorax-code-writeback-reconciler-"));
  const eventsPath = await writePendingWriteback(memoraxCodeHome, {
    sessionId: "session-reconcile",
    eventId: "writeback-reconcile",
    taskId: "task-reconcile",
  });
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(String(url));
    return new Response(JSON.stringify({
      status: "success",
      memory: {
        summary: "Persisted memory content",
        events: [{ id: "memory-reconcile", event: "ADD" }],
      },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const first = await reconcileMemoryWritebackStatuses({
    memoraxCodeHome,
    env: MEMORAX_ENV,
    fetchImpl,
  });
  assert.deepEqual(first, { inspected: 1, persisted: 1, pending: 0, failed: 0 });
  assert.equal(requests.length, 1);
  assert.match(new URL(requests[0]).pathname, /\/v1\/memories\/add\/status\/task-reconcile$/);

  const rawEvents = (await readFile(eventsPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(rawEvents.length, 2);
  assert.equal(rawEvents[1].type, "memory_writeback_status");
  assert.equal(rawEvents[1].source, "writeback_reconciler");
  assert.equal(rawEvents[1].request.task_id, "task-reconcile");
  assert.equal(rawEvents[1].request.original_event_id, "writeback-reconcile");
  assert.equal(rawEvents[1].response.outcome, "saved");
  assert.doesNotMatch(JSON.stringify(rawEvents[1]), /test-secret/);

  const viewerData = await listMemoryViewerDataWithHistory(memoraxCodeHome);
  assert.equal(viewerData.events.length, 1);
  assert.equal(viewerData.events[0].type, "memory_writeback");
  assert.equal(viewerData.events[0].writebackOutcome, "saved");
  assert.equal(viewerData.events[0].content, "Persisted memory content");
  assert.deepEqual(viewerData.events[0].savedMemoryIds, ["memory-reconcile"]);

  clearMemoryViewerEvents();
  const second = await reconcileMemoryWritebackStatuses({
    memoraxCodeHome,
    env: MEMORAX_ENV,
    fetchImpl,
  });
  assert.deepEqual(second, { inspected: 0, persisted: 0, pending: 0, failed: 0 });
  assert.equal(requests.length, 1, "persisted terminal status must survive a new reconciler instance");
  assert.equal((await readFile(eventsPath, "utf8")).trim().split("\n").length, 2);
});

test("writeback reconciler converges Claude tasks without crossing into Codex trace", async () => {
  const memoraxCodeHome = await mkdtemp(join(tmpdir(), "memorax-code-claude-writeback-reconciler-"));
  const claudeEventsPath = await writePendingWriteback(memoraxCodeHome, {
    client: "claude",
    sessionId: "claude-session-reconcile",
    eventId: "claude-add-reconcile",
    taskId: "claude-task-reconcile",
    type: "memory_cli_add",
    source: "memory_cli",
  });
  const codexEventsPath = await writePendingWriteback(memoraxCodeHome, {
    client: "codex",
    sessionId: "codex-session-pending",
    eventId: "codex-add-pending",
    taskId: "codex-task-pending",
    type: "memory_cli_add",
    source: "memory_cli",
  });
  const requests = [];

  const report = await reconcileMemoryWritebackStatuses({
    memoraxCodeHome,
    client: "claude",
    env: MEMORAX_ENV,
    fetchImpl: async (url) => {
      requests.push(String(url));
      return new Response(JSON.stringify({
        status: "success",
        memory: {
          summary: "Claude memory content",
          events: [{ id: "claude-memory", event: "ADD" }],
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  assert.deepEqual(report, { inspected: 1, persisted: 1, pending: 0, failed: 0 });
  assert.equal(requests.length, 1);
  assert.match(new URL(requests[0]).pathname, /\/v1\/memories\/add\/status\/claude-task-reconcile$/);
  assert.equal((await readFile(claudeEventsPath, "utf8")).trim().split("\n").length, 2);
  assert.equal((await readFile(codexEventsPath, "utf8")).trim().split("\n").length, 1);

  const viewerData = await listMemoryViewerDataWithHistory(memoraxCodeHome, { client: "claude" });
  assert.equal(viewerData.events.length, 1);
  assert.equal(viewerData.events[0].client, "claude");
  assert.equal(viewerData.events[0].writebackOutcome, "saved");
  assert.equal(viewerData.events[0].content, "Claude memory content");
});

test("writeback reconciler leaves processing tasks pending without appending an event", async () => {
  const memoraxCodeHome = await mkdtemp(join(tmpdir(), "memorax-code-writeback-processing-"));
  const eventsPath = await writePendingWriteback(memoraxCodeHome, {
    sessionId: "session-processing",
    eventId: "writeback-processing",
    taskId: "task-processing",
  });

  const report = await reconcileMemoryWritebackStatuses({
    memoraxCodeHome,
    env: MEMORAX_ENV,
    fetchImpl: async () => new Response(JSON.stringify({ status: "processing" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  });

  assert.deepEqual(report, { inspected: 1, persisted: 0, pending: 1, failed: 0 });
  assert.equal((await readFile(eventsPath, "utf8")).trim().split("\n").length, 1);
  const viewerData = await listMemoryViewerDataWithHistory(memoraxCodeHome);
  assert.equal(viewerData.events[0].writebackOutcome, "pending");
});

test("writeback reconciler skips unscoped events without stopping its worker", async () => {
  const memoraxCodeHome = await mkdtemp(join(tmpdir(), "memorax-code-writeback-unscoped-"));
  const taskProjection = createMemoryWritebackTaskProjection({
    memoraxCodeHome,
    client: "codex",
  });
  const unscoped = {
    eventId: "a-writeback-unscoped",
    source: "codex_hook_writeback",
    operation: "writeback",
    ok: true,
    request: { payload: { messages: [{ role: "user", content: "Unscoped pending content" }] } },
    response: { raw: { data: { task_id: "task-unscoped", status: "queued" } } },
  };
  const scoped = {
    eventId: "b-writeback-after-unscoped",
    source: "codex_hook_writeback",
    operation: "writeback",
    ok: true,
    traceContext: {
      schemaVersion: "1",
      client: "codex",
      sessionId: "session-after-unscoped",
      turnId: "turn-after-unscoped",
      contextOrigin: "manual",
      capturedAt: "2026-07-20T00:00:00.000Z",
    },
    request: { payload: { messages: [{ role: "user", content: "Scoped pending content" }] } },
    response: { raw: { data: { task_id: "task-after-unscoped", status: "queued" } } },
  };
  for (const event of [unscoped, scoped]) {
    taskProjection.observabilityHook.recordEvent(event);
    recordMemoryViewerEvent(event);
  }
  const requests = [];

  const report = await reconcileMemoryWritebackStatuses({
    memoraxCodeHome,
    env: MEMORAX_ENV,
    concurrency: 1,
    taskProjection,
    fetchImpl: async (url) => {
      requests.push(String(url));
      return new Response(JSON.stringify({
        status: "success",
        memory: { events: [{ id: "memory-after-unscoped", event: "ADD" }] },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  assert.deepEqual(report, { inspected: 1, persisted: 1, pending: 0, failed: 0 });
  assert.equal(requests.length, 1);
  assert.match(new URL(requests[0]).pathname, /\/v1\/memories\/add\/status\/task-after-unscoped$/);
  const viewerData = await listMemoryViewerDataWithHistory(memoraxCodeHome);
  const savedEvent = viewerData.events.find((event) => event.sessionId === "session-after-unscoped");
  assert.equal(savedEvent?.writebackOutcome, "saved");
});

test("writeback reconciler converges a CLI add and does not query it again", async () => {
  const memoraxCodeHome = await mkdtemp(join(tmpdir(), "memorax-code-cli-add-reconciler-"));
  const eventsPath = await writePendingWriteback(memoraxCodeHome, {
    sessionId: "session-cli-add",
    eventId: "cli-add-reconcile",
    taskId: "task-cli-add",
    type: "memory_cli_add",
    source: "memory_cli",
  });
  let requestCount = 0;
  const fetchImpl = async () => {
    requestCount += 1;
    return new Response(JSON.stringify({
      status: "success",
      memory: {
        summary: "CLI memory content",
        events: [{ id: "memory-cli-add", event: "ADD" }],
      },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const first = await reconcileMemoryWritebackStatuses({
    memoraxCodeHome,
    env: MEMORAX_ENV,
    fetchImpl,
  });
  assert.deepEqual(first, { inspected: 1, persisted: 1, pending: 0, failed: 0 });
  assert.equal(requestCount, 1);

  const viewerData = await listMemoryViewerDataWithHistory(memoraxCodeHome);
  assert.equal(viewerData.events.length, 1);
  assert.equal(viewerData.events[0].type, "memory_cli_add");
  assert.equal(viewerData.events[0].writebackOutcome, "saved");
  assert.equal(viewerData.events[0].content, "CLI memory content");

  clearMemoryViewerEvents();
  const second = await reconcileMemoryWritebackStatuses({
    memoraxCodeHome,
    env: MEMORAX_ENV,
    fetchImpl,
  });
  assert.deepEqual(second, { inspected: 0, persisted: 0, pending: 0, failed: 0 });
  assert.equal(requestCount, 1);
  assert.equal((await readFile(eventsPath, "utf8")).trim().split("\n").length, 2);
});

test("writeback status task fallback remains scoped to its session", async () => {
  const memoraxCodeHome = await mkdtemp(join(tmpdir(), "memorax-code-writeback-session-scope-"));
  const firstPath = await writePendingWriteback(memoraxCodeHome, {
    sessionId: "session-task-first",
    eventId: "task-first",
    taskId: "shared-task",
    type: "memory_cli_add",
    source: "memory_cli",
  });
  await writePendingWriteback(memoraxCodeHome, {
    sessionId: "session-task-second",
    eventId: "task-second",
    taskId: "shared-task",
    type: "memory_cli_add",
    source: "memory_cli",
  });
  await appendFile(firstPath, `${JSON.stringify({
    schema_version: "1",
    event_id: "shared-task-status",
    type: "memory_writeback_status",
    timestamp: "2026-07-20T00:01:00.000Z",
    trace: { session_id: "session-task-first", turn_id: "turn-writeback" },
    source: "writeback_reconciler",
    operation: "writeback",
    ok: true,
    request: { task_id: "shared-task" },
    response: {
      taskId: "shared-task",
      status: "success",
      outcome: "saved",
      savedMemoryCount: 1,
      savedMemories: ["First session memory"],
    },
  })}\n`, "utf8");

  const viewerData = await listMemoryViewerDataWithHistory(memoraxCodeHome);
  const first = viewerData.events.find((event) => event.sessionId === "session-task-first");
  const second = viewerData.events.find((event) => event.sessionId === "session-task-second");
  assert.equal(first?.writebackOutcome, "saved");
  assert.equal(first?.content, "First session memory");
  assert.equal(second?.writebackOutcome, "pending");
  assert.equal(second?.content, "Pending local content");
});

test("writeback reconciler rotates bounded batches across pending tasks", async () => {
  const memoraxCodeHome = await mkdtemp(join(tmpdir(), "memorax-code-writeback-rotation-"));
  for (let index = 0; index < 3; index += 1) {
    await writePendingWriteback(memoraxCodeHome, {
      sessionId: `session-rotation-${index}`,
      eventId: `writeback-rotation-${index}`,
      taskId: `task-rotation-${index}`,
    });
  }
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(new URL(String(url)).pathname);
    return new Response(JSON.stringify({ status: "processing" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  await reconcileMemoryWritebackStatuses({
    memoraxCodeHome,
    env: MEMORAX_ENV,
    fetchImpl,
    maxTasks: 1,
    candidateOffset: 0,
  });
  await reconcileMemoryWritebackStatuses({
    memoraxCodeHome,
    env: MEMORAX_ENV,
    fetchImpl,
    maxTasks: 1,
    candidateOffset: 1,
  });

  assert.deepEqual(requests.map((path) => path.split("/").at(-1)), [
    "task-rotation-0",
    "task-rotation-1",
  ]);
});

test("started reconciler backs off pending tasks and stops scheduling after close", async () => {
  const memoraxCodeHome = await mkdtemp(join(tmpdir(), "memorax-code-writeback-backoff-"));
  await writePendingWriteback(memoraxCodeHome, {
    sessionId: "session-backoff",
    eventId: "writeback-backoff",
    taskId: "task-backoff",
  });
  let now = 0;
  let requestCount = 0;
  const reconciler = startMemoryWritebackReconciler({
    memoraxCodeHome,
    env: MEMORAX_ENV,
    intervalMs: 60_000,
    maxBackoffMs: 4 * 60_000,
    now: () => now,
    fetchImpl: async () => {
      requestCount += 1;
      return new Response(JSON.stringify({ status: "processing" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  try {
    assert.deepEqual(
      await reconciler.runNow(),
      { inspected: 1, persisted: 0, pending: 1, failed: 0 },
    );
    assert.deepEqual(
      await reconciler.runNow(),
      { inspected: 0, persisted: 0, pending: 0, failed: 0 },
    );
    now = 60_000;
    assert.deepEqual(
      await reconciler.runNow(),
      { inspected: 1, persisted: 0, pending: 1, failed: 0 },
    );
    now = 2 * 60_000;
    assert.deepEqual(
      await reconciler.runNow(),
      { inspected: 0, persisted: 0, pending: 0, failed: 0 },
    );
    now = 3 * 60_000;
    assert.deepEqual(
      await reconciler.runNow(),
      { inspected: 1, persisted: 0, pending: 1, failed: 0 },
    );
    assert.equal(requestCount, 3);
  } finally {
    reconciler.close();
  }
  now = 24 * 60 * 60_000;
  assert.deepEqual(
    await reconciler.runNow(),
    { inspected: 0, persisted: 0, pending: 0, failed: 0 },
  );
  assert.equal(requestCount, 3);
});

test("writeback reconciler close waits for its active run", async () => {
  const memoraxCodeHome = await mkdtemp(join(tmpdir(), "memorax-code-writeback-close-drain-"));
  await writePendingWriteback(memoraxCodeHome, {
    sessionId: "session-close-drain",
    eventId: "writeback-close-drain",
    taskId: "task-close-drain",
  });
  let notifyFetchStarted;
  let resolveFetch;
  const fetchStarted = new Promise((resolve) => {
    notifyFetchStarted = resolve;
  });
  const reconciler = startMemoryWritebackReconciler({
    memoraxCodeHome,
    env: MEMORAX_ENV,
    intervalMs: 60_000,
    fetchImpl: async () => {
      notifyFetchStarted();
      return await new Promise((resolve) => {
        resolveFetch = resolve;
      });
    },
  });

  await fetchStarted;
  const closing = reconciler.close();
  let settled = false;
  void closing.then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false);

  resolveFetch(new Response(JSON.stringify({ status: "processing" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
  await closing;
  assert.equal(settled, true);
  assert.deepEqual(
    await reconciler.runNow(),
    { inspected: 0, persisted: 0, pending: 0, failed: 0 },
  );
});

async function writePendingWriteback(memoraxCodeHome, {
  client = "codex",
  sessionId,
  eventId,
  taskId,
  type = "memory_writeback",
  source = "codex_hook_writeback",
}) {
  const sessionDir = join(memoraxCodeHome, "debug", "traces", client, "sessions", sessionId);
  const eventsPath = join(sessionDir, "events.jsonl");
  await mkdir(sessionDir, { recursive: true });
  await writeFile(eventsPath, `${JSON.stringify({
    schema_version: "1",
    event_id: eventId,
    type,
    timestamp: "2026-07-20T00:00:00.000Z",
    trace: { client, session_id: sessionId, turn_id: "turn-writeback" },
    source,
    operation: "writeback",
    ok: true,
    request: { payload: { messages: [{ role: "user", content: "Pending local content" }] } },
    response: { raw: { data: { task_id: taskId, status: "queued" } } },
  })}\n`, "utf8");
  return eventsPath;
}
