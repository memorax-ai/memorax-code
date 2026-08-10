import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  composeMemoryObservabilityHooks,
  createBackendMemoryObservability,
} from "../dist/app/memory-observability.js";
import { claudeTracePaths, tracePaths } from "../dist/trace/config.js";
import {
  clearMemoryViewerEvents,
  listMemoryViewerEvents,
  listMemoryViewerEventsWithHistory,
} from "../dist/viewer/store.js";

test("createBackendMemoryObservability preserves an existing memory hook", () => {
  const existingHook = { recordEvent() {} };
  const observability = createBackendMemoryObservability(
    "/tmp/memorax-code-observability-test",
    existingHook,
    {},
  );

  assert.equal(observability, existingHook);
});

test("createBackendMemoryObservability always installs the viewer hook", () => {
  const disabled = createBackendMemoryObservability("/tmp/memorax-code-observability-test", undefined, {
    MEMORAX_CODE_CLAUDE_TRACE_ENABLED: "false",
    MEMORAX_CODE_CODEX_TRACE_ENABLED: "false",
  });
  assert.equal(typeof disabled?.recordEvent, "function");

  const trace = createBackendMemoryObservability("/tmp/memorax-code-observability-test");
  assert.equal(typeof trace?.recordEvent, "function");

  const enabled = createBackendMemoryObservability("/tmp/memorax-code-observability-test", undefined, {
    MEMORAX_CODE_CLAUDE_TRACE_ENABLED: "false",
    MEMORAX_CODE_CODEX_TRACE_ENABLED: "false",
  });
  assert.equal(typeof enabled?.recordEvent, "function");
});

test("default memory observability includes operational projection hooks", () => {
  clearMemoryViewerEvents();
  const delivered = [];
  const observability = createBackendMemoryObservability(
    "/tmp/memorax-code-observability-test",
    undefined,
    {
      MEMORAX_CODE_CLAUDE_TRACE_ENABLED: "false",
      MEMORAX_CODE_CODEX_TRACE_ENABLED: "false",
    },
    [{
      recordEvent(event) {
        delivered.push(event);
      },
    }],
  );

  observability.recordEvent({
    source: "codex_hook_writeback",
    operation: "writeback",
    ok: true,
  });

  const [viewerEvent] = listMemoryViewerEvents();
  assert.equal(delivered.length, 1);
  assert.equal(viewerEvent.id, `trace:${delivered[0].eventId}`);
});

test("memory observability isolates synchronous sink failures", () => {
  const delivered = [];
  const observability = composeMemoryObservabilityHooks([
    {
      recordEvent() {
        throw new Error("injected sink failure");
      },
    },
    {
      recordEvent(event) {
        delivered.push(event);
      },
    },
  ]);

  const event = {
    source: "automatic_retrieval",
    operation: "retrieve",
    ok: true,
  };
  observability.recordEvent(event);
  assert.deepEqual(delivered, [{ ...event, eventId: delivered[0].eventId }]);
  assert.match(delivered[0].eventId, /^memory-observability-/);
});

test("memory observability drain waits for every sink and isolates drain failures", async () => {
  let releaseFirstDrain;
  let lastSinkDrained = false;
  const observability = composeMemoryObservabilityHooks([
    {
      recordEvent() {},
      drain() {
        return new Promise((resolve) => {
          releaseFirstDrain = resolve;
        });
      },
    },
    {
      recordEvent() {},
      async drain() {
        throw new Error("injected drain failure");
      },
    },
    {
      recordEvent() {},
      async drain() {
        lastSinkDrained = true;
      },
    },
  ]);

  const draining = observability.drain();
  await Promise.resolve();
  assert.equal(lastSinkDrained, true);
  let settled = false;
  void draining.then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false);

  releaseFirstDrain();
  await draining;
  assert.equal(settled, true);
});

