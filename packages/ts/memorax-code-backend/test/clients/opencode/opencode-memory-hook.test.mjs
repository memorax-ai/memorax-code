import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runMemoryCli } from "../../../dist/memory/cli.js";
import { createOpenCodeMemoryHookRuntime } from "../../../dist/clients/opencode/memory-hook-runtime.js";
import { openCodeCodingSessionTurn, openCodeMessageTurn } from "../../../dist/clients/opencode/message-turn.js";
import { openCodeTracePaths } from "../../../dist/trace/config.js";
import { createMemoryTurnCoordinator } from "../../../dist/memory/turn-coordinator.js";

const TEST_WORKSPACE = fileURLToPath(new URL("../../..", import.meta.url));

test("OpenCode SDK messages materialize only an exact completed normal turn", () => {
  const valid = openCodeMessageTurn(openCodeMessages(), {
    sessionId: "session-1",
    userMessageId: "user-1",
    assistantMessageId: "assistant-1",
  });
  assert.deepEqual(valid, {
    ok: true,
    turn: {
      sessionId: "session-1",
      userMessageId: "user-1",
      assistantMessageId: "assistant-1",
      userPrompt: "OpenCode user prompt.",
      assistantReply: "OpenCode assistant reply.",
      userTimestamp: 1_700_000_000_000,
      assistantTimestamp: 1_700_000_060_000,
      outcome: "completed",
    },
  });

  const withUserDiffSummary = openCodeMessages();
  withUserDiffSummary[0].info.summary = {
    title: "Turn changes",
    body: "Files changed during this turn",
    diffs: [],
  };
  assert.deepEqual(openCodeMessageTurn(withUserDiffSummary, {
    sessionId: "session-1",
    userMessageId: "user-1",
    assistantMessageId: "assistant-1",
  }), valid, "user diff summary remains eligible for writeback");

  const interrupted = openCodeMessages();
  interrupted[1].info.error = { name: "MessageAbortedError" };
  interrupted[1].parts = [];
  assert.deepEqual(openCodeMessageTurn(interrupted, {
    sessionId: "session-1",
    userMessageId: "user-1",
    assistantMessageId: "assistant-1",
  }), {
    ok: true,
    turn: {
      sessionId: "session-1",
      userMessageId: "user-1",
      assistantMessageId: "assistant-1",
      userPrompt: "OpenCode user prompt.",
      assistantReply: "",
      userTimestamp: 1_700_000_000_000,
      assistantTimestamp: 1_700_000_060_000,
      outcome: "interrupted",
    },
  });

  for (const [name, mutate, reason] of [
    ["parent mismatch", (messages) => { messages[1].info.parentID = "other-user"; }, "message_identity_mismatch"],
    ["session mismatch", (messages) => { messages[1].info.sessionID = "other-session"; }, "message_identity_mismatch"],
    ["incomplete assistant", (messages) => { delete messages[1].info.time.completed; }, "assistant_not_completed"],
    ["summary assistant", (messages) => { messages[1].info.summary = true; }, "summary_message"],
    ["compaction turn", (messages) => { messages[0].parts.push(part("compaction", "user-1")); }, "compaction_message"],
  ]) {
    const messages = openCodeMessages();
    mutate(messages);
    assert.deepEqual(openCodeMessageTurn(messages, {
      sessionId: "session-1",
      userMessageId: "user-1",
      assistantMessageId: "assistant-1",
    }), { ok: false, reason }, name);
  }

  const providerFailure = openCodeMessages();
  providerFailure[1].info.error = { name: "UnknownError" };
  providerFailure[1].parts = [];
  assert.deepEqual(openCodeMessageTurn(providerFailure, {
    sessionId: "session-1",
    userMessageId: "user-1",
    assistantMessageId: "assistant-1",
  }), {
    ok: true,
    turn: {
      sessionId: "session-1",
      userMessageId: "user-1",
      assistantMessageId: "assistant-1",
      userPrompt: "OpenCode user prompt.",
      assistantReply: "",
      userTimestamp: 1_700_000_000_000,
      assistantTimestamp: 1_700_000_060_000,
      outcome: "interrupted",
    },
  });
});

