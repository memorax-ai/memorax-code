import { basename, dirname, join } from "node:path";
import { check, fixtureModel } from "./claude-native-support.mjs";
import { assertCompleteText } from "../codex/codex-native-content-check.mjs";

export const workerPromptMarker = "This invocation is the authorized background repo-memory worker.";
export const foregroundPrompt = "Check the repository's global Claude model configuration.";
export const foregroundAnswer = "FOREGROUND_GLOBAL_SETTINGS_ONLY";
export const backgroundAnswer = "BACKGROUND_GLOBAL_SETTINGS_ONLY";

export function backgroundInputText(body) {
  const text = [];
  const visit = (value) => {
    if (typeof value === "string") text.push(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") Object.values(value).forEach(visit);
  };
  visit(body?.system);
  visit(body?.messages);
  return text.join("\n");
}

export function assertBackgroundJob(job, { jobPath, repository, snapshotHead, claudeCommand }) {
  check(job?.version === 1 && job.runner === "claude" && job.mode === "build" && job.repo === repository
    && job.snapshotHead === snapshotHead && /^[a-f0-9]{40}$/.test(snapshotHead ?? "")
    && job.sharedSnapshot?.head === snapshotHead && job.sharedSnapshot.ref === "refs/remotes/origin/main"
    && job.sharedSnapshot.branch === "main" && job.sharedSnapshot.baseHead === null
    && job.jobId === basename(dirname(jobPath)) && /^[a-f0-9]{32}$/.test(job.runId ?? "")
    && ["preparing", "started", "running", "failed", "succeeded"].includes(job.status), "BACKGROUND_JOB_AUTHORITY_MISMATCH");
  check(typeof job.prompt === "string" && job.prompt.startsWith(workerPromptMarker)
    && JSON.stringify(job.command) === JSON.stringify([claudeCommand, "--print", "--output-format", "text",
      "--dangerously-skip-permissions", "--no-session-persistence", job.prompt]), "BACKGROUND_JOB_COMMAND_MISMATCH");
  check(job.finalMessageSource === "stdout" && job.finalMessagePath === join(dirname(jobPath), "final-message.txt")
    && job.outputLogPath === join(dirname(jobPath), "output.log"), "BACKGROUND_JOB_OUTPUT_AUTHORITY_MISMATCH");
  for (const key of ["pid", "workerPid", "childPid"]) {
    check(job[key] === undefined || (Number.isSafeInteger(job[key]) && job[key] > 1), "BACKGROUND_JOB_PID_INVALID");
  }
  check(job.pid === job.workerPid && (job.childPid === undefined || job.childPid !== job.workerPid),
    "BACKGROUND_JOB_PID_INVALID");
}

export function assertBackgroundNoopResult(job, finalOutput) {
  check(job.status === "failed" && job.failureReason === "artifact_validation_failed" && job.exitCode === 0
    && Number.isInteger(job.validationExitCode) && job.validationExitCode > 0,
  "BACKGROUND_NOOP_JOB_RESULT_MISMATCH");
  check(Number.isSafeInteger(job.workerPid) && job.workerPid > 1
    && Number.isSafeInteger(job.childPid) && job.childPid > 1, "BACKGROUND_JOB_PID_MISSING");
  check(typeof finalOutput === "string" && finalOutput.trim() === backgroundAnswer, "BACKGROUND_NATIVE_STDOUT_MISMATCH");
}

export function assertBackgroundModelRequests(requests, prompt) {
  check(requests.length === 2 && requests.every((request) => request.method === "POST"
    && request.path === "/v1/messages" && request.body?.model === fixtureModel), "BACKGROUND_MODEL_REQUEST_MISMATCH");
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
    && [job.workerPid, job.childPid]
      .every((pid) => !processPresent(pid) && (!posix || !processPresent(-pid))));
}
