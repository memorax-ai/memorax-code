import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createOpenCodeMemoryHookRuntime } from "../../../dist/clients/opencode/memory-hook-runtime.js";
import {
  parseTurnStartCommand,
  parseWritebackCommand,
} from "../../../dist/memory/hook-command.js";

const TEST_WORKSPACE = fileURLToPath(new URL("../../..", import.meta.url));

test("OpenCode turn-start commands keep a closed client-specific schema", () => {
  assert.equal(parseTurnStartCommand({
    version: 1,
    client: "opencode",
    sessionId: "session-1",
    userMessageId: "user-1",
    prompt: "Use the OpenCode prompt.",
    cwd: TEST_WORKSPACE,
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
  }).ok, false);
});

test("OpenCode runtime reuses repository scope and automatic retrieval", async () => {
  const memoraxCodeHome = await mkdtemp(join(tmpdir(), "memorax-code-opencode-runtime-"));
  const requests = [];
  const runtime = createOpenCodeMemoryHookRuntime({
    memoraxCodeHome,
    env: {
      MEMORAX_CODE_HOME: memoraxCodeHome,
      MEMORAX_CODE_OPENCODE_TRACE_ENABLED: "false",
      MEMORAX_CODE_MEMORY_RETRIEVAL_ENABLED: "true",
      MEMORAX_CODE_MEMORAX_ENDPOINT: "http://memorax.test",
      MEMORAX_CODE_MEMORAX_API_KEY: "secret",
      MEMORAX_CODE_MEMORAX_USER_ID: "user-1",
    },
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response(JSON.stringify({
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
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  try {
    const command = {
      version: 1,
      client: "opencode",
      sessionId: "session-1",
      userMessageId: "user-1",
      prompt: "OpenCode user prompt.",
      cwd: TEST_WORKSPACE,
      workspaceKind: "project",
    };
    const start = await runtime.recordTurnStart(command);
    assert.match(start.additionalContext, /shared retrieval runtime/);

    const duplicate = await runtime.recordTurnStart(command);
    assert.equal(duplicate.additionalContext, undefined);
    assert.equal(requests.length, 1);
    assert.equal(new URL(requests[0].url).pathname, "/v1/memories/search");
  } finally {
    runtime.close();
    await rm(memoraxCodeHome, { recursive: true, force: true });
  }
});
