import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  readJsonRuntimeRecord,
  writePrivateJsonRecord,
} from "../runtime-record.mjs";
import { readSetupCompletionRecord } from "../setup-completion.mjs";

export const AUTOMATIC_UPDATE_RECORD_VERSION = 1;
export const AUTOMATIC_UPDATE_CHECK_INTERVAL_MS = 8 * 60 * 60 * 1_000;
export const AUTOMATIC_UPDATE_RETRY_INTERVAL_MS = 15 * 60 * 1_000;

const MAX_TIMER_DELAY_MS = 2_147_483_647;
const OUTCOMES = new Set([
  "up-to-date",
  "updated",
  "reconciled",
  "check-failed",
  "update-failed",
  "reconcile-failed",
]);
const RECORD_KEYS = new Set([
  "version",
  "checkedAt",
  "nextCheckAt",
  "installedVersion",
  "targetVersion",
  "channel",
  "outcome",
]);

export function automaticUpdateStatePath(memoraxCodeHome = defaultMemoraxCodeHome()) {
  return join(resolve(memoraxCodeHome), "runtime", "install", "automatic-update.json");
}

export function readAutomaticUpdateState(memoraxCodeHome = defaultMemoraxCodeHome()) {
  const state = readJsonRuntimeRecord(automaticUpdateStatePath(memoraxCodeHome));
  if (state.status !== "present") return state;
  const value = state.value;
  if (value.version !== AUTOMATIC_UPDATE_RECORD_VERSION) {
    if (Number.isSafeInteger(value.version) && value.version > 0) {
      return { status: "unsupported", version: value.version };
    }
    return { status: "invalid", reason: "invalid_version" };
  }
  if (Object.keys(value).length !== RECORD_KEYS.size
    || Object.keys(value).some((key) => !RECORD_KEYS.has(key))) {
    return { status: "invalid", reason: "unknown_or_missing_fields" };
  }
  const checkedAt = timestamp(value.checkedAt);
  const nextCheckAt = timestamp(value.nextCheckAt);
  const installedVersion = nonEmptyString(value.installedVersion);
  const targetVersion = value.targetVersion === null ? null : nonEmptyString(value.targetVersion);
  const channel = value.channel === "latest" || value.channel === "preview"
    ? value.channel
    : undefined;
  if (!checkedAt || !nextCheckAt || Date.parse(nextCheckAt) < Date.parse(checkedAt)) {
    return { status: "invalid", reason: "invalid_timestamps" };
  }
  if (!installedVersion || targetVersion === undefined || !channel || !OUTCOMES.has(value.outcome)) {
    return { status: "invalid", reason: "invalid_fields" };
  }
  return {
    status: "valid",
    record: {
      version: AUTOMATIC_UPDATE_RECORD_VERSION,
      checkedAt,
      nextCheckAt,
      installedVersion,
      targetVersion,
      channel,
      outcome: value.outcome,
    },
  };
}

export function writeAutomaticUpdateState({
  memoraxCodeHome,
  checkedAtMs,
  installedVersion,
  targetVersion,
  channel,
  outcome,
  retry,
}) {
  const record = {
    version: AUTOMATIC_UPDATE_RECORD_VERSION,
    checkedAt: new Date(checkedAtMs).toISOString(),
    nextCheckAt: new Date(
      checkedAtMs + (retry ? AUTOMATIC_UPDATE_RETRY_INTERVAL_MS : AUTOMATIC_UPDATE_CHECK_INTERVAL_MS),
    ).toISOString(),
    installedVersion,
    targetVersion,
    channel,
    outcome,
  };
  writePrivateJsonRecord(automaticUpdateStatePath(memoraxCodeHome), record, {
    durableBoundary: memoraxCodeHome,
  });
  return record;
}

