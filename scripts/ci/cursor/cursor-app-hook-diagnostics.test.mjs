import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { collectCursorAppHookDiagnostics, projectCursorAppHookDiagnostics, collectCursorAppHookTiming, projectCursorAppHookTiming } from "./cursor-app-hook-diagnostics.mjs";

const secret = "PRIVATE_PROMPT_PATH_EMAIL_TOKEN_CANARY";
const rule = "\u2550".repeat(87), command = `node /${secret}/runtime-hook.mjs --memorax-code-cursor-hook-v1`;
function execution(request, { output = { continue: true }, cmd = command, exit = 0, stderr = secret,
  step = request.hook_event_name, input = JSON.stringify(request, null, 2) } = {}) {
  return [rule, step, rule, `Command: ${cmd} (42ms) exit code: ${exit}`, "", "INPUT:",
    input, "", "OUTPUT:", output === null ? "(empty)" : JSON.stringify(output, null, 2),
    "", "STDERR:", stderr, rule, ""].join("\n");
}
async function fixture(t) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "cursor-hook-diagnostic-")));
  t.after(() => rm(home, { recursive: true, force: true }));
  const sessionId = randomUUID(), turnId = randomUUID();
  const log = join(home, "logs/20261009T120000/window1/output_20261009T120001/cursor.hooks.workspaceId-fixture.log");
  await mkdir(dirname(log), { recursive: true });
  const request = { hook_event_name: "beforeSubmitPrompt", conversation_id: sessionId, session_id: sessionId,
    generation_id: turnId, workspace_roots: [home], prompt: secret, user_email: secret };
  return { home, sessionId, turnId, log, request, collect: () => collectCursorAppHookDiagnostics({ home, sessionId, turnId }) };
}

test("native Hook blocks bind owned executions to exact session/turn and retain only fixed projections", async (t) => {
  const f = await fixture(t);
  const log = `[2026-10-09T12:00:00.000Z] Hook step requested: beforeSubmitPrompt\n`
    + execution(f.request)
    + execution({ ...f.request, generation_id: randomUUID() })
    + execution({ ...f.request, conversation_id: randomUUID() })
    + execution(f.request, { cmd: `node /${secret}/another-hook.mjs` })
    + execution({ ...f.request, hook_event_name: "stop", prompt: undefined }, { output: null });
  await writeFile(f.log, log.replaceAll("\n", "\r\n"));
  const result = await f.collect();
  assert.equal(result.readStatus, "present");
  assert.equal(result.filesRead, 1);
  assert.equal(result.unscopedRequests.beforeSubmitPrompt, 1);
  assert.equal(result.ownedExecutionBlocks.beforeSubmitPrompt, 3);
  assert.equal(result.ownedExecutionBlocks.stop, 1);
  assert.deepEqual(result.filteredExecutionBlocks.beforeSubmitPrompt, { parse: 0, event: 0, session: 1, generation: 1 });
  assert.deepEqual(result.executions.map(({ step, scope }) => ({ step, scope })),
    [{ step: "beforeSubmitPrompt", scope: "turn" }, { step: "stop", scope: "turn" }]);
  assert.deepEqual(result.executions[0], { step: "beforeSubmitPrompt", scope: "turn", generation: "matched",
    sessionAliasMatched: true, workspaceKind: "single", promptKind: "string", exitCode: 0, responseKind: "json",
    continue: "allow", additionalContextPresent: false, stderrPresent: true });
  assert.equal(result.executions[1].responseKind, "empty");
  assert.deepEqual(projectCursorAppHookDiagnostics(result), result);
  for (const privateValue of [secret, f.home, f.sessionId, f.turnId]) assert.ok(!JSON.stringify(result).includes(privateValue));
  assert.equal(await readFile(f.log, "utf8"), log.replaceAll("\n", "\r\n"));
});

test("missing native identities stay session-scoped; Windows commands and failed executions remain observable", async (t) => {
  const f = await fixture(t), windows = `powershell -EncodedCommand ${Buffer.from(command, "utf16le").toString("base64")}`;
  await writeFile(f.log, execution({ ...f.request, generation_id: undefined, session_id: "conflicting",
    workspace_roots: ["relative"], prompt: undefined }, { cmd: windows, output: null, exit: 1 })
    + execution({ ...f.request, hook_event_name: "sessionStart", generation_id: undefined, workspace_roots: [] },
      { output: { additional_context: secret } })
    + execution({ ...f.request, generation_id: "not-an-id" }, { output: 1, exit: "N/A" }));
  const { executions } = await f.collect();
  assert.deepEqual(executions.map((item) => [item.scope, item.generation, item.exitCode]),
    [["session", "absent", 1], ["session", "absent", 0], ["session", "invalid", null]]);
  assert.equal(executions[0].sessionAliasMatched, false);
  assert.equal(executions[0].workspaceKind, "invalid");
  assert.equal(executions[0].promptKind, "absent");
  assert.equal(executions[1].additionalContextPresent, true);
  assert.equal(executions[2].responseKind, "invalid");
});

