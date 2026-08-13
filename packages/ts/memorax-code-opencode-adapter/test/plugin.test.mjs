import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createMemoraxOpenCodePlugin } from "../src/plugin.mjs";
import { OPENCODE_REPO_MEMORY_AGENT } from "../src/repo-memory-server-runner.mjs";

test("a real prompt retrieves context and idle writes the exact SDK turn", async () => {
  const requests = [];
  const clientCalls = [];
  let releaseMessages;
  const messagesReady = new Promise((resolve) => { releaseMessages = resolve; });
  const exactUser = {
    info: { id: "user-1", role: "user", sessionID: "session-1" },
    parts: [{ type: "text", text: "Implement the adapter." }],
  };
  const exactAssistant = {
    info: {
      id: "assistant-1",
      role: "assistant",
      sessionID: "session-1",
      parentID: "user-1",
      time: { completed: 123 },
    },
    parts: [{ type: "text", text: "Implemented." }],
  };
  const messages = [
    { info: { id: "other-user", role: "user", sessionID: "session-1" }, parts: [] },
    exactUser,
    {
      info: {
        id: "wrong-parent",
        role: "assistant",
        sessionID: "session-1",
        parentID: "other-user",
        time: { completed: 999 },
      },
      parts: [{ type: "text", text: "Wrong turn." }],
    },
    exactAssistant,
  ];
  const plugin = createPluginWithoutReminders({
    backendConnection: { url: "http://127.0.0.1:8787", token: "test-token" },
    fetchImpl: responseSequence(requests, [
      { ok: true, additionalContext: "Remember the repository boundary." },
      { ok: true },
    ]),
  });
  const hooks = await plugin(pluginInput({
    client: {
      session: {
        async messages(options) {
          clientCalls.push(options);
          await messagesReady;
          return { data: messages };
        },
      },
    },
  }));
  const output = promptOutput("user-1", "Implement the adapter.", "Existing context");

  await hooks["chat.message"]({ sessionID: "session-1" }, output);
  hooks.event({
    event: {
      type: "session.status",
      properties: { sessionID: "session-1", status: { type: "idle" } },
    },
  });
  const disposing = hooks.dispose();
  assert.equal(await Promise.race([disposing.then(() => true), delay(10, false)]), false);
  releaseMessages();
  await disposing;

  assert.equal(output.message.system, "Existing context\n\nRemember the repository boundary.");
  assert.deepEqual(requests.map((request) => new URL(request.url).pathname), [
    "/memory/turn-start",
    "/memory/writeback",
  ]);
  assert.equal(requests[0].options.headers["x-memorax-code-backend-token"], "test-token");
  assert.deepEqual(requests[0].body, {
    version: 1,
    client: "opencode",
    sessionId: "session-1",
    userMessageId: "user-1",
    prompt: "Implement the adapter.",
    cwd: "/repo/worktree",
    workspaceKind: "project",
  });
  assert.deepEqual(clientCalls, [{
    path: { id: "session-1" },
    query: { directory: "/repo/directory" },
    throwOnError: true,
  }]);
  assert.deepEqual(requests[1].body.messages, [exactUser, exactAssistant]);
});

