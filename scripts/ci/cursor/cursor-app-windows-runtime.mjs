import { execFile } from "node:child_process";
import { win32 as path } from "node:path";
import { promisify } from "node:util";
import { collectCursorAppWindowsStopDiagnostics } from "./cursor-app-diagnostics.mjs";

const exec = promisify(execFile);
const argumentCode = "CURSOR_APP_WINDOWS_RUNTIME_ARGUMENTS";
function check(value) { if (!value) throw Object.assign(new Error(argumentCode), { code: argumentCode }); }
function absolute(value) {
  check(typeof value === "string" && /^[A-Za-z]:\\/.test(value) && !/[\x00-\x1f\x7f;"<>|?*]/.test(value)
    && path.normalize(value) === value && value.length > 3 && !value.slice(2).includes(":"));
  return value.replace(/\\$/, "");
}

export function windowsRuntimePaths({ root, appPath, packageRoot, nodePath, systemRoot = "C:\\Windows" }) {
  root = absolute(root); appPath = absolute(appPath); packageRoot = absolute(packageRoot); nodePath = absolute(nodePath);
  check(path.basename(appPath).toLowerCase() === "cursor.exe" && path.basename(nodePath).toLowerCase() === "node.exe");
  const home = path.join(root, "home"), tmp = path.join(root, "tmp"), system = absolute(systemRoot);
  const powershell = path.join(system, "System32", "WindowsPowerShell", "v1.0");
  // Keep the runner's PowerShell 7 available for Cursor's native UTF-8 Hook pipeline.
  const powershell7 = path.join(path.parse(system).root, "Program Files", "PowerShell", "7");
  const bins = [path.join(path.dirname(path.dirname(packageRoot)), ".bin"), path.dirname(nodePath),
    path.join(system, "System32"), system, powershell, powershell7];
  return { home, tmp, resourcesPackage: path.join(path.dirname(appPath), "resources", "app", "package.json"),
    env: {
      SystemRoot: system, WINDIR: system, SystemDrive: system.slice(0, 2), COMSPEC: path.join(system, "System32", "cmd.exe"),
      PATH: [...new Set(bins)].join(";"), PATHEXT: ".COM;.EXE;.BAT;.CMD", PSModulePath: path.join(powershell, "Modules"),
      HOME: home, USERPROFILE: home, HOMEDRIVE: home.slice(0, 2), HOMEPATH: home.slice(2),
      APPDATA: path.join(home, "AppData", "Roaming"), LOCALAPPDATA: path.join(home, "AppData", "Local"),
      TMPDIR: tmp, TMP: tmp, TEMP: tmp,
      CURSOR_HOME: path.join(home, ".cursor"), CURSOR_CONFIG_DIR: path.join(home, ".cursor"),
      CODEX_HOME: path.join(home, ".codex"), CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
      OPENCODE_CONFIG_DIR: path.join(home, ".opencode"), CODEBUDDY_CONFIG_DIR: path.join(home, ".codebuddy"),
      MEMORAX_CODE_HOME: path.join(root, "state"),
    } };
}

export function hasOwnedWindowsProcesses(rows, { appPath, packageRoot, stateHome, marker, encodedCommand, includeBackend = true, selfPid }) {
  check(Array.isArray(rows) && Number.isSafeInteger(selfPid) && selfPid > 0);
  const paths = [path.dirname(absolute(appPath)), absolute(stateHome),
    ...(includeBackend ? [absolute(packageRoot)] : []), ...(marker ? [absolute(marker)] : [])];
  const patterns = paths.map((value) => new RegExp(`(?:^|[\\s"'=])${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[\\s"'\\\\/])`, "i"));
  if (encodedCommand !== undefined) {
    check(typeof encodedCommand === "string" && /^[A-Za-z0-9+/=]+$/.test(encodedCommand));
    patterns.push(new RegExp(`(?:^|\\s)-EncodedCommand\\s+${encodedCommand.replaceAll("+", "\\+")}(?=$|[\\s"'])`));
  }
  return rows.some((row) => {
    check(row && Number.isSafeInteger(row.ProcessId) && row.ProcessId >= 0
      && (row.CommandLine === null || typeof row.CommandLine === "string")
      && (row.ExecutablePath === null || typeof row.ExecutablePath === "string"));
    return row.ProcessId !== selfPid && patterns.some((pattern) => pattern.test(row.ExecutablePath ?? "") || pattern.test(row.CommandLine ?? ""));
  });
}

export async function auditWindowsProcesses(options, execute = exec) {
  const fail = (suffix) => {
    const code = `CURSOR_APP_WINDOWS_PROCESS_${suffix}`;
    throw Object.assign(new Error(code), { code });
  };
  let stdout;
  try {
    ({ stdout } = await execute(path.join(options.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
        "$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process | Select-Object ProcessId,ExecutablePath,CommandLine) | ConvertTo-Json -Compress"],
      { env: options.env, encoding: "utf8", timeout: 30000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }));
  } catch (error) {
    if (error?.code === "ETIMEDOUT" || (error?.killed === true && error?.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")) fail("QUERY_TIMEOUT");
    const stderr = typeof error?.stderr === "string" ? error.stderr : "";
    if (/\bCommandNotFoundException\b/.test(stderr)) fail("QUERY_COMMAND_NOT_FOUND");
    if (/\bCimException\b/.test(stderr)) fail("QUERY_CIM_FAILED");
    fail("QUERY_FAILED");
  }
  let rows;
  try { rows = JSON.parse(stdout); } catch { fail("JSON_INVALID"); }
  try { return hasOwnedWindowsProcesses(rows, options); } catch { fail("ROWS_INVALID"); }
}

export async function stopWindowsApp(child, env, execute = exec) {
  // Never rediscover or kill an exited child's potentially reused PID.
  if (!child?.pid || child.exitCode != null || child.signalCode != null) return;
  try {
    await execute(path.join(env.SystemRoot, "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"],
      { env, windowsHide: true, timeout: 10000, maxBuffer: 64 * 1024 });
  } catch (error) {
    let suffix = "FAILED";
    if (error?.code === "ETIMEDOUT" || (error?.killed === true && error?.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")) suffix = "TIMEOUT";
    else if (error?.code === "ENOENT") suffix = "UNAVAILABLE";
    else if (Number.isInteger(error?.code) && error.code >= 0 && error.code <= 0xffffffff) suffix = `EXIT_${error.code}`;
    const code = `CURSOR_APP_WINDOWS_APP_STOP_${suffix}`;
    throw Object.assign(new Error(code), { code, windowsAppStop: collectCursorAppWindowsStopDiagnostics({ error, child }) });
  }
}

export function windowsShellCommand(args, environment = {}) {
  check(Array.isArray(args) && args.length > 0 && args[0] !== ""
    && args.every((value) => typeof value === "string" && !value.includes("\0")));
  check(environment && !Array.isArray(environment)
    && [Object.prototype, null].includes(Object.getPrototypeOf(environment)));
  const entries = Object.entries(environment).sort(([left], [right]) => left.localeCompare(right));
  check(entries.every(([key, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
    && typeof value === "string" && !value.includes("\0")));
  const quote = (value) => `'${value.replaceAll("'", "''")}'`;
  const script = ["$ErrorActionPreference='Stop'", ...entries.map(([key, value]) => `$env:${key}=${quote(value)}`),
    `& ${args.map(quote).join(" ")}`, "exit $LASTEXITCODE"].join("; ");
  return `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`;
}
