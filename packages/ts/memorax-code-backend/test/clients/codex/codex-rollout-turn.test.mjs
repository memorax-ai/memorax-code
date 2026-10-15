import assert from "node:assert/strict";
import { test } from "node:test";
import {
  codexCodingSessionTurnFromJsonLines,
  codexInterruptedRolloutTurnFromJsonLines,
  codexRolloutTurnFromJsonLines,
  readCodexInterruptedRolloutTurn,
  readCodexRolloutTurn,
} from "../../../dist/clients/codex/rollout-turn.js";
import { codexSessionTurnIndexFromJsonLines } from "../../../dist/clients/codex/session-turn-index.js";

test("Codex rollout reader selects the exact open turn and preserves prompt and final reply text", () => {
  const transcript = jsonLines([
    sessionMeta("session-1"),
    taskStarted("turn-before"),
    userMessage("Earlier prompt."),
    customToolCall('const r = await tools.exec_command({ cmd: "sed -n \'1,200p\' /Users/test/.codex/plugins/cache/memorax-code/memorax-code-codex-adapter/0.1.11/skills/memorax-code/references/repo-read.md" });'),
    agentMessage("Earlier reply.", "final_answer"),
    taskComplete("turn-before", "Earlier reply."),
    taskStarted("turn-target"),
    turnContext("turn-target"),
    { ...userMessage("  Target prompt with trailing newline.\n"), timestamp: "2026-09-01T08:00:00.000Z" },
    agentMessage("Intermediate update.", "commentary"),
    { ...agentMessage("Target final reply.\n", "final_answer"), timestamp: "2026-09-01T08:03:00.000Z" },
  ]);

  assert.deepEqual(codexRolloutTurnFromJsonLines(transcript, {
    sessionId: "session-1",
    turnId: "turn-target",
  }), {
    ok: true,
    turn: {
      sessionId: "session-1",
      turnId: "turn-target",
      userPrompt: "  Target prompt with trailing newline.\n",
      assistantReply: "Target final reply.\n",
      userTimestamp: Date.parse("2026-09-01T08:00:00.000Z"),
      assistantTimestamp: Date.parse("2026-09-01T08:03:00.000Z"),
      activities: [],
    },
  });
  const source = codexCodingSessionTurnFromJsonLines(transcript, {
    sessionId: "session-1", turnId: "turn-target",
  });
  assert.equal(source.ok, true);
  assert.equal(source.turn.sessionTurnIndex, 2);
  assert.equal(source.turn.userTimestamp, Date.parse("2026-09-01T08:00:00.000Z"));
  assert.equal(source.turn.assistantTimestamp, Date.parse("2026-09-01T08:03:00.000Z"));
  assert.deepEqual(source.turn.items, [
    { type: "message", role: "user", content: [{ type: "input_text", text: "  Target prompt with trailing newline.\n" }] },
    { type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "Intermediate update." }] },
    { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "Target final reply.\n" }] },
  ]);
});

test("Codex coding items preserve native fields and text blocks without duplicate mirrors or hidden reasoning", () => {
  const user = {
    ...responseItemUserMessage("Inspect the parser.", "turn-1").payload,
    id: "message-user",
    content: [
      { type: "input_text", text: "  Inspect the parser.\n", private_metadata: "omit" },
      { type: "input_image", image_url: "private-image" },
      { type: "input_text", text: "\n" },
      { type: "input_text", text: "Keep its text blocks." },
    ],
  };
  const final = {
    ...responseMessage("assistant", "The parser is correct.", "final_answer", "turn-1").payload,
    id: "message-final",
    content: [
      { type: "output_text", text: "The parser is correct.", annotations: [{ text: "omit" }] },
      { type: "output_text", text: "" },
      { type: "output_text", text: "\nIts fields are preserved.  " },
    ],
    status: "completed",
  };
  const argumentsText = ' { "z": 2, "cmd": "pwd" }\n';
  const customInput = "  print('native input')\n";
  const transcript = jsonLines([
    sessionMeta("session-1"),
    taskStarted("turn-1"),
    turnContext("turn-1"),
    { type: "response_item", payload: user },
    userMessage("Inspect the parser."),
    responseMessage("assistant", "Reading the parser.", "commentary", "turn-1"),
    agentMessage("Reading the parser.", "commentary"),
    { type: "response_item", payload: { type: "reasoning", content: [{ text: "private reasoning" }] } },
    responseMessage("assistant", "Private analysis.", "analysis", "turn-1"),
    { type: "response_item", payload: { type: "unknown_item", content: [{ text: "unknown content" }] } },
    { type: "response_item", payload: { type: "function_call", id: "function-1", call_id: "call-1", name: "exec_command", namespace: "functions", arguments: argumentsText, status: "completed" } },
    { type: "response_item", payload: { type: "function_call_output", id: "result-1", call_id: "call-1", output: "  workspace\n", status: "failed" } },
    { type: "response_item", payload: { type: "custom_tool_call", id: "custom-1", call_id: "call-2", name: "exec", input: customInput } },
    { type: "response_item", payload: { type: "custom_tool_call_output", id: "custom-result-1", call_id: "call-2", output: { result: "done" }, success: true } },
    { type: "response_item", payload: final },
    agentMessage("The parser is correct.", "final_answer"),
    taskComplete("turn-1"),
  ]);
  const identity = { sessionId: "session-1", turnId: "turn-1" };
  const source = codexCodingSessionTurnFromJsonLines(transcript, identity);
  assert.equal(source.ok, true);
  const { items, closedAt, sessionTurnIndex, ...qa } = source.turn;
  assert.deepEqual(qa, codexRolloutTurnFromJsonLines(transcript, identity).turn);
  assert.equal(qa.userPrompt, "  Inspect the parser.\n\nKeep its text blocks.");
  assert.equal(qa.assistantReply, "The parser is correct.\n\nIts fields are preserved.  ");
  assert.equal(sessionTurnIndex, 1);
  assert.equal(closedAt, "2026-07-16T00:00:05.000Z");
  assert.deepEqual(items, [
    { type: "message", role: "user", id: "message-user", content: [
      { type: "input_text", text: "  Inspect the parser.\n" },
      { type: "input_text", text: "\n" },
      { type: "input_text", text: "Keep its text blocks." },
    ] },
    { type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "Reading the parser." }] },
    { type: "function_call", id: "function-1", call_id: "call-1", name: "exec_command", namespace: "functions", arguments: argumentsText },
    { type: "function_call_output", id: "result-1", call_id: "call-1", output: "  workspace\n" },
    { type: "custom_tool_call", id: "custom-1", call_id: "call-2", name: "exec", input: customInput },
    { type: "custom_tool_call_output", id: "custom-result-1", call_id: "call-2", output: '{"result":"done"}' },
    { type: "message", role: "assistant", phase: "final_answer", id: "message-final", content: [
      { type: "output_text", text: "The parser is correct." },
      { type: "output_text", text: "" },
      { type: "output_text", text: "\nIts fields are preserved.  " },
    ] },
    { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "The parser is correct." }] },
  ]);

  const interrupted = transcript + jsonLines([turnAborted("turn-1"), threadRolledBack()]);
  assert.deepEqual(codexCodingSessionTurnFromJsonLines(interrupted, identity), {
    ok: false, reason: "turn_not_completed",
  });
});

test("Codex archive retains users, final messages, and tools in native record order without changing QA", () => {
  const transcript = jsonLines([
    sessionMeta("session-1"), taskStarted("turn-1"), turnContext("turn-1"),
    responseItemUserMessage("Inspect the initial input.", "turn-1"),
    completedUserMessage(["Inspect the initial input."], "native-first"),
    responseMessage("assistant", "Inspecting the input.", "commentary", "turn-1"),
    { type: "response_item", payload: { type: "function_call", call_id: "call-first", name: "read", arguments: "{}" } },
    responseItemUserMessage("Include the revised input.", "turn-1"),
    completedUserMessage(["Include the revised input."], "native-second"),
    responseItemUserMessage("<skill>Unrelated injected context.</skill>", "turn-1"),
    { type: "response_item", payload: { type: "function_call_output", call_id: "call-first", output: "Initial result." } },
    responseMessage("assistant", "Initial final response.", "final_answer", "turn-1"),
    { type: "response_item", payload: { type: "function_call", call_id: "call-last", name: "read", arguments: "{}" } },
    responseMessage("assistant", "Revised final response.", "final_answer", "turn-1"),
    { type: "response_item", payload: { type: "function_call_output", call_id: "call-last", output: "Last result." } },
    taskComplete("turn-1"),
  ]);
  const identity = { sessionId: "session-1", turnId: "turn-1" };
  const archive = codexCodingSessionTurnFromJsonLines(transcript, identity);
  assert.equal(archive.ok, true);
  const { items, closedAt, sessionTurnIndex, ...qa } = archive.turn;
  assert.deepEqual(qa, codexRolloutTurnFromJsonLines(transcript, identity).turn);
  assert.equal(qa.userPrompt, "Include the revised input.");
  assert.equal(qa.assistantReply, "Revised final response.");
  assert.deepEqual(items.map((item) => item.type === "message"
    ? `${item.role}/${item.phase ?? "input"}:${item.content.map((block) => block.text).join("\n")}`
    : `${item.type}:${item.call_id}`), [
    "user/input:Inspect the initial input.",
    "assistant/commentary:Inspecting the input.",
    "function_call:call-first",
    "user/input:Include the revised input.",
    "function_call_output:call-first",
    "assistant/final_answer:Initial final response.",
    "function_call:call-last",
    "assistant/final_answer:Revised final response.",
    "function_call_output:call-last",
  ]);
});

