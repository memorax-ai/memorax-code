// The acceptance update that one compatibility monitor attempt supports, proposed for review and never committed. A client's
// official latest version becomes a candidate only when every cell of that version passed in this attempt's result record
// and client-acceptance.json does not defer it; a fallback release, a deferred version, a failed or missing cell and a
// missing input are reported with their reasons instead. A candidate takes its integrity, hashes and sizes from this
// attempt's own records: an npm client from the package job's input record, Cursor App from the frozen release inventory
// and, for its desktop downloads, the hash and size its cells observed, and WorkBuddy from each platform's version report
// and the release matrix. Earlier attempts are not read, so a later attempt proposes nothing. The proposal is a manifest
// that the acceptance reader accepts and its diff against the checkout. Nothing here reads the network or the jobs API,
// and only a broken contract of this step fails it, never the absence of candidates.
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { MANIFEST, readAcceptance, readNodeVersions } from "./client-acceptance.mjs";
import { CLIENTS as RESULTS, defers } from "./client-result.mjs";
import { matrixRows, workbuddyJobName } from "./release-acceptance.mjs";

const SCHEMA = 1;
const USAGE = "Usage: client-acceptance-refresh.mjs propose --inputs <dir> --output <dir> [--github-summary <file>]";
// The manifest's path in the repository, which the diff names.
const MANIFEST_PATH = "scripts/ci/shared/client-acceptance.json";
const CLIENTS = Object.keys(RESULTS);
// The runners on which an npm client and Cursor App run their latest version, and the Cursor App platform each downloads.
const RUNNERS = { "ubuntu-24.04": "linux-x64", "macos-15": "darwin-arm64", "windows-2025": "win32-x64-user" };
// The report block in which each Cursor App desktop cell records its download.
const DESKTOP = { "darwin-arm64": "macos", "win32-x64-user": "windows" };
const VERSION = { 3: /^(0|[1-9]\d*)(?:\.(0|[1-9]\d*)){2}$/, 4: /^(0|[1-9]\d*)(?:\.(0|[1-9]\d*)){3}$/ };
const SHA256 = /^[a-f0-9]{64}$/;

function fail(code) { throw Object.assign(new Error(code), { code }); }
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value) => typeof value === "string" && value.length > 0 && value.length <= 400 && !/[\0-\x1f]/.test(value);
const size = (value) => Number.isSafeInteger(value) && value > 0;
const isLatest = (channel) => String(channel).split("+").includes("latest");

function readJson(file) {
  if (!existsSync(file)) return { status: "MISSING" };
  try { return { status: "OK", value: JSON.parse(readFileSync(file, "utf8")) }; } catch { return { status: "INVALID" }; }
}

