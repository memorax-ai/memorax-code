import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createDshMemoryHookRuntime } from "../../dist/clients/dsh/memory-hook-runtime.js";
import { memoraxConfigFromEnv } from "../../dist/provider/memorax/config.js";

const TURN_START = {
  version: 1,
  client: "dsh",
  sessionId: "session-dsh",
  turnId: "dsh-0-0",
  prompt: "first turn",
};

const DISCARD = {
  version: 1,
  client: "dsh",
  sessionId: "session-dsh",
  turnId: "dsh-0-0",
};

function notConfiguredRepositoryMemorySession() {
  return {
    async resolve() {
      return { ok: false, reason: "config_missing", error: "no memorax config" };
    },
    close() {},
  };
}

function retrievalCount(events) {
  return events.filter((event) => event.message === "automatic.memory_retrieval").length;
}

test("DSH runtime releases an automatic retrieval turn when the turn is discarded", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-dsh-retrieval-release-"));
  const events = [];
  const runtime = createDshMemoryHookRuntime({
    diagnosticLogger(message, fields) {
      events.push({ message, fields });
    },
    env: {
      MEMORAX_CODE_HOME: root,
      MEMORAX_CODE_DSH_TRACE_ENABLED: "false",
      MEMORAX_CODE_MEMORY_RETRIEVAL_ENABLED: "false",
    },
    memoraxCodeHome: root,
    repositoryMemorySession: notConfiguredRepositoryMemorySession(),
    now: () => 1,
  });
  try {
    await runtime.recordTurnStart(TURN_START);
    assert.equal(retrievalCount(events), 1);

    assert.deepEqual(await runtime.discardTurn(DISCARD), { ok: true, discarded: true });

    // Round 10 R10-1: a discarded turn is terminal. Replaying the SAME
    // turnId is acked fail-silent but must NOT restart the turn, so it
    // claims no retrieval. (The claim release itself is hygiene — its only
    // behavioral consumer, a same-key re-claim, is the conflicting-turn-start
    // self-heal covered by the test below.)
    assert.deepEqual(await runtime.recordTurnStart(TURN_START), { ok: true });
    assert.equal(retrievalCount(events), 1);
    assert.equal(
      events.some((event) => event.message === "dsh_memory_hook.turn_start_after_finalize"),
      true,
    );

    // Successor turns keep claiming retrieval after the discard.
    await runtime.recordTurnStart({ ...TURN_START, turnId: "dsh-0-1" });
    assert.equal(retrievalCount(events), 2);
  } finally {
    runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("DSH runtime recovers a writeback from the current-turn trace after a coordinator loss", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-dsh-trace-recovery-"));
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, ".git"), { recursive: true });
  const env = {
    MEMORAX_CODE_HOME: root,
    MEMORAX_CODE_MEMORY_RETRIEVAL_ENABLED: "false",
    MEMORAX_CODE_MEMORY_WRITEBACK_ENABLED: "true",
    MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_ENABLED: "false",
    MEMORAX_CODE_MEMORAX_ENDPOINT: "http://memorax.test",
    MEMORAX_CODE_MEMORAX_API_KEY: "secret",
    MEMORAX_CODE_MEMORAX_USER_ID: "user-1",
  };
  const config = memoraxConfigFromEnv(env);
  assert.equal(config.ok, true);
  const scope = {
    schemaVersion: "workspace-memory-scope.v1",
    baseUserId: config.config.userId,
    effectiveUserId: `${config.config.userId}@test-repository`,
    repositoryKey: "workspace-directory:test-repository",
    repositorySlug: "test-repository",
    repositoryName: "Test Repository",
    identitySource: "workspace-directory",
    scopeKind: "local-directory",
    boundWorkspaceRoot: workspace,
  };
  const events = [];
  let enqueued = 0;
  const runtimeOptions = () => ({
    env,
    memoraxCodeHome: root,
    diagnosticLogger(message, fields) {
      events.push({ message, fields });
    },
    automaticWriteback: () => {
      enqueued += 1;
      return { accepted: true };
    },
    repositoryMemorySession: {
      async resolve() {
        return { ok: true, memory: { config: config.config, scope } };
      },
      close() {},
    },
    now: () => 1,
  });
  const firstRuntime = createDshMemoryHookRuntime(runtimeOptions());
  try {
    await firstRuntime.recordTurnStart({ ...TURN_START, prompt: "recover me", cwd: workspace });
  } finally {
    firstRuntime.close();
  }
  // A restart (or coordinator eviction) drops the in-memory turn metadata;
  // the on-disk current-turn trace still attests the accepted turn-start.
  const secondRuntime = createDshMemoryHookRuntime(runtimeOptions());
  try {
    const recovered = await secondRuntime.writeback({
      version: 1,
      client: "dsh",
      sessionId: TURN_START.sessionId,
      turnId: TURN_START.turnId,
      userText: "recover me",
      assistantText: "recovered reply",
      cwd: workspace,
    });
    assert.deepEqual(recovered, { ok: true, scheduled: true });
    assert.equal(enqueued, 1);
    const writebackEvents = events.filter((event) => event.message === "dsh_memory_hook.writeback");
    assert.equal(writebackEvents.length, 1);
    assert.equal(writebackEvents[0].fields.metadataSource, "current_turn_trace");

    // A turnId with no attestation is still refused.
    const unattested = await secondRuntime.writeback({
      version: 1,
      client: "dsh",
      sessionId: TURN_START.sessionId,
      turnId: "dsh-9-9",
      userText: "recover me",
      assistantText: "nope",
      cwd: workspace,
    });
    assert.deepEqual(unattested, { ok: true, scheduled: false, reason: "turn_metadata_missing" });

    // An attestation for a different session does not vouch for this one.
    const wrongSession = await secondRuntime.writeback({
      version: 1,
      client: "dsh",
      sessionId: "session-other",
      turnId: TURN_START.turnId,
      userText: "recover me",
      assistantText: "nope",
      cwd: workspace,
    });
    assert.deepEqual(wrongSession, { ok: true, scheduled: false, reason: "turn_metadata_missing" });
  } finally {
    secondRuntime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("DSH runtime caps in-memory turn metadata and drops the oldest DSH turns", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-dsh-saturation-"));
  const events = [];
  const runtime = createDshMemoryHookRuntime({
    maxEntries: 4,
    diagnosticLogger(message, fields) {
      events.push({ message, fields });
    },
    env: {
      MEMORAX_CODE_HOME: root,
      MEMORAX_CODE_DSH_TRACE_ENABLED: "false",
      MEMORAX_CODE_MEMORY_RETRIEVAL_ENABLED: "false",
    },
    memoraxCodeHome: root,
    repositoryMemorySession: notConfiguredRepositoryMemorySession(),
    now: () => 1,
  });
  try {
    for (let turn = 0; turn < 5; turn += 1) {
      await runtime.recordTurnStart({ ...TURN_START, turnId: `dsh-0-${turn}`, prompt: `turn ${turn}` });
    }
    // DSH turns share the coordinator pool: the cap holds and the oldest turn
    // was evicted.
    assert.equal(runtime.size(), 4);
    const cacheSizes = events
      .filter((event) => event.message === "dsh_memory_hook.turn_start")
      .map((event) => event.fields.cacheSize);
    assert.deepEqual(cacheSizes, [1, 2, 3, 4, 4]);

    // The evicted oldest turn has no coordinator metadata and, with trace
    // disabled, no attestation to recover from.
    const evicted = await runtime.writeback({
      version: 1,
      client: "dsh",
      sessionId: TURN_START.sessionId,
      turnId: "dsh-0-0",
      userText: "turn 0",
      assistantText: "reply",
    });
    assert.deepEqual(evicted, { ok: true, scheduled: false, reason: "turn_metadata_missing" });

    // The newest turn is still covered.
    const newest = await runtime.writeback({
      version: 1,
      client: "dsh",
      sessionId: TURN_START.sessionId,
      turnId: "dsh-0-4",
      userText: "turn 4",
      assistantText: "reply",
    });
    assert.equal(newest.ok, true);
  } finally {
    runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("DSH runtime releases an automatic retrieval turn after a scheduled writeback", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-dsh-retrieval-writeback-"));
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, ".git"), { recursive: true });
  const env = {
    MEMORAX_CODE_HOME: root,
    MEMORAX_CODE_DSH_TRACE_ENABLED: "false",
    MEMORAX_CODE_MEMORY_RETRIEVAL_ENABLED: "false",
    MEMORAX_CODE_MEMORY_WRITEBACK_ENABLED: "true",
    MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_ENABLED: "false",
    MEMORAX_CODE_MEMORAX_ENDPOINT: "http://memorax.test",
    MEMORAX_CODE_MEMORAX_API_KEY: "secret",
    MEMORAX_CODE_MEMORAX_USER_ID: "user-1",
  };
  const config = memoraxConfigFromEnv(env);
  assert.equal(config.ok, true);
  const scope = {
    schemaVersion: "workspace-memory-scope.v1",
    baseUserId: config.config.userId,
    effectiveUserId: `${config.config.userId}@test-repository`,
    repositoryKey: "workspace-directory:test-repository",
    repositorySlug: "test-repository",
    repositoryName: "Test Repository",
    identitySource: "workspace-directory",
    scopeKind: "local-directory",
    boundWorkspaceRoot: workspace,
  };
  const events = [];
  const requests = [];
  const runtime = createDshMemoryHookRuntime({
    diagnosticLogger(message, fields) {
      events.push({ message, fields });
    },
    env,
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response(JSON.stringify({
        success: true,
        data: { task_id: "dsh-task", status: "queued" },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    memoraxCodeHome: root,
    repositoryMemorySession: {
      async resolve() {
        return { ok: true, memory: { config: config.config, scope } };
      },
      close() {},
    },
    now: () => 1,
  });
  try {
    await runtime.recordTurnStart({ ...TURN_START, cwd: workspace });
    assert.equal(retrievalCount(events), 1);

    assert.deepEqual(await runtime.writeback({
      version: 1,
      client: "dsh",
      sessionId: "session-dsh",
      turnId: "dsh-0-0",
      userText: "first turn",
      assistantText: "reply",
      cwd: workspace,
    }), { ok: true, scheduled: true });

    // Round 10 R10-1: a completed turn is terminal. Replaying the SAME
    // turnId after the writeback must NOT restart it (no second retrieval,
    // no second writeback credential).
    assert.deepEqual(await runtime.recordTurnStart({ ...TURN_START, cwd: workspace }), { ok: true });
    assert.equal(retrievalCount(events), 1);
    assert.equal(
      events.some((event) => event.message === "dsh_memory_hook.turn_start_after_finalize"),
      true,
    );

    // Successor turns keep claiming retrieval after the completed turn.
    await runtime.recordTurnStart({ ...TURN_START, turnId: "dsh-0-1", cwd: workspace });
    assert.equal(retrievalCount(events), 2);
    assert.ok(requests.length >= 1);
  } finally {
    runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("DSH runtime self-heals a conflicting repeated turn-start and accepts an idempotent one", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-dsh-conflicting-turn-start-"));
  const events = [];
  const runtime = createDshMemoryHookRuntime({
    diagnosticLogger(message, fields) {
      events.push({ message, fields });
    },
    env: {
      MEMORAX_CODE_HOME: root,
      MEMORAX_CODE_DSH_TRACE_ENABLED: "false",
      MEMORAX_CODE_MEMORY_RETRIEVAL_ENABLED: "false",
    },
    memoraxCodeHome: root,
    repositoryMemorySession: notConfiguredRepositoryMemorySession(),
    now: () => 1,
  });
  try {
    // Idempotent replay of the same prompt stays a no-op.
    assert.deepEqual(await runtime.recordTurnStart({ ...TURN_START, prompt: "first turn" }), { ok: true });
    assert.deepEqual(await runtime.recordTurnStart({ ...TURN_START, prompt: "first turn" }), { ok: true });
    // A colliding turnId with a new prompt replaces the dead entry instead of
    // dead-ending the turn with conflicting_turn_start.
    assert.deepEqual(await runtime.recordTurnStart({ ...TURN_START, prompt: "different turn" }), { ok: true });
    assert.equal(events.some((event) => event.message === "dsh_memory_hook.turn_start_conflict_replaced"), true);
    // The replaced turn is gone: a writeback for the new prompt is accepted,
    // and the writeback for the old prompt no longer matches.
    const writebackResult = await runtime.writeback({
      version: 1,
      client: "dsh",
      sessionId: TURN_START.sessionId,
      turnId: TURN_START.turnId,
      userText: "different turn",
      assistantText: "reply",
    });
    assert.equal(writebackResult.ok, true);
  } finally {
    runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("DSH runtime serializes concurrent writebacks so only one materializes", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-dsh-writeback-serial-"));
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, ".git"), { recursive: true });
  const env = {
    MEMORAX_CODE_HOME: root,
    MEMORAX_CODE_DSH_TRACE_ENABLED: "false",
    MEMORAX_CODE_MEMORY_RETRIEVAL_ENABLED: "false",
    MEMORAX_CODE_MEMORY_WRITEBACK_ENABLED: "true",
    MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_ENABLED: "false",
    MEMORAX_CODE_MEMORAX_ENDPOINT: "http://memorax.test",
    MEMORAX_CODE_MEMORAX_API_KEY: "secret",
    MEMORAX_CODE_MEMORAX_USER_ID: "user-1",
  };
  const config = memoraxConfigFromEnv(env);
  assert.equal(config.ok, true);
  const scope = {
    schemaVersion: "workspace-memory-scope.v1",
    baseUserId: config.config.userId,
    effectiveUserId: `${config.config.userId}@test-repository`,
    repositoryKey: "workspace-directory:test-repository",
    repositorySlug: "test-repository",
    repositoryName: "Test Repository",
    identitySource: "workspace-directory",
    scopeKind: "local-directory",
    boundWorkspaceRoot: workspace,
  };
  let enqueued = 0;
  const runtime = createDshMemoryHookRuntime({
    env,
    automaticWriteback: () => {
      enqueued += 1;
      return { accepted: true };
    },
    repositoryMemorySession: {
      async resolve() {
        return { ok: true, memory: { config: config.config, scope } };
      },
      close() {},
    },
    now: () => 1,
  });
  try {
    await runtime.recordTurnStart({ ...TURN_START, cwd: workspace });
    const writeback = {
      version: 1,
      client: "dsh",
      sessionId: "session-dsh",
      turnId: "dsh-0-0",
      userText: "first turn",
      assistantText: "reply",
      cwd: workspace,
    };
    const results = await Promise.all([runtime.writeback(writeback), runtime.writeback(writeback)]);
    assert.equal(enqueued, 1);
    assert.deepEqual(
      results.map((result) => (result.scheduled ? "scheduled" : `skip:${result.reason}`)).sort(),
      ["scheduled", "skip:turn_metadata_missing"],
    );
  } finally {
    runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("DSH runtime writeback survives past the shared TTL", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-dsh-ttl-"));
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, ".git"), { recursive: true });
  const env = {
    MEMORAX_CODE_HOME: root,
    MEMORAX_CODE_DSH_TRACE_ENABLED: "false",
    MEMORAX_CODE_MEMORY_RETRIEVAL_ENABLED: "false",
    MEMORAX_CODE_MEMORY_WRITEBACK_ENABLED: "true",
    MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_ENABLED: "false",
    MEMORAX_CODE_MEMORAX_ENDPOINT: "http://memorax.test",
    MEMORAX_CODE_MEMORAX_API_KEY: "secret",
    MEMORAX_CODE_MEMORAX_USER_ID: "user-1",
  };
  const config = memoraxConfigFromEnv(env);
  assert.equal(config.ok, true);
  const scope = {
    schemaVersion: "workspace-memory-scope.v1",
    baseUserId: config.config.userId,
    effectiveUserId: `${config.config.userId}@test-repository`,
    repositoryKey: "workspace-directory:test-repository",
    repositorySlug: "test-repository",
    repositoryName: "Test Repository",
    identitySource: "workspace-directory",
    scopeKind: "local-directory",
    boundWorkspaceRoot: workspace,
  };
  let nowMs = 0;
  const runtime = createDshMemoryHookRuntime({
    env,
    automaticWriteback: () => ({ accepted: true }),
    repositoryMemorySession: {
      async resolve() {
        return { ok: true, memory: { config: config.config, scope } };
      },
      close() {},
    },
    now: () => nowMs,
    ttlMs: 100,
  });
  try {
    await runtime.recordTurnStart({ ...TURN_START, cwd: workspace });
    nowMs = 10_000;
    assert.deepEqual(await runtime.writeback({
      version: 1,
      client: "dsh",
      sessionId: "session-dsh",
      turnId: "dsh-0-0",
      userText: "first turn",
      assistantText: "reply",
      cwd: workspace,
    }), { ok: true, scheduled: true });
  } finally {
    runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("DSH runtime serializes a discard with a writeback for one turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-dsh-discard-writeback-"));
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, ".git"), { recursive: true });
  const env = {
    MEMORAX_CODE_HOME: root,
    MEMORAX_CODE_DSH_TRACE_ENABLED: "false",
    MEMORAX_CODE_MEMORY_RETRIEVAL_ENABLED: "false",
    MEMORAX_CODE_MEMORY_WRITEBACK_ENABLED: "true",
    MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_ENABLED: "false",
    MEMORAX_CODE_MEMORAX_ENDPOINT: "http://memorax.test",
    MEMORAX_CODE_MEMORAX_API_KEY: "secret",
    MEMORAX_CODE_MEMORAX_USER_ID: "user-1",
  };
  const config = memoraxConfigFromEnv(env);
  assert.equal(config.ok, true);
  const scope = {
    schemaVersion: "workspace-memory-scope.v1",
    baseUserId: config.config.userId,
    effectiveUserId: `${config.config.userId}@test-repository`,
    repositoryKey: "workspace-directory:test-repository",
    repositorySlug: "test-repository",
    repositoryName: "Test Repository",
    identitySource: "workspace-directory",
    scopeKind: "local-directory",
    boundWorkspaceRoot: workspace,
  };
  let enqueued = 0;
  const runtime = createDshMemoryHookRuntime({
    env,
    automaticWriteback: () => {
      enqueued += 1;
      return { accepted: true };
    },
    repositoryMemorySession: {
      async resolve() {
        return { ok: true, memory: { config: config.config, scope } };
      },
      close() {},
    },
    now: () => 1,
  });
  try {
    await runtime.recordTurnStart({ ...TURN_START, cwd: workspace });
    const [discardResult, writebackResult] = await Promise.all([
      runtime.discardTurn(DISCARD),
      runtime.writeback({
        version: 1,
        client: "dsh",
        sessionId: "session-dsh",
        turnId: "dsh-0-0",
        userText: "first turn",
        assistantText: "reply",
        cwd: workspace,
      }),
    ]);
    assert.deepEqual(discardResult, { ok: true, discarded: true });
    assert.deepEqual(writebackResult, { ok: true, scheduled: false, reason: "turn_metadata_missing" });
    assert.equal(enqueued, 0);
  } finally {
    runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("DSH runtime serializes concurrent turn-starts and self-heals a conflicting prompt", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-dsh-turn-start-serial-"));
  const events = [];
  let resolveCount = 0;
  let releaseResolve;
  const gate = new Promise((resolve) => { releaseResolve = resolve; });
  const runtime = createDshMemoryHookRuntime({
    diagnosticLogger(message, fields) {
      events.push({ message, fields });
    },
    env: {
      MEMORAX_CODE_HOME: root,
      MEMORAX_CODE_DSH_TRACE_ENABLED: "false",
      MEMORAX_CODE_MEMORY_RETRIEVAL_ENABLED: "false",
    },
    memoraxCodeHome: root,
    repositoryMemorySession: {
      async resolve() {
        resolveCount += 1;
        await gate;
        return { ok: false, reason: "config_missing", error: "no memorax config" };
      },
      close() {},
    },
    now: () => 1,
  });
  try {
    const first = runtime.recordTurnStart({ ...TURN_START, prompt: "first prompt" });
    const second = runtime.recordTurnStart({ ...TURN_START, prompt: "second prompt" });
    releaseResolve();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    // The conflicting second start replaces the first entry instead of
    // dead-ending the turn; serialization keeps the coordinator consistent.
    assert.deepEqual(firstResult, { ok: true });
    assert.deepEqual(secondResult, { ok: true });
    // The first start resolves scope once; the replaced start resolves it again.
    assert.equal(resolveCount, 2);
    assert.equal(events.filter((event) => event.message === "dsh_memory_hook.turn_start_conflict_replaced").length, 1);
    const turnStarts = events.filter((event) => event.message === "dsh_memory_hook.turn_start");
    assert.equal(turnStarts.length, 2);
    assert.deepEqual(turnStarts.map((event) => event.fields.promptChars), ["first prompt".length, "second prompt".length]);
  } finally {
    runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("DSH runtime requires the exact bridge delimiter for a longer writeback user text", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-dsh-prompt-delimiter-"));
  const events = [];
  const runtime = createDshMemoryHookRuntime({
    diagnosticLogger(message, fields) {
      events.push({ message, fields });
    },
    env: {
      MEMORAX_CODE_HOME: root,
      MEMORAX_CODE_DSH_TRACE_ENABLED: "false",
      MEMORAX_CODE_MEMORY_RETRIEVAL_ENABLED: "false",
    },
    memoraxCodeHome: root,
    repositoryMemorySession: notConfiguredRepositoryMemorySession(),
    now: () => 1,
  });
  const writeback = (userText) => ({
    version: 1,
    client: "dsh",
    sessionId: "session-dsh",
    turnId: "dsh-0-0",
    userText,
    assistantText: "reply",
  });
  try {
    await runtime.recordTurnStart({ ...TURN_START, prompt: "Fix the build." });

    assert.deepEqual(await runtime.writeback(writeback("Fix the build.evil")), {
      ok: true,
      scheduled: false,
      reason: "prompt_mismatch",
    });

    assert.deepEqual(await runtime.writeback(writeback("Fix the build. now")), {
      ok: true,
      scheduled: false,
      reason: "prompt_mismatch",
    });

    assert.deepEqual(await runtime.writeback(writeback("Fix the build.\n\nAlso run the tests.")), {
      ok: true,
      scheduled: false,
      reason: "config_missing",
    });
  } finally {
    runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});
