import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { auditMacosProcesses, captureMacosDescendants, createDevToolsEndpointReader, hasOwnedMacosProcesses, macosRuntimePaths,
  reserveFreePort, sandboxInvocation } from "./cursor-app-macos-runtime.mjs";

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
