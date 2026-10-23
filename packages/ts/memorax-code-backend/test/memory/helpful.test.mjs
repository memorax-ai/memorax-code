import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildHelpfulEvaluations, createHelpfulBudget, releaseHelpfulSearches, helpfulSettings,
} from "../../dist/memory/helpful.js";
import { createMemoryTurnCoordinator } from "../../dist/memory/turn-coordinator.js";
import { createAutomaticMemoryWritebackRuntime } from "../../dist/memory/automatic-writeback.js";
import { registerHelpfulSearch } from "../../dist/memory/helpful-bridge.js";

const scope = {
  baseUserId: "base", effectiveUserId: "base@repo", workspaceRoot: "/synthetic/repo",
  canonicalWorkspaceRoot: "/synthetic/repo", repositorySlug: "repo", kind: "general",
};
const batch = (budget, k = 2) => Array.from({ length: 8 }, (_, i) => ({
  helpfulTurn: { turnId: `t${i + 1}`, index: i + 1, complete: true,
    searches: [budget.reserve(randomUUID(), k)] },
  messages: [{ role: "user", content: `u${i + 1}` }, { role: "assistant", content: `a${i + 1}` }],
}));

test("Search bridge follows existing Backend transport with or without a configured token", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "helpful-bridge-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const searchId = randomUUID();
  for (const token of [undefined, "synthetic-local-token"]) {
    const sent = [];
    await registerHelpfulSearch({ search_id: searchId }, {
      client: "codex", sessionId: "native-session", turnId: "native-turn",
    }, {
      MEMORAX_CODE_HOME: home,
      ...(token ? { MEMORAX_CODE_BACKEND_TOKEN: token } : {}),
    }, async (url, init) => {
      sent.push({ url, init });
      return Response.json({ accepted: true });
    });
    assert.equal(sent.length, 1);
    assert.equal(new URL(sent[0].url).pathname, "/memory/helpful-search");
    assert.equal(sent[0].init.headers["x-memorax-code-backend-token"], token);
    assert.deepEqual(JSON.parse(sent[0].init.body), {
      version: 1, context_turns_k: 2, client: "codex",
      sessionId: "native-session", clientTurnId: "native-turn", search_id: searchId,
    });
  }
});

test("eight turns: six complete windows, no candidate payload, no cross-batch retention", () => {
  const budget = createHelpfulBudget(), turns = batch(budget), reasons = [];
  const result = buildHelpfulEvaluations("codex", "s", turns, r => reasons.push(r));
  assert.equal(result.length, 6);
  assert.deepEqual(reasons, ["incomplete_window", "incomplete_window"]);
  assert.deepEqual(result[5].turns.map(t => t.assistant_message), ["a6", "a7", ""]);
  assert.equal("summaries" in result[0], false);
  for (const t of turns) releaseHelpfulSearches(t.helpfulTurn.searches);
  assert.deepEqual(budget.size(), { entries: 0, bytes: 0 });
  assert.deepEqual(buildHelpfulEvaluations("codex", "s", turns), []);
});

test("K is fixed per Search; reorder uses indices; gaps/duplicates/truncation cannot qualify", () => {
  const budget = createHelpfulBudget(), turns = batch(budget, 3);
  assert.equal(buildHelpfulEvaluations("codex", "s", turns.toReversed()).length, 5);
  turns[0].helpfulTurn.searches.push(budget.reserve(randomUUID(), 2));
  assert.equal(buildHelpfulEvaluations("codex", "s", turns).length, 6);
  const firstSearch = turns[0].helpfulTurn.searches[0].search_id;
  turns[1].helpfulTurn.complete = false;
  assert.equal(buildHelpfulEvaluations("codex", "s", turns).some(r => r.search_id === firstSearch), false);
  turns[1].helpfulTurn.complete = true;
  turns[1].helpfulTurn.index = 3;
  assert.equal(buildHelpfulEvaluations("codex", "s", turns).some(r => r.search_id === firstSearch), false);
  turns[0].helpfulTurn.index = undefined;
  assert.equal(buildHelpfulEvaluations("trae", "s", turns).some(r => r.search_id === firstSearch), false);
  assert.deepEqual(buildHelpfulEvaluations("codex", "s", turns, undefined, 1), []);
});

