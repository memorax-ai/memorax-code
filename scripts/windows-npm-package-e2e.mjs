#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";

main().catch((error) => {
  console.error(`windows_npm_package_e2e_failed: ${safeFailureMessage(error)}`);
  process.exitCode = 1;
});

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const prefix = resolve(required(options, "prefix"));
  const workspace = resolve(required(options, "workspace"));
  const mode = options.mode ?? "lifecycle";
  const port = parsePort(options.port ?? "18787");
  const packageRoot = join(prefix, "node_modules", "@memorax/memorax-code-preview");
  const memoraxCode = join(packageRoot, "bin", "memorax-code.mjs");
  const childEnv = { ...process.env, MEMORAX_CODE_BACKEND_PORT: String(port) };
  process.chdir(workspace);

  if (mode === "lifecycle") {
    await runLifecycle({
      childEnv,
      memoraxCode,
      options,
      packageRoot,
      port,
      workspace,
    });
    return;
  }
  if (mode === "updated") {
    await runUpdated({
      childEnv,
      memoraxCode,
      options,
      packageRoot,
      port,
      prefix,
      workspace,
    });
    return;
  }
  throw new Error(`unknown mode: ${mode}`);
}

async function runLifecycle({
  childEnv,
  memoraxCode,
  options,
  packageRoot,
  port,
  workspace,
}) {
  const manifest = await readJson(join(packageRoot, "package.json"));
  const installedVersion = nonEmptyString(manifest?.version) ? manifest.version : "";
  const assertions = {
    npmInstallOk: await isDirectory(packageRoot),
    packageIdentityExact: manifest?.name === "@memorax/memorax-code-preview" && Boolean(installedVersion),
    productionDependencyReady: await exists(join(packageRoot, "node_modules", "smol-toml", "package.json"))
      && !await exists(join(packageRoot, "node_modules", "typescript", "package.json")),
    allBinShimsRunnable: options["bin-shims-verified"] === "true",
    cmdLifecycleVerified: options["cmd-lifecycle-verified"] === "true",
    interruptedInstallRecovered: options["interrupted-install-recovered"] === "true",
    backendLifecycleThreeCycles: false,
    pidChangedOnRestart: false,
    stopRemovedProcess: false,
    portReleased: false,
    updateReady: false,
    sentinelCreated: false,
    installedVersion,
  };
  requireTrue(assertions, [
    "npmInstallOk",
    "packageIdentityExact",
    "productionDependencyReady",
    "allBinShimsRunnable",
    "cmdLifecycleVerified",
    "interruptedInstallRecovered",
  ]);

  await createStateSentinels(workspace);
  assertions.sentinelCreated = true;
  await runJson(memoraxCode, ["stop", "--json", "--clients", "none", "--port", String(port)], childEnv);

  const pidPairs = [];
  for (let cycle = 0; cycle < 3; cycle += 1) {
    const started = await runJson(
      memoraxCode,
      ["start", "--json", "--clients", "none", "--port", String(port)],
      childEnv,
    );
    const startedPid = started.backend?.state?.pid;
    if (!isSafePid(startedPid)) throw new Error("start did not report a safe Backend PID");

    const status = await runJson(
      memoraxCode,
      ["status", "--json", "--clients", "none", "--port", String(port)],
      childEnv,
    );
    if (status.backend?.ok !== true || status.backend?.service !== "memorax-code-backend") {
      throw new Error("Backend status was not healthy");
    }

    const restarted = await runJson(
      memoraxCode,
      ["restart", "--json", "--clients", "none", "--port", String(port)],
      childEnv,
    );
    const restartedPid = restarted.backend?.state?.pid;
    if (!isSafePid(restartedPid) || restartedPid === startedPid) {
      throw new Error("restart did not replace the Backend PID");
    }
    if (!await waitForExit(startedPid)) throw new Error("pre-restart Backend PID remained alive");
    pidPairs.push([startedPid, restartedPid]);

    await runJson(
      memoraxCode,
      ["stop", "--json", "--clients", "none", "--port", String(port)],
      childEnv,
    );
    if (!await waitForExit(restartedPid)) throw new Error("stopped Backend PID remained alive");
    if (!await portCanBind(port)) throw new Error("Backend port remained occupied");
  }

  assertions.backendLifecycleThreeCycles = true;
  assertions.pidChangedOnRestart = pidPairs.length === 3;
  assertions.stopRemovedProcess = true;
  assertions.portReleased = true;

  const updateStart = await runJson(
    memoraxCode,
    ["start", "--json", "--clients", "none", "--port", String(port)],
    childEnv,
  );
  if (!isSafePid(updateStart.backend?.state?.pid)) {
    throw new Error("update preparation did not start the Backend");
  }
  assertions.updateReady = true;
  requireAllBooleans(assertions);
  console.log(JSON.stringify(assertions, null, 2));
}