test("Codex archive preserves multiple legacy inputs at their original positions", () => {
  const transcript = jsonLines([
    sessionMeta("session-1"), taskStarted("turn-1"), turnContext("turn-1"),
    userMessage("Initial legacy input."),
    agentMessage("Intermediate legacy update.", "commentary"),
    userMessage("Additional legacy input."),
    agentMessage("Completed legacy response.", "final_answer"),
    taskComplete("turn-1"),
  ]);
  const identity = { sessionId: "session-1", turnId: "turn-1" };
  const archive = codexCodingSessionTurnFromJsonLines(transcript, identity);
  assert.equal(archive.ok, true);
  assert.equal(codexRolloutTurnFromJsonLines(transcript, identity).turn.userPrompt, "Additional legacy input.");
  assert.deepEqual(archive.turn.items.map((item) => item.content[0].text), [
    "Initial legacy input.", "Intermediate legacy update.", "Additional legacy input.", "Completed legacy response.",
  ]);
});

test("Codex archive removes only one matching assistant mirror per response item", () => {
  const transcript = jsonLines([
    sessionMeta("session-1"), taskStarted("turn-1"), turnContext("turn-1"),
    responseItemUserMessage("Inspect mixed native messages.", "turn-1"),
    responseMessage("assistant", "Mirrored update.", "commentary", "turn-1"),
    agentMessage("Mirrored update.", "commentary"),
    agentMessage("Unique legacy update.", "commentary"),
    agentMessage("Repeated update.", "commentary"),
    agentMessage("Repeated update.", "commentary"),
    responseMessage("assistant", "Repeated update.", "commentary", "turn-1"),
    agentMessage("Legacy repeated update.", "commentary"),
    agentMessage("Legacy repeated update.", "commentary"),
    responseMessage("assistant", "Native repeated update.", "commentary", "turn-1"),
    responseMessage("assistant", "Native repeated update.", "commentary", "turn-1"),
    agentMessage("Same text, distinct phase.", "commentary"),
    responseMessage("assistant", "Same text, distinct phase.", "final_answer", "turn-1"),
    responseMessage("assistant", "Complete mixed messages.", "final_answer", "turn-1"),
    agentMessage("Complete mixed messages.", "final_answer"),
    taskComplete("turn-1"),
  ]);
  const source = codexCodingSessionTurnFromJsonLines(transcript, { sessionId: "session-1", turnId: "turn-1" });
  assert.equal(source.ok, true);
  assert.deepEqual(source.turn.items.filter((item) => item.role === "assistant")
    .map((item) => [item.phase, item.content[0].text]), [
    ["commentary", "Mirrored update."],
    ["commentary", "Unique legacy update."],
    ["commentary", "Repeated update."],
    ["commentary", "Repeated update."],
    ["commentary", "Legacy repeated update."],
    ["commentary", "Legacy repeated update."],
    ["commentary", "Native repeated update."],
    ["commentary", "Native repeated update."],
    ["commentary", "Same text, distinct phase."],
    ["final_answer", "Same text, distinct phase."],
    ["final_answer", "Complete mixed messages."],
  ]);
});

test("Codex turn indexes stay aligned across response-item turns and interrupted boundaries", () => {
  const transcript = jsonLines([
    sessionMeta("session-1"),
    taskStarted("turn-1"),
    turnContext("turn-1"),
    turnContext("turn-1"),
    responseItemUserMessage("Interrupted prompt.", "turn-1"),
    turnAborted("turn-1"),
    taskStarted("background-task"),
    customToolCall("Background work."),
    responseItemUserMessage("Mismatched prompt.", "other-turn"),
    turnAborted("background-task"),
    responseItemUserMessage("Outside a turn."),
    taskStarted("turn-2"),
    responseItemUserMessage("Second prompt.", "turn-2"),
    responseMessage("assistant", "Second reply.", "final_answer", "turn-2"),
    taskComplete("turn-2"),
    taskStarted("turn-3"),
    turnContext("turn-3"),
    responseItemUserMessage("Third prompt.", "turn-3"),
    responseMessage("assistant", "Third reply.", "final_answer", "turn-3"),
    taskComplete("turn-3"),
  ]);
  for (const [turnId, index] of [["turn-2", 2], ["turn-3", 3]]) {
    const identity = { sessionId: "session-1", turnId };
    assert.deepEqual(codexSessionTurnIndexFromJsonLines(transcript, identity), {
      ok: true, sessionTurnIndex: index,
    });
    const result = codexCodingSessionTurnFromJsonLines(transcript, identity);
    assert.equal(result.ok, true);
    assert.equal(result.turn.sessionTurnIndex, index);
  }
});

test("Codex rollout reader uses task_complete as a completed-turn assistant fallback", () => {
  const transcript = jsonLines([
    sessionMeta("session-1"),
    taskStarted("turn-1"),
    userMessage("Stored prompt."),
    { ...taskComplete("turn-1", "Stored final reply."), timestamp: "2026-09-01T08:03:00.000Z" },
    { ...taskComplete("other-turn", "Other final reply."), timestamp: "2026-09-01T08:05:00.000Z" },
  ]);

  assert.deepEqual(codexRolloutTurnFromJsonLines(transcript, {
    sessionId: "session-1",
    turnId: "turn-1",
  }), {
    ok: true,
    turn: {
      sessionId: "session-1",
      turnId: "turn-1",
      userPrompt: "Stored prompt.",
      assistantReply: "Stored final reply.",
      userTimestamp: Date.parse("2026-07-16T00:00:03.000Z"),
      assistantTimestamp: Date.parse("2026-09-01T08:03:00.000Z"),
      activities: [],
    },
  });
});

test("Codex rollout reader supports response_item-only user and final assistant messages", () => {
  const transcript = jsonLines([
    sessionMeta("session-1"),
    taskStarted("turn-1"),
    turnContext("turn-1"),
    { ...responseItemUserMessage("Current-format prompt.", "turn-1"), timestamp: "2026-09-01T08:00:00.000Z" },
    { ...responseMessage("assistant", "Current-format final reply.", "final_answer", "turn-1"), timestamp: "2026-09-01T08:02:58.000Z" },
    { ...taskComplete("turn-1"), timestamp: "2026-09-01T08:03:00.000Z" },
  ]);

  assert.deepEqual(codexRolloutTurnFromJsonLines(transcript, {
    sessionId: "session-1",
    turnId: "turn-1",
  }), {
    ok: true,
    turn: {
      sessionId: "session-1",
      turnId: "turn-1",
      userPrompt: "Current-format prompt.",
      assistantReply: "Current-format final reply.",
      userTimestamp: Date.parse("2026-09-01T08:00:00.000Z"),
      assistantTimestamp: Date.parse("2026-09-01T08:03:00.000Z"),
      activities: [],
    },
  });
});

