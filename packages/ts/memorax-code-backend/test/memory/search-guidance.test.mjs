import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createMemorySearchGuidanceRuntime } from "../../dist/memory/search-guidance.js";
import { parseTurnStartCommand } from "../../dist/memory/hook-command.js";
import { JEV_MODEL } from "../../dist/provider/jev/adapter.js";

const scope = {
  schemaVersion: "workspace-memory-scope.v1", baseUserId: "fixture-user",
  effectiveUserId: "fixture-user-general", repositoryKey: "general", repositorySlug: "General",
  repositoryName: "General", identitySource: "general", scopeKind: "general",
};
const turn = (id, overrides = {}) => ({
  client: "cursor", sessionId: "fixture-session", clientTurnId: id,
  workspaceKind: "projectless", databasePath: "/fixture/cursor.db", createdAt: 1,
  repositoryScope: scope, ...overrides,
});
const command = (id, prompt, overrides = {}) => ({
  version: 1, client: "cursor", sessionId: "fixture-session", turnId: id, prompt,
  workspaceKind: "projectless", databasePath: "/fixture/cursor.db", ...overrides,
});
const response = () => new Response(JSON.stringify({
  model: JEV_MODEL, answers: { search_needed: { type: "noul", noul: 0.9 } },
}));
async function fixture(t, options = {}) {
  const home = await mkdtemp(join(tmpdir(), "memorax-search-guidance-"));
  const requests = [];
  const env = {
    MEMORAX_CODE_JEV_ENABLED: "true", MEMORAX_CODE_JEV_API_KEY: "fixture-jev-key",
    MEMORAX_CODE_MEMORAX_API_KEY: "fixture-memory-key", MEMORAX_CODE_MEMORAX_USER_ID: "fixture-user",
  };
  const runtime = createMemorySearchGuidanceRuntime({
    env, memoraxCodeHome: home,
    fetchImpl: async (_url, init) => { requests.push(JSON.parse(init.body)); return response(); },
    ...options,
  });
  t.after(async () => { runtime.close(); await rm(home, { recursive: true, force: true }); });
  return { runtime, env, requests };
}

test("search guidance rejects mismatched native references and a changed account without sending content", async (t) => {
  const { runtime, env, requests } = await fixture(t);
  runtime.registerTurn(turn("turn-1"), "Find prior engineering guidance");
  for (const override of [{ databasePath: "/other/cursor.db" }, { cwd: "/other/workspace" },
    { workspaceKind: "repository" }, { prompt: "different prompt" }, { sessionId: "different-session" }]) {
    assert.deepEqual(await runtime.evaluate(command("turn-1", "Find prior engineering guidance", override)), {
      ok: false, reason: "context_unavailable",
    });
  }
  assert.equal(requests.length, 0);
  assert.equal((await runtime.evaluate(command("turn-1", "Find prior engineering guidance"))).ok, true);
  assert.deepEqual(Object.keys(requests[0].state), ["current_prompt"]);
  env.MEMORAX_CODE_MEMORAX_USER_ID = "other-user";
  assert.deepEqual(await runtime.evaluate(command("turn-1", "Find prior engineering guidance")), {
    ok: false, reason: "context_unavailable",
  });
  assert.equal(requests.length, 1);
});

