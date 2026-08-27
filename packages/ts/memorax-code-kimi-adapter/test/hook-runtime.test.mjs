import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runKimiHook } from "../src/hook-runtime.mjs";

test("Kimi UserPromptSubmit queries the Backend and returns plain context", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-kimi-hook-"));
  const requests = [];
  try {
    const result = await runKimiHook({
      hook_event_name: "UserPromptSubmit",
      session_id: "session-1",
      cwd: "/workspace/project",
      prompt: [{ type: "text", text: "remember this" }],
    }, {
      backendUrl: "http://127.0.0.1:8787",
      memoraxCodeHome: root,
      statePath: join(root, "correlations.json"),
      fetchImpl: async (url, request) => {
        requests.push({ url: String(url), body: JSON.parse(request.body) });
        return new Response(JSON.stringify({ ok: true, additionalContext: "memory context" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    assert.match(result.additionalContext, /^memory context\n\nMemoraX Code reminder:/);
    assert.deepEqual(requests[0], {
      url: "http://127.0.0.1:8787/memory/turn-start",
      body: {
        version: 1,
        client: "kimi",
        sessionId: "session-1",
        promptId: createHash("sha256").update("remember this").digest("hex"),
        prompt: "remember this",
        cwd: "/workspace/project",
      },
    });
    assert.equal(requests[1].url, "http://127.0.0.1:8787/memory/skill-reminder");
    const state = JSON.parse(await readFile(join(root, "correlations.json"), "utf8"));
    assert.equal(state.sessions["session-1"].length, 1);
    assert.equal(typeof state.sessions["session-1"][0].promptHash, "string");
    assert.equal("prompt" in state.sessions["session-1"][0], false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Kimi flushes an exact completed turn on a later observation hook", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-kimi-flush-"));
  const sessionId = "session-flush";
  const sessionDir = join(root, "sessions", "wd-project", sessionId);
  const wirePath = join(sessionDir, "agents", "main", "wire.jsonl");
  const statePath = join(root, "correlations.json");
  const requests = [];
  await mkdir(join(sessionDir, "agents", "main"), { recursive: true });
  await writeFile(join(root, "session_index.jsonl"), `${JSON.stringify({
    sessionId,
    sessionDir,
    workDir: "/workspace/project",
  })}\n`);
  await writeFile(wirePath, "");
  const options = {
    backendUrl: "http://127.0.0.1:8787",
    memoraxCodeHome: root,
    kimiCodeHome: root,
    statePath,
    fetchImpl: async (url, request) => {
      const captured = { url: String(url), body: JSON.parse(request.body) };
      requests.push(captured);
      const writebackCount = requests.filter((item) => item.url.endsWith("/memory/writeback")).length;
      return new Response(JSON.stringify(captured.url.endsWith("/memory/writeback")
        ? writebackCount === 1
          ? { ok: true, scheduled: false, reason: "config_missing" }
          : { ok: true, scheduled: true }
        : { ok: true }), { status: 200 });
    },
  };
  try {
    await runKimiHook({
      hook_event_name: "UserPromptSubmit",
      session_id: sessionId,
      cwd: "/workspace/project",
      prompt: "write this back",
    }, options);
    await runKimiHook({
      hook_event_name: "TurnStarted",
      session_id: sessionId,
      turn_id: 3,
      prompt: "write this back",
    }, options);
    await writeFile(wirePath, `${[
      { type: "prompt.accepted", promptId: "native-prompt" },
      { type: "turn.prompt", origin: { kind: "user" }, input: [{ type: "text", text: "write this back" }] },
      { type: "context.append_loop_event", event: { type: "step.begin", turnId: 3 } },
      { type: "context.append_loop_event", event: { type: "content.part", turnId: 3, part: { type: "text", text: "done" } } },
      { type: "turn.ended", turnId: 3, reason: "completed" },
    ].map(JSON.stringify).join("\n")}\n`);
    await runKimiHook({
      hook_event_name: "SessionHeartbeat",
      session_id: sessionId,
      cwd: "/workspace/project",
    }, options);
    assert.equal(requests.length, 3);
    assert.equal(requests[2].url, "http://127.0.0.1:8787/memory/writeback");
    assert.deepEqual(requests[2].body, {
      version: 1,
      client: "kimi",
      sessionId,
      promptId: createHash("sha256").update("write this back").digest("hex"),
      turnId: "3",
      wirePath: await realpath(wirePath),
      cwd: "/workspace/project",
    });
    let state = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(state.sessions[sessionId].length, 1);
    await runKimiHook({
      hook_event_name: "SessionHeartbeat",
      session_id: sessionId,
      cwd: "/workspace/project",
    }, options);
    assert.equal(requests.length, 4);
    state = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(state.sessions[sessionId], undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Kimi PostCompact schedules a reminder for the next user prompt", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-kimi-compact-reminder-"));
  const options = {
    backendUrl: "http://127.0.0.1:8787",
    memoraxCodeHome: root,
    statePath: join(root, "correlations.json"),
    fetchImpl: async (url, request) => {
      const path = new URL(String(url)).pathname;
      return new Response(JSON.stringify(path === "/memory/turn-start"
        ? { ok: true }
        : { ok: true }), { status: 200 });
    },
  };
  try {
    await runKimiHook({
      hook_event_name: "UserPromptSubmit",
      session_id: "session-compact",
      prompt: "first prompt",
    }, options);
    await runKimiHook({
      hook_event_name: "PostCompact",
      session_id: "session-compact",
    }, options);
    const result = await runKimiHook({
      hook_event_name: "UserPromptSubmit",
      session_id: "session-compact",
      prompt: "second prompt",
    }, options);
    assert.match(result.additionalContext, /MemoraX Code .*reminder:/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Kimi TurnStarted only attaches the real turn id", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-kimi-turn-"));
  const statePath = join(root, "correlations.json");
  try {
    await runKimiHook({
      hook_event_name: "UserPromptSubmit",
      session_id: "session-2",
      prompt: [{ type: "text", text: "same prompt" }],
    }, {
      backendUrl: "http://127.0.0.1:8787",
      statePath,
      fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    });
    const result = await runKimiHook({
      hook_event_name: "TurnStarted",
      session_id: "session-2",
      turn_id: 7,
      prompt: "same prompt",
    }, { statePath });
    assert.deepEqual(result, { correlation: { matched: true, turnId: "7" } });
    const state = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(state.sessions["session-2"][0].turnId, "7");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Kimi deduplicates repeated prompt events until a turn is attached", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-kimi-prompt-dedupe-"));
  const statePath = join(root, "correlations.json");
  const requests = [];
  try {
    await writeFile(join(root, "config.toml"), "[memory.skill_reminder]\ninterval_turns = 1\n");
    const options = {
      backendUrl: "http://127.0.0.1:8787",
      memoraxCodeHome: root,
      statePath,
      fetchImpl: async (url, request) => {
        requests.push({ url: String(url), body: JSON.parse(request.body) });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    };
    await runKimiHook({
      hook_event_name: "UserPromptSubmit",
      session_id: "session-dedupe",
      prompt: "same prompt",
    }, options);
    await runKimiHook({
      hook_event_name: "UserPromptSubmit",
      session_id: "session-dedupe",
      prompt: "same prompt",
    }, options);
    let state = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(state.sessions["session-dedupe"].length, 1);
    assert.equal(requests.filter((item) => item.url.endsWith("/memory/skill-reminder")).length, 1);

    await runKimiHook({
      hook_event_name: "TurnStarted",
      session_id: "session-dedupe",
      turn_id: "first",
      prompt: "same prompt",
    }, options);
    state = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(state.sessions["session-dedupe"][0].turnId, "first");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Kimi matches a later identical prompt to its unbound entry", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-kimi-prompt-order-"));
  const statePath = join(root, "correlations.json");
  try {
    await writeFile(join(root, "config.toml"), "[memory.skill_reminder]\ninterval_turns = 1\n");
    const options = {
      backendUrl: "http://127.0.0.1:8787",
      statePath,
      fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    };
    await runKimiHook({
      hook_event_name: "UserPromptSubmit",
      session_id: "session-order",
      prompt: "same prompt",
    }, options);
    await runKimiHook({
      hook_event_name: "TurnStarted",
      session_id: "session-order",
      turn_id: "first",
      prompt: "same prompt",
    }, options);
    await runKimiHook({
      hook_event_name: "UserPromptSubmit",
      session_id: "session-order",
      prompt: "same prompt",
    }, options);
    await runKimiHook({
      hook_event_name: "TurnStarted",
      session_id: "session-order",
      turn_id: "second",
      prompt: "same prompt",
    }, options);
    const state = JSON.parse(await readFile(statePath, "utf8"));
    assert.deepEqual(state.sessions["session-order"].map((entry) => entry.turnId), ["first", "second"]);
    assert.notEqual(state.sessions["session-order"][0].reminderId, state.sessions["session-order"][1].reminderId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
