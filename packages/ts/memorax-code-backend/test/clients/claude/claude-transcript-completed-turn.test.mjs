import assert from "node:assert/strict";
import { test } from "node:test";
import {
  claudeCodingSessionTurnFromJsonLines,
  claudeTranscriptTurnFromJsonLines,
} from "../../../dist/clients/claude/transcript-turn.js";

import {
  PROMPT_ID,
  SESSION_ID,
  assistantRecord,
  claudeUsage,
  jsonLines,
  userRecord,
} from "./support/claude-transcript-fixtures.mjs";

test("Claude transcript resolves one exact completed prompt branch", () => {
  const transcript = jsonLines([
    userRecord({ uuid: "user-visible", content: "Materialized Claude prompt.", timestamp: "2026-09-01T08:00:00.000Z" }),
    assistantRecord({
      uuid: "assistant-tool", parentUuid: "user-visible", stopReason: "tool_use",
      content: [
        { type: "text", text: "Working on it." },
        { type: "tool_use", id: "tool-1", name: "Read", input: {} },
      ],
    }),
    userRecord({
      uuid: "user-tool-result",
      parentUuid: "assistant-tool",
      timestamp: "2026-09-01T08:01:00.000Z",
      content: [{ type: "tool_result", tool_use_id: "tool-1", content: "tool output must not become the prompt" }],
    }),
    userRecord({ uuid: "user-meta", parentUuid: "user-tool-result", content: "hidden metadata", isMeta: true }),
    assistantRecord({
      uuid: "assistant-final",
      parentUuid: "user-meta",
      timestamp: "2026-09-01T08:03:00.000Z",
      stopReason: "end_turn",
      content: [
        { type: "thinking", thinking: "private" },
        { type: "text", text: "Materialized Claude answer." },
      ],
    }),
    assistantRecord({
      uuid: "assistant-sidechain",
      parentUuid: "user-visible",
      timestamp: "2026-09-01T08:04:00.000Z",
      stopReason: "end_turn",
      content: [{ type: "text", text: "Sidechain answer must be ignored." }],
      isSidechain: true,
    }),
  ]);

  assert.deepEqual(claudeTranscriptTurnFromJsonLines(transcript, {
    sessionId: SESSION_ID,
    promptId: PROMPT_ID,
  }), {
    ok: true,
    turn: {
      sessionId: SESSION_ID,
      promptId: PROMPT_ID,
      sessionTurnIndex: 1,
      userPrompt: "Materialized Claude prompt.",
      assistantReply: "Materialized Claude answer.",
      userTimestamp: Date.parse("2026-09-01T08:00:00.000Z"),
      assistantTimestamp: Date.parse("2026-09-01T08:03:00.000Z"),
      activities: [],
    },
  });
  const identity = { sessionId: SESSION_ID, promptId: PROMPT_ID };
  const source = claudeCodingSessionTurnFromJsonLines(transcript, identity);
  assert.equal(source.ok, true);
  const { items, closedAt, ...qa } = source.turn;
  assert.deepEqual(qa, claudeTranscriptTurnFromJsonLines(transcript, identity).turn);
  assert.equal(closedAt, "2026-09-01T08:03:00.000Z");
  assert.deepEqual(items, [
    { type: "message", role: "user", content: [{ type: "input_text", text: "Materialized Claude prompt." }] },
    { type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "Working on it." }] },
    { type: "function_call", call_id: "tool-1", name: "Read", arguments: "{}" },
    { type: "function_call_output", call_id: "tool-1", output: "tool output must not become the prompt" },
    { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "Materialized Claude answer." }] },
  ]);
});

test("Claude archive preserves native tool error flags without inferred response status", () => {
  const output = [{ type: "text", text: "File was not found." }];
  const transcript = jsonLines([
    userRecord({ uuid: "user-visible", content: "Read the configuration." }),
    assistantRecord({
      uuid: "assistant-tool", parentUuid: "user-visible", stopReason: "tool_use",
      content: [{ type: "tool_use", id: "read-config", name: "Read", input: { path: "missing.json" } }],
    }),
    userRecord({
      uuid: "user-tool-result", parentUuid: "assistant-tool",
      content: [{ type: "tool_result", tool_use_id: "read-config", is_error: true, content: output }],
    }),
    assistantRecord({
      uuid: "assistant-final", parentUuid: "user-tool-result", stopReason: "end_turn",
      content: [{ type: "text", text: "The configuration is absent." }],
    }),
  ]);
  const result = claudeCodingSessionTurnFromJsonLines(transcript, { sessionId: SESSION_ID, promptId: PROMPT_ID });
  assert.equal(result.ok, true);
  assert.deepEqual(result.turn.items.slice(1, -1).map((item) => (
    item.type === "function_call_output" ? { ...item, output: JSON.parse(item.output) } : item
  )), [
    { type: "function_call", call_id: "read-config", name: "Read", arguments: '{"path":"missing.json"}' },
    { type: "function_call_output", call_id: "read-config", output: { content: output, is_error: true } },
  ]);
});

