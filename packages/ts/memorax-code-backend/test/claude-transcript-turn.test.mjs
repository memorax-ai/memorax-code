import assert from "node:assert/strict";
import { test } from "node:test";
import {
  claudeInterruptedTranscriptTurnFromJsonLines,
  claudeTranscriptMemoryActivitiesFromJsonLines,
  claudeTranscriptTurnFromJsonLines,
} from "../dist/clients/claude/transcript-turn.js";

const SESSION_ID = "session-claude-exact";
const PROMPT_ID = "prompt-claude-exact";

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

test("Claude transcript records only exact-branch structured memory CLI activities", () => {
  const searchTool = {
    type: "tool_use",
    id: "tool-memory-search",
    name: "Bash",
    input: { command: "memorax-cli search --query 'prior context'" },
  };
  const transcript = jsonLines([
    userRecord({ uuid: "user-visible", content: "Use memory deliberately." }),
    assistantRecord({
      uuid: "assistant-off-branch",
      parentUuid: "user-visible",
      stopReason: "tool_use",
      content: [{
        type: "tool_use",
        id: "tool-off-branch",
        name: "Bash",
        input: { command: "memorax-cli add --memory 'off branch'" },
      }],
    }),
    assistantRecord({
      uuid: "assistant-search",
      parentUuid: "user-visible",
      stopReason: null,
      content: [searchTool],
    }),
    assistantRecord({
      uuid: "assistant-search-duplicate",
      parentUuid: "assistant-search",
      stopReason: "tool_use",
      content: [searchTool],
    }),
    userRecord({
      uuid: "user-search-result",
      parentUuid: "assistant-search-duplicate",
      content: [{ type: "tool_result", tool_use_id: "tool-memory-search", content: "search result" }],
    }),
    assistantRecord({
      uuid: "assistant-add",
      parentUuid: "user-search-result",
      stopReason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: "tool-source-review",
          name: "Bash",
          input: { command: "rg -n 'memorax-cli add' docs" },
        },
        {
          type: "tool_use",
          id: "tool-wrong-kind",
          name: "Read",
          input: { command: "memorax-cli add --memory 'not a Bash call'" },
        },
        {
          type: "tool_use",
          id: "tool-memory-add",
          name: "Bash",
          input: { command: "cd /workspace && memorax-cli add --memory 'reusable lesson'" },
        },
      ],
    }),
    userRecord({
      uuid: "user-add-result",
      parentUuid: "assistant-add",
      content: [{ type: "tool_result", tool_use_id: "tool-memory-add", content: "add result" }],
    }),
    assistantRecord({
      uuid: "assistant-final",
      parentUuid: "user-add-result",
      stopReason: "end_turn",
      content: [{ type: "text", text: "Memory operations complete." }],
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
      userPrompt: "Use memory deliberately.",
      assistantReply: "Memory operations complete.",
      activities: [
        { index: 1, type: "memory_cli_search" },
        { index: 2, type: "memory_cli_add" },
      ],
    },
  });
  assert.deepEqual(claudeTranscriptMemoryActivitiesFromJsonLines(transcript, {
    sessionId: SESSION_ID,
  }), [
    {
      promptId: PROMPT_ID,
      index: 1,
      occurrence: 1,
      type: "memory_cli_search",
      toolUseId: "tool-memory-search",
      ok: true,
    },
    {
      promptId: PROMPT_ID,
      index: 2,
      occurrence: 1,
      type: "memory_cli_add",
      toolUseId: "tool-memory-add",
      ok: true,
    },
  ]);
});

test("Claude transcript recognizes conservative absolute MemoraX Code CLI commands without exposing them", () => {
  const transcript = jsonLines([
    userRecord({ uuid: "user-absolute", content: "Use installed memory commands." }),
    assistantRecord({
      uuid: "assistant-absolute",
      parentUuid: "user-absolute",
      timestamp: "2026-07-27T08:00:01.123Z",
      stopReason: "tool_use",
      content: [{
        type: "tool_use",
        id: "tool-absolute-memory",
        name: "Bash",
        input: {
          command: "/private/install/bin/memorax-cli search --query private-query && \"/Path With Space/memorax-cli\" add --memory private-memory",
        },
      }],
    }),
    userRecord({
      uuid: "user-absolute-result",
      parentUuid: "assistant-absolute",
      content: [{
        type: "tool_result",
        tool_use_id: "tool-absolute-memory",
        content: "private tool result",
      }],
    }),
    assistantRecord({
      uuid: "assistant-absolute-final",
      parentUuid: "user-absolute-result",
      stopReason: "end_turn",
      content: [{ type: "text", text: "Done." }],
    }),
  ]);

  const activities = claudeTranscriptMemoryActivitiesFromJsonLines(transcript, {
    sessionId: SESSION_ID,
  });
  assert.deepEqual(activities, [
    {
      promptId: PROMPT_ID,
      index: 1,
      occurrence: 1,
      type: "memory_cli_search",
      toolUseId: "tool-absolute-memory",
      timestamp: "2026-07-27T08:00:01.123Z",
      ok: true,
    },
    {
      promptId: PROMPT_ID,
      index: 1,
      occurrence: 2,
      type: "memory_cli_add",
      toolUseId: "tool-absolute-memory",
      timestamp: "2026-07-27T08:00:01.123Z",
      ok: true,
    },
  ]);
  assert.doesNotMatch(JSON.stringify(activities), /private-query|private-memory|private tool result|install\/bin/);
});

