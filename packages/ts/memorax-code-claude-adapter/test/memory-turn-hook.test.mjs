import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const hookPath = fileURLToPath(new URL("../runtime-hooks/memory-turn.mjs", import.meta.url));
const manifestPath = fileURLToPath(new URL("../hooks/hooks.json", import.meta.url));

test("Claude plugin manifest installs backend, turn-start, and writeback Hooks", async () => {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const runtime = await readFile(hookPath, "utf8");
  assert.equal(manifest.hooks.SessionStart[0].matcher, "startup|resume|clear|compact|fork");
  const commands = Object.fromEntries(Object.entries(manifest.hooks).map(([event, groups]) => [
    event,
    groups.flatMap((group) => group.hooks.map((hook) => hook.command)),
  ]));

  assert.equal(commands.SessionStart.includes(
    "node \"${CLAUDE_PLUGIN_ROOT}/hooks/runtime-hook.mjs\" ensure-backend",
  ), true);
  assert.equal(commands.SessionStart.includes(
    "node \"${CLAUDE_PLUGIN_ROOT}/hooks/runtime-hook.mjs\" memory-cli-session",
  ), true);
  assert.equal(commands.UserPromptSubmit.includes(
    "node \"${CLAUDE_PLUGIN_ROOT}/hooks/runtime-hook.mjs\" memory-turn",
  ), true);
  assert.equal(commands.Stop.includes(
    "node \"${CLAUDE_PLUGIN_ROOT}/hooks/runtime-hook.mjs\" memory-turn",
  ), true);
  assert.equal(manifest.hooks.UserPromptSubmit[0].hooks[1].timeout, 15);
  assert.equal(manifest.hooks.Stop[0].hooks[1].timeout, 10);
  assert.match(runtime, /RETRIEVAL_BACKEND_TIMEOUT_MS = 12_000/);
  assert.match(runtime, /DEFAULT_BACKEND_TIMEOUT_MS = 5_000/);
  assert.match(runtime, /path === "\/memory\/turn-start" \? RETRIEVAL_BACKEND_TIMEOUT_MS : DEFAULT_BACKEND_TIMEOUT_MS/);
});

test("Claude UserPromptSubmit retrieves memory context with the submitted prompt", async () => {
  const recorder = await listenRecorder({
    ok: true,
    additionalContext: "Hidden MemoraX Code external memory context.\n\nRemember the Hook boundary.",
    userNotice: "Your MemoraX trial quota is running low.",
  });
  try {
    const result = await runHook({
      MEMORAX_CODE_BACKEND_URL: recorder.url,
      MEMORAX_CODE_BACKEND_TOKEN: "backend-token",
      MEMORAX_CODE_CLAUDE_MEMORY_HOOK_TIMEOUT_MS: "1000",
    }, {
      hook_event_name: "UserPromptSubmit",
      session_id: "session-claude-hook",
      prompt_id: "prompt-claude-hook",
      prompt: "Use this prompt only as the automatic retrieval query.",
      transcript_path: "/tmp/claude-transcript.jsonl",
      cwd: "/repo",
      workspace_kind: "project",
    });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), {
      systemMessage: "Your MemoraX trial quota is running low.",
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: "Hidden MemoraX Code external memory context.\n\nRemember the Hook boundary.",
      },
    });
    assert.equal(recorder.requestHeaders[0]["x-memorax-code-backend-token"], "backend-token");
    assert.deepEqual(recorder.requests, [{
      path: "/memory/turn-start",
      body: {
        version: 1,
        client: "claude-code",
        sessionId: "session-claude-hook",
        promptId: "prompt-claude-hook",
        transcriptPath: "/tmp/claude-transcript.jsonl",
        prompt: "Use this prompt only as the automatic retrieval query.",
        cwd: "/repo",
        workspaceKind: "project",
      },
    }]);
  } finally {
    await recorder.close();
  }
});

