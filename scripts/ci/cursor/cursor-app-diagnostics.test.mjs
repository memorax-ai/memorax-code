import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { collectCursorAppDiagnostics, collectCursorAppLaunchDiagnostics, collectCursorAppShellDiagnostics,
  createCursorAppDriverDiagnostics, projectCursorAppDriverDiagnostics,
  collectCursorAppBackendDiagnostics, projectCursorAppBackendDiagnostics,
  collectCursorAppSubmissionDiagnostics, projectCursorAppSubmissionDiagnostics,
  collectCursorAppShellOutputDiagnostics, collectCursorAppStopDiagnostics, collectCursorAppWindowsStopDiagnostics,
  projectCursorAppDiagnostics, projectCursorAppLaunchDiagnostics, projectCursorAppShellDiagnostics,
  projectCursorAppStopDiagnostics, projectCursorAppWindowsStopDiagnostics } from "./cursor-app-diagnostics.mjs";

const privateCanary = "private-content-path-token-canary";
const present = (text) => ({ status: "present", text });
const diagnosticKey = (...parts) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");
function redacted(value, secrets = []) {
  for (const secret of [privateCanary, ...secrets]) assert.equal(JSON.stringify(value).includes(secret), false);
}

test("independent Backend diagnostics retain exact-turn failures without exposing raw history", () => {
  const sessionId = randomUUID(), turnId = randomUUID(), identity = { sessionId, turnId };
  const hash = (id) => createHash("sha256").update(id).digest("hex").slice(0, 24);
  const failure = { schemaVersion: 1, client: "cursor", source: "client-hook",
    sessionHash: hash(sessionId), turnHash: hash(turnId), operation: "memory.turn-start",
    failureReason: "turn_state_unavailable", errorCode: "CURSOR_TURN_STATE_UNAVAILABLE", systemCode: "EACCES",
    error: privateCanary, path: privateCanary };
  const history = { action: "diagnostics", ok: true, skipped: 2, records: [failure,
    ...[{ client: "codex" }, { schemaVersion: 2 }, { source: "private" },
      { sessionHash: hash(randomUUID()) }, { turnHash: hash(randomUUID()) },
      { operation: privateCanary }, { failureReason: privateCanary }].map((change) => ({ ...failure, ...change }))] };
  const value = collectCursorAppBackendDiagnostics(history, identity);
  assert.deepEqual(value, { readStatus: "present", skipped: 2, historyTruncated: false,
    records: [{ operation: failure.operation, reason: failure.failureReason,
      errorCode: failure.errorCode, systemCode: "EACCES" }] });
  assert.deepEqual(projectCursorAppBackendDiagnostics(value), value);
  redacted(value, [sessionId, turnId, failure.sessionHash, failure.turnHash]);
  const unknown = collectCursorAppBackendDiagnostics({ ...history, records: [{ ...failure,
    systemCode: privateCanary, errorCode: privateCanary }] }, identity);
  assert.equal(unknown.records[0].systemCode, "other");
  assert.equal(unknown.records[0].errorCode, "other");
  redacted(unknown);
  assert.equal(collectCursorAppBackendDiagnostics(undefined, identity).readStatus, "unavailable");
  for (const change of [{ action: "logs" }, { ok: false }, { records: privateCanary }, { records: Array(101).fill(failure) }]) {
    assert.equal(collectCursorAppBackendDiagnostics({ ...history, ...change }, identity).readStatus, "invalid");
  }
  assert.equal(collectCursorAppBackendDiagnostics(history, { ...identity, turnId: privateCanary }).readStatus, "invalid");
  assert.equal(collectCursorAppBackendDiagnostics({ ...history, records: Array(100).fill(failure) }, identity).historyTruncated, true);
});

