// Whether a failed pull request run of the native client functional workflow is rechecked once. Its failed jobs are
// rechecked only when attempt 1 failed, the package job succeeded, and every other failure is either a cell whose evidence
// names a signature that registered-signatures.json, the mirror of docs/native-ci-failure-register.md, lists as open,
// observing or mitigated, or a result job or PR acceptance reporting those cells. No cell may be cancelled or incomplete,
// and the run's head must still be the head of its open pull request, which has no newer run. Cells are found in attempt
// 1's job listing under the names client-result.mjs gives them, and each failed cell's evidence artifact must belong to
// that attempt and cell. Anything that cannot be read or does not match holds the run. `decide` makes the decision, and
// `confirm` reads the branch's runs and the pull request's head again right before the workflow requests the recheck.
// This script only reads; the workflow requests the recheck.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inflateRawSync } from "node:zlib";
import { CLIENTS } from "./client-result.mjs";

const SCHEMA = 1;
const USAGE = "Usage: native-auto-recheck.mjs decide --repository <owner/name> --run-id <id> --output <file> "
  + "[--github-output <file>] [--github-summary <file>], or confirm --record <file> [--github-summary <file>]";
export const REGISTERED = fileURLToPath(new URL("./registered-signatures.json", import.meta.url));
const WORKFLOW = ".github/workflows/macos-codex-install.yml";
// A registered signature is rechecked only under these statuses; closed and deferred signatures never are.
const RECHECKABLE = /^(?:open|observing #\d+|mitigated #\d+)$/;
// The jobs besides cells that may fail in a rechecked run: on a pull request they report the cells' results.
export const RESULT_JOBS = ["Codex functional result", "OpenCode functional result", "Claude native smoke result",
  "CodeBuddy functional result", "Cursor App canary result", "WorkBuddy functional result", "PR acceptance"];
const coded = (code) => Object.assign(new Error(code), { code });

// The registered signatures a recheck may follow, each in the client|os|suite|stage|code form of an evidence summary.
export function readRegistered(file = REGISTERED) {
  const data = JSON.parse(readFileSync(file, "utf8"));
  const entries = data?.schemaVersion === SCHEMA && Array.isArray(data.signatures) ? data.signatures : [];
  const unique = (key) => new Set(entries.map((entry) => entry[key])).size === entries.length;
  if (!entries.length || !entries.every((entry) => /^S\d+$/.test(entry?.id ?? "") && typeof entry.signature === "string"
    && entry.signature.split("|").length === 5 && RECHECKABLE.test(entry.status ?? "")) || !unique("id") || !unique("signature")) {
    throw coded("REGISTERED_SIGNATURES_INVALID");
  }
  return entries;
}

// Each client's cell names as patterns, built from the names client-result.mjs gives matrix rows. A skipped matrix job
// keeps its unexpanded name and is no cell.
const TOKEN = (field) => `\u0000${field}\u0000`;
const FIELDS = { channel: "[a-z]+(?:\\+[a-z]+)*", version: "[^\\s(),]+", os: "[a-z0-9.-]+", node: "\\d+" };
const CELL_NAMES = Object.entries(CLIENTS).map(([client, spec]) => {
  const row = { os: TOKEN("os"), node: TOKEN("node"), channel: TOKEN("channel"), [client]: TOKEN("version"),
    release: { channel: TOKEN("channel"), desktopVersion: TOKEN("version") } };
  const source = spec.name(row).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\u0000([a-z]+)\u0000/g, (_, field) => `(?<${field}>${FIELDS[field]})`);
  return [client, new RegExp(`^${source}$`)];
});

export function cellOf(name) {
  for (const [client, pattern] of CELL_NAMES) {
    const groups = pattern.exec(name)?.groups;
    if (groups) return { client, channel: groups.channel, version: groups.version, os: groups.os, node: groups.node };
  }
  return null;
}

