import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, win32 } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { assertCursorRepoMemoryRejected, parseCursorRepoMemoryClaim, parseCursorRepoMemoryDelegation,
  verifyCursorRepoMemoryFailure } from "./cursor-app-repo-memory-check.mjs";

const marker = "MemoraX Code missing Repo Memory build: launch this native background delegation once, then continue your task:";
const ticket = "a".repeat(64), token = "b".repeat(64), head = "c".repeat(40);
const jobId = "20261007000000000-build-fixture-12345678", runId = "d".repeat(32);
const parentSessionId = "10000000-0000-4000-8000-000000000001";

function fixturePaths(root, paths = { join, dirname }) {
  const options = { executable: paths.join(root, "node"), helper: paths.join(root, "generation/hooks/repo-memory-job.mjs"),
    stateHome: paths.join(root, "state"), repo: paths.join(root, "repository") };
  const invocation = (command, capability) => ({ executable: options.executable,
    args: [options.helper, command, "--repo", options.repo, "--job", jobId, "--run", runId,
      command === "claim" ? "--ticket" : "--claim-token", capability, ...(command === "abort" ? ["--reason", "child_failed"] : [])],
    env: { MEMORAX_CODE_HOME: options.stateHome } });
  const delegation = { name: "memorax-repo-memory", background: true,
    referencePath: paths.join(root, "generation/skills/memorax-code/references/repo-build.md"),
    prompt: `Real synthetic delegation.\n${JSON.stringify(invocation("claim", ticket))}\nKeep the complete prompt.` };
  const context = ["Other Hook guidance.", marker, JSON.stringify(delegation)].join("\n\n");
  const summary = { ok: true, execution: "native-subagent", runner: "cursor", repo: options.repo, mode: "build",
    jobId, runId, jobPath: paths.join(options.stateHome, "repo-memory-jobs", jobId, "job.json"), status: "claimed",
    snapshotHead: head, expiresAt: "2026-10-07T06:00:01.000Z" };
  const claim = { ...summary, claimToken: token,
    instructions: `Direct reference instructions.\n${JSON.stringify(invocation("finish", token))}\n${JSON.stringify(invocation("abort", token))}` };
  const rejected = { ...summary, ok: false, status: "failed", failureReason: "artifact_validation_failed" };
  return { options, context, delegation, invocation, summary, claim, rejected };
}

function rejected(operation, suffix) {
  assert.throws(operation, { code: `CURSOR_APP_REPO_MEMORY_${suffix}`, message: `CURSOR_APP_REPO_MEMORY_${suffix}` });
}

test("Repo Memory delegates exact POSIX and Windows paths without reconstructing capabilities", () => {
  for (const f of [fixturePaths("/owned fixture"), fixturePaths("D:\\owned fixture", win32)]) {
    const request = parseCursorRepoMemoryDelegation(f.context, f.options);
    assert.deepEqual(request.delegation, f.delegation);
    assert.deepEqual(request.claim, f.invocation("claim", ticket));
    assert.equal(request.jobId, jobId);
    assert.equal(request.runId, runId);
    const claimed = parseCursorRepoMemoryClaim(JSON.stringify(f.claim), request);
    assert.deepEqual(claimed.finish, f.invocation("finish", token));
    assert.deepEqual(claimed.abort, f.invocation("abort", token));
    assert.equal(claimed.claimToken, token);
    assert.equal(assertCursorRepoMemoryRejected(JSON.stringify(f.rejected), claimed), true);
  }
});

