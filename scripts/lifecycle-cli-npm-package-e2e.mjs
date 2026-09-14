#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
assert.ok(process.argv[2], "An installed npm package root is required");
const packageRoot = resolve(process.argv[2]);
const entrypoint = join(packageRoot, "bin", "memorax-code.mjs");
const packageVersion = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")).version;
const root = await mkdtemp(join(tmpdir(), "memorax-code-lifecycle-diagnostics-e2e-"));
const userHome = join(root, "user");
const workspace = join(root, "private-workspace-canary");
const healthyHome = join(root, "healthy-state");
const clientHome = join(root, "failed-client-state");
const logHome = join(root, "blocked-backend-log");
const malformedPid = "{private-pid-record-canary\n";
const backendToken = "synthetic-backend-token-canary-for-installed-lifecycle";
const healthResponseCanary = "private-health-response-body-canary";
const clientContentCanary = "private-client-file-content-canary";
let healthyPort;
let healthyCleanupNeeded = false;
let clientPort;
let clientCleanupNeeded = false;
let clientPid;
let logPort;
let logCleanupNeeded = false;

try {
  await Promise.all([userHome, workspace, join(root, "tmp")]
    .map((path) => mkdir(path, { recursive: true })));

  const lockedHome = join(root, "blocked-backend-directory");
  await mkdir(join(lockedHome, "runtime"), { recursive: true });
  await writeFile(join(lockedHome, "runtime", "backend"), "not a directory\n");
  const locked = await jsonFailure("start", lockedHome, "BACKEND_LIFECYCLE_LOCK_FAILED", "lock");
  assert.ok(["EEXIST", "ENOTDIR"].includes(locked.failure.systemCode));
  assert.equal(await readFile(join(lockedHome, "runtime", "backend"), "utf8"), "not a directory\n");

  const invalidHome = join(root, "invalid-pid-state");
  const pidPath = join(invalidHome, "runtime", "backend", "backend.pid.json");
  await mkdir(dirname(pidPath), { recursive: true });
  await writeFile(pidPath, malformedPid);
  for (const action of ["start", "restart"]) {
    const invalid = await jsonFailure(action, invalidHome, "BACKEND_SERVICE_STATE_INVALID", "read_state");
    assert.equal(invalid.failure.recordReason, "malformed_json");
    assert.equal(await readFile(pidPath, "utf8"), malformedPid);
  }
  const beforeHuman = await diagnosticFiles(invalidHome);
  const human = await runCli("stop", invalidHome, { json: false, suppressGuidance: true });
  assert.equal(human.code, 1);
  assert.ok(human.stdout.trim(), "Existing lifecycle summaries must remain on stdout");
  assert.match(human.stderr, /\[MemoraX Code Backend\]:/);
  assert.match(human.stderr, /BACKEND_SERVICE_STATE_INVALID/);
  assert.match(human.stderr, /Next step/);
  const humanFiles = (await diagnosticFiles(invalidHome)).filter((name) => !beforeHuman.includes(name));
  assert.equal(humanFiles.length, 1);
  const humanPath = join(invalidHome, "runtime", "diagnostics", humanFiles[0]);
  const humanRecord = JSON.parse(await readFile(humanPath, "utf8"));
  await assertDiagnostic({
    action: "stop", failure: humanRecord,
    diagnostic: { id: humanRecord.id, recorded: true, path: humanPath },
  }, invalidHome);
  assert.equal(humanRecord.errorCode, "BACKEND_SERVICE_STATE_INVALID");
  assert.equal(humanRecord.stage, "read_state");
  assert.equal(humanRecord.recordReason, "malformed_json");
  for (const value of [humanRecord.id, humanPath, humanRecord.impact, humanRecord.userAction]) {
    assert.ok(human.stderr.includes(value), "Default stderr must include diagnosis and recovery even when guidance is suppressed");
  }
  assert.equal(await readFile(pidPath, "utf8"), malformedPid);
  await assert.rejects(readFile(join(dirname(pidPath), "managed-clients.json")), { code: "ENOENT" });

  const logDirectory = join(logHome, "runtime", "backend", "backend.log");
  const logSentinel = join(logDirectory, "sentinel.txt");
  await mkdir(logDirectory, { recursive: true });
  await writeFile(logSentinel, "preserve blocked log directory contents\n");
  logPort = await freePort();
  logCleanupNeeded = true;
  const logFailure = await jsonFailure("start", logHome, "BACKEND_SERVICE_PREPARE_FAILED", "prepare_runtime", { port: logPort });
  assert.equal(logFailure.failure.systemCode, "EISDIR");
  assert.equal(logFailure.failure.processState, "not-started");
  assert.equal((await stat(logDirectory)).isDirectory(), true);
  assert.equal(await readFile(logSentinel, "utf8"), "preserve blocked log directory contents\n");
  await assert.rejects(readFile(join(logHome, "runtime", "backend", "backend.pid.json")), { code: "ENOENT" });
  await assertPortAvailable(logPort);
  logCleanupNeeded = false;

  const healthHome = join(root, "rejected-backend-health");
  let healthRequests = 0;
  const healthServer = createHttpServer((_request, response) => {
    healthRequests += 1;
    response.writeHead(503, { "content-type": "text/plain" });
    response.end(healthResponseCanary);
  });
  await new Promise((done, reject) => {
    healthServer.once("error", reject);
    healthServer.listen(0, "127.0.0.1", done);
  });
  try {
    const health = await jsonFailure("start", healthHome, "BACKEND_EXITED_BEFORE_READY", "health", {
      port: healthServer.address().port,
    });
    assert.equal(health.failure.error, "Backend process exited before becoming ready.");
    assert.equal(health.failure.failureReason, "http_error");
    assert.equal(health.failure.httpStatus, 503);
    assert.equal(health.failure.processState, "stopped");
    await assertProcessExited(health.backend.state.pid);
    await assert.rejects(readFile(join(healthHome, "runtime", "backend", "backend.pid.json")), { code: "ENOENT" });
    assert.equal(healthServer.listening, true, "Startup failure must leave the unrelated local HTTP stub running");
    const requestsBeforeQuery = healthRequests;
    const offlineHealthHistory = await runCli("logs", healthHome, {
      port: healthServer.address().port, extraArgs: ["--id", health.diagnostic.id],
    });
    assert.equal(offlineHealthHistory.code, 0, offlineHealthHistory.stdout);
    assert.equal(JSON.parse(offlineHealthHistory.stdout).records[0].id, health.diagnostic.id);
    assert.equal(healthRequests, requestsBeforeQuery, "Diagnostic lookup must not probe the Backend");
  } finally {
    healthServer.closeAllConnections();
    await new Promise((done) => healthServer.close(done));
  }

  const blockedHome = join(root, "blocked-diagnostic-directory");
  const blockedPidPath = join(blockedHome, "runtime", "backend", "backend.pid.json");
  await mkdir(dirname(blockedPidPath), { recursive: true });
  await writeFile(blockedPidPath, malformedPid);
  await writeFile(join(blockedHome, "runtime", "diagnostics"), "not a directory\n");
  const blocked = await runCli("stop", blockedHome);
  assert.equal(blocked.code, 1);
  assert.equal(blocked.stderr, "");
  const blockedReport = JSON.parse(blocked.stdout);
  assert.equal(blockedReport.backend.errorCode, "BACKEND_SERVICE_STATE_INVALID");
  assert.equal(blockedReport.failure.errorCode, "BACKEND_SERVICE_STATE_INVALID");
  assert.equal(blockedReport.failure.stage, "read_state");
  assert.equal(blockedReport.diagnostic.recorded, false);
  assert.ok(blockedReport.diagnostic.recordingError);
  assert.equal(await readFile(blockedPidPath, "utf8"), malformedPid);
  assert.equal(await readFile(join(blockedHome, "runtime", "diagnostics"), "utf8"), "not a directory\n");

  const historicalRecords = await assertDiagnosticDiscovery(invalidHome, humanRecord, blockedHome);

  const traeHome = join(root, "private-trae-home-canary");
  await mkdir(traeHome, { recursive: true });
  await writeFile(join(traeHome, "skills"), clientContentCanary);
  clientPort = await freePort();
  clientCleanupNeeded = true;
  const clientOutput = await runCli("start", clientHome, {
    port: clientPort, clients: "trae", extraArgs: ["--trae-home", traeHome],
  });
  assert.equal(clientOutput.code, 1);
  assert.equal(clientOutput.stderr, "");
  const clientReport = JSON.parse(clientOutput.stdout);
  clientPid = clientReport.backend?.state?.pid;
  assert.equal(clientReport.ok, false);
  assert.equal(clientReport.backend.ok, true, "Client deployment failure must not become a Backend failure");
  assert.ok(Number.isSafeInteger(clientPid) && clientPid > 0);
  assert.equal(clientReport.failure, undefined);
  assert.equal(clientReport.diagnostic, undefined);
  assert.equal(clientReport.clientFailures.length, 1);
  const clientFailure = clientReport.clientFailures[0];
  assert.equal(clientFailure.client, "trae");
  assert.equal(clientFailure.failure.errorCode, "CLIENT_SKILL_STAGE_FAILED");
  assert.equal(clientFailure.failure.stage, "skill-stage");
  assert.ok(["EEXIST", "ENOTDIR"].includes(clientFailure.failure.systemCode));
  assert.equal(clientFailure.failure.processState, "running");
  await assertDiagnostic({ ...clientFailure, action: "start" }, clientHome, "client.start");
  const clientRecord = JSON.parse(await readFile(clientFailure.diagnostic.path, "utf8"));
  assert.equal(clientRecord.client, "trae");
  assert.equal((await diagnosticFiles(clientHome)).length, 1);
  assert.equal(await readFile(join(traeHome, "skills"), "utf8"), clientContentCanary);
  const clientStopped = await runCli("stop", clientHome, { port: clientPort });
  assert.equal(clientStopped.code, 0, clientStopped.stdout);
  await assertProcessExited(clientPid);
  await assert.rejects(readFile(join(clientHome, "runtime", "backend", "backend.pid.json")), { code: "ENOENT" });
  await assertPortAvailable(clientPort);
  assert.equal((await diagnosticFiles(clientHome)).length, 1);
  clientCleanupNeeded = false;

  healthyPort = await freePort();
  healthyCleanupNeeded = true;
  const backendPids = [];
  for (const action of ["start", "restart", "stop"]) {
    const output = await runCli(action, healthyHome, { port: healthyPort });
    assert.equal(output.code, 0, `Healthy ${action} failed: ${output.stdout}\n${output.stderr}`);
    assert.equal(output.stderr, "");
    const report = JSON.parse(output.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.action, action);
    assert.equal(report.backend.ok, true);
    assert.equal(report.failure, undefined);
    assert.equal(report.diagnostic, undefined);
    assert.deepEqual(await diagnosticFiles(healthyHome), []);
    if (action !== "stop") {
      const pid = report.backend.state.pid;
      assert.ok(Number.isSafeInteger(pid) && pid > 0);
      backendPids.push(pid);
      assert.equal(processAlive(pid), true);
      if (action === "start") await assertHealthyDiagnosticSummary(historicalRecords);
      if (action === "restart") await assertProcessExited(backendPids[0]);
    }
  }
  for (const pid of backendPids) await assertProcessExited(pid);
  await assert.rejects(readFile(join(healthyHome, "runtime", "backend", "backend.pid.json")), { code: "ENOENT" });
  await assertPortAvailable(healthyPort);
  healthyCleanupNeeded = false;
  console.log("Installed lifecycle CLI diagnostics E2E passed (debug off, isolated clients, local only).");
} finally {
  let cleanupConfirmed = true;
  if (logCleanupNeeded) {
    // Retain the failed fixture and preserve the original assertion if cleanup fails.
    cleanupConfirmed = false;
    try {
      const cleanup = await runCli("stop", logHome, { port: logPort });
      assert.equal(cleanup.code, 0, "Blocked-log fixture Backend stop failed");
      const pid = JSON.parse(cleanup.stdout).backend?.state?.pid;
      if (pid) await assertProcessExited(pid);
      await assert.rejects(readFile(join(logHome, "runtime", "backend", "backend.pid.json")), { code: "ENOENT" });
      await assertPortAvailable(logPort);
    } catch {
      console.error("Blocked-log E2E cleanup could not confirm Backend shutdown; original failure and fixture state were retained.");
    }
  }
  if (clientCleanupNeeded) {
    const cleanup = await runCli("stop", clientHome, { port: clientPort });
    cleanupConfirmed = cleanup.code === 0;
    if (cleanupConfirmed) {
      if (clientPid) await assertProcessExited(clientPid);
      await assert.rejects(readFile(join(clientHome, "runtime", "backend", "backend.pid.json")), { code: "ENOENT" });
      await assertPortAvailable(clientPort);
    }
    else console.error("Client deployment E2E cleanup could not confirm Backend shutdown; fixture state was retained.");
  }
  if (healthyCleanupNeeded) {
    const cleanup = await runCli("stop", healthyHome, { port: healthyPort });
    cleanupConfirmed = cleanup.code === 0 && cleanupConfirmed;
    if (!cleanupConfirmed) console.error("Lifecycle E2E cleanup could not confirm Backend shutdown; fixture state was retained.");
  }
  if (cleanupConfirmed) await rm(root, { recursive: true, force: true });
}

