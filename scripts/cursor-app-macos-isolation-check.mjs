import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const codes = new Set([
  "CURSOR_APP_MACOS_PROOF_ARGUMENTS", "CURSOR_APP_MACOS_PROOF_PLATFORM", "CURSOR_APP_MACOS_PROOF_FAILED",
  "CURSOR_APP_MACOS_PROOF_FIXTURE", "CURSOR_APP_MACOS_SANDBOX_EXEC_FAILED", "CURSOR_APP_MACOS_PROOF_TIMEOUT",
  "CURSOR_APP_MACOS_PROOF_OUTPUT", "CURSOR_APP_MACOS_LOOPBACK_UNAVAILABLE", "CURSOR_APP_MACOS_LOOPBACK_NOT_RESTRICTED",
  "CURSOR_APP_MACOS_LISTENER_UNAVAILABLE", "CURSOR_APP_MACOS_LISTENER_NOT_RESTRICTED", "CURSOR_APP_MACOS_WILDCARD_OBSERVATION_INVALID",
  "CURSOR_APP_MACOS_UNIX_UNAVAILABLE", "CURSOR_APP_MACOS_UNIX_NOT_RESTRICTED",
  "CURSOR_APP_MACOS_REENTRY_NOT_RESTRICTED",
  "CURSOR_APP_MACOS_IPV4_NOT_DENIED", "CURSOR_APP_MACOS_IPV6_NOT_DENIED", "CURSOR_APP_MACOS_PROOF_INHERITANCE",
  "CURSOR_APP_MACOS_PROOF_CLEANUP",
]);
function failure(code) { return Object.assign(new Error(code), { code }); }
function check(condition, code) { if (!condition) throw failure(code); }
function denied(value) { return value === "EPERM" || value === "EACCES"; }
function wildcardObserved(value) { return value === "LISTENED" || denied(value); }
const networkGates = ["allowedLoopback", "blockedLoopback", "listenerIpv4", "listenerIpv6", "otherListenerIpv4", "otherListenerIpv6",
  "wildcardIpv4", "wildcardIpv6", "unixUserData", "unixTmp", "otherUnixConnect", "otherUnixBind", "sandboxReentry", "ipv4", "ipv6"];
const networkResults = new Set(["CONNECTED", "LISTENED", "EPERM", "EACCES", "REENTRY_DENIED", "TIMEOUT", "OTHER", "NOT_RUN", "EADDRINUSE", "EADDRNOTAVAIL"]);

export function projectMacosNetworkDiagnostic(input) {
  if (!input || ![0, 1, 2].includes(input.depth) || !networkGates.includes(input.failedGate) || !networkResults.has(input.result)) return undefined;
  return { depth: input.depth, failedGate: input.failedGate, result: input.result };
}
function networkDiagnostic(rows) {
  if (!Array.isArray(rows) || rows.length > 3) return undefined;
  for (const [depth, row] of rows.entries()) {
    if (!row || row.depth !== depth) return undefined;
    for (const failedGate of networkGates) {
      const result = row[failedGate];
      const passed = failedGate === "allowedLoopback" ? result === "CONNECTED"
        : ["listenerIpv4", "listenerIpv6", "unixUserData", "unixTmp"].includes(failedGate) ? result === "LISTENED"
          : failedGate.startsWith("wildcard") ? wildcardObserved(result)
            : failedGate === "sandboxReentry" ? result === "REENTRY_DENIED" || denied(result) : denied(result);
      if (!passed) return projectMacosNetworkDiagnostic({ depth, failedGate,
        result: networkResults.has(result) ? result : result === undefined ? "NOT_RUN" : "OTHER" });
    }
  }
}

