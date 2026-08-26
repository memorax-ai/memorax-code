#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
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
import { basename, delimiter, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const OPT_IN_ENV = "MEMORAX_CODE_DSH_E2E";
const TARBALL_ENV = "MEMORAX_CODE_DSH_E2E_MEMORAX_TARBALL";
const DSH_VERSION = "0.1.0-rc.6";
const DSH_PACKAGE = "@deepseek-ai/dsh";
const DSH_MOCK_PACKAGE = "@deepseek-ai/dsh-llm-mock-server";
const DSH_SPEC = DSH_PACKAGE + "@" + DSH_VERSION;
const PNPM_SPEC = "pnpm@11.7.0";
const RECALL = "MEMORAX_DSH_E2E_RECALL_7D49";
const USER_PROFILE = "MEMORAX_DSH_E2E_USER_PROFILE_C42A";
const PROCEDURE_MEMORY = "MEMORAX_DSH_E2E_PROCEDURE_8F13";
const MEMORY_REMINDER = "MemoraX Code reminder: proactively invoke /memorax-code";
const PERSONAL_MEMORY_REMINDER = "MemoraX Code personal-memory reminder: Use /memorax-code";
const REASONING = "MEMORAX_DSH_E2E_REASONING_B31C";
const REPLY = "MEMORAX_DSH_E2E_VISIBLE_REPLY_5A62";
const FIRST_PROMPT = "MEMORAX_DSH_E2E_FIRST_TURN";
const CRASH_PROMPT = "MEMORAX_DSH_E2E_INTERRUPTED_PROMPT";
const RESUME_PROMPT = "MEMORAX_DSH_E2E_RESUMED_PROMPT";
const INTERRUPTED_SESSION_ID = "memorax-dsh-e2e-interrupted";
const INTERRUPTED_MODE_ENV = "MEMORAX_CODE_DSH_E2E_INTERRUPTED_MODE";
const RECOVERY_PROMPT = "MEMORAX_DSH_E2E_AFTER_BACKEND_CRASH";
const STOPPED_PROMPT = "MEMORAX_DSH_E2E_AFTER_STOP";
const MEMORAX_KEY = "memorax-dsh-e2e-key";
const DEEPSEEK_KEY = "deepseek-dsh-e2e-key";
const REPO_MEMORY_DISPATCH_LOG_ENV = "MEMORAX_CODE_DSH_E2E_REPO_JOB_LOG";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const usage = [
  "Usage:",
  "  " + OPT_IN_ENV + "=1 node scripts/dsh-npm-package-e2e.mjs",
  "",
  "Optional:",
  "  " + TARBALL_ENV + "=/absolute/path/to/memorax-code.tgz",
  "",
  "Runs an isolated real-client E2E against " + DSH_SPEC + ".",
  "DSH, Cordis, npm lifecycle scripts, Profiles, and the Backend are real;",
  "only the LLM and MemoraX HTTP endpoints are mocked.",
  "",
].join("\n");

let isolatedRoot;
let stageRoot;
let memoraxEntry;
let runtimeEnv;
let backendPid;
let llmServer;
let memoraxServer;

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  process.stdout.write(usage);
  process.exit(0);
}
if (process.argv.length > 2) {
  console.error("Unknown argument: " + process.argv[2] + "\n\n" + usage);
  process.exit(2);
}
if (process.env[OPT_IN_ENV] !== "1") {
  console.error(OPT_IN_ENV + "=1 is required; this E2E never runs by default\n\n" + usage);
  process.exit(2);
}

main().catch((error) => {
  console.error("dsh_npm_package_e2e_failed: " + (error?.stack || error));
  process.exitCode = 1;
}).finally(cleanup);