test("Shell output retains fixed failure codes and markers while bounding and redacting raw output", () => {
  const output = collectCursorAppShellOutputDiagnostics({
    stdout: present(JSON.stringify({ ok: false, action: "memory.search", errorCode: "MEMORY_CONFIG_MISSING",
      stage: "configuration", systemCode: "ENOENT", query: privateCanary, diagnostic: { path: privateCanary } })),
    stderr: present(`${privateCanary}: Permission denied\nError [ERR_MODULE_NOT_FOUND]: ${privateCanary}`),
  });
  assert.deepEqual(output, { stdoutStatus: "present", stderrStatus: "present", cliJson: "valid",
    errorCode: "MEMORY_CONFIG_MISSING", stage: "configuration", systemCode: "ENOENT",
    markers: { unsupportedNodeVersion: false, nodeModuleNotFound: true, commandNotFound: false, permissionDenied: true,
      jobBusy: false, jobInvalid: false, directoryConflict: false, pathMissing: false, readOnlyFilesystem: false } });
  redacted(output);
  for (const [text, status] of [[privateCanary, "invalid"], ["[]", "unmatched"],
    [JSON.stringify({ ok: true, action: "memory.search" }), "unmatched"], ["x".repeat(65537), "oversized"]]) {
    const result = collectCursorAppShellOutputDiagnostics({ stdout: present(text) });
    assert.equal(result.cliJson, status);
    assert.equal(result.errorCode, "absent");
    redacted(result);
  }
  const unknown = collectCursorAppShellOutputDiagnostics({ stdout: present(JSON.stringify({ ok: false,
    action: "memory.add", errorCode: privateCanary, stage: privateCanary, systemCode: privateCanary })) });
  for (const key of ["errorCode", "stage", "systemCode"]) assert.equal(unknown[key], "other");
  redacted(unknown);
  const oversized = collectCursorAppShellOutputDiagnostics({ stderr: present("Permission denied".repeat(5000)) });
  assert.equal(oversized.stderrStatus, "oversized");
  assert.equal(oversized.markers.permissionDenied, false);
});

test("Shell stderr markers recognize known errors and reject misleading job and filesystem prefixes", () => {
  for (const [marker, text] of [
    ["unsupportedNodeVersion", "memorax-code: MemoraX Code requires Node.js 20 or newer;"],
    ["nodeModuleNotFound", `Error: Cannot find module '${privateCanary}'`],
    ["commandNotFound", "env: memorax-cli: No such file or directory"],
    ["permissionDenied", "Operation not permitted"],
    ["jobBusy", "native repo memory job is busy"],
    ["jobInvalid", "native repo memory job lease is invalid"],
    ["directoryConflict", `Error: ENOTEMPTY: ${privateCanary}`],
    ["pathMissing", `ENOENT: ${privateCanary}`], ["readOnlyFilesystem", `EROFS: ${privateCanary}`],
  ]) {
    const result = collectCursorAppShellOutputDiagnostics({ stderr: present(text) });
    assert.equal(result.markers[marker], true, marker);
    assert.equal(result.errorCode, "absent");
    redacted(result);
  }
  for (const text of [`native repo memory job identity is invalid: ${privateCanary}`,
    `${privateCanary}: ENOENT: unavailable`, "ENOENT_PRIVATE: unavailable"]) {
    const result = collectCursorAppShellOutputDiagnostics({ stdout: present("Permission denied"), stderr: present(text) });
    assert.ok(Object.values(result.markers).every((value) => value === false));
    redacted(result);
  }
});

test("Shell diagnostics bind approval to the exact failed tool and project only fixed outcomes and policy", () => {
  const toolCallId = randomUUID();
  const run = { error: "CURSOR_APP_EXEC_REJECTED", command: privateCanary,
    execRejection: { kind: "shell", toolCallId, rejectionKind: 2, exitCode: 127 },
    shellApproval: { toolCallId, clicked: true } };
  assert.deepEqual(collectCursorAppShellDiagnostics(run), { rejectionKind: 2, approvalClicked: true, exitCode: 127 });
  for (const change of [{ error: "CURSOR_APP_EXEC_IDENTITY" },
    { shellApproval: { toolCallId: randomUUID(), clicked: true } },
    { shellApproval: { toolCallId, clicked: "true" } },
    { execRejection: { ...run.execRejection, toolCallId: privateCanary } }]) {
    assert.equal(collectCursorAppShellDiagnostics({ ...run, ...change }), undefined);
  }
  const projected = projectCursorAppShellDiagnostics({ rejectionKind: 2, approvalClicked: "true", exitCode: 1.5,
    sandboxPolicy: { type: "workspace_readwrite", networkAccess: false, paths: [privateCanary] },
    output: { cliJson: privateCanary, errorCode: privateCanary, stdout: privateCanary,
      markers: { jobBusy: true, pathMissing: "true", [privateCanary]: true } } });
  assert.equal(Object.hasOwn(projected, "exitCode"), false);
  assert.equal(projected.approvalClicked, false);
  assert.deepEqual(projected.sandboxPolicy, { type: "workspace_readwrite", networkAccess: false });
  assert.equal(projected.output.markers.jobBusy, true);
  assert.equal(projected.output.markers.pathMissing, false);
  assert.deepEqual(projectCursorAppShellDiagnostics(projected), projected);
  redacted(projected);
});

