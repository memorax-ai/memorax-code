import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { readFile } from "node:fs/promises";
import { basename, dirname, join, posix, win32 } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { collectCursorAppShellDiagnostics, collectCursorAppStopDiagnostics } from "./cursor-app-diagnostics.mjs";
import { stopWindowsApp } from "./cursor-app-windows-runtime.mjs";

const source = (await readFile(new URL("./cursor-app-native-check.mjs", import.meta.url), "utf8")).replaceAll("\r\n", "\n");

test("actual candidate commands use the owned spawn on every platform and preserve outcomes", async () => {
  const body = source.split("async function command(")[1]?.split("\nasync function ownedProcessesRemain(")[0];
  const cliBody = source.split("  cli = ")[1]?.split(";\n")[0];
  assert.ok(body);
  assert.ok(cliBody);
  const privateCanary = "private-stop-path-token-canary";
  const failure = { ok: false, action: "stop", backend: { ok: false, errorCode: "BACKEND_STOP_TIMEOUT",
    stage: "wait_stopped", processState: "running", state: { path: privateCanary }, error: privateCanary } };
  const modes = ["failed-stop", "successful-stop", "invalid-json", "failed-start", "failed-status", "failed-restart", "timeout", "overflow"];
  for (const [platform, mode] of ["linux", "darwin", "win32"].flatMap((platform) => modes.map((mode) => [platform, mode]))) {
    const action = ["failed-start", "failed-status", "failed-restart"].includes(mode) ? mode.slice(7) : "stop";
    const report = {}, kills = [], timers = [], env = { HOME: "/owned/home", MEMORAX_CODE_HOME: "/owned/state", CURSOR_HOME: "/owned/cursor" };
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null });
    let closed = false, collected = false;
    const close = (exitCode, signal = null) => {
      if (closed) return;
      closed = true; child.exitCode = exitCode; child.signalCode = signal;
      child.stdout.end(); child.stderr.end(); child.emit("close", exitCode, signal);
    };
    child.kill = (signal) => { kills.push(signal); queueMicrotask(() => close(null, signal)); };
    function startCommand(route, file, args, options) {
      assert.equal(route, "owned");
      assert.equal(file, "/owned/node");
      assert.deepEqual(Array.from(args), [join("/owned/package", "bin/memorax-code.mjs"), action,
        "--home", env.MEMORAX_CODE_HOME, "--cursor-home", env.CURSOR_HOME, "--port", "18787", "--clients", "cursor", "--json"]);
      assert.equal(options.cwd, join("/owned", "workspace")); assert.equal(options.env === env, true);
      assert.deepEqual(Array.from(options.stdio), ["ignore", "pipe", "pipe"]);
      assert.equal(options.shell, undefined);
      queueMicrotask(() => {
        child.stderr.write(privateCanary);
        if (mode === "timeout") { timers[0](); return; }
        if (mode === "overflow") { child.stdout.write("x".repeat(1024 * 1024 + 1)); return; }
        child.stdout.write(mode === "invalid-json" ? privateCanary : JSON.stringify(mode === "successful-stop" ? { ok: true } : failure));
        close(mode === "successful-stop" || mode === "invalid-json" ? 0 : 1);
      });
      return child;
    }
    const command = runInNewContext(`(async function command(${body})`, {
      process: { execPath: "/owned/node" }, packageRoot: "/owned/package", root: "/owned", env, report, join, once,
      macos: platform === "darwin" ? {} : undefined, windows: platform === "win32" ? {} : undefined,
      collectCursorAppStopDiagnostics(value) { collected = true; return collectCursorAppStopDiagnostics(value); },
      check(value, code) {
        if (action === "stop") assert.equal(collected, true, "stop JSON is projected before checking the exit");
        if (!value) throw Object.assign(new Error(code), { code });
      },
      setTimeout(callback, timeout) { assert.equal(timeout, 30000); timers.push(callback); return callback; },
      clearTimeout(timer) { assert.equal(timer, timers[0]); timers.length = 0; },
      spawn: (...args) => startCommand("controller", ...args),
      spawnOwned: (...args) => startCommand("owned", ...args),
    }, { timeout: 100 });
    const cli = runInNewContext(cliBody, { command, env, backendPort: 18787 }, { timeout: 100 });
    const code = `CURSOR_APP_CANDIDATE_${action.toUpperCase()}`;
    if (mode === "successful-stop") assert.equal((await cli(action)).ok, true);
    else await assert.rejects(cli(action), { code });
    assert.equal(timers.length, 0);
    assert.deepEqual(kills, ["timeout", "overflow"].includes(mode) ? ["SIGKILL"] : []);
    if (mode === "successful-stop" || action !== "stop") assert.equal(report.candidateStop, undefined);
    else {
      assert.ok(report.candidateStop);
      assert.equal(report.candidateStop.timedOut, mode === "timeout");
      assert.equal(report.candidateStop.outputOverflow, mode === "overflow");
      if (mode === "failed-stop") assert.equal(report.candidateStop.backend.errorCode, "BACKEND_STOP_TIMEOUT");
      if (mode === "invalid-json") assert.equal(report.candidateStop.jsonStatus, "invalid");
      assert.equal(JSON.stringify(report).includes(privateCanary), false);
    }
  }
});

test("native failures capture the current App outcome before cleanup changes process state", () => {
  const capture = source.indexOf("if (app) report.appLaunch = collectCursorAppLaunchDiagnostics(");
  const cleanup = source.indexOf("finally {\n  try { await stopApp();");
  assert.ok(capture > 0 && cleanup > capture);
  assert.match(source, /appLaunchLog = ""; appSpawnError = undefined; appDebugEndpointSeen = false;/);
  assert.match(source, /exitCode: app\.exitCode, signal: app\.signalCode/);
  assert.match(source, /spawnError: appSpawnError, log: appLaunchLog/);
});

