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
import { assertCursorAppNativeContent, assertCursorAppWriteback } from "./cursor-app-native-content-check.mjs";

const [packageRoot, appPath, expectedVersion, playwrightRoot, reportDir] = process.argv.slice(2);
const report = { status: "FAIL", client: "cursor", kind: "app-native-single-turn", platform: process.platform,
  node: process.versions.node, stage: "preflight", evidence: {} };
const prompt = "For this synthetic Cursor acceptance, keep answers concise.\nPreserve this marker: \u8bb0\u5fc6-42.";
const answer = "I will keep answers concise.\nPreserved marker: \u8bb0\u5fc6-42.";
const fixtureKey = "cursor-app-ci-synthetic-key", fixtureUser = "cursor-app-ci-synthetic-user";
const memoryRequests = [];
let agent, memory, app, browser, cli, page, started = false, appLog = "", sessionId;
let root, env;

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
async function ownedProcessesRemain() {
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
    let argv;
    try { argv = (await readFile(`/proc/${entry}/cmdline`, "utf8")).split("\0"); }
    catch (error) { if (error.code === "ENOENT" || error.code === "ESRCH") continue; throw error; }
    if (argv[0]?.startsWith(`${dirname(appPath)}/`) || argv.some((arg) => arg === env.MEMORAX_CODE_HOME
      || arg.startsWith(`${env.MEMORAX_CODE_HOME}/`) || arg.startsWith(`${packageRoot}/`))) return true;
  }
  return false;
}
function assertWriteback() {
  return assertCursorAppWriteback({ requests: memoryRequests, sessionId, prompt, answer, apiKey: fixtureKey,
    baseUserId: fixtureUser, workspaceName: basename(join(root, "workspace")) });
}

