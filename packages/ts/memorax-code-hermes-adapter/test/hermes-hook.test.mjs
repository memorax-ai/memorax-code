import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runHermesHook } from "../hooks/memorax-code-hermes-hook.mjs";

const BASE_PAYLOAD = {
  hook_event_name: "pre_llm_call",
  session_id: "session-1",
  cwd: "C:\\work\\project",
  tool_name: null,
  tool_input: null,
  extra: {
    task_id: "task-1",
    turn_id: "turn-1",
    user_message: "hello hermes",
    model: "claude-sonnet-4",
    platform: "hermes",
    conversation_history: [],
    is_first_turn: true,
  },
};

const originalEnv = { ...process.env };

function withBackendEnv(url, token) {
  process.env.MEMORAX_CODE_BACKEND_URL = url;
  process.env.MEMORAX_CODE_BACKEND_TOKEN = token;
}

function restoreEnv() {
  for (const key of ["MEMORAX_CODE_BACKEND_URL", "MEMORAX_CODE_BACKEND_TOKEN"]) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
}

test("pre_llm_call posts turn-start and returns context", async () => {
  withBackendEnv("http://127.0.0.1:8787", "secret-token");
  try {
    let captured;
    const fetchImpl = async (url, init) => {
      captured = { url, init };
      return {
        status: 200,
        json: async () => ({ ok: true, additionalContext: "Remember: user prefers terse answers." }),
      };
    };
    const output = await runHermesHook(BASE_PAYLOAD, { fetchImpl });
    assert.deepEqual(output, { context: "Remember: user prefers terse answers." });
    assert.equal(captured.url, "http://127.0.0.1:8787/memory/turn-start");
    const body = JSON.parse(captured.init.body);
    assert.equal(body.version, 1);
    assert.equal(body.client, "hermes");
    assert.equal(body.sessionId, "session-1");
    assert.equal(body.cwd, "C:\\work\\project");
    assert.equal(body.turnId, "turn-1");
    assert.equal(body.prompt, "hello hermes");
    assert.equal(body.model, "claude-sonnet-4");
    assert.equal(body.platform, "hermes");
    assert.equal(captured.init.headers.authorization, "Bearer secret-token");
    assert.equal(captured.init.headers["content-type"], "application/json");
  } finally {
    restoreEnv();
  }
});

test("on_session_end posts writeback without stdout context", async () => {
  withBackendEnv("http://127.0.0.1:8787", undefined);
  try {
    let captured;
    const fetchImpl = async (url, init) => {
      captured = { url, init };
      return { status: 200, json: async () => ({ ok: true }) };
    };
    const output = await runHermesHook({
      hook_event_name: "on_session_end",
      session_id: "session-1",
      cwd: "C:\\work\\project",
      tool_name: null,
      tool_input: null,
      extra: {
        task_id: "task-1",
        turn_id: "turn-1",
        completed: true,
        interrupted: false,
        failed: false,
        turn_exit_reason: "completed",
        model: "claude-sonnet-4",
        platform: "hermes",
      },
    }, { fetchImpl });
    assert.equal(output, undefined);
    assert.equal(captured.url, "http://127.0.0.1:8787/memory/writeback");
    const body = JSON.parse(captured.init.body);
    assert.equal(body.completed, true);
    assert.equal(body.interrupted, false);
    assert.equal(body.failed, false);
    assert.equal(body.turnExitReason, "completed");
    assert.equal(body.prompt, undefined);
  } finally {
    restoreEnv();
  }
});

test("unknown hook events fail open without requests", async () => {
  withBackendEnv("http://127.0.0.1:8787", "t");
  try {
    let requested = false;
    const fetchImpl = async () => {
      requested = true;
      return { status: 200, json: async () => ({}) };
    };
    const output = await runHermesHook({ hook_event_name: "pre_tool_call" }, { fetchImpl });
    assert.equal(output, undefined);
    assert.equal(requested, false);
  } finally {
    restoreEnv();
  }
});

test("pre_llm_call without user message fails open", async () => {
  withBackendEnv("http://127.0.0.1:8787", "t");
  try {
    let requested = false;
    const fetchImpl = async () => {
      requested = true;
      return { status: 200, json: async () => ({}) };
    };
    const output = await runHermesHook({ ...BASE_PAYLOAD, extra: { ...BASE_PAYLOAD.extra, user_message: "" } }, { fetchImpl });
    assert.equal(output, undefined);
    assert.equal(requested, false);
  } finally {
    restoreEnv();
  }
});

test("missing identity fields fail open", async () => {
  withBackendEnv("http://127.0.0.1:8787", "t");
  try {
    const fetchImpl = async () => ({ status: 200, json: async () => ({}) });
    assert.equal(
      await runHermesHook({ hook_event_name: "pre_llm_call", session_id: "s", cwd: "c" }, { fetchImpl }),
      undefined,
    );
    assert.equal(
      await runHermesHook({ ...BASE_PAYLOAD, extra: { ...BASE_PAYLOAD.extra, turn_id: "" } }, { fetchImpl }),
      undefined,
    );
    assert.equal(
      await runHermesHook({ ...BASE_PAYLOAD, session_id: "" }, { fetchImpl }),
      undefined,
    );
  } finally {
    restoreEnv();
  }
});

