import { basename, resolve } from "node:path";
import {
  backendServiceEndpoint,
  backendServiceLogs,
  isProcessAlive,
  readBackendServiceState,
  readBackendToken,
  writeBackendToken,
} from "../lifecycle/backend/service.js";
import type { BackendServiceOptions } from "../lifecycle/contracts.js";
import {
  BackendConnectionAuthorityError,
  resolveBackendConnection,
} from "../../../memorax-code-adapter-common/src/backend-connection.mjs";
import {
  RuntimeRecordError,
  type RuntimeRecordWriteRuntime,
} from "../../../memorax-code-adapter-common/src/runtime-record.mjs";
import {
  activateClientHookRuntimeGeneration,
  CLIENT_HOOK_RUNTIME_ABI,
  type ClientHookRuntimeGeneration,
} from "../../../memorax-code-adapter-common/src/hooks/hook-runtime-generation.mjs";
import { createBackendState } from "../app/state.js";
import { createBackendServer, type BackendServer } from "../app/backend-server.js";
import { backendDebug } from "../shared/debug-log.js";
import { prepareClientPluginRemovalCleanup } from "../lifecycle/client-plugin-removal.js";
import {
  resolveBackendInstallWatchdogConfig,
  startBackendInstallWatchdog,
} from "../lifecycle/install-watchdog.js";
import { activateCodexPlugin, installCodexPlugin } from "../clients/codex/plugin-install.js";
import { inspectCodexPluginHooks, trustCodexPluginHooks, type CodexHook } from "../clients/codex/plugin-hooks.js";
import {
  collectMemoraxCodeStatus,
  isAdapterReady,
  isOptionalUnconfiguredClaudeAdapter,
  restartMemoraxCodeService,
  startMemoraxCodeService,
  stopMemoraxCodeService,
  uninstallMemoraxCodeService,
  type AdapterReport,
  type MemoraxCodeLifecycleReport,
  type MemoraxCodeStatusReport,
  type NpmPackageRemovalReport,
} from "../lifecycle/orchestrator.js";
import { backendEnv } from "../config/backend-env.js";
import {
  backendServiceHome,
  BackendLifecycleLockError,
  withBackendLifecycleLock,
} from "../lifecycle/lock.js";
import {
  startBackendShutdownRequestWatcher,
  type BackendShutdownRequestWatcher,
} from "../lifecycle/backend/shutdown-request.js";
import { runtimeRecordDurabilityWarning } from "../lifecycle/backend/result.js";

