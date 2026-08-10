import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BackendConnectionAuthorityError,
  DEFAULT_BACKEND_URL,
  resolveBackendConnection,
  writeBackendConnectionAuthority,
} from "../../../../memorax-code-adapter-common/src/backend-connection.mjs";
import {
  ensurePrivateDirectory,
} from "../../../../memorax-code-adapter-common/src/runtime-record.mjs";
import { backendEnv, parseBooleanEnv } from "../../config/backend-env.js";
import {
  isProcessAlive,
  managedServiceCommandLine,
  probeProcessCommandLine,
  terminateProcessTree,
  type ProcessCommandLineProbeResult,
} from "./process.js";
import { clearBackendServiceState } from "./cleanup.js";
import {
  readBackendServiceRecordAtPath,
  readBackendServiceStateAtPath,
  writeBackendServiceStateAtPath,
  type BackendServiceRecordState,
  type BackendServiceState,
} from "./record.js";
import { assertBackendTokenPersistenceEligible } from "./token-record.js";
import {
  clearBackendShutdownRequest,
  writeBackendShutdownRequest,
} from "./shutdown-request.js";
import {
  runtimeRecordDurabilityWarning,
  runtimeRecordErrorFields,
  runtimeRecordServiceFailure,
  withRuntimeRecordWarnings,
} from "./result.js";
import {
  persistBackendToken,
  readBackendToken,
  writeBackendToken,
} from "./token.js";
import { backendServiceHome } from "../lock.js";
import { isLoopbackHost } from "../../app/state.js";
import type {
  BackendRuntimeRecordWarning,
  BackendServiceEndpoint,
  BackendServiceOptions,
  BackendServiceResult,
  BackendServiceRuntime,
} from "../contracts.js";
import { withLoopbackProxyBypass } from "../../config/proxy-env.js";

export {
  BACKEND_SERVICE_RECORD_VERSION,
  BackendServiceStateError,
} from "./record.js";
export type {
  BackendRuntimeRecordWarning,
  BackendServiceEndpoint,
  BackendServiceOptions,
  BackendServiceResult,
  BackendServiceRuntime,
} from "../contracts.js";
export type {
  BackendServiceRecord,
  BackendServiceRecordState,
  BackendServiceState,
} from "./record.js";
export type { BackendTokenRecord } from "./token-record.js";
export { isProcessAlive, terminateProcessTree } from "./process.js";
export { readBackendToken, writeBackendToken };

function serviceDir(options: BackendServiceOptions): string {
  return join(backendServiceHome(options), "runtime", "backend");
}

function pidPath(options: BackendServiceOptions): string { return join(serviceDir(options), "backend.pid.json"); }

function logPath(options: BackendServiceOptions): string {
  const configured = backendEnv("LOG");
  if (configured) return configured;
  return join(serviceDir(options), "backend.log");
}

export function readBackendServiceRecordState(
  options: BackendServiceOptions = {},
): BackendServiceRecordState {
  return readBackendServiceRecordAtPath(pidPath(options));
}

export function readBackendServiceState(options: BackendServiceOptions = {}): BackendServiceState | undefined {
  return readBackendServiceStateAtPath(pidPath(options));
}

export function backendServiceEndpoint(options: BackendServiceOptions = {}): BackendServiceEndpoint {
  const memoraxCodeHome = backendServiceHome(options);
  let configured;
  try {
    configured = resolveBackendConnection({
      memoraxCodeHome,
      env: { ...process.env, MEMORAX_CODE_BACKEND_URL: undefined },
    });
  } catch (error) {
    const hasExplicitBind = options.host !== undefined || options.port !== undefined;
    if (!(error instanceof BackendConnectionAuthorityError) || !hasExplicitBind) throw error;
    configured = resolveBackendConnection({
      memoraxCodeHome,
      backendUrl: DEFAULT_BACKEND_URL,
      env: {},
    });
  }
  const host = options.host ?? configured.host;
  const port = options.port ?? configured.port;
  const formattedHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  const url = `http://${formattedHost}:${port}`;
  const connection = resolveBackendConnection({
    memoraxCodeHome,
    backendUrl: url,
    backendToken: options.authToken,
  });
  return {
    host,
    port,
    url,
    ...(connection.token ? { authToken: connection.token } : {}),
    ...(connection.tokenSource !== "none" ? { authTokenSource: connection.tokenSource } : {}),
  };
}

