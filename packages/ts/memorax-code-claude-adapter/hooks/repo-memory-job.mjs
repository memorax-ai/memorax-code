#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveHookClaudeCommand } from "../../memorax-code-adapter-common/src/clients/claude-command.mjs";
import { runRepoMemoryJob } from "../../memorax-code-adapter-common/src/repo-memory/repo-memory-job-supervisor.mjs";
import { evaluateRepository } from "../../memorax-code-adapter-common/src/repo-memory/repo-memory-update-policy-evaluator.mjs";

const hookDir = dirname(fileURLToPath(import.meta.url));
const pluginRoot = dirname(hookDir);

try {
  const payload = runRepoMemoryJob(process.argv.slice(2), {
    runner: "claude",
    finalMessageSource: "stdout",
    memorySkillInvocation: "/memorax-code-claude-adapter:memorax-code",
    validatorPath: resolve(pluginRoot, "skills/memorax-code/scripts/repo-memory.mjs"),
    evaluateRepository,
    createCommand({ prompt }) {
      const claude = resolveHookClaudeCommand({
        pluginRoot: process.env.CLAUDE_PLUGIN_ROOT || pluginRoot,
      });
      return [
        claude,
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
