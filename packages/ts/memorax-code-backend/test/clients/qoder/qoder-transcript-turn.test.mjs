import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  MAX_QODER_TRANSCRIPT_BYTES,
  readQoderTranscriptTurn,
} from "../../../dist/clients/qoder/transcript-turn.js";

const sessionId = "session-1";
const turnId = "request-1";
const cwd = resolve("qoder-test-workspace");

test("reads only the original human input and the final end_turn text on the exact native chain", async (t) => {
  const fixture = await createFixture(t);
  const records = [
    human(turnId, null, "  Keep this\n\nprompt.  "),
    node("attachment", "attached", turnId),
    assistant("reasoning", "attached", null, [{ type: "thinking" }]),
    assistant("progress", "reasoning", null, [{ type: "text", text: "Intermediate progress." }]),
    assistant("call", "progress", "tool_use", [{ type: "tool_use", id: "tool-1", name: "Read", input: {} }]),
    node("user", "result", "call", { message: {
      role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", content: "Tool output." }],
    } }),
    node("user", "skill", "result", { isMeta: true, message: { role: "user", content: "Expanded Skill instructions." } }),
    assistant("final", "skill", "end_turn", [
      { type: "text", text: "  Final reply." },
      { type: "thinking" },
      { type: "tool_use", id: "ignored-tool", name: "Read", input: {} },
      { type: "text", text: "Second paragraph.  " },
    ]),
    activeLeaf("final"),
    { type: "last-prompt", sessionId, lastPrompt: "Metadata must not replace the prompt." },
  ];
  records[0].timestamp = "2026-01-01T00:00:00.000Z";
  records[7].timestamp = "2026-01-01T00:01:00.000Z";
  const result = await fixture.read(records);
  assert.deepEqual(result, { ok: true, turn: {
    userPrompt: "  Keep this\n\nprompt.  ",
    assistantReply: "  Final reply.\nSecond paragraph.  ",
    cwd,
    userTimestamp: Date.parse("2026-01-01T00:00:00.000Z"),
    assistantTimestamp: Date.parse("2026-01-01T00:01:00.000Z"),
  } });
});

test("reads an earlier exact turn after later human turns extend the same branch", async (t) => {
  const fixture = await createFixture(t);
  const records = [
    ...completedTurn(turnId, null, "Repeated prompt.", "First reply."),
    ...completedTurn("request-2", "final-request-1", "Repeated prompt.", "Second reply."),
    activeLeaf("final-request-2"),
  ];
  const first = await fixture.read(records);
  const second = await fixture.read(records, "request-2");
  assert.equal(first.ok, true);
  assert.equal(first.turn.assistantReply, "First reply.");
  assert.equal(second.ok, true);
  assert.equal(second.turn.assistantReply, "Second reply.");
  assert.deepEqual(await fixture.read(records, "absent-request"), { ok: false, reason: "turn_not_found" });
});

test("reads native parallel tool batches whose earlier results are leaves beside the active path", async (t) => {
  const fixture = await createFixture(t);
  for (const count of [2, 3]) {
    const records = parallelToolTurn(count);
    records[0].timestamp = "2026-01-01T00:00:00.000Z";
    records.find((record) => record.uuid === "final").timestamp = "2026-01-01T00:01:00.000Z";
    records.find((record) => record.uuid === "result-1").message.content[0].is_error = true;
    records.push(...completedTurn("later-request", "final"), activeLeaf("final-later-request"));
    assert.deepEqual(await fixture.read(records), { ok: true, turn: {
      userPrompt: "Prompt.", assistantReply: "Final reply.", cwd,
      userTimestamp: Date.parse("2026-01-01T00:00:00.000Z"),
      assistantTimestamp: Date.parse("2026-01-01T00:01:00.000Z"),
    } });
  }
});

