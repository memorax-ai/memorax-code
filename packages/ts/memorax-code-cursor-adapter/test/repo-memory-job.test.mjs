import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runCursorRepoMemoryJob } from "../src/native-repo-memory.mjs";
import { markerPathForRepo, readActiveRepoMemoryJobMarker, writeRepoMemoryJobMarker } from "../../memorax-code-adapter-common/src/repo-memory/repo-memory-job-marker.mjs";
import { runRepoMemoryJob } from "../../memorax-code-adapter-common/src/repo-memory/repo-memory-job-supervisor.mjs";
import { readActiveRepoMemoryJobMarker as readLegacyMarker } from "./fixtures/legacy-repo-memory-job-marker.mjs";

const adapterRoot = realpathSync(fileURLToPath(new URL("..", import.meta.url)));
const jobHook = join(adapterRoot, "hooks/repo-memory-job.mjs");
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(MEMORAX_CODE_|CURSOR_|REPO_MEMORY_TEST_)/i.test(key)));

test("Cursor shares a single native build and its validated snapshot across linked worktrees", (t) => {
  const f = fixture(t), linked = join(f.root, "linked worktree");
  runGit(f.repo, ["worktree", "add", "--detach", linked, f.head]);
  const job = prepare(f);
  const waiting = runCursorRepoMemoryJob(["maintain", "--repo", linked], f.options);
  assert.equal(waiting.action, "deduplicated");
  assert.equal(waiting.job.jobId, job.jobId);
  assert.equal(waiting.job.delegation, undefined);
  const claim = claimJob(f, job);
  profile(f, f.head);
  assert.equal(transition(f, "finish", job, ["--claim-token", claim.claimToken]).status, "succeeded");
  const reused = runCursorRepoMemoryJob(["maintain", "--repo", linked], f.options);
  assert.equal(reused.action, "none");
  assert.equal(reused.reason, "shared_bundle_reused");
  assert.equal(reused.job, undefined);
  assert.equal(readFileSync(join(linked, ".repo_memory/PROFILE.md"), "utf8"), readFileSync(join(f.repo, ".repo_memory/PROFILE.md"), "utf8"));
});

test("Cursor native dry-run needs no Agent CLI and creates no job or lease", (t) => {
  const f = fixture(t);
  const result = spawnSync(process.execPath, [jobHook, "maintain", "--repo", f.repo, "--dry-run"], { encoding: "utf8", env: { ...cleanEnv, MEMORAX_CODE_HOME: f.home, MEMORAX_CODE_CURSOR_AGENT_COMMAND: join(f.root, "must-not-execute") } });
  assert.equal(result.status, 0, result.stderr);
  const resultValue = JSON.parse(result.stdout);
  assert.equal(resultValue.reason, "bundle_missing");
  assert.equal(resultValue.job.execution, "native-subagent");
  assert.equal(resultValue.job.command, undefined);
  assert.equal(resultValue.job.delegation, undefined);
  assert.equal(existsSync(join(f.home, "repo-memory-jobs")), false);
});

test("Cursor delegates a private one-use claim then validates completion independently of prose", async (t) => {
  const f = fixture(t);
  const job = prepare(f);
  assert.equal(job.status, "requested");
  assert.equal(job.delegation.name, "memorax-repo-memory");
  assert.equal(job.delegation.background, true);
  assert.match(job.delegation.referencePath, /references[/\\]repo-build\.md$/);
  assert.ok(Date.parse(job.expiresAt) - Date.now() <= 5 * 60 * 1000);
  assert.equal(JSON.parse(readFileSync(job.jobPath)).pid, undefined);
  if (process.platform !== "win32") assert.equal(statSync(job.jobPath).mode & 0o777, 0o600);
  const leasePid = active(f).marker.pid;
  const claim = claimJob(f, job);
  assert.equal(claim.status, "claimed");
  assert.ok(Date.parse(claim.expiresAt) > Date.parse(job.expiresAt));
  assert.match(claim.instructions, /direct Repo Memory reference/);
  assert.match(claim.instructions, /repo-build\.md/);
  const duplicate = claimJob(f, job);
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.reason, "invalid_capability");
  profile(f, f.head);
  const finished = transition(f, "finish", job, ["--claim-token", claim.claimToken]);
  assert.equal(finished.status, "succeeded");
  assert.equal(finished.validation.ok, true);
  assert.equal(active(f).active, false);
  const replay = transition(f, "finish", job, ["--claim-token", claim.claimToken]);
  assert.equal(replay.reason, "invalid_job_status");
  await waitForProcessExit(leasePid);
});

