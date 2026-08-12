import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter } from "node:path";
import { join } from "node:path";
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

test("chat.message starts missing Repo Memory for the Backend-authorized worktree", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-opencode-auto-build-"));
  const backendRepo = join(root, "backend-repo");
  const pluginWorktree = join(root, "plugin-worktree");
  const memoraxCodeHome = join(root, "memorax-code-home");
  const openCodeConfigDir = join(root, "opencode-config");
  const jobLog = join(root, "repo-memory-job.json");
  const requests = [];
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
      fetchImpl: responseSequence(requests, [{ ok: true, repoMemoryWorktree: backendRepo }]),
    });
    hooks = await plugin(pluginInput({
      directory: pluginWorktree,
      worktree: pluginWorktree,
    }));

    await hooks["chat.message"](
      { sessionID: "session-auto-build" },
      promptOutput("user-auto-build", "Build missing Repo Memory."),
    );

    assert.equal(requests.length, 1);
    assert.equal(new URL(requests[0].url).pathname, "/memory/turn-start");
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
  const memoraxCodeHome = join(root, "memorax-code-home");
  const openCodeConfigDir = join(root, "opencode-config");
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
      `writeFileSync(${JSON.stringify(startedPath)}, "started\\n");`,
      `while (!existsSync(${JSON.stringify(releasePath)})) await new Promise((resolve) => setTimeout(resolve, 5));`,
      `appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(process.argv.slice(2)) + "\\n");`,
    ].join("\n"));
    const plugin = createPluginWithoutReminders({
      statePath,
      memoraxCodeHome,
      openCodeConfigDir,
      memoraxCodeCommand,
      backendConnection: { url: "http://127.0.0.1:9", source: "option" },
      healthTimeoutValue: "50",
      startTimeoutValue: "1000",
      backendPromptWaitTimeoutValue: "250",
      fetchImpl: responseSequence(requests, [{ ok: true }, { ok: true }]),
      memorySkillReminderEvaluator: async () => ({ additionalContext: "Local reminder context." }),
    });
    hooks = await plugin(pluginInput());

    const firstOutput = {
      message: { id: "user-start-1" },
      parts: [{ type: "text", text: "First prompt" }],
    };
    const firstPrompt = hooks["chat.message"](
      { sessionID: "session-start-1" },
      firstOutput,
    );
    await waitForFile(startedPath);
    assert.equal(requests.length, 0);
    await firstPrompt;
    assert.equal(requests.length, 0);
    assert.equal(firstOutput.message.system, "Local reminder context.");

    await Promise.race([
      hooks["chat.message"](
        { sessionID: "session-start-2" },
        { message: { id: "user-start-2" }, parts: [{ type: "text", text: "Second prompt" }] },
      ),
      delay(100).then(() => { throw new Error("Backend prompt wait budget was reset"); }),
    ]);
    assert.equal(requests.length, 0);

    await writeFile(releasePath, "release\n");
    for (let attempt = 0; attempt < 200 && requests.length === 0; attempt += 1) {
      await delay(5);
      await hooks["chat.message"](
        { sessionID: "session-start-3" },
        { message: { id: "user-start-3" }, parts: [{ type: "text", text: "Recovered prompt" }] },
      );
    }
    assert.equal(requests.length, 1);

    await hooks["chat.message"](
      { sessionID: "session-start-4" },
      { message: { id: "user-start-4" }, parts: [{ type: "text", text: "Later prompt" }] },
    );
    assert.equal(requests.length, 2);

    await hooks.dispose();
    const calls = (await readFile(callsPath, "utf8")).trim().split("\n").map(JSON.parse);
    assert.deepEqual(calls, [[
      "start",
      "--home", memoraxCodeHome,
      "--opencode-config-dir", openCodeConfigDir,
      "--host", "127.0.0.1",
      "--port", "9",
    ]]);
    assert.equal(requests.length, 2);
  } finally {
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

test("chat.message ignores compaction and synthetic-only messages", async () => {
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
    { sessionID: "session-synthetic" },
    { message: { id: "user-synthetic" }, parts: [{ type: "text", text: "generated", synthetic: true }] },
  );

  assert.equal(requests.length, 0);
});

