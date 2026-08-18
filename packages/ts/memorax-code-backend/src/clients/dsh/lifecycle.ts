import type {
  AdapterLifecycleBackendContext,
  AdapterLifecycleContext,
  AdapterLifecycleParticipant,
  AdapterReport,
} from "../../lifecycle/participant.js";

type DshProfileLifecycle = Readonly<{
  status(): AdapterReport;
  ensureInstalled(options?: Record<string, unknown>): AdapterReport;
  activate(): AdapterReport;
  quiesce(): AdapterReport;
  disable(): AdapterReport;
  remove(): AdapterReport;
}>;

type DshProfileLifecycleModule = Readonly<{
  collectDshAdapterStatus(options?: Record<string, unknown>): AdapterReport;
  withDshPluginLifecycleLock<T>(
    options: Record<string, unknown>,
    operation: (lifecycle: DshProfileLifecycle) => T | Promise<T>,
  ): Promise<T>;
}>;

export type DshAdapterLifecycleParticipant = AdapterLifecycleParticipant<AdapterReport>;

export async function collectDshAdapterLifecycleStatus(
  context: AdapterLifecycleBackendContext,
): Promise<AdapterReport> {
  try {
    return normalizeDshReport(
      (await loadDshProfileLifecycle()).collectDshAdapterStatus(dshAdapterOptions(context)),
    );
  } catch (error) {
    return dshFailure("status", error);
  }
}

/**
 * Keep the DSH state lock for a complete Backend lifecycle command. The caller
 * already owns the Backend lifecycle lock, establishing one lock order for
 * both user commands and native DSH recovery.
 */
export async function withDshAdapterLifecycleLock<T>(
  context: AdapterLifecycleContext,
  operation: (participant: DshAdapterLifecycleParticipant) => T | Promise<T>,
): Promise<T> {
  const module = await loadDshProfileLifecycle();
  return module.withDshPluginLifecycleLock(dshAdapterOptions(context), (lifecycle) => (
    operation(lockedDshAdapterLifecycle(lifecycle))
  ));
}

function lockedDshAdapterLifecycle(lifecycle: DshProfileLifecycle): DshAdapterLifecycleParticipant {
  return {
    status: () => runLockedDshPhase("status", () => lifecycle.status()),
    prepareEnable: () => runLockedDshPhase(
      "prepareEnable",
      () => lifecycle.ensureInstalled({ enabled: false }),
    ),
    activate: () => runLockedDshPhase("activate", () => lifecycle.activate()),
    quiesce: () => runLockedDshPhase("quiesce", () => lifecycle.quiesce()),
    disable: () => runLockedDshPhase("disable", () => lifecycle.disable()),
    remove: () => runLockedDshPhase("remove", () => lifecycle.remove()),
  };
}

async function runLockedDshPhase(
  action: string,
  operation: () => AdapterReport,
): Promise<AdapterReport> {
  try {
    return normalizeDshReport(operation());
  } catch (error) {
    return dshFailure(action, error);
  }
}

function normalizeDshReport(report: AdapterReport): AdapterReport {
  return {
    integration: "plugin",
    runtime: "dsh",
    ...report,
  };
}

function dshAdapterOptions(context: AdapterLifecycleContext): Record<string, unknown> {
  const { argv, serviceOptions } = context;
  return {
    memoraxCodeHome: serviceOptions.home,
    ...(argValue(argv, "--dsh-home") ? { dshHome: argValue(argv, "--dsh-home") } : {}),
    ...(argValue(argv, "--dsh-command") ? { dshCommand: argValue(argv, "--dsh-command") } : {}),
    ...(argValue(argv, "--dsh-adapter-root")
      ? { adapterRoot: argValue(argv, "--dsh-adapter-root") }
      : {}),
    ...(argValue(argv, "--memorax-code-command")
      ? { memoraxCodeCommand: argValue(argv, "--memorax-code-command") }
      : {}),
  };
}

function dshFailure(action: string, error: unknown): AdapterReport {
  return {
    ok: false,
    action,
    integration: "plugin",
    runtime: "dsh",
    error: error instanceof Error ? error.message : String(error),
  };
}

async function loadDshProfileLifecycle(): Promise<DshProfileLifecycleModule> {
  return await import(new URL("../../../../memorax-code-dsh-adapter/src/profile-lifecycle.mjs", import.meta.url).href);
}

function argValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index >= 0) return argv[index + 1];
  const inline = argv.find((arg) => arg.startsWith(`${name}=`));
  return inline?.slice(name.length + 1);
}
