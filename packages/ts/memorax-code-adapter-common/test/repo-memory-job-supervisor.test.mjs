import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { buildPrompt, updatePrompt } from "../src/repo-memory/repo-memory-job-supervisor.mjs";
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

test("shared repo memory prompts preserve provider collection while fixing the Git snapshot", () => {
  const repo = "/fixture/source";
  const head = "a".repeat(40);
  const snapshot = { baseHead: "b".repeat(40), root: repo };
  for (const prompt of [buildPrompt(repo, head, "$memorax-code", snapshot), updatePrompt(repo, head, "$memorax-code", snapshot)]) {
    assert.match(prompt, new RegExp(`Snapshot HEAD: ${head}`));
    assert.match(prompt, /Do not run Git network operations or change Git refs/);
    assert.match(prompt, /packaged (?:collector|detector).*GitHub\/GitLab PR, MR, and issue evidence/);
    assert.match(prompt, /including branch and commit metadata/);
    assert.match(prompt, /when enabled by the history policy and provider access is available/);
    assert.doesNotMatch(prompt, /do not contact Git remotes/i);
  }
});

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

  const result = runJob(["start", "--mode", "build", "--repo", repo], {
    MEMORAX_CODE_HOME: "./memorax-code",
    REPO_MEMORY_TEST_ENV_LOG: envLog,
  }, { cwd: root });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.mode, "build");
  assert.equal(payload.jobPath, join(repoMemoryJobsDir(memoraxCodeHome), payload.jobId, "job.json"));
  assert.equal(waitForTerminal(payload.jobPath).status, "succeeded");
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
