import { basename, dirname, join } from "node:path";
import { check, fixtureModel } from "./codebuddy-native-support.mjs";
import { assertCompleteText } from "./codex-native-content-check.mjs";
import { matchesNativeModel } from "./codebuddy-native-content-check.mjs";

export const workerPromptMarker = "This invocation is the authorized background repo-memory worker.";
export const foregroundPrompt = "Check this repository's global CodeBuddy model configuration.";
export const foregroundAnswer = "FOREGROUND_GLOBAL_SETTINGS_ONLY";
export const backgroundAnswer = "BACKGROUND_GLOBAL_SETTINGS_ONLY";
export const modelEnvironmentOverrides = ["CODEBUDDY_MODEL", "CODEBUDDY_API_KEY", "CODEBUDDY_BASE_URL",
  "CODEBUDDY_SMALL_FAST_MODEL", "CODEBUDDY_BIG_SLOW_MODEL", "CODEBUDDY_CODE_SUBAGENT_MODEL"];

export function assertGlobalConfiguration(env, settings, models, modelUrl) {
  check(modelEnvironmentOverrides.every((name) => env[name] === undefined), "BACKGROUND_PROCESS_MODEL_OVERRIDE_PRESENT");
  check(settings?.model === fixtureModel && settings.env?.CODEBUDDY_BASE_URL === modelUrl
    && settings.env.CODEBUDDY_API_KEY === "native-model-fixture", "BACKGROUND_GLOBAL_SETTINGS_MISMATCH");
  check(Array.isArray(models?.models) && models.models.length === 1 && models.models[0]?.id === fixtureModel
    && models.models[0].vendor === "OpenAI" && models.models[0].url === `${modelUrl}/v1/chat/completions`
    && models.models[0].apiKey === "native-model-fixture"
    && JSON.stringify(models.availableModels) === JSON.stringify([fixtureModel]), "BACKGROUND_GLOBAL_MODEL_MISMATCH");
}

export function backgroundInputText(body) {
  if (!Array.isArray(body?.messages)) return "";
  return body.messages.filter((message) => message?.role === "user").flatMap(({ content }) =>
    typeof content === "string" ? [content] : Array.isArray(content)
      ? content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text) : []).join("\n");
}

export function assertForegroundResult(events) {
  check(Array.isArray(events), "BACKGROUND_FOREGROUND_EVENTS_INVALID");
  const init = events.filter((event) => event?.type === "system" && event.subtype === "init");
  const completed = events.filter((event) => event?.type === "result");
  check(init.length > 0 && typeof init[0].session_id === "string" && init[0].session_id.length > 0
    && init.every((event) => event.session_id === init[0].session_id && matchesNativeModel(event.model, fixtureModel)
      && event.permissionMode === "dontAsk") && completed.length === 1 && completed[0].session_id === init[0].session_id
    && completed[0].subtype === "success" && completed[0].is_error === false && completed[0].terminal_reason === undefined
    && completed[0].result === foregroundAnswer, "BACKGROUND_FOREGROUND_CONFIGURATION_MISMATCH");
  return init[0];
}

export function assertBackgroundJob(job, { jobPath, repository, snapshotHead, codebuddyCommand, pluginRoot }) {
  check(job?.version === 1 && job.runner === "codebuddy" && job.mode === "build" && job.repo === repository
    && job.snapshotHead === snapshotHead && /^[a-f0-9]{40}$/.test(snapshotHead ?? "")
    && job.jobId === basename(dirname(jobPath)) && /^[a-f0-9]{32}$/.test(job.runId ?? "")
    && ["started", "running", "failed", "succeeded"].includes(job.status), "BACKGROUND_JOB_AUTHORITY_MISMATCH");
  check(typeof job.prompt === "string" && job.prompt.startsWith(workerPromptMarker)
    && JSON.stringify(job.command) === JSON.stringify([codebuddyCommand, "--plugin-dir", pluginRoot,
      "--print", "--output-format", "text", "--dangerously-skip-permissions", "--no-session-persistence", job.prompt]),
  "BACKGROUND_JOB_COMMAND_MISMATCH");
  check(job.finalMessageSource === "stdout" && job.finalMessagePath === join(dirname(jobPath), "final-message.txt")
    && job.outputLogPath === join(dirname(jobPath), "output.log"), "BACKGROUND_JOB_OUTPUT_AUTHORITY_MISMATCH");
  for (const key of ["pid", "workerPid", "childPid"]) {
    check(job[key] === undefined || (Number.isSafeInteger(job[key]) && job[key] > 1), "BACKGROUND_JOB_PID_INVALID");
  }
  check(job.pid === job.workerPid && (job.childPid === undefined || job.childPid !== job.workerPid), "BACKGROUND_JOB_PID_INVALID");
}

