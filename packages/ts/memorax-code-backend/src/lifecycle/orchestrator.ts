import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BackendConnectionAuthorityError } from "../../../memorax-code-adapter-common/src/backend-connection.mjs";
import { RuntimeRecordError } from "../../../memorax-code-adapter-common/src/runtime-record.mjs";
import { runBackendStatus } from "./backend/status.js";
import {
  readBackendServiceState,
  preflightBackendServiceStart,
  startBackendService,
  stopBackendService,
} from "./backend/service.js";
import type { BackendServiceOptions } from "./contracts.js";
import {
  backendServiceHome,
  BackendLifecycleLockError,
  withBackendLifecycleLock,
} from "./lock.js";
import { seedMissingMemoraxCodeConfig } from "../provider/memorax/config.js";
import { runProcessWithWindowsNpm } from "../shared/windows-cli-invocation.js";
import { loadManagedClientsConfig, resolveManagedClients, type ManagedClients } from "./client-selection.js";
import { clearActiveManagedClients, readActiveManagedClients, writeActiveManagedClients } from "./active-clients.js";
import { codexAdapterLifecycle } from "../clients/codex/lifecycle.js";
import { claudeAdapterLifecycle } from "../clients/claude/lifecycle.js";
import { openCodeAdapterLifecycle } from "../clients/opencode/lifecycle.js";
import type {
  AdapterReport,
} from "./participant.js";
export type {
  AdapterPluginLifecycleReport,
  AdapterReport,
} from "./participant.js";

export type MemoraxCodeStatusReport = {
  ok: boolean;
  action: "status";
  backend: Awaited<ReturnType<typeof runBackendStatus>>;
  codexAdapter?: AdapterReport;
  claudeAdapter?: AdapterReport;
  opencodeAdapter?: AdapterReport;
};

export type MemoraxCodeLifecycleReport = {
  ok: boolean;
  action: "start" | "stop" | "restart" | "uninstall";
  reason?: string;
  message?: string;
  backend?: Awaited<ReturnType<typeof startBackendService | typeof stopBackendService>>;
  codexAdapter?: AdapterReport;
  claudeAdapter?: AdapterReport;
  opencodeAdapter?: AdapterReport;
  codexPlugin?: Awaited<ReturnType<typeof codexAdapterLifecycle.remove>>;
  npmPackageRemoval?: NpmPackageRemovalReport;
  removesPlugin?: boolean;
  removesUserState?: false;
};

export type NpmPackageRemovalReport = {
  ok: boolean;
  action: "npm-package-remove";
  skipped?: boolean;
  reason?: string;
  packageRoot?: string;
  packageName?: string;
  stdout?: string;
  stderr?: string;
  error?: string;
};

type MemoraxCodeStopContext = Readonly<{
  memoraxCodeHome: string;
  activeClients: ManagedClients | undefined;
  clients: ManagedClients;
}>;

type MemoraxCodeStopExecution = Readonly<{
  report: MemoraxCodeLifecycleReport;
  remainingClients: ManagedClients | undefined;
}>;


