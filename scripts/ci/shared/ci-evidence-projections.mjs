// Typed projections for native CI evidence. Every projector copies only
// allowlisted fields whose values match a narrow type. Free text, command
// lines, raw logs, configuration, content and absolute paths are never returned.
import { open, readdir, lstat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

export const SYSTEM_CODES = new Set([
  "EACCES", "EADDRINUSE", "EADDRNOTAVAIL", "EBADF", "EBUSY", "ECONNREFUSED", "ECONNRESET", "EEXIST", "EINVAL", "EIO",
  "EISDIR", "ELOOP", "EMFILE", "ENAMETOOLONG", "ENFILE", "ENOENT", "ENOEXEC", "ENOMEM", "ENOSPC", "ENOTDIR", "ENOTEMPTY",
  "ENXIO", "EPERM", "EPIPE", "EROFS", "ESRCH", "ETIMEDOUT",
]);
const SIGNALS = ["SIGTERM", "SIGKILL", "SIGINT", "SIGABRT", "SIGHUP", "SIGSEGV"];
const ERROR_NAMES = ["Error", "TypeError", "RangeError", "SyntaxError", "AbortError", "TimeoutError", "AggregateError"];
const CLIENTS = ["codex", "claude", "dsh", "opencode", "codebuddy", "workbuddy", "trae", "cursor"];
const CODE = /^[A-Z][A-Z0-9_]{1,79}$/;
const TOKEN = /^[a-z][a-z0-9_.-]{0,63}$/;
const SEMVER = /^\d{1,4}\.\d{1,4}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,32})?$/;
const SEGMENT = /^[\p{L}\p{N} ._@+()-]{1,80}$/u;
const LABEL = /^[a-z][a-z0-9-]{0,31}$/;
const DIAGNOSTIC_ID = /^mc-\d{13}-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

export const code = (value) => typeof value === "string" && CODE.test(value) ? value : undefined;
export const token = (value) => typeof value === "string" && TOKEN.test(value) ? value : undefined;
export const semver = (value) => typeof value === "string" && SEMVER.test(value) ? value : undefined;
export const systemCode = (value) => SYSTEM_CODES.has(value) ? value : undefined;
export const signal = (value) => SIGNALS.includes(value) ? value : undefined;
export const oneOf = (value, allowed) => allowed.includes(value) ? value : undefined;
export const boundedInt = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max ? value : undefined;
const exitCode = (value) => boundedInt(value, -2147483648, 4294967295);
const isoTime = (value) => typeof value === "string" && ISO_TIME.test(value) ? value : undefined;

