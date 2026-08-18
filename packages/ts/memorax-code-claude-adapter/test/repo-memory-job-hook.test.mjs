import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  markerPathForRepo,
  repoMemoryJobsDir,
} from "../../memorax-code-adapter-common/src/repo-memory/repo-memory-job-marker.mjs";

const adapterRoot = fileURLToPath(new URL("..", import.meta.url));
const jobHook = join(adapterRoot, "hooks", "repo-memory-job.mjs");

function runJob(args, env = {}) {
  return spawnSync(process.execPath, [jobHook, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function tempRoot(prefix) {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

test("Claude repo memory launcher uses a non-persistent print runner", () => {
  const root = tempRoot("claude-repo-memory-job-");
  const repo = join(root, "repo");
  const memoraxCodeHome = join(root, "memorax-code");
  const claudeCommand = join(root, "claude");
  const head = initRepo(repo);

  const result = runJob(["start", "--mode", "build", "--repo", repo, "--dry-run"], {
    MEMORAX_CODE_HOME: memoraxCodeHome,
    MEMORAX_CODE_CLAUDE_COMMAND: claudeCommand,
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.runner, "claude");
  assert.equal(payload.finalMessageSource, "stdout");
  assert.equal(payload.snapshotHead, head);
  assert.equal(dirname(dirname(payload.jobPath)), repoMemoryJobsDir(memoraxCodeHome));
  assert.deepEqual(payload.command.slice(0, 6), [
    claudeCommand,
    "--print",
    "--output-format",
    "text",
    "--dangerously-skip-permissions",
    "--no-session-persistence",
  ]);
  assert.match(payload.command.at(-1), /\/memorax-code-claude-adapter:memorax-code/);
  assert.doesNotMatch(payload.command.at(-1), /\$memorax-code/);
  mkdirSync(join(repo, ".repo_memory"), { recursive: true });
  writeFileSync(join(repo, ".repo_memory", "PROFILE.md"), "# Repo memory fixture\n");
  const updateResult = runJob(["start", "--mode", "update", "--repo", repo, "--dry-run"], {
    MEMORAX_CODE_HOME: memoraxCodeHome,
    MEMORAX_CODE_CLAUDE_COMMAND: claudeCommand,
  });
  assert.equal(updateResult.status, 0, updateResult.stderr);
  const updatePayload = JSON.parse(updateResult.stdout);
  assert.match(updatePayload.command.at(-1), /\/memorax-code-claude-adapter:memorax-code/);
  assert.doesNotMatch(updatePayload.command.at(-1), /\$memorax-code/);
  assert.match(
    payload.workerCommand[1],
    /memorax-code-adapter-common[\\/]src[\\/]repo-memory[\\/]repo-memory-job-worker\.mjs$/,
  );
});

test("Claude repo memory launcher resolves the installed CLI metadata", () => {
  const root = tempRoot("claude-repo-memory-metadata-");
  const repo = join(root, "repo");
  const pluginRoot = join(root, "plugin");
  const claudeCommand = join(root, "claude-runtime");
  initRepo(repo);
  mkdirSync(pluginRoot, { recursive: true });
  writeFileSync(claudeCommand, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(join(pluginRoot, ".memorax-code-package.json"), `${JSON.stringify({
    version: 1,
    claudeCommand,
  }, null, 2)}\n`);

  const result = runJob(["start", "--mode", "build", "--repo", repo, "--dry-run"], {
    CLAUDE_PLUGIN_ROOT: pluginRoot,
    MEMORAX_CODE_CLAUDE_COMMAND: "",
    MEMORAX_CODE_HOME: join(root, "memorax-code"),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).command[0], claudeCommand);
});

test("Claude repo memory worker captures stdout and validates the generated bundle", () => {
  const root = tempRoot("claude-repo-memory-worker-");
  const repo = join(root, "repo");
  const memoraxCodeHome = join(root, "memorax-code");
  const envLog = join(root, "claude-env.json");
  const argsLog = join(root, "claude-args.json");
  const head = initRepo(repo);
  const fakeClaude = writeSuccessfulFakeClaude(root);

  const result = runJob(["start", "--mode", "build", "--repo", repo], {
    FAKE_CLAUDE_ARGS_LOG: argsLog,
    FAKE_CLAUDE_ENV_LOG: envLog,
    MEMORAX_CODE_CLAUDE_COMMAND: fakeClaude,
    MEMORAX_CODE_HOME: memoraxCodeHome,
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  const state = waitForTerminal(payload.jobPath);
  assert.equal(state.status, "succeeded");
  assert.equal(state.runner, "claude");
  assert.equal(state.finalMessageSource, "stdout");
  assert.equal(state.snapshotHead, head);
  assert.equal(readFileSync(state.finalMessagePath, "utf8"), "Claude repo memory completed.\n");

  const workerEnv = JSON.parse(readFileSync(envLog, "utf8"));
  assert.equal(workerEnv.kind, "repo-memory");
  assert.equal(workerEnv.jobId, state.jobId);
  assert.equal(workerEnv.runId, state.runId);
  assert.equal(workerEnv.snapshotHead, head);

  const args = JSON.parse(readFileSync(argsLog, "utf8"));
  assert.deepEqual(args.slice(0, 5), [
    "--print",
    "--output-format",
    "text",
    "--dangerously-skip-permissions",
    "--no-session-persistence",
  ]);
  assert.match(args.at(-1), /repo-build operation/);
});

test("Claude repo memory launcher deduplicates against a Codex-owned repository marker", () => {
  const root = tempRoot("claude-repo-memory-dedupe-");
  const repo = join(root, "repo");
  const memoraxCodeHome = join(root, "memorax-code");
  initRepo(repo);
  writeActiveMarker(memoraxCodeHome, repo, { runner: "codex" });

  const result = runJob(["start", "--mode", "build", "--repo", repo], {
    MEMORAX_CODE_CLAUDE_COMMAND: join(root, "unused-claude"),
    MEMORAX_CODE_HOME: memoraxCodeHome,
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.alreadyRunning, true);
  assert.equal(payload.runner, "codex");
  assert.equal(payload.jobId, "existing-job");
});

test("Claude Hooks ignore trusted repo memory worker sessions", () => {
  const root = tempRoot("claude-repo-memory-hooks-");
  const memoraxCodeHome = join(root, "memorax-code");
  const envFile = join(root, "claude-env.sh");
  const commandLog = join(root, "memorax-code-command.log");
  const fakeMemoraxCode = join(root, "fake-memorax-code.mjs");
  writeFileSync(fakeMemoraxCode, [
    "#!/usr/bin/env node",
    "import { writeFileSync } from 'node:fs';",
    `writeFileSync(${JSON.stringify(commandLog)}, 'called\\n');`,
    "",
  ].join("\n"), { mode: 0o755 });

  const env = {
    CLAUDE_ENV_FILE: envFile,
    MEMORAX_CODE_CLAUDE_LIFECYCLE_COMMAND: fakeMemoraxCode,
    MEMORAX_CODE_CLAUDE_HOOK_DEBUG: "1",
    MEMORAX_CODE_HOME: memoraxCodeHome,
    MEMORAX_CODE_REPO_MEMORY_JOB_KIND: "repo-memory",
    MEMORAX_CODE_REPO_MEMORY_JOB_ID: "20260725000000000-build-repo-deadbeef",
    MEMORAX_CODE_REPO_MEMORY_JOB_RUN_ID: "0123456789abcdef0123456789abcdef",
  };
  const input = JSON.stringify({
    hook_event_name: "UserPromptSubmit",
    session_id: "claude-session",
    prompt_id: "prompt-1",
    transcript_path: join(root, "transcript.jsonl"),
    prompt: "internal repo memory work",
    cwd: root,
  });
  for (const component of [
    "ensure-backend",
    "capture-cwd",
    "memory-cli-session",
    "memory-skill-reminder",
    "memory-turn",
  ]) {
    const result = spawnSync(
      process.execPath,
      [join(adapterRoot, "hooks", "runtime-hook.mjs"), component],
      {
      encoding: "utf8",
      env: { ...process.env, ...env },
      input,
      },
    );
    assert.equal(result.status, 0, `${component}: ${result.stderr}`);
    assert.equal(result.stdout, "", component);
    assert.equal(result.stderr, "", component);
  }
  assert.equal(existsSync(memoraxCodeHome), false);
  assert.equal(existsSync(envFile), false);
  assert.equal(existsSync(commandLog), false);
});

function writeSuccessfulFakeClaude(root) {
  const fakeClaude = join(root, "fake-claude.mjs");
  writeFileSync(fakeClaude, `#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const repo = process.cwd();
const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
const memory = join(repo, ".repo_memory");
mkdirSync(join(memory, "resources"), { recursive: true });
mkdirSync(join(memory, "raw"), { recursive: true });
writeFileSync(join(memory, "PROFILE.md"), [
  "---",
  'schema: "repo_memory_profile.v0.1"',
  'local_head: "' + head + '"',
  "---",
  "",
  "# Claude Repo Memory",
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
writeFileSync(process.env.FAKE_CLAUDE_ENV_LOG, JSON.stringify({
  kind: process.env.MEMORAX_CODE_REPO_MEMORY_JOB_KIND,
  jobId: process.env.MEMORAX_CODE_REPO_MEMORY_JOB_ID,
  runId: process.env.MEMORAX_CODE_REPO_MEMORY_JOB_RUN_ID,
  snapshotHead: process.env.MEMORAX_CODE_REPO_MEMORY_SNAPSHOT_HEAD,
}));
writeFileSync(process.env.FAKE_CLAUDE_ARGS_LOG, JSON.stringify(process.argv.slice(2)));
process.stdout.write("Claude repo memory completed.\\n");
`, { mode: 0o755 });
  return fakeClaude;
}

function initRepo(repo) {
  mkdirSync(repo, { recursive: true });
  git(repo, ["init"]);
  git(repo, ["config", "user.name", "Claude Repo Memory Test"]);
  git(repo, ["config", "user.email", "claude-repo-memory@example.invalid"]);
  writeFileSync(join(repo, "README.md"), "# Test Repo\n");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-m", "initial"]);
  return git(repo, ["rev-parse", "HEAD"]);
}

function git(repo, args) {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
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

function writeActiveMarker(memoraxCodeHome, repo, overrides = {}) {
  const repoRealpath = realpathSync(repo);
  const marker = markerPathForRepo(memoraxCodeHome, repoRealpath);
  mkdirSync(marker.inProgressDir, { recursive: true });
  writeFileSync(marker.markerPath, `${JSON.stringify({
    version: 1,
    repo: repoRealpath,
    repoKey: marker.repoKey,
    mode: "build",
    runner: "codex",
    jobId: "existing-job",
    jobPath: join(repoMemoryJobsDir(memoraxCodeHome), "existing-job", "job.json"),
    outputLogPath: join(repoMemoryJobsDir(memoraxCodeHome), "existing-job", "output.log"),
    finalMessagePath: join(repoMemoryJobsDir(memoraxCodeHome), "existing-job", "final-message.txt"),
    pid: process.pid,
    runId: "0123456789abcdef0123456789abcdef",
    startedAt: new Date().toISOString(),
    ...overrides,
  }, null, 2)}\n`);
}
