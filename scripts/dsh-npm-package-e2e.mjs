#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const OPT_IN_ENV = "MEMORAX_CODE_DSH_E2E";
const DSH_SPEC_ENV = "MEMORAX_CODE_DSH_E2E_DSH_SPEC";
const DSH_ROOT_ENV = "MEMORAX_CODE_DSH_E2E_DSH_ROOT";
const DSH_COMMAND_ENV = "MEMORAX_CODE_DSH_COMMAND";
const MEMORAX_TARBALL_ENV = "MEMORAX_CODE_DSH_E2E_MEMORAX_TARBALL";
const DSH_PACKAGE_NAME = "@deepseek-ai/dsh";
const DSH_MOCK_PACKAGE_NAME = "@deepseek-ai/dsh-llm-mock-server";
const PINNED_PNPM_SPEC = "pnpm@11.7.0";
const RECALL_MARKER = "MEMORAX_DSH_E2E_RECALL_7D49";
const REASONING_MARKER = "MEMORAX_DSH_E2E_REASONING_B31C";
const VISIBLE_REPLY = "MEMORAX_DSH_E2E_VISIBLE_REPLY_5A62";
const FIRST_PROMPT = "MEMORAX_DSH_E2E_DIRECT_PROMPT_FIRST";
const SECOND_PROMPT = "MEMORAX_DSH_E2E_DIRECT_PROMPT_SECOND";
const STOPPED_PROMPT = "MEMORAX_DSH_E2E_PROMPT_AFTER_STOP";
const MEMORAX_API_KEY = "memorax-dsh-e2e-key";
const DEEPSEEK_API_KEY = "deepseek-dsh-e2e-key";
const COMMAND_TIMEOUT_MS = 120_000;
const BUILD_TIMEOUT_MS = 300_000;
const USAGE = `Usage:
  ${OPT_IN_ENV}=1 \\
  ${DSH_SPEC_ENV}=@deepseek-ai/dsh@<exact-version> \\
    node scripts/dsh-npm-package-e2e.mjs

Source-checkout fallback:
  ${OPT_IN_ENV}=1 \\
  ${DSH_ROOT_ENV}=/path/to/deepseek-harness \\
  ${DSH_COMMAND_ENV}=/path/to/dsh \\
    node scripts/dsh-npm-package-e2e.mjs

Optional:
  ${MEMORAX_TARBALL_ENV}=/absolute/path/to/memorax-code.tgz

Runs an isolated npm-package E2E against an exact npm DSH release or a matching
DSH source checkout and CLI. Registry mode also installs the matching published
LLM mock package and the E2E-pinned pnpm version into the isolated
npm prefix; it never uses a floating dist-tag or the host pnpm installation.
The test starts real DSH, Cordis, persistence, and MemoraX Code Backend code;
only the DeepSeek-compatible LLM endpoint and MemoraX HTTP endpoint are mocked.
Without ${MEMORAX_TARBALL_ENV}, the MemoraX Code package is built from this
checkout. Run pnpm run build in a DSH source checkout before using its
apps/cli/lib/bin.js.
`;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let isolatedRoot;
let stageRoot;
let memoraxCodeEntrypoint;
let runtimeEnv;
let backendPid;
let llmServer;
let memoraxServer;

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  process.stdout.write(USAGE);
  process.exit(0);
}
if (process.argv.length > 2) fail(`unknown argument: ${process.argv[2]}`);

main().catch((error) => {
  console.error(`dsh_npm_package_e2e_failed: ${safeError(error)}`);
  process.exitCode = 1;
}).finally(async () => {
  await cleanup();
});

