import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { evaluateRepository } from "../src/repo-memory/repo-memory-update-policy-evaluator.mjs";

const policyEnvKeys = [
  "MEMORAX_CODE_HOME",
  "MEMORAX_CODE_REPO_MEMORY_UPDATE_POLICY",
  "MEMORAX_CODE_REPO_MEMORY_STALE_COMMIT_THRESHOLD",
  "MEMORAX_CODE_REPO_MEMORY_UPDATE_COOLDOWN_HOURS",
];

test("repository evaluator evaluates cooldown using config and the updater-owned timestamp", (t) => {
  const fixture = createRepository(t);
  writeProfile(fixture.repo, fixture.baseline, "2026-07-18T00:00:00Z", [
    'updated_at: "2026-07-16T00:00:00Z"',
  ]);
  writeFileSync(join(fixture.memoraxCodeHome, "config.toml"), [
    "[memory.repo_update]",
    'policy = "adaptive"',
    "commit_threshold = 5",
    "cooldown_hours = 24",
    "",
  ].join("\n"));

  const beforeCooldown = evaluate(fixture, "2026-07-18T23:59:59Z");
  assert.equal(beforeCooldown.trigger, false);
  assert.equal(beforeCooldown.commitsBehind, 2);
  assert.equal(beforeCooldown.lastUpdateSource, "profile.generated_at");

  const afterCooldown = evaluate(fixture, "2026-07-19T00:00:00Z");
  assert.equal(afterCooldown.trigger, true);
  assert.equal(afterCooldown.reason, "cooldown_elapsed");
  assert.equal(afterCooldown.policy, "adaptive");
});

test("repository evaluator detects local PR commits without provider access", (t) => {
  const fixture = createRepository(t, { pullRequestCommit: true });
  writeProfile(fixture.repo, fixture.baseline, "2026-07-18T00:00:00Z");
  writeFileSync(join(fixture.memoraxCodeHome, "config.toml"), [
    "[memory.repo_update]",
    'policy = "pull-request"',
    "",
  ].join("\n"));

  const decision = evaluate(fixture, "2026-07-18T01:00:00Z");
  assert.equal(decision.trigger, true);
  assert.equal(decision.reason, "pull_request_detected");
  assert.equal(decision.pullRequestDetected, true);
});

test("repository evaluator lets env override config", (t) => {
  const fixture = createRepository(t);
  writeProfile(fixture.repo, fixture.baseline, "2026-07-18T00:00:00Z");
  writeFileSync(join(fixture.memoraxCodeHome, "config.toml"), [
    "[memory.repo_update]",
    'policy = "commit-count"',
    "commit_threshold = 5",
    "",
  ].join("\n"));

  const decision = evaluate(fixture, "2026-07-18T01:00:00Z", {
    MEMORAX_CODE_REPO_MEMORY_UPDATE_POLICY: "every-commit",
  });
  assert.equal(decision.trigger, true);
  assert.equal(decision.reason, "pending_commit");
  assert.equal(decision.policySource, "configured");
});

test("repository evaluator falls back to measured defaults for invalid env overrides", (t) => {
  const fixture = createRepository(t);
  writeProfile(fixture.repo, fixture.baseline, "2026-07-18T00:00:00Z");
  writeFileSync(join(fixture.memoraxCodeHome, "config.toml"), [
    "[memory.repo_update]",
    'policy = "every-commit"',
    "commit_threshold = 2",
    "cooldown_hours = 1",
    "",
  ].join("\n"));

  const decision = evaluate(fixture, "2026-07-18T01:00:00Z", {
    MEMORAX_CODE_REPO_MEMORY_UPDATE_POLICY: "unknown",
    MEMORAX_CODE_REPO_MEMORY_STALE_COMMIT_THRESHOLD: "0",
    MEMORAX_CODE_REPO_MEMORY_UPDATE_COOLDOWN_HOURS: "invalid",
  });
  assert.equal(decision.trigger, false);
  assert.equal(decision.policy, "adaptive");
  assert.equal(decision.policySource, "invalid_fallback");
  assert.equal(decision.commitThreshold, 5);
  assert.equal(decision.cooldownHours, 24);
});

test("repository evaluator forces update for a missing baseline", (t) => {
  const fixture = createRepository(t);
  writeProfile(fixture.repo, "", "2026-07-18T00:00:00Z");

  const decision = evaluate(fixture, "2026-07-18T01:00:00Z");
  assert.equal(decision.trigger, true);
  assert.equal(decision.reason, "missing_baseline");
  assert.equal(decision.baselineStatus, "missing");
});

function createRepository(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), "repo-memory-update-policy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  const memoraxCodeHome = join(root, "memorax-code-home");
  mkdirSync(memoraxCodeHome, { recursive: true });
  git(root, ["init", repo]);
  git(repo, ["config", "user.email", "policy@example.invalid"]);
  git(repo, ["config", "user.name", "Policy Test"]);
  commit(repo, "base", "2026-07-18T00:00:00Z");
  const baseline = git(repo, ["rev-parse", "HEAD"]);
  commit(repo, "direct change", "2026-07-18T00:20:00Z");
  commit(
    repo,
    options.pullRequestCommit ? "feat: landed work (#42)" : "second direct change",
    "2026-07-18T00:40:00Z",
  );
  return { repo, memoraxCodeHome, baseline };
}

function writeProfile(repo, localHead, generatedAt, extraFrontmatter = []) {
  const memory = join(repo, ".repo_memory");
  mkdirSync(memory, { recursive: true });
  writeFileSync(join(memory, "PROFILE.md"), [
    "---",
    'schema: "repo_memory_profile.v0.1"',
    `generated_at: "${generatedAt}"`,
    `local_head: "${localHead}"`,
    ...extraFrontmatter,
    "---",
    "",
    "# Fixture Repo",
    "",
  ].join("\n"));
}

function commit(repo, title, date) {
  writeFileSync(join(repo, "fixture.txt"), `${title}\n`);
  git(repo, ["add", "fixture.txt"]);
  git(repo, ["commit", "-m", title], {
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
  });
}

function evaluate(fixture, now, overrides = {}) {
  const previousEnv = policyEnvKeys.map((key) => [key, process.env[key]]);
  try {
    for (const key of policyEnvKeys) delete process.env[key];
    Object.assign(process.env, { MEMORAX_CODE_HOME: fixture.memoraxCodeHome, ...overrides });
    return evaluateRepository({ repo: fixture.repo, nowMs: Date.parse(now) });
  } finally {
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function git(repo, args, env = {}) {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
  }).trim();
}
