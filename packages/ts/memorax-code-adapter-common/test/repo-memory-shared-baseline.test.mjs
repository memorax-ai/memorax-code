import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { defaultBranchSnapshot, prepareSharedRepoMemorySnapshot, publishSharedRepoMemorySnapshot, readSharedRepoMemory, sharedSnapshotRoot } from "../src/repo-memory/repo-memory-shared-bundle.mjs";
import { runRepoMemoryJob } from "../src/repo-memory/repo-memory-job-supervisor.mjs";
import { evaluateRepository } from "../src/repo-memory/repo-memory-update-policy-evaluator.mjs";

const driver = fileURLToPath(new URL("./support/repo-memory-job-driver.mjs", import.meta.url));
const validator = fileURLToPath(new URL("./support/repo-memory-job-validator.mjs", import.meta.url));
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(MEMORAX_CODE_REPO_MEMORY_|REPO_MEMORY_TEST_)/.test(key)));

test("missing default-branch authority skips automatic work without guessing main or using a local map", t => {
  const f = fixture(t, false);
  profile(f.repo, f.head);
  const result = maintain(f);
  assert.equal(result.reason, "default_branch_unavailable");
  assert.equal(result.action, "none");
  assert.equal(result.job, undefined);
  assert.equal(existsSync(join(f.home, "repo-memory-jobs")), false);
  assert.equal(resolve(f).reason, "local_bundle_in_use");
});

test("a dirty feature worktree builds only the fixed mainline snapshot and publishes one shared bundle", t => {
  const f = fixture(t);
  git(f.repo, ["switch", "-c", "feature"]);
  commit(f.repo, "source.txt", "feature-only content\n");
  writeFileSync(join(f.repo, "source.txt"), "uncommitted feature content\n");
  writeFileSync(join(f.repo, "untracked.txt"), "local work\n");
  const before = git(f.repo, ["status", "--porcelain"]);
  const result = maintain(f);
  assert.equal(result.action, "build");
  const state = terminal(result.job.jobPath);
  assert.equal(state.status, "succeeded", JSON.stringify(state));
  assert.equal(state.snapshotHead, f.head);
  assert.equal(state.sharedBaselinePublished, true);
  assert.equal(existsSync(sharedSnapshotRoot(result.job.jobPath)), false);
  assert.equal(git(f.repo, ["status", "--porcelain"]), before);
  assert.equal(readFileSync(join(f.repo, "source.txt"), "utf8"), "uncommitted feature content\n");
  assert.equal(existsSync(join(f.repo, ".repo_memory")), false);
  const baseline = readSharedRepoMemory(f.home, f.repo);
  assert.equal(baseline.head, f.head);
  assert.match(readFileSync(join(baseline.path, ".repo_memory/PROFILE.md"), "utf8"), new RegExp(f.head));
  assert.equal(resolve(f).memoryPath, join(baseline.path, ".repo_memory"));
});

test("dry-run does not create a snapshot, attempt record, or job", t => {
  const f = fixture(t);
  const result = maintain(f, ["--dry-run"]);
  assert.equal(result.action, "build");
  assert.equal(result.job.snapshotHead, f.head);
  assert.match(result.job.prompt, /repo-build operation/);
  assert.equal(existsSync(join(f.home, "repo-memory-jobs")), false);
  assert.equal(readSharedRepoMemory(f.home, f.repo), undefined);
});

