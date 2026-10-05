import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { access, mkdtemp, realpath, rm } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { assertMacosNetworkEvidence, executeMacosSandbox, makeMacosNetworkProfile, probeNetworkLevel,
  projectMacosNetworkDiagnostic, runMacosIsolationProof }
  from "./cursor-app-macos-isolation-check.mjs";

function rows(parentPid = 99) {
  return [0, 1, 2].map((depth) => ({ depth, pid: 100 + depth, parentPid: depth ? 99 + depth : parentPid,
    allowedLoopback: "CONNECTED", blockedLoopback: "EPERM", listenerIpv4: "LISTENED", listenerIpv6: "LISTENED",
    otherListenerIpv4: "EPERM", otherListenerIpv6: "EACCES", wildcardIpv4: "EPERM", wildcardIpv6: "EACCES",
    unixUserData: "LISTENED", unixTmp: "LISTENED", otherUnixConnect: "EPERM", otherUnixBind: "EACCES",
    ipv4: "EACCES", ipv6: "EPERM" }));
}
const identity = { pid: 100, parentPid: 99 };
const unixPaths = { userData: "/owned/app-data/proof.sock", tmp: "/owned/tmp/proof.sock",
  blockedConnect: "/owned/app-data-other/proof.sock", blockedBind: "/owned/tmp-other/proof.sock" };

test("network profile only allows outbound TCP to the exact loopback port", () => {
  assert.equal(makeMacosNetworkProfile(12345), '(version 1)\n(allow default)\n(deny network*)\n(allow network-outbound (remote tcp "localhost:12345"))\n');
  for (const value of [undefined, null, 0, -1, 65536, 1.5, "12345", "12345\n(allow network*)"]) {
    assert.throws(() => makeMacosNetworkProfile(value), { code: "CURSOR_APP_MACOS_PROOF_ARGUMENTS" });
  }
});

test("network profile bounds exact outbound and listener ports", () => {
  const profile = makeMacosNetworkProfile([12345, 12347], [12347]);
  assert.equal(profile, '(version 1)\n(allow default)\n(deny network*)\n'
    + '(allow network-outbound (remote tcp "localhost:12345"))\n'
    + '(allow network-outbound (remote tcp "localhost:12347"))\n'
    + '(allow network-bind (local tcp "localhost:12347"))\n'
    + '(allow network-inbound (local tcp "localhost:12347"))\n');
  for (const ports of [[], [12345, 12345], Array(1), Array.from({ length: 9 }, (_, index) => index + 1),
    [0], [65536], [1.5], ["12345"], ["12345\n(allow network*)"]]) {
    assert.throws(() => makeMacosNetworkProfile(ports), { code: "CURSOR_APP_MACOS_PROOF_ARGUMENTS" });
  }
  for (const ports of [null, 12347, [12347, 12347], [0], ["12347"], Array(1), Array.from({ length: 9 }, (_, index) => index + 1)]) {
    assert.throws(() => makeMacosNetworkProfile(12345, ports), { code: "CURSOR_APP_MACOS_PROOF_ARGUMENTS" });
  }
});

test("Unix IPC rules use only canonical directory filters and escape profile strings", () => {
  const directories = ["/private/tmp/owned/app-data", "/private/tmp/owned/tmp"];
  assert.equal(makeMacosNetworkProfile(12345, [], directories), makeMacosNetworkProfile(12345)
    + directories.map((path) => `(allow network-bind network-inbound network-outbound (subpath "${path}"))\n`).join(""));
  const quoted = '/private/tmp/owned/quoted"name';
  assert.ok(makeMacosNetworkProfile(12345, [], [quoted]).endsWith(`(subpath ${JSON.stringify(quoted)}))\n`));
  for (const paths of [null, "/private/tmp/owned", ["/"], ["relative"], ["/private/tmp/../owned"],
    ["/private/tmp/owned/"], ["/private/tmp/private\ncanary"], ["/owned", "/owned"], Array(1),
    ["/one", "/two", "/three"]]) {
    assert.throws(() => makeMacosNetworkProfile(12345, [], paths), { code: "CURSOR_APP_MACOS_PROOF_ARGUMENTS" });
  }
});

