import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, delimiter, isAbsolute, join } from "node:path";
import {
  localBackendRecoveryArguments,
  resolveBackendConnection,
} from "../backend-connection.mjs";
import { withJsonFileLockAsync } from "../config-utils.mjs";
import { isRepoMemoryJobWorker } from "../repo-memory/repo-memory-job-context.mjs";
import { recordHookFailure } from "./hook-diagnostics.mjs";

export const DEFAULT_ENSURE_BACKEND_START_TIMEOUT_MS = 90000;
const MAX_CHILD_STDOUT_BYTES = 64 * 1024;
const HOOK_INPUT_SYMBOL = Symbol.for("memorax-code.client-hook.input.v1");

export async function runEnsureBackendHook(options) {
  const input = await readStdinJson();
  await ensureBackendAvailable(options, input);
}

export async function ensureBackendAvailable(options, input = {}) {
  if (isRepoMemoryJobWorker()) return;
  const homes = options.resolveHomes(input);
  const metadata = packageMetadata(options.pluginRoot);
  const command = memoraxCodeCommandInfo(
    options.memoraxCodeCommand,
    metadata,
    options.platform,
  );
  if (ensureDisabled(options.ensureBackendValue)) {
    return;
  }
  let connection;
  try {
    connection = options.backendConnection
      ?? resolveBackendConnection({ memoraxCodeHome: homes.memoraxCodeHome });
  } catch (error) {
    recordHookFailure({ memoraxCodeHome: homes.memoraxCodeHome, client: options.client, input, operation: "hook.ensure-backend", errorCode: "HOOK_BACKEND_CONNECTION_INVALID", error });
    options.debug?.(error instanceof Error ? error.message : String(error));
    return;
  }
  const healthTimeoutMs = parsePositiveInt(options.healthTimeoutValue, 1500);
  if (await backendHealthy(connection, healthTimeoutMs)) {
    await options.onHealthy?.({ homes, backendUrl: connection.url });
    return;
  }

  if (localBackendRecoveryArguments(connection) === undefined) return;
  if (!command.value || command.removed === true || !memoraxCodeCommandAvailable(command.value)) return;
  const startTimeoutMs = parsePositiveInt(options.startTimeoutValue, DEFAULT_ENSURE_BACKEND_START_TIMEOUT_MS);
  const deadline = Date.now() + startTimeoutMs;
  try {
    // Hooks from different clients and processes share one recovery attempt.
    // This lock is separate from the lifecycle lock acquired by the child CLI.
    await withJsonFileLockAsync(join(homes.memoraxCodeHome, "runtime", "backend", "hook-recovery.json"), async () => {
      connection = refreshedBackendConnection(options.backendConnection, homes.memoraxCodeHome);
      const remainingHealthMs = Math.min(healthTimeoutMs, deadline - Date.now());
      if (remainingHealthMs <= 0) return;
      if (await backendHealthy(connection, remainingHealthMs)) {
        await options.onHealthy?.({ homes, backendUrl: connection.url });
        return;
      }
      const recoveryArguments = localBackendRecoveryArguments(connection);
      const remainingStartMs = deadline - Date.now();
      if (recoveryArguments === undefined || remainingStartMs <= 0 || !memoraxCodeCommandAvailable(command.value)) return;
      const result = await runMemoraxCode(
        command.value,
        [...options.buildStartArgs(homes, recoveryArguments), "--preserve-clients", "--json"],
        remainingStartMs,
        options.nodePath,
        recoveryEnvironment(options.recoveryEnv, metadata),
      );
      if ((result.code !== 0 || result.signal) && !result.diagnosticRecorded) {
        const errorCode = result.timedOut ? "HOOK_BACKEND_START_TIMEOUT"
          : result.error ? "HOOK_BACKEND_START_SPAWN_FAILED"
            : result.signal ? "HOOK_BACKEND_START_INTERRUPTED" : "HOOK_BACKEND_START_FAILED";
        recordHookFailure({ memoraxCodeHome: homes.memoraxCodeHome, client: options.client, input, operation: "hook.ensure-backend", errorCode, error: result.error, commandExitCode: result.code, commandSignal: result.signal });
      }
      if (result.code !== 0) {
        options.debug?.(
          `MemoraX Code backend start failed with code ${result.code}${result.stderr ? `: ${result.stderr}` : ""}`,
        );
      }
    }, { timeoutMs: startTimeoutMs });
  } catch (error) {
    recordHookFailure({ memoraxCodeHome: homes.memoraxCodeHome, client: options.client, input, operation: "hook.ensure-backend", errorCode: "HOOK_BACKEND_RECOVERY_FAILED", error });
    options.debug?.(error instanceof Error ? error.message : String(error));
  }

}

function refreshedBackendConnection(supplied, memoraxCodeHome) {
  if (!supplied) return resolveBackendConnection({ memoraxCodeHome });
  return resolveBackendConnection({
    memoraxCodeHome,
    env: {},
    backendUrl: supplied.source === "authority" || supplied.source === "default" ? undefined : supplied.url,
    backendToken: supplied.tokenSource === "authority-file" ? undefined : supplied.token,
  });
}

export function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function ensureDisabled(value) {
  return ["0", "false", "no", "off", "disabled"].includes(String(value ?? "").trim().toLowerCase());
}

