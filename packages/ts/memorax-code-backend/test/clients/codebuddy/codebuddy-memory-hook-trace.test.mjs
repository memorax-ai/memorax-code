import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMemoryCli } from "../../../dist/memory/cli.js";
import { createCodeBuddyMemoryHookRuntime } from "../../../dist/clients/codebuddy/memory-hook-runtime.js";
import { clientTracePaths, codeBuddyTracePaths } from "../../../dist/trace/config.js";

const fetchImpl = async () => new Response(JSON.stringify({ context: "retrieved context" }), {
  status: 200,
  headers: { "content-type": "application/json" },
});

function command(sessionId, turnId, transcriptPath, prompt) {
  return {
    version: 1,
    client: "codebuddy",
    sessionId,
    turnId,
    transcriptPath,
    prompt,
    cwd: process.cwd(),
  };
}

function lines(records) {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

async function readEvents(home, sessionId, client = "codebuddy") {
  const path = clientTracePaths(client, home).eventsJsonl(sessionId);
  return (await readFile(path, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line));
}

test("CodeBuddy runtime traces incomplete assistant and does not write back", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-codebuddy-trace-"));
  const transcriptPath = join(home, "session.jsonl");
  const sessionId = "trace-incomplete";
  await writeFile(transcriptPath, lines([
    { id: "u1", type: "message", role: "user", sessionId, content: [{ type: "input_text", text: "<user_query>cancel me</user_query>" }] },
    { id: "a1", type: "message", role: "assistant", parentId: "u1", status: "incomplete", content: [{ type: "output_text", text: "partial" }] },
  ]));
  const writes = [];
  const runtime = createCodeBuddyMemoryHookRuntime({
    env: { MEMORAX_CODE_HOME: home },
    fetchImpl,
    automaticWriteback: async (request) => writes.push(request),
  });
  const turnId = provisionalTurnId(sessionId, "cancel me");
  await runtime.recordTurnStart(command(sessionId, turnId, transcriptPath, "cancel me"));
  const result = await runtime.writeback({ ...command(sessionId, turnId, transcriptPath, ""), client: "codebuddy" });
  runtime.close();

  assert.deepEqual(result, { ok: true, scheduled: false, reason: "assistant_message_missing" });
  assert.equal(writes.length, 0);
  const events = await readEvents(home, sessionId);
  assert.deepEqual(events.map((event) => event.type), ["turn_start", "turn_end"]);
  assert.equal(events[1].ok, false);
  assert.equal(events[1].outcome, "interrupted");
  const current = JSON.parse(await readFile(codeBuddyTracePaths(home).sessionCurrentTurnPath(sessionId), "utf8"));
  assert.equal(current.turn_state, "interrupted");
});

