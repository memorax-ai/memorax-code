#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
assert.ok(process.argv[2], "An installed npm package root is required");
const packageRoot = resolve(process.argv[2]);
const entrypoint = join(packageRoot, "bin", "memorax-code.mjs");
const packageVersion = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")).version;
const root = await mkdtemp(join(tmpdir(), "memorax-code-setup-diagnostics-e2e-"));
const userHome = join(root, "user");
const workspace = join(root, "private-setup-workspace-canary");
const apiKey = `sk_${"E".repeat(43)}`;
const configCanary = "private-config-secret-canary";
const malformedPid = "{private-setup-pid-canary\n";
const clients = ["codex", "claude", "dsh", "opencode", "codebuddy", "workbuddy", "trae"];
const disabledClients = `[clients]\n${clients.map((client) => `${client} = false`).join("\n")}\n`;
const healthyHome = join(root, "healthy-state");
let healthyPort;
let healthyCleanupNeeded = false;

try {
  await Promise.all([userHome, workspace, join(root, "tmp")].map((path) => mkdir(path, { recursive: true })));

  const backendHome = await prepareHome("invalid-backend-state");
  const pidPath = join(backendHome, "runtime", "backend", "backend.pid.json");
  await mkdir(dirname(pidPath), { recursive: true });
  await writeFile(pidPath, malformedPid);
  const failedBackend = await runSetup(backendHome);
  assert.equal(failedBackend.code, 1);
  assert.match(failedBackend.stderr, /BACKEND_SERVICE_STATE_INVALID/);
  assert.match(failedBackend.stderr, /read_state/);
  assert.match(failedBackend.stderr, /malformed_json/);
  assert.doesNotMatch(failedBackend.stderr, /Attempting automatic recovery/);
  const backendRecords = await diagnosticRecords(backendHome);
  assert.equal(backendRecords.length, 1, "Setup must reuse the Backend diagnostic without creating a duplicate setup record");
  await assertDiagnostic(backendRecords[0], failedBackend, {
    source: "memorax-code", operation: "backend.start", errorCode: "BACKEND_SERVICE_STATE_INVALID", stage: "read_state",
  });
  assert.equal(backendRecords[0].record.recordReason, "malformed_json");
  assert.equal(await readFile(pidPath, "utf8"), malformedPid);
  await assertIncomplete(backendHome);

  const malformedConfig = `${disabledClients}\n[memorax]\napi_key = "${configCanary}"\nbroken = [\n`;
  const configHome = await prepareHome("invalid-config", malformedConfig);
  const failedConfig = await runSetup(configHome);
  assert.equal(failedConfig.code, 1);
  const configRecords = await diagnosticRecords(configHome);
  const configDiagnostic = configRecords.find(({ record }) => record.errorCode === "CONFIG_PARSE_EXISTING_FAILED");
  assert.ok(configDiagnostic, "Malformed TOML must retain its precise parse stage");
  await assertDiagnostic(configDiagnostic, failedConfig, {
    source: "memorax-code-setup", operation: "setup", errorCode: "CONFIG_PARSE_EXISTING_FAILED", stage: "config.parse_existing",
  });
  assert.equal(configDiagnostic.record.recordReason, "invalid_toml");
  assert.equal(configDiagnostic.record.configState, "preserved");
  assert.equal(await readFile(join(configHome, "config.toml"), "utf8"), malformedConfig);
  assert.doesNotMatch(failedConfig.stderr, /Starting backend/);
  await assertIncomplete(configHome);

  const authorityHome = await prepareHome("invalid-setup-authority");
  const authorityPath = completionPath(authorityHome);
  await mkdir(authorityPath, { recursive: true });
  const failedAuthority = await runSetup(authorityHome);
  assert.equal(failedAuthority.code, 1);
  const authorityRecords = await diagnosticRecords(authorityHome);
  assert.equal(authorityRecords.length, 1);
  await assertDiagnostic(authorityRecords[0], failedAuthority, {
    source: "memorax-code-setup", operation: "setup", errorCode: "SETUP_COMPLETION_RECORD_INVALID", stage: "setup_state",
  });
  assert.equal(authorityRecords[0].record.recordReason, "unreadable");
  assert.doesNotMatch(failedAuthority.stderr, /SETUP_COMPLETION_WRITE_FAILED|Starting backend/);
  assert.equal((await stat(authorityPath)).isDirectory(), true);
  assert.deepEqual(await readdir(authorityPath), []);
  await assert.rejects(readFile(join(authorityHome, "runtime", "backend", "backend.pid.json")), { code: "ENOENT" });

  await prepareHome("healthy-state");
  healthyPort = await freePort();
  healthyCleanupNeeded = true;
  const healthy = await runSetup(healthyHome, healthyPort);
  assert.equal(healthy.code, 0, `Healthy setup failed: ${healthy.stdout}\n${healthy.stderr}`);
  assert.match(healthy.stderr, /Setup completed successfully/);
  const completion = JSON.parse(await readFile(completionPath(healthyHome), "utf8"));
  assert.equal(completion.version, 1);
  assert.equal(completion.state, "complete");
  assert.equal(completion.completedByVersion, packageVersion);
  assert.deepEqual(await diagnosticRecords(healthyHome), []);
  const backend = JSON.parse(await readFile(join(healthyHome, "runtime", "backend", "backend.pid.json"), "utf8"));
  const stopped = await runCommand(["stop", "--home", healthyHome, "--clients", "none", "--json"], healthyHome, healthyPort);
  assert.equal(stopped.code, 0, stopped.stderr);
  assert.equal(JSON.parse(stopped.stdout).ok, true);
  assert.throws(() => process.kill(backend.pid, 0), { code: "ESRCH" });
  await assert.rejects(readFile(join(healthyHome, "runtime", "backend", "backend.pid.json")), { code: "ENOENT" });
  assert.deepEqual(await diagnosticRecords(healthyHome), []);
  healthyCleanupNeeded = false;
  console.log("Installed setup CLI diagnostics E2E passed (debug off, clients disabled, no remote or trial setup).");
} finally {
  let cleanupConfirmed = true;
  if (healthyCleanupNeeded) {
    const cleanup = await runCommand(["stop", "--home", healthyHome, "--clients", "none", "--json"], healthyHome, healthyPort);
    cleanupConfirmed = cleanup.code === 0;
    if (!cleanupConfirmed) console.error("Setup E2E could not confirm Backend shutdown; fixture state was retained.");
  }
  if (cleanupConfirmed) await rm(root, { recursive: true, force: true });
}

