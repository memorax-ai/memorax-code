import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { withJsonFileLockAsync } from "./memorax-code-adapter-common/src/config-utils.mjs";
import {
  AUTOMATIC_UPDATE_CHECK_INTERVAL_MS,
  AUTOMATIC_UPDATE_RECORD_VERSION,
  AUTOMATIC_UPDATE_RETRY_INTERVAL_MS,
  automaticUpdateStatePath,
  readAutomaticUpdateState,
  writeAutomaticUpdateState,
} from "./memorax-code-adapter-common/src/automatic-update-state.mjs";
import {
  readSetupCompletionRecord,
  withSetupCompletionLock,
} from "./memorax-code-adapter-common/src/setup-completion.mjs";
import {
  npmCommandCwd,
  resolveNpmInvocation,
  runNpmCommand,
  waitForChildProcess,
} from "./npm-invocation.mjs";

export {
  AUTOMATIC_UPDATE_CHECK_INTERVAL_MS,
  AUTOMATIC_UPDATE_RECORD_VERSION,
  AUTOMATIC_UPDATE_RETRY_INTERVAL_MS,
  automaticUpdateStatePath,
  readAutomaticUpdateState,
};

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
      await runNpmCommand(["install", "-g", `${packageName}@${targetVersion}`], {
        env: {
          ...env,
          MEMORAX_CODE_AUTOMATIC_UPDATE_PROCESS: "1",
          MEMORAX_CODE_HOME: memoraxCodeHome,
        },
        stdio: "ignore",
        windowsHide: true,
      })
    ).exitCode === 0,
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
    const finish = (result, effectiveVersion, retry) => {
      const state = writeAutomaticUpdateState({
        memoraxCodeHome,
        nowMs,
        installedVersion: effectiveVersion,
        retry,
      });
      return { ...result, state };
    };
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
      return finish({ ok: false, disposition: "failed", reason: "check_failed" }, installedVersion, true);
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
        return finish({ ok: false, disposition: "failed", reason: "update_failed" }, installedVersion, true);
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
        return finish({ ok: false, disposition: "failed", reason: "reconcile_failed" }, effectiveVersion, true);
      }
    }

    const outcome = updated
      ? "updated"
      : completedByVersion === effectiveVersion
        ? "up-to-date"
        : "reconciled";
    return finish({ ok: true, disposition: outcome }, effectiveVersion, false);
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
    if ((await waitForChildProcess(child)).exitCode !== 0) return false;
    const reconciled = readSetupCompletionRecord(memoraxCodeHome);
    return reconciled.status === "valid"
      && reconciled.record.completedByVersion === targetVersion;
  });
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
