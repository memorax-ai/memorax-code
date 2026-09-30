import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { inspectRepoMemoryBundle } from "../../packages/ts/memorax-code-adapter-common/src/repo-memory/repo-memory-job-supervisor.mjs";
import { defaultBranchSnapshot, prepareSharedRepoMemorySnapshot, publishSharedRepoMemorySnapshot, readSharedRepoMemory } from "../../packages/ts/memorax-code-adapter-common/src/repo-memory/repo-memory-shared-bundle.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../packages/ts/memorax-code-codex-adapter");
const readerSkillRoot = join(packageRoot, "skills", "memorax-code");

for (const changedBranch of [false, true]) {
  test(`canonical collector, reader and updater share a mainline bundle from ${changedBranch ? "a divergent" : "the initial"} checkout`, t => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "repo-memory-mainline-reader-")));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const repo = join(root, "repo"), home = join(root, "home"); mkdirSync(repo); mkdirSync(home);
    const git = args => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    git(["init"]); git(["config", "user.name", "Fixture"]); git(["config", "user.email", "fixture@example.invalid"]);
    writeFileSync(join(repo, "source.txt"), "original source\n"); git(["add", "source.txt"]); git(["commit", "-m", "initial"]);
    const head = git(["rev-parse", "HEAD"]);
    git(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk"]);
    git(["update-ref", "refs/remotes/origin/trunk", head]);
    const validator = join(readerSkillRoot, "scripts/repo-memory.mjs");
    const cli = args => JSON.parse(execFileSync(process.execPath, [validator, ...args], { encoding: "utf8", env: { ...process.env, MEMORAX_CODE_HOME: home } }));
    const validate = path => inspectRepoMemoryBundle(path, validator).status === "usable";
    const first = { ...defaultBranchSnapshot(repo), baseHead: null }, candidate = join(root, "build", "source");
    prepareSharedRepoMemorySnapshot({ home, repo, snapshot: first, root: candidate, validate });
    cli(["collect", "--repo-path", candidate, "--snapshot-ref", head, "--history-mode", "none"]);
    const memory = join(candidate, ".repo_memory");
    writeFileSync(join(memory, "PROFILE.md"), `---\nschema: repo_memory_profile.v0.2\nlocal_head: "${head}"\n---\n# Fixture\n`);
    for (const name of ["commits", "prs", "issues"]) writeFileSync(join(memory, "resources", `${name}.md`), `---\nschema: repo_memory_resource.v0.1\nsource: history_disabled\nresource_count: 0\ntrust_state: unavailable\nraw_source: ""\n---\n# ${name}\n`);
    assert.equal(validate(candidate), true);
    assert.equal(publishSharedRepoMemorySnapshot({ home, repo, snapshot: first, root: candidate, validate }), true);
    const baseline = readSharedRepoMemory(home, repo);
    const linked = join(root, "linked"); git(["worktree", "add", "--detach", linked, head]);
    if (changedBranch) {
      writeFileSync(join(linked, "feature.txt"), "branch work\n");
      git(["-C", linked, "add", "feature.txt"]); git(["-C", linked, "commit", "-m", "feature"]);
      writeFileSync(join(linked, "dirty.txt"), "uncommitted\n");
    }
    const read = cli(["resolve", "--repo-path", linked]);
    assert.equal(read.ok, true);
    assert.equal(read.memoryPath, join(baseline.path, ".repo_memory"));
    assert.equal(existsSync(join(linked, ".repo_memory")), false);
    writeFileSync(join(repo, "source.txt"), "mainline update\n"); git(["add", "source.txt"]); git(["commit", "-m", "mainline update"]);
    const target = git(["rev-parse", "HEAD"]); git(["update-ref", "refs/remotes/origin/trunk", target]);
    const update = { ...defaultBranchSnapshot(linked), baseHead: head }, next = join(root, "update", "source");
    prepareSharedRepoMemorySnapshot({ home, repo: linked, snapshot: update, root: next, validate });
    assert.equal(readFileSync(join(next, "source.txt"), "utf8"), "mainline update\n");
    assert.equal(existsSync(join(next, "feature.txt")), false);
    const report = cli(["detect-updates", "--repo-path", next, "--snapshot-ref", target, "--history-mode", "none"]);
    assert.equal(report.current.local_head, target);
    const profile = join(next, ".repo_memory/PROFILE.md");
    writeFileSync(profile, readFileSync(profile, "utf8").replace(head, target));
    assert.equal(publishSharedRepoMemorySnapshot({ home, repo: linked, snapshot: update, root: next, validate }), true);
    assert.equal(cli(["resolve", "--repo-path", linked]).sharedBaseline.head, target);
    assert.equal(readFileSync(join(baseline.path, ".repo_memory/PROFILE.md"), "utf8").includes(head), true);
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
  assert.match(skill, /`up_to_date`/);
  assert.match(skill, /`active_job`/);
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
  assert.match(skill, /validates the shared bundle and evaluates the configured update policy/);
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

test("shared reader resolves an immutable path and verifies branch changes without blanket rejection", () => {
  const read = readFileSync(join(readerSkillRoot, "references/repo-read.md"), "utf8");
  assert.match(read, /resolve --repo-path/);
  assert.match(read, /memoryPath/);
  assert.match(read, /All branches, detached checkouts, and linked worktrees/);
  assert.match(read, /Hold this immutable version/);
  assert.match(read, /uncommitted changes/);
  assert.doesNotMatch(read, /shared-baseline\.json|sharedBaseline\.changes|refreshed: true/);
});

test("shared authoring references require the fixed mainline snapshot and canonical validation", () => {
  const build = readFileSync(join(readerSkillRoot, "references/repo-build.md"), "utf8");
  const update = readFileSync(join(readerSkillRoot, "references/repo-update.md"), "utf8");
  assert.match(build, /private Git snapshot/);
  assert.match(build, /ordinary collector and Wiki output contract stay/);
  assert.match(update, /isolated source repository at a fixed/);
  assert.match(update, /required even when history is disabled/);
  assert.match(update, /supervisor owns version publication/);
  assert.doesNotMatch(update, /borrowed record|shared-baseline\.json/);
});
