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
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { resolveNpmInvocation } from "../packages/npm/memorax-code/lib/npm-invocation.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENABLE_ENV = "MEMORAX_CODE_KIMI_E2E";
const TARBALL_ENV = "MEMORAX_CODE_KIMI_E2E_MEMORAX_TARBALL";
const KIMI_COMMAND_ENV = "MEMORAX_CODE_KIMI_COMMAND";
const PROMPT = "/memorax-code Build lightweight Repo Memory for this repository. MEMORAX_KIMI_E2E_PROMPT_7C4A";
const REPLY = "MEMORAX_KIMI_E2E_REPLY_91D2";
const MEMORY = "MEMORAX_KIMI_E2E_RECALLED_MEMORY_38F1";
const CLI_QUERY = "MEMORAX_KIMI_E2E_CLI_SEARCH_5E20";
const CLI_MEMORY = "MEMORAX_KIMI_E2E_CLI_MEMORY_6A31";

const usage = [
  "Usage:",
  `  ${ENABLE_ENV}=1 node scripts/kimi-npm-package-e2e.mjs`,
  "",
  "Optional:",
  `  ${TARBALL_ENV}=/absolute/path/to/memorax-code.tgz`,
  `  ${KIMI_COMMAND_ENV}=kimi`,
  "",
  "Runs an isolated E2E against the installed Kimi Code CLI.",
  "Kimi and Backend are real; the model and MemoraX HTTP endpoints are mocked.",
].join("\n");

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  process.stdout.write(`${usage}\n`);
  process.exit(0);
}
if (process.argv.length > 2) {
  console.error(`Unknown argument: ${process.argv[2]}\n\n${usage}`);
  process.exit(2);
}
if (process.env[ENABLE_ENV] !== "1") {
  console.error(`${ENABLE_ENV}=1 is required; this E2E never runs by default\n\n${usage}`);
  process.exit(2);
}

let root;
let stagingRoot;
let gitIndexRoot;
let memoryStub;
let modelStub;
let memoraxCode;
let memoraxCli;
let runtimeEnv;

main().catch((error) => {
  console.error(`kimi_npm_package_e2e_failed: ${error?.stack || error}`);
  process.exitCode = 1;
}).finally(cleanup);