test("interrupted native finish can retry validation with the same claim", async (t) => {
  const f = fixture(t), job = prepare(f), claim = claimJob(f, job);
  profile(f, f.head);
  const paused = await pauseFinishValidation(t, f, job, claim.claimToken);
  paused.child.kill("SIGKILL");
  await paused.completed;
  assert.equal(JSON.parse(readFileSync(job.jobPath)).status, "validating");
  assert.equal(active(f).active, true);
  for (const command of ["finish", "abort"]) {
    const extra = command === "abort" ? ["--reason", "cancelled"] : [];
    assert.equal(transition(f, command, job, ["--claim-token", "0".repeat(64), ...extra]).reason, "invalid_capability");
  }
  const retried = transition(f, "finish", job, ["--claim-token", claim.claimToken]);
  assert.equal(retried.status, "succeeded");
  assert.equal(retried.validation.ok, true);
  assert.equal(active(f).active, false);
});

test("overlapping native finish retries commit only one terminal result", async (t) => {
  const f = fixture(t), job = prepare(f), claim = claimJob(f, job);
  profile(f, f.head);
  const paused = await pauseFinishValidation(t, f, job, claim.claimToken);
  const retried = transition(f, "finish", job, ["--claim-token", claim.claimToken]);
  assert.equal(retried.status, "succeeded");
  const terminal = readFileSync(job.jobPath, "utf8");
  paused.release();
  const late = await paused.completed;
  assert.equal(late.status, 0, late.stderr);
  assert.equal(JSON.parse(late.stdout).reason, "invalid_job_status");
  assert.equal(readFileSync(job.jobPath, "utf8"), terminal);
  assert.equal(active(f).active, false);
});

test("aborting native validation prevents its late result from replacing a new owner", async (t) => {
  const f = fixture(t), job = prepare(f), claim = claimJob(f, job);
  profile(f, f.head);
  const paused = await pauseFinishValidation(t, f, job, claim.claimToken);
  const aborted = transition(f, "abort", job, ["--claim-token", claim.claimToken, "--reason", "cancelled"]);
  assert.equal(aborted.status, "failed");
  assert.equal(aborted.failureReason, "cancelled");
  const terminal = readFileSync(job.jobPath, "utf8");
  const replacement = runCursorRepoMemoryJob(["start", "--mode", "build", "--repo", f.repo], f.options);
  paused.release();
  const late = await paused.completed;
  assert.equal(late.status, 0, late.stderr);
  assert.equal(JSON.parse(late.stdout).reason, "invalid_job_status");
  assert.equal(readFileSync(job.jobPath, "utf8"), terminal);
  assert.equal(active(f).marker.jobId, replacement.jobId);
});

test("Cursor native claims remain usable when consecutive clock reads advance", (t) => {
  const f = fixture(t), job = prepare(f);
  let now = Date.now();
  const claim = transition(f, "claim", job, ["--ticket", ticket(job)], { now: () => now++ });
  assert.equal(claim.status, "claimed");
  profile(f, f.head);
  const finished = transition(f, "finish", job, ["--claim-token", claim.claimToken]);
  assert.equal(finished.status, "succeeded");
  assert.equal(active(f).active, false);
});