async function main() {
  if (process.env[OPT_IN_ENV] !== "1") {
    throw new Error(`${OPT_IN_ENV}=1 is required; this real-client E2E never runs by default\n\n${USAGE}`);
  }
  const dshRequest = requestedDshHarness();

  isolatedRoot = await mkdtemp(join(tmpdir(), "memorax-code-dsh-npm-e2e-"));
  const home = join(isolatedRoot, "home");
  const memoraxCodeHome = join(isolatedRoot, "memorax-code home");
  const dshHome = join(isolatedRoot, "dsh home");
  const npmPrefix = join(isolatedRoot, "npm prefix");
  const npmCache = join(isolatedRoot, "npm cache");
  const npmUserConfig = join(isolatedRoot, "npmrc");
  const codexHome = join(isolatedRoot, "codex home");
  const claudeHome = join(isolatedRoot, "claude home");
  const workspace = join(isolatedRoot, "workspace");
  const tarballRoot = join(isolatedRoot, "tarballs");
  await Promise.all([
    home,
    memoraxCodeHome,
    dshHome,
    npmPrefix,
    npmCache,
    codexHome,
    claudeHome,
    workspace,
    tarballRoot,
  ].map((path) => mkdir(path, { recursive: true })));
  await writeFile(npmUserConfig, "", "utf8");
  await writeFile(join(workspace, "README.md"), "# isolated DSH E2E workspace\n", "utf8");
  const isolatedEnv = {
    ...sanitizedEnvironment(),
    HOME: home,
    CODEX_HOME: codexHome,
    CLAUDE_CONFIG_DIR: claudeHome,
    CLAUDE_HOME: claudeHome,
    DSH_HOME: dshHome,
    NPM_CONFIG_PREFIX: npmPrefix,
    NPM_CONFIG_CACHE: npmCache,
    NPM_CONFIG_USERCONFIG: npmUserConfig,
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
    NPM_CONFIG_FUND: "false",
    NPM_CONFIG_AUDIT: "false",
    PATH: `${npmBinDirectory(npmPrefix)}${delimiter}${process.env.PATH ?? ""}`,
  };
  await run("git", ["init", "--quiet"], { cwd: workspace, env: isolatedEnv });

  const dsh = await resolveDshHarness(dshRequest, {
    env: isolatedEnv,
    npmPrefix,
    workspace,
  });
  const { startMockLlmServer } = await import(pathToFileURL(dsh.mockLlmModulePath).href);
  assert.equal(typeof startMockLlmServer, "function", "DSH mock LLM module does not export startMockLlmServer");

  llmServer = await startMockLlmServer({
    sequence: ["tool_call_success", "reasoning_success"],
    repeatLast: true,
    apiKey: DEEPSEEK_API_KEY,
    successText: VISIBLE_REPLY,
    reasoningText: REASONING_MARKER,
    toolName: "skill",
    toolArguments: JSON.stringify({ name: "memorax-code" }),
  });
  memoraxServer = await startMemoraxMock();
  const backendPort = await reserveFreePort();

  runtimeEnv = {
    ...isolatedEnv,
    MEMORAX_CODE_HOME: memoraxCodeHome,
    MEMORAX_CODE_BACKEND_PORT: String(backendPort),
    MEMORAX_CODE_DSH_COMMAND: dsh.command,
    MEMORAX_CODE_SKIP_CODEX_PLUGIN_INSTALL: "1",
    MEMORAX_CODE_SKIP_CLAUDE_ADAPTER_INSTALL: "1",
    MEMORAX_CODE_MEMORAX_ENDPOINT: memoraxServer.baseUrl,
    MEMORAX_CODE_MEMORAX_API_KEY: MEMORAX_API_KEY,
    MEMORAX_CODE_MEMORAX_USER_ID: "memorax-dsh-e2e-user",
    MEMORAX_CODE_MEMORY_RETRIEVAL_ENABLED: "true",
    MEMORAX_CODE_MEMORY_WRITEBACK_ENABLED: "true",
    MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_ENABLED: "false",
    MEMORAX_CODE_MEMORY_WRITEBACK_CHUNK_ENABLED: "false",
    MEMORAX_CODE_MEMORY_OUTPUT_LANGUAGE: "en",
    MEMORAX_CODE_DSH_DEBUG: "1",
    DEEPSEEK_BASE_URL: `${llmServer.baseURL}/v1`,
    DEEPSEEK_API_KEY,
    DSH_TELEMETRY_DISABLED: "1",
    DSH_PERMISSION_MODE: "danger-full-access",
  };

  progress("initializing an isolated real DSH headless profile");
  await run(dsh.command, ["--profile", "headless", "--dump-default-config"], {
    cwd: workspace,
    env: runtimeEnv,
  });
  await writeFile(join(dshHome, "profiles", "headless", "cordis.patch.yml"), [
    "- id: session-title-llm",
    "  disabled: true",
    "",
    "- id: session-persistence-jsonl",
    "  config:",
    "    root: !!js dshHomePath('sessions')",
    "    compression: none",
    "    packChunks: false",
    "",
  ].join("\n"), "utf8");

  const memoraxPackage = await prepareMemoraxPackage({
    env: runtimeEnv,
    tarballRoot,
    workspace,
  });

  progress("installing the tarball with real npm lifecycle scripts");
  await run("npm", [
    "install",
    "-g",
    "--prefix",
    npmPrefix,
    memoraxPackage.tarball,
    "--foreground-scripts",
    "--loglevel",
    "warn",
  ], { cwd: workspace, env: runtimeEnv, timeoutMs: BUILD_TIMEOUT_MS });

  const packageRoot = await installedPackageRoot(npmPrefix);
  memoraxCodeEntrypoint = join(packageRoot, "bin", "memorax-code.mjs");
  await assertFile(memoraxCodeEntrypoint);
  const sourceAdapterRoot = join(packageRoot, "lib", "memorax-code-dsh-adapter");
  const headlessProfile = join(dshHome, "profiles", "headless");
  const installedAdapter = join(headlessProfile, "node_modules", "@memorax-code", "dsh-adapter");
  const dshStatePath = join(memoraxCodeHome, "adapters", "dsh", "state.json");
  const backendStatePath = join(memoraxCodeHome, "runtime", "backend", "backend.pid.json");

  await assertProfileIntegrated(headlessProfile);
  for (const relativePath of [
    ".memorax-code-package.json",
    "hooks/repo-memory-job.mjs",
    "skills/memorax-code/SKILL.md",
    "skills/memorax-code/dsh-definition.json",
    "memorax-code-adapter-common/src/backend-connection.mjs",
    "src/index.mjs",
  ]) await assertFile(join(installedAdapter, relativePath));
  const packageMetadata = await readJson(join(installedAdapter, ".memorax-code-package.json"));
  const dshState = await readJson(dshStatePath);
  assert.equal(dshState.enabled, true, "npm postinstall did not enable the DSH integration");
  assert.equal(dshState.dshVersion, dsh.version, "DSH lifecycle state did not record the preflighted version");
  assert.deepEqual(dshState.profiles, ["headless"]);
  assert.equal(await realpath(dshState.adapterRoot), await realpath(sourceAdapterRoot));
  assert.equal(await realpath(packageMetadata.sourceAdapterRoot), await realpath(sourceAdapterRoot));
  assert.equal(await realpath(packageMetadata.dshHome), await realpath(dshHome));
  const initialStatus = JSON.parse((await runMemoraxCode([
    "status",
    "--home",
    memoraxCodeHome,
    "--port",
    String(backendPort),
    "--clients",
    "none",
    "--json",
  ], workspace)).stdout);
  assert.equal(initialStatus.dshAdapter?.enabled, true);
  assert.equal(initialStatus.dshAdapter?.version, dsh.version);
  assert.deepEqual(initialStatus.dshAdapter?.profiles?.map((profile) => profile.name), ["headless"]);
  const initialBackendState = await readJson(backendStatePath);
  backendPid = safePid(initialBackendState.pid, "postinstall Backend PID");

  progress("running the first real DSH agent Turn through retrieval, skill, and writeback");
  const firstLlmStart = llmServer.requests.length;
  await runHeadless(dsh.command, workspace, runtimeEnv, FIRST_PROMPT);
  await waitFor(() => memoraxRequests("/v1/memories/add").length >= 1, "first MemoraX Add");
  const firstLlmRequests = llmServer.requests.slice(firstLlmStart);
  assert.ok(firstLlmRequests.length >= 2, "the first Turn did not complete its skill tool round trip");
  assertIncludesJson(firstLlmRequests.map((request) => request.body), RECALL_MARKER, "first model request recall");
  const firstSearch = memoraxRequests("/v1/memories/search")[0];
  assert.equal(firstSearch?.body?.query, FIRST_PROMPT);
  assertExactAdd(memoraxRequests("/v1/memories/add")[0], FIRST_PROMPT);

  const firstSession = await sessionForPrompt(join(dshHome, "sessions"), FIRST_PROMPT);
  assert.match(firstSession.content, new RegExp(RECALL_MARKER));
  assert.match(firstSession.content, new RegExp(REASONING_MARKER));
  assert.match(firstSession.content, /"type":"tool\/call"/);
  assert.match(firstSession.content, /"name":"skill"/);
  assert.match(firstSession.content, /skill_content[^\n]*memorax-code/s);

  progress("restarting the real Backend, then starting a new DSH process and session");
  await runMemoraxCode(["restart", "--home", memoraxCodeHome, "--port", String(backendPort), "--clients", "none", "--json"], workspace);
  const restartedBackendState = await readJson(backendStatePath);
  const restartedPid = safePid(restartedBackendState.pid, "restarted Backend PID");
  assert.notEqual(restartedPid, backendPid, "Backend restart kept the same PID");
  await waitFor(() => !isProcessAlive(backendPid), "pre-restart Backend exit");
  backendPid = restartedPid;

  const secondLlmStart = llmServer.requests.length;
  await runHeadless(dsh.command, workspace, runtimeEnv, SECOND_PROMPT);
  await waitFor(() => memoraxRequests("/v1/memories/add").length >= 2, "second MemoraX Add");
  const secondLlmRequests = llmServer.requests.slice(secondLlmStart);
  assert.ok(secondLlmRequests.length >= 1, "the restarted DSH process made no model request");
  assertIncludesJson(secondLlmRequests.map((request) => request.body), RECALL_MARKER, "post-restart model request recall");
  assertExactAdd(memoraxRequests("/v1/memories/add")[1], SECOND_PROMPT);
  const secondSession = await sessionForPrompt(join(dshHome, "sessions"), SECOND_PROMPT);
  assert.notEqual(secondSession.id, firstSession.id, "a new DSH process reused the first session");

  progress("creating a later DSH profile and reconciling it with memorax-code start");
  await run(dsh.command, ["--profile", "web", "--dump-default-config"], {
    cwd: workspace,
    env: runtimeEnv,
  });
  const webProfile = join(dshHome, "profiles", "web");
  const webManifestPath = join(webProfile, "package.json");
  const stateBeforeDriftStatus = await readFile(dshStatePath, "utf8");
  const webBeforeDriftStatus = await readFile(webManifestPath, "utf8");
  const driftStatus = JSON.parse((await runMemoraxCode([
    "status",
    "--home",
    memoraxCodeHome,
    "--port",
    String(backendPort),
    "--clients",
    "none",
    "--json",
  ], workspace)).stdout);
  assert.equal(driftStatus.ok, true);
  assert.equal(driftStatus.dshAdapter?.enabled, false);
  assert.equal(driftStatus.dshAdapter?.reason, "profile_drift");
  assert.deepEqual(driftStatus.dshAdapter?.profiles, [
    { name: "headless", managed: true, exists: true, installed: true },
    { name: "web", managed: false, exists: true, installed: false },
  ]);
  assert.equal(await readFile(dshStatePath, "utf8"), stateBeforeDriftStatus);
  assert.equal(await readFile(webManifestPath, "utf8"), webBeforeDriftStatus);
  await runMemoraxCode(["start", "--home", memoraxCodeHome, "--port", String(backendPort), "--clients", "none", "--json"], workspace);
  await assertProfileIntegrated(webProfile);
  const expandedState = await readJson(dshStatePath);
  assert.equal(expandedState.enabled, true);
  assert.deepEqual(expandedState.profiles, ["headless", "web"]);
  const expandedStatus = JSON.parse((await runMemoraxCode([
    "status",
    "--home",
    memoraxCodeHome,
    "--port",
    String(backendPort),
    "--clients",
    "none",
    "--json",
  ], workspace)).stdout);
  assert.equal(expandedStatus.dshAdapter?.enabled, true);
  assert.deepEqual(expandedStatus.dshAdapter?.profiles?.map((profile) => profile.name), ["headless", "web"]);

  progress("stopping MemoraX Code and proving DSH cannot revive the Backend");
  const requestsBeforeStop = memoraxServer.requests.length;
  await runMemoraxCode(["stop", "--home", memoraxCodeHome, "--port", String(backendPort), "--json"], workspace);
  await waitFor(() => !isProcessAlive(backendPid), "stopped Backend exit");
  backendPid = undefined;
  assert.equal(await exists(backendStatePath), false, "stop left Backend PID authority behind");
  const stoppedState = await readJson(dshStatePath);
  assert.equal(stoppedState.enabled, false);
  await assertProfileNotIntegrated(headlessProfile);
  await assertProfileNotIntegrated(webProfile);

  await runHeadless(dsh.command, workspace, runtimeEnv, STOPPED_PROMPT);
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
  assert.equal(memoraxServer.requests.length, requestsBeforeStop, "DSH emitted MemoraX traffic after stop");
  assert.equal(await exists(backendStatePath), false, "DSH revived the Backend after stop");

  const preservedSessionFiles = await snapshotFiles(join(dshHome, "sessions"));
  assert.ok(preservedSessionFiles.size >= 3, "real DSH runs did not persist all expected sessions");
  progress("uninstalling the real npm package while preserving DSH profiles and sessions");
  await runMemoraxCode(["uninstall", "--home", memoraxCodeHome, "--port", String(backendPort), "--json"], workspace);
  memoraxCodeEntrypoint = undefined;
  assert.equal(await exists(packageRoot), false, "full uninstall left the npm package installed");
  assert.equal(await exists(dshStatePath), false, "full uninstall left DSH state behind");
  assert.equal(await exists(headlessProfile), true, "uninstall deleted the headless profile");
  assert.equal(await exists(webProfile), true, "uninstall deleted the later web profile");
  await assertProfileNotIntegrated(headlessProfile);
  await assertProfileNotIntegrated(webProfile);
  assert.deepEqual(await snapshotFiles(join(dshHome, "sessions")), preservedSessionFiles, "uninstall changed DSH session data");

  process.stdout.write(`${JSON.stringify({
    ok: true,
    dshDistribution: dsh.distribution,
    dshVersion: dsh.version,
    ...(dsh.requestedVersion ? { requestedDshVersion: dsh.requestedVersion } : {}),
    ...(dsh.pnpmVersion ? { pnpmVersion: dsh.pnpmVersion } : {}),
    memoraxPackageSource: memoraxPackage.source,
    npmPackageInstalledByPostinstall: true,
    firstTurnSkillRoundTrip: true,
    exactWritebackMessages: true,
    backendRestarted: true,
    newProcessNewSession: true,
    laterProfileReconciled: true,
    stoppedBackendStayedDown: true,
    uninstallPreservedProfilesAndSessions: true,
    llmRequests: llmServer.requests.length,
    memoraxSearches: memoraxRequests("/v1/memories/search").length,
    memoraxAdds: memoraxRequests("/v1/memories/add").length,
  }, null, 2)}\n`);
}

