#!/usr/bin/env node
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const usage = "Usage: node scripts/codebuddy-e2e.mjs [TARBALL_DIR] [CODEBUDDY_VERSION] [PREVIOUS_VERSION]";
if (process.argv.length === 3 && ["--help", "-h"].includes(process.argv[2])) {
  console.log(`${usage}\nDefaults: dist/npm/tarballs, CodeBuddy Code 2.159.0, previous package 0.1.18.`);
  process.exit(0);
}
const [tarballDirectory = resolve(repoRoot, "dist/npm/tarballs"), version = "2.159.0",
  previousVersion = "0.1.18"] = process.argv.slice(2);
if (process.argv.length > 5 || ![version, previousVersion].every((value) => /^\d+\.\d+\.\d+$/.test(value))) throw new Error(usage);
const windows = process.platform === "win32";
const command = windows ? "pwsh" : "bash";
const args = windows
  ? ["-NoProfile", "-File", resolve(repoRoot, "scripts/codebuddy-install-check.ps1"),
    "-TarballDirectory", resolve(tarballDirectory), "-CodeBuddyVersion", version, "-PreviousVersion", previousVersion]
  : [resolve(repoRoot, "scripts/codebuddy-install-check.sh"), resolve(tarballDirectory), version, previousVersion];
const child = spawn(command, args, { cwd: repoRoot, stdio: "inherit" });
if (!windows) {
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => child.kill(signal));
}
child.once("error", () => { process.exitCode = 1; console.error("Could not start the CodeBuddy functional runner."); });
child.once("exit", (code) => { process.exitCode = code ?? 1; });
