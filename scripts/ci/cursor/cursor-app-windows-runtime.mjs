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
const outputBytes = (value) => typeof value === "string" ? Buffer.byteLength(value) : Buffer.isBuffer(value) ? value.length : null;
const processError = (code, diagnostics) => Object.assign(new Error(code), { code,
  ...(diagnostics ? { windowsProcessAudit: projectWindowsProcessAuditDiagnostics(diagnostics) } : {}) });
const queryPhaseMarkers = {
  start: "MEMORAX_CURSOR_PROCESS_QUERY_START",
  cimStart: "MEMORAX_CURSOR_PROCESS_QUERY_CIM_START",
  cimComplete: "MEMORAX_CURSOR_PROCESS_QUERY_CIM_COMPLETE",
  jsonComplete: "MEMORAX_CURSOR_PROCESS_QUERY_JSON_COMPLETE",
};
const processQueryScript = ["$ErrorActionPreference='Stop'",
  "[Console]::Error.WriteLine('" + queryPhaseMarkers.start + "')",
  "[Console]::Error.WriteLine('" + queryPhaseMarkers.cimStart + "')",
  "$rows=@(Get-CimInstance Win32_Process -Property ProcessId,ExecutablePath,CommandLine | Select-Object ProcessId,ExecutablePath,CommandLine)",
  "[Console]::Error.WriteLine('" + queryPhaseMarkers.cimComplete + "')",
  "ConvertTo-Json -InputObject @($rows) -Compress",
  "[Console]::Error.WriteLine('" + queryPhaseMarkers.jsonComplete + "')"].join('; ');

function processQueryPhases(start, now) {
  const markers = Object.entries(queryPhaseMarkers), phases = Object.fromEntries(markers.map(([name]) => [name, false]));
  const phaseElapsedMs = Object.fromEntries(markers.map(([name]) => [name, null]));
  let candidates = (1 << markers.length) - 1, position = 0;
  return { phases, phaseElapsedMs, accept(chunk) {
    // Retain only candidate bits and an offset, never arbitrary stderr or partial lines.
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.isBuffer(chunk) ? chunk : [];
    for (const byte of bytes) {
      if (byte === 10) {
        for (let index = 0; index < markers.length; index++) {
          if ((candidates & (1 << index)) && [markers[index][1].length, markers[index][1].length + 1].includes(position)) {
            const name = markers[index][0];
            if (!phases[name]) phaseElapsedMs[name] = elapsed(start, now);
            phases[name] = true;
          }
        }
        candidates = (1 << markers.length) - 1; position = 0;
      } else if (candidates) {
        for (let index = 0; index < markers.length; index++) {
          const marker = markers[index][1];
          if ((position < marker.length ? marker.charCodeAt(position) : position === marker.length ? 13 : -1) !== byte) {
            candidates &= ~(1 << index);
          }
        }
        position++;
      }
    }
  } };
}

function projectProcessQuery(query) {
  return {
    elapsedMs: bounded(query?.elapsedMs, 600000), timedOut: query?.timedOut === true,
    exitCode: bounded(query?.exitCode, 0xffffffff, null),
    signal: query?.signal == null ? "none" : ["none", "SIGTERM", "SIGKILL", "other"].includes(query.signal) ? query.signal : "other",
    stdoutBytes: bounded(query?.stdoutBytes, processQueryMaxBytes, null), stderrBytes: bounded(query?.stderrBytes, processQueryMaxBytes, null),
    spawnObserved: query?.spawnObserved === true, exitObserved: query?.exitObserved === true,
    closeObserved: query?.closeObserved === true, promiseSettled: query?.promiseSettled === true,
    budgetExpired: query?.budgetExpired === true, killRequested: query?.killRequested === true,
    killReturned: typeof query?.killReturned === "boolean" ? query.killReturned : null, killThrew: query?.killThrew === true,
    phases: Object.fromEntries(Object.keys(queryPhaseMarkers).map((name) => [name, query?.phases?.[name] === true])),
    phaseElapsedMs: Object.fromEntries(Object.keys(queryPhaseMarkers).map((name) => [name,
      query?.phases?.[name] === true ? bounded(query?.phaseElapsedMs?.[name], 600000, null) : null])),
  };
}

export function projectWindowsProcessAuditDiagnostics(value) {
  return {
    attempts: bounded(value?.attempts, processAuditMaxAttempts), elapsedMs: bounded(value?.elapsedMs, 600000),
    timeoutCount: bounded(value?.timeoutCount, 2),
    firstFailure: value?.firstFailure === "none" || (typeof value?.firstFailure === "string" && Object.hasOwn(processFailures, value.firstFailure))
      ? value.firstFailure : "query-failed",
    finalStatus: ["clear", "owned-remains", "timeout", "failed", "budget"].includes(value?.finalStatus) ? value.finalStatus : "failed",
    firstFailedQuery: value?.firstFailedQuery && typeof value.firstFailedQuery === "object" && !Array.isArray(value.firstFailedQuery)
      ? projectProcessQuery(value.firstFailedQuery) : null,
    lastQuery: projectProcessQuery(value?.lastQuery),
  };
}

