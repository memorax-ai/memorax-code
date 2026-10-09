#!/usr/bin/env node
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { resolveCommonSourceRoot } from "./common-runtime.mjs";

const hookDir = dirname(fileURLToPath(import.meta.url));
const pluginRoot = dirname(hookDir);
const commonRoot = resolveCommonSourceRoot(pluginRoot);
const { codeBuddyMetadataClient, readCodeBuddyPackageMetadata, resolveHookCodeBuddyCommand } = await import(pathToFileURL(join(commonRoot, "clients", "codebuddy-command.mjs")).href);
const { runRepoMemoryJob } = await import(pathToFileURL(join(commonRoot, "repo-memory", "repo-memory-job-supervisor.mjs")).href);
const { evaluateRepository } = await import(pathToFileURL(join(commonRoot, "repo-memory", "repo-memory-update-policy-evaluator.mjs")).href);

try {
  const metadata = readCodeBuddyPackageMetadata(pluginRoot);
  const client = codeBuddyMetadataClient(metadata) ?? "codebuddy";
  if (metadata?.client !== undefined && metadata.client !== client) throw new Error("invalid CodeBuddy adapter client");
  if (client === "codebuddy") {
    // A nested client must not reuse the foreground client's listening endpoint.
    delete process.env.SERVER__PORT;
    delete process.env.SERVER__HOST;
  }
  if (typeof metadata?.codeBuddyHome === "string" && metadata.codeBuddyHome.trim()) {
    process.env.CODEBUDDY_HOME = metadata.codeBuddyHome;
    process.env.CODEBUDDY_CONFIG_DIR = metadata.codeBuddyHome;
    if (client === "workbuddy") process.env.WORKBUDDY_HOME = metadata.codeBuddyHome;
    else delete process.env.WORKBUDDY_HOME;
  }
  const payload = runRepoMemoryJob(process.argv.slice(2), {
    runner: client,
    finalMessageSource: "stdout",
    memorySkillInvocation: "the `memorax-code` skill",
    validatorPath: resolve(pluginRoot, "skills/memorax-code/scripts/repo-memory.mjs"),
    evaluateRepository,
    createCommand({ prompt }) {
      const codeBuddy = resolveHookCodeBuddyCommand({
        pluginRoot,
        client,
      });
      return [
        codeBuddy,
        // Load this installation's Skill explicitly; the headless worker cannot
        // rely on the GUI's plugin environment or its path format.
        "--plugin-dir",
        pluginRoot,
        "--print",
        "--output-format",
        "text",
        "--dangerously-skip-permissions",
        "--no-session-persistence",
        "--effort",
        "medium",
        prompt,
      ];
    },
  });
  process.stdout.write(`${JSON.stringify(payload)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
