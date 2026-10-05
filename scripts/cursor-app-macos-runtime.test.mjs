import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { auditMacosListeners, auditMacosProcesses, captureMacosDescendants, createDevToolsEndpointReader, hasOwnedMacosProcesses, macosRuntimePaths,
  reserveFreePort, sandboxInvocation, startMacosSandboxDiagnostics } from "./cursor-app-macos-runtime.mjs";

const root = "/private/tmp/cursor run";
const appBundle = `${root}/Cursor.app`;
const appPath = `${appBundle}/Contents/MacOS/Cursor`;
const packageRoot = `${root}/candidate/node_modules/@memorax/memorax-code`;
const stateHome = `${root}/state`;
const marker = `${root}/workspace/cancelled-shell-marker`;
const nodePath = "/opt/node 24/bin/node";
const owners = { appBundle, packageRoot, stateHome, marker, selfPid: 42 };
const port = 43123;
const endpoint = `ws://127.0.0.1:${port}/devtools/browser/12345678-1234-1234-1234-123456789abc`;
const diagnostic = (value) => `DevTools listening on ${value}\n`;

test("macOS paths use the App bundle and an explicit isolated Shell environment", () => {
  const paths = macosRuntimePaths({ root, appPath, packageRoot, nodePath });
  assert.deepEqual(paths, { appBundle, resourcesPackage: `${appBundle}/Contents/Resources/app/package.json`,
    home: `${root}/home`, tmp: `${root}/tmp`, env: {
      HOME: `${root}/home`, USERPROFILE: `${root}/home`, CFFIXED_USER_HOME: `${root}/home`, ZDOTDIR: `${root}/home`,
      SHELL: "/bin/zsh", TMPDIR: `${root}/tmp`, TMP: `${root}/tmp`, TEMP: `${root}/tmp`,
      PATH: `${root}/candidate/node_modules/.bin:/opt/node 24/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    } });
  assert.equal(paths.env.NODE_OPTIONS, undefined);
  assert.equal(paths.env.SSH_AUTH_SOCK, undefined);
  assert.equal(paths.env.VSCODE_PORTABLE, undefined);
});

test("runtime paths reject relative, broad, malformed App and ambiguous PATH inputs", () => {
  for (const change of [{ root: "/" }, { root: "relative" }, { appPath: "/Applications/Cursor" },
    { appPath: `${appBundle}/Contents/MacOS/other` }, { nodePath: "/private:bin/node" },
    { packageRoot: "relative" }, { root: "/tmp/private\ncanary" }]) {
    assert.throws(() => macosRuntimePaths({ root, appPath, packageRoot, nodePath, ...change }),
      { code: "CURSOR_APP_MACOS_RUNTIME_ARGUMENTS" });
  }
});

test("sandbox invocation preserves argument boundaries for both App and Node without a shell", () => {
  const profile = "(version 1)\n(allow default)\n(deny network*)\n";
  for (const executable of [appPath, nodePath]) {
    const args = ["--user-data-dir", `${root}/app data`, "literal 'quoted'; $HOME"];
    assert.deepEqual(sandboxInvocation(executable, args, profile), {
      file: "/usr/bin/sandbox-exec", args: ["-p", profile, executable, ...args],
    });
  }
  for (const args of [["node", [], profile], [nodePath, ["nul\0"], profile], [nodePath, [], ""],
    [nodePath, [], "x".repeat(65537)], [nodePath, null, profile]]) {
    assert.throws(() => sandboxInvocation(...args), { code: "CURSOR_APP_MACOS_RUNTIME_ARGUMENTS" });
  }
});

test("read-only process ownership recognizes only exact run paths and excludes the observer", () => {
  const cases = [
    [`50 ${appPath}`, true],
    [`50 ${appBundle}/Contents/Frameworks/Cursor Helper.app/Contents/MacOS/Cursor Helper`, true],
    [`50 /opt/node ${packageRoot}/lib/backend/server.mjs`, true],
    [`50 /opt/node --home=${stateHome}`, true],
    [`50 /opt/node '${marker}'`, true],
    [`50 /bin/zsh -c '/opt/node -e synthetic "${marker}"'`, true],
    [`42 ${appPath} ${packageRoot} ${stateHome}`, false],
    [`50 /other${appPath}`, false],
    [`50 ${appBundle}-other/Contents/MacOS/Cursor`, false],
    [`50 /opt/node ${stateHome}-other/config`, false],
    [`50 /opt/node ${marker}-other`, false],
    [`50 /opt/node /unrelated/workspace/cancelled-shell-marker`, false],
    ["0 kernel_task\n  51 /usr/bin/true", false],
  ];
  for (const [output, expected] of cases) assert.equal(hasOwnedMacosProcesses(output, owners), expected, output);
  assert.equal(hasOwnedMacosProcesses(`50 /opt/node ${packageRoot}/lib/backend/server.mjs`, { ...owners, includeBackend: false }), false);
  assert.equal(hasOwnedMacosProcesses(`50 ${appPath}`, { ...owners, includeBackend: false }), true);
  assert.equal(hasOwnedMacosProcesses(`50 /opt/node ${marker}`, { ...owners, includeBackend: false }), true);
});

test("process audit rejects incomplete ps output instead of claiming cleanup succeeded", () => {
  for (const output of ["", "   ", "private-unparseable-output", "50 /usr/bin/true\ntruncated", "9".repeat(30) + " /bin/true"]) {
    assert.throws(() => hasOwnedMacosProcesses(output, owners), { code: "CURSOR_APP_MACOS_PROCESS_AUDIT" });
  }
});

test("macOS process inspection executes bounded ps with a clean environment and no signals", async () => {
  let calls = 0;
  const remains = await auditMacosProcesses(owners, async (file, args, options) => {
    calls++;
    assert.equal(file, "/bin/ps");
    assert.deepEqual(args, ["-axww", "-o", "pid=,command="]);
    assert.deepEqual(options, { encoding: "utf8", timeout: 5000, maxBuffer: 4 * 1024 * 1024,
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" } });
    return { stdout: `42 ${appPath}\n50 /opt/node ${marker}\n` };
  });
  assert.equal(remains, true);
  assert.equal(calls, 1);
  await assert.rejects(auditMacosProcesses(owners, async () => { throw new Error("private-process-canary"); }),
    { message: "CURSOR_APP_MACOS_PROCESS_AUDIT", code: "CURSOR_APP_MACOS_PROCESS_AUDIT" });
});

const logStart = Date.parse("2026-10-05T12:34:00.000Z");
const logOptions = { appBundle, home: `${root}/home`, startedAt: logStart, endedAt: logStart + 30000, platform: "darwin",
  environment: { GITHUB_ACTIONS: "true", RUNNER_OS: "macOS", PRIVATE_TOKEN: "private-log-canary" } };
const logRecord = (eventMessage, changes = {}) => ({ eventType: "logEvent", timestamp: "2026-10-05 12:34:15.123456+0000",
  subsystem: "org.chromium.sandbox", category: "chromium_logging", processImagePath: `${appBundle}/Contents/MacOS/Cursor`,
  processID: 123, eventMessage, ...changes });
const logLines = (...rows) => rows.map(JSON.stringify).join("\n") + "\n";
const logPredicate = `subsystem == "org.chromium.sandbox" AND category == "chromium_logging" AND processImagePath BEGINSWITH ${JSON.stringify(appBundle + "/")}`;
const logHeader = `Filtering the log data using "(${logPredicate}) AND type == 1024"\n`;
function assertPrivateLogDropped(result) {
  for (const text of [root, appBundle, "private-log-canary", "123", "eventMessage", "processID", "timestamp"])
    assert.equal(JSON.stringify(result).includes(text), false);
}
function logChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.signals = [];
  child.kill = (signal) => { child.signals.push(signal); queueMicrotask(() => child.emit("close", null, signal)); return true; };
  return child;
}
async function collectLog(options, stdout = "", stderr = "") {
  const monitor = await startMacosSandboxDiagnostics(options, () => {
    const child = logChild();
    queueMicrotask(() => { child.emit("spawn"); child.stdout.write(stdout); child.stderr.write(stderr); });
    return child;
  });
  const result = await monitor.stop(options.endedAt);
  assert.equal(result.closed, true);
  return result.diagnostics;
}

test("sandbox stream starts before App launch without a subscription acknowledgement claim", async () => {
  let child;
  const monitor = await startMacosSandboxDiagnostics({ ...logOptions, home: `${root}/home` }, (file, args, options) => {
    assert.equal(file, "/usr/bin/log");
    assert.deepEqual(args, ["stream", "--style", "ndjson", "--type", "log", "--timeout", "120", "--predicate",
      `subsystem == "org.chromium.sandbox" AND category == "chromium_logging" AND processImagePath BEGINSWITH ${JSON.stringify(appBundle + "/")}`]);
    assert.deepEqual(options, { stdio: ["ignore", "pipe", "pipe"], env: {
      HOME: `${root}/home`, CFFIXED_USER_HOME: `${root}/home`, PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" } });
    child = logChild();
    queueMicrotask(() => child.emit("spawn"));
    return child;
  });
  const result = await monitor.stop(logStart + 30000);
  assert.equal(result.closed, true);
  assert.equal(result.diagnostics.status, "empty");
  assert.deepEqual(child.signals, ["SIGINT"]);
  assert.equal(await monitor.stop(logStart + 30001), result);
  assert.equal(Object.hasOwn(result, "ready"), false);
  assertPrivateLogDropped(result);
});

test("macOS sandbox stream projects individual records without retaining raw messages", async () => {
  const result = await collectLog(logOptions, logLines(logRecord("SeatbeltExec: buffer length read failed: private-log-canary"),
    logRecord("SandboxSerializer: Failed to apply compiled policy: Operation not permitted"), { finished: 1 }));
  assert.equal(result.status, "collected"); assert.equal(result.reason, "none");
  assert.equal(result.markers.sandboxPipeLengthReadFailed, true);
  assert.equal(result.markers.sandboxCompiledPolicyFailed, true);
  assert.equal(result.markers.sandboxPolicyPermissionDenied, true);
  assert.equal(result.markers.sandboxPipeBodyReadFailed, false);
  assertPrivateLogDropped(result);
});

test("sandbox stream accepts only its exact CLI header at the first physical line", async () => {
  for (const records of [logLines({ count: 0, finished: 1 }), logLines(logRecord("SeatbeltExec: buffer read failed"), { count: 1, finished: 1 })]) {
    const result = await collectLog(logOptions, logHeader + records);
    assert.equal(result.status, records.includes("logEvent") ? "collected" : "empty");
    assert.equal(result.reason, "none"); assertPrivateLogDropped(result);
  }
  for (const stdout of [
    logHeader.replace(appBundle, `${appBundle}-other`), logHeader.replace("type == 1024", "type == 512"),
    logHeader.replace("(subsystem", "subsystem"), ` ${logHeader}`, `\n${logHeader}`,
    logHeader + logHeader, logLines(logRecord("SeatbeltExec: buffer read failed")) + logHeader,
    "Filtering the log data using private-log-canary\n",
  ]) {
    const result = await collectLog(logOptions, stdout + logLines({ count: 0, finished: 1 }));
    assert.equal(result.status, "unavailable"); assert.equal(result.reason, "parse-invalid");
    assert.ok(Object.values(result.markers).every((value) => value === false)); assertPrivateLogDropped(result);
  }
});

test("sandbox logs do not manufacture same-line markers across separate records", async () => {
  const result = await collectLog(logOptions, logLines(
    logRecord("SandboxSerializer: Failed to apply compiled policy:"), logRecord("Operation not permitted")));
  assert.equal(result.status, "collected"); assert.equal(result.markers.sandboxCompiledPolicyFailed, true);
  assert.equal(result.markers.permissionDenied, true); assert.equal(result.markers.sandboxPolicyPermissionDenied, false);
});

test("sandbox stream markers use the precise launch interval and normalize timestamp offsets", async () => {
  const options = { ...logOptions, startedAt: logStart + 800, endedAt: logStart + 30200 };
  for (const timestamp of ["2026-10-05 12:34:00.100000+0000", "2026-10-05 12:34:00.799999+0000",
    "2026-10-05 12:34:30.200001+0000", "2026-10-05 12:34:30.900000+0000"]) {
    const result = await collectLog(options, logLines(logRecord("SeatbeltExec: buffer read failed", { timestamp })));
    assert.equal(result.status, "empty"); assert.equal(result.reason, "none");
    assert.ok(Object.values(result.markers).every((value) => value === false));
  }
  for (const timestamp of ["2026-10-05 12:34:00.800000+0000", "2026-10-05 12:34:30.200000+0000",
    "2026-10-05 20:34:00.800000+0800", "2026-10-05 05:34:30.200000-0700", "2026-10-05 18:19:15.123456+0545"]) {
    const result = await collectLog(options, logLines(
      logRecord("SeatbeltExec: buffer length read failed", { timestamp: "2026-10-05 12:34:00.100000+0000" }),
      logRecord("SeatbeltExec: buffer read failed", { timestamp })));
    assert.equal(result.status, "collected"); assert.equal(result.reason, "none");
    assert.equal(result.markers.sandboxPipeBodyReadFailed, true);
    assert.equal(result.markers.sandboxPipeLengthReadFailed, false);
  }
});

test("sandbox log collection distinguishes empty output from invalid records and only ignores a final footer", async () => {
  for (const stdout of ["", "\n", logLines({ finished: 1, statistics: "private-log-canary" })]) {
    const result = await collectLog(logOptions, stdout);
    assert.equal(result.status, "empty"); assert.equal(result.reason, "none");
    assert.ok(Object.values(result.markers).every((value) => value === false)); assertPrivateLogDropped(result);
  }
  for (const stdout of ["private-log-canary", "[]\n", "null\n", logLines({}),
    logLines({ finished: 1 }, logRecord("private-log-canary")), logLines({ finished: 1 }, { finished: 1 }),
    logLines({ finished: 1, eventMessage: "private-log-canary" }),
    logLines(logRecord(42)), logLines(logRecord("private-log-canary", { eventType: "activityCreateEvent" })),
    logLines(logRecord("private-log-canary", { timestamp: "not-a-time" })),
    logLines(logRecord("private-log-canary", { processImagePath: null })), Buffer.from([0xff])]) {
    const result = await collectLog(logOptions, stdout);
    assert.equal(result.status, "unavailable"); assert.equal(result.reason, "parse-invalid");
    assert.ok(Object.values(result.markers).every((value) => value === false)); assertPrivateLogDropped(result);
  }
});

test("sandbox log scope mismatch discards partial markers and never publishes adjacent records", async () => {
  for (const change of [{ subsystem: "private-log-canary" }, { category: "other" },
    { processImagePath: `${appBundle}-other/Contents/MacOS/Cursor` },
    { processImagePath: `${appBundle}/../Other.app/Contents/MacOS/Cursor` },
    { processImagePath: `${appBundle}/private\ncanary` },
    { timestamp: "2026-99-99 12:34:15.123456+0000" }, { timestamp: "2026-02-31 12:34:15.123456+0000" },
    { timestamp: "2026-10-05 12:34:15.123456+0060" }]) {
    const result = await collectLog(logOptions, logLines(logRecord("SeatbeltExec: buffer read failed"), logRecord("private-log-canary", change)));
    assert.equal(result.status, "unavailable"); assert.equal(result.reason, "scope-mismatch");
    assert.ok(Object.values(result.markers).every((value) => value === false)); assertPrivateLogDropped(result);
  }
});

test("sandbox stream refuses non-CI and broad inputs before execution and rejects invalid stop windows", async () => {
  for (const change of [{ platform: "linux" }, { environment: {} }, { environment: { GITHUB_ACTIONS: "true", RUNNER_OS: "Linux" } },
    { appBundle: "/" }, { appBundle: "relative.app" }, { appBundle: "/private/tmp/Other" },
    { appBundle: "/private/tmp/a/../Cursor.app" }, { appBundle: "/private/tmp/private\ncanary.app" }, { home: "/" },
    { home: "/owned/../home" }, { startedAt: undefined }, { startedAt: "0" }, { startedAt: 0 }, { startedAt: logStart + 1.5 }]) {
    let called = false;
    const monitor = await startMacosSandboxDiagnostics({ ...logOptions, ...change }, () => { called = true; });
    const { diagnostics: result, closed } = await monitor.stop(logOptions.endedAt);
    assert.equal(closed, true);
    assert.equal(called, false); assert.equal(result.status, "unavailable"); assert.equal(result.reason, "scope-mismatch");
    assertPrivateLogDropped(result);
  }
  for (const endedAt of [undefined, logStart - 1, logStart + 120001, logStart + 1.5]) {
    const result = await collectLog({ ...logOptions, endedAt });
    assert.equal(result.status, "unavailable"); assert.equal(result.reason, "scope-mismatch");
  }
});

test("sandbox stream execution failures and combined output limits remain fixed diagnostic outcomes", async () => {
  const monitor = await startMacosSandboxDiagnostics(logOptions, () => { throw new Error("private-log-canary"); });
  const failed = await monitor.stop(logOptions.endedAt);
  assert.equal(failed.closed, true); assert.equal(failed.diagnostics.reason, "execute-failed"); assertPrivateLogDropped(failed);
  for (const [stdout, stderr, status, reason] of [
    ["x".repeat(256 * 1024 + 1), "", "overflow", "overflow"],
    ["x".repeat(256 * 1024), "x", "overflow", "overflow"],
    [logLines(logRecord("SeatbeltExec: buffer read failed")), "private-log-canary", "unavailable", "execute-failed"],
  ]) {
    const result = await collectLog(logOptions, stdout, stderr);
    assert.equal(result.status, status); assert.equal(result.reason, reason);
    assert.ok(Object.values(result.markers).every((value) => value === false)); assertPrivateLogDropped(result);
  }
});

test("sandbox stream handles chunk boundaries and stops an actual owned synthetic child", { timeout: 10000 }, async () => {
  let child, ready;
  const outputReady = new Promise((resolve) => { ready = resolve; });
  const payload = logLines(logRecord("SeatbeltExec: buffer read failed: private-log-canary \u8bb0"));
  const monitor = await startMacosSandboxDiagnostics(logOptions, (_file, _args, options) => {
    child = spawn(process.execPath, ["-e", `process.on('SIGINT', () => process.exit(0));
      const bytes = Buffer.from(${JSON.stringify(payload)});
      process.stdout.write(bytes.subarray(0, bytes.length - 4));
      process.stdout.write(bytes.subarray(bytes.length - 4)); setInterval(() => {}, 1000);`], { ...options,
      env: { ...options.env, ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {}) } });
    let received = 0;
    child.stdout.on("data", (chunk) => { received += chunk.length; if (received === Buffer.byteLength(payload)) ready(); });
    return child;
  });
  try {
    await outputReady;
    const result = await monitor.stop(logOptions.endedAt);
    assert.equal(result.closed, true); assert.equal(result.diagnostics.status, "collected");
    assert.equal(result.diagnostics.markers.sandboxPipeBodyReadFailed, true); assertPrivateLogDropped(result);
  } finally { await monitor.stop(logOptions.endedAt); }
});

test("sandbox stream errors and unrequested exits never claim successful collection", async () => {
  for (const kind of ["error", "close"]) {
    const monitor = await startMacosSandboxDiagnostics(logOptions, () => {
      const child = logChild();
      queueMicrotask(() => {
        if (kind === "error") child.emit("error", new Error("private-log-canary"));
        else child.emit("spawn");
        child.emit("close", kind === "error" ? -1 : 0, null);
      });
      return child;
    });
    const result = await monitor.stop(logOptions.endedAt);
    assert.equal(result.closed, true); assert.equal(result.diagnostics.reason, "execute-failed"); assertPrivateLogDropped(result);
  }
});

test("sandbox stream escalates through its owned handle and reports an unclosed child", { timeout: 10000 }, async () => {
  for (const closes of [true, false]) {
    let child;
    const monitor = await startMacosSandboxDiagnostics(logOptions, () => {
      child = logChild();
      child.kill = (signal) => {
        child.signals.push(signal);
        if (signal === "SIGKILL" && closes) queueMicrotask(() => child.emit("close", null, signal));
        return true;
      };
      queueMicrotask(() => child.emit("spawn"));
      return child;
    });
    const result = await monitor.stop(logOptions.endedAt);
    assert.deepEqual(child.signals, ["SIGINT", "SIGKILL"]);
    assert.equal(result.closed, closes); assert.equal(result.diagnostics.reason, "timeout"); assertPrivateLogDropped(result);
  }
});

test("sandbox stream enforces its lifetime even when its caller has not stopped it", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let child;
  const monitor = await startMacosSandboxDiagnostics(logOptions, () => {
    child = logChild(); queueMicrotask(() => child.emit("spawn")); return child;
  });
  t.mock.timers.tick(120000);
  await Promise.resolve();
  const result = await monitor.stop(logOptions.endedAt);
  assert.equal(result.closed, true); assert.equal(result.diagnostics.reason, "timeout");
  assert.deepEqual(child.signals, ["SIGINT"]);
});

test("descendant capture includes the live App root and transitive children from one bounded snapshot", async () => {
  const appPid = process.pid + 10, child = appPid + 1, grandchild = child + 1, unrelated = grandchild + 1;
  let calls = 0;
  const pids = await captureMacosDescendants(appPid, async (file, args, options) => {
    calls++;
    assert.equal(file, "/bin/ps"); assert.deepEqual(args, ["-ax", "-o", "pid=,ppid="]);
    assert.deepEqual(options, { encoding: "utf8", timeout: 5000, maxBuffer: 4 * 1024 * 1024,
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" } });
    return { stdout: `${grandchild} ${child}\n${child} ${appPid}\n${appPid} 1\n${unrelated} 1\n` };
  });
  assert.equal(calls, 1);
  assert.deepEqual(pids, new Set([appPid, child, grandchild]));
});

test("renamed, reparented or reused observed PIDs remain a conservative cleanup failure", async () => {
  const appPid = process.pid + 10, child = appPid + 1;
  const observedPids = await captureMacosDescendants(appPid, async () => ({ stdout: `${appPid} 1\n${child} ${appPid}\n` }));
  for (const command of ["Cursor Helper: shared-process", "Cursor Helper: ptyHost", "/usr/bin/unrelated-reused-pid"]) {
    assert.equal(hasOwnedMacosProcesses(`${child} ${command}\n`, { ...owners, observedPids }), true);
    assert.equal(hasOwnedMacosProcesses(`${child} ${command}\n`, { ...owners, observedPids, includeBackend: false }), true);
  }
  assert.equal(await auditMacosProcesses({ ...owners, observedPids }, async () => ({ stdout: `${child} Cursor Helper: shared-process\n` })), true);
  assert.equal(hasOwnedMacosProcesses(`${child + 1} /usr/bin/unrelated\n`, { ...owners, observedPids }), false);
});

test("descendant capture and final audit exclude the observer even when a synthetic table links it", async () => {
  const appPid = process.pid + 10, observerChild = appPid + 1;
  const observedPids = await captureMacosDescendants(appPid, async () => ({
    stdout: `${appPid} 1\n${process.pid} ${appPid}\n${observerChild} ${process.pid}\n`,
  }));
  assert.deepEqual(observedPids, new Set([appPid]));
  observedPids.add(process.pid);
  assert.equal(hasOwnedMacosProcesses(`${process.pid} ${appPath}\n`, { ...owners, selfPid: process.pid, observedPids }), false);
  await assert.rejects(captureMacosDescendants(process.pid, async () => assert.fail("must not inspect the observer")),
    { code: "CURSOR_APP_MACOS_RUNTIME_ARGUMENTS" });
});

test("descendant capture rejects missing roots, invalid or duplicate ps rows and command failures", async () => {
  const appPid = process.pid + 10;
  for (const stdout of ["", "private-output-canary", `${appPid + 1} 1\n`, `${appPid} 1\ntruncated`,
    `${appPid} 1\n${appPid} 2\n`, `${appPid} 1 extra`, `${appPid} 999999999999999999999999`]) {
    await assert.rejects(captureMacosDescendants(appPid, async () => ({ stdout })), {
      code: "CURSOR_APP_MACOS_PROCESS_AUDIT", message: "CURSOR_APP_MACOS_PROCESS_AUDIT",
    });
  }
  await assert.rejects(captureMacosDescendants(appPid, async () => { throw new Error("private-command-canary"); }),
    { code: "CURSOR_APP_MACOS_PROCESS_AUDIT", message: "CURSOR_APP_MACOS_PROCESS_AUDIT" });
  for (const value of [undefined, 0, -1, 1, "42", 1.5]) await assert.rejects(captureMacosDescendants(value,
    async () => assert.fail("must not inspect invalid PID")), { code: "CURSOR_APP_MACOS_RUNTIME_ARGUMENTS" });
  for (const observedPids of [[], new Set(["42"]), new Set([0]), new Set([1.5])]) {
    assert.throws(() => hasOwnedMacosProcesses("50 /bin/true", { ...owners, observedPids }),
      { code: "CURSOR_APP_MACOS_RUNTIME_ARGUMENTS" });
  }
});

const listenerOptions = { ...owners, appPid: 50, backendPort: 43124, debugPort: port };
const listenerError = { code: "CURSOR_APP_MACOS_LISTENER_AUDIT", message: "CURSOR_APP_MACOS_LISTENER_AUDIT" };
const processRow = (pid, ppid, command, started = "Mon Oct  5 12:34:56 2026") => `${pid} ${ppid} ${started} ${command}\n`;
const listenerProcesses = processRow(42, 1, `/opt/node controller ${packageRoot} ${stateHome}`)
  + processRow(50, 42, appPath) + processRow(51, 50, "Cursor Helper: shared-process")
  + processRow(52, 51, "Cursor Helper: renderer")
  + processRow(60, 1, `/opt/node ${packageRoot}/lib/backend/server.mjs`)
  + processRow(61, 60, "renamed-backend-child")
  + processRow(70, 42, "local-mock-controller")
  + processRow(71, 42, `${appBundle}-other/Contents/MacOS/Cursor`)
  + processRow(72, 42, `/opt/node ${stateHome}-other/service`);
const socketFields = (fd, address, type = "IPv4") => `f${fd}\0t${type}\0PTCP\0n${address}\0TST=LISTEN\0\n`;
const listenerOutput = `p52\0\n${socketFields(4, `127.0.0.1:${port}`)}`
  + `p60\0\n${socketFields(7, "127.0.0.1:43124")}${socketFields(8, "[::1]:43124", "IPv6")}`;
function listenerExecutor({ before = listenerProcesses, after = before, output = listenerOutput, warning = "", fail } = {}) {
  let inspected = false;
  return async (file) => {
    if (file === fail) throw new Error("private-command-output-canary");
    if (file === "/usr/sbin/lsof") return { stdout: output, stderr: warning };
    const stdout = inspected ? after : before;
    inspected = true;
    return { stdout };
  };
}

test("listener audit selects App descendants and exact Backend owners, never the controller or its mock", async () => {
  const calls = [], execute = listenerExecutor();
  assert.equal(await auditMacosListeners(listenerOptions, async (file, args, options) => {
    calls.push([file, args]);
    assert.deepEqual(options, { encoding: "utf8", timeout: 5000, maxBuffer: 4 * 1024 * 1024,
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" } });
    return execute(file);
  }), true);
  assert.deepEqual(calls, [
    ["/bin/ps", ["-axww", "-o", "pid=,ppid=,lstart=,command="]],
    ["/usr/sbin/lsof", ["-nP", "-a", "-p", "50,51,52,60,61", "-iTCP", "-sTCP:LISTEN", "-F0pftPnT", "-T", "s"]],
    ["/bin/ps", ["-axww", "-o", "pid=,ppid=,lstart=,command="]],
  ]);
});

test("listener audit accepts either loopback family and a state-path Backend with different PIDs", async () => {
  const options = { ...listenerOptions, appPid: 150 };
  const before = processRow(150, 42, appPath) + processRow(151, 150, "renamed-helper")
    + processRow(160, 1, `/opt/node ${stateHome}/runtime/backend.mjs`);
  const output = `p151\0\n${socketFields(3, `[::1]:${port}`, "IPv6")}`
    + `p160\0\n${socketFields(9, "127.0.0.1:43124")}`;
  assert.equal(await auditMacosListeners(options, listenerExecutor({ before, output })), true);
});

test("listener audit rejects wildcard, non-loopback and additional owned listening ports", async () => {
  for (const [address, type] of [[`*:${port}`, "IPv4"], [`0.0.0.0:${port}`, "IPv4"],
    [`192.0.2.1:${port}`, "IPv4"], [`127.0.0.2:${port}`, "IPv4"], [`[::]:${port}`, "IPv6"],
    [`[2001:db8::1]:${port}`, "IPv6"], [`[::ffff:127.0.0.1]:${port}`, "IPv6"],
    ["127.0.0.1:43125", "IPv4"], [`localhost:${port}`, "IPv4"]]) {
    const output = `${listenerOutput}p61\0\n${socketFields(3, address, type)}`;
    await assert.rejects(auditMacosListeners(listenerOptions, listenerExecutor({ output })), listenerError);
  }
});

test("listener audit requires both actual ports and cannot pass empty or partial exit-zero lsof output", async () => {
  for (const output of ["", "\0\n", "p50\0\n", `p52\0\n${socketFields(4, `127.0.0.1:${port}`)}`,
    `p60\0\n${socketFields(7, "127.0.0.1:43124")}`, listenerOutput.replace("TST=LISTEN\0\n", "")]) {
    await assert.rejects(auditMacosListeners(listenerOptions, listenerExecutor({ output })), listenerError);
  }
});

test("listener audit strictly parses NUL records, file identity, TCP state and selected PIDs", async () => {
  for (const output of [listenerOutput.replaceAll("\0", "\n"), listenerOutput.slice(0, -1),
    listenerOutput.replace("p52\0", "p70\0"), listenerOutput.replace("p52\0", "p42\0"),
    listenerOutput.replace("p52\0\n", ""), listenerOutput.replace("p52\0", "p52\0extra\0"),
    listenerOutput.replace("PTCP\0", "PUDP\0"), listenerOutput.replace("tIPv4\0", "tIPv6\0"),
    listenerOutput.replace("TST=LISTEN", "TST=ESTABLISHED"), listenerOutput.replace("f4\0", "f4\0f5\0"),
    listenerOutput.replace("f4\0", "funknown\0"), `${listenerOutput}p60\0\n`,
    `${listenerOutput}${socketFields(7, "127.0.0.1:43124")}`]) {
    await assert.rejects(auditMacosListeners(listenerOptions, listenerExecutor({ output })), listenerError);
  }
});

test("listener audit conservatively fails disappearing or reused listener and App PIDs", async () => {
  for (const pid of [50, 52, 60]) {
    const lines = listenerProcesses.split("\n").filter((line) => line && !line.startsWith(`${pid} `)).join("\n") + "\n";
    for (const after of [lines, lines + processRow(pid, 1, "/usr/bin/unrelated"),
      listenerProcesses.replace(new RegExp(`(${pid} \\d+ Mon Oct  5 )12:34:56`), "$112:35:57")]) {
      await assert.rejects(auditMacosListeners(listenerOptions, listenerExecutor({ after })), listenerError);
    }
  }
});

test("listener audit tolerates exited non-listening Hooks and reparented listeners with unchanged identities", async () => {
  const after = listenerProcesses.split("\n").filter((line) => !line.startsWith("61 ")).join("\n")
    .replace("52 51 ", "52 1 ");
  assert.equal(await auditMacosListeners(listenerOptions, listenerExecutor({ after })), true);
});

test("listener audit rejects missing App ownership, malformed process snapshots and duplicate rows", async () => {
  for (const before of ["", "private-process-canary", listenerProcesses.replace(appPath, "/usr/bin/unrelated"),
    listenerProcesses + processRow(50, 1, appPath), listenerProcesses + "truncated\n",
    listenerProcesses.replace("52 51", "99999999999999999999 51")]) {
    await assert.rejects(auditMacosListeners(listenerOptions, listenerExecutor({ before })), listenerError);
  }
  await assert.rejects(auditMacosListeners(listenerOptions, listenerExecutor({ after: "private-output-canary" })), listenerError);
});

test("listener audit fails closed on execution errors or lsof warnings without exposing diagnostics", async () => {
  for (const options of [{ fail: "/bin/ps" }, { fail: "/usr/sbin/lsof" }, { warning: "private-partial-output-canary" }]) {
    await assert.rejects(auditMacosListeners(listenerOptions, listenerExecutor(options)), listenerError);
  }
});

test("listener audit validates PIDs, paths and the two distinct ports before inspecting anything", async () => {
  for (const change of [{ appPid: 42 }, { appPid: 1 }, { appPid: "50" }, { selfPid: 0 }, { appBundle: "/" },
    { packageRoot: "relative" }, { backendPort: port }, { backendPort: "43124" }, { debugPort: 0 }]) {
    await assert.rejects(auditMacosListeners({ ...listenerOptions, ...change }, async () => assert.fail("must not execute")),
      { code: "CURSOR_APP_MACOS_RUNTIME_ARGUMENTS" });
  }
});

test("DevTools endpoint comes only from complete owned stderr lines and permits one unique URL", () => {
  const reader = createDevToolsEndpointReader(port);
  reader.push(`noise http://127.0.0.1:${port}/json/version\n`);
  assert.equal(reader.get(), undefined);
  const line = diagnostic(endpoint);
  for (const byte of Buffer.from(line)) reader.push(Buffer.from([byte]));
  assert.equal(reader.get(), endpoint);
  reader.push(diagnostic(endpoint));
  assert.equal(reader.get(), endpoint);
  const other = endpoint.replace("123456789abc", "123456789def");
  assert.throws(() => reader.push(diagnostic(other)), { code: "CURSOR_APP_MACOS_DEBUG_ENDPOINT_AMBIGUOUS" });
  assert.throws(() => reader.get(), { code: "CURSOR_APP_MACOS_DEBUG_ENDPOINT_AMBIGUOUS" });
});

test("DevTools endpoint rejects other hosts, ports, paths and malformed URLs with fixed errors", () => {
  for (const value of [endpoint.replace("127.0.0.1", "localhost"), endpoint.replace("127.0.0.1", "0.0.0.0"),
    endpoint.replace(String(port), String(port + 1)), endpoint.replace("ws:", "wss:"),
    endpoint.replace("/browser/", "/page/"), `${endpoint}?secret=canary`, `${endpoint}#private`,
    endpoint.replace("123456789abc", "not-a-uuid"), endpoint.replace("127.0.0.1", "user:secret@127.0.0.1")]) {
    const reader = createDevToolsEndpointReader(port);
    assert.throws(() => reader.push(diagnostic(value)), {
      code: "CURSOR_APP_MACOS_DEBUG_ENDPOINT", message: "CURSOR_APP_MACOS_DEBUG_ENDPOINT",
    });
    assert.throws(() => reader.get(), { code: "CURSOR_APP_MACOS_DEBUG_ENDPOINT" });
  }
  assert.throws(() => createDevToolsEndpointReader(port).push("x".repeat(65537)), { code: "CURSOR_APP_MACOS_DEBUG_ENDPOINT" });
  for (const value of [0, -1, 65536, "9222"]) assert.throws(() => createDevToolsEndpointReader(value),
    { code: "CURSOR_APP_MACOS_RUNTIME_ARGUMENTS" });
});

function portServer({ port = 51234, failListen = false, failClose = false } = {}) {
  const server = new EventEmitter();
  server.calls = [];
  server.address = () => ({ port });
  server.listen = (selected, host, callback) => {
    server.calls.push(["listen", selected, host]);
    queueMicrotask(() => failListen ? server.emit("error", new Error("private-listen-canary")) : callback());
  };
  server.close = (callback) => { server.calls.push(["close"]); callback(failClose ? new Error("private-close-canary") : undefined); };
  return server;
}

test("free port selection binds loopback only and closes before returning", async () => {
  const server = portServer();
  assert.equal(await reserveFreePort(() => server), 51234);
  assert.deepEqual(server.calls, [["listen", 0, "127.0.0.1"], ["close"]]);
});

test("port selection exposes fixed errors for construction, bind, close and invalid addresses", async () => {
  for (const options of [{ failListen: true }, { failClose: true }, { port: 0 }, { port: "51234" }]) {
    await assert.rejects(reserveFreePort(() => portServer(options)), {
      message: "CURSOR_APP_MACOS_PORT_RESERVATION", code: "CURSOR_APP_MACOS_PORT_RESERVATION",
    });
  }
  await assert.rejects(reserveFreePort(() => { throw new Error("private-construction-canary"); }),
    { code: "CURSOR_APP_MACOS_PORT_RESERVATION" });
});