test("Codex rollout reader keeps local turn boundaries when assistant metadata names another turn", () => {
  const transcript = jsonLines([
    sessionMeta("session-1"),
    taskStarted("turn-before"),
    responseItemUserMessage("Earlier prompt.", "turn-before"),
    responseMessage("assistant", "Earlier reply.", "final_answer", "turn-target"),
    taskComplete("turn-before"),
    taskStarted("turn-target"),
    turnContext("turn-target"),
    responseItemUserMessage("Target prompt.", "turn-target"),
    responseMessage("assistant", "Intermediate update.", "commentary", "provider-turn"),
    responseMessage("assistant", "Target reply.", "final_answer", "provider-turn"),
    taskComplete("turn-target"),
    responseMessage("assistant", "Reply outside a turn.", "final_answer", "turn-target"),
    taskStarted("turn-after"),
    responseItemUserMessage("Later prompt.", "turn-after"),
    responseMessage("assistant", "Later reply.", "final_answer", "turn-target"),
    taskComplete("turn-after"),
  ]);

  assert.deepEqual(codexRolloutTurnFromJsonLines(transcript, {
    sessionId: "session-1",
    turnId: "turn-target",
  }), {
    ok: true,
    turn: {
      sessionId: "session-1",
      turnId: "turn-target",
      userPrompt: "Target prompt.",
      assistantReply: "Target reply.",
      userTimestamp: Date.parse("2026-07-16T00:00:03.000Z"),
      assistantTimestamp: Date.parse("2026-07-16T00:00:05.000Z"),
      activities: [],
    },
  });
  assert.deepEqual(codexRolloutTurnFromJsonLines(transcript, {
    sessionId: "session-1",
    turnId: "provider-turn",
  }), { ok: false, reason: "turn_not_found" });
  const coding = codexCodingSessionTurnFromJsonLines(transcript, {
    sessionId: "session-1", turnId: "turn-target",
  });
  assert.equal(coding.ok, true);
  const { items, sessionTurnIndex, closedAt, ...qa } = coding.turn;
  assert.deepEqual(qa, codexRolloutTurnFromJsonLines(transcript, {
    sessionId: "session-1", turnId: "turn-target",
  }).turn);
  assert.equal(sessionTurnIndex, 2);
  assert.equal(closedAt, "2026-07-16T00:00:05.000Z");
  assert.deepEqual(items, [
    { type: "message", role: "user", content: [{ type: "input_text", text: "Target prompt." }] },
    { type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "Intermediate update." }] },
    { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "Target reply." }] },
  ]);
  assert.deepEqual(codexCodingSessionTurnFromJsonLines(transcript, {
    sessionId: "session-1", turnId: "provider-turn",
  }), { ok: false, reason: "turn_not_found" });
});

test("Codex rollout reader prefers response_item messages over legacy event messages", () => {
  const transcript = jsonLines([
    sessionMeta("session-1"),
    taskStarted("turn-1"),
    turnContext("turn-1"),
    { ...responseItemUserMessage("Current-format prompt."), timestamp: "invalid" },
    { ...userMessage("Legacy prompt."), timestamp: "2026-09-01T08:00:00.000Z" },
    { ...responseMessage("assistant", "Current-format final reply.", "final_answer"), timestamp: "2026-09-01T08:02:58.000Z" },
    { ...agentMessage("Legacy final reply.", "final_answer"), timestamp: "2026-09-01T08:02:59.000Z" },
    { ...taskComplete("turn-1", "Legacy final reply."), timestamp: "invalid" },
  ]);

  assert.deepEqual(codexRolloutTurnFromJsonLines(transcript, {
    sessionId: "session-1",
    turnId: "turn-1",
  }), {
    ok: true,
    turn: {
      sessionId: "session-1",
      turnId: "turn-1",
      userPrompt: "Current-format prompt.",
      assistantReply: "Current-format final reply.",
      assistantTimestamp: Date.parse("2026-09-01T08:02:58.000Z"),
      activities: [],
    },
  });
});

test("Codex legacy user events select exact native input before or after its response", () => {
  for (const eventFirst of [true, false]) {
    const prompt = "  Explain the native parser.\n\nKeep Unicode 🧪 and trailing space. ";
    const input = responseItemUserMessage(prompt, "turn-1");
    input.timestamp = "2026-09-01T08:00:00.000Z";
    const event = userMessage(prompt);
    event.timestamp = "2026-09-01T08:00:01.000Z";
    assertCodexSelectedUser([
      sessionMeta("session-1"), taskStarted("turn-1"),
      responseItemUserMessage("<environment_context>Injected workspace.</environment_context>", "turn-1"),
      turnContext("turn-1"),
      ...(eventFirst ? [event, input] : [input, event]),
      responseItemUserMessage("<skill>Injected procedure.</skill>", "turn-1"),
      responseMessage("assistant", "The parser selects native input.", "final_answer", "provider-turn"),
      taskComplete("turn-1"),
    ], input, prompt);
  }
});

test("Codex legacy input correlation preserves each input in native archive order", () => {
  const records = [
    sessionMeta("session-1"), taskStarted("turn-1"), turnContext("turn-1"),
    userMessage("Initial input."), responseItemUserMessage("Initial input.", "turn-1"),
    responseMessage("assistant", "Intermediate update.", "commentary"),
    responseItemUserMessage("Revised input.", "turn-1"), userMessage("Revised input."),
    responseItemUserMessage("Injected context.", "turn-1"),
    responseMessage("assistant", "Final reply.", "final_answer"), taskComplete("turn-1"),
  ];
  const identity = { sessionId: "session-1", turnId: "turn-1" };
  const transcript = jsonLines(records);
  const qa = codexRolloutTurnFromJsonLines(transcript, identity);
  const archive = codexCodingSessionTurnFromJsonLines(transcript, identity);
  assert.equal(qa.ok, true);
  assert.equal(archive.ok, true);
  assert.equal(qa.turn.userPrompt, "Revised input.");
  assert.deepEqual(archive.turn.items.map((item) => item.content[0].text), [
    "Initial input.", "Intermediate update.", "Revised input.", "Final reply.",
  ]);
});

test("Codex legacy identity rejects missing, duplicate, and reordered multiple-response associations", () => {
  const cases = [
    { reason: "user_prompt_missing", records: [userMessage("Actual input."), responseItemUserMessage("Injected context.")] },
    { reason: "user_prompt_missing", records: [userMessage(" Actual input. "), responseItemUserMessage("Actual input.")] },
    { reason: "user_prompt_ambiguous", records: [userMessage("Actual input."),
      responseItemUserMessage("Actual input."), responseItemUserMessage("Actual input.")] },
    { reason: "user_prompt_ambiguous", records: [userMessage("Actual input."),
      responseItemUserMessage("Actual input."), userMessage("Actual input.")] },
    { reason: "user_prompt_ambiguous", records: [userMessage("Second."), userMessage("First."),
      responseItemUserMessage("First."), responseItemUserMessage("Second.")] },
    ...[{ turn_id: "other-turn" }, { thread_id: "other-session" }].map((identity) => ({
      reason: "turn_metadata_mismatch", records: [
        { ...userMessage("Actual input."), payload: { ...userMessage("Actual input.").payload, ...identity } },
        responseItemUserMessage("Actual input."),
      ],
    })),
  ];
  for (const { records, reason } of cases) {
    const transcript = jsonLines([
      sessionMeta("session-1"), taskStarted("turn-1"), turnContext("turn-1"), ...records,
      responseItemUserMessage("Unrelated context.", "turn-1"),
      responseMessage("assistant", "Final reply.", "final_answer"), taskComplete("turn-1"),
    ]);
    const identity = { sessionId: "session-1", turnId: "turn-1" };
    assert.deepEqual(codexRolloutTurnFromJsonLines(transcript, identity), { ok: false, reason });
    assert.deepEqual(codexCodingSessionTurnFromJsonLines(transcript, identity), { ok: false, reason });
    assert.deepEqual(codexInterruptedRolloutTurnFromJsonLines(
      transcript + jsonLines([turnAborted("turn-1")]), identity,
    ), { ok: false, reason });
  }
});

test("Codex legacy input cannot borrow a matching response from another native Turn", () => {
  const transcript = jsonLines([
    sessionMeta("session-1"), taskStarted("turn-before"), turnContext("turn-before"),
    responseItemUserMessage("Actual input.", "turn-before"), taskComplete("turn-before"),
    taskStarted("turn-1"), turnContext("turn-1"), userMessage("Actual input."),
    responseItemUserMessage("First context.", "turn-1"), responseItemUserMessage("Second context.", "turn-1"),
    responseMessage("assistant", "Final reply.", "final_answer"), taskComplete("turn-1"),
    taskStarted("turn-after"), responseItemUserMessage("Actual input.", "turn-after"),
  ]);
  const identity = { sessionId: "session-1", turnId: "turn-1" };
  assert.deepEqual(codexRolloutTurnFromJsonLines(transcript, identity), { ok: false, reason: "user_prompt_missing" });
  assert.deepEqual(codexCodingSessionTurnFromJsonLines(transcript, identity), { ok: false, reason: "user_prompt_missing" });
});

