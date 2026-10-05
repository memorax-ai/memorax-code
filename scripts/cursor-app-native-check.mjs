#!/usr/bin/env node
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { startCursorAgentMock } from "./cursor-app-mock-server.mjs";
import { assertCursorAppNativeContent, assertCursorAppWritebacks } from "./cursor-app-native-content-check.mjs";
import { assertCursorAppSkillReference, assertCursorAppMemoryOperation } from "./cursor-app-memory-check.mjs";
import { collectCursorAppDiagnostics } from "./cursor-app-diagnostics.mjs";

const [packageRoot, appPath, expectedVersion, playwrightRoot, reportDir, expectedNodeMajor = "24"] = process.argv.slice(2);
const report = { status: "FAIL", client: "cursor", kind: "app-native-session-flows", platform: process.platform,
  node: process.versions.node, stage: "preflight", evidence: { nativeContent: [] } };
const prompt = "For this synthetic Cursor acceptance, keep answers concise.\nPreserve this marker: \u8bb0\u5fc6-42.";
const answer = "I will keep answers concise.\nPreserved marker: \u8bb0\u5fc6-42.";
const fixtures = [
  { prompt, answer },
  { prompt, answer: "This is the second concise reply.\nPreserved marker: \u8bb0\u5fc6-42." },
  { prompt, answer },
  { prompt: "Use numbered steps for changes in this resumed synthetic session.", answer: "I will use numbered steps for changes in this resumed session." },
  { prompt: "Use the memorax-code skill to search coding memory for the parser validation lesson.",
    answer: "The installed Skill search returned the parser validation lesson.", operation: "search" },
  { prompt: "Use the memorax-code skill to save the verified parser validation lesson.",
    answer: "The installed Skill saved the parser validation lesson.", operation: "add" },
];
const fixtureKey = "cursor-app-ci-synthetic-key", fixtureUser = "cursor-app-ci-synthetic-user";
const skillQuery = "Which parser validation invariant applies to this synthetic task?";
const skillMemory = "Validate parser input before interpreting structured data.";
const skillReason = "Preserve the verified parser validation invariant.";
const searchMemory = "CURSOR_NATIVE_SEARCH_RESULT: validate parser input before interpreting it.";
const memoryRequests = [], turns = [];
let agent, memory, app, browser, cli, page, started = false, appLog = "";
let root, env, chromium, userData, workspace, failure, failureUi, skillRoot, skillText;
const referenceTexts = new Map();

