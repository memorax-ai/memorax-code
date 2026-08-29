import assert from "node:assert/strict";
import { test } from "node:test";
import {
  codexInterruptedRolloutTurnFromJsonLines,
  codexRolloutTurnFromJsonLines,
  readCodexInterruptedRolloutTurn,
  readCodexRolloutTurn,
} from "../../../dist/clients/codex/rollout-turn.js";

test("Codex rollout reader selects the exact open turn and preserves prompt and final reply text", () => {
  const transcript = jsonLines([
    sessionMeta("session-1"),
    taskStarted("turn-before"),
    userMessage("Earlier prompt."),
    customToolCall('const r = await tools.exec_command({ cmd: "sed -n \'1,200p\' /Users/test/.codex/plugins/cache/memorax-code/memorax-code-codex-adapter/0.1.11/skills/memorax-code/references/repo-read.md" });'),
    agentMessage("Earlier reply.", "final_answer"),
    taskComplete("turn-before", "Earlier reply."),
    taskStarted("turn-target"),
    turnContext("turn-target"),
    userMessage("  Target prompt with trailing newline.\n"),
    agentMessage("Intermediate update.", "commentary"),
    agentMessage("Target final reply.\n", "final_answer"),
  ]);

  assert.deepEqual(codexRolloutTurnFromJsonLines(transcript, {
    sessionId: "session-1",
    turnId: "turn-target",
  }), {
    ok: true,
    turn: {
      sessionId: "session-1",
      turnId: "turn-target",
      userPrompt: "  Target prompt with trailing newline.\n",
      assistantReply: "Target final reply.\n",
      activities: [],
    },
  });
});

test("Codex rollout reader uses task_complete as a completed-turn assistant fallback", () => {
  const transcript = jsonLines([
    sessionMeta("session-1"),
    taskStarted("turn-1"),
    userMessage("Stored prompt."),
    taskComplete("turn-1", "Stored final reply."),
  ]);

  assert.deepEqual(codexRolloutTurnFromJsonLines(transcript, {
    sessionId: "session-1",
    turnId: "turn-1",
  }), {
    ok: true,
    turn: {
      sessionId: "session-1",
      turnId: "turn-1",
      userPrompt: "Stored prompt.",
      assistantReply: "Stored final reply.",
      activities: [],
    },
  });
});

test("Codex rollout reader supports response_item-only user and final assistant messages", () => {
  const transcript = jsonLines([
    sessionMeta("session-1"),
    taskStarted("turn-1"),
    turnContext("turn-1"),
    responseItemUserMessage("Current-format prompt.", "turn-1"),
    responseMessage("assistant", "Current-format final reply.", "final_answer", "turn-1"),
    taskComplete("turn-1"),
  ]);

  assert.deepEqual(codexRolloutTurnFromJsonLines(transcript, {
    sessionId: "session-1",
    turnId: "turn-1",
  }), {
    ok: true,
    turn: {
      sessionId: "session-1",
      turnId: "turn-1",
      userPrompt: "Current-format prompt.",
      assistantReply: "Current-format final reply.",
      activities: [],
    },
  });
});

test("Codex rollout reader prefers response_item messages over legacy event messages", () => {
  const transcript = jsonLines([
    sessionMeta("session-1"),
    taskStarted("turn-1"),
    turnContext("turn-1"),
    responseItemUserMessage("Current-format prompt."),
    userMessage("Legacy prompt."),
    responseMessage("assistant", "Current-format final reply.", "final_answer"),
    agentMessage("Legacy final reply.", "final_answer"),
    taskComplete("turn-1", "Legacy final reply."),
  ]);

  assert.deepEqual(codexRolloutTurnFromJsonLines(transcript, {
    sessionId: "session-1",
    turnId: "turn-1",
  }), {
    ok: true,
    turn: {
      sessionId: "session-1",
      turnId: "turn-1",
      userPrompt: "Current-format prompt.",
      assistantReply: "Current-format final reply.",
      activities: [],
    },
  });
});

