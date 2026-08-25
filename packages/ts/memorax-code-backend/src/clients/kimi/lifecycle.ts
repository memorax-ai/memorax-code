import type {
  AdapterLifecycleParticipant,
  AdapterPluginLifecycleReport,
  AdapterReport,
} from "../../lifecycle/participant.js";

export const kimiAdapterLifecycle = {
  async status({ argv, serviceOptions }) {
    try {
      return (await loadKimiInstaller()).readKimiHooksStatus(kimiOptions(argv, serviceOptions.home));
    } catch (error) {
      return { ok: false, action: "status", error: error instanceof Error ? error.message : String(error) };
    }
  },
  async prepareEnable({ argv, serviceOptions }) {
    try {
      return (await loadKimiInstaller()).ensureKimiHooksInstalled(kimiOptions(argv, serviceOptions.home));
    } catch (error) {
      return { ok: false, action: "enable", error: error instanceof Error ? error.message : String(error) };
    }
  },
  async disable({ argv, serviceOptions }) {
    try {
      return (await loadKimiInstaller()).disableKimiHooks(kimiOptions(argv, serviceOptions.home));
    } catch (error) {
      return { ok: false, action: "disable", error: error instanceof Error ? error.message : String(error) };
    }
  },
  async remove({ argv, serviceOptions }) {
    try {
      return (await loadKimiInstaller()).removeKimiHooksInstallation(kimiOptions(argv, serviceOptions.home));
    } catch (error) {
      return {
        ok: false,
        action: "kimi-hook-remove",
        reason: "hook_remove_failed",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  },
} satisfies AdapterLifecycleParticipant<AdapterPluginLifecycleReport>;

function kimiOptions(argv: string[], memoraxCodeHome: string | undefined): Record<string, unknown> {
  return {
    memoraxCodeHome,
    kimiHome: argValue(argv, "--kimi-home"),
    kimiCommand: argValue(argv, "--kimi-command"),
    nodeCommand: argValue(argv, "--node-command"),
  };
}

async function loadKimiInstaller(): Promise<{
  ensureKimiHooksInstalled: (options: Record<string, unknown>) => AdapterReport;
  readKimiHooksStatus: (options: Record<string, unknown>) => AdapterReport;
  disableKimiHooks: (options: Record<string, unknown>) => AdapterReport;
  removeKimiHooksInstallation: (options: Record<string, unknown>) => AdapterPluginLifecycleReport;
}> {
  return await import(new URL("../../../../memorax-code-kimi-adapter/src/plugin-install.mjs", import.meta.url).href);
}

function argValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}
