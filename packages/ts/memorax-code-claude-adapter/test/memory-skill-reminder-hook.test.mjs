import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildClaudeMarketplace } from "../scripts/build-marketplace.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hookPath = join(packageRoot, "runtime-hooks", "memory-skill-reminder.mjs");
const captureHookPath = join(packageRoot, "runtime-hooks", "capture-cwd.mjs");
const MEMORY_SKILL_INVOCATION = "/memorax-code-claude-adapter:memorax-code";
const MEMORY_REMINDER_CONTEXT = `MemoraX Code reminder: proactively invoke ${MEMORY_SKILL_INVOCATION} whenever coding memory might help, even when uncertain; follow the skill's router to decide whether any memory operation is needed. Also use ${MEMORY_SKILL_INVOCATION} for repository-scoped personal memory, and classify the authority before reading or writing.`;
const PERSONAL_MEMORY_REMINDER_CONTEXT = `MemoraX Code personal-memory reminder: Use ${MEMORY_SKILL_INVOCATION} when the user states a durable current-repo identity or interaction preference, asks to list or recall stored personal memory, or explicitly asks to save, update, forget, or delete it. Route reusable action sequences and work rules to procedure memory; do not store repository facts, one-off task details, or secrets.`;

test("Claude memory skill metadata uses the plugin-namespaced invocation", async () => {
  const metadata = await readFile(join(packageRoot, "skills", "memorax-code", "agents", "claude.yaml"), "utf8");
  assert.match(metadata, /Use \/memorax-code-claude-adapter:memorax-code to route/);
  assert.doesNotMatch(metadata, /Use \/memorax-code to route/);
});

test("UserPromptSubmit manifest declares the Claude memory reminder hook", async () => {
  const manifest = JSON.parse(await readFile(join(packageRoot, "hooks", "hooks.json"), "utf8"));
  const commands = manifest.hooks.UserPromptSubmit[0].hooks.map((hook) => hook.command);

  assert.deepEqual(commands, [
    "node \"${CLAUDE_PLUGIN_ROOT}/hooks/runtime-hook.mjs\" capture-cwd",
    "node \"${CLAUDE_PLUGIN_ROOT}/hooks/runtime-hook.mjs\" memory-turn",
    "node \"${CLAUDE_PLUGIN_ROOT}/hooks/runtime-hook.mjs\" memory-skill-reminder",
  ]);
  assert.equal(manifest.hooks.UserPromptSubmit[0].hooks[2].timeout, undefined);
});