async function main() {
  root = await mkdtemp(join(tmpdir(), "memorax-code-kimi-e2e-"));
  const paths = {
    home: join(root, "home"),
    memoraxHome: join(root, "memorax-code-home"),
    kimiHome: join(root, "kimi-home"),
    prefix: join(root, "npm-prefix"),
    npmCache: join(root, "npm-cache"),
    workspace: join(root, "workspace"),
    tarballs: join(root, "tarballs"),
  };
  await Promise.all(Object.values(paths).map((path) => mkdir(path, { recursive: true })));
  for (const [name, path] of Object.entries(paths)) paths[name] = await realpath(path);

  await writeFile(join(paths.workspace, "README.md"), "# isolated Kimi E2E\n");
  await run("git", ["init", "--quiet"], { cwd: paths.workspace, env: cleanEnvironment() });
  await run("git", ["add", "README.md"], { cwd: paths.workspace, env: cleanEnvironment() });
  await run("git", [
    "-c", "user.name=MemoraX Code E2E",
    "-c", "user.email=e2e@memorax.invalid",
    "commit", "--quiet", "-m", "fixture",
  ], { cwd: paths.workspace, env: cleanEnvironment() });

  const repoMemoryHead = (await run("git", ["rev-parse", "HEAD"], {
    cwd: paths.workspace,
    env: cleanEnvironment(),
  })).stdout.trim();
  memoryStub = await startMemoryStub();
  modelStub = await startModelStub({ workspace: paths.workspace, repoMemoryHead });
  const kimiCommand = process.env[KIMI_COMMAND_ENV] || "kimi";
  const baseEnv = cleanEnvironment();
  runtimeEnv = {
    ...baseEnv,
    HOME: paths.home,
    MEMORAX_CODE_HOME: paths.memoraxHome,
    KIMI_CODE_HOME: paths.kimiHome,
    NPM_CONFIG_CACHE: paths.npmCache,
    NPM_CONFIG_FUND: "false",
    NPM_CONFIG_AUDIT: "false",
    MEMORAX_CODE_MEMORY_RETRIEVAL_ENABLED: "true",
    MEMORAX_CODE_MEMORY_WRITEBACK_ENABLED: "true",
    MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_ENABLED: "false",
    MEMORAX_CODE_MEMORAX_ENDPOINT: memoryStub.url,
    MEMORAX_CODE_MEMORAX_API_KEY: "kimi-e2e-memorax-key",
    MEMORAX_CODE_MEMORAX_USER_ID: "kimi-e2e-user",
    MEMORAX_CODE_BACKEND_TOKEN: "kimi-e2e-backend-token",
    MEMORAX_CODE_BACKEND_LOOPBACK_AUTH: "1",
    MEMORAX_CODE_SKIP_CODEX_PLUGIN_INSTALL: "1",
    MEMORAX_CODE_SKIP_CLAUDE_ADAPTER_INSTALL: "1",
    MEMORAX_CODE_SKIP_DSH_ADAPTER_INSTALL: "1",
    MEMORAX_CODE_SKIP_OPENCODE_ADAPTER_INSTALL: "1",
    PATH: `${join(paths.prefix, "bin")}${delimiter}${baseEnv.PATH || ""}`,
  };

  await writeFile(join(paths.kimiHome, "config.toml"), kimiConfig(modelStub.url));
  await run(kimiCommand, ["--version"], { cwd: paths.workspace, env: runtimeEnv });

  const tarball = await resolveTarball(paths, runtimeEnv);
  await runNpm([
    "install", "--prefix", paths.prefix,
    tarball,
    "--foreground-scripts", "--silent",
  ], { cwd: paths.workspace, env: runtimeEnv, timeout: 300_000 });

  const binDir = join(paths.prefix, "node_modules", ".bin");
  runtimeEnv.PATH = `${binDir}${delimiter}${runtimeEnv.PATH}`;
  const installedRoot = join(paths.prefix, "node_modules", "@memorax", "memorax-code");
  memoraxCode = installedCommand(binDir, installedRoot, "memorax-code");
  memoraxCli = installedCommand(binDir, installedRoot, "memorax-cli");
  const backendPort = await freePort();
  const lifecycleArgs = [
    "--home", paths.memoraxHome,
    "--port", String(backendPort),
    "--kimi-home", paths.kimiHome,
    "--kimi-command", kimiCommand,
    "--clients", "kimi",
  ];

  const started = await runJson(memoraxCode.command, [
    ...memoraxCode.args, "start", "--json", ...lifecycleArgs,
  ], { cwd: paths.workspace, env: runtimeEnv });
  assert.equal(started.ok, true);
  assert.equal(started.kimiAdapter?.enabled, true);
  assert.equal((await readFile(join(paths.kimiHome, "config.toml"), "utf8"))
    .match(/# MemoraX Code Kimi Adapter/g)?.length, 6);

  // Exercise the real lifecycle recovery path: a crashed Backend must not
  // strand the managed Kimi integration or duplicate its Hook blocks.
  const firstBackendState = started.backend?.state;
  assert.ok(firstBackendState?.pid, "start did not report the Backend PID");
  assert.ok(firstBackendState?.instanceId, "start did not report the Backend instance");
  process.kill(firstBackendState.pid, "SIGKILL");
  await waitFor(() => !isProcessAlive(firstBackendState.pid), 10_000);

  const recovered = await runJson(memoraxCode.command, [
    ...memoraxCode.args, "start", "--json", ...lifecycleArgs,
  ], { cwd: paths.workspace, env: runtimeEnv });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.kimiAdapter?.enabled, true);
  assert.equal(recovered.backend?.alreadyRunning, undefined);
  assert.notEqual(recovered.backend?.state?.instanceId, firstBackendState.instanceId);
  assert.equal((await readFile(join(paths.kimiHome, "config.toml"), "utf8"))
    .match(/# MemoraX Code Kimi Adapter/g)?.length, 6);

  const cliSearch = await runJson(memoraxCli.command, [
    ...memoraxCli.args, "search", "--query", CLI_QUERY, "--json",
  ], { cwd: paths.workspace, env: runtimeEnv });
  assert.equal(cliSearch.ok, true);
  assert.equal(cliSearch.query, CLI_QUERY);
  assert.match(JSON.stringify(cliSearch), new RegExp(MEMORY));

  const cliAdd = await runJson(memoraxCli.command, [
    ...memoraxCli.args,
    "add",
    "--memory", CLI_MEMORY,
    "--type", "procedural",
    "--reason", "Verify the installed Kimi memory command path.",
    "--content-type", "code",
    "--json",
  ], { cwd: paths.workspace, env: runtimeEnv });
  assert.equal(cliAdd.ok, true);
  assert.equal(cliAdd.action, "memory.add");

  const { stdout, stderr } = await run(kimiCommand, [
    "-m", "test/test-model",
    "-p", PROMPT,
    "--output-format", "stream-json",
  ], {
    cwd: paths.workspace,
    env: { ...runtimeEnv, PWD: paths.workspace },
    timeout: 60_000,
  });
  assert.match(`${stdout}\n${stderr}`, new RegExp(REPLY));
  await waitFor(() => memoryStub.requests.some((request) => request.path === "/v1/memories/search"), 30_000);

  const sessionIndex = await readFile(join(paths.kimiHome, "session_index.jsonl"), "utf8");
  const session = sessionIndex.split(/\r?\n/).filter(Boolean).map(JSON.parse).at(-1);
  assert.ok(session?.sessionId && session?.sessionDir, "Kimi did not persist a session index entry");
  const hookScript = join(
    paths.memoraxHome,
    "adapters", "kimi", "runtime", "memorax-code-kimi-adapter", "src", "hook-runtime.mjs",
  );
  await runWithInput(process.execPath, [hookScript], JSON.stringify({
    hook_event_name: "SessionHeartbeat",
    session_id: session.sessionId,
    cwd: paths.workspace,
  }), { cwd: paths.workspace, env: runtimeEnv });
  try {
    await waitFor(() => memoryStub.requests.some((request) => request.path === "/v1/memories/add"), 30_000);
  } catch (error) {
    throw new Error(`${error.message}; memory requests: ${JSON.stringify(memoryStub.requests)}`);
  }

  const search = memoryStub.requests.filter((request) => request.path === "/v1/memories/search");
  assert.equal(search.length, 2);
  assert.ok(search.some((request) => request.body.query === CLI_QUERY));
  assert.ok(search.some((request) => request.body.query === PROMPT));
  const adds = memoryStub.requests.filter((request) => request.path === "/v1/memories/add");
  assert.equal(adds.length, 2);
  const add = adds.find((request) => request.body.messages?.some(({ role }) => role === "assistant"));
  assert.ok(add, "automatic Kimi writeback did not include the assistant reply");
  assert.deepEqual(add.body.messages.map(({ role, content }) => ({ role, content })), [
    { role: "user", content: PROMPT },
    { role: "assistant", content: REPLY },
  ]);
  const cliAddRequest = adds.find((request) => request.body.messages?.some(({ content }) => content === CLI_MEMORY));
  assert.ok(cliAddRequest, "installed memorax-cli add did not reach MemoraX");
  const modelRequest = modelStub.requests.find((request) => JSON.stringify(request.body).includes(PROMPT));
  assert.ok(modelRequest, "Kimi did not send the prompt to the model stub");
  assert.match(JSON.stringify(modelRequest.body), new RegExp(MEMORY));
  const modelRequestText = JSON.stringify(modelRequest.body);
  assert.ok(
    modelRequestText.includes("single router for persistent coding and repository-local memory"),
    JSON.stringify([...modelRequestText.matchAll(/.{0,80}memorax-code.{0,160}/gi)].slice(0, 8).map(([match]) => match)),
  );

  const validatorPath = join(
    paths.kimiHome,
    "skills", "memorax-code", "scripts", "validate_memory.py",
  );
  const repoMemoryValidation = JSON.parse((await run("python3", [validatorPath, paths.workspace, "--pretty"], {
    cwd: paths.workspace,
    env: runtimeEnv,
  })).stdout);
  assert.equal(repoMemoryValidation.ok, true);

  const wirePath = join(session.sessionDir, "agents", "main", "wire.jsonl");
  const wire = await readFile(wirePath, "utf8");
  assert.match(wire, new RegExp(PROMPT));
  assert.match(wire, new RegExp(REPLY));

  const stopped = await runJson(memoraxCode.command, [
    ...memoraxCode.args, "stop", "--json", ...lifecycleArgs,
  ], { cwd: paths.workspace, env: runtimeEnv });
  assert.equal(stopped.ok, true);
  const uninstalled = await runJson(memoraxCode.command, [
    ...memoraxCode.args, "uninstall", "--json", ...lifecycleArgs, "--no-npm-uninstall",
  ], { cwd: paths.workspace, env: runtimeEnv });
  assert.equal(uninstalled.ok, true);
  const finalConfig = await readFile(join(paths.kimiHome, "config.toml"), "utf8");
  assert.doesNotMatch(finalConfig, /MemoraX Code Kimi Adapter/);
  assert.match(finalConfig, /default_model = "test\/test-model"/);
  await assertMissing(join(paths.kimiHome, "skills", "memorax-code", "SKILL.md"));

  console.log(JSON.stringify({
    ok: true,
    searchRequests: search.length,
    addRequests: adds.length,
    repoMemoryValidated: repoMemoryValidation.ok,
    sessionId: session.sessionId,
  }, null, 2));
}

async function resolveTarball(paths, env) {
  if (process.env[TARBALL_ENV]) return await realpath(process.env[TARBALL_ENV]);
  stagingRoot = join(repoRoot, "dist", `kimi-e2e-${process.pid}`);
  gitIndexRoot = await mkdtemp(join(tmpdir(), "memorax-code-kimi-index-"));
  const buildEnv = { ...env, GIT_INDEX_FILE: join(gitIndexRoot, "index") };
  await run("git", ["read-tree", "HEAD"], { cwd: repoRoot, env: buildEnv });
  await run("git", ["add", "packages/ts/memorax-code-kimi-adapter", "packages/ts/memorax-code-backend/src/clients/kimi"], {
    cwd: repoRoot,
    env: buildEnv,
  });
  await runNpm(["run", "build", "--prefix", "packages/ts/memorax-code-backend"], {
    cwd: repoRoot,
    env: buildEnv,
  });
  await run(process.execPath, [
    "scripts/build-npm-packages.mjs",
    "--out-dir", stagingRoot,
  ], { cwd: repoRoot, env: buildEnv });
  const { stdout } = await runNpm([
    "pack", join(stagingRoot, "memorax-code"),
    "--pack-destination", paths.tarballs,
    "--json",
  ], { cwd: repoRoot, env: buildEnv });
  return join(paths.tarballs, JSON.parse(stdout)[0].filename);
}

function kimiConfig(modelBaseUrl) {
  return [
    'default_model = "test/test-model"',
    "",
    "[providers.test]",
    'type = "openai"',
    `base_url = "${modelBaseUrl}/v1"`,
    'api_key = "kimi-e2e-model-key"',
    "",
    '[models."test/test-model"]',
    'provider = "test"',
    'model = "test-model"',
    "max_context_size = 100000",
    "max_output_size = 1000",
    "capabilities = [\"tool_use\"]",
    "",
    "# User-owned provider configuration must survive lifecycle cleanup.",
  ].join("\n");
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
          task_id: "kimi-e2e-search",
          status: "completed",
          data: [{
            id: "kimi-e2e-memory",
            memory: MEMORY,
            score: 0.99,
            metadata: { memory_type: "procedural" },
          }],
        },
      });
    }
    if (request.method === "POST" && request.url === "/v1/memories/add") {
      return json(response, 202, {
        success: true,
        data: { task_id: "kimi-e2e-add", status: "accepted" },
      });
    }
    return json(response, 404, { message: "not found" });
  });
  return await listen(server, requests);
}