async function prepareMemoraxPackage(options) {
  const supplied = optionalString(process.env[MEMORAX_TARBALL_ENV]);
  if (supplied) {
    const tarball = await requiredFilePath(supplied, MEMORAX_TARBALL_ENV);
    assert.match(tarball, /\.tgz$/, `${MEMORAX_TARBALL_ENV} must name an npm .tgz package`);
    progress(`using the prebuilt MemoraX Code tarball ${tarball}`);
    return { source: "prebuilt-tarball", tarball };
  }

  const stageName = `dsh-npm-e2e-${process.pid}-${randomUUID().replaceAll("-", "")}`;
  const stageRelative = join("dist", stageName);
  stageRoot = join(repoRoot, stageRelative);
  assertWithin(join(repoRoot, "dist"), stageRoot, "npm staging directory");
  progress("building and packing the real MemoraX Code npm package");
  await run(join(repoRoot, "scripts/build-npm-packages.sh"), [stageRelative], {
    cwd: repoRoot,
    env: options.env,
    timeoutMs: BUILD_TIMEOUT_MS,
  });
  const pack = await run("npm", [
    "pack",
    join(stageRoot, "memorax-code"),
    "--pack-destination",
    options.tarballRoot,
    "--json",
  ], {
    cwd: options.workspace,
    env: options.env,
    timeoutMs: BUILD_TIMEOUT_MS,
  });
  const packReport = JSON.parse(pack.stdout);
  assert.equal(Array.isArray(packReport), true, "npm pack did not return an array report");
  assert.equal(packReport.length, 1, "npm pack must produce exactly one tarball");
  assert.equal(packReport[0]?.name, "@memorax/memorax-code");
  const tarball = join(
    options.tarballRoot,
    requiredString(packReport[0]?.filename, "npm pack filename"),
  );
  await assertFile(tarball);
  return { source: "checkout-build", tarball };
}

