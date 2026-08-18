import { randomUUID } from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWriteJson, stringOption } from "../config-utils.mjs";
import { repoMemoryJobWorkerEnv } from "./repo-memory-job-context.mjs";
import {
  markerPathForRepo,
  readActiveRepoMemoryJobMarker,
  realpathRepo,
  releaseRepoMemoryStartupLock,
  repoMemoryJobsDir,
  removeRepoMemoryJobMarkerIfOwned,
  tryAcquireRepoMemoryStartupLock,
  waitForActiveRepoMemoryJobMarker,
  writeRepoMemoryJobMarker,
} from "./repo-memory-job-marker.mjs";

const workerPath = fileURLToPath(new URL("./repo-memory-job-worker.mjs", import.meta.url));
const maintenanceDecisionSchema = "repo_memory_maintenance_decision.v1";
const DEFAULT_MEMORY_SKILL_INVOCATION = "$memorax-code";

export function runRepoMemoryJob(args, options) {
  const runtime = normalizeRuntime(options);
  const request = parseArgs(args);
  if (request.command === "maintain") return maintainRepoMemory(request, runtime);
  if (request.command === "start") return startRepoMemoryJob(request, runtime);
  throw new Error(usage());
}

function normalizeRuntime(options) {
  if (typeof options?.createCommand !== "function") {
    throw new Error("repo memory job runtime requires createCommand");
  }
  if (typeof options?.evaluateRepository !== "function") {
    throw new Error("repo memory job runtime requires evaluateRepository");
  }
  if (!options?.validatorPath) {
    throw new Error("repo memory job runtime requires validatorPath");
  }
  const runner = typeof options.runner === "string" ? options.runner.trim() : "";
  if (!/^[a-z][a-z0-9-]*$/.test(runner)) {
    throw new Error("repo memory job runtime requires a valid runner");
  }
  const finalMessageSource = options.finalMessageSource || "file";
  if (finalMessageSource !== "file" && finalMessageSource !== "stdout") {
    throw new Error("repo memory job runtime requires a valid finalMessageSource");
  }
  return {
    createCommand: options.createCommand,
    evaluateRepository: options.evaluateRepository,
    finalMessageSource,
    memorySkillInvocation: stringOption(options.memorySkillInvocation) ?? DEFAULT_MEMORY_SKILL_INVOCATION,
    runner,
    validatorPath: resolve(options.validatorPath),
  };
}

function maintainRepoMemory(request, runtime) {
  const repo = realpathRepo(resolve(request.repo));
  const memoraxCodeHome = process.env.MEMORAX_CODE_HOME || join(homedir(), ".memorax-code");
  const activeMarker = readActiveRepoMemoryJobMarker({ memoraxCodeHome, repoRealpath: repo });
  if (activeMarker.active) {
    return maintenanceDecision({
      action: "deduplicated",
      reason: "active_job",
      bundleStatus: "unchecked",
      repo,
      job: alreadyRunningPayload(activeMarker.marker),
    });
  }

  const bundle = inspectRepoMemoryBundle(repo, runtime.validatorPath);
  if (bundle.status === "unknown") {
    return maintenanceDecision({
      ok: false,
      action: "none",
      reason: "bundle_validation_failed",
      bundleStatus: "unknown",
      repo,
      validation: bundle.validation,
    });
  }
  if (bundle.status === "missing" || bundle.status === "invalid") {
    return launchMaintenanceJob({
      request,
      runtime,
      repo,
      action: "build",
      reason: bundle.status === "missing" ? "bundle_missing" : "bundle_invalid",
      bundleStatus: bundle.status,
      validation: bundle.validation,
    });
  }

  let policyDecision;
  try {
    policyDecision = runtime.evaluateRepository({
      repo,
      nowMs: request.nowMs,
      configPath: request.configPath,
    });
  } catch {
    return maintenanceDecision({
      ok: false,
      action: "none",
      reason: "policy_evaluation_failed",
      bundleStatus: "usable",
      repo,
      validation: bundle.validation,
    });
  }

  if (!policyDecision.trigger) {
    return maintenanceDecision({
      action: "none",
      reason: "up_to_date",
      bundleStatus: "usable",
      repo,
      validation: bundle.validation,
      policyDecision,
    });
  }

  return launchMaintenanceJob({
    request,
    runtime,
    repo,
    action: "update",
    reason: policyDecision.reason || "policy_triggered",
    bundleStatus: "usable",
    validation: bundle.validation,
    policyDecision,
  });
}

