#!/usr/bin/env node
import { execFile } from "node:child_process";
import { appendFile, readFile, readdir, realpath, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { assertCompleteText, selectNativeTurnContent } from "./codex-native-content-check.mjs";
import { check, createNativeHarness, sendResponses, stopNativeProcessTree, waitFor } from "./codex-native-support.mjs";

// Usage: node scripts/codex-model-inheritance-check.mjs <installed-package-root> <codex-cli-path>
// Each case must fail if a worker ignores the foreground override. A no-op model
// response deliberately avoids testing Repo Memory generation in this suite.
const defaults = { model: "gpt-5.4", provider: "local_native", endpoint: "default" };
const cases = [
  { id: "model-override", expected: { ...defaults, model: "gpt-5.4-mini" },
    args: ["--model", "gpt-5.4-mini"], failure: "MODEL_OVERRIDE_NOT_INHERITED" },
  { id: "provider-override", expected: { ...defaults, provider: "local_override", endpoint: "override" },
    args: ["-c", 'model_provider="local_override"'], failure: "PROVIDER_OVERRIDE_NOT_INHERITED" },
];
const report = { status: "FAIL", suite: "native_codex_model_inheritance", platform: process.platform,
  paidModelRequests: 0, scope: "Foreground session model and provider overrides reach the actual Repo Memory worker",
  excludes: ["Repo Memory bundle generation", "background permission inheritance"], cases: [] };

if (process.argv.length !== 4) {
  report.error = "EXPECTED_INSTALLED_PACKAGE_ROOT_AND_CODEX_CLI_PATH";
} else {
  for (const test of cases) report.cases.push(await runCase(test));
  if (report.cases.every((result) => result.status === "PASS")) report.status = "PASS";
}
console.log(JSON.stringify(report, null, 2));
if (report.status !== "PASS") process.exitCode = 1;

async function runCase(test) {
  const result = { id: test.id, status: "FAIL", configuredDefaults: defaults, expected: test.expected };
  let harness, overrideServer;
  const ownedPids = new Set(), requests = [], receiverErrors = [];
  let stage = "prerequisites";
  async function jobs() {
    const root = join(harness.stateHome, "repo-memory-jobs");
    const paths = await readdir(root, { recursive: true }).catch((error) => {
      if (error.code === "ENOENT") return []; throw error;
    });
    const found = [];
    for (const path of paths.filter((path) => basename(path) === "job.json")) {
      const job = JSON.parse(await readFile(join(root, path), "utf8"));
      check(job.repo === await realpath(harness.workspace) && job.runner === "codex", "INHERITANCE_JOB_AUTHORITY_MISMATCH");
      for (const pid of [job.workerPid, job.childPid]) if (Number.isInteger(pid) && pid > 0) ownedPids.add(pid);
      found.push(job);
    }
    return found;
  }
  function respond(body, response, endpoint) {
    requests.push({ endpoint, model: body.model,
      kind: JSON.stringify(body.input ?? []).includes("This invocation is the authorized background repo-memory worker.") ? "background" : "foreground" });
    // Record routing differences without throwing in the HTTP handler. Report
    // the real expected/actual values only after the worker has terminated.
    sendResponses(response, { output: [{ type: "message", role: "assistant", phase: "final_answer",
      content: [{ type: "output_text", text: "INHERITANCE_CHECK_NOOP_RESPONSE" }] }] });
  }
  try {
    harness = await createNativeHarness({ packageRoot: resolve(process.argv[2]), codexCommand: resolve(process.argv[3]),
      label: `inheritance-${test.id}`, writeback: false });
    stage = "isolated repository setup";
    const gitName = process.platform === "win32" ? "git.exe" : "git";
    let gitCommand;
    for (const path of (process.env.PATH ?? "").split(delimiter).filter(Boolean).map((path) => join(path, gitName))) {
      if (await stat(path).then((info) => info.isFile(), () => false)) { gitCommand = path; break; }
    }
    check(gitCommand, "INHERITANCE_FIXTURE_REQUIRES_GIT");
    harness.env.PATH += `${delimiter}${dirname(gitCommand)}`;
    Object.assign(harness.env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(harness.home, "missing-git-config"),
      MEMORAX_CODE_REPO_MEMORY_JOB_TIMEOUT_MS: "20000", MEMORAX_CODE_REPO_MEMORY_JOB_KILL_GRACE_MS: "1000" });
    const git = (args) => promisify(execFile)(gitCommand, args, { cwd: harness.workspace, env: harness.env, timeout: 10000, windowsHide: true });
    await git(["init", "--quiet"]);
    await git(["-c", "user.name=Inheritance Fixture", "-c", "user.email=inheritance@example.invalid", "commit",
      "--allow-empty", "--no-gpg-sign", "--quiet", "-m", "test: native override inheritance fixture"]);
    if (test.id === "provider-override") {
      overrideServer = createServer((request, response) => {
        (async () => {
          check(request.method === "POST" && request.url === "/responses", "OVERRIDE_PROVIDER_REQUEST_MISMATCH");
          let text = "";
          for await (const chunk of request) { text += chunk; check(text.length <= 2 * 1024 * 1024, "OVERRIDE_PROVIDER_REQUEST_TOO_LARGE"); }
          respond(JSON.parse(text), response, "override");
        })().catch((error) => {
          receiverErrors.push(error.nativeCode ?? "OVERRIDE_PROVIDER_RECEIVER_FAILED");
          if (!response.headersSent) response.writeHead(500);
          response.end();
        });
      });
      await new Promise((done, reject) => { overrideServer.once("error", reject); overrideServer.listen(0, "127.0.0.1", done); });
      await appendFile(join(harness.codexHome, "config.toml"), ["", "[model_providers.local_override]",
        'name = "Local override test"', `base_url = "http://127.0.0.1:${overrideServer.address().port}"`,
        'wire_api = "responses"', 'env_key = "NATIVE_MODEL_KEY"', "requires_openai_auth = false",
        "supports_websockets = false", "request_max_retries = 0", "stream_max_retries = 0", "stream_idle_timeout_ms = 15000", ""].join("\n"));
    }
    harness.setModelHandler((body, response) => respond(body, response, "default"));
    await harness.setup();
    result.codexVersion = harness.codexVersion;
    stage = "foreground override and native worker";
    const output = await harness.runCodex(["exec", "--strict-config", "--ignore-rules", "--json", ...test.args,
      `Check the isolated repository ${test.id} inheritance fixture.`]);
    const events = output.stdout.trim().split(/\r?\n/).map(JSON.parse);
    const foregroundId = events.find((event) => event.type === "thread.started")?.thread_id;
    check(foregroundId && events.some((event) => event.type === "turn.completed")
      && !events.some((event) => ["error", "turn.failed"].includes(event.type)), "INHERITANCE_FOREGROUND_TURN_FAILED");
    await waitFor(async () => {
      const found = await jobs();
      return found.length === 1 && ["failed", "succeeded"].includes(found[0].status);
    }, "INHERITANCE_WORKER_DID_NOT_FINISH", 40000);
    const [job] = await jobs();
    result.workerJob = { status: job.status, failureReason: job.failureReason, exitCode: job.exitCode };
    check(job.status === "failed" && job.failureReason === "artifact_validation_failed" && job.exitCode === 0,
      "INHERITANCE_NOOP_JOB_RESULT_MISMATCH");
    check(typeof job.prompt === "string" && job.prompt === job.command?.at(-1), "INHERITANCE_JOB_PROMPT_MISSING");
    await waitFor(() => [...ownedPids].every((pid) => !alive(pid)), "INHERITANCE_WORKER_PROCESS_REMAINS");
    stage = "native request and rollout evidence";
    const paths = (await readdir(join(harness.codexHome, "sessions"), { recursive: true })).filter((path) => path.endsWith(".jsonl"));
    check(paths.length === 2, "INHERITANCE_NATIVE_SESSION_COUNT_MISMATCH");
    const native = {};
    for (const path of paths) {
      const records = (await readFile(join(harness.codexHome, "sessions", path), "utf8")).trim().split(/\r?\n/).map(JSON.parse);
      const metadata = records.find((record) => record.type === "session_meta")?.payload;
      check(metadata?.cli_version === harness.codexVersion && typeof metadata.id === "string", "INHERITANCE_NATIVE_METADATA_MISMATCH");
      const kind = metadata.id === foregroundId ? "foreground" : "background";
      check(!native[kind], "INHERITANCE_NATIVE_SESSION_IDENTITY_MISMATCH");
      const starts = records.filter((record) => record.type === "event_msg" && record.payload.type === "task_started");
      const contexts = records.filter((record) => record.type === "turn_context");
      check(starts.length === 1 && contexts.length > 0, "INHERITANCE_NATIVE_TURN_MISSING");
      for (const { payload } of contexts) check(payload.turn_id === starts[0].payload.turn_id
        && await realpath(payload.cwd) === await realpath(harness.workspace), "INHERITANCE_NATIVE_CONTEXT_MISMATCH");
      const selected = selectNativeTurnContent(records, { sessionId: metadata.id, turnId: starts[0].payload.turn_id });
      if (kind === "background") assertCompleteText(selected.user.content, job.prompt, "INHERITANCE_NATIVE_WORKER_PROMPT_INCOMPLETE");
      const models = [...new Set(contexts.map(({ payload }) => payload.model))];
      check(models.length === 1, "INHERITANCE_NATIVE_MODEL_CHANGED_WITHIN_TURN");
      native[kind] = { model: models[0], provider: metadata.model_provider };
    }
    check(native.foreground && native.background, "INHERITANCE_NATIVE_SESSION_IDENTITY_MISMATCH");
    const actual = {};
    for (const kind of ["foreground", "background"]) {
      const received = requests.filter((request) => request.kind === kind);
      check(received.length === 1, "INHERITANCE_MODEL_REQUEST_COUNT_MISMATCH");
      check(received[0].model === native[kind].model, "INHERITANCE_HTTP_NATIVE_MODEL_MISMATCH");
      actual[kind] = { ...native[kind], endpoint: received[0].endpoint };
    }
    result.actual = Object.fromEntries(Object.entries(actual).map(([kind, value]) => [kind, safeValues(value)]));
    result.observedModelHttpRequests = requests.length;
    result.observedMemoryHttpRequests = harness.memoryRequests.length;
    check(harness.memoryRequests.length === 0 && harness.serverErrors.length === 0 && receiverErrors.length === 0,
      "INHERITANCE_UNEXPECTED_RECEIVER_ACTIVITY");
    check(equal(actual.foreground, test.expected), "INHERITANCE_FOREGROUND_OVERRIDE_NOT_APPLIED");
    stage = "foreground override inheritance assertion";
    check(equal(actual.background, test.expected), test.failure);
    result.status = "PASS";
  } catch (error) {
    result.stage = stage;
    result.error = error.nativeCode ?? "INHERITANCE_CHECK_FAILED_PRIVATE_OUTPUT_SUPPRESSED";
  } finally {
    try {
      if (harness) {
        await jobs().catch(() => {});
        for (const pid of ownedPids) if (alive(pid)) await stopNativeProcessTree({ pid, kill: () => process.kill(pid, "SIGKILL") }, harness.env);
        await harness.close();
      }
      result.cleanup = "PASS";
    } catch (error) { result.status = "FAIL"; result.cleanup = error.nativeCode ?? "INHERITANCE_CLEANUP_FAILED"; }
    if (overrideServer) {
      overrideServer.closeAllConnections();
      await new Promise((done) => overrideServer.close(done));
    }
  }
  return result;
}

function equal(actual, expected) { return ["model", "provider", "endpoint"].every((key) => actual[key] === expected[key]); }
function safeValues(value) {
  const allowed = { model: ["gpt-5.4", "gpt-5.4-mini"], provider: ["local_native", "local_override"], endpoint: ["default", "override"] };
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, allowed[key].includes(item) ? item : "unexpected"]));
}
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; }
}
