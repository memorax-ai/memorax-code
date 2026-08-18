import type {
  AdapterLifecycleBackendContext,
  AdapterLifecycleContext,
  AdapterLifecycleParticipant,
  AdapterReport,
} from "../../lifecycle/participant.js";

type HermesProfileLifecycle = Readonly<{
  status(): AdapterReport;
  ensureInstalled(options?: Record<string, unknown>): AdapterReport;
  activate(): AdapterReport;
  quiesce(): AdapterReport;
  disable(): AdapterReport;
  remove(): AdapterReport;
}>;

type HermesProfileLifecycleModule = Readonly<{
  collectHermesAdapterStatus(options?: Record<string, unknown>): AdapterReport;
  withHermesPluginLifecycleLock<T>(
    options: Record<string, unknown>,
    operation: (lifecycle: HermesProfileLifecycle) => T | Promise<T>,
  ): Promise<T>;
}>;

export type HermesAdapterLifecycleParticipant = AdapterLifecycleParticipant<AdapterReport>;

export async function collectHermesAdapterLifecycleStatus(
  context: AdapterLifecycleBackendContext,
): Promise<AdapterReport> {
  try {
    return normalizeHermesReport(
      (await loadHermesProfileLifecycle()).collectHermesAdapterStatus(hermesAdapterOptions(context)),
    );
  } catch (error) {
    return hermesFailure("status", error);
  }
}

/**
 * Keep the Hermes state lock for a complete Backend lifecycle command. The caller
 * already owns the Backend lifecycle lock, establishing one lock order for
 * both user commands and native Hermes recovery.
 */
export async function withHermesAdapterLifecycleLock<T>(
  context: AdapterLifecycleContext,
  operation: (participant: HermesAdapterLifecycleParticipant) => T | Promise<T>,
): Promise<T> {
  const module = await loadHermesProfileLifecycle();
  return module.withHermesPluginLifecycleLock(hermesAdapterOptions(context), (lifecycle) => (
    operation(lockedHermesAdapterLifecycle(lifecycle))
  ));
}

function lockedHermesAdapterLifecycle(lifecycle: HermesProfileLifecycle): HermesAdapterLifecycleParticipant {
  return {
    status: () => runLockedHermesPhase("status", () => lifecycle.status()),
    prepareEnable: () => runLockedHermesPhase(
      "prepareEnable",
      () => lifecycle.ensureInstalled({ enabled: false }),
    ),
    activate: () => runLockedHermesPhase("activate", () => lifecycle.activate()),
    quiesce: () => runLockedHermesPhase("quiesce", () => lifecycle.quiesce()),
    disable: () => runLockedHermesPhase("disable", () => lifecycle.disable()),
    remove: () => runLockedHermesPhase("remove", () => lifecycle.remove()),
  };
}

async function runLockedHermesPhase(
  action: string,
  operation: () => AdapterReport,
): Promise<AdapterReport> {
  try {
    return normalizeHermesReport(operation());
  } catch (error) {
    return hermesFailure(action, error);
  }
}

function normalizeHermesReport(report: AdapterReport): AdapterReport {
  return {
    integration: "plugin",
    runtime: "hermes",
    ...report,
  };
}

function hermesAdapterOptions(context: AdapterLifecycleContext): Record<string, unknown> {
  const { argv, serviceOptions } = context;
  return {
    memoraxCodeHome: serviceOptions.home,
    ...(argValue(argv, "--hermes-home") ? { hermesHome: argValue(argv, "--hermes-home") } : {}),
    ...(argValue(argv, "--hermes-command") ? { hermesCommand: argValue(argv, "--hermes-command") } : {}),
    ...(argValue(argv, "--hermes-adapter-root")
      ? { adapterRoot: argValue(argv, "--hermes-adapter-root") }
      : {}),
    ...(argValue(argv, "--memorax-code-command")
      ? { memoraxCodeCommand: argValue(argv, "--memorax-code-command") }
      : {}),
  };
}

function hermesFailure(action: string, error: unknown): AdapterReport {
  return {
    ok: false,
    action,
    integration: "plugin",
    runtime: "hermes",
    error: error instanceof Error ? error.message : String(error),
  };
}

async function loadHermesProfileLifecycle(): Promise<HermesProfileLifecycleModule> {
  return await import(new URL("../../../../memorax-code-hermes-adapter/src/profile-lifecycle.mjs", import.meta.url).href);
}

function argValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index >= 0) return argv[index + 1];
  const inline = argv.find((arg) => arg.startsWith(`${name}=`));
  return inline?.slice(name.length + 1);
}