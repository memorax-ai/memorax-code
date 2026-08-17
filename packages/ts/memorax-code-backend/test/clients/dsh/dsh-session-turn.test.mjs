import assert from "node:assert/strict";
import { test } from "node:test";
import { dshSessionEventTurn } from "../../../dist/clients/dsh/session-turn.js";
import { dshTurnInterval } from "./support/dsh-session-fixtures.mjs";

const CWD = "/workspace/project";

test("DSH turn materialization accepts one exact native interval and excludes plugin and tool content", () => {
  const result = dshSessionEventTurn(dshTurnInterval({ cwd: CWD }));
  assert.deepEqual(result, {
    ok: true,
    turn: {
      sessionId: "session-dsh",
      turn: 1,
      startSeq: 0,
      endSeq: 10,
      userPrompt: "Implement the DSH adapter.",
      assistantReply: "I will inspect.\n\nThe adapter is ready.",
      outcome: "completed",
    },
  });
  assert.equal(JSON.stringify(result).includes("recalled memory"), false);
  assert.equal(JSON.stringify(result).includes("private tool result"), false);

  const ordinaryFork = dshTurnInterval({ cwd: CWD });
  ordinaryFork.sessionHeader.parentSession = "ordinary-parent";
  assert.equal(
    dshSessionEventTurn(ordinaryFork).ok,
    true,
    "an ordinary fork is not a delegated subagent",
  );
});

test("DSH turn materialization fails closed across session, workspace, interval, and event identities", () => {
  const base = dshTurnInterval({ cwd: CWD });
  const cases = [
    ["session header version", (value) => { value.sessionHeader.version = 1; }, "session_header_invalid"],
    ["session id", (value) => { value.sessionHeader.id = "other-session"; }, "session_identity_mismatch"],
    ["workspace", (value) => { value.sessionHeader.cwd = "/workspace/other"; }, "workspace_identity_mismatch"],
    ["subagent", (value) => { value.sessionHeader.delegationDepth = 1; }, "subagent_session"],
    ["interval length", (value) => { value.endSeq += 1; }, "interval_length_mismatch"],
    ["event sequence", (value) => { value.events[4].seq += 1; }, "event_sequence_mismatch"],
    ["surface operation", (value) => { value.events[2].surfaceOp = { op: "replace", start: 1 }; }, "event_invalid"],
    ["first boundary", (value) => { value.events[0].type = "step/start"; }, "turn_boundary_mismatch"],
    ["turn identity", (value) => { value.events[4].data.turn = 2; }, "turn_identity_mismatch"],
    [
      "interrupted turn",
      (value) => { value.events.at(-1).data.reason = { kind: "interrupted" }; },
      "turn_not_completed",
      "interrupted",
    ],
    ["unknown required event", (value) => { delete value.events[9].ignorable; }, "unknown_required_event"],
  ];
  for (const [name, mutate, reason, outcome] of cases) {
    const value = structuredClone(base);
    mutate(value);
    assert.deepEqual(dshSessionEventTurn(value), {
      ok: false,
      reason,
      ...(outcome ? { outcome } : {}),
    }, name);
  }
});

test("DSH turn materialization never treats plugin recall as the user prompt", () => {
  const value = dshTurnInterval({ cwd: CWD });
  value.events[1].data.source = { kind: "plugin", plugin: "memorax-code", form: "recall" };
  assert.deepEqual(dshSessionEventTurn(value), {
    ok: false,
    reason: "user_prompt_missing",
  });
});

test("DSH turn materialization ignores compaction replacement messages", () => {
  const value = dshTurnInterval({ cwd: CWD });
  value.events[2].data.source = {
    kind: "plugin",
    plugin: "compact",
    compactionId: "compaction-1",
  };
  value.events[2].surfaceOp = { op: "replace", start: 1, end: 1 };

  const result = dshSessionEventTurn(value);
  assert.equal(result.ok, true);
  assert.equal(result.turn.userPrompt, "Implement the DSH adapter.");
  assert.equal(JSON.stringify(result).includes("recalled memory"), false);
});

test("DSH interrupted intervals do not require completed-Turn content", () => {
  const value = dshTurnInterval({ cwd: CWD });
  value.events[1].data.source = { kind: "plugin", plugin: "memorax-code", form: "recall" };
  value.events.at(-1).data.reason = { kind: "interrupted" };
  assert.deepEqual(dshSessionEventTurn(value), {
    ok: false,
    reason: "turn_not_completed",
    outcome: "interrupted",
  });
});
