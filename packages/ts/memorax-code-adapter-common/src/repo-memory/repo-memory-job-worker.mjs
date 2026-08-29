import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { atomicWriteJson, readJsonFile, stringOption } from "../config-utils.mjs";
import {
  readActiveRepoMemoryJobMarker,
  realpathRepo,
  removeRepoMemoryJobMarkerIfOwned,
} from "./repo-memory-job-marker.mjs";
import {
  readRepoMemoryJobWorkerContext,
  repoMemoryJobWorkerEnv,
} from "./repo-memory-job-context.mjs";
import { resolveWindowsCliInvocation } from "../windows-cli-invocation.mjs";

let activeChild;
let activeRequest;
let activeWorkerContext;
let requestedSignal;

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    requestedSignal = signal;
    if (activeChild) terminateClient(activeChild, signal);
  });
}

try {
  const succeeded = await main(process.argv.slice(2));
  process.exitCode = succeeded ? 0 : 1;
} catch (error) {
  if (!recordUnhandledFailure(error)) {
    process.stderr.write(`repo memory worker failed: ${errorMessage(error)}\n`);
  }
  process.exitCode = 1;
}

async function main(args) {
  const request = parseArgs(args);
  const workerContext = readRepoMemoryJobWorkerContext();
  if (!workerContext) throw new Error("missing trusted repo memory worker context");
  const repo = realpathRepo(resolve(request.repo));
  activeRequest = { ...request, repo };
  activeWorkerContext = workerContext;
  await waitForOwnedMarker({
    memoraxCodeHome: request.memoraxCodeHome,
    repo,
    jobId: workerContext.jobId,
    runId: workerContext.runId,
  });

  const initial = readJobState(request.jobPath);
  assertJobIdentity(initial, {
    repo,
    jobId: workerContext.jobId,
    runId: workerContext.runId,
  });
  if (initial.status !== "started") throw new Error(`repo memory job cannot start from status ${initial.status}`);
  const clientTimeoutMs = repoMemoryClientTimeoutMs();
  const clientKillGraceMs = repoMemoryClientKillGraceMs();
  let state = writeJobState(request.jobPath, {
    ...initial,
    status: "running",
    pid: process.pid,
    workerPid: process.pid,
    workerStartedAt: new Date().toISOString(),
    clientTimeoutMs,
    clientKillGraceMs,
  });

  if (requestedSignal) {
    return finishFailed(request, state, workerContext, "worker_interrupted", { signal: requestedSignal });
  }

  const runner = runnerName(state.runner);
  const command = normalizedCommand(state.command);
  const childResult = await runClient(command, {
    captureStdout: finalMessageSource(state.finalMessageSource) === "stdout",
    cwd: repo,
    env: {
      ...repoMemoryJobWorkerEnv(workerContext),
      MEMORAX_CODE_REPO_MEMORY_SNAPSHOT_HEAD: state.snapshotHead,
      MEMORAX_CODE_REPO_MEMORY_JOB_MODE: state.mode,
    },
    onSpawn(childPid) {
      state = writeJobState(request.jobPath, {
        ...state,
        childPid,
      });
    },
    finalMessagePath: state.finalMessagePath,
    timeoutMs: clientTimeoutMs,
    killGraceMs: clientKillGraceMs,
  });
  state = readJobState(request.jobPath);

  if (childResult.timedOut) {
    return finishFailed(request, state, workerContext, `${runner}_timeout`, {
      timeoutMs: childResult.timeoutMs,
      elapsedMs: childResult.elapsedMs,
      signal: childResult.signal,
    });
  }
  if (childResult.error) {
    return finishFailed(request, state, workerContext, `${runner}_spawn_failed`, {
      error: childResult.error.message,
    });
  }
  if (childResult.code !== 0) {
    return finishFailed(request, state, workerContext, requestedSignal ? "worker_interrupted" : `${runner}_exit_nonzero`, {
      exitCode: childResult.code,
      signal: childResult.signal,
    });
  }
  if (!nonEmptyFile(state.finalMessagePath)) {
    return finishFailed(request, state, workerContext, "final_message_missing", {
      exitCode: childResult.code,
      signal: childResult.signal,
    });
  }

  const currentHead = gitHead(repo);
  if (currentHead !== state.snapshotHead) {
    return finishFailed(request, state, workerContext, "snapshot_changed", {
      exitCode: childResult.code,
      expectedHead: state.snapshotHead,
      actualHead: currentHead,
    });
  }

  const validation = validateBundle(repo, request.validatorPath);
  if (!validation.ok) {
    return finishFailed(request, state, workerContext, "artifact_validation_failed", {
      exitCode: childResult.code,
      validationExitCode: validation.exitCode,
      validationError: validation.error,
    });
  }

  const profileHead = profileLocalHead(join(repo, ".repo_memory", "PROFILE.md"));
  const resolvedProfileHead = profileHead ? resolveCommit(repo, profileHead) : undefined;
  if (!resolvedProfileHead || resolvedProfileHead !== state.snapshotHead) {
    return finishFailed(request, state, workerContext, "profile_head_mismatch", {
      exitCode: childResult.code,
      profileHead,
      resolvedProfileHead,
      expectedHead: state.snapshotHead,
    });
  }

  return finishSucceeded(request, state, workerContext, {
    exitCode: childResult.code,
    profileHead: resolvedProfileHead,
    validationExitCode: validation.exitCode,
  });
}

