import { lstat, open } from "node:fs/promises";

const maxOutputBytes = 64 * 1024, maxElapsedMs = 600_000, maxLogSampleBytes = 64 * 1024;
const maxFileBytes = 600_000_000;
export const windowsInstallerPhaseMarkers = Object.freeze({
  powershellStart: "MEMORAX_CURSOR_INSTALLER_START",
  launchStart: "MEMORAX_CURSOR_INSTALLER_LAUNCH_START",
  treeWaitComplete: "MEMORAX_CURSOR_INSTALLER_TREE_WAIT_COMPLETE",
  jsonComplete: "MEMORAX_CURSOR_INSTALLER_JSON_COMPLETE",
});
const elapsed = (start, now) => Math.min(maxElapsedMs, Math.max(0, Math.ceil(now() - start)));
const bytes = (value) => typeof value === "string" ? Buffer.byteLength(value) : Buffer.isBuffer(value) ? value.length : null;

function phaseObserver(start, now) {
  const entries = Object.entries(windowsInstallerPhaseMarkers);
  const phases = Object.fromEntries(entries.map(([key]) => [key, false]));
  const phaseElapsedMs = Object.fromEntries(entries.map(([key]) => [key, null]));
  let offset = 0, candidates = entries.map(() => true), carriageReturn = false;
  return {
    phases, phaseElapsedMs,
    accept(value) {
      if (typeof value !== "string" && !Buffer.isBuffer(value)) return;
      // Retain only match offsets and bits, never partial installer output.
      for (const code of Buffer.isBuffer(value) ? value : Buffer.from(value)) {
        if (code === 10) {
          entries.forEach(([key, marker], index) => {
            if (candidates[index] && offset === marker.length && !phases[key]) {
              phases[key] = true;
              phaseElapsedMs[key] = elapsed(start, now);
            }
          });
          offset = 0; candidates = entries.map(() => true); carriageReturn = false;
        } else if (code === 13 && !carriageReturn) {
          carriageReturn = true;
        } else {
          entries.forEach(([, marker], index) => {
            candidates[index] &&= !carriageReturn && offset < marker.length && code === marker.charCodeAt(offset);
          });
          offset = Math.min(offset + 1, 128);
        }
      }
    },
  };
}

export async function observeWindowsInstaller(execute, file, args, options, { now = () => performance.now() } = {}) {
  const start = now(), observer = phaseObserver(start, now), listeners = [];
  const diagnostics = {
    stdoutBytes: null, stderrBytes: null,
    powershell: { spawnObserved: null, exitObserved: null, closeObserved: null, promiseSettled: false,
      spawnElapsedMs: null, exitElapsedMs: null, closeElapsedMs: null, settledElapsedMs: null,
      exitCode: null, signal: null },
    // Start-Process -Wait reports after waiting for the tree. It does not provide
    // an independently observed root-process exit on Windows PowerShell 5.1.
    rootExitObserved: null, rootExitElapsedMs: null,
  };
  let child, result, error, succeeded = false, stderrStream = false;
  const listen = (emitter, event, handler) => {
    if (typeof emitter?.on !== "function" || typeof emitter?.removeListener !== "function") return false;
    emitter.on(event, handler); listeners.push(() => emitter.removeListener(event, handler)); return true;
  };
  const capture = (output) => {
    for (const [field, value] of [["stdoutBytes", output?.stdout], ["stderrBytes", output?.stderr]]) {
      const size = bytes(value);
      if (size !== null) diagnostics[field] = Math.min(maxOutputBytes, Math.max(diagnostics[field] ?? 0, size));
    }
    if (!stderrStream) observer.accept(output?.stderr);
  };
  const count = (field, value) => {
    const size = bytes(value);
    if (size !== null) diagnostics[field] = Math.min(maxOutputBytes, (diagnostics[field] ?? 0) + size);
  };
  try {
    const pending = execute(file, args, options);
    child = pending?.child;
    for (const event of ["spawn", "exit", "close"]) {
      if (listen(child, event, (code, signal) => {
        diagnostics.powershell[`${event}Observed`] = true;
        diagnostics.powershell[`${event}ElapsedMs`] ??= elapsed(start, now);
        if (event === "exit") {
          if (Number.isInteger(code) && code >= -2147483648 && code <= 2147483647) diagnostics.powershell.exitCode = code;
          diagnostics.powershell.signal = signal === null ? "none" : ["SIGKILL", "SIGTERM", "SIGINT"].includes(signal) ? signal : null;
        }
      })) diagnostics.powershell[`${event}Observed`] = false;
    }
    if (listen(child?.stdout, "data", (chunk) => count("stdoutBytes", chunk))) diagnostics.stdoutBytes = 0;
    stderrStream = listen(child?.stderr, "data", (chunk) => { count("stderrBytes", chunk); observer.accept(chunk); });
    if (stderrStream) diagnostics.stderrBytes = 0;
    try { result = await pending; succeeded = true; capture(result); }
    catch (caught) { error = caught; capture(caught); }
    diagnostics.powershell.promiseSettled = true;
    diagnostics.powershell.settledElapsedMs = elapsed(start, now);
  } catch (caught) {
    error = caught; capture(caught);
  } finally {
    for (const remove of listeners) remove();
  }
  return { result, error, succeeded, diagnostics: { ...diagnostics, elapsedMs: elapsed(start, now),
    powershell: { ...diagnostics.powershell }, phases: { ...observer.phases }, phaseElapsedMs: { ...observer.phaseElapsedMs } } };
}

