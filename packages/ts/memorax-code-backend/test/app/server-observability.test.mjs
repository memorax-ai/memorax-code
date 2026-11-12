import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  composeMemoryObservabilityHooks,
  createBackendMemoryObservability,
} from "../../dist/app/memory-observability.js";
import { TRACE_RUNTIME_CLIENTS, claudeTracePaths, tracePaths } from "../../dist/trace/config.js";

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
    source: "memory_cli",
    operation: "query",
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

test("Codex trace observability failures do not create unhandled rejections", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-observability-trace-unhandled-"));
  const blocker = join(root, "debug");
  await writeFile(blocker, "file", "utf8");
  const observability = createBackendMemoryObservability(root, undefined, {
    MEMORAX_CODE_CODEX_TRACE_ENABLED: "true",
  });
  const diagnostics = [];
  const debugOutput = t.mock.method(console, "error", (message) => diagnostics.push(message));
  const previousDebug = process.env.MEMORAX_CODE_BACKEND_DEBUG_REQUESTS;
  process.env.MEMORAX_CODE_BACKEND_DEBUG_REQUESTS = "true";
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
    await observability.drain();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(diagnostics.length, 1);
    assert.match(diagnostics[0], /codex_trace\.write_failed label="memory_observability"/);
    assert.match(diagnostics[0], /ENOTDIR|EEXIST/);
    assert.deepEqual(unhandled.errors, []);
  } finally {
    unhandled.restore();
    debugOutput.mock.restore();
    if (previousDebug === undefined) delete process.env.MEMORAX_CODE_BACKEND_DEBUG_REQUESTS;
    else process.env.MEMORAX_CODE_BACKEND_DEBUG_REQUESTS = previousDebug;
    await rm(root, { recursive: true, force: true });
  }
});

test("session trace observability follows live file switches and isolates client roots", async (t) => {
  for (const [name, codexEnabled] of [["another client enabled", true], ["all clients disabled", false]]) {
    await t.test(name, async () => {
      const root = await mkdtemp(join(tmpdir(), "memorax-code-observability-claude-trace-"));
      try {
        const sessionId = "session-observability-claude";
        const configure = async (claudeEnabled) => writeFile(join(root, "config.toml"), TRACE_RUNTIME_CLIENTS.map((client) => (
          `[trace.${client}]\nenabled = ${client === "claude" ? claudeEnabled : client === "codex" && codexEnabled}\n`
        )).join("\n"));
        await configure(false);
        const env = {};
        const observability = createBackendMemoryObservability(root, undefined, env);
        assert.ok(observability);
        // Later caller mutations must not replace the Backend's environment snapshot.
        env.MEMORAX_CODE_CLAUDE_TRACE_ENABLED = "false";
        const claudeEventsPath = claudeTracePaths(root).eventsJsonl(sessionId);
        const recorded = [];
        for (const [enabled, phase] of [[false, "initial-disabled"], [true, "enabled"], [false, "disabled"], [true, "re-enabled"]]) {
          await configure(enabled);
          observability.recordEvent({
            source: "memory_cli",
            operation: "query",
            ok: true,
            traceContext: {
              schemaVersion: "1",
              client: "claude",
              sessionId,
              turnId: "turn-observability-claude",
              contextOrigin: "manual",
              capturedAt: "2026-07-24T00:00:00.000Z",
            },
            request: { payload: { query: phase } },
          });
          await observability.drain();
          if (enabled) recorded.push(phase);
          if (recorded.length === 0) {
            await assert.rejects(readFile(claudeEventsPath, "utf8"), { code: "ENOENT" });
          } else {
            const events = (await readFile(claudeEventsPath, "utf8")).trim().split("\n").map(JSON.parse);
            assert.deepEqual(events.map((event) => event.request.payload.query), recorded);
          }
        }
        await assert.rejects(readFile(tracePaths(root).eventsJsonl(sessionId), "utf8"), { code: "ENOENT" });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
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
