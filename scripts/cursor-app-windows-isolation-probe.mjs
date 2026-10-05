import { spawn } from "node:child_process";
import { createSocket } from "node:dgram";
import { lstat, readFile, rename, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const portKeys = ["allowed4", "denied4", "allowed6", "denied6"];
const checks = [
  { key: "allowed4", host: "127.0.0.1", port: "allowed4", allowed: true },
  { key: "denied4", host: "127.0.0.1", port: "denied4" },
  { key: "allowed6", host: "::1", port: "allowed6", allowed: true },
  { key: "denied6", host: "::1", port: "denied6" },
  { key: "mappedTcp", host: "::ffff:127.0.0.1", port: "allowed4", allowed: true },
  { key: "mappedDeniedTcp", host: "::ffff:127.0.0.1", port: "denied4" },
  { key: "udp4", host: "127.0.0.1", port: "allowed4", udp: true },
  { key: "udp6", host: "::1", port: "allowed6", udp: true },
  { key: "mappedUdp", host: "::ffff:127.0.0.1", port: "allowed4", udp: true },
];
const keys = checks.map(({ key }) => key);
const allowedKeys = checks.filter(({ allowed }) => allowed).map(({ key }) => key);
const deniedKeys = checks.filter(({ allowed }) => !allowed).map(({ key }) => key);
const outcomes = new Set(["CONNECTED", "ACCESS_DENIED", "REFUSED", "TIMEOUT", "OTHER", "INVALID_RESPONSE"]);
const request = "cursor-loopback-proof\n", response = "fixture-ok\n";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function parseProbeConfig(input) {
  if (!input || typeof input !== "object" || Object.keys(input).sort().join() !== [...portKeys].sort().join()
    || portKeys.some((key) => !Number.isInteger(input[key]) || input[key] < 1 || input[key] > 65535)
    || input.allowed4 === input.denied4 || input.allowed6 === input.denied6) throw new Error("PROBE_CONFIG_INVALID");
  return Object.fromEntries(portKeys.map((key) => [key, input[key]]));
}

export function classifyConnectionError(error) {
  if (error?.code === "EACCES") return "ACCESS_DENIED";
  if (error?.code === "ECONNREFUSED") return "REFUSED";
  if (error?.code === "ETIMEDOUT") return "TIMEOUT";
  return "OTHER";
}

export async function connectToFixture(host, port) {
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(host) || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("PROBE_CONFIG_INVALID");
  return new Promise((resolve) => {
    const socket = createConnection({ host, port, family: host.includes(":") ? 6 : 4 });
    let finished = false, received = "";
    const finish = (outcome) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(outcome);
    };
    const timer = setTimeout(() => finish("TIMEOUT"), 1500);
    socket.once("connect", () => socket.write(request));
    socket.on("data", (data) => {
      received += data.toString("utf8");
      if (received === response) finish("CONNECTED");
      else if (received.length >= response.length) finish("INVALID_RESPONSE");
    });
    socket.once("end", () => finish("INVALID_RESPONSE"));
    socket.once("error", (error) => finish(classifyConnectionError(error)));
  });
}

export async function sendToFixture(host, port) {
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(host) || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("PROBE_CONFIG_INVALID");
  return new Promise((resolve) => {
    const socket = createSocket(host.includes(":") ? "udp6" : "udp4");
    let finished = false;
    const finish = (outcome) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { socket.close(); } catch {}
      resolve(outcome);
    };
    const timer = setTimeout(() => finish("TIMEOUT"), 1500);
    socket.once("error", (error) => finish(classifyConnectionError(error)));
    socket.once("message", (data) => finish(data.toString("utf8") === response ? "CONNECTED" : "INVALID_RESPONSE"));
    socket.connect(port, host, () => {
      socket.send(request, (error) => { if (error) finish(classifyConnectionError(error)); });
    });
  });
}

