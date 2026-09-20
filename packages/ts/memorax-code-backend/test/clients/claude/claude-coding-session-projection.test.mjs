import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  claudeCodingSessionTurnFromJsonLines,
  claudeTranscriptTurnFromJsonLines,
  readClaudeArchiveSource,
  readClaudeCodingSessionTurn,
} from "../../../dist/clients/claude/transcript-turn.js";
import { prepareCodingSessionTurn } from "../../../dist/coding-sessions/coding-turn.js";
import { PROMPT_ID, SESSION_ID, assistantRecord, jsonLines, userRecord } from "./support/claude-transcript-fixtures.mjs";

const identity = { sessionId: SESSION_ID, promptId: PROMPT_ID };
const nativeToolText = ' \n{ "z": 2, "a": 1 }\t';
const closedAt = "2026-09-01T08:03:00.000Z";

function projectionTranscript() {
  return jsonLines([
    userRecord({ uuid: "user", content: [
      { type: "text", text: "\n  First request \t" },
      { type: "text", text: " \n" },
      { type: "image", source: {} },
      { type: "text", text: " second request  \n" },
    ] }),
    assistantRecord({ uuid: "progress", parentUuid: "user", stopReason: null, content: "  progress string \n" }),
    assistantRecord({ uuid: "call", parentUuid: "progress", stopReason: "tool_use", content: [
      { type: "text", text: " commentary block \t\n" },
      { type: "thinking", thinking: "private" },
      { type: "tool_use", id: "read-file", name: "Read", input: nativeToolText },
    ] }),
    userRecord({ uuid: "result", parentUuid: "call", content: [
      { type: "tool_result", tool_use_id: "read-file", content: nativeToolText, is_error: true },
    ] }),
    assistantRecord({ uuid: "final", parentUuid: "result", stopReason: "end_turn", timestamp: closedAt, content: [
      { type: "text", text: " \n final first \t" },
      { type: "thinking", thinking: "private" },
      { type: "text", text: "" },
      { type: "text", text: " final second \n" },
    ] }),
  ]);
}

test("Claude archive v2 preserves selected text block boundaries and whitespace without changing QA", () => {
  const transcript = projectionTranscript();
  const result = claudeCodingSessionTurnFromJsonLines(transcript, identity);
  assert.equal(result.ok, true);
  const { items, closedAt: archiveClosedAt, ...qa } = result.turn;
  assert.deepEqual(qa, claudeTranscriptTurnFromJsonLines(transcript, identity).turn);
  assert.equal(qa.userPrompt, "First request\n\nsecond request");
  assert.equal(qa.assistantReply, "final first\n\nfinal second");
  assert.equal(archiveClosedAt, closedAt);
  assert.deepEqual(items, [
    { type: "message", role: "user", content: [
      { type: "input_text", text: "\n  First request \t" },
      { type: "input_text", text: " \n" },
      { type: "input_text", text: " second request  \n" },
    ] },
    { type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "  progress string \n" }] },
    { type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: " commentary block \t\n" }] },
    { type: "function_call", call_id: "read-file", name: "Read", arguments: nativeToolText },
    { type: "function_call_output", call_id: "read-file", output: items[4].output },
    { type: "message", role: "assistant", phase: "final_answer", content: [
      { type: "output_text", text: " \n final first \t" },
      { type: "output_text", text: "" },
      { type: "output_text", text: " final second \n" },
    ] },
  ]);
  assert.deepEqual(JSON.parse(items[4].output), { content: nativeToolText, is_error: true });
});

test("Claude archive v2 retains scalar message text and only wraps explicit boolean tool errors", () => {
  for (const errorFlag of [true, false, undefined, "true"]) {
    const transcript = jsonLines([
      userRecord({ uuid: "user", content: "  Request \n" }),
      assistantRecord({ uuid: "call", parentUuid: "user", stopReason: "tool_use", content: [
        { type: "tool_use", id: "read-file", name: "Read", input: { path: "sample.txt" } },
      ] }),
      userRecord({ uuid: "result", parentUuid: "call", content: [
        { type: "tool_result", tool_use_id: "read-file", content: nativeToolText,
          ...(errorFlag === undefined ? {} : { is_error: errorFlag }) },
      ] }),
      assistantRecord({ uuid: "final", parentUuid: "result", stopReason: "end_turn", content: "  Answer \n" }),
    ]);
    const result = claudeCodingSessionTurnFromJsonLines(transcript, identity);
    assert.equal(result.ok, true);
    assert.equal(result.turn.items[0].content[0].text, "  Request \n");
    assert.equal(result.turn.items.at(-1).content[0].text, "  Answer \n");
    const output = result.turn.items.find((item) => item.type === "function_call_output");
    assert.ok(output);
    if (typeof errorFlag === "boolean") {
      assert.deepEqual(JSON.parse(output.output), { content: nativeToolText, is_error: errorFlag });
    } else {
      assert.equal(output.output, nativeToolText);
    }
  }
});

test("Claude archive v1 reproduces legacy items and the prepared cursor digest", () => {
  const result = claudeCodingSessionTurnFromJsonLines(projectionTranscript(), { ...identity, projectionVersion: 1 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.turn.items, [
    { type: "message", role: "user", content: [{ type: "input_text", text: "First request\n\nsecond request" }] },
    { type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "progress string" }] },
    { type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "commentary block" }] },
    { type: "function_call", call_id: "read-file", name: "Read", arguments: '{"a":1,"z":2}' },
    { type: "function_call_output", call_id: "read-file", output: '{"a":1,"z":2}' },
    { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "final first\n\nfinal second" }] },
  ]);
  const prepared = prepareCodingSessionTurn({
    client: "claude-code", sessionId: SESSION_ID, turnId: PROMPT_ID, turnIndex: result.turn.sessionTurnIndex,
    outcome: "completed", closedAt, items: result.turn.items,
  });
  assert.equal(createHash("sha256").update(JSON.stringify(prepared)).digest("hex"),
    "2ace2707b0d150a81ebed8cc8fbc1a5e6246d5d2e12ab0692be4e34b0b5b79f9");
  const { items, closedAt: _closedAt, ...qa } = result.turn;
  assert.deepEqual(qa, claudeTranscriptTurnFromJsonLines(projectionTranscript(), identity).turn);
});

test("Claude native archive reread uses the persisted projection version", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "memorax-claude-projection-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const transcriptPath = join(root, "transcript.jsonl");
  const transcript = `${projectionTranscript()}\n`;
  await writeFile(transcriptPath, transcript);
  for (const projectionVersion of [1, 2]) {
    const result = await readClaudeCodingSessionTurn({
      ...identity, transcriptPath, endBytes: Buffer.byteLength(transcript), projectionVersion,
    });
    assert.equal(result.ok, true);
    const reread = await readClaudeArchiveSource({
      client: "claude-code", sessionId: SESSION_ID, turnId: PROMPT_ID,
      turnIndex: result.turn.sessionTurnIndex, outcome: "completed", closedAt,
      source: result.turn.source, projectionVersion,
    });
    assert.deepEqual(reread?.items, result.turn.items);
    assert.deepEqual(result.turn.items,
      claudeCodingSessionTurnFromJsonLines(transcript, { ...identity, projectionVersion }).turn.items);
    assert.equal(reread?.closedAt, closedAt);
  }
});
