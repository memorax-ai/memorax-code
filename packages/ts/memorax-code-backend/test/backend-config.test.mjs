import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { backendEnv } from "../dist/config/backend-env.js";
import {
  createBackendState,
  memoryViewerClaudeProjectsRootFromEnv,
} from "../dist/app/state.js";
import { startBackendInstallWatchdog } from "../dist/lifecycle/install-watchdog.js";
import { createBackendServer } from "../dist/server.js";
import { listen } from "./helpers.mjs";

test("Backend env reads only the canonical contract", () => {
  assert.equal(backendEnv("PORT", {
    MEMORAX_CODE_BACKEND_PORT: "9001",
  }), "9001");
  assert.equal(backendEnv("PORT", {}), undefined);
});

test("Backend parses only an explicitly injected Claude Viewer source", () => {
  const root = join(tmpdir(), "memorax-code-explicit-claude-projects");
  assert.equal(memoryViewerClaudeProjectsRootFromEnv({}), undefined);
  assert.equal(memoryViewerClaudeProjectsRootFromEnv({
    CLAUDE_CONFIG_DIR: join(tmpdir(), "implicit-claude-home"),
  }), undefined);
  assert.equal(memoryViewerClaudeProjectsRootFromEnv({
    MEMORAX_CODE_MEMORY_VIEWER_CLAUDE_PROJECTS_ROOT: "disabled",
  }), false);
  assert.equal(memoryViewerClaudeProjectsRootFromEnv({
    MEMORAX_CODE_MEMORY_VIEWER_CLAUDE_PROJECTS_ROOT: root,
  }), root);
});

