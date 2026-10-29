import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, win32 } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { createEvidenceRecorder } from "../shared/ci-evidence.mjs";
import { projectError, projectPathAlias, semver, systemCode } from "../shared/ci-evidence-projections.mjs";
import { projectTerminalDisposal } from "./codex-setup-pty-evidence.mjs";

const source = (await readFile(new URL("./codex-install-smoke.mjs", import.meta.url), "utf8")).replaceAll("\r\n", "\n");
const privateText = "private-terminal-output /private/fixture/account";
const plain = (value) => JSON.parse(JSON.stringify(value));
function definitionOf(name) {
  const definition = source.match(new RegExp("(?:async )?function " + name + "\\([\\s\\S]*?(?=\\n(?:async )?function )"))?.[0];
  assert.ok(definition, name);
  // The closing parenthesis goes on its own line in case a comment for the next function ends the match.
  return "(" + definition + "\n)";
}
function runnerFunction(name, context = {}) {
  return runInNewContext(definitionOf(name), { process: { execPath: "/fixture/node" },
    projectError, projectPathAlias, projectTerminalDisposal, createHash, ...context });
}

function terminalFixture({ failure, report, evidenceFailure } = {}) {
  const observations = [], env = {};
  const evidence = { observe(name, value) {
    if (evidenceFailure) throw new Error(privateText);
    observations.push({ name, value: plain(value) });
  } };
  const recordTerminalDisposal = runnerFunction("recordTerminalDisposal", { evidence });
  const terminalSetup = runnerFunction("terminalSetup", { env, savedEndpoint: "http://127.0.0.1:1234",
    ptyScript: "/fixture/helper", ptyPackage: "/fixture/dependency", entrypoint: "/fixture/entrypoint",
    fixtureUser: "fixture-user", fixtureKey: "sk_" + "T".repeat(43), recordTerminalDisposal,
    async run() { if (failure) throw failure; return { stdout: JSON.stringify(report) }; },
  });
  return { terminalSetup, observations, env };
}

const disposal = { status: "failed", exitObserved: true, errorCode: "PTY_RESOURCE_DISPOSE_FAILED", systemCode: "EBUSY" };
const report = { status: "FAIL", error: "UNEXPECTED_TERMINAL_EXIT_CODE", exitCode: 1, signal: 0,
  terminalDisposal: { ...disposal, message: privateText, path: privateText, pid: 1234, stdout: privateText } };

test("terminal failure preserves its primary code and only typed disposal fields", async () => {
  const failure = Object.assign(new Error(privateText), { code: 1, stdout: JSON.stringify(report) });
  const fixture = terminalFixture({ failure });
  await assert.rejects(fixture.terminalSetup("complete"), (actual) => actual === failure);
  assert.equal(failure.terminalError, "UNEXPECTED_TERMINAL_EXIT_CODE");
  assert.deepEqual(plain(failure.terminalDisposal), disposal);
  assert.deepEqual(fixture.observations, [{ name: "terminalDisposal", value: { mode: "complete", ...disposal } }]);
  assert.equal(fixture.env.MEMORAX_CODE_MEMORAX_ENDPOINT, undefined);
  assert.equal(JSON.stringify(fixture.observations).includes(privateText), false);
});

test("outer command timeout retains a helper report already written to stdout", async () => {
  const failure = Object.assign(new Error(privateText), { code: null, signal: "SIGTERM", killed: true,
    stdout: JSON.stringify({ ...report, error: "PTY_RESOURCE_DISPOSE_FAILED", exitCode: 0 }) });
  const fixture = terminalFixture({ failure });
  await assert.rejects(fixture.terminalSetup("reuse"), (actual) => actual === failure);
  assert.equal(failure.terminalError, "PTY_RESOURCE_DISPOSE_FAILED");
  assert.deepEqual(plain(failure.terminalDisposal), disposal);
  assert.equal(failure.signal, "SIGTERM");
  assert.equal(failure.killed, true);
});

test("successful helper returns unchanged while safe disposal is journaled", async () => {
  const passing = { status: "PASS", terminalDisposal: { status: "returned", exitObserved: true, output: privateText } };
  const fixture = terminalFixture({ report: passing });
  assert.deepEqual(plain(await fixture.terminalSetup("force-update")), passing);
  assert.deepEqual(fixture.observations, [{ name: "terminalDisposal", value: { mode: "force-update", status: "returned", exitObserved: true } }]);
});

test("missing or truncated helper JSON preserves the original command failure", async () => {
  const failure = Object.assign(new Error(privateText), { code: 1, stdout: '{"status":' });
  const fixture = terminalFixture({ failure });
  await assert.rejects(fixture.terminalSetup("reuse"), (actual) => actual === failure);
  assert.equal(failure.terminalDisposal, undefined);
  assert.deepEqual(fixture.observations, []);
});

