import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
  writeMarker(fixture, { version: 2 });

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
