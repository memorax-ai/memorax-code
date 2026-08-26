import test from "node:test";
import assert from "node:assert/strict";
import { codeBuddyTranscriptTurnFromJsonLines } from "../../../dist/clients/codebuddy/jsonl-history.js";

const sessionId = "session-1";
test("extracts hidden user query and completed assistant branch", () => {
  const lines = [
    { id: "u1", type: "message", role: "user", sessionId, content: [{ type: "input_text", text: "<system-reminder>hidden</system-reminder><user_query>remember this</user_query>" }] },
    { id: "c1", type: "function_call", role: "assistant", parentId: "u1", name: "Bash", arguments: "{}" },
    { id: "r1", type: "function_call_result", parentId: "c1", output: "ok" },
    { id: "a1", type: "message", role: "assistant", parentId: "r1", status: "completed", content: [{ type: "output_text", text: "done" }] },
  ].map(JSON.stringify).join("\n");
  const result = codeBuddyTranscriptTurnFromJsonLines(lines, { sessionId, turnId: "t1", prompt: "remember this" });
  assert.equal(result.ok, true);
  assert.equal(result.turn.userPrompt, "remember this");
  assert.equal(result.turn.assistantReply, "done");
});

test("fails closed on cancelled incomplete assistant", () => {
  const lines = [
    { id: "u1", type: "message", role: "user", sessionId, content: [{ type: "input_text", text: "<user_query>cancel me</user_query>" }] },
    { id: "a1", type: "message", role: "assistant", parentId: "u1", status: "incomplete", content: [{ type: "output_text", text: "partial" }] },
  ].map(JSON.stringify).join("\n");
  assert.deepEqual(codeBuddyTranscriptTurnFromJsonLines(lines, { sessionId, turnId: "t1", prompt: "cancel me" }), { ok: false, reason: "assistant_message_missing" });
});

test("fails closed on two completed branches", () => {
  const lines = [
    { id: "u1", type: "message", role: "user", sessionId, content: [{ type: "input_text", text: "<user_query>fork</user_query>" }] },
    { id: "a1", type: "message", role: "assistant", parentId: "u1", status: "completed", content: [{ type: "output_text", text: "one" }] },
    { id: "a2", type: "message", role: "assistant", parentId: "u1", status: "completed", content: [{ type: "output_text", text: "two" }] },
  ].map(JSON.stringify).join("\n");
  assert.deepEqual(codeBuddyTranscriptTurnFromJsonLines(lines, { sessionId, turnId: "t1", prompt: "fork" }), { ok: false, reason: "turn_ambiguous" });
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
    turnId: `${sessionId}:${Buffer.byteLength(first, "utf8")}:hash:nonce`,
    prompt: "repeat",
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
  assert.deepEqual(codeBuddyTranscriptTurnFromJsonLines(lines, { sessionId, turnId: "t1", prompt: "same" }), { ok: false, reason: "user_prompt_missing" });
});

test("fails closed on malformed JSONL instead of using a partial transcript", () => {
  const lines = [
    JSON.stringify({ id: "u1", type: "message", role: "user", sessionId, content: [{ type: "input_text", text: "partial" }] }),
    "{not-json",
    JSON.stringify({ id: "a1", type: "message", role: "assistant", parentId: "u1", status: "completed", content: [{ type: "output_text", text: "should not persist" }] }),
  ].join("\n");
  assert.deepEqual(codeBuddyTranscriptTurnFromJsonLines(lines, { sessionId, turnId: "t1", prompt: "partial" }), { ok: false, reason: "malformed_transcript" });
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
    turnId: `${sessionId}:${Buffer.byteLength(first, "utf8")}:hash:nonce`,
    prompt: "重复",
  });
  assert.equal(result.ok, true);
  assert.equal(result.turn.assistantReply, "第二轮");
});

test("accepts a prompt materialized before the provisional boundary", () => {
  const lines = [
    { id: "u1", type: "message", role: "user", sessionId, content: [{ type: "input_text", text: "race" }] },
    { id: "a1", type: "message", role: "assistant", parentId: "u1", status: "completed", content: [{ type: "output_text", text: "done" }] },
  ].map(JSON.stringify).join("\n") + "\n";
  const result = codeBuddyTranscriptTurnFromJsonLines(lines, {
    sessionId,
    turnId: `${sessionId}:${Buffer.byteLength(lines, "utf8")}:hash:nonce`,
    prompt: "race",
  });
  assert.equal(result.ok, true);
  assert.equal(result.turn.assistantReply, "done");
});
