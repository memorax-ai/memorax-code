import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { check, fixtureModel } from "./codebuddy-native-support.mjs";
import { assertCompleteText } from "../codex/codex-native-content-check.mjs";
import { matchesNativeModel, summarizeWritebackTrace } from "./codebuddy-native-content-check.mjs";

export const workerPromptMarker = "This invocation is the authorized background repo-memory worker.";
export const foregroundPrompt = "Check this repository's global CodeBuddy model configuration.";
export const foregroundAnswer = "FOREGROUND_GLOBAL_SETTINGS_ONLY";
export const backgroundAnswer = "BACKGROUND_GLOBAL_SETTINGS_ONLY";
export const modelEnvironmentOverrides = ["CODEBUDDY_MODEL", "CODEBUDDY_API_KEY", "CODEBUDDY_BASE_URL",
  "CODEBUDDY_SMALL_FAST_MODEL", "CODEBUDDY_BIG_SLOW_MODEL", "CODEBUDDY_CODE_SUBAGENT_MODEL"];

export function foregroundPromptForClient(client = "codebuddy") {
  check(client === "codebuddy" || client === "workbuddy", "NATIVE_CLIENT_INVALID");
  return client === "codebuddy" ? foregroundPrompt : "Check this repository's global WorkBuddy model configuration.";
}

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