test("launch diagnostics distinguish sandbox failure markers without retaining stderr or paths", () => {
  for (const [marker, log, misleading] of [
    ["sandboxInitializationFailed", "sandbox_init: denied", "sandbox_unknown: denied"],
    ["seatbeltApplyDenied", "sandbox_apply: Operation not permitted", "sandbox_apply:\nOperation not permitted"],
    ["helperSandboxInitializationFailed", "Failed to initialize sandbox.", "Failed to initialize sandbox in secure mode."],
    ["sandboxPolicyDeserializeFailed", "SandboxSerializer: Failed to deserialize policy:", "Failed to deserialize policy:"],
    ["sandboxCompiledPolicyFailed", "SandboxSerializer: Failed to apply compiled policy:", "Failed to apply compiled policy:"],
    ["sandboxSourcePolicyFailed", "SandboxSerializer: Failed to initialize sandbox with source mode policy:", "Failed to initialize sandbox with source mode policy:"],
    ["sandboxPolicyPermissionDenied", "SandboxSerializer: Failed to deserialize policy: Operation not permitted", "SandboxSerializer: Failed to deserialize policy:\nOperation not permitted"],
    ["sandboxPipeLengthReadFailed", "SeatbeltExec: buffer length read failed:", "SeatbeltExec: buffer length read failedextra"],
    ["sandboxPipeBodyReadFailed", "SeatbeltExec: buffer read failed:", "SeatbeltExec: buffer read failedextra"],
    ["processSingletonFailed", "Failed to create a ProcessSingleton", "private singleton"],
    ["networkServiceCrashed", "Network service crashed", "private network"],
    ["gpuProcessFailed", "GPU process launch failed", "private gpu"],
    ["machRegistrationFailed", "bootstrap_register failed", "private bootstrap"],
    ["readOnlyFilesystem", "Read-only file system", "private filesystem"],
    ["permissionDenied", "EACCES", "private permission"],
  ]) {
    const result = collectCursorAppLaunchDiagnostics({ log: `${privateCanary}: ${log}` });
    assert.equal(result.markers[marker], true, marker);
    assert.equal(collectCursorAppLaunchDiagnostics({ log: misleading }).markers[marker], false, marker);
    redacted(result);
  }
  assert.equal(collectCursorAppLaunchDiagnostics({ log: "sandbox_init: " + "x".repeat(1024 * 1024) })
    .markers.sandboxInitializationFailed, false);
  assert.equal(collectCursorAppLaunchDiagnostics({ log:
    "SandboxSerializer: Failed to deserialize policy: " + "x".repeat(256) + "Operation not permitted" })
    .markers.sandboxPolicyPermissionDenied, false);
});

test("process projections retain bounded numeric outcomes, fixed codes and literal booleans", () => {
  for (const project of [projectCursorAppLaunchDiagnostics, projectCursorAppStopDiagnostics, projectCursorAppWindowsStopDiagnostics]) {
    const result = project({ exitCode: 1.5, taskkillExitCode: -1, childExitCode: 0x1_0000_0000,
      spawned: "true", timedOut: "true", signal: privateCanary, childSignal: privateCanary, spawnError: privateCanary,
      log: privateCanary, stderr: privateCanary, markers: { permissionDenied: "true", [privateCanary]: true },
      backend: { errorCode: privateCanary, stage: privateCanary } });
    assert.deepEqual(project(result), result);
    for (const key of ["exitCode", "taskkillExitCode", "childExitCode"]) {
      if (Object.hasOwn(result, key)) assert.equal(result[key], null);
    }
    redacted(result);
  }
  assert.equal(projectCursorAppLaunchDiagnostics({ exitCode: 0xc0000135, spawnError: "ENOENT" }).exitCode, 0xc0000135);
  assert.equal(projectCursorAppStopDiagnostics({ exitCode: 256 }).exitCode, null);
  assert.equal(projectCursorAppWindowsStopDiagnostics({ childExitCode: 0xffff_ffff }).childExitCode, 0xffff_ffff);
});

