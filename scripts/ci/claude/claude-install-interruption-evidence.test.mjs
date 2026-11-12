import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { createEvidenceRecorder, readJournal } from "../shared/ci-evidence.mjs";
import { interruptionFailureEvidence } from "../codex/codex-install-interruption-evidence.mjs";
import { collectInterruptionDiagnostics, createInterruptionGateObservation, interruptionCode,
  observeInterruptionTerminal, recordInterruptionFailure, waitForInterruptionStage } from "./claude-install-interruption-evidence.mjs";

const privateText = "private-fixture-secret /private/fixture/account sk-fixture-secret";
const failure = (testCode) => Object.assign(new Error(privateText), { testCode });
const plain = (value) => JSON.parse(JSON.stringify(value));

function terminalFixture({ stopError } = {}) {
  let exit, stops = 0;
  const terminal = observeInterruptionTerminal({
    child: { write() {} },
    exited: new Promise((done) => { exit = done; }),
    async stop() { stops++; exit({ exitCode: 1, signal: 0 }); if (stopError) throw stopError; },
  });
  return { terminal, exit, stops: () => stops };
}

test("early exit retains the first observer error and Windows exit values separately from cleanup failure", async () => {
  const cleanupError = Object.assign(new Error(privateText), { code: "EPERM", cleanupFailed: true });
  const { terminal } = terminalFixture({ stopError: cleanupError });
  terminal.observation.output("Starting backend with \x60memorax-code start\x60...\n" + privateText);
  terminal.fail(failure("SAVED_ACCOUNT_RETRY_REQUESTED_INPUT"));
  terminal.fail(failure("INTERRUPTION_TERMINAL_OUTPUT_LIMIT"));
  await assert.rejects(waitForInterruptionStage(new Promise(() => {}), terminal),
    (error) => error.testCode === "SAVED_ACCOUNT_RETRY_REQUESTED_INPUT");
  await assert.rejects(terminal.stop(), (error) => error === cleanupError);
  const snapshot = terminal.snapshot();
  assert.equal(snapshot.firstError.code, "SAVED_ACCOUNT_RETRY_REQUESTED_INPUT");
  assert.equal(snapshot.cleanupError.code, "EPERM");
  assert.equal(snapshot.exitCode, 1);
  assert.equal(snapshot.signal, 0);
  assert.equal(snapshot.lastProductStage, "backend-start");
  assert.equal(snapshot.disposal, "failed");
  assert.equal(JSON.stringify(snapshot).includes(privateText), false);
});

test("unexplained early exits remain failures and a reached gate preserves the success path", async () => {
  for (const exitCode of [0, 1, 3221225786]) {
    const { terminal, exit } = terminalFixture();
    exit({ exitCode, signal: 0, command: privateText });
    await assert.rejects(waitForInterruptionStage(new Promise(() => {}), terminal),
      (error) => error.testCode === "SETUP_EXITED_BEFORE_INTERRUPTION_STAGE");
    assert.equal(terminal.snapshot().exitCode, exitCode);
  }
  const { terminal, stops } = terminalFixture(), gate = { kind: "fixture-gate" };
  assert.equal(await waitForInterruptionStage(Promise.resolve(gate), terminal), gate);
  terminal.verify();
  assert.equal(stops(), 0);
  assert.equal(terminal.snapshot().exitObserved, false);
});

test("gate observations preserve counters and bounded health results without process or response content", () => {
  const gate = createInterruptionGateObservation();
  gate.request("start"); gate.record("absent"); gate.stage("continued");
  gate.request("status"); gate.record("valid"); gate.probingHealth();
  gate.health({ status: 200, ok: true, url: privateText }, { ok: true, instanceId: privateText }, true);
  gate.stage("held");
  assert.deepEqual(gate.snapshot(), { startCount: 1, statusCount: 1, command: "status", stage: "held",
    backendRecord: "valid", health: "matched", httpStatus: 200, identityMatched: true, errorCode: null });
  gate.request(privateText); gate.stage(privateText);
  assert.equal(JSON.stringify(gate.snapshot()).includes(privateText), false);
});

