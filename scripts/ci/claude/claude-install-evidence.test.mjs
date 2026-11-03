import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createEvidenceRecorder, readJournal } from "../shared/ci-evidence.mjs";
import { classifyInstallCommand, collectInstallProductDiagnostics, createClaudeInstallEvidence,
  observeInstallCleanup, observeInstallPort, projectInstallCommand } from "./claude-install-evidence.mjs";

const privateText = "sk_private_CANARY /private/user/transcript.json C:\\private\\user\\credential";
const commandPaths = { npmCommand: "/private/npm", entrypoint: "/private/product.mjs", claudeCommand: "/private/claude",
  ptyScript: "/private/pty.mjs", memoryEntrypoint: "/private/memory.mjs" };
const failure = (fields = {}) => Object.assign(new Error(privateText), { stdout: privateText, stderr: privateText,
  path: privateText, pid: 456789, ...fields });

for (const [command, args, expected] of [
  [commandPaths.npmCommand, ["pack", privateText], "npm_pack"],
  ["node", [commandPaths.entrypoint, "update", "--latest", "--force"], "product_update"],
  ["node", [commandPaths.entrypoint, "update", "--recover"], "product_recover"],
  ["node", [commandPaths.entrypoint, "stop", "--clients", "claude", "--json"], "product_stop"],
  ["node", [commandPaths.memoryEntrypoint, "search", "--query", privateText], "memory_search"],
  [commandPaths.claudeCommand, ["plugin", "marketplace", "list", "--json"], "claude_marketplace_list"],
  [privateText, [privateText], "other"],
]) {
  test("command classification returns only the fixed label " + expected, () => {
    assert.equal(classifyInstallCommand(command, args, commandPaths), expected);
  });
}

for (const [fields, expected] of [
  [{ code: 1 }, { status: "nonzero_exit", exitCode: 1 }],
  [{ code: 4294967295 }, { status: "nonzero_exit", exitCode: 4294967295 }],
  [{ code: null, signal: "SIGTERM" }, { status: "signal", signal: "SIGTERM" }],
  [{ code: "ENOENT" }, { status: "native_error", systemCode: "ENOENT" }],
  [{ testCode: "INSTALL_COMMAND_TIMEOUT" }, { status: "timeout", testCode: "INSTALL_COMMAND_TIMEOUT" }],
  [{ testCode: "INSTALL_COMMAND_OUTPUT_LIMIT" }, { status: "output_limit", testCode: "INSTALL_COMMAND_OUTPUT_LIMIT" }],
  [{ cleanupFailed: true, testCode: "INSTALL_COMMAND_PROCESS_REMAINS" },
    { status: "cleanup_failed", testCode: "INSTALL_COMMAND_PROCESS_REMAINS" }],
  [{ code: 1, diagnosticCode: "BACKEND_STOP_TIMEOUT" }, { status: "nonzero_exit", exitCode: 1, diagnosticCode: "BACKEND_STOP_TIMEOUT" }],
  [{ code: privateText, testCode: privateText, diagnosticCode: privateText, signal: privateText }, { status: "failed" }],
]) {
  test("command projection preserves typed outcome " + expected.status + " without private output", () => {
    assert.deepEqual(projectInstallCommand(failure(fields)), expected);
    assert.doesNotMatch(JSON.stringify(projectInstallCommand(failure(fields))), /private|456789|credential/);
  });
}

test("phase, command and first failure survive a later cleanup rejection", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "claude-install-evidence-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let clock = 0;
  const recorder = createEvidenceRecorder({ suite: "claude-install-smoke", client: "claude", directory, now: () => clock });
  const evidence = createClaudeInstallEvidence(recorder, { now: () => clock });
  evidence.setPhase("replacement_artifact_pack");
  const first = failure({ code: 1 });
  await assert.rejects(evidence.command("npm_pack", () => { clock = 15; throw first; }), (error) => error === first);
  const primary = evidence.fail("primary", first);
  assert.equal(primary.phase, "replacement_artifact_pack");
  assert.deepEqual(primary.command, { command: "npm_pack", phase: "replacement_artifact_pack", startedAtMs: 0,
    elapsedMs: 15, status: "nonzero_exit", exitCode: 1 });
  evidence.setPhase("cleanup");
  const stopped = failure({ code: 1, diagnosticCode: "BACKEND_OWNERSHIP_UNVERIFIED" });
  await assert.rejects(evidence.command("product_stop", () => { clock = 24; throw stopped; }), (error) => error === stopped);
  const cleanup = evidence.fail("cleanup", stopped, "stop_command");
  assert.equal(cleanup.diagnosticCode, "BACKEND_OWNERSHIP_UNVERIFIED");
  assert.equal(evidence.fail("primary", failure({ code: "EIO" })), primary);
  assert.equal(evidence.fail("cleanup", failure({ code: "EACCES" }), "directory_removal"), cleanup);
  const summary = evidence.failureSummary();
  assert.equal(summary.kind, "functional+cleanup");
  assert.equal(summary.stage, "replacement_artifact_pack");
  recorder.finish({ testOutcome: "FAIL", failure: summary });
  const journal = readJournal(join(directory, "claude-install-smoke", "journal.jsonl")).records;
  const commandEvents = journal.filter((entry) => entry.kind === "observe" && entry.key.startsWith("command."));
  assert.deepEqual(commandEvents.map((entry) => entry.key), ["command.1.start", "command.1.end", "command.2.start", "command.2.end"]);
  const result = JSON.parse(await readFile(join(directory, "claude-install-smoke", "result.json"), "utf8"));
  assert.equal(result.testOutcome, "FAIL");
  assert.equal(result.failure.primary.command.command, "npm_pack");
  assert.equal(result.failure.cleanup.command.command, "product_stop");
  assert.doesNotMatch(JSON.stringify([journal, result]), /private|456789|credential|transcript/);
});