test("chat.message starts missing Repo Memory for the Backend-authorized worktree", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-opencode-auto-build-"));
  const backendRepo = join(root, "backend-repo");
  const pluginWorktree = join(root, "plugin-worktree");
  const memoraxCodeHome = join(root, "memorax-code-home");
  const openCodeConfigDir = join(root, "opencode-config");
  const jobLog = join(root, "repo-memory-job.json");
  let hooks;
  try {
    await Promise.all([
      mkdir(backendRepo, { recursive: true }),
      mkdir(pluginWorktree, { recursive: true }),
      mkdir(join(openCodeConfigDir, "hooks"), { recursive: true }),
    ]);
    await writeFile(join(openCodeConfigDir, "hooks", "repo-memory-job.mjs"), [
      'import { writeFileSync } from "node:fs";',
      `writeFileSync(${JSON.stringify(jobLog)}, JSON.stringify({`,
      "  args: process.argv.slice(2),",
      "  cwd: process.cwd(),",
      "  memoraxCodeHome: process.env.MEMORAX_CODE_HOME,",
      "  parentSessionId: process.env.MEMORAX_CODE_MEMORY_CLI_SESSION_ID,",
      "  serverUrl: process.env.MEMORAX_CODE_OPENCODE_SERVER_URL,",
      "}));",
      "",
    ].join("\n"));
    const plugin = createPluginWithoutReminders({
      memoraxCodeHome,
      openCodeConfigDir,
      backendConnection: { url: "http://127.0.0.1:8787" },
      fetchImpl: responseSequence([], [{ ok: true, repoMemoryWorktree: backendRepo }]),
    });
    hooks = await plugin(pluginInput({ directory: pluginWorktree, worktree: pluginWorktree }));

    await hooks["chat.message"](
      { sessionID: "session-auto-build" },
      promptOutput("user-auto-build", "Build missing Repo Memory."),
    );

    await waitForFile(jobLog);
    assert.deepEqual(JSON.parse(await readFile(jobLog, "utf8")), {
      args: ["maintain", "--repo", backendRepo],
      cwd: await realpath(backendRepo),
      memoraxCodeHome,
      parentSessionId: "session-auto-build",
      serverUrl: "http://127.0.0.1:4096/",
    });
  } finally {
    await hooks?.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("managed plugin starts the Backend once and bounds prompt waiting", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-opencode-backend-start-"));
  const statePath = join(root, "state.json");
  const callsPath = join(root, "lifecycle-calls.jsonl");
  const startedPath = join(root, "lifecycle-started");
  const releasePath = join(root, "lifecycle-release");
  const memoraxCodeCommand = join(root, "memorax-code.mjs");
  const requests = [];
  let hooks;
  try {
    await writeFile(statePath, JSON.stringify({
      version: 1,
      runtime: "opencode",
      integration: "plugin",
      enabled: true,
    }));
    await writeFile(memoraxCodeCommand, [
      'import { appendFileSync, existsSync, writeFileSync } from "node:fs";',
      `appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(process.argv.slice(2)) + "\\n");`,
      `writeFileSync(${JSON.stringify(startedPath)}, "started\\n");`,
      `while (!existsSync(${JSON.stringify(releasePath)})) await new Promise((resolve) => setTimeout(resolve, 5));`,
    ].join("\n"));
    const plugin = createMemoraxOpenCodePlugin({
      statePath,
      memoraxCodeHome: join(root, "memorax-code-home"),
      openCodeConfigDir: join(root, "opencode-config"),
      memoraxCodeCommand,
      backendConnection: { url: "http://127.0.0.1:9", source: "option" },
      healthTimeoutValue: "50",
      startTimeoutValue: "1000",
      backendPromptWaitTimeoutValue: "100",
      fetchImpl: responseSequence(requests, [{ ok: true }]),
      memorySkillReminderEvaluator: async () => ({ additionalContext: "Local reminder context." }),
    });
    hooks = await plugin(pluginInput());
    await waitForFile(startedPath);

    const first = promptOutput("user-start-1", "First prompt");
    const second = promptOutput("user-start-2", "Second prompt");
    await Promise.race([
      Promise.all([
        hooks["chat.message"]({ sessionID: "session-start-1" }, first),
        hooks["chat.message"]({ sessionID: "session-start-2" }, second),
      ]),
      delay(400).then(() => { throw new Error("Backend prompt wait was not bounded"); }),
    ]);
    assert.equal(requests.length, 0);
    assert.equal(first.message.system, "Local reminder context.");
    assert.equal(second.message.system, "Local reminder context.");
    assert.equal((await readFile(callsPath, "utf8")).trim().split("\n").length, 1);

    await writeFile(releasePath, "release\n");
    await hooks.dispose();
    await hooks["chat.message"](
      { sessionID: "session-start-3" },
      promptOutput("user-start-3", "Recovered prompt"),
    );
    assert.equal(requests.length, 1);
  } finally {
    await writeFile(releasePath, "release\n").catch(() => undefined);
    await hooks?.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("only real user messages enter normal prompt handling", async () => {
  const requests = [];
  let reminderCalls = 0;
  const plugin = createMemoraxOpenCodePlugin({
    backendConnection: { url: "http://127.0.0.1:8787" },
    fetchImpl: responseSequence(requests, [{ ok: true }]),
    memorySkillReminderEvaluator: async () => {
      reminderCalls += 1;
      return { additionalContext: "Reminder." };
    },
  });
  const hooks = await plugin(pluginInput());

  await hooks["chat.message"](
    { sessionID: "compaction" },
    { message: { id: "generated-compaction" }, parts: [{ type: "compaction", auto: true }] },
  );
  await hooks["chat.message"](
    { sessionID: "synthetic" },
    { message: { id: "generated-synthetic" }, parts: [{ type: "text", text: "generated", synthetic: true }] },
  );
  await hooks["chat.message"](
    { sessionID: "repo-memory", agent: OPENCODE_REPO_MEMORY_AGENT },
    promptOutput("repo-memory-user", "Maintain Repo Memory"),
  );
  const output = {
    message: { id: "real-user", summary: { title: "Edited files", diffs: [] } },
    parts: [{ type: "text", text: "Recall memory." }],
  };
  await hooks["chat.message"]({ sessionID: "real-session" }, output);

  assert.equal(reminderCalls, 1);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.prompt, "Recall memory.");
  assert.equal(output.message.system, "Reminder.");
});

test("config registers an isolated Repo Memory subagent without replacing other agents", async () => {
  const hooks = await createPluginWithoutReminders()(pluginInput());
  const config = { agent: { existing: { description: "Keep me." } } };

  await hooks.config(config);

  assert.deepEqual(config.agent.existing, { description: "Keep me." });
  assert.equal(config.agent[OPENCODE_REPO_MEMORY_AGENT].mode, "subagent");
  assert.equal(config.agent[OPENCODE_REPO_MEMORY_AGENT].permission.edit, "allow");
  assert.equal(config.agent[OPENCODE_REPO_MEMORY_AGENT].permission.bash, "allow");
});

test("OpenCode forwards first-prompt and post-compaction reminders once", async () => {
  const memoraxCodeHome = await mkdtemp(join(tmpdir(), "memorax-code-opencode-reminder-"));
  const requests = [];
  let hooks;
  try {
    const plugin = createMemoraxOpenCodePlugin({
      memoraxCodeHome,
      backendConnection: { url: "http://127.0.0.1:8787" },
      fetchImpl: memoryResponse(requests),
    });
    hooks = await plugin(pluginInput());

    const first = promptOutput("user-reminder-1", "First prompt");
    await hooks["chat.message"]({ sessionID: "session-reminder" }, first);
    hooks.event({
      event: {
        type: "session.compacted",
        properties: { sessionID: "session-reminder" },
      },
    });
    const second = promptOutput("user-reminder-2", "After compaction");
    await hooks["chat.message"]({ sessionID: "session-reminder" }, second);
    const third = promptOutput("user-reminder-3", "Later prompt");
    await hooks["chat.message"]({ sessionID: "session-reminder" }, third);
    await hooks.dispose();

    assert.match(first.message.system, /MemoraX Code reminder: proactively invoke/);
    assert.match(second.message.system, /MemoraX Code personal-memory reminder/);
    assert.equal(third.message.system, "Retrieved user-reminder-3.");
    const reminderRequests = requests.filter((request) => request.path === "/memory/skill-reminder");
    assert.deepEqual(reminderRequests.map((request) => request.body.triggers), [
      ["cadence"],
      ["post_compaction"],
    ]);
    assert.equal(Object.hasOwn(reminderRequests[0].body, "transcriptPath"), false);
  } finally {
    await hooks?.dispose();
    await rm(memoraxCodeHome, { recursive: true, force: true });
  }
});

test("shell.env binds OpenCode identity, server, and managed CLI path", async () => {
  const cliBinDir = "/memorax/bin";
  const hooks = await createPluginWithoutReminders({ cliBinDir })(pluginInput());
  const output = {
    env: {
      MEMORAX_CODE_MEMORY_CLI_TRACE_CLIENT: "codex",
      MEMORAX_CODE_MEMORY_CLI_TRACE_SESSION_ID: "old-session",
      MEMORAX_CODE_MEMORY_CLI_SESSION_ID: "old-session",
      MEMORAX_CODE_OPENCODE_SERVER_URL: "http://127.0.0.1:1/",
      PATH: ["/usr/bin", "/bin"].join(delimiter),
    },
  };

  await hooks["shell.env"]({ sessionID: "session-2" }, output);

  assert.equal(output.env.MEMORAX_CODE_MEMORY_CLI_TRACE_CLIENT, "opencode");
  assert.equal(output.env.MEMORAX_CODE_MEMORY_CLI_TRACE_SESSION_ID, "session-2");
  assert.equal(output.env.MEMORAX_CODE_MEMORY_CLI_SESSION_ID, "session-2");
  assert.equal(output.env.MEMORAX_CODE_OPENCODE_SERVER_URL, "http://127.0.0.1:4096/");
  assert.equal(output.env.PATH, [cliBinDir, "/usr/bin", "/bin"].join(delimiter));
});

test("message.updated finalizes only an exact MessageAbortedError once", async () => {
  const requests = [];
  let clientCalls = 0;
  const interruptedMessages = [
    {
      info: { id: "user-interrupted", role: "user", sessionID: "session-interrupted" },
      parts: [{ type: "text", text: "Stop this Turn." }],
    },
    {
      info: {
        id: "assistant-interrupted",
        role: "assistant",
        sessionID: "session-interrupted",
        parentID: "user-interrupted",
        time: { completed: 123 },
        error: { name: "MessageAbortedError" },
      },
      parts: [],
    },
  ];
  const hooks = await createPluginWithoutReminders({
    backendConnection: { url: "http://127.0.0.1:8787" },
    fetchImpl: responseSequence(requests, [
      { ok: true },
      { ok: true, scheduled: false, reason: "interrupted" },
    ]),
  })(pluginInput({
    client: {
      session: {
        async messages() {
          clientCalls += 1;
          return { data: interruptedMessages };
        },
      },
    },
  }));

  await hooks["chat.message"](
    { sessionID: "session-interrupted" },
    promptOutput("user-interrupted", "Stop this Turn."),
  );
  hooks.event({
    event: {
      type: "message.updated",
      properties: {
        info: {
          ...interruptedMessages[1].info,
          id: "assistant-other-error",
          error: { name: "UnknownError" },
        },
      },
    },
  });
  await delay(0);
  assert.equal(clientCalls, 0);

  const abortEvent = {
    event: {
      type: "message.updated",
      properties: { info: interruptedMessages[1].info },
    },
  };
  hooks.event(abortEvent);
  await hooks.dispose();
  hooks.event(abortEvent);
  await hooks.dispose();

  assert.equal(clientCalls, 1);
  assert.equal(requests.length, 2);
  assert.equal(new URL(requests[1].url).pathname, "/memory/writeback");
  assert.deepEqual(requests[1].body.messages, interruptedMessages);
});

function pluginInput(overrides = {}) {
  return {
    client: { session: { async messages() { return { data: [] }; } } },
    project: { vcs: "git" },
    directory: "/repo/directory",
    worktree: "/repo/worktree",
    serverUrl: new URL("http://127.0.0.1:4096"),
    ...overrides,
  };
}

function createPluginWithoutReminders(options) {
  return createMemoraxOpenCodePlugin({
    memorySkillReminderEvaluator: async () => undefined,
    ...options,
  });
}

function promptOutput(id, text, system) {
  return {
    message: { id, ...(system ? { system } : {}) },
    parts: [{ type: "text", text }],
  };
}

function memoryResponse(requests) {
  return async (url, options) => {
    const parsedUrl = new URL(url);
    const body = JSON.parse(options.body);
    requests.push({ url: String(url), path: parsedUrl.pathname, options, body });
    const responseBody = parsedUrl.pathname === "/memory/turn-start"
      ? { ok: true, additionalContext: `Retrieved ${body.userMessageId}.` }
      : { ok: true };
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
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

async function waitForFile(path) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      await readFile(path);
      return;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await delay(5);
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}
