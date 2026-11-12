import { join, resolve } from "node:path";
import {
  readJsonRuntimeRecord,
  writePrivateJsonRecord,
} from "./runtime-record.mjs";

export const AUTOMATIC_UPDATE_RECORD_VERSION = 1;
export const AUTOMATIC_UPDATE_CHECK_INTERVAL_MS = 8 * 60 * 60 * 1_000;
export const AUTOMATIC_UPDATE_RETRY_INTERVAL_MS = 15 * 60 * 1_000;

const RECORD_KEYS = new Set(["version", "installedVersion", "nextCheckAt"]);

export function automaticUpdateStatePath(memoraxCodeHome) {
  return join(resolve(memoraxCodeHome), "runtime", "install", "automatic-update.json");
}

export function readAutomaticUpdateState(memoraxCodeHome) {
  const state = readJsonRuntimeRecord(automaticUpdateStatePath(memoraxCodeHome));
  if (state.status !== "present") return state;
  const value = state.value;
  if (value.version !== AUTOMATIC_UPDATE_RECORD_VERSION) {
    return Number.isSafeInteger(value.version) && value.version > 0
      ? { status: "unsupported", version: value.version }
      : { status: "invalid", reason: "invalid_version" };
  }
  if (Object.keys(value).length !== RECORD_KEYS.size
    || Object.keys(value).some((key) => !RECORD_KEYS.has(key))) {
    return { status: "invalid", reason: "unknown_or_missing_fields" };
  }
  const installedVersion = nonEmptyString(value.installedVersion);
  const nextCheckAt = timestamp(value.nextCheckAt);
  if (!installedVersion || !nextCheckAt) {
    return { status: "invalid", reason: "invalid_fields" };
  }
  return {
    status: "valid",
    record: {
      version: AUTOMATIC_UPDATE_RECORD_VERSION,
      installedVersion,
      nextCheckAt,
    },
  };
}

export function writeAutomaticUpdateState({ memoraxCodeHome, nowMs, installedVersion, retry }) {
  const timestampMs = Number(nowMs);
  const version = nonEmptyString(installedVersion);
  if (!Number.isFinite(timestampMs) || !version) {
    throw new TypeError("automatic update state requires a timestamp and installed version");
  }
  const record = {
    version: AUTOMATIC_UPDATE_RECORD_VERSION,
    installedVersion: version,
    nextCheckAt: new Date(
      timestampMs + (retry ? AUTOMATIC_UPDATE_RETRY_INTERVAL_MS : AUTOMATIC_UPDATE_CHECK_INTERVAL_MS),
    ).toISOString(),
  };
  writePrivateJsonRecord(automaticUpdateStatePath(memoraxCodeHome), record, {
    durableBoundary: memoraxCodeHome,
  });
  return record;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function timestamp(value) {
  const candidate = nonEmptyString(value);
  return candidate && Number.isFinite(Date.parse(candidate))
    ? new Date(Date.parse(candidate)).toISOString()
    : undefined;
}