test("the managed Repo Memory agent is isolated from normal prompt handling", async () => {
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
  const output = promptOutput("repo-memory-user", "Maintain Repo Memory");

  await hooks["chat.message"]({
    sessionID: "repo-memory-session",
    agent: OPENCODE_REPO_MEMORY_AGENT,
  }, output);

  assert.equal(reminderCalls, 0);
  assert.equal(requests.length, 0);
  assert.equal(output.message.system, undefined);
});

test("config registers the managed Repo Memory agent without replacing other agents", async () => {
  const plugin = createPluginWithoutReminders();
  const hooks = await plugin(pluginInput());
  const config = {
    agent: {
      existing: { description: "Keep me." },
      [OPENCODE_REPO_MEMORY_AGENT]: { permission: { edit: "deny" } },
    },
  };

  await hooks.config(config);

  assert.deepEqual(config.agent.existing, { description: "Keep me." });
  assert.deepEqual(config.agent[OPENCODE_REPO_MEMORY_AGENT], {
    description: "Managed MemoraX Code Repo Memory maintenance agent.",
    mode: "subagent",
    permission: {
      edit: "allow",
      bash: "allow",
      webfetch: "allow",
      doom_loop: "allow",
      external_directory: "allow",
    },
  });
});

test("chat.message reuses shared reminder cadence and personal memory contexts", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-opencode-reminder-"));
  const memoraxCodeHome = join(root, "memorax-code-home");
  const repo = join(root, "repo");
  const requests = [];
  let hooks;
  try {
    await mkdir(join(repo, ".repo_memory", "user-profile"), { recursive: true });
    await mkdir(join(repo, ".repo_memory", "procedure-memory"), { recursive: true });
    await mkdir(memoraxCodeHome, { recursive: true });
    execFileSync("git", ["init", "--quiet", repo]);
    await writeFile(join(repo, ".gitignore"), ".repo_memory/\n");
    await writeFile(join(memoraxCodeHome, "config.toml"), [
      "[memory.skill_reminder]",
      "interval_turns = 2",
      "",
    ].join("\n"));
    await writeFile(join(repo, ".repo_memory", "user-profile", "preferences.md"), [
      "---",
      "schema: repo_user_profile_memory.v0.1",
      "scope: repo",
      "owner: repo-user-profile-memory",
      "trust_state: user_stated",
      "active_count: 1",
      "total_count: 1",
      "---",
      "",
      "## Preference pref_concise",
      "",
      "- Status: `active`",
      "- Type: `communication`",
      "- Confidence: `explicit`",
      "- Created: `2026-08-11`",
      "- Updated: `2026-08-11`",
      "- Description: Keep answers concise.",
      "- Applies when: Responding to this user.",
      "- Do not apply when: -",
      "",
    ].join("\n"));
    await writeFile(
      join(repo, ".repo_memory", "procedure-memory", "verify-first.md"),
      "Verify the focused behavior before broad tests.\n",
    );

    const plugin = createMemoraxOpenCodePlugin({
      memoraxCodeHome,
      backendConnection: { url: "http://127.0.0.1:8787" },
      fetchImpl: memoryResponse(requests),
    });
    hooks = await plugin(pluginInput({ directory: repo, worktree: repo }));

    const firstOutput = promptOutput("user-reminder-1", "First prompt", "Existing system context");
    await hooks["chat.message"]({ sessionID: "session-reminder" }, firstOutput);
    const firstContext = firstOutput.message.system;
    assertOrdered(firstContext, [
      "Existing system context",
      "Retrieved user-reminder-1.",
      "MemoraX Code reminder: proactively invoke the `memorax-code` skill",
      "MemoraX Code personal-memory reminder",
      "Keep answers concise.",
      "Verify the focused behavior before broad tests.",
    ]);

    const duplicateOutput = promptOutput("user-reminder-1", "Duplicate prompt");
    await hooks["chat.message"]({ sessionID: "session-reminder" }, duplicateOutput);
    assert.equal(duplicateOutput.message.system, "Retrieved user-reminder-1.");

    const secondOutput = promptOutput("user-reminder-2", "Second prompt");
    await hooks["chat.message"]({ sessionID: "session-reminder" }, secondOutput);
    assert.equal(secondOutput.message.system, "Retrieved user-reminder-2.");

    const thirdOutput = promptOutput("user-reminder-3", "Third prompt");
    await hooks["chat.message"]({ sessionID: "session-reminder" }, thirdOutput);
    assert.match(thirdOutput.message.system, /Retrieved user-reminder-3\./);
    assert.match(thirdOutput.message.system, /MemoraX Code reminder: proactively invoke the `memorax-code` skill/);
    assert.match(thirdOutput.message.system, /Verify the focused behavior before broad tests\./);
    assert.doesNotMatch(thirdOutput.message.system, /Keep answers concise\./);

    await hooks.dispose();
    const reminderRequests = requests.filter((request) => request.path === "/memory/skill-reminder");
    assert.deepEqual(reminderRequests.map((request) => request.body.userMessageId), [
      "user-reminder-1",
      "user-reminder-3",
    ]);
    assert.deepEqual(reminderRequests.map((request) => request.body.triggers), [["cadence"], ["cadence"]]);
    assert.equal(Object.hasOwn(reminderRequests[0].body, "transcriptPath"), false);

    const state = JSON.parse(await readFile(
      join(memoraxCodeHome, "adapters", "opencode", "memory-skill-reminders.json"),
      "utf8",
    ));
    assert.equal(state.sessions["session-reminder"].turnCount, 3);
    assert.equal(state.sessions["session-reminder"].lastTurnId, "user-reminder-3");
  } finally {
    await hooks?.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("session.compacted supplements the next real OpenCode prompt once", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-opencode-compact-reminder-"));
  const memoraxCodeHome = join(root, "memorax-code-home");
  const requests = [];
  let hooks;
  try {
    const plugin = createMemoraxOpenCodePlugin({
      memoraxCodeHome,
      backendConnection: { url: "http://127.0.0.1:8787" },
      fetchImpl: memoryResponse(requests),
    });
    hooks = await plugin(pluginInput());

    await hooks["chat.message"](
      { sessionID: "session-compact-reminder" },
      promptOutput("user-compact-1", "First prompt"),
    );
    hooks.event({
      event: {
        type: "session.compacted",
        properties: { sessionID: "session-compact-reminder" },
      },
    });

    const requestsBeforeGeneratedMessages = requests.length;
    await hooks["chat.message"](
      { sessionID: "session-compact-reminder" },
      { message: { id: "generated-compaction" }, parts: [{ type: "compaction", auto: true }] },
    );
    await hooks["chat.message"](
      { sessionID: "session-compact-reminder" },
      { message: { id: "generated-synthetic" }, parts: [{ type: "text", text: "continue", synthetic: true }] },
    );
    assert.equal(requests.length, requestsBeforeGeneratedMessages);

    const nextOutput = promptOutput("user-compact-2", "Continue after compact");
    await hooks["chat.message"]({ sessionID: "session-compact-reminder" }, nextOutput);
    assert.match(nextOutput.message.system, /MemoraX Code personal-memory reminder/);
    assert.doesNotMatch(nextOutput.message.system, /MemoraX Code reminder: proactively/);

    const laterOutput = promptOutput("user-compact-3", "Later prompt");
    await hooks["chat.message"]({ sessionID: "session-compact-reminder" }, laterOutput);
    assert.equal(laterOutput.message.system, "Retrieved user-compact-3.");

    await hooks.dispose();
    const reminderRequests = requests.filter((request) => request.path === "/memory/skill-reminder");
    assert.deepEqual(reminderRequests.map((request) => request.body.triggers), [
      ["cadence"],
      ["post_compaction"],
    ]);
    const state = JSON.parse(await readFile(
      join(memoraxCodeHome, "adapters", "opencode", "memory-skill-reminders.json"),
      "utf8",
    ));
    assert.equal(state.sessions["session-compact-reminder"].turnCount, 3);
    assert.equal(state.sessions["session-compact-reminder"].supplementalReminderPending, false);
  } finally {
    await hooks?.dispose();
    await rm(root, { recursive: true, force: true });
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
  assert.equal(output.env.MEMORAX_CODE_OPENCODE_SERVER_URL, "http://127.0.0.1:4096/");
  assert.equal(output.env.PATH, [cliBinDir, "/usr/bin", "/bin"].join(delimiter));
});

test("a loaded plugin follows the managed enabled state without an OpenCode restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-opencode-plugin-state-"));
  const statePath = join(root, "state.json");
  const callsPath = join(root, "lifecycle-calls.jsonl");
  const memoraxCodeCommand = join(root, "memorax-code.mjs");
  const requests = [];
  try {
    await writeState(false);
    await writeFile(memoraxCodeCommand, [
      'import { appendFileSync } from "node:fs";',
      `appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(process.argv.slice(2)) + "\\n");`,
    ].join("\n"));
    const plugin = createPluginWithoutReminders({
      statePath,
      memoraxCodeHome: join(root, "memorax-code-home"),
      openCodeConfigDir: join(root, "opencode-config"),
      memoraxCodeCommand,
      backendConnection: { url: "http://127.0.0.1:9", source: "option" },
      healthTimeoutValue: "50",
      startTimeoutValue: "1000",
      fetchImpl: responseSequence(requests, [{ ok: true }]),
    });
    const hooks = await plugin(pluginInput());
    const disabledOutput = { message: { id: "user-disabled" }, parts: [{ type: "text", text: "ignored" }] };
    await hooks["chat.message"]({ sessionID: "session-disabled" }, disabledOutput);
    assert.equal(requests.length, 0);
    await assert.rejects(readFile(callsPath), /ENOENT/);

    await writeState(true);
    const enabledOutput = { message: { id: "user-enabled" }, parts: [{ type: "text", text: "remember" }] };
    await hooks["chat.message"]({ sessionID: "session-enabled" }, enabledOutput);
    assert.equal(requests.length, 1);
    assert.equal((await readFile(callsPath, "utf8")).trim().split("\n").length, 1);
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

test("message.updated finalizes only MessageAbortedError and serializes with idle", async () => {
  const requests = [];
  const clientCalls = [];
  let markFirstMessagesStarted;
  let releaseFirstMessages;
  const firstMessagesStarted = new Promise((resolve) => {
    markFirstMessagesStarted = resolve;
  });
  const firstMessagesReady = new Promise((resolve) => {
    releaseFirstMessages = resolve;
  });
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
        error: {
          name: "MessageAbortedError",
          data: { message: "The user interrupted this Turn." },
        },
      },
      parts: [],
    },
  ];
  const plugin = createPluginWithoutReminders({
    backendConnection: { url: "http://127.0.0.1:8787" },
    fetchImpl: responseSequence(requests, [{ ok: true }, { ok: true, scheduled: false, reason: "interrupted" }]),
  });
  const hooks = await plugin(pluginInput({
    client: {
      session: {
        async messages(options) {
          clientCalls.push(options);
          if (clientCalls.length === 1) {
            markFirstMessagesStarted();
            await firstMessagesReady;
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
  hooks.event({
    event: {
      type: "message.updated",
      properties: {
        info: {
          id: "assistant-unknown-error",
          role: "assistant",
          sessionID: "session-interrupted",
          parentID: "user-interrupted",
          time: { completed: 122 },
          error: { name: "UnknownError" },
        },
      },
    },
  });
  await delay(0);
  assert.equal(clientCalls.length, 0);
  assert.equal(requests.length, 1);

  hooks.event({
    event: {
      type: "session.status",
      properties: { sessionID: "session-interrupted", status: { type: "idle" } },
    },
  });
  await firstMessagesStarted;
  hooks.event({
    event: {
      type: "message.updated",
      properties: { info: interruptedMessages[1].info },
    },
  });
  await delay(0);
  assert.equal(clientCalls.length, 1, "the abort refresh waits for the idle refresh");

  releaseFirstMessages();
  await hooks.dispose();

  assert.equal(clientCalls.length, 2);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].url, "http://127.0.0.1:8787/memory/writeback");
  assert.deepEqual(requests[1].body, {
    version: 1,
    client: "opencode",
    sessionId: "session-interrupted",
    userMessageId: "user-interrupted",
    assistantMessageId: "assistant-interrupted",
    messages: interruptedMessages,
    cwd: "/repo/worktree",
    workspaceKind: "project",
  });

  hooks.event({
    event: {
      type: "session.status",
      properties: { sessionID: "session-interrupted", status: { type: "idle" } },
    },
  });
  await hooks.dispose();
  assert.equal(clientCalls.length, 2);
  assert.equal(requests.length, 2);
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

function assertOrdered(text, fragments) {
  let previous = -1;
  for (const fragment of fragments) {
    const index = text.indexOf(fragment);
    assert.ok(index > previous, `Expected ${JSON.stringify(fragment)} after the previous context`);
    previous = index;
  }
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