test("reads successive parallel batches separated by assistant progress", async (t) => {
  const fixture = await createFixture(t);
  const first = parallelToolTurn(2).filter((record) => record.uuid !== "final" && record.type !== "active-leaf");
  first.push(assistant("between-batches", "result-2", null, [{ type: "text", text: "More work." }]));
  const second = parallelToolTurn().filter((record) => record.uuid !== turnId);
  for (const record of second) {
    if (record.uuid) record.uuid = `second-${record.uuid}`;
    if (record.parentUuid) record.parentUuid = record.parentUuid === turnId ? "between-batches" : `second-${record.parentUuid}`;
    if (record.leafUuid) record.leafUuid = `second-${record.leafUuid}`;
    if (record.message?.id) record.message.id = "second-batch";
    for (const block of record.message?.content ?? []) {
      if (block.type === "tool_use") block.id = `second-${block.id}`;
      if (block.type === "tool_result") block.tool_use_id = `second-${block.tool_use_id}`;
    }
  }
  assert.deepEqual(await fixture.read([...first, ...second]), {
    ok: true, turn: { userPrompt: "Prompt.", assistantReply: "Final reply.", cwd },
  });
});

test("parallel tool result leaves require a complete batch with unique native call and result identities", async (t) => {
  const fixture = await createFixture(t);
  const find = (records, uuid) => records.find((record) => record.uuid === uuid);
  for (const [label, change] of [
    ["wrong result ID", (r) => { find(r, "result-1").message.content[0].tool_use_id = "unknown-tool"; }],
    ["duplicate call ID", (r) => { find(r, "call-2").message.content[0].id = "tool-1"; }],
    ["duplicate result ID", (r) => { r.push({ ...structuredClone(find(r, "result-1")), uuid: "duplicate-result" }); }],
    ["missing earlier result", (r) => { r.splice(r.indexOf(find(r, "result-1")), 1); }],
    ["wrong result parent", (r) => { find(r, "result-1").parentUuid = "call-2"; }],
    ["different assistant batch", (r) => { find(r, "call-2").message.id = "other-batch"; }],
    ["missing assistant batch ID", (r) => { delete find(r, "call-2").message.id; }],
    ["broken call sequence", (r) => { find(r, "call-2").parentUuid = turnId; }],
    ["early batch stop", (r) => { find(r, "call-1").message.stop_reason = "tool_use"; }],
    ["missing batch stop", (r) => { find(r, "call-3").message.stop_reason = null; }],
    ["result has text", (r) => { find(r, "result-1").message.content.push({ type: "text", text: "Other branch." }); }],
    ["wrong result role", (r) => { find(r, "result-1").message.role = "assistant"; }],
    ["meta result", (r) => { find(r, "result-1").isMeta = true; }],
    ["unknown result origin", (r) => { find(r, "result-1").origin = { kind: "unknown" }; }],
    ["result is a query boundary", (r) => { find(r, "result-1").humanInput = { text: "Another human." }; }],
    ["result continues off the active path", (r) => { r.push(node("attachment", "side-continuation", "result-1")); }],
    ["ambiguous call block", (r) => { find(r, "call-1").message.content.push({ type: "tool_use", id: "extra-tool" }); }],
    ["meta call", (r) => { find(r, "call-1").isMeta = true; }],
    ["another assistant final", (r) => { r.push(assistant("other-final", turnId)); }],
  ]) {
    const records = parallelToolTurn();
    change(records);
    assert.deepEqual(await fixture.read(records), { ok: false, reason: "turn_ambiguous" }, label);
  }
});

test("parallel results retain native scope checks and cannot complete an unfinished answer", async (t) => {
  const fixture = await createFixture(t);
  for (const [key, value, reason] of [
    ["sessionId", "other-session", "transcript_session_mismatch"],
    ["cwd", resolve("other-workspace"), "transcript_workspace_mismatch"],
    ["isSidechain", true, "sidechain_unsupported"],
  ]) {
    const records = parallelToolTurn();
    records.find((record) => record.uuid === "result-1")[key] = value;
    assert.deepEqual(await fixture.read(records), { ok: false, reason });
  }
  const records = parallelToolTurn();
  records.find((record) => record.uuid === "final").message.stop_reason = null;
  assert.deepEqual(await fixture.read(records), { ok: false, reason: "assistant_message_missing" });
});

