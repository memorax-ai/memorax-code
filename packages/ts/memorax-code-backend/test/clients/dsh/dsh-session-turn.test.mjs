import assert from "node:assert/strict";
import { test } from "node:test";
import { dshSessionEventTurn } from "../../../dist/clients/dsh/session-turn.js";
import { dshFormat4TurnInterval, dshTurnInterval } from "./support/dsh-session-fixtures.mjs";

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
      finalAssistantReply: "The adapter is ready.",
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
    ["unknown future format", (input) => { input.sessionHeader.version = 5; }, "session_header_invalid"],
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

test("DSH format 4 materializes only direct user and visible model content with producer-owned context", () => {
  const interval = dshFormat4TurnInterval({ cwd: CWD, turn: 2, startSeq: 40 });
  interval.sessionHeader.isSeeded = true;
  interval.sessionHeader.parentSession = "ordinary-parent";
  const inserted = [
    {
      type: "system/message",
      data: {
        turn: 2, step: 1,
        message: {
          id: "system-message", role: "system", source: { kind: "system-prompt" },
          content: [{ type: "text", text: "Private system instructions." }],
        },
      },
      surfaceOp: "append",
    },
    {
      type: "developer/message",
      data: {
        turn: 2, step: 1,
        message: {
          id: "developer-message", role: "developer", source: { kind: "runtime-context" },
          content: [{ type: "text", text: "Private developer instructions." }],
        },
      },
      surfaceOp: "append",
    },
  ];
  interval.events.splice(2, 0, ...inserted);
  const userEvent = interval.events.find((event) => event.type === "user/message");
  userEvent.data.content.push({
    type: "image",
    attachment: { attachmentId: "test-image", mediaType: "image/png", bytes: 4, width: 1, height: 1 },
  });
  interval.events.splice(6, 0, {
    type: "assistant/attempt",
    data: {
      turn: 2, step: 1,
      stream: [{ type: "text-chunks", time0: 1_700_000_000_000, index: 0, dt: [], texts: ["Uncommitted failed attempt."] }],
    },
  });
  const imageOffload = { type: "image/offload", data: { targets: [] } };
  interval.events.splice(-2, 0, imageOffload, { type: "workspace/changes", data: { turn: 2 } });
  interval.events.forEach((event, index) => {
    event.seq = interval.startSeq + index;
    event.time = 1_700_000_000_000 + index;
  });
  imageOffload.data.targets.push({ seq: userEvent.seq, imageIndexes: [0] });
  interval.endSeq = interval.startSeq + interval.events.length - 1;
  const result = dshSessionEventTurn(interval);
  assert.equal(result.ok, true);
  assert.equal(result.turn.userPrompt, "Implement the DSH adapter.");
  assert.equal(result.turn.assistantReply, "I will inspect.\n\nThe adapter is ready.");
  assert.equal(result.turn.finalAssistantReply, "The adapter is ready.");
  assert.equal(result.turn.userTimestamp, userEvent.time);
  assert.equal(result.turn.assistantTimestamp, interval.events.at(-1).time);
  for (const excluded of ["recalled memory", "private tool result", "Private system", "Private developer", "Uncommitted"]) {
    assert.equal(JSON.stringify(result).includes(excluded), false, excluded);
  }

  const older = structuredClone(interval);
  older.sessionHeader.version = 3;
  assert.deepEqual(dshSessionEventTurn(older), { ok: false, reason: "unknown_required_event" });
});

