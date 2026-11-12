import { randomUUID } from "node:crypto";
import { lstatSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { readJsonRuntimeRecord, RuntimeRecordError, writePrivateJsonRecord } from "./runtime-record.mjs";

export const PACKAGE_TRANSITION_ID_ENV = "MEMORAX_CODE_PACKAGE_TRANSITION_ID";
export const PACKAGE_STOP_REVISION_ENV = "MEMORAX_CODE_PACKAGE_STOP_REVISION";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function packageRecoveryTransitionId(env = process.env) {
  const value = env[PACKAGE_TRANSITION_ID_ENV];
  if (value === undefined || value === "") return undefined;
  return requireTransitionId(value);
}

// Atomic snapshots may be read before retirement; writes and assertions require
// the Backend lifecycle lock so a user stop can revoke an in-flight attempt.
export function readPackageRecoveryRevision(memoraxCodeHome) {
  const path = recoveryPath(memoraxCodeHome);
  try {
    if (!lstatSync(path).isFile()) throw permissionError(path, "invalid_path");
  } catch (error) {
    if (error?.code === "ENOENT") return "absent";
    throw error;
  }
  const state = readJsonRuntimeRecord(path);
  if (state.status === "absent") return "absent";
  if (state.status === "present" && state.value.version === 1 && Object.keys(state.value).length === 2) {
    if (typeof state.value.transitionId === "string" && UUID_PATTERN.test(state.value.transitionId)) return "permit:" + state.value.transitionId;
    if (typeof state.value.stoppedId === "string" && UUID_PATTERN.test(state.value.stoppedId)) return "stopped:" + state.value.stoppedId;
  }
  throw state.status === "present" ? permissionError(path, "invalid_record") : new RuntimeRecordError({
    name: "Package recovery permission", path, state, codePrefix: "PACKAGE_RECOVERY_PERMISSION",
  });
}

export function assertPackageRecoveryRevision(memoraxCodeHome, expectedRevision) {
  if (readPackageRecoveryRevision(memoraxCodeHome) !== expectedRevision) {
    throw permissionError(recoveryPath(memoraxCodeHome), "revision_changed");
  }
}

export function writePackageRecoveryPermit(memoraxCodeHome, transitionId) {
  writeRecoveryRecord(memoraxCodeHome, { version: 1, transitionId: requireTransitionId(transitionId) });
}

export function assertPackageRecoveryPermit(memoraxCodeHome, transitionId) {
  assertPackageRecoveryRevision(memoraxCodeHome, "permit:" + requireTransitionId(transitionId));
}

export function clearPackageRecoveryPermit(memoraxCodeHome) {
  // A durable tombstone also revokes attempts that have not retired the Backend yet.
  writeRecoveryRecord(memoraxCodeHome, { version: 1, stoppedId: randomUUID() });
}

function writeRecoveryRecord(memoraxCodeHome, record) {
  const write = writePrivateJsonRecord(recoveryPath(memoraxCodeHome), record, { durableBoundary: memoraxCodeHome });
  if (write.durability !== "confirmed") {
    throw new Error("durable persistence of package recovery permission could not be confirmed");
  }
}

function recoveryPath(memoraxCodeHome) {
  const home = resolve(memoraxCodeHome);
  const path = join(home, "runtime", "install", "package-recovery.json");
  // The selected Home may be a directory alias; links inside it must not redirect
  // runtime-record writes outside that authority boundary.
  for (const directory of [home, join(home, "runtime"), join(home, "runtime", "install")]) {
    try {
      const entry = directory === home ? statSync(directory) : lstatSync(directory);
      if (!entry.isDirectory()) throw permissionError(path, "invalid_parent_path");
    } catch (error) {
      if (error?.code === "ENOENT") break;
      throw error;
    }
  }
  return path;
}

function permissionError(path, reason) {
  return new RuntimeRecordError({
    name: "Package recovery permission", path, state: { status: "invalid", reason }, codePrefix: "PACKAGE_RECOVERY_PERMISSION",
  });
}

function requireTransitionId(value) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) throw new TypeError("package recovery requires a valid transition ID");
  return value;
}
