import { join } from "node:path";
import type {
  AdapterLifecycleBackendContext,
  AdapterLifecycleContext,
  AdapterLifecycleParticipant,
  AdapterPluginLifecycleReport,
  AdapterReport,
} from "../../lifecycle/participant.js";

export const claudeAdapterLifecycle = {
  async status(context) {
    const { argv, serviceOptions, backendUrl } = context;
    try {
      const plugin = await loadClaudePluginInstaller();
      const pluginStatus = plugin.readClaudePluginStatus(claudeAdapterOptions(argv, serviceOptions));
      if (isClaudeCliUnavailable(pluginStatus)) {
        return claudeClientNotDetected("status", { pluginStatus, managed: pluginStatus.managed });
      }
      const claudePluginSkillsRoot = nonEmptyString(pluginStatus.installPath)
        ? join(pluginStatus.installPath, "skills")
        : undefined;
      const adapterStatus = await readClaudeAdapterStatus(
        context,
        claudePluginSkillsRoot,
      );
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
      return { ok: false, action: "status", error: error instanceof Error ? error.message : String(error) };
    }
  },
  async prepareEnable({ argv, serviceOptions, backendUrl }) {
    try {
      const adapter = await loadClaudeAdapterConfig();
      const plugin = await loadClaudePluginInstaller();
      const options = claudeAdapterOptions(argv, serviceOptions, backendUrl);
      const pluginInstall = plugin.ensureClaudePluginInstalled(options);
      if (!pluginInstall.ok) {
        if (isClaudeCliUnavailable(pluginInstall)) {
          return claudeClientNotDetected("enable", { pluginInstall });
        }
        return {
          ok: false,
          action: "enable",
          pluginInstall,
          reason: pluginInstall.reason,
          message: pluginInstall.message,
        };
      }
      const claudePluginSkillsRoot = nonEmptyString(pluginInstall.installPath)
        ? join(pluginInstall.installPath, "skills")
        : undefined;
      const adapterOptions = {
        ...options,
        ...(claudePluginSkillsRoot ? { claudePluginSkillsRoot } : {}),
      };
      const enabled = adapter.enableClaudeAdapter(adapterOptions);
      if (enabled?.ok === false) return enabled;
      const status = adapter.readClaudeAdapterStatus(adapterOptions);
      return { ...enabled, ...status, action: "enable", changed: enabled.changed, pluginInstall };
    } catch (error) {
      return { ok: false, action: "enable", error: error instanceof Error ? error.message : String(error) };
    }
  },
  async disable({ argv, serviceOptions }) {
    try {
      const adapter = await loadClaudeAdapterConfig();
      return adapter.disableClaudeAdapter(claudeAdapterOptions(argv, serviceOptions));
    } catch (error) {
      return { ok: false, action: "disable", error: error instanceof Error ? error.message : String(error) };
    }
  },
  async remove({ argv, serviceOptions }) {
    try {
      return (await loadClaudePluginInstaller()).removeClaudePluginInstallation(
        claudeAdapterOptions(argv, serviceOptions),
      );
    } catch (error) {
      return {
        ok: false,
        action: "claude-plugin-remove",
        reason: "plugin_remove_failed",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  },
} satisfies AdapterLifecycleParticipant<AdapterPluginLifecycleReport>;

function isClaudeCliUnavailable(report: { reason?: string }): boolean {
  return report.reason === "claude_cli_unavailable";
}

function claudeClientNotDetected(
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
    message: "Claude Code runtime is not available; its managed integration was left unchanged.",
    ...details,
  };
}

async function readClaudeAdapterStatus(
  { argv, serviceOptions, backendUrl }: AdapterLifecycleBackendContext,
  claudePluginSkillsRoot?: string,
): Promise<AdapterReport> {
  try {
    const adapter = await loadClaudeAdapterConfig();
    return adapter.readClaudeAdapterStatus({
      ...claudeAdapterOptions(argv, serviceOptions, backendUrl),
      ...(claudePluginSkillsRoot ? { claudePluginSkillsRoot } : {}),
    });
  } catch (error) {
    return { ok: false, action: "status", error: error instanceof Error ? error.message : String(error) };
  }
}

function claudeAdapterOptions(
  argv: string[],
  serviceOptions: AdapterLifecycleContext["serviceOptions"],
  backendUrl?: string,
): Record<string, unknown> {
  return {
    ...(argValue(argv, "--claude-home") ? { claudeHome: argValue(argv, "--claude-home") } : {}),
    ...(argValue(argv, "--claude-command") ? { claudeCommand: argValue(argv, "--claude-command") } : {}),
    memoraxCodeHome: serviceOptions.home,
    ...(backendUrl ? { backendUrl } : {}),
  };
}

async function loadClaudeAdapterConfig(): Promise<{
  enableClaudeAdapter: (options: Record<string, unknown>) => AdapterReport;
  disableClaudeAdapter: (options: Record<string, unknown>) => AdapterReport;
  readClaudeAdapterStatus: (options: Record<string, unknown>) => AdapterReport;
}> {
  return await import(new URL("../../../../memorax-code-claude-adapter/src/config.mjs", import.meta.url).href);
}

async function loadClaudePluginInstaller(): Promise<{
  ensureClaudePluginInstalled: (options: Record<string, unknown>) => AdapterPluginLifecycleReport;
  removeClaudePluginInstallation: (options: Record<string, unknown>) => AdapterPluginLifecycleReport;
  readClaudePluginStatus: (options: Record<string, unknown>) => AdapterReport;
}> {
  return await import(new URL("../../../../memorax-code-claude-adapter/src/plugin-install.mjs", import.meta.url).href);
}

function argValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
