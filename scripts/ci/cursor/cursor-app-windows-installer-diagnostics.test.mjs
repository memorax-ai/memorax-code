import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { classifyWindowsInstallerLog, observeWindowsInstaller, readWindowsInstallerLog,
  windowsInstallerPhaseMarkers as markers } from "./cursor-app-windows-installer-diagnostics.mjs";

function heldExecution() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  let resolve, reject;
  const pending = new Promise((yes, no) => { resolve = yes; reject = no; });
  pending.child = child;
  return { child, pending, resolve, reject };
}

test("installer observations keep the original execution options and distinguish exit, close and settlement", async () => {
  const held = heldExecution(), options = { timeout: 300000, maxBuffer: 65536, killSignal: "SIGKILL" }, args = ["encoded"];
  let time = 10, calls = 0;
  const pending = observeWindowsInstaller((file, actualArgs, actualOptions) => {
    calls++; assert.equal(file, "powershell.exe"); assert.equal(actualArgs, args); assert.equal(actualOptions, options);
    return held.pending;
  }, "powershell.exe", args, options, { now: () => time });
  time = 12; held.child.emit("spawn");
  time = 20; held.child.stderr.emit("data", markers.powershellStart.slice(0, 12));
  held.child.stderr.emit("data", Buffer.from(markers.powershellStart.slice(12) + "\r"));
  held.child.stderr.emit("data", "\n");
  time = 21; held.child.stderr.emit("data", markers.launchStart + "\n");
  time = 40; held.child.stderr.emit("data", markers.treeWaitComplete + "\n");
  time = 42; held.child.stderr.emit("data", markers.jsonComplete + "\n");
  held.child.stdout.emit("data", "ok");
  time = 44; held.child.emit("exit", 0, null);
  time = 60; held.child.emit("close", 0, null);
  time = 61; held.resolve({ stdout: "ok", stderr: Object.values(markers).join("\n") + "\n" });
  const result = await pending, d = result.diagnostics;
  assert.equal(calls, 1); assert.equal(result.succeeded, true); assert.equal(d.stdoutBytes, 2);
  assert.deepEqual(d.powershell, { spawnObserved: true, exitObserved: true, closeObserved: true, promiseSettled: true,
    spawnElapsedMs: 2, exitElapsedMs: 34, closeElapsedMs: 50, settledElapsedMs: 51, exitCode: 0, signal: "none" });
  assert.deepEqual(d.phaseElapsedMs, { powershellStart: 10, launchStart: 11, treeWaitComplete: 30, jsonComplete: 32 });
  assert.equal(d.rootExitObserved, null); assert.equal(d.rootExitElapsedMs, null);
  assert.equal(d.stderrBytes, Buffer.byteLength(Object.values(markers).join("\n") + "\r\n"));
});

test("rejected installers retain streamed phases and detach before late close or output", async () => {
  const held = heldExecution(); let time = 0;
  const pending = observeWindowsInstaller(() => held.pending, "", [], {}, { now: () => time });
  held.child.emit("spawn");
  time = 3; held.child.stderr.emit("data", markers.powershellStart + "\n" + markers.launchStart + "\n");
  time = 300000; held.child.emit("exit", null, "SIGKILL");
  const error = Object.assign(new Error("private-canary"), { killed: true, signal: "SIGKILL", stdout: "", stderr: "" });
  held.reject(error);
  const result = await pending, saved = JSON.stringify(result.diagnostics);
  assert.equal(result.error, error); assert.equal(result.succeeded, false);
  assert.equal(result.diagnostics.powershell.closeObserved, false);
  assert.equal(result.diagnostics.powershell.signal, "SIGKILL");
  assert.equal(result.diagnostics.phases.treeWaitComplete, false);
  time = 300001;
  held.child.emit("close", 0, null);
  held.child.stderr.emit("data", markers.treeWaitComplete + "\nprivate-canary\n");
  assert.equal(JSON.stringify(result.diagnostics), saved);
  for (const event of ["spawn", "exit", "close"]) assert.equal(held.child.listenerCount(event), 0);
  for (const stream of [held.child.stdout, held.child.stderr]) assert.equal(stream.listenerCount("data"), 0);
  assert.equal(saved.includes("private-canary"), false);
});