async function prepareHome(name, config = disabledClients) {
  const stateHome = join(root, name);
  await mkdir(stateHome, { recursive: true });
  await writeFile(join(stateHome, "config.toml"), config, { mode: 0o600 });
  return stateHome;
}

async function runSetup(stateHome, port = 18787) {
  const result = await runCommand(["setup", "--existing-account", "--non-interactive", "--home", stateHome], stateHome, port, `${apiKey}\n`);
  for (const secret of [apiKey, configCanary, malformedPid.trim()]) {
    assert.equal(`${result.stdout}\n${result.stderr}`.includes(secret), false, "Setup output must not disclose input secrets or raw invalid records");
  }
  assert.doesNotMatch(result.stderr, /\[memorax-code-backend:debug\]|Creating or restoring a secure MemoraX credential/);
  await assert.rejects(readdir(join(stateHome, "runtime", "credentials")), { code: "ENOENT" });
  return result;
}

async function runCommand(args, stateHome, port, input = "") {
  const pending = execFileAsync(process.execPath, [entrypoint, ...args], {
    cwd: workspace, env: isolatedEnv(stateHome, port), timeout: 45_000, encoding: "utf8",
  });
  pending.child.stdin.end(input);
  try { return { ...await pending, code: 0 }; }
  catch (error) {
    if (error.code !== 1) throw error;
    return { stdout: error.stdout, stderr: error.stderr, code: 1 };
  }
}