test("Claude UserPromptSubmit starts Repo Memory build for the Backend-authorized worktree", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-claude-auto-build-"));
  const repo = join(root, "repo");
  const pluginRoot = join(root, "plugin");
  const jobLog = join(root, "repo-memory-job.json");
  const recorder = await listenRecorder({ ok: true, repoMemoryWorktree: repo });
  try {
    await Promise.all([
      mkdir(repo, { recursive: true }),
      mkdir(join(pluginRoot, "hooks"), { recursive: true }),
    ]);
    await writeFile(join(pluginRoot, "hooks", "repo-memory-job.mjs"), [
      'import { writeFileSync } from "node:fs";',
      `writeFileSync(${JSON.stringify(jobLog)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));`,
      "",
    ].join("\n"));

    const result = await runHook({
      CLAUDE_PLUGIN_ROOT: pluginRoot,
      MEMORAX_CODE_BACKEND_URL: recorder.url,
      MEMORAX_CODE_CLAUDE_MEMORY_HOOK_TIMEOUT_MS: "1000",
    }, {
      hook_event_name: "UserPromptSubmit",
      session_id: "session-claude-auto-build",
      prompt_id: "prompt-claude-auto-build",
      prompt: "Build missing Repo Memory.",
      transcript_path: "/tmp/claude-auto-build.jsonl",
      cwd: repo,
    });

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(await waitForFile(jobLog)), {
      args: ["maintain", "--repo", repo],
      cwd: await realpath(repo),
    });
  } finally {
    await recorder.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude UserPromptSubmit fails open on non-success or invalid backend responses", async () => {
  for (const responseOptions of [
    { statusCode: 503, rawBody: "backend unavailable" },
    { statusCode: 200, rawBody: "not-json" },
  ]) {
    const recorder = await listenRecorder({ ok: false }, responseOptions);
    try {
      const result = await runHook({
        MEMORAX_CODE_BACKEND_URL: recorder.url,
        MEMORAX_CODE_CLAUDE_MEMORY_HOOK_TIMEOUT_MS: "1000",
      }, {
        hook_event_name: "UserPromptSubmit",
        session_id: "session-claude-hook",
        prompt_id: "prompt-claude-hook",
        prompt: "Continue without recalled context.",
        transcript_path: "/tmp/claude-transcript.jsonl",
        cwd: "/repo",
      });

      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "");
      assert.equal(recorder.requests.length, 1);
    } finally {
      await recorder.close();
    }
  }
});

test("Claude Stop posts the exact prompt id and diagnostic assistant message", async () => {
  const recorder = await listenRecorder();
  try {
    const result = await runHook({
      MEMORAX_CODE_BACKEND_URL: recorder.url,
      MEMORAX_CODE_CLAUDE_MEMORY_HOOK_TIMEOUT_MS: "1000",
    }, {
      hook_event_name: "Stop",
      session_id: "session-claude-hook",
      prompt_id: "prompt-claude-hook",
      transcript_path: "/tmp/claude-transcript.jsonl",
      last_assistant_message: "Assistant message used only for consistency diagnostics.",
      cwd: "/repo",
    });

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(recorder.requests, [{
      path: "/memory/writeback",
      body: {
        version: 1,
        client: "claude-code",
        sessionId: "session-claude-hook",
        promptId: "prompt-claude-hook",
        transcriptPath: "/tmp/claude-transcript.jsonl",
        lastAssistantMessage: "Assistant message used only for consistency diagnostics.",
        cwd: "/repo",
      },
    }]);
  } finally {
    await recorder.close();
  }
});

