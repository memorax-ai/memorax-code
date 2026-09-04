#!/usr/bin/env node
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { resolveCommonSourceRoot } from "./common-runtime.mjs";

const hookDir = dirname(fileURLToPath(import.meta.url));
const pluginRoot = dirname(hookDir);
const commonRoot = resolveCommonSourceRoot(pluginRoot);
const { resolveHookCodeBuddyCommand } = await import(pathToFileURL(join(commonRoot, "clients", "codebuddy-command.mjs")).href);
const { runRepoMemoryJob } = await import(pathToFileURL(join(commonRoot, "repo-memory", "repo-memory-job-supervisor.mjs")).href);
const { evaluateRepository } = await import(pathToFileURL(join(commonRoot, "repo-memory", "repo-memory-update-policy-evaluator.mjs")).href);

try {
  const payload = runRepoMemoryJob(process.argv.slice(2), {
    runner: "codebuddy",
    finalMessageSource: "stdout",
    memorySkillInvocation: "the `memorax-code` skill",
    validatorPath: resolve(pluginRoot, "skills/memorax-code/scripts/repo-memory.mjs"),
    evaluateRepository,
    createCommand({ prompt }) {
      const codeBuddy = resolveHookCodeBuddyCommand({
        pluginRoot,
      });
      return [
        codeBuddy,
        "--plugin-dir",
        pluginRoot,
        "--print",
        "--output-format",
        "text",
        "--dangerously-skip-permissions",
        "--no-session-persistence",
        prompt,
      ];
    },
  });
  process.stdout.write(`${JSON.stringify(payload)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