test("Cursor and other runners share repository single-flight ownership", (t) => {
  const f = fixture(t);
  const job = prepare(f);
  const repeated = runCursorRepoMemoryJob(["maintain", "--repo", f.repo], f.options);
  assert.equal(repeated.action, "deduplicated");
  assert.equal(repeated.job.jobId, job.jobId);
  assert.equal(repeated.job.delegation, undefined);
  const other = runRepoMemoryJob(["start", "--mode", "build", "--repo", f.repo], {
    runner: "fixture", memoraxCodeHome: f.home, validatorPath: f.validator,
    evaluateRepository: () => { throw new Error("must not evaluate"); },
    createCommand: () => { throw new Error("must not launch"); },
  });
  assert.equal(other.alreadyRunning, true);
  assert.equal(other.jobId, job.jobId);
  const claim = claimJob(f, job);
  transition(f, "abort", job, ["--claim-token", claim.claimToken, "--reason", "cancelled"]);
  writeRepoMemoryJobMarker({ memoraxCodeHome: f.home, marker: {
    version: 1, repo: f.repo, repoKey: markerPathForRepo(f.home, f.repo).repoKey,
    jobId: "other-client-job", runId: "other-run", mode: "build", runner: "codex", pid: process.pid,
    jobPath: join(f.home, "other-job.json"), outputLogPath: join(f.home, "other-output"), finalMessagePath: join(f.home, "other-final"), startedAt: new Date().toISOString(),
  } });
  const otherOwns = runCursorRepoMemoryJob(["maintain", "--repo", f.repo], f.options);
  assert.equal(otherOwns.action, "deduplicated");
  assert.equal(otherOwns.job.runner, "codex");
  assert.equal(otherOwns.job.jobId, "other-client-job");
});

test("legacy runtimes preserve requested and claimed Cursor repository ownership", (t) => {
  const f = fixture(t), job = prepare(f);
  const markerPath = markerPathForRepo(f.home, f.repo).markerPath;
  const legacy = () => readLegacyMarker({ memoraxCodeHome: f.home, repoRealpath: f.repo });
  const requested = legacy();
  assert.equal(requested.active, true, "legacy runtime must retain requested ownership: " + requested.reason);
  assert.equal(requested.marker.jobId, job.jobId);
  assert.equal(existsSync(markerPath), true);
  const claim = claimJob(f, job);
  assert.equal(claim.status, "claimed");
  const claimed = legacy();
  assert.equal(claimed.active, true, "legacy runtime must retain claimed ownership: " + claimed.reason);
  assert.equal(claimed.marker.jobId, job.jobId);
  assert.equal(claimed.marker.pid, requested.marker.pid);
  assert.equal(existsSync(markerPath), true);
  profile(f, f.head);
  assert.equal(transition(f, "finish", job, ["--claim-token", claim.claimToken]).status, "succeeded");
});

test("concurrent Cursor processes publish one delegation and only one claimant", async (t) => {
  const f = fixture(t);
  const driver = join(f.root, "driver.mjs");
  writeFileSync(driver, "import { runCursorRepoMemoryJob } from " + JSON.stringify(new URL("../src/native-repo-memory.mjs", import.meta.url).href) + ";\nconsole.log(JSON.stringify(runCursorRepoMemoryJob(process.argv.slice(2), " + JSON.stringify(f.options) + ")));\n");
  const results = await Promise.all([1, 2, 3].map(() => runAsync(driver, ["maintain", "--repo", f.repo])));
  for (const r of results) assert.equal(r.status, 0, r.stderr);
  const decisions = results.map(r => JSON.parse(r.stdout));
  assert.equal(decisions.filter(r => r.job?.delegation).length, 1);
  assert.equal(new Set(decisions.map(r => r.job.jobId)).size, 1);
  const job = decisions.find(r => r.job?.delegation).job;
  const legacyRequested = readLegacyMarker({ memoraxCodeHome: f.home, repoRealpath: f.repo });
  assert.equal(legacyRequested.active, true, "ownership must survive helper exit: " + legacyRequested.reason);
  assert.ok(results.every(r => r.pid !== legacyRequested.marker.pid), "owner PID must outlive the preparing helpers");
  assert.doesNotThrow(() => process.kill(legacyRequested.marker.pid, 0));
  const args = ["claim", "--repo", f.repo, "--job", job.jobId, "--run", job.runId, "--ticket", ticket(job)];
  const claimed = (await Promise.all([1, 2].map(() => runAsync(driver, args)))).map(r => JSON.parse(r.stdout));
  assert.equal(claimed.filter(r => r.status === "claimed").length, 1);
  assert.equal(claimed.filter(r => r.ok === false).length, 1);
  const legacyClaimed = readLegacyMarker({ memoraxCodeHome: f.home, repoRealpath: f.repo });
  assert.equal(legacyClaimed.active, true, "ownership must survive claimant exit: " + legacyClaimed.reason);
  assert.equal(legacyClaimed.marker.pid, legacyRequested.marker.pid);
});