test("an interrupted exact turn cannot borrow a previous or later completed assistant reply", async (t) => {
  const fixture = await createFixture(t);
  const records = [
    ...completedTurn("request-before", null),
    human(turnId, "final-request-before"),
    assistant("call", turnId, "tool_use", [{ type: "tool_use", id: "tool-1", name: "Bash", input: {} }]),
    node("user", "cancelled", "call", {
      toolDenialKind: "interrupted", toolUseResult: { kind: "cancelled" },
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", is_error: true }] },
    }),
    node("user", "control", "cancelled", { message: { role: "user", content: [{ type: "text", text: "Cancelled." }] } }),
    ...completedTurn("request-after", "control"),
    activeLeaf("final-request-after"),
  ];
  assert.deepEqual(await fixture.read(records), { ok: false, reason: "assistant_message_missing" });
  assert.equal((await fixture.read(records, "request-after")).ok, true);
});

test("an earlier end_turn is not final when the same request continues", async (t) => {
  const fixture = await createFixture(t);
  const records = [
    ...completedTurn(turnId, null, "Prompt.", "Earlier Stop reply."),
    node("user", "continuation", "final-request-1", { isMeta: true, message: { role: "user", content: "Continue." } }),
    assistant("progress", "continuation", null, [{ type: "text", text: "More progress." }]),
    activeLeaf("progress"),
  ];
  assert.deepEqual(await fixture.read(records), { ok: false, reason: "assistant_message_missing" });
  records.push(assistant("actual-final", "progress", "end_turn", [{ type: "text", text: "Completed after continuation." }]));
  records.push(activeLeaf("actual-final"));
  const result = await fixture.read(records);
  assert.equal(result.ok, true);
  assert.equal(result.turn.assistantReply, "Completed after continuation.");
});

test("a background task notification is a separate query and cannot replace the prior human answer", async (t) => {
  const fixture = await createFixture(t);
  const records = [
    ...completedTurn(turnId, null, "Human prompt.", "Human answer."),
    node("user", "notification", "final-request-1", {
      isMeta: true, origin: { kind: "task-notification" },
      message: { role: "user", content: [{ type: "text", text: "Synthetic notification." }] },
    }),
    assistant("notification-answer", "notification", "end_turn", [{ type: "text", text: "Task result must not replace human answer." }]),
    activeLeaf("notification-answer"),
  ];
  const result = await fixture.read(records);
  assert.equal(result.ok, true);
  assert.equal(result.turn.assistantReply, "Human answer.");
  assert.equal((await fixture.read(records, "notification")).reason, "turn_metadata_mismatch");
  assert.equal((await fixture.read(records, "unpersisted-notification-request-id")).reason, "turn_not_found");
  records[1].message.stop_reason = "tool_use";
  assert.equal((await fixture.read(records)).reason, "assistant_message_missing");
});

test("optional delayed-registration ordering follows the exact native ancestor chain", async (t) => {
  const fixture = await createFixture(t);
  await fixture.read([
    ...completedTurn(turnId), ...completedTurn("request-2", "final-request-1"), activeLeaf("final-request-2"),
  ]);
  const read = (exactTurnId, afterTurnId) => readQoderTranscriptTurn({
    transcriptPath: fixture.transcriptPath, sessionId, turnId: exactTurnId, afterTurnId,
  });
  assert.equal((await read("request-2", turnId)).ok, true);
  assert.equal((await read(turnId, turnId)).ok, true);
  assert.equal((await read(turnId, "request-2")).reason, "turn_order_mismatch");
  assert.equal((await read("request-2", "unknown-request")).reason, "turn_order_mismatch");
});