export async function collectMemoraxCodeStatus(
  backendUrl: string,
  backendToken: string | undefined,
  serviceOptions: BackendServiceOptions,
  argv: string[],
): Promise<MemoraxCodeStatusReport> {
  const clients = managedClientsFor(argv, serviceOptions, { preferActive: true });
  let serviceState;
  try {
    serviceState = readBackendServiceState(serviceOptions);
  } catch (error) {
    return {
      ok: false,
      action: "status",
      backend: {
        ok: false,
        url: backendUrl,
        error: error instanceof Error ? error.message : String(error),
        ...runtimeRecordErrorFields(error),
      },
    };
  }
  const backend = await runBackendStatus(
    backendUrl,
    backendToken,
    serviceOptions.timeoutMs ?? 5000,
    serviceState
      ? {
          url: serviceState.url,
          instanceId: serviceState.instanceId,
          sessionHome: memoraxCodeHomeForService(serviceOptions),
        }
      : undefined,
  );
  const codexAdapter = clients.codex
    ? await codexAdapterLifecycle.status({ argv, serviceOptions, backendUrl })
    : undefined;
  const claudeAdapter = clients.claude
    ? await claudeAdapterLifecycle.status({ argv, serviceOptions, backendUrl })
    : undefined;
  const opencodeAdapter = clients.opencode
    ? await openCodeAdapterLifecycle.status({ argv, serviceOptions, backendUrl })
    : undefined;
  const codexReady = codexAdapter ? isAdapterReady(codexAdapter) : true;
  const claudeReady = claudeAdapter ? isAdapterReady(claudeAdapter) : true;
  const opencodeReady = opencodeAdapter ? isAdapterReady(opencodeAdapter) : true;
  return {
    ok: backend.ok
      && codexReady
      && opencodeReady
      && (isOptionalUnconfiguredClaudeAdapter(claudeAdapter, codexAdapter) || claudeReady),
    action: "status",
    backend,
    ...(codexAdapter ? { codexAdapter } : {}),
    ...(claudeAdapter ? { claudeAdapter } : {}),
    ...(opencodeAdapter ? { opencodeAdapter } : {}),
  };
}

export async function startMemoraxCodeService(
  serviceOptions: BackendServiceOptions,
  argv: string[],
  commitReadyState?: (report: MemoraxCodeLifecycleReport) => void | Promise<void>,
): Promise<MemoraxCodeLifecycleReport> {
  return withMemoraxCodeLifecycleLock("start", serviceOptions, async () => {
    const report = await startMemoraxCodeServiceLocked(serviceOptions, argv);
    if (report.ok) await commitReadyState?.(report);
    return report;
  });
}

