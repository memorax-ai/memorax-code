import { open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createConnection } from "node:net";
import { boundedInt, code, compact, oneOf, projectProductDiagnostics, signal, systemCode } from "../shared/ci-evidence-projections.mjs";
import { projectTerminalDisposal } from "../codex/codex-setup-pty-evidence.mjs";

const PHASES = ["prerequisites", "lifecycle", "replacement_artifact_prepare", "replacement_artifact_pack",
  "replacement_update_rejection", "replacement_fault_evidence", "replacement_preserved_state", "replacement_diagnostics",
  "replacement_recovery", "replacement_readiness", "replacement_retry", "outbound_isolation", "cleanup"];
const COMMANDS = ["npm_pack", "npm_install", "npm_other", "product_setup", "product_update", "product_recover",
  "product_stop", "product_start", "product_status", "product_uninstall", "product_other", "claude_version",
  "claude_plugin_list", "claude_marketplace_list", "claude_other", "terminal_setup", "memory_search", "memory_status", "other"];
const CLEANUP_STAGES = ["entrypoint_check", "pid_record_read", "stop_command", "stop_response", "pid_record_removal",
  "tracked_process", "port_release", "command_process", "directory_removal"];
const TEST_CODES = ["INSTALL_COMMAND_FAILED", "INSTALL_COMMAND_TIMEOUT", "INSTALL_COMMAND_OUTPUT_LIMIT", "INSTALL_COMMAND_STOPPED",
  "INSTALL_COMMAND_PROCESS_REMAINS", "INSTALL_COMMAND_STDIO_REMAINS", "INSTALL_COMMAND_GROUP_REMAINS",
  "INSTALL_TERMINAL_CLEANUP_UNVERIFIED", "INSTALL_TERMINAL_IDENTITY_INVALID", "INSTALL_TERMINAL_PROCESS_REMAINS"];
const productCode = (value) => typeof value === "string" && value.length <= 80
  && /^(?:CLIENT|CLAUDE|BACKEND|SETUP|CONFIG|UPDATE|PACKAGE|INSTALL|MEMORY)_[A-Z_]{3,}$/.test(value) ? value : undefined;
const exitCode = (value) => boundedInt(value, -2147483648, 4294967295);
const milliseconds = (value) => boundedInt(Math.max(0, Math.round(value)), 0, 86_400_000);

export function classifyInstallCommand(command, args, { npmCommand, entrypoint, claudeCommand, ptyScript, memoryEntrypoint }) {
  if (command === npmCommand) return args[0] === "pack" ? "npm_pack" : args[0] === "install" ? "npm_install" : "npm_other";
  if (args[0] === entrypoint) {
    if (args[1] === "update" && args.includes("--recover")) return "product_recover";
    return ["setup", "update", "stop", "start", "status", "uninstall"].includes(args[1]) ? "product_" + args[1] : "product_other";
  }
  if (command === claudeCommand) {
    if (args[0] === "--version") return "claude_version";
    if (args[0] === "plugin" && args[1] === "list") return "claude_plugin_list";
    if (args[0] === "plugin" && args[1] === "marketplace" && args[2] === "list") return "claude_marketplace_list";
    return "claude_other";
  }
  if (args[0] === ptyScript) return "terminal_setup";
  if (args[0] === memoryEntrypoint) return args[1] === "search" ? "memory_search" : args[1] === "status" ? "memory_status" : "other";
  return "other";
}

export function projectInstallCommand(error) {
  const testCode = oneOf(error?.testCode, TEST_CODES);
  const nativeCode = systemCode(error?.code);
  const commandSignal = signal(error?.signal);
  const status = !error ? "success" : testCode === "INSTALL_COMMAND_TIMEOUT" || nativeCode === "ETIMEDOUT" ? "timeout"
    : testCode === "INSTALL_COMMAND_OUTPUT_LIMIT" ? "output_limit" : error.cleanupFailed === true ? "cleanup_failed"
      : commandSignal ? "signal" : Number.isInteger(error.code) ? "nonzero_exit" : nativeCode ? "native_error" : "failed";
  return compact({ status, exitCode: error ? exitCode(error.code) : 0, signal: commandSignal,
    systemCode: nativeCode, testCode, diagnosticCode: productCode(error?.diagnosticCode),
    terminalError: code(error?.terminalError), terminalDisposal: projectTerminalDisposal(error?.terminalDisposal) });
}