export function compact(record) {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

export function projectError(error) {
  return compact({
    name: oneOf(error?.name, ERROR_NAMES),
    code: systemCode(error?.code) ?? code(error?.code) ?? exitCode(error?.code),
    nativeCode: code(error?.nativeCode),
    operation: code(error?.nativeOperation),
    signal: signal(error?.signal),
    killed: typeof error?.killed === "boolean" ? error.killed : undefined,
  });
}

// Returns "<label>/relative/segments" for a path inside one of the named test roots.
export function projectPathAlias(path, roots) {
  if (typeof path !== "string" || !isAbsolute(path)) return undefined;
  for (const [label, root] of Object.entries(roots ?? {})) {
    if (!LABEL.test(label) || typeof root !== "string" || !isAbsolute(root)) continue;
    const local = relative(resolve(root), resolve(path));
    if (local === "") return `<${label}>`;
    if (/^\.\.(?:[\\/]|$)/.test(local) || isAbsolute(local)) continue;
    const segments = local.split(/[\\/]+/);
    if (segments.length > 16) return `<${label}>/<too-deep>`;
    return [`<${label}>`, ...segments.map((segment) => SEGMENT.test(segment) ? segment : "<segment>")].join("/");
  }
  return undefined;
}

// Reports whether known child processes and recorded PIDs still exist; PIDs are never returned.
// A recorded PID can be reused after exit, so "alive" means only that some process holds it.
export function projectProcessRoles(entries, alive) {
  return Object.fromEntries((entries ?? []).filter(({ role }) => /^[a-z][A-Za-z0-9]{0,31}$/.test(role)).map(({ role, pid, child }) => {
    if (child && (child.exitCode != null || child.signalCode != null)) {
      return [role, compact({ state: "exited", exitCode: exitCode(child.exitCode), signal: signal(child.signalCode) })];
    }
    const target = child ? child.pid : pid;
    if (!Number.isSafeInteger(target) || target <= 0) return [role, { state: "absent" }];
    try { return [role, { state: alive(target) ? "alive" : "exited" }]; }
    catch { return [role, { state: "unknown" }]; }
  }));
}

const JOB_STATUSES = ["preparing", "started", "running", "succeeded", "failed"];

// Projects Repo Memory job records; prompts, commands, repositories and log paths are dropped.
export function projectRepoMemoryJobs(jobs, { since, alive } = {}) {
  const list = Array.isArray(jobs) ? jobs : [];
  const offset = (value) => {
    const time = typeof value === "string" ? Date.parse(value) : NaN;
    return Number.isFinite(time) && Number.isFinite(since) ? boundedInt(Math.round(time - since), -3_600_000, 3_600_000) : undefined;
  };
  const processState = (pid) => projectProcessRoles([{ role: "process", pid }], alive ?? (() => { throw new Error("unknown"); })).process.state;
  return {
    count: list.length,
    jobs: list.slice(0, 4).map((job) => compact({
      status: oneOf(job?.status, JOB_STATUSES) ?? "unknown",
      mode: oneOf(job?.mode, ["build", "update"]),
      runner: oneOf(job?.runner, CLIENTS),
      failureReason: token(job?.failureReason),
      exitCode: job?.exitCode === null ? null : exitCode(job?.exitCode),
      worker: processState(job?.workerPid),
      child: processState(job?.childPid),
      startedAtMs: offset(job?.startedAt),
      finishedAtMs: offset(job?.finishedAt),
    })),
  };
}

const JOB_FILES = ["job.json", "output.log", "final-message.txt"];

// Lists only fixed Repo Memory file names and sizes; file contents are never read.
export async function inventoryRepoMemoryJobs(stateHome, { maxJobs = 8 } = {}) {
  const jobsRoot = join(stateHome, "repo-memory-jobs");
  let entries;
  try { entries = await readdir(jobsRoot, { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return { present: false }; throw error; }
  const jobDirectories = entries.filter((entry) => entry.isDirectory() && entry.name !== "in-progress");
  const markers = entries.some((entry) => entry.isDirectory() && entry.name === "in-progress")
    ? (await readdir(join(jobsRoot, "in-progress"))).filter((name) => name.endsWith(".json")).length : 0;
  const jobs = [];
  for (const entry of jobDirectories.slice(0, maxJobs)) {
    const files = {};
    for (const name of JOB_FILES) {
      const info = await lstat(join(jobsRoot, entry.name, name)).catch((error) => { if (error.code === "ENOENT") return undefined; throw error; });
      files[name] = info?.isFile() ? Math.min(info.size, 1_000_000_000) : null;
    }
    jobs.push(files);
  }
  return { present: true, jobDirectories: jobDirectories.length, inProgressMarkers: markers, jobs };
}

// Projects trace event types and timing from a client's trace store; payloads are never read into the result.
export async function projectTraceEvents(stateHome, client, { since, maxFiles = 8, maxBytes = 256 * 1024, maxEvents = 300 } = {}) {
  if (!CLIENTS.includes(client)) throw new TypeError("Unknown trace client");
  const files = [];
  async function walk(directory, depth) {
    if (depth > 6 || files.length >= maxFiles) return;
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      if (entry.isDirectory()) await walk(join(directory, entry.name), depth + 1);
      else if (entry.isFile() && entry.name === "events.jsonl") files.push(join(directory, entry.name));
    }
  }
  await walk(join(stateHome, "debug", "traces", client), 0);
  const events = [], byType = {};
  let malformed = 0, truncatedFiles = 0;
  for (const file of files) {
    const { text, truncated } = await readPrefix(file, maxBytes);
    if (truncated) truncatedFiles += 1;
    const lines = text.split("\n");
    if (truncated) lines.pop();
    for (const line of lines) {
      if (!line.trim() || events.length >= maxEvents) continue;
      let raw;
      try { raw = JSON.parse(line); } catch { malformed += 1; continue; }
      const type = token(raw?.type);
      if (!type) { malformed += 1; continue; }
      const time = typeof raw.timestamp === "string" ? Date.parse(raw.timestamp) : NaN;
      byType[type] = (byType[type] ?? 0) + 1;
      events.push(compact({
        type, operation: token(raw.operation), source: token(raw.source),
        ok: typeof raw.ok === "boolean" ? raw.ok : undefined,
        tMs: Number.isFinite(time) && Number.isFinite(since) ? boundedInt(Math.round(time - since), -3_600_000, 3_600_000) : undefined,
      }));
    }
  }
  events.sort((left, right) => (left.tMs ?? 0) - (right.tMs ?? 0));
  return { files: files.length, events, byType, malformed, truncatedFiles };
}

async function readPrefix(path, maxBytes) {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return { text: buffer.subarray(0, Math.min(bytesRead, maxBytes)).toString("utf8"), truncated: bytesRead > maxBytes };
  } finally {
    await handle.close();
  }
}

// Projects `memorax-code logs --diagnostics --json`. The product's summaries,
// impact, guidance and hashed identifiers are free text or identity data and are dropped.
export function projectProductDiagnostics(value) {
  const records = Array.isArray(value?.records) ? value.records : [];
  return compact({
    ok: typeof value?.ok === "boolean" ? value.ok : undefined,
    skipped: boundedInt(value?.skipped, 0, 1000),
    errorCode: code(value?.errorCode),
    systemCode: systemCode(value?.systemCode),
    records: records.slice(0, 20).map((record) => compact({
      id: typeof record?.id === "string" && DIAGNOSTIC_ID.test(record.id) ? record.id : undefined,
      timestamp: isoTime(record?.timestamp),
      source: token(record?.source), operation: token(record?.operation), stage: token(record?.stage),
      errorCode: code(record?.errorCode), systemCode: systemCode(record?.systemCode),
      client: oneOf(record?.client, CLIENTS),
      failureReason: token(record?.failureReason), recordReason: token(record?.recordReason),
      commandExitCode: exitCode(record?.commandExitCode), commandSignal: signal(record?.commandSignal),
      httpStatus: boundedInt(record?.httpStatus, 100, 599),
      processState: oneOf(record?.processState, ["not-started", "stopped", "running", "unknown"]),
      recoveryStatus: oneOf(record?.recoveryStatus, ["restored", "failed", "not-attempted", "unsupported-package"]),
      configState: oneOf(record?.configState, ["preserved", "restored", "removed", "unknown"]),
      cleanupErrorCode: code(record?.cleanupErrorCode), cleanupSystemCode: systemCode(record?.cleanupSystemCode),
      recoveryErrorCode: code(record?.recoveryErrorCode), recoveryStage: token(record?.recoveryStage),
      recoverySystemCode: systemCode(record?.recoverySystemCode),
      causeErrorCode: code(record?.causeErrorCode), causeStage: token(record?.causeStage),
      version: semver(record?.version), installedVersion: semver(record?.installedVersion), targetVersion: semver(record?.targetVersion),
      platform: oneOf(record?.platform, ["darwin", "linux", "win32"]),
    })),
  });
}