function recordUnhandledFailure(error) {
  if (!activeRequest || !activeWorkerContext) return false;
  try {
    const state = readJobState(activeRequest.jobPath);
    assertJobIdentity(state, {
      repo: activeRequest.repo,
      jobId: activeWorkerContext.jobId,
      runId: activeWorkerContext.runId,
    });
    if (state.status === "succeeded" || state.status === "failed") {
      removeOwnedMarker(activeRequest, state, activeWorkerContext);
      return true;
    }
    finishFailed(
      activeRequest,
      state,
      activeWorkerContext,
      requestedSignal ? "worker_interrupted" : "worker_internal_error",
      { error: errorMessage(error), signal: requestedSignal },
    );
    return true;
  } catch (recordError) {
    process.stderr.write(
      `repo memory worker failed: ${errorMessage(error)}; could not record terminal state: ${errorMessage(recordError)}\n`,
    );
    return false;
  }
}

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--job") result.jobPath = values[++index];
    else if (value === "--repo") result.repo = values[++index];
    else if (value === "--memorax-code-home") result.memoraxCodeHome = values[++index];
    else if (value === "--validator") result.validatorPath = values[++index];
    else throw new Error(`unknown argument: ${value}`);
  }
  if (!result.jobPath) throw new Error("--job is required");
  if (!result.repo) throw new Error("--repo is required");
  if (!result.memoraxCodeHome) throw new Error("--memorax-code-home is required");
  if (!result.validatorPath) throw new Error("--validator is required");
  result.validatorPath = resolve(result.validatorPath);
  return result;
}

async function waitForOwnedMarker(input) {
  const deadline = Date.now() + 3000;
  while (Date.now() <= deadline) {
    if (requestedSignal) throw new Error(`worker interrupted by ${requestedSignal}`);
    const state = readActiveRepoMemoryJobMarker({
      memoraxCodeHome: input.memoraxCodeHome,
      repoRealpath: input.repo,
    });
    if (
      state.active
      && state.marker.jobId === input.jobId
      && state.marker.runId === input.runId
      && state.marker.pid === process.pid
    ) {
      return;
    }
    await delay(25);
  }
  throw new Error("timed out waiting for owned repo memory job marker");
}

function runClient(command, options) {
  return new Promise((resolveResult) => {
    let settled = false;
    let timeoutHandle;
    let killHandle;
    let timedOut = false;
    let timeoutMs;
    const startedAt = Date.now();
    let invocation;
    try {
      invocation = process.platform === "win32" && /\.[cm]?js$/i.test(command[0])
        ? { command: process.execPath, args: command }
        : resolveWindowsCliInvocation(command[0], command.slice(1), {
          env: options.env,
        });
    } catch (error) {
      resolveResult({ code: undefined, signal: undefined, error });
      return;
    }
    let capturedStdout = "";
    const child = spawn(invocation.command, invocation.args, {
      cwd: options.cwd,
      env: options.env,
      detached: process.platform !== "win32",
      stdio: options.captureStdout ? ["ignore", "pipe", "inherit"] : "inherit",
    });
    activeChild = child;
    if (Number.isInteger(child.pid) && child.pid > 0) options.onSpawn(child.pid);
    if (options.captureStdout) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        capturedStdout += chunk;
        process.stdout.write(chunk);
      });
    }

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (killHandle) clearTimeout(killHandle);
      activeChild = undefined;
      resolveResult({ ...result, timedOut, timeoutMs, elapsedMs: Date.now() - startedAt });
    };
    child.once("error", (error) => finish({ code: undefined, signal: undefined, error }));
    child.once("close", (code, signal) => {
      if (options.captureStdout) {
        try {
          writeFileSync(options.finalMessagePath, capturedStdout, { mode: 0o600 });
        } catch (error) {
          finish({ code, signal, error });
          return;
        }
      }
      finish({ code, signal, error: undefined });
    });
    if (Number.isFinite(options.timeoutMs) && options.timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        timeoutMs = options.timeoutMs;
        timedOut = true;
        const terminated = terminateClient(child, "SIGTERM");
        // A broken or ignored CLI must not leave a detached job behind forever.
        // The grace period is deliberately short and only targets this child.
        killHandle = setTimeout(() => {
          if (!settled) terminateClient(child, "SIGKILL");
        }, options.killGraceMs);
        if (!terminated && !settled) {
          finish({
            code: undefined,
            signal: "SIGTERM",
            error: undefined,
            timedOut: true,
            timeoutMs,
          });
        }
      }, options.timeoutMs);
    }
    if (requestedSignal) terminateClient(child, requestedSignal);
  });
}

