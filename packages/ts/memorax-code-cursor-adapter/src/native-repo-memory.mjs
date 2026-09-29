import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const adapterRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagedCommon = join(adapterRoot, "memorax-code-adapter-common", "src");
const commonRoot = existsSync(packagedCommon) ? packagedCommon : resolve(adapterRoot, "../memorax-code-adapter-common/src");
const loadCommon = (name) => import(pathToFileURL(join(commonRoot, name)).href);
const { runRepoMemoryJob, buildPrompt, updatePrompt, gitSnapshot, inspectRepoMemoryBundle, reuseSharedRepoMemory, recheckSharedRepoMemoryMaintenance } = await loadCommon("repo-memory/repo-memory-job-supervisor.mjs");
const { clearBorrowedRepoMemory, prepareSharedRepoMemoryUpdate, publishSharedRepoMemory, publishSharedRepoMemoryUpdate, recordSharedRepoMemoryAttempt, shareableRepoMemoryWorktree } = await loadCommon("repo-memory/repo-memory-shared-bundle.mjs");
const { evaluateRepository } = await loadCommon("repo-memory/repo-memory-update-policy-evaluator.mjs");
const { gitHead, profileLocalHead, resolveCommit } = await loadCommon("repo-memory/repo-memory-job-artifacts.mjs");
const { markerPathForRepo, readActiveRepoMemoryJobMarker, realpathRepo, repoMemoryJobsDir, tryAcquireRepoMemoryStartupLock, releaseRepoMemoryStartupLock, removeRepoMemoryJobMarkerIfOwned, writeRepoMemoryJobMarker } = await loadCommon("repo-memory/repo-memory-job-marker.mjs");
const { writePrivateJsonRecord } = await loadCommon("runtime-record.mjs");

const SCHEMA = "cursor_native_repo_memory_job.v1";
const LEASE_MS = 6 * 60 * 60 * 1000;
const REQUEST_MS = 5 * 60 * 1000;
const GIT_READ_OPTIONS = { timeoutMs: 2000 };
const JOB_ID = /^\d{17}-(?:build|update)-[a-zA-Z0-9_.-]+-[0-9a-f]{8}$/;
const TOKEN = /^[a-f0-9]{64}$/;
const RUN_ID = /^[a-f0-9]{32}$/;

// The ticket proves possession of this local delegation, not native Cursor
// identity. Cursor remains responsible for child execution and shell approval.
export function runCursorRepoMemoryJob(args, options = {}) {
  const runtime = {
    home: resolve(options.memoraxCodeHome || process.env.MEMORAX_CODE_HOME || join(homedir(), ".memorax-code")),
    helperPath: resolve(options.helperPath || join(adapterRoot, "hooks/repo-memory-job.mjs")),
    validatorPath: resolve(options.validatorPath || defaultValidator()),
    sessionId: options.sessionId,
    now: options.now || Date.now,
    leaseMs: options.leaseMs ?? LEASE_MS,
  };
  runtime.evaluateRepository = options.evaluateRepository || ((input) => evaluateRepository({ ...input, configPath: input.configPath || join(runtime.home, "config.toml") }));
  if (!Number.isSafeInteger(runtime.leaseMs) || runtime.leaseMs <= 0 || runtime.leaseMs > LEASE_MS) throw new Error("invalid native job lease");
  if (["claim", "finish", "abort", "status"].includes(args[0])) return transition(parseTransition(args), runtime);
  return runRepoMemoryJob(args, {
    runner: "cursor",
    validatorPath: runtime.validatorPath,
    memoraxCodeHome: runtime.home,
    evaluateRepository: runtime.evaluateRepository,
    startJob: (request) => prepare(request, runtime),
  });
}