test("expected failed update remains evidence and explicit recovery is the primary failure", async () => {
  const events = [];
  const evidence = createClaudeInstallEvidence({ observe: (key, value) => events.push({ key, value }) });
  evidence.setPhase("replacement_update_rejection");
  const expected = failure({ code: 23, diagnosticCode: "UPDATE_INSTALL_FAILED" });
  await assert.rejects(evidence.command("product_update", () => { throw expected; }), (error) => error === expected);
  assert.equal(evidence.failureSummary(), undefined);
  evidence.setPhase("replacement_recovery");
  const recovery = failure({ code: 1 });
  await assert.rejects(evidence.command("product_recover", () => { throw recovery; }));
  evidence.fail("primary", recovery);
  assert.equal(evidence.failureSummary().primary.command.command, "product_recover");
  assert.equal(evidence.failureSummary().stage, "replacement_recovery");
  assert.equal(events.find((entry) => entry.key === "command.1.end").value.exitCode, 23);
});

test("an evidence write failure changes neither command success nor the original rejection", async () => {
  const evidence = createClaudeInstallEvidence({ observe() { throw failure({ code: "EIO" }); } });
  assert.equal(await evidence.command("product_status", () => "unchanged result"), "unchanged result");
  assert.equal(evidence.failureSummary(), undefined);
  const original = failure({ code: 7 });
  await assert.rejects(evidence.command("product_stop", () => { throw original; }), (error) => error === original);
  evidence.fail("cleanup", original, "stop_command");
  assert.equal(evidence.failureSummary().kind, "cleanup");
  assert.equal(evidence.failureSummary().exitCode, 7);
});

test("existing product diagnostics are bounded and projected without running the installed CLI", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "claude-product-evidence-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  assert.deepEqual(await collectInstallProductDiagnostics(home), { present: false, records: [] });
  const directory = join(home, "runtime", "diagnostics");
  await mkdir(directory, { recursive: true });
  const id = (index) => "mc-" + (1900000000000 + index) + "-00000000-0000-4000-8000-000000000000";
  for (let index = 0; index < 21; index += 1) {
    await writeFile(join(directory, id(index) + ".json"), JSON.stringify({ id: id(index), operation: "update",
      errorCode: "UPDATE_INSTALL_FAILED", commandExitCode: 23, recoveryStatus: "failed", summary: privateText,
      path: privateText, pid: 456789, token: privateText }));
  }
  await writeFile(join(directory, id(21) + ".json"), "not JSON " + privateText);
  await writeFile(join(directory, id(22) + ".json"), JSON.stringify({ summary: "x".repeat(65 * 1024) }));
  const result = await collectInstallProductDiagnostics(home);
  assert.equal(result.files, 23);
  assert.equal(result.truncated, true);
  assert.equal(result.unreadable, 2);
  assert.equal(result.records.length, 18);
  assert.equal(result.records[0].id, id(20));
  assert.equal(result.records[0].commandExitCode, 23);
  assert.doesNotMatch(JSON.stringify(result), /private|456789|summary|token|path/);
});

test("cleanup observations only probe PID slots and never claim ownership or mutate processes", async () => {
  const signals = [];
  const result = await observeInstallCleanup({ pidPath: privateText, trackedPids: [123, 124, 125], port: 43210 }, {
    readPidRecord: async () => ({ pid: 123, token: privateText }),
    kill(pid, value) {
      signals.push(value);
      if (pid === 124) throw failure({ code: "ESRCH" });
      if (pid === 125) throw failure({ code: "EPERM" });
    },
    observePort: async () => ({ state: "refused", systemCode: "ECONNREFUSED" }),
  });
  assert.deepEqual(signals, [0, 0, 0, 0]);
  assert.deepEqual(result, { pidRecord: "present", recordedPid: "alive",
    trackedPidSlots: { observed: 3, alive: 1, exited: 1, unknown: 1, truncated: false },
    port: { state: "refused", systemCode: "ECONNREFUSED" } });
  assert.doesNotMatch(JSON.stringify(result), /123|124|125|43210|private|token/);
});

