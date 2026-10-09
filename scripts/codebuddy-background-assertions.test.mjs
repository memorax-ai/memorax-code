import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fixtureModel } from "./codebuddy-native-support.mjs";
import { assertBackgroundJob, assertBackgroundModelRequests, assertBackgroundNoopResult, assertForegroundResult,
  assertGlobalConfiguration, backgroundInputText, backgroundProcessesExited, modelEnvironmentOverrides,
  summarizeBackgroundJobs, readBackgroundStartDiagnostic, summarizeBackgroundHookFailures, workerPromptMarker, foregroundPrompt, foregroundPromptForClient, foregroundAnswer, backgroundAnswer,
} from "./codebuddy-background-assertions.mjs";

const context = { jobPath: resolve("fixture/jobs/job-fixture/job.json"), repository: resolve("fixture/repo"),
  codebuddyCommand: resolve("fixture/bin/codebuddy"), pluginRoot: resolve("fixture/plugin"), snapshotHead: "b".repeat(40) };
const prompt = `${workerPromptMarker}\n\nPreserve the full synthetic worker prompt.\n\nLast paragraph.`;
const job = (client = "codebuddy") => ({ version: 1, jobId: "job-fixture", runId: "a".repeat(32), runner: client, mode: "build",
  repo: context.repository, snapshotHead: context.snapshotHead, status: "failed", failureReason: "artifact_validation_failed",
  exitCode: 0, validationExitCode: 1, command: [context.codebuddyCommand, "--plugin-dir", context.pluginRoot,
    "--print", "--output-format", "text", "--dangerously-skip-permissions", "--no-session-persistence", prompt],
  sharedSnapshot: { ref: "refs/remotes/origin/main", branch: "main", head: context.snapshotHead, baseHead: null },
  prompt, finalMessageSource: "stdout", finalMessagePath: join(dirname(context.jobPath), "final-message.txt"),
  outputLogPath: join(dirname(context.jobPath), "output.log"), pid: 12345, workerPid: 12345, childPid: 12346 });
const request = (text) => ({ method: "POST", path: "/v1/chat/completions", body: { model: fixtureModel,
  messages: [{ role: "user", content: text }] } });
const events = () => [{ type: "system", subtype: "init", session_id: "native-session", model: fixtureModel, permissionMode: "dontAsk" },
  { type: "result", subtype: "success", is_error: false, session_id: "native-session", result: foregroundAnswer }];

test("CodeBuddy background configuration comes from global files without process model overrides", () => {
  const url = "http://127.0.0.1:12345";
  const settings = { model: fixtureModel, env: { CODEBUDDY_BASE_URL: url, CODEBUDDY_API_KEY: "native-model-fixture" } };
  const models = { models: [{ id: fixtureModel, vendor: "OpenAI", url: `${url}/v1/chat/completions`, apiKey: "native-model-fixture" }],
    availableModels: [fixtureModel] };
  assertGlobalConfiguration({}, settings, models, url);
  for (const name of modelEnvironmentOverrides) {
    assert.throws(() => assertGlobalConfiguration({ [name]: "inherited-override" }, settings, models, url),
      { nativeCode: "BACKGROUND_PROCESS_MODEL_OVERRIDE_PRESENT" });
  }
  assert.throws(() => assertGlobalConfiguration({}, { ...settings, model: "foreign" }, models, url),
    { nativeCode: "BACKGROUND_GLOBAL_SETTINGS_MISMATCH" });
  for (const value of [undefined, null, {}, { models: [null] }, { models: "invalid" }]) {
    assert.throws(() => assertGlobalConfiguration({}, settings, value, url), { nativeCode: "BACKGROUND_GLOBAL_MODEL_MISMATCH" });
  }
  for (const model of [{ ...models.models[0], url: "https://invalid.example" }, { ...models.models[0], apiKey: "wrong-key" },
    { ...models.models[0], id: "wrong-model" }, { ...models.models[0], vendor: "Other" }]) {
    assert.throws(() => assertGlobalConfiguration({}, settings, { ...models, models: [model] }, url),
      { nativeCode: "BACKGROUND_GLOBAL_MODEL_MISMATCH" });
  }
});

