#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
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
const malformedPid = "{private-pid-record-canary\n";
const backendToken = "synthetic-backend-token-canary-for-installed-lifecycle";
const healthResponseCanary = "private-health-response-body-canary";
let healthyPort;
let healthyCleanupNeeded = false;

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

  const logHome = join(root, "blocked-backend-log");
  await mkdir(join(logHome, "runtime", "backend", "backend.log"), { recursive: true });
  const logFailure = await jsonFailure("start", logHome, "BACKEND_SERVICE_PREPARE_FAILED", "prepare_runtime");
  assert.equal(logFailure.failure.systemCode, "EISDIR");
  assert.equal(logFailure.failure.processState, "not-started");
  await assert.rejects(readFile(join(logHome, "runtime", "backend", "backend.pid.json")), { code: "ENOENT" });

  const healthHome = join(root, "rejected-backend-health");
  const healthServer = createHttpServer((_request, response) => {
    response.writeHead(503, { "content-type": "text/plain" });
    response.end(healthResponseCanary);
  });
  await new Promise((done, reject) => {
    healthServer.once("error", reject);
    healthServer.listen(0, "127.0.0.1", done);
  });
  try {
    const health = await jsonFailure("start", healthHome, "BACKEND_HEALTH_NOT_READY", "health", {
      port: healthServer.address().port,
    });
    assert.equal(health.failure.failureReason, "http_error");
    assert.equal(health.failure.httpStatus, 503);
    assert.equal(health.failure.processState, "stopped");
    await assertProcessExited(health.backend.state.pid);
    await assert.rejects(readFile(join(healthHome, "runtime", "backend", "backend.pid.json")), { code: "ENOENT" });
    assert.equal(healthServer.listening, true, "Startup failure must leave the unrelated local HTTP stub running");
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
      if (action === "restart") await assertProcessExited(backendPids[0]);
    }
  }
  for (const pid of backendPids) await assertProcessExited(pid);
  await assert.rejects(readFile(join(healthyHome, "runtime", "backend", "backend.pid.json")), { code: "ENOENT" });
  await assertPortAvailable(healthyPort);
  healthyCleanupNeeded = false;
  console.log("Installed lifecycle CLI diagnostics E2E passed (debug off, clients none, local only).");
} finally {
  let cleanupConfirmed = true;
  if (healthyCleanupNeeded) {
    const cleanup = await runCli("stop", healthyHome, { port: healthyPort });
    cleanupConfirmed = cleanup.code === 0;
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

async function assertDiagnostic(report, stateHome) {
  const diagnostic = report.diagnostic;
  assert.equal(diagnostic.recorded, true);
  assert.ok(diagnostic.id);
  assert.equal(diagnostic.path, join(stateHome, "runtime", "diagnostics", `${diagnostic.id}.json`));
  const text = await readFile(diagnostic.path, "utf8");
  for (const canary of [root, stateHome, workspace, malformedPid.trim(), backendToken, healthResponseCanary]) {
    assert.equal(text.includes(canary), false, "Diagnostic records must omit paths, raw PID records, and tokens");
  }
  const record = JSON.parse(text);
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.id, diagnostic.id);
  assert.equal(record.source, "memorax-code");
  assert.equal(record.operation, `backend.${report.action}`);
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

async function runCli(action, stateHome, { json = true, suppressGuidance = false, port = 18787 } = {}) {
  const args = [entrypoint, action, "--home", stateHome, "--host", "127.0.0.1", "--port", String(port), "--clients", "none"];
  if (json) args.push("--json");
  const env = isolatedEnv(stateHome);
  if (suppressGuidance) env.MEMORAX_CODE_BACKEND_SUPPRESS_GUIDANCE = "1";
  try {
    return { ...await execFileAsync(process.execPath, args, { cwd: workspace, env, timeout: 40_000, encoding: "utf8" }), code: 0 };
  } catch (error) {
    if (error.code !== 1) throw error;
    return { stdout: error.stdout, stderr: error.stderr, code: 1 };
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