test("Codex rollout reader fails closed for conflicting response_item turn metadata", () => {
  for (const conflictingRole of ["user", "assistant"]) {
    const transcript = jsonLines([
      sessionMeta("session-1"),
      taskStarted("turn-1"),
      turnContext("turn-1"),
      responseItemUserMessage(
        "Current-format prompt.",
        conflictingRole === "user" ? "other-turn" : "turn-1",
      ),
      userMessage("Legacy prompt."),
      responseMessage(
        "assistant",
        "Current-format final reply.",
        "final_answer",
        conflictingRole === "assistant" ? "other-turn" : "turn-1",
      ),
      agentMessage("Legacy final reply.", "final_answer"),
      taskComplete("turn-1", "Legacy final reply."),
    ]);

    assert.deepEqual(codexRolloutTurnFromJsonLines(transcript, {
      sessionId: "session-1",
      turnId: "turn-1",
    }), { ok: false, reason: "turn_metadata_mismatch" });
  }

  assert.deepEqual(codexInterruptedRolloutTurnFromJsonLines(jsonLines([
    sessionMeta("session-1"),
    taskStarted("turn-1"),
    turnContext("turn-1"),
    responseItemUserMessage("Current-format prompt.", "other-turn"),
    userMessage("Legacy prompt."),
    agentMessage("Visible partial reply.", "commentary"),
    turnAborted("turn-1"),
  ]), {
    sessionId: "session-1",
    turnId: "turn-1",
  }), { ok: false, reason: "turn_metadata_mismatch" });
});

test("Codex rollout reader aggregates cumulative token snapshots for the complete turn", () => {
  const baseline = tokenUsage({
    input_tokens: 100,
    cached_input_tokens: 40,
    cache_write_input_tokens: 2,
    output_tokens: 10,
    reasoning_output_tokens: 3,
  });
  const first = tokenUsage({
    input_tokens: 160,
    cached_input_tokens: 70,
    cache_write_input_tokens: 2,
    output_tokens: 15,
    reasoning_output_tokens: 5,
  });
  delete baseline.cache_write_input_tokens;
  delete first.cache_write_input_tokens;
  const reset = tokenUsage({
    input_tokens: 50,
    cached_input_tokens: 20,
    cache_write_input_tokens: 0,
    output_tokens: 4,
    reasoning_output_tokens: 1,
  });
  const afterReset = tokenUsage({
    input_tokens: 90,
    cached_input_tokens: 45,
    cache_write_input_tokens: 1,
    output_tokens: 9,
    reasoning_output_tokens: 3,
  });
  const transcript = jsonLines([
    sessionMeta("session-1"),
    tokenCount(baseline),
    taskStarted("turn-1"),
    userMessage("Prompt."),
    tokenCount(first),
    tokenCount(first, { rate_limits: { primary: { used_percent: 1 } } }),
    tokenCount(reset),
    tokenCount(afterReset),
    agentMessage("Reply.", "final_answer"),
    taskComplete("turn-1", "Reply."),
    tokenCount(tokenUsage({
      input_tokens: 200,
      cached_input_tokens: 100,
      cache_write_input_tokens: 2,
      output_tokens: 20,
      reasoning_output_tokens: 8,
    })),
  ]);

  assert.deepEqual(codexRolloutTurnFromJsonLines(transcript, {
    sessionId: "session-1",
    turnId: "turn-1",
  }), {
    ok: true,
    turn: {
      sessionId: "session-1",
      turnId: "turn-1",
      userPrompt: "Prompt.",
      assistantReply: "Reply.",
      activities: [],
      usage: {
        input_tokens: 100,
        cached_input_tokens: 55,
        cache_write_input_tokens: 1,
        output_tokens: 10,
        reasoning_output_tokens: 4,
        total_tokens: 110,
      },
    },
  });
});

