import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { loadMemoraxCodeConfig } from "../dist/config/memorax-code.js";
import { createBackendServer } from "../dist/server.js";
import { createBackendState } from "../dist/app/state.js";
import {
  claudeTracePaths,
  codexTraceConfigFromEnv,
  sanitizeTracePathSegment,
  tracePaths,
} from "../dist/trace/config.js";
import {
  traceContextFromHookBody,
} from "../dist/trace/context.js";
import {
  markCurrentCodexTurnOutcome,
  readCurrentCodexTurn,
  readOpenCodexTurn,
  recordCodexTraceEvent,
  pruneExpiredCodexTraceSessions,
  writeCurrentCodexTurn,
} from "../dist/trace/store.js";

test("codex trace config defaults to enabled and reads config.toml overrides", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-codex-trace-config-"));
  try {
    assert.deepEqual(codexTraceConfigFromEnv({ MEMORAX_CODE_HOME: root }), {
      enabled: true,
      captureContent: true,
      retentionDays: 7,
      maxEventChars: 20_000,
      maxFileBytes: 52_428_800,
    });

    await writeFile(join(root, "config.toml"), [
      "[trace.codex]",
      "enabled = false",
      "capture_content = false",
      "retention_days = 3",
      "max_event_chars = 1234",
      "max_file_bytes = 9999",
      "",
    ].join("\n"), "utf8");

    const config = loadMemoraxCodeConfig(root);
    assert.deepEqual(codexTraceConfigFromEnv({ MEMORAX_CODE_HOME: root }, config), {
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

test("trace context factory normalizes Codex Hook body fields", () => {
  const hookContext = traceContextFromHookBody({
    session_id: "session-hook",
    turn_id: "turn-hook",
    transcript_path: "/tmp/codex.jsonl",
    cwd: "/repo",
    workspace_kind: "projectless",
  }, "2026-07-09T00:01:00.000Z");

  assert.deepEqual(hookContext, {
    schemaVersion: "1",
    client: "codex",
    sessionId: "session-hook",
    turnId: "turn-hook",
    transcriptPath: "/tmp/codex.jsonl",
    cwd: "/repo",
    workspaceKind: "projectless",
    contextOrigin: "codex-hook-body",
    capturedAt: "2026-07-09T00:01:00.000Z",
  });
});

test("trace context captures an opaque Git project identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-codex-trace-project-"));
  const repo = join(root, "ProjectAlpha");
  const cwd = join(repo, "packages", "backend");
  try {
    await mkdir(join(repo, ".git"), { recursive: true });
    await mkdir(cwd, { recursive: true });
    const context = traceContextFromHookBody({
      session_id: "session-project",
      cwd,
    }, "2026-07-09T00:00:00.000Z");
    assert.equal(context.memoryProject.projectLabel, "ProjectAlpha");
    assert.match(context.memoryProject.projectId, /^repo:[a-f0-9]{32}$/);

    await recordCodexTraceEvent({
      memoraxCodeHome: root,
      traceContext: context,
      type: "memory_retrieve",
      source: "automatic_retrieval",
      operation: "retrieve",
      ok: true,
      now: () => new Date("2026-07-09T00:00:01.000Z"),
    });
    const event = JSON.parse(await readFile(tracePaths(root).eventsJsonl("session-project"), "utf8"));
    assert.deepEqual(event.trace.memory_project, {
      project_id: context.memoryProject.projectId,
      project_label: "ProjectAlpha",
    });
    assert.doesNotMatch(JSON.stringify(event.trace.memory_project), /memorax-code-codex-trace-project-/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("trace store writes sanitized session JSONL with snake_case context origin", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-codex-trace-store-"));
  try {
    const context = traceContextFromHookBody({
      session_id: "session/with/slash",
      turn_id: "turn-1",
      transcript_path: "/tmp/transcript.jsonl",
    }, "2026-07-09T00:00:00.000Z");

    await recordCodexTraceEvent({
      memoraxCodeHome: root,
      traceContext: context,
      type: "memory_retrieve",
      source: "automatic_retrieval",
      operation: "retrieve",
      ok: true,
      usage: {
        input_tokens: 120,
        cached_input_tokens: 80,
        cache_write_input_tokens: 0,
        output_tokens: 20,
        reasoning_output_tokens: 5,
        total_tokens: 140,
      },
      request: { payload: { query: "find durable preference", api_key: "do-not-write" } },
      response: { items: [{ memory: "User prefers Chinese replies." }] },
      now: () => new Date("2026-07-09T00:00:01.000Z"),
    });

    const sessions = await readdir(tracePaths(root).sessionsRoot);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0], "session_with_slash");

    const eventText = await readFile(join(tracePaths(root).sessionsRoot, sessions[0], "events.jsonl"), "utf8");
    const event = JSON.parse(eventText.trim());
    assert.match(event.event_id, /^evt_\d+_\d+$/);
    assert.equal(event.trace.session_id, "session/with/slash");
    assert.equal(event.trace.context_origin, "codex-hook-body");
    assert.equal(event.trace.contextOrigin, undefined);
    assert.equal(event.source, "automatic_retrieval");
    assert.deepEqual(event.usage, {
      input_tokens: 120,
      cached_input_tokens: 80,
      cache_write_input_tokens: 0,
      output_tokens: 20,
      reasoning_output_tokens: 5,
      total_tokens: 140,
    });
    assert.equal(event.request.payload.api_key, undefined);
    assert.equal(event.response.items[0].memory, "User prefers Chinese replies.");

    const trace = JSON.parse(await readFile(join(tracePaths(root).sessionsRoot, sessions[0], "trace.json"), "utf8"));
    assert.equal(trace.created_at, "2026-07-09T00:00:01.000Z");
    assert.equal(trace.updated_at, "2026-07-09T00:00:01.000Z");
    assert.equal(trace.session_id, "session/with/slash");
    assert.equal(trace.codex.transcript_path, "/tmp/transcript.jsonl");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("trace store appends explicit event ids once across retries and a cold cache", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-codex-trace-idempotent-event-"));
  const context = traceContextFromHookBody({
    session_id: "session-idempotent-event",
    turn_id: "turn-idempotent-event",
  });
  const eventsPath = tracePaths(root).eventsJsonl(context.sessionId);
  try {
    await mkdir(dirname(eventsPath), { recursive: true });
    await writeFile(eventsPath, `${JSON.stringify({
      schema_version: "1",
      event_id: "evt-existing-idempotent",
      type: "turn_start",
      trace: { session_id: context.sessionId, turn_id: context.turnId },
    })}\n`, "utf8");

    assert.deepEqual(await recordCodexTraceEvent({
      memoraxCodeHome: root,
      eventId: "evt-existing-idempotent",
      traceContext: context,
      type: "turn_start",
    }), { written: false, reason: "duplicate_event" });

    const concurrent = await Promise.all(Array.from({ length: 8 }, () => recordCodexTraceEvent({
      memoraxCodeHome: root,
      eventId: "evt-concurrent-idempotent",
      traceContext: context,
      type: "turn_end",
    })));
    assert.equal(concurrent.filter((result) => result.written).length, 1);
    assert.equal(
      concurrent.filter((result) => !result.written && result.reason === "duplicate_event").length,
      7,
    );

    const events = (await readFile(eventsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(events.map((event) => event.event_id), [
      "evt-existing-idempotent",
      "evt-concurrent-idempotent",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("trace store repairs incomplete JSONL tails without dropping complete records", async (t) => {
  const existingEvent = { event_id: "evt-existing", type: "turn_start" };
  const cases = [
    {
      name: "incomplete tail after a complete record",
      initial: `${JSON.stringify(existingEvent)}\n{"event_id":"broken","payload":"${"x".repeat(20_000)}`,
      expectedEventIds: ["evt-existing", "evt-after-repair"],
    },
    {
      name: "file containing only an incomplete fragment",
      initial: "{\"event_id\":\"broken\"",
      expectedEventIds: ["evt-after-repair"],
    },
    {
      name: "complete record without a trailing newline",
      initial: JSON.stringify(existingEvent),
      expectedEventIds: ["evt-existing", "evt-after-repair"],
    },
  ];

  for (const { name, initial, expectedEventIds } of cases) {
    await t.test(name, async () => {
      const root = await mkdtemp(join(tmpdir(), "memorax-code-codex-trace-tail-repair-"));
      try {
        const context = traceContextFromHookBody({ session_id: `session-${name}` });
        const eventsPath = tracePaths(root).eventsJsonl(context.sessionId);
        await mkdir(dirname(eventsPath), { recursive: true });
        await writeFile(eventsPath, initial, "utf8");

        await recordCodexTraceEvent({
          memoraxCodeHome: root,
          eventId: "evt-after-repair",
          traceContext: context,
          type: "turn_end",
          now: () => new Date("2026-07-09T00:00:01.000Z"),
        });

        const raw = await readFile(eventsPath, "utf8");
        assert.equal(raw.endsWith("\n"), true);
        const events = raw.trimEnd().split("\n").map((line) => JSON.parse(line));
        assert.deepEqual(events.map((event) => event.event_id), expectedEventIds);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("trace store serializes concurrent appends while repairing an incomplete tail", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-codex-trace-tail-race-"));
  try {
    const context = traceContextFromHookBody({ session_id: "session-tail-race" });
    const eventsPath = tracePaths(root).eventsJsonl(context.sessionId);
    await mkdir(dirname(eventsPath), { recursive: true });
    await writeFile(eventsPath, "{\"event_id\":\"broken\"", "utf8");

    const eventIds = Array.from({ length: 16 }, (_, index) => `evt-concurrent-${index}`);
    await Promise.all(eventIds.map((eventId, index) => recordCodexTraceEvent({
      memoraxCodeHome: root,
      eventId,
      traceContext: context,
      type: "memory_retrieve",
      request: { index },
      now: () => new Date("2026-07-09T00:00:01.000Z"),
    })));

    const raw = await readFile(eventsPath, "utf8");
    const events = raw.trimEnd().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(events.map((event) => event.event_id).sort(), eventIds.sort());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("trace store rejects reserved dot session path segments", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-codex-trace-dot-segment-"));
  try {
    const paths = tracePaths(root);
    for (const sessionId of [".", ".."]) {
      const sessionDir = paths.sessionDir(sessionId);
      const sessionRelative = relative(paths.sessionsRoot, sessionDir);
      assert.notEqual(sessionRelative, "");
      assert.equal(sessionRelative.startsWith(".."), false);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("trace path segments rewrite only Windows-illegal names", () => {
  const rewritten = [
    "CON",
    "con",
    "PRN",
    "AUX",
    "NUL",
    "NUL.txt",
    "COM1",
    "com9.log",
    "LPT1",
    "lpt9.backup",
    "name.",
    "name...",
    "...",
  ];
  for (const value of rewritten) {
    const segment = sanitizeTracePathSegment(value, "win32");
    assert.match(segment, /^_win_/);
    assert.doesNotMatch(segment, /[. ]$/);
    assert.doesNotMatch(segment, /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i);
    assert.equal(segment, sanitizeTracePathSegment(value, "win32"));
  }

  assert.notEqual(
    sanitizeTracePathSegment("CON", "win32").toLowerCase(),
    sanitizeTracePathSegment("con", "win32").toLowerCase(),
  );
  assert.deepEqual(
    ["CONSOLE", "NUL-device", "COM0", "COM10", "LPT0", "LPT10", "name.txt"]
      .map((value) => sanitizeTracePathSegment(value, "win32")),
    ["CONSOLE", "NUL-device", "COM0", "COM10", "LPT0", "LPT10", "name.txt"],
  );
  assert.equal(sanitizeTracePathSegment("a:b", "win32"), "a_b");
  assert.equal(sanitizeTracePathSegment("name ", "win32"), "name");
});

test("trace path segments preserve existing macOS mappings", () => {
  const cases = new Map([
    ["CON", "CON"],
    ["NUL.txt", "NUL.txt"],
    ["COM1", "COM1"],
    ["name.", "name."],
    ["name ", "name"],
    ["a:b", "a_b"],
    [".", "session"],
    ["..", "session"],
  ]);
  for (const [value, expected] of cases) {
    assert.equal(sanitizeTracePathSegment(value, "darwin"), expected);
  }
});

test("trace store records metadata only when capture_content is false and merges trace metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-codex-trace-metadata-"));
  try {
    const context = traceContextFromHookBody({
      session_id: "session-metadata",
      transcript_path: "/tmp/original.jsonl",
    }, "2026-07-09T00:00:00.000Z");
    const sessionDir = tracePaths(root).sessionDir(context.sessionId);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, "trace.json"), JSON.stringify({
      schema_version: "1",
      client: "codex",
      session_id: "session-metadata",
      created_at: "2026-07-08T00:00:00.000Z",
      updated_at: "2026-07-08T00:00:00.000Z",
      capture: { capture_content: true },
      codex: { transcript_path: "/tmp/original.jsonl" },
    }, null, 2), "utf8");

    await recordCodexTraceEvent({
      memoraxCodeHome: root,
      config: {
        enabled: true,
        captureContent: false,
        retentionDays: 7,
        maxEventChars: 20_000,
        maxFileBytes: 52_428_800,
      },
      traceContext: context,
      type: "memory_writeback",
      source: "codex_hook_writeback",
      operation: "writeback",
      ok: true,
      relatedTurns: [
        {
          turnId: "turn-related-1",
          requestId: "request-related-1",
          nativeRequestId: "native-related-1",
          contextOrigin: "codex-hook-body",
          capturedAt: "2026-07-09T00:00:00.000Z",
        },
        {
          turnId: "turn-related-2",
          contextOrigin: "codex-hook-body",
          capturedAt: "2026-07-09T00:01:00.000Z",
        },
      ],
      request: { context: { messages: [{ role: "user", content: "raw private user message" }] } },
      response: { raw: { data: { task_id: "task-1", status: "queued" } } },
      now: () => new Date("2026-07-09T00:02:00.000Z"),
    });

    const eventText = await readFile(join(sessionDir, "events.jsonl"), "utf8");
    assert.doesNotMatch(eventText, /raw private user message/);
    assert.match(eventText, /sha256:/);
    assert.deepEqual(JSON.parse(eventText).related_turns, [
      {
        turn_id: "turn-related-1",
        request_id: "request-related-1",
        native_request_id: "native-related-1",
        context_origin: "codex-hook-body",
        captured_at: "2026-07-09T00:00:00.000Z",
      },
      {
        turn_id: "turn-related-2",
        context_origin: "codex-hook-body",
        captured_at: "2026-07-09T00:01:00.000Z",
      },
    ]);

    const trace = JSON.parse(await readFile(join(sessionDir, "trace.json"), "utf8"));
    assert.equal(trace.created_at, "2026-07-08T00:00:00.000Z");
    assert.equal(trace.updated_at, "2026-07-09T00:02:00.000Z");
    assert.equal(trace.codex.transcript_path, "/tmp/original.jsonl");
    assert.equal(trace.capture.capture_content, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("trace store writes one warning when session events exceed max_file_bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-codex-trace-max-file-"));
  try {
    const context = traceContextFromHookBody({ session_id: "session-max-file" });
    const sessionDir = tracePaths(root).sessionDir(context.sessionId);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, "events.jsonl"), "already-too-large\n", "utf8");

    const config = {
      enabled: true,
      captureContent: true,
      retentionDays: 7,
      maxEventChars: 20_000,
      maxFileBytes: 1,
    };
    const first = await recordCodexTraceEvent({
      memoraxCodeHome: root,
      config,
      traceContext: context,
      type: "memory_retrieve",
      source: "automatic_retrieval",
      operation: "retrieve",
      ok: true,
      request: { query: "should not be written" },
      now: () => new Date("2026-07-09T00:03:00.000Z"),
    });
    assert.deepEqual(first, { written: false, reason: "max_file_bytes" });

    const second = await recordCodexTraceEvent({
      memoraxCodeHome: root,
      config,
      traceContext: context,
      type: "memory_retrieve",
      source: "automatic_retrieval",
      operation: "retrieve",
      ok: true,
      request: { query: "should not be written twice" },
      now: () => new Date("2026-07-09T00:04:00.000Z"),
    });
    assert.deepEqual(second, { written: false, reason: "max_file_bytes" });

    const lines = (await readFile(join(sessionDir, "events.jsonl"), "utf8")).trim().split(/\r?\n/);
    const warnings = lines.map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return undefined;
      }
    }).filter((event) => event?.type === "trace_warning");
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].operation, "max_file_bytes");
    assert.equal(warnings[0].ok, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("trace store writes only one max_file_bytes warning under concurrent writers", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-codex-trace-max-file-race-"));
  try {
    const context = traceContextFromHookBody({ session_id: "session-max-file-race" });
    const sessionDir = tracePaths(root).sessionDir(context.sessionId);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, "events.jsonl"), "already-too-large\n", "utf8");
    const config = {
      enabled: true,
      captureContent: true,
      retentionDays: 7,
      maxEventChars: 20_000,
      maxFileBytes: 1,
    };

    await Promise.all(Array.from({ length: 8 }, (_, index) => recordCodexTraceEvent({
      memoraxCodeHome: root,
      config,
      traceContext: context,
      type: "memory_retrieve",
      source: "automatic_retrieval",
      operation: "retrieve",
      ok: true,
      request: { query: `too large ${index}` },
      now: () => new Date("2026-07-09T00:05:00.000Z"),
    })));

    const lines = (await readFile(join(sessionDir, "events.jsonl"), "utf8")).trim().split(/\r?\n/);
    const warnings = lines.map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return undefined;
      }
    }).filter((event) => event?.type === "trace_warning");
    assert.equal(warnings.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("current turn bridge respects enabled and stale contracts", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-codex-current-turn-"));
  try {
    const context = traceContextFromHookBody({
      session_id: "session-current",
      turn_id: "turn-current",
    }, "2026-07-09T00:00:00.000Z");

    assert.deepEqual(await writeCurrentCodexTurn(context, {
      memoraxCodeHome: root,
      config: {
        enabled: false,
        captureContent: true,
        retentionDays: 7,
        maxEventChars: 20_000,
        maxFileBytes: 52_428_800,
      },
    }), { written: false, reason: "disabled" });

    await assert.rejects(readFile(tracePaths(root).currentTurnPath, "utf8"));

    assert.deepEqual(await writeCurrentCodexTurn(context, {
      memoraxCodeHome: root,
      now: () => new Date("2026-07-09T00:00:00.000Z"),
    }), { written: true });

    const fresh = await readCurrentCodexTurn({
      memoraxCodeHome: root,
      now: () => new Date("2026-07-09T00:29:00.000Z"),
    });
    assert.equal(fresh.ok, true);
    assert.equal(fresh.traceContext.sessionId, "session-current");
    assert.equal(fresh.traceContext.contextOrigin, "current-turn-file");

    const stale = await readCurrentCodexTurn({
      memoraxCodeHome: root,
      now: () => new Date("2026-07-09T00:31:00.000Z"),
    });
    assert.deepEqual(stale, { ok: false, reason: "stale" });

    const staleForTraceReconciliation = await readCurrentCodexTurn({
      memoraxCodeHome: root,
      allowStale: true,
      now: () => new Date("2026-07-10T00:00:00.000Z"),
    });
    assert.equal(staleForTraceReconciliation.ok, true);
    assert.equal(staleForTraceReconciliation.traceContext.turnId, "turn-current");

    await writeFile(tracePaths(root).currentTurnPath, JSON.stringify({
      schema_version: "1",
      trace: {
        client: "codex",
        session_id: "session-invalid-current",
      },
    }), "utf8");
    assert.deepEqual(await readCurrentCodexTurn({ memoraxCodeHome: root }), { ok: false, reason: "invalid" });

    await writeFile(tracePaths(root).currentTurnPath, JSON.stringify({
      schema_version: "1",
      trace: {
        client: "unsupported-client",
        session_id: "session-invalid-client",
        captured_at: "2026-07-09T00:00:00.000Z",
      },
    }), "utf8");
    assert.deepEqual(await readCurrentCodexTurn({ memoraxCodeHome: root }), { ok: false, reason: "invalid" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("current turn bridge reads session-scoped turns before global current turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-codex-current-turn-session-scoped-"));
  try {
    await writeCurrentCodexTurn(traceContextFromHookBody({
      session_id: "session-a",
      turn_id: "turn-a",
    }), {
      memoraxCodeHome: root,
      now: () => new Date("2026-07-09T00:00:00.000Z"),
    });
    await writeCurrentCodexTurn(traceContextFromHookBody({
      session_id: "session-b",
      turn_id: "turn-b",
    }), {
      memoraxCodeHome: root,
      now: () => new Date("2026-07-09T00:01:00.000Z"),
    });

    const sessionA = await readCurrentCodexTurn({
      memoraxCodeHome: root,
      expectedSessionId: "session-a",
      now: () => new Date("2026-07-09T00:02:00.000Z"),
    });

    assert.equal(sessionA.ok, true);
    assert.equal(sessionA.traceContext.sessionId, "session-a");
    assert.equal(sessionA.traceContext.turnId, "turn-a");

    const missing = await readCurrentCodexTurn({
      memoraxCodeHome: root,
      expectedSessionId: "session-missing",
      now: () => new Date("2026-07-09T00:02:00.000Z"),
    });

    assert.deepEqual(missing, { ok: false, reason: "session_mismatch" });

    await writeFile(tracePaths(root).sessionCurrentTurnPath("session-a"), JSON.stringify({
      schema_version: "1",
      turn_state: "open",
      trace: {
        client: "codex",
        session_id: "session-b",
        turn_id: "turn-wrong",
        context_origin: "codex-hook-body",
        captured_at: "2026-07-09T00:02:00.000Z",
      },
    }), "utf8");

    const mismatched = await readCurrentCodexTurn({
      memoraxCodeHome: root,
      expectedSessionId: "session-a",
      now: () => new Date("2026-07-09T00:03:00.000Z"),
    });

    assert.deepEqual(mismatched, { ok: false, reason: "session_mismatch" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("current turn bridge preserves recent context after closing rollout reconciliation", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-codex-current-turn-state-"));
  try {
    const context = traceContextFromHookBody({
      session_id: "session-state",
      turn_id: "turn-state",
    }, "2026-07-09T00:00:00.000Z");
    await writeCurrentCodexTurn(context, {
      memoraxCodeHome: root,
      now: () => new Date("2026-07-09T00:00:00.000Z"),
    });

    const paths = tracePaths(root);
    const openGlobal = JSON.parse(await readFile(paths.currentTurnPath, "utf8"));
    const openScoped = JSON.parse(await readFile(paths.sessionCurrentTurnPath("session-state"), "utf8"));
    assert.equal(openGlobal.turn_state, "open");
    assert.equal(openScoped.turn_state, "open");
    assert.equal((await readOpenCodexTurn({
      memoraxCodeHome: root,
      expectedSessionId: "session-state",
      now: () => new Date("2026-07-09T00:01:00.000Z"),
    })).ok, true);

    assert.deepEqual(await markCurrentCodexTurnOutcome(context, "completed", {
      memoraxCodeHome: root,
    }), { updated: true });

    const recent = await readCurrentCodexTurn({
      memoraxCodeHome: root,
      expectedSessionId: "session-state",
      now: () => new Date("2026-07-09T00:06:00.000Z"),
    });
    assert.equal(recent.ok, true);
    assert.equal(recent.traceContext.turnId, "turn-state");
    assert.deepEqual(await readOpenCodexTurn({
      memoraxCodeHome: root,
      expectedSessionId: "session-state",
      now: () => new Date("2026-07-09T00:06:00.000Z"),
    }), { ok: false, reason: "closed", outcome: "completed" });

    const closedGlobal = JSON.parse(await readFile(paths.currentTurnPath, "utf8"));
    const closedScoped = JSON.parse(await readFile(paths.sessionCurrentTurnPath("session-state"), "utf8"));
    assert.equal(closedGlobal.turn_state, "completed");
    assert.equal(closedScoped.turn_state, "completed");

    const otherTurn = traceContextFromHookBody({
      session_id: "session-state",
      turn_id: "turn-other",
    });
    assert.deepEqual(await markCurrentCodexTurnOutcome(otherTurn, "completed", {
      memoraxCodeHome: root,
    }), { updated: false, reason: "not_current_turn" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Backend startup prunes expired Codex and Claude trace sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-codex-trace-retention-"));
  let server;
  try {
    await writeFile(join(root, "config.toml"), [
      "[trace.codex]",
      "retention_days = 1",
      "",
      "[trace.claude]",
      "retention_days = 1",
      "",
    ].join("\n"), "utf8");
    const oldCodexDir = tracePaths(root).sessionDir("old-session");
    const freshCodexDir = tracePaths(root).sessionDir("fresh-session");
    const oldClaudeDir = claudeTracePaths(root).sessionDir("old-session");
    const freshClaudeDir = claudeTracePaths(root).sessionDir("fresh-session");
    for (const directory of [oldCodexDir, freshCodexDir, oldClaudeDir, freshClaudeDir]) {
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "events.jsonl"), "{}\n", "utf8");
    }
    const oldTime = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    for (const directory of [oldCodexDir, oldClaudeDir]) {
      await utimes(directory, oldTime, oldTime);
      await utimes(join(directory, "events.jsonl"), oldTime, oldTime);
    }

    server = createBackendServer(createBackendState("127.0.0.1", {
      sessionHome: root,
    }));
    await listen(server);

    await Promise.all([
      waitForMissing(oldCodexDir),
      waitForMissing(oldClaudeDir),
    ]);
    await stat(freshCodexDir);
    await stat(freshClaudeDir);
  } finally {
    if (server) await closeServer(server);
    await rm(root, { recursive: true, force: true });
  }
});

test("retention keeps sessions with fresh trace files even when directory mtime is old", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-codex-trace-retention-active-"));
  try {
    await writeFile(join(root, "config.toml"), [
      "[trace.codex]",
      "retention_days = 1",
      "",
    ].join("\n"), "utf8");
    const sessionDir = tracePaths(root).sessionDir("active-session");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, "trace.json"), JSON.stringify({
      schema_version: "1",
      client: "codex",
      session_id: "active-session",
      created_at: "2026-07-07T00:00:00.000Z",
      updated_at: new Date().toISOString(),
    }), "utf8");
    await writeFile(join(sessionDir, "events.jsonl"), "{}\n", "utf8");
    const oldTime = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    await utimes(sessionDir, oldTime, oldTime);

    await pruneExpiredCodexTraceSessions({ memoraxCodeHome: root });

    await stat(sessionDir);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("append path honors cross-process retention debounce marker", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-codex-trace-retention-debounce-"));
  try {
    const oldDir = tracePaths(root).sessionDir("old-session");
    await mkdir(oldDir, { recursive: true });
    await writeFile(join(oldDir, "events.jsonl"), "{}\n", "utf8");
    const oldTime = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    await utimes(oldDir, oldTime, oldTime);
    await mkdir(tracePaths(root).root, { recursive: true });
    await writeFile(join(tracePaths(root).root, ".retention-cleanup.json"), JSON.stringify({
      cleaned_at: new Date().toISOString(),
    }), "utf8");

    await recordCodexTraceEvent({
      memoraxCodeHome: root,
      config: {
        enabled: true,
        captureContent: true,
        retentionDays: 1,
        maxEventChars: 20_000,
        maxFileBytes: 52_428_800,
      },
      traceContext: traceContextFromHookBody({ session_id: "new-session" }),
      type: "memory_retrieve",
      source: "automatic_retrieval",
      operation: "retrieve",
      ok: true,
      request: { query: "do not scan every CLI append" },
    });

    await stat(oldDir);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function waitForMissing(path) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await stat(path);
    } catch {
      return;
    }
    await delay(20);
  }
  assert.fail(`Expected path to be pruned: ${path}`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
