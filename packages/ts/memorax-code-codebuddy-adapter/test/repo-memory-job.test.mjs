import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { enableCodeBuddyAdapter, codeBuddyInstallPath } from "../src/config.mjs";

test("CodeBuddy repo memory launcher uses non-persistent print mode", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "memorax-codebuddy-repo-memory-dry-run-")));
  const repo = join(root, "repo");
  initRepo(repo);
  const home = join(root, "workbuddy");
  const command = join(root, "codebuddy");
  writeFileSync(command, "#!/bin/sh\n", { mode: 0o755 });
  await enableCodeBuddyAdapter({ codeBuddyHome: home, codeBuddyCommand: command });
  const result = runInstalledJob(home, ["start", "--mode", "build", "--repo", repo, "--dry-run"], {
    MEMORAX_CODE_HOME: join(root, "memorax-code"),
    CODEBUDDY_PLUGIN_ROOT: "/c/Users/incorrect/plugin/root",
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.runner, "codebuddy");
  assert.equal(payload.finalMessageSource, "stdout");
  assert.deepEqual(payload.command.slice(0, 6), [
    command,
    "--print",
    "--output-format",
    "text",
    "--dangerously-skip-permissions",
    "--no-session-persistence",
  ]);
  assert.match(payload.prompt, /repo-build operation/);
  assert.match(payload.prompt, /the `memorax-code` skill/);
  assert.doesNotMatch(payload.prompt, /memorax-code-codebuddy-adapter:memorax-code/);
  assert.doesNotMatch(payload.prompt, /\$memorax-code/);
});

test("CodeBuddy repo memory worker materializes and validates a repository bundle", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "memorax-codebuddy-repo-memory-worker-")));
  const repo = join(root, "repo");
  initRepo(repo);
  const home = join(root, "workbuddy");
  const memoraxCodeHome = join(root, "memorax-code");
  const command = writeFakeCodeBuddy(join(root, "codebuddy"));
  await enableCodeBuddyAdapter({ codeBuddyHome: home, codeBuddyCommand: command });
  const result = runInstalledJob(home, ["start", "--mode", "build", "--repo", repo], {
    MEMORAX_CODE_HOME: memoraxCodeHome,
    MEMORAX_CODE_CODEBUDDY_COMMAND: command,
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  const state = waitForTerminal(payload.jobPath);
  assert.equal(state.status, "succeeded");
  assert.equal(state.runner, "codebuddy");
  assert.equal(state.finalMessageSource, "stdout");
  assert.match(readFileSync(state.finalMessagePath, "utf8"), /CodeBuddy repo memory completed/);
  assert.equal(readFileSync(join(repo, ".repo_memory", "PROFILE.md"), "utf8").includes("repo_memory_profile.v0.1"), true);
});

test("CodeBuddy repo memory worker bounds a non-returning headless client", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "memorax-codebuddy-repo-memory-timeout-")));
  const repo = join(root, "repo");
  initRepo(repo);
  const home = join(root, "workbuddy");
  const memoraxCodeHome = join(root, "memorax-code");
  const command = writeHangingCodeBuddy(join(root, "codebuddy"));
  await enableCodeBuddyAdapter({ codeBuddyHome: home, codeBuddyCommand: command });
  const result = runInstalledJob(home, ["start", "--mode", "build", "--repo", repo], {
    MEMORAX_CODE_HOME: memoraxCodeHome,
    MEMORAX_CODE_CODEBUDDY_COMMAND: command,
    MEMORAX_CODE_REPO_MEMORY_JOB_TIMEOUT_MS: "120",
    MEMORAX_CODE_REPO_MEMORY_JOB_KILL_GRACE_MS: "80",
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  const state = waitForTerminal(payload.jobPath);
  assert.equal(state.status, "failed");
  assert.equal(state.failureReason, "codebuddy_timeout");
  assert.equal(state.timeoutMs, 120);
  assert.ok(state.elapsedMs >= 100, `expected timeout elapsed time, got ${state.elapsedMs}`);
  assert.equal(state.signal, "SIGTERM");
});

function runInstalledJob(home, args, extraEnv = {}) {
  return spawnSync(process.execPath, [join(codeBuddyInstallPath(home), "hooks", "repo-memory-job.mjs"), ...args], {
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
  });
}

function initRepo(repo) {
  mkdirSync(repo, { recursive: true });
  git(repo, ["init"]);
  git(repo, ["config", "user.name", "CodeBuddy Repo Memory Test"]);
  git(repo, ["config", "user.email", "codebuddy-repo-memory@example.invalid"]);
  writeFileSync(join(repo, "README.md"), "# CodeBuddy Repo Memory Test\n");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-m", "initial"]);
  return git(repo, ["rev-parse", "HEAD"]);
}

function writeFakeCodeBuddy(path) {
  writeFileSync(path, `#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const repo = process.cwd();
const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
const memory = join(repo, ".repo_memory");
mkdirSync(join(memory, "raw"), { recursive: true });
mkdirSync(join(memory, "resources"), { recursive: true });
writeFileSync(join(memory, "PROFILE.md"), "---\\nschema: \\\"repo_memory_profile.v0.1\\\"\\nlocal_head: \\\"" + head + "\\\"\\n---\\n\\n# CodeBuddy Repo Memory\\n");
const resource = (schema, rawSource, source, trustState) => "---\\nschema: \\\"" + schema + "\\\"\\nsource: \\\"" + source + "\\\"\\nresource_count: 0\\ntrust_state: \\\"" + trustState + "\\\"\\nraw_source: \\\"" + rawSource + "\\\"\\n---\\n\\n# " + schema + "\\n";
writeFileSync(join(memory, "resources", "commits.md"), resource("repo_memory_commit_resource.v0.1", "../raw/git-commits.json", "git_commit_facets", "draft_resource"));
writeFileSync(join(memory, "resources", "prs.md"), resource("repo_memory_pr_resource.v0.1", "", "provider_skipped_local_only", "unavailable_local_only"));
writeFileSync(join(memory, "resources", "issues.md"), resource("repo_memory_issue_resource.v0.1", "", "provider_skipped_local_only", "unavailable_local_only"));
writeFileSync(join(memory, "raw", "git-commits.json"), "[]\\n");
process.stdout.write("CodeBuddy repo memory completed.\\n");
`, { mode: 0o755 });
  return path;
}

function writeHangingCodeBuddy(path) {
  writeFileSync(path, `#!/usr/bin/env node
setTimeout(() => {}, 60_000);
`, { mode: 0o755 });
  return path;
}

function git(repo, args) {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function waitForTerminal(jobPath, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = JSON.parse(readFileSync(jobPath, "utf8"));
    if (state.status === "succeeded" || state.status === "failed") return state;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for CodeBuddy repo memory job: ${jobPath}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
}
