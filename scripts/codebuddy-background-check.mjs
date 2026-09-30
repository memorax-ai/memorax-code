#!/usr/bin/env node
import { execFile } from "node:child_process";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, delimiter, dirname, isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";
import { check, createNativeHarness, fixtureModel, waitFor } from "./codebuddy-native-support.mjs";
import { selectNativeTurnContent } from "./codebuddy-native-content-check.mjs";
import { assertBackgroundJob, assertBackgroundModelRequests, assertBackgroundNoopResult, assertForegroundResult,
  assertGlobalConfiguration, backgroundInputText, backgroundProcessesExited, modelEnvironmentOverrides,
  summarizeBackgroundJobs, workerPromptMarker, foregroundPrompt, foregroundAnswer, backgroundAnswer,
} from "./codebuddy-background-assertions.mjs";

const execFileAsync = promisify(execFile);
const report = { status: "FAIL", scope: "native_codebuddy_repo_memory_global_configuration", platform: process.platform,
  repoMemoryBuildValidated: false, modelOverrideInheritanceValidated: false, permissionInheritanceValidated: false,
  backgroundNativeSessionIdentityValidated: false, fixtureArtifactsInjected: false, paidModelRequests: 0 };
let harness, repository, pluginRoot, snapshotHead, jobPrompt, stage = "prerequisites", checksCompleted = false;
let foregroundStarted = false, foregroundFinished = false;
const requests = { foreground: 0, background: 0 };

