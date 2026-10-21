#!/usr/bin/env node
// First-failure evidence for native CI suites. Runners append typed records to
// a journal outside their disposable test root, wrappers keep a suite ledger,
// and workflow steps summarize and export the result. Evidence is best effort:
// it never changes a suite's outcome or exit code.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  appendFileSync, closeSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync,
  writeFileSync, writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { boundedInt, code, compact, oneOf, projectError, semver, systemCode, token } from "./ci-evidence-projections.mjs";

export const EVIDENCE_SCHEMA = 1;
const SUITE = /^[a-z][a-z0-9-]{1,63}$/;
const KEY = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
// Structural guard only: projectors choose fields; this rejects control characters and oversized values.
const TEXT = /^[\p{L}\p{N} _.,:;!?'"()/@+#=<>-]{0,200}$/u;
const OUTCOMES = ["PASS", "FAIL"];
const DEFAULT_LIMITS = Object.freeze({
  maxBytes: 512 * 1024, reserveBytes: 64 * 1024, maxRecords: 2000, maxPerKey: 200, throttleMs: 250, depth: 6, items: 32, keys: 64,
});

function guard(value, limits, issues, depth = 0) {
  const reject = () => { issues.rejected += 1; return "<rejected>"; };
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) && Math.abs(value) <= 1e12 ? value : reject();
  if (typeof value === "string") return TEXT.test(value) ? value : reject();
  if (depth >= limits.depth || typeof value !== "object") return reject();
  if (Array.isArray(value)) {
    if (value.length > limits.items) issues.truncated += 1;
    return value.slice(0, limits.items).map((item) => guard(item, limits, issues, depth + 1));
  }
  const entries = Object.entries(value).filter(([, item]) => item !== undefined);
  if (entries.length > limits.keys) issues.truncated += 1;
  const result = {};
  for (const [key, item] of entries.slice(0, limits.keys)) {
    if (KEY.test(key)) result[key] = guard(item, limits, issues, depth + 1);
    else issues.rejected += 1;
  }
  return result;
}

const issueCode = (prefix, error) => `${prefix}_${systemCode(error?.code) ?? code(error?.code) ?? "FAILED"}`;

