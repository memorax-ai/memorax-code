import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeHookPath = join(packageRoot, "hooks", "runtime-hook.mjs");
const hookPath = [runtimeHookPath, "memory-skill-reminder"];
const captureHookPath = [runtimeHookPath, "capture-cwd"];
let authorizedBackendUrl;
const authorizedBackend = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += String(chunk);
  const parsed = body ? JSON.parse(body) : {};
  const result = request.url === "/memory/turn-start" && typeof parsed.cwd === "string"
    ? { ok: true, repoMemoryWorktree: parsed.cwd }
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

test("multiple procedure files join the existing first and sixth turn cadence", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-procedure-context-cadence-"));
  try {
    const repo = await createRepo(root);
    const memoraxCodeHome = join(root, "memorax-code");
    await writeRegistry(memoraxCodeHome, "native-thread");
    await writeProcedure(repo, "reading-code.md", "# Reading Code\n\n1. Trace the public entry point.");
    await writeProcedure(repo, "writing-code.md", "# Writing Code\n\n1. Add the focused test first.");

    const outputs = [];
    for (let turn = 1; turn <= 6; turn += 1) {
      outputs.push(await runHook(hookPath, {
        hook_event_name: "UserPromptSubmit",
        session_id: "native-thread",
        transcript_path: "/tmp/native-thread.jsonl",
        turn_id: `turn-${turn}`,
        cwd: repo,
        prompt: `prompt ${turn}`,
      }, { MEMORAX_CODE_HOME: memoraxCodeHome }));
    }

    for (const output of outputs) assert.equal(output.code, 0, output.stderr);
    for (const index of [1, 2, 3, 4]) assert.equal(outputs[index].stdout, "");
    for (const index of [0, 5]) {
      const context = reminderContext(outputs[index].stdout);
      assert.match(context, /^MemoraX Code reminder:/);
      assert.match(context, /### reading-code\.md/);
      assert.match(context, /Trace the public entry point/);
      assert.match(context, /### writing-code\.md/);
      assert.match(context, /Add the focused test first/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("profile and procedure reminders stay in one ordered payload", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-procedure-context-combined-"));
  try {
    const repo = await createRepo(root);
    const memoraxCodeHome = join(root, "memorax-code");
    await writeRegistry(memoraxCodeHome, "native-thread");
    await mkdir(memoraxCodeHome, { recursive: true });
    await writeFile(join(memoraxCodeHome, "config.toml"), "[memory.skill_reminder]\ninterval_turns = 1\n");
    await writeProcedure(repo, "reading-papers.md", "# Reading Papers\n\n1. Identify the main claim.");

    await runHook(captureHookPath, {
      hook_event_name: "UserPromptSubmit",
      session_id: "native-thread",
      turn_id: "turn-0",
      transcript_path: "/tmp/native-thread.jsonl",
      cwd: repo,
    }, { MEMORAX_CODE_HOME: memoraxCodeHome });
    await runHook(captureHookPath, {
      hook_event_name: "SessionStart",
      session_id: "native-thread",
      source: "compact",
      cwd: repo,
    }, { MEMORAX_CODE_HOME: memoraxCodeHome });
    const result = await runHook(hookPath, {
      hook_event_name: "UserPromptSubmit",
      session_id: "native-thread",
      transcript_path: "/tmp/native-thread.jsonl",
      turn_id: "turn-1",
      cwd: repo,
      prompt: "prompt after compact",
    }, { MEMORAX_CODE_HOME: memoraxCodeHome });

    const context = reminderContext(result.stdout);
    assert.ok(context.indexOf("MemoraX Code reminder:") < context.indexOf("MemoraX Code personal-memory reminder:"));
    assert.ok(context.indexOf("MemoraX Code personal-memory reminder:") < context.indexOf("### reading-papers.md"));
    assert.equal(result.stdout.trim().split(/\r?\n/).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tracked unignored symlinked and oversized procedure files are skipped", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-procedure-context-untrusted-"));
  const cases = [
    ["tracked", async (repo) => runGit(repo, ["add", "-f", ".repo_memory/procedure-memory/writing-code.md"])],
    ["unignored", async (repo) => writeFile(join(repo, ".gitignore"), "node_modules/\n")],
    ["symlinked", async (repo, path) => {
      const target = join(repo, ".repo_memory", "procedure-memory", "target.txt");
      await rename(path, target);
      await symlink(target, path);
    }],
    ["symlinked-parent", async (repo, path) => {
      const directory = dirname(path);
      const target = join(repo, "procedure-memory-target");
      await rename(directory, target);
      await symlink(target, directory);
    }],
    ["oversized", async (_repo, path) => writeFile(path, "x".repeat((16 * 1024) + 1))],
  ];

  try {
    for (const [name, mutate] of cases) {
      const repo = await createRepo(root);
      const memoraxCodeHome = join(root, `memorax-code-${name}`);
      const sessionId = `session-${name}`;
      const relativePath = ".repo_memory/procedure-memory/writing-code.md";
      const path = join(repo, relativePath);
      await writeRegistry(memoraxCodeHome, sessionId);
      await writeProcedure(repo, "writing-code.md", `# ${name} content must not appear`);
      await mutate(repo, path);

      const result = await runHook(hookPath, {
        hook_event_name: "UserPromptSubmit",
        session_id: sessionId,
        turn_id: `turn-${name}`,
        transcript_path: `/tmp/${sessionId}.jsonl`,
        cwd: repo,
        prompt: "first prompt",
      }, { MEMORAX_CODE_HOME: memoraxCodeHome });
      const context = reminderContext(result.stdout);
      assert.match(context, /^MemoraX Code reminder:/);
      assert.doesNotMatch(context, new RegExp(`${name} content must not appear`));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("one unreadable procedure file does not hide other valid topics", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-procedure-context-unreadable-"));
  try {
    const repo = await createRepo(root);
    const memoraxCodeHome = join(root, "memorax-code");
    await writeRegistry(memoraxCodeHome, "native-thread");
    await writeProcedure(repo, "reading-code.md", "# Reading Code\n\n1. Keep this valid topic visible.");
    await writeProcedure(repo, "writing-code.md", "# Writing Code\n\n1. This topic cannot be read.");
    await chmod(join(repo, ".repo_memory", "procedure-memory", "writing-code.md"), 0o000);

    const result = await runHook(hookPath, {
      hook_event_name: "UserPromptSubmit",
      session_id: "native-thread",
      turn_id: "turn-1",
      transcript_path: "/tmp/native-thread.jsonl",
      cwd: repo,
      prompt: "first prompt",
    }, { MEMORAX_CODE_HOME: memoraxCodeHome });
    const context = reminderContext(result.stdout);
    assert.match(context, /Keep this valid topic visible/);
    assert.doesNotMatch(context, /This topic cannot be read/);
    assert.match(context, /Additional procedure memory was omitted/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("procedure context remains bounded", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-procedure-context-limit-"));
  try {
    const repo = await createRepo(root);
    const memoraxCodeHome = join(root, "memorax-code");
    await writeRegistry(memoraxCodeHome, "native-thread");
    await writeProcedure(repo, "reading-code.md", `# Reading Code\n\n${"step ".repeat(1800)}`);

    const result = await runHook(hookPath, {
      hook_event_name: "UserPromptSubmit",
      session_id: "native-thread",
      turn_id: "turn-1",
      transcript_path: "/tmp/native-thread.jsonl",
      cwd: repo,
      prompt: "first prompt",
    }, { MEMORAX_CODE_HOME: memoraxCodeHome });
    const context = reminderContext(result.stdout);
    const procedureContext = context.slice(context.indexOf("Active repo-scoped procedure memories"));
    assert.match(procedureContext, /Additional procedure memory was omitted/);
    assert.ok(procedureContext.length <= 4000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function createRepo(root) {
  const repo = join(root, `repo-${Math.random().toString(16).slice(2)}`);
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
    ["-c", "user.name=Procedure Test", "-c", "user.email=procedure-test@example.invalid", ...args],
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
