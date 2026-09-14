import {
  closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync,
  type Stats,
} from "node:fs";
import { join, resolve } from "node:path";
import type { DiagnosticRecordFields } from "../../../memorax-code-adapter-common/src/diagnostic-record.mjs";

export type DiagnosticRecord = DiagnosticRecordFields & {
  schemaVersion: 1;
  id: string;
  timestamp: string;
};

export type DiagnosticHistory = {
  ok: boolean;
  records: DiagnosticRecord[];
  skipped: number;
  errorCode?: string;
  systemCode?: string;
};

const RECORD_ID = /^mc-(\d{13})-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_RECORDS = 1000;
const MAX_RECORD_BYTES = 64 * 1024;
const SYSTEM_CODES = new Set([
  "EACCES", "EPERM", "ENOENT", "ENOTDIR", "EISDIR", "ELOOP", "EMFILE", "ENFILE",
  "EBADF", "EINVAL", "EIO", "ENOMEM", "EBUSY", "ENXIO", "ENAMETOOLONG",
]);
const REQUIRED_STRINGS = [
  "source", "operation", "stage", "errorCode", "error", "impact", "userAction",
  "version", "runtimeVersion", "platform",
] as const;
const OPTIONAL_STRINGS = [
  "client", "sessionHash", "turnHash", "systemCode", "failureReason", "recordReason",
  "credentialReason", "commandSignal", "cleanupErrorCode", "cleanupSystemCode",
  "recoveryErrorCode", "recoveryStage", "recoverySystemCode",
] as const;
type DirectoryIdentity = { path: string; stat: Stats };

export function readDiagnosticHistory(
  home: string,
  options: { limit?: number; id?: string } = {},
): DiagnosticHistory {
  const records: DiagnosticRecord[] = [];
  const limit = options.limit ?? 5;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RECORDS) {
    return { ok: false, records, skipped: 0, errorCode: "DIAGNOSTIC_LIMIT_INVALID" };
  }
  if (options.id !== undefined && !RECORD_ID.test(options.id)) {
    return { ok: false, records, skipped: 0, errorCode: "DIAGNOSTIC_ID_INVALID" };
  }
  let directories: DirectoryIdentity[];
  let names: string[];
  try {
    directories = inspectDirectories(home);
    if (!directories.length) {
      return options.id
        ? { ok: false, records, skipped: 0, errorCode: "DIAGNOSTIC_NOT_FOUND", systemCode: "ENOENT" }
        : { ok: true, records, skipped: 0 };
    }
    const directory = directories[1]!.path;
    if (options.id) {
      records.push(readRecord(join(directory, options.id + ".json"), options.id, directories, true));
      return { ok: true, records, skipped: 0 };
    }
    const now = Date.now();
    names = readdirSync(directory)
      .filter((name) => {
        if (!name.endsWith(".json")) return false;
        const match = RECORD_ID.exec(name.slice(0, -5));
        if (!match) return false;
        const age = now - Number(match[1]);
        return age >= 0 && age <= RETENTION_MS;
      })
      .sort().reverse().slice(0, MAX_RECORDS);
  } catch (error) {
    return { ok: false, records, skipped: 0, ...diagnosticFailure(error, "DIAGNOSTIC_DIRECTORY_UNREADABLE") };
  }

  let skipped = 0;
  let failure: Pick<DiagnosticHistory, "errorCode" | "systemCode"> | undefined;
  for (const name of names) {
    try {
      records.push(readRecord(join(directories[1]!.path, name), name.slice(0, -5), directories, false));
      if (records.length === limit) break;
    } catch (error) {
      skipped += 1;
      failure ??= diagnosticFailure(error, "DIAGNOSTIC_RECORD_UNREADABLE");
    }
  }
  return { ok: true, records, skipped, ...failure };
}