function compare(left, right) {
  const a = left.split(".").map(BigInt), b = right.split(".").map(BigInt);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const [x, y] = [a[index] ?? 0n, b[index] ?? 0n];
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

function runOf(env, now) {
  const run = { id: env.GITHUB_RUN_ID, attempt: Number(env.GITHUB_RUN_ATTEMPT), event: env.GITHUB_EVENT_NAME, head: env.GITHUB_SHA };
  if (run.event !== "schedule" || !/^[1-9]\d{0,15}$/.test(run.id ?? "") || !Number.isSafeInteger(run.attempt) || run.attempt < 1
    || run.attempt > 9999 || !/^[a-f0-9]{40}$/.test(run.head ?? "")) fail("REFRESH_RUN_INVALID");
  return { ...run, date: now.toISOString().slice(0, 10) };
}

// This attempt's classification of a client's cells; only a complete listing without issues can support a candidate.
function readRecord(inputs, client, run) {
  const name = `client-result-${client}-attempt${run.attempt}`;
  const { status, value } = readJson(join(inputs, "client-result", `${name}.json`));
  if (status !== "OK") return { name, reasons: [`RESULT_${status}`] };
  if (!(value?.schemaVersion === 1 && value.client === client && value.event === "schedule" && value.basis === "cells"
    && value.run?.id === run.id && value.run?.attempt === run.attempt && Array.isArray(value.cells) && Array.isArray(value.issues))) {
    return { name, reasons: ["RESULT_INVALID"] };
  }
  // An incomplete listing is always among the record's issues.
  if (value.listing !== "COMPLETE" || value.issues.length) {
    return { name, reasons: [`RESULT_ISSUES: ${value.issues.join(", ") || `LISTING_${value.listing}`}`] };
  }
  return { name, cells: value.cells, reasons: [] };
}

function readInputs(inputs, run) {
  const name = `native-client-inputs-attempt${run.attempt}`;
  const { status, value } = readJson(join(inputs, "native-client-inputs", "native-client-inputs.json"));
  if (status !== "OK") return { name, reasons: [`INPUTS_${status}`] };
  const source = value?.source;
  if (!(value?.schemaVersion === 1 && source?.event === "schedule" && source.runId === run.id && source.runAttempt === String(run.attempt)
    && source.sha === run.head && isObject(value.clients))) return { name, reasons: ["INPUTS_INVALID"] };
  return { name, value, reasons: [] };
}

// The latest version against the accepted one. Only a newer version that is not deferred can become a candidate.
function compareVersion(version, accepted, { deferred = [], platform, parts }) {
  if (!VERSION[parts].test(version ?? "")) return { decision: "not-candidate", reasons: ["VERSION_UNSUPPORTED"] };
  const order = compare(version, accepted);
  if (order === 0) return { decision: "unchanged", reasons: [] };
  if (order < 0) return { decision: "not-candidate", reasons: ["LATEST_OLDER_THAN_ACCEPTED"] };
  return { decision: "candidate", reasons: deferred.some((entry) => defers(entry, version, platform)) ? ["DEFERRED"] : [] };
}

const failedCells = (cells) => cells.filter((cell) => cell.class !== "passed").map((cell) => `CELL_NOT_PASSED: ${cell.job} is ${cell.class}`);

// The latest cells of an npm client or Cursor App: one version that is newer than the accepted one and not deferred, and a
// cell on every runner, each of which passed.
function latestOf(record, section) {
  const result = { decision: "not-candidate", version: null, accepted: section.accepted.version, reasons: [], sources: [record.name] };
  if (record.reasons.length) return { ...result, reasons: record.reasons };
  const cells = record.cells.filter((cell) => isLatest(cell.channel));
  const versions = [...new Set(cells.map((cell) => cell.version))];
  if (versions.length !== 1) return { ...result, reasons: [cells.length ? "LATEST_VERSION_AMBIGUOUS" : "LATEST_CELLS_MISSING"] };
  const [version] = versions;
  const decided = compareVersion(version, section.accepted.version, { deferred: section.deferred, parts: 3 });
  if (decided.decision !== "candidate") return { ...result, version, ...decided };
  const missing = Object.keys(RUNNERS).filter((os) => !cells.some((cell) => String(cell.cell).startsWith(`${os}, `)));
  const reasons = [...decided.reasons, ...failedCells(cells), ...missing.map((os) => `CELL_MISSING: ${os}`)];
  return { ...result, version, cells, decision: reasons.length ? "not-candidate" : "candidate", reasons };
}

function npmDecision(client, section, record, inputs, acceptance) {
  const { cells, ...result } = latestOf(record, section);
  if (result.decision !== "candidate") return result;
  result.sources.push(inputs.name);
  if (inputs.reasons.length) return { ...result, decision: "not-candidate", reasons: inputs.reasons };
  // The package job looked this exact version up in the registry from which pull requests install it.
  const entry = inputs.value.clients[client];
  const found = entry?.npmPackage === section.package && entry.registry === section.registry && Array.isArray(entry.versions)
    ? entry.versions.find((item) => item?.version === result.version && Array.isArray(item.channels) && item.channels.includes("latest"))
    : undefined;
  if (!(found?.lookup === "OK" && /^sha512-[A-Za-z0-9+/]{86}==$/.test(found.integrity ?? "") && /^[a-f0-9]{40}$/.test(found.shasum ?? ""))) {
    return { ...result, decision: "not-candidate", reasons: ["INPUTS_VERSION_MISSING"] };
  }
  return { ...result, entry: { version: result.version, integrity: found.integrity, shasum: found.shasum, acceptance } };
}

function cursorDecision(section, record, inputs, run, acceptance) {
  const { cells, ...result } = latestOf(record, section);
  if (result.decision !== "candidate") return result;
  result.sources.push(`cursor-app-releases-attempt${run.attempt}`);
  const inventory = readJson(join(inputs, "cursor-app-releases", "cursor-app-releases.json"));
  if (inventory.status !== "OK") return { ...result, decision: "not-candidate", reasons: [`INVENTORY_${inventory.status}`] };
  // Every platform's frozen latest release is the version the cells ran, built from one commit.
  const releases = Object.fromEntries(Object.values(RUNNERS).map((platform) => [platform, inventory.value?.latest?.[platform]]));
  const linux = releases["linux-x64"], commitSha = linux?.commitSha;
  if (!(Object.values(releases).every((release) => isObject(release) && release.version === result.version && release.channel === "latest"
    && release.commitSha === commitSha && text(release.url)) && /^[a-f0-9]{40}$/.test(commitSha ?? "")
    && linux.hashSource === "official-apt-sha256" && SHA256.test(linux.sha256 ?? "") && text(linux.debVersion) && size(linux.size))) {
    return { ...result, decision: "not-candidate", reasons: ["INVENTORY_INVALID"] };
  }
  const platforms = { "linux-x64": { url: linux.url, sha256: linux.sha256, hashSource: linux.hashSource, debVersion: linux.debVersion,
    size: linux.size } };
  const reasons = [];
  // Cursor publishes no desktop checksum, so a desktop download keeps the hash and size that its passing cell observed.
  for (const [os, platform] of Object.entries(RUNNERS).filter(([, platform]) => DESKTOP[platform])) {
    const cell = cells.find((item) => String(item.cell).startsWith(`${os}, `));
    const name = `cursor-app-${os}-${cell.channel}-node-${String(cell.cell).split(", Node ")[1]}-report-attempt${run.attempt}`;
    result.sources.push(name);
    const { status, value } = readJson(join(inputs, "cursor-app-reports", name, "report.json"));
    const observed = value?.[DESKTOP[platform]];
    if (status !== "OK") reasons.push(`REPORT_${status}: ${platform}`);
    else if (!(value?.status === "PASS" && value.version === result.version && SHA256.test(observed?.observedSha256 ?? "")
      && size(observed.bytes) && (platform !== "darwin-arm64" || (observed.platform === platform && observed.channel === cell.channel
        && observed.version === result.version && observed.commitSha === commitSha)))) reasons.push(`REPORT_INVALID: ${platform}`);
    else platforms[platform] = { url: releases[platform].url, sha256: observed.observedSha256, hashSource: "observed-sha256", size: observed.bytes };
  }
  if (reasons.length) return { ...result, decision: "not-candidate", reasons };
  return { ...result, entry: { version: result.version, commitSha, platforms, acceptance } };
}

// WorkBuddy releases differ per platform, so each platform is decided on its own from its row of the release matrix.
function workbuddyDecision(platform, section, record, inputs, run, rows, acceptance) {
  const result = { decision: "not-candidate", version: null, accepted: section.accepted.platforms[platform].desktop?.version ?? null,
    reasons: [], sources: [record.name, "workbuddy-releases matrix"] };
  if (record.reasons.length) return { ...result, reasons: record.reasons };
  const latest = rows?.filter((row) => row?.release?.platform === platform && (isLatest(row.release.channel) || row.release.channel === "fallback"));
  if (latest?.length !== 1) return { ...result, reasons: [!rows ? "MATRIX_MISSING" : latest.length ? "LATEST_ROW_AMBIGUOUS" : "LATEST_ROW_MISSING"] };
  const [row] = latest;
  const { channel, desktopVersion: version, url } = row.release;
  result.version = version ?? null;
  if (channel === "fallback") return { ...result, reasons: ["FALLBACK"] };
  const decided = compareVersion(version, result.accepted, { deferred: section.deferred, platform, parts: 4 });
  if (decided.decision !== "candidate") return { ...result, ...decided };
  const cells = record.cells.filter((cell) => cell.job === workbuddyJobName(row));
  const reasons = [...decided.reasons, ...(cells.length ? failedCells(cells) : [`CELL_MISSING: ${workbuddyJobName(row)}`])];
  if (reasons.length) return { ...result, reasons };
  const name = `workbuddy-report-${row.os}-${channel}-node-${row.node}-attempt${run.attempt}`;
  result.sources.push(name);
  const { status, value } = readJson(join(inputs, "workbuddy-reports", name, "report.json"));
  if (status !== "OK") return { ...result, reasons: [`REPORT_${status}`] };
  if (!(value?.schemaVersion === 2 && value.runId === run.id && value.runAttempt === run.attempt && value.os === row.os && value.node === row.node
    && value.channel === channel && value.desktopVersion === version && VERSION[3].test(value.runtimeVersion ?? "")
    && SHA256.test(value.sha256?.actual ?? "") && ["match", "warning"].includes(value.sha256.status))) return { ...result, reasons: ["REPORT_INVALID"] };
  if (!(text(url) && url.startsWith("https://"))) return { ...result, reasons: ["MATRIX_INVALID"] };
  // The report says whether the download matched the release's reference SHA-256; the entry pins the downloaded one.
  return { ...result, decision: "candidate", sha256Status: value.sha256.status,
    entry: { desktop: { version, url, sha256: value.sha256.actual }, runtime: { version: value.runtimeVersion }, acceptance } };
}

// JSON.stringify orders integer-like keys numerically, so the unchanged node section keeps the text of the checkout.
function serialize(manifest, source) {
  const node = /^ {2}"node": \{\n(?: {4}.*\n)* {2}\}/m;
  return `${JSON.stringify(manifest, null, 2)}\n`.replace(node, (block) => source.match(node)?.[0] ?? block);
}

// A unified diff with three lines of context from a longest common subsequence of lines; both texts end with a newline.
function unifiedDiff(before, after, path = MANIFEST_PATH) {
  if (before === after) return "";
  const a = before.slice(0, -1).split("\n"), b = after.slice(0, -1).split("\n");
  const common = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) common[i][j] = a[i] === b[j] ? common[i + 1][j + 1] + 1 : Math.max(common[i + 1][j], common[i][j + 1]);
  }
  // Each line with its kind and the number of old and new lines before it.
  const lines = [];
  for (let i = 0, j = 0; i < a.length || j < b.length;) {
    const at = { old: i, new: j };
    if (i < a.length && j < b.length && a[i] === b[j]) {
      lines.push({ ...at, kind: " ", text: a[i] });
      i += 1;
      j += 1;
    } else if (i < a.length && (j === b.length || common[i + 1][j] >= common[i][j + 1])) {
      lines.push({ ...at, kind: "-", text: a[i] });
      i += 1;
    } else {
      lines.push({ ...at, kind: "+", text: b[j] });
      j += 1;
    }
  }
  const hunks = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].kind === " ") continue;
    // Changes at most six unchanged lines apart share a hunk.
    let last = index;
    for (let next = index + 1; next < lines.length && next - last <= 7; next += 1) if (lines[next].kind !== " ") last = next;
    const hunk = lines.slice(Math.max(0, index - 3), last + 4);
    const old = hunk.filter((line) => line.kind !== "+").length, fresh = hunk.filter((line) => line.kind !== "-").length;
    hunks.push(`@@ -${hunk[0].old + (old ? 1 : 0)},${old} +${hunk[0].new + (fresh ? 1 : 0)},${fresh} @@\n`
      + hunk.map((line) => `${line.kind}${line.text}\n`).join(""));
    index = last;
  }
  return `--- a/${path}\n+++ b/${path}\n${hunks.join("")}`;
}

