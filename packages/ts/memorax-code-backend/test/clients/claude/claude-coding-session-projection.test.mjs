import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  claudeCodingSessionTurnFromJsonLines,
  claudeTranscriptTurnFromJsonLines,
  readClaudeArchiveSource,
  readClaudeCodingSessionTurn,
} from "../../../dist/clients/claude/transcript-turn.js";
import { materializePendingCodingSessionTurn, preparePendingCodingSessionTurn } from "../../../dist/coding-sessions/attachment.js";
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

test("Claude archive preserves selected text block boundaries and whitespace without changing QA", () => {
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

test("Claude archive retains scalar message text and only wraps explicit boolean tool errors", () => {
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

test("Claude archive materialization preserves text blocks, tool errors, and its frozen native digest", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "memorax-claude-projection-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const transcriptPath = join(root, "transcript.jsonl");
  const transcript = `${projectionTranscript()}\n`;
  await writeFile(transcriptPath, transcript);
  const result = await readClaudeCodingSessionTurn({ ...identity, transcriptPath });
  assert.equal(result.ok, true);
  const source = {
    client: "claude-code", sessionId: SESSION_ID, turnId: result.turn.nativeUserUuid,
    turnIndex: result.turn.sessionTurnIndex, outcome: "completed", closedAt,
    source: result.turn.source, items: result.turn.items,
  };
  const scope = { repositorySlug: "projection-tests" };
  const pending = preparePendingCodingSessionTurn(source, scope);
  assert.ok(pending);
  assert.equal("projectionVersion" in pending.reference, false);
  assert.equal(pending.reference.source.endBytes, Buffer.byteLength(transcript));
  await appendFile(transcriptPath, `${jsonLines([
    assistantRecord({ uuid: "later-final", parentUuid: "result", stopReason: "end_turn", content: "Later answer." }),
  ])}\n`);
  const reread = await readClaudeArchiveSource(pending.reference);
  assert.deepEqual(reread?.items, result.turn.items);
  assert.deepEqual(result.turn.items, claudeCodingSessionTurnFromJsonLines(transcript, identity).turn.items);
  assert.equal(reread?.closedAt, closedAt);
  const materialized = await materializePendingCodingSessionTurn(pending, scope, readClaudeArchiveSource);
  assert.ok(materialized);
  assert.deepEqual(materialized, prepareCodingSessionTurn({ ...source, repositorySlug: scope.repositorySlug }));
});

function siblingToolRecords(results = []) {
  return [
    userRecord({ uuid: "sibling-user", content: "Inspect one file." }),
    assistantRecord({ uuid: "sibling-call", parentUuid: "sibling-user", stopReason: "tool_use", content: [
      { type: "tool_use", id: "selected-call", name: "Read", input: { path: "sample.txt" } },
    ] }),
    ...results,
    assistantRecord({ uuid: "sibling-final", parentUuid: "sibling-call", stopReason: "end_turn", timestamp: closedAt, content: "Inspected the file." }),
  ];
}

function siblingResult(uuid, content, options = {}) {
  return userRecord({
    uuid, parentUuid: "sibling-call",
    content: [{ type: "tool_result", tool_use_id: "selected-call", content }],
    ...options,
  });
}

test("Claude archive includes a proven sibling tool result before the selected final", () => {
  const records = siblingToolRecords([
    siblingResult("sibling-result", "Selected output."),
    userRecord({ uuid: "unselected-result", parentUuid: "sibling-call", content: [
      { type: "tool_result", tool_use_id: "unknown-call", content: "Unknown output." },
    ] }),
  ]);
  const result = claudeCodingSessionTurnFromJsonLines(jsonLines(records), identity);
  assert.equal(result.ok, true);
  assert.deepEqual(result.turn.items.map((item) => item.type), ["message", "function_call", "function_call_output", "message"]);
  assert.deepEqual(result.turn.items[2], { type: "function_call_output", call_id: "selected-call", output: "Selected output." });
  assert.equal(result.turn.assistantReply, "Inspected the file.");
});

test("Claude archive cannot borrow tool results across prompts, system notifications, or sidechains", () => {
  const unrelated = [
    siblingResult("other-prompt-result", "Other prompt.", { promptId: "other-prompt", parentUuid: "other-user" }),
    { ...siblingResult("sidechain-result", "Sidechain output."), isSidechain: true },
    siblingResult("missing-parent-result", "Unproven parent.", { parentUuid: "missing-parent" }),
    userRecord({ uuid: "other-user", parentUuid: "sibling-call", promptId: "other-prompt", content: "Another human task." }),
    siblingResult("other-user-result", "Other human output.", { parentUuid: "other-user" }),
    userRecord({ uuid: "system-user", parentUuid: "sibling-call", origin: { kind: "task-notification" }, content: "Internal notification." }),
    siblingResult("system-result", "Notification output.", { parentUuid: "system-user" }),
    assistantRecord({ uuid: "other-branch-call", parentUuid: "sibling-call", stopReason: "tool_use", content: [
      { type: "tool_use", id: "other-call", name: "Read", input: {} },
    ] }),
    siblingResult("other-branch-result", "Alternative branch output.", { parentUuid: "other-branch-call" }),
  ];
  const result = claudeCodingSessionTurnFromJsonLines(jsonLines(siblingToolRecords(unrelated)), identity);
  assert.equal(result.ok, true);
  assert.equal(result.turn.items.filter((item) => item.type === "function_call_output").length, 0);
});

test("Claude archive coalesces identical result snapshots and omits conflicting outputs", () => {
  for (const [secondContent, expectedCount] of [["Selected output.", 1], ["Conflicting output.", 0]]) {
    const result = claudeCodingSessionTurnFromJsonLines(jsonLines(siblingToolRecords([
      siblingResult("result-one", "Selected output."),
      siblingResult("result-two", secondContent),
    ])), identity);
    assert.equal(result.ok, true);
    assert.equal(result.turn.items.filter((item) => item.type === "function_call_output").length, expectedCount);
  }
  const result = claudeCodingSessionTurnFromJsonLines(jsonLines(siblingToolRecords([
    siblingResult("result-conflict", "Selected output."),
    siblingResult("result-conflict", "Conflicting output."),
  ])), identity);
  assert.equal(result.ok, true);
  assert.equal(result.turn.items.filter((item) => item.type === "function_call_output").length, 0);
});

test("Claude archive does not collect a sibling result appended after its completed prefix", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "memorax-claude-sibling-boundary-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const transcriptPath = join(root, "transcript.jsonl");
  const transcript = jsonLines(siblingToolRecords([siblingResult("bounded-result", "Bounded output.")])) + "\n";
  await writeFile(transcriptPath, transcript);
  const result = await readClaudeCodingSessionTurn({ ...identity, transcriptPath });
  assert.equal(result.ok, true);
  const source = {
    client: "claude-code", sessionId: SESSION_ID, turnId: result.turn.nativeUserUuid,
    turnIndex: result.turn.sessionTurnIndex, outcome: "completed", closedAt,
    source: result.turn.source, items: result.turn.items,
  };
  const pending = preparePendingCodingSessionTurn(source, { repositorySlug: "sibling-tests" });
  assert.ok(pending);
  await appendFile(transcriptPath, jsonLines([siblingResult("late-result", "Later conflicting output.")]) + "\n");
  const reread = await readClaudeArchiveSource(pending.reference);
  assert.deepEqual(reread?.items, result.turn.items);
  assert.deepEqual(result.turn.items.find((item) => item.type === "function_call_output"), {
    type: "function_call_output", call_id: "selected-call", output: "Bounded output.",
  });
});

test("Claude archive keeps the proven result when an unrelated branch reuses its call id", () => {
  const result = claudeCodingSessionTurnFromJsonLines(jsonLines(siblingToolRecords([
    siblingResult("proven-result", "Selected output."),
    userRecord({ uuid: "other-prompt-human", promptId: "another-prompt", parentUuid: "sibling-call", content: "Another task." }),
    siblingResult("wrong-prompt-result", "Other prompt output.", { promptId: "another-prompt", parentUuid: "other-prompt-human" }),
    assistantRecord({ uuid: "unrelated-branch", parentUuid: "sibling-call", stopReason: null, content: "Off-branch work." }),
    siblingResult("wrong-branch-result", "Other branch output.", { parentUuid: "unrelated-branch" }),
  ])), identity);
  assert.equal(result.ok, true);
  assert.deepEqual(result.turn.items.filter((item) => item.type === "function_call_output"), [
    { type: "function_call_output", call_id: "selected-call", output: "Selected output." },
  ]);
});

test("Claude archive omits outputs for conflicting selected calls and error flags", () => {
  const records = siblingToolRecords([siblingResult("result", "Selected output.")]);
  records[1].message.content.push({ type: "tool_use", id: "selected-call", name: "Write", input: {} });
  const duplicateCall = claudeCodingSessionTurnFromJsonLines(jsonLines(records), identity);
  assert.equal(duplicateCall.ok, true);
  assert.equal(duplicateCall.turn.items.filter((item) => item.type === "function_call_output").length, 0);
  const first = siblingResult("first-result", "Selected output.");
  const second = siblingResult("second-result", "Selected output.");
  first.message.content[0].is_error = false;
  second.message.content[0].is_error = true;
  const conflictingError = claudeCodingSessionTurnFromJsonLines(jsonLines(siblingToolRecords([first, second])), identity);
  assert.equal(conflictingError.ok, true);
  assert.equal(conflictingError.turn.items.filter((item) => item.type === "function_call_output").length, 0);
});

test("Claude archive ignores conflicting result identities outside the selected call branch", () => {
  for (const parentUuid of ["missing-parent", "unselected-assistant"]) {
    const records = siblingToolRecords([
      siblingResult("proven-main-result", "Selected output."),
      assistantRecord({ uuid: "unselected-assistant", parentUuid: "sibling-call", stopReason: null, content: "Unselected work." }),
      siblingResult("unrelated-conflict", "Conflicting output one.", { parentUuid }),
      siblingResult("unrelated-conflict", "Conflicting output two.", { parentUuid }),
    ]);
    records.at(-1).parentUuid = "proven-main-result";
    const result = claudeCodingSessionTurnFromJsonLines(jsonLines(records), identity);
    assert.equal(result.ok, true);
    assert.deepEqual(result.turn.items.filter((item) => item.type === "function_call_output"), [
      { type: "function_call_output", call_id: "selected-call", output: "Selected output." },
    ]);
  }
});

test("Claude archive still omits a proven result when its call has a conflicting sibling identity", () => {
  const records = siblingToolRecords([
    siblingResult("proven-main-result", "Selected output."),
    siblingResult("related-conflict", "Conflicting output one."),
    siblingResult("related-conflict", "Conflicting output two."),
  ]);
  records.at(-1).parentUuid = "proven-main-result";
  const result = claudeCodingSessionTurnFromJsonLines(jsonLines(records), identity);
  assert.equal(result.ok, true);
  assert.equal(result.turn.items.filter((item) => item.type === "function_call_output").length, 0);
});

test("Claude archive preserves native record order when a proven result precedes its call", () => {
  const [prompt, call, result, terminal] = siblingToolRecords([siblingResult("selected-parent-result", "Selected output.")]);
  terminal.parentUuid = result.uuid;
  const transcript = jsonLines([prompt, result, call, terminal]);
  assert.equal(claudeTranscriptTurnFromJsonLines(transcript, identity).ok, true);
  const archive = claudeCodingSessionTurnFromJsonLines(transcript, identity);
  assert.equal(archive.ok, true);
  assert.deepEqual(archive.turn.items.map((item) => item.type), ["message", "function_call_output", "function_call", "message"]);
  assert.deepEqual(archive.turn.items[1], {
    type: "function_call_output", call_id: "selected-call", output: "Selected output.",
  });
});

test("Claude archive applies file-order bounds only to new sibling results", () => {
  const [prompt, call, selectedResult, terminal] = siblingToolRecords([siblingResult("selected-parent-result", "Selected output.")]);
  call.message.content.push({ type: "tool_use", id: "sibling-extra-call", name: "Read", input: {} });
  terminal.parentUuid = selectedResult.uuid;
  const sibling = (uuid, content) => userRecord({ uuid, parentUuid: call.uuid, content: [
    { type: "tool_result", tool_use_id: "sibling-extra-call", content },
  ] });
  const archive = claudeCodingSessionTurnFromJsonLines(jsonLines([
    prompt, selectedResult, sibling("too-early-sibling", "Early conflicting output."), call,
    sibling("proven-sibling", "Sibling output."), terminal,
  ]), identity);
  assert.equal(archive.ok, true);
  const { items } = archive.turn;
  const outputs = items.filter((item) => item.type === "function_call_output");
  assert.equal(outputs.length, 2);
  assert.equal(outputs.some((item) => item.output === "Early conflicting output."), false);
  assert.deepEqual(items.map((item) => [item.type, item.call_id]), [
    ["message", undefined],
    ["function_call_output", "selected-call"],
    ["function_call", "selected-call"],
    ["function_call", "sibling-extra-call"],
    ["function_call_output", "sibling-extra-call"],
    ["message", undefined],
  ]);
});

test("Claude archive uses native parents instead of rewritten tool result prompt labels", () => {
  const output = siblingResult("rewritten-result", "Selected output.");
  const transcript = jsonLines(siblingToolRecords([
    { ...output, promptId: "earlier-label", toolUseResult: { rendered: "first" } },
    { ...output, promptId: "later-label", toolUseResult: { rendered: "second" } },
  ]));
  const result = claudeCodingSessionTurnFromJsonLines(transcript, identity);
  assert.equal(result.ok, true);
  assert.deepEqual(result.turn.items.filter((item) => item.type === "function_call_output"), [
    { type: "function_call_output", call_id: "selected-call", output: "Selected output." },
  ]);
});


test("Claude archive keeps proven sibling outputs at their native positions", () => {
  const records = siblingToolRecords([
    assistantRecord({ uuid: "progress-after-call", parentUuid: "sibling-call", stopReason: null, content: "Waiting for the tool." }),
    siblingResult("delayed-sibling", "Selected output."),
  ]);
  records.at(-1).parentUuid = "progress-after-call";
  const transcript = jsonLines(records);
  const ordinary = claudeTranscriptTurnFromJsonLines(transcript, identity);
  const archive = claudeCodingSessionTurnFromJsonLines(transcript, identity);
  assert.equal(archive.ok, true);
  const { items, closedAt: _closedAt, ...qa } = archive.turn;
  assert.deepEqual(qa, ordinary.turn);
  assert.deepEqual(items.map((item) => [item.type, item.phase, item.call_id]), [
    ["message", undefined, undefined],
    ["function_call", undefined, "selected-call"],
    ["message", "commentary", undefined],
    ["function_call_output", undefined, "selected-call"],
    ["message", "final_answer", undefined],
  ]);
});

test("Claude archive keeps terminal text and tools interleaved without moving final text", () => {
  const transcript = jsonLines([
    userRecord({ uuid: "user", content: "Inspect the file." }),
    assistantRecord({ uuid: "terminal", parentUuid: "user", stopReason: "end_turn", content: [
      { type: "text", text: "  First final block.\n" },
      { type: "text", text: "Second final block." },
      { type: "tool_use", id: "terminal-call", name: "Read", input: { path: "sample.txt" } },
      { type: "text", text: "  Last final block.\n" },
    ] }),
  ]);
  const ordinary = claudeTranscriptTurnFromJsonLines(transcript, identity);
  const archive = claudeCodingSessionTurnFromJsonLines(transcript, identity);
  assert.equal(archive.ok, true);
  const { items, closedAt: _closedAt, ...qa } = archive.turn;
  assert.deepEqual(qa, ordinary.turn);
  assert.deepEqual(items, [
    { type: "message", role: "user", content: [{ type: "input_text", text: "Inspect the file." }] },
    { type: "message", role: "assistant", phase: "final_answer", content: [
      { type: "output_text", text: "  First final block.\n" },
      { type: "output_text", text: "Second final block." },
    ] },
    { type: "function_call", call_id: "terminal-call", name: "Read", arguments: '{"path":"sample.txt"}' },
    { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "  Last final block.\n" }] },
  ]);
});
