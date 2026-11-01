// The result of one native client's matrix, decided cell by cell. The jobs API identifies cells only by name, so every cell
// of the client's matrix output is looked up under the name the workflow gives it in this attempt's job listing and
// classified by its channel and conclusion. A failed baseline or accepted version is a regression; a failed official
// latest release, or the WorkBuddy fallback, is a client release problem, deferred while client-acceptance.json defers its
// version for that cell. The compatibility monitor passes only when every cell passed or was deferred: a new client
// release failure, a regression, a cell that did not complete, a missing cell and an unreadable listing all fail it. On
// the monitor a WorkBuddy cell marked deferred in its matrix may fail without failing the matrix job, and such a cell that
// succeeds fails the monitor. Every other run still requires the entire matrix to succeed and only reports the classes.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { MANIFEST, readAcceptance } from "./client-acceptance.mjs";
import { matrixRows, readListing, workbuddyJobName } from "./release-acceptance.mjs";

const SCHEMA = 1;
const PASSING = ["passed", "client-release-deferred"];
const USAGE = "Usage: client-result.mjs decide --client <id> --needs <json> --api-dir <dir> --output <file> [--github-summary <file>]";
const rowFields = (prefix, key) => ({ name: (row) => `${prefix} ${row.channel} ${row[key]} (${row.os}, Node ${row.node})`,
  channel: (row) => row.channel, version: (row) => row[key], platform: () => undefined, deferred: () => false });
// Each client's matrix job, the job output its matrix comes from, and how the workflow names a cell and reads its channel
// and version. Only WorkBuddy cells name a release platform and can be marked deferred.
export const CLIENTS = {
  codex: { label: "Codex matrix", need: "install", matrix: ["package", "codex-matrix"], ...rowFields("Codex", "codex") },
  opencode: { label: "OpenCode matrix", need: "opencode", matrix: ["package", "opencode-matrix"],
    ...rowFields("OpenCode", "opencode") },
  claude: { label: "Claude native smoke matrix", need: "claude", matrix: ["package", "claude-matrix"],
    ...rowFields("Claude smoke", "claude") },
  codebuddy: { label: "CodeBuddy functional matrix", need: "codebuddy", matrix: ["package", "codebuddy-matrix"],
    ...rowFields("CodeBuddy functional", "codebuddy") },
  cursor: { label: "Cursor App canary", need: "cursor-app", matrix: ["package", "cursor-matrix"], ...rowFields("Cursor App", "cursor") },
  workbuddy: { label: "WorkBuddy matrix", need: "workbuddy-native", matrix: ["workbuddy-releases", "matrix"], name: workbuddyJobName,
    channel: (row) => row.release?.channel, version: (row) => row.release?.desktopVersion, platform: (row) => row.release?.platform,
    deferred: (row) => row.release?.deferred === true },
};

// A cell that did not complete never passes, and a failed baseline or accepted version is a regression even when it is
// also the latest release. Only a failed official latest release or WorkBuddy fallback can be deferred.
export function classify(channel, conclusion, deferred) {
  if (conclusion === "success") return "passed";
  if (conclusion !== "failure") return "not-completed";
  const parts = String(channel).split("+");
  if (parts.includes("baseline") || parts.includes("accepted")) return "baseline-regression";
  return ["latest", "fallback"].includes(channel) && deferred() ? "client-release-deferred" : "client-release-new";
}

// An entry defers its version for every cell of the client or, when it lists platforms, only for cells on those release
// platforms; such an entry never defers a cell without a release platform.
export const defers = (entry, version, platform) => entry.version === version
  && (entry.platforms === undefined || entry.platforms.includes(platform));

