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
  check(rows.every((row) => row && Number.isSafeInteger(row.ProcessId) && row.ProcessId >= 0
    && (row.CommandLine === null || typeof row.CommandLine === "string")
    && (row.ExecutablePath === null || typeof row.ExecutablePath === "string")));
  return rows.some((row) => row.ProcessId !== selfPid
    && patterns.some((pattern) => pattern.test(row.ExecutablePath ?? "") || pattern.test(row.CommandLine ?? "")));
}

const processQueryMaxBytes = 4 * 1024 * 1024;
const processAuditBudgetMs = 60000, processQueryTimeoutMs = 30000, processAuditMaxAttempts = 25;
const processFailures = {
  timeout: "QUERY_TIMEOUT", "command-not-found": "QUERY_COMMAND_NOT_FOUND", cim: "QUERY_CIM_FAILED",
  overflow: "QUERY_OUTPUT_OVERFLOW", "invalid-json": "JSON_INVALID", "invalid-rows": "ROWS_INVALID",
  "query-failed": "QUERY_FAILED", budget: "AUDIT_TIMEOUT",
};
const bounded = (value, max, fallback = 0) => Number.isSafeInteger(value) && value >= 0 && value <= max ? value : fallback;
const elapsed = (start, now) => Math.min(600000, Math.max(0, Math.ceil(now() - start)));
const outputBytes = (value) => typeof value === "string" ? Buffer.byteLength(value) : Buffer.isBuffer(value) ? value.length : 0;
const processError = (code, diagnostics) => Object.assign(new Error(code), { code,
  ...(diagnostics ? { windowsProcessAudit: projectWindowsProcessAuditDiagnostics(diagnostics) } : {}) });

export function projectWindowsProcessAuditDiagnostics(value) {
  const query = value?.lastQuery;
  return {
    attempts: bounded(value?.attempts, processAuditMaxAttempts), elapsedMs: bounded(value?.elapsedMs, 600000),
    timeoutCount: bounded(value?.timeoutCount, 2),
    firstFailure: value?.firstFailure === "none" || (typeof value?.firstFailure === "string" && Object.hasOwn(processFailures, value.firstFailure))
      ? value.firstFailure : "query-failed",
    finalStatus: ["clear", "owned-remains", "timeout", "failed", "budget"].includes(value?.finalStatus) ? value.finalStatus : "failed",
    lastQuery: {
      elapsedMs: bounded(query?.elapsedMs, 600000), timedOut: query?.timedOut === true,
      exitCode: bounded(query?.exitCode, 0xffffffff, null),
      signal: query?.signal == null ? "none" : ["none", "SIGTERM", "SIGKILL", "other"].includes(query.signal) ? query.signal : "other",
      stdoutBytes: bounded(query?.stdoutBytes, processQueryMaxBytes), stderrBytes: bounded(query?.stderrBytes, processQueryMaxBytes),
    },
  };
}

