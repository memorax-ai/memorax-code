import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { collectCursorAppHookDiagnostics, projectCursorAppHookDiagnostics, collectCursorAppHookTiming, projectCursorAppHookTiming,
  collectCursorAppSessionHookDiagnostics, projectCursorAppSessionHookDiagnostics, projectCursorAppHookReadinessFailure,
  collectCursorAppHookTimeline, projectCursorAppHookTimeline } from "./cursor-app-hook-diagnostics.mjs";

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


const currentLaunch = "[2026-10-09T12:00:00.000Z] Initializing Cursor Hooks Service...\n"
  + "[2026-10-09T12:00:00.001Z] Reloading hooks configuration...\n"
  + "[2026-10-09T12:00:00.002Z] Loaded 5 user hook(s) for steps: sessionStart, beforeSubmitPrompt, preCompact, afterAgentResponse, stop\n";
const sessionRequested = "[2026-10-09T12:00:00.003Z] Hook step requested: sessionStart\n";

test("session diagnostics distinguish missing request, missing execution, exit failure and response rejection before any turn", async (t) => {
  const f = await fixture(t);
  const request = { ...f.request, hook_event_name: "sessionStart", generation_id: undefined };
  const context = "MEMORAX_CODE_MEMORY_CLI_TRACE_CLIENT=cursor and MEMORAX_CODE_MEMORY_CLI_TRACE_SESSION_ID=" + f.sessionId;
  for (const [name, body, expected] of [
    ["no-request", "", { requests: 0, blocks: 0, ready: false }],
    ["request-only", sessionRequested, { requests: 1, blocks: 0, ready: false }],
    ["exit-failed", sessionRequested + execution(request, { exit: 1 }), { requests: 1, blocks: 1, exit: 1, trace: false, ready: false }],
    ["context-missing", sessionRequested + execution(request, { output: { continue: true, additional_context: secret } }),
      { requests: 1, blocks: 1, exit: 0, trace: false, ready: false }],
    ["denied", sessionRequested + execution(request, { output: { continue: false, additional_context: context } }),
      { requests: 1, blocks: 1, exit: 0, trace: true, ready: false }],
    ["valid", sessionRequested + execution(request, { output: { additional_context: context } }),
      { requests: 1, blocks: 1, exit: 0, trace: true, ready: true }],
  ]) {
    await writeFile(f.log, currentLaunch + body);
    const value = await collectCursorAppSessionHookDiagnostics({ home: f.home, startedAt, sessionId: f.sessionId });
    const timing = await collectCursorAppHookTiming({ home: f.home, startedAt, sessionId: f.sessionId });
    assert.equal(value.readStatus, "present", name);
    assert.equal(value.currentLogFiles, 1, name);
    assert.equal(value.unscopedRequests, expected.requests, name);
    assert.equal(value.ownedExecutionBlocks, expected.blocks, name);
    assert.equal(value.executions[0]?.exitCode, expected.exit, name);
    assert.equal(value.executions[0]?.traceContextMatched, expected.trace, name);
    assert.equal(timing.requiredUserHooksLoaded, true, name);
    assert.equal(timing.sessionStartReady, expected.ready, name);
    assert.deepEqual(projectCursorAppSessionHookDiagnostics(value), value);
    for (const privateValue of [secret, f.home, f.sessionId, f.turnId]) assert.equal(JSON.stringify(value).includes(privateValue), false);
  }
});

test("session diagnostics require the explicit session and preserve generation, parse and native response failures", async (t) => {
  const f = await fixture(t);
  const request = { ...f.request, hook_event_name: "sessionStart", generation_id: undefined };
  const output = { additional_context: "MEMORAX_CODE_MEMORY_CLI_TRACE_CLIENT=cursor and MEMORAX_CODE_MEMORY_CLI_TRACE_SESSION_ID=" + f.sessionId };
  await writeFile(f.log, currentLaunch
    + execution(request, { input: "{" + secret })
    + execution({ ...request, conversation_id: randomUUID() })
    + execution({ ...request, generation_id: f.turnId })
    + execution({ ...request, generation_id: "malformed" }, { output })
    + execution({ ...request, generation_id: "" }, { output })
    + execution({ ...request, session_id: randomUUID() }, { output })
    + execution(request, { output: null, exit: "N/A" }));
  const value = await collectCursorAppSessionHookDiagnostics({ home: f.home, startedAt, sessionId: f.sessionId });
  assert.deepEqual(value.filteredExecutionBlocks, { parse: 1, event: 0, session: 1, generation: 1 });
  assert.deepEqual(value.executions.map((item) => [item.generation, item.generationAllowed, item.sessionAliasMatched]),
    [["invalid", false, true], ["invalid", true, true], ["absent", true, false], ["absent", true, true]]);
  assert.equal(value.executions.at(-1).responseKind, "empty");
  assert.equal(value.executions.at(-1).exitCode, null);
  assert.deepEqual(projectCursorAppSessionHookDiagnostics(value), value);
  for (const privateValue of [secret, f.home, f.sessionId, f.turnId]) assert.equal(JSON.stringify(value).includes(privateValue), false);
  assert.equal((await collectCursorAppSessionHookDiagnostics({ home: f.home, startedAt, sessionId: secret })).readStatus, "invalid");
});

