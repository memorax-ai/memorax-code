import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  composeMemoryObservabilityHooks,
  createBackendMemoryObservability,
} from "../../dist/app/memory-observability.js";
import { claudeTracePaths, tracePaths } from "../../dist/trace/config.js";

test("createBackendMemoryObservability preserves an existing memory hook", () => {
  const existingHook = { recordEvent() {} };
  const observability = createBackendMemoryObservability(
    "/tmp/memorax-code-observability-test",
    existingHook,
    {},
  );

  assert.equal(observability, existingHook);
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

test("session trace observability routes Claude events to the trace root", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-observability-claude-trace-"));
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
    const claudeEventsPath = claudeTracePaths(root).eventsJsonl(sessionId);
    await waitFor(async () => {
      try {
        return (await readFile(claudeEventsPath, "utf8")).includes("claude trace query");
      } catch {
        return false;
      }
    });
    await assert.rejects(readFile(tracePaths(root).eventsJsonl(sessionId), "utf8"));
  } finally {
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
