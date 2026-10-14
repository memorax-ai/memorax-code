#!/usr/bin/env node
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { createServer as createTcpServer } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertBackendReplacement, assertCredentialNotEchoed, assertProtectedConfiguration,
  snapshotProtectedConfiguration } from "../codex/codex-lifecycle-assertions.mjs";
import { classifyLifecycleRequest } from "../claude/claude-lifecycle-assertions.mjs";
import { startLifecycleCommand } from "../claude/claude-lifecycle-process.mjs";
import { snapshotCursorHooks, assertCursorHooks, verifyCursorLifecycleIntegration,
  assertCursorLifecycleIntegrationAbsent } from "./cursor-lifecycle-assertions.mjs";
import { cursorInterruptionPhases } from "./cursor-lifecycle-interruption.mjs";

const fixtureKey = `sk_${"C".repeat(43)}`, fixtureUser = "cursor-lifecycle-saved-account";
const searchMemory = "CURSOR_LIFECYCLE_SAVED_ACCOUNT_RESULT";
const scripts = dirname(fileURLToPath(import.meta.url));
const otherClients = ["codex", "claude", "opencode", "dsh", "codebuddy", "workbuddy", "trae"];
function check(value, code) { if (!value) throw Object.assign(new Error(code), { testCode: code }); }
async function exists(path) {
  try { await lstat(path); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}
async function json(path) { return JSON.parse(await readFile(path, "utf8")); }
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; }
}
async function freePort() {
  const server = createTcpServer();
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}