test("Claude transcript aggregates exact-branch usage once per assistant message id", () => {
  const toolMessageUsage = claudeUsage({
    inputTokens: 12,
    cacheCreationInputTokens: 4,
    cacheReadInputTokens: 8,
    outputTokens: 3,
    ephemeral1hInputTokens: 1,
    ephemeral5mInputTokens: 3,
    webSearchRequests: 1,
    webFetchRequests: 2,
  });
  const transcript = jsonLines([
    userRecord({ uuid: "user-visible", content: "Measure this turn." }),
    assistantRecord({
      uuid: "assistant-off-branch",
      parentUuid: "user-visible",
      messageId: "message-off-branch",
      usage: claudeUsage({ inputTokens: 900, outputTokens: 900 }),
      stopReason: "tool_use",
      content: [{ type: "tool_use", id: "tool-off-branch", name: "Read", input: {} }],
    }),
    assistantRecord({
      uuid: "assistant-thinking",
      parentUuid: "user-visible",
      messageId: "message-tool",
      usage: toolMessageUsage,
      stopReason: null,
      content: [{ type: "thinking", thinking: "private" }],
    }),
    assistantRecord({
      uuid: "assistant-tool",
      parentUuid: "assistant-thinking",
      messageId: "message-tool",
      usage: toolMessageUsage,
      stopReason: "tool_use",
      content: [{ type: "tool_use", id: "tool-1", name: "Read", input: {} }],
    }),
    userRecord({
      uuid: "user-tool-result",
      parentUuid: "assistant-tool",
      content: [{ type: "tool_result", tool_use_id: "tool-1", content: "tool output" }],
    }),
    assistantRecord({
      uuid: "assistant-final",
      parentUuid: "user-tool-result",
      messageId: "message-final",
      usage: claudeUsage({
        inputTokens: 20,
        cacheCreationInputTokens: null,
        cacheReadInputTokens: null,
        outputTokens: 5,
      }),
      stopReason: "end_turn",
      content: [{ type: "text", text: "Measured." }],
    }),
  ]);

  assert.deepEqual(claudeTranscriptTurnFromJsonLines(transcript, {
    sessionId: SESSION_ID,
    promptId: PROMPT_ID,
  }), {
    ok: true,
    turn: {
      sessionId: SESSION_ID,
      promptId: PROMPT_ID,
      sessionTurnIndex: 1,
      userPrompt: "Measure this turn.",
      assistantReply: "Measured.",
      activities: [],
      usage: {
        input_tokens: 32,
        cache_creation_input_tokens: 4,
        cache_read_input_tokens: 8,
        output_tokens: 8,
        cache_creation: {
          ephemeral_1h_input_tokens: 1,
          ephemeral_5m_input_tokens: 3,
        },
        server_tool_use: {
          web_search_requests: 1,
          web_fetch_requests: 2,
        },
      },
    },
  });
});

test("Claude transcript omits usage when duplicate assistant message records disagree", () => {
  const transcript = jsonLines([
    userRecord({ uuid: "user-visible", content: "Keep content despite uncertain usage." }),
    assistantRecord({
      uuid: "assistant-partial",
      parentUuid: "user-visible",
      messageId: "message-unstable",
      usage: claudeUsage({ inputTokens: 10, outputTokens: 1 }),
      stopReason: null,
      content: [{ type: "thinking", thinking: "private" }],
    }),
    assistantRecord({
      uuid: "assistant-final",
      parentUuid: "assistant-partial",
      messageId: "message-unstable",
      usage: claudeUsage({ inputTokens: 10, outputTokens: 2 }),
      stopReason: "end_turn",
      content: [{ type: "text", text: "Content remains authoritative." }],
    }),
  ]);

  assert.deepEqual(claudeTranscriptTurnFromJsonLines(transcript, {
    sessionId: SESSION_ID,
    promptId: PROMPT_ID,
  }), {
    ok: true,
    turn: {
      sessionId: SESSION_ID,
      promptId: PROMPT_ID,
      sessionTurnIndex: 1,
      userPrompt: "Keep content despite uncertain usage.",
      assistantReply: "Content remains authoritative.",
      activities: [],
    },
  });
});

