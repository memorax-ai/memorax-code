import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { classifyCursorAppExecution, collectCursorAppNativeReport, writeCursorAppFinalReport, writeCursorAppProgress } from "./cursor-app-report.mjs";
import { projectCursorAppHookTimeline } from "./cursor-app-hook-diagnostics.mjs";

const expected = { expectedVersion: "3.21.18", nodeMajor: "24", platform: "linux" };
const privateCanary = "private-path-token-transcript-canary";
const fixture = () => ({ status: "FAIL", client: "cursor", kind: "app-native-session-flows", platform: "linux",
  node: "24.22.0", version: "3.21.18", stage: "native-submit", errorCode: "CURSOR_APP_SKILL_HOOK_CONTEXT",
  evidence: { sameSessionFollowup: true }, memoryRequestCount: 2 });
const timeout = () => classifyCursorAppExecution({ killed: true, signal: "SIGKILL", stderr: privateCanary });
const missing = () => Object.assign(new Error(privateCanary), { code: "ENOENT" });
function collect(readReport, execution = timeout()) {
  return collectCursorAppNativeReport({ readReport, expected,
    fallback: { status: "FAIL", client: "cursor", kind: "app-native-session-flows", stage: "container-native", evidence: {} },
    execution, exitErrorCode: "CURSOR_CONTAINER_NATIVE_EXIT" });
}

test("atomic progress snapshots are redacted, bounded, and cannot authorize PASS", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cursor-progress-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = { ...fixture(), status: "PASS", raw: privateCanary, evidence: { sameSessionFollowup: true, transcript: privateCanary } };
  writeCursorAppProgress(root, input, expected);
  const before = await readFile(join(root, "progress.json"), "utf8");
  assert.equal(before.includes(privateCanary), false);
  assert.equal(JSON.parse(before).status, "FAIL");
  assert.equal(JSON.parse(before).errorCode, "CURSOR_APP_SKILL_HOOK_CONTEXT");
  await writeFile(join(root, "progress.json.tmp"), '{"interrupted":');
  assert.equal(await readFile(join(root, "progress.json"), "utf8"), before);
  const huge = { ...fixture(), evidence: { nativeContent: Array(5000).fill({ composerMatched: true, stateMatched: true, blobCount: 3 }) } };
  assert.throws(() => writeCursorAppProgress(root, huge, expected), { code: "CURSOR_APP_PROGRESS_SIZE" });
  assert.equal(await readFile(join(root, "progress.json"), "utf8"), before);
  writeCursorAppProgress(root, { ...fixture(), memoryRequestCount: 3 }, expected);
  assert.equal(JSON.parse(await readFile(join(root, "progress.json"), "utf8")).memoryRequestCount, 3);
});

