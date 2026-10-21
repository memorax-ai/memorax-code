import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repoMemoryRepositoryPath } from "./repo-memory-repository.mjs";
import { writePrivateJsonRecord } from "../runtime-record.mjs";

export const DEFAULT_REPO_MEMORY_JOB_MARKER_TTL_MS = 6 * 60 * 60 * 1000;
const REPO_MEMORY_JOB_MARKER_VERSION = 1;
const DEFAULT_STARTUP_LOCK_TTL_MS = 30 * 1000;
const DEFAULT_STARTUP_LOCK_GRACE_MS = 5 * 1000;

export function realpathRepo(repo) {
  return realpathSync(repo);
}

export function repoKeyForPath(repoRealpath) {
  return createHash("sha256").update(repoRealpath).digest("hex").slice(0, 24);
}

export function repoMemoryJobsDir(memoraxCodeHome) {
  return join(memoraxCodeHome, "repo-memory-jobs");
}

export function markerPathForRepo(memoraxCodeHome, repoRealpath) {
  const repoKey = repoKeyForPath(repoMemoryRepositoryPath(repoRealpath));
  const inProgressDir = join(repoMemoryJobsDir(memoraxCodeHome), "in-progress");
  return { repoKey, inProgressDir, markerPath: join(inProgressDir, `${repoKey}.json`) };
}

function legacyMarkerPathForRepo(home, repo) {
  return join(repoMemoryJobsDir(home), "in-progress", `${repoKeyForPath(repo)}.json`);
}

export function startupLockPathForRepo(memoraxCodeHome, repoRealpath) {
  const { repoKey, inProgressDir } = markerPathForRepo(memoraxCodeHome, repoRealpath);
  const lockDir = join(inProgressDir, `${repoKey}.lockdir`);
  return { repoKey, inProgressDir, lockDir, lockPath: join(lockDir, "lock.json") };
}

export function readActiveRepoMemoryJobMarker(input) {
  const repoRealpath = input.repoRealpath;
  const info = markerPathForRepo(input.memoraxCodeHome, repoRealpath);
  const legacyPath = legacyMarkerPathForRepo(input.memoraxCodeHome, repoRealpath);
  const markerPath = existsSync(info.markerPath) ? info.markerPath : legacyPath;
  const repoKey = markerPath === info.markerPath ? info.repoKey : repoKeyForPath(repoRealpath);
  if (!existsSync(markerPath)) return { active: false, reason: "missing", markerPath, repoKey };

  let marker;
  try {
    marker = JSON.parse(readFileSync(markerPath, "utf8"));
  } catch {
    removePath(markerPath);
    return { active: false, reason: "invalid_json", markerPath, repoKey };
  }

  // Native lease guards retain v1 PID compatibility. Classify without deleting a
  // record that another process may replace; writers hold the startup lock.
  if (marker?.version === 2 || (marker?.version === 1 && marker.ownerKind === "lease")) {
    const startedAtMs = Date.parse(marker.startedAt || "");
    const expiresAtMs = Date.parse(marker.leaseExpiresAt || "");
    const nowMs = Number.isFinite(input.nowMs) ? input.nowMs : Date.now();
    const valid = marker.ownerKind === "lease"
      && markerRepositoryMatches(marker, repoKey)
      && ["build", "update"].includes(marker.mode)
      && [marker.jobId, marker.jobPath, marker.runner, marker.runId].every(isNonEmptyString)
      && Number.isFinite(startedAtMs) && Number.isFinite(expiresAtMs)
      && expiresAtMs > startedAtMs
      && expiresAtMs - startedAtMs <= DEFAULT_REPO_MEMORY_JOB_MARKER_TTL_MS
      && startedAtMs <= nowMs;
    const legacyEnvelope = marker.version !== 1 || (Number.isSafeInteger(marker.pid) && marker.pid > 0
      && isNonEmptyString(marker.outputLogPath) && isNonEmptyString(marker.finalMessagePath));
    if (!valid || !legacyEnvelope) return { active: true, reason: "invalid_lease", marker, markerPath, repoKey };
    if (marker.version === 1) {
      try { process.kill(marker.pid, 0); } catch (error) {
        if (error?.code !== "EPERM") return { active: false, reason: "pid_not_running", marker, markerPath, repoKey };
      }
    }
    return { active: nowMs < expiresAtMs, reason: nowMs < expiresAtMs ? "leased" : "ttl_expired", marker, markerPath, repoKey };
  }

  if (marker?.version !== REPO_MEMORY_JOB_MARKER_VERSION) {
    removePath(markerPath);
    return {
      active: false,
      reason: Number.isInteger(marker?.version) ? "unsupported_version" : "invalid_record",
      marker,
      markerPath,
      repoKey,
    };
  }
  if (!markerRepositoryMatches(marker, repoKey)) {
    removePath(markerPath);
    return { active: false, reason: "repo_mismatch", marker, markerPath, repoKey };
  }
  if (
    !["build", "update"].includes(marker.mode)
    || !isNonEmptyString(marker.jobId)
    || !isNonEmptyString(marker.jobPath)
    || !isNonEmptyString(marker.outputLogPath)
    || !isNonEmptyString(marker.finalMessagePath)
    || !isNonEmptyString(marker.runner)
    || !isNonEmptyString(marker.runId)
  ) {
    removePath(markerPath);
    return { active: false, reason: "invalid_record", marker, markerPath, repoKey };
  }
  if (!Number.isInteger(marker.pid) || marker.pid <= 0) {
    removePath(markerPath);
    return { active: false, reason: "invalid_pid", marker, markerPath, repoKey };
  }

  const ttlMs = Number.isInteger(input.ttlMs) && input.ttlMs > 0 ? input.ttlMs : DEFAULT_REPO_MEMORY_JOB_MARKER_TTL_MS;
  const startedAtMs = Date.parse(marker.startedAt || "");
  const nowMs = Number.isFinite(input.nowMs) ? input.nowMs : Date.now();
  if (!Number.isFinite(startedAtMs) || nowMs - startedAtMs > ttlMs) {
    removePath(markerPath);
    return { active: false, reason: "ttl_expired", marker, markerPath, repoKey };
  }

  try {
    process.kill(marker.pid, 0);
  } catch (error) {
    if (error?.code === "EPERM") return { active: true, marker, markerPath, repoKey };
    removePath(markerPath);
    return { active: false, reason: "pid_not_running", marker, markerPath, repoKey };
  }

  return { active: true, marker, markerPath, repoKey };
}