test("Claude transcript reads visible text blocks without treating images as content", () => {
  const transcript = jsonLines([
    userRecord({
      uuid: "user-visible",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: "redacted" } },
        { type: "text", text: "Inspect the attached image." },
      ],
    }),
    assistantRecord({
      uuid: "assistant-final",
      parentUuid: "user-visible",
      stopReason: "end_turn",
      content: [{ type: "text", text: "The image was inspected." }],
    }),
  ]);

  const result = claudeTranscriptTurnFromJsonLines(transcript, { sessionId: SESSION_ID, promptId: PROMPT_ID });
  assert.equal(result.ok, true);
  assert.equal(result.turn.userPrompt, "Inspect the attached image.");
});

test("Claude transcript excludes Hook-injected memory context from writeback content", () => {
  const transcript = jsonLines([
    userRecord({ uuid: "user-visible", content: "Implement the Hook retrieval boundary." }),
    userRecord({
      uuid: "user-hook-context",
      parentUuid: "user-visible",
      content: "Hidden MemoraX Code external memory context. Recalled marker must not be written back.",
      isMeta: true,
    }),
    assistantRecord({
      uuid: "assistant-final",
      parentUuid: "user-hook-context",
      stopReason: "end_turn",
      content: [{ type: "text", text: "Implemented without persisting the recalled marker." }],
    }),
  ]);

  assert.deepEqual(claudeTranscriptTurnFromJsonLines(transcript, {
    sessionId: SESSION_ID,
    promptId: PROMPT_ID,
  }), {
    ok: true,
    turn: {
      sessionId: SESSION_ID,
      promptId: PROMPT_ID,
      sessionTurnIndex: 1,
      userPrompt: "Implement the Hook retrieval boundary.",
      assistantReply: "Implemented without persisting the recalled marker.",
      activities: [],
    },
  });
});

test("Claude transcript fails closed on session mismatch and unknown prompts", () => {
  const transcript = jsonLines([
    userRecord({ uuid: "user-visible", content: "Exact prompt." }),
    assistantRecord({ uuid: "assistant-final", parentUuid: "user-visible", stopReason: "end_turn", content: [{ type: "text", text: "Exact answer." }] }),
  ]);

  assert.deepEqual(claudeTranscriptTurnFromJsonLines(transcript, {
    sessionId: "another-session",
    promptId: PROMPT_ID,
  }), { ok: false, reason: "transcript_session_mismatch" });
  assert.deepEqual(claudeTranscriptTurnFromJsonLines(transcript, {
    sessionId: SESSION_ID,
    promptId: "unknown-prompt",
  }), { ok: false, reason: "turn_not_found" });
});

test("Claude transcript fails closed until the exact assistant end_turn materializes", () => {
  const transcript = jsonLines([
    userRecord({ uuid: "user-visible", content: "Incomplete prompt." }),
    assistantRecord({ uuid: "assistant-partial", parentUuid: "user-visible", stopReason: null, content: [{ type: "text", text: "Partial answer." }] }),
  ]);

  assert.deepEqual(claudeTranscriptTurnFromJsonLines(transcript, {
    sessionId: SESSION_ID,
    promptId: PROMPT_ID,
  }), { ok: false, reason: "assistant_message_missing" });
});

test("Claude transcript rejects multiple completed branches for one prompt", () => {
  const transcript = jsonLines([
    userRecord({ uuid: "user-visible", content: "Ambiguous prompt." }),
    assistantRecord({ uuid: "assistant-a", parentUuid: "user-visible", stopReason: "end_turn", content: [{ type: "tool_use", id: "tool-a", name: "Bash", input: { command: "memorax-cli search --query a" } }, { type: "text", text: "Branch A." }] }),
    assistantRecord({ uuid: "assistant-b", parentUuid: "user-visible", stopReason: "end_turn", content: [{ type: "tool_use", id: "tool-b", name: "Bash", input: { command: "memorax-cli add --memory b" } }, { type: "text", text: "Branch B." }] }),
  ]);

  assert.deepEqual(claudeTranscriptTurnFromJsonLines(transcript, {
    sessionId: SESSION_ID,
    promptId: PROMPT_ID,
  }), { ok: false, reason: "turn_ambiguous" });
});