async function main() {
  isolatedRoot = await mkdtemp(join(tmpdir(), "memorax-code-dsh-e2e-"));
  const paths = {
    home: join(isolatedRoot, "home"),
    memoraxHome: join(isolatedRoot, "memorax home"),
    dshHome: join(isolatedRoot, "dsh home"),
    codexHome: join(isolatedRoot, "codex home"),
    claudeHome: join(isolatedRoot, "claude home"),
    opencodeHome: join(isolatedRoot, "opencode config"),
    prefix: join(isolatedRoot, "npm prefix"),
    cache: join(isolatedRoot, "npm cache"),
    workspace: join(isolatedRoot, "workspace"),
    tarballs: join(isolatedRoot, "tarballs"),
  };
  await Promise.all(Object.values(paths).map((path) => mkdir(path, { recursive: true })));
  for (const [name, path] of Object.entries(paths)) paths[name] = await realpath(path);
  await writeFile(join(paths.workspace, "README.md"), "# isolated DSH E2E\n");
  await writeFile(join(paths.workspace, ".gitignore"), ".repo_memory/\n");
  const repoMemoryDispatchLog = join(isolatedRoot, "repo-memory-dispatch.jsonl");
  const ambientMemoraxHome = join(isolatedRoot, "ambient memorax-code home");

  const env = {
    ...cleanEnvironment(),
    HOME: paths.home,
    MEMORAX_CODE_HOME: paths.memoraxHome,
    DSH_HOME: paths.dshHome,
    CODEX_HOME: paths.codexHome,
    CLAUDE_CONFIG_DIR: paths.claudeHome,
    CLAUDE_HOME: paths.claudeHome,
    OPENCODE_CONFIG_DIR: paths.opencodeHome,
    NPM_CONFIG_PREFIX: paths.prefix,
    NPM_CONFIG_CACHE: paths.cache,
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
    NPM_CONFIG_FUND: "false",
    NPM_CONFIG_AUDIT: "false",
    PATH: npmBin(paths.prefix) + delimiter + (process.env.PATH || ""),
  };
  await run("git", ["init", "--quiet"], paths.workspace, env);
  await run("git", ["-c", "user.name=DSH E2E", "-c", "user.email=e2e@example.invalid",
    "add", "README.md", ".gitignore"], paths.workspace, env);
  await run("git", ["-c", "user.name=DSH E2E", "-c", "user.email=e2e@example.invalid",
    "commit", "--quiet", "-m", "fixture"], paths.workspace, env);
  await writePersonalContextFixtures(paths.workspace);

  progress("installing the pinned DSH release and its test-only dependencies");
  await run("npm", ["install", "-g", "--prefix", paths.prefix, DSH_SPEC,
    DSH_MOCK_PACKAGE + "@" + DSH_VERSION, PNPM_SPEC, "--foreground-scripts",
    "--loglevel", "warn"], paths.workspace, env, { timeout: 300_000 });
  const dsh = binPath(paths.prefix, "dsh");
  assert.equal((await run(dsh, ["--version"], paths.workspace, env)).stdout.trim(), DSH_VERSION);
  const mockRoot = await packageRoot(paths.prefix, DSH_MOCK_PACKAGE);
  const mockModule = await import(pathToFileURL(join(mockRoot, "lib", "index.js")).href);
  llmServer = await mockModule.startMockLlmServer({
    sequence: [
      "tool_call_success", "reasoning_success",
      "slow_success", "success",
      "tool_call_success", "reasoning_success",
      "tool_call_success", "reasoning_success",
    ],
    repeatLast: true,
    apiKey: DEEPSEEK_KEY,
    successText: REPLY,
    reasoningText: REASONING,
    toolName: "skill",
    toolArguments: JSON.stringify({ name: "memorax-code" }),
  });
  memoraxServer = await startMemoraxMock();
  const port = await freePort();

  runtimeEnv = {
    ...env,
    MEMORAX_CODE_BACKEND_PORT: String(port),
    MEMORAX_CODE_DSH_COMMAND: dsh,
    MEMORAX_CODE_SKIP_CODEX_PLUGIN_INSTALL: "1",
    MEMORAX_CODE_SKIP_CLAUDE_ADAPTER_INSTALL: "1",
    MEMORAX_CODE_SKIP_OPENCODE_ADAPTER_INSTALL: "1",
    MEMORAX_CODE_MEMORAX_ENDPOINT: memoraxServer.baseUrl,
    MEMORAX_CODE_MEMORAX_API_KEY: MEMORAX_KEY,
    MEMORAX_CODE_MEMORAX_USER_ID: "memorax-dsh-e2e-user",
    MEMORAX_CODE_MEMORY_RETRIEVAL_ENABLED: "true",
    MEMORAX_CODE_MEMORY_WRITEBACK_ENABLED: "true",
    MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_ENABLED: "false",
    MEMORAX_CODE_MEMORY_WRITEBACK_CHUNK_ENABLED: "false",
    MEMORAX_CODE_MEMORY_OUTPUT_LANGUAGE: "en",
    MEMORAX_CODE_DSH_DEBUG: "1",
    [REPO_MEMORY_DISPATCH_LOG_ENV]: repoMemoryDispatchLog,
    DEEPSEEK_BASE_URL: llmServer.baseURL + "/v1",
    DEEPSEEK_API_KEY: DEEPSEEK_KEY,
    DSH_TELEMETRY_DISABLED: "1",
    DSH_PERMISSION_MODE: "danger-full-access",
  };

  progress("creating only the real DSH web Profile");
  await createProfile(dsh, "web", paths, runtimeEnv, false);
  const web = join(paths.dshHome, "profiles", "web");
  const webSentinel = join(web, "memorax-e2e-preserve.txt");
  await writeFile(webSentinel, "preserve web\n");
  const headless = join(paths.dshHome, "profiles", "headless");

  const tarball = await memoraxTarball(paths, runtimeEnv);
  progress("installing the MemoraX Code tarball with real npm lifecycle scripts");
  const installed = await run("npm", ["install", "-g", "--prefix", paths.prefix, tarball.path,
    "--foreground-scripts", "--loglevel", "warn"], paths.workspace, runtimeEnv,
  { timeout: 300_000 });
  const installOutput = installed.stdout + "\n" + installed.stderr;
  assert.match(installOutput, /Detected existing DeepSeek Harness profiles/);
  assert.match(installOutput, /DeepSeek Harness profiles: found \(web\)/);
  assert.match(installOutput, /Restart or refresh DeepSeek Harness/);
  assert.doesNotMatch(installOutput, /client adapters were skipped for this install/);

  const installedRoot = await packageRoot(paths.prefix, "@memorax/memorax-code");
  memoraxEntry = join(installedRoot, "bin", "memorax-code.mjs");
  const sourceRoot = join(installedRoot, "lib", "memorax-code-dsh-adapter");
  const statePath = join(paths.memoraxHome, "adapters", "dsh", "state.json");
  const generationsRoot = join(paths.memoraxHome, "adapters", "dsh", "runtime", "generations");
  const backendStatePath = join(paths.memoraxHome, "runtime", "backend", "backend.pid.json");
  const sessionsRoot = join(paths.dshHome, "sessions");
  const lifecycle = async (command, expectedExit = 0) => {
    const result = await run(process.execPath, [memoraxEntry, command, "--home",
      paths.memoraxHome, "--port", String(port), "--clients", "dsh", "--json"],
    paths.workspace, runtimeEnv, { expectedExit });
    return JSON.parse(result.stdout);
  };

  await assertProfile(headless, true);
  await assertProfile(web, true);
  const initialState = await readJson(statePath);
  assert.equal(initialState.enabled, true);
  assert.deepEqual(initialState.profiles, ["headless", "web"]);
  assert.equal(initialState.dshVersion, DSH_VERSION);
  assert.equal(resolve(initialState.adapterRoot), resolve(sourceRoot));
  assert.equal(isInside(initialState.runtimeBundleRoot, generationsRoot), true);
  assert.equal(await exists(join(initialState.runtimeBundleRoot,
    ".memorax-code-package.json")), true);
  assert.equal(await exists(join(sourceRoot, ".memorax-code-package.json")), false);
  assert.equal(await exists(join(sourceRoot, "runtime")), false);
  assert.equal(await exists(join(sourceRoot, "state.json")), false);
  const profilePackage = await realpath(join(headless, "node_modules",
    "@memorax-code", "dsh-memorax-code"));
  const profileMetadata = await readJson(join(profilePackage, ".memorax-code-package.json"));
  const sourceManifest = await readJson(join(sourceRoot, "package.json"));
  assert.deepEqual(
    [...(await snapshotFiles(profilePackage)).keys()].sort(),
    ["package.json", ...sourceManifest.files].sort(),
  );
  assert.equal(resolve(profileMetadata.runtimeBundleRoot),
    resolve(initialState.runtimeBundleRoot));
  const canonicalSkill = await readFile(join(installedRoot, "lib",
    "memorax-code-codex-adapter", "skills", "memorax-code", "SKILL.md"), "utf8");
  assert.equal(await readFile(join(sourceRoot, "skills", "memorax-code", "SKILL.md"), "utf8"),
    canonicalSkill);
  assert.equal(await readFile(join(profilePackage, "skills", "memorax-code", "SKILL.md"), "utf8"),
    canonicalSkill);
  assert.equal(await exists(join(profilePackage, "src", "profile-lifecycle.mjs")), false);
  await createProfile(dsh, "headless", paths, runtimeEnv, true);
  const headlessSentinel = join(headless, "memorax-e2e-preserve.txt");
  await writeFile(headlessSentinel, "preserve headless\n");

  const packagedRepoMemoryHelper = join(sourceRoot, "hooks", "repo-memory-job.mjs");
  const profileRepoMemoryHelper = join(profilePackage, "hooks", "repo-memory-job.mjs");
  const dryRun = JSON.parse((await run(process.execPath, [profileRepoMemoryHelper,
    "maintain", "--repo", paths.workspace, "--dry-run"], paths.workspace,
  { ...runtimeEnv, MEMORAX_CODE_HOME: ambientMemoraxHome })).stdout);
  assert.equal(dryRun.action, "build");
  assert.equal(dryRun.reason, "bundle_missing");
  assert.equal(dryRun.repo, await realpath(paths.workspace));
  assert.equal(dryRun.job?.dryRun, true);
  assert.equal(dryRun.job?.runner, "dsh");
  assert.equal(isInside(dryRun.job?.jobPath, paths.memoraxHome), true);
  assert.equal(await exists(join(ambientMemoraxHome, "repo-memory-jobs")), false);

  const status = await lifecycle("status");
  assert.equal(status.ok, true);
  assert.equal(status.dshAdapter?.enabled, true);
  assert.equal(status.dshAdapter?.integration, "plugin");
  backendPid = validPid((await readJson(backendStatePath)).pid);

  progress("running a real DSH Turn through Search, personal context, skill, Repo Memory, and Add");
  const firstLlmRequest = llmServer.requests.length;
  const repoMemoryHelperSource = await readFile(profileRepoMemoryHelper, "utf8");
  await writeFile(profileRepoMemoryHelper, repoMemoryDispatchRecorderSource(), "utf8");
  try {
    await runTurn(dsh, FIRST_PROMPT, paths.workspace, runtimeEnv);
    await waitFor(() => exists(repoMemoryDispatchLog), "first Repo Memory auto-build dispatch");
    await delay(200);
    assert.deepEqual(await readJsonLines(repoMemoryDispatchLog), [{
      args: ["maintain", "--repo", await realpath(paths.workspace)],
      cwd: await realpath(paths.workspace),
      memoraxCodeHome: paths.memoraxHome,
    }]);
  } finally {
    await writeFile(profileRepoMemoryHelper, repoMemoryHelperSource, "utf8");
  }
  await waitFor(() => requests("/v1/memories/add").length === 1, "first Add");
  assert.equal(requests("/v1/memories/search")[0]?.body?.query, FIRST_PROMPT);
  assertAdd(requests("/v1/memories/add")[0], FIRST_PROMPT);
  const firstLlmRequests = llmServer.requests.slice(firstLlmRequest);
  assert.ok(firstLlmRequests.length >= 2);
  const firstModelRequest = firstLlmRequests.find((request) =>
    JSON.stringify(request.body).includes(FIRST_PROMPT));
  assert.ok(firstModelRequest);
  assert.match(JSON.stringify(firstModelRequest.body), new RegExp(RECALL));
  assert.match(JSON.stringify(firstModelRequest.body), new RegExp(USER_PROFILE));
  assert.match(JSON.stringify(firstModelRequest.body), new RegExp(PROCEDURE_MEMORY));
  assert.match(JSON.stringify(firstModelRequest.body), new RegExp(MEMORY_REMINDER));
  assert.match(JSON.stringify(firstModelRequest.body), new RegExp(PERSONAL_MEMORY_REMINDER));
  const firstSessionEntry = [...(await snapshotFiles(sessionsRoot)).entries()]
    .find(([, content]) => content.includes(FIRST_PROMPT));
  assert.ok(firstSessionEntry);
  const [, firstSession] = firstSessionEntry;
  const firstSessionId = JSON.parse(firstSession.split("\n", 1)[0]).id;
  assert.ok(typeof firstSessionId === "string" && firstSessionId);
  assert.match(firstSession, new RegExp(RECALL));
  assert.match(firstSession, new RegExp(USER_PROFILE));
  assert.match(firstSession, new RegExp(PROCEDURE_MEMORY));
  assert.match(firstSession, new RegExp(MEMORY_REMINDER));
  assert.match(firstSession, new RegExp(PERSONAL_MEMORY_REMINDER));
  assert.match(firstSession, new RegExp(REASONING));
  assert.match(firstSession, /skill_content[^\n]*memorax-code/s);
  const firstTraceEventsPath = join(paths.memoraxHome, "debug", "traces", "dsh",
    "sessions", firstSessionId, "events.jsonl");
  await waitFor(async () => (
    await readFile(firstTraceEventsPath, "utf8").catch(() => "")
  ).includes('"skill_reminder"'), "first DSH reminder trace");
  const firstReminderEvents = (await readJsonLines(firstTraceEventsPath))
    .filter((event) => event.type === "skill_reminder");
  assert.equal(firstReminderEvents.length, 1);
  assert.equal(firstReminderEvents[0].source, "dsh-cordis");
  assert.equal(firstReminderEvents[0].trace?.context_origin, "dsh-cordis-reminder");
  assert.deepEqual(firstReminderEvents[0].request?.triggers, ["cadence"]);
  assert.match(JSON.stringify(firstReminderEvents[0].response), new RegExp(MEMORY_REMINDER));
  const repoMemoryHead = (await run("git", ["rev-parse", "HEAD"], paths.workspace,
    runtimeEnv)).stdout.trim();
  await writeValidRepoMemoryFixture(paths.workspace, repoMemoryHead);
  const repoMemoryValidation = JSON.parse((await run("python3", [
    join(profilePackage, "skills", "memorax-code", "scripts", "validate_memory.py"),
    paths.workspace,
  ], paths.workspace, runtimeEnv)).stdout);
  assert.equal(repoMemoryValidation.ok, true);

  progress("crashing and resuming one real DSH session to reconcile its interrupted Turn");
  const interruptedRunnerPath = join(headless, "memorax-interrupted-e2e-runner.mjs");
  const interruptedPatchPath = join(isolatedRoot, "memorax-interrupted-e2e.patch.yml");
  await writeFile(interruptedRunnerPath, interruptedRunnerSource(), "utf8");
  await writeFile(interruptedPatchPath, [
    "- id: headless-runner",
    "  disabled: true",
    "",
    "- insert:",
    "    - id: memorax-interrupted-e2e-runner",
    `      name: ${JSON.stringify(pathToFileURL(interruptedRunnerPath).href)}`,
    "",
  ].join("\n"), "utf8");
  const addsBeforeInterrupted = requests("/v1/memories/add").length;
  const runInterrupted = (mode, prompt) => run(dsh, [
    "--profile", "headless", "--patch", interruptedPatchPath, prompt,
  ], paths.workspace, { ...runtimeEnv, [INTERRUPTED_MODE_ENV]: mode }, {
    expectedExit: mode === "crash" ? null : 0,
  });
  const crashed = await runInterrupted("crash", CRASH_PROMPT);
  assert.equal(crashed.signal, "SIGKILL", `DSH did not crash as expected:\n${crashed.stderr}`);
  const crashSession = await sessionForPrompt(sessionsRoot, CRASH_PROMPT);
  assert.equal(crashSession.id, INTERRUPTED_SESSION_ID);
  const crashEvents = await readDshSessionEvents(crashSession.path);
  const crashTurn = turnForPrompt(crashEvents, CRASH_PROMPT);
  assert.equal(
    crashEvents.some((event) => event.type === "turn/end" && event.data?.turn === crashTurn),
    false,
    "the killed DSH process persisted a graceful Turn end",
  );

  await runInterrupted("resume", RESUME_PROMPT);
  await waitFor(
    () => requests("/v1/memories/add").length === addsBeforeInterrupted + 1,
    "resumed DSH Add",
  );
  const resumedSession = await sessionForPrompt(sessionsRoot, RESUME_PROMPT);
  assert.equal(resumedSession.id, crashSession.id);
  const resumedEvents = await readDshSessionEvents(resumedSession.path);
  const resumeTurn = turnForPrompt(resumedEvents, RESUME_PROMPT);
  assert.equal(
    resumedEvents.filter((event) => event.type === "turn/end"
      && event.data?.turn === crashTurn
      && event.data?.reason?.kind === "interrupted").length,
    1,
    "DSH did not durably repair the crashed Turn exactly once",
  );
  const interruptedAdds = requests("/v1/memories/add").slice(addsBeforeInterrupted);
  assert.equal(interruptedAdds.length, 1);
  assertAdd(interruptedAdds[0], RESUME_PROMPT);
  assert.doesNotMatch(JSON.stringify(interruptedAdds), new RegExp(CRASH_PROMPT));

  const interruptedTracePath = join(paths.memoraxHome, "debug", "traces", "dsh",
    "sessions", INTERRUPTED_SESSION_ID, "events.jsonl");
  await waitFor(async () => {
    const trace = await readFile(interruptedTracePath, "utf8").catch(() => "");
    return trace.includes('"native_outcome":"interrupted"')
      && trace.includes('"type":"memory_writeback"');
  }, "interrupted and resumed DSH Trace");
  const interruptedTrace = await readJsonLines(interruptedTracePath);
  const crashTrace = interruptedTrace.filter((event) => event.trace?.turn_id === String(crashTurn));
  const crashTurnEnds = crashTrace.filter((event) => event.type === "turn_end");
  assert.equal(crashTrace.filter((event) => event.type === "turn_start").length, 1);
  assert.equal(crashTurnEnds.length, 1);
  assert.equal(crashTurnEnds[0].outcome, "interrupted");
  assert.equal(crashTurnEnds[0].request?.native_outcome, "interrupted");
  assert.equal(crashTurnEnds[0].trace?.context_origin, "dsh-session-event-log");
  assert.equal(crashTrace.some((event) => event.type === "turn_materialized"), false);
  assert.equal(crashTrace.some((event) => event.type === "memory_writeback"), false);
  const resumeStartIndex = interruptedTrace.findIndex((event) => event.type === "turn_start"
    && event.trace?.turn_id === String(resumeTurn));
  assert.ok(interruptedTrace.indexOf(crashTurnEnds[0]) < resumeStartIndex,
    "interrupted reconciliation did not finish before resumed retrieval");

  progress("recovering a crashed Backend from the current DSH generation");
  const crashedPid = backendPid;
  process.kill(crashedPid, "SIGKILL");
  await waitFor(() => !alive(crashedPid), "crashed Backend exit");
  backendPid = undefined;
  await runTurn(dsh, RECOVERY_PROMPT, paths.workspace, runtimeEnv);
  await waitFor(() => requests("/v1/memories/add").length === 3, "recovery Add");
  const recoveredState = await readJson(statePath);
  assert.equal(resolve(recoveredState.runtimeBundleRoot),
    resolve(initialState.runtimeBundleRoot));
  backendPid = validPid((await readJson(backendStatePath)).pid);
  assert.notEqual(backendPid, crashedPid);
  assert.equal(requests("/v1/memories/search").at(-1)?.body?.query, RECOVERY_PROMPT);
  assertAdd(requests("/v1/memories/add").at(-1), RECOVERY_PROMPT);

  progress("reconciling a Profile created after installation");
  const auxiliary = join(paths.dshHome, "profiles", "auxiliary");
  await run(dsh, ["plugin", "--profile", "auxiliary", "--version"], paths.workspace, runtimeEnv);
  const auxiliarySentinel = join(auxiliary, "memorax-e2e-preserve.txt");
  await writeFile(auxiliarySentinel, "preserve auxiliary\n");
  const drift = await lifecycle("status", 1);
  assert.equal(drift.dshAdapter?.reason, "profile_drift");
  assert.equal((await lifecycle("start")).dshAdapter?.enabled, true);
  backendPid = validPid((await readJson(backendStatePath)).pid);
  await assertProfile(auxiliary, true);
  await assertProfile(headless, true);
  await assertProfile(web, true);
  assert.deepEqual((await readJson(statePath)).profiles, ["auxiliary", "headless", "web"]);

  progress("stopping and proving a DSH Turn cannot revive the Backend");
  const trafficBeforeStop = memoraxServer.requests.length;
  const pidBeforeStop = backendPid;
  assert.equal((await lifecycle("stop")).ok, true);
  await waitFor(() => !alive(pidBeforeStop), "stopped Backend exit");
  backendPid = undefined;
  assert.equal((await readJson(statePath)).enabled, false);
  await assertProfile(auxiliary, false);
  await assertProfile(headless, false);
  await assertProfile(web, false);
  await runTurn(dsh, STOPPED_PROMPT, paths.workspace, runtimeEnv);
  await delay(300);
  assert.equal(memoraxServer.requests.length, trafficBeforeStop);
  assert.equal(await exists(backendStatePath), false);

  const sessions = await snapshotFiles(sessionsRoot);
  assert.ok(sessions.size >= 4, "expected persisted sessions from the DSH E2E Turns");
  progress("uninstalling while preserving DSH Profiles and sessions");
  assert.equal((await lifecycle("uninstall")).ok, true);
  memoraxEntry = undefined;
  assert.equal(await exists(installedRoot), false);
  assert.equal(await exists(statePath), false);
  assert.equal(await exists(generationsRoot), false);
  await assertProfile(auxiliary, false);
  await assertProfile(headless, false);
  await assertProfile(web, false);
  assert.equal(await exists(join(auxiliary, "node_modules", "@memorax-code", "dsh-memorax-code")), false);
  assert.equal(await exists(join(headless, "node_modules", "@memorax-code", "dsh-memorax-code")), false);
  assert.equal(await exists(join(web, "node_modules", "@memorax-code", "dsh-memorax-code")), false);
  assert.equal(await readFile(auxiliarySentinel, "utf8"), "preserve auxiliary\n");
  assert.equal(await readFile(headlessSentinel, "utf8"), "preserve headless\n");
  assert.equal(await readFile(webSentinel, "utf8"), "preserve web\n");
  assert.deepEqual(await snapshotFiles(sessionsRoot), sessions);

  process.stdout.write(JSON.stringify({
    ok: true,
    dshVersion: DSH_VERSION,
    memoraxPackageSource: tarball.source,
    searches: requests("/v1/memories/search").length,
    adds: requests("/v1/memories/add").length,
    firstTurnCanonicalSkillRoundTrip: true,
    firstTurnNativeSkillReminder: true,
    firstTurnPersonalContext: true,
    repoMemoryAutoBuildDispatchedOnce: true,
    repoMemoryRuntimeHomeCanonical: true,
    interruptedTurnRecovered: true,
    backendCrashRecoveredCurrentGeneration: true,
    laterProfileReconciled: true,
    uninstallPreservedProfilesAndSessions: true,
  }, null, 2) + "\n");
}