test("native Run and Skip record only completed clicks on the matching run and tool", async () => {
  const body = source.split("async function runTurn(")[1]?.split("\nasync function assertInterrupted(")[0];
  assert.ok(body);
  for (const permission of [undefined, "deny"]) for (const mode of ["clicked", "click-failed", "not-visible", "wrong-session", "marker-exists"]) {
    if (!permission && mode === "marker-exists") continue;
    const toolCallId = "11111111-1111-4111-8111-111111111111", sessionId = "synthetic-session";
    const run = { conversationId: sessionId, prompt: "synthetic prompt", completed: false,
      pendingTool: { kind: "shell", toolCallId }, shellApproval: { toolCallId, clicked: false } };
    const retry = { ...run, shellApproval: { toolCallId: "22222222-2222-4222-8222-222222222222", clicked: false } };
    const agent = { errors: [], runs: [] }, selectors = [];
    let submitted = 0, markerChecks = 0;
    const code = "CURSOR_APP_EXEC_REJECTED", error = Object.assign(new Error(code), { code });
    const button = {
      async count() { return mode === "not-visible" ? 0 : 1; }, async isVisible() { return true; },
      async click(options) {
        assert.equal(options.timeout, 2000);
        agent.runs.push(retry);
        if (mode === "click-failed") throw error;
      },
    };
    const locator = { locator(selector) { selectors.push(selector); return locator; },
      getByRole(role, options) { assert.equal(role, "button"); assert.equal(options.name, permission ? "Skip" : "Run"); assert.equal(options.exact, true); return button; } };
    const turns = [];
    const runTurn = runInNewContext(`(async function runTurn(${body})`, {
      turns, fixtures: [{ prompt: run.prompt, ...(permission ? { permission } : { operation: "search" }) }], report: {}, agent,
      workspace: "/owned/project-beta", basename,
      denial: { marker: "/owned/project-beta/denied-marker" },
      async assertMarkerAbsent(marker, code) {
        assert.equal(marker, "/owned/project-beta/denied-marker"); markerChecks += 1;
        if (mode === "marker-exists") throw Object.assign(new Error(code), { code });
      },
      page: { locator(selector) { selectors.push(selector); return locator; } },
      async submitPrompt(input, fixture) {
        assert.equal(input, locator); assert.equal(fixture.prompt, run.prompt); submitted += 1;
        if (mode === "wrong-session") run.conversationId = "different-session";
        agent.runs.push(run);
      },
      async waitFor(predicate) { await predicate(); throw error; },
      check(value, actualCode) { if (!value) throw Object.assign(new Error(actualCode), { code: actualCode }); },
    }, { timeout: 100 });
    await assert.rejects(runTurn(sessionId), { code: mode === "wrong-session" ? "CURSOR_APP_SKILL_APPROVAL_IDENTITY"
      : mode === "marker-exists" ? "CURSOR_APP_PERMISSION_TOOL_EXECUTED" : code });
    assert.equal(submitted, 1);
    assert.equal(turns[0].workspaceName, "project-beta");
    assert.equal(run.shellApproval.toolCallId, toolCallId);
    assert.equal(run.shellApproval.clicked, !permission && mode === "clicked");
    assert.equal(run.shellRejection?.clicked, permission && mode === "clicked" ? true : undefined);
    assert.equal(markerChecks, permission && !["not-visible", "wrong-session"].includes(mode) ? 1 : 0);
    assert.equal(retry.shellApproval.clicked, false);
    assert.equal(selectors.includes(`[data-tool-call-id="${toolCallId}"]:visible`), mode !== "wrong-session");
    assert.ok(selectors.includes(`[data-composer-id="${sessionId}"][data-composer-status]:visible`));
  }
});

test("same-session recovery uses a new run and excludes the cancelled turn from completed history", async () => {
  const body = source.split("async function runTurn(")[1]?.split("\nasync function assertInterrupted(")[0];
  for (const mode of ["recovered", "cancelled-history", "reused-id"]) {
    const prior = { conversationId: "same-session", requestId: "old-request", userMessageId: "old-message",
      cancelled: true, completed: false, kvWrites: [], turnBlobId: Buffer.alloc(32) };
    const fixture = { prompt: "new prompt", answer: "new answer" };
    const run = { conversationId: prior.conversationId, prompt: fixture.prompt, completed: true,
      requestId: mode === "reused-id" ? prior.requestId : "new-request", userMessageId: "new-message",
      turnRefs: mode === "cancelled-history" ? [prior.turnBlobId] : [], kvReadCount: 0, kvReadResultCount: 0,
      kvWriteCount: 3, kvAckCount: 3, requestContextRequestCount: 1, requestContextResultCount: 1, requestContextCloseCount: 1 };
    const agent = { runs: [prior], errors: [] }, turns = [], report = {};
    const locator = { locator: () => locator };
    const runTurn = runInNewContext(`(async function runTurn(${body})`, {
      agent, turns, report, workspace: "/owned/workspace", basename,
      page: { locator: () => locator },
      async submitPrompt(input, actual) { assert.equal(actual, fixture); agent.runs.push(run); },
      async waitFor(predicate) {
        if (report.stage === "native-persistence") throw Object.assign(new Error("transport verified"), { code: "VERIFIED" });
        assert.equal(await predicate(), true);
      },
      check(value, code) { if (!value) throw Object.assign(new Error(code), { code }); },
    });
    await assert.rejects(runTurn(prior.conversationId, fixture), { code: mode === "cancelled-history"
      ? "CURSOR_APP_HISTORY_MISMATCH" : mode === "reused-id" ? "CURSOR_APP_REUSED_TURN_IDENTITY" : "VERIFIED" });
    assert.equal(turns.length, 1);
    assert.equal(turns[0].prompt, fixture.prompt);
    assert.equal(turns[0].sessionId, prior.conversationId);
  }
});

