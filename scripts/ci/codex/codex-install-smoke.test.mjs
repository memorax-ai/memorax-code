import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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
function stateReaders({ entrypoint, stateHome, trackedBackends = [], argv = [], expectedPackageVersion, kill, fs = {} } = {}) {
  const withSystemCode = runnerFunction("withSystemCode", { systemCode });
  const readStateRecord = runnerFunction("readStateRecord", { readFile: fs.readFile ?? readFile, withSystemCode });
  const context = { entrypoint, stateHome, trackedBackends, expectedPackageVersion, join, dirname, semver, withSystemCode, readStateRecord,
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
  assert.deepEqual(await read({ trackedBackends: [{ pid: child.pid }] }), { file: "present", process: "exited", tracked: true });
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
  const readers = stateReaders({ entrypoint, stateHome, trackedBackends: [{ pid: process.pid }],
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
  const readers = stateReaders({ entrypoint, stateHome, trackedBackends: [{ pid: process.pid }] });
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

// The tracked-process judgement with an injected platform, signal probe and Windows process query. Instance values
// have the product's 24-byte base64url form; the command lines are synthetic and must never reach the report.
const instanceA = "q3Zr0_Wk-8bN2yT5LmPaVd1Xc7HsJe4G", instanceC = "Hn5-uR2zP_8sYb3Kd7QwLx0VfM4tGc1E";
const nodeExe = String.raw`C:\hostedtoolcache\windows\node\24.15.0\x64\node.exe`;
const serviceEntry = win32.join(String.raw`C:\Users\runneradmin\AppData\Local\Temp\codex install 测试\npm prefix`, "node_modules",
  "@memorax", "memorax-code", "node_modules", "memorax-code-backend", "dist", "service-entrypoint.js");
const commandLine = (marker) => `${nodeExe} "${serviceEntry}" ${marker}`;
const backendLine = (id) => commandLine(`--memorax-code-backend-instance ${id}`);
const otherLine = String.raw`C:\Windows\System32\conhost.exe 0xffffffff -ForceV1`;
const row = (pid, line) => ({ processId: pid, commandLine: Buffer.from(line).toString("base64") });
const answer = (...rows) => ({ stdout: JSON.stringify(rows), stderr: "" });
const remains = "An installation Backend process remains after stop";
const unconfirmed = "An installation Backend process identity could not be confirmed after stop";

function identityFixture({ platform = "win32", live = [], kill = {}, answers = [] } = {}) {
  const calls = [], observations = [];
  const context = {
    report: { checks: [] }, trackedBackends: [], stage: "", cleanupStage: "unset", cleanupTrackedPidIndex: undefined,
    backendPort: 32123, stopInvocations: 0, entrypoint: "/fixture/bin/memorax-code.mjs", Buffer, join: win32.join,
    pidPath: () => "/fixture/backend.pid.json",
    exists: async (path) => path === context.entrypoint && context.entrypointPresent === true,
    async product() { return { stdout: JSON.stringify({ ok: true }) }; },
    verifyBackendReplacementState: async () => context.replacementAfter,
    evidence: { observe(name, value) { observations.push({ name, value: plain(value) }); } },
    createTcpServer: () => ({ once() {}, listen(_port, _host, done) { done(); }, close(done) { done(); } }),
    process: { platform, env: { SystemRoot: "C:\\Windows" }, kill(pid, signal) {
      assert.equal(signal, 0);
      if (kill[pid]) throw kill[pid];
      if (!live.includes(pid)) throw Object.assign(new Error("not found"), { code: "ESRCH" });
    } },
    async execFileAsync(file, args, options) {
      calls.push({ file, args: plain(args), options: plain(options) });
      assert.ok(answers.length, "unexpected process query");
      const next = answers.shift();
      const result = typeof next === "function" ? next() : next;
      if (result instanceof Error) throw result;
      return result;
    },
  };
  for (const name of ["check", "rememberPid", "verifyBackendReplacement", "stopAndVerify", "stopForCleanup", "assertStopped",
    "trackBackend", "signalable", "queryBackendIdentity", "classifyBackendCommandLine", "validInstanceId", "windowsArgv"]) {
    context[name] = runInNewContext(definitionOf(name), context);
  }
  return { context, calls, observations, live, records: () => plain(context.report.backendIdentity ?? []),
    registrations: () => plain(context.report).backendRegistration };
}
// Neither an instance value nor any part of a command line may reach the report or the journal.
function assertPrivate(fx) {
  const text = JSON.stringify([fx.context.report, fx.observations]);
  for (const value of [instanceA, instanceC, "conhost", "service-entrypoint", "hostedtoolcache", "测试"]) {
    assert.equal(text.includes(value), false, value);
  }
}

test("Windows command lines split by the C runtime rules, and quoting that parsers could split differently is uncertain", () => {
  const { windowsArgv } = identityFixture().context;
  for (const [line, args] of [
    [String.raw`C:\node.exe a b `, [String.raw`C:\node.exe`, "a", "b"]],
    [String.raw`"C:\Program Files\node.exe"  "a b"` + "\tc", [String.raw`C:\Program Files\node.exe`, "a b", "c"]],
    // The program name keeps its backslashes; later arguments apply the backslash and quote rules.
    [String.raw`"C:\dir\\" x "a b"c`, [String.raw`C:\dir\\`, "x", "a bc"]],
    [String.raw`x a\b "c\\" d\"e f\\\"g "h i\\\\"`, ["x", String.raw`a\b`, "c\\", 'd"e', 'f\\"g', "h i\\\\"]],
    ['x "" y', ["x", "", "y"]],
  ]) assert.deepEqual(plain(windowsArgv(line)), { args, certain: true }, line);
  for (const line of ['x "a', 'x "a""b"', String.raw`"C:\node.exe"x y`, String.raw`C:\no"de.exe" y`, String.raw`"C:\node.exe y`]) {
    assert.equal(windowsArgv(line).certain, false, line);
  }
});

test("only the exact marker argument with one instance value identifies a Backend; near misses are ambiguous", () => {
  const { classifyBackendCommandLine: classify } = identityFixture().context;
  const tracked = [instanceA];
  assert.equal(classify(backendLine(instanceA), tracked), "match");
  assert.equal(classify(backendLine(instanceC), tracked), "other_instance");
  assert.equal(classify(otherLine, tracked), "no_marker");
  for (const line of ["", " \t"]) assert.equal(classify(line, tracked), "command_line_missing");
  assert.equal(classify(`${nodeExe} "${serviceEntry} --memorax-code-backend-instance ${instanceA}`, tracked), "parse_uncertain");
  for (const marker of [
    `--memorax-code-backend-instance=${instanceA}`, `--memorax-code-backend-instance=${instanceC}`,
    `--MEMORAX-CODE-BACKEND-INSTANCE ${instanceC}`, `--memorax-code-backend-instances ${instanceC}`,
    `-memorax-code-backend-instance ${instanceC}`, `"--memorax-code-backend-instance ${instanceC}"`,
    `--memorax-code-backend-instance ${instanceC} --memorax-code-backend-instance ${instanceC}`,
    "--memorax-code-backend-instance", "--memorax-code-backend-instance --memorax-code-backend-instance",
    `--memorax-code-backend-instance "${instanceC} x"`, `--memorax-code-backend-instance ${instanceA}x`,
    `--memorax-code-backend-instance ${instanceC} --note ${instanceA}`,
  ]) assert.equal(classify(commandLine(marker), tracked), "marker_ambiguous", marker);
  // A tracked instance anywhere on an unrelated command line is ambiguous as well, never another process.
  for (const line of ["C:\\Windows\\notepad.exe C:\\logs\\" + instanceA + ".txt", "C:\\" + instanceA + "\\node.exe"]) {
    assert.equal(classify(line, tracked), "marker_ambiguous", line);
  }
});

test("the Windows process query fails closed and returns only a classification", async () => {
  const pid = 4321;
  const query = async (result) => {
    const fx = identityFixture({ answers: [result] });
    return { result: await fx.context.queryBackendIdentity(pid, [instanceA]), call: fx.calls[0] };
  };
  const { result, call } = await query(answer(row(pid, backendLine(instanceA))));
  assert.equal(result, "match");
  assert.equal(call.file, String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`);
  assert.deepEqual(call.args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
  assert.match(call.args[3], /^\$ErrorActionPreference='Stop'; /);
  assert.match(call.args[3], /Get-CimInstance Win32_Process -Filter 'ProcessId = 4321' -Property ProcessId,CommandLine/);
  // The query runs in the smoke's own environment and directory, never inside the isolated tree.
  assert.deepEqual(call.options, { timeout: 30_000, maxBuffer: 1024 * 1024, encoding: "utf8", windowsHide: true });
  for (const [label, output, expected] of [
    ["no row", answer(), "exited"],
    ["another process", answer(row(pid, otherLine)), "no_marker"],
    ["another Backend instance", answer(row(pid, backendLine(instanceC))), "other_instance"],
    ["empty command line", answer(row(pid, "")), "command_line_missing"],
    ["stderr", { ...answer(row(pid, otherLine)), stderr: "warning" }, "query_stderr"],
    ["deadline", Object.assign(new Error("private"), { killed: true, signal: "SIGTERM", code: null }), "query_timeout"],
    ["exit code", Object.assign(new Error("private"), { killed: false, code: 1 }), "query_failed"],
    ["launch failure", Object.assign(new Error("private"), { code: "ENOENT" }), "query_failed"],
    ["empty output", { stdout: "", stderr: "" }, "query_invalid"],
    ["truncated output", { stdout: "[{", stderr: "" }, "query_invalid"],
    ["object output", { stdout: JSON.stringify(row(pid, otherLine)), stderr: "" }, "query_invalid"],
    ["two rows", answer(row(pid, otherLine), row(pid, otherLine)), "query_invalid"],
    ["another PID", answer(row(pid + 1, otherLine)), "query_invalid"],
    ["missing command line", answer({ processId: pid }), "query_invalid"],
    ["null command line", answer({ processId: pid, commandLine: null }), "query_invalid"],
    ["undecodable command line", answer({ processId: pid, commandLine: "not base64!" }), "query_invalid"],
    // Node would decode each of these to text without a marker, yet none is canonical base64 of valid UTF-8; the
    // non-ASCII Backend line above is.
    ["unpadded base64", answer({ processId: pid, commandLine: "bm9kZS5leGU" }), "query_invalid"],
    ["nonzero padding bits", answer({ processId: pid, commandLine: "bm9kZS5leGV=" }), "query_invalid"],
    ["base64url alphabet", answer({ processId: pid, commandLine: "Pz8_" }), "query_invalid"],
    ["wrapped base64", answer({ processId: pid, commandLine: "bm9kZS5l\r\neGU=" }), "query_invalid"],
    ["invalid UTF-8 byte", answer({ processId: pid, commandLine: "/w==" }), "query_invalid"],
    ["truncated UTF-8 sequence", answer({ processId: pid, commandLine: "5rU=" }), "query_invalid"],
  ]) assert.equal((await query(output)).result, expected, label);
});

test("a tracked PID held by another process passes only for a verified pair and a complete, unambiguous command line", async () => {
  const pid = 4321, verified = answer(row(pid, backendLine(instanceA)));
  const deadline = () => Object.assign(new Error("private"), { killed: true, signal: "SIGTERM", code: null });
  for (const [label, registration, stopAnswer, expected, outcome, registered = "verified"] of [
    ["another process", verified, answer(row(pid, otherLine)), "passed", "identity_mismatch"],
    ["another Backend instance", verified, answer(row(pid, backendLine(instanceC))), "passed", "identity_mismatch"],
    ["the tracked Backend", verified, verified, remains, "identity_match"],
    ["the tracked Backend on an unverified pair", deadline, verified, remains, "identity_match", "query_timeout"],
    ["an unverified pair", { ...verified, stderr: "warning" }, answer(row(pid, otherLine)), unconfirmed,
      "identity_unverified", "query_stderr"],
    ["a pair whose PID showed no marker", answer(row(pid, otherLine)), answer(row(pid, otherLine)), unconfirmed,
      "identity_unverified", "no_marker"],
    ["query stderr", verified, { ...answer(row(pid, otherLine)), stderr: "warning" }, unconfirmed, "query_stderr"],
    ["query deadline", verified, deadline, unconfirmed, "query_timeout"],
    ["query failure", verified, Object.assign(new Error("private"), { code: 1 }), unconfirmed, "query_failed"],
    ["truncated output", verified, { stdout: "[{", stderr: "" }, unconfirmed, "query_invalid"],
    ["missing command line", verified, answer({ processId: pid }), unconfirmed, "query_invalid"],
    ["empty command line", verified, answer(row(pid, "")), unconfirmed, "command_line_missing"],
    ["unterminated quote", verified, answer(row(pid, `${nodeExe} "${serviceEntry}`)), unconfirmed, "parse_uncertain"],
    ["marker joined to its value", verified, answer(row(pid, commandLine(`--memorax-code-backend-instance=${instanceC}`))),
      unconfirmed, "marker_ambiguous"],
    ["marker in another case", verified, answer(row(pid, commandLine(`--MEMORAX-CODE-BACKEND-INSTANCE ${instanceC}`))),
      unconfirmed, "marker_ambiguous"],
    ["tracked instance in another argument", verified, answer(row(pid, `${otherLine} ${instanceA}`)), unconfirmed,
      "marker_ambiguous"],
    ["invalid UTF-8", verified, answer({ processId: pid, commandLine: "/w==" }), unconfirmed, "query_invalid"],
    ["unpadded base64", verified, answer({ processId: pid, commandLine: "bm9kZS5leGU" }), unconfirmed, "query_invalid"],
  ]) {
    const fx = identityFixture({ live: [pid], answers: [registration, stopAnswer] });
    await fx.context.trackBackend({ pid, instanceId: instanceA });
    assert.equal(fx.context.trackedBackends[0].registration, registered, label);
    assert.deepEqual(fx.registrations(), { [registered]: 1 }, label);
    assert.equal(await fx.context.assertStopped().then(() => "passed", (error) => error.message), expected, label);
    assert.deepEqual(fx.records(), [{ index: 0, outcome, registration: registered }], label);
    assert.deepEqual(fx.observations.at(-1), { name: "backendIdentity", value: fx.records() }, label);
    assert.equal(fx.context.trackedBackends.length, expected === "passed" ? 0 : 1, label);
    assert.equal(fx.context.cleanupStage, expected === "passed" ? "port_release" : "tracked_process", label);
    assertPrivate(fx);
  }
});

test("a PID that exits during the check passes only when the probe agrees; probe errors and other platforms still fail", async () => {
  const pid = 4321, verified = answer(row(pid, backendLine(instanceA)));
  let fx = identityFixture({ live: [pid], answers: [verified, () => { fx.live.length = 0; return answer(); }] });
  await fx.context.trackBackend({ pid, instanceId: instanceA });
  await fx.context.assertStopped();
  assert.deepEqual(fx.records(), [{ index: 0, outcome: "exited", registration: "verified" }]);
  fx = identityFixture({ live: [pid], answers: [verified, answer()] });
  await fx.context.trackBackend({ pid, instanceId: instanceA });
  await assert.rejects(fx.context.assertStopped(), { message: unconfirmed });
  assert.deepEqual(fx.records(), [{ index: 0, outcome: "query_inconsistent", registration: "verified" }]);
  // An exited PID needs no query, and a probe error is not an absent process.
  fx = identityFixture({ answers: [verified] });
  await fx.context.trackBackend({ pid, instanceId: instanceA });
  await fx.context.assertStopped();
  assert.deepEqual([fx.calls.length, fx.records()], [1, []]);
  fx = identityFixture({ kill: { [pid]: Object.assign(new Error("private"), { code: "EPERM" }) }, answers: [verified] });
  await fx.context.trackBackend({ pid, instanceId: instanceA });
  await assert.rejects(fx.context.assertStopped(), { code: "EPERM" });
  assert.deepEqual([fx.calls.length, fx.records()], [1, []]);
  // Without a Windows query a live tracked PID stays a remaining Backend and the report has no registrations, as before.
  for (const platform of ["linux", "darwin"]) {
    fx = identityFixture({ platform, live: [pid] });
    await fx.context.trackBackend({ pid, instanceId: instanceA });
    assert.equal(fx.context.trackedBackends[0].registration, "not_applicable");
    await assert.rejects(fx.context.assertStopped(), { message: remains });
    assert.deepEqual([fx.calls.length, fx.records(), fx.registrations()], [0, [], undefined]);
  }
});

test("a PID that recurs with another instance keeps both pairs, so the later live instance still fails", async () => {
  const pid = 4321;
  const fx = identityFixture({ live: [pid], answers: [answer(row(pid, backendLine(instanceA))),
    answer(row(pid, backendLine(instanceC))), answer(row(pid, backendLine(instanceC)))] });
  await fx.context.trackBackend({ pid, instanceId: instanceA });
  await fx.context.trackBackend({ pid, instanceId: instanceC });
  // An exact repeat neither adds a pair nor queries again.
  await fx.context.trackBackend({ pid, instanceId: instanceA });
  assert.deepEqual(plain(fx.context.trackedBackends), [{ pid, instanceId: instanceA, registration: "verified" },
    { pid, instanceId: instanceC, registration: "verified" }]);
  assert.deepEqual([fx.calls.length, fx.registrations()], [2, { verified: 2 }]);
  await assert.rejects(fx.context.assertStopped(), { message: remains });
  // The earlier pair fails already: its PID now carries a tracked instance, though not its own.
  assert.deepEqual(fx.records(), [{ index: 0, outcome: "identity_match", registration: "verified" }]);
  assert.equal(fx.context.trackedBackends.length, 2);
  assertPrivate(fx);
});

test("a replacement retires only its own pair, and an instance without a valid value stays unverified", async () => {
  const pid = 4321, next = 4322;
  const fx = identityFixture({ answers: [answer(row(next, backendLine(instanceA)))] });
  fx.context.trackedBackends.push({ pid, instanceId: "older-instance", registration: "verified" },
    { pid, instanceId: instanceC, registration: "verified" });
  fx.context.replacementAfter = { pid: next, instanceId: instanceA };
  await fx.context.verifyBackendReplacement({ pid, instanceId: instanceC }, "replacement");
  assert.deepEqual(plain(fx.context.trackedBackends), [{ pid, instanceId: "older-instance", registration: "verified" },
    { pid: next, instanceId: instanceA, registration: "verified" }]);
  const invalid = identityFixture({ live: [pid], answers: [answer(row(pid, otherLine))] });
  await invalid.context.trackBackend({ pid });
  assert.deepEqual([invalid.calls.length, invalid.context.trackedBackends[0].registration], [0, "instance_invalid"]);
  await assert.rejects(invalid.context.assertStopped(), { message: unconfirmed });
  assert.deepEqual(invalid.records(), [{ index: 0, outcome: "identity_unverified", registration: "instance_invalid" }]);
});

test("the functional stop and both cleanup paths apply the same tracked-process judgement", async () => {
  const pid = 4321;
  for (const [stopLine, expected, outcome] of [[otherLine, "passed", "identity_mismatch"],
    [backendLine(instanceA), remains, "identity_match"]]) {
    for (const [label, stop] of [["functional stop", (context) => context.stopAndVerify()],
      ["cleanup with entrypoint", (context) => { context.entrypointPresent = true; return context.stopForCleanup(); }],
      ["cleanup without entrypoint", (context) => context.stopForCleanup()]]) {
      const fx = identityFixture({ live: [pid], answers: [answer(row(pid, backendLine(instanceA))), answer(row(pid, stopLine))] });
      await fx.context.trackBackend({ pid, instanceId: instanceA });
      assert.equal(await stop(fx.context).then(() => "passed", (error) => error.message), expected, label);
      assert.deepEqual(fx.records(), [{ index: 0, outcome, registration: "verified" }], label);
    }
  }
});

test("a failed registration read never fails the run, and the report and journal keep its code and count", async () => {
  const pid = 4321, next = 4322, summary = { query_invalid: 1, verified: 1 };
  const fx = identityFixture({ live: [pid, next],
    answers: [{ stdout: "[{", stderr: "" }, answer(row(next, backendLine(instanceC)))] });
  await fx.context.trackBackend({ pid, instanceId: instanceA });
  await fx.context.trackBackend({ pid: next, instanceId: instanceC });
  // Both Backends exit before the stop check, which then queries nothing and records no identity.
  fx.live.length = 0;
  await fx.context.assertStopped();
  assert.deepEqual([fx.calls.length, fx.records(), fx.context.trackedBackends.length], [2, [], 0]);
  assert.deepEqual(fx.registrations(), summary);
  assert.deepEqual(fx.observations, [{ name: "backendRegistration", value: { query_invalid: 1 } },
    { name: "backendRegistration", value: summary }]);
  assertPrivate(fx);
});

// A busy Windows removal of a real directory: the first rm fails with `code`, each probe fails with the next of `probes`
// and removes once they run out, timers fire one per turn in deadline order and move the clock to that deadline (nothing
// else moves it), and PowerShell answers come from a queue. The smoke started at 1 s on this clock's wall time, and each
// path resolves to a long form that does not contain its short form.
async function holderFixture(t, { platform = "win32", code = "EBUSY", probes = [], answers = [], budgets, realpathError } = {}) {
  const root = await mkdtemp(join(tmpdir(), "codex-holder-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const failedPath = join(root, "upgrade user 测试", ".codex");
  await mkdir(join(failedPath, "log"), { recursive: true });
  await writeFile(join(failedPath, "log", "codex-tui.log"), privateText);
  const failure = Object.assign(new Error(privateText), { code, path: failedPath });
  const calls = [], queries = [], warnings = [], observations = [];
  const recorder = createEvidenceRecorder({ suite: "codex-install-smoke", client: "codex" });
  let now = 0;
  const timers = [];
  const context = {
    root, npmPrefix: "/fixture/npm", report: {}, systemCode, projectError, projectPathAlias, join, lstat, readdir,
    holderBudgetMs: budgets ?? { total: 60_000, entries: 2_000, processes: 2_000, defender: 2_000 },
    process: { platform, pid: 100, env: { SystemRoot: "C:\\Windows" } }, performance: { now: () => now, timeOrigin: 1_000 },
    setTimeout(done, delay) {
      timers.push({ at: now + delay, done });
      setImmediate(() => {
        const next = timers.sort((a, b) => a.at - b.at).shift();
        now = Math.max(now, next.at);
        next.done();
      });
    },
    console: { log(line) { warnings.push(line); } },
    evidence: { collect: recorder.collect, observe(name, value) { observations.push(plain(value)); } },
    async realpath(path) { if (realpathError) throw realpathError; return { [root]: "/long/root", "/fixture/npm": "/long/npm" }[path]; },
    async rm(path, options) {
      calls.push([path, plain(options)]);
      if (calls.length === 1) throw failure;
      const next = probes.shift();
      if (next) throw Object.assign(new Error(privateText), { code: next, path: failedPath });
    },
    async execFileAsync(file, args, options) {
      queries.push({ file: file.split(/[\\/]/), args: plain(args), options: plain(options), at: now });
      assert.ok(answers.length, "unexpected PowerShell query");
      const next = answers.shift();
      const result = typeof next === "function" ? await next() : next;
      if (result instanceof Error) throw result;
      return result;
    },
  };
  for (const name of ["withSystemCode", "boundedObservation", "queryPowerShell", "classifyHolderProcesses", "snapshotProcesses",
    "readDefenderStatus", "inspectRemovalPath", "probeRemoval", "holderWarning", "observeRemovalHolders", "removeIsolatedDirectory"]) {
    context[name] = runInNewContext(definitionOf(name), context);
  }
  return { context, root, failure, calls, queries, warnings, observations, record: () => plain(context.report.directoryRemoval) };
}
const holderRow = (ProcessId, Name, CreationDate, ParentProcessId, ExecutablePath = null, CommandLine = null) =>
  ({ ProcessId, ParentProcessId, Name, CreationDate, ExecutablePath, CommandLine });
const holderAnswer = (query, ...rows) => ({ stdout: JSON.stringify({ query, rows }), stderr: "" });
const defenderAnswer = (enabled) => ({ stdout: JSON.stringify({ realTimeProtectionEnabled: enabled }), stderr: "" });
const busyRecord = (code) => ({ status: "failed", attempt: 1, elapsedMs: 0, error: { name: "Error", code }, path: "<root>/upgrade user 测试/.codex" });
const remainingEntries = { exists: true, directory: true, total: 2, names: ["log", "log/codex-tui.log"] };
const wmi = holderRow(300, "WmiPrvSE.exe", 4_000, 4, "C:\\Windows\\System32\\wbem\\WmiPrvSE.exe");
const wmiRecord = { name: "WmiPrvSE.exe", pid: 300, parentPid: 4, createdAt: new Date(4_000).toISOString(), inRoot: false, inNpmPrefix: false };
// Neither a path nor any part of a command line may reach the report, the journal or the job log.
function assertHolderPrivate(fx) {
  const text = JSON.stringify([fx.context.report, fx.observations, fx.warnings]);
  for (const value of [fx.root, "/long", "/fixture", "private", "app-server", "C:", "wbem"]) {
    assert.equal(text.includes(value), false, value);
  }
}

test("a busy Windows removal records what remains, the processes alive, when removal stops failing and Defender, and still fails", async (t) => {
  for (const [label, probes, probeRecords, warning] of [
    ["removable at 4 s", ["EBUSY", "ENOTEMPTY"], [{ second: 1, afterMs: 1_000, code: "EBUSY" },
      { second: 2, afterMs: 2_000, code: "ENOTEMPTY" }, { second: 4, afterMs: 4_000, removed: true }],
      "succeeded on a probe 4.0 s after the failure"],
    ["still busy at 15 s", Array(5).fill("EBUSY"), [1, 2, 4, 8, 15].map((second) => ({ second, afterMs: second * 1_000, code: "EBUSY" })),
      "still failed with EBUSY 15.0 s after the failure"],
  ]) {
    const end = probeRecords.at(-1).afterMs;
    const fx = await holderFixture(t, { probes, answers: [
      // The first query takes 2.5 s while the probes keep their schedule.
      async () => {
        await new Promise((done) => fx.context.setTimeout(done, 2_500));
        // The smoke itself, the query and its console host, and processes without a creation time or older than the
        // smoke are left out.
        return holderAnswer(700, holderRow(100, "node.exe", 1_000, 50, "C:\\node.exe", `node codex-install-smoke.mjs ${fx.root}`),
          holderRow(700, "powershell.exe", 5_000, 100, "C:\\powershell.exe", "powershell -NoProfile"), holderRow(701, "conhost.exe", 5_001, 700),
          holderRow(0, "System Idle Process", null, 0), wmi,
          holderRow(10, "svchost.exe", 999, 4, "C:\\Windows\\System32\\svchost.exe", `svchost.exe ${fx.root}`),
          // A path can appear in its short or long form, in either case and with either separator.
          holderRow(201, "codex.exe", 2_000, 100, "/long/npm/node_modules/@openai/codex/vendor/codex.exe"),
          holderRow(202, "node.exe", 2_500, 100, "C:\\node.exe", `"node.exe" "${fx.root.toUpperCase().replaceAll("/", "\\")}\\workspace" app-server`),
          holderRow(203, privateText, 3_000, 202, null, "cmd /c cd /long/root/private"));
      },
      holderAnswer(702, wmi, holderRow(703, "conhost.exe", 9_000, 702)), defenderAnswer(true),
    ] });
    await assert.rejects(fx.context.removeIsolatedDirectory(), (actual) => actual === fx.failure, label);
    assert.deepEqual(fx.calls, Array(probeRecords.length + 1).fill([fx.root, { recursive: true, force: true }]), label);
    const holders = {
      entries: remainingEntries,
      processes: { afterMs: [0, 2_500], total: 4, processes: [
        { name: "codex.exe", pid: 201, parentPid: 100, createdAt: new Date(2_000).toISOString(), inRoot: false, inNpmPrefix: true },
        { name: "node.exe", pid: 202, parentPid: 100, createdAt: new Date(2_500).toISOString(), inRoot: true, inNpmPrefix: false },
        { name: "unrecognized", pid: 203, parentPid: 202, createdAt: new Date(3_000).toISOString(), inRoot: true, inNpmPrefix: false },
        wmiRecord] },
      probes: probeRecords,
      processesAfterProbes: { afterMs: [end, end], total: 1, processes: [wmiRecord] },
      defender: { realTimeProtectionEnabled: true },
    };
    assert.deepEqual(fx.record(), { ...busyRecord("EBUSY"), holders }, label);
    // The failure is journaled before the observation and again with it.
    assert.deepEqual(fx.observations, [{ status: "started", attempt: 1 }, busyRecord("EBUSY"), fx.record()], label);
    assert.deepEqual(fx.warnings, [`::warning title=Codex cleanup::Directory removal failed with EBUSY; removal ${warning}, and the cleanup `
      + "still fails. Processes created since the smoke started and alive after the failure: "
      + "WmiPrvSE.exe, codex.exe, node.exe, unrecognized."], label);
    // Each query stops on its first error, keeps progress records off stderr, runs outside the isolated tree and ends with its budget.
    assert.deepEqual(fx.queries.map(({ file, args, options, at }) => [file, args.slice(0, 3), args[3].split("; ").slice(0, 2), options, at]),
      [0, end, end].map((at) => [["C:", "Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"],
        ["-NoProfile", "-NonInteractive", "-Command"], ["$ErrorActionPreference='Stop'", "$ProgressPreference='SilentlyContinue'"],
        { timeout: 2_000, maxBuffer: 16 * 1024 * 1024, encoding: "utf8", windowsHide: true }, at]), label);
    assert.deepEqual(fx.queries.map(({ args }) => /Get-CimInstance Win32_Process|Get-MpComputerStatus/.exec(args[3])?.[0]),
      ["Get-CimInstance Win32_Process", "Get-CimInstance Win32_Process", "Get-MpComputerStatus"], label);
    assertHolderPrivate(fx);
    // The evidence guard keeps the whole record: nothing is nested too deeply, too long or outside its character set.
    const directory = await mkdtemp(join(tmpdir(), "codex-holder-evidence-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    createEvidenceRecorder({ suite: "codex-install-smoke", client: "codex", directory })
      .finish({ testOutcome: "FAIL", failure: { directoryRemoval: fx.record() } });
    const result = JSON.parse(await readFile(join(directory, "codex-install-smoke", "result.json"), "utf8"));
    assert.deepEqual([result.failure.directoryRemoval, result.evidenceIssues], [fx.record(), []], label);
  }
});

test("a failed, silent-error or unfinished query records only why it has no value and keeps the removal failure", { timeout: 10_000 }, async (t) => {
  for (const [label, answer, expected] of [
    ["launch failure", () => Object.assign(new Error(privateText), { code: "ENOENT" }), { status: "observation_failed", code: "ENOENT" }],
    // A non-terminating error can still leave exit 0 and well-formed output; it must not read as a result.
    ["stderr with exit 0", () => ({ ...holderAnswer(700, wmi), stderr: "Get-CimInstance : " + privateText }), { status: "observation_failed" }],
    ["exit code", () => Object.assign(new Error(privateText), { code: 1, killed: false }), { status: "observation_failed" }],
    ["truncated output", () => ({ stdout: '{"query":', stderr: "" }), { status: "observation_failed" }],
    ["unexpected shape", () => ({ stdout: "[]", stderr: "" }), { status: "observation_failed" }],
    ["never returns", () => never, { status: "timed_out" }],
  ]) {
    const fx = await holderFixture(t, { answers: [answer(), answer(), answer()],
      budgets: { total: 60_000, entries: 2_000, processes: 50, defender: 50 } });
    await assert.rejects(fx.context.removeIsolatedDirectory(), (actual) => actual === fx.failure, label);
    assert.deepEqual(fx.record(), { ...busyRecord("EBUSY"), holders: { entries: remainingEntries, processes: expected,
      probes: [{ second: 1, afterMs: 1_000, removed: true }], processesAfterProbes: expected, defender: expected } }, label);
    assert.deepEqual(fx.warnings, ["::warning title=Codex cleanup::Directory removal failed with EBUSY; removal succeeded on a probe 1.0 s "
      + "after the failure, and the cleanup still fails. Processes created since the smoke started and alive after the failure: "
      + `unknown (${expected.status}).`], label);
    assertHolderPrivate(fx);
  }
  // A Defender status that is not a boolean is no answer either.
  const fx = await holderFixture(t, { answers: [holderAnswer(700), holderAnswer(701),
    { stdout: '{"realTimeProtectionEnabled":"True"}', stderr: "" }] });
  await assert.rejects(fx.context.removeIsolatedDirectory(), (actual) => actual === fx.failure);
  assert.deepEqual(fx.record().holders.defender, { status: "observation_failed" });
});

test("removal keeps its single attempt and adds no observation off Windows or after an error that is not busy", async (t) => {
  for (const [platform, code] of [["linux", "EBUSY"], ["darwin", "ENOTEMPTY"], ["win32", "EACCES"], ["win32", "EISDIR"]]) {
    const fx = await holderFixture(t, { platform, code });
    await assert.rejects(fx.context.removeIsolatedDirectory(), (actual) => actual === fx.failure, platform + code);
    assert.deepEqual([fx.calls.length, fx.queries, fx.warnings], [1, [], []], platform + code);
    assert.deepEqual(fx.record(), busyRecord(code), platform + code);
  }
});

test("an unexpected observation error ends the observation without replacing the removal failure", async (t) => {
  for (const code of ["EPERM", "ENOTEMPTY"]) {
    const fx = await holderFixture(t, { code, realpathError: Object.assign(new Error(privateText), { code: "EACCES" }) });
    await assert.rejects(fx.context.removeIsolatedDirectory(), (actual) => actual === fx.failure, code);
    assert.deepEqual([fx.calls.length, fx.queries], [1, []], code);
    assert.deepEqual(fx.record(), { ...busyRecord(code), holders: { status: "observation_failed", code: "EACCES" } }, code);
    assert.deepEqual(fx.warnings, [`::warning title=Codex cleanup::Directory removal failed with ${code}; removal was not probed again, `
      + "and the cleanup still fails. Processes created since the smoke started and alive after the failure: unknown (not observed)."], code);
    assertHolderPrivate(fx);
  }
});

test("the total budget stops probes after a wait and keeps later queries from starting", async (t) => {
  // The probe due at 4 s would start past the 3.5 s budget, and nothing is left for the later queries.
  const fx = await holderFixture(t, { probes: ["EBUSY", "EBUSY", "EBUSY"], answers: [holderAnswer(700, wmi)],
    budgets: { total: 3_500, entries: 2_000, processes: 2_000, defender: 2_000 } });
  await assert.rejects(fx.context.removeIsolatedDirectory(), (actual) => actual === fx.failure);
  assert.deepEqual([fx.calls.length, fx.queries.length], [3, 1]);
  assert.deepEqual(fx.record().holders, { entries: remainingEntries, processes: { afterMs: [0, 0], total: 1, processes: [wmiRecord] },
    probes: [{ second: 1, afterMs: 1_000, code: "EBUSY" }, { second: 2, afterMs: 2_000, code: "EBUSY" }],
    processesAfterProbes: { status: "budget_exhausted" }, defender: { status: "budget_exhausted" } });
  assert.match(fx.warnings[0], /removal still failed with EBUSY 2\.0 s after the failure/);
});

test("what remains under the failed path keeps 20 sorted relative names, each projected segment by segment", async (t) => {
  const fx = await holderFixture(t), inspect = fx.context.inspectRemovalPath, directory = join(fx.root, "many");
  await mkdir(join(directory, "b 测试"), { recursive: true });
  await writeFile(join(directory, "a$odd"), "");
  await writeFile(join(directory, "b 测试", "c.log"), "");
  const files = Array.from({ length: 22 }, (_, index) => `file-${String(index).padStart(2, "0")}.log`);
  for (const name of files) await writeFile(join(directory, name), "");
  assert.deepEqual(plain(await inspect(directory)), { exists: true, directory: true, total: 25,
    names: ["<segment>", "b 测试", "b 测试/c.log", ...files.slice(0, 17)] });
  assert.deepEqual(plain(await inspect(join(directory, "a$odd"))), { exists: true, directory: false });
  assert.deepEqual(plain(await inspect(join(directory, "missing"))), { exists: false });
  await assert.rejects(inspect(join(directory, "a$odd", "below")), { code: "ENOTDIR" });
});

test("process records stop at the evidence item limit, keeping first those that name the isolated root or npm prefix", async (t) => {
  const classify = (await holderFixture(t)).context.classifyHolderProcesses;
  const rows = Array.from({ length: 40 }, (_, index) => holderRow(1_000 + index, "svchost.exe", 2_000 + index, 4));
  const result = plain(classify([...rows, holderRow(2_000, "codex.exe", 9_000, 100, "/fixture/npm/codex.exe")],
    { root: ["/fixture/root"], npmPrefix: ["/fixture/npm"] }, { self: 100, query: 700, since: 1_000 }));
  assert.deepEqual([result.total, result.processes.length, result.processes[0].name, result.processes[1].pid, result.processes.at(-1).pid],
    [41, 32, "codex.exe", 1_000, 1_030]);
});