test("restricted network gates require explicit OS denials at every process level", () => {
  assert.deepEqual(assertMacosNetworkEvidence(rows(), identity), { allowedLoopback: true, otherLoopbackDenied: true,
    allowedListenerIpv4: true, allowedListenerIpv6: true, otherListenerPortsDenied: true,
    ownedUnixIpc: true, otherUnixPathsDenied: true,
    externalIpv4Denied: true, externalIpv6Denied: true, inheritedChild: true, inheritedGrandchild: true });
  for (const depth of [0, 1, 2]) {
    for (const [field, code] of [["blockedLoopback", "CURSOR_APP_MACOS_LOOPBACK_NOT_RESTRICTED"],
      ["otherListenerIpv4", "CURSOR_APP_MACOS_LISTENER_NOT_RESTRICTED"], ["otherListenerIpv6", "CURSOR_APP_MACOS_LISTENER_NOT_RESTRICTED"],
      ["otherUnixConnect", "CURSOR_APP_MACOS_UNIX_NOT_RESTRICTED"], ["otherUnixBind", "CURSOR_APP_MACOS_UNIX_NOT_RESTRICTED"],
      ["ipv4", "CURSOR_APP_MACOS_IPV4_NOT_DENIED"], ["ipv6", "CURSOR_APP_MACOS_IPV6_NOT_DENIED"]]) {
      for (const outcome of ["CONNECTED", "LISTENED", "TIMEOUT", "EADDRINUSE", "ENETUNREACH", "ECONNREFUSED", "OTHER", "NOT_RUN", undefined]) {
        const evidence = rows(); evidence[depth][field] = outcome;
        assert.throws(() => assertMacosNetworkEvidence(evidence, identity), { code, message: code });
      }
    }
    const evidence = rows(); evidence[depth].allowedLoopback = "EPERM";
    assert.throws(() => assertMacosNetworkEvidence(evidence, identity), { code: "CURSOR_APP_MACOS_LOOPBACK_UNAVAILABLE" });
    for (const field of ["listenerIpv4", "listenerIpv6"]) {
      const listeners = rows(); listeners[depth][field] = "EPERM";
      assert.throws(() => assertMacosNetworkEvidence(listeners, identity), { code: "CURSOR_APP_MACOS_LISTENER_UNAVAILABLE" });
    }
    for (const field of ["unixUserData", "unixTmp"]) {
      for (const outcome of ["EPERM", "CONNECTED", "TIMEOUT", "ENOENT", "EADDRINUSE", undefined]) {
        const sockets = rows(); sockets[depth][field] = outcome;
        assert.throws(() => assertMacosNetworkEvidence(sockets, identity), { code: "CURSOR_APP_MACOS_UNIX_UNAVAILABLE" });
      }
    }
  }
});

test("wildcard listeners are bounded observations, never inbound address denial evidence", () => {
  for (const depth of [0, 1, 2]) for (const field of ["wildcardIpv4", "wildcardIpv6"]) {
    for (const outcome of ["LISTENED", "EPERM", "EACCES"]) {
      const evidence = rows(); evidence[depth][field] = outcome;
      const result = assertMacosNetworkEvidence(evidence, identity);
      assert.equal(Object.hasOwn(result, "wildcardIpv4Denied"), false);
      assert.equal(Object.hasOwn(result, "wildcardIpv6Denied"), false);
    }
    for (const outcome of ["CONNECTED", "TIMEOUT", "EADDRINUSE", "EADDRNOTAVAIL", "OTHER", "NOT_RUN", undefined, "private-result-canary"]) {
      const evidence = rows(); evidence[depth][field] = outcome;
      assert.throws(() => assertMacosNetworkEvidence(evidence, identity), { code: "CURSOR_APP_MACOS_WILDCARD_OBSERVATION_INVALID" });
    }
  }
});