test("guidance requires registered optional native references before evaluation or cached-result delivery", async (t) => {
  for (const scenario of [
    { field: "cwd", body: { client: "opencode", sessionId: "session", userMessageId: "turn", cwd: "/fixture/workspace" } },
    { field: "workspaceKind", body: { client: "codex", sessionId: "session", turnId: "turn", workspaceKind: "projectless", transcriptPath: "/fixture/session.jsonl" } },
    { field: "transcriptPath", body: { client: "cursor", sessionId: "11111111-1111-4111-8111-111111111111",
      turnId: "22222222-2222-4222-8222-222222222222", workspaceKind: "projectless",
      databasePath: "/fixture/cursor.db", transcriptPath: "/fixture/transcript.txt" } },
  ]) {
    await t.test(`${scenario.body.client}: omitted ${scenario.field}`, async (t) => {
      const { runtime, requests } = await fixture(t);
      const complete = parseTurnStartCommand({ version: 1, ...scenario.body, prompt: "Check the prior fix" });
      assert.equal(complete.ok, true);
      const incomplete = { ...complete.command };
      delete incomplete[scenario.field];
      const parsed = parseTurnStartCommand(incomplete);
      assert.equal(parsed.ok, true, "the field is optional at ingress but was supplied at registration");
      runtime.registerTurn({ ...complete.command, clientTurnId: complete.command.turnId ?? complete.command.userMessageId,
        createdAt: 1, repositoryScope: scope }, complete.command.prompt);
      assert.deepEqual(await runtime.evaluate(parsed.command), { ok: false, reason: "context_unavailable" });
      assert.equal(requests.length, 0);
      assert.equal((await runtime.evaluate(complete.command)).ok, true);
      assert.deepEqual(await runtime.evaluate(parsed.command), { ok: false, reason: "context_unavailable" });
      assert.equal(requests.length, 1, "incomplete requests cannot reuse a successful cached decision either");
    });
  }
});

test("concurrent and repeated guidance evaluations share one provider attempt, including failures", async (t) => {
  const success = { ok: true, decision: "search", probability: 0.9, model: JEV_MODEL };
  for (const scenario of [
    { name: "success", response, expected: success },
    { name: "HTTP failure", response: () => new Response(null, { status: 429 }), expected: { ok: false, reason: "http_error", httpStatus: 429 } },
    { name: "transport failure", error: new Error("fixture unavailable"), expected: { ok: false, reason: "transport_error" } },
  ]) {
    await t.test(scenario.name, async (t) => {
      const pendingFetches = [];
      const { runtime } = await fixture(t, {
        fetchImpl: () => new Promise((resolve, reject) => {
          pendingFetches.push(() => scenario.error ? reject(scenario.error) : resolve(scenario.response()));
        }),
      });
      runtime.registerTurn(turn("turn-1"), "Check historical fix");
      const first = runtime.evaluate(command("turn-1", "Check historical fix"));
      const duplicate = runtime.evaluate(command("turn-1", "Check historical fix"));
      for (const finish of pendingFetches) finish();
      assert.deepEqual(await Promise.all([first, duplicate]), [scenario.expected, scenario.expected]);
      assert.equal(pendingFetches.length, 1, "concurrent evaluations must share the in-flight request");
      const repeated = runtime.evaluate(command("turn-1", "Check historical fix"));
      for (const finish of pendingFetches) finish();
      assert.deepEqual(await repeated, scenario.expected);
      assert.equal(pendingFetches.length, 1, "a completed provider attempt must not be retried in the same turn");
    });
  }
});

test("an A-B-A-B start replay reuses B's decision without a second provider request", async (t) => {
  const { runtime, requests } = await fixture(t);
  const first = turn("turn-A");
  const second = turn("turn-B");
  runtime.registerTurn(first, "First request");
  assert.equal((await runtime.evaluate(command("turn-A", "First request"))).ok, true);
  runtime.completeTurn({ key: first, repositoryScope: scope, userText: "First request", assistantText: "First answer" });
  runtime.registerTurn(second, "Second request");
  const decision = await runtime.evaluate(command("turn-B", "Second request"));
  assert.equal(decision.ok, true);
  assert.deepEqual(requests[1].state.previous_turn, { user: "First request", assistant: "First answer" });

  runtime.registerTurn(first, "First request");
  assert.deepEqual(await runtime.evaluate(command("turn-A", "First request")), { ok: false, reason: "context_unavailable" });
  runtime.registerTurn(second, "Second request");
  assert.deepEqual(await runtime.evaluate(command("turn-B", "Second request")), decision);
  assert.equal(requests.length, 2);

  runtime.completeTurn({ key: second, repositoryScope: scope, userText: "Second request", assistantText: "Second answer" });
  runtime.registerTurn(turn("turn-C"), "Third request");
  assert.equal((await runtime.evaluate(command("turn-C", "Third request"))).ok, true);
  assert.equal(requests.length, 3);
  assert.deepEqual(requests[2].state.previous_turn, { user: "Second request", assistant: "Second answer" });
});

