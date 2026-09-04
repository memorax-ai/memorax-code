#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveHookCodexCommand } from "../../memorax-code-adapter-common/src/clients/codex-command.mjs";
import { runRepoMemoryJob } from "../../memorax-code-adapter-common/src/repo-memory/repo-memory-job-supervisor.mjs";
import { evaluateRepository } from "../../memorax-code-adapter-common/src/repo-memory/repo-memory-update-policy-evaluator.mjs";

const hookDir = dirname(fileURLToPath(import.meta.url));
const pluginRoot = dirname(hookDir);

try {
  const payload = runRepoMemoryJob(process.argv.slice(2), {
    runner: "codex",
    finalMessageSource: "file",
    validatorPath: resolve(pluginRoot, "skills/memorax-code/scripts/repo-memory.mjs"),
    evaluateRepository,
    createCommand({ finalMessagePath, prompt, repo }) {
      const codex = resolveHookCodexCommand({
        pluginRoot: process.env.PLUGIN_ROOT || pluginRoot,
      });
      return [
        codex,
        "exec",
        "--cd",
        repo,
        "--sandbox",
        "danger-full-access",
        "--output-last-message",
        finalMessagePath,
        prompt,
      ];
    },
  });
  process.stdout.write(`${JSON.stringify(payload)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
