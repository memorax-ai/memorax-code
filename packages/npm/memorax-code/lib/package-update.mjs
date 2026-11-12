import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { withJsonFileLockAsync } from "./memorax-code-adapter-common/src/config-utils.mjs";
import { readPackageRecoveryRevision } from "./memorax-code-adapter-common/src/package-recovery.mjs";
import { runNpmCommand } from "./npm-invocation.mjs";
import {
  assertNoPendingPackageTransition,
  consumePackageRestoreMarker,
  readPackageTransitionRecord,
  runNpmPostinstallPackageTransition,
} from "./package-transition.mjs";
import { UpdateFailure, runUpdateInstallWithDiagnostics, updateFailure } from "./update-diagnostics.mjs";

export function withPackageUpdateLock(memoraxCodeHome, operation) {
  // npm's children acquire the transition lock, so installation uses a separate lock.
  return withJsonFileLockAsync(join(memoraxCodeHome, "runtime", "install", "package-update.json"), operation);
}

export async function installPackageUpdate(options) {
  let stage = "install_lock";
  let completedFailure;
  try {
    return await withPackageUpdateLock(options.memoraxCodeHome, async () => {
      const { memoraxCodeHome, packageRoot, npmArgs } = options;
      stage = "transition_read";
      assertNoPendingPackageTransition(memoraxCodeHome);
      const transitionId = randomUUID();
      stage = "recovery_authority";
      const env = { ...options.env, MEMORAX_CODE_HOME: memoraxCodeHome,
        MEMORAX_CODE_PACKAGE_TRANSITION_ID: transitionId,
        MEMORAX_CODE_PACKAGE_UPDATE_PARENT: "1",
        MEMORAX_CODE_PACKAGE_STOP_REVISION: readPackageRecoveryRevision(memoraxCodeHome) };
      let result;
      let failure;
      stage = "install";
      try {
        ({ result, failure } = await runUpdateInstallWithDiagnostics(
          (installEnv) => runNpmCommand(npmArgs, { env: installEnv, stdio: options.stdio, windowsHide: true }), env,
        ));
      } catch (error) {
        failure = updateFailure(error, "UPDATE_INSTALL_FAILED", "install");
        result = { exitCode: 1, signal: null };
      }
      const installed = installedPackageMetadata(packageRoot, options.packageName);
      const installedVersion = installed?.version;
      if (result.exitCode === 0 && (!installedVersion
        || (options.targetVersion && installedVersion !== options.targetVersion))) {
        failure = new UpdateFailure("UPDATE_INSTALLED_PACKAGE_MISMATCH", "install", { commandResult: result });
        result = { ...result, exitCode: 1 };
      }
      if (result.exitCode === 0) {
        const restored = consumePackageRestoreMarker(memoraxCodeHome, transitionId);
        stage = "install_lock";
        return { ...result, installedVersion, restored };
      }
      consumePackageRestoreMarker(memoraxCodeHome, transitionId);
      const transition = readPackageTransitionRecord(memoraxCodeHome);
      const owned = transition.status === "valid" && transition.record.transitionId === transitionId;
      failure.installedVersion = installedVersion;
      failure.targetVersion = options.targetVersion;
      failure.recoveryStatus = "not-attempted";
      if (owned && transition.record.state === "retired") {
        // A rolled-back old CLI cannot enforce cancellation by a subsequent stop.
        if (installed?.memoraxCode?.updateRecoveryProtocol === 1) {
          try {
            await runNpmPostinstallPackageTransition({
              memoraxCodeHome,
              memoraxCodeBin: join(packageRoot, "bin", "memorax-code.mjs"),
              expectedTransitionId: transitionId,
              env,
            });
            failure.recoveryStatus = "restored";
          } catch (error) {
            failure.recoveryStatus = "failed";
            failure.recovery = updateFailure(error, "PACKAGE_TRANSITION_FAILED", "restore");
          }
        } else {
          failure.recoveryStatus = "unsupported-package";
        }
      }
      completedFailure = failure;
      stage = "install_lock";
      // Restoring service does not change the failed npm result into success.
      return { ...result, installedVersion, failure };
    });
  } catch (error) {
    const failure = updateFailure(error, "UPDATE_FAILED", stage, { lockStage: "install_lock" });
    if (completedFailure) {
      completedFailure.recovery ??= failure;
      throw completedFailure;
    }
    throw failure;
  }
}

function installedPackageMetadata(packageRoot, packageName) {
  try {
    const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
    return pkg.name === packageName && typeof pkg.version === "string"
      && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(pkg.version) ? pkg : undefined;
  } catch { return undefined; }
}