test("missing, duplicated, reordered or unrelated processes cannot establish inheritance", () => {
  for (const change of [
    (value) => { value.pop(); },
    (value) => { value[2].pid = value[1].pid; },
    (value) => { value[1].parentPid = 98; },
    (value) => { value[0].parentPid = 98; },
    (value) => { value[0].pid = 105; },
    (value) => { value[2].depth = 0; },
    (value) => { value[1].pid = "101"; },
    (value) => { value.reverse(); },
  ]) {
    const evidence = rows(); change(evidence);
    assert.throws(() => assertMacosNetworkEvidence(evidence, identity), { code: "CURSOR_APP_MACOS_PROOF_INHERITANCE" });
  }
  for (const evidence of [undefined, {}, [], [...rows(), rows()[0]]]) {
    assert.throws(() => assertMacosNetworkEvidence(evidence, identity), { code: "CURSOR_APP_MACOS_PROOF_OUTPUT" });
  }
});

test("ineffective sandbox stops at owned loopback before any external probe or descendant", async () => {
  for (const blocked of ["CONNECTED", "TIMEOUT", "OTHER"]) {
    const calls = [];
    const evidence = await probeNetworkLevel(12345, 12346, 12347, 12348, 0, {
      connect: async (host, port) => { calls.push([host, port]); return port === 12345 ? "CONNECTED" : blocked; },
      bind: async () => assert.fail("must not attempt bind after ineffective outbound isolation"),
      runChild: async () => { assert.fail("must not start a child"); },
    });
    assert.deepEqual(calls, [["127.0.0.1", 12345], ["127.0.0.1", 12346]]);
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0].ipv4, "NOT_RUN");
    assert.equal(evidence[0].ipv6, "NOT_RUN");
  }
});

test("every actual worker bind gate precedes external probes and stops on anything but the required result", async () => {
  const gates = [["127.0.0.1", 12347, true], ["::1", 12347, true], ["127.0.0.1", 12348, false],
    ["::1", 12348, false], ["0.0.0.0", 12347, false], ["::", 12347, false]];
  for (const [index, gate] of gates.entries()) {
    for (const failed of gate[2] ? ["EPERM", "TIMEOUT", "EADDRINUSE"]
      : index < 4 ? ["LISTENED", "TIMEOUT", "EADDRINUSE", "OTHER"]
        : ["CONNECTED", "TIMEOUT", "EADDRINUSE", "EADDRNOTAVAIL", "OTHER", "NOT_RUN", undefined]) {
      const calls = [];
      const evidence = await probeNetworkLevel(12345, 12346, 12347, 12348, 0, {
        connect: async (host, port) => {
          assert.equal(host, "127.0.0.1", "must not probe an external address before all bind gates pass");
          return port === 12345 ? "CONNECTED" : "EPERM";
        },
        bind: async (...args) => { calls.push(args); return calls.length === index + 1 ? failed : args[2] ? "LISTENED" : "EACCES"; },
        runChild: async () => assert.fail("must not start a child after a failed bind gate"),
      });
      assert.deepEqual(calls, gates.slice(0, index + 1));
      assert.equal(evidence[0].ipv4, "NOT_RUN"); assert.equal(evidence[0].ipv6, "NOT_RUN");
    }
  }
});

