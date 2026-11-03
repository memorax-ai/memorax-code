import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collectCandidate, compareStable, decideRelease, npmPublication, PACKAGE_NAME, readAttempts, REQUIRED_JOBS, runCli } from "./release-acceptance.mjs";

const skip = process.platform === "win32";
const temporary = (t, prefix) => {
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
};
const git = (root, ...args) => {
  const result = spawnSync("git", ["-c", "user.name=CI", "-c", "user.email=ci@example.invalid", "-c", "commit.gpgsign=false",
    "-c", "tag.gpgsign=false", ...args], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
const registry = (document, status = 200) => async () => ({ status, json: async () => document });
// A registry document whose stable history is the listed versions, with latest on the newest unless given.
const published = (versions, latest = versions.at(-1)) => registry({ versions: Object.fromEntries(versions.map((item) => [item, {}])),
  time: Object.fromEntries(versions.map((item) => [item, "2026-10-01"])), "dist-tags": latest ? { latest } : {} });

function writeRelease(root, version, changelogVersions) {
  mkdirSync(join(root, "packages/npm/memorax-code"), { recursive: true });
  writeFileSync(join(root, "packages/npm/memorax-code/package.json"), JSON.stringify({ name: PACKAGE_NAME, version }));
  writeFileSync(join(root, "CHANGELOG.md"), `# Changelog\n\n## Unreleased\n\n${changelogVersions.map((item) => `## [${item}] - 2026-10-20\n`).join("\n")}`);
}

// A repository whose first commit is the v0.1.19 release and whose HEAD prepares 0.1.20 after two merged pull requests.
function releaseRepository(t, { tagPrevious = true } = {}) {
  const root = temporary(t, "release-candidate-");
  git(root, "init", "-q", "-b", "main");
  writeRelease(root, "0.1.19", ["0.1.19"]);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "chore:(release) prepare 0.1.19");
  const previous = git(root, "rev-parse", "HEAD");
  if (tagPrevious) git(root, "tag", "v0.1.19");
  writeFileSync(join(root, "notes.txt"), "change\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "Merge pull request #301 from memorax-ai/feature");
  writeRelease(root, "0.1.20", ["0.1.20", "0.1.19"]);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "Merge pull request #302 from memorax-ai/release");
  return { root, previous, head: git(root, "rev-parse", "HEAD"), parent: git(root, "rev-parse", "HEAD^1") };
}

const candidate = (root, sha, options = {}) => collectCandidate({ root, sha, ref: "refs/heads/main", checkVersions: () => true,
  fetchImpl: published(["0.1.18", "0.1.19"]), ...options });

test("a main candidate with an unpublished, consistent and documented version is releasable", { skip }, async (t) => {
  const repo = releaseRepository(t);
  const record = await candidate(repo.root, repo.head);
  assert.deepEqual(record.eligibility, { status: "RELEASABLE", reasons: [], unconfirmed: [] });
  assert.equal(record.candidateSha, repo.head);
  assert.equal(record.testScriptsSha, repo.head);
  assert.deepEqual(record.package, { name: PACKAGE_NAME, version: "0.1.20" });
  assert.deepEqual(record.previousRelease, { tag: "v0.1.19", sha: repo.previous, version: "0.1.19" });
  assert.deepEqual(record.range, { from: "v0.1.19", commits: 2, pullRequests: [302, 301] });
  assert.deepEqual(record.docsBase, { sha: repo.previous, source: "previous-release" });
  assert.deepEqual(record.npm, { status: "NOT_PUBLISHED", latest: "0.1.19", stableVersions: ["0.1.18", "0.1.19"] });
  assert.deepEqual(record.notes, []);
});

test("eligibility problems are recorded as reasons, never thrown", { skip }, async (t) => {
  const repo = releaseRepository(t);
  for (const [options, reason] of [
    [{ ref: "refs/heads/chore/ci-release-acceptance" }, "REF_NOT_MAIN"],
    [{ expectedSha: "a".repeat(40) }, "CANDIDATE_SHA_MISMATCH"],
    [{ expectedSha: "main" }, "EXPECTED_SHA_INVALID"],
    [{ checkVersions: () => false }, "VERSION_INCONSISTENT"],
    [{ fetchImpl: published(["0.1.19", "0.1.20"]) }, "VERSION_ALREADY_PUBLISHED"],
    [{ fetchImpl: registry({ versions: { "0.1.19": {} }, time: { "0.1.19": "2026-10-01", "0.1.20": "2026-10-20" }, "dist-tags": { latest: "0.1.19" } }) },
      "VERSION_PREVIOUSLY_PUBLISHED"],
  ]) {
    const record = await candidate(repo.root, repo.head, options);
    assert.equal(record.eligibility.status, "NOT_RELEASABLE", reason);
    assert.deepEqual(record.eligibility.reasons, [reason]);
  }
  assert.equal((await candidate(repo.root, repo.head, { expectedSha: repo.head.toUpperCase() })).eligibility.status, "RELEASABLE");
});

test("only stable versions are releasable; a prerelease or build version is refused, never compared", { skip }, async (t) => {
  // The comparison itself refuses anything but MAJOR.MINOR.PATCH, so rc.1, rc.2 and the release can never compare equal.
  for (const value of ["0.1.20-rc.1", "0.1.20-rc.2", "0.1.20+build.7"]) {
    assert.throws(() => compareStable(value, "0.1.20"), /VERSION_NOT_STABLE/, value);
    assert.throws(() => compareStable("0.1.20", value), /VERSION_NOT_STABLE/, value);
  }
  assert.deepEqual([compareStable("0.1.10", "0.1.9"), compareStable("0.1.9", "0.1.10"), compareStable("1.0.0", "1.0.0")], [1, -1, 0]);
  const repo = releaseRepository(t);
  for (const version of ["0.1.20-rc.1", "0.1.20-rc.2", "0.1.20+build.7"]) {
    writeRelease(repo.root, version, [version, "0.1.19"]);
    const record = await candidate(repo.root, repo.head, { fetchImpl: published(["0.1.19"]) });
    assert.deepEqual(record.eligibility, { status: "NOT_RELEASABLE", reasons: ["PRERELEASE_NOT_SUPPORTED"], unconfirmed: [] }, version);
  }
  for (const version of ["0.1", "01.2.3", "v0.1.20"]) {
    writeRelease(repo.root, version, [version]);
    assert.ok((await candidate(repo.root, repo.head)).eligibility.reasons.includes("PACKAGE_IDENTITY_INVALID"), version);
  }
  git(repo.root, "checkout", "-q", "--", ".");
  // A prerelease tag is not a previous release, even when it sorts after the stable one.
  git(repo.root, "tag", "v0.1.20-rc.1", repo.parent);
  const stable = await candidate(repo.root, repo.head);
  assert.equal(stable.previousRelease.tag, "v0.1.19");
  assert.equal(stable.eligibility.status, "RELEASABLE");
  // Stable tags compare numerically, not as text.
  git(repo.root, "tag", "v0.1.9", repo.previous);
  assert.equal((await candidate(repo.root, repo.head)).previousRelease.tag, "v0.1.19");
});

test("npm's stable history must agree with the candidate's release history before it can become latest", { skip }, async (t) => {
  const repo = releaseRepository(t);
  for (const [label, fetchImpl, reasons] of [
    // Another release already moved latest past this candidate.
    ["newer release on npm", published(["0.1.19", "0.1.21"]), ["NPM_NEWER_VERSION_PUBLISHED", "NPM_HISTORY_MISMATCH"]],
    ["tagged release never published", published(["0.1.17", "0.1.18"]), ["NPM_HISTORY_MISMATCH"]],
    ["latest moved backwards", published(["0.1.18", "0.1.19"], "0.1.18"), ["NPM_LATEST_NOT_NEWEST"]],
    ["latest missing", published(["0.1.18", "0.1.19"], null), ["NPM_LATEST_NOT_NEWEST"]],
    ["latest on a prerelease", registry({ versions: { "0.1.19": {}, "0.1.21-rc.1": {} }, "dist-tags": { latest: "0.1.21-rc.1" } }), ["NPM_LATEST_NOT_NEWEST"]],
    ["package not on npm", registry(null, 404), ["NPM_HISTORY_MISMATCH"]],
    ["prereleases ignored", registry({ versions: { "0.1.19": {}, "0.1.22-rc.1": {} }, "dist-tags": { latest: "0.1.19", preview: "0.1.22-rc.1" } }), []],
  ]) {
    const record = await candidate(repo.root, repo.head, { fetchImpl });
    assert.deepEqual(record.eligibility.reasons, reasons, label);
    assert.equal(record.eligibility.status, reasons.length ? "NOT_RELEASABLE" : "RELEASABLE", label);
  }
  // npm released 0.1.20 from another branch: the candidate's history ends at v0.1.19, so 0.1.21 would skip that release.
  writeRelease(repo.root, "0.1.21", ["0.1.21", "0.1.19"]);
  const skipped = await candidate(repo.root, repo.head, { fetchImpl: published(["0.1.19", "0.1.20"]) });
  assert.deepEqual(skipped.eligibility.reasons, ["NPM_HISTORY_MISMATCH"]);
  git(repo.root, "checkout", "-q", "--", ".");

  const untagged = releaseRepository(t, { tagPrevious: false });
  assert.deepEqual((await candidate(untagged.root, untagged.head, { fetchImpl: registry(null, 404) })).eligibility,
    { status: "RELEASABLE", reasons: [], unconfirmed: [] });
  assert.deepEqual((await candidate(untagged.root, untagged.head)).eligibility.reasons, ["NPM_HISTORY_MISMATCH"]);
});

test("an npm query that fails or cannot be read leaves eligibility unconfirmed, not unpublished", { skip }, async (t) => {
  const repo = releaseRepository(t);
  const invalid = async () => ({ status: 200, json: async () => { throw new SyntaxError("Unexpected token"); } });
  for (const [fetchImpl, reason] of [
    [registry({}, 500), "NPM_QUERY_FAILED"], [registry({}, 429), "NPM_QUERY_FAILED"],
    [async () => { throw new TypeError("fetch failed"); }, "NPM_QUERY_FAILED"],
    [invalid, "NPM_RESPONSE_INVALID"], [registry({ versions: null }), "NPM_RESPONSE_INVALID"],
  ]) {
    const record = await candidate(repo.root, repo.head, { fetchImpl });
    assert.equal(record.npm.status, "UNCONFIRMED");
    assert.deepEqual(record.eligibility, { status: "UNCONFIRMED", reasons: [], unconfirmed: [reason] });
  }
  const offMain = await candidate(repo.root, repo.head, { ref: "refs/heads/feature", fetchImpl: registry({}, 503) });
  assert.deepEqual(offMain.eligibility, { status: "NOT_RELEASABLE", reasons: ["REF_NOT_MAIN"], unconfirmed: ["NPM_QUERY_FAILED"] });
  assert.equal((await npmPublication("0.1.20", { fetchImpl: registry({}, 500) })).status, "UNCONFIRMED");
});

test("git history decides tags, the previous release and the documentation base", { skip }, async (t) => {
  const repo = releaseRepository(t);
  writeRelease(repo.root, "0.1.20", ["0.1.19"]);
  assert.deepEqual((await candidate(repo.root, repo.head)).eligibility.reasons, ["CHANGELOG_ENTRY_MISSING"]);
  git(repo.root, "checkout", "-q", "--", ".");
  git(repo.root, "tag", "v0.1.20");
  assert.deepEqual((await candidate(repo.root, repo.head)).eligibility.reasons, ["TAG_EXISTS"]);
  git(repo.root, "tag", "-d", "v0.1.20");
  git(repo.root, "tag", "v0.1.21", repo.previous);
  const history = published(["0.1.19", "0.1.21"]);
  const notIncreased = await candidate(repo.root, repo.head, { fetchImpl: history });
  assert.deepEqual(notIncreased.eligibility.reasons, ["VERSION_NOT_INCREASED", "NPM_NEWER_VERSION_PUBLISHED"]);
  assert.equal(notIncreased.previousRelease.tag, "v0.1.21");
  assert.deepEqual((await candidate(repo.root, repo.previous, { fetchImpl: history })).eligibility.reasons,
    ["CHECKOUT_MISMATCH", "VERSION_NOT_INCREASED", "NPM_NEWER_VERSION_PUBLISHED"]);

  const untagged = releaseRepository(t, { tagPrevious: false });
  const record = await candidate(untagged.root, untagged.head, { fetchImpl: registry(null, 404) });
  assert.equal(record.eligibility.status, "RELEASABLE");
  assert.equal(record.previousRelease, null);
  assert.deepEqual(record.notes, ["PREVIOUS_RELEASE_NOT_FOUND"]);
  assert.deepEqual(record.docsBase, { sha: untagged.parent, source: "first-parent" });
  const broken = await candidate(untagged.root, untagged.head, { runGit: () => { throw new Error("spawn git ENOENT"); } });
  assert.deepEqual(broken.eligibility, { status: "UNCONFIRMED", reasons: [], unconfirmed: ["GIT_QUERY_FAILED"] });
});

const SHA = "c".repeat(40);
const ENV = { GITHUB_SHA: SHA, GITHUB_RUN_ID: "999", GITHUB_RUN_ATTEMPT: "1", GITHUB_REPOSITORY: "memorax-ai/memorax-code", GITHUB_SERVER_URL: "https://github.com" };
const LINUX_URL = "https://download.codebuddy.cn/workbuddy/linux-x64-deb/WorkBuddy-linux-x64-deb-5.5.6.38337834-1.deb";
const WINDOWS_URL = "https://download.codebuddy.cn/workbuddy/win32-x64-user/WorkBuddy-win32-x64-user-5.6.2.39298511-2.exe";
const WORKBUDDY_ROWS = [
  { os: "ubuntu-24.04", arch: "x64", node: "24", release: { platform: "linux-x64-deb", channel: "baseline+latest", desktopVersion: "5.5.6.38337834",
    productVersion: "5.5.6", runtimeVersion: "2.137.1", sha256: "a".repeat(64), url: LINUX_URL } },
  { os: "windows-2025", arch: "x64", node: "24", release: { platform: "win32-x64-user", channel: "fallback", desktopVersion: "5.6.2.39298511",
    productVersion: "5.6.2", runtimeVersion: null, sha256: "b".repeat(64), url: WINDOWS_URL } },
];
const jobName = (row) => `WorkBuddy native (${row.os}, Node ${row.node}, ${row.release.channel}, ${row.release.desktopVersion})`;
// The package job records upload-artifact's bare digest; the REST API reports the same digest with a sha256: prefix.
const PACKAGE_DIGEST = "d".repeat(64);

// What a WorkBuddy cell writes for the release record, here for the given row, attempt and actual download hash.
const workbuddyReport = (row, { attempt = 1, runtimeVersion = row.release.runtimeVersion ?? "2.147.0", actual = row.release.sha256 } = {}) => ({
  schemaVersion: 2, runId: "999", runAttempt: attempt, os: row.os, node: row.node, channel: row.release.channel,
  desktopVersion: row.release.desktopVersion, runtimeVersion, arch: row.arch, source: new URL(row.release.url).host,
  sha256: { reference: row.release.sha256, actual, status: actual === row.release.sha256 ? "match" : "warning" } });

// An attempt's complete job listing; jobs carried from an earlier attempt keep their start time and runner.
function listing(attempt, jobs) {
  return { attempt, status: "COMPLETE", jobs: jobs.map((job, index) => ({ id: attempt * 1000 + index, run_id: 999, run_attempt: attempt,
    conclusion: "success", ...job })) };
}
const ranAt = (minute, runner) => ({ started_at: `2026-10-19T03:${String(minute).padStart(2, "0")}:00Z`, runner_id: runner });
const firstAttempt = () => listing(1, [{ name: "package", ...ranAt(0, 1) }, ...WORKBUDDY_ROWS.map((row, index) => ({ name: jobName(row), ...ranAt(5, 10 + index) }))]);

function writeReport(reports, row, attempt, report = workbuddyReport(row, { attempt })) {
  const directory = join(reports, `workbuddy-report-${row.os}-${row.release.channel}-node-${row.node}-attempt${attempt}`);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "report.json"), typeof report === "string" ? report : JSON.stringify(report));
}

