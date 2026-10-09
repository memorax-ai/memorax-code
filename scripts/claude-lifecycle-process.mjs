import { execFile, spawn } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function startLifecycleCommand(command, args, {
  cwd, env, input = "", timeoutMs = 120_000, maxOutputBytes = 4 * 1024 * 1024, terminal = false,
} = {}) {
  const posix = process.platform !== "win32";
  const child = spawn(command, args, { cwd, env, windowsHide: true, detached: posix,
    stdio: ["pipe", "pipe", "pipe"] });
  const output = { stdout: "", stderr: "" }, sizes = { stdout: 0, stderr: 0 };
  let exited = false, closed = false, released = false, failure, cleanupFailure, cleaning, timer, cleanupDone;
  const cleanupSettled = new Promise((done) => { cleanupDone = done; });
  const exit = new Promise((done) => {
    child.once("error", (error) => { failure ??= error; exited = true; done(); });
    child.once("exit", (code, signal) => {
      exited = true;
      if (code !== 0) failure ??= Object.assign(new Error("INSTALL_COMMAND_FAILED"), { code, signal });
      done();
    });
  });
  child.once("close", () => { closed = true; });
  for (const name of ["stdout", "stderr"]) {
    child[name].setEncoding("utf8");
    child[name].on("data", (text) => {
      sizes[name] += Buffer.byteLength(text);
      if (sizes[name] <= maxOutputBytes) output[name] += text;
      else abort("INSTALL_COMMAND_OUTPUT_LIMIT");
    });
  }
  child.stdin.on("error", () => {});
  child.stdin.end(input);
  timer = setTimeout(() => abort("INSTALL_COMMAND_TIMEOUT"), timeoutMs);

  function abort(code) {
    failure ??= commandError(code);
    void clean(true).catch((error) => { cleanupFailure ??= error; });
  }
  function clean(interrupted) {
    if (released) return Promise.resolve();
    return cleaning ??= cleanResources(interrupted).finally(cleanupDone);
  }
  async function cleanResources(interrupted) {
    if (!child.pid) { released = true; return; }
    const groups = new Set([child.pid]);
    let unverifiableTerminal = false;
    if (interrupted && terminal) {
      // A PTY owns a separate session. Only a still-live parent can establish
      // its descendants; never infer ownership from command text or old PIDs.
      if (exited) unverifiableTerminal = true;
      else if (posix) {
        try {
          for (const group of await terminalGroups(child.pid, env)) groups.add(group);
        } catch { unverifiableTerminal = true; }
      }
    }
    let cleanupError;
    if (posix) {
      for (const group of [...groups].reverse()) {
        try { if (groupMayExist(group)) signalGroup(group); }
        catch (error) { cleanupError ??= error; }
      }
    } else if (!exited) {
      const windowsRoot = env?.SystemRoot ?? process.env.SystemRoot ?? "C:\\Windows";
      try {
        await execFileAsync(join(windowsRoot, "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"],
          { env, windowsHide: true, timeout: 10_000 });
      } catch (error) { cleanupError ??= error; }
    }
    // A failed descendant-group cleanup must not leave this owned leader alive.
    // This best effort does not turn an unverified group cleanup into success.
    if (!exited) {
      try { child.kill("SIGKILL"); }
      catch (error) { cleanupError ??= error; }
    }
    const deadline = Date.now() + 10_000;
    if (posix) for (const group of groups) {
      try { await waitFor(() => !groupMayExist(group), "INSTALL_COMMAND_GROUP_REMAINS", deadline); }
      catch (error) { cleanupError ??= error; }
    }
    try { await waitFor(() => exited, "INSTALL_COMMAND_PROCESS_REMAINS", deadline); }
    catch (error) { cleanupError ??= error; }
    if (cleanupError) throw cleanupError;
    if (unverifiableTerminal) throw commandError("INSTALL_TERMINAL_CLEANUP_UNVERIFIED", true);
    released = true;
  }
  const result = (async () => {
    await Promise.race([exit, cleanupSettled]);
    clearTimeout(timer);
    if (!exited) cleanupFailure ??= commandError("INSTALL_COMMAND_PROCESS_REMAINS", true);
    try { await clean(Boolean(failure)); }
    catch (error) { cleanupFailure ??= error; }
    // A child inheriting stdout can keep close pending after its leader exits.
    try { await waitFor(() => closed, "INSTALL_COMMAND_STDIO_REMAINS"); }
    catch (error) {
      cleanupFailure ??= error;
      child.stdout.destroy();
      child.stderr.destroy();
    }
    if (cleanupFailure) {
      cleanupFailure.cleanupFailed = true;
      throw Object.assign(cleanupFailure, output);
    }
    if (failure) throw Object.assign(failure, output);
    return output;
  })();
  return {
    result,
    async stop() {
      if (released) return;
      failure ??= commandError("INSTALL_COMMAND_STOPPED");
      await clean(true);
    },
  };
}

