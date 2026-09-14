import { randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const MAX_RECORDS = 1000;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const RECORD_NAME = /^mc-(\d{13})-[a-f0-9-]{36}\.json$/;

// Callers supply safe, content-free fields, never raw exceptions or payloads.
// Separate immutable files avoid a shared append/rotation lock across CLI processes.
export function writeDiagnosticRecord(memoraxCodeHome, fields) {
  const now = Date.now();
  const id = `mc-${now}-${randomUUID()}`;
  const record = { ...fields, schemaVersion: 1, id, timestamp: new Date(now).toISOString() };
  let path;
  try {
    const home = resolve(memoraxCodeHome);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    let directory = home;
    for (const segment of ["runtime", "diagnostics"]) {
      directory = join(directory, segment);
      try { mkdirSync(directory, { mode: 0o700 }); }
      catch (error) { if (error.code !== "EEXIST") throw error; }
      const stat = lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        return { id, recorded: false, recordingError: "DIAGNOSTIC_DIRECTORY_INVALID" };
      }
    }
    if (process.platform !== "win32") chmodSync(directory, 0o700);
    path = join(directory, `${id}.json`);
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    // Only owned filenames are pruned. A concurrent writer/remover is harmless.
    // Cleanup failure never hides a record that was successfully written.
    try {
      const names = readdirSync(directory).filter((name) => RECORD_NAME.test(name)).sort().reverse();
      for (const [index, name] of names.entries()) {
        if (index < MAX_RECORDS && now - Number(RECORD_NAME.exec(name)[1]) <= RETENTION_MS) continue;
        const candidate = join(directory, name);
        if (candidate !== path) {
          try { unlinkSync(candidate); } catch { /* Another process may have pruned it. */ }
        }
      }
    } catch { /* Diagnostics remain usable when retention cleanup is unavailable. */ }
    return { id, recorded: true, path };
  } catch (error) {
    // Errors may embed paths or sensitive text. Return only known filesystem codes.
    const code = ["EACCES", "EPERM", "ENOSPC", "EROFS", "ENOTDIR", "ENOENT", "EMFILE", "ENAMETOOLONG"]
      .includes(error?.code) ? error.code : "DIAGNOSTIC_WRITE_FAILED";
    return { id, recorded: false, recordingError: code };
  }
}