// One downloaded candidate package plus the run outputs, artifact record, attempt listings and WorkBuddy reports for a
// passing run.
function acceptedRun(t, { version = "0.1.20", eligibility = { status: "RELEASABLE", reasons: [], unconfirmed: [] } } = {}) {
  const root = temporary(t, "release-record-");
  const staging = join(root, "staging", "package");
  mkdirSync(staging, { recursive: true });
  writeFileSync(join(staging, "package.json"), JSON.stringify({ name: PACKAGE_NAME, version }));
  const packageDir = join(root, "download");
  mkdirSync(join(packageDir, "memorax-code-package-attempt1"), { recursive: true });
  const tgz = join(packageDir, "memorax-code-package-attempt1", "memorax-memorax-code-0.1.20.tgz");
  assert.equal(spawnSync("tar", ["-czf", tgz, "-C", join(root, "staging"), "package"]).status, 0);
  const sha256 = createHash("sha256").update(readFileSync(tgz)).digest("hex");
  const reports = join(root, "reports");
  for (const row of WORKBUDDY_ROWS) writeReport(reports, row, 1);
  const matrix = (key, value) => JSON.stringify({ include: [{ os: "ubuntu-24.04", node: "24", channel: "baseline", [key]: value }] });
  const needs = Object.fromEntries(REQUIRED_JOBS.map((id) => [id, { result: "success", outputs: {} }]));
  needs.candidate.outputs.record = JSON.stringify({ schemaVersion: 1, candidateSha: SHA, testScriptsSha: SHA, ref: "refs/heads/main",
    expectedSha: null, package: { name: PACKAGE_NAME, version: "0.1.20" }, previousRelease: { tag: "v0.1.19", sha: "b".repeat(40), version: "0.1.19" },
    range: { from: "v0.1.19", commits: 2, pullRequests: [302, 301] }, npm: { status: "NOT_PUBLISHED", latest: "0.1.19", stableVersions: ["0.1.19"] },
    docsBase: { sha: "b".repeat(40), source: "previous-release" }, eligibility, notes: [] });
  Object.assign(needs.package.outputs, { "package-artifact-name": "memorax-code-package-attempt1", "package-artifact-id": "123",
    "package-artifact-digest": PACKAGE_DIGEST, "package-sha256": sha256, "codex-matrix": matrix("codex", "0.147.0"),
    "opencode-matrix": matrix("opencode", "1.18.18"), "claude-matrix": matrix("claude", "2.1.277"),
    "codebuddy-matrix": matrix("codebuddy", "2.159.0"), "cursor-matrix": matrix("cursor", "3.21.18") });
  needs["workbuddy-releases"].outputs = { matrix: JSON.stringify({ include: WORKBUDDY_ROWS }),
    coverage: "Coverage degraded: Windows latest not tested; selected 5.6.2.39298511." };
  const artifact = { id: 123, name: "memorax-code-package-attempt1", digest: `sha256:${PACKAGE_DIGEST}`, expired: false, workflow_run: { id: 999 } };
  const attempts = [firstAttempt()];
  return { root, packageDir, reports, needs, artifact, sha256, attempts,
    decide: (overrides = {}) => decideRelease({ needs, packageDir, workbuddyReportsDir: reports, artifact, attempts, env: ENV, ...overrides }) };
}