async function startMemoraxCodeServiceLocked(
  serviceOptions: BackendServiceOptions,
  argv: string[],
): Promise<MemoraxCodeLifecycleReport> {
  const memoraxCodeHome = memoraxCodeHomeForService(serviceOptions);
  let backendUrl: string;
  try {
    backendUrl = expectedBackendUrl(serviceOptions);
  } catch (error) {
    return {
      ok: false,
      action: "start",
      backend: {
        ok: false,
        action: "start",
        error: error instanceof Error ? error.message : String(error),
        ...runtimeRecordErrorFields(error),
      },
    };
  }
  const serviceStateFailure = backendServiceStatePreflight(serviceOptions, "start");
  if (serviceStateFailure) {
    return { ok: false, action: "start", backend: serviceStateFailure };
  }
  const config = loadManagedClientsConfig(memoraxCodeHome);
  const clients = resolveManagedClients(argv, config);
  const previousClients = readActiveManagedClients(memoraxCodeHome);
  // A failed Backend ownership check must leave the active client generation
  // and its conservative cleanup marker untouched.
  const stopped = await stopBackendService(serviceOptions);
  if (!stopped.ok) {
    return {
      ok: false,
      action: "start",
      backend: { ...stopped, action: "start" },
    };
  }
  const deselectedCodex = previousClients?.codex && !clients.codex
    ? await codexAdapterLifecycle.disable({ argv, serviceOptions })
    : undefined;
  const deselectedClaude = previousClients?.claude && !clients.claude
    ? await claudeAdapterLifecycle.disable({ argv, serviceOptions })
    : undefined;
  const deselectedOpenCode = previousClients?.opencode && !clients.opencode
    ? await openCodeAdapterLifecycle.disable({ argv, serviceOptions })
    : undefined;
  if (deselectedCodex?.ok === false || deselectedClaude?.ok === false || deselectedOpenCode?.ok === false) {
    return {
      ok: false,
      action: "start",
      backend: await recoverBackendAfterStartPreparationFailure(
        serviceOptions,
        "adapter_disable_failed",
      ),
      ...(deselectedCodex ? { codexAdapter: deselectedCodex } : {}),
      ...(deselectedClaude ? { claudeAdapter: deselectedClaude } : {}),
      ...(deselectedOpenCode ? { opencodeAdapter: deselectedOpenCode } : {}),
    };
  }
  // The marker is a conservative cleanup scope, not a readiness signal. Persist
  // it before later steps can fail so an unqualified stop/uninstall still
  // restores every client integration that this start may touch.
  try {
    writeActiveManagedClients(memoraxCodeHome, clients);
    await seedMissingMemoraxCodeConfig(memoraxCodeHomeForService(serviceOptions));
  } catch (error) {
    return {
      ok: false,
      action: "start",
      reason: "lifecycle_state_prepare_failed",
      message: error instanceof Error ? error.message : String(error),
      backend: await recoverBackendAfterStartPreparationFailure(
        serviceOptions,
        "lifecycle_state_prepare_failed",
      ),
    };
  }
  const codexAdapter = clients.codex
    ? await codexAdapterLifecycle.prepareEnable({ argv, serviceOptions, backendUrl })
    : undefined;
  if (codexAdapter?.ok === false) {
    return {
      ok: false,
      action: "start",
      backend: await recoverBackendAfterStartPreparationFailure(
        serviceOptions,
        "codex_adapter_enable_failed",
      ),
      codexAdapter,
    };
  }
  const claudeAdapter = clients.claude
    ? await claudeAdapterLifecycle.prepareEnable({ argv, serviceOptions, backendUrl })
    : undefined;
  const opencodeAdapter = clients.opencode
    ? await openCodeAdapterLifecycle.prepareEnable({ argv, serviceOptions, backendUrl })
    : undefined;
  if (opencodeAdapter?.ok === false) {
    return {
      ok: false,
      action: "start",
      backend: await recoverBackendAfterStartPreparationFailure(
        serviceOptions,
        "opencode_adapter_enable_failed",
      ),
      ...(codexAdapter ? { codexAdapter } : {}),
      ...(claudeAdapter ? { claudeAdapter } : {}),
      opencodeAdapter,
    };
  }
  const backendStartOptions: BackendServiceOptions = {
    ...serviceOptions,
    claudeProjectsRoot: claudeProjectsRootForStart(argv, claudeAdapter),
  };
  const backend = await startBackendService(backendStartOptions);
  if (!backend.ok) {
    const disabledCodex = codexAdapter
      ? await codexAdapterLifecycle.disable({ argv, serviceOptions })
      : undefined;
    const disabledOpenCode = opencodeAdapter
      ? await openCodeAdapterLifecycle.disable({ argv, serviceOptions })
      : undefined;
    return {
      ok: false,
      action: "start",
      backend,
      ...(disabledCodex ? { codexAdapter: disabledCodex } : {}),
      ...(claudeAdapter ? { claudeAdapter } : {}),
      ...(disabledOpenCode ? { opencodeAdapter: disabledOpenCode } : {}),
    };
  }
  return {
    ok: claudeAdapter?.ok !== false,
    action: "start",
    backend,
    ...(codexAdapter ? { codexAdapter } : {}),
    ...(claudeAdapter ? { claudeAdapter } : {}),
    ...(opencodeAdapter ? { opencodeAdapter } : {}),
  };
}

function claudeProjectsRootForStart(
  argv: string[],
  claudeAdapter: AdapterReport | undefined,
): string | false {
  if (claudeAdapter?.ok === false || claudeAdapter?.enabled !== true) return false;
  const claudeHome = argValue(argv, "--claude-home")?.trim()
    || process.env.CLAUDE_CONFIG_DIR?.trim()
    || process.env.CLAUDE_HOME?.trim()
    || join(homedir(), ".claude");
  return join(resolve(claudeHome), "projects");
}

function expectedBackendUrl(serviceOptions: BackendServiceOptions): string {
  return preflightBackendServiceStart(serviceOptions).url;
}

