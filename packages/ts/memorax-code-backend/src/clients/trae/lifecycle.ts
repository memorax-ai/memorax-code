import type {
  AdapterLifecycleParticipant,
  AdapterPluginLifecycleReport,
  AdapterReport,
} from "../../lifecycle/participant.js";

export const traeAdapterLifecycle = {
  async status({ argv, serviceOptions }) {
    try {
      return await (await load()).readTraeAdapterStatus(options(argv, serviceOptions));
    } catch (error) {
      return { ok: false, action: "status", error: error instanceof Error ? error.message : String(error) };
    }
  },
  async prepareEnable({ argv, serviceOptions }) {
    try {
      return await (await load()).enableTraeAdapter(options(argv, serviceOptions));
    } catch (error) {
      return { ok: false, action: "enable", error: error instanceof Error ? error.message : String(error) };
    }
  },
  async disable({ argv, serviceOptions }) {
    try {
      return await (await load()).disableTraeAdapter(options(argv, serviceOptions));
    } catch (error) {
      return { ok: false, action: "disable", error: error instanceof Error ? error.message : String(error) };
    }
  },
  async remove({ argv, serviceOptions }) {
    try {
      return await (await load()).removeTraeAdapterInstallation(options(argv, serviceOptions));
    } catch (error) {
      return {
        ok: false,
        action: "trae-adapter-remove",
        reason: "adapter_remove_failed",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  },
} satisfies AdapterLifecycleParticipant<AdapterPluginLifecycleReport>;

function options(argv: string[], serviceOptions: { home?: string }): Record<string, unknown> {
  const traeHome = argValue(argv, "--trae-home");
  return {
    ...(traeHome ? { traeHome } : {}),
    memoraxCodeHome: serviceOptions.home,
  };
}

async function load(): Promise<{
  enableTraeAdapter(options: Record<string, unknown>): Promise<AdapterReport>;
  disableTraeAdapter(options: Record<string, unknown>): Promise<AdapterReport>;
  readTraeAdapterStatus(options: Record<string, unknown>): Promise<AdapterReport>;
  removeTraeAdapterInstallation(options: Record<string, unknown>): Promise<AdapterPluginLifecycleReport>;
}> {
  return await import(new URL("../../../../memorax-code-trae-adapter/src/config.mjs", import.meta.url).href);
}

function argValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}
