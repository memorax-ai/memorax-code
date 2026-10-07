import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { posix, win32 } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { assertCursorRepoMemoryRejected, parseCursorRepoMemoryClaim,
  parseCursorRepoMemoryDelegation } from "./cursor-app-repo-memory-check.mjs";
import { collectCursorAppShellOutputDiagnostics, projectCursorAppShellDiagnostics } from "./cursor-app-diagnostics.mjs";

const source = await readFile(new URL("./cursor-app-native-check.mjs", import.meta.url), "utf8");
const start = source.indexOf("function repoMemoryTools(run, results) {"), end = source.indexOf("\nfunction assertRepoMemoryNativeContent()", start);
assert.ok(start >= 0 && end > start);
const body = source.slice(start, end);
const contentStart = end + 1, contentEnd = source.indexOf("\nasync function runRepoMemoryWorker()", contentStart);
assert.ok(contentEnd > contentStart);
const contentBody = source.slice(contentStart, contentEnd);
const approvalStart = source.indexOf("  const approved = new Set(), opened = new Set();", contentEnd);
const approvalEnd = source.indexOf("\n  const [parent, child] = agent.runs.slice(repoMemory.runIndex);", approvalStart);
assert.ok(approvalStart > contentEnd && approvalEnd > approvalStart);
const approvalBody = source.slice(approvalStart, approvalEnd);
const persistenceStart = source.indexOf("  await waitFor(async () => {", approvalEnd);
const persistenceEnd = source.indexOf('\n  }, "CURSOR_APP_REPO_MEMORY_PERSISTENCE");', persistenceStart);
assert.ok(persistenceStart > approvalEnd && persistenceEnd > persistenceStart);
const persistenceBody = source.slice(persistenceStart + "  await waitFor(".length, persistenceEnd + "\n  }".length);
const marker = "MemoraX Code missing Repo Memory build: launch this native background delegation once, then continue your task:";

function fixture(platform = "linux") {
  const paths = platform === "win32" ? win32 : posix, root = platform === "win32" ? "D:\\owned fixture" : "/owned fixture";
  const executable = paths.join(root, "node"), helper = paths.join(root, "generation/hooks/repo-memory-job.mjs");
  const stateHome = paths.join(root, "state"), workspace = paths.join(root, "repository");
  const sessionId = "10000000-0000-4000-8000-000000000001", childId = "20000000-0000-4000-8000-000000000002";
  const jobId = "20261007000000000-build-fixture-12345678", runId = "d".repeat(32);
  const ticket = "a".repeat(64), token = "b".repeat(64);
  const invocation = (command, capability) => ({ executable,
    args: [helper, command, "--repo", workspace, "--job", jobId, "--run", runId,
      command === "claim" ? "--ticket" : "--claim-token", capability,
      ...(command === "abort" ? ["--reason", "child_failed"] : [])], env: { MEMORAX_CODE_HOME: stateHome } });
  const delegation = { name: "memorax-repo-memory", background: true,
    referencePath: paths.join(root, "generation/skills/memorax-code/references/repo-build.md"),
    prompt: `The complete delegated native job.\n${JSON.stringify(invocation("claim", ticket))}\nKeep this final instruction.` };
  const definition = { path: paths.join(root, "home/.cursor/agents/memorax-repo-memory.md"), body: "Managed worker instructions." };
  const repoMemory = { sessionId }, repoMemoryFixture = { prompt: "Synthetic foreground prompt." }, commands = [], report = {};
  const run = runInNewContext(`(${body})`, {
    repoMemory, repoMemoryFixture, repoMemoryDefinition: definition, repoMemoryHelper: helper,
    workspace, env: { MEMORAX_CODE_HOME: stateHome }, process: { platform, execPath: executable },
    parseCursorRepoMemoryDelegation, parseCursorRepoMemoryClaim, assertCursorRepoMemoryRejected,
    report, collectCursorAppShellOutputDiagnostics, projectCursorAppShellDiagnostics,
    shellCommand(args, environment) { commands.push({ args: Array.from(args), env: { ...environment } }); return "encoded-fixture-command"; },
    check(value, code) { if (!value) throw Object.assign(new Error(code), { code }); },
  }, { timeout: 100 });
  const parent = { conversationId: sessionId, prompt: repoMemoryFixture.prompt, requestContextCloseCount: 1,
    customSubagents: [{ name: "memorax-repo-memory", model: "inherit", isBackground: true, prompt: definition.body,
      fullPath: definition.path }],
    requestContext: { hooksAdditionalContext: "Other installed session context." },
    userHookAdditionalContexts: [{ content: `${marker}\n${JSON.stringify(delegation)}` }] };
  const child = { conversationId: childId, parentConversationId: sessionId, subagentTypeName: "memorax-repo-memory",
    prompt: delegation.prompt, requestContextCloseCount: 1 };
  const summary = { ok: true, execution: "native-subagent", runner: "cursor", repo: workspace, mode: "build", jobId, runId,
    jobPath: paths.join(stateHome, "repo-memory-jobs", jobId, "job.json"), status: "claimed", snapshotHead: "c".repeat(40),
    expiresAt: "2026-10-07T06:00:01.000Z" };
  const claimResult = { kind: "shell", exitCode: 0, stdout: JSON.stringify({ ...summary, claimToken: token,
    instructions: `Direct reference.\n${JSON.stringify(invocation("finish", token))}\n${JSON.stringify(invocation("abort", token))}` }) };
  const finishResult = { kind: "shell", exitCode: 1, stdout: JSON.stringify({ ...summary, ok: false, status: "failed",
    failureReason: "artifact_validation_failed" }) };
  return { run, parent, child, commands, repoMemory, definition, delegation, claimResult, finishResult, workspace, invocation, ticket, token, report };
}

