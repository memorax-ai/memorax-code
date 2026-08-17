import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadMemoraxCodeConfig, renderDefaultMemoraxCodeConfig } from "../../dist/config/memorax-code.js";
import {
  TRACE_CLIENTS,
  clientTraceConfigFromEnv,
  dshTraceConfigFromEnv,
  dshTracePaths,
} from "../../dist/trace/config.js";
import {
  isTraceClient,
  traceContextFromCurrentTurnRecord,
  traceContextFromDshSessionEventLog,
  traceContextFromDshTurnStart,
} from "../../dist/trace/context.js";

test("DSH trace config has its own defaults, file section, env prefix, and path", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-dsh-trace-config-"));
  try {
    assert.deepEqual(TRACE_CLIENTS, ["codex", "claude", "dsh", "opencode"]);
    assert.match(renderDefaultMemoraxCodeConfig(), /\[trace\.dsh\]\nenabled = true/);
    assert.deepEqual(dshTraceConfigFromEnv({
      MEMORAX_CODE_HOME: root,
      MEMORAX_CODE_CODEX_TRACE_ENABLED: "false",
      MEMORAX_CODE_CLAUDE_TRACE_CAPTURE_CONTENT: "false",
    }), {
      enabled: true,
      captureContent: true,
      retentionDays: 7,
      maxEventChars: 20_000,
      maxFileBytes: 52_428_800,
    });

    await writeFile(join(root, "config.toml"), [
      "[trace.codex]",
      "enabled = true",
      "retention_days = 9",
      "",
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
    assert.deepEqual(dshTraceConfigFromEnv({
      MEMORAX_CODE_HOME: root,
      MEMORAX_CODE_DSH_TRACE_CAPTURE_CONTENT: "true",
      MEMORAX_CODE_DSH_TRACE_ENABLED: "true",
      MEMORAX_CODE_DSH_TRACE_MAX_EVENT_CHARS: "4321",
      MEMORAX_CODE_DSH_TRACE_MAX_FILE_BYTES: "8888",
      MEMORAX_CODE_DSH_TRACE_RETENTION_DAYS: "5",
    }, config), {
      enabled: true,
      captureContent: true,
      retentionDays: 5,
      maxEventChars: 4321,
      maxFileBytes: 8888,
    });
    assert.equal(dshTracePaths(root).root, join(root, "debug", "traces", "dsh"));
    assert.equal(dshTracePaths(root).eventsJsonl("shared/session"), join(
      root,
      "debug",
      "traces",
      "dsh",
      "sessions",
      "shared_session",
      "events.jsonl",
    ));
    assert.equal(clientTraceConfigFromEnv("dsh", { MEMORAX_CODE_HOME: root }, config).retentionDays, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("DSH trace contexts distinguish Cordis turn start from authoritative Event Log materialization", () => {
  const body = {
    sessionId: " session-dsh ",
    turn: 7,
    cwd: "/repo",
  };
  assert.deepEqual(traceContextFromDshTurnStart(body, "2026-08-16T00:00:00.000Z"), {
    schemaVersion: "1",
    client: "dsh",
    sessionId: "session-dsh",
    turnId: "7",
    cwd: "/repo",
    contextOrigin: "dsh-cordis-turn-start",
    capturedAt: "2026-08-16T00:00:00.000Z",
  });
  assert.deepEqual(traceContextFromDshSessionEventLog(body, "2026-08-16T00:00:01.000Z"), {
    schemaVersion: "1",
    client: "dsh",
    sessionId: "session-dsh",
    turnId: "7",
    cwd: "/repo",
    contextOrigin: "dsh-session-event-log",
    capturedAt: "2026-08-16T00:00:01.000Z",
  });
  assert.equal(isTraceClient("dsh"), true);
});

test("DSH current-turn records preserve client identity without trusting the stored origin", () => {
  assert.deepEqual(traceContextFromCurrentTurnRecord({
    schema_version: "1",
    trace: {
      client: "dsh",
      session_id: "session-dsh",
      turn_id: "7",
      context_origin: "dsh-cordis-turn-start",
      captured_at: "2026-08-16T00:00:00.000Z",
    },
  }), {
    schemaVersion: "1",
    client: "dsh",
    sessionId: "session-dsh",
    turnId: "7",
    contextOrigin: "current-turn-file",
    capturedAt: "2026-08-16T00:00:00.000Z",
  });
});

test("DSH trace context rejects missing or non-positive integer native turn identity", () => {
  for (const turn of [undefined, "1", 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const body = { sessionId: "session-dsh", turn, cwd: "/repo" };
    assert.equal(traceContextFromDshTurnStart(body), undefined);
    assert.equal(traceContextFromDshSessionEventLog(body), undefined);
  }
  assert.equal(traceContextFromDshTurnStart({ turn: 1, cwd: "/repo" }), undefined);
});

test("DSH trace context requires workspace identity at both authority boundaries", () => {
  for (const body of [
    { sessionId: "session-dsh", turn: 1 },
    { sessionId: "session-dsh", turn: 1, cwd: "   " },
  ]) {
    assert.equal(traceContextFromDshTurnStart(body), undefined);
    assert.equal(traceContextFromDshSessionEventLog(body), undefined);
  }
});