test("unclaimed Cursor lease guards stop at the requested expiry", async (t) => {
  const f = fixture(t);
  f.options.leaseMs = 1500;
  const job = prepare(f), pid = active(f).marker.pid;
  await waitForProcessExit(pid);
  assert.ok(Date.now() >= Date.parse(job.expiresAt));
  const result = claimJob(f, job);
  assert.equal(result.failureReason, "lease_expired");
  assert.equal(active(f).active, false);
});

test("a dead Cursor lease guard rejects native claims", async (t) => {
  const f = fixture(t), job = prepare(f), pid = active(f).marker.pid;
  assert.notEqual(pid, process.pid);
  process.kill(pid, "SIGTERM");
  await waitForProcessExit(pid);
  const result = claimJob(f, job);
  assert.equal(result.reason, "job_ownership_lost");
  assert.equal(active(f).active, false);
});

test("Cursor never delegates when the lease guard cannot start", (t) => {
  const f = fixture(t);
  f.options.helperPath = join(f.root, "missing-helper.mjs");
  assert.throws(() => prepare(f), /lease guard did not become ready/);
  assert.equal(active(f).active, false);
  const records = readdirSync(join(f.home, "repo-memory-jobs"))
    .filter(name => name !== "in-progress")
    .map(name => JSON.parse(readFileSync(join(f.home, "repo-memory-jobs", name, "job.json"))));
  assert.equal(records.length, 1);
  assert.equal(records[0].status, "failed");
  assert.equal(records[0].failureReason, "lease_guard_start_failed");
});

test("Cursor reuses adaptive policy for current, commit-threshold and disabled bundles", (t) => {
  const f = fixture(t);
  profile(f, f.head);
  mkdirSync(f.home, { recursive: true });
  writeFileSync(join(f.home, "config.toml"), '[memory.repo_update]\npolicy = "adaptive"\ncommit_threshold = 2\ncooldown_hours = 24\n');
  assert.equal(runCursorRepoMemoryJob(["maintain", "--repo", f.repo], f.options).reason, "up_to_date");
  commit(f, "one"); commit(f, "two");
  const update = runCursorRepoMemoryJob(["maintain", "--repo", f.repo, "--dry-run"], f.options);
  assert.equal(update.action, "update");
  assert.equal(update.reason, "commit_threshold_reached");
  assert.equal(update.policyDecision.commitsBehind, 2);
  writeFileSync(join(f.home, "config.toml"), '[memory.repo_update]\npolicy = "manual"\n');
  const skipped = runCursorRepoMemoryJob(["maintain", "--repo", f.repo, "--dry-run"], f.options);
  assert.equal(skipped.action, "none");
});

for (const scenario of ["snapshot_changed", "artifact_validation_failed", "profile_head_mismatch"]) {
  test("Cursor native finish rejects " + scenario, (t) => {
    const f = fixture(t);
    const job = prepare(f), claim = claimJob(f, job);
    profile(f, scenario === "profile_head_mismatch" ? "0".repeat(40) : f.head);
    if (scenario === "snapshot_changed") commit(f, "changed-during-authoring");
    if (scenario === "artifact_validation_failed") writeFileSync(join(f.repo, ".repo_memory", "invalid"), "invalid");
    const result = transition(f, "finish", job, ["--claim-token", claim.claimToken]);
    assert.equal(result.ok, false);
    assert.equal(result.status, "failed");
    assert.equal(result.failureReason, scenario);
    assert.equal(active(f).active, false);
  });
}

test("native claim fails if HEAD changed before authoring", (t) => {
  const f = fixture(t), job = prepare(f);
  commit(f, "changed-before-claim");
  const result = claimJob(f, job);
  assert.equal(result.failureReason, "snapshot_changed");
  assert.equal(active(f).active, false);
});

