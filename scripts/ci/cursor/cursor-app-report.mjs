import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { projectCursorAppDiagnostics, projectCursorAppLaunchDiagnostics, projectCursorAppDriverDiagnostics,
  projectCursorAppBackendDiagnostics, projectCursorAppSubmissionDiagnostics,
  projectCursorAppShellDiagnostics, projectCursorAppStopDiagnostics, projectCursorAppWindowsStopDiagnostics } from "./cursor-app-diagnostics.mjs";
import { projectCursorAppHookDiagnostics, projectCursorAppHookTiming, projectCursorAppHookReadinessFailure,
  projectCursorAppHookTimeline } from "./cursor-app-hook-diagnostics.mjs";
import { projectCursorAppSkillHookContext } from "./cursor-app-hook-context.mjs";
import { projectCursorRepoMemoryDelegation } from "./cursor-app-repo-memory-check.mjs";
import { projectWindowsProcessAuditDiagnostics } from "./cursor-app-windows-runtime.mjs";

const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const codePattern = /^CURSOR_(?:APP|MOCK|AGENT|CONTAINER)_[A-Z0-9_]{1,100}$/;
const stages = new Set(["preflight", "candidate-install", "app-start", "native-submit", "agent-transport",
  "native-persistence", "automatic-add", "workspace-switch", "app-restart", "session-open", "pending-shell-interruption",
  "repo-memory-worker", "hook-config-ready", "hook-session-ready", "cleanup", "complete"]);
const completedEvidence = ["agentTransport", "nativeHooks", "exactAutomaticAdd", "sameSessionFollowup", "sessionIsolation", "workspaceIsolation", "appResume",
  "skillSearch", "skillAdd", "shellDenied", "pendingShellInterrupted", "sameSessionRecovered", "repoMemoryWorker", "cleanup"];
const completedCounts = {
  writes: [3, 3, 3, 3, 6, 6, 4, 0, 3, 4, 5], acknowledgements: [3, 3, 3, 3, 6, 6, 4, 0, 3, 4, 5],
  historyTurns: [0, 1, 0, 2, 3, 4, 0, 0, 0, 0, 0],
  reads: [0, 3, 0, 6, 9, 15, 0, 0, 0, 0, 0], readResults: [0, 3, 0, 6, 9, 15, 0, 0, 0, 0, 0],
  execRequests: [0, 0, 0, 0, 3, 3, 1, 1, 0, 1, 2],
  execResults: [0, 0, 0, 0, 3, 3, 1, 0, 0, 1, 2], execCloses: [0, 0, 0, 0, 3, 3, 1, 0, 0, 1, 2],
  contextRequests: Array(11).fill(1), contextResults: Array(11).fill(1), contextCloses: Array(11).fill(1),
};

