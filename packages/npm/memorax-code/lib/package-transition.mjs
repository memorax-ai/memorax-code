import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { withJsonFileLock, withJsonFileLockAsync } from "./memorax-code-adapter-common/src/config-utils.mjs";
import {
  readJsonRuntimeRecord,
  RuntimeRecordError,
  writePrivateJsonRecord,
} from "./memorax-code-adapter-common/src/runtime-record.mjs";

export const PACKAGE_TRANSITION_RECORD_VERSION = 1;
export const PACKAGE_TRANSITION_FRESHNESS_MS = 15 * 60 * 1_000;
export const PACKAGE_TRANSITION_COMMAND_TIMEOUT_MS = 45_000;

const RETIRING_KEYS = new Set([
  "version",
  "state",
  "transitionId",
  "startedAt",
  "sourceVersion",
]);
const RETIRED_KEYS = new Set([...RETIRING_KEYS, "retiredAt"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

export class PackageTransitionRecordError extends RuntimeRecordError {
  constructor(state, path) {
    super({
      name: "Package transition record",
      path,
      state,
      codePrefix: "PACKAGE_TRANSITION_RECORD",
      recovery: state.status === "unsupported"
        ? "upgrade MemoraX Code or restore a supported package transition record"
        : "inspect the package transition record before retrying installation",
    });
    this.name = "PackageTransitionRecordError";
  }
}

export function packageTransitionPath(memoraxCodeHome = defaultMemoraxCodeHome()) {
  return join(memoraxCodeHome, "runtime", "install", "package-transition.json");
}

export function readPackageTransitionRecord(memoraxCodeHome = defaultMemoraxCodeHome()) {
  const path = packageTransitionPath(memoraxCodeHome);
  const state = readJsonRuntimeRecord(path);
  if (state.status !== "present") return state;
  const value = state.value;
  if (value.version !== PACKAGE_TRANSITION_RECORD_VERSION) {
    if (Number.isSafeInteger(value.version) && value.version > 0) {
      return { status: "unsupported", version: value.version };
    }
    return { status: "invalid", reason: "invalid_version" };
  }
  if (value.state !== "retiring" && value.state !== "retired") {
    return { status: "invalid", reason: "invalid_state" };
  }
  const allowedKeys = value.state === "retiring" ? RETIRING_KEYS : RETIRED_KEYS;
  if (Object.keys(value).length !== allowedKeys.size
    || Object.keys(value).some((key) => !allowedKeys.has(key))) {
    return { status: "invalid", reason: "unknown_or_missing_fields" };
  }
  if (typeof value.transitionId !== "string" || !UUID_PATTERN.test(value.transitionId)) {
    return { status: "invalid", reason: "invalid_transition_id" };
  }
  const startedAt = isoTimestamp(value.startedAt);
  if (!startedAt) return { status: "invalid", reason: "invalid_started_at" };
  const sourceVersion = nonEmptyString(value.sourceVersion);
  if (!sourceVersion) return { status: "invalid", reason: "invalid_source_version" };
  const record = {
    version: PACKAGE_TRANSITION_RECORD_VERSION,
    state: value.state,
    transitionId: value.transitionId,
    startedAt,
    sourceVersion,
  };
  if (value.state === "retired") {
    const retiredAt = isoTimestamp(value.retiredAt);
    if (!retiredAt || Date.parse(retiredAt) < Date.parse(startedAt)) {
      return { status: "invalid", reason: "invalid_retired_at" };
    }
    record.retiredAt = retiredAt;
  }
  return { status: "valid", record };
}

export function runNpmPreinstallPackageTransition(options = {}) {
  const memoraxCodeHome = resolve(nonEmptyString(options.memoraxCodeHome) ?? defaultMemoraxCodeHome());
  const memoraxCodeBin = requiredString(options.memoraxCodeBin, "memoraxCodeBin");
  const packageVersion = requiredString(options.packageVersion, "packageVersion");
  const pidPath = backendPidPath(memoraxCodeHome);
  const dshStatePath = join(memoraxCodeHome, "adapters", "dsh", "state.json");
  if (!existsSync(pidPath) && !existsSync(dshStatePath)) return { disposition: "noop" };

  const transitionPath = packageTransitionPath(memoraxCodeHome);
  let transition;
  let shouldStop = false;
  withJsonFileLock(transitionPath, () => {
    const existing = readPackageTransitionRecord(memoraxCodeHome);
    if (existing.status !== "absent") throw packageTransitionStateError(existing, transitionPath);
    const pidState = readBackendPidState(pidPath);
    const hasDshState = existsSync(dshStatePath);
    if (pidState.status === "absent" && !hasDshState) return;
    shouldStop = true;
    if (pidState.status !== "alive" && !hasDshState) return;
    transition = {
      version: PACKAGE_TRANSITION_RECORD_VERSION,
      state: "retiring",
      transitionId: randomUUID(),
      startedAt: nowIso(options),
      sourceVersion: packageVersion,
    };
    const write = writePrivateJsonRecord(transitionPath, transition, {
      durableBoundary: memoraxCodeHome,
    });
    if (write.durability !== "confirmed") {
      throw transitionError("PACKAGE_TRANSITION_DURABILITY_UNCERTAIN", "durable persistence of the retiring package transition could not be confirmed");
    }
  });

  if (!shouldStop) return { disposition: "noop" };
  const stopped = runLifecycleCommand({
    ...options,
    memoraxCodeHome,
    memoraxCodeBin,
    args: ["stop", "--home", memoraxCodeHome, "--clients", "none", "--json"],
    env: { ...options.env, MEMORAX_CODE_PACKAGE_REPLACEMENT: "1" },
    label: "memorax-code stop",
  });
  if (existsSync(pidPath)) {
    throw transitionError(
      "PACKAGE_TRANSITION_PID_REMAINS",
      `managed Backend PID authority still exists at ${pidPath}`,
      stopped.result,
    );
  }
  if (!transition) return { disposition: "cleaned" };

  const retired = withJsonFileLock(transitionPath, () => {
    const current = requireValidTransition(memoraxCodeHome);
    if (current.record.state !== "retiring"
      || current.record.transitionId !== transition.transitionId) {
      throw transitionError("PACKAGE_TRANSITION_REPLACED", "package transition changed while the Backend was being retired");
    }
    const record = { ...current.record, state: "retired", retiredAt: nowIso(options) };
    const write = writePrivateJsonRecord(transitionPath, record, {
      durableBoundary: memoraxCodeHome,
    });
    if (write.durability !== "confirmed") {
      throw transitionError("PACKAGE_TRANSITION_DURABILITY_UNCERTAIN", "durable persistence of the retired package transition could not be confirmed");
    }
    return record;
  });
  return { disposition: "retired", transition: retired };
}

export async function runNpmPostinstallPackageTransition(options = {}) {
  const memoraxCodeHome = resolve(nonEmptyString(options.memoraxCodeHome) ?? defaultMemoraxCodeHome());
  const memoraxCodeBin = requiredString(options.memoraxCodeBin, "memoraxCodeBin");
  const transitionPath = packageTransitionPath(memoraxCodeHome);
  if (readJsonRuntimeRecord(transitionPath).status === "absent") {
    return { disposition: "noop" };
  }

  return await withJsonFileLockAsync(transitionPath, async () => {
    const reloaded = readPackageTransitionRecord(memoraxCodeHome);
    if (reloaded.status === "absent") return { disposition: "noop" };
    if (reloaded.status !== "valid") {
      throw new PackageTransitionRecordError(reloaded, transitionPath);
    }
    const current = reloaded;
    if (current.record.state !== "retired") {
      throw transitionError("PACKAGE_TRANSITION_NOT_RETIRED", "package transition is still retiring");
    }
    const ageMs = nowMs(options) - Date.parse(current.record.retiredAt);
    if (ageMs < 0 || ageMs > PACKAGE_TRANSITION_FRESHNESS_MS) {
      throw transitionError("PACKAGE_TRANSITION_STALE", "retired package transition is stale");
    }

    runLifecycleCommand({
      ...options,
      memoraxCodeHome,
      memoraxCodeBin,
      args: ["start", "--home", memoraxCodeHome, "--json"],
      env: { ...options.env, MEMORAX_CODE_PACKAGE_REPLACEMENT: "1" },
      label: "memorax-code start",
    });
    runLifecycleCommand({
      ...options,
      memoraxCodeHome,
      memoraxCodeBin,
      args: ["status", "--home", memoraxCodeHome, "--json"],
      label: "memorax-code status",
    });

    const finalState = requireValidTransition(memoraxCodeHome);
    if (finalState.record.state !== "retired"
      || finalState.record.transitionId !== current.record.transitionId) {
      throw transitionError("PACKAGE_TRANSITION_REPLACED", "package transition changed before it could be consumed");
    }
    unlinkSync(transitionPath);
    return { disposition: "restored", transitionId: current.record.transitionId };
  });
}

function requireValidTransition(memoraxCodeHome) {
  const path = packageTransitionPath(memoraxCodeHome);
  const state = readPackageTransitionRecord(memoraxCodeHome);
  if (state.status !== "valid") throw new PackageTransitionRecordError(state, path);
  return state;
}

function packageTransitionStateError(state, path) {
  if (state.status === "valid") {
    return transitionError("PACKAGE_TRANSITION_PENDING", `package transition is already ${state.record.state}: ${path}`);
  }
  return new PackageTransitionRecordError(state, path);
}

function readBackendPidState(path) {
  const state = readJsonRuntimeRecord(path);
  if (state.status === "absent") return state;
  if (state.status !== "present" || !Number.isSafeInteger(state.value.pid) || state.value.pid <= 0) {
    return { status: "unknown" };
  }
  try {
    process.kill(state.value.pid, 0);
    return { status: "alive", pid: state.value.pid };
  } catch (error) {
    if (error?.code === "ESRCH") return { status: "dead", pid: state.value.pid };
    if (error?.code === "EPERM") return { status: "alive", pid: state.value.pid };
    return { status: "unknown", pid: state.value.pid };
  }
}

function runLifecycleCommand(options) {
  const spawn = options.spawnSyncImpl ?? spawnSync;
  const result = spawn(process.execPath, [options.memoraxCodeBin, ...options.args], {
    cwd: join(options.memoraxCodeHome, "runtime", "install"),
    encoding: "utf8",
    env: { ...process.env, ...options.env, MEMORAX_CODE_HOME: options.memoraxCodeHome },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: positiveInteger(options.commandTimeoutMs, PACKAGE_TRANSITION_COMMAND_TIMEOUT_MS),
    killSignal: "SIGKILL",
    windowsHide: true,
  });
  if (result.error || result.signal || result.status !== 0) {
    const detail = result.error?.code === "ETIMEDOUT"
      ? `${options.label} timed out after ${positiveInteger(options.commandTimeoutMs, PACKAGE_TRANSITION_COMMAND_TIMEOUT_MS)} ms`
      : result.error?.message
      ?? (result.signal ? `${options.label} exited from signal ${result.signal}` : `${options.label} exited with status ${result.status ?? "unknown"}`);
    throw transitionError("PACKAGE_TRANSITION_COMMAND_FAILED", detail, result);
  }
  let report;
  try {
    report = JSON.parse(String(result.stdout ?? ""));
  } catch {
    throw transitionError("PACKAGE_TRANSITION_COMMAND_INVALID_JSON", `${options.label} did not return valid JSON`, result);
  }
  if (!report || typeof report !== "object" || Array.isArray(report) || report.ok !== true) {
    throw transitionError("PACKAGE_TRANSITION_COMMAND_NOT_OK", `${options.label} did not report ok=true`, result);
  }
  return { result, report };
}

function transitionError(code, message, command) {
  const error = new Error(message);
  error.name = "PackageTransitionError";
  error.code = code;
  if (command) error.command = command;
  return error;
}

function backendPidPath(memoraxCodeHome) {
  return join(memoraxCodeHome, "runtime", "backend", "backend.pid.json");
}

function defaultMemoraxCodeHome() {
  return join(homedir(), ".memorax-code");
}

function requiredString(value, name) {
  const result = nonEmptyString(value);
  if (!result) throw new TypeError(`package transition requires ${name}`);
  return result;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isoTimestamp(value) {
  const candidate = nonEmptyString(value);
  return candidate && ISO_TIMESTAMP_PATTERN.test(candidate) && Number.isFinite(Date.parse(candidate))
    ? candidate
    : undefined;
}

function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function nowMs(options) {
  return typeof options.now === "function" ? Number(options.now()) : Date.now();
}

function nowIso(options) {
  return new Date(nowMs(options)).toISOString();
}