test("linked worktrees read the same version regardless of branch divergence, structural edits, or dirt", t => {
  const f = fixture(t);
  build(f);
  const original = resolve(f).memoryPath;
  const linked = join(f.root, "linked");
  git(f.repo, ["worktree", "add", "-b", "feature", linked, f.head]);
  for (let i = 0; i < 6; i++) commit(linked, `feature-${i}.txt`, `${i}\n`);
  commit(linked, "package.json", '{"name":"feature"}\n');
  git(linked, ["rm", "source.txt"]); git(linked, ["commit", "-m", "remove source"]);
  writeFileSync(join(linked, "dirty.txt"), "changed\n".repeat(1500));
  const branch = { ...f, repo: linked };
  assert.equal(resolve(branch).memoryPath, original);
  const decision = maintain(branch, ["--now", "2099-01-01T00:00:00Z"]);
  assert.equal(decision.reason, "up_to_date");
  assert.equal(decision.policyDecision.commitsBehind, 0);
  assert.equal(existsSync(join(linked, ".repo_memory")), false);
  git(linked, ["checkout", "--detach", "HEAD"]);
  assert.equal(resolve(branch).memoryPath, original);
});

test("mainline changes update from another worktree without file-count or structural-change gates", t => {
  const f = fixture(t);
  build(f);
  const old = readSharedRepoMemory(f.home, f.repo);
  const linked = join(f.root, "linked");
  git(f.repo, ["worktree", "add", "--detach", linked, f.head]);
  git(f.repo, ["rm", "source.txt"]);
  for (let i = 0; i < 25; i++) writeFileSync(join(f.repo, `main-${i}.txt`), "large change\n".repeat(50));
  writeFileSync(join(f.repo, "package.json"), '{"name":"main"}\n');
  git(f.repo, ["add", "."]); git(f.repo, ["commit", "-m", "mainline changes"]);
  const target = git(f.repo, ["rev-parse", "HEAD"]);
  git(f.repo, ["update-ref", "refs/remotes/origin/trunk", target]);
  writeFileSync(join(linked, "uncommitted.txt"), "local work\n");
  const branch = { ...f, repo: linked };
  const result = maintain(branch, [], { MEMORAX_CODE_REPO_MEMORY_UPDATE_POLICY: "every-commit" });
  assert.equal(result.action, "update");
  assert.equal(result.policyDecision.commitsBehind, 1);
  assert.equal(terminal(result.job.jobPath).status, "succeeded");
  const next = readSharedRepoMemory(f.home, f.repo);
  assert.equal(next.head, target);
  assert.notEqual(next.path, old.path);
  assert.equal(resolve(branch).memoryPath, resolve(f).memoryPath);
  assert.match(readFileSync(join(old.path, ".repo_memory/PROFILE.md"), "utf8"), new RegExp(f.head));
  assert.equal(git(linked, ["rev-parse", "HEAD"]), f.head);
  assert.equal(readFileSync(join(linked, "uncommitted.txt"), "utf8"), "local work\n");
});

test("failed initial builds and updates retain the last successful baseline and throttle retries", t => {
  const f = fixture(t);
  const initial = maintain(f, [], { REPO_MEMORY_TEST_BEHAVIOR: "final-only" });
  assert.equal(terminal(initial.job.jobPath).status, "failed");
  assert.equal(readSharedRepoMemory(f.home, f.repo), undefined);
  assert.equal(maintain(f).reason, "shared_update_cooldown");
  const later = ["--now", "2099-01-01T00:00:00Z"];
  const retry = maintain(f, later);
  assert.equal(terminal(retry.job.jobPath).status, "succeeded");
  const baseline = readSharedRepoMemory(f.home, f.repo);
  advance(f);
  const failed = maintain(f, [], { MEMORAX_CODE_REPO_MEMORY_UPDATE_POLICY: "every-commit", REPO_MEMORY_TEST_BEHAVIOR: "invalid-profile" });
  assert.equal(terminal(failed.job.jobPath).status, "failed");
  assert.deepEqual(readSharedRepoMemory(f.home, f.repo), baseline);
  assert.equal(maintain(f, [], { MEMORAX_CODE_REPO_MEMORY_UPDATE_POLICY: "every-commit" }).reason, "shared_update_cooldown");
  assert.equal(resolve(f).memoryPath, join(baseline.path, ".repo_memory"));
});

