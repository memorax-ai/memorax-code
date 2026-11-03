import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createClaudeMemoryHookRuntime } from "../../../dist/clients/claude/memory-hook-runtime.js";
import { readClaudeArchiveSource } from "../../../dist/clients/claude/transcript-turn.js";
import { createAutomaticMemoryWritebackRuntime } from "../../../dist/memory/automatic-writeback.js";
import { createMemoryTurnCoordinator } from "../../../dist/memory/turn-coordinator.js";

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

test("a completed Claude predecessor with no Stop is settled before its distinct successor", async (t) => {
  const run = await fixture(t);
  await run.save([]);
  await run.runtime.recordTurnStart({ ...run.command, prompt: "First request." });
  await run.save(records(1, "First request."));
  await run.runtime.recordTurnStart({ ...run.command, prompt: "Second request." });
  await run.save([...records(1, "First request."), ...records(2, "Second request.")]);
  assert.deepEqual(await run.runtime.writeback({ ...run.command, lastAssistantMessage: "Done." }),
    { ok: true, scheduled: true });
  assert.deepEqual(run.enqueued.map(x => [x.codingTurn.turnId, x.userText]), [
    ["user-1", "First request."], ["user-2", "Second request."],
  ]);
  assert.equal(run.runtime.size(), 0);
});

for (const persistedBeforeStart of [false, true]) {
  test(`a Claude predecessor without a reply or interruption cannot block consecutive reused IDs (persisted=${persistedBeforeStart})`, async (t) => {
    const run = await fixture(t);
    const first = records(1, "An unanswered request.")[0];
    await run.save(persistedBeforeStart ? [first] : []);
    await run.runtime.recordTurnStart({ ...run.command, prompt: first.message.content });
    const rows = [first];
    for (let index = 2; index <= 5; index++) {
      const next = records(index, `Distinct request ${index}.`);
      if (index === 2) next[0].parentUuid = first.uuid;
      await run.save(persistedBeforeStart ? [...rows, next[0]] : rows);
      const start = await run.runtime.recordTurnStart({ ...run.command, prompt: next[0].message.content });
      assert.equal(start.ok, true);
      rows.push(...next);
      await run.save(rows);
      assert.deepEqual(await run.runtime.writeback({ ...run.command, lastAssistantMessage: "Done." }),
        { ok: true, scheduled: true });
    }
    assert.deepEqual(run.enqueued.map(x => [x.codingTurn.turnId, x.codingTurn.turnIndex]),
      [["user-2", 2], ["user-3", 3], ["user-4", 4], ["user-5", 5]]);
    assert.equal(run.runtime.size(), 0, "the unresolved predecessor was explicitly superseded");
  });
}

for (const rejection of ["disabled", "throw"]) {
  test(`a Claude enqueue ${rejection} stays retryable without blocking a distinct successor`, async (t) => {
    const attempted = [], accepted = [];
    const run = await fixture(t, { automaticWriteback(input) {
      attempted.push(input.codingTurn.turnId);
      if (input.codingTurn.turnId === "user-1") {
        if (rejection === "throw") throw new Error("Synthetic enqueue failure.");
        return { accepted: false, reason: rejection };
      }
      accepted.push(input);
      return { accepted: true };
    } });
    await run.save([]);
    await run.runtime.recordTurnStart({ ...run.command, prompt: "First request." });
    await run.save(records(1, "First request."));
    const stop = { ...run.command, lastAssistantMessage: "Done." };
    const rejected = { ok: true, scheduled: false, reason: rejection === "throw" ? "decision_error" : rejection };
    assert.deepEqual(await run.runtime.writeback(stop), rejected);
    assert.equal(run.runtime.size(), 1, "rejected enqueue cannot consume native Turn metadata");
    assert.deepEqual(await run.runtime.writeback(stop), rejected);
    assert.deepEqual(attempted, ["user-1", "user-1"], "settling an attempt is not accepted deduplication");
    assert.equal(run.runtime.size(), 1);
    await run.runtime.recordTurnStart({ ...run.command, prompt: "Second request." });
    await run.save([...records(1, "First request."), ...records(2, "Second request.")]);
    assert.deepEqual(await run.runtime.writeback(stop), { ok: true, scheduled: true });
    assert.deepEqual(accepted.map(x => [x.codingTurn.turnId, x.userText]), [["user-2", "Second request."]]);
  });
}

