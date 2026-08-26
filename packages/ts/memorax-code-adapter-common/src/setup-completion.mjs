import { unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { withJsonFileLockAsync } from "./config-utils.mjs";
import {
  readJsonRuntimeRecord,
  RuntimeRecordError,
  writePrivateJsonRecord,
} from "./runtime-record.mjs";

export const SETUP_COMPLETION_RECORD_VERSION = 1;

const SETUP_COMPLETION_RECORD_KEYS = new Set([
  "version",
  "state",
  "completedAt",
  "completedByVersion",
]);
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

export class SetupCompletionRecordError extends RuntimeRecordError {
  constructor(state, path) {
    super({
      name: "Setup completion record",
      path,
      state,
      codePrefix: "SETUP_COMPLETION_RECORD",
      recovery: state.status === "unsupported"
        ? "upgrade MemoraX Code or restore a supported setup completion record"
        : "inspect the setup completion record before replacing it",
    });
    this.name = "SetupCompletionRecordError";
  }
}

export function setupCompletionPath(memoraxCodeHome = defaultMemoraxCodeHome()) {
  return join(memoraxCodeHome, "runtime", "setup", "setup-completion.json");
}

export function readSetupCompletionRecord(memoraxCodeHome = defaultMemoraxCodeHome()) {
  const path = setupCompletionPath(memoraxCodeHome);
  const state = readJsonRuntimeRecord(path);
  if (state.status !== "present") return state;
  const value = state.value;
  if (value.version !== SETUP_COMPLETION_RECORD_VERSION) {
    if (Number.isSafeInteger(value.version) && value.version > 0) {
      return { status: "unsupported", version: value.version };
    }
    return { status: "invalid", reason: "invalid_version" };
  }
  if (Object.keys(value).some((key) => !SETUP_COMPLETION_RECORD_KEYS.has(key))) {
    return { status: "invalid", reason: "unknown_fields" };
  }
  if (value.state !== "complete") {
    return { status: "invalid", reason: "invalid_state" };
  }
  const completedAt = isoTimestamp(value.completedAt);
  if (!completedAt) return { status: "invalid", reason: "invalid_completed_at" };
  const completedByVersion = nonEmptyString(value.completedByVersion);
  if (!completedByVersion) {
    return { status: "invalid", reason: "invalid_completed_by_version" };
  }
  return {
    status: "valid",
    record: {
      version: SETUP_COMPLETION_RECORD_VERSION,
      state: "complete",
      completedAt,
      completedByVersion,
    },
  };
}

export function writeSetupCompletionRecord(options, runtime) {
  const memoraxCodeHome = nonEmptyString(options?.memoraxCodeHome) ?? defaultMemoraxCodeHome();
  const completedAt = isoTimestamp(options?.completedAt);
  if (!completedAt) {
    throw new TypeError("Setup completion record requires a valid ISO completedAt timestamp");
  }
  const completedByVersion = nonEmptyString(options?.completedByVersion);
  if (!completedByVersion) {
    throw new TypeError("Setup completion record requires a non-empty completedByVersion");
  }
  const path = setupCompletionPath(memoraxCodeHome);
  const existing = readSetupCompletionRecord(memoraxCodeHome);
  if (existing.status === "invalid" || existing.status === "unsupported") {
    throw new SetupCompletionRecordError(existing, path);
  }
  return writePrivateJsonRecord(path, {
    version: SETUP_COMPLETION_RECORD_VERSION,
    state: "complete",
    completedAt,
    completedByVersion,
  }, {
    ...runtime,
    durableBoundary: memoraxCodeHome,
  });
}

export async function clearSetupCompletionRecord(
  memoraxCodeHome = defaultMemoraxCodeHome(),
  options,
) {
  const home = nonEmptyString(memoraxCodeHome) ?? defaultMemoraxCodeHome();
  return await withSetupCompletionLock(
    home,
    (_state, mutation) => mutation.clear(),
    options,
  );
}

export async function withSetupCompletionLock(
  memoraxCodeHome,
  operation,
  options,
) {
  const home = nonEmptyString(memoraxCodeHome);
  if (!home) throw new TypeError("Setup completion lock requires a MemoraX Code home");
  if (typeof operation !== "function") {
    throw new TypeError("Setup completion lock requires an operation");
  }
  const path = setupCompletionPath(home);
  return await withJsonFileLockAsync(path, async () => {
    let state = readSetupCompletionRecord(home);
    if (state.status === "invalid" || state.status === "unsupported") {
      throw new SetupCompletionRecordError(state, path);
    }
    return await operation(state, {
      clear() {
        if (state.status === "absent") return { path, removed: false };
        unlinkSync(path);
        state = { status: "absent" };
        return { path, removed: true };
      },
    });
  }, options);
}

function defaultMemoraxCodeHome() {
  return join(homedir(), ".memorax-code");
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isoTimestamp(value) {
  const candidate = nonEmptyString(value);
  return candidate
    && ISO_TIMESTAMP_PATTERN.test(candidate)
    && Number.isFinite(Date.parse(candidate))
    ? candidate
    : undefined;
}