export function assertBackgroundJob(job, { jobPath, repository, snapshotHead, codebuddyCommand, pluginRoot, client = "codebuddy" }) {
  check(client === "codebuddy" || client === "workbuddy", "NATIVE_CLIENT_INVALID");
  check(job?.version === 1 && job.runner === client && job.mode === "build" && job.repo === repository
    && job.snapshotHead === snapshotHead && /^[a-f0-9]{40}$/.test(snapshotHead ?? "")
    && job.sharedSnapshot?.head === snapshotHead && job.sharedSnapshot.ref === "refs/remotes/origin/main"
    && job.sharedSnapshot.branch === "main" && job.sharedSnapshot.baseHead === null
    && job.jobId === basename(dirname(jobPath)) && /^[a-f0-9]{32}$/.test(job.runId ?? "")
    && ["preparing", "started", "running", "failed", "succeeded"].includes(job.status), "BACKGROUND_JOB_AUTHORITY_MISMATCH");
  check(typeof job.prompt === "string" && job.prompt.startsWith(workerPromptMarker)
    && JSON.stringify(job.command) === JSON.stringify([codebuddyCommand, "--plugin-dir", pluginRoot,
      "--print", "--output-format", "text", "--dangerously-skip-permissions", "--no-session-persistence", "--effort", "medium", job.prompt]),
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

export function assertBackgroundModelRequests(requests, prompt, { client = "codebuddy" } = {}) {
  const expectedForegroundPrompt = foregroundPromptForClient(client);
  check(Array.isArray(requests) && requests.length === 2 && requests.every((request) => request.method === "POST"
    && request.path === "/v1/chat/completions" && request.body?.model === fixtureModel), "BACKGROUND_MODEL_REQUEST_MISMATCH");
  const worker = requests.filter(({ body }) => backgroundInputText(body).includes(workerPromptMarker));
  const foreground = requests.filter(({ body }) => !backgroundInputText(body).includes(workerPromptMarker));
  check(worker.length === 1 && foreground.length === 1, "BACKGROUND_MODEL_REQUEST_IDENTITY_MISMATCH");
  assertCompleteText(backgroundInputText(worker[0].body), prompt, "BACKGROUND_FULL_JOB_PROMPT_MISSING");
  assertCompleteText(backgroundInputText(foreground[0].body), expectedForegroundPrompt, "BACKGROUND_FOREGROUND_PROMPT_MISSING");
}

export function backgroundProcessesExited(jobs, processPresent, posix = process.platform !== "win32") {
  return jobs.length > 0 && jobs.every((job) => ["failed", "succeeded"].includes(job.status)
    && Number.isSafeInteger(job.workerPid) && job.workerPid > 1
    && Number.isSafeInteger(job.childPid) && job.childPid > 1
    && [job.workerPid, job.childPid].every((pid) => !processPresent(pid) && (!posix || !processPresent(-pid))));
}

export function summarizeBackgroundJobs(validatedJobs, processPresent) {
  check(Array.isArray(validatedJobs), "BACKGROUND_JOB_DIAGNOSTIC_INVALID");
  const reasons = ["snapshot_prepare_failed", "startup_ownership_lost", "worker_start_failed", "worker_interrupted", "codebuddy_timeout", "codebuddy_spawn_failed",
    "codebuddy_exit_nonzero", "workbuddy_timeout", "workbuddy_spawn_failed", "workbuddy_exit_nonzero",
    "final_message_missing", "snapshot_changed", "artifact_validation_failed", "profile_head_mismatch"];
  const jobs = validatedJobs.map((job) => {
    check(["preparing", "started", "running", "failed", "succeeded"].includes(job?.status)
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

export async function readBackgroundStartDiagnostic({ stateHome, client, sessionId, repository }) {
  const summary = { trace: "unavailable", pending: "unavailable", turnStarts: null, skillReminders: null,
    pendingMatchesPrompt: null, pendingWorkspaceMatches: null, pendingProjectless: null, jobsDirectory: "unavailable" };
  let root;
  try { root = await realpath(stateHome); } catch { return summary; }
  const contained = (path) => {
    const value = relative(root, path);
    return value !== ".." && !value.startsWith("../") && !value.startsWith("..\\") && !isAbsolute(value);
  };
  try {
    const path = await realpath(join(root, "repo-memory-jobs"));
    if (contained(path) && (await stat(path)).isDirectory()) summary.jobsDirectory = "present";
  } catch (error) { summary.jobsDirectory = error.code === "ENOENT" ? "missing" : "unavailable"; }
  if (!["codebuddy", "workbuddy"].includes(client) || typeof sessionId !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(sessionId)) return summary;

  const read = async (path, parse) => {
    try {
      const target = await realpath(path), info = await stat(target);
      if (!contained(target) || !info.isFile() || info.size > 1024 * 1024) return { status: "unavailable" };
      return { status: "available", value: parse(await readFile(target, "utf8")) };
    } catch (error) { return { status: error.code === "ENOENT" ? "missing" : "unavailable" }; }
  };
  const record = (text) => {
    const value = JSON.parse(text);
    check(value && typeof value === "object" && !Array.isArray(value), "BACKGROUND_DIAGNOSTIC_RECORD_INVALID");
    return value;
  };
  const trace = await read(join(root, "debug", "traces", client, "sessions", sessionId, "events.jsonl"),
    (text) => text.split(/\r?\n/).filter(Boolean).map(record));
  const pending = await read(join(root, "adapters", client, "pending.json"), record);
  const promptHash = createHash("sha256").update(foregroundPromptForClient(client).trim()).digest("hex");
  const events = trace.value ?? [];
  const hook = summarizeWritebackTrace(events, pending.value, { client, sessionId, promptHash });
  summary.trace = trace.status;
  summary.pending = pending.status;
  if (trace.status === "available") {
    summary.turnStarts = hook.turnStarts;
    // This event is recorded only after the Hook receives turn-start's response.
    summary.skillReminders = events.filter((event) => event.type === "skill_reminder" && event.ok === true
      && event.trace?.client === client && event.trace.session_id === sessionId
      && typeof event.trace.turn_id === "string" && event.trace.turn_id.startsWith(`${sessionId}:`)
      && event.trace.turn_id.endsWith(`:${promptHash}`)).length;
  }
  if (pending.status === "available") {
    summary.pendingMatchesPrompt = hook.pendingMatchesPrompt;
    const current = pending.value[sessionId];
    if (hook.pendingMatchesPrompt) {
      if (typeof repository === "string") summary.pendingWorkspaceMatches = current?.cwd === repository;
      summary.pendingProjectless = current?.workspaceKind === "projectless";
    }
  }
  return summary;
}

export function summarizeBackgroundHookFailures(history, { client, sessionId }) {
  if (history?.ok !== true || !Array.isArray(history.records) || history.records.length > 1000
    || !["codebuddy", "workbuddy"].includes(client) || typeof sessionId !== "string" || !sessionId) return { available: false };
  const sessionHash = createHash("sha256").update(sessionId).digest("hex").slice(0, 24);
  const matches = history.records.filter((entry) => entry?.source === "client-hook"
    && entry.client === client && entry.sessionHash === sessionHash
    && ["hook.runtime", "hook.ensure-backend", "memory.turn-start"].includes(entry.operation));
  const codes = ["HOOK_RUNTIME_FAILED", "HOOK_BACKEND_CONNECTION_INVALID", "HOOK_BACKEND_START_TIMEOUT",
    "HOOK_BACKEND_START_SPAWN_FAILED", "HOOK_BACKEND_START_INTERRUPTED", "HOOK_BACKEND_START_FAILED",
    "HOOK_BACKEND_RECOVERY_FAILED", "HOOK_BACKEND_REQUEST_TIMEOUT", "HOOK_BACKEND_REQUEST_FAILED", "HOOK_BACKEND_HTTP_REJECTED"];
  const systemCodes = ["ENOENT", "ENOEXEC", "EACCES", "EPERM", "ENOSPC", "EROFS", "ENOTDIR", "EISDIR", "EMFILE",
    "ENAMETOOLONG", "ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND"];
  return { available: true, incomplete: history.skipped !== 0 || history.records.length === 1000 || matches.length > 10,
    failures: matches.slice(0, 10).map((entry) => ({ operation: entry.operation,
      errorCode: codes.includes(entry.errorCode) ? entry.errorCode : "other",
      systemCode: systemCodes.includes(entry.systemCode) ? entry.systemCode : null,
      httpStatus: Number.isInteger(entry.httpStatus) && entry.httpStatus >= 100 && entry.httpStatus <= 599 ? entry.httpStatus : null })) };
}
