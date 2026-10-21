import { execFile, spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

/** Run one isolated fixture command and reap every process in its owned group. */
export async function runNativeProcess(command, args, options) {
  const { cwd, env, input = "", timeout = 120_000, expectedExit = 0, logPath,
    redact = (text) => text } = options;
  const isNodeEntrypoint = /\.m?js$/i.test(command);
  const child = spawn(isNodeEntrypoint ? process.execPath : command,
    isNodeEntrypoint ? [command, ...args] : args, {
      cwd, env: { ...env, PWD: cwd }, detached: process.platform !== "win32",
      windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
  child.stdin.on("error", () => {});
  child.stdin.end(input);
  let stdout = "", stderr = "", timedOut = false, stopping;
  child.stdout.on("data", (chunk) => { stdout = (stdout + chunk).slice(-MAX_OUTPUT_BYTES); });
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-MAX_OUTPUT_BYTES); });
  const stop = () => stopping ??= stopNativeProcessTree(child, env);
  const timer = setTimeout(() => { timedOut = true; void stop().catch(() => {}); }, timeout);
  let result;
  try {
    result = await new Promise((resolveChild) => {
      child.once("error", (error) => resolveChild({ code: null, signal: null, error: error.message }));
      child.once("close", (code, signal) => resolveChild({ code, signal }));
    });
  } finally {
    clearTimeout(timer);
    await stop();
  }
  const report = {
    command: basename(command), args: args.map(redact), pid: child.pid, ...result, timedOut,
    stdout: redact(stdout), stderr: redact(stderr),
  };
  if (logPath) await writeFile(logPath, JSON.stringify(report, null, 2) + "\n");
  if (timedOut || result.error || (expectedExit !== null && result.code !== expectedExit)) {
    throw new Error([
      basename(command) + " exited " + (timedOut ? `after ${timeout} ms timeout` :
        result.error ?? result.code ?? result.signal),
      logPath && "process diagnostics: " + logPath,
      report.stdout.trim() && "stdout:\n" + report.stdout.slice(-8000),
      report.stderr.trim() && "stderr:\n" + report.stderr.slice(-8000),
    ].filter(Boolean).join("\n"));
  }
  return { ...result, stdout, stderr };
}

export async function stopNativeProcessTree(child, env) {
  if (!Number.isSafeInteger(child.pid) || child.pid <= 1 || child.pid === process.pid) return;
  if (process.platform === "win32") {
    // A closed Windows process no longer proves ownership of a reused PID.
    if (child.exitCode != null || child.signalCode != null) return;
    await execFileAsync(join(env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
      ["/PID", String(child.pid), "/T", "/F"], { env, windowsHide: true, timeout: 10_000 })
      .catch(() => { child.kill("SIGKILL"); });
    return;
  }
  try { process.kill(-child.pid, "SIGKILL"); } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}
