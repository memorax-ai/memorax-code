#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { createServer as createTcpServer } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { assertBackendReplacement, assertCredentialNotEchoed, assertSetupInputRejection,
  snapshotProtectedConfiguration, assertProtectedConfiguration } from "./codex-lifecycle-assertions.mjs";
import { stopNativeProcessTree } from "./opencode-native-support.mjs";

const execFileAsync = promisify(execFile);
const pluginName = "memorax-code-opencode-adapter";
const otherClients = ["codex", "claude", "dsh", "codebuddy", "workbuddy", "trae", "cursor"];
const fixtureKey = `sk_${"E".repeat(43)}`;
const fixtureUser = "lifecycle-saved-account";
const searchFixture = "LIFECYCLE_SAVED_ACCOUNT_SEARCH_RESULT";
const report = { status: "FAIL", platform: process.platform, arch: process.arch, checks: [] };
const cleanupCodes = {
  entrypoint_check: "CLEANUP_ENTRYPOINT_CHECK_FAILED",
  pid_record_read: "CLEANUP_PID_RECORD_READ_FAILED",
  stop_command: "CLEANUP_STOP_COMMAND_FAILED",
  stop_response: "CLEANUP_STOP_RESPONSE_FAILED",
  pid_record_removal: "CLEANUP_PID_RECORD_REMAINS",
  tracked_process: "CLEANUP_TRACKED_PROCESS_CHECK_FAILED",
  port_release: "CLEANUP_PORT_RELEASE_FAILED",
  command_process: "CLEANUP_COMMAND_PROCESS_REMAINS",
  directory_removal: "CLEANUP_DIRECTORY_REMOVAL_FAILED",
};
let cleanupStage = "entrypoint_check";
let cleanupTrackedPidIndex;
let stage = "prerequisites";
let root, env, workspace, entrypoint, stateHome, openCodeConfigDir, backendPort, endpoint, registry, savedEndpoint;
let resolveInvocation, resolveNpmInvocation;
let setupStarted = false;
let requests = 0;
let allowSearch = false;
const memoryRequests = [];
const endpointErrors = [];
const backendPids = new Set();
const commandPids = new Set();
const activeCommands = new Set();
let commandCleanupVerified = true;
let cleanupPromise, receivedSignal;
let npmCommand, npmPrefix, candidateTarball, ptyPackage, ptyScript;
let expectedPackageVersion, sourceRoot, parse;
let originalProvider;
const preservedMemory = new Map();
const signalHandlers = new Map(["SIGINT", "SIGTERM"].map((signal) => [signal, () => handleSignal(signal)]));
for (const [signal, handler] of signalHandlers) process.on(signal, handler);

