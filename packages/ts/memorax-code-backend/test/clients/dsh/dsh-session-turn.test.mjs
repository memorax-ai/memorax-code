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
      userTimestamp: 1_700_000_000_001,
      assistantTimestamp: 1_700_000_000_010,
      outcome: "completed",
    },
  });
  assert.equal(JSON.stringify(result).includes("recalled memory"), false);
  assert.equal(JSON.stringify(result).includes("private tool result"), false);

  const withoutEndTime = dshTurnInterval({ cwd: CWD });
  delete withoutEndTime.events.at(-1).time;
  assert.equal(dshSessionEventTurn(withoutEndTime).turn.assistantTimestamp, 1_700_000_000_007);
  delete withoutEndTime.events[1].time;
  withoutEndTime.events[7].time = "not-a-time";
  const withoutMessageTimes = dshSessionEventTurn(withoutEndTime);
  assert.equal(withoutMessageTimes.ok, true);
  assert.equal(withoutMessageTimes.turn.userTimestamp, undefined, "plugin recall is not a prompt time source");
  assert.equal(withoutMessageTimes.turn.assistantTimestamp, undefined, "earlier assistant text cannot date the final reply");

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

test("DSH format 3 keeps native QA while excluding new context and failed-attempt events", () => {
  const value = dshTurnInterval({ cwd: CWD });
  value.sessionHeader.version = 3;
  value.sessionHeader.isSeeded = false;
  value.sessionHeader.delegationDepth = 0;
  for (const event of value.events) {
    if (event.type === "assistant/message") event.data.stream = [];
  }
  value.events[2].surfaceOp = { op: "replace", startSeq: 1, endSeq: 1 };
  value.events[2].sourceEventSeqs = [1];
  value.events.splice(-1, 0, {
    type: "system/message",
    data: {
      turn: 1,
      step: 1,
      message: {
        id: "system-message",
        role: "system",
        source: { kind: "plugin", plugin: "system-prompt" },
        content: [{ type: "text", text: "Private system instructions." }],
      },
    },
    surfaceOp: "append",
  }, {
    type: "assistant/attempt",
    data: {
      turn: 1,
      step: 1,
      stream: [{
        type: "text-chunks", time0: 1_700_000_000_009,
        index: 0, dt: [], texts: ["Uncommitted failed attempt."],
      }],
    },
  });
  value.events.forEach((event, index) => {
    event.seq = index;
    event.time = 1_700_000_000_000 + index;
  });
  value.endSeq = value.events.length - 1;

  const expected = dshSessionEventTurn(dshTurnInterval({ cwd: CWD }));
  expected.turn.endSeq = value.endSeq;
  expected.turn.assistantTimestamp = value.events.at(-1).time;
  assert.deepEqual(dshSessionEventTurn(value), expected);

  const cases = [
    ["unsupported earlier format", (input) => { input.sessionHeader.version = 2; }, "session_header_invalid"],
    ["unknown future format", (input) => { input.sessionHeader.version = 4; }, "session_header_invalid"],
    ["missing seed classification", (input) => { delete input.sessionHeader.isSeeded; }, "session_header_invalid"],
    ["retired seed length", (input) => { input.sessionHeader.seedLength = 0; }, "session_header_invalid"],
    ["old replacement fields", (input) => { input.events[2].surfaceOp = { op: "replace", start: 1, end: 1 }; }, "event_invalid"],
    ["direct user replacement", (input) => { input.events[2].data.source = { kind: "user" }; }, "event_invalid"],
    ["unknown required event", (input) => { delete input.events[9].ignorable; }, "unknown_required_event"],
    ["retired required event", (input) => { input.events[10].type = "assistant/chunk"; }, "unknown_required_event"],
    ["new event in old format", (input) => { input.sessionHeader.version = 0; input.events[2].surfaceOp = "append"; }, "unknown_required_event"],
  ];
  for (const [name, mutate, reason] of cases) {
    const input = structuredClone(value);
    mutate(input);
    assert.deepEqual(dshSessionEventTurn(input), { ok: false, reason }, name);
  }
});
