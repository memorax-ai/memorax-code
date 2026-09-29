import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { inspectRepoMemoryBundle, runRepoMemoryJob } from "../../packages/ts/memorax-code-adapter-common/src/repo-memory/repo-memory-job-supervisor.mjs";
import { defaultBranchSnapshot, prepareSharedRepoMemoryUpdate, publishSharedRepoMemoryUpdate, readSharedRepoMemory } from "../../packages/ts/memorax-code-adapter-common/src/repo-memory/repo-memory-shared-bundle.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../packages/ts/memorax-code-codex-adapter");
const readerSkillRoot = join(packageRoot, "skills", "memorax-code");

for (const ancestor of [false, true]) {
  test(`${ancestor ? "ancestor" : "same-commit"} worktrees reuse a full bundle through the canonical Skill validator without a runner`, (t) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "repo-memory-shared-reader-")));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const repo = join(root, "repo"), linked = join(root, "linked");
    mkdirSync(repo);
    const git = (args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    git(["init"]); git(["config", "user.name", "Repo Memory Test"]); git(["config", "user.email", "repo-memory@example.invalid"]);
    writeFileSync(join(repo, "README.md"), "# Fixture\n");
    git(["add", "README.md"]); git(["commit", "-m", "initial"]);
    writeFileSync(join(repo, "feature.txt"), "initial feature\n");
    git(["add", "feature.txt"]); git(["commit", "-m", "fixture source"]);
    const head = git(["rev-parse", "HEAD"]);
    git(["worktree", "add", "--detach", linked, head]);
    const memory = join(repo, ".repo_memory");
    mkdirSync(join(memory, "resources"), { recursive: true });
    mkdirSync(join(memory, "raw"));
    writeFileSync(join(memory, "PROFILE.md"), `---\nschema: repo_memory_profile.v0.2\nlocal_head: "${head}"\n---\n# Fixture\n`);
    for (const name of ["commits", "prs", "issues"]) {
      writeFileSync(join(memory, "resources", `${name}.md`), `---\nschema: repo_memory_resource.v0.1\nsource: history_disabled\nresource_count: 0\ntrust_state: unavailable\nraw_source: ""\n---\n# ${name}\n`);
    }
    writeFileSync(join(memory, "raw/git-commits.json"), "{}\n");
    const runtime = {
      runner: "fixture", memoraxCodeHome: join(root, "home"),
      validatorPath: join(readerSkillRoot, "scripts/repo-memory.mjs"),
      evaluateRepository: () => ({ trigger: false }),
      createCommand: () => { assert.fail("shared reuse must not create an Agent command"); },
    };
    assert.equal(runRepoMemoryJob(["maintain", "--repo", repo], runtime).reason, "up_to_date");
    if (ancestor) {
      writeFileSync(join(linked, "feature.txt"), "changed feature\n");
      git(["-C", linked, "add", "feature.txt"]); git(["-C", linked, "commit", "-m", "feature"]);
    }
    const result = runRepoMemoryJob(["maintain", "--repo", linked], runtime);
    assert.equal(result.reason, ancestor ? "shared_bundle_borrowed" : "shared_bundle_reused");
    assert.equal(result.job, undefined);
    assert.equal(readFileSync(join(linked, ".repo_memory/PROFILE.md"), "utf8"), readFileSync(join(memory, "PROFILE.md"), "utf8"));
    assert.equal(readFileSync(join(linked, ".repo_memory/resources/commits.md"), "utf8"), readFileSync(join(memory, "resources/commits.md"), "utf8"));
    const later = runRepoMemoryJob(["maintain", "--repo", linked, "--now", "2099-01-01T00:00:00Z"], {
      ...runtime, evaluateRepository: () => assert.fail("borrowed maps must not evaluate update policy"),
    });
    assert.equal(later.reason, "shared_baseline_in_use");

    // Exercise the actual detector and validator with memory outside the Git tree.
    git(["-C", linked, "switch", "-c", "shared-trunk"]);
    writeFileSync(join(linked, "candidate.txt"), "candidate change\n");
    git(["-C", linked, "add", "candidate.txt"]); git(["-C", linked, "commit", "-m", "default change"]);
    const target = git(["-C", linked, "rev-parse", "HEAD"]);
    git(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/shared-trunk"]);
    git(["update-ref", "refs/remotes/origin/shared-trunk", target]);
    const update = { ...defaultBranchSnapshot(linked), baseHead: head }, candidate = join(root, "candidate");
    const validate = path => inspectRepoMemoryBundle(path, runtime.validatorPath).status === "usable";
    prepareSharedRepoMemoryUpdate({ home: runtime.memoraxCodeHome, repo: linked, update, root: candidate, validate });
    const report = JSON.parse(execFileSync(process.execPath, [runtime.validatorPath, "detect-updates", "--repo-path", linked,
      "--memory-path", join(candidate, ".repo_memory"), "--snapshot-ref", target, "--history-mode", "local-only"], { encoding: "utf8" }));
    assert.equal(report.baseline.local_commit_sha, head);
    assert.equal(report.current.local_head, target);
    assert.equal(report.memory_path, realpathSync(join(candidate, ".repo_memory")));
    const profile = join(candidate, ".repo_memory/PROFILE.md");
    writeFileSync(profile, readFileSync(profile, "utf8").replace(head, target));
    assert.equal(publishSharedRepoMemoryUpdate({ home: runtime.memoraxCodeHome, repo: linked, update, root: candidate, validate }), true);
    assert.equal(readSharedRepoMemory(runtime.memoraxCodeHome, linked).head, target);
    assert.equal(readFileSync(join(linked, ".repo_memory/PROFILE.md"), "utf8"), readFileSync(join(memory, "PROFILE.md"), "utf8"));
  });
}

