import { attachDeploymentFailure, deploymentFailure } from "../../../../memorax-code-adapter-common/src/deployment-failure.mjs";
import { resolveManagedClients, type ManagedClients } from "../../lifecycle/client-selection.js";
import type { AdapterLifecycleParticipant, AdapterPluginLifecycleReport, AdapterReport } from "../../lifecycle/participant.js";

type CodeBuddyConfig = {
  readManagedCodeBuddyTarget(options: Record<string, unknown>): Promise<{ codeBuddyHome: string } | undefined>;
  resolveCodeBuddyClientSelection(clients: ManagedClients, options: { memoraxCodeHome: string; codeBuddyHome?: string; workBuddyHome?: string }): Promise<ManagedClients>;
  enableCodeBuddyAdapter(options: Record<string, unknown>): Promise<AdapterReport>;
  disableCodeBuddyAdapter(options: Record<string, unknown>): Promise<AdapterReport>;
  readCodeBuddyAdapterStatus(options: Record<string, unknown>): Promise<AdapterReport>;
  removeCodeBuddyPluginInstallation(options: Record<string, unknown>): Promise<AdapterPluginLifecycleReport>;
};
export const codeBuddyAdapterLifecycle = createCodeBuddyAdapterLifecycle("codebuddy");
export const workBuddyAdapterLifecycle = createCodeBuddyAdapterLifecycle("workbuddy");

export async function resolveCodeBuddyClientSelection(clients: ManagedClients, memoraxCodeHome: string, argv: string[] = []): Promise<ManagedClients> {
  if (!clients.codebuddy || clients.workbuddy !== undefined) return clients;
  return (await load()).resolveCodeBuddyClientSelection(clients, { memoraxCodeHome,
    codeBuddyHome: homeArgument(argv, "--codebuddy-home"),
    workBuddyHome: homeArgument(argv, "--workbuddy-home"),
  });
}

function createCodeBuddyAdapterLifecycle(client: "codebuddy" | "workbuddy"): AdapterLifecycleParticipant<AdapterPluginLifecycleReport> {
  return {
    async status({ argv, serviceOptions }) {
      try { return await (await load()).readCodeBuddyAdapterStatus(await options(argv, serviceOptions, client)); }
      catch (error) { return failure("status", error); }
    },
    async prepareEnable({ argv, serviceOptions }) {
      try { return await (await load()).enableCodeBuddyAdapter(await options(argv, serviceOptions, client)); }
      catch (error) { return failure("enable", error); }
    },
    async disable({ argv, serviceOptions }) {
      try { return await (await load()).disableCodeBuddyAdapter(await options(argv, serviceOptions, client)); }
      catch (error) { return failure("disable", error); }
    },
    async remove({ argv, serviceOptions }) {
      try { return await (await load()).removeCodeBuddyPluginInstallation(await options(argv, serviceOptions, client)); }
      catch (error) {
        return {
          ok: false,
          action: `${client}-plugin-remove`,
          reason: "plugin_remove_failed",
          failure: deploymentFailure(error, "plugin-remove"), message: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}
async function load(): Promise<CodeBuddyConfig> {
  return await import(new URL("../../../../memorax-code-codebuddy-adapter/src/config.mjs", import.meta.url).href)
    .catch((error) => { throw attachDeploymentFailure(error, "adapter-load"); }) as CodeBuddyConfig;
}
async function options(argv: string[], serviceOptions: { home?: string }, client: "codebuddy" | "workbuddy"): Promise<Record<string, unknown>> {
  const workBuddyHome = homeArgument(argv, "--workbuddy-home");
  let home = client === "workbuddy" ? workBuddyHome : homeArgument(argv, "--codebuddy-home");
  const legacyHome = homeArgument(argv, "--codebuddy-home");
  const explicitCodeBuddySelection = argv.includes("--clients") && resolveManagedClients(argv).codebuddy;
  if (legacyHome && !workBuddyHome
    && (client === "workbuddy" || !explicitCodeBuddySelection)) {
    // Owned legacy WorkBuddy roots apply to that product alone. Preserve the
    // CLI's retained root unless the user explicitly selects it with this flag.
    const target = await (await load()).readManagedCodeBuddyTarget({
      client: "workbuddy", memoraxCodeHome: serviceOptions.home, codeBuddyHome: legacyHome,
    });
    if (target) home = client === "workbuddy" ? target.codeBuddyHome : undefined;
  }
  return { client, ...(home ? { codeBuddyHome: home } : {}), ...(workBuddyHome ? { workBuddyHome } : {}), memoraxCodeHome: serviceOptions.home };
}
function homeArgument(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}
function failure(action: string, error: unknown): AdapterReport {
  return { ok: false, action, failure: deploymentFailure(error, "deploy"), error: error instanceof Error ? error.message : String(error) };
}