// The named text members of a zip archive, read in memory: nothing is extracted. A member must be stored or deflated,
// unencrypted and named once; anything else, or an archive that cannot be parsed, is an error.
const MEMBER_LIMIT = 1024 * 1024;
export function zipMembers(archive, names) {
  const end = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0 || archive.length - end < 22) throw coded("ARCHIVE_INVALID");
  const members = {};
  for (let entry = archive.readUInt32LE(end + 16), left = archive.readUInt16LE(end + 10); left > 0; left -= 1) {
    if (archive.readUInt32LE(entry) !== 0x02014b50) throw coded("ARCHIVE_INVALID");
    const flags = archive.readUInt16LE(entry + 8), method = archive.readUInt16LE(entry + 10);
    const packed = archive.readUInt32LE(entry + 20), size = archive.readUInt32LE(entry + 24), local = archive.readUInt32LE(entry + 42);
    const nameEnd = entry + 46 + archive.readUInt16LE(entry + 28);
    const name = archive.toString("utf8", entry + 46, nameEnd);
    entry = nameEnd + archive.readUInt16LE(entry + 30) + archive.readUInt16LE(entry + 32);
    if (!names.includes(name)) continue;
    if (Object.hasOwn(members, name) || flags & 1 || ![0, 8].includes(method) || size > MEMBER_LIMIT
      || archive.readUInt32LE(local) !== 0x04034b50) throw coded("ARCHIVE_INVALID");
    const start = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
    const data = archive.subarray(start, start + packed);
    const text = method === 8 ? inflateRawSync(data, { maxOutputLength: MEMBER_LIMIT }) : data;
    if (data.length !== packed || text.length !== size) throw coded("ARCHIVE_INVALID");
    members[name] = text.toString("utf8");
  }
  return members;
}

// Every item of a listing read with gh api --paginate --slurp, exactly once, or null.
function itemsOf(pages, key) {
  if (!Array.isArray(pages) || !pages.length
    || !pages.every((page) => Array.isArray(page?.[key]) && page.total_count === pages[0].total_count)) return null;
  const items = pages.flatMap((page) => page[key]);
  return items.length === pages[0].total_count && new Set(items.map((item) => item?.id)).size === items.length ? items : null;
}

// A failed cell's evidence: the run's one artifact under the cell's name, read intact, recording this attempt and cell
// and a failure whose signature is registered.
function evidenceOf({ api, repository, runId, cell, artifact, artifacts, signatures }) {
  const matches = artifacts.filter((item) => item?.name === artifact);
  if (matches.length !== 1) return { issue: matches.length ? "ARTIFACT_IDENTITY_MISMATCH" : "ARTIFACT_MISSING" };
  const [{ id, digest, expired, workflow_run: source }] = matches;
  const hex = /^sha256:([a-f0-9]{64})$/.exec(String(digest ?? ""))?.[1];
  if (!hex || expired !== false || String(source?.id) !== runId) return { issue: "ARTIFACT_IDENTITY_MISMATCH" };
  let archive;
  try {
    archive = api(`repos/${repository}/actions/artifacts/${id}/zip`, { raw: true });
  } catch {
    return { issue: "ARTIFACT_UNREADABLE" };
  }
  if (createHash("sha256").update(archive).digest("hex") !== hex) return { issue: "ARTIFACT_IDENTITY_MISMATCH" };
  let inputs, summary;
  try {
    const members = zipMembers(archive, ["inputs.json", "summary.json"]);
    [inputs, summary] = [JSON.parse(members["inputs.json"]), JSON.parse(members["summary.json"])];
  } catch {
    return { issue: "EVIDENCE_INVALID" };
  }
  const recorded = inputs?.source;
  if (recorded?.repository !== repository || recorded.runId !== runId || recorded.runAttempt !== "1" || summary?.runAttempt !== 1
    || ["client", "os", "channel", "node"].some((key) => summary[key] !== cell[key]) || summary.clientVersion !== cell.version) {
    return { issue: "ARTIFACT_IDENTITY_MISMATCH" };
  }
  const signature = typeof summary.signature === "string" ? summary.signature : null;
  if (summary.testOutcome !== "FAIL" || !signature) return { issue: "EVIDENCE_NOT_FAILED", signature };
  const entry = signatures.find((item) => item.signature === signature);
  return entry ? { signature, registered: entry.id } : { issue: "SIGNATURE_UNREGISTERED", signature };
}

// One read of a GitHub API path with the gh CLI: parsed JSON, a listing's pages, or an archive's bytes.
export function readApi(path, { pages = false, raw = false } = {}) {
  const output = execFileSync("gh", ["api", ...(pages ? ["--paginate", "--slurp"] : []), path],
    { maxBuffer: 256 * 1024 * 1024, timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] });
  return raw ? output : JSON.parse(output.toString("utf8"));
}