function prepare(request, runtime) {
  const repo = realpathRepo(resolve(request.repo));
  if (!["build", "update"].includes(request.mode)) throw new Error("--mode must be build or update");
  if (request.mode === "update" && !request.sharedUpdate && !existsSync(join(repo, ".repo_memory/PROFILE.md"))) throw new Error("repo memory update requires an existing PROFILE.md");
  const perform = () => {
    const active = readActiveRepoMemoryJobMarker({ memoraxCodeHome: runtime.home, repoRealpath: repo });
    if (active.active) return existing(active.marker);
    if (request.automatic) {
      const commonRuntime = { memoraxCodeHome: runtime.home, validatorPath: runtime.validatorPath, evaluateRepository: runtime.evaluateRepository };
      const sharedDecision = request.sharedUpdate ? recheckSharedRepoMemoryMaintenance(request, commonRuntime) : reuseSharedRepoMemory({ ...request, startupLocked: !request.dryRun }, commonRuntime);
      if (sharedDecision) return { ok: sharedDecision.ok, sharedDecision };
    }
    const snapshot = gitSnapshot(repo, GIT_READ_OPTIONS);
    if (request.sharedUpdate && snapshot.head !== request.sharedUpdate.head) return { sharedDecision: { reason: "shared_update_changed", bundleStatus: "unchecked" } };
    if (request.dryRun) return { ok: true, dryRun: true, alreadyRunning: false, execution: "native-subagent", runner: "cursor", repo, mode: request.mode, snapshotHead: snapshot.head };
    const now = runtime.now();
    const jobId = new Date(now).toISOString().replace(/[^0-9]/g, "").slice(0, 17) + "-" + request.mode + "-" + (basename(repo).replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 40) || "repo") + "-" + randomBytes(4).toString("hex");
    const ticket = randomBytes(32).toString("hex");
    const state = {
      schema: SCHEMA, version: 1, jobId, runId: randomUUID().replaceAll("-", ""),
      repo, mode: request.mode, runner: "cursor", execution: "native-subagent", status: "requested",
      startedAt: new Date(now).toISOString(), expiresAt: new Date(now + Math.min(REQUEST_MS, runtime.leaseMs)).toISOString(),
      snapshotHead: snapshot.head, snapshotBranch: snapshot.branch, snapshotWorkingTreeState: snapshot.workingTreeState,
      shareableSnapshot: shareableRepoMemoryWorktree(repo),
      sharedUpdate: request.sharedUpdate,
      validatorPath: runtime.validatorPath, parentSessionId: runtime.sessionId, ticketHash: hash(ticket),
    };
    if (request.sharedUpdate) prepareSharedRepoMemoryUpdate({ home: runtime.home, repo, update: request.sharedUpdate,
      root: dirname(jobPath(runtime, jobId)), validate: (path) => inspectRepoMemoryBundle(path, runtime.validatorPath).status === "usable" });
    writeState(runtime, state);
    if (request.sharedUpdate) recordSharedRepoMemoryAttempt({ home: runtime.home, repo, update: request.sharedUpdate, nowMs: request.nowMs });
    try {
      state.leasePid = startLeaseGuard(runtime, state);
      writeState(runtime, state);
      writeMarker(runtime, state);
    } catch (error) {
      finishState(runtime, state, "lease_guard_start_failed");
      throw error;
    }
    return {
      ...summary(runtime, state), alreadyRunning: false,
      delegation: {
        name: "memorax-repo-memory", background: true,
        referencePath: join(dirname(dirname(state.validatorPath)), "references", "repo-" + state.mode + ".md"),
        prompt: "Perform only this delegated Repo Memory job in " + repo + ". Before reading or changing Repo Memory, claim the ticket with the following local helper invocation. Continue only when the returned JSON has ok:true and status:claimed, then follow its instructions. Do not invoke maintain, start, a client CLI, or another subagent. A failed/expired claim means stop without writing.\n\n" + invocation(runtime, state, "claim", ["--ticket", ticket]) + "\n\nThe unclaimed ticket expires at " + state.expiresAt + ". Claim before that deadline. After a successful claim, use the authoring expiry returned by claim and stop writing at that later deadline; expiry cannot forcibly stop a native agent. Never report success until finish returns status:succeeded.",
      },
    };
  };
  return request.dryRun ? perform() : withRepoLock(runtime, repo, perform);
}