test("Codex rollout reader records ordered repo-memory and memory CLI activities", () => {
  const pluginRoot = "/Users/test/.codex/plugins/cache/memorax-code/memorax-code-codex-adapter/0.1.11";
  const windowsPluginRoot = String.raw`C:\Users\test\.codex\plugins\cache\memorax-code\memorax-code-codex-adapter\0.1.11`;
  const transcript = jsonLines([
    sessionMeta("session-1", "vscode"),
    taskStarted("turn-1"),
    userMessage("Use repository memory, then search and add."),
    customToolCall(`const r = await tools.exec_command({ cmd: "sed -n '1,200p' ${pluginRoot}/skills/memorax-code/references/repo-build.md" });`),
    customToolCall(`const r = await tools.exec_command({ cmd: "type ${windowsPluginRoot}\\skills\\memorax-code\\references\\repo-build.md" });`),
    customToolCall(`const r = await tools.exec_command({ cmd: "sed -n '1,200p' ${pluginRoot}/skills/memorax-code/references/repo-read.md && sed -n '1,200p' ${pluginRoot}/skills/memorax-code/references/repo-update.md" });`),
    customToolCall('const r = await tools.exec_command({"cmd":"memorax-cli search --query \\"prior context\\""});'),
    customToolCall('const r = await tools.exec_command({ cmd: "git status --short" });'),
    customToolCall('const r = await tools.exec_command({ cmd: "memorax-cli add --message \\"reusable lesson\\"" });'),
    agentMessage("Done.", "final_answer"),
  ]);

  const result = codexRolloutTurnFromJsonLines(transcript, {
    sessionId: "session-1",
    turnId: "turn-1",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.turn.activities, [
    { index: 1, type: "repo_memory_operation", operation: "repo-build" },
    { index: 2, type: "repo_memory_operation", operation: "repo-read" },
    { index: 2, type: "repo_memory_operation", operation: "repo-update" },
    { index: 3, type: "memory_cli_search" },
    { index: 4, type: "memory_cli_add" },
  ]);
});

test("Codex rollout reader uses the file header authority across imported history", () => {
  const pluginRoot = "/Users/test/.codex/plugins/cache/memorax-code/memorax-code-codex-adapter/0.1.11";
  const vscodeTranscript = jsonLines([
    sessionMeta("session-current", "vscode"),
    sessionMeta("session-imported", "exec"),
    taskStarted("turn-imported"),
    userMessage("Imported prompt."),
    taskComplete("turn-imported", "Imported reply."),
    taskStarted("turn-target"),
    turnContext("turn-target"),
    userMessage("Current prompt."),
    customToolCall(`const r = await tools.exec_command({ cmd: "sed -n '1,200p' ${pluginRoot}/skills/memorax-code/references/repo-read.md" });`),
    tokenCount(tokenUsage({
      input_tokens: 120,
      cached_input_tokens: 40,
      cache_write_input_tokens: 0,
      output_tokens: 12,
      reasoning_output_tokens: 2,
    })),
    agentMessage("Current reply.", "final_answer"),
  ]);

  assert.deepEqual(codexRolloutTurnFromJsonLines(vscodeTranscript, {
    sessionId: "session-current",
    turnId: "turn-target",
  }), {
    ok: true,
    turn: {
      sessionId: "session-current",
      turnId: "turn-target",
      userPrompt: "Current prompt.",
      assistantReply: "Current reply.",
      activities: [{ index: 1, type: "repo_memory_operation", operation: "repo-read" }],
    },
  });

  const execTranscript = jsonLines([
    sessionMeta("session-current", "exec"),
    sessionMeta("session-imported", "vscode"),
    taskStarted("turn-target"),
    userMessage("Background prompt."),
    customToolCall(`const r = await tools.exec_command({ cmd: "sed -n '1,200p' ${pluginRoot}/skills/memorax-code/references/repo-read.md" });`),
    agentMessage("Background reply.", "final_answer"),
  ]);
  const execResult = codexRolloutTurnFromJsonLines(execTranscript, {
    sessionId: "session-current",
    turnId: "turn-target",
  });
  assert.equal(execResult.ok, true);
  assert.deepEqual(execResult.turn.activities, []);
});

test("Codex rollout reader treats repeated authority session metadata as idempotent", () => {
  const usage = tokenUsage({
    input_tokens: 30,
    cached_input_tokens: 12,
    cache_write_input_tokens: 0,
    output_tokens: 6,
    reasoning_output_tokens: 2,
  });
  const transcript = jsonLines([
    sessionMeta("session-1", "vscode"),
    sessionMeta("session-1", "vscode"),
    taskStarted("turn-1"),
    turnContext("turn-1"),
    userMessage("Prompt from a resumed session."),
    tokenCount(usage),
    sessionMeta("session-1", "vscode"),
    agentMessage("Reply from a resumed session.", "final_answer"),
  ]);

  assert.deepEqual(codexRolloutTurnFromJsonLines(transcript, {
    sessionId: "session-1",
    turnId: "turn-1",
  }), {
    ok: true,
    turn: {
      sessionId: "session-1",
      turnId: "turn-1",
      userPrompt: "Prompt from a resumed session.",
      assistantReply: "Reply from a resumed session.",
      activities: [],
      usage,
    },
  });
});

test("Codex interrupted rollout reader preserves visible partial output, usage, and activities", () => {
  const baseline = tokenUsage({
    input_tokens: 100,
    cached_input_tokens: 40,
    cache_write_input_tokens: 0,
    output_tokens: 10,
    reasoning_output_tokens: 3,
  });
  const afterWork = tokenUsage({
    input_tokens: 140,
    cached_input_tokens: 60,
    cache_write_input_tokens: 0,
    output_tokens: 15,
    reasoning_output_tokens: 4,
  });
  const transcript = jsonLines([
    sessionMeta("session-1"),
    tokenCount(baseline),
    taskStarted("turn-1"),
    turnContext("turn-1"),
    userMessage("Prompt interrupted after visible progress."),
    agentMessage("First visible update.", "commentary"),
    customToolCall('const r = await tools.exec_command({ cmd: "memorax-cli search --query \\"prior context\\"" });'),
    tokenCount(afterWork),
    agentMessage("Second visible update.", "commentary"),
    turnAborted("turn-1"),
    taskStarted("turn-2"),
    userMessage("Next prompt."),
    agentMessage("Next reply.", "final_answer"),
  ]);

  assert.deepEqual(codexInterruptedRolloutTurnFromJsonLines(transcript, {
    sessionId: "session-1",
    turnId: "turn-1",
  }), {
    ok: true,
    turn: {
      sessionId: "session-1",
      turnId: "turn-1",
      userPrompt: "Prompt interrupted after visible progress.",
      assistantReply: "First visible update.\n\nSecond visible update.",
      activities: [{ index: 1, type: "memory_cli_search" }],
      usage: {
        input_tokens: 40,
        cached_input_tokens: 20,
        cache_write_input_tokens: 0,
        output_tokens: 5,
        reasoning_output_tokens: 1,
        total_tokens: 45,
      },
      interruptedAt: "2026-07-16T00:00:04.500Z",
      sessionTurnIndex: 1,
    },
  });
});

test("Codex interrupted rollout reader omits a guessed turn index for imported history", () => {
  const transcript = jsonLines([
    sessionMeta("session-current", "vscode"),
    sessionMeta("session-imported", "vscode"),
    taskStarted("turn-imported"),
    turnContext("turn-imported"),
    userMessage("Imported prompt."),
    taskComplete("turn-imported", "Imported reply."),
    taskStarted("turn-target"),
    turnContext("turn-target"),
    userMessage("Current interrupted prompt."),
    agentMessage("Visible progress.", "commentary"),
    turnAborted("turn-target"),
  ]);

  assert.deepEqual(codexInterruptedRolloutTurnFromJsonLines(transcript, {
    sessionId: "session-current",
    turnId: "turn-target",
  }), {
    ok: true,
    turn: {
      sessionId: "session-current",
      turnId: "turn-target",
      userPrompt: "Current interrupted prompt.",
      assistantReply: "Visible progress.",
      activities: [],
      interruptedAt: "2026-07-16T00:00:04.500Z",
    },
  });
});

test("Codex interrupted rollout reader accepts an empty visible assistant response", () => {
  const transcript = jsonLines([
    sessionMeta("session-1"),
    taskStarted("turn-1"),
    turnContext("turn-1"),
    userMessage("Prompt interrupted before visible output."),
    turnAborted("turn-1"),
  ]);

  assert.deepEqual(codexInterruptedRolloutTurnFromJsonLines(transcript, {
    sessionId: "session-1",
    turnId: "turn-1",
  }), {
    ok: true,
    turn: {
      sessionId: "session-1",
      turnId: "turn-1",
      userPrompt: "Prompt interrupted before visible output.",
      assistantReply: "",
      activities: [],
      interruptedAt: "2026-07-16T00:00:04.500Z",
      sessionTurnIndex: 1,
    },
  });
});

test("Codex interrupted rollout reader derives the session turn index in the same scan", () => {
  const transcript = jsonLines([
    sessionMeta("session-1"),
    taskStarted("turn-1"),
    turnContext("turn-1"),
    userMessage("Completed prompt."),
    taskComplete("turn-1", "Completed reply."),
    taskStarted("turn-2"),
    turnContext("turn-2"),
    userMessage("Interrupted second prompt."),
    turnAborted("turn-2"),
  ]);

  const result = codexInterruptedRolloutTurnFromJsonLines(transcript, {
    sessionId: "session-1",
    turnId: "turn-2",
  });
  assert.equal(result.ok, true);
  assert.equal(result.turn.sessionTurnIndex, 2);
});

test("Codex interrupted rollout reader leaves edited and rolled-back prompts unresolved", () => {
  const transcript = jsonLines([
    sessionMeta("session-1"),
    taskStarted("turn-1"),
    turnContext("turn-1"),
    userMessage("Original prompt."),
    agentMessage("Visible output from the original prompt.", "commentary"),
    turnAborted("turn-1"),
    threadRolledBack(),
    taskStarted("turn-2"),
    userMessage("Edited prompt."),
  ]);

  assert.deepEqual(codexInterruptedRolloutTurnFromJsonLines(transcript, {
    sessionId: "session-1",
    turnId: "turn-1",
  }), { ok: false, reason: "turn_rolled_back" });
});

test("Codex interrupted rollout reader ignores rollback from a later turn", () => {
  const transcript = jsonLines([
    sessionMeta("session-1"),
    taskStarted("turn-1"),
    turnContext("turn-1"),
    userMessage("Ordinary interrupted prompt."),
    agentMessage("Visible output before interruption.", "commentary"),
    turnAborted("turn-1"),
    taskStarted("turn-2"),
    userMessage("A later prompt."),
    turnAborted("turn-2"),
    threadRolledBack(),
  ]);

  const result = codexInterruptedRolloutTurnFromJsonLines(transcript, {
    sessionId: "session-1",
    turnId: "turn-1",
  });
  assert.equal(result.ok, true);
  assert.equal(result.turn.assistantReply, "Visible output before interruption.");
});

test("Codex rollout reader attributes background repo-memory launchers to the parent turn only", () => {
  const pluginRoot = "/Users/test/.codex/plugins/cache/memorax-code/memorax-code-codex-adapter/0.1.11";
  const parent = codexRolloutTurnFromJsonLines(jsonLines([
    sessionMeta("parent-session", "vscode"),
    taskStarted("parent-turn"),
    userMessage("Start repository memory jobs."),
    customToolCall(`const r = await tools.exec_command({ cmd: "node \\"${pluginRoot}/hooks/repo-memory-job.mjs\\" start --mode build --repo /repo" });`),
    customToolCall(`const r = await tools.exec_command({ cmd: "node \\"${pluginRoot}/hooks/repo-memory-job.mjs\\" start --mode=update --repo /repo" });`),
    agentMessage("Jobs started.", "final_answer"),
  ]), {
    sessionId: "parent-session",
    turnId: "parent-turn",
  });
  assert.equal(parent.ok, true);
  assert.deepEqual(parent.turn.activities, [
    { index: 1, type: "repo_memory_operation", operation: "repo-build" },
    { index: 2, type: "repo_memory_operation", operation: "repo-update" },
  ]);

  const child = codexRolloutTurnFromJsonLines(jsonLines([
    sessionMeta("child-session", "exec"),
    taskStarted("child-turn"),
    userMessage("Background builder task."),
    customToolCall(`const r = await tools.exec_command({ cmd: "sed -n '1,240p' ${pluginRoot}/skills/memorax-code/references/repo-build.md" });`),
    agentMessage("Build complete.", "final_answer"),
  ]), {
    sessionId: "child-session",
    turnId: "child-turn",
  });
  assert.equal(child.ok, true);
  assert.deepEqual(child.turn.activities, []);
});

test("Codex rollout reader does not treat source review or command text as an activity", () => {
  const transcript = jsonLines([
    sessionMeta("session-1", "vscode"),
    taskStarted("turn-1"),
    userMessage("Review repo-memory implementation."),
    customToolCall('const r = await tools.exec_command({ cmd: "sed -n \'1,200p\' packages/ts/memorax-code-codex-adapter/skills/memorax-code/references/repo-read.md" });'),
    customToolCall('const r = await tools.exec_command({ cmd: "sed -n \'1,200p\' /Users/test/.codex/plugins/cache/memorax-code/memorax-code-codex-adapter/0.1.11/skills/memorax-code/SKILL.md" });'),
    customToolCall('const r = await tools.exec_command({ cmd: "rg -n \'memorax-cli search\' docs" });'),
    customToolCall('const r = await tools.exec_command({ cmd: "node packages/ts/memorax-code-codex-adapter/hooks/repo-memory-job.mjs start --mode build --repo ." });'),
    agentMessage("Reviewed.", "final_answer"),
  ]);

  const result = codexRolloutTurnFromJsonLines(transcript, {
    sessionId: "session-1",
    turnId: "turn-1",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.turn.activities, []);
});

test("Codex rollout reader fails closed for session, turn, and content mismatches", () => {
  const base = [
    sessionMeta("session-1"),
    taskStarted("turn-1"),
    userMessage("Prompt."),
    agentMessage("Reply.", "final_answer"),
  ];

  assert.deepEqual(codexRolloutTurnFromJsonLines(jsonLines(base), {
    sessionId: "other-session",
    turnId: "turn-1",
  }), { ok: false, reason: "transcript_session_mismatch" });
  assert.deepEqual(codexRolloutTurnFromJsonLines(jsonLines([
    taskStarted("turn-before-header"),
    sessionMeta("session-1"),
    taskStarted("turn-1"),
    userMessage("Prompt."),
    agentMessage("Reply.", "final_answer"),
  ]), {
    sessionId: "session-1",
    turnId: "turn-1",
  }), { ok: false, reason: "transcript_session_mismatch" });
  assert.deepEqual(codexRolloutTurnFromJsonLines([
    "{malformed-json",
    jsonLines([
      sessionMeta("session-1"),
      taskStarted("turn-1"),
      userMessage("Prompt."),
      agentMessage("Reply.", "final_answer"),
    ]),
  ].join("\n"), {
    sessionId: "session-1",
    turnId: "turn-1",
  }), { ok: false, reason: "transcript_session_mismatch" });
  assert.deepEqual(codexRolloutTurnFromJsonLines(jsonLines([
    sessionMeta("other-session"),
    sessionMeta("session-1"),
    taskStarted("turn-1"),
    userMessage("Prompt."),
    agentMessage("Reply.", "final_answer"),
  ]), {
    sessionId: "session-1",
    turnId: "turn-1",
  }), { ok: false, reason: "transcript_session_mismatch" });
  assert.deepEqual(codexRolloutTurnFromJsonLines(jsonLines([
    { type: "session_meta", payload: { session_id: "session-1" } },
    taskStarted("turn-1"),
    userMessage("Prompt."),
    agentMessage("Reply.", "final_answer"),
  ]), {
    sessionId: "session-1",
    turnId: "turn-1",
  }), { ok: false, reason: "transcript_session_mismatch" });
  assert.deepEqual(codexRolloutTurnFromJsonLines(jsonLines([
    sessionMeta("session-1"),
    { type: "session_meta", payload: {} },
    taskStarted("turn-1"),
    userMessage("Prompt."),
    agentMessage("Reply.", "final_answer"),
  ]), {
    sessionId: "session-1",
    turnId: "turn-1",
  }), { ok: false, reason: "transcript_session_mismatch" });
  for (const trailingSessionMeta of [
    sessionMeta("other-session"),
    { type: "session_meta", payload: {} },
  ]) {
    assert.deepEqual(codexRolloutTurnFromJsonLines(jsonLines([
      sessionMeta("session-1"),
      taskStarted("turn-1"),
      userMessage("Prompt."),
      trailingSessionMeta,
      agentMessage("Reply.", "final_answer"),
    ]), {
      sessionId: "session-1",
      turnId: "turn-1",
    }), { ok: false, reason: "transcript_session_mismatch" });
  }
  assert.deepEqual(codexRolloutTurnFromJsonLines(jsonLines(base), {
    sessionId: "session-1",
    turnId: "missing-turn",
  }), { ok: false, reason: "turn_not_found" });
  assert.deepEqual(codexRolloutTurnFromJsonLines(jsonLines([
    sessionMeta("session-1"),
    taskStarted("turn-1"),
    agentMessage("Reply.", "final_answer"),
  ]), {
    sessionId: "session-1",
    turnId: "turn-1",
  }), { ok: false, reason: "user_prompt_missing" });
  assert.deepEqual(codexRolloutTurnFromJsonLines(jsonLines([
    sessionMeta("session-1"),
    taskStarted("turn-1"),
    userMessage("Prompt."),
    agentMessage("Only commentary.", "commentary"),
  ]), {
    sessionId: "session-1",
    turnId: "turn-1",
  }), { ok: false, reason: "assistant_message_missing" });
});

test("Codex rollout reader reports an unavailable transcript without throwing", async () => {
  const result = await readCodexRolloutTurn({
    transcriptPath: "/path/that/does/not/exist.jsonl",
    sessionId: "session-1",
    turnId: "turn-1",
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "transcript_unavailable");
  assert.equal(typeof result.error, "string");
});

test("Codex interrupted rollout reader reports an unavailable transcript without throwing", async () => {
  const result = await readCodexInterruptedRolloutTurn({
    transcriptPath: "/path/that/does/not/exist.jsonl",
    sessionId: "session-1",
    turnId: "turn-1",
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "transcript_unavailable");
  assert.equal(typeof result.error, "string");
});

function jsonLines(records) {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

function sessionMeta(sessionId, source) {
  return { timestamp: "2026-07-16T00:00:00.000Z", type: "session_meta", payload: { id: sessionId, source } };
}

function taskStarted(turnId) {
  return { timestamp: "2026-07-16T00:00:01.000Z", type: "event_msg", payload: { type: "task_started", turn_id: turnId } };
}

function turnContext(turnId) {
  return { timestamp: "2026-07-16T00:00:02.000Z", type: "turn_context", payload: { turn_id: turnId } };
}

function userMessage(message) {
  return { timestamp: "2026-07-16T00:00:03.000Z", type: "event_msg", payload: { type: "user_message", message } };
}

function agentMessage(message, phase) {
  return { timestamp: "2026-07-16T00:00:04.000Z", type: "event_msg", payload: { type: "agent_message", message, phase } };
}

function taskComplete(turnId, lastAgentMessage) {
  return {
    timestamp: "2026-07-16T00:00:05.000Z",
    type: "event_msg",
    payload: { type: "task_complete", turn_id: turnId, last_agent_message: lastAgentMessage },
  };
}

function turnAborted(turnId, reason = "interrupted") {
  return {
    timestamp: "2026-07-16T00:00:04.500Z",
    type: "event_msg",
    payload: { type: "turn_aborted", turn_id: turnId, reason },
  };
}

function threadRolledBack() {
  return {
    timestamp: "2026-07-16T00:00:04.750Z",
    type: "event_msg",
    payload: { type: "thread_rolled_back", num_turns: 1 },
  };
}

function tokenCount(totalTokenUsage, extra = {}) {
  return {
    timestamp: "2026-07-16T00:00:03.500Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: { total_token_usage: totalTokenUsage },
      ...extra,
    },
  };
}

function tokenUsage(usage) {
  return {
    ...usage,
    total_tokens: usage.input_tokens + usage.output_tokens,
  };
}

function responseMessage(role, text, phase, turnId) {
  return {
    timestamp: "2026-07-16T00:00:04.000Z",
    type: "response_item",
    payload: {
      type: "message",
      role,
      phase,
      content: [{ type: "output_text", text }],
      ...(turnId ? { internal_chat_message_metadata_passthrough: { turn_id: turnId } } : {}),
    },
  };
}

function responseItemUserMessage(text, turnId) {
  return {
    timestamp: "2026-07-16T00:00:03.000Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text }],
      ...(turnId ? { internal_chat_message_metadata_passthrough: { turn_id: turnId } } : {}),
    },
  };
}

function customToolCall(input) {
  return {
    timestamp: "2026-07-16T00:00:03.500Z",
    type: "response_item",
    payload: { type: "custom_tool_call", name: "exec", input },
  };
}
