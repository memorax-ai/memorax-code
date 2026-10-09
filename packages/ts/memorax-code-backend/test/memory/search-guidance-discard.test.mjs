import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createHarnessMemoryRuntime } from "../../dist/memory/harness-runtime.js";
import { createMemorySearchGuidanceRuntime } from "../../dist/memory/search-guidance.js";
import { createMemoryService } from "../../dist/memory/service.js";
import { JEV_MODEL } from "../../dist/provider/jev/adapter.js";
import { dshTurnInterval } from "../clients/dsh/support/dsh-session-fixtures.mjs";

const scope = {
  schemaVersion: "workspace-memory-scope.v1", baseUserId: "fixture-user",
  effectiveUserId: "fixture-user-general", repositoryKey: "general", repositorySlug: "General",
  repositoryName: "General", identitySource: "general", scopeKind: "general",
};
const unavailable = { ok: false, reason: "context_unavailable" };
const answer = () => Response.json({ model: JEV_MODEL, answers: { search_needed: { type: "noul", noul: 0.8 } } });
const key = (id) => ({ client: "cursor", sessionId: "fixture-session", clientTurnId: id });
const command = (id) => ({
  version: 1, client: "cursor", sessionId: "fixture-session", turnId: id, prompt: "Request " + id,
  workspaceKind: "projectless", databasePath: "/fixture/cursor.db",
});

async function fixture(t, fetchImpl) {
  const home = await mkdtemp(join(tmpdir(), "memorax-guidance-discard-"));
  const env = {
    MEMORAX_CODE_HOME: home,
    MEMORAX_CODE_MEMORAX_API_KEY: "fixture-memory-key", MEMORAX_CODE_MEMORAX_USER_ID: "fixture-user",
    MEMORAX_CODE_MEMORY_WRITEBACK_ENABLED: "false", MEMORAX_CODE_CURSOR_TRACE_ENABLED: "false",
    MEMORAX_CODE_DSH_TRACE_ENABLED: "false",
    MEMORAX_CODE_JEV_ENABLED: "true", MEMORAX_CODE_JEV_API_KEY: "fixture-jev-key",
  };
  const requests = [];
  const provider = async (url, init) => {
    assert.equal(String(url), "https://api.typesafe.ai/v1/systemone");
    requests.push(JSON.parse(init.body).state);
    return fetchImpl ? fetchImpl() : answer();
  };
  const guidance = createMemorySearchGuidanceRuntime({ env, memoraxCodeHome: home, fetchImpl: provider });
  let now = 1;
  const memory = { ok: true, memory: { scope } };
  const harness = createHarnessMemoryRuntime({
    client: "cursor", writebackSource: "cursor_hook_writeback", diagnosticPrefix: "fixture",
    traceFailureEvent: "fixture.trace_failure", quotaNotices: false,
  }, {
    env, memoraxCodeHome: home, searchGuidance: guidance, now: () => now, ttlMs: 10,
    automaticWriteback: () => ({ accepted: true }),
  });
  const coordinator = harness.turnCoordinator;
  t.after(async () => { harness.close(); guidance.close(); await rm(home, { recursive: true, force: true }); });
  return {
    home, env, provider, guidance, coordinator, requests,
    expire() { now += 11; coordinator.pruneExpired(); },
    async start(id) {
      await harness.recordTurnStart({
        sessionId: key(id).sessionId, clientTurnId: id, prompt: command(id).prompt,
        workspaceKind: "projectless", databasePath: command(id).databasePath,
        createdAt: now, repositoryMemory: memory,
      });
    },
    complete(id) {
      return harness.completeTurn({
        sessionId: key(id).sessionId, clientTurnId: id, metadata: coordinator.getTurn(key(id)),
        userText: command(id).prompt, assistantText: "Answer " + id,
        resolveRepositoryMemory: async () => memory,
      });
    },
  };
}

test("standalone harness discards guidance even after metadata expiry and rejects late replays", async (t) => {
  for (const reason of ["interrupted", "rolled_back", "superseded"]) {
    for (const expired of [false, true]) {
      await t.test(`${reason}, expired=${expired}`, async (t) => {
        const f = await fixture(t);
        await f.start("A");
        await f.complete("A");
        await f.start("B");
        if (expired) f.expire();
        assert.equal(f.coordinator.discardTurn(key("B"), reason), !expired);
        assert.deepEqual(await f.guidance.evaluate(command("B")), unavailable);

        await f.start("B");
        await f.complete("B");
        assert.deepEqual(await f.guidance.evaluate(command("B")), unavailable);
        await f.start("A");
        await f.complete("A");
        assert.deepEqual(await f.guidance.evaluate(command("A")), unavailable);
        assert.equal(f.requests.length, 0);

        await f.start("C");
        assert.equal((await f.guidance.evaluate(command("C"))).ok, true);
        assert.deepEqual(f.requests, [{ current_prompt: "Request C" }]);
      });
    }
  }
});

