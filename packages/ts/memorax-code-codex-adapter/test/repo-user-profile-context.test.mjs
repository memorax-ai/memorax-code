import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeHookPath = join(packageRoot, "hooks", "runtime-hook.mjs");
const hookPath = [runtimeHookPath, "memory-skill-reminder"];
const captureHookPath = [runtimeHookPath, "capture-cwd"];
const MEMORY_REMINDER_CONTEXT = "MemoraX Code reminder: proactively invoke $memorax-code whenever coding memory might help, even when uncertain; follow the skill's router to decide whether any memory operation is needed. Also use $memorax-code for repository-scoped personal memory, and classify the authority before reading or writing.";
const PROFILE_REMINDER_CONTEXT = "MemoraX Code personal-memory reminder: Use $memorax-code when the user states a durable current-repo identity or interaction preference, asks to list or recall stored personal memory, or explicitly asks to save, update, forget, or delete it. Route reusable action sequences and work rules to procedure memory; do not store repository facts, one-off task details, or secrets.";
const authorizedWorktreeOverrides = new Map();
const authorizedBackendRequests = [];
let authorizedBackendUrl;
const authorizedBackend = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += String(chunk);
  const parsed = body ? JSON.parse(body) : {};
  authorizedBackendRequests.push({ path: request.url, body: parsed });
  const repositoryWorktree = authorizedWorktreeOverrides.has(parsed.sessionId)
    ? authorizedWorktreeOverrides.get(parsed.sessionId)
    : parsed.cwd;
  const result = request.url === "/memory/turn-start" && repositoryWorktree
    ? { ok: true, repoMemoryWorktree: repositoryWorktree }
    : { ok: true };
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(result));
});

before(async () => {
  await new Promise((resolveListen) => authorizedBackend.listen(0, "127.0.0.1", resolveListen));
  authorizedBackendUrl = `http://127.0.0.1:${authorizedBackend.address().port}`;
});

after(async () => {
  await new Promise((resolveClose) => authorizedBackend.close(resolveClose));
});

