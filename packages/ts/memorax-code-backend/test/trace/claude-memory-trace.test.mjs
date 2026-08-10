import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadMemoraxCodeConfig, renderDefaultMemoraxCodeConfig } from "../../dist/config/memorax-code.js";
import {
  claudeTraceConfigFromEnv,
  claudeTracePaths,
  clientTraceConfigFromEnv,
  clientTracePaths,
  codexTraceConfigFromEnv,
  tracePaths,
} from "../../dist/trace/config.js";
import { traceContextFromClaudeHookBody } from "../../dist/trace/context.js";
import {
  markCurrentClaudeTurnOutcome,
  markCurrentCodexTurnOutcome,
  pruneExpiredClaudeTraceSessions,
  readCurrentClaudeTurn,
  readCurrentCodexTurn,
  readOpenClaudeTurn,
  recordClaudeTraceEvent,
  recordCodexTraceEvent,
  recordTraceEvent,
  writeCurrentClaudeTurn,
  writeCurrentCodexTurn,
} from "../../dist/trace/store.js";

test("claude trace config defaults to enabled and reads isolated overrides", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-claude-trace-config-"));
  try {
    assert.match(renderDefaultMemoraxCodeConfig(), /\[trace\.claude\]\nenabled = true/);
    assert.deepEqual(claudeTraceConfigFromEnv({ MEMORAX_CODE_HOME: root }), {
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
      "[trace.claude]",
      "enabled = false",
      "capture_content = false",
      "retention_days = 3",
      "max_event_chars = 1234",
      "max_file_bytes = 9999",
      "",
    ].join("\n"), "utf8");

    const config = loadMemoraxCodeConfig(root);
    assert.deepEqual(claudeTraceConfigFromEnv({ MEMORAX_CODE_HOME: root }, config), {
      enabled: false,
      captureContent: false,
      retentionDays: 3,
      maxEventChars: 1234,
      maxFileBytes: 9999,
    });
    assert.deepEqual(claudeTraceConfigFromEnv({
      MEMORAX_CODE_HOME: root,
      MEMORAX_CODE_CLAUDE_TRACE_CAPTURE_CONTENT: "true",
      MEMORAX_CODE_CLAUDE_TRACE_ENABLED: "true",
      MEMORAX_CODE_CLAUDE_TRACE_MAX_EVENT_CHARS: "4321",
      MEMORAX_CODE_CLAUDE_TRACE_MAX_FILE_BYTES: "8888",
      MEMORAX_CODE_CLAUDE_TRACE_RETENTION_DAYS: "5",
    }, config), {
      enabled: true,
      captureContent: true,
      retentionDays: 5,
      maxEventChars: 4321,
      maxFileBytes: 8888,
    });
    assert.deepEqual(codexTraceConfigFromEnv({ MEMORAX_CODE_HOME: root }, config), {
      enabled: true,
      captureContent: true,
      retentionDays: 9,
      maxEventChars: 20_000,
      maxFileBytes: 52_428_800,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude Hook trace context maps prompt identity without provider assumptions", () => {
  assert.deepEqual(traceContextFromClaudeHookBody({
    session_id: "claude-hook-session",
    prompt_id: "claude-hook-prompt",
    transcript_path: "/tmp/claude-transcript.jsonl",
    workspace_kind: "project",
  }, "2026-07-24T00:00:00.000Z"), {
    schemaVersion: "1",
    client: "claude",
    sessionId: "claude-hook-session",
    turnId: "claude-hook-prompt",
    transcriptPath: "/tmp/claude-transcript.jsonl",
    workspaceKind: "project",
    contextOrigin: "claude-hook-body",
    capturedAt: "2026-07-24T00:00:00.000Z",
  });
});

test("trace store isolates Codex and Claude sessions with the same id", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-client-trace-isolation-"));
  const sessionId = "shared-session";
  try {
    const claude = claudeTraceContext({
      sessionId,
      turnId: "claude-turn",
      transcriptPath: "/tmp/claude.jsonl",
    });
    const codex = codexTraceContext({
      sessionId,
      turnId: "codex-turn",
      transcriptPath: "/tmp/codex.jsonl",
    });
    await Promise.all([
      recordClaudeTraceEvent({
        memoraxCodeHome: root,
        traceContext: claude,
        type: "memory_retrieve",
        source: "claude_hook_retrieval",
        operation: "retrieve",
        ok: true,
        request: { query: "claude query" },
      }),
      recordCodexTraceEvent({
        memoraxCodeHome: root,
        traceContext: codex,
        type: "memory_retrieve",
        source: "codex_hook_retrieval",
        operation: "retrieve",
        ok: true,
        request: { query: "codex query" },
      }),
    ]);

    const claudeEvent = JSON.parse(await readFile(claudeTracePaths(root).eventsJsonl(sessionId), "utf8"));
    const codexEvent = JSON.parse(await readFile(tracePaths(root).eventsJsonl(sessionId), "utf8"));
    assert.equal(claudeEvent.trace.client, "claude");
    assert.equal(claudeEvent.trace.turn_id, "claude-turn");
    assert.equal(claudeEvent.request.query, "claude query");
    assert.equal(codexEvent.trace.client, "codex");
    assert.equal(codexEvent.trace.turn_id, "codex-turn");
    assert.equal(codexEvent.request.query, "codex query");

    const claudeTrace = JSON.parse(await readFile(claudeTracePaths(root).traceJson(sessionId), "utf8"));
    const codexTrace = JSON.parse(await readFile(tracePaths(root).traceJson(sessionId), "utf8"));
    assert.equal(claudeTrace.client, "claude");
    assert.equal(claudeTrace.claude.transcript_path, "/tmp/claude.jsonl");
    assert.equal(claudeTrace.codex, undefined);
    assert.equal(codexTrace.client, "codex");
    assert.equal(codexTrace.codex.transcript_path, "/tmp/codex.jsonl");
    assert.equal(codexTrace.claude, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("client-specific trace wrappers fail closed on mismatches", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-client-trace-mismatch-"));
  const claude = claudeTraceContext();
  const codex = codexTraceContext();
  try {
    assert.deepEqual(await recordCodexTraceEvent({
      memoraxCodeHome: root,
      traceContext: claude,
      type: "turn_start",
    }), { written: false, reason: "client_mismatch" });
    assert.deepEqual(await recordClaudeTraceEvent({
      memoraxCodeHome: root,
      traceContext: codex,
      type: "turn_start",
    }), { written: false, reason: "client_mismatch" });
    assert.deepEqual(await recordCodexTraceEvent({
      memoraxCodeHome: root,
      traceContext: undefined,
      type: "turn_start",
      config: {
        enabled: false,
        captureContent: true,
        retentionDays: 7,
        maxEventChars: 20_000,
        maxFileBytes: 52_428_800,
      },
    }), { written: false, reason: "disabled" });
    assert.deepEqual(await writeCurrentCodexTurn(claude, { memoraxCodeHome: root }), {
      written: false,
      reason: "client_mismatch",
    });
    assert.deepEqual(await writeCurrentClaudeTurn(codex, { memoraxCodeHome: root }), {
      written: false,
      reason: "client_mismatch",
    });
    assert.deepEqual(await markCurrentCodexTurnOutcome(claude, "completed", { memoraxCodeHome: root }), {
      updated: false,
      reason: "client_mismatch",
    });
    assert.deepEqual(await markCurrentClaudeTurnOutcome(codex, "completed", { memoraxCodeHome: root }), {
      updated: false,
      reason: "client_mismatch",
    });
    await assert.rejects(readFile(tracePaths(root).eventsJsonl(claude.sessionId), "utf8"));
    await assert.rejects(readFile(claudeTracePaths(root).eventsJsonl(codex.sessionId), "utf8"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("generic trace APIs reject unsupported client identities before path access", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-client-trace-invalid-client-"));
  try {
    assert.throws(
      () => clientTraceConfigFromEnv("../escape", { MEMORAX_CODE_HOME: root }),
      /Unsupported trace client/,
    );
    assert.throws(
      () => clientTracePaths("../escape", root),
      /Unsupported trace client/,
    );
    assert.deepEqual(await recordTraceEvent({
      memoraxCodeHome: root,
      traceContext: {
        ...claudeTraceContext(),
        client: "../escape",
      },
      type: "turn_start",
    }), { written: false, reason: "unsupported_client" });
    await assert.rejects(stat(join(root, "debug")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude current-turn state is isolated and closes without changing Codex state", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-claude-current-turn-"));
  const context = claudeTraceContext();
  try {
    assert.deepEqual(await writeCurrentClaudeTurn(context, {
      memoraxCodeHome: root,
      now: () => new Date("2026-07-24T00:00:01.000Z"),
    }), { written: true });
    const current = await readCurrentClaudeTurn({
      memoraxCodeHome: root,
      expectedSessionId: context.sessionId,
      now: () => new Date("2026-07-24T00:00:02.000Z"),
    });
    assert.equal(current.ok, true);
    assert.equal(current.traceContext.client, "claude");
    assert.equal(current.traceContext.turnId, context.turnId);
    assert.deepEqual(await readCurrentCodexTurn({ memoraxCodeHome: root }), { ok: false, reason: "missing" });

    assert.deepEqual(await markCurrentClaudeTurnOutcome(context, "completed", { memoraxCodeHome: root }), {
      updated: true,
    });
    assert.deepEqual(await readOpenClaudeTurn({
      memoraxCodeHome: root,
      expectedSessionId: context.sessionId,
      allowStale: true,
    }), {
      ok: false,
      reason: "closed",
      outcome: "completed",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude retention removes only expired Claude sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-claude-trace-retention-"));
  try {
    const oldClaudeDir = claudeTracePaths(root).sessionDir("old-claude");
    const freshClaudeDir = claudeTracePaths(root).sessionDir("fresh-claude");
    const oldCodexDir = tracePaths(root).sessionDir("old-codex");
    for (const directory of [oldClaudeDir, freshClaudeDir, oldCodexDir]) {
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "events.jsonl"), "{}\n", "utf8");
    }
    const oldTime = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    for (const directory of [oldClaudeDir, oldCodexDir]) {
      await utimes(directory, oldTime, oldTime);
      await utimes(join(directory, "events.jsonl"), oldTime, oldTime);
    }

    await pruneExpiredClaudeTraceSessions({
      memoraxCodeHome: root,
      config: {
        enabled: true,
        captureContent: true,
        retentionDays: 1,
        maxEventChars: 20_000,
        maxFileBytes: 52_428_800,
      },
    });

    await assert.rejects(stat(oldClaudeDir));
    await stat(freshClaudeDir);
    await stat(oldCodexDir);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function claudeTraceContext(overrides = {}) {
  return {
    schemaVersion: "1",
    client: "claude",
    sessionId: "claude-session",
    turnId: "claude-turn",
    contextOrigin: "manual",
    capturedAt: "2026-07-24T00:00:00.000Z",
    ...overrides,
  };
}

function codexTraceContext(overrides = {}) {
  return {
    schemaVersion: "1",
    client: "codex",
    sessionId: "codex-session",
    turnId: "codex-turn",
    contextOrigin: "codex-hook-body",
    capturedAt: "2026-07-24T00:00:00.000Z",
    ...overrides,
  };
}
