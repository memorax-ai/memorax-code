import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { crc32, deflateRawSync } from "node:zlib";
import { CLIENTS } from "./client-result.mjs";
import { RESULT_JOBS, cellOf, confirm, decide, failureOf, readRegistered, render, runCli, zipMembers } from "./native-auto-recheck.mjs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8").replaceAll("\r\n", "\n");
const MATRICES = JSON.parse(read("./fixtures/client-result/matrices.json"));
const REGISTER = read("../../../docs/native-ci-failure-register.md");
const NATIVE = read("../../../.github/workflows/macos-codex-install.yml");
const WORKFLOW = read("../../../.github/workflows/native-auto-recheck.yml");
const REPOSITORY = "memorax-ai/memorax-code";

// Run 41570380043 of pull request #260 as it stood when attempt 1 completed, before its recheck: attempt 1's job listing,
// reduced as in the client-result fixtures, and the evidence of its two failed cells, reduced to the fields the decision
// reads. The CodeBuddy baseline cell failed with S7's signature and the Codex accepted cell with S1's, the package job
// succeeded, and only their result jobs and PR acceptance failed besides. The pull request was open at the run's head,
// and run 41585762475 was the branch's next run.
const FIXTURE = JSON.parse(read("./fixtures/native-auto-recheck/41570380043-1.json"));
const RUN = String(FIXTURE.run.id);
const CODEBUDDY = "CodeBuddy functional baseline 2.159.0 (windows-2025, Node 24)";
const CODEX = "Codex accepted 0.166.0 (windows-2025, Node 24)";
const CODEX_EVIDENCE = "native-evidence-codex-windows-2025-accepted-node-24-attempt1";
const RUN_PATH = `repos/${REPOSITORY}/actions/runs/${RUN}`;
const ARTIFACTS = `repos/${REPOSITORY}/actions/runs/${RUN}/artifacts?per_page=100`;
const PULL = `repos/${REPOSITORY}/pulls/${FIXTURE.pull.number}`;
const RUNS = `repos/${REPOSITORY}/actions/workflows/${FIXTURE.run.workflow_id}/runs?event=pull_request&branch=fix%2Fmemorax-endpoint-migration&per_page=100`;
// A gh api call that exited with this standard error.
const gh = (stderr) => Object.assign(new Error("Command failed: gh api"), { status: 1, stderr: Buffer.from(stderr) });

const header = (size, fields) => {
  const buffer = Buffer.alloc(size);
  for (const [offset, bits, value] of fields) buffer[`writeUInt${bits}LE`](value, offset);
  return buffer;
};
// A zip archive of these members, laid out as upload-artifact writes an artifact; only method 8 is deflated, and `grow`
// overstates each member's size.
function zip(members, { method = 8, flags = 0, grow = 0 } = {}) {
  const parts = [], entries = [];
  let offset = 0;
  for (const [name, text] of members) {
    const data = Buffer.from(text), packed = method === 8 ? deflateRawSync(data) : data, file = Buffer.from(name);
    const sizes = [[14, 32, crc32(data)], [18, 32, packed.length], [22, 32, data.length + grow]];
    parts.push(header(30, [[0, 32, 0x04034b50], [6, 16, flags], [8, 16, method], ...sizes, [26, 16, file.length]]), file, packed);
    entries.push(header(46, [[0, 32, 0x02014b50], [8, 16, flags], [10, 16, method],
      ...sizes.map(([at, bits, value]) => [at + 2, bits, value]), [28, 16, file.length], [42, 32, offset]]), file);
    offset += 30 + file.length + packed.length;
  }
  const directory = Buffer.concat(entries);
  return Buffer.concat([...parts, directory, header(22, [[0, 32, 0x06054b50], [8, 16, members.length], [10, 16, members.length],
    [12, 32, directory.length], [16, 32, offset]])]);
}