test("Claude transcript coalesces identical UUID snapshots with only workspace metadata changes", () => {
  const prompt = userRecord({ uuid: "user-snapshot", content: "Keep one completed answer." });
  const terminal = assistantRecord({
    uuid: "assistant-snapshot", parentUuid: "user-snapshot", messageId: "message-snapshot",
    stopReason: "end_turn", timestamp: "2026-09-01T08:03:00.000Z", content: "Completed answer.",
  });
  const transcript = jsonLines([
    prompt,
    { ...terminal, cwd: "/workspace/first", gitBranch: "feature-first", slug: "first" },
    { ...terminal, cwd: "/workspace/second", gitBranch: "feature-second", slug: "second" },
    terminal,
  ]);
  for (const read of [claudeTranscriptTurnFromJsonLines, claudeCodingSessionTurnFromJsonLines]) {
    const result = read(transcript, { sessionId: SESSION_ID, promptId: PROMPT_ID });
    assert.equal(result.ok, true);
    assert.equal(result.turn.assistantReply, "Completed answer.");
    if ("items" in result.turn) {
      assert.equal(result.turn.items.filter((item) => item.phase === "final_answer").length, 1);
    }
  }
});

test("Claude transcript rejects conflicting UUID records instead of trusting the final snapshot", () => {
  const prompt = userRecord({ uuid: "user-conflict", content: "Keep identity exact." });
  const terminal = assistantRecord({
    uuid: "assistant-conflict", parentUuid: "user-conflict", messageId: "message-conflict",
    stopReason: "end_turn", content: "Original answer.",
  });
  const conflicts = [
    [terminal, { ...terminal, message: { ...terminal.message, content: "Changed answer." } }],
    [terminal, { ...terminal, parentUuid: "unrelated-user" }],
    [terminal, { ...terminal, isSidechain: true }],
    [terminal, { ...terminal, message: { ...terminal.message, stop_reason: null } }],
    [prompt, { ...prompt, message: { role: "user", content: "Changed prompt." } }],
    [prompt, { ...prompt, promptId: "another-prompt" }],
  ];
  for (const conflicting of conflicts) {
    for (const snapshots of [conflicting, [...conflicting].reverse()]) {
      const records = conflicting[0] === prompt ? [...snapshots, terminal] : [prompt, ...snapshots];
      for (const read of [claudeTranscriptTurnFromJsonLines, claudeCodingSessionTurnFromJsonLines]) {
        assert.deepEqual(read(jsonLines(records), { sessionId: SESSION_ID, promptId: PROMPT_ID }), {
          ok: false, reason: "turn_ambiguous",
        });
      }
    }
  }
});

test("Claude transcript does not let system notification completions replace a human answer", () => {
  const prompt = userRecord({ uuid: "user-before-notification", content: "Complete the human task." });
  const terminal = assistantRecord({
    uuid: "assistant-before-notification", parentUuid: prompt.uuid,
    stopReason: "end_turn", content: "Human answer.",
  });
  for (const notificationFields of [{ origin: { kind: "task-notification" } }, { promptSource: "system" }]) {
    for (const content of [[{ type: "thinking", thinking: "Internal follow-up." }], "Notification answer."]) {
      const transcript = jsonLines([
        prompt, terminal,
        userRecord({
          uuid: "system-notification", parentUuid: terminal.uuid, content: "Task completed.",
          ...notificationFields,
        }),
        assistantRecord({ uuid: "notification-terminal", parentUuid: "system-notification", stopReason: "end_turn", content }),
      ]);
      for (const read of [claudeTranscriptTurnFromJsonLines, claudeCodingSessionTurnFromJsonLines]) {
        const result = read(transcript, { sessionId: SESSION_ID, promptId: PROMPT_ID });
        assert.equal(result.ok, true);
        assert.equal(result.turn.assistantReply, "Human answer.");
        if ("items" in result.turn) {
          assert.equal(JSON.stringify(result.turn.items).includes("Notification"), false);
        }
      }
    }
  }
});

test("Claude transcript cannot use a notification-only completion as the human answer", () => {
  const transcript = jsonLines([
    userRecord({ uuid: "human-without-answer", content: "Still awaiting an answer." }),
    userRecord({
      uuid: "system-only", parentUuid: "human-without-answer", content: "Task notification.",
      origin: { kind: "task-notification" },
    }),
    assistantRecord({ uuid: "system-only-answer", parentUuid: "system-only", stopReason: "end_turn", content: "System answer." }),
  ]);
  for (const read of [claudeTranscriptTurnFromJsonLines, claudeCodingSessionTurnFromJsonLines]) {
    assert.deepEqual(read(transcript, { sessionId: SESSION_ID, promptId: PROMPT_ID }), {
      ok: false, reason: "assistant_message_missing",
    });
  }
});

