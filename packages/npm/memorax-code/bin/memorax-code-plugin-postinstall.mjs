#!/usr/bin/env node
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { unsupportedNodeVersionMessage } from "../lib/node-version.mjs";
import { runNpmPostinstallPackageTransition } from "../lib/package-transition.mjs";

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
  printCommandOutput(error?.command);
  console.error(`${PREFIX} Package transition could not be completed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

function printCommandOutput(command) {
  for (const output of [command?.stdout, command?.stderr]) {
    for (const line of String(output ?? "").split(/\r?\n/)) {
      if (line) console.warn(`${PREFIX} ${line}`);
    }
  }
}
