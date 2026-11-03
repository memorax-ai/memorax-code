import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { acceptedMatrix as workbuddyMatrix } from "../codebuddy-workbuddy/workbuddy-release-matrix.mjs";
import { acceptedMatrix as cursorMatrix, acceptedReleases } from "../cursor/cursor-app-release.mjs";
import { CHANNELS, MANIFEST, readAcceptance, runCli as acceptanceCli } from "./client-acceptance.mjs";
import { propose, render } from "./client-acceptance-refresh.mjs";
import { CLIENTS, decide } from "./client-result.mjs";

const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));
const SCRIPT = fileURLToPath(new URL("./client-acceptance-refresh.mjs", import.meta.url));
const WORKFLOW = readFileSync(new URL("../../../.github/workflows/macos-codex-install.yml", import.meta.url), "utf8")
  .replaceAll("\r\n", "\n");
// Compatibility monitor run 41037250868, attempt 1, on 410224bf. Its job listing and the matrices of the npm clients and
// Cursor App are the result classification fixtures; the refresh fixture keeps only what the refresh reads from the run's
// artifacts: the package job's input record, the frozen Cursor App inventory, the reports of the Cursor App latest desktop
// cells and of the WorkBuddy latest Linux cell, and the WorkBuddy release matrix. Only WorkBuddy latest 5.9.3.42398134 failed,
// on macOS and Windows.
const RUN = JSON.parse(readFileSync(join(FIXTURES, "client-acceptance-refresh", "41037250868-1.json"), "utf8"));
const LISTING = JSON.parse(readFileSync(join(FIXTURES, "client-result", "41037250868-1.json"), "utf8"));
const MATRICES = JSON.parse(readFileSync(join(FIXTURES, "client-result", "matrices.json"), "utf8"))["41037250868"];
const ENV = { GITHUB_RUN_ID: RUN.run.id, GITHUB_RUN_ATTEMPT: String(RUN.run.attempt), GITHUB_EVENT_NAME: "schedule",
  GITHUB_SHA: RUN.run.head };
const NOW = new Date("2026-10-30T10:40:00Z");
const SOURCE = readFileSync(MANIFEST, "utf8");
const BASELINES = JSON.parse(SOURCE).clients;
const NODE = /^ {2}"node": \{\n(?: {4}.*\n)* {2}\}/m;
const NPM = ["codex", "opencode", "claude", "codebuddy"];
const ACCEPTANCE = [{ run: "41037250868/1", result: "passed" }];
const DEFERRAL = { version: "5.9.3.42398134", platforms: ["darwin-arm64", "win32-x64-user"], date: "2026-10-28", runs: [],
  reason: "Fixture deferral." };
const WORKBUDDY_LATEST = (os) => `WorkBuddy native (${os}, Node 24, latest, 5.9.3.42398134)`;
// What this run supports when every client still accepts its baseline: every latest version except the deferred WorkBuddy one.
const CANDIDATES = {
  codex: ["candidate", "0.166.0"], opencode: ["candidate", "1.19.5"], claude: ["candidate", "2.1.314"],
  codebuddy: ["candidate", "2.178.1"], cursor: ["candidate", "3.27.22"], "workbuddy linux-x64-deb": ["candidate", "5.6.2.40046327"],
  ...Object.fromEntries([["darwin-arm64", "macos-15"], ["win32-x64-user", "windows-2025"]].map(([platform, os]) => [`workbuddy ${platform}`,
    ["not-candidate", "5.9.3.42398134", "DEFERRED", `CELL_NOT_PASSED: ${WORKBUDDY_LATEST(os)} is client-release-deferred`]])),
};