test("unreadable records and failed port observation remain unknown without masking earlier failures", async () => {
  const result = await observeInstallCleanup({ pidPath: privateText, trackedPids: Array(40).fill(123) }, {
    readPidRecord: async () => { throw failure({ code: "EACCES" }); },
    kill() { throw failure({ code: "EPERM" }); },
    observePort: async () => { throw failure({ code: "EIO" }); },
  });
  assert.equal(result.pidRecord, "unreadable");
  assert.equal(result.trackedPidSlots.observed, 32);
  assert.equal(result.trackedPidSlots.truncated, true);
  assert.deepEqual(result.port, { state: "unknown", systemCode: "EIO" });
});

for (const [event, expected] of [["connect", "accepting"], ["error", "refused"], ["timeout", "timeout"]]) {
  test("port observation is bounded and destroys its socket after " + expected, async () => {
    const socket = new EventEmitter();
    let destroyed = 0;
    socket.destroy = () => { destroyed += 1; };
    // Keep the pure mock timer alive as a real connection would do.
    const keepAlive = setTimeout(() => {}, 1000);
    try {
      const promise = observeInstallPort(43210, { timeoutMs: 5, connect(options) {
        assert.deepEqual(options, { host: "127.0.0.1", port: 43210 });
        return socket;
      } });
      if (event === "connect") socket.emit("connect");
      if (event === "error") socket.emit("error", failure({ code: "ECONNREFUSED" }));
      const result = await promise;
      assert.equal(result.state, expected);
      assert.equal(destroyed, 1);
      assert.doesNotMatch(JSON.stringify(result), /private|43210/);
    } finally { clearTimeout(keepAlive); }
  });
}

for (const terminalError of ["EXPECTED_INTERACTIVE_PROMPTS_NOT_OBSERVED", "PTY_RESOURCE_DISPOSE_FAILED"]) {
  test("terminal evidence added after command-end preserves " + terminalError + " and disposal failure", async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "claude-terminal-evidence-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const recorder = createEvidenceRecorder({ suite: "claude-install-smoke", client: "claude", directory });
    const evidence = createClaudeInstallEvidence(recorder);
    evidence.setPhase("lifecycle");
    const original = failure({ code: 1, testCode: "INSTALL_TERMINAL_CLEANUP_UNVERIFIED", cleanupFailed: true });
    await assert.rejects(evidence.command("terminal_setup", async () => { throw original; }), (error) => error === original);
    // terminalSetup parses the helper JSON only after command() has recorded its exit.
    Object.assign(original, { terminalError, terminalDisposal: { status: "failed", exitObserved: true,
      errorCode: "PTY_RESOURCE_DISPOSE_FAILED", systemCode: "EIO", message: privateText, path: privateText } });
    const primary = evidence.fail("primary", original);
    assert.equal(primary.code, terminalError);
    assert.equal(primary.terminalError, terminalError);
    assert.equal(primary.testCode, "INSTALL_TERMINAL_CLEANUP_UNVERIFIED");
    assert.equal(primary.command.command, "terminal_setup");
    assert.equal(primary.command.terminalError, undefined);
    assert.deepEqual(primary.terminalDisposal, { status: "failed", exitObserved: true,
      errorCode: "PTY_RESOURCE_DISPOSE_FAILED", systemCode: "EIO" });
    evidence.setPhase("cleanup");
    evidence.fail("cleanup", failure({ diagnosticCode: "BACKEND_STOP_TIMEOUT" }), "stop_command");
    assert.equal(evidence.fail("primary", failure({ code: "EIO" })), primary);
    recorder.finish({ testOutcome: "FAIL", failure: evidence.failureSummary() });
    const journal = readJournal(join(directory, "claude-install-smoke", "journal.jsonl")).records;
    const recorded = journal.find((event) => event.key === "primaryFailure").value;
    assert.equal(recorded.code, terminalError);
    assert.deepEqual(recorded.terminalDisposal, primary.terminalDisposal);
    const result = JSON.parse(await readFile(join(directory, "claude-install-smoke", "result.json"), "utf8"));
    assert.equal(result.testOutcome, "FAIL");
    assert.equal(result.failure.kind, "functional+cleanup");
    assert.equal(result.failure.primary.terminalError, terminalError);
    assert.equal(result.failure.cleanup.code, "BACKEND_STOP_TIMEOUT");
    assert.doesNotMatch(JSON.stringify([journal, result]), /private|456789|credential|transcript/);
  });
}

test("terminal command projection rejects untyped cleanup diagnostics and private error text", () => {
  assert.deepEqual(projectInstallCommand(failure({ code: 1, terminalError: privateText,
    terminalDisposal: { status: privateText, exitObserved: true, systemCode: privateText } })),
  { status: "nonzero_exit", exitCode: 1 });
});