for (const completeBeforeLateStop of [false, true]) {
  test(`a late Claude Stop cannot misattribute content or poison the current occurrence (completed=${completeBeforeLateStop})`, async (t) => {
    const run = await fixture(t);
    const old = records(1, "Old request.");
    old[3].message.content[0].text = "Old native answer.";
    const current = records(2, "Current request.");
    current[0].parentUuid = old[0].uuid;
    current[3].message.content[0].text = "Current native answer.";
    await run.save([]);
    await run.runtime.recordTurnStart({ ...run.command, prompt: old[0].message.content });
    await run.save([old[0]]);
    await run.runtime.recordTurnStart({ ...run.command, prompt: current[0].message.content });
    // The old completion lands after the new start. Its Stop carries the reused ID.
    const rows = [old[0], current[0], ...old.slice(1)];
    if (completeBeforeLateStop) rows.push(...current.slice(1));
    await run.save(rows);
    const late = await run.runtime.writeback({ ...run.command, lastAssistantMessage: "Old native answer." });
    if (completeBeforeLateStop) {
      assert.deepEqual(late, { ok: true, scheduled: true });
    } else {
      assert.deepEqual(late, { ok: true, scheduled: false, reason: "assistant_message_missing" });
      assert.equal(run.enqueued.length, 0);
      assert.equal(run.runtime.size(), 1, "a premature Stop must retain current metadata for retry");
      rows.push(...current.slice(1));
      await run.save(rows);
    }
    const stop = { ...run.command, lastAssistantMessage: "Current native answer." };
    assert.deepEqual(await run.runtime.writeback(stop), { ok: true, scheduled: true });
    assert.deepEqual(await run.runtime.writeback(stop), { ok: true, scheduled: true });
    assert.deepEqual(run.enqueued.map(x => [x.codingTurn.turnId, x.userText, x.assistantText]),
      [["user-2", "Current request.", "Current native answer."]]);
    assert.equal(run.runtime.size(), 0);
  });
}

