import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildClaudeMarketplace } from "../scripts/build-marketplace.mjs";

const hookPath = fileURLToPath(new URL("../hooks/runtime-hook.mjs", import.meta.url));

test("healthy backend leaves Claude adapter lifecycle unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-claude-ensure-healthy-"));
  const callsPath = join(root, "calls.jsonl");
  const command = await fakeMemoraxCode(root);
  const backend = await healthyBackend();
  try {
    const result = await runHook({
      MEMORAX_CODE_BACKEND_URL: backend.url,
      MEMORAX_CODE_CLAUDE_LIFECYCLE_COMMAND: command,
      MEMORAX_CODE_TEST_ARGS_PATH: callsPath,
    });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(await readCalls(callsPath), []);
  } finally {
    await backend.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("unhealthy backend restores the persisted shared client selection", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-claude-ensure-start-"));
  const callsPath = join(root, "calls.jsonl");
  const command = await fakeMemoraxCode(root);
  const memoraxCodeHome = join(root, "memorax-code-home");
  const claudeHome = join(root, "claude-home");
  try {
    const result = await runHook({
      MEMORAX_CODE_HOME: memoraxCodeHome,
      CLAUDE_CONFIG_DIR: claudeHome,
      MEMORAX_CODE_BACKEND_URL: "http://127.0.0.1:9",
      MEMORAX_CODE_CLAUDE_ENSURE_TIMEOUT_MS: "50",
      MEMORAX_CODE_CLAUDE_LIFECYCLE_COMMAND: command,
      MEMORAX_CODE_TEST_ARGS_PATH: callsPath,
    });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(await readCalls(callsPath), [[
      "start",
      "--home",
      memoraxCodeHome,
      "--claude-home",
      claudeHome,
      "--host",
      "127.0.0.1",
      "--port",
      "9",
      "--preserve-clients",
      "--json",
    ]]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unhealthy remote Backend does not trigger local lifecycle recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-claude-ensure-remote-"));
  const callsPath = join(root, "calls.jsonl");
  const command = await fakeMemoraxCode(root);
  try {
    const result = await runHook({
      MEMORAX_CODE_HOME: join(root, "memorax-code-home"),
      CLAUDE_CONFIG_DIR: join(root, "claude-home"),
      MEMORAX_CODE_BACKEND_URL: "http://backend.example:8877",
      MEMORAX_CODE_CLAUDE_ENSURE_TIMEOUT_MS: "50",
      MEMORAX_CODE_CLAUDE_LIFECYCLE_COMMAND: command,
      MEMORAX_CODE_TEST_ARGS_PATH: callsPath,
    });

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(await readCalls(callsPath), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unhealthy Backend recovery preserves the persisted host and port", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-claude-ensure-connection-"));
  const callsPath = join(root, "calls.jsonl");
  const command = await fakeMemoraxCode(root);
  const memoraxCodeHome = join(root, "memorax-code-home");
  const claudeHome = join(root, "claude-home");
  const runtime = join(memoraxCodeHome, "runtime", "backend");
  try {
    await mkdir(runtime, { recursive: true });
    await writeFile(join(runtime, "backend-connection.json"), `${JSON.stringify({
      version: 1,
      url: "http://127.0.0.1:9",
    })}\n`);
    const result = await runHook({
      MEMORAX_CODE_HOME: memoraxCodeHome,
      CLAUDE_CONFIG_DIR: claudeHome,
      MEMORAX_CODE_BACKEND_URL: "",
      MEMORAX_CODE_CLAUDE_ENSURE_TIMEOUT_MS: "50",
      MEMORAX_CODE_CLAUDE_LIFECYCLE_COMMAND: command,
      MEMORAX_CODE_TEST_ARGS_PATH: callsPath,
    });

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(await readCalls(callsPath), [[
      "start",
      "--home", memoraxCodeHome,
      "--claude-home", claudeHome,
      "--host", "127.0.0.1",
      "--port", "9",
      "--preserve-clients",
      "--json",
    ]]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unsupported connection authority fails open without local lifecycle recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-claude-ensure-unsupported-"));
  const callsPath = join(root, "calls.jsonl");
  const command = await fakeMemoraxCode(root);
  const memoraxCodeHome = join(root, "memorax-code-home");
  const runtime = join(memoraxCodeHome, "runtime", "backend");
  try {
    await mkdir(runtime, { recursive: true });
    await writeFile(join(runtime, "backend-connection.json"), `${JSON.stringify({
      version: 2,
      url: "http://127.0.0.1:9",
    })}\n`);
    const result = await runHook({
      MEMORAX_CODE_HOME: memoraxCodeHome,
      CLAUDE_CONFIG_DIR: join(root, "claude-home"),
      MEMORAX_CODE_BACKEND_URL: "",
      MEMORAX_CODE_BACKEND_HOST: "",
      MEMORAX_CODE_BACKEND_PORT: "",
      MEMORAX_CODE_CLAUDE_LIFECYCLE_COMMAND: command,
      MEMORAX_CODE_CLAUDE_HOOK_DEBUG: "1",
      MEMORAX_CODE_TEST_ARGS_PATH: callsPath,
    });

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /Backend connection authority uses unsupported version 2/);
    assert.deepEqual(await readCalls(callsPath), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unhealthy backend resolves memorax-code from installed plugin metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-claude-ensure-metadata-"));
  const callsPath = join(root, "calls.jsonl");
  const command = await fakeMemoraxCode(root);
  try {
    const built = await buildClaudeMarketplace({ outputDir: join(root, "marketplace") });
    const stagedPlugin = built.pluginRoot;
    const stagedHook = join(stagedPlugin, "hooks", "runtime-hook.mjs");
    await writeFile(join(stagedPlugin, ".memorax-code-package.json"), `${JSON.stringify({ memoraxCodeCommand: command })}\n`);
    const result = await runHook({
      CLAUDE_PLUGIN_ROOT: stagedPlugin,
      MEMORAX_CODE_BACKEND_URL: "http://127.0.0.1:9",
      MEMORAX_CODE_CLAUDE_ENSURE_TIMEOUT_MS: "50",
      MEMORAX_CODE_CLAUDE_LIFECYCLE_COMMAND: "",
      MEMORAX_CODE_COMMAND: "",
      MEMORAX_CODE_HOME: join(root, "memorax-code-home"),
      MEMORAX_CODE_TEST_ARGS_PATH: callsPath,
    }, {
      hook_event_name: "SessionStart",
      session_id: "metadata-session",
    }, stagedHook);
    assert.equal(result.code, 0, result.stderr);
    assert.equal((await readCalls(callsPath)).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("disabled Claude ensure-backend Hook is inert", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-claude-ensure-disabled-"));
  const callsPath = join(root, "calls.jsonl");
  const command = await fakeMemoraxCode(root);
  try {
    const result = await runHook({
      MEMORAX_CODE_CLAUDE_ENSURE_BACKEND: "0",
      MEMORAX_CODE_CLAUDE_LIFECYCLE_COMMAND: command,
      MEMORAX_CODE_TEST_ARGS_PATH: callsPath,
    });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(await readCalls(callsPath), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function runHook(env, input = {
  hook_event_name: "SessionStart",
  session_id: "ensure-backend-session",
  source: "startup",
}, path = hookPath) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path, "ensure-backend"], {
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

async function fakeMemoraxCode(root) {
  const path = join(root, "fake-memorax-code.mjs");
  await writeFile(path, [
    'import { appendFileSync } from "node:fs";',
    'appendFileSync(process.env.MEMORAX_CODE_TEST_ARGS_PATH, `${JSON.stringify(process.argv.slice(2))}\\n`);',
  ].join("\n"));
  return path;
}

async function healthyBackend() {
  const server = createServer((request, response) => {
    if (request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, service: "memorax-code-backend" }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.equal(typeof address, "object");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function readCalls(path) {
  try {
    return (await readFile(path, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}