test("CodeBuddy next turn reconciles the previous interrupted trace without writeback", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-codebuddy-trace-reconcile-"));
  const transcriptPath = join(home, "session.jsonl");
  const sessionId = "trace-reconcile";
  const firstPrompt = "interrupt this turn";
  const secondPrompt = "continue in the next turn";
  const firstTurnId = provisionalTurnId(sessionId, firstPrompt);
  const firstUser = { id: "u1", type: "message", role: "user", sessionId, content: [{ type: "input_text", text: firstPrompt }] };
  await writeFile(transcriptPath, lines([firstUser]));
  const writes = [];
  const diagnostics = [];
  const runtime = createCodeBuddyMemoryHookRuntime({
    env: {
      MEMORAX_CODE_HOME: home,
      MEMORAX_CODE_MEMORY_RETRIEVAL_ENABLED: "false",
    },
    automaticWriteback: (request) => {
      writes.push(request);
      return { accepted: true };
    },
    diagnosticLogger: (event, fields) => diagnostics.push({ event, fields }),
  });
  try {
    await runtime.recordTurnStart(command(sessionId, firstTurnId, transcriptPath, firstPrompt));
    const beforeSecond = lines([
      firstUser,
      { id: "a1", type: "message", role: "assistant", parentId: "u1", status: "incomplete", content: [{ type: "output_text", text: "partial answer" }] },
    ]);
    await writeFile(transcriptPath, beforeSecond + lines([
      { id: "u2", type: "message", role: "user", sessionId, content: [{ type: "input_text", text: secondPrompt }] },
    ]));
    const secondTurnId = provisionalTurnId(sessionId, secondPrompt, Buffer.byteLength(beforeSecond, "utf8"));
    await runtime.recordTurnStart(command(sessionId, secondTurnId, transcriptPath, secondPrompt));

    const events = await readEvents(home, sessionId);
    assert.deepEqual(events.map((event) => event.type), ["turn_start", "turn_end", "turn_start"]);
    assert.equal(events[1].trace.turn_id, firstTurnId);
    assert.equal(events[1].source, "codebuddy-transcript");
    assert.equal(events[1].outcome, "interrupted");
    assert.equal(events[1].request.prompt, firstPrompt);
    assert.equal(events[1].response.assistantMessage, "partial answer");
    assert.equal(writes.length, 0);
    assert.equal(runtime.size(), 1);
    assert.equal(diagnostics.some(({ event }) => event === "codebuddy_memory_hook.interrupted_turn_reconciled"), true);
    const current = JSON.parse(await readFile(codeBuddyTracePaths(home).sessionCurrentTurnPath(sessionId), "utf8"));
    assert.equal(current.turn_state, "open");
    assert.equal(current.trace.turn_id, secondTurnId);
  } finally {
    runtime.close();
  }
});

test("WorkBuddy next turn restores an assistant-less interrupted trace after runtime restart", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-codebuddy-trace-restart-"));
  const transcriptPath = join(home, "session.jsonl");
  const sessionId = "trace-restart";
  const firstPrompt = "interrupt before restart";
  const secondPrompt = "continue after restart";
  const firstTurnId = provisionalTurnId(sessionId, firstPrompt);
  const firstUser = { id: "u1", type: "message", role: "user", sessionId, content: [{ type: "input_text", text: firstPrompt }] };
  await writeFile(transcriptPath, lines([firstUser]));
  const env = {
    MEMORAX_CODE_HOME: home,
    MEMORAX_CODE_MEMORY_RETRIEVAL_ENABLED: "false",
  };
  const firstRuntime = createCodeBuddyMemoryHookRuntime({
    client: "workbuddy",
    env,
    automaticWriteback: () => ({ accepted: true }),
  });
  await firstRuntime.recordTurnStart({ ...command(sessionId, firstTurnId, transcriptPath, firstPrompt), client: "workbuddy" });
  firstRuntime.close();

  const firstTranscript = lines([firstUser]);
  await writeFile(transcriptPath, firstTranscript + lines([
    { id: "u2", type: "message", role: "user", sessionId, content: [{ type: "input_text", text: secondPrompt }] },
  ]));
  const secondTurnId = provisionalTurnId(sessionId, secondPrompt, Buffer.byteLength(firstTranscript, "utf8"));
  const writes = [];
  const restarted = createCodeBuddyMemoryHookRuntime({
    client: "workbuddy",
    env,
    automaticWriteback: (request) => {
      writes.push(request);
      return { accepted: true };
    },
  });
  try {
    await restarted.recordTurnStart({ ...command(sessionId, secondTurnId, transcriptPath, secondPrompt), client: "workbuddy" });
    const events = await readEvents(home, sessionId, "workbuddy");
    assert.deepEqual(events.map((event) => event.type), ["turn_start", "turn_end", "turn_start"]);
    assert.equal(events[1].trace.turn_id, firstTurnId);
    assert.equal(events[1].outcome, "interrupted");
    assert.equal(events[1].request.prompt, firstPrompt);
    assert.equal(writes.length, 0);
    assert.equal(restarted.size(), 1);
  } finally {
    restarted.close();
  }
});