export async function runCursorLifecycleCheck(candidatePath, reportDirectory, previousVersion = "0.1.18") {
  const report = { status: "FAIL", suite: "cursor_lifecycle", client: "cursor", platform: process.platform,
    node: process.versions.node, stage: "prerequisites", checks: [] };
  let root, output, env, workspace, stateHome, cursorHome, npmCli, prefix, packageRoot, entrypoint, parse;
  let candidate, manifest, port, endpoint, registry, savedEndpoint, expectedHooks;
  let installationStarted = false, allowSearch = false, commandsClean = true, cleanupPromise, interrupted;
  let unexpectedRequests = 0, malformedRequests = 0;
  const commands = new Set(), backendPids = new Set(), preserved = new Map(), searches = [];
  const ptyScript = join(scripts, "../codex/codex-setup-pty.mjs");
  const interruptionScript = join(scripts, "cursor-lifecycle-interruption-cli.mjs");
  const completionPath = () => join(stateHome, "runtime/setup/setup-completion.json");
  const pidPath = () => join(stateHome, "runtime/backend/backend.pid.json");
  const transitionPath = () => join(stateHome, "runtime/install/package-transition.json");
  const signalHandlers = new Map(["SIGINT", "SIGTERM"].map((signal) => [signal, () => {
    if (interrupted) return;
    interrupted = signal;
    report.status = "FAIL"; report.error = "CURSOR_LIFECYCLE_INTERRUPTED";
    const timer = setTimeout(() => process.exit(signal === "SIGINT" ? 130 : 143), 60_000);
    void cleanup().finally(async () => {
      if (output) await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
      clearTimeout(timer); process.exit(signal === "SIGINT" ? 130 : 143);
    });
  }]));
  for (const [signal, handler] of signalHandlers) process.on(signal, handler);
  try {
    check(typeof reportDirectory === "string" && typeof candidatePath === "string"
      && /^\d+\.\d+\.\d+$/.test(previousVersion), "CURSOR_LIFECYCLE_ARGUMENTS");
    const destination = resolve(reportDirectory);
    await mkdir(destination, { recursive: true, mode: 0o700 });
    check(!(await lstat(destination)).isSymbolicLink() && (await readdir(destination)).length === 0,
      "CURSOR_LIFECYCLE_REPORT_DIRECTORY");
    output = destination;
    candidate = resolve(candidatePath);
    const info = await lstat(candidate);
    check(info.isFile() && !info.isSymbolicLink(), "CURSOR_LIFECYCLE_CANDIDATE");
    check(fixtureUser !== userInfo().username, "CURSOR_LIFECYCLE_ACCOUNT_FIXTURE");
    const temporary = process.env.RUNNER_TEMP ?? tmpdir();
    check(isAbsolute(temporary), "CURSOR_LIFECYCLE_TEMP_DIRECTORY");
    root = await realpath(await mkdtemp(join(temporary, "cursor-lifecycle-")));
    prefix = join(root, "npm");
    packageRoot = join(prefix, process.platform === "win32" ? "node_modules" : "lib/node_modules", "@memorax/memorax-code");
    entrypoint = join(packageRoot, "bin/memorax-code.mjs");
    const nodeDirectory = dirname(await realpath(process.execPath));
    for (const path of [join(nodeDirectory, "node_modules/npm/bin/npm-cli.js"),
      join(nodeDirectory, "../lib/node_modules/npm/bin/npm-cli.js")]) {
      if (await exists(path)) { npmCli = path; break; }
    }
    check(npmCli, "CURSOR_LIFECYCLE_NPM_UNAVAILABLE");
    port = await freePort();
    endpoint = createServer(async (request, response) => {
      const kind = classifyLifecycleRequest(request.method, request.url, allowSearch);
      if (kind === "connectivity") { response.writeHead(200).end(); return; }
      if (kind !== "search") { unexpectedRequests++; response.writeHead(503).end(); return; }
      try {
        let raw = "";
        for await (const chunk of request) {
          raw += chunk;
          check(Buffer.byteLength(raw) <= 32768, "CURSOR_LIFECYCLE_REQUEST_SIZE");
        }
        searches.push({ method: request.method, path: request.url, authorization: request.headers.authorization,
          body: JSON.parse(raw) });
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ success: true,
          data: { task_id: "cursor-lifecycle-search", status: "completed", data: [
            { id: "cursor-lifecycle", memory: searchMemory, score: 0.95, metadata: { memory_type: "procedural" } },
          ] } }));
      } catch { malformedRequests++; response.writeHead(400).end(); }
    });
    await new Promise((done, reject) => { endpoint.once("error", reject); endpoint.listen(0, "127.0.0.1", done); });
    savedEndpoint = `http://127.0.0.1:${endpoint.address().port}/saved-account`;
    await mkdir(join(root, "tmp"));
    for (const name of ["user.npmrc", "global.npmrc"]) await writeFile(join(root, name), "", { mode: 0o600 });
    await prepareHome("fresh-user");
    report.stage = "candidate-install";
    installationStarted = true;
    await npmInstall(candidate);
    check(!(await exists(completionPath())) && !(await exists(pidPath())), "CURSOR_LIFECYCLE_INSTALL_STARTED_BACKEND");
    manifest = await json(join(packageRoot, "package.json"));
    check(manifest.name === "@memorax/memorax-code" && /^\d+\.\d+\.\d+$/.test(manifest.version)
      && manifest.version !== previousVersion, "CURSOR_LIFECYCLE_PACKAGE_VERSION");
    report.packageVersion = manifest.version; report.previousVersion = previousVersion;
    ({ parse } = createRequire(join(packageRoot, "package.json"))("smol-toml"));
    report.stage = "terminal-install";
    await npm(["install", "--prefix", join(root, "terminal"), "--no-audit", "--no-fund", "node-pty@1.1.0"]);
    report.stage = "fresh-setup";
    await terminal("complete");
    await ready();
    report.checks.push("fresh_setup");
    await seedMemory();
    const savedConfig = snapshotProtectedConfiguration(parse(await readFile(join(stateHome, "config.toml"), "utf8")));
    report.stage = "repeat-setup";
    await terminal("reuse"); await ready(); await retained(savedConfig);
    report.checks.push("repeat_setup_saved_account");
    report.stage = "uninstall";
    const uninstalled = await productJson(["uninstall", "--clients", "cursor", "--json"]);
    check(uninstalled.ok === true && uninstalled.cursorPlugin?.ok === true && uninstalled.npmPackageRemoval?.ok === true
      && uninstalled.npmPackageRemoval.skipped !== true, "CURSOR_LIFECYCLE_UNINSTALL");
    check(!(await exists(entrypoint)) && !(await exists(completionPath())), "CURSOR_LIFECYCLE_UNINSTALL_REMAINS");
    await stopped();
    await assertCursorLifecycleIntegrationAbsent({ cursorHome, stateHome });
    await retained(savedConfig);
    report.checks.push("uninstall_preserves_account_and_user_files");
    report.stage = "reinstall";
    await npmInstall(candidate); await terminal("reuse"); await ready(); await retained(savedConfig);
    await savedAccountSearch();
    report.checks.push("reinstall_without_account_input");
    await stop();

    report.stage = "previous-version-install";
    await prepareHome("upgrade user");
    await npmInstall(`@memorax/memorax-code@${previousVersion}`);
    check((await json(join(packageRoot, "package.json"))).version === previousVersion, "CURSOR_LIFECYCLE_PREVIOUS_VERSION");
    await terminal("complete");
    // The published baseline predates Cursor support; verify its Backend before upgrading the integration.
    const oldStatus = await productJson(["status", "--clients", "none", "--json"]);
    check(oldStatus.ok === true && oldStatus.backend?.ok === true
      && (await json(completionPath())).completedByVersion === previousVersion, "CURSOR_LIFECYCLE_PREVIOUS_NOT_READY");
    await rememberPid(); await seedMemory();
    const upgradeConfig = snapshotProtectedConfiguration(parse(await readFile(join(stateHome, "config.toml"), "utf8")));
    registry = await createCursorLifecycleRegistry(manifest, await readFile(candidate));
    await writeFile(join(root, "user.npmrc"), `@memorax:registry=${registry.url}\n`, { mode: 0o600 });
    env.npm_config_cache = join(root, "update-cache");
    const oldBackend = await json(pidPath()), oldCompletion = await readFile(completionPath(), "utf8");
    report.stage = "download-failure";
    registry.rejectDownload = true;
    await rejectProduct(["update", "--latest"]);
    check(registry.counts.rejected > 0 && (await json(join(packageRoot, "package.json"))).version === previousVersion,
      "CURSOR_LIFECYCLE_DOWNLOAD_FAILURE_NOT_OBSERVED");
    check((await productJson(["status", "--clients", "none", "--json"])).backend?.ok === true
      && (await json(pidPath())).pid === oldBackend.pid && await readFile(completionPath(), "utf8") === oldCompletion,
    "CURSOR_LIFECYCLE_DOWNLOAD_FAILURE_CHANGED_BACKEND");
    await retained(upgradeConfig);
    report.checks.push("download_failure_keeps_previous_install");
    report.stage = "previous-version-upgrade";
    registry.rejectDownload = false;
    await terminal("update"); await ready(); await replaced(oldBackend); await retained(upgradeConfig);
    check(registry.counts.manifest > 0 && registry.counts.artifact > 0, "CURSOR_LIFECYCLE_REGISTRY_NOT_USED");
    report.checks.push("previous_version_upgraded_to_candidate");
    report.stage = "candidate-force-update";
    const candidateBackend = await json(pidPath()), beforeArtifact = registry.counts.artifact;
    env.npm_config_cache = join(root, "candidate-update-cache");
    await terminal("force-update"); await ready(); await replaced(candidateBackend); await retained(upgradeConfig);
    check(registry.counts.artifact > beforeArtifact, "CURSOR_LIFECYCLE_CANDIDATE_NOT_FETCHED");
    await savedAccountSearch();
    report.checks.push("candidate_updater_replaces_live_backend");

    report.stage = "replacement-failure";
    const replacementBackend = await json(pidPath()), faultMarker = join(root, "replacement-fault.json");
    const fault = await makeCursorReplacementFault({ packageRoot, root, faultMarker, oldPid: replacementBackend.pid, npm });
    registry.setArtifact(fault.manifest, await readFile(fault.tarball));
    env.npm_config_cache = join(root, "replacement-fault-cache");
    const diagnosticsRoot = join(stateHome, "runtime/diagnostics");
    const beforeDiagnostics = new Set(await exists(diagnosticsRoot) ? await readdir(diagnosticsRoot) : []);
    const failure = await rejectProduct(["update", "--latest", "--force"]);
    check(failure.diagnosticCode === "UPDATE_INSTALL_FAILED", "CURSOR_LIFECYCLE_REPLACEMENT_DIAGNOSTIC");
    const evidence = await json(faultMarker);
    check(evidence.stage === "postinstall" && evidence.transitionState === "retired" && evidence.oldBackendStopped === true
      && evidence.candidateVersion === manifest.version, "CURSOR_LIFECYCLE_REPLACEMENT_NOT_REACHED");
    const diagnostics = await Promise.all((await readdir(diagnosticsRoot))
      .filter((name) => /^mc-.*\.json$/.test(name) && !beforeDiagnostics.has(name)).map((name) => json(join(diagnosticsRoot, name))));
    const diagnostic = diagnostics.find((item) => item.operation === "update" && item.errorCode === "UPDATE_INSTALL_FAILED"
      && item.commandExitCode === 23 && ["restored", "failed"].includes(item.recoveryStatus));
    check(diagnostic, "CURSOR_LIFECYCLE_RECOVERY_DIAGNOSTIC");
    await retained(upgradeConfig);
    if (diagnostic.recoveryStatus === "failed") {
      check((await json(transitionPath())).state === "retired", "CURSOR_LIFECYCLE_TRANSITION_LOST");
      await product(["update", "--recover"]);
    }
    await ready(); await replaced(replacementBackend); await retained(upgradeConfig);
    report.replacementFailure = { injectedExitCode: 23, diagnosticCode: "UPDATE_INSTALL_FAILED",
      recoveryStatus: diagnostic.recoveryStatus, originalCommandFailed: true };
    report.checks.push("postinstall_failure_recovered_after_backend_retirement");
    report.stage = "replacement-retry";
    registry.setArtifact(manifest, await readFile(candidate));
    env.npm_config_cache = join(root, "replacement-retry-cache");
    const recoveredBackend = await json(pidPath());
    await terminal("force-update"); await ready(); await replaced(recoveredBackend); await retained(upgradeConfig);
    check((await json(join(packageRoot, "package.json"))).scripts.postinstall === manifest.scripts.postinstall,
      "CURSOR_LIFECYCLE_FAULT_SCRIPT_REMAINS");
    await savedAccountSearch();
    report.checks.push("retry_restores_unmodified_candidate");
    await stop();
    report.setupInterruption = [];
    for (const phase of cursorInterruptionPhases) {
      report.stage = `setup-interruption-${phase}`;
      const result = { id: phase, status: "FAIL" };
      report.setupInterruption.push(result);
      await prepareHome(`interruption-${phase}`);
      const configPath = join(stateHome, "config.toml");
      await writeFile(configPath, `[memorax]\nendpoint = ${JSON.stringify(savedEndpoint)}\nuser_id = ${JSON.stringify(fixtureUser)}\napi_key = ${JSON.stringify(fixtureKey)}\n`
        + (await readFile(configPath, "utf8")).replace("cursor = true", "cursor = true \t"), { mode: 0o600 });
      await seedMemory();
      const protectedConfig = snapshotProtectedConfiguration(parse(await readFile(configPath, "utf8")));
      try {
        const { status, ...interruption } = JSON.parse((await run([interruptionScript, packageRoot,
          join(root, "terminal/node_modules/node-pty"), phase])).stdout);
        check(status === "PASS", "CURSOR_LIFECYCLE_INTERRUPTION_FAILED");
        Object.assign(result, interruption);
      } catch (error) {
        try { if (JSON.parse(error.stdout).cleanupFailed === true) commandsClean = false; } catch {}
        throw error;
      }
      await retained(protectedConfig);
      report.stage = `setup-recovery-${phase}`;
      await terminal("reuse"); await ready(); await retained(protectedConfig); await savedAccountSearch(); await stop();
      Object.assign(result, { status: "PASS", retryWithoutAccountInput: true, cursorIntegrationVerified: true,
        savedAccountRequestVerified: true, cleanup: "PASS" });
    }
    report.checks.push("four_stage_setup_interruption_recovery");
    check(!interrupted, "CURSOR_LIFECYCLE_INTERRUPTED");
    report.status = "PASS"; report.stage = "complete";
  } catch (error) {
    report.error = /^(?:CURSOR_LIFECYCLE|PROTECTED|BACKEND_REPLACEMENT|INSTALL|TERMINAL)_[A-Z0-9_]+$/.test(error.testCode ?? error.message)
      ? (error.testCode ?? error.message) : "CURSOR_LIFECYCLE_FAILED_PRIVATE_OUTPUT_SUPPRESSED";
    if (error.diagnosticCode) report.diagnosticCode = error.diagnosticCode;
    if (Number.isInteger(error.code) && error.code >= 0 && error.code <= 0xffffffff) report.commandExitCode = error.code;
    if (["ENOENT", "ENOEXEC", "EACCES", "EPERM", "ETIMEDOUT"].includes(error.code)) report.systemCode = error.code;
  } finally {
    await cleanup();
    report.requests = { unexpected: unexpectedRequests, malformed: malformedRequests, savedAccountSearch: searches.length };
    if (report.status === "PASS" && (unexpectedRequests !== 0 || malformedRequests !== 0 || searches.length !== 7)) {
      report.status = "FAIL"; report.error = "CURSOR_LIFECYCLE_REQUEST_AUDIT";
    }
    for (const [signal, handler] of signalHandlers) process.off(signal, handler);
    if (output) await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  }
  return report;

  async function run(args, input = "", cleanupCommand = false) {
    check(!interrupted || cleanupCommand, "CURSOR_LIFECYCLE_INTERRUPTED");
    const pending = startLifecycleCommand(process.execPath, args, { cwd: workspace, env, input,
      timeoutMs: cleanupCommand ? 15000 : 180000, terminal: args[0] === ptyScript || args[0] === interruptionScript });
    commands.add(pending);
    try {
      const result = await pending.result;
      assertCredentialNotEchoed(result.stdout + result.stderr, fixtureKey);
      return result;
    } catch (error) {
      if (error.cleanupFailed) commandsClean = false;
      assertCredentialNotEchoed((error.stdout ?? "") + (error.stderr ?? ""), fixtureKey);
      error.diagnosticCode = `${error.stdout ?? ""}\n${error.stderr ?? ""}`.match(/\b(?:CURSOR|BACKEND|SETUP|CONFIG|UPDATE|PACKAGE|INSTALL|MEMORY)_[A-Z_]{3,}\b/)?.[0];
      throw error;
    } finally { commands.delete(pending); }
  }
  async function npm(args) { return run([npmCli, ...args]); }
  async function npmInstall(specifier) {
    return npm(["install", "--global", "--prefix", prefix, "--no-audit", "--no-fund", specifier]);
  }
  async function product(args, cleanupCommand = false) { return run([entrypoint, ...args], "", cleanupCommand); }
  async function productJson(args) { return JSON.parse((await product(args)).stdout); }
  async function rejectProduct(args) {
    try { await product(args); } catch (error) {
      check(!error.cleanupFailed && Number.isInteger(error.code) && error.code !== 0,
        "CURSOR_LIFECYCLE_EXPECTED_PRODUCT_REJECTION");
      return error;
    }
    check(false, "CURSOR_LIFECYCLE_UNEXPECTED_SUCCESS");
  }
  async function terminal(mode) {
    if (mode === "complete") env.MEMORAX_CODE_MEMORAX_ENDPOINT = savedEndpoint;
    try {
      const result = JSON.parse((await run([ptyScript, join(root, "terminal/node_modules/node-pty"), entrypoint, mode],
        JSON.stringify({ username: fixtureUser, apiKey: fixtureKey }))).stdout);
      check(result.status === "PASS" && result.credentialNotEchoed === true && result.exitCode === 0,
        "CURSOR_LIFECYCLE_TERMINAL_FAILED");
      if (mode !== "complete") check(result.accountInputSent === false, "CURSOR_LIFECYCLE_ACCOUNT_INPUT_REPEATED");
    } catch (error) {
      try {
        const result = JSON.parse(error.stdout);
        if (/^[A-Z][A-Z0-9_]{1,79}$/.test(result.error)) report.terminalError = result.error;
        if (["ENOENT", "ENOEXEC", "EACCES", "EPERM", "PTY_SPAWN_FAILED"].includes(result.nativeErrorCode)) {
          report.terminalNativeError = result.nativeErrorCode;
        }
      } catch {}
      throw error;
    } finally { delete env.MEMORAX_CODE_MEMORAX_ENDPOINT; }
  }
  async function prepareHome(name) {
    const home = join(root, name);
    stateHome = join(home, ".memorax-code"); cursorHome = join(home, ".cursor"); workspace = join(home, "workspace-fixture");
    env = cursorLifecycleEnvironment({ root, home, stateHome, cursorHome, prefix, npmCli, port });
    for (const path of [workspace, stateHome, cursorHome]) await mkdir(path, { recursive: true });
    await writeFile(join(stateHome, "config.toml"), ["[clients]", "cursor = true", ...otherClients.map((name) => `${name} = false`),
      "[memory.writeback]", "enabled = false", "[jev]", "enabled = false", ""].join("\n"), { mode: 0o600 });
    const hooks = { version: 1, customSetting: "preserved", hooks: { stop: [{ command: "user-owned-hook" }] } };
    expectedHooks = snapshotCursorHooks(hooks);
    await writeFile(join(cursorHome, "hooks.json"), JSON.stringify(hooks));
    preserved.clear();
    const userFiles = [[join(cursorHome, "mcp.json"), '{"mcpServers":{},"fixture":"preserved"}\n'],
      [join(cursorHome, "skills/user-fixture/SKILL.md"), "User-owned fixture Skill.\n"],
      [join(cursorHome, "agents/user-fixture.md"), "User-owned fixture agent.\n"]];
    for (const [path, text] of userFiles) {
      await mkdir(dirname(path), { recursive: true }); await writeFile(path, text); preserved.set(path, text);
    }
  }
  async function seedMemory() {
    for (const name of ["user-profile/preferences.md", "procedure-memory/lifecycle.md"]) {
      const path = join(stateHome, "personal-memory", name), text = "Synthetic retained personal memory.\n";
      await mkdir(dirname(path), { recursive: true }); await writeFile(path, text); preserved.set(path, text);
    }
  }
  async function retained(snapshot) {
    assertProtectedConfiguration(parse(await readFile(join(stateHome, "config.toml"), "utf8")), snapshot);
    assertCursorHooks(await json(join(cursorHome, "hooks.json")), expectedHooks);
    for (const [path, text] of preserved) check(await readFile(path, "utf8") === text, "CURSOR_LIFECYCLE_USER_FILE_CHANGED");
  }
  async function ready() {
    const completion = await json(completionPath());
    check((await json(join(packageRoot, "package.json"))).version === manifest.version
      && completion.version === 1 && completion.state === "complete"
      && completion.completedByVersion === manifest.version, "CURSOR_LIFECYCLE_COMPLETION_VERSION");
    check(!Object.hasOwn(env, "MEMORAX_CODE_MEMORAX_ENDPOINT") && !Object.hasOwn(env, "MEMORAX_CODE_MEMORAX_API_KEY")
      && !Object.hasOwn(env, "MEMORAX_CODE_MEMORAX_USER_ID"), "CURSOR_LIFECYCLE_ACCOUNT_OVERRIDE");
    const config = parse(await readFile(join(stateHome, "config.toml"), "utf8"));
    check(config.memorax?.api_key === fixtureKey && config.memorax?.user_id === fixtureUser
      && config.memorax?.endpoint === savedEndpoint && config.memory?.writeback?.enabled === false
      && config.jev?.enabled === false && config.clients?.cursor === true
      && otherClients.every((name) => config.clients?.[name] === false), "CURSOR_LIFECYCLE_SAVED_CONFIGURATION");
    const status = await productJson(["status", "--clients", "cursor", "--json"]);
    check(status.ok === true && status.backend?.ok === true, "CURSOR_LIFECYCLE_BACKEND_NOT_READY");
    await verifyCursorLifecycleIntegration({ packageRoot, cursorHome, stateHome, adapter: status.cursorAdapter });
    await rememberPid();
  }
  async function rememberPid() {
    if (await exists(pidPath())) {
      const { pid } = await json(pidPath());
      check(Number.isSafeInteger(pid) && pid > 0, "CURSOR_LIFECYCLE_PID_INVALID");
      backendPids.add(pid);
    }
  }
  async function replaced(before) {
    const after = await json(pidPath());
    check(after.url === `http://127.0.0.1:${port}`, "CURSOR_LIFECYCLE_BACKEND_ENDPOINT");
    const response = await fetch(new URL("/health", after.url), { signal: AbortSignal.timeout(5000) });
    check(response.ok && alive(after.pid), "CURSOR_LIFECYCLE_BACKEND_HEALTH");
    assertBackendReplacement(before, after, await response.json(), alive(before.pid));
    backendPids.delete(before.pid);
    check(!(await exists(transitionPath())), "CURSOR_LIFECYCLE_TRANSITION_REMAINS");
  }
  async function savedAccountSearch() {
    const query = "Verify the retained synthetic Cursor lifecycle account.", before = searches.length;
    let result;
    allowSearch = true;
    try { result = JSON.parse((await run([join(packageRoot, "bin/memorax-cli.mjs"), "search", "--query", query, "--json"])).stdout); }
    finally { allowSearch = false; }
    const request = searches[before], user = `${fixtureUser}@workspace-fixture`;
    check(searches.length === before + 1 && request?.method === "POST"
      && request.path === "/saved-account/v1/memories/search" && request.authorization === `Token ${fixtureKey}`
      && request.body.user_id === user && request.body.query === query && !Object.hasOwn(request.body, "session_id"),
    "CURSOR_LIFECYCLE_SAVED_ACCOUNT_REQUEST");
    check(result.ok === true && result.action === "memory.search" && result.query === query
      && result.baseUserId === fixtureUser && result.effectiveUserId === user
      && result.items?.length === 1 && result.items[0].memory === searchMemory && result.receipt?.accepted === true,
    "CURSOR_LIFECYCLE_SAVED_ACCOUNT_RESULT");
  }
  async function stopped() {
    check(!(await exists(pidPath())), "CURSOR_LIFECYCLE_PID_RECORD_REMAINS");
    for (const pid of backendPids) check(Number.isSafeInteger(pid) && pid > 0 && !alive(pid), "CURSOR_LIFECYCLE_BACKEND_REMAINS");
    const probe = createTcpServer();
    await new Promise((done, reject) => { probe.once("error", reject); probe.listen(port, "127.0.0.1", done); });
    await new Promise((done) => probe.close(done));
    backendPids.clear();
  }
  async function stop() {
    await rememberPid();
    check(JSON.parse((await product(["stop", "--clients", "none", "--json"], true)).stdout).ok === true,
      "CURSOR_LIFECYCLE_STOP_FAILED");
    await stopped();
  }
  function cleanup() { return cleanupPromise ??= clean(); }
  async function clean() {
    for (const command of [...commands]) {
      try { await command.stop(); } catch { commandsClean = false; }
      try { await command.result; } catch (error) { if (error.cleanupFailed) commandsClean = false; }
    }
    try {
      if (installationStarted) { if (await exists(entrypoint)) await stop(); else await stopped(); }
      check(commandsClean, "CURSOR_LIFECYCLE_COMMAND_CLEANUP");
      if (root) await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      report.cleanup = "PASS";
    } catch {
      report.status = "FAIL"; report.cleanup = "FAIL"; report.cleanupError = "CURSOR_LIFECYCLE_STATE_RETAINED";
    }
    if (registry) await registry.close();
    if (endpoint?.listening) { endpoint.closeAllConnections(); await new Promise((done) => endpoint.close(done)); }
  }
}

