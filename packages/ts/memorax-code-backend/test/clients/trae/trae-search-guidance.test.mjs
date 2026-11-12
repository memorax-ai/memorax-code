import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createTraeMemoryHookRuntime } from "../../../dist/clients/trae/memory-hook-runtime.js";
import { createMemorySearchGuidanceRuntime } from "../../../dist/memory/search-guidance.js";
import { JEV_MODEL } from "../../../dist/provider/jev/adapter.js";

const unavailable = { ok: false, reason: "context_unavailable" };
const answer = () => Response.json({ model: JEV_MODEL, answers: { search_needed: { type: "noul", noul: 0.8 } } });

test("Trae preserves completed search context independently of automatic Add acceptance", async (t) => {
  for (const mode of ["disabled", "rejected", "accepted"]) {
    await t.test(mode, async (t) => {
      const f = await fixture(t, { mode });
      const first = f.command("A");
      const second = f.command("B");
      await f.runtime.recordTurnStart(first);
      const completed = await f.runtime.writeback({ ...first, lastAssistantMessage: "Final answer A" });
      assert.equal(completed.scheduled, mode === "accepted");
      if (mode !== "accepted") assert.equal(completed.reason, mode === "disabled" ? "disabled" : "decision_error");
      assert.equal(f.runtime.size(), mode === "accepted" ? 0 : 1);

      await f.runtime.recordTurnStart(second);
      assert.equal((await f.guidance.evaluate(second)).decision, "search");
      assert.deepEqual(f.requests, [{
        current_prompt: second.prompt,
        previous_turn: { user: first.prompt, assistant: "Final answer A" },
      }]);
      await f.runtime.recordTurnStart(first);
      assert.deepEqual(await f.guidance.evaluate(first), unavailable);
      assert.equal((await f.guidance.evaluate(second)).decision, "search");
      assert.equal(f.requests.length, 1, "a completed start replay must preserve the current decision");
      const secondCompletion = await f.runtime.writeback({ ...second, lastAssistantMessage: "Final answer B" });
      assert.equal(secondCompletion.scheduled, mode === "accepted");
      if (mode !== "accepted") assert.equal(secondCompletion.reason, mode === "disabled" ? "disabled" : "decision_error");
    });
  }
});

test("Trae replacement still invalidates an unfinished turn and its in-flight search decision", async (t) => {
  let providerStarted;
  const started = new Promise((resolve) => { providerStarted = resolve; });
  let releaseProvider;
  const pending = new Promise((resolve) => { releaseProvider = resolve; });
  const f = await fixture(t, { mode: "rejected", fetchImpl: async (_, index) => {
    if (index === 1) { providerStarted(); await pending; }
    return answer();
  } });
  const first = f.command("A");
  const interrupted = f.command("B");
  const current = f.command("C");
  await f.runtime.recordTurnStart(first);
  await f.runtime.writeback({ ...first, lastAssistantMessage: "Final answer A" });
  await f.runtime.recordTurnStart(interrupted);
  const decision = f.guidance.evaluate(interrupted);
  await started;
  assert.deepEqual(f.requests[0].previous_turn, { user: first.prompt, assistant: "Final answer A" });

  await f.runtime.recordTurnStart(current);
  releaseProvider();
  assert.deepEqual(await decision, unavailable);
  assert.deepEqual(await f.runtime.writeback({ ...interrupted, lastAssistantMessage: "Late interrupted answer" }), {
    ok: true, scheduled: false, reason: "interrupted",
  });
  await f.runtime.recordTurnStart(interrupted);
  assert.deepEqual(await f.guidance.evaluate(interrupted), unavailable);
  assert.equal((await f.guidance.evaluate(current)).decision, "search");
  assert.deepEqual(f.requests[1], { current_prompt: current.prompt });
  assert.equal(f.requests.length, 2);
});

test("Trae completed context cannot cross a changed workspace", async (t) => {
  const f = await fixture(t, { mode: "disabled" });
  const first = f.command("A");
  await f.runtime.recordTurnStart(first);
  await f.runtime.writeback({ ...first, lastAssistantMessage: "Final answer A" });
  const otherWorkspace = join(f.root, "other-workspace");
  await mkdir(otherWorkspace);
  const next = { ...f.command("B"), cwd: otherWorkspace };
  await f.runtime.recordTurnStart(next);
  assert.deepEqual(await f.guidance.evaluate(next), unavailable);
  assert.equal(f.requests.length, 0);
});

async function fixture(t, { mode, fetchImpl } = {}) {
  const root = await mkdtemp(join(tmpdir(), "memorax-trae-guidance-"));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  await Promise.all([mkdir(home), mkdir(workspace)]);
  const env = {
    MEMORAX_CODE_HOME: home,
    MEMORAX_CODE_MEMORAX_API_KEY: "fixture-memory-key", MEMORAX_CODE_MEMORAX_USER_ID: "fixture-user",
    MEMORAX_CODE_MEMORY_WRITEBACK_ENABLED: mode === "disabled" ? "false" : "true",
    MEMORAX_CODE_TRAE_TRACE_ENABLED: "false",
    MEMORAX_CODE_JEV_ENABLED: "true", MEMORAX_CODE_JEV_API_KEY: "fixture-jev-key",
  };
  const requests = [];
  const guidance = createMemorySearchGuidanceRuntime({ env, memoraxCodeHome: home, fetchImpl: async (url, init) => {
    assert.equal(String(url), "https://api.typesafe.ai/v1/systemone");
    const state = JSON.parse(init.body).state;
    requests.push(state);
    return fetchImpl ? fetchImpl(state, requests.length) : answer();
  } });
  const runtime = createTraeMemoryHookRuntime({
    env, memoraxCodeHome: home, searchGuidance: guidance,
    fetchImpl: () => { throw new Error("Automatic Add must not contact a provider in this test"); },
    ...(mode !== "disabled" ? { automaticWriteback: () => mode === "accepted"
      ? { accepted: true } : { accepted: false, reason: "decision_error" } } : {}),
  });
  t.after(async () => { runtime.close(); guidance.close(); await rm(root, { recursive: true, force: true }); });
  return {
    root, runtime, guidance, requests,
    command(id) {
      const sessionId = "fixture-trae-session";
      const prompt = "Request " + id;
      const createdAt = 1_700_000_000_000 + id.charCodeAt(0);
      const digest = createHash("sha256").update(prompt).digest("hex");
      return { version: 1, client: "trae", sessionId, turnId: `${sessionId}:${createdAt}:${digest}`,
        prompt, cwd: workspace, workspaceKind: "project" };
    },
  };
}