try {
  check(["darwin", "linux", "win32"].includes(process.platform), "This smoke test requires macOS, Linux or Windows");
  check(process.argv.length === 10, "Usage: opencode-install-smoke.mjs INSTALLED_PACKAGE_ROOT OPENCODE_CLI_PATH CANDIDATE_TARBALL NPM_CLI_PATH PREVIOUS_VERSION PTY_PACKAGE_ROOT PTY_SCRIPT_PATH OPENCODE_VERSION");
  const packageRoot = resolve(process.argv[2]);
  const openCodeCommand = resolve(process.argv[3]);
  entrypoint = join(packageRoot, "bin", "memorax-code.mjs");
  candidateTarball = resolve(process.argv[4]);
  npmCommand = resolve(process.argv[5]);
  const previousVersion = process.argv[6];
  ptyPackage = resolve(process.argv[7]);
  ptyScript = resolve(process.argv[8]);
  const expectedOpenCodeVersion = process.argv[9];
  check(/^\d+\.\d+\.\d+$/.test(expectedOpenCodeVersion), "Expected OpenCode version must be exact");
  check(/^\d+\.\d+\.\d+$/.test(previousVersion), "Previous package version must be exact");
  npmPrefix = resolve(packageRoot, process.platform === "win32" ? "../../.." : "../../../..");
  check(await readFile(join(npmPrefix, ".memorax-code-ci-owned"), "utf8") === "opencode-install-check\n",
    "Refusing npm lifecycle mutations outside the wrapper-owned prefix");
  ({ resolveWindowsCliInvocation: resolveInvocation } = await import(
    pathToFileURL(join(packageRoot, "lib", "windows-cli-invocation.mjs")).href));
  ({ resolveNpmInvocation } = await import(
    pathToFileURL(join(packageRoot, "lib", "npm-invocation.mjs")).href));
  const manifest = await readJson(join(packageRoot, "package.json"));
  check(manifest.name === "@memorax/memorax-code", "The installed package has an unexpected identity");
  sourceRoot = join(packageRoot, "lib", pluginName);
  ({ parse } = createRequire(join(packageRoot, "package.json"))("smol-toml"));
  expectedPackageVersion = manifest.version;
  check(previousVersion !== manifest.version, "Upgrade requires a different previous package version");
  report.packageVersion = manifest.version;

  root = await mkdtemp(join(tmpdir(), "memorax-code-opencode-install-"));
  check(fixtureUser !== userInfo().username, "The saved account fixture must differ from the actual system username");
  const userHome = join(root, "user home 测试");
  workspace = join(root, "workspace 测试");
  stateHome = join(userHome, ".memorax-code");
  openCodeConfigDir = join(userHome, ".config", "opencode");
  await Promise.all([workspace, stateHome, openCodeConfigDir, join(root, "tmp")].map((path) => mkdir(path, { recursive: true })));
  backendPort = await freePort();
  endpoint = createServer(async (request, response) => {
    if (!allowSearch) {
      requests += 1;
      response.writeHead(503).end();
      return;
    }
    try {
      let raw = "";
      for await (const chunk of request) {
        raw += chunk;
        check(raw.length <= 32_768, "Explicit Search request exceeded the fixture size limit");
      }
      memoryRequests.push({ method: request.method, path: request.url,
        authorization: request.headers.authorization, body: JSON.parse(raw) });
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ success: true,
        data: { task_id: "lifecycle-search", status: "completed", data: [{ id: "saved-account-fixture",
          memory: searchFixture, score: 0.95, metadata: { memory_type: "procedural" } }] } }));
    } catch {
      endpointErrors.push("INVALID_EXPLICIT_SEARCH_REQUEST");
      response.writeHead(400).end();
    }
  });
  await new Promise((done, reject) => { endpoint.once("error", reject); endpoint.listen(0, "127.0.0.1", done); });
  const dummyUrl = `http://127.0.0.1:${endpoint.address().port}`;
  savedEndpoint = `${dummyUrl}/saved-account`;
  env = isolatedEnv(userHome, openCodeCommand);
  await writeFile(join(stateHome, "config.toml"), ["[clients]", "opencode = true",
    ...otherClients.map((client) => `${client} = false`), "[memory.writeback]", "enabled = false",
    "[jev]", "enabled = false", ""].join("\n"), { mode: 0o600 });
  originalProvider = JSON.stringify({
    formatter: false, lsp: false, share: "disabled", autoupdate: false,
    model: "install-smoke/lifecycle-fixture", small_model: "install-smoke/lifecycle-fixture",
    enabled_providers: ["install-smoke"],
    provider: { "install-smoke": {
      name: "Install smoke", env: [], npm: "@ai-sdk/openai-compatible",
      models: { "lifecycle-fixture": { name: "Lifecycle fixture", tool_call: true,
        limit: { context: 100_000, output: 10_000 } } },
      options: { baseURL: `${dummyUrl}/v1`, apiKey: "lifecycle-model-fixture" },
    } },
  }, null, 2);
  await writeFile(join(openCodeConfigDir, "opencode.json"), originalProvider, { mode: 0o600 });
  const version = await run(openCodeCommand, ["--version"]);
  const actualOpenCodeVersion = /^(\d+\.\d+\.\d+)$/.exec(version.stdout.trim())?.[1];
  report.expectedOpenCodeVersion = expectedOpenCodeVersion;
  report.openCodeVersion = actualOpenCodeVersion ?? "unrecognized";
  check(actualOpenCodeVersion === expectedOpenCodeVersion, "The installed OpenCode CLI version differs from the selected version");
  report.checks.push("installed package and real OpenCode CLI available");

  const initialConfig = await readFile(join(stateHome, "config.toml"), "utf8");
  const initialOpenCodeConfig = await readFile(join(openCodeConfigDir, "opencode.json"), "utf8");
  const prepareScenarioHome = async (name) => {
    const scenarioHome = join(root, name);
    stateHome = join(scenarioHome, ".memorax-code");
    openCodeConfigDir = join(scenarioHome, ".config", "opencode");
    env = isolatedEnv(scenarioHome, openCodeCommand);
    await Promise.all([stateHome, openCodeConfigDir].map((path) => mkdir(path, { recursive: true })));
    await writeFile(join(stateHome, "config.toml"), initialConfig, { mode: 0o600 });
    await writeFile(join(openCodeConfigDir, "opencode.json"), initialOpenCodeConfig, { mode: 0o600 });
  };
  setupStarted = true;
  for (const [label, input] of [["empty stdin", ""], ["multiple stdin values", "invalid\nsecond\n"]]) {
    stage = `rejected setup: ${label}`;
    const rejected = await rejectedProduct(["setup", "--existing-account", "--non-interactive"], input);
    assertSetupInputRejection(rejected);
    check(await readFile(join(stateHome, "config.toml"), "utf8") === initialConfig
      && await readFile(join(openCodeConfigDir, "opencode.json"), "utf8") === initialOpenCodeConfig,
    "Rejected setup changed existing configuration");
    check(!(await exists(completionPath())) && !(await exists(pidPath())), "Rejected setup created completion or Backend state");
  }
  report.checks.push("empty and multiline stdin returned the expected input diagnostic and exit 2 before any state mutation");

  stage = "interactive setup cancellation";
  const cancelled = await terminalSetup("cancel");
  check(cancelled.status === "PASS" && cancelled.usernamePromptSeen && cancelled.keyPromptSeen,
    "Interactive cancellation did not reach the expected native prompts");
  check(!(await exists(completionPath())) && !(await exists(pidPath())), "Cancelled setup created completion or Backend state");
  const cancelledConfig = await readFile(join(stateHome, "config.toml"), "utf8");
  check(!cancelledConfig.includes(fixtureKey) && JSON.stringify(parse(cancelledConfig).clients) === JSON.stringify(parse(initialConfig).clients),
    "Cancelled setup stored the key or changed the client choices");
  check(await readFile(join(openCodeConfigDir, "opencode.json"), "utf8") === initialOpenCodeConfig,
    "Cancelled setup changed OpenCode provider configuration");
  await verifyIntegrationAbsent("Cancelled setup installed OpenCode integration files");
  report.checks.push("real terminal setup cancelled at the masked-key prompt without completing or installing the plugin");

  // Failure recovery has its own home so it cannot prepare the fresh-install case.
  await prepareScenarioHome("failed setup user 测试");
  stage = "failed setup with occupied Backend port";
  const occupied = createServer((_request, response) => response.writeHead(503).end());
  await new Promise((done, reject) => { occupied.once("error", reject); occupied.listen(backendPort, "127.0.0.1", done); });
  try {
    env.MEMORAX_CODE_MEMORAX_ENDPOINT = savedEndpoint;
    const failure = await rejectedProduct(["setup", "--existing-account", "--non-interactive"], `${fixtureKey}\n`);
    report.setupFailureCode = failure.diagnosticCode ?? "NO_DIAGNOSTIC_CODE";
    check(["BACKEND_EXITED_BEFORE_READY", "BACKEND_HEALTH_NOT_READY"].includes(failure.diagnosticCode),
      "Occupied-port setup failed for an unexpected reason");
    check(!(await exists(completionPath())), "Failed Backend startup was recorded as completed setup");
  } finally {
    delete env.MEMORAX_CODE_MEMORAX_ENDPOINT;
    occupied.closeAllConnections();
    await new Promise((done) => occupied.close(done));
  }
  report.checks.push("occupied Backend port fails setup without recording completion");

  stage = "failed setup recovery";
  await terminalSetup("reuse");
  await verifyReady("occupied-port recovery", userInfo().username);
  await stopAndVerify();

  await prepareScenarioHome("fresh install user 测试");
  check(!(await exists(completionPath())) && !(await exists(pidPath())), "Fresh installation inherited lifecycle state");
  await verifyIntegrationAbsent("Fresh installation inherited OpenCode integration files");
  for (const attempt of ["fresh", "repeat"]) {
    stage = `${attempt} setup`;
    if (attempt === "fresh") {
      const interactive = await terminalSetup("complete");
      check(interactive.status === "PASS" && interactive.usernamePromptSeen && interactive.keyPromptSeen && interactive.credentialNotEchoed,
        "Interactive setup did not complete its native masked-key prompts");
    } else {
      await terminalSetup("reuse");
    }
    await verifyReady(attempt);
  }
  for (const [path, contents] of [
    [join(stateHome, "personal-memory", "user-profile", "preferences.md"), "Synthetic installation preservation fixture.\n"],
    [join(stateHome, "personal-memory", "procedure-memory", "install-smoke.md"), "Synthetic procedure preservation fixture.\n"],
  ]) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents, { mode: 0o600 });
    preservedMemory.set(path, contents);
  }
  const savedMemoraxConfig = await readFile(join(stateHome, "config.toml"), "utf8");
  const savedCompletion = await readFile(completionPath(), "utf8");
  stage = "stop and start";
  await stopAndVerify();
  check(await readFile(completionPath(), "utf8") === savedCompletion, "Stop changed setup completion");
  check((await productJson(["start", "--clients", "opencode", "--json"])).ok === true, "Start failed after stop");
  await verifyReady("stop/start");
  await verifyPreserved(savedMemoraxConfig);

  stage = "native uninstall";
  env.npm_config_prefix = npmPrefix;
  const uninstalled = await productJson(["uninstall", "--clients", "opencode", "--json"]);
  check(uninstalled.ok === true && uninstalled.opencodeAdapter?.pluginRemove?.ok === true
    && uninstalled.npmPackageRemoval?.ok === true && uninstalled.npmPackageRemoval.skipped !== true,
  "Uninstall did not remove the native plugin and isolated npm package");
  check(!(await exists(entrypoint)) && !(await exists(completionPath())), "Uninstall retained package entrypoint or completion");
  await assertStopped();
  await verifyIntegrationAbsent("OpenCode integration files remain after uninstall");
  await verifyPreserved(savedMemoraxConfig);
  report.checks.push("native plugin and global npm package removed; provider, configuration and synthetic personal memory retained");

  stage = "npm reinstall";
  await npmInstall(candidateTarball);
  const reused = await terminalSetup("reuse");
  check(reused.status === "PASS" && reused.accountInputSent === false,
    "Ordinary reinstall did not restore the saved account without account input");
  await verifyReady("reinstall");
  await verifyPreserved(savedMemoraxConfig);
  await verifySavedAccountSearch("reinstall");
  report.checks.push("ordinary setup after native uninstall and npm reinstall restored the saved account without account input");
  await stopAndVerify();

  // A second isolated home starts with the real previous published package.
  // Serve only the candidate package from an isolated scoped npm registry so
  // the real public updater selects this PR artifact instead of a public release.
  stage = "previous published version install";
  await prepareScenarioHome("upgrade user 测试");
  preservedMemory.clear();
  await npmInstall(`@memorax/memorax-code@${previousVersion}`);
  check((await readJson(join(packageRoot, "package.json"))).version === previousVersion, "Previous version was not installed");
  await terminalSetup("complete");
  const previousStatus = await productJson(["status", "--clients", "opencode", "--json"]);
  check(previousStatus.ok === true && previousStatus.backend?.ok === true && previousStatus.opencodeAdapter?.ok === true,
    "Previous published version did not start successfully");
  await rememberPid();
  check((await readJson(completionPath())).completedByVersion === previousVersion,
    "Previous version did not record its own successful setup");
  const upgradeConfig = await readFile(join(stateHome, "config.toml"), "utf8");
  const upgradeMemory = join(stateHome, "personal-memory", "user-profile", "preferences.md");
  await mkdir(dirname(upgradeMemory), { recursive: true });
  await writeFile(upgradeMemory, "Synthetic previous-version memory fixture.\n", { mode: 0o600 });
  preservedMemory.set(upgradeMemory, "Synthetic previous-version memory fixture.\n");

  stage = "live public update";
  const artifact = await readFile(candidateTarball);
  let servedArtifact = artifact;
  let servedManifest = manifest;
  const registryRequests = { manifest: 0, artifact: 0, rejectedArtifact: 0 };
  let rejectDownload = true;
  let registryUrl;
  registry = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    if (path === "/@memorax/memorax-code") {
      registryRequests.manifest += 1;
      const version = { ...servedManifest, dist: { tarball: `${registryUrl}/candidate.tgz`,
        shasum: createHash("sha1").update(servedArtifact).digest("hex") } };
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        name: manifest.name, "dist-tags": { latest: manifest.version }, versions: { [manifest.version]: version },
      }));
    } else if (path === "/candidate.tgz") {
      if (rejectDownload) {
        registryRequests.rejectedArtifact += 1;
        response.writeHead(503).end();
        return;
      }
      registryRequests.artifact += 1;
      response.writeHead(200, { "content-type": "application/octet-stream" }).end(servedArtifact);
    } else {
      response.writeHead(404).end();
    }
  });
  await new Promise((done, reject) => { registry.once("error", reject); registry.listen(0, "127.0.0.1", done); });
  registryUrl = `http://127.0.0.1:${registry.address().port}`;
  const npmConfig = join(root, "upgrade.npmrc");
  await writeFile(npmConfig, `@memorax:registry=${registryUrl}\n`, { mode: 0o600 });
  env.npm_config_userconfig = npmConfig;
  env.npm_config_cache = join(root, "update npm cache");
  env.npm_config_fetch_retries = "0";
  env.npm_config_fetch_timeout = "15000";
  const previousBackend = await readJson(pidPath());
  const previousCompletion = await readFile(completionPath(), "utf8");
  stage = "failed update artifact download";
  await rejectedProduct(["update", "--latest"]);
  check(registryRequests.rejectedArtifact > 0, "The failed updater did not reach the rejected artifact download");
  check((await readJson(join(packageRoot, "package.json"))).version === previousVersion,
    "A failed artifact download changed the installed package version");
  check((await productJson(["status", "--clients", "opencode", "--json"])).backend?.ok === true
    && (await readJson(pidPath())).pid === previousBackend.pid,
  "A failed artifact download stopped or replaced the previous Backend");
  check(await readFile(completionPath(), "utf8") === previousCompletion,
    "A failed artifact download changed setup completion");
  await verifyPreserved(upgradeConfig);
  report.checks.push("failed update artifact download retains the previous package, live Backend, completion, configuration and memory");
  rejectDownload = false;
  stage = "retry public update in a native terminal";
  const updated = await terminalSetup("update");
  check(updated.status === "PASS" && updated.exitCode === 0, "The public update command failed");
  check(registryRequests.manifest > 0 && registryRequests.artifact > 0, "The updater did not fetch the candidate from the scoped registry");
  check((await readJson(join(packageRoot, "package.json"))).version === expectedPackageVersion,
    "Candidate package did not replace the previous version");
  await verifyReady("upgrade");
  await verifyBackendReplacement(previousBackend, "previous-release update");
  await verifyPreserved(upgradeConfig);
  check(!(await exists(join(stateHome, "runtime", "install", "package-transition.json"))),
    "Successful replacement retained pending transition authority");
  report.upgrade = { from: previousVersion, to: expectedPackageVersion, mechanism: "public update --latest with candidate scoped registry" };
  report.checks.push("real terminal update --latest upgraded the running previous release to the candidate with configuration and synthetic memory retained");

  stage = "candidate updater force reinstall";
  const candidateBackend = await readJson(pidPath());
  const beforeCandidateRequests = { ...registryRequests };
  // A fresh cache requires this candidate's updater to fetch the artifact again.
  env.npm_config_cache = join(root, "candidate updater npm cache");
  const candidateUpdate = await terminalSetup("force-update");
  check(candidateUpdate.status === "PASS" && candidateUpdate.exitCode === 0,
    "The candidate's public update command failed");
  check(registryRequests.manifest > beforeCandidateRequests.manifest
    && registryRequests.artifact > beforeCandidateRequests.artifact,
    "The candidate updater did not download and install the registry artifact");
  check((await readJson(join(packageRoot, "package.json"))).version === expectedPackageVersion,
    "Candidate force update installed an unexpected version");
  await verifyReady("candidate force update");
  await verifyBackendReplacement(candidateBackend, "candidate force update");
  await verifyPreserved(upgradeConfig);
  check(!(await exists(join(stateHome, "runtime", "install", "package-transition.json"))),
    "Candidate force update retained pending transition authority");
  report.candidateUpdate = { from: expectedPackageVersion, to: expectedPackageVersion,
    mechanism: "candidate public update --latest --force with a fresh npm cache" };
  report.checks.push("candidate updater reinstalled the artifact and replaced the running Backend with configuration and memory retained");
  await verifySavedAccountSearch("candidate force update");

  stage = "candidate package replacement lifecycle failure";
  const replacementBackend = await readJson(pidPath());
  const faultMarker = join(root, "npm-replacement-fault.json");
  const fault = await makeReplacementFaultArtifact(packageRoot, faultMarker, replacementBackend.pid);
  servedArtifact = await readFile(fault.tarball);
  servedManifest = fault.manifest;
  const beforeFaultRequests = { ...registryRequests };
  const diagnosticsRoot = join(stateHome, "runtime", "diagnostics");
  const beforeFaultDiagnostics = new Set(await exists(diagnosticsRoot) ? await readdir(diagnosticsRoot) : []);
  env.npm_config_cache = join(root, "failed replacement npm cache");
  const failedReplacement = await rejectedProduct(["update", "--latest", "--force"]);
  check(failedReplacement.diagnosticCode === "UPDATE_INSTALL_FAILED",
    "Package replacement failed without the expected public update diagnostic");
  check(registryRequests.artifact > beforeFaultRequests.artifact,
    "The replacement failure did not download the fault-injected candidate");
  const faultEvidence = await readJson(faultMarker);
  check(faultEvidence.stage === "postinstall" && faultEvidence.transitionState === "retired"
    && faultEvidence.oldBackendStopped === true && faultEvidence.candidateVersion === expectedPackageVersion,
  "Fault injection did not reach real package replacement after the old Backend retired");
  await verifyPreserved(upgradeConfig);
  const diagnostics = await Promise.all((await readdir(diagnosticsRoot))
    .filter((name) => /^mc-.*\.json$/.test(name) && !beforeFaultDiagnostics.has(name))
    .map((name) => readJson(join(diagnosticsRoot, name))));
  const replacementFailure = diagnostics.find((item) => item.operation === "update"
    && item.errorCode === "UPDATE_INSTALL_FAILED" && item.commandExitCode === 23
    && ["restored", "failed"].includes(item.recoveryStatus));
  check(replacementFailure && ["restored", "failed"].includes(replacementFailure.recoveryStatus),
    "Failed package replacement did not record a recognizable recovery outcome");
  if (replacementFailure.recoveryStatus === "failed") {
    check((await readJson(join(stateHome, "runtime", "install", "package-transition.json"))).state === "retired",
      "Failed recovery lost pending package transition authority");
    await product(["update", "--recover"]);
  }
  await verifyReady("failed replacement recovery");
  await verifyBackendReplacement(replacementBackend, "failed replacement recovery");
  check(!(await exists(join(stateHome, "runtime", "install", "package-transition.json"))),
    "Recovered replacement retained pending transition authority");
  report.replacementFailure = { evidence: "real_npm_with_candidate_postinstall_fault_injection",
    injectedExitCode: 23, npmExitCode: replacementFailure.commandExitCode,
    publicCommandExitCode: failedReplacement.code, diagnosticCode: replacementFailure.errorCode,
    recoveryStatus: replacementFailure.recoveryStatus, originalCommandFailed: true };
  report.checks.push("candidate npm replacement failed after old Backend retirement; the public error and recovery state remained identifiable and the saved account survived");

  stage = "retry candidate package replacement";
  servedArtifact = artifact;
  servedManifest = manifest;
  env.npm_config_cache = join(root, "replacement retry npm cache");
  const recoveredBackend = await readJson(pidPath());
  await terminalSetup("force-update");
  await verifyReady("replacement retry");
  await verifyBackendReplacement(recoveredBackend, "replacement retry");
  await verifyPreserved(upgradeConfig);
  const installedManifest = await readJson(join(packageRoot, "package.json"));
  check(installedManifest.scripts.postinstall === manifest.scripts.postinstall,
    "Replacement retry retained the injected lifecycle script");
  check(!(await exists(join(stateHome, "runtime", "install", "package-transition.json"))),
    "Replacement retry retained pending transition authority");
  await verifySavedAccountSearch("replacement retry");
  report.checks.push("retry installed the unmodified candidate and restored native readiness and saved-account Search");
  stage = "outbound isolation";
  check(requests === 0, "Installation unexpectedly contacted the model or MemoraX endpoint");
  check(endpointErrors.length === 0, "The explicit Search fixture received malformed requests");
  report.outbound = { installationRequests: requests, explicitSearchRequests: memoryRequests.length,
    observation: "configured loopback endpoint", setupEndpointOverride: "initial account enrollment only",
    credentialInputOnReinstall: false };
  report.checks.push("configured model/MemoraX endpoint received no lifecycle requests; only deliberate saved-account Search requests reached the loopback fixture");
  report.status = "PASS";
} catch (error) {
  report.stage = stage;
  const assertionCode = typeof error.message === "string"
    ? error.message.match(/^(?:SETUP_INPUT_REJECTION|BACKEND_REPLACEMENT|TERMINAL_DISCLOSED|EMPTY_CREDENTIAL_CANARY|PROTECTED_)[A-Z_]*/)?.[0]
    : undefined;
  report.error = error.smokeMessage ?? assertionCode ?? "The stage failed; private command output was suppressed";
  if (typeof error.code === "number") report.exitCode = error.code;
  if (["ENOENT", "ENOEXEC", "EACCES", "EPERM", "EINVAL", "ETIMEDOUT"].includes(error.code)) report.nativeErrorCode = error.code;
  if (error.diagnosticCode) report.diagnosticCode = error.diagnosticCode;
  if (error.terminalError) report.terminalError = error.terminalError;
  if (error.terminalDiagnostics) report.terminalDiagnostics = error.terminalDiagnostics;
  if (error.terminalNativeError) report.terminalNativeError = error.terminalNativeError;
} finally {
  await cleanup();
  if (!receivedSignal) for (const [signal, handler] of signalHandlers) process.off(signal, handler);
}
console.log(JSON.stringify(report, null, 2));
if (report.status !== "PASS") process.exitCode = 1;

