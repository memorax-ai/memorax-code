import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeHookPath = join(packageRoot, "hooks", "runtime-hook.mjs");
const hookPath = [runtimeHookPath, "memory-skill-reminder"];
const captureHookPath = [runtimeHookPath, "capture-cwd"];
let authorizedBackendUrl;
const authorizedBackend = createServer((request, response) => {
  request.resume();
  const result = { ok: true };
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

test("multiple procedure files join the first prompt and configured reminder cadence", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-procedure-context-cadence-"));
  try {
    const repo = await createWorkspace(root);
    const memoraxCodeHome = join(root, "memorax-code");
    await writeRegistry(memoraxCodeHome, "native-thread");
    await writeFile(join(memoraxCodeHome, "config.toml"), "[memory.skill_reminder]\ninterval_turns = 2\n");
    await writeProcedure(memoraxCodeHome, "reading-code.md", "# Reading Code\n\n1. Trace the public entry point.");
    await writeProcedure(memoraxCodeHome, "writing-code.md", "# Writing Code\n\n1. Add the focused test first.");

    const outputs = [];
    for (let turn = 1; turn <= 3; turn += 1) {
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
    assert.equal(outputs[1].stdout, "");
    for (const index of [0, 2]) {
      const context = reminderContext(outputs[index].stdout);
      assert.match(context, /^MemoraX Code reminder:/);
      assert.match(context, /### reading-code\.md/);
      assert.match(context, /Trace the public entry point/);
      assert.match(context, /### writing-code\.md/);
      assert.match(context, /Add the focused test first/);
      assert.match(context, /Natural final-answer mention for supported coding agents:/);
      assert.match(context, /begin the final answer with one brief opening paragraph/);
      assert.doesNotMatch(context, /memorax-impact/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("profile and procedure reminders stay in one ordered payload", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-procedure-context-combined-"));
  try {
    const repo = await createWorkspace(root);
    const memoraxCodeHome = join(root, "memorax-code");
    await writeRegistry(memoraxCodeHome, "native-thread");
    await mkdir(memoraxCodeHome, { recursive: true });
    await writeFile(join(memoraxCodeHome, "config.toml"), "[memory.skill_reminder]\ninterval_turns = 1\n");
    await writeProcedure(memoraxCodeHome, "reading-papers.md", "# Reading Papers\n\n1. Identify the main claim.");

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
    assert.ok(context.includes("MemoraX Code reminder:"));
    assert.ok(context.includes("MemoraX Code personal-memory reminder:"));
    assert.ok(context.includes("### reading-papers.md"));
    assert.ok(context.indexOf("MemoraX Code reminder:") < context.indexOf("MemoraX Code personal-memory reminder:"));
    assert.ok(context.indexOf("MemoraX Code personal-memory reminder:") < context.indexOf("### reading-papers.md"));
    assert.equal(result.stdout.trim().split(/\r?\n/).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("symlinked and oversized global procedure files are skipped", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-procedure-context-untrusted-"));
  const cases = [
    ["symlinked", async (_home, path) => {
      const target = join(dirname(path), "target.txt");
      await rename(path, target);
      await symlink(target, path);
    }],
    ["symlinked-parent", async (home, path) => {
      const directory = dirname(path);
      const target = join(home, "procedure-memory-target");
      await rename(directory, target);
      await symlink(target, directory);
    }],
    ["oversized", async (_home, path) => writeFile(path, "x".repeat((16 * 1024) + 1))],
  ];

  try {
    for (const [name, mutate] of cases) {
      const repo = await createWorkspace(root);
      const memoraxCodeHome = join(root, `memorax-code-${name}`);
      const sessionId = `session-${name}`;
      const path = join(memoraxCodeHome, "personal-memory", "procedure-memory", "writing-code.md");
      await writeRegistry(memoraxCodeHome, sessionId);
      await writeProcedure(memoraxCodeHome, "writing-code.md", `# ${name} content must not appear`);
      await mutate(memoraxCodeHome, path);

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
      assert.doesNotMatch(context, /Natural final-answer mention/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("one unreadable procedure file does not hide other valid topics", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-procedure-context-unreadable-"));
  try {
    const repo = await createWorkspace(root);
    const memoraxCodeHome = join(root, "memorax-code");
    await writeRegistry(memoraxCodeHome, "native-thread");
    await writeProcedure(memoraxCodeHome, "reading-code.md", "# Reading Code\n\n1. Keep this valid topic visible.");
    await writeProcedure(memoraxCodeHome, "writing-code.md", "# Writing Code\n\n1. This topic cannot be read.");
    // chmod does not revoke access on Windows or for a POSIX root user.
    const unreadablePath = join(memoraxCodeHome, "personal-memory", "procedure-memory", "writing-code.md");
    const preload = join(root, "unreadable-procedure.mjs");
    await writeFile(preload, `
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      const read = fs.readFileSync;
      fs.readFileSync = (path, ...args) => {
        if (path === ${JSON.stringify(unreadablePath)}) {
          throw Object.assign(new Error("fixture access denied"), { code: "EACCES" });
        }
        return read(path, ...args);
      };
      syncBuiltinESMExports();
    `);

    const result = await runHook(hookPath, {
      hook_event_name: "UserPromptSubmit",
      session_id: "native-thread",
      turn_id: "turn-1",
      transcript_path: "/tmp/native-thread.jsonl",
      cwd: repo,
      prompt: "first prompt",
    }, {
      MEMORAX_CODE_HOME: memoraxCodeHome,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, "--import=" + pathToFileURL(preload).href].filter(Boolean).join(" "),
    });
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
    const repo = await createWorkspace(root);
    const memoraxCodeHome = join(root, "memorax-code");
    await writeRegistry(memoraxCodeHome, "native-thread");
    await writeProcedure(memoraxCodeHome, "reading-code.md", `# Reading Code\n\n${"step ".repeat(1800)}`);

    const result = await runHook(hookPath, {
      hook_event_name: "UserPromptSubmit",
      session_id: "native-thread",
      turn_id: "turn-1",
      transcript_path: "/tmp/native-thread.jsonl",
      cwd: repo,
      prompt: "first prompt",
    }, { MEMORAX_CODE_HOME: memoraxCodeHome });
    const context = reminderContext(result.stdout);
    assert.ok(context.includes("Active user-scoped procedure memories"));
    const procedureContext = context.slice(context.indexOf("Active user-scoped procedure memories"));
    assert.match(procedureContext, /Additional procedure memory was omitted/);
    assert.ok(procedureContext.length <= 4000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function createWorkspace(root) {
  const repo = join(root, `repo-${Math.random().toString(16).slice(2)}`);
  await mkdir(repo);
  await writeFile(join(repo, "README.md"), "# Test repo\n");
  return repo;
}

async function writeProcedure(memoraxCodeHome, name, content) {
  const directory = join(memoraxCodeHome, "personal-memory", "procedure-memory");
  await mkdir(directory, { recursive: true });
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
