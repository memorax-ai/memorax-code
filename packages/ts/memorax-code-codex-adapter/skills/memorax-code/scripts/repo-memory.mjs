#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const skillDir = process.env.MEMORAX_CODE_REPO_MEMORY_SKILL_DIR
  ? resolve(process.env.MEMORAX_CODE_REPO_MEMORY_SKILL_DIR)
  : dirname(scriptDir);
const pluginRoot = resolve(scriptDir, "../../..");
const directEntrypoint = fileURLToPath(new URL(
  "../../../../memorax-code-backend/dist/repo-memory/cli.js",
  import.meta.url,
));

if (existsSync(directEntrypoint)) {
  const { runRepoMemoryCli } = await import(pathToFileURL(directEntrypoint).href);
  process.exitCode = await runRepoMemoryCli(process.argv.slice(2), { skillDir });
} else {
  const command = memoraxCodeCommand();
  if (!command) {
    process.stderr.write("Repo Memory runtime is unavailable; reinstall or rebuild MemoraX Code.\n");
    process.exit(1);
  }
  const args = ["repo-memory", ...process.argv.slice(2)];
  const result = /\.[cm]?js$/i.test(command)
    ? spawnSync(process.execPath, [command, ...args], { stdio: "inherit", windowsHide: true })
    : spawnSync(command, args, { stdio: "inherit", windowsHide: true });
  if (result.error) {
    process.stderr.write(`Repo Memory runtime failed: ${result.error.message}\n`);
    process.exitCode = 1;
  } else {
    process.exitCode = result.status ?? 1;
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