function transition(request, runtime) {
  const repo = realpathRepo(resolve(request.repo));
  if (request.command === "finish") {
    const acquired = withRepoLock(runtime, repo, () => {
      const state = loadOwnedState(request, runtime, repo);
      // Validation is read-only; retries still compete for one locked terminal transition.
      const rejection = authorize(request, runtime, state, "claimed", "validating");
      if (rejection) return rejection;
      state.status = "validating";
      writeState(runtime, state);
      return state;
    });
    if (acquired.ok === false) return acquired;
    let failureReason;
    let validation;
    let profileHead;
    try {
      if (gitHead(repo, GIT_READ_OPTIONS) !== acquired.snapshotHead) failureReason = "snapshot_changed";
      else {
        const memoryRoot = acquired.sharedUpdate ? dirname(jobPath(runtime, acquired.jobId)) : repo;
        const bundle = inspectRepoMemoryBundle(memoryRoot, acquired.validatorPath);
        validation = bundle.validation;
        if (bundle.status !== "usable") failureReason = "artifact_validation_failed";
        else {
          const value = profileLocalHead(join(memoryRoot, ".repo_memory/PROFILE.md"));
          profileHead = value ? resolveCommit(repo, value, GIT_READ_OPTIONS) : undefined;
          if (profileHead !== acquired.snapshotHead) failureReason = "profile_head_mismatch";
        }
      }
    } catch {
      failureReason = "artifact_validation_failed";
    }
    return withRepoLock(runtime, repo, () => {
      const state = loadOwnedState(request, runtime, repo);
      const rejection = authorize(request, runtime, state, "validating");
      if (rejection) return rejection;
      // Recheck after the validator; neither a concurrent commit nor lease
      // expiry may be converted into success by an earlier snapshot.
      try { if (gitHead(repo, GIT_READ_OPTIONS) !== state.snapshotHead) failureReason = "snapshot_changed"; } catch { failureReason = "snapshot_changed"; }
      state.validation = validation;
      state.profileHead = profileHead;
      if (!failureReason) state.sharedBaselinePublished = state.sharedUpdate
        ? publishSharedRepoMemoryUpdate({ home: runtime.home, repo, update: state.sharedUpdate, root: dirname(jobPath(runtime, state.jobId)),
          validate: (path) => inspectRepoMemoryBundle(path, runtime.validatorPath).status === "usable" })
        : publishSharedRepoMemory({ home: runtime.home, repo,
        head: state.snapshotHead, shareable: state.shareableSnapshot === true,
        validate: (path) => inspectRepoMemoryBundle(path, runtime.validatorPath).status === "usable" });
      if (!failureReason && state.sharedUpdate && !state.sharedBaselinePublished) failureReason = "shared_publication_rejected";
      if (!failureReason && !state.sharedUpdate) clearBorrowedRepoMemory(repo);
      return finishState(runtime, state, failureReason);
    });
  }
  return withRepoLock(runtime, repo, () => {
    const state = loadOwnedState(request, runtime, repo);
    if (request.command === "status") {
      if (!["succeeded", "failed"].includes(state.status) && runtime.now() >= Date.parse(state.expiresAt)) return finishState(runtime, state, "lease_expired");
      return summary(runtime, state);
    }
    if (request.command === "claim") {
      const rejection = authorize(request, runtime, state, "requested");
      if (rejection) return rejection;
      if (gitHead(repo, GIT_READ_OPTIONS) !== state.snapshotHead) return finishState(runtime, state, "snapshot_changed");
      const claimToken = randomBytes(32).toString("hex");
      state.status = "claimed";
      const claimedAt = runtime.now();
      state.claimedAt = new Date(claimedAt).toISOString();
      state.expiresAt = new Date(claimedAt + runtime.leaseMs).toISOString();
      state.claimHash = hash(claimToken);
      delete state.ticketHash;
      writeState(runtime, state);
      writeMarker(runtime, state);
      const memoryPrompt = (state.mode === "build" ? buildPrompt : updatePrompt)(repo, state.snapshotHead, "the direct Repo Memory reference at " + join(dirname(dirname(state.validatorPath)), "references", "repo-" + state.mode + ".md"),
        state.sharedUpdate ? { ...state.sharedUpdate, root: dirname(jobPath(runtime, state.jobId)) } : undefined);
      return {
        ...summary(runtime, state), claimToken,
        instructions: memoryPrompt + "\nThis is a Cursor native subagent. Do not call the Skill router, repo-read, maintain, start, any client CLI, or delegate again. Read the direct reference completely and perform its collect/detect/author/validate steps. The fixed authoring lease expires at " + state.expiresAt + ". Before every write confirm the lease has not expired. When authoring is complete, call finish below; only its validated succeeded result is success. If blocked, use abort instead.\n\n" + invocation(runtime, state, "finish", ["--claim-token", claimToken]) + "\n\n" + invocation(runtime, state, "abort", ["--claim-token", claimToken, "--reason", "child_failed"]),
      };
    }
    const rejection = authorize(request, runtime, state, "claimed", "validating");
    if (rejection) return rejection;
    return finishState(runtime, state, request.reason);
  });
}