test("session collection reports partial frames and excludes executions outside the current launch", async (t) => {
  const f = await fixture(t), request = { ...f.request, hook_event_name: "sessionStart", generation_id: undefined };
  await writeFile(f.log, currentLaunch + execution(request).slice(0, -40));
  const partial = await collectCursorAppSessionHookDiagnostics({ home: f.home, startedAt, sessionId: f.sessionId });
  assert.equal(partial.readStatus, "invalid");
  assert.equal(partial.executions.length, 0);
  await writeFile(f.log, currentLaunch + execution(request));
  const earlier = await collectCursorAppSessionHookDiagnostics({ home: f.home, startedAt: startedAt + 1, sessionId: f.sessionId });
  assert.equal(earlier.currentLogFiles, 0);
  assert.equal(earlier.ownedExecutionBlocks, 0);
});

test("readiness failure projection is bounded, idempotent and excludes identity and private text", () => {
  const value = projectCursorAppHookReadinessFailure({ phase: "session", appLaunch: 1,
    code: "CURSOR_APP_SESSION_START_READY_TIMEOUT", timeoutKind: "predicate", waitElapsedMs: 5000,
    lastObservationElapsedMs: 100, observationPending: true,
    lastObservation: { phase: "session", requiredUserHooksLoaded: true, sessionStartReady: false, sessionId: secret },
    sessionDiagnosticsStatus: "completed", sessionStart: { readStatus: "present", filesRead: 1, currentLogFiles: 1,
      unscopedRequests: 1, ownedExecutionBlocks: 1, filteredExecutionBlocks: { parse: 1, raw: secret }, executions: [], raw: secret },
    sessionId: secret, home: secret, error: secret });
  assert.deepEqual(projectCursorAppHookReadinessFailure(value), value);
  assert.equal(value.sessionStart.unscopedRequests, 1);
  assert.equal(value.sessionStart.filteredExecutionBlocks.parse, 1);
  assert.equal(JSON.stringify(value).includes(secret), false);
  const invalid = projectCursorAppHookReadinessFailure({ phase: secret, appLaunch: 17, code: secret, timeoutKind: secret,
    waitElapsedMs: Infinity, lastObservationElapsedMs: -1, lastObservation: secret, sessionStart: { executions: [secret] } });
  assert.equal(invalid.waitElapsedMs, null);
  assert.equal(invalid.lastObservationElapsedMs, null);
  assert.equal(invalid.lastObservation, null);
  assert.equal(JSON.stringify(invalid).includes(secret), false);
});

const loadedText = "Loaded 5 user hook(s) for steps: sessionStart, beforeSubmitPrompt, preCompact, afterAgentResponse, stop";
async function timelineFixture(t) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "cursor-hook-timeline-")));
  t.after(() => rm(home, { recursive: true, force: true }));
  return { home,
    line: (start, offset, text) => "[" + new Date(start + offset).toISOString() + "] " + text + "\n",
    async write(launch, text, window = "window1") {
      const log = join(home, "logs", launch, window, "output_20261009T120001/cursor.hooks.workspaceId-fixture.log");
      await mkdir(dirname(log), { recursive: true });
      await writeFile(log, text.replaceAll("\n", "\r\n"));
    } };
}