function launchMaintenanceJob(input) {
  const job = startRepoMemoryJob({
    command: "start",
    repo: input.repo,
    mode: input.action,
    dryRun: input.request.dryRun,
  }, input.runtime);
  if (job.alreadyRunning) {
    return maintenanceDecision({
      action: "deduplicated",
      reason: "active_job",
      bundleStatus: input.bundleStatus,
      repo: input.repo,
      validation: input.validation,
      policyDecision: input.policyDecision,
      job,
    });
  }
  return maintenanceDecision({
    action: input.action,
    reason: input.reason,
    bundleStatus: input.bundleStatus,
    repo: input.repo,
    validation: input.validation,
    policyDecision: input.policyDecision,
    job,
  });
}

function maintenanceDecision(input) {
  return Object.fromEntries(Object.entries({
    schema: maintenanceDecisionSchema,
    ok: input.ok ?? true,
    action: input.action,
    reason: input.reason,
    bundleStatus: input.bundleStatus,
    repo: input.repo,
    validation: input.validation,
    policyDecision: input.policyDecision,
    job: input.job,
  }).filter(([, value]) => value !== undefined));
}

function inspectRepoMemoryBundle(repo, validatorPath) {
  const profilePath = join(repo, ".repo_memory", "PROFILE.md");
  if (!existsSync(profilePath)) return { status: "missing" };
  try {
    if (!statSync(profilePath).isFile()) {
      return {
        status: "invalid",
        validation: { ok: false, reason: "profile_not_regular_file" },
      };
    }
  } catch {
    return {
      status: "invalid",
      validation: { ok: false, reason: "profile_unreadable" },
    };
  }

  try {
    if (!statSync(validatorPath).isFile()) {
      return {
        status: "unknown",
        validation: { ok: false, reason: "validator_unavailable" },
      };
    }
  } catch {
    return {
      status: "unknown",
      validation: { ok: false, reason: "validator_unavailable" },
    };
  }

  const python = process.env.MEMORAX_CODE_REPO_MEMORY_PYTHON_COMMAND || "python3";
  const result = spawnSync(python, [validatorPath, repo], {
    cwd: repo,
    encoding: "utf8",
    env: process.env,
  });
  let report;
  try {
    report = JSON.parse(result.stdout || "");
  } catch {
    report = undefined;
  }
  if (!result.error && result.status === 0 && report?.ok === true) {
    return {
      status: "usable",
      validation: { ok: true, exitCode: result.status },
    };
  }
  if (result.error || !report || typeof report.ok !== "boolean") {
    return {
      status: "unknown",
      validation: {
        ok: false,
        reason: "validator_unavailable",
        exitCode: result.status,
      },
    };
  }
  return {
    status: "invalid",
    validation: {
      ok: false,
      reason: result.error ? "validator_unavailable" : "validation_failed",
      exitCode: result.status,
    },
  };
}

