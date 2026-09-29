import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { repoKeyForPath } from "./repo-memory-job-marker.mjs";
import { gitHead, profileLocalHead, resolveCommit } from "./repo-memory-job-artifacts.mjs";
import { repoMemoryRepositoryPath } from "./repo-memory-repository.mjs";
import { writePrivateJsonRecord } from "../runtime-record.mjs";

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
  const initial = readBaseline(path, repo);
  if (!initial) return undefined;
  const versions = join(path, "versions");
  const info = lstatSync(versions, { throwIfNoEntry: false });
  if (!info) return initial;
  if (!info.isDirectory()) throw new Error("invalid shared Repo Memory versions");
  let selected = initial;
  let distance = ancestorDistance(repo, initial.head);
  for (const entry of readdirSync(versions, { withFileTypes: true })) {
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(entry.name)) continue;
    if (!entry.isDirectory()) throw new Error("invalid shared Repo Memory version");
    const version = readBaseline(join(versions, entry.name), repo);
    if (!version || version.head !== entry.name) throw new Error("invalid shared Repo Memory version");
    const next = ancestorDistance(repo, version.head);
    if (next < distance) { selected = version; distance = next; }
  }
  return selected;
}

function ancestorDistance(repo, head) {
  if (readGit(repo, ["merge-base", "--is-ancestor", head, "HEAD"], true).status === 1) return Infinity;
  return Number(readGit(repo, ["rev-list", "--count", `${head}..HEAD`]).stdout.trim());
}

function readBaseline(path, repo) {
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (!info) return undefined;
  if (!info.isDirectory() || !lstatSync(join(path, "baseline.json")).isFile()) {
    throw new Error("shared Repo Memory must use regular local files");
  }
  const record = JSON.parse(readFileSync(join(path, "baseline.json"), "utf8"));
  if (record.schema !== SCHEMA || record.repository !== repoMemoryRepositoryPath(repo)
    || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(record.head)
    || (record.publishedAt !== undefined && !Number.isFinite(Date.parse(record.publishedAt)))) {
    throw new Error("invalid shared Repo Memory baseline");
  }
  return { ...record, path };
}

// Generated memory and the collector's ignore entry are not source changes.
export function shareableRepoMemoryWorktree(repo, stagingName) {
  const paths = ["--", ".", ":(exclude).repo_memory", ...(stagingName ? [`:(exclude)${stagingName}`] : [])];
  const options = { cwd: repo, encoding: "utf8", timeout: 2000, killSignal: "SIGKILL", env: { ...process.env, GIT_NO_LAZY_FETCH: "1" } };
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
    writeFileSync(join(stage, "baseline.json"), JSON.stringify({ schema: SCHEMA, repository: repoMemoryRepositoryPath(repo), head,
      publishedAt: new Date().toISOString() }), { mode: 0o600 });
    if (!shareableRepoMemoryWorktree(repo) || gitHead(repo, GIT_OPTIONS) !== head) return false;
    renameSync(stage, destination);
    return true;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

export function restoreSharedRepoMemory({ baseline, repo, validate, dryRun = false, refresh = false }) {
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
  const previous = refresh ? borrowedFingerprint(repo) : undefined;
  if (lstatSync(target, { throwIfNoEntry: false }) && !previous) return result("local_bundle_exists");
  const reason = sharedBaseline.head === baseline.head ? "shared_bundle_reused" : "shared_bundle_borrowed";
  if (dryRun) return { ...result(reason), refreshed: Boolean(previous) };
  const stagingName = `.repo-memory-reuse-${randomUUID()}`;
  const stage = join(repo, stagingName);
  let preserveStage = false;
  try {
    copyBundle(join(baseline.path, ".repo_memory"), join(stage, ".repo_memory"));
    const stagedValidation = validate(stage);
    if (stagedValidation.status === "unknown") return result("shared_bundle_unavailable");
    if (stagedValidation.status !== "usable" || !bundleHeadMatches(repo, stage, baseline.head)) return result("shared_bundle_invalid");
    writeFileSync(join(stage, ".repo_memory", BORROWED_FILE), JSON.stringify({
      schema: BORROWED_SCHEMA, repository: baseline.repository, head: baseline.head,
      fingerprint: bundleFingerprint(join(stage, ".repo_memory")),
    }), { mode: 0o600 });
    if (gitHead(repo, GIT_OPTIONS) !== sharedBaseline.head) return result("shared_snapshot_mismatch");
    if (!shareableRepoMemoryWorktree(repo, stagingName)) return result("worktree_dirty");
    if (previous) {
      if (borrowedFingerprint(repo) !== previous) return result("local_bundle_exists");
      for (const name of ["procedure-memory", "user-profile"]) {
        if (lstatSync(join(target, name), { throwIfNoEntry: false })) copyBundle(join(target, name), join(stage, ".repo_memory", name), false);
      }
    } else if (lstatSync(target, { throwIfNoEntry: false })) return result("local_bundle_exists");
    const ignorePath = join(repo, ".gitignore");
    const ignoreInfo = lstatSync(ignorePath, { throwIfNoEntry: false });
    if (ignoreInfo && !ignoreInfo.isFile()) return result("worktree_dirty");
    const ignore = ignoreInfo ? readFileSync(ignorePath, "utf8") : "";
    if (!/^\/?\.repo_memory\/?\r?$/m.test(ignore)) {
      appendFileSync(ignorePath, `${ignore && !ignore.endsWith("\n") ? "\n" : ""}.repo_memory/\n`);
    }
    const backup = join(stage, "previous");
    if (previous && borrowedFingerprint(repo) !== previous) return result("local_bundle_exists");
    if (previous) renameSync(target, backup);
    try { renameSync(join(stage, ".repo_memory"), target); }
    catch (error) {
      if (previous) {
        try { renameSync(backup, target); }
        catch { preserveStage = true; }
      }
      throw error;
    }
    return { ...result(reason), refreshed: Boolean(previous) };
  } finally {
    if (!preserveStage) rmSync(stage, { recursive: true, force: true });
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

export function inspectSharedDelta(repo, baseHead) {
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
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8", timeout: 2000, killSignal: "SIGKILL", maxBuffer: 128 * 1024,
    env: { ...process.env, GIT_NO_LAZY_FETCH: "1" } });
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

// Only helper-created, byte-for-byte unchanged borrowed maps can be refreshed.
export function borrowedFingerprint(repo) {
  const memory = join(repo, ".repo_memory"), path = join(memory, BORROWED_FILE);
  if (!lstatSync(path, { throwIfNoEntry: false })?.isFile()) return undefined;
  const record = JSON.parse(readFileSync(path, "utf8"));
  if (record.schema !== BORROWED_SCHEMA || record.repository !== repoMemoryRepositoryPath(repo)
    || !/^[a-f0-9]{64}$/.test(record.fingerprint || "")
    || resolveCommit(repo, profileLocalHead(join(memory, "PROFILE.md")) || "", GIT_OPTIONS) !== record.head) return undefined;
  return bundleFingerprint(memory) === record.fingerprint ? record.fingerprint : undefined;
}

function bundleFingerprint(root) {
  const hash = createHash("sha256");
  const visit = (path, relative = "") => {
    if (!lstatSync(path).isDirectory()) throw new Error("invalid Repo Memory directory");
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!relative && ["procedure-memory", "user-profile", BORROWED_FILE].includes(entry.name)) continue;
      const name = relative + entry.name;
      hash.update(JSON.stringify([name, entry.isDirectory()]));
      if (entry.isDirectory()) visit(join(path, entry.name), name + "/");
      else if (entry.isFile()) {
        const bytes = readFileSync(join(path, entry.name));
        hash.update(String(bytes.length) + ":"); hash.update(bytes);
      } else throw new Error("Repo Memory sharing does not follow symbolic links");
    }
  };
  visit(root);
  return hash.digest("hex");
}

