import assert from "node:assert/strict";
import { homedir } from "node:os";
import { test } from "node:test";
import {
  CODING_TURN_MAX_BYTES,
  codingEventText,
  prepareCodingSessionTurn,
} from "../../dist/coding-sessions/coding-turn.js";

test("session Items retain their wire shape and redact local data", () => {
  const turn = prepareCodingSessionTurn({
    client: "codex",
    sessionId: "session-1",
    turnId: "turn-1",
    turnIndex: 1,
    items: [
      { type: "message", role: "user", content: [{ type: "input_text", text: `Inspect ${homedir()}/private.` }] },
      {
        type: "function_call",
        call_id: "call-1",
        name: "exec_command",
        arguments: codingEventText({ token: "sk-test-secret-1234567890", cmd: "npm test" }),
      },
      {
        type: "function_call_output",
        call_id: "call-1",
        output: codingEventText({
          result: "tests passed",
          preview: "data:image/png;base64,AAAA",
        }),
      },
      { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "Done." }] },
    ],
    outcome: "completed",
    closedAt: "2026-08-30T08:00:00Z",
    repositorySlug: "memorax-code",
  });

  assert.ok(turn);
  assert.equal(turn.truncation, undefined);
  assert.deepEqual(turn.items.map((item) => item.type), ["message", "function_call", "function_call_output", "message"]);
  assert.match(turn.items[0].content[0].text, /\[REDACTED:LOCAL_PATH\]\/private/);
  assert.equal(turn.items[1].arguments.startsWith('{"cmd":"npm test","token":'), true);
  assert.doesNotMatch(turn.items[1].arguments, /sk-test-secret/);
  assert.doesNotMatch(turn.items[2].output, /base64,AAAA/);
  assert.match(turn.items[2].output, /BINARY_CONTENT_OMITTED/);
});

test("native text blocks and tool strings retain formatting without retaining binary attachments", () => {
  const content = ["```", "\n", "const answer = 42;", "\n```"].map((text) => ({ type: "output_text", text }));
  const argumentsText = ' { "z": 1, "a": 2 }\n';
  const turn = prepareCodingSessionTurn({
    client: "codex", sessionId: "session-1", turnId: "turn-1", turnIndex: 1,
    outcome: "completed", closedAt: "2026-08-30T08:00:00Z",
    items: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "Inspect the project." }] },
      { type: "function_call", call_id: "call-1", name: "inspect", arguments: argumentsText },
      {
        type: "function_call_output", call_id: "call-1",
        output: JSON.stringify({
          result: "ok", preview: "data:image/png;base64,AAAA",
          buffer: { type: "Buffer", data: [1, 2, 3] },
          attachment: { type: "audio", data: "AAAA" },
        }),
      },
      { type: "message", role: "assistant", phase: "final_answer", content },
    ],
  });
  assert.ok(turn);
  assert.equal(turn.items[1].arguments, argumentsText);
  assert.deepEqual(JSON.parse(turn.items[2].output), {
    result: "ok", preview: "[BINARY_CONTENT_OMITTED]", buffer: "[BINARY_CONTENT_OMITTED]",
    attachment: { type: "audio", data: "[BINARY_CONTENT_OMITTED]" },
  });
  assert.deepEqual(turn.items[3].content, content);
  assert.equal(turn.truncation, undefined);
});

test("truncation metadata counts each native text block only once", () => {
  const turn = prepareCodingSessionTurn({
    client: "codex", sessionId: "session-1", turnId: "turn-1", turnIndex: 1,
    outcome: "completed", closedAt: "2026-08-30T08:00:00Z",
    items: [
      {
        type: "message", role: "user", content: [
          { type: "input_text", text: "a".repeat(128_001) },
          { type: "input_text", text: "b".repeat(128_001) },
        ],
      },
      { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "Done." }] },
    ],
  });
  assert.deepEqual(turn.truncation, { original_item_count: 2, truncated_text_fields: 2 });
  assert.deepEqual(turn.items[0].content.map((part) => part.text.length), [128_000, 128_000]);
});

test("coding Turn bounds keep QA and recent tool content with explicit loss metadata", () => {
  const source = {
    client: "codex",
    sessionId: "session-1",
    turnId: "turn-1",
    turnIndex: 1,
    items: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "Inspect the project." }] },
      ...Array.from({ length: 600 }, (_, index) => ({
        type: "function_call_output", call_id: `call-${index}`, output: "Read file.",
      })),
      { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "Inspection complete." }] },
    ],
    outcome: "completed",
    closedAt: "2026-08-30T08:00:00Z",
  };
  const countBounded = prepareCodingSessionTurn(source);
  assert.equal(countBounded.items.length, 512);
  assert.equal(countBounded.items[1].call_id, "call-90");
  assert.deepEqual(countBounded.truncation, {
    original_item_count: 602, truncated_text_fields: 0,
  });

  for (const item of source.items.slice(-5, -1)) item.output = "字\u0001".repeat(80_000);
  const byteBounded = prepareCodingSessionTurn(source);
  assert.ok(Buffer.byteLength(JSON.stringify(byteBounded), "utf8") <= CODING_TURN_MAX_BYTES);
  assert.deepEqual(byteBounded.items.map((item) => item.type), [
    "message", "function_call_output", "function_call_output",
    "function_call_output", "function_call_output", "message",
  ]);
  assert.equal(byteBounded.items[1].call_id, "call-596");
  assert.ok(byteBounded.items[1].output.length < 128_000);
  assert.deepEqual(byteBounded.truncation, {
    original_item_count: 602, truncated_text_fields: 4,
  });
});

test("coding Turn byte budget includes large QA, escaped identities, and truncation metadata", () => {
  const turn = prepareCodingSessionTurn({
    client: "codex",
    sessionId: '"'.repeat(255),
    turnId: "\\".repeat(255),
    turnIndex: Number.MAX_SAFE_INTEGER,
    items: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "中".repeat(160_000) }] },
      { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "完🙂\u0001".repeat(40_000) }] },
    ],
    outcome: "completed",
    closedAt: "2026-08-30T08:00:00Z",
    repositorySlug: "仓".repeat(255),
  });
  assert.ok(turn);
  assert.ok(Buffer.byteLength(JSON.stringify(turn), "utf8") <= CODING_TURN_MAX_BYTES);
  assert.equal(turn.items.length, 2);
  assert.ok(turn.items[0].content[0].text.startsWith("中"));
  assert.ok(turn.items[1].content[0].text.startsWith("完🙂"));
  assert.equal(turn.items[1].content[0].text.isWellFormed(), true);
  assert.deepEqual(turn.truncation, {
    original_item_count: 2, truncated_text_fields: 2,
  });
});
