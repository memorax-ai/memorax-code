import type { AdapterLifecycleParticipant, AdapterPluginLifecycleReport, AdapterReport } from "../../lifecycle/participant.js";

type CodeBuddyConfig = {
  enableCodeBuddyAdapter(options: Record<string, unknown>): Promise<AdapterReport>;
  disableCodeBuddyAdapter(options: Record<string, unknown>): Promise<AdapterReport>;
  readCodeBuddyAdapterStatus(options: Record<string, unknown>): Promise<AdapterReport>;
  removeCodeBuddyPluginInstallation(options: Record<string, unknown>): Promise<AdapterPluginLifecycleReport>;
};
export const codeBuddyAdapterLifecycle = {
  async status({ argv, serviceOptions }) {
    try { return await (await load()).readCodeBuddyAdapterStatus(options(argv, serviceOptions)); }
    catch (error) { return failure("status", error); }
  },
  async prepareEnable({ argv, serviceOptions }) {
    try { return await (await load()).enableCodeBuddyAdapter(options(argv, serviceOptions)); }
    catch (error) { return failure("enable", error); }
  },
  async disable({ argv, serviceOptions }) {
    try { return await (await load()).disableCodeBuddyAdapter(options(argv, serviceOptions)); }
    catch (error) { return failure("disable", error); }
  },
  async remove({ argv, serviceOptions }) {
    try { return await (await load()).removeCodeBuddyPluginInstallation(options(argv, serviceOptions)); }
    catch (error) {
      return {
        ok: false,
        action: "codebuddy-plugin-remove",
        reason: "plugin_remove_failed",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  },
} satisfies AdapterLifecycleParticipant<AdapterPluginLifecycleReport>;
async function load(): Promise<CodeBuddyConfig> { return await import(new URL("../../../../memorax-code-codebuddy-adapter/src/config.mjs", import.meta.url).href) as CodeBuddyConfig; }
function options(argv: string[], serviceOptions: { home?: string }): Record<string, unknown> { const index = argv.indexOf("--codebuddy-home"); return { ...(index >= 0 && argv[index + 1] ? { codeBuddyHome: argv[index + 1] } : {}), memoraxCodeHome: serviceOptions.home }; }
function failure(action: string, error: unknown): AdapterReport {
  return { ok: false, action, error: error instanceof Error ? error.message : String(error) };
}
