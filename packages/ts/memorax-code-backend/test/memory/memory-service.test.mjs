import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createBackendState } from "../../dist/app/state.js";
import { createMemoryService } from "../../dist/memory/service.js";

test("Backend state does not own the memory service", () => {
  const state = createBackendState("127.0.0.1");
  assert.equal("memoryRuntime" in state, false);
  assert.equal("memoryService" in state, false);
  assert.equal("memoryObservability" in state, false);
});

test("memory service exposes a sealed Hook facade and closes idempotently", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-service-"));
  const memoraxCodeHome = join(root, "home");
  const firstWorkspace = join(root, "workspace-a");
  await Promise.all([
    mkdir(memoraxCodeHome, { recursive: true }),
    mkdir(firstWorkspace, { recursive: true }),
  ]);
  const diagnosticEvents = [];
  const service = createMemoryService({
    diagnosticLogger(message, fields) {
      diagnosticEvents.push({ message, fields });
    },
    env: {
      MEMORAX_CODE_CODEX_TRACE_ENABLED: "false",
      MEMORAX_CODE_OPENCODE_TRACE_ENABLED: "false",
      MEMORAX_CODE_MEMORAX_ENDPOINT: "http://memorax.test",
      MEMORAX_CODE_MEMORAX_API_KEY: "secret",
      MEMORAX_CODE_MEMORAX_USER_ID: "user-1",
    },
    memoraxCodeHome,
  });
  try {
    assert.equal("automaticWriteback" in service, false);
    assert.equal("codexHook" in service, false);
    assert.equal("repositoryMemorySession" in service, false);
    assert.equal("turnCoordinator" in service, false);
    assert.equal("enqueueAutomaticMemoryWriteback" in service, false);
    assert.equal("completeMaterializedTurn" in service, false);
    assert.equal("resolveRepositoryMemorySession" in service, false);
    assert.equal("memoryObservability" in service, false);
    assert.equal("recordCodexSkillReminder" in service, false);

    await service.recordTurnStart({
      version: 1,
      client: "codex",
      sessionId: "session-memory-service",
      turnId: "turn-memory-service",
      prompt: "Record this exact turn in the runtime.",
      cwd: firstWorkspace,
      transcriptPath: join(memoraxCodeHome, "missing-rollout.jsonl"),
    });
    assert.equal(diagnosticEvents.some((event) => event.message === "memory_hook.turn_start"), true);
    await service.recordTurnStart({
      version: 1,
      client: "claude-code",
      sessionId: "session-claude-memory-service",
      promptId: "prompt-claude-memory-service",
      cwd: firstWorkspace,
      transcriptPath: join(memoraxCodeHome, "missing-claude-transcript.jsonl"),
    });
    assert.equal(diagnosticEvents.some((event) => event.message === "claude_memory_hook.turn_start"), true);
    await service.recordTurnStart({
      version: 1,
      client: "opencode",
      sessionId: "session-opencode-memory-service",
      userMessageId: "user-opencode-memory-service",
      prompt: "Record this exact OpenCode turn in the runtime.",
      cwd: firstWorkspace,
    });
    assert.equal(diagnosticEvents.some((event) => event.message === "opencode_memory.turn_start"), true);

    await assert.rejects(service.recordTurnStart({
      version: 1,
      client: "unknown-client",
      sessionId: "session-unknown-client",
      prompt: "Do not inherit Codex authority.",
      transcriptPath: join(memoraxCodeHome, "unknown-client.jsonl"),
    }), /unsupported memory Hook command/);

    await service.drain();
    await service.drain();
    service.close();
    service.close();
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("memory service discards fallback writeback when turn start upgrades the session scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-service-scope-upgrade-"));
  const memoraxCodeHome = join(root, "home");
  const workspace = join(root, "quant");
  await mkdir(join(workspace, ".git"), { recursive: true });
  const transcriptPath = await writeRollout(root, "session-scope-upgrade", [
    {
      turnId: "turn-before-repair",
      prompt: "Keep this fallback turn buffered.",
      reply: "The fallback turn is buffered.",
    },
    {
      turnId: "turn-after-repair",
      prompt: "Observe the repaired Git metadata.",
      reply: "The repaired turn is interrupted before writeback.",
    },
  ]);
  const { fetchImpl, requests } = memoraxAddFetch();
  const diagnosticEvents = [];
  const service = createMemoryService({
    diagnosticLogger(message, fields) {
      diagnosticEvents.push({ message, fields });
    },
    env: {
      MEMORAX_CODE_HOME: memoraxCodeHome,
      MEMORAX_CODE_CODEX_TRACE_ENABLED: "false",
      MEMORAX_CODE_MEMORY_RETRIEVAL_ENABLED: "false",
      MEMORAX_CODE_MEMORY_WRITEBACK_ENABLED: "true",
      MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_ENABLED: "true",
      MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_MAX_TURNS: "8",
      MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_MAX_AGE_MS: "600000",
      MEMORAX_CODE_MEMORAX_ENDPOINT: "http://memorax.test",
      MEMORAX_CODE_MEMORAX_API_KEY: "secret",
      MEMORAX_CODE_MEMORAX_USER_ID: "user-1",
    },
    fetchImpl,
    memoraxCodeHome,
  });
  try {
    assert.deepEqual(await service.recordTurnStart({
      version: 1,
      client: "codex",
      sessionId: "session-scope-upgrade",
      turnId: "turn-before-repair",
      prompt: "Keep this fallback turn buffered.",
      cwd: workspace,
      transcriptPath,
    }), { ok: true });
    assert.deepEqual(await service.writebackTurn({
      version: 1,
      client: "codex",
      sessionId: "session-scope-upgrade",
      turnId: "turn-before-repair",
      lastAssistantMessage: "The fallback turn is buffered.",
      cwd: workspace,
      transcriptPath,
    }), { ok: true, scheduled: true });
    assert.equal(requests.length, 0);

    await repairGitMetadata(workspace, "quant-repository");
    assert.deepEqual(await service.recordTurnStart({
      version: 1,
      client: "codex",
      sessionId: "session-scope-upgrade",
      turnId: "turn-after-repair",
      prompt: "Observe the repaired Git metadata.",
      cwd: workspace,
      transcriptPath,
    }), { ok: true, repoMemoryWorktree: await realpath(workspace) });

    await service.drain();
    assert.equal(requests.length, 0);
    assert.equal(diagnosticEvents.some(({ message, fields }) => (
      message === "memory.automatic_writeback"
      && fields?.skipReason === "buffer_scope_upgraded"
      && fields?.discardedTurnCount === 1
    )), true);
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function repairGitMetadata(workspace, repositoryName) {
  const gitDir = join(workspace, ".git");
  await mkdir(join(gitDir, "objects"), { recursive: true });
  await mkdir(join(gitDir, "refs", "heads"), { recursive: true });
  await writeFile(join(gitDir, "HEAD"), "ref: refs/heads/main\n", "utf8");
  await writeFile(
    join(gitDir, "config"),
    `[remote "origin"]\n\turl = https://example.test/owner/${repositoryName}.git\n`,
    "utf8",
  );
}

async function writeRollout(root, sessionId, turns) {
  const transcriptPath = join(root, `${sessionId}.jsonl`);
  const records = [{
    timestamp: "2026-07-16T00:00:00.000Z",
    type: "session_meta",
    payload: { id: sessionId },
  }];
  for (const [index, turn] of turns.entries()) {
    records.push(
      {
        timestamp: `2026-07-16T00:00:${String(index * 3 + 1).padStart(2, "0")}.000Z`,
        type: "event_msg",
        payload: { type: "task_started", turn_id: turn.turnId },
      },
      {
        timestamp: `2026-07-16T00:00:${String(index * 3 + 1).padStart(2, "0")}.001Z`,
        type: "turn_context",
        payload: { turn_id: turn.turnId },
      },
      {
        timestamp: `2026-07-16T00:00:${String(index * 3 + 2).padStart(2, "0")}.000Z`,
        type: "event_msg",
        payload: { type: "user_message", message: turn.prompt },
      },
      {
        timestamp: `2026-07-16T00:00:${String(index * 3 + 3).padStart(2, "0")}.000Z`,
        type: "event_msg",
        payload: { type: "agent_message", message: turn.reply, phase: "final_answer" },
      },
    );
  }
  await writeFile(transcriptPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
  return transcriptPath;
}

function memoraxAddFetch() {
  const requests = [];
  return {
    requests,
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response(JSON.stringify({
        success: true,
        data: { task_id: "service-scope-upgrade", status: "queued" },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  };
}