export function writeRepoMemoryJobMarker(input) {
  const { inProgressDir, markerPath } = markerPathForRepo(input.memoraxCodeHome, input.marker.repo);
  mkdirSync(inProgressDir, { recursive: true });
  writePrivateJsonRecord(markerPath, input.marker, { durableBoundary: input.memoraxCodeHome });
  const legacyPath = legacyMarkerPathForRepo(input.memoraxCodeHome, input.marker.repo);
  if (legacyPath !== markerPath) writePrivateJsonRecord(legacyPath, { ...input.marker, repoKey: repoKeyForPath(input.marker.repo) }, { durableBoundary: input.memoraxCodeHome });
  return markerPath;
}

export function removeRepoMemoryJobMarker(input) {
  const markerPath = typeof input === "string" ? input : markerPathForRepo(input.memoraxCodeHome, input.repoRealpath).markerPath;
  removePath(markerPath);
}

export function removeRepoMemoryJobMarkerIfOwned(input) {
  const markerPath = markerPathForRepo(input.memoraxCodeHome, input.repoRealpath).markerPath;
  let marker;
  try {
    marker = JSON.parse(readFileSync(markerPath, "utf8"));
  } catch {
    return false;
  }
  if (marker?.jobId !== input.jobId || marker?.runId !== input.runId) return false;
  removePath(markerPath);
  const legacyPath = legacyMarkerPathForRepo(input.memoraxCodeHome, input.repoRealpath);
  if (legacyPath !== markerPath) {
    try {
      const legacy = JSON.parse(readFileSync(legacyPath, "utf8"));
      if (legacy.jobId === input.jobId && legacy.runId === input.runId) removePath(legacyPath);
    } catch { /* A legacy runtime may already have removed its marker. */ }
  }
  return !existsSync(markerPath);
}

export function tryAcquireRepoMemoryStartupLock(input) {
  const repoRealpath = input.repoRealpath;
  const info = startupLockPathForRepo(input.memoraxCodeHome, repoRealpath);
  const repoKey = input.legacy ? repoKeyForPath(repoRealpath) : info.repoKey;
  const inProgressDir = info.inProgressDir;
  const lockDir = join(inProgressDir, `${repoKey}.lockdir`), lockPath = join(lockDir, "lock.json");
  mkdirSync(inProgressDir, { recursive: true });

  try {
    mkdirSync(lockDir);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const state = classifyStartupLock({ lockDir, lockPath, ttlMs: input.ttlMs, graceMs: input.graceMs, nowMs: input.nowMs });
    if (!state.stale) return { acquired: false, reason: state.reason, lockDir, lockPath, repoKey };
    if (!removeStaleStartupLock({ lockDir, lockPath, expectedToken: state.token })) {
      return { acquired: false, reason: "locked", lockDir, lockPath, repoKey };
    }
    try {
      mkdirSync(lockDir);
    } catch (retryError) {
      if (retryError?.code === "EEXIST") return { acquired: false, reason: "locked", lockDir, lockPath, repoKey };
      throw retryError;
    }
  }

  const lock = {
    version: 1,
    repo: repoRealpath,
    repoKey,
    pid: process.pid,
    token: randomUUID(),
    startedAt: new Date(Number.isFinite(input.nowMs) ? input.nowMs : Date.now()).toISOString(),
    lockDir,
    lockPath,
  };
  try {
    writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  } catch (error) {
    removePath(lockDir);
    throw error;
  }
  if (!input.legacy && repoKeyForPath(repoRealpath) !== repoKey) {
    const legacy = tryAcquireRepoMemoryStartupLock({ ...input, legacy: true });
    if (!legacy.acquired) {
      releaseRepoMemoryStartupLock(lock);
      return legacy;
    }
    lock.legacyLock = legacy.lock;
  }
  return { acquired: true, lock };
}