export async function stopMemoraxCodeService(
  serviceOptions: BackendServiceOptions,
  argv: string[],
): Promise<MemoraxCodeLifecycleReport> {
  return withMemoraxCodeLifecycleLock("stop", serviceOptions, () =>
    stopMemoraxCodeServiceLocked(serviceOptions, argv));
}

async function stopMemoraxCodeServiceLocked(
  serviceOptions: BackendServiceOptions,
  argv: string[],
): Promise<MemoraxCodeLifecycleReport> {
  const context = memoraxCodeStopContext(serviceOptions, argv);
  const execution = await executeMemoraxCodeStop(serviceOptions, argv, context);
  if (execution.report.ok) commitActiveManagedClients(context.memoraxCodeHome, execution.remainingClients);
  return execution.report;
}

async function executeMemoraxCodeStop(
  serviceOptions: BackendServiceOptions,
  argv: string[],
  context: MemoraxCodeStopContext,
): Promise<MemoraxCodeStopExecution> {
  const { activeClients, clients } = context;
  const serviceStateFailure = backendServiceStatePreflight(serviceOptions, "stop");
  if (serviceStateFailure) {
    return {
      report: {
        ok: false,
        action: "stop",
        backend: serviceStateFailure,
      },
      remainingClients: activeClients,
    };
  }
  const remaining = activeClients && hasExplicitClientSelection(argv)
    ? {
      codex: activeClients.codex && !clients.codex,
      claude: activeClients.claude && !clients.claude,
      opencode: activeClients.opencode && !clients.opencode,
    }
    : undefined;
  const hasRemainingClients = remaining?.codex === true
    || remaining?.claude === true
    || remaining?.opencode === true;
  const backendOnlyStop = !clients.codex && !clients.claude && !clients.opencode;
  const needsBackendStop = backendOnlyStop || !hasRemainingClients;
  // A true partial stop keeps the shared Backend for remaining clients. Every
  // other stop establishes Backend shutdown before mutating client state.
  const stoppedBackend = needsBackendStop
    ? await stopBackendService(serviceOptions)
    : undefined;
  if (stoppedBackend?.ok === false) {
    return {
      report: {
        ok: false,
        action: "stop",
        backend: stoppedBackend,
      },
      remainingClients: activeClients,
    };
  }
  const codexAdapter = clients.codex
    ? await codexAdapterLifecycle.disable({ argv, serviceOptions })
    : undefined;
  const claudeAdapter = clients.claude
    ? await claudeAdapterLifecycle.disable({ argv, serviceOptions })
    : undefined;
  const opencodeAdapter = clients.opencode
    ? await openCodeAdapterLifecycle.disable({ argv, serviceOptions })
    : undefined;
  const adaptersOk = codexAdapter?.ok !== false
    && claudeAdapter?.ok !== false
    && opencodeAdapter?.ok !== false;
  const backend = stoppedBackend
    ?? (adaptersOk
      ? preservedBackendResult(serviceOptions, "active_clients_remaining")
      : preservedBackendResult(serviceOptions, "adapter_disable_failed"));
  const ok = backend.ok
    && codexAdapter?.ok !== false
    && claudeAdapter?.ok !== false
    && opencodeAdapter?.ok !== false;
  return {
    report: {
      ok,
      action: "stop",
      backend,
      ...(codexAdapter ? { codexAdapter } : {}),
      ...(claudeAdapter ? { claudeAdapter } : {}),
      ...(opencodeAdapter ? { opencodeAdapter } : {}),
    },
    remainingClients: remaining && hasRemainingClients ? remaining : undefined,
  };
}

export async function restartMemoraxCodeService(
  serviceOptions: BackendServiceOptions,
  argv: string[],
  commitReadyState?: (report: MemoraxCodeLifecycleReport) => void | Promise<void>,
): Promise<MemoraxCodeLifecycleReport> {
  return withMemoraxCodeLifecycleLock("restart", serviceOptions, async () => {
    const report = await restartMemoraxCodeServiceLocked(serviceOptions, argv);
    if (report.ok) await commitReadyState?.(report);
    return report;
  });
}

