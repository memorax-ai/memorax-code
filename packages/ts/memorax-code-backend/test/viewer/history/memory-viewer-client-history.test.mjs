import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  clearMemoryViewerEvents,
  listMemoryViewerDataWithHistory,
  listMemoryViewerEvents,
  recordMemoryViewerEvent,
} from "../../../dist/viewer/store.js";
import { projectMemoryViewerUserData } from "../../../dist/viewer/projection/user.js";

test.beforeEach(() => clearMemoryViewerEvents());

test("memory viewer combines client-isolated history without identity collisions", async (t) => {
  const memoraxCodeHome = await mkdtemp(join(tmpdir(), "memorax-code-viewer-clients-"));
  t.after(() => rm(memoraxCodeHome, { recursive: true, force: true }));
  const projectId = `repo:${"a".repeat(32)}`;
  const shared = {
    type: "memory_retrieve",
    event_id: "shared-event",
    trace: {
      session_id: "shared-session",
      memory_project: { project_id: projectId, project_label: "Shared Project" },
    },
    source: "direct_overlay",
    operation: "retrieve",
    ok: true,
  };
  await writeTraceEvents(memoraxCodeHome, "codex", "shared-session", [{
    ...shared,
    timestamp: "2026-07-28T00:00:00.000Z",
    response: { items: [{ memory: "Codex memory." }] },
  }]);
  await writeTraceEvents(memoraxCodeHome, "claude", "shared-session", [{
    ...shared,
    timestamp: "2026-07-28T00:01:00.000Z",
    response: { items: [{ memory: "Claude memory." }] },
  }]);

  const all = await listMemoryViewerDataWithHistory(memoraxCodeHome);
  assert.deepEqual(all.events.map(({ client, id, content }) => ({ client, id, content })), [{
    client: "codex",
    id: "trace:shared-event",
    content: "Codex memory.",
  }, {
    client: "claude",
    id: "claude-trace:shared-event",
    content: "Claude memory.",
  }]);
  assert.equal(new Set(all.events.map((event) => event.id)).size, 2);
  assert.equal(new Set(all.events.map((event) => event.eventKey)).size, 2);
  assert.equal(
    all.events[0].eventKey,
    JSON.stringify(["codex", "shared-session", "trace:shared-event"]),
  );
  assert.deepEqual(all.projectSessions.map(({ client, projectId: id, sessionId, eventCount }) => ({
    client,
    projectId: id,
    sessionId,
    eventCount,
  })), [{
    client: "claude",
    projectId,
    sessionId: "shared-session",
    eventCount: 1,
  }, {
    client: "codex",
    projectId,
    sessionId: "shared-session",
    eventCount: 1,
  }]);
  assert.deepEqual(
    all.activityProjectSessions.map((entry) => entry.client),
    ["claude", "codex"],
  );

  for (const client of ["codex", "claude"]) {
    const selected = await listMemoryViewerDataWithHistory(memoraxCodeHome, { client });
    assert.deepEqual(selected.events.map((event) => event.client), [client]);
    assert.deepEqual(selected.projectSessions.map((entry) => entry.client), [client]);
    assert.deepEqual(selected.catalogSourceEvents.map((event) => event.client), [client]);
  }
});

test("memory viewer canonicalizes persisted timestamps before user projection", async (t) => {
  const memoraxCodeHome = await mkdtemp(join(tmpdir(), "memorax-code-viewer-timestamp-"));
  t.after(() => rm(memoraxCodeHome, { recursive: true, force: true }));
  const secret = "private prompt /Users/alice session-123";
  await writeTraceEvents(memoraxCodeHome, "codex", "timestamp-session", [{
    type: "memory_retrieve",
    event_id: "timestamp-event",
    timestamp: `Tue, 28 Jul 2026 00:00:00 GMT (${secret})`,
    trace: { session_id: "timestamp-session" },
    source: "direct_overlay",
    operation: "retrieve",
    ok: true,
    response: { items: [] },
  }]);

  const data = await listMemoryViewerDataWithHistory(memoraxCodeHome, { client: "codex" });
  assert.equal(data.events[0]?.timestamp, "2026-07-28T00:00:00.000Z");
  const projection = projectMemoryViewerUserData(data.events);
  assert.equal(projection.activities[0]?.occurredAt, "2026-07-28T00:00:00.000Z");
  assert.doesNotMatch(JSON.stringify(projection), new RegExp(escapeRegExp(secret)));
});

