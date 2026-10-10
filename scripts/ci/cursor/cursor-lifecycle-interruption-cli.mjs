#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, join } from "node:path";
import { assertProtectedConfiguration, snapshotProtectedConfiguration } from "../codex/codex-lifecycle-assertions.mjs";
import { assertCursorHooks, snapshotCursorHooks } from "./cursor-lifecycle-assertions.mjs";
import { cursorInterruptionPhases, startCursorSetupInterruption } from "./cursor-lifecycle-interruption.mjs";

function check(value, suffix) {
  if (!value) throw new Error(`CURSOR_LIFECYCLE_INTERRUPTION_${suffix}`);
}

let report;
try {
  const [packageRoot, ptyRoot, phase] = process.argv.slice(2);
  const { MEMORAX_CODE_HOME: stateHome, CURSOR_HOME: cursorHome } = process.env;
  check(process.argv.length === 5 && cursorInterruptionPhases.includes(phase)
    && [packageRoot, ptyRoot, stateHome, cursorHome].every((path) => typeof path === "string" && isAbsolute(path)), "ARGUMENTS");
  const { parse } = createRequire(join(packageRoot, "package.json"))("smol-toml");
  const readConfig = async () => parse(await readFile(join(stateHome, "config.toml"), "utf8"));
  const readHooks = async () => JSON.parse(await readFile(join(cursorHome, "hooks.json"), "utf8"));
  const config = await readConfig(), protectedConfig = snapshotProtectedConfiguration(config);
  const protectedHooks = snapshotCursorHooks(await readHooks());
  const result = await startCursorSetupInterruption({ phase, packageRoot, ptyRoot, workspace: process.cwd(),
    env: process.env, key: config.memorax.api_key, async verifyPreserved() {
      assertProtectedConfiguration(await readConfig(), protectedConfig);
      assertCursorHooks(await readHooks(), protectedHooks);
    } }).result;
  const stageEvidence = phase === "before-backend-start"
    ? { kind: "held-native-lifecycle-lock", backendHealthy: false }
    : phase === "saved-account-key-cancel" ? { kind: "native-masked-key-prompt", backendHealthy: false }
    : { kind: "test-preload-pauses-real-installed-cli-child", command: phase === "after-config-write" ? "start" : "status",
      backendHealthy: phase === "after-backend-start" };
  check(result?.stageReached === true && result.completionAbsentAfterInterruption === true
    && result.interruptedSetupFailed === true && result.setupProcessesStopped === true
    && result.stageEvidence?.kind === stageEvidence.kind
    && result.stageEvidence.backendHealthy === stageEvidence.backendHealthy
    && result.stageEvidence.command === stageEvidence.command, "RESULT_INVALID");
  report = { status: "PASS", stageReached: true, stageEvidence, completionAbsentAfterInterruption: true,
    interruptedSetupFailed: true, setupProcessesStopped: true };
} catch (error) {
  const code = error?.testCode ?? error?.message;
  report = { status: "FAIL",
    error: typeof code === "string" && /^(?:CURSOR_LIFECYCLE|PROTECTED|INSTALL|TERMINAL)_[A-Z0-9_]{1,100}$/.test(code)
      ? code : "CURSOR_LIFECYCLE_INTERRUPTION_FAILED_PRIVATE_OUTPUT_SUPPRESSED",
    cleanupFailed: error?.cleanupFailed === true };
}
console.log(JSON.stringify(report));
if (report.status !== "PASS") process.exitCode = 1;