test("a releasable candidate passes only with every job and the exact package verified", { skip }, (t) => {
  const run = acceptedRun(t);
  const record = run.decide();
  assert.equal(record.verdict, "PASS");
  assert.deepEqual(record.acceptance.issues, []);
  assert.deepEqual(record.package, { file: "memorax-memorax-code-0.1.20.tgz", sha256: run.sha256,
    packageJson: { name: PACKAGE_NAME, version: "0.1.20" },
    artifact: { name: "memorax-code-package-attempt1", id: "123", digest: PACKAGE_DIGEST } });
  assert.deepEqual(record.clients.codex, [{ os: "ubuntu-24.04", node: "24", channel: "baseline", version: "0.147.0" }]);
  assert.deepEqual(record.clients.workbuddy.cells.map((cell) => [cell.channel, cell.desktopVersion, cell.runtimeVersion, cell.source, cell.attempt]),
    [["baseline+latest", "5.5.6.38337834", "2.137.1", "download.codebuddy.cn", 1], ["fallback", "5.6.2.39298511", "2.147.0", "download.codebuddy.cn", 1]]);
  assert.match(record.clients.workbuddy.coverage, /^Coverage degraded/);
  assert.deepEqual(record.run.attempts, [{ attempt: 1, status: "COMPLETE", unsuccessfulJobs: [] }]);
  assert.equal(record.publish.length, 5);
  assert.match(record.publish[2], /^npm publish memorax-memorax-code-0\.1\.20\.tgz --access public --tag latest$/);
  assert.equal(record.run.url, "https://github.com/memorax-ai/memorax-code/actions/runs/999");
});

