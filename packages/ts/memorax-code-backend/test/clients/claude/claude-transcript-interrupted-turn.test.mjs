import assert from "node:assert/strict";
import { test } from "node:test";
import { claudeInterruptedTranscriptTurnFromJsonLines } from "../../../dist/clients/claude/transcript-turn.js";

import {
  PROMPT_ID,
  SESSION_ID,
  assistantRecord,
  claudeUsage,
  jsonLines,
  userRecord,
} from "./support/claude-transcript-fixtures.mjs";

test("Claude transcript recovers an interrupted turn from the marker parent graph", () => {
  const transcript = jsonLines([
    userRecord({ uuid: "user-interrupted", content: "Investigate the interruption." }),
    assistantRecord({
      uuid: "assistant-partial",
      parentUuid: "user-interrupted",
      messageId: "message-partial",
      usage: claudeUsage({ inputTokens: 10, outputTokens: 2 }),
      stopReason: null,
      content: [{ type: "text", text: "Partial analysis." }],
    }),
    assistantRecord({
      uuid: "assistant-tool",
      parentUuid: "assistant-partial",
      messageId: "message-tool",
      usage: claudeUsage({ inputTokens: 20, outputTokens: 3 }),
      stopReason: "tool_use",
      content: [{
        type: "tool_use",
        id: "tool-memory-search",
        name: "Bash",
        input: { command: "memorax-cli search --query 'interruption context'" },
      }],
    }),
    userRecord({
      uuid: "user-tool-result",
      parentUuid: "assistant-tool",
      content: [{ type: "tool_result", tool_use_id: "tool-memory-search", content: "search result" }],
    }),
    assistantRecord({
      uuid: "assistant-after-tool",
      parentUuid: "user-tool-result",
      messageId: "message-after-tool",
      usage: claudeUsage({ inputTokens: 30, outputTokens: 4 }),
      stopReason: null,
      content: [{ type: "text", text: "Partial conclusion." }],
    }),
    userRecord({
      uuid: "interruption-marker",
      parentUuid: "assistant-after-tool",
      content: "Interrupted by the user.",
      interruptedMessageId: "message-not-directly-resolvable",
      timestamp: "2026-07-25T08:15:30.000Z",
    }),
    userRecord({
      uuid: "user-next",
      parentUuid: "interruption-marker",
      promptId: "prompt-next",
      content: "Continue with another prompt.",
    }),
  ]);

  assert.deepEqual(claudeInterruptedTranscriptTurnFromJsonLines(transcript, {
    sessionId: SESSION_ID,
    promptId: PROMPT_ID,
  }), {
    ok: true,
    turn: {
      sessionId: SESSION_ID,
      promptId: PROMPT_ID,
      sessionTurnIndex: 1,
      userPrompt: "Investigate the interruption.",
      assistantReply: "Partial analysis.\n\nPartial conclusion.",
      activities: [{ index: 1, type: "memory_cli_search" }],
      usage: {
        input_tokens: 60,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 9,
        cache_creation: {
          ephemeral_1h_input_tokens: 0,
          ephemeral_5m_input_tokens: 0,
        },
        server_tool_use: {
          web_search_requests: 0,
          web_fetch_requests: 0,
        },
      },
      interruptedAt: "2026-07-25T08:15:30.000Z",
    },
  });
  assert.deepEqual(claudeInterruptedTranscriptTurnFromJsonLines(transcript, {
    sessionId: SESSION_ID,
    promptId: "prompt-next",
  }), { ok: false, reason: "turn_not_interrupted" });
});

test("Claude transcript preserves an interrupted turn without assistant material", () => {
  const transcript = jsonLines([
    userRecord({ uuid: "user-interrupted", content: "Stop immediately." }),
    userRecord({
      uuid: "interruption-marker",
      parentUuid: "user-interrupted",
      content: "Interrupted by the user.",
      interruptedMessageId: "message-without-material",
    }),
  ]);

  assert.deepEqual(claudeInterruptedTranscriptTurnFromJsonLines(transcript, {
    sessionId: SESSION_ID,
    promptId: PROMPT_ID,
  }), {
    ok: true,
    turn: {
      sessionId: SESSION_ID,
      promptId: PROMPT_ID,
      sessionTurnIndex: 1,
      userPrompt: "Stop immediately.",
      assistantReply: "",
      activities: [],
    },
  });
});

test("Claude transcript fails closed on multiple interruption branches", () => {
  const transcript = jsonLines([
    userRecord({ uuid: "user-interrupted", content: "Ambiguous interruption." }),
    userRecord({
      uuid: "interruption-a",
      parentUuid: "user-interrupted",
      content: "First interruption marker.",
      interruptedMessageId: "message-a",
    }),
    userRecord({
      uuid: "interruption-b",
      parentUuid: "user-interrupted",
      content: "Second interruption marker.",
      interruptedMessageId: "message-b",
    }),
  ]);

  assert.deepEqual(claudeInterruptedTranscriptTurnFromJsonLines(transcript, {
    sessionId: SESSION_ID,
    promptId: PROMPT_ID,
  }), { ok: false, reason: "turn_ambiguous" });
});
