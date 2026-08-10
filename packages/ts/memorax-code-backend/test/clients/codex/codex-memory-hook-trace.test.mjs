import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodexMemoryHookRuntime } from "../../../dist/clients/codex/memory-hook-runtime.js";
import { tracePaths } from "../../../dist/trace/config.js";
import {
  captureUnhandledRejections,
  delay,
  memoraxAddFetch,
  waitForFile,
  writeRollout,
} from "./support/memory-hook-fixtures.mjs";

const TEST_WORKSPACE = fileURLToPath(new URL("../../..", import.meta.url));
const TEST_REPO_ROOT = resolve(TEST_WORKSPACE, "../../..");
const GIT_TURN_START_RESULT = { ok: true, repoMemoryWorktree: TEST_REPO_ROOT };
const TEST_MEMORAX_CODE_HOME = join(tmpdir(), `memorax-code-hook-scope-${process.pid}`);
const WRITEBACK_ENV = {
  MEMORAX_CODE_HOME: TEST_MEMORAX_CODE_HOME,
  MEMORAX_CODE_MEMORY_WRITEBACK_ENABLED: "true",
  MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_ENABLED: "false",
  MEMORAX_CODE_MEMORAX_ENDPOINT: "http://memorax.test",
  MEMORAX_CODE_MEMORAX_API_KEY: "secret",
  MEMORAX_CODE_MEMORAX_USER_ID: "user-1",
};

test("memory hook turn-start trace failures do not create unhandled rejections", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-hook-trace-unhandled-"));
  const blocker = join(root, "debug");
  await writeFile(blocker, "file", "utf8");
  const unhandled = captureUnhandledRejections();
  const controller = createCodexMemoryHookRuntime({
    env: { ...WRITEBACK_ENV, MEMORAX_CODE_HOME: root },
    memoraxCodeHome: root,
  });
  try {
    assert.deepEqual(await controller.recordTurnStart({
      sessionId: "session-trace-failure",
      turnId: "turn-trace-failure",
      prompt: "Trace write should fail open.",
      cwd: TEST_WORKSPACE,
      transcriptPath: "/tmp/trace-failure.jsonl",
    }), GIT_TURN_START_RESULT);
    await delay(50);
    assert.deepEqual(unhandled.errors, []);
  } finally {
    controller.close();
    unhandled.restore();
    await rm(root, { recursive: true, force: true });
  }
});

