import { execFile } from "node:child_process";
import { createServer } from "node:net";
import { posix as path } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const argumentCode = "CURSOR_APP_MACOS_RUNTIME_ARGUMENTS";
const processCode = "CURSOR_APP_MACOS_PROCESS_AUDIT";
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

async function processSnapshot(args, execute) {
  try {
    const { stdout } = await execute("/bin/ps", args, {
      encoding: "utf8", timeout: 5000, maxBuffer: 4 * 1024 * 1024,
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
    });
    return stdout;
  } catch { throw failure(processCode); }
}

export async function auditMacosProcesses(options, execute = exec) {
  return hasOwnedMacosProcesses(await processSnapshot(["-axww", "-o", "pid=,command="], execute), options);
}

export async function captureMacosDescendants(appPid, execute = exec) {
  check(Number.isSafeInteger(appPid) && appPid > 1 && appPid !== process.pid);
  const output = await processSnapshot(["-ax", "-o", "pid=,ppid="], execute);
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