test("Repo Memory tools require native context, then parent Task and child claim/finish in order", () => {
  for (const platform of ["linux", "darwin", "win32"]) {
    const f = fixture(platform);
    assert.deepEqual({ ...f.run({ ...f.parent, requestContextCloseCount: 0 }, []) }, { kind: "requestContext" });
    assert.equal(f.repoMemory.request, undefined);
    const task = f.run(f.parent, []);
    assert.deepEqual({ ...task }, { kind: "task", subagentType: "memorax-repo-memory", prompt: f.delegation.prompt,
      description: "Validate the delegated Repo Memory job", model: "inherit", background: true });
    assert.equal(f.commands.length, 0, "The parent must delegate instead of claiming the job itself");
    assert.equal(f.run(f.parent, [{ kind: "task", isBackground: true, agentId: f.child.conversationId }]), undefined);
    assert.deepEqual({ ...f.run({ ...f.child, requestContextCloseCount: 0 }, []) }, { kind: "requestContext" });
    const claim = f.run(f.child, []);
    assert.equal(claim.kind, "shell");
    assert.equal(claim.expectedExitCode, undefined);
    assert.equal(claim.workingDirectory, f.workspace);
    assert.equal(claim.timeoutMs, 20000);
    assert.equal(claim.networkAccess, platform === "darwin" ? true : undefined);
    assert.deepEqual(f.commands[0], { args: [f.invocation("claim", f.ticket).executable, ...f.invocation("claim", f.ticket).args],
      env: f.invocation("claim", f.ticket).env });
    const finish = f.run(f.child, [f.claimResult]);
    assert.equal(finish.kind, "shell");
    assert.equal(finish.expectedExitCode, 1);
    assert.equal(finish.fullPermissions, platform === "darwin" ? true : undefined);
    assert.equal(finish.networkAccess, undefined);
    assert.deepEqual(f.commands[1], { args: [f.invocation("finish", f.token).executable, ...f.invocation("finish", f.token).args],
      env: f.invocation("finish", f.token).env });
    assert.equal(f.repoMemory.rejected, undefined);
    assert.equal(f.run(f.child, [f.claimResult, f.finishResult]), undefined);
    assert.equal(f.repoMemory.rejected, true);
    assert.equal(f.commands.length, 2);
  }
});