// Every decision with its client and, for WorkBuddy, its platform.
const decisions = (clients) => Object.entries(clients).flatMap(([client, item]) => (client === "workbuddy"
  ? Object.entries(item.platforms).map(([platform, decision]) => [client, platform, decision]) : [[client, null, item]]));
const later = (accepted) => ({ decision: "not-candidate", version: null, accepted, reasons: ["LATER_ATTEMPT"], sources: [] });

// Decide every client from the artifacts under `inputs` and write refresh.json, the proposed manifest and its diff to `output`.
export function propose({ inputs, output, env = process.env, now = new Date(), manifest = MANIFEST }) {
  const run = runOf(env, now);
  let source, sections;
  try {
    sections = Object.fromEntries(CLIENTS.map((client) => [client, readAcceptance(client, manifest)]));
    source = readFileSync(manifest, "utf8");
  } catch (error) {
    fail(`REFRESH_MANIFEST_INVALID:${error.code ?? error.name}`);
  }
  const key = `${run.id}/${run.attempt}`;
  const acceptance = [{ run: key, result: "passed" }];
  const inputsRecord = run.attempt === 1 ? readInputs(inputs, run) : null;
  const clients = Object.fromEntries(CLIENTS.map((client) => {
    const section = sections[client];
    if (client === "workbuddy") {
      const record = inputsRecord && readRecord(inputs, client, run), rows = matrixRows(env.WORKBUDDY_MATRIX);
      return [client, { platforms: Object.fromEntries(Object.entries(section.accepted.platforms).map(([platform, entry]) => [platform,
        inputsRecord ? workbuddyDecision(platform, section, record, inputs, run, rows, acceptance) : later(entry.desktop?.version ?? null)])) }];
    }
    if (!inputsRecord) return [client, later(section.accepted.version)];
    const record = readRecord(inputs, client, run);
    return [client, client === "cursor" ? cursorDecision(section, record, inputs, run, acceptance)
      : npmDecision(client, section, record, inputsRecord, acceptance)];
  }));
  const proposed = JSON.parse(source);
  const candidates = decisions(clients).filter(([, , decision]) => decision.decision === "candidate");
  for (const [client, platform, { entry }] of candidates) {
    if (platform) proposed.clients[client].accepted.platforms[platform] = entry;
    else proposed.clients[client].accepted = entry;
  }
  if (candidates.length) proposed.runs[key] = { event: "schedule", head: run.head, date: run.date };
  const proposal = candidates.length ? serialize(proposed, source) : source;
  mkdirSync(output, { recursive: true });
  const file = join(output, "client-acceptance.proposed.json");
  writeFileSync(file, proposal);
  try {
    readNodeVersions(file);
    for (const client of CLIENTS) readAcceptance(client, file);
  } catch (error) {
    rmSync(file, { force: true });
    fail(`REFRESH_PROPOSAL_INVALID:${error.code ?? error.name}`);
  }
  writeFileSync(join(output, "client-acceptance.diff"), unifiedDiff(source, proposal));
  for (const [, , decision] of candidates) delete decision.entry;
  const refresh = { schemaVersion: SCHEMA, run, manifest: MANIFEST_PATH, changed: candidates.length > 0, clients };
  writeFileSync(join(output, "refresh.json"), `${JSON.stringify(refresh, null, 2)}\n`);
  return refresh;
}