export function makeMacosNetworkProfile(outboundPorts, listenPorts = [], unixDirectories = []) {
  const outbound = Array.isArray(outboundPorts) ? [...outboundPorts] : [outboundPorts];
  check(Array.isArray(listenPorts), "CURSOR_APP_MACOS_PROOF_ARGUMENTS");
  const listeners = [...listenPorts];
  for (const ports of [outbound, listeners]) {
    check(ports.length <= 8 && new Set(ports).size === ports.length
      && ports.every((port) => Number.isInteger(port) && port > 0 && port <= 65535), "CURSOR_APP_MACOS_PROOF_ARGUMENTS");
  }
  check(outbound.length > 0, "CURSOR_APP_MACOS_PROOF_ARGUMENTS");
  check(Array.isArray(unixDirectories) && unixDirectories.length <= 2
    && new Set(unixDirectories).size === unixDirectories.length
    && [...unixDirectories].every((directory) => typeof directory === "string" && !directory.endsWith("/")
      && posix.isAbsolute(directory) && posix.normalize(directory) === directory
      && !/[\x00-\x1f\x7f]/.test(directory)), "CURSOR_APP_MACOS_PROOF_ARGUMENTS");
  return `(version 1)\n(allow default)\n(deny network*)\n`
    + outbound.map((port) => `(allow network-outbound (remote tcp "localhost:${port}"))\n`).join("")
    // SBPL's local localhost filter also permits wildcard binds at these ports.
    + listeners.map((port) => `(allow network-bind (local tcp "localhost:${port}"))\n`
      + `(allow network-inbound (local tcp "localhost:${port}"))\n`).join("")
    // Apple's container.sb uses subpath filters for private Unix-domain IPC.
    + unixDirectories.map((directory) => `(allow network-bind network-inbound network-outbound (subpath ${JSON.stringify(directory)}))\n`).join("");
}

