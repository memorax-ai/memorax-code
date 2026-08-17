#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runRepoMemoryJob } from "../../memorax-code-adapter-common/src/repo-memory/repo-memory-job-supervisor.mjs";
import { evaluateRepository } from "../../memorax-code-adapter-common/src/repo-memory/repo-memory-update-policy-evaluator.mjs";

const hookDir = dirname(fileURLToPath(import.meta.url));
const adapterRoot = dirname(hookDir);
const packagedValidator = resolve(adapterRoot, "skills/memorax-code/scripts/validate_memory.py");
const validatorPath = existsSync(packagedValidator)
  ? packagedValidator
  : resolve(adapterRoot, "../memorax-code-codex-adapter/skills/memorax-code/scripts/validate_memory.py");

try {
  const payload = runRepoMemoryJob(process.argv.slice(2), {
    runner: "opencode",
    finalMessageSource: "stdout",
    memorySkillInvocation: "the `memorax-code` skill",
    validatorPath,
    evaluateRepository,
    createCommand({ prompt, repo }) {
      return [
        process.execPath,
        resolve(adapterRoot, "src/repo-memory-server-runner.mjs"),
        "--repo",
        repo,
        "--prompt",
        prompt,
      ];
    },
  });
  process.stdout.write(`${JSON.stringify(payload)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