async function backendHealthy(connection, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(new URL("/health", connection.url), {
      signal: controller.signal,
      headers: {
        connection: "close",
        ...(connection.token ? { "x-memorax-code-backend-token": connection.token } : {}),
      },
    });
    if (!response.ok) return false;
    const body = await response.json().catch(() => undefined);
    return body?.ok === true && body.service === "memorax-code-backend";
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function memoraxCodeCommandInfo(explicitCommand, metadata, platform = process.platform) {
  const explicit = stringValue(explicitCommand);
  if (explicit) return { value: explicit, removed: pathLooksRemoved(explicit) };
  const command = stringValue(metadata?.memoraxCodeCommand);
  if (command) return { value: command, removed: pathLooksRemoved(command) };
  if (platform === "win32") return { value: undefined, removed: false };
  return { value: "memorax-code", removed: false };
}

function packageMetadata(pluginRoot) {
  const root = stringValue(pluginRoot);
  if (!root) return undefined;
  const path = join(root, ".memorax-code-package.json");
  if (!existsSync(path)) return undefined;
  try {
    const metadata = JSON.parse(readFileSync(path, "utf8"));
    return metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? metadata
      : undefined;
  } catch {
    return undefined;
  }
}

function recoveryEnvironment(recoveryEnv, metadata) {
  if (stringValue(recoveryEnv?.MEMORAX_CODE_NPM_EXEC_PATH)
    || stringValue(process.env.MEMORAX_CODE_NPM_EXEC_PATH)) {
    return recoveryEnv;
  }
  const npmExecPath = metadataNpmExecPath(metadata);
  return npmExecPath
    ? { ...(recoveryEnv ?? {}), MEMORAX_CODE_NPM_EXEC_PATH: npmExecPath }
    : recoveryEnv;
}

function metadataNpmExecPath(metadata) {
  const npmExecPath = stringValue(metadata?.npmExecPath);
  if (!npmExecPath || !isAbsolute(npmExecPath) || !/\.(?:cjs|js|mjs)$/i.test(npmExecPath)) {
    return undefined;
  }
  try {
    return statSync(npmExecPath).isFile() ? npmExecPath : undefined;
  } catch {
    return undefined;
  }
}

function pathLooksRemoved(command) {
  return (command.includes("/") || command.includes("\\")) && !existsSync(command);
}

function memoraxCodeCommandAvailable(command) {
  if (!command) return false;
  if (command.includes("/") || command.includes("\\")) return existsSync(command);
  const path = process.env.PATH ?? "";
  return path.split(delimiter).some((dir) => dir && existsSync(join(dir, command)));
}

function runMemoraxCode(command, args, timeoutMs, nodePath, recoveryEnv) {
  return new Promise((resolve) => {
    const childArgs = nodeEntrypoint(command) ? [command, ...args] : args;
    const childCommand = nodeEntrypoint(command) ? (stringValue(nodePath) ?? process.execPath) : command;
    let stderr = "";
    let stdout = "";
    let stdoutBytes = 0;
    let settled = false;
    const child = spawn(childCommand, childArgs, {
      env: recoveryEnv === undefined ? process.env : { ...process.env, ...recoveryEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, diagnosticRecorded: result.code !== 0 && !result.timedOut && !result.error && !result.signal && savedStartDiagnostic(stdout) });
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish({ code: 124, stderr: "timed out", timedOut: true });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      stdout = stdoutBytes <= MAX_CHILD_STDOUT_BYTES ? stdout + String(chunk) : "";
    });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => finish({ code: 127, stderr: error.message, error: { code: error.code } }));
    child.on("close", (code, signal) => finish({ code: code ?? 0, stderr, signal }));
  });
}

function savedStartDiagnostic(stdout) {
  try {
    const report = JSON.parse(stdout);
    if (report?.action !== "start" || report.ok !== false || typeof report.backend?.ok !== "boolean") return false;
    const reportKeys = {
      codex: "codexAdapter", claude: "claudeAdapter", dsh: "dshAdapter", opencode: "opencodeAdapter",
      codebuddy: "codebuddyAdapter", workbuddy: "workbuddyAdapter", trae: "traeAdapter",
    };
    if (Object.hasOwn(report, "clientFailures") && !Array.isArray(report.clientFailures)) return false;
    const clientFailures = report.clientFailures ?? [];
    if (clientFailures.length > 7) return false;
    const diagnostics = report.backend.ok === false ? [report.diagnostic] : [];
    const seenClients = new Set();
    for (const entry of clientFailures) {
      if (!Object.hasOwn(reportKeys, entry?.client) || seenClients.has(entry.client)
        || report[reportKeys[entry.client]]?.ok !== false) return false;
      seenClients.add(entry.client);
      diagnostics.push(entry.diagnostic);
    }
    for (const [client, key] of Object.entries(reportKeys)) {
      if (report[key]?.ok === false && !seenClients.has(client)) return false;
    }
    // Trust only the requested child command's structured saved-record metadata.
    // Never retain its report, raw output, or a supplied filesystem path.
    return diagnostics.length > 0 && diagnostics.every((diagnostic) => diagnostic?.recorded === true
      && /^mc-\d{13}-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(diagnostic.id));
  } catch { return false; }
}

function nodeEntrypoint(command) {
  const name = basename(command).toLowerCase();
  return name.endsWith(".mjs") || name.endsWith(".js");
}

function parsePositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function readStdinJson() {
  const injected = globalThis[HOOK_INPUT_SYMBOL];
  if (injected && typeof injected === "object" && !Array.isArray(injected)) return injected;
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}
