import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { appendFile, chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  appendLedger, createEvidenceRecorder, exportStatus, finalizeLedger, phaseLedger, planLedger, prepareEvidenceDirectory, readJournal,
  readLedger, recordInputs, recordManifest, renderSummary, summarizeEvidence,
} from "./ci-evidence.mjs";
import {
  inventoryRepoMemoryJobs, projectError, projectPathAlias, projectProcessRoles, projectProductDiagnostics, projectRepoMemoryJobs,
  projectTraceEvents,
} from "./ci-evidence-projections.mjs";

const helper = fileURLToPath(new URL("./ci-evidence.mjs", import.meta.url));
const helperUrl = pathToFileURL(helper).href;
const secret = `sk_${"E".repeat(43)}`;

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), "memorax-ci-evidence-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const journalOf = (directory, suite) => readJournal(join(directory, suite, "journal.jsonl"));
const resultOf = async (directory, suite) => JSON.parse(await readFile(join(directory, suite, "result.json"), "utf8"));
const cli = (...args) => spawnSync(process.execPath, [helper, ...args], { encoding: "utf8" });

test("a recorder without an evidence directory is disabled and never throws", async () => {
  const evidence = createEvidenceRecorder({ suite: "fixture-suite", client: "codex", directory: "" });
  evidence.observe("progress", { stage: "setup" });
  evidence.track(() => ({ stage: "setup" }))();
  assert.deepEqual(await evidence.collect("fixture", () => ({ ok: true })), { status: "OK", value: { ok: true } });
  assert.equal(evidence.finish({ testOutcome: "FAIL" }), "DISABLED");
});

test("observations persist on change, coalesce inside the throttle window and flush the newest value", async (t) => {
  const directory = await workspace(t);
  let clock = 0;
  const evidence = createEvidenceRecorder({ suite: "fixture-suite", client: "opencode", directory, now: () => clock,
    limits: { throttleMs: 1000 } });
  evidence.observe("jobs", { status: "preparing" });
  evidence.observe("jobs", { status: "preparing" });
  clock = 10; evidence.observe("jobs", { status: "started" });
  clock = 20; evidence.observe("jobs", { status: "running" });
  clock = 1500; evidence.observe("jobs", { status: "failed" });
  clock = 1510; evidence.observe("jobs", { status: "running" });
  assert.equal(evidence.finish({ testOutcome: "FAIL" }), "COMPLETE");
  const journal = journalOf(directory, "fixture-suite");
  assert.equal(journal.truncatedTail, false);
  assert.deepEqual(journal.records.filter((record) => record.kind === "observe").map((record) => record.value.status),
    ["preparing", "failed", "running"]);
  assert.deepEqual(journal.records.map((record) => record.seq), journal.records.map((_, index) => index + 1));
  assert.deepEqual(journal.records.map((record) => record.kind), ["start", "observe", "observe", "observe", "finish"]);
  const result = await resultOf(directory, "fixture-suite");
  assert.equal(result.testOutcome, "FAIL");
  assert.equal(result.evidenceStatus, "COMPLETE");
});

test("a pending observation is written when its throttle window closes without another change", async (t) => {
  const directory = await workspace(t);
  const evidence = createEvidenceRecorder({ suite: "fixture-suite", client: "codex", directory, limits: { throttleMs: 40 } });
  evidence.observe("jobs", { count: 0 });
  evidence.observe("jobs", { count: 1 });
  await new Promise((done) => setTimeout(done, 150));
  assert.deepEqual(journalOf(directory, "fixture-suite").records.filter((record) => record.kind === "observe")
    .map((record) => record.value.count), [0, 1]);
  evidence.finish({ testOutcome: "PASS" });
});

