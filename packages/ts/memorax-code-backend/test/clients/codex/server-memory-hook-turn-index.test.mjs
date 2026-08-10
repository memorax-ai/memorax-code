import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createCodexMemoryHookRuntime } from "../../../dist/clients/codex/memory-hook-runtime.js";
import { tracePaths } from "../../../dist/trace/config.js";

test("memory hook trace records the Codex session turn index at start and end", async () => {
  const memoraxCodeHome = await mkdtemp(join(tmpdir(), "memorax-code-hook-turn-index-"));
  const transcriptPath = await writeRollout(memoraxCodeHome, "session-turn-index", [
    { turnId: "turn-before", prompt: "Earlier prompt.", reply: "Earlier reply." },
    { turnId: "turn-target", prompt: "Target prompt.", reply: "Target reply." },
  ]);
  const controller = createCodexMemoryHookRuntime({
    memoraxCodeHome,
    env: traceEnv(),
  });
  try {
    assert.deepEqual(await controller.recordTurnStart({
      sessionId: "session-turn-index",
      turnId: "turn-target",
      prompt: "Target prompt.",
      cwd: "/repo",
      transcriptPath,
    }), { ok: true });

    const eventsPath = tracePaths(memoraxCodeHome).eventsJsonl("session-turn-index");
    await waitForEvent(eventsPath, "turn_start");
    await controller.writeback({
      sessionId: "session-turn-index",
      turnId: "turn-target",
      lastAssistantMessage: "Target reply.",
      transcriptPath,
    });
    const events = await waitForEvent(eventsPath, "turn_end");

    const turnStart = events.find((event) => event.type === "turn_start");
    const turnEnd = events.find((event) => event.type === "turn_end");
    assert.equal(turnStart.session_turn_index, 2);
    assert.equal(turnEnd.session_turn_index, 2);
  } finally {
    controller.close();
    await rm(memoraxCodeHome, { recursive: true, force: true });
  }
});

test("memory hook retries the Codex session turn index at turn end without guessing at start", async () => {
  const memoraxCodeHome = await mkdtemp(join(tmpdir(), "memorax-code-hook-turn-index-retry-"));
  const transcriptPath = await writeRollout(memoraxCodeHome, "session-turn-index-retry", [
    { turnId: "turn-before", prompt: "Earlier prompt.", reply: "Earlier reply." },
  ]);
  const controller = createCodexMemoryHookRuntime({
    memoraxCodeHome,
    env: traceEnv(),
  });
  try {
    assert.deepEqual(await controller.recordTurnStart({
      sessionId: "session-turn-index-retry",
      turnId: "turn-target",
      prompt: "Target prompt.",
      cwd: "/repo",
      transcriptPath,
    }), { ok: true });

    const eventsPath = tracePaths(memoraxCodeHome).eventsJsonl("session-turn-index-retry");
    let events = await waitForEvent(eventsPath, "turn_start");
    assert.equal(events.find((event) => event.type === "turn_start").session_turn_index, undefined);

    await writeRollout(memoraxCodeHome, "session-turn-index-retry", [
      { turnId: "turn-before", prompt: "Earlier prompt.", reply: "Earlier reply." },
      { turnId: "turn-target", prompt: "Target prompt.", reply: "Target reply." },
    ]);
    await controller.writeback({
      sessionId: "session-turn-index-retry",
      turnId: "turn-target",
      lastAssistantMessage: "Target reply.",
      transcriptPath,
    });
    events = await waitForEvent(eventsPath, "turn_end");

    assert.equal(events.find((event) => event.type === "turn_end").session_turn_index, 2);
  } finally {
    controller.close();
    await rm(memoraxCodeHome, { recursive: true, force: true });
  }
});

function traceEnv() {
  return {
    MEMORAX_CODE_HOME: undefined,
    MEMORAX_CODE_CODEX_TRACE_ENABLED: undefined,
  };
}

async function writeRollout(root, sessionId, turns) {
  const transcriptPath = join(root, `${sessionId}.jsonl`);
  const records = [{
    timestamp: "2026-07-17T00:00:00.000Z",
    type: "session_meta",
    payload: { id: sessionId },
  }];
  for (const [index, turn] of turns.entries()) {
    records.push(
      {
        timestamp: `2026-07-17T00:00:${String(index * 3 + 1).padStart(2, "0")}.000Z`,
        type: "turn_context",
        payload: { turn_id: turn.turnId },
      },
      {
        timestamp: `2026-07-17T00:00:${String(index * 3 + 2).padStart(2, "0")}.000Z`,
        type: "event_msg",
        payload: { type: "user_message", message: turn.prompt },
      },
      {
        timestamp: `2026-07-17T00:00:${String(index * 3 + 3).padStart(2, "0")}.000Z`,
        type: "event_msg",
        payload: { type: "agent_message", message: turn.reply, phase: "final_answer" },
      },
    );
  }
  await writeFile(transcriptPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
  return transcriptPath;
}

async function waitForEvent(path, eventType) {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    try {
      const events = (await readFile(path, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      if (events.some((event) => event.type === eventType)) return events;
    } catch {
      // The trace writer creates the file asynchronously.
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`${eventType} trace event was not written`);
}
