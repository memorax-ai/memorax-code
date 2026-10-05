import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const codes = new Set([
  "CURSOR_APP_MACOS_PROOF_ARGUMENTS", "CURSOR_APP_MACOS_PROOF_PLATFORM", "CURSOR_APP_MACOS_PROOF_FAILED",
  "CURSOR_APP_MACOS_PROOF_FIXTURE", "CURSOR_APP_MACOS_SANDBOX_EXEC_FAILED", "CURSOR_APP_MACOS_PROOF_TIMEOUT",
  "CURSOR_APP_MACOS_PROOF_OUTPUT", "CURSOR_APP_MACOS_LOOPBACK_UNAVAILABLE", "CURSOR_APP_MACOS_LOOPBACK_NOT_RESTRICTED",
  "CURSOR_APP_MACOS_IPV4_NOT_DENIED", "CURSOR_APP_MACOS_IPV6_NOT_DENIED", "CURSOR_APP_MACOS_PROOF_INHERITANCE",
  "CURSOR_APP_MACOS_PROOF_CLEANUP",
]);
function failure(code) { return Object.assign(new Error(code), { code }); }
function check(condition, code) { if (!condition) throw failure(code); }
function denied(value) { return value === "EPERM" || value === "EACCES"; }

export function makeMacosNetworkProfile(port) {
  check(Number.isInteger(port) && port > 0 && port <= 65535, "CURSOR_APP_MACOS_PROOF_ARGUMENTS");
  return `(version 1)\n(allow default)\n(deny network*)\n(allow network-outbound (remote tcp "localhost:${port}"))\n`;
}

// This worker never sends application data or resolves a hostname. A denied owned
// loopback port must prove enforcement before documentation-only external probes.
export async function probeNetworkLevel(allowedPort, blockedPort, depth, overrides = {}) {
  const { createConnection } = await import("node:net");
  const connect = overrides.connect ?? ((host, port) => new Promise((resolveResult) => {
    const socket = createConnection({ host, port });
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true; clearTimeout(timer); socket.destroy(); resolveResult(result);
    };
    const timer = setTimeout(() => finish("TIMEOUT"), 1000);
    socket.once("connect", () => { if (host !== "127.0.0.1") finish("CONNECTED"); });
    socket.once("end", () => finish("CONNECTED"));
    socket.once("error", (error) => finish(["EPERM", "EACCES"].includes(error.code) ? error.code : "OTHER"));
    socket.resume();
  }));
  const row = { depth, pid: process.pid, parentPid: process.ppid, allowedLoopback: "NOT_RUN",
    blockedLoopback: "NOT_RUN", ipv4: "NOT_RUN", ipv6: "NOT_RUN" };
  row.allowedLoopback = await connect("127.0.0.1", allowedPort);
  if (row.allowedLoopback !== "CONNECTED") return [row];
  row.blockedLoopback = await connect("127.0.0.1", blockedPort);
  if (!["EPERM", "EACCES"].includes(row.blockedLoopback)) return [row];
  row.ipv4 = await connect("198.51.100.1", 9);
  if (!["EPERM", "EACCES"].includes(row.ipv4)) return [row];
  row.ipv6 = await connect("2001:db8::1", 9);
  if (!["EPERM", "EACCES"].includes(row.ipv6) || depth === 2) return [row];
  let next;
  try {
    if (overrides.runChild) next = await overrides.runChild(depth + 1);
    else {
      const { execFileSync } = await import("node:child_process");
      next = JSON.parse(execFileSync(process.execPath,
        [...process.execArgv, String(allowedPort), String(blockedPort), String(depth + 1)],
        { env: process.env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 4096 }));
    }
  } catch { next = []; }
  return [row, ...(Array.isArray(next) ? next : [])];
}

export function assertMacosNetworkEvidence(rows, { pid, parentPid }) {
  check(Array.isArray(rows) && rows.length > 0 && rows.length <= 3, "CURSOR_APP_MACOS_PROOF_OUTPUT");
  for (const [index, row] of rows.entries()) {
    check(row && typeof row === "object" && row.depth === index && Number.isSafeInteger(row.pid) && row.pid > 0
      && row.parentPid === (index ? rows[index - 1].pid : parentPid), "CURSOR_APP_MACOS_PROOF_INHERITANCE");
    check(row.allowedLoopback === "CONNECTED", "CURSOR_APP_MACOS_LOOPBACK_UNAVAILABLE");
    check(denied(row.blockedLoopback), "CURSOR_APP_MACOS_LOOPBACK_NOT_RESTRICTED");
    check(denied(row.ipv4), "CURSOR_APP_MACOS_IPV4_NOT_DENIED");
    check(denied(row.ipv6), "CURSOR_APP_MACOS_IPV6_NOT_DENIED");
  }
  check(rows.length === 3 && rows[0].pid === pid && new Set(rows.map((row) => row.pid)).size === 3,
    "CURSOR_APP_MACOS_PROOF_INHERITANCE");
  return { allowedLoopback: true, otherLoopbackDenied: true, externalIpv4Denied: true,
    externalIpv6Denied: true, inheritedChild: true, inheritedGrandchild: true };
}

function publicReport(platform, error, evidence) {
  const failed = error !== undefined || !evidence;
  const report = { schemaVersion: 1, kind: "network-isolation-proof", scope: "sandbox-exec-network-only",
    platform: ["darwin", "linux", "win32"].includes(platform) ? platform : "other",
    status: failed ? "FAIL" : "PASS", appStarted: false, nativeAcceptance: false };
  if (failed) report.errorCode = codes.has(error?.code) ? error.code : "CURSOR_APP_MACOS_PROOF_FAILED";
  else report.evidence = evidence;
  return report;
}

