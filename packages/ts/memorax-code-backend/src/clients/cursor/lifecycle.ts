import { attachDeploymentFailure, deploymentFailure } from "../../../../memorax-code-adapter-common/src/deployment-failure.mjs";
import type {
  AdapterLifecycleParticipant,
  AdapterPluginLifecycleReport,
  AdapterReport,
} from "../../lifecycle/participant.js";

export const cursorAdapterLifecycle = {
  async status({ argv, serviceOptions }) {
    try {
      return await (await load()).readCursorAdapterStatus(options(argv, serviceOptions));
    } catch (error) {
      return { ok: false, action: "status", failure: deploymentFailure(error, "deploy"), error: error instanceof Error ? error.message : String(error) };
    }
  },
  async prepareEnable({ argv, serviceOptions }) {
    try {
      return await (await load()).enableCursorAdapter(options(argv, serviceOptions));
    } catch (error) {
      return { ok: false, action: "enable", failure: deploymentFailure(error, "deploy"), error: error instanceof Error ? error.message : String(error) };
    }
  },
  async disable({ argv, serviceOptions }) {
    try {
      return await (await load()).disableCursorAdapter(options(argv, serviceOptions));
    } catch (error) {
      return { ok: false, action: "disable", failure: deploymentFailure(error, "deploy"), error: error instanceof Error ? error.message : String(error) };
    }
  },
  async remove({ argv, serviceOptions }) {
    try {
      return await (await load()).removeCursorAdapterInstallation(options(argv, serviceOptions));
    } catch (error) {
      return {
        ok: false,
        action: "cursor-adapter-remove",
        reason: "adapter_remove_failed",
        failure: deploymentFailure(error, "plugin-remove"), message: error instanceof Error ? error.message : String(error),
      };
    }
  },
} satisfies AdapterLifecycleParticipant<AdapterPluginLifecycleReport>;

function options(argv: string[], serviceOptions: { home?: string }): Record<string, unknown> {
  const cursorHome = argValue(argv, "--cursor-home");
  return {
    ...(cursorHome ? { cursorHome } : {}),
    memoraxCodeHome: serviceOptions.home,
  };
}

async function load(): Promise<{
  enableCursorAdapter(options: Record<string, unknown>): Promise<AdapterReport>;
  disableCursorAdapter(options: Record<string, unknown>): Promise<AdapterReport>;
  readCursorAdapterStatus(options: Record<string, unknown>): Promise<AdapterReport>;
  removeCursorAdapterInstallation(options: Record<string, unknown>): Promise<AdapterPluginLifecycleReport>;
}> {
  return await import(new URL("../../../../memorax-code-cursor-adapter/src/config.mjs", import.meta.url).href)
    .catch((error) => { throw attachDeploymentFailure(error, "adapter-load"); });
}

function argValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}