test("search guidance discards a successful in-flight decision when its registered turn changes", async (t) => {
  let release;
  const { runtime } = await fixture(t, {
    fetchImpl: () => new Promise((resolve) => { release = resolve; }),
  });
  runtime.registerTurn(turn("turn-1"), "Check historical fix");
  const pending = runtime.evaluate(command("turn-1", "Check historical fix"));
  assert.equal(typeof release, "function");
  runtime.registerTurn(turn("turn-2"), "New unrelated task");
  release(response());
  assert.deepEqual(await pending, { ok: false, reason: "context_unavailable" });
});

test("search guidance does not advance duplicate starts and clears retained context on eviction or disablement", async (t) => {
  const { runtime, env, requests } = await fixture(t, { maxEntries: 1 });
  const first = turn("turn-1");
  runtime.registerTurn(first, "Earlier request");
  runtime.completeTurn({ key: first, repositoryScope: scope, userText: "Earlier request", assistantText: "Final answer" });
  runtime.registerTurn(first, "Earlier request");
  runtime.registerTurn(turn("turn-2"), "Continue");
  await runtime.evaluate(command("turn-2", "Continue"));
  assert.deepEqual(requests[0].state.previous_turn, { user: "Earlier request", assistant: "Final answer" });

  runtime.registerTurn(turn("other-turn", { sessionId: "other-session" }), "Other session");
  assert.deepEqual(await runtime.evaluate(command("turn-2", "Continue")), { ok: false, reason: "context_unavailable" });
  runtime.completeTurn({ key: first, repositoryScope: scope, userText: "Earlier request", assistantText: "Late stale answer" });
  runtime.registerTurn(turn("turn-3"), "Resume original session");
  await runtime.evaluate(command("turn-3", "Resume original session"));
  assert.equal(requests[1].state.previous_turn, undefined);

  env.MEMORAX_CODE_JEV_ENABLED = "false";
  assert.equal(runtime.isEnabled(), false);
  env.MEMORAX_CODE_JEV_ENABLED = "true";
  assert.deepEqual(await runtime.evaluate(command("turn-3", "Resume original session")), { ok: false, reason: "context_unavailable" });
  runtime.registerTurn(turn("turn-4"), "Fresh request");
  runtime.registerTurn(turn("turn-4"), "Conflicting duplicate");
  assert.deepEqual(await runtime.evaluate(command("turn-4", "Fresh request")), { ok: false, reason: "context_unavailable" });
  assert.equal(requests.length, 2);
});


test("retired starts and completions cannot replace the current turn or its successor context", async (t) => {
  const { runtime, requests } = await fixture(t);
  const first = turn("turn-1");
  const second = turn("turn-2");
  runtime.registerTurn(first, "First request");
  runtime.completeTurn({ key: first, repositoryScope: scope, userText: "First request", assistantText: "First answer" });
  runtime.registerTurn(second, "Second request");
  runtime.registerTurn(first, "Conflicting replay of the first request");
  await runtime.evaluate(command("turn-2", "Second request"));
  assert.deepEqual(requests[0].state.previous_turn, { user: "First request", assistant: "First answer" });

  runtime.completeTurn({ key: second, repositoryScope: scope, userText: "Second request", assistantText: "Second answer" });
  runtime.registerTurn(first, "First request");
  runtime.completeTurn({ key: first, repositoryScope: scope, userText: "First request", assistantText: "Replayed first answer" });
  assert.deepEqual(await runtime.evaluate(command("turn-1", "First request")), { ok: false, reason: "context_unavailable" });
  runtime.registerTurn(turn("turn-3"), "Third request");
  await runtime.evaluate(command("turn-3", "Third request"));
  assert.deepEqual(requests[1].state.previous_turn, { user: "Second request", assistant: "Second answer" });
});