test("interruption oracle retains the old terminal trace after the same session recovers", async () => {
  const body = source.split("async function assertInterrupted(")[1]?.split("\nasync function interruptPendingShell(")[0];
  for (const recovered of [false, true]) for (const mode of ["valid", "tool-ran", "old-completed", "old-materialized", "late-add",
    ...(recovered ? ["different-session", "same-request", "wrong-active", "new-not-materialized"] : ["wrong-state"])]) {
    const interruption = { sessionId: "same-session", runIndex: 1, marker: "/owned/cancelled-marker" };
    const old = { requestId: "old-request", cancelled: true, completed: false,
      cancellation: { actionReceived: true, rejected: true, execClosed: true, transportClosed: true, rstCode: 8 },
      kvWriteCount: 0, kvAckCount: 0, execRequestCount: 1, execResultCount: 0, execCloseCount: 0,
      requestContextRequestCount: 1, requestContextResultCount: 1, requestContextCloseCount: 1 };
    const next = { conversationId: mode === "different-session" ? "another-session" : interruption.sessionId,
      requestId: mode === "same-request" ? old.requestId : "new-request", completed: true, prompt: "recovery prompt" };
    const store = { readStatus: "present", versionMatched: true, clientMatched: true, sessionMatched: true,
      activePresent: true, turnMatched: true, state: "interrupted", stopStatus: "aborted", reason: "interrupted", metadataPresent: false };
    const trace = { readStatus: "present", turnStartCount: 1, interruptedCount: 1,
      completedCount: mode === "old-completed" ? 1 : 0, materializedCount: mode === "old-materialized" ? 1 : 0 };
    const reads = [];
    let writebackChecks = 0;
    const assertInterrupted = runInNewContext(`(async function assertInterrupted(${body})`, {
      interruption, agent: { runs: [{ completed: true }, old, ...(recovered ? [next] : [])] },
      recoveryFixture: { prompt: next.prompt }, env: { MEMORAX_CODE_HOME: "/owned/state" },
      async assertMarkerAbsent(marker, code) {
        assert.equal(marker, interruption.marker);
        if (mode === "tool-ran") throw Object.assign(new Error(code), { code });
      },
      async collectCursorAppDiagnostics({ sessionId, turnId }) {
        assert.equal(sessionId, interruption.sessionId); reads.push(turnId);
        if (turnId === old.requestId) return { turnStore: recovered ? { turnMatched: false } :
          { ...store, state: mode === "wrong-state" ? "open" : store.state }, trace };
        assert.equal(turnId, next.requestId);
        return { turnStore: { ...store, turnMatched: mode !== "wrong-active", state: "accepted", stopStatus: "completed" },
          trace: { ...trace, interruptedCount: 0, materializedCount: mode === "new-not-materialized" ? 0 : 1, completedCount: 1 } };
      },
      assertWriteback() {
        writebackChecks += 1;
        if (mode === "late-add") throw Object.assign(new Error("exact writebacks differ"), { code: "EXACT_WRITEBACK_MISMATCH" });
      },
      check(value, code) { if (!value) throw Object.assign(new Error(code), { code }); },
    });
    if (mode === "valid") {
      await assertInterrupted({ recovered });
      assert.deepEqual(reads, recovered ? [old.requestId, next.requestId] : [old.requestId]);
      assert.equal(writebackChecks, 1);
    } else await assert.rejects(assertInterrupted({ recovered }), { code: mode === "tool-ran"
      ? "CURSOR_APP_INTERRUPTION_TOOL_EXECUTED" : mode === "late-add" ? "EXACT_WRITEBACK_MISMATCH"
        : ["different-session", "same-request"].includes(mode) ? "CURSOR_APP_RECOVERY_IDENTITY"
          : ["wrong-active", "new-not-materialized"].includes(mode) ? "CURSOR_APP_RECOVERY_HOOK" : "CURSOR_APP_INTERRUPTION_HOOK" });
  }
});

test("actual failure capture uses the first rejected Shell, never the last retry", () => {
  const capture = source.match(/  const shellResult = collectCursorAppShellDiagnostics\([^\n]+\);\n  if \(shellResult\) report\.shellResult = shellResult;/)?.[0];
  assert.ok(capture);
  const toolCallId = "11111111-1111-4111-8111-111111111111";
  const first = { error: "CURSOR_APP_EXEC_REJECTED", execRejection: { kind: "shell", toolCallId, rejectionKind: 2, exitCode: 127 },
    shellApproval: { toolCallId, clicked: true } };
  const retry = { ...first, execRejection: { ...first.execRejection, exitCode: 1 }, shellApproval: { toolCallId, clicked: false } };
  const report = {};
  runInNewContext(capture, { report, agent: { firstShellFailure: first, runs: [first, retry] }, collectCursorAppShellDiagnostics });
  assert.deepEqual(report.shellResult, { rejectionKind: 2, approvalClicked: true, exitCode: 127 });
  const unrelated = {};
  runInNewContext(capture, { report: unrelated, agent: { runs: [retry] }, collectCursorAppShellDiagnostics });
  assert.equal(unrelated.shellResult, undefined);
});

test("owned native commands and App launch preserve direct spawn arguments without a shell", () => {
  const body = source.split("function spawnOwned(")[1]?.split("\nasync function command(")[0];
  assert.ok(body);
  assert.match(source, /app = spawnOwned\(appPath,/);
  for (const platform of ["linux", "darwin", "win32"]) {
    const calls = [], options = { env: { HOME: "/owned/home" }, cwd: "/owned/workspace" };
    const spawnOwned = runInNewContext(`(function spawnOwned(${body})`, {
      macos: platform === "darwin" ? {} : undefined,
      windows: platform === "win32" ? {} : undefined,
      spawn(file, args, actualOptions) { calls.push({ file, args, actualOptions }); return "owned child"; },
    }, { timeout: 100 });
    assert.equal(spawnOwned("/owned/Node", ["an argument with spaces"], options), "owned child");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].actualOptions, options);
    assert.equal(calls[0].file, "/owned/Node");
    assert.deepEqual(Array.from(calls[0].args), ["an argument with spaces"]);
    assert.equal(options.shell, undefined);
  }
});