test("CodeBuddy native foreground requires one successful matching session with the configured model", () => {
  assert.equal(assertForegroundResult(events()).session_id, "native-session");
  for (const patch of [{ subtype: "error" }, { is_error: true }, { terminal_reason: "aborted_streaming" },
    { session_id: "foreign" }, { result: "partial" }]) {
    assert.throws(() => assertForegroundResult([events()[0], { ...events()[1], ...patch }]),
      { nativeCode: "BACKGROUND_FOREGROUND_CONFIGURATION_MISMATCH" });
  }
  for (const values of [[], [events()[0]], [...events(), events()[1]],
    [{ ...events()[0], model: "wrong" }, events()[1]], [{ ...events()[0], permissionMode: "default" }, events()[1]]]) {
    assert.throws(() => assertForegroundResult(values), { nativeCode: "BACKGROUND_FOREGROUND_CONFIGURATION_MISMATCH" });
  }
});

test("CodeBuddy foreground repeated init events retain exact local model and session authority", () => {
  const [init, completed] = events();
  assert.equal(assertForegroundResult([{ ...init, model: `custom-local:${fixtureModel}` }, completed]).session_id, init.session_id);
  assert.equal(assertForegroundResult([init, { ...init, model: `custom-local:${fixtureModel}` }, init, completed]), init);
  for (const patch of [{ session_id: "foreign" }, { session_id: undefined }, { model: "unknown" },
    { model: `custom-local:custom-local:${fixtureModel}` }, { permissionMode: "default" }, { permissionMode: undefined }]) {
    assert.throws(() => assertForegroundResult([init, { ...init, ...patch }, completed]),
      { nativeCode: "BACKGROUND_FOREGROUND_CONFIGURATION_MISMATCH" });
  }
});

test("CodeBuddy background job pins the native launcher, plugin, repository and snapshot", () => {
  assertBackgroundJob(job(), context);
  assertBackgroundJob({ ...job(), status: "started", pid: undefined, workerPid: undefined, childPid: undefined }, context);
  for (const change of [{ runner: "workbuddy" }, { repo: "private-unowned-repo" }, { snapshotHead: "c".repeat(40) },
    { jobId: "different" }, { runId: "invalid" }, { status: "unknown" }, { mode: "update" }]) {
    assert.throws(() => assertBackgroundJob({ ...job(), ...change }, context), { nativeCode: "BACKGROUND_JOB_AUTHORITY_MISMATCH" });
  }
});

for (const client of ["codebuddy", "workbuddy"]) {
  test(`${client} background job requires its own client identity and exact native command`, () => {
    const selected = { ...context, client }, actual = job(client);
    assertBackgroundJob(actual, selected);
    assert.throws(() => assertBackgroundJob({ ...actual, runner: client === "workbuddy" ? "codebuddy" : "workbuddy" }, selected),
      { nativeCode: "BACKGROUND_JOB_AUTHORITY_MISMATCH" });
    assert.throws(() => assertBackgroundJob({ ...actual, command: ["foreign-runtime", ...actual.command.slice(1)] }, selected),
      { nativeCode: "BACKGROUND_JOB_COMMAND_MISMATCH" });
    assert.throws(() => assertBackgroundJob({ ...actual, command: [actual.command[0], "--plugin-dir", "foreign-plugin", ...actual.command.slice(3)] }, selected),
      { nativeCode: "BACKGROUND_JOB_COMMAND_MISMATCH" });
  });

  test(`${client} model evidence binds the full worker prompt and matching foreground prompt`, () => {
    const expected = foregroundPromptForClient(client);
    const other = foregroundPromptForClient(client === "workbuddy" ? "codebuddy" : "workbuddy");
    assertBackgroundModelRequests([request(expected), request(prompt)], prompt, { client });
    assertBackgroundModelRequests([request(prompt), request(expected)], prompt, { client });
    assert.throws(() => assertBackgroundModelRequests([request(other), request(prompt)], prompt, { client }),
      { nativeCode: "BACKGROUND_FOREGROUND_PROMPT_MISSING" });
    assert.throws(() => assertBackgroundModelRequests([request(expected), request(workerPromptMarker)], prompt, { client }),
      { nativeCode: "BACKGROUND_FULL_JOB_PROMPT_MISSING" });
  });
}