test("Repo Memory accepts identical delegations repeated by native context channels but rejects conflicts", () => {
  for (const f of [fixturePaths("/owned fixture"), fixturePaths("D:\\owned fixture", win32)]) {
    const expected = parseCursorRepoMemoryDelegation(f.context, f.options);
    assert.deepEqual(parseCursorRepoMemoryDelegation(`${f.context}\n${f.context}`, f.options), expected);
    const reordered = Object.fromEntries(Object.entries(f.delegation).reverse());
    assert.deepEqual(parseCursorRepoMemoryDelegation(`${f.context}\n${marker}\n${JSON.stringify(reordered)}`, f.options), expected);
    for (const changed of [{ ...f.delegation, prompt: `${f.delegation.prompt} changed` },
      { ...f.delegation, prompt: f.delegation.prompt.replace(ticket, "e".repeat(64)) },
      { ...f.delegation, background: false }, { ...f.delegation, referencePath: "/foreign/references/repo-build.md" }]) {
      rejected(() => parseCursorRepoMemoryDelegation(`${f.context}\n${marker}\n${JSON.stringify(changed)}`, f.options), "DELEGATION_INVALID");
    }
    rejected(() => parseCursorRepoMemoryDelegation(`${f.context}\n${marker}\nprivate-invalid-json`, f.options), "DELEGATION_INVALID");
  }
});

test("Repo Memory accepts live Hook blank-line framing without crossing another marker or other content", () => {
  const f = fixturePaths("/owned fixture");
  for (const separator of ["\n", "\n\n", "\r\n\r\n", "\n \t\n\n"]) {
    const context = ["Other Hook guidance.", marker, JSON.stringify(f.delegation)].join(separator);
    assert.deepEqual(parseCursorRepoMemoryDelegation(context, f.options).delegation, f.delegation);
  }
  for (const context of [marker, `${marker}\n \t\n`, `${marker}\n\n${f.context}`,
    `${marker}\n\n${marker}\n\n${JSON.stringify(f.delegation)}`,
    `${marker}\n\nnot-json\n${JSON.stringify(f.delegation)}`]) {
    rejected(() => parseCursorRepoMemoryDelegation(context, f.options), "DELEGATION_INVALID");
  }
});

test("Repo Memory delegation rejects ambiguity, altered identity, credentials and unexpected invocation arguments", () => {
  const f = fixturePaths("/owned fixture");
  for (const context of ["", f.context.replace(marker, "private-canary"),
    f.context.replace('"background":true', '"background":false'), f.context.replace('"name":"memorax-repo-memory"', '"name":"other"'),
    f.context.replace("/generation/skills/memorax-code/references/repo-build.md", "/foreign/references/repo-build.md")]) {
    rejected(() => parseCursorRepoMemoryDelegation(context, f.options), "DELEGATION_INVALID");
  }
  for (const change of [
    (call) => { call.executable += "-other"; }, (call) => { call.args[0] += "-other"; },
    (call) => { call.args[3] += "-other"; }, (call) => { call.args[5] = "../private-canary"; },
    (call) => { call.args[7] = "wrong-run"; }, (call) => { call.args[9] = "private-capability-canary"; },
    (call) => { call.args.push("--unexpected"); }, (call) => { call.env.PRIVATE_KEY = "private-canary"; },
  ]) {
    const call = f.invocation("claim", ticket); change(call);
    const delegation = { ...f.delegation, prompt: `Instructions.\n${JSON.stringify(call)}` };
    rejected(() => parseCursorRepoMemoryDelegation(`${marker}\n${JSON.stringify(delegation)}`, f.options), "DELEGATION_INVALID");
  }
  const duplicate = { ...f.delegation, prompt: `${f.delegation.prompt}\n${JSON.stringify(f.invocation("claim", ticket))}` };
  rejected(() => parseCursorRepoMemoryDelegation(`${marker}\n${JSON.stringify(duplicate)}`, f.options), "DELEGATION_INVALID");
});