test("Claude transcript recognizes memory CLI commands after shell assignment words", () => {
  const transcript = jsonLines([
    userRecord({ uuid: "user-assignment", content: "Recover assigned memory calls." }),
    assistantRecord({
      uuid: "assistant-assignment",
      parentUuid: "user-assignment",
      timestamp: "2026-07-27T09:00:01.123Z",
      stopReason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: "tool-assigned-bare",
          name: "Bash",
          input: {
            command: "MEMORAX_CODE_MODE=safe MEMORAX_CODE_LABEL='safe label' memorax-cli search --query private-assigned-query",
            description: "private assigned reason",
          },
        },
        {
          type: "tool_use",
          id: "tool-assigned-absolute",
          name: "Bash",
          input: {
            command: "MEMORAX_CODE_ROOT=\"/Private Root\" \"/Private Root/bin/memorax-cli\" search --query private-absolute-query",
          },
        },
        {
          type: "tool_use",
          id: "tool-assigned-rg",
          name: "Bash",
          input: { command: "PATTERN='memorax-cli search' rg -n \"$PATTERN\" private-source-path" },
        },
        {
          type: "tool_use",
          id: "tool-assigned-echo",
          name: "Bash",
          input: { command: "MESSAGE=safe echo memorax-cli search --query not-an-invocation" },
        },
      ],
    }),
    userRecord({
      uuid: "user-assignment-results",
      parentUuid: "assistant-assignment",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool-assigned-bare",
          content: "private bare result",
        },
        {
          type: "tool_result",
          tool_use_id: "tool-assigned-absolute",
          content: "private absolute result",
          is_error: true,
        },
        {
          type: "tool_result",
          tool_use_id: "tool-assigned-rg",
          content: "private rg result",
        },
        {
          type: "tool_result",
          tool_use_id: "tool-assigned-echo",
          content: "private echo result",
        },
      ],
    }),
    assistantRecord({
      uuid: "assistant-assignment-final",
      parentUuid: "user-assignment-results",
      stopReason: "end_turn",
      content: [{ type: "text", text: "Assignment calls checked." }],
    }),
  ]);

  const activities = claudeTranscriptMemoryActivitiesFromJsonLines(transcript, {
    sessionId: SESSION_ID,
  });
  assert.deepEqual(activities, [
    {
      promptId: PROMPT_ID,
      index: 1,
      occurrence: 1,
      type: "memory_cli_search",
      toolUseId: "tool-assigned-bare",
      timestamp: "2026-07-27T09:00:01.123Z",
      ok: true,
    },
    {
      promptId: PROMPT_ID,
      index: 2,
      occurrence: 1,
      type: "memory_cli_search",
      toolUseId: "tool-assigned-absolute",
      timestamp: "2026-07-27T09:00:01.123Z",
      ok: false,
    },
  ]);
  assert.doesNotMatch(
    JSON.stringify(activities),
    /private-assigned-query|private-absolute-query|private assigned reason|Private Root|private (?:bare|absolute|rg|echo) result|private-source-path|not-an-invocation/,
  );
});