async function queryWindowsProcesses(options, execute, timeout, now, budget = timeout) {
  const start = now();
  let child, timer, budgetTimer, stdout, stderr, error, timedOut = false, budgetExpired = false, terminationFailed = false;
  let succeeded = false;
  try {
    // Own the deadline: child.killed also describes manual termination and buffer overflow.
    const pending = execute(path.join(options.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
        "$ErrorActionPreference='Stop'; ConvertTo-Json -InputObject @(Get-CimInstance Win32_Process -Property ProcessId,ExecutablePath,CommandLine | Select-Object ProcessId,ExecutablePath,CommandLine) -Compress"],
      { env: options.env, encoding: "utf8", timeout: 0, maxBuffer: processQueryMaxBytes, windowsHide: true });
    child = pending?.child;
    const closed = child ? new Promise((resolve) => child.once("close", resolve)) : Promise.resolve();
    timer = setTimeout(() => {
      timedOut = true;
      try { child?.kill("SIGKILL"); } catch { terminationFailed = true; }
    }, Math.max(1, timeout - (now() - start)));
    const settled = Promise.resolve(pending).then((result) => { ({ stdout, stderr } = result); succeeded = true; },
      (caught) => { error = caught; stdout = caught?.stdout; stderr = caught?.stderr; }).finally(() => clearTimeout(timer));
    // An execFile error can settle before close. A missing close exhausts the same budget, never authorizing a retry.
    await Promise.race([Promise.all([settled, closed]), new Promise((resolve) => {
      budgetTimer = setTimeout(() => { budgetExpired = true; resolve(); }, Math.max(1, budget - (now() - start)));
    })]);
  } catch (caught) { error = caught; stdout = caught?.stdout; stderr = caught?.stderr; }
  finally { clearTimeout(timer); clearTimeout(budgetTimer); }
  const diagnostics = {
    elapsedMs: elapsed(start, now), timedOut,
    exitCode: child?.exitCode ?? (Number.isInteger(error?.code) ? error.code : succeeded ? 0 : null),
    signal: child?.signalCode ?? error?.signal ?? "none",
    stdoutBytes: Math.min(processQueryMaxBytes, outputBytes(stdout)), stderrBytes: Math.min(processQueryMaxBytes, outputBytes(stderr)),
  };
  let failure;
  if (error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || outputBytes(stdout) > processQueryMaxBytes || outputBytes(stderr) > processQueryMaxBytes) failure = "overflow";
  else if (terminationFailed) failure = "query-failed";
  else if (timedOut) failure = "timeout";
  else if (error) {
    const text = typeof stderr === "string" ? stderr : "";
    failure = /\bCommandNotFoundException\b/.test(text) ? "command-not-found"
      : /\bCimException\b/.test(text) ? "cim" : "query-failed";
  }
  if (!failure && budgetExpired) failure = "budget";
  if (failure) return { diagnostics, failure, budgetExpired };
  let rows;
  try { rows = JSON.parse(stdout); } catch { return { diagnostics, failure: "invalid-json" }; }
  try { return { diagnostics, owned: hasOwnedWindowsProcesses(rows, options) }; }
  catch { return { diagnostics, failure: "invalid-rows" }; }
}

export async function auditWindowsProcesses(options, execute = exec) {
  const result = await queryWindowsProcesses(options, execute, processQueryTimeoutMs, () => performance.now());
  if (result.failure) throw processError("CURSOR_APP_WINDOWS_PROCESS_" + processFailures[result.failure]);
  return result.owned;
}

export async function waitForWindowsProcessesExit(options, {
  execute = exec, now = () => performance.now(), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const start = now(), deadline = start + processAuditBudgetMs;
  const diagnostics = { attempts: 0, elapsedMs: 0, timeoutCount: 0, firstFailure: "none", finalStatus: "failed" };
  const finish = (status, code) => {
    diagnostics.elapsedMs = elapsed(start, now);
    diagnostics.finalStatus = status;
    const projected = projectWindowsProcessAuditDiagnostics(diagnostics);
    if (code) throw processError(code, projected);
    return projected;
  };
  while (diagnostics.attempts < processAuditMaxAttempts) {
    const remaining = Math.floor(deadline - now());
    if (remaining <= 0) {
      if (diagnostics.firstFailure === "none") diagnostics.firstFailure = "budget";
      return finish("budget", "CURSOR_APP_WINDOWS_PROCESS_AUDIT_TIMEOUT");
    }
    diagnostics.attempts++;
    const result = await queryWindowsProcesses(options, execute, Math.min(processQueryTimeoutMs, remaining), now, remaining);
    diagnostics.lastQuery = result.diagnostics;
    if (result.failure) {
      if (diagnostics.firstFailure === "none") diagnostics.firstFailure = result.failure;
      if (result.failure === "timeout") diagnostics.timeoutCount++;
      if (result.failure !== "timeout" || diagnostics.timeoutCount > 1
        || diagnostics.attempts === processAuditMaxAttempts || result.budgetExpired || now() >= deadline) {
        return finish(result.failure === "timeout" ? "timeout" : result.failure === "budget" ? "budget" : "failed",
          "CURSOR_APP_WINDOWS_PROCESS_" + processFailures[result.failure]);
      }
    } else {
      if (now() >= deadline) {
        if (diagnostics.firstFailure === "none") diagnostics.firstFailure = "budget";
        return finish("budget", "CURSOR_APP_WINDOWS_PROCESS_AUDIT_TIMEOUT");
      }
      if (!result.owned) return finish("clear");
      if (diagnostics.attempts === processAuditMaxAttempts) return finish("owned-remains", "CURSOR_APP_CLEANUP_DESCENDANTS");
    }
    await sleep(Math.min(200, Math.max(0, deadline - now())));
  }
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