test("Repo Memory claim and final rejection require matching returned capabilities and exact outcomes", () => {
  const f = fixturePaths("/owned fixture"), request = parseCursorRepoMemoryDelegation(f.context, f.options);
  for (const claim of [{ ...f.claim, ok: false }, { ...f.claim, status: "requested" }, { ...f.claim, runner: "claude" },
    { ...f.claim, jobId: jobId.replace("12345678", "87654321") }, { ...f.claim, repo: "/foreign" },
    { ...f.claim, claimToken: ticket }, { ...f.claim, instructions: `${f.claim.instructions}\n${JSON.stringify(f.invocation("finish", token))}` },
    { ...f.claim, instructions: f.claim.instructions.replace('"child_failed"', '"cancelled"') }]) {
    rejected(() => parseCursorRepoMemoryClaim(JSON.stringify(claim), request), "CLAIM_INVALID");
  }
  const claimed = parseCursorRepoMemoryClaim(JSON.stringify(f.claim), request);
  for (const result of [{ ...f.rejected, ok: true }, { ...f.rejected, status: "succeeded" },
    { ...f.rejected, failureReason: "child_failed" }]) {
    rejected(() => assertCursorRepoMemoryRejected(JSON.stringify(result), claimed), "FINISH_OUTCOME_MISMATCH");
  }
  for (const result of [{ ...f.rejected, snapshotHead: "e".repeat(40) },
    { ...f.rejected, expiresAt: "2026-10-07T06:00:02.000Z" }]) {
    rejected(() => assertCursorRepoMemoryRejected(JSON.stringify(result), claimed), "FINISH_AUTHORITY_MISMATCH");
  }
  for (const result of [{ ...f.rejected, jobPath: "/private-canary" }, { ...f.rejected, runner: "other" },
    { ...f.rejected, snapshotHead: "private-canary" }, { ...f.rejected, expiresAt: "private-canary" },
    { ok: false, reason: "invalid_capability" }]) {
    rejected(() => assertCursorRepoMemoryRejected(JSON.stringify(result), claimed), "FINISH_SUMMARY_MISMATCH");
  }
  for (const output of ["", "private-path-and-token", "{}\n{}", "null", "[]", "x".repeat(262145)]) {
    rejected(() => assertCursorRepoMemoryRejected(output, claimed), "FINISH_JSON_INVALID");
  }
  for (const output of ["private-path-and-token", "{}\n{}", "x".repeat(262145)]) {
    rejected(() => parseCursorRepoMemoryClaim(output, request), "CLAIM_INVALID");
  }
});

