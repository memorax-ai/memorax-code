import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startLifecycleCommand } from "./claude-lifecycle-process.mjs";

export async function stopWrapperBackend(stateHome, command, windowsShell) {
  const pidPath = join(stateHome, "runtime", "backend", "backend.pid.json");
  let raw, pid, failure;
  try { raw = await readFile(pidPath, "utf8"); }
  catch (error) {
    if (error.code === "ENOENT") return;
    failure = cleanupError("WRAPPER_BACKEND_RECORD_UNREADABLE");
  }
  if (raw !== undefined) {
    try {
      pid = JSON.parse(raw).pid;
      if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) throw new Error();
    } catch { pid = undefined; failure = cleanupError("WRAPPER_BACKEND_RECORD_INVALID"); }
  }
  try {
    const windows = process.platform === "win32";
    if (windows && !windowsShell) throw cleanupError("WRAPPER_WINDOWS_SHELL_MISSING");
    const args = ["stop", "--clients", "codebuddy", "--json"];
    const operation = startLifecycleCommand(windows ? windowsShell : command,
      windows ? ["-NoProfile", "-NonInteractive", "-Command",
        "& $env:MEMORAX_TEST_STOP_SHIM stop --clients codebuddy --json; exit $LASTEXITCODE"] : args,
      { env: { ...process.env, MEMORAX_TEST_STOP_SHIM: command }, timeoutMs: 15_000, maxOutputBytes: 1024 * 1024 });
    const stopped = JSON.parse((await operation.result).stdout);
    if (stopped.ok !== true) throw cleanupError("WRAPPER_PUBLIC_STOP_FAILED");
  } catch { failure ??= cleanupError("WRAPPER_PUBLIC_STOP_FAILED"); }
  if (pid !== undefined) {
    const deadline = Date.now() + 15_000;
    try {
      while (present(pid)) {
        if (Date.now() >= deadline) throw cleanupError("WRAPPER_BACKEND_PROCESS_REMAINS");
        await new Promise((done) => setTimeout(done, 50));
      }
    } catch { failure ??= cleanupError("WRAPPER_BACKEND_PROCESS_REMAINS"); }
  }
  try {
    if (await stat(pidPath).then(() => true, (error) => { if (error.code === "ENOENT") return false; throw error; })) {
      failure ??= cleanupError("WRAPPER_BACKEND_RECORD_REMAINS");
    }
  } catch { failure ??= cleanupError("WRAPPER_BACKEND_RECORD_UNREADABLE"); }
  if (failure) throw failure;
}

function present(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; if (error.code === "EPERM") return true; throw error; }
}
function cleanupError(code) { return Object.assign(new Error(code), { testCode: code }); }

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length < 4 || process.argv.length > 5) throw cleanupError("WRAPPER_CLEANUP_ARGUMENTS_INVALID");
    await stopWrapperBackend(resolve(process.argv[2]), resolve(process.argv[3]), process.argv[4]);
  } catch {
    console.error("Wrapper Backend cleanup could not be confirmed; original failure and isolated state retained.");
    process.exitCode = 1;
  }
}