test("a killed synthetic child leaves its first failure readable without a final report", { timeout: 10000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cursor-progress-killed-"));
  const code = 'import { writeCursorAppProgress } from ' + JSON.stringify(new URL("./cursor-app-report.mjs", import.meta.url).href) + ';'
    + 'writeCursorAppProgress(' + JSON.stringify(root) + ',' + JSON.stringify(fixture()) + ',' + JSON.stringify(expected) + ');'
    + 'process.stdout.write("ready"); setInterval(() => {}, 1000);';
  const child = spawn(process.execPath, ["--input-type=module", "--eval", code], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(async () => { child.kill("SIGKILL"); await rm(root, { recursive: true, force: true }); });
  const closed = once(child, "close");
  child.stderr.resume();
  await once(child.stdout, "data");
  child.kill("SIGKILL");
  await closed;
  const report = await collect((name) => readFile(join(root, name), "utf8"));
  assert.equal(report.status, "FAIL");
  assert.equal(report.errorCode, "CURSOR_APP_SKILL_HOOK_CONTEXT");
  assert.equal(report.stage, "native-submit");
  assert.equal(report.nativeExecution.status, "timeout");
  assert.equal(report.nativeExecution.reportSource, "progress");
  assert.equal(report.nativeExecution.finalReport, "missing");
  assert.equal(report.evidence.sameSessionFollowup, true);
});

test("missing, truncated, invalid and unreadable final reports preserve valid progress and the original error", async () => {
  for (const mode of ["missing", "truncated", "invalid", "unavailable"]) {
    const report = await collect(async (name) => {
      if (name === "progress.json") return JSON.stringify({ ...fixture(), raw: privateCanary });
      if (mode === "missing") throw missing();
      if (mode === "unavailable") throw Object.assign(new Error(privateCanary), { code: "EACCES" });
      return mode === "truncated" ? '{"status":' : JSON.stringify({ ...fixture(), platform: "other" });
    });
    assert.equal(report.errorCode, "CURSOR_APP_SKILL_HOOK_CONTEXT");
    assert.equal(report.nativeExecution.finalReport, ["missing", "unavailable"].includes(mode) ? mode : "invalid");
    assert.equal(report.nativeExecution.progressReport, "valid");
    assert.equal(report.nativeExecution.status, "timeout");
    assert.equal(JSON.stringify(report).includes(privateCanary), false);
  }
});

test("missing progress never conceals timeout, abort, nonzero exit or evidence read failure", async () => {
  for (const [error, status, code] of [
    [{ code: "ETIMEDOUT" }, "timeout", "CURSOR_APP_NATIVE_TIMEOUT"],
    [{ code: "ABORT_ERR" }, "aborted", "CURSOR_APP_NATIVE_ABORTED"],
    [{ code: 9 }, "exited", "CURSOR_CONTAINER_NATIVE_EXIT"],
  ]) {
    for (const unavailable of [false, true]) {
      const report = await collect(async () => { throw unavailable ? new Error(privateCanary) : missing(); }, classifyCursorAppExecution(error));
      assert.equal(report.status, "FAIL");
      assert.equal(report.errorCode, code);
      assert.equal(report.nativeExecution.status, status);
      assert.equal(report.nativeExecution.finalReport, unavailable ? "unavailable" : "missing");
      assert.equal(report.nativeExecution.progressReport, unavailable ? "unavailable" : "missing");
      assert.equal(JSON.stringify(report).includes(privateCanary), false);
    }
  }
  const absent = await collect(async () => { throw missing(); }, classifyCursorAppExecution());
  assert.equal(absent.errorCode, "CURSOR_APP_NATIVE_REPORT_MISSING");
  const forged = await collect(async () => JSON.stringify({ ...fixture(), status: "PASS" }), classifyCursorAppExecution());
  assert.equal(forged.status, "FAIL");
  assert.equal(forged.nativeExecution.progressReport, "invalid");
});

test("execution classification publishes only fixed statuses, signals and bounded exit codes", () => {
  for (const [error, status, exitCode, signal] of [
    [undefined, "exited", 0, "none"], [{ code: 7 }, "exited", 7, "none"],
    [{ killed: true, signal: "SIGKILL" }, "timeout", null, "SIGKILL"],
    [{ code: "ABORT_ERR", killed: true, signal: "SIGKILL" }, "aborted", null, "SIGKILL"],
    [{ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", killed: true, signal: "SIGKILL" }, "output-overflow", null, "SIGKILL"],
    [{ signal: "SIGTERM" }, "signal", null, "SIGTERM"], [{ code: "ENOENT" }, "launch-error", null, "none"],
    [{ code: privateCanary, signal: privateCanary }, "failed", null, "none"],
  ]) assert.deepEqual(classifyCursorAppExecution(error), { status, exitCode, signal });
});

test("wrapper report write failures preserve the original test failure and fail a previously successful result", async () => {
  for (const failed of [false, true]) for (const platform of ["container", "windows", "macos"]) {
    const report = failed ? fixture() : { status: "PASS", evidence: { cleanup: true } };
    const code = platform === "container" ? "CURSOR_CONTAINER_REPORT_WRITE" : "CURSOR_APP_" + platform.toUpperCase() + "_REPORT_WRITE";
    await writeCursorAppFinalReport("/owned/report.json", report, code, async () => { throw new Error(privateCanary); });
    assert.equal(report.status, "FAIL");
    assert.equal(report.errorCode, failed ? "CURSOR_APP_SKILL_HOOK_CONTEXT" : code);
    assert.equal(report.reportWriteError, code);
    assert.equal(JSON.stringify(report).includes(privateCanary), false);
  }
});


test("final and recovered progress reports retain driver readiness evidence on every native platform", async () => {
  for (const platform of ["linux", "darwin", "win32"]) for (const source of ["final", "progress"]) {
    const input = { ...fixture(), platform, stage: "app-start", errorCode: "CURSOR_APP_DRIVER",
      appDriver: { cdpConnected: true, cdpConnectedElapsedMs: 200, elapsedMs: 5200, waitElapsedMs: 5000,
        probeCount: 1, outcome: "failed", timeoutKind: "predicate",
        firstProbe: { contextCount: 1, pageCount: 2, workbenchCount: 1, elapsedMs: 200, completedElapsedMs: null,
          driverState: "unobserved", evaluation: "pending", evaluationFailure: "none", url: privateCanary },
        lastProbe: { contextCount: 1, pageCount: 2, workbenchCount: 1, elapsedMs: 200, completedElapsedMs: null,
          driverState: "unobserved", evaluation: "pending", evaluationFailure: "none", title: privateCanary },
        rawError: privateCanary } };
    const report = await collectCursorAppNativeReport({ expected: { ...expected, platform },
      fallback: { status: "FAIL", evidence: {} }, execution: classifyCursorAppExecution({ code: 1 }),
      exitErrorCode: "CURSOR_APP_NATIVE_EXIT", async readReport(name) {
        if (source === "progress" && name === "report.json") throw missing();
        return JSON.stringify(input);
      } });
    assert.equal(report.errorCode, "CURSOR_APP_DRIVER");
    assert.equal(report.appDriver.cdpConnected, true);
    assert.equal(report.appDriver.timeoutKind, "predicate");
    assert.equal(report.appDriver.waitElapsedMs, 5000);
    assert.equal(report.appDriver.lastProbe.evaluation, "pending");
    assert.equal(report.appDriver.firstProbe.workbenchCount, 1);
    assert.equal(report.nativeExecution.reportSource, source);
    assert.equal(JSON.stringify(report).includes(privateCanary), false);
  }
});


test("final and progress reports preserve frozen first-session evidence without exporting identity", async () => {
  for (const source of ["final", "progress"]) {
    const input = { ...fixture(), stage: "hook-session-ready", errorCode: "CURSOR_APP_SESSION_START_READY_TIMEOUT",
      hookReadinessFailure: { phase: "session", appLaunch: 1, code: "CURSOR_APP_SESSION_START_READY_TIMEOUT",
        timeoutKind: "predicate", waitElapsedMs: 5000, lastObservationElapsedMs: 200, observationPending: true,
        lastObservation: { phase: "session", requiredUserHooksLoaded: true, sessionStartReady: false, sessionId: privateCanary },
        sessionDiagnosticsStatus: "completed", sessionStart: { readStatus: "present", currentLogFiles: 1,
          unscopedRequests: 1, ownedExecutionBlocks: 1, filteredExecutionBlocks: { parse: 1 }, executions: [], raw: privateCanary },
        sessionId: privateCanary, home: privateCanary } };
    const output = await collect(async name => {
      if (source === "progress" && name === "report.json") throw missing();
      return JSON.stringify(input);
    });
    assert.equal(output.errorCode, input.errorCode);
    assert.equal(output.hookReadinessFailure.timeoutKind, "predicate");
    assert.equal(output.hookReadinessFailure.lastObservationElapsedMs, 200);
    assert.equal(output.hookReadinessFailure.sessionStart.unscopedRequests, 1);
    assert.equal(output.hookReadinessFailure.sessionStart.filteredExecutionBlocks.parse, 1);
    assert.equal(JSON.stringify(output).includes(privateCanary), false);
  }
});

test("the Hook timeline is kept for final PASS, final FAIL and recovered progress on every platform without deciding the result", async () => {
  const passing = (platform) => ({ status: "PASS", client: "cursor", kind: "app-native-session-flows", platform, node: "24.22.0",
    version: "3.21.18", stage: "complete", evidence: { agentTransport: true, nativeHooks: true, exactAutomaticAdd: true,
      sameSessionFollowup: true, sessionIsolation: true, workspaceIsolation: true, appResume: true, skillSearch: true, skillAdd: true,
      shellDenied: true, pendingShellInterrupted: true, sameSessionRecovered: true, repoMemoryWorker: true, cleanup: true,
      nativeContent: [3, 6, 3, 9, 15, 21, 4, 3, 4].map((blobCount) => ({ composerMatched: true, stateMatched: true, blobCount })) },
    agent: { runs: 11, ancillaryRequestCount: 0, unsupportedRpcCount: 0, errors: [], cancelled: Array.from({ length: 11 }, (_, index) => index === 7),
      writes: [3, 3, 3, 3, 6, 6, 4, 0, 3, 4, 5], acknowledgements: [3, 3, 3, 3, 6, 6, 4, 0, 3, 4, 5], historyTurns: [0, 1, 0, 2, 3, 4, 0, 0, 0, 0, 0],
      reads: [0, 3, 0, 6, 9, 15, 0, 0, 0, 0, 0], readResults: [0, 3, 0, 6, 9, 15, 0, 0, 0, 0, 0],
      execRequests: [0, 0, 0, 0, 3, 3, 1, 1, 0, 1, 2], execResults: [0, 0, 0, 0, 3, 3, 1, 0, 0, 1, 2], execCloses: [0, 0, 0, 0, 3, 3, 1, 0, 0, 1, 2],
      contextRequests: Array(11).fill(1), contextResults: Array(11).fill(1), contextCloses: Array(11).fill(1) }, memoryRequestCount: 11 });
  const timeline = { collection: "completed", readStatus: "present", filesRead: 4, raw: privateCanary,
    launches: [{ launch: 1, logFiles: 1, serviceInitMs: 900, config: [{ ms: 950, state: "loaded", text: privateCanary }],
      requestsMs: { sessionStart: [1200], beforeSubmitPrompt: [1300] }, omittedEvents: 0 }],
    sessions: [{ role: "S1", launch: 1, createMs: { requested: 1100, observed: 1250 }, configAtCreate: "not-ready", id: privateCanary,
      submitsMs: [{ launch: 1, ms: 1300 }], context: { runs: 1, ownRuns: 0, none: ["initial"], foreignRoles: [privateCanary] } }],
    sessionStart: { requests: 1, ownedExecutionBlocks: 1, executions: [{ role: "S2", launch: 2, exitCode: 0, responseKind: "json",
      trace: "foreign", traceRole: "S1", stdout: privateCanary }] } };
  for (const platform of ["linux", "darwin", "win32"]) for (const source of ["pass", "fail", "progress"]) {
    const input = { ...(source === "pass" ? passing(platform) : { ...fixture(), platform }), hookTimeline: timeline };
    const report = await collectCursorAppNativeReport({ expected: { ...expected, platform },
      fallback: { status: "FAIL", evidence: {} }, execution: classifyCursorAppExecution(source === "progress" ? { code: 1 } : undefined),
      exitErrorCode: "CURSOR_APP_NATIVE_EXIT", async readReport(name) {
        if (source === "progress" && name === "report.json") throw missing();
        return JSON.stringify(input, null, 2);
      } });
    assert.equal(report.status, source === "pass" ? "PASS" : "FAIL", `${platform} ${source}`);
    assert.equal(report.nativeExecution.reportSource, source === "progress" ? "progress" : "final");
    assert.deepEqual(report.hookTimeline, projectCursorAppHookTimeline(timeline));
    assert.equal(report.hookTimeline.sessions[0].configAtCreate, "not-ready");
    assert.equal(report.hookTimeline.sessionStart.executions[0].traceRole, "S1");
    assert.equal(JSON.stringify(report).includes(privateCanary), false);
  }
  // A malformed timeline projects to its empty failed form and never fails a passing report.
  const garbage = await collectCursorAppNativeReport({ expected: { ...expected, platform: "win32" }, fallback: { status: "FAIL", evidence: {} },
    execution: classifyCursorAppExecution(), exitErrorCode: "CURSOR_APP_NATIVE_EXIT",
    readReport: async () => JSON.stringify({ ...passing("win32"), hookTimeline: privateCanary }) });
  assert.equal(garbage.status, "PASS");
  assert.equal(garbage.hookTimeline.collection, "failed");
  assert.deepEqual(garbage.hookTimeline.sessions, []);
  assert.equal(JSON.stringify(garbage).includes(privateCanary), false);
});
