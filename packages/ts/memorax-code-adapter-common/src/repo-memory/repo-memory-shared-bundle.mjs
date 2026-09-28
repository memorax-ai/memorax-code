import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { repoKeyForPath } from "./repo-memory-job-marker.mjs";
import { gitHead, profileLocalHead, resolveCommit } from "./repo-memory-job-artifacts.mjs";
import { repoMemoryRepositoryPath } from "./repo-memory-repository.mjs";

const SCHEMA = "repo_memory_shared_bundle.v1";
const BORROWED_SCHEMA = "repo_memory_borrowed_baseline.v1";
const BORROWED_FILE = "shared-baseline.json";
const GIT_OPTIONS = { timeoutMs: 2000 };
const MAX_DELTA_FILES = 20;
const MAX_DELTA_LINES = 1000;
const STRUCTURAL_FILES = /^(?:AGENTS\.md|ARCHITECTURE\.md|package\.json|package-lock\.json|yarn\.lock|pnpm-(?:lock\.yaml|workspace\.yaml)|Cargo\.(?:toml|lock)|go\.(?:mod|sum|work)|pyproject\.toml|poetry\.lock|uv\.lock|requirements[^/]*\.txt|Pipfile(?:\.lock)?|pom\.xml|(?:settings|build)\.gradle(?:\.kts)?|Makefile|CMakeLists\.txt|Dockerfile|\.gitmodules|tsconfig[^/]*\.json)$/i;

export function sharedRepoMemoryPath(home, repo) {
  return join(home, "repo-memory-bases", repoKeyForPath(repoMemoryRepositoryPath(repo)));
}

export function readSharedRepoMemory(home, repo) {
  const path = sharedRepoMemoryPath(home, repo);
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (!info) return undefined;
  if (!info.isDirectory() || !lstatSync(join(path, "baseline.json")).isFile()) {
    throw new Error("shared Repo Memory must use regular local files");
  }
  const record = JSON.parse(readFileSync(join(path, "baseline.json"), "utf8"));
  if (record.schema !== SCHEMA || record.repository !== repoMemoryRepositoryPath(repo)
    || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(record.head)) {
    throw new Error("invalid shared Repo Memory baseline");
  }
  return { ...record, path };
}

// Generated memory and the collector's ignore entry are not source changes.
export function shareableRepoMemoryWorktree(repo, stagingName) {
  const paths = ["--", ".", ":(exclude).repo_memory", ...(stagingName ? [`:(exclude)${stagingName}`] : [])];
  const options = { cwd: repo, encoding: "utf8", timeout: 2000, killSignal: "SIGKILL" };
  const tracked = spawnSync("git", ["diff", "--name-only", "-z", "HEAD", ...paths], options);
  if (tracked.error || tracked.status !== 0) throw new Error(`repo memory jobs require a readable git HEAD: ${repo}`);
  const untracked = spawnSync("git", ["ls-files", "--others", "--exclude-standard", "-z", ...paths], options);
  if (untracked.error || untracked.status !== 0) throw new Error(`repo memory jobs require a readable git HEAD: ${repo}`);
  const changes = [...new Set((tracked.stdout + untracked.stdout).split("\0").filter(Boolean))];
  if (changes.length === 0) return true;
  if (changes.length !== 1 || changes[0] !== ".gitignore" || !existsSync(join(repo, ".gitignore"))) return false;
  const path = join(repo, ".gitignore");
  if (!lstatSync(path).isFile()) return false;
  const before = spawnSync("git", ["show", "HEAD:.gitignore"], options);
  if (tracked.stdout && before.status !== 0) return false;
  const withoutMemory = (text) => text.split(/\r?\n/).filter(line => line !== ".repo_memory/" && line !== "/.repo_memory/").join("\n").trimEnd();
  return withoutMemory(readFileSync(path, "utf8")) === withoutMemory(before.status === 0 ? before.stdout : "");
}

