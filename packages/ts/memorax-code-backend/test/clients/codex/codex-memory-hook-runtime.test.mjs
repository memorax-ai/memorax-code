import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runMemoryCli } from "../../../dist/memory/cli.js";
import { createCodexMemoryHookRuntime } from "../../../dist/clients/codex/memory-hook-runtime.js";
import { tracePaths } from "../../../dist/trace/config.js";
import {
  memoraxAddFetch,
  memoraxSearchFetch,
  waitFor,
  writeRollout,
} from "./support/memory-hook-fixtures.mjs";

const TEST_WORKSPACE = fileURLToPath(new URL("../../..", import.meta.url));
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

test("memory hook preserves registered workspace failures instead of rebinding to Hook cwd", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-hook-registered-scope-"));
  const registered = join(root, "registered");
  const registryDir = join(root, "adapters", "codex");
  const sessionId = "session-registered-scope";
  await mkdir(registered);
  await mkdir(registryDir, { recursive: true });
  await writeFile(join(registered, ".git"), "invalid Git pointer\n");
  await writeFile(join(registryDir, "workspaces.json"), JSON.stringify({ sessions: { [sessionId]: { cwd: registered } } }));
  const transcriptPath = await writeRollout(root, sessionId, [
    { turnId: "invalid-registry", prompt: "Keep the registered scope failure.", reply: "No fallback to Hook cwd." },
    { turnId: "conflicting-registry", prompt: "Check both workspace authorities.", reply: "No cross-workspace binding." },
  ]);
  const requests = [];
  const controller = createCodexMemoryHookRuntime({
    memoraxCodeHome: root,
    env: { ...WRITEBACK_ENV, MEMORAX_CODE_HOME: root, MEMORAX_CODE_MEMORY_RETRIEVAL_ENABLED: "true" },
    automaticWriteback: (input) => { requests.push(input); return { accepted: true }; },
    fetchImpl: async (input) => { requests.push(input); throw new Error("unexpected retrieval"); },
  });
  try {
    for (const [turnId, reason] of [
      ["invalid-registry", "workspace_scope_unavailable"],
      ["conflicting-registry", "workspace_scope_mismatch"],
    ]) {
      assert.deepEqual(await controller.recordTurnStart({
        sessionId, turnId, prompt: "Preserve native workspace authority.", cwd: TEST_WORKSPACE, transcriptPath,
      }), { ok: true });
      assert.deepEqual(await controller.writeback({
        sessionId, turnId, lastAssistantMessage: "Completed.", cwd: TEST_WORKSPACE, transcriptPath,
      }), { ok: true, scheduled: false, reason });
      if (turnId === "invalid-registry") await rm(join(registered, ".git"));
    }
    assert.equal(controller.size(), 2);
    assert.deepEqual(requests, []);
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
    commentaries: ["Inspecting the persisted turn."],
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
    env: { ...WRITEBACK_ENV, MEMORAX_CODE_HOME: root, MEMORAX_CODE_CODING_SESSIONS_ENABLED: "true" },
    fetchImpl,
    captureCodingTurns: true,
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
    assert.equal(requests[0].body.event, undefined);
    assert.equal(requests[0].body.coding_context.session_id, "session-hook");
    assert.equal(requests[0].body.coding_context.turns[0].turn_id, "turn-1");
    assert.deepEqual(requests[0].body.coding_context.items, [
      { type: "message", role: "user", content: [{ type: "input_text", text: "Remember this persisted Codex turn.\n" }] },
      { type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "Inspecting the persisted turn." }] },
      { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "Stored persisted Codex answer.\n" }] },
    ]);
    assert.deepEqual(requests[0].body.messages.map((message) => message.timestamp), [
      Date.parse("2026-07-16T00:00:02.000Z"),
      Date.parse("2026-07-16T00:00:03.000Z"),
    ]);
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

