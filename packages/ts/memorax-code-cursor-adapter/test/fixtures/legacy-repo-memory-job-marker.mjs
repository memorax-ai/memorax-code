// Frozen v1 marker reader from memorax-ai/memorax-code commit
// 0e56e9a07f9d19d9b86c59499f87b4316382f4ab,
// packages/ts/memorax-code-adapter-common/src/repo-memory/repo-memory-job-marker.mjs.
// Keep the original read/delete behavior independent of the current implementation.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_REPO_MEMORY_JOB_MARKER_TTL_MS = 6 * 60 * 60 * 1000;
const REPO_MEMORY_JOB_MARKER_VERSION = 1;

export function repoKeyForPath(repoRealpath) {
  return createHash("sha256").update(repoRealpath).digest("hex").slice(0, 24);
}

export function repoMemoryJobsDir(memoraxCodeHome) {
  return join(memoraxCodeHome, "repo-memory-jobs");
}

export function markerPathForRepo(memoraxCodeHome, repoRealpath) {
  const repoKey = repoKeyForPath(repoRealpath);
  const inProgressDir = join(repoMemoryJobsDir(memoraxCodeHome), "in-progress");
  return { repoKey, inProgressDir, markerPath: join(inProgressDir, `${repoKey}.json`) };
}

export function readActiveRepoMemoryJobMarker(input) {
  const repoRealpath = input.repoRealpath;
  const { repoKey, markerPath } = markerPathForRepo(input.memoraxCodeHome, repoRealpath);
  if (!existsSync(markerPath)) return { active: false, reason: "missing", markerPath, repoKey };

  let marker;
  try {
    marker = JSON.parse(readFileSync(markerPath, "utf8"));
  } catch {
    removePath(markerPath);
    return { active: false, reason: "invalid_json", markerPath, repoKey };
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
  if (marker?.repo !== repoRealpath || marker?.repoKey !== repoKey) {
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

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function removePath(path) {
  try {
    rmSync(path, { force: true, recursive: true });
  } catch {
    // Best-effort cleanup only.
  }
}
