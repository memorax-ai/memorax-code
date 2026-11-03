// Pinned client acceptance inputs for pull requests. client-acceptance.json records each native client's baseline and its
// most recently accepted version: per platform the download source, the SHA-256 or npm integrity, and the runs that
// accepted them. A pull request installs exactly these inputs; the compatibility monitor and release acceptance keep
// resolving official latest releases, and an accepted version changes only through a reviewed update of the manifest.
// A missing entry, an unreadable manifest or an integrity mismatch fails the run: nothing falls back to a latest lookup.
import { execFile } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { NPM_CLIENTS } from "./ci-evidence.mjs";

const exec = promisify(execFile);
export const MANIFEST = fileURLToPath(new URL("./client-acceptance.json", import.meta.url));
export const CHANNELS = ["baseline", "accepted"];
const REGISTRY = "https://registry.npmjs.org/";
// Each npm client also runs its baseline on its oldest supported Node, as the latest-resolving steps do.
const NODE_FLOOR = { codex: "20", opencode: "20", claude: "22", codebuddy: "20" };
// Every Node major a native matrix runs; the manifest pins each to one exact release.
const NODE_MAJORS = ["20", "22", "24"];
const LABELS = { codex: "Codex", opencode: "OpenCode", claude: "Claude Code", codebuddy: "CodeBuddy Code" };
const PLATFORMS = ["ubuntu-24.04", "macos-15", "windows-2025"];
const RUN = /^[1-9]\d{0,15}\/[1-9]\d{0,3}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function fail(code) { throw Object.assign(new Error(code), { code }); }
function check(value, code = "CLIENT_ACCEPTANCE_INVALID") { if (!value) fail(code); }
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const only = (value, keys) => isObject(value) && Object.keys(value).every((key) => keys.includes(key));
const text = (value) => typeof value === "string" && value.length > 0 && value.length <= 400 && !/[\0-\x1f]/.test(value);
const npmClient = (client) => typeof client === "string" && Object.hasOwn(NPM_CLIENTS, client);

function validRun(run) {
  return only(run, ["event", "pullRequest", "head", "date", "rerun"]) && ["pull_request", "schedule", "workflow_dispatch"].includes(run.event)
    && (run.event === "pull_request" ? Number.isSafeInteger(run.pullRequest) && run.pullRequest > 0 : run.pullRequest === undefined)
    && /^[a-f0-9]{40}$/.test(run.head ?? "") && DATE.test(run.date ?? "") && [undefined, "single-job", "all-jobs"].includes(run.rerun);
}

// Every pinned version cites at least one run that passed it; failed cells and rechecks stay on record.
function validRecords(records, runs) {
  return Array.isArray(records) && records.every((record) => only(record, ["run", "result", "failed", "note"])
    && typeof record.run === "string" && Object.hasOwn(runs, record.run)
    && (record.result === "passed" ? record.failed === undefined
      : record.result === "failed" && Array.isArray(record.failed) && record.failed.length > 0 && record.failed.every(text))
    && (record.note === undefined || text(record.note))) && records.some((record) => record.result === "passed");
}

function validateNpm(client, section) {
  check(only(section, ["package", "registry", ...CHANNELS, "deferred"]) && section.package === NPM_CLIENTS[client]
    && section.registry === REGISTRY);
  for (const channel of CHANNELS) {
    const entry = section[channel];
    check(only(entry, ["version", "integrity", "shasum", "acceptance"]) && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(entry.version ?? "")
      && /^sha512-[A-Za-z0-9+/]{86}==$/.test(entry.integrity ?? "") && /^[a-f0-9]{40}$/.test(entry.shasum ?? ""));
  }
  if (section.accepted.version === section.baseline.version) {
    check(section.accepted.integrity === section.baseline.integrity && section.accepted.shasum === section.baseline.shasum);
  }
}

function freeze(value) {
  if (value !== null && typeof value === "object") Object.values(value).forEach(freeze);
  return Object.freeze(value);
}

function readManifest(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { fail("CLIENT_ACCEPTANCE_UNREADABLE"); }
}

