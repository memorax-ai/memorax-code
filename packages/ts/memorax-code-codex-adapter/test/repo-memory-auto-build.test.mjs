import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  resolveGitWorktreeRoot,
  scheduleMissingRepoMemoryBuild,
} from "../../memorax-code-adapter-common/src/repo-memory/repo-memory-auto-build.mjs";
import {
  markerPathForRepo,
  writeRepoMemoryJobMarker,
} from "../../memorax-code-adapter-common/src/repo-memory/repo-memory-job-marker.mjs";

test("repo memory auto-build resolves normal and linked Git worktrees without invoking Git", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-auto-build-root-"));
  try {
    const repo = await createRepo(root);
    const canonicalRepo = await realpath(repo);
    const nested = join(repo, "src", "nested");
    await mkdir(nested, { recursive: true });
    assert.equal(resolveGitWorktreeRoot(nested), canonicalRepo);

    const linked = join(root, "linked");
    runGit(repo, ["worktree", "add", "-b", "linked", linked]);
    const linkedNested = join(linked, "packages", "demo");
    await mkdir(linkedNested, { recursive: true });
    assert.equal(resolveGitWorktreeRoot(linkedNested), await realpath(linked));

    const plain = join(root, "plain");
    await mkdir(plain);
    assert.equal(resolveGitWorktreeRoot(plain), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repo memory auto-build schedules maintain only when PROFILE.md is missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-auto-build-missing-"));
  const previousHome = process.env.MEMORAX_CODE_HOME;
  const previousLog = process.env.MEMORAX_CODE_AUTO_BUILD_TEST_LOG;
  try {
    const repo = await createRepo(root);
    const canonicalRepo = await realpath(repo);
    const pluginRoot = await createFakePlugin(root);
    const memoraxCodeHome = join(root, "memorax-code");
    const logPath = join(root, "auto-build.log");
    process.env.MEMORAX_CODE_HOME = memoraxCodeHome;
    process.env.MEMORAX_CODE_AUTO_BUILD_TEST_LOG = logPath;

    const scheduled = scheduleMissingRepoMemoryBuild({
      hook_event_name: "UserPromptSubmit",
      session_id: "session-a",
      cwd: join(repo, "src"),
      workspace_kind: "git",
    }, {
      adapterDir: "codex",
      debugEnv: "MEMORAX_CODE_CODEX_HOOK_DEBUG",
      pluginRoot,
      sessionKeyPrefix: "codex",
    });
    assert.equal(scheduled.scheduled, true);
    assert.equal(scheduled.reason, "profile_missing");
    const invocation = JSON.parse(await waitForFile(logPath));
    assert.deepEqual(invocation.args, ["maintain", "--repo", canonicalRepo]);
    assert.equal(invocation.cwd, canonicalRepo);

    await mkdir(join(repo, ".repo_memory"));
    await writeFile(join(repo, ".repo_memory", "PROFILE.md"), "# Existing Repo Memory\n");
    const existing = scheduleMissingRepoMemoryBuild({
      hook_event_name: "UserPromptSubmit",
      session_id: "session-a",
      cwd: repo,
    }, {
      adapterDir: "codex",
      pluginRoot,
      sessionKeyPrefix: "codex",
    });
    assert.equal(existing.scheduled, false);
    assert.equal(existing.reason, "profile_present");
    await delay(100);
    assert.equal((await readFile(logPath, "utf8")).trim().split(/\r?\n/).length, 1);
  } finally {
    restoreEnv("MEMORAX_CODE_HOME", previousHome);
    restoreEnv("MEMORAX_CODE_AUTO_BUILD_TEST_LOG", previousLog);
    await rm(root, { recursive: true, force: true });
  }
});

test("repo memory auto-build uses captured workspace state and deduplicates an active job", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-auto-build-active-"));
  const previousHome = process.env.MEMORAX_CODE_HOME;
  const previousLog = process.env.MEMORAX_CODE_AUTO_BUILD_TEST_LOG;
  try {
    const repo = await createRepo(root);
    const canonicalRepo = await realpath(repo);
    const pluginRoot = await createFakePlugin(root);
    const memoraxCodeHome = join(root, "memorax-code");
    const logPath = join(root, "auto-build.log");
    process.env.MEMORAX_CODE_HOME = memoraxCodeHome;
    process.env.MEMORAX_CODE_AUTO_BUILD_TEST_LOG = logPath;
    await writeWorkspaceState(memoraxCodeHome, canonicalRepo);

    const { repoKey } = markerPathForRepo(memoraxCodeHome, canonicalRepo);
    writeRepoMemoryJobMarker({
      memoraxCodeHome,
      marker: {
        version: 1,
        repo: canonicalRepo,
        repoKey,
        mode: "build",
        jobId: "20260804000000000-build-repo-1234abcd",
        jobPath: join(root, "job.json"),
        outputLogPath: join(root, "output.log"),
        finalMessagePath: join(root, "final-message.txt"),
        pid: process.pid,
        runner: "codex",
        runId: "a".repeat(32),
        startedAt: new Date().toISOString(),
      },
    });

    const result = scheduleMissingRepoMemoryBuild({
      hook_event_name: "UserPromptSubmit",
      session_id: "captured-session",
    }, {
      adapterDir: "codex",
      pluginRoot,
      sessionKeyPrefix: "codex",
    });
    assert.equal(result.scheduled, false);
    assert.equal(result.reason, "active_job");
    await delay(100);
    await assert.rejects(readFile(logPath, "utf8"), /ENOENT/);
  } finally {
    restoreEnv("MEMORAX_CODE_HOME", previousHome);
    restoreEnv("MEMORAX_CODE_AUTO_BUILD_TEST_LOG", previousLog);
    await rm(root, { recursive: true, force: true });
  }
});

