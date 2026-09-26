#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const pluginName = "memorax-code-codex-adapter";
const pluginId = `${pluginName}@memorax-code`;
const otherClients = ["claude", "dsh", "opencode", "codebuddy", "workbuddy", "trae", "cursor"];
const fixtureKey = `sk_${"E".repeat(43)}`;
const report = { status: "FAIL", platform: process.platform, arch: process.arch, checks: [] };
let stage = "prerequisites";
let root, env, workspace, entrypoint, stateHome, codexHome, backendPort, endpoint, registry;
let resolveInvocation, resolveNpmInvocation;
let setupStarted = false;
let requests = 0;
const backendPids = new Set();
let npmCommand, npmPrefix, candidateTarball, ptyPackage, ptyScript;
let expectedPackageVersion, expectedPluginVersion, expectedEvents, sourceRoot, parse;
let originalProvider;
const preservedMemory = new Map();

try {
  check(["darwin", "linux", "win32"].includes(process.platform), "This smoke test requires macOS, Linux or Windows");
  check(process.argv.length === 9, "Usage: codex-install-smoke.mjs INSTALLED_PACKAGE_ROOT CODEX_CLI_PATH CANDIDATE_TARBALL NPM_CLI_PATH PREVIOUS_VERSION PTY_PACKAGE_ROOT PTY_SCRIPT_PATH");
  const packageRoot = resolve(process.argv[2]);
  const codexCommand = resolve(process.argv[3]);
  entrypoint = join(packageRoot, "bin", "memorax-code.mjs");
  candidateTarball = resolve(process.argv[4]);
  npmCommand = resolve(process.argv[5]);
  const previousVersion = process.argv[6];
  ptyPackage = resolve(process.argv[7]);
  ptyScript = resolve(process.argv[8]);
  check(/^\d+\.\d+\.\d+$/.test(previousVersion), "Previous package version must be exact");
  npmPrefix = resolve(packageRoot, process.platform === "win32" ? "../../.." : "../../../..");
  check(await readFile(join(npmPrefix, ".memorax-code-ci-owned"), "utf8") === "codex-install-check\n",
    "Refusing npm lifecycle mutations outside the wrapper-owned prefix");
  ({ resolveWindowsCliInvocation: resolveInvocation } = await import(
    pathToFileURL(join(packageRoot, "lib", "windows-cli-invocation.mjs")).href));
  ({ resolveNpmInvocation } = await import(
    pathToFileURL(join(packageRoot, "lib", "npm-invocation.mjs")).href));
  const manifest = await readJson(join(packageRoot, "package.json"));
  check(manifest.name === "@memorax/memorax-code", "The installed package has an unexpected identity");
  sourceRoot = join(packageRoot, "lib", pluginName);
  const pluginManifest = await readJson(join(sourceRoot, ".codex-plugin", "plugin.json"));
  const hookManifest = await readJson(join(sourceRoot, "hooks", "hooks.json"));
  expectedEvents = Object.entries(hookManifest.hooks).flatMap(([event, groups]) =>
    groups.flatMap((group) => group.hooks.map(() => event[0].toLowerCase() + event.slice(1)))).sort();
  ({ parse } = createRequire(join(packageRoot, "package.json"))("smol-toml"));
  expectedPackageVersion = manifest.version;
  expectedPluginVersion = pluginManifest.version;
  check(previousVersion !== manifest.version, "Upgrade requires a different previous package version");
  report.packageVersion = manifest.version;
  report.pluginVersion = pluginManifest.version;

  root = await mkdtemp(join(tmpdir(), "memorax-code-codex-install-"));
  const userHome = join(root, "user home 测试");
  workspace = join(root, "workspace 测试");
  stateHome = join(userHome, ".memorax-code");
  codexHome = join(userHome, ".codex");
  await Promise.all([workspace, stateHome, codexHome, join(root, "tmp")].map((path) => mkdir(path, { recursive: true })));
  backendPort = await freePort();
  endpoint = createServer((_request, response) => {
    requests += 1;
    response.writeHead(503).end();
  });
  await new Promise((done, reject) => { endpoint.once("error", reject); endpoint.listen(0, "127.0.0.1", done); });
  const dummyUrl = `http://127.0.0.1:${endpoint.address().port}`;
  env = isolatedEnv(userHome, codexCommand, dummyUrl);
  await writeFile(join(stateHome, "config.toml"), ["[clients]", "codex = true",
    ...otherClients.map((client) => `${client} = false`), ""].join("\n"), { mode: 0o600 });
  originalProvider = { model: "install-smoke", model_provider: "install-smoke", model_providers: {
    "install-smoke": { name: "Install smoke", base_url: dummyUrl, wire_api: "responses" },
  } };
  await writeFile(join(codexHome, "config.toml"), [
    'model = "install-smoke"', 'model_provider = "install-smoke"',
    '[model_providers.install-smoke]', 'name = "Install smoke"',
    `base_url = "${dummyUrl}"`, 'wire_api = "responses"', "",
  ].join("\n"), { mode: 0o600 });
  const version = await run(codexCommand, ["--version"]);
  check(/^codex-cli \S+$/.test(version.stdout.trim()), "The Codex command did not return its version");
  report.codexVersion = version.stdout.trim();
  report.checks.push("installed package and real Codex CLI available");

  const initialConfig = await readFile(join(stateHome, "config.toml"), "utf8");
  const initialCodexConfig = await readFile(join(codexHome, "config.toml"), "utf8");
  const prepareScenarioHome = async (name) => {
    const scenarioHome = join(root, name);
    stateHome = join(scenarioHome, ".memorax-code");
    codexHome = join(scenarioHome, ".codex");
    env = isolatedEnv(scenarioHome, codexCommand, dummyUrl);
    await Promise.all([stateHome, codexHome].map((path) => mkdir(path, { recursive: true })));
    await writeFile(join(stateHome, "config.toml"), initialConfig, { mode: 0o600 });
    await writeFile(join(codexHome, "config.toml"), initialCodexConfig, { mode: 0o600 });
  };
  for (const [label, input] of [["empty stdin", ""], ["multiple stdin values", "invalid\nsecond\n"]]) {
    stage = `rejected setup: ${label}`;
    await rejectedProduct(["setup", "--existing-account", "--non-interactive"], input);
    check(await readFile(join(stateHome, "config.toml"), "utf8") === initialConfig
      && await readFile(join(codexHome, "config.toml"), "utf8") === initialCodexConfig,
    "Rejected setup changed existing configuration");
    check(!(await exists(completionPath())) && !(await exists(pidPath())), "Rejected setup created completion or Backend state");
  }
  report.checks.push("empty and multiline stdin rejected before configuration, completion or Backend mutation");

  stage = "interactive setup cancellation";
  const cancelled = await terminalSetup("cancel");
  check(cancelled.status === "PASS" && cancelled.usernamePromptSeen && cancelled.keyPromptSeen,
    "Interactive cancellation did not reach the expected native prompts");
  check(!(await exists(completionPath())) && !(await exists(pidPath())), "Cancelled setup created completion or Backend state");
  const cancelledConfig = await readFile(join(stateHome, "config.toml"), "utf8");
  check(!cancelledConfig.includes(fixtureKey) && JSON.stringify(parse(cancelledConfig).clients) === JSON.stringify(parse(initialConfig).clients),
    "Cancelled setup stored the key or changed the client choices");
  check(await readFile(join(codexHome, "config.toml"), "utf8") === initialCodexConfig,
    "Cancelled setup changed Codex provider configuration");
  const cancelledNative = JSON.parse((await run(codexCommand, ["plugin", "list", "--available", "--json"])).stdout);
  check(!cancelledNative.installed.some((item) => item.pluginId === pluginId || item.name === pluginName),
    "Cancelled setup registered the native plugin");
  report.checks.push("real terminal setup cancelled at the masked-key prompt without completing or installing the plugin");

  // Failure recovery has its own home so it cannot prepare the fresh-install case.
  await prepareScenarioHome("failed setup user 测试");
  stage = "failed setup with occupied Backend port";
  const occupied = createServer((_request, response) => response.writeHead(503).end());
  await new Promise((done, reject) => { occupied.once("error", reject); occupied.listen(backendPort, "127.0.0.1", done); });
  setupStarted = true;
  try {
    const failure = await rejectedProduct(["setup", "--existing-account", "--non-interactive"], `${fixtureKey}\n`);
    check(["BACKEND_EXITED_BEFORE_READY", "BACKEND_HEALTH_NOT_READY"].includes(failure.diagnosticCode),
      "Occupied-port setup failed for an unexpected reason");
    report.setupFailureCode = failure.diagnosticCode;
    check(!(await exists(completionPath())), "Failed Backend startup was recorded as completed setup");
  } finally {
    occupied.closeAllConnections();
    await new Promise((done) => occupied.close(done));
  }
  report.checks.push("occupied Backend port fails setup without recording completion");

  stage = "failed setup recovery";
  await product(["setup", "--existing-account", "--non-interactive"], `${fixtureKey}\n`);
  await verifyReady("occupied-port recovery");
  await stopAndVerify();

  await prepareScenarioHome("fresh install user 测试");
  check(!(await exists(completionPath())) && !(await exists(pidPath())), "Fresh installation inherited lifecycle state");
  const freshNative = JSON.parse((await run(codexCommand, ["plugin", "list", "--available", "--json"])).stdout);
  check(!freshNative.installed.some((item) => item.pluginId === pluginId || item.name === pluginName),
    "Fresh installation inherited a native plugin registration");
  for (const attempt of ["fresh", "repeat"]) {
    stage = `${attempt} setup`;
    if (attempt === "fresh") {
      const interactive = await terminalSetup("complete");
      check(interactive.status === "PASS" && interactive.usernamePromptSeen && interactive.keyPromptSeen && interactive.credentialNotEchoed,
        "Interactive setup did not complete its native masked-key prompts");
    } else {
      await product(["setup", "--existing-account", "--non-interactive"], `${fixtureKey}\n`);
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
  check((await productJson(["start", "--clients", "codex", "--json"])).ok === true, "Start failed after stop");
  await verifyReady("stop/start");
  await verifyPreserved(savedMemoraxConfig);

  stage = "native uninstall";
  env.npm_config_prefix = npmPrefix;
  const uninstalled = await productJson(["uninstall", "--clients", "codex", "--json"]);
  check(uninstalled.ok === true && uninstalled.codexPlugin?.ok === true
    && uninstalled.npmPackageRemoval?.ok === true && uninstalled.npmPackageRemoval.skipped !== true,
  "Uninstall did not remove the native plugin and isolated npm package");
  check(!(await exists(entrypoint)) && !(await exists(completionPath())), "Uninstall retained package entrypoint or completion");
  await assertStopped();
  const nativeAfterRemoval = JSON.parse((await run(codexCommand, ["plugin", "list", "--available", "--json"])).stdout);
  check(!nativeAfterRemoval.installed.some((item) => item.pluginId === pluginId || item.name === pluginName),
    "Native plugin remains registered after uninstall");
  await verifyPreserved(savedMemoraxConfig);
  report.checks.push("native plugin and global npm package removed; provider, configuration and synthetic personal memory retained");

  stage = "npm reinstall";
  await npmInstall(candidateTarball);
  await product(["setup", "--existing-account", "--non-interactive"], `${fixtureKey}\n`);
  await verifyReady("reinstall");
  await verifyPreserved(savedMemoraxConfig);
  await stopAndVerify();

  // A second isolated home starts with the real previous published package.
  // Serve only the candidate package from an isolated scoped npm registry so
  // the real public updater selects this PR artifact instead of a public release.
  stage = "previous published version install";
  await prepareScenarioHome("upgrade user 测试");
  preservedMemory.clear();
  await npmInstall(`@memorax/memorax-code@${previousVersion}`);
  check((await readJson(join(packageRoot, "package.json"))).version === previousVersion, "Previous version was not installed");
  await product(["setup", "--existing-account", "--non-interactive"], `${fixtureKey}\n`);
  const previousStatus = await productJson(["status", "--clients", "codex", "--json"]);
  check(previousStatus.ok === true && previousStatus.backend?.ok === true && previousStatus.codexAdapter?.ok === true,
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
  const registryRequests = { manifest: 0, artifact: 0, rejectedArtifact: 0 };
  let rejectDownload = true;
  let registryUrl;
  registry = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    if (path === "/@memorax/memorax-code") {
      registryRequests.manifest += 1;
      const version = { ...manifest, dist: { tarball: `${registryUrl}/candidate.tgz`,
        shasum: createHash("sha1").update(artifact).digest("hex") } };
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
      response.writeHead(200, { "content-type": "application/octet-stream" }).end(artifact);
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
  const previousPid = (await readJson(pidPath())).pid;
  const previousCompletion = await readFile(completionPath(), "utf8");
  stage = "failed update artifact download";
  await rejectedProduct(["update", "--latest"]);
  check(registryRequests.rejectedArtifact > 0, "The failed updater did not reach the rejected artifact download");
  check((await readJson(join(packageRoot, "package.json"))).version === previousVersion,
    "A failed artifact download changed the installed package version");
  check((await productJson(["status", "--clients", "codex", "--json"])).backend?.ok === true
    && (await readJson(pidPath())).pid === previousPid,
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
  await verifyPreserved(upgradeConfig);
  check(!(await exists(join(stateHome, "runtime", "install", "package-transition.json"))),
    "Successful replacement retained pending transition authority");
  report.upgrade = { from: previousVersion, to: expectedPackageVersion, mechanism: "public update --latest with candidate scoped registry" };
  report.checks.push("real terminal update --latest upgraded the running previous release to the candidate with configuration and synthetic memory retained");
  stage = "outbound isolation";
  check(requests === 0, "Installation unexpectedly contacted the model or MemoraX endpoint");
  report.checks.push("no model or MemoraX requests");
  report.status = "PASS";
} catch (error) {
  report.stage = stage;
  report.error = error.smokeMessage ?? "The stage failed; private command output was suppressed";
  if (typeof error.code === "number") report.exitCode = error.code;
  if (["ENOENT", "ENOEXEC", "EACCES", "EPERM", "EINVAL", "ETIMEDOUT"].includes(error.code)) report.nativeErrorCode = error.code;
  if (error.diagnosticCode) report.diagnosticCode = error.diagnosticCode;
  if (error.terminalError) report.terminalError = error.terminalError;
  if (error.terminalDiagnostics) report.terminalDiagnostics = error.terminalDiagnostics;
  if (error.terminalNativeError) report.terminalNativeError = error.terminalNativeError;
} finally {
  try {
    if (setupStarted) {
      if (await exists(entrypoint)) await stopAndVerify();
      else await assertStopped();
      report.checks.push("Backend stopped, process exited and port released");
    }
    if (root) await rm(root, { recursive: true, force: true });
    report.cleanup = "PASS";
  } catch {
    report.status = "FAIL";
    report.cleanup = "FAIL: isolated state retained because shutdown was not confirmed";
  }
  for (const server of [endpoint, registry]) {
    if (!server?.listening) continue;
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
}
console.log(JSON.stringify(report, null, 2));
if (report.status !== "PASS") process.exitCode = 1;

async function verifyReady(attempt) {
  stage = `${attempt} native registration`;
  const native = JSON.parse((await run(env.CODEX_CLI_PATH, ["plugin", "list", "--available", "--json"])).stdout);
  check(Array.isArray(native.installed), "Codex did not return an installed plugin list");
  const matches = native.installed.filter((item) => item.name === pluginName || item.pluginId === pluginId);
  check(matches.length === 1, "Codex must register exactly one MemoraX Code plugin");
  const registration = matches[0];
  check(registration.pluginId === pluginId && registration.installed === true && registration.enabled === true,
    "The native plugin registration is missing, disabled, or has an unexpected identity");
  check(registration.version === expectedPluginVersion, "The native plugin version differs from the installed package");

  stage = `${attempt} native hooks`;
  const hooks = await productJson(["codex-plugin", "hooks", "--json"]);
  check(hooks.ok === true && Array.isArray(hooks.hooks), "Codex did not return plugin Hooks");
  check(JSON.stringify(hooks.hooks.map((hook) => hook.eventName).sort()) === JSON.stringify(expectedEvents),
    "Native Hook events differ from the installed Hook manifest");
  check(hooks.hooks.every((hook) => hook.pluginId === pluginId
    && ["trusted", "managed"].includes(hook.trustStatus)), "Some native plugin Hooks are not trusted");
  const trust = await productJson(["codex-plugin", "trust-hooks", "--check", "--json"]);
  check(trust.ok === true && trust.checkedOnly === true && trust.hooks.length === 0
    && trust.requiresFullReview === false, "Hook trust still requires review after setup");

  stage = `${attempt} readiness`;
  const completion = await readJson(join(stateHome, "runtime", "setup", "setup-completion.json"));
  check(completion.version === 1 && completion.state === "complete"
    && completion.completedByVersion === expectedPackageVersion, "Setup did not record completion for this package");
  const memorax = parse(await readFile(join(stateHome, "config.toml"), "utf8")).memorax;
  check(memorax?.api_key === fixtureKey && memorax.endpoint === env.MEMORAX_CODE_MEMORAX_ENDPOINT,
    "Setup did not preserve the exact supplied credential and endpoint");
  const status = await productJson(["status", "--clients", "codex", "--json"]);
  check(status.ok === true && status.backend?.ok === true, "The installed Backend is not healthy");
  check(status.codexAdapter?.ok === true && status.codexAdapter.enabled === true
    && status.codexAdapter.backendUrlMatches === true, "The Codex adapter is not connected to this Backend");
  const skill = status.codexAdapter.codexSkills;
  check(skill?.ok === true && skill.delivery === "plugin" && typeof skill.rootPath === "string",
    "The Codex adapter does not expose its packaged Skill");
  const skillRelative = relative(codexHome, skill.rootPath);
  check(skillRelative !== ".." && !skillRelative.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
    && !isAbsolute(skillRelative), "The installed Skill escaped the isolated Codex home");
  const installedSkill = await readFile(join(skill.rootPath, "memorax-code", "SKILL.md"), "utf8");
  check(installedSkill === await readFile(join(sourceRoot, "skills", "memorax-code", "SKILL.md"), "utf8"),
    "The installed Skill differs from the packaged Skill");
  const config = parse(await readFile(join(codexHome, "config.toml"), "utf8"));
  check(config.model === originalProvider.model && config.model_provider === originalProvider.model_provider
    && JSON.stringify(config.model_providers) === JSON.stringify(originalProvider.model_providers),
  "Setup changed the existing Codex model configuration");
  const backend = await readJson(join(stateHome, "runtime", "backend", "backend.pid.json"));
  check(Number.isInteger(backend.pid) && backend.pid > 0, "Backend PID record is invalid");
  backendPids.add(backend.pid);
  report.checks.push(`${attempt}: native plugin, trusted Hooks, packaged Skill, Backend and completion verified`);
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
async function stopAndVerify() {
  await rememberPid();
  check((await productJson(["stop", "--clients", "codex", "--json"])).ok === true, "Backend stop did not succeed");
  await assertStopped();
}
async function assertStopped() {
  check(!(await exists(pidPath())), "Backend PID record remains after stop");
  for (const pid of backendPids) {
    let alive = true;
    try { process.kill(pid, 0); } catch (error) { if (error.code === "ESRCH") alive = false; else throw error; }
    check(!alive, "An installation Backend process remains after stop");
  }
  const probe = createTcpServer();
  await new Promise((done, reject) => { probe.once("error", reject); probe.listen(backendPort, "127.0.0.1", done); });
  await new Promise((done) => probe.close(done));
  backendPids.clear();
}
async function verifyPreserved(config) {
  // Upgrades may add defaults or rewrite TOML formatting, but every existing
  // configured value must retain its meaning.
  const mismatch = changedConfigField(parse(await readFile(join(stateHome, "config.toml"), "utf8")), parse(config));
  check(mismatch === undefined, `Lifecycle changed the existing MemoraX configuration field: ${mismatch}`);
  const codex = parse(await readFile(join(codexHome, "config.toml"), "utf8"));
  check(codex.model === originalProvider.model && codex.model_provider === originalProvider.model_provider
    && JSON.stringify(codex.model_providers) === JSON.stringify(originalProvider.model_providers),
  "Lifecycle changed the existing Codex provider configuration");
  for (const [path, contents] of preservedMemory) check(await readFile(path, "utf8") === contents, "Lifecycle changed retained personal memory");
}
function changedConfigField(actual, expected, prefix = "config") {
  if (expected && typeof expected === "object" && !Array.isArray(expected) && !(expected instanceof Date)) {
    if (!actual || typeof actual !== "object") return prefix;
    for (const [key, value] of Object.entries(expected)) {
      const mismatch = changedConfigField(actual[key], value, `${prefix}.${key}`);
      if (mismatch !== undefined) return mismatch;
    }
    return undefined;
  }
  return isDeepStrictEqual(actual, expected) ? undefined : prefix;
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
  try {
    return JSON.parse((await run(process.execPath, [ptyScript, ptyPackage, entrypoint, mode],
      JSON.stringify({ username: "install-smoke", apiKey: fixtureKey }))).stdout);
  } catch (error) {
    // The helper emits only a bounded safe JSON report; raw terminal output
    // stays private even when a test assertion or native terminal launch fails.
    try {
      const safe = JSON.parse(error.stdout);
      if (/^[A-Z][A-Z0-9_]{1,79}$/.test(safe.error)) error.terminalError = safe.error;
      error.terminalDiagnostics = Object.fromEntries([
        "usernamePromptSeen", "keyPromptSeen", "languagePromptSeen", "outputBytes", "cursorPositionReplies", "exitCode", "signal",
      ].filter((key) => typeof safe[key] === "boolean" || Number.isFinite(safe[key])).map((key) => [key, safe[key]]));
      if (/^[A-Z][A-Z0-9_]{1,79}$/.test(safe.nativeErrorCode)) error.terminalNativeError = safe.nativeErrorCode;
    } catch {}
    throw error;
  }
}
async function npmInstall(specifier) {
  await run(npmCommand, ["install", "--global", "--prefix", npmPrefix, "--no-audit", "--no-fund", specifier]);
}

function check(condition, message) {
  if (!condition) throw Object.assign(new Error(message), { smokeMessage: message });
}

async function readJson(path) { return JSON.parse(await readFile(path, "utf8")); }

async function run(command, args, input = "") {
  const invocation = process.platform === "win32" && command === npmCommand
    ? resolveNpmInvocation(args, { env }) : resolveInvocation(command, args, { env });
  const pending = execFileAsync(invocation.command, invocation.args, {
    cwd: workspace, env, timeout: 120_000, maxBuffer: 4 * 1024 * 1024, encoding: "utf8", windowsHide: true,
  });
  pending.child.stdin.on("error", () => {});
  pending.child.stdin.end(input);
  let result;
  try { result = await pending; }
  catch (error) {
    // Report only the stable product error code, never raw process output.
    check(!`${error.stdout ?? ""}\n${error.stderr ?? ""}`.includes(fixtureKey), "A failing command disclosed the setup credential");
    error.diagnosticCode = `${error.stdout ?? ""}\n${error.stderr ?? ""}`.match(/\b(?:CLIENT|CODEX|BACKEND|SETUP|CONFIG|UPDATE|PACKAGE|INSTALL)_[A-Z_]{3,}\b/)?.[0];
    throw error;
  }
  check(!`${result.stdout}\n${result.stderr}`.includes(fixtureKey), "A command disclosed the setup credential");
  return result;
}

function product(args, input) { return run(process.execPath, [entrypoint, ...args], input); }
async function productJson(args) { return JSON.parse((await product(args)).stdout); }

async function freePort() {
  const server = createTcpServer();
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}

function isolatedEnv(userHome, codexCommand, dummyUrl) {
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
    MEMORAX_CODE_MEMORAX_ENDPOINT: dummyUrl, MEMORAX_CODE_MEMORAX_WRITEBACK_ENABLED: "false",
    CODEX_HOME: codexHome, CODEX_CLI_PATH: codexCommand, MEMORAX_CODE_CODEX_COMMAND: codexCommand,
    DSH_HOME: join(userHome, ".dsh"), CLAUDE_CONFIG_DIR: join(userHome, ".claude"), CLAUDE_HOME: join(userHome, ".claude"),
    OPENCODE_CONFIG_DIR: join(userHome, ".config", "opencode"),
    CODEBUDDY_HOME: join(userHome, ".codebuddy"), CODEBUDDY_CONFIG_DIR: join(userHome, ".codebuddy"),
    WORKBUDDY_HOME: join(userHome, ".workbuddy"), WORKBUDDY_CONFIG_DIR: join(userHome, ".workbuddy"),
    TRAE_CN_HOME: join(userHome, ".trae-cn"), TRAE_HOME: join(userHome, ".trae-cn"), CURSOR_HOME: join(userHome, ".cursor"),
    MEMORAX_CODE_CODEX_TRACE_ENABLED: "false",
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