test("DSH format 4 validates native header, message source, tool role, and surface identities", () => {
  const base = dshFormat4TurnInterval({ cwd: CWD });
  const event = (value, type) => value.events.find((entry) => entry.type === type);
  const recall = (value) => value.events.find((entry) => entry.type === "user/message" && entry.data.source.kind !== "user");
  const cases = [
    ["missing seed classification", (value) => { delete value.sessionHeader.isSeeded; }, "session_header_invalid"],
    ["retired seed length", (value) => { value.sessionHeader.seedLength = 0; }, "session_header_invalid"],
    ["missing delegation depth", (value) => { delete value.sessionHeader.delegationDepth; }, "session_header_invalid"],
    ["unexpected header field", (value) => { value.sessionHeader.inheritedEventCount = 0; }, "session_header_invalid"],
    ["delegated session", (value) => { value.sessionHeader.delegationDepth = 1; }, "subagent_session"],
    ["session identity", (value) => { value.sessionHeader.id = "other-session"; }, "session_identity_mismatch"],
    ["workspace identity", (value) => { value.sessionHeader.cwd = "/workspace/other"; }, "workspace_identity_mismatch"],
    ["event sequence", (value) => { value.events[4].seq += 1; }, "event_sequence_mismatch"],
    ["turn identity", (value) => { event(value, "assistant/message").data.turn += 1; }, "turn_identity_mismatch"],
    ["retired plugin source", (value) => { recall(value).data.source = { kind: "plugin", plugin: "memorax-code-dsh" }; }, "event_invalid"],
    ["missing user identity", (value) => { delete event(value, "user/message").data.id; }, "event_invalid"],
    ["non-model assistant", (value) => { event(value, "assistant/message").data.message.source = { kind: "memorax-code-dsh" }; }, "event_invalid"],
    ["missing assistant stream", (value) => { delete event(value, "assistant/message").data.stream; }, "event_invalid"],
    ["retired tool role", (value) => { event(value, "tool/result").data.message.role = "user"; }, "event_invalid"],
    ["mismatched tool call", (value) => { event(value, "tool/result").data.message.toolCallId = "another-call"; }, "event_invalid"],
    ["retired tool wrapper", (value) => { event(value, "tool/result").data.message.content = [{ type: "tool-result", content: [] }]; }, "event_invalid"],
    ["tool error flag", (value) => { event(value, "tool/result").data.message.isError = "true"; }, "event_invalid"],
    ["tool error identity", (value) => { event(value, "tool/result").data.error = { code: "FAILED" }; }, "event_invalid"],
    ["retired replacement fields", (value) => { recall(value).surfaceOp = { op: "replace", start: 2, end: 2 }; }, "event_invalid"],
    ["replacement without sources", (value) => { recall(value).surfaceOp = { op: "replace", startSeq: 2, endSeq: 2 }; }, "event_invalid"],
    ["future source reference", (value) => { recall(value).sourceEventSeqs = [9]; }, "event_invalid"],
    ["log-only surface", (value) => { event(value, "step/start").surfaceOp = "append"; }, "event_invalid"],
    ["seed boundary within turn", (value) => { value.events[9] = { ...value.events[9], type: "session/end-seed", data: { inherited: true } }; }, "turn_boundary_mismatch"],
    ["working directory change", (value) => {
      value.events[9] = { type: "working-directory/change", seq: 9, time: 10, data: { cwd: "/workspace/other" } };
    }, "workspace_identity_mismatch"],
    ["ignorable working directory change", (value) => {
      value.events[9] = { type: "working-directory/change", seq: 9, time: 10, ignorable: true, data: { cwd: "/workspace/other" } };
    }, "workspace_identity_mismatch"],
    ["unknown required event", (value) => { delete value.events[9].ignorable; }, "unknown_required_event"],
  ];
  for (const [name, mutate, reason] of cases) {
    const value = structuredClone(base);
    mutate(value);
    assert.deepEqual(dshSessionEventTurn(value), { ok: false, reason }, name);
  }
});

test("DSH format 4 excludes migrated plugin sources and compaction replacement content", () => {
  const interval = dshFormat4TurnInterval({ cwd: CWD });
  const recall = interval.events[3];
  recall.data.source = { kind: "compact-checkpoint", compactionId: "compact-1" };
  recall.surfaceOp = { op: "replace", startSeq: 2, endSeq: 2 };
  recall.sourceEventSeqs = [2];
  assert.equal(dshSessionEventTurn(interval).turn.userPrompt, "Implement the DSH adapter.");

  interval.events[2].data.source = { kind: "plugin:user", form: "recall" };
  assert.deepEqual(dshSessionEventTurn(interval), { ok: false, reason: "user_prompt_missing" });
  interval.events.at(-1).data.reason = { kind: "interrupted" };
  assert.deepEqual(dshSessionEventTurn(interval), {
    ok: false, reason: "turn_not_completed", outcome: "interrupted",
  });
});

test("DSH format 4 job lifecycle records remain local while the owning Turn writes native QA", () => {
  const interval = dshFormat4TurnInterval({ cwd: CWD });
  const job = {
    jobId: "job-1", owner: interval.sessionId, kind: "shell",
    label: "Private background command", startedAt: 1_700_000_000_000,
    toolCall: { callId: "call-1", rootCallId: "call-1" },
  };
  interval.events.splice(-1, 0, {
    type: "job/registered", data: job,
  }, {
    type: "job/settled",
    data: {
      ...job, finishedAt: 1_700_000_000_001, status: "completed", cause: "producer",
      producerReported: true, detail: "Private background output",
    },
  });
  interval.events.forEach((event, index) => { event.seq = index; });
  interval.endSeq = interval.events.length - 1;
  const result = dshSessionEventTurn(interval);
  assert.equal(result.ok, true);
  assert.equal(result.turn.userPrompt, "Implement the DSH adapter.");
  assert.equal(result.turn.assistantReply, "I will inspect.\n\nThe adapter is ready.");
  assert.equal(JSON.stringify(result).includes("Private background"), false);
});