test("unbound, malformed and partial log text never manufactures execution evidence", async (t) => {
  const f = await fixture(t);
  for (const text of [secret, execution(f.request).replace('"prompt":', '"broken"'),
    execution(f.request).slice(0, -100), execution({ ...f.request, conversation_id: undefined, session_id: undefined })]) {
    await writeFile(f.log, text);
    assert.deepEqual((await f.collect()).executions, []);
  }
  const projected = projectCursorAppHookDiagnostics({ secret, readStatus: secret, filesRead: -1,
    unscopedRequests: { beforeSubmitPrompt: 99999 }, executions: [{ step: "stop", scope: "turn", exitCode: secret,
      responseKind: secret, additionalContextPresent: secret, stderrPresent: secret, raw: secret }] });
  assert.ok(!JSON.stringify(projected).includes(secret));
  assert.equal(projected.executions[0].exitCode, null);
});

test("owned execution counts retain the first rejection reason without accepting discarded identities", async (t) => {
  const f = await fixture(t);
  await writeFile(f.log,
    execution(f.request, { input: `{${secret}` })
    + execution(f.request, { input: JSON.stringify([secret]) })
    + execution({ ...f.request, hook_event_name: "stop", conversation_id: randomUUID(), generation_id: randomUUID() },
      { step: "beforeSubmitPrompt" })
    + execution({ ...f.request, conversation_id: undefined, session_id: undefined })
    + execution({ ...f.request, conversation_id: randomUUID(), generation_id: randomUUID() })
    + execution({ ...f.request, generation_id: randomUUID() })
    + execution(f.request, { cmd: `node /${secret}/unowned.mjs` })
    + execution(f.request, { step: "unknown" })
    + execution(f.request).slice(0, -100));
  const result = await f.collect();
  assert.equal(result.readStatus, "present");
  assert.deepEqual(result.executions, []);
  assert.equal(result.ownedExecutionBlocks.beforeSubmitPrompt, 6);
  assert.deepEqual(result.filteredExecutionBlocks.beforeSubmitPrompt, { parse: 2, event: 1, session: 2, generation: 1 });
  assert.equal(result.ownedExecutionBlocks.stop, 0);
  assert.deepEqual(projectCursorAppHookDiagnostics(result), result);
  for (const privateValue of [secret, command, f.home, f.sessionId, f.turnId]) {
    assert.ok(!JSON.stringify(result).includes(privateValue));
  }
});

test("block count projections reject unknown fields and invalid or unbounded values", () => {
  for (const invalid of [-1, 1.5, 4097, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, secret, {}, null]) {
    const result = projectCursorAppHookDiagnostics({
      ownedExecutionBlocks: { beforeSubmitPrompt: invalid, stop: 4096, [secret]: 1 },
      filteredExecutionBlocks: { beforeSubmitPrompt: { parse: 3, event: invalid, session: invalid, generation: invalid, [secret]: 1 },
        [secret]: { parse: 1 } },
    });
    assert.equal(result.ownedExecutionBlocks.beforeSubmitPrompt, 0);
    assert.equal(result.ownedExecutionBlocks.stop, 4096);
    assert.deepEqual(result.filteredExecutionBlocks.beforeSubmitPrompt, { parse: 3, event: 0, session: 0, generation: 0 });
    assert.ok(!JSON.stringify(result).includes(secret));
  }
});

test("oversized execution reports preserve prior safe block and rejection counts", async (t) => {
  const f = await fixture(t);
  await writeFile(f.log, execution(f.request).repeat(32)
    + execution(f.request, { input: JSON.stringify(null) })
    + execution({ ...f.request, hook_event_name: "stop" })
    + execution({ ...f.request, hook_event_name: "preCompact" }));
  const result = await f.collect();
  assert.equal(result.readStatus, "oversized");
  assert.equal(result.ownedExecutionBlocks.beforeSubmitPrompt, 33);
  assert.equal(result.ownedExecutionBlocks.stop, 1);
  assert.equal(result.ownedExecutionBlocks.preCompact, 0);
  assert.deepEqual(result.filteredExecutionBlocks.beforeSubmitPrompt, { parse: 1, event: 0, session: 0, generation: 0 });
  assert.equal(result.executions.length, 32);
  assert.deepEqual(projectCursorAppHookDiagnostics(result), result);
  for (const privateValue of [secret, f.home, f.sessionId, f.turnId]) assert.ok(!JSON.stringify(result).includes(privateValue));
});