test("an evidence observer failure does not replace a terminal failure or its disposal result", async () => {
  const failure = Object.assign(new Error(privateText), { code: 1, stdout: JSON.stringify(report) });
  const fixture = terminalFixture({ failure, evidenceFailure: true });
  await assert.rejects(fixture.terminalSetup("reuse"), (actual) => actual === failure);
  assert.equal(failure.terminalError, report.error);
  assert.deepEqual(plain(failure.terminalDisposal), disposal);
});

for (const evidenceFailure of [false, true]) {
  test("directory removal records one bounded attempt and retains EBUSY" + (evidenceFailure ? " when evidence fails" : ""), async () => {
    const root = "/fixture/isolated", report = {}, observations = [], calls = [];
    const failure = Object.assign(new Error(privateText), { code: "EBUSY", path: root + "/upgrade user 测试/.codex" });
    let now = 10;
    const remove = runnerFunction("removeIsolatedDirectory", { root, report,
      performance: { now: () => { now += 12; return now; } },
      evidence: { observe(name, value) { if (evidenceFailure) throw new Error(privateText); observations.push({ name, value: plain(value) }); } },
      async rm(path, options) { calls.push({ path, options: plain(options) }); throw failure; },
    });
    await assert.rejects(remove(), (actual) => actual === failure);
    assert.deepEqual(calls, [{ path: root, options: { recursive: true, force: true } }]);
    assert.deepEqual(plain(report.directoryRemoval), { status: "failed", attempt: 1, elapsedMs: 12,
      error: { name: "Error", code: "EBUSY" }, path: "<root>/upgrade user 测试/.codex" });
    assert.equal(JSON.stringify(observations).includes(privateText), false);
    if (!evidenceFailure) assert.equal(observations[0].value.status, "started");
  });
}

test("successful directory removal does not add retries or change the rm contract", async () => {
  const report = {}, calls = [];
  const remove = runnerFunction("removeIsolatedDirectory", { root: "/fixture/isolated", report,
    performance: { now: () => 0 }, evidence: { observe() {} }, async rm(...args) { calls.push(plain(args)); },
  });
  await remove();
  assert.deepEqual(calls, [["/fixture/isolated", { recursive: true, force: true }]]);
  assert.deepEqual(plain(report.directoryRemoval), { status: "returned", attempt: 1, elapsedMs: 0 });
});

// Windows removal with synthetic rm failures and clock; each retry delay advances the clock at once.
function removalFixture({ platform = "win32", processCheck = { status: "clear" }, failures = [], clock } = {}) {
  const root = "/fixture/isolated", report = { processCheck }, calls = [], thrown = [], delays = [], observations = [], warnings = [];
  let now = 0;
  const remove = runnerFunction("removeIsolatedDirectory", { root, report, process: { platform },
    removalRetryDelaysMs: [250, 500, 1000], removalBudgetMs: 5_000, performance: { now: clock ?? (() => now) },
    setTimeout(done, delay) { delays.push(delay); now += delay; done(); },
    console: { log(line) { warnings.push(line); } },
    evidence: { observe(name, value) { observations.push(plain(value)); } },
    async rm(path, options) {
      calls.push(plain(options));
      const code = failures.shift();
      if (!code) return;
      thrown.push(Object.assign(new Error(privateText), { code, path: root + "/upgrade user 测试/.codex" }));
      throw thrown.at(-1);
    },
  });
  return { remove, report, calls, thrown, delays, observations, warnings };
}
const busyPath = "<root>/upgrade user 测试/.codex";

test("Windows removal retries a transient EBUSY after a clear process check and keeps the first error and attempts", async () => {
  const fixture = removalFixture({ failures: ["EBUSY", "EBUSY"] });
  await fixture.remove();
  assert.deepEqual(fixture.delays, [250, 500]);
  assert.deepEqual(fixture.calls, Array(3).fill({ recursive: true, force: true }));
  const record = { status: "returned", attempt: 3, elapsedMs: 750,
    firstError: { name: "Error", code: "EBUSY", path: busyPath }, errors: ["EBUSY", "EBUSY"], recovered: true };
  assert.deepEqual(plain(fixture.report.directoryRemoval), record);
  assert.deepEqual(fixture.observations, [1, 2, 3].map((attempt) => ({ status: "started", attempt })).concat([record]));
  // A recovered removal stays visible in the job log, with codes only.
  assert.deepEqual(fixture.warnings, ["::warning title=Codex cleanup::The isolated directory was removed on attempt 3 after EBUSY, EBUSY; the pre-removal query found no process matching the isolated paths."]);
  assert.equal(JSON.stringify([fixture.observations, fixture.warnings]).includes(privateText), false);
});

