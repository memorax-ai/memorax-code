import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const runtimeHook = fileURLToPath(new URL("../hooks/runtime-hook.mjs", import.meta.url));
const userPromptHook = [runtimeHook, "memory-skill-reminder"];
const writebackHook = [runtimeHook, "memory-writeback"];

test("combined UserPromptSubmit hook posts user prompt and first reminder to Backend", async () => {
  const { server, url, requests, requestHeaders } = await listenRecorder();
  const memoraxCodeHome = await mkdtemp(join(tmpdir(), "memorax-code-codex-memory-hook-"));
  const userHome = join(memoraxCodeHome, "user-home");
  const managedCwd = join(userHome, "Documents", "Codex", "2026-07-29", "new-chat");
  await mkdir(managedCwd, { recursive: true });
  try {
    const result = await runHook(userPromptHook, {
      HOME: userHome,
      MEMORAX_CODE_BACKEND_URL: url,
      MEMORAX_CODE_BACKEND_TOKEN: "backend-token",
      MEMORAX_CODE_CODEX_MEMORY_HOOK_TIMEOUT_MS: "1000",
      MEMORAX_CODE_HOME: memoraxCodeHome,
      USERPROFILE: userHome,
    }, {
      hook_event_name: "UserPromptSubmit",
      session_id: "session-1",
      turn_id: "turn-1",
      prompt: "Generate 0 to 3 hyperpersonalized suggestions without treating recently viewed docs as obligations.",
      cwd: managedCwd,
      transcript_path: "/tmp/transcript.jsonl",
    });

    assert.equal(result.code, 0, result.stderr);
    assert.match(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, /\$memorax-code/);
    assert.equal(result.stderr, "");
    assert.equal(requests.length, 2);
    assert.equal(requests[0].path, "/memory/turn-start");
    assert.equal(requests[1].path, "/memory/skill-reminder");
    assert.equal(requestHeaders[0]["x-memorax-code-backend-token"], "backend-token");
    assert.deepEqual(requests[0].body, {
      version: 1,
      client: "codex",
      sessionId: "session-1",
      turnId: "turn-1",
      prompt: "Generate 0 to 3 hyperpersonalized suggestions without treating recently viewed docs as obligations.",
      cwd: managedCwd,
      workspaceKind: "projectless",
      transcriptPath: "/tmp/transcript.jsonl",
    });
    assert.deepEqual(requests[1].body, {
      version: 1,
      client: "codex",
      sessionId: "session-1",
      turnId: "turn-1",
      transcriptPath: "/tmp/transcript.jsonl",
      cwd: managedCwd,
      workspaceKind: "projectless",
      content: JSON.parse(result.stdout).hookSpecificOutput.additionalContext,
      triggers: ["cadence"],
    });
  } finally {
    server.close();
    await rm(memoraxCodeHome, { recursive: true, force: true });
  }
});

test("combined UserPromptSubmit hook refreshes Backend connection authority before its reminder", async () => {
  const memoraxCodeHome = await mkdtemp(join(tmpdir(), "memorax-code-codex-memory-connection-refresh-"));
  const reminderRecorder = await listenRecorder();
  const turnRecorder = await listenRecorder({
    beforeResponse: () => writeBackendConnection(memoraxCodeHome, reminderRecorder.url, "replacement-token"),
  });
  try {
    await writeBackendConnection(memoraxCodeHome, turnRecorder.url, "initial-token");
    const result = await runHook(userPromptHook, {
      MEMORAX_CODE_BACKEND_URL: "",
      MEMORAX_CODE_BACKEND_HOST: "",
      MEMORAX_CODE_BACKEND_PORT: "",
      MEMORAX_CODE_BACKEND_TOKEN: "",
      MEMORAX_CODE_CODEX_MEMORY_HOOK_TIMEOUT_MS: "1000",
      MEMORAX_CODE_HOME: memoraxCodeHome,
    }, {
      hook_event_name: "UserPromptSubmit",
      session_id: "session-connection-refresh",
      turn_id: "turn-connection-refresh",
      prompt: "Keep the reminder bound to the current Backend.",
      transcript_path: "/tmp/connection-refresh.jsonl",
    });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.match(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, /\$memorax-code/);
    assert.deepEqual(turnRecorder.requests.map((request) => request.path), ["/memory/turn-start"]);
    assert.deepEqual(reminderRecorder.requests.map((request) => request.path), ["/memory/skill-reminder"]);
    assert.equal(turnRecorder.requestHeaders[0]["x-memorax-code-backend-token"], "initial-token");
    assert.equal(reminderRecorder.requestHeaders[0]["x-memorax-code-backend-token"], "replacement-token");
  } finally {
    turnRecorder.server.close();
    reminderRecorder.server.close();
    await rm(memoraxCodeHome, { recursive: true, force: true });
  }
});

