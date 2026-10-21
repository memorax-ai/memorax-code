import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { classifyCursorAppExecution, collectCursorAppNativeReport, writeCursorAppFinalReport, writeCursorAppProgress } from "./cursor-app-report.mjs";

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