test("OpenCode SDK messages materialize a completed compaction continuation as the original turn", () => {
  const messages = compactedOpenCodeMessages();
  messages[1].parts = [
    textPart("assistant-tail", "Inspecting the implementation."),
    { ...part("tool", "assistant-tail"), tool: "read", callID: "read-1", state: { status: "completed", input: { filePath: "README.md" }, output: "read result" } },
    { ...part("reasoning", "assistant-tail"), text: "hidden reasoning" },
    { ...textPart("assistant-tail", "unrelated"), sessionID: "other-session" },
  ];
  assert.deepEqual(openCodeMessageTurn(messages, {
    sessionId: "session-1",
    userMessageId: "user-1",
    assistantMessageId: "assistant-final",
  }), {
    ok: true,
    turn: {
      sessionId: "session-1",
      userMessageId: "user-1",
      assistantMessageId: "assistant-final",
      userPrompt: "OpenCode user prompt.",
      assistantReply: "OpenCode final reply.",
      userTimestamp: 1_700_000_000_000,
      assistantTimestamp: 1_700_000_300_000,
      outcome: "completed",
    },
  });

  assert.deepEqual(openCodeMessageTurn(messages, {
    sessionId: "session-1",
    userMessageId: "user-1",
    assistantMessageId: "assistant-tail",
  }), { ok: false, reason: "message_identity_mismatch" });

  const collected = openCodeCodingSessionTurn(messages, {
    sessionId: "session-1", userMessageId: "user-1", assistantMessageId: "assistant-final", turnIndex: 3,
  });
  assert.equal(collected.ok, true);
  assert.equal(collected.turn.turnIndex, 3);
  assert.deepEqual(collected.turn.events, [
    { type: "user_message", content: "OpenCode user prompt." },
    { type: "assistant_message", phase: "progress", content: "Inspecting the implementation." },
    { type: "tool_call", tool: "read", callId: "read-1", arguments: '{"filePath":"README.md"}' },
    { type: "tool_result", callId: "read-1", status: "success", output: "read result" },
    { type: "assistant_message", phase: "final", content: "OpenCode final reply." },
  ]);

  for (const [name, mutate] of [
    ["unknown compaction tail", (input) => { input[2].parts[0].tail_start_id = "assistant-other"; }],
    ["unmarked synthetic continuation", (input) => { delete input[3].parts[0].metadata; }],
    ["unrelated final parent", (input) => { input[4].info.parentID = "user-other"; }],
  ]) {
    const invalid = compactedOpenCodeMessages();
    mutate(invalid);
    assert.deepEqual(openCodeMessageTurn(invalid, {
      sessionId: "session-1",
      userMessageId: "user-1",
      assistantMessageId: "assistant-final",
    }), { ok: false, reason: "message_identity_mismatch" }, name);
  }

  const interrupted = compactedOpenCodeMessages();
  interrupted[4].info.error = { name: "MessageAbortedError" };
  interrupted[4].parts = [];
  assert.deepEqual(openCodeMessageTurn(interrupted, {
    sessionId: "session-1",
    userMessageId: "user-1",
    assistantMessageId: "assistant-final",
  }), {
    ok: true,
    turn: {
      sessionId: "session-1",
      userMessageId: "user-1",
      assistantMessageId: "assistant-final",
      userPrompt: "OpenCode user prompt.",
      assistantReply: "",
      userTimestamp: 1_700_000_000_000,
      assistantTimestamp: 1_700_000_300_000,
      outcome: "interrupted",
    },
  });
});

