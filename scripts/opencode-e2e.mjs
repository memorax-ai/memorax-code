#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OPENCODE_VERSION = "1.18.16";
const PROMPT = "Reply with exactly: OpenCode E2E completed.";
const REPLY = "OpenCode E2E completed.";

const root = await mkdtemp(join(tmpdir(), "memorax-code-opencode-e2e-"));
const home = join(root, "home");
const memoraxCodeHome = join(root, "memorax-code-home");
const openCodeConfigDir = join(root, "xdg-config", "opencode");
const prefix = join(root, "npm-prefix");
const workspace = join(root, "workspace");
const stagingRoot = join(repoRoot, "dist", `opencode-e2e-${process.pid}`);
const npmCache = join(root, "npm-cache");
const userConfigPath = join(openCodeConfigDir, "opencode.jsonc");
const backendPort = await freePort();
let memoryStub;
let modelStub;
let openCode;
let backendStarted = false;

const inheritedEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => (
  !key.startsWith("MEMORAX_CODE_")
  && !key.startsWith("OPENCODE_")
  && !key.startsWith("XDG_")
)));
const env = {
  ...inheritedEnv,
  HOME: home,
  MEMORAX_CODE_HOME: memoraxCodeHome,
  OPENCODE_CONFIG_DIR: openCodeConfigDir,
  XDG_CONFIG_HOME: dirname(openCodeConfigDir),
  XDG_DATA_HOME: join(root, "xdg-data"),
  XDG_STATE_HOME: join(root, "xdg-state"),
  XDG_CACHE_HOME: join(root, "xdg-cache"),
  NPM_CONFIG_CACHE: npmCache,
  NPM_CONFIG_FUND: "false",
  NPM_CONFIG_AUDIT: "false",
  MEMORAX_CODE_BACKEND_PORT: String(backendPort),
  MEMORAX_CODE_MEMORY_RETRIEVAL_ENABLED: "true",
  MEMORAX_CODE_MEMORY_WRITEBACK_ENABLED: "true",
  MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_ENABLED: "false",
  MEMORAX_CODE_MEMORAX_API_KEY: "opencode-e2e-key",
  MEMORAX_CODE_MEMORAX_USER_ID: "opencode-e2e-user",
  MEMORAX_CODE_BACKEND_TOKEN: "opencode-e2e-backend-token",
  MEMORAX_CODE_BACKEND_LOOPBACK_AUTH: "1",
  MEMORAX_CODE_OPENCODE_PLUGIN_DEBUG: "1",
  MEMORAX_CODE_SKIP_CODEX_PLUGIN_INSTALL: "1",
  MEMORAX_CODE_SKIP_CLAUDE_ADAPTER_INSTALL: "1",
};

