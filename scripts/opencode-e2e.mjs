#!/usr/bin/env node
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [tarballDirectory = resolve(repoRoot, "dist/npm/tarballs"), version = "1.18.18"] = process.argv.slice(2);
if (process.argv.length > 4 || !/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error("Usage: node scripts/opencode-e2e.mjs [TARBALL_DIR] [OPENCODE_VERSION]");
}
const windows = process.platform === "win32";
const command = windows ? "pwsh" : "bash";
const args = windows
  ? ["-NoProfile", "-File", resolve(repoRoot, "scripts/opencode-install-check.ps1"),
    "-TarballDirectory", resolve(tarballDirectory), "-OpenCodeVersion", version]
  : [resolve(repoRoot, "scripts/opencode-install-check.sh"), resolve(tarballDirectory), version];
const child = spawn(command, args, { cwd: repoRoot, stdio: "inherit" });
if (!windows) {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => child.kill(signal));
  }
}
child.once("error", () => { process.exitCode = 1; console.error("Could not start the OpenCode functional runner."); });
child.once("exit", (code) => { process.exitCode = code ?? 1; });
