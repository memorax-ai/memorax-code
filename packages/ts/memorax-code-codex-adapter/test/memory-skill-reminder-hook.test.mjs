import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeHookPath = join(packageRoot, "hooks", "runtime-hook.mjs");
const MEMORY_REMINDER_CONTEXT = "MemoraX Code reminder: proactively invoke $memorax-code whenever coding memory might help, even when uncertain; follow the skill's router to decide whether any memory operation is needed. Also use $memorax-code for repository-scoped personal memory, and classify the authority before reading or writing.";
const PROFILE_REMINDER_CONTEXT = "MemoraX Code personal-memory reminder: Use $memorax-code when the user states a durable current-repo identity or interaction preference, asks to list or recall stored personal memory, or explicitly asks to save, update, forget, or delete it. Route reusable action sequences and work rules to procedure memory; do not store repository facts, one-off task details, or secrets.";

test("manifest reuses capture-cwd for compact and keeps one serialized UserPromptSubmit memory hook", async () => {
  const manifest = JSON.parse(await readFile(join(packageRoot, "hooks", "hooks.json"), "utf8"));
  const runtime = await readFile(join(packageRoot, "runtime-hooks", "memory-skill-reminder.mjs"), "utf8");
  const sessionCommands = manifest.hooks.SessionStart.flatMap((group) => group.hooks).map((hook) => hook.command);
  const commands = manifest.hooks.UserPromptSubmit[0].hooks.map((hook) => hook.command);

  const captureIndex = commands.indexOf("node \"$PLUGIN_ROOT/hooks/runtime-hook.mjs\" capture-cwd");
  const memoryReminderIndex = commands.indexOf("node \"$PLUGIN_ROOT/hooks/runtime-hook.mjs\" memory-skill-reminder");
  assert.ok(memoryReminderIndex > captureIndex);
  assert.deepEqual(commands, [
    "node \"$PLUGIN_ROOT/hooks/runtime-hook.mjs\" capture-cwd",
    "node \"$PLUGIN_ROOT/hooks/runtime-hook.mjs\" memory-skill-reminder",
  ]);
  assert.equal(manifest.hooks.UserPromptSubmit[0].hooks[1].timeout, 20);
  assert.match(runtime, /RETRIEVAL_BACKEND_TIMEOUT_MS = 12_000/);
  assert.match(runtime, /DEFAULT_BACKEND_TIMEOUT_MS = 5_000/);
  assert.match(runtime, /path === "\/memory\/turn-start" \? RETRIEVAL_BACKEND_TIMEOUT_MS : DEFAULT_BACKEND_TIMEOUT_MS/);
  assert.equal(manifest.hooks.SessionStart.length, 1);
  assert.deepEqual(sessionCommands, [
    "node \"$PLUGIN_ROOT/hooks/runtime-hook.mjs\" ensure-backend",
    "node \"$PLUGIN_ROOT/hooks/runtime-hook.mjs\" capture-cwd",
  ]);
});

