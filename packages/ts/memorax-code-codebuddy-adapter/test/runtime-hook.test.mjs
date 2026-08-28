import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const hookPath = fileURLToPath(new URL("../hooks/runtime-hook.mjs", import.meta.url));
const manifestPath = fileURLToPath(new URL("../hooks/hooks.json", import.meta.url));

test("SessionStart prewarms Backend without starting a memory turn", async () => {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const sessionStart = manifest.hooks.SessionStart?.[0];
  assert.equal(sessionStart?.matcher, "startup|resume|clear|compact");
  assert.equal(sessionStart?.hooks?.length, 1);
  assert.match(sessionStart.hooks[0].command, /runtime-hook\.mjs\" turn$/);
  assert.equal(sessionStart.hooks[0].timeout, 35);

  const root = await mkdtemp(join(tmpdir(), "memorax-codebuddy-hook-"));
  const transcriptPath = join(root, "session.jsonl");
  await writeFile(transcriptPath, "");
  const requests = [];
  const server = await startServer(requests, { ok: true, service: "memorax-code-backend" });
  try {
    const result = await runHook({
      hook_event_name: "SessionStart", session_id: "session-start", transcript_path: transcriptPath,
      source: "startup", cwd: root,
    }, { root, server });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
    assert.deepEqual(requests.map((request) => request.path), ["/health"]);
    await assert.rejects(readFile(join(root, "adapters", "codebuddy", "pending.json"), "utf8"), { code: "ENOENT" });
  } finally { await server.close(); }
});

test("UserPromptSubmit posts turn-start and returns retrieved context", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-codebuddy-hook-"));
  const transcriptPath = join(root, "session.jsonl");
  await writeFile(transcriptPath, "");
  const requests = [];
  const server = await startServer(requests, { additionalContext: "memory context" });
  try {
    const result = await runHook({
      hook_event_name: "UserPromptSubmit", session_id: "session-1", transcript_path: transcriptPath,
      prompt: "remember this", cwd: root,
    }, { root, server });
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), {
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "memory context" },
    });
    const turnStarts = requests.filter((request) => request.path === "/memory/turn-start");
    assert.equal(turnStarts.length, 1);
    assert.equal(turnStarts[0].body.client, "codebuddy");
    assert.equal(turnStarts[0].body.sessionId, "session-1");
    assert.equal(turnStarts[0].body.prompt, "remember this");
    const pending = JSON.parse(await readFile(join(root, "adapters", "codebuddy", "pending.json"), "utf8"));
    assert.equal(pending["session-1"].version, 1);
    assert.equal(pending["session-1"].turnId, provisionalTurnId("session-1", 0, "remember this"));
  } finally { await server.close(); }
});

test("UserPromptSubmit retries reuse one deterministic pending turn and a new prompt replaces it", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-codebuddy-hook-"));
  const transcriptPath = join(root, "session.jsonl");
  await writeFile(transcriptPath, "");
  const requests = [];
  const server = await startServer(requests, { additionalContext: "memory context" });
  const input = {
    hook_event_name: "UserPromptSubmit", session_id: "session-retry", transcript_path: transcriptPath,
    prompt: "same prompt", cwd: root,
  };
  try {
    const first = await runHook(input, { root, server });
    assert.equal(first.status, 0);
    const firstPending = JSON.parse(await readFile(join(root, "adapters", "codebuddy", "pending.json"), "utf8"));

    const retry = await runHook(input, { root, server });
    assert.equal(retry.status, 0);
    assert.deepEqual(JSON.parse(retry.stdout), {
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "memory context" },
    });
    const retryPending = JSON.parse(await readFile(join(root, "adapters", "codebuddy", "pending.json"), "utf8"));
    assert.equal(retryPending["session-retry"].turnId, firstPending["session-retry"].turnId);
    assert.equal(retryPending["session-retry"].createdAt, firstPending["session-retry"].createdAt);
    assert.equal(retryPending["session-retry"].version, 1);
    assert.equal(Object.keys(retryPending).length, 1);

    const next = await runHook({ ...input, prompt: "next prompt" }, { root, server });
    assert.equal(next.status, 0);
    const nextPending = JSON.parse(await readFile(join(root, "adapters", "codebuddy", "pending.json"), "utf8"));
    assert.equal(nextPending["session-retry"].turnId, provisionalTurnId("session-retry", 0, "next prompt"));
    assert.notEqual(nextPending["session-retry"].turnId, retryPending["session-retry"].turnId);
    assert.equal(Object.keys(nextPending).length, 1);
    assert.equal(requests.filter((request) => request.path === "/memory/turn-start").length, 3);
  } finally { await server.close(); }
});