test("acceptance and eligibility are decided separately", { skip }, (t) => {
  for (const [eligibility, verdict] of [
    [{ status: "NOT_RELEASABLE", reasons: ["REF_NOT_MAIN", "VERSION_ALREADY_PUBLISHED"], unconfirmed: [] }, "NOT_RELEASABLE"],
    [{ status: "UNCONFIRMED", reasons: [], unconfirmed: ["NPM_QUERY_FAILED"] }, "UNCONFIRMED"],
  ]) {
    const record = acceptedRun(t, { eligibility }).decide();
    assert.equal(record.acceptance.status, "PASS");
    assert.deepEqual(record.eligibility, eligibility);
    assert.equal(record.verdict, verdict);
    assert.deepEqual(record.publish, []);
  }
  const run = acceptedRun(t, { eligibility: { status: "NOT_RELEASABLE", reasons: ["REF_NOT_MAIN"], unconfirmed: [] } });
  run.needs["opencode-result"].result = "failure";
  const failed = run.decide();
  assert.equal(failed.verdict, "FAIL");
  assert.deepEqual(failed.eligibility.reasons, ["REF_NOT_MAIN"]);
});

test("failed, cancelled, skipped or missing required jobs never pass", { skip }, (t) => {
  for (const id of REQUIRED_JOBS) {
    for (const [result, verdict] of [["failure", "FAIL"], ["cancelled", "INCOMPLETE"], ["skipped", "INCOMPLETE"], [undefined, "INCOMPLETE"]]) {
      const run = acceptedRun(t);
      if (result) run.needs[id].result = result;
      else delete run.needs[id];
      const record = run.decide();
      assert.equal(record.verdict, verdict, `${id}=${result}`);
      if (id === "candidate") assert.equal(record.eligibility.status, "UNCONFIRMED");
    }
  }
});