test("Claude transcript coalesces ancestor and descendant end_turn snapshots", () => {
  const transcript = jsonLines([
    userRecord({ uuid: "user-terminal-lineage", content: "Recover one terminal lineage." }),
    assistantRecord({
      uuid: "assistant-lineage-tool",
      parentUuid: "user-terminal-lineage",
      timestamp: "2026-07-27T10:00:01.123Z",
      stopReason: "tool_use",
      content: [{
        type: "tool_use",
        id: "tool-lineage-search",
        name: "Bash",
        input: {
          command: "memorax-cli.cmd search --query private-lineage-query",
          description: "private lineage reason",
        },
      }],
    }),
    userRecord({
      uuid: "user-lineage-result",
      parentUuid: "assistant-lineage-tool",
      content: [{
        type: "tool_result",
        tool_use_id: "tool-lineage-search",
        content: "private lineage result",
      }],
    }),
    assistantRecord({
      uuid: "assistant-terminal-ancestor",
      parentUuid: "user-lineage-result",
      timestamp: "2026-07-27T10:00:02.000Z",
      messageId: "message-terminal-snapshot",
      stopReason: "end_turn",
      content: [{ type: "text", text: "Earlier terminal snapshot." }],
    }),
    assistantRecord({
      uuid: "assistant-terminal-descendant",
      parentUuid: "assistant-terminal-ancestor",
      timestamp: Date.parse("2026-07-27T10:00:05.000Z"),
      messageId: "message-terminal-snapshot",
      stopReason: "end_turn",
      content: [{ type: "text", text: "Final terminal snapshot." }],
    }),
  ]);

  assert.deepEqual(claudeTranscriptTurnFromJsonLines(transcript, {
    sessionId: SESSION_ID,
    promptId: PROMPT_ID,
  }), {
    ok: true,
    turn: {
      sessionId: SESSION_ID,
      promptId: PROMPT_ID,
      sessionTurnIndex: 1,
      userPrompt: "Recover one terminal lineage.",
      assistantReply: "Final terminal snapshot.",
      assistantTimestamp: Date.parse("2026-07-27T10:00:05.000Z"),
      activities: [{ index: 1, type: "memory_cli_search" }],
    },
  });

});

test("Claude transcript keeps sibling end_turn lineages ambiguous", () => {
  const transcript = jsonLines([
    userRecord({ uuid: "user-sibling-lineages", content: "Reject sibling terminals." }),
    assistantRecord({
      uuid: "assistant-sibling-a-tool",
      parentUuid: "user-sibling-lineages",
      stopReason: "tool_use",
      content: [{
        type: "tool_use",
        id: "tool-sibling-a",
        name: "Bash",
        input: { command: "memorax-cli search --query private-sibling-a" },
      }],
    }),
    userRecord({
      uuid: "user-sibling-a-result",
      parentUuid: "assistant-sibling-a-tool",
      content: [{
        type: "tool_result",
        tool_use_id: "tool-sibling-a",
        content: "private sibling a result",
      }],
    }),
    assistantRecord({
      uuid: "assistant-sibling-a-final",
      parentUuid: "user-sibling-a-result",
      stopReason: "end_turn",
      content: [{ type: "text", text: "Sibling A." }],
    }),
    assistantRecord({
      uuid: "assistant-sibling-b-tool",
      parentUuid: "user-sibling-lineages",
      stopReason: "tool_use",
      content: [{
        type: "tool_use",
        id: "tool-sibling-b",
        name: "Bash",
        input: { command: "memorax-cli add --memory private-sibling-b" },
      }],
    }),
    userRecord({
      uuid: "user-sibling-b-result",
      parentUuid: "assistant-sibling-b-tool",
      content: [{
        type: "tool_result",
        tool_use_id: "tool-sibling-b",
        content: "private sibling b result",
      }],
    }),
    assistantRecord({
      uuid: "assistant-sibling-b-final",
      parentUuid: "user-sibling-b-result",
      stopReason: "end_turn",
      content: [{ type: "text", text: "Sibling B." }],
    }),
  ]);

  assert.deepEqual(claudeTranscriptTurnFromJsonLines(transcript, {
    sessionId: SESSION_ID,
    promptId: PROMPT_ID,
  }), { ok: false, reason: "turn_ambiguous" });
});