test("Backend stop diagnostics redact structured failures and bound malformed output", () => {
  const result = collectCursorAppStopDiagnostics({ exitCode: 1, stdout: JSON.stringify({ ok: false, action: "stop",
    backend: { ok: false, errorCode: "BACKEND_OWNERSHIP_UNVERIFIED", stage: "verify_ownership",
      failureReason: "process_probe_inconclusive", systemCode: "EPERM", processState: "unknown",
      state: { pid: 12345, token: privateCanary } }, cursorAdapter: { ok: true, root: privateCanary } }) });
  assert.equal(result.actionMatched, true);
  assert.equal(result.backend.errorCode, "BACKEND_OWNERSHIP_UNVERIFIED");
  assert.deepEqual(result.cursorAdapter, { present: true, ok: true });
  redacted(result, ["12345"]);
  for (const [stdout, status] of [["", "absent"], [privateCanary, "invalid"], ["null", "invalid"],
    ["x".repeat(1024 * 1024 + 1), "oversized"]]) {
    const invalid = collectCursorAppStopDiagnostics({ stdout, signal: "SIGKILL", timedOut: true });
    assert.equal(invalid.jsonStatus, status);
    assert.equal(invalid.backend.present, false);
    assert.equal(invalid.timedOut, true);
    redacted(invalid);
  }
});

test("Windows stop diagnostics capture the held child and distinguish bounded stderr, timeout and overflow", () => {
  const child = { pid: 12345, exitCode: null, signalCode: null };
  const result = collectCursorAppWindowsStopDiagnostics({ child,
    error: { code: 128, stderr: 'ERROR: The process "12345" not found.\r\n' + privateCanary } });
  assert.deepEqual(result, { taskkillExitCode: 128, childExitCode: null, childSignal: "none",
    timedOut: false, outputOverflow: false, markers: { processNotFound: true, accessDenied: false } });
  child.exitCode = 0;
  assert.equal(result.childExitCode, null);
  redacted(result, ["12345"]);
  assert.equal(collectCursorAppWindowsStopDiagnostics({ error: { stderr: Buffer.from("Reason: Access is denied.\n") } })
    .markers.accessDenied, true);
  for (const error of [{ stdout: "ERROR: Access is denied." }, { stderr: "ERROR: Access is denied.extra" },
    { stderr: "\u00e9".repeat(32 * 1024) + "\nERROR: Access is denied." }]) {
    assert.equal(collectCursorAppWindowsStopDiagnostics({ error }).markers.accessDenied, false);
  }
  for (const [code, timedOut, outputOverflow] of [["ETIMEDOUT", true, false], ["ERR_CHILD_PROCESS_STDIO_MAXBUFFER", false, true]]) {
    const stopped = collectCursorAppWindowsStopDiagnostics({ error: { code, killed: true } });
    assert.equal(stopped.timedOut, timedOut);
    assert.equal(stopped.outputOverflow, outputOverflow);
  }
});

async function fixture(t) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "memorax-cursor-diagnostics-")));
  t.after(() => rm(home, { recursive: true, force: true }));
  const sessionId = randomUUID(), turnId = randomUUID();
  const store = join(home, "runtime/cursor/turns", createHash("sha256").update(sessionId).digest("hex") + ".json");
  const trace = join(home, "debug/traces/cursor/sessions", sessionId, "events.jsonl");
  await mkdir(dirname(store), { recursive: true });
  await mkdir(dirname(trace), { recursive: true });
  const record = { version: 2, client: "cursor", sessionId, active: { turnId, state: "open", stopStatus: "completed",
    reason: "native_final_response_pending", responseDigest: "a".repeat(64), metadata: { secret: privateCanary }, retryUntil: 42 } };
  const event = (type, outcome, identities = {}) => ({ type, outcome,
    trace: { client: "cursor", session_id: sessionId, turn_id: turnId, ...identities }, request: { prompt: privateCanary } });
  const collect = async () => {
    const value = await collectCursorAppDiagnostics({ home, sessionId, turnId });
    assert.deepEqual(projectCursorAppDiagnostics(value), value);
    redacted(value, [home, sessionId, turnId, "a".repeat(64)]);
    return value;
  };
  return { home, sessionId, turnId, store, trace, record, event, collect };
}