async function createProfile(dsh, name, paths, env, persistent) {
  await run(dsh, ["--profile", name, "--dump-default-config"], paths.workspace, env);
  if (!persistent) return;
  await writeFile(join(paths.dshHome, "profiles", name, "cordis.patch.yml"), [
    "- id: session-title-llm",
    "  disabled: true",
    "",
    "- id: session-persistence-jsonl",
    "  config:",
    "    root: !!js dshHomePath('sessions')",
    "    compression: none",
    "    packChunks: false",
    "",
  ].join("\n"));
}

async function memoraxTarball(paths, env) {
  if (process.env[TARBALL_ENV]) {
    return { path: await realpath(resolve(process.env[TARBALL_ENV])), source: "provided" };
  }
  stageRoot = join(repoRoot, "dist", "dsh-e2e-" + process.pid + "-" + Date.now());
  await run(join(repoRoot, "scripts", "build-npm-packages.sh"),
    [relative(repoRoot, stageRoot)], repoRoot, env, { timeout: 300_000 });
  const packed = await run("npm", ["pack", join(stageRoot, "memorax-code"),
    "--pack-destination", paths.tarballs, "--json"], paths.workspace, env,
  { timeout: 300_000 });
  const report = JSON.parse(packed.stdout);
  assert.equal(report.length, 1);
  return { path: join(paths.tarballs, report[0].filename), source: "checkout" };
}

