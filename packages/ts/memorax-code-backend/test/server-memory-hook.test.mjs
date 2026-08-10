import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createBackendState } from "../dist/app/state.js";
import { createBackendServer } from "../dist/server.js";
import { createCodexMemoryHookRuntime } from "../dist/clients/codex/memory-hook-runtime.js";
import { clientTracePaths, tracePaths } from "../dist/trace/config.js";
import { listen } from "./helpers.mjs";

const TEST_WORKSPACE = fileURLToPath(new URL("..", import.meta.url));
const TEST_REPO_ROOT = resolve(TEST_WORKSPACE, "../../..");
const GIT_TURN_START_RESULT = { ok: true, repoMemoryWorktree: TEST_REPO_ROOT };
const TEST_MEMORAX_CODE_HOME = join(tmpdir(), `memorax-code-hook-scope-${process.pid}`);
const WRITEBACK_ENV = {
  MEMORAX_CODE_HOME: TEST_MEMORAX_CODE_HOME,
  MEMORAX_CODE_MEMORY_WRITEBACK_ENABLED: "true",
  MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_ENABLED: "false",
  MEMORAX_CODE_MEMORAX_ENDPOINT: "http://memorax.test",
  MEMORAX_CODE_MEMORAX_API_KEY: "secret",
  MEMORAX_CODE_MEMORAX_USER_ID: "user-1",
};