test("turn diagnostics correlate exact client/session/generation, preserve interruption metadata status and never write", async (t) => {
  const f = await fixture(t);
  await writeFile(f.store, JSON.stringify(f.record));
  const events = [f.event("turn_start"), f.event("turn_end", "completed"), f.event("turn_materialized"),
    f.event("turn_start", undefined, { turn_id: randomUUID() }), f.event("turn_start", undefined, { session_id: randomUUID() }),
    f.event("turn_start", undefined, { client: "codex" })];
  await writeFile(f.trace, events.map(JSON.stringify).join("\n"));
  const value = await f.collect();
  assert.deepEqual(value.turnStore, { readStatus: "present", versionMatched: true, clientMatched: true,
    sessionMatched: true, activePresent: true, turnMatched: true, state: "open", stopStatus: "completed",
    reason: "native_final_response_pending", responseDigestPresent: true, metadataPresent: true, retryUntilPresent: true, diagnostics: [] });
  assert.deepEqual(value.trace, { readStatus: "present", eventCount: 6, turnStartCount: 1,
    completedCount: 1, interruptedCount: 0, materializedCount: 1 });
  assert.deepEqual(JSON.parse(await readFile(f.store, "utf8")), f.record);
  f.record.active = { turnId: f.turnId, state: "interrupted", stopStatus: "aborted", reason: "interrupted" };
  await writeFile(f.store, JSON.stringify(f.record));
  await writeFile(f.trace, JSON.stringify(f.event("turn_end", "interrupted")));
  const cancelled = await f.collect();
  assert.equal(cancelled.turnStore.state, "interrupted");
  assert.equal(cancelled.turnStore.stopStatus, "aborted");
  assert.equal(cancelled.turnStore.metadataPresent, false);
  assert.equal(cancelled.turnStore.responseDigestPresent, false);
  assert.equal(cancelled.trace.interruptedCount, 1);
});

test("stored diagnostic hashes distinguish current-turn failures and session classifications, with bounded identity checks", async (t) => {
  const f = await fixture(t);
  const turn = { operation: "memory.writeback", reason: "start_missing", scope: "turn" };
  const session = { operation: "memory.turn-start", reason: "database_native_format_invalid", scope: "session" };
  delete f.record.active;
  f.record.diagnosticKeys = [diagnosticKey(turn.operation, f.turnId, turn.reason), diagnosticKey(session.operation, session.reason),
    diagnosticKey(turn.operation, randomUUID(), turn.reason), diagnosticKey("memory.writeback", "start_missing"),
    diagnosticKey("memory.turn-start", "database_unavailable"), diagnosticKey(privateCanary, f.turnId, turn.reason)];
  await writeFile(f.store, JSON.stringify(f.record));
  assert.deepEqual((await f.collect()).turnStore.diagnostics, [turn, session]);
  assert.deepEqual((await collectCursorAppDiagnostics({ ...f, turnId: randomUUID() })).turnStore.diagnostics, [session]);
  for (const change of [{ version: 1 }, { client: "codex" }, { sessionId: randomUUID() },
    { diagnosticKeys: [privateCanary] }, { diagnosticKeys: Array(65).fill(f.record.diagnosticKeys[0]) }]) {
    await writeFile(f.store, JSON.stringify({ ...f.record, ...change }));
    assert.deepEqual((await f.collect()).turnStore.diagnostics, []);
  }
  const projected = projectCursorAppDiagnostics({ turnStore: { readStatus: "present", versionMatched: true,
    clientMatched: true, sessionMatched: true, diagnostics: [turn, session, turn,
      { ...session, reason: "database_unavailable" }, { ...turn, scope: privateCanary }] } });
  assert.deepEqual(projected.turnStore.diagnostics, [turn, session]);
  redacted(projected);
});

test("diagnostic reads reject invalid records, excessive sizes/events, unsafe files and malformed identities", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.collect()).turnStore.readStatus, "absent");
  for (const [text, status] of [[privateCanary, "invalid"], ["[]", "invalid"], [Buffer.from([0xff]), "invalid"],
    [Buffer.alloc(1024 * 1024 + 1), "oversized"]]) {
    await writeFile(f.store, text);
    await writeFile(f.trace, text);
    const value = await f.collect();
    assert.equal(value.turnStore.readStatus, status);
    assert.equal(value.trace.readStatus, status);
  }
  await writeFile(f.trace, "{}\n".repeat(4097));
  assert.equal((await f.collect()).trace.readStatus, "oversized");
  await rm(f.store);
  await mkdir(f.store);
  assert.equal((await f.collect()).turnStore.readStatus, "unsafe");
  for (const change of [{ home: "relative" }, { sessionId: "../private" }, { turnId: `${f.turnId}\n` }]) {
    const value = await collectCursorAppDiagnostics({ ...f, ...change });
    assert.equal(value.turnStore.readStatus, "invalid");
    redacted(value);
  }
});