test("active preferences join the first prompt and the first prompt after compact", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-user-profile-context-lifecycle-"));
  try {
    const repo = await createRepo(root, "lifecycle");
    const memoraxCodeHome = join(root, "memorax-code");
    await writeRegistry(memoraxCodeHome, "native-thread");
    await writeFile(join(memoraxCodeHome, "config.toml"), "[memory.skill_reminder]\ninterval_turns = 3\n");
    await writePreferences(repo, [
      preference("pref_language", "用户偏好使用中文交流。", "与用户交流时。", "用户明确要求其他语言。"),
      preference("pref_summary", "用户偏好先给出结论。", "汇报实现或诊断结果时。", "用户要求展开推导过程时。"),
    ]);

    const outputs = [];
    for (let turn = 1; turn <= 4; turn += 1) {
      outputs.push(await runHook(hookPath, {
        hook_event_name: "UserPromptSubmit",
        session_id: "native-thread",
        transcript_path: "/tmp/native-thread.jsonl",
        turn_id: `turn-${turn}`,
        cwd: repo,
        prompt: `prompt ${turn}`,
      }, { MEMORAX_CODE_HOME: memoraxCodeHome }));
    }

    const firstContext = reminderContext(outputs[0].stdout);
    assert.ok(firstContext.includes(MEMORY_REMINDER_CONTEXT));
    assert.ok(firstContext.includes(PROFILE_REMINDER_CONTEXT));
    assert.ok(firstContext.includes("Active repo-scoped user preferences"));
    assert.ok(firstContext.indexOf(MEMORY_REMINDER_CONTEXT) < firstContext.indexOf(PROFILE_REMINDER_CONTEXT));
    assert.ok(firstContext.indexOf(PROFILE_REMINDER_CONTEXT) < firstContext.indexOf("Active repo-scoped user preferences"));
    assert.match(firstContext, /Description: 用户偏好使用中文交流。/);
    assert.match(firstContext, /Applies when: 与用户交流时。/);
    assert.match(firstContext, /Do not apply when: 用户明确要求其他语言。/);
    assert.match(firstContext, /Description: 用户偏好先给出结论。/);
    assert.match(firstContext, /Natural final-answer mention for supported coding agents:/);
    assert.match(firstContext, /begin the final answer with one brief opening paragraph/);
    assert.match(firstContext, /successful explicit `memorax-cli search`/);
    assert.match(firstContext, /automatic Coding Memory retrieval/);
    assert.doesNotMatch(firstContext, /memorax-impact/);
    for (const index of [1, 2]) assert.equal(outputs[index].stdout, "");
    const laterCadenceContext = reminderContext(outputs[3].stdout);
    assert.equal(laterCadenceContext, MEMORY_REMINDER_CONTEXT);

    await runHook(captureHookPath, {
      hook_event_name: "SessionStart",
      session_id: "native-thread",
      source: "compact",
      cwd: repo,
    }, { MEMORAX_CODE_HOME: memoraxCodeHome });
    const afterCompact = await runHook(hookPath, {
      hook_event_name: "UserPromptSubmit",
      session_id: "native-thread",
      transcript_path: "/tmp/native-thread.jsonl",
      turn_id: "turn-5",
      cwd: repo,
      prompt: "prompt after compact",
    }, { MEMORAX_CODE_HOME: memoraxCodeHome });
    const following = await runHook(hookPath, {
      hook_event_name: "UserPromptSubmit",
      session_id: "native-thread",
      transcript_path: "/tmp/native-thread.jsonl",
      turn_id: "turn-6",
      cwd: repo,
      prompt: "following prompt",
    }, { MEMORAX_CODE_HOME: memoraxCodeHome });

    const compactContext = reminderContext(afterCompact.stdout);
    assert.match(compactContext, new RegExp(`^${escapeRegex(PROFILE_REMINDER_CONTEXT)}`));
    assert.doesNotMatch(compactContext, /^MemoraX Code reminder:/);
    assert.match(compactContext, /Description: 用户偏好使用中文交流。/);
    assert.match(compactContext, /Natural final-answer mention for supported coding agents:/);
    assert.doesNotMatch(compactContext, /memorax-impact/);
    assert.equal(following.stdout, "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("empty preferences preserve the existing reminder payloads", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-user-profile-context-empty-"));
  try {
    const repo = await createRepo(root, "empty");
    const memoraxCodeHome = join(root, "memorax-code");
    await writeRegistry(memoraxCodeHome, "native-thread");
    await writePreferences(repo, []);

    const first = await runHook(hookPath, {
      hook_event_name: "UserPromptSubmit",
      session_id: "native-thread",
      transcript_path: "/tmp/native-thread.jsonl",
      turn_id: "turn-1",
      cwd: repo,
      prompt: "first prompt",
    }, { MEMORAX_CODE_HOME: memoraxCodeHome });
    assert.equal(reminderContext(first.stdout), MEMORY_REMINDER_CONTEXT);

    await runHook(captureHookPath, {
      hook_event_name: "SessionStart",
      session_id: "native-thread",
      source: "compact",
      cwd: repo,
    }, { MEMORAX_CODE_HOME: memoraxCodeHome });
    const afterCompact = await runHook(hookPath, {
      hook_event_name: "UserPromptSubmit",
      session_id: "native-thread",
      transcript_path: "/tmp/native-thread.jsonl",
      turn_id: "turn-2",
      cwd: repo,
      prompt: "prompt after compact",
    }, { MEMORAX_CODE_HOME: memoraxCodeHome });
    assert.equal(reminderContext(afterCompact.stdout), PROFILE_REMINDER_CONTEXT);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preference and procedure contexts stay in one ordered payload", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-user-profile-context-combined-"));
  try {
    const repo = await createRepo(root, "combined");
    const memoraxCodeHome = join(root, "memorax-code");
    await writeRegistry(memoraxCodeHome, "native-thread");
    await writePreferences(repo, [
      preference("pref_language", "用户偏好使用中文交流。", "与用户交流时。", "用户明确要求其他语言。"),
    ]);
    await writeProcedure(repo, "pull-request.md", "# Pull Request\n\n1. Create pull requests as drafts.");

    const result = await runHook(hookPath, {
      hook_event_name: "UserPromptSubmit",
      session_id: "native-thread",
      transcript_path: "/tmp/native-thread.jsonl",
      turn_id: "turn-1",
      cwd: repo,
      prompt: "first prompt",
    }, { MEMORAX_CODE_HOME: memoraxCodeHome });

    const context = reminderContext(result.stdout);
    assert.ok(context.includes(MEMORY_REMINDER_CONTEXT));
    assert.ok(context.includes(PROFILE_REMINDER_CONTEXT));
    assert.ok(context.includes("Active repo-scoped user preferences"));
    assert.ok(context.includes("Active repo-scoped procedure memories"));
    assert.ok(context.indexOf(MEMORY_REMINDER_CONTEXT) < context.indexOf(PROFILE_REMINDER_CONTEXT));
    assert.ok(context.indexOf(PROFILE_REMINDER_CONTEXT) < context.indexOf("Active repo-scoped user preferences"));
    assert.ok(context.indexOf("Active repo-scoped user preferences") < context.indexOf("Active repo-scoped procedure memories"));
    assert.equal(result.stdout.trim().split(/\r?\n/).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repo-scoped contexts use the Backend-authorized worktree and trace the injected content", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-personal-memory-scope-"));
  const unavailableSession = "scope-unavailable";
  const authorizedSession = "scope-authorized";
  try {
    const hookRepo = await createRepo(root, "hook-scope");
    const authorizedRepo = await createRepo(root, "authorized-scope");
    const memoraxCodeHome = join(root, "memorax-code");
    await writePreferences(hookRepo, [
      preference("pref_hook", "hook repo profile must not appear", "always", "never"),
    ]);
    await writeProcedure(hookRepo, "hook.md", "# Hook repo procedure must not appear");
    await writePreferences(authorizedRepo, [
      preference("pref_authorized", "authorized repo profile", "always", "never"),
    ]);
    await writeProcedure(authorizedRepo, "authorized.md", "# Authorized repo procedure");
    authorizedWorktreeOverrides.set(unavailableSession, undefined);
    authorizedWorktreeOverrides.set(authorizedSession, authorizedRepo);

    const unavailable = await runHook(hookPath, {
      hook_event_name: "UserPromptSubmit",
      session_id: unavailableSession,
      transcript_path: "/tmp/scope-unavailable.jsonl",
      turn_id: "turn-unavailable",
      cwd: hookRepo,
      prompt: "prompt without repository authority",
    }, { MEMORAX_CODE_HOME: memoraxCodeHome });
    assert.equal(reminderContext(unavailable.stdout), MEMORY_REMINDER_CONTEXT);

    const authorized = await runHook(hookPath, {
      hook_event_name: "UserPromptSubmit",
      session_id: authorizedSession,
      transcript_path: "/tmp/scope-authorized.jsonl",
      turn_id: "turn-authorized",
      cwd: hookRepo,
      prompt: "prompt with repository authority",
    }, { MEMORAX_CODE_HOME: memoraxCodeHome });
    const authorizedContext = reminderContext(authorized.stdout);
    assert.match(authorizedContext, /Description: authorized repo profile/);
    assert.match(authorizedContext, /Authorized repo procedure/);
    assert.doesNotMatch(authorizedContext, /hook repo profile must not appear/);
    assert.doesNotMatch(authorizedContext, /Hook repo procedure must not appear/);

    const unavailableRequests = authorizedBackendRequests.filter(
      (request) => request.body.sessionId === unavailableSession,
    );
    assert.deepEqual(unavailableRequests.map((request) => request.path), [
      "/memory/turn-start",
      "/memory/skill-reminder",
    ]);
    assert.equal(unavailableRequests[1].body.cwd, hookRepo);
    assert.equal(unavailableRequests[1].body.content, MEMORY_REMINDER_CONTEXT);
    assert.deepEqual(unavailableRequests[1].body.triggers, ["cadence"]);
    const authorizedRequests = authorizedBackendRequests.filter(
      (request) => request.body.sessionId === authorizedSession,
    );
    assert.deepEqual(authorizedRequests.map((request) => request.path), [
      "/memory/turn-start",
      "/memory/skill-reminder",
    ]);
    assert.equal(authorizedRequests[1].body.cwd, hookRepo);
    assert.equal(authorizedRequests[1].body.content, authorizedContext);
    assert.deepEqual(authorizedRequests[1].body.triggers, ["cadence"]);
  } finally {
    authorizedWorktreeOverrides.delete(unavailableSession);
    authorizedWorktreeOverrides.delete(authorizedSession);
    await rm(root, { recursive: true, force: true });
  }
});