test("persistent occupation still fails after the bounded retries and keeps every attempt's code", async () => {
  const fixture = removalFixture({ failures: ["EBUSY", "ENOTEMPTY", "EPERM", "ENOTEMPTY", "EBUSY"] });
  await assert.rejects(fixture.remove(), (actual) => actual === fixture.thrown.at(-1));
  assert.deepEqual(fixture.delays, [250, 500, 1000]);
  assert.equal(fixture.calls.length, 4);
  assert.deepEqual(plain(fixture.report.directoryRemoval), { status: "failed", attempt: 4, elapsedMs: 1750,
    firstError: { name: "Error", code: "EBUSY", path: busyPath }, errors: ["EBUSY", "ENOTEMPTY", "EPERM", "ENOTEMPTY"],
    error: { name: "Error", code: "ENOTEMPTY" }, path: busyPath });
  assert.deepEqual(fixture.warnings, []);
});

test("the total removal budget ends retries before every delay is used", async () => {
  // Attempt 1 fails at 4.6 s, its wait ends at 4.85 s, attempt 2 fails at 4.9 s and its 500 ms wait would pass 5 s.
  const times = [0, 4_600, 4_850, 4_900, 4_900];
  const fixture = removalFixture({ failures: ["EBUSY", "EBUSY", "EBUSY"], clock: () => times.shift() });
  await assert.rejects(fixture.remove(), (actual) => actual === fixture.thrown.at(-1));
  assert.deepEqual(fixture.delays, [250]);
  assert.deepEqual(plain(fixture.report.directoryRemoval), { status: "failed", attempt: 2, elapsedMs: 4_900,
    firstError: { name: "Error", code: "EBUSY", path: busyPath }, errors: ["EBUSY", "EBUSY"],
    error: { name: "Error", code: "EBUSY" }, path: busyPath });
});

test("a retry timer that fires after the budget starts no further attempt and keeps the previous failure", async () => {
  // Attempt 1 fails at 4.5 s; its 250 ms wait would end within budget, but the timer resumes at 5.3 s.
  const times = [0, 4_500, 5_300, 5_300];
  const fixture = removalFixture({ failures: ["EBUSY"], clock: () => times.shift() });
  await assert.rejects(fixture.remove(), (actual) => actual === fixture.thrown[0]);
  assert.deepEqual([fixture.calls.length, fixture.delays, fixture.warnings], [1, [250], []]);
  assert.deepEqual(plain(fixture.report.directoryRemoval), { status: "failed", attempt: 1, elapsedMs: 5_300,
    error: { name: "Error", code: "EBUSY" }, path: busyPath });
});

test("removal keeps one attempt off Windows, without a clear process check, or after a non-transient error", async () => {
  for (const [label, options, code] of [
    ["linux", { platform: "linux" }, "EBUSY"],
    ["process check timed out", { processCheck: { status: "timed_out" } }, "EBUSY"],
    ["process check failed", { processCheck: { status: "observation_failed", code: "ENOENT" } }, "EBUSY"],
    ["no process check", { processCheck: null }, "EBUSY"],
    ["non-transient error", {}, "EACCES"],
  ]) {
    const fixture = removalFixture({ ...options, failures: [code, code] });
    await assert.rejects(fixture.remove(), (actual) => actual === fixture.thrown[0], label);
    assert.deepEqual([fixture.calls.length, fixture.delays, fixture.warnings], [1, [], []], label);
    assert.deepEqual(plain(fixture.report.directoryRemoval), { status: "failed", attempt: 1, elapsedMs: 0,
      error: { name: "Error", code }, path: busyPath }, label);
  }
});

test("final failure evidence retains terminal and directory cleanup causes independently", () => {
  const report = { status: "FAIL", stage: "terminal fixture", error: "The stage failed; private command output was suppressed",
    terminalError: "UNEXPECTED_TERMINAL_EXIT_CODE", terminalDisposal: disposal, checks: ["fixture"],
    cleanupFailure: { stage: "directory_removal", code: "CLEANUP_DIRECTORY_REMOVAL_FAILED", systemCode: "EBUSY", path: "<root>/.codex" },
    directoryRemoval: { status: "failed", attempt: 1, elapsedMs: 12, error: { code: "EBUSY" } } };
  const failureEvidence = runnerFunction("failureEvidence", { report, setupStarted: true });
  const result = plain(failureEvidence("FAIL"));
  assert.equal(result.kind, "functional+cleanup");
  assert.equal(result.code, "UNEXPECTED_TERMINAL_EXIT_CODE");
  assert.deepEqual(result.terminalDisposal, disposal);
  assert.equal(result.cleanupCode, "CLEANUP_DIRECTORY_REMOVAL_FAILED:EBUSY");
  assert.equal(result.directoryRemoval.attempt, 1);
  assert.equal(result.shutdownConfirmed, true);
});