test("diagnostic reads reject symlink files and parent directories", {
  skip: process.platform === "win32" ? "Symlink permission is runner-dependent" : false,
}, async (t) => {
  const f = await fixture(t), target = join(f.home, "private");
  await writeFile(target, JSON.stringify(f.record));
  await symlink(target, f.store);
  assert.equal((await f.collect()).turnStore.readStatus, "unsafe");
  await rm(dirname(f.store), { recursive: true });
  await symlink(f.home, dirname(f.store));
  assert.equal((await f.collect()).turnStore.readStatus, "unsafe");
});

test("turn report projection discards arbitrary fields and invalid counters", () => {
  const value = projectCursorAppDiagnostics({ secret: privateCanary,
    turnStore: { readStatus: "present", reason: privateCanary, stopStatus: privateCanary, responseDigestPresent: "true" },
    trace: { readStatus: "present", eventCount: 9, completedCount: -1, interruptedCount: 4097,
      materializedCount: "1", raw: privateCanary } });
  assert.equal(value.turnStore.reason, "other");
  assert.equal(value.turnStore.stopStatus, "other");
  assert.equal(value.turnStore.responseDigestPresent, false);
  assert.deepEqual(value.trace, { readStatus: "present", eventCount: 9, turnStartCount: 0,
    completedCount: 0, interruptedCount: 0, materializedCount: 0 });
  redacted(value);
});


test("submission diagnostics classify bounded Playwright failures without exposing their content", () => {
  for (const [message, name, code, failureKind] of [
    ["locator.fill: Timeout 10000ms exceeded.", "TimeoutError", undefined, "timeout"],
    ["locator.fill: Error: strict mode violation: locator resolved to 2 elements", "Error", undefined, "ambiguous"],
    ["locator.press: Element is not attached to the DOM", "Error", undefined, "detached"],
    ["locator.fill: Timeout 10000ms exceeded; element was detached", "TimeoutError", undefined, "detached"],
    ["locator.fill: Element is not editable", "Error", undefined, "not-editable"],
    ["locator.fill: Error: Element is not an <input>, <textarea> or [contenteditable] element", "Error", undefined, "not-editable"],
    ["", "Error", "CURSOR_APP_SKILL_MENU", "timeout"],
    ["", "Error", "CURSOR_APP_SKILL_MENTION", "timeout"],
    [privateCanary, "Error", privateCanary, "other"],
    ["x".repeat(8192) + " strict mode violation", "Error", undefined, "other"],
  ]) {
    const value = collectCursorAppSubmissionDiagnostics({ phase: "fill", error: { name, code, message: message + privateCanary },
      readStatus: "present", composerCount: 1, inputCount: 2, primaryInputCount: 1, editingInputCount: 1,
      composerStatus: "cancelled", selectedSessionMatches: true, editable: null, raw: privateCanary });
    assert.equal(value.failureKind, failureKind);
    assert.equal(value.phase, "fill");
    assert.equal(value.inputCount, 2);
    assert.equal(value.editable, null);
    assert.deepEqual(projectCursorAppSubmissionDiagnostics(value), value);
    redacted(value);
  }
});

