import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fixtureModel } from "./codebuddy-native-support.mjs";
import { assertBackgroundJob, assertBackgroundModelRequests, assertBackgroundNoopResult, assertForegroundResult,
  assertGlobalConfiguration, backgroundInputText, backgroundProcessesExited, modelEnvironmentOverrides,
  workerPromptMarker, foregroundPrompt, foregroundAnswer, backgroundAnswer,
} from "./codebuddy-background-assertions.mjs";

const context = { jobPath: resolve("fixture/jobs/job-fixture/job.json"), repository: resolve("fixture/repo"),
  codebuddyCommand: resolve("fixture/bin/codebuddy"), pluginRoot: resolve("fixture/plugin"), snapshotHead: "b".repeat(40) };
const prompt = `${workerPromptMarker}\n\nPreserve the full synthetic worker prompt.\n\nLast paragraph.`;
const job = () => ({ version: 1, jobId: "job-fixture", runId: "a".repeat(32), runner: "codebuddy", mode: "build",
  repo: context.repository, snapshotHead: context.snapshotHead, status: "failed", failureReason: "artifact_validation_failed",
  exitCode: 0, validationExitCode: 1, command: [context.codebuddyCommand, "--plugin-dir", context.pluginRoot,
    "--print", "--output-format", "text", "--dangerously-skip-permissions", "--no-session-persistence", prompt],
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

test("CodeBuddy background assertion errors never disclose private native content or paths", () => {
  const privateText = "PRIVATE_NATIVE_OUTPUT_AND_PATH_CANARY";
  for (const run of [() => assertBackgroundJob({ ...job(), repo: privateText }, context),
    () => assertBackgroundJob({ ...job(), finalMessagePath: privateText }, context),
    () => assertBackgroundNoopResult(job(), privateText), () => assertForegroundResult([events()[0], { ...events()[1], result: privateText }])]) {
    assert.throws(run, (error) => error.message === error.nativeCode && !error.stack.includes(privateText));
  }
});