test("repo memory auto-build skips projectless and non-Git workspaces", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-auto-build-skip-"));
  try {
    const pluginRoot = await createFakePlugin(root);
    const projectless = scheduleMissingRepoMemoryBuild({
      hook_event_name: "UserPromptSubmit",
      cwd: root,
      workspace_kind: "projectless",
    }, { pluginRoot });
    assert.equal(projectless.reason, "projectless_workspace");

    const nonGit = scheduleMissingRepoMemoryBuild({
      hook_event_name: "UserPromptSubmit",
      cwd: root,
    }, { pluginRoot });
    assert.equal(nonGit.reason, "git_worktree_unavailable");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function createRepo(root) {
  const repo = join(root, "repo");
  await mkdir(join(repo, "src"), { recursive: true });
  runGit(repo, ["init", "-b", "main"]);
  await writeFile(join(repo, "README.md"), "# Repo Memory auto-build fixture\n");
  runGit(repo, ["add", "README.md"]);
  runGit(repo, ["commit", "-m", "initial fixture"]);
  return repo;
}

async function createFakePlugin(root) {
  const pluginRoot = join(root, "plugin");
  const hookPath = join(pluginRoot, "hooks", "repo-memory-job.mjs");
  await mkdir(dirname(hookPath), { recursive: true });
  await writeFile(hookPath, [
    'import { appendFileSync } from "node:fs";',
    "const path = process.env.MEMORAX_CODE_AUTO_BUILD_TEST_LOG;",
    "appendFileSync(path, `${JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() })}\\n`);",
    "",
  ].join("\n"));
  return pluginRoot;
}

async function writeWorkspaceState(memoraxCodeHome, repo) {
  const path = join(memoraxCodeHome, "adapters", "codex", "workspaces.json");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({
    version: 1,
    runtime: "codex",
    sessions: {
      "captured-session": { cwd: repo },
    },
  })}\n`);
}

function runGit(cwd, args) {
  const result = spawnSync("git", [
    "-c",
    "user.name=Repo Memory Auto Build Test",
    "-c",
    "user.email=repo-memory-auto-build@example.invalid",
    ...args,
  ], { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

async function waitForFile(path) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      const value = await readFile(path, "utf8");
      if (value.trim()) return value.trim().split(/\r?\n/)[0];
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await delay(25);
  }
  throw new Error(`timed out waiting for ${path}`);
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