test("reads are bounded and reject unsafe paths, malformed identities and invalid UTF-8", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.collect()).readStatus, "absent");
  for (const [data, expected] of [[Buffer.from([0xff]), "invalid"], [Buffer.alloc(2 * 1024 * 1024 + 1), "oversized"],
    [execution(f.request).repeat(33), "oversized"]]) {
    await writeFile(f.log, data);
    assert.equal((await f.collect()).readStatus, expected);
  }
  for (const patch of [{ home: "relative" }, { sessionId: "invalid" }, { turnId: `${f.turnId}\n` }]) {
    assert.equal((await collectCursorAppHookDiagnostics({ ...f, ...patch })).readStatus, "invalid");
  }
  if (process.platform !== "win32") {
    await rm(f.log);
    await symlink(join(f.home, "outside"), f.log);
    assert.equal((await f.collect()).readStatus, "unsafe");
    await rm(join(f.home, "logs"), { recursive: true });
    await symlink(f.home, join(f.home, "logs"));
    assert.equal((await f.collect()).readStatus, "unsafe");
  }
});

test("discovery stays in native output directories and bounds file count and total bytes", async (t) => {
  const f = await fixture(t), nested = join(dirname(f.log), "nested");
  await mkdir(nested);
  await writeFile(join(nested, "cursor.hooks.log"), execution(f.request));
  await writeFile(join(f.home, "cursor.hooks.log"), execution(f.request));
  assert.equal((await f.collect()).readStatus, "absent");
  for (let index = 0; index < 17; index++) {
    await writeFile(join(dirname(f.log), `cursor.hooks.workspaceId-${index}.log`), "");
  }
  assert.equal((await f.collect()).readStatus, "oversized");
  await rm(dirname(f.log), { recursive: true });
  await mkdir(dirname(f.log));
  for (const name of ["cursor.hooks.log", "cursor.hooks.workspaceId-extra.log"]) {
    await writeFile(join(dirname(f.log), name), Buffer.alloc(1024 * 1024 + 1, 32));
  }
  assert.equal((await f.collect()).readStatus, "oversized");
  await rm(join(f.home, "logs"), { recursive: true });
  for (let index = 0; index < 513; index++) await writeFile(join(f.home, `ignored-${index}`), "");
  assert.equal((await f.collect()).readStatus, "oversized");
});

const startedAt = Date.parse("2026-10-09T12:00:00.000Z");
const logLine = (offset, text) => "[" + new Date(startedAt + offset).toISOString() + "] " + text + "\n";
const initialized = logLine(1, "Initializing Cursor Hooks Service...");
const reload = logLine(2, "Reloading hooks configuration...");
const loaded = logLine(3, "Loaded 5 user hook(s) for steps: sessionStart, beforeSubmitPrompt, preCompact, afterAgentResponse, stop");
const marker = (id) => "MEMORAX_CODE_MEMORY_CLI_TRACE_CLIENT=cursor and MEMORAX_CODE_MEMORY_CLI_TRACE_SESSION_ID=" + id;

test("Hook startup timing accepts only the current launch and projects native times separately from observations", async (t) => {
  const f = await fixture(t);
  const start = { ...f.request, hook_event_name: "sessionStart", generation_id: "", prompt: undefined };
  await writeFile(f.log, initialized + reload + loaded
    + execution(start, { output: { additional_context: marker(f.sessionId) }, stderr: "" })
    + logLine(10, "Hook step requested: beforeSubmitPrompt") + execution(f.request));
  const result = await collectCursorAppHookTiming({ ...f, startedAt });
  assert.equal(result.readStatus, "present");
  assert.equal(result.currentLogFiles, 1);
  assert.equal(result.requiredUserHooksLoaded, true);
  assert.equal(result.sessionStartReady, true);
  assert.deepEqual(result.counts, { reload: 1, userConfigLoad: 1, beforeSubmitRequest: 1, beforeSubmitExecution: 1 });
  assert.deepEqual(result.nativeLogMs, { firstReload: 2, lastReload: 2, lastRequiredUserConfigLoad: 3, lastBeforeSubmitRequest: 10 });
  assert.deepEqual(result.observedMs, { sessionStartReady: null, submit: null, modelRequest: null, turnStart: null });
  assert.deepEqual(projectCursorAppHookTiming(result), result);
  for (const value of [secret, f.home, f.sessionId, f.turnId]) assert.equal(JSON.stringify(result).includes(value), false);
  // The same complete file belongs to an earlier App after restart.
  const old = await collectCursorAppHookTiming({ ...f, startedAt: startedAt + 20 });
  assert.equal(old.currentLogFiles, 0);
  assert.equal(old.requiredUserHooksLoaded, false);
  assert.equal(old.sessionStartReady, false);
});

