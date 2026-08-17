import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createOpenCodeMemoryHookRuntime } from "../../../dist/clients/opencode/memory-hook-runtime.js";
import { openCodeMessageTurn } from "../../../dist/clients/opencode/message-turn.js";
import { openCodeTracePaths } from "../../../dist/trace/config.js";
import {
  parseTurnStartCommand,
  parseWritebackCommand,
} from "../../../dist/memory/hook-command.js";

const TEST_WORKSPACE = fileURLToPath(new URL("../../..", import.meta.url));

test("OpenCode Hook commands keep a closed client-specific schema", () => {
  assert.equal(parseTurnStartCommand({
    version: 1,
    client: "opencode",
    sessionId: "session-1",
    userMessageId: "user-1",
    prompt: "Use the OpenCode SDK turn.",
    cwd: TEST_WORKSPACE,
  }).ok, true);
  assert.equal(parseWritebackCommand({
    version: 1,
    client: "opencode",
    sessionId: "session-1",
    userMessageId: "user-1",
    assistantMessageId: "assistant-1",
    messages: [],
  }).ok, true);
  assert.equal(parseTurnStartCommand({
    version: 1,
    client: "opencode",
    sessionId: "session-1",
    userMessageId: "user-1",
    prompt: "Do not accept another client's transcript field.",
    transcriptPath: "/tmp/transcript.jsonl",
  }).ok, false);
  assert.equal(parseWritebackCommand({
    version: 1,
    client: "opencode",
    sessionId: "session-1",
    userMessageId: "user-1",
    assistantMessageId: "assistant-1",
    messages: [],
    lastAssistantMessage: "Hook text is not OpenCode writeback authority.",
  }).ok, false);
});

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
      outcome: "interrupted",
    },
  });

  for (const [name, mutate, reason] of [
    ["parent mismatch", (messages) => { messages[1].info.parentID = "other-user"; }, "message_identity_mismatch"],
    ["session mismatch", (messages) => { messages[1].info.sessionID = "other-session"; }, "message_identity_mismatch"],
    ["incomplete assistant", (messages) => { delete messages[1].info.time.completed; }, "assistant_not_completed"],
    ["other assistant error", (messages) => { messages[1].info.error = { name: "UnknownError" }; }, "assistant_error"],
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
    assert.equal(JSON.parse(await readFile(paths.currentTurnPath, "utf8")).turn_state, "interrupted");
  } finally {
    runtime.close();
    await rm(memoraxCodeHome, { recursive: true, force: true });
  }
});

test("OpenCode runtime reuses retrieval, scope, and automatic writeback", async () => {
  const memoraxCodeHome = await mkdtemp(join(tmpdir(), "memorax-code-opencode-runtime-"));
  const requests = [];
  const runtime = createOpenCodeMemoryHookRuntime({
    memoraxCodeHome,
    env: {
      MEMORAX_CODE_HOME: memoraxCodeHome,
      MEMORAX_CODE_OPENCODE_TRACE_ENABLED: "false",
      MEMORAX_CODE_MEMORY_RETRIEVAL_ENABLED: "true",
      MEMORAX_CODE_MEMORY_WRITEBACK_ENABLED: "true",
      MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_ENABLED: "false",
      MEMORAX_CODE_MEMORAX_ENDPOINT: "http://memorax.test",
      MEMORAX_CODE_MEMORAX_API_KEY: "secret",
      MEMORAX_CODE_MEMORAX_USER_ID: "user-1",
    },
    fetchImpl: async (url, init) => {
      const request = { url: String(url), body: JSON.parse(init.body) };
      requests.push(request);
      const searching = request.url.endsWith("/v1/memories/search");
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
        data: { task_id: "writeback-1", status: "queued" },
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
  } finally {
    runtime.close();
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
        time: { created: 1 },
      },
      parts: [textPart("user-1", "OpenCode user prompt.")],
    },
    {
      info: {
        id: "assistant-1",
        sessionID: "session-1",
        role: "assistant",
        parentID: "user-1",
        time: { created: 2, completed: 3 },
      },
      parts: [textPart("assistant-1", "OpenCode assistant reply.")],
    },
  ];
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
