// Release acceptance for one dispatched commit: record the candidate and its release eligibility, then decide whether
// the run's single candidate package passed acceptance. Acceptance and eligibility are decided and recorded separately;
// an eligibility problem never stops acceptance jobs, and only a passing acceptance of a releasable candidate exits 0.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

export const PACKAGE_NAME = "@memorax/memorax-code";
const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME.replace("/", "%2F")}`;
// Release acceptance supports stable versions only; a valid prerelease or build version is refused, never compared.
const STABLE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const COMMIT = /^[0-9a-f]{40}$/;
const SCHEMA = 1;
// Jobs whose results decide acceptance; each result job already requires its whole matrix.
export const REQUIRED_JOBS = ["candidate", "basic-checks", "package", "workbuddy-releases", "functional-result",
  "opencode-result", "claude-result", "codebuddy-result", "cursor-app-result", "workbuddy-result"];
const CLIENTS = { codex: "codex", opencode: "opencode", claude: "claude", codebuddy: "codebuddy", cursor: "cursor" };
const UNSUCCESSFUL = ["failure", "cancelled", "timed_out"];

export function compareStable(left, right) {
  const [a, b] = [left, right].map((value) => STABLE.exec(value)?.slice(1).map(Number));
  if (!a || !b) throw new Error("VERSION_NOT_STABLE");
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  return 0;
}
const newestStable = (versions) => [...versions].sort((left, right) => compareStable(right, left))[0] ?? null;

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function gitRunner(root) {
  return (args) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8", timeout: 30_000 });
    if (result.error) throw result.error;
    return { status: result.status, stdout: result.stdout.trim() };
  };
}

function versionsConsistent(root) {
  return spawnSync(process.execPath, ["scripts/sync-release-version.mjs", "--check"], { cwd: root, encoding: "utf8", timeout: 60_000 }).status === 0;
}

// Read whether this exact version was ever published and npm's stable release history. A failed or unreadable query
// never counts as unpublished.
export async function npmPublication(version, { fetchImpl = fetch, timeoutMs = 20_000 } = {}) {
  let response;
  try {
    response = await fetchImpl(REGISTRY_URL, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    return { status: "UNCONFIRMED", reason: "NPM_QUERY_FAILED" };
  }
  if (response.status === 404) return { status: "NOT_PUBLISHED", latest: null, stableVersions: [] };
  if (response.status !== 200) return { status: "UNCONFIRMED", reason: "NPM_QUERY_FAILED", httpStatus: response.status };
  let document;
  try {
    document = await response.json();
  } catch {
    return { status: "UNCONFIRMED", reason: "NPM_RESPONSE_INVALID" };
  }
  if (!document || typeof document.versions !== "object" || document.versions === null) {
    return { status: "UNCONFIRMED", reason: "NPM_RESPONSE_INVALID" };
  }
  const latest = SEMVER.test(document["dist-tags"]?.latest ?? "") ? document["dist-tags"].latest : null;
  // Prerelease versions are outside the release history that latest follows.
  const stableVersions = Object.keys(document.versions).filter((item) => STABLE.test(item)).sort(compareStable);
  if (Object.hasOwn(document.versions, version)) return { status: "PUBLISHED", latest, stableVersions };
  // npm never reuses an unpublished version number.
  if (document.time && Object.hasOwn(document.time, version)) return { status: "PREVIOUSLY_PUBLISHED", latest, stableVersions };
  return { status: "NOT_PUBLISHED", latest, stableVersions };
}

export async function collectCandidate({ root, sha, ref, expectedSha = "", runGit = gitRunner(root),
  checkVersions = () => versionsConsistent(root), fetchImpl } = {}) {
  const reasons = [], unconfirmed = [], notes = [];
  const packageJson = JSON.parse(readFileSync(join(root, "packages/npm/memorax-code/package.json"), "utf8"));
  const version = packageJson.version;
  const stable = STABLE.test(version);
  if (packageJson.name !== PACKAGE_NAME || !SEMVER.test(version)) reasons.push("PACKAGE_IDENTITY_INVALID");
  else if (!stable) reasons.push("PRERELEASE_NOT_SUPPORTED");
  if (ref !== "refs/heads/main") reasons.push("REF_NOT_MAIN");
  const expected = expectedSha.trim().toLowerCase();
  if (expected && !COMMIT.test(expected)) reasons.push("EXPECTED_SHA_INVALID");
  else if (expected && expected !== sha) reasons.push("CANDIDATE_SHA_MISMATCH");
  if (!checkVersions()) reasons.push("VERSION_INCONSISTENT");
  const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
  if (!new RegExp(`^## \\[${escapeRegExp(version)}\\] - \\d{4}-\\d{2}-\\d{2}$`, "m").test(changelog)) reasons.push("CHANGELOG_ENTRY_MISSING");

  let previousRelease = null, range = null, docsBase = null;
  try {
    const head = runGit(["rev-parse", "HEAD"]);
    if (head.status !== 0) throw new Error("GIT_QUERY_FAILED");
    if (head.stdout !== sha) reasons.push("CHECKOUT_MISMATCH");
    const tag = runGit(["rev-parse", "-q", "--verify", `refs/tags/v${version}^{commit}`]);
    if (tag.status === 0) reasons.push("TAG_EXISTS");
    else if (tag.status !== 1) throw new Error("GIT_QUERY_FAILED");
    const merged = runGit(["tag", "--merged", sha, "--list", "v*"]);
    if (merged.status !== 0) throw new Error("GIT_QUERY_FAILED");
    // Only stable tags are release history; prerelease tags are neither previous releases nor compared.
    const releases = merged.stdout.split("\n").filter((name) => name !== `v${version}` && STABLE.test(name.slice(1)));
    const previous = releases.sort((left, right) => compareStable(right.slice(1), left.slice(1)))[0];
    if (previous) {
      const commit = runGit(["rev-list", "-n", "1", previous]);
      const count = runGit(["rev-list", "--count", `${previous}..${sha}`]);
      const subjects = runGit(["log", "--first-parent", "--format=%s", `${previous}..${sha}`]);
      if ([commit, count, subjects].some((result) => result.status !== 0)) throw new Error("GIT_QUERY_FAILED");
      previousRelease = { tag: previous, sha: commit.stdout, version: previous.slice(1) };
      if (stable && compareStable(previousRelease.version, version) >= 0) reasons.push("VERSION_NOT_INCREASED");
      const pullRequests = [...subjects.stdout.matchAll(/^Merge pull request #(\d+) /gm)].map((match) => Number(match[1]));
      range = { from: previous, commits: Number(count.stdout), pullRequests };
      docsBase = { sha: commit.stdout, source: "previous-release" };
    } else {
      notes.push("PREVIOUS_RELEASE_NOT_FOUND");
      const parent = runGit(["rev-parse", `${sha}^1`]);
      if (parent.status === 0) docsBase = { sha: parent.stdout, source: "first-parent" };
    }
  } catch {
    unconfirmed.push("GIT_QUERY_FAILED");
  }

  const npm = await npmPublication(version, { fetchImpl });
  if (npm.status === "PUBLISHED") reasons.push("VERSION_ALREADY_PUBLISHED");
  else if (npm.status === "PREVIOUSLY_PUBLISHED") reasons.push("VERSION_PREVIOUSLY_PUBLISHED");
  else if (npm.status === "UNCONFIRMED") unconfirmed.push(npm.reason);
  // npm's stable releases must agree with the candidate's release history, so publishing it as latest can neither move
  // latest backwards nor skip a release this history does not contain.
  if (stable && npm.status !== "UNCONFIRMED") {
    const newestOther = newestStable(npm.stableVersions.filter((item) => item !== version));
    if (newestOther && compareStable(newestOther, version) > 0) reasons.push("NPM_NEWER_VERSION_PUBLISHED");
    if (!unconfirmed.includes("GIT_QUERY_FAILED") && newestOther !== (previousRelease?.version ?? null)) reasons.push("NPM_HISTORY_MISMATCH");
    if (newestStable(npm.stableVersions) !== npm.latest) reasons.push("NPM_LATEST_NOT_NEWEST");
  }

  const status = reasons.length ? "NOT_RELEASABLE" : unconfirmed.length ? "UNCONFIRMED" : "RELEASABLE";
  return {
    schemaVersion: SCHEMA, candidateSha: sha, testScriptsSha: sha, ref, expectedSha: expected || null,
    package: { name: packageJson.name, version }, previousRelease, range, npm, docsBase,
    eligibility: { status, reasons, unconfirmed }, notes,
  };
}

function walk(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

const sha256File = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
// upload-artifact reports a bare hex digest while the REST API prefixes the same digest with "sha256:".
const digestHex = (value) => /^(?:sha256:)?([a-f0-9]{64})$/.exec(String(value ?? ""))?.[1] ?? null;
const parseJson = (value) => {
  try { return JSON.parse(value); } catch { return null; }
};
const hostOf = (url) => {
  try { return new URL(url).host; } catch { return null; }
};

export function matrixRows(value) {
  const include = parseJson(value ?? "")?.include;
  return Array.isArray(include) ? include : null;
}

// Verify that the downloaded artifact is the package job's exact candidate and read its own package metadata.
function verifyPackage({ outputs, candidate, packageDir, artifact, runId }, fail, incomplete) {
  const record = { file: null, sha256: outputs["package-sha256"] || null, packageJson: null,
    artifact: { name: outputs["package-artifact-name"] || null, id: outputs["package-artifact-id"] || null, digest: outputs["package-artifact-digest"] || null } };
  if (!record.sha256 || !record.artifact.name || !record.artifact.id || !record.artifact.digest) {
    incomplete("PACKAGE_RECORD_MISSING");
    return record;
  }
  if (!artifact) incomplete("ARTIFACT_METADATA_MISSING");
  else if (String(artifact.id) !== record.artifact.id || artifact.name !== record.artifact.name
    || !digestHex(record.artifact.digest) || digestHex(artifact.digest) !== digestHex(record.artifact.digest)
    || artifact.expired !== false || String(artifact.workflow_run?.id) !== String(runId)) fail("ARTIFACT_IDENTITY_MISMATCH");
  const files = walk(packageDir).filter((path) => /(?:^|[\\/])memorax-memorax-code-[^\\/]+\.tgz$/.test(path));
  if (files.length !== 1) {
    (files.length ? fail : incomplete)(files.length ? "PACKAGE_FILE_AMBIGUOUS" : "PACKAGE_FILE_MISSING");
    return record;
  }
  const [file] = files;
  record.file = file.split(/[\\/]/).at(-1);
  if (lstatSync(file).isSymbolicLink()) {
    fail("PACKAGE_FILE_NOT_REGULAR");
    return record;
  }
  if (sha256File(file) !== record.sha256) fail("PACKAGE_SHA256_MISMATCH");
  const extracted = spawnSync("tar", ["-xOzf", file, "package/package.json"], { encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 });
  const metadata = extracted.status === 0 ? parseJson(extracted.stdout) : null;
  if (!metadata) {
    incomplete("PACKAGE_METADATA_UNREADABLE");
    return record;
  }
  record.packageJson = { name: metadata.name, version: metadata.version };
  if (candidate && (metadata.name !== PACKAGE_NAME || metadata.version !== candidate.package.version
    || record.file !== `memorax-memorax-code-${candidate.package.version}.tgz`)) fail("PACKAGE_VERSION_MISMATCH");
  return record;
}

// The job name the workflow gives each WorkBuddy cell; the attempts API identifies cells only by name.
export const workbuddyJobName = (row) => `WorkBuddy native (${row.os}, Node ${row.node}, ${row.release?.channel}, ${row.release?.desktopVersion})`;

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

// A job's execution in one listing: its start time and runner. A job carried into a later attempt keeps both, and every
// job that runs gets its own runner. Undefined when the listing does not hold the job; null when it holds the job but
// does not identify one execution of it.
function executionIn(jobs, name) {
  const matches = jobs.filter((job) => job.name === name);
  if (!matches.length) return undefined;
  const [job] = matches;
  if (matches.length !== 1 || !Number.isSafeInteger(job.runner_id) || job.runner_id < 1 || !TIMESTAMP.test(job.started_at ?? "")
    || jobs.filter((other) => other.runner_id === job.runner_id).length !== 1) return null;
  return `${job.started_at} ${job.runner_id}`;
}

// The attempt in which a cell last ran: the earliest attempt from which the latest listing's execution was carried.
// Without every attempt's complete listing, or when a listing holds the cell without identifying its execution, the
// attempt is unknown.
function lastRunAttempt(name, attempts) {
  if (!attempts.length || attempts.some((entry) => entry.status !== "COMPLETE")) return null;
  const executions = attempts.map((entry) => executionIn(entry.jobs ?? [], name));
  let index = executions.length - 1;
  if (!executions[index]) return null;
  while (index > 0 && executions[index - 1] !== undefined) {
    if (executions[index - 1] === null) return null;
    if (executions[index - 1] !== executions[index]) break;
    index -= 1;
  }
  return attempts[index].attempt;
}

// Each cell's report must come from the attempt in which the cell last ran: a cell that did not run again keeps its
// earlier report, and a cell that ran again never falls back to an older one.
function workbuddyCells(rows, reportsDir, attempts, env, fail, incomplete) {
  return (rows ?? []).map((row) => {
    const release = row.release ?? {};
    const cell = { os: row.os, node: row.node, channel: release.channel, desktopVersion: release.desktopVersion,
      runtimeVersion: null, arch: null, source: null, sha256: null, attempt: null, report: null };
    const attempt = lastRunAttempt(workbuddyJobName(row), attempts);
    if (!attempt) {
      incomplete("WORKBUDDY_ATTEMPT_UNKNOWN");
      return cell;
    }
    const name = `workbuddy-report-${row.os}-${release.channel}-node-${row.node}-attempt${attempt}`;
    const path = join(reportsDir ?? "", name, "report.json");
    Object.assign(cell, { attempt, report: name });
    if (!reportsDir || !existsSync(path)) {
      incomplete("WORKBUDDY_REPORT_MISSING");
      return cell;
    }
    const report = parseJson(readFileSync(path, "utf8"));
    const hash = report?.sha256 ?? {};
    const valid = report?.schemaVersion === 2 && /^\d+\.\d+\.\d+$/.test(report.runtimeVersion ?? "")
      && /^[a-f0-9]{64}$/.test(hash.actual ?? "") && ["match", "warning"].includes(hash.status);
    if (!valid) {
      incomplete("WORKBUDDY_REPORT_INVALID");
      return cell;
    }
    // Identity, versions and hashes must agree with the frozen release, this run and the attempt that ran the cell.
    const matches = report.runId === String(env.GITHUB_RUN_ID) && report.runAttempt === attempt
      && report.os === row.os && String(report.node) === String(row.node) && report.channel === release.channel
      && report.desktopVersion === release.desktopVersion && (release.runtimeVersion == null || report.runtimeVersion === release.runtimeVersion)
      && report.arch === row.arch && report.source === hostOf(release.url) && hash.reference === release.sha256
      && hash.status === (hash.actual === hash.reference ? "match" : "warning");
    if (!matches) fail("WORKBUDDY_REPORT_MISMATCH");
    // Linux tolerates same-version rebuilds with a recorded warning; macOS and Windows require the hash before use.
    else if (hash.status === "warning" && release.platform !== "linux-x64-deb") fail("WORKBUDDY_HASH_MISMATCH");
    return { ...cell, runtimeVersion: report.runtimeVersion, arch: report.arch, source: report.source,
      sha256: { reference: hash.reference, actual: hash.actual, status: hash.status } };
  });
}

export function decideRelease({ needs, packageDir, workbuddyReportsDir, artifact = null, attempts = [], env = process.env }) {
  const issues = { fail: new Set(), incomplete: new Set() };
  const fail = (code) => issues.fail.add(code);
  const incomplete = (code) => issues.incomplete.add(code);
  const jobs = Object.fromEntries(REQUIRED_JOBS.map((id) => [id, needs?.[id]?.result ?? "missing"]));
  for (const [id, result] of Object.entries(jobs)) {
    if (result === "failure") fail(`JOB_FAILED:${id}`);
    else if (result !== "success") incomplete(`JOB_NOT_SUCCESSFUL:${id}:${result}`);
  }
  // Every attempt of the run must be read completely; an unreadable attempt never counts as one without failures.
  const runAttempt = Number(env.GITHUB_RUN_ATTEMPT);
  if (!Number.isSafeInteger(runAttempt) || runAttempt < 1) incomplete("RUN_ATTEMPT_INVALID");
  for (let attempt = 1; attempt <= runAttempt; attempt += 1) {
    const status = attempts.find((entry) => entry.attempt === attempt)?.status ?? "MISSING";
    if (status !== "COMPLETE") incomplete(`ATTEMPT_RECORD_${status}:${attempt}`);
  }

  const candidate = needs?.candidate?.result === "success" ? parseJson(needs.candidate.outputs?.record ?? "") : null;
  if (!candidate || candidate.schemaVersion !== SCHEMA) incomplete("CANDIDATE_RECORD_MISSING");
  else if (candidate.candidateSha !== env.GITHUB_SHA) fail("CANDIDATE_SHA_CHANGED");
  const outputs = needs?.package?.outputs ?? {};
  const packageRecord = verifyPackage({ outputs, candidate, packageDir, artifact, runId: env.GITHUB_RUN_ID }, fail, incomplete);

  const clients = {};
  for (const [name, key] of Object.entries(CLIENTS)) {
    const rows = matrixRows(outputs[`${name}-matrix`]);
    if (!rows) incomplete(`CLIENT_VERSIONS_MISSING:${name}`);
    clients[name] = (rows ?? []).map((row) => ({ os: row.os, node: row.node, channel: row.channel, version: row[key] }));
  }
  const workbuddyRows = matrixRows(needs?.["workbuddy-releases"]?.outputs?.matrix);
  if (!workbuddyRows) incomplete("CLIENT_VERSIONS_MISSING:workbuddy");
  clients.workbuddy = { coverage: needs?.["workbuddy-releases"]?.outputs?.coverage || null,
    cells: workbuddyCells(workbuddyRows, workbuddyReportsDir, attempts, env, fail, incomplete) };

  const acceptance = issues.fail.size ? "FAIL" : issues.incomplete.size ? "INCOMPLETE" : "PASS";
  const eligibility = candidate?.eligibility ?? { status: "UNCONFIRMED", reasons: [], unconfirmed: ["CANDIDATE_RECORD_MISSING"] };
  const verdict = acceptance !== "PASS" ? acceptance
    : { RELEASABLE: "PASS", NOT_RELEASABLE: "NOT_RELEASABLE" }[eligibility.status] ?? "UNCONFIRMED";
  const version = candidate?.package?.version ?? null;
  const runUrl = `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
  return {
    schemaVersion: SCHEMA, verdict,
    acceptance: { status: acceptance, jobs, issues: [...issues.fail, ...issues.incomplete] },
    eligibility: { status: eligibility.status, reasons: eligibility.reasons ?? [], unconfirmed: eligibility.unconfirmed ?? [] },
    candidate: candidate ? { version, candidateSha: candidate.candidateSha, testScriptsSha: candidate.testScriptsSha,
      ref: candidate.ref, expectedSha: candidate.expectedSha } : null,
    package: packageRecord,
    previousRelease: candidate?.previousRelease ?? null, range: candidate?.range ?? null,
    npm: candidate?.npm ?? null, docsBase: candidate?.docsBase ?? null, notes: candidate?.notes ?? [],
    clients,
    run: { id: env.GITHUB_RUN_ID, attempt: runAttempt, url: runUrl,
      attempts: attempts.map(({ attempt, status, jobs: list }) => ({ attempt, status,
        unsuccessfulJobs: list ? list.filter((job) => UNSUCCESSFUL.includes(job.conclusion)).map((job) => `${job.name}: ${job.conclusion}`) : null })) },
    upgradeCoverage: "Upgrade suites install fixed earlier MemoraX Code versions; upgrading from the previous release to this candidate is not exercised.",
    publish: verdict !== "PASS" ? [] : [
      `Download ${packageRecord.artifact.name} (artifact ${packageRecord.artifact.id}) from ${runUrl}; do not rebuild.`,
      `Confirm that sha256 of ${packageRecord.file} is ${packageRecord.sha256}.`,
      `npm publish ${packageRecord.file} --access public --tag latest`,
      `Compare npm view ${PACKAGE_NAME}@${version} dist.integrity dist.shasum with the sha512 and sha1 of the same file.`,
      `Tag v${version} at ${candidate.candidateSha} and attach the same file and its SHA256SUMS to the GitHub Release.`,
    ],
  };
}

function renderCandidate(record) {
  const range = record.range ? `${record.range.commits} commits since ${record.range.from}${record.range.pullRequests.length ? `, PRs ${record.range.pullRequests.map((number) => `#${number}`).join(", ")}` : ""}` : "previous release not found";
  return [`### Release candidate ${record.package.version}`, "",
    `- Candidate ${record.candidateSha} (test scripts from ${record.testScriptsSha}), ref ${record.ref}`,
    `- Eligibility: **${record.eligibility.status}**${[...record.eligibility.reasons, ...record.eligibility.unconfirmed].length ? ` (${[...record.eligibility.reasons, ...record.eligibility.unconfirmed].join(", ")})` : ""}`,
    `- npm: ${record.npm.status}${record.npm.latest ? `, latest ${record.npm.latest}` : ""}; ${range}`,
    `- Documentation compares with ${record.docsBase ? `${record.docsBase.sha} (${record.docsBase.source})` : "an unrecorded base"}`, "",
    "Eligibility is recorded separately and does not stop the acceptance jobs.", ""].join("\n");
}

function renderRecord(record) {
  const listed = (values) => (values.length ? ` (${values.join(", ")})` : "");
  const warnings = record.clients.workbuddy.cells.filter((cell) => cell.sha256?.status === "warning")
    .map((cell) => `${cell.os} ${cell.channel} Node ${cell.node}`);
  return [`### Release acceptance: **${record.verdict}**`, "",
    `- Acceptance: **${record.acceptance.status}**${listed(record.acceptance.issues)}`,
    `- Eligibility: **${record.eligibility.status}**${listed([...record.eligibility.reasons, ...record.eligibility.unconfirmed])}`,
    `- Candidate: ${record.candidate ? `${record.candidate.version} at ${record.candidate.candidateSha}` : "not recorded"}`,
    `- Package: ${record.package.file ?? "not verified"}, tgz SHA-256 ${record.package.sha256 ?? "-"}; artifact ${record.package.artifact.name ?? "-"} (ID ${record.package.artifact.id ?? "-"}, digest ${record.package.artifact.digest ?? "-"})`,
    `- Previous release: ${record.previousRelease ? `${record.previousRelease.tag} at ${record.previousRelease.sha}` : "not found"}`,
    `- Attempts: ${record.run.attempts.map((entry) => `${entry.attempt} ${entry.status}`).join(", ") || "none read"}`,
    `- WorkBuddy coverage: ${record.clients.workbuddy.coverage ?? "unavailable"}`,
    `- WorkBuddy Linux hash warnings: ${warnings.length ? warnings.join(", ") : "none"}`,
    `- ${record.upgradeCoverage}`, "",
    record.verdict === "PASS" ? `Publish the accepted file manually:\n\n${record.publish.map((step, index) => `${index + 1}. ${step}`).join("\n")}\n`
      : "This run does not accept the candidate for delivery. Do not publish its package.\n", ""].join("\n");
}

function parseOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = /^--([a-z][a-z0-9-]{0,40})$/.exec(args[index])?.[1];
    if (!name || index + 1 >= args.length) throw new Error("Usage: release-acceptance.mjs candidate|record --option value ...");
    options[name] = args[index + 1];
  }
  return options;
}

// Read one attempt's job listing as a result job wrote it. A failed query, a missing, empty, unreadable or partial
// listing, or a listing of another run or attempt is reported as such and never read as an attempt without failures.
export function readListing(apiDir, attempt, runId) {
  const path = join(apiDir ?? "", `attempt-${attempt}.json`);
  if (apiDir && existsSync(join(apiDir, `attempt-${attempt}.failed`))) return { status: "QUERY_FAILED", jobs: null };
  if (!apiDir || !existsSync(path)) return { status: "MISSING", jobs: null };
  const text = readFileSync(path, "utf8");
  if (!text.trim()) return { status: "EMPTY", jobs: null };
  const pages = parseJson(text);
  if (!Array.isArray(pages) || !pages.length || !pages.every((page) => Array.isArray(page?.jobs) && Number.isSafeInteger(page.total_count))) {
    return { status: "INVALID", jobs: null };
  }
  const jobs = pages.flatMap((page) => page.jobs);
  const total = pages[0].total_count;
  if (total < 1 || pages.some((page) => page.total_count !== total)) return { status: "INCOMPLETE", jobs: null };
  // Every page was read: the listing holds exactly total_count distinct jobs.
  if (jobs.length !== total || new Set(jobs.map((job) => job?.id)).size !== total) return { status: "INCOMPLETE", jobs: null };
  if (jobs.some((job) => typeof job?.name !== "string" || job.run_attempt !== attempt || String(job.run_id) !== String(runId))) {
    return { status: "MISMATCH", jobs: null };
  }
  return { status: "COMPLETE", jobs };
}

export function readAttempts(apiDir, runAttempt, runId) {
  const attempts = [];
  for (let attempt = 1; attempt <= runAttempt; attempt += 1) attempts.push({ attempt, ...readListing(apiDir, attempt, runId) });
  return attempts;
}

export async function runCli(args, env = process.env) {
  const [command, ...rest] = args;
  const options = parseOptions(rest);
  if (command === "candidate") {
    const record = await collectCandidate({ root: process.cwd(), sha: options.sha, ref: options.ref, expectedSha: options["expected-sha"] ?? "" });
    if (options["github-output"]) appendFileSync(options["github-output"], `record=${JSON.stringify(record)}\ndocs-base-sha=${record.docsBase?.sha ?? ""}\n`);
    if (options["github-summary"]) appendFileSync(options["github-summary"], renderCandidate(record));
    console.log(JSON.stringify(record, null, 2));
    return 0;
  }
  if (command === "record") {
    let record;
    try {
      const artifactPath = options["api-dir"] ? join(options["api-dir"], "artifact.json") : "";
      record = decideRelease({
        needs: parseJson(env.NEEDS_JSON ?? "") ?? {}, packageDir: options["package-dir"], workbuddyReportsDir: options["workbuddy-reports"],
        artifact: artifactPath && existsSync(artifactPath) ? parseJson(readFileSync(artifactPath, "utf8")) : null,
        attempts: readAttempts(options["api-dir"], Number(env.GITHUB_RUN_ATTEMPT), env.GITHUB_RUN_ID), env,
      });
    } catch (error) {
      record = { schemaVersion: SCHEMA, verdict: "INCOMPLETE", acceptance: { status: "INCOMPLETE", issues: [`RECORD_FAILED:${error.code ?? error.name}`] } };
    }
    mkdirSync(dirname(options.output), { recursive: true });
    writeFileSync(options.output, `${JSON.stringify(record, null, 2)}\n`);
    if (options["github-summary"]) {
      appendFileSync(options["github-summary"], record.package ? renderRecord(record)
        : `### Release acceptance: **${record.verdict}**\n\n${record.acceptance.issues.join(", ")}\n\n`);
    }
    console.log(JSON.stringify(record, null, 2));
    return record.verdict === "PASS" ? 0 : 1;
  }
  throw new Error("Usage: release-acceptance.mjs candidate|record --option value ...");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
    console.error(`::error title=Release acceptance::${error.message}`);
    process.exitCode = 1;
  });
}
