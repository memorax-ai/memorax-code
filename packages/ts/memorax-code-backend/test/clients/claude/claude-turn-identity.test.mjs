import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createClaudeMemoryHookRuntime } from "../../../dist/clients/claude/memory-hook-runtime.js";
import { readClaudeArchiveSource } from "../../../dist/clients/claude/transcript-turn.js";
import { createAutomaticMemoryWritebackRuntime } from "../../../dist/memory/automatic-writeback.js";

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), "memorax-claude-identity-"));
  const transcriptPath = join(root, "session.jsonl");
  const scope = { schemaVersion: "workspace-memory-scope.v1", baseUserId: "user-1",
    effectiveUserId: "user-1@identity", repositoryKey: "identity-key", repositorySlug: "identity",
    repositoryName: "identity", identitySource: "workspace-directory", scopeKind: "local-directory",
    boundWorkspaceRoot: root };
  const env = { MEMORAX_CODE_HOME: root, MEMORAX_CODE_CLAUDE_TRACE_ENABLED: "false",
    MEMORAX_CODE_MEMORY_WRITEBACK_ENABLED: "true", MEMORAX_CODE_CODING_SESSIONS_ENABLED: "true",
    MEMORAX_CODE_MEMORAX_ENDPOINT: "http://offline.invalid", MEMORAX_CODE_MEMORAX_API_KEY: "synthetic-key",
    MEMORAX_CODE_MEMORAX_USER_ID: "user-1", MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_MAX_AGE_MS: "60000" };
  const bodies = [], enqueued = [];
  const automatic = createAutomaticMemoryWritebackRuntime({ memoraxCodeHome: root, readCodingSessionTurn: readClaudeArchiveSource });
  const runtime = createClaudeMemoryHookRuntime({ captureCodingTurns: true, env, memoraxCodeHome: root,
    transcriptReadAttempts: 1, repositoryMemorySession: { async resolve() { return { ok: true, memory: { config: {}, scope } }; } },
    automaticWriteback(input) { enqueued.push(input); return automatic.enqueue(input); },
    fetchImpl: async (_url, init) => { bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ success: true, data: { task_id: "offline", status: "queued" } }), { status: 202 }); },
    ...overrides });
  t.after(async () => { runtime.close(); automatic.close(); await rm(root, { recursive: true, force: true }); });
  const command = { version: 1, client: "claude-code", sessionId: "session", promptId: "reused-prompt",
    transcriptPath, cwd: root };
  return { runtime, automatic, bodies, enqueued, command, scope,
    async save(rows) { await writeFile(transcriptPath, rows.map(JSON.stringify).join("\n") + (rows.length ? "\n" : "")); } };
}

function records(index, prompt = "Inspect the working tree.") {
  const base = { sessionId: "session", isSidechain: false, timestamp: "2026-10-14T01:00:00.000Z" };
  return [
    { ...base, type: "user", userType: "external", promptId: "reused-prompt", uuid: `user-${index}`,
      parentUuid: index > 1 ? `final-${index - 1}` : null, message: { role: "user", content: prompt } },
    { ...base, type: "assistant", uuid: `tool-${index}`, parentUuid: `user-${index}`, message: { role: "assistant",
      stop_reason: "tool_use", content: [{ type: "tool_use", id: `call-${index}`, name: "Bash", input: { command: "pwd" } }] } },
    { ...base, type: "user", uuid: `result-${index}`, parentUuid: `tool-${index}`, message: { role: "user",
      content: [{ type: "tool_result", tool_use_id: `call-${index}`, content: `Directory ${index}` }] } },
    { ...base, type: "assistant", uuid: `final-${index}`, parentUuid: `result-${index}`, message: { role: "assistant",
      stop_reason: "end_turn", content: [{ type: "text", text: "The working tree was inspected." }] } },
  ];
}

test("eight reused Claude prompt IDs retain distinct native turns and the existing Add trigger", async (t) => {
  const run = await fixture(t);
  const rows = [], starts = [];
  for (let index = 1; index <= 8; index++) {
    const next = records(index);
    // Exercise both native persistence orders, including identical QA text.
    await run.save(index % 2 ? rows : [...rows, next[0]]);
    starts.push(await run.runtime.recordTurnStart({ ...run.command, prompt: next[0].message.content }));
    rows.push(...next);
    await run.save(rows);
    const stop = { ...run.command, lastAssistantMessage: "Diagnostic Hook text." };
    assert.deepEqual(await run.runtime.writeback(stop), { ok: true, scheduled: true });
    assert.deepEqual(await run.runtime.writeback(stop), { ok: true, scheduled: true });
    if (index < 8) {
      await new Promise(setImmediate);
      assert.equal(run.bodies.length, 0, "no early Add");
    }
  }
  await run.automatic.drain();
  assert.equal(new Set(starts.map(x => x.claudeTurnKey)).size, 8);
  assert.equal(run.enqueued.length, 8, "duplicate Stops cannot enqueue the same native UUID twice");
  assert.equal(run.bodies.length, 1);
  const body = run.bodies[0];
  assert.equal(body.messages.length, 16);
  assert.equal(body.content_type, "code");
  assert.equal(body.async_mode, true);
  assert.deepEqual(body.coding_context.turns.map(t => [t.turn_id, t.turn_index]),
    Array.from({ length: 8 }, (_, i) => [`user-${i + 1}`, i + 1]));
  assert.equal(body.coding_context.items.filter(i => i.type === "function_call").length, 8);
  assert.equal(body.coding_context.items.filter(i => i.type === "function_call_output").length, 8);
  assert.equal(JSON.stringify(body).includes("claude-start:"), false);
  assert.equal(JSON.stringify(body).includes(run.command.transcriptPath), false);
});