test("Repo Memory parent rejects missing or changed installed custom agent definitions and Task results", () => {
  for (const [mutate, suffix] of [
    [(run) => { run.customSubagents = []; }, "COUNT"], [(run) => { run.customSubagents.push(run.customSubagents[0]); }, "COUNT"],
    [(run) => { run.customSubagents[0].fullPath += "-foreign"; }, "PATH"], [(run) => { run.customSubagents[0].model = "unrequested-model"; }, "MODEL"],
    [(run) => { run.customSubagents[0].isBackground = false; }, "BACKGROUND"], [(run) => { run.customSubagents[0].prompt += " changed"; }, "PROMPT"],
  ]) {
    const f = fixture(); mutate(f.parent);
    assert.throws(() => f.run(f.parent, []), { code: `CURSOR_APP_REPO_MEMORY_DEFINITION_${suffix}` });
    assert.equal(f.commands.length, 0);
  }
  for (const results of [[{ kind: "shell", isBackground: true }], [{ kind: "task", isBackground: false }],
    [{ kind: "task", isBackground: true }, { kind: "task", isBackground: true }]]) {
    const f = fixture(); f.run(f.parent, []);
    assert.throws(() => f.run(f.parent, results), { code: "CURSOR_APP_REPO_MEMORY_TASK" });
  }
});

test("Repo Memory tools reject foreign parent, child and prompt identities before any Shell execution", () => {
  const f = fixture();
  assert.throws(() => f.run({ ...f.parent, prompt: "Other parent prompt" }, []), { code: "CURSOR_APP_REPO_MEMORY_PARENT" });
  f.run(f.parent, []);
  for (const changed of [{ parentConversationId: "foreign" }, { subagentTypeName: "generalPurpose" }, { prompt: "different delegation" }]) {
    assert.throws(() => f.run({ ...f.child, ...changed }, []), { code: "CURSOR_APP_REPO_MEMORY_CHILD" });
  }
  assert.equal(f.commands.length, 0);
  assert.equal(f.repoMemory.claimed, undefined);
});

test("Repo Memory expected finish rejection cannot turn claim errors or other tool failures into success", () => {
  for (const result of [{ kind: "read", exitCode: 0 }, { kind: "shell", exitCode: 1 }]) {
    const f = fixture(); f.run(f.parent, []);
    assert.throws(() => f.run(f.child, [result]), { code: "CURSOR_APP_REPO_MEMORY_CLAIM" });
    assert.equal(f.repoMemory.rejected, undefined);
  }
  for (const result of [{ kind: "read", exitCode: 1 }, { kind: "shell", exitCode: 0 }, { kind: "shell", exitCode: 2 }]) {
    const f = fixture(); f.run(f.parent, []);
    assert.throws(() => f.run(f.child, [f.claimResult, result]), { code: "CURSOR_APP_REPO_MEMORY_FINISH" });
    assert.equal(f.repoMemory.rejected, undefined);
  }
  const f = fixture(); f.run(f.parent, []);
  assert.throws(() => f.run(f.child, [{ ...f.claimResult, stdout: "private-invalid-result" }]), { code: "CURSOR_APP_REPO_MEMORY_CLAIM_INVALID" });
  assert.throws(() => f.run(f.child, [f.claimResult,
    { ...f.finishResult, stdout: f.finishResult.stdout.replace("artifact_validation_failed", "child_failed") }]),
  { code: "CURSOR_APP_REPO_MEMORY_FINISH_OUTCOME_MISMATCH" });
  assert.equal(f.repoMemory.rejected, undefined);
  assert.throws(() => f.run(f.child, [f.claimResult, f.finishResult, f.finishResult]), { code: "CURSOR_APP_REPO_MEMORY_FINISH" });
});

test("Repo Memory finish failures retain only existing sanitized Shell diagnostics", () => {
  const f = fixture("darwin"); f.run(f.parent, []);
  f.child.shellApproval = { clicked: true };
  assert.throws(() => f.run(f.child, [f.claimResult, { ...f.finishResult, stdout: "",
    stderr: `Error: EPERM: operation not permitted, unlink '/private/canary/${f.token}/.git/config'` }]),
  { code: "CURSOR_APP_REPO_MEMORY_FINISH_JSON_INVALID" });
  assert.equal(f.report.shellResult.exitCode, 1);
  assert.equal(f.report.shellResult.approvalClicked, true);
  assert.equal(f.report.shellResult.output.stdoutStatus, "absent");
  assert.equal(f.report.shellResult.output.markers.permissionDenied, true);
  assert.equal(JSON.stringify(f.report).includes(f.token), false);
  assert.equal(JSON.stringify(f.report).includes("private/canary"), false);
  assert.equal(f.repoMemory.rejected, undefined);
});

