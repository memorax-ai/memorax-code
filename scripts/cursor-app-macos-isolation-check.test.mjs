import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { access } from "node:fs/promises";
import { createConnection } from "node:net";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { assertMacosNetworkEvidence, executeMacosSandbox, makeMacosNetworkProfile, probeNetworkLevel, runMacosIsolationProof }
  from "./cursor-app-macos-isolation-check.mjs";

function rows(parentPid = 99) {
  return [0, 1, 2].map((depth) => ({ depth, pid: 100 + depth, parentPid: depth ? 99 + depth : parentPid,
    allowedLoopback: "CONNECTED", blockedLoopback: "EPERM", ipv4: "EACCES", ipv6: "EPERM" }));
}
const identity = { pid: 100, parentPid: 99 };

test("network profile only allows outbound TCP to the exact loopback port", () => {
  assert.equal(makeMacosNetworkProfile(12345), '(version 1)\n(allow default)\n(deny network*)\n(allow network-outbound (remote tcp "localhost:12345"))\n');
  for (const value of [undefined, null, 0, -1, 65536, 1.5, "12345", "12345\n(allow network*)"]) {
    assert.throws(() => makeMacosNetworkProfile(value), { code: "CURSOR_APP_MACOS_PROOF_ARGUMENTS" });
  }
});

test("only explicit OS denials pass for every level in the actual process chain", () => {
  assert.deepEqual(assertMacosNetworkEvidence(rows(), identity), { allowedLoopback: true, otherLoopbackDenied: true,
    externalIpv4Denied: true, externalIpv6Denied: true, inheritedChild: true, inheritedGrandchild: true });
  for (const depth of [0, 1, 2]) {
    for (const [field, code] of [["blockedLoopback", "CURSOR_APP_MACOS_LOOPBACK_NOT_RESTRICTED"],
      ["ipv4", "CURSOR_APP_MACOS_IPV4_NOT_DENIED"], ["ipv6", "CURSOR_APP_MACOS_IPV6_NOT_DENIED"]]) {
      for (const outcome of ["CONNECTED", "TIMEOUT", "ENETUNREACH", "ECONNREFUSED", "OTHER", "NOT_RUN", undefined]) {
        const evidence = rows(); evidence[depth][field] = outcome;
        assert.throws(() => assertMacosNetworkEvidence(evidence, identity), { code, message: code });
      }
    }
    const evidence = rows(); evidence[depth].allowedLoopback = "EPERM";
    assert.throws(() => assertMacosNetworkEvidence(evidence, identity), { code: "CURSOR_APP_MACOS_LOOPBACK_UNAVAILABLE" });
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
    const evidence = await probeNetworkLevel(12345, 12346, 0, {
      connect: async (host, port) => { calls.push([host, port]); return port === 12345 ? "CONNECTED" : blocked; },
      runChild: async () => { assert.fail("must not start a child"); },
    });
    assert.deepEqual(calls, [["127.0.0.1", 12345], ["127.0.0.1", 12346]]);
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0].ipv4, "NOT_RUN");
    assert.equal(evidence[0].ipv6, "NOT_RUN");
  }
});

test("worker repeats the full proof in both child generations and stops at the grandchild", async () => {
  const calls = [], generations = [];
  const run = (depth) => probeNetworkLevel(12345, 12346, depth, {
    connect: async (host, port) => { calls.push([depth, host, port]); return port === 12345 ? "CONNECTED" : "EPERM"; },
    runChild: async (next) => { generations.push(next); return run(next); },
  });
  const evidence = await run(0);
  assert.deepEqual(generations, [1, 2]);
  assert.deepEqual(evidence.map((row) => row.depth), [0, 1, 2]);
  assert.deepEqual(calls, [0, 1, 2].flatMap((depth) => [[depth, "127.0.0.1", 12345], [depth, "127.0.0.1", 12346],
    [depth, "198.51.100.1", 9], [depth, "2001:db8::1", 9]]));
});

test("unsupported platforms fail without starting fixtures or a subprocess", async () => {
  for (const platform of ["linux", "win32", "unknown-private-platform"]) {
    const report = await runMacosIsolationProof({ platform, execute: async () => assert.fail("must not execute") });
    assert.equal(report.errorCode, "CURSOR_APP_MACOS_PROOF_PLATFORM");
    assert.equal(report.status, "FAIL");
    assert.equal(report.appStarted, false);
    assert.equal(report.nativeAcceptance, false);
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
    const port = Number(args.at(-3));
    assert.equal(args[1], makeMacosNetworkProfile(port));
    for (let index = 0; index < 3; index++) {
      await new Promise((done, reject) => {
        const socket = createConnection({ host: "127.0.0.1", port });
        socket.once("end", () => { socket.destroy(); done(); }); socket.once("error", reject); socket.resume();
      });
    }
    const evidence = rows(process.pid); evidence[0].privatePath = "/private/synthetic";
    return { pid: 100, stdout: JSON.stringify(evidence), stderr: "private synthetic credentials" };
  } });
  assert.equal(report.status, "PASS", JSON.stringify(report));
  assert.equal(report.kind, "network-isolation-proof");
  assert.equal(report.scope, "sandbox-exec-network-only");
  assert.equal(report.appStarted, false);
  assert.equal(report.nativeAcceptance, false);
  assert.deepEqual(Object.keys(report).sort(), ["appStarted", "evidence", "kind", "nativeAcceptance", "platform", "schemaVersion", "scope", "status"]);
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
