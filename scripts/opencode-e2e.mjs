#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { resolveNpmInvocation } from "../packages/npm/memorax-code/lib/npm-invocation.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OPENCODE_VERSION = "1.18.18";
const PROMPT = "Reply with exactly: OpenCode E2E completed.";
const REPLY = "OpenCode E2E completed.";
const SECOND_PROMPT = "Reply with exactly: OpenCode E2E second turn completed.";
const SECOND_REPLY = "OpenCode E2E second turn completed.";

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
let memoraxCode;

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
  const repoMemoryHead = (await run("git", ["rev-parse", "HEAD"], {
    cwd: workspace,
    env,
  })).stdout.trim();

  memoryStub = await startMemoryStub();
  modelStub = await startModelStub({
    reply: REPLY,
    repoMemoryHead,
    workspace,
  });
  env.MEMORAX_CODE_MEMORAX_ENDPOINT = memoryStub.url;

  await runNpm(["run", "build", "--prefix", "packages/ts/memorax-code-backend"], {
    cwd: repoRoot,
    env,
  });
  await run(process.execPath, [
    "scripts/build-npm-packages.mjs",
    "--out-dir", stagingRoot,
  ], { cwd: repoRoot, env });
  const tarballDir = join(root, "tarballs");
  await mkdir(tarballDir, { recursive: true });
  const { stdout: packJson } = await runNpm([
    "pack", join(stagingRoot, "memorax-code"),
    "--pack-destination", tarballDir,
    "--json",
  ], { cwd: repoRoot, env });
  const tarball = join(tarballDir, JSON.parse(packJson)[0].filename);
  await runNpm([
    "install", "--prefix", prefix,
    tarball,
    `opencode-ai@${OPENCODE_VERSION}`,
    "--foreground-scripts",
    "--silent",
  ], { cwd: workspace, env });

  const binDir = join(prefix, "node_modules", ".bin");
  env.PATH = `${binDir}${delimiter}${env.PATH ?? ""}`;
  const installedPackageRoot = join(prefix, "node_modules", "@memorax", "memorax-code");
  memoraxCode = installedMemoraxCli(binDir, installedPackageRoot, "memorax-code");
  const memoraxOpenCode = installedMemoraxCli(binDir, installedPackageRoot, "memorax-code-opencode");
  const opencode = process.platform === "win32"
    ? join(prefix, "node_modules", "opencode-ai", "bin", "opencode.exe")
    : join(binDir, "opencode");

  const startReport = await runJson(memoraxCode.command, [
    ...memoraxCode.args,
    "start", "--json",
    "--home", memoraxCodeHome,
    "--opencode-config-dir", openCodeConfigDir,
    "--clients", "opencode",
    "--port", String(backendPort),
  ], { cwd: workspace, env });
  assert.equal(startReport.ok, true);
  assert.equal(startReport.opencodeAdapter?.enabled, true);
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
  const { stdout: openCodeOutput, stderr: openCodeError } = await run(opencode, [
    "run",
    "--format=json",
    "--model=test/test-model",
    "--print-logs",
    ...PROMPT.split(" "),
  ], {
    cwd: workspace,
    closeStdin: true,
    env: {
      ...env,
      PWD: workspace,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    },
    timeout: 60_000,
  });
  const runEvents = parseJsonLines(openCodeOutput);
  const sessionId = runEvents.find((event) => typeof event?.sessionID === "string")?.sessionID;
  assert.equal(typeof sessionId, "string");
  assert.ok(sessionId);
  assert.match(openCodeRunText(runEvents), /OpenCode E2E completed/);
  assert.doesNotMatch(openCodeError, /opencode quota reminder failed/);
  await waitFor(() => memoryStub.requests.some((request) => request.path === "/v1/memories/add"));

  const { stdout: secondOpenCodeOutput, stderr: secondOpenCodeError } = await run(opencode, [
    "run",
    `--session=${sessionId}`,
    "--format=json",
    "--model=test/test-model",
    "--print-logs",
    ...SECOND_PROMPT.split(" "),
  ], {
    cwd: workspace,
    closeStdin: true,
    env: {
      ...env,
      PWD: workspace,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    },
    timeout: 60_000,
  });
  const secondRunEvents = parseJsonLines(secondOpenCodeOutput);
  assert.match(openCodeRunText(secondRunEvents), /OpenCode E2E second turn completed/);
  assert.doesNotMatch(secondOpenCodeError, /opencode quota reminder failed/);
  await waitFor(() => (
    memoryStub.requests.filter((request) => request.path === "/v1/memories/add").length === 2
  ));

  const backendConnectionModule = pathToFileURL(join(
    prefix,
    "node_modules", "@memorax", "memorax-code", "lib",
    "memorax-code-adapter-common", "src", "backend-connection.mjs",
  )).href;
  const { resolveBackendConnection } = await import(backendConnectionModule);

  assert.deepEqual(
    memoryStub.requests.filter((request) => request.path === "/v1/memories/search").map((request) => request.body.query),
    [PROMPT, SECOND_PROMPT],
  );
  const adds = memoryStub.requests.filter((request) => request.path === "/v1/memories/add");
  assert.deepEqual(adds.map((request) => (
    request.body.messages.map(({ role, content }) => ({ role, content }))
  )), [
    [
      { role: "user", content: PROMPT },
      { role: "assistant", content: REPLY },
    ],
    [
      { role: "user", content: SECOND_PROMPT },
      { role: "assistant", content: SECOND_REPLY },
    ],
  ]);
  const promptModelRequest = modelStub.requests.find((request) => (
    JSON.stringify(request.body).includes(PROMPT)
  ));
  assert.ok(promptModelRequest, "OpenCode did not send the user prompt to the model");
  assert.match(JSON.stringify(promptModelRequest.body), /E2E recalled memory/);
  const secondPromptModelRequest = modelStub.requests.find((request) => (
    JSON.stringify(request.body).includes(SECOND_PROMPT)
  ));
  assert.ok(secondPromptModelRequest, "OpenCode did not send the second user prompt to the model");
  for (const request of [promptModelRequest, secondPromptModelRequest]) {
    assert.doesNotMatch(JSON.stringify(request.body), /Quota reminder|额度提醒/);
  }

  const repoMemoryJob = await waitFor(async () => {
    const jobs = await readRepoMemoryJobs(memoraxCodeHome);
    return jobs.find((job) => job.status === "succeeded" || job.status === "failed");
  }, 60_000);
  assert.equal(repoMemoryJob.status, "succeeded", JSON.stringify(repoMemoryJob, null, 2));
  assert.equal(repoMemoryJob.runner, "opencode");
  assert.equal(repoMemoryJob.mode, "build");
  assert.equal(repoMemoryJob.validation?.ok, true);
  const validatorPath = join(
    openCodeConfigDir,
    "skills", "memorax-code", "scripts", "validate_memory.py",
  );
  const repoMemoryValidation = JSON.parse((await run("python3", [validatorPath, workspace], {
    cwd: workspace,
    env,
  })).stdout);
  assert.equal(repoMemoryValidation.ok, true);

  const doctor = await runJson(memoraxOpenCode.command, [
    ...memoraxOpenCode.args,
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
  const tracePath = join(
    memoraxCodeHome,
    "debug", "traces", "opencode", "sessions", sessionId, "events.jsonl",
  );
  await waitFor(async () => (
    await readFile(tracePath, "utf8").catch(() => "")
  ).includes('"type":"memory_writeback"'));

  const traceEvents = (await readFile(tracePath, "utf8")).trim().split(/\r?\n/).map(JSON.parse);
  const traceTypes = new Set(traceEvents.map((event) => event.type));
  for (const type of ["turn_start", "turn_end", "memory_retrieve", "memory_writeback"]) {
    assert.equal(traceTypes.has(type), true);
  }

  const uninstall = await runJson(memoraxCode.command, [
    ...memoraxCode.args,
    "uninstall", "--json",
    "--home", memoraxCodeHome,
    "--opencode-config-dir", openCodeConfigDir,
    "--clients", "opencode",
    "--no-npm-uninstall",
    "--port", String(backendPort),
  ], { cwd: workspace, env });
  assert.equal(uninstall.ok, true);
  await assertMissing(join(openCodeConfigDir, "plugins", "memorax-code.js"));
  await assertMissing(join(openCodeConfigDir, "skills", "memorax-code", "SKILL.md"));
  await assertMissing(join(openCodeConfigDir, "hooks", "repo-memory-job.mjs"));
  assert.match(await readFile(userConfigPath, "utf8"), /user-owned config/);

  console.log(JSON.stringify({
    ok: true,
    openCodeVersion: OPENCODE_VERSION,
    searchRequests: memoryStub.requests.filter((request) => request.path === "/v1/memories/search").length,
    addRequests: memoryStub.requests.filter((request) => request.path === "/v1/memories/add").length,
    repoMemoryJobStatus: repoMemoryJob.status,
  }, null, 2));
} finally {
  if (memoraxCode) {
    await run(memoraxCode.command, [
      ...memoraxCode.args,
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
  let addCount = 0;
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
          balances: [quotaBalance("memory_search", 10)],
        },
      });
    }
    if (request.method === "POST" && request.url === "/v1/memories/add") {
      addCount += 1;
      return json(response, 202, {
        success: true,
        data: {
          task_id: `opencode-e2e-add-${addCount}`,
          status: "accepted",
          balances: [quotaBalance("memory_write", 10 - addCount)],
        },
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
    const isRepoMemoryBuild = JSON.stringify(body).includes(
      "This invocation is the authorized background repo-memory worker.",
    );
    if (isRepoMemoryBuild) {
      await writeValidRepoMemoryFixture(options.workspace, options.repoMemoryHead);
    }
    const reply = isRepoMemoryBuild
      ? "Repo Memory built and validated."
      : JSON.stringify(body).includes(SECOND_PROMPT)
        ? SECOND_REPLY
        : options.reply;
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

function quotaBalance(featureCode, remaining) {
  return {
    product_code: "memory_api",
    feature_code: featureCode,
    spec_key: "calls",
    quota_unit: "times",
    quota_limit: 100,
    reserved: 1,
    consumed: 0,
    remaining,
  };
}

function installedMemoraxCli(binDir, packageRoot, name) {
  if (process.platform !== "win32") {
    return { command: join(binDir, name), args: [] };
  }
  return {
    command: process.execPath,
    args: [join(packageRoot, "bin", `${name}.mjs`)],
  };
}

function runNpm(args, options) {
  const invocation = resolveNpmInvocation(args, {
    env: options.env,
    nodePath: process.execPath,
  });
  return run(invocation.command, invocation.args, options);
}

async function run(command, args, options) {
  try {
    const { closeStdin, ...execOptions } = options;
    const invocation = execFileAsync(command, args, {
      ...execOptions,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    if (closeStdin) invocation.child?.stdin?.end();
    return await invocation;
  } catch (error) {
    const detail = [error.message, error.stdout, error.stderr].filter(Boolean).join("\n");
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
    const result = await predicate();
    if (result) return result;
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

function parseJsonLines(output) {
  return output.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function openCodeRunText(events) {
  return events
    .filter((event) => event?.type === "text" && typeof event?.part?.text === "string")
    .map((event) => event.part.text)
    .join("\n")
    .trim();
}

async function readRepoMemoryJobs(memoraxCodeHome) {
  const jobsDir = join(memoraxCodeHome, "repo-memory-jobs");
  const entries = await readdir(jobsDir, { withFileTypes: true }).catch(() => []);
  const jobs = await Promise.all(entries
    .filter((entry) => entry.isDirectory() && entry.name !== "in-progress")
    .map(async (entry) => {
      try {
        return JSON.parse(await readFile(join(jobsDir, entry.name, "job.json"), "utf8"));
      } catch {
        return undefined;
      }
    }));
  return jobs.filter(Boolean);
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
      "# Isolated OpenCode E2E Repo Memory",
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
