import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createMemoraxOpenCodePlugin } from "../src/plugin.mjs";
import { OPENCODE_REPO_MEMORY_AGENT } from "../src/repo-memory-server-runner.mjs";

test("chat.message retrieves memory and injects it into the system prompt", async () => {
  const requests = [];
  const plugin = createPluginWithoutReminders({
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

test("chat.message shows userNotice without blocking or injecting it into model context", async () => {
  const toastCalls = [];
  const plugin = createPluginWithoutReminders({
    backendConnection: { url: "http://127.0.0.1:8787" },
    fetchImpl: responseSequence([], [{
      ok: true,
      additionalContext: "Retrieved memory context.",
      userNotice: "Quota reminder: Memory search has 10% or less remaining.",
    }]),
  });
  const hooks = await plugin(pluginInput({
    client: {
      session: { async messages() { return { data: [] }; } },
      tui: {
        showToast(options) {
          toastCalls.push(options);
          return new Promise(() => {});
        },
      },
    },
  }));
  const output = promptOutput("user-quota", "Recall memory.", "Existing system context");

  await hooks["chat.message"]({ sessionID: "session-quota" }, output);

  assert.equal(output.message.system, "Existing system context\n\nRetrieved memory context.");
  assert.doesNotMatch(output.message.system, /Quota reminder/);
  assert.deepEqual(toastCalls, [{
    body: {
      title: "MemoraX Code",
      message: "Quota reminder: Memory search has 10% or less remaining.",
      variant: "warning",
      duration: 10_000,
    },
    query: { directory: "/repo/directory" },
    throwOnError: true,
  }]);
});

test("repo-scoped reminder builders require a Backend-authorized worktree", async () => {
  const evaluations = [];
  const plugin = createMemoraxOpenCodePlugin({
    backendConnection: { url: "http://127.0.0.1:8787" },
    fetchImpl: responseSequence([], [
      { ok: true },
      { ok: true, repoMemoryWorktree: "/repo/authorized" },
    ]),
    memorySkillReminderEvaluator: async (options, input) => {
      const profileBuilder = typeof options.buildPersonalMemoryContext === "function";
      const procedureBuilder = typeof options.buildCadenceReminderContext === "function";
      const repositoryContext = profileBuilder && procedureBuilder;
      evaluations.push({ profileBuilder, procedureBuilder, cwd: input.cwd });
      return { additionalContext: repositoryContext ? "Authorized repo context." : "Generic reminder context." };
    },
  });
  const hooks = await plugin(pluginInput());
  const generic = promptOutput("user-scope-1", "First prompt");
  const authorized = promptOutput("user-scope-2", "Second prompt");

  await hooks["chat.message"]({ sessionID: "session-scope" }, generic);
  await hooks["chat.message"]({ sessionID: "session-scope" }, authorized);

  assert.equal(generic.message.system, "Generic reminder context.");
  assert.equal(authorized.message.system, "Authorized repo context.");
  assert.deepEqual(evaluations, [
    { profileBuilder: false, procedureBuilder: false, cwd: "/repo/worktree" },
    { profileBuilder: true, procedureBuilder: true, cwd: "/repo/worktree" },
  ]);
});

test("chat.message starts missing Repo Memory for the Backend-authorized worktree", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-opencode-auto-build-"));
  const nodePath = process.execPath;
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
      "  openCodeCommand: process.env.MEMORAX_CODE_OPENCODE_COMMAND,",
      "  serverUrl: process.env.MEMORAX_CODE_OPENCODE_SERVER_URL,",
      "}));",
      "",
    ].join("\n"));
    const plugin = createPluginWithoutReminders({
      memoraxCodeHome,
      openCodeConfigDir,
      nodePath,
      backendConnection: { url: "http://127.0.0.1:8787" },
      fetchImpl: responseSequence([], [{ ok: true, repoMemoryWorktree: backendRepo }]),
    });
    process.execPath = join(root, "opencode");
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
      openCodeCommand: join(root, "opencode"),
      serverUrl: "http://127.0.0.1:4096/",
    });
  } finally {
    process.execPath = nodePath;
    await hooks?.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("managed plugin starts the Backend once and bounds prompt waiting", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-opencode-backend-start-"));
  const nodePath = process.execPath;
  const memoraxCodeHome = join(root, "memorax-code-home");
  const openCodeConfigDir = join(root, "opencode-config");
  const statePath = join(root, "state.json");
  const callsPath = join(root, "lifecycle-calls.jsonl");
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
      'import { appendFileSync, existsSync } from "node:fs";',
      `appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(process.argv.slice(2)) + "\\n");`,
      `while (!existsSync(${JSON.stringify(releasePath)})) await new Promise((resolve) => setTimeout(resolve, 5));`,
    ].join("\n"));
    const plugin = createMemoraxOpenCodePlugin({
      statePath,
      memoraxCodeHome,
      openCodeConfigDir,
      memoraxCodeCommand,
      nodePath,
      backendConnection: { url: "http://127.0.0.1:9", source: "option" },
      healthTimeoutValue: "50",
      startTimeoutValue: "1000",
      backendPromptWaitTimeoutValue: "100",
      fetchImpl: responseSequence(requests, [{ ok: true }]),
      memorySkillReminderEvaluator: async () => ({ additionalContext: "Local reminder context." }),
    });
    process.execPath = join(root, "opencode");
    hooks = await plugin(pluginInput());
    await waitForFile(callsPath);
    const calls = (await readFile(callsPath, "utf8")).trim().split("\n").map(JSON.parse);
    assert.deepEqual(calls, [[
      "start",
      "--home", memoraxCodeHome,
      "--opencode-config-dir", openCodeConfigDir,
      "--host", "127.0.0.1",
      "--port", "9",
    ]]);
    const prompt = async (id) => {
      const output = promptOutput(id, id);
      await hooks["chat.message"]({ sessionID: `session-${id}` }, output);
      return output;
    };
    const [first, second] = await Promise.race([
      Promise.all([prompt("user-start-1"), prompt("user-start-2")]),
      delay(400).then(() => { throw new Error("Backend prompt wait was not bounded"); }),
    ]);
    assert.equal(requests.length, 0);
    assert.equal(first.message.system, "Local reminder context.");
    assert.equal(second.message.system, "Local reminder context.");

    await writeFile(releasePath, "release\n");
    await hooks.dispose();
    await prompt("user-start-3");
    assert.equal(requests.length, 1);
  } finally {
    process.execPath = nodePath;
    await writeFile(releasePath, "release\n").catch(() => undefined);
    await hooks?.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("managed plugin records load and real user message workspace evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-opencode-runtime-evidence-"));
  const memoraxCodeHome = join(root, "memorax-code-home");
  const workspace = join(root, "workspace");
  const statePath = join(root, "state.json");
  const requests = [];
  let hooks;
  try {
    await mkdir(workspace, { recursive: true });
    const canonicalWorkspace = await realpath(workspace);
    await writeFile(statePath, JSON.stringify({
      version: 1,
      runtime: "opencode",
      integration: "plugin",
      enabled: true,
    }));
    const plugin = createPluginWithoutReminders({
      statePath,
      memoraxCodeHome,
      backendConnection: { url: "http://127.0.0.1:8787" },
      fetchImpl: responseSequence(requests, [{ ok: true }]),
    });
    hooks = await plugin(pluginInput({ directory: workspace, worktree: workspace }));

    const workspaceStatePath = join(
      memoraxCodeHome,
      "adapters",
      "opencode",
      "workspaces.json",
    );
    const loadedState = JSON.parse(await readFile(workspaceStatePath, "utf8"));
    assert.equal(loadedState.latest.event, "plugin.load");
    assert.equal(loadedState.latest.cwd, canonicalWorkspace);
    await assert.rejects(
      readFile(join(memoraxCodeHome, "adapters", "opencode", "session-registry.json")),
      /ENOENT/,
    );

    await hooks["chat.message"]({
      sessionID: "repo-memory-session",
      agent: OPENCODE_REPO_MEMORY_AGENT,
    }, promptOutput("repo-memory-user", "Maintain Repo Memory"));
    assert.equal(
      JSON.parse(await readFile(workspaceStatePath, "utf8")).latest.event,
      "plugin.load",
    );

    await hooks["chat.message"](
      { sessionID: "runtime-session" },
      promptOutput("runtime-user", "Check runtime diagnostics"),
    );
    const promptedState = JSON.parse(await readFile(workspaceStatePath, "utf8"));
    assert.equal(promptedState.latest.event, "chat.message");
    assert.equal(promptedState.latest.sessionId, "runtime-session");
    assert.equal(promptedState.sessions["runtime-session"].cwd, canonicalWorkspace);
  } finally {
    await hooks?.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("chat.message does not mistake a user diff summary for compaction", async () => {
  const requests = [];
  const plugin = createPluginWithoutReminders({
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

test("chat.message ignores compaction-containing and synthetic-only messages", async () => {
  const requests = [];
  const plugin = createPluginWithoutReminders({
    backendConnection: { url: "http://127.0.0.1:8787" },
    fetchImpl: responseSequence(requests, []),
  });
  const hooks = await plugin(pluginInput());

  await hooks["chat.message"](
    { sessionID: "session-compaction" },
    { message: { id: "user-compaction" }, parts: [{ type: "compaction", auto: true }] },
  );
  await hooks["chat.message"](
    { sessionID: "session-mixed-compaction" },
    {
      message: { id: "user-mixed-compaction" },
      parts: [
        { type: "compaction", auto: true },
        { type: "text", text: "internal compaction summary" },
      ],
    },
  );
  await hooks["chat.message"](
    { sessionID: "session-synthetic" },
    { message: { id: "user-synthetic" }, parts: [{ type: "text", text: "generated", synthetic: true }] },
  );

  assert.equal(requests.length, 0);
});

test("the managed Repo Memory agent is registered and isolated from prompt handling", async () => {
  const requests = [];
  let reminderCalls = 0;
  const plugin = createMemoraxOpenCodePlugin({
    backendConnection: { url: "http://127.0.0.1:8787" },
    fetchImpl: responseSequence(requests, []),
    memorySkillReminderEvaluator: async () => {
      reminderCalls += 1;
      return { additionalContext: "must not be injected" };
    },
  });
  const hooks = await plugin(pluginInput());
  const config = {
    agent: {
      existing: { description: "Keep me." },
      [OPENCODE_REPO_MEMORY_AGENT]: {
        description: "User-configured Repo Memory agent.",
        disable: true,
        permission: { bash: "deny" },
      },
    },
  };

  await hooks.config(config);
  const output = promptOutput("repo-memory-user", "Maintain Repo Memory");
  await hooks["chat.message"]({
    sessionID: "repo-memory-session",
    agent: OPENCODE_REPO_MEMORY_AGENT,
  }, output);

  assert.deepEqual(config.agent.existing, { description: "Keep me." });
  assert.deepEqual(config.agent[OPENCODE_REPO_MEMORY_AGENT], {
    description: "User-configured Repo Memory agent.",
    mode: "subagent",
    hidden: true,
    disable: true,
    permission: { bash: "deny" },
  });
  assert.equal(reminderCalls, 0);
  assert.equal(requests.length, 0);
  assert.equal(output.message.system, undefined);
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
    assert.equal(reminderRequests.every((request) => request.body.cwd === "/repo/worktree"), true);
    assert.equal(Object.hasOwn(reminderRequests[0].body, "transcriptPath"), false);
  } finally {
    await hooks?.dispose();
    await rm(memoraxCodeHome, { recursive: true, force: true });
  }
});

test("shell.env overwrites the OpenCode session identity and prepends the managed CLI path", async () => {
  const cliBinDir = "/memorax/bin";
  const plugin = createPluginWithoutReminders({ cliBinDir });
  const hooks = await plugin(pluginInput());
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
  assert.equal(output.env.MEMORAX_CODE_OPENCODE_COMMAND, process.execPath);
  assert.equal(output.env.MEMORAX_CODE_OPENCODE_SERVER_URL, "http://127.0.0.1:4096/");
  assert.equal(output.env.PATH, [cliBinDir, "/usr/bin", "/bin"].join(delimiter));
});

test("shell.env clears inherited session identity without an OpenCode session", async () => {
  const plugin = createMemoraxOpenCodePlugin();
  const hooks = await plugin({});
  const output = {
    env: {
      MEMORAX_CODE_MEMORY_CLI_TRACE_CLIENT: "codex",
      MEMORAX_CODE_MEMORY_CLI_TRACE_SESSION_ID: "old-session",
      MEMORAX_CODE_MEMORY_CLI_SESSION_ID: "old-session",
    },
  };

  await hooks["shell.env"]({}, output);

  assert.equal(output.env.MEMORAX_CODE_MEMORY_CLI_TRACE_CLIENT, "opencode");
  assert.equal(Object.hasOwn(output.env, "MEMORAX_CODE_MEMORY_CLI_TRACE_SESSION_ID"), false);
  assert.equal(Object.hasOwn(output.env, "MEMORAX_CODE_MEMORY_CLI_SESSION_ID"), false);
});

test("a loaded plugin follows the managed enabled state without an OpenCode restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-opencode-plugin-state-"));
  const statePath = join(root, "state.json");
  const requests = [];
  try {
    await writeState(false);
    const plugin = createPluginWithoutReminders({
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
  const plugin = createPluginWithoutReminders({
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

test("idle follows an OpenCode compaction continuation back to the original pending turn", async () => {
  const requests = [];
  const messages = compactedMessages();
  const plugin = createPluginWithoutReminders({
    backendConnection: { url: "http://127.0.0.1:8787" },
    fetchImpl: responseSequence(requests, [{ ok: true }, { ok: true }]),
  });
  const hooks = await plugin(pluginInput({
    client: { session: { async messages() { return { data: messages }; } } },
  }));

  await hooks["chat.message"](
    { sessionID: "session-compacted-turn" },
    promptOutput("user-original", "Implement the requested change."),
  );
  hooks.event(sessionIdleEvent("session-compacted-turn"));
  await hooks.dispose();

  assert.equal(requests.length, 2);
  assert.equal(requests[1].body.userMessageId, "user-original");
  assert.equal(requests[1].body.assistantMessageId, "assistant-final");
  assert.deepEqual(
    requests[1].body.messages.map((message) => message.info.id),
    ["user-original", "assistant-tail", "user-compaction", "user-continuation", "assistant-final"],
  );
  assert.deepEqual(requests[1].body.messages[1], {
    info: {
      id: "assistant-tail",
      sessionID: "session-compacted-turn",
      role: "assistant",
      parentID: "user-original",
    },
    parts: [],
  });
  assert.equal(messages[1].parts[0].type, "tool", "native SDK messages remain unchanged");
});

test("malformed compaction records remain pending until the SDK lineage is complete", async () => {
  for (const [name, mutate] of [
    ["missing tail id", (message) => { delete message.parts[0].tail_start_id; }],
    ["blank tail id", (message) => { message.parts[0].tail_start_id = " "; }],
    ["duplicate compaction part", (message) => { message.parts.push({ ...message.parts[0] }); }],
  ]) {
    const requests = [];
    const messages = compactedMessages();
    mutate(messages[2]);
    const plugin = createPluginWithoutReminders({
      backendConnection: { url: "http://127.0.0.1:8787" },
      fetchImpl: responseSequence(requests, [{ ok: true }, { ok: true }]),
    });
    const hooks = await plugin(pluginInput({
      client: { session: { async messages() { return { data: messages }; } } },
    }));

    await hooks["chat.message"](
      { sessionID: "session-compacted-turn" },
      promptOutput("user-original", "Implement the requested change."),
    );
    hooks.event(sessionIdleEvent("session-compacted-turn"));
    await hooks.dispose();

    assert.deepEqual(
      requests.map((request) => new URL(request.url).pathname),
      ["/memory/turn-start"],
      name,
    );

    messages[2] = compactedMessages()[2];
    hooks.event(sessionIdleEvent("session-compacted-turn"));
    await hooks.dispose();

    assert.equal(requests.length, 2, name);
    assert.equal(requests[1].body.assistantMessageId, "assistant-final", name);
  }
});

test("message.updated finalizes an interrupted compaction continuation", async () => {
  const requests = [];
  const messages = compactedMessages();
  const assistant = messages.at(-1);
  assistant.info.error = { name: "MessageAbortedError" };
  assistant.parts = [];
  const plugin = createPluginWithoutReminders({
    backendConnection: { url: "http://127.0.0.1:8787" },
    fetchImpl: responseSequence(requests, [
      { ok: true },
      { ok: true, scheduled: false, reason: "interrupted" },
    ]),
  });
  const hooks = await plugin(pluginInput({
    client: { session: { async messages() { return { data: messages }; } } },
  }));

  await hooks["chat.message"](
    { sessionID: "session-compacted-turn" },
    promptOutput("user-original", "Implement the requested change."),
  );
  hooks.event(messageUpdatedEvent(assistant.info));
  await hooks.dispose();

  assert.equal(requests.length, 2);
  assert.equal(requests[1].body.userMessageId, "user-original");
  assert.equal(requests[1].body.assistantMessageId, "assistant-final");
});

test("idle discards HTTP 413 without starving a runtime-closed retry", async () => {
  const requests = [];
  const names = ["oversized", "retry"];
  const messages = names.flatMap((name, index) => {
    const userId = `user-${name}`;
    return [
      {
        info: { id: userId, role: "user", sessionID: "session-retry" },
        parts: [{ type: "text", text: `Prompt ${name}.` }],
      },
      {
        info: {
          id: `assistant-${name}`,
          role: "assistant",
          sessionID: "session-retry",
          parentID: userId,
          time: { completed: index + 1 },
        },
        parts: [{ type: "text", text: `Reply ${name}.` }],
      },
    ];
  });
  const plugin = createPluginWithoutReminders({
    backendConnection: { url: "http://127.0.0.1:8787" },
    fetchImpl: responseSequence(requests, [
      { ok: true },
      { ok: true },
      new Response(null, { status: 413 }),
      { ok: true, scheduled: false, reason: "runtime_closed" },
      { ok: true, scheduled: true },
    ]),
  });
  const hooks = await plugin(pluginInput({
    client: { session: { async messages() { return { data: messages }; } } },
  }));
  for (const name of names) {
    await hooks["chat.message"](
      { sessionID: "session-retry" },
      { message: { id: `user-${name}` }, parts: [{ type: "text", text: `Prompt ${name}.` }] },
    );
  }
  const idle = () => hooks.event({
    event: {
      type: "session.status",
      properties: { sessionID: "session-retry", status: { type: "idle" } },
    },
  });

  idle();
  await hooks.dispose();
  idle();
  await hooks.dispose();

  assert.deepEqual(
    requests.filter((request) => request.url.endsWith("/memory/writeback"))
      .map((request) => request.body.userMessageId),
    ["user-oversized", "user-retry", "user-retry"],
  );
});

test("message.updated finalizes MessageAbortedError and serializes with idle", async () => {
  const requests = [];
  let clientCalls = 0;
  let markIdleStarted;
  let releaseIdle;
  const idleStarted = new Promise((resolve) => { markIdleStarted = resolve; });
  const idleReady = new Promise((resolve) => { releaseIdle = resolve; });
  const assistantInfo = {
    id: "assistant-interrupted",
    role: "assistant",
    sessionID: "session-interrupted",
    parentID: "user-interrupted",
    time: { completed: 123 },
    error: { name: "MessageAbortedError" },
  };
  const interruptedMessages = [
    {
      info: { id: "user-interrupted", role: "user", sessionID: "session-interrupted" },
      parts: [{ type: "text", text: "Stop this Turn." }],
    },
    { info: assistantInfo, parts: [] },
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
          if (clientCalls === 1) {
            markIdleStarted();
            await idleReady;
            return { data: [] };
          }
          return { data: interruptedMessages };
        },
      },
    },
  }));

  await hooks["chat.message"](
    { sessionID: "session-interrupted" },
    promptOutput("user-interrupted", "Stop this Turn."),
  );
  hooks.event(sessionIdleEvent("session-interrupted"));
  await idleStarted;
  const abortEvent = messageUpdatedEvent(assistantInfo);
  hooks.event(abortEvent);
  await delay(0);
  assert.equal(clientCalls, 1, "the abort refresh waits for the idle refresh");

  releaseIdle();
  await hooks.dispose();
  hooks.event(abortEvent);
  await hooks.dispose();

  assert.equal(clientCalls, 2);
  assert.deepEqual(requests.map((request) => new URL(request.url).pathname), [
    "/memory/turn-start",
    "/memory/writeback",
  ]);
  assert.deepEqual(requests[1].body.messages, interruptedMessages);
});

test("message.updated closes an explicit provider error without writeback", async () => {
  const requests = [];
  const assistantInfo = {
    id: "assistant-provider-error",
    role: "assistant",
    sessionID: "session-provider-error",
    parentID: "user-provider-error",
    time: { completed: 123 },
    error: { name: "UnknownError" },
  };
  const messages = [
    {
      info: { id: "user-provider-error", role: "user", sessionID: "session-provider-error" },
      parts: [{ type: "text", text: "Run the request." }],
    },
    { info: assistantInfo, parts: [] },
  ];
  const hooks = await createPluginWithoutReminders({
    backendConnection: { url: "http://127.0.0.1:8787" },
    fetchImpl: responseSequence(requests, [
      { ok: true },
      { ok: true, scheduled: false, reason: "interrupted" },
    ]),
  })(pluginInput({
    client: { session: { async messages() { return { data: messages }; } } },
  }));

  await hooks["chat.message"](
    { sessionID: "session-provider-error" },
    promptOutput("user-provider-error", "Run the request."),
  );
  hooks.event(messageUpdatedEvent(assistantInfo));
  await hooks.dispose();

  assert.equal(requests.length, 2);
  assert.equal(requests[1].body.assistantMessageId, "assistant-provider-error");
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

function messageUpdatedEvent(info) {
  return { event: { type: "message.updated", properties: { info } } };
}

function sessionIdleEvent(sessionID) {
  return { event: { type: "session.status", properties: { sessionID, status: { type: "idle" } } } };
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

function compactedMessages() {
  const sessionID = "session-compacted-turn";
  const text = (messageID, value, extra = {}) => ({
    id: `${messageID}-text`,
    sessionID,
    messageID,
    type: "text",
    text: value,
    ...extra,
  });
  return [
    {
      info: { id: "user-original", sessionID, role: "user", time: { created: 1 } },
      parts: [text("user-original", "Implement the requested change.")],
    },
    {
      info: {
        id: "assistant-tail",
        sessionID,
        role: "assistant",
        parentID: "user-original",
        time: { created: 2, completed: 3 },
      },
      parts: [{ id: "assistant-tail-tool", sessionID, messageID: "assistant-tail", type: "tool" }],
    },
    {
      info: { id: "user-compaction", sessionID, role: "user", time: { created: 4 } },
      parts: [{
        id: "user-compaction-part",
        sessionID,
        messageID: "user-compaction",
        type: "compaction",
        auto: true,
        tail_start_id: "assistant-tail",
      }],
    },
    {
      info: {
        id: "assistant-summary",
        sessionID,
        role: "assistant",
        parentID: "user-compaction",
        summary: true,
        time: { created: 5, completed: 6 },
      },
      parts: [text("assistant-summary", "Internal summary.")],
    },
    {
      info: { id: "user-continuation", sessionID, role: "user", time: { created: 7 } },
      parts: [text("user-continuation", "Continue.", {
        synthetic: true,
        metadata: { compaction_continue: true },
      })],
    },
    {
      info: {
        id: "assistant-final",
        sessionID,
        role: "assistant",
        parentID: "user-continuation",
        time: { created: 8, completed: 9 },
      },
      parts: [text("assistant-final", "Implemented and verified.")],
    },
  ];
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
    if (body instanceof Response) return body;
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