// Read and validate one client's section. Cursor and WorkBuddy releases are checked further by their own validators.
export function readAcceptance(client, file = MANIFEST) {
  const manifest = readManifest(file);
  check(isObject(manifest) && manifest.schemaVersion === 1 && isObject(manifest.runs) && isObject(manifest.clients)
    && Object.entries(manifest.runs).every(([key, run]) => RUN.test(key) && validRun(run))
    && (manifest.gaps === undefined || (Array.isArray(manifest.gaps) && manifest.gaps.every(text))));
  check(typeof client === "string" && Object.hasOwn(manifest.clients, client) && isObject(manifest.clients[client]),
    "CLIENT_ACCEPTANCE_CLIENT_MISSING");
  const section = manifest.clients[client];
  for (const channel of CHANNELS) check(Object.hasOwn(section, channel) && isObject(section[channel]), "CLIENT_ACCEPTANCE_CHANNEL_MISSING");
  // WorkBuddy versions differ per platform, so each platform carries its own acceptance records.
  const entries = client === "workbuddy" ? CHANNELS.flatMap((channel) => {
    check(isObject(section[channel].platforms) && Object.keys(section[channel].platforms).length > 0, "CLIENT_ACCEPTANCE_CHANNEL_MISSING");
    return Object.values(section[channel].platforms);
  }) : CHANNELS.map((channel) => section[channel]);
  for (const entry of entries) check(validRecords(entry?.acceptance, manifest.runs));
  check(section.deferred === undefined || (Array.isArray(section.deferred) && section.deferred.every((item) =>
    only(item, ["version", "platforms", "date", "runs", "reason"]) && text(item.version) && text(item.reason) && DATE.test(item.date ?? "")
    && (item.platforms === undefined || (Array.isArray(item.platforms) && item.platforms.every(text)))
    && Array.isArray(item.runs) && item.runs.every((run) => typeof run === "string" && Object.hasOwn(manifest.runs, run)))));
  if (npmClient(client)) validateNpm(client, section);
  return freeze(section);
}

// The exact Node release of each major, for every run that builds a native matrix, not only pull requests. Jobs outside the
// matrices read the root .node-version, which equals the pinned 24 release.
export function readNodeVersions(file = MANIFEST) {
  const versions = readManifest(file)?.node;
  check(only(versions, NODE_MAJORS) && NODE_MAJORS.every((major) => typeof versions[major] === "string"
    && new RegExp(`^${major}\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)$`).test(versions[major])), "CLIENT_ACCEPTANCE_NODE_INVALID");
  return Object.freeze({ ...versions });
}

// A cell keeps its Node major, which job and artifact names and report matching use, and gains the exact release that
// setup-node installs. A major without a pinned release fails.
export function pinNodeVersions(include, versions = readNodeVersions()) {
  return include.map((cell) => {
    check(typeof cell.node === "string" && Object.hasOwn(versions, cell.node), "CLIENT_ACCEPTANCE_NODE_INVALID");
    return { ...cell, nodeVersion: versions[cell.node] };
  });
}

export function npmMatrix(client, section, nodeVersions = readNodeVersions()) {
  check(npmClient(client), "CLIENT_ACCEPTANCE_ARGUMENTS_INVALID");
  const { baseline, accepted } = section;
  const same = accepted.version === baseline.version;
  const include = PLATFORMS.map((os) => ({ os, node: "24", [client]: baseline.version, channel: same ? "baseline+accepted" : "baseline" }));
  include.push({ os: "ubuntu-24.04", node: NODE_FLOOR[client], [client]: baseline.version, channel: "baseline" });
  if (!same) include.push(...PLATFORMS.map((os) => ({ os, node: "24", [client]: accepted.version, channel: "accepted" })));
  return { include: pinNodeVersions(include, nodeVersions) };
}

// The registry must still serve each pinned version with its recorded integrity, so the install gets exactly that tarball.
export async function verifyNpm(section, { npm = ["npm"] } = {}) {
  const [file, ...args] = npm;
  for (const channel of CHANNELS) {
    const { version, integrity, shasum } = section[channel];
    let dist;
    try {
      const { stdout } = await exec(file, [...args, "view", `${section.package}@${version}`, "dist.integrity", "dist.shasum", "--json",
        `--registry=${section.registry}`], { timeout: 30_000, maxBuffer: 64 * 1024, encoding: "utf8" });
      dist = JSON.parse(stdout);
    } catch { fail("CLIENT_ACCEPTANCE_LOOKUP_FAILED"); }
    check(dist?.["dist.integrity"] === integrity && dist["dist.shasum"] === shasum, "CLIENT_ACCEPTANCE_INTEGRITY_MISMATCH");
  }
}

export async function runCli(args, { env = process.env, npm, file } = {}) {
  const [command, client] = args;
  check(command === "npm-matrix" && args.length === 2 && npmClient(client), "CLIENT_ACCEPTANCE_ARGUMENTS_INVALID");
  const section = readAcceptance(client, file);
  const nodeVersions = readNodeVersions(file);
  await verifyNpm(section, { npm });
  const matrix = npmMatrix(client, section, nodeVersions);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `matrix=${JSON.stringify(matrix)}\n`);
  if (env.GITHUB_STEP_SUMMARY) {
    appendFileSync(env.GITHUB_STEP_SUMMARY, `${LABELS[client]} pinned acceptance inputs: baseline **${section.baseline.version}**, `
      + `accepted **${section.accepted.version}**; registry integrity verified for both.\n\n`
      + `${matrix.include.length} required native jobs; no latest lookup and no version fallback.\n`);
  }
  return matrix;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await runCli(process.argv.slice(2)))); }
  catch (error) {
    const code = /^CLIENT_ACCEPTANCE_[A-Z_]+$/.test(error?.code ?? "") ? error.code : "CLIENT_ACCEPTANCE_FAILED";
    console.error(`${code}: the pinned client inputs were not verified; no latest lookup or fallback.`);
    process.exitCode = 1;
  }
}