function check(value, code) { if (!value) throw Object.assign(new Error(code), { code }); }
function safeCode(error) { return /^CURSOR_(?:APP|AGENT|MOCK)_[A-Z0-9_]+$/.test(error?.code) ? error.code : "CURSOR_APP_CHECK_FAILED"; }
async function bounded(promise, code, timeoutMs = 10000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(code), { code })), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}
async function waitFor(predicate, code, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  do {
    check(!app || (app.exitCode === null && app.signalCode === null), "CURSOR_APP_EXITED");
    if (await bounded(Promise.resolve().then(predicate), code, 5000)) return;
    await delay(200);
  } while (Date.now() < deadline);
  check(false, code);
}
async function command(args, code) {
  const child = spawn(process.execPath, [join(packageRoot, "bin/memorax-code.mjs"), ...args],
    { cwd: join(root, "workspace"), env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", overflow = false;
  child.stdout.on("data", (chunk) => { stdout += chunk; if (stdout.length > 1024 * 1024) { overflow = true; child.kill("SIGKILL"); } });
  child.stderr.resume();
  const timer = setTimeout(() => child.kill("SIGKILL"), 30000);
  try {
    const [exitCode] = await once(child, "close");
    check(exitCode === 0 && !overflow, code);
    try { return JSON.parse(stdout); } catch { check(false, code); }
  } finally { clearTimeout(timer); }
}
async function ownedProcessesRemain({ includeBackend = true } = {}) {
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
    let argv;
    try { argv = (await readFile(`/proc/${entry}/cmdline`, "utf8")).split("\0"); }
    catch (error) { if (error.code === "ENOENT" || error.code === "ESRCH") continue; throw error; }
    if (argv[0]?.startsWith(`${dirname(appPath)}/`) || argv.some((arg) => arg === env.MEMORAX_CODE_HOME
      || arg.startsWith(`${env.MEMORAX_CODE_HOME}/`) || (includeBackend && arg.startsWith(`${packageRoot}/`)))) return true;
  }
  return false;
}
function assertWriteback() {
  const automatic = [];
  let position = 0;
  for (const turn of turns) {
    if (turn.operation) position++;
    automatic.push(memoryRequests[position++]);
  }
  check(memoryRequests.length === position, "CURSOR_APP_MEMORY_REQUEST_COUNT");
  return assertCursorAppWritebacks({ requests: automatic, turns, apiKey: fixtureKey,
    baseUserId: fixtureUser, workspaceName: basename(workspace) });
}
function quote(value) { return `'${value.replaceAll("'", "'\\''")}'`; }
function assertSkillMemory(operation, result, request) {
  return assertCursorAppMemoryOperation({ request, result, operation, query: skillQuery,
    memory: operation === "search" ? searchMemory : skillMemory, reason: skillReason, sessionId: "memorax-cli",
    apiKey: fixtureKey, baseUserId: fixtureUser, workspaceName: basename(workspace) });
}
function toolSteps(run, results) {
  const fixture = fixtures[turns.length - 1];
  check(run.prompt === fixture?.prompt && run.conversationId === turns.at(-1).sessionId, "CURSOR_APP_SKILL_IDENTITY");
  if (!run.requestContextCloseCount) return { kind: "requestContext" };
  if (!fixture.operation) return;
  const reference = join(skillRoot, "references", `memorax-${fixture.operation}.md`);
  if (results.length === 0) {
    const sessionRuns = agent.runs.filter((item) => item.conversationId === run.conversationId
      && (item === run || (item.completed && run.turnRefs.some((ref) => ref.equals(item.turnBlobId)))));
    const contexts = sessionRuns.flatMap((item) => [item.requestContext?.hooksAdditionalContext,
      ...(item.userHookAdditionalContexts ?? []).map((context) => context.content)]).filter(Boolean);
    check(contexts.some((context) => context.includes(`MEMORAX_CODE_MEMORY_CLI_TRACE_CLIENT=cursor and MEMORAX_CODE_MEMORY_CLI_TRACE_SESSION_ID=${run.conversationId}`)),
      "CURSOR_APP_SKILL_HOOK_CONTEXT");
    check(run.requestContext?.agentSkills.some((skill) => skill.fullPath === join(skillRoot, "SKILL.md")
      && !skill.parseError && !skill.disableModelInvocation), "CURSOR_APP_SKILL_NOT_DISCOVERED");
    return { kind: "read", path: join(skillRoot, "SKILL.md") };
  }
  check(results[0].kind === "read" && results[0].path === join(skillRoot, "SKILL.md")
    && results[0].content === skillText, "CURSOR_APP_SKILL_NOT_READ");
  if (results.length === 1) return { kind: "read", path: reference };
  check(results[1].kind === "read" && results[1].path === reference
    && results[1].content === referenceTexts.get(fixture.operation), "CURSOR_APP_SKILL_REFERENCE_NOT_READ");
  if (results.length === 2) {
    const executable = assertCursorAppSkillReference(results[1].content, fixture.operation, process.platform);
    const args = fixture.operation === "search" ? ["search", "--query", skillQuery, "--json"]
      : ["add", "--memory", skillMemory, "--type", "procedural", "--reason", skillReason, "--json"];
    return { kind: "shell", command: ["env", "MEMORAX_CODE_MEMORY_CLI_TRACE_CLIENT=cursor",
      `MEMORAX_CODE_MEMORY_CLI_TRACE_SESSION_ID=${run.conversationId}`, executable, ...args].map(quote).join(" "),
    workingDirectory: workspace, timeoutMs: 20000 };
  }
  check(results.length === 3 && results[2].kind === "shell" && results[2].exitCode === 0,
    "CURSOR_APP_SKILL_COMMAND_FAILED");
  let result;
  try { result = JSON.parse(results[2].stdout); } catch { check(false, "CURSOR_APP_SKILL_RESULT_JSON"); }
  assertSkillMemory(fixture.operation, result, memoryRequests[fixture.operation === "search" ? 4 : 6]);
}
async function stopApp() {
  let closeError;
  try { await bounded(browser?.close(), "CURSOR_APP_BROWSER_CLEANUP"); } catch (error) { closeError = error; }
  browser = undefined;
  page = undefined;
  if (app && app.exitCode === null && app.signalCode === null) {
    const closed = once(app, "close");
    app.kill("SIGTERM");
    if (!await Promise.race([closed.then(() => true), delay(5000).then(() => false)])) {
      app.kill("SIGKILL");
      check(await Promise.race([closed.then(() => true), delay(5000).then(() => false)]), "CURSOR_APP_CLEANUP_TIMEOUT");
    }
  }
  app = undefined;
  if (closeError) throw closeError;
}
async function assertProcessesStopped(options) {
  // Never kill discovered PIDs; the owned container teardown removes any surviving descendants.
  for (let attempt = 0; attempt < 25; attempt++) {
    if (!await ownedProcessesRemain(options)) return;
    await delay(200);
  }
  check(false, "CURSOR_APP_CLEANUP_DESCENDANTS");
}
async function startApp() {
  app = spawn(appPath, ["--user-data-dir", userData, "--extensions-dir", join(root, "extensions"), "--new-window",
    "--skip-onboarding", "--skip-welcome", "--skip-release-notes", "--skip-add-to-recently-opened",
    "--disable-updates", "--disable-telemetry", "--disable-crash-reporter", "--use-inmemory-secretstorage",
    "--enable-smoke-test-driver", "--smoke-test-use-real-agent-http", "--test-backend-url", agent.url,
    "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=9222", workspace],
  { cwd: workspace, env, stdio: ["ignore", "pipe", "pipe"] });
  const capture = (chunk) => { appLog = (appLog + chunk).slice(-1024 * 1024); };
  app.stdout.on("data", capture); app.stderr.on("data", capture);
  app.on("error", () => { report.appSpawnFailed = true; });
  await waitFor(async () => {
    try { return (await fetch("http://127.0.0.1:9222/json/version", { signal: AbortSignal.timeout(300) })).ok; } catch { return false; }
  }, "CURSOR_APP_DEBUG_PORT");
  browser = await chromium.connectOverCDP("http://127.0.0.1:9222", { timeout: 5000 });
  await waitFor(async () => {
    page = browser.contexts().flatMap((context) => context.pages()).find((item) => item.url().includes("workbench.html"));
    return page && await page.evaluate(() => Boolean(window.driver)).catch(() => false);
  }, "CURSOR_APP_DRIVER");
  page.setDefaultTimeout(10000);
  await bounded(page.evaluate(async () => {
    // Keep synthetic login from replacing the IDE window with the Agents window.
    await window.driver.executeCommand("workbench.action.devSetApplicationStorageForTesting",
      "cursor.glassDefaultOnLogin.handledAtMs", Date.now(), "application");
    await window.driver.executeCommand("workbench.action.devAutoLoginFakeForTesting");
  }), "CURSOR_APP_FAKE_AUTH_TIMEOUT");
  await bounded(page.evaluate(() => window.driver.whenWorkbenchRestored()), "CURSOR_APP_WORKBENCH_RESTORE_TIMEOUT", 30000);
}
async function openSession(sessionId) {
  report.stage = "session-open";
  await bounded(page.evaluate((id) => id
    ? window.driver.executeCommand("composer.openComposer", id, { openInNewTab: false })
    : window.driver.executeCommand("workbench.action.chat.open"), sessionId), "CURSOR_APP_CHAT_OPEN_TIMEOUT");
  if (sessionId) {
    // The visible composer is mounted only after its persisted data has loaded.
    await waitFor(async () => await page.locator(`[data-composer-id="${sessionId}"][data-composer-status]:visible`).count() === 1,
      "CURSOR_APP_COMPOSER_NOT_READY");
  }
  let selected;
  await waitFor(async () => {
    selected = (await page.evaluate(() => window.driver.executeCommand("workbench.action.devGetComposerDataForTesting")))?.composerId;
    return typeof selected === "string" && selected.length > 0
      && (sessionId ? selected === sessionId : !turns.some((turn) => turn.sessionId === selected));
  }, "CURSOR_APP_SESSION");
  const composer = page.locator(`[data-composer-id="${selected}"][data-composer-status]:visible`);
  const hasHistory = agent.runs.some((run) => run.conversationId === selected && run.completed);
  await waitFor(async () => await composer.count() === 1
    && (!hasHistory || await composer.getAttribute("data-composer-status") === "completed"), "CURSOR_APP_COMPOSER_NOT_READY");
  return selected;
}
function assertSnapshot(sessionId) {
  const sessionRuns = agent.runs.filter((run) => run.conversationId === sessionId);
  const latest = sessionRuns.at(-1);
  return assertCursorAppNativeContent({ databasePath: env.MEMORAX_CODE_CURSOR_DATABASE_PATH,
    sessionId, generationId: latest.requestId, conversationStateBytes: latest.conversationStateBytes,
    kvWrites: sessionRuns.flatMap((run) => run.kvWrites) });
}
async function runTurn(sessionId) {
  const index = turns.length, fixture = fixtures[index];
  const approvedTools = new Set();
  turns.push({ sessionId, ...fixture });
  report.stage = "native-submit";
  const input = page.locator(`[data-composer-id="${sessionId}"][data-composer-status]:visible`)
    .locator('[contenteditable="true"][role="textbox"]:visible');
  await input.fill(fixture.prompt); await input.press("Enter");
  report.stage = "agent-transport";
  await waitFor(async () => {
    check(!agent.errors.length, agent.errors[0]);
    const run = agent.runs[index], pending = run?.pendingTool;
    if (pending?.kind === "shell" && !approvedTools.has(pending.toolCallId)) {
      check(fixture.operation && run.conversationId === sessionId && run.prompt === fixture.prompt,
        "CURSOR_APP_SKILL_APPROVAL_IDENTITY");
      const button = page.locator(`[data-composer-id="${sessionId}"][data-composer-status]:visible`)
        .locator(`[data-tool-call-id="${pending.toolCallId}"]:visible`).getByRole("button", { name: "Run", exact: true });
      const count = await button.count();
      check(count <= 1, "CURSOR_APP_SKILL_APPROVAL_AMBIGUOUS");
      if (count === 1 && await button.isVisible()) {
        await button.click({ timeout: 2000 });
        approvedTools.add(pending.toolCallId);
      }
    }
    return run?.completed;
  }, "CURSOR_APP_AGENT_TIMEOUT", 90000);
  check(agent.runs.length === index + 1, "CURSOR_APP_RUN_COUNT");
  const run = agent.runs[index], previous = agent.runs.slice(0, index).filter((item) => item.conversationId === sessionId);
  check(run.conversationId === sessionId && run.prompt === fixture.prompt, "CURSOR_APP_RUN_PROMPT_IDENTITY");
  check(new Set(agent.runs.map((item) => item.requestId)).size === index + 1
    && new Set(agent.runs.map((item) => item.userMessageId)).size === index + 1, "CURSOR_APP_REUSED_TURN_IDENTITY");
  check(run.turnRefs.length === previous.length && run.turnRefs.every((ref, position) => ref.equals(previous[position].turnBlobId)), "CURSOR_APP_HISTORY_MISMATCH");
  const previousBlobs = previous.reduce((count, item) => count + item.kvWrites.length, 0);
  check(run.kvReadCount === previousBlobs && run.kvReadResultCount === previousBlobs, "CURSOR_APP_HISTORY_READ_COUNT");
  const writes = fixture.operation ? 6 : 3;
  check(run.kvWriteCount === writes && run.kvAckCount === writes, "CURSOR_APP_KV_ACK_COUNT");
  check(run.requestContextRequestCount === 1 && run.requestContextResultCount === 1 && run.requestContextCloseCount === 1,
    "CURSOR_APP_SKILL_CONTEXT_COUNT");
  report.stage = "native-persistence";
  let content;
  await waitFor(() => {
    try { content = assertSnapshot(sessionId); return true; }
    catch (error) { report.nativeContentError = safeCode(error); return false; }
  }, "CURSOR_APP_NATIVE_CONTENT_TIMEOUT");
  delete report.nativeContentError;
  report.evidence.nativeContent.push(content);
  report.stage = "automatic-add";
  await waitFor(() => memoryRequests.length >= turns.length + turns.filter((turn) => turn.operation).length, "CURSOR_APP_ADD_TIMEOUT");
  assertWriteback();
  const events = (await readFile(join(env.MEMORAX_CODE_HOME, "debug/traces/cursor/sessions", sessionId, "events.jsonl"), "utf8"))
    .trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
  const starts = events.filter((event) => event.type === "turn_start" && event.trace?.client === "cursor"
    && event.trace.session_id === sessionId && event.trace.turn_id === run.requestId);
  check(starts.length === 1, "CURSOR_APP_HOOK_CORRELATION");
  check(events.some((event) => event.type === "turn_end" && event.trace?.client === "cursor"
    && event.trace.session_id === sessionId && event.trace.turn_id === run.requestId && event.outcome === "completed"), "CURSOR_APP_HOOK_COMPLETION");
  if (fixture.operation) {
    check(run.execRequestCount === 3 && run.execResultCount === 3 && run.execCloseCount === 3, "CURSOR_APP_SKILL_EXEC_COUNT");
    check(approvedTools.size === 1, "CURSOR_APP_SKILL_APPROVAL_COUNT");
    const calls = events.filter((event) => event.type === `memory_cli_${fixture.operation}` && event.trace?.client === "cursor"
      && event.trace.session_id === sessionId && event.trace.turn_id === run.requestId && event.ok === true);
    check(calls.length === 1, "CURSOR_APP_SKILL_TRACE_IDENTITY");
    report.evidence[fixture.operation === "search" ? "skillSearch" : "skillAdd"] = true;
  }
}

try {
  const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
  check([7, 8].includes(process.argv.length) && process.platform === "linux" && ["22", "24"].includes(expectedNodeMajor)
    && nodeMajor === Number(expectedNodeMajor) && (nodeMajor !== 22 || nodeMinor >= 13),
    "CURSOR_APP_ARGUMENTS");
  check(process.getuid() !== 0 && Object.values(networkInterfaces()).flat().every((item) => item.internal), "CURSOR_APP_ISOLATION");
  check((await readFile("/proc/net/route", "utf8")).trim().split("\n").length === 1, "CURSOR_APP_EXTERNAL_ROUTE");
  const security = await readFile("/proc/self/status", "utf8");
  check(/^CapEff:\s+0+$/m.test(security) && /^NoNewPrivs:\s+1$/m.test(security) && /^Seccomp:\s+2$/m.test(security), "CURSOR_APP_SANDBOX");
  let externalReachable = false;
  try { await fetch("http://192.0.2.1:80", { signal: AbortSignal.timeout(1000) }); externalReachable = true; } catch {}
  check(!externalReachable, "CURSOR_APP_EXTERNAL_NETWORK");
  report.version = JSON.parse(await readFile(join(dirname(appPath), "resources/app/package.json"), "utf8")).version;
  check(report.version === expectedVersion, "CURSOR_APP_VERSION");
  ({ chromium } = await import(pathToFileURL(join(playwrightRoot, "index.mjs")).href));
  root = await mkdtemp("/tmp/memorax-cursor-app-ci-");
  const home = join(root, "home");
  userData = join(root, "app-data"); workspace = join(root, "workspace");
  agent = await startCursorAgentMock({ answers: fixtures.map((fixture) => fixture.answer), toolSteps, timeoutMs: 60000 });
  memory = createServer(async (request, response) => {
    try {
      let raw = "";
      for await (const chunk of request) { raw += chunk; check(raw.length <= 1024 * 1024, "CURSOR_APP_MEMORY_BODY"); }
      check(request.method === "POST" && ["/v1/memories/add", "/v1/memories/search"].includes(request.url), "CURSOR_APP_MEMORY_ROUTE");
      memoryRequests.push({ method: request.method, path: request.url, authorization: request.headers.authorization, body: JSON.parse(raw) });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ success: true, data: request.url.endsWith("/add")
        ? { task_id: "cursor-app-ci-task", status: "completed" }
        : { task_id: "native-search", status: "completed", data: [{ id: "fixture-memory", memory: searchMemory,
          metadata: { memory_type: "procedural" }, score: 0.95 }] } }));
    } catch { memoryRequests.push({ invalid: true }); response.writeHead(400); response.end(); }
  });
  await new Promise((resolve) => memory.listen(0, "127.0.0.1", resolve));
  env = {
    PATH: `${join(dirname(dirname(packageRoot)), ".bin")}:/usr/local/bin:/usr/bin:/bin`, HOME: home, USERPROFILE: home, LANG: "C.UTF-8",
    DISPLAY: process.env.DISPLAY, XAUTHORITY: process.env.XAUTHORITY,
    XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"),
    XDG_DATA_HOME: join(home, ".local/share"), XDG_STATE_HOME: join(home, ".local/state"),
    XDG_RUNTIME_DIR: join(root, "runtime"), TMPDIR: "/tmp",
    CURSOR_HOME: join(home, ".cursor"), CURSOR_CONFIG_DIR: join(home, ".cursor"),
    CODEX_HOME: join(home, ".codex"), CLAUDE_CONFIG_DIR: join(home, ".claude"),
    OPENCODE_CONFIG_DIR: join(home, ".opencode"), CODEBUDDY_CONFIG_DIR: join(home, ".codebuddy"),
    MEMORAX_CODE_HOME: join(root, "state"), MEMORAX_CODE_AUTO_UPDATE: "false", MEMORAX_CODE_JEV_ENABLED: "false",
    MEMORAX_CODE_CURSOR_DATABASE_PATH: join(userData, "User/globalStorage/state.vscdb"),
    MEMORAX_CODE_CURSOR_ENSURE_BACKEND: "false", MEMORAX_CODE_CURSOR_TRACE_ENABLED: "true",
    MEMORAX_CODE_MEMORAX_ENDPOINT: `http://127.0.0.1:${memory.address().port}`,
    MEMORAX_CODE_MEMORAX_API_KEY: fixtureKey, MEMORAX_CODE_MEMORAX_USER_ID: fixtureUser,
    MEMORAX_CODE_MEMORY_WRITEBACK_ENABLED: "true", MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_ENABLED: "false",
    MEMORAX_CODE_MEMORY_WRITEBACK_CHUNK_ENABLED: "false",
  };
  for (const path of [home, join(userData, "User"), workspace, env.CURSOR_HOME, env.XDG_RUNTIME_DIR]) await mkdir(path, { recursive: true, mode: 0o700 });
  // Cursor's login Shell sources /etc/profile, which resets the inherited PATH.
  await writeFile(join(home, ".profile"), `export PATH=${quote(env.PATH)}\n`);
  await writeFile(join(userData, "User/settings.json"), JSON.stringify({ "update.mode": "none", "telemetry.telemetryLevel": "off",
    "extensions.autoUpdate": false, "extensions.autoCheckUpdates": false, "workbench.startupEditor": "none", "security.workspace.trust.enabled": false }));
  cli = (action) => command([action, "--home", env.MEMORAX_CODE_HOME, "--cursor-home", env.CURSOR_HOME,
    "--port", "18787", "--clients", "cursor", "--json"], `CURSOR_APP_CANDIDATE_${action.toUpperCase()}`);
  report.stage = "candidate-install";
  started = true;
  check((await cli("start")).cursorAdapter?.enabled === true, "CURSOR_APP_ADAPTER_DISABLED");
  skillRoot = join(env.CURSOR_HOME, "skills/memorax-code");
  skillText = await readFile(join(skillRoot, "SKILL.md"), "utf8");
  for (const operation of ["search", "add"]) {
    referenceTexts.set(operation, await readFile(join(skillRoot, "references", `memorax-${operation}.md`), "utf8"));
  }
  report.stage = "app-start";
  await startApp();
  const firstSession = await openSession();
  await runTurn(firstSession);
  await openSession(firstSession);
  await runTurn(firstSession);
  report.evidence.sameSessionFollowup = true;
  const secondSession = await openSession();
  check(secondSession !== firstSession, "CURSOR_APP_SESSION_NOT_ISOLATED");
  await runTurn(secondSession);
  report.stage = "app-restart";
  const oldPid = app.pid;
  await stopApp();
  await assertProcessesStopped({ includeBackend: false });
  assertWriteback();
  await startApp();
  check(app.pid !== oldPid, "CURSOR_APP_RESTART_IDENTITY");
  await openSession(firstSession);
  assertSnapshot(firstSession);
  assertWriteback();
  await runTurn(firstSession);
  report.evidence.appResume = true;
  await openSession(firstSession);
  await runTurn(firstSession);
  await openSession(firstSession);
  await runTurn(firstSession);
  assertSnapshot(firstSession);
  assertSnapshot(secondSession);
  report.evidence.sessionIsolation = true;
  report.evidence.agentTransport = true;
  check((await cli("status")).cursorAdapter?.cursorHooks?.runtimeObserved === true, "CURSOR_APP_HOOK_NOT_OBSERVED");
  report.evidence.nativeHooks = true;
  report.evidence.exactAutomaticAdd = true;
  report.stage = "cleanup";
} catch (error) {
  failure = error?.stack ?? String(error); report.errorCode = safeCode(error);
  const run = agent?.runs.at(-1);
  if (env && run) report.diagnostics = await collectCursorAppDiagnostics({ home: env.MEMORAX_CODE_HOME,
    sessionId: run.conversationId, turnId: run.requestId });
  failureUi = await page?.locator("body").innerText({ timeout: 1000 }).then((text) => text.slice(0, 32000)).catch(() => undefined);
}
finally {
  try { await stopApp(); } catch (error) { report.cleanupError = safeCode(error); }
  try { if (started) await cli("stop"); } catch (error) { report.cleanupError ??= safeCode(error); }
  try {
    if (started) await assertProcessesStopped();
  } catch (error) { report.cleanupError ??= safeCode(error); }
  if (agent) {
    await bounded(agent.close(), "CURSOR_APP_AGENT_CLEANUP").catch(() => { report.cleanupError = "CURSOR_APP_AGENT_CLEANUP"; });
    report.agent = { runs: agent.runs.length, writes: agent.runs.map((run) => run.kvWriteCount),
      acknowledgements: agent.runs.map((run) => run.kvAckCount), ancillaryRequestCount: agent.ancillaryRequestCount,
      unsupportedRpcCount: agent.unsupportedRpcCount, historyTurns: agent.runs.map((run) => run.turnRefs.length),
      reads: agent.runs.map((run) => run.kvReadCount), readResults: agent.runs.map((run) => run.kvReadResultCount),
      execRequests: agent.runs.map((run) => run.execRequestCount), execResults: agent.runs.map((run) => run.execResultCount),
      execCloses: agent.runs.map((run) => run.execCloseCount),
      contextRequests: agent.runs.map((run) => run.requestContextRequestCount),
      contextResults: agent.runs.map((run) => run.requestContextResultCount),
      contextCloses: agent.runs.map((run) => run.requestContextCloseCount) };
    if (agent.errors.length) {
      report.agent.errors = agent.errors;
      report.errorCode ??= safeCode({ code: agent.errors[0] });
    }
  }
  if (memory) {
    memory.closeAllConnections();
    await bounded(new Promise((resolve) => memory.close(resolve)), "CURSOR_APP_MEMORY_CLEANUP").catch((error) => { report.cleanupError = safeCode(error); });
  }
  if (!report.errorCode && !report.cleanupError) {
    try {
      check(turns.length === fixtures.length && agent.runs.length === fixtures.length
        && agent.runs.every((run, index) => run.completed && run.kvWriteCount === (fixtures[index].operation ? 6 : 3)
          && run.kvAckCount === run.kvWriteCount), "CURSOR_APP_FINAL_RUN_COUNT");
      assertWriteback();
      for (const [index, operation] of [[4, "search"], [5, "add"]]) {
        assertSkillMemory(operation, JSON.parse(agent.runs[index].toolResults[2].stdout), memoryRequests[index === 4 ? 4 : 6]);
      }
    } catch (error) { report.errorCode = safeCode(error); }
  }
  if (!report.cleanupError) report.evidence.cleanup = true;
  report.memoryRequestCount = memoryRequests.length;
  if (!report.errorCode && !report.cleanupError) { report.status = "PASS"; report.stage = "complete"; }
  if (reportDir) {
    await mkdir(reportDir, { recursive: true });
    // This directory is private debugging material and is never a CI upload target.
    await mkdir(join(reportDir, ".private"), { recursive: true, mode: 0o700 });
    await writeFile(join(reportDir, ".private/app.log"), appLog, { mode: 0o600 });
    await writeFile(join(reportDir, ".private/unknown-rpc.json"), JSON.stringify(agent?.unknownRpcMethods ?? []), { mode: 0o600 });
    await writeFile(join(reportDir, ".private/run-shapes.json"), JSON.stringify(agent?.runs.map((run) => ({
      context: run.requestContext && { hookContentLength: run.requestContext.hooksAdditionalContext?.length,
        skills: run.requestContext.agentSkills.map(({ fullPath, parseError, disableModelInvocation }) => ({ fullPath, parseError: Boolean(parseError), disableModelInvocation })) },
      hookContexts: run.userHookAdditionalContexts?.map(({ hookEventName, content }) => ({ hookEventName, length: content.length })),
      contextParts: Boolean(run.requestContextParts), pendingTool: run.pendingTool, execRejection: run.execRejection, error: run.error,
    })) ?? []), { mode: 0o600 });
    if (failure) await writeFile(join(reportDir, ".private/failure.log"), failure, { mode: 0o600 });
    if (failureUi) await writeFile(join(reportDir, ".private/ui.txt"), failureUi, { mode: 0o600 });
    await writeFile(join(reportDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  }
}
console.log(JSON.stringify(report, null, 2));
if (report.status !== "PASS") process.exitCode = 1;