test("Claude memory Hook reads the persisted Backend connection and token", async () => {
  const recorder = await listenRecorder();
  const memoraxCodeHome = await mkdtemp(join(tmpdir(), "memorax-code-claude-memory-connection-"));
  try {
    await writeBackendConnection(memoraxCodeHome, recorder.url, "persisted-backend-token");
    const result = await runHook({
      MEMORAX_CODE_BACKEND_URL: "",
      MEMORAX_CODE_BACKEND_TOKEN: "",
      MEMORAX_CODE_CLAUDE_MEMORY_HOOK_TIMEOUT_MS: "1000",
      MEMORAX_CODE_HOME: memoraxCodeHome,
    }, {
      hook_event_name: "Stop",
      session_id: "session-persisted-connection",
      prompt_id: "prompt-persisted-connection",
      transcript_path: "/tmp/claude-transcript.jsonl",
      last_assistant_message: "Persist this Claude answer.",
      cwd: "/repo",
    });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(recorder.requests.length, 1);
    assert.equal(recorder.requestHeaders[0]["x-memorax-code-backend-token"], "persisted-backend-token");
  } finally {
    await recorder.close();
    await rm(memoraxCodeHome, { recursive: true, force: true });
  }
});

test("Claude memory Hook fails open on an invalid connection authority", async () => {
  const memoraxCodeHome = await mkdtemp(join(tmpdir(), "memorax-code-claude-memory-invalid-connection-"));
  try {
    const runtime = join(memoraxCodeHome, "runtime", "backend");
    await mkdir(runtime, { recursive: true });
    await writeFile(join(runtime, "backend-connection.json"), "{not-json\n");
    const result = await runHook({
      MEMORAX_CODE_BACKEND_URL: "",
      MEMORAX_CODE_BACKEND_HOST: "",
      MEMORAX_CODE_BACKEND_PORT: "",
      MEMORAX_CODE_CLAUDE_HOOK_DEBUG: "1",
      MEMORAX_CODE_HOME: memoraxCodeHome,
    }, {
      hook_event_name: "UserPromptSubmit",
      session_id: "session-invalid-connection",
      prompt_id: "prompt-invalid-connection",
      prompt: "Continue without Backend memory.",
      transcript_path: "/tmp/claude-transcript.jsonl",
      cwd: "/repo",
    });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Backend connection authority is invalid/);
  } finally {
    await rm(memoraxCodeHome, { recursive: true, force: true });
  }
});

test("Claude memory Hook fails closed without prompt_id", async () => {
  const recorder = await listenRecorder();
  try {
    const result = await runHook({
      MEMORAX_CODE_BACKEND_URL: recorder.url,
      MEMORAX_CODE_CLAUDE_MEMORY_HOOK_TIMEOUT_MS: "1000",
    }, {
      hook_event_name: "Stop",
      session_id: "session-claude-hook",
      transcript_path: "/tmp/claude-transcript.jsonl",
      last_assistant_message: "Must not be sent.",
    });

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(recorder.requests, []);
  } finally {
    await recorder.close();
  }
});

function runHook(env, input) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [hookPath], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}

async function writeBackendConnection(memoraxCodeHome, url, token) {
  const runtime = join(memoraxCodeHome, "runtime", "backend");
  const tokenPath = join(runtime, "backend-token.json");
  await mkdir(runtime, { recursive: true });
  await writeFile(tokenPath, `${JSON.stringify({
    version: 1,
    token,
    createdAt: "2026-07-26T00:00:00.000Z",
  })}\n`, { mode: 0o600 });
  await writeFile(join(runtime, "backend-connection.json"), `${JSON.stringify({
    version: 1,
    url,
    tokenPath,
  })}\n`);
}

async function listenRecorder(result = { ok: true }, responseOptions = {}) {
  const requests = [];
  const requestHeaders = [];
  const server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += String(chunk);
    requestHeaders.push(request.headers);
    requests.push({
      path: new URL(request.url ?? "/", "http://127.0.0.1").pathname,
      body: text ? JSON.parse(text) : {},
    });
    response.writeHead(responseOptions.statusCode ?? 200, { "content-type": "application/json" });
    response.end(responseOptions.rawBody ?? JSON.stringify(result));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.equal(typeof address, "object");
  return {
    requests,
    requestHeaders,
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
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
