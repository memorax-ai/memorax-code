import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { projectError, projectPathAlias } from "../shared/ci-evidence-projections.mjs";
import { projectTerminalDisposal } from "./codex-setup-pty-evidence.mjs";

const source = (await readFile(new URL("./codex-install-smoke.mjs", import.meta.url), "utf8")).replaceAll("\r\n", "\n");
const privateText = "private-terminal-output /private/fixture/account";
const plain = (value) => JSON.parse(JSON.stringify(value));
function runnerFunction(name, context = {}) {
  const definition = source.match(new RegExp("(?:async )?function " + name + "\\([\\s\\S]*?(?=\\n(?:async )?function )"))?.[0];
  assert.ok(definition, name);
  return runInNewContext("(" + definition + ")", { process: { execPath: "/fixture/node" },
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