test("installer observations distinguish unavailable output from observed zero and synchronous throws", async () => {
  const unknown = await observeWindowsInstaller(() => Promise.resolve({}), "", [], {});
  assert.equal(unknown.diagnostics.stdoutBytes, null);
  assert.equal(unknown.diagnostics.stderrBytes, null);
  assert.equal(unknown.diagnostics.powershell.spawnObserved, null);
  assert.equal(unknown.diagnostics.powershell.promiseSettled, true);
  const empty = await observeWindowsInstaller(() => Promise.resolve({ stdout: "", stderr: "" }), "", [], {});
  assert.equal(empty.diagnostics.stdoutBytes, 0); assert.equal(empty.diagnostics.stderrBytes, 0);
  const sync = await observeWindowsInstaller(() => { throw Object.assign(new Error("private-canary"), { stdout: "" }); }, "", [], {});
  assert.equal(sync.succeeded, false); assert.equal(sync.diagnostics.stdoutBytes, 0); assert.equal(sync.diagnostics.stderrBytes, null);
  assert.equal(sync.diagnostics.powershell.promiseSettled, false);
  assert.equal(sync.diagnostics.powershell.settledElapsedMs, null);
  assert.equal(JSON.stringify(sync.diagnostics).includes("private-canary"), false);
});

test("installer markers require complete exact lines and keep first observation times within bounds", async () => {
  const held = heldExecution(); let time = 0;
  const pending = observeWindowsInstaller(() => held.pending, "", [], {}, { now: () => time });
  held.child.stderr.emit("data", "private-canary ".repeat(10000) + markers.powershellStart + "\n");
  held.child.stderr.emit("data", markers.launchStart + " private-canary\n");
  held.child.stderr.emit("data", markers.treeWaitComplete + "\r\r\n");
  held.child.stderr.emit("data", markers.jsonComplete);
  time = 20; held.child.stderr.emit("data", "\n");
  time = 30; held.child.stderr.emit("data", markers.jsonComplete + "\n");
  time = 900000; held.resolve({ stdout: "", stderr: "private-canary" });
  const { diagnostics: d } = await pending;
  assert.deepEqual(d.phases, { powershellStart: false, launchStart: false, treeWaitComplete: false, jsonComplete: true });
  assert.deepEqual(d.phaseElapsedMs, { powershellStart: null, launchStart: null, treeWaitComplete: null, jsonComplete: 20 });
  assert.equal(d.elapsedMs, 600000); assert.equal(d.stderrBytes, 65536);
  assert.equal(JSON.stringify(d).includes("private-canary"), false);
});

test("settled-only output records phase availability without inventing earlier timestamps", async () => {
  let time = 0;
  const result = await observeWindowsInstaller(async () => {
    time = 50; return { stderr: markers.powershellStart + "\n" + markers.launchStart, stdout: "" };
  }, "", [], {}, { now: () => time });
  assert.equal(result.diagnostics.phaseElapsedMs.powershellStart, 50);
  assert.equal(result.diagnostics.phaseElapsedMs.launchStart, null);
  assert.equal(result.diagnostics.powershell.exitObserved, null);
});

