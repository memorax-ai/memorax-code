import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { runInNewContext } from "node:vm";
import { code, projectError } from "../shared/ci-evidence-projections.mjs";
import { createSetupTerminalObservation } from "./codex-install-interruption-evidence.mjs";

const source = (await readFile(new URL("./codex-install-interruption-check.mjs", import.meta.url), "utf8")).replaceAll("\r\n", "\n");
const phases = ["after-config-write", "before-backend-start", "after-backend-start", "saved-account-key-cancel"];
const privateText = "private-fixture-secret /private/fixture/account";
const failure = (testCode) => Object.assign(new Error(testCode), { testCode });
const check = (value, testCode) => { if (!value) throw failure(testCode); };
const plain = (value) => JSON.parse(JSON.stringify(value));
function runnerFunction(name, context = {}) {
  const definition = source.match(new RegExp("(?:async )?function " + name + "\\([\\s\\S]*?(?=\\n(?:async )?function )"))?.[0];
  assert.ok(definition, name);
  return runInNewContext("(" + definition.replaceAll("import.meta.url", JSON.stringify("file:///fixture/runner.mjs")) + ")", { check, failure, Buffer, join, basename, dirname, resolve, pathToFileURL, fileURLToPath,
    code, projectError, stripVTControlCharacters, createSetupTerminalObservation,
    safeCode(error) { return code(error.testCode) ?? code(error.nativeCode) ?? "INTERRUPTION_CHECK_FAILED_PRIVATE_OUTPUT_SUPPRESSED"; }, ...context });
}

async function runRetryCase(options = {}) {
  const events = [], observations = [], deadlines = [], terminals = [];
  const key = "sk_" + "I".repeat(43), account = { endpoint: "http://127.0.0.1:1234", user_id: "interruption-saved-0", api_key: key };
  let configText, gateHandler, starts = 0;
  const harness = { stateHome: "/isolated/state", workspace: "/isolated/project", packageRoot: "/fixture/package",
    env: {}, memoryUrl: account.endpoint, memoryRequests: [], serverErrors: [],
    async runProduct(args) {
      events.push(args[0]);
      return { stdout: JSON.stringify({ ok: true, backend: { ok: true }, codexAdapter: { ok: true } }) };
    },
    setModelHandler() {},
    async runCodex() { return { stdout: '{"type":"thread.started","thread_id":"fixture"}\n{"type":"turn.completed"}' }; },
    async runMemory() {
      events.push("native-search");
      harness.memoryRequests.push({ path: "/v1/memories/search", authorization: "Token " + key,
        body: { user_id: account.user_id + "@project", query: "Interrupted setup saved account check" } });
      return { stdout: JSON.stringify({ ok: true, baseUserId: account.user_id, effectiveUserId: account.user_id + "@project" }) };
    },
    async close() { events.push("harness-close"); if (options.closeFailure) throw failure("NATIVE_CLEANUP_TEMPORARY_STATE_EBUSY"); },
  };
  const evidence = {
    observe(name, value) { observations.push({ name, value: plain(value) }); events.push("observe:" + name); },
    track() { return () => events.push("untrack"); },
  };
  const runCase = runnerFunction("runCase", {
    packageRoot: harness.packageRoot, codexCommand: "/fixture/codex", phases, key, progress: {}, evidence,
    fixtureModel: "synthetic", sendResponses() {},
    createRequire: () => () => ({ parse: () => ({ memorax: account }) }),
    async createNativeHarness() { return harness; },
    async writeFile(_path, text) { configText = text; },
    async readFile(path) { return path.endsWith("package.json") ? '{"version":"0.1.20"}' : configText; },
    snapshotProtectedConfiguration: () => ({ account }), assertProtectedConfiguration() {}, assertCredentialNotEchoed() {},
    createServer(handler) {
      gateHandler = handler;
      return { once() {}, listen(_port, _host, done) { done(); }, address: () => ({ port: 1234 }),
        closeAllConnections() {
          if (options.gateCloseFailure === "connections") throw Object.assign(new Error(privateText), { code: "EIO" });
        },
        close(done) {
          events.push("gate-close");
          if (options.gateCloseFailure === "close") throw Object.assign(new Error(privateText), { code: "EIO" });
          done(options.gateCloseFailure === "callback" ? Object.assign(new Error(privateText), { code: "EIO" }) : undefined);
        } };
    },
    async readJsonIfPresent(path) {
      if (path.endsWith("setup-completion.json") && !options.completionMissing) return { completedByVersion: "0.1.20" };
      return undefined;
    },
    exists: async () => false, alive: () => false,
    async waitFor(predicate, testCode) { check(await predicate(), testCode); },
    startTerminal() {
      starts++;
      const observation = createSetupTerminalObservation({ now: () => 0 });
      observation.output("Checking local setup state...\n" + privateText);
      let resolveExit;
      const terminal = { child: { pid: starts }, observation, inputRequested: starts === 2 && options.inputRequested,
        output: () => privateText, exited: new Promise((done) => { resolveExit = done; }) };
      terminal.emitExit = (event) => { observation.exit(event); resolveExit(event); };
      terminals.push(terminal);
      if (starts === 1) {
        configText += " ";
        queueMicrotask(() => gateHandler({ async *[Symbol.asyncIterator]() { yield JSON.stringify({ pid: 100, args: ["codex-plugin", "install"] }); } },
          { destroyed: false, writeHead() { return this; }, end() { this.destroyed = true; } }));
      } else {
        events.push("retry-start");
        if (!options.timeout) terminal.emitExit({ exitCode: options.exitCode ?? 1, signal: options.signal ?? 0 });
      }
      return terminal;
    },
    async deadline(promise, ms, testCode) {
      deadlines.push({ ms, testCode });
      if (options.timeout && testCode === "SETUP_RETRY_TIMEOUT") throw failure(testCode);
      return promise;
    },
    async stopTerminal(terminal) {
      events.push(terminal === terminals[0] ? "interrupt-initial" : "cleanup-terminal");
      terminal.observation.dispose(!(options.stopFailure && terminal === terminals[1]));
      if (options.stopFailure && terminal === terminals[1]) throw failure("PTY_RESOURCE_DISPOSE_FAILED");
      if (!terminal.observation.snapshot().exitObserved) terminal.emitExit({ exitCode: 1, signal: 0 });
    },
    disposeTerminal(terminal) { terminal.observation.dispose(true); },
    async stopNativeProcessTree() { events.push("stop-fallback"); },
    async collectSetupProductDiagnostics(receivedEvidence, phase, receivedHarness) {
      assert.equal(receivedEvidence, evidence); assert.equal(receivedHarness, harness); assert.equal(phase, "after-config-write");
      events.push("collect-product-diagnostics");
      return options.diagnosticFailure ? { status: "FAILED", error: { name: "Error", code: "EACCES" } }
        : { status: "OK", records: [{ stage: "plugin-register", errorCode: "CLIENT_DEPLOYMENT_FAILED" }] };
    },
  });
  return { result: plain(await runCase("after-config-write")), events, observations, deadlines };
}

