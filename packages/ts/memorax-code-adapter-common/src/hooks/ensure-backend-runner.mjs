import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, delimiter, join } from "node:path";
import {
  localBackendRecoveryArguments,
  resolveBackendConnection,
} from "../backend-connection.mjs";
import { readStdinJson } from "../config-utils.mjs";
import { isRepoMemoryJobWorker } from "../repo-memory/repo-memory-job-context.mjs";

export const DEFAULT_ENSURE_BACKEND_START_TIMEOUT_MS = 90000;

export async function runEnsureBackendHook(options) {
  if (isRepoMemoryJobWorker() || ensureDisabled(options.ensureBackendValue)) return;

  const input = await readStdinJson();
  await ensureBackendAvailable(options, input);
}

export async function ensureBackendAvailable(options, input = {}) {
  const homes = options.resolveHomes(input);
  let connection;
  try {
    connection = options.backendConnection
      ?? resolveBackendConnection({ memoraxCodeHome: homes.memoraxCodeHome });
  } catch (error) {
    options.debug?.(error instanceof Error ? error.message : String(error));
    return;
  }
  const healthTimeoutMs = parsePositiveInt(options.healthTimeoutValue, 1500);
  if (await backendHealthy(connection, healthTimeoutMs)) {
    await options.onHealthy?.({ homes, backendUrl: connection.url });
    return;
  }

  const recoveryArguments = localBackendRecoveryArguments(connection);
  if (recoveryArguments === undefined) return;
  const command = memoraxCodeCommandInfo(options.memoraxCodeCommand, options.pluginRoot);
  if (!command.value || command.removed === true || !memoraxCodeCommandAvailable(command.value)) return;
  const result = await runMemoraxCode(
    command.value,
    options.buildStartArgs(homes, recoveryArguments),
    parsePositiveInt(options.startTimeoutValue, DEFAULT_ENSURE_BACKEND_START_TIMEOUT_MS),
    options.nodePath,
  );
  if (result.code !== 0) {
    options.debug?.(
      `MemoraX Code backend start failed with code ${result.code}${result.stderr ? `: ${result.stderr}` : ""}`,
    );
  }
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

function memoraxCodeCommandInfo(explicitCommand, pluginRoot) {
  const explicit = stringValue(explicitCommand);
  if (explicit) return { value: explicit, removed: pathLooksRemoved(explicit) };
  const metadata = metadataCommand(pluginRoot);
  if (metadata) return { value: metadata, removed: pathLooksRemoved(metadata) };
  return { value: "memorax-code", removed: false };
}

function metadataCommand(pluginRoot) {
  const root = stringValue(pluginRoot);
  if (!root) return undefined;
  const path = join(root, ".memorax-code-package.json");
  if (!existsSync(path)) return undefined;
  try {
    const metadata = JSON.parse(readFileSync(path, "utf8"));
    return stringValue(metadata.memoraxCodeCommand);
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

function runMemoraxCode(command, args, timeoutMs, nodePath) {
  return new Promise((resolve) => {
    const childArgs = nodeEntrypoint(command) ? [command, ...args] : args;
    const childCommand = nodeEntrypoint(command) ? (stringValue(nodePath) ?? process.execPath) : command;
    let stderr = "";
    let settled = false;
    const child = spawn(childCommand, childArgs, {
      env: process.env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish({ code: 124, stderr: "timed out" });
    }, timeoutMs);
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => finish({ code: 127, stderr: error.message }));
    child.on("close", (code) => finish({ code: code ?? 0, stderr }));
  });
}

function nodeEntrypoint(command) {
  const name = basename(command).toLowerCase();
  return name.endsWith(".mjs") || name.endsWith(".js");
}

function parsePositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
