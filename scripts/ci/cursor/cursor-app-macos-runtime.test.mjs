import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { auditMacosProcesses, captureMacosDescendants, createDevToolsEndpointReader, hasOwnedMacosProcesses, macosRuntimePaths,
  reserveFreePort } from "./cursor-app-macos-runtime.mjs";

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
const startedAt = "Tue Oct 20 21:44:50 2026";
const restartedAt = "Tue Oct 20 21:44:51 2026";
const processLine = (pid, command, start = startedAt) => `${pid} ${start} ${command}`;
const descendantLine = (pid, ppid, start = startedAt) => `${pid} ${ppid} ${start}`;

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

test("read-only process ownership recognizes only exact run paths and excludes the observer", () => {
  const cases = [
    [appPath, true],
    [appBundle + "/Contents/Frameworks/Cursor Helper.app/Contents/MacOS/Cursor Helper", true],
    ["/opt/node " + packageRoot + "/lib/backend/server.mjs", true],
    ["/opt/node --home=" + stateHome, true],
    ["/opt/node '" + marker + "'", true],
    ["/bin/zsh -c '/opt/node -e synthetic \"" + marker + "\"'", true],
    ["/other" + appPath, false],
    [appBundle + "-other/Contents/MacOS/Cursor", false],
    ["/opt/node " + stateHome + "-other/config", false],
    ["/opt/node " + marker + "-other", false],
    ["/opt/node /unrelated/workspace/cancelled-shell-marker", false],
  ];
  for (const [command, expected] of cases) assert.equal(hasOwnedMacosProcesses(processLine(50, command), owners), expected, command);
  assert.equal(hasOwnedMacosProcesses(processLine(42, appPath + " " + packageRoot + " " + stateHome), owners), false);
  assert.equal(hasOwnedMacosProcesses(processLine(0, "kernel_task") + "\n  " + processLine(51, "/usr/bin/true"), owners), false);
  assert.equal(hasOwnedMacosProcesses(processLine(50, "/opt/node " + packageRoot + "/lib/backend/server.mjs"), { ...owners, includeBackend: false }), false);
  assert.equal(hasOwnedMacosProcesses(processLine(50, appPath), { ...owners, includeBackend: false }), true);
  assert.equal(hasOwnedMacosProcesses(processLine(50, "/opt/node " + marker), { ...owners, includeBackend: false }), true);
});

test("process audit rejects incomplete, invalid or duplicate ps rows instead of claiming cleanup succeeded", () => {
  for (const output of ["", "   ", "private-unparseable-output", "50 /usr/bin/true", processLine(50, "/usr/bin/true") + "\ntruncated",
    processLine("9".repeat(30), "/bin/true"), processLine(50, "/bin/true") + "\n" + processLine(50, "/bin/true", restartedAt)]) {
    assert.throws(() => hasOwnedMacosProcesses(output, owners), { code: "CURSOR_APP_MACOS_PROCESS_AUDIT" });
  }
  for (const invalid of ["private-time-canary", "Tue Oct 32 21:44:50 2026", "Tue Oct 20 25:44:50 2026",
    "Tue Oct 20 21:60:50 2026", "Tue Oct 20 21:44:60 2026", "Tue Foo 20 21:44:50 2026", "Tue Oct 20 21:44:50 26",
    "Mon Oct 20 21:44:50 2026", "Tue Feb 31 21:44:50 2026"]) {
    assert.throws(() => hasOwnedMacosProcesses(processLine(50, "/bin/true", invalid), owners), { code: "CURSOR_APP_MACOS_PROCESS_AUDIT" });
  }
});