test("Claude transcript derives only a bounded Search count from recognized result envelopes", () => {
  const transcript = jsonLines([
    userRecord({ uuid: "user-counts", content: "Count safe result envelopes." }),
    assistantRecord({
      uuid: "assistant-counts",
      parentUuid: "user-counts",
      stopReason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: "tool-count-xml",
          name: "Bash",
          input: { command: "memorax-cli search --query PRIVATE_COUNT_QUERY_XML" },
        },
        {
          type: "tool_use",
          id: "tool-count-json",
          name: "Bash",
          input: { command: "memorax-cli search --query PRIVATE_COUNT_QUERY_JSON --json" },
        },
        {
          type: "tool_use",
          id: "tool-count-malformed",
          name: "Bash",
          input: { command: "memorax-cli search --query PRIVATE_COUNT_QUERY_MALFORMED" },
        },
      ],
    }),
    userRecord({
      uuid: "user-count-results",
      parentUuid: "assistant-counts",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool-count-xml",
          content: [
            "<memories>",
            "  <facts memory_type=\"core\">",
            "   - PRIVATE_COUNT_RESULT_ONE &lt;facts&gt;",
            "   -[2026-07-27T09:10:00.000Z] PRIVATE_COUNT_RESULT_TWO",
            "  </facts>",
            "  <facts memory_type=\"procedural\">",
            "   - PRIVATE_COUNT_RESULT_THREE",
            "  </facts>",
            "</memories>",
          ].join("\n"),
        },
        {
          type: "tool_result",
          tool_use_id: "tool-count-json",
          content: JSON.stringify({
            ok: true,
            action: "memory.search",
            query: "PRIVATE_JSON_QUERY_BODY",
            items: [{ memory: "PRIVATE_JSON_RESULT_ONE" }, { memory: "PRIVATE_JSON_RESULT_TWO" }],
          }),
        },
        {
          type: "tool_result",
          tool_use_id: "tool-count-malformed",
          content: [
            "<memories>",
            "  <facts>",
            "   - PRIVATE_MALFORMED_RESULT",
            "PRIVATE_UNRECOGNIZED_LINE",
            "  </facts>",
            "</memories>",
          ].join("\n"),
        },
      ],
    }),
    assistantRecord({
      uuid: "assistant-counts-final",
      parentUuid: "user-count-results",
      stopReason: "end_turn",
      content: [{ type: "text", text: "Counts checked." }],
    }),
  ]);

  const activities = claudeTranscriptMemoryActivitiesFromJsonLines(transcript, {
    sessionId: SESSION_ID,
  });
  assert.deepEqual(activities, [
    {
      promptId: PROMPT_ID,
      index: 1,
      occurrence: 1,
      type: "memory_cli_search",
      toolUseId: "tool-count-xml",
      ok: true,
      itemCount: 3,
    },
    {
      promptId: PROMPT_ID,
      index: 2,
      occurrence: 1,
      type: "memory_cli_search",
      toolUseId: "tool-count-json",
      ok: true,
      itemCount: 2,
    },
    {
      promptId: PROMPT_ID,
      index: 3,
      occurrence: 1,
      type: "memory_cli_search",
      toolUseId: "tool-count-malformed",
      ok: true,
    },
  ]);
  assert.doesNotMatch(JSON.stringify(activities), /PRIVATE_/);
});

test("Claude transcript keeps counts unknown for multiple memory invocations and oversized envelopes", () => {
  const transcript = jsonLines([
    userRecord({ uuid: "user-count-guards", content: "Keep unsafe counts unknown." }),
    assistantRecord({
      uuid: "assistant-count-guards",
      parentUuid: "user-count-guards",
      stopReason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: "tool-count-multiple",
          name: "Bash",
          input: {
            command: "memorax-cli search --query PRIVATE_MULTI_A && memorax-cli search --query PRIVATE_MULTI_B",
          },
        },
        {
          type: "tool_use",
          id: "tool-count-oversized",
          name: "Bash",
          input: { command: "memorax-cli search --query PRIVATE_OVERSIZED_QUERY" },
        },
      ],
    }),
    userRecord({
      uuid: "user-count-guard-results",
      parentUuid: "assistant-count-guards",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool-count-multiple",
          content: [
            "<memories>",
            "  <facts>",
            "   - PRIVATE_MULTI_RESULT",
            "  </facts>",
            "</memories>",
          ].join("\n"),
        },
        {
          type: "tool_result",
          tool_use_id: "tool-count-oversized",
          content: [
            "<memories>",
            "  <facts>",
            ...Array.from({ length: 101 }, (_, index) => `   - PRIVATE_OVERSIZED_RESULT_${index}`),
            "  </facts>",
            "</memories>",
          ].join("\n"),
        },
      ],
    }),
    assistantRecord({
      uuid: "assistant-count-guards-final",
      parentUuid: "user-count-guard-results",
      stopReason: "end_turn",
      content: [{ type: "text", text: "Count guards checked." }],
    }),
  ]);

  const activities = claudeTranscriptMemoryActivitiesFromJsonLines(transcript, {
    sessionId: SESSION_ID,
  });
  assert.deepEqual(activities.map(({ type, occurrence, ok, itemCount }) => ({
    type,
    occurrence,
    ok,
    itemCount,
  })), [
    { type: "memory_cli_search", occurrence: 1, ok: true, itemCount: undefined },
    { type: "memory_cli_search", occurrence: 2, ok: true, itemCount: undefined },
    { type: "memory_cli_search", occurrence: 1, ok: true, itemCount: undefined },
  ]);
  assert.doesNotMatch(JSON.stringify(activities), /PRIVATE_/);
});