test("only mainline commits and shared publication age feed update policy", t => {
  const f = fixture(t); build(f);
  advance(f);
  assert.equal(maintain(f, ["--dry-run"]).reason, "up_to_date");
  const old = maintain(f, ["--dry-run", "--now", "2099-01-01T00:00:00Z"]);
  assert.equal(old.action, "update");
  assert.equal(old.policyDecision.lastUpdateSource, "shared.publishedAt");
  assert.equal(old.policyDecision.commitsBehind, 1);
});

test("mainline history replacement defers automatic update while the old map remains readable", t => {
  const f = fixture(t); build(f);
  const original = resolve(f).memoryPath;
  git(f.repo, ["checkout", "--orphan", "replacement"]);
  git(f.repo, ["rm", "-rf", "."]);
  const target = commit(f.repo, "new.txt", "new history\n");
  git(f.repo, ["update-ref", "refs/remotes/origin/trunk", target]);
  assert.equal(maintain(f).reason, "shared_history_changed");
  assert.equal(resolve(f).memoryPath, original);
});

test("snapshot publication accepts mainline advancement but rejects candidate source mutation", t => {
  const f = fixture(t);
  const snapshot = { ...defaultBranchSnapshot(f.repo), baseHead: null };
  const root = join(f.root, "job", "source");
  prepareSharedRepoMemorySnapshot({ home: f.home, repo: f.repo, snapshot, root, validate });
  assert.equal(readFileSync(join(root, "source.txt"), "utf8"), "mainline source\n");
  assert.equal(git(root, ["rev-parse", "HEAD"]), f.head);
  profile(root, f.head);
  advance(f);
  writeFileSync(join(root, "source.txt"), "modified candidate source\n");
  assert.equal(publishSharedRepoMemorySnapshot({ home: f.home, repo: f.repo, snapshot, root, validate }), false);
  writeFileSync(join(root, "source.txt"), "mainline source\n");
  assert.equal(publishSharedRepoMemorySnapshot({ home: f.home, repo: f.repo, snapshot, root, validate }), true);
  assert.equal(readSharedRepoMemory(f.home, f.repo).head, f.head);
});

test("publication rechecks provenance and does not overwrite a concurrently published baseline", t => {
  const f = fixture(t);
  const snapshot = { ...defaultBranchSnapshot(f.repo), baseHead: null };
  const roots = [join(f.root, "job-a", "source"), join(f.root, "job-b", "source")];
  for (const root of roots) {
    prepareSharedRepoMemorySnapshot({ home: f.home, repo: f.repo, snapshot, root, validate });
    profile(root, f.head);
  }
  assert.equal(publishSharedRepoMemorySnapshot({ home: f.home, repo: f.repo, snapshot, root: roots[0], validate }), true);
  const first = readSharedRepoMemory(f.home, f.repo);
  assert.equal(publishSharedRepoMemorySnapshot({ home: f.home, repo: f.repo, snapshot, root: roots[1], validate }), false);
  assert.deepEqual(readSharedRepoMemory(f.home, f.repo), first);
});

test("invalid shared artifacts fail closed instead of silently replacing them", t => {
  const f = fixture(t); build(f);
  const baseline = readSharedRepoMemory(f.home, f.repo);
  writeFileSync(join(baseline.path, ".repo_memory/PROFILE.md"), "broken\n");
  assert.equal(maintain(f).reason, "shared_bundle_invalid");
  assert.equal(resolve(f).ok, false);
});

test("publication excludes personal sidecars and rejects links", { skip: process.platform === "win32" }, t => {
  const f = fixture(t);
  const snapshot = { ...defaultBranchSnapshot(f.repo), baseHead: null }, root = join(f.root, "job", "source");
  prepareSharedRepoMemorySnapshot({ home: f.home, repo: f.repo, snapshot, root, validate });
  profile(root, f.head);
  mkdirSync(join(root, ".repo_memory/user-profile"));
  writeFileSync(join(root, ".repo_memory/user-profile/private.txt"), "private\n");
  symlinkSync(join(f.repo, "source.txt"), join(root, ".repo_memory/link"));
  assert.throws(() => publishSharedRepoMemorySnapshot({ home: f.home, repo: f.repo, snapshot, root, validate }), /symbolic links/);
  rmSync(join(root, ".repo_memory/link"));
  assert.equal(publishSharedRepoMemorySnapshot({ home: f.home, repo: f.repo, snapshot, root, validate }), true);
  assert.equal(existsSync(join(readSharedRepoMemory(f.home, f.repo).path, ".repo_memory/user-profile")), false);
});