function requestedDshHarness() {
  const spec = optionalString(process.env[DSH_SPEC_ENV]);
  const root = optionalString(process.env[DSH_ROOT_ENV]);
  const command = optionalString(process.env[DSH_COMMAND_ENV]);
  if (spec) {
    if (root || command) {
      fail(`${DSH_SPEC_ENV} cannot be combined with ${DSH_ROOT_ENV} or ${DSH_COMMAND_ENV}`);
    }
    const requestedVersion = exactDshVersion(spec);
    if (!requestedVersion) {
      fail(`${DSH_SPEC_ENV} must be ${DSH_PACKAGE_NAME}@<exact-version>; ranges and dist-tags are not accepted`);
    }
    return { distribution: "npm", spec, requestedVersion };
  }
  if (!root || !command) {
    fail(`set ${DSH_SPEC_ENV}, or set both ${DSH_ROOT_ENV} and ${DSH_COMMAND_ENV}`);
  }
  return { distribution: "source" };
}

async function resolveDshHarness(request, options) {
  if (request.distribution === "npm") {
    return resolveNpmDshHarness(request, options);
  }
  const dshRoot = await requiredDirectory(DSH_ROOT_ENV);
  const dshCommand = await requiredExecutable(DSH_COMMAND_ENV);
  const dshManifest = await readJson(join(dshRoot, "apps/cli/package.json"));
  assert.equal(dshManifest?.name, DSH_PACKAGE_NAME, `${DSH_ROOT_ENV} does not contain the DSH CLI source`);
  const sourceDshCommand = join(dshRoot, "apps/cli/lib/bin.js");
  if (await exists(sourceDshCommand) && dshCommand === await realpath(sourceDshCommand)) {
    for (const path of [
      join(dshRoot, "packages/typert/registry/lib/index.js"),
      join(dshRoot, "packages/api/gateway/lib/index.js"),
    ]) await assertFile(path, "run pnpm run build in the DSH source checkout before this E2E");
  }
  const version = await commandVersion(dshCommand, options);
  assert.equal(version, dshManifest.version, "DSH source manifest and CLI versions differ");
  const mockLlmModulePath = join(dshRoot, "packages/test-support/llm-mock-server/lib/index.js");
  await assertFile(mockLlmModulePath, "build the DSH mock LLM package before running this E2E");
  return {
    command: dshCommand,
    distribution: "source",
    mockLlmModulePath,
    version,
  };
}

