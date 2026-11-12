import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { bundleHeadMatches, readSharedRepoMemory } from "../../../memorax-code-adapter-common/src/repo-memory/repo-memory-shared-bundle.mjs";
import { canonicalPath, type CommandOutput } from "./shared.js";
import { executeValidate } from "./validate.js";

export function executeResolve(args: string[]): CommandOutput {
  if (args.length !== 2 || args[0] !== "--repo-path" || !args[1]) {
    return { exitCode: 2, stdout: "", stderr: "Usage: memorax-code repo-memory resolve --repo-path PATH\n" };
  }
  try {
    const repo = canonicalPath(args[1]);
    const home = resolve(process.env.MEMORAX_CODE_HOME || join(homedir(), ".memorax-code"));
    const baseline = readSharedRepoMemory(home, repo);
    const root = baseline?.path || repo;
    const validation = executeValidate([root]);
    if (validation.exitCode !== 0 || (baseline && !bundleHeadMatches(repo, root, baseline.head))) {
      return output({ ok: false, reason: baseline ? "shared_bundle_invalid" : "bundle_unavailable" });
    }
    return output({ ok: true, reason: baseline ? "shared_baseline_in_use" : "local_bundle_in_use",
      memoryPath: join(root, ".repo_memory"), sharedBaseline: baseline ? { head: baseline.head, publishedAt: baseline.publishedAt } : undefined });
  } catch {
    return output({ ok: false, reason: "shared_bundle_unavailable" });
  }
}

function output(value: Record<string, unknown>): CommandOutput {
  return { exitCode: 0, stdout: `${JSON.stringify(value)}\n`, stderr: "" };
}
