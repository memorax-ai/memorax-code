import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const prepareScript = join(packageRoot, "skills", "memorax-code", "scripts", "prepare_repo_memory.py");
const commitFacetsScript = join(packageRoot, "skills", "memorax-code", "scripts", "git_commit_facets.py");
const facetsScript = join(packageRoot, "skills", "memorax-code", "scripts", "github_resource_facets.py");
const gitlabFacetsScript = join(packageRoot, "skills", "memorax-code", "scripts", "gitlab_resource_facets.py");

function runGit(cwd, args) {
  const result = spawnSync(
    "git",
    ["-c", "user.name=Repo Memory Test", "-c", "user.email=repo-memory-test@example.invalid", ...args],
    { cwd, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

test("repo-memory prepare gives actionable guidance for non-git folders", () => {
  const root = mkdtempSync(join(tmpdir(), "memorax-code-repo-memory-non-git."));
  try {
    const folder = join(root, "folder");
    mkdirSync(folder);
    writeFileSync(join(folder, "README.md"), "# Not git yet\n");

    const result = spawnSync("python3", [prepareScript, folder], {
      cwd: packageRoot,
      encoding: "utf8",
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /\*\*Repo Memory Cannot Be Built Yet\*\*/);
    assert.match(result.stderr, /not a git repository/);
    assert.match(result.stderr, /git init/);
    assert.match(result.stderr, /make at least one commit/);
    assert.match(result.stderr, /inspecting files without repo memory/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repo-memory prepare preserves procedure and user-profile sidecars without reuse", () => {
  const root = mkdtempSync(join(tmpdir(), "memorax-code-repo-memory-sidecars."));
  try {
    const repo = join(root, "repo");
    const memory = join(repo, ".repo_memory");
    mkdirSync(repo);
    runGit(repo, ["init", "-b", "main"]);
    writeFileSync(join(repo, "README.md"), "# Test repo\n");
    runGit(repo, ["add", "README.md"]);
    runGit(repo, ["commit", "-m", "initial"]);
    mkdirSync(join(memory, "user-profile"), { recursive: true });
    mkdirSync(join(memory, "procedure-memory"));
    writeFileSync(join(memory, "procedure-memory", "reviewing-code.md"), "# Reviewing Code\n\n- Read the diff.\n");
    writeFileSync(join(memory, "user-profile", "preferences.md"), "# Preferences\n");

    const result = spawnSync("python3", [prepareScript, repo], {
      cwd: packageRoot,
      encoding: "utf8",
      env: { ...process.env, PATH: "/usr/bin:/bin" },
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(readFileSync(join(memory, "procedure-memory", "reviewing-code.md"), "utf8"), /Read the diff/);
    assert.equal(readFileSync(join(memory, "user-profile", "preferences.md"), "utf8"), "# Preferences\n");
    assert.equal(readFileSync(join(repo, ".gitignore"), "utf8"), ".repo_memory/\n");
    assert.equal(JSON.parse(result.stdout).created_directories.includes(".repo_memory/resources"), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repo-memory prepare ignores .repo_memory and detects GitLab remotes", () => {
  const root = mkdtempSync(join(tmpdir(), "memorax-code-repo-memory-prepare."));
  try {
    const repo = join(root, "repo");
    const bin = join(root, "bin");
    const gh = join(bin, "gh");
    const glab = join(bin, "glab");
    mkdirSync(repo);
    mkdirSync(bin);
    writeFileSync(
      gh,
      `#!/bin/sh
set -eu
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  printf '%s\\n' 'not logged in' >&2
  exit 1
fi
printf 'unexpected gh args: %s\\n' "$*" >&2
exit 2
`,
    );
    writeFileSync(
      glab,
      `#!/bin/sh
set -eu
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  printf '%s\\n' 'not logged in' >&2
  exit 1
fi
printf 'unexpected glab args: %s\\n' "$*" >&2
exit 2
`,
    );
    chmodSync(gh, 0o755);
    chmodSync(glab, 0o755);
    runGit(repo, ["init", "-b", "main"]);
    writeFileSync(join(repo, "README.md"), "# Test repo\n");
    runGit(repo, ["add", "README.md"]);
    runGit(repo, ["commit", "-m", "initial"]);
    runGit(repo, ["remote", "add", "origin", "git@gitlab.com:group/subgroup/project.git"]);

    const result = spawnSync("python3", [prepareScript, repo], {
      cwd: packageRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stderr, "");

    const report = JSON.parse(result.stdout);
    assert.equal(report.git_provider, "gitlab");
    assert.equal(report.git_remote_repo, "group/subgroup/project");
    assert.equal(report.gitlab_repo, "group/subgroup/project");
    assert.equal(report.github_repo, "");
    assert.equal(report.glab_available, true);
    assert.equal(report.glab_authenticated, false);
    assert.equal(report.provider_cli, "glab");
    assert.equal(report.provider_evidence_state, "auth_required");
    assert.equal(report.provider_login_hint, "glab auth login");
    assert.equal(report.provider_notice_level, "warning");
    assert.match(report.provider_user_notice, /GitLab provider evidence is unavailable/);
    assert.match(report.provider_user_notice, /glab auth login/);
    assert.match(report.provider_user_notice, /continuing with local-only repo memory/);
    assert.match(report.provider_notice_markdown, /\*\*Provider Evidence Unavailable\*\*/);
    assert.match(report.provider_notice_markdown, /> GitLab provider evidence is unavailable/);
    assert.match(report.provider_notice_markdown, /```bash\nglab auth login\n```/);
    assert.deepEqual(report.provider_next_steps, ["Run: glab auth login", "Rerun $memorax-code repo-build to collect GitLab MR/issue evidence."]);
    assert.equal(report.gitignore_updated, true);
    assert.equal(readFileSync(join(repo, ".gitignore"), "utf8"), ".repo_memory/\n");

    const savedReport = JSON.parse(readFileSync(join(repo, ".repo_memory", "raw", "prepare-report.json"), "utf8"));
    assert.equal(savedReport.git_provider, "gitlab");
    assert.equal(savedReport.gitignore_updated, true);

    const second = spawnSync("python3", [prepareScript, repo, "--reuse"], {
      cwd: packageRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
      },
    });
    assert.equal(second.status, 0, second.stderr || second.stdout);
    const secondReport = JSON.parse(second.stdout);
    assert.equal(secondReport.gitignore_updated, false);
    assert.equal(readFileSync(join(repo, ".gitignore"), "utf8"), ".repo_memory/\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repo-memory prepare shows prominent GitHub login guidance when gh is unauthenticated", () => {
  const root = mkdtempSync(join(tmpdir(), "memorax-code-repo-memory-github-auth."));
  try {
    const repo = join(root, "repo");
    const bin = join(root, "bin");
    const gh = join(bin, "gh");
    const glab = join(bin, "glab");
    mkdirSync(repo);
    mkdirSync(bin);
    writeFileSync(
      gh,
      `#!/bin/sh
set -eu
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  printf '%s\\n' 'not logged in' >&2
  exit 1
fi
printf 'unexpected gh args: %s\\n' "$*" >&2
exit 2
`,
    );
    writeFileSync(
      glab,
      `#!/bin/sh
set -eu
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  exit 0
fi
printf 'unexpected glab args: %s\\n' "$*" >&2
exit 2
`,
    );
    chmodSync(gh, 0o755);
    chmodSync(glab, 0o755);
    runGit(repo, ["init", "-b", "main"]);
    writeFileSync(join(repo, "README.md"), "# Test repo\n");
    runGit(repo, ["add", "README.md"]);
    runGit(repo, ["commit", "-m", "initial"]);
    runGit(repo, ["remote", "add", "origin", "git@github.com:owner/project.git"]);

    const result = spawnSync("python3", [prepareScript, repo], {
      cwd: packageRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stderr, "");

    const report = JSON.parse(result.stdout);
    assert.equal(report.git_provider, "github");
    assert.equal(report.github_repo, "owner/project");
    assert.equal(report.provider_cli, "gh");
    assert.equal(report.provider_evidence_state, "auth_required");
    assert.equal(report.provider_login_hint, "gh auth login");
    assert.equal(report.provider_notice_level, "warning");
    assert.match(report.provider_user_notice, /GitHub provider evidence is unavailable/);
    assert.match(report.provider_notice_markdown, /\*\*Provider Evidence Unavailable\*\*/);
    assert.match(report.provider_notice_markdown, /> GitHub provider evidence is unavailable/);
    assert.match(report.provider_notice_markdown, /```bash\ngh auth login\n```/);
    assert.deepEqual(report.provider_next_steps, ["Run: gh auth login", "Rerun $memorax-code repo-build to collect GitHub PR/issue evidence."]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repo-memory prepare prefers origin over an earlier fork remote", () => {
  const root = mkdtempSync(join(tmpdir(), "memorax-code-repo-memory-origin-remote."));
  try {
    const repo = join(root, "repo");
    const bin = join(root, "bin");
    const gh = join(bin, "gh");
    const glab = join(bin, "glab");
    mkdirSync(repo);
    mkdirSync(bin);
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
    writeFileSync(
      glab,
      `#!/bin/sh
set -eu
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  exit 1
fi
printf 'unexpected glab args: %s\n' "$*" >&2
exit 2
`,
    );
    chmodSync(gh, 0o755);
    chmodSync(glab, 0o755);
    runGit(repo, ["init", "-b", "main"]);
    writeFileSync(join(repo, "README.md"), "# Test repo\n");
    runGit(repo, ["add", "README.md"]);
    runGit(repo, ["commit", "-m", "initial"]);
    runGit(repo, ["remote", "add", "fork", "git@github.com:me/project.git"]);
    runGit(repo, ["remote", "add", "origin", "git@github.com:owner/project.git"]);

    const result = spawnSync("python3", [prepareScript, repo], {
      cwd: packageRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const report = JSON.parse(result.stdout);
    assert.equal(report.git_provider, "github");
    assert.equal(report.git_remote_name, "origin");
    assert.equal(report.git_remote_repo, "owner/project");
    assert.equal(report.github_repo, "owner/project");
    assert.equal(report.git_remote_selection_reason, "preferred_origin_fetch_remote");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repo-memory prepare checks the selected GitHub Enterprise host", () => {
  const root = mkdtempSync(join(tmpdir(), "memorax-code-repo-memory-github-host."));
  try {
    const repo = join(root, "repo");
    const bin = join(root, "bin");
    const gh = join(bin, "gh");
    const glab = join(bin, "glab");
    mkdirSync(repo);
    mkdirSync(bin);
    writeFileSync(
      gh,
      `#!/bin/sh
set -eu
if [ "$1" = "auth" ] && [ "$2" = "status" ] && [ "\${3:-}" = "--hostname" ] && [ "\${4:-}" = "github.example.test" ]; then
  printf '%s\n' 'not logged in to selected GitHub host' >&2
  exit 1
fi
printf 'unexpected gh args: %s\n' "$*" >&2
exit 2
`,
    );
    writeFileSync(
      glab,
      `#!/bin/sh
set -eu
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  exit 1
fi
printf 'unexpected glab args: %s\n' "$*" >&2
exit 2
`,
    );
    chmodSync(gh, 0o755);
    chmodSync(glab, 0o755);
    runGit(repo, ["init", "-b", "main"]);
    writeFileSync(join(repo, "README.md"), "# Test repo\n");
    runGit(repo, ["add", "README.md"]);
    runGit(repo, ["commit", "-m", "initial"]);
    runGit(repo, ["remote", "add", "origin", "git@github.example.test:owner/project.git"]);

    const result = spawnSync("python3", [prepareScript, repo], {
      cwd: packageRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const report = JSON.parse(result.stdout);
    assert.equal(report.git_provider, "github");
    assert.equal(report.git_remote_host, "github.example.test");
    assert.equal(report.git_remote_name, "origin");
    assert.equal(report.github_repo, "owner/project");
    assert.equal(report.provider_cli, "gh");
    assert.equal(report.provider_evidence_state, "auth_required");
    assert.equal(report.provider_login_hint, "gh auth login --hostname github.example.test");
    assert.match(report.gh_auth_error, /selected GitHub host/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repo-memory prepare checks the selected GitLab host", () => {
  const root = mkdtempSync(join(tmpdir(), "memorax-code-repo-memory-gitlab-host."));
  try {
    const repo = join(root, "repo");
    const bin = join(root, "bin");
    const gh = join(bin, "gh");
    const glab = join(bin, "glab");
    mkdirSync(repo);
    mkdirSync(bin);
    writeFileSync(
      gh,
      `#!/bin/sh
set -eu
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  exit 1
fi
printf 'unexpected gh args: %s\n' "$*" >&2
exit 2
`,
    );
    writeFileSync(
      glab,
      `#!/bin/sh
set -eu
if [ "$1" = "auth" ] && [ "$2" = "status" ] && [ "\${3:-}" = "--hostname" ] && [ "\${4:-}" = "gitlab.example.test" ]; then
  printf '%s\n' 'not logged in to selected GitLab host' >&2
  exit 1
fi
printf 'unexpected glab args: %s\n' "$*" >&2
exit 2
`,
    );
    chmodSync(gh, 0o755);
    chmodSync(glab, 0o755);
    runGit(repo, ["init", "-b", "main"]);
    writeFileSync(join(repo, "README.md"), "# Test repo\n");
    runGit(repo, ["add", "README.md"]);
    runGit(repo, ["commit", "-m", "initial"]);
    runGit(repo, ["remote", "add", "fork", "git@gitlab.example.test:me/project.git"]);
    runGit(repo, ["remote", "add", "origin", "git@gitlab.example.test:group/project.git"]);

    const result = spawnSync("python3", [prepareScript, repo], {
      cwd: packageRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const report = JSON.parse(result.stdout);
    assert.equal(report.git_provider, "gitlab");
    assert.equal(report.git_remote_host, "gitlab.example.test");
    assert.equal(report.git_remote_name, "origin");
    assert.equal(report.gitlab_repo, "group/project");
    assert.equal(report.provider_cli, "glab");
    assert.equal(report.provider_evidence_state, "auth_required");
    assert.equal(report.provider_login_hint, "glab auth login --hostname gitlab.example.test");
    assert.match(report.glab_auth_error, /selected GitLab host/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repo-memory local git commits collect without provider auth", () => {
  const root = mkdtempSync(join(tmpdir(), "memorax-code-repo-memory-commits-local."));
  try {
    const repo = join(root, "repo");
    const bin = join(root, "bin");
    const gh = join(bin, "gh");
    const glab = join(bin, "glab");
    mkdirSync(repo);
    mkdirSync(bin);
    writeFileSync(
      gh,
      `#!/bin/sh
set -eu
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  printf '%s\\n' 'not logged in' >&2
  exit 1
fi
printf 'unexpected gh args: %s\\n' "$*" >&2
exit 2
`,
    );
    writeFileSync(
      glab,
      `#!/bin/sh
set -eu
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  printf '%s\\n' 'not logged in' >&2
  exit 1
fi
printf 'unexpected glab args: %s\\n' "$*" >&2
exit 2
`,
    );
    chmodSync(gh, 0o755);
    chmodSync(glab, 0o755);

    runGit(repo, ["init", "-b", "main"]);
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, "README.md"), "# Test repo\n");
    runGit(repo, ["add", "README.md"]);
    runGit(repo, ["commit", "-m", "initial docs"]);
    writeFileSync(join(repo, "src", "app.ts"), "export const answer = 42;\n");
    runGit(repo, ["add", "src/app.ts"]);
    runGit(repo, ["commit", "-m", "add app module", "-m", "Introduces the app entrypoint for local commit memory."]);
    const latestSha = runGit(repo, ["rev-parse", "HEAD"]);
    runGit(repo, ["remote", "add", "origin", "git@github.com:owner/project.git"]);

    const prepare = spawnSync("python3", [prepareScript, repo], {
      cwd: packageRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
      },
    });
    assert.equal(prepare.status, 0, prepare.stderr || prepare.stdout);
    const report = JSON.parse(prepare.stdout);
    assert.equal(report.provider_evidence_state, "auth_required");

    const memoryRoot = join(repo, ".repo_memory");
    const commitRaw = join(memoryRoot, "raw", "git-commits.json");
    const collect = spawnSync(
      "python3",
      [
        commitFacetsScript,
        "--repo-path",
        repo,
        "--snapshot-ref",
        "HEAD",
        "--limit",
        "2",
        "--out",
        commitRaw,
      ],
      {
        cwd: packageRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
        },
      },
    );
    assert.equal(collect.status, 0, collect.stderr || collect.stdout);

    const rawCommits = JSON.parse(readFileSync(commitRaw, "utf8"));
    assert.deepEqual(
      rawCommits.map((commit) => commit.sourceType),
      ["commit", "commit"],
    );
    assert.equal(rawCommits[0].sha, latestSha);
    assert.equal(rawCommits[0].title, "add app module");
    assert.deepEqual(rawCommits[0].files, ["src/app.ts"]);
    assert.deepEqual(rawCommits[0].path_modules, ["src"]);
    assert.match(rawCommits[0].summary, /Introduces the app entrypoint/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repo-memory GitHub facets retry transient gh EOF failures", () => {
  const root = mkdtempSync(join(tmpdir(), "memorax-code-repo-memory-gh-retry."));
  try {
    const bin = join(root, "bin");
    const counter = join(root, "pr-view-counter");
    const out = join(root, "github-facets.json");
    const gh = join(bin, "gh");
    mkdirSync(bin);
    writeFileSync(
      gh,
      `#!/bin/sh
set -eu
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  printf '%s\\n' '[{"number":1,"title":"Retry PR","state":"OPEN","url":"https://example.test/pull/1","updatedAt":"2026-07-03T00:00:00Z","baseRefName":"main","headRefName":"retry","headRepository":{"nameWithOwner":"owner/repo"},"headRepositoryOwner":{"login":"owner"},"isDraft":false}]'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  if [ ! -f "$GH_RETRY_COUNTER" ]; then
    printf 'seen\\n' > "$GH_RETRY_COUNTER"
    printf '%s\\n' 'Post "https://api.github.com/graphql": EOF' >&2
    exit 1
  fi
  printf '%s\\n' '{"number":1,"title":"Retry PR","body":"Retry body","state":"OPEN","url":"https://example.test/pull/1","updatedAt":"2026-07-03T00:00:00Z","createdAt":"2026-07-03T00:00:00Z","closedAt":"","mergedAt":"","author":{"login":"tester"},"comments":[],"reviews":[],"latestReviews":[],"reviewDecision":"","files":[{"path":"packages/example.ts"}],"commits":[{"messageHeadline":"retry commit","oid":"abc"}],"closingIssuesReferences":[],"mergeCommit":null,"baseRefName":"main","headRefName":"retry","headRepository":{"nameWithOwner":"owner/repo"},"headRepositoryOwner":{"login":"owner"},"isDraft":false,"additions":1,"deletions":0,"changedFiles":1}'
  exit 0
fi
printf 'unexpected gh args: %s\\n' "$*" >&2
exit 2
`,
    );
    chmodSync(gh, 0o755);
    const result = spawnSync(
      "python3",
      [
        facetsScript,
        "--repo",
        "owner/repo",
        "--include",
        "prs",
        "--pr-limit",
        "1",
        "--state",
        "all",
        "--concurrency",
        "1",
        "--gh-retries",
        "1",
        "--gh-retry-delay-ms",
        "1",
        "--out",
        out,
      ],
      {
        cwd: packageRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          GH_RETRY_COUNTER: counter,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stderr, new RegExp("retrying 1/1"));
    const facets = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(facets.length, 1);
    assert.equal(facets[0].facetId, "pr.1");
    assert.equal(facets[0].summary, "Retry body");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repo-memory GitHub facets passes hostname to gh auth and repo selector", () => {
  const root = mkdtempSync(join(tmpdir(), "memorax-code-repo-memory-github-api-host."));
  try {
    const bin = join(root, "bin");
    const out = join(root, "github-facets.json");
    const gh = join(bin, "gh");
    mkdirSync(bin);
    writeFileSync(
      gh,
      `#!/bin/sh
set -eu
if [ "$1" = "auth" ] && [ "$2" = "status" ] && [ "\${3:-}" = "--hostname" ] && [ "\${4:-}" = "github.example.test" ]; then
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "list" ]; then
  case " $* " in
    *' --repo github.example.test/owner/repo '*)
      printf '%s\\n' '[{"number":9,"title":"Hosted issue","state":"OPEN","url":"https://github.example.test/owner/repo/issues/9","updatedAt":"2026-07-01T00:00:00Z","labels":[]}]'
      exit 0
      ;;
  esac
fi
if [ "$1" = "issue" ] && [ "$2" = "view" ]; then
  case " $* " in
    *' --repo github.example.test/owner/repo '*)
      printf '%s\\n' '{"number":9,"title":"Hosted issue","body":"Self-hosted GitHub issue evidence.","state":"OPEN","url":"https://github.example.test/owner/repo/issues/9","updatedAt":"2026-07-01T00:00:00Z","labels":[],"comments":[]}'
      exit 0
      ;;
  esac
fi
printf 'unexpected gh args: %s\\n' "$*" >&2
exit 2
`,
    );
    chmodSync(gh, 0o755);

    const result = spawnSync(
      "python3",
      [
        facetsScript,
        "--repo",
        "owner/repo",
        "--hostname",
        "github.example.test",
        "--include",
        "issues",
        "--issue-limit",
        "1",
        "--state",
        "all",
        "--out",
        out,
      ],
      {
        cwd: packageRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const facets = JSON.parse(readFileSync(out, "utf8"));
    assert.deepEqual(facets.map((facet) => facet.facetId), ["issue.9"]);
    assert.equal(facets[0].repo, "owner/repo");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repo-memory GitHub facets treats limit as retained snapshot PR count", () => {
  const root = mkdtempSync(join(tmpdir(), "memorax-code-repo-memory-gh-snapshot-backfill."));
  try {
    const repo = join(root, "repo");
    const bin = join(root, "bin");
    const out = join(root, "github-facets.json");
    const gh = join(bin, "gh");
    mkdirSync(repo);
    mkdirSync(bin);

    runGit(repo, ["init", "-b", "main"]);
    writeFileSync(join(repo, "file.txt"), "base\n");
    runGit(repo, ["add", "file.txt"]);
    runGit(repo, ["commit", "-m", "base"]);
    writeFileSync(join(repo, "file.txt"), "base\nlanded\n");
    runGit(repo, ["commit", "-am", "landed pr merge"]);
    const landedSha = runGit(repo, ["rev-parse", "HEAD"]);
    runGit(repo, ["checkout", "-b", "future"]);
    writeFileSync(join(repo, "file.txt"), "base\nlanded\nfuture\n");
    runGit(repo, ["commit", "-am", "future pr merge"]);
    const futureSha = runGit(repo, ["rev-parse", "HEAD"]);
    runGit(repo, ["checkout", "main"]);

    writeFileSync(
      gh,
      `#!/bin/sh
set -eu
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  case " $* " in
    *' --limit 1 '*)
      printf '%s\\n' '[{"number":2}]'
      ;;
    *)
      printf '%s\\n' '[{"number":2},{"number":1}]'
      ;;
  esac
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  case "$3" in
    1)
      printf '%s\\n' '{"number":1,"title":"Landed PR","body":"Landed body","state":"MERGED","url":"https://example.test/pull/1","updatedAt":"2026-07-01T00:00:00Z","createdAt":"2026-07-01T00:00:00Z","closedAt":"2026-07-01T00:00:00Z","mergedAt":"2026-07-01T00:00:00Z","author":{"login":"tester"},"comments":[],"reviews":[],"latestReviews":[],"reviewDecision":"","files":[{"path":"packages/landed.ts"}],"commits":[{"messageHeadline":"landed pr merge","oid":"'"$LANDED_SHA"'"}],"closingIssuesReferences":[],"mergeCommit":{"oid":"'"$LANDED_SHA"'"},"baseRefName":"main","headRefName":"landed","headRepository":{"nameWithOwner":"owner/repo"},"headRepositoryOwner":{"login":"owner"},"isDraft":false,"additions":1,"deletions":0,"changedFiles":1}'
      ;;
    2)
      printf '%s\\n' '{"number":2,"title":"Future PR","body":"Future body","state":"MERGED","url":"https://example.test/pull/2","updatedAt":"2026-07-04T00:00:00Z","createdAt":"2026-07-04T00:00:00Z","closedAt":"2026-07-04T00:00:00Z","mergedAt":"2026-07-04T00:00:00Z","author":{"login":"tester"},"comments":[],"reviews":[],"latestReviews":[],"reviewDecision":"","files":[{"path":"packages/future.ts"}],"commits":[{"messageHeadline":"future pr merge","oid":"'"$FUTURE_SHA"'"}],"closingIssuesReferences":[],"mergeCommit":{"oid":"'"$FUTURE_SHA"'"},"baseRefName":"main","headRefName":"future","headRepository":{"nameWithOwner":"owner/repo"},"headRepositoryOwner":{"login":"owner"},"isDraft":false,"additions":1,"deletions":0,"changedFiles":1}'
      ;;
    *)
      printf 'unexpected PR number: %s\\n' "$3" >&2
      exit 2
      ;;
  esac
  exit 0
fi
printf 'unexpected gh args: %s\\n' "$*" >&2
exit 2
`,
    );
    chmodSync(gh, 0o755);

    const result = spawnSync(
      "python3",
      [
        facetsScript,
        "--repo",
        "owner/repo",
        "--repo-path",
        repo,
        "--snapshot-ref",
        "HEAD",
        "--include",
        "prs",
        "--pr-limit",
        "1",
        "--state",
        "all",
        "--concurrency",
        "1",
        "--out",
        out,
      ],
      {
        cwd: packageRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          LANDED_SHA: landedSha,
          FUTURE_SHA: futureSha,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const facets = JSON.parse(readFileSync(out, "utf8"));
    assert.deepEqual(
      facets.map((facet) => facet.facetId),
      ["pr.1"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repo-memory GitLab facets collects merge requests and issues with glab", () => {
  const root = mkdtempSync(join(tmpdir(), "memorax-code-repo-memory-gitlab."));
  try {
    const bin = join(root, "bin");
    const out = join(root, "gitlab-facets.json");
    const glab = join(bin, "glab");
    mkdirSync(bin);
    writeFileSync(
      glab,
      `#!/bin/sh
set -eu
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  exit 0
fi
if [ "$1" = "api" ]; then
  case "$2" in
    'projects/group%2Fproject/merge_requests?state=all&per_page=2&order_by=updated_at&sort=desc')
      printf '%s\\n' '[{"iid":7,"title":"Add GitLab support","description":"Support GitLab merge request and issue evidence. Closes #9","state":"merged","web_url":"https://gitlab.example.test/group/project/-/merge_requests/7","updated_at":"2026-07-03T00:00:00Z","created_at":"2026-07-02T00:00:00Z","closed_at":"2026-07-03T00:00:00Z","merged_at":"2026-07-03T00:00:00Z","author":{"username":"tester"},"source_branch":"gitlab-support","target_branch":"main","draft":false,"changes_count":"2","merge_commit_sha":"abc123"}]'
      exit 0
      ;;
    'projects/group%2Fproject/merge_requests/7/changes')
      printf '%s\\n' '{"changes":[{"new_path":"packages/gitlab.ts"},{"new_path":"docs/gitlab.md"}]}'
      exit 0
      ;;
    'projects/group%2Fproject/issues?state=all&per_page=2&order_by=updated_at&sort=desc')
      printf '%s\\n' '[{"iid":9,"title":"Support GitLab","description":"Users need GitLab repositories to build repo memory.","state":"opened","web_url":"https://gitlab.example.test/group/project/-/issues/9","updated_at":"2026-07-01T00:00:00Z","labels":["repo-memory"]}]'
      exit 0
      ;;
  esac
fi
printf 'unexpected glab args: %s\\n' "$*" >&2
exit 2
`,
    );
    chmodSync(glab, 0o755);

    const result = spawnSync(
      "python3",
      [
        gitlabFacetsScript,
        "--repo",
        "group/project",
        "--include",
        "prs,issues",
        "--pr-limit",
        "2",
        "--issue-limit",
        "2",
        "--state",
        "all",
        "--summary-chars",
        "4000",
        "--out",
        out,
      ],
      {
        cwd: packageRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const facets = JSON.parse(readFileSync(out, "utf8"));
    assert.deepEqual(
      facets.map((facet) => facet.facetId),
      ["mr.7", "issue.9"],
    );
    assert.equal(facets[0].provider, "gitlab");
    assert.equal(facets[0].sourceType, "pr");
    assert.equal(facets[0].state, "MERGED");
    assert.deepEqual(facets[0].prs, [7]);
    assert.deepEqual(facets[0].issues, [9]);
    assert.deepEqual(facets[0].files, ["packages/gitlab.ts", "docs/gitlab.md"]);
    assert.equal(facets[1].provider, "gitlab");
    assert.equal(facets[1].sourceType, "issue");
    assert.equal(facets[1].state, "OPEN");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repo-memory GitLab facets passes hostname to glab auth and api", () => {
  const root = mkdtempSync(join(tmpdir(), "memorax-code-repo-memory-gitlab-api-host."));
  try {
    const bin = join(root, "bin");
    const out = join(root, "gitlab-facets.json");
    const glab = join(bin, "glab");
    mkdirSync(bin);
    writeFileSync(
      glab,
      `#!/bin/sh
set -eu
if [ "$1" = "auth" ] && [ "$2" = "status" ] && [ "\${3:-}" = "--hostname" ] && [ "\${4:-}" = "gitlab.example.test" ]; then
  exit 0
fi
if [ "$1" = "api" ] && [ "\${2:-}" = "--hostname" ] && [ "\${3:-}" = "gitlab.example.test" ]; then
  case "$4" in
    'projects/group%2Fproject/issues?state=all&per_page=1&order_by=updated_at&sort=desc')
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

    const result = spawnSync(
      "python3",
      [
        gitlabFacetsScript,
        "--repo",
        "group/project",
        "--hostname",
        "gitlab.example.test",
        "--include",
        "issues",
        "--issue-limit",
        "1",
        "--state",
        "all",
        "--out",
        out,
      ],
      {
        cwd: packageRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const facets = JSON.parse(readFileSync(out, "utf8"));
    assert.deepEqual(facets.map((facet) => facet.facetId), ["issue.9"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repo-memory GitLab facets treats limit as retained snapshot MR count", () => {
  const root = mkdtempSync(join(tmpdir(), "memorax-code-repo-memory-gitlab-snapshot-backfill."));
  try {
    const repo = join(root, "repo");
    const bin = join(root, "bin");
    const out = join(root, "gitlab-facets.json");
    const glab = join(bin, "glab");
    mkdirSync(repo);
    mkdirSync(bin);

    runGit(repo, ["init", "-b", "main"]);
    writeFileSync(join(repo, "file.txt"), "base\n");
    runGit(repo, ["add", "file.txt"]);
    runGit(repo, ["commit", "-m", "base"]);
    writeFileSync(join(repo, "file.txt"), "base\nlanded\n");
    runGit(repo, ["commit", "-am", "landed mr merge"]);
    const landedSha = runGit(repo, ["rev-parse", "HEAD"]);
    runGit(repo, ["checkout", "-b", "future"]);
    writeFileSync(join(repo, "file.txt"), "base\nlanded\nfuture\n");
    runGit(repo, ["commit", "-am", "future mr merge"]);
    const futureSha = runGit(repo, ["rev-parse", "HEAD"]);
    runGit(repo, ["checkout", "main"]);

    writeFileSync(
      glab,
      `#!/bin/sh
set -eu
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  exit 0
fi
if [ "$1" = "api" ]; then
  case "$2" in
    'projects/group%2Fproject/merge_requests?state=all&per_page=1&order_by=updated_at&sort=desc')
      printf '%s\\n' '[{"iid":2,"title":"Future MR","description":"Future body","state":"merged","web_url":"https://gitlab.example.test/group/project/-/merge_requests/2","updated_at":"2026-07-04T00:00:00Z","created_at":"2026-07-04T00:00:00Z","closed_at":"2026-07-04T00:00:00Z","merged_at":"2026-07-04T00:00:00Z","author":{"username":"tester"},"source_branch":"future","target_branch":"main","draft":false,"changes_count":"1","merge_commit_sha":"'"$FUTURE_SHA"'"}]'
      exit 0
      ;;
    'projects/group%2Fproject/merge_requests?state=all&per_page=1&order_by=updated_at&sort=desc&page=1')
      printf '%s\\n' '[{"iid":2,"title":"Future MR","description":"Future body","state":"merged","web_url":"https://gitlab.example.test/group/project/-/merge_requests/2","updated_at":"2026-07-04T00:00:00Z","created_at":"2026-07-04T00:00:00Z","closed_at":"2026-07-04T00:00:00Z","merged_at":"2026-07-04T00:00:00Z","author":{"username":"tester"},"source_branch":"future","target_branch":"main","draft":false,"changes_count":"1","merge_commit_sha":"'"$FUTURE_SHA"'"}]'
      exit 0
      ;;
    'projects/group%2Fproject/merge_requests?state=all&per_page=1&order_by=updated_at&sort=desc&page=2')
      printf '%s\\n' '[{"iid":1,"title":"Landed MR","description":"Landed body","state":"merged","web_url":"https://gitlab.example.test/group/project/-/merge_requests/1","updated_at":"2026-07-01T00:00:00Z","created_at":"2026-07-01T00:00:00Z","closed_at":"2026-07-01T00:00:00Z","merged_at":"2026-07-01T00:00:00Z","author":{"username":"tester"},"source_branch":"landed","target_branch":"main","draft":false,"changes_count":"1","merge_commit_sha":"'"$LANDED_SHA"'"}]'
      exit 0
      ;;
    'projects/group%2Fproject/merge_requests/1/changes')
      printf '%s\\n' '{"changes":[{"new_path":"packages/landed.ts"}]}'
      exit 0
      ;;
  esac
fi
printf 'unexpected glab args: %s\\n' "$*" >&2
exit 2
`,
    );
    chmodSync(glab, 0o755);

    const result = spawnSync(
      "python3",
      [
        gitlabFacetsScript,
        "--repo",
        "group/project",
        "--repo-path",
        repo,
        "--snapshot-ref",
        "HEAD",
        "--include",
        "prs",
        "--pr-limit",
        "1",
        "--state",
        "all",
        "--out",
        out,
      ],
      {
        cwd: packageRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          LANDED_SHA: landedSha,
          FUTURE_SHA: futureSha,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const facets = JSON.parse(readFileSync(out, "utf8"));
    assert.deepEqual(
      facets.map((facet) => facet.facetId),
      ["mr.1"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repo-memory GitHub facets filters PRs to the snapshot commit history", () => {
  const root = mkdtempSync(join(tmpdir(), "memorax-code-repo-memory-pr-snapshot."));
  try {
    const repo = join(root, "repo");
    const bin = join(root, "bin");
    const out = join(root, "github-facets.json");
    const gh = join(bin, "gh");
    mkdirSync(repo);
    mkdirSync(bin);

    runGit(repo, ["init", "-b", "main"]);
    writeFileSync(join(repo, "file.txt"), "base\n");
    runGit(repo, ["add", "file.txt"]);
    runGit(repo, ["commit", "-m", "base"]);
    writeFileSync(join(repo, "file.txt"), "base\nlanded\n");
    runGit(repo, ["commit", "-am", "landed pr merge"]);
    const landedSha = runGit(repo, ["rev-parse", "HEAD"]);
    runGit(repo, ["checkout", "-b", "future"]);
    writeFileSync(join(repo, "file.txt"), "base\nlanded\nfuture\n");
    runGit(repo, ["commit", "-am", "future pr merge"]);
    const futureSha = runGit(repo, ["rev-parse", "HEAD"]);
    runGit(repo, ["checkout", "main"]);

    writeFileSync(
      gh,
      `#!/bin/sh
set -eu
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  printf '%s\\n' '[{"number":1},{"number":2},{"number":3}]'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  case "$3" in
    1)
      printf '%s\\n' '{"number":1,"title":"Landed PR","body":"Landed body","state":"MERGED","url":"https://example.test/pull/1","updatedAt":"2026-07-01T00:00:00Z","createdAt":"2026-07-01T00:00:00Z","closedAt":"2026-07-01T00:00:00Z","mergedAt":"2026-07-01T00:00:00Z","author":{"login":"tester"},"comments":[],"reviews":[],"latestReviews":[],"reviewDecision":"","files":[{"path":"packages/landed.ts"}],"commits":[{"messageHeadline":"landed pr merge","oid":"'"$LANDED_SHA"'"}],"closingIssuesReferences":[],"mergeCommit":{"oid":"'"$LANDED_SHA"'"},"baseRefName":"main","headRefName":"landed","headRepository":{"nameWithOwner":"owner/repo"},"headRepositoryOwner":{"login":"owner"},"isDraft":false,"additions":1,"deletions":0,"changedFiles":1}'
      ;;
    2)
      printf '%s\\n' '{"number":2,"title":"Future PR","body":"Future body","state":"MERGED","url":"https://example.test/pull/2","updatedAt":"2026-07-04T00:00:00Z","createdAt":"2026-07-04T00:00:00Z","closedAt":"2026-07-04T00:00:00Z","mergedAt":"2026-07-04T00:00:00Z","author":{"login":"tester"},"comments":[],"reviews":[],"latestReviews":[],"reviewDecision":"","files":[{"path":"packages/future.ts"}],"commits":[{"messageHeadline":"future pr merge","oid":"'"$FUTURE_SHA"'"}],"closingIssuesReferences":[],"mergeCommit":{"oid":"'"$FUTURE_SHA"'"},"baseRefName":"main","headRefName":"future","headRepository":{"nameWithOwner":"owner/repo"},"headRepositoryOwner":{"login":"owner"},"isDraft":false,"additions":1,"deletions":0,"changedFiles":1}'
      ;;
    3)
      printf '%s\\n' '{"number":3,"title":"Open PR","body":"Open body","state":"OPEN","url":"https://example.test/pull/3","updatedAt":"2026-07-04T00:00:00Z","createdAt":"2026-07-04T00:00:00Z","closedAt":"","mergedAt":"","author":{"login":"tester"},"comments":[],"reviews":[],"latestReviews":[],"reviewDecision":"","files":[{"path":"packages/open.ts"}],"commits":[{"messageHeadline":"open pr commit","oid":"open"}],"closingIssuesReferences":[],"mergeCommit":null,"baseRefName":"main","headRefName":"open","headRepository":{"nameWithOwner":"owner/repo"},"headRepositoryOwner":{"login":"owner"},"isDraft":false,"additions":1,"deletions":0,"changedFiles":1}'
      ;;
    *)
      printf 'unexpected PR number: %s\\n' "$3" >&2
      exit 2
      ;;
  esac
  exit 0
fi
printf 'unexpected gh args: %s\\n' "$*" >&2
exit 2
`,
    );
    chmodSync(gh, 0o755);

    const result = spawnSync(
      "python3",
      [
        facetsScript,
        "--repo",
        "owner/repo",
        "--repo-path",
        repo,
        "--snapshot-ref",
        "HEAD",
        "--include",
        "prs",
        "--pr-limit",
        "3",
        "--state",
        "all",
        "--concurrency",
        "1",
        "--out",
        out,
      ],
      {
        cwd: packageRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          LANDED_SHA: landedSha,
          FUTURE_SHA: futureSha,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const facets = JSON.parse(readFileSync(out, "utf8"));
    assert.deepEqual(
      facets.map((facet) => facet.facetId),
      ["pr.1"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("repo-memory build guidance requires wiki-style repository pages", () => {
  const build = readFileSync(join(packageRoot, "skills", "memorax-code", "references", "repo-build.md"), "utf8");
  const templates = readFileSync(join(packageRoot, "skills", "memorax-code", "references", "repo-templates.md"), "utf8");

  assert.match(build, /## Wiki-Style Output Contract/);
  assert.match(build, /wiki-style repository memory/);
  assert.match(build, /supporting conceptual pages/);
  assert.match(build, /3-7 Markdown pages total, including `PROFILE\.md`/);
  assert.match(build, /resources\/\*\.md remain compact historical routing cards/);

  assert.match(templates, /layout: "wiki_landing_page\.v0\.1"/);
  assert.match(templates, /schema: "repo_memory_wiki_page\.v0\.1"/);
  assert.match(templates, /## Major Areas/);
  assert.match(templates, /## Supporting Pages/);
  assert.match(templates, /Evidence status:/);
  assert.match(templates, /Agent note:/);
});

test("repo-memory build plans natural page boundaries before final wiki writing", () => {
  const build = readFileSync(join(packageRoot, "skills", "memorax-code", "references", "repo-build.md"), "utf8");
  const templates = readFileSync(join(packageRoot, "skills", "memorax-code", "references", "repo-templates.md"), "utf8");

  assert.match(build, /## Conceptual Page Planning/);
  assert.match(build, /temporary planning artifact at `\.repo_memory\/_plan\.md`/);
  assert.match(build, /canonical homes for overlapping concepts/);
  assert.match(build, /Do not assume fixed supporting page names/);
  assert.match(build, /Remove `\.repo_memory\/_plan\.md` before final validation/);
  assert.match(build, /Merge rather than split/);
  assert.match(build, /Split rather than merge/);
  assert.match(build, /Natural documentation domains/);
  assert.match(build, /candidates, not a required checklist/);

  assert.match(templates, /### `\.repo_memory\/_plan\.md`/);
  assert.match(templates, /selected, merged, or skipped/);
  assert.match(templates, /### `\.repo_memory\/<repo-native-topic>\.md`/);
  assert.match(templates, /Name pages from repository vocabulary, not from this template/);
  assert.match(templates, /generic names are fallback names/);
  assert.doesNotMatch(templates, /\| Architecture \| \[Architecture\]\(\.\/architecture\.md\)/);
  assert.doesNotMatch(templates, /\| Runtime Flow \| \[Runtime Flow\]\(\.\/runtime-flow\.md\)/);
  assert.doesNotMatch(templates, /\| Developer Workflow \| \[Developer Workflow\]\(\.\/developer-workflow\.md\)/);
});

test("repo-memory build guidance documents configurable history modes and disabled resources", () => {
  const build = readFileSync(join(packageRoot, "skills", "memorax-code", "references", "repo-build.md"), "utf8");
  const templates = readFileSync(join(packageRoot, "skills", "memorax-code", "references", "repo-templates.md"), "utf8");

  assert.match(build, /repo_memory_builder_defaults\.v2/);
  assert.match(build, /"repoHistory"/);
  assert.match(build, /"mode": "provider"/);
  assert.match(build, /## Historical Evidence Policy/);
  assert.match(build, /--history-mode none/);
  assert.match(build, /--history-mode commits-only/);
  assert.match(build, /--history-mode local-only/);
  assert.match(build, /--history-mode provider/);
  assert.match(build, /--history-mode provider-required/);
  assert.match(build, /`--skip-provider` is a compatibility alias for `--history-mode local-only`/);
  assert.match(build, /write disabled resource files/);
  assert.match(build, /source: "history_disabled"/);
  assert.match(build, /source: "provider_skipped_local_only"/);
  assert.match(build, /do not say that no PRs or issues exist/);

  assert.match(templates, /Disabled Or Unavailable Resource Files/);
  assert.match(templates, /source: "history_disabled"/);
  assert.match(templates, /source: "provider_skipped_local_only"/);
  assert.match(templates, /source: "provider_unavailable"/);
  assert.match(templates, /resource_count: 0/);
  assert.match(templates, /raw_source: ""/);
  assert.match(templates, /No provider evidence was collected/);
});