test("Claude memory skill reminder mirrors due context to the Backend trace contract", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-claude-memory-reminder-trace-"));
  const memoraxCodeHome = join(root, "memorax-code");
  const recorder = await listenRecorder();
  try {
    const env = {
      MEMORAX_CODE_BACKEND_TOKEN: "backend-token",
      MEMORAX_CODE_BACKEND_URL: recorder.url,
      MEMORAX_CODE_CLAUDE_MEMORY_HOOK_TIMEOUT_MS: "1000",
      MEMORAX_CODE_HOME: memoraxCodeHome,
    };
    const first = await runHook({
      hook_event_name: "UserPromptSubmit",
      session_id: "trace-thread",
      prompt_id: "prompt-1",
      transcript_path: "/tmp/claude-trace-thread.jsonl",
      cwd: "/repo",
      workspace_kind: "git",
      prompt: "first prompt",
    }, env);
    const duplicate = await runHook({
      hook_event_name: "UserPromptSubmit",
      session_id: "trace-thread",
      prompt_id: "prompt-1",
      transcript_path: "/tmp/claude-trace-thread.jsonl",
      cwd: "/repo",
      workspace_kind: "git",
      prompt: "first prompt",
    }, env);
    const second = await runHook({
      hook_event_name: "UserPromptSubmit",
      session_id: "trace-thread",
      prompt_id: "prompt-2",
      transcript_path: "/tmp/claude-trace-thread.jsonl",
      cwd: "/repo",
      workspace_kind: "git",
      prompt: "second prompt",
    }, env);

    assert.equal(first.code, 0, first.stderr);
    assertReminder(first.stdout);
    assert.equal(duplicate.code, 0, duplicate.stderr);
    assert.equal(duplicate.stdout, "");
    assert.equal(second.code, 0, second.stderr);
    assert.equal(second.stdout, "");
    assert.deepEqual(recorder.requests, [{
      path: "/memory/skill-reminder",
      body: {
        version: 1,
        client: "claude-code",
        sessionId: "trace-thread",
        promptId: "prompt-1",
        transcriptPath: "/tmp/claude-trace-thread.jsonl",
        cwd: "/repo",
        workspaceKind: "git",
        content: MEMORY_REMINDER_CONTEXT,
        triggers: ["cadence"],
      },
    }]);
    assert.equal(recorder.requestHeaders[0]["x-memorax-code-backend-token"], "backend-token");
  } finally {
    await recorder.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude memory skill reminder injection survives a trace recorder failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-claude-memory-reminder-trace-failure-"));
  const recorder = await listenRecorder({ statusCode: 503 });
  try {
    const result = await runHook({
      hook_event_name: "UserPromptSubmit",
      session_id: "trace-failure-thread",
      prompt_id: "prompt-1",
      transcript_path: "/tmp/claude-trace-failure.jsonl",
      prompt: "continue even when trace recording fails",
    }, {
      MEMORAX_CODE_BACKEND_URL: recorder.url,
      MEMORAX_CODE_CLAUDE_MEMORY_HOOK_TIMEOUT_MS: "1000",
      MEMORAX_CODE_HOME: join(root, "memorax-code"),
    });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, "");
    assertReminder(result.stdout);
    assert.equal(recorder.requests.length, 1);
  } finally {
    await recorder.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude memory skill reminder bounds a hanging trace request without changing output", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-claude-memory-reminder-trace-hang-"));
  const recorder = await listenRecorder({ hang: true });
  const input = {
    hook_event_name: "UserPromptSubmit",
    session_id: "trace-hang-thread",
    prompt_id: "prompt-1",
    transcript_path: "/tmp/claude-trace-hang.jsonl",
    prompt: "continue when trace recording hangs",
  };
  try {
    const baseline = await runHook(input, {
      MEMORAX_CODE_HOME: join(root, "baseline"),
    });
    const startedAt = Date.now();
    const result = await runHook(input, {
      MEMORAX_CODE_BACKEND_URL: recorder.url,
      MEMORAX_CODE_CLAUDE_MEMORY_HOOK_TIMEOUT_MS: "60000",
      MEMORAX_CODE_HOME: join(root, "hanging"),
    });
    const elapsedMs = Date.now() - startedAt;

    assert.equal(baseline.code, 0, baseline.stderr);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, baseline.stdout);
    assert.ok(elapsedMs < 3000, `hanging reminder trace took ${elapsedMs}ms`);
    assert.equal(recorder.requests.length, 1);
  } finally {
    await recorder.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude memory skill reminder emits for native sessions on the first and sixth prompts", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-claude-memory-reminder-"));
  const memoraxCodeHome = join(root, "memorax-code");
  try {
    await writeRegistry(memoraxCodeHome, {
      "native-thread": {
        key: "native-thread",
        claudeSessionId: "native-thread",
      },
    });

    const outputs = [];
    for (let index = 0; index < 6; index += 1) {
      outputs.push(await runHook({
        hook_event_name: "UserPromptSubmit",
        session_id: "native-thread",
        prompt: `prompt ${index + 1}`,
      }, { MEMORAX_CODE_HOME: memoraxCodeHome }));
    }

    for (const result of outputs) assert.equal(result.code, 0, result.stderr);
    assertReminder(outputs[0].stdout);
    assert.equal(outputs[1].stdout, "");
    assert.equal(outputs[2].stdout, "");
    assert.equal(outputs[3].stdout, "");
    assert.equal(outputs[4].stdout, "");
    assertReminder(outputs[5].stdout);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude memory skill reminder reads interval from MemoraX Code config", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-claude-memory-reminder-config-"));
  const memoraxCodeHome = join(root, "memorax-code");
  try {
    await writeRegistry(memoraxCodeHome, {
      "native-thread": {
        key: "native-thread",
        claudeSessionId: "native-thread",
      },
    });
    await writeFile(join(memoraxCodeHome, "config.toml"), [
      "[memory.skill_reminder]",
      "interval_turns = 2",
      "",
    ].join("\n"));

    const first = await runHook({
      hook_event_name: "UserPromptSubmit",
      session_id: "native-thread",
      prompt: "prompt 1",
    }, { MEMORAX_CODE_HOME: memoraxCodeHome });
    const second = await runHook({
      hook_event_name: "UserPromptSubmit",
      session_id: "native-thread",
      prompt: "prompt 2",
    }, { MEMORAX_CODE_HOME: memoraxCodeHome });
    const third = await runHook({
      hook_event_name: "UserPromptSubmit",
      session_id: "native-thread",
      prompt: "prompt 3",
    }, { MEMORAX_CODE_HOME: memoraxCodeHome });

    assert.equal(first.code, 0, first.stderr);
    assert.equal(second.code, 0, second.stderr);
    assert.equal(third.code, 0, third.stderr);
    assertReminder(first.stdout);
    assert.equal(second.stdout, "");
    assertReminder(third.stdout);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude memory skill reminder lets env override the config interval", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-claude-memory-reminder-env-"));
  const memoraxCodeHome = join(root, "memorax-code");
  try {
    await writeRegistry(memoraxCodeHome, {
      "native-thread": {
        key: "native-thread",
        claudeSessionId: "native-thread",
      },
    });
    await writeFile(join(memoraxCodeHome, "config.toml"), [
      "[memory.skill_reminder]",
      "interval_turns = 9",
      "",
    ].join("\n"));

    const first = await runHook({
      hook_event_name: "UserPromptSubmit",
      session_id: "native-thread",
      prompt: "prompt 1",
    }, {
      MEMORAX_CODE_HOME: memoraxCodeHome,
      MEMORAX_CODE_MEMORY_SKILL_REMINDER_INTERVAL_TURNS: "2",
    });
    const second = await runHook({
      hook_event_name: "UserPromptSubmit",
      session_id: "native-thread",
      prompt: "prompt 2",
    }, {
      MEMORAX_CODE_HOME: memoraxCodeHome,
      MEMORAX_CODE_MEMORY_SKILL_REMINDER_INTERVAL_TURNS: "2",
    });
    const third = await runHook({
      hook_event_name: "UserPromptSubmit",
      session_id: "native-thread",
      prompt: "prompt 3",
    }, {
      MEMORAX_CODE_HOME: memoraxCodeHome,
      MEMORAX_CODE_MEMORY_SKILL_REMINDER_INTERVAL_TURNS: "2",
    });

    assert.equal(first.code, 0, first.stderr);
    assert.equal(second.code, 0, second.stderr);
    assert.equal(third.code, 0, third.stderr);
    assertReminder(first.stdout);
    assert.equal(second.stdout, "");
    assertReminder(third.stdout);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude memory skill reminder counts a repeated prompt id only once", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-claude-memory-reminder-idempotent-prompt-"));
  const memoraxCodeHome = join(root, "memorax-code");
  try {
    await mkdir(memoraxCodeHome, { recursive: true });
    await writeFile(join(memoraxCodeHome, "config.toml"), [
      "[memory.skill_reminder]",
      "interval_turns = 1",
      "",
    ].join("\n"));

    const first = await runHook({
      hook_event_name: "UserPromptSubmit",
      session_id: "native-thread",
      prompt_id: "prompt-1",
      prompt: "first prompt",
    }, { MEMORAX_CODE_HOME: memoraxCodeHome });
    const duplicate = await runHook({
      hook_event_name: "UserPromptSubmit",
      session_id: "native-thread",
      prompt_id: "prompt-1",
      prompt: "first prompt",
    }, { MEMORAX_CODE_HOME: memoraxCodeHome });
    const second = await runHook({
      hook_event_name: "UserPromptSubmit",
      session_id: "native-thread",
      prompt_id: "prompt-2",
      prompt: "second prompt",
    }, { MEMORAX_CODE_HOME: memoraxCodeHome });

    assert.equal(first.code, 0, first.stderr);
    assert.equal(duplicate.code, 0, duplicate.stderr);
    assert.equal(second.code, 0, second.stderr);
    assertReminder(first.stdout);
    assert.equal(duplicate.stdout, "");
    assertReminder(second.stdout);
    const state = JSON.parse(await readFile(join(memoraxCodeHome, "adapters", "claude-code", "memory-skill-reminders.json"), "utf8"));
    assert.equal(state.sessions["native-thread"].turnCount, 2);
    assert.equal(state.sessions["native-thread"].lastTurnId, "prompt-2");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude memory skill reminder resets corrupt reminder state", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-claude-memory-reminder-corrupt-state-"));
  const memoraxCodeHome = join(root, "memorax-code");
  try {
    await writeRegistry(memoraxCodeHome, {
      "native-thread": {
        key: "native-thread",
        claudeSessionId: "native-thread",
      },
    });
    const statePath = join(memoraxCodeHome, "adapters", "claude-code", "memory-skill-reminders.json");
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(statePath, "{not json");

    const result = await runHook({
      hook_event_name: "UserPromptSubmit",
      session_id: "native-thread",
      prompt: "prompt after corrupt state",
    }, { MEMORAX_CODE_HOME: memoraxCodeHome });

    assert.equal(result.code, 0, result.stderr);
    assertReminder(result.stdout);
    const state = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(state.runtime, "claude-code");
    assert.equal(state.sessions["native-thread"].turnCount, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude memory skill reminder accepts an unregistered session", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-claude-memory-reminder-unregistered-"));
  const memoraxCodeHome = join(root, "memorax-code");
  try {
    const result = await runHook({
      hook_event_name: "UserPromptSubmit",
      session_id: "unregistered-thread",
      prompt: "unregistered prompt",
    }, { MEMORAX_CODE_HOME: memoraxCodeHome });

    assert.equal(result.code, 0, result.stderr);
    assertReminder(result.stdout);
    const state = JSON.parse(await readFile(join(memoraxCodeHome, "adapters", "claude-code", "memory-skill-reminders.json"), "utf8"));
    assert.equal(state.sessions["unregistered-thread"].turnCount, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude capture hook registers and counts a new native session", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-claude-memory-reminder-new-native-"));
  const memoraxCodeHome = join(root, "memorax-code");
  const workspace = join(root, "workspace");
  try {
    await mkdir(workspace, { recursive: true });
    const env = { MEMORAX_CODE_HOME: memoraxCodeHome };
    const capture = await runScript(captureHookPath, {
      hook_event_name: "UserPromptSubmit",
      session_id: "new-direct-thread",
      cwd: workspace,
      prompt: "first prompt",
    }, env);
    const reminder = await runHook({
      hook_event_name: "UserPromptSubmit",
      session_id: "new-direct-thread",
      cwd: workspace,
      prompt: "first prompt",
    }, env);

    assert.equal(capture.code, 0, capture.stderr);
    assert.equal(reminder.code, 0, reminder.stderr);
    assertReminder(reminder.stdout);
    const registry = JSON.parse(await readFile(join(memoraxCodeHome, "adapters", "claude-code", "session-registry.json"), "utf8"));
    assert.equal(registry.sessions["new-direct-thread"].claudeSessionId, "new-direct-thread");
    assert.equal(registry.sessions["new-direct-thread"].workspace, await realpath(workspace));
    const reminderState = JSON.parse(await readFile(join(memoraxCodeHome, "adapters", "claude-code", "memory-skill-reminders.json"), "utf8"));
    assert.equal(reminderState.sessions["new-direct-thread"].turnCount, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude injects profile and procedure memory on the shared cadence and after compact", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-claude-personal-memory-"));
  const memoraxCodeHome = join(root, "memorax-code");
  try {
    const repo = await createRepo(root);
    await writeProcedure(repo, "testing.md", "# Testing\n\n1. Run focused tests before the full suite.");
    await writePreferences(repo);
    const env = { MEMORAX_CODE_HOME: memoraxCodeHome };
    const sessionId = "claude-personal-memory-thread";

    const startup = await runScript(captureHookPath, {
      hook_event_name: "SessionStart",
      session_id: sessionId,
      source: "startup",
      cwd: repo,
    }, env);
    assert.equal(startup.code, 0, startup.stderr);

    const outputs = [];
    for (let turn = 1; turn <= 6; turn += 1) {
      outputs.push(await runHook({
        hook_event_name: "UserPromptSubmit",
        session_id: sessionId,
        prompt_id: `prompt-${turn}`,
        prompt: `prompt ${turn}`,
      }, env));
    }
    for (const output of outputs) assert.equal(output.code, 0, output.stderr);
    for (const index of [1, 2, 3, 4]) assert.equal(outputs[index].stdout, "");

    const firstContext = reminderContext(outputs[0].stdout);
    assert.ok(firstContext.indexOf(MEMORY_REMINDER_CONTEXT) < firstContext.indexOf(PERSONAL_MEMORY_REMINDER_CONTEXT));
    assert.ok(firstContext.indexOf(PERSONAL_MEMORY_REMINDER_CONTEXT) < firstContext.indexOf("Active repo-scoped user preferences"));
    assert.ok(firstContext.indexOf("Active repo-scoped user preferences") < firstContext.indexOf("Active repo-scoped procedure memories"));
    assert.match(firstContext, /Description: 用户偏好使用中文交流。/);
    assert.match(firstContext, /Run focused tests before the full suite/);
    assert.match(firstContext, /Natural final-answer mention for Codex and Claude Code:/);
    assert.match(firstContext, /begin the final answer with one brief opening paragraph/);
    assert.doesNotMatch(firstContext, /memorax-impact/);

    const sixthContext = reminderContext(outputs[5].stdout);
    assert.match(sixthContext, /^MemoraX Code reminder:/);
    assert.match(sixthContext, /Run focused tests before the full suite/);
    assert.match(sixthContext, /Natural final-answer mention for Codex and Claude Code:/);
    assert.doesNotMatch(sixthContext, /memorax-impact/);
    assert.doesNotMatch(sixthContext, /MemoraX Code personal-memory reminder:/);
    assert.doesNotMatch(sixthContext, /用户偏好使用中文交流/);

    const compact = await runScript(captureHookPath, {
      hook_event_name: "SessionStart",
      session_id: sessionId,
      source: "compact",
    }, env);
    assert.equal(compact.code, 0, compact.stderr);

    const afterCompact = await runHook({
      hook_event_name: "UserPromptSubmit",
      session_id: sessionId,
      prompt_id: "prompt-7",
      prompt: "prompt after compact",
    }, env);
    const duplicate = await runHook({
      hook_event_name: "UserPromptSubmit",
      session_id: sessionId,
      prompt_id: "prompt-7",
      prompt: "prompt after compact",
    }, env);

    assert.equal(afterCompact.code, 0, afterCompact.stderr);
    assert.equal(duplicate.code, 0, duplicate.stderr);
    const compactContext = reminderContext(afterCompact.stdout);
    assert.match(compactContext, /^MemoraX Code personal-memory reminder:/);
    assert.match(compactContext, /Description: 用户偏好使用中文交流。/);
    assert.match(compactContext, /Natural final-answer mention for Codex and Claude Code:/);
    assert.doesNotMatch(compactContext, /memorax-impact/);
    assert.doesNotMatch(compactContext, /^MemoraX Code reminder:/);
    assert.doesNotMatch(compactContext, /Run focused tests before the full suite/);
    assert.equal(duplicate.stdout, "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude marketplace packages hooks with self-contained common helpers", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-claude-memory-reminder-marketplace-"));
  const marketplaceRoot = join(root, "marketplace");
  const workspace = join(root, "workspace");
  const memoraxCodeHome = join(root, "memorax-code");
  try {
    await mkdir(workspace, { recursive: true });
    const result = await buildClaudeMarketplace({ outputDir: marketplaceRoot });
    assert.equal(result.ok, true);

    const cachePluginRoot = join(root, "claude", "plugins", "cache", "memorax-code-local", "memorax-code-claude-adapter", "0.1.0");
    await cp(result.pluginRoot, cachePluginRoot, { recursive: true });
    const env = { MEMORAX_CODE_HOME: memoraxCodeHome };
    const input = {
      hook_event_name: "UserPromptSubmit",
      session_id: "cached-direct-thread",
      prompt_id: "cached-direct-prompt",
      cwd: workspace,
      prompt: "first prompt",
    };
    const runtimeHook = join(cachePluginRoot, "hooks", "runtime-hook.mjs");
    const capture = await runScript(runtimeHook, input, env, "capture-cwd");
    const reminder = await runScript(runtimeHook, input, env, "memory-skill-reminder");

    assert.equal(capture.code, 0, capture.stderr);
    assert.equal(reminder.code, 0, reminder.stderr);
    assertReminder(reminder.stdout);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function writeRegistry(memoraxCodeHome, sessions) {
  const registryPath = join(memoraxCodeHome, "adapters", "claude-code", "session-registry.json");
  await mkdir(dirname(registryPath), { recursive: true });
  await writeFile(registryPath, `${JSON.stringify({
    version: 1,
    runtime: "claude-code",
    sessions,
  }, null, 2)}\n`);
}

function assertReminder(stdout) {
  const context = reminderContext(stdout);
  const payload = JSON.parse(stdout);
  assert.deepEqual(Object.keys(payload), ["hookSpecificOutput"]);
  assert.equal(payload.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.equal(context, MEMORY_REMINDER_CONTEXT);
  assert.match(context, /proactively invoke/);
  assert.match(context, /follow the skill's router to decide whether any memory operation is needed/);
  assert.match(context, /repository-scoped personal memory/);
  assert.doesNotMatch(context, /repo memory/i);
  assert.match(context, /classify the authority/);
  assert.doesNotMatch(context, /\$memorax-code/);
}

function reminderContext(stdout) {
  assert.notEqual(stdout, "");
  assert.equal(stdout.trim().split(/\r?\n/).length, 1);
  return JSON.parse(stdout).hookSpecificOutput.additionalContext;
}

async function createRepo(root) {
  const repo = join(root, "repo");
  await mkdir(repo);
  runGit(repo, ["init", "-b", "main"]);
  await writeFile(join(repo, "README.md"), "# Claude personal memory fixture\n");
  runGit(repo, ["add", "README.md"]);
  runGit(repo, ["commit", "-m", "initial fixture"]);
  return repo;
}

function runGit(cwd, args) {
  const result = spawnSync(
    "git",
    ["-c", "user.name=Claude Personal Memory Test", "-c", "user.email=claude-personal-memory@example.invalid", ...args],
    { cwd, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

async function writeProcedure(repo, name, content) {
  const directory = join(repo, ".repo_memory", "procedure-memory");
  await mkdir(directory, { recursive: true });
  await writeFile(join(repo, ".gitignore"), ".repo_memory/\n");
  await writeFile(join(directory, name), `${content.trim()}\n`);
}

async function writePreferences(repo) {
  const directory = join(repo, ".repo_memory", "user-profile");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "preferences.md"), [
    "---",
    'schema: "repo_user_profile_memory.v0.1"',
    'scope: "repo"',
    'owner: "repo-user-profile-memory"',
    'trust_state: "user_stated"',
    'updated_at: "2026-07-26T00:00:00.000Z"',
    "active_count: 1",
    "total_count: 1",
    "---",
    "",
    "# Repo-Scoped User Profile And Preferences",
    "",
    "## Active Preferences",
    "",
    "## Preference pref_language",
    "",
    "- Type: `communication`",
    "- Status: `active`",
    "- Confidence: `user_stated`",
    "- Created: `2026-07-26T00:00:00.000Z`",
    "- Updated: `2026-07-26T00:00:00.000Z`",
    "- Description: 用户偏好使用中文交流。",
    "- Applies when: 与用户交流时。",
    "- Do not apply when: 用户明确要求其他语言。",
    "- Raw lookup: `preferenceId=pref_language`",
    "",
  ].join("\n"));
}

function runHook(input, env = {}) {
  return runScript(hookPath, input, env);
}

function runScript(scriptPath, input, env = {}, component) {
  return new Promise((resolve) => {
    const childEnv = { ...process.env };
    delete childEnv.MEMORAX_CODE_MEMORY_SKILL_REMINDER_INTERVAL_TURNS;
    delete childEnv.PLUGIN_DATA;
    childEnv.MEMORAX_CODE_BACKEND_URL = "http://127.0.0.1:1";
    childEnv.MEMORAX_CODE_CLAUDE_MEMORY_HOOK_TIMEOUT_MS = "100";
    Object.assign(childEnv, env);
    const child = spawn(process.execPath, [
      scriptPath,
      ...(component ? [component] : []),
    ], {
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(`${JSON.stringify(input)}\n`);
  });
}

async function listenRecorder({ hang = false, statusCode = 200 } = {}) {
  const requests = [];
  const requestHeaders = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += String(chunk);
    requests.push({
      path: req.url,
      body: JSON.parse(body),
    });
    requestHeaders.push(req.headers);
    if (hang) return;
    res.writeHead(statusCode, { "content-type": "application/json" });
    res.end(JSON.stringify(statusCode === 200 ? { ok: true } : { ok: false }));
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  return {
    requests,
    requestHeaders,
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolveClose) => {
      server.close(resolveClose);
      server.closeAllConnections();
    }),
  };
}