async function restartMemoraxCodeServiceLocked(
  serviceOptions: BackendServiceOptions,
  argv: string[],
): Promise<MemoraxCodeLifecycleReport> {
  try {
    expectedBackendUrl(serviceOptions);
  } catch (error) {
    return {
      ok: false,
      action: "restart",
      backend: {
        ok: false,
        action: "restart",
        error: error instanceof Error ? error.message : String(error),
        ...runtimeRecordErrorFields(error),
      },
    };
  }
  const started = await startMemoraxCodeServiceLocked(serviceOptions, argv);
  return { ...started, action: "restart" };
}

export async function uninstallMemoraxCodeService(
  serviceOptions: BackendServiceOptions,
  argv: string[],
): Promise<MemoraxCodeLifecycleReport> {
  return withMemoraxCodeLifecycleLock("uninstall", serviceOptions, () =>
    uninstallMemoraxCodeServiceLocked(serviceOptions, argv));
}

async function uninstallMemoraxCodeServiceLocked(
  serviceOptions: BackendServiceOptions,
  argv: string[],
): Promise<MemoraxCodeLifecycleReport> {
  const context = memoraxCodeStopContext(serviceOptions, argv);
  const { activeClients, clients, memoraxCodeHome } = context;
  const configuredClients = managedClientsFor([], serviceOptions);
  const canRemoveSharedPackage = includesManagedClients(clients, configuredClients)
    && (!activeClients || includesManagedClients(clients, activeClients));
  const stopExecution = await executeMemoraxCodeStop(serviceOptions, argv, context);
  const stopped = stopExecution.report;
  if (!stopped.ok) {
    return {
      ...stopped,
      action: "uninstall",
      npmPackageRemoval: skippedNpmPackageRemoval("lifecycle_stop_failed"),
      removesPlugin: false,
      removesUserState: false,
    };
  }
  const codexPlugin = clients.codex
    ? await codexAdapterLifecycle.remove({ argv, serviceOptions })
    : undefined;
  const claudePlugin = clients.claude
    ? await claudeAdapterLifecycle.remove({ argv, serviceOptions })
    : undefined;
  const opencodePlugin = clients.opencode
    ? await openCodeAdapterLifecycle.remove({ argv, serviceOptions })
    : undefined;
  const pluginCleanupOk = codexPlugin?.ok !== false
    && claudePlugin?.ok !== false
    && opencodePlugin?.ok !== false;
  const npmPackageRemoval = !pluginCleanupOk
    ? skippedNpmPackageRemoval("plugin_cleanup_failed")
    : canRemoveSharedPackage
      ? await removeNpmPackageIfInstalled(argv)
      : skippedNpmPackageRemoval("partial_client_uninstall");
  const claudeAdapter = stopped.claudeAdapter && claudePlugin
    ? { ...stopped.claudeAdapter, pluginRemove: claudePlugin }
    : stopped.claudeAdapter;
  const opencodeAdapter = stopped.opencodeAdapter && opencodePlugin
    ? { ...stopped.opencodeAdapter, pluginRemove: opencodePlugin }
    : stopped.opencodeAdapter;
  const ok = pluginCleanupOk && npmPackageRemoval.ok !== false;
  if (ok) commitActiveManagedClients(memoraxCodeHome, stopExecution.remainingClients);
  return {
    ...stopped,
    ok,
    action: "uninstall",
    ...(codexPlugin ? { codexPlugin } : {}),
    ...(claudeAdapter ? { claudeAdapter } : {}),
    ...(opencodeAdapter ? { opencodeAdapter } : {}),
    npmPackageRemoval,
    removesPlugin: codexPlugin?.ok === true || claudePlugin?.ok === true || opencodePlugin?.ok === true,
    removesUserState: false,
  };
}