test("metadata capacity is released with owners; receipt IDs cannot stand in for Search IDs", () => {
  const budget = createHelpfulBudget(1, 1024);
  assert.equal(budget.reserve("receipt", 2), undefined);
  assert.equal(budget.reserve(randomUUID(), 1), undefined);
  const item = budget.reserve(randomUUID(), 2);
  assert.equal(budget.reserve(randomUUID(), 2), undefined);
  item.release(); item.release();
  assert.equal(budget.size().entries, 0);
  assert.ok(budget.reserve(randomUUID(), 4));
  assert.equal(createHelpfulBudget(256, 1).reserve(randomUUID(), 2), undefined);
});

for (const client of ["codex", "claude-code", "dsh", "opencode", "codebuddy", "workbuddy", "trae", "cursor"]) {
  test(`${client}: shared completion transfers Search metadata to actual Add and clears it`, async (t) => {
    const home = await mkdtemp(join(tmpdir(), "helpful-add-"));
    t.after(() => rm(home, { recursive: true, force: true }));
    const sent = [], budget = createHelpfulBudget();
    const env = {
      MEMORAX_CODE_HOME: home, MEMORAX_CODE_MEMORAX_API_KEY: "synthetic",
      MEMORAX_CODE_MEMORAX_USER_ID: "base", MEMORAX_CODE_MEMORAX_ENDPOINT: "http://synthetic.invalid",
      MEMORAX_CODE_MEMORY_WRITEBACK_ENABLED: "true",
      MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_MAX_TURNS: "8",
    };
    const runtime = createAutomaticMemoryWritebackRuntime({ memoraxCodeHome: home });
    const coordinator = createMemoryTurnCoordinator({ automaticWriteback: runtime.enqueue });
    t.after(() => { coordinator.close(); runtime.close(); });
    const memory = { ok: true, memory: { scope, config: {} } };
    for (let i = 1; i <= 8; i++) {
      const key = { client, sessionId: "s", clientTurnId: `t${i}` };
      const metadata = coordinator.recordTurnStart({
        ...key, createdAt: Date.now(), sessionTurnIndex: i, repositoryMemory: memory,
      });
      metadata.helpfulSearches.push(budget.reserve(randomUUID(), 2));
      const result = await coordinator.completeMaterializedTurn({
        key, metadata, resolveRepositoryMemory: async () => memory,
        ...(client === "claude-code" ? { nativeTurnId: `native-${i}` } : {}),
        userText: `Useful question ${i}`, assistantText: `Detailed answer ${i}`,
        writeback: { client, sessionKey: "s", env, fetchImpl: async (url, init) => {
          assert.equal(new URL(url).pathname, "/v1/memories/add");
          sent.push(JSON.parse(init.body));
          return Response.json({ success: true, data: { status: "accepted", task_id: randomUUID() } }, { status: 202 });
        } },
      });
      assert.equal(result.scheduled, true);
      if (i < 8) assert.equal(sent.length, 0);
    }
    await runtime.drain();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].helpful_evaluations.length, 6);
    assert.equal(sent[0].helpful_evaluations[0].client, client);
    assert.equal("coding_context" in sent[0], false);
    assert.equal(budget.size().entries, 0);
  });
}

test("Helpful disabled or Add disabled sends no evaluation; closing releases buffered metadata", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "helpful-flags-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  for (const helpful of [true, false]) {
    for (const add of [true, false]) {
      const budget = createHelpfulBudget(), sent = [];
      const runtime = createAutomaticMemoryWritebackRuntime({ memoraxCodeHome: home, helpfulEnabled: () => helpful });
      const coordinator = createMemoryTurnCoordinator({ automaticWriteback: runtime.enqueue });
      for (let i = 1; i <= 3; i++) {
        const key = { client: "codex", sessionId: `${helpful}-${add}`, clientTurnId: `t${i}` };
        const memory = { ok: true, memory: { scope, config: {} } };
        const metadata = coordinator.recordTurnStart({
          ...key, createdAt: Date.now(), sessionTurnIndex: i, repositoryMemory: memory,
        });
        metadata.helpfulSearches.push(budget.reserve(randomUUID(), 2));
        await coordinator.completeMaterializedTurn({
          key, metadata, resolveRepositoryMemory: async () => memory,
          userText: `Question ${i}`, assistantText: `Answer ${i}`,
          writeback: { client: "codex", sessionKey: key.sessionId, env: {
            MEMORAX_CODE_HOME: home, MEMORAX_CODE_MEMORAX_API_KEY: "synthetic",
            MEMORAX_CODE_MEMORAX_USER_ID: "base", MEMORAX_CODE_MEMORY_WRITEBACK_ENABLED: String(add),
          }, fetchImpl: async (url, init) => {
            sent.push(JSON.parse(init.body));
            return Response.json({ success: true, data: { status: "accepted", task_id: randomUUID() } }, { status: 202 });
          } },
        });
      }
      await runtime.drain();
      assert.equal(sent.length, add ? 1 : 0);
      if (add) assert.equal(Boolean(sent[0].helpful_evaluations), helpful);
      coordinator.close(); runtime.close();
      assert.equal(budget.size().entries, 0);
    }
  }
});

