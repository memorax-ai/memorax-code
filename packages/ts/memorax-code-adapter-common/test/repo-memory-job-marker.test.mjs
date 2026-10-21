import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  markerPathForRepo,
  readActiveRepoMemoryJobMarker,
  releaseRepoMemoryStartupLock,
  repoMemoryJobsDir,
  tryAcquireRepoMemoryStartupLock,
} from "../src/repo-memory/repo-memory-job-marker.mjs";

test("repo memory job marker rejects unsupported versions", (t) => {
  const fixture = createFixture(t);
  writeMarker(fixture, { version: 3 });

  const state = readActiveRepoMemoryJobMarker(fixture);

  assert.equal(state.active, false);
  assert.equal(state.reason, "unsupported_version");
  assert.equal(existsSync(state.markerPath), false);
});

test("repo memory job marker rejects incomplete current records", (t) => {
  const fixture = createFixture(t);
  writeMarker(fixture, { runId: undefined });

  const state = readActiveRepoMemoryJobMarker(fixture);

  assert.equal(state.active, false);
  assert.equal(state.reason, "invalid_record");
  assert.equal(existsSync(state.markerPath), false);
});

test("repo memory startup lock release preserves a replaced lock", (t) => {
  const fixture = createFixture(t);
  const first = tryAcquireRepoMemoryStartupLock(fixture);
  assert.equal(first.acquired, true);
  releaseRepoMemoryStartupLock(first.lock);
  const second = tryAcquireRepoMemoryStartupLock(fixture);
  assert.equal(second.acquired, true);
  releaseRepoMemoryStartupLock(first.lock);
  assert.equal(existsSync(second.lock.lockDir), true);
  releaseRepoMemoryStartupLock(second.lock);
  assert.equal(existsSync(second.lock.lockDir), false);
});

test("repo memory startup locks stay owned while a slow preparer is alive", (t) => {
  const fixture = createFixture(t);
  const first = tryAcquireRepoMemoryStartupLock({ ...fixture, nowMs: Date.now() - 31_000 });
  assert.equal(first.acquired, true);
  t.after(() => releaseRepoMemoryStartupLock(first.lock));
  const competing = tryAcquireRepoMemoryStartupLock(fixture);
  if (competing.acquired) releaseRepoMemoryStartupLock(competing.lock);
  assert.equal(competing.acquired, false);
  assert.equal(competing.reason, "locked");
});

test("repo memory startup locks are recoverable after their owner exits", (t) => {
  const fixture = createFixture(t);
  const first = tryAcquireRepoMemoryStartupLock(fixture);
  const exited = spawnSync(process.execPath, ["-e", ""]);
  assert.equal(exited.status, 0);
  writeFileSync(first.lock.lockPath, JSON.stringify({ ...first.lock, pid: exited.pid }));
  const next = tryAcquireRepoMemoryStartupLock(fixture);
  t.after(() => releaseRepoMemoryStartupLock(next.lock));
  assert.equal(next.acquired, true);
  assert.notEqual(next.lock.token, first.lock.token);
});

test("repo memory lease markers remain active without a process PID", (t) => {
  const fixture = createFixture(t);
  const nowMs = Date.now();
  writeMarker(fixture, {
    version: 2, ownerKind: "lease", pid: undefined,
    startedAt: new Date(nowMs).toISOString(),
    leaseExpiresAt: new Date(nowMs + 60_000).toISOString(),
  });
  const active = readActiveRepoMemoryJobMarker({ ...fixture, nowMs });
  assert.equal(active.active, true);
  assert.equal(active.reason, "leased");
  const expired = readActiveRepoMemoryJobMarker({ ...fixture, nowMs: nowMs + 60_001 });
  assert.equal(expired.active, false);
  assert.equal(expired.reason, "ttl_expired");
  assert.equal(existsSync(expired.markerPath), true, "a reader must not unlink a lease another owner may replace");
});

test("malformed lease markers fail closed without deleting ownership", (t) => {
  const fixture = createFixture(t);
  writeMarker(fixture, { version: 2, ownerKind: "lease", pid: undefined, leaseExpiresAt: "invalid" });
  const state = readActiveRepoMemoryJobMarker(fixture);
  assert.equal(state.active, true);
  assert.equal(state.reason, "invalid_lease");
  assert.equal(existsSync(state.markerPath), true);
});

test("future and excessively long lease markers cannot expire open", (t) => {
  const fixture = createFixture(t);
  const nowMs = Date.now();
  for (const [startedAtMs, expiresAtMs] of [[nowMs + 60_000, nowMs + 120_000], [nowMs, nowMs + 7 * 60 * 60 * 1000]]) {
    writeMarker(fixture, { version: 2, ownerKind: "lease", startedAt: new Date(startedAtMs).toISOString(), leaseExpiresAt: new Date(expiresAtMs).toISOString() });
    const state = readActiveRepoMemoryJobMarker({ ...fixture, nowMs });
    assert.equal(state.active, true);
    assert.equal(state.reason, "invalid_lease");
  }
});

function createFixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "repo-memory-job-state-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  mkdirSync(repo);
  return { memoraxCodeHome: join(root, "memorax-code"), repoRealpath: realpathSync(repo) };
}

function writeMarker({ memoraxCodeHome, repoRealpath }, overrides) {
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