test("installer log classification accepts known whole lines and never returns free text", () => {
  const text = "2026-10-20 14:05:00.000   Starting the installation process.\r\n"
    + "2026-10-20 14:05:01.000   -- Run entry --\r\n"
    + "2026-10-20 14:05:02.000   Error: private-canary C:\\private\\token\r\n"
    + "2026-10-20 14:05:03.000   Installation process failed.\r\n";
  assert.deepEqual(classifyWindowsInstallerLog(Buffer.from(text)), { lastRecognizedEvent: "installation-failed", errorObserved: true });
  assert.deepEqual(classifyWindowsInstallerLog(Buffer.from("private-canary Installation process succeeded.\n")), {
    lastRecognizedEvent: "unknown", errorObserved: false });
  assert.deepEqual(classifyWindowsInstallerLog(Buffer.from("Installation process succeeded.\n"), { partialStart: true }), {
    lastRecognizedEvent: "unknown", errorObserved: false });
  assert.deepEqual(classifyWindowsInstallerLog(Buffer.alloc(65537)), { lastRecognizedEvent: "unknown", errorObserved: null });
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "cursor-installer-log-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return join(root, "installer.log");
}

test("installer log reads are bounded, support UTF-16LE and report missing, empty and unknown data", async (t) => {
  const path = await fixture(t);
  const missing = await readWindowsInstallerLog(path);
  assert.equal(missing.availability, "missing"); assert.equal(missing.sampledBytes, null); assert.equal(missing.errorObserved, null);
  await writeFile(path, "");
  const empty = await readWindowsInstallerLog(path);
  assert.equal(empty.availability, "empty"); assert.equal(empty.sampledBytes, 0); assert.equal(empty.errorObserved, false);
  await writeFile(path, Buffer.from("\uFEFFStarting the installation process.\r\nInstallation process succeeded.\r\n", "utf16le"));
  const unicode = await readWindowsInstallerLog(path);
  assert.equal(unicode.availability, "readable"); assert.equal(unicode.lastRecognizedEvent, "installation-succeeded");
  assert.equal(unicode.changedDuringRead, false); assert.equal(unicode.truncated, false);
  await writeFile(path, "private-canary ".repeat(10000) + "\n-- Run entry --\n");
  const large = await readWindowsInstallerLog(path);
  assert.equal(large.truncated, true); assert.equal(large.sampledBytes, 65536); assert.equal(large.lastRecognizedEvent, "run-entry");
  assert.equal(JSON.stringify(large).includes("private-canary"), false);
  await writeFile(path, "private-canary");
  const unknown = await readWindowsInstallerLog(path);
  assert.equal(unknown.availability, "readable"); assert.equal(unknown.lastRecognizedEvent, "unknown");
  await writeFile(path, Buffer.from([0xfe, 0xff, 0, 0]));
  assert.equal((await readWindowsInstallerLog(path)).availability, "unsupported-encoding");
});

test("installer log diagnostics reject unsafe files and replacements, and tolerate IO failures", async () => {
  const stat = { isFile: () => true, isSymbolicLink: () => false, dev: 1, ino: 1, size: 0, mtimeMs: 0 };
  let opens = 0, closed = false;
  for (const [changes, availability] of [
    [{ isSymbolicLink: () => true }, "unsafe"], [{ isFile: () => false }, "unsafe"], [{ size: 600000001 }, "oversized"],
  ]) {
    const result = await readWindowsInstallerLog("unused", { statFile: async () => ({ ...stat, ...changes }),
      openFile: async () => { opens++; assert.fail("unsafe log must not be opened"); } });
    assert.equal(result.availability, availability);
  }
  assert.equal(opens, 0);
  const replaced = await readWindowsInstallerLog("unused", { statFile: async () => stat, openFile: async () => ({
    stat: async () => ({ ...stat, ino: 2 }), close: async () => { closed = true; },
  }) });
  assert.equal(replaced.availability, "changed"); assert.equal(closed, true);
  const failed = await readWindowsInstallerLog("unused", { statFile: async () => { throw new Error("private-canary"); } });
  assert.equal(failed.availability, "unavailable"); assert.equal(JSON.stringify(failed).includes("private-canary"), false);
});

test("installer logs which grow while sampled remain diagnostic observations", async () => {
  const stat = { isFile: () => true, isSymbolicLink: () => false, dev: 1, ino: 1, size: 0, mtimeMs: 0 };
  let stats = 0, closed = false;
  const result = await readWindowsInstallerLog("unused", { statFile: async () => stat, openFile: async () => ({
    stat: async () => ({ ...stat, size: stats++ ? 100 : 0 }),
    read: async () => ({ bytesRead: 0 }), close: async () => { closed = true; },
  }) });
  assert.equal(result.changedDuringRead, true); assert.equal(result.sampledBytes, 0);
  assert.equal(result.lastRecognizedEvent, "unknown"); assert.equal(closed, true);
});

test("installer log deadline covers a stat or close which never settles", async () => {
  const never = () => new Promise(() => {});
  const stalledStat = await readWindowsInstallerLog("unused", { timeoutMs: 10, statFile: never });
  assert.equal(stalledStat.availability, "timeout");
  assert.equal(stalledStat.sampledBytes, null); assert.equal(stalledStat.errorObserved, null);
  const stat = { isFile: () => true, isSymbolicLink: () => false, dev: 1, ino: 1, size: 0, mtimeMs: 0 };
  let closes = 0;
  const stalledClose = await readWindowsInstallerLog("unused", { timeoutMs: 10, statFile: async () => stat,
    openFile: async () => ({ stat: async () => stat, read: async () => ({ bytesRead: 0 }),
      close: () => { closes++; return never(); } }) });
  assert.equal(stalledClose.availability, "timeout"); assert.equal(closes, 1);
});

test("a log handle opened after the deadline is closed without reading or changing the timeout report", async () => {
  const stat = { isFile: () => true, isSymbolicLink: () => false, dev: 1, ino: 1, size: 0, mtimeMs: 0 };
  let resolveOpen, closes = 0;
  const pending = readWindowsInstallerLog("unused", { timeoutMs: 10, statFile: async () => stat,
    openFile: () => new Promise((resolve) => { resolveOpen = resolve; }) });
  const result = await pending, saved = JSON.stringify(result);
  assert.equal(result.availability, "timeout");
  resolveOpen({ stat: () => assert.fail("late open must not start another operation"),
    close: async () => { closes++; } });
  await new Promise(setImmediate);
  assert.equal(closes, 1); assert.equal(JSON.stringify(result), saved);
});

test("a late log read stops after timeout, closes once and cannot publish its content", async () => {
  const stat = { isFile: () => true, isSymbolicLink: () => false, dev: 1, ino: 1, size: 100, mtimeMs: 0 };
  let resolveRead, reads = 0, stats = 0, closes = 0;
  const pending = readWindowsInstallerLog("unused", { timeoutMs: 10, statFile: async () => stat,
    openFile: async () => ({ stat: async () => { stats++; return stat; },
      read: () => { reads++; return new Promise((resolve) => { resolveRead = resolve; }); },
      close: async () => { closes++; } }) });
  const result = await pending, saved = JSON.stringify(result);
  assert.equal(result.availability, "timeout"); assert.equal(closes, 1);
  resolveRead({ bytesRead: 0, private: "private-canary" });
  await new Promise(setImmediate);
  assert.equal(reads, 1); assert.equal(stats, 1); assert.equal(closes, 1);
  assert.equal(JSON.stringify(result), saved); assert.equal(saved.includes("private-canary"), false);
});


test("PowerShell 5.1 CLIXML progress can surround streamed installer markers without becoming evidence", async () => {
  const held = heldExecution(); let time = 0;
  const pending = observeWindowsInstaller(() => held.pending, "powershell.exe", [], {}, { now: () => time });
  const stderr = [markers.powershellStart, markers.launchStart, "#< CLIXML", markers.treeWaitComplete,
    markers.jsonComplete, '<Objs><Obj S="progress"><AV>Preparing modules for first use.</AV>'
      + '<S>private-canary C:\\private\\token ' + markers.launchStart + '</S></Obj></Objs>', ""].join("\r\n");
  for (let offset = 0; offset < stderr.length; offset += 7) {
    time += 1; held.child.stderr.emit("data", Buffer.from(stderr.slice(offset, offset + 7)));
  }
  held.resolve({ stdout: '{"status":"exited","exitCode":0,"nativeErrorCode":null}', stderr });
  const { diagnostics } = await pending;
  assert.deepEqual(diagnostics.phases, Object.fromEntries(Object.keys(markers).map(name => [name, true])));
  const times = Object.values(diagnostics.phaseElapsedMs);
  assert.ok(times.every(Number.isInteger));
  assert.ok(times.every((at, index) => index === 0 || at > times[index - 1]));
  assert.equal(diagnostics.stderrBytes, Buffer.byteLength(stderr));
  assert.equal(JSON.stringify(diagnostics).includes("CLIXML"), false);
  assert.equal(JSON.stringify(diagnostics).includes("private-canary"), false);
  assert.equal(JSON.stringify(diagnostics).includes("Preparing modules"), false);
});
