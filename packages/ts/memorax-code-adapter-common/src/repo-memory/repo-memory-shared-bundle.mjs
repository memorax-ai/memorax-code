import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { repoKeyForPath } from "./repo-memory-job-marker.mjs";
import { gitHead, profileLocalHead, resolveCommit } from "./repo-memory-job-artifacts.mjs";
import { repoMemoryRepositoryPath } from "./repo-memory-repository.mjs";
import { writePrivateJsonRecord } from "../runtime-record.mjs";

const SCHEMA = "repo_memory_shared_bundle.v2";
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const VERSION = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const GIT_OPTIONS = { timeoutMs: 2000 };

export function sharedRepoMemoryPath(home, repo) {
  return join(home, "repo-memory-bases", repoKeyForPath(repoMemoryRepositoryPath(repo)));
}

// Every worktree resolves the same immutable version through one atomic record.
export function readSharedRepoMemory(home, repo) {
  const root = sharedRepoMemoryPath(home, repo);
  const info = lstatSync(root, { throwIfNoEntry: false });
  if (!info) return undefined;
  if (!info.isDirectory()) throw new Error("invalid shared Repo Memory directory");
  const recordPath = join(root, "baseline.json");
  const recordInfo = lstatSync(recordPath, { throwIfNoEntry: false });
  if (!recordInfo) return undefined;
  if (!recordInfo.isFile()) throw new Error("invalid shared Repo Memory record");
  const record = JSON.parse(readFileSync(recordPath, "utf8"));
  if (![SCHEMA, "repo_memory_shared_bundle.v1"].includes(record.schema)
    || record.repository !== repoMemoryRepositoryPath(repo) || !SHA.test(record.head)
    || (record.publishedAt !== undefined && !Number.isFinite(Date.parse(record.publishedAt)))) {
    throw new Error("invalid shared Repo Memory baseline");
  }
  let path = root;
  if (record.schema === SCHEMA) {
    if (!VERSION.test(record.version) || !lstatSync(join(root, "versions")).isDirectory()) throw new Error("invalid shared Repo Memory version");
    path = join(root, "versions", record.version);
    if (!lstatSync(path).isDirectory()) throw new Error("invalid shared Repo Memory version");
  }
  return { ...record, path };
}

// Resolve local remote-tracking evidence, regardless of the caller's branch or dirt.
export function defaultBranchSnapshot(repo) {
  try {
    const ref = readGit(repo, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]).stdout.trim();
    if (!ref.startsWith("refs/remotes/origin/") || ref === "refs/remotes/origin/HEAD") return undefined;
    const head = readGit(repo, ["rev-parse", "--verify", `${ref}^{commit}`]).stdout.trim();
    return SHA.test(head) ? { ref, branch: ref.slice("refs/remotes/origin/".length), head } : undefined;
  } catch { return undefined; }
}

export function sharedSnapshotRoot(jobPath) {
  return join(dirname(jobPath), "source");
}

// The private local clone keeps the existing collector's Git and output contracts.
// It does not register a worktree or change the source repository's refs/index.
export function prepareSharedRepoMemorySnapshot({ home, repo, snapshot, root, validate }) {
  const baseline = readSharedRepoMemory(home, repo);
  if ((baseline?.head ?? null) !== snapshot.baseHead) throw new Error("shared Repo Memory baseline changed");
  if (baseline && (!validate(baseline.path) || !bundleHeadMatches(repo, baseline.path, baseline.head))) throw new Error("invalid shared Repo Memory baseline");
  const parent = dirname(root);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const emptyConfig = join(parent, "git-config");
  const hooks = join(parent, "git-hooks");
  writeFileSync(emptyConfig, "", { flag: "wx", mode: 0o600 });
  mkdirSync(hooks, { mode: 0o700 });
  const env = { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: emptyConfig };
  const git = (cwd, args) => {
    const result = spawnSync("git", ["-c", "core.longpaths=true", "-c", `core.hooksPath=${hooks}`, ...args], {
      cwd, env, encoding: "utf8", timeout: 60000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024,
    });
    if (result.error || result.status !== 0) throw new Error("could not prepare local Repo Memory snapshot");
    return result.stdout.trim();
  };
  git(parent, ["clone", "--local", "--shared", "--no-hardlinks", "--no-checkout", "--template=", "--", repoMemoryRepositoryPath(repo), root]);
  // Keep later collector and worker Git commands usable in deep Windows job paths.
  git(root, ["config", "core.longpaths", "true"]);
  git(root, ["checkout", "--detach", snapshot.head]);
  const origin = readGit(repo, ["config", "--get", "remote.origin.url"], true);
  if (origin.status === 0 && origin.stdout.trim()) git(root, ["config", "remote.origin.url", origin.stdout.trim()]);
  else git(root, ["remote", "remove", "origin"]);
  // Preserve native repository identity while preventing checkout hooks in this copy.
  git(root, ["config", "core.hooksPath", hooks]);
  rmSync(join(root, ".repo_memory"), { recursive: true, force: true });
  if (baseline) copyBundle(join(baseline.path, ".repo_memory"), join(root, ".repo_memory"));
  if (gitHead(root, GIT_OPTIONS) !== snapshot.head) throw new Error("Repo Memory snapshot changed");
}

