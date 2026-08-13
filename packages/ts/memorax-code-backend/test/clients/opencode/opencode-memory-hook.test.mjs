import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createOpenCodeMemoryHookRuntime } from "../../../dist/clients/opencode/memory-hook-runtime.js";
import { openCodeMessageTurn } from "../../../dist/clients/opencode/message-turn.js";
import { openCodeTracePaths } from "../../../dist/trace/config.js";

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
  interrupted[1].info.error = {
    name: "MessageAbortedError",
    data: { message: "The user interrupted this Turn." },
  };
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
      assistantReply: "OpenCode assistant reply.",
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

test("OpenCode finalizes only an explicit MessageAbortedError without writeback", async () => {
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
    assert.equal(runtime.size(), 1);

    const messages = openCodeMessages();
    messages[1].info.error = {
      name: "MessageAbortedError",
      data: { message: "The user interrupted this Turn." },
    };
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
    assert.equal(
      JSON.parse(await readFile(paths.sessionCurrentTurnPath("session-1"), "utf8")).turn_state,
      "interrupted",
    );
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