test("superseding an unresolved Claude start does not disambiguate identical native user texts", async (t) => {
  const run = await fixture(t);
  const prompt = "Repeat the same request.";
  const first = records(1, prompt)[0];
  const second = records(2, prompt);
  second[0].parentUuid = first.uuid;
  await run.save([]);
  await run.runtime.recordTurnStart({ ...run.command, prompt });
  await run.save([first]);
  await run.runtime.recordTurnStart({ ...run.command, prompt });
  await run.save([first, ...second]);
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


test("a pending predecessor rejection releases its successor after settlement without consuming rejected metadata", async (t) => {
  let block = false, release, reached;
  const waiting = new Promise(resolve => { reached = resolve; });
  const attempted = [], accepted = [];
  const run = await fixture(t, {
    repositoryMemorySession: { async resolve() {
      if (block) {
        block = false;
        reached();
        await new Promise(resolve => { release = resolve; });
      }
      return { ok: true, memory: { config: {}, scope: run.scope } };
    } },
    automaticWriteback(input) {
      attempted.push(input.codingTurn.turnId);
      if (input.codingTurn.turnId === "user-1") return { accepted: false, reason: "disabled" };
      accepted.push(input);
      return { accepted: true };
    },
  });
  await run.save([]);
  await run.runtime.recordTurnStart({ ...run.command, prompt: "First request." });
  await run.save(records(1, "First request."));
  block = true;
  const originalRead = run.runtime.writeback({ ...run.command, lastAssistantMessage: "First answer." });
  await waiting;
  await run.runtime.recordTurnStart({ ...run.command, prompt: "Second request." });
  await run.save([...records(1, "First request."), ...records(2, "Second request.")]);
  const secondStop = run.runtime.writeback({ ...run.command, lastAssistantMessage: "Second answer." });
  await new Promise(setImmediate);
  assert.deepEqual(attempted, [], "successor must wait while predecessor completion is in flight");
  assert.equal(run.runtime.size(), 2);
  release();
  assert.deepEqual(await originalRead, { ok: true, scheduled: false, reason: "disabled" });
  assert.deepEqual(await secondStop, { ok: true, scheduled: true });
  assert.deepEqual(attempted, ["user-1", "user-2"]);
  assert.deepEqual(accepted.map(x => x.codingTurn.turnId), ["user-2"]);
  assert.equal(run.runtime.size(), 1, "only the accepted successor metadata is consumed");
});


test("a fast invalid Claude Stop cannot hide an earlier pending completion from its successor", async (t) => {
  const entered = Promise.withResolvers(), gate = Promise.withResolvers();
  let block = false, released = false;
  const accepted = [];
  const run = await fixture(t, {
    repositoryMemorySession: { async resolve() {
      if (block) {
        block = false;
        entered.resolve();
        await gate.promise;
      }
      return { ok: true, memory: { config: {}, scope: run.scope } };
    } },
    automaticWriteback(input) {
      assert.equal(released, true, "no occurrence may overtake the pending predecessor");
      accepted.push(input.codingTurn.turnId);
      return { accepted: true };
    },
  });
  t.after(() => gate.resolve());
  await run.save([]);
  await run.runtime.recordTurnStart({ ...run.command, prompt: "First request." });
  await run.save(records(1, "First request."));
  block = true;
  const originalStop = run.runtime.writeback({ ...run.command, lastAssistantMessage: "First answer." });
  await entered.promise;
  assert.deepEqual(await run.runtime.writeback({ ...run.command, lastAssistantMessage: "" }),
    { ok: true, scheduled: false, reason: "assistant_message_missing" });
  const second = await run.runtime.recordTurnStart({ ...run.command, prompt: "Second request." });
  assert.equal(second.ok, true, "the new start must return while the predecessor is pending");
  await run.save([...records(1, "First request."), ...records(2, "Second request.")]);
  let successorFinished = false;
  const secondStop = run.runtime.writeback({ ...run.command, lastAssistantMessage: "Second answer." })
    .then(result => { successorFinished = true; return result; });
  await new Promise(setImmediate);
  assert.equal(successorFinished, false);
  assert.deepEqual(accepted, []);
  assert.equal(run.runtime.size(), 2);
  released = true;
  gate.resolve();
  assert.deepEqual(await originalStop, { ok: true, scheduled: true });
  assert.deepEqual(await secondStop, { ok: true, scheduled: true });
  assert.deepEqual(accepted, ["user-1", "user-2"]);
  assert.equal(run.runtime.size(), 0);
});

for (const earlyInvalidMiddleStop of [false, true]) {
  test(`consecutive Claude starts inherit pending settlement without deadlock (invalid middle Stop=${earlyInvalidMiddleStop})`, async (t) => {
    const entered = Promise.withResolvers(), gate = Promise.withResolvers();
    let block = false, released = false;
    const accepted = [];
    const run = await fixture(t, {
      repositoryMemorySession: { async resolve() {
        if (block) {
          block = false;
          entered.resolve();
          await gate.promise;
        }
        return { ok: true, memory: { config: {}, scope: run.scope } };
      } },
      automaticWriteback(input) {
        assert.equal(released, true, "inherited pending work must settle before a successor enqueues");
        accepted.push(input.codingTurn.turnId);
        return { accepted: true };
      },
    });
    t.after(() => gate.resolve());
    await run.save([]);
    await run.runtime.recordTurnStart({ ...run.command, prompt: "First request." });
    const first = records(1, "First request.");
    const second = records(2, "Second request.");
    const third = records(3, "Third request.");
    await run.save(first);
    block = true;
    const originalStop = run.runtime.writeback({ ...run.command, lastAssistantMessage: "First answer." });
    await entered.promise;
    assert.equal((await run.runtime.recordTurnStart({ ...run.command, prompt: second[0].message.content })).ok, true);
    await run.save([...first, ...second]);
    if (earlyInvalidMiddleStop) {
      assert.deepEqual(await run.runtime.writeback({ ...run.command,
        transcriptPath: run.command.transcriptPath + ".wrong", lastAssistantMessage: "Second answer." }),
        { ok: true, scheduled: false, reason: "turn_metadata_mismatch" });
    }
    // Register the third start before releasing the first Stop. The second native
    // completion is already in this start's prefix even if its Stop never arrives.
    const thirdStart = await run.runtime.recordTurnStart({ ...run.command, prompt: third[0].message.content });
    assert.equal(thirdStart.ok, true, "inherited settlement must not block start registration");
    await run.save([...first, ...second, ...third]);
    let successorFinished = false;
    const thirdStop = run.runtime.writeback({ ...run.command, lastAssistantMessage: "Third answer." })
      .then(result => { successorFinished = true; return result; });
    await new Promise(setImmediate);
    assert.equal(successorFinished, false);
    assert.deepEqual(accepted, []);
    assert.equal(run.runtime.size(), 3);
    released = true;
    gate.resolve();
    assert.deepEqual(await originalStop, { ok: true, scheduled: true });
    assert.deepEqual(await thirdStop, { ok: true, scheduled: true });
    assert.deepEqual(accepted, earlyInvalidMiddleStop ? ["user-1", "user-3"] : ["user-1", "user-2", "user-3"]);
    assert.equal(run.runtime.size(), earlyInvalidMiddleStop ? 1 : 0,
      "a rejected middle attempt retains metadata; only accepted completions consume it");
  });
}


test("a delayed predecessor reconciliation cannot overwrite a newer Claude start", async (t) => {
  const entered = Promise.withResolvers(), gate = Promise.withResolvers();
  const accepted = [];
  const coordinator = createMemoryTurnCoordinator({ automaticWriteback(input) {
    accepted.push([input.codingTurn.turnId, input.userText]);
    return { accepted: true };
  } });
  const run = await fixture(t, { turnCoordinator: {
    ...coordinator,
    completeMaterializedTurn(input) {
      return coordinator.completeMaterializedTurn({ ...input, async resolveRepositoryMemory() {
        if (input.nativeTurnId === "user-1") {
          entered.resolve();
          await gate.promise;
        }
        return input.resolveRepositoryMemory();
      } });
    },
  } });
  t.after(() => { gate.resolve(); coordinator.close(); });
  const first = records(1, "First request.");
  const second = records(2, "Second request.")[0];
  const third = records(3, "Third request.");
  third[0].parentUuid = second.uuid;
  await run.save([]);
  await run.runtime.recordTurnStart({ ...run.command, prompt: first[0].message.content });
  await run.save(first);
  // Starting B discovers A's missed Stop, then pauses A at scope validation.
  const secondStart = run.runtime.recordTurnStart({ ...run.command, prompt: second.message.content });
  await entered.promise;
  await run.save([...first, second]);
  assert.equal((await run.runtime.recordTurnStart({ ...run.command, prompt: third[0].message.content })).ok, true);
  await run.save([...first, second, ...third]);
  gate.resolve();
  assert.equal((await secondStart).ok, true);
  // A late completion of B's start must not replace the already registered C.
  assert.deepEqual(await run.runtime.writeback({ ...run.command, lastAssistantMessage: "Third answer." }),
    { ok: true, scheduled: true });
  assert.deepEqual(accepted, [["user-1", "First request."], ["user-3", "Third request."]]);
  assert.equal(run.runtime.size(), 0);
});