export function createEvidenceRecorder({
  suite, client, directory = process.env.MEMORAX_CI_EVIDENCE_DIR, limits = {},
  now = () => performance.now(), wallClock = () => Date.now(),
}) {
  if (!SUITE.test(suite) || !SUITE.test(client)) throw new TypeError("Evidence suite and client must be fixed identifiers");
  const config = { ...DEFAULT_LIMITS, ...limits };
  const started = now(), startedAt = new Date(wallClock()).toISOString();
  const issues = new Map(), lastValue = new Map(), lastWrite = new Map(), pending = new Map(), perKey = new Map();
  const samplers = new Set();
  let mode = directory ? "ACTIVE" : "DISABLED", fd, suiteDirectory, seq = 0, bytes = 0, records = 0, dropped = 0, finished = false;

  const issue = (name) => { if (/^[A-Z][A-Z0-9_]{1,79}$/.test(name)) issues.set(name, (issues.get(name) ?? 0) + 1); };
  const elapsed = () => Math.max(0, Math.round(now() - started));
  const project = (value) => {
    const local = { rejected: 0, truncated: 0 };
    const result = guard(value, config, local);
    if (local.rejected) issue("VALUE_REJECTED");
    if (local.truncated) issue("VALUE_TRUNCATED");
    return result;
  };

  function append(record, { reserved = false } = {}) {
    if (fd === undefined) return false;
    const line = `${JSON.stringify({ v: EVIDENCE_SCHEMA, seq: seq + 1, t: elapsed(), ...record })}\n`;
    const size = Buffer.byteLength(line);
    const capacity = config.maxBytes + (reserved ? config.reserveBytes : 0);
    if ((!reserved && records >= config.maxRecords) || bytes + size > capacity) {
      dropped += 1;
      if (!issues.has("JOURNAL_LIMIT")) { issue("JOURNAL_LIMIT"); append({ kind: "limit" }, { reserved: true }); }
      return false;
    }
    try {
      // One synchronous write per complete line: a killed runner can leave at most a truncated last line.
      writeSync(fd, line);
      seq += 1; records += 1; bytes += size;
      return true;
    } catch (error) {
      issue(issueCode("JOURNAL_WRITE", error));
      try { closeSync(fd); } catch {}
      fd = undefined;
      return false;
    }
  }

  if (mode === "ACTIVE") {
    try {
      if (typeof directory !== "string" || !isAbsolute(directory)) throw Object.assign(new Error("invalid"), { code: "DIRECTORY_INVALID" });
      const info = lstatSync(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw Object.assign(new Error("invalid"), { code: "DIRECTORY_INVALID" });
      suiteDirectory = join(directory, suite);
      mkdirSync(suiteDirectory, { mode: 0o700 });
      fd = openSync(join(suiteDirectory, "journal.jsonl"), "wx", 0o600);
      append({ kind: "start", suite, client, platform: process.platform, arch: process.arch, node: process.version, startedAt });
    } catch (error) {
      mode = "UNAVAILABLE";
      issue(issueCode("OPEN", error));
      if (fd !== undefined) { try { closeSync(fd); } catch {} fd = undefined; }
    }
  }

  function persist(key, serialized, value) {
    const count = perKey.get(key) ?? 0;
    if (count >= config.maxPerKey) { issue("OBSERVE_LIMIT"); return; }
    if (append({ kind: "observe", key, value })) {
      perKey.set(key, count + 1);
      lastValue.set(key, serialized);
      lastWrite.set(key, now());
    }
  }
  function flush(key) {
    const waiting = pending.get(key);
    if (!waiting) return;
    clearTimeout(waiting.timer);
    pending.delete(key);
    persist(key, waiting.serialized, waiting.value);
  }

  // Persist a key's value when it changes; changes inside the throttle window
  // coalesce and the newest one is written when the window closes.
  function observe(key, value) {
    if (finished || fd === undefined) return;
    if (!KEY.test(key)) { issue("OBSERVE_KEY_INVALID"); return; }
    const projected = project(value);
    const serialized = JSON.stringify(projected);
    const waiting = pending.get(key);
    if (serialized === (waiting ? waiting.serialized : lastValue.get(key))) return;
    if (waiting && serialized === lastValue.get(key)) { clearTimeout(waiting.timer); pending.delete(key); return; }
    const since = now() - (lastWrite.get(key) ?? -Infinity);
    if (since >= config.throttleMs) {
      if (waiting) { clearTimeout(waiting.timer); pending.delete(key); }
      persist(key, serialized, projected);
      return;
    }
    let timer = waiting?.timer;
    if (!timer) {
      timer = setTimeout(() => flush(key), Math.max(1, Math.ceil(config.throttleMs - since)));
      timer.unref?.();
    }
    pending.set(key, { serialized, value: projected, timer });
  }

  // Sample in-memory progress without changing how the runner assigns it.
  function track(sample, { key = "progress", intervalMs = 200 } = {}) {
    if (finished || fd === undefined) return () => {};
    const take = () => {
      try { observe(key, sample()); } catch { issue("TRACK_SAMPLE_FAILED"); }
    };
    take();
    const timer = setInterval(take, intervalMs);
    timer.unref?.();
    const stop = () => {
      if (!samplers.delete(stop)) return;
      clearInterval(timer);
      take();
      flush(key);
    };
    samplers.add(stop);
    return stop;
  }

  // Run an optional collection under its own budget. Failures and timeouts are
  // recorded as evidence issues and returned; they are never thrown.
  async function collect(name, collector, { budgetMs = 10_000 } = {}) {
    if (!KEY.test(name)) throw new TypeError("Evidence collector names must be fixed identifiers");
    const begun = now();
    let timer;
    try {
      const value = await Promise.race([
        Promise.resolve().then(collector),
        new Promise((_, reject) => {
          // Awaited collection must reach its deadline even when the collector
          // owns no active handles. The finally block releases this timer.
          timer = setTimeout(() => reject(Object.assign(new Error("Evidence budget expired"), { evidenceBudget: true })), budgetMs);
        }),
      ]);
      append({ kind: "collect", name, status: "OK", elapsedMs: Math.round(now() - begun), value: project(value) }, { reserved: true });
      return { status: "OK", value };
    } catch (error) {
      const status = error?.evidenceBudget ? "TIMEOUT" : "FAILED";
      const details = error?.evidenceBudget ? undefined : projectError(error);
      issue(`COLLECT_${status}`);
      append(compact({ kind: "collect", name, status, elapsedMs: Math.round(now() - begun), error: details }), { reserved: true });
      return compact({ status, error: details });
    } finally {
      clearTimeout(timer);
    }
  }

  function status() {
    if (mode !== "ACTIVE") return mode;
    return issues.size ? "PARTIAL" : "COMPLETE";
  }

  // Close the journal and write result.json. The returned evidence status is
  // separate from testOutcome and never replaces it.
  function finish({ testOutcome, failure } = {}) {
    if (finished) return status();
    for (const stop of [...samplers]) stop();
    for (const key of [...pending.keys()]) flush(key);
    finished = true;
    if (fd === undefined) return status();
    const outcome = oneOf(testOutcome, OUTCOMES) ?? "<rejected>";
    append({ kind: "finish", testOutcome: outcome }, { reserved: true });
    try { closeSync(fd); } catch (error) { issue(issueCode("JOURNAL_CLOSE", error)); }
    fd = undefined;
    try {
      const result = compact({
        schemaVersion: EVIDENCE_SCHEMA, suite, client, platform: process.platform, startedAt, durationMs: elapsed(),
        testOutcome: outcome, failure: failure === undefined ? undefined : project(failure),
        journal: { records, bytes, dropped },
      });
      result.evidenceStatus = status();
      result.evidenceIssues = [...issues.keys()].sort();
      const target = join(suiteDirectory, "result.json"), temporary = `${target}.${process.pid}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      renameSync(temporary, target);
    } catch (error) {
      issue(issueCode("RESULT_WRITE", error));
    }
    return status();
  }

  return { get status() { return status(); }, get issues() { return [...issues.keys()].sort(); }, observe, track, collect, issue, finish };
}

// Reads newline-terminated JSON records. A record without its newline is the
// interrupted last write of a killed process and is reported, not parsed. A read cut
// short at maxBytes is reported as readTruncated; its partial last line is not an interrupted write.
export function readJournal(path, { maxBytes = 4 * 1024 * 1024 } = {}) {
  const { text, truncated } = readBounded(path, maxBytes);
  const lines = text.split("\n");
  const tail = lines.pop();
  const records = [];
  let invalidLines = 0;
  for (const line of lines) {
    try {
      const record = JSON.parse(line);
      if (record && typeof record === "object" && !Array.isArray(record)) records.push(record);
      else invalidLines += 1;
    } catch {
      invalidLines += 1;
    }
  }
  return { records, invalidLines, truncatedTail: !truncated && tail !== "", readTruncated: truncated };
}

function readBounded(path, maxBytes) {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(maxBytes + 1);
    const length = readSync(fd, buffer, 0, buffer.length, 0);
    return { text: buffer.subarray(0, Math.min(length, maxBytes)).toString("utf8"), truncated: length > maxBytes };
  } finally {
    closeSync(fd);
  }
}

function readJsonFile(path, maxBytes = 256 * 1024) {
  const { text, truncated } = readBounded(path, maxBytes);
  if (truncated) throw Object.assign(new Error("too large"), { code: "EVIDENCE_FILE_TOO_LARGE" });
  return JSON.parse(text);
}

// The evidence directory must be a real, empty directory outside the runtime that cleanup removes.
export function prepareEvidenceDirectory(path, forbiddenRoot) {
  const fail = (reason) => { throw Object.assign(new Error(reason), { code: reason }); };
  if (typeof path !== "string" || !isAbsolute(path)) fail("EVIDENCE_DIRECTORY_NOT_ABSOLUTE");
  if (typeof forbiddenRoot !== "string" || !isAbsolute(forbiddenRoot)) fail("EVIDENCE_ROOT_NOT_ABSOLUTE");
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) fail("EVIDENCE_DIRECTORY_INVALID");
  if (readdirSync(path).length) fail("EVIDENCE_DIRECTORY_NOT_EMPTY");
  const evidence = realpathSync(path), runtime = realpathSync(forbiddenRoot);
  const inside = (child, parent) => {
    const local = relative(parent, child);
    return local === "" || (!/^\.\.(?:[\\/]|$)/.test(local) && !isAbsolute(local));
  };
  if (inside(evidence, runtime) || inside(runtime, evidence)) fail("EVIDENCE_DIRECTORY_OVERLAPS_RUNTIME");
  return evidence;
}

const LEDGER_EVENTS = ["start", "end", "skip", "not_run", "incomplete"];
const SKIP_REASONS = ["pending_implementation"];
const WRAPPER_PHASES = ["setup", "suites", "cleanup"];
// Suites whose runners write a journal and a result; the ledger alone tracks every other suite.
const EVIDENCE_SUITES = new Set(["codex-install-smoke", "codex-install-interruption-check", "opencode-native-check", "claude-install-smoke"]);

function writeLedgerRecord(directory, record) {
  appendFileSync(join(directory, "ledger.jsonl"), `${JSON.stringify({ v: EVIDENCE_SCHEMA, at: new Date().toISOString(), ...record })}\n`,
    { mode: 0o600 });
}

// Record the wrapper's planned suites first, so a killed wrapper still reports unreached suites.
export function planLedger(directory, suites) {
  if (!Array.isArray(suites) || !suites.length || !suites.every((suite) => SUITE.test(suite))) throw usageError();
  writeLedgerRecord(directory, { event: "plan", suites });
}

// Record the running wrapper phase, so a failure outside every suite is classified by where it happened.
export function phaseLedger(directory, phase) {
  if (!WRAPPER_PHASES.includes(phase)) throw usageError();
  writeLedgerRecord(directory, { event: "phase", phase });
}

export function appendLedger(directory, event, suite, detail) {
  if (!LEDGER_EVENTS.includes(event) || !SUITE.test(suite)) throw usageError();
  const record = { event, suite };
  if (event === "end") {
    const exitCode = Number(detail);
    if (!/^-?\d{1,10}$/.test(String(detail)) || boundedInt(exitCode, -2147483648, 4294967295) === undefined) throw usageError();
    record.exitCode = exitCode;
  }
  if (event === "skip") {
    if (!SKIP_REASONS.includes(detail)) throw usageError();
    record.reason = detail;
  }
  writeLedgerRecord(directory, record);
}

export function readLedger(directory, { missingOk = false } = {}) {
  let journal;
  try { journal = readJournal(join(directory, "ledger.jsonl")); }
  catch (error) {
    if (!missingOk || error.code !== "ENOENT") throw error;
    journal = { records: [], truncatedTail: false, invalidLines: 0, readTruncated: false };
  }
  const suites = new Map();
  let phase;
  for (const record of journal.records) {
    if (record.event === "plan" && Array.isArray(record.suites)) {
      for (const suite of record.suites) if (SUITE.test(suite) && !suites.has(suite)) suites.set(suite, { suite, status: "PLANNED" });
      continue;
    }
    if (record.event === "phase") {
      if (WRAPPER_PHASES.includes(record.phase)) phase = record.phase;
      continue;
    }
    if (!SUITE.test(record.suite) || !LEDGER_EVENTS.includes(record.event)) continue;
    const entry = suites.get(record.suite) ?? { suite: record.suite };
    if (record.event === "start") entry.status = "RUNNING";
    if (record.event === "end") {
      entry.status = record.exitCode === 0 ? "PASS" : "FAIL";
      entry.exitCode = boundedInt(record.exitCode, -2147483648, 4294967295);
    }
    if (record.event === "skip") entry.status = "SKIPPED_BY_DESIGN";
    if (record.event === "not_run") entry.status = "NOT_RUN";
    if (record.event === "incomplete") entry.status = "INCOMPLETE";
    suites.set(record.suite, entry);
  }
  return { suites, phase, truncatedTail: journal.truncatedTail, invalidLines: journal.invalidLines, readTruncated: journal.readTruncated };
}

// Mark planned suites the wrapper never reached and suites that started without ending.
export function finalizeLedger(directory, planned) {
  const { suites } = readLedger(directory, { missingOk: true });
  for (const suite of planned) {
    if (!SUITE.test(suite)) throw usageError();
    const status = suites.get(suite)?.status;
    if (status === undefined || status === "PLANNED") appendLedger(directory, "not_run", suite);
    else if (status === "RUNNING") appendLedger(directory, "incomplete", suite);
  }
}

const CLIENTS = ["codex", "opencode", "claude", "codebuddy", "cursor"];
const CHANNELS = ["baseline", "latest", "baseline+latest"];
const RUNNER_LABEL = /^(?:ubuntu|macos|windows)-[0-9a-z.-]{1,16}$/;
const PASSING = ["PASS", "SKIPPED_BY_DESIGN"];

// Only an instrumented suite that started owes a journal and a result. NOT_RUN, skipped
// and uninstrumented suites have nothing to report, so their absence is not an evidence gap.
function suiteEvidence(entry, suitesDirectory, issues) {
  if (!EVIDENCE_SUITES.has(entry.suite)) return "not_instrumented";
  if (!["PASS", "FAIL", "INCOMPLETE"].includes(entry.status)) return "not_run";
  const id = entry.suite.toUpperCase().replaceAll("-", "_");
  const before = issues.size;
  let journal;
  try { journal = readJournal(join(suitesDirectory, entry.suite, "journal.jsonl")); }
  catch (error) {
    issues.add(`${error.code === "ENOENT" ? "JOURNAL_MISSING" : "JOURNAL_UNREADABLE"}_${id}`);
    return "missing";
  }
  if (journal.truncatedTail) issues.add(`JOURNAL_TRUNCATED_TAIL_${id}`);
  if (journal.invalidLines) issues.add(`JOURNAL_INVALID_LINES_${id}`);
  if (journal.readTruncated) issues.add(`JOURNAL_READ_TRUNCATED_${id}`);
  const progress = journal.records.filter((record) => record.kind === "observe" && record.key === "progress").at(-1)?.value;
  if (progress && typeof progress === "object") entry.lastProgress = progress;
  let result;
  try { result = readJsonFile(join(suitesDirectory, entry.suite, "result.json")); }
  catch {
    issues.add(`RESULT_MISSING_${id}`);
    return "partial";
  }
  entry.result = { testOutcome: oneOf(result.testOutcome, OUTCOMES), failure: result.failure, evidenceStatus: result.evidenceStatus };
  if (result.evidenceStatus !== "COMPLETE") issues.add(`SUITE_EVIDENCE_${oneOf(result.evidenceStatus, ["PARTIAL", "UNAVAILABLE"]) ?? "UNKNOWN"}_${id}`);
  // The runner's own result must agree with the exit status the wrapper recorded. A result for a
  // suite without an end record means the ledger lost that record, not that the runner was cut short.
  if (entry.status !== "INCOMPLETE" && entry.result.testOutcome !== entry.status) issues.add(`RESULT_OUTCOME_MISMATCH_${id}`);
  if (entry.status === "INCOMPLETE" && entry.result.testOutcome) issues.add(`LEDGER_END_MISSING_${id}`);
  return issues.size === before ? "recorded" : "partial";
}

const STEP_OUTCOMES = ["success", "failure", "cancelled", "skipped"];

// Classify a failure from the runner's own result, falling back to the exit status the wrapper recorded.
function reportedFailure(entry) {
  const failure = entry.result?.failure;
  const category = oneOf(failure?.kind, ["functional", "cleanup", "functional+cleanup"]) ?? "unclassified";
  const stage = category === "cleanup" ? `cleanup:${failure?.cleanupStage ?? "unknown"}` : failure?.stage ?? entry.lastProgress?.stage ?? "unknown";
  return [category, stage, failure?.code ?? `EXIT_${entry.exitCode ?? "UNKNOWN"}`];
}

// Combine the wrapper ledger and suite results into one job-level record.
export function summarizeEvidence(root, options = {}) {
  const client = oneOf(options.client, CLIENTS) ?? "unknown";
  const os = typeof options.os === "string" && RUNNER_LABEL.test(options.os) ? options.os : "unknown";
  const stepOutcome = oneOf(options.testStepOutcome, STEP_OUTCOMES);
  // A skipped step leaves nothing behind: skipped input recording owes no inputs.json,
  // and a skipped test step never starts the wrapper.
  const inputsExpected = oneOf(options.inputsStepOutcome, STEP_OUTCOMES) !== "skipped";
  const ledgerExpected = stepOutcome !== "skipped";
  const issues = new Set();
  const suitesDirectory = join(root, "suites");
  if (inputsExpected) {
    try { readJsonFile(join(root, "inputs.json")); } catch { issues.add("INPUTS_MISSING"); }
  }
  let ledger;
  try { ledger = readLedger(suitesDirectory); }
  catch (error) { if (ledgerExpected) issues.add(error.code === "ENOENT" ? "LEDGER_MISSING" : "LEDGER_UNREADABLE"); }
  if (ledger?.truncatedTail) issues.add("LEDGER_TRUNCATED_TAIL");
  if (ledger?.invalidLines) issues.add("LEDGER_INVALID_LINES");
  if (ledger?.readTruncated) issues.add("LEDGER_READ_TRUNCATED");
  const suites = ledger ? [...ledger.suites.values()] : [];
  for (const entry of suites) {
    // A killed wrapper never finalizes its ledger; derive the statuses finalize would record.
    if (entry.status === "PLANNED") entry.status = "NOT_RUN";
    if (entry.status === "RUNNING") entry.status = "INCOMPLETE";
    entry.evidence = suiteEvidence(entry, suitesDirectory, issues);
  }
  const failed = suites.find((entry) => entry.status === "FAIL");
  const unconfirmed = suites.find((entry) => entry.status === "INCOMPLETE");
  let testOutcome, category, signature;
  if (stepOutcome === "skipped") testOutcome = "NOT_RUN";
  else if (stepOutcome === "success" || (!stepOutcome && suites.length && suites.every((entry) => PASSING.includes(entry.status)))) testOutcome = "PASS";
  else testOutcome = "FAIL";
  if (stepOutcome === "success" && (failed || unconfirmed)) issues.add("LEDGER_OUTCOME_MISMATCH");
  if (testOutcome === "FAIL") {
    let suite = "wrapper", stage, failureCode;
    if (failed) {
      suite = failed.suite;
      [category, stage, failureCode] = reportedFailure(failed);
    } else if (unconfirmed) {
      // The wrapper never confirmed this suite's exit. A failure the runner reported itself is kept;
      // any other runner result does not prove a normal exit, so that completion stays unconfirmed.
      // A suite that left no result at all is reported as interrupted.
      suite = unconfirmed.suite;
      const progress = unconfirmed.lastProgress ?? {};
      const progressStage = [progress.stage, progress.backgroundStage].filter((part) => typeof part === "string").join("/") || "unknown";
      if (unconfirmed.result?.testOutcome === "FAIL" && unconfirmed.result.failure) [category, stage, failureCode] = reportedFailure(unconfirmed);
      else if (unconfirmed.result) [category, stage, failureCode] = ["unclassified", progressStage, "EXIT_UNCONFIRMED"];
      else [category, stage, failureCode] = ["interrupted", progressStage, "INCOMPLETE"];
    } else if (ledger?.phase === "cleanup" && suites.length && suites.every((entry) => PASSING.includes(entry.status))) {
      [category, stage, failureCode] = ["wrapper_cleanup", "cleanup", "WRAPPER_CLEANUP_FAILED"];
    } else if (ledger?.phase === "setup") {
      [category, stage, failureCode] = ["setup", "setup", "WRAPPER_SETUP_FAILED"];
    } else {
      // Without a recorded phase the failure location is unknown; do not guess setup.
      [category, stage, failureCode] = ["unclassified", ledger?.phase ?? "unknown", "WRAPPER_FAILED"];
    }
    signature = [client, os, suite, stage, failureCode]
      .map((part) => String(part).replace(/[^\p{L}\p{N} _.:/()<>+-]/gu, "?").slice(0, 120)).join("|");
  }
  const evidenceStatus = ledgerExpected && !ledger ? "UNAVAILABLE" : issues.size ? "PARTIAL" : "COMPLETE";
  const summary = compact({
    schemaVersion: EVIDENCE_SCHEMA, client, os,
    channel: oneOf(options.channel, CHANNELS), clientVersion: semver(options.clientVersion),
    node: typeof options.node === "string" && /^\d{1,3}$/.test(options.node) ? options.node : undefined,
    runAttempt: boundedInt(Number(options.runAttempt), 1, 1000),
    testOutcome, category, signature, wrapperPhase: ledger?.phase, evidenceStatus, evidenceIssues: [...issues].sort(),
    // status is what the wrapper recorded; reportedOutcome is what the runner reported about itself.
    suites: suites.map((entry) => compact({
      suite: entry.suite, status: entry.status, exitCode: entry.exitCode, evidence: entry.evidence,
      reportedOutcome: entry.result?.testOutcome, failure: entry.result?.failure, evidenceStatus: entry.result?.evidenceStatus,
      lastProgress: entry.lastProgress,
    })),
  });
  writeFileSync(join(root, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  return summary;
}

export function renderSummary(summary) {
  const suites = (summary.suites ?? []).map((entry) => {
    const notes = [entry.exitCode ? `exit ${entry.exitCode}` : undefined,
      entry.reportedOutcome && entry.reportedOutcome !== entry.status ? `runner reported ${entry.reportedOutcome}` : undefined,
      ["missing", "partial"].includes(entry.evidence) ? `evidence ${entry.evidence}` : undefined].filter(Boolean);
    return `${entry.suite} ${entry.status === "FAIL" ? "**FAIL**" : entry.status}${notes.length ? ` (${notes.join(", ")})` : ""}`;
  });
  const lines = [
    `### Native CI evidence: ${summary.client} ${summary.os}${summary.channel ? ` (${summary.channel} ${summary.clientVersion ?? ""}, Node ${summary.node ?? "?"})` : ""}`,
    "",
    `- testOutcome: **${summary.testOutcome}**${summary.category ? ` (category: ${summary.category})` : ""}`,
    ...(summary.signature ? [`- signature: \`${summary.signature}\``] : []),
    `- evidenceStatus: **${summary.evidenceStatus}**${summary.evidenceIssues?.length ? ` (${summary.evidenceIssues.join(", ")})` : ""}`,
    `- suites: ${suites.length ? suites.join(" · ") : "none recorded"}`,
  ];
  if (summary.runAttempt > 1) {
    lines.push(`- This is re-run attempt ${summary.runAttempt}. Earlier attempts keep their own artifacts (suffix \`-attempt1\` …); a passing re-run does not mark an earlier failure as fixed.`);
  }
  return `${lines.join("\n")}\n\n`;
}

const EXPORT_WARNINGS = {
  EMPTY: "The evidence upload step succeeded without creating an artifact; the test outcome is unchanged.",
  UPLOAD_FAILED: "The evidence artifact was not uploaded; the test outcome is unchanged.",
  NOT_ATTEMPTED: "The evidence upload step did not run; the test outcome is unchanged.",
};

// Only a successful upload step that returned an artifact ID counts as exported evidence.
export function exportStatus({ outcome, artifactId } = {}) {
  if (outcome === "success") return typeof artifactId === "string" && /^\d{1,20}$/.test(artifactId) ? "UPLOADED" : "EMPTY";
  return outcome === "skipped" ? "NOT_ATTEMPTED" : "UPLOAD_FAILED";
}

const SELF_TEST_COUNTS = ["tests", "pass", "fail", "cancelled", "skipped", "todo"];

// A CI tool self-test passes only when every test it ran executed and passed. node:test exits 0
// for skipped and todo tests, so the TAP summary counts decide, not the exit status alone.
export function selfTestStatus(tap, exitCode) {
  const counts = {};
  for (const line of tap.split(/\r?\n/)) {
    const match = /^# (tests|pass|fail|cancelled|skipped|todo) (\d{1,6})$/.exec(line);
    if (match) counts[match[1]] = Number(match[2]);
  }
  if (!SELF_TEST_COUNTS.every((name) => name in counts)) return { status: "FAIL" };
  const executed = counts.tests > 0 && counts.pass === counts.tests
    && counts.fail === 0 && counts.cancelled === 0 && counts.skipped === 0 && counts.todo === 0;
  return { status: exitCode === 0 && executed ? "PASS" : "FAIL", counts };
}

const exec = promisify(execFile);
const sha256File = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const githubText = (value, pattern) => typeof value === "string" && pattern.test(value) ? value : undefined;

function githubSource(env = process.env) {
  return compact({
    repository: githubText(env.GITHUB_REPOSITORY, /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/),
    sha: githubText(env.GITHUB_SHA, /^[a-f0-9]{40}$/),
    ref: githubText(env.GITHUB_REF, /^refs\/(?:heads|tags|pull)\/[A-Za-z0-9._/-]{1,200}$/),
    event: token(env.GITHUB_EVENT_NAME),
    runId: githubText(env.GITHUB_RUN_ID, /^\d{1,20}$/),
    runAttempt: githubText(env.GITHUB_RUN_ATTEMPT, /^\d{1,4}$/),
    job: githubText(env.GITHUB_JOB, /^[A-Za-z][A-Za-z0-9_-]{0,99}$/),
  });
}

function packageFile(directory) {
  const names = readdirSync(directory).filter((name) => /^memorax-memorax-code-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\.tgz$/.test(name));
  return names.length === 1 ? names[0] : undefined;
}

function packageProvenance(options) {
  const file = packageFile(options["package-dir"]);
  const sha256 = file ? sha256File(join(options["package-dir"], file)) : undefined;
  const expected = githubText(options["expected-package-sha256"], /^[a-f0-9]{64}$/);
  return compact({
    file, sha256, expectedSha256: expected,
    sha256Matches: sha256 && expected ? sha256 === expected : undefined,
    artifact: compact({
      name: githubText(options["package-artifact-name"], /^[A-Za-z0-9._+-]{1,120}$/),
      id: githubText(options["package-artifact-id"], /^\d{1,20}$/),
      digest: githubText(options["package-artifact-digest"], /^(?:sha256:)?[a-f0-9]{64}$/),
    }),
  });
}

// Record what one matrix job tested; fields come from GitHub context and typed options only.
export function recordInputs(output, options, env = process.env) {
  const record = {
    schemaVersion: EVIDENCE_SCHEMA, recordedAt: new Date().toISOString(),
    source: githubSource(env),
    runner: compact({
      os: oneOf(env.RUNNER_OS, ["Linux", "macOS", "Windows"]), arch: oneOf(env.RUNNER_ARCH, ["X64", "ARM64", "X86", "ARM"]),
      label: githubText(options["matrix-os"], RUNNER_LABEL), imageOS: token(env.ImageOS),
      imageVersion: githubText(env.ImageVersion, /^\d{8}\.\d{1,6}(?:\.\d{1,6})?$/),
    }),
    node: compact({ version: githubText(process.version, /^v\d+\.\d+\.\d+$/), matrix: githubText(options["matrix-node"], /^\d{1,3}$/) }),
    npm: compact({ version: semver(options["npm-version"]) }),
    client: compact({ name: oneOf(options.client, CLIENTS), channel: oneOf(options.channel, CHANNELS), version: semver(options["client-version"]) }),
    package: packageProvenance(options),
  };
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  writeFileSync(output, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return record;
}

const NPM_CLIENTS = { codex: "@openai/codex", opencode: "opencode-ai", claude: "@anthropic-ai/claude-code", codebuddy: "@tencent-ai/codebuddy-code" };
// CodeBuddy versions are resolved against the public registry explicitly in the workflow.
const EXPLICIT_REGISTRY = { codebuddy: "https://registry.npmjs.org/" };

// Record the run's candidate package and frozen client versions with their sources and checksums.
export async function recordManifest(output, options, { env = process.env, npm = ["npm"] } = {}) {
  const [npmFile, ...npmArgs] = npm;
  const lookup = async (name, version) => {
    const registry = EXPLICIT_REGISTRY[name];
    try {
      const { stdout } = await exec(npmFile, [...npmArgs, "view", `${NPM_CLIENTS[name]}@${version}`, "dist.integrity", "dist.shasum", "--json",
        ...(registry ? [`--registry=${registry}`] : [])], { timeout: 30_000, maxBuffer: 64 * 1024, encoding: "utf8" });
      const dist = JSON.parse(stdout);
      return compact({
        integrity: githubText(dist["dist.integrity"], /^sha512-[A-Za-z0-9+/]{86}==$/),
        shasum: githubText(dist["dist.shasum"], /^[a-f0-9]{40}$/), lookup: "OK",
      });
    } catch (error) {
      return compact({ lookup: "FAILED", error: projectError(error) });
    }
  };
  let defaultRegistry;
  try {
    defaultRegistry = githubText((await exec(npmFile, [...npmArgs, "config", "get", "registry"], { timeout: 15_000, encoding: "utf8" })).stdout.trim(),
      /^https:\/\/[A-Za-z0-9.-]{1,100}(?::\d{1,5})?\/(?:[A-Za-z0-9._/-]{0,100})$/);
  } catch {}
  const clients = {};
  for (const item of [options.matrix ?? []].flat()) {
    const separator = item.indexOf("=");
    const name = item.slice(0, separator);
    if (!NPM_CLIENTS[name]) continue;
    let include = [];
    try { include = JSON.parse(item.slice(separator + 1)).include ?? []; } catch {}
    const channels = new Map();
    for (const entry of include) {
      const version = semver(entry?.[name]);
      if (!version) continue;
      const set = channels.get(version) ?? new Set();
      for (const channel of String(entry.channel).split("+")) if (["baseline", "latest"].includes(channel)) set.add(channel);
      channels.set(version, set);
    }
    if (!channels.size) continue;
    clients[name] = {
      npmPackage: NPM_CLIENTS[name], registry: EXPLICIT_REGISTRY[name] ?? defaultRegistry ?? "unknown",
      versions: await Promise.all([...channels].map(async ([version, set]) => ({ version, channels: [...set].sort(), ...(await lookup(name, version)) }))),
    };
  }
  const cursor = options["cursor-releases"];
  const manifest = compact({
    schemaVersion: EVIDENCE_SCHEMA, recordedAt: new Date().toISOString(), source: githubSource(env),
    package: packageProvenance(options), clients,
    cursorReleases: cursor ? compact({
      artifact: githubText(options["cursor-releases-artifact-name"], /^[A-Za-z0-9._+-]{1,120}$/),
      sha256: (() => { try { return sha256File(cursor); } catch { return undefined; } })(),
    }) : undefined,
  });
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return manifest;
}

function usageError() {
  return Object.assign(new Error("Invalid CI evidence arguments"), { usage: true });
}

function parseOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = /^--([a-z][a-z0-9-]{0,40})$/.exec(args[index])?.[1];
    if (!name || index + 1 >= args.length) throw usageError();
    if (name === "matrix") (options.matrix ??= []).push(args[index + 1]);
    else options[name] = args[index + 1];
  }
  return options;
}

export async function runCli(args) {
  const [command, ...rest] = args;
  try {
    if (command === "prepare" && rest.length === 2) {
      console.log(prepareEvidenceDirectory(rest[0], rest[1]));
      return 0;
    }
    if (command === "ledger" && rest.length >= 3) {
      const [directory, event, ...detail] = rest;
      if (event === "plan" && detail.length === 1) planLedger(directory, detail[0].split(","));
      else if (event === "phase" && detail.length === 1) phaseLedger(directory, detail[0]);
      else if (event === "finalize" && detail.length === 1) finalizeLedger(directory, detail[0].split(","));
      else if (["start", "end", "skip"].includes(event) && detail.length === (event === "start" ? 1 : 2)) appendLedger(directory, event, ...detail);
      else throw usageError();
      return 0;
    }
    if (command === "inputs" && rest.length >= 1) {
      try { recordInputs(rest[0], parseOptions(rest.slice(1))); }
      catch (error) { if (error.usage) throw error; console.log(`::warning title=CI evidence::Native test inputs were not recorded (${projectError(error).code ?? "FAILED"}).`); }
      return 0;
    }
    if (command === "manifest" && rest.length >= 1) {
      try { await recordManifest(rest[0], parseOptions(rest.slice(1))); }
      catch (error) { if (error.usage) throw error; console.log(`::warning title=CI evidence::The native client input manifest was not recorded (${projectError(error).code ?? "FAILED"}).`); }
      return 0;
    }
    if (command === "summarize" && rest.length >= 1) {
      const options = parseOptions(rest.slice(1));
      try {
        const summary = summarizeEvidence(rest[0], {
          client: options.client, os: options.os, channel: options.channel, clientVersion: options["client-version"],
          node: options.node, testStepOutcome: options["test-step-outcome"], inputsStepOutcome: options["inputs-step-outcome"],
          runAttempt: options["run-attempt"],
        });
        if (options["github-summary"]) appendFileSync(options["github-summary"], renderSummary(summary));
        if (summary.evidenceStatus !== "COMPLETE") {
          console.log(`::warning title=CI evidence::Evidence is ${summary.evidenceStatus}; the test outcome is reported separately.`);
        }
      } catch (error) {
        console.log(`::warning title=CI evidence::The evidence summary failed (${projectError(error).code ?? "FAILED"}); the test outcome is unchanged.`);
      }
      return 0;
    }
    if (command === "export-status" && rest.length >= 2) {
      const options = parseOptions(rest);
      const status = exportStatus({ outcome: options.outcome, artifactId: options["artifact-id"] });
      if (status !== "UPLOADED") console.log(`::warning title=CI evidence export::${EXPORT_WARNINGS[status]}`);
      if (options["github-summary"]) {
        try {
          appendFileSync(options["github-summary"], `- exportStatus: **${status}**${status === "UPLOADED" ? ` (artifact ID ${options["artifact-id"]})` : ""}\n\n`);
        } catch (error) {
          console.log(`::warning title=CI evidence export::The export status could not be written (${projectError(error).code ?? "FAILED"}); the test outcome is unchanged.`);
        }
      }
      console.log(`exportStatus=${status}`);
      return 0;
    }
    // Reported on its own summary line: a self-test failure fails the job but is not a native test outcome.
    if (command === "self-test-status" && rest.length >= 4) {
      const options = parseOptions(rest);
      if (!options.tap || !/^-?\d{1,10}$/.test(options["exit-code"] ?? "")) throw usageError();
      let tap = "";
      try { tap = readBounded(options.tap, 4 * 1024 * 1024).text; } catch {}
      const { status, counts } = selfTestStatus(tap, Number(options["exit-code"]));
      const detail = counts ? `${counts.tests} tests: ${counts.pass} passed, ${counts.fail} failed, ${counts.skipped} skipped, `
        + `${counts.todo} todo, ${counts.cancelled} cancelled` : "no node:test summary";
      if (status !== "PASS") {
        console.log(`::error title=CI tool self-test::Not every expected self-test executed and passed (${detail}); the native testOutcome is reported separately.`);
      }
      if (options["github-summary"]) {
        try { appendFileSync(options["github-summary"], `- CI tool self-test (evidence wrappers): **${status}** (${detail})\n\n`); }
        catch (error) { console.log(`::warning title=CI tool self-test::The self-test status could not be written (${projectError(error).code ?? "FAILED"}).`); }
      }
      console.log(`selfTestStatus=${status}`);
      return status === "PASS" ? 0 : 1;
    }
    throw usageError();
  } catch (error) {
    if (error.usage) {
      console.error("Usage: ci-evidence.mjs prepare DIR RUNTIME_ROOT | ledger DIR plan|phase|start|end|skip|finalize ... | inputs FILE ... | manifest FILE ... | summarize ROOT ... | export-status --outcome ... | self-test-status --tap FILE --exit-code N ...");
      return 2;
    }
    console.error(`CI evidence ${command} failed: ${projectError(error).code ?? "FAILED"}`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runCli(process.argv.slice(2));
}