test("submission projections preserve only bounded counts, literal booleans and known states", () => {
  const valid = { phase: "enter", failureKind: "not-editable", readStatus: "present", composerCount: 0,
    inputCount: 64, primaryInputCount: 1, editingInputCount: 0, composerStatus: "completed", editable: false,
    selectedSessionMatches: false };
  assert.deepEqual(projectCursorAppSubmissionDiagnostics({ ...valid, sessionId: privateCanary, error: privateCanary }), valid);
  for (const invalid of [-1, 65, 1.5, NaN, Infinity, "1", true, {}, null, undefined]) {
    const value = projectCursorAppSubmissionDiagnostics({ phase: privateCanary, failureKind: privateCanary,
      readStatus: privateCanary, composerCount: invalid, inputCount: invalid, primaryInputCount: invalid,
      editingInputCount: invalid, composerStatus: privateCanary, editable: privateCanary, selectedSessionMatches: privateCanary });
    assert.deepEqual(value, { phase: "other", failureKind: "other", readStatus: "other", composerCount: null,
      inputCount: null, primaryInputCount: null, editingInputCount: null, composerStatus: "other", editable: null,
      selectedSessionMatches: null });
    redacted(value);
  }
  assert.equal(collectCursorAppSubmissionDiagnostics({ error: privateCanary }).failureKind, "other");
  assert.equal(projectCursorAppSubmissionDiagnostics().readStatus, "unavailable");
});


test("driver readiness keeps first and last probes, frozen timings and unavailable versus zero observations", () => {
  let clock = 100;
  const snapshots = [], driver = createCursorAppDriverDiagnostics({ now: () => clock, onUpdate: value => snapshots.push(value) });
  assert.equal(driver.snapshot().cdpConnected, false);
  assert.equal(driver.snapshot().probeCount, 0);
  assert.equal(driver.snapshot().waitElapsedMs, null);
  assert.equal(driver.snapshot().firstProbe, null);
  clock = 150; driver.connected(); driver.beginWait();
  const first = driver.beginProbe({ contextCount: 1, pageCount: 0, workbenchCount: 0, pageSelected: false });
  assert.equal(first.evaluation, "not-started");
  clock = 350;
  const second = driver.beginProbe({ contextCount: 1, pageCount: 2, workbenchCount: 1, pageSelected: true });
  const pending = driver.snapshot();
  assert.equal(pending.lastProbe.evaluation, "pending");
  assert.equal(pending.lastProbe.completedElapsedMs, null);
  clock = 360; driver.resolved(second, true);
  const result = driver.finish("ready");
  assert.equal(result.cdpConnectedElapsedMs, 50);
  assert.equal(result.elapsedMs, 260);
  assert.equal(result.waitElapsedMs, 210);
  assert.equal(result.probeCount, 2);
  assert.equal(result.firstProbe.pageCount, 0);
  assert.equal(result.lastProbe.driverState, "ready");
  assert.equal(result.lastProbe.completedElapsedMs, 260);
  assert.equal(result.slowProbeCount, 0);
  assert.equal(result.lastProbe.slowAtElapsedMs, null);
  assert.equal(pending.lastProbe.evaluation, "pending");
  clock = 900000;
  driver.closeAt(0); driver.slow();
  driver.timeout("overall"); driver.rejected(second, new Error(privateCanary)); driver.resolved(first, true);
  driver.connected(); driver.beginWait(); driver.beginProbe({ pageSelected: true }); driver.finish("failed");
  assert.deepEqual(driver.snapshot(), result);
  assert.deepEqual(snapshots.at(-1), result);
  const absent = projectCursorAppDriverDiagnostics({});
  assert.equal(absent.cdpConnected, null);
  assert.equal(absent.probeCount, null);
  assert.equal(absent.elapsedMs, null);
  assert.equal(absent.timeoutKind, "unavailable");
  assert.equal(absent.slowProbeCount, null);
});

test("driver readiness marks a pending probe slow once and ignores probe results at or after its deadline", () => {
  let clock = 100;
  const driver = createCursorAppDriverDiagnostics({ now: () => clock });
  driver.connected(); driver.beginWait(); driver.closeAt(1100);
  driver.slow();
  assert.equal(driver.snapshot().slowProbeCount, 0);
  const absent = driver.beginProbe({ contextCount: 1, pageCount: 0, workbenchCount: 0, pageSelected: false });
  driver.slow();
  assert.equal(absent.slowAtElapsedMs, null);
  clock = 200;
  const probe = driver.beginProbe({ contextCount: 1, pageCount: 1, workbenchCount: 1, pageSelected: true });
  clock = 700; driver.slow();
  clock = 800; driver.slow();
  assert.equal(driver.snapshot().slowProbeCount, 1);
  assert.equal(driver.snapshot().lastProbe.slowAtElapsedMs, 600);
  clock = 1100;
  driver.resolved(probe, true); driver.rejected(probe, new Error(privateCanary)); driver.slow();
  driver.timeout("overall");
  const result = driver.finish("failed");
  assert.equal(result.timeoutKind, "overall");
  assert.equal(result.slowProbeCount, 1);
  assert.equal(result.lastProbe.evaluation, "pending");
  assert.equal(result.lastProbe.driverState, "unobserved");
  assert.equal(result.lastProbe.completedElapsedMs, null);
  assert.equal(result.waitElapsedMs, 1000);
  redacted(result);
});