async function startModelStub(options) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const body = await requestJson(request);
    requests.push({ method: request.method, path: request.url, body });
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      return json(response, 404, { message: "not found" });
    }
    if (JSON.stringify(body).includes(PROMPT)) {
      await writeValidRepoMemoryFixture(options.workspace, options.repoMemoryHead);
    }
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "close",
    });
    for (const payload of [
      {
        id: "kimi-e2e-chat",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
      },
      {
        id: "kimi-e2e-chat",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { content: REPLY }, finish_reason: null }],
      },
      {
        id: "kimi-e2e-chat",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
    ]) response.write(`data: ${JSON.stringify(payload)}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  return await listen(server, requests, "");
}

async function writeValidRepoMemoryFixture(workspace, head) {
  const memory = join(workspace, ".repo_memory");
  await Promise.all([
    mkdir(join(memory, "raw"), { recursive: true }),
    mkdir(join(memory, "resources"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(memory, "PROFILE.md"), [
      "---",
      'schema: "repo_memory_profile.v0.1"',
      `local_head: "${head}"`,
      "---",
      "",
      "# Isolated Kimi E2E Repo Memory",
      "",
    ].join("\n")),
    writeFile(join(memory, "resources", "commits.md"), emptyRepoMemoryResource(
      "repo_memory_commit_resource.v0.1", "git_commit_facets", "draft_resource",
      "../raw/git-commits.json",
    )),
    writeFile(join(memory, "resources", "prs.md"), emptyRepoMemoryResource(
      "repo_memory_pr_resource.v0.1", "provider_skipped_local_only",
      "unavailable_local_only", "",
    )),
    writeFile(join(memory, "resources", "issues.md"), emptyRepoMemoryResource(
      "repo_memory_issue_resource.v0.1", "provider_skipped_local_only",
      "unavailable_local_only", "",
    )),
    writeFile(join(memory, "raw", "git-commits.json"), "[]\n"),
    writeFile(join(workspace, ".gitignore"), ".repo_memory/\n"),
  ]);
}

function emptyRepoMemoryResource(schema, source, trustState, rawSource) {
  return [
    "---",
    `schema: "${schema}"`,
    `source: "${source}"`,
    "resource_count: 0",
    `trust_state: "${trustState}"`,
    `raw_source: "${rawSource}"`,
    "---",
    "",
    `# ${schema}`,
    "",
  ].join("\n");
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

