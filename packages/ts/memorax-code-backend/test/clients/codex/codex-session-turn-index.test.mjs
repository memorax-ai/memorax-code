import assert from "node:assert/strict";
import { test } from "node:test";
import {
  codexSessionTurnIndexFromJsonLines,
  readCodexSessionTurnIndex,
} from "../../../dist/clients/codex/session-turn-index.js";

test("Codex session turn index counts unique top-level turn boundaries and ignores tool activity", () => {
  const transcript = jsonLines([
    sessionMeta("session-1"),
    turnContext("turn-1"),
    taskStarted("turn-1"),
    toolCall("call-1"),
    turnContext("turn-1"),
    taskComplete("turn-1"),
    taskStarted("background-task"),
    toolCall("background-call"),
    taskComplete("background-task"),
    taskStarted("message-turn-2"),
    userMessage("User prompt without turn_context."),
    toolCall("call-2"),
    turnContext("turn-target"),
  ]);

  assert.deepEqual(codexSessionTurnIndexFromJsonLines(transcript, {
    sessionId: "session-1",
    turnId: "turn-target",
  }), {
    ok: true,
    sessionTurnIndex: 3,
  });
});

test("Codex session turn index fails closed for session and turn mismatches", () => {
  const transcript = jsonLines([
    sessionMeta("session-1"),
    turnContext("turn-1"),
  ]);

  assert.deepEqual(codexSessionTurnIndexFromJsonLines(transcript, {
    sessionId: "other-session",
    turnId: "turn-1",
  }), { ok: false, reason: "transcript_session_mismatch" });
  assert.deepEqual(codexSessionTurnIndexFromJsonLines(transcript, {
    sessionId: "session-1",
    turnId: "missing-turn",
  }), { ok: false, reason: "turn_not_found" });
});

test("Codex session turn index reports an unavailable transcript without throwing", async () => {
  const result = await readCodexSessionTurnIndex({
    transcriptPath: "/path/that/does/not/exist.jsonl",
    sessionId: "session-1",
    turnId: "turn-1",
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "transcript_unavailable");
  assert.equal(typeof result.error, "string");
});

function jsonLines(records) {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

function sessionMeta(sessionId) {
  return { type: "session_meta", payload: { id: sessionId } };
}

function turnContext(turnId) {
  return { type: "turn_context", payload: { turn_id: turnId } };
}

function taskStarted(turnId) {
  return { type: "event_msg", payload: { type: "task_started", turn_id: turnId } };
}

function taskComplete(turnId) {
  return { type: "event_msg", payload: { type: "task_complete", turn_id: turnId } };
}

function userMessage(message) {
  return { type: "event_msg", payload: { type: "user_message", message } };
}

function toolCall(callId) {
  return {
    type: "response_item",
    payload: { type: "function_call", call_id: callId, name: "exec_command" },
  };
}
