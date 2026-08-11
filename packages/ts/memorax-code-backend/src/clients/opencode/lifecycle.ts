import type {
  AdapterLifecycleParticipant,
  AdapterPluginLifecycleReport,
  AdapterReport,
} from "../../lifecycle/participant.js";

export const openCodeAdapterLifecycle = {
  async status({ argv, serviceOptions, backendUrl }) {
    try {
      return (await loadOpenCodePluginInstaller()).readOpenCodePluginStatus(
        openCodeAdapterOptions(argv, serviceOptions.home, backendUrl),
      );
    } catch (error) {
      return { ok: false, action: "status", error: error instanceof Error ? error.message : String(error) };
    }
  },
  async prepareEnable({ argv, serviceOptions, backendUrl }) {
    try {
      return (await loadOpenCodePluginInstaller()).ensureOpenCodePluginInstalled(
        openCodeAdapterOptions(argv, serviceOptions.home, backendUrl),
      );
    } catch (error) {
      return { ok: false, action: "enable", error: error instanceof Error ? error.message : String(error) };
    }
  },
  async disable({ argv, serviceOptions }) {
    try {
      return (await loadOpenCodePluginInstaller()).disableOpenCodePlugin(
        openCodeAdapterOptions(argv, serviceOptions.home),
      );
    } catch (error) {
      return { ok: false, action: "disable", error: error instanceof Error ? error.message : String(error) };
    }
  },
  async remove({ argv, serviceOptions }) {
    try {
      return (await loadOpenCodePluginInstaller()).removeOpenCodePluginInstallation(
        openCodeAdapterOptions(argv, serviceOptions.home),
      );
    } catch (error) {
      return {
        ok: false,
        action: "opencode-plugin-remove",
        reason: "plugin_remove_failed",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  },
} satisfies AdapterLifecycleParticipant<AdapterPluginLifecycleReport>;

function openCodeAdapterOptions(
  argv: string[],
  memoraxCodeHome: string | undefined,
  backendUrl?: string,
): Record<string, unknown> {
  const openCodeConfigDir = argValue(argv, "--opencode-config-dir");
  return {
    ...(openCodeConfigDir ? { openCodeConfigDir } : {}),
    memoraxCodeHome,
    ...(backendUrl ? { backendUrl } : {}),
  };
}

async function loadOpenCodePluginInstaller(): Promise<{
  ensureOpenCodePluginInstalled: (options: Record<string, unknown>) => AdapterReport;
  disableOpenCodePlugin: (options: Record<string, unknown>) => AdapterReport;
  removeOpenCodePluginInstallation: (options: Record<string, unknown>) => AdapterPluginLifecycleReport;
  readOpenCodePluginStatus: (options: Record<string, unknown>) => AdapterReport;
}> {
  return await import(new URL("../../../../memorax-code-opencode-adapter/src/plugin-install.mjs", import.meta.url).href);
}

function argValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}