function nativeContentFixture({ generationId = "parent-generation", failureCode } = {}) {
  const parent = { conversationId: "parent-session", requestId: "parent-generation",
    conversationStateBytes: Buffer.from("parent-state"), kvWrites: [{ bytes: Buffer.from("parent-blob") }] };
  const child = { conversationId: "child-session", taskToolCallId: "parent-task" };
  const notification = { conversationId: parent.conversationId, requestId: "notification-generation", completed: true,
    inputConversationStateBytes: Buffer.from("notification-state"),
    notifications: [{ subagentId: child.conversationId, toolCallId: child.taskToolCallId }] };
  const agent = { runs: [{ conversationId: "earlier-session" }, parent, child], notifications: [] };
  const subagentCalls = [], contentCalls = [], evidence = { composerMatched: true, stateMatched: true, blobCount: 3 };
  const run = runInNewContext(`(${contentBody})`, {
    agent, repoMemory: { runIndex: 1 }, env: { MEMORAX_CODE_CURSOR_DATABASE_PATH: "/owned/state.vscdb" },
    assertCursorAppNativeSubagent(options) { subagentCalls.push(options); },
    assertCursorAppNativeContent(options) {
      contentCalls.push(options);
      const code = failureCode ?? (options.generationId === generationId ? undefined : "CURSOR_APP_DATABASE_GENERATION_MISMATCH");
      if (code) throw Object.assign(new Error(code), { code });
      return evidence;
    },
    check(value, code) { if (!value) throw Object.assign(new Error(code), { code }); },
  }, { timeout: 100 });
  return { run, agent, parent, child, notification, subagentCalls, contentCalls, evidence };
}

test("Repo Memory native content waits for the background notification before cleanup", () => {
  const f = nativeContentFixture();
  assert.throws(() => f.run(), { code: "CURSOR_APP_REPO_MEMORY_NOTIFICATION" });
  assert.equal(f.contentCalls.length, 0);
  f.agent.notifications.push(f.notification);
  assert.equal(f.run(), f.evidence);
  assert.deepEqual({ ...f.subagentCalls[0] }, { databasePath: "/owned/state.vscdb",
    parentSessionId: f.parent.conversationId, childSessionId: f.child.conversationId });
  assert.deepEqual({ ...f.contentCalls[0] }, { databasePath: "/owned/state.vscdb", sessionId: f.parent.conversationId,
    generationId: f.parent.requestId, conversationStateBytes: f.parent.conversationStateBytes, kvWrites: f.parent.kvWrites });
  assert.equal(f.contentCalls[0].conversationStateBytes, f.parent.conversationStateBytes);
  assert.equal(f.contentCalls[0].kvWrites, f.parent.kvWrites);
});

test("Repo Memory background notification does not replace the parent's persisted checkpoint", () => {
  const f = nativeContentFixture();
  f.agent.notifications.push(f.notification);
  assert.equal(f.run(), f.evidence);
  assert.equal(f.contentCalls[0].sessionId, f.parent.conversationId);
  assert.equal(f.contentCalls[0].generationId, f.parent.requestId);
  assert.equal(f.contentCalls[0].conversationStateBytes, f.parent.conversationStateBytes);
  assert.equal(f.contentCalls[0].kvWrites, f.parent.kvWrites);
  f.agent.notifications.push({ ...f.notification });
  assert.throws(() => f.run(), { code: "CURSOR_APP_REPO_MEMORY_NOTIFICATION" });
  assert.equal(f.contentCalls.length, 1, "A later duplicate must be rechecked before reading native content");
});