function fail(code) { throw Object.assign(new Error(code), { code }); }
function check(value, code) { if (!value) fail(code); }
function count(value) { check(Number.isSafeInteger(value) && value >= 0, "CURSOR_CONTAINER_REPORT"); return value; }
export function projectCursorAppReport(input, { expectedVersion, nodeMajor = "24", platform = "linux" } = {}) {
  check(typeof expectedVersion === "string" && versionPattern.test(expectedVersion), "CURSOR_CONTAINER_RELEASE");
  check(["linux", "darwin", "win32"].includes(platform), "CURSOR_CONTAINER_REPORT");
  check(["22", "24"].includes(nodeMajor), "CURSOR_CONTAINER_NODE");
  const nodeVersion = typeof input?.node === "string" && input.node.match(versionPattern);
  check(input && ["PASS", "FAIL"].includes(input.status) && input.client === "cursor"
    && input.kind === "app-native-session-flows" && input.platform === platform
    && nodeVersion && nodeVersion[1] === nodeMajor && (nodeMajor !== "22" || Number(nodeVersion[2]) >= 13)
    && stages.has(input.stage), "CURSOR_CONTAINER_REPORT");
  const report = { status: input.status, client: "cursor", kind: input.kind, platform, node: input.node,
    stage: input.stage, evidence: {} };
  if (input.version !== undefined) {
    check(input.version === expectedVersion, "CURSOR_CONTAINER_REPORT");
    report.version = input.version;
  }
  for (const key of ["errorCode", "cleanupError", "nativeContentError"]) if (input[key] !== undefined) {
    check(typeof input[key] === "string" && codePattern.test(input[key]), "CURSOR_CONTAINER_REPORT");
    report[key] = input[key];
  }
  for (const key of completedEvidence) if (input.evidence?.[key] !== undefined) {
    check(typeof input.evidence[key] === "boolean", "CURSOR_CONTAINER_REPORT");
    report.evidence[key] = input.evidence[key];
  }
  const content = input.evidence?.nativeContent;
  if (content !== undefined) {
    check(Array.isArray(content), "CURSOR_CONTAINER_REPORT");
    report.evidence.nativeContent = content.map((item) => {
      check(item && typeof item.composerMatched === "boolean" && typeof item.stateMatched === "boolean", "CURSOR_CONTAINER_REPORT");
      return { composerMatched: item.composerMatched, stateMatched: item.stateMatched, blobCount: count(item.blobCount) };
    });
  }
  if (input.agent !== undefined) {
    const agent = input.agent;
    check(Array.isArray(agent.errors ?? []) && (agent.errors ?? []).every((value) => typeof value === "string" && codePattern.test(value)), "CURSOR_CONTAINER_REPORT");
    report.agent = { runs: count(agent.runs), ancillaryRequestCount: count(agent.ancillaryRequestCount),
      unsupportedRpcCount: count(agent.unsupportedRpcCount), errors: agent.errors ?? [] };
    for (const key of Object.keys(completedCounts)) {
      check(Array.isArray(agent[key]), "CURSOR_CONTAINER_REPORT");
      report.agent[key] = agent[key].map(count);
    }
    check(Array.isArray(agent.cancelled) && agent.cancelled.every((value) => typeof value === "boolean"), "CURSOR_CONTAINER_REPORT");
    report.agent.cancelled = [...agent.cancelled];
  }
  if (input.memoryRequestCount !== undefined) report.memoryRequestCount = count(input.memoryRequestCount);
  if (input.diagnostics !== undefined) report.diagnostics = projectCursorAppDiagnostics(input.diagnostics);
  if (input.status === "FAIL" && input.nativeHooks !== undefined) report.nativeHooks = projectCursorAppHookDiagnostics(input.nativeHooks);
  if (input.status === "FAIL" && input.hookReadinessFailure !== undefined) report.hookReadinessFailure = projectCursorAppHookReadinessFailure(input.hookReadinessFailure);
  if (input.status === "FAIL" && input.nativeSubmit !== undefined) report.nativeSubmit = projectCursorAppSubmissionDiagnostics(input.nativeSubmit);
  if (["linux", "darwin"].includes(platform) && input.hookTimings !== undefined) {
    report.hookTimings = (Array.isArray(input.hookTimings) ? input.hookTimings.slice(0, 32) : []).map(projectCursorAppHookTiming);
  }
  // Same shape for PASS and FAIL on every platform, so a failing cell can be compared with its baseline.
  if (input.hookTimeline !== undefined) report.hookTimeline = projectCursorAppHookTimeline(input.hookTimeline);
  if (input.status === "FAIL" && input.skillHookContext !== undefined) report.skillHookContext = projectCursorAppSkillHookContext(input.skillHookContext);
  if (input.status === "FAIL" && input.repoMemoryDelegation !== undefined) report.repoMemoryDelegation = projectCursorRepoMemoryDelegation(input.repoMemoryDelegation);
  if (input.status === "FAIL" && input.backendDiagnostics !== undefined) report.backendDiagnostics = projectCursorAppBackendDiagnostics(input.backendDiagnostics);
  if (input.appLaunch !== undefined) report.appLaunch = projectCursorAppLaunchDiagnostics(input.appLaunch);
  if (input.appDriver !== undefined) report.appDriver = projectCursorAppDriverDiagnostics(input.appDriver);
  if (input.status === "FAIL" && input.candidateStop !== undefined) report.candidateStop = projectCursorAppStopDiagnostics(input.candidateStop);
  if (input.status === "FAIL" && input.shellResult !== undefined) report.shellResult = projectCursorAppShellDiagnostics(input.shellResult);
  if (platform === "win32" && input.windowsProcessAudits !== undefined) {
    report.windowsProcessAudits = (Array.isArray(input.windowsProcessAudits) ? input.windowsProcessAudits.slice(0, 5) : [])
      .map((item) => ({ stage: ["workspace-switch", "app-restart", "repo-memory-worker", "cleanup"].includes(item?.stage) ? item.stage : "other",
        ...projectWindowsProcessAuditDiagnostics(item) }));
  }
  if (input.status === "FAIL" && platform === "win32" && input.windowsAppStop !== undefined) {
    report.windowsAppStop = projectCursorAppWindowsStopDiagnostics(input.windowsAppStop);
  }
  if (report.status === "PASS") check(report.stage === "complete" && report.version === expectedVersion && !report.errorCode && !report.cleanupError && !report.nativeContentError
    && completedEvidence.every((key) => report.evidence[key] === true)
    && content?.length === 9 && [3, 6, 3, 9, 15, 21, 4, 3, 4].every((blobs, index) => content[index]?.composerMatched === true
      && content[index]?.stateMatched === true && content[index]?.blobCount === blobs)
    && report.agent?.runs === 11 && Object.entries(completedCounts).every(([key, values]) => report.agent[key].length === values.length
      && values.every((value, index) => report.agent[key][index] === value))
    && report.agent.cancelled.length === 11 && [false, false, false, false, false, false, false, true, false, false, false].every((value, index) => report.agent.cancelled[index] === value)
    && report.agent.errors.length === 0 && report.memoryRequestCount === 11, "CURSOR_CONTAINER_REPORT");
  return report;
}

