import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fixtureModel } from "./claude-native-support.mjs";
import { assertBackgroundJob, assertBackgroundModelRequests, assertBackgroundNoopResult, backgroundInputText,
  backgroundProcessesExited, workerPromptMarker, foregroundPrompt, backgroundAnswer,
} from "./claude-background-assertions.mjs";

const context = { jobPath: resolve("fixture/jobs/job-fixture/job.json"), repository: resolve("fixture/repo"),
  claudeCommand: resolve("fixture/bin/claude"), snapshotHead: "b".repeat(40) };
const prompt = `${workerPromptMarker}\n\nComplete the entire synthetic job prompt.\n`;
const job = () => ({ version: 1, jobId: "job-fixture", runId: "a".repeat(32), runner: "claude", mode: "build",
  repo: context.repository, snapshotHead: context.snapshotHead, status: "failed", failureReason: "artifact_validation_failed", exitCode: 0, validationExitCode: 1,
  command: [context.claudeCommand, "--print", "--output-format", "text", "--dangerously-skip-permissions", "--no-session-persistence", prompt],
  sharedSnapshot: { ref: "refs/remotes/origin/main", branch: "main", head: context.snapshotHead, baseHead: null },
  prompt, finalMessageSource: "stdout", finalMessagePath: join(dirname(context.jobPath), "final-message.txt"),
  outputLogPath: join(dirname(context.jobPath), "output.log"), pid: 12345, workerPid: 12345, childPid: 12346 });
const request = (text) => ({ method: "POST", path: "/v1/messages", body: { model: fixtureModel,
  messages: [{ role: "user", content: [{ type: "text", text }] }] } });

test("Claude background job preserves its native launcher and isolated output authority", () => {
  assertBackgroundJob(job(), context);
  assertBackgroundJob({ ...job(), status: "started", pid: undefined, workerPid: undefined, childPid: undefined }, context);
  for (const change of [{ runner: "codex" }, { repo: "private-unowned-repo" }, { jobId: "different" },
    { runId: "invalid" }, { status: "unknown" }, { mode: "update" }]) {
    assert.throws(() => assertBackgroundJob({ ...job(), ...change }, context), { nativeCode: "BACKGROUND_JOB_AUTHORITY_MISMATCH" });
  }
});

test("Claude background job rejects added model overrides, altered persistence and foreign output paths", () => {
  for (const command of [[...job().command, "--model", "other"], job().command.filter((part) => part !== "--no-session-persistence"),
    ["different-client", ...job().command.slice(1)]]) {
    assert.throws(() => assertBackgroundJob({ ...job(), command }, context), { nativeCode: "BACKGROUND_JOB_COMMAND_MISMATCH" });
  }
  for (const change of [{ finalMessageSource: "file" }, { finalMessagePath: "private-output" }, { outputLogPath: "private-log" }]) {
    assert.throws(() => assertBackgroundJob({ ...job(), ...change }, context), { nativeCode: "BACKGROUND_JOB_OUTPUT_AUTHORITY_MISMATCH" });
  }
});

test("Claude background job rejects malformed process identities", () => {
  for (const change of [{ pid: -1 }, { workerPid: 0 }, { childPid: "12346" }, { childPid: 12345 }, { workerPid: 99 }]) {
    assert.throws(() => assertBackgroundJob({ ...job(), ...change }, context), { nativeCode: "BACKGROUND_JOB_PID_INVALID" });
  }
});

test("Claude noop worker must finish natively before the real artifact validator rejects it", () => {
  assertBackgroundNoopResult(job(), `${backgroundAnswer}\n`);
  for (const change of [{ status: "succeeded" }, { failureReason: "claude_exit_nonzero" }, { exitCode: 1 },
    { validationExitCode: 0 }, { validationExitCode: undefined }]) {
    assert.throws(() => assertBackgroundNoopResult({ ...job(), ...change }, backgroundAnswer),
      { nativeCode: "BACKGROUND_NOOP_JOB_RESULT_MISMATCH" });
  }
  assert.throws(() => assertBackgroundNoopResult({ ...job(), childPid: undefined }, backgroundAnswer),
    { nativeCode: "BACKGROUND_JOB_PID_MISSING" });
  assert.throws(() => assertBackgroundNoopResult(job(), "different native output"), { nativeCode: "BACKGROUND_NATIVE_STDOUT_MISMATCH" });
});

test("Claude global model evidence requires both real requests and the complete worker prompt", () => {
  const foreground = request(foregroundPrompt), worker = request(prompt);
  assertBackgroundModelRequests([foreground, worker], prompt);
  assert.equal(backgroundInputText({ system: [{ text: "system fixture" }], ...worker.body }).includes(prompt), true);
  const wrongModel = request(prompt);
  wrongModel.body.model = "wrong-model";
  for (const values of [[worker], [foreground, worker, worker], [foreground, wrongModel], [foreground, foreground]]) {
    assert.throws(() => assertBackgroundModelRequests(values, prompt));
  }
  assert.throws(() => assertBackgroundModelRequests([foreground, request(workerPromptMarker)], prompt),
    { message: "BACKGROUND_FULL_JOB_PROMPT_MISSING" });
});

test("background process cleanup checks detached groups after leaders exit and handles Windows without groups", () => {
  const probes = [];
  assert.equal(backgroundProcessesExited([job()], (pid) => { probes.push(pid); return false; }, true), true);
  assert.deepEqual(probes, [12345, -12345, 12346, -12346]);
  for (const remaining of probes) assert.equal(backgroundProcessesExited([job()], (pid) => pid === remaining, true), false);
  assert.equal(backgroundProcessesExited([{ ...job(), status: "running" }], () => false, true), false);
  assert.equal(backgroundProcessesExited([{ ...job(), workerPid: undefined }], () => false, true), false);
  assert.equal(backgroundProcessesExited([{ ...job(), childPid: undefined }], () => false, true), false);
  assert.equal(backgroundProcessesExited([], () => false, true), false);
  assert.equal(backgroundProcessesExited([job()], (pid) => pid < 0, false), true);
});

test("background assertion errors never disclose local output or paths", () => {
  const privateText = "private-path-and-output-canary";
  for (const run of [() => assertBackgroundJob({ ...job(), repo: privateText }, context),
    () => assertBackgroundJob({ ...job(), finalMessagePath: privateText }, context),
    () => assertBackgroundNoopResult(job(), privateText)]) {
    assert.throws(run, (error) => error.message === error.nativeCode && !error.stack.includes(privateText));
  }
});

test("Claude shared build binds the mainline snapshot and permits preparation before worker publication", () => {
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
