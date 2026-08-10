import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  completeMemoryWritebackTask,
  createMemoryWritebackTaskProjection,
  pendingMemoryWritebackTasks,
  projectMemoryWritebackTasks,
} from "../dist/memory/writeback-task-projection.js";
import { clientTracePaths } from "../dist/trace/config.js";

test("writeback task projection prefers an explicit origin over task fallback", () => {
  const tasks = projectMemoryWritebackTasks([
    pendingTask("origin-first", "session-first", "shared-task"),
    pendingTask("origin-second", "session-first", "shared-task"),
    {
      kind: "status",
      eventId: "status-explicit",
      timestamp: "2026-07-20T00:01:00.000Z",
      client: "codex",
      sessionId: "session-first",
      taskId: "shared-task",
      originalEventId: "origin-first",
      completion: completeMemoryWritebackTask({
        status: "success",
        memoryKnown: true,
        memory: { summary: "Explicit result" },
      }),
    },
    {
      kind: "status",
      eventId: "status-fallback",
      timestamp: "2026-07-20T00:02:00.000Z",
      client: "codex",
      sessionId: "session-first",
      taskId: "shared-task",
      completion: completeMemoryWritebackTask({
        status: "failed",
        error: "Fallback result",
      }),
    },
  ]);

  assert.equal(tasks[0].completion.outcome, "saved");
  assert.equal(tasks[0].completion.savedMemories?.[0], "Explicit result");
  assert.equal(tasks[1].completion.outcome, "failed");
});

test("writeback task projection scopes explicit origins to their client and session", () => {
  const tasks = projectMemoryWritebackTasks([
    pendingTask("shared-origin", "session-first", "task-first"),
    pendingTask("shared-origin", "session-second", "task-second"),
    {
      kind: "status",
      eventId: "status-first",
      timestamp: "2026-07-20T00:01:00.000Z",
      client: "codex",
      sessionId: "session-first",
      taskId: "task-first",
      originalEventId: "shared-origin",
      completion: completeMemoryWritebackTask({
        status: "success",
        memoryKnown: true,
        memory: { summary: "First session result" },
      }),
    },
  ]);
  const bySession = new Map(tasks.map((task) => [task.sessionId, task]));

  assert.equal(bySession.get("session-first")?.completion.outcome, "saved");
  assert.equal(bySession.get("session-second")?.completion.outcome, "pending");
  assert.equal(bySession.get("session-second")?.statusEventId, undefined);
});

test("writeback task projection never schedules a rejected origin", () => {
  assert.deepEqual(pendingMemoryWritebackTasks([{
    ...pendingTask("rejected-origin", "session-rejected", "task-rejected"),
    ok: false,
  }]), []);
});

test("Codex writeback task projection excludes unscoped and Claude live events", async () => {
  const memoraxCodeHome = await mkdtemp(join(tmpdir(), "memorax-code-writeback-task-client-"));
  const projection = createMemoryWritebackTaskProjection({
    memoraxCodeHome,
    client: "codex",
  });
  try {
    projection.observabilityHook.recordEvent?.(liveWriteback(undefined, "unscoped-task"));
    projection.observabilityHook.recordEvent?.(liveWriteback("claude", "claude-task"));
    projection.observabilityHook.recordEvent?.(liveWriteback("codex", "codex-task"));

    const pending = await projection.listPending();
    assert.deepEqual(pending.map((task) => ({
      client: task.client,
      sessionId: task.sessionId,
      taskId: task.taskId,
    })), [{
      client: "codex",
      sessionId: "session-codex",
      taskId: "codex-task",
    }]);
  } finally {
    await rm(memoraxCodeHome, { recursive: true, force: true });
  }
});

test("Codex writeback task projection retains colliding live event ids across sessions", async () => {
  const memoraxCodeHome = await mkdtemp(join(tmpdir(), "memorax-code-writeback-task-live-sessions-"));
  const projection = createMemoryWritebackTaskProjection({
    memoraxCodeHome,
    client: "codex",
  });
  try {
    projection.observabilityHook.recordEvent?.(liveWriteback("codex", "task-first", {
      eventId: "shared-live-event",
      sessionId: "session-first",
    }));
    projection.observabilityHook.recordEvent?.(liveWriteback("codex", "task-second", {
      eventId: "shared-live-event",
      sessionId: "session-second",
    }));

    const pending = await projection.listPending();
    assert.deepEqual(pending
      .map((task) => [task.sessionId, task.taskId])
      .sort((left, right) => left[0].localeCompare(right[0])), [
      ["session-first", "task-first"],
      ["session-second", "task-second"],
    ]);
  } finally {
    await rm(memoraxCodeHome, { recursive: true, force: true });
  }
});

