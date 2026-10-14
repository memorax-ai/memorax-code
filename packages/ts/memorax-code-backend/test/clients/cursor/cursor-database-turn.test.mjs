import assert from "node:assert/strict";
import { test } from "node:test";
import {
  captureCursorContinuation, cursorTextDigest, selectCursorDatabaseTurn,
} from "../../../dist/clients/cursor/database-turn.js";

const previousGenerationId = "11111111-1111-4111-8111-111111111111";
const generationId = "22222222-2222-4222-8222-222222222222";
const prompt = "Synthetic user prompt with <user_query> in its text.\nPreserve spacing. ";
const answer = "Synthetic public final answer. ";
const promptDigest = cursorTextDigest(prompt);
const responseDigest = cursorTextDigest(answer);

function step(id, type = "assistantMessage", text = answer) {
  return { id, type, text, contentHash: cursorTextDigest(JSON.stringify({ type, text })) };
}

function turn(requestId = generationId, steps = [step("final")]) {
  return { id: `turn-${requestId}`, type: "agent", requestId, userMessageId: "native-user",
    userMessageRef: "native-user-blob", userPrompt: prompt, steps };
}

function snapshot(turns = [turn()], latestGenerationId = generationId) {
  return { stateHash: "synthetic-state", latestGenerationId, turns };
}

function select(native, continuation) {
  return selectCursorDatabaseTurn({ snapshot: native, generationId, promptDigest, responseDigest, continuation });
}

function capture(native = snapshot([turn(previousGenerationId, [step("partial", "assistantMessage", "Partial reply")])], previousGenerationId)) {
  return captureCursorContinuation({ snapshot: native, generationId, previousGenerationId,
    requestId: previousGenerationId, promptDigest });
}

test("Cursor native DB selects exact ordinary and edited turns without a start snapshot or text wrapper", () => {
  const native = snapshot([turn(previousGenerationId), turn(generationId, [
    step("thinking", "thinkingMessage", "Private reasoning"),
    step("tool", "toolCall", "Tool output"), step("final"),
  ])]);
  assert.deepEqual(select(native), { ok: true, userPrompt: prompt, assistantReply: answer });
  const edited = snapshot([turn(generationId)]);
  edited.turns[0].id = "replacement-branch-turn";
  assert.deepEqual(select(edited), { ok: true, userPrompt: prompt, assistantReply: answer });
});

test("Cursor native DB waits for the exact generation and its fully persisted final text", async (t) => {
  const cases = [
    ["previous generation", snapshot([turn()], previousGenerationId), "native_generation_pending"],
    ["missing generation", snapshot([turn()], null), "native_generation_pending"],
    ["stale state despite current generation", snapshot([turn(previousGenerationId)]), "native_turn_pending"],
    ["no final step", snapshot([turn(generationId, [])]), "native_final_response_pending"],
    ["empty final step", snapshot([turn(generationId, [step("empty", "assistantMessage", "")])]), "native_final_response_pending"],
    ["partial final text", snapshot([turn(generationId, [step("partial", "assistantMessage", answer.slice(0, 8))])]), "native_final_response_pending"],
    ["matching intermediate then tool", snapshot([turn(generationId, [step("intermediate"), step("tool", "toolCall")])]), "native_final_response_pending"],
    ["matching intermediate then different final", snapshot([turn(generationId, [step("intermediate"), step("last", "assistantMessage", "Different final")])]), "native_final_response_pending"],
    ["thinking text cannot be final", snapshot([turn(generationId, [step("thought", "thinkingMessage")])]), "native_final_response_pending"],
  ];
  for (const [name, native, reason] of cases) await t.test(name, () => {
    assert.deepEqual(select(native), { ok: false, reason, retryable: true });
  });
});

test("Cursor native DB rejects conflicting identities, unknown steps and duplicate final text", async (t) => {
  const badPrompt = turn(); badPrompt.userPrompt = "Different native user";
  const noUser = turn(); delete noUser.userMessageId;
  const unsupported = turn(); unsupported.reason = "native_user_unsupported";
  const cases = [
    ["duplicate native request", snapshot([turn(), turn()]), "native_turn_ambiguous"],
    ["target no longer last", snapshot([turn(), turn(previousGenerationId)]), "native_turn_replaced"],
    ["different user prompt", snapshot([badPrompt]), "native_prompt_mismatch"],
    ["missing native user identity", snapshot([noUser]), "native_user_unavailable"],
    ["unsupported target user", snapshot([unsupported]), "native_user_unsupported"],
    ["unknown step", snapshot([turn(generationId, [step("unknown", "unknown"), step("final")])]), "native_step_unsupported"],
    ["same reply twice", snapshot([turn(generationId, [step("first"), step("second")])]), "native_response_ambiguous"],
  ];
  for (const [name, native, reason] of cases) await t.test(name, () => {
    assert.deepEqual(select(native), { ok: false, reason });
  });
});

