import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hookPath = join(packageRoot, "hooks", "repo-memory-update-policy.mjs");

test("repo memory update policy CLI emits the evaluated JSON and rejects invalid arguments", (t) => {
  const root = mkdtempSync(join(tmpdir(), "repo-memory-update-policy-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  mkdirSync(repo);
  const git = (args) => execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  git(["init"]);
  git(["-c", "user.name=Policy Test", "-c", "user.email=policy@example.invalid", "commit", "--allow-empty", "-m", "baseline"]);
  const head = git(["rev-parse", "HEAD"]);
  mkdirSync(join(repo, ".repo_memory"));
  writeFileSync(join(repo, ".repo_memory", "PROFILE.md"), [
    "---",
    'schema: "repo_memory_profile.v0.1"',
    'generated_at: "2026-07-18T00:00:00Z"',
    `local_head: "${head}"`,
    "---",
    "",
  ].join("\n"));
  const configPath = join(root, "policy.toml");
  writeFileSync(configPath, '[memory.repo_update]\npolicy = "daily"\n');
  const env = { ...process.env, MEMORAX_CODE_HOME: join(root, "memorax-code-home") };
  delete env.MEMORAX_CODE_REPO_MEMORY_UPDATE_POLICY;
  delete env.MEMORAX_CODE_REPO_MEMORY_STALE_COMMIT_THRESHOLD;
  delete env.MEMORAX_CODE_REPO_MEMORY_UPDATE_COOLDOWN_HOURS;

  const result = spawnSync(process.execPath, [
    hookPath, "evaluate", "--repo", repo, "--now", "2026-07-18T12:00:00Z", "--config", configPath,
  ], { encoding: "utf8", env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.trim().split(/\r?\n/).length, 1);
  const decision = JSON.parse(result.stdout);
  assert.equal(decision.schema, "repo_memory_update_policy_decision.v1");
  assert.equal(decision.ok, true);
  assert.equal(decision.head, head);
  assert.equal(decision.baseline, head);
  assert.equal(decision.policy, "daily");
  assert.equal(decision.ageHours, 12);

  const invalid = spawnSync(process.execPath, [
    hookPath, "evaluate", "--repo", repo, "--now", "invalid",
  ], { encoding: "utf8", env });
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stdout, "");
  assert.equal(invalid.stderr, "--now must be ISO8601\n");
});