function skippedNpmPackageRemoval(reason: string): NpmPackageRemovalReport {
  return { ok: true, action: "npm-package-remove", skipped: true, reason };
}

async function removeNpmPackageIfInstalled(argv: string[]): Promise<NpmPackageRemovalReport> {
  if (argv.includes("--no-npm-uninstall")) {
    return { ok: true, action: "npm-package-remove", skipped: true, reason: "disabled_by_flag" };
  }
  const packageRoot = await currentNpmPackageRoot();
  if (!packageRoot) return { ok: true, action: "npm-package-remove", skipped: true, reason: "not_running_from_npm_package" };
  const packageJson = await readPackageJson(packageRoot);
  const packageName = typeof packageJson.name === "string" && packageJson.name.trim() ? packageJson.name : "@memorax/memorax-code";
  const npmExecPath = nonEmptyString(process.env.MEMORAX_CODE_NPM_EXEC_PATH)
    ? process.env.MEMORAX_CODE_NPM_EXEC_PATH
    : process.env.npm_execpath;
  const npmCommandOverride = nonEmptyString(process.env.MEMORAX_CODE_NPM_COMMAND) ? process.env.MEMORAX_CODE_NPM_COMMAND : undefined;
  const directNpmEntrypoint = (
    npmExecPath
    && existsSync(npmExecPath)
    && (npmCommandOverride || process.platform !== "win32")
  ) ? npmExecPath : undefined;
  const npmCommand = npmCommandOverride ?? (directNpmEntrypoint ? process.execPath : "npm");
  const npmArgs = directNpmEntrypoint
    ? [directNpmEntrypoint, "uninstall", "-g", packageName]
    : ["uninstall", "-g", packageName];
  const result = await runProcessWithWindowsNpm(
    npmCommand,
    npmArgs,
    { cwd: homedir(), env: process.env },
  );
  return {
    ok: result.ok,
    action: "npm-package-remove",
    packageRoot,
    packageName,
    stdout: result.stdout,
    stderr: result.stderr,
    ...(result.ok ? {} : { error: result.stderr || result.stdout || "npm uninstall failed" }),
  };
}

