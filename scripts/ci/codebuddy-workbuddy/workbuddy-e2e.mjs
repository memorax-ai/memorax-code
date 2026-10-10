#!/usr/bin/env node
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const usage = "Usage: node scripts/ci/codebuddy-workbuddy/workbuddy-e2e.mjs TARBALL_DIR BUNDLED_COMMAND RUNTIME_VERSION [PREVIOUS_VERSION]";
if (process.argv.length === 3 && ["--help", "-h"].includes(process.argv[2])) {
  console.log(`${usage}\nRuns installation lifecycle, setup interruption, native Memory/Skill, four permission cases and Repo Memory worker checks; excludes the two explicit runtime interrupt diagnostics, valid Repo Memory generation and desktop UI.`);
  process.exit(0);
}
const [tarballDirectory, bundledCommand, version, previousVersion = "0.1.18"] = process.argv.slice(2);
if (![5, 6].includes(process.argv.length) || ![version, previousVersion].every((value) => /^\d+\.\d+\.\d+$/.test(value))) {
  console.error(usage);
  process.exit(1);
}
const windows = process.platform === "win32";
const args = windows
  ? ["-NoProfile", "-File", resolve(repoRoot, "scripts/ci/codebuddy-workbuddy/codebuddy-install-check.ps1"),
    "-TarballDirectory", resolve(tarballDirectory), "-CodeBuddyVersion", version, "-PreviousVersion", previousVersion,
    "-Client", "workbuddy", "-WorkBuddyCommand", resolve(bundledCommand)]
  : [resolve(repoRoot, "scripts/ci/codebuddy-workbuddy/codebuddy-install-check.sh"), resolve(tarballDirectory), version, previousVersion,
    "workbuddy", resolve(bundledCommand)];
const child = spawn(windows ? "pwsh" : "bash", args, { cwd: repoRoot, stdio: "inherit" });
if (!windows) {
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => child.kill(signal));
}
child.once("error", () => { process.exitCode = 1; console.error("Could not start the WorkBuddy functional runner."); });
child.once("exit", (code) => { process.exitCode = code ?? 1; });
