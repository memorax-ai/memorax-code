import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  markerPathForRepo,
  repoMemoryJobsDir,
} from "../../memorax-code-adapter-common/src/repo-memory/repo-memory-job-marker.mjs";

const jobHook = fileURLToPath(new URL("../hooks/repo-memory-job.mjs", import.meta.url));

function runJob(args, env = {}) {
  return spawnSync(process.execPath, [jobHook, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
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
  assert.equal(payload.snapshotHead, head);
  assert.match(
    payload.workerCommand[1],
    /memorax-code-adapter-common[\\/]src[\\/]repo-memory[\\/]repo-memory-job-worker\.mjs$/,
  );
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

for (const expectedMode of ["build", "update"]) {
  test(`Codex maintain completes ${expectedMode} through the packaged Skill validator`, () => {
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
    const head = runGit(repo, ["rev-parse", "HEAD"]).trim();
    const fakeCodex = writeCompletingFakeCodex(root);
    const result = runJob(["maintain", "--repo", repo], {
      MEMORAX_CODE_HOME: memoraxCodeHome,
      MEMORAX_CODE_CODEX_COMMAND: fakeCodex,
      MEMORAX_CODE_REPO_MEMORY_PYTHON_COMMAND: join(root, "missing-python"),
    });
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.action, expectedMode);
    assert.equal(payload.job.mode, expectedMode);
    assert.equal(payload.job.alreadyRunning, false);

    const state = waitForTerminal(payload.job.jobPath);
    assert.equal(state.status, "succeeded");
    assert.equal(state.runner, "codex");
    assert.equal(state.finalMessageSource, "file");
    assert.deepEqual(state.command.slice(0, 6), [fakeCodex, "exec", "--cd", repo, "--sandbox", "danger-full-access"]);
    assert.equal(state.command[state.command.indexOf("--output-last-message") + 1], state.finalMessagePath);
    assert.equal(readFileSync(state.finalMessagePath, "utf8"), "Repo memory operation completed.\n");
    assert.equal(state.snapshotHead, head);
    assert.equal(state.validation.ok, true);
    assert.equal(state.validation.profileHead, head);
    assert.equal(countJobDirs(memoraxCodeHome), 1);
    waitForMarkerAbsent(memoraxCodeHome, repo);
  });
}

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
  waitForMarkerAbsent(memoraxCodeHome, repo);
});

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

function writeValidMemoryBundle(repo, head) {
  const memory = join(repo, ".repo_memory");
  mkdirSync(join(memory, "raw"), { recursive: true });
  mkdirSync(join(memory, "resources"), { recursive: true });
  writeFileSync(join(memory, "PROFILE.md"), `---\nschema: "repo_memory_profile.v0.1"\nlocal_head: "${head}"\n---\n\n# Test Repo Memory Profile\n`);
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
