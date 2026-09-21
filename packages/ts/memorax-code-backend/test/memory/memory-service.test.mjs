import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createBackendState } from "../../dist/app/state.js";
import { createMemoryService } from "../../dist/memory/service.js";
import { clientTracePaths } from "../../dist/trace/config.js";

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

test("CodeBuddy and WorkBuddy isolate equal native IDs through service writeback and trace", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "memorax-codebuddy-trace-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const sessionId = "trace-completed";
  const prompt = "remember this";
  const turnId = codeBuddyTurnId(sessionId, prompt);
  const requests = [];
  const service = createMemoryService({
    env: {
      MEMORAX_CODE_HOME: home,
      MEMORAX_CODE_MEMORY_RETRIEVAL_ENABLED: "false",
      MEMORAX_CODE_MEMORY_WRITEBACK_ENABLED: "true",
      MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_ENABLED: "false",
      MEMORAX_CODE_MEMORAX_ENDPOINT: "http://memorax.test",
      MEMORAX_CODE_MEMORAX_API_KEY: "secret",
      MEMORAX_CODE_MEMORAX_USER_ID: "user-1",
    },
    fetchImpl: async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ success: true, data: { task_id: "saved", status: "queued" } }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    },
  });
  try {
    const commands = [];
    for (const client of ["codebuddy", "workbuddy"]) {
      const cwd = join(home, client);
      const transcriptPath = join(home, `${client}.jsonl`);
      await mkdir(cwd);
      await writeFile(transcriptPath, [
        { id: "u1", type: "message", role: "user", sessionId, content: [{ type: "input_text", text: `<user_query>${prompt}</user_query>` }] },
        { id: "a1", type: "message", role: "assistant", parentId: "u1", status: "completed", content: [{ type: "output_text", text: `${client} done` }] },
      ].map((record) => JSON.stringify(record)).join("\n") + "\n");
      const start = { version: 1, sessionId, turnId, transcriptPath, prompt, client, cwd };
      commands.push(start);
      await service.recordTurnStart(start);
    }
    for (const start of commands) {
      assert.deepEqual(await service.writebackTurn(start), { ok: true, scheduled: true });
    }
    await service.drain();
    assert.equal(requests.length, 2);
    for (const [index, { client }] of commands.entries()) {
      assert.equal(requests[index].user_id, `user-1@${client}`);
      assert.equal(requests[index].session_id, sessionId);
      assert.equal(requests[index].messages[1].content, `${client} done`);
      const paths = clientTracePaths(client, home);
      const events = (await readFile(paths.eventsJsonl(sessionId), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      assert.deepEqual(events.map((event) => event.type), ["turn_start", "turn_end", "turn_materialized"]);
      assert.ok(events.every((event) => event.trace.client === client && event.trace.session_id === sessionId));
      assert.equal(events[0].source, `${client}-hook`);
      assert.equal(events[1].outcome, "completed");
      assert.equal(events[2].source, `${client}-transcript`);
      const current = JSON.parse(await readFile(paths.sessionCurrentTurnPath(sessionId), "utf8"));
      assert.equal(current.turn_state, "completed");
    }
  } finally {
    service.close();
  }
});

