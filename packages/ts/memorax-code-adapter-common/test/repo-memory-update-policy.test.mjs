import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_REPO_MEMORY_UPDATE_POLICY,
  evaluateRepoMemoryUpdatePolicy,
  parseRepoMemoryUpdatePolicyConfig,
  resolveRepoMemoryUpdatePolicy,
} from "../src/repo-memory/repo-memory-update-policy.mjs";

test("repo memory update policy defaults to five commits or 24 hours", () => {
  assert.deepEqual(resolveRepoMemoryUpdatePolicy(), {
    policy: "adaptive",
    policySource: "default",
    commitThreshold: 5,
    cooldownHours: 24,
  });
  assert.equal(DEFAULT_REPO_MEMORY_UPDATE_POLICY, "adaptive");
});

test("adaptive policy triggers on either the commit threshold or cooldown", () => {
  const common = {
    policy: "adaptive",
    commitThreshold: 5,
    cooldownHours: 24,
    baselineStatus: "ancestor",
    lastUpdatedAtMs: Date.parse("2026-07-18T00:00:00Z"),
  };
  assert.equal(evaluateRepoMemoryUpdatePolicy({
    ...common,
    commitsBehind: 4,
    nowMs: Date.parse("2026-07-18T23:59:59Z"),
  }).trigger, false);
  assert.equal(evaluateRepoMemoryUpdatePolicy({
    ...common,
    commitsBehind: 5,
    nowMs: Date.parse("2026-07-18T01:00:00Z"),
  }).reason, "commit_threshold_reached");
  assert.equal(evaluateRepoMemoryUpdatePolicy({
    ...common,
    commitsBehind: 1,
    nowMs: Date.parse("2026-07-19T00:00:00Z"),
  }).reason, "cooldown_elapsed");
});

test("repo memory update policy supports every commit, daily, and pull request modes", () => {
  const common = {
    commitThreshold: 5,
    cooldownHours: 24,
    commitsBehind: 1,
    baselineStatus: "ancestor",
    lastUpdatedAtMs: Date.parse("2026-07-18T00:00:00Z"),
  };
  assert.equal(evaluateRepoMemoryUpdatePolicy({
    ...common,
    policy: "every-commit",
    nowMs: Date.parse("2026-07-18T01:00:00Z"),
  }).reason, "pending_commit");
  assert.equal(evaluateRepoMemoryUpdatePolicy({
    ...common,
    policy: "daily",
    nowMs: Date.parse("2026-07-18T23:59:59Z"),
  }).trigger, false);
  assert.equal(evaluateRepoMemoryUpdatePolicy({
    ...common,
    policy: "pull-request",
    pullRequestDetected: true,
    nowMs: Date.parse("2026-07-18T01:00:00Z"),
  }).reason, "pull_request_detected");
  assert.equal(evaluateRepoMemoryUpdatePolicy({
    ...common,
    policy: "pull-request-or-daily",
    nowMs: Date.parse("2026-07-19T00:00:00Z"),
  }).reason, "cooldown_elapsed");
});

test("missing and rewritten baselines always schedule repair-capable updates", () => {
  assert.equal(evaluateRepoMemoryUpdatePolicy({
    policy: "pull-request",
    baselineStatus: "missing",
    commitsBehind: 0,
  }).reason, "missing_baseline");
  assert.equal(evaluateRepoMemoryUpdatePolicy({
    policy: "daily",
    baselineStatus: "not_ancestor",
    commitsBehind: 0,
  }).reason, "baseline_not_ancestor");
});

test("invalid policy and numeric values fall back to measured defaults", () => {
  assert.deepEqual(resolveRepoMemoryUpdatePolicy({
    policy: "unknown",
    commitThreshold: 0,
    cooldownHours: -1,
  }), {
    policy: "adaptive",
    policySource: "invalid_fallback",
    commitThreshold: 5,
    cooldownHours: 24,
  });
  assert.equal(resolveRepoMemoryUpdatePolicy({ policy: "every_commit" }).policySource, "invalid_fallback");
});

test("repo memory update config parser reads only memory.repo_update", () => {
  const config = parseRepoMemoryUpdatePolicyConfig([
    "[memory.skill_reminder]",
    "interval_turns = 9",
    "",
    "[memory.repo_update]",
    'policy = "pull-request-or-daily"',
    "commit_threshold = 7",
    "cooldown_hours = 36",
    "",
    "[model]",
    'policy = "ignored"',
  ].join("\n"));
  assert.deepEqual(config, {
    policy: "pull-request-or-daily",
    commitThreshold: 7,
    cooldownHours: 36,
  });
});