test("a driver probe that completes after 5s is slow at its completion, once, and never after its deadline", () => {
  let clock = 0;
  const driver = createCursorAppDriverDiagnostics({ now: () => clock });
  driver.connected(); driver.beginWait(); driver.closeAt(40000);
  const probe = () => driver.beginProbe({ contextCount: 1, pageCount: 1, workbenchCount: 1, pageSelected: true });
  const quick = probe();
  clock = 4999; driver.resolved(quick, false);
  assert.equal(quick.slowAtElapsedMs, null);
  const absent = probe();
  clock = 9999; driver.resolved(absent, false);
  const rejected = probe();
  clock = 15000; driver.rejected(rejected, new Error("Execution context was destroyed"));
  const ready = probe();
  clock = 20000; driver.slow();
  clock = 21000; driver.resolved(ready, true);
  assert.deepEqual([absent, rejected, ready].map((item) => item.slowAtElapsedMs), [9999, 15000, 20000]);
  assert.equal(driver.snapshot().slowProbeCount, 3);
  const late = probe();
  clock = 40000; driver.resolved(late, true);
  const result = driver.finish("failed");
  assert.equal(result.slowProbeCount, 3);
  assert.equal(result.lastProbe.evaluation, "pending");
  assert.equal(result.lastProbe.slowAtElapsedMs, null);
  clock = 50000; driver.resolved(late, true);
  assert.deepEqual(driver.snapshot(), result);
});

test("driver evaluation failures have fixed categories and retain no error messages, URLs or titles", () => {
  for (const [message, name, category] of [
    ["Target page, context or browser has been closed", "Error", "page-closed"],
    ["Execution context was destroyed, most likely because of a navigation", "Error", "context-destroyed"],
    ["Timeout 5000ms exceeded", "Error", "timeout"],
    ["unrecognized", "TimeoutError", "timeout"],
    ["unrecognized", "Error", "other"],
  ]) {
    const driver = createCursorAppDriverDiagnostics({ onUpdate() { throw new Error(privateCanary); } });
    driver.connected(); driver.beginWait();
    const probe = driver.beginProbe({ contextCount: 1, pageCount: 1, workbenchCount: 1, pageSelected: true,
      url: privateCanary, title: privateCanary });
    driver.rejected(probe, { name, message: message + " " + privateCanary, stack: privateCanary });
    driver.timeout("overall"); driver.timeout("predicate");
    const result = driver.finish("failed");
    assert.equal(result.lastProbe.evaluation, "rejected");
    assert.equal(result.lastProbe.evaluationFailure, category);
    assert.equal(result.lastProbe.driverState, "unobserved");
    assert.equal(result.timeoutKind, "overall");
    redacted(result);
  }
  const result = projectCursorAppDriverDiagnostics({ cdpConnected: "true", cdpConnectedElapsedMs: -1,
    probeCount: 10001, slowProbeCount: -1, elapsedMs: Infinity, waitElapsedMs: 600001, outcome: privateCanary, timeoutKind: privateCanary,
    firstProbe: { elapsedMs: 0, completedElapsedMs: 0, contextCount: 0, pageCount: 10001, workbenchCount: 1.5, slowAtElapsedMs: 600001,
      driverState: privateCanary, evaluation: privateCanary, evaluationFailure: privateCanary, url: privateCanary },
    lastProbe: privateCanary, title: privateCanary, rawError: privateCanary });
  assert.equal(result.cdpConnected, null);
  for (const key of ["cdpConnectedElapsedMs", "probeCount", "slowProbeCount", "elapsedMs", "waitElapsedMs"]) assert.equal(result[key], null);
  assert.equal(result.firstProbe.slowAtElapsedMs, null);
  assert.equal(result.firstProbe.contextCount, 0);
  assert.equal(result.firstProbe.pageCount, null);
  assert.equal(result.firstProbe.workbenchCount, null);
  assert.equal(result.lastProbe, null);
  redacted(result);
});