test("Claude native completion deduplication shares concurrent attempts and retries rejected enqueue", async (t) => {
  let enabled = false, calls = 0;
  const run = await fixture(t, { automaticWriteback() { calls++; return enabled ? { accepted: true } : { accepted: false, reason: "disabled" }; } });
  await run.save([]);
  await run.runtime.recordTurnStart({ ...run.command, prompt: "Inspect the working tree." });
  await run.save(records(1));
  const stop = { ...run.command, lastAssistantMessage: "Done." };
  assert.deepEqual(await run.runtime.writeback(stop), { ok: true, scheduled: false, reason: "disabled" });
  assert.equal(run.runtime.size(), 1);
  enabled = true;
  const results = await Promise.all([run.runtime.writeback(stop), run.runtime.writeback(stop)]);
  assert.ok(results.every(r => r.scheduled));
  assert.equal(calls, 2);
  assert.equal(run.runtime.size(), 0);
});

test("duplicate Claude starts revalidate scope without creating a predecessor conflict", async (t) => {
  let resolutions = 0;
  const run = await fixture(t, { repositoryMemorySession: { async resolve() {
    resolutions++;
    return { ok: true, memory: { config: {}, scope: run.scope } };
  } } });
  await run.save([]);
  const command = { ...run.command, prompt: "Inspect the working tree." };
  const first = await run.runtime.recordTurnStart(command);
  assert.deepEqual(await run.runtime.recordTurnStart(command), first);
  assert.equal(resolutions, 2);
  await run.save(records(1));
  assert.equal((await run.runtime.writeback({ ...run.command, lastAssistantMessage: "Done." })).scheduled, true);
  assert.equal(run.enqueued.length, 1);
});

test("Claude refuses overlapping unresolved starts with the same Hook ID", async (t) => {
  const run = await fixture(t);
  await run.save([]);
  await run.runtime.recordTurnStart({ ...run.command, prompt: "First request." });
  await run.save(records(1, "First request."));
  await run.runtime.recordTurnStart({ ...run.command, prompt: "Second request." });
  await run.save([...records(1, "First request."), ...records(2, "Second request.")]);
  assert.deepEqual(await run.runtime.writeback({ ...run.command, lastAssistantMessage: "Done." }),
    { ok: true, scheduled: false, reason: "turn_ambiguous" });
  assert.equal(run.enqueued.length, 0);
});

test("a pending predecessor acceptance releases only its own successor and preserves new metadata", async (t) => {
  let block = false, release, reached;
  const waiting = new Promise(resolve => { reached = resolve; });
  const run = await fixture(t, { repositoryMemorySession: { async resolve() {
    if (block) {
      block = false;
      reached();
      await new Promise(resolve => { release = resolve; });
    }
    return { ok: true, memory: { config: {}, scope: run.scope } };
  } } });
  await run.save([]);
  await run.runtime.recordTurnStart({ ...run.command, prompt: "First request." });
  await run.save(records(1, "First request."));
  // Pause the first completion at scope validation while a new start registers.
  block = true;
  const originalRead = run.runtime.writeback({ ...run.command, lastAssistantMessage: "First answer." });
  await waiting;
  const second = await run.runtime.recordTurnStart({ ...run.command, prompt: "Second request." });
  assert.equal(second.ok, true);
  await run.save([...records(1, "First request."), ...records(2, "Second request.")]);
  const secondStop = run.runtime.writeback({ ...run.command, lastAssistantMessage: "Second answer." });
  await new Promise(setImmediate);
  assert.equal(run.enqueued.length, 0);
  release();
  assert.equal((await originalRead).scheduled, true);
  assert.equal((await secondStop).scheduled, true);
  assert.equal(run.runtime.size(), 0);
  assert.deepEqual(run.enqueued.map(x => x.codingTurn.turnId), ["user-1", "user-2"]);
});
