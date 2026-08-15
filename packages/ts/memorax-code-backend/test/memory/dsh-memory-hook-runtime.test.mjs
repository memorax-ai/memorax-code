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

    await runtime.recordTurnStart(TURN_START);
    assert.equal(retrievalCount(events), 2);
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

    await runtime.recordTurnStart({ ...TURN_START, cwd: workspace });
    assert.equal(retrievalCount(events), 2);
    assert.ok(requests.length >= 1);
  } finally {
    runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});
