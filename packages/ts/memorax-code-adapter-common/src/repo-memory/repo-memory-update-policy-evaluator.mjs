import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  evaluateRepoMemoryUpdatePolicy,
  parseRepoMemoryUpdatePolicyConfig,
} from "./repo-memory-update-policy.mjs";

export function runRepoMemoryUpdatePolicy(args) {
  return evaluateRepository(parseArgs(args));
}

export function evaluateRepository(input) {
  const repo = repositoryRoot(input.repo);
  const profilePath = input.profilePath || join(repo, ".repo_memory", "PROFILE.md");
  if (!existsSync(profilePath)) {
    throw new Error(`repo memory update policy requires .repo_memory/PROFILE.md: ${repo}`);
  }

  const profileStat = statSync(profilePath);
  if (!profileStat.isFile()) throw new Error(`repo memory profile is not a regular file: ${profilePath}`);
  const profile = parseFrontmatter(readFileSync(profilePath, "utf8"));
  const head = git(repo, ["rev-parse", "HEAD"]);
  const baseline = stringValue(profile.local_head);
  const baselineState = inspectBaseline(repo, baseline, head);
  const lastUpdate = Number.isFinite(input.lastUpdatedAtMs)
    ? { atMs: input.lastUpdatedAtMs, source: "shared.publishedAt" }
    : profileUpdateTime(profile, profileStat.mtimeMs);
  const config = resolvedConfig(input);
  const pullRequestDetected = baselineState.status === "ancestor" && baselineState.commitsBehind > 0
    ? pendingRangeContainsPullRequest(repo, baseline, head)
    : false;
  const decision = evaluateRepoMemoryUpdatePolicy({
    ...config,
    baselineStatus: baselineState.status,
    commitsBehind: baselineState.commitsBehind,
    pullRequestDetected,
    lastUpdatedAtMs: lastUpdate.atMs,
    nowMs: input.nowMs,
  });

  return {
    schema: "repo_memory_update_policy_decision.v1",
    ok: true,
    trigger: decision.trigger,
    reason: decision.reason,
    policy: decision.policy,
    policySource: decision.policySource,
    commitThreshold: decision.commitThreshold,
    cooldownHours: decision.cooldownHours,
    commitsBehind: decision.commitsBehind,
    pullRequestDetected: decision.pullRequestDetected,
    baselineStatus: decision.baselineStatus,
    ageHours: round(decision.ageHours),
    lastUpdateSource: lastUpdate.source,
    baseline,
    head,
  };
}

function resolvedConfig(input) {
  const memoraxCodeHome = process.env.MEMORAX_CODE_HOME || join(homedir(), ".memorax-code");
  const configPath = input.configPath || join(memoraxCodeHome, "config.toml");
  const fileConfig = existsSync(configPath)
    ? parseRepoMemoryUpdatePolicyConfig(readFileSync(configPath, "utf8"))
    : {};
  return {
    policy: stringValue(process.env.MEMORAX_CODE_REPO_MEMORY_UPDATE_POLICY) ?? fileConfig.policy,
    commitThreshold: process.env.MEMORAX_CODE_REPO_MEMORY_STALE_COMMIT_THRESHOLD
      ?? fileConfig.commitThreshold,
    cooldownHours: process.env.MEMORAX_CODE_REPO_MEMORY_UPDATE_COOLDOWN_HOURS
      ?? fileConfig.cooldownHours,
  };
}

function inspectBaseline(repo, baseline, head) {
  if (!baseline) return { status: "missing", commitsBehind: Number.MAX_SAFE_INTEGER };
  if (gitMaybe(repo, ["rev-parse", "--verify", `${baseline}^{commit}`]) === undefined) {
    return { status: "not_ancestor", commitsBehind: Number.MAX_SAFE_INTEGER };
  }
  if (!gitSuccess(repo, ["merge-base", "--is-ancestor", baseline, head])) {
    return { status: "not_ancestor", commitsBehind: Number.MAX_SAFE_INTEGER };
  }
  const count = Number(git(repo, ["rev-list", "--count", `${baseline}..${head}`]));
  return {
    status: "ancestor",
    commitsBehind: Number.isInteger(count) && count >= 0 ? count : Number.MAX_SAFE_INTEGER,
  };
}

function pendingRangeContainsPullRequest(repo, baseline, head) {
  const messages = gitMaybe(repo, ["log", "--format=%s%n%b%x00", `${baseline}..${head}`]) || "";
  return messages.split("\x00").some((message) => (
    /\(#\d+\)\s*$/m.test(message)
    || /^Merge pull request #\d+\b/m.test(message)
    || /See merge request .+!\d+\b/m.test(message)
  ));
}

function profileUpdateTime(profile, mtimeMs) {
  for (const field of ["generated_at", "updated_at", "last_updated_at"]) {
    const raw = stringValue(profile[field]);
    const atMs = Date.parse(raw || "");
    if (Number.isFinite(atMs)) return { atMs, source: `profile.${field}` };
  }
  return { atMs: mtimeMs, source: "profile.mtime" };
}

function parseFrontmatter(text) {
  const match = String(text).match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return {};
  const result = {};
  for (const rawLine of match[1].split(/\r?\n/)) {
    const field = rawLine.match(/^([A-Za-z0-9_]+)\s*:\s*(.*?)\s*$/);
    if (!field) continue;
    result[field[1]] = field[2].replace(/^['"]|['"]$/g, "");
  }
  return result;
}

function repositoryRoot(path) {
  const candidate = realpathSync(resolve(path));
  const root = git(candidate, ["rev-parse", "--show-toplevel"]);
  return realpathSync(root);
}

function git(repo, args) {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
  }).trim();
}

function gitMaybe(repo, args) {
  try {
    return git(repo, args);
  } catch {
    return undefined;
  }
}

function gitSuccess(repo, args) {
  try {
    execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "ignore", "ignore"],
      env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
    });
    return true;
  } catch {
    return false;
  }
}

function parseArgs(args) {
  if (args[0] !== "evaluate") {
    throw new Error("usage: repo-memory-update-policy.mjs evaluate --repo PATH [--now ISO8601] [--config PATH]");
  }
  const input = {};
  for (let index = 1; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--repo") input.repo = requiredValue(args, ++index, value);
    else if (value === "--now") {
      input.nowMs = Date.parse(requiredValue(args, ++index, value));
      if (!Number.isFinite(input.nowMs)) throw new Error("--now must be ISO8601");
    } else if (value === "--config") input.configPath = resolve(requiredValue(args, ++index, value));
    else throw new Error(`unknown argument: ${value}`);
  }
  if (!input.repo) throw new Error("--repo is required");
  return input;
}

function requiredValue(values, index, flag) {
  const value = values[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function round(value) {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : undefined;
}