test("OpenCode finalizes an explicit MessageAbortedError without writeback", async () => {
  const memoraxCodeHome = await mkdtemp(join(tmpdir(), "memorax-code-opencode-interrupted-"));
  const writebacks = [];
  const runtime = createOpenCodeMemoryHookRuntime({
    automaticWriteback: (input) => {
      writebacks.push(input);
      return { accepted: true };
    },
    memoraxCodeHome,
    env: {
      MEMORAX_CODE_HOME: memoraxCodeHome,
      MEMORAX_CODE_MEMORY_RETRIEVAL_ENABLED: "false",
      MEMORAX_CODE_OPENCODE_TRACE_ENABLED: "true",
    },
  });
  try {
    await runtime.recordTurnStart({
      version: 1,
      client: "opencode",
      sessionId: "session-1",
      userMessageId: "user-1",
      prompt: "OpenCode user prompt.",
      cwd: TEST_WORKSPACE,
      workspaceKind: "project",
    });

    const messages = openCodeMessages();
    messages[1].info.error = { name: "MessageAbortedError" };
    messages[1].parts = [];
    assert.deepEqual(await runtime.writeback({
      version: 1,
      client: "opencode",
      sessionId: "session-1",
      userMessageId: "user-1",
      assistantMessageId: "assistant-1",
      messages,
      cwd: TEST_WORKSPACE,
      workspaceKind: "project",
    }), { ok: true, scheduled: false, reason: "interrupted" });

    assert.equal(runtime.size(), 0);
    assert.equal(writebacks.length, 0);
    const paths = openCodeTracePaths(memoraxCodeHome);
    const events = (await readFile(paths.eventsJsonl("session-1"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(events.map(({ type, outcome }) => ({ type, outcome })), [
      { type: "turn_start", outcome: undefined },
      { type: "turn_end", outcome: "interrupted" },
    ]);
    assert.deepEqual(events.map(({ source }) => source), ["opencode-plugin", "opencode-plugin"]);
    assert.deepEqual(events.map(({ trace }) => trace.client), ["opencode", "opencode"]);
    assert.equal(JSON.parse(await readFile(paths.currentTurnPath, "utf8")).turn_state, "interrupted");
  } finally {
    runtime.close();
    await rm(memoraxCodeHome, { recursive: true, force: true });
  }
});

test("OpenCode runtime routes SDK content and carries write quota to the next prompt", async () => {
  const memoraxCodeHome = await mkdtemp(join(tmpdir(), "memorax-code-opencode-runtime-"));
  const requests = [];
  let searchCalls = 0;
  const runtime = createOpenCodeMemoryHookRuntime({
    memoraxCodeHome,
    captureCodingTurns: true,
    env: {
      MEMORAX_CODE_HOME: memoraxCodeHome,
      MEMORAX_CODE_OPENCODE_TRACE_ENABLED: "false",
      MEMORAX_CODE_MEMORY_RETRIEVAL_ENABLED: "true",
      MEMORAX_CODE_MEMORY_WRITEBACK_ENABLED: "true",
      MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_ENABLED: "false",
      MEMORAX_CODE_CODING_SESSIONS_ENABLED: "true",
      MEMORAX_CODE_MEMORAX_ENDPOINT: "http://memorax.test",
      MEMORAX_CODE_MEMORAX_API_KEY: "secret",
      MEMORAX_CODE_MEMORAX_USER_ID: "user-1",
    },
    claimQuotaNotice: async (_config, quota) => `${quota.featureCode}: ${quota.remaining}`,
    fetchImpl: async (url, init) => {
      const request = { url: String(url), body: JSON.parse(init.body) };
      requests.push(request);
      const searching = request.url.endsWith("/v1/memories/search");
      if (searching) searchCalls += 1;
      return new Response(JSON.stringify(searching ? {
        success: true,
        data: {
          task_id: "search-1",
          status: "completed",
          data: [{
            id: "memory-1",
            memory: "OpenCode can reuse the shared retrieval runtime.",
            score: 0.9,
            metadata: { memory_type: "core" },
          }],
        },
      } : {
        success: true,
        data: {
          task_id: "writeback-1",
          status: "queued",
          balances: [quotaBalance("memory_write", 9)],
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  try {
    const start = await runtime.recordTurnStart({
      version: 1,
      client: "opencode",
      sessionId: "session-1",
      userMessageId: "user-1",
      prompt: "OpenCode user prompt.",
      cwd: TEST_WORKSPACE,
      workspaceKind: "project",
    });
    assert.match(start.additionalContext, /shared retrieval runtime/);

    assert.deepEqual(await runtime.writeback({
      version: 1,
      client: "opencode",
      sessionId: "session-1",
      userMessageId: "user-1",
      assistantMessageId: "assistant-1",
      turnIndex: 1,
      messages: openCodeMessages(),
      cwd: TEST_WORKSPACE,
      workspaceKind: "project",
    }), { ok: true, scheduled: true });
    await waitFor(() => requests.length === 2);
    assert.deepEqual(requests.map((request) => new URL(request.url).pathname), [
      "/v1/memories/search",
      "/v1/memories/add",
    ]);
    assert.deepEqual(requests[1].body.messages.map(({ role, content }) => ({ role, content })), [
      { role: "user", content: "OpenCode user prompt." },
      { role: "assistant", content: "OpenCode assistant reply." },
    ]);
    assert.deepEqual(requests[1].body.messages.map(({ timestamp }) => timestamp), [
      1_700_000_000_000,
      1_700_000_060_000,
    ]);
    assert.equal(requests[1].body.coding_turns[0].client, "opencode");
    assert.equal(requests[1].body.coding_turns[0].turn_id, "user-1");
    assert.equal(requests[1].body.coding_turns[0].turn_index, 1);
    assert.deepEqual(requests[1].body.coding_turns[0].events.map(({ type }) => type), ["user_message", "assistant_message"]);

    assert.deepEqual(await runtime.recordTurnStart({
      version: 1,
      client: "opencode",
      sessionId: "session-1",
      userMessageId: "user-1",
      prompt: "OpenCode user prompt.",
      cwd: TEST_WORKSPACE,
      workspaceKind: "project",
    }), { ok: true, repoMemoryWorktree: start.repoMemoryWorktree });
    assert.equal(searchCalls, 1);

    const next = await runtime.recordTurnStart({
      version: 1,
      client: "opencode",
      sessionId: "session-1",
      userMessageId: "user-2",
      prompt: "OpenCode second prompt.",
      cwd: TEST_WORKSPACE,
      workspaceKind: "project",
    });
    assert.equal(next.userNotice, "memory_write: 9");
    assert.doesNotMatch(next.additionalContext, /memory_write/);
  } finally {
    runtime.close();
    await rm(memoraxCodeHome, { recursive: true, force: true });
  }
});

test("OpenCode default chat shares General across automatic Add and nested Skill commands", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-opencode-general-"));
  const workspace = join(root, "Documents", "Default Project");
  const nested = join(workspace, "work");
  await mkdir(nested, { recursive: true });
  const env = {
    MEMORAX_CODE_HOME: join(root, "home"),
    MEMORAX_CODE_OPENCODE_TRACE_ENABLED: "false",
    MEMORAX_CODE_MEMORY_RETRIEVAL_ENABLED: "false",
    MEMORAX_CODE_MEMORY_WRITEBACK_ENABLED: "true",
    MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_ENABLED: "false",
    MEMORAX_CODE_MEMORAX_ENDPOINT: "http://memorax.test",
    MEMORAX_CODE_MEMORAX_API_KEY: "secret",
    MEMORAX_CODE_MEMORAX_USER_ID: "user-1",
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
  const runtime = createOpenCodeMemoryHookRuntime({ env, fetchImpl });
  const command = {
    version: 1,
    client: "opencode",
    sessionId: "session-1",
    userMessageId: "user-1",
    cwd: workspace,
    workspaceKind: "projectless",
  };
  try {
    assert.deepEqual(await runtime.recordTurnStart({ ...command, prompt: "OpenCode user prompt." }), { ok: true });
    assert.deepEqual(await runtime.writeback({
      ...command,
      assistantMessageId: "assistant-1",
      messages: openCodeMessages(),
    }), { ok: true, scheduled: true });
    await waitFor(() => requests.length === 1);
    assert.deepEqual(requests[0].body.messages.map(({ role, content }) => ({ role, content })), [
      { role: "user", content: "OpenCode user prompt." },
      { role: "assistant", content: "OpenCode assistant reply." },
    ]);
    const options = {
      cwd: nested,
      env: {
        ...env,
        MEMORAX_CODE_MEMORY_CLI_TRACE_CLIENT: "opencode",
        MEMORAX_CODE_MEMORY_CLI_TRACE_SESSION_ID: "session-1",
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
  } finally {
    runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenCode SDK completion requires a prior scope binding but not unexpired turn metadata", async () => {
  const memoraxCodeHome = await mkdtemp(join(tmpdir(), "memorax-code-opencode-bound-scope-"));
  const writebacks = [];
  let now = Date.now();
  const turnCoordinator = createMemoryTurnCoordinator({
    now: () => now,
    ttlMs: 1,
    automaticWriteback: (input) => { writebacks.push(input); return { accepted: true }; },
  });
  const runtime = createOpenCodeMemoryHookRuntime({
    memoraxCodeHome,
    now: () => now,
    turnCoordinator,
    env: {
      MEMORAX_CODE_HOME: memoraxCodeHome,
      MEMORAX_CODE_OPENCODE_TRACE_ENABLED: "false",
      MEMORAX_CODE_MEMORY_RETRIEVAL_ENABLED: "false",
      MEMORAX_CODE_MEMORAX_ENDPOINT: "http://memorax.test",
      MEMORAX_CODE_MEMORAX_API_KEY: "secret",
      MEMORAX_CODE_MEMORAX_USER_ID: "user-1",
    },
  });
  const command = {
    version: 1,
    client: "opencode",
    sessionId: "session-1",
    userMessageId: "user-1",
    assistantMessageId: "assistant-final",
    messages: compactedOpenCodeMessages(),
    cwd: TEST_WORKSPACE,
    workspaceKind: "project",
  };
  try {
    assert.deepEqual(await runtime.writeback(command), {
      ok: true, scheduled: false, reason: "workspace_scope_unavailable",
    });
    assert.deepEqual(writebacks, []);
    await runtime.recordTurnStart({
      version: 1,
      client: "opencode",
      sessionId: command.sessionId,
      userMessageId: command.userMessageId,
      prompt: "The Hook prompt is not writeback content authority.",
      cwd: TEST_WORKSPACE,
      workspaceKind: "project",
    });
    assert.equal(runtime.size(), 1);
    now += 10;
    turnCoordinator.pruneExpired();
    assert.equal(runtime.size(), 0);
    assert.deepEqual(await runtime.writeback(command), { ok: true, scheduled: true });
    assert.equal(runtime.size(), 0);
    assert.equal(writebacks.length, 1);
    assert.equal(writebacks[0].client, "opencode");
    assert.equal(writebacks[0].userText, "OpenCode user prompt.");
    assert.equal(writebacks[0].assistantText, "OpenCode final reply.");
    assert.equal(writebacks[0].userTimestamp, 1_700_000_000_000);
    assert.equal(writebacks[0].assistantTimestamp, 1_700_000_300_000);
    assert.equal(writebacks[0].traceContext.turnId, "user-1");
    assert.equal(writebacks[0].memoryObservabilitySource, "opencode_plugin_writeback");
  } finally {
    runtime.close();
    turnCoordinator.close();
    await rm(memoraxCodeHome, { recursive: true, force: true });
  }
});

function openCodeMessages() {
  return [
    {
      info: {
        id: "user-1",
        sessionID: "session-1",
        role: "user",
        time: { created: 1_700_000_000_000 },
      },
      parts: [textPart("user-1", "OpenCode user prompt.")],
    },
    {
      info: {
        id: "assistant-1",
        sessionID: "session-1",
        role: "assistant",
        parentID: "user-1",
        time: { created: 1_700_000_001_000, completed: 1_700_000_060_000 },
      },
      parts: [textPart("assistant-1", "OpenCode assistant reply.")],
    },
  ];
}

function compactedOpenCodeMessages() {
  return [
    openCodeMessages()[0],
    {
      info: {
        id: "assistant-tail",
        sessionID: "session-1",
        role: "assistant",
        parentID: "user-1",
        time: { created: 1_700_000_001_000, completed: 1_700_000_060_000 },
      },
      parts: [],
    },
    {
      info: {
        id: "user-compaction",
        sessionID: "session-1",
        role: "user",
        time: { created: 1_700_000_120_000 },
      },
      parts: [{
        ...part("compaction", "user-compaction"),
        auto: true,
        tail_start_id: "assistant-tail",
      }],
    },
    {
      info: {
        id: "user-continuation",
        sessionID: "session-1",
        role: "user",
        time: { created: 1_700_000_180_000 },
      },
      parts: [{
        ...textPart("user-continuation", "Continue."),
        synthetic: true,
        metadata: { compaction_continue: true },
      }],
    },
    {
      info: {
        id: "assistant-final",
        sessionID: "session-1",
        role: "assistant",
        parentID: "user-continuation",
        time: { created: 1_700_000_181_000, completed: 1_700_000_300_000 },
      },
      parts: [textPart("assistant-final", "OpenCode final reply.")],
    },
  ];
}

function quotaBalance(featureCode, remaining) {
  return {
    product_code: "memory_api",
    feature_code: featureCode,
    spec_key: "calls",
    quota_unit: "times",
    quota_limit: 100,
    reserved: 0,
    consumed: 0,
    remaining,
  };
}

function textPart(messageID, text) {
  return {
    id: `${messageID}-text`,
    sessionID: "session-1",
    messageID,
    type: "text",
    text,
  };
}

function part(type, messageID) {
  return {
    id: `${messageID}-${type}`,
    sessionID: "session-1",
    messageID,
    type,
  };
}

async function waitFor(predicate) {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for OpenCode writeback");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