test("expired claims fail and cannot remove a replacement owner's lease", (t) => {
  const f = fixture(t), job = prepare(f), claim = claimJob(f, job);
  const expired = transition(f, "finish", job, ["--claim-token", claim.claimToken], { now: () => Date.parse(claim.expiresAt) + 1 });
  assert.equal(expired.failureReason, "lease_expired");
  const replacement = prepare(f);
  const late = transition(f, "finish", job, ["--claim-token", claim.claimToken]);
  assert.equal(late.reason, "invalid_job_status");
  assert.equal(active(f).marker.jobId, replacement.jobId);
  const wrong = transition(f, "claim", replacement, ["--ticket", "0".repeat(64)]);
  assert.equal(wrong.reason, "invalid_capability");
  assert.equal(active(f).marker.jobId, replacement.jobId);
});

test("expired unclaimed tickets record failure without accepting completion text", (t) => {
  const f = fixture(t), job = prepare(f);
  const result = transition(f, "claim", job, ["--ticket", ticket(job)], { now: () => Date.parse(job.expiresAt) + 1 });
  assert.equal(result.failureReason, "lease_expired");
  assert.equal(active(f).active, false);
  assert.throws(() => transition(f, "finish", job, ["--claim-token", "succeeded"]), /claim-token/);
});

test("native finalization rejects repo/run mismatch and a replaced marker", async (t) => {
  const f = fixture(t), job = prepare(f), claim = claimJob(f, job);
  const otherRepo = join(f.root, "other"); mkdirSync(otherRepo);
  assert.throws(() => runCursorRepoMemoryJob(["finish", "--repo", otherRepo, "--job", job.jobId, "--run", job.runId, "--claim-token", claim.claimToken], f.options), /identity/);
  assert.throws(() => transition(f, "finish", { ...job, runId: "0".repeat(32) }, ["--claim-token", claim.claimToken]), /identity/);
  const markerPath = markerPathForRepo(f.home, f.repo).markerPath;
  const marker = JSON.parse(readFileSync(markerPath));
  marker.runId = "replacement-run"; writeFileSync(markerPath, JSON.stringify(marker));
  const result = transition(f, "finish", job, ["--claim-token", claim.claimToken]);
  assert.equal(result.reason, "job_ownership_lost");
  assert.equal(JSON.parse(readFileSync(markerPath)).runId, "replacement-run");
  await waitForProcessExit(marker.pid);
  assert.deepEqual(JSON.parse(readFileSync(markerPath)), marker, "old lease guard must retain the replacement marker");
});

test("native abort records a bounded reason, releases ownership and rejects replay", (t) => {
  const f = fixture(t), job = prepare(f), claim = claimJob(f, job);
  const result = transition(f, "abort", job, ["--claim-token", claim.claimToken, "--reason", "permission_denied"]);
  assert.equal(result.failureReason, "permission_denied");
  assert.equal(result.status, "failed");
  assert.equal(active(f).active, false);
  assert.equal(transition(f, "abort", job, ["--claim-token", claim.claimToken, "--reason", "cancelled"]).reason, "invalid_job_status");
});

test("native finish rejects expiry during independent validation", (t) => {
  const f = fixture(t), job = prepare(f), claim = claimJob(f, job);
  profile(f, f.head);
  let reads = 0;
  const result = transition(f, "finish", job, ["--claim-token", claim.claimToken], {
    now: () => ++reads === 1 ? Date.now() : Date.parse(claim.expiresAt) + 1,
  });
  assert.equal(result.failureReason, "lease_expired");
  assert.equal(result.status, "failed");
  assert.equal(active(f).active, false);
});

test("native finish rechecks HEAD after the validator returns", (t) => {
  const f = fixture(t), job = prepare(f), claim = claimJob(f, job);
  profile(f, f.head);
  writeFileSync(f.validator, 'import {spawnSync} from "node:child_process"; const repo=process.argv[3];const r=spawnSync("git",["commit","--allow-empty","--quiet","-m","validator-race"],{cwd:repo});console.log(JSON.stringify({ok:r.status===0}));process.exitCode=r.status;');
  const result = transition(f, "finish", job, ["--claim-token", claim.claimToken]);
  assert.equal(result.failureReason, "snapshot_changed");
  assert.equal(result.status, "failed");
});

