import { execFile } from "node:child_process";
import { createServer } from "node:net";
import { posix as path } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const argumentCode = "CURSOR_APP_MACOS_RUNTIME_ARGUMENTS";
const processCode = "CURSOR_APP_MACOS_PROCESS_AUDIT";
const listenerCode = "CURSOR_APP_MACOS_LISTENER_AUDIT";
function failure(code) { return Object.assign(new Error(code), { code }); }
function check(value, code = argumentCode) { if (!value) throw failure(code); }
function absolute(value) {
  check(typeof value === "string" && path.isAbsolute(value) && !/[\0\r\n]/.test(value));
  const result = path.normalize(value);
  check(result !== "/");
  return result.replace(/\/$/, "");
}
function validPort(port) { return Number.isInteger(port) && port > 0 && port <= 65535; }

export function macosRuntimePaths({ root, appPath, packageRoot, nodePath }) {
  root = absolute(root); appPath = absolute(appPath); packageRoot = absolute(packageRoot); nodePath = absolute(nodePath);
  check(appPath.endsWith(".app/Contents/MacOS/Cursor"));
  const appBundle = path.resolve(appPath, "../../.."), home = path.join(root, "home"), tmp = path.join(root, "tmp");
  const bins = [path.join(path.dirname(path.dirname(packageRoot)), ".bin"), path.dirname(nodePath), "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  check(bins.every((entry) => !entry.includes(":")));
  return { appBundle, resourcesPackage: path.join(appBundle, "Contents/Resources/app/package.json"), home, tmp,
    env: { HOME: home, USERPROFILE: home, CFFIXED_USER_HOME: home, ZDOTDIR: home, SHELL: "/bin/zsh",
      TMPDIR: tmp, TMP: tmp, TEMP: tmp, PATH: [...new Set(bins)].join(":") } };
}

export function sandboxInvocation(executable, args, profile) {
  executable = absolute(executable);
  check(Array.isArray(args) && args.every((arg) => typeof arg === "string" && !arg.includes("\0"))
    && typeof profile === "string" && profile.length > 0 && profile.length <= 65536 && !profile.includes("\0"));
  return { file: "/usr/bin/sandbox-exec", args: ["-p", profile, executable, ...args] };
}

function pathPattern(value, directory) {
  const escaped = absolute(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[\\s\"'=])${escaped}(?=$|[\\s\"'${directory ? "/" : ""}])`);
}

export function hasOwnedMacosProcesses(output, { appBundle, packageRoot, stateHome, marker, includeBackend = true,
  selfPid = process.pid, observedPids = new Set() }) {
  check(typeof output === "string" && output.length <= 4 * 1024 * 1024 && output.trim(), processCode);
  check(typeof includeBackend === "boolean" && Number.isSafeInteger(selfPid) && selfPid > 0);
  check(observedPids instanceof Set && [...observedPids].every((pid) => Number.isSafeInteger(pid) && pid > 0));
  const patterns = [pathPattern(appBundle, true), pathPattern(stateHome, true)];
  if (includeBackend) patterns.push(pathPattern(packageRoot, true));
  if (marker !== undefined) patterns.push(pathPattern(marker, false));
  let owned = false;
  for (const line of output.trim().split(/\r?\n/)) {
    const row = line.match(/^\s*(\d+)[ \t]+(.+)$/);
    check(row && Number.isSafeInteger(Number(row[1])), processCode);
    if (Number(row[1]) !== selfPid && (observedPids.has(Number(row[1])) || patterns.some((pattern) => pattern.test(row[2])))) owned = true;
  }
  return owned;
}

export async function auditMacosProcesses(options, execute = exec) {
  let output;
  try {
    ({ stdout: output } = await execute("/bin/ps", ["-axww", "-o", "pid=,command="], {
      encoding: "utf8", timeout: 5000, maxBuffer: 4 * 1024 * 1024,
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
    }));
  } catch { throw failure(processCode); }
  return hasOwnedMacosProcesses(output, options);
}

export async function captureMacosDescendants(appPid, execute = exec) {
  check(Number.isSafeInteger(appPid) && appPid > 1 && appPid !== process.pid);
  let output;
  try {
    ({ stdout: output } = await execute("/bin/ps", ["-ax", "-o", "pid=,ppid="], {
      encoding: "utf8", timeout: 5000, maxBuffer: 4 * 1024 * 1024,
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
    }));
  } catch { throw failure(processCode); }
  check(typeof output === "string" && output.length <= 4 * 1024 * 1024 && output.trim(), processCode);
  const rows = output.trim().split(/\r?\n/).map((line) => {
    const row = line.match(/^\s*(\d+)\s+(\d+)\s*$/);
    check(row && [row[1], row[2]].every((value) => Number.isSafeInteger(Number(value))), processCode);
    return { pid: Number(row[1]), ppid: Number(row[2]) };
  });
  check(new Set(rows.map((row) => row.pid)).size === rows.length && rows.some((row) => row.pid === appPid), processCode);
  const owned = new Set([appPid]);
  let previous = 0;
  while (previous !== owned.size) {
    previous = owned.size;
    for (const row of rows) if (row.pid !== process.pid && owned.has(row.ppid)) owned.add(row.pid);
  }
  return owned;
}

export async function auditMacosListeners({ appPid, appBundle, packageRoot, stateHome, backendPort, debugPort,
  selfPid = process.pid }, execute = exec) {
  check(Number.isSafeInteger(selfPid) && selfPid > 0 && Number.isSafeInteger(appPid) && appPid > 1 && appPid !== selfPid);
  check(validPort(backendPort) && validPort(debugPort) && backendPort !== debugPort);
  const appPattern = pathPattern(appBundle, true);
  const patterns = [appPattern, pathPattern(packageRoot, true), pathPattern(stateHome, true)];
  const options = { encoding: "utf8", timeout: 5000, maxBuffer: 4 * 1024 * 1024,
    env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" } };
  const inspect = async () => {
    const { stdout, stderr } = await execute("/bin/ps", ["-axww", "-o", "pid=,ppid=,lstart=,command="], options);
    check(!stderr && typeof stdout === "string" && stdout.length <= options.maxBuffer && stdout.trim(), listenerCode);
    const rows = new Map();
    for (const line of stdout.trim().split(/\r?\n/)) {
      const row = line.match(/^\s*(\d+)\s+(\d+)\s+((?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/);
      check(row && [row[1], row[2]].every((value) => Number.isSafeInteger(Number(value)))
        && !rows.has(Number(row[1])), listenerCode);
      rows.set(Number(row[1]), { ppid: Number(row[2]), started: row[3].replace(/\s+/g, " "), command: row[4] });
    }
    return rows;
  };
  try {
    const before = await inspect();
    check(before.has(appPid) && appPattern.test(before.get(appPid).command), listenerCode);
    const owned = new Set([appPid]);
    for (const [pid, row] of before) if (pid > 1 && pid !== selfPid && patterns.some((pattern) => pattern.test(row.command))) owned.add(pid);
    let previous = 0;
    while (previous !== owned.size) {
      previous = owned.size;
      for (const [pid, row] of before) if (pid > 1 && pid !== selfPid && owned.has(row.ppid)) owned.add(pid);
    }
    const { stdout, stderr } = await execute("/usr/sbin/lsof", ["-nP", "-a", "-p", [...owned].sort((a, b) => a - b).join(","),
      "-iTCP", "-sTCP:LISTEN", "-F0pftPnT", "-T", "s"], options);
    check(!stderr && typeof stdout === "string" && stdout.length <= options.maxBuffer && stdout.endsWith("\0\n"), listenerCode);
    const seenProcesses = new Set(), listeners = new Set(), ports = new Set(), descriptors = new Set();
    let pid;
    for (const line of stdout.slice(0, -1).split("\n")) {
      check(line.endsWith("\0"), listenerCode);
      const fields = line.slice(0, -1).split("\0");
      if (/^p\d+$/.test(fields[0])) {
        pid = Number(fields[0].slice(1));
        check(fields.length === 1 && owned.has(pid) && !seenProcesses.has(pid), listenerCode);
        seenProcesses.add(pid);
        continue;
      }
      const values = new Map(fields.map((field) => [field[0], field.slice(1)]));
      check(pid && fields.length === 5 && values.size === 5 && /^f\d+$/.test(fields[0])
        && ["IPv4", "IPv6"].includes(values.get("t")) && values.get("P") === "TCP"
        && values.get("T") === "ST=LISTEN" && !descriptors.has(`${pid}:${values.get("f")}`), listenerCode);
      const address = values.get("n")?.match(/^(127\.0\.0\.1|\[::1\]):(\d+)$/);
      check(address && [String(backendPort), String(debugPort)].includes(address[2])
        && values.get("t") === (address[1] === "127.0.0.1" ? "IPv4" : "IPv6"), listenerCode);
      descriptors.add(`${pid}:${values.get("f")}`); listeners.add(pid); ports.add(Number(address[2]));
    }
    check(ports.has(backendPort) && ports.has(debugPort), listenerCode);
    const after = await inspect();
    // Only observed listeners and the App root must retain their process identity.
    for (const owner of new Set([appPid, ...listeners])) {
      check(after.has(owner) && after.get(owner).started === before.get(owner).started
        && after.get(owner).command === before.get(owner).command, listenerCode);
    }
    return true;
  } catch { throw failure(listenerCode); }
}

export function createDevToolsEndpointReader(port) {
  check(validPort(port));
  let pending = "", endpoint, error;
  return {
    push(chunk) {
      if (error) throw error;
      try {
        check(typeof chunk === "string" || Buffer.isBuffer(chunk));
        pending += chunk.toString();
        const lines = pending.split("\n"); pending = lines.pop();
        check(pending.length <= 65536, "CURSOR_APP_MACOS_DEBUG_ENDPOINT");
        for (const text of lines) {
          const line = text.trim();
          if (!line.startsWith("DevTools listening on ")) continue;
          const value = line.slice("DevTools listening on ".length);
          const match = value.match(/^ws:\/\/127\.0\.0\.1:(\d+)\/devtools\/browser\/([0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12})$/);
          check(match && match[1] === String(port), "CURSOR_APP_MACOS_DEBUG_ENDPOINT");
          check(!endpoint || endpoint === value, "CURSOR_APP_MACOS_DEBUG_ENDPOINT_AMBIGUOUS");
          endpoint = value;
        }
      } catch (caught) { error = caught; throw error; }
    },
    get() { if (error) throw error; return endpoint; },
  };
}

// The port is released before return; a later bind collision must fail the launch.
export async function reserveFreePort(makeServer = createServer) {
  let server;
  try { server = makeServer(); } catch { throw failure("CURSOR_APP_MACOS_PORT_RESERVATION"); }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, port) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) reject(failure("CURSOR_APP_MACOS_PORT_RESERVATION")); else resolve(port);
    };
    const timer = setTimeout(() => {
      try { server.close(() => {}); } catch {}
      finish(true);
    }, 2000);
    try {
      server.once("error", () => finish(true));
      server.listen(0, "127.0.0.1", () => {
        try {
          const port = server.address()?.port;
          server.close((error) => finish(error || !validPort(port), port));
        } catch { finish(true); }
      });
    } catch { finish(true); }
  });
}