test("Codex user identity keeps later context injections out of QA and archive", () => {
  for (const injected of ["<environment_context>Injected workspace.</environment_context>", "<skill>Injected procedure.</skill>"]) {
    const user = responseItemUserMessage("Explain the native parser.", "turn-1");
    user.payload.id = "response-user";
    user.timestamp = "2026-09-01T08:00:00.000Z";
    const earlierContext = responseItemUserMessage(injected, "turn-1");
    earlierContext.payload.id = "native-user";
    const laterContext = responseItemUserMessage(injected, "turn-1");
    laterContext.timestamp = "2026-09-01T08:01:00.000Z";
    assertCodexSelectedUser([
      sessionMeta("session-1"), taskStarted("turn-1"), turnContext("turn-1"),
      earlierContext, user,
      completedUserMessage(["Explain the native parser."], "native-user"),
      { ...userMessage("Different legacy mirror."), payload: { ...userMessage("Different legacy mirror.").payload,
        turn_id: "other-turn", thread_id: "other-session" } },
      laterContext,
      responseMessage("assistant", "The parser selects native input.", "final_answer", "provider-turn"),
      taskComplete("turn-1"),
    ], user, "Explain the native parser.");
  }
});

test("Codex user identity preserves literal context tags and native text blocks", () => {
  for (const text of ["<environment_context>Explain this tag.</environment_context>", "<skill>Explain this tag.</skill>"]) {
    const user = responseItemUserMessage(text, "turn-1");
    user.payload.content.push(
      { type: "input_text", text: "\n" },
      { type: "input_text", text: "" },
      { type: "input_text", text: "  Keep this second block.\n" },
    );
    assertCodexSelectedUser([
      sessionMeta("session-1"), taskStarted("turn-1"), turnContext("turn-1"),
      user,
      completedUserMessage([text, "\n", "", "  Keep this second block.\n"], "native-user"),
      responseItemUserMessage("Unrelated injected context.", "turn-1"),
      responseMessage("assistant", "The tags are literal user text.", "final_answer", "turn-1"),
      taskComplete("turn-1"),
    ], user, `${text}\n  Keep this second block.\n`);
  }
});

test("Codex user identity matches native images without rewriting response text", () => {
  const firstText = "Describe the provided image.";
  const lastText = "Compare its visible labels.";
  const open = '<image path="synthetic.png">';
  const image = { type: "input_image", image_url: "data:image/png;base64,AAAA" };
  for (const nativeType of ["image", "local_image"]) {
    for (const wrapped of [false, true]) {
      const user = responseItemUserMessage(firstText, "turn-1");
      user.payload.content.push(
        ...(wrapped ? [{ type: "input_text", text: open }, image, { type: "input_text", text: "</image>" }] : [image]),
        { type: "input_text", text: lastText },
      );
      const native = completedUserMessage([], "native-image-user");
      native.payload.item.content = [
        { type: "text", text: firstText },
        nativeType === "image" ? { type: nativeType, image_url: image.image_url } : { type: nativeType, path: "synthetic.png" },
        { type: "text", text: lastText },
      ];
      assertCodexSelectedUser([
        sessionMeta("session-1"), taskStarted("turn-1"), turnContext("turn-1"), user, native,
        responseItemUserMessage("Later context is not the user input.", "turn-1"),
        responseMessage("assistant", "The image contains labels.", "final_answer", "turn-1"), taskComplete("turn-1"),
      ], user, wrapped ? `${firstText}\n${open}\n</image>\n${lastText}` : `${firstText}\n${lastText}`);
    }
  }
  const literal = responseItemUserMessage(open, "turn-1");
  literal.payload.content.push({ type: "input_text", text: "</image>" }, { type: "input_text", text: "Explain these literal tags." });
  assertCodexSelectedUser([
    sessionMeta("session-1"), taskStarted("turn-1"), turnContext("turn-1"), literal,
    completedUserMessage([open, "</image>", "Explain these literal tags."], "native-text-user"),
    responseMessage("assistant", "These are literal tags.", "final_answer", "turn-1"), taskComplete("turn-1"),
  ], literal, `${open}\n</image>\nExplain these literal tags.`);
  const literalImage = responseItemUserMessage(open, "turn-1");
  literalImage.payload.content.push(image, { type: "input_text", text: "</image>" }, { type: "input_text", text: lastText });
  const nativeLiteralImage = completedUserMessage([], "native-literal-image");
  nativeLiteralImage.payload.item.content = [
    { type: "text", text: open }, { type: "local_image", path: "synthetic.png" },
    { type: "text", text: "</image>" }, { type: "text", text: lastText },
  ];
  assertCodexSelectedUser([
    sessionMeta("session-1"), taskStarted("turn-1"), turnContext("turn-1"), literalImage, nativeLiteralImage,
    responseMessage("assistant", "Literal tags surround the image.", "final_answer", "turn-1"), taskComplete("turn-1"),
  ], literalImage, `${open}\n</image>\n${lastText}`);
});

test("Codex user identity rejects unmatched image structure and extra context", () => {
  const text = (value) => ({ type: "input_text", text: value });
  const caption = text("Describe the image.");
  const open = text('<image path="synthetic.png">');
  const close = text("</image>");
  const image = { type: "input_image", image_url: "data:image/png;base64,AAAA" };
  const cases = [
    { name: "wrapper without input_image", nativeImage: true, content: [caption, open, close] },
    { name: "image wrapper without native image", nativeImage: false, content: [caption, open, image, close] },
    { name: "different image count", nativeImage: true, content: [caption, image, image] },
    { name: "different image position", nativeImage: true, content: [image, caption] },
    { name: "unknown content does not identify an image", nativeImage: true, content: [caption, { type: "input_file", file_id: "synthetic-file" }] },
    { name: "ordinary context before image", nativeImage: true, content: [caption, text("Extra context."), open, image, close] },
    { name: "ordinary context after image", nativeImage: true, content: [caption, open, image, close, text("Extra context.")] },
    { name: "opening tag includes unrelated text", nativeImage: true, content: [caption, text('<image path="synthetic.png">Extra context.'), image, close] },
    { name: "closing tag includes unrelated text", nativeImage: true, content: [caption, open, image, text("</image>Extra context.")] },
    { name: "opening tag contains prose", nativeImage: true, content: [caption, text("<image arbitrary injected prose>"), image, close] },
    { name: "opening tag contains a newline", nativeImage: true, content: [caption, text('<image\npath="synthetic.png">'), image, close] },
    { name: "opening tag path contains a newline", nativeImage: true, content: [caption, text('<image path="synthetic\n.png">'), image, close] },
  ];
  for (const { name, nativeImage, content } of cases) {
    const user = responseItemUserMessage("Describe the image.", "turn-1");
    user.payload.content = content;
    const native = completedUserMessage(["Describe the image."], "native-user");
    if (nativeImage) native.payload.item.content.push({ type: "local_image", path: "synthetic.png" });
    const transcript = jsonLines([
      sessionMeta("session-1"), taskStarted("turn-1"), turnContext("turn-1"), user, native,
      responseMessage("assistant", "An answer cannot repair the input shape.", "final_answer", "turn-1"), taskComplete("turn-1"),
    ]);
    const identity = { sessionId: "session-1", turnId: "turn-1" };
    assert.deepEqual(codexRolloutTurnFromJsonLines(transcript, identity), { ok: false, reason: "user_prompt_missing" }, name);
    assert.deepEqual(codexCodingSessionTurnFromJsonLines(transcript, identity), { ok: false, reason: "user_prompt_missing" }, name);
  }
});

test("Codex QA selects the last real input while its archive retains every identified input", () => {
  for (const secondText of ["Use the revised input.", "Use the initial input."]) {
    const first = responseItemUserMessage("Use the initial input.", "turn-1");
    first.payload.id = "response-first";
    const last = responseItemUserMessage(secondText, "turn-1");
    last.payload.id = "response-last";
    last.timestamp = "2026-09-01T08:02:00.000Z";
    assertCodexSelectedUser([
      sessionMeta("session-1"), taskStarted("turn-1"), turnContext("turn-1"),
      first, completedUserMessage(["Use the initial input."], "native-first"),
      responseMessage("assistant", "Working on the input.", "commentary", "turn-1"),
      last, completedUserMessage([secondText], "native-last"),
      responseItemUserMessage("<skill>Injected after the real input.</skill>", "turn-1"),
      responseMessage("assistant", "Applied the last input.", "final_answer", "turn-1"),
      taskComplete("turn-1"),
    ], last, secondText, [first, last]);
  }
});

test("Codex user identity treats repeated native message identities as idempotent", () => {
  for (const duplicateBeforeLastEvent of [true, false]) {
    const first = completedUserMessage(["Initial input."], "native-first");
    const initialResponse = responseItemUserMessage("Initial input.", "turn-1");
    const last = responseItemUserMessage("Revised input.", "turn-1");
    last.payload.id = "response-last";
    assertCodexSelectedUser([
      sessionMeta("session-1"), taskStarted("turn-1"), turnContext("turn-1"),
      initialResponse, first,
      last,
      ...(duplicateBeforeLastEvent ? [first] : []),
      completedUserMessage(["Revised input."], "native-last"),
      ...(!duplicateBeforeLastEvent ? [first] : []),
      responseItemUserMessage("Later context must not replace native input.", "turn-1"),
      responseMessage("assistant", "Applied the revised input.", "final_answer", "turn-1"),
      taskComplete("turn-1"),
    ], last, "Revised input.", [initialResponse, last]);
  }
});