async function runTurn(dsh, prompt, cwd, env) {
  const result = await run(dsh, ["--profile", "headless", prompt], cwd, env);
  assert.match(result.stdout, new RegExp(REPLY));
}

function assertAdd(request, prompt) {
  assert.equal(request?.authorization, "Token " + MEMORAX_KEY);
  assert.deepEqual(request?.body?.messages?.map((message) => [
    message.role, message.content,
  ]), [["user", prompt], ["assistant", REPLY]]);
  const serialized = JSON.stringify(request.body);
  assert.doesNotMatch(serialized, new RegExp(RECALL));
  assert.doesNotMatch(serialized, new RegExp(USER_PROFILE));
  assert.doesNotMatch(serialized, new RegExp(PROCEDURE_MEMORY));
  assert.doesNotMatch(serialized, /MemoraX Code reminder:/);
  assert.doesNotMatch(serialized, /MemoraX Code personal-memory reminder:/);
  assert.doesNotMatch(serialized, new RegExp(REASONING));
  assert.doesNotMatch(serialized, /skill_content/);
}

async function writePersonalContextFixtures(workspace) {
  const profileRoot = join(workspace, ".repo_memory", "user-profile");
  const procedureRoot = join(workspace, ".repo_memory", "procedure-memory");
  await Promise.all([
    mkdir(profileRoot, { recursive: true }),
    mkdir(procedureRoot, { recursive: true }),
  ]);
  await writeFile(join(profileRoot, "preferences.md"), [
    "---",
    'schema: "repo_user_profile_memory.v0.1"',
    'scope: "repo"',
    'owner: "repo-user-profile-memory"',
    'trust_state: "user_stated"',
    'updated_at: "2026-08-16T00:00:00.000Z"',
    "active_count: 1",
    "total_count: 1",
    "---",
    "",
    "# Repo-Scoped User Profile And Preferences",
    "",
    "## Active Preferences",
    "",
    "## Preference pref_dsh_e2e",
    "",
    "- Type: `workflow`",
    "- Status: `active`",
    "- Confidence: `user_stated`",
    "- Created: `2026-08-16T00:00:00.000Z`",
    "- Updated: `2026-08-16T00:00:00.000Z`",
    `- Description: Apply ${USER_PROFILE} during this DSH E2E.`,
    "- Applies when: Running the isolated DSH E2E.",
    "- Do not apply when: Outside this isolated fixture.",
    "- Raw lookup: `preferenceId=pref_dsh_e2e`",
    "",
  ].join("\n"));
  await writeFile(join(procedureRoot, "dsh-e2e.md"), [
    "# DSH E2E Procedure",
    "",
    `Use ${PROCEDURE_MEMORY} only as an injected-context marker.`,
    "",
  ].join("\n"));
}

