#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const skillDir = dirname(scriptDir);
const pluginRoot = resolve(scriptDir, "../../..");
const directEntrypoint = [
  "../../../../memorax-code-backend/dist/personal-memory/cli.js",
  "../../../../../../memorax-code-backend/dist/personal-memory/cli.js",
]
  .map((path) => fileURLToPath(new URL(path, import.meta.url)))
  .find((path) => existsSync(path));

if (directEntrypoint) {
  const { runUserProfileCli } = await import(pathToFileURL(directEntrypoint).href);
  process.exitCode = await runUserProfileCli(process.argv.slice(2));
} else {
  const command = memoraxCodeCommand();
  if (!command) {
    process.stderr.write("User Profile runtime is unavailable; reinstall or rebuild MemoraX Code.\n");
    process.exit(1);
  }
  const args = ["user-profile", ...process.argv.slice(2)];
  const nodeEntrypoint = resolveNodeEntrypoint(command);
  const result = nodeEntrypoint
    ? spawnSync(process.execPath, [nodeEntrypoint, ...args], { stdio: "inherit", windowsHide: true })
    : spawnSync(command, args, { stdio: "inherit", windowsHide: true });
  if (result.error) {
    process.stderr.write(`User Profile runtime failed: ${result.error.message}\n`);
    process.exitCode = 1;
  } else {
    process.exitCode = result.status ?? 1;
  }
}

function resolveNodeEntrypoint(command) {
  if (/\.[cm]?js$/i.test(command)) return command;
  try {
    const resolved = realpathSync(command);
    if (/\.[cm]?js$/i.test(resolved)) return resolved;
    const firstLine = readFileSync(resolved, "utf8").split(/\r?\n/, 1)[0];
    return /^#!.*\bnode(?:\s|$)/.test(firstLine) ? resolved : undefined;
  } catch {
    return undefined;
  }
}

function memoraxCodeCommand() {
  for (const root of [skillDir, pluginRoot]) {
    const metadataPath = join(root, ".memorax-code-package.json");
    if (!existsSync(metadataPath)) continue;
    try {
      const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
      if (typeof metadata?.memoraxCodeCommand === "string" && metadata.memoraxCodeCommand.trim()) {
        return metadata.memoraxCodeCommand.trim();
      }
    } catch {
      // Try the package-level metadata next.
    }
  }
  return undefined;
}