// Values sent to the shared recorder are chosen here, never copied from commands or reports.
// Expected command rejections remain observations; only the runner declares a primary failure.
export function createClaudeInstallEvidence(recorder, { now = () => performance.now() } = {}) {
  const started = now(), failedCommands = new WeakMap();
  let phase = "prerequisites", phaseSequence = 0, commandSequence = 0, primary, cleanup;
  const elapsed = () => milliseconds(now() - started);
  const emit = (key, value) => { try { recorder.observe(key, value); } catch {} };
  const setPhase = (value) => {
    phase = oneOf(value, PHASES) ?? "lifecycle";
    emit("phase." + ++phaseSequence, { phase, elapsedMs: elapsed() });
  };
  setPhase(phase);
  return {
    get phase() { return phase; },
    setPhase,
    async command(name, operation) {
      const command = oneOf(name, COMMANDS) ?? "other", commandPhase = phase, sequence = ++commandSequence;
      const start = now(), startedAtMs = elapsed();
      emit("command." + sequence + ".start", { command, phase: commandPhase, startedAtMs });
      let failure;
      try { return await operation(); }
      catch (error) { failure = error; throw error; }
      finally {
        const result = { command, phase: commandPhase, startedAtMs, elapsedMs: milliseconds(now() - start),
          ...projectInstallCommand(failure) };
        if (failure && (typeof failure === "object" || typeof failure === "function")) failedCommands.set(failure, result);
        emit("command." + sequence + ".end", result);
      }
    },
    fail(kind, error, cleanupStage) {
      if (kind === "cleanup" ? cleanup : primary) return kind === "cleanup" ? cleanup : primary;
      const command = error && (typeof error === "object" || typeof error === "function") ? failedCommands.get(error) : undefined;
      const details = projectInstallCommand(error);
      const code = details.terminalError ?? details.diagnosticCode ?? details.testCode ?? details.systemCode
        ?? (details.exitCode !== undefined ? "COMMAND_EXIT_NONZERO" : details.signal ? "COMMAND_SIGNAL" : "CLAUDE_INSTALL_STAGE_FAILED");
      const value = compact({ phase, elapsedMs: elapsed(), code, ...details, command,
        cleanupStage: kind === "cleanup" ? oneOf(cleanupStage, CLEANUP_STAGES) : undefined });
      if (kind === "cleanup") cleanup = value;
      else primary = value;
      emit(kind === "cleanup" ? "cleanupFailure" : "primaryFailure", value);
      return value;
    },
    failureSummary() {
      if (!primary && !cleanup) return undefined;
      const first = primary ?? cleanup;
      return compact({ kind: primary ? cleanup ? "functional+cleanup" : "functional" : "cleanup",
        stage: first.phase, code: first.code, exitCode: first.exitCode, primary, cleanup });
    },
  };
}

async function readBoundedJson(path, maxBytes) {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maxBytes) throw Object.assign(new Error("Evidence record too large"), { code: "EFBIG" });
    return JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
  } finally { await handle.close(); }
}

// Read the existing diagnostic files even if package replacement has broken the installed CLI.
// No diagnostic text, paths, configuration or raw command output reaches the journal.
export async function collectInstallProductDiagnostics(stateHome) {
  const directory = join(stateHome, "runtime", "diagnostics");
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return { present: false, records: [] }; throw error; }
  const files = entries.filter((entry) => entry.isFile()
    && /^mc-\d{13}-[a-f0-9-]{36}\.json$/.test(entry.name)).map((entry) => entry.name).sort().reverse();
  const records = [];
  let unreadable = 0;
  for (const name of files.slice(0, 20)) {
    try { records.push(await readBoundedJson(join(directory, name), 64 * 1024)); }
    catch { unreadable += 1; }
  }
  return { present: true, files: Math.min(files.length, 1000), unreadable, truncated: files.length > 20,
    ...projectProductDiagnostics({ records }) };
}

function probePid(pid, kill) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return "unknown";
  try { kill(pid, 0); return "alive"; }
  catch (error) { return error.code === "ESRCH" ? "exited" : "unknown"; }
}

export function observeInstallPort(port, { connect = createConnection, timeoutMs = 300 } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return Promise.resolve({ state: "unknown" });
  return new Promise((resolve) => {
    let socket, timer, settled = false;
    const finish = (state, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket?.destroy(); } catch {}
      resolve(compact({ state, systemCode: systemCode(error?.code) }));
    };
    timer = setTimeout(() => finish("timeout"), timeoutMs);
    timer.unref?.();
    try {
      socket = connect({ host: "127.0.0.1", port });
      socket.once("connect", () => finish("accepting"));
      socket.once("error", (error) => finish(error.code === "ECONNREFUSED" ? "refused" : "unknown", error));
    } catch (error) { finish("unknown", error); }
  });
}

// A live PID slot may have been reused. This is an observation, never proof of Backend ownership
// or permission to kill it. A refused TCP connection also does not replace the port-release gate.
export async function observeInstallCleanup({ pidPath, trackedPids, port }, {
  readPidRecord = (path) => readBoundedJson(path, 16 * 1024), kill = process.kill,
  observePort = observeInstallPort,
} = {}) {
  let pidRecord = "absent", recordedPid = "unknown";
  if (pidPath) {
    try {
      const record = await readPidRecord(pidPath);
      pidRecord = Number.isSafeInteger(record?.pid) && record.pid > 0 ? "present" : "invalid";
      if (pidRecord === "present") recordedPid = probePid(record.pid, kill);
    } catch (error) { pidRecord = error.code === "ENOENT" ? "absent" : "unreadable"; }
  }
  const pids = [...(trackedPids ?? [])], counts = { observed: Math.min(pids.length, 32), alive: 0, exited: 0, unknown: 0,
    truncated: pids.length > 32 };
  for (const pid of pids.slice(0, 32)) counts[probePid(pid, kill)] += 1;
  let endpoint;
  try { endpoint = await observePort(port); }
  catch (error) { endpoint = compact({ state: "unknown", systemCode: systemCode(error.code) }); }
  return { pidRecord, recordedPid, trackedPidSlots: counts, port: endpoint };
}
