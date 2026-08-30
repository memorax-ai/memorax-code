import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodeBuddyMemoryHookRuntime } from "../../../dist/clients/codebuddy/memory-hook-runtime.js";
import { codeBuddyTracePaths } from "../../../dist/trace/config.js";

const fetchImpl = async () => new Response(JSON.stringify({ context: "retrieved context" }), {
  status: 200,
  headers: { "content-type": "application/json" },
});

function command(sessionId, turnId, transcriptPath, prompt) {
  return {
    version: 1,
    client: "codebuddy",
    sessionId,
    turnId,
    transcriptPath,
    prompt,
    cwd: process.cwd(),
  };
}

function lines(records) {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

async function readEvents(home, sessionId) {
  const path = codeBuddyTracePaths(home).eventsJsonl(sessionId);
  return (await readFile(path, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line));
}

test("CodeBuddy runtime records completed turn lifecycle trace", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-codebuddy-trace-"));
  const transcriptPath = join(home, "session.jsonl");
  const sessionId = "trace-completed";
  await writeFile(transcriptPath, lines([
    { id: "u1", type: "message", role: "user", sessionId, content: [{ type: "input_text", text: "<user_query>remember this</user_query>" }] },
    { id: "a1", type: "message", role: "assistant", parentId: "u1", status: "completed", content: [{ type: "output_text", text: "done" }] },
  ]));
  const runtime = createCodeBuddyMemoryHookRuntime({
    env: { MEMORAX_CODE_HOME: home },
    fetchImpl,
    automaticWriteback: async () => undefined,
  });
  await runtime.recordTurnStart(command(sessionId, "t1", transcriptPath, "remember this"));
  await runtime.writeback({ ...command(sessionId, "t1", transcriptPath, ""), client: "codebuddy" });
  runtime.close();

  const events = await readEvents(home, sessionId);
  assert.deepEqual(events.map((event) => event.type), ["turn_start", "turn_end", "turn_materialized"]);
  assert.equal(events[1].outcome, "completed");
  assert.equal(events[2].source, "codebuddy-transcript");
  const current = JSON.parse(await readFile(codeBuddyTracePaths(home).sessionCurrentTurnPath(sessionId), "utf8"));
  assert.equal(current.turn_state, "completed");
});

test("CodeBuddy runtime traces incomplete assistant and does not write back", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-codebuddy-trace-"));
  const transcriptPath = join(home, "session.jsonl");
  const sessionId = "trace-incomplete";
  await writeFile(transcriptPath, lines([
    { id: "u1", type: "message", role: "user", sessionId, content: [{ type: "input_text", text: "<user_query>cancel me</user_query>" }] },
    { id: "a1", type: "message", role: "assistant", parentId: "u1", status: "incomplete", content: [{ type: "output_text", text: "partial" }] },
  ]));
  const writes = [];
  const runtime = createCodeBuddyMemoryHookRuntime({
    env: { MEMORAX_CODE_HOME: home },
    fetchImpl,
    automaticWriteback: async (request) => writes.push(request),
  });
  await runtime.recordTurnStart(command(sessionId, "t1", transcriptPath, "cancel me"));
  const result = await runtime.writeback({ ...command(sessionId, "t1", transcriptPath, ""), client: "codebuddy" });
  runtime.close();

  assert.deepEqual(result, { ok: true, scheduled: false, reason: "assistant_message_missing" });
  assert.equal(writes.length, 0);
  const events = await readEvents(home, sessionId);
  assert.deepEqual(events.map((event) => event.type), ["turn_start", "turn_end"]);
  assert.equal(events[1].ok, false);
  assert.equal(events[1].outcome, "interrupted");
  const current = JSON.parse(await readFile(codeBuddyTracePaths(home).sessionCurrentTurnPath(sessionId), "utf8"));
  assert.equal(current.turn_state, "interrupted");
});