async function resolveNpmDshHarness(request, options) {
  progress(`installing ${request.spec}, its matching LLM mock, and ${PINNED_PNPM_SPEC}`);
  await run("npm", [
    "install",
    "-g",
    "--prefix",
    options.npmPrefix,
    request.spec,
    `${DSH_MOCK_PACKAGE_NAME}@${request.requestedVersion}`,
    PINNED_PNPM_SPEC,
    "--foreground-scripts",
    "--loglevel",
    "warn",
  ], {
    cwd: options.workspace,
    env: options.env,
    timeoutMs: BUILD_TIMEOUT_MS,
  });

  const dshRoot = await installedGlobalPackageRoot(options.npmPrefix, DSH_PACKAGE_NAME);
  const dshManifest = await readJson(join(dshRoot, "package.json"));
  assert.equal(dshManifest?.name, DSH_PACKAGE_NAME);
  assert.equal(dshManifest?.version, request.requestedVersion, "installed DSH version differs from the requested version");
  const dshCommand = await requiredExecutablePath(globalBinPath(options.npmPrefix, "dsh"), "installed DSH CLI");
  const version = await commandVersion(dshCommand, options);
  assert.equal(version, request.requestedVersion, "installed DSH manifest and CLI versions differ");

  const mockRoot = await installedGlobalPackageRoot(options.npmPrefix, DSH_MOCK_PACKAGE_NAME);
  const mockManifest = await readJson(join(mockRoot, "package.json"));
  assert.equal(mockManifest?.name, DSH_MOCK_PACKAGE_NAME);
  assert.equal(mockManifest?.version, version, "DSH and its LLM mock package versions differ");
  const mockLlmModulePath = join(mockRoot, "lib", "index.js");
  await assertFile(mockLlmModulePath);

  const pnpmCommand = await requiredExecutablePath(globalBinPath(options.npmPrefix, "pnpm"), "isolated pnpm CLI");
  const pnpmVersion = await commandVersion(pnpmCommand, options);
  assert.equal(pnpmVersion, PINNED_PNPM_SPEC.slice("pnpm@".length));
  return {
    command: dshCommand,
    distribution: "npm",
    mockLlmModulePath,
    pnpmVersion,
    requestedVersion: request.requestedVersion,
    version,
  };
}