test("a killed runner leaves every complete record readable", async (t) => {
  const directory = await workspace(t);
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { createEvidenceRecorder } from ${JSON.stringify(helperUrl)};
    const evidence = createEvidenceRecorder({ suite: "killed-suite", client: "codex", directory: process.argv[1],
      limits: { throttleMs: 0, maxRecords: 1e6, maxPerKey: 1e6, maxBytes: 256 * 1024 * 1024 } });
    let count = 0;
    const tick = () => { for (let i = 0; i < 50; i += 1) evidence.observe("progress", { count: ++count, padding: "x".repeat(4000) }); setImmediate(tick); };
    tick();
  `, directory], { stdio: "ignore" });
  const exited = new Promise((done) => child.once("exit", (code, signal) => done({ code, signal })));
  const deadline = Date.now() + 15_000;
  for (;;) {
    let records = 0;
    try { records = journalOf(directory, "killed-suite").records.length; } catch {}
    if (records >= 300) break;
    assert.ok(Date.now() < deadline, "the fixture runner did not write enough records");
    await new Promise((done) => setTimeout(done, 20));
  }
  child.kill("SIGKILL");
  assert.equal((await exited).signal, "SIGKILL");
  const journal = journalOf(directory, "killed-suite");
  assert.equal(journal.invalidLines, 0);
  assert.equal(typeof journal.truncatedTail, "boolean");
  assert.ok(journal.records.length >= 300);
  assert.deepEqual(journal.records.map((record) => record.seq), journal.records.map((_, index) => index + 1));
  const counts = journal.records.filter((record) => record.kind === "observe").map((record) => record.value.count);
  assert.deepEqual(counts, counts.map((_, index) => index + 1));
  await assert.rejects(readFile(join(directory, "killed-suite", "result.json")), { code: "ENOENT" });
});

test("an interrupted final write is reported as a truncated tail, not parsed", async (t) => {
  const path = join(await workspace(t), "journal.jsonl");
  await writeFile(path, `${JSON.stringify({ v: 1, seq: 1 })}\n${JSON.stringify({ v: 1, seq: 2 })}\n{"v":1,"seq":3,"kind":"obs`);
  const journal = readJournal(path);
  assert.deepEqual(journal.records.map((record) => record.seq), [1, 2]);
  assert.equal(journal.truncatedTail, true);
  assert.equal(journal.invalidLines, 0);
});

test("evidence failures never change the test outcome or the exit code", async (t) => {
  const root = await workspace(t);
  const fixture = `
    import { chmodSync } from "node:fs";
    import { join } from "node:path";
    import { createEvidenceRecorder } from ${JSON.stringify(helperUrl)};
    const [directory, outcome, fault] = process.argv.slice(1);
    const report = { status: outcome };
    const evidence = createEvidenceRecorder({ suite: "fixture-suite", client: "opencode", directory });
    evidence.track(() => ({ stage: "fixture stage" }));
    if (fault === "result-unwritable") chmodSync(join(directory, "fixture-suite"), 0o500);
    report.evidenceStatus = evidence.finish({ testOutcome: report.status,
      failure: outcome === "FAIL" ? { kind: "functional", stage: "fixture stage", code: "FIXTURE_FAILED" } : undefined });
    console.log(JSON.stringify(report));
    if (report.status !== "PASS") process.exitCode = 1;
  `;
  const cases = [["valid", "COMPLETE"], ["file", "UNAVAILABLE"], ["existing-suite", "UNAVAILABLE"]];
  if (process.platform !== "win32" && process.getuid?.() !== 0) cases.push(["result-unwritable", "PARTIAL"]);
  for (const [fault, expected] of cases) {
    for (const outcome of ["PASS", "FAIL"]) {
      const directory = join(root, `${fault}-${outcome}`);
      if (fault === "file") await writeFile(directory, "not a directory");
      else await mkdir(fault === "existing-suite" ? join(directory, "fixture-suite") : directory, { recursive: true });
      const run = spawnSync(process.execPath, ["--input-type=module", "-e", fixture, directory, outcome, fault], { encoding: "utf8" });
      assert.equal(run.status, outcome === "PASS" ? 0 : 1, `${fault} ${outcome}: ${run.stderr}`);
      assert.deepEqual(JSON.parse(run.stdout), { status: outcome, evidenceStatus: expected });
      if (fault === "result-unwritable") await chmod(join(directory, "fixture-suite"), 0o700);
    }
  }
});

test("collectors run under their own budget, record failures and never replace the original error", async (t) => {
  const directory = await workspace(t);
  const evidence = createEvidenceRecorder({ suite: "fixture-suite", client: "opencode", directory });
  const original = Object.assign(new Error("BACKGROUND_JOB_DID_NOT_FINISH"), { nativeCode: "BACKGROUND_JOB_DID_NOT_FINISH" });
  const started = performance.now();
  await assert.rejects(async () => {
    try { throw original; }
    catch (error) {
      assert.deepEqual(await evidence.collect("hangs", () => new Promise(() => {}), { budgetMs: 50 }), { status: "TIMEOUT" });
      const failed = await evidence.collect("throws", () => { throw Object.assign(new Error(secret), { code: "EBUSY" }); });
      assert.deepEqual(failed, { status: "FAILED", error: { name: "Error", code: "EBUSY" } });
      throw error;
    }
  }, (error) => error === original);
  assert.ok(performance.now() - started < 2_000);
  assert.equal(evidence.status, "PARTIAL");
  assert.deepEqual(evidence.issues, ["COLLECT_FAILED", "COLLECT_TIMEOUT"]);
  assert.equal(evidence.finish({ testOutcome: "FAIL" }), "PARTIAL");
  const collected = journalOf(directory, "fixture-suite").records.filter((record) => record.kind === "collect");
  assert.deepEqual(collected.map(({ name, status }) => [name, status]), [["hangs", "TIMEOUT"], ["throws", "FAILED"]]);
  assert.doesNotMatch(await readFile(join(directory, "fixture-suite", "journal.jsonl"), "utf8"), new RegExp(secret));
});

test("an awaited collector keeps its deadline alive without other handles and releases it after settling", async (t) => {
  const root = await workspace(t);
  const script = [
    "import { createEvidenceRecorder } from " + JSON.stringify(helperUrl) + ";",
    'const evidence = createEvidenceRecorder({ suite: "standalone-suite", client: "codex", directory: process.argv[1] });',
    'const mode = process.argv[2];',
    'const result = await evidence.collect("fixture", () => {',
    '  if (mode === "hangs") return new Promise(() => {});',
    '  if (mode === "throws") throw Object.assign(new Error("private fixture"), { code: "EBUSY" });',
    '  return { ok: true };',
    '}, { budgetMs: mode === "hangs" ? 50 : 10000 });',
    'evidence.finish({ testOutcome: "FAIL", failure: { kind: "functional", code: "PRIMARY_FAILURE" } });',
    'console.log(JSON.stringify(result));',
    'process.exitCode = 7;',
  ].join("\n");
  for (const [mode, expected] of [["hangs", "TIMEOUT"], ["returns", "OK"], ["throws", "FAILED"]]) {
    const directory = join(root, mode);
    await mkdir(directory);
    // The child has no test-runner handles. Fast collectors must also clear their
    // ten-second budget so this process exits before the five-second outer limit.
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script, directory, mode], {
      encoding: "utf8", timeout: 5000,
    });
    assert.equal(child.error, undefined, mode);
    assert.equal(child.signal, null, mode);
    assert.equal(child.status, 7, mode);
    assert.equal(JSON.parse(child.stdout).status, expected);
    const result = await resultOf(directory, "standalone-suite");
    assert.equal(result.testOutcome, "FAIL");
    assert.equal(result.failure.code, "PRIMARY_FAILURE");
    assert.deepEqual(journalOf(directory, "standalone-suite").records.filter((record) => record.kind === "collect")
      .map((record) => record.status), [expected]);
  }
});

test("the structural guard rejects control characters and unnamed keys instead of recording them", async (t) => {
  const directory = await workspace(t);
  const evidence = createEvidenceRecorder({ suite: "fixture-suite", client: "codex", directory });
  evidence.observe("progress", { stage: "line\nbreak", "bad key": 1, nested: { ok: true } });
  assert.equal(evidence.finish({ testOutcome: "PASS" }), "PARTIAL");
  const observed = journalOf(directory, "fixture-suite").records.find((record) => record.kind === "observe");
  assert.deepEqual(observed.value, { stage: "<rejected>", nested: { ok: true } });
  const result = await resultOf(directory, "fixture-suite");
  assert.equal(result.testOutcome, "PASS");
  assert.deepEqual(result.evidenceIssues, ["VALUE_REJECTED"]);
});

