#!/usr/bin/env node
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";
import { unsupportedNodeVersionMessage } from "../lib/node-version.mjs";
import { runNpmPostinstallPackageTransition } from "../lib/package-transition.mjs";
import { reportUpdateFailure, UpdateFailure } from "../lib/update-diagnostics.mjs";
import { updateConfigFileWithLock } from "../lib/memorax-code-adapter-common/src/memorax-code-config-file.mjs";
import { appendMissingJevConfig } from "../lib/memorax-code-adapter-common/src/jev-config-defaults.mjs";

const PREFIX = "[MemoraX Code Install]:";
const nodeVersionError = unsupportedNodeVersionMessage();
if (nodeVersionError) {
  console.error(`${PREFIX} ${nodeVersionError}`);
  process.exit(1);
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const memoraxCodeHome = process.env.MEMORAX_CODE_HOME?.trim() || join(homedir(), ".memorax-code");

let stage = "transition_read";
try {
  const result = await runNpmPostinstallPackageTransition({
    memoraxCodeHome,
    expectedTransitionId: process.env.MEMORAX_CODE_PACKAGE_TRANSITION_ID?.trim() || undefined,
    retryRestore: true,
    writeRestoreMarker: process.env.MEMORAX_CODE_PACKAGE_UPDATE_PARENT === "1",
    memoraxCodeBin: join(scriptDir, "memorax-code.mjs"),
  });
  if (result.disposition === "restored") {
    console.warn(`${PREFIX} Updated managed Backend started and verified.`);
  }
  stage = "config";
  let failure;
  const updated = updateConfigFileWithLock({
    path: join(memoraxCodeHome, "config.toml"),
    transform: appendMissingJevConfig,
    parseToml: parse,
    warn: () => {},
    onFailure: (details) => { failure = details; },
  });
  if (updated === "failed") {
    throw new UpdateFailure("INSTALL_CONFIG_MIGRATION_FAILED", stage, {
      systemCode: failure?.systemCode,
      recordReason: failure?.recordReason,
      configStage: failure?.stage,
      configState: failure?.configState,
    });
  }
} catch (error) {
  reportUpdateFailure(error, {
    home: memoraxCodeHome,
    operation: stage === "config" ? "install.config" : "install.restore",
    code: stage === "config" ? "INSTALL_CONFIG_MIGRATION_FAILED" : "PACKAGE_TRANSITION_FAILED",
    stage,
  });
  process.exit(1);
}
