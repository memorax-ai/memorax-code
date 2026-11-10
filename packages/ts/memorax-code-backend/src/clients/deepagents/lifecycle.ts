import { attachDeploymentFailure, deploymentFailure } from "../../../../memorax-code-adapter-common/src/deployment-failure.mjs";
import { join } from "node:path";
import type {
  AdapterLifecycleBackendContext,
  AdapterLifecycleContext,
  AdapterLifecycleParticipant,
  AdapterPluginLifecycleReport,
  AdapterReport,
} from "../../lifecycle/participant.js";

export const deepAgentsAdapterLifecycle = {
  async status(context) {
    const { argv, serviceOptions, backendUrl } = context;
    try {
      const plugin = await loadDeepAgentsPluginInstaller();
      const pluginStatus = plugin.readDeepAgentsPluginStatus(deepAgentsAdapterOptions(argv, serviceOptions));
      if (isDeepAgentsCliUnavailable(pluginStatus)) {
        return deepAgentsClientNotDetected("status", { pluginStatus, managed: pluginStatus.managed });
      }
      const skillsRoot = nonEmptyString(pluginStatus.installPath)
        ? join(pluginStatus.installPath, "skills")
        : undefined;
      const adapterStatus = await readDeepAgentsAdapterStatus(context, skillsRoot);
      return {
        ...adapterStatus,
        ok: adapterStatus.ok !== false && pluginStatus.ok !== false,
        installed: adapterStatus.installed === true && pluginStatus.installed === true,
        enabled: adapterStatus.enabled === true && pluginStatus.enabled === true,
        managed: pluginStatus.managed,
        pluginStatus,
        ...(pluginStatus.ok === false ? { reason: pluginStatus.reason, message: pluginStatus.message } : {}),
      };
    } catch (error) {
      return { ok: false, action: "status", failure: deploymentFailure(error, "deploy"), error: error instanceof Error ? error.message : String(error) };
    }
  },
  async prepareEnable({ argv, serviceOptions, backendUrl }) {
    try {
      const adapter = await loadDeepAgentsAdapterConfig();
      const plugin = await loadDeepAgentsPluginInstaller();
      const options = deepAgentsAdapterOptions(argv, serviceOptions, backendUrl);
      const pluginInstall = plugin.ensureDeepAgentsPluginInstalled(options);
      if (!pluginInstall.ok) {
        if (isDeepAgentsCliUnavailable(pluginInstall)) {
          return deepAgentsClientNotDetected("enable", { pluginInstall });
        }
        return {
          ok: false,
          action: "enable",
          pluginInstall,
          reason: pluginInstall.reason,
          message: pluginInstall.message,
        };
      }
      const skillsRoot = nonEmptyString(pluginInstall.installPath)
        ? join(pluginInstall.installPath, "skills")
        : undefined;
      const adapterOptions = {
        ...options,
        ...(skillsRoot ? { deepAgentsPluginSkillsRoot: skillsRoot } : {}),
      };
      const enabled = adapter.enableDeepAgentsAdapter(adapterOptions);
      if (enabled?.ok === false) return enabled;
      const status = adapter.readDeepAgentsAdapterStatus(adapterOptions);
      return { ...enabled, ...status, action: "enable", changed: enabled.changed, pluginInstall };
    } catch (error) {
      return { ok: false, action: "enable", failure: deploymentFailure(error, "deploy"), error: error instanceof Error ? error.message : String(error) };
    }
  },
  async disable({ argv, serviceOptions }) {
    try {
      const adapter = await loadDeepAgentsAdapterConfig();
      return adapter.disableDeepAgentsAdapter(deepAgentsAdapterOptions(argv, serviceOptions));
    } catch (error) {
      return { ok: false, action: "disable", failure: deploymentFailure(error, "deploy"), error: error instanceof Error ? error.message : String(error) };
    }
  },
  async remove({ argv, serviceOptions }) {
    try {
      return (await loadDeepAgentsPluginInstaller()).removeDeepAgentsPluginInstallation(
        deepAgentsAdapterOptions(argv, serviceOptions),
      );
    } catch (error) {
      return {
        ok: false,
        action: "deepagents-plugin-remove",
        reason: "plugin_remove_failed",
        failure: deploymentFailure(error, "plugin-remove"), message: error instanceof Error ? error.message : String(error),
      };
    }
  },
} satisfies AdapterLifecycleParticipant<AdapterPluginLifecycleReport>;

function isDeepAgentsCliUnavailable(report: { reason?: string }): boolean {
  return report.reason === "deepagents_cli_unavailable";
}

function deepAgentsClientNotDetected(
  action: string,
  details: Pick<AdapterReport, "managed" | "pluginInstall" | "pluginStatus"> = {},
): AdapterReport {
  return {
    ok: true,
    action,
    installed: false,
    enabled: false,
    skipped: true,
    reason: "client_not_detected",
    message: "Deep Agents Code runtime is not available; its managed integration was left unchanged.",
    ...details,
  };
}

async function readDeepAgentsAdapterStatus(
  { argv, serviceOptions, backendUrl }: AdapterLifecycleBackendContext,
  deepAgentsPluginSkillsRoot?: string,
): Promise<AdapterReport> {
  try {
    const adapter = await loadDeepAgentsAdapterConfig();
    return adapter.readDeepAgentsAdapterStatus({
      ...deepAgentsAdapterOptions(argv, serviceOptions, backendUrl),
      ...(deepAgentsPluginSkillsRoot ? { deepAgentsPluginSkillsRoot } : {}),
    });
  } catch (error) {
    return { ok: false, action: "status", failure: deploymentFailure(error, "deploy"), error: error instanceof Error ? error.message : String(error) };
  }
}

function deepAgentsAdapterOptions(
  argv: string[],
  serviceOptions: AdapterLifecycleContext["serviceOptions"],
  backendUrl?: string,
): Record<string, unknown> {
  return {
    ...(argValue(argv, "--deepagents-home") ? { deepAgentsHome: argValue(argv, "--deepagents-home") } : {}),
    ...(argValue(argv, "--deepagents-command") ? { deepAgentsCommand: argValue(argv, "--deepagents-command") } : {}),
    memoraxCodeHome: serviceOptions.home,
    ...(backendUrl ? { backendUrl } : {}),
  };
}

async function loadDeepAgentsAdapterConfig(): Promise<{
  enableDeepAgentsAdapter: (options: Record<string, unknown>) => AdapterReport;
  disableDeepAgentsAdapter: (options: Record<string, unknown>) => AdapterReport;
  readDeepAgentsAdapterStatus: (options: Record<string, unknown>) => AdapterReport;
}> {
  return await import(new URL("../../../../memorax-code-deepagents-adapter/src/config.mjs", import.meta.url).href)
    .catch((error) => { throw attachDeploymentFailure(error, "adapter-load"); });
}

async function loadDeepAgentsPluginInstaller(): Promise<{
  ensureDeepAgentsPluginInstalled: (options: Record<string, unknown>) => AdapterPluginLifecycleReport;
  removeDeepAgentsPluginInstallation: (options: Record<string, unknown>) => AdapterPluginLifecycleReport;
  readDeepAgentsPluginStatus: (options: Record<string, unknown>) => AdapterReport;
}> {
  return await import(new URL("../../../../memorax-code-deepagents-adapter/src/plugin-install.mjs", import.meta.url).href)
    .catch((error) => { throw attachDeploymentFailure(error, "adapter-load"); });
}

function argValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
