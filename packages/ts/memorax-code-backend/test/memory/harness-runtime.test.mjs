import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createHarnessMemoryRuntime } from "../../dist/memory/harness-runtime.js";
import { createRepositoryMemorySessionRuntime } from "../../dist/memory/repository-session.js";
import { createMemoryTurnCoordinator } from "../../dist/memory/turn-coordinator.js";

test("harness runtime rejects conflicting trace identity before recording or dispatching", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-harness-identity-"));
  const writebacks = [];
  const runtime = createHarnessMemoryRuntime(definition("claude-code"), {
    memoraxCodeHome: root,
    env: {},
    automaticWriteback: (input) => { writebacks.push(input); return { accepted: true }; },
  });
  const foreignContext = {
    schemaVersion: "1",
    client: "codebuddy",
    sessionId: "session",
    turnId: "turn",
    contextOrigin: "codebuddy-hook-body",
    capturedAt: new Date().toISOString(),
  };
  const turn = { sessionId: "session", clientTurnId: "turn", createdAt: Date.now(), prompt: "Read the exact turn." };
  try {
    await assert.rejects(runtime.recordTurnStart({ ...turn, traceContext: foreignContext }), /trace identity mismatch/);
    await assert.rejects(runtime.recordTurnStart({ ...turn, retrievalTraceContext: foreignContext }), /trace identity mismatch/);
    await assert.rejects(runtime.completeTurn({
      ...turn,
      userText: "Read the exact turn.",
      assistantText: "The native turn is complete.",
      traceContext: foreignContext,
      resolveRepositoryMemory: () => { throw new Error("must reject before scope resolution"); },
    }), /trace identity mismatch/);
    assert.equal(runtime.size(), 0);
    assert.deepEqual(writebacks, []);
    assert.deepEqual(await readdir(root), []);
  } finally {
    runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("harness runtimes isolate identical turns and preserve injected resources when one closes", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-harness-shared-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const writebacks = [];
  const coordinator = createMemoryTurnCoordinator({
    automaticWriteback: (input) => { writebacks.push(input); return { accepted: true }; },
  });
  const repository = createRepositoryMemorySessionRuntime();
  const closed = [];
  const options = {
    memoraxCodeHome: join(root, "home"),
    env: {
      MEMORAX_CODE_MEMORAX_ENDPOINT: "http://memorax.test",
      MEMORAX_CODE_MEMORAX_API_KEY: "test-key",
      MEMORAX_CODE_MEMORAX_USER_ID: "test-user",
      MEMORAX_CODE_MEMORY_RETRIEVAL_ENABLED: "false",
    },
    turnCoordinator: { ...coordinator, close: () => closed.push("coordinator") },
    repositoryMemorySession: { ...repository, close: () => closed.push("repository") },
    pendingQuotaNotice: { claim: async () => undefined, queue() {}, close: () => closed.push("quota") },
    fetchImpl: async () => { throw new Error("automatic retrieval is disabled"); },
  };
  const claude = createHarnessMemoryRuntime(definition("claude-code"), options);
  const codebuddy = createHarnessMemoryRuntime(definition("codebuddy"), options);
  // Normalized input can come from SDK or Hook evidence without a transcript
  // path. Client-specific materializers supply the native evidence.
  const turn = { sessionId: "same-session", clientTurnId: "same-turn", cwd: workspace, createdAt: Date.now(), prompt: "Original prompt." };
  try {
    await claude.recordTurnStart(turn);
    await codebuddy.recordTurnStart(turn);
    assert.equal(claude.size(), 1);
    assert.equal(codebuddy.size(), 1);
    claude.close();
    assert.deepEqual(closed, []);
    const metadata = coordinator.getTurn({ client: "codebuddy", sessionId: turn.sessionId, clientTurnId: turn.clientTurnId });
    const result = await codebuddy.completeTurn({
      ...turn,
      metadata,
      userText: "Verified native prompt.",
      assistantText: "Verified native reply.",
      resolveRepositoryMemory: () => codebuddy.resolveRepositoryMemory(turn),
    });
    assert.deepEqual(result, { scheduled: true, metadataDisposition: "consumed" });
    assert.equal(claude.size(), 1);
    assert.equal(codebuddy.size(), 0);
    assert.equal(writebacks[0].client, "codebuddy");
    assert.equal(writebacks[0].userText, "Verified native prompt.");
    assert.equal(writebacks[0].assistantText, "Verified native reply.");
    assert.equal(writebacks[0].memoryObservabilitySource, "codebuddy_hook_writeback");
  } finally {
    claude.close();
    codebuddy.close();
    coordinator.close();
    repository.close();
    await rm(root, { recursive: true, force: true });
  }
});

function definition(client) {
  const prefix = client === "claude-code" ? "claude" : client;
  return {
    client,
    retrievalSource: `${prefix}_hook_retrieval`,
    writebackSource: `${prefix}_hook_writeback`,
    diagnosticPrefix: `${prefix}_memory_hook`,
    traceFailureEvent: `${prefix}_trace.write_failed`,
    deduplicateRetrieval: client === "claude-code",
  };
}