test("native finish requires validator JSON success as well as exit zero", (t) => {
  const f = fixture(t), job = prepare(f), claim = claimJob(f, job);
  profile(f, f.head);
  writeFileSync(f.validator, 'console.log(JSON.stringify({ok:false}));');
  const result = transition(f, "finish", job, ["--claim-token", claim.claimToken]);
  assert.equal(result.failureReason, "artifact_validation_failed");
});

test("Cursor native CLI uses the canonical validator to reject an incomplete bundle", (t) => {
  const f = fixture(t);
  delete f.options.validatorPath;
  const job = prepare(f), claim = claimJob(f, job);
  profile(f, f.head);
  const result = spawnSync(process.execPath, [jobHook, "finish", "--repo", f.repo, "--job", job.jobId, "--run", job.runId, "--claim-token", claim.claimToken], { encoding: "utf8", env: { ...cleanEnv, MEMORAX_CODE_HOME: f.home } });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(JSON.parse(result.stdout).failureReason, "artifact_validation_failed");
});

test("Cursor synchronous native startup bounds a stalled Git status and releases its lock", { skip: process.platform === "win32" }, (t) => {
  const f = fixture(t);
  const bin = join(f.root, "slow-git-bin");
  mkdirSync(bin);
  const git = join(bin, "git");
  writeFileSync(git, "#!" + process.execPath + "\n" + 'if(process.argv[2]==="rev-parse")console.log(' + JSON.stringify(f.head) + ');else if(process.argv[2]==="branch")console.log("main");else {process.on("SIGTERM",()=>{});setTimeout(()=>{},10000); }\n');
  chmodSync(git, 0o700);
  const started = Date.now();
  const result = spawnSync(process.execPath, [jobHook, "maintain", "--repo", f.repo], {
    encoding: "utf8", timeout: 6000,
    env: { ...cleanEnv, MEMORAX_CODE_HOME: f.home, PATH: bin + ":" + cleanEnv.PATH },
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /readable git HEAD/);
  assert.ok(Date.now() - started < 5000, "snapshot must finish within its native budget");
  assert.equal(active(f).active, false);
  assert.equal(existsSync(markerPathForRepo(f.home, f.repo).markerPath.replace(/\.json$/, ".lockdir")), false);
});

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cursor native memory ")));
  t.after(async () => {
    const jobs = join(root, "private state", "repo-memory-jobs");
    const pids = existsSync(jobs) ? readdirSync(jobs).filter(name => name !== "in-progress").flatMap(name => {
      const path = join(jobs, name, "job.json");
      if (!existsSync(path)) return [];
      const pid = JSON.parse(readFileSync(path)).leasePid;
      return Number.isSafeInteger(pid) && pid > 0 ? [pid] : [];
    }) : [];
    rmSync(root, { recursive: true, force: true });
    try { await Promise.all(pids.map(waitForProcessExit)); }
    finally { rmSync(root, { recursive: true, force: true }); }
  });
  const repo = join(root, "repo with spaces"), home = join(root, "private state");
  mkdirSync(repo); runGit(repo, ["init", "--quiet"]); runGit(repo, ["config", "user.name", "Cursor Test"]); runGit(repo, ["config", "user.email", "cursor@example.invalid"]);
  writeFileSync(join(repo, "README.md"), "# Isolated test\n"); runGit(repo, ["add", "README.md"]); runGit(repo, ["commit", "--quiet", "-m", "initial"]);
  const head = runGit(repo, ["rev-parse", "HEAD"]).trim();
  const validator = join(root, "validator.mjs");
  writeFileSync(validator, 'import {existsSync} from "node:fs"; import {join} from "node:path"; const repo=process.argv[3]; const ok=existsSync(join(repo,".repo_memory/PROFILE.md"))&&!existsSync(join(repo,".repo_memory/invalid"));console.log(JSON.stringify({ok, errors:ok?[]:["fixture_invalid"]}));process.exitCode=ok?0:1;\n');
  return { root, repo, home, head, validator, options: { memoraxCodeHome: home, validatorPath: validator, helperPath: jobHook, sessionId: "fixture-parent" } };
}
function prepare(f) { return runCursorRepoMemoryJob(["maintain", "--repo", f.repo], f.options).job; }
function ticket(job) { const line = job.delegation.prompt.split("\n").find(x => x.startsWith('{"executable"')); const args = JSON.parse(line).args; return args[args.indexOf("--ticket") + 1]; }
function claimJob(f, job) { return transition(f, "claim", job, ["--ticket", ticket(job)]); }
function transition(f, command, job, extra = [], options = {}) { return runCursorRepoMemoryJob([command, "--repo", f.repo, "--job", job.jobId, "--run", job.runId, ...extra], { ...f.options, ...options }); }
function profile(f, head) { mkdirSync(join(f.repo, ".repo_memory"), { recursive: true }); writeFileSync(join(f.repo, ".repo_memory/PROFILE.md"), '---\nlocal_head: "' + head + '"\ngenerated_at: "' + new Date().toISOString() + '"\n---\n# Fixture\n'); }
function active(f) { return readActiveRepoMemoryJobMarker({ memoraxCodeHome: f.home, repoRealpath: f.repo }); }
function commit(f, name) { writeFileSync(join(f.repo, name), name); runGit(f.repo, ["add", name]); runGit(f.repo, ["commit", "--quiet", "-m", name]); }
function runGit(repo, args) { const r = spawnSync("git", args, { cwd: repo, encoding: "utf8" }); assert.equal(r.status, 0, r.stderr); return r.stdout; }
function runAsync(driver, args) { return new Promise((resolveResult) => { const child = spawn(process.execPath, [driver, ...args], { env: cleanEnv, stdio: ["ignore", "pipe", "pipe"] }); let stdout="", stderr=""; child.stdout.on("data", x => stdout += x); child.stderr.on("data", x => stderr += x); child.once("close", status => resolveResult({status, stdout, stderr, pid: child.pid})); }); }