// Keep process-facing CLI orchestration outside the HTTP server module.
// This preserves server.ts as the importable route factory used by tests and tools.
export function runBackendCli(argv = process.argv): void {
  const program = basename(argv[1] ?? "memorax-code-backend");
  const usageName = program === "memorax-code" || program === "memorax-code.js" ? "memorax-code" : "memorax-code-backend";
  const command = argv[2];
  if (argv.includes("--help") || argv.includes("-h")) {
    const commands = usageName === "memorax-code"
      ? "start|stop|restart|uninstall|logs|token|status"
      : "status|logs";
    console.log([
      `Usage: ${usageName} [${commands}] [--backend-url URL] [--backend-token TOKEN] [--home DIR]`,
      "[--host HOST] [--port PORT] [--rotate] [--show]",
      "[--codex-command CMD]",
      "[--codex-home DIR] [--claude-home DIR]",
      "[--clients codex|claude|codex,claude|all|none]",
      "[--json]",
      "[--marketplace-path FILE] [--plugin-source-path DIR] [--claude-command CMD] [--help]",
      "[--yes]",
      "",
      "Common local flow: memorax-code start, memorax-code status, memorax-code logs, memorax-code stop",
      "Uninstall flow: memorax-code uninstall stops the backend, removes only selected client integrations, and removes the npm package when applicable",
      "Codex plugin flow: memorax-code codex-plugin install; memorax-code codex-plugin activate --yes; memorax-code codex-plugin trust-hooks",
      "Memory CLI: memorax-cli status, memorax-cli search --query TEXT [--session-id ID], memorax-cli add --memory TEXT --type TYPE --reason REASON [--session-id ID] [--content-type code]",
      "Adapter flow: lifecycle commands use --clients when provided, otherwise persisted [clients] config; client provider settings stay client-owned.",
      "",
      "Environment: MEMORAX_CODE_BACKEND_HOST=127.0.0.1 MEMORAX_CODE_BACKEND_PORT=8787",
      "MEMORAX_CODE_BACKEND_TOKEN=<optional local token>",
    ].join("\n"));
    process.exit(0);
  }
  if (usageName === "memorax-code-backend"
    && command !== undefined
    && command !== "status"
    && command !== "logs") {
    console.error(`${usageName}: unknown command '${command}'. Run '${usageName} --help' for usage.`);
    process.exit(1);
  }
  let serviceOptions: BackendServiceOptions;
  let pendingClientHookRuntime: PendingClientHookRuntime | undefined;
  try {
    serviceOptions = parseServiceOptions(argv);
    pendingClientHookRuntime = takePendingClientHookRuntime(command, argv, serviceOptions);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  if (command === "status") {
    let backendUrl: string;
    let backendToken: string | undefined;
    try {
      backendUrl = argValue(argv, "--backend-url")
        ?? backendEnv("URL")
        ?? backendServiceEndpoint(serviceOptions).url;
      backendToken = resolveBackendConnection({
        memoraxCodeHome: serviceOptions.home,
        backendUrl,
        backendToken: argValue(argv, "--backend-token"),
      }).token;
    } catch (error) {
      const status = backendConnectionStatusFailure(error, serviceOptions);
      if (argv.includes("--json")) console.log(JSON.stringify(status, null, 2));
      else printMemoraxCodeStatus(status);
      process.exit(1);
    }
    collectMemoraxCodeStatus(backendUrl, backendToken, serviceOptions, argv).then((status) => {
      if (argv.includes("--json")) console.log(JSON.stringify(status, null, 2));
      else printMemoraxCodeStatus(status);
      process.exit(status.ok ? 0 : 1);
    }).catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
  } else if (command === "codex-plugin") {
    runCodexPluginCommand(argv).then((result) => {
      if (argv.includes("--json")) console.log(JSON.stringify(result, null, 2));
      else printCodexPluginInstallResult(result);
      process.exit(result.ok ? 0 : 1);
    }).catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
  } else if (command === "start") {
    startMemoraxCodeService(serviceOptions, argv, () => {
      activatePendingClientHookRuntime(pendingClientHookRuntime);
    }).then((result) => {
      if (argv.includes("--json")) console.log(JSON.stringify(result, null, 2));
      else printLifecycleResult(result);
      process.exit(result.ok ? 0 : 1);
    }).catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
  } else if (command === "stop") {
    stopMemoraxCodeService(serviceOptions, argv).then((result) => {
      if (argv.includes("--json")) console.log(JSON.stringify(result, null, 2));
      else printLifecycleResult(result);
      process.exit(result.ok ? 0 : 1);
    }).catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
  } else if (command === "restart") {
    restartMemoraxCodeService(serviceOptions, argv, () => {
      activatePendingClientHookRuntime(pendingClientHookRuntime);
    }).then((result) => {
      if (argv.includes("--json")) console.log(JSON.stringify(result, null, 2));
      else printLifecycleResult(result);
      process.exit(result.ok ? 0 : 1);
    }).catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
  } else if (command === "uninstall") {
    uninstallMemoraxCodeService(serviceOptions, argv).then((result) => {
      if (argv.includes("--json")) console.log(JSON.stringify(result, null, 2));
      else printLifecycleResult(result);
      process.exit(result.ok ? 0 : 1);
    }).catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
  } else if (command === "logs") {
    const result = backendServiceLogs(serviceOptions);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  } else if (command === "token") {
    runBackendTokenCommand(serviceOptions, argv).then((result) => {
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.ok ? 0 : 1);
    }).catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
  } else if (usageName === "memorax-code") {
    // `memorax-code` is the service-management CLI. An unrecognised or missing subcommand
    // is always a user error here; do not fall through to raw-server mode.
    if (command !== undefined) {
      console.error(`memorax-code: unknown command '${command}'. Run 'memorax-code --help' for usage.`);
    } else {
      console.error("memorax-code: no command given. Run 'memorax-code --help' for usage.");
    }
    process.exit(1);
  } else if (command !== undefined) {
    console.error(`${usageName}: unknown command '${command}'. Run '${usageName} --help' for usage.`);
    process.exit(1);
  } else {
    // Raw server mode: invoked directly as `memorax-code-backend` without a subcommand.
    const port = Number(backendEnv("PORT") ?? "8787");
    const host = backendEnv("HOST") ?? "127.0.0.1";
    const state = createBackendState(host);
    void startRawBackendServer(state, host, port, argv).catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
  }
}