test("the candidate package must be the recorded artifact, file, checksum and version", { skip }, (t) => {
  const cases = [
    ["checksum", (run) => { run.needs.package.outputs["package-sha256"] = "0".repeat(64); }, "FAIL", "PACKAGE_SHA256_MISMATCH"],
    ["no file", (run) => rmSync(run.packageDir, { recursive: true }), "INCOMPLETE", "PACKAGE_FILE_MISSING"],
    ["two files", (run) => writeFileSync(join(run.packageDir, "memorax-memorax-code-0.1.21.tgz"), ""), "FAIL", "PACKAGE_FILE_AMBIGUOUS"],
    ["no artifact record", (run) => ({ artifact: null }), "INCOMPLETE", "ARTIFACT_METADATA_MISSING"],
    ["digest", (run) => ({ artifact: { ...run.artifact, digest: `sha256:${"e".repeat(64)}` } }), "FAIL", "ARTIFACT_IDENTITY_MISMATCH"],
    ["malformed digests", (run) => {
      run.needs.package.outputs["package-artifact-digest"] = "sha256:abc";
      return { artifact: { ...run.artifact, digest: "sha256:abc" } };
    }, "FAIL", "ARTIFACT_IDENTITY_MISMATCH"],
    ["other run", (run) => ({ artifact: { ...run.artifact, workflow_run: { id: 1 } } }), "FAIL", "ARTIFACT_IDENTITY_MISMATCH"],
    ["expired", (run) => ({ artifact: { ...run.artifact, expired: true } }), "FAIL", "ARTIFACT_IDENTITY_MISMATCH"],
    ["no package outputs", (run) => { delete run.needs.package.outputs["package-artifact-id"]; }, "INCOMPLETE", "PACKAGE_RECORD_MISSING"],
    ["unreadable metadata", (run) => {
      const tgz = join(run.packageDir, "memorax-code-package-attempt1", "memorax-memorax-code-0.1.20.tgz");
      writeFileSync(tgz, "not a tarball");
      run.needs.package.outputs["package-sha256"] = createHash("sha256").update("not a tarball").digest("hex");
    }, "INCOMPLETE", "PACKAGE_METADATA_UNREADABLE"],
  ];
  for (const [label, change, verdict, issue] of cases) {
    const run = acceptedRun(t);
    const record = run.decide(change(run) ?? {});
    assert.equal(record.verdict, verdict, label);
    assert.ok(record.acceptance.issues.includes(issue), `${label}: ${record.acceptance.issues}`);
  }
  const wrongVersion = acceptedRun(t, { version: "0.1.19" }).decide();
  assert.equal(wrongVersion.verdict, "FAIL");
  assert.ok(wrongVersion.acceptance.issues.includes("PACKAGE_VERSION_MISMATCH"));
});

test("the candidate record must exist and keep the run's commit", { skip }, (t) => {
  const unreadable = acceptedRun(t);
  unreadable.needs.candidate.outputs.record = "{not json";
  const missing = unreadable.decide();
  assert.equal(missing.verdict, "INCOMPLETE");
  assert.deepEqual(missing.eligibility, { status: "UNCONFIRMED", reasons: [], unconfirmed: ["CANDIDATE_RECORD_MISSING"] });
  const moved = acceptedRun(t).decide({ env: { ...ENV, GITHUB_SHA: "d".repeat(40) } });
  assert.equal(moved.verdict, "FAIL");
  assert.ok(moved.acceptance.issues.includes("CANDIDATE_SHA_CHANGED"));
});