// Progress is diagnostic evidence only; only the final file can authorize PASS.
export function writeCursorAppProgress(directory, input, expected) {
  const report = projectCursorAppReport({ ...input, status: "FAIL" }, expected);
  const serialized = JSON.stringify(report, null, 2) + "\n";
  check(Buffer.byteLength(serialized) <= 64 * 1024, "CURSOR_APP_PROGRESS_SIZE");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, "progress.json.tmp");
  writeFileSync(temporary, serialized, { mode: 0o600 });
  renameSync(temporary, join(directory, "progress.json"));
}

export function classifyCursorAppExecution(error, exitCode = error ? null : 0) {
  const integer = (value) => Number.isInteger(value) && value >= -2147483648 && value <= 2147483647;
  const signal = ["SIGINT", "SIGTERM", "SIGKILL", "SIGABRT", "SIGSEGV", "SIGQUIT"].includes(error?.signal) ? error.signal : "none";
  let status = "exited";
  if (error?.code === "ABORT_ERR" || error?.name === "AbortError") status = "aborted";
  else if (error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") status = "output-overflow";
  else if (error?.code === "ETIMEDOUT" || error?.killed === true && signal === "SIGKILL") status = "timeout";
  else if (signal !== "none") status = "signal";
  else if (["ENOENT", "EACCES", "ENOEXEC"].includes(error?.code)) status = "launch-error";
  else if (error && !integer(error.code)) status = "failed";
  return { status, exitCode: integer(error?.code) ? error.code : integer(exitCode) ? exitCode : null, signal };
}

export async function collectCursorAppNativeReport({ readReport, expected, fallback, execution, exitErrorCode }) {
  let report, source = "missing", finalStatus = "missing", progressStatus = "not-read";
  for (const [name, key] of [["report.json", "final"], ["progress.json", "progress"]]) {
    let status, text;
    try { text = await readReport(name); }
    catch (error) { status = error?.code === "ENOENT" ? "missing" : "unavailable"; }
    try {
      if (status) throw null;
      check(typeof text === "string" && Buffer.byteLength(text) <= 64 * 1024, "CURSOR_CONTAINER_REPORT");
      const value = JSON.parse(text);
      check(key === "final" || value.status === "FAIL", "CURSOR_CONTAINER_REPORT");
      report = projectCursorAppReport(value, expected);
      source = key;
      status = "valid";
    } catch { status ??= "invalid"; }
    if (key === "final") finalStatus = status;
    else progressStatus = status;
    if (report) break;
  }
  report ??= { ...fallback, evidence: { ...fallback.evidence } };
  const outcome = { ...execution, reportSource: source, finalReport: finalStatus, progressReport: progressStatus };
  if (source !== "final" || execution.status !== "exited" || execution.exitCode !== 0) {
    report.status = "FAIL";
    const codes = { timeout: "CURSOR_APP_NATIVE_TIMEOUT", aborted: "CURSOR_APP_NATIVE_ABORTED",
      "output-overflow": "CURSOR_APP_NATIVE_OUTPUT_OVERFLOW", signal: "CURSOR_APP_NATIVE_SIGNAL",
      "launch-error": "CURSOR_APP_NATIVE_LAUNCH_FAILED", failed: "CURSOR_APP_NATIVE_EXECUTION_FAILED" };
    report.errorCode ??= codes[execution.status] ?? (execution.exitCode !== 0 ? exitErrorCode
      : finalStatus === "missing" ? "CURSOR_APP_NATIVE_REPORT_MISSING"
        : finalStatus === "unavailable" ? "CURSOR_APP_NATIVE_REPORT_UNAVAILABLE" : "CURSOR_APP_NATIVE_REPORT_INVALID");
  }
  report.nativeExecution = outcome;
  return report;
}

export async function writeCursorAppFinalReport(path, report, errorCode, write = writeFile) {
  try { await write(path, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 }); }
  catch {
    report.status = "FAIL";
    report.reportWriteError = errorCode;
    report.errorCode ??= errorCode;
  }
}