// The default branch is local evidence only. Never contact remotes or guess a branch name.
export function defaultBranchSnapshot(repo) {
  try {
    const ref = readGit(repo, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]).stdout.trim();
    if (!ref.startsWith("refs/remotes/origin/") || ref === "refs/remotes/origin/HEAD") return undefined;
    const branch = ref.slice("refs/remotes/origin/".length);
    if (readGit(repo, ["symbolic-ref", "--quiet", "HEAD"]).stdout.trim() !== `refs/heads/${branch}`) return undefined;
    const head = readGit(repo, ["rev-parse", "--verify", `${ref}^{commit}`]).stdout.trim();
    if (readGit(repo, ["rev-parse", "--verify", "HEAD^{commit}"]).stdout.trim() !== head) return undefined;
    return { ref, branch, head };
  } catch { return undefined; }
}

export function prepareSharedRepoMemoryUpdate({ home, repo, update, root, validate }) {
  const baseline = readSharedRepoMemory(home, repo);
  if (!baseline || baseline.head !== update.baseHead) throw new Error("shared Repo Memory baseline changed");
  copyBundle(join(baseline.path, ".repo_memory"), join(root, ".repo_memory"));
  if (!validate(root) || !bundleHeadMatches(repo, root, update.baseHead)) throw new Error("invalid shared Repo Memory candidate");
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

// Called under repository ownership before dispatch, including native tickets.
export function recordSharedRepoMemoryAttempt({ home, repo, update, nowMs = Date.now() }) {
  writePrivateJsonRecord(join(sharedRepoMemoryPath(home, repo), "update-attempt.json"), {
    schema: "repo_memory_shared_attempt.v1", baseHead: update.baseHead, head: update.head, startedAt: new Date(nowMs).toISOString(),
  }, { durableBoundary: home });
}

export function publishSharedRepoMemoryUpdate({ home, repo, update, root, validate }) {
  const matches = () => {
    const snapshot = defaultBranchSnapshot(repo);
    return snapshot?.head === update.head && snapshot.ref === update.ref && shareableRepoMemoryWorktree(repo)
      && readSharedRepoMemory(home, repo)?.head === update.baseHead;
  };
  if (!matches()) return false;
  const versions = join(sharedRepoMemoryPath(home, repo), "versions");
  mkdirSync(versions, { recursive: true, mode: 0o700 });
  const stage = join(versions, `${randomUUID()}.tmp`);
  try {
    copyBundle(join(root, ".repo_memory"), join(stage, ".repo_memory"));
    if (!validate(stage) || !bundleHeadMatches(repo, stage, update.head) || !matches()) return false;
    writeFileSync(join(stage, "baseline.json"), JSON.stringify({ schema: SCHEMA,
      repository: repoMemoryRepositoryPath(repo), head: update.head, publishedAt: new Date().toISOString() }), { mode: 0o600 });
    renameSync(stage, join(versions, update.head));
    return true;
  } finally { rmSync(stage, { recursive: true, force: true }); }
}