test("configuration gate rejects incomplete, stale, foreign and invalid loads and resets on the next reload", async (t) => {
  const f = await fixture(t);
  for (const text of [loaded, reload + loaded, initialized + reload,
    initialized + loaded.replace("5 user", "5 project"),
    initialized + loaded.replace("beforeSubmitPrompt, ", ""),
    initialized + loaded.replace("5 user", "4 user"),
    initialized + loaded + logLine(4, "Reloading hooks configuration..."),
    initialized + loaded + logLine(4, "ERROR: Failed to parse user hooks configuration"),
    initialized + loaded + logLine(4, "No user hooks configuration found"),
    initialized + loaded.slice(0, -1), initialized + loaded + execution(f.request).slice(0, -20),
    execution(f.request, { stderr: initialized + loaded }),
    execution(f.request).slice(0, -20) + initialized + loaded]) {
    await writeFile(f.log, text);
    assert.equal((await collectCursorAppHookTiming({ home: f.home, startedAt })).requiredUserHooksLoaded, false);
  }
  await writeFile(f.log, initialized + reload + loaded + logLine(4, "Reloading hooks configuration...")
    + loaded.replace("00.003Z", "00.005Z"));
  const next = await collectCursorAppHookTiming({ home: f.home, startedAt });
  assert.equal(next.requiredUserHooksLoaded, true);
  assert.equal(next.counts.reload, 2);
  assert.equal(next.nativeLogMs.lastRequiredUserConfigLoad, 5);
});

test("session startup requires an owned complete successful block, exact identity and matching context", async (t) => {
  const f = await fixture(t), other = randomUUID();
  const start = { ...f.request, hook_event_name: "sessionStart", generation_id: "", prompt: undefined };
  const options = { output: { additional_context: marker(f.sessionId) }, stderr: "" };
  for (const [request, patch, partial] of [[start, {}, false],
    [{ ...start, conversation_id: other }, {}, false], [{ ...start, session_id: other }, {}, false],
    [{ ...start, generation_id: f.turnId }, {}, false], [{ ...start, generation_id: "invalid" }, {}, false],
    [start, { cmd: "node /unowned-hook.mjs" }, false], [start, { exit: 1 }, false],
    [start, { output: { additional_context: marker(other) } }, false],
    [start, { output: { additional_context: marker(f.sessionId) + "-suffix" } }, false],
    [start, { output: { continue: false, additional_context: marker(f.sessionId) } }, false],
    [start, { output: {} }, false], [start, {}, true]]) {
    let block = execution(request, { ...options, ...patch });
    if (partial) block = block.slice(0, -20);
    await writeFile(f.log, initialized + reload + loaded + block);
    const result = await collectCursorAppHookTiming({ ...f, startedAt });
    assert.equal(result.sessionStartReady, request === start && !Object.keys(patch).length && !partial);
  }
});

test("timing refuses multiple current log windows, unsafe data and unknown/unbounded fields", async (t) => {
  const f = await fixture(t);
  await writeFile(f.log, initialized + loaded);
  const other = join(dirname(f.log), "cursor.hooks.workspaceId-another.log");
  await writeFile(other, initialized + loaded);
  assert.equal((await collectCursorAppHookTiming({ ...f, startedAt })).requiredUserHooksLoaded, false);
  await rm(other);
  await writeFile(f.log, Buffer.alloc(2 * 1024 * 1024 + 1));
  const oversized = await collectCursorAppHookTiming({ ...f, startedAt });
  assert.equal(oversized.readStatus, "oversized");
  assert.equal(oversized.requiredUserHooksLoaded, false);
  for (const patch of [{ startedAt: NaN }, { sessionId: secret }, { turnId: secret }]) {
    assert.equal((await collectCursorAppHookTiming({ ...f, startedAt, ...patch })).readStatus, "invalid");
  }
  const projected = projectCursorAppHookTiming({ phase: secret, appLaunch: 17, runIndex: 65, raw: secret,
    requiredUserHooksLoaded: secret, sessionStartReady: secret,
    counts: { reload: 4097, userConfigLoad: -1, beforeSubmitRequest: 2, beforeSubmitExecution: secret },
    nativeLogMs: { firstReload: -1, lastReload: 1800001, lastRequiredUserConfigLoad: secret, lastBeforeSubmitRequest: 3 },
    observedMs: { sessionStartReady: 0, submit: 4, modelRequest: Infinity, turnStart: 1.5 } });
  assert.equal(JSON.stringify(projected).includes(secret), false);
  assert.equal(projected.runIndex, null);
  assert.equal(projected.requiredUserHooksLoaded, false);
  assert.deepEqual(projected.observedMs, { sessionStartReady: 0, submit: 4, modelRequest: null, turnStart: null });
});