test("Codex user identity rejects a repeated native identity with different image content", () => {
  for (const nativeType of ["image", "local_image"]) {
    const user = responseItemUserMessage("Describe the image.", "turn-1");
    user.payload.content.push({ type: "input_image", image_url: "data:image/png;base64,AAAA" });
    const first = completedUserMessage(["Describe the image."], "same-native-id");
    const changed = completedUserMessage(["Describe the image."], "same-native-id");
    first.payload.item.content.push(nativeType === "image"
      ? { type: nativeType, image_url: "data:image/png;base64,AAAA" }
      : { type: nativeType, path: "synthetic-first.png" });
    changed.payload.item.content.push(nativeType === "image"
      ? { type: nativeType, image_url: "data:image/png;base64,BBBB" }
      : { type: nativeType, path: "synthetic-second.png" });
    const transcript = jsonLines([
      sessionMeta("session-1"), taskStarted("turn-1"), turnContext("turn-1"), user, first, changed,
      responseMessage("assistant", "The image has a label.", "final_answer", "turn-1"), taskComplete("turn-1"),
    ]);
    const identity = { sessionId: "session-1", turnId: "turn-1" };
    const failure = { ok: false, reason: "user_prompt_ambiguous" };
    assert.deepEqual(codexRolloutTurnFromJsonLines(transcript, identity), failure, nativeType);
    assert.deepEqual(codexCodingSessionTurnFromJsonLines(transcript, identity), failure, nativeType);
    assert.deepEqual(codexInterruptedRolloutTurnFromJsonLines(
      transcript + jsonLines([turnAborted("turn-1")]), identity,
    ), failure, nativeType);
  }
});

test("Codex user identity fails closed for missing, conflicting, or ambiguous native association", () => {
  const missingThread = completedUserMessage(["Actual input."], "native-user");
  delete missingThread.payload.thread_id;
  const missingTurn = completedUserMessage(["Actual input."], "native-user");
  delete missingTurn.payload.turn_id;
  const otherThread = completedUserMessage(["Actual input."], "native-user");
  otherThread.payload.thread_id = "other-session";
  const cases = [
    { name: "missing matching response", reason: "user_prompt_missing", records: [
      responseItemUserMessage("Injected context.", "turn-1"),
      completedUserMessage(["Actual input."], "native-user"),
    ] },
    { name: "legacy text cannot repair missing modern association", reason: "user_prompt_missing", records: [
      responseItemUserMessage("Injected context.", "turn-1"),
      userMessage("Actual input."),
      completedUserMessage(["Actual input."], "native-user"),
    ] },
    { name: "matching response occurs after the native boundary", reason: "user_prompt_missing", records: [
      completedUserMessage(["Actual input."], "native-user"),
      responseItemUserMessage("Actual input.", "turn-1"),
    ] },
    { name: "empty native input does not allow response fallback", reason: "user_prompt_missing", records: [
      responseItemUserMessage("Actual input.", "turn-1"), completedUserMessage([], "native-user"),
    ] },
    { name: "missing native thread", reason: "turn_metadata_mismatch", records: [
      responseItemUserMessage("Actual input.", "turn-1"), missingThread,
    ] },
    { name: "missing native turn", reason: "turn_metadata_mismatch", records: [
      responseItemUserMessage("Actual input.", "turn-1"), missingTurn,
    ] },
    { name: "conflicting native thread", reason: "turn_metadata_mismatch", records: [
      responseItemUserMessage("Actual input.", "turn-1"), otherThread,
    ] },
    { name: "conflicting native turn", reason: "turn_metadata_mismatch", records: [
      responseItemUserMessage("Actual input.", "turn-1"),
      completedUserMessage(["Actual input."], "native-user", "other-turn"),
    ] },
    { name: "indistinguishable earlier candidates", reason: "user_prompt_ambiguous", records: [
      responseItemUserMessage("Actual input.", "turn-1"),
      responseItemUserMessage("Actual input.", "turn-1"),
      completedUserMessage(["Actual input."], "native-user"),
    ] },
    { name: "missing native item identity", reason: "user_prompt_ambiguous", records: [
      responseItemUserMessage("Actual input.", "turn-1"),
      completedUserMessage(["Actual input."], undefined),
    ] },
    { name: "conflicting repeated native identity", reason: "user_prompt_ambiguous", records: [
      responseItemUserMessage("Initial input.", "turn-1"),
      completedUserMessage(["Initial input."], "same-native-id"),
      responseItemUserMessage("Revised input.", "turn-1"),
      completedUserMessage(["Revised input."], "same-native-id"),
    ] },
    { name: "joined text is not identical text blocks", reason: "user_prompt_missing", records: [
      responseItemUserMessage("First block.\nSecond block.", "turn-1"),
      completedUserMessage(["First block.", "Second block."], "native-user"),
    ] },
    { name: "response-only multiple candidates", reason: "user_prompt_ambiguous", records: [
      responseItemUserMessage("Initial candidate.", "turn-1"),
      responseItemUserMessage("Later candidate.", "turn-1"),
    ] },
  ];
  for (const { name, records, reason } of cases) {
    const transcript = jsonLines([
      sessionMeta("session-1"), taskStarted("turn-1"), turnContext("turn-1"),
      ...records,
      responseMessage("assistant", "A final reply cannot repair user identity.", "final_answer", "turn-1"),
      taskComplete("turn-1"),
    ]);
    const identity = { sessionId: "session-1", turnId: "turn-1" };
    assert.deepEqual(codexRolloutTurnFromJsonLines(transcript, identity), { ok: false, reason }, name);
    assert.deepEqual(codexCodingSessionTurnFromJsonLines(transcript, identity), { ok: false, reason }, name);
    assert.deepEqual(codexInterruptedRolloutTurnFromJsonLines(
      transcript + jsonLines([turnAborted("turn-1")]), identity,
    ), { ok: false, reason }, name);
  }
});

test("Codex user identity cannot borrow matching response text from another turn", () => {
  const transcript = jsonLines([
    sessionMeta("session-1"), taskStarted("earlier-turn"), turnContext("earlier-turn"),
    responseItemUserMessage("Repeated input.", "earlier-turn"),
    completedUserMessage(["Repeated input."], "native-earlier", "earlier-turn"),
    responseMessage("assistant", "Earlier answer.", "final_answer", "earlier-turn"),
    taskComplete("earlier-turn"),
    taskStarted("turn-1"), turnContext("turn-1"),
    responseItemUserMessage("Unrelated injected context.", "turn-1"),
    completedUserMessage(["Repeated input."], "native-target"),
    responseMessage("assistant", "Target answer.", "final_answer", "turn-1"),
    taskComplete("turn-1"),
  ]);
  const identity = { sessionId: "session-1", turnId: "turn-1" };
  assert.deepEqual(codexRolloutTurnFromJsonLines(transcript, identity), {
    ok: false, reason: "user_prompt_missing",
  });
  assert.deepEqual(codexCodingSessionTurnFromJsonLines(transcript, identity), {
    ok: false, reason: "user_prompt_missing",
  });
});

test("Codex rollout reader fails closed for conflicting user response_item turn metadata", () => {
  const transcript = jsonLines([
    sessionMeta("session-1"),
    taskStarted("turn-1"),
    turnContext("turn-1"),
    responseItemUserMessage("Current-format prompt.", "other-turn"),
    userMessage("Legacy prompt."),
    responseMessage("assistant", "Current-format final reply.", "final_answer", "provider-turn"),
    agentMessage("Legacy final reply.", "final_answer"),
    taskComplete("turn-1", "Legacy final reply."),
  ]);

  assert.deepEqual(codexRolloutTurnFromJsonLines(transcript, {
    sessionId: "session-1",
    turnId: "turn-1",
  }), { ok: false, reason: "turn_metadata_mismatch" });

  assert.deepEqual(codexCodingSessionTurnFromJsonLines(transcript, {
    sessionId: "session-1",
    turnId: "turn-1",
  }), { ok: false, reason: "turn_metadata_mismatch" });

  assert.deepEqual(codexInterruptedRolloutTurnFromJsonLines(jsonLines([
    sessionMeta("session-1"),
    taskStarted("turn-1"),
    turnContext("turn-1"),
    responseItemUserMessage("Current-format prompt.", "other-turn"),
    userMessage("Legacy prompt."),
    agentMessage("Visible partial reply.", "commentary"),
    turnAborted("turn-1"),
  ]), {
    sessionId: "session-1",
    turnId: "turn-1",
  }), { ok: false, reason: "turn_metadata_mismatch" });
});

