import type { AdapterLifecycleParticipant, AdapterPluginLifecycleReport, AdapterReport } from "../../lifecycle/participant.js";

type CodeBuddyConfig = {
  enableCodeBuddyAdapter(options: Record<string, unknown>): Promise<AdapterReport>;
  disableCodeBuddyAdapter(options: Record<string, unknown>): Promise<AdapterReport>;
  readCodeBuddyAdapterStatus(options: Record<string, unknown>): Promise<AdapterReport>;
  removeCodeBuddyPluginInstallation(options: Record<string, unknown>): Promise<AdapterPluginLifecycleReport>;
};
export const codeBuddyAdapterLifecycle = {
  async status({ argv, serviceOptions }) { return (await load()).readCodeBuddyAdapterStatus(options(argv, serviceOptions)); },
  async prepareEnable({ argv, serviceOptions }) { return (await load()).enableCodeBuddyAdapter(options(argv, serviceOptions)); },
  async disable({ argv, serviceOptions }) { return (await load()).disableCodeBuddyAdapter(options(argv, serviceOptions)); },
  async remove({ argv, serviceOptions }) { return (await load()).removeCodeBuddyPluginInstallation(options(argv, serviceOptions)); },
} satisfies AdapterLifecycleParticipant<AdapterPluginLifecycleReport>;
async function load(): Promise<CodeBuddyConfig> { return await import(new URL("../../../../memorax-code-codebuddy-adapter/src/config.mjs", import.meta.url).href) as CodeBuddyConfig; }
function options(argv: string[], serviceOptions: { home?: string }): Record<string, unknown> { const index = argv.indexOf("--codebuddy-home"); return { ...(index >= 0 && argv[index + 1] ? { codeBuddyHome: argv[index + 1] } : {}), memoraxCodeHome: serviceOptions.home }; }