test("Codex source-only identity failure preserves independently valid QA writeback", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-hook-source-identity-"));
  const transcriptPath = await writeRollout(root, "session-source-identity", [{
    turnId: "turn-1", prompt: "Inspect the parser.", reply: "The parser is correct.", toolCalls: ["read parser"],
  }]);
  const records = (await readFile(transcriptPath, "utf8")).trim().split("\n").map(JSON.parse);
  const tool = records.find((record) => record.type === "response_item");
  tool.payload = {
    type: "function_call", call_id: "call-other", name: "read", arguments: "{}",
    internal_chat_message_metadata_passthrough: { turn_id: "other-turn" },
  };
  await writeFile(transcriptPath, `${records.map(JSON.stringify).join("\n")}\n`);
  const { fetchImpl, requests } = memoraxAddFetch();
  const controller = createCodexMemoryHookRuntime({
    env: { ...WRITEBACK_ENV, MEMORAX_CODE_HOME: root, MEMORAX_CODE_CODEX_TRACE_ENABLED: "false", MEMORAX_CODE_CODING_SESSIONS_ENABLED: "true" },
    fetchImpl,
    captureCodingTurns: true,
  });
  try {
    await controller.recordTurnStart({
      sessionId: "session-source-identity", turnId: "turn-1", prompt: "Inspect the parser.",
      transcriptPath, cwd: root,
    });
    assert.deepEqual(await controller.writeback({
      sessionId: "session-source-identity", turnId: "turn-1", lastAssistantMessage: "The parser is correct.",
      transcriptPath, cwd: root,
    }), { ok: true, scheduled: true });
    await waitFor(() => requests.length === 1, "QA writeback must not depend on source collection");
    assert.deepEqual(requests[0].body.messages.map(({ content }) => content), ["Inspect the parser.", "The parser is correct."]);
    assert.equal(requests[0].body.coding_context, undefined, "Source identity failures must not construct a fallback archive");
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

test("memory hook and nested Skill commands share General across Codex projectless task directories", async () => {
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
  const env = {
    ...WRITEBACK_ENV,
    MEMORAX_CODE_HOME: join(root, "home"),
    MEMORAX_CODE_CODEX_TRACE_ENABLED: "false",
  };
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(init.body) });
    const data = String(url).endsWith("/add") ? { task_id: "general-add", status: "queued" } : { data: [] };
    return new Response(JSON.stringify({ success: true, data }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const controller = createCodexMemoryHookRuntime({ env, fetchImpl });
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
      "user-1@General",
      "user-1@General",
    ]);
    assert.equal(requests[0].body.metadata.memorax_code_memory_scope, "general.v1");
    assert.equal(requests[0].body.metadata.memorax_code_workspace, "General");
    const nested = join(firstTask, "work");
    await mkdir(nested);
    const options = { cwd: nested, env: { ...env, CODEX_THREAD_ID: "session-projectless-1" }, fetchImpl };
    const search = await runMemoryCli(["search", "--query", "general preference"], options);
    const added = await runMemoryCli([
      "add", "--memory", "Keep shared general preferences.", "--type", "preference", "--reason", "Explicit test save.",
    ], options);
    assert.equal(search.ok, true);
    assert.equal(added.ok, true);
    assert.equal(search.effectiveUserId, requests[0].body.user_id);
    assert.equal(added.effectiveUserId, requests[0].body.user_id);
    assert.deepEqual(requests.map(({ url }) => new URL(url).pathname), [
      "/v1/memories/add", "/v1/memories/add", "/v1/memories/search", "/v1/memories/add",
    ]);
    assert.ok(requests.every(({ body }) => body.user_id === "user-1@General"));
    assert.equal(requests[3].body.metadata.memorax_code_memory_scope, "general.v1");
  } finally {
    controller.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex binds a cwd-less General turn once before native writeback", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-hook-general-bind-"));
  const workspace = join(root, "Documents", "Codex", "2026-09-09", "task");
  const nested = join(workspace, "nested");
  const other = join(root, "Documents", "Codex", "2026-09-09", "other");
  const ordinary = join(root, "ordinary");
  await Promise.all([nested, other, ordinary].map((path) => mkdir(path, { recursive: true })));
  const { fetchImpl, requests } = memoraxAddFetch();
  const env = {
    ...WRITEBACK_ENV, HOME: root, USERPROFILE: root,
    MEMORAX_CODE_HOME: join(root, "state"),
    MEMORAX_CODE_CODEX_TRACE_ENABLED: "false",
  };
  const controller = createCodexMemoryHookRuntime({ env, fetchImpl, memoraxCodeHome: env.MEMORAX_CODE_HOME });
  try {
    for (const [sessionId, cwd, accepted] of [["bind-default", workspace, true], ["reject-ordinary", ordinary, false]]) {
      const transcriptPath = await writeRollout(root, sessionId, [
        { turnId: "first", prompt: "Keep this general preference.", reply: "The preference is recorded." },
        { turnId: "next", prompt: "Continue the same task.", reply: "The scope stays bound." },
      ]);
      await controller.recordTurnStart({
        sessionId, turnId: "first", prompt: "Keep this general preference.",
        workspaceKind: "projectless", transcriptPath,
      });
      const before = requests.length;
      const completed = await controller.writeback({
        sessionId, turnId: "first", cwd, transcriptPath,
        lastAssistantMessage: "The preference is recorded.",
      });
      if (!accepted) {
        assert.deepEqual(completed, { ok: true, scheduled: false, reason: "workspace_scope_mismatch" });
        assert.equal(requests.length, before, "an ordinary cwd cannot inherit an unbound General hint");
        continue;
      }
      assert.deepEqual(completed, { ok: true, scheduled: true });
      await waitFor(() => requests.length === before + 1, "first cwd binding lost the current QA");
      assert.equal(requests[before].body.user_id, "user-1@General");
      assert.deepEqual(requests[before].body.messages.map(({ role, content, timestamp }) => ({ role, content, timestamp })), [
        { role: "user", content: "Keep this general preference.", timestamp: Date.parse("2026-07-16T00:00:02.000Z") },
        { role: "assistant", content: "The preference is recorded.", timestamp: Date.parse("2026-07-16T00:00:03.000Z") },
      ]);
      await controller.recordTurnStart({
        sessionId, turnId: "next", prompt: "Continue the same task.", cwd: nested, transcriptPath,
      });
      assert.deepEqual(await controller.writeback({
        sessionId, turnId: "next", cwd: nested, transcriptPath, lastAssistantMessage: "The scope stays bound.",
      }), { ok: true, scheduled: true });
      await waitFor(() => requests.length === before + 2, "bound General did not survive the next nested turn");
      assert.equal(requests[before + 1].body.user_id, "user-1@General");
      await controller.recordTurnStart({
        sessionId, turnId: "next", prompt: "Continue the same task.",
        cwd: other, workspaceKind: "projectless", transcriptPath,
      });
      assert.deepEqual(await controller.writeback({
        sessionId, turnId: "next", cwd: other, transcriptPath, lastAssistantMessage: "The scope stays bound.",
      }), { ok: true, scheduled: false, reason: "workspace_scope_mismatch" });
      assert.equal(requests.length, before + 2, "an established General root cannot be replaced");
    }
  } finally {
    controller.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex General recovery respects the native header and existing local bindings", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-hook-native-scope-"));
  const workspace = join(root, "Documents", "Codex", "2026-09-08", "task");
  const nested = join(workspace, "nested");
  await mkdir(nested, { recursive: true });
  const env = {
    ...WRITEBACK_ENV,
    HOME: root,
    USERPROFILE: root,
    MEMORAX_CODE_HOME: join(root, "state"),
    MEMORAX_CODE_CODEX_TRACE_ENABLED: "false",
    MEMORAX_CODE_MEMORY_RETRIEVAL_ENABLED: "true",
  };
  const metadata = (id, cwd) => ({ type: "session_meta", payload: { id, cwd } });
  const { fetchImpl, requests } = memoraxSearchFetch("Scoped test memory.");
  try {
    for (const [sessionId, records, initialKind] of [
      ["wrong-session", [metadata("other-session", workspace)]],
      ["imported-root", [metadata("imported-root", nested), metadata("imported-root", workspace)]],
      ["invalid-header", [{ type: "turn_context", payload: {} }, metadata("invalid-header", workspace)]],
      ["explicit-local", [metadata("explicit-local", workspace)], "local"],
    ]) {
      const transcriptPath = join(root, `${sessionId}.jsonl`);
      await writeFile(transcriptPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
      const controller = createCodexMemoryHookRuntime({ env, fetchImpl, automaticWriteback: () => ({ accepted: true }) });
      try {
        if (initialKind) {
          await controller.recordTurnStart({
            sessionId, turnId: "first", prompt: "Keep the explicit folder scope.",
            cwd: workspace, workspaceKind: initialKind, transcriptPath,
          });
        }
        const result = await controller.recordTurnStart({
          sessionId, turnId: "next", prompt: "Use only the authorized session scope.", cwd: nested, transcriptPath,
        });
        assert.match(result.additionalContext, /Scoped test memory/, sessionId);
        assert.equal(requests.at(-1).body.user_id, `user-1@${initialKind ? "task" : "nested"}`, sessionId);
      } finally {
        controller.close();
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("memory hook restores exact projectless scope from current-turn state after restart with trace disabled", async () => {
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
    MEMORAX_CODE_CODEX_TRACE_ENABLED: "false",
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
    assert.equal(requests[0].body.user_id, "user-1@General");
    const current = JSON.parse(await readFile(
      tracePaths(memoraxCodeHome).sessionCurrentTurnPath("session-projectless-restart"), "utf8",
    ));
    assert.equal(current.turn_state, "completed");
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
    MEMORAX_CODE_CODEX_TRACE_ENABLED: "true",
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
  const paths = tracePaths(env.MEMORAX_CODE_HOME);
  await Promise.all([
    rm(paths.currentTurnPath),
    rm(paths.sessionCurrentTurnPath("session-scope-restart-unavailable")),
  ]);

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
    assert.equal(requests[0].body.user_id, "user-1@General");
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