test("an attempt that cannot be read completely never counts as an attempt without failures", { skip }, (t) => {
  const run = acceptedRun(t);
  const api = join(run.root, "api");
  mkdirSync(api);
  const pages = (attempt, jobs, total = jobs.length) => JSON.stringify([{ total_count: total,
    jobs: jobs.map((name, index) => ({ id: attempt * 100 + index, run_id: 999, run_attempt: attempt, name, conclusion: "success" })) }]);
  const write = (attempt, text) => writeFileSync(join(api, `attempt-${attempt}.json`), text);
  const status = (attempt) => readAttempts(api, 3, "999").find((entry) => entry.attempt === attempt).status;
  write(1, pages(1, ["package", "Tests"]));
  assert.equal(status(1), "COMPLETE");
  assert.equal(status(2), "MISSING");
  for (const [label, text, expected] of [
    ["empty file", "", "EMPTY"], ["blank file", "\n", "EMPTY"], ["corrupt JSON", "[{\"total_count\": 2, \"jobs\": [", "INVALID"],
    ["not a page list", "{}", "INVALID"], ["no pages", "[]", "INVALID"],
    ["partial pages", pages(2, ["package"], 2), "INCOMPLETE"],
    ["duplicate job", JSON.stringify([{ total_count: 2, jobs: [{ id: 1, run_id: 999, run_attempt: 2, name: "a" }, { id: 1, run_id: 999, run_attempt: 2, name: "a" }] }]), "INCOMPLETE"],
    ["another attempt", pages(1, ["package"]), "MISMATCH"],
    ["another run", JSON.stringify([{ total_count: 1, jobs: [{ id: 1, run_id: 5, run_attempt: 2, name: "package" }] }]), "MISMATCH"],
  ]) {
    write(2, text);
    assert.equal(status(2), expected, label);
  }
  write(2, pages(2, ["package"]));
  writeFileSync(join(api, "attempt-2.failed"), "");
  assert.equal(status(2), "QUERY_FAILED");
  assert.equal(readAttempts(undefined, 2, "999").every((entry) => entry.status === "MISSING"), true);

  // Functional results are kept, but the record is incomplete and never releases the candidate.
  for (const entry of ["MISSING", "QUERY_FAILED", "EMPTY", "INVALID", "INCOMPLETE", "MISMATCH"]) {
    const record = run.decide({ attempts: [{ attempt: 1, status: entry, jobs: null }] });
    assert.equal(record.verdict, "INCOMPLETE", entry);
    assert.ok(record.acceptance.issues.includes(`ATTEMPT_RECORD_${entry}:1`), entry);
    assert.deepEqual(record.acceptance.jobs, Object.fromEntries(REQUIRED_JOBS.map((id) => [id, "success"])));
    assert.deepEqual(record.run.attempts, [{ attempt: 1, status: entry, unsuccessfulJobs: null }]);
    assert.deepEqual(record.publish, []);
  }
  // Attempt 2 needs the listing of attempt 1 and of attempt 2.
  const second = run.decide({ env: { ...ENV, GITHUB_RUN_ATTEMPT: "2" } });
  assert.ok(second.acceptance.issues.includes("ATTEMPT_RECORD_MISSING:2"));
  assert.equal(run.decide({ env: { ...ENV, GITHUB_RUN_ATTEMPT: "0" } }).verdict, "INCOMPLETE");
});

test("WorkBuddy reports come from the attempt in which each cell last ran and must match the run and frozen release", { skip }, (t) => {
  const [linux, windows] = WORKBUDDY_ROWS;
  const rerunAttempts = () => [firstAttempt(), listing(2, [{ name: "package", ...ranAt(0, 1) },
    { name: jobName(linux), ...ranAt(5, 10) }, { name: jobName(windows), ...ranAt(40, 99) }])];
  const env = { ...ENV, GITHUB_RUN_ATTEMPT: "2" };
  const run = acceptedRun(t);
  // Windows ran again in attempt 2; Linux was carried over and keeps its attempt-1 report.
  writeReport(run.reports, windows, 2, workbuddyReport(windows, { attempt: 2, runtimeVersion: "2.148.0" }));
  const record = run.decide({ attempts: rerunAttempts(), env });
  assert.equal(record.verdict, "PASS", record.acceptance.issues.join());
  assert.deepEqual(record.clients.workbuddy.cells.map((cell) => [cell.attempt, cell.report, cell.runtimeVersion]), [
    [1, "workbuddy-report-ubuntu-24.04-baseline+latest-node-24-attempt1", "2.137.1"],
    [2, "workbuddy-report-windows-2025-fallback-node-24-attempt2", "2.148.0"]]);
  // A cell that ran again never falls back to its older report.
  rmSync(join(run.reports, "workbuddy-report-windows-2025-fallback-node-24-attempt2"), { recursive: true });
  const stale = run.decide({ attempts: rerunAttempts(), env });
  assert.equal(stale.verdict, "INCOMPLETE");
  assert.ok(stale.acceptance.issues.includes("WORKBUDDY_REPORT_MISSING"));
  assert.equal(stale.clients.workbuddy.cells[1].report, "workbuddy-report-windows-2025-fallback-node-24-attempt2");
  // Without every attempt's complete listing the attempt that ran a cell is unknown.
  const unknown = run.decide({ attempts: [firstAttempt(), { attempt: 2, status: "QUERY_FAILED", jobs: null }], env });
  assert.ok(unknown.acceptance.issues.includes("WORKBUDDY_ATTEMPT_UNKNOWN"));
  assert.ok(run.decide({ attempts: [listing(1, [{ name: "package", ...ranAt(0, 1) }])] }).acceptance.issues.includes("WORKBUDDY_ATTEMPT_UNKNOWN"));
});

