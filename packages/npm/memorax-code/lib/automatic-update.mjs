import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { withJsonFileLockAsync } from "./memorax-code-adapter-common/src/config-utils.mjs";
import {
  readJsonRuntimeRecord,
  writePrivateJsonRecord,
} from "./memorax-code-adapter-common/src/runtime-record.mjs";
import {
  readSetupCompletionRecord,
  withSetupCompletionLock,
} from "./memorax-code-adapter-common/src/setup-completion.mjs";
import { resolveNpmInvocation } from "./npm-invocation.mjs";

export const AUTOMATIC_UPDATE_RECORD_VERSION = 1;
export const AUTOMATIC_UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1_000;
export const AUTOMATIC_UPDATE_RETRY_INTERVAL_MS = 15 * 60 * 1_000;

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

export async function runAutomaticUpdate(options) {
  const memoraxCodeHome = resolve(requiredString(options?.memoraxCodeHome, "memoraxCodeHome"));
  const packageRoot = resolve(requiredString(options?.packageRoot, "packageRoot"));
  const packageName = requiredString(options?.packageName, "packageName");
  const packageVersion = requiredString(options?.packageVersion, "packageVersion");
  const env = options?.env ?? process.env;
  if (automaticUpdateDisabled(env.MEMORAX_CODE_AUTO_UPDATE)) {
    return { ok: true, disposition: "disabled" };
  }

  const completion = readSetupCompletionRecord(memoraxCodeHome);
  if (completion.status === "absent") {
    return { ok: true, disposition: "setup-incomplete" };
  }
  if (completion.status !== "valid") {
    return { ok: false, disposition: "failed", reason: "setup_completion_invalid" };
  }

  const channel = packageVersion.includes("-") ? "preview" : "latest";
  return await runAutomaticUpdateCore({
    memoraxCodeHome,
    installedVersion: packageVersion,
    completedByVersion: completion.record.completedByVersion,
    channel,
    resolveTargetVersion: async (targetChannel) => resolveTargetVersion({
      channel: targetChannel,
      env,
      packageName,
    }),
    installVersion: async (targetVersion) => (
      await runNpmCommand({
        args: ["install", "-g", `${packageName}@${targetVersion}`],
        env: {
          ...env,
          MEMORAX_CODE_AUTOMATIC_UPDATE_PROCESS: "1",
          MEMORAX_CODE_HOME: memoraxCodeHome,
        },
        stdio: "ignore",
      })
    ) === 0,
    reconcile: async (targetVersion) => await runAutomaticSetup({
      env,
      memoraxCodeHome,
      packageRoot,
      targetVersion,
    }),
  });
}

export async function runAutomaticUpdateCore(options) {
  const memoraxCodeHome = resolve(requiredString(options?.memoraxCodeHome, "memoraxCodeHome"));
  const installedVersion = requiredString(options?.installedVersion, "installedVersion");
  const completedByVersion = requiredString(options?.completedByVersion, "completedByVersion");
  const channel = options?.channel === "preview" ? "preview" : "latest";
  const resolveTargetVersion = requiredFunction(options?.resolveTargetVersion, "resolveTargetVersion");
  const installVersion = requiredFunction(options?.installVersion, "installVersion");
  const reconcile = requiredFunction(options?.reconcile, "reconcile");
  const path = automaticUpdateStatePath(memoraxCodeHome);

  return await withJsonFileLockAsync(path, async () => {
    const nowMs = currentTime(options);
    const state = readAutomaticUpdateState(memoraxCodeHome);
    if (state.status === "valid"
      && state.record.installedVersion === installedVersion
      && nowMs < Date.parse(state.record.nextCheckAt)) {
      return { ok: true, disposition: "throttled", state: state.record };
    }

    let targetVersion;
    try {
      targetVersion = requiredString(
        await resolveTargetVersion(channel),
        "targetVersion",
      );
    } catch {
      const record = writeState({
        memoraxCodeHome,
        checkedAtMs: nowMs,
        installedVersion,
        targetVersion: null,
        channel,
        outcome: "check-failed",
        retry: true,
      });
      return { ok: false, disposition: "failed", reason: "check_failed", state: record };
    }

    let effectiveVersion = installedVersion;
    let updated = false;
    if (targetVersion !== installedVersion) {
      let installed = false;
      try {
        installed = await installVersion(targetVersion) === true;
      } catch {
        installed = false;
      }
      if (!installed) {
        const record = writeState({
          memoraxCodeHome,
          checkedAtMs: nowMs,
          installedVersion,
          targetVersion,
          channel,
          outcome: "update-failed",
          retry: true,
        });
        return { ok: false, disposition: "failed", reason: "update_failed", state: record };
      }
      effectiveVersion = targetVersion;
      updated = true;
    }

    if (updated || completedByVersion !== effectiveVersion) {
      let reconciled = false;
      try {
        reconciled = await reconcile(effectiveVersion) === true;
      } catch {
        reconciled = false;
      }
      if (!reconciled) {
        const record = writeState({
          memoraxCodeHome,
          checkedAtMs: nowMs,
          installedVersion: effectiveVersion,
          targetVersion,
          channel,
          outcome: "reconcile-failed",
          retry: true,
        });
        return { ok: false, disposition: "failed", reason: "reconcile_failed", state: record };
      }
    }

    const outcome = updated
      ? "updated"
      : completedByVersion === effectiveVersion
        ? "up-to-date"
        : "reconciled";
    const record = writeState({
      memoraxCodeHome,
      checkedAtMs: nowMs,
      installedVersion: effectiveVersion,
      targetVersion,
      channel,
      outcome,
      retry: false,
    });
    return { ok: true, disposition: outcome, state: record };
  });
}

