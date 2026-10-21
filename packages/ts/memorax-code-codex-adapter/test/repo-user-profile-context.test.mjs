import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
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
const MEMORY_REMINDER_CONTEXT = "MemoraX Code reminder: proactively invoke $memorax-code whenever coding memory might help, even when uncertain; follow the skill's router to decide whether any memory operation is needed. Also use $memorax-code for global personal memory, including working rules or preferences the user wants kept, and classify the authority before reading or writing. When a personal-memory save accompanies another task, write it only after every task action has finished, do not mention the planned save in preambles or progress messages, and report it only at the end of the final answer.";
const PROFILE_REMINDER_CONTEXT = "MemoraX Code personal-memory reminder: Use $memorax-code when the user states a working rule or preference meant to keep applying after the current task, judged by intent rather than by trigger words such as remember, or asks to list, recall, update, forget, or delete personal memory. Route how-to-work rules to procedure memory and communication or presentation preferences to profile memory; do not store repository facts, one-off task details, or secrets. When a personal-memory save accompanies another task, write it only after every task action has finished, do not mention the planned save in preambles or progress messages, and report it only at the end of the final answer.";
const authorizedWorktreeOverrides = new Map();
const authorizedGuidanceDecisions = new Map();
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
  const guidanceDecision = authorizedGuidanceDecisions.get(parsed.sessionId)?.get(parsed.turnId);
  const result = request.url === "/memory/search-guidance"
    ? guidanceDecision ? { ok: true, decision: guidanceDecision } : { ok: false, reason: "disabled" }
    : request.url === "/memory/turn-start" && repositoryWorktree
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
    const repo = await createWorkspace(root, "lifecycle");
    const memoraxCodeHome = join(root, "memorax-code");
    await writeRegistry(memoraxCodeHome, "native-thread");
    await writeFile(join(memoraxCodeHome, "config.toml"), "[memory.skill_reminder]\ninterval_turns = 3\n");
    await writePreferences(memoraxCodeHome, [
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
    assert.ok(firstContext.includes("Active user-scoped preferences"));
    assert.ok(firstContext.indexOf(MEMORY_REMINDER_CONTEXT) < firstContext.indexOf(PROFILE_REMINDER_CONTEXT));
    assert.ok(firstContext.indexOf(PROFILE_REMINDER_CONTEXT) < firstContext.indexOf("Active user-scoped preferences"));
    assert.match(firstContext, /Description: 用户偏好使用中文交流。/);
    assert.match(firstContext, /Applies when: 与用户交流时。/);
    assert.match(firstContext, /Do not apply when: 用户明确要求其他语言。/);
    assert.match(firstContext, /Description: 用户偏好先给出结论。/);
    assert.match(firstContext, /Natural final-answer mention for supported coding agents:/);
    assert.match(firstContext, /begin the final answer with one brief opening paragraph/);
    assert.match(firstContext, /successful explicit `memorax-cli search`/);
    assert.match(firstContext, /Do not report active Add, automatic writeback, or Repo Memory build or update/);
    assert.match(firstContext, /A personal-memory save, update, or deletion made in the current turn is not memory that helped the current turn/);
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
    const repo = await createWorkspace(root, "empty");
    const memoraxCodeHome = join(root, "memorax-code");
    await writeRegistry(memoraxCodeHome, "native-thread");
    await writePreferences(memoraxCodeHome, []);

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
    const repo = await createWorkspace(root, "combined");
    const memoraxCodeHome = join(root, "memorax-code");
    await writeRegistry(memoraxCodeHome, "native-thread");
    await writePreferences(memoraxCodeHome, [
      preference("pref_language", "用户偏好使用中文交流。", "与用户交流时。", "用户明确要求其他语言。"),
    ]);
    await writeProcedure(memoraxCodeHome, "pull-request.md", "# Pull Request\n\n1. Create pull requests as drafts.");

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
    assert.ok(context.includes("Active user-scoped preferences"));
    assert.ok(context.includes("Active user-scoped procedure memories"));
    assert.ok(context.indexOf(MEMORY_REMINDER_CONTEXT) < context.indexOf(PROFILE_REMINDER_CONTEXT));
    assert.ok(context.indexOf(PROFILE_REMINDER_CONTEXT) < context.indexOf("Active user-scoped preferences"));
    assert.ok(context.indexOf("Active user-scoped preferences") < context.indexOf("Active user-scoped procedure memories"));
    assert.equal(result.stdout.trim().split(/\r?\n/).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("global personal contexts ignore the native workspace and trace the injected content", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-personal-memory-scope-"));
  const unavailableSession = "scope-unavailable";
  const authorizedSession = "scope-authorized";
  try {
    const hookRepo = await createWorkspace(root, "hook-scope");
    const otherWorkspace = await createWorkspace(root, "other-scope");
    const memoraxCodeHome = join(root, "memorax-code");
    await writePreferences(memoraxCodeHome, [
      preference("pref_global", "global profile", "always", "never"),
    ]);
    await writeProcedure(memoraxCodeHome, "global.md", "# Global procedure");
    authorizedWorktreeOverrides.set(unavailableSession, undefined);
    authorizedWorktreeOverrides.set(authorizedSession, undefined);

    const unavailable = await runHook(hookPath, {
      hook_event_name: "UserPromptSubmit",
      session_id: unavailableSession,
      transcript_path: "/tmp/scope-unavailable.jsonl",
      turn_id: "turn-unavailable",
      cwd: hookRepo,
      prompt: "prompt without repository authority",
    }, { MEMORAX_CODE_HOME: memoraxCodeHome });
    const unavailableContext = reminderContext(unavailable.stdout);
    assert.match(unavailableContext, /Description: global profile/);
    assert.match(unavailableContext, /Global procedure/);

    const authorized = await runHook(hookPath, {
      hook_event_name: "UserPromptSubmit",
      session_id: authorizedSession,
      transcript_path: "/tmp/scope-authorized.jsonl",
      turn_id: "turn-authorized",
      cwd: otherWorkspace,
      prompt: "prompt in an unrelated workspace",
    }, { MEMORAX_CODE_HOME: memoraxCodeHome });
    const authorizedContext = reminderContext(authorized.stdout);
    assert.match(authorizedContext, /Description: global profile/);
    assert.match(authorizedContext, /Global procedure/);
    assert.doesNotMatch(authorizedContext, /repo profile|repo procedure/);

    const unavailableRequests = authorizedBackendRequests.filter(
      (request) => request.body.sessionId === unavailableSession,
    );
    assert.deepEqual(unavailableRequests.map((request) => request.path), [
      "/memory/turn-start",
      "/memory/search-guidance",
      "/memory/skill-reminder",
    ]);
    assert.deepEqual(unavailableRequests[1].body, unavailableRequests[0].body);
    assert.equal(unavailableRequests[2].body.cwd, hookRepo);
    assert.equal(unavailableRequests[2].body.content, unavailableContext);
    assert.deepEqual(unavailableRequests[2].body.triggers, ["cadence"]);
    const authorizedRequests = authorizedBackendRequests.filter(
      (request) => request.body.sessionId === authorizedSession,
    );
    assert.deepEqual(authorizedRequests.map((request) => request.path), [
      "/memory/turn-start",
      "/memory/search-guidance",
      "/memory/skill-reminder",
    ]);
    assert.deepEqual(authorizedRequests[1].body, authorizedRequests[0].body);
    assert.equal(authorizedRequests[2].body.cwd, otherWorkspace);
    assert.equal(authorizedRequests[2].body.content, authorizedContext);
    assert.deepEqual(authorizedRequests[2].body.triggers, ["cadence"]);
  } finally {
    authorizedWorktreeOverrides.delete(unavailableSession);
    authorizedWorktreeOverrides.delete(authorizedSession);
    await rm(root, { recursive: true, force: true });
  }
});


test("Codex injects global personal memory when Turn registration fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-personal-memory-registration-"));
  let fixture;
  const requests = [];
  const backend = createServer((request, response) => {
    request.resume();
    requests.push(request.url);
    response.writeHead(fixture.status, { "content-type": "application/json" });
    response.end(fixture.body);
  });
  await new Promise((resolveListen) => backend.listen(0, "127.0.0.1", resolveListen));
  try {
    for (fixture of [
      { name: "http-rejected", status: 503, body: '{"ok":false}' },
      { name: "body-rejected", status: 200, body: '{"ok":false}' },
      { name: "invalid-body", status: 200, body: "invalid JSON" },
      { name: "unavailable", url: "http://127.0.0.1:1" },
    ]) {
      const memoraxCodeHome = join(root, fixture.name);
      await writePreferences(memoraxCodeHome, [preference("pref_global", "Global preference", "Always", "Never")]);
      await writeProcedure(memoraxCodeHome, "global.md", "# Global procedure");
      requests.length = 0;
      const result = await runHook(hookPath, {
        hook_event_name: "UserPromptSubmit",
        session_id: fixture.name,
        transcript_path: join(root, "session.jsonl"),
        turn_id: "turn-1",
        cwd: root,
        prompt: "First prompt",
      }, {
        MEMORAX_CODE_HOME: memoraxCodeHome,
        MEMORAX_CODE_BACKEND_URL: fixture.url ?? `http://127.0.0.1:${backend.address().port}`,
      });
      assert.equal(result.code, 0, result.stderr);
      const context = reminderContext(result.stdout);
      assert.ok(context.startsWith(MEMORY_REMINDER_CONTEXT), fixture.name);
      assert.ok(context.includes(PROFILE_REMINDER_CONTEXT), fixture.name);
      assert.match(context, /Description: Global preference/, fixture.name);
      assert.match(context, /# Global procedure/, fixture.name);
      // Search guidance and the reminder trace still require an accepted Turn.
      assert.deepEqual(requests, fixture.url ? [] : ["/memory/turn-start"]);
    }
  } finally {
    await new Promise((resolveClose) => backend.close(resolveClose));
    await rm(root, { recursive: true, force: true });
  }
});