test("App launch keeps the default Chromium sandbox and forces isolated shell environment on native hosts", () => {
  const launch = source.split("async function startApp() {")[1]?.split("\nasync function openSession(")[0];
  const body = launch?.slice(launch.indexOf("  app = spawnOwned("), launch.indexOf("  const capture = "));
  assert.ok(body);
  for (const platform of ["linux", "darwin", "win32"]) {
    const env = { HOME: "/owned/home" }, calls = [];
    runInNewContext(body, {
      macos: platform === "darwin" ? {} : undefined, windows: platform === "win32" ? {} : undefined,
      appPath: "/owned/app", userData: "/owned/app-data", root: "/owned", workspace: "/owned/workspace",
      agent: { url: "http://127.0.0.1:12345" }, debugPort: 12346, env, join,
      spawnOwned(file, args, options) { calls.push({ file, args: Array.from(args), options }); },
    }, { timeout: 100 });
    assert.equal(calls.length, 1);
    const { file, args, options } = calls[0];
    assert.equal(file, "/owned/app"); assert.equal(options.env, env); assert.equal(options.shell, undefined);
    assert.equal(args.includes("--force-disable-user-env"), platform !== "linux");
    assert.equal(args.includes("--use-inmemory-secretstorage"), true);
    assert.equal(args.includes("--test-backend-url=http://127.0.0.1:12345"), true);
    assert.equal(args.includes("--test-backend-url"), false);
    assert.equal(args.includes("http://127.0.0.1:12345"), false);
    assert.equal(args.includes("--remote-debugging-address=127.0.0.1"), true);
    assert.equal(args.includes("--remote-debugging-port=12346"), true);
    assert.equal(args.some((arg) => ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu-sandbox"].includes(arg)), false);
    assert.equal(args.at(-1), "/owned/workspace");
    assert.equal(options.cwd, "/owned/workspace");
  }
});

test("native sequence opens a second workspace then restores the original session without restarting Backend", async () => {
  const body = source.split('  report.stage = "app-start";')[1]?.split('  report.stage = "cleanup";')[0];
  assert.ok(body);
  for (const paths of [posix, win32]) {
    const root = paths.resolve("/owned"), firstWorkspace = paths.join(root, "workspace");
    const secondWorkspace = paths.join(root, "project-beta");
    const env = { MEMORAX_CODE_HOME: paths.join(root, "state") }, userData = paths.join(root, "app-data");
    const turns = [], starts = [], stops = [], audits = [], created = [], commands = [], snapshots = [];
    let freshSessions = 0;
    const context = { root, firstWorkspace, workspace: firstWorkspace, env, userData, join: paths.join,
      report: { evidence: {} }, app: undefined, recoveryFixture: { prompt: "recovery" },
      async mkdir(path) { created.push(path); },
      async startApp() {
        assert.equal(context.app, undefined);
        context.app = { pid: starts.length + 1 };
        starts.push({ workspace: context.workspace, env: context.env, userData: context.userData });
      },
      async stopApp() { stops.push(context.workspace); context.app = undefined; },
      async assertProcessesStopped(options) { audits.push(options.includeBackend); },
      async openSession(id) { return id ?? ["session-a", "session-b", "session-deny"][freshSessions++]; },
      async runTurn(sessionId, fixture) {
        if (sessionId === "session-cancel") assert.equal(fixture, context.recoveryFixture);
        turns.push({ sessionId, workspace: context.workspace });
      },
      assertWriteback() {}, assertSnapshot(sessionId) { snapshots.push(sessionId); },
      async cli(action) { commands.push(action); return { cursorAdapter: { cursorHooks: { runtimeObserved: true } } }; },
      async interruptPendingShell() {
        assert.equal(context.workspace, firstWorkspace); context.interruption = { sessionId: "session-cancel" };
      },
      async assertInterrupted(options) { assert.equal(options.recovered, true); },
      check(value, code) { assert.ok(value, code); },
    };
    await runInNewContext(`(async () => {${body}})()`, context, { timeout: 100 });
    assert.deepEqual(starts.map((item) => item.workspace), [firstWorkspace, secondWorkspace, firstWorkspace]);
    assert.ok(starts.every((item) => item.env === env && item.userData === userData));
    assert.deepEqual(stops, [firstWorkspace, secondWorkspace]);
    assert.deepEqual(audits, [false, false]);
    assert.deepEqual(created, [secondWorkspace]);
    assert.deepEqual(commands, ["status"]);
    assert.deepEqual(turns, [
      { sessionId: "session-a", workspace: firstWorkspace },
      { sessionId: "session-a", workspace: firstWorkspace },
      { sessionId: "session-b", workspace: secondWorkspace },
      ...Array.from({ length: 3 }, () => ({ sessionId: "session-a", workspace: firstWorkspace })),
      { sessionId: "session-deny", workspace: firstWorkspace },
      { sessionId: "session-cancel", workspace: firstWorkspace },
    ]);
    assert.deepEqual(snapshots, ["session-a", "session-a", "session-b"]);
    assert.equal(context.report.evidence.workspaceIsolation, true);
    assert.equal(context.report.evidence.appResume, true);
    assert.equal(context.report.evidence.sameSessionRecovered, true);
    assert.equal(freshSessions, 3);
  }
});

test("native submission selects one Skill menu item and preserves its mention while typing the prompt", async () => {
  const body = source.split("async function submitPrompt(")[1]?.split("\nasync function runTurn(")[0];
  assert.ok(body);
  for (const [operation, menuCount, mentionCount, suffix] of [
    [undefined, 0, 0, undefined], ["search", 1, 1, undefined], ["add", 1, 1, undefined],
    ["search", 0, 0, "MENU"], ["search", 2, 0, "MENU"],
    ["search", 1, 0, "MENTION"], ["search", 1, 2, "MENTION"],
  ]) {
    const promptBody = "synthetic prompt with a private-content-canary";
    const fixture = { prompt: operation ? `/memorax-code ${promptBody}` : promptBody, operation };
    const events = [], fills = [], inserted = [], presses = [];
    let hasMention = false, text = "";
    const input = {
      async fill(value) { events.push("fill"); fills.push(value); text = value; hasMention = false; },
      async pressSequentially(value) {
        assert.equal(text, "");
        assert.equal(value, "/memorax-code");
        events.push("type"); text += value;
      },
      locator(selector) {
        assert.equal(selector, '[data-typeahead-type="cursor_skill"][data-mention-name="memorax-code"]');
        return { async count() { events.push("mention"); return mentionCount; } };
      },
      async press(key) {
        events.push(key); presses.push(key);
        if (key === "Enter") {
          assert.equal(text, fixture.prompt);
          assert.equal(hasMention, Boolean(operation));
        } else assert.equal(key, "End");
      },
    };
    const item = {
      async count() { events.push("menu"); return menuCount; },
      async click() { events.push("click"); hasMention = true; text = "/memorax-code "; },
    };
    const submitPrompt = runInNewContext(`(async function submitPrompt(${body})`, {
      page: {
        locator(selector) {
          assert.equal(selector, ".ui-slash-menu__content:visible");
          return { locator(titleSelector) {
            assert.equal(titleSelector, ".ui-slash-menu__item-title");
            return { filter({ hasText }) {
              assert.equal(hasText.test("/memorax-code"), true);
              assert.equal(hasText.test("/memorax-code-other"), false);
              assert.equal(hasText.test("Create /memorax-code skill"), false);
              return item;
            } };
          } };
        },
        keyboard: { async insertText(value) {
          events.push("insert"); inserted.push(value); text += value;
          assert.equal(hasMention, true);
          assert.equal(value, promptBody);
        } },
      },
      async waitFor(predicate, code) {
        if (!await predicate()) throw Object.assign(new Error(code), { code });
      },
    }, { timeout: 100 });
    if (suffix) await assert.rejects(submitPrompt(input, fixture), (error) => {
      assert.equal(error.code, `CURSOR_APP_SKILL_${suffix}`);
      assert.equal(error.message, error.code);
      assert.equal(JSON.stringify(error).includes("canary"), false);
      return true;
    });
    else await submitPrompt(input, fixture);
    assert.deepEqual(fills, [operation ? "" : fixture.prompt]);
    assert.deepEqual(presses, suffix ? [] : operation ? ["End", "Enter"] : ["Enter"]);
    assert.deepEqual(inserted, operation && !suffix ? [promptBody] : []);
    assert.deepEqual(events, !operation ? ["fill", "Enter"] : suffix === "MENU" ? ["fill", "type", "menu"]
      : suffix === "MENTION" ? ["fill", "type", "menu", "click", "mention"]
      : ["fill", "type", "menu", "click", "mention", "End", "insert", "Enter"]);
  }
});

test("native Skill tools require the exact current manually attached file and still read its full installed text", () => {
  const body = source.split("function toolSteps(")[1]?.split("\nasync function stopApp(")[0];
  assert.ok(body);
  for (const [platform, skillRoot, nativePath] of [
    ["win32", "C:\\private-path-canary\\skills\\memorax-code", "c:\\private-path-canary\\skills\\memorax-code\\SKILL.md"],
    ["win32", "D:\\private-path-canary\\skills\\memorax-code", "d:\\private-path-canary\\skills\\memorax-code\\SKILL.md"],
    ["win32", "c:\\private-path-canary\\skills\\memorax-code", "c:\\private-path-canary\\skills\\memorax-code\\SKILL.md"],
    ["win32", "d:\\private-path-canary\\skills\\memorax-code", "d:\\private-path-canary\\skills\\memorax-code\\SKILL.md"],
    ["linux", "/private-path-canary/skills/memorax-code", "/private-path-canary/skills/memorax-code/SKILL.md"],
    ["darwin", "/private-path-canary/skills/memorax-code", "/private-path-canary/skills/memorax-code/SKILL.md"],
  ]) for (const newline of ["\n", "\r\n"]) {
    const pathJoin = platform === "win32" ? win32.join : posix.join;
    const installedPath = pathJoin(skillRoot, "SKILL.md");
    const content = "# Installed Skill\n\nKeep this exact body and trailing newline.\n";
    const skillText = ["---", "name: memorax-code", "description: synthetic", "---", "", " \t", content].join("\n").replaceAll("\n", newline);
    const match = { fullPath: nativePath, content, manuallyAttached: true };
    const other = { ...match, fullPath: pathJoin(skillRoot, "private-other-canary", "SKILL.md") };
    const differentSeparator = platform === "win32" ? nativePath.replaceAll("\\", "/") : nativePath.replaceAll("/", "\\");
    for (const [selected, suffix] of [
      [undefined, "PATH"], [[], "PATH"], [[other], "PATH"], [[match, match], "PATH"],
      [[{ ...match, manuallyAttached: false }], "TYPE"], [[{ ...match, manuallyAttached: undefined }], "TYPE"],
      [[{ ...match, content: "private-content-canary" }], "CONTENT"], [[{ ...match, content: content.trimEnd() }], "CONTENT"],
      [[{ ...match, content: skillText }], "CONTENT"],
      [[{ ...match, fullPath: differentSeparator }], "PATH"],
      [[{ ...match, fullPath: nativePath.replace("private-path-canary", "Private-path-canary") }], "PATH"],
      [[{ ...match, fullPath: nativePath.replace("SKILL.md", "skill.md") }], "PATH"],
      ...(platform === "win32" ? [[[{ ...match, fullPath: nativePath.replace(/^[a-z]:/, (drive) => drive.toUpperCase()) }], "PATH"]] : []),
      [[match], undefined], [[other, match], undefined],
    ]) {
      const prior = { conversationId: "synthetic-session", completed: true, turnBlobId: Buffer.alloc(32), selectedCursorRules: [match] };
      const run = { prompt: "/memorax-code synthetic prompt", conversationId: prior.conversationId,
        requestContextCloseCount: 1, turnRefs: [], selectedCursorRules: selected,
        inputRequestContext: { agentSkills: [match], agentSkillsInfoComplete: true },
        requestContext: { agentSkills: [match], agentSkillsInfoComplete: true,
          hooksAdditionalContext: "MEMORAX_CODE_MEMORY_CLI_TRACE_CLIENT=cursor and MEMORAX_CODE_MEMORY_CLI_TRACE_SESSION_ID=synthetic-session" } };
      const toolSteps = runInNewContext(`(function toolSteps(${body})`, {
        process: { platform }, join: pathJoin, skillRoot, skillText, agent: { runs: [prior, run] },
        interruption: undefined, turns: [{ sessionId: run.conversationId, prompt: run.prompt, operation: "search" }],
        check(value, code) { if (!value) throw Object.assign(new Error(code), { code }); },
      }, { timeout: 100 });
      if (suffix) assert.throws(() => toolSteps(run, []), (error) => {
        assert.equal(error.code, `CURSOR_APP_SKILL_ATTACHMENT_${suffix}`);
        assert.equal(error.message, error.code);
        assert.deepEqual(Object.keys(error), ["code"]);
        assert.equal(JSON.stringify(error).includes("canary"), false);
        return true;
      });
      else {
        assert.deepEqual(JSON.parse(JSON.stringify(toolSteps(run, []))), { kind: "read", path: installedPath });
        assert.deepEqual(JSON.parse(JSON.stringify(toolSteps(run, [{ kind: "read", path: installedPath, content: skillText }]))),
          { kind: "read", path: pathJoin(skillRoot, "references", "memorax-search.md") });
        if (nativePath !== installedPath) assert.throws(() => toolSteps(run, [{ kind: "read", path: nativePath, content: skillText }]),
          { code: "CURSOR_APP_SKILL_NOT_READ" });
        assert.throws(() => toolSteps(run, [{ kind: "read", path: installedPath, content }]),
          { code: "CURSOR_APP_SKILL_NOT_READ" });
      }
    }
  }
});

test("native Shell commands keep POSIX quoting and route Windows Skill context and pending markers", () => {
  const shell = source.slice(source.indexOf("function quote("), source.indexOf("\nfunction assertSkillMemory("));
  const body = source.split("function toolSteps(")[1]?.split("\nasync function stopApp(")[0];
  assert.ok(shell && body);
  const posix = runInNewContext(`(() => { ${shell}; return shellCommand; })()`, { windows: undefined });
  assert.equal(posix(["/owned/tool", "it's a value"], { FIXTURE: "a b" }), "'env' 'FIXTURE=a b' '/owned/tool' 'it'\\''s a value'");
  for (const operation of ["search", "add", "interrupt"]) {
    const calls = [], workspace = "C:\\owned\\workspace", skillRoot = "C:\\owned\\skills\\memorax-code";
    const run = { prompt: "synthetic prompt", conversationId: "synthetic-session", requestContextCloseCount: 1 };
    const interruption = { sessionId: run.conversationId, runIndex: 1, marker: "C:\\owned\\pending marker" };
    const encodedCommand = "ZgBpAHgAdAB1AHIAZQA=", command = `powershell.exe -EncodedCommand ${encodedCommand}`;
    const reference = win32.join(skillRoot, "references", `memorax-${operation}.md`);
    const results = operation === "interrupt" ? [] : [
      { kind: "read", path: win32.join(skillRoot, "SKILL.md"), content: "installed skill" },
      { kind: "read", path: reference, content: "installed reference" },
    ];
    const toolSteps = runInNewContext(`(() => { ${shell}; return function toolSteps(${body}; })()`, {
      process: { platform: "win32", execPath: "C:\\owned\\node.exe" }, join: win32.join,
      env: { MEMORAX_CODE_MEMORAX_ENDPOINT: "http://127.0.0.1:12345", MEMORAX_CODE_HOME: "C:\\owned\\state" },
      agent: { runs: operation === "interrupt" ? [undefined, run] : [run] },
      turns: [{ sessionId: run.conversationId, prompt: run.prompt, operation }],
      interruption,
      interruptedFixture: { prompt: run.prompt }, workspace, skillRoot, skillText: "installed skill",
      referenceTexts: new Map([[operation, "installed reference"]]),
      skillQuery: "query ' value", skillMemory: "memory ' value", skillReason: "reason ' value",
      windows: { windowsShellCommand(args, environment) {
        calls.push({ args: Array.from(args), environment: { ...environment } }); return command;
      } },
      assertCursorAppSkillReference(content, actualOperation, platform) {
        assert.equal(content, "installed reference"); assert.equal(actualOperation, operation); assert.equal(platform, "win32");
        return "C:\\owned\\bin\\memorax-cli.cmd";
      },
      check(value, code) { if (!value) throw Object.assign(new Error(code), { code }); },
    }, { timeout: 100 });
    assert.deepEqual(JSON.parse(JSON.stringify(toolSteps(run, results))), {
      kind: "shell", command, workingDirectory: workspace, timeoutMs: 20000,
    });
    assert.equal(interruption.encodedCommand, operation === "interrupt" ? encodedCommand : undefined);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], operation === "interrupt" ? {
      args: ["C:\\owned\\node.exe", "-e", "require('node:fs').writeFileSync(process.argv[1], 'unexpected execution')", "C:\\owned\\pending marker"],
      environment: {},
    } : {
      args: ["C:\\owned\\bin\\memorax-cli.cmd", ...(operation === "search"
        ? ["search", "--query", "query ' value", "--json"]
        : ["add", "--memory", "memory ' value", "--type", "procedural", "--reason", "reason ' value", "--json"])],
      environment: { MEMORAX_CODE_MEMORAX_ENDPOINT: "http://127.0.0.1:12345", MEMORAX_CODE_HOME: "C:\\owned\\state",
        MEMORAX_CODE_MEMORY_CLI_TRACE_CLIENT: "cursor", MEMORAX_CODE_MEMORY_CLI_TRACE_SESSION_ID: run.conversationId },
    });
  }
});