function authorize(request, runtime, state, ...statuses) {
  const credential = request.command === "claim" ? request.ticket : request.claimToken;
  const expected = request.command === "claim" ? state.ticketHash : state.claimHash;
  if (!matches(credential, expected)) return rejected("invalid_capability");
  if (!statuses.includes(state.status)) return rejected("invalid_job_status");
  if (runtime.now() >= Date.parse(state.expiresAt)) return finishState(runtime, state, "lease_expired");
  const marker = readActiveRepoMemoryJobMarker({ memoraxCodeHome: runtime.home, repoRealpath: state.repo });
  if (!Number.isSafeInteger(state.leasePid) || marker.marker?.pid !== state.leasePid || !marker.active || marker.reason === "invalid_lease" || marker.marker?.jobId !== state.jobId || marker.marker?.runId !== state.runId || marker.marker?.leaseExpiresAt !== state.expiresAt || marker.marker?.startedAt !== (state.claimedAt || state.startedAt)) return rejected("job_ownership_lost");
  return undefined;
}

function loadOwnedState(request, runtime, repo) {
  const state = JSON.parse(readFileSync(jobPath(runtime, request.jobId), "utf8"));
  const leaseStartedAt = Date.parse(state.claimedAt || state.startedAt);
  if (!Number.isFinite(leaseStartedAt) || Date.parse(state.expiresAt) <= leaseStartedAt || (["claimed", "validating", "succeeded"].includes(state.status) && !state.claimedAt)) throw new Error("native repo memory job lease is invalid");
  if (state.schema !== SCHEMA || state.version !== 1 || state.runner !== "cursor" || state.execution !== "native-subagent" || state.jobId !== request.jobId || state.runId !== request.runId || state.repo !== repo || !["build", "update"].includes(state.mode) || !["requested", "claimed", "validating", "succeeded", "failed"].includes(state.status) || !/^[a-f0-9]{40,64}$/.test(state.snapshotHead) || !Number.isFinite(Date.parse(state.expiresAt)) || !Number.isFinite(Date.parse(state.startedAt)) || Date.parse(state.expiresAt) <= Date.parse(state.startedAt) || Date.parse(state.expiresAt) - Date.parse(state.claimedAt || state.startedAt) > LEASE_MS || state.validatorPath !== runtime.validatorPath) throw new Error("native repo memory job identity is invalid");
  return state;
}

function finishState(runtime, state, failureReason) {
  state.status = failureReason ? "failed" : "succeeded";
  state.finishedAt = new Date(runtime.now()).toISOString();
  if (failureReason) state.failureReason = failureReason;
  writeState(runtime, state);
  removeRepoMemoryJobMarkerIfOwned({ memoraxCodeHome: runtime.home, repoRealpath: state.repo, jobId: state.jobId, runId: state.runId });
  return summary(runtime, state);
}