export function preflightBackendServiceStart(options: BackendServiceOptions = {}): BackendServiceEndpoint {
  const endpoint = backendServiceEndpoint(options);
  const token = backendServiceTokenCandidate(options, endpoint);
  if (token) assertBackendTokenPersistenceEligible(backendServiceHome(options));
  return endpoint;
}

export async function startBackendService(
  options: BackendServiceOptions = {},
  runtime: BackendServiceRuntime = {},
): Promise<BackendServiceResult> {
  let endpoint: BackendServiceEndpoint;
  try {
    endpoint = backendServiceEndpoint(options);
  } catch (error) {
    return {
      ok: false,
      action: "start",
      error: error instanceof Error ? error.message : String(error),
      ...runtimeRecordErrorFields(error),
    };
  }
  const processAlive = runtime.isProcessAlive ?? isProcessAlive;
  let existing: BackendServiceState | undefined;
  try {
    existing = readBackendServiceState(options);
  } catch (error) {
    return runtimeRecordServiceFailure("start", error);
  }
  let token: string | undefined;
  try {
    token = resolveBackendServiceToken(options, endpoint);
  } catch (error) {
    return runtimeRecordServiceFailure("start", error);
  }
  const { host, port, url } = endpoint;
  if (existing && processAlive(existing.pid)) {
    const ownership = await readBackendOwnership(
      existing,
      options.timeoutMs ?? 5000,
      backendServiceHome(options),
      runtime,
    );
    if (canReportRunning(ownership)) {
      return { ok: true, action: "start", alreadyRunning: true, state: existing };
    }
    if (processAlive(existing.pid)) {
      return {
        ok: false,
        action: "start",
        state: existing,
        error: `refusing to replace unverified process ${existing.pid}; ${describeOwnershipFailure(ownership)}; remove stale Backend state after confirming process ownership`,
      };
    }
  }
  if (existing) {
    const cleanup = clearBackendServiceState(pidPath(options), existing, "start");
    if (cleanup) return cleanup;
  }
  clearBackendShutdownRequest(backendServiceHome(options));

  ensurePrivateDirectory(serviceDir(options), { durableBoundary: backendServiceHome(options) });
  const logs = logPath(options);
  const outFd = openSync(logs, "a");
  const errFd = openSync(logs, "a");
  const serverPath = fileURLToPath(new URL("../../service-entrypoint.js", import.meta.url));
  const instanceId = randomBytes(24).toString("base64url");
  let child: ChildProcess;
  try {
    child = (runtime.spawnProcess ?? spawn)(
      process.execPath,
      [serverPath, "--memorax-code-backend-instance", instanceId],
      {
        detached: true,
        env: withLoopbackProxyBypass({
          ...process.env,
          MEMORAX_CODE_HOME: backendServiceHome(options),
          MEMORAX_CODE_BACKEND_HOST: host,
          MEMORAX_CODE_BACKEND_PORT: String(port),
          MEMORAX_CODE_BACKEND_INSTANCE_ID: instanceId,
          ...(options.claudeProjectsRoot === false
            ? { MEMORAX_CODE_MEMORY_VIEWER_CLAUDE_PROJECTS_ROOT: "disabled" }
            : typeof options.claudeProjectsRoot === "string" && options.claudeProjectsRoot.trim()
              ? { MEMORAX_CODE_MEMORY_VIEWER_CLAUDE_PROJECTS_ROOT: resolve(options.claudeProjectsRoot.trim()) }
              : {}),
          ...(token ? { MEMORAX_CODE_BACKEND_TOKEN: token } : {}),
        }, url),
        stdio: ["ignore", outFd, errFd],
      },
    );
  } catch (error) {
    closeSync(outFd);
    closeSync(errFd);
    return {
      ok: false,
      action: "start",
      logPath: logs,
      error: `failed to spawn Backend process: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  closeSync(outFd);
  closeSync(errFd);
  const spawnError = await waitForSpawn(child);
  const childPid = child.pid;
  if (spawnError || !Number.isSafeInteger(childPid) || (childPid ?? 0) <= 0) {
    return {
      ok: false,
      action: "start",
      logPath: logs,
      error: spawnError
        ? `failed to spawn Backend process: ${spawnError.message}`
        : "failed to spawn Backend process: child PID is unavailable",
    };
  }
  child.unref();

  const state: BackendServiceState & { instanceId: string } = {
    pid: childPid as number,
    instanceId,
    host,
    port,
    url,
    logPath: logs,
    startedAt: new Date().toISOString(),
  };
  const durabilityWarnings: BackendRuntimeRecordWarning[] = [];
  try {
    const written = writeBackendServiceStateAtPath(
      pidPath(options),
      state,
      backendServiceHome(options),
      runtime.recordWriteRuntime,
    );
    const warning = runtimeRecordDurabilityWarning("pid", written);
    if (warning) durabilityWarnings.push(warning);
  } catch (error) {
    const terminated = (runtime.terminateProcessTree ?? terminateProcessTree)(state.pid);
    if (terminated) {
      await waitUntilStopped(state.pid, options.timeoutMs ?? 5000, processAlive);
    }
    return {
      ok: false,
      action: "start",
      state,
      error: `failed to persist Backend service state: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const healthy = await waitForHealth(
    url,
    options.timeoutMs ?? 5000,
    instanceId,
    backendServiceHome(options),
    runtime,
  );
  if (!healthy) {
    const terminated = (runtime.terminateProcessTree ?? terminateProcessTree)(state.pid);
    if (terminated) {
      await waitUntilStopped(state.pid, options.timeoutMs ?? 5000, processAlive);
    }
    if (terminated && !processAlive(state.pid)) {
      const cleanup = clearBackendServiceState(
        pidPath(options), state, "start",
        `backend did not become healthy at ${url}; process stopped`,
      );
      if (cleanup) return cleanup;
      return {
        ok: false,
        action: "start",
        state,
        error: `backend did not become healthy at ${url}`,
      };
    }
    return {
      ok: false,
      action: "start",
      state,
      error: `backend did not become healthy at ${url}; cleanup failed and PID state was retained`,
    };
  }
  try {
    const activeTokenRecord = token
      ? persistBackendToken(options, token, runtime.recordWriteRuntime)
      : undefined;
    const tokenWarning = runtimeRecordDurabilityWarning(
      "token",
      activeTokenRecord?.persistence,
    );
    if (tokenWarning) durabilityWarnings.push(tokenWarning);
    const connectionWrite = writeBackendConnectionAuthority({
      memoraxCodeHome: backendServiceHome(options),
      url,
      ...(activeTokenRecord ? { tokenPath: activeTokenRecord.tokenPath } : {}),
    }, runtime.recordWriteRuntime);
    const connectionWarning = runtimeRecordDurabilityWarning(
      "connection",
      connectionWrite,
    );
    if (connectionWarning) durabilityWarnings.push(connectionWarning);
  } catch (error) {
    const terminated = (runtime.terminateProcessTree ?? terminateProcessTree)(state.pid);
    if (terminated) {
      await waitUntilStopped(state.pid, options.timeoutMs ?? 5000, processAlive);
    }
    if (terminated && !processAlive(state.pid)) {
      const cleanup = clearBackendServiceState(
        pidPath(options), state, "start",
        `failed to persist Backend connection authority: ${error instanceof Error ? error.message : String(error)}; process stopped`,
      );
      if (cleanup) return cleanup;
    }
    return {
      ok: false,
      action: "start",
      state,
      error: `failed to persist Backend connection authority: ${error instanceof Error ? error.message : String(error)}`,
      ...runtimeRecordErrorFields(error),
    };
  }
  return withRuntimeRecordWarnings(
    { ok: true, action: "start", state },
    durabilityWarnings,
  );
}

function resolveBackendServiceToken(options: BackendServiceOptions, endpoint: BackendServiceEndpoint): string | undefined {
  const loopback = isLoopbackHost(endpoint.host);
  const serverMode = backendEnv("MODE") === "server";
  const allowExternalAccess = parseBooleanEnv(backendEnv("ALLOW_EXTERNAL")) ?? serverMode;
  if (!loopback && !allowExternalAccess) {
    throw new Error(`external Backend host "${endpoint.host}" is disabled; set MEMORAX_CODE_BACKEND_ALLOW_EXTERNAL=1 and configure MEMORAX_CODE_BACKEND_TOKEN to opt in`);
  }
  const token = backendServiceTokenCandidate(options, endpoint);
  if ((!loopback || serverMode) && !token) {
    throw new Error("MEMORAX_CODE_BACKEND_TOKEN is required for server mode or external Backend access");
  }
  if (token) assertBackendTokenPersistenceEligible(backendServiceHome(options));
  return token;
}

function backendServiceTokenCandidate(options: BackendServiceOptions, endpoint: BackendServiceEndpoint): string | undefined {
  const loopback = isLoopbackHost(endpoint.host);
  const loopbackAuth = parseBooleanEnv(backendEnv("LOOPBACK_AUTH"));
  const serverMode = backendEnv("MODE") === "server";
  const needsStoredToken = endpoint.authToken === undefined
    && (!loopback || loopbackAuth === true || serverMode);
  const tokenFromFile = needsStoredToken ? readBackendToken(options)?.token : undefined;
  const configuredToken = loopback
    && loopbackAuth === false
    && endpoint.authTokenSource === "authority-file"
    ? undefined
    : endpoint.authToken;
  const token = configuredToken
    ?? (loopback && loopbackAuth !== true ? undefined : tokenFromFile);
  return token;
}

export async function stopBackendService(
  options: BackendServiceOptions = {},
  runtime: BackendServiceRuntime = {},
): Promise<BackendServiceResult> {
  const processAlive = runtime.isProcessAlive ?? isProcessAlive;
  let state: BackendServiceState | undefined;
  try {
    state = readBackendServiceState(options);
  } catch (error) {
    return runtimeRecordServiceFailure("stop", error);
  }
  if (!state) return { ok: true, action: "stop", alreadyRunning: false };
  if (processAlive(state.pid)) {
    const timeoutMs = options.timeoutMs ?? 5000;
    const windowsInstanceId = (runtime.platform ?? process.platform) === "win32"
      ? state.instanceId
      : undefined;
    if (windowsInstanceId) {
      try {
        writeBackendShutdownRequest(backendServiceHome(options), {
          pid: state.pid,
          instanceId: windowsInstanceId,
        });
        await waitUntilStopped(state.pid, timeoutMs, processAlive);
      } catch {
        // A verified process may still be force-stopped below when the private
        // request file cannot be written.
      } finally {
        clearBackendShutdownRequest(backendServiceHome(options));
      }
    }
    if (processAlive(state.pid)) {
      const ownership = await readBackendOwnership(
        state,
        timeoutMs,
        backendServiceHome(options),
        runtime,
      );
      if (processAlive(state.pid)) {
        if (!canForceStop(ownership)) {
          const refusal = windowsInstanceId
            ? `refusing to force-stop process ${state.pid}`
            : `refusing to stop unverified process ${state.pid}`;
          return {
            ok: false,
            action: "stop",
            state,
            error: `${refusal}; ${describeOwnershipFailure(ownership)}`,
          };
        }
        if (!(runtime.terminateProcessTree ?? terminateProcessTree)(state.pid)) {
          return {
            ok: false,
            action: "stop",
            state,
            error: `failed to terminate verified Backend process ${state.pid}`,
          };
        }
        await waitUntilStopped(state.pid, timeoutMs, processAlive);
        if (processAlive(state.pid)) {
          return { ok: false, action: "stop", state, error: `backend process ${state.pid} did not stop` };
        }
      }
    }
  }
  clearBackendShutdownRequest(backendServiceHome(options));
  const cleanup = clearBackendServiceState(pidPath(options), state, "stop", "Backend process stopped");
  if (cleanup) return cleanup;
  return { ok: true, action: "stop", state };
}

export async function restartBackendService(
  options: BackendServiceOptions = {},
  runtime: BackendServiceRuntime = {},
): Promise<BackendServiceResult> {
  const stopped = await stopBackendService(options, runtime);
  if (!stopped.ok) return { ...stopped, action: "restart" };
  const started = await startBackendService(options, runtime);
  return { ...started, action: "restart" };
}

export function backendServiceLogs(options: BackendServiceOptions = {}, bytes = 12000): BackendServiceResult {
  const path = logPath(options);
  if (!existsSync(path)) return { ok: false, action: "logs", logPath: path, error: "log file does not exist" };
  const text = readFileSync(path, "utf8");
  return { ok: true, action: "logs", logPath: path, text: text.slice(Math.max(0, text.length - bytes)) };
}

async function waitForHealth(
  url: string,
  timeoutMs: number,
  instanceId: string,
  expectedSessionHome: string,
  runtime: BackendServiceRuntime,
): Promise<boolean> {
  const budgetMs = Number.isFinite(timeoutMs) ? Math.max(0, Math.trunc(timeoutMs)) : 0;
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const remainingMs = deadline - Date.now();
    try {
      const health = await readHealthWithTimeout(
        new URL("/health", url),
        remainingMs,
        runtime.fetch,
      );
      if (health.ok
        && health.body.ok === true
        && health.body.service === "memorax-code-backend"
        && health.body.instanceId === instanceId
        && typeof health.body.state?.sessionHome === "string"
        && resolve(health.body.state.sessionHome) === resolve(expectedSessionHome)) return true;
    } catch {
      // Retry until timeout; the child process may still be starting.
    }
    const retryBudgetMs = deadline - Date.now();
    if (retryBudgetMs > 0) await sleep(Math.min(100, retryBudgetMs));
  }
  return false;
}

type BackendHealthEvidence = "matched" | "conflicting" | "inconclusive";

type BackendProcessEvidence =
  | { status: "not_probed" }
  | { status: "matched" }
  | { status: "mismatched" }
  | { status: "not_found" }
  | {
      status: "inconclusive";
      probe: Extract<ProcessCommandLineProbeResult, { status: "inconclusive" }>;
    };

type BackendOwnershipEvidence =
  | { status: "invalid_state" }
  | {
      status: "evaluated";
      health: BackendHealthEvidence;
      process: BackendProcessEvidence;
    };

async function readBackendOwnership(
  state: BackendServiceState,
  timeoutMs: number,
  expectedSessionHome: string,
  runtime: BackendServiceRuntime,
): Promise<BackendOwnershipEvidence> {
  if (!isTrustedServiceState(state)) return { status: "invalid_state" };
  let health: BackendHealthEvidence = "inconclusive";
  if (isLoopbackHealthUrl(state.url)) {
    try {
      const result = await readHealthWithTimeout(
        new URL("/health", state.url),
        timeoutMs,
        runtime.fetch,
      );
      if (result.ok) {
        health = result.body.ok === true
          && result.body.service === "memorax-code-backend"
          && result.body.instanceId === state.instanceId
          && typeof result.body.state?.sessionHome === "string"
          && resolve(result.body.state.sessionHome) === resolve(expectedSessionHome)
          ? "matched"
          : "conflicting";
      }
    } catch {
      // Process evidence can still prove ownership for a hung Backend.
    }
  }
  if (health === "conflicting") {
    return {
      status: "evaluated",
      health,
      process: { status: "not_probed" },
    };
  }
  // Read the process marker after the bounded health probe so PID reuse while
  // awaiting health cannot authorize the following synchronous taskkill path.
  const probe = runtime.probeProcessCommandLine
    ? runtime.probeProcessCommandLine(state.pid)
    : runtime.platform
      ? probeProcessCommandLine(state.pid, { platform: runtime.platform })
      : probeProcessCommandLine(state.pid);
  let processEvidence: BackendProcessEvidence;
  if (probe.status === "ok") {
    processEvidence = managedServiceCommandLine(probe.commandLine, state.instanceId)
      ? { status: "matched" }
      : { status: "mismatched" };
  } else if (probe.status === "not_found") {
    processEvidence = { status: "not_found" };
  } else {
    processEvidence = { status: "inconclusive", probe };
  }
  return {
    status: "evaluated",
    health,
    process: processEvidence,
  };
}

function canReportRunning(ownership: BackendOwnershipEvidence): boolean {
  if (ownership.status !== "evaluated") return false;
  if (ownership.health === "conflicting"
    || ownership.process.status === "mismatched"
    || ownership.process.status === "not_found") return false;
  return ownership.health === "matched" || ownership.process.status === "matched";
}

function canForceStop(ownership: BackendOwnershipEvidence): boolean {
  return ownership.status === "evaluated"
    && ownership.health !== "conflicting"
    && ownership.process.status === "matched";
}

function describeOwnershipFailure(ownership: BackendOwnershipEvidence): string {
  if (ownership.status === "invalid_state") {
    return "Backend service state is not trusted";
  }
  if (ownership.health === "conflicting") {
    return "Backend health identity conflicts with the recorded instance";
  }
  if (ownership.process.status === "mismatched") {
    return "process command identity does not match the recorded Backend instance";
  }
  if (ownership.process.status === "not_found") {
    return "the recorded process was not found by the ownership probe";
  }
  if (ownership.process.status === "inconclusive") {
    return describeInconclusiveProcessProbe(ownership.process.probe);
  }
  return "Backend ownership could not be established";
}

function describeInconclusiveProcessProbe(
  probe: Extract<ProcessCommandLineProbeResult, { status: "inconclusive" }>,
): string {
  if (probe.reason === "timeout") {
    return `ownership probe timed out after ${probe.timeoutMs}ms`;
  }
  const details = [
    probe.reason,
    probe.code ? `code ${probe.code}` : undefined,
    typeof probe.exitCode === "number" ? `exit code ${probe.exitCode}` : undefined,
    probe.signal ? `signal ${probe.signal}` : undefined,
  ].filter((value): value is string => value !== undefined);
  return `ownership probe was inconclusive (${details.join(", ")})`;
}

function isTrustedServiceState(state: BackendServiceState): boolean {
  if (!Number.isSafeInteger(state.pid) || state.pid <= 0) return false;
  if (!Number.isSafeInteger(state.port) || state.port <= 0 || state.port > 65535) return false;
  try {
    const url = new URL(state.url);
    return url.protocol === "http:" && Number(url.port || "80") === state.port;
  } catch {
    return false;
  }
}

function isLoopbackHealthUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" && isLoopbackHost(parsed.hostname);
  } catch {
    return false;
  }
}

function waitForSpawn(child: ChildProcess): Promise<Error | undefined> {
  return new Promise((resolveSpawn) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      resolveSpawn(error);
    };
    child.once("error", finish);
    child.once("spawn", () => finish());
  });
}

async function readHealthWithTimeout(
  url: URL,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<{
  ok: boolean;
  body: {
    ok?: boolean;
    service?: string;
    instanceId?: string;
    state?: { sessionHome?: string };
  };
}> {
  const controller = new AbortController();
  const boundedTimeoutMs = Math.max(1, Math.min(timeoutMs, 1000));
  const timeout = setTimeout(() => controller.abort(), boundedTimeoutMs);
  try {
    const response = await fetchImpl(url, {
      headers: { connection: "close" },
      signal: controller.signal,
    });
    if (!response.ok) return { ok: false, body: {} };
    return {
      ok: true,
      body: await response.json() as {
        ok?: boolean;
        service?: string;
        instanceId?: string;
        state?: { sessionHome?: string };
      },
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function waitUntilStopped(
  pid: number,
  timeoutMs: number,
  processAlive: (pid: number) => boolean = isProcessAlive,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!processAlive(pid)) return;
    await sleep(100);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