test("Hook timeline attributes launches, sessionStart executions and request context only to check roles", async (t) => {
  const { home, line, write } = await timelineFixture(t);
  const [first, second, child, other] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()], next = startedAt + 60000;
  const start = (id, output, patch = {}) => execution({ hook_event_name: "sessionStart", conversation_id: id, session_id: id,
    workspace_roots: [home], user_email: secret, ...patch }, { output, stderr: "" });
  const posix = `env MEMORAX_CODE_MEMORY_CLI_TRACE_CLIENT=cursor MEMORAX_CODE_MEMORY_CLI_TRACE_SESSION_ID=${second} memorax-cli search`;
  await write("20261009T120000", line(startedAt, 1, "Initializing Cursor Hooks Service...")
    + line(startedAt, 2, "Reloading hooks configuration...") + line(startedAt, 4, "Hook step requested: sessionStart")
    + start(other, { additional_context: marker(other) }) + line(startedAt, 9, loadedText)
    + line(startedAt, 12, "Hook step requested: beforeSubmitPrompt")
    + execution({ hook_event_name: "beforeSubmitPrompt", conversation_id: first, generation_id: randomUUID(), prompt: secret })
    + start(first, { additional_context: marker(other) }) + line(startedAt, 15, "Hook step requested: beforeSubmitPrompt"));
  await write("20261009T120100", line(next, 1, "Initializing Cursor Hooks Service...")
    + line(next, 2, "Reloading hooks configuration...") + line(next, 3, loadedText) + line(next, 6, "Hook step requested: sessionStart")
    + start(second, { additional_context: posix }) + start(child, { additional_context: marker(child) })
    + start("not-a-native-session") + start(second, undefined, { generation_id: randomUUID() })
    + execution({ hook_event_name: "sessionStart" }, { input: "{" + secret })
    + start(second, { additional_context: secret }) + start(second, null)
    + line(next, 20, "Hook step requested: beforeSubmitPrompt") + start(first, {}).slice(0, -40));
  // A log written before the first check launch stays outside every launch.
  await write("20261009T115900", line(startedAt, -1000, "Initializing Cursor Hooks Service...")
    + line(startedAt, -999, "Hook step requested: sessionStart") + start(first, { additional_context: marker(first) }));
  const sessions = [
    { id: first, launch: 1, requestedAt: startedAt + 5, observedAt: startedAt + 8, submits: [{ launch: 1, at: startedAt + 11 }] },
    { id: second, launch: 2, requestedAt: next + 5, observedAt: next + 9, submits: [{ launch: 2, at: next + 19 }] }];
  const runs = [
    { conversationId: first, inputRequestContext: { hooksAdditionalContext: marker(other) } },
    { conversationId: first, requestContext: { hooksAdditionalContext: marker(first) }, userHookAdditionalContexts: [{ content: secret }] },
    { conversationId: second, inputRequestContext: { hooksAdditionalContext: posix } },
    { conversationId: child, parentConversationId: second, inputRequestContext: { hooksAdditionalContext: marker(child) } }];
  const result = await collectCursorAppHookTimeline({ home, launches: [startedAt, next], sessions, runs });
  const base = { exitCode: 0, responseKind: "json", continue: "absent", stderrPresent: false, generationAllowed: true,
    sessionAliasMatched: true, workspaceKind: "single" };
  const second2 = { launch: 2, writtenMs: { notBefore: 6, notAfter: 20 }, submitRequestsBefore: 0 };
  assert.deepEqual(result, { collection: "completed", readStatus: "present", filesRead: 3, unattributedLogFiles: 1, incompleteLogFiles: 1,
    launches: [
      { launch: 1, logFiles: 1, serviceInitMs: 1, config: [{ ms: 2, state: "reloading" }, { ms: 9, state: "loaded" }],
        requestsMs: { sessionStart: [4], beforeSubmitPrompt: [12, 15] }, omittedEvents: 0 },
      { launch: 2, logFiles: 1, serviceInitMs: 1, config: [{ ms: 2, state: "reloading" }, { ms: 3, state: "loaded" }],
        requestsMs: { sessionStart: [6], beforeSubmitPrompt: [20] }, omittedEvents: 0 }],
    sessions: [
      { role: "S1", launch: 1, createMs: { requested: 5, observed: 8 }, configAtCreate: "not-ready", submitsMs: [{ launch: 1, ms: 11 }],
        context: { runs: 2, ownRuns: 1, own: ["fresh"], foreign: ["initial"], unrecognized: [], none: ["user"], foreignRoles: ["other"] } },
      { role: "S2", launch: 2, createMs: { requested: 5, observed: 9 }, configAtCreate: "ready", submitsMs: [{ launch: 2, ms: 19 }],
        context: { runs: 1, ownRuns: 0, own: [], foreign: [], unrecognized: ["initial"], none: [], foreignRoles: [] } }],
    sessionStart: { requests: 3, ownedExecutionBlocks: 10, filteredExecutionBlocks: { parse: 1, event: 0, session: 1, generation: 1 },
      executions: [
        { role: "other", launch: 1, writtenMs: { notBefore: 4, notAfter: 9 }, submitRequestsBefore: 0, ...base, trace: "own", traceRole: null },
        { role: "S1", launch: 1, writtenMs: { notBefore: 12, notAfter: 15 }, submitRequestsBefore: 1, ...base, trace: "foreign", traceRole: "other" },
        { role: "S2", ...second2, ...base, trace: "unrecognized", traceRole: null },
        { role: "S2-child", ...second2, ...base, trace: "own", traceRole: null },
        { role: "S2", ...second2, ...base, trace: "none", traceRole: null },
        { role: "S2", ...second2, ...base, responseKind: "empty", trace: "absent", traceRole: null },
        { role: "S1", launch: null, writtenMs: { notBefore: null, notAfter: null }, submitRequestsBefore: 0, ...base, trace: "own", traceRole: null }] } });
  assert.deepEqual(projectCursorAppHookTimeline(result), result);
  for (const value of [secret, home, first, second, child, other]) assert.equal(JSON.stringify(result).includes(value), false);
});