// Each read is made up to three times, about five seconds apart, when gh gets no response, a 5xx or a 429; any other
// failure is final. The recheck request is never retried.
const ATTEMPTS = 3;
const PAUSE = 5_000;
const pause = (milliseconds) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);

// What a failed read reports, and whether it is retried: the HTTP status gh printed for the response, or no response at
// all (a transport error, a failed connection or a timeout).
export function failureOf(error) {
  const stderr = String(error?.stderr ?? "");
  const status = Number(/\bHTTP (\d{3})\b/.exec(stderr)?.[1]);
  if (status) return { failure: `HTTP ${status}`, retry: status >= 500 || status === 429 };
  const network = error?.code === "ETIMEDOUT" || /^(?:error connecting to |[A-Z][a-z]+ "https:\/\/[^"]*": )/m.test(stderr);
  return { failure: network ? "network" : "other", retry: network };
}

// The reads of one decision. A read that still fails holds the run with its reason, and each read that failed at least
// once is recorded with its attempts and failures.
function reading(api, sleep) {
  const reasons = [], retries = [];
  const hold = (reason) => {
    if (!reasons.includes(reason)) reasons.push(reason);
  };
  const get = (path, options) => {
    const failures = [];
    for (;;) {
      try {
        const value = api(path, options);
        if (failures.length) retries.push({ path, attempts: failures.length + 1, failures, outcome: "read" });
        return value;
      } catch (error) {
        const { failure, retry } = failureOf(error);
        failures.push(failure);
        if (!retry || failures.length === ATTEMPTS) {
          retries.push({ path, attempts: failures.length, failures, outcome: "unreadable" });
          throw error;
        }
        sleep(PAUSE);
      }
    }
  };
  const read = (path, reason, options) => {
    try {
      return get(path, options);
    } catch {
      hold(reason);
      return null;
    }
  };
  return { reasons, retries, hold, get, read };
}

// Whether the run is still a completed, failed attempt 1, as a recheck by hand starts another attempt of the same run,
// and its head is still the head of its open pull request, whose branch has no newer run of this workflow. A push moves
// the pull request's head before its run is created, so the branch's runs are read first.
function current({ repository, run, read, hold }) {
  const runs = read(`repos/${repository}/actions/workflows/${run.workflow}/runs?event=pull_request&branch=`
    + `${encodeURIComponent(String(run.branch ?? ""))}&per_page=100`, "RUNS_UNREADABLE");
  const listed = runs?.workflow_runs;
  if (runs && (!Array.isArray(listed) || !listed.every((item) => Number.isSafeInteger(item?.run_number))
    || !listed.some((item) => String(item.id) === run.id) || !Number.isSafeInteger(run.number))) hold("RUNS_INVALID");
  else if (runs && listed.some((item) => item.run_number > run.number)) hold("NEWER_RUN");
  const entry = Array.isArray(listed) ? listed.find((item) => String(item?.id) === run.id) : undefined;
  if (entry && (entry.run_attempt !== 1 || entry.status !== "completed" || entry.conclusion !== "failure")) {
    hold("RUN_CHANGED");
  }
  const pull = run.pullRequest === null ? null : read(`repos/${repository}/pulls/${run.pullRequest}`, "PULL_REQUEST_UNREADABLE");
  if (pull && pull.state !== "open") hold("PULL_REQUEST_NOT_OPEN");
  if (pull && pull.head?.sha !== run.head) hold("HEAD_CHANGED");
}