function startRepoMemoryJob(request, runtime) {
  const repo = realpathRepo(resolve(request.repo));
  const mode = request.mode;
  if (mode !== "build" && mode !== "update") throw new Error("--mode must be build or update");
  if (mode === "update" && !existsSync(join(repo, ".repo_memory", "PROFILE.md"))) {
    throw new Error(`repo memory update requires an existing .repo_memory/PROFILE.md: ${repo}`);
  }

  const memoraxCodeHome = process.env.MEMORAX_CODE_HOME || join(homedir(), ".memorax-code");
  const jobsDir = repoMemoryJobsDir(memoraxCodeHome);

  const activeMarker = readActiveRepoMemoryJobMarker({ memoraxCodeHome, repoRealpath: repo });
  if (activeMarker.active) return alreadyRunningPayload(activeMarker.marker);

  const jobId = `${new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 17)}-${mode}-${safeSlug(repo)}-${randomSuffix()}`;
  const jobDir = join(jobsDir, jobId);
  const finalMessagePath = join(jobDir, "final-message.txt");
  const outputLogPath = join(jobDir, "output.log");
  const jobPath = join(jobDir, "job.json");
  const snapshot = gitSnapshot(repo);
  const prompt = mode === "build"
    ? buildPrompt(repo, snapshot.head, runtime.memorySkillInvocation)
    : updatePrompt(repo, snapshot.head, runtime.memorySkillInvocation);
  const command = runtime.createCommand({
    finalMessagePath,
    prompt,
    repo,
  });
  assertCommand(command);
  const runId = randomUUID().replace(/-/g, "");
  const workerCommand = [
    process.execPath,
    workerPath,
    "--job",
    jobPath,
    "--repo",
    repo,
    "--memorax-code-home",
    memoraxCodeHome,
    "--validator",
    runtime.validatorPath,
  ];

  if (request.dryRun) {
    return {
      ok: true,
      dryRun: true,
      alreadyRunning: false,
      mode,
      runner: runtime.runner,
      finalMessageSource: runtime.finalMessageSource,
      repo,
      jobPath,
      command,
      workerCommand,
      prompt,
      snapshotHead: snapshot.head,
    };
  }

  mkdirSync(jobsDir, { recursive: true });
  const lockResult = tryAcquireRepoMemoryStartupLock({ memoraxCodeHome, repoRealpath: repo });
  if (!lockResult.acquired) {
    const markerState = waitForActiveRepoMemoryJobMarker({ memoraxCodeHome, repoRealpath: repo, timeoutMs: 2000, intervalMs: 50 });
    if (markerState.active) return alreadyRunningPayload(markerState.marker);
    throw new Error(`repo memory job startup is already in progress for ${repo}`);
  }

  const startupLock = lockResult.lock;
  try {
    const markerInsideLock = readActiveRepoMemoryJobMarker({ memoraxCodeHome, repoRealpath: repo });
    if (markerInsideLock.active) return alreadyRunningPayload(markerInsideLock.marker);

    mkdirSync(jobDir);
    const state = {
      version: 1,
      jobId,
      mode,
      repo,
      status: "started",
      startedAt: new Date().toISOString(),
      command,
      workerCommand,
      prompt,
      runner: runtime.runner,
      finalMessageSource: runtime.finalMessageSource,
      outputLogPath,
      finalMessagePath,
      runId,
      snapshotHead: snapshot.head,
      snapshotBranch: snapshot.branch,
      snapshotWorkingTreeState: snapshot.workingTreeState,
    };
    atomicWriteJson(jobPath, state);

    let logFd;
    let child;
    try {
      logFd = openSync(outputLogPath, "a");
      child = spawn(workerCommand[0], workerCommand.slice(1), {
        cwd: repo,
        detached: true,
        env: repoMemoryJobWorkerEnv({ jobId, runId }),
        stdio: ["ignore", logFd, logFd],
      });
    } finally {
      if (logFd !== undefined) closeSync(logFd);
    }
    if (!Number.isInteger(child?.pid) || child.pid <= 0) {
      child?.on?.("error", () => {});
      throw new Error("failed to start repo memory job supervisor");
    }
    state.pid = child.pid;
    state.workerPid = child.pid;
    atomicWriteJson(jobPath, state);
    writeRepoMemoryJobMarker({
      memoraxCodeHome,
      marker: {
        version: 1,
        repo,
        repoKey: markerPathForRepo(memoraxCodeHome, repo).repoKey,
        mode,
        jobId,
        jobPath,
        outputLogPath,
        finalMessagePath,
        pid: child.pid,
        runner: runtime.runner,
        runId,
        startedAt: state.startedAt,
      },
    });
    waitForWorkerInitialization({
      child,
      memoraxCodeHome,
      jobPath,
      repo,
      state,
      jobId,
      runId,
    });
    child.unref();
    return {
      ok: true,
      alreadyRunning: false,
      mode,
      runner: runtime.runner,
      repo,
      jobId,
      jobPath,
      outputLogPath,
      finalMessagePath,
      pid: child.pid,
    };
  } finally {
    releaseRepoMemoryStartupLock(startupLock);
  }
}

