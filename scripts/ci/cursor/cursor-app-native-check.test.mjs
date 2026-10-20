import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { basename, dirname, join, win32 } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { collectCursorAppBackendDiagnostics, collectCursorAppShellDiagnostics, collectCursorAppStopDiagnostics, collectCursorAppSubmissionDiagnostics } from "./cursor-app-diagnostics.mjs";
import { projectCursorAppHookTiming } from "./cursor-app-hook-diagnostics.mjs";
import { collectCursorAppSkillHookContext } from "./cursor-app-hook-context.mjs";

const source = (await readFile(new URL("./cursor-app-native-check.mjs", import.meta.url), "utf8")).replaceAll("\r\n", "\n");
const privateCanary = "private-content-path-token-canary";
function check(value, code) { if (!value) throw Object.assign(new Error(code), { code }); }
function nativeFunction(name, context = {}) {
  const definition = source.match(new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?(?=\\n(?:async )?function )`))?.[0];
  assert.ok(definition, name);
  return runInNewContext(`(${definition})`, { check, Buffer, basename, dirname, join, once, collectCursorAppSkillHookContext, projectCursorAppHookTiming, collectCursorAppSubmissionDiagnostics,
    process: { platform: "darwin" }, appLaunch: 0, readyHookSessions: new Map(),
    beginHookTiming() {}, markHookSubmit() {}, async observeHookTiming() {}, finishHookTiming() {}, async waitForHookReady() {}, async recordSubmissionFailure() {}, ...context }, { timeout: 100 });
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
  const selector = "  const run = repoMemory?.failedRun ?? agent?.runs.at(-1);";
  const body = selector + source.split(selector)[1]?.split("\n}\nfinally {")[0];
  assert.ok(body);
  const run = { conversationId: "11111111-1111-1111-1111-111111111111", requestId: "22222222-2222-2222-2222-222222222222" };
  const identity = { sessionId: run.conversationId, turnId: run.requestId };
  for (const failed of [false, true]) for (const saved of [false, true]) for (const firstFailure of [false, true]) {
    const snapshot = saved ? collectCursorAppSkillHookContext({ run: { ...run,
      inputRequestContext: { hooksAdditionalContext: privateCanary } } }) : undefined;
    const report = { errorCode: "CURSOR_APP_ADD_TIMEOUT", ...(snapshot ? { skillHookContext: snapshot } : {}) };
    await runInNewContext(`(async () => {${body}})()`, { run, report,
      agent: { runs: firstFailure ? [run, { conversationId: privateCanary, requestId: privateCanary }] : [run] },
      repoMemory: firstFailure ? { failedRun: run } : undefined, collectCursorAppSkillHookContext,
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
    assert.equal(report.skillHookContext.matched, false);
    if (saved) assert.equal(report.skillHookContext, snapshot);
    else assert.deepEqual(report.skillHookContext, collectCursorAppSkillHookContext({ run, runs: [run] }));
    assert.equal(JSON.stringify(report).includes(privateCanary), false);
  }
});

test("App launch preserves the sandbox and isolated arguments with a longer Windows driver deadline", async () => {
  for (const platform of ["linux", "darwin", "win32"]) {
    const child = childProcess(), waits = [], argumentsSeen = [], readiness = [];
    const readyHookSessions = new Map([["old-session", 12]]);
    const page = { url: () => "file:///workbench.html", evaluate: async () => true, setDefaultTimeout() {} };
    const start = nativeFunction("startApp", {
      process: { platform }, readyHookSessions,
      async waitForHookReady(phase) { readiness.push(phase); },
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
    assert.deepEqual(readiness, ["config"]);
    assert.equal(readyHookSessions.size, platform === "win32" ? 1 : 0);
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

test("same-session recovery uses the primary input beside the cancelled turn editor and keeps native identity checks", async () => {
  for (const mode of ["recovered", "cancelled-history", "reused-id", "primary-missing", "primary-ambiguous"]) {
    const prior = { conversationId: "session", requestId: "old", userMessageId: "old", cancelled: true,
      completed: false, kvWrites: [], turnBlobId: Buffer.alloc(32) };
    const run = { conversationId: "session", prompt: "recovery", completed: true, userMessageId: "new",
      requestId: mode === "reused-id" ? "old" : "new", turnRefs: mode === "cancelled-history" ? [prior.turnBlobId] : [],
      kvReadCount: 0, kvReadResultCount: 0, kvWriteCount: 3, kvAckCount: 3,
      requestContextRequestCount: 1, requestContextResultCount: 1, requestContextCloseCount: 1 };
    const inline = { className: "ui-prompt-input-editor__input", value: "cancelled prompt" };
    const primary = { className: "aislash-editor-input", value: "" };
    const editors = [inline, ...(mode === "primary-missing" ? [] : [primary]),
      ...(mode === "primary-ambiguous" ? [{ ...primary }] : [])];
    const agent = { runs: [prior], errors: [] }, report = {}, submitted = [];
    const composer = { locator(selector) {
      assert.ok(selector.endsWith('[contenteditable="true"][role="textbox"]:visible'));
      const className = selector.match(/^\.([a-z_-]+)/)?.[1];
      const matches = editors.filter(editor => !className || editor.className === className);
      return { async fill(value) { check(matches.length === 1, "INPUT_LOCATOR_AMBIGUOUS"); matches[0].value = value; },
        async press(key) {
          check(matches.length === 1, "INPUT_LOCATOR_AMBIGUOUS");
          check(matches[0] === primary, "EDITED_TURN_SUBMITTED");
          assert.equal(key, "Enter"); assert.equal(primary.value, run.prompt);
          submitted.push({ sessionId: prior.conversationId, requestId: run.requestId }); agent.runs.push(run);
        } };
    } };
    const runTurn = nativeFunction("runTurn", { agent, report, turns: [], workspace: "/owned/workspace",
      page: { locator(selector) { assert.equal(selector, '[data-composer-id="session"][data-composer-status]:visible'); return composer; } },
      submitPrompt: nativeFunction("submitPrompt"),
      async waitFor(predicate) { check(report.stage !== "native-persistence", "VERIFIED"); assert.equal(await predicate(), true); },
    });
    const inputRejected = mode.startsWith("primary-");
    await assert.rejects(runTurn("session", { prompt: "recovery" }), { code: inputRejected ? "INPUT_LOCATOR_AMBIGUOUS"
      : mode === "recovered" ? "VERIFIED" : mode === "reused-id" ? "CURSOR_APP_REUSED_TURN_IDENTITY" : "CURSOR_APP_HISTORY_MISMATCH" });
    assert.equal(inline.value, "cancelled prompt");
    assert.equal(prior.requestId, "old");
    assert.deepEqual(submitted, inputRejected ? [] : [{ sessionId: "session", requestId: run.requestId }]);
    assert.equal(agent.runs[0], prior);
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

test("Skill Hook assertion consumes initial, dynamic and completed Exec contexts with exact session binding", () => {
  const sessionId = "11111111-1111-4111-8111-111111111111", other = "22222222-2222-4222-8222-222222222222";
  for (const location of ["initial", "dynamic", "exec"]) for (const current of [true, false]) {
    const content = "MEMORAX_CODE_MEMORY_CLI_TRACE_CLIENT=cursor and MEMORAX_CODE_MEMORY_CLI_TRACE_SESSION_ID=" + (current ? sessionId : other);
    const run = { conversationId: sessionId, prompt: "/memorax-code prompt", requestContextCloseCount: 1, turnRefs: [],
      requestContext: { hooksAdditionalContext: "" },
      selectedCursorRules: [{ fullPath: "/owned/skill/SKILL.md", content: "# Skill\n", manuallyAttached: true }] };
    if (location === "initial") run.inputRequestContext = { hooksAdditionalContext: content };
    if (location === "dynamic") run.requestContextParts = { dynamicContext: { hooksAdditionalContext: content } };
    if (location === "exec") run.execHookAdditionalContexts = [{ hookEventName: "sessionStart", content }];
    const tools = nativeFunction("toolSteps", { process: { platform: "linux" }, skillRoot: "/owned/skill", skillText: "# Skill\n",
      interruption: undefined, report: {}, agent: { runs: [run] }, turns: [{ sessionId, prompt: run.prompt, operation: "search" }] });
    if (current) assert.equal(tools(run, []).path, "/owned/skill/SKILL.md");
    else assert.throws(() => tools(run, []), { code: "CURSOR_APP_SKILL_HOOK_CONTEXT" });
  }
});

test("Skill Hook failure preserves the first context snapshot across transport retries", () => {
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const first = { conversationId: sessionId, prompt: "/memorax-code prompt", requestContextCloseCount: 1, turnRefs: [],
    inputRequestContext: { hooksAdditionalContext: privateCanary } };
  const retry = { ...first, inputRequestContext: undefined, requestContext: { hooksAdditionalContext: "different context" } };
  const agent = { runs: [first] }, report = {};
  const tools = nativeFunction("toolSteps", { process: { platform: "linux" }, skillRoot: "/owned/skill", skillText: "# Skill\n",
    interruption: undefined, agent, report, turns: [{ sessionId, prompt: first.prompt, operation: "search" }] });
  assert.throws(() => tools(first, []), { code: "CURSOR_APP_SKILL_HOOK_CONTEXT" });
  const snapshot = report.skillHookContext;
  assert.equal(snapshot.current.initial.present, true);
  assert.equal(snapshot.current.fresh.present, false);
  agent.runs.push(retry);
  assert.throws(() => tools(retry, []), { code: "CURSOR_APP_SKILL_HOOK_CONTEXT" });
  assert.equal(report.skillHookContext, snapshot);
  assert.notDeepEqual(snapshot, collectCursorAppSkillHookContext({ run: retry, runs: agent.runs }));
  const marker = "MEMORAX_CODE_MEMORY_CLI_TRACE_CLIENT=cursor and MEMORAX_CODE_MEMORY_CLI_TRACE_SESSION_ID=" + sessionId;
  retry.execHookAdditionalContexts = [{ hookEventName: "sessionStart", content: marker }];
  retry.selectedCursorRules = [{ fullPath: "/owned/skill/SKILL.md", content: "# Skill\n", manuallyAttached: true }];
  assert.equal(tools(retry, []).path, "/owned/skill/SKILL.md");
  first.inputRequestContext.hooksAdditionalContext = marker;
  assert.equal(collectCursorAppSkillHookContext({ run: first, runs: agent.runs }).matched, true);
  assert.equal(report.skillHookContext, snapshot);
  assert.equal(snapshot.matched, false);
  assert.equal(JSON.stringify(snapshot).includes(privateCanary), false);
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

test("Linux and macOS readiness use bounded independent gates and preserve failure before submission", async () => {
  for (const platform of ["linux", "darwin"]) for (const phase of ["config", "session"]) for (const ready of [false, true]) {
    const calls = [], report = {};
    const gate = nativeFunction("waitForHookReady", { process: { platform }, report,
      beginHookTiming(value, id) { calls.push([value, id]); },
      async observeHookTiming() { return { requiredUserHooksLoaded: ready, sessionStartReady: phase === "session" && ready }; },
      async waitFor(predicate, code) { calls.push(code); check(await predicate(), code); },
      finishHookTiming() { calls.push("snapshot"); },
    });
    if (ready) await gate(phase, "session");
    else await assert.rejects(gate(phase, "session"), { code: phase === "config"
      ? "CURSOR_APP_HOOK_CONFIG_READY_TIMEOUT" : "CURSOR_APP_SESSION_START_READY_TIMEOUT" });
    assert.equal(report.stage, phase === "config" ? "hook-config-ready" : "hook-session-ready");
    assert.equal(calls.at(-1), "snapshot");
    assert.deepEqual(calls[0], [phase, "session"]);
  }
  for (const platform of ["win32"]) {
    await nativeFunction("waitForHookReady", { process: { platform }, beginHookTiming() { assert.fail("unsupported readiness gate"); } })("config");
  }
});

test("new sessions wait for their Hook but resumed sessions do not require a new sessionStart", async () => {
  for (const resumed of [false, true]) {
    const calls = [], selected = "11111111-1111-4111-8111-111111111111";
    const open = nativeFunction("openSession", { report: {}, turns: [], agent: { runs: [] }, bounded: (promise) => promise,
      page: { async evaluate(callback, id) { return id ? undefined : { composerId: selected }; },
        locator: () => ({ count: async () => 1 }) },
      async waitFor(predicate) { assert.equal(await predicate(), true); },
      async waitForHookReady(phase, id) { calls.push([phase, id]); },
    });
    assert.equal(await open(resumed ? selected : undefined), selected);
    assert.deepEqual(calls, resumed ? [] : [["session", selected]]);
  }
});

test("Hook timing binds observations to the first native attempt and snapshots contain no identity or path", async () => {
  const sessionId = "11111111-1111-4111-8111-111111111111", turnId = "22222222-2222-4222-8222-222222222222";
  const current = { phase: "turn", appLaunch: 1, sessionId, runIndex: 0, observedMs: { submit: 10 } };
  const first = { conversationId: sessionId, requestId: turnId }, retry = { conversationId: sessionId, requestId: "33333333-3333-4333-8333-333333333333" };
  const seen = [], readyHookSessions = new Map();
  const observe = nativeFunction("observeHookTiming", { activeHookTiming: current, appStartedAt: 1000,
    Date: { now: () => 1020 }, userData: "/owned/app-data", env: { MEMORAX_CODE_HOME: "/owned/state" },
    agent: { runs: [first, retry] }, readyHookSessions,
    async collectCursorAppHookTiming(input) {
      seen.push(input.turnId);
      return projectCursorAppHookTiming({ readStatus: "present", currentLogFiles: 1, requiredUserHooksLoaded: true, sessionStartReady: true });
    },
    async collectCursorAppDiagnostics(input) { assert.equal(input.turnId, turnId); return { trace: { readStatus: "present", turnStartCount: 1 } }; },
  });
  const timing = await observe();
  assert.deepEqual(seen, [turnId]);
  assert.deepEqual(timing.observedMs, { sessionStartReady: 20, submit: 10, modelRequest: 20, turnStart: 20 });
  assert.equal(timing.runIndex, 0);
  const report = {};
  const finish = nativeFunction("finishHookTiming", { activeHookTiming: current, report });
  finish(); finish();
  current.observedMs.submit = 999;
  assert.equal(report.hookTimings.length, 1);
  assert.equal(report.hookTimings[0].observedMs.submit, 10);
  for (const value of [sessionId, turnId, "/owned"]) assert.equal(JSON.stringify(report).includes(value), false);
});

test("submission observation happens immediately before Enter and does not replay input", async () => {
  const calls = [];
  const submit = nativeFunction("submitPrompt", { markHookSubmit() { calls.push("mark"); },
    page: {}, bounded: (promise) => promise });
  await submit({ async fill() { calls.push("fill"); }, async press(key) { calls.push(key); } }, { prompt: "synthetic" });
  assert.deepEqual(calls, ["fill", "mark", "Enter"]);
});

test("Windows process audit records each bounded result and cleanup cannot replace the earlier failure", async () => {
  const report = { stage: "workspace-switch", errorCode: "PRIMARY_FAILURE" }, calls = [];
  const first = { attempts: 2, timeoutCount: 2, finalStatus: "timeout" };
  const next = { attempts: 1, timeoutCount: 0, finalStatus: "clear" };
  const audit = nativeFunction("assertProcessesStopped", { report, process: { pid: 9 }, appPath: "/owned/app", packageRoot: "/owned/package",
    env: { MEMORAX_CODE_HOME: "/owned/state" }, interruption: undefined,
    windows: { projectWindowsProcessAuditDiagnostics: value => ({ ...value }),
      async waitForWindowsProcessesExit(options) {
        calls.push(options);
        if (calls.length === 1) throw Object.assign(new Error("QUERY_TIMEOUT"), { code: "QUERY_TIMEOUT", windowsProcessAudit: first });
        return next;
      } },
    ownedProcessesRemain() { assert.fail("must not nest the old Windows retry loop"); },
  });
  await assert.rejects(audit({ includeBackend: false }), { code: "QUERY_TIMEOUT" });
  await audit({ stage: "cleanup" });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].includeBackend, false);
  assert.equal(calls[1].includeBackend, true);
  assert.equal(report.windowsProcessAudits.length, 2);
  assert.equal(report.windowsProcessAudits[0].stage, "workspace-switch");
  assert.equal(report.windowsProcessAudits[0].finalStatus, "timeout");
  assert.equal(report.windowsProcessAudits[1].stage, "cleanup");
  assert.equal(report.errorCode, "PRIMARY_FAILURE");
});

test("Repo Memory timing observes the first submission before reporting its original failure", async () => {
  const body = source.split("async function runRepoMemoryWorker() {")[1]?.split("\ntry {")[0];
  assert.ok(body);
  const calls = [], agent = { runs: [], errors: [] }, report = { evidence: {} };
  const failure = "CURSOR_APP_REPO_MEMORY_DELEGATION_INVALID";
  const worker = runInNewContext("(async function () {" + body + ")", { check, basename, report, agent, turns: [], repoMemory: undefined,
    async stopApp() {}, async assertProcessesStopped() {}, async prepareRepoMemoryWorkspace() { return { repo: "/owned/repo" }; },
    async startApp() { calls.push("config-ready"); }, async openSession() { calls.push("session-ready"); return "parent-session"; },
    page: { locator(selector) {
      assert.equal(selector, '[data-composer-id="parent-session"][data-composer-status]:visible');
      return { locator(inputSelector) {
        assert.equal(inputSelector, '.aislash-editor-input[contenteditable="true"][role="textbox"]:visible');
        return {};
      } };
    } }, repoMemoryFixture: { prompt: "synthetic" },
    beginHookTiming(phase, sessionId, options) { calls.push([phase, sessionId, options.runIndex]); },
    async submitPrompt() { calls.push("submit"); agent.runs.push({ requestId: "first" }, { requestId: "retry" }); agent.errors.push(failure); },
    async observeHookTiming() { calls.push("observe"); },
    async waitFor(predicate) { await predicate(); },
  });
  await assert.rejects(worker(), { code: failure });
  assert.deepEqual(calls, ["config-ready", "session-ready", ["turn", "parent-session", 0], "submit", "observe"]);
});


test("submission failures retain the exact error and action phase without retrying or submitting later", async () => {
  for (const phase of ["fill", "type-skill", "select-skill", "verify-skill", "move-to-end", "insert-text", "enter"]) {
    const error = new Error(privateCanary), actions = [], records = [];
    const act = async (current) => { actions.push(current); if (current === phase) throw error; };
    const input = { fill: () => act("fill"), pressSequentially: () => act("type-skill"),
      press: key => act(key === "End" ? "move-to-end" : "enter"),
      locator: () => ({ count: async () => { await act("verify-skill"); return 1; } }) };
    const composer = {}, sessionId = privateCanary;
    const submit = nativeFunction("submitPrompt", {
      page: { locator: () => ({ locator: () => ({ filter: () => ({ count: async () => 1, click: () => act("select-skill") }) }) }),
        keyboard: { insertText: () => act("insert-text") } },
      async waitFor(predicate, code) { check(await predicate(), code); },
      async recordSubmissionFailure(value) { records.push(value); throw new Error("diagnostic read failed"); },
      markHookSubmit() { actions.push("mark"); },
    });
    await assert.rejects(submit(input, { operation: phase === "fill" ? undefined : "search", prompt: "/memorax-code synthetic" },
      { composer, sessionId }), failure => failure === error);
    assert.equal(records.length, 1);
    assert.equal(records[0].phase, phase);
    assert.equal(records[0].error, error);
    assert.equal(records[0].input, input);
    assert.equal(records[0].composer, composer);
    assert.equal(records[0].sessionId, sessionId);
    assert.equal(actions.at(-1), phase);
    assert.equal(actions.filter(action => action === phase).length, 1);
    assert.equal(actions.includes("mark"), phase === "enter");
  }
});

test("failed submission snapshots distinguish duplicate editors and never act on an ambiguous locator", async () => {
  for (const mode of ["unique", "duplicate", "absent", "not-editable", "different-session", "missing-session", "unknown-status"]) {
    const report = {}, calls = [], count = mode === "absent" ? 0 : mode === "duplicate" ? 2 : 1;
    const sessionId = privateCanary, error = Object.assign(new Error(privateCanary), { name: "TimeoutError" });
    const composer = { async count() { return mode === "absent" ? 0 : 1; },
      async getAttribute(name) { calls.push("status"); assert.equal(name, "data-composer-status"); return mode === "unknown-status" ? privateCanary : "cancelled"; },
      locator(selector) {
        assert.ok(['.aislash-editor-input[contenteditable="true"][role="textbox"]:visible',
          '.ui-prompt-input-editor__input[contenteditable="true"][role="textbox"]:visible'].includes(selector));
        calls.push(selector);
        return { count: async () => mode === "absent" ? 0 : selector.includes("aislash") || mode === "duplicate" ? 1 : 0 };
      } };
    const input = { async count() { return count; }, async isEditable() { calls.push("editable"); return mode !== "not-editable"; } };
    const capture = nativeFunction("recordSubmissionFailure", { report,
      async bounded(promise, code, timeout) { assert.equal(code, "CURSOR_APP_SUBMIT_DIAGNOSTICS_TIMEOUT"); assert.equal(timeout, 1000); return promise; },
      page: { async evaluate(fn, id) {
        const composerId = mode === "different-session" ? "different-synthetic-session" : mode === "missing-session" ? undefined : sessionId;
        const read = runInNewContext("(" + fn.toString() + ")", { window: { driver: { async executeCommand(command) {
          assert.equal(command, "workbench.action.devGetComposerDataForTesting");
          return { composerId, privateData: privateCanary };
        } } } });
        return read(id);
      } },
    });
    await capture({ composer, input, sessionId, phase: "fill", error });
    const value = report.nativeSubmit;
    assert.equal(value.readStatus, "present");
    assert.equal(value.failureKind, "timeout");
    assert.equal(value.inputCount, count);
    assert.equal(value.primaryInputCount, mode === "absent" ? 0 : 1);
    assert.equal(value.editingInputCount, mode === "duplicate" ? 1 : 0);
    assert.equal(value.editable, count === 1 ? mode !== "not-editable" : null);
    assert.equal(value.selectedSessionMatches, mode === "missing-session" ? null : mode !== "different-session");
    assert.equal(value.composerStatus, mode === "absent" ? "absent" : mode === "unknown-status" ? "other" : "cancelled");
    assert.equal(calls.includes("editable"), count === 1);
    assert.equal(calls.includes("status"), mode !== "absent");
    assert.equal(JSON.stringify(value).includes(privateCanary), false);
    await capture({ phase: "enter", error: new Error("later error") });
    assert.equal(report.nativeSubmit, value);
  }
});

test("unavailable submission diagnostics preserve the original phase and failure without inventing zero counts", async () => {
  for (const failure of ["read", "timeout"]) {
    const report = {}, error = new Error("strict mode violation " + privateCanary);
    const capture = nativeFunction("recordSubmissionFailure", { report,
      async bounded(promise) { await promise.catch(() => {}); throw new Error(privateCanary); },
      page: { evaluate: async () => true },
    });
    const composer = { count: async () => { if (failure === "read") throw new Error(privateCanary); return 1; },
      getAttribute: async () => "cancelled", locator: () => ({ count: async () => 1 }) };
    const input = { count: async () => 2 };
    await capture({ composer, input, sessionId: privateCanary, phase: "fill", error });
    assert.equal(report.nativeSubmit.readStatus, "unavailable");
    assert.equal(report.nativeSubmit.failureKind, "ambiguous");
    assert.equal(report.nativeSubmit.phase, "fill");
    for (const key of ["composerCount", "inputCount", "primaryInputCount", "editingInputCount", "editable", "selectedSessionMatches"]) {
      assert.equal(report.nativeSubmit[key], null);
    }
    assert.equal(JSON.stringify(report).includes(privateCanary), false);
  }
});


test("a hung diagnostic read cannot hold submission failure open beyond its own bounded budget", async () => {
  const report = {}, original = new Error("strict mode violation " + privateCanary);
  const bounded = nativeFunction("bounded", { setTimeout, clearTimeout });
  const capture = nativeFunction("recordSubmissionFailure", { report, bounded,
    page: { evaluate: async () => true } });
  const composer = { count: () => new Promise(() => {}), locator: () => ({ count: async () => 1 }) };
  const input = { count: async () => 2 };
  await capture({ composer, input, sessionId: privateCanary, phase: "fill", error: original });
  assert.equal(report.nativeSubmit.readStatus, "unavailable");
  assert.equal(report.nativeSubmit.phase, "fill");
  assert.equal(report.nativeSubmit.failureKind, "ambiguous");
  assert.equal(JSON.stringify(report).includes(privateCanary), false);
});


test("the pending-shell interruption fixture also submits only through its session's primary input", async () => {
  const actions = [], finished = new Error("submission observed"), sessionId = "interrupted-session";
  const input = { async fill(value) { actions.push(["fill", value]); }, async press(key) { actions.push(["press", key]); throw finished; } };
  const interrupt = nativeFunction("interruptPendingShell", { agent: { runs: [] }, report: {}, interruption: undefined,
    workspace: "/owned/workspace", interruptedFixture: { prompt: "synthetic interruption" }, async openSession() { return sessionId; },
    page: { locator(selector) {
      assert.equal(selector, '[data-composer-id="interrupted-session"][data-composer-status]:visible');
      return { locator(inputSelector) {
        assert.equal(inputSelector, '.aislash-editor-input[contenteditable="true"][role="textbox"]:visible');
        return input;
      } };
    } },
  });
  await assert.rejects(interrupt(), error => error === finished);
  assert.deepEqual(actions, [["fill", "synthetic interruption"], ["press", "Enter"]]);
});
