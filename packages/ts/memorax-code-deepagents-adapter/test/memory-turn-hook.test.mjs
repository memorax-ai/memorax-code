import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const hookPath = fileURLToPath(new URL("../runtime-hooks/memory-turn.mjs", import.meta.url));
const manifestPath = fileURLToPath(new URL("../hooks/hooks.json", import.meta.url));

test("Deep Agents plugin manifest registers backend, prompt, and Stop Hooks", async () => {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
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
    "node \"${CLAUDE_PLUGIN_ROOT}/hooks/runtime-hook.mjs\" memory-skill-reminder",
  ), true);
  assert.equal(commands.Stop.includes(
    "node \"${CLAUDE_PLUGIN_ROOT}/hooks/runtime-hook.mjs\" memory-turn",
  ), true);
  assert.equal(manifest.hooks.UserPromptSubmit[0].hooks[1].timeout, 20);
  assert.equal(manifest.hooks.Stop[0].hooks[1].timeout, 10);
});

test("Deep Agents UserPromptSubmit records a deepagents turn-start", async () => {
  const recorder = await listenRecorder({
    ok: true,
    userNotice: "Your MemoraX trial quota is running low.",
  });
  try {
    const result = await runHook({
      MEMORAX_CODE_BACKEND_URL: recorder.url,
      MEMORAX_CODE_BACKEND_TOKEN: "backend-token",
      MEMORAX_CODE_DEEPAGENTS_MEMORY_HOOK_TIMEOUT_MS: "1000",
    }, {
      hook_event_name: "UserPromptSubmit",
      session_id: "session-deepagents-hook",
      prompt_id: "prompt-deepagents-hook",
      prompt: "Record this dcode prompt for exact Turn tracking.",
      transcript_path: "/tmp/deepagents-transcript.jsonl",
      cwd: "/repo",
    });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), {
      systemMessage: "Your MemoraX trial quota is running low.",
    });
    assert.equal(recorder.requestHeaders[0]["x-memorax-code-backend-token"], "backend-token");
    assert.deepEqual(recorder.requests, [{
      path: "/memory/turn-start",
      body: {
        version: 1,
        client: "deepagents",
        sessionId: "session-deepagents-hook",
        promptId: "prompt-deepagents-hook",
        transcriptPath: "/tmp/deepagents-transcript.jsonl",
        prompt: "Record this dcode prompt for exact Turn tracking.",
        cwd: "/repo",
      },
    }]);
  } finally {
    await recorder.close();
  }
});

test("Deep Agents Stop posts writeback with the native prompt id", async () => {
  const recorder = await listenRecorder({ ok: true });
  try {
    const result = await runHook({
      MEMORAX_CODE_BACKEND_URL: recorder.url,
      MEMORAX_CODE_BACKEND_TOKEN: "backend-token",
      MEMORAX_CODE_DEEPAGENTS_MEMORY_HOOK_TIMEOUT_MS: "1000",
    }, {
      hook_event_name: "Stop",
      session_id: "session-deepagents-stop",
      prompt_id: "prompt-deepagents-stop",
      transcript_path: "/tmp/deepagents-stop.jsonl",
      last_assistant_message: "Final dcode answer.",
      cwd: "/repo",
    });

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(recorder.requests, [{
      path: "/memory/writeback",
      body: {
        version: 1,
        client: "deepagents",
        sessionId: "session-deepagents-stop",
        promptId: "prompt-deepagents-stop",
        transcriptPath: "/tmp/deepagents-stop.jsonl",
        lastAssistantMessage: "Final dcode answer.",
        cwd: "/repo",
      },
    }]);
  } finally {
    await recorder.close();
  }
});

async function runHook(env, input) {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-deepagents-hook-"));
  try {
    const child = spawn(process.execPath, [hookPath], {
      env: { ...process.env, ...env, MEMORAX_CODE_HOME: join(root, "memorax-code") },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.end(`${JSON.stringify(input)}\n`);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const code = await new Promise((resolve) => child.on("close", resolve));
    return { code, stdout, stderr };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function listenRecorder(responseBody) {
  const requests = [];
  const requestHeaders = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      requestHeaders.push(request.headers);
      requests.push({ path: request.url, body: JSON.parse(body) });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(responseBody));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    requestHeaders,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