test("gate failures retain only known stages and restricted system or validation codes", () => {
  const gate = createInterruptionGateObservation();
  gate.request("status");
  gate.fail(Object.assign(new SyntaxError(privateText), { stdout: privateText }));
  assert.equal(gate.snapshot().backendRecord, "invalid");
  assert.equal(gate.snapshot().errorCode, "DEPENDENCY_GATE_OBSERVATION_FAILED");
  gate.probingHealth();
  gate.response({ status: 200, url: privateText });
  gate.fail(Object.assign(new Error(privateText), { cause: { code: "ECONNREFUSED", address: privateText } }));
  assert.equal(gate.snapshot().health, "error");
  assert.equal(gate.snapshot().httpStatus, 200);
  assert.equal(gate.snapshot().errorCode, "ECONNREFUSED");
  assert.deepEqual(gate.snapshot().firstError, { stage: "record", code: "DEPENDENCY_GATE_OBSERVATION_FAILED" });
  gate.fail({ code: privateText, testCode: privateText, message: privateText });
  assert.equal(gate.snapshot().errorCode, "DEPENDENCY_GATE_OBSERVATION_FAILED");
  assert.equal(JSON.stringify(gate.snapshot()).includes(privateText), false);
});

test("functional and cleanup failures keep distinct first causes in the independently persisted suite result", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "claude-interruption-evidence-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const evidence = createEvidenceRecorder({ suite: "claude-install-interruption-check", client: "claude", directory });
  const result = { status: "FAIL", errors: [] };
  recordInterruptionFailure(result, "after-backend-start:interrupt-setup", failure("SAVED_ACCOUNT_RETRY_REQUESTED_INPUT"));
  recordInterruptionFailure(result, "after-backend-start:interrupt-setup", failure("SETUP_EXITED_BEFORE_INTERRUPTION_STAGE"));
  recordInterruptionFailure(result, "after-backend-start:terminal-stop", Object.assign(new Error(privateText), { code: "EPERM" }), { cleanup: true });
  evidence.observe("after-backend-start.firstFailure", result.firstFailure);
  evidence.observe("after-backend-start.cleanup", result.cleanupFailures);
  const report = { status: "FAIL", cases: [result] };
  assert.equal(evidence.finish({ testOutcome: report.status, failure: interruptionFailureEvidence(report) }), "COMPLETE");
  const suite = join(directory, "claude-install-interruption-check");
  const persisted = JSON.parse(await readFile(join(suite, "result.json"), "utf8"));
  assert.deepEqual(persisted.failure, { kind: "functional+cleanup", stage: "after-backend-start:interrupt-setup",
    code: "SAVED_ACCOUNT_RETRY_REQUESTED_INPUT", cleanupStage: "after-backend-start:terminal-stop", cleanupCode: "EPERM" });
  assert.equal(result.firstFailure.code, "SAVED_ACCOUNT_RETRY_REQUESTED_INPUT");
  assert.equal(JSON.stringify(readJournal(join(suite, "journal.jsonl"))).includes(privateText), false);
});

test("diagnostics remain available without an evidence directory and discard private fields", async (t) => {
  const stateHome = await mkdtemp(join(tmpdir(), "claude-interruption-diagnostics-"));
  t.after(() => rm(stateHome, { recursive: true, force: true }));
  const directory = join(stateHome, "runtime", "diagnostics");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "mc-1700000000000-12345678-1234-1234-1234-123456789abc.json"), JSON.stringify({
    source: "setup", operation: "setup", stage: "start", errorCode: "SETUP_START_FAILED",
    commandExitCode: 1, summary: privateText, apiKey: privateText, command: privateText, absolutePath: privateText,
  }));
  const evidence = createEvidenceRecorder({ suite: "claude-install-interruption-check", client: "claude", directory: "" });
  const collected = await collectInterruptionDiagnostics(evidence, "after-backend-start", { stateHome });
  assert.equal(collected.status, "OK");
  assert.equal(collected.records[0].errorCode, "SETUP_START_FAILED");
  assert.equal(collected.records[0].commandExitCode, 1);
  assert.equal(JSON.stringify(collected).includes(privateText), false);
  assert.equal(evidence.finish({ testOutcome: "FAIL" }), "DISABLED");
});

