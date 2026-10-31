import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { MANIFEST } from "./client-acceptance.mjs";
import { CLIENTS, annotations, classify, decide, render } from "./client-result.mjs";

const FIXTURES = fileURLToPath(new URL("./fixtures/client-result/", import.meta.url));
const MATRICES = JSON.parse(readFileSync(join(FIXTURES, "matrices.json"), "utf8"));
const SCRIPT = fileURLToPath(new URL("./client-result.mjs", import.meta.url));
const WORKFLOW = readFileSync(new URL("../../../.github/workflows/macos-codex-install.yml", import.meta.url), "utf8")
  .replaceAll("\r\n", "\n");

// Real job listings, reduced to each job's id, name, conclusion, run_attempt and run_id, and every client's matrix in those
// runs. The WorkBuddy matrices and the pull request's npm matrices are the ones the runs printed; the others were rebuilt
// from the versions in the job names, in the order the workflow builds them, and each renders exactly its run's cell names.
// Each run lists its cells that did not succeed, with their classes, and the clients whose result fails.
const WORKBUDDY_LATEST = ["macos-15", "windows-2025"].map((os) => `WorkBuddy native (${os}, Node 24, latest, 5.9.3.42398134)`);
const DEFERRED = Object.fromEntries(WORKBUDDY_LATEST.map((name) => [name, "client-release-deferred"]));
const RUNS = [
  // Compatibility monitor on 24855d1e: Codex latest 0.165.0 failed on Windows, and WorkBuddy latest 5.9.3.42398134 failed
  // on macOS and Windows, where it is deferred.
  { id: "40853420771", attempt: 1, failing: ["codex"],
    failed: { codex: { "Codex latest 0.165.0 (windows-2025, Node 24)": "client-release-new" }, workbuddy: DEFERRED } },
  // Compatibility monitor on 410224bf: only the deferred WorkBuddy cells failed.
  { id: "41037250868", attempt: 1, failing: [], failed: { workbuddy: DEFERRED } },
  // Pull request on 822e3dcb: the Cursor App Windows baseline cell failed, and the re-run of that single job passed.
  { id: "41017240796", attempt: 1, failing: ["cursor"],
    failed: { cursor: { "Cursor App baseline 3.21.18 (windows-2025, Node 24)": "baseline-regression" } } },
  { id: "41017240796", attempt: 2, failing: [], failed: {} },
];
// A deferral like the one client-acceptance.json records for those WorkBuddy cells; no test depends on the manifest's
// current deferrals.
const DEFERRAL = { version: "5.9.3.42398134", platforms: ["darwin-arm64", "win32-x64-user"], date: "2026-10-28", runs: [],
  reason: "Fixture deferral." };

