import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { createEvidenceRecorder, readJournal } from "../shared/ci-evidence.mjs";
import { createClaudeInstallEvidence } from "./claude-install-evidence.mjs";

const source = await readFile(new URL("./claude-install-smoke.mjs", import.meta.url), "utf8");
const cleanupSource = source.slice(source.indexOf("async function cleanupResources() {"),
  source.indexOf("async function collectProductDiagnostics(name) {"));

for (const primaryFailed of [false, true]) {
  test("actual smoke cleanup preserves " + (primaryFailed ? "the primary failure" : "a cleanup-only failure")
    + " when evidence observations fail", async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "claude-cleanup-evidence-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const evidence = createEvidenceRecorder({ suite: "claude-install-smoke", client: "claude", directory });
    const installEvidence = createClaudeInstallEvidence(evidence);
    const report = { status: primaryFailed ? "FAIL" : "PASS", checks: [] };
    const events = [];
    if (primaryFailed) {
      installEvidence.setPhase("replacement_recovery");
      const first = Object.assign(new Error("private primary output"), { code: 1 });
      await assert.rejects(installEvidence.command("product_recover", async () => { throw first; }));
      report.primaryFailure = installEvidence.fail("primary", first);
    }
    const first = report.primaryFailure;
    const stopError = Object.assign(new Error("private stop output"), { code: 1, diagnosticCode: "BACKEND_STOP_TIMEOUT" });
    const context = {
      report, evidence, installEvidence, activeCommands: new Set(), setupStarted: true,
      cleanupStage: "entrypoint_check", cleanupCodes: { stop_command: "CLEANUP_STOP_COMMAND_FAILED" },
      root: "/private/test-root", entrypoint: "/private/entrypoint", stateHome: "/private/state",
      backendPids: new Set([456789]), backendPort: 43210, endpoint: undefined, registry: undefined,
      exists: async () => true,
      collectProductDiagnostics: async (name) => {
        events.push(name);
        await evidence.collect(name, () => { throw Object.assign(new Error("private read failure"), { code: "EIO" }); });
      },
      stopAndVerify: async () => {
        events.push("stop");
        context.cleanupStage = "stop_command";
        return installEvidence.command("product_stop", async () => { throw stopError; });
      },
      assertStopped: async () => { throw new Error("unexpected gate bypass"); },
      rm: async () => { throw new Error("failed cleanup must retain isolated state"); },
      pidPath: () => "/private/pid-record",
      observeInstallCleanup: async () => { events.push("cleanupObservations"); throw new Error("private observation failure"); },
    };
    const cleanup = runInNewContext(cleanupSource + "\ncleanupResources", context);
    await cleanup();
    assert.deepEqual(events, ["productDiagnostics", "stop", "cleanupProductDiagnostics", "cleanupObservations"]);
    assert.equal(report.status, "FAIL");
    assert.equal(report.primaryFailure, first);
    assert.equal(report.cleanupFailure.code, "CLEANUP_STOP_COMMAND_FAILED");
    assert.equal(report.cleanupFailure.details.diagnosticCode, "BACKEND_STOP_TIMEOUT");
    assert.equal(report.cleanupFailure.details.command.command, "product_stop");
    assert.equal(report.cleanupFailure.commandExitCode, 1);
    const failure = installEvidence.failureSummary();
    evidence.finish({ testOutcome: report.status, failure });
    assert.equal(failure.kind, primaryFailed ? "functional+cleanup" : "cleanup");
    if (primaryFailed) assert.equal(failure.primary.command.command, "product_recover");
    const journal = readJournal(join(directory, "claude-install-smoke", "journal.jsonl")).records;
    assert.equal(journal.filter((entry) => entry.kind === "collect" && entry.status === "FAILED").length, 3);
    assert.doesNotMatch(JSON.stringify(journal), /private|456789|43210/);
  });
}

test("the runner emits a finished failed result before any native command when prerequisites are missing", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "claude-prerequisite-evidence-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const evidence = join(directory, "evidence");
  await mkdir(evidence);
  const env = { PATH: process.env.PATH, HOME: directory, USERPROFILE: directory, MEMORAX_CI_EVIDENCE_DIR: evidence };
  for (const name of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) if (process.env[name]) env[name] = process.env[name];
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./claude-install-smoke.mjs", import.meta.url))], {
    cwd: directory, env, encoding: "utf8", timeout: 10_000,
  });
  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "FAIL");
  assert.equal(report.primaryFailure.phase, "prerequisites");
  assert.equal(report.cleanup, "PASS");
  const final = JSON.parse(await readFile(join(evidence, "claude-install-smoke", "result.json"), "utf8"));
  assert.equal(final.testOutcome, "FAIL");
  assert.equal(final.failure.kind, "functional");
  const journal = readJournal(join(evidence, "claude-install-smoke", "journal.jsonl")).records;
  assert.equal(journal.some((entry) => entry.kind === "observe" && entry.key.startsWith("command.")), false);
});