async function commandVersion(command, options) {
  const result = await run(command, ["--version"], {
    cwd: options.workspace,
    env: options.env,
  });
  const version = requiredString(result.stdout, `${commandLabel(command)} --version`).trim();
  assert.equal(version.includes("\n"), false, `${commandLabel(command)} --version returned multiple lines`);
  return version;
}

function exactDshVersion(spec) {
  const prefix = `${DSH_PACKAGE_NAME}@`;
  if (!spec.startsWith(prefix)) return undefined;
  const version = spec.slice(prefix.length);
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(version)
    ? version
    : undefined;
}

function npmBinDirectory(prefix) {
  return process.platform === "win32" ? prefix : join(prefix, "bin");
}

function globalBinPath(prefix, name) {
  return join(npmBinDirectory(prefix), process.platform === "win32" ? `${name}.cmd` : name);
}

async function runHeadless(command, cwd, env, prompt) {
  const result = await run(command, ["--profile", "headless", prompt], { cwd, env });
  assert.match(result.stdout, new RegExp(VISIBLE_REPLY), `DSH headless output did not contain ${VISIBLE_REPLY}`);
}

async function runMemoraxCode(args, cwd) {
  assert.ok(memoraxCodeEntrypoint, "MemoraX Code entrypoint is unavailable");
  return run(process.execPath, [memoraxCodeEntrypoint, ...args], { cwd, env: runtimeEnv });
}