test("known retired identities preserve a current entry after its account and scope change", async (t) => {
  const { runtime, env, requests } = await fixture(t);
  const first = turn("turn-1");
  runtime.registerTurn(first, "Original account request");
  runtime.completeTurn({ key: first, repositoryScope: scope, userText: "Original account request", assistantText: "Original account answer" });
  const newScope = { ...scope, baseUserId: "other-user", effectiveUserId: "other-user-general" };
  env.MEMORAX_CODE_MEMORAX_USER_ID = "other-user";
  runtime.registerTurn(turn("turn-2", { repositoryScope: newScope }), "New account request");
  runtime.registerTurn(first, "Original account request");
  runtime.completeTurn({ key: first, repositoryScope: scope, userText: "Original account request", assistantText: "Original account answer" });
  assert.equal((await runtime.evaluate(command("turn-2", "New account request"))).ok, true);
  assert.deepEqual(requests[0].state, { current_prompt: "New account request" });
});

test("retired identity overflow and session eviction resume with current-only guidance", async (t) => {
  const { runtime, requests } = await fixture(t, { maxEntries: 1 });
  for (let index = 1; index <= 257; index += 1) {
    const current = turn("turn-" + index);
    runtime.registerTurn(current, "Request " + index);
    if (index === 257) {
      await runtime.evaluate(command("turn-257", "Request 257"));
      assert.deepEqual(requests[0].state.previous_turn, { user: "Request 256", assistant: "Answer 256" });
    }
    runtime.completeTurn({ key: current, repositoryScope: scope, userText: "Request " + index, assistantText: "Answer " + index });
  }
  runtime.registerTurn(turn("turn-258"), "Request 258");
  runtime.registerTurn(turn("turn-2"), "Request 2");
  assert.equal((await runtime.evaluate(command("turn-258", "Request 258"))).ok, true);
  assert.deepEqual(requests[1].state, { current_prompt: "Request 258" });

  // The oldest retired identity is outside the bounded replay window, but it
  // cannot supply previous-QA context to itself or the next observed turn.
  const first = turn("turn-1");
  runtime.registerTurn(first, "Request 1");
  await runtime.evaluate(command("turn-1", "Request 1"));
  assert.deepEqual(requests[2].state, { current_prompt: "Request 1" });
  runtime.completeTurn({ key: first, repositoryScope: scope, userText: "Request 1", assistantText: "Replayed answer" });
  runtime.registerTurn(turn("turn-259"), "Request 259");
  await runtime.evaluate(command("turn-259", "Request 259"));
  assert.deepEqual(requests[3].state, { current_prompt: "Request 259" });

  runtime.registerTurn(turn("other-turn", { sessionId: "other-session" }), "Other session");
  runtime.registerTurn(turn("turn-258"), "Request 258");
  await runtime.evaluate(command("turn-258", "Request 258"));
  assert.deepEqual(requests[4].state, { current_prompt: "Request 258" });
});


test("invalidating a conflicting duplicate does not erase retired identities", async (t) => {
  for (const conflict of ["start", "completion"]) {
    await t.test(conflict, async (t) => {
      const { runtime, requests } = await fixture(t);
      const first = turn("turn-1");
      const second = turn("turn-2");
      runtime.registerTurn(first, "First request");
      runtime.completeTurn({ key: first, repositoryScope: scope, userText: "First request", assistantText: "First answer" });
      runtime.registerTurn(second, "Second request");
      if (conflict === "start") runtime.registerTurn(second, "Conflicting second request");
      else {
        runtime.completeTurn({ key: second, repositoryScope: scope, userText: "Second request", assistantText: "Second answer" });
        runtime.completeTurn({ key: second, repositoryScope: scope, userText: "Second request", assistantText: "Conflicting second answer" });
      }
      runtime.registerTurn(first, "First request");
      runtime.completeTurn({ key: first, repositoryScope: scope, userText: "First request", assistantText: "Replayed first answer" });
      runtime.registerTurn(turn("turn-3"), "Third request");
      await runtime.evaluate(command("turn-3", "Third request"));
      assert.deepEqual(requests[0].state, { current_prompt: "Third request" });
    });
  }
});