test("the active leaf proves branch membership without choosing the latest turn", async (t) => {
  const fixture = await createFixture(t);
  const records = [
    ...completedTurn(turnId),
    ...completedTurn("other-request"),
    activeLeaf("final-other-request"),
  ];
  assert.deepEqual(await fixture.read(records), { ok: false, reason: "turn_branch_mismatch" });
  assert.deepEqual(await fixture.read(completedTurn(turnId)), { ok: false, reason: "turn_branch_mismatch" });
  records.push(activeLeaf(turnId));
  assert.deepEqual(await fixture.read(records), { ok: false, reason: "turn_branch_mismatch" });
});

test("ambiguous same-turn terminal branches fail even when the active leaf names one", async (t) => {
  const fixture = await createFixture(t);
  const records = [
    ...completedTurn(turnId),
    assistant("other-final", turnId, "end_turn", [{ type: "text", text: "Other branch." }]),
    activeLeaf("final-request-1"),
  ];
  assert.deepEqual(await fixture.read(records), { ok: false, reason: "turn_ambiguous" });
  records[2] = assistant("other-progress", turnId, null, [{ type: "text", text: "Other branch in progress." }]);
  assert.deepEqual(await fixture.read(records), { ok: false, reason: "turn_ambiguous" });
});

test("identical duplicate UUID records are accepted but conflicting records fail closed", async (t) => {
  const fixture = await createFixture(t);
  const records = completedTurn(turnId);
  assert.equal((await fixture.read([...records, structuredClone(records[1]), activeLeaf("final-request-1")])).ok, true);
  const conflict = structuredClone(records[1]);
  conflict.message.content[0].text = "Conflicting final.";
  assert.deepEqual(await fixture.read([...records, conflict, activeLeaf("final-request-1")]), { ok: false, reason: "turn_ambiguous" });
});

test("requires exact human uuid and requestSetId with explicit original human input", async (t) => {
  const fixture = await createFixture(t);
  const cases = [
    ["requestSetId", "other-request", "turn_metadata_mismatch"],
    ["requestSetId", undefined, "turn_metadata_mismatch"],
    ["origin", { kind: "tool" }, "turn_metadata_mismatch"],
    ["origin", undefined, "turn_metadata_mismatch"],
    ["isMeta", true, "turn_metadata_mismatch"],
    ["humanInput", undefined, "user_prompt_missing"],
    ["humanInput", { text: "  " }, "user_prompt_missing"],
    ["humanInput", { text: 1 }, "user_prompt_missing"],
    ["message", { role: "assistant", content: [] }, "turn_metadata_mismatch"],
  ];
  for (const [key, value, reason] of cases) {
    const records = completedTurn(turnId);
    records[0][key] = value;
    assert.deepEqual(await fixture.read([...records, activeLeaf("final-request-1")]), { ok: false, reason }, key);
  }
  const conflictingHuman = human("other-request", "final-request-1");
  conflictingHuman.requestSetId = turnId;
  assert.deepEqual(await fixture.read([...completedTurn(turnId), conflictingHuman, activeLeaf("other-request")]), {
    ok: false, reason: "turn_metadata_mismatch",
  });
});

test("validates native session, workspace, and main-chain identity on every selected node", async (t) => {
  const fixture = await createFixture(t);
  for (const [key, value, reason] of [
    ["sessionId", "other-session", "transcript_session_mismatch"],
    ["sessionId", undefined, "transcript_session_mismatch"],
    ["cwd", resolve("other-test-workspace"), "transcript_workspace_mismatch"],
    ["cwd", undefined, "transcript_workspace_mismatch"],
    ["isSidechain", true, "sidechain_unsupported"],
    ["isSidechain", undefined, "sidechain_unsupported"],
  ]) {
    for (const index of [0, 1, 2]) {
      const records = [human(turnId), node("attachment", "attachment", turnId), assistant("final", "attachment"), activeLeaf("final")];
      records[index][key] = value;
      assert.deepEqual(await fixture.read(records), { ok: false, reason }, `${key}/${index}`);
    }
  }
  for (const invalidCwd of ["relative-workspace", "", `/${String.fromCharCode(0)}`]) {
    const records = completedTurn(turnId).map((record) => ({ ...record, cwd: invalidCwd }));
    assert.deepEqual(await fixture.read([...records, activeLeaf("final-request-1")]), {
      ok: false, reason: "transcript_workspace_mismatch",
    });
  }
});

