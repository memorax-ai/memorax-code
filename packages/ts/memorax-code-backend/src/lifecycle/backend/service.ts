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
  backendServiceFailureFields,
  backendServicePreflightFailureFields,
  backendServiceSystemCode,
  runtimeRecordDurabilityWarning,
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
  BackendServiceFailureReason,
  BackendServiceOptions,
  BackendServiceResult,
  BackendServiceRuntime,
} from "../contracts.js";
import { withLoopbackProxyBypass } from "../../config/proxy-env.js";
import { isRecord } from "../../shared/record.js";

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
      ...backendServicePreflightFailureFields(error),
    };
  }
  const processAlive = runtime.isProcessAlive ?? isProcessAlive;
  let existing: BackendServiceState | undefined;
  try {
    existing = readBackendServiceState(options);
  } catch (error) {
    return {
      ...runtimeRecordServiceFailure("start", error),
      ...backendServiceFailureFields(error, "BACKEND_SERVICE_STATE_READ_FAILED", "read_state"),
    };
  }
  let token: string | undefined;
  try {
    token = resolveBackendServiceToken(options, endpoint);
  } catch (error) {
    return {
      ...runtimeRecordServiceFailure("start", error),
      ...backendServiceFailureFields(error, "BACKEND_TOKEN_CONFIG_FAILED", "resolve_token"),
    };
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
        ...backendServiceFailureFields(ownershipProbeError(ownership), "BACKEND_OWNERSHIP_UNVERIFIED", "verify_ownership"),
        failureReason: ownershipFailureReason(ownership),
        error: `refusing to replace unverified process ${existing.pid}; ${describeOwnershipFailure(ownership)}; remove stale Backend state after confirming process ownership`,
      };
    }
  }
  if (existing) {
    const cleanup = clearBackendServiceState(pidPath(options), existing, "start");
    if (cleanup) return cleanup;
  }
  clearBackendShutdownRequest(backendServiceHome(options));

  const logs = logPath(options);
  let outFd: number | undefined;
  let errFd: number;
  try {
    ensurePrivateDirectory(serviceDir(options), { durableBoundary: backendServiceHome(options) });
    outFd = openSync(logs, "a");
    errFd = openSync(logs, "a");
  } catch (error) {
    if (outFd !== undefined) closeSync(outFd);
    return {
      ok: false,
      action: "start",
      logPath: logs,
      error: "failed to prepare Backend runtime directory or log file",
      ...backendServiceFailureFields(error, "BACKEND_SERVICE_PREPARE_FAILED", "prepare_runtime", "not-started"),
    };
  }
  const serverPath = fileURLToPath(new URL("../../service-entrypoint.js", import.meta.url));
  const instanceId = randomBytes(24).toString("base64url");
  let child: ChildProcess;
  try {
    child = (runtime.spawnProcess ?? spawn)(
      process.execPath,
      [serverPath, "--memorax-code-backend-instance", instanceId],
      {
        cwd: serviceDir(options),
        detached: true,
        env: withLoopbackProxyBypass({
          ...process.env,
          MEMORAX_CODE_HOME: backendServiceHome(options),
          MEMORAX_CODE_BACKEND_HOST: host,
          MEMORAX_CODE_BACKEND_PORT: String(port),
          MEMORAX_CODE_BACKEND_INSTANCE_ID: instanceId,
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
      ...backendServiceFailureFields(error, "BACKEND_SPAWN_FAILED", "spawn", "not-started"),
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
      ...backendServiceFailureFields(
        spawnError, spawnError ? "BACKEND_SPAWN_FAILED" : "BACKEND_SPAWN_PID_MISSING",
        "spawn", spawnError ? "not-started" : "unknown",
      ),
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
    const cleanup = await stopFailedBackendStart(state.pid, options.timeoutMs ?? 5000, runtime);
    return {
      ok: false,
      action: "start",
      state,
      error: `failed to persist Backend service state: ${error instanceof Error ? error.message : String(error)}`,
      ...backendServiceFailureFields(error, "BACKEND_SERVICE_STATE_WRITE_FAILED", "persist_pid"),
      ...cleanup,
    };
  }

  const healthy = await waitForHealth(
    url,
    options.timeoutMs ?? 5000,
    instanceId,
    backendServiceHome(options),
    runtime,
  );
  if (!healthy.ok) {
    const processCleanup = await stopFailedBackendStart(state.pid, options.timeoutMs ?? 5000, runtime);
    const failure: BackendServiceResult = {
      ok: false,
      action: "start",
      state,
      error: `backend did not become healthy at ${url}`,
      ...backendServiceFailureFields({ code: healthy.systemCode }, "BACKEND_HEALTH_NOT_READY", "health"),
      failureReason: healthy.failureReason,
      ...(healthy.httpStatus === undefined ? {} : { httpStatus: healthy.httpStatus }),
      ...processCleanup,
    };
    if (processCleanup.processState === "stopped") {
      const cleanup = clearBackendServiceState(
        pidPath(options), state, "start",
        `backend did not become healthy at ${url}; process stopped`,
      );
      return cleanup ? withStartupCleanupFailure(failure, cleanup) : failure;
    }
    return {
      ...failure,
      error: `backend did not become healthy at ${url}; cleanup failed and PID state was retained`,
    };
  }
  let persistenceStage: "persist_token" | "persist_connection" = "persist_token";
  try {
    const activeTokenRecord = token
      ? persistBackendToken(options, token, runtime.recordWriteRuntime)
      : undefined;
    const tokenWarning = runtimeRecordDurabilityWarning(
      "token",
      activeTokenRecord?.persistence,
    );
    if (tokenWarning) durabilityWarnings.push(tokenWarning);
    persistenceStage = "persist_connection";
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
    const processCleanup = await stopFailedBackendStart(state.pid, options.timeoutMs ?? 5000, runtime);
    const persistenceError = `failed to persist Backend ${persistenceStage === "persist_token" ? "token record" : "connection authority"}: ${error instanceof Error ? error.message : String(error)}`;
    const failure: BackendServiceResult = {
      ok: false,
      action: "start",
      state,
      error: persistenceError,
      ...backendServiceFailureFields(error, persistenceStage === "persist_token" ? "BACKEND_TOKEN_WRITE_FAILED" : "BACKEND_CONNECTION_WRITE_FAILED", persistenceStage),
      ...processCleanup,
    };
    if (processCleanup.processState === "stopped") {
      const cleanup = clearBackendServiceState(
        pidPath(options), state, "start",
        `${persistenceError}; process stopped`,
      );
      if (cleanup) return withStartupCleanupFailure(failure, cleanup);
    }
    return failure;
  }
  return withRuntimeRecordWarnings(
    { ok: true, action: "start", state },
    durabilityWarnings,
  );
}

async function stopFailedBackendStart(
  pid: number,
  timeoutMs: number,
  runtime: BackendServiceRuntime,
): Promise<Pick<BackendServiceResult, "processState" | "cleanupErrorCode" | "cleanupSystemCode">> {
  let terminated: boolean;
  try {
    terminated = (runtime.terminateProcessTree ?? terminateProcessTree)(pid);
  } catch (error) {
    const systemCode = backendServiceSystemCode(error);
    return {
      processState: "unknown",
      cleanupErrorCode: "BACKEND_TERMINATE_FAILED",
      ...(systemCode ? { cleanupSystemCode: systemCode } : {}),
    };
  }
  if (!terminated) return { processState: "unknown", cleanupErrorCode: "BACKEND_TERMINATE_FAILED" };
  const processAlive = runtime.isProcessAlive ?? isProcessAlive;
  await waitUntilStopped(pid, timeoutMs, processAlive);
  return processAlive(pid)
    ? { processState: "running", cleanupErrorCode: "BACKEND_STOP_TIMEOUT" }
    : { processState: "stopped" };
}

function withStartupCleanupFailure(
  failure: BackendServiceResult,
  cleanup: BackendServiceResult,
): BackendServiceResult {
  return {
    ...failure,
    error: cleanup.error,
    cleanupErrorCode: cleanup.errorCode,
    ...(cleanup.systemCode ? { cleanupSystemCode: cleanup.systemCode } : {}),
  };
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
    return {
      ...runtimeRecordServiceFailure("stop", error),
      ...backendServiceFailureFields(error, "BACKEND_SERVICE_STATE_READ_FAILED", "read_state"),
    };
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
            ...backendServiceFailureFields(ownershipProbeError(ownership), "BACKEND_OWNERSHIP_UNVERIFIED", "verify_ownership"),
            failureReason: ownershipFailureReason(ownership),
            error: `${refusal}; ${describeOwnershipFailure(ownership)}`,
          };
        }
        let terminated: boolean;
        try {
          terminated = (runtime.terminateProcessTree ?? terminateProcessTree)(state.pid);
        } catch (error) {
          return {
            ok: false,
            action: "stop",
            state,
            error: `failed to terminate verified Backend process ${state.pid}`,
            ...backendServiceFailureFields(error, "BACKEND_TERMINATE_FAILED", "terminate"),
          };
        }
        if (!terminated) {
          return {
            ok: false,
            action: "stop",
            state,
            error: `failed to terminate verified Backend process ${state.pid}`,
            ...backendServiceFailureFields(undefined, "BACKEND_TERMINATE_FAILED", "terminate"),
          };
        }
        await waitUntilStopped(state.pid, timeoutMs, processAlive);
        if (processAlive(state.pid)) {
          return {
            ok: false,
            action: "stop",
            state,
            error: `backend process ${state.pid} did not stop`,
            ...backendServiceFailureFields(undefined, "BACKEND_STOP_TIMEOUT", "wait_stopped", "running"),
          };
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

type BackendHealthFailure = {
  ok: false;
  failureReason: BackendServiceFailureReason;
  httpStatus?: number;
  systemCode?: string;
};

async function waitForHealth(
  url: string,
  timeoutMs: number,
  instanceId: string,
  expectedSessionHome: string,
  runtime: BackendServiceRuntime,
): Promise<{ ok: true } | BackendHealthFailure> {
  let failure: BackendHealthFailure = { ok: false, failureReason: "deadline" };
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
      const failureReason = health.ok
        ? healthResponseFailureReason(health.body, instanceId, expectedSessionHome)
        : "http_error";
      if (!failureReason) return { ok: true };
      failure = {
        ok: false,
        failureReason,
        ...(health.httpStatus === undefined ? {} : { httpStatus: health.httpStatus }),
      };
    } catch (error) {
      const known = error instanceof BackendHealthProbeError ? error : undefined;
      failure = {
        ok: false,
        failureReason: known?.failureReason ?? "unknown",
        ...(known?.httpStatus === undefined ? {} : { httpStatus: known.httpStatus }),
        ...(known?.systemCode ? { systemCode: known.systemCode } : {}),
      };
      // Retry until timeout; the child process may still be starting.
    }
    const retryBudgetMs = deadline - Date.now();
    if (retryBudgetMs > 0) await sleep(Math.min(100, retryBudgetMs));
  }
  return failure;
}

function healthResponseFailureReason(
  body: unknown,
  instanceId: string,
  expectedSessionHome: string,
): BackendServiceFailureReason | undefined {
  if (!isRecord(body) || typeof body.ok !== "boolean") return "invalid_response";
  if (!body.ok) return "not_ready";
  if (typeof body.service !== "string") return "invalid_response";
  if (body.service !== "memorax-code-backend") return "identity_mismatch";
  if (typeof body.instanceId !== "string") return "invalid_response";
  if (body.instanceId !== instanceId) return "identity_mismatch";
  if (!isRecord(body.state) || typeof body.state.sessionHome !== "string") return "invalid_response";
  return resolve(body.state.sessionHome) === resolve(expectedSessionHome) ? undefined : "identity_mismatch";
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

function ownershipProbeError(ownership: BackendOwnershipEvidence): unknown {
  return ownership.status === "evaluated" && ownership.process.status === "inconclusive"
    ? { code: ownership.process.probe.code }
    : undefined;
}

function ownershipFailureReason(ownership: BackendOwnershipEvidence): BackendServiceFailureReason {
  if (ownership.status === "invalid_state") return "invalid_state";
  if (ownership.health === "conflicting") return "health_conflict";
  if (ownership.process.status === "mismatched") return "process_mismatch";
  if (ownership.process.status === "not_found") return "process_not_found";
  if (ownership.process.status === "inconclusive") return "process_probe_inconclusive";
  return "unknown";
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

class BackendHealthProbeError extends Error {
  readonly failureReason: "invalid_response" | "transport" | "timeout";
  readonly systemCode?: string;

  constructor(error: unknown, timedOut: boolean, readonly httpStatus?: number) {
    super("Backend health probe failed");
    this.systemCode = backendServiceSystemCode(error);
    const timeout = timedOut
      || (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name))
      || (this.systemCode !== undefined && /TIME(?:DOUT|OUT)$/.test(this.systemCode));
    this.failureReason = timeout ? "timeout" : error instanceof SyntaxError ? "invalid_response" : "transport";
  }
}

async function readHealthWithTimeout(
  url: URL,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<{
  ok: boolean;
  httpStatus?: number;
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
  let httpStatus: number | undefined;
  try {
    const response = await fetchImpl(url, {
      headers: { connection: "close" },
      signal: controller.signal,
    });
    httpStatus = Number.isInteger(response.status) && response.status >= 100 && response.status <= 599
      ? response.status
      : undefined;
    if (!response.ok) return { ok: false, httpStatus, body: {} };
    return {
      ok: true,
      httpStatus,
      body: await response.json() as {
        ok?: boolean;
        service?: string;
        instanceId?: string;
        state?: { sessionHome?: string };
      },
    };
  } catch (error) {
    throw new BackendHealthProbeError(error, controller.signal.aborted, httpStatus);
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