test("Cursor Continue binds the exact prior native user and accepts only appended public final text", () => {
  const before = snapshot([turn("older"), turn(previousGenerationId, [
    step("thought", "thinkingMessage", "Prior reasoning"), step("partial", "assistantMessage", "Partial reply"),
  ])], previousGenerationId);
  const captured = capture(before);
  assert.equal(captured.ok, true);
  const after = structuredClone(before);
  after.latestGenerationId = generationId;
  after.turns[1].id = "updated-native-turn-blob";
  after.turns[1].steps.push(step("new-thought", "thinkingMessage", "New reasoning"), step("new-tool", "toolCall"), step("final"));
  assert.deepEqual(select(after, captured.baseline), { ok: true, userPrompt: prompt, assistantReply: answer });
  assert.equal(captured.baseline.steps.length, 2, "captured authority is not mutated by later snapshots");
});

test("Cursor Continue never guesses a prior native turn from position or an unrelated generation", async (t) => {
  const badPrompt = turn(previousGenerationId); badPrompt.userPrompt = "Another user";
  const cases = [
    ["unrelated generation", snapshot([turn(previousGenerationId)], "other"), "native_generation_pending", true],
    ["missing exact prior turn", snapshot([turn("other")]), "native_turn_pending", true],
    ["duplicate request identity", snapshot([turn(previousGenerationId), turn(previousGenerationId)]), "native_turn_ambiguous"],
    ["later native branch", snapshot([turn(previousGenerationId), turn("other")]), "native_turn_replaced"],
    ["changed original prompt", snapshot([badPrompt]), "native_prompt_mismatch"],
  ];
  for (const [name, native, reason, retryable] of cases) await t.test(name, () => {
    assert.deepEqual(capture(native), { ok: false, reason, ...(retryable ? { retryable } : {}) });
  });
});

test("Cursor Continue rejects user, branch and existing-step replacement", async (t) => {
  const before = snapshot([turn("older"), turn(previousGenerationId, [step("partial", "assistantMessage", "Partial reply")])]);
  const captured = capture(before);
  assert.equal(captured.ok, true);
  const cases = [
    ["changed user id", (s) => { s.turns[1].userMessageId = "different-user"; }, "native_continuation_replaced"],
    ["changed user blob", (s) => { s.turns[1].userMessageRef = "different-blob"; }, "native_continuation_replaced"],
    ["replaced prior branch", (s) => { s.turns[0].id = "different-prior-turn"; }, "native_continuation_replaced"],
    ["removed preceding turn", (s) => { s.turns.shift(); }, "native_continuation_replaced"],
    ["rewritten prior step", (s) => { s.turns[1].steps[0] = step("new-partial", "assistantMessage", "Partial reply"); }, "native_continuation_prefix_changed"],
    ["mutated step with reused id", (s) => { s.turns[1].steps[0] = step("partial", "assistantMessage", "Changed partial"); }, "native_continuation_prefix_changed"],
    ["removed prior step", (s) => { s.turns[1].steps.shift(); }, "native_continuation_prefix_changed"],
  ];
  for (const [name, mutate, reason] of cases) await t.test(name, () => {
    const after = structuredClone(before);
    after.turns[1].steps.push(step("final"));
    mutate(after);
    assert.deepEqual(select(after, captured.baseline), { ok: false, reason });
  });
});

test("Cursor Continue does not replay a matching old answer or concatenate retained partial text", () => {
  const before = snapshot([turn(previousGenerationId, [step("old-final")])]);
  const captured = capture(before);
  assert.equal(captured.ok, true);
  assert.deepEqual(select(before, captured.baseline), { ok: false, reason: "native_final_response_pending", retryable: true });
  const after = structuredClone(before);
  after.turns[0].steps.push(step("delayed-previous-partial", "assistantMessage", "Old partial"));
  assert.deepEqual(select(after, captured.baseline), { ok: false, reason: "native_final_response_pending", retryable: true });
  after.turns[0].steps.push(step("new-final"));
  assert.deepEqual(select(after, captured.baseline), { ok: true, userPrompt: prompt, assistantReply: answer });
  after.turns[0].steps.push(step("duplicate-new-final"));
  assert.deepEqual(select(after, captured.baseline), { ok: false, reason: "native_response_ambiguous" });
});
