import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  codeBuddyInterruptedTranscriptTurnFromJsonLines,
  codeBuddyTranscriptTurnFromJsonLines,
  readCodeBuddyArchiveSource,
} from "../../../dist/clients/codebuddy/jsonl-history.js";
import { materializePendingCodingSessionTurn, preparePendingCodingSessionTurn } from "../../../dist/coding-sessions/attachment.js";
import { prepareCodingSessionTurn } from "../../../dist/coding-sessions/coding-turn.js";

const sessionId = "session-1";

test("archive projection preserves native text blocks and complete tool results without changing QA", async () => {
  const userContent = [{ type: "input_text", text: "  Read " }, { type: "input_text", text: "\nthese files. \n" }];
  const commentary = [{ type: "output_text", text: "  Checking. \n" }, { type: "output_text", text: "\nNext.  " }];
  const finalContent = [{ type: "output_text", text: " \nDone. " }, { type: "output_text", text: " See details.\n " }];
  const structuredOutput = { text: "  visible  ", exit_code: 1, detail: { reason: "unavailable" } };
  const arrayOutput = [{ type: "text", text: "text fragment" }, { type: "diagnostic", code: 7 }, 7, "literal", null];
  const transcript = [
    { id: "u1", type: "message", role: "user", sessionId, content: userContent },
    { id: "progress", type: "message", role: "assistant", parentId: "u1", content: commentary },
    { id: "c1", type: "function_call", parentId: "progress", callId: "call-1", name: "Read", arguments: '  {"b":2,"a":1}\n' },
    { id: "r1", type: "function_call_result", parentId: "c1", callId: "call-1", status: "error", output: structuredOutput },
    { id: "c2", type: "function_call", parentId: "r1", callId: "call-2", name: "Read", arguments: { file: "second" } },
    { id: "r2", type: "function_call_result", parentId: "c2", callId: "call-2", output: arrayOutput },
    { id: "c3", type: "function_call", parentId: "r2", callId: "call-3", name: "Read", arguments: "  raw arguments\n" },
    { id: "r3", type: "function_call_result", parentId: "c3", callId: "call-3", output: " \nraw result\t " },
    { id: "a1", type: "message", role: "assistant", parentId: "r3", status: "completed", content: finalContent },
  ].map(JSON.stringify).join("\n");
  const identity = { sessionId, turnId: provisionalTurnId("Read \n\nthese files.") };
  const ordinary = codeBuddyTranscriptTurnFromJsonLines(transcript, identity);
  const projected = codeBuddyTranscriptTurnFromJsonLines(transcript, { ...identity, captureCodingItems: true });
  assert.equal(projected.ok, true);
  const { items, ...qa } = projected.turn;
  assert.deepEqual(qa, ordinary.turn);
  assert.equal(qa.userPrompt, "Read \n\nthese files.");
  assert.equal(qa.assistantReply, "Done. \n See details.");
  assert.deepEqual(items[0], { type: "message", role: "user", content: userContent });
  assert.deepEqual(items[1], { type: "message", role: "assistant", phase: "commentary", content: commentary });
  assert.deepEqual(items.at(-1), { type: "message", role: "assistant", phase: "final_answer", content: finalContent });
  assert.deepEqual(items.filter((item) => item.type === "function_call"), [
    { type: "function_call", call_id: "call-1", name: "Read", arguments: '  {"b":2,"a":1}\n' },
    { type: "function_call", call_id: "call-2", name: "Read", arguments: '{"file":"second"}' },
    { type: "function_call", call_id: "call-3", name: "Read", arguments: "  raw arguments\n" },
  ]);
  const outputs = items.filter((item) => item.type === "function_call_output");
  assert.deepEqual(JSON.parse(outputs[0].output), { output: structuredOutput, status: "error" });
  assert.deepEqual(JSON.parse(outputs[1].output), arrayOutput);
  assert.deepEqual(outputs[2], { type: "function_call_output", call_id: "call-3", output: " \nraw result\t " });
  assert.equal(items.length, 9);
  const directory = await mkdtemp(join(tmpdir(), "memorax-codebuddy-projection-"));
  try {
    const transcriptPath = join(directory, "session.jsonl");
    await writeFile(transcriptPath, transcript);
    const scope = { repositorySlug: "projection-tests" };
    const sources = ["codebuddy", "workbuddy"].map((client) => ({
      ...identity, client, turnIndex: 1, closedAt: "2026-09-20T08:00:00.000Z", outcome: "completed",
      source: { transcriptPath, endBytes: Buffer.byteLength(transcript) }, items,
    }));
    const pendingTurns = sources.map((source) => preparePendingCodingSessionTurn(source, scope));
    await appendFile(transcriptPath, "\n" + [
      { id: "u2", type: "message", role: "user", sessionId, content: userContent },
      { id: "a2", type: "message", role: "assistant", parentId: "u2", status: "completed", content: "Later answer." },
    ].map(JSON.stringify).join("\n") + "\n");
    for (const [index, pending] of pendingTurns.entries()) {
      assert.ok(pending);
      assert.equal("projectionVersion" in pending.reference, false);
      assert.equal(pending.reference.source.endBytes, Buffer.byteLength(transcript));
      const restored = await readCodeBuddyArchiveSource(pending.reference);
      assert.deepEqual(restored.items, items);
      const materialized = await materializePendingCodingSessionTurn(pending, scope, readCodeBuddyArchiveSource);
      assert.ok(materialized);
      assert.deepEqual(materialized, prepareCodingSessionTurn({ ...sources[index], repositorySlug: scope.repositorySlug }));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("archive user text keeps original-input and cross-block user-query authority", () => {
  for (const { content, expected, prompt } of [
    {
      content: [
        { type: "input_text", text: "expanded instructions", providerData: { content: "  /memorax-code <user_query>literal</user_query> " } },
        { type: "input_text", text: "more expanded instructions", providerData: { content: "\n original continuation  " } },
        { type: "input_text", text: "display-only text must stay excluded" },
      ],
      expected: ["  /memorax-code <user_query>literal</user_query> ", "\n original continuation  "],
      prompt: "/memorax-code <user_query>literal</user_query> \n\n original continuation",
    },
    {
      content: [
        { type: "input_text", text: "hidden prefix<user_query>  first " },
        { type: "input_text", text: "" },
        { type: "input_text", text: "\n second  </user_query>hidden suffix" },
        { type: "output_text", text: "wrong role must stay excluded" },
      ],
      expected: ["  first ", "", "\n second  "],
      prompt: "first \n\n\n second",
    },
  ]) {
    const transcript = [
      { id: "u1", type: "message", role: "user", sessionId, content },
      { id: "a1", type: "message", role: "assistant", parentId: "u1", status: "completed", content: [{ type: "output_text", text: "done" }] },
    ].map(JSON.stringify).join("\n");
    const identity = { sessionId, turnId: provisionalTurnId(prompt) };
    const ordinary = codeBuddyTranscriptTurnFromJsonLines(transcript, identity);
    const archived = codeBuddyTranscriptTurnFromJsonLines(transcript, { ...identity, captureCodingItems: true });
    assert.equal(archived.ok, true);
    const { items, ...qa } = archived.turn;
    assert.deepEqual(qa, ordinary.turn);
    assert.equal(qa.userPrompt, prompt);
    assert.deepEqual(items[0], { type: "message", role: "user", content: expected.map((text) => ({ type: "input_text", text })) });
    assert.deepEqual(codeBuddyTranscriptTurnFromJsonLines(transcript, {
      ...identity, turnId: provisionalTurnId("expanded instructions"), captureCodingItems: true,
    }), { ok: false, reason: "user_prompt_missing" });
  }
});

test("extracts hidden user query and completed assistant branch", () => {
  const lines = [
    { id: "u1", type: "message", role: "user", sessionId, timestamp: "2026-09-07T08:00:00+08:00", content: [
      { type: "output_text", text: "<user_query>ignore this block</user_query>" },
      { type: "input_text", text: "<system-reminder>hidden</system-reminder><user_query>remember this</user_query>" },
    ] },
    { id: "c1", type: "function_call", role: "assistant", parentId: "u1", name: "Bash", arguments: "{}" },
    { id: "r1", type: "function_call_result", parentId: "c1", output: "ok" },
    { id: "a1", type: "message", role: "assistant", parentId: "r1", status: "completed", timestamp: "2026-09-07T00:05:00.000Z", content: [
      { type: "input_text", text: "ignore this block" },
      { type: "output_text", text: "done" },
    ] },
  ].map(JSON.stringify).join("\n");
  const result = codeBuddyTranscriptTurnFromJsonLines(lines, { sessionId, turnId: provisionalTurnId("remember this") });
  assert.equal(result.ok, true);
  assert.equal(result.turn.userPrompt, "remember this");
  assert.equal(result.turn.assistantReply, "done");
  assert.equal(result.turn.userTimestamp, Date.parse("2026-09-07T00:00:00.000Z"));
  assert.equal(result.turn.assistantTimestamp, Date.parse("2026-09-07T00:05:00.000Z"));
});

test("prefers native original input over expanded Skill content", () => {
  const prompt = "/memorax-code explain <user_query>literal tags</user_query>";
  const user = { id: "u1", type: "message", role: "user", sessionId, timestamp: 1_700_000_000_000, content: [
    { type: "output_text", text: "not user input", providerData: { content: "ignore this block" } },
    { type: "input_text", text: "<command-name>/memorax-code</command-name>\n# MemoraX Code\nExpanded instructions",
      providerData: { content: prompt } },
  ] };
  const assistant = { id: "a1", type: "message", role: "assistant", parentId: "u1",
    status: "completed", timestamp: 1_700_000_060_000,
    content: [{ type: "output_text", text: "done", providerData: { content: "not the reply" } }] };
  const input = { sessionId, turnId: provisionalTurnId(prompt) };
  const completed = codeBuddyTranscriptTurnFromJsonLines([user, assistant].map(JSON.stringify).join("\n"), input);
  assert.equal(completed.ok, true);
  assert.equal(completed.turn.userPrompt, prompt);
  assert.equal(completed.turn.assistantReply, "done");
  assert.equal(completed.turn.userTimestamp, user.timestamp);
  assert.equal(completed.turn.assistantTimestamp, assistant.timestamp);

  assistant.status = "incomplete";
  const transcript = [user, assistant].map(JSON.stringify).join("\n");
  assert.deepEqual(codeBuddyTranscriptTurnFromJsonLines(transcript, input), { ok: false, reason: "assistant_message_missing" });
  const interrupted = codeBuddyInterruptedTranscriptTurnFromJsonLines(transcript, input);
  assert.equal(interrupted.ok, true);
  assert.equal(interrupted.turn.userPrompt, prompt);
  assert.equal(interrupted.turn.assistantReply, "done");
});

test("does not fall back to displayed text when native original input is invalid or mismatched", () => {
  const prompt = "/memorax-code remember this";
  for (const original of ["another prompt", "", "   ", null, 42, [prompt], { text: prompt }]) {
    const transcript = [
      { id: "u1", type: "message", role: "user", sessionId, content: [
        { type: "input_text", text: prompt, providerData: { content: original } },
      ] },
      { id: "a1", type: "message", role: "assistant", parentId: "u1", status: "completed",
        content: [{ type: "output_text", text: "must not persist" }] },
    ].map(JSON.stringify).join("\n");
    assert.deepEqual(codeBuddyTranscriptTurnFromJsonLines(transcript, {
      sessionId, turnId: provisionalTurnId(prompt),
    }), { ok: false, reason: "user_prompt_missing" }, JSON.stringify(original));
  }
});

test("preserves completed and interrupted replies through a long tool chain", () => {
  const records = [
    { id: "u1", type: "message", role: "user", sessionId, content: [{ type: "input_text", text: "long task" }] },
  ];
  // Stay within the normal test budget even when a turn has thousands of records.
  const callCount = 1000;
  for (let index = 0; index < callCount; index += 1) {
    records.push(
      { id: `c${index}`, type: "function_call", role: "assistant", parentId: records.at(-1).id, callId: `call-${index}`, name: "Bash", arguments: "{}" },
      { id: `r${index}`, type: "function_call_result", parentId: `c${index}`, callId: `call-${index}`, output: `result ${index}` },
    );
  }
  const assistant = {
    id: "a1", type: "message", role: "assistant", parentId: records.at(-1).id,
    status: "completed", content: [{ type: "output_text", text: "done" }],
  };
  records.push(assistant);
  const input = { sessionId, turnId: provisionalTurnId("long task") };
  const transcript = records.map(JSON.stringify).join("\n");
  const startedAt = performance.now();
  const completed = codeBuddyTranscriptTurnFromJsonLines(transcript, { ...input, captureCodingItems: true });
  // Synchronous parsing can block the runner's timeout, so check elapsed time too.
  assert.ok(performance.now() - startedAt < 5000, "Long-chain extraction must avoid repeated transcript scans");
  assert.equal(completed.ok, true);
  assert.equal(completed.turn.userPrompt, "long task");
  assert.equal(completed.turn.assistantReply, "done");
  assert.equal(completed.turn.userTimestamp, undefined);
  assert.equal(completed.turn.assistantTimestamp, undefined);
  assert.equal(completed.turn.activities.length, callCount * 2);
  assert.equal(completed.turn.items.length, callCount * 2 + 2);
  assert.equal(completed.turn.items.at(-2).call_id, `call-${callCount - 1}`);

  assistant.status = "incomplete";
  assistant.content[0].text = "partial answer";
  const interrupted = codeBuddyInterruptedTranscriptTurnFromJsonLines(records.map(JSON.stringify).join("\n"), input);
  assert.equal(interrupted.ok, true);
  assert.equal(interrupted.turn.assistantReply, "partial answer");
  assert.equal(interrupted.turn.activities.length, callCount * 2);
});

test("preserves descendant activities and parsed order after duplicate replacement", () => {
  const records = [
    { id: "u1", type: "message", role: "user", sessionId, content: [{ type: "input_text", text: "branch task" }] },
    { id: "c1", type: "function_call", parentId: "u1", name: "Bash", arguments: "main" },
    { id: "r1", type: "function_call_result", parentId: "c1", output: "main result" },
    { id: "sibling", type: "function_call", parentId: "u1", name: "Read", arguments: "sibling" },
    { type: "function_call_result", parentId: "sibling", output: "sibling result" },
    { id: "replaced", type: "function_call", parentId: "u1", name: "stale" },
    { id: "a1", type: "message", role: "assistant", parentId: "r1", status: "completed", content: [{ type: "output_text", text: "done" }] },
    { id: "replaced", type: "function_call", parentId: "missing", name: "unrelated" },
  ];
  const result = codeBuddyTranscriptTurnFromJsonLines(records.map(JSON.stringify).join("\n"), {
    sessionId, turnId: provisionalTurnId("branch task"),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.turn.activities, [
    { kind: "tool", name: "tool", output: "sibling result" },
    { kind: "tool", name: "Bash", input: "main" },
    { kind: "tool", name: "tool", output: "main result" },
    { kind: "tool", name: "Read", input: "sibling" },
  ]);
});

test("rejects a completed reply whose parent chain cycles without reaching the user", () => {
  const lines = [
    { id: "u1", type: "message", role: "user", sessionId, content: [{ type: "input_text", text: "cyclic chain" }] },
    { id: "c1", type: "function_call", role: "assistant", parentId: "r1", name: "Bash", arguments: "{}" },
    { id: "r1", type: "function_call_result", parentId: "c1", output: "unrelated result" },
    { id: "a1", type: "message", role: "assistant", parentId: "r1", status: "completed", content: [{ type: "output_text", text: "must not persist" }] },
  ].map(JSON.stringify).join("\n");
  assert.deepEqual(codeBuddyTranscriptTurnFromJsonLines(lines, {
    sessionId, turnId: provisionalTurnId("cyclic chain"),
  }), { ok: false, reason: "assistant_message_missing" });
});

test("fails closed on cancelled incomplete assistant", () => {
  const lines = [
    { id: "u1", type: "message", role: "user", sessionId, content: [{ type: "input_text", text: "<user_query>cancel me</user_query>" }] },
    { id: "a1", type: "message", role: "assistant", parentId: "u1", status: "incomplete", content: [{ type: "output_text", text: "partial" }] },
  ].map(JSON.stringify).join("\n");
  assert.deepEqual(codeBuddyTranscriptTurnFromJsonLines(lines, { sessionId, turnId: provisionalTurnId("cancel me") }), { ok: false, reason: "assistant_message_missing" });
});

test("recovers an interrupted turn without assistant material", () => {
  const lines = [
    { id: "u1", type: "message", role: "user", sessionId, content: [{ type: "input_text", text: "<user_query>cancel before reply</user_query>" }] },
    { id: "c1", type: "function_call", parentId: "u1", name: "Bash", arguments: "{}" },
  ].map(JSON.stringify).join("\n");
  assert.deepEqual(
    codeBuddyInterruptedTranscriptTurnFromJsonLines(lines, {
      sessionId,
      turnId: provisionalTurnId("cancel before reply"),
    }),
    {
      ok: true,
      turn: {
        sessionId,
        turnId: provisionalTurnId("cancel before reply"),
        userPrompt: "cancel before reply",
        assistantReply: "",
        activities: [],
        sessionTurnIndex: 1,
      },
    },
  );
});

test("recovers the unique incomplete assistant branch", () => {
  const lines = [
    { id: "u1", type: "message", role: "user", sessionId, content: [{ type: "input_text", text: "cancel partial reply" }] },
    { id: "a1", type: "message", role: "assistant", parentId: "u1", status: "incomplete", content: [{ type: "output_text", text: "partial answer" }] },
  ].map(JSON.stringify).join("\n");
  const result = codeBuddyInterruptedTranscriptTurnFromJsonLines(lines, {
    sessionId,
    turnId: provisionalTurnId("cancel partial reply"),
  });
  assert.equal(result.ok, true);
  assert.equal(result.turn.assistantReply, "partial answer");
});

test("interrupted reader fails closed on completed, ambiguous, or malformed transcripts", () => {
  const user = { id: "u1", type: "message", role: "user", sessionId, content: [{ type: "input_text", text: "strict interruption" }] };
  const input = { sessionId, turnId: provisionalTurnId("strict interruption") };
  const completed = [
    user,
    { id: "a1", type: "message", role: "assistant", parentId: "u1", status: "completed", content: [{ type: "output_text", text: "done" }] },
  ].map(JSON.stringify).join("\n");
  const ambiguous = [
    user,
    { id: "a1", type: "message", role: "assistant", parentId: "u1", status: "incomplete", content: [{ type: "output_text", text: "one" }] },
    { id: "a2", type: "message", role: "assistant", parentId: "u1", status: "incomplete", content: [{ type: "output_text", text: "two" }] },
  ].map(JSON.stringify).join("\n");
  const malformed = `${JSON.stringify(user)}\n{not-json`;

  assert.deepEqual(codeBuddyInterruptedTranscriptTurnFromJsonLines(completed, input), { ok: false, reason: "turn_not_interrupted" });
  assert.deepEqual(codeBuddyInterruptedTranscriptTurnFromJsonLines(ambiguous, input), { ok: false, reason: "turn_ambiguous" });
  assert.deepEqual(codeBuddyInterruptedTranscriptTurnFromJsonLines(malformed, input), { ok: false, reason: "malformed_transcript" });
});

test("fails closed on two completed branches", () => {
  const lines = [
    { id: "u1", type: "message", role: "user", sessionId, content: [{ type: "input_text", text: "<user_query>fork</user_query>" }] },
    { id: "a1", type: "message", role: "assistant", parentId: "u1", status: "completed", content: [{ type: "output_text", text: "one" }] },
    { id: "a2", type: "message", role: "assistant", parentId: "u1", status: "completed", content: [{ type: "output_text", text: "two" }] },
  ].map(JSON.stringify).join("\n");
  assert.deepEqual(codeBuddyTranscriptTurnFromJsonLines(lines, { sessionId, turnId: provisionalTurnId("fork") }), { ok: false, reason: "turn_ambiguous" });
});

test("uses the provisional transcript boundary for repeated prompts", () => {
  const first = [
    { id: "u1", type: "message", role: "user", sessionId, timestamp: 1_700_000_000_000, content: [{ type: "input_text", text: "repeat" }] },
    { id: "a1", type: "message", role: "assistant", parentId: "u1", status: "completed", timestamp: 1_700_000_060_000, content: [{ type: "output_text", text: "first" }] },
  ].map(JSON.stringify).join("\n") + "\n";
  const second = [
    { id: "u2", type: "message", role: "user", sessionId, timestamp: 1_700_000_300_000, content: [{ type: "input_text", text: "repeat" }] },
    { id: "a2", type: "message", role: "assistant", parentId: "u2", status: "completed", timestamp: 1_700_000_420_000, content: [{ type: "output_text", text: "second" }] },
  ].map(JSON.stringify).join("\n") + "\n";
  const result = codeBuddyTranscriptTurnFromJsonLines(first + second, {
    sessionId,
    turnId: provisionalTurnId("repeat", Buffer.byteLength(first, "utf8")),
  });
  assert.equal(result.ok, true);
  assert.equal(result.turn.assistantReply, "second");
  assert.equal(result.turn.userTimestamp, 1_700_000_300_000);
  assert.equal(result.turn.assistantTimestamp, 1_700_000_420_000);
});

test("does not accept session-less user records when session markers exist", () => {
  const lines = [
    { id: "other", type: "message", role: "user", sessionId: "other-session", content: [{ type: "input_text", text: "same" }] },
    { id: "other-a", type: "message", role: "assistant", parentId: "other", status: "completed", content: [{ type: "output_text", text: "wrong" }] },
    { id: "unknown", type: "message", role: "user", content: [{ type: "input_text", text: "same" }] },
  ].map(JSON.stringify).join("\n");
  assert.deepEqual(codeBuddyTranscriptTurnFromJsonLines(lines, { sessionId, turnId: provisionalTurnId("same") }), { ok: false, reason: "user_prompt_missing" });
});

test("requires an exact session marker on the selected user record", () => {
  const lines = [
    { id: "u1", type: "message", role: "user", content: [{ type: "input_text", text: "sessionless" }] },
    { id: "a1", type: "message", role: "assistant", parentId: "u1", status: "completed", content: [{ type: "output_text", text: "must not persist" }] },
  ].map(JSON.stringify).join("\n");
  assert.deepEqual(codeBuddyTranscriptTurnFromJsonLines(lines, {
    sessionId,
    turnId: provisionalTurnId("sessionless"),
  }), { ok: false, reason: "user_prompt_missing" });
});

test("requires native parentId lineage for the completed assistant", () => {
  const lines = [
    { id: "u1", type: "message", role: "user", sessionId, content: [{ type: "input_text", text: "lineage" }] },
    { id: "a1", type: "message", role: "assistant", logicalParentId: "u1", status: "completed", content: [{ type: "output_text", text: "must not persist" }] },
  ].map(JSON.stringify).join("\n");
  assert.deepEqual(codeBuddyTranscriptTurnFromJsonLines(lines, {
    sessionId,
    turnId: provisionalTurnId("lineage"),
  }), { ok: false, reason: "assistant_message_missing" });
});

test("fails closed on malformed JSONL instead of using a partial transcript", () => {
  const lines = [
    JSON.stringify({ id: "u1", type: "message", role: "user", sessionId, content: [{ type: "input_text", text: "partial" }] }),
    "{not-json",
    JSON.stringify({ id: "a1", type: "message", role: "assistant", parentId: "u1", status: "completed", content: [{ type: "output_text", text: "should not persist" }] }),
  ].join("\n");
  assert.deepEqual(codeBuddyTranscriptTurnFromJsonLines(lines, { sessionId, turnId: provisionalTurnId("partial") }), { ok: false, reason: "malformed_transcript" });
});

test("uses UTF-8 byte boundaries when a repeated prompt follows non-ASCII history", () => {
  for (const [newline, originalInput] of [["\n", false], ["\r\n", false], ["\n", true], ["\r\n", true]]) {
    const first = [
      { id: "u1", type: "message", role: "user", sessionId, content: [{ type: "input_text", text: "重复" }] },
      { id: "a1", type: "message", role: "assistant", parentId: "u1", status: "completed", content: [{ type: "output_text", text: "第一轮" }] },
    ].map(JSON.stringify).join(newline) + newline;
    const second = [
      { id: "u2", type: "message", role: "user", sessionId, content: [{ type: "input_text",
        text: originalInput ? "<command-name>/memorax-code</command-name>expanded" : "重复",
        ...(originalInput ? { providerData: { content: "重复" } } : {}),
      }] },
      { id: "a2", type: "message", role: "assistant", parentId: "u2", status: "completed", content: [{ type: "output_text", text: "第二轮" }] },
    ].map(JSON.stringify).join(newline) + newline;
    const boundary = Buffer.byteLength(first, "utf8");
    const result = codeBuddyTranscriptTurnFromJsonLines(first + second, {
      sessionId,
      turnId: provisionalTurnId("重复", boundary),
    });
    assert.equal(result.ok, true);
    assert.equal(result.turn.assistantReply, "第二轮");
    assert.deepEqual(codeBuddyTranscriptTurnFromJsonLines(first + second, {
      sessionId,
      turnId: provisionalTurnId("重复", boundary + 1),
    }), { ok: false, reason: "user_prompt_missing" }, "records before the exact byte boundary must stay excluded");
  }
});

test("rejects a prompt materialized before the provisional boundary", () => {
  const lines = [
    { id: "u1", type: "message", role: "user", sessionId, content: [{ type: "input_text", text: "race" }] },
    { id: "a1", type: "message", role: "assistant", parentId: "u1", status: "completed", content: [{ type: "output_text", text: "done" }] },
  ].map(JSON.stringify).join("\n") + "\n";
  assert.deepEqual(codeBuddyTranscriptTurnFromJsonLines(lines, {
    sessionId,
    turnId: provisionalTurnId("race", Buffer.byteLength(lines, "utf8")),
  }), { ok: false, reason: "user_prompt_missing" });
});

test("fails closed on malformed, cross-session, or prompt-mismatched provisional turn IDs", () => {
  const lines = [
    { id: "u1", type: "message", role: "user", sessionId, content: [{ type: "input_text", text: "identity" }] },
    { id: "a1", type: "message", role: "assistant", parentId: "u1", status: "completed", content: [{ type: "output_text", text: "done" }] },
  ].map(JSON.stringify).join("\n");
  for (const [turnId, reason] of [
    ["malformed", "turn_not_found"],
    [`${sessionId}:00:${promptDigest("identity")}`, "turn_not_found"],
    [provisionalTurnId("identity", 0, "other-session"), "turn_not_found"],
    [provisionalTurnId("different prompt"), "user_prompt_missing"],
  ]) {
    assert.deepEqual(codeBuddyTranscriptTurnFromJsonLines(lines, { sessionId, turnId }), { ok: false, reason });
  }
});

test("fails closed when more than one matching user follows the boundary", () => {
  const lines = [
    { id: "u1", type: "message", role: "user", sessionId, content: [{ type: "input_text", text: "repeat" }] },
    { id: "a1", type: "message", role: "assistant", parentId: "u1", status: "completed", content: [{ type: "output_text", text: "first" }] },
    { id: "u2", type: "message", role: "user", sessionId, content: [{ type: "input_text", text: "repeat" }] },
    { id: "a2", type: "message", role: "assistant", parentId: "u2", status: "completed", content: [{ type: "output_text", text: "second" }] },
  ].map(JSON.stringify).join("\n");
  assert.deepEqual(codeBuddyTranscriptTurnFromJsonLines(lines, {
    sessionId,
    turnId: provisionalTurnId("repeat"),
  }), { ok: false, reason: "turn_ambiguous" });
});

function provisionalTurnId(prompt, boundary = 0, targetSessionId = sessionId) {
  return `${targetSessionId}:${boundary}:${promptDigest(prompt)}`;
}

function promptDigest(prompt) {
  return createHash("sha256").update(prompt.trim()).digest("hex");
}
