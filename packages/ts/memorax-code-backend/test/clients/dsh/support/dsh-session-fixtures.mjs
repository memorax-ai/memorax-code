export function dshTurnInterval({
  sessionId = "session-dsh",
  cwd,
  turn = 1,
  startSeq = 0,
} = {}) {
  if (!cwd) throw new Error("fixture cwd is required");
  const events = [];
  const append = (type, data, extra = {}) => {
    events.push({
      type,
      seq: startSeq + events.length,
      time: 1_700_000_000_000 + events.length,
      data,
      ...extra,
    });
  };
  append("turn/start", { turn });
  append("agent/inbox/spliced", {
    target: "next-turn",
    start: 0,
    removedCount: 1,
    inserted: [],
  });
  append("user/message", {
    id: "user-message-1",
    role: "user",
    content: [{ type: "text", text: "Implement the DSH adapter." }],
    source: { kind: "user" },
  }, { surfaceOp: "append" });
  append("session/title", {
    title: "Implement the DSH adapter",
    messageSeqs: [startSeq + 2],
    source: { kind: "fallback" },
  });
  append("step/start", { turn, step: 1 });
  append("user/message", {
    id: "memory-recall-1",
    role: "user",
    content: [{ type: "text", text: "recalled memory must not be written back" }],
    source: { kind: "plugin", plugin: "memorax-code", form: "recall" },
  }, { surfaceOp: "append" });
  append("request/header", {
    header: { config: { provider: "mock", model: "mock" } },
    reason: "initial",
  });
  append("request/context", { provider: "mock", model: "mock" });
  append("assistant/chunk", {
    turn,
    step: 1,
    chunk: { type: "text-delta", index: 0, text: "I will inspect." },
  });
  append("assistant/message", {
    turn,
    step: 1,
    message: {
      id: "assistant-message-1",
      role: "assistant",
      content: [
        { type: "text", text: "I will inspect." },
        { type: "tool-call", id: "call-1", name: "read", arguments: "{}" },
      ],
      source: { kind: "model", provider: "mock", model: "mock" },
    },
  }, { surfaceOp: "append", sourceEventSeqs: [startSeq + 8] });
  append("tool/call", {
    turn,
    step: 1,
    callId: "call-1",
    name: "read",
    arguments: "{}",
  });
  append("tool/result", {
    turn,
    step: 1,
    message: {
      id: "tool-message-1",
      role: "user",
      content: [{
        type: "tool-result",
        toolCallId: "call-1",
        content: [{ type: "text", text: "private tool result must stay local" }],
        isError: false,
      }],
      source: { kind: "tool", callId: "call-1" },
    },
  }, { surfaceOp: "append", sourceEventSeqs: [startSeq + 10] });
  append("step/end", { turn, step: 1 });
  append("step/start", { turn, step: 2 });
  append("assistant/chunk", {
    turn,
    step: 2,
    chunk: { type: "text-delta", index: 0, text: "The adapter is ready." },
  });
  append("assistant/message", {
    turn,
    step: 2,
    message: {
      id: "assistant-message-2",
      role: "assistant",
      content: [{ type: "text", text: "The adapter is ready." }],
      source: { kind: "model", provider: "mock", model: "mock" },
    },
  }, { surfaceOp: "append", sourceEventSeqs: [startSeq + 14] });
  append("step/end", { turn, step: 2 });
  append("plugin/telemetry", null, { ignorable: true });
  append("turn/end", { turn, reason: { kind: "completed" } });
  return {
    sessionId,
    turn,
    startSeq,
    endSeq: startSeq + events.length - 1,
    cwd,
    sessionHeader: {
      version: 0,
      id: sessionId,
      createdAt: 1_700_000_000_000,
      cwd,
    },
    events,
  };
}
