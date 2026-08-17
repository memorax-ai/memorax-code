import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const validateScript = join(packageRoot, "skills", "memorax-code", "scripts", "validate_memory.py");

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeResource(path, { schema, resourceCount, rawSource, sections, source, trustState }) {
  const inferredSource = source ?? (
    schema.includes("_commit_")
      ? (rawSource ? "git_commit_facets" : "history_disabled")
      : (rawSource ? "github_resource_facets" : "provider_skipped_local_only")
  );
  const inferredTrustState = trustState ?? "draft_resource";
  writeFileSync(
    path,
    `---
schema: "${schema}"
source: "${inferredSource}"
resource_count: ${resourceCount}
trust_state: "${inferredTrustState}"
${rawSource === undefined ? "" : `raw_source: "${rawSource}"\n`}---

# ${schema}

${sections.map((section) => `## ${section}\n\nDescription: ${section}.\n`).join("\n")}`,
  );
}

function makeMemoryRoot(root) {
  const repo = join(root, "repo");
  const memory = join(repo, ".repo_memory");
  mkdirSync(join(memory, "resources"), { recursive: true });
  mkdirSync(join(memory, "raw"), { recursive: true });
  return { repo, memory };
}

test("repo-memory validator accepts a markdown-first bundle and scans JSON only under raw", () => {
  const root = mkdtempSync(join(tmpdir(), "memorax-code-repo-memory-validate-pass."));
  try {
    const { repo, memory } = makeMemoryRoot(root);
    writeFileSync(
      join(memory, "PROFILE.md"),
      `---
schema: "repo_memory_profile.v0.1"
---

# Test Repo Memory Profile

This profile describes the test repository.
`,
    );
    writeResource(join(memory, "resources", "commits.md"), {
      schema: "repo_memory_commit_resource.v0.1",
      resourceCount: 2,
      rawSource: "../raw/git-commits.json",
      sections: ["commit one", "commit two"],
    });
    writeResource(join(memory, "resources", "prs.md"), {
      schema: "repo_memory_pr_resource.v0.1",
      resourceCount: 1,
      rawSource: "../raw/github-facets.json",
      sections: ["PR 1"],
    });
    writeResource(join(memory, "resources", "issues.md"), {
      schema: "repo_memory_issue_resource.v0.1",
      resourceCount: 1,
      rawSource: "../raw/github-facets.json",
      sections: ["Issue 1"],
    });
    writeJson(join(memory, "raw", "git-commits.json"), [{ sourceType: "commit", facetId: "commit.abc" }]);
    writeJson(join(memory, "raw", "github-facets.json"), [
      { sourceType: "pr", facetId: "pr.1" },
      { sourceType: "issue", facetId: "issue.1" },
    ]);
    mkdirSync(join(memory, "raw", "provider"));
    writeJson(join(memory, "raw", "provider", "metadata.json"), { provider: "github" });
    writeFileSync(join(memory, "custom-state.json"), "{\n");
    mkdirSync(join(memory, "procedure-memory"));
    writeFileSync(join(memory, "procedure-memory", "reviewing-code.md"), "# Procedure [does not need bundle frontmatter]\n");
    mkdirSync(join(memory, "user-profile"));
    writeFileSync(join(memory, "user-profile", "preferences.md"), "# Preferences [are a sidecar]\n");
    const result = spawnSync("python3", [validateScript, repo, "--pretty"], {
      cwd: packageRoot,
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.deepEqual(report.errors, []);
    assert.ok(report.checked.includes("PROFILE.md"));
    assert.ok(report.checked.includes("raw/github-facets.json"));
    assert.ok(report.checked.includes("raw/provider/metadata.json"));
    assert.equal(report.checked.includes("custom-state.json"), false);
    assert.equal(report.checked.includes("procedure-memory/reviewing-code.md"), false);
    assert.equal(report.checked.includes("user-profile/preferences.md"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repo-memory validator allows markdown link text with whitespace before the target", () => {
  const root = mkdtempSync(join(tmpdir(), "memorax-code-repo-memory-validate-link."));
  try {
    const { memory } = makeMemoryRoot(root);
    writeFileSync(
      join(memory, "PROFILE.md"),
      `---
schema: "repo_memory_profile.v0.1"
---

# Test Repo Memory Profile

Docs: [Repo docs] (https://example.invalid/docs)

Issues: [Issue tracker]
(https://example.invalid/issues)
`,
    );
    writeResource(join(memory, "resources", "commits.md"), {
      schema: "repo_memory_commit_resource.v0.1",
      resourceCount: 0,
      rawSource: "../raw/git-commits.json",
      sections: [],
    });
    writeResource(join(memory, "resources", "prs.md"), {
      schema: "repo_memory_pr_resource.v0.1",
      resourceCount: 0,
      rawSource: "../raw/github-facets.json",
      sections: [],
    });
    writeResource(join(memory, "resources", "issues.md"), {
      schema: "repo_memory_issue_resource.v0.1",
      resourceCount: 0,
      rawSource: "../raw/github-facets.json",
      sections: [],
    });
    writeJson(join(memory, "raw", "git-commits.json"), []);
    writeJson(join(memory, "raw", "github-facets.json"), []);

    const result = spawnSync("python3", [validateScript, memory, "--pretty"], {
      cwd: packageRoot,
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.deepEqual(report.errors, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repo-memory validator ignores bracket syntax inside inline code spans", () => {
  const root = mkdtempSync(join(tmpdir(), "memorax-code-repo-memory-validate-code-span."));
  try {
    const { memory } = makeMemoryRoot(root);
    writeFileSync(
      join(memory, "PROFILE.md"),
      `---
schema: "repo_memory_profile.v0.1"
---

# Test Repo Memory Profile

Run \`memorax-code repo-build [--force] [repo]\` to regenerate the wiki.
`,
    );
    writeResource(join(memory, "resources", "commits.md"), {
      schema: "repo_memory_commit_resource.v0.1",
      resourceCount: 0,
      rawSource: "../raw/git-commits.json",
      sections: [],
    });
    writeResource(join(memory, "resources", "prs.md"), {
      schema: "repo_memory_pr_resource.v0.1",
      resourceCount: 0,
      rawSource: "",
      sections: [],
    });
    writeResource(join(memory, "resources", "issues.md"), {
      schema: "repo_memory_issue_resource.v0.1",
      resourceCount: 0,
      rawSource: "",
      sections: [],
    });
    writeJson(join(memory, "raw", "git-commits.json"), []);

    const result = spawnSync("python3", [validateScript, memory, "--pretty"], {
      cwd: packageRoot,
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.deepEqual(report.errors, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repo-memory validator reports placeholders and mismatched resource counts", () => {
  const root = mkdtempSync(join(tmpdir(), "memorax-code-repo-memory-validate-fail."));
  try {
    const { memory } = makeMemoryRoot(root);
    writeFileSync(
      join(memory, "PROFILE.md"),
      `---
schema: "repo_memory_profile.v0.1"
---

# [repo name] Repo Memory Profile
`,
    );
    writeResource(join(memory, "resources", "commits.md"), {
      schema: "repo_memory_commit_resource.v0.1",
      resourceCount: 2,
      rawSource: "../raw/git-commits.json",
      sections: ["commit one"],
    });
    writeResource(join(memory, "resources", "prs.md"), {
      schema: "repo_memory_pr_resource.v0.1",
      resourceCount: 0,
      rawSource: "../raw/github-facets.json",
      sections: [],
    });
    writeResource(join(memory, "resources", "issues.md"), {
      schema: "repo_memory_issue_resource.v0.1",
      resourceCount: 0,
      sections: [],
    });
    writeJson(join(memory, "raw", "git-commits.json"), []);

    const result = spawnSync("python3", [validateScript, memory, "--pretty"], {
      cwd: packageRoot,
      encoding: "utf8",
    });

    assert.notEqual(result.status, 0);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, false);
    assert.ok(report.errors.some((error) => /PROFILE\.md.*placeholder.*\[repo name\]/.test(error)));
    assert.ok(report.errors.some((error) => /resources\/commits\.md.*resource_count.*2.*1/.test(error)));
    assert.ok(report.errors.some((error) => /resources\/issues\.md.*frontmatter field 'raw_source' is missing/.test(error)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repo-memory validator requires explicit resource provenance state", () => {
  const root = mkdtempSync(join(tmpdir(), "memorax-code-repo-memory-validate-resource-provenance."));
  try {
    const { memory } = makeMemoryRoot(root);
    writeFileSync(
      join(memory, "PROFILE.md"),
      `---
schema: "repo_memory_profile.v0.2"
layout: "wiki_landing_page.v0.1"
---

# Test Repo Wiki
`,
    );
    writeFileSync(
      join(memory, "resources", "commits.md"),
      `---
schema: "repo_memory_commit_resource.v0.1"
resource_count: 0
raw_source: "../raw/git-commits.json"
---

# Commit Resource Snapshot
`,
    );
    writeResource(join(memory, "resources", "prs.md"), {
      schema: "repo_memory_pr_resource.v0.1",
      resourceCount: 0,
      rawSource: "",
      sections: [],
    });
    writeResource(join(memory, "resources", "issues.md"), {
      schema: "repo_memory_issue_resource.v0.1",
      resourceCount: 0,
      rawSource: "",
      sections: [],
    });
    writeJson(join(memory, "raw", "git-commits.json"), []);

    const result = spawnSync("python3", [validateScript, memory, "--pretty"], {
      cwd: packageRoot,
      encoding: "utf8",
    });

    assert.notEqual(result.status, 0);
    const report = JSON.parse(result.stdout);
    assert.ok(report.errors.some((error) => /resources\/commits\.md.*frontmatter field 'source' is missing/.test(error)));
    assert.ok(report.errors.some((error) => /resources\/commits\.md.*frontmatter field 'trust_state' is missing/.test(error)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repo-memory validator rejects empty provider raw sources unless marked unavailable", () => {
  const root = mkdtempSync(join(tmpdir(), "memorax-code-repo-memory-validate-empty-provider-source."));
  try {
    const { memory } = makeMemoryRoot(root);
    writeFileSync(
      join(memory, "PROFILE.md"),
      `---
schema: "repo_memory_profile.v0.2"
layout: "wiki_landing_page.v0.1"
---

# Test Repo Wiki
`,
    );
    writeResource(join(memory, "resources", "commits.md"), {
      schema: "repo_memory_commit_resource.v0.1",
      resourceCount: 0,
      rawSource: "../raw/git-commits.json",
      sections: [],
    });
    writeResource(join(memory, "resources", "prs.md"), {
      schema: "repo_memory_pr_resource.v0.1",
      resourceCount: 0,
      rawSource: "",
      source: "github_resource_facets",
      sections: [],
    });
    writeResource(join(memory, "resources", "issues.md"), {
      schema: "repo_memory_issue_resource.v0.1",
      resourceCount: 0,
      rawSource: "",
      source: "provider_skipped_local_only",
      sections: [],
    });
    writeJson(join(memory, "raw", "git-commits.json"), []);

    const result = spawnSync("python3", [validateScript, memory, "--pretty"], {
      cwd: packageRoot,
      encoding: "utf8",
    });

    assert.notEqual(result.status, 0);
    const report = JSON.parse(result.stdout);
    assert.ok(report.errors.some((error) => /resources\/prs\.md.*empty raw_source.*unavailable source/.test(error)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});





test("repo-memory validator rejects empty commit raw sources unless history is disabled", () => {
  const root = mkdtempSync(join(tmpdir(), "memorax-code-repo-memory-validate-empty-commit-source."));
  try {
    const { memory } = makeMemoryRoot(root);
    writeFileSync(
      join(memory, "PROFILE.md"),
      `---
schema: "repo_memory_profile.v0.2"
layout: "wiki_landing_page.v0.1"
---

# Test Repo Wiki
`,
    );
    writeResource(join(memory, "resources", "commits.md"), {
      schema: "repo_memory_commit_resource.v0.1",
      resourceCount: 0,
      rawSource: "",
      source: "git_commit_facets",
      sections: [],
    });
    writeResource(join(memory, "resources", "prs.md"), {
      schema: "repo_memory_pr_resource.v0.1",
      resourceCount: 0,
      rawSource: "",
      source: "history_disabled",
      trustState: "disabled_by_policy",
      sections: [],
    });
    writeResource(join(memory, "resources", "issues.md"), {
      schema: "repo_memory_issue_resource.v0.1",
      resourceCount: 0,
      rawSource: "",
      source: "history_disabled",
      trustState: "disabled_by_policy",
      sections: [],
    });
    writeJson(join(memory, "raw", "git-commits.json"), []);

    const result = spawnSync("python3", [validateScript, memory, "--pretty"], {
      cwd: packageRoot,
      encoding: "utf8",
    });

    assert.notEqual(result.status, 0);
    const report = JSON.parse(result.stdout);
    assert.ok(report.errors.some((error) => /resources\/commits\.md.*empty raw_source.*disabled or unavailable source/.test(error)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repo-memory validator accepts disabled historical resource files", () => {
  const root = mkdtempSync(join(tmpdir(), "memorax-code-repo-memory-validate-history-disabled."));
  try {
    const { repo, memory } = makeMemoryRoot(root);
    writeFileSync(
      join(memory, "PROFILE.md"),
      `---
schema: "repo_memory_profile.v0.2"
layout: "wiki_landing_page.v0.1"
---

# Test Repo Wiki
`,
    );
    writeResource(join(memory, "resources", "commits.md"), {
      schema: "repo_memory_commit_resource.v0.1",
      resourceCount: 0,
      rawSource: "",
      source: "history_disabled",
      trustState: "disabled_by_policy",
      sections: [],
    });
    writeResource(join(memory, "resources", "prs.md"), {
      schema: "repo_memory_pr_resource.v0.1",
      resourceCount: 0,
      rawSource: "",
      source: "history_disabled",
      trustState: "disabled_by_policy",
      sections: [],
    });
    writeResource(join(memory, "resources", "issues.md"), {
      schema: "repo_memory_issue_resource.v0.1",
      resourceCount: 0,
      rawSource: "",
      source: "history_disabled",
      trustState: "disabled_by_policy",
      sections: [],
    });
    writeJson(join(memory, "raw", "git-commits.json"), []);

    const result = spawnSync("python3", [validateScript, repo, "--pretty"], {
      cwd: packageRoot,
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.deepEqual(report.errors, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repo-memory validator rejects fabricated provider resources without provider raw evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "memorax-code-repo-memory-validate-fabricated-provider."));
  try {
    const { memory } = makeMemoryRoot(root);
    writeFileSync(
      join(memory, "PROFILE.md"),
      `---
schema: "repo_memory_profile.v0.2"
layout: "wiki_landing_page.v0.1"
---

# Test Repo Wiki
`,
    );
    writeResource(join(memory, "resources", "commits.md"), {
      schema: "repo_memory_commit_resource.v0.1",
      resourceCount: 0,
      rawSource: "../raw/git-commits.json",
      sections: [],
    });
    writeResource(join(memory, "resources", "prs.md"), {
      schema: "repo_memory_pr_resource.v0.1",
      resourceCount: 1,
      rawSource: "../raw/github-facets.json",
      sections: ["PR/MR #1: fabricated"],
    });
    writeResource(join(memory, "resources", "issues.md"), {
      schema: "repo_memory_issue_resource.v0.1",
      resourceCount: 0,
      rawSource: "",
      sections: [],
    });
    writeJson(join(memory, "raw", "git-commits.json"), []);

    const result = spawnSync("python3", [validateScript, memory, "--pretty"], {
      cwd: packageRoot,
      encoding: "utf8",
    });

    assert.notEqual(result.status, 0);
    const report = JSON.parse(result.stdout);
    assert.ok(report.errors.some((error) => /resources\/prs\.md.*provider raw evidence is missing/.test(error)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repo-memory validator accepts wiki-style conceptual pages with frontmatter", () => {
  const root = mkdtempSync(join(tmpdir(), "memorax-code-repo-memory-validate-wiki."));
  try {
    const { repo, memory } = makeMemoryRoot(root);
    writeFileSync(
      join(memory, "PROFILE.md"),
      `---
schema: "repo_memory_profile.v0.2"
layout: "wiki_landing_page.v0.1"
---

# Test Repo Wiki

## Major Areas

| Area | Page | What It Covers |
|------|------|----------------|
| Architecture | [Architecture](./architecture.md) | Runtime boundaries. |
`,
    );
    writeFileSync(
      join(memory, "architecture.md"),
      `---
schema: "repo_memory_wiki_page.v0.1"
page_type: "architecture"
---

# Architecture

This page routes agents to current source before editing.
`,
    );
    writeResource(join(memory, "resources", "commits.md"), {
      schema: "repo_memory_commit_resource.v0.1",
      resourceCount: 0,
      rawSource: "../raw/git-commits.json",
      sections: [],
    });
    writeResource(join(memory, "resources", "prs.md"), {
      schema: "repo_memory_pr_resource.v0.1",
      resourceCount: 0,
      rawSource: "",
      sections: [],
    });
    writeResource(join(memory, "resources", "issues.md"), {
      schema: "repo_memory_issue_resource.v0.1",
      resourceCount: 0,
      rawSource: "",
      sections: [],
    });
    writeJson(join(memory, "raw", "git-commits.json"), []);

    const result = spawnSync("python3", [validateScript, repo, "--pretty"], {
      cwd: packageRoot,
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.ok(report.checked.includes("architecture.md"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