function assertExactAdd(request, prompt) {
  assert.ok(request, `missing MemoraX Add for ${prompt}`);
  assert.equal(request.authorization, `Token ${MEMORAX_API_KEY}`);
  assert.deepEqual(request.body?.messages?.map((message) => [message.role, message.content]), [
    ["user", prompt],
    ["assistant", VISIBLE_REPLY],
  ]);
  const serialized = JSON.stringify(request.body);
  assert.doesNotMatch(serialized, new RegExp(RECALL_MARKER));
  assert.doesNotMatch(serialized, new RegExp(REASONING_MARKER));
  assert.doesNotMatch(serialized, /skill_content/);
}

async function assertProfileIntegrated(profileRoot) {
  const manifest = await readJson(join(profileRoot, "package.json"));
  assert.equal(Object.hasOwn(manifest.dependencies ?? {}, "@memorax-code/dsh-adapter"), true);
  assert.equal(manifest.dsh?.profile?.bundles?.includes("@memorax-code/dsh-adapter"), true);
}

async function assertProfileNotIntegrated(profileRoot) {
  const manifest = await readJson(join(profileRoot, "package.json"));
  assert.equal(Object.hasOwn(manifest.dependencies ?? {}, "@memorax-code/dsh-adapter"), false);
  assert.equal(manifest.dsh?.profile?.bundles?.includes("@memorax-code/dsh-adapter"), false);
}

async function sessionForPrompt(sessionsRoot, prompt) {
  await waitFor(async () => {
    const files = await listFiles(sessionsRoot);
    return files.some((path) => path.endsWith(".jsonl"));
  }, `persisted session for ${prompt}`);
  for (const path of await listFiles(sessionsRoot)) {
    if (!path.endsWith(".jsonl")) continue;
    const content = await readFile(path, "utf8");
    if (!content.includes(prompt)) continue;
    const header = JSON.parse(content.split("\n", 1)[0]);
    return { id: requiredString(header.id, "DSH session id"), path, content };
  }
  throw new Error(`no persisted DSH session contains ${prompt}`);
}

async function snapshotFiles(root) {
  const result = new Map();
  for (const path of await listFiles(root)) {
    result.set(relative(root, path), await readFile(path, "utf8"));
  }
  return result;
}

async function listFiles(root) {
  const result = [];
  async function visit(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) result.push(path);
    }
  }
  await visit(root);
  return result.sort();
}

async function startMemoraxMock() {
  const requests = [];
  const server = createHttpServer((request, response) => {
    void handle(request, response).catch((error) => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ success: false, error: safeError(error) }));
    });
  });
  async function handle(request, response) {
    const body = await readRequestBody(request);
    const record = {
      method: request.method,
      path: request.url,
      authorization: request.headers.authorization,
      body,
    };
    requests.push(record);
    response.setHeader("content-type", "application/json");
    if (request.headers.authorization !== `Token ${MEMORAX_API_KEY}`) {
      response.writeHead(401);
      response.end(JSON.stringify({ success: false, error: "invalid test authorization" }));
      return;
    }
    if (request.method === "POST" && request.url === "/v1/memories/search") {
      response.writeHead(200);
      response.end(JSON.stringify({
        success: true,
        data: {
          task_id: "dsh-e2e-search",
          status: "completed",
          data: [{
            id: "dsh-e2e-memory",
            memory: RECALL_MARKER,
            score: 1,
            metadata: { memory_type: "core" },
          }],
        },
        meta: { request_id: "dsh-e2e-search-request" },
      }));
      return;
    }
    if (request.method === "POST" && request.url === "/v1/memories/add") {
      response.writeHead(202);
      response.end(JSON.stringify({
        success: true,
        data: { task_id: "dsh-e2e-add", status: "accepted", data: null },
        meta: { request_id: "dsh-e2e-add-request" },
      }));
      return;
    }
    if (request.method === "GET" && request.url?.startsWith("/v1/memories/add/status/")) {
      response.writeHead(200);
      response.end(JSON.stringify({
        success: true,
        data: { task_id: "dsh-e2e-add", status: "completed", data: null },
        meta: { request_id: "dsh-e2e-add-status-request" },
      }));
      return;
    }
    response.writeHead(404);
    response.end(JSON.stringify({ success: false, error: "unknown test route" }));
  }
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolveClose) => {
      server.close(() => resolveClose());
      server.closeAllConnections();
    }),
  };
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function memoraxRequests(path) {
  return memoraxServer.requests.filter((request) => request.path === path);
}

async function installedPackageRoot(prefix) {
  return installedGlobalPackageRoot(prefix, "@memorax/memorax-code");
}

async function installedGlobalPackageRoot(prefix, packageName) {
  const packagePath = packageName.split("/");
  for (const path of [
    join(prefix, "lib", "node_modules", ...packagePath),
    join(prefix, "node_modules", ...packagePath),
  ]) {
    if (await exists(join(path, "package.json"))) return path;
  }
  throw new Error(`npm did not install ${packageName} under the isolated prefix`);
}