test("background client selection keeps CodeBuddy defaults and rejects unsupported clients", () => {
  assert.equal(foregroundPromptForClient(), foregroundPrompt);
  assert.equal(foregroundPromptForClient("workbuddy"), "Check this repository's global WorkBuddy model configuration.");
  for (const client of [null, "", "claude", "WorkBuddy"]) {
    for (const run of [() => foregroundPromptForClient(client),
      () => assertBackgroundJob(undefined, { client }),
      () => assertBackgroundModelRequests(undefined, undefined, { client })]) {
      assert.throws(run, { nativeCode: "NATIVE_CLIENT_INVALID" });
    }
  }
});

test("CodeBuddy background job rejects overrides, altered persistence, plugin and output paths", () => {
  for (const command of [[...job().command, "--model", "other"], job().command.filter((part) => part !== "--no-session-persistence"),
    ["other-client", ...job().command.slice(1)], [context.codebuddyCommand, "--plugin-dir", "other-plugin", ...job().command.slice(3)]]) {
    assert.throws(() => assertBackgroundJob({ ...job(), command }, context), { nativeCode: "BACKGROUND_JOB_COMMAND_MISMATCH" });
  }
  for (const change of [{ finalMessageSource: "file" }, { finalMessagePath: "private-output" }, { outputLogPath: "private-log" }]) {
    assert.throws(() => assertBackgroundJob({ ...job(), ...change }, context), { nativeCode: "BACKGROUND_JOB_OUTPUT_AUTHORITY_MISMATCH" });
  }
});

test("CodeBuddy background job rejects malformed process identities", () => {
  for (const change of [{ pid: -1 }, { workerPid: 0 }, { childPid: "12346" }, { childPid: 12345 }, { workerPid: 99 }]) {
    assert.throws(() => assertBackgroundJob({ ...job(), ...change }, context), { nativeCode: "BACKGROUND_JOB_PID_INVALID" });
  }
});

test("CodeBuddy noop completes natively before the canonical artifact validator rejects it", () => {
  assertBackgroundNoopResult(job(), `${backgroundAnswer}\n`);
  for (const change of [{ status: "succeeded" }, { failureReason: "codebuddy_exit_nonzero" }, { exitCode: 1 },
    { validationExitCode: 0 }, { validationExitCode: undefined }]) {
    assert.throws(() => assertBackgroundNoopResult({ ...job(), ...change }, backgroundAnswer),
      { nativeCode: "BACKGROUND_NOOP_JOB_RESULT_MISMATCH" });
  }
  assert.throws(() => assertBackgroundNoopResult({ ...job(), childPid: undefined }, backgroundAnswer),
    { nativeCode: "BACKGROUND_JOB_PID_MISSING" });
  assert.throws(() => assertBackgroundNoopResult(job(), "different native output"), { nativeCode: "BACKGROUND_NATIVE_STDOUT_MISMATCH" });
});

test("WorkBuddy noop requires native completion and still fails canonical artifact validation", () => {
  const actual = job("workbuddy");
  assertBackgroundJob(actual, { ...context, client: "workbuddy" });
  assertBackgroundNoopResult(actual, `${backgroundAnswer}\n`);
  for (const change of [{ status: "succeeded" }, { failureReason: "workbuddy_timeout" },
    { failureReason: "workbuddy_exit_nonzero" }, { exitCode: 1 }, { validationExitCode: 0 }]) {
    assert.throws(() => assertBackgroundNoopResult({ ...actual, ...change }, backgroundAnswer),
      { nativeCode: "BACKGROUND_NOOP_JOB_RESULT_MISMATCH" });
  }
});