test("memory viewer projects superseded orphan turns without writing a synthetic end", async (t) => {
  const memoraxCodeHome = await mkdtemp(join(tmpdir(), "memorax-code-viewer-orphan-turn-"));
  t.after(() => rm(memoraxCodeHome, { recursive: true, force: true }));
  await writeTraceEvents(memoraxCodeHome, "codex", "orphan-session", [
    {
      type: "turn_start",
      event_id: "orphan-start",
      timestamp: "2026-07-28T00:00:00.000Z",
      trace: { session_id: "orphan-session", turn_id: "orphan-turn" },
      operation: "query",
      request: { prompt: "Interrupted prompt." },
    },
    {
      type: "turn_start",
      event_id: "latest-start",
      timestamp: "2026-07-28T00:01:00.000Z",
      trace: { session_id: "orphan-session", turn_id: "latest-turn" },
      operation: "query",
      request: { prompt: "Latest prompt." },
    },
  ]);

  const data = await listMemoryViewerDataWithHistory(memoraxCodeHome, {
    client: "codex",
    includeUserProjection: true,
  });
  assert.deepEqual(data.events.map(({ type, turnId, turnOutcome }) => ({
    type,
    turnId,
    turnOutcome,
  })), [{
    type: "turn_start",
    turnId: "orphan-turn",
    turnOutcome: "interrupted",
  }, {
    type: "turn_start",
    turnId: "latest-turn",
    turnOutcome: undefined,
  }]);
  assert.equal(data.events.some((event) => event.type === "turn_end"), false);
  assert.deepEqual(data.userProjection.activities.map(({ status }) => status), [
    "processing",
    "interrupted",
  ]);
  assert.equal(data.userProjection.summary.processingCount, 1);
});

test("memory viewer keeps session-title candidates qualified by client", async (t) => {
  const memoraxCodeHome = await mkdtemp(join(tmpdir(), "memorax-code-viewer-client-titles-"));
  t.after(() => rm(memoraxCodeHome, { recursive: true, force: true }));
  for (const [client, prompt, timestamp] of [
    ["codex", "Codex session title", "2026-07-28T00:00:00.000Z"],
    ["claude", "Claude session title", "2026-07-28T00:01:00.000Z"],
  ]) {
    await writeTraceEvents(memoraxCodeHome, client, "shared-session", [{
      type: "turn_start",
      event_id: "shared-start",
      timestamp,
      trace: { session_id: "shared-session", turn_id: "shared-turn" },
      operation: "query",
      request: { prompt },
    }]);
  }

  const data = await listMemoryViewerDataWithHistory(memoraxCodeHome);
  assert.deepEqual(data.sessionTitleCandidates.map(({ client, sessionId, title }) => ({
    client,
    sessionId,
    title,
  })), [{
    client: "codex",
    sessionId: "shared-session",
    title: "Codex session title",
  }, {
    client: "claude",
    sessionId: "shared-session",
    title: "Claude session title",
  }]);
});

test("memory viewer keeps client activity and complete Turn windows isolated", async (t) => {
  const memoraxCodeHome = await mkdtemp(join(tmpdir(), "memorax-code-viewer-client-turns-"));
  t.after(() => rm(memoraxCodeHome, { recursive: true, force: true }));
  const sharedTrace = { session_id: "same-session", turn_id: "same-turn" };
  await writeTraceEvents(memoraxCodeHome, "codex", "same-session", [{
    type: "turn_start",
    event_id: "codex-old-start",
    timestamp: "2026-07-01T00:00:00.000Z",
    trace: sharedTrace,
    operation: "query",
    request: { prompt: "Old Codex prompt." },
  }]);
  await writeTraceEvents(memoraxCodeHome, "claude", "same-session", [{
    type: "memory_retrieve",
    event_id: "claude-recent-search",
    timestamp: "2026-07-28T00:00:00.000Z",
    trace: sharedTrace,
    source: "claude_hook_overlay",
    operation: "retrieve",
    ok: true,
    response: { items: [{ memory: "Recent Claude result." }] },
  }]);

  const active = await listMemoryViewerDataWithHistory(memoraxCodeHome, {
    activeSessionSince: Date.parse("2026-07-27T00:00:00.000Z"),
  });
  assert.deepEqual(active.events.map(({ client, id }) => ({ client, id })), [{
    client: "claude",
    id: "claude-trace:claude-recent-search",
  }]);
  assert.deepEqual(active.turnEvents.map(({ client, id }) => ({ client, id })), [{
    client: "claude",
    id: "claude-trace:claude-recent-search",
  }]);
});

