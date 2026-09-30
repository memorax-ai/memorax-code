import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  codeBuddyInterruptedTranscriptTurnFromJsonLines,
  codeBuddyTranscriptTurnFromJsonLines,
  readCodeBuddyInterruptedTranscriptTurn,
  readCodeBuddyTranscriptTurn,
} from "../../../dist/clients/codebuddy/jsonl-history.js";

const sessionId = "session-1";
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

test("CodeBuddy matches native Hook line-break removal without changing completed or interrupted content", () => {
  for (const newline of ["\n", "\r\n", "\r"]) {
    const prompt = `First caf\u00e9 paragraph.${newline}${newline}  Second\tparagraph.`;
    const input = { sessionId, turnId: provisionalTurnId("First caf\u00e9 paragraph.  Second\tparagraph.") };
    for (const client of [undefined, "codebuddy"]) {
      for (const [status, parse] of transcriptReaders()) {
        for (const source of ["plain", "wrapped", "original"]) {
          const records = turnRecords(prompt, "1", status);
          const block = records[0].content[0];
          if (source === "wrapped") block.text = `<system-reminder>hidden</system-reminder><user_query>${prompt}</user_query>`;
          if (source === "original") {
            block.text = "Expanded Skill instructions must not become the prompt.";
            block.providerData = { content: prompt };
          }
          const result = parse(records.map(JSON.stringify).join("\n"), { ...input, client });
          assert.equal(result.ok, true, `${client ?? "default"}/${status}/${source}/${JSON.stringify(newline)}`);
          assert.equal(result.turn.userPrompt, prompt);
          assert.equal(result.turn.assistantReply, "Reply\nwith paragraphs.");
          assert.equal(result.turn.turnId, input.turnId);
        }
      }
    }
  }
});

test("retains exact multiline prompt matching for CodeBuddy and WorkBuddy", () => {
  const prompt = "First paragraph.\n\nSecond paragraph.";
  for (const client of ["codebuddy", "workbuddy"]) {
    for (const [status, parse] of transcriptReaders()) {
      const result = parse(turnRecords(prompt, "1", status).map(JSON.stringify).join("\n"), {
        sessionId, client, turnId: provisionalTurnId(prompt),
      });
      assert.equal(result.ok, true, `${client}/${status}`);
      assert.equal(result.turn.userPrompt, prompt);
    }
  }
});

test("does not enable CodeBuddy line-break compatibility for WorkBuddy", () => {
  for (const [status, parse] of transcriptReaders()) {
    assert.deepEqual(parse(turnRecords("first\nsecond", "1", status).map(JSON.stringify).join("\n"), {
      sessionId, client: "workbuddy", turnId: provisionalTurnId("firstsecond"),
    }), { ok: false, reason: "user_prompt_missing" });
  }
});

test("multiple input_text blocks keep exact matching without a flattened fallback", () => {
  for (const [extra, prompt] of [
    [{ type: "input_text", text: "c\nd" }, "a\nb\nc\nd"],
    [{ type: "input_text", text: "" }, "a\nb"],
    [{ type: "input_text", text: 42 }, "a\nb"],
    [{ type: "input_text" }, "a\nb"],
  ]) {
    for (const [status, parse] of transcriptReaders()) {
      const records = turnRecords("a\nb", "1", status);
      records[0].content.push(extra);
      const transcript = records.map(JSON.stringify).join("\n");
      const exact = parse(transcript, { sessionId, turnId: provisionalTurnId(prompt) });
      assert.equal(exact.ok, true);
      assert.equal(exact.turn.userPrompt, prompt);
      assert.deepEqual(parse(transcript, { sessionId, turnId: provisionalTurnId(prompt.replace(/\r\n|\r|\n/g, "")) }),
        { ok: false, reason: "user_prompt_missing" });
    }
  }
});

test("line-break compatibility keeps the exact UTF-8 boundary and excludes earlier collisions", () => {
  for (const newline of ["\n", "\r\n"]) {
    for (const [status, parse] of transcriptReaders()) {
      const first = turnRecords("caf\u00e9ab", "1", status).map(JSON.stringify).join(newline) + newline;
      const second = turnRecords("caf\u00e9a\nb", "2", status).map(JSON.stringify).join(newline) + newline;
      const boundary = Buffer.byteLength(first, "utf8");
      const result = parse(first + second, { sessionId, turnId: provisionalTurnId("caf\u00e9ab", boundary) });
      assert.equal(result.ok, true);
      assert.equal(result.turn.userPrompt, "caf\u00e9a\nb");
      assert.equal(result.turn.sessionTurnIndex, 2);
      assert.deepEqual(parse(first + second, { sessionId, turnId: provisionalTurnId("caf\u00e9ab", boundary + 1) }),
        { ok: false, reason: "user_prompt_missing" });
      assert.deepEqual(parse(first + second, { sessionId, turnId: provisionalTurnId("caf\u00e9ab") }),
        { ok: false, reason: "turn_ambiguous" });
    }
  }
});