try {
  await Promise.all([
    mkdir(workspace, { recursive: true }),
    mkdir(openCodeConfigDir, { recursive: true }),
  ]);
  await writeFile(join(workspace, "README.md"), "# OpenCode E2E\n");
  await writeFile(userConfigPath, "{ // user-owned config\n}\n");
  await run("git", ["init", "--quiet"], { cwd: workspace, env });
  await run("git", ["add", "README.md"], { cwd: workspace, env });
  await run("git", [
    "-c", "user.name=MemoraX Code E2E",
    "-c", "user.email=e2e@memorax.invalid",
    "commit", "--quiet", "-m", "test fixture",
  ], { cwd: workspace, env });

  memoryStub = await startMemoryStub();
  modelStub = await startModelStub(REPLY);
  env.MEMORAX_CODE_MEMORAX_ENDPOINT = memoryStub.url;

  await run("npm", ["run", "build", "--prefix", "packages/ts/memorax-code-backend"], {
    cwd: repoRoot,
    env,
  });
  await run(process.execPath, [
    "scripts/build-npm-packages.mjs",
    "--out-dir", stagingRoot,
  ], { cwd: repoRoot, env });
  const tarballDir = join(root, "tarballs");
  await mkdir(tarballDir, { recursive: true });
  const { stdout: packJson } = await run("npm", [
    "pack", join(stagingRoot, "memorax-code"),
    "--pack-destination", tarballDir,
    "--json",
  ], { cwd: repoRoot, env });
  const tarball = join(tarballDir, JSON.parse(packJson)[0].filename);
  await run("npm", [
    "install", "--prefix", prefix,
    tarball,
    `opencode-ai@${OPENCODE_VERSION}`,
    `@opencode-ai/sdk@${OPENCODE_VERSION}`,
    "--foreground-scripts",
    "--silent",
  ], { cwd: workspace, env });

  const binDir = join(prefix, "node_modules", ".bin");
  env.PATH = `${binDir}${delimiter}${env.PATH ?? ""}`;
  const memoraxCode = join(binDir, process.platform === "win32" ? "memorax-code.cmd" : "memorax-code");
  const memoraxOpenCode = join(binDir, process.platform === "win32" ? "memorax-code-opencode.cmd" : "memorax-code-opencode");
  const opencode = join(binDir, process.platform === "win32" ? "opencode.cmd" : "opencode");

  const startReport = await runJson(memoraxCode, [
    "start", "--json",
    "--home", memoraxCodeHome,
    "--opencode-config-dir", openCodeConfigDir,
    "--clients", "opencode",
    "--port", String(backendPort),
  ], { cwd: workspace, env });
  assert.equal(startReport.ok, true);
  assert.equal(startReport.opencodeAdapter?.enabled, true);
  backendStarted = true;
  await assertManagedArtifacts(openCodeConfigDir);

  const config = {
    formatter: false,
    lsp: false,
    share: "disabled",
    autoupdate: false,
    model: "test/test-model",
    small_model: "test/test-model",
    enabled_providers: ["test"],
    provider: {
      test: {
        name: "MemoraX Code E2E",
        id: "test",
        env: [],
        npm: "@ai-sdk/openai-compatible",
        models: {
          "test-model": {
            id: "test-model",
            name: "Test Model",
            attachment: false,
            reasoning: false,
            temperature: false,
            tool_call: false,
            release_date: "2026-01-01",
            limit: { context: 100_000, output: 10_000 },
            cost: { input: 0, output: 0 },
          },
        },
        options: { apiKey: "local-e2e", baseURL: modelStub.url },
      },
    },
  };
  openCode = await startOpenCode(opencode, workspace, env, config);
  const sdkModule = pathToFileURL(join(
    prefix,
    "node_modules", "@opencode-ai", "sdk", "dist", "client.js",
  )).href;
  const backendConnectionModule = pathToFileURL(join(
    prefix,
    "node_modules", "@memorax", "memorax-code", "lib",
    "memorax-code-adapter-common", "src", "backend-connection.mjs",
  )).href;
  const { createOpencodeClient } = await import(sdkModule);
  const { resolveBackendConnection } = await import(backendConnectionModule);
  const client = createOpencodeClient({ baseUrl: openCode.url, directory: workspace });
  const sessionResponse = await client.session.create({ body: { title: "MemoraX Code E2E" } });
  const sessionId = sessionResponse.data?.id;
  assert.equal(typeof sessionId, "string");
  assert.ok(sessionId);

  const promptResponse = await client.session.prompt({
    path: { id: sessionId },
    body: {
      model: { providerID: "test", modelID: "test-model" },
      parts: [{ type: "text", text: PROMPT }],
    },
  });
  assert.equal(promptResponse.data?.info?.role, "assistant");
  assert.match(messageText(promptResponse.data), /OpenCode E2E completed/);
  await waitFor(() => memoryStub.requests.some((request) => request.path === "/v1/memories/add"));

  assert.deepEqual(
    memoryStub.requests.filter((request) => request.path === "/v1/memories/search").map((request) => request.body.query),
    [PROMPT],
  );
  const add = memoryStub.requests.find((request) => request.path === "/v1/memories/add");
  assert.deepEqual(add.body.messages.map(({ role, content }) => ({ role, content })), [
    { role: "user", content: PROMPT },
    { role: "assistant", content: REPLY },
  ]);
  assert.match(JSON.stringify(modelStub.requests[0].body), /E2E recalled memory/);

  const doctor = await runJson(memoraxOpenCode, [
    "doctor", "--json",
    "--memorax-code-home", memoraxCodeHome,
    "--opencode-config-dir", openCodeConfigDir,
  ], { cwd: workspace, env });
  assert.equal(doctor.ok, true);
  assert.equal(doctor.workspace?.captured, true);
  assert.equal(doctor.workspace?.latest?.cwd, await realpath(workspace));

  const connection = resolveBackendConnection({
    memoraxCodeHome,
    env: { MEMORAX_CODE_HOME: memoraxCodeHome },
  });
  assert.equal(connection.source, "authority");
  assert.equal(connection.tokenSource, "authority-file");
  const viewerResponse = await fetch(
    `${connection.url}/memory-viewer/api/summary?client=opencode`,
    { headers: { "x-memorax-code-backend-token": connection.token } },
  );
  assert.equal(viewerResponse.status, 200);
  const viewer = await viewerResponse.json();
  assert.equal(viewer.ok, true);
  assert.equal(viewer.selectedClient, "opencode");
  assert.deepEqual({
    turnCount: viewer.summary.turnCount,
    searchOperationCount: viewer.summary.searchOperationCount,
    searchedMemoryCount: viewer.summary.searchedMemoryCount,
    addOperationCount: viewer.summary.addOperationCount,
  }, {
    turnCount: 1,
    searchOperationCount: 1,
    searchedMemoryCount: 1,
    addOperationCount: 1,
  });
  const viewerJson = JSON.stringify(viewer);
  for (const privateValue of [PROMPT, REPLY, "E2E recalled memory", sessionId]) {
    assert.equal(viewerJson.includes(privateValue), false);
  }
  for (const field of ["prompt", "answer", "query", "results", "details", "sessionId", "turnId"]) {
    assert.equal(viewerJson.includes(`"${field}"`), false);
  }

  const traceEvents = (await readFile(join(
    memoraxCodeHome,
    "debug", "traces", "opencode", "sessions", sessionId, "events.jsonl",
  ), "utf8")).trim().split(/\r?\n/).map(JSON.parse);
  const traceTypes = new Set(traceEvents.map((event) => event.type));
  for (const type of ["turn_start", "turn_end", "memory_retrieve", "memory_writeback"]) {
    assert.equal(traceTypes.has(type), true);
  }

  await openCode.close();
  openCode = undefined;
  const uninstall = await runJson(memoraxCode, [
    "uninstall", "--json",
    "--home", memoraxCodeHome,
    "--opencode-config-dir", openCodeConfigDir,
    "--clients", "opencode",
    "--no-npm-uninstall",
    "--port", String(backendPort),
  ], { cwd: workspace, env });
  assert.equal(uninstall.ok, true);
  backendStarted = false;
  await assertMissing(join(openCodeConfigDir, "plugins", "memorax-code.js"));
  await assertMissing(join(openCodeConfigDir, "skills", "memorax-code", "SKILL.md"));
  await assertMissing(join(openCodeConfigDir, "hooks", "repo-memory-job.mjs"));
  assert.match(await readFile(userConfigPath, "utf8"), /user-owned config/);

  console.log(JSON.stringify({
    ok: true,
    openCodeVersion: OPENCODE_VERSION,
    searchRequests: memoryStub.requests.filter((request) => request.path === "/v1/memories/search").length,
    addRequests: memoryStub.requests.filter((request) => request.path === "/v1/memories/add").length,
    viewerActivities: viewer.activities.length,
  }, null, 2));
} finally {
  await openCode?.close().catch(() => undefined);
  if (backendStarted) {
    const memoraxCode = join(
      prefix,
      "node_modules", ".bin",
      process.platform === "win32" ? "memorax-code.cmd" : "memorax-code",
    );
    await run(memoraxCode, [
      "stop", "--json",
      "--home", memoraxCodeHome,
      "--clients", "none",
      "--port", String(backendPort),
    ], { cwd: workspace, env }).catch(() => undefined);
  }
  await memoryStub?.close().catch(() => undefined);
  await modelStub?.close().catch(() => undefined);
  await rm(stagingRoot, { recursive: true, force: true });
  if (process.env.MEMORAX_CODE_KEEP_E2E_ARTIFACTS === "1") {
    console.error(`OpenCode E2E artifacts kept at ${root}`);
  } else {
    await rm(root, { recursive: true, force: true });
  }
}