test("memory viewer keeps fallback writeback statuses isolated by client", async (t) => {
  const memoraxCodeHome = await mkdtemp(join(tmpdir(), "memorax-code-viewer-client-writeback-"));
  t.after(() => rm(memoraxCodeHome, { recursive: true, force: true }));
  const task = (client, eventId, timestamp) => ({
    type: "memory_writeback",
    event_id: eventId,
    timestamp,
    trace: { session_id: "shared-session", turn_id: "shared-turn" },
    source: client === "claude" ? "claude_hook_writeback" : "hook_writeback",
    operation: "writeback",
    ok: true,
    request: {
      payload: {
        messages: [{ role: "user", content: `${client} pending content` }],
      },
    },
    response: { raw: { data: { task_id: "shared-task", status: "queued" } } },
  });
  await writeTraceEvents(memoraxCodeHome, "codex", "shared-session", [
    task("codex", "codex-writeback", "2026-07-28T00:00:00.000Z"),
  ]);
  await writeTraceEvents(memoraxCodeHome, "claude", "shared-session", [
    task("claude", "claude-writeback", "2026-07-28T00:00:30.000Z"),
    {
      type: "memory_writeback_status",
      event_id: "claude-status",
      timestamp: "2026-07-28T00:01:00.000Z",
      trace: { session_id: "shared-session", turn_id: "shared-turn" },
      source: "writeback_reconciler",
      operation: "writeback",
      ok: true,
      request: { task_id: "shared-task" },
      response: {
        taskId: "shared-task",
        status: "success",
        outcome: "saved",
        savedMemoryCount: 1,
        savedMemories: ["Claude private saved memory"],
      },
      error: "Claude private status detail",
    },
  ]);

  const data = await listMemoryViewerDataWithHistory(memoraxCodeHome);
  const byClient = new Map(data.events.map((event) => [event.client, event]));
  const codex = byClient.get("codex");
  const claude = byClient.get("claude");
  assert.equal(codex?.writebackOutcome, "pending");
  assert.equal(codex?.writebackStatus, "queued");
  assert.equal(codex?.content, "codex pending content");
  assert.equal(codex?.error, undefined);
  assert.equal(codex?.savedMemories, undefined);
  assert.equal(claude?.writebackOutcome, "saved");
  assert.equal(claude?.content, "Claude private saved memory");
  assert.equal(claude?.error, "Claude private status detail");
  assert.deepEqual(claude?.savedMemories, ["Claude private saved memory"]);
});

test("memory viewer refreshes either client history while retaining the other client", async (t) => {
  const memoraxCodeHome = await mkdtemp(join(tmpdir(), "memorax-code-viewer-client-refresh-"));
  t.after(() => rm(memoraxCodeHome, { recursive: true, force: true }));
  const event = (eventId, timestamp) => ({
    type: "memory_retrieve",
    event_id: eventId,
    timestamp,
    trace: { session_id: "refresh-session" },
    source: "direct_overlay",
    operation: "retrieve",
    ok: true,
    response: { items: [{ memory: eventId }] },
  });
  const codexPath = await writeTraceEvents(memoraxCodeHome, "codex", "refresh-session", [
    event("codex-initial", "2026-07-28T00:00:00.000Z"),
  ]);
  const claudePath = await writeTraceEvents(memoraxCodeHome, "claude", "refresh-session", [
    event("claude-initial", "2026-07-28T00:01:00.000Z"),
  ]);
  assert.deepEqual((await listMemoryViewerDataWithHistory(memoraxCodeHome)).events.map((item) => item.id), [
    "trace:codex-initial",
    "claude-trace:claude-initial",
  ]);

  await appendFile(claudePath, `\n${JSON.stringify(event("claude-appended", "2026-07-28T00:02:00.000Z"))}`, "utf8");
  assert.deepEqual((await listMemoryViewerDataWithHistory(memoraxCodeHome)).events.map((item) => item.id), [
    "trace:codex-initial",
    "claude-trace:claude-initial",
    "claude-trace:claude-appended",
  ]);

  await writeFile(codexPath, `${JSON.stringify(event("codex-replacement", "2026-07-28T00:03:00.000Z"))}\n`, "utf8");
  assert.deepEqual((await listMemoryViewerDataWithHistory(memoraxCodeHome)).events.map((item) => item.id), [
    "claude-trace:claude-initial",
    "claude-trace:claude-appended",
    "trace:codex-replacement",
  ]);
});

test("memory viewer assigns a client to live events and preserves Codex identities", () => {
  const context = (client) => ({
    schemaVersion: "1",
    client,
    mode: "unknown",
    sessionId: "live-session",
    contextOrigin: "manual",
    capturedAt: "2026-07-28T00:00:00.000Z",
  });
  recordMemoryViewerEvent({
    eventId: "same-live-event",
    source: "memory_cli",
    operation: "retrieve",
    ok: true,
    traceContext: context("codex"),
  });
  recordMemoryViewerEvent({
    eventId: "same-live-event",
    source: "memory_cli",
    operation: "retrieve",
    ok: true,
    traceContext: context("claude"),
  });
  recordMemoryViewerEvent({
    source: "workflow_startup",
    operation: "retrieve",
    ok: true,
  });

  const live = listMemoryViewerEvents();
  assert.deepEqual(live.map((event) => event.client), ["codex", "claude", "codex"]);
  assert.equal(live[0].id, "trace:same-live-event");
  assert.equal(live[1].id, "claude-trace:same-live-event");
  assert.equal(new Set(live.map((event) => event.eventKey)).size, 3);
});

async function writeTraceEvents(memoraxCodeHome, client, sessionDir, events) {
  const directory = join(memoraxCodeHome, "debug", "traces", client, "sessions", sessionDir);
  const path = join(directory, "events.jsonl");
  await mkdir(directory, { recursive: true });
  await writeFile(path, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
  return path;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
