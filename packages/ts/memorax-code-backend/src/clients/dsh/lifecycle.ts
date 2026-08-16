import type {
  AdapterLifecycleBackendContext,
  AdapterLifecycleContext,
  AdapterLifecycleParticipant,
  AdapterReport,
} from "../../lifecycle/participant.js";

type DshProfileLifecycle = Readonly<{
  status(): AdapterReport;
  ensureInstalled(options?: Record<string, unknown>): AdapterReport;
  activate(options?: Record<string, unknown>): AdapterReport;
  quiesce(): AdapterReport;
  disable(options?: Record<string, unknown>): AdapterReport;
  remove(options?: Record<string, unknown>): AdapterReport;
}>;

type DshProfileLifecycleModule = Readonly<{
  collectDshAdapterStatus(options?: Record<string, unknown>): AdapterReport;
  withDshPluginLifecycleLock<T>(
    options: Record<string, unknown>,
    operation: (lifecycle: DshProfileLifecycle) => T | Promise<T>,
  ): Promise<T>;
}>;

export type DshAdapterLifecycleParticipant = AdapterLifecycleParticipant<AdapterReport>;

export const dshAdapterLifecycle = {
  async status(context) {
    try {
      return normalizeDshReport(
        (await loadDshProfileLifecycle()).collectDshAdapterStatus(dshAdapterOptions(context)),
      );
    } catch (error) {
      return dshFailure("status", error);
    }
  },
  prepareEnable: (context) => runDshLifecyclePhase(context, "prepareEnable"),
  activate: (context) => runDshLifecyclePhase(context, "activate"),
  quiesce: (context) => runDshLifecyclePhase(context, "quiesce"),
  disable: (context) => runDshLifecyclePhase(context, "disable"),
  remove: (context) => runDshLifecyclePhase(context, "remove"),
} satisfies DshAdapterLifecycleParticipant;

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

async function runDshLifecyclePhase(
  context: AdapterLifecycleContext,
  phase: "prepareEnable" | "activate" | "quiesce" | "disable" | "remove",
): Promise<AdapterReport> {
  try {
    return await withDshAdapterLifecycleLock(context, (participant) => {
      if (phase === "prepareEnable") {
        return participant.prepareEnable({ ...context, backendUrl: "" });
      }
      if (phase === "activate") {
        return participant.activate?.({ ...context, backendUrl: "" }) ?? dshMissingPhase(phase);
      }
      if (phase === "quiesce") {
        return participant.quiesce?.(context) ?? dshMissingPhase(phase);
      }
      return participant[phase](context);
    });
  } catch (error) {
    return dshFailure(phase, error);
  }
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

function dshMissingPhase(action: string): AdapterReport {
  return dshFailure(action, new Error(`DSH lifecycle participant does not implement ${action}`));
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
