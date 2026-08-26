import assert from "node:assert/strict";
import { test } from "node:test";
import {
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
    userRecord({ uuid: "user-visible", content: "Materialized Claude prompt." }),
    assistantRecord({ uuid: "assistant-tool", parentUuid: "user-visible", stopReason: "tool_use", content: [{ type: "tool_use", id: "tool-1", name: "Read", input: {} }] }),
    userRecord({
      uuid: "user-tool-result",
      parentUuid: "assistant-tool",
      content: [{ type: "tool_result", tool_use_id: "tool-1", content: "tool output must not become the prompt" }],
    }),
    userRecord({ uuid: "user-meta", parentUuid: "user-tool-result", content: "hidden metadata", isMeta: true }),
    assistantRecord({
      uuid: "assistant-final",
      parentUuid: "user-meta",
      stopReason: "end_turn",
      content: [
        { type: "thinking", thinking: "private" },
        { type: "text", text: "Materialized Claude answer." },
      ],
    }),
    assistantRecord({
      uuid: "assistant-sidechain",
      parentUuid: "user-visible",
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
      activities: [],
    },
  });
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
          command: "memorax-cli search --query private-lineage-query",
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
      messageId: "message-terminal-snapshot",
      stopReason: "end_turn",
      content: [{ type: "text", text: "Earlier terminal snapshot." }],
    }),
    assistantRecord({
      uuid: "assistant-terminal-descendant",
      parentUuid: "assistant-terminal-ancestor",
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
