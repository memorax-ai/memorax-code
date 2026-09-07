import { fileURLToPath } from "node:url";
import { runRepoMemoryJob } from "../../src/repo-memory/repo-memory-job-supervisor.mjs";
import { evaluateRepository } from "../../src/repo-memory/repo-memory-update-policy-evaluator.mjs";

const runnerPath = fileURLToPath(new URL("./repo-memory-job-runner.mjs", import.meta.url));
const validatorPath = fileURLToPath(new URL("./repo-memory-job-validator.mjs", import.meta.url));

// A separate process isolates environment and startup races without a native adapter.
try {
  const payload = runRepoMemoryJob(process.argv.slice(2), {
    runner: "fixture",
    finalMessageSource: "file",
    memorySkillInvocation: "/fixture-memory",
    validatorPath,
    evaluateRepository,
    createCommand({ repo, finalMessagePath }) {
      return [process.execPath, runnerPath, repo, finalMessagePath];
    },
  });
  process.stdout.write(`${JSON.stringify(payload)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