function writeMarker(runtime, state) {
  const markerInfo = markerPathForRepo(runtime.home, state.repo);
  writeRepoMemoryJobMarker({ memoraxCodeHome: runtime.home, marker: {
    // Retain the v1 envelope for immutable older runtimes sharing this path.
    version: 1, ownerKind: "lease", pid: state.leasePid, repo: state.repo, repoKey: markerInfo.repoKey,
    mode: state.mode, runner: "cursor", jobId: state.jobId, runId: state.runId,
    outputLogPath: join(dirname(jobPath(runtime, state.jobId)), "output.log"),
    finalMessagePath: join(dirname(jobPath(runtime, state.jobId)), "final-message.md"),
    jobPath: jobPath(runtime, state.jobId), startedAt: state.claimedAt || state.startedAt, leaseExpiresAt: state.expiresAt,
  } });
}

function startLeaseGuard(runtime, state) {
  const readyPath = join(dirname(jobPath(runtime, state.jobId)), "lease-ready.json");
  const child = spawn(process.execPath, [runtime.helperPath, "lease-guard", runtime.home, state.repo, state.jobId, state.runId], {
    detached: true, stdio: "ignore", windowsHide: true,
  });
  child.on("error", () => {});
  child.unref();
  if (!Number.isSafeInteger(child.pid) || child.pid <= 0) throw new Error("native repo memory lease guard could not start");
  const deadline = Date.now() + 2000;
  try {
    while (Date.now() < deadline) {
      if (existsSync(readyPath)) {
        const ready = JSON.parse(readFileSync(readyPath, "utf8"));
        if (ready.pid !== child.pid || ready.jobId !== state.jobId || ready.runId !== state.runId) break;
        process.kill(child.pid, 0);
        return child.pid;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
    throw new Error("native repo memory lease guard did not become ready");
  } finally {
    rmSync(readyPath, { force: true });
  }
}

// This process supplies legacy PID liveness only; it never executes a model,
// authors repository files, or claims to terminate the native Cursor child.
export async function holdCursorRepoMemoryLease(args) {
  const [home, repo, jobId, runId] = args;
  if (args.length !== 4 || !home || !repo || !JOB_ID.test(jobId || "") || !RUN_ID.test(runId || "")) throw new Error("invalid lease guard identity");
  const runtime = { home: resolve(home) };
  const path = jobPath(runtime, jobId);
  const initial = JSON.parse(readFileSync(path, "utf8"));
  const hardDeadline = Date.parse(initial.startedAt) + REQUEST_MS + LEASE_MS;
  if (initial.schema !== SCHEMA || initial.repo !== repo || initial.jobId !== jobId || initial.runId !== runId || initial.status !== "requested" || !Number.isFinite(hardDeadline)) throw new Error("invalid lease guard job");
  // Report readiness before taking the lock: prepare holds it while waiting.
  writePrivateJsonRecord(join(dirname(path), "lease-ready.json"), { pid: process.pid, jobId, runId }, { durableBoundary: runtime.home });
  while (Date.now() < hardDeadline) {
    if (!existsSync(path)) return;
    const acquired = tryAcquireRepoMemoryStartupLock({ memoraxCodeHome: runtime.home, repoRealpath: repo });
    if (acquired.acquired) {
      try {
        const state = JSON.parse(readFileSync(path, "utf8"));
        const marker = JSON.parse(readFileSync(markerPathForRepo(runtime.home, repo).markerPath, "utf8"));
        const start = Date.parse(state.claimedAt || state.startedAt), expiry = Date.parse(state.expiresAt);
        if (state.schema !== SCHEMA || state.repo !== repo || state.jobId !== jobId || state.runId !== runId || state.leasePid !== process.pid
          || !["requested", "claimed", "validating"].includes(state.status)
          || !Number.isFinite(start) || !Number.isFinite(expiry) || expiry <= start || expiry - start > LEASE_MS || expiry > hardDeadline || Date.now() >= expiry
          || marker.jobId !== jobId || marker.runId !== runId || marker.pid !== process.pid || marker.leaseExpiresAt !== state.expiresAt) return;
      } catch { return; }
      finally { releaseRepoMemoryStartupLock(acquired.lock); }
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 250));
  }
}

function summary(runtime, state) {
  return { ok: state.status !== "failed", execution: "native-subagent", runner: "cursor", repo: state.repo, mode: state.mode, jobId: state.jobId, runId: state.runId, jobPath: jobPath(runtime, state.jobId), status: state.status, snapshotHead: state.snapshotHead, expiresAt: state.expiresAt, failureReason: state.failureReason, validation: state.validation };
}

function existing(marker) {
  return { ok: true, alreadyRunning: true, mode: marker.mode, runner: marker.runner, repo: marker.repo, jobId: marker.jobId, jobPath: marker.jobPath };
}

function withRepoLock(runtime, repo, operation) {
  const deadline = Date.now() + 2000;
  for (;;) {
    const result = tryAcquireRepoMemoryStartupLock({ memoraxCodeHome: runtime.home, repoRealpath: repo });
    if (result.acquired) {
      try { return operation(); } finally { releaseRepoMemoryStartupLock(result.lock); }
    }
    if (Date.now() >= deadline) throw new Error("native repo memory job is busy");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
}

function writeState(runtime, state) {
  writePrivateJsonRecord(jobPath(runtime, state.jobId), state, { durableBoundary: runtime.home });
}

function jobPath(runtime, jobId) {
  if (!JOB_ID.test(jobId || "")) throw new Error("invalid native job ID");
  return join(repoMemoryJobsDir(runtime.home), jobId, "job.json");
}

function invocation(runtime, state, command, extra) {
  return JSON.stringify({ executable: process.execPath, args: [runtime.helperPath, command, "--repo", state.repo, "--job", state.jobId, "--run", state.runId, ...extra], env: { MEMORAX_CODE_HOME: runtime.home } }) + "\nRun with this environment; shell-quote every argument independently, including paths with spaces.";
}

function parseTransition(args) {
  const request = { command: args[0] };
  const names = { "--repo": "repo", "--job": "jobId", "--run": "runId", "--ticket": "ticket", "--claim-token": "claimToken", "--reason": "reason" };
  for (let i = 1; i < args.length; i += 2) {
    const key = names[args[i]], value = args[i + 1];
    if (!key || request[key] !== undefined || typeof value !== "string" || !value || value.startsWith("--")) throw new Error("invalid native job argument");
    request[key] = value;
  }
  if (!request.repo || !JOB_ID.test(request.jobId || "") || !RUN_ID.test(request.runId || "")) throw new Error("native job requires --repo, --job and --run");
  if (request.command === "claim" && (!TOKEN.test(request.ticket || "") || request.claimToken || request.reason)) throw new Error("claim requires only --ticket");
  if (["finish", "abort"].includes(request.command) && (!TOKEN.test(request.claimToken || "") || request.ticket)) throw new Error("native job requires --claim-token");
  if (request.command === "finish" && request.reason) throw new Error("finish does not accept --reason");
  if (request.command === "abort" && !["child_failed", "permission_denied", "cancelled"].includes(request.reason)) throw new Error("abort requires a known --reason");
  if (request.command === "status" && (request.ticket || request.claimToken || request.reason)) throw new Error("status accepts identity only");
  return request;
}

function hash(value) { return createHash("sha256").update(value).digest("hex"); }
function matches(value, expected) { return TOKEN.test(value || "") && TOKEN.test(expected || "") && timingSafeEqual(Buffer.from(hash(value), "hex"), Buffer.from(expected, "hex")); }
function rejected(reason) { return { ok: false, reason }; }
function defaultValidator() {
  const packaged = join(adapterRoot, "skills/memorax-code/scripts/repo-memory.mjs");
  return existsSync(packaged) ? packaged : resolve(adapterRoot, "../memorax-code-codex-adapter/skills/memorax-code/scripts/repo-memory.mjs");
}
