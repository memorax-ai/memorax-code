import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { sharedRepoMemoryPath } from "./repo-memory-shared-bundle.mjs";

export function scheduleMissingRepoMemoryBuild(repo, options = {}) {
  try {
    const repoPath = nonEmptyString(repo);
    const pluginRoot = nonEmptyString(options.pluginRoot);
    if (!repoPath || !pluginRoot) return false;
    const home = resolve(options.env?.MEMORAX_CODE_HOME || process.env.MEMORAX_CODE_HOME || join(homedir(), ".memorax-code"));
    if (existsSync(join(sharedRepoMemoryPath(home, repoPath), "baseline.json"))) return false;

    const jobHookPath = join(pluginRoot, "hooks", "repo-memory-job.mjs");
    if (!existsSync(jobHookPath)) return false;
    // The detached hook changes cwd; preserve the caller's configured state root.
    const env = { ...(options.env ?? process.env) };
    if (env.MEMORAX_CODE_HOME) env.MEMORAX_CODE_HOME = resolve(env.MEMORAX_CODE_HOME);
    const child = spawn(options.nodePath ?? process.execPath, [jobHookPath, "maintain", "--repo", repoPath], {
      cwd: repoPath,
      detached: true,
      env,
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