test("worker exercises real owned IPv4/IPv6 listeners and closes them before rejecting unrestricted bind", async () => {
  const reservations = [createServer(), createServer()];
  try {
    for (const server of reservations) await new Promise((done, reject) => {
      server.once("error", reject); server.listen(0, "127.0.0.1", done);
    });
    const [listenPort, blockedListenPort] = reservations.map((server) => server.address().port);
    for (const server of reservations) await new Promise((done) => server.close(done));
    const evidence = await probeNetworkLevel(12345, 12346, listenPort, blockedListenPort, 0, {
      connect: async (host, port) => {
        assert.equal(host, "127.0.0.1", "the unrestricted bind must stop external probes");
        return port === 12345 ? "CONNECTED" : "EPERM";
      },
      runChild: async () => assert.fail("the unrestricted bind must stop descendants"),
    });
    assert.equal(evidence[0].listenerIpv4, "LISTENED"); assert.equal(evidence[0].listenerIpv6, "LISTENED");
    assert.equal(evidence[0].otherListenerIpv4, "LISTENED"); assert.equal(evidence[0].wildcardIpv4, "NOT_RUN");
    assert.equal(evidence[0].ipv4, "NOT_RUN"); assert.equal(evidence[0].ipv6, "NOT_RUN");
    for (const [index, server] of reservations.entries()) await new Promise((done, reject) => {
      server.once("error", reject); server.listen(index ? blockedListenPort : listenPort, "127.0.0.1", done);
    });
  } finally {
    for (const server of reservations) if (server.listening) await new Promise((done) => server.close(done));
  }
});

test("worker repeats the full proof in both child generations and stops at the grandchild", async () => {
  const calls = [], generations = [];
  const run = (depth) => probeNetworkLevel(12345, 12346, 12347, 12348, depth, {
    unixPaths,
    connect: async (host, port) => { calls.push([depth, "connect", host, port]); return port === 12345 ? "CONNECTED" : "EPERM"; },
    connectUnix: async (path) => { calls.push([depth, "unix-connect", path]); return "EACCES"; },
    bind: async (host, port, exchange) => {
      calls.push([depth, "bind", host, port, exchange]);
      return host === "0.0.0.0" || host === "::" ? ["LISTENED", "EPERM", "EACCES"][depth] : exchange ? "LISTENED" : "EPERM";
    },
    bindUnix: async (path, exchange) => { calls.push([depth, "bind", path, undefined, exchange]); return exchange ? "LISTENED" : "EPERM"; },
    runChild: async (next) => { generations.push(next); return run(next); },
  });
  const evidence = await run(0);
  assert.deepEqual(generations, [1, 2]);
  assert.deepEqual(evidence.map((row) => row.depth), [0, 1, 2]);
  assert.deepEqual(evidence.map((row) => [row.wildcardIpv4, row.wildcardIpv6]),
    [["LISTENED", "LISTENED"], ["EPERM", "EPERM"], ["EACCES", "EACCES"]]);
  assert.deepEqual(calls, [0, 1, 2].flatMap((depth) => [[depth, "connect", "127.0.0.1", 12345], [depth, "connect", "127.0.0.1", 12346],
    [depth, "bind", "127.0.0.1", 12347, true], [depth, "bind", "::1", 12347, true],
    [depth, "bind", "127.0.0.1", 12348, false], [depth, "bind", "::1", 12348, false],
    [depth, "bind", "0.0.0.0", 12347, false], [depth, "bind", "::", 12347, false],
    [depth, "bind", unixPaths.userData, undefined, true], [depth, "bind", unixPaths.tmp, undefined, true],
    [depth, "unix-connect", unixPaths.blockedConnect], [depth, "bind", unixPaths.blockedBind, undefined, false],
    [depth, "connect", "198.51.100.1", 9], [depth, "connect", "2001:db8::1", 9]]));
});

test("each Unix IPC gate precedes external probes and rejects timeout or an unrestricted neighbor", async () => {
  const gates = ["unixUserData", "unixTmp", "otherUnixConnect", "otherUnixBind"];
  for (const field of gates) for (const outcome of field.startsWith("unix")
    ? ["EPERM", "TIMEOUT", "OTHER"] : ["CONNECTED", "LISTENED", "TIMEOUT", "ENOENT", "OTHER"]) {
    const calls = [];
    const evidence = await probeNetworkLevel(12345, 12346, 12347, 12348, 0, {
      unixPaths,
      connect: async (host, port) => {
        assert.equal(host, "127.0.0.1", "Unix gates must precede external probes");
        return port === 12345 ? "CONNECTED" : "EPERM";
      },
      bind: async (host, port, exchange) => exchange ? "LISTENED" : "EPERM",
      bindUnix: async (path, exchange) => {
        const current = path === unixPaths.userData ? "unixUserData" : path === unixPaths.tmp ? "unixTmp" : "otherUnixBind";
        calls.push(current); return current === field ? outcome : exchange ? "LISTENED" : "EACCES";
      },
      connectUnix: async (path) => {
        assert.equal(path, unixPaths.blockedConnect); calls.push("otherUnixConnect");
        return field === "otherUnixConnect" ? outcome : "EPERM";
      },
      runChild: async () => assert.fail("must not start a child after a failed Unix gate"),
    });
    assert.deepEqual(calls, gates.slice(0, gates.indexOf(field) + 1));
    assert.equal(evidence[0].ipv4, "NOT_RUN"); assert.equal(evidence[0].ipv6, "NOT_RUN");
  }
});