export function trackLifecycleTerminal(child, env) {
  if (!Number.isInteger(child?.pid) || child.pid <= 1 || typeof child.onExit !== "function" || typeof child.kill !== "function") {
    throw commandError("INSTALL_TERMINAL_IDENTITY_INVALID", true);
  }
  let ended = false, stopping;
  const exited = new Promise((done) => child.onExit((event) => { ended = true; done(event); }));
  return { child, exited, stop: () => stopping ??= stop() };

  async function stop() {
    const posix = process.platform !== "win32";
    let cleanupError;
    if (posix) {
      try { if (groupMayExist(child.pid)) signalGroup(child.pid); }
      catch (error) { cleanupError ??= error; }
    } else if (!ended) {
      const windowsRoot = env?.SystemRoot ?? process.env.SystemRoot ?? "C:\\Windows";
      try {
        await execFileAsync(join(windowsRoot, "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"],
          { env, windowsHide: true, timeout: 10_000 });
      } catch (error) { cleanupError ??= error; }
    }
    // ConPTY handles must be disposed even after its shell exits. POSIX does
    // not need another leader signal once onExit has retired that identity.
    if (!posix || !ended) {
      try {
        if (posix) child.kill("SIGKILL");
        else child.kill();
      }
      catch (error) { if (error.code !== "ESRCH") cleanupError ??= error; }
    }
    const deadline = Date.now() + 10_000;
    if (posix) {
      try { await waitFor(() => !groupMayExist(child.pid), "INSTALL_TERMINAL_GROUP_REMAINS", deadline); }
      catch (error) { cleanupError ??= error; }
    }
    try { await waitFor(() => ended, "INSTALL_TERMINAL_PROCESS_REMAINS", deadline); }
    catch (error) { cleanupError ??= error; }
    if (cleanupError) { cleanupError.cleanupFailed = true; throw cleanupError; }
  }
}

async function terminalGroups(rootPid, env) {
  const { stdout } = await execFileAsync("/bin/ps", ["-axo", "pid=,ppid=,pgid="], {
    env, timeout: 5_000, maxBuffer: 1024 * 1024, encoding: "utf8",
  });
  const entries = stdout.trim().split(/\r?\n/).map((line) => line.trim().split(/\s+/).map(Number));
  if (!entries.every((entry) => entry.length === 3 && entry.every(Number.isInteger))
    || !entries.some(([pid, , group]) => pid === rootPid && group === rootPid)) {
    throw commandError("INSTALL_TERMINAL_CLEANUP_UNVERIFIED", true);
  }
  const owned = new Set([rootPid]);
  for (const parent of owned) for (const [pid, ppid] of entries) if (ppid === parent && pid > 1) owned.add(pid);
  const groups = new Set();
  for (const [pid, , group] of entries) {
    if (!owned.has(pid)) continue;
    if (group <= 1 || !owned.has(group)) throw commandError("INSTALL_TERMINAL_CLEANUP_UNVERIFIED", true);
    groups.add(group);
  }
  return groups;
}

function signalGroup(pid) {
  try { process.kill(-pid, "SIGKILL"); }
  catch (error) { if (error.code !== "ESRCH") throw error; }
}
function groupMayExist(pid) {
  try { process.kill(-pid, 0); return true; }
  catch (error) {
    if (error.code === "ESRCH") return false;
    // macOS can return EPERM briefly after a successful group SIGKILL. It is
    // not absence: retain ownership until ESRCH or a bounded cleanup failure.
    if (error.code === "EPERM") return true;
    throw error;
  }
}
async function waitFor(predicate, code, deadline = Date.now() + 10_000) {
  while (!predicate()) {
    if (Date.now() >= deadline) throw commandError(code, true);
    await new Promise((done) => setTimeout(done, 25));
  }
}
function commandError(code, cleanupFailed = false) {
  return Object.assign(new Error(code), { testCode: code, cleanupFailed });
}