test("Codex Hook retrieves automatic memory once per exact turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-hook-retrieval-"));
  const transcriptPath = await writeRollout(root, "session-retrieval", [{
    turnId: "turn-retrieval",
    prompt: "Recall the parser boundary.",
    reply: "The parser boundary was recalled.",
  }]);
  const { fetchImpl, requests } = memoraxSearchFetch("Keep malformed input fail-closed.");
  const events = [];
  const controller = createCodexMemoryHookRuntime({
    env: {
      ...WRITEBACK_ENV,
      MEMORAX_CODE_HOME: root,
      MEMORAX_CODE_CODEX_TRACE_ENABLED: "false",
      MEMORAX_CODE_MEMORY_RETRIEVAL_ENABLED: "true",
    },
    automaticWriteback: () => ({ accepted: true }),
    fetchImpl,
    memoraxCodeHome: root,
    memoryObservability: { recordEvent: (event) => events.push(event) },
  });
  try {
    const first = await controller.recordTurnStart({
      sessionId: "session-retrieval",
      turnId: "turn-retrieval",
      prompt: "Recall the parser boundary.",
      cwd: TEST_WORKSPACE,
      transcriptPath,
    });
    assert.equal(first.ok, true);
    assert.match(first.additionalContext, /Keep malformed input fail-closed/);
    assert.equal(first.repoMemoryWorktree, TEST_REPO_ROOT);

    assert.deepEqual(await controller.recordTurnStart({
      sessionId: "session-retrieval",
      turnId: "turn-retrieval",
      prompt: "Recall the parser boundary.",
      cwd: TEST_WORKSPACE,
      transcriptPath,
    }), GIT_TURN_START_RESULT);
    assert.deepEqual(await controller.writeback({
      sessionId: "session-retrieval",
      turnId: "turn-retrieval",
      lastAssistantMessage: "The parser boundary was recalled.",
      cwd: TEST_WORKSPACE,
      transcriptPath,
    }), { ok: true, scheduled: true });
    assert.deepEqual(await controller.recordTurnStart({
      sessionId: "session-retrieval",
      turnId: "turn-retrieval",
      prompt: "Recall the parser boundary.",
      cwd: TEST_WORKSPACE,
      transcriptPath,
    }), GIT_TURN_START_RESULT);
    assert.deepEqual(await controller.recordTurnStart({
      sessionId: "session-without-turn-id",
      prompt: "Do not retrieve without an exact turn id.",
      cwd: TEST_WORKSPACE,
      transcriptPath,
    }), GIT_TURN_START_RESULT);

    assert.equal(requests.length, 1);
    assert.equal(requests[0].body.query, "Recall the parser boundary.");
    assert.equal(events.length, 1);
    assert.equal(events[0].source, "codex_hook_retrieval");
    assert.equal(events[0].operation, "retrieve");
    assert.equal(events[0].traceContext.sessionId, "session-retrieval");
    assert.equal(events[0].traceContext.turnId, "turn-retrieval");
  } finally {
    controller.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("memory hook writeback accepts repeated authority metadata in the exact Codex rollout turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-hook-rollout-source-"));
  const workspace = join(root, "memorax-code");
  await mkdir(workspace, { recursive: true });
  const transcriptPath = await writeRollout(root, "session-hook", [{
    turnId: "turn-1",
    prompt: "Remember this persisted Codex turn.\n",
    reply: "Stored persisted Codex answer.\n",
  }], {
    prefixRecords: [{
      timestamp: "2026-07-16T00:00:00.500Z",
      type: "session_meta",
      payload: { id: "session-hook" },
    }],
  });
  const { fetchImpl, requests } = memoraxAddFetch();
  const events = [];
  const controller = createCodexMemoryHookRuntime({
    env: WRITEBACK_ENV,
    fetchImpl,
    memoryObservability: { recordEvent: (event) => events.push(event) },
  });
  try {
    const started = await controller.recordTurnStart({
      sessionId: "session-hook",
      turnId: "turn-1",
      prompt: "This Hook prompt must not become the writeback source.",
      cwd: workspace,
      transcriptPath,
    });
    assert.deepEqual(started, { ok: true });

    const written = await controller.writeback({
      sessionId: "session-hook",
      turnId: "turn-1",
      lastAssistantMessage: "This Hook reply must not become the writeback source.",
      transcriptPath,
    });
    assert.deepEqual(written, { ok: true, scheduled: true });
    assert.equal(controller.size(), 0);
    await waitFor(() => requests.length === 1, "hook writeback did not call MemoraX add");
    await waitFor(() => events.length === 1, "hook writeback did not record observability");

    assert.equal(requests[0].body.messages[0].content, "Remember this persisted Codex turn.");
    assert.equal(requests[0].body.messages[1].content, "Stored persisted Codex answer.");
    assert.equal(requests[0].body.user_id, "user-1@memorax-code");
    assert.equal(requests[0].body.metadata.memorax_code_base_user_id, "user-1");
    assert.equal(requests[0].body.metadata.memorax_code_workspace, "memorax-code");
    assert.equal(requests[0].body.metadata.memorax_code_memory_scope, "workspace-name.v1");
    assert.equal("memorax_code_repository" in requests[0].body.metadata, false);
    assert.match(requests[0].body.metadata.idempotency_key, /^automatic:codex:/);
    assert.equal(events.at(-1).source, "codex_hook_writeback");
  } finally {
    controller.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("memory hook writeback does not fall back to Hook content when the rollout turn is missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-hook-rollout-missing-turn-"));
  const transcriptPath = await writeRollout(root, "session-missing-turn", [{
    turnId: "other-turn",
    prompt: "Other prompt.",
    reply: "Other reply.",
  }]);
  const { fetchImpl, requests } = memoraxAddFetch();
  const controller = createCodexMemoryHookRuntime({ env: WRITEBACK_ENV, fetchImpl });
  try {
    await controller.recordTurnStart({
      sessionId: "session-missing-turn",
      turnId: "target-turn",
      prompt: "Hook fallback prompt must be ignored.",
      cwd: TEST_WORKSPACE,
      transcriptPath,
    });
    assert.deepEqual(await controller.writeback({
      sessionId: "session-missing-turn",
      turnId: "target-turn",
      lastAssistantMessage: "Hook fallback reply must be ignored.",
      transcriptPath,
    }), { ok: true, scheduled: false, reason: "turn_not_found" });
    assert.equal(requests.length, 0);
  } finally {
    controller.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("memory hook keeps turn-start scope until a late rollout writeback is accepted", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-hook-late-rollout-scope-"));
  const workspace = join(root, "memorax-code");
  await mkdir(workspace, { recursive: true });
  const sessionId = "session-late-rollout";
  const turnId = "turn-late-rollout";
  const transcriptPath = await writeRollout(root, sessionId, [{
    turnId: "other-turn",
    prompt: "Other prompt.",
    reply: "Other reply.",
  }]);
  const env = {
    ...WRITEBACK_ENV,
    MEMORAX_CODE_HOME: root,
    MEMORAX_CODE_CODEX_TRACE_ENABLED: "false",
  };
  const { fetchImpl, requests } = memoraxAddFetch();
  const controller = createCodexMemoryHookRuntime({ env, fetchImpl });
  const writeback = {
    sessionId,
    turnId,
    lastAssistantMessage: "Late rollout answer.",
    cwd: workspace,
    transcriptPath,
  };
  try {
    await controller.recordTurnStart({
      sessionId,
      turnId,
      prompt: "Late rollout prompt.",
      cwd: workspace,
      transcriptPath,
    });
    assert.deepEqual(await controller.writeback(writeback), {
      ok: true,
      scheduled: false,
      reason: "turn_not_found",
    });
    assert.equal(controller.size(), 1);

    await writeRollout(root, sessionId, [{
      turnId,
      prompt: "Late rollout prompt.",
      reply: "Late rollout answer.",
    }]);
    env.MEMORAX_CODE_MEMORY_WRITEBACK_ENABLED = "false";
    assert.deepEqual(await controller.writeback(writeback), {
      ok: true,
      scheduled: false,
      reason: "disabled",
    });
    assert.equal(controller.size(), 1);
    assert.equal(requests.length, 0);

    env.MEMORAX_CODE_MEMORY_WRITEBACK_ENABLED = "true";
    env.MEMORAX_CODE_MEMORAX_USER_ID = "user-2";
    assert.deepEqual(await controller.writeback(writeback), {
      ok: true,
      scheduled: false,
      reason: "workspace_scope_mismatch",
    });
    assert.equal(controller.size(), 1);
    assert.equal(requests.length, 0);

    env.MEMORAX_CODE_MEMORAX_USER_ID = "user-1";
    assert.deepEqual(await controller.writeback(writeback), { ok: true, scheduled: true });
    assert.equal(controller.size(), 0);
    await waitFor(() => requests.length === 1, "late rollout writeback did not use the pinned scope");
    assert.equal(requests[0].body.user_id, "user-1@memorax-code");
  } finally {
    controller.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("memory hook keeps a turn-start config failure after configuration recovers", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-hook-turn-config-missing-"));
  const sessionId = "session-config-missing";
  const turnId = "turn-config-missing";
  const transcriptPath = await writeRollout(root, sessionId, [{
    turnId,
    prompt: "This turn started without memory configuration.",
    reply: "Do not retroactively bind it after configuration changes.",
  }]);
  const env = {
    ...WRITEBACK_ENV,
    MEMORAX_CODE_HOME: root,
    MEMORAX_CODE_CODEX_TRACE_ENABLED: "false",
    MEMORAX_CODE_MEMORAX_API_KEY: undefined,
  };
  const { fetchImpl, requests } = memoraxAddFetch();
  const controller = createCodexMemoryHookRuntime({ env, fetchImpl });
  const writeback = {
    sessionId,
    turnId,
    lastAssistantMessage: "Do not retroactively bind it after configuration changes.",
    cwd: TEST_WORKSPACE,
    transcriptPath,
  };
  try {
    await controller.recordTurnStart({
      sessionId,
      turnId,
      prompt: "This turn started without memory configuration.",
      cwd: TEST_WORKSPACE,
      transcriptPath,
    });
    env.MEMORAX_CODE_MEMORAX_API_KEY = "secret";

    assert.deepEqual(await controller.writeback(writeback), {
      ok: true,
      scheduled: false,
      reason: "config_missing",
    });
    assert.deepEqual(await controller.writeback(writeback), {
      ok: true,
      scheduled: false,
      reason: "config_missing",
    });
    assert.equal(controller.size(), 1);
    assert.equal(requests.length, 0);
  } finally {
    controller.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("memory hook aggregates distinct turns from the same session", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-hook-rollout-buffer-"));
  const transcriptPath = await writeRollout(root, "session-hook-buffered", [
    { turnId: "turn-hook-1", prompt: "First official login prompt.", reply: "First official login answer." },
    { turnId: "turn-hook-2", prompt: "Second official login prompt.", reply: "Second official login answer." },
  ]);
  const { fetchImpl, requests } = memoraxAddFetch();
  const events = [];
  const controller = createCodexMemoryHookRuntime({
    env: {
      ...WRITEBACK_ENV,
      MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_ENABLED: "true",
      MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_MAX_TURNS: "2",
      MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_MAX_AGE_MS: "60000",
    },
    fetchImpl,
    memoryObservability: { recordEvent: (event) => events.push(event) },
  });

  try {
    await controller.recordTurnStart({
      sessionId: "session-hook-buffered",
      turnId: "turn-hook-1",
      prompt: "First official login prompt.",
      cwd: TEST_WORKSPACE,
      transcriptPath,
    });
    assert.deepEqual(await controller.writeback({
      sessionId: "session-hook-buffered",
      turnId: "turn-hook-1",
      lastAssistantMessage: "First official login answer.",
      transcriptPath,
    }), { ok: true, scheduled: true });
    assert.equal(requests.length, 0);

    await controller.recordTurnStart({
      sessionId: "session-hook-buffered",
      turnId: "turn-hook-2",
      prompt: "Second official login prompt.",
      cwd: TEST_WORKSPACE,
      transcriptPath,
    });
    assert.deepEqual(await controller.writeback({
      sessionId: "session-hook-buffered",
      turnId: "turn-hook-2",
      lastAssistantMessage: "Second official login answer.",
      transcriptPath,
    }), { ok: true, scheduled: true });

    await waitFor(() => requests.length === 1, "buffered hook turns did not produce one MemoraX add");
    await waitFor(() => events.length === 1, "buffered hook turns did not record observability");
    assert.deepEqual(requests[0].body.messages.map((message) => message.content), [
      "First official login prompt.",
      "First official login answer.",
      "Second official login prompt.",
      "Second official login answer.",
    ]);
    assert.equal(events.length, 1);
    assert.equal(events[0].traceContext.sessionId, "session-hook-buffered");
    assert.equal(events[0].traceContext.turnId, undefined);
    assert.deepEqual(events[0].relatedTurns.map((turn) => turn.turnId), ["turn-hook-1", "turn-hook-2"]);
    assert.doesNotMatch(JSON.stringify(requests[0].body), /relatedTurns|related_turns/);
  } finally {
    controller.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("memory hook writes non-Git workspaces and blocks cross-workspace sessions", async () => {
  const nonGit = await mkdtemp(join(tmpdir(), "memorax-code-hook-non-git-"));
  const otherRepository = await mkdtemp(join(tmpdir(), "memorax-code-hook-other-repo-"));
  const nonGitTranscript = await writeRollout(nonGit, "session-non-git", [{
    turnId: "turn-non-git",
    prompt: "Remember this local workspace turn.",
    reply: "Keep it in this workspace.",
  }]);
  const mismatchTranscript = await writeRollout(nonGit, "session-repository-mismatch", [
    { turnId: "turn-original-repository", prompt: "Bind this session to memorax-code.", reply: "Original reply." },
    { turnId: "turn-other-repository", prompt: "Do not move this session.", reply: "Must not cross repositories." },
    { turnId: "turn-after-mismatch", prompt: "The mismatched session remains blocked.", reply: "Still blocked." },
  ]);
  const { fetchImpl, requests } = memoraxAddFetch();
  const controller = createCodexMemoryHookRuntime({ env: WRITEBACK_ENV, fetchImpl });
  try {
    await controller.recordTurnStart({
      sessionId: "session-non-git",
      turnId: "turn-non-git",
      prompt: "Remember this local workspace turn.",
      cwd: nonGit,
      transcriptPath: nonGitTranscript,
    });
    assert.deepEqual(await controller.writeback({
      sessionId: "session-non-git",
      turnId: "turn-non-git",
      lastAssistantMessage: "Keep it in this workspace.",
      transcriptPath: nonGitTranscript,
    }), { ok: true, scheduled: true });
    await waitFor(() => requests.length === 1, "non-Git hook writeback did not call MemoraX add");
    assert.equal(requests[0].body.user_id, `user-1@${basename(nonGit)}`);
    assert.equal(requests[0].body.metadata.memorax_code_memory_scope, "workspace-name.v1");
    assert.equal(requests[0].body.metadata.memorax_code_workspace, basename(nonGit));
    assert.equal("memorax_code_repository" in requests[0].body.metadata, false);

    await controller.recordTurnStart({
      sessionId: "session-repository-mismatch",
      turnId: "turn-original-repository",
      prompt: "Bind this session to memorax-code.",
      cwd: TEST_WORKSPACE,
      transcriptPath: mismatchTranscript,
    });
    await controller.recordTurnStart({
      sessionId: "session-repository-mismatch",
      turnId: "turn-other-repository",
      prompt: "Do not move this session.",
      cwd: otherRepository,
      transcriptPath: mismatchTranscript,
    });
    assert.deepEqual(await controller.writeback({
      sessionId: "session-repository-mismatch",
      turnId: "turn-other-repository",
      lastAssistantMessage: "Must not cross repositories.",
      transcriptPath: mismatchTranscript,
    }), { ok: true, scheduled: false, reason: "workspace_scope_mismatch" });

    await controller.recordTurnStart({
      sessionId: "session-repository-mismatch",
      turnId: "turn-after-mismatch",
      prompt: "The mismatched session remains blocked.",
      cwd: TEST_WORKSPACE,
      transcriptPath: mismatchTranscript,
    });
    assert.deepEqual(await controller.writeback({
      sessionId: "session-repository-mismatch",
      turnId: "turn-after-mismatch",
      lastAssistantMessage: "Still blocked.",
      transcriptPath: mismatchTranscript,
    }), { ok: true, scheduled: false, reason: "workspace_scope_mismatch" });
    assert.equal(requests.length, 1);
  } finally {
    controller.close();
    await rm(nonGit, { recursive: true, force: true });
    await rm(otherRepository, { recursive: true, force: true });
  }
});

test("memory hook upgrades automatic writeback after direct Git metadata is repaired", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-hook-git-repair-"));
  const workspace = join(root, "quant");
  await mkdir(join(workspace, ".git"), { recursive: true });
  const transcriptPath = await writeRollout(root, "session-git-repair", [{
    turnId: "turn-git-repair",
    prompt: "Repair the damaged Git metadata.",
    reply: "The Git metadata is repaired.",
  }]);
  const { fetchImpl, requests } = memoraxAddFetch();
  const controller = createCodexMemoryHookRuntime({
    env: {
      ...WRITEBACK_ENV,
      MEMORAX_CODE_HOME: join(root, "home"),
    },
    fetchImpl,
  });
  try {
    assert.deepEqual(await controller.recordTurnStart({
      sessionId: "session-git-repair",
      turnId: "turn-git-repair",
      prompt: "Repair the damaged Git metadata.",
      cwd: workspace,
      transcriptPath,
    }), { ok: true });

    await repairGitMetadata(workspace, "quant-repository");
    assert.deepEqual(await controller.writeback({
      sessionId: "session-git-repair",
      turnId: "turn-git-repair",
      lastAssistantMessage: "The Git metadata is repaired.",
      cwd: workspace,
      transcriptPath,
    }), { ok: true, scheduled: true });

    await waitFor(() => requests.length === 1, "repaired Git scope did not reach MemoraX add");
    assert.equal(requests[0].body.user_id, "user-1@quant-repository");
    assert.equal(requests[0].body.metadata.memorax_code_memory_scope, "repository-name.v1");
    assert.equal(requests[0].body.metadata.memorax_code_workspace, "quant-repository");
  } finally {
    controller.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("memory hook maps different Codex projectless task directories to Codex-General", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-hook-projectless-"));
  const firstTask = join(root, "2026-07-13", "w");
  const secondTask = join(root, "2026-07-14", "new-chat-2");
  await mkdir(firstTask, { recursive: true });
  await mkdir(secondTask, { recursive: true });
  const firstTranscript = await writeRollout(root, "session-projectless-1", [{
    turnId: "turn-projectless-1",
    prompt: "Remember a general Codex preference.",
    reply: "Stored as a general Codex memory.",
  }]);
  const secondTranscript = await writeRollout(root, "session-projectless-2", [{
    turnId: "turn-projectless-2",
    prompt: "Recall it in another projectless task.",
    reply: "Used the same general scope.",
  }]);
  const { fetchImpl, requests } = memoraxAddFetch();
  const controller = createCodexMemoryHookRuntime({ env: WRITEBACK_ENV, fetchImpl });
  try {
    await controller.recordTurnStart({
      sessionId: "session-projectless-1",
      turnId: "turn-projectless-1",
      prompt: "Remember a general Codex preference.",
      cwd: firstTask,
      workspaceKind: "projectless",
      transcriptPath: firstTranscript,
    });
    await controller.recordTurnStart({
      sessionId: "session-projectless-2",
      turnId: "turn-projectless-2",
      prompt: "Recall it in another projectless task.",
      cwd: secondTask,
      workspaceKind: "projectless",
      transcriptPath: secondTranscript,
    });

    assert.deepEqual(await controller.writeback({
      sessionId: "session-projectless-1",
      turnId: "turn-projectless-1",
      lastAssistantMessage: "Stored as a general Codex memory.",
      cwd: firstTask,
      transcriptPath: firstTranscript,
    }), { ok: true, scheduled: true });
    assert.deepEqual(await controller.writeback({
      sessionId: "session-projectless-2",
      turnId: "turn-projectless-2",
      lastAssistantMessage: "Used the same general scope.",
      cwd: secondTask,
      transcriptPath: secondTranscript,
    }), { ok: true, scheduled: true });
    await waitFor(() => requests.length === 2, "projectless hook writebacks did not call MemoraX add");
    assert.deepEqual(requests.map((request) => request.body.user_id), [
      "user-1@Codex-General",
      "user-1@Codex-General",
    ]);
    assert.equal(requests[0].body.metadata.memorax_code_memory_scope, "codex-projectless.v1");
    assert.equal(requests[0].body.metadata.memorax_code_workspace, "Codex-General");
  } finally {
    controller.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("memory hook restores exact projectless scope from current-turn trace after runtime restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-hook-projectless-restart-"));
  const memoraxCodeHome = join(root, "home");
  const workspace = join(root, "projectless-task");
  await mkdir(workspace, { recursive: true });
  const transcriptPath = await writeRollout(root, "session-projectless-restart", [{
    turnId: "turn-projectless-restart",
    prompt: "Remember this after the Backend restarts.",
    reply: "Stored under the original projectless scope.",
  }]);
  const env = {
    ...WRITEBACK_ENV,
    MEMORAX_CODE_HOME: memoraxCodeHome,
    MEMORAX_CODE_CODEX_TRACE_ENABLED: "true",
  };
  const { fetchImpl, requests } = memoraxAddFetch();
  const first = createCodexMemoryHookRuntime({ env, fetchImpl });
  await first.recordTurnStart({
    sessionId: "session-projectless-restart",
    turnId: "turn-projectless-restart",
    prompt: "Remember this after the Backend restarts.",
    cwd: workspace,
    workspaceKind: "projectless",
    transcriptPath,
  });
  first.close();

  const restarted = createCodexMemoryHookRuntime({ env, fetchImpl });
  try {
    assert.deepEqual(await restarted.writeback({
      sessionId: "session-projectless-restart",
      turnId: "turn-projectless-restart",
      lastAssistantMessage: "Stored under the original projectless scope.",
      cwd: workspace,
      transcriptPath,
    }), { ok: true, scheduled: true });
    await waitFor(() => requests.length === 1, "restarted Hook did not restore projectless scope");
    assert.equal(requests[0].body.user_id, "user-1@Codex-General");
  } finally {
    restarted.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("memory hook rejects a conflicting projectless scope after runtime restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-hook-projectless-restart-conflict-"));
  const memoraxCodeHome = join(root, "home");
  const workspace = join(root, "projectless-task");
  await mkdir(workspace, { recursive: true });
  const transcriptPath = await writeRollout(root, "session-projectless-restart-conflict", [{
    turnId: "turn-projectless-restart-conflict",
    prompt: "Keep the exact projectless scope.",
    reply: "Do not accept a conflicting Stop scope.",
  }]);
  const env = {
    ...WRITEBACK_ENV,
    MEMORAX_CODE_HOME: memoraxCodeHome,
    MEMORAX_CODE_CODEX_TRACE_ENABLED: "true",
  };
  const { fetchImpl, requests } = memoraxAddFetch();
  const first = createCodexMemoryHookRuntime({ env, fetchImpl });
  await first.recordTurnStart({
    sessionId: "session-projectless-restart-conflict",
    turnId: "turn-projectless-restart-conflict",
    prompt: "Keep the exact projectless scope.",
    cwd: workspace,
    workspaceKind: "projectless",
    transcriptPath,
  });
  first.close();

  const restarted = createCodexMemoryHookRuntime({ env, fetchImpl });
  try {
    assert.deepEqual(await restarted.writeback({
      sessionId: "session-projectless-restart-conflict",
      turnId: "turn-projectless-restart-conflict",
      lastAssistantMessage: "Do not accept a conflicting Stop scope.",
      cwd: workspace,
      workspaceKind: "project",
      transcriptPath,
    }), { ok: true, scheduled: false, reason: "workspace_scope_mismatch" });
    assert.equal(requests.length, 0);
  } finally {
    restarted.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("memory hook rejects a conflicting physical workspace after runtime restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-hook-workspace-restart-conflict-"));
  const memoraxCodeHome = join(root, "home");
  const firstWorkspace = join(root, "one", "demo");
  const secondWorkspace = join(root, "two", "demo");
  await mkdir(firstWorkspace, { recursive: true });
  await mkdir(secondWorkspace, { recursive: true });
  const transcriptPath = await writeRollout(root, "session-workspace-restart-conflict", [{
    turnId: "turn-workspace-restart-conflict",
    prompt: "Keep the exact physical workspace.",
    reply: "Do not accept the same name from another root.",
  }]);
  const env = {
    ...WRITEBACK_ENV,
    MEMORAX_CODE_HOME: memoraxCodeHome,
    MEMORAX_CODE_CODEX_TRACE_ENABLED: "true",
  };
  const { fetchImpl, requests } = memoraxAddFetch();
  const first = createCodexMemoryHookRuntime({ env, fetchImpl });
  await first.recordTurnStart({
    sessionId: "session-workspace-restart-conflict",
    turnId: "turn-workspace-restart-conflict",
    prompt: "Keep the exact physical workspace.",
    cwd: firstWorkspace,
    workspaceKind: "project",
    transcriptPath,
  });
  first.close();

  const restarted = createCodexMemoryHookRuntime({ env, fetchImpl });
  try {
    assert.deepEqual(await restarted.writeback({
      sessionId: "session-workspace-restart-conflict",
      turnId: "turn-workspace-restart-conflict",
      lastAssistantMessage: "Do not accept the same name from another root.",
      cwd: secondWorkspace,
      workspaceKind: "project",
      transcriptPath,
    }), { ok: true, scheduled: false, reason: "workspace_scope_mismatch" });
    assert.equal(requests.length, 0);
  } finally {
    restarted.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("memory hook fails closed after restart when no exact scope authority exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-hook-scope-restart-unavailable-"));
  const workspace = join(root, "projectless-task");
  await mkdir(workspace, { recursive: true });
  const transcriptPath = await writeRollout(root, "session-scope-restart-unavailable", [{
    turnId: "turn-scope-restart-unavailable",
    prompt: "Do not guess this scope after restart.",
    reply: "No writeback without exact scope authority.",
  }]);
  const env = {
    ...WRITEBACK_ENV,
    MEMORAX_CODE_HOME: join(root, "home"),
    MEMORAX_CODE_CODEX_TRACE_ENABLED: "false",
  };
  const { fetchImpl, requests } = memoraxAddFetch();
  const first = createCodexMemoryHookRuntime({ env, fetchImpl });
  await first.recordTurnStart({
    sessionId: "session-scope-restart-unavailable",
    turnId: "turn-scope-restart-unavailable",
    prompt: "Do not guess this scope after restart.",
    cwd: workspace,
    workspaceKind: "projectless",
    transcriptPath,
  });
  first.close();

  const restarted = createCodexMemoryHookRuntime({ env, fetchImpl });
  try {
    assert.deepEqual(await restarted.writeback({
      sessionId: "session-scope-restart-unavailable",
      turnId: "turn-scope-restart-unavailable",
      lastAssistantMessage: "No writeback without exact scope authority.",
      cwd: workspace,
      transcriptPath,
    }), { ok: true, scheduled: false, reason: "workspace_scope_unavailable" });
    assert.deepEqual(await restarted.writeback({
      sessionId: "session-scope-restart-unavailable",
      turnId: "turn-scope-restart-unavailable",
      lastAssistantMessage: "An explicit Stop scope is still not prior authority.",
      cwd: workspace,
      workspaceKind: "projectless",
      transcriptPath,
    }), { ok: true, scheduled: false, reason: "workspace_scope_unavailable" });
    assert.equal(requests.length, 0);
  } finally {
    restarted.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("memory hook preserves the workspace scope captured at turn start", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-hook-scope-change-"));
  const transcriptPath = await writeRollout(root, "session-config-change", [{
    turnId: "turn-config-change",
    prompt: "Keep the original turn scope.",
    reply: "Do not write under a changed identity.",
  }]);
  const env = { ...WRITEBACK_ENV };
  const { fetchImpl, requests } = memoraxAddFetch();
  const controller = createCodexMemoryHookRuntime({ env, fetchImpl });
  try {
    await controller.recordTurnStart({
      sessionId: "session-config-change",
      turnId: "turn-config-change",
      prompt: "Keep the original turn scope.",
      cwd: TEST_WORKSPACE,
      transcriptPath,
    });
    env.MEMORAX_CODE_MEMORAX_USER_ID = "user-2";
    assert.deepEqual(await controller.writeback({
      sessionId: "session-config-change",
      turnId: "turn-config-change",
      lastAssistantMessage: "Do not write under a changed identity.",
      cwd: TEST_WORKSPACE,
      transcriptPath,
    }), { ok: true, scheduled: false, reason: "workspace_scope_mismatch" });
    assert.equal(requests.length, 0);
  } finally {
    controller.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("memory hook writeback preserves projectless scope after turn metadata cache expiry", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-hook-expired-metadata-"));
  const workspace = join(root, "projectless-task");
  await mkdir(workspace, { recursive: true });
  const transcriptPath = await writeRollout(root, "session-expired", [{
    turnId: "turn-expired",
    prompt: "Persisted prompt outlives metadata.",
    reply: "Persisted reply outlives metadata.",
  }]);
  let now = 1_000;
  const { fetchImpl, requests } = memoraxAddFetch();
  const controller = createCodexMemoryHookRuntime({
    env: WRITEBACK_ENV,
    fetchImpl,
    now: () => now,
    ttlMs: 300,
  });
  try {
    assert.deepEqual(await controller.recordTurnStart({
      sessionId: "session-expired",
      turnId: "turn-expired",
      prompt: "Hook prompt.",
      cwd: workspace,
      workspaceKind: "projectless",
      transcriptPath,
    }), { ok: true });

    now += 301;
    assert.equal(controller.size(), 0);
    assert.deepEqual(await controller.writeback({
      sessionId: "session-expired",
      turnId: "turn-expired",
      lastAssistantMessage: "Hook reply.",
      cwd: workspace,
      transcriptPath,
    }), { ok: true, scheduled: true });
    await waitFor(() => requests.length === 1, "expired metadata blocked rollout-backed writeback");
    assert.deepEqual(requests[0].body.messages.map((message) => message.content), [
      "Persisted prompt outlives metadata.",
      "Persisted reply outlives metadata.",
    ]);
    assert.equal(requests[0].body.user_id, "user-1@Codex-General");
  } finally {
    controller.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("memory hook writeback requires an exact turn id instead of using the latest session turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-hook-turn-id-required-"));
  const transcriptPath = await writeRollout(root, "session-exact-latest", [{
    turnId: "turn-with-id",
    prompt: "Exact prompt.",
    reply: "Exact reply.",
  }]);
  const { fetchImpl, requests } = memoraxAddFetch();
  const controller = createCodexMemoryHookRuntime({
    env: WRITEBACK_ENV,
    fetchImpl,
  });
  try {
    await controller.recordTurnStart({
      sessionId: "session-exact-latest",
      turnId: "turn-with-id",
      prompt: "Exact prompt.",
      cwd: TEST_WORKSPACE,
      transcriptPath,
    });

    assert.deepEqual(await controller.writeback({
      sessionId: "session-exact-latest",
      lastAssistantMessage: "Stop omitted turn id.",
      transcriptPath,
    }), { ok: true, scheduled: false, reason: "turn_id_missing" });
    assert.equal(requests.length, 0);
  } finally {
    controller.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("memory hook metadata cache eviction does not drop rollout-backed turns", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-hook-metadata-eviction-"));
  const transcripts = new Map();
  for (const [sessionId, turnId, prompt, reply] of [
    ["s1", "t1", "one", "first reply"],
    ["s2", "t2", "two", "second reply"],
    ["s3", "t3", "three", "third reply"],
  ]) {
    transcripts.set(sessionId, await writeRollout(root, sessionId, [{ turnId, prompt, reply }]));
  }
  const { fetchImpl, requests } = memoraxAddFetch();
  const controller = createCodexMemoryHookRuntime({
    env: WRITEBACK_ENV,
    fetchImpl,
    maxEntries: 2,
  });
  try {
    await controller.recordTurnStart({ sessionId: "s1", turnId: "t1", prompt: "one", cwd: TEST_WORKSPACE, transcriptPath: transcripts.get("s1") });
    await controller.recordTurnStart({ sessionId: "s2", turnId: "t2", prompt: "two", cwd: TEST_WORKSPACE, transcriptPath: transcripts.get("s2") });
    await controller.recordTurnStart({ sessionId: "s3", turnId: "t3", prompt: "three", cwd: TEST_WORKSPACE, transcriptPath: transcripts.get("s3") });

    assert.equal(controller.size(), 2);
    assert.deepEqual(await controller.writeback({
      sessionId: "s1",
      turnId: "t1",
      lastAssistantMessage: "Hook reply.",
      cwd: TEST_WORKSPACE,
      transcriptPath: transcripts.get("s1"),
    }), { ok: true, scheduled: true });
    await waitFor(() => requests.length === 1, "evicted metadata blocked rollout-backed writeback");
    assert.deepEqual(requests[0].body.messages.map((message) => message.content), ["one", "first reply"]);
  } finally {
    controller.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("memory hook turn-start trace failures do not create unhandled rejections", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-hook-trace-unhandled-"));
  const blocker = join(root, "debug");
  await writeFile(blocker, "file", "utf8");
  const unhandled = captureUnhandledRejections();
  const controller = createCodexMemoryHookRuntime({
    env: { ...WRITEBACK_ENV, MEMORAX_CODE_HOME: root },
    memoraxCodeHome: root,
  });
  try {
    assert.deepEqual(await controller.recordTurnStart({
      sessionId: "session-trace-failure",
      turnId: "turn-trace-failure",
      prompt: "Trace write should fail open.",
      cwd: TEST_WORKSPACE,
      transcriptPath: "/tmp/trace-failure.jsonl",
    }), GIT_TURN_START_RESULT);
    await delay(50);
    assert.deepEqual(unhandled.errors, []);
  } finally {
    controller.close();
    unhandled.restore();
    await rm(root, { recursive: true, force: true });
  }
});

test("memory hook rejects pathless Codex turns without cache, trace, or MemoraX writeback", async () => {
  const sessionHome = await mkdtemp(join(tmpdir(), "memorax-code-hook-pathless-"));
  const { fetchImpl, requests } = memoraxAddFetch();
  const controller = createCodexMemoryHookRuntime({
    env: { ...WRITEBACK_ENV, MEMORAX_CODE_CODEX_TRACE_ENABLED: "true", MEMORAX_CODE_HOME: undefined },
    fetchImpl,
    memoraxCodeHome: sessionHome,
  });
  try {
    assert.deepEqual(await controller.recordTurnStart({
      sessionId: "background-session",
      turnId: "background-turn",
      prompt: "Generate hyperpersonalized suggestions.",
      cwd: "/repo",
    }), { ok: true });
    assert.equal(controller.size(), 0);

    assert.deepEqual(await controller.writeback({
      sessionId: "background-session",
      turnId: "background-turn",
      lastAssistantMessage: "Suggestion output.",
      cwd: "/repo",
    }), { ok: true, scheduled: false, reason: "non_materialized_session" });
    assert.equal(requests.length, 0);
    await assert.rejects(readFile(tracePaths(sessionHome).currentTurnPath, "utf8"), /ENOENT/);
    await assert.rejects(readFile(tracePaths(sessionHome).sessionCurrentTurnPath("background-session"), "utf8"), /ENOENT/);
    await assert.rejects(readFile(tracePaths(sessionHome).eventsJsonl("background-session"), "utf8"), /ENOENT/);
  } finally {
    controller.close();
    await rm(sessionHome, { recursive: true, force: true });
  }
});

test("Backend memory hook endpoints record and write back a turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-hook-http-rollout-"));
  const transcriptPath = await writeRollout(root, "session-http", [{
    turnId: "turn-http",
    prompt: "HTTP hook prompt.",
    reply: "HTTP hook answer.",
  }]);
  const { fetchImpl, requests } = memoraxAddFetch();
  const restoreEnv = withEnv(WRITEBACK_ENV);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  const state = createBackendState();
  const server = createBackendServer(state);
  const url = await listen(server);
  try {
    const start = await originalFetch(`${url}/memory/turn-start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: 1,
        client: "codex",
        sessionId: "session-http",
        turnId: "turn-http",
        prompt: "HTTP hook prompt.",
        cwd: TEST_WORKSPACE,
        transcriptPath,
      }),
    });
    assert.equal(start.status, 200);
    assert.deepEqual(await start.json(), GIT_TURN_START_RESULT);

    const writeback = await originalFetch(`${url}/memory/writeback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: 1,
        client: "codex",
        sessionId: "session-http",
        turnId: "turn-http",
        lastAssistantMessage: "HTTP hook answer.",
        transcriptPath,
      }),
    });
    assert.equal(writeback.status, 200);
    assert.deepEqual(await writeback.json(), { ok: true, scheduled: true });
    await waitFor(() => requests.length === 1, "HTTP hook writeback did not call MemoraX add");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    globalThis.fetch = originalFetch;
    restoreEnv();
    await rm(root, { recursive: true, force: true });
  }
});

test("Backend memory hook endpoints reject commands outside the closed schema", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-hook-http-contract-"));
  const state = createBackendState("127.0.0.1", { sessionHome: root });
  const server = createBackendServer(state);
  const url = await listen(server);
  const codexTurnStart = {
    version: 1,
    client: "codex",
    sessionId: "session-codex-turn-start",
    prompt: "Codex turn start.",
    transcriptPath: "/tmp/codex.jsonl",
  };
  const claudeTurnStart = {
    version: 1,
    client: "claude-code",
    sessionId: "session-claude-turn-start",
    promptId: "prompt-claude-turn-start",
    prompt: "Claude turn start.",
    transcriptPath: "/tmp/claude.jsonl",
  };
  const codexWriteback = {
    version: 1,
    client: "codex",
    sessionId: "session-codex-writeback",
    lastAssistantMessage: "Codex writeback.",
  };
  const claudeWriteback = {
    version: 1,
    client: "claude-code",
    sessionId: "session-claude-writeback",
    promptId: "prompt-claude-writeback",
    lastAssistantMessage: "Claude writeback.",
    transcriptPath: "/tmp/claude.jsonl",
  };
  try {
    for (const [caseName, path, body] of [
      ["unversioned command", "/memory/turn-start", {
        client: "codex",
        sessionId: "session-unversioned",
        prompt: "Old commands must not inherit Codex authority.",
        transcriptPath: "/tmp/codex.jsonl",
      }],
      ["missing client", "/memory/turn-start", {
        version: 1,
        sessionId: "session-clientless",
        prompt: "Client identity is required.",
        transcriptPath: "/tmp/codex.jsonl",
      }],
      ["unsupported version", "/memory/turn-start", {
        version: 2,
        client: "codex",
        sessionId: "session-future",
        prompt: "Unknown versions fail closed.",
        transcriptPath: "/tmp/codex.jsonl",
      }],
      ["unknown client", "/memory/turn-start", {
        version: 1,
        client: "unknown-client",
        sessionId: "session-unknown",
        prompt: "Unknown clients fail closed.",
        transcriptPath: "/tmp/codex.jsonl",
      }],
      ["incomplete Claude writeback", "/memory/writeback", {
        version: 1,
        client: "claude-code",
        sessionId: "session-incomplete-writeback",
        lastAssistantMessage: "Client-specific required fields fail closed.",
        transcriptPath: "/tmp/claude.jsonl",
      }],
      ["unknown Codex turn-start field", "/memory/turn-start", {
        ...codexTurnStart,
        unexpected: true,
      }],
      ["Codex field on Claude turn-start", "/memory/turn-start", {
        ...claudeTurnStart,
        turnId: "wrong-client-field",
      }],
      ["invalid optional Codex turn id", "/memory/turn-start", {
        ...codexTurnStart,
        turnId: 42,
      }],
      ["invalid optional Claude cwd", "/memory/turn-start", {
        ...claudeTurnStart,
        cwd: {},
      }],
      ["unknown snake-case Codex writeback field", "/memory/writeback", {
        ...codexWriteback,
        session_id: codexWriteback.sessionId,
      }],
      ["Claude field on Codex writeback", "/memory/writeback", {
        ...codexWriteback,
        promptId: "wrong-client-field",
      }],
      ["invalid optional Codex transcript path", "/memory/writeback", {
        ...codexWriteback,
        transcriptPath: 42,
      }],
      ["Codex field on Claude writeback", "/memory/writeback", {
        ...claudeWriteback,
        turnId: "wrong-client-field",
      }],
      ["invalid optional Claude workspace kind", "/memory/writeback", {
        ...claudeWriteback,
        workspaceKind: {},
      }],
    ]) {
      const response = await fetch(`${url}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 400, caseName);
      assert.deepEqual(await response.json(), {
        ok: false,
        error: "invalid memory Hook command",
      }, caseName);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test("Backend memory hook endpoints write client-isolated trace events", async () => {
  const { fetchImpl, requests } = memoraxAddFetch();
  const sessionHome = await mkdtemp(join(tmpdir(), "memorax-code-hook-trace-"));
  const restoreEnv = withEnv({
    ...WRITEBACK_ENV,
    MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_ENABLED: "true",
    MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_MAX_TURNS: "1",
    MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_MAX_AGE_MS: "60000",
    MEMORAX_CODE_HOME: undefined,
    MEMORAX_CODE_CLAUDE_TRACE_ENABLED: undefined,
    MEMORAX_CODE_CODEX_TRACE_ENABLED: undefined,
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  const state = createBackendState("127.0.0.1", { sessionHome });
  const server = createBackendServer(state);
  const url = await listen(server);
  const transcriptPath = await writeRollout(sessionHome, "session-trace-hook", [{
    turnId: "turn-trace-hook",
    prompt: "Trace this hook prompt.",
    reply: "Trace this hook answer.",
    toolCalls: [
      'const r = await tools.exec_command({ cmd: "sed -n \'1,240p\' /Users/test/.codex/plugins/cache/memorax-code/memorax-code-codex-adapter/0.1.11/skills/memorax-code/references/repo-read.md" });',
      'const r = await tools.exec_command({ cmd: "memorax-cli search --query \\"trace ordering\\"" });',
    ],
    tokenUsage: {
      input_tokens: 120,
      cached_input_tokens: 80,
      cache_write_input_tokens: 0,
      output_tokens: 20,
      reasoning_output_tokens: 5,
      total_tokens: 140,
    },
  }]);
  try {
    const start = await originalFetch(`${url}/memory/turn-start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: 1,
        client: "codex",
        sessionId: "session-trace-hook",
        turnId: "turn-trace-hook",
        prompt: "Trace this hook prompt.",
        cwd: TEST_WORKSPACE,
        transcriptPath,
      }),
    });
    assert.equal(start.status, 200);

    await waitForFile(tracePaths(sessionHome).currentTurnPath, /session-trace-hook/, "current turn trace was not written");
    const currentTurn = JSON.parse(await readFile(tracePaths(sessionHome).currentTurnPath, "utf8"));
    assert.equal(currentTurn.turn_state, "open");
    assert.equal(currentTurn.trace.session_id, "session-trace-hook");
    assert.equal(currentTurn.trace.turn_id, "turn-trace-hook");
    assert.equal(currentTurn.trace.context_origin, "codex-hook-body");

    const scopedCurrentPath = tracePaths(sessionHome).sessionCurrentTurnPath("session-trace-hook");
    await waitForFile(scopedCurrentPath, /session-trace-hook/, "session current turn trace was not written");
    const scopedCurrentTurn = JSON.parse(await readFile(scopedCurrentPath, "utf8"));
    assert.equal(scopedCurrentTurn.turn_state, "open");
    assert.equal(scopedCurrentTurn.trace.session_id, "session-trace-hook");
    assert.equal(scopedCurrentTurn.trace.turn_id, "turn-trace-hook");
    assert.equal(scopedCurrentTurn.trace.context_origin, "codex-hook-body");

    const reminder = await originalFetch(`${url}/memory/skill-reminder`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: 1,
        client: "codex",
        sessionId: "session-trace-hook",
        turnId: "turn-trace-hook",
        transcriptPath,
        content: "MemoraX Code reminder: use the skill when prior work could help.",
        triggers: ["cadence", "post_compaction"],
      }),
    });
    assert.equal(reminder.status, 200);
    assert.deepEqual(await reminder.json(), { ok: true });

    const unversionedReminder = await originalFetch(`${url}/memory/skill-reminder`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client: "codex",
        sessionId: "session-trace-hook",
        turnId: "turn-trace-hook",
        transcriptPath,
        content: "Unversioned reminder commands must not be recorded.",
        triggers: ["cadence"],
      }),
    });
    assert.equal(unversionedReminder.status, 200);
    assert.deepEqual(await unversionedReminder.json(), { ok: true });

    const mismatchedClaudeReminder = await originalFetch(`${url}/memory/skill-reminder`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: 1,
        client: "claude-code",
        sessionId: "session-trace-hook",
        turnId: "turn-trace-hook",
        transcriptPath,
        content: "Claude reminder commands must use promptId.",
        triggers: ["cadence"],
      }),
    });
    assert.equal(mismatchedClaudeReminder.status, 200);
    assert.deepEqual(await mismatchedClaudeReminder.json(), { ok: true });

    const claudeReminder = await originalFetch(`${url}/memory/skill-reminder`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: 1,
        client: "claude-code",
        sessionId: "session-trace-hook",
        promptId: "turn-trace-hook",
        transcriptPath,
        cwd: TEST_WORKSPACE,
        workspaceKind: "project",
        content: "MemoraX Code reminder: use the skill in Claude when prior work could help.",
        triggers: ["cadence"],
      }),
    });
    assert.equal(claudeReminder.status, 200);
    assert.deepEqual(await claudeReminder.json(), { ok: true });

    const writeback = await originalFetch(`${url}/memory/writeback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: 1,
        client: "codex",
        sessionId: "session-trace-hook",
        turnId: "turn-trace-hook",
        lastAssistantMessage: "Trace this hook answer.",
        transcriptPath,
      }),
    });
    assert.equal(writeback.status, 200);
    await waitFor(() => requests.length === 1, "HTTP hook writeback did not call MemoraX add");

    const completedCurrentTurn = JSON.parse(await readFile(tracePaths(sessionHome).currentTurnPath, "utf8"));
    const completedScopedTurn = JSON.parse(await readFile(scopedCurrentPath, "utf8"));
    assert.equal(completedCurrentTurn.turn_state, "completed");
    assert.equal(completedScopedTurn.turn_state, "completed");
    assert.equal(completedCurrentTurn.trace.turn_id, "turn-trace-hook");
    assert.equal(completedScopedTurn.trace.turn_id, "turn-trace-hook");

    const eventsPath = tracePaths(sessionHome).eventsJsonl("session-trace-hook");
    await waitForFile(eventsPath, /memory_writeback/, "trace events were not written");
    const events = (await readFile(eventsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(events[0].type, "turn_start");
    assert.equal(events[0].trace.context_origin, "codex-hook-body");
    assert.deepEqual(events.slice(0, 3).map((event) => event.type), ["turn_start", "skill_reminder", "turn_end"]);
    const skillReminder = events[1];
    assert.equal(skillReminder.source, "codex-hook");
    assert.equal(skillReminder.operation, "reminder");
    assert.equal(skillReminder.trace.client, "codex");
    assert.deepEqual(skillReminder.request.triggers, ["cadence", "post_compaction"]);
    assert.deepEqual(skillReminder.response, {
      role: "developer",
      content: "MemoraX Code reminder: use the skill when prior work could help.",
    });
    assert.equal(events.filter((event) => event.type === "skill_reminder").length, 1);

    const claudeEventsPath = clientTracePaths("claude", sessionHome).eventsJsonl("session-trace-hook");
    await waitForFile(claudeEventsPath, /skill_reminder/, "Claude reminder trace event was not written");
    const claudeEvents = (await readFile(claudeEventsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(claudeEvents.length, 1);
    assert.equal(claudeEvents[0].type, "skill_reminder");
    assert.equal(claudeEvents[0].source, "claude-hook");
    assert.equal(claudeEvents[0].operation, "reminder");
    assert.equal(claudeEvents[0].trace.client, "claude");
    assert.equal(claudeEvents[0].trace.session_id, "session-trace-hook");
    assert.equal(claudeEvents[0].trace.turn_id, "turn-trace-hook");
    assert.equal(claudeEvents[0].trace.context_origin, "claude-hook-body");
    assert.deepEqual(claudeEvents[0].request.triggers, ["cadence"]);
    assert.deepEqual(claudeEvents[0].response, {
      role: "developer",
      content: "MemoraX Code reminder: use the skill in Claude when prior work could help.",
    });
    const turnEnd = events.find((event) => event.type === "turn_end");
    assert.equal(turnEnd.source, "codex-hook");
    assert.equal(turnEnd.trace.session_id, "session-trace-hook");
    assert.equal(turnEnd.trace.turn_id, "turn-trace-hook");
    assert.equal(turnEnd.trace.transcript_path, transcriptPath);
    assert.equal(turnEnd.response.assistantMessage, "Trace this hook answer.");
    assert.deepEqual(turnEnd.usage, {
      input_tokens: 120,
      cached_input_tokens: 80,
      cache_write_input_tokens: 0,
      output_tokens: 20,
      reasoning_output_tokens: 5,
      total_tokens: 140,
    });
    assert.deepEqual(turnEnd.activities, [
      { index: 1, type: "repo_memory_operation", operation: "repo-read" },
      { index: 2, type: "memory_cli_search" },
    ]);
    const writebackEvent = events.find((event) => event.type === "memory_writeback");
    assert.equal(writebackEvent.source, "codex_hook_writeback");
    assert.equal(writebackEvent.trace.session_id, "session-trace-hook");
    assert.equal(writebackEvent.trace.turn_id, undefined);
    assert.deepEqual(writebackEvent.related_turns.map((turn) => turn.turn_id), ["turn-trace-hook"]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    globalThis.fetch = originalFetch;
    restoreEnv();
    await rm(sessionHome, { recursive: true, force: true });
  }
});

test("memory hook writeback records turn_end even when the Codex rollout is unavailable", async () => {
  const sessionHome = await mkdtemp(join(tmpdir(), "memorax-code-hook-turn-end-"));
  const controller = createCodexMemoryHookRuntime({
    env: {
      MEMORAX_CODE_HOME: undefined,
      MEMORAX_CODE_CODEX_TRACE_ENABLED: undefined,
    },
    memoraxCodeHome: sessionHome,
  });
  try {
    const result = await controller.writeback({
      sessionId: "session-turn-end",
      turnId: "turn-end-1",
      lastAssistantMessage: "Assistant answer should be traced.",
      cwd: "/repo",
      transcriptPath: "/tmp/codex-transcript.jsonl",
    });
    assert.deepEqual(result, { ok: true, scheduled: false, reason: "transcript_unavailable" });

    const eventsPath = tracePaths(sessionHome).eventsJsonl("session-turn-end");
    await waitForFile(eventsPath, /turn_end/, "turn_end trace event was not written");
    const events = (await readFile(eventsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "turn_end");
    assert.equal(events[0].trace.session_id, "session-turn-end");
    assert.equal(events[0].trace.turn_id, "turn-end-1");
    assert.equal(events[0].trace.context_origin, "codex-hook-body");
    assert.equal(events[0].trace.cwd, "/repo");
    assert.equal(events[0].trace.transcript_path, "/tmp/codex-transcript.jsonl");
    assert.equal(events[0].response.assistantMessage, "Assistant answer should be traced.");
    assert.equal(events[0].activities, undefined);
  } finally {
    controller.close();
    await rm(sessionHome, { recursive: true, force: true });
  }
});

test("memory hook deduplicates lifecycle events and appends late rollout materialization", async () => {
  const sessionHome = await mkdtemp(join(tmpdir(), "memorax-code-hook-lifecycle-idempotency-"));
  const sessionId = "session-lifecycle-idempotency";
  const turnId = "turn-lifecycle-idempotency";
  const transcriptPath = join(sessionHome, `${sessionId}.jsonl`);
  const controller = createCodexMemoryHookRuntime({
    automaticWriteback: () => ({ accepted: true }),
    env: {
      ...WRITEBACK_ENV,
      MEMORAX_CODE_HOME: sessionHome,
      MEMORAX_CODE_CODEX_TRACE_ENABLED: undefined,
    },
    memoraxCodeHome: sessionHome,
  });
  const turnStart = {
    sessionId,
    turnId,
    prompt: "Materialize this Codex turn later.",
    cwd: TEST_WORKSPACE,
    transcriptPath,
  };
  const writeback = {
    sessionId,
    turnId,
    lastAssistantMessage: "Hook answer before rollout materialization.",
    cwd: TEST_WORKSPACE,
    transcriptPath,
  };
  try {
    assert.deepEqual(await controller.recordTurnStart(turnStart), GIT_TURN_START_RESULT);
    assert.deepEqual(await controller.recordTurnStart(turnStart), GIT_TURN_START_RESULT);
    assert.deepEqual(await controller.writeback(writeback), {
      ok: true,
      scheduled: false,
      reason: "transcript_unavailable",
    });

    await writeRollout(sessionHome, sessionId, [{
      turnId,
      prompt: "Materialize this Codex turn later.",
      reply: "Exact rollout answer after materialization.",
    }]);
    assert.deepEqual(await controller.writeback(writeback), { ok: true, scheduled: true });

    const events = (await readFile(tracePaths(sessionHome).eventsJsonl(sessionId), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(events.map((event) => event.type), [
      "turn_start",
      "turn_end",
      "turn_materialized",
    ]);
    assert.equal(events[0].event_id.startsWith("trace-turn-start-"), true);
    assert.equal(events[1].event_id.startsWith("trace-turn-end-"), true);
    assert.equal(events[1].response.assistantMessage, "Hook answer before rollout materialization.");
    assert.equal(events[2].event_id.startsWith("trace-turn-materialized-"), true);
    assert.equal(events[2].request.original_event_id, events[1].event_id);
    assert.equal(events[2].request.prompt, "Materialize this Codex turn later.");
    assert.equal(events[2].response.assistantMessage, "Exact rollout answer after materialization.");
  } finally {
    controller.close();
    await rm(sessionHome, { recursive: true, force: true });
  }
});

test("memory hook writeback records turn_end with cached trace context when Stop omits paths", async () => {
  const sessionHome = await mkdtemp(join(tmpdir(), "memorax-code-hook-turn-end-fallback-"));
  const transcriptPath = await writeRollout(sessionHome, "session-turn-end-fallback", [{
    turnId: "turn-end-fallback",
    prompt: "Prompt with paths.",
    reply: "Assistant answer uses cached paths.",
  }]);
  const controller = createCodexMemoryHookRuntime({
    env: {
      ...WRITEBACK_ENV,
      MEMORAX_CODE_HOME: undefined,
      MEMORAX_CODE_CODEX_TRACE_ENABLED: undefined,
    },
    fetchImpl: async () => new Response("{}", { status: 200 }),
    memoraxCodeHome: sessionHome,
  });
  try {
    assert.deepEqual(await controller.recordTurnStart({
      sessionId: "session-turn-end-fallback",
      turnId: "turn-end-fallback",
      prompt: "Prompt with paths.",
      cwd: TEST_WORKSPACE,
      transcriptPath,
    }), GIT_TURN_START_RESULT);

    const result = await controller.writeback({
      sessionId: "session-turn-end-fallback",
      turnId: "turn-end-fallback",
      lastAssistantMessage: "Assistant answer uses cached paths.",
    });
    assert.deepEqual(result, { ok: true, scheduled: true });

    const eventsPath = tracePaths(sessionHome).eventsJsonl("session-turn-end-fallback");
    await waitForFile(eventsPath, /turn_end/, "turn_end trace event was not written");
    const events = (await readFile(eventsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const turnEnd = events.find((event) => event.type === "turn_end");
    assert.equal(turnEnd.trace.session_id, "session-turn-end-fallback");
    assert.equal(turnEnd.trace.turn_id, "turn-end-fallback");
    assert.equal(turnEnd.trace.cwd, TEST_WORKSPACE);
    assert.equal(turnEnd.trace.transcript_path, transcriptPath);
    assert.equal(turnEnd.response.assistantMessage, "Assistant answer uses cached paths.");
  } finally {
    controller.close();
    await rm(sessionHome, { recursive: true, force: true });
  }
});

test("memory hook closes an ordinary interrupted turn before recording the next turn", async () => {
  const sessionHome = await mkdtemp(join(tmpdir(), "memorax-code-hook-interrupted-turn-"));
  const transcriptPath = await writeRollout(sessionHome, "session-interrupted-turn", [
    {
      turnId: "turn-interrupted",
      prompt: "Inspect the trace before interruption.",
      interrupted: true,
      commentaries: ["First visible update.", "Second visible update."],
      toolCalls: ['const r = await tools.exec_command({ cmd: "memorax-cli search --query \\"trace\\"" });'],
      tokenUsage: {
        input_tokens: 120,
        cached_input_tokens: 80,
        cache_write_input_tokens: 0,
        output_tokens: 20,
        reasoning_output_tokens: 5,
        total_tokens: 140,
      },
    },
    {
      turnId: "turn-next",
      prompt: "Continue after interruption.",
      reply: "Completed next answer.",
    },
  ]);
  const { fetchImpl, requests } = memoraxAddFetch();
  const controller = createCodexMemoryHookRuntime({
    env: {
      ...WRITEBACK_ENV,
      MEMORAX_CODE_HOME: undefined,
      MEMORAX_CODE_CODEX_TRACE_ENABLED: undefined,
    },
    fetchImpl,
    memoraxCodeHome: sessionHome,
  });
  try {
    await controller.recordTurnStart({
      sessionId: "session-interrupted-turn",
      turnId: "turn-interrupted",
      prompt: "Inspect the trace before interruption.",
      cwd: TEST_WORKSPACE,
      transcriptPath,
    });
    await controller.recordTurnStart({
      sessionId: "session-interrupted-turn",
      turnId: "turn-next",
      prompt: "Continue after interruption.",
      cwd: TEST_WORKSPACE,
      transcriptPath,
    });

    const eventsPath = tracePaths(sessionHome).eventsJsonl("session-interrupted-turn");
    const events = (await readFile(eventsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(events.map((event) => event.type), ["turn_start", "turn_end", "turn_start"]);
    const interruptedEnd = events[1];
    assert.match(interruptedEnd.event_id, /^trace-turn-end-[a-f0-9]{32}$/);
    assert.equal(interruptedEnd.trace.turn_id, "turn-interrupted");
    assert.equal(interruptedEnd.outcome, "interrupted");
    assert.equal(interruptedEnd.timestamp, "2026-07-16T00:00:03.750Z");
    assert.equal(interruptedEnd.response.assistantMessage, "First visible update.\n\nSecond visible update.");
    assert.equal(interruptedEnd.session_turn_index, 1);
    assert.deepEqual(interruptedEnd.activities, [{ index: 1, type: "memory_cli_search" }]);
    assert.deepEqual(interruptedEnd.usage, {
      input_tokens: 120,
      cached_input_tokens: 80,
      cache_write_input_tokens: 0,
      output_tokens: 20,
      reasoning_output_tokens: 5,
      total_tokens: 140,
    });
    assert.equal(requests.length, 0);
    assert.equal(controller.size(), 1);
  } finally {
    controller.close();
    await rm(sessionHome, { recursive: true, force: true });
  }
});

test("memory hook closes an interrupted turn from a composite Codex rollout", async () => {
  const sessionHome = await mkdtemp(join(tmpdir(), "memorax-code-hook-composite-rollout-"));
  const sessionId = "session-composite-rollout";
  const transcriptPath = await writeRollout(sessionHome, sessionId, [
    {
      turnId: "turn-interrupted",
      prompt: "Inspect the composite rollout before interruption.",
      interrupted: true,
      commentaries: ["Visible progress from the current session."],
      tokenUsage: {
        input_tokens: 120,
        cached_input_tokens: 80,
        cache_write_input_tokens: 0,
        output_tokens: 20,
        reasoning_output_tokens: 5,
        total_tokens: 140,
      },
    },
    {
      turnId: "turn-next",
      prompt: "Continue after the composite interruption.",
      reply: "Completed next answer.",
    },
  ], {
    headerSource: "vscode",
    prefixRecords: [
      {
        timestamp: "2026-07-15T23:59:57.000Z",
        type: "session_meta",
        payload: { id: "session-imported-history", source: "exec" },
      },
      {
        timestamp: "2026-07-15T23:59:58.000Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "turn-imported-history" },
      },
      {
        timestamp: "2026-07-15T23:59:59.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "Imported historical prompt." },
      },
    ],
  });
  const { fetchImpl, requests } = memoraxAddFetch();
  const controller = createCodexMemoryHookRuntime({
    env: {
      ...WRITEBACK_ENV,
      MEMORAX_CODE_HOME: undefined,
      MEMORAX_CODE_CODEX_TRACE_ENABLED: undefined,
    },
    fetchImpl,
    memoraxCodeHome: sessionHome,
  });
  try {
    await controller.recordTurnStart({
      sessionId,
      turnId: "turn-interrupted",
      prompt: "Inspect the composite rollout before interruption.",
      cwd: TEST_WORKSPACE,
      transcriptPath,
    });
    await controller.recordTurnStart({
      sessionId,
      turnId: "turn-next",
      prompt: "Continue after the composite interruption.",
      cwd: TEST_WORKSPACE,
      transcriptPath,
    });

    const events = (await readFile(tracePaths(sessionHome).eventsJsonl(sessionId), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(events.map((event) => event.type), ["turn_start", "turn_end", "turn_start"]);
    assert.equal(events[1].trace.turn_id, "turn-interrupted");
    assert.equal(events[1].outcome, "interrupted");
    assert.equal(events[1].response.assistantMessage, "Visible progress from the current session.");
    assert.equal("session_turn_index" in events[1], false);
    assert.equal("usage" in events[1], false);
    assert.equal(requests.length, 0);
  } finally {
    controller.close();
    await rm(sessionHome, { recursive: true, force: true });
  }
});

test("memory hook closes an interrupted turn from the session bridge after restart", async () => {
  const sessionHome = await mkdtemp(join(tmpdir(), "memorax-code-hook-interrupted-restart-"));
  const sessionId = "session-interrupted-restart";
  const transcriptPath = await writeRollout(sessionHome, sessionId, [
    {
      turnId: "turn-before-restart",
      prompt: "Interrupt before restarting the Backend.",
      interrupted: true,
      commentaries: ["Visible progress survives restart."],
    },
    {
      turnId: "turn-after-restart",
      prompt: "Continue after restarting the Backend.",
      reply: "Completed after restart.",
    },
  ]);
  const options = {
    env: {
      MEMORAX_CODE_HOME: undefined,
      MEMORAX_CODE_CODEX_TRACE_ENABLED: undefined,
    },
    memoraxCodeHome: sessionHome,
  };
  const first = createCodexMemoryHookRuntime(options);
  try {
    await first.recordTurnStart({
      sessionId,
      turnId: "turn-before-restart",
      prompt: "Interrupt before restarting the Backend.",
      cwd: TEST_WORKSPACE,
      transcriptPath,
    });
    await waitForFile(
      tracePaths(sessionHome).sessionCurrentTurnPath(sessionId),
      /turn-before-restart/,
      "session current turn was not persisted before restart",
    );
  } finally {
    first.close();
  }

  const second = createCodexMemoryHookRuntime(options);
  try {
    await second.recordTurnStart({
      sessionId,
      turnId: "turn-after-restart",
      prompt: "Continue after restarting the Backend.",
      cwd: TEST_WORKSPACE,
      transcriptPath,
    });

    const events = (await readFile(tracePaths(sessionHome).eventsJsonl(sessionId), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(events.map((event) => event.type), ["turn_start", "turn_end", "turn_start"]);
    assert.equal(events[1].trace.turn_id, "turn-before-restart");
    assert.equal(events[1].outcome, "interrupted");
    assert.equal(events[1].response.assistantMessage, "Visible progress survives restart.");
  } finally {
    second.close();
    await rm(sessionHome, { recursive: true, force: true });
  }
});

test("memory hook leaves prompt-edit rollback turns pending without a synthetic turn end", async () => {
  const sessionHome = await mkdtemp(join(tmpdir(), "memorax-code-hook-rolled-back-turn-"));
  const transcriptPath = await writeRollout(sessionHome, "session-rolled-back-turn", [
    {
      turnId: "turn-original",
      prompt: "Original prompt.",
      interrupted: true,
      rolledBack: true,
      commentaries: ["Visible output before editing."],
    },
    {
      turnId: "turn-edited",
      prompt: "Edited prompt.",
      reply: "Edited prompt answer.",
    },
  ]);
  const controller = createCodexMemoryHookRuntime({
    env: {
      MEMORAX_CODE_HOME: undefined,
      MEMORAX_CODE_CODEX_TRACE_ENABLED: undefined,
    },
    memoraxCodeHome: sessionHome,
  });
  try {
    await controller.recordTurnStart({
      sessionId: "session-rolled-back-turn",
      turnId: "turn-original",
      prompt: "Original prompt.",
      cwd: TEST_WORKSPACE,
      transcriptPath,
    });
    await controller.recordTurnStart({
      sessionId: "session-rolled-back-turn",
      turnId: "turn-edited",
      prompt: "Edited prompt.",
      cwd: TEST_WORKSPACE,
      transcriptPath,
    });

    const eventsPath = tracePaths(sessionHome).eventsJsonl("session-rolled-back-turn");
    const events = (await readFile(eventsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(events.map((event) => event.type), ["turn_start", "turn_start"]);
    assert.equal(events.some((event) => event.type === "turn_end"), false);
  } finally {
    controller.close();
    await rm(sessionHome, { recursive: true, force: true });
  }
});

test("Backend memory hook endpoints keep working when Codex trace is disabled", async () => {
  const { fetchImpl, requests } = memoraxAddFetch();
  const sessionHome = await mkdtemp(join(tmpdir(), "memorax-code-hook-trace-disabled-"));
  await writeFile(join(sessionHome, "config.toml"), [
    "[trace.codex]",
    "enabled = false",
    "",
  ].join("\n"), "utf8");
  const restoreEnv = withEnv({
    ...WRITEBACK_ENV,
    MEMORAX_CODE_HOME: undefined,
    MEMORAX_CODE_CODEX_TRACE_ENABLED: undefined,
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  const state = createBackendState("127.0.0.1", { sessionHome });
  const server = createBackendServer(state);
  const url = await listen(server);
  const transcriptPath = await writeRollout(sessionHome, "session-trace-disabled", [{
    turnId: "turn-trace-disabled",
    prompt: "Trace disabled prompt.",
    reply: "Trace disabled answer.",
  }]);
  try {
    await originalFetch(`${url}/memory/turn-start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: 1,
        client: "codex",
        sessionId: "session-trace-disabled",
        turnId: "turn-trace-disabled",
        prompt: "Trace disabled prompt.",
        cwd: TEST_WORKSPACE,
        transcriptPath,
      }),
    });
    const writeback = await originalFetch(`${url}/memory/writeback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: 1,
        client: "codex",
        sessionId: "session-trace-disabled",
        turnId: "turn-trace-disabled",
        lastAssistantMessage: "Trace disabled answer.",
        transcriptPath,
      }),
    });
    assert.equal(writeback.status, 200);
    assert.deepEqual(await writeback.json(), { ok: true, scheduled: true });
    await waitFor(() => requests.length === 1, "disabled trace hook writeback did not call MemoraX add");
    await assert.rejects(readFile(tracePaths(sessionHome).currentTurnPath, "utf8"));
    await assert.rejects(readFile(tracePaths(sessionHome).eventsJsonl("session-trace-disabled"), "utf8"));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    globalThis.fetch = originalFetch;
    restoreEnv();
    await rm(sessionHome, { recursive: true, force: true });
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

async function writeRollout(root, sessionId, turns, options = {}) {
  const transcriptPath = join(root, `${sessionId}.jsonl`);
  const records = [{
    timestamp: "2026-07-16T00:00:00.000Z",
    type: "session_meta",
    payload: {
      id: sessionId,
      ...(options.headerSource ? { source: options.headerSource } : {}),
    },
  }, ...(options.prefixRecords ?? [])];
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
    );
    for (const [toolIndex, input] of (turn.toolCalls ?? []).entries()) {
      records.push({
        timestamp: `2026-07-16T00:00:${String(index * 3 + 2).padStart(2, "0")}.${String(toolIndex + 1).padStart(3, "0")}Z`,
        type: "response_item",
        payload: { type: "custom_tool_call", name: "exec", input },
      });
    }
    for (const [commentaryIndex, message] of (turn.commentaries ?? []).entries()) {
      records.push({
        timestamp: `2026-07-16T00:00:${String(index * 3 + 2).padStart(2, "0")}.${String(commentaryIndex + 100).padStart(3, "0")}Z`,
        type: "event_msg",
        payload: { type: "agent_message", message, phase: "commentary" },
      });
    }
    if (turn.tokenUsage) {
      records.push({
        timestamp: `2026-07-16T00:00:${String(index * 3 + 3).padStart(2, "0")}.500Z`,
        type: "event_msg",
        payload: {
          type: "token_count",
          info: { total_token_usage: turn.tokenUsage },
        },
      });
    }
    if (turn.interrupted) {
      records.push({
        timestamp: `2026-07-16T00:00:${String(index * 3 + 3).padStart(2, "0")}.750Z`,
        type: "event_msg",
        payload: { type: "turn_aborted", turn_id: turn.turnId, reason: "interrupted" },
      });
      if (turn.rolledBack) {
        records.push({
          timestamp: `2026-07-16T00:00:${String(index * 3 + 3).padStart(2, "0")}.900Z`,
          type: "event_msg",
          payload: { type: "thread_rolled_back", num_turns: 1 },
        });
      }
    } else {
      records.push({
        timestamp: `2026-07-16T00:00:${String(index * 3 + 3).padStart(2, "0")}.000Z`,
        type: "event_msg",
        payload: { type: "agent_message", message: turn.reply, phase: "final_answer" },
      });
    }
  }
  await writeFile(transcriptPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
  return transcriptPath;
}

function memoraxAddFetch() {
  const requests = [];
  return {
    requests,
    fetchImpl: async (url, init) => {
      requests.push({
        url: String(url),
        body: JSON.parse(init.body),
      });
      return new Response(JSON.stringify({ success: true, data: { task_id: "hook-memory-add", status: "queued" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  };
}

function memoraxSearchFetch(memoryText) {
  const requests = [];
  return {
    requests,
    fetchImpl: async (url, init) => {
      requests.push({
        url: String(url),
        body: JSON.parse(init.body),
      });
      return new Response(JSON.stringify({
        success: true,
        data: {
          task_id: "hook-memory-search",
          status: "completed",
          data: [{
            id: "memory-1",
            memory: memoryText,
            score: 0.95,
            metadata: { memory_type: "core" },
          }],
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  };
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

async function waitForFile(path, pattern, message) {
  await waitFor(async () => {
    try {
      return pattern.test(await readFile(path, "utf8"));
    } catch {
      return false;
    }
  }, message);
}

function withEnv(updates) {
  const previous = new Map(Object.keys(updates).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function captureUnhandledRejections() {
  const errors = [];
  const handler = (error) => {
    errors.push(error);
  };
  process.on("unhandledRejection", handler);
  return {
    errors,
    restore() {
      process.off("unhandledRejection", handler);
    },
  };
}

async function delay(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
