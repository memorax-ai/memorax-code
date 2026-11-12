import { existsSync } from "node:fs";
import { join } from "node:path";

export function resolveCommonSourceRoot(pluginRoot) {
  const candidates = [
    join(pluginRoot, "memorax-code-adapter-common", "src"),
    join(pluginRoot, "..", "memorax-code-adapter-common", "src"),
    join(pluginRoot, "..", "..", "memorax-code-adapter-common", "src"),
  ];
  const root = candidates.find((candidate) => existsSync(join(candidate, "repo-memory", "repo-memory-job-supervisor.mjs")));
  if (!root) throw new Error(`MemoraX Code shared runtime is unavailable for CodeBuddy plugin: ${pluginRoot}`);
  return root;
}
