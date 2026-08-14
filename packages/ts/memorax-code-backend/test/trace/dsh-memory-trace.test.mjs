import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadMemoraxCodeConfig } from "../../dist/config/memorax-code.js";
import {
  dshTraceConfigFromEnv,
  dshTracePaths,
} from "../../dist/trace/config.js";
import { traceContextFromDshHookBody } from "../../dist/trace/context.js";
import {
  markCurrentDshTurnOutcome,
  readOpenDshTurn,
  recordDshTraceEvent,
  writeCurrentDshTurn,
} from "../../dist/trace/store.js";

test("dsh trace config defaults to enabled and reads config.toml overrides", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-dsh-trace-config-"));
  try {
    assert.deepEqual(dshTraceConfigFromEnv({ MEMORAX_CODE_HOME: root }), {
      enabled: true,
      captureContent: true,
      retentionDays: 7,
      maxEventChars: 20_000,
      maxFileBytes: 52_428_800,
    });

    await writeFile(join(root, "config.toml"), [
      "[trace.dsh]",
      "enabled = false",
      "capture_content = false",
      "retention_days = 3",
      "max_event_chars = 1234",
      "max_file_bytes = 9999",
      "",
    ].join("\n"), "utf8");

    const config = loadMemoraxCodeConfig(root);
    assert.deepEqual(dshTraceConfigFromEnv({ MEMORAX_CODE_HOME: root }, config), {
      enabled: false,
      captureContent: false,
      retentionDays: 3,
      maxEventChars: 1234,
      maxFileBytes: 9999,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("trace context factory normalizes DSH Hook body fields", () => {
  const context = traceContextFromDshHookBody({
    session_id: "session-dsh",
    turn_id: "dsh-0-1",
    transcript_path: "/tmp/dsh.jsonl",
    cwd: "/repo",
    workspace_kind: "projectless",
  }, "2026-07-09T00:01:00.000Z");

  assert.deepEqual(context, {
    schemaVersion: "1",
    client: "dsh",
    sessionId: "session-dsh",
    turnId: "dsh-0-1",
    transcriptPath: "/tmp/dsh.jsonl",
    cwd: "/repo",
    workspaceKind: "projectless",
    contextOrigin: "dsh-hook-body",
    capturedAt: "2026-07-09T00:01:00.000Z",
  });
});

test("DSH trace store writes turn events and closes the current turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-dsh-trace-store-"));
  try {
    const context = traceContextFromDshHookBody({
      session_id: "session-dsh-trace",
      turn_id: "dsh-0-2",
      cwd: "/repo",
    }, "2026-07-09T00:00:00.000Z");

    assert.deepEqual(await writeCurrentDshTurn(context, { memoraxCodeHome: root }), { written: true });

    const open = await readOpenDshTurn({
      memoraxCodeHome: root,
      expectedSessionId: "session-dsh-trace",
    });
    assert.equal(open.ok, true);
    assert.equal(open.traceContext.client, "dsh");

    await recordDshTraceEvent({
      memoraxCodeHome: root,
      traceContext: context,
      type: "turn_start",
      source: "unknown",
      operation: "query",
      ok: true,
      now: () => new Date("2026-07-09T00:00:01.000Z"),
    });

    const eventsPath = dshTracePaths(root).eventsJsonl("session-dsh-trace");
    const event = JSON.parse((await readFile(eventsPath, "utf8")).trim());
    assert.equal(event.trace.client, "dsh");
    assert.equal(event.trace.context_origin, "dsh-hook-body");

    await markCurrentDshTurnOutcome(context, "completed", { memoraxCodeHome: root });
    const closed = await readOpenDshTurn({
      memoraxCodeHome: root,
      expectedSessionId: "session-dsh-trace",
    });
    assert.equal(closed.ok, false);
    assert.equal(closed.reason, "closed");
    assert.equal(closed.outcome, "completed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("DSH trace paths resolve under the client-specific trace root", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-dsh-trace-paths-"));
  try {
    await mkdir(root, { recursive: true });
    const paths = dshTracePaths(root);
    assert.match(paths.root, /traces\/dsh$/);
    assert.match(paths.sessionDir("session-x"), /traces\/dsh\/sessions\/session-x$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