test("POSIX Skill commands bind fixture state and request network access only on macOS", () => {
  const shell = source.slice(source.indexOf("function quote("), source.indexOf("\nfunction assertSkillMemory("));
  const body = source.split("function toolSteps(")[1]?.split("\nasync function stopApp(")[0];
  const env = { MEMORAX_CODE_MEMORAX_ENDPOINT: "http://127.0.0.1:12345", MEMORAX_CODE_HOME: "/owned/state ' space" };
  const run = { prompt: "synthetic prompt", conversationId: "synthetic-session", requestContextCloseCount: 1 };
  for (const platform of ["darwin", "linux"]) for (const operation of ["search", "add"]) {
    const agent = { runs: [run] };
    const toolSteps = runInNewContext(`(() => { ${shell}; return function toolSteps(${body}; })()`, {
      process: { platform, execPath: "/owned/node" }, windows: undefined, env, join, agent,
      turns: [{ sessionId: run.conversationId, prompt: run.prompt, operation }],
      interruption: { sessionId: run.conversationId, runIndex: 1, marker: "/owned/pending" }, interruptedFixture: { prompt: run.prompt },
      workspace: "/owned/workspace", skillRoot: "/owned/skill", skillText: "installed skill",
      referenceTexts: new Map([[operation, "installed reference"]]),
      skillQuery: "query", skillMemory: "memory", skillReason: "reason",
      assertCursorAppSkillReference: () => "memorax-cli",
      check(value, code) { if (!value) throw Object.assign(new Error(code), { code }); },
    }, { timeout: 100 });
    const result = toolSteps(run, [
      { kind: "read", path: "/owned/skill/SKILL.md", content: "installed skill" },
      { kind: "read", path: `/owned/skill/references/memorax-${operation}.md`, content: "installed reference" },
    ]);
    const args = operation === "search" ? "'search' '--query' 'query' '--json'"
      : "'add' '--memory' 'memory' '--type' 'procedural' '--reason' 'reason' '--json'";
    assert.equal(result.command, "'env' 'MEMORAX_CODE_MEMORAX_ENDPOINT=http://127.0.0.1:12345' "
      + "'MEMORAX_CODE_HOME=/owned/state '\\'' space' 'MEMORAX_CODE_MEMORY_CLI_TRACE_CLIENT=cursor' "
      + `'MEMORAX_CODE_MEMORY_CLI_TRACE_SESSION_ID=synthetic-session' 'memorax-cli' ${args}`);
    assert.equal(result.workingDirectory, "/owned/workspace");
    assert.equal(result.timeoutMs, 20000);
    assert.equal(result.networkAccess, platform === "darwin" ? true : undefined);
    agent.runs = [undefined, run];
    assert.equal(toolSteps(run, []).networkAccess, undefined);
  }
});

