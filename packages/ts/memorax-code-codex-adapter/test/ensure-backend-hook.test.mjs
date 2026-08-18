import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_ENSURE_BACKEND_START_TIMEOUT_MS,
  ensureBackendAvailable,
} from "../../memorax-code-adapter-common/src/hooks/ensure-backend-runner.mjs";
import { enableCodexAdapter, readCodexAdapterStatus } from "../src/config.mjs";

const pluginRoot = fileURLToPath(new URL("..", import.meta.url));
const hookPath = join(pluginRoot, "hooks", "runtime-hook.mjs");

test("ensure-backend process ceiling leaves room for lifecycle lock wait and recovery", () => {
  assert.equal(DEFAULT_ENSURE_BACKEND_START_TIMEOUT_MS, 90000);
});

test("shared Backend recovery passes caller-supplied internal environment", async () => {
  const f = await fixture();
  const recordPath = join(f.root, "recovery.json");
  const command = join(f.root, "recovery-memorax-code.mjs");
  await writeFile(command, [
    'import { writeFileSync } from "node:fs";',
    'writeFileSync(process.env.MEMORAX_CODE_TEST_RECORD_PATH, JSON.stringify({',
    '  marker: process.env.MEMORAX_CODE_DSH_ADAPTER_RECOVERY,',
    '  revision: process.env.MEMORAX_CODE_DSH_ADAPTER_EXPECTED_REVISION,',
    '}));',
  ].join("\n"));

  await ensureBackendAvailable({
    backendConnection: {
      memoraxCodeHome: f.memoraxCodeHome,
      url: "http://127.0.0.1:9",
      source: "environment",
    },
    healthTimeoutValue: "50",
    memoraxCodeCommand: command,
    nodePath: process.execPath,
    resolveHomes: () => ({ memoraxCodeHome: f.memoraxCodeHome }),
    buildStartArgs: () => ["start"],
    recoveryEnv: {
      MEMORAX_CODE_TEST_RECORD_PATH: recordPath,
      MEMORAX_CODE_DSH_ADAPTER_RECOVERY: "1",
      MEMORAX_CODE_DSH_ADAPTER_EXPECTED_REVISION: "revision-1",
    },
  });

  assert.deepEqual(JSON.parse(await readFile(recordPath, "utf8")), {
    marker: "1",
    revision: "revision-1",
  });
});

async function fixture(prefix = "memorax-code-ensure-hooks-") {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const codexHome = join(root, "codex-home");
  const memoraxCodeHome = join(root, "memorax-code-home");
  await mkdir(codexHome, { recursive: true });
  await mkdir(memoraxCodeHome, { recursive: true });
  return { root, codexHome, memoraxCodeHome };
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
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function fakeMemoraxCode(root) {
  const command = join(root, "fake-memorax-code.mjs");
  await writeFile(command, [
    'import { appendFileSync } from "node:fs";',
    'appendFileSync(process.env.MEMORAX_CODE_TEST_ARGS_PATH, `${JSON.stringify(process.argv.slice(2))}\\n`);',
  ].join("\n"));
  return command;
}

async function hangingMemoraxCode(root) {
  const command = join(root, "hanging-memorax-code.mjs");
  await writeFile(command, "setInterval(() => {}, 1000);\n");
  return command;
}

function runHook({
  env = {},
  input = {
    hook_event_name: "SessionStart",
    session_id: "ensure-backend-session",
  },
} = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [hookPath, "ensure-backend"], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(`${JSON.stringify(input)}\n`);
  });
}

