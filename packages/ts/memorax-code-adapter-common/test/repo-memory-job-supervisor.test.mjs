import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { publishSharedRepoMemory, readSharedRepoMemory, restoreSharedRepoMemory } from "../src/repo-memory/repo-memory-shared-bundle.mjs";
import { runRepoMemoryJob } from "../src/repo-memory/repo-memory-job-supervisor.mjs";
import {
  markerPathForRepo,
  repoMemoryJobsDir,
  startupLockPathForRepo,
} from "../src/repo-memory/repo-memory-job-marker.mjs";

const jobDriver = fileURLToPath(new URL("./support/repo-memory-job-driver.mjs", import.meta.url));
const fixtureRunner = fileURLToPath(new URL("./support/repo-memory-job-runner.mjs", import.meta.url));
const workerPath = fileURLToPath(new URL("../src/repo-memory/repo-memory-job-worker.mjs", import.meta.url));

const inheritedJobEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => (
  !/^(MEMORAX_CODE_REPO_MEMORY_|REPO_MEMORY_TEST_)/i.test(key)
)));

function runJob(args, env = {}, { cwd } = {}) {
  return spawnSync(process.execPath, [jobDriver, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...inheritedJobEnv, ...env },
  });
}

function runJobAsync(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [jobDriver, ...args], {
      env: { ...inheritedJobEnv, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function tempRoot(t, prefix) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => {
    const memoraxCodeHome = join(root, "memorax-code");
    const jobsDir = repoMemoryJobsDir(memoraxCodeHome);
    for (const entry of existsSync(jobsDir) ? readdirSync(jobsDir, { withFileTypes: true }) : []) {
      if (!entry.isDirectory() || entry.name === "in-progress") continue;
      const jobPath = join(jobsDir, entry.name, "job.json");
      const state = JSON.parse(readFileSync(jobPath, "utf8"));
      if (state.status !== "succeeded" && state.status !== "failed") {
        killAndWait(state.pid, jobPath);
        if (process.platform === "win32") continue;
      }
      waitForMarkerAbsent(memoraxCodeHome, state.repo);
    }
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

test("repo memory update worker prompt follows updater history policy", (t) => {
  const root = tempRoot(t, "repo-memory-job-update-prompt-");
  const repo = join(root, "repo");
  const memoraxCodeHome = join(root, "memorax-code");
  const head = initRepo(repo);
  writeProfile(repo, head);

  const result = runJob(["start", "--mode", "update", "--repo", repo, "--dry-run"], { MEMORAX_CODE_HOME: memoraxCodeHome });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);

  assert.equal(payload.ok, true);
  assert.equal(payload.mode, "update");
  assert.match(payload.prompt, /repo-update operation/);
  assert.match(payload.prompt, /packaged repo-update detector's effective history policy/);
  assert.match(payload.prompt, /Do not re-enable commit or provider evidence channels disabled by repoHistory\.mode/);
  assert.doesNotMatch(payload.prompt, /Detect local commit delta from the stored baseline/);
  assert.doesNotMatch(payload.prompt, /Also try GitHub\/GitLab PR, MR, and issue evidence/);
  assert.equal(countJobDirs(memoraxCodeHome), 0);
});

test("repo memory maintain dry-run selects build for a missing bundle without creating job state", (t) => {
  const root = tempRoot(t, "repo-memory-maintain-missing-");
  const repo = join(root, "repo");
  const memoraxCodeHome = join(root, "memorax-code");
  initRepo(repo);

  const result = runJob(["maintain", "--repo", repo, "--dry-run"], {
    MEMORAX_CODE_HOME: memoraxCodeHome,
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.job.ok, true);
  assert.equal(payload.job.runner, "fixture");
  assert.equal(payload.job.finalMessageSource, "file");
  assert.equal(payload.job.repo, repo);
  assert.match(payload.job.prompt, /\/fixture-memory/);
  assert.match(payload.job.prompt, /repo-build operation/);
  assert.match(payload.job.prompt, new RegExp(runGit(repo, ["rev-parse", "HEAD"]).trim()));
  assert.match(payload.job.prompt, /authorized background repo-memory worker/);
  assert.match(payload.job.prompt, /GitHub\/GitLab PR, MR, and issue evidence/);
  assert.match(payload.job.prompt, /repo-memory\.mjs collect --reuse/);
  assert.match(payload.job.prompt, /procedure-memory/);
  assert.match(payload.job.prompt, /user-profile/);
  assert.equal(payload.schema, "repo_memory_maintenance_decision.v1");
  assert.equal(payload.ok, true);
  assert.equal(payload.action, "build");
  assert.equal(payload.reason, "bundle_missing");
  assert.equal(payload.bundleStatus, "missing");
  assert.equal(payload.job.dryRun, true);
  assert.equal(payload.job.mode, "build");
  assert.equal(countJobDirs(memoraxCodeHome), 0);
});

test("repo memory maintain selects build when the validator rejects the bundle", (t) => {
  const root = tempRoot(t, "repo-memory-maintain-invalid-");
  const repo = join(root, "repo");
  const memoraxCodeHome = join(root, "memorax-code");
  const head = initRepo(repo);
  writeProfile(repo, head);

  const result = runJob(["maintain", "--repo", repo, "--dry-run"], {
    MEMORAX_CODE_HOME: memoraxCodeHome,
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.action, "build");
  assert.equal(payload.reason, "bundle_invalid");
  assert.equal(payload.bundleStatus, "invalid");
  assert.equal(payload.validation.ok, false);
  assert.equal(payload.job.mode, "build");
  assert.equal(countJobDirs(memoraxCodeHome), 0);
});

test("repo memory maintain returns no-op for a usable fresh bundle", (t) => {
  const root = tempRoot(t, "repo-memory-maintain-fresh-");
  const repo = join(root, "repo");
  const memoraxCodeHome = join(root, "memorax-code");
  const head = initRepo(repo);
  writeValidatedProfile(repo, head);

  const result = runJob(["maintain", "--repo", repo, "--dry-run"], {
    MEMORAX_CODE_HOME: memoraxCodeHome,
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.action, "none");
  assert.equal(payload.reason, "up_to_date");
  assert.equal(payload.bundleStatus, "usable");
  assert.equal(payload.validation.ok, true);
  assert.equal(payload.policyDecision.trigger, false);
  assert.equal(payload.policyDecision.commitsBehind, 0);
  assert.equal(payload.job, undefined);
  assert.equal(countJobDirs(memoraxCodeHome), 0);
});

test("repo memory maintain selects update when adaptive commit threshold is reached", (t) => {
  const root = tempRoot(t, "repo-memory-maintain-adaptive-");
  const repo = join(root, "repo");
  const memoraxCodeHome = join(root, "memorax-code");
  const baseline = initRepo(repo);
  writeValidatedProfile(repo, baseline);
  for (let index = 1; index <= 5; index += 1) {
    writeFileSync(join(repo, `change-${index}.txt`), `change ${index}\n`);
    runGit(repo, ["add", `change-${index}.txt`]);
    runGit(repo, ["commit", "-m", `change ${index}`]);
  }

  const result = runJob(["maintain", "--repo", repo, "--dry-run"], {
    MEMORAX_CODE_HOME: memoraxCodeHome,
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.action, "update");
  assert.equal(payload.reason, "commit_threshold_reached");
  assert.equal(payload.bundleStatus, "usable");
  assert.equal(payload.policyDecision.policy, "adaptive");
  assert.equal(payload.policyDecision.commitThreshold, 5);
  assert.equal(payload.policyDecision.commitsBehind, 5);
  assert.equal(payload.job.mode, "update");
  assert.equal(payload.job.dryRun, true);
  assert.equal(countJobDirs(memoraxCodeHome), 0);
});

test("repo memory maintain selects update when adaptive cooldown is reached", (t) => {
  const root = tempRoot(t, "repo-memory-maintain-cooldown-");
  const repo = join(root, "repo");
  const memoraxCodeHome = join(root, "memorax-code");
  const baseline = initRepo(repo);
  writeValidatedProfile(repo, baseline, { generatedAt: "2026-07-18T00:00:00Z" });
  writeFileSync(join(repo, "cooldown-change.txt"), "cooldown change\n");
  runGit(repo, ["add", "cooldown-change.txt"]);
  runGit(repo, ["commit", "-m", "cooldown change"]);

  const result = runJob([
    "maintain",
    "--repo",
    repo,
    "--dry-run",
    "--now",
    "2026-07-19T00:00:00Z",
  ], {
    MEMORAX_CODE_HOME: memoraxCodeHome,
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.action, "update");
  assert.equal(payload.reason, "cooldown_elapsed");
  assert.equal(payload.policyDecision.policy, "adaptive");
  assert.equal(payload.policyDecision.commitsBehind, 1);
  assert.equal(payload.policyDecision.ageHours, 24);
  assert.equal(payload.job.mode, "update");
  assert.equal(countJobDirs(memoraxCodeHome), 0);
});

for (const baseline of ["", "0000000000000000000000000000000000000000"]) {
  test(`repo memory maintain selects repair-capable update for baseline ${baseline ? "not ancestor" : "missing"}`, (t) => {
    const root = tempRoot(t, "repo-memory-maintain-baseline-");
    const repo = join(root, "repo");
    const memoraxCodeHome = join(root, "memorax-code");
    initRepo(repo);
    writeValidatedProfile(repo, baseline);

    const result = runJob(["maintain", "--repo", repo, "--dry-run"], {
      MEMORAX_CODE_HOME: memoraxCodeHome,
    });
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.action, "update");
    assert.equal(payload.reason, baseline ? "baseline_not_ancestor" : "missing_baseline");
    assert.equal(payload.bundleStatus, "usable");
    assert.equal(payload.policyDecision.trigger, true);
    assert.equal(payload.job.mode, "update");
    assert.equal(countJobDirs(memoraxCodeHome), 0);
  });
}

test("repo memory start and maintain reuse an active job before inspecting the bundle", (t) => {
  const root = tempRoot(t, "repo-memory-maintain-deduplicate-");
  const repo = join(root, "repo");
  const memoraxCodeHome = join(root, "memorax-code");
  initRepo(repo);
  const env = {
    MEMORAX_CODE_HOME: memoraxCodeHome,
    REPO_MEMORY_TEST_BEHAVIOR: "wait",
  };

  const started = runJob(["start", "--mode", "build", "--repo", repo], env);
  assert.equal(started.status, 0, started.stderr);
  const startedPayload = JSON.parse(started.stdout);
  assert.equal(startedPayload.alreadyRunning, false);
  assert.equal(countJobDirs(memoraxCodeHome), 1);

  const repeated = runJob(["start", "--mode", "build", "--repo", repo], env);
  assert.equal(repeated.status, 0, repeated.stderr);
  const repeatedPayload = JSON.parse(repeated.stdout);
  assert.equal(repeatedPayload.alreadyRunning, true);
  assert.equal(repeatedPayload.jobId, startedPayload.jobId);
  assert.equal(repeatedPayload.outputLogPath, startedPayload.outputLogPath);
  assert.equal(countJobDirs(memoraxCodeHome), 1);

  const maintained = runJob(["maintain", "--repo", repo, "--dry-run"], env);
  assert.equal(maintained.status, 0, maintained.stderr);
  const payload = JSON.parse(maintained.stdout);
  assert.equal(payload.action, "deduplicated");
  assert.equal(payload.reason, "active_job");
  assert.equal(payload.bundleStatus, "unchecked");
  assert.equal(payload.job.alreadyRunning, true);
  assert.equal(payload.job.jobId, startedPayload.jobId);
  assert.equal(countJobDirs(memoraxCodeHome), 1);
});

test("repo memory maintain degrades to a non-blocking no-op when policy evaluation fails", (t) => {
  const root = tempRoot(t, "repo-memory-maintain-policy-failure-");
  const repo = join(root, "repo");
  const memoraxCodeHome = join(root, "memorax-code");
  const head = initRepo(repo);
  writeValidatedProfile(repo, head);
  writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/missing\n");

  const result = runJob(["maintain", "--repo", repo, "--dry-run"], {
    MEMORAX_CODE_HOME: memoraxCodeHome,
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.action, "none");
  assert.equal(payload.reason, "policy_evaluation_failed");
  assert.equal(payload.bundleStatus, "usable");
  assert.equal(payload.job, undefined);
  assert.equal(countJobDirs(memoraxCodeHome), 0);
});

for (const expectedMode of ["build", "update"]) {
  test(`repo memory maintain launches and completes supervised ${expectedMode}`, (t) => {
    const root = tempRoot(t, `repo-memory-maintain-${expectedMode}-complete-`);
    const repo = join(root, "repo");
    const memoraxCodeHome = join(root, "memorax-code");
    const baseline = initRepo(repo);
    if (expectedMode === "update") {
      writeValidatedProfile(repo, baseline);
      for (let index = 1; index <= 5; index += 1) {
        writeFileSync(join(repo, `update-${index}.txt`), `update ${index}\n`);
        runGit(repo, ["add", `update-${index}.txt`]);
        runGit(repo, ["commit", "-m", `update ${index}`]);
      }
    }
    const head = runGit(repo, ["rev-parse", "HEAD"]).trim();
    const envLog = join(root, "worker-env.json");
    const result = runJob(["maintain", "--repo", repo], {
      MEMORAX_CODE_HOME: memoraxCodeHome,
      REPO_MEMORY_TEST_ENV_LOG: envLog,
    });
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.action, expectedMode);
    assert.equal(payload.job.mode, expectedMode);
    assert.equal(payload.job.alreadyRunning, false);

    const state = waitForTerminal(payload.job.jobPath);
    assert.equal(state.status, "succeeded", JSON.stringify(state));
    assert.equal(state.exitCode, 0);
    assert.equal(state.mode, expectedMode);
    assert.equal(state.snapshotHead, head);
    assert.equal(state.validation.ok, true);
    assert.equal(state.validation.profileHead, head);
    assert.equal(countJobDirs(memoraxCodeHome), 1);
    waitForMarkerAbsent(memoraxCodeHome, repo);

    const workerEnv = JSON.parse(readFileSync(envLog, "utf8"));
    assert.equal(workerEnv.kind, "repo-memory");
    assert.equal(workerEnv.jobId, payload.job.jobId);
    assert.match(workerEnv.runId, /^[0-9a-f]{32}$/);
    assert.equal(workerEnv.snapshotHead, head);
    assert.equal(workerEnv.mode, expectedMode);
  });
}

test("repo memory job launcher writes job state in MEMORAX_CODE_HOME", (t) => {
  const root = tempRoot(t, "repo-memory-job-state-");
  const repo = join(root, "repo");
  const memoraxCodeHome = join(root, "memorax-code");
  const head = initRepo(repo);
  writeProfile(repo, head);
  const result = runJob(["start", "--mode", "update", "--repo", repo], {
    MEMORAX_CODE_HOME: memoraxCodeHome,
    REPO_MEMORY_TEST_BEHAVIOR: "wait",
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.mode, "update");
  assert.match(payload.jobPath, /repo-memory-jobs/);
  assert.match(payload.jobId, /^\d{17}-update-repo-[0-9a-f]{8}$/);
  const state = JSON.parse(readFileSync(payload.jobPath, "utf8"));
  assert.equal(state.mode, "update");
  assert.equal(state.runner, "fixture");
  assert.equal(state.finalMessageSource, "file");
  assert.equal(state.repo, repo);
  assert.ok(["started", "running"].includes(state.status));
  assert.equal(state.snapshotHead, head);
  assert.match(state.runId, /^[0-9a-f]{32}$/);
  assert.match(state.finalMessagePath, /final-message\.txt$/);
  assert.match(state.outputLogPath, /output\.log$/);
  assert.deepEqual(state.command, [process.execPath, fixtureRunner, repo, state.finalMessagePath]);
  assert.equal(state.workerCommand[1], workerPath);
});

test("repo memory maintenance preserves a relative home when workers change cwd", (t) => {
  const root = tempRoot(t, "repo-memory-job-relative-home-");
  const repo = join(root, "repo");
  const memoraxCodeHome = join(root, "memorax-code");
  const envLog = join(root, "worker-env.json");
  initRepo(repo);

  const result = runJob(["maintain", "--repo", repo], {
    MEMORAX_CODE_HOME: "./memorax-code",
    REPO_MEMORY_TEST_ENV_LOG: envLog,
  }, { cwd: root });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.action, "build");
  assert.equal(payload.job.jobPath, join(repoMemoryJobsDir(memoraxCodeHome), payload.job.jobId, "job.json"));
  assert.equal(waitForTerminal(payload.job.jobPath).status, "succeeded");
  assert.equal(JSON.parse(readFileSync(envLog, "utf8")).memoraxCodeHome, memoraxCodeHome);
  assert.equal(existsSync(join(repo, "memorax-code")), false);
  waitForMarkerAbsent(memoraxCodeHome, repo);
});

test("repo memory job launcher allows only one concurrent startup per repo", async (t) => {
  const root = tempRoot(t, "repo-memory-job-concurrent-");
  const repo = join(root, "repo");
  const memoraxCodeHome = join(root, "memorax-code");
  initRepo(repo);
  const env = {
    MEMORAX_CODE_HOME: memoraxCodeHome,
    REPO_MEMORY_TEST_BEHAVIOR: "wait",
  };

  const results = await Promise.all(Array.from({ length: 20 }, () => runJobAsync(["start", "--mode", "build", "--repo", repo], env)));
  assert.equal(results.every((result) => result.status === 0), true, results.map((result) => result.stderr).join("\n"));
  const payloads = results.map((result) => JSON.parse(result.stdout));
  const started = payloads.filter((payload) => payload.alreadyRunning === false);
  const alreadyRunning = payloads.filter((payload) => payload.alreadyRunning === true);
  assert.equal(started.length, 1);
  assert.equal(alreadyRunning.length, 19);
  assert.equal(countJobDirs(memoraxCodeHome), 1);
  assert.equal(new Set(payloads.map((payload) => payload.jobId)).size, 1);
});

test("repo memory job launcher overwrites marker with non-running pid", (t) => {
  const root = tempRoot(t, "repo-memory-job-stale-pid-");
  const repo = join(root, "repo");
  const memoraxCodeHome = join(root, "memorax-code");
  const head = initRepo(repo);
  writeProfile(repo, head);
  writeMarker(memoraxCodeHome, repo, {
    pid: 999999999,
    startedAt: new Date().toISOString(),
  });
  const result = runJob(["start", "--mode", "update", "--repo", repo], {
    MEMORAX_CODE_HOME: memoraxCodeHome,
    REPO_MEMORY_TEST_BEHAVIOR: "wait",
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.alreadyRunning, false);
  const marker = JSON.parse(readFileSync(markerPathForRepo(memoraxCodeHome, realpathSync(repo)).markerPath, "utf8"));
  assert.equal(marker.version, 1);
  assert.equal(marker.pid, payload.pid);
  assert.equal(marker.mode, "update");
});

test("repo memory job launcher overwrites marker after TTL expires", (t) => {
  const root = tempRoot(t, "repo-memory-job-stale-ttl-");
  const repo = join(root, "repo");
  const memoraxCodeHome = join(root, "memorax-code");
  initRepo(repo);
  writeMarker(memoraxCodeHome, repo, {
    pid: process.pid,
    startedAt: "2000-01-01T00:00:00.000Z",
  });
  const result = runJob(["start", "--mode", "build", "--repo", repo], {
    MEMORAX_CODE_HOME: memoraxCodeHome,
    REPO_MEMORY_TEST_BEHAVIOR: "wait",
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.alreadyRunning, false);
  const marker = JSON.parse(readFileSync(markerPathForRepo(memoraxCodeHome, realpathSync(repo)).markerPath, "utf8"));
  assert.equal(marker.pid, payload.pid);
  assert.equal(marker.mode, "build");
});

test("repo memory job launcher does not start when startup state directory is invalid", (t) => {
  const root = tempRoot(t, "repo-memory-job-invalid-startup-state-");
  const repo = join(root, "repo");
  const memoraxCodeHome = join(root, "memorax-code");
  initRepo(repo);
  const jobsDir = repoMemoryJobsDir(memoraxCodeHome);
  mkdirSync(jobsDir, { recursive: true });
  writeFileSync(join(jobsDir, "in-progress"), "not a directory\n");
  const result = runJob(["start", "--mode", "build", "--repo", repo], {
    MEMORAX_CODE_HOME: memoraxCodeHome,
    REPO_MEMORY_TEST_BEHAVIOR: "wait",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ENOTDIR|EEXIST/);
  assert.equal(countJobDirs(memoraxCodeHome), 0);
});

test("repo memory job launcher treats fresh empty startup lockdir as initializing", (t) => {
  const root = tempRoot(t, "repo-memory-job-empty-lock-");
  const repo = join(root, "repo");
  const memoraxCodeHome = join(root, "memorax-code");
  initRepo(repo);
  const lockInfo = startupLockPathForRepo(memoraxCodeHome, realpathSync(repo));
  mkdirSync(lockInfo.lockDir, { recursive: true });
  const result = runJob(["start", "--mode", "build", "--repo", repo], {
    MEMORAX_CODE_HOME: memoraxCodeHome,
    REPO_MEMORY_TEST_BEHAVIOR: "wait",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /startup is already in progress/);
  assert.equal(existsSync(lockInfo.lockDir), true);
  assert.equal(countJobDirs(memoraxCodeHome), 0);
});

test("repo memory job launcher removes old empty startup lockdir and starts job", (t) => {
  const root = tempRoot(t, "repo-memory-job-old-empty-lock-");
  const repo = join(root, "repo");
  const memoraxCodeHome = join(root, "memorax-code");
  initRepo(repo);
  const lockInfo = startupLockPathForRepo(memoraxCodeHome, realpathSync(repo));
  mkdirSync(lockInfo.lockDir, { recursive: true });
  const old = new Date(Date.now() - 60_000);
  utimesSync(lockInfo.lockDir, old, old);
  const result = runJob(["start", "--mode", "build", "--repo", repo], {
    MEMORAX_CODE_HOME: memoraxCodeHome,
    REPO_MEMORY_TEST_BEHAVIOR: "wait",
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.alreadyRunning, false);
  assert.equal(existsSync(lockInfo.lockDir), false);
});

test("repo memory job launcher removes stale startup lock and starts job", (t) => {
  const root = tempRoot(t, "repo-memory-job-stale-lock-");
  const repo = join(root, "repo");
  const memoraxCodeHome = join(root, "memorax-code");
  initRepo(repo);
  const markerInfo = markerPathForRepo(memoraxCodeHome, realpathSync(repo));
  const lockDir = join(markerInfo.inProgressDir, `${markerInfo.repoKey}.lockdir`);
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(join(lockDir, "lock.json"), `${JSON.stringify({
    version: 1,
    repo: realpathSync(repo),
    repoKey: markerInfo.repoKey,
    pid: 999999999,
    startedAt: "2000-01-01T00:00:00.000Z",
  }, null, 2)}\n`);
  const result = runJob(["start", "--mode", "build", "--repo", repo], {
    MEMORAX_CODE_HOME: memoraxCodeHome,
    REPO_MEMORY_TEST_BEHAVIOR: "wait",
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.alreadyRunning, false);
  assert.equal(existsSync(lockDir), false);
});

test("repo memory job supervisor fails when generated artifacts do not validate", (t) => {
  const root = tempRoot(t, "repo-memory-job-validation-fail-");
  const repo = join(root, "repo");
  const memoraxCodeHome = join(root, "memorax-code");
  initRepo(repo);
  const result = runJob(["start", "--mode", "build", "--repo", repo], {
    MEMORAX_CODE_HOME: memoraxCodeHome,
    REPO_MEMORY_TEST_BEHAVIOR: "final-only",
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  const state = waitForTerminal(payload.jobPath);
  assert.equal(state.status, "failed");
  assert.equal(state.failureReason, "artifact_validation_failed");
  waitForMarkerAbsent(memoraxCodeHome, repo);
});

test("repo memory job supervisor rejects a repository HEAD change during build", (t) => {
  const root = tempRoot(t, "repo-memory-job-snapshot-change-");
  const repo = join(root, "repo");
  const memoraxCodeHome = join(root, "memorax-code");
  const launchHead = initRepo(repo);
  const result = runJob(["start", "--mode", "build", "--repo", repo], {
    MEMORAX_CODE_HOME: memoraxCodeHome,
    REPO_MEMORY_TEST_BEHAVIOR: "change-head",
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  const state = waitForTerminal(payload.jobPath);
  assert.equal(state.status, "failed");
  assert.equal(state.failureReason, "snapshot_changed");
  assert.equal(state.expectedHead, launchHead);
  assert.notEqual(state.actualHead, launchHead);
  waitForMarkerAbsent(memoraxCodeHome, repo);
});

test("repo memory job supervisor records an unexpected validation exception", (t) => {
  const root = tempRoot(t, "repo-memory-job-internal-error-");
  const repo = join(root, "repo");
  const memoraxCodeHome = join(root, "memorax-code");
  initRepo(repo);
  const result = runJob(["start", "--mode", "build", "--repo", repo], {
    MEMORAX_CODE_HOME: memoraxCodeHome,
    REPO_MEMORY_TEST_BEHAVIOR: "break-git",
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  const state = waitForTerminal(payload.jobPath);
  assert.equal(state.status, "failed");
  assert.equal(state.failureReason, "worker_internal_error");
  assert.match(state.error, /git could not resolve HEAD/);
  waitForMarkerAbsent(memoraxCodeHome, repo);
});

test("repo memory update fails before launch without an existing profile", (t) => {
  const root = tempRoot(t, "repo-memory-job-update-missing-");
  const repo = join(root, "repo");
  const memoraxCodeHome = join(root, "memorax-code");
  initRepo(repo);
  const result = runJob(["start", "--mode", "update", "--repo", repo, "--dry-run"], {
    MEMORAX_CODE_HOME: memoraxCodeHome,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /update requires an existing \.repo_memory\/PROFILE\.md/);
});

test("linked worktrees build once under concurrent maintenance and reuse the completed snapshot", async (t) => {
  const root = tempRoot(t, "repo-memory-shared-concurrent-");
  const repo = join(root, "repo"), linked = join(root, "linked"), home = join(root, "memorax-code");
  const head = initRepo(repo);
  runGit(repo, ["worktree", "add", "--detach", linked, head]);
  const env = { MEMORAX_CODE_HOME: home };
  const results = await Promise.all([repo, linked].map(path => runJobAsync(["maintain", "--repo", path], env)));
  for (const result of results) assert.equal(result.status, 0, result.stderr);
  const decisions = results.map(result => JSON.parse(result.stdout));
  const launched = decisions.find(result => result.action === "build");
  assert.ok(launched);
  assert.equal(decisions.filter(result => result.action === "build").length, 1);
  const completed = waitForTerminal(launched.job.jobPath);
  assert.equal(completed.status, "succeeded");
  assert.equal(completed.sharedBaselinePublished, true);
  waitForMarkerAbsent(home, launched.job.repo);
  const other = launched.job.repo === repo ? linked : repo;
  const result = runJob(["maintain", "--repo", other], env);
  assert.equal(result.status, 0, result.stderr);
  const decision = JSON.parse(result.stdout);
  assert.equal(decision.action, "none");
  assert.ok(["shared_bundle_reused", "shared_baseline_in_use"].includes(decision.reason));
  assert.equal(countJobDirs(home), 1);
  assert.equal(readFileSync(join(other, ".repo_memory/PROFILE.md"), "utf8"), readFileSync(join(launched.job.repo, ".repo_memory/PROFILE.md"), "utf8"));
  assert.equal(readSharedRepoMemory(home, other).head, head);
  assert.match(readFileSync(join(other, ".gitignore"), "utf8"), /^\.repo_memory\/$/m);
});

test("shared snapshots survive source bundle removal and exclude personal sidecars", (t) => {
  const root = tempRoot(t, "repo-memory-shared-copy-");
  const repo = join(root, "repo"), linked = join(root, "linked"), home = join(root, "memorax-code");
  const head = initRepo(repo);
  runGit(repo, ["worktree", "add", "-b", "feature", linked, head]);
  writeValidatedProfile(repo, head);
  mkdirSync(join(repo, ".repo_memory/procedure-memory"));
  writeFileSync(join(repo, ".repo_memory/procedure-memory/private.md"), "private fixture");
  writeFileSync(join(repo, ".repo_memory/architecture.md"), "# Architecture fixture\n");
  const env = { MEMORAX_CODE_HOME: home };
  assert.equal(runJob(["maintain", "--repo", repo], env).status, 0);
  assert.ok(readSharedRepoMemory(home, linked));
  rmSync(join(repo, ".repo_memory"), { recursive: true });
  const result = runJob(["maintain", "--repo", linked], env);
  assert.equal(JSON.parse(result.stdout).reason, "shared_bundle_reused");
  assert.equal(readFileSync(join(linked, ".repo_memory/architecture.md"), "utf8"), "# Architecture fixture\n");
  assert.equal(existsSync(join(linked, ".repo_memory/procedure-memory")), false);
  assert.equal(countJobDirs(home), 0);
});

test("shared reuse leaves dry-runs, dirty worktrees, and existing local files untouched", (t) => {
  const root = tempRoot(t, "repo-memory-shared-boundaries-");
  const repo = join(root, "repo"), linked = join(root, "linked"), home = join(root, "memorax-code");
  const head = initRepo(repo);
  runGit(repo, ["worktree", "add", "--detach", linked, head]);
  writeValidatedProfile(repo, head);
  const env = { MEMORAX_CODE_HOME: home };
  runJob(["maintain", "--repo", repo], env);
  const maintain = (extra = []) => JSON.parse(runJob(["maintain", "--repo", linked, ...extra], env).stdout);
  assert.equal(maintain(["--dry-run"]).reason, "shared_bundle_reused");
  assert.equal(existsSync(join(linked, ".repo_memory")), false);
  writeFileSync(join(linked, "untracked.txt"), "local work");
  assert.equal(maintain().reason, "worktree_dirty");
  assert.equal(existsSync(join(linked, ".repo_memory")), false);
  rmSync(join(linked, "untracked.txt"));
  mkdirSync(join(linked, ".repo_memory"));
  writeFileSync(join(linked, ".repo_memory/notes.md"), "local notes");
  assert.equal(maintain().reason, "local_bundle_exists");
  assert.equal(readFileSync(join(linked, ".repo_memory/notes.md"), "utf8"), "local notes");
  assert.equal(countJobDirs(home), 0);
});

test("descendant commits borrow the baseline and independent repositories never share", (t) => {
  const root = tempRoot(t, "repo-memory-shared-identity-");
  const repo = join(root, "repo"), linked = join(root, "linked"), independent = join(root, "independent"), home = join(root, "memorax-code");
  const head = initRepo(repo);
  runGit(repo, ["worktree", "add", "--detach", linked, head]);
  writeValidatedProfile(repo, head);
  const env = { MEMORAX_CODE_HOME: home };
  runJob(["maintain", "--repo", repo], env);
  writeFileSync(join(linked, "new.txt"), "new commit");
  runGit(linked, ["add", "new.txt"]); runGit(linked, ["commit", "-m", "feature change"]);
  const changed = JSON.parse(runJob(["maintain", "--repo", linked], env).stdout);
  assert.equal(changed.reason, "shared_bundle_borrowed");
  assert.deepEqual(changed.sharedBaseline.changes, [{ status: "A", path: "new.txt" }]);
  assert.equal(changed.job, undefined);
  runGit(repo, ["clone", "--no-hardlinks", repo, independent]);
  assert.equal(runGit(independent, ["rev-parse", "HEAD"]).trim(), head);
  const separate = JSON.parse(runJob(["maintain", "--repo", independent, "--dry-run"], env).stdout);
  assert.equal(separate.action, "build");
  assert.equal(countJobDirs(home), 0);
});

test("borrowed ancestor maps preserve provenance and never trigger policy updates as commits and time advance", (t) => {
  const f = sharedFixture(t);
  const original = readFileSync(join(f.repo, ".repo_memory/PROFILE.md"), "utf8");
  for (let index = 0; index < 6; index++) f.commit("feature.txt", `# Feature ${index}\n`);
  const dry = f.maintain(["--dry-run"]);
  assert.equal(dry.reason, "shared_bundle_borrowed");
  assert.equal(existsSync(join(f.linked, ".repo_memory")), false);
  const restored = f.maintain();
  assert.equal(restored.reason, "shared_bundle_borrowed");
  assert.deepEqual(restored.sharedBaseline.changes, [{ status: "M", path: "feature.txt" }]);
  assert.equal(restored.sharedBaseline.changedLines, 2);
  assert.equal(restored.sharedBaseline.baseHead, f.head);
  assert.equal(restored.sharedBaseline.head, runGit(f.linked, ["rev-parse", "HEAD"]).trim());
  assert.equal(readFileSync(join(f.linked, ".repo_memory/PROFILE.md"), "utf8"), original);
  for (let index = 0; index < 2; index++) {
    f.commit("local change.txt", `change ${index}\n`);
    const next = f.maintain(["--now", "2099-01-01T00:00:00Z"]);
    assert.equal(next.reason, "shared_baseline_in_use");
    assert.equal(next.action, "none");
    assert.equal(next.job, undefined);
    assert.equal(next.policyDecision, undefined);
  }
  rmSync(readSharedRepoMemory(f.home, f.repo).path, { recursive: true });
  assert.equal(f.maintain().reason, "shared_baseline_in_use", "borrowed copies survive cache removal");
  assert.equal(countJobDirs(f.home), 0);
});

test("same-commit copies stay borrowed when their worktree later advances", (t) => {
  const f = sharedFixture(t);
  assert.equal(f.maintain().reason, "shared_bundle_reused");
  f.commit("feature.txt", "# Feature\n");
  assert.equal(f.maintain(["--now", "2099-01-01T00:00:00Z"]).reason, "shared_baseline_in_use");
  assert.equal(countJobDirs(f.home), 0);
});

for (const borrowed of [false, true]) {
  for (const scenario of ["diverged", "dirty", "deleted", "renamed", "manifest", "binary", "files", "lines"]) {
    test(`shared ancestor reuse defers ${scenario} changes ${borrowed ? "after" : "before"} materialization`, (t) => {
      const f = sharedFixture(t);
      if (borrowed) assert.equal(f.maintain().reason, "shared_bundle_reused");
      let reason = "shared_delta_incompatible";
      if (scenario === "diverged") {
        runGit(f.linked, ["checkout", "--orphan", "unrelated"]);
        runGit(f.linked, ["commit", "-m", "unrelated history"]);
        reason = "shared_snapshot_mismatch";
      } else if (scenario === "dirty") {
        writeFileSync(join(f.linked, "README.md"), "uncommitted change");
        reason = "worktree_dirty";
      } else if (scenario === "deleted" || scenario === "renamed") {
        runGit(f.linked, scenario === "deleted" ? ["rm", "README.md"] : ["mv", "README.md", "GUIDE.md"]);
        runGit(f.linked, ["commit", "-m", scenario]);
      } else if (scenario === "manifest") f.commit("package.json", '{"type":"module"}\n');
      else if (scenario === "binary") f.commit("binary.dat", Buffer.from([0, 1, 2]));
      else if (scenario === "files") {
        for (let index = 0; index < 21; index++) writeFileSync(join(f.linked, `file-${index}.txt`), "added\n");
        runGit(f.linked, ["add", "*.txt"]); runGit(f.linked, ["commit", "-m", "many files"]);
        reason = "shared_delta_too_large";
      } else {
        f.commit("large.txt", "line\n".repeat(1001));
        reason = "shared_delta_too_large";
      }
      const result = f.maintain();
      assert.equal(result.reason, reason);
      assert.equal(result.action, "none");
      assert.equal(result.job, undefined);
      assert.equal(existsSync(join(f.linked, ".repo_memory/PROFILE.md")), borrowed);
      assert.equal(countJobDirs(f.home), 0);
    });
  }
}

test("invalid borrowed metadata and artifacts never fall through to an automatic build or update", (t) => {
  const f = sharedFixture(t);
  f.maintain();
  const recordPath = join(f.linked, ".repo_memory/shared-baseline.json");
  const original = readFileSync(recordPath, "utf8");
  writeFileSync(recordPath, "invalid JSON");
  assert.equal(f.maintain().reason, "shared_bundle_unavailable");
  writeFileSync(recordPath, JSON.stringify({ ...JSON.parse(original), repository: f.linked }));
  assert.equal(f.maintain().reason, "shared_bundle_unavailable");
  writeFileSync(recordPath, original);
  f.commit("feature.txt", "updated source\n");
  writeValidatedProfile(f.linked, runGit(f.linked, ["rev-parse", "HEAD"]).trim());
  assert.equal(f.maintain().reason, "shared_bundle_invalid", "partial authoring must not silently promote ownership");
  rmSync(join(f.linked, ".repo_memory/PROFILE.md"));
  assert.equal(f.maintain().reason, "shared_bundle_invalid");
  assert.equal(countJobDirs(f.home), 0);
});

test("borrowed deltas preserve unusual Git paths and accept the text budget boundary", (t) => {
  const f = sharedFixture(t), name = process.platform === "win32" ? "odd name.txt" : "odd\tline\nname.txt";
  f.commit(name, "line\n".repeat(1000));
  const result = f.maintain();
  assert.equal(result.reason, "shared_bundle_borrowed");
  assert.deepEqual(result.sharedBaseline.changes, [{ status: "A", path: name }]);
  assert.equal(result.sharedBaseline.changedLines, 1000);
});

test("borrowed maps reject executable-mode changes", { skip: process.platform === "win32" }, (t) => {
  const f = sharedFixture(t);
  chmodSync(join(f.linked, "feature.txt"), 0o755);
  runGit(f.linked, ["add", "feature.txt"]); runGit(f.linked, ["commit", "-m", "executable change"]);
  assert.equal(f.maintain().reason, "shared_delta_incompatible");
  assert.equal(countJobDirs(f.home), 0);
});

test("borrowed maps detect Git links even when user diff configuration hides submodules", (t) => {
  const f = sharedFixture(t);
  runGit(f.linked, ["config", "diff.ignoreSubmodules", "all"]);
  runGit(f.linked, ["update-index", "--add", "--cacheinfo", `160000,${f.head},linked-module`]);
  runGit(f.linked, ["commit", "-m", "add module boundary"]);
  assert.equal(f.maintain().reason, "shared_delta_incompatible");
  assert.equal(countJobDirs(f.home), 0);
});

test("failed explicit authoring retains the borrowed record and automatic suppression", (t) => {
  const f = sharedFixture(t);
  f.maintain();
  f.commit("feature.txt", "feature\n");
  const job = JSON.parse(runJob(["start", "--mode", "update", "--repo", f.linked], {
    MEMORAX_CODE_HOME: f.home, REPO_MEMORY_TEST_BEHAVIOR: "final-only",
  }).stdout);
  assert.equal(waitForTerminal(job.jobPath).status, "failed");
  waitForMarkerAbsent(f.home, f.linked);
  assert.equal(existsSync(join(f.linked, ".repo_memory/shared-baseline.json")), true);
  assert.equal(f.maintain(["--now", "2099-01-01T00:00:00Z"]).reason, "shared_baseline_in_use");
  assert.equal(countJobDirs(f.home), 1);
});

test("explicit update promotes a borrowed copy to local maintenance without replacing the shared baseline", (t) => {
  const f = sharedFixture(t);
  f.maintain();
  f.commit("feature.txt", "# Feature\n");
  const baselinePath = readSharedRepoMemory(f.home, f.repo).path;
  const original = readFileSync(join(baselinePath, ".repo_memory/PROFILE.md"), "utf8");
  const job = JSON.parse(runJob(["start", "--mode", "update", "--repo", f.linked], { MEMORAX_CODE_HOME: f.home }).stdout);
  assert.equal(waitForTerminal(job.jobPath).status, "succeeded");
  waitForMarkerAbsent(f.home, f.linked);
  assert.equal(existsSync(join(f.linked, ".repo_memory/shared-baseline.json")), false);
  assert.equal(readFileSync(join(baselinePath, ".repo_memory/PROFILE.md"), "utf8"), original);
  assert.equal(f.maintain().reason, "up_to_date");
});

test("ancestor restoration rechecks the target snapshot after staged validation", (t) => {
  const f = sharedFixture(t);
  f.commit("feature.txt", "# Feature\n");
  const baseline = readSharedRepoMemory(f.home, f.linked);
  const result = restoreSharedRepoMemory({ baseline, repo: f.linked, validate: (path) => {
    if (path !== baseline.path) runGit(f.linked, ["commit", "--allow-empty", "-m", "raced snapshot"]);
    return { status: "usable" };
  } });
  assert.equal(result.reason, "shared_snapshot_mismatch");
  assert.equal(existsSync(join(f.linked, ".repo_memory")), false);
  assert.equal(readdirSync(f.linked).some(name => name.startsWith(".repo-memory-reuse-")), false);
});

function sharedFixture(t) {
  const root = tempRoot(t, "repo-memory-borrowed-");
  const repo = join(root, "repo"), linked = join(root, "linked"), home = join(root, "memorax-code");
  initRepo(repo);
  writeFileSync(join(repo, "feature.txt"), "initial feature\n");
  runGit(repo, ["add", "feature.txt"]); runGit(repo, ["commit", "-m", "fixture source"]);
  const head = runGit(repo, ["rev-parse", "HEAD"]).trim();
  runGit(repo, ["worktree", "add", "--detach", linked, head]);
  writeValidatedProfile(repo, head);
  assert.equal(runJob(["maintain", "--repo", repo], { MEMORAX_CODE_HOME: home }).status, 0);
  return { repo, linked, home, head,
    maintain: (args = []) => {
      const result = runJob(["maintain", "--repo", linked, ...args], { MEMORAX_CODE_HOME: home });
      assert.ok(result.stdout, result.stderr);
      return JSON.parse(result.stdout);
    },
    commit: (name, text) => {
      writeFileSync(join(linked, name), text);
      runGit(linked, ["add", name]); runGit(linked, ["commit", "-m", "feature change"]);
    },
  };
}

test("failed builds and dirty source snapshots do not publish a shared baseline", (t) => {
  const root = tempRoot(t, "repo-memory-shared-publish-");
  const repo = join(root, "repo"), home = join(root, "memorax-code");
  initRepo(repo);
  const failed = JSON.parse(runJob(["start", "--mode", "build", "--repo", repo], {
    MEMORAX_CODE_HOME: home, REPO_MEMORY_TEST_BEHAVIOR: "final-only",
  }).stdout);
  assert.equal(waitForTerminal(failed.jobPath).status, "failed");
  waitForMarkerAbsent(home, repo);
  assert.equal(readSharedRepoMemory(home, repo), undefined);
  writeFileSync(join(repo, "README.md"), "uncommitted changes");
  const deferred = JSON.parse(runJob(["maintain", "--repo", repo], { MEMORAX_CODE_HOME: home }).stdout);
  assert.equal(deferred.reason, "worktree_dirty");
  const explicit = JSON.parse(runJob(["start", "--mode", "build", "--repo", repo], { MEMORAX_CODE_HOME: home }).stdout);
  assert.equal(waitForTerminal(explicit.jobPath).status, "succeeded");
  assert.equal(readSharedRepoMemory(home, repo), undefined);
});

test("an invalid shared bundle never starts another background build", (t) => {
  const root = tempRoot(t, "repo-memory-shared-invalid-");
  const repo = join(root, "repo"), linked = join(root, "linked"), home = join(root, "memorax-code");
  const head = initRepo(repo);
  runGit(repo, ["worktree", "add", "--detach", linked, head]);
  writeValidatedProfile(repo, head);
  const env = { MEMORAX_CODE_HOME: home };
  runJob(["maintain", "--repo", repo], env);
  const baseline = readSharedRepoMemory(home, linked);
  const unavailable = runRepoMemoryJob(["maintain", "--repo", linked], {
    runner: "fixture", memoraxCodeHome: home, validatorPath: join(root, "missing-validator.mjs"),
    evaluateRepository: () => assert.fail("must not evaluate local policy"),
    createCommand: () => assert.fail("must not launch a replacement build"),
  });
  assert.equal(unavailable.reason, "shared_bundle_unavailable");
  assert.equal(unavailable.ok, false);
  writeFileSync(join(baseline.path, ".repo_memory/PROFILE.md"), "invalid fixture");
  const result = JSON.parse(runJob(["maintain", "--repo", linked], env).stdout);
  assert.equal(result.reason, "shared_bundle_invalid");
  assert.equal(result.ok, false);
  assert.equal(countJobDirs(home), 0);
  assert.equal(existsSync(join(linked, ".repo_memory")), false);
});

test("shared restoration rejects bundle links without copying their targets", { skip: process.platform === "win32" }, (t) => {
  const root = tempRoot(t, "repo-memory-shared-symlink-");
  const repo = join(root, "repo"), linked = join(root, "linked"), home = join(root, "memorax-code");
  const head = initRepo(repo);
  runGit(repo, ["worktree", "add", "--detach", linked, head]);
  writeValidatedProfile(repo, head);
  const env = { MEMORAX_CODE_HOME: home };
  runJob(["maintain", "--repo", repo], env);
  const baseline = readSharedRepoMemory(home, linked);
  const external = join(root, "outside.txt");
  writeFileSync(external, "private fixture");
  symlinkSync(external, join(baseline.path, ".repo_memory/external.txt"));
  const result = JSON.parse(runJob(["maintain", "--repo", linked], env).stdout);
  assert.equal(result.reason, "shared_bundle_unavailable");
  assert.equal(result.ok, false);
  assert.equal(existsSync(join(linked, ".repo_memory")), false);
  assert.equal(readdirSync(linked).some(name => name.startsWith(".repo-memory-reuse-")), false);
  assert.equal(countJobDirs(home), 0);
  rmSync(join(baseline.path, ".repo_memory/external.txt"));
  symlinkSync(join(root, "missing"), join(linked, ".repo_memory"));
  const preserved = JSON.parse(runJob(["maintain", "--repo", linked], env).stdout);
  assert.equal(preserved.reason, "local_bundle_exists");
  assert.equal(readdirSync(linked).includes(".repo_memory"), true);
});

test("publication checks the copied PROFILE snapshot after canonical validation", (t) => {
  const root = tempRoot(t, "repo-memory-shared-stage-head-");
  const repo = join(root, "repo"), home = join(root, "memorax-code");
  const head = initRepo(repo);
  writeValidatedProfile(repo, head);
  const published = publishSharedRepoMemory({ home, repo, head, shareable: true, validate: (stage) => {
    writeValidatedProfile(stage, "0".repeat(40));
    return true;
  } });
  assert.equal(published, false);
  assert.equal(readSharedRepoMemory(home, repo), undefined);
});

test("conflicting linked-worktree metadata cannot select another repository's shared storage", (t) => {
  const root = tempRoot(t, "repo-memory-shared-metadata-");
  const repo = join(root, "repo"), linked = join(root, "linked"), other = join(root, "other"), home = join(root, "memorax-code");
  const head = initRepo(repo);
  initRepo(other);
  runGit(repo, ["worktree", "add", "--detach", linked, head]);
  const gitDir = readFileSync(join(linked, ".git"), "utf8").trim().slice(8);
  writeFileSync(join(gitDir, "commondir"), join(other, ".git") + "\n");
  const result = runJob(["maintain", "--repo", linked], { MEMORAX_CODE_HOME: home });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /invalid Repo Memory linked worktree metadata/);
  assert.equal(countJobDirs(home), 0);
});

function initRepo(repo) {
  mkdirSync(repo, { recursive: true });
  runGit(repo, ["init"]);
  runGit(repo, ["config", "user.name", "Repo Memory Test"]);
  runGit(repo, ["config", "user.email", "repo-memory@example.invalid"]);
  writeFileSync(join(repo, "README.md"), "# Test Repo\n");
  runGit(repo, ["add", "README.md"]);
  runGit(repo, ["commit", "-m", "initial"]);
  return runGit(repo, ["rev-parse", "HEAD"]).trim();
}

function runGit(repo, args) {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

function writeProfile(repo, head) {
  mkdirSync(join(repo, ".repo_memory"), { recursive: true });
  writeFileSync(join(repo, ".repo_memory", "PROFILE.md"), `---\nlocal_head: "${head}"\n---\n# Profile\n`);
}

function writeValidatedProfile(repo, head, options = {}) {
  mkdirSync(join(repo, ".repo_memory"), { recursive: true });
  const generatedAt = options.generatedAt ? `generated_at: "${options.generatedAt}"\n` : "";
  writeFileSync(join(repo, ".repo_memory", "PROFILE.md"), `---\nfixture_valid: true\n${generatedAt}local_head: "${head}"\n---\n# Profile\n`);
}

function writeMarker(memoraxCodeHome, repo, overrides = {}) {
  const repoRealpath = realpathSync(repo);
  const markerInfo = markerPathForRepo(memoraxCodeHome, repoRealpath);
  mkdirSync(markerInfo.inProgressDir, { recursive: true });
  writeFileSync(markerInfo.markerPath, `${JSON.stringify({
    version: 1,
    repo: repoRealpath,
    repoKey: markerInfo.repoKey,
    mode: "build",
    jobId: "existing-job",
    jobPath: join(repoMemoryJobsDir(memoraxCodeHome), "existing-job", "job.json"),
    outputLogPath: join(repoMemoryJobsDir(memoraxCodeHome), "existing-job", "output.log"),
    finalMessagePath: join(repoMemoryJobsDir(memoraxCodeHome), "existing-job", "final-message.txt"),
    pid: process.pid,
    runner: "fixture",
    runId: "existing-run",
    startedAt: new Date().toISOString(),
    ...overrides,
  }, null, 2)}\n`);
}

function killMaybe(pid) {
  try {
    process.kill(pid);
  } catch {
    // Test cleanup only.
  }
}

function killAndWait(pid, jobPath) {
  if (process.platform === "win32") {
    // Forced termination cannot run the worker's SIGTERM finalizer on Windows.
    // Scheduling assertions are complete; terminate only this fixture's process tree.
    const result = spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return;
  }
  killMaybe(pid);
  const state = waitForTerminal(jobPath);
  assert.equal(state.status, "failed");
  assert.equal(state.failureReason, "worker_interrupted");
}

function waitForTerminal(jobPath, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = JSON.parse(readFileSync(jobPath, "utf8"));
    if (state.status === "succeeded" || state.status === "failed") return state;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for repo memory job: ${jobPath}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
}

function waitForMarkerAbsent(memoraxCodeHome, repo, timeoutMs = 2_000) {
  const markerPath = markerPathForRepo(memoraxCodeHome, realpathSync(repo)).markerPath;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!existsSync(markerPath)) return;
    if (Date.now() >= deadline) {
      assert.equal(existsSync(markerPath), false);
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
}

function countJobDirs(memoraxCodeHome) {
  const jobsDir = repoMemoryJobsDir(memoraxCodeHome);
  if (!existsSync(jobsDir)) return 0;
  return readdirSync(jobsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== "in-progress")
    .length;
}