function resolveTargetVersion({ channel, env, packageName }) {
  const args = ["view", `${packageName}@${channel}`, "version", "--json"];
  const invocation = resolveNpmInvocation(args, { env });
  const cwd = npmCommandCwd(env);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd,
    encoding: "utf8",
    env: { ...env, PWD: cwd, MEMORAX_CODE_AUTOMATIC_UPDATE_PROCESS: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
    maxBuffer: 64 * 1024,
    windowsHide: true,
  });
  if (result.error || result.signal || result.status !== 0) {
    throw new Error("npm registry version check failed");
  }
  let version;
  try {
    version = JSON.parse(String(result.stdout ?? ""));
  } catch {
    throw new Error("npm registry returned an invalid version response");
  }
  if (typeof version !== "string"
    || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error("npm registry returned an invalid package version");
  }
  return version;
}

async function runNpmCommand({ args, env, stdio }) {
  let invocation;
  try {
    invocation = resolveNpmInvocation(args, { env });
  } catch {
    return 1;
  }
  const cwd = npmCommandCwd(env);
  const child = spawn(invocation.command, invocation.args, {
    cwd,
    env: { ...env, PWD: cwd },
    stdio,
    windowsHide: true,
  });
  return await new Promise((resolveExitCode) => {
    child.on("error", () => resolveExitCode(1));
    child.on("close", (code, signal) => resolveExitCode(signal ? 1 : (code ?? 1)));
  });
}

async function runAutomaticSetup({ env, memoraxCodeHome, packageRoot, targetVersion }) {
  return await withSetupCompletionLock(memoraxCodeHome, async (completion) => {
    if (completion.status !== "valid") return false;
    const setupPath = join(packageRoot, "bin", "memorax-code-setup.mjs");
    if (!existsSync(setupPath)) return false;
    const setupEnv = {
      ...env,
      MEMORAX_CODE_AUTOMATIC_UPDATE_PROCESS: "1",
      MEMORAX_CODE_HOME: memoraxCodeHome,
      MEMORAX_CODE_SETUP_AUTOMATIC_UPDATE: "1",
      MEMORAX_CODE_SETUP_UPDATE: "1",
    };
    delete setupEnv.MEMORAX_CODE_SETUP_MODE;
    const child = spawn(process.execPath, [setupPath], {
      env: setupEnv,
      stdio: "ignore",
      windowsHide: true,
    });
    const exitCode = await new Promise((resolveExitCode) => {
      child.on("error", () => resolveExitCode(1));
      child.on("close", (code, signal) => resolveExitCode(signal ? 1 : (code ?? 1)));
    });
    if (exitCode !== 0) return false;
    const reconciled = readSetupCompletionRecord(memoraxCodeHome);
    return reconciled.status === "valid"
      && reconciled.record.completedByVersion === targetVersion;
  });
}

function npmCommandCwd(env) {
  for (const candidate of [env.HOME, homedir(), "/"]) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return "/";
}

function writeState({
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

function currentTime(options) {
  const value = typeof options?.now === "function" ? Number(options.now()) : Date.now();
  if (!Number.isFinite(value)) throw new TypeError("automatic update now must return a timestamp");
  return value;
}

function requiredFunction(value, name) {
  if (typeof value !== "function") throw new TypeError(`automatic update requires ${name}`);
  return value;
}

function requiredString(value, name) {
  const result = nonEmptyString(value);
  if (!result) throw new TypeError(`automatic update requires ${name}`);
  return result;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function automaticUpdateDisabled(value) {
  return ["0", "false", "no", "off", "disabled"].includes(String(value ?? "").trim().toLowerCase());
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