test("memorax-code repo-read reference enforces retrieval budget and stop rules", () => {
  const skill = readFileSync(join(readerSkillRoot, "references", "repo-read.md"), "utf8");

  assert.match(skill, /## Retrieval Budget/);
  assert.match(skill, /Read `PROFILE\.md` at most once/);
  assert.match(skill, /at most 2 combined `rg` commands/);
  assert.match(skill, /Stop repo-memory retrieval as soon as the hits are sufficient/);
  assert.match(skill, /Do NOT open these unless the user explicitly asks/);
  assert.match(skill, /\.repo_memory\/raw\/\*\.json/);
  assert.match(skill, /`docs\/`, `packages\/`, `tests\/`, or other live source directories/);
  assert.match(skill, /Do not read repo memory again after `maintain` returns/);
  assert.match(skill, /Current implementation claims and code edits still require live-code verification/);
});

test("memorax-code repo-read reference silently schedules supervised maintenance only when needed", () => {
  const skill = readFileSync(join(readerSkillRoot, "references", "repo-read.md"), "utf8");

  assert.match(skill, /broad repo introduction/);
  assert.match(skill, /history, architecture background, cross-module routing, PR\/issue context/);
  assert.match(skill, /Skip this reference for narrow tasks with a clear live-code target/);
  assert.match(skill, /## Single Maintenance Handoff/);
  assert.match(skill, /repo-memory-job\.mjs' maintain --repo/);
  assert.match(skill, /Prefer the Repo Memory maintenance helper supplied by the current client's\s+native session context/);
  assert.match(skill, /even when this Skill was imported from another client/);
  assert.match(skill, /Only when no current-session helper was supplied, use the packaged helper/);
  assert.match(skill, /current-session helper is missing or fails, skip maintenance; never fall back to\s+the Skill-relative helper or another client's runner/);
  assert.match(skill, /`bundle_missing`/);
  assert.match(skill, /`bundle_invalid`/);
  assert.match(skill, /`up_to_date`/);
  assert.match(skill, /`active_job`/);
  assert.match(skill, /`shared_bundle_reused` restores a validated copy at the exact same/);
  assert.match(skill, /do not invoke maintenance a second time/);
  assert.match(skill, /do not launch a build to compensate/);
  assert.match(skill, /Do not wait, poll, retry, or expose/);
  assert.match(skill, /Never replace the packaged helper with a generic subagent/);
  assert.match(skill, /helper returns `job\.delegation`/);
  assert.match(skill, /Cursor native background subagent through the Task tool/);
  assert.match(skill, /claim the\nprovided ticket before authoring and finalize through the helper/);
  assert.match(skill, /Never invent a delegation when the helper returned `active_job` or `up_to_date`/);
});

test("memorax-code repo-read delegates deterministic maintenance decisions only on relevant demand", () => {
  const skill = readFileSync(join(readerSkillRoot, "references", "repo-read.md"), "utf8");

  assert.match(skill, /Only a relevant `repo-read` invokes `maintain`/);
  assert.match(skill, /Commit arrival, PR merge, and elapsed time alone do not invoke it/);
  assert.match(skill, /validates the generated bundle, evaluates the configured local update policy/);
  assert.match(skill, /provider network access/);
  assert.match(skill, /`adaptive\(5 commits OR 24 hours\)`/);
  assert.match(skill, /missing or non-ancestor baseline/);
});

test("memorax-code repo-read makes maintain the immediate post-read handoff", () => {
  const skill = readFileSync(join(readerSkillRoot, "references", "repo-read.md"), "utf8");

  assert.match(skill, /After the final repo-memory read, run `maintain` as the very next tool action/);
  assert.match(skill, /Do not run it in parallel with a repo-memory read/);
  assert.match(skill, /Do not inspect live code, maintained documentation, Git evidence, run unrelated tools, or answer between them/);
  assert.match(skill, /If no repo-memory read was possible, run it immediately after detecting that state/);
  assert.match(skill, /The same handoff applies when hits already answer the question or the retrieval budget is exhausted/);
});


test("memorax-code repo-read follows wiki-style progressive reading", () => {
  const skill = readFileSync(join(readerSkillRoot, "references", "repo-read.md"), "utf8");

  assert.match(skill, /wiki-style repo memory/);
  assert.match(skill, /PROFILE\.md` as the wiki landing page/);
  assert.match(skill, /Major Areas/);
  assert.match(skill, /Supporting Pages/);
  assert.match(skill, /Open at most 2-4 relevant conceptual pages/);
  assert.match(skill, /canonical homes/);
  assert.match(skill, /Do not assume fixed page names/);
  assert.match(skill, /\.repo_memory\/\*\.md/);
  assert.match(skill, /resources\/\*\.md for historical routing cards/);
});

test("memorax-code repo-read treats disabled history resources as collection state", () => {
  const skill = readFileSync(join(readerSkillRoot, "references", "repo-read.md"), "utf8");

  assert.match(skill, /Disabled and unavailable historical resource files/);
  assert.match(skill, /source: "history_disabled"/);
  assert.match(skill, /source: "provider_skipped_local_only"/);
  assert.match(skill, /source: "provider_unavailable"/);
  assert.match(skill, /collection state, not repository state/);
  assert.match(skill, /do not conclude that there are no commits, PRs, MRs, or issues/);
  assert.match(skill, /Ask whether to rebuild with provider history/);
});

test("borrowed-map guidance requires delta verification and keeps automatic authoring disabled", () => {
  const read = readFileSync(join(readerSkillRoot, "references/repo-read.md"), "utf8");
  assert.match(read, /shared_baseline_in_use/);
  assert.match(read, /sharedBaseline\.changes/);
  assert.match(read, /active job, unavailable helper, or failed check is not that confirmation/);
  assert.match(read, /bounded delta does not\s+prove semantic compatibility/);
  assert.match(read, /Do not author a\s+branch-specific map/);
  for (const operation of ["build", "update"]) {
    const reference = readFileSync(join(readerSkillRoot, `references/repo-${operation}.md`), "utf8");
    assert.match(reference, /explicitly requested/);
    assert.match(reference, /shared-baseline\.json/);
    assert.match(reference, /passes validation/);
  }
});

test("shared default-branch guidance isolates candidate authoring and discards pre-refresh hits", () => {
  const read = readFileSync(join(readerSkillRoot, "references/repo-read.md"), "utf8");
  const update = readFileSync(join(readerSkillRoot, "references/repo-update.md"), "utf8");
  assert.match(read, /local target of `origin\/HEAD`/);
  assert.match(read, /`refreshed: true` after a read, discard those earlier hits/);
  assert.match(read, /Locally authored bundles keep their update policy/);
  assert.match(update, /--memory-path <candidate-memory>/);
  assert.match(update, /--snapshot-ref <snapshot-sha>/);
  assert.match(update, /required even when history is disabled/);
  assert.match(update, /supervisor owns version publication/);
  assert.match(update, /Do not clear the source worktree's borrowed record/);
});