test("Hook timeline reports readiness changes, ambiguous log windows, caps and scope without guessing", async (t) => {
  const { home, line, write } = await timelineFixture(t), next = startedAt + 60000;
  await write("20261009T120000", line(startedAt, 1, "Initializing Cursor Hooks Service...")
    + line(startedAt, 3, loadedText) + line(startedAt, 6, "Reloading hooks configuration...")
    + Array.from({ length: 10 }, (_, index) => line(startedAt, 10 + index, "Hook step requested: beforeSubmitPrompt")).join(""));
  await write("20261009T120100", line(next, 1, "Initializing Cursor Hooks Service...") + line(next, 3, loadedText));
  await write("20261009T120100", line(next, 2, "Initializing Cursor Hooks Service...") + line(next, 4, loadedText), "window2");
  const sessions = [{ id: randomUUID(), launch: 1, requestedAt: startedAt + 5, observedAt: startedAt + 8, submits: [] },
    { id: randomUUID(), launch: 2, requestedAt: next + 5, observedAt: next + 8, submits: [] }];
  const result = await collectCursorAppHookTimeline({ home, launches: [startedAt, next], sessions, runs: [] });
  // Loaded when creation was requested, reloading when it was observed.
  assert.deepEqual(result.sessions.map((item) => item.configAtCreate), ["changed", "unknown"]);
  assert.deepEqual(result.launches[0].requestsMs.beforeSubmitPrompt, [10, 11, 12, 13, 14, 15, 16, 17]);
  assert.equal(result.launches[0].omittedEvents, 2);
  assert.deepEqual(result.launches[1], { launch: 2, logFiles: 2, serviceInitMs: 1,
    config: [{ ms: 3, state: "loaded" }, { ms: 4, state: "loaded" }], requestsMs: { sessionStart: [], beforeSubmitPrompt: [] }, omittedEvents: 0 });
  const unattributed = await collectCursorAppHookTimeline({ home, launches: [], sessions });
  assert.equal(unattributed.unattributedLogFiles, 3);
  assert.deepEqual(unattributed.launches, []);
  assert.deepEqual(unattributed.sessions.map((item) => [item.launch, item.configAtCreate]), [[1, "unknown"], [2, "unknown"]]);
  assert.equal((await collectCursorAppHookTimeline({ home: "relative", launches: [startedAt] })).readStatus, "invalid");
  assert.equal((await collectCursorAppHookTimeline({ home: join(home, "missing"), launches: [startedAt] })).readStatus, "absent");
});

test("Hook timeline leaves readiness unknown when a read fails or the log stops before creation was observed", async (t) => {
  const sessions = [{ id: randomUUID(), launch: 1, requestedAt: startedAt + 5, observedAt: startedAt + 8, submits: [] }];
  const start = () => execution({ hook_event_name: "sessionStart", conversation_id: randomUUID() }, { stderr: "" });
  const collect = async (body) => {
    const { home, line, write } = await timelineFixture(t);
    await write("20261009T120000", line(startedAt, 1, "Initializing Cursor Hooks Service...") + line(startedAt, 3, loadedText) + body(line));
    return collectCursorAppHookTimeline({ home, launches: [startedAt], sessions, runs: [] });
  };
  // The read fails on the 33rd execution, after this launch's configuration lines were collected.
  const failed = await collect(() => Array.from({ length: 33 }, start).join(""));
  assert.deepEqual([failed.readStatus, failed.launches[0].config, failed.sessions[0].configAtCreate],
    ["oversized", [{ ms: 3, state: "loaded" }], "unknown"]);
  // The readable part ends before creation was observed, so a reload there could be missing.
  const cut = await collect(() => start().slice(0, -40));
  assert.deepEqual([cut.readStatus, cut.incompleteLogFiles, cut.launches[0].config, cut.sessions[0].configAtCreate],
    ["present", 1, [{ ms: 3, state: "loaded" }], "unknown"]);
  const covered = await collect((line) => line(startedAt, 8, "Hook step requested: sessionStart") + start().slice(0, -40));
  assert.deepEqual([covered.incompleteLogFiles, covered.sessions[0].configAtCreate], [1, "ready"]);
});

