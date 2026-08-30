import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  codeBuddyInterruptedTranscriptTurnFromJsonLines,
  codeBuddyTranscriptTurnFromJsonLines,
} from "../../../dist/clients/codebuddy/jsonl-history.js";

const sessionId = "session-1";
test("extracts hidden user query and completed assistant branch", () => {
  const lines = [
    { id: "u1", type: "message", role: "user", sessionId, content: [
      { type: "output_text", text: "<user_query>ignore this block</user_query>" },
      { type: "input_text", text: "<system-reminder>hidden</system-reminder><user_query>remember this</user_query>" },
    ] },
    { id: "c1", type: "function_call", role: "assistant", parentId: "u1", name: "Bash", arguments: "{}" },
    { id: "r1", type: "function_call_result", parentId: "c1", output: "ok" },
    { id: "a1", type: "message", role: "assistant", parentId: "r1", status: "completed", content: [
      { type: "input_text", text: "ignore this block" },
      { type: "output_text", text: "done" },
    ] },
  ].map(JSON.stringify).join("\n");
  const result = codeBuddyTranscriptTurnFromJsonLines(lines, { sessionId, turnId: provisionalTurnId("remember this") });
  assert.equal(result.ok, true);
  assert.equal(result.turn.userPrompt, "remember this");
  assert.equal(result.turn.assistantReply, "done");
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
    { id: "u1", type: "message", role: "user", sessionId, content: [{ type: "input_text", text: "repeat" }] },
    { id: "a1", type: "message", role: "assistant", parentId: "u1", status: "completed", content: [{ type: "output_text", text: "first" }] },
  ].map(JSON.stringify).join("\n") + "\n";
  const second = [
    { id: "u2", type: "message", role: "user", sessionId, content: [{ type: "input_text", text: "repeat" }] },
    { id: "a2", type: "message", role: "assistant", parentId: "u2", status: "completed", content: [{ type: "output_text", text: "second" }] },
  ].map(JSON.stringify).join("\n") + "\n";
  const result = codeBuddyTranscriptTurnFromJsonLines(first + second, {
    sessionId,
    turnId: provisionalTurnId("repeat", Buffer.byteLength(first, "utf8")),
  });
  assert.equal(result.ok, true);
  assert.equal(result.turn.assistantReply, "second");
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
  const first = [
    { id: "u1", type: "message", role: "user", sessionId, content: [{ type: "input_text", text: "重复" }] },
    { id: "a1", type: "message", role: "assistant", parentId: "u1", status: "completed", content: [{ type: "output_text", text: "第一轮" }] },
  ].map(JSON.stringify).join("\n") + "\n";
  const second = [
    { id: "u2", type: "message", role: "user", sessionId, content: [{ type: "input_text", text: "重复" }] },
    { id: "a2", type: "message", role: "assistant", parentId: "u2", status: "completed", content: [{ type: "output_text", text: "第二轮" }] },
  ].map(JSON.stringify).join("\n") + "\n";
  const result = codeBuddyTranscriptTurnFromJsonLines(first + second, {
    sessionId,
    turnId: provisionalTurnId("重复", Buffer.byteLength(first, "utf8")),
  });
  assert.equal(result.ok, true);
  assert.equal(result.turn.assistantReply, "第二轮");
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