// Only owned loopback fixtures exchange synthetic data. All loopback and bind
// gates, reentry and wildcard observations must complete before external connect-only probes.
export async function probeNetworkLevel(allowedPort, blockedPort, listenPort, blockedListenPort, depth, overrides = {}) {
  const { createConnection, createServer } = await import("node:net");
  const { unixPaths } = overrides;
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
  const connectUnix = overrides.connectUnix ?? ((path) => new Promise((resolveResult) => {
    const socket = createConnection({ path });
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true; clearTimeout(timer); socket.destroy(); resolveResult(result);
    };
    const timer = setTimeout(() => finish("TIMEOUT"), 1000);
    socket.once("connect", () => finish("CONNECTED"));
    socket.once("error", (error) => finish(["EPERM", "EACCES"].includes(error.code) ? error.code : "OTHER"));
  }));
  const bindSocket = (host, port, exchange) => new Promise((resolveResult) => {
    const sockets = new Set();
    let settled = false;
    const server = createServer((socket) => {
      sockets.add(socket); socket.once("close", () => sockets.delete(socket));
      socket.once("error", () => finish("OTHER"));
      socket.end("cursor-network-proof");
    });
    const finish = (result) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      for (const socket of sockets) socket.destroy();
      server.close((error) => resolveResult(error && error.code !== "ERR_SERVER_NOT_RUNNING" ? "OTHER" : result));
    };
    const timer = setTimeout(() => finish("TIMEOUT"), 1000);
    server.once("error", (error) => finish(["EPERM", "EACCES", "EADDRINUSE", "EADDRNOTAVAIL"].includes(error.code) ? error.code : "OTHER"));
    server.once("listening", () => {
      if (!exchange) { finish("LISTENED"); return; }
      const socket = createConnection(port === undefined ? { path: host } : { host, port });
      sockets.add(socket); socket.once("close", () => sockets.delete(socket));
      let received = "";
      socket.setEncoding("utf8");
      socket.on("data", (data) => { received += data; if (received.length > 64) finish("OTHER"); });
      socket.once("end", () => finish(received === "cursor-network-proof" ? "LISTENED" : "OTHER"));
      socket.once("error", (error) => finish(["EPERM", "EACCES"].includes(error.code) ? error.code : "OTHER"));
    });
    try { server.listen(port === undefined ? host : { host, port, ipv6Only: host === "::1" || host === "::" }); }
    catch { finish("OTHER"); }
  });
  const bind = overrides.bind ?? bindSocket;
  const bindUnix = overrides.bindUnix ?? ((path, exchange) => bindSocket(path, undefined, exchange));
  const sandboxReentry = async () => {
    const { spawnSync } = await import("node:child_process");
    const source = `const { createConnection } = await import("node:net");
      const socket = createConnection({ host: "127.0.0.1", port: Number(process.argv[1]) });
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true; clearTimeout(timer); socket.destroy(); console.log(result);
      };
      const timer = setTimeout(() => finish("TIMEOUT"), 1000);
      socket.once("connect", () => finish("CONNECTED"));
      socket.once("error", (error) => finish(["EPERM", "EACCES"].includes(error.code) ? error.code : "OTHER"));`;
    let result;
    try {
      result = await (overrides.sandboxReentry ?? spawnSync)("/usr/bin/sandbox-exec",
        ["-p", "(version 1)\n(allow default)\n", process.execPath, "--input-type=module", "-e", source, String(blockedPort)],
        { env: process.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 2500, killSignal: "SIGKILL", maxBuffer: 4096 });
    } catch { return "OTHER"; }
    if (result?.error) return result.error.code === "ETIMEDOUT" ? "TIMEOUT" : "OTHER";
    if (result?.signal != null || !Number.isInteger(result?.status)) return "OTHER";
    if (result.status === 0 && result.stderr === "") {
      return ["CONNECTED", "EPERM", "EACCES", "TIMEOUT", "OTHER"].find((value) => result.stdout === value + "\n") ?? "OTHER";
    }
    if (result.status > 0 && result.status <= 255 && result.stdout === "" && typeof result.stderr === "string"
      && /^sandbox-exec: sandbox_(?:apply|init): (?:Operation not permitted|EPERM)\n$/.test(result.stderr)) return "REENTRY_DENIED";
    return "OTHER";
  };
  const row = { depth, pid: process.pid, parentPid: process.ppid, allowedLoopback: "NOT_RUN",
    listenerIpv4: "NOT_RUN", listenerIpv6: "NOT_RUN", otherListenerIpv4: "NOT_RUN", otherListenerIpv6: "NOT_RUN",
    wildcardIpv4: "NOT_RUN", wildcardIpv6: "NOT_RUN",
    unixUserData: "NOT_RUN", unixTmp: "NOT_RUN", otherUnixConnect: "NOT_RUN", otherUnixBind: "NOT_RUN",
    blockedLoopback: "NOT_RUN", sandboxReentry: "NOT_RUN", ipv4: "NOT_RUN", ipv6: "NOT_RUN" };
  row.allowedLoopback = await connect("127.0.0.1", allowedPort);
  if (row.allowedLoopback !== "CONNECTED") return [row];
  row.blockedLoopback = await connect("127.0.0.1", blockedPort);
  if (!["EPERM", "EACCES"].includes(row.blockedLoopback)) return [row];
  for (const [field, host, port, exchange] of [
    ["listenerIpv4", "127.0.0.1", listenPort, true], ["listenerIpv6", "::1", listenPort, true],
    ["otherListenerIpv4", "127.0.0.1", blockedListenPort, false], ["otherListenerIpv6", "::1", blockedListenPort, false],
    ["wildcardIpv4", "0.0.0.0", listenPort, false], ["wildcardIpv6", "::", listenPort, false],
  ]) {
    row[field] = await bind(host, port, exchange);
    const accepted = exchange ? row[field] === "LISTENED"
      : field.startsWith("wildcard") ? ["LISTENED", "EPERM", "EACCES"].includes(row[field]) : ["EPERM", "EACCES"].includes(row[field]);
    if (!accepted) return [row];
  }
  if (!unixPaths) return [row];
  for (const [field, path] of [["unixUserData", unixPaths.userData], ["unixTmp", unixPaths.tmp]]) {
    row[field] = await bindUnix(path, true);
    if (row[field] !== "LISTENED") return [row];
  }
  row.otherUnixConnect = await connectUnix(unixPaths.blockedConnect);
  if (!["EPERM", "EACCES"].includes(row.otherUnixConnect)) return [row];
  row.otherUnixBind = await bindUnix(unixPaths.blockedBind, false);
  if (!["EPERM", "EACCES"].includes(row.otherUnixBind)) return [row];
  row.sandboxReentry = await sandboxReentry();
  if (!["REENTRY_DENIED", "EPERM", "EACCES"].includes(row.sandboxReentry)) return [row];
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
        [...process.execArgv, String(allowedPort), String(blockedPort), String(listenPort), String(blockedListenPort),
          JSON.stringify(unixPaths), String(depth + 1)],
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
    check(row.listenerIpv4 === "LISTENED" && row.listenerIpv6 === "LISTENED", "CURSOR_APP_MACOS_LISTENER_UNAVAILABLE");
    check(denied(row.otherListenerIpv4) && denied(row.otherListenerIpv6), "CURSOR_APP_MACOS_LISTENER_NOT_RESTRICTED");
    check(wildcardObserved(row.wildcardIpv4) && wildcardObserved(row.wildcardIpv6), "CURSOR_APP_MACOS_WILDCARD_OBSERVATION_INVALID");
    check(row.unixUserData === "LISTENED" && row.unixTmp === "LISTENED", "CURSOR_APP_MACOS_UNIX_UNAVAILABLE");
    check(denied(row.otherUnixConnect) && denied(row.otherUnixBind), "CURSOR_APP_MACOS_UNIX_NOT_RESTRICTED");
    check(row.sandboxReentry === "REENTRY_DENIED" || denied(row.sandboxReentry), "CURSOR_APP_MACOS_REENTRY_NOT_RESTRICTED");
    check(denied(row.ipv4), "CURSOR_APP_MACOS_IPV4_NOT_DENIED");
    check(denied(row.ipv6), "CURSOR_APP_MACOS_IPV6_NOT_DENIED");
  }
  check(rows.length === 3 && rows[0].pid === pid && new Set(rows.map((row) => row.pid)).size === 3,
    "CURSOR_APP_MACOS_PROOF_INHERITANCE");
  return { allowedLoopback: true, otherLoopbackDenied: true, externalIpv4Denied: true,
    allowedListenerIpv4: true, allowedListenerIpv6: true, otherListenerPortsDenied: true,
    ownedUnixIpc: true, otherUnixPathsDenied: true, sandboxReentryRestricted: true,
    externalIpv6Denied: true, inheritedChild: true, inheritedGrandchild: true };
}