const source = await readFile(new URL("./claude-install-interruption-check.mjs", import.meta.url), "utf8");
const definition = source.match(/async function runCase\([\s\S]*?(?=\nfunction startTerminal)/)?.[0];
assert.ok(definition);

async function runCaseFixture(options = {}) {
  const events = [], observations = [], deadlines = [], terminals = [];
  const phase = options.success ? "after-config-write" : "after-backend-start";
  const key = "sk_" + "I".repeat(43), user = "interruption-saved-" + (options.success ? 0 : 2);
  const account = { endpoint: "http://127.0.0.1:1234", api_key: key, user_id: user };
  let gateHandler, configText, completed = false, beforeClose, recordReads = 0;
  const pluginName = "memorax-code-claude-adapter";
  const harness = {
    stateHome: "/isolated/state", workspace: "/isolated/project", packageRoot: "/fixture/package", claudeHome: "/isolated/claude",
    env: { MEMORAX_CODE_BACKEND_PORT: "4321" }, memoryUrl: account.endpoint,
    modelRequests: [], memoryRequests: [], serverErrors: [],
    setBeforeClose(handler) { beforeClose = handler; },
    setModelHandler() {},
    async runProduct(args) { events.push("product-" + args[0]); return { stdout: '{"ok":true,"backend":{"ok":true},"claudeAdapter":{"ok":true}}' }; },
    async runClaude(args) {
      if (args[0] === "--version") return { stdout: "2.1.322 (Claude Code)" };
      harness.modelRequests.push({});
      return { stdout: [
        { type: "system", subtype: "init", session_id: "fixture", model: "synthetic", plugins: [], skills: [pluginName + ":memorax-code"] },
        { type: "result", session_id: "fixture", is_error: false, subtype: "success", result: "Interrupted setup recovery fixture completed." },
      ].map(JSON.stringify).join("\n") };
    },
    async runMemory() {
      harness.memoryRequests.push({ path: "/v1/memories/search", authorization: "Token " + key,
        body: { user_id: user + "@project", query: "Interrupted setup saved account check" } });
      return { stdout: JSON.stringify({ ok: true, baseUserId: user, effectiveUserId: user + "@project" }) };
    },
    async close() {
      events.push("harness-close");
      if (options.closeFailure) throw Object.assign(new Error(privateText), { nativeCode: "NATIVE_CLEANUP_FAILED" });
      await beforeClose?.();
    },
  };
  const evidence = { observe(name, value) { observations.push({ name, value: plain(value) }); events.push("observe:" + name); },
    track() { return () => events.push("untrack"); } };
  const runCase = runInNewContext("(" + definition.replaceAll("import.meta.url", JSON.stringify("file:///fixture/runner.mjs")) + ")", {
    Buffer, join, basename, dirname, resolve, fileURLToPath, pathToFileURL, packageRoot: harness.packageRoot, claudeCommand: "/fixture/claude",
    expectedVersion: "2.1.322", phases: ["after-config-write", "before-backend-start", "after-backend-start", "saved-account-key-cancel"],
    key, pluginName, evidence, fixtureModel: "synthetic", createInterruptionGateObservation, recordInterruptionFailure, waitForInterruptionStage,
    failure, check(value, testCode) { if (!value) throw failure(testCode); }, safeCode: interruptionCode,
    async createNativeHarness() { return harness; }, createRequire: () => () => ({ parse: () => ({ memorax: account }) }),
    async writeFile(_path, value) { configText = value; },
    async readFile(path) { return path.endsWith("package.json") ? '{"version":"0.1.23"}' : configText; },
    async readJsonIfPresent(path) {
      if (path.endsWith("backend.pid.json") && options.gateError && recordReads++ === 0) {
        throw Object.assign(new Error(privateText), { code: "EACCES" });
      }
      if (path.endsWith("setup-completion.json")) return completed ? { version: 1, state: "complete", completedByVersion: "0.1.23" } : undefined;
      if (path.endsWith("plugin.json")) return { name: pluginName, version: "0.1.23" };
      return undefined;
    },
    async realpath(path) { return path; }, exists: async () => completed, alive: () => false,
    snapshotClaudeSettings: () => ({}), assertClaudeSettings() {}, assertProtectedConfiguration() {}, assertCredentialNotEchoed() {},
    snapshotProtectedConfiguration: () => ({ account }),
    async verifyNativePlugin() { return { source: "/fixture/plugin", cache: "/fixture/cache", version: "0.1.23" }; },
    selectNativeMemoraxPlugin: () => ({ path: "/fixture/plugin" }),
    async waitFor(predicate, testCode) { if (!(await predicate())) throw failure(testCode); },
    async deadline(promise, ms, testCode) { deadlines.push({ ms, testCode }); return promise; },
    createServer(handler) {
      gateHandler = handler;
      return { listening: true, once() {}, listen(_port, _host, done) { done(); }, address: () => ({ port: 1234 }),
        closeAllConnections() {}, close(done) { this.listening = false; done(); } };
    },
    startTerminal() {
      const fixture = terminalFixture({ stopError: options.stopFailure ? Object.assign(new Error(privateText), { code: "EPERM", cleanupFailed: true }) : undefined });
      const terminal = { ...fixture.terminal, inputRequested: false, output: () => privateText };
      const stop = terminal.stop;
      terminal.stop = async () => { events.push("terminal-stop"); return stop(); };
      terminals.push(terminal);
      terminal.observation.output("Checking local setup state...\n" + privateText);
      if (terminals.length === 1 && options.success) {
        configText += " ";
        queueMicrotask(() => gateHandler({ method: "POST", url: "/", async *[Symbol.asyncIterator]() { yield JSON.stringify({ pid: 100, args: ["start"] }); } },
          { destroyed: false, writeHead() { return this; }, end() { this.destroyed = true; } }));
      } else if (terminals.length === 2) {
        completed = true;
        fixture.exit({ exitCode: 0, signal: 0 });
      } else if (options.gateError) {
        queueMicrotask(() => gateHandler({ method: "POST", url: "/", async *[Symbol.asyncIterator]() { yield JSON.stringify({ pid: 100, args: ["status"] }); } },
          { destroyed: false, writeHead(status) { assert.equal(status, 500); return this; }, end() { this.destroyed = true; fixture.exit({ exitCode: 1, signal: 0 }); } }));
      } else if (options.observerFailure) terminal.fail(failure("SAVED_ACCOUNT_RETRY_REQUESTED_INPUT"));
      else fixture.exit({ exitCode: 1, signal: 0 });
      return terminal;
    },
    async collectInterruptionDiagnostics(_evidence, _phase, receivedHarness) {
      assert.equal(receivedHarness, harness); events.push("collect-diagnostics");
      return options.diagnosticFailure ? { status: "FAILED", error: { code: "EACCES" } }
        : { status: "OK", records: [{ source: "setup", errorCode: "SETUP_START_FAILED" }] };
    },
  });
  return { result: plain(await runCase(phase)), events, observations, deadlines };
}

test("runner keeps observer failure, exit evidence and cleanup failures, collecting diagnostics before cleanup", async () => {
  const { result, events, observations, deadlines } = await runCaseFixture({ observerFailure: true, stopFailure: true, closeFailure: true });
  assert.equal(result.status, "FAIL");
  assert.equal(result.firstFailure.code, "SAVED_ACCOUNT_RETRY_REQUESTED_INPUT");
  assert.equal(result.firstFailure.stage, "after-backend-start:interrupt-setup");
  assert.deepEqual(result.errors, ["SAVED_ACCOUNT_RETRY_REQUESTED_INPUT"]);
  assert.equal(result.terminal.exitCode, 1);
  assert.equal(result.terminal.lastProductStage, "preflight");
  assert.deepEqual(result.cleanupFailures.map(x => x.code), ["EPERM", "NATIVE_CLEANUP_FAILED"]);
  assert.equal(result.cleanup, "EPERM");
  assert.ok(events.indexOf("collect-diagnostics") < events.indexOf("terminal-stop"));
  assert.ok(events.indexOf("terminal-stop") < events.indexOf("harness-close"));
  assert.equal(observations.find(x => x.name.endsWith(".terminalAfterStop")).value.disposal, "failed");
  assert.equal(JSON.stringify(result).includes(privateText), false);
  assert.deepEqual(deadlines[0], { ms: 110000, testCode: "INTERRUPTION_STAGE_NOT_REACHED" });
});

test("diagnostic collection failure does not replace the original early-exit error", async () => {
  const { result } = await runCaseFixture({ diagnosticFailure: true });
  assert.equal(result.firstFailure.code, "SETUP_EXITED_BEFORE_INTERRUPTION_STAGE");
  assert.deepEqual(result.errors, ["SETUP_EXITED_BEFORE_INTERRUPTION_STAGE"]);
  assert.equal(result.productDiagnostics.status, "FAILED");
  assert.equal(result.cleanup, "PASS");
});

test("successful interruption and retry remain successful without additional diagnostic probes", async () => {
  const { result, events, deadlines } = await runCaseFixture({ success: true });
  assert.equal(result.status, "PASS");
  assert.equal(result.cleanup, "PASS");
  assert.equal(result.stageReached, true);
  assert.equal(result.retryWithoutAccountInput, true);
  assert.equal(result.savedAccountRequestVerified, true);
  assert.equal(result.firstFailure, undefined);
  assert.equal(result.productDiagnostics, undefined);
  assert.equal(events.includes("collect-diagnostics"), false);
  assert.deepEqual(deadlines.find(x => x.testCode === "SETUP_RETRY_TIMEOUT"), { ms: 110000, testCode: "SETUP_RETRY_TIMEOUT" });
});


test("runner records a gate read failure before the resulting child exit without leaking its private error", async () => {
  const { result } = await runCaseFixture({ gateError: true });
  assert.equal(result.firstFailure.code, "SETUP_EXITED_BEFORE_INTERRUPTION_STAGE");
  assert.equal(result.gate.statusCount, 1);
  assert.equal(result.gate.backendRecord, "unreadable");
  assert.equal(result.gate.errorCode, "EACCES");
  assert.deepEqual(result.gate.firstError, { stage: "record", code: "EACCES" });
  assert.equal(result.cleanup, "PASS");
  assert.equal(JSON.stringify(result).includes(privateText), false);
});
