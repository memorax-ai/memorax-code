import { createInterface } from "node:readline/promises";
import {
  installCodexPlugin,
  isCodexPluginActive,
  isCodexPluginStaged,
  removeCodexPlugin,
  type CodexPluginRemoveReport,
} from "./plugin-install.js";
import type {
  AdapterLifecycleParticipant,
  AdapterPluginLifecycleReport,
  AdapterReport,
} from "../../lifecycle/participant.js";
import type { BackendServiceOptions } from "../../lifecycle/contracts.js";

const BACKEND_PREFIX = "[MemoraX Code Backend]:";
const GREEN = "\x1b[32m";
const RESET = "\x1b[0m";

export async function enableCodexAdapterForStart(
  argv: string[],
  serviceOptions: BackendServiceOptions,
  backendUrl: string,
): Promise<AdapterReport> {
  try {
    let options = codexAdapterOptions(argv, serviceOptions, backendUrl);
    const codexHome = typeof options.codexHome === "string" ? options.codexHome : undefined;
    if (!isCodexPluginActive({ codexHome }) && !isCodexPluginStaged({ codexHome })) {
      const installed = await maybeInstallCodexPluginForStart(argv);
      if (installed) {
        backendLog(green("Codex plugin source registered. Activate the MemoraX Code Codex Adapter plugin, then restart or refresh Codex."));
      } else if (installed === false) {
        return codexPluginNotInstalled();
      }
    }
    options = codexAdapterOptions(argv, serviceOptions, backendUrl);
    if (!isCodexPluginActive({ codexHome })) {
      return isCodexPluginStaged({ codexHome })
        ? codexPluginActivationRequired()
        : codexPluginNotInstalled();
    }
    return (await loadCodexAdapterConfig()).enableCodexAdapter(options);
  } catch (error) {
    return { ok: false, action: "enable", error: error instanceof Error ? error.message : String(error) };
  }
}

export async function readCodexAdapterStatusForLifecycle(
  argv: string[],
  serviceOptions: BackendServiceOptions,
  backendUrl?: string,
): Promise<AdapterReport> {
  try {
    return (await loadCodexAdapterConfig()).readCodexAdapterStatus(codexAdapterOptions(argv, serviceOptions, backendUrl));
  } catch (error) {
    return { ok: false, action: "status", error: error instanceof Error ? error.message : String(error) };
  }
}

export async function disableCodexAdapterForLifecycle(
  argv: string[],
  serviceOptions: BackendServiceOptions,
): Promise<AdapterReport> {
  try {
    return (await loadCodexAdapterConfig()).disableCodexAdapter(codexAdapterOptions(argv, serviceOptions));
  } catch (error) {
    return { ok: false, action: "disable", error: error instanceof Error ? error.message : String(error) };
  }
}

export const codexAdapterLifecycle = {
  status: ({ argv, serviceOptions, backendUrl }) => (
    readCodexAdapterStatusForLifecycle(argv, serviceOptions, backendUrl)
  ),
  prepareEnable: ({ argv, serviceOptions, backendUrl }) => (
    enableCodexAdapterForStart(argv, serviceOptions, backendUrl)
  ),
  disable: ({ argv, serviceOptions }) => (
    disableCodexAdapterForLifecycle(argv, serviceOptions)
  ),
  remove: ({ argv }) => removeCodexPlugin(codexPluginRemoveOptions(argv)),
} satisfies AdapterLifecycleParticipant<CodexPluginRemoveReport>;

function codexAdapterOptions(
  argv: string[],
  serviceOptions: BackendServiceOptions,
  backendUrl?: string,
): Record<string, unknown> {
  const codexHome = argValue(argv, "--codex-home");
  return {
    ...(codexHome ? { codexHome } : {}),
    memoraxCodeHome: serviceOptions.home,
    ...(backendUrl ? { backendUrl } : {}),
  };
}

function codexPluginNotInstalled(): AdapterReport {
  return {
    ok: true,
    action: "enable",
    skipped: true,
    reason: "codex_plugin_not_installed",
    message: "Codex plugin is not installed; run `memorax-code codex-plugin install`, then activate it and rerun `memorax-code start`.",
  };
}

function codexPluginActivationRequired(): AdapterReport {
  return {
    ok: true,
    action: "enable",
    skipped: true,
    reason: "codex_plugin_activation_required",
    message: "Codex plugin source is registered but not active; run `memorax-code codex-plugin activate --yes`, then rerun `memorax-code start`.",
  };
}

async function maybeInstallCodexPluginForStart(argv: string[]): Promise<boolean | undefined> {
  if (argv.includes("--json")) return undefined;
  if (argv.includes("--yes")) {
    await installCodexPlugin(codexPluginInstallOptions(argv));
    return true;
  }
  if (!canPromptOnStdin()) return undefined;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${BACKEND_PREFIX} Install MemoraX Code Codex Adapter plugin now? [y/N] `);
    if (!process.stdout.isTTY) process.stdout.write("\n");
    if (!/^y(?:es)?$/i.test(answer.trim())) return false;
    await installCodexPlugin(codexPluginInstallOptions(argv));
    return true;
  } finally {
    rl.close();
  }
}

function codexPluginInstallOptions(argv: string[]) {
  return {
    codexHome: argValue(argv, "--codex-home"),
    marketplacePath: argValue(argv, "--marketplace-path"),
    pluginSourcePath: argValue(argv, "--plugin-source-path"),
    codexCommand: argValue(argv, "--codex-command"),
  };
}

function codexPluginRemoveOptions(argv: string[]) {
  return {
    ...codexPluginInstallOptions(argv),
    workspace: argValue(argv, "--workspace"),
  };
}

function canPromptOnStdin(): boolean {
  return process.stdin.isTTY === true;
}

function backendLog(message: string): void {
  console.log(`${BACKEND_PREFIX} ${message}`);
}

function green(value: string): string {
  return `${GREEN}${value}${RESET}`;
}

function argValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

async function loadCodexAdapterConfig(): Promise<{
  enableCodexAdapter: (options: Record<string, unknown>) => AdapterReport;
  disableCodexAdapter: (options: Record<string, unknown>) => AdapterReport;
  readCodexAdapterStatus: (options: Record<string, unknown>) => AdapterReport;
}> {
  return await import(new URL("../../../../memorax-code-codex-adapter/src/config.mjs", import.meta.url).href);
}
