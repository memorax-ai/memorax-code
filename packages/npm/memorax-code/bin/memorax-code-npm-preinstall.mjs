#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { unsupportedNodeVersionMessage } from "../lib/node-version.mjs";
import { runNpmPreinstallPackageTransition } from "../lib/package-transition.mjs";
import { reportUpdateFailure } from "../lib/update-diagnostics.mjs";

const PREFIX = "[MemoraX Code Install]:";
const nodeVersionError = unsupportedNodeVersionMessage();
if (nodeVersionError) {
  console.error(`${PREFIX} ${nodeVersionError}`);
  process.exit(1);
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = dirname(scriptDir);
const memoraxCodeHome = process.env.MEMORAX_CODE_HOME?.trim() || join(homedir(), ".memorax-code");

try {
  const result = runNpmPreinstallPackageTransition({
    memoraxCodeHome,
    memoraxCodeBin: join(scriptDir, "memorax-code.mjs"),
    packageVersion: packageVersion(packageRoot),
  });
  if (result.disposition === "retired") {
    console.warn(`${PREFIX} Existing managed Backend retired for package replacement.`);
  }
} catch (error) {
  reportUpdateFailure(error, { home: memoraxCodeHome, operation: "install.retire", code: "PACKAGE_TRANSITION_FAILED", stage: "transition_read" });
  process.exit(1);
}

function packageVersion(root) {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (typeof pkg.version !== "string" || !pkg.version.trim()) {
    throw new Error("package metadata does not contain a version");
  }
  return pkg.version.trim();
}