test("worker uses real owned Unix sockets for round trips and catches an unrestricted neighbor", async () => {
  const root = await realpath(await mkdtemp(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "mci-unit-")));
  const paths = Object.fromEntries(Object.keys(unixPaths).map((key) => [key, join(root, `${key}.sock`)]));
  const server = createServer((socket) => socket.end());
  try {
    await new Promise((done, reject) => { server.once("error", reject); server.listen(paths.blockedConnect, done); });
    for (const denyConnect of [false, true]) {
      const evidence = await probeNetworkLevel(12345, 12346, 12347, 12348, 0, {
        unixPaths: paths,
        connect: async (host, port) => {
          assert.equal(host, "127.0.0.1"); return port === 12345 ? "CONNECTED" : "EPERM";
        },
        bind: async (host, port, exchange) => exchange ? "LISTENED" : "EPERM",
        ...(denyConnect ? { connectUnix: async () => "EPERM" } : {}),
        runChild: async () => assert.fail("an unrestricted Unix neighbor must stop descendants"),
      });
      assert.equal(evidence[0].unixUserData, "LISTENED"); assert.equal(evidence[0].unixTmp, "LISTENED");
      assert.equal(evidence[0].otherUnixConnect, denyConnect ? "EPERM" : "CONNECTED");
      assert.equal(evidence[0].otherUnixBind, denyConnect ? "LISTENED" : "NOT_RUN");
      assert.equal(evidence[0].ipv4, "NOT_RUN"); assert.equal(evidence[0].ipv6, "NOT_RUN");
      await assert.rejects(access(paths.userData), { code: "ENOENT" });
      await assert.rejects(access(paths.tmp), { code: "ENOENT" });
    }
  } finally {
    if (server.listening) await new Promise((done) => server.close(done));
    await rm(root, { recursive: true, force: true });
  }
});

test("unsupported platforms fail without starting fixtures or a subprocess", async () => {
  for (const platform of ["linux", "win32", "unknown-private-platform"]) {
    const report = await runMacosIsolationProof({ platform, execute: async () => assert.fail("must not execute") });
    assert.equal(report.errorCode, "CURSOR_APP_MACOS_PROOF_PLATFORM");
    assert.equal(report.status, "FAIL");
    assert.equal(report.appStarted, false);
    assert.equal(report.nativeAcceptance, false);
    assert.equal(report.inboundAddressIsolation, "not-enforced");
    assert.ok(!JSON.stringify(report).includes("unknown-private-platform"));
  }
});