async function readArgs(path) {
  try {
    return (await readFile(path, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

test("healthy Backend reconciles a missing adapter state to shared Hooks", async () => {
  const f = await fixture();
  const backend = await healthyBackend();
  try {
    const result = await runHook({
      env: {
        CODEX_HOME: f.codexHome,
        MEMORAX_CODE_HOME: f.memoraxCodeHome,
        MEMORAX_CODE_BACKEND_URL: backend.url,
        PLUGIN_ROOT: pluginRoot,
      },
    });
    assert.equal(result.code, 0, result.stderr);
    const status = readCodexAdapterStatus({
      codexHome: f.codexHome,
      memoraxCodeHome: f.memoraxCodeHome,
      codexPluginSkillsRoot: join(pluginRoot, "skills"),
    });
    assert.equal(status.enabled, true);
    assert.equal(status.integration, "hooks");
    assert.equal(status.codexSkills.status, "plugin-managed");
  } finally {
    await backend.close();
  }
});

test("healthy Backend does not invoke memorax-code when Hook adapter is already ready", async () => {
  const f = await fixture();
  const backend = await healthyBackend();
  const argsPath = join(f.root, "args.jsonl");
  const command = await fakeMemoraxCode(f.root);
  enableCodexAdapter({
    codexHome: f.codexHome,
    memoraxCodeHome: f.memoraxCodeHome,
    backendUrl: backend.url,
    codexPluginSkillsRoot: join(pluginRoot, "skills"),
  });
  try {
    const result = await runHook({
      env: {
        CODEX_HOME: f.codexHome,
        MEMORAX_CODE_HOME: f.memoraxCodeHome,
        MEMORAX_CODE_BACKEND_URL: backend.url,
        MEMORAX_CODE_CODEX_LIFECYCLE_COMMAND: command,
        MEMORAX_CODE_TEST_ARGS_PATH: argsPath,
        PLUGIN_ROOT: pluginRoot,
      },
    });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(await readArgs(argsPath), []);
  } finally {
    await backend.close();
  }
});

test("unhealthy Backend starts memorax-code for Codex", async () => {
  const f = await fixture();
  const argsPath = join(f.root, "args.jsonl");
  const command = await fakeMemoraxCode(f.root);
  const result = await runHook({
    env: {
      CODEX_HOME: f.codexHome,
      MEMORAX_CODE_HOME: f.memoraxCodeHome,
      MEMORAX_CODE_BACKEND_URL: "http://127.0.0.1:9",
      MEMORAX_CODE_CODEX_ENSURE_TIMEOUT_MS: "50",
      MEMORAX_CODE_CODEX_LIFECYCLE_COMMAND: command,
      MEMORAX_CODE_TEST_ARGS_PATH: argsPath,
    },
  });
  assert.equal(result.code, 0, result.stderr);
  const [args] = await readArgs(argsPath);
  assert.deepEqual(args, [
    "start",
    "--home", f.memoraxCodeHome,
    "--codex-home", f.codexHome,
    "--host", "127.0.0.1",
    "--port", "9",
  ]);
});

test("unhealthy remote Backend does not trigger local lifecycle recovery", async () => {
  const f = await fixture();
  const argsPath = join(f.root, "args.jsonl");
  const command = await fakeMemoraxCode(f.root);
  const result = await runHook({
    env: {
      CODEX_HOME: f.codexHome,
      MEMORAX_CODE_HOME: f.memoraxCodeHome,
      MEMORAX_CODE_BACKEND_URL: "http://backend.example:8877",
      MEMORAX_CODE_CODEX_ENSURE_TIMEOUT_MS: "50",
      MEMORAX_CODE_CODEX_LIFECYCLE_COMMAND: command,
      MEMORAX_CODE_TEST_ARGS_PATH: argsPath,
    },
  });

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(await readArgs(argsPath), []);
});

test("unhealthy Backend recovery preserves the persisted host and port", async () => {
  const f = await fixture();
  const argsPath = join(f.root, "args.jsonl");
  const command = await fakeMemoraxCode(f.root);
  const runtime = join(f.memoraxCodeHome, "runtime", "backend");
  await mkdir(runtime, { recursive: true });
  await writeFile(join(runtime, "backend-connection.json"), `${JSON.stringify({
    version: 1,
    url: "http://127.0.0.1:9",
  })}\n`);

  const result = await runHook({
    env: {
      CODEX_HOME: f.codexHome,
      MEMORAX_CODE_HOME: f.memoraxCodeHome,
      MEMORAX_CODE_BACKEND_URL: "",
      MEMORAX_CODE_CODEX_ENSURE_TIMEOUT_MS: "50",
      MEMORAX_CODE_CODEX_LIFECYCLE_COMMAND: command,
      MEMORAX_CODE_TEST_ARGS_PATH: argsPath,
    },
  });

  assert.equal(result.code, 0, result.stderr);
  const [args] = await readArgs(argsPath);
  assert.deepEqual(args, [
    "start",
    "--home", f.memoraxCodeHome,
    "--codex-home", f.codexHome,
    "--host", "127.0.0.1",
    "--port", "9",
  ]);
});

test("invalid connection authority fails open without local lifecycle recovery", async () => {
  const f = await fixture();
  const argsPath = join(f.root, "args.jsonl");
  const command = await fakeMemoraxCode(f.root);
  const runtime = join(f.memoraxCodeHome, "runtime", "backend");
  await mkdir(runtime, { recursive: true });
  await writeFile(join(runtime, "backend-connection.json"), "{not-json\n");

  const result = await runHook({
    env: {
      CODEX_HOME: f.codexHome,
      MEMORAX_CODE_HOME: f.memoraxCodeHome,
      MEMORAX_CODE_BACKEND_URL: "",
      MEMORAX_CODE_BACKEND_HOST: "",
      MEMORAX_CODE_BACKEND_PORT: "",
      MEMORAX_CODE_CODEX_LIFECYCLE_COMMAND: command,
      MEMORAX_CODE_CODEX_HOOK_DEBUG: "1",
      MEMORAX_CODE_TEST_ARGS_PATH: argsPath,
    },
  });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /Backend connection authority is invalid/);
  assert.deepEqual(await readArgs(argsPath), []);
});

test("Backend start recovery remains bounded and fails open on timeout", async () => {
  const f = await fixture();
  const command = await hangingMemoraxCode(f.root);
  const startedAt = Date.now();
  const result = await runHook({
    env: {
      CODEX_HOME: f.codexHome,
      MEMORAX_CODE_HOME: f.memoraxCodeHome,
      MEMORAX_CODE_BACKEND_URL: "http://127.0.0.1:9",
      MEMORAX_CODE_CODEX_ENSURE_TIMEOUT_MS: "50",
      MEMORAX_CODE_CODEX_START_TIMEOUT_MS: "50",
      MEMORAX_CODE_CODEX_LIFECYCLE_COMMAND: command,
      MEMORAX_CODE_CODEX_HOOK_DEBUG: "1",
    },
  });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /MemoraX Code backend start failed with code 124: timed out/);
  assert.ok(Date.now() - startedAt < 2_000);
});

test("ensure-backend resolves memorax-code command from plugin metadata", async () => {
  const f = await fixture();
  const argsPath = join(f.root, "args.jsonl");
  const command = await fakeMemoraxCode(f.root);
  const stagedPlugin = join(f.root, "staged-plugin");
  await mkdir(stagedPlugin, { recursive: true });
  await writeFile(join(stagedPlugin, ".memorax-code-package.json"), `${JSON.stringify({ memoraxCodeCommand: command })}\n`);
  const result = await runHook({
    env: {
      CODEX_HOME: f.codexHome,
      MEMORAX_CODE_HOME: f.memoraxCodeHome,
      MEMORAX_CODE_BACKEND_URL: "http://127.0.0.1:9",
      MEMORAX_CODE_CODEX_ENSURE_TIMEOUT_MS: "50",
      MEMORAX_CODE_TEST_ARGS_PATH: argsPath,
      PLUGIN_ROOT: stagedPlugin,
      MEMORAX_CODE_CODEX_LIFECYCLE_COMMAND: "",
      MEMORAX_CODE_COMMAND: "",
    },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal((await readArgs(argsPath)).length, 1);
});

test("disabled ensure-backend hook exits without state or command changes", async () => {
  const f = await fixture();
  const argsPath = join(f.root, "args.jsonl");
  const command = await fakeMemoraxCode(f.root);
  const result = await runHook({
    env: {
      CODEX_HOME: f.codexHome,
      MEMORAX_CODE_HOME: f.memoraxCodeHome,
      MEMORAX_CODE_CODEX_ENSURE_BACKEND: "0",
      MEMORAX_CODE_CODEX_LIFECYCLE_COMMAND: command,
      MEMORAX_CODE_TEST_ARGS_PATH: argsPath,
    },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(await readArgs(argsPath), []);
  await assert.rejects(access(join(f.memoraxCodeHome, "adapters", "codex", "state.json")), /ENOENT/);
});

test("missing metadata command leaves stale plugin Hook inert after backend removal", async () => {
  const f = await fixture();
  const removedCommand = join(f.root, "removed", "memorax-code.mjs");
  const result = await runHook({
    env: {
      CODEX_HOME: f.codexHome,
      MEMORAX_CODE_HOME: f.memoraxCodeHome,
      MEMORAX_CODE_BACKEND_URL: "http://127.0.0.1:9",
      MEMORAX_CODE_CODEX_ENSURE_TIMEOUT_MS: "50",
      MEMORAX_CODE_CODEX_LIFECYCLE_COMMAND: removedCommand,
    },
  });
  assert.equal(result.code, 0, result.stderr);
});