test("Claude transcript retains confirmed activities when the terminal reply has no visible text", () => {
  const transcript = jsonLines([
    userRecord({ uuid: "user-empty-reply", content: "Use memory." }),
    assistantRecord({
      uuid: "assistant-empty-tool",
      parentUuid: "user-empty-reply",
      stopReason: "tool_use",
      content: [{
        type: "tool_use",
        id: "tool-empty-reply",
        name: "Bash",
        input: { command: "memorax-cli search --query hidden-empty-query" },
      }],
    }),
    userRecord({
      uuid: "user-empty-result",
      parentUuid: "assistant-empty-tool",
      content: [{
        type: "tool_result",
        tool_use_id: "tool-empty-reply",
        content: "hidden empty result",
      }],
    }),
    assistantRecord({
      uuid: "assistant-empty-final",
      parentUuid: "user-empty-result",
      stopReason: "end_turn",
      content: [],
    }),
  ]);

  const activities = claudeTranscriptMemoryActivitiesFromJsonLines(transcript, {
    sessionId: SESSION_ID,
  });
  assert.deepEqual(activities, [{
    promptId: PROMPT_ID,
    index: 1,
    occurrence: 1,
    type: "memory_cli_search",
    toolUseId: "tool-empty-reply",
    ok: true,
  }]);
  assert.doesNotMatch(JSON.stringify(activities), /hidden-empty-query|hidden empty result/);
});

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
  assert.deepEqual(claudeTranscriptMemoryActivitiesFromJsonLines(transcript, {
    sessionId: SESSION_ID,
  }), []);
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

  const activities = claudeTranscriptMemoryActivitiesFromJsonLines(transcript, {
    sessionId: SESSION_ID,
  });
  assert.deepEqual(activities, [{
    promptId: PROMPT_ID,
    index: 1,
    occurrence: 1,
    type: "memory_cli_search",
    toolUseId: "tool-lineage-search",
    timestamp: "2026-07-27T10:00:01.123Z",
    ok: true,
  }]);
  assert.doesNotMatch(
    JSON.stringify(activities),
    /private-lineage-query|private lineage reason|private lineage result/,
  );
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
  assert.deepEqual(claudeTranscriptMemoryActivitiesFromJsonLines(transcript, {
    sessionId: SESSION_ID,
  }), []);
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

function userRecord({
  uuid,
  parentUuid = null,
  promptId = PROMPT_ID,
  sessionId = SESSION_ID,
  content,
  isMeta = false,
  origin,
  promptSource,
  interruptedMessageId,
  timestamp,
}) {
  return {
    parentUuid,
    isSidechain: false,
    isMeta,
    promptId,
    ...(origin === undefined ? {} : { origin }),
    ...(promptSource === undefined ? {} : { promptSource }),
    ...(interruptedMessageId === undefined ? {} : { interruptedMessageId }),
    ...(timestamp === undefined ? {} : { timestamp }),
    type: "user",
    userType: "external",
    message: { role: "user", content },
    uuid,
    sessionId,
  };
}

function assistantRecord({
  uuid,
  parentUuid,
  sessionId = SESSION_ID,
  messageId,
  usage,
  stopReason,
  content,
  isSidechain = false,
  timestamp,
}) {
  return {
    parentUuid,
    isSidechain,
    type: "assistant",
    message: {
      role: "assistant",
      content,
      stop_reason: stopReason,
      ...(messageId === undefined ? {} : { id: messageId }),
      ...(usage === undefined ? {} : { usage }),
    },
    uuid,
    sessionId,
    ...(timestamp === undefined ? {} : { timestamp }),
  };
}

function claudeUsage({
  inputTokens,
  cacheCreationInputTokens = null,
  cacheReadInputTokens = null,
  outputTokens,
  ephemeral1hInputTokens,
  ephemeral5mInputTokens,
  webSearchRequests,
  webFetchRequests,
}) {
  return {
    input_tokens: inputTokens,
    cache_creation_input_tokens: cacheCreationInputTokens,
    cache_read_input_tokens: cacheReadInputTokens,
    output_tokens: outputTokens,
    cache_creation: ephemeral1hInputTokens === undefined || ephemeral5mInputTokens === undefined
      ? null
      : {
        ephemeral_1h_input_tokens: ephemeral1hInputTokens,
        ephemeral_5m_input_tokens: ephemeral5mInputTokens,
      },
    server_tool_use: webSearchRequests === undefined || webFetchRequests === undefined
      ? null
      : {
        web_search_requests: webSearchRequests,
        web_fetch_requests: webFetchRequests,
      },
  };
}

function jsonLines(records) {
  return records.map((record) => JSON.stringify(record)).join("\n");
}