test("retry failure records exit evidence and first failure before diagnostics and cleanup", async () => {
  const { result, events, observations, deadlines } = await runRetryCase();
  assert.equal(result.status, "FAIL");
  assert.deepEqual(result.errors, ["SETUP_RETRY_FAILED"]);
  assert.equal(result.firstFailure.stage, "after-config-write:retry");
  assert.equal(result.firstFailure.code, "SETUP_RETRY_FAILED");
  assert.equal(result.retry.exitCode, 1);
  assert.equal(result.retry.signal, 0);
  assert.equal(result.retry.lastProductStage, "preflight");
  assert.equal(result.retry.disposal, "not-requested");
  assert.equal(result.cleanup, "PASS");
  assert.equal(result.retryWithoutAccountInput, undefined);
  assert.equal(JSON.stringify(result).includes(privateText), false);
  assert.ok(events.indexOf("observe:after-config-write.retry") < events.indexOf("observe:after-config-write.firstFailure"));
  assert.ok(events.indexOf("observe:after-config-write.firstFailure") < events.indexOf("collect-product-diagnostics"));
  assert.ok(events.indexOf("collect-product-diagnostics") < events.indexOf("cleanup-terminal"));
  assert.ok(events.indexOf("cleanup-terminal") < events.indexOf("harness-close"));
  assert.equal(observations.find((item) => item.name.endsWith("terminalAfterStop")).value.disposal, "succeeded");
  assert.deepEqual(deadlines.find((item) => item.testCode === "SETUP_RETRY_TIMEOUT"), { ms: 110000, testCode: "SETUP_RETRY_TIMEOUT" });
});

test("retry timeout records unavailable exit fields, and failed diagnostics never replace the functional error", async () => {
  const { result } = await runRetryCase({ timeout: true, diagnosticFailure: true });
  assert.deepEqual(result.errors, ["SETUP_RETRY_TIMEOUT"]);
  assert.equal(result.retry.exitObserved, false);
  assert.equal(result.retry.exitCode, null);
  assert.equal(result.retry.signal, null);
  assert.equal(result.firstFailure.code, "SETUP_RETRY_TIMEOUT");
  assert.equal(result.productDiagnostics.status, "FAILED");
  assert.equal(result.cleanup, "PASS");
});

test("first retry failure and both cleanup failures retain their original stages", async () => {
  const { result } = await runRetryCase({ stopFailure: true, closeFailure: true });
  assert.equal(result.firstFailure.code, "SETUP_RETRY_FAILED");
  assert.deepEqual(result.errors, ["SETUP_RETRY_FAILED"]);
  assert.equal(result.cleanup, "PTY_RESOURCE_DISPOSE_FAILED");
  assert.deepEqual(result.cleanupFailures.map(({ stage, code }) => ({ stage, code })), [
    { stage: "after-config-write:terminal-stop", code: "PTY_RESOURCE_DISPOSE_FAILED" },
    { stage: "after-config-write:harness-close", code: "NATIVE_CLEANUP_TEMPORARY_STATE_EBUSY" },
  ]);
});