test("typed projections keep allowlisted fields and drop free text, secrets and paths", async (t) => {
  const root = await workspace(t);
  const diagnostics = projectProductDiagnostics({ action: "diagnostics", ok: true, skipped: 0, records: [{
    schemaVersion: 1, id: "mc-1760594400000-12345678-1234-1234-1234-123456789abc", timestamp: "2026-10-16T06:00:00.000Z",
    source: "cli", operation: "update", stage: "transition_read", errorCode: "UPDATE_INSTALL_FAILED", systemCode: "EBUSY",
    error: `Update failed for ${root} with ${secret}`, impact: "Free text impact.", userAction: "Free text guidance.",
    sessionHash: "abc123", commandExitCode: 23, recoveryStatus: "restored", platform: "win32", unknown: secret,
  }] });
  assert.deepEqual(Object.keys(diagnostics.records[0]).sort(),
    ["commandExitCode", "errorCode", "id", "operation", "platform", "recoveryStatus", "source", "stage", "systemCode", "timestamp"]);
  const jobs = projectRepoMemoryJobs([{ status: "running", mode: "build", runner: "opencode", workerPid: 101, childPid: 0,
    prompt: `Repository: ${root} ${secret}`, command: ["opencode", secret], repo: root, outputLogPath: join(root, "output.log"),
    startedAt: "2026-10-16T06:00:01.000Z" }], { since: Date.parse("2026-10-16T06:00:00.000Z"), alive: (pid) => pid === 101 });
  assert.deepEqual(jobs, { count: 1, jobs: [{ status: "running", mode: "build", runner: "opencode", worker: "alive", child: "absent",
    startedAtMs: 1000 }] });
  for (const value of [diagnostics, jobs]) {
    const text = JSON.stringify(value);
    assert.doesNotMatch(text, new RegExp(secret));
    assert.equal(text.includes(root), false);
  }
  assert.equal(projectPathAlias(join(root, "upgrade user 测试", ".memorax-code", "backend.log"), { root }),
    "<root>/upgrade user 测试/.memorax-code/backend.log");
  assert.equal(projectPathAlias(join(root, "..", "outside"), { root }), undefined);
  assert.equal(projectPathAlias(join(root, "bad\nsegment"), { root }), "<root>/<segment>");
  assert.equal(projectPathAlias("relative/path", { root }), undefined);
  assert.deepEqual(projectError(Object.assign(new Error(secret), { code: "EPERM", nativeOperation: "REPO_JOB_READ" })),
    { name: "Error", code: "EPERM", operation: "REPO_JOB_READ" });
  assert.deepEqual(projectProcessRoles([{ role: "openCodeServer", child: { pid: 7, exitCode: 3, signalCode: null } },
    { role: "backend", pid: 9 }, { role: "worker" }], (pid) => pid === 9),
  { openCodeServer: { state: "exited", exitCode: 3 }, backend: { state: "alive" }, worker: { state: "absent" } });
});

test("state readers report trace types, file sizes and timing without content", async (t) => {
  const stateHome = await workspace(t);
  const session = join(stateHome, "debug", "traces", "opencode", "2026-10-16", "session-a");
  await mkdir(session, { recursive: true });
  await writeFile(join(session, "events.jsonl"), [
    JSON.stringify({ type: "turn_start", operation: "memory.turn-start", source: "opencode-plugin", ok: true,
      timestamp: "2026-10-16T06:00:02.000Z", request: { prompt: secret } }),
    "not json",
    JSON.stringify({ type: "Bad Type", timestamp: "2026-10-16T06:00:03.000Z" }),
    "",
  ].join("\n"));
  const trace = await projectTraceEvents(stateHome, "opencode", { since: Date.parse("2026-10-16T06:00:00.000Z") });
  assert.deepEqual(trace.events, [{ type: "turn_start", operation: "memory.turn-start", source: "opencode-plugin", ok: true, tMs: 2000 }]);
  assert.equal(trace.malformed, 2);
  assert.doesNotMatch(JSON.stringify(trace), new RegExp(secret));
  const jobsRoot = join(stateHome, "repo-memory-jobs");
  await mkdir(join(jobsRoot, "20261016-build-fixture"), { recursive: true });
  await mkdir(join(jobsRoot, "in-progress"));
  await writeFile(join(jobsRoot, "20261016-build-fixture", "job.json"), JSON.stringify({ prompt: secret }));
  await writeFile(join(jobsRoot, "20261016-build-fixture", "output.log"), `worker output ${secret}`);
  await writeFile(join(jobsRoot, "in-progress", "repo-key.json"), "{}");
  const inventory = await inventoryRepoMemoryJobs(stateHome);
  assert.deepEqual(inventory, { present: true, jobDirectories: 1, inProgressMarkers: 1,
    jobs: [{ "job.json": JSON.stringify({ prompt: secret }).length, "output.log": `worker output ${secret}`.length, "final-message.txt": null }] });
  assert.deepEqual(await inventoryRepoMemoryJobs(join(stateHome, "missing")), { present: false });
});

