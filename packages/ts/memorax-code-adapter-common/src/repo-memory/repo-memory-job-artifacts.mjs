import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { stringOption } from "../config-utils.mjs";

export function profileLocalHead(path) {
  try {
    const text = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
    const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
    if (!match) return undefined;
    const line = match[1].split(/\r?\n/).find((entry) => /^local_head\s*:/.test(entry.trim()));
    return stringOption(line?.replace(/^\s*local_head\s*:\s*/, "").trim().replace(/^['"]|['"]$/g, ""));
  } catch {
    return undefined;
  }
}

export function resolveCommit(repo, ref, options = {}) {
  const result = spawnSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
    ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs, killSignal: "SIGKILL" }),
  });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

export function gitHead(repo, options = {}) {
  const head = resolveCommit(repo, "HEAD", options);
  if (!head) throw new Error(`git could not resolve HEAD in ${repo}`);
  return head;
}