function installedCommand(binDir, packageRoot, name) {
  if (process.platform !== "win32") return { command: join(binDir, name), args: [] };
  return { command: process.execPath, args: [join(packageRoot, "bin", `${name}.mjs`)] };
}

function runNpm(args, options) {
  const invocation = resolveNpmInvocation(args, { env: options.env, nodePath: process.execPath });
  return run(invocation.command, invocation.args, options);
}

async function run(command, args, options) {
  try {
    const result = await execFileAsync(command, args, {
      ...options,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    return result;
  } catch (error) {
    const detail = [error.message, error.stdout, error.stderr].filter(Boolean).join("\n");
    throw new Error(`${command} ${args.join(" ")} failed${detail ? `:\n${detail}` : ""}`);
  }
}

async function runWithInput(command, args, input, options) {
  return await new Promise((resolveResult, rejectResult) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", rejectResult);
    child.once("close", (code, signal) => {
      if (code === 0) return resolveResult({ stdout, stderr });
      rejectResult(new Error(`${command} ${args.join(" ")} failed (code=${code}, signal=${signal})${stderr ? `:\n${stderr}` : ""}`));
    });
    child.stdin.end(input);
  });
}

async function runJson(command, args, options) {
  const { stdout } = await run(command, args, options);
  return JSON.parse(stdout);
}

function cleanEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => (
    !key.startsWith("MEMORAX_CODE_")
    && !key.startsWith("KIMI_")
    && !key.startsWith("XDG_")
    && key !== "GIT_INDEX_FILE"
  )));
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await predicate();
    if (result) return result;
    if (Date.now() >= deadline) throw new Error("timed out waiting for Kimi E2E condition");
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

async function assertMissing(path) {
  await assert.rejects(access(path));
}

async function cleanup() {
  if (memoraxCode && runtimeEnv) {
    await run(memoraxCode.command, [
      ...memoraxCode.args,
      "stop", "--json",
      "--home", runtimeEnv.MEMORAX_CODE_HOME,
      "--clients", "none",
    ], { cwd: runtimeEnv.HOME, env: runtimeEnv }).catch(() => undefined);
  }
  await memoryStub?.close().catch(() => undefined);
  await modelStub?.close().catch(() => undefined);
  await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
  await rm(gitIndexRoot, { recursive: true, force: true }).catch(() => undefined);
  if (process.env.MEMORAX_CODE_KEEP_E2E_ARTIFACTS === "1") {
    console.error(`Kimi E2E artifacts kept at ${root}`);
  } else {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}