test("the ledger marks unreached suites NOT_RUN and interrupted suites INCOMPLETE without hiding a failure", async (t) => {
  const directory = await workspace(t);
  appendLedger(directory, "skip", "codex-model-inheritance-check", "pending_implementation");
  appendLedger(directory, "start", "codex-install-smoke");
  appendLedger(directory, "end", "codex-install-smoke", "1");
  appendLedger(directory, "start", "codex-native-check");
  const planned = ["codex-install-smoke", "codex-native-check", "codex-permissions-check"];
  finalizeLedger(directory, planned);
  finalizeLedger(directory, planned);
  const statuses = Object.fromEntries([...readLedger(directory).suites.values()].map((entry) => [entry.suite, entry.status]));
  assert.deepEqual(statuses, { "codex-model-inheritance-check": "SKIPPED_BY_DESIGN", "codex-install-smoke": "FAIL",
    "codex-native-check": "INCOMPLETE", "codex-permissions-check": "NOT_RUN" });
  assert.throws(() => appendLedger(directory, "end", "codex-install-smoke", "not-a-number"));
  assert.throws(() => appendLedger(directory, "skip", "codex-install-smoke", "free text"));
  const plannedDirectory = await workspace(t);
  planLedger(plannedDirectory, ["first-suite", "second-suite"]);
  appendLedger(plannedDirectory, "start", "first-suite");
  finalizeLedger(plannedDirectory, ["first-suite", "second-suite"]);
  assert.deepEqual([...readLedger(plannedDirectory).suites.values()].map(({ suite, status }) => [suite, status]),
    [["first-suite", "INCOMPLETE"], ["second-suite", "NOT_RUN"]]);
  assert.throws(() => planLedger(plannedDirectory, ["Not A Suite"]));
  const fresh = await workspace(t);
  assert.equal(cli("ledger", fresh, "finalize", "a-suite,b-suite").status, 0);
  assert.deepEqual([...readLedger(fresh).suites.values()].map((entry) => entry.status), ["NOT_RUN", "NOT_RUN"]);
  assert.equal(cli("ledger", fresh, "end", "a-suite").status, 2);
});

async function evidenceRoot(t, { ledger = [], suites = {}, inputs = true, ledgerFile = true }) {
  const root = await workspace(t);
  await mkdir(join(root, "suites"));
  if (inputs) await writeFile(join(root, "inputs.json"), JSON.stringify({ schemaVersion: 1 }));
  if (ledgerFile) await writeFile(join(root, "suites", "ledger.jsonl"), "");
  for (const [event, suite, detail] of ledger) {
    if (event === "plan") planLedger(join(root, "suites"), detail.split(","));
    else if (event === "phase") phaseLedger(join(root, "suites"), detail);
    else appendLedger(join(root, "suites"), event, suite, detail);
  }
  for (const [suite, { progress, result, journal }] of Object.entries(suites)) {
    await mkdir(join(root, "suites", suite));
    const records = [{ v: 1, seq: 1, t: 0, kind: "start", suite }, { v: 1, seq: 2, t: 5, kind: "observe", key: "progress", value: progress }];
    await writeFile(join(root, "suites", suite, "journal.jsonl"), journal ?? records.map((record) => `${JSON.stringify(record)}\n`).join(""));
    if (result) await writeFile(join(root, "suites", suite, "result.json"), JSON.stringify(result));
  }
  return root;
}