test("gate close errors retain the retry failure, finish observation and return the case report", async () => {
  for (const gateCloseFailure of ["connections", "close", "callback"]) {
    const { result, events, observations } = await runRetryCase({ gateCloseFailure });
    assert.equal(result.status, "FAIL");
    assert.equal(result.firstFailure.code, "SETUP_RETRY_FAILED");
    assert.deepEqual(result.errors, ["SETUP_RETRY_FAILED"]);
    assert.equal(result.cleanupFailures.length, 1);
    assert.equal(result.cleanupFailures[0].stage, "after-config-write:gate-close");
    assert.equal(result.cleanupFailures[0].error.code, "EIO");
    assert.equal(result.cleanup, result.cleanupFailures[0].code);
    assert.ok(events.includes("untrack"));
    assert.equal(observations.at(-1).name, "after-config-write.result");
    assert.deepEqual(observations.at(-1).value.errors, ["SETUP_RETRY_FAILED"]);
    assert.equal(JSON.stringify(result).includes(privateText), false);
  }
});

test("successful PTY exit still requires all original completion, readiness and native saved-account checks", async () => {
  const passed = await runRetryCase({ exitCode: 0 });
  assert.equal(passed.result.status, "PASS");
  assert.equal(passed.result.retryWithoutAccountInput, true);
  assert.equal(passed.result.savedAccountRequestVerified, true);
  assert.equal(passed.result.disabledAutomaticWritebackVerified, true);
  assert.ok(passed.events.includes("native-search"));
  assert.equal(passed.events.includes("collect-product-diagnostics"), false);
  const missing = await runRetryCase({ exitCode: 0, completionMissing: true });
  assert.equal(missing.result.status, "FAIL");
  assert.deepEqual(missing.result.errors, ["SETUP_RETRY_COMPLETION_MISSING"]);
  const requested = await runRetryCase({ exitCode: 0, inputRequested: true });
  assert.deepEqual(requested.result.errors, ["SAVED_ACCOUNT_RETRY_REQUESTED_INPUT"]);
  const signalled = await runRetryCase({ exitCode: 0, signal: 15 });
  assert.deepEqual(signalled.result.errors, ["SETUP_RETRY_FAILED"]);
});

test("PTY exit snapshot survives late output and disposal without changing the exit event", async () => {
  let onData, onExit, kills = 0;
  const child = { onData(fn) { onData = fn; }, onExit(fn) { onExit = fn; }, write() {}, kill() { kills++; } };
  const disposeTerminal = runnerFunction("disposeTerminal");
  const startTerminal = runnerFunction("startTerminal", {
    packageRoot: "/fixture/package", process: { execPath: "/fixture/node" }, disposeTerminal,
    pty: { spawn() { return child; } },
  });
  const terminal = startTerminal({ env: {}, workspace: "/fixture/workspace" }, ["setup"], { cancelCase: false });
  onData("Starting backend with \x60memorax-code start\x60...");
  const event = { exitCode: 1, signal: 0 };
  onExit(event);
  assert.equal(await terminal.exited, event);
  const first = terminal.observation.snapshot();
  onData(privateText);
  disposeTerminal(terminal);
  disposeTerminal(terminal);
  assert.equal(kills, 1);
  assert.equal(first.disposal, "not-requested");
  assert.equal(first.outputAfterExitBytes, 0);
  assert.equal(terminal.observation.snapshot().outputAfterExitBytes, Buffer.byteLength(privateText));
  assert.equal(terminal.observation.snapshot().exitCode, 1);
  assert.equal(terminal.inputRequested, false);
  assert.equal(JSON.stringify(first).includes(privateText), false);
});

test("source integration keeps case order, timeout gates and recorder completion outside test decisions", () => {
  assert.ok(source.includes('const phases = ' + JSON.stringify(phases).replaceAll(',', ', ') + ';'));
  assert.ok(source.includes('createEvidenceRecorder({ suite: "codex-install-interruption-check", client: "codex" })'));
  assert.ok(source.includes('report.status = report.cases.every((result) => result.status === "PASS") ? "PASS" : "FAIL"'));
  assert.ok(source.includes('report.evidenceStatus = evidence.finish({ testOutcome: report.status, failure: interruptionFailureEvidence(report) })'));
  assert.ok(source.includes('await deadline(terminal.exited, 15_000, "SETUP_PROCESS_TREE_DID_NOT_EXIT")'));
  assert.ok(source.includes('if (report.status !== "PASS") process.exitCode = 1'));
});