try {
  check(process.argv.length === 7 && process.platform === "linux" && Number(process.versions.node.split(".")[0]) === 24,
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
  const { chromium } = await import(pathToFileURL(join(playwrightRoot, "index.mjs")).href);
  root = await mkdtemp("/tmp/memorax-cursor-app-ci-");
  const home = join(root, "home"), userData = join(root, "app-data"), workspace = join(root, "workspace");
  agent = await startCursorAgentMock({ answer, timeoutMs: 30000 });
  memory = createServer(async (request, response) => {
    try {
      let raw = "";
      for await (const chunk of request) { raw += chunk; check(raw.length <= 1024 * 1024, "CURSOR_APP_MEMORY_BODY"); }
      check(request.method === "POST" && ["/v1/memories/add", "/v1/memories/search"].includes(request.url), "CURSOR_APP_MEMORY_ROUTE");
      memoryRequests.push({ method: request.method, path: request.url, authorization: request.headers.authorization, body: JSON.parse(raw) });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ success: true, data: request.url.endsWith("/add")
        ? { task_id: "cursor-app-ci-task", status: "completed" } : { data: [] } }));
    } catch { memoryRequests.push({ invalid: true }); response.writeHead(400); response.end(); }
  });
  await new Promise((resolve) => memory.listen(0, "127.0.0.1", resolve));
  env = {
    PATH: "/usr/local/bin:/usr/bin:/bin", HOME: home, USERPROFILE: home, LANG: "C.UTF-8",
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
  await writeFile(join(userData, "User/settings.json"), JSON.stringify({ "update.mode": "none", "telemetry.telemetryLevel": "off",
    "extensions.autoUpdate": false, "extensions.autoCheckUpdates": false, "workbench.startupEditor": "none", "security.workspace.trust.enabled": false }));
  cli = (action) => command([action, "--home", env.MEMORAX_CODE_HOME, "--cursor-home", env.CURSOR_HOME,
    "--port", "18787", "--clients", "cursor", "--json"], `CURSOR_APP_CANDIDATE_${action.toUpperCase()}`);
  report.stage = "candidate-install";
  started = true;
  check((await cli("start")).cursorAdapter?.enabled === true, "CURSOR_APP_ADAPTER_DISABLED");
  report.stage = "app-start";
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
  report.stage = "native-submit";
  await bounded(page.evaluate(() => window.driver.executeCommand("workbench.action.devAutoLoginFakeForTesting")), "CURSOR_APP_FAKE_AUTH_TIMEOUT");
  await bounded(page.evaluate((query) => window.driver.executeCommand("workbench.action.chat.open", { query }), prompt), "CURSOR_APP_CHAT_OPEN_TIMEOUT");
  sessionId = (await bounded(page.evaluate(() => window.driver.executeCommand("workbench.action.devGetComposerDataForTesting")), "CURSOR_APP_COMPOSER_TIMEOUT"))?.composerId;
  check(typeof sessionId === "string" && sessionId.length > 0, "CURSOR_APP_SESSION");
  const input = page.locator('[contenteditable="true"][role="textbox"]');
  await input.fill(prompt); await input.press("Enter");
  report.stage = "agent-transport";
  await waitFor(() => {
    check(!agent.errors.length, agent.errors[0]);
    check(!agent.runs[0]?.error, agent.runs[0]?.error);
    return agent.runs.length > 0 && agent.runs[0].completed;
  }, "CURSOR_APP_AGENT_TIMEOUT", 45000);
  check(agent.runs.length === 1, "CURSOR_APP_RUN_COUNT");
  const run = agent.runs[0];
  check(run.conversationId === sessionId && run.prompt === prompt, "CURSOR_APP_RUN_PROMPT_IDENTITY");
  check(run.kvWriteCount === 3 && run.kvAckCount === 3, "CURSOR_APP_KV_ACK_COUNT");
  report.evidence.agentTransport = true;
  report.stage = "native-persistence";
  await waitFor(() => {
    try {
      report.evidence.nativeContent = assertCursorAppNativeContent({ databasePath: env.MEMORAX_CODE_CURSOR_DATABASE_PATH,
        sessionId, generationId: run.requestId, conversationStateBytes: run.conversationStateBytes, kvWrites: run.kvWrites });
      return true;
    } catch (error) { report.nativeContentError = safeCode(error); return false; }
  }, "CURSOR_APP_NATIVE_CONTENT_TIMEOUT");
  delete report.nativeContentError;
  report.stage = "automatic-add";
  await waitFor(() => memoryRequests.length > 0, "CURSOR_APP_ADD_TIMEOUT");
  assertWriteback();
  check((await cli("status")).cursorAdapter?.cursorHooks?.runtimeObserved === true, "CURSOR_APP_HOOK_NOT_OBSERVED");
  const events = (await readFile(join(env.MEMORAX_CODE_HOME, "debug/traces/cursor/sessions", sessionId, "events.jsonl"), "utf8"))
    .trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
  const turns = events.filter((event) => event.type === "turn_start" && event.trace?.client === "cursor" && event.trace.session_id === sessionId);
  check(turns.length === 1 && turns[0].trace.turn_id === run.requestId, "CURSOR_APP_HOOK_CORRELATION");
  check(events.some((event) => event.type === "turn_end" && event.trace?.turn_id === turns[0].trace.turn_id && event.outcome === "completed"), "CURSOR_APP_HOOK_COMPLETION");
  report.evidence.nativeHooks = true;
  report.evidence.exactAutomaticAdd = true;
  report.stage = "cleanup";
} catch (error) { report.errorCode = safeCode(error); }
finally {
  try {
    await bounded(browser?.close(), "CURSOR_APP_BROWSER_CLEANUP").catch((error) => { report.cleanupError = safeCode(error); });
    if (app && app.exitCode === null && app.signalCode === null) {
      const closed = once(app, "close");
      app.kill("SIGTERM");
      if (!await Promise.race([closed.then(() => true), delay(5000).then(() => false)])) {
        app.kill("SIGKILL");
        check(await Promise.race([closed.then(() => true), delay(5000).then(() => false)]), "CURSOR_APP_CLEANUP_TIMEOUT");
      }
    }
  } catch (error) { report.cleanupError = safeCode(error); }
  try { if (started) await cli("stop"); } catch (error) { report.cleanupError ??= safeCode(error); }
  try {
    if (started) {
      // Do not kill discovered PIDs: fail closed and let the owned container teardown remove descendants.
      let remaining = true;
      for (let attempt = 0; attempt < 25 && remaining; attempt++) {
        remaining = await ownedProcessesRemain();
        if (remaining) await delay(200);
      }
      check(!remaining, "CURSOR_APP_CLEANUP_DESCENDANTS");
    }
  } catch (error) { report.cleanupError ??= safeCode(error); }
  if (agent) {
    await bounded(agent.close(), "CURSOR_APP_AGENT_CLEANUP").catch(() => { report.cleanupError = "CURSOR_APP_AGENT_CLEANUP"; });
    report.agent = { runs: agent.runs.length, writes: agent.runs.map((run) => run.kvWriteCount),
      acknowledgements: agent.runs.map((run) => run.kvAckCount), ancillaryRequestCount: agent.ancillaryRequestCount,
      unsupportedRpcCount: agent.unsupportedRpcCount };
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
      check(agent.runs.length === 1 && agent.runs[0].completed && agent.runs[0].kvWriteCount === 3
        && agent.runs[0].kvAckCount === 3, "CURSOR_APP_FINAL_RUN_COUNT");
      assertWriteback();
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
    await writeFile(join(reportDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  }
}
console.log(JSON.stringify(report, null, 2));
if (report.status !== "PASS") process.exitCode = 1;