async function startMemoryStub() {
  const requests = [];
  const server = createServer(async (request, response) => {
    const body = await requestJson(request);
    requests.push({ method: request.method, path: request.url, body });
    if (request.method === "POST" && request.url === "/v1/memories/search") {
      return json(response, 200, {
        success: true,
        data: {
          task_id: "opencode-e2e-search",
          status: "completed",
          data: [{
            id: "opencode-e2e-memory",
            memory: "E2E recalled memory from the local stub.",
            score: 0.99,
            metadata: { memory_type: "procedural" },
          }],
        },
      });
    }
    if (request.method === "POST" && request.url === "/v1/memories/add") {
      return json(response, 202, {
        success: true,
        data: { task_id: "opencode-e2e-add", status: "accepted" },
      });
    }
    return json(response, 404, { message: "not found" });
  });
  return await listen(server, requests);
}

async function startModelStub(reply) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const body = await requestJson(request);
    requests.push({ method: request.method, path: request.url, body });
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      return json(response, 404, { message: "not found" });
    }
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "close",
    });
    for (const payload of [
      { id: "chatcmpl-e2e", object: "chat.completion.chunk", choices: [{ delta: { role: "assistant" } }] },
      { id: "chatcmpl-e2e", object: "chat.completion.chunk", choices: [{ delta: { content: reply } }] },
      {
        id: "chatcmpl-e2e",
        object: "chat.completion.chunk",
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
    ]) {
      response.write(`data: ${JSON.stringify(payload)}\n\n`);
    }
    response.end("data: [DONE]\n\n");
  });
  return await listen(server, requests, "/v1");
}