export function render(refresh) {
  if (refresh.error) {
    return ["### Client acceptance refresh: **contract error**", "", `${refresh.error}. Nothing was proposed.`, "", ""].join("\n");
  }
  const all = decisions(refresh.clients);
  const count = all.filter(([, , item]) => item.decision === "candidate").length;
  return [`### Client acceptance refresh: ${count} candidate${count === 1 ? "" : "s"}`, "",
    `Compatibility monitor run ${refresh.run.id}, attempt ${refresh.run.attempt}. Nothing was committed or opened: review `
      + `client-acceptance.diff in client-acceptance-refresh-attempt${refresh.run.attempt} and apply it in a reviewed pull request.`, "",
    "| Client | Latest | Accepted | Decision | Reasons |", "| --- | --- | --- | --- | --- |",
    ...all.map(([client, platform, item]) => `| ${client}${platform ? ` ${platform}` : ""} | ${item.version ?? "none"} | ${
      item.accepted ?? "none"} | ${item.decision} | ${[...item.reasons, ...(item.sha256Status ? [`download SHA-256 ${item.sha256Status}`] : [])]
      .join("; ") || "none"} |`), "", ""].join("\n");
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

// Always writes refresh.json and the summary; exits 1 only when this step's own contract breaks.
export function runCli(args, { env = process.env, now = new Date(), manifest = MANIFEST } = {}) {
  const [command, ...rest] = args;
  const options = parseOptions(rest);
  if (command !== "propose" || !options.inputs || !options.output) throw new Error(USAGE);
  let refresh;
  try {
    refresh = propose({ inputs: options.inputs, output: options.output, env, now, manifest });
  } catch (error) {
    refresh = { schemaVersion: SCHEMA, run: { id: env.GITHUB_RUN_ID ?? null, attempt: Number(env.GITHUB_RUN_ATTEMPT) || null },
      error: /^REFRESH_/.test(error.code ?? "") ? error.code : `REFRESH_FAILED:${error.code ?? error.name}` };
    mkdirSync(options.output, { recursive: true });
    writeFileSync(join(options.output, "refresh.json"), `${JSON.stringify(refresh, null, 2)}\n`);
  }
  if (options["github-summary"]) appendFileSync(options["github-summary"], render(refresh));
  if (refresh.error) console.log(`::error title=Client acceptance refresh::${refresh.error}`);
  return refresh.error ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = runCli(process.argv.slice(2));
  } catch (error) {
    console.error(`::error title=Client acceptance refresh::${error.message}`);
    process.exitCode = 1;
  }
}