async function currentNpmPackageRoot(): Promise<string | undefined> {
  const override = nonEmptyString(process.env.MEMORAX_CODE_NPM_PACKAGE_ROOT) ? resolve(process.env.MEMORAX_CODE_NPM_PACKAGE_ROOT) : undefined;
  if (override && await isMemoraxCodeNpmPackageRoot(override)) return override;
  let current = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth += 1) {
    if (await isMemoraxCodeNpmPackageRoot(current)) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

async function isMemoraxCodeNpmPackageRoot(dir: string): Promise<boolean> {
  try {
    const packageJson = await readPackageJson(dir);
    const packageName = typeof packageJson.name === "string" ? packageJson.name : "";
    return packageName.includes("memorax-code") && existsSync(join(dir, "bin", "memorax-code.mjs"));
  } catch {
    return false;
  }
}

async function readPackageJson(dir: string): Promise<Record<string, unknown>> {
  const parsed = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

function managedClientsFor(
  argv: string[],
  serviceOptions: BackendServiceOptions,
  options: { preferActive?: boolean } = {},
): ManagedClients {
  const memoraxCodeHome = memoraxCodeHomeForService(serviceOptions);
  if (hasExplicitClientSelection(argv)) return resolveManagedClients(argv);
  if (options.preferActive && !hasExplicitClientSelection(argv)) {
    const active = readActiveManagedClients(memoraxCodeHome);
    if (active) return active;
  }
  return resolveManagedClients(argv, loadManagedClientsConfig(memoraxCodeHome));
}

function memoraxCodeStopContext(
  serviceOptions: BackendServiceOptions,
  argv: string[],
): MemoraxCodeStopContext {
  const memoraxCodeHome = memoraxCodeHomeForService(serviceOptions);
  return {
    memoraxCodeHome,
    activeClients: readActiveManagedClients(memoraxCodeHome),
    clients: managedClientsFor(argv, serviceOptions, { preferActive: true }),
  };
}

function commitActiveManagedClients(memoraxCodeHome: string, clients: ManagedClients | undefined): void {
  if (clients) writeActiveManagedClients(memoraxCodeHome, clients);
  else clearActiveManagedClients(memoraxCodeHome);
}

function hasExplicitClientSelection(argv: string[]): boolean {
  return argv.includes("--clients");
}

function argValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function includesManagedClients(selection: ManagedClients, required: ManagedClients): boolean {
  return (!required.codex || selection.codex)
    && (!required.claude || selection.claude)
    && (!required.opencode || selection.opencode);
}

function preservedBackendResult(
  serviceOptions: BackendServiceOptions,
  reason: string,
  action = "stop",
): Awaited<ReturnType<typeof stopBackendService>> {
  const state = readBackendServiceState(serviceOptions);
  return {
    ok: true,
    action,
    skipped: true,
    reason,
    ...(state ? { state, alreadyRunning: true } : { alreadyRunning: false }),
  };
}

async function recoverBackendAfterStartPreparationFailure(
  serviceOptions: BackendServiceOptions,
  reason: string,
): Promise<Awaited<ReturnType<typeof startBackendService>>> {
  try {
    const recovery = await startBackendService(serviceOptions);
    return {
      ...recovery,
      action: "start",
      reason: recovery.ok
        ? `${reason}_backend_recovered`
        : `${reason}_backend_recovery_failed`,
    };
  } catch (error) {
    return {
      ok: false,
      action: "start",
      reason: `${reason}_backend_recovery_failed`,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function backendServiceStatePreflight(
  serviceOptions: BackendServiceOptions,
  action: string,
): NonNullable<MemoraxCodeLifecycleReport["backend"]> | undefined {
  try {
    readBackendServiceState(serviceOptions);
    return undefined;
  } catch (error) {
    return {
      ok: false,
      action,
      error: error instanceof Error ? error.message : String(error),
      ...runtimeRecordErrorFields(error),
    };
  }
}

function runtimeRecordErrorFields(error: unknown): { errorCode?: string } {
  return error instanceof BackendConnectionAuthorityError
    || error instanceof RuntimeRecordError
    || error instanceof BackendLifecycleLockError
    ? { errorCode: error.code }
    : {};
}

function memoraxCodeHomeForService(serviceOptions: BackendServiceOptions): string {
  return backendServiceHome(serviceOptions);
}

async function withMemoraxCodeLifecycleLock(
  action: MemoraxCodeLifecycleReport["action"],
  serviceOptions: BackendServiceOptions,
  operation: () => Promise<MemoraxCodeLifecycleReport>,
): Promise<MemoraxCodeLifecycleReport> {
  try {
    return await withBackendLifecycleLock(serviceOptions, operation);
  } catch (error) {
    if (!(error instanceof BackendLifecycleLockError)) throw error;
    return {
      ok: false,
      action,
      backend: {
        ok: false,
        action,
        error: error.message,
        errorCode: error.code,
      },
    };
  }
}

export function isAdapterReady(report: AdapterReport): boolean {
  const integration = report.integration ?? report.state?.integration;
  return (integration === "hooks" || integration === "plugin")
    && report.ok !== false
    && report.installed === true
    && report.enabled === true
    && report.backendUrlMatches !== false
    && report.codexSkills?.ok !== false
    && report.claudeSkills?.ok !== false
    && report.opencodeSkills?.ok !== false;
}


export function isOptionalUnconfiguredClaudeAdapter(report: AdapterReport | undefined, codexAdapter: AdapterReport | undefined): boolean {
  return Boolean(
    report
      && codexAdapter
      && isAdapterReady(codexAdapter)
      && report.ok !== false
      && report.installed !== true
      && !report.error,
  );
}


function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
