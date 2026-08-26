import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const POSIX_PROCESS_PROBE_TIMEOUT_MS = 2_000;
const WINDOWS_PROCESS_PROBE_TIMEOUT_MS = 10_000;
const PROCESS_TERMINATION_TIMEOUT_MS = 5_000;

export type ProcessCommandLineProbeResult =
  | {
      status: "ok";
      commandLine: string;
    }
  | {
      status: "not_found";
    }
  | {
      status: "inconclusive";
      reason:
        | "invalid_pid"
        | "powershell_unavailable"
        | "timeout"
        | "terminated"
        | "spawn_error"
        | "read_error"
        | "nonzero_exit";
      timeoutMs: number;
      code?: string;
      exitCode?: number;
      signal?: NodeJS.Signals;
    };

type ProcessCommandLineProbeSpawnOptions = {
  encoding: "utf8";
  windowsHide?: boolean;
  timeout: number;
  killSignal: "SIGKILL";
};

type ProcessCommandLineProbeSpawnResult = {
  error?: NodeJS.ErrnoException;
  signal: NodeJS.Signals | null;
  status: number | null;
  stdout: string;
};

export type ProcessCommandLineProbeRuntime = {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  readFileSync?: (path: string) => Buffer;
  spawnSync?: (
    command: string,
    args: string[],
    options: ProcessCommandLineProbeSpawnOptions,
  ) => ProcessCommandLineProbeSpawnResult;
};

export function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function terminateProcessTree(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  if (!isProcessAlive(pid)) return true;
  if (process.platform === "win32") {
    const taskkill = process.env.SystemRoot
      ? join(process.env.SystemRoot, "System32", "taskkill.exe")
      : undefined;
    if (!taskkill) return false;
    return spawnSync(
      taskkill,
      ["/PID", String(pid), "/T", "/F"],
      {
        stdio: "ignore",
        windowsHide: true,
        timeout: PROCESS_TERMINATION_TIMEOUT_MS,
        killSignal: "SIGKILL",
      },
    ).status === 0;
  }
  try {
    process.kill(pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

export function probeProcessCommandLine(
  pid: number,
  runtime: ProcessCommandLineProbeRuntime = {},
): ProcessCommandLineProbeResult {
  const platform = runtime.platform ?? process.platform;
  const timeoutMs = platform === "win32"
    ? WINDOWS_PROCESS_PROBE_TIMEOUT_MS
    : POSIX_PROCESS_PROBE_TIMEOUT_MS;
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return { status: "inconclusive", reason: "invalid_pid", timeoutMs };
  }
  if (platform === "linux") {
    try {
      const rawCommandLine = (runtime.readFileSync ?? readFileSync)(`/proc/${pid}/cmdline`);
      const commandLine = rawCommandLine.toString("utf8").replaceAll("\0", " ").trim();
      return commandLine
        ? { status: "ok", commandLine }
        : { status: "not_found" };
    } catch (error) {
      const code = error instanceof Error
        ? (error as NodeJS.ErrnoException).code
        : undefined;
      return {
        status: "inconclusive",
        reason: "read_error",
        timeoutMs,
        ...(code ? { code } : {}),
      };
    }
  }
  const run = runtime.spawnSync ?? runProbeCommand;
  let command: string;
  let args: string[];
  const options: ProcessCommandLineProbeSpawnOptions = {
    encoding: "utf8",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  };
  if (platform === "win32") {
    const systemRoot = (runtime.env ?? process.env).SystemRoot;
    const powershell = systemRoot
      ? join(
        systemRoot,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      )
      : undefined;
    if (!powershell) {
      return { status: "inconclusive", reason: "powershell_unavailable", timeoutMs };
    }
    command = powershell;
    args = [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CommandLine`,
    ];
    options.windowsHide = true;
  } else {
    command = "ps";
    args = ["-p", String(pid), "-o", "command="];
  }
  let result: ProcessCommandLineProbeSpawnResult;
  try {
    result = run(command, args, options);
  } catch (error) {
    const code = error instanceof Error
      ? (error as NodeJS.ErrnoException).code
      : undefined;
    return {
      status: "inconclusive",
      reason: "spawn_error",
      timeoutMs,
      ...(code ? { code } : {}),
    };
  }
  if (result.error?.code === "ETIMEDOUT") {
    return {
      status: "inconclusive",
      reason: "timeout",
      timeoutMs,
      code: "ETIMEDOUT",
      ...(result.signal ? { signal: result.signal } : {}),
    };
  }
  if (result.error) {
    return {
      status: "inconclusive",
      reason: "spawn_error",
      timeoutMs,
      ...(result.error.code ? { code: result.error.code } : {}),
    };
  }
  if (result.signal) {
    return {
      status: "inconclusive",
      reason: "terminated",
      timeoutMs,
      signal: result.signal,
    };
  }
  if (result.status !== 0) {
    return {
      status: "inconclusive",
      reason: "nonzero_exit",
      timeoutMs,
      ...(typeof result.status === "number" ? { exitCode: result.status } : {}),
    };
  }
  const commandLine = result.stdout.trim();
  return commandLine
    ? { status: "ok", commandLine }
    : { status: "not_found" };
}

export function managedServiceCommandLine(commandLine: string, instanceId: string): boolean {
  const marker = commandLine.match(
    /(?:^|\s)--memorax-code-backend-instance(?:=|\s+)([A-Za-z0-9_-]+)(?:\s|$)/,
  )?.[1];
  return marker === instanceId
    && /(?:^|[\\/\s"'])node(?:\.exe)?(?:["']?\s)/i.test(commandLine)
    && /[\\/]memorax-code-backend[\\/]dist[\\/]service-entrypoint\.js(?:["']?(?:\s|$))/i.test(commandLine);
}

function runProbeCommand(
  command: string,
  args: string[],
  options: ProcessCommandLineProbeSpawnOptions,
): ProcessCommandLineProbeSpawnResult {
  const result = spawnSync(command, args, options);
  return {
    ...(result.error ? { error: result.error } : {}),
    signal: result.signal,
    status: result.status,
    stdout: result.stdout,
  };
}