function waitForWorkerInitialization(input) {
  const deadline = Date.now() + 3000;
  let lastState = input.state;
  for (;;) {
    try {
      lastState = JSON.parse(readFileSync(input.jobPath, "utf8"));
    } catch {
      // Atomic replacement can make the file briefly unavailable to a concurrent reader.
    }
    if (lastState.status === "running" || lastState.status === "succeeded" || lastState.status === "failed") return;

    if (!pidIsRunning(input.child.pid)) {
      failWorkerInitialization(input, lastState, "repo memory job supervisor exited during startup");
    }
    if (Date.now() >= deadline) {
      try {
        process.kill(input.child.pid, "SIGTERM");
      } catch {
        // The worker may have exited between the liveness check and cleanup.
      }
      failWorkerInitialization(input, lastState, "timed out waiting for repo memory job supervisor startup");
    }
    sleep(25);
  }
}

function failWorkerInitialization(input, state, message) {
  atomicWriteJson(input.jobPath, {
    ...state,
    status: "failed",
    finishedAt: new Date().toISOString(),
    failureReason: "worker_start_failed",
    error: message,
  });
  removeRepoMemoryJobMarkerIfOwned({
    memoraxCodeHome: input.memoraxCodeHome,
    repoRealpath: input.repo,
    jobId: input.jobId,
    runId: input.runId,
  });
  throw new Error(message);
}

function pidIsRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function alreadyRunningPayload(marker) {
  return {
    ok: true,
    alreadyRunning: true,
    mode: marker.mode,
    repo: marker.repo,
    jobId: marker.jobId,
    jobPath: marker.jobPath,
    outputLogPath: marker.outputLogPath,
    finalMessagePath: marker.finalMessagePath,
    pid: marker.pid,
    runner: marker.runner,
  };
}

function parseArgs(values) {
  const result = { command: values[0] };
  for (let index = 1; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--mode") result.mode = values[++index];
    else if (value === "--repo") result.repo = values[++index];
    else if (value === "--dry-run") result.dryRun = true;
    else if (value === "--now") {
      result.nowMs = Date.parse(values[++index] || "");
      if (!Number.isFinite(result.nowMs)) throw new Error("--now must be ISO8601");
    } else if (value === "--config") {
      const configPath = values[++index];
      if (!configPath || configPath.startsWith("--")) throw new Error("--config requires a value");
      result.configPath = resolve(configPath);
    } else throw new Error(`unknown argument: ${value}`);
  }
  if (!result.repo) throw new Error("--repo is required");
  if (result.command === "start" && (result.nowMs !== undefined || result.configPath !== undefined)) {
    throw new Error("--now and --config are only valid with maintain");
  }
  if (result.command === "maintain" && result.mode !== undefined) {
    throw new Error("--mode is only valid with start");
  }
  return result;
}

function usage() {
  return [
    "usage:",
    "  repo-memory-job.mjs maintain --repo PATH [--dry-run] [--now ISO8601] [--config PATH]",
    "  repo-memory-job.mjs start --mode build|update --repo PATH [--dry-run]",
  ].join("\n");
}