test("Codex rollout reader aggregates cumulative token snapshots for the complete turn", () => {
  const baseline = tokenUsage({
    input_tokens: 100,
    cached_input_tokens: 40,
    cache_write_input_tokens: 2,
    output_tokens: 10,
    reasoning_output_tokens: 3,
  });
  const first = tokenUsage({
    input_tokens: 160,
    cached_input_tokens: 70,
    cache_write_input_tokens: 2,
    output_tokens: 15,
    reasoning_output_tokens: 5,
  });
  delete baseline.cache_write_input_tokens;
  delete first.cache_write_input_tokens;
  const reset = tokenUsage({
    input_tokens: 50,
    cached_input_tokens: 20,
    cache_write_input_tokens: 0,
    output_tokens: 4,
    reasoning_output_tokens: 1,
  });
  const afterReset = tokenUsage({
    input_tokens: 90,
    cached_input_tokens: 45,
    cache_write_input_tokens: 1,
    output_tokens: 9,
    reasoning_output_tokens: 3,
  });
  const transcript = jsonLines([
    sessionMeta("session-1"),
    tokenCount(baseline),
    taskStarted("turn-1"),
    userMessage("Prompt."),
    tokenCount(first),
    tokenCount(first, { rate_limits: { primary: { used_percent: 1 } } }),
    tokenCount(reset),
    tokenCount(afterReset),
    agentMessage("Reply.", "final_answer"),
    taskComplete("turn-1", "Reply."),
    tokenCount(tokenUsage({
      input_tokens: 200,
      cached_input_tokens: 100,
      cache_write_input_tokens: 2,
      output_tokens: 20,
      reasoning_output_tokens: 8,
    })),
  ]);

  assert.deepEqual(codexRolloutTurnFromJsonLines(transcript, {
    sessionId: "session-1",
    turnId: "turn-1",
  }), {
    ok: true,
    turn: {
      sessionId: "session-1",
      turnId: "turn-1",
      userPrompt: "Prompt.",
      assistantReply: "Reply.",
      userTimestamp: Date.parse("2026-07-16T00:00:03.000Z"),
      assistantTimestamp: Date.parse("2026-07-16T00:00:05.000Z"),
      activities: [],
      usage: {
        input_tokens: 100,
        cached_input_tokens: 55,
        cache_write_input_tokens: 1,
        output_tokens: 10,
        reasoning_output_tokens: 4,
        total_tokens: 110,
      },
    },
  });
});