test("memory service surfaces automatic Add quota on the next supported client turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-service-quota-"));
  const memoraxCodeHome = join(root, "home");
  const workspace = join(root, "workspace");
  await Promise.all([
    mkdir(memoraxCodeHome, { recursive: true }),
    mkdir(workspace, { recursive: true }),
  ]);
  const turns = [
    { turnId: "turn-quota-1", prompt: "Store the first turn.", reply: "First turn stored." },
    { turnId: "turn-quota-2", prompt: "Store the second turn.", reply: "Second turn stored." },
    { turnId: "turn-quota-3", prompt: "Store the third turn.", reply: "Third turn stored." },
  ];
  const transcriptPath = await writeRollout(root, "session-service-quota", turns);
  const codeBuddyTranscriptPath = join(root, "session-codebuddy-service-quota.jsonl");
  await writeFile(codeBuddyTranscriptPath, "", "utf8");
  const diagnosticEvents = [];
  const requests = [];
  const service = createMemoryService({
    claimQuotaNotice: async (_config, quota) => `Quota notice: ${quota.remaining} remaining.`,
    diagnosticLogger(message, fields) {
      diagnosticEvents.push({ message, fields });
    },
    env: {
      MEMORAX_CODE_HOME: memoraxCodeHome,
      MEMORAX_CODE_CODEX_TRACE_ENABLED: "false",
      MEMORAX_CODE_CLAUDE_TRACE_ENABLED: "false",
      MEMORAX_CODE_CODEBUDDY_TRACE_ENABLED: "false",
      MEMORAX_CODE_MEMORY_RETRIEVAL_ENABLED: "false",
      MEMORAX_CODE_MEMORY_WRITEBACK_ENABLED: "true",
      MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_ENABLED: "false",
      MEMORAX_CODE_MEMORAX_ENDPOINT: "http://memorax.test",
      MEMORAX_CODE_MEMORAX_API_KEY: "secret",
      MEMORAX_CODE_MEMORAX_USER_ID: "user-1",
    },
    fetchImpl: async (url, init) => {
      const remaining = 9_999 - requests.length;
      requests.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response(JSON.stringify({
        success: true,
        data: {
          task_id: `service-quota-${requests.length}`,
          status: "completed",
          balances: [{
            product_code: "memory_api",
            feature_code: "memory_write",
            spec_key: "calls",
            quota_unit: "times",
            quota_limit: 10_000,
            reserved: 1,
            consumed: 0,
            remaining,
          }],
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    memoraxCodeHome,
  });
  const codexTurnStart = (turn) => ({
    version: 1,
    client: "codex",
    sessionId: "session-service-quota",
    turnId: turn.turnId,
    prompt: turn.prompt,
    cwd: workspace,
    transcriptPath,
  });
  const writeback = (turn) => ({
    version: 1,
    client: "codex",
    sessionId: "session-service-quota",
    turnId: turn.turnId,
    lastAssistantMessage: turn.reply,
    cwd: workspace,
    transcriptPath,
  });
  try {
    await service.recordTurnStart(codexTurnStart(turns[0]));
    assert.deepEqual(await service.writebackTurn(writeback(turns[0])), {
      ok: true,
      scheduled: true,
    });
    await waitForAcceptedWritebacks(diagnosticEvents, 1);

    const claudeNotice = await service.recordTurnStart({
      version: 1,
      client: "claude-code",
      sessionId: "session-claude-service-quota",
      promptId: "prompt-service-quota",
      prompt: "Show the first pending warning.",
      cwd: workspace,
      transcriptPath,
    });
    assert.equal(claudeNotice.userNotice, "Quota notice: 9999 remaining.");
    assert.equal("additionalContext" in claudeNotice, false);

    await service.recordTurnStart(codexTurnStart(turns[1]));
    assert.deepEqual(await service.writebackTurn(writeback(turns[1])), {
      ok: true,
      scheduled: true,
    });
    await waitForAcceptedWritebacks(diagnosticEvents, 2);

    const codeBuddySessionId = "session-codebuddy-service-quota";
    const codeBuddyPrompt = "Show the second pending warning.";
    const codeBuddyNotice = await service.recordTurnStart({
      version: 1,
      client: "codebuddy",
      sessionId: codeBuddySessionId,
      turnId: codeBuddyTurnId(codeBuddySessionId, codeBuddyPrompt),
      prompt: codeBuddyPrompt,
      cwd: workspace,
      transcriptPath: codeBuddyTranscriptPath,
    });
    assert.equal(codeBuddyNotice.userNotice, "Quota notice: 9998 remaining.");
    assert.equal("additionalContext" in codeBuddyNotice, false);

    await service.recordTurnStart(codexTurnStart(turns[2]));
    assert.deepEqual(await service.writebackTurn(writeback(turns[2])), {
      ok: true,
      scheduled: true,
    });
    await waitForAcceptedWritebacks(diagnosticEvents, 3);

    const openCodeTurn = {
      version: 1,
      client: "opencode",
      sessionId: "session-opencode-service-quota",
      userMessageId: "user-opencode-service-quota",
      prompt: "Show the second pending warning.",
      cwd: workspace,
    };
    const openCodeNotice = await service.recordTurnStart(openCodeTurn);
    assert.equal(openCodeNotice.userNotice, "Quota notice: 9997 remaining.");
    assert.equal("additionalContext" in openCodeNotice, false);
    assert.deepEqual(await service.recordTurnStart(openCodeTurn), { ok: true });
    assert.equal(requests.length, 3);
  } finally {
    await service.drain();
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

test("eight native Turns share one QA Add with optional Responses items and stable request retries", { timeout: 60_000 }, async (t) => {
  for (const scenario of [
    { name: "both enabled", qa: true, archive: true },
    { name: "QA disabled", qa: false, archive: true },
    { name: "existing config without collection opt-in", qa: true, archive: false },
  ]) {
    await t.test(scenario.name, async (t) => {
      const root = await mkdtemp(join(tmpdir(), "memorax-service-coding-event-"));
      t.after(() => rm(root, { recursive: true, force: true }));
      const home = join(root, "state");
      const workspace = join(root, "workspace");
      await mkdir(workspace);
      const sessionId = "independent-upload-session";
      const turns = Array.from({ length: 8 }, (_, index) => ({
        turnId: `turn-${index + 1}`, prompt: `Review module ${index + 1}.`,
        reply: `Module ${index + 1} was reviewed.`, coding: true,
      }));
      const transcriptPath = await writeRollout(root, sessionId, turns);
      const requests = [];
      const diagnostics = [];
      const service = createMemoryService({
        memoraxCodeHome: home,
        env: {
          MEMORAX_CODE_HOME: home,
          MEMORAX_CODE_CODEX_TRACE_ENABLED: "false",
          MEMORAX_CODE_MEMORY_RETRIEVAL_ENABLED: "false",
          MEMORAX_CODE_MEMORY_WRITEBACK_ENABLED: String(scenario.qa),
          ...(scenario.archive ? { MEMORAX_CODE_CODING_SESSIONS_ENABLED: "true" } : {}),
          MEMORAX_CODE_MEMORAX_ENDPOINT: "http://memorax.test",
          MEMORAX_CODE_MEMORAX_API_KEY: "synthetic-key",
          MEMORAX_CODE_MEMORAX_USER_ID: "user-1",
        },
        diagnosticLogger: (message, fields) => diagnostics.push({ message, fields }),
        fetchImpl: async (url, init) => {
          const body = JSON.parse(init.body);
          assert.equal(String(url), "http://memorax.test/v1/memories/add");
          requests.push(body);
          assert.equal(body.event, undefined);
          assert.equal(body.coding_turns, undefined);
          assert.equal(body.turns, undefined);
          assert.equal(body.items, undefined);
          assert.doesNotMatch(JSON.stringify(body.messages), /Tool-only output|function_call/);
          if (scenario.archive && requests.length === 1) return new Response("", { status: 503 });
          return Response.json({ success: true, data: { task_id: "qa-accepted", status: "accepted" } }, { status: 202 });
        },
      });
      t.after(() => service.close());
      for (const turn of turns) {
        const command = { version: 1, client: "codex", sessionId, turnId: turn.turnId, cwd: workspace, transcriptPath };
        await service.recordTurnStart({ ...command, prompt: turn.prompt });
        const result = await service.writebackTurn({ ...command, lastAssistantMessage: turn.reply });
        assert.equal(result.scheduled, scenario.qa);
        if (!scenario.qa) assert.equal(result.reason, "disabled");
      }
      if (scenario.qa) await waitForAcceptedWritebacks(diagnostics, 1);
      await service.drain();
      assert.equal(requests.length, scenario.qa ? (scenario.archive ? 2 : 1) : 0);
      const archives = requests.flatMap((request) => request.coding_context ? [request.coding_context] : []);
      assert.equal(archives.length, scenario.qa && scenario.archive ? 2 : 0);
      if (scenario.qa && scenario.archive) {
        assert.deepEqual(requests[1], requests[0], "retry preserves both QA and the exact archive batch");
        assert.equal(requests[0].messages.length, 16);
        assert.equal(requests[0].user_id, "user-1@workspace");
        assert.equal(archives[0].schema_version, 2);
        assert.equal(archives[0].redaction_version, 1);
        assert.equal(archives[0].repository_slug, "workspace");
        assert.deepEqual(archives[0].turns.map((turn) => turn.turn_id), turns.map((turn) => turn.turnId));
        assert.deepEqual(archives[0].turns.map((turn) => turn.turn_index), [1, 2, 3, 4, 5, 6, 7, 8]);
        assert.equal(archives[0].items.length, 8 * 7);
        let offset = 0;
        for (const [index, metadata] of archives[0].turns.entries()) {
          assert.deepEqual(Object.keys(metadata).sort(), ["closed_at", "item_count", "turn_id", "turn_index"]);
          assert.equal(metadata.item_count, 7);
          const items = archives[0].items.slice(offset, offset + metadata.item_count);
          offset += metadata.item_count;
          assert.deepEqual(items.map((item) => item.type), [
            "message", "message", "function_call", "function_call_output",
            "custom_tool_call", "custom_tool_call_output", "message",
          ]);
          assert.deepEqual(items[0], { type: "message", id: `user-item-${index}`, role: "user",
            content: [{ type: "input_text", text: turns[index].prompt }] });
          assert.equal(items[1].phase, "commentary");
          assert.deepEqual(items[2], { type: "function_call", id: `function-item-${index}`, call_id: `call-${index}`,
            name: "read_file", namespace: "functions", arguments: '{"path":"src/main.ts"}' });
          assert.equal(items[3].call_id, items[2].call_id);
          assert.equal(items[4].input, "*** Begin Patch\n*** End Patch");
          assert.equal(items[5].call_id, items[4].call_id);
          assert.deepEqual(items[6], { type: "message", id: `assistant-item-${index}`, role: "assistant",
            phase: "final_answer", content: [{ type: "output_text", text: turns[index].reply }] });
          assert.ok(items.every((item) => !("index" in item) && !("status" in item) && !("tool_result" in item)));
        }
        assert.equal(offset, archives[0].items.length, "Turn counts partition every collected item");
        assert.match(JSON.stringify(archives[0]), /Tool-only output/);
        assert.doesNotMatch(JSON.stringify(archives[0]), /Bearer fake-sensitive-value|internal_metadata|Private reasoning marker/);
        assert.equal(JSON.stringify(archives[0]).includes(root), false);
      }
    });
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

function codeBuddyTurnId(sessionId, prompt, boundary = 0) {
  return `${sessionId}:${boundary}:${createHash("sha256").update(prompt.trim()).digest("hex")}`;
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
      ...(turn.coding ? [
        { timestamp: "2026-07-16T00:00:02.050Z", type: "response_item", payload: {
          type: "message", id: `user-item-${index}`, role: "user",
          content: [{ type: "input_text", text: turn.prompt }], internal_metadata: { cwd: root },
        } },
        { timestamp: "2026-07-16T00:00:02.060Z", type: "response_item", payload: {
          type: "message", role: "assistant", phase: "commentary",
          content: [{ type: "output_text", text: "I will inspect the module." }], status: "completed",
        } },
        { timestamp: "2026-07-16T00:00:02.070Z", type: "response_item", payload: {
          type: "reasoning", summary: [{ type: "summary_text", text: "Private reasoning marker" }],
        } },
        { timestamp: "2026-07-16T00:00:02.100Z", type: "response_item", payload: {
          type: "function_call", id: `function-item-${index}`, call_id: `call-${index}`, name: "read_file",
          namespace: "functions", arguments: "{\"path\":\"src/main.ts\"}", internal_metadata: { cwd: root },
        } },
        { timestamp: "2026-07-16T00:00:02.200Z", type: "response_item", payload: {
          type: "function_call_output", call_id: `call-${index}`, output: "Tool-only output. Authorization: Bearer fake-sensitive-value",
        } },
        { timestamp: "2026-07-16T00:00:02.300Z", type: "response_item", payload: {
          type: "custom_tool_call", call_id: `custom-${index}`, name: "apply_patch", input: "*** Begin Patch\n*** End Patch",
        } },
        { timestamp: "2026-07-16T00:00:02.400Z", type: "response_item", payload: {
          type: "custom_tool_call_output", call_id: `custom-${index}`, output: "No changes needed.",
        } },
        { timestamp: "2026-07-16T00:00:02.500Z", type: "response_item", payload: {
          type: "message", id: `assistant-item-${index}`, role: "assistant", phase: "final_answer",
          content: [{ type: "output_text", text: turn.reply }], status: "completed",
        } },
      ] : []),
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

async function waitForAcceptedWritebacks(events, expected) {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    const accepted = events.filter(({ message, fields }) => (
      message === "memory.automatic_writeback" && fields?.accepted === true
    )).length;
    if (accepted >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`automatic writeback ${expected} did not settle`);
}


test("memory service records confirmed completion failures without changing Hook results", async (t) => {
  for (const scenario of [
    { name: "unreadable transcript", missing: true, reason: "transcript_unavailable", stage: "content-read" },
    { name: "wrong native session", wrongSession: true, reason: "transcript_session_mismatch", stage: "correlation" },
    { name: "unreadable workspace", wrongWorkspace: true, reason: "workspace_scope_unavailable", stage: "scope" },
    { name: "incomplete assistant output", incomplete: true, reason: "assistant_message_missing", quiet: true },
    { name: "disabled writeback", missing: true, disabled: true, reason: "transcript_unavailable", quiet: true },
    { name: "unavailable diagnostic directory", missing: true, blocked: true, reason: "transcript_unavailable" },
  ]) {
    await t.test(scenario.name, async (t) => {
      const root = await mkdtemp(join(tmpdir(), "memorax-service-diagnostics-"));
      t.after(() => rm(root, { recursive: true, force: true }));
      const memoraxCodeHome = join(root, "state");
      const workspace = join(root, "workspace");
      await mkdir(workspace);
      if (scenario.blocked) {
        await mkdir(join(memoraxCodeHome, "runtime"), { recursive: true });
        await writeFile(join(memoraxCodeHome, "runtime", "diagnostics"), "occupied");
      }
      const sessionId = "private-diagnostic-session";
      const turnId = "private-diagnostic-turn";
      const transcriptPath = scenario.missing ? join(root, "private-missing-rollout.jsonl")
        : await writeRollout(root, scenario.wrongSession ? "different-native-session" : sessionId,
          [{ turnId, prompt: "Private prompt marker.", reply: scenario.incomplete ? "" : "Private answer marker." }]);
      const requests = [];
      const service = createMemoryService({
        memoraxCodeHome,
        env: { MEMORAX_CODE_HOME: memoraxCodeHome, MEMORAX_CODE_DEBUG: "false",
          MEMORAX_CODE_CODEX_TRACE_ENABLED: "false", MEMORAX_CODE_MEMORY_RETRIEVAL_ENABLED: "false",
          MEMORAX_CODE_MEMORY_WRITEBACK_ENABLED: String(!scenario.disabled),
          MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_ENABLED: "false",
          MEMORAX_CODE_MEMORAX_ENDPOINT: "http://memorax.test", MEMORAX_CODE_MEMORAX_API_KEY: "secret",
          MEMORAX_CODE_MEMORAX_USER_ID: "user-1" },
        fetchImpl: async (...args) => { requests.push(args); throw new Error("provider must not be called"); },
      });
      t.after(() => service.close());
      const command = { version: 1, client: "codex", sessionId, turnId, transcriptPath,
        cwd: scenario.wrongWorkspace ? join(root, "missing-workspace") : workspace };
      const result = await service.writebackTurn({ ...command, lastAssistantMessage: "Private answer marker." });
      assert.deepEqual(result, { ok: true, scheduled: false, reason: scenario.reason });
      await service.drain();
      assert.equal(requests.length, 0);
      if (scenario.blocked) {
        assert.equal(await readFile(join(memoraxCodeHome, "runtime", "diagnostics"), "utf8"), "occupied");
        return;
      }
      const directory = join(memoraxCodeHome, "runtime", "diagnostics");
      const files = await readdir(directory).catch((error) => { if (error.code === "ENOENT") return []; throw error; });
      if (scenario.quiet) { assert.deepEqual(files, []); return; }
      assert.equal(files.length, 1);
      const record = JSON.parse(await readFile(join(directory, files[0]), "utf8"));
      assert.equal(record.source, "automatic-writeback");
      assert.equal(record.failureReason, scenario.reason);
      assert.equal(record.stage, scenario.stage);
      assert.equal(record.client, "codex");
      assert.match(record.errorCode, /^WRITEBACK_/);
      assert.equal(record.sessionHash, createHash("sha256").update(sessionId).digest("hex").slice(0, 24));
      assert.equal(record.turnHash, createHash("sha256").update(turnId).digest("hex").slice(0, 24));
      assert.equal(record.systemCode, undefined, "the native reader does not supply an errno; do not guess one");
      assert.equal(/private|Private|secret|user-1|memorax.test/.test(JSON.stringify(record)), false);
      assert.equal(JSON.stringify(record).includes(root), false);
    });
  }
});


test("memory service does not report an OpenCode interruption without cached Turn metadata", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "memorax-service-interrupted-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  let requests = 0;
  const service = createMemoryService({ memoraxCodeHome: home,
    env: { MEMORAX_CODE_HOME: home, MEMORAX_CODE_DEBUG: "false",
      MEMORAX_CODE_OPENCODE_TRACE_ENABLED: "false", MEMORAX_CODE_MEMORY_WRITEBACK_ENABLED: "true",
      MEMORAX_CODE_MEMORAX_ENDPOINT: "http://memorax.test", MEMORAX_CODE_MEMORAX_API_KEY: "secret",
      MEMORAX_CODE_MEMORAX_USER_ID: "user-1" },
    fetchImpl: async () => { requests += 1; throw new Error("interruption must not upload"); } });
  t.after(() => service.close());
  assert.deepEqual(await service.writebackTurn({ version: 1, client: "opencode", sessionId: "session-1",
    userMessageId: "user-1", assistantMessageId: "assistant-1", cwd: home,
    messages: [
      { info: { id: "user-1", sessionID: "session-1", role: "user", time: { created: 1700000000000 } },
        parts: [{ type: "text", sessionID: "session-1", messageID: "user-1", text: "Cancel this request." }] },
      { info: { id: "assistant-1", sessionID: "session-1", role: "assistant", parentID: "user-1",
        time: { created: 1700000001000, completed: 1700000002000 }, error: { name: "MessageAbortedError" } }, parts: [] },
    ],
  }), { ok: true, scheduled: false, reason: "turn_metadata_mismatch" });
  await service.drain();
  assert.equal(requests, 0);
  await assert.rejects(readdir(join(home, "runtime", "diagnostics")), { code: "ENOENT" });
});
