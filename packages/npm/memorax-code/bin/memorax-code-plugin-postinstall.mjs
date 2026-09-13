#!/usr/bin/env node
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { unsupportedNodeVersionMessage } from "../lib/node-version.mjs";
import { runNpmPostinstallPackageTransition } from "../lib/package-transition.mjs";
import { reportUpdateFailure } from "../lib/update-diagnostics.mjs";

const PREFIX = "[MemoraX Code Install]:";
const nodeVersionError = unsupportedNodeVersionMessage();
if (nodeVersionError) {
  console.error(`${PREFIX} ${nodeVersionError}`);
  process.exit(1);
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const memoraxCodeHome = process.env.MEMORAX_CODE_HOME?.trim() || join(homedir(), ".memorax-code");

try {
  const result = await runNpmPostinstallPackageTransition({
    memoraxCodeHome,
    memoraxCodeBin: join(scriptDir, "memorax-code.mjs"),
  });
  if (result.disposition === "restored") {
    console.warn(`${PREFIX} Updated managed Backend started and verified.`);
  }
} catch (error) {
  reportUpdateFailure(error, { home: memoraxCodeHome, operation: "install.restore", code: "PACKAGE_TRANSITION_FAILED", stage: "transition_read" });
  process.exit(1);
}