function scratch(t) {
  const root = mkdtempSync(join(tmpdir(), "client-result-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

// A copy of client-acceptance.json in which only these clients defer these entries.
function manifestWith(root, deferred = { workbuddy: [DEFERRAL] }) {
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
  for (const [client, section] of Object.entries(manifest.clients)) {
    if (deferred[client]) section.deferred = deferred[client];
    else delete section.deferred;
  }
  const file = join(mkdtempSync(join(root, "manifest-")), "client-acceptance.json");
  writeFileSync(file, JSON.stringify(manifest));
  return file;
}

// An API directory holding a fixture listing, after `change` edits its jobs, as the listing of attempt `as`.
function listing(root, id, attempt, { as = attempt, change } = {}) {
  const pages = JSON.parse(readFileSync(join(FIXTURES, `${id}-${attempt}.json`), "utf8"));
  change?.(pages[0].jobs);
  const dir = mkdtempSync(join(root, "api-"));
  writeFileSync(join(dir, `attempt-${as}.json`), JSON.stringify(pages));
  return dir;
}

// The result job's dependencies: this client's matrix output in the run and its matrix job's result.
function needsOf(id, client, result) {
  const { need, matrix: [source, output] } = CLIENTS[client];
  return { package: { result: "success", outputs: {} },
    [source]: { result: "success", outputs: { [output]: JSON.stringify(MATRICES[id][client]) } }, [need]: { result, outputs: {} } };
}
const envOf = (id, attempt, event = MATRICES[id].event) => ({ GITHUB_RUN_ID: id, GITHUB_RUN_ATTEMPT: String(attempt), GITHUB_EVENT_NAME: event });
const failures = (record) => Object.fromEntries(record.cells.filter((cell) => cell.class !== "passed").map((cell) => [cell.job, cell.class]));

test("real listings classify every cell by channel, conclusion and deferred version", (t) => {
  const root = scratch(t);
  const manifest = manifestWith(root);
  for (const { id, attempt, failing, failed } of RUNS) {
    const apiDir = listing(root, id, attempt);
    for (const client of Object.keys(CLIENTS)) {
      const expected = failed[client] ?? {}, where = `${id}/${attempt} ${client}`;
      const record = decide({ client, needs: needsOf(id, client, Object.keys(expected).length ? "failure" : "success"), apiDir,
        env: envOf(id, attempt), manifest });
      assert.equal(record.verdict, failing.includes(client) ? "FAIL" : "PASS", where);
      assert.equal(record.basis, MATRICES[id].event === "schedule" ? "cells" : "matrix-result", where);
      assert.deepEqual([record.listing, record.issues, record.cells.length], ["COMPLETE", [], 7], where);
      assert.deepEqual(failures(record), expected, where);
      for (const cell of record.cells) {
        assert.ok(Number.isSafeInteger(cell.id), `${where}: ${cell.job}`);
        assert.equal(cell.conclusion, expected[cell.job] ? "failure" : "success", `${where}: ${cell.job}`);
        // A pull request installs only the pinned baseline and accepted versions.
        if (MATRICES[id].event === "pull_request") assert.match(cell.channel, /^(?:baseline|accepted|baseline\+accepted)$/, where);
      }
    }
  }
});

test("a deferral covers only its client and version and, when it lists platforms, only cells on those release platforms", (t) => {
  const root = scratch(t);
  const [macos, windows] = WORKBUDDY_LATEST;
  const workbuddy = listing(root, "41037250868", 1);
  for (const [deferred, verdict, expected] of [
    [{}, "FAIL", { [macos]: "client-release-new", [windows]: "client-release-new" }],
    [{ workbuddy: [{ ...DEFERRAL, platforms: ["darwin-arm64"] }] }, "FAIL", { [macos]: "client-release-deferred", [windows]: "client-release-new" }],
    [{ workbuddy: [{ ...DEFERRAL, platforms: ["linux-x64-deb"] }] }, "FAIL", { [macos]: "client-release-new", [windows]: "client-release-new" }],
    [{ workbuddy: [{ ...DEFERRAL, version: "5.9.3.42398135" }] }, "FAIL", { [macos]: "client-release-new", [windows]: "client-release-new" }],
    [{ codex: [DEFERRAL] }, "FAIL", { [macos]: "client-release-new", [windows]: "client-release-new" }],
    [{ workbuddy: [{ ...DEFERRAL, platforms: undefined }] }, "PASS", DEFERRED],
  ]) {
    const record = decide({ client: "workbuddy", needs: needsOf("41037250868", "workbuddy", "failure"), apiDir: workbuddy,
      env: envOf("41037250868", 1), manifest: manifestWith(root, deferred) });
    assert.deepEqual([record.verdict, failures(record), record.issues], [verdict, expected, []], JSON.stringify(deferred));
  }
  // npm cells name no release platform, so only an entry without platforms defers their version.
  const codex = listing(root, "40853420771", 1);
  const cell = "Codex latest 0.165.0 (windows-2025, Node 24)";
  for (const [platforms, verdict, expected] of [[undefined, "PASS", "client-release-deferred"], [["win32-x64-user"], "FAIL", "client-release-new"],
    [["darwin-arm64"], "FAIL", "client-release-new"]]) {
    const record = decide({ client: "codex", needs: needsOf("40853420771", "codex", "failure"), apiDir: codex, env: envOf("40853420771", 1),
      manifest: manifestWith(root, { codex: [{ ...DEFERRAL, version: "0.165.0", platforms }] }) });
    assert.deepEqual([record.verdict, failures(record)], [verdict, { [cell]: expected }], String(platforms));
  }
  // A manifest that cannot be read or validated defers nothing.
  const invalid = manifestWith(root, { workbuddy: [{ ...DEFERRAL, date: "28 October" }] });
  for (const [manifest, code] of [[join(root, "missing.json"), "CLIENT_ACCEPTANCE_UNREADABLE"], [invalid, "CLIENT_ACCEPTANCE_INVALID"]]) {
    const record = decide({ client: "workbuddy", needs: needsOf("41037250868", "workbuddy", "failure"), apiDir: workbuddy,
      env: envOf("41037250868", 1), manifest });
    assert.deepEqual([record.verdict, failures(record), record.issues],
      ["FAIL", { [macos]: "client-release-new", [windows]: "client-release-new" }, [`DEFERRED_UNREADABLE:${code}`]], code);
  }
});

test("only the compatibility monitor passes deferred cells; every other run follows the matrix result", (t) => {
  const root = scratch(t);
  const manifest = manifestWith(root);
  const apiDir = listing(root, "41037250868", 1);
  for (const event of ["workflow_dispatch", "pull_request", "push"]) {
    const record = decide({ client: "workbuddy", needs: needsOf("41037250868", "workbuddy", "failure"), apiDir,
      env: envOf("41037250868", 1, event), manifest });
    assert.deepEqual([record.verdict, record.basis, failures(record)], ["FAIL", "matrix-result", DEFERRED], event);
    assert.deepEqual(annotations(record), ["::error::The entire WorkBuddy matrix must succeed. Failed, cancelled or skipped dependencies do not pass this check."]);
  }
});

test("an unreadable or foreign listing fails the monitor and leaves every other run to the matrix result", (t) => {
  const root = scratch(t);
  const directory = (files) => {
    const dir = mkdtempSync(join(root, "api-"));
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    return dir;
  };
  for (const [status, apiDir, id = "41037250868", attempt = 1] of [
    ["QUERY_FAILED", directory({ "attempt-1.failed": "" })],
    ["MISSING", undefined],
    ["MISSING", directory({})],
    ["EMPTY", directory({ "attempt-1.json": "" })],
    ["INVALID", directory({ "attempt-1.json": "{}" })],
    ["INCOMPLETE", listing(root, "41037250868", 1, { change: (jobs) => jobs.pop() })],
    // Attempt 2's listing read as attempt 1, and a listing of another run.
    ["MISMATCH", listing(root, "41017240796", 2, { as: 1 }), "41017240796"],
    ["MISMATCH", listing(root, "41037250868", 1), "40853420771"],
  ]) {
    const needs = needsOf("41037250868", "opencode", "success");
    const monitor = decide({ client: "opencode", needs, apiDir, env: envOf(id, attempt, "schedule") });
    assert.deepEqual([monitor.verdict, monitor.listing, monitor.issues], ["FAIL", status, [`LISTING_${status}`]], status);
    assert.deepEqual(monitor.cells.map((cell) => cell.class), Array(7).fill("unread"), status);
    assert.deepEqual(annotations(monitor), [`::error title=OpenCode matrix cells::LISTING_${status}`], status);
    const pullRequest = decide({ client: "opencode", needs, apiDir, env: envOf(id, attempt, "pull_request") });
    assert.deepEqual([pullRequest.verdict, pullRequest.basis, pullRequest.listing], ["PASS", "matrix-result", status], status);
  }
});

test("a missing, duplicated, regressed or incomplete cell fails the monitor", (t) => {
  const root = scratch(t);
  const manifest = manifestWith(root);
  const names = MATRICES["41037250868"].codex.include.map(CLIENTS.codex.name);
  const baseline = names.find((name) => name.startsWith("Codex baseline ")), latest = names.find((name) => name.startsWith("Codex latest "));
  const set = (name, fields) => (jobs) => Object.assign(jobs.find((job) => job.name === name), fields);
  const cases = [
    ["codex", latest, "missing", set(latest, { name: `${latest} renamed` })],
    ["codex", latest, "ambiguous", (jobs) => { jobs.find((job) => !job.name.startsWith("Codex ")).name = latest; }],
    ["codex", baseline, "baseline-regression", set(baseline, { conclusion: "failure" })],
    ...["cancelled", "timed_out", "skipped", null].map((conclusion) => ["codex", latest, "not-completed", set(latest, { conclusion })]),
    // A deferred version that did not complete is not deferred.
    ["workbuddy", WORKBUDDY_LATEST[0], "not-completed", set(WORKBUDDY_LATEST[0], { conclusion: "cancelled" })],
  ];
  for (const [client, name, expected, change] of cases) {
    const record = decide({ client, needs: needsOf("41037250868", client, "failure"), env: envOf("41037250868", 1),
      apiDir: listing(root, "41037250868", 1, { change }), manifest });
    const where = `${name}: ${expected}`;
    assert.equal(record.verdict, "FAIL", where);
    assert.equal(record.cells.find((cell) => cell.job === name).class, expected, where);
    assert.ok(annotations(record).some((line) => line.startsWith(`::error title=${expected}::${name}`)), where);
  }
});

test("the monitor needs its matrix output and a matrix result that the cells explain", (t) => {
  const root = scratch(t);
  const manifest = manifestWith(root);
  const apiDir = listing(root, "41037250868", 1);
  for (const value of [undefined, "", "not json", JSON.stringify({ include: [] })]) {
    const needs = needsOf("41037250868", "codex", "success");
    needs.package.outputs["codex-matrix"] = value;
    const monitor = decide({ client: "codex", needs, apiDir, env: envOf("41037250868", 1) });
    assert.deepEqual([monitor.verdict, monitor.issues, monitor.cells], ["FAIL", ["MATRIX_MISSING"], []], String(value));
    const pullRequest = decide({ client: "codex", needs, apiDir, env: envOf("41037250868", 1, "pull_request") });
    assert.equal(pullRequest.verdict, "PASS", String(value));
  }
  for (const [client, result, verdict] of [["codex", "success", "PASS"], ["codex", "failure", "FAIL"], ["codex", "cancelled", "FAIL"],
    ["codex", "skipped", "FAIL"], ["workbuddy", "failure", "PASS"], ["workbuddy", "success", "FAIL"], ["workbuddy", "cancelled", "FAIL"]]) {
    const record = decide({ client, needs: needsOf("41037250868", client, result), apiDir, env: envOf("41037250868", 1), manifest });
    assert.deepEqual([record.verdict, record.issues], [verdict, verdict === "PASS" ? [] : [`MATRIX_RESULT_UNEXPLAINED:${result}`]], `${client} ${result}`);
  }
});

test("a failure is classified by channel, and deferrals are consulted only for a failed latest release or fallback", () => {
  for (const [channel, conclusion, deferred, expected, consulted] of [
    ["baseline", "success", true, "passed", false],
    ["latest", "success", true, "passed", false],
    ["baseline", "failure", true, "baseline-regression", false],
    ["accepted", "failure", true, "baseline-regression", false],
    ["baseline+accepted", "failure", true, "baseline-regression", false],
    ["baseline+latest", "failure", true, "baseline-regression", false],
    ["latest", "failure", true, "client-release-deferred", true],
    ["fallback", "failure", true, "client-release-deferred", true],
    ["latest", "failure", false, "client-release-new", true],
    ["fallback", "failure", false, "client-release-new", true],
    ["nightly", "failure", true, "client-release-new", false],
    ...["cancelled", "timed_out", "skipped", "neutral", null].flatMap((value) => [["baseline+latest", value, true, "not-completed", false],
      ["latest", value, true, "not-completed", false]]),
  ]) {
    let calls = 0;
    assert.equal(classify(channel, conclusion, () => { calls += 1; return deferred; }), expected, `${channel} ${conclusion}`);
    assert.equal(calls, consulted ? 1 : 0, `${channel} ${conclusion}`);
  }
});

test("the monitor annotates each deferred and failing cell, every other run keeps one matrix error, and the summary has one row per cell", (t) => {
  const root = scratch(t);
  const manifest = manifestWith(root);
  const run = (id, attempt, client, result) => decide({ client, needs: needsOf(id, client, result), apiDir: listing(root, id, attempt),
    env: envOf(id, attempt), manifest });
  const workbuddy = run("40853420771", 1, "workbuddy", "failure");
  assert.deepEqual(annotations(workbuddy), WORKBUDDY_LATEST.map((name) => `::notice title=client-release-deferred::${name} concluded failure: `
    + "the version is deferred in scripts/ci/shared/client-acceptance.json."));
  assert.deepEqual(annotations(run("40853420771", 1, "codex", "failure")), ["::error title=client-release-new::Codex latest 0.165.0 "
    + "(windows-2025, Node 24) concluded failure: register the signature in docs/native-ci-failure-register.md first, then defer the "
    + "version in scripts/ci/shared/client-acceptance.json or fix it."]);
  const cursor = run("41017240796", 1, "cursor", "failure");
  assert.deepEqual(annotations(cursor), ["::error::The entire Cursor App canary must succeed. Failed, cancelled or skipped dependencies do not pass this check."]);
  assert.deepEqual(annotations(run("41017240796", 2, "cursor", "success")), []);
  const summary = render(workbuddy).split("\n");
  assert.equal(summary[0], "### WorkBuddy matrix cells: **PASS**");
  assert.ok(summary.includes("Job listing of this attempt: COMPLETE. Issues: none."));
  assert.equal(summary.filter((line) => line.startsWith("| ") && !/^\| (?:Cell|---) /.test(line)).length, 7);
  assert.ok(summary.includes("| macos-15, Node 24 | latest | 5.9.3.42398134 | failure | client-release-deferred |"));
  assert.ok(summary.includes("| ubuntu-24.04, Node 20 | baseline | 5.5.6.38337834 | success | passed |"));
  assert.ok(render(cursor).includes("| windows-2025, Node 24 | baseline | 3.21.18 | failure | baseline-regression |"));
  assert.match(render(cursor), /^This pull_request run requires the entire Cursor App canary to succeed; the classes are reported only\.$/m);
});

test("the CLI always writes the record and summary and exits 0 only for a passing result", (t) => {
  const root = scratch(t);
  const cli = (args, env) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", timeout: 10_000, env: { PATH: process.env.PATH, ...env } });
  const decideArgs = (client, needs, apiDir, label) => ["decide", "--client", client, "--needs", needs, "--api-dir", apiDir,
    "--output", join(root, label, "record.json"), "--github-summary", join(root, `${label}.md`)];
  const read = (label) => [JSON.parse(readFileSync(join(root, label, "record.json"), "utf8")), readFileSync(join(root, `${label}.md`), "utf8")];
  for (const [attempt, result, status] of [[1, "failure", 1], [2, "success", 0]]) {
    const needs = needsOf("41017240796", "cursor", result), apiDir = listing(root, "41017240796", attempt), env = envOf("41017240796", attempt);
    const actual = cli(decideArgs("cursor", JSON.stringify(needs), apiDir, `attempt-${attempt}`), env);
    assert.equal(actual.status, status, actual.stderr);
    const record = decide({ client: "cursor", needs, apiDir, env });
    assert.deepEqual(read(`attempt-${attempt}`), [record, render(record)]);
    assert.equal(actual.stdout, annotations(record).map((line) => `${line}\n`).join(""));
  }
  // Undecidable input still writes a failing record.
  for (const [client, needs, issue] of [["cursor", "{", "DECIDE_FAILED:SyntaxError"], ["nightly", "{}", "DECIDE_FAILED:CLIENT_RESULT_CLIENT_UNKNOWN"]]) {
    const actual = cli(decideArgs(client, needs, root, client), envOf("41017240796", 1));
    assert.equal(actual.status, 1, issue);
    const [record, summary] = read(client);
    assert.deepEqual([record.verdict, record.issues, record.cells], ["FAIL", [issue], []], issue);
    assert.match(summary, /^### .+ cells: \*\*FAIL\*\*$/m, issue);
    assert.match(actual.stdout, new RegExp(`^::error title=.+ cells::${issue}$`, "m"), issue);
  }
  for (const args of [["record", "--output", join(root, "record.json")], ["decide", "--client"], ["decide", "--client", "cursor"]]) {
    const actual = cli(args, envOf("41017240796", 1));
    assert.equal(actual.status, 1, args.join(" "));
    assert.match(actual.stderr, /^::error title=Client result::Usage: client-result\.mjs decide /, args.join(" "));
  }
});

test("each client's cell names and matrix source match its workflow matrix job", () => {
  for (const [client, spec] of Object.entries(CLIENTS)) {
    const parts = WORKFLOW.split(`\n  ${spec.need}:\n`);
    assert.equal(parts.length, 2, client);
    const job = parts[1].split(/\n  [a-z][a-z0-9-]*:\n/)[0];
    assert.ok(job.includes(`\n      matrix: \${{ fromJSON(needs.${spec.matrix[0]}.outputs.${spec.matrix[1]}) }}\n`), client);
    const template = job.match(/^    name: (.+)$/m)?.[1];
    assert.ok(template, client);
    for (const { [client]: { include } } of Object.values(MATRICES)) {
      for (const row of include) {
        assert.equal(spec.name(row), template.replace(/\$\{\{ matrix\.([a-zA-Z.]+) \}\}/g,
          (_, path) => String(path.split(".").reduce((value, key) => value?.[key], row))), client);
      }
    }
  }
});