async function jsonFailure(action, stateHome, errorCode, stage, options = {}) {
  const output = await runCli(action, stateHome, options);
  assert.equal(output.code, 1, action);
  assert.equal(output.stderr, "", "JSON output must remain machine-readable with default debug off");
  const report = JSON.parse(output.stdout);
  assert.equal(report.ok, false);
  assert.equal(report.action, action);
  assert.equal(report.backend.ok, false);
  assert.equal(report.backend.errorCode, errorCode);
  assert.equal(report.failure.errorCode, errorCode);
  assert.equal(report.failure.stage, stage);
  await assertDiagnostic(report, stateHome);
  return report;
}

async function assertDiagnostic(report, stateHome, operation = `backend.${report.action}`) {
  const diagnostic = report.diagnostic;
  assert.equal(diagnostic.recorded, true);
  assert.ok(diagnostic.id);
  assert.equal(diagnostic.path, join(stateHome, "runtime", "diagnostics", `${diagnostic.id}.json`));
  const text = await readFile(diagnostic.path, "utf8");
  for (const canary of [root, stateHome, workspace, malformedPid.trim(), backendToken, healthResponseCanary, clientContentCanary]) {
    assert.equal(text.includes(canary), false, "Diagnostic records must omit paths, raw PID records, and tokens");
  }
  const record = JSON.parse(text);
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.id, diagnostic.id);
  assert.equal(record.source, "memorax-code");
  assert.equal(record.operation, operation);
  assert.equal(record.version, packageVersion);
  assert.equal(record.platform, process.platform);
  assert.ok(record.runtimeVersion);
  assert.ok(Number.isFinite(Date.parse(record.timestamp)));
  for (const field of ["errorCode", "stage", "error", "processState", "impact", "userAction"]) {
    assert.ok(record[field]);
    assert.equal(record[field], report.failure[field]);
  }
  for (const field of ["systemCode", "cleanupErrorCode", "cleanupSystemCode", "failureReason", "recordReason", "httpStatus"]) {
    assert.equal(record[field], report.failure[field]);
  }
  for (const field of ["pid", "home", "state", "backend", "report", "token", "logPath"]) assert.equal(record[field], undefined);
  if (process.platform !== "win32") assert.equal((await stat(diagnostic.path)).mode & 0o777, 0o600);
}