// The GitHub API of the fixture run after `change` edits its state and `adjust` its responses. Each evidence entry becomes
// an artifact with its archive and digest; any other field of the entry replaces that artifact's listed metadata. A path
// ending in an entry of `unreadable` fails, a path ending in a key of `failing` first throws that key's errors in turn,
// and listings must be read as all their pages. The API keeps the paths it was asked for in `calls`.
function apiOf(change, adjust) {
  const state = structuredClone(FIXTURE);
  change?.(state);
  const archives = {}, artifacts = [];
  for (const [name, { id, inputs, summary, archive, ...metadata }] of Object.entries(state.evidence)) {
    const bytes = archive ?? zip([["inputs.json", JSON.stringify(inputs)], ["summary.json", JSON.stringify(summary)]]);
    archives[`repos/${REPOSITORY}/actions/artifacts/${id}/zip`] = bytes;
    artifacts.push({ id, name, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, expired: false,
      workflow_run: { id: Number(RUN) }, ...metadata });
  }
  const responses = {
    [RUN_PATH]: state.run,
    [`repos/${REPOSITORY}/actions/runs/${RUN}/attempts/1/jobs?per_page=100`]: state.listing,
    [ARTIFACTS]: [{ total_count: artifacts.length, artifacts }],
    [PULL]: state.pull,
    [RUNS]: state.runs,
  };
  adjust?.(responses);
  const calls = [];
  return Object.assign((path, { pages = false, raw = false } = {}) => {
    calls.push(path);
    if (state.unreadable?.some((suffix) => path.endsWith(suffix))) throw new Error(`unreadable: ${path}`);
    const failing = Object.entries(state.failing ?? {}).find(([suffix]) => path.endsWith(suffix))?.[1];
    if (failing?.length) throw failing.shift();
    if (raw) return archives[path];
    assert.ok(Object.hasOwn(responses, path), path);
    assert.equal(pages, Array.isArray(responses[path]), path);
    return structuredClone(responses[path]);
  }, { calls });
}
const decideWith = (change, adjust) => decide({ repository: REPOSITORY, runId: RUN, api: apiOf(change, adjust), sleep: () => {} });
const job = (state, name) => state.listing[0].jobs.find((item) => item.name === name);
function scratch(t) {
  const root = mkdtempSync(join(tmpdir(), "native-auto-recheck-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("each registered signature is a register entry with the same status on that entry's client and OS, never closed or deferred", () => {
  const rows = new Map(REGISTER.split("\n").filter((line) => /^\| S\d+ \|/.test(line)).map((line) => {
    const cells = line.split(/(?<!\\)\|/).slice(1, -1).map((cell) => cell.trim());
    return [cells[0], { signature: cells[1], status: cells.at(-1).replace(/^`(.*)`$/, "$1") }];
  }));
  const entries = readRegistered();
  for (const entry of entries) {
    const row = rows.get(entry.id);
    assert.ok(row, entry.id);
    assert.equal(entry.status, row.status, entry.id);
    const [, client, os] = /^`([a-z]+)\\\|([a-z0-9.-]+)\\\|/.exec(row.signature) ?? [];
    assert.ok(client && entry.signature.startsWith(`${client}|${os}|`), entry.id);
  }
  for (const [id, row] of rows) {
    if (/^(?:closed|deferred)\b/.test(row.status)) assert.ok(!entries.some((entry) => entry.id === id), id);
  }
});

test("the mirror lists open, observing or mitigated signatures once each, and an unreadable mirror holds the run", (t) => {
  const root = scratch(t);
  const write = (signatures) => {
    const file = join(mkdtempSync(join(root, "mirror-")), "registered-signatures.json");
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, signatures }));
    return file;
  };
  const entry = { id: "S9", signature: "codex|windows-2025|codex-install-smoke|stage|CODE", status: "open" };
  assert.equal(readRegistered(write([entry, { id: "S10", signature: "claude|macos-15|suite|stage|CODE", status: "observing #300" },
    { id: "S11", signature: "opencode|ubuntu-24.04|suite|stage|CODE", status: "mitigated #301" }])).length, 3);
  for (const signatures of [[], [{ ...entry, status: "closed: not seen since 2026-10-29 over 10 runs" }],
    [{ ...entry, status: "deferred 5.9.3.42398134" }], [entry, { ...entry, id: "S10" }], [entry, { ...entry, signature: "a|b|c|d|e" }],
    [{ ...entry, signature: "codex|windows-2025|codex-install-smoke" }], [{ ...entry, id: "1" }]]) {
    assert.throws(() => readRegistered(write(signatures)), /REGISTERED_SIGNATURES_INVALID/, JSON.stringify(signatures));
  }
  const record = decide({ repository: REPOSITORY, runId: RUN, api: apiOf(), registered: write([{ ...entry, status: "closed" }]) });
  assert.deepEqual(record.reasons, ["REGISTERED_SIGNATURES_INVALID", "SIGNATURE_UNREGISTERED"]);
});

test("each recorded cell name parses back into its client, channel, version, OS and Node major, and no other job is a cell", () => {
  for (const matrices of Object.values(MATRICES)) {
    for (const [client, spec] of Object.entries(CLIENTS)) {
      for (const row of matrices[client].include) {
        assert.deepEqual(cellOf(spec.name(row)), { client, channel: spec.channel(row), version: spec.version(row), os: row.os,
          node: String(row.node) });
      }
    }
  }
  assert.deepEqual(FIXTURE.listing[0].jobs.filter((item) => !cellOf(item.name)).map((item) => item.name).sort(), [...RESULT_JOBS,
    "Basic checks", "Client acceptance refresh (compatibility monitor)", "Native client scope",
    "OpenCode Windows initialization diagnostic (not functional acceptance)", "Release acceptance result", "Release candidate",
    "WorkBuddy releases", "package", "provider"].sort());
  assert.equal(cellOf("Codex ${{ matrix.channel }} ${{ matrix.codex }} (${{ matrix.os }}, Node ${{ matrix.node }})"), null);
});

test("a run that failed only in cells with registered signatures is rechecked", () => {
  const record = decideWith();
  assert.equal(record.decision, "recheck");
  assert.deepEqual(record.reasons, []);
  assert.deepEqual(record.run, { id: RUN, attempt: 1, event: "pull_request", head: FIXTURE.run.head_sha,
    branch: "fix/memorax-endpoint-migration", number: 296, workflow: FIXTURE.run.workflow_id, pullRequest: 260 });
  assert.deepEqual(record.retries, []);
  assert.deepEqual(record.cells.map((cell) => [cell.job, cell.artifact, cell.signature, cell.registered, cell.issue]), [
    [CODEBUDDY, "native-evidence-codebuddy-windows-2025-baseline-node-24-attempt1",
      "codebuddy|windows-2025|codebuddy-install-interruption-check|unknown|EXIT_1", "S7", null],
    [CODEX, CODEX_EVIDENCE, "codex|windows-2025|codex-install-smoke|cleanup:directory_removal|CLEANUP_DIRECTORY_REMOVAL_FAILED:EBUSY",
      "S1", null]]);
  assert.deepEqual(record.jobs.map((item) => [item.job, item.conclusion, item.allowed]), [["CodeBuddy functional result", "failure", true],
    ["Codex functional result", "failure", true], ["PR acceptance", "failure", true]]);
});

test("any other failure, unmatched evidence, incomplete cell, later attempt, moved head or newer run holds the run", () => {
  const codex = (edit) => (state) => edit(state.evidence[CODEX_EVIDENCE]);
  const cases = [
    ["SIGNATURE_UNREGISTERED", codex((evidence) => { evidence.summary.signature = "codex|windows-2025|codex-install-smoke|unknown|EXIT_1"; })],
    ["EVIDENCE_NOT_FAILED", codex((evidence) => { evidence.summary.testOutcome = "PASS"; })],
    ["PACKAGE_NOT_SUCCEEDED", (state) => { job(state, "package").conclusion = "failure"; }],
    ["JOB_NOT_RECHECKABLE", (state) => { job(state, "WorkBuddy releases").conclusion = "failure"; }],
    ["JOB_NOT_RECHECKABLE", (state) => { job(state, "Codex functional result").conclusion = "cancelled"; }],
    ["ARTIFACT_MISSING", (state) => { delete state.evidence[CODEX_EVIDENCE]; }],
    // Cursor and WorkBuddy cells upload no evidence, so a failure of theirs always holds.
    ["ARTIFACT_MISSING", (state) => { job(state, "Cursor App accepted 3.27.22 (windows-2025, Node 24)").conclusion = "failure"; }],
    ["ARTIFACT_MISSING", (state) => { job(state, "WorkBuddy native (windows-2025, Node 24, accepted, 5.8.3.41334564)").conclusion = "failure"; }],
    ["ARTIFACTS_INVALID", null, (responses) => { responses[ARTIFACTS][0].total_count += 1; }],
    ["ARTIFACT_IDENTITY_MISMATCH", codex((evidence) => { evidence.workflow_run = { id: FIXTURE.newerRun.id }; })],
    ["ARTIFACT_IDENTITY_MISMATCH", codex((evidence) => { evidence.expired = true; })],
    ["ARTIFACT_IDENTITY_MISMATCH", codex((evidence) => { evidence.digest = `sha256:${"0".repeat(64)}`; })],
    ["ARTIFACT_IDENTITY_MISMATCH", codex((evidence) => { evidence.inputs.source.runId = String(FIXTURE.newerRun.id); })],
    ["ARTIFACT_IDENTITY_MISMATCH", codex((evidence) => { evidence.inputs.source.runAttempt = "2"; })],
    ["ARTIFACT_IDENTITY_MISMATCH", codex((evidence) => { evidence.inputs.source.repository = "fork/memorax-code"; })],
    ["ARTIFACT_IDENTITY_MISMATCH", codex((evidence) => { evidence.summary.runAttempt = 2; })],
    ["ARTIFACT_IDENTITY_MISMATCH", codex((evidence) => { evidence.summary.channel = "baseline"; })],
    ["ARTIFACT_IDENTITY_MISMATCH", codex((evidence) => { evidence.summary.clientVersion = "0.147.0"; })],
    ["ARTIFACT_IDENTITY_MISMATCH", null, (responses) => {
      const [page] = responses[ARTIFACTS];
      page.artifacts.push({ ...page.artifacts.find((item) => item.name === CODEX_EVIDENCE), id: 1 });
      page.total_count += 1;
    }],
    ["EVIDENCE_INVALID", codex((evidence) => { evidence.archive = zip([["summary.json", JSON.stringify(evidence.summary)]]); })],
    ["CELL_NOT_COMPLETED", (state) => { job(state, CODEBUDDY).conclusion = "cancelled"; }],
    ["CELL_NOT_COMPLETED", (state) => { job(state, "Codex baseline 0.147.0 (windows-2025, Node 24)").conclusion = null; }],
    ["NO_FAILED_CELL", (state) => { for (const name of [CODEBUDDY, CODEX]) job(state, name).conclusion = "success"; }],
    ["RUN_NOT_FIRST_ATTEMPT", (state) => { state.run.run_attempt = 2; }],
    ["RUN_NOT_FAILED", (state) => { state.run.conclusion = "cancelled"; }],
    ["RUN_NOT_PULL_REQUEST", (state) => { state.run.event = "push"; }],
    ["RUN_NOT_NATIVE", (state) => { state.run.path = ".github/workflows/ci.yml"; }],
    ["RUN_HEAD_FOREIGN", (state) => { state.run.head_repository.full_name = "fork/memorax-code"; }],
    ["PULL_REQUEST_UNKNOWN", (state) => { state.run.pull_requests = []; }],
    ["PULL_REQUEST_NOT_OPEN", (state) => { state.pull.state = "closed"; }],
    ["HEAD_CHANGED", (state) => { state.pull.head.sha = "55fca975".padEnd(40, "0"); }],
    ["NEWER_RUN", (state) => { state.runs.workflow_runs.unshift(state.newerRun); }],
    ["RUNS_INVALID", (state) => { state.runs.workflow_runs = []; }],
    ["RUNS_INVALID", (state) => { delete state.runs.workflow_runs[0].run_number; }],
    ["LISTING_INVALID", (state) => { state.listing[0].total_count += 1; }],
    ["LISTING_INVALID", (state) => { job(state, "package").run_attempt = 2; }],
  ];
  for (const [reason, change, adjust] of cases) {
    const record = decideWith(change, adjust);
    assert.equal(record.decision, "hold", reason);
    assert.deepEqual(record.reasons, [reason], `${reason}: ${record.reasons}`);
  }
});

test("a read that fails holds the run", () => {
  for (const [reason, suffix] of [["RUN_UNREADABLE", `/actions/runs/${RUN}`], ["LISTING_UNREADABLE", "/attempts/1/jobs?per_page=100"],
    ["ARTIFACTS_UNREADABLE", `/runs/${RUN}/artifacts?per_page=100`], ["ARTIFACT_UNREADABLE", `/artifacts/${FIXTURE.evidence[CODEX_EVIDENCE].id}/zip`],
    ["PULL_REQUEST_UNREADABLE", `/pulls/${FIXTURE.pull.number}`], ["RUNS_UNREADABLE", "&per_page=100"]]) {
    const record = decideWith((state) => { state.unreadable = [suffix]; });
    assert.equal(record.decision, "hold", reason);
    assert.deepEqual(record.reasons, [reason], `${reason}: ${record.reasons}`);
  }
});

test("a read is retried only when gh got no response, a 5xx or a 429", () => {
  const url = `"https://api.github.com/${RUN_PATH}"`;
  for (const [error, failure, retry] of [
    [gh("gh: Server Error (HTTP 502)\n"), "HTTP 502", true],
    [gh("gh: HTTP 503\n"), "HTTP 503", true],
    [gh("gh: You have exceeded a secondary rate limit. (HTTP 429)\n"), "HTTP 429", true],
    [gh("gh: Not Found (HTTP 404)\n"), "HTTP 404", false],
    [gh("gh: Resource not accessible by integration (HTTP 403)\n"), "HTTP 403", false],
    [gh("gh: Gone (HTTP 410)\n"), "HTTP 410", false],
    [gh(`Get ${url}: net/http: TLS handshake timeout\n`), "network", true],
    [gh(`Get ${url}: EOF\n`), "network", true],
    [gh("error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com\n"), "network", true],
    [Object.assign(new Error("spawnSync gh ETIMEDOUT"), { code: "ETIMEDOUT" }), "network", true],
    [Object.assign(new Error("spawnSync gh ENOENT"), { code: "ENOENT" }), "other", false],
    [Object.assign(gh("gh: To use GitHub CLI in a GitHub Actions workflow, set the GH_TOKEN environment variable.\n"), { status: 4 }),
      "other", false],
    [new SyntaxError("Unexpected end of JSON input"), "other", false],
  ]) {
    assert.deepEqual(failureOf(error), { failure, retry }, `${failure}: ${error.stderr ?? error.message}`);
  }
});

test("a read that gets no response, a 5xx or a 429 is made up to three times, five seconds apart, and the record keeps its failures", () => {
  const decideFailing = (failing) => {
    const slept = [];
    const record = decide({ repository: REPOSITORY, runId: RUN, api: apiOf((state) => { state.failing = failing; }),
      sleep: (milliseconds) => slept.push(milliseconds) });
    return { record, slept };
  };
  const archive = `repos/${REPOSITORY}/actions/artifacts/${FIXTURE.evidence[CODEX_EVIDENCE].id}/zip`;
  let { record, slept } = decideFailing({ [ARTIFACTS]: [gh("gh: Server Error (HTTP 502)\n"), gh("gh: HTTP 504\n")],
    [archive]: [gh(`Get "https://api.github.com/${archive}": EOF\n`)] });
  assert.equal(record.decision, "recheck");
  assert.deepEqual(record.retries, [{ path: ARTIFACTS, attempts: 3, failures: ["HTTP 502", "HTTP 504"], outcome: "read" },
    { path: archive, attempts: 2, failures: ["network"], outcome: "read" }]);
  assert.deepEqual(slept, [5000, 5000, 5000]);
  assert.match(render(record), /^Reads that failed: `repos\/memorax-ai\/memorax-code\/actions\/runs\/41570380043\/artifacts\?per_page=100`: HTTP 502, HTTP 504, then read; `[^`]+\/zip`: network, then read\.$/m);

  // The third failure is final: no fourth request is made.
  const run = { [RUN_PATH]: [gh("gh: HTTP 502\n"), gh("gh: Too Many Requests (HTTP 429)\n"), gh(`Get "https://api.github.com/${RUN_PATH}": EOF\n`),
    gh("gh: HTTP 502\n")] };
  ({ record, slept } = decideFailing(run));
  assert.deepEqual(record.reasons, ["RUN_UNREADABLE"]);
  assert.deepEqual(record.retries, [{ path: RUN_PATH, attempts: 3, failures: ["HTTP 502", "HTTP 429", "network"], outcome: "unreadable" }]);
  assert.deepEqual(slept, [5000, 5000]);
  assert.equal(run[RUN_PATH].length, 1);
  assert.match(render(record), /`: HTTP 502, HTTP 429, network, unreadable\.$/m);

  // Any other failure is final at once.
  const pull = { [PULL]: [gh("gh: Not Found (HTTP 404)\n"), gh("gh: Not Found (HTTP 404)\n")] };
  ({ record, slept } = decideFailing(pull));
  assert.deepEqual(record.reasons, ["PULL_REQUEST_UNREADABLE"]);
  assert.deepEqual(record.retries, [{ path: PULL, attempts: 1, failures: ["HTTP 404"], outcome: "unreadable" }]);
  assert.deepEqual(slept, []);
  assert.equal(pull[PULL].length, 1);
});

test("right before the request, the branch's runs and then the pull request's head are read again, and any change holds the run", () => {
  const record = decideWith();
  const api = apiOf();
  const confirmed = confirm({ record, api, sleep: () => assert.fail("no read is retried") });
  const { confirmation, ...rest } = confirmed;
  assert.deepEqual(rest, record);
  assert.deepEqual(confirmation, { decision: "recheck", reasons: [], retries: [] });
  assert.deepEqual(api.calls, [RUNS, PULL]);
  for (const [reason, change] of [
    ["HEAD_CHANGED", (state) => { state.pull.head.sha = "55fca975".padEnd(40, "0"); }],
    ["PULL_REQUEST_NOT_OPEN", (state) => { state.pull.state = "closed"; }],
    ["NEWER_RUN", (state) => { state.runs.workflow_runs.unshift(state.newerRun); }],
    ["RUNS_INVALID", (state) => { state.runs.workflow_runs = []; }],
    ["RUNS_UNREADABLE", (state) => { state.unreadable = [RUNS]; }],
    ["PULL_REQUEST_UNREADABLE", (state) => { state.unreadable = [PULL]; }],
  ]) {
    const result = confirm({ record, api: apiOf(change), sleep: () => {} });
    assert.equal(result.decision, "hold", reason);
    assert.deepEqual(result.reasons, [reason], reason);
    assert.deepEqual([result.confirmation.decision, result.confirmation.reasons], ["hold", [reason]], reason);
  }
  const failing = { [RUNS]: [gh("gh: HTTP 502\n")] };
  assert.deepEqual(confirm({ record, api: apiOf((state) => { state.failing = failing; }), sleep: () => {} }).confirmation,
    { decision: "recheck", reasons: [], retries: [{ path: RUNS, attempts: 2, failures: ["HTTP 502"], outcome: "read" }] });
  // Only an unconfirmed recheck decision is confirmed.
  for (const other of [decideWith((state) => { state.run.run_attempt = 2; }), confirmed, { ...record, schemaVersion: 2 }]) {
    assert.throws(() => confirm({ record: other, api: apiOf() }), /not an unconfirmed recheck decision/);
  }
});

test("the archive reader reads stored and deflated members in memory and rejects a duplicated, encrypted, unknown or misreported member", () => {
  const members = [["summary.json", "{\"testOutcome\":\"FAIL\"}"], ["suites/ledger.jsonl", "{}\n"], ["inputs.json", "{}"]];
  for (const method of [0, 8]) {
    assert.deepEqual(zipMembers(zip(members, { method }), ["inputs.json", "summary.json"]),
      { "summary.json": "{\"testOutcome\":\"FAIL\"}", "inputs.json": "{}" });
  }
  assert.deepEqual(zipMembers(zip(members), ["missing.json"]), {});
  for (const [label, archive] of [["duplicated", zip([...members, ["inputs.json", "{}"]])], ["encrypted", zip(members, { flags: 1 })],
    ["bzip2", zip(members, { method: 12 })], ["misreported size", zip(members, { grow: 1 })], ["truncated", zip(members).subarray(0, 60)],
    ["not an archive", Buffer.from("summary.json")]]) {
    assert.throws(() => zipMembers(archive, ["inputs.json", "summary.json"]), undefined, label);
  }
});

test("the CLI writes the record, the decision output and a summary that keeps run text inside table cells", (t) => {
  const root = scratch(t);
  const output = join(root, "decision", `auto-recheck-decision-${RUN}-attempt1.json`);
  const [outputs, summary] = [join(root, "github-output"), join(root, "summary.md")];
  assert.equal(runCli(["decide", "--repository", REPOSITORY, "--run-id", RUN, "--output", output, "--github-output", outputs,
    "--github-summary", summary], apiOf()), 0);
  assert.equal(JSON.parse(readFileSync(output, "utf8")).decision, "recheck");
  assert.equal(readFileSync(outputs, "utf8"), "decision=recheck\n");
  const text = readFileSync(summary, "utf8");
  assert.match(text, /^### Native auto recheck: \*\*recheck\*\*$/m);
  assert.match(text, /^\| Codex accepted 0\.166\.0 \(windows-2025, Node 24\) \| failure \| `codex\\\|windows-2025\\\|codex-install-smoke\\\|cleanup:directory_removal\\\|CLEANUP_DIRECTORY_REMOVAL_FAILED:EBUSY` \| S1 \| none \|$/m);
  const held = render(decideWith((state) => { state.evidence[CODEX_EVIDENCE].summary.signature = "codex|`x`|y"; }));
  assert.match(held, /^Run 41570380043 attempt 1 \(pull_request, head 7c0a49d8, pull request #260\)\. Held: `SIGNATURE_UNREGISTERED`\.$/m);
  assert.match(held, /\| failure \| `codex\\\|'x'\\\|y` \| none \| SIGNATURE_UNREGISTERED \|$/m);
  assert.throws(() => runCli(["decide", "--repository", REPOSITORY, "--run-id", "latest", "--output", output], apiOf()), /^Error: Usage/);
});

test("confirm rewrites the record, adds to the summary and prints only the decision", (t) => {
  const root = scratch(t);
  const summary = join(root, "summary.md"), sleep = () => {};
  const decided = () => {
    const output = join(mkdtempSync(join(root, "decision-")), `auto-recheck-decision-${RUN}-attempt1.json`);
    writeFileSync(output, `${JSON.stringify(decideWith(), null, 2)}\n`);
    return output;
  };
  const log = t.mock.method(console, "log", () => {});
  t.mock.method(console, "error", () => {});
  const [unchanged, moved] = [decided(), decided()];
  assert.equal(runCli(["confirm", "--record", unchanged, "--github-summary", summary], apiOf(), sleep), 0);
  assert.equal(runCli(["confirm", "--record", moved, "--github-summary", summary],
    apiOf((state) => { state.runs.workflow_runs.unshift(state.newerRun); }), sleep), 0);
  assert.deepEqual(log.mock.calls.map((call) => call.arguments), [["recheck"], ["hold"]]);
  assert.deepEqual(JSON.parse(readFileSync(unchanged, "utf8")).confirmation, { decision: "recheck", reasons: [], retries: [] });
  assert.deepEqual(JSON.parse(readFileSync(moved, "utf8")).reasons, ["NEWER_RUN"]);
  const text = readFileSync(summary, "utf8");
  assert.match(text, /^### Native auto recheck, right before the request: \*\*recheck\*\*$/m);
  assert.match(text, /^### Native auto recheck, right before the request: \*\*hold\*\*\n\nHeld: `NEWER_RUN`\.$/m);
  assert.throws(() => runCli(["confirm", "--record", unchanged], apiOf(), sleep), /not an unconfirmed recheck decision/);
  assert.equal(log.mock.calls.length, 2);
});

// Source contracts for the workflow, as in the other workflow tests; they complement actionlint rather than parse YAML.
const jobOf = (source, id) => source.split(`\n  ${id}:\n`)[1].split(/\n  [a-z][a-z0-9-]*:\n/)[0];

test("the workflow handles only a failed first attempt of a pull request run from this repository and requests one recheck for a recheck decision confirmed right before the request", () => {
  assert.equal(/^name: (.+)$/m.exec(NATIVE)[1], "Native client functional checks");
  assert.match(WORKFLOW, /^on:\n  workflow_run:\n    workflows: \["Native client functional checks"\]\n    types: \[completed\]\n  workflow_dispatch:\n    inputs:\n      run_id:\n[\s\S]*?\n      mode:\n[\s\S]*?\n        options:\n          - decide-only\n\npermissions:\n  actions: write\n  contents: read\n  pull-requests: read\n\n/m);
  const decideJob = jobOf(WORKFLOW, "decide");
  assert.match(decideJob, /^    if: >-\n      github\.event_name == 'workflow_dispatch'\n      \|\| \(github\.event\.workflow_run\.event == 'pull_request'\n      && github\.event\.workflow_run\.conclusion == 'failure'\n      && github\.event\.workflow_run\.run_attempt == 1\n      && github\.event\.workflow_run\.head_repository\.full_name == github\.repository\)\n/m);
  // The default branch's code only: the checkout names no ref and keeps no credentials.
  assert.match(decideJob, /\n      - uses: actions\/checkout@v7\n        with:\n          persist-credentials: false\n      - uses: actions\/setup-node@v7\n/);
  assert.match(decideJob, /\n        run: node scripts\/ci\/shared\/native-auto-recheck\.mjs decide --repository "\$GITHUB_REPOSITORY" --run-id "\$RUN_ID" --output "\$RUNNER_TEMP\/auto-recheck\/auto-recheck-decision-\$RUN_ID-attempt1\.json" --github-output "\$GITHUB_OUTPUT" --github-summary "\$GITHUB_STEP_SUMMARY"\n/);
  assert.match(decideJob, /\n          name: auto-recheck-decision-\$\{\{ env\.RUN_ID \}\}-attempt1\n          path: \$\{\{ runner\.temp \}\}\/auto-recheck\n/);
  assert.match(decideJob, /\n      - name: Recheck the failed jobs once\n        if: github\.event_name == 'workflow_run' && steps\.decide\.outputs\.decision == 'recheck'\n        env:\n          GH_TOKEN: \$\{\{ github\.token \}\}\n        run: \|\n          decision="\$\(node scripts\/ci\/shared\/native-auto-recheck\.mjs confirm --record "\$RUNNER_TEMP\/auto-recheck\/auto-recheck-decision-\$RUN_ID-attempt1\.json" --github-summary "\$GITHUB_STEP_SUMMARY"\)"\n          if \[ "\$decision" = recheck \]; then\n            gh api --method POST "repos\/\$GITHUB_REPOSITORY\/actions\/runs\/\$RUN_ID\/rerun-failed-jobs"\n          fi\n/);
  // The recheck step confirms the decision and then requests the recheck; the record is uploaded last, whatever happened.
  const order = ["        id: decide\n", "      - name: Recheck the failed jobs once\n", "      - uses: actions/upload-artifact@v7\n        if: always()\n"];
  assert.deepEqual(order.map((step) => decideJob.indexOf(step)), order.map((step) => decideJob.indexOf(step)).sort((a, b) => a - b));
  assert.ok(order.every((step) => decideJob.includes(step)));
  assert.equal(WORKFLOW.match(/--method POST|rerun/g).length, 2);
  // The run ID and manual inputs reach shell code only through the environment.
  const scripts = [...WORKFLOW.matchAll(/^( +)run: (?:\|\n((?:\1  .*\n)+)|(.+)\n)/gm)].map((match) => match[2] ?? match[3]);
  assert.equal(scripts.length, 2);
  for (const script of scripts) assert.doesNotMatch(script, /\$\{\{/);
});

test("each failed cell's evidence is the artifact its matrix job uploads, and the jobs that report cells are the pull request result names", () => {
  for (const [id, client] of [["install", "codex"], ["opencode", "opencode"], ["claude", "claude"], ["codebuddy", "codebuddy"]]) {
    assert.match(jobOf(NATIVE, id), new RegExp(`\\n          name: native-evidence-${client}-\\$\\{\\{ matrix\\.os \\}\\}-\\$\\{\\{ matrix\\.channel \\}\\}`
      + "-node-\\$\\{\\{ matrix\\.node \\}\\}-attempt\\$\\{\\{ github\\.run_attempt \\}\\}\\n"), id);
  }
  const names = [...NATIVE.matchAll(/^    name: \$\{\{ github\.event_name == 'pull_request' && '([^']+)' \|\|/gm)].map((match) => match[1]);
  assert.deepEqual(names.sort(), [...RESULT_JOBS].sort());
  // The package job has no name of its own, so its jobs API name is its ID.
  assert.doesNotMatch(jobOf(NATIVE, "package"), /^    name: /m);
});