function preference(id, description, appliesWhen, doNotApplyWhen) {
  return {
    id,
    type: "communication",
    status: "active",
    description,
    appliesWhen,
    doNotApplyWhen,
  };
}

async function writePreferences(repo, entries) {
  const directory = join(repo, ".repo_memory", "user-profile");
  await mkdir(directory, { recursive: true });
  await writeFile(join(repo, ".gitignore"), ".repo_memory/\n");
  const activeCount = entries.filter((entry) => entry.status === "active").length;
  const blocks = entries.map((entry) => [
    `## Preference ${entry.id}`,
    "",
    `- Type: \`${entry.type}\``,
    `- Status: \`${entry.status}\``,
    "- Confidence: `user_stated`",
    "- Created: `2026-07-18T00:00:00.000Z`",
    "- Updated: `2026-07-18T00:00:00.000Z`",
    `- Description: ${entry.description}`,
    `- Applies when: ${entry.appliesWhen || "-"}`,
    `- Do not apply when: ${entry.doNotApplyWhen || "-"}`,
    `- Raw lookup: \`preferenceId=${entry.id}\``,
  ].join("\n"));
  const text = [
    "---",
    'schema: "repo_user_profile_memory.v0.1"',
    'scope: "repo"',
    'owner: "repo-user-profile-memory"',
    'trust_state: "user_stated"',
    'updated_at: "2026-07-18T00:00:00.000Z"',
    `active_count: ${activeCount}`,
    `total_count: ${entries.length}`,
    "---",
    "",
    "# Repo-Scoped User Profile And Preferences",
    "",
    "## Active Preferences",
    "",
    blocks.join("\n\n---\n\n"),
    "",
  ].join("\n");
  await writeFile(join(directory, "preferences.md"), text);
}