function repoMemoryDispatchRecorderSource() {
  return [
    'import { appendFileSync } from "node:fs";',
    `const logPath = process.env[${JSON.stringify(REPO_MEMORY_DISPATCH_LOG_ENV)}];`,
    'if (!logPath) throw new Error("missing DSH E2E Repo Memory dispatch log");',
    "appendFileSync(logPath, JSON.stringify({",
    "  args: process.argv.slice(2),",
    "  cwd: process.cwd(),",
    "  memoraxCodeHome: process.env.MEMORAX_CODE_HOME,",
    '}) + "\\n");',
    "",
  ].join("\n");
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
      "# Isolated DSH E2E Repo Memory",
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

function interruptedRunnerSource() {
  return [
    'import { installModelSelection } from "@deepseek-ai/dsh-agent";',
    'import { createUserMessage } from "@deepseek-ai/dsh-llm";',
    'import { SessionId } from "@deepseek-ai/dsh-session";',
    "",
    'export const name = "memorax-interrupted-e2e-runner";',
    'export const inject = ["agentDefaultModel", "agents", "headlessStartup", "sessions"];',
    "",
    "export function apply(ctx) {",
    "  void run(ctx).catch((error) => {",
    '    process.stderr.write(`memorax interrupted E2E runner: ${error instanceof Error ? error.message : String(error)}\\n`);',
    '    ctx.get("appExit")?.(1);',
    "  });",
    "}",
    "",
    "async function run(ctx) {",
    '  await ctx.get("loader")?.await();',
    '  const agents = ctx.get("agents");',
    '  const defaultModel = ctx.get("agentDefaultModel");',
    '  const prompt = ctx.get("headlessStartup")?.task;',
    '  const sessions = ctx.get("sessions");',
    "  if (!agents || !defaultModel || !sessions) return;",
    `  const mode = process.env[${JSON.stringify(INTERRUPTED_MODE_ENV)}];`,
    `  const sessionId = ${JSON.stringify(INTERRUPTED_SESSION_ID)};`,
    '  if ((mode !== "crash" && mode !== "resume") || !prompt) {',
    '    throw new Error("missing interrupted E2E mode or prompt");',
    "  }",
    "  let crashStarted = false;",
    '  ctx.on("session/event", (session, event) => {',
    '    if (mode !== "crash" || crashStarted || session.id !== sessionId || event.type !== "assistant/chunk") return;',
    "    crashStarted = true;",
    '    void sessions.flush(session).then(() => process.kill(process.pid, "SIGKILL"), (error) => {',
    '      process.stderr.write(`memorax interrupted E2E flush: ${error instanceof Error ? error.message : String(error)}\\n`);',
    "      process.exit(1);",
    "    });",
    "  });",
    "  const selection = defaultModel.currentSelection();",
    "  const setup = (agentCtx) => {",
    "    installModelSelection(agentCtx, { current: selection, assembled: undefined });",
    "  };",
    "  const shared = {",
    "    agentOptions: { provider: selection.provider, model: selection.model },",
    "    setup,",
    "  };",
    '  const { agent } = mode === "resume"',
    "    ? await agents.resume({ resumeSessionId: SessionId(sessionId), ...shared })",
    "    : await agents.create({ sessionId: SessionId(sessionId), meta: { cwd: process.cwd() }, ...shared });",
    "  await agent.whenIdle();",
    "  agent.followup(createUserMessage({",
    '    content: [{ type: "text", text: prompt }],',
    '    source: { kind: "user" },',
    "  }));",
    "  await agent.whenIdle();",
    "  await sessions.flush(agent.session);",
    '  if (mode === "resume") ctx.get("appExit")?.(0);',
    "}",
    "",
  ].join("\n");
}

async function readJsonLines(path) {
  return (await readFile(path, "utf8"))
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function sessionForPrompt(sessionsRoot, prompt) {
  await waitFor(async () => [...(await snapshotFiles(sessionsRoot)).values()]
    .some((content) => content.includes(prompt)), `persisted session for ${prompt}`);
  for (const [relativePath, content] of await snapshotFiles(sessionsRoot)) {
    if (!relativePath.endsWith(".jsonl") || !content.includes(prompt)) continue;
    const header = JSON.parse(content.split("\n", 1)[0]);
    assert.ok(typeof header.id === "string" && header.id, "DSH session id is missing");
    return { id: header.id, path: join(sessionsRoot, relativePath), content };
  }
  throw new Error(`No persisted DSH session contains ${prompt}`);
}

async function readDshSessionEvents(path) {
  return (await readJsonLines(path)).slice(1);
}

function turnForPrompt(events, prompt) {
  const promptIndex = events.findIndex((event) => event.type === "user/message"
    && event.data?.source?.kind === "user"
    && JSON.stringify(event.data).includes(prompt));
  assert.notEqual(promptIndex, -1, `No DSH user/message contains ${prompt}`);
  for (let index = promptIndex; index >= 0; index -= 1) {
    const turn = events[index]?.type === "turn/start" ? events[index].data?.turn : undefined;
    if (Number.isSafeInteger(turn) && turn > 0) return turn;
  }
  assert.fail(`No DSH turn/start precedes ${prompt}`);
}

async function assertProfile(root, integrated) {
  const manifest = await readJson(join(root, "package.json"));
  assert.equal(Object.hasOwn(manifest.dependencies || {}, "@memorax-code/dsh-memorax-code"),
    integrated);
  assert.equal(Boolean(manifest.dsh?.profile?.bundles?.includes(
    "@memorax-code/dsh-memorax-code")), integrated);
}

async function startMemoraxMock() {
  const recorded = [];
  const server = createHttpServer((request, response) => {
    void handle(request, response).catch((error) => {
      sendJson(response, 500, { success: false, error: String(error) });
    });
  });
  async function handle(request, response) {
    const body = await requestBody(request);
    recorded.push({ path: request.url, authorization: request.headers.authorization, body });
    if (request.headers.authorization !== "Token " + MEMORAX_KEY) {
      sendJson(response, 401, { success: false });
    } else if (request.method === "POST" && request.url === "/v1/memories/search") {
      sendJson(response, 200, {
        success: true,
        data: { task_id: "search", status: "completed", data: [{
          id: "memory", memory: RECALL, score: 1, metadata: { memory_type: "core" },
        }] },
      });
    } else if (request.method === "POST" && request.url === "/v1/memories/add") {
      sendJson(response, 202, {
        success: true, data: { task_id: "add", status: "accepted", data: null },
      });
    } else {
      sendJson(response, 404, { success: false });
    }
  }
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    baseUrl: "http://127.0.0.1:" + address.port,
    requests: recorded,
    close: () => new Promise((resolveClose) => {
      server.close(resolveClose);
      server.closeAllConnections();
    }),
  };
}

function sendJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
}