export function assertBackgroundNoopResult(job, finalOutput) {
  check(job?.status === "failed" && job.failureReason === "artifact_validation_failed" && job.exitCode === 0
    && Number.isInteger(job.validationExitCode) && job.validationExitCode > 0, "BACKGROUND_NOOP_JOB_RESULT_MISMATCH");
  check(Number.isSafeInteger(job.workerPid) && job.workerPid > 1
    && Number.isSafeInteger(job.childPid) && job.childPid > 1, "BACKGROUND_JOB_PID_MISSING");
  check(typeof finalOutput === "string" && finalOutput.trim() === backgroundAnswer, "BACKGROUND_NATIVE_STDOUT_MISMATCH");
}

export function assertBackgroundModelRequests(requests, prompt) {
  check(Array.isArray(requests) && requests.length === 2 && requests.every((request) => request.method === "POST"
    && request.path === "/v1/chat/completions" && request.body?.model === fixtureModel), "BACKGROUND_MODEL_REQUEST_MISMATCH");
  const worker = requests.filter(({ body }) => backgroundInputText(body).includes(workerPromptMarker));
  const foreground = requests.filter(({ body }) => !backgroundInputText(body).includes(workerPromptMarker));
  check(worker.length === 1 && foreground.length === 1, "BACKGROUND_MODEL_REQUEST_IDENTITY_MISMATCH");
  assertCompleteText(backgroundInputText(worker[0].body), prompt, "BACKGROUND_FULL_JOB_PROMPT_MISSING");
  assertCompleteText(backgroundInputText(foreground[0].body), foregroundPrompt, "BACKGROUND_FOREGROUND_PROMPT_MISSING");
}

export function backgroundProcessesExited(jobs, processPresent, posix = process.platform !== "win32") {
  return jobs.length > 0 && jobs.every((job) => ["failed", "succeeded"].includes(job.status)
    && Number.isSafeInteger(job.workerPid) && job.workerPid > 1
    && Number.isSafeInteger(job.childPid) && job.childPid > 1
    && [job.workerPid, job.childPid].every((pid) => !processPresent(pid) && (!posix || !processPresent(-pid))));
}

export function summarizeBackgroundJobs(validatedJobs, processPresent) {
  check(Array.isArray(validatedJobs), "BACKGROUND_JOB_DIAGNOSTIC_INVALID");
  const reasons = ["worker_start_failed", "worker_interrupted", "codebuddy_timeout", "codebuddy_spawn_failed",
    "codebuddy_exit_nonzero", "final_message_missing", "snapshot_changed", "artifact_validation_failed", "profile_head_mismatch"];
  const jobs = validatedJobs.map((job) => {
    check(["started", "running", "failed", "succeeded"].includes(job?.status)
      && [job.workerPid, job.childPid].every((pid) => pid === undefined || Number.isSafeInteger(pid) && pid > 1),
    "BACKGROUND_JOB_DIAGNOSTIC_INVALID");
    return { status: job.status,
      failureReason: job.failureReason === undefined ? "missing" : reasons.includes(job.failureReason) ? job.failureReason : "other",
      exitCode: Number.isSafeInteger(job.exitCode) && Math.abs(job.exitCode) <= 0xffffffff ? job.exitCode : null,
      workerPidPresent: job.workerPid !== undefined,
      workerAlive: job.workerPid !== undefined && Boolean(processPresent(job.workerPid)),
      childPidPresent: job.childPid !== undefined,
      childAlive: job.childPid !== undefined && Boolean(processPresent(job.childPid)) };
  });
  return { jobCount: jobs.length, jobs };
}