// The failure-state readers with real file and process access; each test varies paths, versions or one injected error.
function stateReaders({ entrypoint, stateHome, backendPids = new Set(), argv = [], expectedPackageVersion, kill, fs = {} } = {}) {
  const withSystemCode = runnerFunction("withSystemCode", { systemCode });
  const readStateRecord = runnerFunction("readStateRecord", { readFile: fs.readFile ?? readFile, withSystemCode });
  const context = { entrypoint, stateHome, backendPids, expectedPackageVersion, join, dirname, semver, withSystemCode, readStateRecord,
    stat: fs.stat ?? stat, pidPath: runnerFunction("pidPath", { join, stateHome }),
    process: { argv, kill: kill ?? ((pid, signal) => process.kill(pid, signal)) } };
  return Object.fromEntries(["inspectEntrypoint", "inspectInstalledPackage", "inspectPackageTransition", "inspectBackendPid", "withSystemCode"]
    .map((name) => [name, name === "withSystemCode" ? withSystemCode : runnerFunction(name, context)]));
}

async function stateRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "codex-failure-state-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entrypoint = join(root, "package", "bin", "memorax-code.mjs"), stateHome = join(root, "state");
  await mkdir(dirname(entrypoint), { recursive: true });
  await mkdir(join(stateHome, "runtime", "backend"), { recursive: true });
  await mkdir(join(stateHome, "runtime", "install"), { recursive: true });
  return { root, entrypoint, stateHome, packageJson: join(root, "package", "package.json"),
    transition: join(stateHome, "runtime", "install", "package-transition.json"), pidFile: join(stateHome, "runtime", "backend", "backend.pid.json") };
}
const writeState = (path, value) => value === undefined ? rm(path, { force: true })
  : writeFile(path, typeof value === "string" ? value : JSON.stringify(value));
const boundedObservation = runnerFunction("boundedObservation", { withSystemCode: runnerFunction("withSystemCode", { systemCode }) });
const never = () => new Promise(() => {});
// The observed Windows update timeout, as the report holds it before its cleanup PID observation.
const observedUpdateTimeout = { status: "FAIL", stage: "retry public update in a native terminal",
  error: "The stage failed; private command output was suppressed", exitCode: 1, terminalError: "TERMINAL_CASE_TIMEOUT",
  terminalDisposal: { status: "returned", exitObserved: false }, checks: Array(13).fill("fixture"),
  cleanupFailure: { stage: "pid_record_removal", code: "CLEANUP_PID_RECORD_REMAINS" } };
const evidenceOf = (report) => plain(runnerFunction("failureEvidence", { report, setupStarted: true })("FAIL"));

test("the failure-time entry status distinguishes present, missing and stat errors without running the CLI", async (t) => {
  const { root, entrypoint } = await stateRoot(t);
  await writeFile(entrypoint, "");
  assert.deepEqual(plain(await stateReaders({ entrypoint }).inspectEntrypoint()), { status: "present" });
  assert.deepEqual(plain(await stateReaders({ entrypoint: join(root, "removed", "memorax-code.mjs") }).inspectEntrypoint()), { status: "missing" });
  // Only allowlisted system codes are kept; the error message never is.
  for (const [code, expected] of [["EPERM", { status: "stat_error", code: "EPERM" }], ["EUNLISTED", { status: "stat_error" }]]) {
    const failing = stateReaders({ entrypoint, fs: { async stat() { throw Object.assign(new Error(privateText), { code }); } } });
    assert.deepEqual(plain(await failing.inspectEntrypoint()), expected);
  }
  assert.deepEqual(plain(await stateReaders().inspectEntrypoint()), { status: "not_initialized" });
});

test("a PID record and its process are separate observations, including a record whose process exited", async (t) => {
  const { stateHome, pidFile } = await stateRoot(t);
  const read = async (options) => plain(await stateReaders({ stateHome, ...options }).inspectBackendPid());
  assert.deepEqual(await read(), { file: "absent", process: "not_probed" });
  await writeState(pidFile, "{");
  assert.deepEqual(await read(), { file: "unparseable", process: "not_probed" });
  await writeState(pidFile, { pid: 0 });
  assert.deepEqual(await read(), { file: "invalid", process: "not_probed" });
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await once(child, "exit");
  await writeState(pidFile, { pid: child.pid });
  assert.deepEqual(await read({ backendPids: new Set([child.pid]) }), { file: "present", process: "exited", tracked: true });
  await writeState(pidFile, { pid: process.pid });
  assert.deepEqual(await read(), { file: "present", process: "alive", tracked: false });
  // A probe error is unknown, never alive or exited.
  assert.deepEqual(await read({ kill() { throw Object.assign(new Error(privateText), { code: "EPERM" }); } }),
    { file: "present", process: "unknown", tracked: false, code: "EPERM" });
  await rm(pidFile);
  await mkdir(pidFile);
  assert.deepEqual(await read(), { file: "unreadable", process: "not_probed", code: "EISDIR" });
});