// Call after canonical validation, while the job still owns its repository marker.
// The first valid committed snapshot wins; updates never replace this baseline.
export function publishSharedRepoMemory({ home, repo, head, shareable, validate }) {
  const destination = sharedRepoMemoryPath(home, repo);
  if (lstatSync(destination, { throwIfNoEntry: false })) return false;
  if (!shareable || !shareableRepoMemoryWorktree(repo) || gitHead(repo, GIT_OPTIONS) !== head) return false;
  const value = profileLocalHead(join(repo, ".repo_memory", "PROFILE.md"));
  if (!value || resolveCommit(repo, value, GIT_OPTIONS) !== head) return false;
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  const stage = `${destination}.${randomUUID()}.tmp`;
  try {
    copyBundle(join(repo, ".repo_memory"), join(stage, ".repo_memory"));
    if (!validate(stage) || !bundleHeadMatches(repo, stage, head)) return false;
    writeFileSync(join(stage, "baseline.json"), JSON.stringify({ schema: SCHEMA, repository: repoMemoryRepositoryPath(repo), head }), { mode: 0o600 });
    if (!shareableRepoMemoryWorktree(repo) || gitHead(repo, GIT_OPTIONS) !== head) return false;
    renameSync(stage, destination);
    return true;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

export function restoreSharedRepoMemory({ baseline, repo, validate, dryRun = false }) {
  const sharedBaseline = inspectSharedDelta(repo, baseline.head);
  if (sharedBaseline.reason) return sharedBaseline;
  const result = (reason) => ({ reason, sharedBaseline });
  if (!shareableRepoMemoryWorktree(repo)) return result("worktree_dirty");
  if (!lstatSync(join(baseline.path, ".repo_memory")).isDirectory()) return result("shared_bundle_invalid");
  const sourceValidation = validate(baseline.path);
  if (sourceValidation.status === "unknown") return result("shared_bundle_unavailable");
  if (sourceValidation.status !== "usable"
    || resolveCommit(repo, profileLocalHead(join(baseline.path, ".repo_memory", "PROFILE.md")) || "", GIT_OPTIONS) !== baseline.head) {
    return result("shared_bundle_invalid");
  }
  const target = join(repo, ".repo_memory");
  if (lstatSync(target, { throwIfNoEntry: false })) return result("local_bundle_exists");
  const reason = sharedBaseline.head === baseline.head ? "shared_bundle_reused" : "shared_bundle_borrowed";
  if (dryRun) return result(reason);
  const stagingName = `.repo-memory-reuse-${randomUUID()}`;
  const stage = join(repo, stagingName);
  try {
    copyBundle(join(baseline.path, ".repo_memory"), join(stage, ".repo_memory"));
    const stagedValidation = validate(stage);
    if (stagedValidation.status === "unknown") return result("shared_bundle_unavailable");
    if (stagedValidation.status !== "usable" || !bundleHeadMatches(repo, stage, baseline.head)) return result("shared_bundle_invalid");
    writeFileSync(join(stage, ".repo_memory", BORROWED_FILE), JSON.stringify({
      schema: BORROWED_SCHEMA, repository: baseline.repository, head: baseline.head,
    }), { mode: 0o600 });
    if (gitHead(repo, GIT_OPTIONS) !== sharedBaseline.head) return result("shared_snapshot_mismatch");
    if (!shareableRepoMemoryWorktree(repo, stagingName)) return result("worktree_dirty");
    if (lstatSync(target, { throwIfNoEntry: false })) return result("local_bundle_exists");
    const ignorePath = join(repo, ".gitignore");
    const ignoreInfo = lstatSync(ignorePath, { throwIfNoEntry: false });
    if (ignoreInfo && !ignoreInfo.isFile()) return result("worktree_dirty");
    const ignore = ignoreInfo ? readFileSync(ignorePath, "utf8") : "";
    if (!/^\/?\.repo_memory\/?\r?$/m.test(ignore)) {
      appendFileSync(ignorePath, `${ignore && !ignore.endsWith("\n") ? "\n" : ""}.repo_memory/\n`);
    }
    renameSync(join(stage, ".repo_memory"), target);
    return result(reason);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

// A restored copy stays borrowed as its branch advances; elapsed time and
// commit count must not turn a cheap read into another per-worktree Agent job.
export function inspectBorrowedRepoMemory({ repo, validate }) {
  const path = join(repo, ".repo_memory", BORROWED_FILE);
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (!info) return undefined;
  if (!info.isFile() || !lstatSync(join(repo, ".repo_memory")).isDirectory()) throw new Error("invalid borrowed Repo Memory record");
  const record = JSON.parse(readFileSync(path, "utf8"));
  if (record.schema !== BORROWED_SCHEMA || record.repository !== repoMemoryRepositoryPath(repo)
    || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(record.head)) throw new Error("invalid borrowed Repo Memory record");
  const validation = validate(repo);
  if (validation.status === "unknown") return { reason: "shared_bundle_unavailable" };
  if (validation.status !== "usable") return { reason: "shared_bundle_invalid" };
  const profileHead = resolveCommit(repo, profileLocalHead(join(repo, ".repo_memory", "PROFILE.md")) || "", GIT_OPTIONS);
  if (profileHead !== record.head) return { reason: "shared_bundle_invalid" };
  const sharedBaseline = inspectSharedDelta(repo, record.head);
  if (sharedBaseline.reason) return sharedBaseline;
  if (!shareableRepoMemoryWorktree(repo)) return { reason: "worktree_dirty" };
  if (gitHead(repo, GIT_OPTIONS) !== sharedBaseline.head) return { reason: "shared_snapshot_mismatch" };
  return { reason: "shared_baseline_in_use", sharedBaseline };
}

export function clearBorrowedRepoMemory(repo) {
  rmSync(join(repo, ".repo_memory", BORROWED_FILE), { force: true });
}

function inspectSharedDelta(repo, baseHead) {
  const head = gitHead(repo, GIT_OPTIONS);
  const sharedBaseline = { baseHead, head, changes: [], changedLines: 0 };
  if (head === baseHead) return sharedBaseline;
  const ancestry = readGit(repo, ["merge-base", "--is-ancestor", baseHead, head], true);
  if (ancestry.status === 1) return { reason: "shared_snapshot_mismatch" };
  const args = ["--no-ext-diff", "--no-textconv", "--no-renames", "--ignore-submodules=none", baseHead, head, "--", ".", ":(exclude).repo_memory"];
  const raw = readGit(repo, ["diff", "--raw", "-z", ...args]).stdout.split("\0").filter(Boolean);
  if (raw.length / 2 > MAX_DELTA_FILES) return { reason: "shared_delta_too_large" };
  for (let index = 0; index < raw.length; index += 2) {
    const match = /^:(\d{6}) (\d{6}) [a-f0-9]+ [a-f0-9]+ ([A-Z])$/.exec(raw[index]);
    const path = raw[index + 1];
    if (!match || !path) throw new Error("invalid Repo Memory Git delta");
    const [, before, after, status] = match;
    if (!["A", "M"].includes(status) || !/^100(?:644|755)$/.test(after)
      || (status === "M" && before !== after) || STRUCTURAL_FILES.test(basename(path))) {
      return { reason: "shared_delta_incompatible" };
    }
    sharedBaseline.changes.push({ status, path });
  }
  const stats = readGit(repo, ["diff", "--numstat", "-z", ...args]).stdout.split("\0").filter(Boolean);
  for (const entry of stats) {
    const match = /^(\d+)\t(\d+)\t/.exec(entry);
    if (!match) return { reason: "shared_delta_incompatible" };
    sharedBaseline.changedLines += Number(match[1]) + Number(match[2]);
  }
  if (sharedBaseline.changedLines > MAX_DELTA_LINES) return { reason: "shared_delta_too_large" };
  return sharedBaseline;
}

function readGit(repo, args, allowNotAncestor = false) {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8", timeout: 2000, killSignal: "SIGKILL", maxBuffer: 128 * 1024 });
  if (result.error || (result.status !== 0 && !(allowNotAncestor && result.status === 1))) throw new Error("Repo Memory Git delta unavailable");
  return result;
}

function bundleHeadMatches(repo, root, head) {
  const value = profileLocalHead(join(root, ".repo_memory", "PROFILE.md"));
  return Boolean(value && resolveCommit(repo, value, GIT_OPTIONS) === head);
}

function copyBundle(source, target, top = true) {
  if (!lstatSync(source).isDirectory()) throw new Error("Repo Memory bundle must be a regular directory");
  mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (top && ["procedure-memory", "user-profile", BORROWED_FILE].includes(entry.name)) continue;
    const from = join(source, entry.name), to = join(target, entry.name);
    if (entry.isDirectory()) copyBundle(from, to, false);
    else if (entry.isFile()) writeFileSync(to, readFileSync(from), { mode: 0o600 });
    else throw new Error("Repo Memory sharing does not follow symbolic links");
  }
}