export async function executeMacosSandbox({ args, env, cwd, signal }, spawnProcess = spawn) {
  return new Promise((resolveResult, reject) => {
    let child, stdout = "", error, timer;
    const stop = (code) => {
      error ??= failure(code);
      if (child?.pid && child.exitCode === null && child.signalCode === null) {
        try { process.kill(-child.pid, "SIGKILL"); } catch (caught) {
          if (caught.code !== "ESRCH") error = failure("CURSOR_APP_MACOS_PROOF_CLEANUP");
        }
      }
    };
    const abort = () => stop("CURSOR_APP_MACOS_PROOF_TIMEOUT");
    if (signal?.aborted) { reject(failure("CURSOR_APP_MACOS_PROOF_TIMEOUT")); return; }
    try {
      child = spawnProcess("/usr/bin/sandbox-exec", args, { env, cwd, detached: true, stdio: ["ignore", "pipe", "ignore"] });
    } catch { reject(failure("CURSOR_APP_MACOS_SANDBOX_EXEC_FAILED")); return; }
    signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => stop("CURSOR_APP_MACOS_PROOF_TIMEOUT"), 20_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (stdout.length + chunk.length > 4096) stop("CURSOR_APP_MACOS_PROOF_OUTPUT");
      else stdout += chunk;
    });
    child.once("error", () => { error = failure("CURSOR_APP_MACOS_SANDBOX_EXEC_FAILED"); });
    child.once("close", (code) => {
      clearTimeout(timer); signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else if (code !== 0) reject(failure("CURSOR_APP_MACOS_SANDBOX_EXEC_FAILED"));
      else resolveResult({ stdout, pid: child.pid });
    });
  });
}

export async function runMacosIsolationProof({ platform = process.platform, execute = executeMacosSandbox, signal } = {}) {
  let root, error, evidence;
  const fixtures = [], sockets = new Set();
  try {
    check(platform === "darwin", "CURSOR_APP_MACOS_PROOF_PLATFORM");
    check(!signal?.aborted, "CURSOR_APP_MACOS_PROOF_TIMEOUT");
    root = await mkdtemp(join(tmpdir(), "memorax-cursor-network-proof-"));
    for (let index = 0; index < 2; index++) {
      const fixture = { count: 0 };
      fixture.server = createServer((socket) => {
        fixture.count++; sockets.add(socket); socket.once("close", () => sockets.delete(socket)); socket.end();
      });
      fixtures.push(fixture);
      await new Promise((resolveListen, reject) => {
        fixture.server.once("error", reject);
        fixture.server.listen(0, "127.0.0.1", resolveListen);
      });
      fixture.port = fixture.server.address().port;
    }
    const [allowed, blocked] = fixtures;
    for (const fixture of fixtures) {
      await new Promise((resolveConnect, reject) => {
        const socket = createConnection({ host: "127.0.0.1", port: fixture.port });
        const timer = setTimeout(() => { socket.destroy(); reject(failure("CURSOR_APP_MACOS_PROOF_FIXTURE")); }, 1000);
        socket.once("end", () => { clearTimeout(timer); socket.destroy(); resolveConnect(); });
        socket.once("error", () => { clearTimeout(timer); reject(failure("CURSOR_APP_MACOS_PROOF_FIXTURE")); });
        socket.resume();
      });
    }
    allowed.count = 0; blocked.count = 0;
    const source = `const probe = ${probeNetworkLevel.toString()};\nconsole.log(JSON.stringify(await probe(...process.argv.slice(1).map(Number))));`;
    const result = await execute({ args: ["-p", makeMacosNetworkProfile(allowed.port), process.execPath,
      "--input-type=module", "-e", source, String(allowed.port), String(blocked.port), "0"], cwd: root,
    env: { PATH: "/usr/bin:/bin", HOME: root, CFFIXED_USER_HOME: root, TMPDIR: root, TMP: root, TEMP: root,
      LANG: "C", LC_ALL: "C" }, signal });
    check(!signal?.aborted, "CURSOR_APP_MACOS_PROOF_TIMEOUT");
    let rows;
    try { rows = JSON.parse(result.stdout); } catch { throw failure("CURSOR_APP_MACOS_PROOF_OUTPUT"); }
    evidence = assertMacosNetworkEvidence(rows, { pid: result.pid, parentPid: process.pid });
    check(allowed.count === 3 && blocked.count === 0, "CURSOR_APP_MACOS_PROOF_FIXTURE");
  } catch (caught) { error = caught; }
  finally {
    for (const socket of sockets) socket.destroy();
    for (const { server } of fixtures) {
      try { if (server.listening) await new Promise((done) => server.close(done)); }
      catch { error = failure("CURSOR_APP_MACOS_PROOF_CLEANUP"); }
    }
    if (root) await rm(root, { recursive: true, force: true }).catch(() => { error = failure("CURSOR_APP_MACOS_PROOF_CLEANUP"); });
  }
  return publicReport(platform, error, evidence);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort); process.once("SIGTERM", abort);
  const report = process.argv.length === 2
    ? await runMacosIsolationProof({ signal: controller.signal })
    : publicReport(process.platform, failure("CURSOR_APP_MACOS_PROOF_ARGUMENTS"));
  process.removeListener("SIGINT", abort); process.removeListener("SIGTERM", abort);
  console.log(JSON.stringify(report));
  if (report.status !== "PASS") process.exitCode = 1;
}