function inspectDirectories(home: string): DirectoryIdentity[] {
  const directories: DirectoryIdentity[] = [];
  for (const path of [join(resolve(home), "runtime"), join(resolve(home), "runtime", "diagnostics")]) {
    let stat: Stats;
    try { stat = lstatSync(path); }
    catch (error) {
      if (systemCode(error) === "ENOENT") return [];
      throw new DiagnosticReadError(systemCode(error) === "ENOTDIR"
        ? "DIAGNOSTIC_DIRECTORY_INVALID" : "DIAGNOSTIC_DIRECTORY_UNREADABLE", safeSystemCode(error));
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new DiagnosticReadError("DIAGNOSTIC_DIRECTORY_INVALID");
    directories.push({ path, stat });
  }
  return directories;
}

function verifyDirectories(directories: DirectoryIdentity[]): void {
  for (const directory of directories) {
    let stat: Stats;
    try { stat = lstatSync(directory.path); }
    catch (error) { throw new DiagnosticReadError("DIAGNOSTIC_DIRECTORY_CHANGED", safeSystemCode(error)); }
    if (!stat.isDirectory() || stat.isSymbolicLink() || !sameFile(stat, directory.stat)) {
      throw new DiagnosticReadError("DIAGNOSTIC_DIRECTORY_CHANGED");
    }
  }
}

function readRecord(path: string, id: string, directories: DirectoryIdentity[], lookup: boolean): DiagnosticRecord {
  let fd: number | undefined;
  let observed = false;
  try {
    verifyDirectories(directories);
    const before = lstatSync(path);
    observed = true;
    if (!before.isFile() || before.isSymbolicLink()) throw new DiagnosticReadError("DIAGNOSTIC_RECORD_INVALID_FILE");
    if (before.size > MAX_RECORD_BYTES) throw new DiagnosticReadError("DIAGNOSTIC_RECORD_TOO_LARGE");
    // NONBLOCK prevents a file replaced with a FIFO from hanging the CLI.
    // NOFOLLOW protects the leaf; directory and inode rechecks protect the result.
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const opened = fstatSync(fd);
    if (!opened.isFile() || !sameFile(before, opened)) throw new DiagnosticReadError("DIAGNOSTIC_RECORD_CHANGED");
    if (opened.size > MAX_RECORD_BYTES) throw new DiagnosticReadError("DIAGNOSTIC_RECORD_TOO_LARGE");
    const buffer = Buffer.alloc(opened.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    const after = fstatSync(fd);
    const current = lstatSync(path);
    verifyDirectories(directories);
    if (!sameFile(opened, current) || !current.isFile() || current.isSymbolicLink()
      || length !== opened.size || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
      throw new DiagnosticReadError("DIAGNOSTIC_RECORD_CHANGED");
    }
    let raw: unknown;
    try { raw = JSON.parse(buffer.subarray(0, length).toString("utf8")); }
    catch { throw new DiagnosticReadError("DIAGNOSTIC_RECORD_INVALID_JSON"); }
    return projectRecord(raw, id);
  } catch (error) {
    if (error instanceof DiagnosticReadError) throw error;
    if (systemCode(error) === "ENOENT") throw new DiagnosticReadError(
      lookup && !observed ? "DIAGNOSTIC_NOT_FOUND" : "DIAGNOSTIC_RECORD_DISAPPEARED", safeSystemCode(error),
    );
    if (systemCode(error) === "ELOOP") throw new DiagnosticReadError("DIAGNOSTIC_RECORD_INVALID_FILE", "ELOOP");
    throw new DiagnosticReadError("DIAGNOSTIC_RECORD_UNREADABLE", safeSystemCode(error));
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* Read-only cleanup cannot replace the read outcome. */ }
    }
  }
}

function projectRecord(raw: unknown, id: string): DiagnosticRecord {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new DiagnosticReadError("DIAGNOSTIC_RECORD_INVALID");
  const input = raw as Record<string, unknown>;
  if (input.schemaVersion !== 1) throw new DiagnosticReadError("DIAGNOSTIC_SCHEMA_UNSUPPORTED");
  const timestamp = new Date(Number(RECORD_ID.exec(id)![1])).toISOString();
  if (input.id !== id || input.timestamp !== timestamp) throw new DiagnosticReadError("DIAGNOSTIC_RECORD_IDENTITY_MISMATCH");
  const fields = Object.fromEntries(REQUIRED_STRINGS.map((key) => [key, terminalText(input[key], true)])) as
    Pick<DiagnosticRecordFields, typeof REQUIRED_STRINGS[number]>;
  const record: DiagnosticRecord = { ...fields, schemaVersion: 1, id, timestamp };
  for (const key of OPTIONAL_STRINGS) {
    if (input[key] !== undefined) record[key] = terminalText(input[key]);
  }
  for (const key of ["commandExitCode", "httpStatus", "retryAfterMs"] as const) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== "number" || !Number.isFinite(input[key])) throw new DiagnosticReadError("DIAGNOSTIC_RECORD_INVALID");
    record[key] = input[key];
  }
  if (input.configState !== undefined) {
    if (typeof input.configState !== "string" || !["preserved", "restored", "removed", "unknown"].includes(input.configState)) throw new DiagnosticReadError("DIAGNOSTIC_RECORD_INVALID");
    record.configState = input.configState as DiagnosticRecordFields["configState"];
  }
  if (input.processState !== undefined) {
    if (typeof input.processState !== "string" || !["not-started", "stopped", "running", "unknown"].includes(input.processState)) throw new DiagnosticReadError("DIAGNOSTIC_RECORD_INVALID");
    record.processState = input.processState as DiagnosticRecordFields["processState"];
  }
  return record;
}

function terminalText(value: unknown, required = false): string {
  if (typeof value !== "string") throw new DiagnosticReadError("DIAGNOSTIC_RECORD_INVALID");
  // Preserve the writer's safe summaries, removing only terminal control and
  // directional formatting characters. Unknown JSON fields are never projected.
  const text = value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ");
  if (required && !text.trim()) throw new DiagnosticReadError("DIAGNOSTIC_RECORD_INVALID");
  return text;
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function systemCode(error: unknown): unknown {
  return error && typeof error === "object" && "code" in error ? error.code : undefined;
}

class DiagnosticReadError extends Error {
  constructor(readonly code: string, readonly systemCode?: string) { super(code); }
}

function safeSystemCode(error: unknown): string | undefined {
  const code = systemCode(error);
  return typeof code === "string" && SYSTEM_CODES.has(code) ? code : undefined;
}

function diagnosticFailure(error: unknown, fallback: string): Pick<DiagnosticHistory, "errorCode" | "systemCode"> {
  const code = error instanceof DiagnosticReadError ? error.systemCode : safeSystemCode(error);
  const errorCode = error instanceof DiagnosticReadError ? error.code
    : fallback === "DIAGNOSTIC_DIRECTORY_UNREADABLE" && code === "ENOENT" ? "DIAGNOSTIC_DIRECTORY_CHANGED" : fallback;
  return { errorCode, ...(code ? { systemCode: code } : {}) };
}