export function cursorLifecycleEnvironment({ root, home, stateHome, cursorHome, prefix, npmCli, port }) {
  const windowsRoot = process.env.SystemRoot ?? "C:\\Windows";
  const systemPaths = process.platform === "win32" ? [join(windowsRoot, "System32"), windowsRoot,
    join(windowsRoot, "System32/WindowsPowerShell/v1.0")] : ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  const env = { HOME: home, USERPROFILE: home, USER: "cursor-lifecycle", LOGNAME: "cursor-lifecycle", LANG: "en_US.UTF-8",
    PATH: [dirname(process.execPath), ...systemPaths].join(delimiter),
    TMPDIR: join(root, "tmp"), TMP: join(root, "tmp"), TEMP: join(root, "tmp"),
    APPDATA: join(home, "AppData/Roaming"), LOCALAPPDATA: join(home, "AppData/Local"),
    XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share"),
    XDG_STATE_HOME: join(home, ".local/state"), XDG_CACHE_HOME: join(home, ".cache"),
    npm_config_cache: join(root, "npm-cache"), npm_config_prefix: prefix, npm_config_registry: "https://registry.npmjs.org/",
    npm_config_userconfig: join(root, "user.npmrc"), npm_config_globalconfig: join(root, "global.npmrc"),
    npm_config_fetch_retries: "0", npm_config_fetch_timeout: "15000",
    MEMORAX_CODE_HOME: stateHome, CURSOR_HOME: cursorHome, MEMORAX_CODE_NPM_EXEC_PATH: npmCli,
    MEMORAX_CODE_AUTO_UPDATE: "false", MEMORAX_CODE_INSTALL_WATCHDOG: "0",
    MEMORAX_CODE_BACKEND_HOST: "127.0.0.1", MEMORAX_CODE_BACKEND_PORT: String(port),
    MEMORAX_CODE_CURSOR_TRACE_ENABLED: "false", MEMORAX_CODE_SKIP_CODEX_PLUGIN_INSTALL: "1",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(home, "missing-git-config"), GIT_TERMINAL_PROMPT: "0" };
  for (const client of otherClients) {
    for (const suffix of ["HOME", "CONFIG_DIR"]) env[`${client.toUpperCase()}_${suffix}`] = join(home, `.${client}`);
    env[`MEMORAX_CODE_${client.toUpperCase()}_COMMAND`] = join(root, "missing-client");
    env[`MEMORAX_CODE_${client.toUpperCase()}_TRACE_ENABLED`] = "false";
    env[`MEMORAX_CODE_SKIP_${client.toUpperCase()}_ADAPTER_INSTALL`] = "1";
  }
  env.TRAE_CN_HOME = env.TRAE_HOME;
  if (process.platform === "win32") Object.assign(env, { SystemRoot: windowsRoot, WINDIR: windowsRoot,
    ComSpec: join(windowsRoot, "System32/cmd.exe"), PATHEXT: ".COM;.EXE;.BAT;.CMD", USERNAME: "cursor-lifecycle" });
  return env;
}