async function checkFixtures(config) {
  const result = {};
  for (const check of checks) {
    const connect = check.udp ? sendToFixture : connectToFixture;
    result[check.key] = await connect(check.host, config[check.port]);
  }
  return result;
}

export function summarizeLevels(input, mode) {
  const invalid = { passed: false, errorCode: "CURSOR_APP_WINDOWS_PROBE_OUTPUT_INVALID", levelCount: 0,
    deniedAttempts: 0, observations: [] };
  if (!["baseline", "restricted"].includes(mode) || !Array.isArray(input) || input.length !== 3
    || input.some((entry, depth) => !entry || entry.depth !== depth
      || Object.keys(entry).sort().join() !== ["depth", ...keys].sort().join()
      || keys.some((key) => !outcomes.has(entry[key])))) return invalid;
  const observations = input.map((entry) => ({ depth: entry.depth,
    ...Object.fromEntries(keys.map((key) => [key, entry[key]])) }));
  let errorCode;
  if (mode === "baseline" && input.some((entry) => keys.some((key) => entry[key] !== "CONNECTED")))
    errorCode = "CURSOR_APP_WINDOWS_BASELINE_UNREACHABLE";
  else if (input.some((entry) => allowedKeys.some((key) => entry[key] !== "CONNECTED")))
    errorCode = "CURSOR_APP_WINDOWS_ALLOWED_LOOPBACK_FAILED";
  else if (mode === "restricted" && input.some((entry) => deniedKeys.some((key) => entry[key] === "CONNECTED")))
    errorCode = "CURSOR_APP_WINDOWS_LOOPBACK_NOT_RESTRICTED";
  else if (mode === "restricted" && input.some((entry) => deniedKeys.some((key) => entry[key] !== "ACCESS_DENIED")))
    errorCode = "CURSOR_APP_WINDOWS_DENIAL_UNPROVEN";
  return { passed: !errorCode, ...(errorCode ? { errorCode } : {}), levelCount: 3,
    deniedAttempts: mode === "restricted" ? deniedKeys.length * 3 : 0, observations };
}

async function readJson(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192) throw new Error("PROBE_FILE_INVALID");
  return JSON.parse(await readFile(path, "utf8"));
}

async function publish(path, value) {
  const temporary = `${path}.pending`;
  await writeFile(temporary, JSON.stringify(value), { flag: "wx" });
  await rename(temporary, path);
}

function createTcpFixture(sockets) {
  return createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
    socket.setTimeout(1500, () => socket.destroy());
    let received = "";
    socket.on("data", (data) => {
      received += data.toString("utf8");
      if (received === request) socket.end(response);
      else if (received.length >= request.length) socket.destroy();
    });
  });
}

function closeFixture(server) {
  return new Promise((resolve) => { try { server.close(resolve); } catch { resolve(); } });
}

export async function createFixturePair(host, sockets = new Set()) {
  if (!["127.0.0.1", "::1"].includes(host)) throw new Error("PROBE_CONFIG_INVALID");
  // A port selected for one protocol may be reserved for the other on Windows.
  // Select a jointly bound pair before publishing ports or installing policy.
  for (let attempt = 0; attempt < 12; attempt++) {
    const server = createTcpFixture(sockets);
    const datagram = createSocket({ type: host === "::1" ? "udp6" : "udp4", ipv6Only: host === "::1" });
    try {
      await new Promise((resolve, reject) => {
        datagram.once("error", reject);
        datagram.bind(0, host, resolve);
      });
      const port = datagram.address().port;
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen({ host, port, ipv6Only: true }, resolve);
      });
      datagram.on("message", (data, peer) => {
        if (data.toString("utf8") === request) datagram.send(response, peer.port, peer.address);
      });
      return { server, datagram, port };
    } catch (error) {
      await Promise.all([closeFixture(server), closeFixture(datagram)]);
      if (!["EACCES", "EADDRINUSE"].includes(error?.code)) throw error;
    }
  }
  throw new Error("PROBE_FIXTURE_PORT_UNAVAILABLE");
}

