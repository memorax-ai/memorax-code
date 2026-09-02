import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { enableTraeAdapter } from "../src/config.mjs";

test("Trae UserPromptSubmit records one Turn and injects memory context", async () => {
  const fixture = await createFixture("prompt");
  try {
    const result = await runHook(fixture, {
      hook_event_name: "UserPromptSubmit",
      session_id: "trae-session-1",
      prompt: "remember the validated Trae Hook flow",
      cwd: fixture.root,
    });

    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.match(output.hookSpecificOutput.additionalContext, /^memory context\n\nMemoraX Code reminder:/);

    const turnStart = fixture.requests.find((request) => request.path === "/memory/turn-start");
    assert.equal(turnStart.body.client, "trae");
    assert.equal(turnStart.body.sessionId, "trae-session-1");
    assert.equal(turnStart.body.prompt, "remember the validated Trae Hook flow");
    assert.match(turnStart.body.turnId, /^trae-session-1:[1-9]\d*:[a-f0-9]{64}$/);

    const reminder = fixture.requests.find((request) => request.path === "/memory/skill-reminder");
    assert.equal(reminder.body.turnId, turnStart.body.turnId);
    assert.deepEqual(reminder.body.triggers, ["cadence"]);

    const turns = JSON.parse(await readFile(join(fixture.root, "adapters", "trae", "active-turns.json"), "utf8"));
    assert.equal(turns.sessions["trae-session-1"].turnId, turnStart.body.turnId);
    const observed = JSON.parse(await readFile(join(fixture.root, "adapters", "trae", "runtime-observed.json"), "utf8"));
    assert.equal(observed.runtimeDigest, fixture.runtimeDigest);
  } finally {
    await fixture.close();
  }
});

test("Trae Stop writes the matching Hook pair and clears only an accepted Turn", async () => {
  const fixture = await createFixture("stop");
  try {
    await runHook(fixture, {
      hook_event_name: "UserPromptSubmit",
      session_id: "trae-session-2",
      prompt: "pair this prompt with the final answer",
      cwd: fixture.root,
    });
    const turnStart = fixture.requests.find((request) => request.path === "/memory/turn-start");

    const stop = await runHook(fixture, {
      hook_event_name: "Stop",
      session_id: "trae-session-2",
      last_assistant_message: "validated final answer",
      text_content: "validated final answer",
      cwd: fixture.root,
    });

    assert.equal(stop.status, 0, stop.stderr);
    const writeback = fixture.requests.find((request) => request.path === "/memory/writeback");
    assert.deepEqual(writeback.body, {
      version: 1,
      client: "trae",
      sessionId: "trae-session-2",
      turnId: turnStart.body.turnId,
      prompt: "pair this prompt with the final answer",
      lastAssistantMessage: "validated final answer",
      cwd: fixture.root,
    });
    const turns = JSON.parse(await readFile(join(fixture.root, "adapters", "trae", "active-turns.json"), "utf8"));
    assert.deepEqual(turns.sessions, {});
  } finally {
    await fixture.close();
  }
});

test("Trae Stop fails closed when its assistant fields conflict", async () => {
  const fixture = await createFixture("conflict");
  try {
    await runHook(fixture, {
      hook_event_name: "UserPromptSubmit",
      session_id: "trae-session-3",
      prompt: "retain this turn",
      cwd: fixture.root,
    });
    const before = await readFile(join(fixture.root, "adapters", "trae", "active-turns.json"), "utf8");

    const stop = await runHook(fixture, {
      hook_event_name: "Stop",
      session_id: "trae-session-3",
      last_assistant_message: "first answer",
      text_content: "conflicting answer",
      cwd: fixture.root,
    });

    assert.equal(stop.status, 0, stop.stderr);
    assert.equal(fixture.requests.some((request) => request.path === "/memory/writeback"), false);
    assert.equal(await readFile(join(fixture.root, "adapters", "trae", "active-turns.json"), "utf8"), before);
  } finally {
    await fixture.close();
  }
});

async function createFixture(name) {
  const root = await mkdtemp(join(tmpdir(), `memorax-code-trae-hook-${name}-`));
  const traeHome = join(root, "trae-home");
  const requests = [];
  const server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    const received = { path: request.url, body: text ? JSON.parse(text) : undefined };
    requests.push(received);
    const body = request.url === "/health"
      ? { ok: true, service: "memorax-code-backend" }
      : request.url === "/memory/turn-start"
        ? { ok: true, additionalContext: "memory context" }
        : request.url === "/memory/writeback"
          ? { ok: true, scheduled: true }
          : { ok: true };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const installed = await enableTraeAdapter({
    memoraxCodeHome: root,
    traeHome,
    memoraxCodeCommand: process.execPath,
  });
  assert.equal(installed.ok, true);
  const state = JSON.parse(await readFile(installed.statePath, "utf8"));
  return {
    root,
    traeHome,
    requests,
    runtimePath: state.runtimePath,
    runtimeDigest: state.runtimeDigest,
    server,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await rm(root, { recursive: true, force: true });
    },
  };
}

function runHook(fixture, input) {
  const address = fixture.server.address();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [fixture.runtimePath], {
      cwd: fixture.root,
      env: {
        ...process.env,
        MEMORAX_CODE_BACKEND_URL: `http://127.0.0.1:${address.port}`,
        MEMORAX_CODE_MEMORY_SKILL_REMINDER_INTERVAL_TURNS: "1",
        TRAE_CN_HOME: fixture.traeHome,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status, signal) => resolve({
      status,
      signal,
      stdout: stdout.trim(),
      stderr,
    }));
    child.stdin.end(JSON.stringify(input));
  });
}