test("Codex trace observability failures do not create unhandled rejections", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-observability-trace-unhandled-"));
  const blocker = join(root, "debug");
  await writeFile(blocker, "file", "utf8");
  const observability = createBackendMemoryObservability(root);
  const unhandled = captureUnhandledRejections();
  try {
    observability.recordEvent({
      source: "automatic_writeback",
      operation: "writeback",
      ok: true,
      traceContext: {
        schemaVersion: "1",
        client: "codex",
        sessionId: "session-observability-failure",
        turnId: "turn-observability-failure",
        contextOrigin: "codex-hook-body",
        capturedAt: "2026-07-09T00:00:00.000Z",
      },
    });
    await delay(50);
    assert.deepEqual(unhandled.errors, []);
  } finally {
    unhandled.restore();
    await rm(root, { recursive: true, force: true });
  }
});

test("session trace observability routes Claude events to the trace root and local projection", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-observability-claude-trace-"));
  clearMemoryViewerEvents();
  try {
    const sessionId = "session-observability-claude";
    const observability = createBackendMemoryObservability(root, undefined, {
      MEMORAX_CODE_CLAUDE_TRACE_ENABLED: "true",
      MEMORAX_CODE_CODEX_TRACE_ENABLED: "false",
    });
    observability.recordEvent({
      source: "claude_hook_retrieval",
      operation: "retrieve",
      ok: true,
      traceContext: {
        schemaVersion: "1",
        client: "claude",
        sessionId,
        turnId: "turn-observability-claude",
        contextOrigin: "manual",
        capturedAt: "2026-07-24T00:00:00.000Z",
      },
      request: { payload: { query: "claude trace query" } },
    });
    observability.recordEvent({
      source: "claude_hook_writeback",
      operation: "writeback",
      ok: true,
      response: { raw: { data: { task_id: "claude-task", status: "queued" } } },
    });

    const claudeEventsPath = claudeTracePaths(root).eventsJsonl(sessionId);
    await waitFor(async () => {
      try {
        return (await readFile(claudeEventsPath, "utf8")).includes("claude trace query");
      } catch {
        return false;
      }
    });
    await assert.rejects(readFile(tracePaths(root).eventsJsonl(sessionId), "utf8"));
    const viewerEvents = listMemoryViewerEvents();
    assert.deepEqual(viewerEvents.map(({ client, source }) => ({ client, source })), [
      { client: "claude", source: "claude_hook_retrieval" },
      { client: "claude", source: "claude_hook_writeback" },
    ]);
    assert.equal(viewerEvents.every((event) => event.id.startsWith("claude-trace:")), true);
  } finally {
    clearMemoryViewerEvents();
    await rm(root, { recursive: true, force: true });
  }
});

test("memory observability correlates live projection and persisted trace events", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-observability-correlation-"));
  clearMemoryViewerEvents();
  try {
    const observability = createBackendMemoryObservability(root);
    observability.recordEvent({
      source: "automatic_retrieval",
      operation: "retrieve",
      ok: true,
      traceContext: {
        schemaVersion: "1",
        client: "codex",
        sessionId: "session-observability-correlation",
        turnId: "turn-observability-correlation",
        contextOrigin: "codex-hook-body",
        capturedAt: "2026-07-14T00:00:00.000Z",
      },
      request: { payload: { query: "shared query" } },
      response: { items: [{ memory: "shared result" }] },
    });
    const [live] = listMemoryViewerEvents();
    assert.match(live.id, /^trace:memory-observability-/);
    const eventsPath = join(
      root,
      "debug",
      "traces",
      "codex",
      "sessions",
      "session-observability-correlation",
      "events.jsonl",
    );
    await waitFor(async () => {
      try {
        return (await readFile(eventsPath, "utf8")).includes(live.id.slice("trace:".length));
      } catch {
        return false;
      }
    });
    const merged = await listMemoryViewerEventsWithHistory(root);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].id, live.id);
    assert.equal(merged[0].content, "shared result");
  } finally {
    clearMemoryViewerEvents();
    await rm(root, { recursive: true, force: true });
  }
});

function captureUnhandledRejections() {
  const errors = [];
  const handler = (error) => {
    errors.push(error);
  };
  process.on("unhandledRejection", handler);
  return {
    errors,
    restore() {
      process.off("unhandledRejection", handler);
    },
  };
}

async function delay(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(10);
  }
  assert.fail(`condition was not met within ${timeoutMs}ms`);
}