function cleanup() {
  return cleanupPromise ??= cleanupResources();
}

async function cleanupResources() {
  for (const child of [...activeCommands]) {
    try { await stopOwnedCommand(child); }
    catch { commandCleanupVerified = false; }
  }
  try {
    if (setupStarted) {
      cleanupStage = "entrypoint_check";
      if (await exists(entrypoint)) await stopAndVerify();
      else await assertStopped();
      report.checks.push("Backend stopped, process exited and port released");
    }
    if (root) {
      cleanupStage = "command_process";
      check(commandCleanupVerified, "An owned command process tree could not be verified");
      for (const pid of commandPids) check(!processAlive(pid), "An owned command process remains after cleanup");
      cleanupStage = "directory_removal";
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
    report.cleanup = "PASS";
  } catch (error) {
    report.status = "FAIL";
    report.cleanup = "FAIL: isolated state retained because shutdown was not confirmed";
    report.cleanupFailure = { stage: cleanupStage, code: cleanupCodes[cleanupStage] };
    if (cleanupStage === "tracked_process" && Number.isInteger(cleanupTrackedPidIndex)) {
      report.cleanupFailure.trackedPidIndex = cleanupTrackedPidIndex;
      report.cleanupFailure.trackedPidCount = backendPids.size;
    }
    if (["ENOENT", "EACCES", "EPERM", "EBUSY", "ENOTEMPTY", "ESRCH", "EINVAL", "ETIMEDOUT",
      "EADDRINUSE", "EADDRNOTAVAIL", "EPIPE", "ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EIO", "EROFS"].includes(error.code)) {
      report.cleanupFailure.systemCode = error.code;
    }
    if (Number.isInteger(error.code) && error.code >= 0 && error.code <= 255) {
      report.cleanupFailure.commandExitCode = error.code;
    }
    if (["SIGTERM", "SIGKILL", "SIGINT", "SIGABRT"].includes(error.signal)) {
      report.cleanupFailure.commandSignal = error.signal;
    }
  }
  for (const server of [endpoint, registry]) {
    if (!server?.listening) continue;
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
}

function handleSignal(signal) {
  if (receivedSignal) return;
  receivedSignal = signal;
  report.status = "FAIL";
  report.signal = signal;
  report.stage = stage;
  const exitCode = signal === "SIGINT" ? 130 : 143;
  const timeout = setTimeout(() => {
    report.cleanup = "FAIL: owned resource cleanup exceeded its time limit";
    console.log(JSON.stringify(report, null, 2));
    process.exit(exitCode);
  }, 60_000);
  void cleanup().finally(() => {
    clearTimeout(timeout);
    report.status = "FAIL";
    console.log(JSON.stringify(report, null, 2));
    process.exit(exitCode);
  });
}

async function verifyReady(attempt, expectedUser = fixtureUser) {
  stage = `${attempt} readiness`;
  const completion = await readJson(join(stateHome, "runtime", "setup", "setup-completion.json"));
  check(completion.version === 1 && completion.state === "complete"
    && completion.completedByVersion === expectedPackageVersion, "Setup did not record completion for this package");
  check(!Object.hasOwn(env, "MEMORAX_CODE_MEMORAX_ENDPOINT")
    && !Object.hasOwn(env, "MEMORAX_CODE_MEMORAX_WRITEBACK_ENABLED")
    && !Object.hasOwn(env, "MEMORAX_CODE_MEMORY_WRITEBACK_ENABLED"),
  "A test environment override could mask saved endpoint or writeback configuration");
  const saved = parse(await readFile(join(stateHome, "config.toml"), "utf8"));
  check(saved.memorax?.api_key === fixtureKey && saved.memorax.endpoint === savedEndpoint
    && saved.memorax.user_id === expectedUser,
  "Setup did not preserve the exact supplied user identity, credential and endpoint");
  check(saved.memory?.writeback?.enabled === false && saved.jev?.enabled === false
    && saved.clients?.opencode === true && otherClients.every((client) => saved.clients?.[client] === false),
  "Lifecycle changed a persisted user feature or client selection");
  const effectiveMemory = JSON.parse((await run(process.execPath,
    [join(dirname(entrypoint), "memorax-cli.mjs"), "status", "--config-only", "--json"])).stdout);
  check(effectiveMemory.ok === true && effectiveMemory.config?.baseUrl === savedEndpoint
    && effectiveMemory.config.userId === expectedUser
    && effectiveMemory.config.writeback?.writebackEnabled === false
    && effectiveMemory.config.writeback?.globalEnabled === true,
  "Effective memory configuration does not honor the saved account and persisted writeback disablement");
  const status = await productJson(["status", "--clients", "opencode", "--json"]);
  check(status.ok === true && status.backend?.ok === true, "The installed Backend is not healthy");
  const adapter = status.opencodeAdapter;
  check(adapter?.ok === true && adapter.installed === true && adapter.enabled === true
    && adapter.current === true && adapter.managed === true && adapter.backendUrlMatches === true,
  "The OpenCode integration is not current and connected to this Backend");
  const expectedPaths = {
    pluginPath: join(openCodeConfigDir, "plugins", "memorax-code.js"),
    skillPath: join(openCodeConfigDir, "skills", "memorax-code"),
    repoMemoryHelperPath: join(openCodeConfigDir, "hooks", "repo-memory-job.mjs"),
  };
  for (const [field, expectedPath] of Object.entries(expectedPaths)) {
    check(adapter[field] === expectedPath, "The installed integration has an unexpected discovery path");
    const pathRelative = relative(openCodeConfigDir, adapter[field]);
    check(pathRelative !== ".." && !pathRelative.startsWith(`..${sep}`)
      && !isAbsolute(pathRelative), "The installed integration escaped the isolated OpenCode directory");
  }
  check(adapter.pluginCurrent === true && adapter.repoMemoryHelperCurrent === true,
    "The managed OpenCode loader or repo-memory helper differs from the installed package");
  const skill = adapter.opencodeSkills;
  check(skill?.ok === true && skill.sourceKind === "canonical" && skill.path === expectedPaths.skillPath,
    "The OpenCode adapter does not expose its canonical Skill");
  check(await readFile(join(skill.path, "SKILL.md"), "utf8")
    === await readFile(join(sourceRoot, "skills", "memorax-code", "SKILL.md"), "utf8"),
  "The installed Skill differs from the packaged Skill");
  check(await readFile(join(openCodeConfigDir, "opencode.json"), "utf8") === originalProvider,
    "Setup changed the existing OpenCode model configuration");
  const backend = await readJson(join(stateHome, "runtime", "backend", "backend.pid.json"));
  check(Number.isInteger(backend.pid) && backend.pid > 0, "Backend PID record is invalid");
  backendPids.add(backend.pid);
  report.checks.push(`${attempt}: managed plugin, repo-memory helper, packaged Skill, Backend and completion verified`);
}

async function verifyIntegrationAbsent(message) {
  for (const path of [
    join(openCodeConfigDir, "plugins", "memorax-code.js"),
    join(openCodeConfigDir, "skills", "memorax-code"),
    join(openCodeConfigDir, "hooks", "repo-memory-job.mjs"),
  ]) check(!(await exists(path)), message);
}

function completionPath() { return join(stateHome, "runtime", "setup", "setup-completion.json"); }
function pidPath() { return join(stateHome, "runtime", "backend", "backend.pid.json"); }
async function exists(path) {
  return stat(path).then(() => true, (error) => { if (error.code === "ENOENT") return false; throw error; });
}
async function rememberPid() {
  if (await exists(pidPath())) {
    const backend = await readJson(pidPath());
    check(Number.isInteger(backend.pid) && backend.pid > 0, "Backend PID record is invalid");
    backendPids.add(backend.pid);
  }
}
async function verifyBackendReplacement(before, label) {
  stage = `${label} Backend replacement`;
  const after = await readJson(pidPath());
  let oldProcessAlive = true;
  try { process.kill(before.pid, 0); }
  catch (error) { if (error.code === "ESRCH") oldProcessAlive = false; else throw error; }
  try { process.kill(after.pid, 0); }
  catch { check(false, "Updated Backend PID does not identify a live process"); }
  check(after.url === `http://127.0.0.1:${backendPort}`, "Updated Backend has an unexpected endpoint");
  const response = await fetch(new URL("/health", after.url), { signal: AbortSignal.timeout(5_000) });
  check(response.ok, "Updated Backend did not answer its health endpoint successfully");
  assertBackendReplacement(before, after, await response.json(), oldProcessAlive);
  backendPids.delete(before.pid);
  report.checks.push(`${label}: old Backend exited; new PID, instance and live health identity agree`);
}
async function stopAndVerify() {
  cleanupStage = "pid_record_read";
  await rememberPid();
  cleanupStage = "stop_command";
  const stopped = await product(["stop", "--clients", "opencode", "--json"], undefined, { cleanup: true });
  cleanupStage = "stop_response";
  check(JSON.parse(stopped.stdout).ok === true, "Backend stop did not succeed");
  await assertStopped();
}
async function assertStopped() {
  cleanupStage = "pid_record_removal";
  check(!(await exists(pidPath())), "Backend PID record remains after stop");
  cleanupStage = "tracked_process";
  let trackedIndex = 0;
  for (const pid of backendPids) {
    cleanupTrackedPidIndex = trackedIndex++;
    let alive = true;
    try { process.kill(pid, 0); } catch (error) { if (error.code === "ESRCH") alive = false; else throw error; }
    check(!alive, "An installation Backend process remains after stop");
  }
  cleanupStage = "port_release";
  const probe = createTcpServer();
  await new Promise((done, reject) => { probe.once("error", reject); probe.listen(backendPort, "127.0.0.1", done); });
  await new Promise((done) => probe.close(done));
  backendPids.clear();
}
async function verifyPreserved(config) {
  assertProtectedConfiguration(parse(await readFile(join(stateHome, "config.toml"), "utf8")),
    snapshotProtectedConfiguration(parse(config)));
  check(await readFile(join(openCodeConfigDir, "opencode.json"), "utf8") === originalProvider,
    "Lifecycle changed the existing OpenCode provider configuration");
  for (const [path, contents] of preservedMemory) check(await readFile(path, "utf8") === contents, "Lifecycle changed retained personal memory");
}
async function rejectedProduct(args, input) {
  let failure;
  try { await product(args, input); } catch (error) {
    if (error.smokeMessage) throw error;
    check(typeof error.code === "number" && error.code !== 0, "Expected product rejection, not process launch failure");
    failure = error;
  }
  check(failure, "A command expected to fail unexpectedly succeeded");
  return failure;
}
async function terminalSetup(mode) {
  // Account enrollment has no endpoint prompt. Supply its endpoint only for
  // this initial input; every reuse, update and request reads persisted state.
  if (mode === "complete" || mode === "cancel") env.MEMORAX_CODE_MEMORAX_ENDPOINT = savedEndpoint;
  try {
    return JSON.parse((await run(process.execPath, [ptyScript, ptyPackage, entrypoint, mode],
      JSON.stringify({ username: fixtureUser, apiKey: fixtureKey }))).stdout);
  } catch (error) {
    // The helper emits only a bounded safe JSON report; raw terminal output
    // stays private even when a test assertion or native terminal launch fails.
    try {
      const safe = JSON.parse(error.stdout);
      if (/^[A-Z][A-Z0-9_]{1,79}$/.test(safe.error)) error.terminalError = safe.error;
      error.terminalDiagnostics = Object.fromEntries([
        "usernamePromptSeen", "keyPromptSeen", "languagePromptSeen", "accountInputSent", "outputBytes", "cursorPositionReplies", "exitCode", "signal",
      ].filter((key) => typeof safe[key] === "boolean" || Number.isFinite(safe[key])).map((key) => [key, safe[key]]));
      if (/^[A-Z][A-Z0-9_]{1,79}$/.test(safe.nativeErrorCode)) error.terminalNativeError = safe.nativeErrorCode;
    } catch {}
    throw error;
  } finally {
    delete env.MEMORAX_CODE_MEMORAX_ENDPOINT;
  }
}
async function verifySavedAccountSearch(label) {
  stage = `${label} saved-account Search`;
  check(requests === 0, "A lifecycle operation contacted the model or MemoraX fixture before explicit Search");
  const before = memoryRequests.length;
  const query = `Verify the saved lifecycle account after ${label}.`;
  let result;
  allowSearch = true;
  try {
    result = JSON.parse((await run(process.execPath,
      [join(dirname(entrypoint), "memorax-cli.mjs"), "search", "--query", query, "--json"])).stdout);
  } finally {
    allowSearch = false;
  }
  check(endpointErrors.length === 0 && memoryRequests.length === before + 1,
    "Explicit Search did not make exactly one request to the saved endpoint");
  const request = memoryRequests[before];
  const scopedUser = `${fixtureUser}@workspace-测试`;
  check(request.method === "POST" && request.path === "/saved-account/v1/memories/search"
    && request.authorization === `Token ${fixtureKey}` && request.body.user_id === scopedUser
    && request.body.query === query && !Object.hasOwn(request.body, "session_id"),
  "Explicit Search changed the saved endpoint, credential, scoped user identity or query");
  check(result.ok === true && result.action === "memory.search" && result.query === query
    && result.baseUserId === fixtureUser && result.effectiveUserId === scopedUser
    && result.items?.length === 1 && result.items[0].memory === searchFixture
    && result.receipt?.accepted === true,
  "Explicit Search did not return the saved account identity and fixture result");
  report.checks.push(`${label}: installed memory CLI Search used the saved endpoint, credential and workspace-scoped account`);
}

async function makeReplacementFaultArtifact(packageRoot, faultMarker, oldPid) {
  const faultRoot = join(root, "fault candidate");
  await cp(packageRoot, faultRoot, { recursive: true,
    filter: (source) => !relative(packageRoot, source).split(/[\\/]/).includes("node_modules") });
  const manifest = await readJson(join(faultRoot, "package.json"));
  // The artifact differs only in a test lifecycle wrapper. Its real preinstall,
  // Backend, adapters and updater are unchanged; this is injected npm failure
  // evidence, not a product defect or a rejected-download substitute.
  manifest.scripts.postinstall = "node ./bin/ci-replacement-failure.mjs";
  await writeFile(join(faultRoot, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(faultRoot, "bin", "ci-replacement-failure.mjs"), [
    'import { readFileSync, writeFileSync } from "node:fs";',
    'import { join } from "node:path";',
    `const marker = ${JSON.stringify(faultMarker)};`,
    `const oldPid = ${JSON.stringify(oldPid)};`,
    'const transition = JSON.parse(readFileSync(join(process.env.MEMORAX_CODE_HOME, "runtime", "install", "package-transition.json"), "utf8"));',
    'let oldBackendStopped = false;',
    'try { process.kill(oldPid, 0); } catch (error) { if (error.code === "ESRCH") oldBackendStopped = true; else throw error; }',
    'if (transition.state !== "retired" || !oldBackendStopped) process.exit(24);',
    `writeFileSync(marker, JSON.stringify({ stage: "postinstall", transitionState: transition.state, oldBackendStopped, candidateVersion: ${JSON.stringify(manifest.version)} }), { mode: 0o600 });`,
    'process.exit(23);', "",
  ].join("\n"));
  const packed = JSON.parse((await run(npmCommand,
    ["pack", faultRoot, "--ignore-scripts", "--pack-destination", faultRoot, "--json"])).stdout);
  check(packed.length === 1 && typeof packed[0].filename === "string", "Fault-injected npm artifact was not packed");
  return { tarball: join(faultRoot, packed[0].filename), manifest };
}
async function npmInstall(specifier) {
  await run(npmCommand, ["install", "--global", "--prefix", npmPrefix, "--no-audit", "--no-fund", specifier]);
}

function check(condition, message) {
  if (!condition) throw Object.assign(new Error(message), { smokeMessage: message });
}

async function readJson(path) { return JSON.parse(await readFile(path, "utf8")); }

async function run(command, args, input = "", options = {}) {
  check(!receivedSignal || options.cleanup === true, "Installation smoke is stopping");
  const invocation = process.platform === "win32" && command === npmCommand
    ? resolveNpmInvocation(args, { env }) : resolveInvocation(command, args, { env });
  const pending = execFileAsync(invocation.command, invocation.args, {
    cwd: workspace, env, maxBuffer: 4 * 1024 * 1024, encoding: "utf8", windowsHide: true,
    detached: process.platform !== "win32",
  });
  activeCommands.add(pending.child);
  if (pending.child.pid) commandPids.add(pending.child.pid);
  pending.child.once("exit", () => {
    commandPids.delete(pending.child.pid);
    activeCommands.delete(pending.child);
  });
  pending.child.stdin.on("error", () => {});
  pending.child.stdin.end(input);
  let result, timer, stopping, cleanupFailure;
  let timedOut = false;
  const stop = () => stopping ??= stopOwnedCommand(pending.child).catch((error) => {
    cleanupFailure = error;
    commandCleanupVerified = false;
  });
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(async () => {
      timedOut = true;
      await stop();
      reject(new Error("INSTALL_COMMAND_TIMEOUT"));
    }, options.cleanup === true ? 15_000 : 120_000);
  });
  try {
    result = await Promise.race([pending, timeout]);
    check(!timedOut, "An installation command exceeded its time limit");
  }
  catch (error) {
    if (timedOut) await stop();
    check(!cleanupFailure, "The timed-out command process tree could not be stopped");
    check(!timedOut, "An installation command exceeded its time limit");
    // Report only the stable product error code, never raw process output.
    assertCredentialNotEchoed(`${error.stdout ?? ""}\n${error.stderr ?? ""}`, fixtureKey);
    error.diagnosticCode = `${error.stdout ?? ""}\n${error.stderr ?? ""}`.match(/\b(?:CLIENT|OPENCODE|BACKEND|SETUP|CONFIG|UPDATE|PACKAGE|INSTALL|MEMORY)_[A-Z_]{3,}\b/)?.[0];
    throw error;
  } finally {
    clearTimeout(timer);
    if (stopping) await stopping;
  }
  assertCredentialNotEchoed(`${result.stdout}\n${result.stderr}`, fixtureKey);
  return result;
}

async function stopOwnedCommand(child) {
  if (!child.pid) return;
  const pids = new Set([child.pid]);
  let cleanupFailure;
  if (process.platform !== "win32") {
    // node-pty creates a separate session, so killing only the wrapper's group
    // would miss it. Read identities only, never command lines or environment.
    try {
      const { stdout } = await execFileAsync("/bin/ps", ["-axo", "pid=,ppid="], {
        timeout: 5_000, maxBuffer: 1024 * 1024, encoding: "utf8", env,
      });
      const processes = stdout.trim().split(/\r?\n/).map((line) => line.trim().split(/\s+/).map(Number));
      check(processes.every((entry) => entry.length === 2 && entry.every(Number.isInteger))
        && processes.some(([pid]) => pid === child.pid), "The owned command process tree could not be identified");
      for (const parent of pids) {
        for (const [pid, ppid] of processes) if (ppid === parent && pid > 1) pids.add(pid);
      }
    } catch (error) { cleanupFailure = error; }
  }
  for (const pid of pids) commandPids.add(pid);
  const deadline = Date.now() + 10_000;
  for (const pid of [...pids].reverse()) {
    try { await stopNativeProcessTree({ pid }, env); }
    catch (error) { cleanupFailure ??= error; }
    // Let the still-live parent reap its child before terminating the parent.
    while (processAlive(pid) && Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, 50));
    }
  }
  check(!cleanupFailure, "The owned command process tree could not be verified and stopped");
  check([...pids].every((pid) => !processAlive(pid)), "The owned command process tree did not exit");
  for (const pid of pids) commandPids.delete(pid);
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
}