test("Stop posts writeback and clears only an accepted pending turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-codebuddy-hook-"));
  const transcriptPath = join(root, "session.jsonl");
  await writeFile(transcriptPath, "");
  const requests = [];
  const server = await startServer(requests, { ok: true, scheduled: true });
  try {
    const start = await runHook({
      hook_event_name: "UserPromptSubmit", session_id: "session-2", transcript_path: transcriptPath,
      prompt: "hello", cwd: root,
    }, { root, server });
    assert.equal(start.status, 0);
    const pending = JSON.parse(await readFile(join(root, "adapters", "codebuddy", "pending.json"), "utf8"));
    const turnId = pending["session-2"].turnId;
    await writeFile(transcriptPath, [
      JSON.stringify({ id: "u1", role: "user", sessionId: "session-2", content: "<user_query>hello</user_query>" }),
      JSON.stringify({ id: "a1", role: "assistant", parentId: "u1", status: "completed", content: "done" }), "",
    ].join("\n"));
    const stop = await runHook({
      hook_event_name: "Stop", session_id: "session-2", transcript_path: transcriptPath, cwd: root,
    }, { root, server });
    assert.equal(stop.status, 0);
    assert.equal(requests.at(-1).path, "/memory/writeback");
    assert.equal(requests.at(-1).body.turnId, turnId);
    assert.deepEqual(JSON.parse(await readFile(join(root, "adapters", "codebuddy", "pending.json"), "utf8")), {});
  } finally { await server.close(); }
});

test("Stop retains pending state when writeback is not scheduled", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-codebuddy-hook-"));
  const transcriptPath = join(root, "session.jsonl");
  await writeFile(transcriptPath, "");
  const server = await startServer([], { ok: true, scheduled: false, reason: "assistant_message_missing" });
  try {
    await runHook({
      hook_event_name: "UserPromptSubmit", session_id: "session-3", transcript_path: transcriptPath,
      prompt: "hello", cwd: root,
    }, { root, server });
    const before = JSON.parse(await readFile(join(root, "adapters", "codebuddy", "pending.json"), "utf8"));
    const stop = await runHook({
      hook_event_name: "Stop", session_id: "session-3", transcript_path: transcriptPath, cwd: root,
    }, { root, server });
    assert.equal(stop.status, 0);
    assert.deepEqual(JSON.parse(await readFile(join(root, "adapters", "codebuddy", "pending.json"), "utf8")), before);
  } finally { await server.close(); }
});

async function startServer(requests, response) {
  const server = createServer(async (request, responseStream) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    requests.push({ path: request.url, body: text ? JSON.parse(text) : undefined });
    responseStream.writeHead(200, { "content-type": "application/json" });
    responseStream.end(JSON.stringify(response));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

function runHook(input, { root, server }) {
  const address = server.address();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [hookPath], {
      cwd: root,
      env: { ...process.env, MEMORAX_CODE_HOME: root, MEMORAX_CODE_BACKEND_URL: `http://127.0.0.1:${address.port}` },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status, signal) => resolve({ status, signal, stdout: stdout.trim(), stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}

function provisionalTurnId(sessionId, boundary, prompt) {
  return `${sessionId}:${boundary}:${createHash("sha256").update(prompt.trim()).digest("hex")}`;
}