test("CodeBuddy global model evidence requires both HTTP requests and every worker prompt paragraph", () => {
  const foreground = request(foregroundPrompt), worker = request(prompt);
  assertBackgroundModelRequests([foreground, worker], prompt);
  assertBackgroundModelRequests([worker, foreground], prompt);
  for (const values of [[worker], [foreground, worker, worker], [foreground, foreground],
    [foreground, { ...worker, path: "/foreign" }], [foreground, { ...worker, body: { ...worker.body, model: "foreign" } }],
    [foreground, { ...worker, body: { ...worker.body, model: `custom-local:${fixtureModel}` } }]]) {
    assert.throws(() => assertBackgroundModelRequests(values, prompt));
  }
  assert.throws(() => assertBackgroundModelRequests([foreground, request(workerPromptMarker)], prompt),
    { nativeCode: "BACKGROUND_FULL_JOB_PROMPT_MISSING" });
  assert.throws(() => assertBackgroundModelRequests([foreground, request(`${workerPromptMarker}\n\nLast paragraph.`)], prompt),
    { nativeCode: "BACKGROUND_FULL_JOB_PROMPT_MISSING" });
});

test("CodeBuddy model prompt evidence excludes tool results, reasoning and arbitrary metadata", () => {
  const hidden = { messages: [{ role: "tool", content: prompt }, { role: "assistant", content: prompt },
    { role: "user", content: [{ type: "image_url", text: prompt }], metadata: prompt }], reasoning_content: prompt };
  assert.equal(backgroundInputText(hidden), "");
  assert.equal(backgroundInputText({ messages: [{ role: "user", content: [{ type: "text", text: prompt }] }] }), prompt);
  assert.throws(() => assertBackgroundModelRequests([request(foregroundPrompt), { ...request(""), body: { model: fixtureModel, ...hidden } }], prompt),
    { nativeCode: "BACKGROUND_MODEL_REQUEST_IDENTITY_MISMATCH" });
});

test("CodeBuddy background cleanup checks worker and child groups, not only exited leaders", () => {
  const probes = [];
  assert.equal(backgroundProcessesExited([job()], (pid) => { probes.push(pid); return false; }, true), true);
  assert.deepEqual(probes, [12345, -12345, 12346, -12346]);
  for (const remaining of probes) assert.equal(backgroundProcessesExited([job()], (pid) => pid === remaining, true), false);
  for (const change of [{ status: "running" }, { workerPid: undefined }, { childPid: undefined }]) {
    assert.equal(backgroundProcessesExited([{ ...job(), ...change }], () => false, true), false);
  }
  assert.equal(backgroundProcessesExited([], () => false, true), false);
  assert.equal(backgroundProcessesExited([job()], (pid) => pid < 0, false), true);
});

test("CodeBuddy background diagnostics distinguish no job, unpublished processes and live workers", () => {
  const probes = [];
  const present = (pid) => { probes.push(pid); return pid === 12345; };
  assert.deepEqual(summarizeBackgroundJobs([], present), { jobCount: 0, jobs: [] });
  assert.deepEqual(summarizeBackgroundJobs([
    { ...job(), status: "started", workerPid: undefined, childPid: undefined, failureReason: undefined, exitCode: undefined },
    { ...job(), status: "running", failureReason: undefined, exitCode: undefined }], present), { jobCount: 2, jobs: [
    { status: "started", failureReason: "missing", exitCode: null,
      workerPidPresent: false, workerAlive: false, childPidPresent: false, childAlive: false },
    { status: "running", failureReason: "missing", exitCode: null,
      workerPidPresent: true, workerAlive: true, childPidPresent: true, childAlive: false },
  ] });
  assert.deepEqual(probes, [12345, 12346]);
});

