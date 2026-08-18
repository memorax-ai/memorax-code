import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  markerPathForRepo,
  readActiveRepoMemoryJobMarker,
  releaseRepoMemoryStartupLock,
  repoMemoryJobsDir,
  startupLockPathForRepo,
  tryAcquireRepoMemoryStartupLock,
} from "../../memorax-code-adapter-common/src/repo-memory/repo-memory-job-marker.mjs";

const jobHook = fileURLToPath(new URL("../hooks/repo-memory-job.mjs", import.meta.url));

function runJob(args, env = {}) {
  return spawnSync(process.execPath, [jobHook, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function runJobAsync(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [jobHook, ...args], {
      env: { ...process.env, ...env },
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

function tempRoot(prefix) {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

test("repo memory job launcher writes dry-run command with danger-full-access", () => {
  const root = tempRoot("repo-memory-job-");
  const repo = join(root, "repo");
  const memoraxCodeHome = join(root, "memorax-code");
  const head = initRepo(repo);
  const result = runJob(["start", "--mode", "build", "--repo", repo, "--dry-run"], { MEMORAX_CODE_HOME: memoraxCodeHome });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.mode, "build");
  assert.equal(payload.runner, "codex");
  assert.equal(payload.finalMessageSource, "file");
  assert.equal(payload.repo, repo);
  assert.equal(dirname(dirname(payload.jobPath)), repoMemoryJobsDir(memoraxCodeHome));
  assert.deepEqual(payload.command.slice(0, 6), ["codex", "exec", "--cd", repo, "--sandbox", "danger-full-access"]);
  assert.ok(payload.command.includes("--output-last-message"));
  assert.match(payload.prompt, /\$memorax-code/);
  assert.match(payload.prompt, /repo-build operation/);
  assert.match(payload.prompt, new RegExp(head));
  assert.match(payload.prompt, /authorized background repo-memory worker/);
  assert.match(payload.prompt, /GitHub\/GitLab PR, MR, and issue evidence/);
  assert.match(payload.prompt, /collect_all\.py --reuse/);
  assert.match(payload.prompt, /procedure-memory/);
  assert.match(payload.prompt, /user-profile/);
  assert.equal(payload.snapshotHead, head);
  assert.match(
    payload.workerCommand[1],
    /memorax-code-adapter-common[\\/]src[\\/]repo-memory[\\/]repo-memory-job-worker\.mjs$/,
  );
});

test("repo memory update worker prompt follows updater history policy", () => {
  const root = tempRoot("repo-memory-job-update-prompt-");
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

test("repo memory job launcher resolves Codex from installed plugin metadata", () => {
  const root = tempRoot("repo-memory-job-codex-metadata-");
  const repo = join(root, "repo");
  const pluginRoot = join(root, "plugin");
  const codexCommand = join(root, "Codex.app", "Contents", "Resources", "codex");
  initRepo(repo);
  mkdirSync(pluginRoot, { recursive: true });
  mkdirSync(join(root, "Codex.app", "Contents", "Resources"), { recursive: true });
  writeFileSync(codexCommand, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(join(pluginRoot, ".memorax-code-package.json"), `${JSON.stringify({
    version: 1,
    codexCommand,
  }, null, 2)}\n`);

  const result = runJob(["start", "--mode", "build", "--repo", repo, "--dry-run"], {
    MEMORAX_CODE_HOME: join(root, "memorax-code"),
    PLUGIN_ROOT: pluginRoot,
    MEMORAX_CODE_CODEX_COMMAND: "",
    CODEX_CLI_PATH: "",
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.command[0], codexCommand);
});

test("repo memory maintain dry-run selects build for a missing bundle without creating job state", () => {
  const root = tempRoot("repo-memory-maintain-missing-");
  const repo = join(root, "repo");
  const memoraxCodeHome = join(root, "memorax-code");
  initRepo(repo);

  const result = runJob(["maintain", "--repo", repo, "--dry-run"], {
    MEMORAX_CODE_HOME: memoraxCodeHome,
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.schema, "repo_memory_maintenance_decision.v1");
  assert.equal(payload.ok, true);
  assert.equal(payload.action, "build");
  assert.equal(payload.reason, "bundle_missing");
  assert.equal(payload.bundleStatus, "missing");
  assert.equal(payload.job.dryRun, true);
  assert.equal(payload.job.mode, "build");
  assert.equal(countJobDirs(memoraxCodeHome), 0);
});

test("repo memory maintain selects build for a structurally invalid bundle", () => {
  const root = tempRoot("repo-memory-maintain-invalid-");
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

test("repo memory maintain returns no-op for a usable fresh bundle", () => {
  const root = tempRoot("repo-memory-maintain-fresh-");
  const repo = join(root, "repo");
  const memoraxCodeHome = join(root, "memorax-code");
  const head = initRepo(repo);
  writeValidMemoryBundle(repo, head);

  const result = runJob(["maintain", "--repo", repo, "--dry-run"], {
    MEMORAX_CODE_HOME: memoraxCodeHome,
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.action, "none");
  assert.equal(payload.reason, "up_to_date");
  assert.equal(payload.bundleStatus, "usable");
  assert.equal(payload.policyDecision.trigger, false);
  assert.equal(payload.policyDecision.commitsBehind, 0);
  assert.equal(payload.job, undefined);
  assert.equal(countJobDirs(memoraxCodeHome), 0);
});

test("repo memory maintain selects update when adaptive commit threshold is reached", () => {
  const root = tempRoot("repo-memory-maintain-adaptive-");
  const repo = join(root, "repo");
  const memoraxCodeHome = join(root, "memorax-code");
  const baseline = initRepo(repo);
  writeValidMemoryBundle(repo, baseline);
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

test("repo memory maintain selects update when adaptive cooldown is reached", () => {
  const root = tempRoot("repo-memory-maintain-cooldown-");
  const repo = join(root, "repo");
  const memoraxCodeHome = join(root, "memorax-code");
  const baseline = initRepo(repo);
  writeValidMemoryBundle(repo, baseline, { generatedAt: "2026-07-18T00:00:00Z" });
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
  test(`repo memory maintain selects repair-capable update for baseline ${baseline ? "not ancestor" : "missing"}`, () => {
    const root = tempRoot("repo-memory-maintain-baseline-");
    const repo = join(root, "repo");
    const memoraxCodeHome = join(root, "memorax-code");
    initRepo(repo);
    writeValidMemoryBundle(repo, baseline);

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

test("repo memory maintain deduplicates against an active job before inspecting the bundle", () => {
  const root = tempRoot("repo-memory-maintain-deduplicate-");
  const repo = join(root, "repo");
  const memoraxCodeHome = join(root, "memorax-code");
  initRepo(repo);
  const fakeCodex = writeLongRunningFakeCodex(root);
  const env = {
    MEMORAX_CODE_HOME: memoraxCodeHome,
    MEMORAX_CODE_CODEX_COMMAND: fakeCodex,
    FAKE_CODEX_LOG: join(root, "fake-codex.log"),
  };

  const started = runJob(["start", "--mode", "build", "--repo", repo], env);
  assert.equal(started.status, 0, started.stderr);
  const startedPayload = JSON.parse(started.stdout);

  const maintained = runJob(["maintain", "--repo", repo, "--dry-run"], env);
  assert.equal(maintained.status, 0, maintained.stderr);
  const payload = JSON.parse(maintained.stdout);
  assert.equal(payload.action, "deduplicated");
  assert.equal(payload.reason, "active_job");
  assert.equal(payload.bundleStatus, "unchecked");
  assert.equal(payload.job.alreadyRunning, true);
  assert.equal(payload.job.jobId, startedPayload.jobId);
  assert.equal(countJobDirs(memoraxCodeHome), 1);

  killAndWait(startedPayload.pid, startedPayload.jobPath);
});

test("repo memory maintain degrades to a non-blocking no-op when policy evaluation fails", () => {
  const root = tempRoot("repo-memory-maintain-policy-failure-");
  const repo = join(root, "repo");
  const memoraxCodeHome = join(root, "memorax-code");
  const head = initRepo(repo);
  writeValidMemoryBundle(repo, head);
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

test("repo memory maintain preserves an existing bundle when the validator is unavailable", () => {
  const root = tempRoot("repo-memory-maintain-validator-unavailable-");
  const repo = join(root, "repo");
  const memoraxCodeHome = join(root, "memorax-code");
  const head = initRepo(repo);
  writeValidMemoryBundle(repo, head);

  const result = runJob(["maintain", "--repo", repo, "--dry-run"], {
    MEMORAX_CODE_HOME: memoraxCodeHome,
    MEMORAX_CODE_REPO_MEMORY_PYTHON_COMMAND: join(root, "missing-python"),
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.action, "none");
  assert.equal(payload.reason, "bundle_validation_failed");
  assert.equal(payload.bundleStatus, "unknown");
  assert.equal(payload.validation.reason, "validator_unavailable");
  assert.equal(payload.job, undefined);
  assert.equal(countJobDirs(memoraxCodeHome), 0);
});

for (const expectedMode of ["build", "update"]) {
  test(`repo memory maintain launches and completes supervised ${expectedMode}`, () => {
    const root = tempRoot(`repo-memory-maintain-${expectedMode}-complete-`);
    const repo = join(root, "repo");
    const memoraxCodeHome = join(root, "memorax-code");
    const baseline = initRepo(repo);
    if (expectedMode === "update") {
      writeValidMemoryBundle(repo, baseline);
      for (let index = 1; index <= 5; index += 1) {
        writeFileSync(join(repo, `update-${index}.txt`), `update ${index}\n`);
        runGit(repo, ["add", `update-${index}.txt`]);
        runGit(repo, ["commit", "-m", `update ${index}`]);
      }
    }
    const fakeCodex = writeCompletingFakeCodex(root);
    const result = runJob(["maintain", "--repo", repo], {
      MEMORAX_CODE_HOME: memoraxCodeHome,
      MEMORAX_CODE_CODEX_COMMAND: fakeCodex,
      FAKE_CODEX_ENV_LOG: join(root, "worker-env.json"),
    });
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.action, expectedMode);
    assert.equal(payload.job.mode, expectedMode);
    assert.equal(payload.job.alreadyRunning, false);

    const state = waitForTerminal(payload.job.jobPath);
    assert.equal(state.status, "succeeded");
    assert.equal(state.mode, expectedMode);
    assert.equal(state.validation.ok, true);
    assert.equal(countJobDirs(memoraxCodeHome), 1);
  });
}

test("repo memory job launcher writes job state in MEMORAX_CODE_HOME", () => {
  const root = tempRoot("repo-memory-job-state-");
  const repo = join(root, "repo");
  const memoraxCodeHome = join(root, "memorax-code");
  const head = initRepo(repo);
  writeProfile(repo, head);
  const fakeCodex = writeLongRunningFakeCodex(root);
  const result = runJob(["start", "--mode", "update", "--repo", repo], {
    MEMORAX_CODE_HOME: memoraxCodeHome,
    MEMORAX_CODE_CODEX_COMMAND: fakeCodex,
    FAKE_CODEX_LOG: join(root, "fake-codex.log"),
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.mode, "update");
  assert.match(payload.jobPath, /repo-memory-jobs/);
  assert.match(payload.jobId, /^\d{17}-update-repo-[0-9a-f]{8}$/);
  const state = JSON.parse(readFileSync(payload.jobPath, "utf8"));
  assert.equal(state.mode, "update");
  assert.equal(state.runner, "codex");
  assert.equal(state.finalMessageSource, "file");
  assert.equal(state.repo, repo);
  assert.ok(["started", "running"].includes(state.status));
  assert.equal(state.snapshotHead, head);
  assert.match(state.runId, /^[0-9a-f]{32}$/);
  assert.match(state.finalMessagePath, /final-message\.txt$/);
  assert.match(state.outputLogPath, /output\.log$/);
  assert.deepEqual(state.command.slice(0, 6), [fakeCodex, "exec", "--cd", repo, "--sandbox", "danger-full-access"]);
  assert.match(
    state.workerCommand[1],
    /memorax-code-adapter-common[\\/]src[\\/]repo-memory[\\/]repo-memory-job-worker\.mjs$/,
  );
  killAndWait(payload.pid, payload.jobPath);
});

test("repo memory job launcher returns existing active job instead of spawning twice", () => {
  const root = tempRoot("repo-memory-job-dedupe-");
  const repo = join(root, "repo");
  const memoraxCodeHome = join(root, "memorax-code");
  initRepo(repo);
  const fakeCodex = writeLongRunningFakeCodex(root);

  const env = {
    MEMORAX_CODE_HOME: memoraxCodeHome,
    MEMORAX_CODE_CODEX_COMMAND: fakeCodex,
    FAKE_CODEX_LOG: join(root, "fake-codex.log"),
  };
  const first = runJob(["start", "--mode", "build", "--repo", repo], env);
  assert.equal(first.status, 0, first.stderr);
  const firstPayload = JSON.parse(first.stdout);
  assert.equal(firstPayload.alreadyRunning, false);
  assert.equal(countJobDirs(memoraxCodeHome), 1);

  const second = runJob(["start", "--mode", "build", "--repo", repo], env);
  assert.equal(second.status, 0, second.stderr);
  const secondPayload = JSON.parse(second.stdout);
  assert.equal(secondPayload.alreadyRunning, true);
  assert.equal(secondPayload.jobId, firstPayload.jobId);
  assert.equal(secondPayload.outputLogPath, firstPayload.outputLogPath);
  assert.equal(countJobDirs(memoraxCodeHome), 1);

  killAndWait(firstPayload.pid, firstPayload.jobPath);
});

test("repo memory job launcher allows only one concurrent startup per repo", async () => {
  const root = tempRoot("repo-memory-job-concurrent-");
  const repo = join(root, "repo");
  const memoraxCodeHome = join(root, "memorax-code");
  initRepo(repo);
  const fakeCodex = writeLongRunningFakeCodex(root);
  const env = {
    MEMORAX_CODE_HOME: memoraxCodeHome,
    MEMORAX_CODE_CODEX_COMMAND: fakeCodex,
    FAKE_CODEX_LOG: join(root, "fake-codex.log"),
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

  killAndWait(started[0].pid, started[0].jobPath);
});

test("repo memory job launcher overwrites marker with non-running pid", () => {
  const root = tempRoot("repo-memory-job-stale-pid-");
  const repo = join(root, "repo");
  const memoraxCodeHome = join(root, "memorax-code");
  const head = initRepo(repo);
  writeProfile(repo, head);
  writeMarker(memoraxCodeHome, repo, {
    pid: 999999999,
    startedAt: new Date().toISOString(),
  });
  const fakeCodex = writeLongRunningFakeCodex(root);
  const result = runJob(["start", "--mode", "update", "--repo", repo], {
    MEMORAX_CODE_HOME: memoraxCodeHome,
    MEMORAX_CODE_CODEX_COMMAND: fakeCodex,
    FAKE_CODEX_LOG: join(root, "fake-codex.log"),
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.alreadyRunning, false);
  const marker = JSON.parse(readFileSync(markerPathForRepo(memoraxCodeHome, realpathSync(repo)).markerPath, "utf8"));
  assert.equal(marker.version, 1);
  assert.equal(marker.pid, payload.pid);
  assert.equal(marker.mode, "update");

  killAndWait(payload.pid, payload.jobPath);
});

test("repo memory job launcher overwrites marker after TTL expires", () => {
  const root = tempRoot("repo-memory-job-stale-ttl-");
  const repo = join(root, "repo");
  const memoraxCodeHome = join(root, "memorax-code");
  initRepo(repo);
  writeMarker(memoraxCodeHome, repo, {
    pid: process.pid,
    startedAt: "2000-01-01T00:00:00.000Z",
  });
  const fakeCodex = writeLongRunningFakeCodex(root);
  const result = runJob(["start", "--mode", "build", "--repo", repo], {
    MEMORAX_CODE_HOME: memoraxCodeHome,
    MEMORAX_CODE_CODEX_COMMAND: fakeCodex,
    FAKE_CODEX_LOG: join(root, "fake-codex.log"),
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.alreadyRunning, false);
  const marker = JSON.parse(readFileSync(markerPathForRepo(memoraxCodeHome, realpathSync(repo)).markerPath, "utf8"));
  assert.equal(marker.pid, payload.pid);
  assert.equal(marker.mode, "build");

  killAndWait(payload.pid, payload.jobPath);
});

test("repo memory job marker rejects unsupported versions", () => {
  const root = tempRoot("repo-memory-job-marker-version-");
  const repo = join(root, "repo");
  const memoraxCodeHome = join(root, "memorax-code");
  initRepo(repo);
  writeMarker(memoraxCodeHome, repo, { version: 2 });

  const state = readActiveRepoMemoryJobMarker({
    memoraxCodeHome,
    repoRealpath: realpathSync(repo),
  });

  assert.equal(state.active, false);
  assert.equal(state.reason, "unsupported_version");
  assert.equal(existsSync(state.markerPath), false);
});

test("repo memory job marker rejects incomplete current records", () => {
  const root = tempRoot("repo-memory-job-marker-invalid-");
  const repo = join(root, "repo");
  const memoraxCodeHome = join(root, "memorax-code");
  initRepo(repo);
  writeMarker(memoraxCodeHome, repo, { runId: undefined });

  const state = readActiveRepoMemoryJobMarker({
    memoraxCodeHome,
    repoRealpath: realpathSync(repo),
  });

  assert.equal(state.active, false);
  assert.equal(state.reason, "invalid_record");
  assert.equal(existsSync(state.markerPath), false);
});

test("repo memory job launcher does not start when startup state directory is invalid", () => {
  const root = tempRoot("repo-memory-job-invalid-startup-state-");
  const repo = join(root, "repo");
  const memoraxCodeHome = join(root, "memorax-code");
  initRepo(repo);
  const jobsDir = repoMemoryJobsDir(memoraxCodeHome);
  mkdirSync(jobsDir, { recursive: true });
  writeFileSync(join(jobsDir, "in-progress"), "not a directory\n");
  const fakeCodex = writeLongRunningFakeCodex(root);
  const result = runJob(["start", "--mode", "build", "--repo", repo], {
    MEMORAX_CODE_HOME: memoraxCodeHome,
    MEMORAX_CODE_CODEX_COMMAND: fakeCodex,
    FAKE_CODEX_LOG: join(root, "fake-codex.log"),
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ENOTDIR|EEXIST/);
  assert.equal(countJobDirs(memoraxCodeHome), 0);
});

test("repo memory job supervisor records a missing Codex executable as failed", () => {
  const root = tempRoot("repo-memory-job-spawn-fails-");
  const repo = join(root, "repo");
  const memoraxCodeHome = join(root, "memorax-code");
  initRepo(repo);
  const missingCodex = join(root, "missing-codex");
  const result = runJob(["start", "--mode", "build", "--repo", repo], {
    MEMORAX_CODE_HOME: memoraxCodeHome,
    MEMORAX_CODE_CODEX_COMMAND: missingCodex,
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  const state = waitForTerminal(payload.jobPath);
  assert.equal(state.status, "failed");
  assert.equal(state.failureReason, "codex_spawn_failed");
  assert.equal(existsSync(markerPathForRepo(memoraxCodeHome, realpathSync(repo)).markerPath), false);
});

test("repo memory job launcher treats fresh empty startup lockdir as initializing", () => {
  const root = tempRoot("repo-memory-job-empty-lock-");
  const repo = join(root, "repo");
  const memoraxCodeHome = join(root, "memorax-code");
  initRepo(repo);
  const lockInfo = startupLockPathForRepo(memoraxCodeHome, realpathSync(repo));
  mkdirSync(lockInfo.lockDir, { recursive: true });
  const fakeCodex = writeLongRunningFakeCodex(root);
  const result = runJob(["start", "--mode", "build", "--repo", repo], {
    MEMORAX_CODE_HOME: memoraxCodeHome,
    MEMORAX_CODE_CODEX_COMMAND: fakeCodex,
    FAKE_CODEX_LOG: join(root, "fake-codex.log"),
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /startup is already in progress/);
  assert.equal(existsSync(lockInfo.lockDir), true);
  assert.equal(countJobDirs(memoraxCodeHome), 0);
});

test("repo memory job launcher removes old empty startup lockdir and starts job", () => {
  const root = tempRoot("repo-memory-job-old-empty-lock-");
  const repo = join(root, "repo");
  const memoraxCodeHome = join(root, "memorax-code");
  initRepo(repo);
  const lockInfo = startupLockPathForRepo(memoraxCodeHome, realpathSync(repo));
  mkdirSync(lockInfo.lockDir, { recursive: true });
  const old = new Date(Date.now() - 60_000);
  utimesSync(lockInfo.lockDir, old, old);
  const fakeCodex = writeLongRunningFakeCodex(root);
  const result = runJob(["start", "--mode", "build", "--repo", repo], {
    MEMORAX_CODE_HOME: memoraxCodeHome,
    MEMORAX_CODE_CODEX_COMMAND: fakeCodex,
    FAKE_CODEX_LOG: join(root, "fake-codex.log"),
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.alreadyRunning, false);
  assert.equal(existsSync(lockInfo.lockDir), false);

  killAndWait(payload.pid, payload.jobPath);
});

test("repo memory startup lock release preserves a replaced lock", () => {
  const root = tempRoot("repo-memory-job-token-lock-");
  const repo = join(root, "repo");
  const memoraxCodeHome = join(root, "memorax-code");
  mkdirSync(repo, { recursive: true });
  const repoRealpath = realpathSync(repo);
  const first = tryAcquireRepoMemoryStartupLock({ memoraxCodeHome, repoRealpath });
  assert.equal(first.acquired, true);
  releaseRepoMemoryStartupLock(first.lock);
  const second = tryAcquireRepoMemoryStartupLock({ memoraxCodeHome, repoRealpath });
  assert.equal(second.acquired, true);
  releaseRepoMemoryStartupLock(first.lock);
  assert.equal(existsSync(second.lock.lockDir), true);
  releaseRepoMemoryStartupLock(second.lock);
  assert.equal(existsSync(second.lock.lockDir), false);
});

test("repo memory job launcher removes stale startup lock and starts job", () => {
  const root = tempRoot("repo-memory-job-stale-lock-");
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
  const fakeCodex = writeLongRunningFakeCodex(root);
  const result = runJob(["start", "--mode", "build", "--repo", repo], {
    MEMORAX_CODE_HOME: memoraxCodeHome,
    MEMORAX_CODE_CODEX_COMMAND: fakeCodex,
    FAKE_CODEX_LOG: join(root, "fake-codex.log"),
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.alreadyRunning, false);
  assert.equal(existsSync(lockDir), false);

  killAndWait(payload.pid, payload.jobPath);
});

for (const mode of ["build", "update"]) {
  test(`repo memory job supervisor completes and validates ${mode}`, () => {
    const root = tempRoot(`repo-memory-job-${mode}-success-`);
    const repo = join(root, "repo");
    const memoraxCodeHome = join(root, "memorax-code");
    const head = initRepo(repo);
    if (mode === "update") writeValidMemoryBundle(repo, head);
    const envLog = join(root, "worker-env.json");
    const fakeCodex = writeCompletingFakeCodex(root);
    const result = runJob(["start", "--mode", mode, "--repo", repo], {
      MEMORAX_CODE_HOME: memoraxCodeHome,
      MEMORAX_CODE_CODEX_COMMAND: fakeCodex,
      FAKE_CODEX_ENV_LOG: envLog,
    });
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    const state = waitForTerminal(payload.jobPath);
    assert.equal(state.status, "succeeded");
    assert.equal(state.exitCode, 0);
    assert.equal(state.snapshotHead, head);
    assert.equal(state.validation.ok, true);
    assert.equal(state.validation.profileHead, head);
    waitForMarkerAbsent(memoraxCodeHome, repo);

    const workerEnv = JSON.parse(readFileSync(envLog, "utf8"));
    assert.equal(workerEnv.kind, "repo-memory");
    assert.equal(workerEnv.jobId, payload.jobId);
    assert.match(workerEnv.runId, /^[0-9a-f]{32}$/);
    assert.equal(workerEnv.snapshotHead, head);
    assert.equal(workerEnv.mode, mode);
  });
}

test("repo memory job supervisor fails when generated artifacts do not validate", () => {
  const root = tempRoot("repo-memory-job-validation-fail-");
  const repo = join(root, "repo");
  const memoraxCodeHome = join(root, "memorax-code");
  initRepo(repo);
  const fakeCodex = writeFinalOnlyFakeCodex(root);
  const result = runJob(["start", "--mode", "build", "--repo", repo], {
    MEMORAX_CODE_HOME: memoraxCodeHome,
    MEMORAX_CODE_CODEX_COMMAND: fakeCodex,
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  const state = waitForTerminal(payload.jobPath);
  assert.equal(state.status, "failed");
  assert.equal(state.failureReason, "artifact_validation_failed");
  assert.equal(existsSync(markerPathForRepo(memoraxCodeHome, realpathSync(repo)).markerPath), false);
});

test("repo memory job supervisor rejects a repository HEAD change during build", () => {
  const root = tempRoot("repo-memory-job-snapshot-change-");
  const repo = join(root, "repo");
  const memoraxCodeHome = join(root, "memorax-code");
  const launchHead = initRepo(repo);
  const fakeCodex = writeHeadChangingFakeCodex(root);
  const result = runJob(["start", "--mode", "build", "--repo", repo], {
    MEMORAX_CODE_HOME: memoraxCodeHome,
    MEMORAX_CODE_CODEX_COMMAND: fakeCodex,
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  const state = waitForTerminal(payload.jobPath);
  assert.equal(state.status, "failed");
  assert.equal(state.failureReason, "snapshot_changed");
  assert.equal(state.expectedHead, launchHead);
  assert.notEqual(state.actualHead, launchHead);
  assert.equal(existsSync(markerPathForRepo(memoraxCodeHome, realpathSync(repo)).markerPath), false);
});

test("repo memory job supervisor records an unexpected validation exception", () => {
  const root = tempRoot("repo-memory-job-internal-error-");
  const repo = join(root, "repo");
  const memoraxCodeHome = join(root, "memorax-code");
  initRepo(repo);
  const fakeCodex = writeGitBreakingFakeCodex(root);
  const result = runJob(["start", "--mode", "build", "--repo", repo], {
    MEMORAX_CODE_HOME: memoraxCodeHome,
    MEMORAX_CODE_CODEX_COMMAND: fakeCodex,
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  const state = waitForTerminal(payload.jobPath);
  assert.equal(state.status, "failed");
  assert.equal(state.failureReason, "worker_internal_error");
  assert.match(state.error, /git could not resolve HEAD/);
  assert.equal(existsSync(markerPathForRepo(memoraxCodeHome, realpathSync(repo)).markerPath), false);
});

test("repo memory update fails before launch without an existing profile", () => {
  const root = tempRoot("repo-memory-job-update-missing-");
  const repo = join(root, "repo");
  const memoraxCodeHome = join(root, "memorax-code");
  initRepo(repo);
  const result = runJob(["start", "--mode", "update", "--repo", repo, "--dry-run"], {
    MEMORAX_CODE_HOME: memoraxCodeHome,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /update requires an existing \.repo_memory\/PROFILE\.md/);
});

function writeLongRunningFakeCodex(root) {
  const fakeCodex = join(root, "fake-codex.mjs");
  writeFileSync(fakeCodex, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
setTimeout(() => {}, 30000);
`, { mode: 0o755 });
  return fakeCodex;
}

function writeCompletingFakeCodex(root) {
  const fakeCodex = join(root, "fake-codex-complete.mjs");
  writeFileSync(fakeCodex, `#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const repo = args[args.indexOf("--cd") + 1];
const finalMessagePath = args[args.indexOf("--output-last-message") + 1];
const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
const memory = join(repo, ".repo_memory");
mkdirSync(join(memory, "raw"), { recursive: true });
mkdirSync(join(memory, "resources"), { recursive: true });
writeFileSync(join(memory, "PROFILE.md"), [
  "---",
  'schema: "repo_memory_profile.v0.1"',
  'local_head: "' + head + '"',
  "---",
  "",
  "# Test Repo Memory Profile",
  "",
  "Generated by the fake Codex worker.",
  "",
].join("\\n"));
const resource = (schema, rawSource, source, trustState) => [
  "---",
  'schema: "' + schema + '"',
  'source: "' + source + '"',
  "resource_count: 0",
  'trust_state: "' + trustState + '"',
  'raw_source: "' + rawSource + '"',
  "---",
  "",
  "# " + schema,
  "",
].join("\\n");
writeFileSync(join(memory, "resources", "commits.md"), resource("repo_memory_commit_resource.v0.1", "../raw/git-commits.json", "git_commit_facets", "draft_resource"));
writeFileSync(join(memory, "resources", "prs.md"), resource("repo_memory_pr_resource.v0.1", "", "provider_skipped_local_only", "unavailable_local_only"));
writeFileSync(join(memory, "resources", "issues.md"), resource("repo_memory_issue_resource.v0.1", "", "provider_skipped_local_only", "unavailable_local_only"));
writeFileSync(join(memory, "raw", "git-commits.json"), "[]\\n");
writeFileSync(finalMessagePath, "Repo memory operation completed.\\n");
writeFileSync(process.env.FAKE_CODEX_ENV_LOG, JSON.stringify({
  kind: process.env.MEMORAX_CODE_REPO_MEMORY_JOB_KIND,
  jobId: process.env.MEMORAX_CODE_REPO_MEMORY_JOB_ID,
  runId: process.env.MEMORAX_CODE_REPO_MEMORY_JOB_RUN_ID,
  snapshotHead: process.env.MEMORAX_CODE_REPO_MEMORY_SNAPSHOT_HEAD,
  mode: process.env.MEMORAX_CODE_REPO_MEMORY_JOB_MODE,
}));
`, { mode: 0o755 });
  return fakeCodex;
}

function writeFinalOnlyFakeCodex(root) {
  const fakeCodex = join(root, "fake-codex-final-only.mjs");
  writeFileSync(fakeCodex, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const finalMessagePath = args[args.indexOf("--output-last-message") + 1];
writeFileSync(finalMessagePath, "No generated artifacts.\\n");
`, { mode: 0o755 });
  return fakeCodex;
}

function writeHeadChangingFakeCodex(root) {
  const fakeCodex = join(root, "fake-codex-change-head.mjs");
  writeFileSync(fakeCodex, `#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const repo = args[args.indexOf("--cd") + 1];
const finalMessagePath = args[args.indexOf("--output-last-message") + 1];
appendFileSync(join(repo, "README.md"), "\\nchanged during memory build\\n");
execFileSync("git", ["add", "README.md"], { cwd: repo });
execFileSync("git", ["commit", "-m", "change during memory build"], { cwd: repo });
writeFileSync(finalMessagePath, "Changed HEAD.\\n");
`, { mode: 0o755 });
  return fakeCodex;
}

function writeGitBreakingFakeCodex(root) {
  const fakeCodex = join(root, "fake-codex-break-git.mjs");
  writeFileSync(fakeCodex, `#!/usr/bin/env node
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const repo = args[args.indexOf("--cd") + 1];
const finalMessagePath = args[args.indexOf("--output-last-message") + 1];
rmSync(join(repo, ".git", "HEAD"));
writeFileSync(finalMessagePath, "Broke git metadata.\\n");
`, { mode: 0o755 });
  return fakeCodex;
}

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

function writeValidMemoryBundle(repo, head, options = {}) {
  const memory = join(repo, ".repo_memory");
  mkdirSync(join(memory, "raw"), { recursive: true });
  mkdirSync(join(memory, "resources"), { recursive: true });
  const generatedAt = options.generatedAt ? `generated_at: "${options.generatedAt}"\n` : "";
  writeFileSync(join(memory, "PROFILE.md"), `---\nschema: "repo_memory_profile.v0.1"\n${generatedAt}local_head: "${head}"\n---\n\n# Test Repo Memory Profile\n`);
  writeFileSync(join(memory, "resources", "commits.md"), emptyResource("repo_memory_commit_resource.v0.1", "../raw/git-commits.json"));
  writeFileSync(join(memory, "resources", "prs.md"), emptyResource("repo_memory_pr_resource.v0.1", ""));
  writeFileSync(join(memory, "resources", "issues.md"), emptyResource("repo_memory_issue_resource.v0.1", ""));
  writeFileSync(join(memory, "raw", "git-commits.json"), "[]\n");
}

function emptyResource(schema, rawSource) {
  const source = schema.includes("_commit_")
    ? "git_commit_facets"
    : "provider_skipped_local_only";
  const trustState = schema.includes("_commit_")
    ? "draft_resource"
    : "unavailable_local_only";
  return `---\nschema: "${schema}"\nsource: "${source}"\nresource_count: 0\ntrust_state: "${trustState}"\nraw_source: "${rawSource}"\n---\n\n# ${schema}\n`;
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
    runner: "codex",
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