export async function createCursorLifecycleRegistry(manifest, artifact) {
  const counts = { manifest: 0, artifact: 0, rejected: 0 };
  const registry = { counts, rejectDownload: false, setArtifact(nextManifest, nextArtifact) { manifest = nextManifest; artifact = nextArtifact; } };
  const server = createServer((request, response) => {
    let path;
    try { path = decodeURIComponent(new URL(request.url, "http://localhost").pathname); }
    catch { response.writeHead(400).end(); return; }
    if (request.method === "GET" && path === "/@memorax/memorax-code") {
      counts.manifest++;
      const version = { ...manifest, dist: { tarball: `${registry.url}/candidate.tgz`, shasum: createHash("sha1").update(artifact).digest("hex") } };
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ name: manifest.name,
        "dist-tags": { latest: manifest.version }, versions: { [manifest.version]: version } }));
    } else if (request.method === "GET" && path === "/candidate.tgz") {
      if (registry.rejectDownload) { counts.rejected++; response.writeHead(503).end(); }
      else { counts.artifact++; response.writeHead(200, { "content-type": "application/octet-stream" }).end(artifact); }
    } else response.writeHead(404).end();
  });
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  registry.url = `http://127.0.0.1:${server.address().port}`;
  registry.close = async () => { server.closeAllConnections(); await new Promise((done) => server.close(done)); };
  return registry;
}