test("proof uses isolated environment and only publishes validated network evidence", async () => {
  let ownedRoot;
  const report = await runMacosIsolationProof({ platform: "darwin", execute: async ({ args, env, cwd }) => {
    ownedRoot = cwd;
    assert.equal(args[0], "-p");
    assert.equal(args[2], process.execPath);
    assert.deepEqual(args.slice(3, 5), ["--input-type=module", "-e"]);
    assert.equal(args.at(-1), "0");
    assert.deepEqual(Object.keys(env).sort(), ["CFFIXED_USER_HOME", "HOME", "LANG", "LC_ALL", "PATH", "TEMP", "TMP", "TMPDIR"]);
    assert.equal(env.HOME, cwd);
    assert.equal(env.CFFIXED_USER_HOME, cwd);
    const port = Number(args.at(-6)), listenPort = Number(args.at(-4)), blockedListenPort = Number(args.at(-3));
    const paths = JSON.parse(args.at(-2));
    assert.deepEqual(paths, { userData: join(cwd, "app-data/proof.sock"), tmp: join(cwd, "tmp/proof.sock"),
      blockedConnect: join(cwd, "app-data-other/proof.sock"), blockedBind: join(cwd, "tmp-other/proof.sock") });
    assert.equal(new Set(args.slice(-6, -2)).size, 4);
    assert.equal(args[1], makeMacosNetworkProfile([port, listenPort], [listenPort], [join(cwd, "app-data"), join(cwd, "tmp")]));
    assert.ok(!args[1].includes(String(blockedListenPort)));
    for (let index = 0; index < 3; index++) {
      await new Promise((done, reject) => {
        const socket = createConnection({ host: "127.0.0.1", port });
        socket.once("end", () => { socket.destroy(); done(); }); socket.once("error", reject); socket.resume();
      });
    }
    const evidence = rows(process.pid); evidence[0].privatePath = "/private/synthetic";
    evidence[0].wildcardIpv4 = "LISTENED"; evidence[1].wildcardIpv6 = "LISTENED";
    return { pid: 100, stdout: JSON.stringify(evidence), stderr: "private synthetic credentials" };
  } });
  assert.equal(report.status, "PASS", JSON.stringify(report));
  assert.equal(report.kind, "network-isolation-proof");
  assert.equal(report.scope, "sandbox-exec-network-only");
  assert.equal(report.inboundAddressIsolation, "not-enforced");
  assert.equal(report.appStarted, false);
  assert.equal(report.nativeAcceptance, false);
  assert.deepEqual(report.observations, { wildcardListeners: [
    { depth: 0, ipv4: "LISTENED", ipv6: "EACCES" },
    { depth: 1, ipv4: "EPERM", ipv6: "LISTENED" },
    { depth: 2, ipv4: "EPERM", ipv6: "EACCES" },
  ] });
  assert.deepEqual(Object.keys(report).sort(), ["appStarted", "evidence", "inboundAddressIsolation", "kind",
    "nativeAcceptance", "observations", "platform", "schemaVersion", "scope", "status"]);
  assert.ok(!JSON.stringify(report).includes("private"));
  assert.ok(!JSON.stringify(report).includes(ownedRoot));
  await assert.rejects(access(ownedRoot), { code: "ENOENT" });
});

test("execution failures, malformed output and missing real fixture connections fail closed and stay redacted", async () => {
  for (const [execute, code] of [
    [async () => { throw null; }, "CURSOR_APP_MACOS_PROOF_FAILED"],
    [async () => { throw Object.assign(new Error("private ENOEXEC path/token"), { code: "ENOEXEC" }); }, "CURSOR_APP_MACOS_PROOF_FAILED"],
    [async () => { throw Object.assign(new Error("private timeout"), { code: "CURSOR_APP_MACOS_PROOF_TIMEOUT" }); }, "CURSOR_APP_MACOS_PROOF_TIMEOUT"],
    [async () => ({ pid: 100, stdout: "private malformed JSON" }), "CURSOR_APP_MACOS_PROOF_OUTPUT"],
    [async () => ({ pid: 100, stdout: JSON.stringify(rows(process.pid)) }), "CURSOR_APP_MACOS_PROOF_FIXTURE"],
  ]) {
    let root;
    const report = await runMacosIsolationProof({ platform: "darwin", execute: async (options) => { root = options.cwd; return execute(options); } });
    assert.equal(report.status, "FAIL");
    assert.equal(report.errorCode, code);
    assert.equal(report.evidence, undefined);
    assert.ok(!JSON.stringify(report).includes("private"));
    assert.ok(!JSON.stringify(report).includes(root));
    await assert.rejects(access(root), { code: "ENOENT" });
  }
});