async function diskFixture(run) {
  const temporary = await mkdtemp(join(tmpdir(), "cursor-repo-memory-check-")), root = await realpath(temporary);
  try {
    const f = fixturePaths(root), commonRoot = join(root, "generation/memorax-code-adapter-common/src");
    for (const file of ["runtime-record.mjs", "config-utils.mjs", "windows-directory-retry.mjs",
      "repo-memory/repo-memory-job-marker.mjs", "repo-memory/repo-memory-repository.mjs",
      "repo-memory/repo-memory-job-artifacts.mjs", "repo-memory/repo-memory-shared-bundle.mjs"]) {
      await mkdir(dirname(join(commonRoot, file)), { recursive: true });
      await copyFile(new URL(`../packages/ts/memorax-code-adapter-common/src/${file}`, import.meta.url), join(commonRoot, file));
    }
    await mkdir(join(f.options.repo, ".git/objects"), { recursive: true });
    await mkdir(join(f.options.repo, ".git/refs"), { recursive: true });
    await mkdir(dirname(f.summary.jobPath), { recursive: true });
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    assert.ok(child.pid > 1);
    const state = { ...f.rejected, schema: "cursor_native_repo_memory_job.v1", version: 1,
      parentSessionId, startedAt: "2026-10-07T00:00:00.000Z", claimedAt: "2026-10-07T00:00:01.000Z",
      finishedAt: "2026-10-07T00:00:02.000Z", claimHash: createHash("sha256").update(token).digest("hex"),
      validatorPath: join(root, "generation/skills/memorax-code/scripts/repo-memory.mjs"),
      leasePid: child.pid, sharedSnapshot: { head, ref: "refs/remotes/origin/main", baseHead: null },
    };
    await writeFile(f.summary.jobPath, JSON.stringify(state));
    const paths = await import(pathToFileURL(join(commonRoot, "repo-memory/repo-memory-job-marker.mjs")));
    const shared = await import(pathToFileURL(join(commonRoot, "repo-memory/repo-memory-shared-bundle.mjs")));
    const request = parseCursorRepoMemoryDelegation(f.context, f.options);
    const claimed = parseCursorRepoMemoryClaim(JSON.stringify(f.claim), request);
    await run({ ...f, state, claimed, markerPath: paths.markerPathForRepo(f.options.stateHome, f.options.repo).markerPath,
      baselineRoot: shared.sharedRepoMemoryPath(f.options.stateHome, f.options.repo),
      verify: () => verifyCursorRepoMemoryFailure(claimed, { parentSessionId, snapshotHead: head, timeoutMs: 25 }) });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("Repo Memory failure verification reads real installed path helpers and returns only fixed booleans", async () => {
  await diskFixture(async ({ verify, summary }) => {
    const before = await readFile(summary.jobPath);
    const evidence = await verify();
    assert.deepEqual(evidence, { jobIdentityMatched: true, claimVerified: true, invalidArtifactsRejected: true,
      snapshotMatched: true, snapshotRemoved: true, bundleUnpublished: true, activeMarkerRemoved: true, leaseGuardExited: true });
    assert.deepEqual(await readFile(summary.jobPath), before);
  });
});

test("Repo Memory failure verification rejects wrong state, lingering outputs and a live guard without killing it", async () => {
  for (const change of [
    (state) => { state.parentSessionId = "other"; }, (state) => { state.claimHash = "0".repeat(64); },
    (state) => { state.ticketHash = "a".repeat(64); }, (state) => { state.finishedAt = state.startedAt; },
    (state) => { state.snapshotHead = "e".repeat(40); }, (state) => { state.sharedBaselinePublished = true; },
    (state) => { state.status = "succeeded"; }, (state) => { state.sharedSnapshot.head = "e".repeat(40); },
    (state) => { state.validatorPath = "/foreign/repo-memory.mjs"; },
  ]) await diskFixture(async ({ state, summary, verify }) => {
    change(state); await writeFile(summary.jobPath, JSON.stringify(state));
    await assert.rejects(verify(), { code: "CURSOR_APP_REPO_MEMORY_STATE_INVALID" });
  });
  for (const pathKind of ["marker", "baseline", "versions", "source", "profile"]) await diskFixture(async (f) => {
    const path = { marker: f.markerPath, baseline: join(f.baselineRoot, "baseline.json"),
      versions: join(f.baselineRoot, "versions"), source: join(dirname(f.summary.jobPath), "source"),
      profile: join(f.options.repo, ".repo_memory/PROFILE.md") }[pathKind];
    await mkdir(dirname(path), { recursive: true }); await writeFile(path, "private-canary");
    await assert.rejects(f.verify(), { code: "CURSOR_APP_REPO_MEMORY_STATE_INVALID" });
  });
  await diskFixture(async ({ state, summary, verify }) => {
    state.leasePid = process.pid; await writeFile(summary.jobPath, JSON.stringify(state));
    await assert.rejects(verify(), { code: "CURSOR_APP_REPO_MEMORY_GUARD_REMAINS" });
    assert.doesNotThrow(() => process.kill(process.pid, 0));
  });
});

test("Repo Memory state reads reject oversized records and symlinks without disclosing private data", async () => {
  await diskFixture(async ({ summary, verify }) => {
    await writeFile(summary.jobPath, "x".repeat(262145));
    await assert.rejects(verify(), { code: "CURSOR_APP_REPO_MEMORY_STATE_INVALID" });
  });
  if (process.platform !== "win32") await diskFixture(async ({ summary, verify }) => {
    const target = join(dirname(summary.jobPath), "private-canary");
    await writeFile(target, await readFile(summary.jobPath)); await rm(summary.jobPath);
    await symlink(target, summary.jobPath);
    await assert.rejects(verify(), { code: "CURSOR_APP_REPO_MEMORY_STATE_INVALID" });
  });
});