export async function makeCursorReplacementFault({ packageRoot, root, faultMarker, oldPid, npm }) {
  const faultRoot = join(root, "fault-candidate");
  await cp(packageRoot, faultRoot, { recursive: true,
    filter: (source) => !relative(packageRoot, source).split(/[\\/]/).includes("node_modules") });
  const manifest = await json(join(faultRoot, "package.json"));
  // Only the disposable candidate's postinstall is replaced; preinstall must retire the real old Backend.
  manifest.scripts.postinstall = "node ./bin/ci-replacement-failure.mjs";
  await writeFile(join(faultRoot, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
  await writeFile(join(faultRoot, "bin/ci-replacement-failure.mjs"), [
    'import { readFileSync, writeFileSync } from "node:fs";', 'import { join } from "node:path";',
    'const transition = JSON.parse(readFileSync(join(process.env.MEMORAX_CODE_HOME, "runtime/install/package-transition.json"), "utf8"));',
    'let oldBackendStopped = false;',
    `try { process.kill(${JSON.stringify(oldPid)}, 0); } catch (error) { if (error.code === "ESRCH") oldBackendStopped = true; else throw error; }`,
    'if (transition.state !== "retired" || !oldBackendStopped) process.exit(24);',
    `writeFileSync(${JSON.stringify(faultMarker)}, JSON.stringify({ stage: "postinstall", transitionState: transition.state, oldBackendStopped, candidateVersion: ${JSON.stringify(manifest.version)} }));`,
    'process.exit(23);', "",
  ].join("\n"));
  const packed = JSON.parse((await npm(["pack", faultRoot, "--ignore-scripts", "--pack-destination", faultRoot, "--json"])).stdout);
  check(packed.length === 1 && typeof packed[0].filename === "string", "CURSOR_LIFECYCLE_FAULT_PACK");
  return { manifest, tarball: join(faultRoot, packed[0].filename) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await runCursorLifecycleCheck(...process.argv.slice(2));
  console.log(JSON.stringify(report));
  if (report.status !== "PASS") process.exitCode = 1;
}