test("Codex rollout reader records ordered repo-memory and memory CLI activities", () => {
  const pluginRoot = "/Users/test/.codex/plugins/cache/memorax-code/memorax-code-codex-adapter/0.1.11";
  const windowsPluginRoot = String.raw`C:\Users\test\.codex\plugins\cache\memorax-code\memorax-code-codex-adapter\0.1.11`;
  const transcript = jsonLines([
    sessionMeta("session-1", "vscode"),
    taskStarted("turn-1"),
    userMessage("Use repository memory, then search and add."),
    customToolCall(`const r = await tools.exec_command({ cmd: "sed -n '1,200p' ${pluginRoot}/skills/memorax-code/references/repo-build.md" });`),
    customToolCall(`const r = await tools.exec_command({ cmd: "type ${windowsPluginRoot}\\skills\\memorax-code\\references\\repo-build.md" });`),
    customToolCall(`const r = await tools.exec_command({ cmd: "sed -n '1,200p' ${pluginRoot}/skills/memorax-code/references/repo-read.md && sed -n '1,200p' ${pluginRoot}/skills/memorax-code/references/repo-update.md" });`),
    customToolCall('const r = await tools.exec_command({"cmd":"memorax-cli.cmd search --query \\"prior context\\""});'),
    customToolCall('const r = await tools.exec_command({ cmd: "git status --short" });'),
    customToolCall('const r = await tools.exec_command({ cmd: "memorax-cli add --message \\"reusable lesson\\"" });'),
    agentMessage("Done.", "final_answer"),
  ]);

  const result = codexRolloutTurnFromJsonLines(transcript, {
    sessionId: "session-1",
    turnId: "turn-1",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.turn.activities, [
    { index: 1, type: "repo_memory_operation", operation: "repo-build" },
    { index: 2, type: "repo_memory_operation", operation: "repo-read" },
    { index: 2, type: "repo_memory_operation", operation: "repo-update" },
    { index: 3, type: "memory_cli_search" },
    { index: 4, type: "memory_cli_add" },
  ]);
});

test("Codex rollout reader uses the file header authority across imported history", () => {
  const pluginRoot = "/Users/test/.codex/plugins/cache/memorax-code/memorax-code-codex-adapter/0.1.11";
  const vscodeTranscript = jsonLines([
    sessionMeta("session-current", "vscode"),
    sessionMeta("session-imported", "exec"),
    taskStarted("turn-imported"),
    userMessage("Imported prompt."),
    taskComplete("turn-imported", "Imported reply."),
    taskStarted("turn-target"),
    turnContext("turn-target"),
    userMessage("Current prompt."),
    customToolCall(`const r = await tools.exec_command({ cmd: "sed -n '1,200p' ${pluginRoot}/skills/memorax-code/references/repo-read.md" });`),
    tokenCount(tokenUsage({
      input_tokens: 120,
      cached_input_tokens: 40,
      cache_write_input_tokens: 0,
      output_tokens: 12,
      reasoning_output_tokens: 2,
    })),
    agentMessage("Current reply.", "final_answer"),
  ]);

  assert.deepEqual(codexRolloutTurnFromJsonLines(vscodeTranscript, {
    sessionId: "session-current",
    turnId: "turn-target",
  }), {
    ok: true,
    turn: {
      sessionId: "session-current",
      turnId: "turn-target",
      userPrompt: "Current prompt.",
      assistantReply: "Current reply.",
      userTimestamp: Date.parse("2026-07-16T00:00:03.000Z"),
      assistantTimestamp: Date.parse("2026-07-16T00:00:04.000Z"),
      activities: [{ index: 1, type: "repo_memory_operation", operation: "repo-read" }],
    },
  });

  const execTranscript = jsonLines([
    sessionMeta("session-current", "exec"),
    sessionMeta("session-imported", "vscode"),
    taskStarted("turn-target"),
    userMessage("Background prompt."),
    customToolCall(`const r = await tools.exec_command({ cmd: "sed -n '1,200p' ${pluginRoot}/skills/memorax-code/references/repo-read.md" });`),
    agentMessage("Background reply.", "final_answer"),
  ]);
  const execResult = codexRolloutTurnFromJsonLines(execTranscript, {
    sessionId: "session-current",
    turnId: "turn-target",
  });
  assert.equal(execResult.ok, true);
  assert.deepEqual(execResult.turn.activities, []);
});

test("Codex rollout reader treats repeated authority session metadata as idempotent", () => {
  const usage = tokenUsage({
    input_tokens: 30,
    cached_input_tokens: 12,
    cache_write_input_tokens: 0,
    output_tokens: 6,
    reasoning_output_tokens: 2,
  });
  const transcript = jsonLines([
    sessionMeta("session-1", "vscode"),
    sessionMeta("session-1", "vscode"),
    taskStarted("turn-1"),
    turnContext("turn-1"),
    userMessage("Prompt from a resumed session."),
    tokenCount(usage),
    sessionMeta("session-1", "vscode"),
    agentMessage("Reply from a resumed session.", "final_answer"),
  ]);

  assert.deepEqual(codexRolloutTurnFromJsonLines(transcript, {
    sessionId: "session-1",
    turnId: "turn-1",
  }), {
    ok: true,
    turn: {
      sessionId: "session-1",
      turnId: "turn-1",
      userPrompt: "Prompt from a resumed session.",
      assistantReply: "Reply from a resumed session.",
      userTimestamp: Date.parse("2026-07-16T00:00:03.000Z"),
      assistantTimestamp: Date.parse("2026-07-16T00:00:04.000Z"),
      activities: [],
      usage,
    },
  });
});

test("Codex interrupted rollout reader preserves visible partial output, usage, and activities", () => {
  const baseline = tokenUsage({
    input_tokens: 100,
    cached_input_tokens: 40,
    cache_write_input_tokens: 0,
    output_tokens: 10,
    reasoning_output_tokens: 3,
  });
  const afterWork = tokenUsage({
    input_tokens: 140,
    cached_input_tokens: 60,
    cache_write_input_tokens: 0,
    output_tokens: 15,
    reasoning_output_tokens: 4,
  });
  const transcript = jsonLines([
    sessionMeta("session-1"),
    tokenCount(baseline),
    taskStarted("turn-1"),
    turnContext("turn-1"),
    userMessage("Prompt interrupted after visible progress."),
    agentMessage("First visible update.", "commentary"),
    customToolCall('const r = await tools.exec_command({ cmd: "memorax-cli search --query \\"prior context\\"" });'),
    tokenCount(afterWork),
    agentMessage("Second visible update.", "commentary"),
    turnAborted("turn-1"),
    taskStarted("turn-2"),
    userMessage("Next prompt."),
    agentMessage("Next reply.", "final_answer"),
  ]);

  assert.deepEqual(codexInterruptedRolloutTurnFromJsonLines(transcript, {
    sessionId: "session-1",
    turnId: "turn-1",
  }), {
    ok: true,
    turn: {
      sessionId: "session-1",
      turnId: "turn-1",
      userPrompt: "Prompt interrupted after visible progress.",
      assistantReply: "First visible update.\n\nSecond visible update.",
      activities: [{ index: 1, type: "memory_cli_search" }],
      usage: {
        input_tokens: 40,
        cached_input_tokens: 20,
        cache_write_input_tokens: 0,
        output_tokens: 5,
        reasoning_output_tokens: 1,
        total_tokens: 45,
      },
      interruptedAt: "2026-07-16T00:00:04.500Z",
      sessionTurnIndex: 1,
    },
  });
});

test("Codex interrupted rollout reader omits a guessed turn index for imported history", () => {
  const transcript = jsonLines([
    sessionMeta("session-current", "vscode"),
    sessionMeta("session-imported", "vscode"),
    taskStarted("turn-imported"),
    turnContext("turn-imported"),
    userMessage("Imported prompt."),
    taskComplete("turn-imported", "Imported reply."),
    taskStarted("turn-target"),
    turnContext("turn-target"),
    userMessage("Current interrupted prompt."),
    agentMessage("Visible progress.", "commentary"),
    turnAborted("turn-target"),
  ]);

  assert.deepEqual(codexInterruptedRolloutTurnFromJsonLines(transcript, {
    sessionId: "session-current",
    turnId: "turn-target",
  }), {
    ok: true,
    turn: {
      sessionId: "session-current",
      turnId: "turn-target",
      userPrompt: "Current interrupted prompt.",
      assistantReply: "Visible progress.",
      activities: [],
      interruptedAt: "2026-07-16T00:00:04.500Z",
    },
  });
});

test("Codex interrupted rollout reader accepts an empty visible assistant response", () => {
  const transcript = jsonLines([
    sessionMeta("session-1"),
    taskStarted("turn-1"),
    turnContext("turn-1"),
    userMessage("Prompt interrupted before visible output."),
    turnAborted("turn-1"),
  ]);

  assert.deepEqual(codexInterruptedRolloutTurnFromJsonLines(transcript, {
    sessionId: "session-1",
    turnId: "turn-1",
  }), {
    ok: true,
    turn: {
      sessionId: "session-1",
      turnId: "turn-1",
      userPrompt: "Prompt interrupted before visible output.",
      assistantReply: "",
      activities: [],
      interruptedAt: "2026-07-16T00:00:04.500Z",
      sessionTurnIndex: 1,
    },
  });
});

test("Codex interrupted rollout reader derives the session turn index in the same scan", () => {
  const transcript = jsonLines([
    sessionMeta("session-1"),
    taskStarted("turn-1"),
    turnContext("turn-1"),
    userMessage("Completed prompt."),
    taskComplete("turn-1", "Completed reply."),
    taskStarted("turn-2"),
    turnContext("turn-2"),
    userMessage("Interrupted second prompt."),
    turnAborted("turn-2"),
  ]);

  const result = codexInterruptedRolloutTurnFromJsonLines(transcript, {
    sessionId: "session-1",
    turnId: "turn-2",
  });
  assert.equal(result.ok, true);
  assert.equal(result.turn.sessionTurnIndex, 2);
});

test("Codex interrupted rollout reader leaves edited and rolled-back prompts unresolved", () => {
  const transcript = jsonLines([
    sessionMeta("session-1"),
    taskStarted("turn-1"),
    turnContext("turn-1"),
    userMessage("Original prompt."),
    agentMessage("Visible output from the original prompt.", "commentary"),
    turnAborted("turn-1"),
    threadRolledBack(),
    taskStarted("turn-2"),
    userMessage("Edited prompt."),
  ]);

  assert.deepEqual(codexInterruptedRolloutTurnFromJsonLines(transcript, {
    sessionId: "session-1",
    turnId: "turn-1",
  }), { ok: false, reason: "turn_rolled_back" });
});

test("Codex interrupted rollout reader ignores rollback from a later turn", () => {
  const transcript = jsonLines([
    sessionMeta("session-1"),
    taskStarted("turn-1"),
    turnContext("turn-1"),
    userMessage("Ordinary interrupted prompt."),
    agentMessage("Visible output before interruption.", "commentary"),
    turnAborted("turn-1"),
    taskStarted("turn-2"),
    userMessage("A later prompt."),
    turnAborted("turn-2"),
    threadRolledBack(),
  ]);

  const result = codexInterruptedRolloutTurnFromJsonLines(transcript, {
    sessionId: "session-1",
    turnId: "turn-1",
  });
  assert.equal(result.ok, true);
  assert.equal(result.turn.assistantReply, "Visible output before interruption.");
});

test("Codex rollout reader attributes background repo-memory launchers to the parent turn only", () => {
  const pluginRoot = "/Users/test/.codex/plugins/cache/memorax-code/memorax-code-codex-adapter/0.1.11";
  const parent = codexRolloutTurnFromJsonLines(jsonLines([
    sessionMeta("parent-session", "vscode"),
    taskStarted("parent-turn"),
    userMessage("Start repository memory jobs."),
    customToolCall(`const r = await tools.exec_command({ cmd: "node \\"${pluginRoot}/hooks/repo-memory-job.mjs\\" start --mode build --repo /repo" });`),
    customToolCall(`const r = await tools.exec_command({ cmd: "node \\"${pluginRoot}/hooks/repo-memory-job.mjs\\" start --mode=update --repo /repo" });`),
    agentMessage("Jobs started.", "final_answer"),
  ]), {
    sessionId: "parent-session",
    turnId: "parent-turn",
  });
  assert.equal(parent.ok, true);
  assert.deepEqual(parent.turn.activities, [
    { index: 1, type: "repo_memory_operation", operation: "repo-build" },
    { index: 2, type: "repo_memory_operation", operation: "repo-update" },
  ]);

  const child = codexRolloutTurnFromJsonLines(jsonLines([
    sessionMeta("child-session", "exec"),
    taskStarted("child-turn"),
    userMessage("Background builder task."),
    customToolCall(`const r = await tools.exec_command({ cmd: "sed -n '1,240p' ${pluginRoot}/skills/memorax-code/references/repo-build.md" });`),
    agentMessage("Build complete.", "final_answer"),
  ]), {
    sessionId: "child-session",
    turnId: "child-turn",
  });
  assert.equal(child.ok, true);
  assert.deepEqual(child.turn.activities, []);
});

test("Codex rollout reader does not treat source review or command text as an activity", () => {
  const transcript = jsonLines([
    sessionMeta("session-1", "vscode"),
    taskStarted("turn-1"),
    userMessage("Review repo-memory implementation."),
    customToolCall('const r = await tools.exec_command({ cmd: "sed -n \'1,200p\' packages/ts/memorax-code-codex-adapter/skills/memorax-code/references/repo-read.md" });'),
    customToolCall('const r = await tools.exec_command({ cmd: "sed -n \'1,200p\' /Users/test/.codex/plugins/cache/memorax-code/memorax-code-codex-adapter/0.1.11/skills/memorax-code/SKILL.md" });'),
    customToolCall('const r = await tools.exec_command({ cmd: "rg -n \'memorax-cli search\' docs" });'),
    customToolCall('const r = await tools.exec_command({ cmd: "node packages/ts/memorax-code-codex-adapter/hooks/repo-memory-job.mjs start --mode build --repo ." });'),
    agentMessage("Reviewed.", "final_answer"),
  ]);

  const result = codexRolloutTurnFromJsonLines(transcript, {
    sessionId: "session-1",
    turnId: "turn-1",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.turn.activities, []);
});

test("Codex rollout reader fails closed for session, turn, and content mismatches", () => {
  const base = [
    sessionMeta("session-1"),
    taskStarted("turn-1"),
    userMessage("Prompt."),
    agentMessage("Reply.", "final_answer"),
  ];

  assert.deepEqual(codexRolloutTurnFromJsonLines(jsonLines(base), {
    sessionId: "other-session",
    turnId: "turn-1",
  }), { ok: false, reason: "transcript_session_mismatch" });
  assert.deepEqual(codexRolloutTurnFromJsonLines(jsonLines([
    taskStarted("turn-before-header"),
    sessionMeta("session-1"),
    taskStarted("turn-1"),
    userMessage("Prompt."),
    agentMessage("Reply.", "final_answer"),
  ]), {
    sessionId: "session-1",
    turnId: "turn-1",
  }), { ok: false, reason: "transcript_session_mismatch" });
  assert.deepEqual(codexRolloutTurnFromJsonLines([
    "{malformed-json",
    jsonLines([
      sessionMeta("session-1"),
      taskStarted("turn-1"),
      userMessage("Prompt."),
      agentMessage("Reply.", "final_answer"),
    ]),
  ].join("\n"), {
    sessionId: "session-1",
    turnId: "turn-1",
  }), { ok: false, reason: "transcript_session_mismatch" });
  assert.deepEqual(codexRolloutTurnFromJsonLines(jsonLines([
    sessionMeta("other-session"),
    sessionMeta("session-1"),
    taskStarted("turn-1"),
    userMessage("Prompt."),
    agentMessage("Reply.", "final_answer"),
  ]), {
    sessionId: "session-1",
    turnId: "turn-1",
  }), { ok: false, reason: "transcript_session_mismatch" });
  assert.deepEqual(codexRolloutTurnFromJsonLines(jsonLines([
    { type: "session_meta", payload: { session_id: "session-1" } },
    taskStarted("turn-1"),
    userMessage("Prompt."),
    agentMessage("Reply.", "final_answer"),
  ]), {
    sessionId: "session-1",
    turnId: "turn-1",
  }), { ok: false, reason: "transcript_session_mismatch" });
  assert.deepEqual(codexRolloutTurnFromJsonLines(jsonLines([
    sessionMeta("session-1"),
    { type: "session_meta", payload: {} },
    taskStarted("turn-1"),
    userMessage("Prompt."),
    agentMessage("Reply.", "final_answer"),
  ]), {
    sessionId: "session-1",
    turnId: "turn-1",
  }), { ok: false, reason: "transcript_session_mismatch" });
  for (const trailingSessionMeta of [
    sessionMeta("other-session"),
    { type: "session_meta", payload: {} },
  ]) {
    assert.deepEqual(codexRolloutTurnFromJsonLines(jsonLines([
      sessionMeta("session-1"),
      taskStarted("turn-1"),
      userMessage("Prompt."),
      trailingSessionMeta,
      agentMessage("Reply.", "final_answer"),
    ]), {
      sessionId: "session-1",
      turnId: "turn-1",
    }), { ok: false, reason: "transcript_session_mismatch" });
  }
  assert.deepEqual(codexRolloutTurnFromJsonLines(jsonLines(base), {
    sessionId: "session-1",
    turnId: "missing-turn",
  }), { ok: false, reason: "turn_not_found" });
  assert.deepEqual(codexRolloutTurnFromJsonLines(jsonLines([
    sessionMeta("session-1"),
    taskStarted("turn-1"),
    agentMessage("Reply.", "final_answer"),
  ]), {
    sessionId: "session-1",
    turnId: "turn-1",
  }), { ok: false, reason: "user_prompt_missing" });
  assert.deepEqual(codexRolloutTurnFromJsonLines(jsonLines([
    sessionMeta("session-1"),
    taskStarted("turn-1"),
    userMessage("Prompt."),
    agentMessage("Only commentary.", "commentary"),
  ]), {
    sessionId: "session-1",
    turnId: "turn-1",
  }), { ok: false, reason: "assistant_message_missing" });
});

test("Codex rollout reader reports an unavailable transcript without throwing", async () => {
  const result = await readCodexRolloutTurn({
    transcriptPath: "/path/that/does/not/exist.jsonl",
    sessionId: "session-1",
    turnId: "turn-1",
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "transcript_unavailable");
  assert.equal(typeof result.error, "string");
});

test("Codex interrupted rollout reader reports an unavailable transcript without throwing", async () => {
  const result = await readCodexInterruptedRolloutTurn({
    transcriptPath: "/path/that/does/not/exist.jsonl",
    sessionId: "session-1",
    turnId: "turn-1",
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "transcript_unavailable");
  assert.equal(typeof result.error, "string");
});

function assertCodexSelectedUser(records, expectedResponse, expectedPrompt, expectedArchiveUsers = [expectedResponse]) {
  const transcript = jsonLines(records);
  const identity = { sessionId: "session-1", turnId: "turn-1" };
  const qa = codexRolloutTurnFromJsonLines(transcript, identity);
  const archive = codexCodingSessionTurnFromJsonLines(transcript, identity);
  assert.equal(qa.ok, true);
  assert.equal(archive.ok, true);
  const { items, closedAt, sessionTurnIndex, ...archiveQa } = archive.turn;
  assert.deepEqual(archiveQa, qa.turn);
  assert.equal(qa.turn.userPrompt, expectedPrompt);
  assert.equal(qa.turn.userTimestamp, Date.parse(expectedResponse.timestamp));
  assert.deepEqual(items.filter((item) => item.type === "message" && item.role === "user"), expectedArchiveUsers.map((response) => ({
    type: "message", role: "user",
    ...(response.payload.id ? { id: response.payload.id } : {}),
    content: response.payload.content.filter((part) => part.type === "input_text")
      .map(({ text }) => ({ type: "input_text", text })),
  })));
}

function completedUserMessage(texts, id, turnId = "turn-1") {
  return {
    timestamp: "2026-09-01T08:00:00.100Z",
    type: "event_msg",
    payload: {
      type: "item_completed", thread_id: "session-1", turn_id: turnId,
      item: { type: "UserMessage", id, content: texts.map((text) => ({ type: "text", text })) },
    },
  };
}

function jsonLines(records) {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

function sessionMeta(sessionId, source) {
  return { timestamp: "2026-07-16T00:00:00.000Z", type: "session_meta", payload: { id: sessionId, source } };
}

function taskStarted(turnId) {
  return { timestamp: "2026-07-16T00:00:01.000Z", type: "event_msg", payload: { type: "task_started", turn_id: turnId } };
}

function turnContext(turnId) {
  return { timestamp: "2026-07-16T00:00:02.000Z", type: "turn_context", payload: { turn_id: turnId } };
}

function userMessage(message) {
  return { timestamp: "2026-07-16T00:00:03.000Z", type: "event_msg", payload: { type: "user_message", message } };
}

function agentMessage(message, phase) {
  return { timestamp: "2026-07-16T00:00:04.000Z", type: "event_msg", payload: { type: "agent_message", message, phase } };
}

function taskComplete(turnId, lastAgentMessage) {
  return {
    timestamp: "2026-07-16T00:00:05.000Z",
    type: "event_msg",
    payload: { type: "task_complete", turn_id: turnId, last_agent_message: lastAgentMessage },
  };
}

function turnAborted(turnId, reason = "interrupted") {
  return {
    timestamp: "2026-07-16T00:00:04.500Z",
    type: "event_msg",
    payload: { type: "turn_aborted", turn_id: turnId, reason },
  };
}

function threadRolledBack() {
  return {
    timestamp: "2026-07-16T00:00:04.750Z",
    type: "event_msg",
    payload: { type: "thread_rolled_back", num_turns: 1 },
  };
}

function tokenCount(totalTokenUsage, extra = {}) {
  return {
    timestamp: "2026-07-16T00:00:03.500Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: { total_token_usage: totalTokenUsage },
      ...extra,
    },
  };
}

function tokenUsage(usage) {
  return {
    ...usage,
    total_tokens: usage.input_tokens + usage.output_tokens,
  };
}

function responseMessage(role, text, phase, turnId) {
  return {
    timestamp: "2026-07-16T00:00:04.000Z",
    type: "response_item",
    payload: {
      type: "message",
      role,
      phase,
      content: [{ type: "output_text", text }],
      ...(turnId ? { internal_chat_message_metadata_passthrough: { turn_id: turnId } } : {}),
    },
  };
}

function responseItemUserMessage(text, turnId) {
  return {
    timestamp: "2026-07-16T00:00:03.000Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text }],
      ...(turnId ? { internal_chat_message_metadata_passthrough: { turn_id: turnId } } : {}),
    },
  };
}

function customToolCall(input) {
  return {
    timestamp: "2026-07-16T00:00:03.500Z",
    type: "response_item",
    payload: { type: "custom_tool_call", name: "exec", input },
  };
}