export function sharedRepoMemorySnapshotMatches(repo, snapshot, root) {
  const current = defaultBranchSnapshot(repo);
  return Boolean(current && current.ref === snapshot.ref
    && readGit(repo, ["merge-base", "--is-ancestor", snapshot.head, current.head], true).status === 0
    && gitHead(root, GIT_OPTIONS) === snapshot.head && shareableRepoMemoryWorktree(root));
}

// Called while the job owns the repository marker (and the native finalizer lock).
export function publishSharedRepoMemorySnapshot({ home, repo, snapshot, root, validate }) {
  const matches = () => sharedRepoMemorySnapshotMatches(repo, snapshot, root)
    && (readSharedRepoMemory(home, repo)?.head ?? null) === snapshot.baseHead;
  if (!matches() || !validate(root) || !bundleHeadMatches(repo, root, snapshot.head)) return false;
  const destination = sharedRepoMemoryPath(home, repo);
  const versions = join(destination, "versions");
  mkdirSync(versions, { recursive: true, mode: 0o700 });
  if (!lstatSync(versions).isDirectory()) throw new Error("invalid shared Repo Memory versions");
  const version = randomUUID();
  const stage = join(versions, `${version}.tmp`);
  try {
    copyBundle(join(root, ".repo_memory"), join(stage, ".repo_memory"));
    if (!validate(stage) || !bundleHeadMatches(repo, stage, snapshot.head) || !matches()) return false;
    renameSync(stage, join(versions, version));
    writePrivateJsonRecord(join(destination, "baseline.json"), {
      schema: SCHEMA, repository: repoMemoryRepositoryPath(repo), head: snapshot.head,
      ref: snapshot.ref, publishedAt: new Date().toISOString(), version,
    }, { durableBoundary: home });
    return true;
  } finally { rmSync(stage, { recursive: true, force: true }); }
}

export function bundleHeadMatches(repo, root, head) {
  const value = profileLocalHead(join(root, ".repo_memory", "PROFILE.md"));
  return Boolean(value && (value === head || resolveCommit(repo, value, GIT_OPTIONS) === head));
}

function copyBundle(source, target, top = true) {
  if (!lstatSync(source).isDirectory()) throw new Error("Repo Memory bundle must be a regular directory");
  mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (top && ["procedure-memory", "user-profile", "shared-baseline.json"].includes(entry.name)) continue;
    const from = join(source, entry.name), to = join(target, entry.name);
    if (entry.isDirectory()) copyBundle(from, to, false);
    else if (entry.isFile()) writeFileSync(to, readFileSync(from), { mode: 0o600 });
    else throw new Error("Repo Memory sharing does not follow symbolic links");
  }
}

// Only the private authoring snapshot must stay clean; user worktrees may be dirty.
export function shareableRepoMemoryWorktree(repo) {
  const paths = ["--", ".", ":(exclude).repo_memory"];
  const tracked = readGit(repo, ["diff", "--name-only", "-z", "HEAD", ...paths]);
  const untracked = readGit(repo, ["ls-files", "--others", "--exclude-standard", "-z", ...paths]);
  const changes = [...new Set((tracked.stdout + untracked.stdout).split("\0").filter(Boolean))];
  if (changes.length === 0) return true;
  if (changes.length !== 1 || changes[0] !== ".gitignore" || !existsSync(join(repo, ".gitignore"))) return false;
  if (!lstatSync(join(repo, ".gitignore")).isFile()) return false;
  const before = readGit(repo, ["show", "HEAD:.gitignore"], true);
  const withoutMemory = (text) => text.split(/\r?\n/).filter(line => line !== ".repo_memory/" && line !== "/.repo_memory/").join("\n").trimEnd();
  return withoutMemory(readFileSync(join(repo, ".gitignore"), "utf8")) === withoutMemory(before.status === 0 ? before.stdout : "");
}

export function sharedRepoMemoryAttemptCoolingDown({ home, repo, baseHead, cooldownHours, nowMs = Date.now() }) {
  const path = join(sharedRepoMemoryPath(home, repo), "update-attempt.json");
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (!info) return false;
  if (!info.isFile()) throw new Error("invalid shared Repo Memory attempt");
  const attempt = JSON.parse(readFileSync(path, "utf8"));
  if (attempt.schema !== "repo_memory_shared_attempt.v1" || !Number.isFinite(Date.parse(attempt.startedAt))) throw new Error("invalid shared Repo Memory attempt");
  return attempt.baseHead === baseHead && nowMs - Date.parse(attempt.startedAt) < cooldownHours * 3600000;
}

export function recordSharedRepoMemoryAttempt({ home, repo, snapshot, nowMs = Date.now() }) {
  writePrivateJsonRecord(join(sharedRepoMemoryPath(home, repo), "update-attempt.json"), {
    schema: "repo_memory_shared_attempt.v1", baseHead: snapshot.baseHead, head: snapshot.head, startedAt: new Date(nowMs).toISOString(),
  }, { durableBoundary: home });
}

function readGit(repo, args, allowFailure = false) {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8", timeout: 2000, killSignal: "SIGKILL", maxBuffer: 128 * 1024,
    env: { ...process.env, GIT_NO_LAZY_FETCH: "1" } });
  if (result.error || (result.status !== 0 && !allowFailure)) throw new Error("Repo Memory Git evidence unavailable");
  return result;
}
