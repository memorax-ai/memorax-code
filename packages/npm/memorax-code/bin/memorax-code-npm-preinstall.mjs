#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { unsupportedNodeVersionMessage } from "../lib/node-version.mjs";

const PREFIX = "[MemoraX Code Install]:";
const PREINSTALL_STOP_TIMEOUT_MS = 45_000;
const nodeVersionError = unsupportedNodeVersionMessage();
if (nodeVersionError) {
  console.error(`${PREFIX} ${nodeVersionError}`);
  process.exit(1);
}
const scriptDir = dirname(fileURLToPath(import.meta.url));
const memoraxCodeBin = join(scriptDir, "memorax-code.mjs");
const memoraxCodeHome = process.env.MEMORAX_CODE_HOME?.trim() || join(homedir(), ".memorax-code");
const pidPath = join(memoraxCodeHome, "runtime", "backend", "backend.pid.json");
const dshStatePath = join(memoraxCodeHome, "adapters", "dsh", "state.json");

if (!existsSync(pidPath) && !existsSync(dshStatePath)) process.exit(0);

console.warn(`${PREFIX} Stopping the existing managed Backend before postinstall setup...`);
const result = spawnSync(
  process.execPath,
  [memoraxCodeBin, "stop", "--home", memoraxCodeHome, "--clients", "none", "--json"],
  {
    encoding: "utf8",
    env: {
      ...process.env,
      MEMORAX_CODE_HOME: memoraxCodeHome,
      MEMORAX_CODE_PACKAGE_REPLACEMENT: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: PREINSTALL_STOP_TIMEOUT_MS,
    killSignal: "SIGKILL",
  },
);

if (result.status !== 0 || result.error || existsSync(pidPath)) {
  printOutput(result.stdout);
  printOutput(result.stderr);
  const detail = result.error?.code === "ETIMEDOUT"
    ? `memorax-code stop timed out after ${PREINSTALL_STOP_TIMEOUT_MS} ms`
    : result.error?.message
    ?? (existsSync(pidPath)
      ? `managed Backend PID authority still exists at ${pidPath}`
      : `memorax-code stop exited with status ${result.status ?? "unknown"}`);
  console.error(`${PREFIX} Package setup was stopped because the existing Backend could not be retired safely: ${detail}`);
  process.exit(1);
}

console.warn(`${PREFIX} Existing managed Backend stopped; postinstall will start the updated Backend after setup succeeds.`);

function printOutput(output) {
  for (const line of String(output ?? "").split(/\r?\n/)) {
    if (line) console.warn(`${PREFIX} ${line}`);
  }
}
