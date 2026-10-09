import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { basename, dirname, join, win32 } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { collectCursorAppBackendDiagnostics, collectCursorAppShellDiagnostics, collectCursorAppStopDiagnostics } from "./cursor-app-diagnostics.mjs";

const source = (await readFile(new URL("./cursor-app-native-check.mjs", import.meta.url), "utf8")).replaceAll("\r\n", "\n");
const privateCanary = "private-content-path-token-canary";
function check(value, code) { if (!value) throw Object.assign(new Error(code), { code }); }
function nativeFunction(name, context = {}) {
  const definition = source.match(new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?(?=\\n(?:async )?function )`))?.[0];
  assert.ok(definition, name);
  return runInNewContext(`(${definition})`, { check, Buffer, basename, dirname, join, once, ...context }, { timeout: 100 });
}
function childProcess() {
  return Object.assign(new EventEmitter(), { pid: 201, exitCode: null, signalCode: null,
    stdout: new PassThrough(), stderr: new PassThrough() });
}

test("memory HTTP callback preserves split UTF-8 and rejects oversized or malformed requests", async (t) => {
  const body = source.split("memory = createServer(")[1]?.split("\n  await new Promise((resolve) => memory.listen(")[0].trim();
  assert.ok(body);
  const memoryRequests = [];
  const handler = runInNewContext(`(${body.slice(0, -2)})`, { check, memoryRequests, searchMemory: "synthetic memory" });
  let firstChunk;
  const server = createServer((request, response) => {
    request.once("data", () => firstChunk?.());
    return handler(request, response);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const content = "Exact \u4e2d\u6587 \ud83e\uddea content";
  const bytes = Buffer.from(JSON.stringify({ messages: [{ role: "user", content }] }));
  for (const payload of [bytes, Buffer.alloc(1024 * 1024 + 1, "x"), Buffer.from(privateCanary)]) {
    const seen = new Promise((resolve) => { firstChunk = resolve; });
    let request;
    const reply = new Promise((resolve, reject) => {
      request = httpRequest({ host: "127.0.0.1", port: server.address().port, method: "POST",
        path: "/v1/memories/add", agent: false, headers: { authorization: "Token synthetic" } }, async (response) => {
        response.resume();
        await once(response, "end");
        resolve(response.statusCode);
      });
      request.once("error", reject);
    });
    const split = payload === bytes ? bytes.indexOf(Buffer.from("\u4e2d")) + 1 : 16;
    request.write(payload.subarray(0, split));
    await seen;
    request.end(payload.subarray(split));
    assert.equal(await reply, payload === bytes ? 200 : 400);
  }
  assert.equal(memoryRequests[0].body.messages[0].content, content);
  assert.equal(memoryRequests[0].authorization, "Token synthetic");
  assert.ok(memoryRequests.slice(1).every((request) => request.invalid === true));
});

test("candidate commands drain stderr, bound output/time and preserve redacted stop failure evidence", async () => {
  for (const mode of ["success", "failure", "invalid-json", "timeout", "overflow"]) {
    const child = childProcess(), report = {}, kills = [];
    let timer, cleared = false;
    const close = (code, signal = null) => {
      child.exitCode = code; child.signalCode = signal;
      child.stdout.end(); child.stderr.end(); child.emit("close", code, signal);
    };
    child.kill = (signal) => { kills.push(signal); queueMicrotask(() => close(null, signal)); };
    const command = nativeFunction("command", {
      process: { execPath: "/owned/node" }, packageRoot: "/owned/package", root: "/owned", env: {}, report,
      collectCursorAppStopDiagnostics,
      setTimeout(callback, milliseconds) { assert.equal(milliseconds, 30000); timer = callback; return timer; },
      clearTimeout(value) { assert.equal(value, timer); cleared = true; },
      spawn(file, args, options) {
        assert.equal(file, "/owned/node");
        assert.deepEqual(Array.from(args), [join("/owned/package", "bin/memorax-code.mjs"), "stop"]);
        assert.equal(options.shell, undefined);
        queueMicrotask(() => {
          child.stderr.write(privateCanary);
          if (mode === "timeout") return timer();
          if (mode === "overflow") return child.stdout.write("x".repeat(1024 * 1024 + 1));
          child.stdout.write(mode === "invalid-json" ? privateCanary : JSON.stringify({ ok: mode === "success", action: "stop",
            backend: { errorCode: "BACKEND_STOP_TIMEOUT", state: privateCanary } }));
          close(mode === "failure" ? 1 : 0);
        });
        return child;
      },
    });
    if (mode === "success") assert.equal((await command(["stop"], "CURSOR_APP_CANDIDATE_STOP")).ok, true);
    else {
      await assert.rejects(command(["stop"], "CURSOR_APP_CANDIDATE_STOP"), { code: "CURSOR_APP_CANDIDATE_STOP" });
      assert.equal(report.candidateStop.timedOut, mode === "timeout");
      assert.equal(report.candidateStop.outputOverflow, mode === "overflow");
    }
    assert.equal(cleared, true);
    assert.deepEqual(kills, ["timeout", "overflow"].includes(mode) ? ["SIGKILL"] : []);
    assert.equal(JSON.stringify(report).includes(privateCanary), false);
  }
});

test("failure collection reads existing diagnostics without replacing the original failure", async () => {
  const body = source.split("  const run = agent?.runs.at(-1);")[1]?.split("\n}\nfinally {")[0];
  assert.ok(body);
  const run = { conversationId: "11111111-1111-1111-1111-111111111111", requestId: "22222222-2222-2222-2222-222222222222" };
  const identity = { sessionId: run.conversationId, turnId: run.requestId };
  for (const failed of [false, true]) {
    const report = { errorCode: "CURSOR_APP_ADD_TIMEOUT" };
    await runInNewContext(`(async () => {${body}})()`, { run, report,
      env: { MEMORAX_CODE_HOME: "/owned/state" }, userData: "/owned/app-data", collectCursorAppBackendDiagnostics,
      async collectCursorAppDiagnostics(input) { assert.deepEqual({ ...input }, { home: "/owned/state", ...identity }); return {}; },
      async collectCursorAppHookDiagnostics(input) { assert.deepEqual({ ...input }, { home: "/owned/app-data", ...identity }); return { readStatus: "absent" }; },
      async command(args) {
        assert.deepEqual(Array.from(args), ["logs", "--diagnostics", "--limit", "100", "--json", "--home", "/owned/state"]);
        if (failed) throw new Error(privateCanary);
        return { action: "diagnostics", ok: true, records: [] };
      },
    });
    assert.equal(report.errorCode, "CURSOR_APP_ADD_TIMEOUT");
    assert.equal(report.backendDiagnostics.readStatus, failed ? "unavailable" : "present");
    assert.equal(JSON.stringify(report).includes(privateCanary), false);
  }
});

test("App launch preserves the sandbox and isolated arguments with a longer Windows driver deadline", async () => {
  for (const platform of ["linux", "darwin", "win32"]) {
    const child = childProcess(), waits = [], argumentsSeen = [];
    const page = { url: () => "file:///workbench.html", evaluate: async () => true, setDefaultTimeout() {} };
    const start = nativeFunction("startApp", {
      macos: platform === "darwin" ? { createDevToolsEndpointReader: () => ({ push() {}, get: () => "ws://127.0.0.1:12346" }) } : undefined,
      windows: platform === "win32" ? {} : undefined,
      appPath: "/owned/app", userData: "/owned/app-data", root: "/owned", workspace: "/owned/workspace",
      agent: { url: "http://127.0.0.1:12345" }, debugPort: 12346, env: {}, report: {}, AbortSignal,
      fetch: async () => ({ ok: true }), bounded: (promise) => promise,
      chromium: { connectOverCDP: async () => ({ contexts: () => [{ pages: () => [page] }] }) },
      async waitFor(predicate, code, deadline) { waits.push([code, deadline]); assert.equal(await predicate(), true); },
      spawn(file, args, options) {
        assert.equal(file, "/owned/app"); assert.equal(options.shell, undefined);
        argumentsSeen.push(...args);
        return child;
      },
    });
    await start();
    assert.equal(argumentsSeen.includes("--force-disable-user-env"), platform !== "linux");
    assert.ok(argumentsSeen.includes("--use-inmemory-secretstorage"));
    assert.ok(argumentsSeen.includes("--test-backend-url=http://127.0.0.1:12345"));
    assert.ok(argumentsSeen.includes("--remote-debugging-address=127.0.0.1"));
    assert.equal(argumentsSeen.some((arg) => ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu-sandbox"].includes(arg)), false);
    assert.equal(argumentsSeen.at(-1), "/owned/workspace");
    assert.deepEqual(waits.at(-1), ["CURSOR_APP_DRIVER", platform === "win32" ? 90000 : 30000]);
    child.stdout.end(); child.stderr.end();
  }
});

test("native sequence restores the original session after workspace switching without restarting Backend", async () => {
  const body = source.split('  report.stage = "app-start";')[1]?.split('  report.stage = "cleanup";')[0];
  const starts = [], stops = [], turns = [], commands = [];
  let sessions = 0;
  const context = { check, join, root: "/owned", firstWorkspace: "/owned/workspace", workspace: "/owned/workspace",
    report: { evidence: {} }, recoveryFixture: { prompt: "recovery" },
    async mkdir() {}, async startApp() { context.app = { pid: starts.length + 1 }; starts.push(context.workspace); },
    async stopApp() { stops.push(context.workspace); context.app = undefined; },
    async assertProcessesStopped(options) { assert.equal(options.includeBackend, false); },
    async openSession(id) { return id ?? ["session-a", "session-b", "session-deny"][sessions++]; },
    async runTurn(sessionId) { turns.push([sessionId, context.workspace]); }, assertWriteback() {}, assertSnapshot() {},
    async cli(action) { commands.push(action); return { cursorAdapter: { cursorHooks: { runtimeObserved: true } } }; },
    async interruptPendingShell() { context.interruption = { sessionId: "session-cancel" }; },
    async assertInterrupted(options) { assert.equal(options.recovered, true); },
    async runRepoMemoryWorker() { assert.equal(turns.length, 8); },
  };
  await runInNewContext(`(async () => {${body}})()`, context);
  assert.deepEqual(starts, ["/owned/workspace", "/owned/project-beta", "/owned/workspace"]);
  assert.deepEqual(stops, starts.slice(0, 2));
  assert.deepEqual(commands, ["status"]);
  assert.deepEqual(turns.map(([session]) => session), ["session-a", "session-a", "session-b",
    "session-a", "session-a", "session-a", "session-deny", "session-cancel"]);
  assert.equal(turns[2][1], "/owned/project-beta");
  assert.equal(turns[3][1], "/owned/workspace");
  assert.equal(context.report.evidence.sameSessionRecovered, true);
});

test("Skill submission preserves its menu mention and rejects ambiguous menu or missing mention", async () => {
  for (const [operation, menuCount, mentionCount, suffix] of [[undefined, 0, 0], ["search", 1, 1],
    ["add", 2, 1, "MENU"], ["search", 1, 0, "MENTION"]]) {
    const events = [], fixture = { operation, prompt: operation ? "/memorax-code synthetic prompt" : "synthetic prompt" };
    let text = "", attached = false;
    const input = { async fill(value) { events.push("fill"); text = value; attached = false; },
      async pressSequentially(value) { text += value; }, locator: () => ({ count: async () => mentionCount }),
      async press(key) { events.push(key); if (key === "Enter") { assert.equal(text, fixture.prompt); assert.equal(attached, Boolean(operation)); } } };
    const submit = nativeFunction("submitPrompt", { page: {
      locator: () => ({ locator: () => ({ filter: ({ hasText }) => {
        assert.equal(hasText.test("/memorax-code-other"), false);
        return { count: async () => menuCount, async click() { attached = true; text = "/memorax-code "; } };
      } }) }),
      keyboard: { async insertText(value) { assert.equal(attached, true); text += value; } },
    }, async waitFor(predicate, code) { check(await predicate(), code); } });
    if (suffix) await assert.rejects(submit(input, fixture), { code: `CURSOR_APP_SKILL_${suffix}` });
    else await submit(input, fixture);
    assert.deepEqual(events, suffix ? ["fill"] : operation ? ["fill", "End", "Enter"] : ["fill", "Enter"]);
  }
});

test("Run and Skip bind completed clicks to the exact run and fail closed on identity or marker conflicts", async () => {
  for (const permission of [undefined, "deny"]) for (const mode of ["clicked", "click-failed", "wrong-session", "marker-exists"]) {
    if (!permission && mode === "marker-exists") continue;
    const run = { conversationId: mode === "wrong-session" ? "other-session" : "session", prompt: "prompt",
      pendingTool: { kind: "shell", toolCallId: "tool-id" }, shellApproval: { toolCallId: "tool-id", clicked: false } };
    const retry = { ...run, shellApproval: { toolCallId: "retry", clicked: false } };
    const agent = { errors: [], runs: [] }, turns = [], selectors = [];
    const locator = { locator(selector) { selectors.push(selector); return locator; },
      getByRole(role, options) {
        assert.equal(role, "button"); assert.equal(options.name, permission ? "Skip" : "Run");
        return { count: async () => 1, isVisible: async () => true,
          async click() { agent.runs.push(retry); check(mode !== "click-failed", "CLICK_FAILED"); } };
      } };
    const runTurn = nativeFunction("runTurn", { turns, agent, report: {}, workspace: "/owned/project-beta",
      page: { locator: () => locator }, denial: { marker: "/owned/marker" },
      async assertMarkerAbsent() { check(mode !== "marker-exists", "CURSOR_APP_PERMISSION_TOOL_EXECUTED"); },
      async submitPrompt() { agent.runs.push(run); },
      async waitFor(predicate) { await predicate(); check(false, "PENDING"); },
    });
    await assert.rejects(runTurn("session", { prompt: "prompt", ...(permission ? { permission } : { operation: "search" }) }),
      { code: mode === "wrong-session" ? "CURSOR_APP_SKILL_APPROVAL_IDENTITY" : mode === "click-failed" ? "CLICK_FAILED"
        : mode === "marker-exists" ? "CURSOR_APP_PERMISSION_TOOL_EXECUTED" : "PENDING" });
    assert.equal(run.shellApproval.clicked, !permission && mode === "clicked");
    assert.equal(run.shellRejection?.clicked, permission && mode === "clicked" ? true : undefined);
    assert.equal(retry.shellApproval.clicked, false);
    assert.equal(turns[0].workspaceName, "project-beta");
    if (mode !== "wrong-session") assert.ok(selectors.includes('[data-tool-call-id="tool-id"]:visible'));
  }
});

test("same-session recovery requires new identities and excludes the cancelled turn from history", async () => {
  for (const mode of ["recovered", "cancelled-history", "reused-id"]) {
    const prior = { conversationId: "session", requestId: "old", userMessageId: "old", cancelled: true,
      completed: false, kvWrites: [], turnBlobId: Buffer.alloc(32) };
    const run = { conversationId: "session", prompt: "recovery", completed: true, userMessageId: "new",
      requestId: mode === "reused-id" ? "old" : "new", turnRefs: mode === "cancelled-history" ? [prior.turnBlobId] : [],
      kvReadCount: 0, kvReadResultCount: 0, kvWriteCount: 3, kvAckCount: 3,
      requestContextRequestCount: 1, requestContextResultCount: 1, requestContextCloseCount: 1 };
    const agent = { runs: [prior], errors: [] }, report = {};
    const runTurn = nativeFunction("runTurn", { agent, report, turns: [], workspace: "/owned/workspace",
      page: { locator: () => ({ locator: () => ({}) }) }, async submitPrompt() { agent.runs.push(run); },
      async waitFor(predicate) { check(report.stage !== "native-persistence", "VERIFIED"); assert.equal(await predicate(), true); },
    });
    await assert.rejects(runTurn("session", { prompt: "recovery" }), { code: mode === "recovered" ? "VERIFIED"
      : mode === "reused-id" ? "CURSOR_APP_REUSED_TURN_IDENTITY" : "CURSOR_APP_HISTORY_MISMATCH" });
  }
});

test("interruption and recovery require terminal traces, discarded metadata and no late Add", async () => {
  for (const recovered of [false, true]) for (const mode of ["valid", "metadata", "materialized", "late-add", "tool-ran"]) {
    const old = { requestId: "old", cancelled: true, completed: false,
      cancellation: { actionReceived: true, rejected: true, execClosed: true, transportClosed: true, rstCode: 8 },
      kvWriteCount: 0, kvAckCount: 0, execRequestCount: 1, execResultCount: 0, execCloseCount: 0,
      requestContextRequestCount: 1, requestContextResultCount: 1, requestContextCloseCount: 1 };
    const next = { requestId: "new", conversationId: "session", prompt: "recovery", completed: true };
    const store = { readStatus: "present", versionMatched: true, clientMatched: true, sessionMatched: true,
      activePresent: true, turnMatched: true, metadataPresent: mode === "metadata" };
    const reads = [];
    const interrupted = nativeFunction("assertInterrupted", { interruption: { sessionId: "session", runIndex: 0, marker: "/owned/marker" },
      agent: { runs: [old, next] }, recoveryFixture: { prompt: "recovery" }, env: { MEMORAX_CODE_HOME: "/owned/state" },
      async assertMarkerAbsent() { check(mode !== "tool-ran", "CURSOR_APP_INTERRUPTION_TOOL_EXECUTED"); },
      async collectCursorAppDiagnostics({ turnId }) {
        reads.push(turnId);
        return turnId === "old" ? { turnStore: { ...store, state: "interrupted", stopStatus: "aborted", reason: "interrupted" },
          trace: { readStatus: "present", turnStartCount: 1, interruptedCount: 1, completedCount: 0, materializedCount: mode === "materialized" ? 1 : 0 } }
          : { turnStore: { ...store, state: "accepted", stopStatus: "completed" },
            trace: { turnStartCount: 1, completedCount: 1, interruptedCount: 0, materializedCount: 1 } };
      },
      assertWriteback() { check(mode !== "late-add", "EXACT_WRITEBACK_MISMATCH"); },
    });
    if (mode === "valid") { await interrupted({ recovered }); assert.deepEqual(reads, recovered ? ["old", "new"] : ["old"]); }
    else await assert.rejects(interrupted({ recovered }), { code: mode === "tool-ran" ? "CURSOR_APP_INTERRUPTION_TOOL_EXECUTED"
      : mode === "late-add" ? "EXACT_WRITEBACK_MISMATCH" : recovered && mode === "metadata" ? "CURSOR_APP_RECOVERY_HOOK" : "CURSOR_APP_INTERRUPTION_HOOK" });
  }
});

test("Skill tools require the exact manually attached body and full installed file before the reference", () => {
  for (const [platform, skillRoot, paths] of [["linux", "/owned/skill", { join }], ["win32", "D:\\owned\\skill", win32]]) {
    const installed = paths.join(skillRoot, "SKILL.md"), content = "# Installed Skill\n";
    const skillText = "---\r\nname: memorax-code\r\n---\r\n\r\n" + content;
    const match = { fullPath: platform === "win32" ? installed.replace("D:", "d:") : installed, content, manuallyAttached: true };
    const run = { conversationId: "session", prompt: "/memorax-code prompt", requestContextCloseCount: 1, turnRefs: [],
      requestContext: { hooksAdditionalContext: "MEMORAX_CODE_MEMORY_CLI_TRACE_CLIENT=cursor and MEMORAX_CODE_MEMORY_CLI_TRACE_SESSION_ID=session" } };
    const tools = nativeFunction("toolSteps", { process: { platform }, join: paths.join, skillRoot, skillText,
      interruption: undefined, agent: { runs: [run] }, turns: [{ sessionId: "session", prompt: run.prompt, operation: "search" }] });
    for (const [selected, suffix] of [[[match], undefined], [[match, match], "PATH"],
      [[{ ...match, fullPath: installed + "-other" }], "PATH"], [[{ ...match, manuallyAttached: false }], "TYPE"],
      [[{ ...match, content: content.trimEnd() }], "CONTENT"]]) {
      run.selectedCursorRules = selected;
      if (suffix) assert.throws(() => tools(run, []), { code: `CURSOR_APP_SKILL_ATTACHMENT_${suffix}` });
      else assert.equal(tools(run, []).path, installed);
    }
    assert.equal(tools(run, [{ kind: "read", path: installed, content: skillText }]).path,
      paths.join(skillRoot, "references/memorax-search.md"));
    assert.throws(() => tools(run, [{ kind: "read", path: installed, content }]), { code: "CURSOR_APP_SKILL_NOT_READ" });
  }
});

test("Skill shell steps bind the isolated endpoint, state and session with macOS network permission", () => {
  for (const platform of ["linux", "darwin", "win32"]) for (const operation of ["search", "add"]) {
    const run = { conversationId: "session", prompt: "prompt", requestContextCloseCount: 1 };
    const env = { MEMORAX_CODE_HOME: "/owned/state", MEMORAX_CODE_MEMORAX_ENDPOINT: "http://127.0.0.1:12345" };
    const tools = nativeFunction("toolSteps", { process: { platform }, env, interruption: undefined,
      agent: { runs: [run] }, turns: [{ sessionId: "session", prompt: "prompt", operation }],
      skillRoot: "/owned/skill", skillText: "installed", workspace: "/owned/workspace",
      referenceTexts: new Map([[operation, "reference"]]), skillQuery: "query", skillMemory: "memory", skillReason: "reason",
      assertCursorAppSkillReference: () => platform === "win32" ? "memorax-cli.cmd" : "memorax-cli",
      shellCommand: (args, environment) => JSON.stringify({ args, environment }),
    });
    const shell = tools(run, [{ kind: "read", path: join("/owned/skill", "SKILL.md"), content: "installed" },
      { kind: "read", path: join("/owned/skill", "references", `memorax-${operation}.md`), content: "reference" }]);
    const command = JSON.parse(shell.command);
    assert.deepEqual(command.environment, { ...env, MEMORAX_CODE_MEMORY_CLI_TRACE_CLIENT: "cursor",
      MEMORAX_CODE_MEMORY_CLI_TRACE_SESSION_ID: "session" });
    assert.deepEqual(command.args, [platform === "win32" ? "memorax-cli.cmd" : "memorax-cli", ...(operation === "search"
      ? ["search", "--query", "query", "--json"] : ["add", "--memory", "memory", "--type", "procedural", "--reason", "reason", "--json"])]);
    assert.equal(shell.networkAccess, platform === "darwin" ? true : undefined);
    assert.equal(shell.workingDirectory, "/owned/workspace");
  }
});

test("cleanup captures macOS descendants before closing even when capture fails", async () => {
  for (const failed of [false, true]) {
    const calls = [], app = childProcess(), observedMacosPids = new Set();
    const stop = nativeFunction("stopApp", { app, observedMacosPids, windows: undefined, page: {},
      macos: { async captureMacosDescendants() { calls.push("capture"); check(!failed, "AUDIT_FAILED"); return [201, 202]; } },
      browser: { async close() { calls.push("close"); app.exitCode = 0; } }, bounded: (promise) => promise });
    if (failed) await assert.rejects(stop(), { code: "AUDIT_FAILED" }); else await stop();
    assert.deepEqual(calls, ["capture", "close"]);
    assert.deepEqual([...observedMacosPids], failed ? [] : [201, 202]);
  }
});

test("Windows cleanup waits for native child exit and releases listeners before owned fallback", async () => {
  for (const mode of ["quit-exit", "delayed-exit", "quit-no-exit", "no-page", "exited", "browser-error"]) {
    const app = childProcess(), calls = [];
    if (mode === "exited") app.exitCode = 0;
    const exit = () => { app.exitCode = 0; app.emit("exit", 0); app.emit("close", 0); };
    const stop = nativeFunction("stopApp", { app, macos: undefined, report: {}, env: {},
      page: ["no-page", "browser-error"].includes(mode) ? undefined : { evaluate: (callback) => callback() },
      window: { driver: { async executeCommand(command) {
        assert.equal(command, "workbench.action.quit"); calls.push("quit");
        assert.equal(app.listenerCount("exit"), 1);
        if (mode === "quit-exit") { exit(); throw new Error(privateCanary); }
      } } },
      async bounded(promise, code, milliseconds) {
        if (code === "CURSOR_APP_WINDOWS_QUIT_TIMEOUT") {
          assert.equal(milliseconds, 5000);
          let settled = false;
          promise.then(() => { settled = true; });
          for (let turn = 0; turn < 8; turn++) await Promise.resolve();
          if (mode !== "quit-exit") assert.equal(settled, false);
          if (mode === "delayed-exit") exit();
          else check(mode !== "quit-no-exit", code);
        }
        return promise;
      },
      browser: { async close() { calls.push("browser"); assert.equal(app.listenerCount("exit"), 0); check(mode !== "browser-error", "BROWSER_FAILED"); } },
      windows: { async stopWindowsApp(child) { assert.equal(child, app); calls.push("taskkill"); exit(); } },
      delay: () => new Promise(() => {}),
    });
    if (mode === "browser-error") await assert.rejects(stop(), { code: "BROWSER_FAILED" }); else await stop();
    assert.deepEqual(calls, [...(!["no-page", "exited", "browser-error"].includes(mode) ? ["quit"] : []), "browser",
      ...(["quit-no-exit", "no-page", "browser-error"].includes(mode) ? ["taskkill"] : [])]);
    assert.equal(app.listenerCount("exit"), 0);
    const completed = [...calls];
    await stop();
    assert.deepEqual(calls, completed);
  }
});

test("repeated Windows cleanup preserves the first stop snapshot and primary failure", async () => {
  const app = childProcess(), report = { errorCode: "CURSOR_APP_ADD_TIMEOUT" };
  const snapshots = [{ taskkillExitCode: 128, childExitCode: null }, { taskkillExitCode: 1, childExitCode: 0 }];
  let stops = 0;
  const stop = nativeFunction("stopApp", { app, report, macos: undefined, page: undefined, env: {},
    browser: { async close() {} }, bounded: (promise) => promise,
    windows: { async stopWindowsApp() { throw Object.assign(new Error("STOP_FAILED"), { code: "STOP_FAILED", windowsAppStop: snapshots[stops++] }); } },
  });
  await assert.rejects(stop(), { code: "STOP_FAILED" });
  await assert.rejects(stop(), { code: "STOP_FAILED" });
  assert.equal(report.windowsAppStop, snapshots[0]);
  assert.equal(report.errorCode, "CURSOR_APP_ADD_TIMEOUT");
  app.emit("close", 0);
});

test("Linux cleanup audits owned marker and package paths without claiming unrelated processes", async () => {
  const marker = "/owned/workspace/cancelled-marker";
  for (const [argv, includeBackend, expected] of [
    [["node", "-e", "script", marker], true, true], [["sh", "-c", `node '${marker}'`], true, true],
    [["/owned/app/cursor"], false, true], [["node", "/owned/package/backend.mjs"], true, true],
    [["node", "/owned/package/backend.mjs"], false, false], [["node", "/owned/state-other/tool"], true, false],
  ]) {
    const audit = nativeFunction("ownedProcessesRemain", { process: { pid: 1 }, macos: undefined, windows: undefined,
      appPath: "/owned/app/cursor", packageRoot: "/owned/package", env: { MEMORAX_CODE_HOME: "/owned/state" }, interruption: { marker },
      readdir: async () => ["1", "2", "self"], readFile: async () => argv.join("\0") });
    assert.equal(await audit({ includeBackend }), expected);
  }
});

test("failure capture retains the first rejected Shell rather than a retry", () => {
  const capture = source.match(/  const shellResult = collectCursorAppShellDiagnostics\([^\n]+\);\n  if \(shellResult\) report\.shellResult = shellResult;/)?.[0];
  const toolCallId = "11111111-1111-4111-8111-111111111111";
  const first = { error: "CURSOR_APP_EXEC_REJECTED", execRejection: { kind: "shell", toolCallId, rejectionKind: 2, exitCode: 127 },
    shellApproval: { toolCallId, clicked: true } };
  const report = {};
  runInNewContext(capture, { report, agent: { firstShellFailure: first, runs: [{ error: "retry" }] }, collectCursorAppShellDiagnostics });
  assert.deepEqual(report.shellResult, { rejectionKind: 2, approvalClicked: true, exitCode: 127 });
});

test("preflight rejects unsupported runtimes, Linux root and unowned Windows runners", () => {
  const body = source.split("\ntry {\n")[1]?.split("  // macOS Unix sockets")[0];
  for (const [platform, node, uid, code] of [["win32", "24.0.0"], ["linux", "24.0.0", 1000],
    ["linux", "24.0.0", 0, "CURSOR_APP_ISOLATION"], ["win32", "22.12.0", undefined, "CURSOR_APP_ARGUMENTS"]]) {
    const preflight = runInNewContext(`(() => {${body}})`, { check, expectedNodeMajor: node.split(".")[0],
      process: { platform, versions: { node }, argv: Array(8), getuid() { assert.notEqual(platform, "win32"); return uid; } } });
    if (code) assert.throws(preflight, { code }); else preflight();
  }
  const guard = source.split('  } else if (process.platform === "win32") {\n')[1]?.split("    windows = await import(")[0];
  for (const actions of ["true", undefined]) {
    const run = runInNewContext(`(() => {${guard}})`, { check,
      process: { env: { GITHUB_ACTIONS: actions, RUNNER_OS: "Windows" }, arch: "x64" } });
    if (actions) run(); else assert.throws(run, { code: "CURSOR_APP_WINDOWS_RUNNER" });
  }
});
