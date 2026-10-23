#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const options = parseArgs(process.argv.slice(2));
const job = required(options, "job");
if (!["package", "codex", "claude"].includes(job)) {
  throw new Error("--job must be package, codex, or claude");
}
const prefix = resolve(required(options, "prefix"));
const output = resolve(required(options, "output"));
const memoraxCodeHome = resolve(requiredEnv("MEMORAX_CODE_HOME"));
const packageRoot = join(prefix, "node_modules", "@memorax/memorax-code-preview");
const statePath = join(memoraxCodeHome, "runtime", "backend", "backend.pid.json");
const state = await readJson(statePath);
const assertionReport = options.assertions
  ? await readJson(resolve(options.assertions))
  : undefined;
const logPath = join(memoraxCodeHome, "runtime", "backend", "backend.log");
const report = {
  job,
  packageVersions: {
    package: await manifestVersion(join(packageRoot, "package.json")),
    codexAdapter: await manifestVersion(
      join(packageRoot, "lib", "memorax-code-codex-adapter", "package.json"),
    ),
    claudeAdapter: await manifestVersion(
      join(packageRoot, "lib", "memorax-code-claude-adapter", "package.json"),
    ),
  },
  backend: {
    statePresent: Boolean(state),
    pidValid: isSafePid(state?.pid),
    pidAlive: processAlive(state?.pid),
    instancePresent: typeof state?.instanceId === "string"
      && state.instanceId.length > 0,
    health: await healthSummary(state),
  },
  process: {
    installedPrefixReferences: await processReferenceCount(prefix),
  },
  assertions: assertionSummary(assertionReport),
  backendLogTail: await redactedLogTail(logPath),
};
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);

async function manifestVersion(path) {
  const value = (await readJson(path))?.version;
  return typeof value === "string" ? value : null;
}

async function healthSummary(state) {
  if (!state?.url) return "absent";
  try {
    const url = new URL("/health", state.url);
    if (!isLoopbackHostname(url.hostname)) return "mismatch";
    const response = await fetch(url, {
      signal: AbortSignal.timeout(500),
    });
    if (!response.ok) return "unreachable";
    const body = await response.json();
    return body?.service === "memorax-code-backend"
      && (!state.instanceId || body.instanceId === state.instanceId)
      ? "healthy"
      : "mismatch";
  } catch {
    return "unreachable";
  }
}

function assertionSummary(value) {
  const values = value && typeof value === "object"
    ? Object.values(value)
    : [];
  return {
    reportPresent: Boolean(value),
    trueCount: values.filter((item) => item === true).length,
    falseCount: values.filter((item) => item === false).length,
  };
}

async function redactedLogTail(path) {
  const text = await readFile(path, "utf8").catch(() => "");
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-40)
    .map(redactDiagnosticLine);
}

function redactDiagnosticLine(line) {
  if (/(?:^|[\s"'=(])(?:[A-Za-z]:[\\/]|\/(?:Users|home)\/)/i.test(line)) {
    return "<path>";
  }
  if (/authorization|bearer|api[\s_-]?key|token|password|secret|credential|cookie|client[\s_-]?secret|access[\s_-]?key|private[\s_-]?key/i.test(line)) {
    return "<redacted>";
  }
  return line
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s"'?]+)\?[^\s"']*/gi, "$1?<redacted>")
    .slice(0, 500);
}

async function processReferenceCount(prefixPath) {
  if (process.platform !== "win32" || !process.env.SystemRoot) return 0;
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
  );
  if (result.code !== 0) return 0;
  const parsed = JSON.parse(result.stdout || "[]");
  const records = Array.isArray(parsed) ? parsed : [parsed];
  const needle = prefixPath.toLowerCase();
  return records.filter((record) => record?.ProcessId !== process.pid
    && String(record?.CommandLine ?? "").toLowerCase().includes(needle)).length;
}

function run(command, args) {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.on("error", () => resolveRun({ code: 127, stdout: "" }));
    child.on("close", (code) => {
      resolveRun({ code: code ?? 1, stdout });
    });
  });
}

function processAlive(pid) {
  if (!isSafePid(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isSafePid(value) {
  return Number.isSafeInteger(value) && value > 0;
}

async function readJson(path) {
  try {
    return JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/, ""));
  } catch {
    return undefined;
  }
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

function isLoopbackHostname(value) {
  return value === "127.0.0.1" || value === "localhost" || value === "[::1]";
}
