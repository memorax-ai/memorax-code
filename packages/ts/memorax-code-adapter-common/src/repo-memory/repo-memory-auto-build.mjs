import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export function scheduleMissingRepoMemoryBuild(repo, options = {}) {
  try {
    const repoPath = nonEmptyString(repo);
    const pluginRoot = nonEmptyString(options.pluginRoot);
    if (!repoPath || !pluginRoot) return false;
    if (existsSync(join(repoPath, ".repo_memory", "PROFILE.md"))) return false;

    const jobHookPath = join(pluginRoot, "hooks", "repo-memory-job.mjs");
    if (!existsSync(jobHookPath)) return false;
    const child = spawn(options.nodePath ?? process.execPath, [jobHookPath, "maintain", "--repo", repoPath], {
      cwd: repoPath,
      detached: true,
      env: options.env ?? process.env,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", (error) => debug(options, error));
    child.unref();
    return true;
  } catch (error) {
    debug(options, error);
    return false;
  }
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function debug(options, error) {
  if (process.env[options.debugEnv] === "1") {
    console.error(error instanceof Error ? error.message : String(error));
  }
}