test("Claude transcript selects the completion whose nearest visible prompt has the exact prompt id", () => {
  const transcript = jsonLines([
    userRecord({ uuid: "user-first", content: "First prompt." }),
    assistantRecord({ uuid: "assistant-first", parentUuid: "user-first", stopReason: "end_turn", content: [{ type: "text", text: "First answer." }] }),
    userRecord({ uuid: "user-second", parentUuid: "assistant-first", promptId: "prompt-second", content: "Second prompt." }),
    assistantRecord({ uuid: "assistant-second", parentUuid: "user-second", stopReason: "end_turn", content: [{ type: "text", text: "Second answer." }] }),
  ]);

  assert.deepEqual(claudeTranscriptTurnFromJsonLines(transcript, {
    sessionId: SESSION_ID,
    promptId: PROMPT_ID,
  }), {
    ok: true,
    turn: {
      sessionId: SESSION_ID,
      promptId: PROMPT_ID,
      sessionTurnIndex: 1,
      userPrompt: "First prompt.",
      assistantReply: "First answer.",
      activities: [],
    },
  });
});

test("Claude transcript accepts a contiguous historical session prefix", () => {
  const previousSessionId = "session-claude-previous";
  const transcript = jsonLines([
    userRecord({
      uuid: "previous-user",
      promptId: "previous-prompt",
      sessionId: previousSessionId,
      content: "Previous session prompt.",
    }),
    assistantRecord({
      uuid: "previous-assistant",
      parentUuid: "previous-user",
      sessionId: previousSessionId,
      stopReason: "end_turn",
      content: [{ type: "text", text: "Previous session answer." }],
    }),
    userRecord({
      uuid: "current-user",
      parentUuid: "previous-assistant",
      content: "Current session prompt.",
    }),
    assistantRecord({
      uuid: "current-assistant",
      parentUuid: "current-user",
      stopReason: "end_turn",
      content: [{ type: "text", text: "Current session answer." }],
    }),
  ]);

  assert.deepEqual(claudeTranscriptTurnFromJsonLines(transcript, {
    sessionId: SESSION_ID,
    promptId: PROMPT_ID,
  }), {
    ok: true,
    turn: {
      sessionId: SESSION_ID,
      promptId: PROMPT_ID,
      sessionTurnIndex: 1,
      userPrompt: "Current session prompt.",
      assistantReply: "Current session answer.",
      activities: [],
    },
  });
});

test("Claude transcript rejects a foreign session after the requested session begins", () => {
  const transcript = jsonLines([
    userRecord({ uuid: "current-user", content: "Current session prompt." }),
    assistantRecord({
      uuid: "current-assistant",
      parentUuid: "current-user",
      stopReason: "end_turn",
      content: [{ type: "text", text: "Current session answer." }],
    }),
    userRecord({
      uuid: "foreign-user",
      promptId: "foreign-prompt",
      sessionId: "session-claude-foreign",
      content: "Foreign session prompt.",
    }),
  ]);

  assert.deepEqual(claudeTranscriptTurnFromJsonLines(transcript, {
    sessionId: SESSION_ID,
    promptId: PROMPT_ID,
  }), { ok: false, reason: "transcript_session_mismatch" });
});

test("Claude transcript counts unique interactive prompt ids and excludes explicit non-turn user records", () => {
  const transcript = jsonLines([
    userRecord({
      uuid: "task-notification",
      promptId: "prompt-task-notification",
      content: "Task notification.",
      origin: { kind: "task-notification" },
    }),
    userRecord({
      uuid: "system-prompt",
      parentUuid: "task-notification",
      promptId: "prompt-system",
      content: "System prompt.",
      promptSource: "system",
    }),
    userRecord({
      uuid: "interruption-marker",
      parentUuid: "system-prompt",
      promptId: "prompt-interruption",
      content: "Interruption marker.",
      interruptedMessageId: "assistant-interrupted",
    }),
    userRecord({
      uuid: "first-user",
      parentUuid: "interruption-marker",
      promptId: "prompt-first",
      content: "First interactive prompt.",
    }),
    userRecord({
      uuid: "first-user-duplicate",
      parentUuid: "first-user",
      promptId: "prompt-first",
      content: "First interactive prompt.",
    }),
    assistantRecord({
      uuid: "first-assistant",
      parentUuid: "first-user-duplicate",
      stopReason: "end_turn",
      content: [{ type: "text", text: "First interactive answer." }],
    }),
    userRecord({
      uuid: "target-user",
      parentUuid: "first-assistant",
      content: "Target interactive prompt.",
    }),
    assistantRecord({
      uuid: "target-assistant",
      parentUuid: "target-user",
      stopReason: "end_turn",
      content: [{ type: "text", text: "Target interactive answer." }],
    }),
  ]);

  assert.deepEqual(claudeTranscriptTurnFromJsonLines(transcript, {
    sessionId: SESSION_ID,
    promptId: PROMPT_ID,
  }), {
    ok: true,
    turn: {
      sessionId: SESSION_ID,
      promptId: PROMPT_ID,
      sessionTurnIndex: 2,
      userPrompt: "Target interactive prompt.",
      assistantReply: "Target interactive answer.",
      activities: [],
    },
  });
  for (const promptId of [
    "prompt-task-notification",
    "prompt-system",
    "prompt-interruption",
  ]) {
    assert.deepEqual(claudeTranscriptTurnFromJsonLines(transcript, {
      sessionId: SESSION_ID,
      promptId,
    }), { ok: false, reason: "turn_not_found" });
  }
});

