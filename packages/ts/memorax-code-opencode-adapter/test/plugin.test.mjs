import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter } from "node:path";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createMemoraxOpenCodePlugin } from "../src/plugin.mjs";

test("chat.message retrieves memory and injects it into the system prompt", async () => {
  const requests = [];
  const plugin = createMemoraxOpenCodePlugin({
    backendConnection: { url: "http://127.0.0.1:8787", token: "test-token" },
    fetchImpl: responseSequence(requests, [{ ok: true, additionalContext: "Remember the repository boundary." }]),
  });
  const hooks = await plugin(pluginInput());
  const output = {
    message: { id: "user-1", system: "Existing system context" },
    parts: [
      { type: "text", text: "First prompt line" },
      { type: "text", text: "ignored", synthetic: true },
      { type: "text", text: "Second prompt line" },
    ],
  };

  await hooks["chat.message"]({ sessionID: "session-1" }, output);

  assert.equal(output.message.system, "Existing system context\n\nRemember the repository boundary.");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "http://127.0.0.1:8787/memory/turn-start");
  assert.equal(requests[0].options.headers["x-memorax-code-backend-token"], "test-token");
  assert.deepEqual(requests[0].body, {
    version: 1,
    client: "opencode",
    sessionId: "session-1",
    userMessageId: "user-1",
    prompt: "First prompt line\n\nSecond prompt line",
    cwd: "/repo/worktree",
    workspaceKind: "project",
  });
});

test("chat.message does not mistake a user diff summary for compaction", async () => {
  const requests = [];
  const plugin = createMemoraxOpenCodePlugin({
    backendConnection: { url: "http://127.0.0.1:8787" },
    fetchImpl: responseSequence(requests, [{ ok: true }]),
  });
  const hooks = await plugin(pluginInput());
  const output = {
    message: {
      id: "user-with-summary",
      summary: { title: "Edited files", body: "One change", diffs: [] },
    },
    parts: [{ type: "text", text: "Keep recalling memory." }],
  };

  await hooks["chat.message"]({ sessionID: "session-with-summary" }, output);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.prompt, "Keep recalling memory.");
});

test("chat.message ignores compaction and synthetic-only messages", async () => {
  const requests = [];
  const plugin = createMemoraxOpenCodePlugin({
    backendConnection: { url: "http://127.0.0.1:8787" },
    fetchImpl: responseSequence(requests, []),
  });
  const hooks = await plugin(pluginInput());

  await hooks["chat.message"](
    { sessionID: "session-compaction" },
    { message: { id: "user-compaction" }, parts: [{ type: "compaction", auto: true }] },
  );
  await hooks["chat.message"](
    { sessionID: "session-synthetic" },
    { message: { id: "user-synthetic" }, parts: [{ type: "text", text: "generated", synthetic: true }] },
  );

  assert.equal(requests.length, 0);
});

test("shell.env overwrites the OpenCode session identity and prepends the managed CLI path", async () => {
  const cliBinDir = "/memorax/bin";
  const plugin = createMemoraxOpenCodePlugin({ cliBinDir });
  const hooks = await plugin(pluginInput());
  const output = {
    env: {
      MEMORAX_CODE_MEMORY_CLI_TRACE_CLIENT: "codex",
      MEMORAX_CODE_MEMORY_CLI_TRACE_SESSION_ID: "old-session",
      MEMORAX_CODE_MEMORY_CLI_SESSION_ID: "old-session",
      PATH: ["/usr/bin", "/bin"].join(delimiter),
    },
  };

  await hooks["shell.env"]({ sessionID: "session-2" }, output);

  assert.equal(output.env.MEMORAX_CODE_MEMORY_CLI_TRACE_CLIENT, "opencode");
  assert.equal(output.env.MEMORAX_CODE_MEMORY_CLI_TRACE_SESSION_ID, "session-2");
  assert.equal(output.env.MEMORAX_CODE_MEMORY_CLI_SESSION_ID, "session-2");
  assert.equal(output.env.PATH, [cliBinDir, "/usr/bin", "/bin"].join(delimiter));
});

