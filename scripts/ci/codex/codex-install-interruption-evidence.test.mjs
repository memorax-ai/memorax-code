import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createEvidenceRecorder, readJournal } from "../shared/ci-evidence.mjs";
import { collectSetupProductDiagnostics, createSetupTerminalObservation, interruptionFailureEvidence } from "./codex-install-interruption-evidence.mjs";

const privateText = "private-fixture-content /private/user/home sk-fixture-secret";
const harness = { packageRoot: "/fixture/package", workspace: "/fixture/workspace", env: { PRIVATE_FIXTURE: privateText } };
const diagnostic = {
  ok: true, skipped: 0, records: [{ source: "setup", operation: "setup", stage: "plugin-register", client: "codex",
    errorCode: "CLIENT_DEPLOYMENT_FAILED", commandExitCode: 1, summary: privateText, guidance: privateText,
    apiKey: privateText, command: privateText, absolutePath: privateText, sessionHash: privateText }],
};
async function recorder(t) {
  const directory = await mkdtemp(join(tmpdir(), "memorax-codex-interruption-evidence-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, evidence: createEvidenceRecorder({ suite: "codex-install-interruption-check", client: "codex", directory }) };
}

test("PTY observations distinguish absent exit evidence, Windows exit values and fixed product stages", () => {
  let clock = 0;
  const observed = createSetupTerminalObservation({ now: () => clock });
  assert.deepEqual(observed.snapshot(), { exitObserved: false, exitCode: null, signal: null, outputBytes: 0,
    outputAfterExitBytes: 0, lastProductStage: null, lastOutputElapsedMs: null, exitElapsedMs: null, disposal: "not-requested" });
  clock = 12;
  const first = "\x1b[32mChecking local setup state...\x1b[0m\r\n";
  observed.output(first);
  clock = 20;
  observed.output("Starting backend with \x60memorax-");
  observed.output("code start\x60...\r\n" + privateText + "中文");
  assert.equal(observed.snapshot().lastProductStage, "backend-start");
  assert.equal(observed.snapshot().outputBytes, Buffer.byteLength(first + "Starting backend with \x60memorax-code start\x60...\r\n" + privateText + "中文"));
  clock = 25;
  observed.exit({ exitCode: 3221225786, signal: 0, output: privateText });
  const atExit = observed.snapshot();
  assert.equal(atExit.exitCode, 3221225786);
  assert.equal(atExit.signal, 0);
  assert.equal(atExit.exitElapsedMs, 25);
  assert.equal(atExit.lastOutputElapsedMs, 20);
  clock = 30;
  const late = "Setup completed successfully.\r\n";
  observed.output(late);
  observed.dispose(true);
  observed.exit({ exitCode: 0, signal: 0 });
  assert.equal(atExit.lastProductStage, "backend-start");
  assert.equal(atExit.outputAfterExitBytes, 0);
  assert.equal(atExit.disposal, "not-requested");
  const after = observed.snapshot();
  assert.equal(after.exitCode, 3221225786);
  assert.equal(after.outputAfterExitBytes, Buffer.byteLength(late));
  assert.equal(after.lastProductStage, "completed");
  assert.equal(after.disposal, "succeeded");
  assert.equal(JSON.stringify(after).includes("private"), false);
});

test("PTY observation rejects malformed exit fields and never guesses a stage from arbitrary output", () => {
  const observed = createSetupTerminalObservation({ now: () => 0 });
  observed.output(privateText);
  observed.output(undefined);
  observed.exit({ exitCode: "1", signal: 256 });
  observed.dispose(false);
  assert.equal(observed.snapshot().exitObserved, true);
  assert.equal(observed.snapshot().exitCode, null);
  assert.equal(observed.snapshot().signal, null);
  assert.equal(observed.snapshot().lastProductStage, null);
  assert.equal(observed.snapshot().disposal, "failed");
});

test("diagnostic collection uses the bounded read-only product command and exports only typed fields", async (t) => {
  const { directory, evidence } = await recorder(t);
  let calls = 0;
  const collected = await collectSetupProductDiagnostics(evidence, "after-config-write", harness, { run: async (command, args, options) => {
    calls++;
    assert.equal(command, process.execPath);
    assert.deepEqual(args.slice(1), ["logs", "--diagnostics", "--limit", "20", "--json"]);
    assert.equal(options.timeout, 15000);
    assert.equal(options.maxBuffer, 1024 * 1024);
    assert.equal(options.cwd, harness.workspace);
    assert.equal(options.env, harness.env);
    return { stdout: JSON.stringify(diagnostic) };
  } });
  assert.equal(calls, 1);
  assert.deepEqual(collected, { status: "OK", ok: true, skipped: 0, records: [{ source: "setup", operation: "setup",
    stage: "plugin-register", client: "codex", errorCode: "CLIENT_DEPLOYMENT_FAILED", commandExitCode: 1 }] });
  const firstFailure = { stage: "after-config-write:retry", code: "SETUP_RETRY_FAILED" };
  evidence.observe("after-config-write.firstFailure", firstFailure);
  assert.equal(evidence.finish({ testOutcome: "FAIL", failure: { kind: "functional", ...firstFailure } }), "COMPLETE");
  const suite = join(directory, "codex-install-interruption-check");
  const journal = readJournal(join(suite, "journal.jsonl"));
  assert.equal(journal.records.find((record) => record.kind === "collect").value.records[0].stage, "plugin-register");
  const persisted = JSON.parse(await readFile(join(suite, "result.json"), "utf8"));
  assert.equal(persisted.failure.code, "SETUP_RETRY_FAILED");
  assert.equal(persisted.testOutcome, "FAIL");
  assert.equal(JSON.stringify(journal).includes(privateText), false);
  assert.equal(JSON.stringify(collected).includes("summary"), false);
});

test("failed or malformed diagnostics preserve the functional result and report partial evidence", async (t) => {
  for (const mode of ["command", "parse"]) {
    const { evidence } = await recorder(t);
    const result = await collectSetupProductDiagnostics(evidence, "after-config-write", harness, { run: async () => {
      if (mode === "command") throw Object.assign(new Error(privateText), { code: "EACCES", stderr: privateText });
      return { stdout: privateText };
    } });
    assert.equal(result.status, "FAILED");
    assert.equal(JSON.stringify(result).includes(privateText), false);
    assert.equal(evidence.finish({ testOutcome: "FAIL", failure: { kind: "functional", code: "SETUP_RETRY_FAILED" } }), "PARTIAL");
  }
});

test("a failed diagnostic command can still return its validated JSON result", async (t) => {
  const { evidence } = await recorder(t);
  const result = await collectSetupProductDiagnostics(evidence, "after-config-write", harness, { run: async () => {
    throw Object.assign(new Error(privateText), { code: 1, stdout: JSON.stringify({ ...diagnostic, ok: false }), stderr: privateText });
  } });
  assert.equal(result.status, "OK");
  assert.equal(result.ok, false);
  assert.equal(result.records[0].errorCode, "CLIENT_DEPLOYMENT_FAILED");
  evidence.finish({ testOutcome: "FAIL", failure: { kind: "functional", code: "SETUP_RETRY_FAILED" } });
});

test("failure summary keeps the first functional failure and first cleanup failure independently", () => {
  const report = { status: "FAIL", cases: [
    { firstFailure: { stage: "after-config-write:retry", code: "SETUP_RETRY_FAILED" },
      cleanupFailures: [{ stage: "after-config-write:terminal-stop", code: "PTY_RESOURCE_DISPOSE_FAILED" },
        { stage: "after-config-write:harness-close", code: "NATIVE_CLEANUP_TEMPORARY_STATE_EBUSY" }] },
    { firstFailure: { stage: "before-backend-start:retry", code: "SETUP_RETRY_TIMEOUT" } },
  ] };
  assert.deepEqual(interruptionFailureEvidence(report), { kind: "functional+cleanup", stage: "after-config-write:retry", code: "SETUP_RETRY_FAILED",
    cleanupStage: "after-config-write:terminal-stop", cleanupCode: "PTY_RESOURCE_DISPOSE_FAILED" });
  assert.equal(interruptionFailureEvidence({ status: "PASS", cases: [] }), undefined);
  assert.deepEqual(interruptionFailureEvidence({ status: "FAIL", cases: [{ cleanupFailures: report.cases[0].cleanupFailures }] }), {
    kind: "cleanup", stage: undefined, code: "PTY_RESOURCE_DISPOSE_FAILED", cleanupStage: "after-config-write:terminal-stop", cleanupCode: "PTY_RESOURCE_DISPOSE_FAILED" });
});
