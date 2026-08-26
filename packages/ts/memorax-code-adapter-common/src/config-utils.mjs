import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { ensurePrivateDirectory } from "./runtime-record.mjs";

const JSON_FILE_LOCK_TIMEOUT_MS = 1500;
const JSON_FILE_LOCK_STALE_MS = 30000;
const JSON_FILE_LOCK_RETRY_MS = 10;
const PROCESS_START_TOLERANCE_MS = 5000;
const LOCK_SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));
const HOOK_INPUT_SYMBOL = Symbol.for("memorax-code.client-hook.input.v1");

export function readAdapterState(path) {
  const state = readJsonFile(path);
  if (state?.unreadable) return { unreadable: true };
  return state?.value;
}

export function readJsonFile(path) {
  if (!path || !existsSync(path)) return undefined;
  try {
    return { value: JSON.parse(readFileSync(path, "utf8")) };
  } catch {
    return { unreadable: true };
  }
}

export function readJsonValue(path) {
  return readJsonFile(path)?.value;
}

export async function readStdinJson() {
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

export function injectClientHookInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("client Hook input must be an object");
  }
  globalThis[HOOK_INPUT_SYMBOL] = input;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function stringOption(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function atomicWriteJson(path, value) {
  atomicWriteText(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function atomicWriteText(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, value);
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

export function withJsonFileLock(path, operation, options = {}) {
  const timeoutMs = positiveInteger(options.timeoutMs, JSON_FILE_LOCK_TIMEOUT_MS);
  const staleMs = positiveInteger(options.staleMs, JSON_FILE_LOCK_STALE_MS);
  const retryMs = positiveInteger(options.retryMs, JSON_FILE_LOCK_RETRY_MS);
  const lockPath = `${path}.lock`;
  const ownerId = `${process.pid}:${randomUUID()}`;
  const deadline = Date.now() + timeoutMs;
  const observedProcessStarts = new Map();
  const directory = dirname(path);
  ensurePrivateDirectory(directory, { durableBoundary: directory });

  while (!tryAcquireJsonFileLock(lockPath, ownerId)) {
    if (removeStaleJsonFileLock(lockPath, staleMs, observedProcessStarts)) continue;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      const error = new Error(`timed out waiting for JSON state lock: ${lockPath}`);
      error.code = "JSON_FILE_LOCK_TIMEOUT";
      error.path = path;
      error.lockPath = lockPath;
      throw error;
    }
    sleepSync(Math.min(retryMs, remainingMs));
  }

  try {
    const result = operation();
    if (result && typeof result.then === "function") {
      throw new TypeError("withJsonFileLock operation must be synchronous");
    }
    return result;
  } finally {
    releaseJsonFileLock(lockPath, ownerId);
  }
}

export async function withJsonFileLockAsync(path, operation, options = {}) {
  const timeoutMs = positiveInteger(options.timeoutMs, JSON_FILE_LOCK_TIMEOUT_MS);
  const staleMs = positiveInteger(options.staleMs, JSON_FILE_LOCK_STALE_MS);
  const retryMs = positiveInteger(options.retryMs, JSON_FILE_LOCK_RETRY_MS);
  const signal = options.signal;
  const lockPath = `${path}.lock`;
  const ownerId = `${process.pid}:${randomUUID()}`;
  const deadline = Date.now() + timeoutMs;
  const observedProcessStarts = new Map();
  const directory = dirname(path);
  throwIfJsonFileLockAborted(signal, path, lockPath);
  ensurePrivateDirectory(directory, { durableBoundary: directory });

  while (!tryAcquireJsonFileLock(lockPath, ownerId)) {
    throwIfJsonFileLockAborted(signal, path, lockPath);
    if (removeStaleJsonFileLock(lockPath, staleMs, observedProcessStarts)) continue;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      const error = new Error(`timed out waiting for JSON state lock: ${lockPath}`);
      error.code = "JSON_FILE_LOCK_TIMEOUT";
      error.path = path;
      error.lockPath = lockPath;
      throw error;
    }
    await sleep(Math.min(retryMs, remainingMs), signal, path, lockPath);
  }

  try {
    throwIfJsonFileLockAborted(signal, path, lockPath);
    return await operation();
  } finally {
    releaseJsonFileLock(lockPath, ownerId);
  }
}

function tryAcquireJsonFileLock(lockPath, ownerId) {
  let descriptor;
  try {
    descriptor = openSync(lockPath, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify({
      version: 1,
      ownerId,
      pid: process.pid,
      processStartedAt: new Date(performance.timeOrigin).toISOString(),
      createdAt: new Date().toISOString(),
    })}\n`);
    closeSync(descriptor);
    return true;
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Best-effort cleanup after an incomplete lock acquisition.
      }
      rmSync(lockPath, { force: true });
    }
    if (error?.code === "EEXIST") return false;
    throw error;
  }
}

function removeStaleJsonFileLock(lockPath, staleMs, observedProcessStarts) {
  let snapshot;
  try {
    snapshot = readJsonFileLockSnapshot(lockPath);
  } catch {
    return false;
  }
  const staleByAge = Date.now() - snapshot.mtimeMs >= staleMs;
  if (snapshot.pid) {
    if (pidIsAlive(snapshot.pid)) {
      if (!staleByAge) return false;
      // PID liveness alone is insufficient because operating systems reuse PIDs.
      // A matching process birth keeps even a long-running owner authoritative.
      const liveProcessStartedAtMs = observedProcessStart(
        snapshot.pid,
        observedProcessStarts,
      );
      if (liveProcessStartedAtMs === undefined) return false;
      if (snapshot.processStartedAtMs !== undefined) {
        if (sameProcessStart(snapshot.processStartedAtMs, liveProcessStartedAtMs)) return false;
      } else {
        const lockCreatedAtMs = snapshot.createdAtMs ?? snapshot.mtimeMs;
        if (liveProcessStartedAtMs <= lockCreatedAtMs + PROCESS_START_TOLERANCE_MS) return false;
      }
    }
  } else if (!staleByAge) {
    return false;
  }

  removeAbandonedReapClaims(lockPath, observedProcessStarts);
  // The hard-link count is the reaper election: only a claimant that observes
  // exactly the lock path and its own claim may remove the stale lock.
  const claimId = randomUUID().replaceAll("-", "").slice(0, 24);
  const claimPath = `${lockPath}.reap-v1-${process.pid}-${Math.trunc(performance.timeOrigin)}-${claimId}`;
  try {
    linkSync(lockPath, claimPath);
  } catch {
    return false;
  }
  try {
    const current = statSync(lockPath);
    const claim = statSync(claimPath);
    if (current.dev !== claim.dev || current.ino !== claim.ino) return false;
    if (current.nlink !== 2 || claim.nlink !== 2) return false;
    if (readFileSync(claimPath, "utf8") !== snapshot.raw) return false;
    unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  } finally {
    rmSync(claimPath, { force: true });
  }
}

function removeAbandonedReapClaims(lockPath, observedProcessStarts) {
  const directory = dirname(lockPath);
  const prefix = `${basename(lockPath)}.reap-`;
  let entries;
  try {
    entries = readdirSync(directory);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;
    const suffix = entry.slice(prefix.length);
    const match = /^v1-(\d+)-(\d+)-[a-f0-9]{24}$/.exec(suffix);
    if (!match) continue;
    const pid = Number(match[1]);
    const expectedProcessStartedAtMs = Number(match[2]);
    if (reapClaimOwnerIsAlive(
      pid,
      expectedProcessStartedAtMs,
      observedProcessStarts,
    )) continue;
    rmSync(join(directory, entry), { force: true });
  }
}

function reapClaimOwnerIsAlive(pid, expectedProcessStartedAtMs, observedProcessStarts) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  if (!Number.isSafeInteger(expectedProcessStartedAtMs) || expectedProcessStartedAtMs <= 0) {
    return false;
  }
  if (!pidIsAlive(pid)) return false;
  const actualProcessStartedAtMs = observedProcessStart(pid, observedProcessStarts);
  if (actualProcessStartedAtMs === undefined) return true;
  return sameProcessStart(expectedProcessStartedAtMs, actualProcessStartedAtMs);
}

function releaseJsonFileLock(lockPath, ownerId) {
  try {
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    if (lock?.ownerId === ownerId) unlinkSync(lockPath);
  } catch {
    // A missing, changed, or unreadable lock is not ours to remove.
  }
}

function readJsonFileLockSnapshot(lockPath) {
  const raw = readFileSync(lockPath, "utf8");
  const stat = statSync(lockPath);
  let pid;
  let processStartedAtMs;
  let createdAtMs;
  try {
    const parsed = JSON.parse(raw);
    if (Number.isInteger(parsed?.pid) && parsed.pid > 0) pid = parsed.pid;
    processStartedAtMs = timestampMs(parsed?.processStartedAt);
    createdAtMs = timestampMs(parsed?.createdAt);
  } catch {
    // Invalid abandoned locks become reclaimable only after the stale threshold.
  }
  return {
    raw,
    pid,
    processStartedAtMs,
    createdAtMs,
    dev: stat.dev,
    ino: stat.ino,
    mtimeMs: stat.mtimeMs,
  };
}

function pidIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function observedProcessStart(pid, observedProcessStarts) {
  if (observedProcessStarts.has(pid)) {
    return observedProcessStarts.get(pid);
  }
  const startedAtMs = readProcessStartedAtMs(pid);
  observedProcessStarts.set(pid, startedAtMs);
  return startedAtMs;
}

function readProcessStartedAtMs(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  if (pid === process.pid) return performance.timeOrigin;
  if (process.platform === "win32") return readWindowsProcessStartedAtMs(pid);
  const ps = ["/bin/ps", "/usr/bin/ps"].find(existsSync);
  if (!ps) return undefined;
  const result = spawnSync(
    ps,
    ["-p", String(pid), "-o", "lstart="],
    {
      encoding: "utf8",
      env: { ...process.env, LANG: "C", LC_ALL: "C" },
      timeout: 1000,
      windowsHide: true,
    },
  );
  if (result.status !== 0) return undefined;
  return timestampMs(result.stdout.trim());
}

function readWindowsProcessStartedAtMs(pid) {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot) return undefined;
  const powershell = join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  if (!existsSync(powershell)) return undefined;
  const command = [
    `$item = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' -ErrorAction SilentlyContinue`,
    "if ($null -ne $item) { $item.CreationDate.ToUniversalTime().ToString('o') }",
  ].join("; ");
  const result = spawnSync(
    powershell,
    ["-NoProfile", "-NonInteractive", "-Command", command],
    { encoding: "utf8", timeout: 1000, windowsHide: true },
  );
  if (result.status !== 0) return undefined;
  return timestampMs(result.stdout.trim());
}

function sameProcessStart(expectedMs, actualMs) {
  return Math.abs(expectedMs - actualMs) <= PROCESS_START_TOLERANCE_MS;
}

function timestampMs(value) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function sleepSync(milliseconds) {
  Atomics.wait(LOCK_SLEEP_BUFFER, 0, 0, Math.max(1, Math.trunc(milliseconds)));
}

function sleep(milliseconds, signal, path, lockPath) {
  const delayMs = Math.max(1, Math.trunc(milliseconds));
  if (!signal) return new Promise((resolve) => setTimeout(resolve, delayMs));
  throwIfJsonFileLockAborted(signal, path, lockPath);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener?.("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(() => finish(), delayMs);
    const onAbort = () => finish(jsonFileLockAbortError(path, lockPath));
    signal.addEventListener?.("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function throwIfJsonFileLockAborted(signal, path, lockPath) {
  if (signal?.aborted) throw jsonFileLockAbortError(path, lockPath);
}

function jsonFileLockAbortError(path, lockPath) {
  const error = new Error(`aborted while waiting for JSON state lock: ${lockPath}`);
  error.code = "JSON_FILE_LOCK_ABORTED";
  error.path = path;
  error.lockPath = lockPath;
  return error;
}

function positiveInteger(value, fallback) {
  const normalized = Number.isFinite(value) ? Math.trunc(value) : 0;
  return normalized > 0 ? normalized : fallback;
}