export function startAutomaticUpdateScheduler(options = {}, runtime = {}) {
  const env = options.env ?? process.env;
  if (automaticUpdateDisabled(options.automaticUpdateValue ?? env.MEMORAX_CODE_AUTO_UPDATE)) {
    return undefined;
  }

  const memoraxCodeHome = nonEmptyString(options.memoraxCodeHome);
  const memoraxCodeCommand = nonEmptyString(options.memoraxCodeCommand);
  const installedVersion = nonEmptyString(options.installedVersion);
  const nodePath = nonEmptyString(options.nodePath) ?? process.execPath;
  const pathExists = runtime.existsSync ?? existsSync;
  if (!memoraxCodeHome
    || !memoraxCodeCommand
    || !installedVersion
    || !pathExists(memoraxCodeCommand)) {
    return undefined;
  }

  const home = resolve(memoraxCodeHome);
  const readCompletion = runtime.readSetupCompletionRecord ?? readSetupCompletionRecord;
  const readUpdateState = runtime.readAutomaticUpdateState ?? readAutomaticUpdateState;
  const spawnProcess = runtime.spawnProcess ?? spawn;
  const now = runtime.now ?? Date.now;
  const setTimer = runtime.setTimeout ?? setTimeout;
  const clearTimer = runtime.clearTimeout ?? clearTimeout;
  let closed = false;
  let childRunning = false;
  let timer;
  let suppressImmediate = options.automaticUpdateProcess === true
    || env.MEMORAX_CODE_AUTOMATIC_UPDATE_PROCESS === "1";

  const debug = (message) => options.debug?.(message);
  const scheduleAfter = (delayMs) => {
    if (closed) return;
    if (timer !== undefined) clearTimer(timer);
    const boundedDelay = Math.max(1, Math.min(MAX_TIMER_DELAY_MS, Math.trunc(delayMs)));
    timer = setTimer(() => {
      timer = undefined;
      reconcile();
    }, boundedDelay);
    timer?.unref?.();
  };
  const scheduleRetry = () => scheduleAfter(AUTOMATIC_UPDATE_RETRY_INTERVAL_MS);

  const launch = () => {
    let child;
    try {
      child = spawnProcess(
        nodePath,
        [memoraxCodeCommand, "update", "--automatic", "--home", home],
        {
          detached: true,
          env: {
            ...env,
            MEMORAX_CODE_AUTOMATIC_UPDATE_PROCESS: "1",
            MEMORAX_CODE_HOME: home,
          },
          stdio: "ignore",
          windowsHide: true,
        },
      );
    } catch (error) {
      debug(`MemoraX Code automatic update could not start: ${error instanceof Error ? error.message : String(error)}`);
      scheduleRetry();
      return;
    }

    childRunning = true;
    let settled = false;
    const finish = (successful) => {
      if (settled) return;
      settled = true;
      childRunning = false;
      if (closed) return;
      reconcile({ deferDue: !successful });
    };
    child.once("error", (error) => {
      debug(`MemoraX Code automatic update could not start: ${error.message}`);
      finish(false);
    });
    child.once("close", (code, signal) => finish(signal === null && code === 0));
    child.unref();
  };

  function reconcile({ deferDue = false } = {}) {
    if (closed || childRunning) return;
    let completion;
    let state;
    let nowMs;
    try {
      completion = readCompletion(home);
      state = readUpdateState(home);
      nowMs = Number(now());
      if (!Number.isFinite(nowMs)) throw new TypeError("automatic update scheduler clock is invalid");
    } catch (error) {
      debug(`MemoraX Code automatic update scheduling failed: ${error instanceof Error ? error.message : String(error)}`);
      scheduleRetry();
      return;
    }

    if (completion.status !== "valid") {
      scheduleRetry();
      return;
    }
    if (state.status === "valid" && state.record.installedVersion === installedVersion) {
      const remainingMs = Date.parse(state.record.nextCheckAt) - nowMs;
      if (remainingMs > 0) {
        scheduleAfter(remainingMs);
        return;
      }
    }
    if (suppressImmediate) {
      suppressImmediate = false;
      scheduleRetry();
      return;
    }
    if (deferDue) {
      scheduleRetry();
      return;
    }
    launch();
  }

  reconcile();
  return {
    close() {
      if (closed) return;
      closed = true;
      if (timer !== undefined) {
        clearTimer(timer);
        timer = undefined;
      }
    },
  };
}

function automaticUpdateDisabled(value) {
  return ["0", "false", "no", "off", "disabled"].includes(String(value ?? "").trim().toLowerCase());
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

function defaultMemoraxCodeHome() {
  return join(homedir(), ".memorax-code");
}