export function decide({ repository, runId, api = readApi, registered = REGISTERED, sleep = pause }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? "") || !/^\d{1,20}$/.test(runId ?? "")) throw new Error(USAGE);
  const cells = [], jobs = [];
  const { reasons, retries, hold, get, read } = reading(api, sleep);
  let signatures = [];
  try {
    signatures = readRegistered(registered);
  } catch {
    hold("REGISTERED_SIGNATURES_INVALID");
  }

  const run = read(`repos/${repository}/actions/runs/${runId}`, "RUN_UNREADABLE");
  if (run) {
    if (String(run.id) !== runId || run.path !== WORKFLOW || !Number.isSafeInteger(run.workflow_id)) hold("RUN_NOT_NATIVE");
    if (run.event !== "pull_request") hold("RUN_NOT_PULL_REQUEST");
    if (run.head_repository?.full_name !== repository) hold("RUN_HEAD_FOREIGN");
    if (run.run_attempt !== 1) hold("RUN_NOT_FIRST_ATTEMPT");
    else if (run.status !== "completed" || run.conclusion !== "failure") hold("RUN_NOT_FAILED");
  }

  // Attempt 1's jobs: the package job, the cells and the jobs that report them.
  const pages = read(`repos/${repository}/actions/runs/${runId}/attempts/1/jobs?per_page=100`, "LISTING_UNREADABLE", { pages: true });
  let listing = pages && itemsOf(pages, "jobs");
  if (pages && !listing?.every((job) => typeof job?.name === "string" && job.run_attempt === 1 && String(job.run_id) === runId)) {
    hold("LISTING_INVALID");
    listing = null;
  }
  const failed = [];
  for (const job of listing ?? []) {
    const cell = cellOf(job.name);
    if (cell && job.conclusion === "failure") failed.push({ job, cell });
    else if (cell && job.conclusion !== "success") {
      cells.push({ job: job.name, id: job.id, conclusion: job.conclusion ?? null, ...cell, artifact: null, signature: null,
        registered: null, issue: "CELL_NOT_COMPLETED" });
      hold("CELL_NOT_COMPLETED");
    } else if (!cell && job.name !== "package" && !["success", "skipped"].includes(job.conclusion)) {
      const allowed = job.conclusion === "failure" && RESULT_JOBS.includes(job.name);
      jobs.push({ job: job.name, id: job.id, conclusion: job.conclusion ?? null, allowed });
      if (!allowed) hold("JOB_NOT_RECHECKABLE");
    }
  }
  if (listing && listing.filter((job) => job.name === "package" && job.conclusion === "success").length !== 1) {
    hold("PACKAGE_NOT_SUCCEEDED");
  }
  if (listing && !failed.length) hold("NO_FAILED_CELL");

  if (failed.length) {
    const artifactPages = read(`repos/${repository}/actions/runs/${runId}/artifacts?per_page=100`, "ARTIFACTS_UNREADABLE",
      { pages: true });
    const artifacts = artifactPages && itemsOf(artifactPages, "artifacts");
    if (artifactPages && !artifacts) hold("ARTIFACTS_INVALID");
    for (const { job, cell } of failed) {
      const artifact = `native-evidence-${cell.client}-${cell.os}-${cell.channel}-node-${cell.node}-attempt1`;
      const found = artifacts ? evidenceOf({ api: get, repository, runId, cell, artifact, artifacts, signatures })
        : { issue: artifactPages ? "ARTIFACTS_INVALID" : "ARTIFACTS_UNREADABLE" };
      cells.push({ job: job.name, id: job.id, conclusion: job.conclusion, ...cell, artifact, signature: found.signature ?? null,
        registered: found.registered ?? null, issue: found.issue ?? null });
      if (found.issue) hold(found.issue);
    }
  }

  // The run's head must still be the head of its one open pull request, which has no newer run of this workflow. The
  // record keeps what confirm reads again.
  const numbers = Array.isArray(run?.pull_requests) ? run.pull_requests.map((pull) => pull?.number) : [];
  const subject = { id: runId, attempt: run?.run_attempt ?? null, event: run?.event ?? null, head: run?.head_sha ?? null,
    branch: run?.head_branch ?? null, number: run?.run_number ?? null, workflow: run?.workflow_id ?? null,
    pullRequest: numbers.length === 1 && Number.isSafeInteger(numbers[0]) ? numbers[0] : null };
  if (run) {
    if (subject.pullRequest === null) hold("PULL_REQUEST_UNKNOWN");
    current({ repository, run: subject, read, hold });
  }

  return { schemaVersion: SCHEMA, repository, run: subject, decision: reasons.length ? "hold" : "recheck", reasons, cells, jobs,
    retries };
}

// For a recheck decision, right before the recheck request: the branch's runs and the pull request's head are read again,
// and any change, or a read that fails, holds the run. The record keeps the confirmation, and a hold becomes its decision.
export function confirm({ record, api = readApi, sleep = pause }) {
  if (record?.schemaVersion !== SCHEMA || record.decision !== "recheck" || record.confirmation
    || !/^[\w.-]+\/[\w.-]+$/.test(record.repository ?? "") || !/^\d{1,20}$/.test(record.run?.id ?? "")) {
    throw new Error("The record is not an unconfirmed recheck decision");
  }
  const { reasons, retries, hold, read } = reading(api, sleep);
  current({ repository: record.repository, run: record.run, read, hold });
  const decision = reasons.length ? "hold" : "recheck";
  return { ...record, decision, reasons: [...record.reasons, ...reasons], confirmation: { decision, reasons, retries } };
}

