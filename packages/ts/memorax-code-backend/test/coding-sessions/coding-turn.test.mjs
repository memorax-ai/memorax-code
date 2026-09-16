import assert from "node:assert/strict";
import { homedir } from "node:os";
import { test } from "node:test";
import {
  CODING_TURN_MAX_BYTES,
  codingEventText,
  normalizeCodingSessionTurn,
} from "../../dist/coding-sessions/coding-turn.js";

test("coding Turn normalization preserves ordered tool evidence and redacts local data", () => {
  const turn = normalizeCodingSessionTurn({
    client: "codex",
    sessionId: "session-1",
    turnId: "turn-1",
    turnIndex: 1,
    events: [
      { type: "user_message", content: `Inspect ${homedir()}/private.` },
      {
        type: "tool_call",
        callId: "call-1",
        tool: "exec_command",
        arguments: codingEventText({ token: "sk-test-secret-1234567890", cmd: "npm test" }),
      },
      {
        type: "tool_result",
        callId: "call-1",
        status: "success",
        output: codingEventText({
          result: "tests passed",
          preview: "data:image/png;base64,AAAA",
        }),
      },
      { type: "assistant_message", phase: "final", content: "Done." },
    ],
    outcome: "completed",
    closedAt: "2026-08-30T08:00:00Z",
    repositorySlug: "memorax-code",
  });

  assert.ok(turn);
  assert.equal(turn.truncation, undefined);
  assert.deepEqual(turn.events.map((event) => [event.index, event.type]), [
    [1, "user_message"],
    [2, "tool_call"],
    [3, "tool_result"],
    [4, "assistant_message"],
  ]);
  assert.match(turn.events[0].content, /\[REDACTED:LOCAL_PATH\]\/private/);
  assert.equal(turn.events[1].arguments.startsWith('{"cmd":"npm test","token":'), true);
  assert.doesNotMatch(turn.events[1].arguments, /sk-test-secret/);
  assert.doesNotMatch(turn.events[2].output, /base64,AAAA/);
  assert.match(turn.events[2].output, /BINARY_CONTENT_OMITTED/);
});

test("coding Turn bounds keep QA and recent tool content with explicit loss metadata", () => {
  const source = {
    client: "codex",
    sessionId: "session-1",
    turnId: "turn-1",
    turnIndex: 1,
    events: [
      { type: "user_message", content: "Inspect the project." },
      ...Array.from({ length: 600 }, (_, index) => ({
        type: "tool_result", callId: `call-${index}`, status: "success", output: "Read file.",
      })),
      { type: "assistant_message", phase: "final", content: "Inspection complete." },
    ],
    outcome: "completed",
    closedAt: "2026-08-30T08:00:00Z",
  };
  const countBounded = normalizeCodingSessionTurn(source);
  assert.equal(countBounded.events.length, 512);
  assert.equal(countBounded.events[1].call_id, "call-90");
  assert.deepEqual(countBounded.truncation, {
    original_event_count: 602, truncated_text_fields: 0,
  });

  for (const event of source.events.slice(-5, -1)) event.output = "字\u0001".repeat(80_000);
  const byteBounded = normalizeCodingSessionTurn(source);
  assert.ok(Buffer.byteLength(JSON.stringify(byteBounded), "utf8") <= CODING_TURN_MAX_BYTES);
  assert.deepEqual(byteBounded.events.map((event) => [event.index, event.type]), [
    [1, "user_message"], [2, "tool_result"], [3, "tool_result"],
    [4, "tool_result"], [5, "tool_result"], [6, "assistant_message"],
  ]);
  assert.equal(byteBounded.events[1].call_id, "call-596");
  assert.ok(byteBounded.events[1].output.length < 128_000);
  assert.deepEqual(byteBounded.truncation, {
    original_event_count: 602, truncated_text_fields: 4,
  });
});

test("coding Turn byte budget includes large QA, escaped identities, and truncation metadata", () => {
  const turn = normalizeCodingSessionTurn({
    client: "codex",
    sessionId: '"'.repeat(255),
    turnId: "\\".repeat(255),
    turnIndex: Number.MAX_SAFE_INTEGER,
    events: [
      { type: "user_message", content: "中".repeat(160_000) },
      { type: "assistant_message", phase: "final", content: "完🙂\u0001".repeat(40_000) },
    ],
    outcome: "completed",
    closedAt: "2026-08-30T08:00:00Z",
    repositorySlug: "仓".repeat(255),
  });
  assert.ok(turn);
  assert.ok(Buffer.byteLength(JSON.stringify(turn), "utf8") <= CODING_TURN_MAX_BYTES);
  assert.equal(turn.events.length, 2);
  assert.ok(turn.events[0].content.startsWith("中"));
  assert.ok(turn.events[1].content.startsWith("完🙂"));
  assert.equal(turn.events[1].content.isWellFormed(), true);
  assert.deepEqual(turn.truncation, {
    original_event_count: 2, truncated_text_fields: 2,
  });
});