async function startRawBackendServer(
  state: ReturnType<typeof createBackendState>,
  host: string,
  port: number,
  argv: string[],
): Promise<void> {
  const installWatchdogConfig = resolveBackendInstallWatchdogConfig();
  const clientPluginCleanup = installWatchdogConfig?.enabled
    ? await prepareClientPluginRemovalCleanup({
        memoraxCodeHome: state.sessionHome,
        codexHome: argValue(argv, "--codex-home"),
        claudeHome: argValue(argv, "--claude-home"),
        codexCommand: argValue(argv, "--codex-command"),
        claudeCommand: argValue(argv, "--claude-command"),
      })
    : undefined;
  const server = createBackendServer(state);
  let installRemovalStarted = false;
  const installWatchdog = startBackendInstallWatchdog(installWatchdogConfig, async (event) => {
    if (installRemovalStarted) return;
    installRemovalStarted = true;
    backendDebug("install_watchdog.backend_uninstalled", {
      reason: event.reason,
      missingPaths: event.missingPaths,
    });
    const cleanup = await clientPluginCleanup?.();
    if (cleanup?.ok === false) {
      backendDebug("install_watchdog.client_plugin_cleanup_failed", {
        codexOk: cleanup.codexPlugin.ok,
        codexReason: "reason" in cleanup.codexPlugin ? cleanup.codexPlugin.reason : undefined,
        claudeOk: cleanup.claudePlugin.ok,
        claudeReason: cleanup.claudePlugin.reason,
      });
    }
    server.close(() => {
      if (installWatchdogConfig?.exitProcess !== false) {
        setTimeout(() => process.exit(0), 50).unref?.();
      }
    });
  });
  installBackendShutdownControls(server, state);
  server.once("close", () => installWatchdog?.close());
  server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      console.error(`memorax-code-backend failed to listen on http://${host}:${port}: address already in use`);
      console.error("Stop the existing Backend process or set MEMORAX_CODE_BACKEND_PORT to a free port.");
    } else {
      console.error(error instanceof Error ? error.message : String(error));
    }
    process.exit(1);
  });
  server.listen(port, host, () => {
    console.log(`memorax-code-backend listening on http://${host}:${port}`);
  });
}