async function runUpdated({
  childEnv,
  memoraxCode,
  options,
  packageRoot,
  port,
  prefix,
  workspace,
}) {
  const oldPid = Number(required(options, "old-pid"));
  if (!isSafePid(oldPid)) throw new Error("--old-pid must be a safe positive integer");
  const expectedVersion = required(options, "expected-version");
  const baselineVersion = required(options, "baseline-version");
  const installedVersion = (await readJson(join(packageRoot, "package.json")))?.version;
  const state = await readJson(backendStatePath());
  const health = await backendHealth(state);
  const assertions = {
    updateInstalledNewVersion: installedVersion === expectedVersion,
    oldPidRemoved: await waitForExit(oldPid),
    newPidHealthy: isSafePid(state?.pid)
      && state.pid !== oldPid
      && health.service === "memorax-code-backend"
      && health.instanceId === state.instanceId,
    versionAdvanced: expectedVersion !== baselineVersion,
    partialUninstallOk: false,
    partialUninstallKeptPackage: false,
    partialUninstallKeptState: false,
    backendRestartedAfterPartialUninstall: false,
    uninstallCommandOk: false,
    uninstallRemovedProcess: false,
    uninstallReleasedPort: false,
    uninstallRemovedPackage: false,
    managedChildProcessesRemoved: false,
    userStatePreserved: false,
    sentinelBytesPreserved: false,
    installedVersion: nonEmptyString(installedVersion) ? installedVersion : "",
    expectedVersion,
    baselineVersion,
  };
  requireTrue(assertions, [
    "updateInstalledNewVersion",
    "oldPidRemoved",
    "newPidHealthy",
    "versionAdvanced",
  ]);

  const partial = await runJson(
    memoraxCode,
    [
      "uninstall",
      "--json",
      "--clients",
      "none",
      "--no-npm-uninstall",
      "--port",
      String(port),
    ],
    childEnv,
  );
  assertions.partialUninstallOk = partial.ok === true
    && partial.npmPackageRemoval?.reason === "disabled_by_flag";
  assertions.partialUninstallKeptPackage = await isDirectory(packageRoot);
  assertions.partialUninstallKeptState = await sentinelsMatch(workspace);

  const restarted = await runJson(
    memoraxCode,
    ["start", "--json", "--clients", "none", "--port", String(port)],
    childEnv,
  );
  const finalPid = restarted.backend?.state?.pid;
  assertions.backendRestartedAfterPartialUninstall = isSafePid(finalPid);
  if (!isSafePid(finalPid)) throw new Error("partial uninstall recovery did not restart the Backend");

  const uninstall = await runJson(
    memoraxCode,
    ["uninstall", "--json", "--clients", "none", "--port", String(port)],
    childEnv,
  );
  assertions.uninstallCommandOk = uninstall.ok === true
    && uninstall.npmPackageRemoval?.ok === true
    && uninstall.npmPackageRemoval?.skipped !== true;
  assertions.uninstallRemovedProcess = await waitForExit(finalPid);
  assertions.uninstallReleasedPort = await portCanBind(port);
  assertions.uninstallRemovedPackage = !await exists(packageRoot);
  assertions.managedChildProcessesRemoved = await noProcessReferencesPrefix(prefix);
  assertions.userStatePreserved = await isDirectory(process.env.MEMORAX_CODE_HOME);
  assertions.sentinelBytesPreserved = await sentinelsMatch(workspace);
  requireAllBooleans(assertions);
  console.log(JSON.stringify(assertions, null, 2));
}

async function createStateSentinels(workspace) {
  const memoraxCodeHome = requiredEnv("MEMORAX_CODE_HOME");
  const configPath = join(memoraxCodeHome, "config.toml");
  const existingConfig = await readFile(configPath, "utf8").catch(
    () => "[clients]\ncodex = false\nclaude = false\n",
  );
  const config = `${existingConfig.trimEnd()}\n\n[windows_e2e_sentinel]\nvalue = "preserve-v1"\n`;
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, config);

  const files = [
    ["memory/e2e-sentinel.bin", "memory-preserve-v1\u0000\u0001"],
    ["user-state/e2e-sentinel.txt", "user-state-preserve-v1\n"],
  ];
  for (const [relativePath, contents] of files) {
    const path = join(memoraxCodeHome, relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents);
  }

  const paths = ["config.toml", ...files.map(([path]) => path)];
  const hashes = {};
  for (const path of paths) hashes[path] = hash(await readFile(join(memoraxCodeHome, path)));
  await writeFile(join(workspace, "sentinel-hashes.json"), `${JSON.stringify(hashes)}\n`);
}