test("Claude transcript ignores an incomplete unterminated JSONL tail", () => {
  const transcript = `${jsonLines([
    userRecord({ uuid: "user-visible", content: "Stable prompt." }),
    assistantRecord({ uuid: "assistant-final", parentUuid: "user-visible", stopReason: "end_turn", content: [{ type: "text", text: "Stable answer." }] }),
  ])}\n{"type":`;

  const result = claudeTranscriptTurnFromJsonLines(transcript, { sessionId: SESSION_ID, promptId: PROMPT_ID });
  assert.equal(result.ok, true);
  assert.equal(result.turn.assistantReply, "Stable answer.");
});

test("Claude transcript fails closed on malformed completed JSONL records", () => {
  const valid = [
    JSON.stringify(userRecord({ uuid: "user-visible", content: "Stable prompt." })),
    JSON.stringify(assistantRecord({ uuid: "assistant-final", parentUuid: "user-visible", stopReason: "end_turn", content: [{ type: "text", text: "Stable answer." }] })),
  ];

  for (const transcript of [
    `${valid[0]}\n{"broken":\n${valid[1]}`,
    `${valid.join("\n")}\n{"broken":\n`,
    `${valid[0]}\n[]\n${valid[1]}`,
  ]) {
    const result = claudeTranscriptTurnFromJsonLines(transcript, { sessionId: SESSION_ID, promptId: PROMPT_ID });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "transcript_unavailable");
  }
});

test("Claude transcript does not guess an earlier answer when a human terminal descendant is textless", () => {
  const transcript = jsonLines([
    userRecord({ uuid: "human-prompt", content: "Wait for the final completion." }),
    assistantRecord({ uuid: "visible-terminal", parentUuid: "human-prompt", stopReason: "end_turn", content: "Earlier answer." }),
    assistantRecord({ uuid: "textless-terminal", parentUuid: "visible-terminal", stopReason: "end_turn", content: [{ type: "thinking", thinking: "Continuing." }] }),
  ]);
  for (const read of [claudeTranscriptTurnFromJsonLines, claudeCodingSessionTurnFromJsonLines]) {
    assert.deepEqual(read(transcript, { sessionId: SESSION_ID, promptId: PROMPT_ID }), {
      ok: false, reason: "assistant_message_missing",
    });
  }
});

test("Claude transcript ignores non-human snapshot prompt labels and auxiliary tool result metadata", () => {
  const prompt = userRecord({ uuid: "metadata-user", content: "Read the selected file." });
  const call = assistantRecord({ uuid: "metadata-call", parentUuid: prompt.uuid, stopReason: "tool_use", content: [
    { type: "tool_use", id: "metadata-tool", name: "Read", input: {} },
  ] });
  const result = userRecord({ uuid: "metadata-result", parentUuid: call.uuid, timestamp: "2026-09-01T08:02:00.000Z", content: [
    { type: "tool_result", tool_use_id: "metadata-tool", content: "Native message output." },
  ] });
  const meta = userRecord({ uuid: "metadata-context", parentUuid: result.uuid, isMeta: true, content: "Hidden context." });
  const terminal = assistantRecord({ uuid: "metadata-final", parentUuid: meta.uuid, stopReason: "end_turn", content: "Selected answer." });
  const transcript = jsonLines([
    prompt, call,
    { ...result, promptId: "older-label", toolUseResult: { presentation: "first" } },
    { ...result, promptId: "newer-label", toolUseResult: { presentation: "second" } },
    { ...meta, promptId: "older-label" }, { ...meta, promptId: "newer-label" }, terminal,
  ]);
  for (const read of [claudeTranscriptTurnFromJsonLines, claudeCodingSessionTurnFromJsonLines]) {
    const parsed = read(transcript, { sessionId: SESSION_ID, promptId: PROMPT_ID });
    assert.equal(parsed.ok, true);
    assert.equal(parsed.turn.assistantReply, "Selected answer.");
    if ("items" in parsed.turn) {
      assert.deepEqual(parsed.turn.items.filter((item) => item.type === "function_call_output"), [
        { type: "function_call_output", call_id: "metadata-tool", output: "Native message output." },
      ]);
    }
  }
});