test("the job summary separates testOutcome, failure category, evidenceStatus and signature", async (t) => {
  const cleanup = await evidenceRoot(t, {
    ledger: [["skip", "codex-model-inheritance-check", "pending_implementation"], ["start", "codex-install-smoke"],
      ["end", "codex-install-smoke", "1"]],
    suites: { "codex-install-smoke": { progress: { stage: "outbound isolation", cleanupStage: "directory_removal", checks: 30 },
      result: { schemaVersion: 1, testOutcome: "FAIL", evidenceStatus: "COMPLETE", failure: { kind: "cleanup",
        code: "CLEANUP_DIRECTORY_REMOVAL_FAILED:EBUSY", cleanupStage: "directory_removal", shutdownConfirmed: true,
        cleanupPath: "<root>/upgrade user 测试/update npm cache/_cacache", checksPassed: 30 } } } },
  });
  finalizeLedger(join(cleanup, "suites"), ["codex-install-smoke", "codex-native-check", "codex-permissions-check"]);
  const summary = summarizeEvidence(cleanup, { client: "codex", os: "windows-2025", channel: "latest", clientVersion: "0.163.0",
    node: "24", testStepOutcome: "failure", runAttempt: "1" });
  assert.equal(summary.testOutcome, "FAIL");
  assert.equal(summary.category, "cleanup");
  assert.equal(summary.signature, "codex|windows-2025|codex-install-smoke|cleanup:directory_removal|CLEANUP_DIRECTORY_REMOVAL_FAILED:EBUSY");
  assert.equal(summary.evidenceStatus, "COMPLETE");
  assert.deepEqual(summary.suites.map(({ suite, status, evidence }) => [suite, status, evidence]), [
    ["codex-model-inheritance-check", "SKIPPED_BY_DESIGN", "not_instrumented"], ["codex-install-smoke", "FAIL", "recorded"],
    ["codex-native-check", "NOT_RUN", "not_instrumented"], ["codex-permissions-check", "NOT_RUN", "not_instrumented"]]);
  assert.deepEqual(JSON.parse(await readFile(join(cleanup, "summary.json"), "utf8")), summary);

  // The wrapper was killed too: its plan is the only record of the suites it never reached.
  const interrupted = await evidenceRoot(t, { ledger: [["plan", "", "opencode-install-smoke,opencode-native-check,opencode-permissions-check"],
    ["start", "opencode-install-smoke"], ["end", "opencode-install-smoke", "0"], ["start", "opencode-native-check"]],
    suites: { "opencode-native-check": { progress: { stage: "default global model and real Repo Memory worker",
      backgroundStage: "background job wait", checks: 6 } } } });
  const killed = summarizeEvidence(interrupted, { client: "opencode", os: "windows-2025", testStepOutcome: "failure" });
  assert.equal(killed.category, "interrupted");
  assert.equal(killed.signature, "opencode|windows-2025|opencode-native-check|default global model and real Repo Memory worker/background job wait|INCOMPLETE");
  assert.equal(killed.evidenceStatus, "PARTIAL");
  assert.deepEqual(killed.evidenceIssues, ["RESULT_MISSING_OPENCODE_NATIVE_CHECK"]);
  assert.deepEqual(killed.suites.map(({ suite, status }) => [suite, status]), [["opencode-install-smoke", "PASS"],
    ["opencode-native-check", "INCOMPLETE"], ["opencode-permissions-check", "NOT_RUN"]]);

  const setup = await evidenceRoot(t, { ledger: [["phase", "", "setup"], ["skip", "codex-model-inheritance-check", "pending_implementation"]] });
  const beforeSuites = summarizeEvidence(setup, { client: "codex", os: "ubuntu-24.04", testStepOutcome: "failure" });
  assert.equal(beforeSuites.category, "setup");
  assert.equal(beforeSuites.signature, "codex|ubuntu-24.04|wrapper|setup|WRAPPER_SETUP_FAILED");

  const passing = await evidenceRoot(t, { ledger: [["start", "codex-install-smoke"], ["end", "codex-install-smoke", "0"]],
    suites: { "codex-install-smoke": { progress: { stage: "outbound isolation" },
      result: { schemaVersion: 1, testOutcome: "PASS", evidenceStatus: "PARTIAL" } } } });
  const green = summarizeEvidence(passing, { client: "codex", os: "macos-15", testStepOutcome: "success", runAttempt: "2" });
  assert.equal(green.testOutcome, "PASS");
  assert.equal(green.signature, undefined);
  assert.equal(green.evidenceStatus, "PARTIAL");
  assert.match(renderSummary(green), /re-run attempt 2/);
  assert.match(renderSummary(summary), /signature: `codex\|windows-2025\|codex-install-smoke\|cleanup:directory_removal/);
});

test("the summary expects evidence only from instrumented suites that ran and classifies wrapper failures by phase", async (t) => {
  const summarize = async (setup, testStepOutcome, client = "codex") =>
    summarizeEvidence(await evidenceRoot(t, setup), { client, os: "windows-2025", testStepOutcome });
  const view = (summary) => summary.suites.map(({ suite, status, evidence }) => [suite, status, evidence]);
  const phases = (...names) => names.map((name) => ["phase", "", name]);
  const passed = { schemaVersion: 1, testOutcome: "PASS", evidenceStatus: "COMPLETE" };

  // An instrumented suite that ran owes a journal and a result.
  const missing = await summarize({ ledger: [["plan", "", "codex-install-smoke,codex-native-check"], ...phases("setup", "suites"),
    ["start", "codex-install-smoke"], ["end", "codex-install-smoke", "1"]] }, "failure");
  assert.deepEqual(view(missing), [["codex-install-smoke", "FAIL", "missing"], ["codex-native-check", "NOT_RUN", "not_instrumented"]]);
  assert.deepEqual([missing.evidenceStatus, missing.evidenceIssues], ["PARTIAL", ["JOURNAL_MISSING_CODEX_INSTALL_SMOKE"]]);
  assert.equal(missing.signature, "codex|windows-2025|codex-install-smoke|unknown|EXIT_1");
  assert.match(renderSummary(missing), /codex-install-smoke \*\*FAIL\*\* \(exit 1, evidence missing\)/);

  // Uninstrumented suites and suites the wrapper never reached owe nothing.
  const unowed = await summarize({ ledger: [["plan", "", "opencode-install-smoke,opencode-native-check"], ...phases("setup", "suites"),
    ["start", "opencode-install-smoke"], ["end", "opencode-install-smoke", "1"]] }, "failure", "opencode");
  assert.deepEqual(view(unowed), [["opencode-install-smoke", "FAIL", "not_instrumented"], ["opencode-native-check", "NOT_RUN", "not_run"]]);
  assert.deepEqual([unowed.evidenceStatus, unowed.evidenceIssues], ["COMPLETE", []]);

  // A skipped step never started the wrapper; a step that ran without leaving a ledger lost its evidence.
  const skipped = await summarize({ ledgerFile: false }, "skipped");
  assert.deepEqual([skipped.testOutcome, skipped.evidenceStatus, skipped.evidenceIssues], ["NOT_RUN", "COMPLETE", []]);
  for (const [outcome, testOutcome] of [["success", "PASS"], ["failure", "FAIL"]]) {
    const lost = await summarize({ ledgerFile: false }, outcome);
    assert.deepEqual([lost.testOutcome, lost.evidenceStatus, lost.evidenceIssues], [testOutcome, "UNAVAILABLE", ["LEDGER_MISSING"]]);
  }
  // Input recording that never ran owes no inputs; recording that ran without leaving them lost them.
  for (const [inputsStepOutcome, evidenceStatus, evidenceIssues] of [["skipped", "COMPLETE", []], ["success", "PARTIAL", ["INPUTS_MISSING"]]]) {
    const inputs = summarizeEvidence(await evidenceRoot(t, { inputs: false, ledgerFile: false }),
      { client: "codex", os: "windows-2025", inputsStepOutcome, testStepOutcome: "skipped" });
    assert.deepEqual([inputs.testOutcome, inputs.evidenceStatus, inputs.evidenceIssues], ["NOT_RUN", evidenceStatus, evidenceIssues]);
  }

  // Damaged lines and a result that contradicts the recorded exit status are reported, not dropped.
  const journal = `${JSON.stringify({ v: 1, seq: 1, t: 0, kind: "start", suite: "codex-install-smoke" })}\nnot json\n${
    JSON.stringify({ v: 1, seq: 3, t: 5, kind: "observe", key: "progress", value: { stage: "doctor" } })}\n`;
  const ranAndCleaned = [...phases("setup", "suites"), ["start", "codex-install-smoke"], ["end", "codex-install-smoke", "0"], ...phases("cleanup")];
  const damagedRoot = await evidenceRoot(t, { ledger: ranAndCleaned,
    suites: { "codex-install-smoke": { journal, result: { ...passed, testOutcome: "FAIL" } } } });
  await appendFile(join(damagedRoot, "suites", "ledger.jsonl"), "{broken\n");
  const damaged = summarizeEvidence(damagedRoot, { client: "codex", os: "windows-2025", testStepOutcome: "success" });
  assert.deepEqual(view(damaged), [["codex-install-smoke", "PASS", "partial"]]);
  assert.deepEqual([damaged.evidenceStatus, damaged.evidenceIssues], ["PARTIAL",
    ["JOURNAL_INVALID_LINES_CODEX_INSTALL_SMOKE", "LEDGER_INVALID_LINES", "RESULT_OUTCOME_MISMATCH_CODEX_INSTALL_SMOKE"]]);
  assert.equal(damaged.suites[0].lastProgress.stage, "doctor");

  // Records past the read limit are reported as a truncated read, not as an interrupted write.
  const largeRoot = await evidenceRoot(t, { ledger: ranAndCleaned,
    suites: { "codex-install-smoke": { progress: { stage: "doctor" }, result: passed } } });
  const padding = `${JSON.stringify({ v: 1, kind: "observe", key: "padding", value: "x".repeat(1000) })}\n`.repeat(4300);
  for (const file of ["ledger.jsonl", "codex-install-smoke/journal.jsonl"]) await appendFile(join(largeRoot, "suites", file), padding);
  const large = summarizeEvidence(largeRoot, { client: "codex", os: "windows-2025", testStepOutcome: "success" });
  assert.deepEqual([large.evidenceStatus, large.evidenceIssues], ["PARTIAL", ["JOURNAL_READ_TRUNCATED_CODEX_INSTALL_SMOKE", "LEDGER_READ_TRUNCATED"]]);
  assert.deepEqual([view(large), large.suites[0].lastProgress], [[["codex-install-smoke", "PASS", "partial"]], { stage: "doctor" }]);

  // A wrapper that fails after every suite passed failed in its own cleanup, not in setup.
  const allPassed = { ledger: [["plan", "", "opencode-install-smoke,opencode-native-check"], ...phases("setup", "suites"),
    ["start", "opencode-install-smoke"], ["end", "opencode-install-smoke", "0"], ["start", "opencode-native-check"], ["end", "opencode-native-check", "0"]],
  suites: { "opencode-native-check": { progress: { stage: "server shutdown" }, result: passed } } };
  const wrapperCleanup = await summarize({ ...allPassed, ledger: [...allPassed.ledger, ...phases("cleanup")] }, "failure", "opencode");
  assert.deepEqual([wrapperCleanup.testOutcome, wrapperCleanup.category, wrapperCleanup.wrapperPhase, wrapperCleanup.evidenceStatus],
    ["FAIL", "wrapper_cleanup", "cleanup", "COMPLETE"]);
  assert.equal(wrapperCleanup.signature, "opencode|windows-2025|wrapper|cleanup|WRAPPER_CLEANUP_FAILED");

  // Outside setup and wrapper cleanup the failing location is unknown and is not guessed.
  const betweenSuites = await summarize(allPassed, "failure", "opencode");
  assert.deepEqual([betweenSuites.category, betweenSuites.signature], ["unclassified", "opencode|windows-2025|wrapper|suites|WRAPPER_FAILED"]);
  const noPhase = await summarize({ ledger: [["skip", "codex-model-inheritance-check", "pending_implementation"]] }, "failure");
  assert.deepEqual([noPhase.category, noPhase.signature], ["unclassified", "codex|windows-2025|wrapper|unknown|WRAPPER_FAILED"]);

  // A passing step keeps its outcome when the ledger records a failure; the conflict is an evidence issue.
  const conflicting = await summarize({ ledger: [...phases("setup", "suites"), ["start", "opencode-install-smoke"],
    ["end", "opencode-install-smoke", "1"]] }, "success", "opencode");
  assert.deepEqual([conflicting.testOutcome, conflicting.evidenceStatus, conflicting.evidenceIssues], ["PASS", "PARTIAL", ["LEDGER_OUTCOME_MISMATCH"]]);
  // The wrapper never confirmed these exits, so the missing end record is an evidence gap either way. A failure
  // the runner reported is kept; a reported pass, or a failure without a reason, leaves the completion unconfirmed.
  const unconfirmedExit = (result) => summarize({ ledger: [...phases("setup", "suites"), ["start", "codex-install-smoke"]],
    suites: { "codex-install-smoke": { progress: { stage: "doctor" }, result } } }, "failure");
  const reported = await unconfirmedExit({ ...passed, testOutcome: "FAIL",
    failure: { kind: "cleanup", code: "CLEANUP_DIRECTORY_REMOVAL_FAILED:EBUSY", cleanupStage: "directory_removal" } });
  assert.deepEqual([reported.category, reported.signature, reported.evidenceIssues], ["cleanup",
    "codex|windows-2025|codex-install-smoke|cleanup:directory_removal|CLEANUP_DIRECTORY_REMOVAL_FAILED:EBUSY",
    ["LEDGER_END_MISSING_CODEX_INSTALL_SMOKE"]]);
  assert.deepEqual(reported.suites.map(({ status, reportedOutcome }) => [status, reportedOutcome]), [["INCOMPLETE", "FAIL"]]);
  for (const result of [passed, { ...passed, testOutcome: "FAIL" }]) {
    const unconfirmed = await unconfirmedExit(result);
    assert.deepEqual([unconfirmed.category, unconfirmed.signature, unconfirmed.evidenceStatus, unconfirmed.evidenceIssues], ["unclassified",
      "codex|windows-2025|codex-install-smoke|doctor|EXIT_UNCONFIRMED", "PARTIAL", ["LEDGER_END_MISSING_CODEX_INSTALL_SMOKE"]]);
    assert.deepEqual(unconfirmed.suites.map(({ status, reportedOutcome }) => [status, reportedOutcome]), [["INCOMPLETE", result.testOutcome]]);
  }
  assert.match(renderSummary(await unconfirmedExit(passed)), /codex-install-smoke INCOMPLETE \(runner reported PASS, evidence partial\)/);
});

test("the export status counts only a successful upload with an artifact ID and never fails the job", async (t) => {
  for (const [outcome, artifactId, expected] of [["success", "4567890123", "UPLOADED"], ["success", "", "EMPTY"],
    ["success", undefined, "EMPTY"], ["success", "not-an-id", "EMPTY"], ["failure", "", "UPLOAD_FAILED"],
    ["cancelled", "", "UPLOAD_FAILED"], ["skipped", "", "NOT_ATTEMPTED"]]) {
    assert.equal(exportStatus({ outcome, artifactId }), expected, `${outcome} ${artifactId}`);
  }
  const root = await workspace(t);
  const jobSummary = join(root, "summary.md");
  const report = (outcome, artifactId, file = jobSummary) =>
    cli("export-status", "--outcome", outcome, "--artifact-id", artifactId, "--github-summary", file);
  const uploaded = report("success", "4567890123");
  assert.deepEqual([uploaded.status, uploaded.stdout], [0, "exportStatus=UPLOADED\n"]);
  // upload-artifact succeeds without an artifact ID when it finds no files.
  for (const [outcome, status, warning] of [["success", "EMPTY", /succeeded without creating an artifact/],
    ["failure", "UPLOAD_FAILED", /was not uploaded/]]) {
    const run = report(outcome, "");
    assert.equal(run.status, 0);
    assert.match(run.stdout, new RegExp(`^::warning title=CI evidence export::.*${warning.source}`, "m"));
    assert.match(run.stdout, new RegExp(`^exportStatus=${status}$`, "m"));
  }
  assert.equal(await readFile(jobSummary, "utf8"),
    "- exportStatus: **UPLOADED** (artifact ID 4567890123)\n\n- exportStatus: **EMPTY**\n\n- exportStatus: **UPLOAD_FAILED**\n\n");
  // A job summary that cannot be written is reported, and the status is still printed.
  const unwritable = report("success", "4567890123", root);
  assert.equal(unwritable.status, 0);
  assert.match(unwritable.stdout, /^::warning title=CI evidence export::The export status could not be written \([A-Z_]+\)/m);
  assert.match(unwritable.stdout, /^exportStatus=UPLOADED$/m);
  assert.equal(cli("export-status").status, 2);
  assert.equal(cli("export-status", "--outcome").status, 2);
});

test("the CI tool self-test passes only when every test executed and passed, and is reported on its own line", async (t) => {
  const root = await workspace(t);
  // Real node:test TAP output: a skipped or todo test still exits 0.
  const tapOf = async (name, body) => {
    await writeFile(join(root, `${name}.test.mjs`), `import test from "node:test";\n${body}\n`);
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const run = spawnSync(process.execPath, ["--test", "--test-reporter=tap", join(root, `${name}.test.mjs`)], { encoding: "utf8", env });
    await writeFile(join(root, `${name}.tap`), run.stdout);
    return { tap: join(root, `${name}.tap`), exitCode: String(run.status) };
  };
  const passing = await tapOf("passing", 'test("a", () => {});\ntest("b", () => {});');
  const skipping = await tapOf("skipping", 'test("a", () => {});\ntest("b", { skip: "no shell" }, () => {});');
  const todo = await tapOf("todo", 'test("a", () => {});\ntest("b", { todo: true }, () => {});');
  const failing = await tapOf("failing", 'test("a", () => { throw new Error("broken"); });');
  assert.deepEqual([skipping.exitCode, todo.exitCode, failing.exitCode], ["0", "0", "1"]);
  const jobSummary = join(root, "summary.md");
  const status = ({ tap, exitCode }, file = jobSummary) =>
    cli("self-test-status", "--tap", tap, "--exit-code", exitCode, "--github-summary", file);
  const passed = status(passing);
  assert.deepEqual([passed.status, passed.stdout], [0, "selfTestStatus=PASS\n"]);
  for (const result of [skipping, todo, failing, { tap: join(root, "missing.tap"), exitCode: "0" }]) {
    const run = status(result);
    assert.equal(run.status, 1);
    assert.match(run.stdout, /^::error title=CI tool self-test::Not every expected self-test executed and passed/m);
    assert.match(run.stdout, /^selfTestStatus=FAIL$/m);
  }
  assert.equal(await readFile(jobSummary, "utf8"), [
    "- CI tool self-test (evidence wrappers): **PASS** (2 tests: 2 passed, 0 failed, 0 skipped, 0 todo, 0 cancelled)",
    "- CI tool self-test (evidence wrappers): **FAIL** (2 tests: 1 passed, 0 failed, 1 skipped, 0 todo, 0 cancelled)",
    "- CI tool self-test (evidence wrappers): **FAIL** (2 tests: 1 passed, 0 failed, 0 skipped, 1 todo, 0 cancelled)",
    "- CI tool self-test (evidence wrappers): **FAIL** (1 tests: 0 passed, 1 failed, 0 skipped, 0 todo, 0 cancelled)",
    "- CI tool self-test (evidence wrappers): **FAIL** (no node:test summary)", ""].join("\n\n"));
  // An unwritable job summary is reported without changing the self-test result.
  const unwritable = status(passing, root);
  assert.equal(unwritable.status, 0);
  assert.match(unwritable.stdout, /^::warning title=CI tool self-test::The self-test status could not be written \([A-Z_]+\)/m);
  assert.equal(cli("self-test-status", "--tap", passing.tap).status, 2);
  assert.equal(cli("self-test-status", "--tap", passing.tap, "--exit-code", "zero").status, 2);
});

test("summary, inputs and manifest commands warn instead of failing the job", async (t) => {
  const root = await workspace(t);
  for (const args of [["summarize", join(root, "missing"), "--client", "codex"], ["inputs", join(root, "inputs.json"),
    "--package-dir", join(root, "missing")]]) {
    const run = cli(...args);
    assert.equal(run.status, 0);
    assert.match(run.stdout, /^::warning title=CI evidence::/m);
  }
  assert.equal(cli("summarize").status, 2);
});

test("the evidence directory must be an empty real directory outside the runtime", async (t) => {
  const root = await workspace(t);
  const runtime = join(root, "runtime");
  await mkdir(runtime);
  assert.equal(prepareEvidenceDirectory(join(root, "evidence"), runtime), join(realpathSync(root), "evidence"));
  await writeFile(join(root, "evidence", "existing"), "");
  assert.throws(() => prepareEvidenceDirectory(join(root, "evidence"), runtime), { code: "EVIDENCE_DIRECTORY_NOT_EMPTY" });
  assert.throws(() => prepareEvidenceDirectory(join(runtime, "evidence"), runtime), { code: "EVIDENCE_DIRECTORY_OVERLAPS_RUNTIME" });
  assert.throws(() => prepareEvidenceDirectory("relative/evidence", runtime), { code: "EVIDENCE_DIRECTORY_NOT_ABSOLUTE" });
  if (process.platform !== "win32") {
    await mkdir(join(root, "target"));
    await symlink(join(root, "target"), join(root, "link"));
    assert.throws(() => prepareEvidenceDirectory(join(root, "link"), runtime), { code: "EVIDENCE_DIRECTORY_INVALID" });
  }
  await writeFile(join(root, "file"), "");
  assert.throws(() => prepareEvidenceDirectory(join(root, "file"), runtime));
  const run = cli("prepare", join(root, "evidence"), runtime);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /EVIDENCE_DIRECTORY_NOT_EMPTY/);
});

test("inputs and the manifest record package and client provenance with checksums", async (t) => {
  const root = await workspace(t);
  const packages = join(root, "tarballs");
  await mkdir(packages);
  await writeFile(join(packages, "memorax-memorax-code-0.1.20.tgz"), "candidate bytes");
  const sha256 = "732d058fadd90c70f22429227ab5d9c74919217099efe737aa46835ce3a60856";
  const env = { GITHUB_REPOSITORY: "memorax-ai/memorax-code", GITHUB_SHA: "165c3c675f9702e70f34e3bdd8cf0cc83d730293",
    GITHUB_REF: "refs/heads/main", GITHUB_EVENT_NAME: "push", GITHUB_RUN_ID: "38858541095", GITHUB_RUN_ATTEMPT: "1",
    GITHUB_JOB: "install", RUNNER_OS: "Windows", RUNNER_ARCH: "X64", ImageOS: "win25", ImageVersion: "not a version" };
  const inputs = recordInputs(join(root, "inputs.json"), { client: "codex", channel: "latest", "client-version": "0.163.0",
    "matrix-os": "windows-2025", "matrix-node": "24", "npm-version": "11.19.0", "package-dir": packages,
    "package-artifact-name": "memorax-code-package-attempt1", "package-artifact-id": "12028286155",
    "package-artifact-digest": "sha256:83d6b7a0d1a58bbe91c4bc8ecaf9e864ff8e16049072d515cfbb4924d1d9044d",
    "expected-package-sha256": "0".repeat(64) }, env);
  assert.equal(inputs.package.file, "memorax-memorax-code-0.1.20.tgz");
  assert.equal(inputs.package.sha256, sha256);
  assert.equal(inputs.package.sha256Matches, false);
  assert.equal(inputs.runner.imageVersion, undefined);
  assert.equal(inputs.source.runAttempt, "1");
  assert.deepEqual(inputs.client, { name: "codex", channel: "latest", version: "0.163.0" });

  const fakeNpm = join(root, "fake-npm.mjs");
  await writeFile(fakeNpm, `
    const args = process.argv.slice(2);
    if (args[0] === "config") { console.log("https://registry.npmjs.org/"); process.exit(0); }
    if (args[1].endsWith("@9.9.9")) process.exit(1);
    console.log(JSON.stringify({ "dist.integrity": "sha512-" + "A".repeat(86) + "==", "dist.shasum": "a".repeat(40) }));
  `);
  const matrix = JSON.stringify({ include: [{ os: "windows-2025", node: "24", codex: "0.147.0", channel: "baseline" },
    { os: "windows-2025", node: "24", codex: "0.163.0", channel: "latest" }, { os: "ubuntu-24.04", node: "20", codex: "0.147.0", channel: "baseline" }] });
  const manifest = await recordManifest(join(root, "manifest.json"), { "package-dir": packages, "package-artifact-name": "memorax-code-package-attempt1",
    matrix: [`codex=${matrix}`, `opencode=${JSON.stringify({ include: [{ opencode: "9.9.9", channel: "baseline+latest" }] })}`, "claude="] },
  { env, npm: [process.execPath, fakeNpm] });
  assert.deepEqual(manifest.source, { repository: "memorax-ai/memorax-code", sha: env.GITHUB_SHA, ref: "refs/heads/main", event: "push",
    runId: "38858541095", runAttempt: "1", job: "install" });
  assert.equal(manifest.package.sha256, sha256);
  assert.deepEqual(manifest.clients.codex.versions.map(({ version, channels, lookup }) => [version, channels, lookup]),
    [["0.147.0", ["baseline"], "OK"], ["0.163.0", ["latest"], "OK"]]);
  assert.equal(manifest.clients.codex.versions[0].shasum, "a".repeat(40));
  assert.deepEqual(manifest.clients.opencode.versions.map(({ channels, lookup }) => [channels, lookup]), [[["baseline", "latest"], "FAILED"]]);
  assert.equal(manifest.clients.claude, undefined);
});

for (const [client, suite] of [["codex", "codex-install-interruption-check"], ["claude", "claude-install-smoke"]]) {
  test(suite + " requires its first-failure evidence and retains the primary failure", async (t) => {
    const setup = { ledger: [["plan", "", suite], ["phase", "", "suites"], ["start", suite], ["end", suite, "1"]] };
    const options = { client, os: "windows-2025", testStepOutcome: "failure" };
    const missing = summarizeEvidence(await evidenceRoot(t, setup), options);
    assert.equal(missing.testOutcome, "FAIL");
    assert.equal(missing.evidenceStatus, "PARTIAL");
    assert.equal(missing.suites[0].evidence, "missing");
    const recorded = summarizeEvidence(await evidenceRoot(t, { ...setup, suites: {
      [suite]: { progress: { stage: "recovery" }, result: {
        schemaVersion: 1, testOutcome: "FAIL", evidenceStatus: "COMPLETE",
        failure: { kind: "functional+cleanup", stage: "recovery", code: "PRIMARY_FAILURE", cleanupCode: "CLEANUP_FAILURE" },
      } },
    } }), options);
    assert.equal(recorded.evidenceStatus, "COMPLETE");
    assert.equal(recorded.category, "functional+cleanup");
    assert.ok(recorded.signature.endsWith("|recovery|PRIMARY_FAILURE"));
  });
}
