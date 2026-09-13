import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { UpdateFailure, updateFailure, npmRegistryFailureFields, projectUpdateDiagnosticMessage, runUpdateInstallWithDiagnostics } from "./update-diagnostics.mjs";
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
    return { ok: false, disposition: "failed", reason: "setup_completion_invalid",
      error: setupCompletionFailure(completion) };
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
    installVersion: async (targetVersion) => {
      const { failure } = await runUpdateInstallWithDiagnostics((installEnv) => runNpmCommand(["install", "-g", `${packageName}@${targetVersion}`], {
        env: {
          ...installEnv,
          MEMORAX_CODE_AUTOMATIC_UPDATE_PROCESS: "1",
          MEMORAX_CODE_HOME: memoraxCodeHome,
        },
        stdio: "ignore",
        windowsHide: true,
      }), env);
      if (failure) throw failure;
      return true;
    },
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

  let stage = "update_lock";
  let completedResult;
  try {
    return await withJsonFileLockAsync(path, async () => {
      stage = "update_state";
      const nowMs = currentTime(options);
      const finish = (result, effectiveVersion, retry) => {
        try {
          const state = writeAutomaticUpdateState({
            memoraxCodeHome,
            nowMs,
            installedVersion: effectiveVersion,
            retry,
          });
          stage = "update_lock";
          completedResult = { ...result, state };
          return completedResult;
        } catch (error) {
          const failure = updateFailure(error, "UPDATE_STATE_WRITE_FAILED", "update_state");
          if (result.error) {
            result.error.recovery ??= failure;
            throw result.error;
          }
          throw failure;
        }
      };
      const state = readAutomaticUpdateState(memoraxCodeHome);
      if (state.status === "valid"
        && state.record.installedVersion === installedVersion
        && nowMs < Date.parse(state.record.nextCheckAt)) {
        stage = "update_lock";
        return { ok: true, disposition: "throttled", state: state.record };
      }

      let targetVersion;
      try {
        targetVersion = requiredString(
          await resolveTargetVersion(channel),
          "targetVersion",
        );
      } catch (error) {
        return finish({ ok: false, disposition: "failed", reason: "check_failed",
          error: updateFailure(error, "UPDATE_VERSION_CHECK_FAILED", "version_check") }, installedVersion, true);
      }

      let effectiveVersion = installedVersion;
      let updated = false;
      if (targetVersion !== installedVersion) {
        let installed = false;
        let failure;
        try {
          installed = await installVersion(targetVersion) === true;
        } catch (error) {
          failure = error;
        }
        if (!installed) {
          return finish({ ok: false, disposition: "failed", reason: "update_failed",
            error: updateFailure(failure, "UPDATE_INSTALL_FAILED", "install") }, installedVersion, true);
        }
        effectiveVersion = targetVersion;
        updated = true;
      }

      // An interrupted update can leave current package files with client setup
      // still completed by an older version.
      if (updated || completedByVersion !== effectiveVersion) {
        let reconciled = false;
        let failure;
        try {
          reconciled = await reconcile(effectiveVersion) === true;
        } catch (error) {
          failure = error;
        }
        if (!reconciled) {
          return finish({ ok: false, disposition: "failed", reason: "reconcile_failed",
            error: updateFailure(failure, "UPDATE_RECONCILE_FAILED", "reconcile") }, effectiveVersion, true);
        }
      }

      const outcome = updated
        ? "updated"
        : completedByVersion === effectiveVersion
          ? "up-to-date"
          : "reconciled";
      return finish({ ok: true, disposition: outcome }, effectiveVersion, false);
    });
  } catch (error) {
    const failure = updateFailure(error, "UPDATE_FAILED", stage, { lockStage: "update_lock" });
    if (completedResult?.error) {
      completedResult.error.recovery ??= failure;
      throw completedResult.error;
    }
    throw failure;
  }
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
    throw new UpdateFailure("UPDATE_VERSION_CHECK_FAILED", "version_check", { commandResult: result, ...npmRegistryFailureFields(result.stdout) });
  }
  let version;
  try {
    version = JSON.parse(String(result.stdout ?? ""));
  } catch {
    throw new UpdateFailure("UPDATE_VERSION_RESPONSE_INVALID", "version_check", { failureReason: "invalid_response" });
  }
  if (typeof version !== "string"
    || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new UpdateFailure("UPDATE_VERSION_RESPONSE_INVALID", "version_check", { failureReason: "invalid_version" });
  }
  return version;
}

export async function runAutomaticSetup({ env, memoraxCodeHome, packageRoot, targetVersion }) {
  const children = new Map();
  let childFailed = false;
  let stage = "setup_state";
  try {
    return await withSetupCompletionLock(memoraxCodeHome, async (completion) => {
      if (completion.status !== "valid") throw setupCompletionFailure(completion);
      stage = "reconcile";
      const setupPath = join(packageRoot, "bin", "memorax-code-setup.mjs");
      if (!existsSync(setupPath)) throw new UpdateFailure("UPDATE_RECONCILE_FAILED", "reconcile", { failureReason: "missing_entrypoint" });
      const setupEnv = {
        ...env,
        MEMORAX_CODE_AUTOMATIC_UPDATE_PROCESS: "1",
        MEMORAX_CODE_HOME: memoraxCodeHome,
        MEMORAX_CODE_SETUP_AUTOMATIC_UPDATE: "1",
        MEMORAX_CODE_SETUP_UPDATE: "1",
      };
      delete setupEnv.MEMORAX_CODE_SETUP_MODE;
      let result;
      try {
        const child = spawn(process.execPath, [setupPath], {
          env: setupEnv,
          stdio: ["ignore", "ignore", "ignore", "ipc"],
          windowsHide: true,
        });
        child.on("message", (message) => {
          const diagnostic = projectUpdateDiagnosticMessage(message);
          if (diagnostic && children.size < 32 && !children.has(diagnostic.diagnostic.id)) {
            children.set(diagnostic.diagnostic.id, diagnostic);
          }
        });
        result = await waitForChildProcess(child);
      } catch (error) {
        childFailed = true;
        throw updateFailure(error, "UPDATE_RECONCILE_FAILED", "reconcile");
      }
      if (result.exitCode !== 0) {
        childFailed = true;
        throw new UpdateFailure("UPDATE_RECONCILE_FAILED", "reconcile", { commandResult: result });
      }
      const reconciled = readSetupCompletionRecord(memoraxCodeHome);
      if (reconciled.status !== "valid") throw setupCompletionFailure(reconciled);
      if (reconciled.record.completedByVersion !== targetVersion) {
        throw new UpdateFailure("UPDATE_RECONCILE_FAILED", "reconcile", { failureReason: "setup_mismatch", recordReason: reconciled.reason });
      }
      stage = "setup_state";
      return true;
    });
  } catch (error) {
    const failure = updateFailure(error, "UPDATE_RECONCILE_FAILED", stage, { lockStage: "setup_state" });
    if (childFailed && children.size) failure.children = [...children.values()];
    throw failure;
  }
}

function setupCompletionFailure(state) {
  const code = {
    invalid: "SETUP_COMPLETION_RECORD_INVALID",
    unsupported: "SETUP_COMPLETION_RECORD_UNSUPPORTED",
    absent: "SETUP_COMPLETION_RECORD_ABSENT",
  }[state.status] ?? "UPDATE_SETUP_STATE_INVALID";
  return new UpdateFailure(code, "setup_state", { recordReason: state.reason });
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