test("CodeBuddy background diagnostics expose only fixed state and process-presence fields", () => {
  const privateText = "PRIVATE_JOB_PATH_PROMPT_COMMAND_ID_CANARY";
  const source = { ...job(), prompt: privateText, command: [privateText], repo: privateText, jobId: privateText,
    finalMessagePath: privateText, error: privateText, failureReason: privateText };
  assert.deepEqual(summarizeBackgroundJobs([source, { ...source, status: "succeeded" }], () => false),
    { jobCount: 2, jobs: [
      { status: "failed", failureReason: "other", exitCode: 0,
        workerPidPresent: true, workerAlive: false, childPidPresent: true, childAlive: false },
      { status: "succeeded", failureReason: "other", exitCode: 0,
        workerPidPresent: true, workerAlive: false, childPidPresent: true, childAlive: false },
    ] });
  assert.equal(JSON.stringify(summarizeBackgroundJobs([source], () => true)).includes(privateText), false);
});

test("CodeBuddy background diagnostics bound exit codes and allow only known failure reasons", () => {
  for (const exitCode of [0, 1, -1, 0xc0000005]) {
    const [summary] = summarizeBackgroundJobs([{ ...job(), failureReason: "codebuddy_exit_nonzero", exitCode }], () => false).jobs;
    assert.equal(summary.failureReason, "codebuddy_exit_nonzero");
    assert.equal(summary.exitCode, exitCode);
  }
  for (const exitCode of [undefined, "PRIVATE_EXIT_CODE", NaN, Infinity, 1.5, 0x100000000]) {
    const [summary] = summarizeBackgroundJobs([{ ...job(), failureReason: undefined, exitCode }], () => false).jobs;
    assert.equal(summary.failureReason, "missing");
    assert.equal(summary.exitCode, null);
  }
});

test("WorkBuddy background diagnostics retain its native failure codes without exposing raw failures", () => {
  for (const failureReason of ["workbuddy_timeout", "workbuddy_spawn_failed", "workbuddy_exit_nonzero"]) {
    const [summary] = summarizeBackgroundJobs([{ ...job("workbuddy"), failureReason }], () => false).jobs;
    assert.equal(summary.failureReason, failureReason);
  }
  assert.equal(summarizeBackgroundJobs([{ ...job("workbuddy"), failureReason: "workbuddy_private_native_error" }], () => false)
    .jobs[0].failureReason, "other");
});

test("CodeBuddy background diagnostics reject unrecognized states and malformed PIDs before probing", () => {
  for (const value of [undefined, [null], [{ ...job(), status: "PRIVATE_UNKNOWN_STATE" }],
    [{ ...job(), workerPid: 1 }], [{ ...job(), childPid: "PRIVATE_PID" }]]) {
    assert.throws(() => summarizeBackgroundJobs(value, () => assert.fail("invalid process was probed")),
      (error) => error.nativeCode === "BACKGROUND_JOB_DIAGNOSTIC_INVALID" && error.message === error.nativeCode);
  }
});

test("CodeBuddy background assertion errors never disclose private native content or paths", () => {
  const privateText = "PRIVATE_NATIVE_OUTPUT_AND_PATH_CANARY";
  for (const run of [() => assertBackgroundJob({ ...job(), repo: privateText }, context),
    () => assertBackgroundJob({ ...job(), finalMessagePath: privateText }, context),
    () => assertBackgroundNoopResult(job(), privateText), () => assertForegroundResult([events()[0], { ...events()[1], result: privateText }])]) {
    assert.throws(run, (error) => error.message === error.nativeCode && !error.stack.includes(privateText));
  }
});

test("CodeBuddy shared build binds the mainline snapshot and permits preparation before worker publication", () => {
  const preparing = { ...job(), status: "preparing", pid: undefined, workerPid: undefined, childPid: undefined };
  assertBackgroundJob(preparing, context);
  assert.equal(backgroundProcessesExited([preparing], () => false), false);
  for (const sharedSnapshot of [undefined, null, { ...job().sharedSnapshot, head: "c".repeat(40) },
    { ...job().sharedSnapshot, ref: "refs/heads/main" }, { ...job().sharedSnapshot, branch: "feature" },
    { ...job().sharedSnapshot, baseHead: context.snapshotHead }]) {
    assert.throws(() => assertBackgroundJob({ ...job(), sharedSnapshot }, context),
      { nativeCode: "BACKGROUND_JOB_AUTHORITY_MISMATCH" });
  }
});