test("installed package versions and transition records keep absent, unreadable, unparseable and unrecognized states apart", async (t) => {
  const { entrypoint, stateHome, packageJson, transition } = await stateRoot(t);
  const readers = stateReaders({ entrypoint, stateHome, argv: ["node", "smoke", "", "", "", "", "0.1.18"], expectedPackageVersion: "0.1.21" });
  for (const [contents, expected] of [
    [undefined, { file: "absent" }], ["{", { file: "unparseable" }],
    [{ version: "0.1.21" }, { file: "present", version: "0.1.21", relation: "candidate" }],
    [{ version: "0.1.18" }, { file: "present", version: "0.1.18", relation: "previous" }],
    [{ version: "0.1.19" }, { file: "present", version: "0.1.19", relation: "other" }],
    [{ version: privateText }, { file: "present", relation: "invalid_version" }],
  ]) {
    await writeState(packageJson, contents);
    assert.deepEqual(plain(await readers.inspectInstalledPackage()), expected, JSON.stringify(contents));
  }
  for (const [contents, expected] of [
    [undefined, { file: "absent" }], ["{", { file: "unparseable" }],
    [{ version: 1, state: "retiring", transitionId: "fixture", sourceVersion: "0.1.18" },
      { file: "present", recordVersion: 1, state: "retiring", sourceVersion: "0.1.18" }],
    [{ version: 1, state: "retired", sourceVersion: "0.1.18", retiredAt: "2026-10-23T18:20:00Z" },
      { file: "present", recordVersion: 1, state: "retired", sourceVersion: "0.1.18" }],
    [{ version: 2, state: privateText, sourceVersion: privateText }, { file: "present", recordVersion: 2, state: "unrecognized" }],
  ]) {
    await writeState(transition, contents);
    assert.deepEqual(plain(await readers.inspectPackageTransition()), expected, JSON.stringify(contents));
  }
  await rm(transition, { force: true });
  await mkdir(transition);
  assert.deepEqual(plain(await readers.inspectPackageTransition()), { file: "unreadable", code: "EISDIR" });
});

test("the failure snapshot keeps every other item when one cannot be observed", async (t) => {
  const { entrypoint, stateHome, packageJson, transition, pidFile } = await stateRoot(t);
  await writeFile(entrypoint, "");
  await writeState(packageJson, { name: "@memorax/memorax-code", version: "0.1.18" });
  await writeState(transition, { version: 1, state: "retired", sourceVersion: "0.1.18" });
  await writeState(pidFile, { pid: process.pid });
  const readers = stateReaders({ entrypoint, stateHome, backendPids: new Set([process.pid]),
    argv: ["node", "smoke", "", "", "", "", "0.1.18"], expectedPackageVersion: "0.1.21" });
  // `registryRequests` is declared in the smoke and stays undefined until the upgrade scenario starts its registry.
  const evidence = createEvidenceRecorder({ suite: "codex-install-smoke", client: "codex" });
  const snapshot = async (context) => plain(await runnerFunction("snapshotFailureState",
    { ...readers, evidence, boundedObservation, registryRequests: undefined, ...context })());
  assert.deepEqual(await snapshot({ registryRequests: { manifest: 2, artifact: 0, rejectedArtifact: 1, extra: privateText } }), {
    entrypoint: { status: "present" },
    installedPackage: { file: "present", version: "0.1.18", relation: "previous" },
    packageTransition: { file: "present", recordVersion: 1, state: "retired", sourceVersion: "0.1.18" },
    backendPid: { file: "present", process: "alive", tracked: true },
    registryRequests: { manifest: 2, artifact: 0, rejectedArtifact: 1 },
  });
  const failed = await snapshot({ async inspectInstalledPackage() { throw Object.assign(new Error(privateText), { code: "EIO" }); } });
  assert.deepEqual(failed.installedPackage, { status: "observation_failed", code: "EIO" });
  assert.deepEqual(failed.entrypoint, { status: "present" });
  assert.deepEqual(failed.backendPid, { file: "present", process: "alive", tracked: true });
  assert.deepEqual(failed.registryRequests, { status: "not_started" });
  assert.equal(JSON.stringify(failed).includes(privateText), false);
});