test("macOS cleanup uses the read-only owned-path and observed-PID audit without scanning Linux proc", async () => {
  const body = source.split("async function ownedProcessesRemain(")[1]?.split("\nfunction assertWriteback(")[0];
  const calls = [], observedMacosPids = new Set([234]);
  const audit = runInNewContext(`(async function ownedProcessesRemain(${body})`, {
    process: { pid: 123 }, macosPaths: { appBundle: "/owned/Cursor.app" }, packageRoot: "/owned/package",
    env: { MEMORAX_CODE_HOME: "/owned/state" }, interruption: { marker: "/owned/marker" }, observedMacosPids,
    macos: { auditMacosProcesses(options) { calls.push(options); return true; } },
    readdir() { assert.fail("macOS must not use /proc"); },
  }, { timeout: 100 });
  assert.equal(await audit({ includeBackend: false }), true);
  assert.equal(calls[0].observedPids, observedMacosPids);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ appBundle: "/owned/Cursor.app", packageRoot: "/owned/package",
    stateHome: "/owned/state", marker: "/owned/marker", includeBackend: false, selfPid: 123, observedPids: {} }]);
});

test("Windows cleanup delegates only the current owned paths and fails closed on audit errors", async () => {
  const body = source.split("async function ownedProcessesRemain(")[1]?.split("\nfunction assertWriteback(")[0];
  assert.ok(body);
  for (const includeBackend of [true, false]) for (const result of [true, false, "error"]) {
    const env = { MEMORAX_CODE_HOME: "C:\\owned\\state" }, calls = [];
    const audit = runInNewContext(`(async function ownedProcessesRemain(${body})`, {
      process: { pid: 123 }, macos: undefined, appPath: "C:\\owned\\Cursor.exe", packageRoot: "C:\\owned\\package",
      env, interruption: { marker: "C:\\owned\\marker", encodedCommand: "ZgBpAHgAdAB1AHIAZQA=" },
      windows: { async auditWindowsProcesses(options) {
        calls.push(options);
        if (result === "error") throw Object.assign(new Error("audit failed"), { code: "CURSOR_APP_WINDOWS_PROCESS_AUDIT" });
        return result;
      } },
      readdir() { assert.fail("Windows must not use /proc"); },
    }, { timeout: 100 });
    if (result === "error") await assert.rejects(audit({ includeBackend }), { code: "CURSOR_APP_WINDOWS_PROCESS_AUDIT" });
    else assert.equal(await audit(includeBackend ? undefined : { includeBackend }), result);
    assert.equal(calls.length, 1); assert.equal(calls[0].env, env);
    assert.deepEqual({ ...calls[0] }, { appPath: "C:\\owned\\Cursor.exe", packageRoot: "C:\\owned\\package",
      stateHome: env.MEMORAX_CODE_HOME, marker: "C:\\owned\\marker", encodedCommand: "ZgBpAHgAdAB1AHIAZQA=",
      includeBackend, selfPid: 123, env });
  }
});

