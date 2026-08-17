import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillRoot = join(packageRoot, "skills", "memorax-code");
const detectScript = join(skillRoot, "scripts", "detect_updates.py");

function runGit(cwd, args) {
  const result = spawnSync(
    "git",
    ["-c", "user.name=Repo Memory Updater Test", "-c", "user.email=repo-memory-updater@example.invalid", ...args],
    { cwd, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeProfile(memory, localHead, extraFrontmatter = "") {
  writeFileSync(
    join(memory, "PROFILE.md"),
    `---
schema: "repo_memory_profile.v0.1"
local_head: "${localHead}"
${extraFrontmatter}
---

# Repo Memory
`,
  );
}

function writeCommitResource(memory, commits) {
  writeFileSync(
    join(memory, "resources", "commits.md"),
    `---
schema: "repo_memory_commit_resource.v0.1"
resource_count: ${commits.length}
raw_source: "../raw/git-commits.json"
---

# Commit Resource Snapshot

${commits.map((commit) => `## Commit ${commit.shortSha}: ${commit.title}

- SHA: \`${commit.sha}\`
- Description: ${commit.title}.
`).join("\n---\n\n")}`,
  );
}

function writePrResource(memory, prs) {
  writeFileSync(
    join(memory, "resources", "prs.md"),
    `---
schema: "repo_memory_pr_resource.v0.1"
resource_count: ${prs.length}
raw_source: "../raw/github-facets.json"
---

# Pull Request Resource Snapshot

${prs.map((pr) => `## PR/MR #${pr.number}: ${pr.title}

- State: \`${pr.state}\`
- Branch: \`${pr.base ?? "main"} <- ${pr.head ?? `pr-${pr.number}`}\`
- Description: ${pr.title}.
- URL: ${pr.url ?? `https://example.test/pull/${pr.number}`}
`).join("\n---\n\n")}`,
  );
}

function writeIssueResource(memory, issues) {
  writeFileSync(
    join(memory, "resources", "issues.md"),
    `---
schema: "repo_memory_issue_resource.v0.1"
resource_count: ${issues.length}
raw_source: "../raw/github-facets.json"
---

# Issue Resource Snapshot

${issues.map((issue) => `## Issue #${issue.number}: ${issue.title}

- State: \`${issue.state}\`
- Description: ${issue.title}.
- URL: ${issue.url ?? `https://example.test/issues/${issue.number}`}
`).join("\n---\n\n")}`,
  );
}

function createProviderSuccessGh(path) {
  writeFileSync(
    path,
    `#!/bin/sh
set -eu
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  printf '%s\\n' '[{"number":42},{"number":43}]'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  case "$3" in
    42)
      printf '%s\\n' '{"number":42,"title":"existing PR refreshed","body":"refreshed","state":"MERGED","url":"https://example.test/pull/42","updatedAt":"2026-07-03T00:00:00Z","createdAt":"2026-07-01T00:00:00Z","closedAt":"2026-07-03T00:00:00Z","mergedAt":"2026-07-03T00:00:00Z","author":{"login":"tester"},"comments":[],"reviews":[],"latestReviews":[],"reviewDecision":"","files":[],"commits":[{"messageHeadline":"baseline","oid":"'"$BASELINE_SHA"'"}],"closingIssuesReferences":[],"mergeCommit":{"oid":"'"$BASELINE_SHA"'"},"baseRefName":"main","headRefName":"pr-42","headRepository":{"nameWithOwner":"owner/repo"},"headRepositoryOwner":{"login":"owner"},"isDraft":false,"additions":1,"deletions":0,"changedFiles":1}'
      ;;
    43)
      printf '%s\\n' '{"number":43,"title":"new PR","body":"new","state":"MERGED","url":"https://example.test/pull/43","updatedAt":"2026-07-03T00:00:00Z","createdAt":"2026-07-03T00:00:00Z","closedAt":"2026-07-03T00:00:00Z","mergedAt":"2026-07-03T00:00:00Z","author":{"login":"tester"},"comments":[],"reviews":[],"latestReviews":[],"reviewDecision":"","files":[],"commits":[{"messageHeadline":"baseline","oid":"'"$BASELINE_SHA"'"}],"closingIssuesReferences":[],"mergeCommit":{"oid":"'"$BASELINE_SHA"'"},"baseRefName":"main","headRefName":"pr-43","headRepository":{"nameWithOwner":"owner/repo"},"headRepositoryOwner":{"login":"owner"},"isDraft":false,"additions":1,"deletions":0,"changedFiles":1}'
      ;;
    *)
      printf 'unexpected PR number: %s\\n' "$3" >&2
      exit 2
      ;;
  esac
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "list" ]; then
  printf '%s\\n' '[{"number":7},{"number":8}]'
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "view" ]; then
  case "$3" in
    7)
      printf '%s\\n' '{"number":7,"title":"existing issue refreshed","body":"refreshed","state":"CLOSED","url":"https://example.test/issues/7","updatedAt":"2026-07-03T00:00:00Z","labels":[],"comments":[]}'
      ;;
    8)
      printf '%s\\n' '{"number":8,"title":"new issue","body":"new","state":"OPEN","url":"https://example.test/issues/8","updatedAt":"2026-07-03T00:00:00Z","labels":[],"comments":[]}'
      ;;
    *)
      printf 'unexpected issue number: %s\\n' "$3" >&2
      exit 2
      ;;
  esac
  exit 0
fi
printf 'unexpected gh args: %s\\n' "$*" >&2
exit 2
`,
  );
  chmodSync(path, 0o755);
}

function createEmptyProviderGh(path) {
  writeFileSync(
    path,
    `#!/bin/sh
set -eu
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  printf '%s\\n' '[]'
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "list" ]; then
  printf '%s\\n' '[]'
  exit 0
fi
printf 'unexpected gh args: %s\\n' "$*" >&2
exit 2
`,
  );
  chmodSync(path, 0o755);
}

function createSameTitleUpdatedGh(path) {
  writeFileSync(
    path,
    `#!/bin/sh
set -eu
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  printf '%s\\n' '[{"number":42}]'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  printf '%s\\n' '{"number":42,"title":"same PR title","body":"updated provider body","state":"MERGED","url":"https://example.test/pull/42","updatedAt":"2026-07-04T00:00:00Z","createdAt":"2026-07-01T00:00:00Z","closedAt":"2026-07-04T00:00:00Z","mergedAt":"2026-07-04T00:00:00Z","author":{"login":"tester"},"comments":[],"reviews":[],"latestReviews":[],"reviewDecision":"","files":[{"path":"src/provider.ts"}],"commits":[{"messageHeadline":"metadata-only update","oid":"'"$BASELINE_SHA"'"}],"closingIssuesReferences":[],"mergeCommit":{"oid":"'"$BASELINE_SHA"'"},"baseRefName":"main","headRefName":"pr-42","headRepository":{"nameWithOwner":"owner/repo"},"headRepositoryOwner":{"login":"owner"},"isDraft":false,"additions":2,"deletions":1,"changedFiles":1}'
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "list" ]; then
  printf '%s\\n' '[]'
  exit 0
fi
printf 'unexpected gh args: %s\\n' "$*" >&2
exit 2
`,
  );
  chmodSync(path, 0o755);
}

test("memorax-code repo-update reference declares incremental update boundaries", () => {
  const skill = readFileSync(join(skillRoot, "references", "repo-update.md"), "utf8");
  assert.match(skill, /incremental/i);
  assert.match(skill, /Do not rebuild/i);
  assert.match(skill, /Default Settings/);
  assert.match(skill, /User Count Requests/);
  assert.match(skill, /defaults\.json/);
  assert.match(skill, /repoHistory\.mode/);
  assert.match(skill, /--history-mode/);
  assert.match(skill, /effective history policy/);
  assert.match(skill, /--pr-limit/);
  assert.match(skill, /--issue-limit/);
  assert.match(skill, /builder_helpers/);
  assert.match(skill, /provider_items/);
  assert.match(skill, /missing_baseline_commit/);
  assert.match(skill, /repo-build\.md/);
  assert.match(skill, /repo-read\.md/);
  assert.match(skill, /full refresh/i);
  assert.match(skill, /--reuse/);
  assert.match(skill, /Report Gates/);
  assert.match(skill, /Read the JSON report as gates before editing/);
  assert.match(skill, /Provider Sandbox and Transport Failures/);
  assert.match(skill, /gh\/glab/);
  assert.match(skill, /approved network-enabled mode/);
  assert.match(skill, /Do not use a restricted shell sandbox to verify provider\/API availability/);
  assert.match(skill, /Verify provider authentication in the same normal shell/);
  assert.match(skill, /--hostname <host>/);
  assert.match(skill, /Authenticate with `gh auth login` or `glab auth login`/);
  assert.match(skill, /Do not treat provider fetch failure as no PR\/issue delta/);
  assert.match(skill, /Do not re-enable commit or provider channels disabled by policy/);
  assert.match(skill, /set `PROFILE\.md\.generated_at` to the successful update time/);
  assert.match(skill, /read-time cooldown policy uses this timestamp/);

  const openaiYaml = readFileSync(join(skillRoot, "agents", "openai.yaml"), "utf8");
  assert.match(openaiYaml, /display_name: "MemoraX Code"/);
  assert.match(openaiYaml, /Use \$memorax-code/);
  assert.match(openaiYaml, /allow_implicit_invocation: true/);

  const claudeYaml = readFileSync(join(skillRoot, "agents", "claude.yaml"), "utf8");
  assert.doesNotMatch(skill, /\bCodex\b/);
  assert.match(skill, /normal assistant messages/);
  assert.match(claudeYaml, /display_name: "MemoraX Code"/);
  assert.match(claudeYaml, /Use \/memorax-code-claude-adapter:memorax-code/);
  assert.doesNotMatch(claudeYaml, /Use \/memorax-code to route/);
  assert.match(claudeYaml, /~\/\.claude\/skills\/memorax-code/);
  assert.match(claudeYaml, /\.claude\/skills\/memorax-code/);
  assert.match(claudeYaml, /allow_implicit_invocation: true/);
});

test("repo-memory-updater detects only local commits after the stored memory baseline", () => {
  const root = mkdtempSync(join(tmpdir(), "memorax-code-repo-memory-updater."));
  try {
    const repo = join(root, "repo");
    const memory = join(repo, ".repo_memory");
    mkdirSync(repo);
    runGit(repo, ["init", "-b", "main"]);
    writeFileSync(join(repo, "README.md"), "# Repo\n");
    runGit(repo, ["add", "README.md"]);
    runGit(repo, ["commit", "-m", "initial repo memory baseline"]);
    const baselineSha = runGit(repo, ["rev-parse", "HEAD"]);
    writeFileSync(join(repo, "feature.txt"), "new memory signal\n");
    runGit(repo, ["add", "feature.txt"]);
    runGit(repo, ["commit", "-m", "add updater delta signal"]);
    const latestSha = runGit(repo, ["rev-parse", "HEAD"]);

    mkdirSync(join(memory, "resources"), { recursive: true });
    mkdirSync(join(memory, "raw"), { recursive: true });
    writeProfile(memory, baselineSha);
    writeCommitResource(memory, [{
      sha: baselineSha,
      shortSha: baselineSha.slice(0, 12),
      title: "initial repo memory baseline",
    }]);
    writePrResource(memory, [{ number: 42, title: "existing PR baseline", state: "MERGED" }]);
    writeIssueResource(memory, [{ number: 7, title: "existing issue baseline", state: "CLOSED" }]);
    writeJson(join(memory, "raw", "git-commits.json"), [
      {
        sourceType: "commit",
        facetId: `commit.${baselineSha.slice(0, 12)}`,
        sha: baselineSha,
        short_sha: baselineSha.slice(0, 12),
        title: "initial repo memory baseline",
      },
    ]);

    const result = spawnSync("python3", [detectScript, "--repo-path", repo, "--pretty"], {
      cwd: packageRoot,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);

    assert.equal(report.ok, true);
    assert.equal(report.memory_path, realpathSync(memory));
    assert.deepEqual(report.effective_settings.limits, { prs: 30, issues: 30 });
    assert.match(report.effective_settings.source, /memorax-code\/defaults\.json$/);
    assert.deepEqual(report.effective_settings.overrides, {});
    assert.match(report.builder_helpers.skill_dir, /memorax-code$/);
    assert.match(report.builder_helpers.files.defaults.path, /memorax-code\/defaults\.json$/);
    assert.equal(report.builder_helpers.files.defaults.exists, true);
    assert.equal("build_indexes" in report.builder_helpers.files, false);
    assert.match(report.builder_helpers.files.validate_memory.path, /memorax-code\/scripts\/validate_memory\.py$/);
    assert.equal(report.builder_helpers.files.validate_memory.exists, true);
    assert.equal(typeof report.builder_helpers.files.validate_memory.mtime_ns, "number");
    assert.ok(report.builder_helpers.files.validate_memory.mtime_ns > 0);
    assert.equal(report.baseline.local_commit_sha, baselineSha);
    assert.equal(report.current.local_head, latestSha);
    assert.deepEqual(
      report.deltas.local_commits.map((commit) => commit.sha),
      [latestSha],
    );
    assert.deepEqual(report.deltas.pull_requests.added_numbers, []);
    assert.deepEqual(report.deltas.issues.added_numbers, []);
    assert.equal(report.actions.length > 0, true);
    assert.match(report.actions.join("\n"), /resources\/commits\.md/);
    assert.doesNotMatch(report.actions.join("\n"), /full rebuild/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("repo-memory-updater reads PR and issue limits from v2 repoHistory defaults", () => {
  const root = mkdtempSync(join(tmpdir(), "memorax-code-repo-memory-updater-v2-defaults."));
  try {
    const repo = join(root, "repo");
    const memory = join(repo, ".repo_memory");
    const tempSkillRoot = join(root, "skill", "memorax-code");
    const tempScripts = join(tempSkillRoot, "scripts");
    mkdirSync(repo);
    mkdirSync(join(memory, "resources"), { recursive: true });
    mkdirSync(join(memory, "raw"), { recursive: true });
    mkdirSync(tempScripts, { recursive: true });
    copyFileSync(detectScript, join(tempScripts, "detect_updates.py"));
    writeJson(join(tempSkillRoot, "defaults.json"), {
      schema: "repo_memory_builder_defaults.v2",
      repoHistory: {
        mode: "provider",
        limits: {
          commits: 11,
          prs: 5,
          issues: 6,
        },
      },
      summaryChars: 1234,
    });

    runGit(repo, ["init", "-b", "main"]);
    writeFileSync(join(repo, "README.md"), "# Repo\n");
    runGit(repo, ["add", "README.md"]);
    runGit(repo, ["commit", "-m", "initial v2 defaults baseline"]);
    const baselineSha = runGit(repo, ["rev-parse", "HEAD"]);

    writeProfile(memory, baselineSha);
    writeCommitResource(memory, [{
      sha: baselineSha,
      shortSha: baselineSha.slice(0, 12),
      title: "initial v2 defaults baseline",
    }]);
    writePrResource(memory, []);
    writeIssueResource(memory, []);
    writeJson(join(memory, "raw", "git-commits.json"), [{ sourceType: "commit", sha: baselineSha }]);

    const result = spawnSync("python3", [join(tempScripts, "detect_updates.py"), "--repo-path", repo, "--provider-mode", "off", "--pretty"], {
      cwd: packageRoot,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);

    assert.deepEqual(report.effective_settings.limits, { prs: 5, issues: 6 });
    assert.equal(report.effective_settings.summary_chars, 1234);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repo-memory-updater skips commit and provider deltas when repoHistory mode is none", () => {
  const root = mkdtempSync(join(tmpdir(), "memorax-code-repo-memory-updater-history-none."));
  try {
    const repo = join(root, "repo");
    const memory = join(repo, ".repo_memory");
    const tempSkillRoot = join(root, "skill", "memorax-code");
    const tempScripts = join(tempSkillRoot, "scripts");
    const bin = join(root, "bin");
    const gh = join(bin, "gh");
    mkdirSync(repo);
    mkdirSync(bin);
    mkdirSync(join(memory, "resources"), { recursive: true });
    mkdirSync(join(memory, "raw"), { recursive: true });
    mkdirSync(tempScripts, { recursive: true });
    copyFileSync(detectScript, join(tempScripts, "detect_updates.py"));
    writeJson(join(tempSkillRoot, "defaults.json"), {
      schema: "repo_memory_builder_defaults.v2",
      repoHistory: {
        mode: "none",
        limits: { commits: 11, prs: 5, issues: 6 },
      },
      summaryChars: 1234,
    });
    writeFileSync(gh, "#!/bin/sh\nprintf 'provider CLI must not be called\\n' >&2\nexit 2\n", { mode: 0o755 });

    runGit(repo, ["init", "-b", "main"]);
    writeFileSync(join(repo, "README.md"), "# Repo\n");
    runGit(repo, ["add", "README.md"]);
    runGit(repo, ["commit", "-m", "initial history none baseline"]);
    const baselineSha = runGit(repo, ["rev-parse", "HEAD"]);
    runGit(repo, ["remote", "add", "origin", "git@github.com:owner/repo.git"]);
    writeFileSync(join(repo, "feature.txt"), "new history that policy disables\n");
    runGit(repo, ["add", "feature.txt"]);
    runGit(repo, ["commit", "-m", "new commit ignored by history none"]);

    writeProfile(memory, baselineSha);
    writeCommitResource(memory, [{
      sha: baselineSha,
      shortSha: baselineSha.slice(0, 12),
      title: "initial history none baseline",
    }]);
    writePrResource(memory, [{ number: 42, title: "existing PR baseline", state: "MERGED" }]);
    writeIssueResource(memory, [{ number: 7, title: "existing issue baseline", state: "CLOSED" }]);
    writeJson(join(memory, "raw", "git-commits.json"), [{ sourceType: "commit", sha: baselineSha }]);

    const result = spawnSync("python3", [join(tempScripts, "detect_updates.py"), "--repo-path", repo, "--pretty"], {
      cwd: packageRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);

    assert.equal(report.effective_settings.history.mode, "none");
    assert.deepEqual(report.effective_settings.history.collect, { commits: false, provider: false });
    assert.deepEqual(report.deltas.local_commits, []);
    assert.equal(report.deltas.local_commit_status.status, "skipped");
    assert.equal(report.deltas.local_commit_status.reason, "history_disabled_by_policy");
    assert.equal(report.deltas.commit_delta_skipped, "history_disabled_by_policy");
    assert.equal(report.current.provider.evidence_state, "skipped_by_policy");
    assert.equal(report.current.provider_fetch.attempted, false);
    assert.equal(report.current.provider_fetch.reason, "history_disabled_by_policy");
    assert.deepEqual(report.current.provider_items.pull_requests, []);
    assert.deepEqual(report.current.provider_items.issues, []);
    assert.deepEqual(report.deltas.pull_requests.upsert_numbers, []);
    assert.deepEqual(report.deltas.issues.upsert_numbers, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repo-memory-updater keeps local commits but skips providers when repoHistory mode is local-only", () => {
  const root = mkdtempSync(join(tmpdir(), "memorax-code-repo-memory-updater-history-local-only."));
  try {
    const repo = join(root, "repo");
    const memory = join(repo, ".repo_memory");
    const tempSkillRoot = join(root, "skill", "memorax-code");
    const tempScripts = join(tempSkillRoot, "scripts");
    const bin = join(root, "bin");
    const gh = join(bin, "gh");
    mkdirSync(repo);
    mkdirSync(bin);
    mkdirSync(join(memory, "resources"), { recursive: true });
    mkdirSync(join(memory, "raw"), { recursive: true });
    mkdirSync(tempScripts, { recursive: true });
    copyFileSync(detectScript, join(tempScripts, "detect_updates.py"));
    writeJson(join(tempSkillRoot, "defaults.json"), {
      schema: "repo_memory_builder_defaults.v2",
      repoHistory: {
        mode: "local-only",
        limits: { commits: 11, prs: 5, issues: 6 },
      },
      summaryChars: 1234,
    });
    writeFileSync(gh, "#!/bin/sh\nprintf 'provider CLI must not be called\\n' >&2\nexit 2\n", { mode: 0o755 });

    runGit(repo, ["init", "-b", "main"]);
    writeFileSync(join(repo, "README.md"), "# Repo\n");
    runGit(repo, ["add", "README.md"]);
    runGit(repo, ["commit", "-m", "initial local-only baseline"]);
    const baselineSha = runGit(repo, ["rev-parse", "HEAD"]);
    runGit(repo, ["remote", "add", "origin", "git@github.com:owner/repo.git"]);
    writeFileSync(join(repo, "feature.txt"), "new local history\n");
    runGit(repo, ["add", "feature.txt"]);
    runGit(repo, ["commit", "-m", "new local-only commit"]);
    const latestSha = runGit(repo, ["rev-parse", "HEAD"]);

    writeProfile(memory, baselineSha);
    writeCommitResource(memory, [{
      sha: baselineSha,
      shortSha: baselineSha.slice(0, 12),
      title: "initial local-only baseline",
    }]);
    writePrResource(memory, [{ number: 42, title: "existing PR baseline", state: "MERGED" }]);
    writeIssueResource(memory, [{ number: 7, title: "existing issue baseline", state: "CLOSED" }]);
    writeJson(join(memory, "raw", "git-commits.json"), [{ sourceType: "commit", sha: baselineSha }]);

    const result = spawnSync("python3", [join(tempScripts, "detect_updates.py"), "--repo-path", repo, "--pretty"], {
      cwd: packageRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);

    assert.equal(report.effective_settings.history.mode, "local-only");
    assert.deepEqual(report.effective_settings.history.collect, { commits: true, provider: false });
    assert.deepEqual(report.deltas.local_commits.map((commit) => commit.sha), [latestSha]);
    assert.equal(report.deltas.local_commit_status.status, "ok");
    assert.equal(report.current.provider.evidence_state, "skipped_by_policy");
    assert.equal(report.current.provider_fetch.attempted, false);
    assert.equal(report.current.provider_fetch.reason, "history_provider_disabled_by_policy");
    assert.deepEqual(report.current.provider_items.pull_requests, []);
    assert.deepEqual(report.current.provider_items.issues, []);
    assert.deepEqual(report.deltas.pull_requests.upsert_numbers, []);
    assert.deepEqual(report.deltas.issues.upsert_numbers, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repo-memory-updater compares provider PR and issue resources incrementally", () => {
  const root = mkdtempSync(join(tmpdir(), "memorax-code-repo-memory-provider-delta."));
  try {
    const repo = join(root, "repo");
    const memory = join(repo, ".repo_memory");
    const bin = join(root, "bin");
    const gh = join(bin, "gh");
    mkdirSync(repo);
    mkdirSync(bin);
    mkdirSync(join(memory, "raw"), { recursive: true });
    mkdirSync(join(memory, "resources"), { recursive: true });
    createProviderSuccessGh(gh);

    runGit(repo, ["init", "-b", "main"]);
    writeFileSync(join(repo, "README.md"), "# Repo\n");
    runGit(repo, ["add", "README.md"]);
    runGit(repo, ["commit", "-m", "initial provider baseline"]);
    const baselineSha = runGit(repo, ["rev-parse", "HEAD"]);
    runGit(repo, ["remote", "add", "origin", "git@github.com:owner/repo.git"]);

    writeProfile(memory, baselineSha);
    writeCommitResource(memory, [{
      sha: baselineSha,
      shortSha: baselineSha.slice(0, 12),
      title: "initial provider baseline",
    }]);
    writePrResource(memory, [
      { number: 41, title: "older PR outside current window", state: "MERGED" },
      { number: 42, title: "existing PR", state: "MERGED" },
    ]);
    writeIssueResource(memory, [
      { number: 6, title: "older issue outside current window", state: "CLOSED" },
      { number: 7, title: "existing issue", state: "CLOSED" },
    ]);
    writeJson(join(memory, "raw", "git-commits.json"), [{ sourceType: "commit", sha: baselineSha }]);

    const result = spawnSync("python3", [detectScript, "--repo-path", repo, "--pretty"], {
      cwd: packageRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        BASELINE_SHA: baselineSha,
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);

    assert.equal(report.current.provider.name, "github");
    assert.equal(report.current.provider.evidence_state, "ready");
    assert.equal(report.current.provider_fetch.attempted, true);
    assert.equal(report.current.provider_fetch.ok, true);
    assert.deepEqual(report.deltas.pull_requests.added_numbers, [43]);
    assert.deepEqual(report.deltas.pull_requests.updated_numbers, [42]);
    assert.deepEqual(report.deltas.pull_requests.upsert_numbers, [42, 43]);
    const newPr = report.current.provider_items.pull_requests.find((pr) => pr.number === 43);
    assert.equal(newPr.summary, "new");
    assert.equal(newPr.changed_files, 1);
    assert.deepEqual(newPr.commit_headlines, ["baseline"]);
    assert.equal(newPr.raw_lookup, "facetId=pr.43");
    assert.equal("facetId" in newPr, false);
    assert.equal("updatedAt" in newPr, false);
    assert.equal("sourceType" in newPr, false);
    assert.deepEqual(report.deltas.pull_requests.baseline_only_numbers, [41]);
    assert.deepEqual(report.deltas.pull_requests.delete_numbers, []);
    assert.deepEqual(report.deltas.issues.added_numbers, [8]);
    assert.deepEqual(report.deltas.issues.updated_numbers, [7]);
    assert.deepEqual(report.deltas.issues.upsert_numbers, [7, 8]);
    const newIssue = report.current.provider_items.issues.find((issue) => issue.number === 8);
    assert.equal(newIssue.summary, "new");
    assert.deepEqual(newIssue.evidence, ["issue #8: new issue"]);
    assert.equal(newIssue.raw_lookup, "facetId=issue.8");
    assert.equal("facetId" in newIssue, false);
    assert.equal("updatedAt" in newIssue, false);
    assert.equal("sourceType" in newIssue, false);
    assert.deepEqual(report.deltas.issues.baseline_only_numbers, [6]);
    assert.deepEqual(report.deltas.issues.delete_numbers, []);
    assert.match(report.actions.join("\n"), /resources\/prs\.md/);
    assert.match(report.actions.join("\n"), /resources\/issues\.md/);
    assert.match(report.actions.join("\n"), /Preserve baseline-only/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repo-memory-updater prefers profile repo identity over an earlier fork remote", () => {
  const root = mkdtempSync(join(tmpdir(), "memorax-code-repo-memory-profile-provider."));
  try {
    const repo = join(root, "repo");
    const memory = join(repo, ".repo_memory");
    const bin = join(root, "bin");
    const gh = join(bin, "gh");
    mkdirSync(repo);
    mkdirSync(bin);
    mkdirSync(join(memory, "raw"), { recursive: true });
    mkdirSync(join(memory, "resources"), { recursive: true });
    writeFileSync(
      gh,
      `#!/bin/sh
set -eu
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  exit 0
fi
printf 'unexpected gh args: %s\n' "$*" >&2
exit 2
`,
    );
    chmodSync(gh, 0o755);

    runGit(repo, ["init", "-b", "main"]);
    writeFileSync(join(repo, "README.md"), "# Repo\n");
    runGit(repo, ["add", "README.md"]);
    runGit(repo, ["commit", "-m", "initial provider profile baseline"]);
    const baselineSha = runGit(repo, ["rev-parse", "HEAD"]);
    runGit(repo, ["remote", "add", "fork", "git@github.com:me/repo.git"]);
    runGit(repo, ["remote", "add", "origin", "git@github.com:owner/repo.git"]);

    writeProfile(
      memory,
      baselineSha,
      'repo_full_name: "owner/repo"\ncode_host_provider: "github"\nrepo_url: "https://github.com/owner/repo.git"',
    );
    writeCommitResource(memory, [{
      sha: baselineSha,
      shortSha: baselineSha.slice(0, 12),
      title: "initial provider profile baseline",
    }]);
    writePrResource(memory, []);
    writeIssueResource(memory, []);
    writeJson(join(memory, "raw", "git-commits.json"), [{ sourceType: "commit", sha: baselineSha }]);

    const result = spawnSync("python3", [detectScript, "--repo-path", repo, "--provider-mode", "off", "--pretty"], {
      cwd: packageRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);

    assert.equal(report.current.provider.name, "github");
    assert.equal(report.current.provider.repo, "owner/repo");
    assert.equal(report.current.provider.selection_reason, "profile_frontmatter");
    assert.equal(report.current.provider.remote_name, "");
    assert.equal(report.current.provider_fetch.attempted, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repo-memory-updater passes GitLab profile host to provider helper", () => {
  const root = mkdtempSync(join(tmpdir(), "memorax-code-repo-memory-profile-gitlab-host."));
  try {
    const repo = join(root, "repo");
    const memory = join(repo, ".repo_memory");
    const bin = join(root, "bin");
    const glab = join(bin, "glab");
    mkdirSync(repo);
    mkdirSync(bin);
    mkdirSync(join(memory, "raw"), { recursive: true });
    mkdirSync(join(memory, "resources"), { recursive: true });
    writeFileSync(
      glab,
      `#!/bin/sh
set -eu
if [ "$1" = "auth" ] && [ "$2" = "status" ] && [ "\${3:-}" = "--hostname" ] && [ "\${4:-}" = "gitlab.example.test" ]; then
  exit 0
fi
if [ "$1" = "api" ] && [ "\${2:-}" = "--hostname" ] && [ "\${3:-}" = "gitlab.example.test" ]; then
  case "$4" in
    'projects/group%2Fproject/merge_requests?state=all&per_page=30&order_by=updated_at&sort=desc&page=1')
      printf '%s\\n' '[]'
      exit 0
      ;;
    'projects/group%2Fproject/issues?state=all&per_page=30&order_by=updated_at&sort=desc')
      printf '%s\\n' '[{"iid":9,"title":"Hosted issue","description":"Self-hosted GitLab issue evidence.","state":"opened","web_url":"https://gitlab.example.test/group/project/-/issues/9","updated_at":"2026-07-01T00:00:00Z","labels":["repo-memory"]}]'
      exit 0
      ;;
  esac
fi
printf 'unexpected glab args: %s\\n' "$*" >&2
exit 2
`,
    );
    chmodSync(glab, 0o755);

    runGit(repo, ["init", "-b", "main"]);
    writeFileSync(join(repo, "README.md"), "# Repo\n");
    runGit(repo, ["add", "README.md"]);
    runGit(repo, ["commit", "-m", "initial gitlab provider baseline"]);
    const baselineSha = runGit(repo, ["rev-parse", "HEAD"]);
    runGit(repo, ["remote", "add", "origin", "git@gitlab.example.test:wrong/repo.git"]);

    writeProfile(
      memory,
      baselineSha,
      'repo_full_name: "group/project"\ncode_host_provider: "gitlab"\nrepo_url: "https://gitlab.example.test/group/project.git"',
    );
    writeCommitResource(memory, [{
      sha: baselineSha,
      shortSha: baselineSha.slice(0, 12),
      title: "initial gitlab provider baseline",
    }]);
    writePrResource(memory, []);
    writeIssueResource(memory, []);
    writeJson(join(memory, "raw", "git-commits.json"), [{ sourceType: "commit", sha: baselineSha }]);

    const result = spawnSync("python3", [detectScript, "--repo-path", repo, "--pretty"], {
      cwd: packageRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);

    assert.equal(report.current.provider.name, "gitlab");
    assert.equal(report.current.provider.repo, "group/project");
    assert.equal(report.current.provider.host, "gitlab.example.test");
    assert.equal(report.current.provider.selection_reason, "profile_frontmatter");
    assert.equal(report.current.provider_fetch.ok, true);
    assert.deepEqual(report.deltas.issues.added_numbers, [9]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repo-memory-updater preserves baseline-only numbers when provider fetch returns empty", () => {
  const root = mkdtempSync(join(tmpdir(), "memorax-code-repo-memory-provider-empty."));
  try {
    const repo = join(root, "repo");
    const memory = join(repo, ".repo_memory");
    const bin = join(root, "bin");
    const gh = join(bin, "gh");
    mkdirSync(repo);
    mkdirSync(bin);
    mkdirSync(join(memory, "raw"), { recursive: true });
    mkdirSync(join(memory, "resources"), { recursive: true });
    createEmptyProviderGh(gh);

    runGit(repo, ["init", "-b", "main"]);
    writeFileSync(join(repo, "README.md"), "# Repo\n");
    runGit(repo, ["add", "README.md"]);
    runGit(repo, ["commit", "-m", "initial provider baseline"]);
    const baselineSha = runGit(repo, ["rev-parse", "HEAD"]);
    runGit(repo, ["remote", "add", "origin", "git@github.com:owner/repo.git"]);

    writeProfile(memory, baselineSha);
    writeCommitResource(memory, [{
      sha: baselineSha,
      shortSha: baselineSha.slice(0, 12),
      title: "initial provider baseline",
    }]);
    writePrResource(memory, [{ number: 42, title: "existing PR", state: "MERGED" }]);
    writeIssueResource(memory, [{ number: 7, title: "existing issue", state: "CLOSED" }]);
    writeJson(join(memory, "raw", "git-commits.json"), [{ sourceType: "commit", sha: baselineSha }]);

    const result = spawnSync("python3", [detectScript, "--repo-path", repo, "--pretty"], {
      cwd: packageRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);

    assert.equal(report.current.provider_fetch.ok, true);
    assert.deepEqual(report.deltas.pull_requests.current_numbers, []);
    assert.deepEqual(report.deltas.pull_requests.baseline_only_numbers, [42]);
    assert.deepEqual(report.deltas.issues.current_numbers, []);
    assert.deepEqual(report.deltas.issues.baseline_only_numbers, [7]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repo-memory-updater reports rewritten history instead of silently skipping commit deltas", () => {
  const root = mkdtempSync(join(tmpdir(), "memorax-code-repo-memory-rewritten-history."));
  try {
    const repo = join(root, "repo");
    const memory = join(repo, ".repo_memory");
    mkdirSync(repo);
    runGit(repo, ["init", "-b", "main"]);
    writeFileSync(join(repo, "README.md"), "# Baseline\n");
    runGit(repo, ["add", "README.md"]);
    runGit(repo, ["commit", "-m", "baseline commit"]);
    const baselineSha = runGit(repo, ["rev-parse", "HEAD"]);

    runGit(repo, ["checkout", "--orphan", "rewritten"]);
    writeFileSync(join(repo, "README.md"), "# Rewritten\n");
    writeFileSync(join(repo, "rewritten.txt"), "new history\n");
    runGit(repo, ["add", "README.md", "rewritten.txt"]);
    runGit(repo, ["commit", "-m", "rewritten history commit"]);

    mkdirSync(join(memory, "resources"), { recursive: true });
    mkdirSync(join(memory, "raw"), { recursive: true });
    writeProfile(memory, baselineSha);
    writeCommitResource(memory, [{
      sha: baselineSha,
      shortSha: baselineSha.slice(0, 12),
      title: "baseline commit",
    }]);
    writePrResource(memory, []);
    writeIssueResource(memory, []);
    writeJson(join(memory, "raw", "git-commits.json"), [{ sourceType: "commit", sha: baselineSha }]);

    const result = spawnSync("python3", [detectScript, "--repo-path", repo, "--provider-mode", "off", "--pretty"], {
      cwd: packageRoot,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);

    assert.equal(report.deltas.commit_delta_skipped, "baseline_not_ancestor_of_head");
    assert.equal(report.deltas.local_commit_status.status, "skipped");
    assert.equal(report.deltas.local_commit_status.reason, "baseline_not_ancestor_of_head");
    assert.equal(report.notices.length, 1);
    assert.equal(report.notices[0].level, "warning");
    assert.equal(report.notices[0].title, "Repo Memory Baseline Rewritten");
    assert.equal(report.notices[0].render_as, "assistant_message");
    assert.match(report.notices[0].message, /not an ancestor of the current HEAD/);
    assert.match(report.actions.join("\n"), /full rebuild/i);
    assert.match(report.actions.join("\n"), /\$memorax-code repo-build/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repo-memory-updater surfaces provider fetch failures as keep-existing actions", () => {
  const root = mkdtempSync(join(tmpdir(), "memorax-code-repo-memory-provider-failure."));
  try {
    const repo = join(root, "repo");
    const memory = join(repo, ".repo_memory");
    const bin = join(root, "bin");
    const gh = join(bin, "gh");
    mkdirSync(repo);
    mkdirSync(bin);
    writeFileSync(
      gh,
      `#!/bin/sh
set -eu
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  exit 0
fi
printf '%s\\n' 'simulated provider outage' >&2
exit 2
`,
    );
    chmodSync(gh, 0o755);

    runGit(repo, ["init", "-b", "main"]);
    writeFileSync(join(repo, "README.md"), "# Repo\n");
    runGit(repo, ["add", "README.md"]);
    runGit(repo, ["commit", "-m", "initial provider failure baseline"]);
    const baselineSha = runGit(repo, ["rev-parse", "HEAD"]);

    mkdirSync(join(memory, "resources"), { recursive: true });
    mkdirSync(join(memory, "raw"), { recursive: true });
    runGit(repo, ["remote", "add", "origin", "git@github.com:owner/repo.git"]);
    writeProfile(memory, baselineSha);
    writeCommitResource(memory, [{
      sha: baselineSha,
      shortSha: baselineSha.slice(0, 12),
      title: "initial provider failure baseline",
    }]);
    writePrResource(memory, [{ number: 1, title: "existing PR", state: "MERGED" }]);
    writeIssueResource(memory, [{ number: 2, title: "existing issue", state: "CLOSED" }]);
    writeJson(join(memory, "raw", "git-commits.json"), [{ sourceType: "commit", sha: baselineSha }]);

    const result = spawnSync("python3", [detectScript, "--repo-path", repo, "--pretty"], {
      cwd: packageRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);

    assert.equal(report.current.provider_fetch.attempted, true);
    assert.equal(report.current.provider_fetch.ok, false);
    assert.equal(report.notices.length, 1);
    assert.equal(report.notices[0].level, "warning");
    assert.equal(report.notices[0].title, "Provider Delta Fetch Failed");
    assert.equal(report.notices[0].render_as, "assistant_message");
    assert.match(report.notices[0].message, /keeping existing PR\/issue resources unchanged/);
    assert.deepEqual(report.deltas.pull_requests.added_numbers, []);
    assert.deepEqual(report.deltas.issues.added_numbers, []);
    assert.match(report.actions.join("\n"), /Provider delta fetch failed/);
    assert.match(report.actions.join("\n"), /keeping existing PR\/issue resources unchanged/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repo-memory-updater uses raw provider facets to detect metadata-only updates", () => {
  const root = mkdtempSync(join(tmpdir(), "memorax-code-repo-memory-provider-raw-delta."));
  try {
    const repo = join(root, "repo");
    const memory = join(repo, ".repo_memory");
    const bin = join(root, "bin");
    const gh = join(bin, "gh");
    mkdirSync(repo);
    mkdirSync(bin);
    mkdirSync(join(memory, "raw"), { recursive: true });
    mkdirSync(join(memory, "resources"), { recursive: true });
    createSameTitleUpdatedGh(gh);

    runGit(repo, ["init", "-b", "main"]);
    writeFileSync(join(repo, "README.md"), "# Repo\n");
    runGit(repo, ["add", "README.md"]);
    runGit(repo, ["commit", "-m", "initial provider raw baseline"]);
    const baselineSha = runGit(repo, ["rev-parse", "HEAD"]);
    runGit(repo, ["remote", "add", "origin", "git@github.com:owner/repo.git"]);

    writeProfile(memory, baselineSha);
    writeCommitResource(memory, [{
      sha: baselineSha,
      shortSha: baselineSha.slice(0, 12),
      title: "initial provider raw baseline",
    }]);
    writePrResource(memory, [{ number: 42, title: "same PR title", state: "MERGED", head: "pr-42" }]);
    writeIssueResource(memory, []);
    writeJson(join(memory, "raw", "git-commits.json"), [{ sourceType: "commit", sha: baselineSha }]);
    writeJson(join(memory, "raw", "github-facets.json"), [{
      facetId: "pr.42",
      sourceType: "pr",
      prs: [42],
      title: "same PR title",
      state: "MERGED",
      updatedAt: "2026-07-01T00:00:00Z",
      url: "https://example.test/pull/42",
      base_ref: "main",
      head_ref: "pr-42",
      summary: "old provider body",
    }]);

    const result = spawnSync("python3", [detectScript, "--repo-path", repo, "--pretty"], {
      cwd: packageRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        BASELINE_SHA: baselineSha,
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);

    assert.deepEqual(report.deltas.pull_requests.updated_numbers, [42]);
    const updatedPr = report.current.provider_items.pull_requests.find((pr) => pr.number === 42);
    assert.equal(updatedPr.summary, "updated provider body");
    assert.deepEqual(updatedPr.files, ["src/provider.ts"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repo-memory-updater compares provider deltas against raw facets before edited resource text", () => {
  const root = mkdtempSync(join(tmpdir(), "memorax-code-repo-memory-provider-raw-priority."));
  try {
    const repo = join(root, "repo");
    const memory = join(repo, ".repo_memory");
    const bin = join(root, "bin");
    const gh = join(bin, "gh");
    mkdirSync(repo);
    mkdirSync(bin);
    mkdirSync(join(memory, "raw"), { recursive: true });
    mkdirSync(join(memory, "resources"), { recursive: true });
    createSameTitleUpdatedGh(gh);

    runGit(repo, ["init", "-b", "main"]);
    writeFileSync(join(repo, "README.md"), "# Repo\n");
    runGit(repo, ["add", "README.md"]);
    runGit(repo, ["commit", "-m", "initial provider raw priority baseline"]);
    const baselineSha = runGit(repo, ["rev-parse", "HEAD"]);
    runGit(repo, ["remote", "add", "origin", "git@github.com:owner/repo.git"]);

    writeProfile(memory, baselineSha);
    writeCommitResource(memory, [{
      sha: baselineSha,
      shortSha: baselineSha.slice(0, 12),
      title: "initial provider raw priority baseline",
    }]);
    writePrResource(memory, [{ number: 42, title: "human edited resource title", state: "MERGED", head: "pr-42" }]);
    writeIssueResource(memory, []);
    writeJson(join(memory, "raw", "git-commits.json"), [{ sourceType: "commit", sha: baselineSha }]);
    writeJson(join(memory, "raw", "github-facets.json"), [{
      facetId: "pr.42",
      sourceType: "pr",
      prs: [42],
      title: "same PR title",
      state: "MERGED",
      updatedAt: "2026-07-04T00:00:00Z",
      url: "https://example.test/pull/42",
      base_ref: "main",
      head_ref: "pr-42",
      summary: "updated provider body",
      files: ["src/provider.ts"],
      changed_files: 1,
      additions: 2,
      deletions: 1,
      commit_headlines: ["metadata-only update"],
    }]);

    const result = spawnSync("python3", [detectScript, "--repo-path", repo, "--pretty"], {
      cwd: packageRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        BASELINE_SHA: baselineSha,
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);

    assert.deepEqual(report.deltas.pull_requests.updated_numbers, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repo-memory-updater reports a missing local commit baseline as an assistant warning", () => {
  const root = mkdtempSync(join(tmpdir(), "memorax-code-repo-memory-missing-baseline."));
  try {
    const repo = join(root, "repo");
    const memory = join(repo, ".repo_memory");
    mkdirSync(repo);
    runGit(repo, ["init", "-b", "main"]);
    writeFileSync(join(repo, "README.md"), "# Repo\n");
    runGit(repo, ["add", "README.md"]);
    runGit(repo, ["commit", "-m", "initial commit without memory baseline"]);

    mkdirSync(join(memory, "resources"), { recursive: true });
    mkdirSync(join(memory, "raw"), { recursive: true });
    writeProfile(memory, "");
    writeCommitResource(memory, []);
    writePrResource(memory, []);
    writeIssueResource(memory, []);
    writeJson(join(memory, "raw", "git-commits.json"), []);

    const result = spawnSync("python3", [detectScript, "--repo-path", repo, "--provider-mode", "off", "--pretty"], {
      cwd: packageRoot,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);

    assert.equal(report.deltas.commit_delta_skipped, "missing_baseline_commit");
    assert.equal(report.notices[0].title, "Repo Memory Commit Baseline Missing");
    assert.equal(report.notices[0].render_as, "assistant_message");
    assert.match(report.actions.join("\n"), /full rebuild/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repo-memory-updater falls back to the nearest stored commit when PROFILE local_head is absent", () => {
  const root = mkdtempSync(join(tmpdir(), "memorax-code-repo-memory-nearest-baseline."));
  try {
    const repo = join(root, "repo");
    const memory = join(repo, ".repo_memory");
    mkdirSync(repo);
    runGit(repo, ["init", "-b", "main"]);
    writeFileSync(join(repo, "README.md"), "# One\n");
    runGit(repo, ["add", "README.md"]);
    runGit(repo, ["commit", "-m", "older stored baseline"]);
    const olderSha = runGit(repo, ["rev-parse", "HEAD"]);
    writeFileSync(join(repo, "README.md"), "# Two\n");
    runGit(repo, ["add", "README.md"]);
    runGit(repo, ["commit", "-m", "newer stored baseline"]);
    const newerSha = runGit(repo, ["rev-parse", "HEAD"]);
    writeFileSync(join(repo, "feature.txt"), "new delta\n");
    runGit(repo, ["add", "feature.txt"]);
    runGit(repo, ["commit", "-m", "latest delta after memory"]);
    const latestSha = runGit(repo, ["rev-parse", "HEAD"]);

    mkdirSync(join(memory, "resources"), { recursive: true });
    mkdirSync(join(memory, "raw"), { recursive: true });
    writeProfile(memory, "");
    writeCommitResource(memory, [
      { sha: olderSha, shortSha: olderSha.slice(0, 12), title: "older stored baseline" },
      { sha: newerSha, shortSha: newerSha.slice(0, 12), title: "newer stored baseline" },
    ]);
    writePrResource(memory, []);
    writeIssueResource(memory, []);
    writeJson(join(memory, "raw", "git-commits.json"), [{ sourceType: "commit", sha: olderSha }, { sourceType: "commit", sha: newerSha }]);

    const result = spawnSync("python3", [detectScript, "--repo-path", repo, "--provider-mode", "off", "--pretty"], {
      cwd: packageRoot,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);

    assert.equal(report.baseline.local_commit_sha, newerSha);
    assert.deepEqual(report.deltas.local_commits.map((commit) => commit.sha), [latestSha]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repo-memory-updater preserves gh auth check diagnostics from provider helper", () => {
  const root = mkdtempSync(join(tmpdir(), "memorax-code-repo-memory-provider-auth-flake."));
  try {
    const repo = join(root, "repo");
    const memory = join(repo, ".repo_memory");
    const bin = join(root, "bin");
    const gh = join(bin, "gh");
    const authCounter = join(root, "gh-auth-count");
    mkdirSync(repo);
    mkdirSync(bin);
    writeFileSync(
      gh,
      `#!/bin/sh
set -eu
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  count=0
  if [ -f "$GH_AUTH_COUNTER" ]; then
    count=$(cat "$GH_AUTH_COUNTER")
  fi
  count=$((count + 1))
  printf '%s\\n' "$count" > "$GH_AUTH_COUNTER"
  if [ "$count" = "1" ]; then
    exit 0
  fi
  printf '%s\\n' 'keyring temporarily unavailable while reading gh credentials' >&2
  exit 1
fi
printf '%s\\n' 'unexpected provider call after failed auth check' >&2
exit 2
`,
    );
    chmodSync(gh, 0o755);

    runGit(repo, ["init", "-b", "main"]);
    writeFileSync(join(repo, "README.md"), "# Repo\n");
    runGit(repo, ["add", "README.md"]);
    runGit(repo, ["commit", "-m", "initial provider auth baseline"]);
    const baselineSha = runGit(repo, ["rev-parse", "HEAD"]);

    mkdirSync(join(memory, "resources"), { recursive: true });
    mkdirSync(join(memory, "raw"), { recursive: true });
    runGit(repo, ["remote", "add", "origin", "git@github.com:owner/repo.git"]);
    writeProfile(memory, baselineSha);
    writeCommitResource(memory, [{
      sha: baselineSha,
      shortSha: baselineSha.slice(0, 12),
      title: "initial provider auth baseline",
    }]);
    writePrResource(memory, [{ number: 1, title: "existing PR", state: "MERGED" }]);
    writeIssueResource(memory, [{ number: 2, title: "existing issue", state: "CLOSED" }]);
    writeJson(join(memory, "raw", "git-commits.json"), [{ sourceType: "commit", sha: baselineSha }]);

    const result = spawnSync("python3", [detectScript, "--repo-path", repo, "--pretty"], {
      cwd: packageRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        GH_AUTH_COUNTER: authCounter,
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);

    assert.equal(report.current.provider.evidence_state, "ready");
    assert.equal(report.current.provider_fetch.attempted, true);
    assert.equal(report.current.provider_fetch.ok, false);
    assert.match(report.current.provider_fetch.stderr, /gh auth check failed/i);
    assert.match(report.current.provider_fetch.stderr, /keyring temporarily unavailable/);
    assert.doesNotMatch(report.current.provider_fetch.stderr, /^GitHub CLI is not authenticated\. Run: gh auth login$/);
    assert.match(report.notices[0].message, /Provider delta fetch failed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