async function pauseFinishValidation(t, f, job, claimToken) {
  const startedPath = join(f.root, "validation-started.json"), releasePath = join(f.root, "validation-release");
  writeFileSync(f.validator, 'import {existsSync,writeFileSync} from "node:fs";const started=' + JSON.stringify(startedPath) + ',release=' + JSON.stringify(releasePath) + ';if(!existsSync(started)){writeFileSync(started,JSON.stringify({pid:process.pid}));const deadline=Date.now()+10000;while(!existsSync(release)&&Date.now()<deadline)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);if(!existsSync(release))process.exit(1);}console.log(JSON.stringify({ok:true}));\n');
  const driver = join(f.root, "finish-driver.mjs");
  const args = ["finish", "--repo", f.repo, "--job", job.jobId, "--run", job.runId, "--claim-token", claimToken];
  writeFileSync(driver, "import {runCursorRepoMemoryJob} from " + JSON.stringify(new URL("../src/native-repo-memory.mjs", import.meta.url).href) + ";console.log(JSON.stringify(runCursorRepoMemoryJob(" + JSON.stringify(args) + "," + JSON.stringify(f.options) + ")));\n");
  const child = spawn(process.execPath, [driver], { env: cleanEnv, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "", validatorPid;
  child.stdout.on("data", chunk => stdout += chunk);
  child.stderr.on("data", chunk => stderr += chunk);
  const completed = new Promise(resolveResult => child.once("close", status => resolveResult({ status, stdout, stderr })));
  t.after(async () => {
    child.kill("SIGKILL");
    if (validatorPid) {
      try { process.kill(validatorPid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
      await waitForProcessExit(validatorPid);
    }
    await completed;
  });
  const deadline = Date.now() + 5000;
  while (!existsSync(startedPath) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(existsSync(startedPath), true, "finish must reach its independent validator: " + stderr);
  validatorPid = JSON.parse(readFileSync(startedPath)).pid;
  assert.equal(JSON.parse(readFileSync(job.jobPath)).status, "validating");
  return { child, completed, release: () => writeFileSync(releasePath, "release") };
}

async function waitForProcessExit(pid) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); }
    catch (error) { if (error.code === "ESRCH") return; throw error; }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail("lease guard did not stop within its cleanup budget");
}