try {
  check(process.argv.length === 5, "EXPECTED_INSTALLED_PACKAGE_CODEBUDDY_PATH_AND_VERSION");
  harness = await createNativeHarness({ packageRoot: process.argv[2], codebuddyCommand: process.argv[3],
    expectedVersion: process.argv[4], label: "background", writeback: false });
  repository = await realpath(harness.workspace);
  harness.setBeforeClose(async () => {
    if (!foregroundStarted) return;
    // The product bounds its detached worker. Do not signal historical PIDs;
    // uncertain shutdown must retain the isolated state for inspection.
    await waitFor(async () => {
      const observed = await jobs();
      return observed.length === 1 && backgroundProcessesExited(observed, processPresent);
    }, "BACKGROUND_PROCESS_CLEANUP_UNVERIFIED", 35_000);
    check(foregroundFinished, "BACKGROUND_FOREGROUND_CLEANUP_UNVERIFIED");
  });
  for (const name of modelEnvironmentOverrides) delete harness.env[name];
  Object.assign(harness.env, { MEMORAX_CODE_REPO_MEMORY_JOB_TIMEOUT_MS: "30000", MEMORAX_CODE_REPO_MEMORY_JOB_KILL_GRACE_MS: "1000",
    GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.multiPackIndex", GIT_CONFIG_VALUE_0: "false" });
  stage = "repository setup";
  const gitName = process.platform === "win32" ? "git.exe" : "git";
  let gitCommand;
  for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(directory, gitName);
    if (await stat(candidate).then((info) => info.isFile(), () => false)) { gitCommand = candidate; break; }
  }
  check(gitCommand, "BACKGROUND_FIXTURE_REQUIRES_GIT");
  harness.env.PATH += `${delimiter}${dirname(gitCommand)}`;
  const git = (args) => execFileAsync(gitCommand, ["-c", "core.multiPackIndex=false", ...args],
    { cwd: repository, env: harness.env, timeout: 10_000, windowsHide: true });
  await git(["init", "--quiet"]);
  await git(["-c", "user.name=Native Fixture", "-c", "user.email=native@example.invalid", "commit", "--allow-empty",
    "--no-gpg-sign", "--quiet", "-m", "test: native global configuration fixture"]);
  snapshotHead = (await git(["rev-parse", "HEAD"])).stdout.trim();

  stage = "installed plugin and global configuration";
  const status = await harness.setup();
  check(status.codebuddyAdapter?.codebuddyHooks?.configured === true
    && status.codebuddyAdapter.codebuddySkills?.ok === true, "BACKGROUND_PLUGIN_NOT_CONFIGURED");
  pluginRoot = await realpath(join(dirname(status.codebuddyAdapter.codebuddySkills.path), "../.."));
  check(within(await realpath(harness.codebuddyHome), pluginRoot), "BACKGROUND_PLUGIN_PATH_OUTSIDE_HOME");
  assertGlobalConfiguration(harness.env,
    JSON.parse(await readFile(join(harness.codebuddyHome, "settings.json"), "utf8")),
    JSON.parse(await readFile(join(harness.codebuddyHome, "models.json"), "utf8")), harness.modelUrl);
  check(harness.modelRequests.length === 0 && harness.memoryRequests.length === 0, "BACKGROUND_SETUP_MADE_REQUESTS");
  harness.setModelHandler((body) => {
    const kind = backgroundInputText(body).includes(workerPromptMarker) ? "background" : "foreground";
    requests[kind]++;
    check(requests[kind] === 1, "UNEXPECTED_BACKGROUND_MODEL_CONTINUATION");
    return { text: kind === "background" ? backgroundAnswer : foregroundAnswer };
  });
  stage = "native foreground without model overrides";
  foregroundStarted = true;
  const output = await harness.runCodeBuddy(["-p", foregroundPrompt, "--output-format", "stream-json", "--verbose",
    "--permission-mode", "dontAsk", "--setting-sources", "user", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}']);
  foregroundFinished = true;
  const init = assertForegroundResult(output.stdout.trim().split(/\r?\n/).filter(Boolean).map(JSON.parse));
  check(typeof init.cwd === "string" && await realpath(init.cwd) === repository, "BACKGROUND_NATIVE_WORKSPACE_MISMATCH");
  stage = "native foreground transcript";
  await waitFor(async () => {
    const files = (await readdir(harness.codebuddyHome, { recursive: true }))
      .filter((file) => basename(file) === `${init.session_id}.jsonl`);
    check(files.length <= 1, "BACKGROUND_FOREGROUND_TRANSCRIPT_NOT_UNIQUE");
    if (!files.length) return false;
    const transcriptPath = await realpath(join(harness.codebuddyHome, files[0]));
    check(within(await realpath(harness.codebuddyHome), transcriptPath), "BACKGROUND_TRANSCRIPT_PATH_OUTSIDE_HOME");
    const records = (await readFile(transcriptPath, "utf8")).split(/\r?\n/).filter(Boolean).map(JSON.parse);
    if (!records.some((record) => record.type === "message" && record.role === "assistant" && record.status === "completed")) return false;
    selectNativeTurnContent(records, { sessionId: init.session_id, prompt: foregroundPrompt, finalText: foregroundAnswer });
    return true;
  }, "BACKGROUND_FOREGROUND_TRANSCRIPT_MISSING");
  stage = "background worker result";
  const [job] = await waitFor(async () => {
    const observed = await jobs();
    check(observed.length <= 1, "BACKGROUND_JOB_NOT_UNIQUE");
    return observed.length === 1 && ["failed", "succeeded"].includes(observed[0].status) ? observed : false;
  }, "BACKGROUND_JOB_DID_NOT_FINISH", 45_000);
  jobPrompt = job.prompt;
  const finalMessagePath = await realpath(job.finalMessagePath);
  check(within(await realpath(harness.stateHome), finalMessagePath), "BACKGROUND_OUTPUT_PATH_OUTSIDE_HOME");
  assertBackgroundNoopResult(job, await readFile(finalMessagePath, "utf8"));
  assertBackgroundModelRequests(harness.modelRequests, jobPrompt);
  check(harness.memoryRequests.length === 0 && harness.serverErrors.length === 0, "BACKGROUND_UNEXPECTED_RECEIVER_ACTIVITY");
  check(await stat(join(repository, ".repo_memory", "PROFILE.md")).then(() => false,
    (error) => { if (error.code === "ENOENT") return true; throw error; }), "BACKGROUND_UNEXPECTED_PROFILE_ARTIFACT");
  stage = "detached process exit";
  await waitFor(() => backgroundProcessesExited([job], processPresent), "BACKGROUND_PROCESS_REMAINS");
  Object.assign(report, { codebuddyVersion: harness.codebuddyVersion, model: fixtureModel, provider: "local_openai_chat_completions",
    globalSettingsOnly: true, foregroundNativeTranscriptValidated: true, backgroundOutputSource: "native CodeBuddy stdout",
    jobStatus: "failed", expectedFailure: "artifact_validation_failed" });
  checksCompleted = true;
} catch (error) {
  Object.assign(report, { stage, error: error.nativeCode ?? "BACKGROUND_CHECK_FAILED_PRIVATE_OUTPUT_SUPPRESSED" });
  try {
    // jobs() validates installation, repository, command and output authority
    // before the diagnostic can probe or summarize any recorded process.
    report.backgroundJobs = { available: true, ...summarizeBackgroundJobs(await jobs(), processPresent) };
  } catch { report.backgroundJobs = { available: false }; }
} finally {
  try { await harness?.close(); report.cleanup = "PASS"; }
  catch (error) { report.cleanup = error.nativeCode ?? "BACKGROUND_CLEANUP_FAILED"; }
}
if (checksCompleted && report.cleanup === "PASS") {
  try {
    assertBackgroundModelRequests(harness.modelRequests, jobPrompt);
    check(harness.memoryRequests.length === 0 && harness.serverErrors.length === 0, "BACKGROUND_UNEXPECTED_RECEIVER_ACTIVITY");
    report.status = "PASS";
  } catch (error) {
    Object.assign(report, { stage: "final receiver audit after cleanup", error: error.nativeCode ?? "BACKGROUND_FINAL_AUDIT_FAILED" });
  }
}
Object.assign(report, { foregroundRequests: requests.foreground, backgroundRequests: requests.background,
  modelRequests: harness?.modelRequests.length ?? 0, memoryRequests: harness?.memoryRequests.length ?? 0,
  receiverErrors: harness?.serverErrors ?? [] });
console.log(JSON.stringify(report, null, 2));
if (report.status !== "PASS") process.exitCode = 1;

async function jobs() {
  const jobsRoot = join(harness.stateHome, "repo-memory-jobs");
  const files = await readdir(jobsRoot, { recursive: true }).catch((error) => {
    if (error.code === "ENOENT") return []; throw error;
  });
  const entries = [];
  for (const file of files.filter((file) => basename(file) === "job.json")) {
    const jobPath = join(jobsRoot, file);
    check(within(await realpath(jobsRoot), await realpath(jobPath)), "BACKGROUND_JOB_PATH_OUTSIDE_HOME");
    const job = JSON.parse(await readFile(jobPath, "utf8"));
    assertBackgroundJob(job, { jobPath, repository, snapshotHead, codebuddyCommand: harness.codebuddyCommand, pluginRoot });
    entries.push(job);
  }
  return entries;
}
function processPresent(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; if (error.code === "EPERM") return true; throw error; }
}
function within(parent, child) {
  const path = relative(parent, child);
  return path !== ".." && !path.startsWith("../") && !path.startsWith("..\\") && !isAbsolute(path);
}