test("cleanup records whether it issued stop or why it skipped it, and keeps the original cleanup failure", async () => {
  const remains = Object.assign(new Error("Backend PID record remains after stop"), { smokeMessage: "Backend PID record remains after stop" });
  const entryError = Object.assign(new Error(privateText), { code: "EPERM" }), pidError = new Error(privateText);
  for (const [label, overrides, cleanupStop, error, cleanupStage] of [
    ["entry present", { exists: async () => true }, { invoked: true }, remains, "pid_record_removal"],
    ["entry missing", { exists: async () => false }, { invoked: false, skipReason: "entrypoint_missing" }, remains, "pid_record_removal"],
    ["entry check failed", { async exists() { throw entryError; } },
      { invoked: false, skipReason: "entrypoint_check_failed" }, entryError, "entrypoint_check"],
    ["PID record unreadable before stop", { exists: async () => true, async rememberPid() { throw pidError; } },
      { invoked: false, skipReason: "pid_record_read_failed" }, pidError, "pid_record_read"],
  ]) {
    const commands = [];
    const context = { report: {}, stopInvocations: 0, cleanupStage: "unset", entrypoint: "/fixture/bin/memorax-code.mjs",
      async rememberPid() {}, async product(args) { commands.push(args); return { stdout: JSON.stringify({ ok: true }) }; },
      async assertStopped() { context.cleanupStage = "pid_record_removal"; throw remains; }, ...overrides };
    context.check = runInNewContext(definitionOf("check"), context);
    context.stopAndVerify = runInNewContext(definitionOf("stopAndVerify"), context);
    const stopForCleanup = runInNewContext(definitionOf("stopForCleanup"), context);
    await assert.rejects(stopForCleanup(), (actual) => actual === error, label);
    assert.deepEqual(plain(context.report.cleanupStop), cleanupStop, label);
    assert.deepEqual(plain(commands), cleanupStop.invoked ? [["stop", "--clients", "codex", "--json"]] : [], label);
    assert.equal(context.cleanupStage, cleanupStage, label);
  }
});

test("product diagnostics record why they were skipped, and the new fields leave the failure result unchanged", async () => {
  for (const [label, context, expected, collects] of [
    ["no environment", { env: undefined }, { status: "skipped", reason: "environment_not_ready" }, 0],
    ["entry missing", { inspectEntrypoint: async () => ({ status: "missing" }) }, { status: "skipped", reason: "entrypoint_missing" }, 0],
    ["entry stat error", { inspectEntrypoint: async () => ({ status: "stat_error", code: "EPERM" }) },
      { status: "skipped", reason: "entrypoint_stat_error" }, 0],
    ["collected", {}, { status: "collected" }, 1],
    ["collection failed", { collectStatus: "FAILED" }, { status: "failed" }, 1],
  ]) {
    const report = {}, collected = [];
    const collect = runnerFunction("collectProductDiagnostics", { report, env: {}, entrypoint: "/fixture/bin/memorax-code.mjs",
      inspectEntrypoint: async () => ({ status: "present" }), ...context,
      evidence: { async collect(name) { collected.push(name); return { status: context.collectStatus ?? "OK" }; } } });
    await collect();
    assert.deepEqual(plain(report.productDiagnostics), expected, label);
    assert.equal(collected.length, collects, label);
  }
  // The observed Windows update timeout keeps its kind, stage, codes and shutdown result with and without the new fields.
  const observed = observedUpdateTimeout;
  const diagnosed = { ...observed, failureState: { entrypoint: { status: "missing" } },
    productDiagnostics: { status: "skipped", reason: "entrypoint_missing" }, cleanupStop: { invoked: false, skipReason: "entrypoint_missing" },
    cleanupFailure: { ...observed.cleanupFailure, backendPid: { file: "present", process: "alive", tracked: true } } };
  const before = evidenceOf(observed), after = evidenceOf(diagnosed);
  for (const key of Object.keys(before)) assert.deepEqual(after[key], before[key], key);
  assert.deepEqual([after.kind, after.stage, after.code, after.cleanupCode, after.shutdownConfirmed],
    ["functional+cleanup", "retry public update in a native terminal", "TERMINAL_CASE_TIMEOUT", "CLEANUP_PID_RECORD_REMAINS", false]);
  assert.deepEqual([after.failureState, after.productDiagnostics, after.cleanupStop, after.cleanupBackendPid],
    [diagnosed.failureState, diagnosed.productDiagnostics, diagnosed.cleanupStop, diagnosed.cleanupFailure.backendPid]);
});