test("native Codex prompts evaluate Jev independently of personal-memory cadence and skip duplicates", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-jev-native-hook-"));
  const sessionId = "jev-native-thread";
  authorizedGuidanceDecisions.set(sessionId, new Map([
    ["turn-1", "skip"], ["turn-2", "search"], ["turn-3", "skip"], ["turn-4", "skip"],
  ]));
  try {
    const repo = await createWorkspace(root, "jev");
    const memoraxCodeHome = join(root, "memorax-code");
    await writeRegistry(memoraxCodeHome, sessionId);
    await writeFile(join(memoraxCodeHome, "config.toml"), "[memory.skill_reminder]\ninterval_turns = 3\n");
    await writePreferences(memoraxCodeHome, [preference("pref_jev", "Prefer concise fixture responses.", "Always.", "")]);
    await writeProcedure(memoraxCodeHome, "fixture-testing.md", "# Fixture testing\n\nRun the focused fixture test first.");
    const prompt = (turn) => runHook(hookPath, {
      hook_event_name: "UserPromptSubmit", session_id: sessionId, turn_id: "turn-" + turn,
      transcript_path: join(root, "session.jsonl"), cwd: repo, prompt: "Task " + turn,
    }, { MEMORAX_CODE_HOME: memoraxCodeHome, HOME: root, USERPROFILE: root });

    const first = await prompt(1);
    assert.equal(first.code, 0, first.stderr);
    const firstContext = reminderContext(first.stdout);
    assert.match(firstContext, /Prefer concise fixture responses/);
    assert.match(firstContext, /Run the focused fixture test first/);
    assert.doesNotMatch(firstContext, /proactively invoke|Jev selected/);

    const second = await prompt(2);
    assert.equal(second.code, 0, second.stderr);
    const secondContext = reminderContext(second.stdout);
    assert.match(secondContext, /Jev selected Coding Memory search/);
    assert.match(secondContext, /\$memorax-code/);
    assert.match(secondContext, /references\/memorax-search\.md/);
    assert.doesNotMatch(secondContext, /search --query|without rereading/);
    assert.doesNotMatch(secondContext, /proactively invoke|personal-memory reminder|Prefer concise fixture responses|Run the focused fixture test first/);
    const duplicate = await prompt(2);
    assert.equal(duplicate.code, 0, duplicate.stderr);
    assert.equal(duplicate.stdout, "");
    const third = await prompt(3);
    assert.equal(third.code, 0, third.stderr);
    assert.equal(third.stdout, "");

    const fourth = await prompt(4);
    assert.equal(fourth.code, 0, fourth.stderr);
    const fourthContext = reminderContext(fourth.stdout);
    assert.match(fourthContext, /Run the focused fixture test first/);
    assert.doesNotMatch(fourthContext, /Prefer concise fixture responses|proactively invoke|Jev selected/);
    const requests = authorizedBackendRequests.filter(({ body }) => body.sessionId === sessionId);
    const guidance = requests.filter(({ path }) => path === "/memory/search-guidance");
    assert.deepEqual(guidance.map(({ body }) => body.turnId), ["turn-1", "turn-2", "turn-3", "turn-4"]);
    for (const { body } of guidance) {
      assert.deepEqual(body, requests.find((request) => request.path === "/memory/turn-start" && request.body.turnId === body.turnId).body);
    }
    assert.deepEqual(requests.filter(({ path }) => path === "/memory/skill-reminder").map(({ body }) => body.triggers), [
      ["search_guidance", "cadence"], ["search_guidance"], ["search_guidance", "cadence"],
    ]);
  } finally {
    authorizedGuidanceDecisions.delete(sessionId);
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

async function writePreferences(memoraxCodeHome, entries) {
  const directory = join(memoraxCodeHome, "personal-memory", "user-profile");
  await mkdir(directory, { recursive: true });
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
    'schema: "user_profile_memory.v0.1"',
    'scope: "user"',
    'owner: "user-profile-memory"',
    'trust_state: "user_stated"',
    'updated_at: "2026-07-18T00:00:00.000Z"',
    `active_count: ${activeCount}`,
    `total_count: ${entries.length}`,
    "---",
    "",
    "# User Profile And Preferences",
    "",
    "## Active Preferences",
    "",
    blocks.join("\n\n---\n\n"),
    "",
  ].join("\n");
  await writeFile(join(directory, "preferences.md"), text);
}

async function writeProcedure(memoraxCodeHome, name, content) {
  const directory = join(memoraxCodeHome, "personal-memory", "procedure-memory");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, name), `${content.trim()}\n`);
}

async function createWorkspace(root, name) {
  const repo = join(root, `repo-${name}`);
  await mkdir(repo);
  await writeFile(join(repo, "README.md"), "# Test repo\n");
  return repo;
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
