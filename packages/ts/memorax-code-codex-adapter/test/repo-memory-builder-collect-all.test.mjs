import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const builderSkillRoot = join(packageRoot, "skills", "memorax-code");
const collectAllScript = join(builderSkillRoot, "scripts", "collect_all.py");
const defaultsPath = join(builderSkillRoot, "defaults.json");
const githubFacetsScript = join(builderSkillRoot, "scripts", "github_resource_facets.py");
const gitlabFacetsScript = join(builderSkillRoot, "scripts", "gitlab_resource_facets.py");
const prepareScript = join(packageRoot, "skills", "memorax-code", "scripts", "prepare_repo_memory.py");
const userProfileScript = join(packageRoot, "skills", "memorax-code", "scripts", "user_profile_memory.py");

function runGit(cwd, args) {
  const result = spawnSync(
    "git",
    ["-c", "user.name=Repo Memory Test", "-c", "user.email=repo-memory-test@example.invalid", ...args],
    { cwd, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function createFakeProviderCli(path, command) {
  writeFileSync(
    path,
    `#!/bin/sh
set -eu
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  printf '%s\\n' 'not logged in' >&2
  exit 1
fi
printf 'unexpected ${command} args: %s\\n' "$*" >&2
exit 2
`,
  );
  chmodSync(path, 0o755);
}

function createFakeAuthenticatedGithubCli(path) {
  writeFileSync(
    path,
    `#!/bin/sh
set -eu
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  printf '%s\\n' 'github.com logged in'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  printf '%s\\n' "GraphQL: Could not resolve to a Repository with the name 'owner/project'. (repository)" >&2
  exit 1
fi
printf 'unexpected gh args: %s\\n' "$*" >&2
exit 2
`,
  );
  chmodSync(path, 0o755);
}

function createFakeSuccessfulGithubCli(path) {
  writeFileSync(
    path,
    `#!/bin/sh
set -eu
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  printf '%s\\n' 'github.com logged in'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  printf '%s\\n' '[{"number":1}]'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  printf '%s\\n' '{"number":1,"title":"Memory CLI","body":"Updates memory commands","state":"MERGED","url":"https://example.test/pull/1","updatedAt":"2026-07-03T00:00:00Z","createdAt":"2026-07-03T00:00:00Z","closedAt":"2026-07-03T00:00:00Z","mergedAt":"2026-07-03T00:00:00Z","author":{"login":"tester"},"comments":[],"reviews":[],"latestReviews":[],"reviewDecision":"","files":[{"path":"packages/ts/memorax-code-backend/src/memory-cli.ts"}],"commits":[{"messageHeadline":"update memory cli","oid":"'"$LATEST_SHA"'"}],"closingIssuesReferences":[{"number":7}],"mergeCommit":{"oid":"'"$LATEST_SHA"'"},"baseRefName":"main","headRefName":"memory","headRepository":{"nameWithOwner":"owner/project"},"isDraft":false,"additions":4,"deletions":1,"changedFiles":1}'
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "list" ]; then
  printf '%s\\n' '[{"number":7}]'
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "view" ]; then
  printf '%s\\n' '{"number":7,"title":"Track memory CLI","body":"Issue body","state":"CLOSED","url":"https://example.test/issues/7","updatedAt":"2026-07-03T00:00:00Z","labels":[{"name":"memory"}],"comments":[]}'
  exit 0
fi
printf 'unexpected gh args: %s\\n' "$*" >&2
exit 2
`,
  );
  chmodSync(path, 0o755);
}


function createFakeGithubCliWithNonlocalPrAndIssue(path) {
  writeFileSync(
    path,
    `#!/bin/sh
set -eu
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  printf '%s\n' 'github.com logged in'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  printf '%s\n' '[{"number":2},{"number":1}]'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ] && [ "$3" = "2" ]; then
  printf '%s\n' '{"number":2,"title":"Nonlocal merge","body":"Missing locally","state":"MERGED","url":"https://example.test/pull/2","updatedAt":"2026-07-04T00:00:00Z","createdAt":"2026-07-04T00:00:00Z","closedAt":"2026-07-04T00:00:00Z","mergedAt":"2026-07-04T00:00:00Z","author":{"login":"tester"},"comments":[],"reviews":[],"latestReviews":[],"reviewDecision":"","files":[{"path":"src/missing.ts"}],"commits":[{"messageHeadline":"missing merge","oid":"f82897ff49f9a3902ecf9da60eec6c24a15abec2"}],"closingIssuesReferences":[],"mergeCommit":{"oid":"f82897ff49f9a3902ecf9da60eec6c24a15abec2"},"baseRefName":"main","headRefName":"missing","headRepository":{"nameWithOwner":"owner/project"},"isDraft":false,"additions":2,"deletions":0,"changedFiles":1}'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ] && [ "$3" = "1" ]; then
  printf '%s\n' '{"number":1,"title":"Local merge","body":"Present locally","state":"MERGED","url":"https://example.test/pull/1","updatedAt":"2026-07-03T00:00:00Z","createdAt":"2026-07-03T00:00:00Z","closedAt":"2026-07-03T00:00:00Z","mergedAt":"2026-07-03T00:00:00Z","author":{"login":"tester"},"comments":[],"reviews":[],"latestReviews":[],"reviewDecision":"","files":[{"path":"src/app.ts"}],"commits":[{"messageHeadline":"local merge","oid":"'"$LATEST_SHA"'"}],"closingIssuesReferences":[],"mergeCommit":{"oid":"'"$LATEST_SHA"'"},"baseRefName":"main","headRefName":"local","headRepository":{"nameWithOwner":"owner/project"},"isDraft":false,"additions":1,"deletions":0,"changedFiles":1}'
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "list" ]; then
  printf '%s\n' '[{"number":7}]'
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "view" ]; then
  printf '%s\n' '{"number":7,"title":"Provider issue survives PR filtering","body":"Issue body","state":"OPEN","url":"https://example.test/issues/7","updatedAt":"2026-07-03T00:00:00Z","labels":[],"comments":[]}'
  exit 0
fi
printf 'unexpected gh args: %s\n' "$*" >&2
exit 2
`,
  );
  chmodSync(path, 0o755);
}

function createRepoFixture(root) {
  const repo = join(root, "repo");
  const bin = join(root, "bin");
  mkdirSync(repo);
  mkdirSync(bin);
  createFakeProviderCli(join(bin, "gh"), "gh");
  createFakeProviderCli(join(bin, "glab"), "glab");

  runGit(repo, ["init", "-b", "main"]);
  writeFileSync(join(repo, "README.md"), "# Test repo\n");
  runGit(repo, ["add", "README.md"]);
  runGit(repo, ["commit", "-m", "initial docs"]);
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "app.ts"), "export const answer = 42;\n");
  runGit(repo, ["add", "src/app.ts"]);
  runGit(repo, ["commit", "-m", "add app module", "-m", "Introduces the app entrypoint."]);
  runGit(repo, ["remote", "add", "origin", "git@github.com:owner/project.git"]);

  return { repo, bin };
}

function runCollectAll(repo, bin, extraArgs = []) {
  return spawnSync(
    "python3",
    [
      collectAllScript,
      "--repo-path",
      repo,
      "--commit-limit",
      "2",
      "--pr-limit",
      "2",
      "--issue-limit",
      "2",
      "--summary-chars",
      "4000",
      "--pretty",
      ...extraArgs,
    ],
    {
      cwd: packageRoot,
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
    },
  );
}

test("collect-all builds local commit memory and skips unauthenticated provider facets", () => {
  const root = mkdtempSync(join(tmpdir(), "memorax-code-repo-memory-collect."));
  try {
    const { repo, bin } = createRepoFixture(root);

    const result = runCollectAll(repo, bin);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stderr, "");

    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.repo_path, realpathSync(repo));
    assert.equal(report.memory_path, join(realpathSync(repo), ".repo_memory"));
    assert.equal(report.provider.name, "github");
    assert.equal(report.provider.evidence_state, "auth_required");
    assert.equal(report.provider.notice_level, "warning");
    assert.match(report.provider.notice_markdown, /\*\*Provider Evidence Unavailable\*\*/);
    assert.match(report.provider.notice_markdown, /```bash\ngh auth login\n```/);
    assert.equal(report.notices.length, 1);
    assert.equal(report.notices[0].level, "warning");
    assert.equal(report.notices[0].title, "Provider Evidence Unavailable");
    assert.match(report.notices[0].message, /GitHub provider evidence is unavailable/);
    assert.doesNotMatch(report.notices[0].message, /`/);
    assert.equal(report.notices[0].command, "gh auth login");
    assert.equal(report.notices[0].render_as, "assistant_message");
    assert.equal("markdown" in report.notices[0], false);
    assert.deepEqual(report.notices[0].next_steps, ["Run: gh auth login", "Rerun $memorax-code repo-build to collect GitHub PR/issue evidence."]);
    assert.equal(report.steps.prepare.ok, true);
    assert.equal(report.steps.git_commits.ok, true);
    assert.equal(report.steps.provider_facets.skipped, true);
    assert.equal("indexes" in report.steps, false);
    assert.deepEqual(report.counts.raw.git_commits, { commit: 2 });
    assert.equal("indexes" in report.counts, false);
    assert.match(report.next_step, /Inspect raw evidence, then author PROFILE\.md and resources\/\*\.md/);
    assert.equal("commit_index" in report.outputs, false);
    assert.equal("prs_index" in report.outputs, false);
    assert.equal("issues_index" in report.outputs, false);

    assert.equal(existsSync(join(repo, ".repo_memory", "raw", "prepare-report.json")), true);
    assert.equal(existsSync(join(repo, ".repo_memory", "raw", "git-commits.json")), true);
    assert.equal(existsSync(join(repo, ".repo_memory", "indexes")), false);
    assert.equal(existsSync(join(repo, ".repo_memory", "raw", "github-facets.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("collect-all falls back to local memory when ready provider facets fail", () => {
  const root = mkdtempSync(join(tmpdir(), "memorax-code-repo-memory-provider-fallback."));
  try {
    const { repo, bin } = createRepoFixture(root);
    createFakeAuthenticatedGithubCli(join(bin, "gh"));

    const result = runCollectAll(repo, bin);
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.provider.evidence_state, "ready");
    assert.equal(report.steps.prepare.ok, true);
    assert.equal(report.steps.git_commits.ok, true);
    assert.equal(report.steps.provider_facets.ok, false);
    assert.equal(report.steps.provider_facets.skipped, false);
    assert.equal(report.steps.provider_facets.degraded_to_local_only, true);
    assert.match(report.steps.provider_facets.stderr, /Could not resolve to a Repository/);
    assert.equal("indexes" in report.steps, false);
    assert.deepEqual(report.counts.raw.git_commits, { commit: 2 });
    assert.equal("indexes" in report.counts, false);
    assert.equal(existsSync(join(repo, ".repo_memory", "indexes")), false);
    assert.equal(existsSync(join(repo, ".repo_memory", "raw", "github-facets.json")), false);
    assert.equal("provider_facets" in report.outputs, false);
    assert.equal("commit_index" in report.outputs, false);
    assert.equal("prs_index" in report.outputs, false);
    assert.equal("issues_index" in report.outputs, false);
    assert.ok(report.notices.some((notice) => (
      notice.level === "warning" &&
      notice.title === "Provider Evidence Unavailable" &&
      /Could not resolve to a Repository/.test(notice.message)
    )));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("collect-all keeps provider facets raw without persistent index outputs", () => {
  const root = mkdtempSync(join(tmpdir(), "memorax-code-repo-memory-provider-success."));
  try {
    const { repo, bin } = createRepoFixture(root);
    createFakeSuccessfulGithubCli(join(bin, "gh"));
    const latestSha = runGit(repo, ["rev-parse", "HEAD"]);

    const result = spawnSync(
      "python3",
      [
        collectAllScript,
        "--repo-path",
        repo,
        "--commit-limit",
        "2",
        "--pr-limit",
        "1",
        "--issue-limit",
        "1",
        "--pretty",
      ],
      {
        cwd: packageRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          LATEST_SHA: latestSha,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.provider.evidence_state, "ready");
    assert.equal(report.steps.provider_facets.ok, true);
    assert.equal(report.outputs.provider_facets, join(realpathSync(repo), ".repo_memory", "raw", "github-facets.json"));
    assert.deepEqual(report.counts.raw.provider_facets, { issue: 1, pr: 1 });
    assert.equal("indexes" in report.steps, false);
    assert.equal("indexes" in report.counts, false);
    assert.equal("commit_index" in report.outputs, false);
    assert.equal("prs_index" in report.outputs, false);
    assert.equal("issues_index" in report.outputs, false);

    const facets = JSON.parse(readFileSync(join(repo, ".repo_memory", "raw", "github-facets.json"), "utf8"));
    assert.deepEqual(
      facets.map((facet) => facet.facetId),
      ["pr.1", "issue.7"],
    );
    assert.equal(existsSync(join(repo, ".repo_memory", "indexes")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});



test("GitHub provider skips PRs with nonlocal merge commits without losing issues", () => {
  const root = mkdtempSync(join(tmpdir(), "memorax-code-repo-memory-provider-nonlocal-pr."));
  try {
    const { repo, bin } = createRepoFixture(root);
    createFakeGithubCliWithNonlocalPrAndIssue(join(bin, "gh"));
    const latestSha = runGit(repo, ["rev-parse", "HEAD"]);

    const result = spawnSync(
      "python3",
      [
        collectAllScript,
        "--repo-path",
        repo,
        "--commit-limit",
        "2",
        "--pr-limit",
        "1",
        "--issue-limit",
        "1",
        "--pretty",
      ],
      {
        cwd: packageRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          LATEST_SHA: latestSha,
        },
      },
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.steps.provider_facets.ok, true);
    assert.deepEqual(report.counts.raw.provider_facets, { issue: 1, pr: 1 });
    const facets = JSON.parse(readFileSync(join(repo, ".repo_memory", "raw", "github-facets.json"), "utf8"));
    assert.deepEqual(facets.map((facet) => facet.facetId), ["pr.1", "issue.7"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("collect-all can require provider evidence instead of falling back", () => {
  const root = mkdtempSync(join(tmpdir(), "memorax-code-repo-memory-provider-required."));
  try {
    const { repo, bin } = createRepoFixture(root);
    createFakeAuthenticatedGithubCli(join(bin, "gh"));

    const result = runCollectAll(repo, bin, ["--require-provider"]);
    assert.notEqual(result.status, 0);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, false);
    assert.equal(report.failed_step, "provider_facets");
    assert.equal(report.steps.git_commits.ok, true);
    assert.match(report.steps.provider_facets.stderr, /Could not resolve to a Repository/);
    assert.ok(report.notices.some((notice) => (
      notice.level === "warning" &&
      notice.title === "Provider Evidence Unavailable" &&
      /Could not resolve to a Repository/.test(notice.message)
    )));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("collect-all can skip provider evidence even when provider is ready", () => {
  const root = mkdtempSync(join(tmpdir(), "memorax-code-repo-memory-provider-skipped."));
  try {
    const { repo, bin } = createRepoFixture(root);
    createFakeAuthenticatedGithubCli(join(bin, "gh"));

    const result = runCollectAll(repo, bin, ["--skip-provider"]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.provider.evidence_state, "ready");
    assert.equal(report.steps.provider_facets.skipped, true);
    assert.equal(report.steps.provider_facets.reason, "provider_skipped_by_user");
    assert.equal("indexes" in report.counts, false);
    assert.equal("commit_index" in report.outputs, false);
    assert.equal("prs_index" in report.outputs, false);
    assert.equal("issues_index" in report.outputs, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});



test("collect-all supports history mode none without collecting commit or provider facets", () => {
  const root = mkdtempSync(join(tmpdir(), "memorax-code-repo-memory-history-none."));
  try {
    const { repo, bin } = createRepoFixture(root);
    createFakeAuthenticatedGithubCli(join(bin, "gh"));

    const result = runCollectAll(repo, bin, ["--history-mode", "none"]);
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.effective_settings.history.mode, "none");
    assert.deepEqual(report.effective_settings.history.collect, { commits: false, provider: false });
    assert.equal(report.steps.git_commits.skipped, true);
    assert.equal(report.steps.git_commits.reason, "history_disabled_by_policy");
    assert.equal(report.steps.provider_facets.skipped, true);
    assert.equal(report.steps.provider_facets.reason, "history_disabled_by_policy");
    assert.deepEqual(report.counts.raw.git_commits, {});
    assert.equal(existsSync(join(repo, ".repo_memory", "raw", "git-commits.json")), true);
    assert.deepEqual(JSON.parse(readFileSync(join(repo, ".repo_memory", "raw", "git-commits.json"), "utf8")), []);
    assert.equal(existsSync(join(repo, ".repo_memory", "raw", "github-facets.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("collect-all supports commits-only history mode without provider access", () => {
  const root = mkdtempSync(join(tmpdir(), "memorax-code-repo-memory-history-commits-only."));
  try {
    const { repo, bin } = createRepoFixture(root);
    createFakeAuthenticatedGithubCli(join(bin, "gh"));

    const result = runCollectAll(repo, bin, ["--history-mode", "commits-only"]);
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.effective_settings.history.mode, "commits-only");
    assert.deepEqual(report.effective_settings.history.collect, { commits: true, provider: false });
    assert.equal(report.steps.git_commits.ok, true);
    assert.deepEqual(report.counts.raw.git_commits, { commit: 2 });
    assert.equal(report.steps.provider_facets.skipped, true);
    assert.equal(report.steps.provider_facets.reason, "history_provider_disabled_by_policy");
    assert.equal(existsSync(join(repo, ".repo_memory", "raw", "github-facets.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("collect-all maps legacy provider flags to history modes", () => {
  const root = mkdtempSync(join(tmpdir(), "memorax-code-repo-memory-history-legacy-flags."));
  try {
    const { repo, bin } = createRepoFixture(root);
    createFakeAuthenticatedGithubCli(join(bin, "gh"));

    const skipped = runCollectAll(repo, bin, ["--skip-provider"]);
    assert.equal(skipped.status, 0, skipped.stderr || skipped.stdout);
    assert.equal(JSON.parse(skipped.stdout).effective_settings.history.mode, "local-only");

    const required = runCollectAll(repo, bin, ["--reuse", "--require-provider"]);
    assert.notEqual(required.status, 0);
    assert.equal(JSON.parse(required.stdout).effective_settings.history.mode, "provider-required");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("collect-all rejects contradictory history mode and provider flag combinations", () => {
  const root = mkdtempSync(join(tmpdir(), "memorax-code-repo-memory-history-conflict."));
  try {
    const { repo, bin } = createRepoFixture(root);

    const skippedNone = runCollectAll(repo, bin, ["--history-mode", "none", "--skip-provider"]);
    assert.notEqual(skippedNone.status, 0);
    assert.match(skippedNone.stderr, /--skip-provider cannot be combined with --history-mode none/);

    const skippedCommitsOnly = runCollectAll(repo, bin, ["--history-mode", "commits-only", "--skip-provider"]);
    assert.notEqual(skippedCommitsOnly.status, 0);
    assert.match(skippedCommitsOnly.stderr, /--skip-provider cannot be combined with --history-mode commits-only/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("collect-all reports visible defaults from defaults.json", () => {
  const root = mkdtempSync(join(tmpdir(), "memorax-code-repo-memory-defaults."));
  try {
    const defaults = JSON.parse(readFileSync(defaultsPath, "utf8"));
    assert.equal(defaults.schema, "repo_memory_builder_defaults.v2");
    assert.equal(defaults.repoHistory.mode, "provider");
    assert.deepEqual(defaults.repoHistory.limits, { commits: 30, prs: 30, issues: 30 });
    assert.equal(defaults.summaryChars, 4000);

    const { repo, bin } = createRepoFixture(root);
    const result = spawnSync(
      "python3",
      [collectAllScript, "--repo-path", repo, "--pretty"],
      {
        cwd: packageRoot,
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
      },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const report = JSON.parse(result.stdout);
    assert.equal(report.effective_settings.history.mode, "provider");
    assert.deepEqual(report.effective_settings.history.collect, { commits: true, provider: true });
    assert.deepEqual(report.effective_settings.limits, { commits: 30, prs: 30, issues: 30 });
    assert.equal(report.effective_settings.summary_chars, 4000);
    assert.match(report.effective_settings.source, /defaults\.json$/);
    assert.deepEqual(report.effective_settings.overrides, {});
    assert.deepEqual(report.counts.raw.git_commits, { commit: 2 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("memorax-code repo-build maps user count requests to one-run limit overrides", () => {
  const skill = readFileSync(join(builderSkillRoot, "references", "repo-build.md"), "utf8");
  assert.match(skill, /User Count Requests/);
  assert.match(skill, /one-run/i);
  assert.match(skill, /Do not edit `defaults\.json`/);
  assert.match(skill, /拉\s*50\s*条\s*commit/);
  assert.match(skill, /--commit-limit 50/);
  assert.match(skill, /--pr-limit 20/);
  assert.match(skill, /--issue-limit 30/);
  assert.match(skill, /future builder runs/i);
});

test("memorax-code repo-build requires final summaries to surface notices", () => {
  const skill = readFileSync(join(builderSkillRoot, "references", "repo-build.md"), "utf8");
  assert.match(skill, /Final Summary Notices/);
  assert.match(skill, /must include/i);
  assert.match(skill, /notices\[\]/);
  assert.match(skill, /Provider Evidence Unavailable/);
  assert.match(skill, /Provider Sandbox and Transport Failures/);
  assert.match(skill, /gh\/glab/);
  assert.match(skill, /approved network-enabled mode/);
  assert.match(skill, /Do not use a restricted shell sandbox to verify provider\/API availability/);
  assert.match(skill, /Verify provider authentication in the same normal shell/);
  assert.match(skill, /--hostname <host>/);
  assert.match(skill, /Authenticate with `gh auth login` or `glab auth login`/);
  assert.match(skill, /Do not treat a provider transport failure as empty PR\/issue evidence/);
  assert.match(skill, /Do not silently collapse notices into counts/);
});

test("memorax-code repo-build is app-neutral and the router declares OpenAI and Claude metadata", () => {
  const skill = readFileSync(join(builderSkillRoot, "references", "repo-build.md"), "utf8");
  const router = readFileSync(join(builderSkillRoot, "SKILL.md"), "utf8");
  const openaiYaml = readFileSync(join(builderSkillRoot, "agents", "openai.yaml"), "utf8");
  const claudeYaml = readFileSync(join(builderSkillRoot, "agents", "claude.yaml"), "utf8");

  assert.match(router, /single router for persistent coding and repository-local\s+memory/);
  assert.match(router, /### Repo Memory/);
  assert.match(router, /references\/repo-build\.md/);
  assert.match(skill, /first-time creation, full rebuilds, or full refreshes/);
  assert.doesNotMatch(skill, /\bCodex\b/);
  assert.match(skill, /normal user-visible assistant message/);
  assert.match(openaiYaml, /display_name: "MemoraX Code"/);
  assert.match(openaiYaml, /Use \$memorax-code/);
  assert.match(openaiYaml, /allow_implicit_invocation: true/);
  assert.match(claudeYaml, /display_name: "MemoraX Code"/);
  assert.match(claudeYaml, /Use \/memorax-code-claude-adapter:memorax-code/);
  assert.doesNotMatch(claudeYaml, /Use \/memorax-code to route/);
  assert.match(claudeYaml, /~\/\.claude\/skills\/memorax-code/);
  assert.match(claudeYaml, /\.claude\/skills\/memorax-code/);
  assert.match(claudeYaml, /allow_implicit_invocation: true/);
});

test("memorax-code repo templates separate repo memory from runtime coding memory", () => {
  const templates = readFileSync(join(builderSkillRoot, "references", "repo-templates.md"), "utf8");

  assert.match(templates, /## Coding Memory Boundary/);
  assert.match(templates, /cold-start repository map/);
  assert.match(templates, /Runtime coding memory is narrower and should take precedence/);
  assert.match(templates, /Do not treat repo memory, commits, PRs, or issues as implementation recipes/);
});

test("memorax-code repo-build keeps update routing concise", () => {
  const skill = readFileSync(join(builderSkillRoot, "references", "repo-build.md"), "utf8");
  assert.match(skill, /prefer `repo-update\.md`/);
  assert.match(skill, /Internal scripts/);
  assert.match(skill, /Description.+repo-templates\.md/s);
});

test("collect-all supports separate commit, PR, and issue limit overrides", () => {
  const root = mkdtempSync(join(tmpdir(), "memorax-code-repo-memory-limit-overrides."));
  try {
    const { repo, bin } = createRepoFixture(root);
    const result = spawnSync(
      "python3",
      [
        collectAllScript,
        "--repo-path",
        repo,
        "--commit-limit",
        "1",
        "--pr-limit",
        "7",
        "--issue-limit",
        "9",
        "--pretty",
      ],
      {
        cwd: packageRoot,
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
      },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const report = JSON.parse(result.stdout);
    assert.deepEqual(report.effective_settings.limits, { commits: 1, prs: 7, issues: 9 });
    assert.deepEqual(report.effective_settings.overrides, {
      commit_limit: 1,
      pr_limit: 7,
      issue_limit: 9,
    });
    assert.deepEqual(report.counts.raw.git_commits, { commit: 1 });
    assert.equal("indexes" in report.counts, false);
    assert.equal("commit_index" in report.outputs, false);
    assert.equal("prs_index" in report.outputs, false);
    assert.equal("issues_index" in report.outputs, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("provider facet scripts accept separate PR and issue limit overrides", () => {
  const root = mkdtempSync(join(tmpdir(), "memorax-code-repo-memory-provider-limits."));
  try {
    const { repo, bin } = createRepoFixture(root);
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` };

    const github = spawnSync(
      "python3",
      [
        githubFacetsScript,
        "--repo",
        "owner/project",
        "--repo-path",
        repo,
        "--snapshot-ref",
        "HEAD",
        "--pr-limit",
        "1",
        "--issue-limit",
        "2",
      ],
      { cwd: packageRoot, encoding: "utf8", env },
    );
    assert.notEqual(github.status, 0);
    assert.match(github.stderr, /gh auth check failed/);
    assert.match(github.stderr, /stderr: not logged in/);
    assert.doesNotMatch(github.stderr, /unrecognized arguments/);

    const gitlab = spawnSync(
      "python3",
      [
        gitlabFacetsScript,
        "--repo",
        "owner/project",
        "--repo-path",
        repo,
        "--snapshot-ref",
        "HEAD",
        "--pr-limit",
        "1",
        "--issue-limit",
        "2",
      ],
      { cwd: packageRoot, encoding: "utf8", env },
    );
    assert.notEqual(gitlab.status, 0);
    assert.match(gitlab.stderr, /glab auth check failed/);
    assert.match(gitlab.stderr, /stderr: not logged in/);
    assert.doesNotMatch(gitlab.stderr, /unrecognized arguments/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("collect-all requires --reuse and preserves unknown files in an existing .repo_memory directory", () => {
  const root = mkdtempSync(join(tmpdir(), "memorax-code-repo-memory-reuse."));
  try {
    const { repo, bin } = createRepoFixture(root);

    const first = runCollectAll(repo, bin);
    assert.equal(first.status, 0, first.stderr || first.stdout);

    const withoutReuse = runCollectAll(repo, bin);
    assert.notEqual(withoutReuse.status, 0);
    assert.match(withoutReuse.stderr, /already exists/);
    assert.match(withoutReuse.stderr, /--reuse/);

    const unknownFile = join(repo, ".repo_memory", "custom-state.json");
    writeFileSync(unknownFile, '{"ownedBy":"another-tool"}\n');

    const withReuse = runCollectAll(repo, bin, ["--reuse"]);
    assert.equal(withReuse.status, 0, withReuse.stderr || withReuse.stdout);
    const report = JSON.parse(withReuse.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.steps.prepare.ok, true);
    assert.equal(readFileSync(unknownFile, "utf8"), '{"ownedBy":"another-tool"}\n');

    const force = spawnSync("python3", [prepareScript, repo, "--force"], {
      cwd: packageRoot,
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
    });
    assert.notEqual(force.status, 0);
    assert.match(force.stderr, /unrecognized arguments: --force/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repo-memory prepare allows a user-profile-only .repo_memory sidecar", () => {
  const root = mkdtempSync(join(tmpdir(), "memorax-code-repo-memory-user-profile-sidecar."));
  try {
    const { repo, bin } = createRepoFixture(root);

    const profile = spawnSync("python3", [
      userProfileScript,
      "add",
      "--repo",
      repo,
      "--type",
      "communication",
      "--description",
      "User prefers concise Chinese answers in this repository.",
      "--applies-when",
      "Answering repo-local questions.",
    ], {
      cwd: packageRoot,
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
    });
    assert.equal(profile.status, 0, profile.stderr || profile.stdout);
    assert.equal(existsSync(join(repo, ".repo_memory", "user-profile", "preferences.md")), true);

    const prepared = spawnSync("python3", [prepareScript, repo], {
      cwd: packageRoot,
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
    });
    assert.equal(prepared.status, 0, prepared.stderr || prepared.stdout);
    assert.equal(existsSync(join(repo, ".repo_memory", "user-profile", "preferences.md")), true);
    assert.equal(existsSync(join(repo, ".repo_memory", "raw", "prepare-report.json")), true);
    assert.equal(existsSync(join(repo, ".repo_memory", "resources")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("collect-all can render progress without corrupting the JSON report", () => {
  const root = mkdtempSync(join(tmpdir(), "memorax-code-repo-memory-progress."));
  try {
    const { repo, bin } = createRepoFixture(root);

    const result = runCollectAll(repo, bin, ["--progress"]);
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.match(result.stderr, /memorax-code repo-build \[[#-]+\] 1\/3 prepare/);
    assert.match(result.stderr, /memorax-code repo-build \[[#-]+\] 3\/3 provider facets/);
    assert.doesNotMatch(result.stderr, /indexes/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