test("Claude transcript limits conflicting human identities to their reachable prompts", () => {
  const other = userRecord({ uuid: "conflicting-human", promptId: "other-prompt-one", content: "Another task." });
  const transcript = jsonLines([
    other, { ...other, promptId: "other-prompt-two" },
    assistantRecord({ uuid: "other-terminal", parentUuid: other.uuid, stopReason: "end_turn", content: "Other answer." }),
    userRecord({ uuid: "unaffected-human", content: "The selected task." }),
    assistantRecord({ uuid: "unaffected-terminal", parentUuid: "unaffected-human", stopReason: "end_turn", content: "Selected answer." }),
  ]);
  for (const read of [claudeTranscriptTurnFromJsonLines, claudeCodingSessionTurnFromJsonLines]) {
    assert.equal(read(transcript, { sessionId: SESSION_ID, promptId: PROMPT_ID }).ok, true);
    for (const promptId of ["other-prompt-one", "other-prompt-two"]) {
      assert.deepEqual(read(transcript, { sessionId: SESSION_ID, promptId }), { ok: false, reason: "turn_ambiguous" });
    }
  }
});

test("Claude transcript checks every conflicting parent before excluding a branch from the requested prompt", () => {
  const bridge = assistantRecord({ uuid: "conflicting-parent", parentUuid: "first-human", stopReason: null, content: "Working." });
  for (const variants of [[bridge, { ...bridge, parentUuid: "second-human" }], [{ ...bridge, parentUuid: "second-human" }, bridge]]) {
    const transcript = jsonLines([
      userRecord({ uuid: "first-human", promptId: "first-prompt", content: "First task." }),
      userRecord({ uuid: "second-human", promptId: "second-prompt", content: "Second task." }),
      ...variants,
      assistantRecord({ uuid: "conflicting-terminal", parentUuid: bridge.uuid, stopReason: "end_turn", content: "Uncertain answer." }),
      userRecord({ uuid: "unaffected-human", content: "Selected task." }),
      assistantRecord({ uuid: "unaffected-terminal", parentUuid: "unaffected-human", stopReason: "end_turn", content: "Selected answer." }),
    ]);
    for (const read of [claudeTranscriptTurnFromJsonLines, claudeCodingSessionTurnFromJsonLines]) {
      for (const promptId of ["first-prompt", "second-prompt"]) {
        assert.deepEqual(read(transcript, { sessionId: SESSION_ID, promptId }), { ok: false, reason: "turn_ambiguous" });
      }
      assert.equal(read(transcript, { sessionId: SESSION_ID, promptId: PROMPT_ID }).ok, true);
    }
  }
});

test("Claude transcript retains ambiguity when a conflicting lineage is missing or cyclic", () => {
  const bridge = assistantRecord({ uuid: "unresolved-parent", parentUuid: "other-human", stopReason: null, content: "Working." });
  for (const unresolvedParent of ["missing-parent", bridge.uuid]) {
    const transcript = jsonLines([
      userRecord({ uuid: "selected-human", content: "Selected task." }),
      assistantRecord({ uuid: "earlier-answer", parentUuid: "selected-human", stopReason: "end_turn", content: "Earlier answer." }),
      userRecord({ uuid: "other-human", promptId: "other-prompt", content: "Other task." }),
      bridge, { ...bridge, parentUuid: unresolvedParent },
      assistantRecord({ uuid: "uncertain-terminal", parentUuid: bridge.uuid, stopReason: "end_turn", content: "Uncertain answer." }),
    ]);
    for (const read of [claudeTranscriptTurnFromJsonLines, claudeCodingSessionTurnFromJsonLines]) {
      assert.deepEqual(read(transcript, { sessionId: SESSION_ID, promptId: PROMPT_ID }), { ok: false, reason: "turn_ambiguous" });
    }
  }
});