function terminateClient(child, signal) {
  if (!child || !Number.isInteger(child.pid) || child.pid <= 0) return false;
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch {
      // The process group may have exited between the timeout and this call.
    }
  }
  if (process.platform === "win32") {
    try {
      const result = spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "ignore", "ignore"],
      });
      if (result.status === 0) return true;
    } catch {
      // Fall through to the direct child termination below.
    }
  }
  try {
    return child.kill(signal);
  } catch {
    return false;
  }
}

function repoMemoryClientTimeoutMs(env = process.env) {
  return positiveEnvInteger(env.MEMORAX_CODE_REPO_MEMORY_JOB_TIMEOUT_MS, 10 * 60 * 1000);
}

function repoMemoryClientKillGraceMs(env = process.env) {
  return positiveEnvInteger(env.MEMORAX_CODE_REPO_MEMORY_JOB_KILL_GRACE_MS, 5000);
}

function positiveEnvInteger(value, fallback) {
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) return fallback;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function validateBundle(repo, validator) {
  const python = process.env.MEMORAX_CODE_REPO_MEMORY_PYTHON_COMMAND || "python3";
  process.stdout.write("\n[repo-memory-worker] validating generated repo memory\n");
  const result = spawnSync(python, [validator, repo, "--pretty"], {
    cwd: repo,
    encoding: "utf8",
    env: process.env,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return {
    ok: !result.error && result.status === 0,
    exitCode: result.status,
    error: result.error instanceof Error ? result.error.message : undefined,
  };
}

function finishSucceeded(request, state, workerContext, details) {
  try {
    writeJobState(request.jobPath, {
      ...state,
      status: "succeeded",
      finishedAt: new Date().toISOString(),
      exitCode: details.exitCode,
      validation: {
        ok: true,
        exitCode: details.validationExitCode,
        profileHead: details.profileHead,
      },
    });
    process.stdout.write("[repo-memory-worker] job succeeded\n");
    return true;
  } finally {
    removeOwnedMarker(request, state, workerContext);
  }
}

function finishFailed(request, state, workerContext, failureReason, details = {}) {
  try {
    writeJobState(request.jobPath, {
      ...state,
      status: "failed",
      finishedAt: new Date().toISOString(),
      failureReason,
      ...definedEntries(details),
    });
    process.stderr.write(`[repo-memory-worker] job failed: ${failureReason}\n`);
    return false;
  } finally {
    removeOwnedMarker(request, state, workerContext);
  }
}

function removeOwnedMarker(request, state, workerContext) {
  removeRepoMemoryJobMarkerIfOwned({
    memoraxCodeHome: request.memoraxCodeHome,
    repoRealpath: state.repo,
    jobId: workerContext.jobId,
    runId: workerContext.runId,
  });
}

function readJobState(path) {
  const result = readJsonFile(path);
  if (!result?.value || result.unreadable) throw new Error(`repo memory job state is unreadable: ${path}`);
  return result.value;
}

function writeJobState(path, state) {
  atomicWriteJson(path, state);
  return state;
}

function assertJobIdentity(state, expected) {
  if (state.jobId !== expected.jobId) throw new Error("repo memory job id does not match worker context");
  if (state.runId !== expected.runId) throw new Error("repo memory job run id does not match worker context");
  if (state.repo !== expected.repo) throw new Error("repo memory job repository does not match worker context");
}

function normalizedCommand(value) {
  if (!Array.isArray(value) || value.length === 0 || value.some((entry) => typeof entry !== "string" || !entry)) {
    throw new Error("repo memory job command is invalid");
  }
  return value;
}

function runnerName(value) {
  const runner = stringOption(value) || "codex";
  if (!/^[a-z][a-z0-9-]*$/.test(runner)) {
    throw new Error("repo memory job runner is invalid");
  }
  return runner;
}

function finalMessageSource(value) {
  const source = stringOption(value) || "file";
  if (source !== "file" && source !== "stdout") {
    throw new Error("repo memory job final message source is invalid");
  }
  return source;
}

function nonEmptyFile(path) {
  try {
    return existsSync(path) && readFileSync(path, "utf8").trim().length > 0;
  } catch {
    return false;
  }
}

function profileLocalHead(path) {
  try {
    const text = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
    const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
    if (!match) return undefined;
    const line = match[1].split(/\r?\n/).find((entry) => /^local_head\s*:/.test(entry.trim()));
    return stringOption(line?.replace(/^\s*local_head\s*:\s*/, "").trim().replace(/^['"]|['"]$/g, ""));
  } catch {
    return undefined;
  }
}

function resolveCommit(repo, ref) {
  const result = spawnSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
    cwd: repo,
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function gitHead(repo) {
  const head = resolveCommit(repo, "HEAD");
  if (!head) throw new Error(`git could not resolve HEAD in ${repo}`);
  return head;
}

function definedEntries(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