test("non-200 and non-JSON responses fail open", async () => {
  withBackendEnv("http://127.0.0.1:8787", "t");
  try {
    const status500 = await runHermesHook(BASE_PAYLOAD, {
      fetchImpl: async () => ({ status: 500, json: async () => ({}) }),
    });
    assert.equal(status500, undefined);
    const nonJson = await runHermesHook(BASE_PAYLOAD, {
      fetchImpl: async () => ({ status: 200, json: async () => "nope" }),
    });
    assert.equal(nonJson, undefined);
  } finally {
    restoreEnv();
  }
});

test("backend outage fails open with diagnostic", async () => {
  withBackendEnv("http://127.0.0.1:8787", "t");
  try {
    const diagnostics = [];
    const output = await runHermesHook(BASE_PAYLOAD, {
      fetchImpl: async () => {
        throw new Error("connection refused");
      },
      diagnostic(label, fields) {
        diagnostics.push({ label, ...fields });
      },
    });
    assert.equal(output, undefined);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].label, "hermes_hook.request_failed");
  } finally {
    restoreEnv();
  }
});

test("empty additional context returns no stdout payload", async () => {
  withBackendEnv("http://127.0.0.1:8787", "t");
  try {
    const output = await runHermesHook(BASE_PAYLOAD, {
      fetchImpl: async () => ({ status: 200, json: async () => ({ ok: true, additionalContext: "" }) }),
    });
    assert.equal(output, undefined);
  } finally {
    restoreEnv();
  }
});

test("end to end: spawned hook posts to a real local backend", async () => {
  const received = [];
  const server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    received.push({ url: request.url, body: JSON.parse(text) });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, additionalContext: "from-e2e" }));
  });
  await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const { port } = server.address();
  const hookPath = join(
    import.meta.dirname,
    "..",
    "hooks",
    "memorax-code-hermes-hook.mjs",
  );
  try {
    const { stdout, stderr } = await spawnHook(hookPath, BASE_PAYLOAD, port);
    assert.equal(stderr, "");
    const output = JSON.parse(stdout);
    assert.deepEqual(output, { context: "from-e2e" });
    assert.equal(received.length, 1);
    assert.equal(received[0].url, "/memory/turn-start");
    assert.equal(received[0].body.turnId, "turn-1");
    assert.equal(received[0].body.client, "hermes");
  } finally {
    server.close();
    restoreEnv();
  }
});

test("end to end: spawned hook exits 0 when the backend is down", async () => {
  const hookPath = join(
    import.meta.dirname,
    "..",
    "hooks",
    "memorax-code-hermes-hook.mjs",
  );
  const { status, stderr } = await spawnHook(hookPath, BASE_PAYLOAD, 59999);
  assert.equal(status, 0);
  assert.match(stderr, /hermes_hook/);
});

test("end to end: runtime generation layout resolves adapter common", async () => {
  const received = [];
  const server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    received.push({ url: request.url, body: JSON.parse(text) });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, additionalContext: "gen-ok" }));
  });
  await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const { port } = server.address();
  const generationRoot = mkdtempSync(join(tmpdir(), "mx-hermes-gen-"));
  try {
    const hooksDir = join(generationRoot, "hooks");
    const commonDir = join(generationRoot, "memorax-code-adapter-common", "src");
    mkdirSync(hooksDir, { recursive: true });
    mkdirSync(commonDir, { recursive: true });
    const hookSource = join(import.meta.dirname, "..", "hooks", "memorax-code-hermes-hook.mjs");
    const commonSource = join(import.meta.dirname, "..", "..", "memorax-code-adapter-common", "src");
    cpSync(hookSource, join(hooksDir, "memorax-code-hermes-hook.mjs"));
    cpSync(commonSource, commonDir, { recursive: true });
    const { stdout, stderr } = await spawnHook(
      join(hooksDir, "memorax-code-hermes-hook.mjs"),
      BASE_PAYLOAD,
      port,
    );
    assert.equal(stderr, "");
    assert.deepEqual(JSON.parse(stdout), { context: "gen-ok" });
    assert.equal(received.length, 1);
    assert.equal(received[0].body.client, "hermes");
  } finally {
    server.close();
    rmSync(generationRoot, { recursive: true, force: true });
    restoreEnv();
  }
});

function spawnHook(hookPath, payload, port) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [hookPath], {
      env: {
        ...process.env,
        HERMES_HOME: "",
        MEMORAX_CODE_BACKEND_URL: `http://127.0.0.1:${port}`,
        MEMORAX_CODE_BACKEND_TOKEN: "e2e-token",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("exit", (status) => resolvePromise({ status, stdout, stderr }));
    child.stdin.end(JSON.stringify(payload));
  });
}