async function writeProcedure(repo, name, content) {
  const directory = join(repo, ".repo_memory", "procedure-memory");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, name), `${content.trim()}\n`);
}

async function createRepo(root, name) {
  const repo = join(root, `repo-${name}`);
  await mkdir(repo);
  runGit(repo, ["init", "-b", "main"]);
  await writeFile(join(repo, "README.md"), "# Test repo\n");
  runGit(repo, ["add", "README.md"]);
  runGit(repo, ["commit", "-m", "initial docs"]);
  return repo;
}

function runGit(cwd, args) {
  const result = spawnSync(
    "git",
    ["-c", "user.name=Profile Test", "-c", "user.email=profile-test@example.invalid", ...args],
    { cwd, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

async function writeRegistry(memoraxCodeHome, sessionId) {
  const registryPath = join(memoraxCodeHome, "adapters", "codex", "session-registry.json");
  await mkdir(dirname(registryPath), { recursive: true });
  await writeFile(registryPath, `${JSON.stringify({
    version: 1,
    runtime: "codex",
    sessions: {
      [sessionId]: { key: sessionId, codexSessionId: sessionId },
    },
  }, null, 2)}\n`);
}

function reminderContext(stdout) {
  assert.notEqual(stdout, "");
  assert.equal(stdout.trim().split(/\r?\n/).length, 1);
  return JSON.parse(stdout).hookSpecificOutput.additionalContext;
}

function runHook(command, input, env) {
  return new Promise((resolveResult) => {
    const childEnv = { ...process.env };
    delete childEnv.MEMORAX_CODE_MEMORY_SKILL_REMINDER_INTERVAL_TURNS;
    delete childEnv.PLUGIN_DATA;
    childEnv.MEMORAX_CODE_BACKEND_URL = authorizedBackendUrl;
    childEnv.MEMORAX_CODE_CODEX_MEMORY_HOOK_TIMEOUT_MS = "100";
    Object.assign(childEnv, env);
    const child = spawn(process.execPath, command, {
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("close", (code) => resolveResult({ code, stdout, stderr }));
    child.stdin.end(`${JSON.stringify(input)}\n`);
  });
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