test("discard invalidates the result of an already running guidance request", async (t) => {
  for (const reason of ["interrupted", "rolled_back", "superseded"]) await t.test(reason, async (t) => {
    let release;
    const f = await fixture(t, () => new Promise((resolve) => { release = () => resolve(answer()); }));
    await f.start("A");
    const pending = f.guidance.evaluate(command("A"));
    assert.equal(typeof release, "function");
    assert.equal(f.coordinator.discardTurn(key("A"), reason), true);
    release();
    assert.deepEqual(await pending, unavailable);
    assert.deepEqual(await f.guidance.evaluate(command("A")), unavailable);
    assert.equal(f.requests.length, 1);
  });
});

test("only normal supersession preserves completed QA after writeback consumes metadata", async (t) => {
  for (const reason of ["interrupted", "rolled_back", "superseded"]) await t.test(reason, async (t) => {
    const f = await fixture(t);
    await f.start("A");
    assert.equal((await f.complete("A")).metadataDisposition, "consumed");
    assert.equal(f.coordinator.discardTurn(key("A"), reason), false);
    assert.deepEqual(await f.guidance.evaluate(command("A")), unavailable);
    await f.start("B");
    assert.equal((await f.guidance.evaluate(command("B"))).ok, true);
    assert.deepEqual(f.requests, [{ current_prompt: "Request B",
      ...(reason === "superseded" ? { previous_turn: { user: "Request A", assistant: "Answer A" } } : {}),
    }]);
  });
});

test("completed QA survives normal consumption while discards affect only the matching current client and turn", async (t) => {
  const f = await fixture(t);
  await f.start("A");
  assert.equal((await f.complete("A")).metadataDisposition, "consumed");
  await f.start("B");
  assert.equal((await f.guidance.evaluate(command("B"))).ok, true);
  assert.deepEqual(f.requests[0].previous_turn, { user: "Request A", assistant: "Answer A" });
  assert.equal(f.coordinator.discardTurn(key("A"), "interrupted"), false);
  assert.equal((await f.guidance.evaluate(command("B"))).ok, true);
  assert.equal(f.requests.length, 1);

  const foreign = {
    version: 1, client: "opencode", sessionId: "fixture-session", userMessageId: "B",
    workspaceKind: "projectless", prompt: "Independent request",
  };
  f.guidance.registerTurn({
    client: foreign.client, sessionId: foreign.sessionId, clientTurnId: foreign.userMessageId,
    workspaceKind: foreign.workspaceKind, createdAt: 1, repositoryScope: scope,
  }, foreign.prompt);
  f.coordinator.discardTurn(key("B"), "rolled_back");
  assert.deepEqual(await f.guidance.evaluate(command("B")), unavailable);
  assert.equal((await f.guidance.evaluate(foreign)).ok, true);
  assert.deepEqual(f.requests[1], { current_prompt: foreign.prompt });
});

test("native DSH interruption through the shared service revokes guidance and prior QA", async (t) => {
  const f = await fixture(t);
  const cwd = join(f.home, "workspace");
  await mkdir(cwd);
  const service = createMemoryService({ env: f.env, memoraxCodeHome: f.home, fetchImpl: f.provider });
  t.after(async () => { await service.drain(); service.close(); });
  const first = dshTurnInterval({ cwd, sessionId: "native-discard-session", turn: 1 });
  await service.recordTurnStart({
    version: 1, client: "dsh", sessionId: first.sessionId, turn: 1,
    startSeq: first.startSeq, cwd, prompt: "Implement the DSH adapter.",
  });
  await service.writebackTurn({ version: 1, client: "dsh", ...first });
  const second = dshTurnInterval({ cwd, sessionId: first.sessionId, turn: 2, startSeq: first.endSeq + 1 });
  second.events[1].data.content[0].text = "Interrupted request";
  second.events.at(-1).data.reason.kind = "cancelled";
  const start = {
    version: 1, client: "dsh", sessionId: second.sessionId, turn: 2,
    startSeq: second.startSeq, cwd, prompt: "Interrupted request",
  };
  await service.recordTurnStart(start);
  const stopped = await service.writebackTurn({ version: 1, client: "dsh", ...second });
  assert.equal(stopped.reason, "turn_not_completed");
  assert.deepEqual(await service.evaluateSearchGuidance(start), unavailable);
  assert.equal(f.requests.length, 0);
  const next = { ...start, turn: 3, startSeq: second.endSeq + 1, prompt: "New task" };
  await service.recordTurnStart(next);
  assert.equal((await service.evaluateSearchGuidance(next)).ok, true);
  assert.deepEqual(f.requests, [{ current_prompt: next.prompt }]);
});