test("concurrent worktrees dispatch only one mainline build", async t => {
  const f = fixture(t), linked = join(f.root, "linked");
  git(f.repo, ["worktree", "add", "--detach", linked, f.head]);
  const run = repo => new Promise(resolveResult => {
    const child = spawn(process.execPath, [driver, "maintain", "--repo", repo], { env: { ...cleanEnv, MEMORAX_CODE_HOME: f.home }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", c => stdout += c); child.stderr.on("data", c => stderr += c);
    child.on("close", status => { assert.equal(status, 0, stderr); resolveResult(JSON.parse(stdout)); });
  });
  const results = await Promise.all([run(f.repo), run(linked)]);
  const jobs = results.filter(r => r.action === "build");
  assert.equal(jobs.length, 1, JSON.stringify(results));
  assert.equal(terminal(jobs[0].job.jobPath).status, "succeeded");
  assert.equal(resolve(f).memoryPath, resolve({ ...f, repo: linked }).memoryPath);
});

function fixture(t, defaultBranch = true) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "repo-memory-mainline-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo"), home = join(root, "home"); mkdirSync(repo); mkdirSync(home);
  git(repo, ["init", "-b", "trunk"]); git(repo, ["config", "user.name", "Fixture"]); git(repo, ["config", "user.email", "fixture@example.invalid"]);
  const head = commit(repo, "source.txt", "mainline source\n");
  if (defaultBranch) {
    git(repo, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk"]);
    git(repo, ["update-ref", "refs/remotes/origin/trunk", head]);
  }
  return { root, repo, home, head };
}
function git(repo, args) {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
}
function commit(repo, name, content) {
  writeFileSync(join(repo, name), content); git(repo, ["add", name]); git(repo, ["commit", "-m", name]); return git(repo, ["rev-parse", "HEAD"]);
}
function advance(f) {
  const head = commit(f.repo, "new-main.txt", "new main\n"); git(f.repo, ["update-ref", "refs/remotes/origin/trunk", head]); return head;
}
function profile(root, head) {
  mkdirSync(join(root, ".repo_memory"), { recursive: true });
  writeFileSync(join(root, ".repo_memory/PROFILE.md"), `---\nfixture_valid: true\nlocal_head: "${head}"\n---\n# Profile\n`);
}
function validate(root) { return readFileSync(join(root, ".repo_memory/PROFILE.md"), "utf8").includes("fixture_valid: true"); }
function maintain(f, extra = [], env = {}) {
  const result = spawnSync(process.execPath, [driver, "maintain", "--repo", f.repo, ...extra], { encoding: "utf8", env: { ...cleanEnv, MEMORAX_CODE_HOME: f.home, ...env } });
  assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
}
function resolve(f) {
  return runRepoMemoryJob(["resolve", "--repo", f.repo], { runner: "fixture", memoraxCodeHome: f.home, validatorPath: validator,
    evaluateRepository, createCommand: () => assert.fail("resolve must not launch a client") });
}
function build(f) {
  const result = maintain(f); const state = terminal(result.job.jobPath); assert.equal(state.status, "succeeded", JSON.stringify(state)); return result;
}
function terminal(path) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const state = JSON.parse(readFileSync(path, "utf8"));
    if (["succeeded", "failed"].includes(state.status)) {
      // The terminal state precedes marker release and snapshot cleanup.
      while (state.sharedSnapshot && existsSync(sharedSnapshotRoot(path)) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      return state;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  assert.fail("worker did not finish");
}