test("rejects sidechain descendants and foreign session active-leaf authority", async (t) => {
  const fixture = await createFixture(t);
  const sibling = assistant("side-final", turnId);
  sibling.isSidechain = true;
  assert.deepEqual(await fixture.read([...completedTurn(turnId), sibling, activeLeaf("final-request-1")]), {
    ok: false, reason: "sidechain_unsupported",
  });
  assert.deepEqual(await fixture.read([...completedTurn(turnId), { ...activeLeaf("final-request-1"), sessionId: "other-session" }]), {
    ok: false, reason: "turn_branch_mismatch",
  });
});

test("rejects missing chain links, unknown active leaves, and cycles", async (t) => {
  const fixture = await createFixture(t);
  for (const parentUuid of ["missing-parent", "final-request-1"]) {
    const records = completedTurn(turnId);
    records[1].parentUuid = parentUuid;
    assert.deepEqual(await fixture.read([...records, activeLeaf("final-request-1")]), { ok: false, reason: "turn_chain_invalid" });
  }
  const cyclic = completedTurn(turnId);
  cyclic[0].parentUuid = "final-request-1";
  assert.deepEqual(await fixture.read([...cyclic, activeLeaf("final-request-1")]), { ok: false, reason: "turn_chain_invalid" });
  assert.deepEqual(await fixture.read([...completedTurn(turnId), activeLeaf("missing")]), { ok: false, reason: "turn_chain_invalid" });
});

test("requires a complete final assistant message with nonempty text", async (t) => {
  const fixture = await createFixture(t);
  for (const [replacement, reason] of [
    [{ message: { role: "assistant", stop_reason: null, content: [{ type: "text", text: "Incomplete." }] } }, "assistant_message_missing"],
    [{ message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "text", text: "Calling a tool." }] } }, "assistant_message_missing"],
    [{ message: { role: "user", stop_reason: "end_turn", content: [{ type: "text", text: "Wrong role." }] } }, "assistant_message_missing"],
    [{ isMeta: true }, "assistant_message_missing"],
    [{ message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "thinking" }] } }, "assistant_message_missing"],
    [{ message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "  " }] } }, "assistant_message_missing"],
    [{ message: { role: "assistant", stop_reason: "end_turn", content: "Partial shape." } }, "malformed_transcript"],
    [{ message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text" }] } }, "malformed_transcript"],
    [{ message: { role: "assistant", stop_reason: "end_turn", content: [{ text: "Missing type." }] } }, "malformed_transcript"],
    [{ message: { role: "assistant", stop_reason: "end_turn", content: [null] } }, "malformed_transcript"],
  ]) {
    const records = completedTurn(turnId);
    Object.assign(records[1], replacement);
    assert.deepEqual(await fixture.read([...records, activeLeaf("final-request-1")]), { ok: false, reason });
  }
});

test("uses only valid native message timestamps and never metadata clocks", async (t) => {
  const fixture = await createFixture(t);
  for (const timestamp of [undefined, "invalid", 1234, -1]) {
    const records = completedTurn(turnId);
    records[0].timestamp = timestamp;
    records[1].timestamp = timestamp;
    const result = await fixture.read([...records, { ...activeLeaf("final-request-1"), timestamp: 1_800_000_000_000 }]);
    assert.deepEqual(result, { ok: true, turn: { userPrompt: "Prompt.", assistantReply: "Final reply.", cwd } });
  }
});