test("a WorkBuddy cell's attempt is unknown unless each listing holding it identifies one execution", { skip }, (t) => {
  const [linux, windows] = WORKBUDDY_ROWS;
  const env = { ...ENV, GITHUB_RUN_ATTEMPT: "2" };
  // Skipped jobs have no runner and the running release result has no conclusion; neither identifies a WorkBuddy cell.
  const others = (attempt) => [{ name: "package", ...ranAt(0, 1) }, { name: jobName(windows), ...ranAt(5, 11) },
    { name: "provider", conclusion: "skipped", started_at: "2026-10-19T03:00:01Z", runner_id: null },
    ...(attempt === 2 ? [{ name: "Release acceptance result", status: "in_progress", conclusion: null, ...ranAt(50, 77) }] : [])];
  const attempts = (first, second) => [listing(1, [...others(1), ...first]), listing(2, [...others(2), ...second])];
  const cell = (fields) => [{ name: jobName(linux), ...fields }];
  for (const [label, first, second] of [
    ["fields missing in both listings", cell({}), cell({})],
    ["fields null in both listings", cell({ started_at: null, runner_id: null }), cell({ started_at: null, runner_id: null })],
    ["earlier listing without a runner", cell({ started_at: "2026-10-19T03:05:00Z" }), cell(ranAt(40, 50))],
    ["latest listing without a runner", cell(ranAt(5, 10)), cell({ started_at: "2026-10-19T03:05:00Z", runner_id: null })],
    ["start time is not a timestamp", cell({ started_at: "yesterday", runner_id: 10 }), cell({ started_at: "yesterday", runner_id: 10 })],
    ["runner is not a positive integer", cell({ ...ranAt(5, 10), runner_id: "10" }), cell({ ...ranAt(5, 10), runner_id: "10" })],
    ["runner zero", cell({ ...ranAt(5, 10), runner_id: 0 }), cell({ ...ranAt(5, 10), runner_id: 0 })],
    ["name held twice", cell(ranAt(5, 10)), [...cell(ranAt(5, 10)), ...cell(ranAt(40, 50))]],
    ["runner shared with another job", [...cell(ranAt(5, 10)), { name: "Tests", ...ranAt(6, 10) }],
      [...cell(ranAt(5, 10)), { name: "Tests", ...ranAt(6, 10) }]],
  ]) {
    const run = acceptedRun(t);
    const record = run.decide({ attempts: attempts(first, second), env });
    assert.equal(record.verdict, "INCOMPLETE", label);
    assert.ok(record.acceptance.issues.includes("WORKBUDDY_ATTEMPT_UNKNOWN"), `${label}: ${record.acceptance.issues}`);
    // The cell's attempt-1 report exists but is never used.
    assert.deepEqual([record.clients.workbuddy.cells[0].attempt, record.clients.workbuddy.cells[0].report, record.clients.workbuddy.cells[0].runtimeVersion],
      [null, null, null], label);
    assert.equal(record.clients.workbuddy.cells[1].attempt, 1, label);
  }
  // Identified executions: carried over keeps attempt 1; absent from attempt 1 means the cell first ran in attempt 2.
  const carried = acceptedRun(t).decide({ attempts: attempts(cell(ranAt(5, 10)), cell(ranAt(5, 10))), env });
  assert.equal(carried.verdict, "PASS", carried.acceptance.issues.join());
  assert.equal(carried.clients.workbuddy.cells[0].attempt, 1);
  const late = acceptedRun(t);
  writeReport(late.reports, linux, 2);
  const lateRecord = late.decide({ attempts: attempts([], cell(ranAt(40, 50))), env });
  assert.equal(lateRecord.verdict, "PASS", lateRecord.acceptance.issues.join());
  assert.equal(lateRecord.clients.workbuddy.cells[0].report, "workbuddy-report-ubuntu-24.04-baseline+latest-node-24-attempt2");
});

test("WorkBuddy reports keep both hashes and the status; only Linux may warn", { skip }, (t) => {
  const [linux, windows] = WORKBUDDY_ROWS;
  const run = acceptedRun(t);
  writeReport(run.reports, linux, 1, workbuddyReport(linux, { actual: "e".repeat(64) }));
  const warned = run.decide();
  assert.equal(warned.verdict, "PASS", warned.acceptance.issues.join());
  assert.deepEqual(warned.clients.workbuddy.cells[0].sha256, { reference: "a".repeat(64), actual: "e".repeat(64), status: "warning" });
  assert.deepEqual(warned.clients.workbuddy.cells[1].sha256, { reference: "b".repeat(64), actual: "b".repeat(64), status: "match" });
  writeReport(run.reports, windows, 1, workbuddyReport(windows, { actual: "e".repeat(64) }));
  const gated = run.decide();
  assert.equal(gated.verdict, "FAIL");
  assert.ok(gated.acceptance.issues.includes("WORKBUDDY_HASH_MISMATCH"));
});