test("network failure projection accepts only bounded depth and fixed gate/result enums", () => {
  const input = { depth: 2, failedGate: "otherUnixConnect", result: "EPERM", pid: 123, port: 42, path: "/private/canary" };
  assert.deepEqual(projectMacosNetworkDiagnostic(input), { depth: 2, failedGate: "otherUnixConnect", result: "EPERM" });
  for (const value of [undefined, null, {}, { ...input, depth: 3 }, { ...input, depth: "2" },
    { ...input, failedGate: "private-gate-canary" }, { ...input, result: "private-result-canary" }]) {
    assert.equal(projectMacosNetworkDiagnostic(value), undefined);
  }
});

test("proof failure exposes the first failing network gate without path, PID, port or raw error", async () => {
  for (const [depth, failedGate, result, expected] of [[0, "listenerIpv4", "TIMEOUT", "TIMEOUT"],
    [1, "otherUnixBind", "LISTENED", "LISTENED"], [2, "otherUnixConnect", "private-value-canary", "OTHER"],
    [0, "wildcardIpv4", "TIMEOUT", "TIMEOUT"], [1, "wildcardIpv6", "private-value-canary", "OTHER"]]) {
    const evidence = rows(process.pid);
    for (const row of evidence) row.wildcardIpv4 = row.wildcardIpv6 = "LISTENED";
    evidence[depth][failedGate] = result;
    evidence[depth].privatePath = "/private/canary";
    const report = await runMacosIsolationProof({ platform: "darwin", execute: async () => ({ pid: 100, stdout: JSON.stringify(evidence) }) });
    assert.equal(report.status, "FAIL");
    assert.equal(report.evidence, undefined);
    assert.deepEqual(report.diagnostic, { depth, failedGate, result: expected });
    assert.ok(!JSON.stringify(report).includes("private"));
    assert.ok(!JSON.stringify(report).includes("100"));
  }
});

test("sandbox execution errors including ENOEXEC expose only the fixed error code", async () => {
  for (const errorCode of ["ENOEXEC", "ENOENT", "EACCES"]) {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough() });
    await assert.rejects(executeMacosSandbox({ args: ["-p", "profile"], env: {}, cwd: "/synthetic" },
      (command, args, options) => {
        assert.equal(command, "/usr/bin/sandbox-exec");
        assert.deepEqual(args, ["-p", "profile"]);
        assert.equal(options.detached, true);
        assert.deepEqual(options.stdio, ["ignore", "pipe", "ignore"]);
        queueMicrotask(() => {
          child.emit("error", Object.assign(new Error("private path/token"), { code: errorCode }));
          child.emit("close", -1);
        });
        return child;
      }), { code: "CURSOR_APP_MACOS_SANDBOX_EXEC_FAILED", message: "CURSOR_APP_MACOS_SANDBOX_EXEC_FAILED" });
  }
});

test("an already cancelled proof never starts the sandbox", async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(executeMacosSandbox({ signal: controller.signal }, () => assert.fail("must not spawn")),
    { code: "CURSOR_APP_MACOS_PROOF_TIMEOUT" });
  const report = await runMacosIsolationProof({ platform: "darwin", signal: controller.signal,
    execute: async () => assert.fail("must not execute") });
  assert.equal(report.status, "FAIL");
  assert.equal(report.errorCode, "CURSOR_APP_MACOS_PROOF_TIMEOUT");
});

test("CLI rejects arguments with one redacted public report and never runs the sandbox", () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./cursor-app-macos-isolation-check.mjs", import.meta.url)),
    "--private-path=/private/synthetic"], { encoding: "utf8", timeout: 5000 });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  const report = JSON.parse(result.stdout);
  assert.equal(report.errorCode, "CURSOR_APP_MACOS_PROOF_ARGUMENTS");
  assert.equal(report.appStarted, false);
  assert.equal(report.nativeAcceptance, false);
  assert.ok(!result.stdout.includes("private"));
});
