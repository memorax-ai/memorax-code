#!/usr/bin/env node
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runRepoMemoryJob } from "../../memorax-code-adapter-common/src/repo-memory/repo-memory-job-supervisor.mjs";
import { evaluateRepository } from "../../memorax-code-adapter-common/src/repo-memory/repo-memory-update-policy-evaluator.mjs";

const hookDir = dirname(fileURLToPath(import.meta.url));
const pluginRoot = dirname(hookDir);

try {
  const payload = runRepoMemoryJob(process.argv.slice(2), {
    runner: "deepagents",
    finalMessageSource: "stdout",
    memorySkillInvocation: "/skill:memorax-code-deepagents-adapter@memorax-code-deepagents-local:memorax-code",
    validatorPath: resolve(pluginRoot, "skills/memorax-code/scripts/repo-memory.mjs"),
    evaluateRepository,
    createCommand({ prompt }) {
      return [
        resolveDeepAgentsCommand(pluginRoot),
        "-n",
        "--shell-allow-list",
        "all",
        prompt,
      ];
    },
  });
  process.stdout.write(`${JSON.stringify(payload)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

function resolveDeepAgentsCommand(root) {
  const explicit = stringValue(process.env.MEMORAX_CODE_DEEPAGENTS_COMMAND);
  if (explicit) return explicit;
  const metadataCommand = readMetadataCommand(stringValue(process.env.CLAUDE_PLUGIN_ROOT) || root);
  if (metadataCommand && commandPathExists(metadataCommand)) return metadataCommand;
  return "dcode";
}

function readMetadataCommand(pluginRoot) {
  if (!pluginRoot) return undefined;
  const path = join(pluginRoot, ".memorax-code-package.json");
  if (!existsSync(path)) return undefined;
  try {
    return stringValue(JSON.parse(readFileSync(path, "utf8")).deepAgentsCommand);
  } catch {
    return undefined;
  }
}

function commandPathExists(command) {
  if (!command.includes("/") && !command.includes("\\")) return true;
  try {
    accessSync(command, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