function installBackendShutdownControls(
  server: BackendServer,
  state: ReturnType<typeof createBackendState>,
): void {
  let stopping = false;
  let shutdownRequestWatcher: BackendShutdownRequestWatcher | undefined;
  const remove = () => {
    process.off("SIGTERM", onSigterm);
    process.off("SIGINT", onSigint);
    shutdownRequestWatcher?.close();
  };
  const stop = (source: "signal" | "request", signal?: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    remove();
    if (source === "signal") backendDebug("shutdown.signal_received", { signal });
    else backendDebug("shutdown.request_received", { pid: process.pid });
    void server.shutdown().then(
      () => process.exit(0),
      (error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      },
    );
  };
  const onSigterm = () => stop("signal", "SIGTERM");
  const onSigint = () => stop("signal", "SIGINT");
  process.once("SIGTERM", onSigterm);
  process.once("SIGINT", onSigint);
  const instanceId = backendEnv("INSTANCE_ID");
  if (process.platform === "win32" && instanceId) {
    const logWatchFailure = (error: unknown) => {
      backendDebug("shutdown.request_watch_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    };
    try {
      shutdownRequestWatcher = startBackendShutdownRequestWatcher({
        memoraxCodeHome: state.sessionHome,
        pid: process.pid,
        instanceId,
        onShutdown() {
          stop("request");
        },
        onError: logWatchFailure,
      });
    } catch (error) {
      // The verified lifecycle can still fall back to taskkill when the local
      // filesystem does not support the graceful request watcher.
      logWatchFailure(error);
    }
  }
  server.once("close", remove);
}

const PENDING_CLIENT_HOOK_RUNTIME_ENV = "MEMORAX_CODE_PENDING_CLIENT_HOOK_RUNTIME_V1";

type PendingClientHookRuntime = Readonly<{
  memoraxCodeHome: string;
  generation: ClientHookRuntimeGeneration;
}>;

function takePendingClientHookRuntime(
  command: string | undefined,
  _argv: string[],
  serviceOptions: BackendServiceOptions,
): PendingClientHookRuntime | undefined {
  const acceptsPending = command === "start" || command === "restart";
  if (!acceptsPending) return undefined;

  const raw = process.env[PENDING_CLIENT_HOOK_RUNTIME_ENV];
  if (raw === undefined) return undefined;
  delete process.env[PENDING_CLIENT_HOOK_RUNTIME_ENV];

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("pending client Hook runtime is malformed");
  }
  if (!isRecord(value)
    || value.version !== 1
    || typeof value.memoraxCodeHome !== "string"
    || !value.memoraxCodeHome.trim()
    || !isClientHookRuntimeGeneration(value.generation)) {
    throw new Error("pending client Hook runtime is invalid");
  }
  const memoraxCodeHome = resolve(value.memoraxCodeHome);
  if (memoraxCodeHome !== resolve(backendServiceHome(serviceOptions))) {
    throw new Error("pending client Hook runtime targets another MemoraX Code home");
  }
  return { memoraxCodeHome, generation: value.generation };
}

function activatePendingClientHookRuntime(
  pending: PendingClientHookRuntime | undefined,
): void {
  if (!pending) return;
  let activated;
  try {
    activated = activateClientHookRuntimeGeneration(pending);
  } catch (error) {
    throw new Error(
      `client Hook runtime activation failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (activated.durability === "uncertain") {
    console.error(
      "memorax-code: client Hook runtime activated with uncertain crash durability; retry `memorax-code start`.",
    );
  }
}

function isClientHookRuntimeGeneration(
  value: unknown,
): value is ClientHookRuntimeGeneration {
  return isRecord(value)
    && value.version === 1
    && value.runtimeAbi === CLIENT_HOOK_RUNTIME_ABI
    && typeof value.generationId === "string"
    && value.generationId !== "."
    && value.generationId !== ".."
    && /^[a-zA-Z0-9._-]{1,160}$/.test(value.generationId)
    && typeof value.packageVersion === "string"
    && value.packageVersion.trim().length > 0
    && typeof value.contentDigest === "string"
    && /^[a-f0-9]{64}$/.test(value.contentDigest)
    && typeof value.createdAt === "string"
    && Number.isFinite(Date.parse(value.createdAt));
}

type CodexPluginCommandReport = Awaited<ReturnType<
  typeof installCodexPlugin | typeof activateCodexPlugin | typeof inspectCodexPluginHooks | typeof trustCodexPluginHooks
>>;

async function runCodexPluginCommand(argv: string[]): Promise<CodexPluginCommandReport> {
  const subcommand = argv[3] ?? "install";
  if (subcommand === "activate") {
    return await activateCodexPlugin({
      codexHome: argValue(argv, "--codex-home"),
      marketplacePath: argValue(argv, "--marketplace-path"),
      pluginSourcePath: argValue(argv, "--plugin-source-path"),
      codexCommand: argValue(argv, "--codex-command"),
      workspace: argValue(argv, "--workspace"),
      yes: argv.includes("--yes"),
    });
  }
  if (subcommand === "hooks") {
    return await inspectCodexPluginHooks({
      codexHome: argValue(argv, "--codex-home"),
      codexCommand: argValue(argv, "--codex-command"),
      workspace: argValue(argv, "--workspace"),
    });
  }
  if (subcommand === "trust-hooks") {
    return await trustCodexPluginHooks({
      codexHome: argValue(argv, "--codex-home"),
      codexCommand: argValue(argv, "--codex-command"),
      workspace: argValue(argv, "--workspace"),
      yes: argv.includes("--yes"),
      check: argv.includes("--check"),
      previousHooks: codexHooksFromEnv("MEMORAX_CODE_CODEX_PREVIOUS_HOOKS_JSON"),
      selectedHooks: codexHooksFromEnv("MEMORAX_CODE_CODEX_HOOK_TRUST_SELECTION_JSON"),
    });
  }
  if (subcommand !== "install") throw new Error(`memorax-code codex-plugin: unknown command '${subcommand}'. Run 'memorax-code --help' for usage.`);
  return await installCodexPlugin({
    codexHome: argValue(argv, "--codex-home"),
    marketplacePath: argValue(argv, "--marketplace-path"),
    pluginSourcePath: argValue(argv, "--plugin-source-path"),
    codexCommand: argValue(argv, "--codex-command"),
  });
}

function printCodexPluginInstallResult(report: CodexPluginCommandReport): void {
  console.log(`${report.action}: ${report.ok ? "ok" : "needs attention"}`);
  if (report.action === "codex-plugin-hooks") {
    console.log(`codex home: ${report.codexHome}`);
    console.log(`hooks: ${report.hooks.length}`);
    console.log("backend: not started");
    return;
  }
  if (report.action === "codex-plugin-trust-hooks") {
    console.log(`codex home: ${report.codexHome}`);
    console.log(`hooks reviewed: ${report.hooks.length}`);
    console.log(`trusted hooks: ${report.trustedHooks}`);
    if (report.requiresFullReview) console.log("incremental trust: blocked by plugin marketplace identity change");
    console.log(`config: ${report.configPath}`);
    console.log("backend: not started");
    return;
  }
  const install = report.action === "codex-plugin-activate" ? report.install : report;
  console.log(`codex home: ${install.codexHome}`);
  console.log(`plugin source: ${install.pluginSourcePath}`);
  console.log(`personal marketplace: ${install.marketplacePath}`);
  if (report.action === "codex-plugin-activate") {
    console.log(`trusted hooks: ${report.trustedHooks}`);
    console.log(`config: ${report.configPath}`);
  }
  console.log("backend: not started");
}

function codexHooksFromEnv(name: string): CodexHook[] | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${name} must contain a JSON array`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${name} must contain a JSON array`);
  return parsed.map((value, index) => {
    if (!isRecord(value) || typeof value.key !== "string" || typeof value.currentHash !== "string") {
      throw new Error(`${name}[${index}] must contain string key and currentHash fields`);
    }
    return {
      key: value.key,
      currentHash: value.currentHash,
      ...(typeof value.pluginId === "string" ? { pluginId: value.pluginId } : {}),
      ...(typeof value.handlerType === "string" ? { handlerType: value.handlerType } : {}),
      ...(typeof value.eventName === "string" ? { eventName: value.eventName } : {}),
      ...(typeof value.command === "string" ? { command: value.command } : {}),
      ...(typeof value.statusMessage === "string" ? { statusMessage: value.statusMessage } : {}),
      ...(typeof value.trustStatus === "string" ? { trustStatus: value.trustStatus } : {}),
    };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function printMemoraxCodeStatus(report: MemoraxCodeStatusReport): void {
  const backend = report.backend;
  backendLog(`MemoraX Code Backend status: ${report.ok ? blueBold("Enabled") : redBold("Unavailable")}`);
  backendLog(report.ok
    ? green("MemoraX Code is ready for new client sessions.")
    : red("MemoraX Code is not ready for new client sessions."));
  backendLog(`Backend status: ${backend.ok ? blueBold("Enabled") : redBold("Unavailable")} ${backend.url}${backend.status ? ` status=${backend.status}` : ""}${backendIdentityDetail(backend.identity)}${backend.error ? ` error=${backend.error}` : ""}`);
  if (backend.service) backendLog(`Backend service: ${backend.service}`);
  if (typeof backend.authRequired === "boolean") backendLog(`Client auth: ${backend.authRequired ? "required" : "not required"}`);
  if (report.codexAdapter) {
    backendLog(`Codex adapter: ${adapterStatusLine(report.codexAdapter)}`);
  }
  if (report.claudeAdapter) backendLog(`Claude adapter: ${claudeAdapterStatusLine(report.claudeAdapter, report.codexAdapter)}`);
  if (!suppressBackendGuidance()) {
    for (const line of statusGuidance(report)) backendLog(line);
  }
}

function backendConnectionStatusFailure(
  error: unknown,
  serviceOptions: BackendServiceOptions,
): MemoraxCodeStatusReport {
  let state;
  try {
    state = readBackendServiceState(serviceOptions);
  } catch {
    // The connection error remains the first failed preflight. Service-state
    // diagnostics are reported once connection resolution succeeds.
  }
  return {
    ok: false,
    action: "status",
    backend: {
      ok: false,
      url: state?.url ?? "",
      error: error instanceof Error ? error.message : String(error),
      ...runtimeRecordErrorFields(error),
    },
  };
}

function runtimeRecordErrorFields(error: unknown): { errorCode?: string } {
  return error instanceof BackendConnectionAuthorityError
    || error instanceof RuntimeRecordError
    || error instanceof BackendLifecycleLockError
    ? { errorCode: error.code }
    : {};
}

export async function runBackendTokenCommand(
  serviceOptions: BackendServiceOptions,
  argv: string[],
  recordWriteRuntime?: RuntimeRecordWriteRuntime,
): Promise<Record<string, unknown> & { ok: boolean; action: "token" }> {
  try {
    return await withBackendLifecycleLock(serviceOptions, () => {
      if (argv.includes("--rotate")) {
        const state = readBackendServiceState(serviceOptions);
        if (state && isProcessAlive(state.pid)) {
          return {
            ok: false,
            action: "token" as const,
            error: "stop the managed Backend before rotating its token, then run `memorax-code start`",
          };
        }
      }
      const record = argv.includes("--show")
        ? readBackendToken(serviceOptions)
        : writeBackendToken(
            serviceOptions,
            argv.includes("--rotate"),
            recordWriteRuntime,
          );
      if (!record) {
        return {
          ok: false,
          action: "token" as const,
          error: "backend token file does not exist",
        };
      }
      const warning = runtimeRecordDurabilityWarning("token", record.persistence);
      return {
        ok: true,
        action: "token" as const,
        ...(warning ? { degraded: true, warnings: [warning] } : {}),
        tokenPath: record.tokenPath,
        token: record.token,
        createdAt: record.createdAt,
        rotatedAt: record.rotatedAt,
        export: `export MEMORAX_CODE_BACKEND_TOKEN=${shellSingleQuote(record.token)}`,
      };
    });
  } catch (error) {
    return {
      ok: false,
      action: "token",
      error: error instanceof Error ? error.message : String(error),
      ...runtimeRecordErrorFields(error),
    };
  }
}

function printLifecycleResult(report: MemoraxCodeLifecycleReport): void {
  const degraded = report.backend?.degraded === true;
  backendLog(`${lifecycleActionLabel(report.action)}: ${report.ok ? green(degraded ? "ok (degraded)" : "ok") : red("needs attention")}`);
  if (report.message) backendLog(report.message);
  if (report.backend) {
    const status = !report.backend.ok
      ? red("not ok")
      : report.backend.action === "stop"
        ? green(report.backend.skipped ? "kept running" : "stopped")
        : green(report.backend.degraded ? "ok (degraded)" : "ok");
    backendLog(`Backend: ${status}${report.backend.state?.url ? ` ${report.backend.state.url}` : ""}${report.backend.errorCode ? ` code=${report.backend.errorCode}` : ""}${report.backend.error ? ` error=${report.backend.error}` : ""}`);
    for (const warning of report.backend.warnings ?? []) {
      backendLog(`Warning: ${warning.message}${warning.errorCode ? ` code=${warning.errorCode}` : ""}`);
    }
  }
  if (report.codexAdapter) backendLog(`Codex adapter: ${adapterStatusLine(report.codexAdapter)}`);
  if (report.claudeAdapter) backendLog(`Claude adapter: ${adapterStatusLine(report.claudeAdapter)}`);
  if (report.codexPlugin) {
    const removed = report.codexPlugin.removedPaths.length;
    const marketplace = report.codexPlugin.marketplaceChanged ? " marketplace=updated" : " marketplace=unchanged";
    backendLog(`Codex plugin: ${codexPluginRemoveStatusLine(report.codexPlugin.pluginRemove)} paths=${removed}${marketplace}`);
  }
  if (report.npmPackageRemoval) backendLog(`npm package: ${npmPackageRemovalStatusLine(report.npmPackageRemoval)}`);
  if (!suppressBackendGuidance()) {
    for (const line of lifecycleGuidance(report)) backendLog(line);
  }
}

const BACKEND_PREFIX = "[MemoraX Code Backend]:";
const GREEN = "\x1b[32m";
const BLUE = "\x1b[34m";
const RED = "\x1b[31m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

function backendLog(message: string): void {
  console.log(`${BACKEND_PREFIX} ${message}`);
}

function green(value: string): string {
  return `${GREEN}${value}${RESET}`;
}

function blueBold(value: string): string {
  return `${BLUE}${BOLD}${value}${RESET}`;
}

function red(value: string): string {
  return `${RED}${value}${RESET}`;
}

function redBold(value: string): string {
  return `${RED}${BOLD}${value}${RESET}`;
}

function suppressBackendGuidance(): boolean {
  return ["1", "true", "yes"].includes(String(process.env.MEMORAX_CODE_BACKEND_SUPPRESS_GUIDANCE ?? "").toLowerCase());
}

function lifecycleActionLabel(action: MemoraxCodeLifecycleReport["action"]): string {
  if (action === "start") return "Start";
  if (action === "stop") return "Stop";
  if (action === "restart") return "Restart";
  if (action === "uninstall") return "Uninstall";
  return action;
}

function lifecycleGuidance(report: MemoraxCodeLifecycleReport): string[] {
  if (report.action === "start") {
    if (report.backend?.ok === false) {
      return [
        red("Backend did not start cleanly."),
        "Run `memorax-code logs` for details, then retry `memorax-code start`.",
      ];
    }
    if (!report.codexAdapter && !report.claudeAdapter) {
      return [
        green("Backend is running."),
        "Adapters were not changed for this command.",
      ];
    }
    if ((!report.codexAdapter || isAdapterReady(report.codexAdapter)) && (!report.claudeAdapter || isAdapterReady(report.claudeAdapter))) {
      return [
        green("Backend is running and adapters are enabled."),
        green("Existing sessions with the stable plugin shell select the active Hook runtime on their next user prompt."),
        "Restart or refresh a client only if its plugin shell was installed, changed, or newly enabled, or MemoraX Code is not active on the next prompt.",
      ];
    }
    return [
      red("Backend may be running, but one or more adapters are not enabled."),
      "Run `memorax-code status` for details. Restart or refresh the client after fixing the adapter.",
    ];
  }
  if (report.action === "stop") {
    return report.ok
      ? [
        green("Backend is stopped."),
        ...(report.codexAdapter ? [green("Codex Hook integration is stopped; provider config was not changed.")] : []),
        ...(report.claudeAdapter ? [green("Claude Code Hook integration is stopped; provider config was not changed.")] : []),
      ]
      : [
        red("Backend did not stop cleanly."),
        "Run `memorax-code status` and `memorax-code logs` for details.",
      ];
  }
  if (report.action === "restart") {
    return report.ok
      ? [
        green("Backend restarted."),
        green("Existing sessions with the stable plugin shell use the active Hook runtime on their next user prompt."),
        "Restart or refresh a client only if MemoraX Code is not active on the next prompt.",
      ]
      : [
        red("Backend restart needs attention."),
        "Run `memorax-code status` and `memorax-code logs` for details.",
      ];
  }
  if (report.action === "uninstall") {
    if (!report.ok) {
      return [
        red("Uninstall needs attention."),
        "Run `memorax-code status` and `memorax-code logs` before retrying.",
      ];
    }
    const clientName = report.codexAdapter && report.claudeAdapter
      ? "Codex and Claude Code"
      : report.codexAdapter
        ? "Codex"
        : report.claudeAdapter
          ? "Claude Code"
          : undefined;
    const npmPackageRemoved = report.npmPackageRemoval?.ok === true
      && report.npmPackageRemoval.skipped !== true;
    return [
      ...(npmPackageRemoved
        ? [green("MemoraX Code has been uninstalled from this npm installation.")]
        : clientName
          ? [green(`MemoraX Code has been uninstalled from ${clientName}.`)]
          : []),
      ...(clientName
        ? [green(report.codexAdapter && report.claudeAdapter
          ? "Restart or refresh Codex and Claude Code so they drop the removed adapter plugins."
          : `Restart or refresh ${clientName} so it drops the removed adapter plugin.`)]
        : []),
    ];
  }
  return [];
}

function statusGuidance(report: MemoraxCodeStatusReport): string[] {
  if (report.ok) {
    return [
      green("MemoraX Code is ready; sessions with the stable plugin shell use the active Hook runtime on their next user prompt."),
      "Restart or refresh a client only if its plugin shell was installed, changed, or newly enabled, or MemoraX Code is not active on the next prompt.",
    ];
  }
  if (!report.backend.ok) {
    if (report.backend.identity && (
      !report.backend.identity.urlMatches
      || !report.backend.identity.instanceIdMatches
      || !report.backend.identity.sessionHomeMatches
    )) {
      return [
        red("Backend identity does not match the managed connection state."),
        "Run `memorax-code stop`, verify the configured Backend endpoint, then run `memorax-code start`.",
      ];
    }
    return [
      red("Backend is not reachable."),
      "Run `memorax-code start`, then `memorax-code status`.",
    ];
  }
  if (report.codexAdapter && !isAdapterReady(report.codexAdapter)) {
    return [
      red("Codex adapter is not enabled."),
      "Run `memorax-code start`, restart or refresh Codex, then enable the MemoraX Code Codex Adapter plugin.",
    ];
  }
  if (report.claudeAdapter && !isAdapterReady(report.claudeAdapter) && !isOptionalUnconfiguredClaudeAdapter(report.claudeAdapter, report.codexAdapter)) {
    return [
      red("Claude adapter is not enabled."),
      "Run `memorax-code start`, then restart or refresh Claude Code.",
    ];
  }
  return [
    red("MemoraX Code needs attention."),
    "Run `memorax-code status` and `memorax-code logs` for details.",
  ];
}

function backendIdentityDetail(identity: MemoraxCodeStatusReport["backend"]["identity"]): string {
  if (!identity || (identity.urlMatches && identity.instanceIdMatches && identity.sessionHomeMatches)) return "";
  const mismatches = [
    !identity.urlMatches ? "url" : undefined,
    !identity.instanceIdMatches ? "instance" : undefined,
    !identity.sessionHomeMatches ? "home" : undefined,
  ].filter(Boolean);
  return ` identity_mismatch=${mismatches.join(",")}`;
}

function codexPluginRemoveStatusLine(report: { ok: boolean; skipped?: boolean; reason?: string; stderr?: string; stdout?: string }): string {
  if (report.skipped) return `skipped ${report.reason ?? "not-applicable"}`;
  if (!report.ok) return `not ok${report.stderr || report.stdout ? ` error=${report.stderr || report.stdout}` : ""}`;
  return "removed";
}

function npmPackageRemovalStatusLine(report: NpmPackageRemovalReport): string {
  if (report.skipped) return `skipped ${report.reason ?? "not-applicable"}`;
  if (!report.ok) return `not ok${report.packageName ? ` ${report.packageName}` : ""}${report.error ? ` error=${report.error}` : ""}`;
  return `removed ${report.packageName ?? "package"}`;
}

function adapterStatusLine(report: AdapterReport): string {
  if (report.error) return `not ok error=${report.error}`;
  if (report.ok === false) return `not ok ${report.message ?? report.reason ?? "failed"}`;
  if (report.skipped) return `skipped ${report.reason ?? "not-ready"}${report.message ? ` ${report.message}` : ""}`;
  if (report.backendUrlMatches === false) {
    return `not ok endpoint_mismatch configured=${report.configuredBackendUrl ?? "missing"} expected=${report.expectedBackendUrl ?? "unknown"}`;
  }
  const enabled = isAdapterReady(report);
  const skillStatus = report.codexSkills?.status ?? report.claudeSkills?.status;
  const skills = skillStatus ? ` skills=${skillStatus}` : "";
  const changed = report.changed === true ? " changed" : "";
  return `${enabled ? "ok" : "not enabled"} integration=hooks${skills}${changed}`;
}

function claudeAdapterStatusLine(report: AdapterReport, codexAdapter?: AdapterReport): string {
  if (isOptionalUnconfiguredClaudeAdapter(report, codexAdapter)) {
    return `skipped ${report.reason ?? "not-configured"}`;
  }
  return adapterStatusLine(report);
}

function argValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index >= 0) return argv[index + 1];
  const inline = argv.find((arg) => arg.startsWith(`${name}=`));
  return inline?.slice(name.length + 1);
}

function parseServiceOptions(argv: string[]): BackendServiceOptions {
  const home = argValue(argv, "--home");
  if (argv.some((arg) => arg === "--home" || arg.startsWith("--home="))
    && !home?.trim()) {
    throw new Error("memorax-code: --home requires a directory");
  }
  return {
    home,
    host: argValue(argv, "--host"),
    port: argValue(argv, "--port") ? Number(argValue(argv, "--port")) : undefined,
    authToken: argValue(argv, "--backend-token"),
  };
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