function product(args, input, options) { return run(process.execPath, [entrypoint, ...args], input, options); }
async function productJson(args) { return JSON.parse((await product(args)).stdout); }

async function freePort() {
  const server = createTcpServer();
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}

function isolatedEnv(userHome, openCodeCommand) {
  const windowsRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
  const systemPaths = process.platform === "win32"
    ? [join(windowsRoot, "System32"), windowsRoot, join(windowsRoot, "System32", "Wbem"),
      join(windowsRoot, "System32", "WindowsPowerShell", "v1.0")]
    : ["/usr/bin", "/bin"];
  const isolated = {
    HOME: userHome, USERPROFILE: userHome, USER: "install-smoke", LOGNAME: "install-smoke", LANG: "en_US.UTF-8",
    PATH: [...new Set([dirname(process.execPath), dirname(npmCommand), ...systemPaths])].join(delimiter),
    APPDATA: join(userHome, "AppData", "Roaming"), LOCALAPPDATA: join(userHome, "AppData", "Local"),
    TMPDIR: join(root, "tmp"), TMP: join(root, "tmp"), TEMP: join(root, "tmp"),
    XDG_CONFIG_HOME: join(userHome, ".config"), XDG_DATA_HOME: join(userHome, ".local", "share"),
    XDG_STATE_HOME: join(userHome, ".local", "state"), XDG_CACHE_HOME: join(userHome, ".cache"),
    npm_config_cache: join(root, "npm-cache"), npm_config_prefix: npmPrefix,
    MEMORAX_CODE_HOME: stateHome, MEMORAX_CODE_AUTO_UPDATE: "false", MEMORAX_CODE_INSTALL_WATCHDOG: "0",
    MEMORAX_CODE_BACKEND_HOST: "127.0.0.1", MEMORAX_CODE_BACKEND_PORT: String(backendPort),
    CODEX_HOME: join(userHome, ".codex"), CODEX_CLI_PATH: join(root, "unused-client"),
    MEMORAX_CODE_SKIP_CODEX_PLUGIN_INSTALL: "1",
    MEMORAX_CODE_OPENCODE_COMMAND: openCodeCommand, OPENCODE_TEST_HOME: userHome,
    OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_SHARE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1",
    DSH_HOME: join(userHome, ".dsh"), CLAUDE_CONFIG_DIR: join(userHome, ".claude"), CLAUDE_HOME: join(userHome, ".claude"),
    OPENCODE_CONFIG_DIR: openCodeConfigDir,
    CODEBUDDY_HOME: join(userHome, ".codebuddy"), CODEBUDDY_CONFIG_DIR: join(userHome, ".codebuddy"),
    WORKBUDDY_HOME: join(userHome, ".workbuddy"), WORKBUDDY_CONFIG_DIR: join(userHome, ".workbuddy"),
    TRAE_CN_HOME: join(userHome, ".trae-cn"), TRAE_HOME: join(userHome, ".trae-cn"), CURSOR_HOME: join(userHome, ".cursor"),
    MEMORAX_CODE_OPENCODE_TRACE_ENABLED: "false",
  };
  if (process.platform === "win32") Object.assign(isolated, {
    SystemRoot: windowsRoot, WINDIR: windowsRoot,
    ComSpec: join(windowsRoot, "System32", "cmd.exe"),
    PATHEXT: ".COM;.EXE;.BAT;.CMD", USERNAME: "install-smoke",
  });
  for (const client of otherClients) {
    isolated[`MEMORAX_CODE_${client.toUpperCase()}_COMMAND`] = join(root, "unused-client");
    isolated[`MEMORAX_CODE_${client.toUpperCase()}_TRACE_ENABLED`] = "false";
    isolated[`MEMORAX_CODE_SKIP_${client.toUpperCase()}_ADAPTER_INSTALL`] = "1";
  }
  return isolated;
}