export function decide({ client, needs, apiDir, env = process.env, manifest = MANIFEST }) {
  if (!Object.hasOwn(CLIENTS, client)) throw Object.assign(new Error("CLIENT_RESULT_CLIENT_UNKNOWN"), { code: "CLIENT_RESULT_CLIENT_UNKNOWN" });
  const spec = CLIENTS[client], issues = [];
  const schedule = env.GITHUB_EVENT_NAME === "schedule";
  const matrixResult = needs?.[spec.need]?.result ?? "missing";
  const rows = matrixRows(needs?.[spec.matrix[0]]?.outputs?.[spec.matrix[1]]);
  if (!rows?.length) issues.push("MATRIX_MISSING");
  const attempt = Number(env.GITHUB_RUN_ATTEMPT);
  const listing = readListing(apiDir, attempt, env.GITHUB_RUN_ID);
  if (listing.status !== "COMPLETE") issues.push(`LISTING_${listing.status}`);
  // The manifest is read only for a failed latest release; a manifest that cannot be read defers nothing.
  let deferred;
  const deferrals = () => {
    if (deferred) return deferred;
    try {
      deferred = readAcceptance(client, manifest).deferred ?? [];
    } catch (error) {
      deferred = [];
      issues.push(`DEFERRED_UNREADABLE:${error.code ?? error.name}`);
    }
    return deferred;
  };
  const cells = (rows ?? []).map((row) => {
    const job = spec.name(row), channel = spec.channel(row), version = spec.version(row);
    const cell = { cell: `${row.os}, Node ${row.node}`, job, channel, version, id: null, conclusion: null };
    const matches = listing.jobs?.filter((item) => item.name === job);
    if (!matches) return { ...cell, class: "unread" };
    if (matches.length !== 1) return { ...cell, class: matches.length ? "ambiguous" : "missing" };
    const [{ id, conclusion }] = matches;
    return { ...cell, id, conclusion, class: classify(channel, conclusion,
      () => deferrals().some((entry) => defers(entry, version, spec.platform(row)))) };
  });
  // On the monitor a cell marked deferred may fail without failing GitHub's result for the matrix, which must agree with the
  // cells: failure exactly when a deferred release failed on an unmarked cell. A marked cell that succeeded either passed
  // its deferred release or had its allowed failure reported as success.
  const marked = (rows ?? []).map((row) => schedule && spec.deferred(row));
  const passing = cells.length > 0 && cells.every((cell) => PASSING.includes(cell.class));
  const deferredFailure = cells.some((cell, index) => cell.class === "client-release-deferred" && !marked[index]);
  if (passing && matrixResult !== (deferredFailure ? "failure" : "success")) issues.push(`MATRIX_RESULT_UNEXPLAINED:${matrixResult}`);
  for (const [index, cell] of cells.entries()) {
    if (marked[index] && cell.conclusion === "success") issues.push(`DEFERRED_CELL_SUCCEEDED:${cell.job}`);
  }
  const pass = schedule ? passing && !issues.length : matrixResult === "success";
  return { schemaVersion: SCHEMA, client, event: env.GITHUB_EVENT_NAME ?? null,
    run: { id: env.GITHUB_RUN_ID ?? null, attempt: Number.isSafeInteger(attempt) ? attempt : null },
    verdict: pass ? "PASS" : "FAIL", basis: schedule ? "cells" : "matrix-result", matrixResult, listing: listing.status, issues, cells };
}

const NOTES = {
  "client-release-deferred": "the version is deferred in scripts/ci/shared/client-acceptance.json",
  "client-release-new": "register the signature in docs/native-ci-failure-register.md first, then defer the version in "
    + "scripts/ci/shared/client-acceptance.json or fix it",
  "baseline-regression": "a baseline or accepted version did not pass",
  "not-completed": "a cell that did not complete never passes",
  missing: "this attempt's job listing does not contain the cell",
  ambiguous: "this attempt's job listing contains the cell more than once",
};
const labelOf = (record) => CLIENTS[record.client]?.label ?? "client matrix";

export function render(record) {
  const label = labelOf(record);
  const basis = {
    cells: "On the compatibility monitor a cell passes when it succeeded, or when its official latest release failed and "
      + "scripts/ci/shared/client-acceptance.json defers that version for it.",
    "matrix-result": `This ${record.event} run requires the entire ${label} to succeed; the classes are reported only.`,
  }[record.basis] ?? "The cells could not be classified.";
  return [`### ${label} cells: **${record.verdict}**`, "", basis, "",
    `Job listing of this attempt: ${record.listing ?? "not read"}. Issues: ${record.issues.join(", ") || "none"}.`, "",
    "| Cell | Channel | Version | Conclusion | Class |", "| --- | --- | --- | --- | --- |",
    ...record.cells.map((cell) => `| ${cell.cell} | ${cell.channel} | ${cell.version} | ${cell.conclusion ?? "none"} | ${cell.class} |`),
    "", ""].join("\n");
}

// A monitor run names each cell that did not pass and each deferred release; every other run keeps one matrix error.
export function annotations(record) {
  const label = labelOf(record);
  if (record.basis === "matrix-result") {
    return record.verdict === "PASS" ? []
      : [`::error::The entire ${label} must succeed. Failed, cancelled or skipped dependencies do not pass this check.`];
  }
  return [...record.cells.filter((cell) => NOTES[cell.class]).map((cell) => `::${cell.class === "client-release-deferred" ? "notice" : "error"} `
    + `title=${cell.class}::${cell.job}${cell.conclusion ? ` concluded ${cell.conclusion}` : ""}: ${NOTES[cell.class]}.`),
  ...record.issues.map((issue) => `::error title=${label} cells::${issue}`)];
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

// Always writes the record and the summary; exits 0 only for a passing result.
export function runCli(args, env = process.env) {
  const [command, ...rest] = args;
  const options = parseOptions(rest);
  if (command !== "decide" || !options.output) throw new Error(USAGE);
  let record;
  try {
    record = decide({ client: options.client, needs: JSON.parse(options.needs ?? ""), apiDir: options["api-dir"], env });
  } catch (error) {
    record = { schemaVersion: SCHEMA, client: options.client ?? null, event: env.GITHUB_EVENT_NAME ?? null,
      run: { id: env.GITHUB_RUN_ID ?? null, attempt: null }, verdict: "FAIL", basis: null, matrixResult: null, listing: null,
      issues: [`DECIDE_FAILED:${error.code ?? error.name}`], cells: [] };
  }
  mkdirSync(dirname(options.output), { recursive: true });
  writeFileSync(options.output, `${JSON.stringify(record, null, 2)}\n`);
  if (options["github-summary"]) appendFileSync(options["github-summary"], render(record));
  for (const line of annotations(record)) console.log(line);
  return record.verdict === "PASS" ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = runCli(process.argv.slice(2));
  } catch (error) {
    console.error(`::error title=Client result::${error.message}`);
    process.exitCode = 1;
  }
}