test("macOS cleanup records descendants before browser shutdown and still closes after an audit failure", async () => {
  const body = source.split("async function stopApp(")[1]?.split("\nasync function assertProcessesStopped(")[0];
  assert.ok(body);
  for (const failCapture of [false, true]) {
    const calls = [], observedMacosPids = new Set([200]);
    const error = Object.assign(new Error("audit failed"), { code: "CURSOR_APP_MACOS_PROCESS_AUDIT" });
    const app = { pid: 201, exitCode: null, signalCode: null };
    const stopApp = runInNewContext(`(async function stopApp(${body})`, {
      macos: { async captureMacosDescendants(pid) {
        calls.push("capture"); assert.equal(pid, 201);
        if (failCapture) throw error;
        return new Set([201, 202]);
      } }, app, observedMacosPids, page: {},
      browser: { async close() { calls.push("close"); app.exitCode = 0; } },
      bounded: (promise) => promise,
      once() { assert.fail("an exited owned child must not receive signals"); },
    }, { timeout: 100 });
    if (failCapture) await assert.rejects(stopApp(), (caught) => caught === error);
    else await stopApp();
    assert.deepEqual(calls, ["capture", "close"]);
    assert.deepEqual([...observedMacosPids], failCapture ? [200] : [200, 201, 202]);
  }
});

test("Windows App cleanup uses its held live child after browser close, never an exited or absent child", async () => {
  const body = source.split("async function stopApp(")[1]?.split("\nasync function assertProcessesStopped(")[0];
  assert.ok(body);
  for (const mode of ["live", "exited", "signaled", "absent", "browser-exits", "browser-error"]) {
    const calls = [], env = { HOME: "C:\\owned\\home" };
    const app = mode === "absent" ? undefined : Object.assign(new EventEmitter(), {
      pid: 201, exitCode: mode === "exited" ? 0 : null, signalCode: mode === "signaled" ? "SIGTERM" : null,
      kill() { assert.fail("a closed Windows child must not receive fallback signals"); },
    });
    const error = Object.assign(new Error("browser close failed"), { code: "CURSOR_APP_BROWSER_CLEANUP" });
    const stopApp = runInNewContext(`(async function stopApp(${body})`, {
      macos: undefined, app, env, page: {}, once, bounded: (promise) => promise,
      delay() { return new Promise(() => {}); },
      browser: { async close() {
        calls.push("browser");
        if (mode === "browser-exits") app.exitCode = 0;
        if (mode === "browser-error") throw error;
      } },
      windows: { async stopWindowsApp(child, actualEnv) {
        calls.push("stop"); assert.equal(child, app); assert.equal(actualEnv, env);
        assert.equal(child.exitCode, null); assert.equal(child.signalCode, null);
        child.exitCode = 0; child.emit("close", 0, null);
      } },
      check(value, code) { if (!value) throw Object.assign(new Error(code), { code }); },
    }, { timeout: 100 });
    if (mode === "browser-error") await assert.rejects(stopApp(), (caught) => caught === error);
    else await stopApp();
    assert.deepEqual(calls, ["live", "browser-error"].includes(mode) ? ["browser", "stop"] : ["browser"]);
  }
});