// Job names and signatures come from the run, so they are kept inside table cells and code spans.
const cellText = (value) => String(value).replaceAll("`", "'").replaceAll("|", "\\|");
const held = (reasons) => `Held: ${reasons.map((reason) => `\`${reason}\``).join(", ")}.`;
const retried = (retries) => (retries.length ? [`Reads that failed: ${retries.map((item) => `\`${cellText(item.path)}\`: `
  + `${item.failures.join(", ")}, ${item.outcome === "read" ? "then read" : "unreadable"}`).join("; ")}.`, ""] : []);
export function render(record) {
  const { run } = record;
  const basis = record.decision === "recheck"
    ? "For a completed pull request run, the workflow reads the branch's runs and the pull request's head again and then "
      + "requests one recheck of the failed jobs; a manual decide-only run requests none."
    : held(record.reasons);
  const others = record.jobs.map((job) => `${cellText(job.job)} (${job.conclusion ?? "none"}${job.allowed ? "" : ", not allowed"})`);
  return [`### Native auto recheck: **${record.decision}**`, "",
    `Run ${run.id} attempt 1${run.attempt > 1 ? ` of ${run.attempt}` : ""} (${run.event ?? "event unknown"}, head ${run.head?.slice(0, 8) ?? "unknown"}, pull request `
      + `${run.pullRequest === null ? "unknown" : `#${run.pullRequest}`}). ${basis}`, "",
    "| Cell | Conclusion | Signature | Registered | Issue |", "| --- | --- | --- | --- | --- |",
    ...record.cells.map((cell) => `| ${cellText(cell.job)} | ${cell.conclusion ?? "none"} | `
      + `${cell.signature === null ? "none" : `\`${cellText(cell.signature)}\``} | ${cell.registered ?? "none"} | ${cell.issue ?? "none"} |`),
    "", ...(others.length ? [`Other jobs that did not succeed: ${others.join(", ")}.`, ""] : []), ...retried(record.retries), ""].join("\n");
}

export function renderConfirmation(record) {
  const { decision, reasons, retries } = record.confirmation;
  return [`### Native auto recheck, right before the request: **${decision}**`, "",
    decision === "recheck" ? "The branch's runs and the pull request's head have not changed; the workflow requests the recheck."
      : held(reasons), "", ...retried(retries), ""].join("\n");
}

function parseOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = /^--([a-z][a-z0-9-]{0,40})$/.exec(args[index])?.[1];
    if (!name || index + 1 >= args.length) throw new Error(USAGE);
    options[name] = args[index + 1];
  }
  return options;
}

// Always writes the record and, when asked, the summary and the decision output; a hold is not a failure. confirm
// rewrites the record and prints only the decision on standard output, for the recheck step to read.
export function runCli(args, api = readApi, sleep = pause) {
  const [command, ...rest] = args;
  const options = parseOptions(rest);
  if (command === "confirm" && options.record) {
    const record = confirm({ record: JSON.parse(readFileSync(options.record, "utf8")), api, sleep });
    writeFileSync(options.record, `${JSON.stringify(record, null, 2)}\n`);
    if (options["github-summary"]) appendFileSync(options["github-summary"], renderConfirmation(record));
    console.error(`Native auto recheck of run ${record.run.id}, right before the request: ${record.decision}`
      + `${record.confirmation.reasons.length ? ` (${record.confirmation.reasons.join(", ")})` : ""}`);
    console.log(record.decision);
    return 0;
  }
  if (command !== "decide" || !options.output) throw new Error(USAGE);
  const record = decide({ repository: options.repository, runId: options["run-id"], api, sleep });
  mkdirSync(dirname(options.output), { recursive: true });
  writeFileSync(options.output, `${JSON.stringify(record, null, 2)}\n`);
  if (options["github-summary"]) appendFileSync(options["github-summary"], render(record));
  if (options["github-output"]) appendFileSync(options["github-output"], `decision=${record.decision}\n`);
  console.log(`Native auto recheck of run ${record.run.id}: ${record.decision}`
    + `${record.reasons.length ? ` (${record.reasons.join(", ")})` : ""}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = runCli(process.argv.slice(2));
  } catch (error) {
    console.error(`::error title=Native auto recheck::${error.message}`);
    process.exitCode = 1;
  }
}