test("background diagnostics retain preparation failures without treating preparation as completion", () => {
  const preparing = { ...job(), status: "preparing", workerPid: undefined, childPid: undefined,
    failureReason: undefined, exitCode: undefined };
  assert.deepEqual(summarizeBackgroundJobs([preparing], () => assert.fail("unpublished PID was probed")).jobs,
    [{ status: "preparing", failureReason: "missing", exitCode: null,
      workerPidPresent: false, workerAlive: false, childPidPresent: false, childAlive: false }]);
  for (const failureReason of ["snapshot_prepare_failed", "startup_ownership_lost"]) {
    assert.equal(summarizeBackgroundJobs([{ ...preparing, status: "failed", failureReason }], () => false)
      .jobs[0].failureReason, failureReason);
  }
});

test("background start diagnostics match the client, session and prompt without disclosing or changing records", async (t) => {
  const { stateHome, put, sessionId } = await startDiagnosticFixture(t);
  const secret = "PRIVATE_TRACE_BODY_PATH_PID_TOKEN_CANARY";
  await mkdir(join(stateHome, "repo-memory-jobs"));
  for (const client of ["codebuddy", "workbuddy"]) {
    const hash = createHash("sha256").update(foregroundPromptForClient(client)).digest("hex");
    const trace = { client, session_id: sessionId, turn_id: `${sessionId}:0:${hash}` };
    const records = [trace, { ...trace, client: client === "codebuddy" ? "workbuddy" : "codebuddy" },
      { ...trace, session_id: "foreign-session" }, { ...trace, turn_id: `${sessionId}:0:${"b".repeat(64)}` }]
      .flatMap((trace) => ["turn_start", "skill_reminder"].map((type) => ({ type, trace, ok: true, response: secret })));
    const tracePath = join(stateHome, "debug", "traces", client, "sessions", sessionId, "events.jsonl");
    const pendingPath = join(stateHome, "adapters", client, "pending.json");
    const raw = records.map((record) => JSON.stringify(record)).join("\n") + "\n";
    await put(tracePath, raw);
    await put(pendingPath, JSON.stringify({ [sessionId]: { turnId: trace.turn_id, transcriptPath: secret, cwd: secret } }));
    const input = { stateHome, client, sessionId, repository: secret };
    const summary = await readBackgroundStartDiagnostic(input);
    assert.deepEqual(summary, { trace: "available", pending: "available", turnStarts: 1, skillReminders: 1,
      pendingMatchesPrompt: true, pendingWorkspaceMatches: true, pendingProjectless: false, jobsDirectory: "present" });
    for (const value of [secret, sessionId, stateHome, hash]) assert.equal(JSON.stringify(summary).includes(value), false);
    assert.equal(await readFile(tracePath, "utf8"), raw);
    await put(pendingPath, JSON.stringify({ [sessionId]: { turnId: trace.turn_id, cwd: "other", workspaceKind: "projectless" } }));
    const changed = await readBackgroundStartDiagnostic(input);
    assert.equal(changed.pendingWorkspaceMatches, false);
    assert.equal(changed.pendingProjectless, true);
    await put(pendingPath, JSON.stringify({ "foreign-session": { turnId: trace.turn_id } }));
    assert.equal((await readBackgroundStartDiagnostic(input)).pendingMatchesPrompt, false);
    assert.equal((await readBackgroundStartDiagnostic(input)).pendingWorkspaceMatches, null);
  }
});

