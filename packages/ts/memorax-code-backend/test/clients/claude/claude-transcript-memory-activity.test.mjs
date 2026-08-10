import assert from "node:assert/strict";
import { test } from "node:test";
import {
  claudeTranscriptMemoryActivitiesFromJsonLines,
  claudeTranscriptTurnFromJsonLines,
} from "../../../dist/clients/claude/transcript-turn.js";

import {
  PROMPT_ID,
  SESSION_ID,
  assistantRecord,
  jsonLines,
  userRecord,
} from "./support/claude-transcript-fixtures.mjs";

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
