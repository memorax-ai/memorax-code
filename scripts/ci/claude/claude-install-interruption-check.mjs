#!/usr/bin/env node
import { chmod, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { createNativeHarness, fixtureModel, waitFor } from "./claude-native-support.mjs";
import { assertCredentialNotEchoed, assertProtectedConfiguration, snapshotProtectedConfiguration } from "../codex/codex-lifecycle-assertions.mjs";
import { assertClaudeSettings, assertLifecycleHooks, assertLifecycleMarketplace, selectLifecyclePlugin,
  snapshotClaudeSettings } from "./claude-lifecycle-assertions.mjs";
import { trackLifecycleTerminal } from "./claude-lifecycle-process.mjs";
import { selectNativeMemoraxPlugin } from "./claude-native-content-check.mjs";

const report = { status: "FAIL", suite: "claude_setup_interruption", platform: process.platform,
  paidModelRequests: 0, evidence: "real installed setup in a PTY; native lifecycle lock and test-only Node child admission gates", cases: [] };
const phases = ["after-config-write", "before-backend-start", "after-backend-start", "saved-account-key-cancel"];
const key = `sk_${"I".repeat(43)}`;
const pluginName = "memorax-code-claude-adapter";
let packageRoot, claudeCommand, pty, expectedVersion;
try {
  check(process.argv.length === 6, "EXPECTED_PACKAGE_CLAUDE_PTY_PATHS_AND_VERSION");
  packageRoot = resolve(process.argv[2]);
  claudeCommand = resolve(process.argv[3]);
  expectedVersion = process.argv[5];
  check(/^\d+\.\d+\.\d+$/.test(expectedVersion), "EXPECTED_CLAUDE_VERSION_INVALID");
  report.claudeVersion = expectedVersion;
  const require = createRequire(join(resolve(process.argv[4]), "package.json"));
  check(require("node-pty/package.json").version === "1.1.0", "UNEXPECTED_PTY_DEPENDENCY_VERSION");
  if (process.platform === "darwin") {
    const helper = join(dirname(require.resolve("node-pty/package.json")), "prebuilds", `darwin-${process.arch}`, "spawn-helper");
    const info = await stat(helper);
    if (!(info.mode & 0o100)) await chmod(helper, info.mode | 0o100);
  }
  pty = require("node-pty");
  for (const phase of phases) {
    const result = await runCase(phase);
    report.cases.push(result);
    console.error(JSON.stringify({ suite: report.suite, case: phase, status: result.status, errors: result.errors, cleanup: result.cleanup }));
  }
  report.status = report.cases.every((result) => result.status === "PASS") ? "PASS" : "FAIL";
} catch (error) {
  report.error = safeCode(error);
}
console.log(JSON.stringify(report, null, 2));
if (report.status !== "PASS") process.exitCode = 1;

async function runCase(phase) {
  const result = { id: phase, status: "FAIL", errors: [] };
  let harness, gateServer, terminal, releaseLock, heldLock;
  let setupCleanupPromise, cleanupPromise;
  let stage = "create-harness";
  let gateEnabled = true, reached, initialConfig, parse, protectedConfig, protectedSettings;
  const gateReached = new Promise((done) => { reached = done; });
  const blockedResponses = new Set(), dependencyPids = new Set(), backendPids = new Set();
  const quiesceSetup = () => setupCleanupPromise ??= (async () => {
    let cleanupError;
    const attempt = async (operation) => {
      try { await operation(); } catch (error) { cleanupError ??= error; }
    };
    await attempt(async () => { if (terminal) await terminal.stop(); });
    await attempt(async () => {
      gateEnabled = false;
      for (const response of blockedResponses) {
        if (!response.destroyed && !response.writableEnded) response.writeHead(503).end("cleanup");
      }
      blockedResponses.clear();
    });
    await attempt(async () => {
      releaseLock?.();
      try {
        if (heldLock) await deadline(heldLock, 10_000, "INTERRUPTION_RELEASE_LOCK_TIMEOUT");
      } finally { heldLock = undefined; }
    });
    await attempt(async () => {
      if (gateServer?.listening) {
        gateServer.closeAllConnections();
        await deadline(new Promise((done) => gateServer.close(done)), 5_000, "INTERRUPTION_GATE_CLOSE_TIMEOUT");
      }
    });
    await attempt(() => waitFor(() => [...dependencyPids].every((pid) => !alive(pid)), "INTERRUPTION_CLEANUP_DEPENDENCY_REMAINS"));
    if (cleanupError) throw cleanupError;
  })();
  const rememberBackend = async () => {
    const record = await readJsonIfPresent(join(harness.stateHome, "runtime", "backend", "backend.pid.json"));
    if (record) {
      check(Number.isSafeInteger(record.pid) && record.pid > 1
        && record.url === `http://127.0.0.1:${harness.env.MEMORAX_CODE_BACKEND_PORT}`
        && typeof record.instanceId === "string" && record.instanceId.length > 0, "BACKEND_RECORD_INVALID");
      backendPids.add(record.pid);
    }
    return record;
  };
  const cleanupSetup = () => cleanupPromise ??= (async () => {
    let cleanupError;
    const attempt = async (operation) => {
      try { await operation(); } catch (error) { cleanupError ??= error; }
    };
    await attempt(quiesceSetup);
    if (harness) {
      delete harness.env.NODE_OPTIONS;
      delete harness.env.MEMORAX_TEST_CLAUDE_GATE_URL;
      delete harness.env.MEMORAX_TEST_GATED_ENTRYPOINT;
      await attempt(rememberBackend);
      await attempt(async () => {
        const stopped = JSON.parse((await harness.runProduct(["stop", "--clients", "claude", "--json"],
          { cleanup: true, timeout: 15_000 })).stdout);
        check(stopped.ok === true, "INTERRUPTION_CLEANUP_STOP_FAILED");
      });
      await attempt(() => waitFor(() => [...backendPids, ...dependencyPids].every((pid) => !alive(pid)),
        "INTERRUPTION_CLEANUP_PROCESS_REMAINS"));
      await attempt(async () => check(!(await rememberBackend()), "INTERRUPTION_CLEANUP_PID_RECORD_REMAINS"));
    }
    if (cleanupError) throw cleanupError;
  })();
  const config = () => readFile(join(harness.stateHome, "config.toml"), "utf8");
  const completed = () => exists(join(harness.stateHome, "runtime", "setup", "setup-completion.json"));
  const observe = async (operation) => { try { await operation(); } catch (error) { result.errors.push(safeCode(error)); } };
  try {
    harness = await createNativeHarness({ packageRoot, claudeCommand, label: `interruption-${phase}`, writeback: false,
      expectedVersion });
    harness.setBeforeClose(cleanupSetup);
    const version = (await harness.runClaude(["--version"])).stdout.trim();
    check(version === `${expectedVersion} (Claude Code)`, "INSTALLED_CLAUDE_VERSION_MISMATCH");
    ({ parse } = createRequire(join(packageRoot, "package.json"))("smol-toml"));
    for (const name of ["MEMORAX_CODE_MEMORAX_ENDPOINT", "MEMORAX_CODE_MEMORAX_API_KEY", "MEMORAX_CODE_MEMORAX_USER_ID",
      "MEMORAX_CODE_MEMORY_WRITEBACK_ENABLED", "MEMORAX_CODE_JEV_ENABLED"]) delete harness.env[name];
    for (const name of Object.keys(harness.env)) if (name.startsWith("ANTHROPIC_")) delete harness.env[name];
    protectedSettings = snapshotClaudeSettings(await readJsonIfPresent(join(harness.claudeHome, "settings.json")));
    const user = `interruption-saved-${phases.indexOf(phase)}`;
    // Trailing whitespace makes a real setup-managed configuration publication
    // observable while the protected semantic choices remain unchanged.
    initialConfig = `[memorax]\nendpoint = ${JSON.stringify(harness.memoryUrl)}\nuser_id = ${JSON.stringify(user)}\napi_key = ${JSON.stringify(key)}\n
[clients]\ncodex = false\nclaude = true \t\ndsh = false\nopencode = false\ncodebuddy = false\nworkbuddy = false\ntrae = false\ncursor = false\n
[memory.writeback]\nenabled = false\n[memory.cli]\nadd_enabled = false\n[memory.add]\noutput_language = "en"\n[jev]\nenabled = false\n`;
    await writeFile(join(harness.stateHome, "config.toml"), initialConfig, { mode: 0o600 });
    protectedConfig = snapshotProtectedConfiguration(parse(initialConfig));
    stage = "interrupt-setup";
    gateServer = createServer((request, response) => {
      (async () => {
        let raw = "";
        for await (const chunk of request) { raw += chunk; check(raw.length < 32768, "DEPENDENCY_GATE_REQUEST_TOO_LARGE"); }
        const call = JSON.parse(raw);
        check(request.method === "POST" && request.url === "/" && Number.isSafeInteger(call.pid) && call.pid > 1
          && Array.isArray(call.args) && call.args.every((arg) => typeof arg === "string")
          && ["start", "status"].includes(call.args[0]), "DEPENDENCY_GATE_REQUEST_INVALID");
        let gated = false;
        const backend = await rememberBackend();
        if (gateEnabled && phase === "after-config-write" && call.args[0] === "start" && !backend) gated = true;
        if (gateEnabled && phase === "after-backend-start" && call.args[0] === "status" && backend) {
          const health = await fetch(new URL("/health", backend.url), { signal: AbortSignal.timeout(5_000) });
          const body = await health.json();
          gated = health.ok && body.ok === true && body.instanceId === backend.instanceId;
        }
        if (gated) {
          dependencyPids.add(call.pid);
          blockedResponses.add(response);
          reached({ kind: "test-preload-pauses-real-installed-cli-child", command: call.args[0], configPublished: await config() !== initialConfig,
            backendHealthy: phase === "after-backend-start" });
        } else response.writeHead(200).end("continue");
      })().catch(() => { response.writeHead(500).end("dependency gate failed"); });
    });
    await new Promise((done, reject) => { gateServer.once("error", reject); gateServer.listen(0, "127.0.0.1", done); });
    Object.assign(harness.env, {
      NODE_OPTIONS: `--import=${pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "claude-install-interruption-driver.mjs")).href}`,
      MEMORAX_TEST_CLAUDE_GATE_URL: `http://127.0.0.1:${gateServer.address().port}`,
      MEMORAX_TEST_GATED_ENTRYPOINT: join(packageRoot, "bin", "memorax-code.mjs") });
    if (phase === "before-backend-start") {
      const { withBackendLifecycleLock } = await import(pathToFileURL(join(packageRoot, "lib", "memorax-code-backend", "dist", "lifecycle", "lock.js")));
      let lockReady;
      const ready = new Promise((done) => { lockReady = done; });
      const release = new Promise((done) => { releaseLock = done; });
      heldLock = withBackendLifecycleLock({ home: harness.stateHome }, () => { lockReady(); return release; });
      await deadline(Promise.race([ready, heldLock]), 10_000, "LIFECYCLE_GATE_LOCK_NOT_ACQUIRED");
    }
    terminal = startTerminal(harness, phase === "saved-account-key-cancel" ? ["setup", "--existing-account"] : ["setup"], {
      cancelCase: phase === "saved-account-key-cancel", onStage: (event) => {
        if (phase === "before-backend-start" && event === "starting-backend") reached({ kind: "held-native-lifecycle-lock", backendHealthy: false });
        if (phase === "saved-account-key-cancel" && event === "key-prompt") reached({ kind: "native-masked-key-prompt", backendHealthy: false });
      },
    });
    result.stageEvidence = await deadline(Promise.race([gateReached, terminal.exited.then(() => { throw failure("SETUP_EXITED_BEFORE_INTERRUPTION_STAGE"); })]),
      110_000, "INTERRUPTION_STAGE_NOT_REACHED");
    terminal.verify();
    result.stageReached = true;
    await observe(async () => check(!(await completed()), "SETUP_COMPLETED_BEFORE_INTERRUPTION"));
    await observe(async () => assertProtectedConfiguration(parse(await config()), protectedConfig));
    await observe(async () => assertClaudeSettings(await readJsonIfPresent(join(harness.claudeHome, "settings.json")), protectedSettings));
    if (phase !== "after-backend-start") await observe(async () => check(!(await rememberBackend()), "BACKEND_STARTED_BEFORE_REQUESTED_GATE"));
    if (phase === "after-config-write") await observe(async () => check(await config() !== initialConfig, "CONFIG_PUBLICATION_NOT_OBSERVED"));
    result.interruption = phase === "saved-account-key-cancel" ? "Ctrl-C before entering a replacement key" : "terminate the real setup process tree at the dependency gate";
    if (phase === "saved-account-key-cancel") terminal.child.write("\x03");
    else await terminal.stop();
    const interrupted = await deadline(terminal.exited, 15_000, "INTERRUPTED_SETUP_DID_NOT_EXIT");
    terminal.verify();
    check(interrupted.exitCode !== 0 || interrupted.signal > 0, "INTERRUPTED_SETUP_REPORTED_SUCCESS");
    await observe(async () => assertCredentialNotEchoed(terminal.output(), key));
    await terminal.stop();
    terminal = undefined;
    await waitFor(() => [...dependencyPids].every((pid) => !alive(pid)), "INTERRUPTED_DEPENDENCY_PROCESS_REMAINS");
    gateEnabled = false;
    for (const response of blockedResponses) if (!response.destroyed) response.writeHead(503).end("interrupted");
    blockedResponses.clear();
    releaseLock?.();
    if (heldLock) await deadline(heldLock, 10_000, "INTERRUPTION_RELEASE_LOCK_TIMEOUT");
    heldLock = undefined;
    delete harness.env.NODE_OPTIONS;
    delete harness.env.MEMORAX_TEST_CLAUDE_GATE_URL;
    delete harness.env.MEMORAX_TEST_GATED_ENTRYPOINT;
    await observe(async () => check(!(await completed()), "INTERRUPTED_SETUP_RECORDED_COMPLETION"));
    await observe(async () => assertProtectedConfiguration(parse(await config()), protectedConfig));
    await observe(async () => assertClaudeSettings(await readJsonIfPresent(join(harness.claudeHome, "settings.json")), protectedSettings));
    result.completionAbsentAfterInterruption = !(await completed());
    const interruptedConfig = parse(await config());
    check(Object.entries(protectedConfig.account).every(([field, value]) => interruptedConfig.memorax?.[field] === value),
      "INTERRUPTED_SAVED_ACCOUNT_NOT_PRESERVED");
    stage = "retry-setup";
    terminal = startTerminal(harness, ["setup"], { cancelCase: false });
    const retried = await deadline(terminal.exited, 110_000, "SETUP_RETRY_TIMEOUT");
    terminal.verify();
    check(!terminal.inputRequested, "SAVED_ACCOUNT_RETRY_REQUESTED_INPUT");
    check(retried.exitCode === 0 && !(retried.signal > 0), "SETUP_RETRY_FAILED");
    assertCredentialNotEchoed(terminal.output(), key);
    await terminal.stop();
    terminal = undefined;
    result.retryWithoutAccountInput = true;
    stage = "recovered-state";
    await observe(async () => assertProtectedConfiguration(parse(await config()), protectedConfig));
    check(parse(await config()).memorax?.endpoint === protectedConfig.account.endpoint,
      "RECOVERY_ENDPOINT_CHANGED_BEFORE_REQUEST");
    const completion = await readJsonIfPresent(join(harness.stateHome, "runtime", "setup", "setup-completion.json"));
    const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
    check(completion?.version === 1 && completion.state === "complete"
      && completion.completedByVersion === manifest.version, "SETUP_RETRY_COMPLETION_MISSING");
    stage = "recovered-status";
    const status = JSON.parse((await harness.runProduct(["status", "--clients", "claude", "--json"])).stdout);
    check(status.ok === true && status.backend?.ok === true && status.claudeAdapter?.ok === true, "SETUP_RETRY_NOT_READY");
    const plugin = await verifyNativePlugin(harness, status, protectedSettings);
    result.nativePluginAndSettingsVerified = true;
    check(harness.modelRequests.length === 0 && harness.memoryRequests.length === 0, "SETUP_MADE_MEMORY_OR_MODEL_REQUESTS");
    const answer = "Interrupted setup recovery fixture completed.";
    harness.setModelHandler((body) => {
      check(body.model === fixtureModel, "RECOVERY_MODEL_SUBSTITUTION");
      return { text: answer };
    });
    stage = "recovered-native-session";
    const native = await harness.runClaude(["-p", "Check the recovered setup fixture.", "--output-format", "stream-json", "--verbose",
      "--permission-mode", "dontAsk", "--setting-sources", "user", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}']);
    const events = native.stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    const results = events.filter((event) => event.type === "result");
    const [completedTurn] = results;
    const session = completedTurn?.session_id;
    check(results.length === 1 && typeof session === "string" && session.length > 0 && completedTurn.result === answer
      && completedTurn.is_error === false && completedTurn.subtype === "success", "RECOVERY_NATIVE_SESSION_FAILED");
    const init = events.filter((event) => event.type === "system" && event.subtype === "init");
    check(init.length === 1 && init[0].session_id === session && init[0].model === fixtureModel,
      "RECOVERY_NATIVE_INIT_IDENTITY_MISMATCH");
    const loadedRoot = await realpath(selectNativeMemoraxPlugin(init[0].plugins).path);
    check(loadedRoot === plugin.source || loadedRoot === plugin.cache, "RECOVERY_NATIVE_PLUGIN_NOT_LOADED");
    const loadedManifest = await readJsonIfPresent(join(loadedRoot, ".claude-plugin", "plugin.json"));
    check(loadedManifest?.name === pluginName && loadedManifest.version === plugin.version
      && init[0].skills?.includes(`${pluginName}:memorax-code`), "RECOVERY_NATIVE_SKILL_NOT_LOADED");
    check(harness.modelRequests.length === 1, "RECOVERY_MODEL_REQUEST_COUNT_MISMATCH");
    check(harness.memoryRequests.length === 0, "DISABLED_WRITEBACK_SENT_REQUEST");
    stage = "saved-account-search";
    const query = "Interrupted setup saved account check";
    const searched = JSON.parse((await harness.runMemory(["search", "--query", query, "--session-id", session, "--json"])).stdout);
    check(searched.ok === true && searched.baseUserId === user && searched.effectiveUserId === `${user}@${basename(harness.workspace)}`,
      "RECOVERY_SEARCH_IDENTITY_MISMATCH");
    check(harness.memoryRequests.length === 1, "RECOVERY_SEARCH_REQUEST_COUNT_MISMATCH");
    const request = harness.memoryRequests[0];
    check(request.path === "/v1/memories/search" && request.authorization === `Token ${key}`
      && request.body.user_id === `${user}@${basename(harness.workspace)}` && request.body.query === query, "RECOVERY_REQUEST_USED_WRONG_ACCOUNT");
    result.savedAccountRequestVerified = true;
    result.disabledAutomaticWritebackVerified = true;
    check(harness.serverErrors.length === 0, "RECOVERY_RECEIVER_FAILED");
    assertClaudeSettings(await readJsonIfPresent(join(harness.claudeHome, "settings.json")), protectedSettings);
    result.status = result.errors.length === 0 ? "PASS" : "FAIL";
  } catch (error) {
    result.failureStage = stage;
    result.errors.push(safeCode(error));
  } finally {
    try {
      await cleanupSetup();
      result.cleanup = "PASS";
    } catch (error) {
      result.status = "FAIL";
      result.cleanup = safeCode(error);
    }
    try { await harness?.close(); }
    catch (error) { result.status = "FAIL"; result.cleanup = safeCode(error); }
  }
  return result;
}

function startTerminal(harness, args, { cancelCase, onStage = () => {} }) {
  let output = "", outputBytes = 0, terminalError, queriesAnswered = 0, usernameAnswered = false, keySeen = false, startSeen = false;
  const env = { ...harness.env, TERM: "xterm-256color" };
  delete env.MEMORAX_CODE_SETUP_ASSUME_INTERACTIVE;
  const child = pty.spawn(process.execPath, [join(packageRoot, "bin", "memorax-code.mjs"), ...args],
    { name: "xterm-256color", cols: 120, rows: 40, cwd: harness.workspace, env });
  const terminal = { ...trackLifecycleTerminal(child, env), inputRequested: false, output: () => output,
    verify() { if (terminalError) throw terminalError; } };
  const abort = (error) => {
    terminalError ??= error;
    void terminal.stop().catch((cleanupError) => { terminalError = cleanupError; });
  };
  child.onData((chunk) => {
    try {
      if (terminalError) return;
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > 2 * 1024 * 1024) throw failure("INTERRUPTION_TERMINAL_OUTPUT_LIMIT");
      output += chunk;
      const queries = output.split("\x1b[6n").length - 1;
      while (queriesAnswered < queries && queriesAnswered < 16) { queriesAnswered += 1; child.write("\x1b[1;1R"); }
      const visible = stripVTControlCharacters(output);
      const username = /Username[^\r\n]*:/.test(visible);
      const keyPrompt = visible.includes("MemoraX API key:");
      if (!cancelCase && (username || keyPrompt || visible.includes("Preferred language [ZH/en]")
        || visible.includes("Connect MemoraX Code to MemoraX now") || visible.includes("Use the saved connection and memory preferences"))) {
        terminal.inputRequested = true;
        throw failure("SAVED_ACCOUNT_RETRY_REQUESTED_INPUT");
      }
      if (cancelCase && username && !usernameAnswered) { usernameAnswered = true; child.write("\r"); }
      if (cancelCase && keyPrompt && !keySeen) { keySeen = true; onStage("key-prompt"); }
      if (!startSeen && visible.includes("Starting backend with `memorax-code start`")) { startSeen = true; onStage("starting-backend"); }
    } catch (error) {
      abort(error);
    }
  });
  return terminal;
}

async function verifyNativePlugin(harness, status, protectedSettings) {
  const adapter = status.claudeAdapter;
  check(adapter?.installed === true && adapter.enabled === true && adapter.integration === "hooks"
    && adapter.managed === true && adapter.backendUrlMatches === true
    && adapter.configuredBackendUrl === `http://127.0.0.1:${harness.env.MEMORAX_CODE_BACKEND_PORT}`
    && adapter.pluginStatus?.ok === true && adapter.pluginStatus.installed === true && adapter.pluginStatus.enabled === true,
  "RECOVERY_NATIVE_INTEGRATION_NOT_READY");
  const sourceRoot = join(packageRoot, "lib", "memorax-code-claude-adapter");
  const expected = await readJsonIfPresent(join(sourceRoot, ".claude-plugin", "plugin.json"));
  const plugin = selectLifecyclePlugin(JSON.parse((await harness.runClaude(["plugin", "list", "--json"])).stdout), expected.version);
  const registered = assertLifecycleMarketplace(JSON.parse((await harness.runClaude(["plugin", "marketplace", "list", "--json"])).stdout));
  const marketplaceRoot = await realpath(join(packageRoot, "lib", "memorax-code-claude-marketplace"));
  check(await realpath(registered.path) === marketplaceRoot, "RECOVERY_NATIVE_MARKETPLACE_MISMATCH");
  const marketplace = await readJsonIfPresent(join(marketplaceRoot, ".claude-plugin", "marketplace.json"));
  const declared = marketplace?.plugins?.filter((entry) => entry.name === pluginName);
  check(declared?.length === 1 && typeof declared[0].source === "string", "RECOVERY_MARKETPLACE_PLUGIN_MISSING");
  const source = await realpath(join(marketplaceRoot, declared[0].source));
  const cache = await realpath(plugin.installPath);
  check(within(marketplaceRoot, source) && within(await realpath(harness.claudeHome), cache)
    && await realpath(adapter.pluginStatus.installPath) === cache, "RECOVERY_INSTALLED_PLUGIN_PATH_MISMATCH");
  const installed = await readJsonIfPresent(join(cache, ".claude-plugin", "plugin.json"));
  check(installed?.name === pluginName && installed.version === expected.version, "RECOVERY_PLUGIN_MANIFEST_MISMATCH");
  assertLifecycleHooks(await readJsonIfPresent(join(cache, "hooks", "hooks.json")),
    await readJsonIfPresent(join(sourceRoot, "hooks", "hooks.json")),
    await readJsonIfPresent(join(cache, "hooks", "runtime-shell.json")),
    await readJsonIfPresent(join(sourceRoot, "hooks", "runtime-shell.json")));
  for (const path of ["hooks/runtime-hook.mjs", "hooks/hook-launcher.mjs", "runtime-hooks/ensure-backend.mjs",
    "runtime-hooks/memory-turn.mjs", "runtime-hooks/memory-cli-session.mjs", "runtime-hooks/memory-skill-reminder.mjs"]) {
    check((await stat(join(cache, path))).isFile(), "RECOVERY_HOOK_ASSET_MISSING");
  }
  const skills = adapter.claudeSkills;
  const delivered = skills?.skills?.filter((skill) => skill.name === "memorax-code");
  check(skills?.ok === true && skills.status === "plugin-managed" && skills.delivery === "plugin"
    && await realpath(skills.rootPath) === await realpath(join(cache, "skills"))
    && delivered?.length === 1 && delivered[0].ok === true && delivered[0].sourceKind === "plugin"
    && delivered[0].sourceExists === true
    && await realpath(delivered[0].sourcePath) === await realpath(join(cache, "skills", "memorax-code")),
  "RECOVERY_PLUGIN_SKILL_SOURCE_MISMATCH");
  for (const path of ["SKILL.md", "references/memorax-search.md", "references/memorax-add.md"]) {
    check(await readFile(join(cache, "skills", "memorax-code", path), "utf8")
      === await readFile(join(sourceRoot, "skills", "memorax-code", path), "utf8"), "RECOVERY_SKILL_ASSET_MISMATCH");
  }
  assertClaudeSettings(await readJsonIfPresent(join(harness.claudeHome, "settings.json")), protectedSettings);
  return { source, cache, version: expected.version };
}
function within(parent, path) {
  const child = relative(parent, path);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}
function failure(code) { return Object.assign(new Error(code), { testCode: code }); }
function check(condition, code) { if (!condition) throw failure(code); }
function safeCode(error) { return error.testCode ?? error.nativeCode ?? error.message?.match(/^PROTECTED_[A-Z_]+/)?.[0] ?? "INTERRUPTION_CHECK_FAILED_PRIVATE_OUTPUT_SUPPRESSED"; }
function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; if (error.code === "EPERM") return true; throw error; }
}
async function exists(path) { return stat(path).then(() => true, (error) => { if (error.code === "ENOENT") return false; throw error; }); }
async function readJsonIfPresent(path) { try { return JSON.parse(await readFile(path, "utf8")); } catch (error) { if (error.code === "ENOENT") return undefined; throw error; } }
async function deadline(promise, ms, code) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(failure(code)), ms); })]); }
  finally { clearTimeout(timer); }
}
