import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { repoMemoryJobsDir } from "../../memorax-code-adapter-common/src/repo-memory/repo-memory-job-marker.mjs";

const adapterRoot = fileURLToPath(new URL("..", import.meta.url));
const jobHook = join(adapterRoot, "hooks", "repo-memory-job.mjs");

test("OpenCode repo memory launcher uses the local server runner", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "opencode-repo-memory-job-")));
  const repo = join(root, "repo");
  const memoraxCodeHome = join(root, "memorax-code");
  try {
    const head = initRepo(repo);
    const result = runJob(["start", "--mode", "build", "--repo", repo, "--dry-run"], {
      MEMORAX_CODE_HOME: memoraxCodeHome,
    });
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.runner, "opencode");
    assert.equal(payload.finalMessageSource, "stdout");
    assert.equal(payload.snapshotHead, head);
    assert.equal(dirname(dirname(payload.jobPath)), repoMemoryJobsDir(memoraxCodeHome));
    assert.deepEqual(payload.command.slice(0, 4), [
      process.execPath,
      join(adapterRoot, "src", "repo-memory-server-runner.mjs"),
      "--repo",
      repo,
    ]);
    assert.equal(payload.command[4], "--prompt");
    assert.match(payload.command[5], /the `memorax-code` skill/);
    assert.match(payload.command[5], /repo-build operation/);
    assert.match(payload.command[5], /authorized background repo-memory worker/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function runJob(args, env = {}) {
  return spawnSync(process.execPath, [jobHook, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function initRepo(repo) {
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "--quiet"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: repo });
  writeFileSync(join(repo, "README.md"), "# fixture\n");
  execFileSync("git", ["add", "README.md"], { cwd: repo });
  execFileSync("git", ["commit", "--quiet", "-m", "initial"], { cwd: repo });
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
}
