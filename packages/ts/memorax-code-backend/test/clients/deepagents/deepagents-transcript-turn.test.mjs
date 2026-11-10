import assert from "node:assert/strict";
import { test } from "node:test";
import {
  deepAgentsInterruptedTranscriptTurnFromJsonLines,
  deepAgentsTranscriptTurnFromJsonLines,
} from "../../../dist/clients/deepagents/transcript-turn.js";
import {
  PROMPT_ID,
  SESSION_ID,
  THREAD_ID,
  jsonLines,
  record,
} from "./support/deepagents-transcript-fixtures.mjs";

test("Deep Agents transcript aligns by prompt text and uses Stop reply authority", () => {
  const transcript = jsonLines([
    record({ sequence: 0, role: "user", content: "Earlier prompt." }),
    record({ sequence: 1, role: "assistant", content: "Earlier answer." }),
    record({ sequence: 2, role: "user", content: "Current dcode prompt.", timestamp: "2026-11-01T08:00:00.000Z" }),
    record({
      sequence: 3,
      role: "assistant",
      content: [
        { type: "text", text: "I will search memory." },
        { type: "tool_call", name: "bash", args: { command: "memorax-cli search prior context" } },
      ],
    }),
    record({ sequence: 4, role: "tool", name: "bash", content: "search output" }),
    record({ sequence: 5, role: "assistant", content: "Partial transcript answer.", timestamp: "2026-11-01T08:01:00.000Z" }),
  ]);

  assert.deepEqual(deepAgentsTranscriptTurnFromJsonLines(transcript, {
    sessionId: SESSION_ID,
    promptId: PROMPT_ID,
    prompt: "Current dcode prompt.",
    lastAssistantMessage: "Final dcode answer from Stop.",
  }), {
    ok: true,
    turn: {
      sessionId: SESSION_ID,
      promptId: PROMPT_ID,
      sessionTurnIndex: 2,
      userPrompt: "Current dcode prompt.",
      assistantReply: "Final dcode answer from Stop.",
      userTimestamp: Date.parse("2026-11-01T08:00:00.000Z"),
      assistantTimestamp: Date.parse("2026-11-01T08:01:00.000Z"),
      activities: [{ index: 1, type: "memory_cli_search" }],
    },
  });
});

test("Deep Agents transcript does not require hook session_id to equal thread_id", () => {
  const transcript = jsonLines([
    record({ sequence: 0, role: "user", content: "Prompt." }),
    record({ sequence: 1, role: "assistant", content: "Answer." }),
  ]);
  const result = deepAgentsTranscriptTurnFromJsonLines(transcript, {
    sessionId: "dcode-session-identity",
    promptId: PROMPT_ID,
    prompt: "Prompt.",
    lastAssistantMessage: "Answer.",
  });
  assert.equal(result.ok, true);
  assert.equal(result.turn.sessionId, "dcode-session-identity");
});

test("Deep Agents transcript falls back to the latest user turn when prompt text is absent", () => {
  const transcript = jsonLines([
    record({ sequence: 0, role: "user", content: "First prompt." }),
    record({ sequence: 1, role: "assistant", content: "First answer." }),
    record({ sequence: 2, role: "user", content: "Second prompt with injected context." }),
    record({ sequence: 3, role: "assistant", content: "Second answer." }),
  ]);
  const result = deepAgentsTranscriptTurnFromJsonLines(transcript, {
    sessionId: SESSION_ID,
    promptId: PROMPT_ID,
    prompt: "not present verbatim",
    lastAssistantMessage: "Second answer from Stop.",
  });
  assert.equal(result.ok, true);
  assert.equal(result.turn.sessionTurnIndex, 2);
  assert.match(result.turn.userPrompt, /Second prompt/u);
});

test("Deep Agents interrupted turn uses the latest user turn and transcript assistant text", () => {
  const transcript = jsonLines([
    record({ sequence: 0, role: "user", content: "Interrupted prompt." }),
    record({ sequence: 1, role: "assistant", content: "Partial answer one." }),
    record({ sequence: 2, role: "assistant", content: "Partial answer two." }),
  ]);
  const result = deepAgentsInterruptedTranscriptTurnFromJsonLines(transcript, {
    sessionId: SESSION_ID,
    promptId: PROMPT_ID,
  });
  assert.equal(result.ok, true);
  assert.equal(result.turn.userPrompt, "Interrupted prompt.");
  assert.equal(result.turn.assistantReply, "Partial answer one.\n\nPartial answer two.");
  assert.equal(result.turn.sessionTurnIndex, 1);
});

test("Deep Agents transcript rejects malformed JSONL", () => {
  const result = deepAgentsTranscriptTurnFromJsonLines("{not-json}\n", {
    sessionId: SESSION_ID,
    promptId: PROMPT_ID,
    prompt: "Prompt.",
  });
  assert.deepEqual(result, {
    ok: false,
    reason: "transcript_unavailable",
    error: "Deep Agents transcript contains an invalid completed JSONL record.",
  });
});

test("Deep Agents transcript rejects a turn without assistant content", () => {
  const transcript = jsonLines([
    record({ sequence: 0, role: "user", content: "Prompt without answer." }),
  ]);
  const result = deepAgentsTranscriptTurnFromJsonLines(transcript, {
    sessionId: SESSION_ID,
    promptId: PROMPT_ID,
    prompt: "Prompt without answer.",
  });
  assert.deepEqual(result, { ok: false, reason: "assistant_message_missing" });
});