test("rejects malformed JSONL, partial tails, invalid native records, and invalid UTF-8", async (t) => {
  const fixture = await createFixture(t);
  const valid = [...completedTurn(turnId), activeLeaf("final-request-1")].map(JSON.stringify).join("\n");
  for (const suffix of ["{", "[]", "null", "1", '{}', '{"type":"assistant"}', '{"type":"attachment","uuid":""}', '{"type":"active-leaf"}']) {
    await writeFile(fixture.transcriptPath, `${valid}\n${suffix}`);
    assert.deepEqual(await fixture.readFile(), { ok: false, reason: "malformed_transcript" }, suffix);
  }
  await writeFile(fixture.transcriptPath, Buffer.concat([Buffer.from(`${valid}\n`), Buffer.from([0xff])]));
  assert.deepEqual(await fixture.readFile(), { ok: false, reason: "malformed_transcript" });
});

test("accepts complete JSONL without a trailing newline and with CRLF separators", async (t) => {
  const fixture = await createFixture(t);
  await writeFile(fixture.transcriptPath, [...completedTurn(turnId), activeLeaf("final-request-1")].map(JSON.stringify).join("\r\n"));
  assert.equal((await fixture.readFile()).ok, true);
});

test("bounds native file reads and reports missing or non-file transcripts", async (t) => {
  const fixture = await createFixture(t);
  assert.equal((await fixture.readFile()).reason, "transcript_unavailable");
  await writeFile(fixture.transcriptPath, "");
  await truncate(fixture.transcriptPath, MAX_QODER_TRANSCRIPT_BYTES + 1);
  assert.deepEqual(await fixture.readFile(), { ok: false, reason: "transcript_too_large" });
  assert.deepEqual(await readQoderTranscriptTurn({ transcriptPath: fixture.root, sessionId, turnId }), {
    ok: false, reason: "transcript_unavailable",
  });
});

function node(type, uuid, parentUuid = null, extra = {}) {
  return { type, uuid, parentUuid, sessionId, cwd, isSidechain: false, ...extra };
}

function human(uuid, parentUuid = null, prompt = "Prompt.") {
  return node("user", uuid, parentUuid, {
    requestSetId: uuid,
    origin: { kind: "human" },
    humanInput: { text: prompt },
    message: { role: "user", content: [{ type: "text", text: "Expanded prompt is not original human input." }] },
  });
}

function assistant(uuid, parentUuid, stopReason = "end_turn", content = [{ type: "text", text: "Final reply." }]) {
  return node("assistant", uuid, parentUuid, { message: { role: "assistant", stop_reason: stopReason, content } });
}

function completedTurn(uuid, parentUuid = null, prompt = "Prompt.", reply = "Final reply.") {
  return [human(uuid, parentUuid, prompt), assistant(`final-${uuid}`, uuid, "end_turn", [{ type: "text", text: reply }])];
}

function parallelToolTurn(count = 3) {
  const records = [human(turnId)];
  for (let index = 1; index <= count; index += 1) {
    const call = assistant(`call-${index}`, index === 1 ? turnId : `call-${index - 1}`,
      index === count ? "tool_use" : null, [{ type: "tool_use", id: `tool-${index}`, name: "Read", input: {} }]);
    call.message.id = "assistant-batch";
    records.push(call);
  }
  // Result arrival order does not replace the parent and tool-use identities.
  for (let index = count; index >= 1; index -= 1) {
    records.push(node("user", `result-${index}`, `call-${index}`, { message: {
      role: "user", content: [{ type: "tool_result", tool_use_id: `tool-${index}`, content: "Synthetic tool output." }],
    } }));
  }
  return [...records, assistant("final", `result-${count}`), activeLeaf("final")];
}

function activeLeaf(leafUuid) {
  return { type: "active-leaf", sessionId, leafUuid, explicit: false };
}

async function createFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "memorax-qoder-transcript-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const transcriptPath = join(root, "session.jsonl");
  return {
    root,
    transcriptPath,
    readFile: (exactTurnId = turnId) => readQoderTranscriptTurn({ transcriptPath, sessionId, turnId: exactTurnId }),
    async read(records, exactTurnId = turnId) {
      await writeFile(transcriptPath, records.map(JSON.stringify).join("\n") + "\n");
      return readQoderTranscriptTurn({ transcriptPath, sessionId, turnId: exactTurnId });
    },
  };
}