test("memory skill reminder emits without repo profile on the first and sixth prompts", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-codex-memory-reminder-"));
  const memoraxCodeHome = join(root, "memorax-code");
  try {
    await writeRegistry(memoraxCodeHome, {
      "native-thread": {
        key: "native-thread",
        codexSessionId: "native-thread",
      },
    });
    const outputs = [];
    for (let index = 0; index < 6; index += 1) {
      outputs.push(await runHook({
        hook_event_name: "UserPromptSubmit",
        session_id: "native-thread",
        turn_id: `turn-${index + 1}`,
        transcript_path: "/tmp/native-thread.jsonl",
        prompt: `prompt ${index + 1}`,
      }, { MEMORAX_CODE_HOME: memoraxCodeHome }));
    }

    for (const result of outputs) assert.equal(result.code, 0, result.stderr);
    assertMemoryReminder(outputs[0].stdout);
    assert.equal(outputs[1].stdout, "");
    assert.equal(outputs[2].stdout, "");
    assert.equal(outputs[3].stdout, "");
    assert.equal(outputs[4].stdout, "");
    assertMemoryReminder(outputs[5].stdout);
    await assert.rejects(readFile(join(memoraxCodeHome, "adapters", "codex", "repo-user-profile-injections.json"), "utf8"), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repo profile reminder is consumed once on the first prompt after compact", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-codex-profile-after-compact-"));
  const memoraxCodeHome = join(root, "memorax-code");
  try {
    await writeRegistry(memoraxCodeHome, {
      "native-thread": {
        key: "native-thread",
        codexSessionId: "native-thread",
      },
    });

    const first = await runHook({
      hook_event_name: "UserPromptSubmit",
      session_id: "native-thread",
      turn_id: "turn-1",
      transcript_path: "/tmp/native-thread.jsonl",
      prompt: "prompt 1",
    }, { MEMORAX_CODE_HOME: memoraxCodeHome });
    const compact = await runCaptureHook({
      hook_event_name: "SessionStart",
      session_id: "native-thread",
      source: "compact",
    }, { MEMORAX_CODE_HOME: memoraxCodeHome });
    const afterCompact = await runHook({
      hook_event_name: "UserPromptSubmit",
      session_id: "native-thread",
      turn_id: "turn-2",
      transcript_path: "/tmp/native-thread.jsonl",
      prompt: "prompt 2",
    }, { MEMORAX_CODE_HOME: memoraxCodeHome });
    const following = await runHook({
      hook_event_name: "UserPromptSubmit",
      session_id: "native-thread",
      turn_id: "turn-3",
      transcript_path: "/tmp/native-thread.jsonl",
      prompt: "prompt 3",
    }, { MEMORAX_CODE_HOME: memoraxCodeHome });

    assertMemoryReminder(first.stdout);
    assert.equal(compact.stdout, "");
    assertProfileReminder(afterCompact.stdout);
    assert.equal(following.stdout, "");
    const state = JSON.parse(await readFile(join(memoraxCodeHome, "adapters", "codex", "memory-skill-reminders.json"), "utf8"));
    assert.equal(state.sessions["native-thread"].turnCount, 3);
    assert.equal(state.sessions["native-thread"].supplementalReminderPending, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("memory and repo profile reminders share one payload when compact refresh meets cadence", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-codex-profile-combined-trigger-"));
  const memoraxCodeHome = join(root, "memorax-code");
  try {
    await writeRegistry(memoraxCodeHome, {
      "native-thread": {
        key: "native-thread",
        codexSessionId: "native-thread",
      },
    });
    await writeFile(join(memoraxCodeHome, "config.toml"), [
      "[memory.skill_reminder]",
      "interval_turns = 1",
      "",
    ].join("\n"));

    await runHook({
      hook_event_name: "UserPromptSubmit",
      session_id: "native-thread",
      turn_id: "turn-1",
      transcript_path: "/tmp/native-thread.jsonl",
      prompt: "prompt 1",
    }, { MEMORAX_CODE_HOME: memoraxCodeHome });
    await runCaptureHook({
      hook_event_name: "SessionStart",
      session_id: "native-thread",
      source: "compact",
    }, { MEMORAX_CODE_HOME: memoraxCodeHome });
    const result = await runHook({
      hook_event_name: "UserPromptSubmit",
      session_id: "native-thread",
      turn_id: "turn-2",
      transcript_path: "/tmp/native-thread.jsonl",
      prompt: "prompt 2",
    }, { MEMORAX_CODE_HOME: memoraxCodeHome });

    assertCombinedReminder(result.stdout);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("combined memory hook records turn start before each emitted developer reminder", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-codex-reminder-event-"));
  const memoraxCodeHome = join(root, "memorax-code");
  const requests = [];
  const lifecycle = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += String(chunk);
    const requestBody = JSON.parse(body);
    requests.push({ path: req.url, body: requestBody });
    if (req.url === "/memory/turn-start") {
      lifecycle.push(`${requestBody.turnId}:start-received`);
      await new Promise((resolve) => setTimeout(resolve, 20));
      lifecycle.push(`${requestBody.turnId}:start-responded`);
    } else {
      lifecycle.push(`${requestBody.turnId}:reminder-received`);
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true}');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    await writeRegistry(memoraxCodeHome, {
      "native-thread": {
        key: "native-thread",
        codexSessionId: "native-thread",
      },
    });
    await writeFile(join(memoraxCodeHome, "config.toml"), "[memory.skill_reminder]\ninterval_turns = 2\n");
    const result = await runHook({
      hook_event_name: "UserPromptSubmit",
      session_id: "native-thread",
      turn_id: "turn-1",
      transcript_path: "/tmp/native-thread.jsonl",
      cwd: "/repo",
      workspace_kind: "git",
      prompt: "prompt 1",
    }, {
      MEMORAX_CODE_HOME: memoraxCodeHome,
      MEMORAX_CODE_BACKEND_URL: `http://127.0.0.1:${address.port}`,
    });

    assert.equal(result.code, 0, result.stderr);
    assertMemoryReminder(result.stdout);
    await runCaptureHook({
      hook_event_name: "SessionStart",
      session_id: "native-thread",
      source: "compact",
    }, { MEMORAX_CODE_HOME: memoraxCodeHome });
    const afterCompact = await runHook({
      hook_event_name: "UserPromptSubmit",
      session_id: "native-thread",
      turn_id: "turn-2",
      transcript_path: "/tmp/native-thread.jsonl",
      cwd: "/repo",
      workspace_kind: "git",
      prompt: "prompt 2",
    }, {
      MEMORAX_CODE_HOME: memoraxCodeHome,
      MEMORAX_CODE_BACKEND_URL: `http://127.0.0.1:${address.port}`,
    });
    assert.equal(afterCompact.code, 0, afterCompact.stderr);
    assertProfileReminder(afterCompact.stdout);
    await runCaptureHook({
      hook_event_name: "SessionStart",
      session_id: "native-thread",
      source: "compact",
    }, { MEMORAX_CODE_HOME: memoraxCodeHome });
    const combined = await runHook({
      hook_event_name: "UserPromptSubmit",
      session_id: "native-thread",
      turn_id: "turn-3",
      transcript_path: "/tmp/native-thread.jsonl",
      cwd: "/repo",
      workspace_kind: "git",
      prompt: "prompt 3",
    }, {
      MEMORAX_CODE_HOME: memoraxCodeHome,
      MEMORAX_CODE_BACKEND_URL: `http://127.0.0.1:${address.port}`,
    });
    assert.equal(combined.code, 0, combined.stderr);
    assertCombinedReminder(combined.stdout);
    assert.deepEqual(requests, [
      {
        path: "/memory/turn-start",
        body: {
          version: 1,
          client: "codex",
          sessionId: "native-thread",
          turnId: "turn-1",
          prompt: "prompt 1",
          cwd: "/repo",
          workspaceKind: "git",
          transcriptPath: "/tmp/native-thread.jsonl",
        },
      },
      {
        path: "/memory/skill-reminder",
        body: {
          version: 1,
          client: "codex",
          sessionId: "native-thread",
          turnId: "turn-1",
          transcriptPath: "/tmp/native-thread.jsonl",
          cwd: "/repo",
          workspaceKind: "git",
          content: MEMORY_REMINDER_CONTEXT,
          triggers: ["cadence"],
        },
      },
      {
        path: "/memory/turn-start",
        body: {
          version: 1,
          client: "codex",
          sessionId: "native-thread",
          turnId: "turn-2",
          prompt: "prompt 2",
          cwd: "/repo",
          workspaceKind: "git",
          transcriptPath: "/tmp/native-thread.jsonl",
        },
      },
      {
        path: "/memory/skill-reminder",
        body: {
          version: 1,
          client: "codex",
          sessionId: "native-thread",
          turnId: "turn-2",
          transcriptPath: "/tmp/native-thread.jsonl",
          cwd: "/repo",
          workspaceKind: "git",
          content: PROFILE_REMINDER_CONTEXT,
          triggers: ["post_compaction"],
        },
      },
      {
        path: "/memory/turn-start",
        body: {
          version: 1,
          client: "codex",
          sessionId: "native-thread",
          turnId: "turn-3",
          prompt: "prompt 3",
          cwd: "/repo",
          workspaceKind: "git",
          transcriptPath: "/tmp/native-thread.jsonl",
        },
      },
      {
        path: "/memory/skill-reminder",
        body: {
          version: 1,
          client: "codex",
          sessionId: "native-thread",
          turnId: "turn-3",
          transcriptPath: "/tmp/native-thread.jsonl",
          cwd: "/repo",
          workspaceKind: "git",
          content: `${MEMORY_REMINDER_CONTEXT}\n\n${PROFILE_REMINDER_CONTEXT}`,
          triggers: ["cadence", "post_compaction"],
        },
      },
    ]);
    assert.deepEqual(lifecycle, [
      "turn-1:start-received",
      "turn-1:start-responded",
      "turn-1:reminder-received",
      "turn-2:start-received",
      "turn-2:start-responded",
      "turn-2:reminder-received",
      "turn-3:start-received",
      "turn-3:start-responded",
      "turn-3:reminder-received",
    ]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test("combined memory hook starts Repo Memory build for the Backend-authorized worktree", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-codex-auto-build-"));
  const memoraxCodeHome = join(root, "memorax-code");
  const repo = join(root, "repo");
  const pluginRoot = join(root, "plugin");
  const jobLog = join(root, "repo-memory-job.json");
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(req.url === "/memory/turn-start"
      ? { ok: true, repoMemoryWorktree: repo }
      : { ok: true }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    await Promise.all([
      mkdir(repo, { recursive: true }),
      mkdir(join(pluginRoot, "hooks"), { recursive: true }),
      writeRegistry(memoraxCodeHome, {
        "native-thread": {
          key: "native-thread",
          codexSessionId: "native-thread",
        },
      }),
    ]);
    await writeFile(join(pluginRoot, "hooks", "repo-memory-job.mjs"), [
      'import { writeFileSync } from "node:fs";',
      `writeFileSync(${JSON.stringify(jobLog)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));`,
      "",
    ].join("\n"));

    const result = await runHook({
      hook_event_name: "UserPromptSubmit",
      session_id: "native-thread",
      turn_id: "turn-auto-build",
      transcript_path: "/tmp/native-thread.jsonl",
      cwd: repo,
      workspace_kind: "git",
      prompt: "Build missing Repo Memory.",
    }, {
      MEMORAX_CODE_BACKEND_URL: `http://127.0.0.1:${address.port}`,
      MEMORAX_CODE_HOME: memoraxCodeHome,
      PLUGIN_ROOT: pluginRoot,
    });

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(await waitForFile(jobLog)), {
      args: ["maintain", "--repo", repo],
      cwd: await realpath(repo),
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test("automatic retrieval, reminders, and user notices share one Codex Hook payload", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-codex-retrieval-reminder-"));
  const memoraxCodeHome = join(root, "memorax-code");
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += String(chunk);
    const requestBody = JSON.parse(body);
    requests.push({ path: req.url, body: requestBody });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(req.url === "/memory/turn-start"
      ? {
          ok: true,
          ...(requestBody.turnId === "turn-1"
            ? { additionalContext: `Retrieved context for ${requestBody.turnId}.` }
            : {}),
          userNotice: `Quota notice for ${requestBody.turnId}.`,
        }
      : { ok: true }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    await writeRegistry(memoraxCodeHome, {
      "native-thread": {
        key: "native-thread",
        codexSessionId: "native-thread",
      },
    });
    const env = {
      MEMORAX_CODE_HOME: memoraxCodeHome,
      MEMORAX_CODE_BACKEND_URL: `http://127.0.0.1:${address.port}`,
    };
    const first = await runHook({
      hook_event_name: "UserPromptSubmit",
      session_id: "native-thread",
      turn_id: "turn-1",
      transcript_path: "/tmp/native-thread.jsonl",
      cwd: "/repo",
      workspace_kind: "git",
      prompt: "prompt 1",
    }, env);
    const second = await runHook({
      hook_event_name: "UserPromptSubmit",
      session_id: "native-thread",
      turn_id: "turn-2",
      transcript_path: "/tmp/native-thread.jsonl",
      cwd: "/repo",
      workspace_kind: "git",
      prompt: "prompt 2",
    }, env);

    assert.equal(first.code, 0, first.stderr);
    assert.deepEqual(JSON.parse(first.stdout), {
      systemMessage: "Quota notice for turn-1.",
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: `Retrieved context for turn-1.\n\n${MEMORY_REMINDER_CONTEXT}`,
      },
    });
    assert.equal(second.code, 0, second.stderr);
    assert.deepEqual(JSON.parse(second.stdout), {
      systemMessage: "Quota notice for turn-2.",
    });
    assert.deepEqual(requests.map((request) => request.path), [
      "/memory/turn-start",
      "/memory/skill-reminder",
      "/memory/turn-start",
    ]);
    assert.equal(requests[1].body.content, MEMORY_REMINDER_CONTEXT);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test("combined memory hook does not record an orphan reminder when turn start fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-codex-reminder-start-failure-"));
  const memoraxCodeHome = join(root, "memorax-code");
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += String(chunk);
    requests.push({ path: req.url, body: JSON.parse(body) });
    res.writeHead(503, { "content-type": "application/json" });
    res.end('{"ok":false}');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    await writeRegistry(memoraxCodeHome, {
      "native-thread": {
        key: "native-thread",
        codexSessionId: "native-thread",
      },
    });
    const result = await runHook({
      hook_event_name: "UserPromptSubmit",
      session_id: "native-thread",
      turn_id: "turn-1",
      transcript_path: "/tmp/native-thread.jsonl",
      cwd: "/repo",
      workspace_kind: "git",
      prompt: "prompt 1",
    }, {
      MEMORAX_CODE_HOME: memoraxCodeHome,
      MEMORAX_CODE_BACKEND_URL: `http://127.0.0.1:${address.port}`,
    });

    assert.equal(result.code, 0, result.stderr);
    assertMemoryReminder(result.stdout);
    assert.deepEqual(requests, [{
      path: "/memory/turn-start",
      body: {
        version: 1,
        client: "codex",
        sessionId: "native-thread",
        turnId: "turn-1",
        prompt: "prompt 1",
        cwd: "/repo",
        workspaceKind: "git",
        transcriptPath: "/tmp/native-thread.jsonl",
      },
    }]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test("memory skill reminder reads interval from MemoraX Code config", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-codex-memory-reminder-config-"));
  const memoraxCodeHome = join(root, "memorax-code");
  try {
    await writeRegistry(memoraxCodeHome, {
      "native-thread": {
        key: "native-thread",
        codexSessionId: "native-thread",
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
      turn_id: "turn-1",
      transcript_path: "/tmp/native-thread.jsonl",
      prompt: "prompt 1",
    }, { MEMORAX_CODE_HOME: memoraxCodeHome });
    const second = await runHook({
      hook_event_name: "UserPromptSubmit",
      session_id: "native-thread",
      turn_id: "turn-2",
      transcript_path: "/tmp/native-thread.jsonl",
      prompt: "prompt 2",
    }, { MEMORAX_CODE_HOME: memoraxCodeHome });
    const third = await runHook({
      hook_event_name: "UserPromptSubmit",
      session_id: "native-thread",
      turn_id: "turn-3",
      transcript_path: "/tmp/native-thread.jsonl",
      prompt: "prompt 3",
    }, { MEMORAX_CODE_HOME: memoraxCodeHome });

    assert.equal(first.code, 0, first.stderr);
    assert.equal(second.code, 0, second.stderr);
    assert.equal(third.code, 0, third.stderr);
    assertMemoryReminder(first.stdout);
    assert.equal(second.stdout, "");
    assertMemoryReminder(third.stdout);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("memory skill reminder lets env override the config interval", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-codex-memory-reminder-env-"));
  const memoraxCodeHome = join(root, "memorax-code");
  try {
    await writeRegistry(memoraxCodeHome, {
      "native-thread": {
        key: "native-thread",
        codexSessionId: "native-thread",
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
      turn_id: "turn-1",
      transcript_path: "/tmp/native-thread.jsonl",
      prompt: "prompt 1",
    }, {
      MEMORAX_CODE_HOME: memoraxCodeHome,
      MEMORAX_CODE_MEMORY_SKILL_REMINDER_INTERVAL_TURNS: "2",
    });
    const second = await runHook({
      hook_event_name: "UserPromptSubmit",
      session_id: "native-thread",
      turn_id: "turn-2",
      transcript_path: "/tmp/native-thread.jsonl",
      prompt: "prompt 2",
    }, {
      MEMORAX_CODE_HOME: memoraxCodeHome,
      MEMORAX_CODE_MEMORY_SKILL_REMINDER_INTERVAL_TURNS: "2",
    });
    const third = await runHook({
      hook_event_name: "UserPromptSubmit",
      session_id: "native-thread",
      turn_id: "turn-3",
      transcript_path: "/tmp/native-thread.jsonl",
      prompt: "prompt 3",
    }, {
      MEMORAX_CODE_HOME: memoraxCodeHome,
      MEMORAX_CODE_MEMORY_SKILL_REMINDER_INTERVAL_TURNS: "2",
    });

    assert.equal(first.code, 0, first.stderr);
    assert.equal(second.code, 0, second.stderr);
    assert.equal(third.code, 0, third.stderr);
    assertMemoryReminder(first.stdout);
    assert.equal(second.stdout, "");
    assertMemoryReminder(third.stdout);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("memory skill reminder ignores invalid config intervals", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-codex-memory-reminder-invalid-config-"));
  const memoraxCodeHome = join(root, "memorax-code");
  try {
    await writeRegistry(memoraxCodeHome, {
      "native-thread": {
        key: "native-thread",
        codexSessionId: "native-thread",
      },
    });
    await writeFile(join(memoraxCodeHome, "config.toml"), [
      "[memory.skill_reminder]",
      "interval_turns = 0",
      "",
    ].join("\n"));

    const outputs = [];
    for (let index = 0; index < 6; index += 1) {
      outputs.push(await runHook({
        hook_event_name: "UserPromptSubmit",
        session_id: "native-thread",
        turn_id: `turn-${index + 1}`,
        transcript_path: "/tmp/native-thread.jsonl",
        prompt: `prompt ${index + 1}`,
      }, { MEMORAX_CODE_HOME: memoraxCodeHome }));
    }

    for (const result of outputs) assert.equal(result.code, 0, result.stderr);
    assertMemoryReminder(outputs[0].stdout);
    assert.equal(outputs[1].stdout, "");
    assert.equal(outputs[2].stdout, "");
    assert.equal(outputs[3].stdout, "");
    assert.equal(outputs[4].stdout, "");
    assertMemoryReminder(outputs[5].stdout);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("memory skill reminder counts a repeated turn id only once", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-codex-memory-reminder-idempotent-turn-"));
  const memoraxCodeHome = join(root, "memorax-code");
  try {
    await writeRegistry(memoraxCodeHome, {
      "native-thread": {
        key: "native-thread",
        codexSessionId: "native-thread",
      },
    });
    await writeFile(join(memoraxCodeHome, "config.toml"), [
      "[memory.skill_reminder]",
      "interval_turns = 1",
      "",
    ].join("\n"));

    const first = await runHook({
      hook_event_name: "UserPromptSubmit",
      session_id: "native-thread",
      transcript_path: "/tmp/native-thread.jsonl",
      turn_id: "turn-1",
      prompt: "first prompt",
    }, { MEMORAX_CODE_HOME: memoraxCodeHome });
    const duplicate = await runHook({
      hook_event_name: "UserPromptSubmit",
      session_id: "native-thread",
      transcript_path: "/tmp/native-thread.jsonl",
      turn_id: "turn-1",
      prompt: "first prompt",
    }, { MEMORAX_CODE_HOME: memoraxCodeHome });
    const second = await runHook({
      hook_event_name: "UserPromptSubmit",
      session_id: "native-thread",
      transcript_path: "/tmp/native-thread.jsonl",
      turn_id: "turn-2",
      prompt: "second prompt",
    }, { MEMORAX_CODE_HOME: memoraxCodeHome });

    assert.equal(first.code, 0, first.stderr);
    assert.equal(duplicate.code, 0, duplicate.stderr);
    assert.equal(second.code, 0, second.stderr);
    assertMemoryReminder(first.stdout);
    assert.equal(duplicate.stdout, "");
    assertMemoryReminder(second.stdout);
    const state = JSON.parse(await readFile(join(memoraxCodeHome, "adapters", "codex", "memory-skill-reminders.json"), "utf8"));
    assert.equal(state.sessions["native-thread"].turnCount, 2);
    assert.equal(state.sessions["native-thread"].lastTurnId, "turn-2");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent capture Hooks preserve every session and workspace record", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-codex-capture-concurrent-"));
  const memoraxCodeHome = join(root, "memorax-code");
  const workspace = join(root, "workspace");
  const sessionIds = Array.from({ length: 16 }, (_, index) => `concurrent-session-${index + 1}`);
  try {
    await mkdir(workspace, { recursive: true });
    const results = await Promise.all(sessionIds.map((sessionId) => runCaptureHook({
      hook_event_name: "UserPromptSubmit",
      session_id: sessionId,
      turn_id: `turn-${sessionId}`,
      transcript_path: join(root, `${sessionId}.jsonl`),
      cwd: workspace,
    }, { MEMORAX_CODE_HOME: memoraxCodeHome })));

    for (const result of results) assert.equal(result.code, 0, result.stderr);
    const registry = JSON.parse(await readFile(
      join(memoraxCodeHome, "adapters", "codex", "session-registry.json"),
      "utf8",
    ));
    const workspaces = JSON.parse(await readFile(
      join(memoraxCodeHome, "adapters", "codex", "workspaces.json"),
      "utf8",
    ));
    assert.equal(Object.keys(registry.sessions).length, sessionIds.length);
    for (const sessionId of sessionIds) {
      assert.equal(registry.sessions[sessionId].codexSessionId, sessionId);
      assert.equal(workspaces.sessions[sessionId].sessionId, sessionId);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("capture Hook falls back to HOME when MEMORAX_CODE_HOME is empty", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-codex-capture-empty-home-"));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  const memoraxCodeHome = join(home, ".memorax-code");
  try {
    await mkdir(workspace, { recursive: true });
    const result = await runCaptureHook({
      hook_event_name: "UserPromptSubmit",
      session_id: "empty-home-session",
      turn_id: "empty-home-turn",
      transcript_path: join(root, "empty-home-session.jsonl"),
      cwd: workspace,
    }, { HOME: home, MEMORAX_CODE_HOME: "" });

    assert.equal(result.code, 0, result.stderr);
    const registry = JSON.parse(await readFile(
      join(memoraxCodeHome, "adapters", "codex", "session-registry.json"),
      "utf8",
    ));
    const workspaces = JSON.parse(await readFile(
      join(memoraxCodeHome, "adapters", "codex", "workspaces.json"),
      "utf8",
    ));
    assert.equal(registry.sessions["empty-home-session"].codexSessionId, "empty-home-session");
    assert.equal(workspaces.sessions["empty-home-session"].sessionId, "empty-home-session");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent reminder Hooks emit and count one repeated turn only once", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-codex-reminder-concurrent-"));
  const memoraxCodeHome = join(root, "memorax-code");
  const input = {
    hook_event_name: "UserPromptSubmit",
    session_id: "concurrent-session",
    transcript_path: "/tmp/concurrent-session.jsonl",
    turn_id: "concurrent-turn",
    prompt: "same concurrent prompt",
  };
  try {
    const results = await Promise.all(Array.from(
      { length: 12 },
      () => runHook(input, { MEMORAX_CODE_HOME: memoraxCodeHome }),
    ));

    for (const result of results) assert.equal(result.code, 0, result.stderr);
    assert.equal(results.filter((result) => result.stdout !== "").length, 1);
    const state = JSON.parse(await readFile(
      join(memoraxCodeHome, "adapters", "codex", "memory-skill-reminders.json"),
      "utf8",
    ));
    assert.equal(state.sessions["concurrent-session"].turnCount, 1);
    assert.equal(state.sessions["concurrent-session"].lastTurnId, "concurrent-turn");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("memory skill reminder resets corrupt reminder state", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-codex-memory-reminder-corrupt-state-"));
  const memoraxCodeHome = join(root, "memorax-code");
  try {
    await writeRegistry(memoraxCodeHome, {
      "native-thread": {
        key: "native-thread",
        codexSessionId: "native-thread",
      },
    });
    const statePath = join(memoraxCodeHome, "adapters", "codex", "memory-skill-reminders.json");
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(statePath, "{not json");

    const result = await runHook({
      hook_event_name: "UserPromptSubmit",
      session_id: "native-thread",
      turn_id: "turn-after-corrupt-state",
      transcript_path: "/tmp/native-thread.jsonl",
      prompt: "prompt after corrupt state",
    }, { MEMORAX_CODE_HOME: memoraxCodeHome });

    assert.equal(result.code, 0, result.stderr);
    assertMemoryReminder(result.stdout);
    const state = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(state.runtime, "codex");
    assert.equal(state.sessions["native-thread"].turnCount, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("memory skill reminder accepts unregistered Codex sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-codex-memory-reminder-unregistered-"));
  const memoraxCodeHome = join(root, "memorax-code");
  try {
    const outputs = [];
    for (let index = 0; index < 6; index += 1) {
      outputs.push(await runHook({
        hook_event_name: "UserPromptSubmit",
        session_id: "unregistered-thread",
        turn_id: `turn-${index + 1}`,
        transcript_path: "/tmp/unregistered-thread.jsonl",
        prompt: `prompt ${index + 1}`,
      }, { MEMORAX_CODE_HOME: memoraxCodeHome }));
    }

    for (const result of outputs) assert.equal(result.code, 0, result.stderr);
    assertMemoryReminder(outputs[0].stdout);
    assert.equal(outputs[1].stdout, "");
    assert.equal(outputs[2].stdout, "");
    assert.equal(outputs[3].stdout, "");
    assert.equal(outputs[4].stdout, "");
    assertMemoryReminder(outputs[5].stdout);
    const state = JSON.parse(await readFile(join(memoraxCodeHome, "adapters", "codex", "memory-skill-reminders.json"), "utf8"));
    assert.equal(state.sessions["unregistered-thread"].turnCount, 6);
    await assert.rejects(readFile(join(memoraxCodeHome, "adapters", "codex", "session-registry.json"), "utf8"), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("memory skill reminder ignores pathless Codex turns without creating state", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-codex-memory-reminder-pathless-"));
  const memoraxCodeHome = join(root, "memorax-code");
  try {
    const result = await runHook({
      hook_event_name: "UserPromptSubmit",
      session_id: "background-thread",
      turn_id: "background-turn",
      prompt: "Generate hyperpersonalized suggestions.",
      transcript_path: " ",
    }, { MEMORAX_CODE_HOME: memoraxCodeHome });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "");
    await assert.rejects(readFile(join(memoraxCodeHome, "adapters", "codex", "memory-skill-reminders.json"), "utf8"), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function writeRegistry(memoraxCodeHome, sessions) {
  const registryPath = join(memoraxCodeHome, "adapters", "codex", "session-registry.json");
  await mkdir(dirname(registryPath), { recursive: true });
  await writeFile(registryPath, `${JSON.stringify({
    version: 1,
    runtime: "codex",
    sessions,
  }, null, 2)}\n`);
}

function reminderContext(stdout) {
  assert.notEqual(stdout, "");
  assert.equal(stdout.trim().split(/\r?\n/).length, 1);
  const payload = JSON.parse(stdout);
  assert.deepEqual(Object.keys(payload), ["hookSpecificOutput"]);
  assert.equal(payload.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  return payload.hookSpecificOutput.additionalContext;
}

function assertMemoryReminder(stdout) {
  const context = reminderContext(stdout);
  assert.equal(context, MEMORY_REMINDER_CONTEXT);
  assert.match(context, /proactively invoke/);
  assert.match(context, /follow the skill's router to decide whether any memory operation is needed/);
  assert.match(context, /repository-scoped personal memory/);
  assert.doesNotMatch(context, /repo memory/i);
  assert.match(context, /classify the authority before reading or writing/);
}

function assertProfileReminder(stdout) {
  const context = reminderContext(stdout);
  assert.equal(context, PROFILE_REMINDER_CONTEXT);
}

function assertCombinedReminder(stdout) {
  const context = reminderContext(stdout);
  assert.equal(context, `${MEMORY_REMINDER_CONTEXT}\n\n${PROFILE_REMINDER_CONTEXT}`);
}

function runHook(input, env = {}) {
  return runHookScript("memory-skill-reminder", input, env);
}

function runCaptureHook(input, env = {}) {
  return runHookScript("capture-cwd", input, env);
}

function runHookScript(component, input, env = {}) {
  return new Promise((resolve) => {
    const childEnv = { ...process.env };
    delete childEnv.MEMORAX_CODE_MEMORY_SKILL_REMINDER_INTERVAL_TURNS;
    delete childEnv.PLUGIN_DATA;
    childEnv.MEMORAX_CODE_BACKEND_URL = "http://127.0.0.1:1";
    childEnv.MEMORAX_CODE_CODEX_MEMORY_HOOK_TIMEOUT_MS = "100";
    Object.assign(childEnv, env);
    const child = spawn(process.execPath, [runtimeHookPath, component], {
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

async function waitForFile(path) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${path}`);
}