test("combined UserPromptSubmit hook skips pathless Codex background turns but writeback reaches Backend", async () => {
  const { server, url, requests } = await listenRecorder();
  const memoraxCodeHome = await mkdtemp(join(tmpdir(), "memorax-code-codex-background-hook-"));
  try {
    const turnStart = await runHook(userPromptHook, {
      MEMORAX_CODE_BACKEND_URL: url,
      MEMORAX_CODE_CODEX_MEMORY_HOOK_TIMEOUT_MS: "1000",
      MEMORAX_CODE_HOME: memoraxCodeHome,
    }, {
      hook_event_name: "UserPromptSubmit",
      session_id: "background-session",
      turn_id: "background-turn",
      prompt: "Generate hyperpersonalized suggestions.",
      cwd: "/repo",
    });
    const writeback = await runHook(writebackHook, {
      MEMORAX_CODE_BACKEND_URL: url,
      MEMORAX_CODE_CODEX_MEMORY_HOOK_TIMEOUT_MS: "1000",
      MEMORAX_CODE_HOME: memoraxCodeHome,
    }, {
      hook_event_name: "Stop",
      session_id: "background-session",
      turn_id: "background-turn",
      last_assistant_message: "Suggestion output.",
      cwd: "/repo",
    });

    assert.equal(turnStart.code, 0, turnStart.stderr);
    assert.equal(writeback.code, 0, writeback.stderr);
    assert.equal(turnStart.stdout, "");
    assert.equal(writeback.stdout, "");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].path, "/memory/writeback");
    assert.deepEqual(requests[0].body, {
      version: 1,
      client: "codex",
      sessionId: "background-session",
      turnId: "background-turn",
      lastAssistantMessage: "Suggestion output.",
      cwd: "/repo",
    });
  } finally {
    server.close();
    await rm(memoraxCodeHome, { recursive: true, force: true });
  }
});

test("memory writeback hook posts assistant message to Backend", async () => {
  const { server, url, requests } = await listenRecorder();
  const memoraxCodeHome = await mkdtemp(join(tmpdir(), "memorax-code-codex-writeback-hook-"));
  const userHome = join(memoraxCodeHome, "user-home");
  const managedCwd = join(userHome, "Documents", "Codex", "2026-07-29", "new-chat");
  await mkdir(managedCwd, { recursive: true });
  try {
    const env = {
      HOME: userHome,
      MEMORAX_CODE_BACKEND_URL: url,
      MEMORAX_CODE_CODEX_MEMORY_HOOK_TIMEOUT_MS: "1000",
      MEMORAX_CODE_HOME: memoraxCodeHome,
      USERPROFILE: userHome,
    };
    const pinned = await runHook(userPromptHook, env, {
      hook_event_name: "UserPromptSubmit",
      session_id: "session-1",
      turn_id: "turn-1",
      prompt: "Pin this turn.",
      cwd: managedCwd,
    });
    assert.equal(pinned.code, 0, pinned.stderr);
    const result = await runHook(writebackHook, {
      ...env,
    }, {
      hook_event_name: "Stop",
      session_id: "session-1",
      turn_id: "turn-1",
      last_assistant_message: "Assistant answer.",
      cwd: managedCwd,
      transcript_path: "/tmp/transcript.jsonl",
    });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].path, "/memory/writeback");
    assert.deepEqual(requests[0].body, {
      version: 1,
      client: "codex",
      sessionId: "session-1",
      turnId: "turn-1",
      lastAssistantMessage: "Assistant answer.",
      cwd: managedCwd,
      workspaceKind: "projectless",
      transcriptPath: "/tmp/transcript.jsonl",
    });
  } finally {
    server.close();
    await rm(memoraxCodeHome, { recursive: true, force: true });
  }
});