test("macOS process inspection executes bounded ps with start identity, a clean environment and no signals", async () => {
  let calls = 0;
  const remains = await auditMacosProcesses(owners, async (file, args, options) => {
    calls++;
    assert.equal(file, "/bin/ps");
    assert.deepEqual(args, ["-axww", "-o", "pid=,lstart=,command="]);
    assert.deepEqual(options, { encoding: "utf8", timeout: 5000, maxBuffer: 4 * 1024 * 1024,
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" } });
    return { stdout: processLine(42, appPath) + "\n" + processLine(50, "/opt/node " + marker) + "\n" };
  });
  assert.equal(remains, true);
  assert.equal(calls, 1);
  await assert.rejects(auditMacosProcesses(owners, async () => { throw new Error("private-process-canary"); }),
    { message: "CURSOR_APP_MACOS_PROCESS_AUDIT", code: "CURSOR_APP_MACOS_PROCESS_AUDIT" });
});

test("descendant capture records the live App root and transitive child lifetimes from one bounded snapshot", async () => {
  const appPid = process.pid + 10, child = appPid + 1, grandchild = child + 1, unrelated = grandchild + 1;
  let calls = 0;
  const observedProcesses = await captureMacosDescendants(appPid, async (file, args, options) => {
    calls++;
    assert.equal(file, "/bin/ps"); assert.deepEqual(args, ["-ax", "-o", "pid=,ppid=,lstart="]);
    assert.deepEqual(options, { encoding: "utf8", timeout: 5000, maxBuffer: 4 * 1024 * 1024,
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" } });
    return { stdout: [descendantLine(grandchild, child, restartedAt), descendantLine(child, appPid, restartedAt),
      descendantLine(appPid, 1), descendantLine(unrelated, 1)].join("\n") + "\n" };
  });
  assert.equal(calls, 1);
  assert.deepEqual(observedProcesses, new Map([[appPid, startedAt], [child, restartedAt], [grandchild, restartedAt]]));
});

test("renamed or reparented observed lifetimes remain owned but an unrelated recycled PID is clear on the first audit", async () => {
  const appPid = process.pid + 10, child = appPid + 1;
  const observedProcesses = await captureMacosDescendants(appPid, async () => ({
    stdout: descendantLine(appPid, 1) + "\n" + descendantLine(child, appPid) + "\n",
  }));
  for (const command of ["Cursor Helper: shared-process", "Cursor Helper: ptyHost", "/usr/bin/renamed-survivor"]) {
    for (const includeBackend of [true, false]) {
      assert.equal(hasOwnedMacosProcesses(processLine(child, command), { ...owners, observedProcesses, includeBackend }), true);
    }
  }
  assert.equal(await auditMacosProcesses({ ...owners, observedProcesses }, async () => ({
    stdout: processLine(child, "/usr/bin/unrelated-reused-pid", restartedAt),
  })), false);
  assert.equal(hasOwnedMacosProcesses(processLine(child + 1, "/usr/bin/unrelated"), { ...owners, observedProcesses }), false);
  // Path ownership must still catch a new owned lifetime even when its old PID was recorded.
  assert.equal(hasOwnedMacosProcesses(processLine(child, appPath, restartedAt), { ...owners, observedProcesses }), true);
  assert.equal(hasOwnedMacosProcesses(processLine(child, "/opt/node " + stateHome, restartedAt), { ...owners, observedProcesses }), true);
});

test("second-resolution start identity keeps indistinguishable PID reuse a conservative cleanup failure", async () => {
  const appPid = process.pid + 10;
  const observedProcesses = await captureMacosDescendants(appPid, async () => ({ stdout: descendantLine(appPid, 1) }));
  assert.equal(hasOwnedMacosProcesses(processLine(appPid, "/usr/bin/possibly-reused-within-same-second"), { ...owners, observedProcesses }), true);
});

test("ps padding is normalized without changing a process lifetime", async () => {
  const appPid = process.pid + 10;
  const padded = "Thu Oct  1 01:02:03 2026", normalized = "Thu Oct 1 01:02:03 2026";
  const observedProcesses = await captureMacosDescendants(appPid, async () => ({ stdout: "  " + descendantLine(appPid, 1, padded) + "  \n" }));
  assert.deepEqual(observedProcesses, new Map([[appPid, normalized]]));
  assert.equal(hasOwnedMacosProcesses("  " + processLine(appPid, "/usr/bin/renamed-survivor", padded), { ...owners, observedProcesses }), true);
});

test("descendant capture and final audit exclude the observer even when a synthetic table links it", async () => {
  const appPid = process.pid + 10, observerChild = appPid + 1;
  const observedProcesses = await captureMacosDescendants(appPid, async () => ({
    stdout: [descendantLine(appPid, 1), descendantLine(process.pid, appPid), descendantLine(observerChild, process.pid)].join("\n"),
  }));
  assert.deepEqual(observedProcesses, new Map([[appPid, startedAt]]));
  observedProcesses.set(process.pid, startedAt);
  assert.equal(hasOwnedMacosProcesses(processLine(process.pid, appPath), { ...owners, selfPid: process.pid, observedProcesses }), false);
  await assert.rejects(captureMacosDescendants(process.pid, async () => assert.fail("must not inspect the observer")),
    { code: "CURSOR_APP_MACOS_RUNTIME_ARGUMENTS" });
});

test("descendant capture rejects missing roots, invalid or duplicate ps rows and command failures", async () => {
  const appPid = process.pid + 10;
  for (const stdout of ["", "private-output-canary", descendantLine(appPid + 1, 1), descendantLine(appPid, 1) + "\ntruncated",
    descendantLine(appPid, 1) + "\n" + descendantLine(appPid, 2), descendantLine(appPid, 1) + " extra",
    descendantLine(appPid, "9".repeat(30)), descendantLine(appPid, 1, "Tue Feb 31 21:44:50 2026")]) {
    await assert.rejects(captureMacosDescendants(appPid, async () => ({ stdout })), {
      code: "CURSOR_APP_MACOS_PROCESS_AUDIT", message: "CURSOR_APP_MACOS_PROCESS_AUDIT",
    });
  }
  await assert.rejects(captureMacosDescendants(appPid, async () => { throw new Error("private-command-canary"); }),
    { code: "CURSOR_APP_MACOS_PROCESS_AUDIT", message: "CURSOR_APP_MACOS_PROCESS_AUDIT" });
  for (const value of [undefined, 0, -1, 1, "42", 1.5]) await assert.rejects(captureMacosDescendants(value,
    async () => assert.fail("must not inspect invalid PID")), { code: "CURSOR_APP_MACOS_RUNTIME_ARGUMENTS" });
  for (const observedProcesses of [[], new Set([42]), new Map([["42", startedAt]]), new Map([[0, startedAt]]),
    new Map([[1.5, startedAt]]), new Map([[42, undefined]]), new Map([[42, "private-time-canary"]]),
    new Map([[42, "Tue Oct  20 21:44:50 2026"]])]) {
    assert.throws(() => hasOwnedMacosProcesses(processLine(50, "/bin/true"), { ...owners, observedProcesses }),
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