test("Repo Memory accepts only the parent or its verified notification generation with the same checkpoint", () => {
  for (const generationId of ["parent-generation", "notification-generation", "foreign-generation"]) {
    const f = nativeContentFixture({ generationId });
    f.agent.notifications.push(f.notification);
    if (generationId === "foreign-generation") assert.throws(() => f.run(), { code: "CURSOR_APP_DATABASE_GENERATION_MISMATCH" });
    else assert.equal(f.run(), f.evidence);
    assert.equal(f.contentCalls.length, generationId === "parent-generation" ? 1 : 2);
    for (const call of f.contentCalls) {
      assert.equal(call.conversationStateBytes, f.parent.conversationStateBytes);
      assert.equal(call.kvWrites, f.parent.kvWrites);
    }
  }
  for (const failureCode of ["CURSOR_APP_DATABASE_STATE_MISMATCH", "CURSOR_APP_DATABASE_BLOB_MISMATCH"]) {
    const f = nativeContentFixture({ failureCode }); f.agent.notifications.push(f.notification);
    assert.throws(() => f.run(), { code: failureCode });
    assert.equal(f.contentCalls.length, 1);
  }
});

test("Repo Memory native content rejects foreign, incomplete, failed and ambiguous notifications", () => {
  for (const change of [
    (notification) => { notification.notifications[0].subagentId = "foreign-child"; },
    (notification) => { notification.notifications[0].toolCallId = "foreign-task"; },
    (notification) => { notification.completed = false; },
    (notification) => { delete notification.completed; },
    (notification) => { notification.error = "CURSOR_AGENT_NOTIFICATION_FAILED"; },
    (notification) => { notification.notifications = []; },
    (notification) => { notification.notifications.push({ ...notification.notifications[0] }); },
  ]) {
    const f = nativeContentFixture();
    change(f.notification); f.agent.notifications.push(f.notification);
    assert.throws(() => f.run(), { code: "CURSOR_APP_REPO_MEMORY_NOTIFICATION" });
    assert.equal(f.contentCalls.length, 0);
  }
});

async function approvalFixture({ composerCount = 1, buttonCount = 1, visible = true, parentId = "parent-session", poll } = {}) {
  const child = { conversationId: "child-session", parentConversationId: parentId,
    pendingTool: { kind: "shell", toolCallId: "claim-tool" } };
  const opened = [], clicked = [], selectors = [], state = { composerCount, buttonCount, visible };
  const button = { count: async () => state.buttonCount, isVisible: async () => state.visible,
    async click(options) { clicked.push({ toolCallId: child.pendingTool.toolCallId, ...options }); } };
  const composer = { count: async () => state.composerCount,
    locator(selector) {
      assert.equal(selector, `[data-tool-call-id="${child.pendingTool.toolCallId}"]:visible`);
      return { getByRole(role, options) {
        assert.equal(role, "button"); assert.deepEqual({ ...options }, { name: "Run", exact: true }); return button;
      } };
    } };
  const run = runInNewContext(`(async () => {${approvalBody}})`, {
    agent: { errors: [], runs: [{ conversationId: "parent-session" }, child] }, sessionId: "parent-session", repoMemory: { runIndex: 0 },
    page: { locator(selector) {
      assert.equal(selector, '[data-composer-id="child-session"][data-composer-location="editor"][data-composer-status]:visible');
      selectors.push(selector); return composer;
    }, async evaluate(callback, id) {
      return runInNewContext(`(${callback.toString()})(id)`, { id, window: { driver: {
        executeCommand(command, session, options) { opened.push({ command, session, ...options }); },
      } } }, { timeout: 100 });
    } },
    async waitFor(callback, code, timeout) {
      assert.equal(code, "CURSOR_APP_REPO_MEMORY_TIMEOUT"); assert.equal(timeout, 90000);
      if (poll) await poll(callback, { state, child, opened, clicked });
      else { await callback(); await callback(); }
    },
    check(value, code) { if (!value) throw Object.assign(new Error(code), { code }); },
  }, { timeout: 100 });
  await run();
  return { child, opened, clicked, selectors };
}

test("Repo Memory approval targets the unique child editor and exact tool once, without a first-match fallback", async () => {
  const f = await approvalFixture();
  assert.equal(f.selectors.length, 1);
  assert.deepEqual(f.clicked, [{ toolCallId: "claim-tool", timeout: 2000 }]);
  assert.deepEqual({ ...f.child.shellApproval }, { toolCallId: "claim-tool", clicked: true });
  assert.deepEqual(f.opened, []);
  const hidden = await approvalFixture({ visible: false });
  assert.deepEqual(hidden.clicked, []); assert.equal(hidden.child.shellApproval, undefined);
  for (const options of [{ composerCount: 2 }, { buttonCount: 2 }]) {
    await assert.rejects(approvalFixture(options), { code: "CURSOR_APP_REPO_MEMORY_APPROVAL" });
  }
  await assert.rejects(approvalFixture({ parentId: "foreign-parent" }), { code: "CURSOR_APP_REPO_MEMORY_CHILD" });
});