async function startOpenCode(command, cwd, childEnv, config) {
  const port = await freePort();
  const child = spawn(command, [
    "serve", "--hostname=127.0.0.1", `--port=${port}`, "--print-logs",
  ], {
    cwd,
    env: { ...childEnv, OPENCODE_CONFIG_CONTENT: JSON.stringify(config) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const url = `http://127.0.0.1:${port}`;
  await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(`OpenCode exited early:\n${output}`);
    return await fetch(`${url}/global/health`).then((response) => response.ok).catch(() => false);
  }, 20_000);
  return {
    url,
    async close() {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      await Promise.race([
        new Promise((resolveExit) => child.once("exit", resolveExit)),
        new Promise((_, reject) => setTimeout(() => reject(new Error("OpenCode did not stop")), 5_000)),
      ]);
    },
  };
}

async function listen(server, requests, suffix = "") {
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}${suffix}`,
    requests,
    close: () => new Promise((resolveClose, reject) => {
      server.close((error) => error ? reject(error) : resolveClose());
    }),
  };
}

function requestJson(request) {
  return new Promise((resolveBody, reject) => {
    let text = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { text += chunk; });
    request.on("end", () => {
      try {
        resolveBody(text ? JSON.parse(text) : {});
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function run(command, args, options) {
  try {
    return await execFileAsync(command, args, {
      ...options,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    const detail = [error.stdout, error.stderr].filter(Boolean).join("\n");
    throw new Error(`${command} ${args.join(" ")} failed${detail ? `:\n${detail}` : ""}`);
  }
}

async function runJson(command, args, options) {
  const { stdout } = await run(command, args, options);
  return JSON.parse(stdout);
}

async function waitFor(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) throw new Error("timed out waiting for E2E condition");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
}

async function freePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const { port } = server.address();
  await new Promise((resolveClose, reject) => {
    server.close((error) => error ? reject(error) : resolveClose());
  });
  return port;
}

function messageText(message) {
  return (message?.parts ?? [])
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

async function assertManagedArtifacts(configDir) {
  await Promise.all([
    access(join(configDir, "plugins", "memorax-code.js")),
    access(join(configDir, "skills", "memorax-code", "SKILL.md")),
    access(join(configDir, "hooks", "repo-memory-job.mjs")),
  ]);
}

async function assertMissing(path) {
  await assert.rejects(access(path));
}