const logEvents = new Map([
  ["Starting the installation process.", "installation-started"],
  ["Installation process succeeded.", "installation-succeeded"],
  ["Installation process failed.", "installation-failed"],
  ["-- Run entry --", "run-entry"],
  ["Deinitializing Setup.", "deinitializing"],
]);

export function classifyWindowsInstallerLog(sample, { partialStart = false, encoding = "utf8" } = {}) {
  let lastRecognizedEvent = "unknown", errorObserved = false;
  if (!Buffer.isBuffer(sample) || sample.length > maxLogSampleBytes || !["utf8", "utf16le"].includes(encoding)) {
    return { lastRecognizedEvent, errorObserved: null };
  }
  const lines = sample.toString(encoding).split(/\r?\n/);
  if (partialStart) lines.shift();
  for (const raw of lines) {
    const line = raw.replace(/^\uFEFF/, "").replace(/^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(?:\.\d{1,3})?\s+/, "");
    if (logEvents.has(line)) lastRecognizedEvent = logEvents.get(line);
    if (/^(?:Error|Exception message):(?: |$)/.test(line)) errorObserved = true;
  }
  // Inno log formatting is not a stable interface. Unrecognized text stays
  // unknown, and these observations never establish installation or cleanup.
  return { lastRecognizedEvent, errorObserved };
}

export async function readWindowsInstallerLog(logPath, { statFile = lstat, openFile = open, timeoutMs = 2000 } = {}) {
  const report = { availability: "unavailable", sizeBytes: null, sampledBytes: null, truncated: null,
    changedDuringRead: null, lastRecognizedEvent: "unknown", errorObserved: null };
  const timeoutReport = () => ({ ...report, availability: "timeout" });
  const budget = Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, 2000) : 2000;
  let file, closing, expired = false, timer;
  const closeFile = () => {
    if (!file) return Promise.resolve();
    if (!closing) {
      try { closing = Promise.resolve(file.close()).catch(() => {}); }
      catch { closing = Promise.resolve(); }
    }
    return closing;
  };
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => {
      expired = true;
      void closeFile();
      resolve(timeoutReport());
    }, budget);
  });
  const read = async () => {
    try {
      const before = await statFile(logPath);
      if (expired) return timeoutReport();
      if (!before.isFile() || before.isSymbolicLink()) return { ...report, availability: "unsafe" };
      if (!Number.isSafeInteger(before.size) || before.size < 0 || before.size > maxFileBytes) {
        return { ...report, availability: "oversized" };
      }
      file = await openFile(logPath, "r");
      if (expired) return timeoutReport();
      const opened = await file.stat();
      if (expired) return timeoutReport();
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
        return { ...report, availability: "changed" };
      }
      const header = Buffer.alloc(2);
      const { bytesRead: headerBytes } = await file.read(header, 0, 2, 0);
      if (expired) return timeoutReport();
      if (headerBytes === 2 && header[0] === 0xfe && header[1] === 0xff) {
        return { ...report, availability: "unsupported-encoding", sizeBytes: before.size };
      }
      const encoding = headerBytes === 2 && header[0] === 0xff && header[1] === 0xfe ? "utf16le" : "utf8";
      let offset = Math.max(0, before.size - maxLogSampleBytes);
      if (encoding === "utf16le" && offset % 2) offset++;
      const sample = Buffer.alloc(before.size - offset);
      const { bytesRead } = await file.read(sample, 0, sample.length, offset);
      if (expired) return timeoutReport();
      const after = await file.stat();
      if (expired) return timeoutReport();
      const changedDuringRead = after.size !== before.size || after.mtimeMs !== before.mtimeMs || opened.size !== before.size;
      return { ...report, availability: before.size === 0 ? "empty" : "readable", sizeBytes: before.size,
        sampledBytes: bytesRead, truncated: offset > 0, changedDuringRead,
        ...classifyWindowsInstallerLog(sample.subarray(0, bytesRead), { partialStart: offset > 0, encoding }) };
    } catch (error) {
      return { ...report, availability: error?.code === "ENOENT" ? "missing" : "unavailable" };
    } finally {
      // The deadline also covers close. An open/read which finishes later still
      // reaches this cleanup, without starting more IO or changing the report.
      await closeFile();
    }
  };
  try { return await Promise.race([read(), deadline]); }
  finally { clearTimeout(timer); }
}
