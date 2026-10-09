import { execFile } from "node:child_process";
import { delimiter, dirname } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function backgroundGitPath(currentPath, gitCommand) {
  const paths = currentPath.split(delimiter);
  return [...paths.slice(0, 3), dirname(gitCommand), ...paths.slice(3)].join(delimiter);
}

export async function probeBackgroundGit({ repository, snapshotHead, env }, exec = execFileAsync) {
  const result = { observation: "after_failure", stage: "symbolic-ref", refMatches: null, headMatches: null,
    exitCode: null, systemCode: null, signal: null, timedOut: false };
  for (const [stage, args, field, expected] of [
    ["symbolic-ref", ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], "refMatches", "refs/remotes/origin/main"],
    ["rev-parse", ["rev-parse", "--verify", "refs/remotes/origin/main^{commit}"], "headMatches", snapshotHead],
  ]) {
    result.stage = stage;
    try {
      const { stdout } = await exec("git", args, { cwd: repository, env: { ...env, GIT_NO_LAZY_FETCH: "1" },
        encoding: "utf8", timeout: 2000, killSignal: "SIGKILL", maxBuffer: 128 * 1024, windowsHide: true });
      result.exitCode = 0;
      result[field] = typeof stdout === "string" && stdout.trim() === expected;
      if (!result[field]) break;
    } catch (error) {
      result.exitCode = Number.isSafeInteger(error?.code) && Math.abs(error.code) <= 0xffffffff ? error.code : null;
      result.systemCode = ["ENOENT", "EACCES", "EPERM", "ETIMEDOUT", "ENOBUFS", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"]
        .includes(error?.code) ? error.code : typeof error?.code === "string" ? "other" : null;
      result.signal = ["SIGKILL", "SIGTERM", "SIGINT", "SIGHUP", "SIGABRT"].includes(error?.signal)
        ? error.signal : typeof error?.signal === "string" ? "other" : null;
      result.timedOut = error?.code === "ETIMEDOUT"
        || (error?.killed === true && error?.signal === "SIGKILL" && error?.code == null);
      break;
    }
  }
  return result;
}