test("Repo Memory opens the missing native child in a new tab once, then tracks each approved tool", async () => {
  const f = await approvalFixture({ composerCount: 0, async poll(callback, { state, child, opened, clicked }) {
    await callback(); await callback();
    assert.deepEqual(opened, [{ command: "composer.openComposer", session: child.conversationId, openInNewTab: true }]);
    assert.deepEqual(clicked, []); assert.equal(child.shellApproval, undefined);
    state.composerCount = 1;
    await callback(); await callback();
    child.pendingTool = { kind: "shell", toolCallId: "finish-tool" };
    await callback(); await callback();
  } });
  assert.deepEqual(f.clicked, [{ toolCallId: "claim-tool", timeout: 2000 }, { toolCallId: "finish-tool", timeout: 2000 }]);
  assert.deepEqual({ ...f.child.shellApproval }, { toolCallId: "finish-tool", clicked: true });
});

function persistenceFixture() {
  const f = nativeContentFixture(), report = {}, repoMemory = {}, events = [];
  f.agent.errors = [];
  f.agent.notifications.push(f.notification);
  const ui = { parent: { count: 1, status: "completed" }, child: { count: 1, status: "completed" } };
  const poll = runInNewContext(`(${persistenceBody})`, {
    agent: f.agent, parent: f.parent, child: f.child, repoMemory, report,
    assertRepoMemoryNativeContent() { events.push("snapshot"); return f.run(); },
    page: { locator(selector) {
      const role = selector === '[data-composer-id="parent-session"][data-composer-status]:visible' ? "parent" : "child";
      if (role === "child") assert.equal(selector,
        '[data-composer-id="child-session"][data-composer-status][data-composer-location="editor"]:visible');
      events.push(role);
      return { count: async () => ui[role].count, async getAttribute(name) {
        assert.equal(name, "data-composer-status"); return ui[role].status;
      } };
    } },
    safeCode: (error) => error.code,
    check(value, code) { if (!value) throw Object.assign(new Error(code), { code }); },
  }, { timeout: 100 });
  return { ...f, poll, ui, report, repoMemory, events };
}

test("Repo Memory persistence requires the strict native snapshot and unique completed parent and child editors", async () => {
  const f = persistenceFixture();
  assert.equal(await f.poll(), true);
  assert.deepEqual(f.events, ["snapshot", "parent", "child"]);
  assert.equal(f.repoMemory.content, f.evidence);
  assert.equal(f.report.nativeContentError, undefined);
  for (const role of ["parent", "child"]) for (const change of [
    { count: 0 }, { count: 2 }, { status: "generating" }, { status: "cancelled" }, { status: null },
  ]) {
    const pending = persistenceFixture(); Object.assign(pending.ui[role], change);
    assert.equal(await pending.poll(), false);
  }
});

test("Repo Memory persistence waits on missing or invalid native notifications before examining UI status", async () => {
  for (const change of [(f) => { f.agent.notifications = []; },
    (f) => { f.notification.notifications[0].subagentId = "foreign-child"; }]) {
    const f = persistenceFixture(); change(f);
    assert.equal(await f.poll(), false);
    assert.deepEqual(f.events, ["snapshot"]);
    assert.equal(f.report.nativeContentError, "CURSOR_APP_REPO_MEMORY_NOTIFICATION");
  }
});

test("Repo Memory persistence propagates agent errors instead of retrying them as a pending snapshot", async () => {
  const f = persistenceFixture();
  f.agent.errors.push("CURSOR_AGENT_EXEC_DUPLICATE");
  await assert.rejects(f.poll(), { code: "CURSOR_AGENT_EXEC_DUPLICATE" });
  assert.deepEqual(f.events, []);
  assert.equal(f.repoMemory.content, undefined);
  assert.equal(f.report.nativeContentError, undefined);
});