function requests(path) {
  return memoraxServer.requests.filter((request) => request.path === path);
}

async function packageRoot(prefix, packageName) {
  const parts = packageName.split("/");
  for (const root of [
    join(prefix, "lib", "node_modules", ...parts),
    join(prefix, "node_modules", ...parts),
  ]) {
    if (await exists(join(root, "package.json"))) return root;
  }
  throw new Error("Package was not installed: " + packageName);
}

function npmBin(prefix) {
  return process.platform === "win32" ? prefix : join(prefix, "bin");
}

function binPath(prefix, name) {
  return join(npmBin(prefix), process.platform === "win32" ? name + ".cmd" : name);
}

async function freePort() {
  const server = createNetServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise((resolveClose) => server.close(resolveClose));
  return address.port;
}

async function run(command, args, cwd, env, options = {}) {
  const child = spawn(command, args, {
    cwd,
    env: { ...env, PWD: cwd },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, options.timeout || 120_000);
  const result = await new Promise((resolveChild, rejectChild) => {
    child.once("error", rejectChild);
    child.once("close", (code, signal) => resolveChild({ code, signal }));
  }).finally(() => clearTimeout(timer));
  const expected = Object.hasOwn(options, "expectedExit") ? options.expectedExit : 0;
  if (timedOut || (expected !== null && result.code !== expected)) {
    throw new Error([
      basename(command) + " exited " + (timedOut ? "after timeout" :
        result.code ?? result.signal),
      stdout.trim() && "stdout:\n" + stdout.slice(-8000),
      stderr.trim() && "stderr:\n" + stderr.slice(-8000),
    ].filter(Boolean).join("\n"));
  }
  return { ...result, stdout, stderr };
}

async function waitFor(predicate, label) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(25);
  }
  throw new Error("Timed out waiting for " + label);
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function validPid(value) {
  assert.ok(Number.isSafeInteger(value) && value > 0, "Invalid Backend PID");
  return value;
}

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function snapshotFiles(root) {
  const snapshot = new Map();
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) snapshot.set(relative(root, path), await readFile(path, "utf8"));
    }
  }
  await visit(root);
  return snapshot;
}