test("rejects every ambiguous union of exact and line-break-normalized candidates", () => {
  for (const prompts of [["ab", "a\nb"], ["a\nb", "ab"], ["a\nb", "a\r\nb"]]) {
    for (const [status, parse] of transcriptReaders()) {
      const records = prompts.flatMap((prompt, index) => turnRecords(prompt, String(index), status));
      assert.deepEqual(parse(records.map(JSON.stringify).join("\n"), {
        sessionId, turnId: provisionalTurnId("ab"),
      }), { ok: false, reason: "turn_ambiguous" }, `${status}/${JSON.stringify(prompts)}`);
    }
  }
});

test("line-break compatibility does not remove spaces, tabs, or Unicode line separators", () => {
  for (const [status, parse] of transcriptReaders()) {
    const records = turnRecords("alpha \n beta\tgamma\u2028delta", "1", status).map(JSON.stringify).join("\n");
    const valid = parse(records, { sessionId, turnId: provisionalTurnId("alpha  beta\tgamma\u2028delta") });
    assert.equal(valid.ok, true);
    for (const wrong of ["alpha beta\tgamma\u2028delta", "alpha  beta gamma\u2028delta", "alpha  beta\tgammadelta"]) {
      assert.deepEqual(parse(records, { sessionId, turnId: provisionalTurnId(wrong) }),
        { ok: false, reason: "user_prompt_missing" }, wrong);
    }
  }
});

test("line-break compatibility still requires the matching native session", () => {
  for (const [status, parse] of transcriptReaders()) {
    const foreign = turnRecords("a\nb", "foreign", status, "other-session");
    const input = { sessionId, turnId: provisionalTurnId("ab") };
    assert.deepEqual(parse(foreign.map(JSON.stringify).join("\n"), input), { ok: false, reason: "user_prompt_missing" });
    const result = parse([...foreign, ...turnRecords("a\rb", "local", status)].map(JSON.stringify).join("\n"), input);
    assert.equal(result.ok, true);
    assert.equal(result.turn.userPrompt, "a\rb");
  }
});

test("file readers propagate the client-specific multiline matching contract", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "memorax-codebuddy-transcript-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const transcriptPath = join(root, "session.jsonl");
  for (const [status, read] of [["completed", readCodeBuddyTranscriptTurn], ["incomplete", readCodeBuddyInterruptedTranscriptTurn]]) {
    await writeFile(transcriptPath, turnRecords("first\nsecond", "1", status).map(JSON.stringify).join("\n"));
    const input = { transcriptPath, sessionId, turnId: provisionalTurnId("firstsecond") };
    const result = await read({ ...input, client: "codebuddy" });
    assert.equal(result.ok, true);
    assert.equal(result.turn.userPrompt, "first\nsecond");
    assert.deepEqual(await read({ ...input, client: "workbuddy" }), { ok: false, reason: "user_prompt_missing" });
  }
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
      { id: `c${index}`, type: "function_call", role: "assistant", parentId: records.at(-1).id, name: "Bash", arguments: "{}" },
      { id: `r${index}`, type: "function_call_result", parentId: `c${index}`, output: `result ${index}` },
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
  const completed = codeBuddyTranscriptTurnFromJsonLines(transcript, input);
  // Synchronous parsing can block the runner's timeout, so check elapsed time too.
  assert.ok(performance.now() - startedAt < 5000, "Long-chain extraction must avoid repeated transcript scans");
  assert.equal(completed.ok, true);
  assert.equal(completed.turn.userPrompt, "long task");
  assert.equal(completed.turn.assistantReply, "done");
  assert.equal(completed.turn.userTimestamp, undefined);
  assert.equal(completed.turn.assistantTimestamp, undefined);
  assert.equal(completed.turn.activities.length, callCount * 2);

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

function transcriptReaders() {
  return [["completed", codeBuddyTranscriptTurnFromJsonLines], ["incomplete", codeBuddyInterruptedTranscriptTurnFromJsonLines]];
}

function turnRecords(prompt, id, status, targetSessionId = sessionId) {
  return [
    { id: `u-${id}`, type: "message", role: "user", sessionId: targetSessionId, content: [{ type: "input_text", text: prompt }] },
    { id: `a-${id}`, type: "message", role: "assistant", sessionId: targetSessionId, parentId: `u-${id}`, status,
      content: [{ type: "output_text", text: "Reply\nwith paragraphs." }] },
  ];
}