function scratch(t) {
  const root = mkdtempSync(join(tmpdir(), "client-acceptance-refresh-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

// The checkout's manifest as it stood before any monitor run was accepted: every client accepts its baseline and only
// WorkBuddy defers a version, after `change`. The text keeps the checkout's form, including the order of its Node pins.
function manifestOf(root, change) {
  const manifest = JSON.parse(SOURCE);
  for (const section of Object.values(manifest.clients)) {
    section.accepted = structuredClone(section.baseline);
    delete section.deferred;
  }
  manifest.clients.workbuddy.deferred = [DEFERRAL];
  change?.(manifest);
  const file = join(mkdtempSync(join(root, "manifest-")), "client-acceptance.json");
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`.replace(NODE, SOURCE.match(NODE)[0]));
  return file;
}

// This attempt's artifacts where the job downloads them, after `listing` edits the job listing and `matrices` the matrices.
// Each result record is decided from them as its result job decides it, with a matrix result that fails exactly when one
// of the client's cells failed.
function inputsOf(root, manifest, { listing, matrices } = {}) {
  const page = structuredClone(LISTING[0]);
  listing?.(page);
  const rows = structuredClone({ ...MATRICES, workbuddy: RUN.workbuddyMatrix });
  matrices?.(rows);
  const apiDir = mkdtempSync(join(root, "api-")), dir = mkdtempSync(join(root, "inputs-"));
  writeFileSync(join(apiDir, "attempt-1.json"), JSON.stringify([page]));
  const write = (path, value) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), JSON.stringify(value));
  };
  for (const [client, { need, matrix: [source, output], name }] of Object.entries(CLIENTS)) {
    const failed = rows[client].include.some((row) => page.jobs.some((job) => job.name === name(row) && job.conclusion === "failure"));
    write(`client-result/client-result-${client}-attempt1.json`, decide({ client, apiDir, env: ENV, manifest,
      needs: { [source]: { outputs: { [output]: JSON.stringify(rows[client]) } }, [need]: { result: failed ? "failure" : "success" } } }));
  }
  write("native-client-inputs/native-client-inputs.json", RUN.inputs);
  write("cursor-app-releases/cursor-app-releases.json", RUN.cursorReleases);
  for (const [name, report] of Object.entries(RUN.cursorReports)) write(`cursor-app-reports/${name}/report.json`, report);
  for (const [name, report] of Object.entries(RUN.workbuddyReports)) write(`workbuddy-reports/${name}/report.json`, report);
  return { dir, env: { ...ENV, WORKBUDDY_MATRIX: JSON.stringify(rows.workbuddy) } };
}

function proposeFrom(root, manifest, inputs, env = {}) {
  const output = mkdtempSync(join(root, "output-"));
  return { output, refresh: propose({ inputs: inputs.dir, output, env: { ...inputs.env, ...env }, now: NOW, manifest }) };
}

// Each client's decision, WorkBuddy's per platform, as [decision, latest version, ...reasons].
const outcomes = (refresh) => Object.fromEntries(Object.entries(refresh.clients).flatMap(([client, item]) => (client === "workbuddy"
  ? Object.entries(item.platforms).map(([platform, decision]) => [`workbuddy ${platform}`, decision]) : [[client, item]]))
  .map(([key, { decision, version, reasons }]) => [key, [decision, version, ...reasons]]));
const set = (name, fields) => (page) => Object.assign(page.jobs.find((job) => job.name === name), fields);
const editJson = (file, change) => writeFileSync(file, JSON.stringify(change(JSON.parse(readFileSync(file, "utf8")))));

// A stand-in for `npm view` that answers from dist.json beside it; no test reaches the registry.
function fakeNpm(root, dist) {
  const dir = mkdtempSync(join(root, "npm-"));
  writeFileSync(join(dir, "npm.mjs"), `import { readFileSync } from "node:fs";
const answer = JSON.parse(readFileSync(new URL("./dist.json", import.meta.url), "utf8"))[process.argv[3]];
if (answer === undefined) process.exit(1);
process.stdout.write(JSON.stringify(answer));
`);
  writeFileSync(join(dir, "dist.json"), JSON.stringify(dist));
  return [process.execPath, join(dir, "npm.mjs")];
}
const recorded = (section) => Object.fromEntries(CHANNELS.map((channel) => [`${section.package}@${section[channel].version}`,
  { "dist.integrity": section[channel].integrity, "dist.shasum": section[channel].shasum }]));

test("each latest version that passed every cell becomes a candidate with what this attempt recorded, and pull requests read the proposal", async (t) => {
  const root = scratch(t);
  const manifest = manifestOf(root);
  const { output, refresh } = proposeFrom(root, manifest, inputsOf(root, manifest));
  assert.deepEqual(outcomes(refresh), CANDIDATES);
  assert.deepEqual([refresh.schemaVersion, refresh.run, refresh.manifest, refresh.changed], [1, { id: RUN.run.id, attempt: 1,
    event: "schedule", head: RUN.run.head, date: "2026-10-30" }, "scripts/ci/shared/client-acceptance.json", true]);
  assert.deepEqual(JSON.parse(readFileSync(join(output, "refresh.json"), "utf8")), refresh);
  // Each decision names the artifacts it read.
  assert.deepEqual(refresh.clients.codex, { decision: "candidate", version: "0.166.0", accepted: BASELINES.codex.baseline.version,
    reasons: [], sources: ["client-result-codex-attempt1", "native-client-inputs-attempt1"] });
  assert.deepEqual(refresh.clients.cursor.sources, ["client-result-cursor-attempt1", "cursor-app-releases-attempt1",
    "cursor-app-macos-15-latest-node-24-report-attempt1", "cursor-app-windows-2025-latest-node-24-report-attempt1"]);
  assert.deepEqual(refresh.clients.workbuddy.platforms["linux-x64-deb"], { decision: "candidate", version: "5.6.2.40046327",
    accepted: BASELINES.workbuddy.baseline.platforms["linux-x64-deb"].desktop.version, reasons: [], sources: ["client-result-workbuddy-attempt1",
      "workbuddy-releases matrix", "workbuddy-report-ubuntu-24.04-latest-node-24-attempt1"], sha256Status: "match" });

  // The proposal changes only the candidates' accepted entries and records the run they cite.
  const file = join(output, "client-acceptance.proposed.json");
  const proposal = readFileSync(file, "utf8"), proposed = JSON.parse(proposal), expected = JSON.parse(readFileSync(manifest, "utf8"));
  for (const client of NPM) {
    const { version, integrity, shasum } = RUN.inputs.clients[client].versions.find((item) => item.channels.includes("latest"));
    expected.clients[client].accepted = { version, integrity, shasum, acceptance: ACCEPTANCE };
  }
  const { "linux-x64": linux, "darwin-arm64": macos, "win32-x64-user": windows } = RUN.cursorReleases.latest;
  const observed = (release, report) => ({ url: release.url, sha256: report.observedSha256, hashSource: "observed-sha256", size: report.bytes });
  expected.clients.cursor.accepted = { version: linux.version, commitSha: linux.commitSha, platforms: {
    "linux-x64": { url: linux.url, sha256: linux.sha256, hashSource: "official-apt-sha256", debVersion: linux.debVersion, size: linux.size },
    "darwin-arm64": observed(macos, RUN.cursorReports["cursor-app-macos-15-latest-node-24-report-attempt1"].macos),
    "win32-x64-user": observed(windows, RUN.cursorReports["cursor-app-windows-2025-latest-node-24-report-attempt1"].windows) },
  acceptance: ACCEPTANCE };
  const report = RUN.workbuddyReports["workbuddy-report-ubuntu-24.04-latest-node-24-attempt1"];
  const row = RUN.workbuddyMatrix.include.find(({ release }) => release.platform === "linux-x64-deb" && release.channel === "latest");
  expected.clients.workbuddy.accepted.platforms["linux-x64-deb"] = { desktop: { version: report.desktopVersion, url: row.release.url,
    sha256: report.sha256.actual }, runtime: { version: report.runtimeVersion }, acceptance: ACCEPTANCE };
  expected.runs["41037250868/1"] = { event: "schedule", head: RUN.run.head, date: "2026-10-30" };
  assert.deepEqual(proposed, expected);
  assert.equal(proposal.match(NODE)[0], SOURCE.match(NODE)[0]);

  // The diff applies to the checkout's manifest and gives the proposal.
  const tree = mkdtempSync(join(root, "tree-"));
  mkdirSync(join(tree, "scripts", "ci", "shared"), { recursive: true });
  copyFileSync(manifest, join(tree, "scripts", "ci", "shared", "client-acceptance.json"));
  const applied = spawnSync("git", ["apply", join(output, "client-acceptance.diff")], { cwd: tree, encoding: "utf8", timeout: 10_000 });
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(readFileSync(join(tree, "scripts", "ci", "shared", "client-acceptance.json"), "utf8"), proposal);

  // A pull request reads the proposal as it reads the manifest: npm-matrix verifies each npm pin and the Cursor App and
  // WorkBuddy accepted matrices run the new versions.
  for (const client of NPM) {
    const section = readAcceptance(client, file);
    const matrix = await acceptanceCli(["npm-matrix", client], { env: {}, npm: fakeNpm(root, recorded(section)), file });
    assert.deepEqual(matrix.include.filter((cell) => cell.channel === "accepted").map((cell) => cell[client]),
      Array(3).fill(expected.clients[client].accepted.version), client);
  }
  assert.deepEqual(cursorMatrix(acceptedReleases(readAcceptance("cursor", file))).include.filter((cell) => cell.channel === "accepted")
    .map((cell) => [cell.os, cell.cursor]), [["ubuntu-24.04", "3.27.22"], ["macos-15", "3.27.22"], ["windows-2025", "3.27.22"]]);
  assert.deepEqual(workbuddyMatrix(readAcceptance("workbuddy", file)).include.filter((cell) => cell.release.channel === "accepted")
    .map((cell) => [cell.os, cell.release.desktopVersion]), [["ubuntu-24.04", "5.6.2.40046327"]]);

  // The summary has one row per decision.
  const summary = render(refresh).split("\n");
  assert.equal(summary[0], "### Client acceptance refresh: 6 candidates");
  assert.equal(summary.filter((line) => /^\| [a-z]/.test(line)).length, 8);
  assert.ok(summary.includes(`| codex | 0.166.0 | ${BASELINES.codex.baseline.version} | candidate | none |`));
  assert.ok(summary.includes(`| workbuddy linux-x64-deb | 5.6.2.40046327 | ${
    BASELINES.workbuddy.baseline.platforms["linux-x64-deb"].desktop.version} | candidate | download SHA-256 match |`));
  assert.ok(summary.includes(`| workbuddy darwin-arm64 | 5.9.3.42398134 | ${BASELINES.workbuddy.baseline.platforms["darwin-arm64"].desktop
    .version} | not-candidate | DEFERRED; CELL_NOT_PASSED: ${WORKBUDDY_LATEST("macos-15")} is client-release-deferred |`));
});

test("an accepted, older or deferred version and a later attempt propose nothing for their client, and no candidate leaves the checkout as it is", (t) => {
  const root = scratch(t);
  const baseline = manifestOf(root);
  const first = proposeFrom(root, baseline, inputsOf(root, baseline));
  // The checkout after the proposal was applied: every candidate is now accepted.
  const applied = join(mkdtempSync(join(root, "applied-")), "client-acceptance.json");
  copyFileSync(join(first.output, "client-acceptance.proposed.json"), applied);
  const unchanged = proposeFrom(root, applied, inputsOf(root, applied));
  assert.deepEqual(outcomes(unchanged.refresh), Object.fromEntries(Object.entries(CANDIDATES)
    .map(([key, [decision, ...rest]]) => [key, decision === "candidate" ? ["unchanged", ...rest] : [decision, ...rest]])));
  assert.equal(unchanged.refresh.changed, false);
  assert.equal(readFileSync(join(unchanged.output, "client-acceptance.proposed.json"), "utf8"), readFileSync(applied, "utf8"));
  assert.equal(readFileSync(join(unchanged.output, "client-acceptance.diff"), "utf8"), "");
  assert.match(render(unchanged.refresh), /^### Client acceptance refresh: 0 candidates$/m);

  const deferral = { version: "0.166.0", date: "2026-10-30", runs: [], reason: "Fixture deferral." };
  for (const [change, codex] of [
    [(m) => { m.clients.codex.accepted.version = "0.167.0"; }, ["not-candidate", "0.166.0", "LATEST_OLDER_THAN_ACCEPTED"]],
    [(m) => { m.clients.codex.deferred = [deferral]; }, ["not-candidate", "0.166.0", "DEFERRED"]],
    // npm cells name no release platform, so a deferral that lists platforms never defers an npm version.
    [(m) => { m.clients.codex.deferred = [{ ...deferral, platforms: ["win32-x64-user"] }]; }, CANDIDATES.codex],
  ]) {
    const manifest = manifestOf(root, change);
    assert.deepEqual(outcomes(proposeFrom(root, manifest, inputsOf(root, manifest)).refresh), { ...CANDIDATES, codex }, String(change));
  }
  // A re-run's attempt reads none of the artifacts, because the jobs that passed before keep their earlier attempt's names.
  const manifest = manifestOf(root);
  const later = proposeFrom(root, manifest, inputsOf(root, manifest), { GITHUB_RUN_ATTEMPT: "2" });
  assert.deepEqual(Object.values(outcomes(later.refresh)), Array(8).fill(["not-candidate", null, "LATER_ATTEMPT"]));
  assert.deepEqual([later.refresh.run.attempt, later.refresh.changed], [2, false]);
});

test("a fallback release, a failed or missing cell and a record with issues leave their client without a candidate", (t) => {
  const root = scratch(t);
  const manifest = manifestOf(root);
  const windows = WORKBUDDY_LATEST("windows-2025"), drop = (name) => (page) => {
    page.jobs = page.jobs.filter((job) => job.name !== name);
    page.total_count = page.jobs.length;
  };
  for (const [edits, expected] of [
    // The Windows fallback is never accepted, even when its cell passed.
    [{ matrices: (rows) => {
      rows.workbuddy.include.find((row) => row.os === "windows-2025" && row.release.channel === "latest").release.channel = "fallback";
    }, listing: set(windows, { name: windows.replace(", latest, ", ", fallback, "), conclusion: "success" }) },
    { "workbuddy win32-x64-user": ["not-candidate", "5.9.3.42398134", "FALLBACK"] }],
    [{ listing: (page) => {
      set("Codex latest 0.166.0 (windows-2025, Node 24)", { conclusion: "failure" })(page);
      set("Cursor App latest 3.27.22 (macos-15, Node 24)", { conclusion: "cancelled" })(page);
    } }, { codex: ["not-candidate", "0.166.0", "CELL_NOT_PASSED: Codex latest 0.166.0 (windows-2025, Node 24) is client-release-new"],
      cursor: ["not-candidate", "3.27.22", "CELL_NOT_PASSED: Cursor App latest 3.27.22 (macos-15, Node 24) is not-completed"] }],
    // A cell missing from the listing, and a runner missing from the matrix.
    [{ listing: drop("OpenCode latest 1.19.5 (macos-15, Node 24)"),
      matrices: (rows) => { rows.claude.include = rows.claude.include.filter((row) => !(row.channel === "latest" && row.os === "windows-2025")); } },
    { opencode: ["not-candidate", "1.19.5", "CELL_NOT_PASSED: OpenCode latest 1.19.5 (macos-15, Node 24) is missing"],
      claude: ["not-candidate", "2.1.314", "CELL_MISSING: windows-2025"] }],
    // An incomplete listing fails every result record.
    [{ listing: (page) => { page.total_count += 1; } }, Object.fromEntries(Object.keys(CANDIDATES)
      .map((key) => [key, ["not-candidate", null, "RESULT_ISSUES: LISTING_INCOMPLETE"]]))],
  ]) {
    const { refresh } = proposeFrom(root, manifest, inputsOf(root, manifest, edits));
    assert.deepEqual(outcomes(refresh), { ...CANDIDATES, ...expected }, JSON.stringify(Object.keys(expected)));
  }
  const { refresh } = proposeFrom(root, manifest, inputsOf(root, manifest, { listing: set("Cursor App latest 3.27.22 (macos-15, Node 24)",
    { conclusion: "failure" }) }));
  // A client without a passing version reads nothing more.
  assert.deepEqual(refresh.clients.cursor.sources, ["client-result-cursor-attempt1"]);
});

test("a missing or foreign artifact leaves only the clients that need it without a candidate", (t) => {
  const root = scratch(t);
  const manifest = manifestOf(root);
  const npm = (reason) => Object.fromEntries(NPM.map((client) => [client, ["not-candidate", CANDIDATES[client][1], reason]]));
  const workbuddyMatrix = (change) => {
    const rows = structuredClone(RUN.workbuddyMatrix);
    change(rows.include.find(({ release }) => release.platform === "linux-x64-deb" && release.channel === "latest").release);
    return JSON.stringify(rows);
  };
  for (const [label, change, expected, env] of [
    ["no result record", (dir) => rmSync(join(dir, "client-result", "client-result-codebuddy-attempt1.json")),
      { codebuddy: ["not-candidate", null, "RESULT_MISSING"] }],
    ["another client's record", (dir) => copyFileSync(join(dir, "client-result", "client-result-codex-attempt1.json"),
      join(dir, "client-result", "client-result-cursor-attempt1.json")), { cursor: ["not-candidate", null, "RESULT_INVALID"] }],
    ["no input record", (dir) => rmSync(join(dir, "native-client-inputs", "native-client-inputs.json")), npm("INPUTS_MISSING")],
    ["another attempt's input record", (dir) => editJson(join(dir, "native-client-inputs", "native-client-inputs.json"),
      (value) => ({ ...value, source: { ...value.source, runAttempt: "2" } })), npm("INPUTS_INVALID")],
    ["an input record from another commit", (dir) => editJson(join(dir, "native-client-inputs", "native-client-inputs.json"),
      (value) => ({ ...value, source: { ...value.source, sha: "0".repeat(40) } })), npm("INPUTS_INVALID")],
    ["a failed latest lookup", (dir) => editJson(join(dir, "native-client-inputs", "native-client-inputs.json"), (value) => {
      value.clients.codex.versions.find((item) => item.version === "0.166.0").lookup = "FAILED";
      return value;
    }), { codex: ["not-candidate", "0.166.0", "INPUTS_VERSION_MISSING"] }],
    ["a lookup in another registry", (dir) => editJson(join(dir, "native-client-inputs", "native-client-inputs.json"), (value) => {
      value.clients.codex.registry = "https://registry.example.invalid/";
      return value;
    }), { codex: ["not-candidate", "0.166.0", "INPUTS_VERSION_MISSING"] }],
    ["no inventory", (dir) => rmSync(join(dir, "cursor-app-releases", "cursor-app-releases.json")),
      { cursor: ["not-candidate", "3.27.22", "INVENTORY_MISSING"] }],
    ["an inventory from two commits", (dir) => editJson(join(dir, "cursor-app-releases", "cursor-app-releases.json"), (value) => {
      value.latest["win32-x64-user"].commitSha = "0".repeat(40);
      return value;
    }), { cursor: ["not-candidate", "3.27.22", "INVENTORY_INVALID"] }],
    ["no macOS report", (dir) => rmSync(join(dir, "cursor-app-reports", "cursor-app-macos-15-latest-node-24-report-attempt1"),
      { recursive: true }), { cursor: ["not-candidate", "3.27.22", "REPORT_MISSING: darwin-arm64"] }],
    ["a macOS report from another commit", (dir) => editJson(join(dir, "cursor-app-reports", "cursor-app-macos-15-latest-node-24-report-attempt1",
      "report.json"), (value) => ({ ...value, macos: { ...value.macos, commitSha: "0".repeat(40) } })),
    { cursor: ["not-candidate", "3.27.22", "REPORT_INVALID: darwin-arm64"] }],
    ["a failed Windows report", (dir) => editJson(join(dir, "cursor-app-reports", "cursor-app-windows-2025-latest-node-24-report-attempt1",
      "report.json"), (value) => ({ ...value, status: "FAIL" })), { cursor: ["not-candidate", "3.27.22", "REPORT_INVALID: win32-x64-user"] }],
    ["no WorkBuddy report", (dir) => rmSync(join(dir, "workbuddy-reports"), { recursive: true }),
      { "workbuddy linux-x64-deb": ["not-candidate", "5.6.2.40046327", "REPORT_MISSING"] }],
    ["a mismatched WorkBuddy download", (dir) => editJson(join(dir, "workbuddy-reports", "workbuddy-report-ubuntu-24.04-latest-node-24-attempt1",
      "report.json"), (value) => ({ ...value, sha256: { ...value.sha256, status: "mismatch" } })),
    { "workbuddy linux-x64-deb": ["not-candidate", "5.6.2.40046327", "REPORT_INVALID"] }],
    ["a WorkBuddy report from another run", (dir) => editJson(join(dir, "workbuddy-reports",
      "workbuddy-report-ubuntu-24.04-latest-node-24-attempt1", "report.json"), (value) => ({ ...value, runId: "1" })),
    { "workbuddy linux-x64-deb": ["not-candidate", "5.6.2.40046327", "REPORT_INVALID"] }],
    // Latest cells of two versions cannot come from one matrix.
    ["a record with two latest versions", (dir) => editJson(join(dir, "client-result", "client-result-codex-attempt1.json"), (value) => {
      value.cells.find((cell) => cell.channel === "latest" && cell.cell.startsWith("windows-2025, ")).version = "0.166.1";
      return value;
    }), { codex: ["not-candidate", null, "LATEST_VERSION_AMBIGUOUS"] }],
    ["a record without the WorkBuddy cell", (dir) => editJson(join(dir, "client-result", "client-result-workbuddy-attempt1.json"),
      (value) => ({ ...value, cells: value.cells.filter((cell) => !(cell.channel === "latest" && cell.cell.startsWith("ubuntu-24.04, "))) })),
    { "workbuddy linux-x64-deb": ["not-candidate", "5.6.2.40046327",
      "CELL_MISSING: WorkBuddy native (ubuntu-24.04, Node 24, latest, 5.6.2.40046327)"] }],
    ["no WorkBuddy matrix", () => {}, Object.fromEntries(["linux-x64-deb", "darwin-arm64", "win32-x64-user"]
      .map((platform) => [`workbuddy ${platform}`, ["not-candidate", null, "MATRIX_MISSING"]])), { WORKBUDDY_MATRIX: "" }],
    ["a plain HTTP download", () => {}, { "workbuddy linux-x64-deb": ["not-candidate", "5.6.2.40046327", "MATRIX_INVALID"] },
      { WORKBUDDY_MATRIX: workbuddyMatrix((release) => { release.url = release.url.replace(/^https:/, "http:"); }) }],
  ]) {
    const inputs = inputsOf(root, manifest);
    change(inputs.dir);
    const { refresh } = proposeFrom(root, manifest, inputs, env);
    assert.deepEqual(outcomes(refresh), { ...CANDIDATES, ...expected }, label);
  }
});

test("only a broken contract fails the step: it still writes refresh.json and the summary, and never a partial proposal", (t) => {
  const root = scratch(t);
  const manifest = manifestOf(root);
  const inputs = inputsOf(root, manifest);
  const cli = (args, env) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", timeout: 20_000,
    env: { PATH: process.env.PATH, ...inputs.env, ...env } });
  const args = (output) => ["propose", "--inputs", inputs.dir, "--output", output, "--github-summary", join(output, "summary.md")];
  // The command decides against the checkout's own manifest.
  const ok = join(root, "ok");
  const passed = cli(args(ok));
  assert.deepEqual([passed.status, passed.stdout, passed.stderr], [0, "", ""]);
  const refresh = JSON.parse(readFileSync(join(ok, "refresh.json"), "utf8"));
  assert.equal(readFileSync(join(ok, "summary.md"), "utf8"), render(refresh));
  assert.ok(existsSync(join(ok, "client-acceptance.proposed.json")) && existsSync(join(ok, "client-acceptance.diff")));
  // Only the compatibility monitor proposes.
  const push = join(root, "push");
  const failed = cli(args(push), { GITHUB_EVENT_NAME: "push" });
  assert.deepEqual([failed.status, failed.stdout], [1, "::error title=Client acceptance refresh::REFRESH_RUN_INVALID\n"]);
  assert.deepEqual(JSON.parse(readFileSync(join(push, "refresh.json"), "utf8")), { schemaVersion: 1, run: { id: RUN.run.id, attempt: 1 },
    error: "REFRESH_RUN_INVALID" });
  assert.equal(readFileSync(join(push, "summary.md"), "utf8"),
    "### Client acceptance refresh: **contract error**\n\nREFRESH_RUN_INVALID. Nothing was proposed.\n\n");
  assert.ok(!existsSync(join(push, "client-acceptance.proposed.json")));
  for (const usage of [["propose"], ["propose", "--inputs", inputs.dir], ["refresh", "--inputs", inputs.dir, "--output", push],
    ["propose", "--inputs", inputs.dir, "--output"]]) {
    const actual = cli(usage);
    assert.equal(actual.status, 1, usage.join(" "));
    assert.match(actual.stderr, /^::error title=Client acceptance refresh::Usage: client-acceptance-refresh\.mjs propose /, usage.join(" "));
  }
  // A manifest that cannot be read, and a proposal that the acceptance reader rejects, which is removed.
  const output = join(root, "invalid");
  assert.throws(() => propose({ inputs: inputs.dir, output, env: inputs.env, now: NOW, manifest: join(root, "missing.json") }),
    { code: "REFRESH_MANIFEST_INVALID:CLIENT_ACCEPTANCE_UNREADABLE" });
  const unpinned = join(mkdtempSync(join(root, "manifest-")), "client-acceptance.json");
  writeFileSync(unpinned, JSON.stringify({ ...JSON.parse(readFileSync(manifest, "utf8")), node: { 24: "24" } }));
  assert.throws(() => propose({ inputs: inputs.dir, output, env: inputs.env, now: NOW, manifest: unpinned }),
    { code: "REFRESH_PROPOSAL_INVALID:CLIENT_ACCEPTANCE_NODE_INVALID" });
  assert.ok(!existsSync(join(output, "client-acceptance.proposed.json")) && !existsSync(join(output, "refresh.json")));
});

test("only the compatibility monitor runs the refresh, on this attempt's artifacts, and it uploads the proposal without writing anything", () => {
  const job = WORKFLOW.split("\n  acceptance-refresh:\n")[1].split(/\n  [a-z][a-z0-9-]*:\n/)[0];
  assert.match(job, /^ {4}if: always\(\) && !cancelled\(\) && github\.event_name == 'schedule'$/m);
  assert.equal(job.match(/^ {4}needs: \[(.+)\]$/m)?.[1], ["package", "workbuddy-releases", "functional-result", "opencode-result",
    "claude-result", "codebuddy-result", "cursor-app-result", "workbuddy-result"].join(", "));
  assert.match(job, /^ {4}permissions:\n {6}contents: read\n {4}steps:\n/m);
  assert.match(job, /^ {10}persist-credentials: false$/m);
  assert.doesNotMatch(job, /git (?:commit|push)|gh pr|write-all|: write$/m);
  const steps = job.split("\n      - ").slice(1).map((step) => ({ uses: step.match(/^uses: (\S+)/)?.[1],
    ...Object.fromEntries([...step.matchAll(/^ {8,10}([A-Za-z_-]+): (.+)$/gm)].map(([, key, value]) => [key, value])) }));
  const temp = "${{ runner.temp }}/acceptance-refresh-inputs";
  const downloads = steps.filter((step) => step.uses === "actions/download-artifact@v8");
  assert.deepEqual(downloads, [
    { pattern: "client-result-*-attempt${{ github.run_attempt }}", path: `${temp}/client-result`, "merge-multiple": "true" },
    { name: "native-client-inputs-attempt${{ github.run_attempt }}", path: `${temp}/native-client-inputs` },
    { name: "cursor-app-releases-attempt${{ github.run_attempt }}", path: `${temp}/cursor-app-releases` },
    { pattern: "cursor-app-*-latest-*-report-attempt${{ github.run_attempt }}", path: `${temp}/cursor-app-reports` },
    { pattern: "workbuddy-report-*-attempt${{ github.run_attempt }}", path: `${temp}/workbuddy-reports` },
  ].map((download) => ({ uses: "actions/download-artifact@v8", "continue-on-error": "true", ...download })));
  // Every artifact the refresh read in the fixture run is uploaded under that name, and exactly one download fetches it.
  const uploads = [...WORKFLOW.matchAll(/^ {6}- uses: actions\/upload-artifact@v7\n(?: {8}.*\n)*/gm)]
    .map(([step]) => `${step.match(/^ {10}name: (.+)$/m)?.[1]} ${step.match(/^ {10}path: (.+)$/m)?.[1]}`);
  const fill = (template, row) => template.replaceAll("${{ github.run_attempt }}", "1")
    .replace(/\$\{\{ matrix\.([a-z.]+) \}\}/g, (_, path) => path.split(".").reduce((value, key) => value[key], row));
  const glob = (pattern) => new RegExp(`^${pattern.replaceAll("${{ github.run_attempt }}", "1").split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")}$`);
  const latest = (rows, channel) => rows.include.filter((row) => channel(row) === "latest");
  for (const [template, path, rows] of [
    ...Object.keys(CLIENTS).map((client) => [`client-result-${client}-attempt\${{ github.run_attempt }}`,
      `\${{ runner.temp }}/client-result/client-result-${client}-attempt\${{ github.run_attempt }}.json`, [{}]]),
    ["native-client-inputs-attempt${{ github.run_attempt }}", "${{ runner.temp }}/native-client-inputs.json", [{}]],
    ["cursor-app-releases-attempt${{ github.run_attempt }}", "${{ runner.temp }}/cursor-app-releases.json", [{}]],
    ["cursor-app-${{ matrix.os }}-${{ matrix.channel }}-node-${{ matrix.node }}-report-attempt${{ github.run_attempt }}",
      "${{ runner.temp }}/cursor-app-report/report.json", latest(MATRICES.cursor, (row) => row.channel).filter((row) => row.os !== "ubuntu-24.04")],
    ["workbuddy-report-${{ matrix.os }}-${{ matrix.release.channel }}-node-${{ matrix.node }}-attempt${{ github.run_attempt }}",
      "${{ runner.temp }}/workbuddy-report/report.json", latest(RUN.workbuddyMatrix, (row) => row.release.channel)
        .filter((row) => row.os === "ubuntu-24.04")],
  ]) {
    assert.ok(uploads.includes(`${template} ${path}`), template);
    for (const row of rows) {
      const name = fill(template, row);
      if (row.os) assert.ok(Object.hasOwn({ ...RUN.cursorReports, ...RUN.workbuddyReports }, name), name);
      assert.equal(downloads.filter((download) => (download.name ? fill(download.name, {}) === name : glob(download.pattern).test(name))).length,
        1, name);
    }
  }
  const propose = steps.find((step) => step.run?.startsWith("node scripts/ci/shared/client-acceptance-refresh.mjs "));
  assert.deepEqual(propose, { uses: undefined, shell: "bash", WORKBUDDY_MATRIX: "${{ needs.workbuddy-releases.outputs.matrix }}",
    run: 'node scripts/ci/shared/client-acceptance-refresh.mjs propose --inputs "$RUNNER_TEMP/acceptance-refresh-inputs" --output '
      + '"$RUNNER_TEMP/acceptance-refresh" --github-summary "$GITHUB_STEP_SUMMARY"' });
  assert.deepEqual(steps.at(-1), { uses: "actions/upload-artifact@v7", if: "always()", name: "client-acceptance-refresh-attempt${{ github.run_attempt }}",
    path: "${{ runner.temp }}/acceptance-refresh", "if-no-files-found": "warn", "retention-days": "30" });
});