test("Hook timeline projection is idempotent, bounded and drops unknown, private or invalid values", () => {
  const max = 1800000, sources = ["initial", "fresh", "dynamic", "user", "exec"];
  const roles = [...[1, 2, 3, 4, 5, 6].flatMap((index) => [`S${index}`, `S${index}-child`]), "other"];
  const value = projectCursorAppHookTimeline({ collection: "completed", readStatus: "present", filesRead: 16,
    unattributedLogFiles: 16, incompleteLogFiles: 16, raw: secret,
    launches: Array(20).fill({ launch: 6, logFiles: 16, serviceInitMs: max, config: Array(20).fill({ ms: max, state: "reloading", raw: secret }),
      requestsMs: { sessionStart: Array(20).fill(max), beforeSubmitPrompt: Array(20).fill(max) }, omittedEvents: 4096, raw: secret }),
    sessions: Array(20).fill({ role: "S6-child", launch: 6, createMs: { requested: max, observed: max }, configAtCreate: "not-ready",
      submitsMs: Array(20).fill({ launch: 8, ms: max }), id: secret, context: { runs: 4096, ownRuns: 4096,
        own: sources, foreign: sources, unrecognized: sources, none: sources, foreignRoles: roles } }),
    sessionStart: { requests: 4096, ownedExecutionBlocks: 4096,
      filteredExecutionBlocks: { parse: 4096, event: 4096, session: 4096, generation: 4096, raw: secret },
      executions: Array(20).fill({ role: "S6-child", launch: 6, writtenMs: { notBefore: max, notAfter: max }, submitRequestsBefore: 4096,
        exitCode: 0xffff_ffff, responseKind: "invalid", continue: "absent", stderrPresent: true, generationAllowed: true,
        sessionAliasMatched: true, workspaceKind: "projectless", trace: "foreign", traceRole: "S6-child", sessionId: secret }) } });
  assert.deepEqual(projectCursorAppHookTimeline(value), value);
  assert.deepEqual([value.launches.length, value.launches[0].config.length, value.launches[0].requestsMs.sessionStart.length,
    value.sessions.length, value.sessions[0].submitsMs.length, value.sessions[0].context.foreignRoles.length,
    value.sessionStart.executions.length], [6, 8, 8, 6, 6, 3, 10]);
  // Worst case stays a fraction of the 64 KiB report limit, including the indented final report.
  assert.ok(JSON.stringify(value, null, 2).length <= 24 * 1024, String(JSON.stringify(value, null, 2).length));
  assert.equal(JSON.stringify(value).includes(secret), false);
  for (const garbage of [undefined, null, secret, 7, [], { launches: secret, sessions: [secret, null, 1], sessionStart: { executions: [1, secret] } }]) {
    const empty = projectCursorAppHookTimeline(garbage);
    assert.equal(empty.collection, "failed");
    assert.equal(empty.readStatus, "unavailable");
    assert.deepEqual([empty.launches, empty.sessions, empty.sessionStart.executions], [[], [], []]);
  }
  const invalid = projectCursorAppHookTimeline({ collection: secret, launches: [{ launch: 0, serviceInitMs: -1, config: [{ ms: 1, state: secret }],
    requestsMs: { sessionStart: [-1, max + 1, 3] } }], sessions: [{ role: secret, launch: 9, configAtCreate: secret, submitsMs: [{ launch: 1, ms: -1 }] }],
    sessionStart: { executions: [{ role: secret, trace: secret, traceRole: "S1" }, { trace: "own", traceRole: "S1" }] } });
  assert.deepEqual(invalid.launches, [{ launch: null, logFiles: 0, serviceInitMs: null, config: [],
    requestsMs: { sessionStart: [3], beforeSubmitPrompt: [] }, omittedEvents: 0 }]);
  assert.deepEqual([invalid.sessions[0].role, invalid.sessions[0].launch, invalid.sessions[0].configAtCreate, invalid.sessions[0].submitsMs],
    ["other", null, "unknown", [{ launch: 1, ms: null }]]);
  assert.deepEqual(invalid.sessionStart.executions.map((item) => [item.role, item.trace, item.traceRole]), [["other", "absent", null], ["other", "own", null]]);
  assert.equal(JSON.stringify(invalid).includes(secret), false);
});