async function queryWindowsProcesses(options, execute, timeout, now, budget = timeout) {
  const start = now(), phaseObserver = processQueryPhases(start, now), listeners = [];
  const observed = { stdoutBytes: null, stderrBytes: null, spawnObserved: false, exitObserved: false,
    closeObserved: false, promiseSettled: false, killRequested: false, killReturned: null, killThrew: false };
  let child, timer, budgetTimer, stdout, stderr, error, timedOut = false, budgetExpired = false, terminationFailed = false;
  let succeeded = false, exitCode, exitSignal, stderrStream = false;
  const listen = (emitter, event, handler) => {
    if (typeof emitter?.on !== "function") return false;
    emitter.on(event, handler); listeners.push(() => emitter.removeListener(event, handler)); return true;
  };
  const countOutput = (name, value) => {
    const bytes = outputBytes(value);
    if (bytes !== null) observed[name] = Math.min(processQueryMaxBytes, (observed[name] ?? 0) + bytes);
  };
  const captureOutput = (result) => {
    ({ stdout, stderr } = result ?? {});
    for (const [name, value] of [["stdoutBytes", stdout], ["stderrBytes", stderr]]) {
      const bytes = outputBytes(value);
      if (bytes !== null) observed[name] = Math.min(processQueryMaxBytes, Math.max(observed[name] ?? 0, bytes));
    }
    if (!stderrStream) phaseObserver.accept(stderr);
  };
  try {
    // Own the deadline: child.killed also describes manual termination and buffer overflow.
    const pending = execute(path.join(options.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", processQueryScript],
      { env: options.env, encoding: "utf8", timeout: 0, maxBuffer: processQueryMaxBytes, windowsHide: true });
    child = pending?.child;
    listen(child, "spawn", () => { observed.spawnObserved = true; });
    listen(child, "exit", (code, signal) => { observed.exitObserved = true; exitCode = code; exitSignal = signal; });
    const closed = child ? new Promise((resolve) => listen(child, "close", () => { observed.closeObserved = true; resolve(); })) : Promise.resolve();
    if (listen(child?.stdout, "data", (chunk) => countOutput("stdoutBytes", chunk))) observed.stdoutBytes = 0;
    stderrStream = listen(child?.stderr, "data", (chunk) => { countOutput("stderrBytes", chunk); phaseObserver.accept(chunk); });
    if (stderrStream) observed.stderrBytes = 0;
    timer = setTimeout(() => {
      timedOut = true;
      observed.killRequested = typeof child?.kill === "function";
      try {
        const killed = child?.kill("SIGKILL");
        if (typeof killed === "boolean") observed.killReturned = killed;
      } catch { terminationFailed = true; observed.killThrew = true; }
    }, Math.max(1, timeout - (now() - start)));
    const settled = Promise.resolve(pending).then((result) => { observed.promiseSettled = true; captureOutput(result); succeeded = true; },
      (caught) => { observed.promiseSettled = true; error = caught; captureOutput(caught); }).finally(() => clearTimeout(timer));
    // An execFile error can settle before close. A missing close exhausts the same budget, never authorizing a retry.
    await Promise.race([Promise.all([settled, closed]), new Promise((resolve) => {
      budgetTimer = setTimeout(() => { budgetExpired = true; resolve(); }, Math.max(1, budget - (now() - start)));
    })]);
  } catch (caught) { error = caught; captureOutput(caught); }
  finally { clearTimeout(timer); clearTimeout(budgetTimer); for (const remove of listeners) remove(); }
  const diagnostics = {
    elapsedMs: elapsed(start, now), timedOut, ...observed, budgetExpired: budgetExpired || now() - start >= budget,
    exitCode: child?.exitCode ?? exitCode ?? (Number.isInteger(error?.code) ? error.code : succeeded ? 0 : null),
    signal: child?.signalCode ?? exitSignal ?? error?.signal ?? "none", phases: { ...phaseObserver.phases },
    phaseElapsedMs: { ...phaseObserver.phaseElapsedMs },
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
      if (diagnostics.firstFailure === "none") {
        diagnostics.firstFailure = result.failure; diagnostics.firstFailedQuery = result.diagnostics;
      }
      if (result.failure === "timeout") diagnostics.timeoutCount++;
      if (result.failure !== "timeout" || diagnostics.timeoutCount > 1
        || diagnostics.attempts === processAuditMaxAttempts || result.budgetExpired || now() >= deadline) {
        return finish(result.failure === "timeout" ? "timeout" : result.failure === "budget" ? "budget" : "failed",
          "CURSOR_APP_WINDOWS_PROCESS_" + processFailures[result.failure]);
      }
    } else {
      if (now() >= deadline) {
        if (diagnostics.firstFailure === "none") {
          diagnostics.firstFailure = "budget"; diagnostics.firstFailedQuery = result.diagnostics;
        }
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