test("background start diagnostics distinguish missing evidence from unavailable identity or files", async (t) => {
  const { stateHome, sessionId, put } = await startDiagnosticFixture(t);
  const input = { stateHome, client: "codebuddy", sessionId };
  assert.deepEqual(await readBackgroundStartDiagnostic(input), { trace: "missing", pending: "missing",
    turnStarts: null, skillReminders: null, pendingMatchesPrompt: null, pendingWorkspaceMatches: null, pendingProjectless: null, jobsDirectory: "missing" });
  const invalid = await readBackgroundStartDiagnostic({ ...input, sessionId: "../PRIVATE_SESSION" });
  assert.equal(invalid.trace, "unavailable");
  assert.equal(invalid.pending, "unavailable");
  await put(join(stateHome, "repo-memory-jobs"), "PRIVATE_NOT_A_DIRECTORY");
  const tracePath = join(stateHome, "debug", "traces", "codebuddy", "sessions", sessionId, "events.jsonl");
  await put(join(stateHome, "adapters", "codebuddy", "pending.json"), "PRIVATE_INVALID_JSON");
  for (const text of ["null\n", "PRIVATE_OVERSIZED_TRACE".repeat(60000)]) {
    await put(tracePath, text);
    assert.deepEqual(await readBackgroundStartDiagnostic(input), { trace: "unavailable", pending: "unavailable",
      turnStarts: null, skillReminders: null, pendingMatchesPrompt: null, pendingWorkspaceMatches: null, pendingProjectless: null, jobsDirectory: "unavailable" });
  }
});

test("background start diagnostics do not treat an unreadable state root as absent evidence", async (t) => {
  const { stateHome, sessionId } = await startDiagnosticFixture(t);
  await rm(stateHome, { recursive: true });
  assert.deepEqual(await readBackgroundStartDiagnostic({ stateHome, client: "codebuddy", sessionId }), {
    trace: "unavailable", pending: "unavailable", turnStarts: null, skillReminders: null,
    pendingMatchesPrompt: null, pendingWorkspaceMatches: null, pendingProjectless: null, jobsDirectory: "unavailable" });
});

test("background Hook failures correlate the client and session and expose only fixed diagnostic fields", () => {
  const secret = "PRIVATE_SESSION_PATH_TOKEN_MESSAGE_CANARY", client = "workbuddy";
  const sessionHash = createHash("sha256").update(secret).digest("hex").slice(0, 24);
  const failure = { source: "client-hook", client, sessionHash, operation: "memory.turn-start",
    errorCode: "HOOK_BACKEND_HTTP_REJECTED", systemCode: "ECONNRESET", httpStatus: 503, error: secret };
  const records = [failure, { ...failure, client: "codebuddy" }, { ...failure, sessionHash: "other" },
    { ...failure, operation: "memory.writeback" }, { ...failure, source: "other" },
    { ...failure, errorCode: secret, systemCode: secret, httpStatus: secret }];
  const history = { ok: true, skipped: 0, records }, original = structuredClone(history);
  const summary = summarizeBackgroundHookFailures(history, { client, sessionId: secret });
  assert.deepEqual(summary, { available: true, incomplete: false, failures: [
    { operation: "memory.turn-start", errorCode: "HOOK_BACKEND_HTTP_REJECTED", systemCode: "ECONNRESET", httpStatus: 503 },
    { operation: "memory.turn-start", errorCode: "other", systemCode: null, httpStatus: null },
  ] });
  for (const value of [secret, sessionHash]) assert.equal(JSON.stringify(summary).includes(value), false);
  assert.deepEqual(history, original);
  assert.equal(summarizeBackgroundHookFailures({ ...history, skipped: 1 }, { client, sessionId: secret }).incomplete, true);
  const bounded = summarizeBackgroundHookFailures({ ...history, records: Array(11).fill(failure) }, { client, sessionId: secret });
  assert.equal(bounded.incomplete, true);
  assert.equal(bounded.failures.length, 10);
  for (const invalid of [undefined, { ok: false }, { ok: true, records: Array(1001).fill(failure) }]) {
    assert.deepEqual(summarizeBackgroundHookFailures(invalid, { client, sessionId: secret }), { available: false });
  }
});

async function startDiagnosticFixture(t) {
  const stateHome = await mkdtemp(join(tmpdir(), "background-diagnostic-"));
  t.after(() => rm(stateHome, { recursive: true, force: true }));
  const put = async (path, text) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, text); };
  return { stateHome, sessionId: "private-session-canary", put };
}