test("a loaded plugin follows the managed enabled state without an OpenCode restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-opencode-plugin-state-"));
  const statePath = join(root, "state.json");
  const requests = [];
  try {
    await writeState(false);
    const plugin = createMemoraxOpenCodePlugin({
      statePath,
      backendConnection: { url: "http://127.0.0.1:8787" },
      fetchImpl: responseSequence(requests, [{ ok: true }]),
    });
    const hooks = await plugin(pluginInput());
    const disabledOutput = { message: { id: "user-disabled" }, parts: [{ type: "text", text: "ignored" }] };
    await hooks["chat.message"]({ sessionID: "session-disabled" }, disabledOutput);
    assert.equal(requests.length, 0);

    await writeState(true);
    const enabledOutput = { message: { id: "user-enabled" }, parts: [{ type: "text", text: "remember" }] };
    await hooks["chat.message"]({ sessionID: "session-enabled" }, enabledOutput);
    assert.equal(requests.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  async function writeState(enabled) {
    await mkdir(root, { recursive: true });
    await writeFile(statePath, JSON.stringify({
      version: 1,
      runtime: "opencode",
      integration: "plugin",
      enabled,
    }));
  }
});

test("idle reads authoritative SDK messages and dispose drains the pending writeback", async () => {
  const requests = [];
  let releaseMessages;
  const messagesReady = new Promise((resolve) => {
    releaseMessages = resolve;
  });
  const clientCalls = [];
  const input = pluginInput({
    client: {
      session: {
        async messages(options) {
          clientCalls.push(options);
          await messagesReady;
          return {
            data: [
              {
                info: { id: "user-3", role: "user", sessionID: "session-3" },
                parts: [{ type: "text", text: "Implement the adapter." }],
              },
              {
                info: {
                  id: "assistant-3",
                  role: "assistant",
                  sessionID: "session-3",
                  parentID: "user-3",
                  time: { completed: 123 },
                },
                parts: [{ type: "text", text: "Implemented." }],
              },
            ],
          };
        },
      },
    },
  });
  const plugin = createMemoraxOpenCodePlugin({
    backendConnection: { url: "http://127.0.0.1:8787" },
    fetchImpl: responseSequence(requests, [{ ok: true }, { ok: true }]),
  });
  const hooks = await plugin(input);
  await hooks["chat.message"](
    { sessionID: "session-3" },
    { message: { id: "user-3" }, parts: [{ type: "text", text: "Implement the adapter." }] },
  );

  hooks.event({
    event: {
      type: "session.status",
      properties: { sessionID: "session-3", status: { type: "idle" } },
    },
  });
  let disposed = false;
  const disposing = hooks.dispose().then(() => {
    disposed = true;
  });
  await delay(10);
  assert.equal(disposed, false);

  releaseMessages();
  await disposing;

  assert.deepEqual(clientCalls, [{
    path: { id: "session-3" },
    query: { directory: "/repo/directory" },
    throwOnError: true,
  }]);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].url, "http://127.0.0.1:8787/memory/writeback");
  assert.deepEqual(requests[1].body, {
    version: 1,
    client: "opencode",
    sessionId: "session-3",
    userMessageId: "user-3",
    assistantMessageId: "assistant-3",
    messages: [
      {
        info: { id: "user-3", role: "user", sessionID: "session-3" },
        parts: [{ type: "text", text: "Implement the adapter." }],
      },
      {
        info: {
          id: "assistant-3",
          role: "assistant",
          sessionID: "session-3",
          parentID: "user-3",
          time: { completed: 123 },
        },
        parts: [{ type: "text", text: "Implemented." }],
      },
    ],
    cwd: "/repo/worktree",
    workspaceKind: "project",
  });
});

function pluginInput(overrides = {}) {
  return {
    client: { session: { async messages() { return { data: [] }; } } },
    project: { vcs: "git" },
    directory: "/repo/directory",
    worktree: "/repo/worktree",
    ...overrides,
  };
}

function responseSequence(requests, responses) {
  return async (url, options) => {
    requests.push({ url: String(url), options, body: JSON.parse(options.body) });
    const body = responses.shift() ?? { ok: true };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}