async function sentinelsMatch(workspace) {
  const expected = await readJson(join(workspace, "sentinel-hashes.json"));
  if (!expected || typeof expected !== "object") return false;
  for (const [path, digest] of Object.entries(expected)) {
    const contents = await readFile(join(requiredEnv("MEMORAX_CODE_HOME"), path)).catch(() => undefined);
    if (!contents || hash(contents) !== digest) return false;
  }
  return true;
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function backendStatePath() {
  return join(requiredEnv("MEMORAX_CODE_HOME"), "runtime", "backend", "backend.pid.json");
}

async function backendHealth(state) {
  if (!state?.url) return {};
  try {
    const url = new URL("/health", state.url);
    if (!isLoopbackHostname(url.hostname)) return {};
    const response = await fetch(url, {
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return {};
    return await response.json();
  } catch {
    return {};
  }
}

async function noProcessReferencesPrefix(prefix) {
  if (process.platform !== "win32" || !process.env.SystemRoot) return false;
  const powershell = join(
    process.env.SystemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const result = await run(
    powershell,
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress",
    ],
    process.env,
    false,
  );
  if (result.code !== 0) return false;
  const parsed = JSON.parse(result.stdout || "[]");
  const records = Array.isArray(parsed) ? parsed : [parsed];
  const needle = resolve(prefix).toLowerCase();
  return !records.some((record) => record?.ProcessId !== process.pid
    && String(record?.CommandLine ?? "").toLowerCase().includes(needle));
}

async function runJson(entrypoint, args, childEnv) {
  const result = await run(entrypoint, args, childEnv);
  if (result.code !== 0) throw new Error("MemoraX Code lifecycle command failed");
  return JSON.parse(result.stdout);
}

function run(entrypoint, args, childEnv, nodeEntrypoint = true) {
  return new Promise((resolveResult) => {
    const child = spawn(
      nodeEntrypoint ? process.execPath : entrypoint,
      nodeEntrypoint ? [entrypoint, ...args] : args,
      {
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", () => {
      resolveResult({ code: 127, stdout, stderr: "process_spawn_failed" });
    });
    child.on("close", (code) => {
      resolveResult({ code: code ?? 1, stdout, stderr });
    });
  });
}

function portCanBind(port) {
  return new Promise((resolveResult) => {
    const server = createServer();
    server.once("error", () => resolveResult(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolveResult(true));
    });
  });
}

async function processAlive(pid) {
  if (!isSafePid(pid)) return false;
  try {
    process.kill(pid, 0);
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid, timeoutMs = 10_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!await processAlive(pid)) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  return !await processAlive(pid);
}

function requireTrue(values, keys) {
  for (const key of keys) {
    if (values[key] !== true) throw new Error(`required E2E assertion failed: ${key}`);
  }
}

function requireAllBooleans(values) {
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === "boolean" && value !== true) {
      throw new Error(`E2E assertion failed: ${key}`);
    }
  }
}

function isSafePid(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function parsePort(value) {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("--port must be an integer between 1 and 65535");
  }
  return port;
}

async function readJson(path) {
  try {
    return JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/, ""));
  } catch {
    return undefined;
  }
}

async function exists(path) {
  return Boolean(await stat(path).catch(() => undefined));
}

async function isDirectory(path) {
  return Boolean((await stat(path).catch(() => undefined))?.isDirectory());
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    result[argv[index].replace(/^--/, "")] = argv[index + 1];
  }
  return result;
}

function required(values, name) {
  if (!values[name]) throw new Error(`--${name} is required`);
  return values[name];
}

function requiredEnv(name) {
  if (!process.env[name]) throw new Error(`${name} is required`);
  return process.env[name];
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isLoopbackHostname(value) {
  return value === "127.0.0.1" || value === "localhost" || value === "[::1]";
}

function safeFailureMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/authorization|bearer|api[\s_-]?key|token|password|secret|credential|cookie|[A-Za-z]:[\\/]|\/(?:Users|home)\//i.test(message)) {
    return "details_redacted";
  }
  return message.slice(0, 300);
}