async function assertDiagnosticDiscovery(stateHome, realRecord, blockedHome) {
  const directory = join(stateHome, "runtime", "diagnostics");
  const secret = "private-discovery-unknown-field-canary";
  const now = Date.now();
  const copies = [0, 1, 2].map((index) => ({
    ...realRecord,
    id: `mc-${now - 2 + index}-${randomUUID()}`,
    timestamp: new Date(now - 2 + index).toISOString(),
    error: index === 2 ? `${realRecord.error}\u001b[31m\u009b` : realRecord.error,
    token: secret,
    rawException: { message: secret },
  }));
  for (const record of copies) await writeFile(join(directory, `${record.id}.json`), JSON.stringify(record), { mode: 0o600 });
  // Older retained records must remain discoverable beyond the former seven-day/100-record window.
  for (let index = 0; index < 101; index += 1) {
    const timestamp = now - 29 * 24 * 60 * 60 * 1000 - index;
    const record = { ...realRecord, id: `mc-${timestamp}-${randomUUID()}`, timestamp: new Date(timestamp).toISOString() };
    await writeFile(join(directory, `${record.id}.json`), JSON.stringify(record), { mode: 0o600 });
  }
  const validIds = (await diagnosticFiles(stateHome)).map((name) => name.slice(0, -5)).sort().reverse();
  const expiredTimestamp = now - 31 * 24 * 60 * 60 * 1000;
  const expiredRecord = { ...realRecord, id: `mc-${expiredTimestamp}-${randomUUID()}`, timestamp: new Date(expiredTimestamp).toISOString() };
  await writeFile(join(directory, `${expiredRecord.id}.json`), JSON.stringify(expiredRecord), { mode: 0o600 });
  const corruptId = `mc-${now}-${randomUUID()}`;
  await writeFile(join(directory, `${corruptId}.json`), "{corrupt diagnostic", { mode: 0o600 });
  const unsafeId = `mc-${now}-${randomUUID()}`;
  const outsidePath = join(root, "outside-diagnostic.json");
  const outsideText = JSON.stringify({ ...realRecord, id: unsafeId, timestamp: new Date(now).toISOString() });
  await writeFile(outsidePath, outsideText, { mode: 0o600 });
  const unsafePath = join(directory, `${unsafeId}.json`);
  try { await symlink(outsidePath, unsafePath); }
  catch (error) {
    if (process.platform !== "win32" || !["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) throw error;
    await mkdir(unsafePath);
  }
  await writeFile(join(stateHome, "runtime", "backend", "backend-connection.json"), "{invalid connection authority");
  const beforeQueries = await snapshotFiles(stateHome);
  const recentOutput = await queryDiagnostics(stateHome);
  assert.equal(recentOutput.code, 0, recentOutput.stdout);
  assert.equal(recentOutput.stderr, "");
  const recent = JSON.parse(recentOutput.stdout);
  assert.equal(recent.action, "diagnostics");
  assert.equal(recent.ok, true);
  assert.deepEqual(recent.records.map((record) => record.id), validIds.slice(0, 5));
  assert.ok(recent.skipped >= 2);
  assert.ok(recent.errorCode, "Partial discovery must report skipped damaged or unsafe entries");
  assert.equal(recentOutput.stdout.includes(secret), false);
  assert.equal(recent.records.some((record) => [corruptId, unsafeId].includes(record.id)), false);
  const controlled = recent.records.find((record) => record.id === copies[2].id);
  assert.ok(controlled);
  assert.doesNotMatch(controlled.error, /[\u0000-\u001f\u007f-\u009f]/);
  assert.equal(controlled.token, undefined);
  assert.equal(controlled.rawException, undefined);

  const limitedOutput = await queryDiagnostics(stateHome, ["--limit", "2"]);
  assert.equal(limitedOutput.code, 0);
  assert.deepEqual(JSON.parse(limitedOutput.stdout).records.map((record) => record.id), validIds.slice(0, 2));
  const allOutput = await queryDiagnostics(stateHome, ["--limit", "1000"]);
  assert.equal(allOutput.code, 0, allOutput.stdout);
  assert.deepEqual(JSON.parse(allOutput.stdout).records.map((record) => record.id), validIds);
  const lookup = await queryDiagnostics(stateHome, ["--id", realRecord.id]);
  assert.equal(lookup.code, 0);
  assert.equal(JSON.parse(lookup.stdout).records.length, 1);
  assert.equal(JSON.parse(lookup.stdout).records[0].id, realRecord.id);
  const feedback = await queryDiagnostics(stateHome, ["--id", copies[2].id], { json: false });
  assert.equal(feedback.code, 0);
  assert.match(feedback.stdout, /MemoraX Code diagnostic history/);
  for (const label of ["Diagnostic ID", "Time", "Operation", "Stage", "Error code", "Error", "Impact", "Next step"]) {
    assert.ok(feedback.stdout.includes(label), `Feedback text must include ${label}`);
  }
  assert.ok(feedback.stdout.includes(copies[2].id));
  assert.equal(feedback.stdout.includes(secret), false);
  assert.doesNotMatch(feedback.stdout, /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/);

  const unavailable = await runCli("status", stateHome, { connectionOptions: false });
  assert.equal(unavailable.code, 1);
  const unavailableStatus = JSON.parse(unavailable.stdout);
  assert.equal(unavailableStatus.ok, false);
  assert.equal(unavailableStatus.diagnostics.ok, true);
  assert.equal(unavailableStatus.diagnostics.records.length, 3);
  const missing = await queryDiagnostics(stateHome, ["--id", `mc-${Date.now()}-${randomUUID()}`]);
  assert.equal(missing.code, 1);
  assert.equal(JSON.parse(missing.stdout).ok, false);
  for (const args of [["--limit", "0"], ["--limit", "1001"], ["--id", "../invalid-id"]]) {
    const invalid = await queryDiagnostics(stateHome, args);
    assert.equal(invalid.code, 2);
    assert.equal(JSON.parse(invalid.stdout).ok, false);
  }
  assert.deepEqual(await snapshotFiles(stateHome), beforeQueries, "Diagnostic queries must not alter records or Backend authority");
  assert.equal(await readFile(outsidePath, "utf8"), outsideText);
  const blocked = await queryDiagnostics(blockedHome);
  assert.equal(blocked.code, 1);
  assert.equal(JSON.parse(blocked.stdout).ok, false);
  const emptyHome = join(root, "empty-diagnostic-home");
  const empty = await queryDiagnostics(emptyHome, ["--diagnostics"], { homeFlag: false });
  assert.equal(empty.code, 0);
  assert.deepEqual(JSON.parse(empty.stdout).records, []);
  assert.equal(JSON.parse(empty.stdout).ok, true);
  await assert.rejects(stat(emptyHome), { code: "ENOENT" });
  return [realRecord, ...copies];
}

async function assertHealthyDiagnosticSummary(records) {
  const directory = join(healthyHome, "runtime", "diagnostics");
  await mkdir(directory, { recursive: true });
  try {
    for (const record of records) await writeFile(join(directory, `${record.id}.json`), JSON.stringify(record), { mode: 0o600 });
    const status = await runCli("status", healthyHome, { port: healthyPort });
    assert.equal(status.code, 0, status.stdout);
    const report = JSON.parse(status.stdout);
    assert.equal(report.ok, true, "Historical failures must not change current healthy status");
    assert.equal(report.diagnostics.ok, true);
    assert.equal(report.diagnostics.records.length, 3);
    const human = await runCli("status", healthyHome, { port: healthyPort, json: false });
    assert.equal(human.code, 0);
    assert.match(human.stdout, /Recent failures/);
    assert.equal(records.filter((record) => human.stdout.includes(record.id)).length, 3);
    const legacy = await runCli("logs", healthyHome, { port: healthyPort });
    assert.equal(legacy.code, 0);
    const logs = JSON.parse(legacy.stdout);
    assert.equal(logs.action, "logs");
    assert.equal(logs.logPath, join(healthyHome, "runtime", "backend", "backend.log"));
    assert.equal(typeof logs.text, "string");
    assert.equal(logs.records, undefined);
    assert.equal(logs.diagnostics, undefined);
    await rm(directory, { recursive: true });
    await writeFile(directory, "blocked diagnostic history");
    const blocked = await runCli("status", healthyHome, { port: healthyPort });
    assert.equal(blocked.code, 0, blocked.stdout);
    assert.equal(JSON.parse(blocked.stdout).ok, true);
    assert.equal(JSON.parse(blocked.stdout).diagnostics.ok, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function queryDiagnostics(stateHome, extraArgs = ["--diagnostics"], options = {}) {
  return await runCli("logs", stateHome, { connectionOptions: false, extraArgs, ...options });
}

async function snapshotFiles(path) {
  const entries = [];
  for (const name of (await readdir(path)).sort()) {
    const target = join(path, name);
    const metadata = await lstat(target);
    const content = metadata.isDirectory() ? await snapshotFiles(target)
      : metadata.isSymbolicLink() ? await readlink(target) : await readFile(target, "base64");
    entries.push({ name, mode: metadata.mode, mtimeMs: metadata.mtimeMs, content });
  }
  return entries;
}

async function runCli(action, stateHome, { json = true, suppressGuidance = false, port = 18787, clients = "none", extraArgs = [], connectionOptions = true, homeFlag = true } = {}) {
  const args = [entrypoint, action, ...(homeFlag ? ["--home", stateHome] : []),
    ...(connectionOptions ? ["--host", "127.0.0.1", "--port", String(port), "--clients", clients] : []), ...extraArgs];
  if (json) args.push("--json");
  const env = isolatedEnv(stateHome);
  if (suppressGuidance) env.MEMORAX_CODE_BACKEND_SUPPRESS_GUIDANCE = "1";
  try {
    return { ...await execFileAsync(process.execPath, args, { cwd: workspace, env, timeout: 40_000, encoding: "utf8" }), code: 0 };
  } catch (error) {
    if (![1, 2].includes(error.code)) throw error;
    return { stdout: error.stdout, stderr: error.stderr, code: error.code };
  }
}

function isolatedEnv(stateHome) {
  const windowsRoot = process.env.SystemRoot ?? process.env.WINDIR;
  const commandPaths = process.platform === "win32"
    ? [dirname(process.execPath), ...(windowsRoot ? [join(windowsRoot, "System32")] : [])]
    : [dirname(process.execPath), "/usr/bin", "/bin"];
  const env = {
    HOME: userHome, USERPROFILE: userHome,
    APPDATA: join(userHome, "AppData", "Roaming"), LOCALAPPDATA: join(userHome, "AppData", "Local"),
    PATH: commandPaths.join(delimiter),
    TMPDIR: join(root, "tmp"), TMP: join(root, "tmp"), TEMP: join(root, "tmp"),
    XDG_CONFIG_HOME: join(userHome, ".config"), XDG_DATA_HOME: join(userHome, ".local", "share"),
    XDG_STATE_HOME: join(userHome, ".local", "state"), XDG_CACHE_HOME: join(userHome, ".cache"),
    MEMORAX_CODE_HOME: stateHome, MEMORAX_CODE_AUTO_UPDATE: "false", MEMORAX_CODE_INSTALL_WATCHDOG: "0",
    MEMORAX_CODE_BACKEND_TOKEN: backendToken, MEMORAX_CODE_BACKEND_LOOPBACK_AUTH: "1",
    MEMORAX_CODE_MEMORY_RETRIEVAL_ENABLED: "false", MEMORAX_CODE_MEMORY_WRITEBACK_ENABLED: "false",
    CODEX_HOME: join(userHome, ".codex"), DSH_HOME: join(userHome, ".dsh"),
    CLAUDE_CONFIG_DIR: join(userHome, ".claude"), CLAUDE_HOME: join(userHome, ".claude"),
    OPENCODE_CONFIG_DIR: join(userHome, ".config", "opencode"),
    CODEBUDDY_HOME: join(userHome, ".codebuddy"), CODEBUDDY_CONFIG_DIR: join(userHome, ".codebuddy"),
    WORKBUDDY_HOME: join(userHome, ".workbuddy"), WORKBUDDY_CONFIG_DIR: join(userHome, ".workbuddy"),
    TRAE_CN_HOME: join(userHome, ".trae-cn"), TRAE_HOME: join(userHome, ".trae-cn"),
  };
  for (const client of ["CODEX", "CLAUDE", "CODEBUDDY", "WORKBUDDY", "DSH", "OPENCODE", "TRAE"]) {
    env[`MEMORAX_CODE_${client}_COMMAND`] = join(root, "unused-synthetic-client");
    env[`MEMORAX_CODE_${client}_TRACE_ENABLED`] = "false";
  }
  for (const key of ["SystemRoot", "WINDIR", "COMSPEC", "PATHEXT"]) {
    if (process.platform === "win32" && process.env[key]) env[key] = process.env[key];
  }
  assert.equal(env.MEMORAX_CODE_BACKEND_DEBUG_REQUESTS, undefined);
  return env;
}

async function diagnosticFiles(stateHome) {
  try { return (await readdir(join(stateHome, "runtime", "diagnostics"))).sort(); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}

async function freePort() {
  const server = createServer();
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}

async function assertPortAvailable(port) {
  const server = createServer();
  await new Promise((done, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", done); });
  await new Promise((done) => server.close(done));
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
}

async function assertProcessExited(pid) {
  const deadline = Date.now() + 5000;
  while (processAlive(pid) && Date.now() < deadline) await delay(25);
  assert.equal(processAlive(pid), false, "The fixture Backend must exit before cleanup");
}