test("memory hook writeback records turn_end even when the Codex rollout is unavailable", async () => {
  const sessionHome = await mkdtemp(join(tmpdir(), "memorax-code-hook-turn-end-"));
  const controller = createCodexMemoryHookRuntime({
    env: {
      MEMORAX_CODE_HOME: undefined,
      MEMORAX_CODE_CODEX_TRACE_ENABLED: undefined,
    },
    memoraxCodeHome: sessionHome,
  });
  try {
    const result = await controller.writeback({
      sessionId: "session-turn-end",
      turnId: "turn-end-1",
      lastAssistantMessage: "Assistant answer should be traced.",
      cwd: "/repo",
      transcriptPath: "/tmp/codex-transcript.jsonl",
    });
    assert.deepEqual(result, { ok: true, scheduled: false, reason: "transcript_unavailable" });

    const eventsPath = tracePaths(sessionHome).eventsJsonl("session-turn-end");
    await waitForFile(eventsPath, /turn_end/, "turn_end trace event was not written");
    const events = (await readFile(eventsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "turn_end");
    assert.equal(events[0].trace.session_id, "session-turn-end");
    assert.equal(events[0].trace.turn_id, "turn-end-1");
    assert.equal(events[0].trace.context_origin, "codex-hook-body");
    assert.equal(events[0].trace.cwd, "/repo");
    assert.equal(events[0].trace.transcript_path, "/tmp/codex-transcript.jsonl");
    assert.equal(events[0].response.assistantMessage, "Assistant answer should be traced.");
    assert.equal(events[0].activities, undefined);
  } finally {
    controller.close();
    await rm(sessionHome, { recursive: true, force: true });
  }
});

test("memory hook deduplicates lifecycle events and appends late rollout materialization", async () => {
  const sessionHome = await mkdtemp(join(tmpdir(), "memorax-code-hook-lifecycle-idempotency-"));
  const sessionId = "session-lifecycle-idempotency";
  const turnId = "turn-lifecycle-idempotency";
  const transcriptPath = join(sessionHome, `${sessionId}.jsonl`);
  const controller = createCodexMemoryHookRuntime({
    automaticWriteback: () => ({ accepted: true }),
    env: {
      ...WRITEBACK_ENV,
      MEMORAX_CODE_HOME: sessionHome,
      MEMORAX_CODE_CODEX_TRACE_ENABLED: undefined,
    },
    memoraxCodeHome: sessionHome,
  });
  const turnStart = {
    sessionId,
    turnId,
    prompt: "Materialize this Codex turn later.",
    cwd: TEST_WORKSPACE,
    transcriptPath,
  };
  const writeback = {
    sessionId,
    turnId,
    lastAssistantMessage: "Hook answer before rollout materialization.",
    cwd: TEST_WORKSPACE,
    transcriptPath,
  };
  try {
    assert.deepEqual(await controller.recordTurnStart(turnStart), GIT_TURN_START_RESULT);
    assert.deepEqual(await controller.recordTurnStart(turnStart), GIT_TURN_START_RESULT);
    assert.deepEqual(await controller.writeback(writeback), {
      ok: true,
      scheduled: false,
      reason: "transcript_unavailable",
    });

    await writeRollout(sessionHome, sessionId, [{
      turnId,
      prompt: "Materialize this Codex turn later.",
      reply: "Exact rollout answer after materialization.",
    }]);
    assert.deepEqual(await controller.writeback(writeback), { ok: true, scheduled: true });

    const events = (await readFile(tracePaths(sessionHome).eventsJsonl(sessionId), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(events.map((event) => event.type), [
      "turn_start",
      "turn_end",
      "turn_materialized",
    ]);
    assert.equal(events[0].event_id.startsWith("trace-turn-start-"), true);
    assert.equal(events[1].event_id.startsWith("trace-turn-end-"), true);
    assert.equal(events[1].response.assistantMessage, "Hook answer before rollout materialization.");
    assert.equal(events[2].event_id.startsWith("trace-turn-materialized-"), true);
    assert.equal(events[2].request.original_event_id, events[1].event_id);
    assert.equal(events[2].request.prompt, "Materialize this Codex turn later.");
    assert.equal(events[2].response.assistantMessage, "Exact rollout answer after materialization.");
  } finally {
    controller.close();
    await rm(sessionHome, { recursive: true, force: true });
  }
});

test("memory hook writeback records turn_end with cached trace context when Stop omits paths", async () => {
  const sessionHome = await mkdtemp(join(tmpdir(), "memorax-code-hook-turn-end-fallback-"));
  const transcriptPath = await writeRollout(sessionHome, "session-turn-end-fallback", [{
    turnId: "turn-end-fallback",
    prompt: "Prompt with paths.",
    reply: "Assistant answer uses cached paths.",
  }]);
  const controller = createCodexMemoryHookRuntime({
    env: {
      ...WRITEBACK_ENV,
      MEMORAX_CODE_HOME: undefined,
      MEMORAX_CODE_CODEX_TRACE_ENABLED: undefined,
    },
    fetchImpl: async () => new Response("{}", { status: 200 }),
    memoraxCodeHome: sessionHome,
  });
  try {
    assert.deepEqual(await controller.recordTurnStart({
      sessionId: "session-turn-end-fallback",
      turnId: "turn-end-fallback",
      prompt: "Prompt with paths.",
      cwd: TEST_WORKSPACE,
      transcriptPath,
    }), GIT_TURN_START_RESULT);

    const result = await controller.writeback({
      sessionId: "session-turn-end-fallback",
      turnId: "turn-end-fallback",
      lastAssistantMessage: "Assistant answer uses cached paths.",
    });
    assert.deepEqual(result, { ok: true, scheduled: true });

    const eventsPath = tracePaths(sessionHome).eventsJsonl("session-turn-end-fallback");
    await waitForFile(eventsPath, /turn_end/, "turn_end trace event was not written");
    const events = (await readFile(eventsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const turnEnd = events.find((event) => event.type === "turn_end");
    assert.equal(turnEnd.trace.session_id, "session-turn-end-fallback");
    assert.equal(turnEnd.trace.turn_id, "turn-end-fallback");
    assert.equal(turnEnd.trace.cwd, TEST_WORKSPACE);
    assert.equal(turnEnd.trace.transcript_path, transcriptPath);
    assert.equal(turnEnd.response.assistantMessage, "Assistant answer uses cached paths.");
  } finally {
    controller.close();
    await rm(sessionHome, { recursive: true, force: true });
  }
});

test("memory hook closes an ordinary interrupted turn before recording the next turn", async () => {
  const sessionHome = await mkdtemp(join(tmpdir(), "memorax-code-hook-interrupted-turn-"));
  const transcriptPath = await writeRollout(sessionHome, "session-interrupted-turn", [
    {
      turnId: "turn-interrupted",
      prompt: "Inspect the trace before interruption.",
      interrupted: true,
      commentaries: ["First visible update.", "Second visible update."],
      toolCalls: ['const r = await tools.exec_command({ cmd: "memorax-cli search --query \\"trace\\"" });'],
      tokenUsage: {
        input_tokens: 120,
        cached_input_tokens: 80,
        cache_write_input_tokens: 0,
        output_tokens: 20,
        reasoning_output_tokens: 5,
        total_tokens: 140,
      },
    },
    {
      turnId: "turn-next",
      prompt: "Continue after interruption.",
      reply: "Completed next answer.",
    },
  ]);
  const { fetchImpl, requests } = memoraxAddFetch();
  const controller = createCodexMemoryHookRuntime({
    env: {
      ...WRITEBACK_ENV,
      MEMORAX_CODE_HOME: undefined,
      MEMORAX_CODE_CODEX_TRACE_ENABLED: undefined,
    },
    fetchImpl,
    memoraxCodeHome: sessionHome,
  });
  try {
    await controller.recordTurnStart({
      sessionId: "session-interrupted-turn",
      turnId: "turn-interrupted",
      prompt: "Inspect the trace before interruption.",
      cwd: TEST_WORKSPACE,
      transcriptPath,
    });
    await controller.recordTurnStart({
      sessionId: "session-interrupted-turn",
      turnId: "turn-next",
      prompt: "Continue after interruption.",
      cwd: TEST_WORKSPACE,
      transcriptPath,
    });

    const eventsPath = tracePaths(sessionHome).eventsJsonl("session-interrupted-turn");
    const events = (await readFile(eventsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(events.map((event) => event.type), ["turn_start", "turn_end", "turn_start"]);
    const interruptedEnd = events[1];
    assert.match(interruptedEnd.event_id, /^trace-turn-end-[a-f0-9]{32}$/);
    assert.equal(interruptedEnd.trace.turn_id, "turn-interrupted");
    assert.equal(interruptedEnd.outcome, "interrupted");
    assert.equal(interruptedEnd.timestamp, "2026-07-16T00:00:03.750Z");
    assert.equal(interruptedEnd.response.assistantMessage, "First visible update.\n\nSecond visible update.");
    assert.equal(interruptedEnd.session_turn_index, 1);
    assert.deepEqual(interruptedEnd.activities, [{ index: 1, type: "memory_cli_search" }]);
    assert.deepEqual(interruptedEnd.usage, {
      input_tokens: 120,
      cached_input_tokens: 80,
      cache_write_input_tokens: 0,
      output_tokens: 20,
      reasoning_output_tokens: 5,
      total_tokens: 140,
    });
    assert.equal(requests.length, 0);
    assert.equal(controller.size(), 1);
  } finally {
    controller.close();
    await rm(sessionHome, { recursive: true, force: true });
  }
});

test("memory hook closes an interrupted turn from a composite Codex rollout", async () => {
  const sessionHome = await mkdtemp(join(tmpdir(), "memorax-code-hook-composite-rollout-"));
  const sessionId = "session-composite-rollout";
  const transcriptPath = await writeRollout(sessionHome, sessionId, [
    {
      turnId: "turn-interrupted",
      prompt: "Inspect the composite rollout before interruption.",
      interrupted: true,
      commentaries: ["Visible progress from the current session."],
      tokenUsage: {
        input_tokens: 120,
        cached_input_tokens: 80,
        cache_write_input_tokens: 0,
        output_tokens: 20,
        reasoning_output_tokens: 5,
        total_tokens: 140,
      },
    },
    {
      turnId: "turn-next",
      prompt: "Continue after the composite interruption.",
      reply: "Completed next answer.",
    },
  ], {
    headerSource: "vscode",
    prefixRecords: [
      {
        timestamp: "2026-07-15T23:59:57.000Z",
        type: "session_meta",
        payload: { id: "session-imported-history", source: "exec" },
      },
      {
        timestamp: "2026-07-15T23:59:58.000Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "turn-imported-history" },
      },
      {
        timestamp: "2026-07-15T23:59:59.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "Imported historical prompt." },
      },
    ],
  });
  const { fetchImpl, requests } = memoraxAddFetch();
  const controller = createCodexMemoryHookRuntime({
    env: {
      ...WRITEBACK_ENV,
      MEMORAX_CODE_HOME: undefined,
      MEMORAX_CODE_CODEX_TRACE_ENABLED: undefined,
    },
    fetchImpl,
    memoraxCodeHome: sessionHome,
  });
  try {
    await controller.recordTurnStart({
      sessionId,
      turnId: "turn-interrupted",
      prompt: "Inspect the composite rollout before interruption.",
      cwd: TEST_WORKSPACE,
      transcriptPath,
    });
    await controller.recordTurnStart({
      sessionId,
      turnId: "turn-next",
      prompt: "Continue after the composite interruption.",
      cwd: TEST_WORKSPACE,
      transcriptPath,
    });

    const events = (await readFile(tracePaths(sessionHome).eventsJsonl(sessionId), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(events.map((event) => event.type), ["turn_start", "turn_end", "turn_start"]);
    assert.equal(events[1].trace.turn_id, "turn-interrupted");
    assert.equal(events[1].outcome, "interrupted");
    assert.equal(events[1].response.assistantMessage, "Visible progress from the current session.");
    assert.equal("session_turn_index" in events[1], false);
    assert.equal("usage" in events[1], false);
    assert.equal(requests.length, 0);
  } finally {
    controller.close();
    await rm(sessionHome, { recursive: true, force: true });
  }
});

test("memory hook closes an interrupted turn from the session bridge after restart", async () => {
  const sessionHome = await mkdtemp(join(tmpdir(), "memorax-code-hook-interrupted-restart-"));
  const sessionId = "session-interrupted-restart";
  const transcriptPath = await writeRollout(sessionHome, sessionId, [
    {
      turnId: "turn-before-restart",
      prompt: "Interrupt before restarting the Backend.",
      interrupted: true,
      commentaries: ["Visible progress survives restart."],
    },
    {
      turnId: "turn-after-restart",
      prompt: "Continue after restarting the Backend.",
      reply: "Completed after restart.",
    },
  ]);
  const options = {
    env: {
      MEMORAX_CODE_HOME: undefined,
      MEMORAX_CODE_CODEX_TRACE_ENABLED: undefined,
    },
    memoraxCodeHome: sessionHome,
  };
  const first = createCodexMemoryHookRuntime(options);
  try {
    await first.recordTurnStart({
      sessionId,
      turnId: "turn-before-restart",
      prompt: "Interrupt before restarting the Backend.",
      cwd: TEST_WORKSPACE,
      transcriptPath,
    });
    await waitForFile(
      tracePaths(sessionHome).sessionCurrentTurnPath(sessionId),
      /turn-before-restart/,
      "session current turn was not persisted before restart",
    );
  } finally {
    first.close();
  }

  const second = createCodexMemoryHookRuntime(options);
  try {
    await second.recordTurnStart({
      sessionId,
      turnId: "turn-after-restart",
      prompt: "Continue after restarting the Backend.",
      cwd: TEST_WORKSPACE,
      transcriptPath,
    });

    const events = (await readFile(tracePaths(sessionHome).eventsJsonl(sessionId), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(events.map((event) => event.type), ["turn_start", "turn_end", "turn_start"]);
    assert.equal(events[1].trace.turn_id, "turn-before-restart");
    assert.equal(events[1].outcome, "interrupted");
    assert.equal(events[1].response.assistantMessage, "Visible progress survives restart.");
  } finally {
    second.close();
    await rm(sessionHome, { recursive: true, force: true });
  }
});

test("memory hook leaves prompt-edit rollback turns pending without a synthetic turn end", async () => {
  const sessionHome = await mkdtemp(join(tmpdir(), "memorax-code-hook-rolled-back-turn-"));
  const transcriptPath = await writeRollout(sessionHome, "session-rolled-back-turn", [
    {
      turnId: "turn-original",
      prompt: "Original prompt.",
      interrupted: true,
      rolledBack: true,
      commentaries: ["Visible output before editing."],
    },
    {
      turnId: "turn-edited",
      prompt: "Edited prompt.",
      reply: "Edited prompt answer.",
    },
  ]);
  const controller = createCodexMemoryHookRuntime({
    env: {
      MEMORAX_CODE_HOME: undefined,
      MEMORAX_CODE_CODEX_TRACE_ENABLED: undefined,
    },
    memoraxCodeHome: sessionHome,
  });
  try {
    await controller.recordTurnStart({
      sessionId: "session-rolled-back-turn",
      turnId: "turn-original",
      prompt: "Original prompt.",
      cwd: TEST_WORKSPACE,
      transcriptPath,
    });
    await controller.recordTurnStart({
      sessionId: "session-rolled-back-turn",
      turnId: "turn-edited",
      prompt: "Edited prompt.",
      cwd: TEST_WORKSPACE,
      transcriptPath,
    });

    const eventsPath = tracePaths(sessionHome).eventsJsonl("session-rolled-back-turn");
    const events = (await readFile(eventsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(events.map((event) => event.type), ["turn_start", "turn_start"]);
    assert.equal(events.some((event) => event.type === "turn_end"), false);
  } finally {
    controller.close();
    await rm(sessionHome, { recursive: true, force: true });
  }
});