test("WorkBuddy reports must be readable schema 2 reports of this run and cell", { skip }, (t) => {
  const [linux] = WORKBUDDY_ROWS;
  const valid = workbuddyReport(linux);
  for (const [label, report, issue] of [
    ["unreadable", "{not json", "WORKBUDDY_REPORT_INVALID"],
    ["schema 1", { ...valid, schemaVersion: 1 }, "WORKBUDDY_REPORT_INVALID"],
    ["no runtime", { ...valid, runtimeVersion: null }, "WORKBUDDY_REPORT_INVALID"],
    ["no actual hash", { ...valid, sha256: { ...valid.sha256, actual: "" } }, "WORKBUDDY_REPORT_INVALID"],
    ["unknown status", { ...valid, sha256: { ...valid.sha256, status: "skipped" } }, "WORKBUDDY_REPORT_INVALID"],
    ["other run", { ...valid, runId: "998" }, "WORKBUDDY_REPORT_MISMATCH"],
    ["other attempt", { ...valid, runAttempt: 2 }, "WORKBUDDY_REPORT_MISMATCH"],
    ["other os", { ...valid, os: "ubuntu-22.04" }, "WORKBUDDY_REPORT_MISMATCH"],
    ["other node", { ...valid, node: "20" }, "WORKBUDDY_REPORT_MISMATCH"],
    ["other channel", { ...valid, channel: "latest" }, "WORKBUDDY_REPORT_MISMATCH"],
    ["other desktop", { ...valid, desktopVersion: "5.7.0.40000000" }, "WORKBUDDY_REPORT_MISMATCH"],
    ["other baseline runtime", { ...valid, runtimeVersion: "2.137.2" }, "WORKBUDDY_REPORT_MISMATCH"],
    ["other arch", { ...valid, arch: "arm64" }, "WORKBUDDY_REPORT_MISMATCH"],
    ["other source", { ...valid, source: "example.invalid" }, "WORKBUDDY_REPORT_MISMATCH"],
    ["other reference", { ...valid, sha256: { ...valid.sha256, reference: "f".repeat(64) } }, "WORKBUDDY_REPORT_MISMATCH"],
    ["other reference with a consistent status", { ...valid, sha256: { reference: "f".repeat(64), actual: "f".repeat(64), status: "match" } }, "WORKBUDDY_REPORT_MISMATCH"],
    ["status contradicts hashes", { ...valid, sha256: { ...valid.sha256, status: "warning" } }, "WORKBUDDY_REPORT_MISMATCH"],
  ]) {
    const run = acceptedRun(t);
    writeReport(run.reports, linux, 1, report);
    const record = run.decide();
    assert.equal(record.verdict, issue === "WORKBUDDY_REPORT_INVALID" ? "INCOMPLETE" : "FAIL", label);
    assert.ok(record.acceptance.issues.includes(issue), `${label}: ${record.acceptance.issues}`);
  }
  const run = acceptedRun(t);
  rmSync(join(run.reports, "workbuddy-report-ubuntu-24.04-baseline+latest-node-24-attempt1"), { recursive: true });
  assert.ok(run.decide().acceptance.issues.includes("WORKBUDDY_REPORT_MISSING"));
});

test("the record CLI reads every attempt and exits 0 only for a passing releasable candidate", { skip }, async (t) => {
  for (const [eligibility, code] of [[undefined, 0], [{ status: "NOT_RELEASABLE", reasons: ["REF_NOT_MAIN"], unconfirmed: [] }, 1]]) {
    const run = acceptedRun(t, eligibility ? { eligibility } : {});
    const api = join(run.root, "api");
    mkdirSync(api);
    writeFileSync(join(api, "artifact.json"), JSON.stringify(run.artifact));
    const first = firstAttempt().jobs;
    first.push({ id: 1900, run_id: 999, run_attempt: 1, name: "Cursor App latest 3.25.6 (windows-2025, Node 24)", conclusion: "failure", ...ranAt(6, 30) });
    writeFileSync(join(api, "attempt-1.json"), JSON.stringify([{ total_count: first.length, jobs: first }]));
    const second = first.map((job) => ({ ...job, id: job.id + 5000, run_attempt: 2,
      ...(job.name.startsWith("Cursor") ? { conclusion: "success", ...ranAt(40, 31) } : {}) }));
    writeFileSync(join(api, "attempt-2.json"), JSON.stringify([{ total_count: second.length, jobs: second }]));
    const output = join(run.root, "record", "release-record.json");
    const summary = join(run.root, "summary.md");
    const status = await runCli(["record", "--package-dir", run.packageDir, "--workbuddy-reports", run.reports, "--api-dir", api,
      "--output", output, "--github-summary", summary], { ...ENV, GITHUB_RUN_ATTEMPT: "2", NEEDS_JSON: JSON.stringify(run.needs) });
    assert.equal(status, code);
    const record = JSON.parse(readFileSync(output, "utf8"));
    assert.deepEqual(record.run.attempts, [{ attempt: 1, status: "COMPLETE", unsuccessfulJobs: ["Cursor App latest 3.25.6 (windows-2025, Node 24): failure"] },
      { attempt: 2, status: "COMPLETE", unsuccessfulJobs: [] }]);
    assert.match(readFileSync(summary, "utf8"), code ? /does not accept the candidate for delivery/ : /Publish the accepted file manually/);
    assert.match(readFileSync(summary, "utf8"), /Attempts: 1 COMPLETE, 2 COMPLETE/);
  }
});
