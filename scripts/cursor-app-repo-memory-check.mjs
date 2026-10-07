import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

const marker = "MemoraX Code missing Repo Memory build: launch this native background delegation once, then continue your task:";
const limit = 256 * 1024;
const tokenPattern = /^[a-f0-9]{64}$/;
const headPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const jobPattern = /^\d{17}-build-[a-zA-Z0-9_.-]+-[0-9a-f]{8}$/;
const runPattern = /^[a-f0-9]{32}$/;

function fail(suffix) {
  const code = `CURSOR_APP_REPO_MEMORY_${suffix}`;
  throw Object.assign(new Error(code), { code });
}
function check(value, suffix) { if (!value) fail(suffix); }
function record(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function pathsFor(value) { return /^[a-z]:[\\/]|^\\\\/i.test(value) ? path.win32 : path; }
function absolute(value) { return typeof value === "string" && !/[\0\r\n]/.test(value) && pathsFor(value).isAbsolute(value); }
function text(value, suffix) { check(typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= limit, suffix); return value; }
function json(value, suffix) {
  try { const result = JSON.parse(text(value, suffix)); check(record(result), suffix); return result; }
  catch { fail(suffix); }
}
function invocations(value, suffix) {
  return text(value, suffix).split(/\r?\n/).filter((line) => line.startsWith('{"executable":')).map((line) => json(line, suffix));
}
function jobPath(request) { return pathsFor(request.stateHome).join(request.stateHome, "repo-memory-jobs", request.jobId, "job.json"); }
function validateInvocation(call, request, command, capability, suffix) {
  const args = [request.helper, command, "--repo", request.repo, "--job", request.jobId, "--run", request.runId,
    command === "claim" ? "--ticket" : "--claim-token", capability, ...(command === "abort" ? ["--reason", "child_failed"] : [])];
  check(record(call) && Object.keys(call).length === 3 && call.executable === request.executable
    && Array.isArray(call.args) && call.args.length === args.length && call.args.every((value, index) => value === args[index])
    && record(call.env) && Object.keys(call.env).length === 1 && call.env.MEMORAX_CODE_HOME === request.stateHome, suffix);
  return call;
}
function validateSummary(value, request, suffix) {
  check(value.execution === "native-subagent" && value.runner === "cursor" && value.mode === "build"
    && value.repo === request.repo && value.jobId === request.jobId && value.runId === request.runId
    && value.jobPath === jobPath(request) && headPattern.test(value.snapshotHead ?? "")
    && typeof value.expiresAt === "string" && Number.isFinite(Date.parse(value.expiresAt)), suffix);
}

export function parseCursorRepoMemoryDelegation(context, options) {
  const suffix = "DELEGATION_INVALID";
  check(record(options) && [options.executable, options.helper, options.stateHome, options.repo].every(absolute), suffix);
  const lines = text(context, suffix).split(/\r?\n/), indices = lines.flatMap((line, index) => line === marker ? [index] : []);
  check(indices.length > 0, suffix);
  const delegations = indices.map((index) => {
    let next = index + 1;
    while (next < lines.length && lines[next].trim() === "") next += 1;
    check(next < lines.length && lines[next] !== marker, suffix);
    return json(lines[next], suffix);
  }), [delegation] = delegations;
  check(delegations.every((value) => isDeepStrictEqual(value, delegation)), suffix);
  const paths = pathsFor(options.helper), generation = paths.dirname(paths.dirname(options.helper));
  check(delegation.name === "memorax-repo-memory" && delegation.background === true
    && Object.keys(delegation).length === 4
    && delegation.referencePath === paths.join(generation, "skills/memorax-code/references/repo-build.md"), suffix);
  const calls = invocations(delegation.prompt, suffix);
  check(calls.length === 1 && Array.isArray(calls[0].args) && calls[0].args.length === 10, suffix);
  const [call] = calls, jobId = call.args[5], runId = call.args[7], ticket = call.args[9];
  check(jobPattern.test(jobId ?? "") && runPattern.test(runId ?? "") && tokenPattern.test(ticket ?? ""), suffix);
  const request = { executable: options.executable, helper: options.helper, stateHome: options.stateHome, repo: options.repo,
    jobId, runId, delegation };
  return { ...request, claim: validateInvocation(call, request, "claim", ticket, suffix) };
}

export function parseCursorRepoMemoryClaim(stdout, request) {
  const suffix = "CLAIM_INVALID", result = json(stdout, suffix);
  validateSummary(result, request, suffix);
  check(result.ok === true && result.status === "claimed" && tokenPattern.test(result.claimToken ?? ""), suffix);
  const calls = invocations(result.instructions, suffix);
  check(calls.length === 2, suffix);
  const finish = calls.find((call) => call.args?.[1] === "finish"), abort = calls.find((call) => call.args?.[1] === "abort");
  validateInvocation(finish, request, "finish", result.claimToken, suffix);
  validateInvocation(abort, request, "abort", result.claimToken, suffix);
  return { ...request, claimToken: result.claimToken, snapshotHead: result.snapshotHead, expiresAt: result.expiresAt, finish, abort };
}

export function assertCursorRepoMemoryRejected(stdout, claimed) {
  const suffix = "FINISH_INVALID", result = json(stdout, suffix);
  validateSummary(result, claimed, suffix);
  check(result.ok === false && result.status === "failed" && result.failureReason === "artifact_validation_failed"
    && result.snapshotHead === claimed.snapshotHead && result.expiresAt === claimed.expiresAt, suffix);
  return true;
}

async function absent(file) {
  try { await lstat(file); return false; }
  catch (error) { if (error.code === "ENOENT") return true; throw error; }
}
function processPresent(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
}

export async function verifyCursorRepoMemoryFailure(claimed, { parentSessionId, snapshotHead, timeoutMs = 10000 }) {
  try {
    const suffix = "STATE_INVALID", file = jobPath(claimed), info = await lstat(file), home = await realpath(claimed.stateHome);
    check(info.isFile() && info.size > 0 && info.size <= limit
      && await realpath(file) === path.join(home, "repo-memory-jobs", claimed.jobId, "job.json"), suffix);
    const state = json(await readFile(file, "utf8"), suffix);
    const started = Date.parse(state.startedAt), claimedAt = Date.parse(state.claimedAt), finished = Date.parse(state.finishedAt);
    check(state.schema === "cursor_native_repo_memory_job.v1" && state.version === 1 && state.runner === "cursor"
      && state.execution === "native-subagent" && state.mode === "build" && state.repo === claimed.repo
      && state.jobId === claimed.jobId && state.runId === claimed.runId && typeof parentSessionId === "string"
      && parentSessionId.length > 0 && state.parentSessionId === parentSessionId
      && state.status === "failed" && state.failureReason === "artifact_validation_failed"
      && state.claimHash === createHash("sha256").update(claimed.claimToken).digest("hex") && state.ticketHash === undefined
      && [started, claimedAt, finished].every(Number.isFinite) && started <= claimedAt && claimedAt <= finished
      && finished < Date.parse(state.expiresAt) && state.expiresAt === claimed.expiresAt
      && headPattern.test(snapshotHead ?? "") && state.snapshotHead === snapshotHead && state.snapshotHead === claimed.snapshotHead
      && state.sharedSnapshot?.head === snapshotHead && state.sharedSnapshot.baseHead === null
      && state.validatorPath === path.join(path.dirname(path.dirname(claimed.helper)), "skills/memorax-code/scripts/repo-memory.mjs")
      && state.sharedBaselinePublished === undefined && Number.isSafeInteger(state.leasePid) && state.leasePid > 1, suffix);
    const common = path.join(path.dirname(path.dirname(claimed.helper)), "memorax-code-adapter-common/src/repo-memory");
    const { markerPathForRepo, repoKeyForPath } = await import(pathToFileURL(path.join(common, "repo-memory-job-marker.mjs")));
    const { sharedRepoMemoryPath, sharedSnapshotRoot } = await import(pathToFileURL(path.join(common, "repo-memory-shared-bundle.mjs")));
    const baseline = sharedRepoMemoryPath(claimed.stateHome, claimed.repo);
    for (const candidate of [markerPathForRepo(claimed.stateHome, claimed.repo).markerPath,
      path.join(claimed.stateHome, "repo-memory-jobs/in-progress", `${repoKeyForPath(claimed.repo)}.json`),
      path.join(baseline, "baseline.json"), path.join(baseline, "versions"), sharedSnapshotRoot(file),
      path.join(claimed.repo, ".repo_memory/PROFILE.md")]) check(await absent(candidate), suffix);
    check(Number.isSafeInteger(timeoutMs) && timeoutMs >= 0 && timeoutMs <= 30000, suffix);
    const deadline = Date.now() + timeoutMs;
    while (processPresent(state.leasePid)) {
      check(Date.now() < deadline, "GUARD_REMAINS");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return { jobIdentityMatched: true, claimVerified: true, invalidArtifactsRejected: true, snapshotMatched: true,
      snapshotRemoved: true, bundleUnpublished: true, activeMarkerRemoved: true, leaseGuardExited: true };
  } catch (error) {
    if (error.code === "CURSOR_APP_REPO_MEMORY_GUARD_REMAINS") throw error;
    fail("STATE_INVALID");
  }
}