test("DSH format 4 replacement endpoints follow surface order after earlier replacements", () => {
  const interval = dshFormat4TurnInterval({ cwd: CWD });
  const context = (id, surfaceOp, sourceEventSeqs) => ({
    type: "user/message",
    data: {
      id, role: "user", source: { kind: "plugin:context-projection" },
      content: [{ type: "text", text: `Private projected context ${id}` }],
    },
    surfaceOp,
    ...(sourceEventSeqs ? { sourceEventSeqs } : {}),
  });
  // Appending 4 then replacing 3 at 5 leaves the surface ordered [2, 5, 4].
  // The next replacement therefore spans 5 through 4, even though 5 > 4.
  interval.events.splice(4, 0,
    context("later-context", "append"),
    context("replacement-head", { op: "replace", startSeq: 3, endSeq: 3 }, [3]),
    context("nested-context", { op: "replace", startSeq: 5, endSeq: 4 }, [5, 4]),
  );
  interval.events.forEach((event, index) => { event.seq = index; });
  interval.endSeq = interval.events.length - 1;
  const result = dshSessionEventTurn(interval);
  assert.equal(result.ok, true);
  assert.equal(result.turn.userPrompt, "Implement the DSH adapter.");
  assert.equal(result.turn.assistantReply, "I will inspect.\n\nThe adapter is ready.");
  assert.equal(JSON.stringify(result).includes("Private projected context"), false);

  for (const mutate of [
    (event) => { event.surfaceOp.startSeq = event.seq; event.sourceEventSeqs = [event.seq, 4]; },
    (event) => { event.surfaceOp.endSeq = event.seq; event.sourceEventSeqs = [5, event.seq]; },
    (event) => { event.sourceEventSeqs = [5]; },
  ]) {
    const malformed = structuredClone(interval);
    mutate(malformed.events[6]);
    assert.deepEqual(dshSessionEventTurn(malformed), { ok: false, reason: "event_invalid" });
  }
});

test("DSH format 4 tool-result pruning may preserve a prior turn without contributing QA", () => {
  const interval = dshFormat4TurnInterval({ cwd: CWD, turn: 2, startSeq: 40 });
  interval.events.splice(4, 0, {
    type: "compaction/prune",
    data: { shadowedRange: { start: 10, end: 10 }, shadowedSeqs: [10], shadowedTokenCount: 100 },
  }, {
    type: "tool/result",
    data: {
      turn: 1, step: 3,
      message: {
        id: "historical-tool-result", role: "tool",
        source: { kind: "tool", callId: "historical-call" }, toolCallId: "historical-call",
        content: [{ type: "text", text: "Private pruned historical tool output." }],
      },
    },
    surfaceOp: { op: "replace", startSeq: 10, endSeq: 10 },
    sourceEventSeqs: [10],
  });
  interval.events.forEach((event, index) => { event.seq = interval.startSeq + index; });
  interval.endSeq = interval.startSeq + interval.events.length - 1;
  const result = dshSessionEventTurn(interval);
  assert.equal(result.ok, true);
  assert.equal(result.turn.turn, 2);
  assert.equal(result.turn.userPrompt, "Implement the DSH adapter.");
  assert.equal(result.turn.assistantReply, "I will inspect.\n\nThe adapter is ready.");
  assert.equal(JSON.stringify(result).includes("historical tool output"), false);

  const cases = [
    ["future turn", (event) => { event.data.turn = 3; }, "turn_identity_mismatch"],
    ["nonpositive turn", (event) => { event.data.turn = 0; }, "event_invalid"],
    ["appended historical result", (event) => { event.surfaceOp = "append"; }, "turn_identity_mismatch"],
    ["missing replacement sources", (event) => { delete event.sourceEventSeqs; }, "event_invalid"],
    ["invalid replacement range", (event) => { delete event.surfaceOp.endSeq; }, "event_invalid"],
    ["mismatched native tool source", (event) => { event.data.message.source.callId = "other-call"; }, "event_invalid"],
    ["assistant from a prior turn", (event) => {
      event.type = "assistant/message";
      event.data.message.role = "assistant";
      event.data.message.source = { kind: "model", provider: "mock", model: "mock" };
      event.data.stream = [];
    }, "turn_identity_mismatch"],
  ];
  for (const [name, mutate, reason] of cases) {
    const malformed = structuredClone(interval);
    mutate(malformed.events[5]);
    assert.deepEqual(dshSessionEventTurn(malformed), { ok: false, reason }, name);
  }
  const older = structuredClone(interval);
  older.sessionHeader.version = 3;
  assert.deepEqual(dshSessionEventTurn(older), { ok: false, reason: "turn_identity_mismatch" });
});