test("memory writeback hook reads the persisted Backend connection and token", async () => {
  const { server, url, requests, requestHeaders } = await listenRecorder();
  const memoraxCodeHome = await mkdtemp(join(tmpdir(), "memorax-code-codex-memory-connection-"));
  try {
    await writeBackendConnection(memoraxCodeHome, url, "persisted-backend-token");
    const env = {
      MEMORAX_CODE_BACKEND_URL: "",
      MEMORAX_CODE_BACKEND_TOKEN: "",
      MEMORAX_CODE_CODEX_MEMORY_HOOK_TIMEOUT_MS: "1000",
      MEMORAX_CODE_HOME: memoraxCodeHome,
    };
    const pinned = await runHook(userPromptHook, env, {
      hook_event_name: "UserPromptSubmit",
      session_id: "session-persisted-connection",
      turn_id: "turn-persisted-connection",
      prompt: "Pin this turn.",
      cwd: "/repo",
    });
    assert.equal(pinned.code, 0, pinned.stderr);
    const result = await runHook(writebackHook, env, {
      hook_event_name: "Stop",
      session_id: "session-persisted-connection",
      turn_id: "turn-persisted-connection",
      last_assistant_message: "Persist this answer.",
      cwd: "/repo",
      transcript_path: "/tmp/transcript.jsonl",
    });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].path, "/memory/writeback");
    assert.equal(requestHeaders[0]["x-memorax-code-backend-token"], "persisted-backend-token");
  } finally {
    server.close();
    await rm(memoraxCodeHome, { recursive: true, force: true });
  }
});

test("Codex memory Hook fails open on an invalid connection authority", async () => {
  const memoraxCodeHome = await mkdtemp(join(tmpdir(), "memorax-code-codex-memory-invalid-connection-"));
  try {
    const runtime = join(memoraxCodeHome, "runtime", "backend");
    await mkdir(runtime, { recursive: true });
    await writeFile(join(runtime, "backend-connection.json"), "{not-json\n");
    const result = await runHook(userPromptHook, {
      MEMORAX_CODE_BACKEND_URL: "",
      MEMORAX_CODE_BACKEND_HOST: "",
      MEMORAX_CODE_BACKEND_PORT: "",
      MEMORAX_CODE_CODEX_HOOK_DEBUG: "1",
      MEMORAX_CODE_HOME: memoraxCodeHome,
    }, {
      hook_event_name: "UserPromptSubmit",
      session_id: "session-invalid-connection",
      turn_id: "turn-invalid-connection",
      prompt: "Continue without Backend memory.",
      cwd: "/repo",
      transcript_path: "/tmp/transcript.jsonl",
    });

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /Backend connection authority is invalid/);
  } finally {
    await rm(memoraxCodeHome, { recursive: true, force: true });
  }
});

test("repo memory background workers do not record turns or writeback", async () => {
  const { server, url, requests } = await listenRecorder();
  const memoraxCodeHome = await mkdtemp(join(tmpdir(), "memorax-code-codex-worker-hook-"));
  const internalJobEnv = {
    MEMORAX_CODE_BACKEND_URL: url,
    MEMORAX_CODE_CODEX_MEMORY_HOOK_TIMEOUT_MS: "1000",
    MEMORAX_CODE_HOME: memoraxCodeHome,
    MEMORAX_CODE_REPO_MEMORY_JOB_KIND: "repo-memory",
    MEMORAX_CODE_REPO_MEMORY_JOB_ID: "20260718000000000-build-repo-deadbeef",
    MEMORAX_CODE_REPO_MEMORY_JOB_RUN_ID: "0123456789abcdef0123456789abcdef",
  };
  try {
    const turnStart = await runHook(userPromptHook, internalJobEnv, {
      hook_event_name: "UserPromptSubmit",
      session_id: "repo-memory-worker",
      turn_id: "worker-turn",
      prompt: "Use $memorax-code repo-build.",
      cwd: "/repo",
      transcript_path: "/tmp/repo-memory-worker.jsonl",
    });
    const writeback = await runHook(writebackHook, internalJobEnv, {
      hook_event_name: "Stop",
      session_id: "repo-memory-worker",
      turn_id: "worker-turn",
      last_assistant_message: "Repo memory build completed.",
      cwd: "/repo",
      transcript_path: "/tmp/repo-memory-worker.jsonl",
    });

    assert.equal(turnStart.code, 0, turnStart.stderr);
    assert.equal(writeback.code, 0, writeback.stderr);
    assert.equal(turnStart.stdout, "");
    assert.equal(writeback.stdout, "");
    assert.deepEqual(requests, []);
  } finally {
    server.close();
    await rm(memoraxCodeHome, { recursive: true, force: true });
  }
});

function runHook(command, env, input = {}) {
  assert.equal(
    typeof env.MEMORAX_CODE_HOME === "string" && env.MEMORAX_CODE_HOME.length > 0,
    true,
    "Hook tests must use an isolated MEMORAX_CODE_HOME",
  );
  return new Promise((resolve) => {
    const childEnv = { ...process.env };
    delete childEnv.MEMORAX_CODE_HOME;
    const child = spawn(process.execPath, command, {
      env: { ...childEnv, ...env },
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

async function listenRecorder({ beforeResponse } = {}) {
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
    await beforeResponse?.();
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
    requests,
    requestHeaders,
  };
}