async function fixtures(configPath) {
  const servers = [], datagrams = [], sockets = new Set(), config = {};
  let stop;
  const stopped = new Promise((resolve) => { stop = resolve; });
  const deadline = setTimeout(stop, 180000);
  process.stdin.resume();
  process.stdin.once("data", stop);
  process.stdin.once("end", stop);
  try {
    for (const key of portKeys) {
      const host = key.endsWith("4") ? "127.0.0.1" : "::1";
      if (key.startsWith("allowed")) {
        const pair = await createFixturePair(host, sockets);
        servers.push(pair.server); datagrams.push(pair.datagram);
        config[key] = pair.port;
        continue;
      }
      const server = createTcpFixture(sockets);
      servers.push(server);
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen({ host, port: 0, ipv6Only: true }, resolve);
      });
      config[key] = server.address().port;
    }
    await publish(configPath, parseProbeConfig(config));
    await stopped;
  } finally {
    clearTimeout(deadline);
    for (const socket of sockets) socket.destroy();
    await Promise.all([...servers, ...datagrams].map(closeFixture));
    process.stdin.pause();
  }
}

async function runLevel(root, depth) {
  if (![0, 1, 2].includes(depth)) throw new Error("PROBE_DEPTH_INVALID");
  // Every worker has its own deadline, including a descendant whose parent exits.
  const deadline = setTimeout(() => process.exit(2), 30000);
  let child, childDone;
  try {
    const config = parseProbeConfig(await readJson(join(root, "config.json")));
    if (depth < 2) {
      child = spawn(process.execPath, [fileURLToPath(import.meta.url), "level", root, String(depth + 1)], {
        env: { ...process.env }, cwd: root, windowsHide: true, stdio: "ignore",
      });
      childDone = new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code) => code === 0 ? resolve() : reject(new Error("PROBE_CHILD_FAILED")));
      });
      childDone.catch(() => {});
    }
    await publish(join(root, `ready-${depth}.json`), { depth, pid: process.pid, parentPid: process.ppid });
    const until = Date.now() + 15000;
    while (true) {
      try {
        if ((await readJson(join(root, "start.json"))).start !== true) throw new Error("PROBE_START_INVALID");
        break;
      } catch (error) {
        if (error?.code !== "ENOENT" || Date.now() >= until) throw error;
        await delay(50);
      }
    }
    const result = { depth, ...await checkFixtures(config) };
    await publish(join(root, `result-${depth}.json`), result);
    if (childDone) await childDone;
  } finally {
    if (child && child.exitCode === null) {
      child.kill();
      await childDone.catch(() => {});
    }
    clearTimeout(deadline);
  }
}

async function main(args) {
  if (process.platform !== "win32") throw new Error("PROBE_PLATFORM_UNSUPPORTED");
  if (args[0] === "fixtures" && args.length === 2) return fixtures(args[1]);
  if (args[0] === "level" && args.length === 3) return runLevel(args[1], Number(args[2]));
  if (args[0] === "summarize" && args.length === 3) {
    const levels = [];
    for (let depth = 0; depth < 3; depth++) levels.push(await readJson(join(args[1], `result-${depth}.json`)));
    process.stdout.write(JSON.stringify(summarizeLevels(levels, args[2])));
    return;
  }
  if (args[0] === "control" && args.length === 2) {
    const config = parseProbeConfig(await readJson(args[1]));
    const results = await checkFixtures(config);
    process.stdout.write(JSON.stringify({ reachable: Object.values(results).every((value) => value === "CONNECTED") }));
    return;
  }
  throw new Error("PROBE_ARGUMENT_INVALID");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await main(process.argv.slice(2)); }
  catch { process.stderr.write("CURSOR_APP_WINDOWS_PROBE_FAILED\n"); process.exitCode = 1; }
}