export function assertRepoMemoryStartupLockOwned(lock) {
  let current;
  try { current = JSON.parse(readFileSync(lock.lockPath, "utf8")); } catch { /* Missing ownership fails closed. */ }
  if (!lock?.token || current?.token !== lock.token || current?.pid !== process.pid) {
    throw new Error("repo memory startup lock ownership lost");
  }
  if (lock.legacyLock) assertRepoMemoryStartupLockOwned(lock.legacyLock);
}

export function releaseRepoMemoryStartupLock(lock) {
  if (!lock?.lockDir || !lock?.lockPath || !lock?.token) return;
  if (lock.legacyLock) releaseRepoMemoryStartupLock(lock.legacyLock);
  try {
    const current = JSON.parse(readFileSync(lock.lockPath, "utf8"));
    if (current?.token !== lock.token) return;
  } catch {
    return;
  }
  removePath(lock.lockDir);
}

export function waitForActiveRepoMemoryJobMarker(input) {
  const timeoutMs = Number.isInteger(input.timeoutMs) && input.timeoutMs >= 0 ? input.timeoutMs : 2000;
  const intervalMs = Number.isInteger(input.intervalMs) && input.intervalMs > 0 ? input.intervalMs : 50;
  const started = Date.now();
  let state = readActiveRepoMemoryJobMarker(input);
  while (!state.active && Date.now() - started < timeoutMs) {
    sleep(intervalMs);
    state = readActiveRepoMemoryJobMarker(input);
  }
  return state.active ? state : { active: false, reason: "timeout", markerPath: state.markerPath, repoKey: state.repoKey };
}

function classifyStartupLock(input) {
  const ttlMs = Number.isInteger(input.ttlMs) && input.ttlMs > 0 ? input.ttlMs : DEFAULT_STARTUP_LOCK_TTL_MS;
  const graceMs = Number.isInteger(input.graceMs) && input.graceMs > 0 ? input.graceMs : DEFAULT_STARTUP_LOCK_GRACE_MS;
  const nowMs = Number.isFinite(input.nowMs) ? input.nowMs : Date.now();

  let lock;
  try {
    lock = JSON.parse(readFileSync(input.lockPath, "utf8"));
  } catch {
    const ageMs = startupLockDirAgeMs(input.lockDir, nowMs);
    if (ageMs < ttlMs && ageMs < graceMs) return { stale: false, reason: "initializing" };
    return { stale: true, reason: "missing_lock_file" };
  }

  const startedAtMs = Date.parse(lock.startedAt || "");
  if (!Number.isFinite(startedAtMs)) {
    return { stale: true, reason: "ttl_expired", token: lock.token };
  }
  if (!Number.isInteger(lock.pid) || lock.pid <= 0) return { stale: true, reason: "invalid_pid", token: lock.token };

  // Snapshot preparation can outlast the initialization TTL. A live owner
  // retains its lock until release; age alone must not permit another launch.
  try {
    process.kill(lock.pid, 0);
    return { stale: false, reason: "locked", token: lock.token };
  } catch (error) {
    return error?.code === "EPERM"
      ? { stale: false, reason: "locked", token: lock.token }
      : { stale: true, reason: "pid_not_running", token: lock.token };
  }
}

function startupLockDirAgeMs(lockDir, nowMs) {
  try {
    return Math.max(0, nowMs - statSync(lockDir).mtimeMs);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function removeStaleStartupLock(input) {
  if (input.expectedToken) {
    try {
      const current = JSON.parse(readFileSync(input.lockPath, "utf8"));
      if (current?.token !== input.expectedToken) return false;
    } catch {
      return false;
    }
  }
  removePath(input.lockDir);
  return !existsSync(input.lockDir);
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function markerRepositoryMatches(marker, repoKey) {
  try {
    return marker?.repoKey === repoKey
      && (repoKeyForPath(repoMemoryRepositoryPath(marker.repo)) === repoKey || repoKeyForPath(marker.repo) === repoKey);
  } catch {
    return false;
  }
}

function removePath(path) {
  try {
    rmSync(path, { force: true, recursive: true });
  } catch {
    // Best-effort cleanup only.
  }
}