test("WorkBuddy provisional turn writeback and nested Skill commands share General", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-codebuddy-runtime-"));
  const transcriptPath = join(home, "session.jsonl");
  const workspace = join(home, "WorkBuddy");
  const nested = join(workspace, "work");
  await mkdir(nested, { recursive: true });
  const sessionId = "runtime-completed";
  const prompt = "persist this turn";
  const turnId = provisionalTurnId(sessionId, prompt);
  await writeFile(transcriptPath, lines([
    { id: "u-native", type: "message", role: "user", sessionId, timestamp: 1_700_000_000_000, content: [{ type: "input_text", text: prompt }] },
    { id: "shared-node", type: "message", role: "assistant", parentId: "u-native", content: [{ type: "output_text", text: "Inspecting the project." }] },
    { id: "shared-node", type: "function_call", parentId: "u-native", callId: "read-1", name: "Read", arguments: { path: "README.md" } },
    { id: "shared-node", type: "function_call", parentId: "u-native", callId: "read-2", name: "Read", arguments: { path: "package.json" } },
    { id: "result-1", type: "function_call_result", parentId: "shared-node", callId: "read-1", output: { type: "text", text: "project introduction" } },
    { id: "result-2", type: "function_call_result", parentId: "shared-node", callId: "read-2", output: "package metadata" },
    { id: "a-native", type: "message", role: "assistant", parentId: "result-2", status: "completed", timestamp: 1_700_000_060_000, content: [{ type: "output_text", text: "persisted reply" }] },
    { id: "late-tool", type: "function_call", parentId: "u-native", callId: "late-1", name: "Read", arguments: "not part of completed turn" },
  ]));
  const requests = [];
  const env = configuredEnv(home, { MEMORAX_CODE_WORKBUDDY_TRACE_ENABLED: "false", MEMORAX_CODE_CODING_SESSIONS_ENABLED: "true" });
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(init.body) });
    const data = String(url).endsWith("/add") ? { task_id: "general-add", status: "queued" } : { data: [] };
    return new Response(JSON.stringify({ success: true, data }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const runtime = createCodeBuddyMemoryHookRuntime({ env, fetchImpl, client: "workbuddy", captureCodingTurns: true });
  try {
    await runtime.recordTurnStart({
      ...command(sessionId, turnId, transcriptPath, prompt),
      client: "workbuddy",
      cwd: workspace,
      workspaceKind: "projectless",
    });
    assert.deepEqual(await runtime.writeback({
      ...command(sessionId, turnId, transcriptPath, ""),
      client: "workbuddy",
      cwd: workspace,
    }), { ok: true, scheduled: true });
    const deadline = Date.now() + 1_000;
    while (requests.length === 0) {
      assert.ok(Date.now() < deadline, "WorkBuddy automatic Add was not sent");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(requests[0].body.messages.map(({ role, content, timestamp }) => ({ role, content, timestamp })), [
      { role: "user", content: prompt, timestamp: 1_700_000_000_000 },
      { role: "assistant", content: "persisted reply", timestamp: 1_700_000_060_000 },
    ]);
    const codingTurn = requests[0].body.coding_turns[0];
    assert.equal(codingTurn.client, "workbuddy");
    assert.equal(codingTurn.session_id, sessionId);
    assert.equal(codingTurn.turn_id, turnId);
    assert.equal(codingTurn.turn_index, 1);
    assert.equal(codingTurn.closed_at, new Date(1_700_000_060_000).toISOString());
    assert.deepEqual(codingTurn.events.map(({ index, ...event }) => event), [
      { type: "user_message", content: prompt },
      { type: "assistant_message", phase: "progress", content: "Inspecting the project." },
      { type: "tool_call", call_id: "read-1", tool: "Read", arguments: '{"path":"README.md"}' },
      { type: "tool_call", call_id: "read-2", tool: "Read", arguments: '{"path":"package.json"}' },
      { type: "tool_result", call_id: "read-1", status: "success", output: "project introduction" },
      { type: "tool_result", call_id: "read-2", status: "success", output: "package metadata" },
      { type: "assistant_message", phase: "final", content: "persisted reply" },
    ]);
    const options = {
      cwd: nested,
      env: {
        ...env,
        CODEBUDDY_SESSION_ID: sessionId,
        CODEX_THREAD_ID: "inherited-codex-thread",
      },
      fetchImpl,
    };
    const search = await runMemoryCli(["search", "--query", "general preference"], options);
    const added = await runMemoryCli([
      "add", "--memory", "Keep shared general preferences.", "--type", "preference", "--reason", "Explicit test save.",
    ], options);
    assert.equal(search.ok, true);
    assert.equal(added.ok, true);
    assert.equal(search.effectiveUserId, "user-1@General");
    assert.equal(added.effectiveUserId, "user-1@General");
    assert.deepEqual(requests.map(({ url }) => new URL(url).pathname), [
      "/v1/memories/add", "/v1/memories/search", "/v1/memories/add",
    ]);
    assert.ok(requests.every(({ body }) => body.user_id === "user-1@General"));
    for (const index of [0, 2]) {
      assert.equal(requests[index].body.metadata.memorax_code_memory_scope, "general.v1");
      assert.equal(requests[index].body.metadata.memorax_code_workspace, "General");
    }
    // A later native hook can omit the default-chat hint after entering a child
    // directory. Its operational bridge must retain the session's General root.
    const nextPrompt = "continue from the child directory";
    await runtime.recordTurnStart({
      ...command(sessionId, provisionalTurnId(sessionId, nextPrompt), transcriptPath, nextPrompt),
      client: "workbuddy",
      cwd: nested,
    });
    const nextSearch = await runMemoryCli(["search", "--query", "general preference"], options);
    assert.equal(nextSearch.ok, true);
    assert.equal(nextSearch.effectiveUserId, "user-1@General");
    assert.equal(requests.at(-1).body.user_id, "user-1@General");
  } finally {
    runtime.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("CodeBuddy automatic Search returns basic context when explicitly enabled", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-codebuddy-search-"));
  const transcriptPath = join(home, "session.jsonl");
  await writeFile(transcriptPath, "");
  const sessionId = "search-retry";
  const prompt = "find prior context";
  const turnId = provisionalTurnId(sessionId, prompt);
  let searchCalls = 0;
  const runtime = createCodeBuddyMemoryHookRuntime({
    env: configuredEnv(home, {
      MEMORAX_CODE_CODEBUDDY_TRACE_ENABLED: "false",
      MEMORAX_CODE_MEMORY_RETRIEVAL_ENABLED: "true",
    }),
    automaticWriteback: () => ({ accepted: true }),
    claimQuotaNotice: async (_config, quota) => `${quota.featureCode}: ${quota.remaining}`,
    fetchImpl: async () => {
      searchCalls += 1;
      return new Response(JSON.stringify({
        success: true,
        data: {
          task_id: `search-${searchCalls}`,
          status: "completed",
          data: [{ id: "memory-1", memory: "basic retry context", score: 0.9, metadata: { memory_type: "core" } }],
          balances: [{
            product_code: "memory_api",
            feature_code: "memory_search",
            spec_key: "calls",
            quota_unit: "times",
            quota_limit: 10_000,
            reserved: 1,
            consumed: 0,
            remaining: 9_999,
          }],
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const start = command(sessionId, turnId, transcriptPath, prompt);
  try {
    const result = await runtime.recordTurnStart(start);
    assert.match(result.additionalContext, /basic retry context/);
    assert.equal(result.userNotice, "memory_search: 9999");
    assert.doesNotMatch(result.additionalContext, /memory_search/);
    assert.equal(searchCalls, 1);
  } finally {
    runtime.close();
  }
});

function provisionalTurnId(sessionId, prompt, boundary = 0) {
  return `${sessionId}:${boundary}:${createHash("sha256").update(prompt.trim()).digest("hex")}`;
}

function configuredEnv(home, overrides = {}) {
  return {
    MEMORAX_CODE_HOME: home,
    MEMORAX_CODE_MEMORY_RETRIEVAL_ENABLED: "false",
    MEMORAX_CODE_MEMORY_WRITEBACK_ENABLED: "true",
    MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_ENABLED: "false",
    MEMORAX_CODE_MEMORAX_ENDPOINT: "http://memorax.test",
    MEMORAX_CODE_MEMORAX_API_KEY: "secret",
    MEMORAX_CODE_MEMORAX_USER_ID: "user-1",
    ...overrides,
  };
}