test("a snapshot reader that never returns times out alone; the other items and their journal records are kept", { timeout: 10_000 }, async (t) => {
  const { root, entrypoint, stateHome, transition, pidFile } = await stateRoot(t);
  await writeFile(entrypoint, "");
  await writeState(transition, { version: 1, state: "retiring", sourceVersion: "0.1.18" });
  await writeState(pidFile, { pid: process.pid });
  const directory = join(root, "evidence");
  await mkdir(directory);
  const evidence = createEvidenceRecorder({ suite: "codex-install-smoke", client: "codex", directory });
  const readers = stateReaders({ entrypoint, stateHome, backendPids: new Set([process.pid]) });
  const snapshotFailureState = runnerFunction("snapshotFailureState",
    { ...readers, evidence, boundedObservation, registryRequests: undefined, inspectInstalledPackage: never });
  const started = Date.now();
  const result = plain(await snapshotFailureState(50));
  assert.ok(Date.now() - started < 5_000);
  assert.deepEqual(result, {
    entrypoint: { status: "present" }, installedPackage: { status: "timed_out" },
    packageTransition: { file: "present", recordVersion: 1, state: "retiring", sourceVersion: "0.1.18" },
    backendPid: { file: "present", process: "alive", tracked: true }, registryRequests: { status: "not_started" },
  });
  // Each item was journaled as it completed, before cleanup; the timeout is an evidence issue, not a silent omission.
  evidence.finish({ testOutcome: "FAIL" });
  const records = (await readFile(join(directory, "codex-install-smoke", "journal.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(records.filter((record) => record.kind === "collect").map(({ name, status }) => [name, status]).sort(), [
    ["failureState.backendPid", "OK"], ["failureState.entrypoint", "OK"],
    ["failureState.installedPackage", "TIMEOUT"], ["failureState.packageTransition", "OK"],
  ]);
  assert.deepEqual(evidence.issues, ["COLLECT_TIMEOUT"]);
});

test("a cleanup PID observation that never returns still lets the report finish with its original errors", { timeout: 10_000 }, async () => {
  const report = structuredClone(observedUpdateTimeout);
  const observeCleanupBackendPid = runnerFunction("observeCleanupBackendPid", { report, boundedObservation,
    evidence: createEvidenceRecorder({ suite: "codex-install-smoke", client: "codex" }), inspectBackendPid: never });
  const started = Date.now();
  await observeCleanupBackendPid(50);
  assert.ok(Date.now() - started < 5_000);
  assert.deepEqual(plain(report.cleanupFailure), { stage: "pid_record_removal", code: "CLEANUP_PID_RECORD_REMAINS",
    backendPid: { status: "timed_out" } });
  const before = evidenceOf(observedUpdateTimeout), after = evidenceOf(report);
  for (const key of Object.keys(before)) assert.deepEqual(after[key], before[key], key);
  assert.deepEqual([after.code, after.cleanupCode, after.cleanupBackendPid],
    ["TERMINAL_CASE_TIMEOUT", "CLEANUP_PID_RECORD_REMAINS", { status: "timed_out" }]);
});

// Windows process rows in the shapes the PowerShell query returns; the temporary path can appear in short or long form.
const tempShort = "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp", tempLong = "C:\\Users\\runneradmin\\AppData\\Local\\Temp";
const isolatedPrefix = tempShort + "\\memorax-codex-install-0f1e\\npm", isolatedRoot = tempShort + "\\memorax-code-codex-install-AbC123";
const longForm = (path) => path.replace(tempShort, tempLong);
const processRow = (ProcessId, Name, ExecutablePath, CommandLine) => ({ ProcessId, Name, ExecutablePath, CommandLine });
const nativeCodex = processRow(201, "codex.exe", longForm(isolatedPrefix) + "\\node_modules\\@openai\\codex\\vendor\\codex.exe", null);
const unrelatedProcess = processRow(300, "svchost.exe", "C:\\Windows\\System32\\svchost.exe", "svchost.exe -k netsvcs");

test("the process check counts related processes in either path form and keeps paths and command lines private", () => {
  const classify = runnerFunction("classifyRelatedProcesses");
  const rows = [
    // The smoke itself names the isolated package in its arguments.
    processRow(100, "node.exe", "C:\\hostedtoolcache\\node.exe", `node codex-install-smoke.mjs ${isolatedPrefix}\\node_modules/@memorax/memorax-code`),
    nativeCodex,
    processRow(202, "node.exe", "C:\\hostedtoolcache\\node.exe",
      `"node.exe" "${isolatedPrefix.toLowerCase().replaceAll("\\", "/")}/node_modules/@openai/codex/bin/codex.js" app-server`),
    processRow(203, privateText, null, `cmd.exe /d /s /c "cd ${isolatedRoot}\\workspace 测试"`),
    unrelatedProcess, processRow(4, "System", null, null),
  ];
  const paths = [isolatedPrefix, isolatedRoot, longForm(isolatedPrefix), longForm(isolatedRoot)];
  const remaining = plain(classify(rows, paths, 100));
  assert.deepEqual(remaining, { status: "remaining", codex: 2, other: 1, names: ["codex.exe", "node.exe", "unrecognized"] });
  assert.equal(/runner|temp|private/i.test(JSON.stringify(remaining)), false);
  assert.deepEqual(plain(classify([rows[0], unrelatedProcess, rows[5]], paths, 100)), { status: "clear" });
});

test("a remaining related process fails the Windows check; a failed or unfinished query neither passes nor fails it", { timeout: 10_000 }, async () => {
  for (const [label, query, processCheck, failure, checks] of [
    ["remaining", async () => ({ stdout: JSON.stringify([nativeCodex, unrelatedProcess]) }),
      { status: "remaining", codex: 1, other: 0, names: ["codex.exe"] }, "A Codex or isolated installation process remains before directory removal", []],
    ["clear", async () => ({ stdout: JSON.stringify([unrelatedProcess]), stderr: "" }), { status: "clear" }, undefined,
      ["pre-removal process query found no process matching the isolated paths"]],
    ["query failed", async () => { throw Object.assign(new Error(privateText), { code: "ENOENT" }); },
      { status: "observation_failed", code: "ENOENT" }, undefined, []],
    // A non-terminating query error can still leave exit 0 and an empty list; it must not read as clear.
    ["query error with exit 0", async () => ({ stdout: "[]", stderr: "Get-CimInstance : " + privateText }),
      { status: "observation_failed" }, undefined, []],
    ["query never returns", never, { status: "timed_out" }, undefined, []],
  ]) {
    const report = { checks: [] }, invocations = [];
    const checkRelatedProcesses = runnerFunction("checkRelatedProcesses", { report, npmPrefix: isolatedPrefix, root: isolatedRoot,
      join: win32.join, process: { pid: 100, env: { SystemRoot: "C:\\Windows" } }, boundedObservation, check: runnerFunction("check"),
      classifyRelatedProcesses: runnerFunction("classifyRelatedProcesses"), realpath: async (path) => longForm(path),
      evidence: createEvidenceRecorder({ suite: "codex-install-smoke", client: "codex" }),
      execFileAsync(command, args, options) {
        invocations.push([command, args.at(-1).split("; ").slice(0, 2), options.cwd, options.windowsHide]);
        return query();
      } });
    const checked = checkRelatedProcesses(50);
    if (failure) await assert.rejects(checked, (actual) => actual.smokeMessage === failure, label);
    else await checked;
    assert.deepEqual(plain(report.processCheck), processCheck, label);
    assert.deepEqual(report.checks, checks, label);
    // The query stops on its first error, keeps progress records off stderr, and runs outside the directory it inspects.
    assert.deepEqual(invocations, [["C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      ["$ErrorActionPreference='Stop'", "$ProgressPreference='SilentlyContinue'"], undefined, true]], label);
  }
});

test("failure evidence separates a matching process from a removal still reporting occupation after the query found none", () => {
  const occupied = { status: "failed", attempt: 4, elapsedMs: 1750, firstError: { name: "Error", code: "EBUSY", path: "<root>/.codex" },
    errors: ["EBUSY", "EBUSY", "EBUSY", "EBUSY"], error: { name: "Error", code: "EBUSY" }, path: "<root>/.codex" };
  for (const [processCheck, cleanupFailure, directoryRemoval, cleanupCode, shutdownConfirmed] of [
    [{ status: "remaining", codex: 1, other: 0, names: ["codex.exe"] }, { stage: "command_process", code: "CLEANUP_COMMAND_PROCESS_REMAINS" },
      undefined, "CLEANUP_COMMAND_PROCESS_REMAINS", false],
    [{ status: "clear" }, { stage: "directory_removal", code: "CLEANUP_DIRECTORY_REMOVAL_FAILED", systemCode: "EBUSY", path: "<root>/.codex" },
      occupied, "CLEANUP_DIRECTORY_REMOVAL_FAILED:EBUSY", true],
  ]) {
    const report = { status: "FAIL", checks: ["fixture"], processCheck, cleanupFailure, directoryRemoval };
    const result = plain(runnerFunction("failureEvidence", { report, setupStarted: true })("PASS"));
    assert.deepEqual([result.kind, result.code, result.cleanupCode, result.shutdownConfirmed], ["cleanup", cleanupCode, cleanupCode, shutdownConfirmed]);
    assert.deepEqual(result.processCheck, processCheck);
    assert.deepEqual(result.directoryRemoval, directoryRemoval);
  }
});