function isInside(path, parent) {
  const child = relative(resolve(parent), resolve(path));
  return child && child !== ".." && !child.startsWith(".." + sep);
}

function cleanEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("MEMORAX_CODE_") || key.startsWith("DSH_") ||
      key.startsWith("DEEPSEEK_") || key.startsWith("NPM_CONFIG_") ||
      ["CODEX_HOME", "CLAUDE_HOME", "CLAUDE_CONFIG_DIR",
        "OPENCODE_CONFIG_DIR"].includes(key)) delete env[key];
  }
  return env;
}

async function exists(path) {
  return stat(path).then(() => true, () => false);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function progress(message) {
  process.stderr.write("[dsh-npm-e2e] " + message + "\n");
}

async function cleanup() {
  if (memoraxEntry && runtimeEnv && await exists(memoraxEntry)) {
    await run(process.execPath, [memoraxEntry, "stop", "--home",
      runtimeEnv.MEMORAX_CODE_HOME, "--clients", "dsh", "--json"],
    repoRoot, runtimeEnv, { timeout: 30_000 }).catch(() => undefined);
  }
  if (alive(backendPid)) process.kill(backendPid, "SIGKILL");
  await Promise.allSettled([llmServer?.close?.(), memoraxServer?.close?.()]);
  if (stageRoot) await rm(stageRoot, { recursive: true, force: true });
  if (isolatedRoot) await rm(isolatedRoot, { recursive: true, force: true });
}