test("Backend health reports current lifecycle and security state", async () => {
  const sessionHome = await mkdtemp(join(tmpdir(), "memorax-code-health-state-"));
  const server = createBackendServer(createBackendState("127.0.0.1", {
    sessionHome,
    authToken: "",
    security: {
      mode: "local",
      allowExternalAccess: false,
    },
  }));
  const backendUrl = await listen(server);
  try {
    const response = await fetch(new URL("/health", backendUrl));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body, {
      ok: true,
      service: "memorax-code-backend",
      ...(process.env.MEMORAX_CODE_BACKEND_INSTANCE_ID === undefined
        ? {}
        : { instanceId: process.env.MEMORAX_CODE_BACKEND_INSTANCE_ID }),
      authRequired: false,
      security: {
        mode: "local",
        allowExternalAccess: false,
      },
      state: { sessionHome },
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(sessionHome, { recursive: true, force: true });
  }
});

test("Backend lifecycle starts writeback reconciliation and persists terminal status", { concurrency: false }, async () => {
  const sessionHome = await mkdtemp(join(tmpdir(), "memorax-code-backend-writeback-reconciler-"));
  const sessionDir = join(sessionHome, "debug", "traces", "codex", "sessions", "session-lifecycle");
  const eventsPath = join(sessionDir, "events.jsonl");
  const envNames = [
    "MEMORAX_CODE_CODEX_TRACE_ENABLED",
    "MEMORAX_CODE_MEMORAX_API_KEY",
    "MEMORAX_CODE_MEMORAX_ENDPOINT",
    "MEMORAX_CODE_MEMORAX_USER_ID",
    "MEMORAX_CODE_MEMORAX_WRITEBACK_ENABLED",
  ];
  const previousEnv = new Map(envNames.map((name) => [name, process.env[name]]));
  const originalFetch = globalThis.fetch;
  const requests = [];
  let server;
  try {
    await mkdir(sessionDir, { recursive: true });
    await writeFile(eventsPath, JSON.stringify({
      type: "memory_writeback",
      event_id: "writeback-lifecycle",
      timestamp: "2026-07-24T10:00:00Z",
      trace: {
        client: "codex",
        session_id: "session-lifecycle",
        turn_id: "turn-lifecycle",
      },
      source: "codex_hook_writeback",
      operation: "writeback",
      ok: true,
      request: { payload: { messages: [{ role: "user", content: "Persist lifecycle status." }] } },
      response: { raw: { data: { task_id: "task-lifecycle", status: "queued" } } },
    }), "utf8");
    process.env.MEMORAX_CODE_CODEX_TRACE_ENABLED = "true";
    process.env.MEMORAX_CODE_MEMORAX_API_KEY = "test-key";
    process.env.MEMORAX_CODE_MEMORAX_ENDPOINT = "http://memorax.test";
    process.env.MEMORAX_CODE_MEMORAX_USER_ID = "test-user";
    process.env.MEMORAX_CODE_MEMORAX_WRITEBACK_ENABLED = "true";
    globalThis.fetch = async (url) => {
      requests.push(String(url));
      return new Response(JSON.stringify({
        status: "success",
        memory: {
          summary: "Lifecycle reconciliation result.",
          events: [{ id: "memory-lifecycle", event: "ADD" }],
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    };

    server = createBackendServer(createBackendState("127.0.0.1", { sessionHome }));
    await listen(server);
    await waitForFileLines(eventsPath, 2);

    assert.equal(requests.length, 1);
    assert.match(new URL(requests[0]).pathname, /\/v1\/memories\/add\/status\/task-lifecycle$/);
    const events = (await readFile(eventsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(events[1].type, "memory_writeback_status");
    assert.equal(events[1].source, "writeback_reconciler");
    assert.equal(events[1].request.original_event_id, "writeback-lifecycle");
    assert.equal(events[1].response.outcome, "saved");
  } finally {
    if (server) await new Promise((resolve) => server.close(() => resolve()));
    globalThis.fetch = originalFetch;
    for (const [name, value] of previousEnv) restoreEnv(name, value);
    await rm(sessionHome, { recursive: true, force: true });
  }
});

test("Backend CLI reports occupied port without unhandled error stack", async () => {
  const occupied = createServer((_, res) => res.end("busy"));
  const occupiedUrl = await listen(occupied);
  const port = new URL(occupiedUrl).port;
  try {
    const result = await runCommand(process.execPath, [
      fileURLToPath(new URL("../dist/server.js", import.meta.url)),
    ], {
      ...process.env,
      MEMORAX_CODE_BACKEND_HOST: "127.0.0.1",
      MEMORAX_CODE_BACKEND_PORT: port,
    });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /address already in use/);
    assert.match(result.stderr, /MEMORAX_CODE_BACKEND_PORT/);
    assert.doesNotMatch(result.stderr, /Unhandled 'error' event/);
  } finally {
    await new Promise((resolve) => occupied.close(resolve));
  }
});

test("memorax-code CLI documents current commands without exposing trace export", async () => {
  const cliPath = fileURLToPath(new URL("../dist/memorax-code.js", import.meta.url));
  const help = await runCommand(process.execPath, [cliPath, "--help"], { ...process.env });
  assert.equal(help.code, 0);
  assert.match(
    help.stdout,
    /^Usage: memorax-code \[start\|stop\|restart\|uninstall\|logs\|token\|status\]/,
  );
  assert.match(help.stdout, /Memory CLI: memorax-cli status, memorax-cli search/);
  assert.doesNotMatch(help.stdout, /\btrace\b/);

  const trace = await runCommand(process.execPath, [cliPath, "trace"], { ...process.env });
  assert.equal(trace.code, 1);
  assert.match(trace.stderr, /unknown command 'trace'/);
});

test("Backend security defaults to local-only", async () => {
  assert.throws(
    () => createBackendState("0.0.0.0"),
    /external Backend host/,
  );
  assert.throws(
    () => createBackendState("0.0.0.0", {
      security: { allowExternalAccess: true },
    }),
    /MEMORAX_CODE_BACKEND_TOKEN is required/,
  );

  const server = createBackendServer(createBackendState("127.0.0.1"));
  const backendUrl = await listen(server);
  try {
    const health = await fetch(new URL("/health", backendUrl));
    assert.equal(health.status, 200);
    const body = await health.json();
    assert.equal(body.security.mode, "local");
    assert.equal(body.security.allowExternalAccess, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("install watchdog reports package removal without owning client cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-install-watchdog-"));
  const sentinel = join(root, "package.json");
  let shutdownEvent;
  let watchdog;

  try {
    await writeFile(sentinel, JSON.stringify({ name: "@memorax/memorax-code", version: "0.1.2" }));
    watchdog = startBackendInstallWatchdog({
      enabled: true,
      paths: [sentinel],
      intervalMs: 25,
      graceMs: 50,
      exitProcess: false,
    }, (event) => {
      shutdownEvent = event;
    });

    await rm(sentinel);
    const shutdownDeadline = Date.now() + 2000;
    while (Date.now() < shutdownDeadline && !shutdownEvent) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(shutdownEvent, {
      reason: "install_missing",
      missingPaths: [sentinel],
    });
  } finally {
    watchdog?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("raw Backend process composes package-removal cleanup and exits after the install disappears", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-install-watchdog-process-"));
  const sentinel = join(root, "package.json");
  const port = await freePort();
  await writeFile(sentinel, "{}\n");
  const child = spawn(process.execPath, [
    fileURLToPath(new URL("../dist/server.js", import.meta.url)),
  ], {
    env: {
      ...process.env,
      HOME: join(root, "home"),
      MEMORAX_CODE_HOME: join(root, "memorax-code-home"),
      CODEX_HOME: join(root, "codex-home"),
      CLAUDE_CONFIG_DIR: join(root, "claude-home"),
      MEMORAX_CODE_BACKEND_HOST: "127.0.0.1",
      MEMORAX_CODE_BACKEND_PORT: String(port),
      MEMORAX_CODE_INSTALL_WATCHDOG: "1",
      MEMORAX_CODE_INSTALL_WATCH_PATHS: sentinel,
      MEMORAX_CODE_INSTALL_WATCH_INTERVAL_MS: "25",
      MEMORAX_CODE_INSTALL_WATCH_GRACE_MS: "50",
      MEMORAX_CODE_INSTALL_WATCH_EXIT: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });

  try {
    await waitFor(() => stdout.includes(`listening on http://127.0.0.1:${port}`));
    await rm(sentinel);
    const result = await waitForChildExit(child);
    assert.equal(result.code, 0, `${stdout}\n${stderr}`);
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    await rm(root, { recursive: true, force: true });
  }
});

test("Backend memory routes reject invalid, oversized, and encoded JSON bodies", async () => {
  const server = createBackendServer(createBackendState("127.0.0.1"));
  const backendUrl = await listen(server);
  const previousLimit = process.env.MEMORAX_CODE_BACKEND_MAX_JSON_BODY_BYTES;
  try {
    const invalid = await fetch(new URL("/memory/turn-start", backendUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    assert.equal(invalid.status, 400);
    assert.match((await invalid.json()).error, /valid JSON/);

    const identity = await fetch(new URL("/memory/turn-start", backendUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-encoding": "identity",
      },
      body: JSON.stringify({
        version: 1,
        client: "codex",
        sessionId: "identity-command",
        prompt: "Identity encoding is accepted.",
        transcriptPath: "/tmp/identity-command.jsonl",
      }),
    });
    assert.equal(identity.status, 200);

    for (const encoding of ["gzip", "x-gzip", "deflate", "br", "zstd"]) {
      const encoded = await fetch(new URL("/memory/turn-start", backendUrl), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-encoding": encoding,
        },
        body: JSON.stringify({ client: "codex" }),
      });
      assert.equal(encoded.status, 415, encoding);
      assert.match(
        (await encoded.json()).error,
        new RegExp(`unsupported content-encoding: ${encoding}`),
      );
    }

    process.env.MEMORAX_CODE_BACKEND_MAX_JSON_BODY_BYTES = "1024";
    const oversized = await fetch(new URL("/memory/turn-start", backendUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "x".repeat(1_100) }),
    });
    assert.equal(oversized.status, 413);
    assert.match((await oversized.json()).error, /exceeds 1024 bytes/);
  } finally {
    restoreEnv("MEMORAX_CODE_BACKEND_MAX_JSON_BODY_BYTES", previousLimit);
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Backend does not expose model-provider routes", async () => {
  const server = createBackendServer(createBackendState("127.0.0.1"));
  const backendUrl = await listen(server);
  try {
    for (const path of ["/v1/messages", "/v1/responses"]) {
      const response = await fetch(new URL(path, backendUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(response.status, 404, path);
      assert.deepEqual(await response.json(), { ok: false, error: "not found" });
    }
    assert.equal((await fetch(new URL("/v1/models", backendUrl))).status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(predicate) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("timed out waiting for Backend process state");
}

function waitForChildExit(child) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("timed out waiting for Backend process exit"));
    }, 5_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
}

async function waitForFileLines(path, expectedLines) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const lines = await readFile(path, "utf8")
      .then((text) => text.trim().split("\n").filter(Boolean).length);
    if (lines >= expectedLines) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${expectedLines} lines in ${path}`);
}

function runCommand(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`command timed out: ${command}`));
    }, 5000);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
  });
}