test("Windows App stop preserves the first failure snapshot through repeated cleanup", async () => {
  const body = source.split("async function stopApp(")[1]?.split("\nasync function assertProcessesStopped(")[0];
  assert.ok(body);
  for (const primaryError of [undefined, "CURSOR_APP_ADD_TIMEOUT"]) {
    const report = primaryError ? { errorCode: primaryError } : {};
    const env = { SystemRoot: "C:\\Windows" }, failures = [];
    const app = Object.assign(new EventEmitter(), { pid: 201, exitCode: null, signalCode: null,
      kill() { assert.fail("failed taskkill must not introduce fallback signals"); } });
    let stops = 0;
    const stopApp = runInNewContext(`(async function stopApp(${body})`, {
      macos: undefined, app, env, report, page: {}, once, bounded: (promise) => promise,
      browser: { async close() {} },
      windows: { async stopWindowsApp(child, actualEnv) {
        try {
          return await stopWindowsApp(child, actualEnv, async () => {
            stops += 1;
            if (stops === 2) child.exitCode = 0;
            throw Object.assign(new Error("private-stop-canary"), { code: stops === 1 ? 128 : 1,
              stdout: "private-stop-canary", stderr: stops === 1
                ? 'ERROR: The process "201" not found.\nprivate-stop-canary'
                : "ERROR: Access is denied.\nprivate-stop-canary" });
          });
        } catch (error) { failures.push(error); throw error; }
      } },
      check(value, code) { if (!value) throw Object.assign(new Error(code), { code }); },
    }, { timeout: 100 });
    await assert.rejects(stopApp(), (error) => error === failures[0]
      && error.code === "CURSOR_APP_WINDOWS_APP_STOP_EXIT_128");
    const snapshot = report.windowsAppStop;
    assert.deepEqual(snapshot, { taskkillExitCode: 128, childExitCode: null, childSignal: "none", timedOut: false,
      outputOverflow: false, markers: { processNotFound: true, accessDenied: false } });
    await assert.rejects(stopApp(), (error) => error === failures[1]
      && error.code === "CURSOR_APP_WINDOWS_APP_STOP_EXIT_1");
    assert.equal(failures[1].windowsAppStop.childExitCode, 0);
    assert.equal(failures[1].windowsAppStop.markers.accessDenied, true);
    assert.equal(report.windowsAppStop, snapshot);
    assert.equal(snapshot.childExitCode, null);
    assert.equal(report.errorCode, primaryError);
    assert.equal(JSON.stringify(report).includes("private-stop-canary"), false);
    assert.equal(stops, 2);
    app.emit("close", 0, null);
  }
});

test("native cleanup audits the pending marker Node and Shell without killing discovered processes", async () => {
  const body = source.split("async function ownedProcessesRemain(")[1]?.split("\nfunction assertWriteback(")[0];
  assert.ok(body);
  const marker = "/owned/workspace/cancelled-shell-marker";
  for (const [argv, includeBackend, expected] of [
    [["/usr/local/bin/node", "-e", "synthetic marker script", marker], true, true],
    [["/bin/sh", "-c", `/usr/local/bin/node -e 'synthetic marker script' '${marker}'`], true, true],
    [["/owned/app/cursor"], false, true],
    [["node", "/owned/package/backend.mjs"], true, true],
    [["node", "/owned/package/backend.mjs"], false, false],
    [["node", "--home", "/owned/state"], true, true],
    [["node", "/unrelated/workspace/cancelled-shell-marker"], true, false],
    [["node", "/owned/state-other/tool.mjs"], true, false],
  ]) {
    const check = runInNewContext(`(async function ownedProcessesRemain(${body})`, {
      process: { pid: 1 }, macos: undefined, windows: undefined, dirname, appPath: "/owned/app/cursor", packageRoot: "/owned/package",
      env: { MEMORAX_CODE_HOME: "/owned/state" }, interruption: { marker },
      async readdir(path) { assert.equal(path, "/proc"); return ["1", "2", "self"]; },
      async readFile(path, encoding) {
        assert.equal(path, "/proc/2/cmdline"); assert.equal(encoding, "utf8");
        return argv.join("\0");
      },
    }, { timeout: 100 });
    assert.equal(await check({ includeBackend }), expected);
  }
});

test("native preflight validates Node and platform without calling getuid on Windows", () => {
  const body = source.split("\ntry {\n")[1]?.split("  // macOS Unix sockets")[0];
  const windowsGuard = source.split('  } else if (process.platform === "win32") {\n')[1]?.split("    windows = await import(")[0];
  assert.ok(body && windowsGuard);
  for (const [platform, node, expectedNodeMajor, argc, uid, errorCode] of [
    ["win32", "24.0.0", "24", 8], ["win32", "22.13.0", "22", 7],
    ["linux", "24.0.0", "24", 8, 1000], ["darwin", "24.0.0", "24", 8, 501],
    ["linux", "24.0.0", "24", 8, 0, "CURSOR_APP_ISOLATION"],
    ["win32", "22.12.0", "22", 8, undefined, "CURSOR_APP_ARGUMENTS"],
    ["win32", "20.0.0", "20", 8, undefined, "CURSOR_APP_ARGUMENTS"],
    ["win32", "24.0.0", "22", 8, undefined, "CURSOR_APP_ARGUMENTS"],
    ["win32", "24.0.0", "24", 6, undefined, "CURSOR_APP_ARGUMENTS"],
    ["freebsd", "24.0.0", "24", 8, 1000, "CURSOR_APP_ARGUMENTS"],
  ]) {
    const preflight = runInNewContext(`(() => { ${body} })`, {
      expectedNodeMajor, process: { platform, versions: { node }, argv: Array(argc),
        getuid() { assert.notEqual(platform, "win32"); return uid; } },
      check(value, code) { if (!value) throw Object.assign(new Error(code), { code }); },
    }, { timeout: 100 });
    if (errorCode) assert.throws(preflight, { code: errorCode }); else preflight();
  }
  for (const [actions, runnerOs, arch, allowed] of [
    ["true", "Windows", "x64", true], [undefined, "Windows", "x64", false],
    ["false", "Windows", "x64", false], ["true", "macOS", "x64", false], ["true", "Windows", "arm64", false],
  ]) {
    const guard = runInNewContext(`(() => { ${windowsGuard} })`, {
      process: { env: { GITHUB_ACTIONS: actions, RUNNER_OS: runnerOs }, arch },
      check(value, code) { if (!value) throw Object.assign(new Error(code), { code }); },
    }, { timeout: 100 });
    if (allowed) guard(); else assert.throws(guard, { code: "CURSOR_APP_WINDOWS_RUNNER" });
  }
});