function publicReport(platform, error, evidence, rows) {
  const failed = error !== undefined || !evidence;
  const report = { schemaVersion: 1, kind: "network-isolation-proof", scope: "sandbox-exec-network-only",
    inboundAddressIsolation: "not-enforced",
    platform: ["darwin", "linux", "win32"].includes(platform) ? platform : "other",
    status: failed ? "FAIL" : "PASS", appStarted: false, nativeAcceptance: false };
  if (failed) {
    report.errorCode = codes.has(error?.code) ? error.code : "CURSOR_APP_MACOS_PROOF_FAILED";
    const diagnostic = networkDiagnostic(rows);
    if (diagnostic) report.diagnostic = diagnostic;
  }
  else {
    report.evidence = evidence;
    report.observations = { wildcardListeners: rows.map((row) => ({ depth: row.depth,
      ipv4: row.wildcardIpv4, ipv6: row.wildcardIpv6 })) };
  }
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
  let root, error, evidence, rows;
  const fixtures = [], sockets = new Set();
  try {
    check(platform === "darwin", "CURSOR_APP_MACOS_PROOF_PLATFORM");
    check(!signal?.aborted, "CURSOR_APP_MACOS_PROOF_TIMEOUT");
    // macOS Unix socket paths are short; do not nest under a runner's long TMPDIR.
    root = await realpath(await mkdtemp(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "mci-proof-")));
    for (let index = 0; index < 4; index++) {
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
    const [allowed, blocked, listener, blockedListener] = fixtures;
    for (const fixture of fixtures) {
      await new Promise((resolveConnect, reject) => {
        const socket = createConnection({ host: "127.0.0.1", port: fixture.port });
        const timer = setTimeout(() => { socket.destroy(); reject(failure("CURSOR_APP_MACOS_PROOF_FIXTURE")); }, 1000);
        socket.once("end", () => { clearTimeout(timer); socket.destroy(); resolveConnect(); });
        socket.once("error", () => { clearTimeout(timer); reject(failure("CURSOR_APP_MACOS_PROOF_FIXTURE")); });
        socket.resume();
      });
    }
    for (const fixture of fixtures) fixture.count = 0;
    for (const fixture of [listener, blockedListener]) await new Promise((done, reject) => {
      fixture.server.close((error) => error ? reject(error) : done());
    });
    const unixDirectories = [join(root, "app-data"), join(root, "tmp")];
    for (const directory of [...unixDirectories, ...unixDirectories.map((path) => `${path}-other`)]) {
      await mkdir(directory, { mode: 0o700 });
    }
    const unixPaths = { userData: join(unixDirectories[0], "proof.sock"), tmp: join(unixDirectories[1], "proof.sock"),
      blockedConnect: join(`${unixDirectories[0]}-other`, "proof.sock"), blockedBind: join(`${unixDirectories[1]}-other`, "proof.sock") };
    const unixFixtures = [];
    for (const path of [unixPaths.blockedConnect, unixPaths.blockedBind]) {
      const fixture = { count: 0 };
      fixture.server = createServer((socket) => {
        fixture.count++; sockets.add(socket); socket.once("close", () => sockets.delete(socket)); socket.end();
      });
      fixtures.push(fixture); unixFixtures.push(fixture);
      await new Promise((done, reject) => { fixture.server.once("error", reject); fixture.server.listen(path, done); });
      await new Promise((done, reject) => {
        const socket = createConnection({ path });
        const timer = setTimeout(() => { socket.destroy(); reject(failure("CURSOR_APP_MACOS_PROOF_FIXTURE")); }, 1000);
        socket.once("end", () => { clearTimeout(timer); socket.destroy(); done(); });
        socket.once("error", (error) => { clearTimeout(timer); reject(error); }); socket.resume();
      });
      fixture.count = 0;
    }
    await new Promise((done, reject) => unixFixtures[1].server.close((error) => error ? reject(error) : done()));
    const source = `const probe = ${probeNetworkLevel.toString()};\n`
      + `console.log(JSON.stringify(await probe(...process.argv.slice(1,5).map(Number),Number(process.argv[6]),{unixPaths:JSON.parse(process.argv[5])})));`;
    const result = await execute({ args: ["-p", makeMacosNetworkProfile([allowed.port, listener.port], [listener.port], unixDirectories), process.execPath,
      "--input-type=module", "-e", source, String(allowed.port), String(blocked.port), String(listener.port), String(blockedListener.port),
      JSON.stringify(unixPaths), "0"], cwd: root,
    env: { PATH: "/usr/bin:/bin", HOME: root, CFFIXED_USER_HOME: root, TMPDIR: root, TMP: root, TEMP: root,
      LANG: "C", LC_ALL: "C" }, signal });
    check(!signal?.aborted, "CURSOR_APP_MACOS_PROOF_TIMEOUT");
    try { rows = JSON.parse(result.stdout); } catch { throw failure("CURSOR_APP_MACOS_PROOF_OUTPUT"); }
    evidence = assertMacosNetworkEvidence(rows, { pid: result.pid, parentPid: process.pid });
    check(allowed.count === 3 && blocked.count === 0 && unixFixtures[0].count === 0, "CURSOR_APP_MACOS_PROOF_FIXTURE");
  } catch (caught) { error = caught; }
  finally {
    for (const socket of sockets) socket.destroy();
    for (const { server } of fixtures) {
      try { if (server.listening) await new Promise((done) => server.close(done)); }
      catch { error = failure("CURSOR_APP_MACOS_PROOF_CLEANUP"); }
    }
    if (root) await rm(root, { recursive: true, force: true }).catch(() => { error = failure("CURSOR_APP_MACOS_PROOF_CLEANUP"); });
  }
  return publicReport(platform, error, evidence, rows);
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