function buildPrompt(repo, snapshotHead, memorySkillInvocation) {
  return `This invocation is the authorized background repo-memory worker. Complete the requested operation yourself; do not inspect, launch, or defer to another repo-memory job.\n\nUse ${memorySkillInvocation} and select the Repo Memory repo-build operation to build lightweight repo memory for this repository.\n\nRepository: ${repo}\nSnapshot HEAD: ${snapshotHead}\n\nDefault behavior:\n- Collect local git commit evidence from the exact snapshot SHA above, not a later symbolic HEAD.\n- Also try GitHub/GitLab PR, MR, and issue evidence when provider CLIs and authentication are available.\n- If provider evidence is unavailable, continue local-only and clearly record why.\n- Do not fabricate PR, MR, or issue facts.\n- If a previous attempt left an existing partial or unusable .repo_memory directory, perform a full refresh with collect_all.py --reuse instead of stopping because the directory exists.\n- Preserve .repo_memory/procedure-memory and .repo_memory/user-profile sidecars during full-refresh recovery.\n- Keep file writes scoped to ${repo}/.repo_memory and necessary repo-memory ignore/config entries.\n- Do not modify source code, dependency files, global config, or files outside the target repo unless explicitly required by repo-memory tooling.\n- Ensure PROFILE.md local_head resolves to the snapshot SHA above.\n- Run the packaged repo-memory validator before finishing.\n- Write a concise final summary with generated files, provider evidence status, and any follow-up needed.\n`;
}

function updatePrompt(repo, snapshotHead, memorySkillInvocation) {
  return `This invocation is the authorized background repo-memory worker. Complete the requested operation yourself; do not inspect, launch, or defer to another repo-memory job.\n\nUse ${memorySkillInvocation} and select the Repo Memory repo-update operation to incrementally update this repository's existing .repo_memory.\n\nRepository: ${repo}\nSnapshot HEAD: ${snapshotHead}\n\nDefault behavior:\n- Treat existing .repo_memory as the baseline.\n- Run and follow the packaged repo-update detector's effective history policy.\n- Do not re-enable commit or provider evidence channels disabled by repoHistory.mode.\n- If provider evidence is unavailable when provider history is enabled, preserve existing provider resources.\n- Do not rebuild unless updater reports the baseline is unusable; if a full rebuild is required, stop and report that.\n- Keep file writes scoped to ${repo}/.repo_memory and necessary repo-memory ignore/config entries.\n- Do not modify source code, dependency files, global config, or files outside the target repo unless explicitly required by repo-memory tooling.\n- Ensure PROFILE.md local_head resolves to the snapshot SHA above.\n- Run the packaged repo-memory validator before finishing.\n- Write a concise final summary with changed files, provider evidence status, and any follow-up needed.\n`;
}

function gitSnapshot(repo) {
  try {
    return {
      head: execFileSync("git", ["rev-parse", "--verify", "HEAD^{commit}"], {
        cwd: repo,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim(),
      branch: execFileSync("git", ["branch", "--show-current"], {
        cwd: repo,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim() || "(detached HEAD)",
      workingTreeState: execFileSync("git", ["status", "--short"], {
        cwd: repo,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim() ? "dirty" : "clean",
    };
  } catch {
    throw new Error(`repo memory jobs require a readable git HEAD: ${repo}`);
  }
}

function safeSlug(value) {
  return value.split(/[\\/]/).filter(Boolean).pop()?.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 40) || "repo";
}

function randomSuffix() {
  return randomUUID().replace(/-/g, "").slice(0, 8);
}

function assertCommand(command) {
  if (!Array.isArray(command) || command.length === 0 || command.some((entry) => typeof entry !== "string" || !entry)) {
    throw new Error("repo memory job runtime returned an invalid command");
  }
}