test("writeback task projection preserves opaque trace-prefixed event ids", async () => {
  const memoraxCodeHome = await mkdtemp(join(tmpdir(), "memorax-code-writeback-task-opaque-ids-"));
  const projection = createMemoryWritebackTaskProjection({
    memoraxCodeHome,
    client: "codex",
  });
  try {
    projection.observabilityHook.recordEvent?.(liveWriteback("codex", "task-plain", {
      eventId: "evt_shared",
      sessionId: "session-opaque",
    }));
    projection.observabilityHook.recordEvent?.(liveWriteback("codex", "task-prefixed", {
      eventId: "trace:evt_shared",
      sessionId: "session-opaque",
    }));

    const pending = await projection.listPending();
    assert.deepEqual(
      pending
        .map((task) => [task.eventId, task.taskId])
        .sort((left, right) => left[0].localeCompare(right[0])),
      [
        ["evt_shared", "task-plain"],
        ["trace:evt_shared", "task-prefixed"],
      ],
    );
  } finally {
    await rm(memoraxCodeHome, { recursive: true, force: true });
  }
});

test("writeback task projection requires an explicit origin task id to match", () => {
  const tasks = projectMemoryWritebackTasks([
    pendingTask("evt_shared", "session-opaque", "task-plain"),
    pendingTask("trace:evt_shared", "session-opaque", "task-prefixed"),
    {
      kind: "status",
      eventId: "status-task-fallback",
      timestamp: "2026-07-20T00:01:00.000Z",
      client: "codex",
      sessionId: "session-opaque",
      taskId: "task-plain",
      originalEventId: "trace:evt_shared",
      completion: completeMemoryWritebackTask({
        status: "success",
        memoryKnown: true,
        memory: { summary: "Plain task result" },
      }),
    },
  ]);
  const byTask = new Map(tasks.map((task) => [task.taskId, task]));

  assert.equal(byTask.get("task-plain")?.completion.outcome, "saved");
  assert.equal(byTask.get("task-plain")?.statusEventId, "status-task-fallback");
  assert.equal(byTask.get("task-prefixed")?.completion.outcome, "pending");
  assert.equal(byTask.get("task-prefixed")?.statusEventId, undefined);
});

test("Codex writeback task projection retains colliding history and live event ids", async () => {
  const memoraxCodeHome = await mkdtemp(join(tmpdir(), "memorax-code-writeback-task-history-live-"));
  const paths = clientTracePaths("codex", memoraxCodeHome);
  const projection = createMemoryWritebackTaskProjection({
    memoraxCodeHome,
    client: "codex",
  });
  try {
    await mkdir(paths.sessionDir("session-history"), { recursive: true });
    await writeFile(paths.eventsJsonl("session-history"), `${JSON.stringify({
      event_id: "shared-history-live-event",
      type: "memory_writeback",
      timestamp: "2026-07-20T00:00:00.000Z",
      trace: {
        client: "codex",
        session_id: "session-history",
      },
      ok: true,
      response: {
        raw: {
          data: {
            task_id: "task-history",
            status: "queued",
          },
        },
      },
    })}\n`, "utf8");
    projection.observabilityHook.recordEvent?.(liveWriteback("codex", "task-live", {
      eventId: "shared-history-live-event",
      sessionId: "session-live",
    }));

    const pending = await projection.listPending();
    assert.deepEqual(pending
      .map((task) => [task.sessionId, task.taskId])
      .sort((left, right) => left[0].localeCompare(right[0])), [
      ["session-history", "task-history"],
      ["session-live", "task-live"],
    ]);
  } finally {
    await rm(memoraxCodeHome, { recursive: true, force: true });
  }
});

function pendingTask(eventId, sessionId, taskId) {
  return {
    kind: "task",
    eventId,
    timestamp: "2026-07-20T00:00:00.000Z",
    client: "codex",
    sessionId,
    ok: true,
    taskId,
    status: "queued",
  };
}

function liveWriteback(client, taskId, options = {}) {
  return {
    eventId: options.eventId ?? `live-${taskId}`,
    source: client === "claude" ? "claude_hook_writeback" : "codex_hook_writeback",
    operation: "writeback",
    ok: true,
    ...(client ? {
      traceContext: {
        schemaVersion: "1",
        client,
        sessionId: options.sessionId ?? `session-${client}`,
        turnId: `turn-${client}`,
        contextOrigin: "manual",
        capturedAt: "2026-07-20T00:00:00.000Z",
      },
    } : {}),
    response: {
      raw: {
        data: {
          task_id: taskId,
          status: "queued",
        },
      },
    },
  };
}