test("configuration defaults to enabled, validates K independently of Add", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "helpful-settings-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  assert.deepEqual(helpfulSettings(home), { enabled: true, k: 2 });
  await writeFile(join(home, "config.toml"), "[helpful]\nenabled=false\ncontext_turns_k=4\n");
  assert.deepEqual(helpfulSettings(home), { enabled: false, k: 4 });
  await writeFile(join(home, "config.toml"), "[helpful]\ncontext_turns_k=1\n");
  assert.equal(helpfulSettings(home).enabled, false);
});

test("chunking freezes one attachment for Add retries and never repeats it in later chunks", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "helpful-chunks-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const sent = [], budget = createHelpfulBudget(), search = budget.reserve(randomUUID(), 2);
  const runtime = createAutomaticMemoryWritebackRuntime({ memoraxCodeHome: home });
  t.after(() => runtime.close());
  for (let i = 1; i <= 3; i++) {
    runtime.enqueue({
      client: "codex", sessionKey: "chunked", repositoryScope: scope,
      userText: `question ${i}: ` + "context ".repeat(25),
      assistantText: `answer ${i}:\napi_key = 'synthetic-private-credential-value'\n` + "explanation ".repeat(25),
      helpfulTurn: { turnId: `t${i}`, index: i, complete: true, searches: i === 1 ? [search] : [] },
      env: {
        MEMORAX_CODE_HOME: home, MEMORAX_CODE_MEMORAX_API_KEY: "synthetic",
        MEMORAX_CODE_MEMORAX_USER_ID: "base", MEMORAX_CODE_MEMORY_WRITEBACK_ENABLED: "true",
        MEMORAX_CODE_MEMORY_WRITEBACK_CHUNK_MAX_CHARS: "200",
      },
      fetchImpl: async (url, init) => {
        const payload = JSON.parse(init.body);
        sent.push(payload);
        if (sent.length === 1) return Response.json({ error: "temporary" }, { status: 503 });
        return Response.json({ success: true, data: { status: "accepted", task_id: randomUUID() } }, { status: 202 });
      },
    });
  }
  await runtime.drain();
  assert.ok(sent.length > 2);
  assert.deepEqual(sent[0].helpful_evaluations, sent[1].helpful_evaluations);
  assert.equal(sent[0].helpful_evaluations.length, 1);
  assert.ok(sent.slice(2).every(p => !("helpful_evaluations" in p)));
  assert.equal(JSON.stringify(sent).includes("synthetic-private-credential-value"), false);
  assert.equal(budget.size().entries, 0);
});

test("coordinator expiry/discard and buffer close free metadata without sending", async (t) => {
  const budget = createHelpfulBudget();
  let now = 1000;
  const coordinator = createMemoryTurnCoordinator({
    now: () => now, ttlMs: 10, automaticWriteback: () => ({ accepted: false, reason: "disabled" }),
  });
  t.after(() => coordinator.close());
  const memory = { ok: true, memory: { scope, config: {} } };
  const key = { client: "codex", sessionId: "s", clientTurnId: "n" };
  const start = () => {
    const turn = coordinator.recordTurnStart({ ...key, createdAt: now, repositoryMemory: memory });
    turn.helpfulSearches.push(budget.reserve(randomUUID(), 2));
  };
  start(); now += 11; coordinator.pruneExpired();
  assert.equal(budget.size().entries, 0);
  start(); coordinator.discardTurn(key, "interrupted");
  assert.equal(budget.size().entries, 0);
  start(); coordinator.clearHelpful();
  assert.equal(budget.size().entries, 0);
});