function isolatedEnv(stateHome, port) {
  const windowsRoot = process.env.SystemRoot ?? process.env.WINDIR;
  const commandPaths = process.platform === "win32"
    ? [dirname(process.execPath), ...(windowsRoot ? [join(windowsRoot, "System32")] : [])]
    : [dirname(process.execPath), "/usr/bin", "/bin"];
  const env = {
    HOME: userHome, USERPROFILE: userHome, PATH: commandPaths.join(delimiter),
    APPDATA: join(userHome, "AppData", "Roaming"), LOCALAPPDATA: join(userHome, "AppData", "Local"),
    TMPDIR: join(root, "tmp"), TMP: join(root, "tmp"), TEMP: join(root, "tmp"),
    XDG_CONFIG_HOME: join(userHome, ".config"), XDG_DATA_HOME: join(userHome, ".local", "share"),
    XDG_STATE_HOME: join(userHome, ".local", "state"), XDG_CACHE_HOME: join(userHome, ".cache"),
    MEMORAX_CODE_HOME: stateHome, MEMORAX_CODE_AUTO_UPDATE: "false", MEMORAX_CODE_INSTALL_WATCHDOG: "0",
    MEMORAX_CODE_BACKEND_HOST: "127.0.0.1", MEMORAX_CODE_BACKEND_PORT: String(port),
    MEMORAX_CODE_MEMORAX_ENDPOINT: "http://127.0.0.1:9",
    MEMORAX_CODE_MEMORY_RETRIEVAL_ENABLED: "false", MEMORAX_CODE_MEMORY_WRITEBACK_ENABLED: "false",
    CODEX_HOME: join(userHome, ".codex"), DSH_HOME: join(userHome, ".dsh"),
    CLAUDE_CONFIG_DIR: join(userHome, ".claude"), CLAUDE_HOME: join(userHome, ".claude"),
    OPENCODE_CONFIG_DIR: join(userHome, ".config", "opencode"),
    CODEBUDDY_HOME: join(userHome, ".codebuddy"), CODEBUDDY_CONFIG_DIR: join(userHome, ".codebuddy"),
    WORKBUDDY_HOME: join(userHome, ".workbuddy"), WORKBUDDY_CONFIG_DIR: join(userHome, ".workbuddy"),
    TRAE_CN_HOME: join(userHome, ".trae-cn"), TRAE_HOME: join(userHome, ".trae-cn"),
  };
  for (const client of clients) {
    env[`MEMORAX_CODE_${client.toUpperCase()}_COMMAND`] = join(root, "unused-synthetic-client");
    env[`MEMORAX_CODE_${client.toUpperCase()}_TRACE_ENABLED`] = "false";
    env[`MEMORAX_CODE_SKIP_${client.toUpperCase()}_ADAPTER_INSTALL`] = "1";
  }
  env.MEMORAX_CODE_SKIP_CODEX_PLUGIN_INSTALL = "1";
  for (const key of ["SystemRoot", "WINDIR", "COMSPEC", "PATHEXT"]) {
    if (process.platform === "win32" && process.env[key]) env[key] = process.env[key];
  }
  assert.equal(env.MEMORAX_CODE_BACKEND_DEBUG_REQUESTS, undefined);
  assert.equal(env.MEMORAX_CODE_SETUP_VERBOSE, undefined);
  return env;
}

async function diagnosticRecords(stateHome) {
  const directory = join(stateHome, "runtime", "diagnostics");
  let files;
  try { files = await readdir(directory); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  return await Promise.all(files.map(async (name) => {
    const path = join(directory, name);
    const text = await readFile(path, "utf8");
    for (const canary of [root, apiKey, configCanary, malformedPid.trim()]) {
      assert.equal(text.includes(canary), false, "Diagnostic records must omit paths, secrets, and invalid source contents");
    }
    return { path, record: JSON.parse(text) };
  }));
}

async function assertDiagnostic({ path, record }, output, expected) {
  for (const [field, value] of Object.entries(expected)) assert.equal(record[field], value);
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.version, packageVersion);
  assert.equal(record.platform, process.platform);
  assert.ok(record.runtimeVersion);
  assert.ok(Number.isFinite(Date.parse(record.timestamp)));
  assert.ok(record.id && record.error && record.impact && record.userAction);
  for (const value of [record.errorCode, record.stage, record.id, path, record.userAction]) {
    assert.ok(output.stderr.includes(value), "Default setup output must show the same persisted diagnostic and recovery guidance");
  }
  if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
}

function completionPath(stateHome) {
  return join(stateHome, "runtime", "setup", "setup-completion.json");
}

async function assertIncomplete(stateHome) {
  await assert.rejects(readFile(completionPath(stateHome)), { code: "ENOENT" });
}

async function freePort() {
  const server = createServer();
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}