async function reserveFreePort() {
  const server = createNetServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise((resolveClose, rejectClose) => server.close((error) => {
    if (error) rejectClose(error);
    else resolveClose();
  }));
  return port;
}

async function run(command, args, { cwd, env, timeoutMs = COMMAND_TIMEOUT_MS } = {}) {
  const child = spawn(command, args, {
    cwd,
    env: { ...env, PWD: cwd },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);
  const result = await new Promise((resolveChild, rejectChild) => {
    child.once("error", rejectChild);
    child.once("close", (code, signal) => resolveChild({ code, signal }));
  }).finally(() => clearTimeout(timer));
  if (timedOut || result.code !== 0) {
    throw new Error([
      `${commandLabel(command)} exited ${timedOut ? `after ${timeoutMs} ms` : result.code ?? result.signal}`,
      stdout.trim() ? `stdout:\n${tail(stdout)}` : "",
      stderr.trim() ? `stderr:\n${tail(stderr)}` : "",
    ].filter(Boolean).join("\n"));
  }
  return { stdout, stderr };
}

async function waitFor(predicate, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function safePid(value, label) {
  assert.ok(Number.isSafeInteger(value) && value > 0, `${label} is invalid`);
  return value;
}

function sanitizedEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("MEMORAX_CODE_")
      || key.startsWith("DEEPSEEK_")
      || key.startsWith("DSH_")
      || key === "CODEX_HOME"
      || key === "CLAUDE_CONFIG_DIR"
      || key === "CLAUDE_HOME") delete env[key];
  }
  return env;
}

async function requiredDirectory(name) {
  const value = requiredString(process.env[name], name);
  const path = await realpath(resolve(value));
  assert.equal((await stat(path)).isDirectory(), true, `${name} is not a directory`);
  return path;
}

async function requiredExecutable(name) {
  const value = requiredString(process.env[name], name);
  return requiredExecutablePath(value, name);
}

async function requiredFilePath(value, label) {
  const path = await realpath(resolve(value));
  assert.equal((await stat(path)).isFile(), true, `${label} is not a file`);
  return path;
}

async function requiredExecutablePath(value, label) {
  const path = await realpath(resolve(value));
  await access(path, process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
  assert.equal((await stat(path)).isFile(), true, `${label} is not a file`);
  return path;
}

async function assertFile(path, hint) {
  try {
    assert.equal((await stat(path)).isFile(), true);
  } catch (error) {
    throw new Error(`${path} is not a file${hint ? `; ${hint}` : ""}`, { cause: error });
  }
}

async function exists(path) {
  return stat(path).then(() => true, () => false);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function requiredString(value, label) {
  assert.ok(typeof value === "string" && value.trim(), `${label} is required`);
  return value.trim();
}

function optionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function assertIncludesJson(value, marker, label) {
  assert.match(JSON.stringify(value), new RegExp(marker), `${label} is missing`);
}

function assertWithin(root, candidate, label) {
  const child = relative(resolve(root), resolve(candidate));
  assert.ok(child && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child), `${label} escapes ${root}`);
}

function progress(message) {
  process.stderr.write(`[dsh-npm-e2e] ${message}\n`);
}

function commandLabel(command) {
  return command.split(/[\\/]/).at(-1) || command;
}

function tail(value, maxChars = 12_000) {
  return value.length <= maxChars ? value : value.slice(-maxChars);
}

function safeError(error) {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

function fail(message) {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(2);
}

async function cleanup() {
  if (memoraxCodeEntrypoint && runtimeEnv && await exists(memoraxCodeEntrypoint)) {
    await run(process.execPath, [memoraxCodeEntrypoint, "stop", "--home", runtimeEnv.MEMORAX_CODE_HOME, "--json"], {
      cwd: repoRoot,
      env: runtimeEnv,
      timeoutMs: 30_000,
    }).catch(() => undefined);
  }
  if (backendPid && isProcessAlive(backendPid)) {
    try {
      process.kill(backendPid, "SIGTERM");
      await waitFor(() => !isProcessAlive(backendPid), "cleanup Backend exit", 5_000);
    } catch {
      if (isProcessAlive(backendPid)) process.kill(backendPid, "SIGKILL");
    }
  }
  await Promise.allSettled([
    llmServer?.close?.(),
    memoraxServer?.close?.(),
  ]);
  if (stageRoot) {
    assertWithin(join(repoRoot, "dist"), stageRoot, "cleanup npm staging directory");
    await rm(stageRoot, { recursive: true, force: true });
  }
  if (isolatedRoot) await rm(isolatedRoot, { recursive: true, force: true });
}
