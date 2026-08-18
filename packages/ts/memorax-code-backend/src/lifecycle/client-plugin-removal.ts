import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  cleanupCodexAfterBackendRemoval,
  type BackendRemovalCleanupReport,
} from "../clients/codex/plugin-install.js";
import { withBackendLifecycleLock } from "./lock.js";

type ClaudePluginRemovalReport = {
  ok: boolean;
  action: string;
  reason?: string;
  message?: string;
};

type ClaudePluginInstaller = {
  removeClaudePluginInstallation: (options: Record<string, unknown>) => ClaudePluginRemovalReport;
};

type OpenCodePluginRemovalReport = {
  ok: boolean;
  action: string;
  reason?: string;
  message?: string;
};

type OpenCodePluginInstaller = {
  removeOpenCodePluginInstallation: (options: Record<string, unknown>) => OpenCodePluginRemovalReport;
};

type DshPluginRemovalReport = {
  ok: boolean;
  action: string;
  skipped?: boolean;
  reason?: string;
  message?: string;
};

type DshProfileLifecycleModule = {
  withDshPluginLifecycleLock<T>(
    options: Record<string, unknown>,
    operation: (lifecycle: { remove(): DshPluginRemovalReport }) => T | Promise<T>,
  ): Promise<T>;
};

export type ClientPluginRemovalOptions = {
  memoraxCodeHome?: string;
  homeDir?: string;
  codexHome?: string;
  claudeHome?: string;
  dshHome?: string;
  dshAdapterRoot?: string;
  openCodeConfigDir?: string;
  codexCommand?: string;
  claudeCommand?: string;
  dshCommand?: string;
};

export type ClientPluginRemovalReport = {
  ok: boolean;
  action: "client-plugin-removal-cleanup";
  codexPlugin: BackendRemovalCleanupReport | ClientPluginRemovalFailure;
  claudePlugin: ClaudePluginRemovalReport | ClientPluginRemovalFailure;
  dshPlugin: DshPluginRemovalReport | ClientPluginRemovalFailure;
  opencodePlugin: OpenCodePluginRemovalReport | ClientPluginRemovalFailure;
};

type ClientPluginRemovalFailure = {
  ok: false;
  action: string;
  reason: "plugin_remove_failed";
  message: string;
};

export async function prepareClientPluginRemovalCleanup(
  options: ClientPluginRemovalOptions = {},
): Promise<() => Promise<ClientPluginRemovalReport>> {
  const claudePluginInstaller = await loadClaudePluginInstaller();
  const dshProfileLifecycle = await loadDshProfileLifecycle();
  const openCodePluginInstaller = await loadOpenCodePluginInstaller();
  const home = resolveHome(options.homeDir);
  const memoraxCodeHome = resolve(options.memoraxCodeHome ?? process.env.MEMORAX_CODE_HOME ?? join(home, ".memorax-code"));
  const claudeState = await readJsonRecord(join(memoraxCodeHome, "adapters", "claude-code", "state.json"));
  const claudeHome = options.claudeHome ?? stringField(claudeState, "claudeHome");

  return async () => {
    try {
      return await withBackendLifecycleLock({ home: memoraxCodeHome }, async () => {
        const [codexPlugin, claudePlugin, dshPlugin, opencodePlugin] = await Promise.all([
          cleanupCodexAfterBackendRemoval({
            memoraxCodeHome,
            homeDir: home,
            codexHome: options.codexHome,
            codexCommand: options.codexCommand,
          }).catch((error) => removalFailure("backend-removal-cleanup", error)),
          Promise.resolve()
            .then(() => claudePluginInstaller.removeClaudePluginInstallation({
              memoraxCodeHome,
              ...(claudeHome ? { claudeHome } : {}),
              ...(options.claudeCommand ? { claudeCommand: options.claudeCommand } : {}),
            }))
            .catch((error) => removalFailure("claude-plugin-remove", error)),
          dshProfileLifecycle.withDshPluginLifecycleLock({
            memoraxCodeHome,
            homeDir: home,
            ...(options.dshHome ? { dshHome: options.dshHome } : {}),
            ...(options.dshAdapterRoot ? { adapterRoot: options.dshAdapterRoot } : {}),
            ...(options.dshCommand ? { dshCommand: options.dshCommand } : {}),
          }, (lifecycle) => lifecycle.remove())
            .catch((error) => removalFailure("dsh-plugin-remove", error)),
          Promise.resolve()
            .then(() => openCodePluginInstaller.removeOpenCodePluginInstallation({
              memoraxCodeHome,
              ...(options.openCodeConfigDir
                ? { openCodeConfigDir: options.openCodeConfigDir }
                : {}),
            }))
            .catch((error) => removalFailure("opencode-plugin-remove", error)),
        ]);
        return {
          ok: codexPlugin.ok && claudePlugin.ok && dshPlugin.ok && opencodePlugin.ok,
          action: "client-plugin-removal-cleanup" as const,
          codexPlugin,
          claudePlugin,
          dshPlugin,
          opencodePlugin,
        };
      });
    } catch (error) {
      const failure = removalFailure("client-plugin-removal-cleanup", error);
      return {
        ok: false,
        action: "client-plugin-removal-cleanup",
        codexPlugin: failure,
        claudePlugin: failure,
        dshPlugin: failure,
        opencodePlugin: failure,
      };
    }
  };
}

async function loadClaudePluginInstaller(): Promise<ClaudePluginInstaller> {
  return await import(new URL("../../../memorax-code-claude-adapter/src/plugin-install.mjs", import.meta.url).href);
}

async function loadOpenCodePluginInstaller(): Promise<OpenCodePluginInstaller> {
  return await import(new URL("../../../memorax-code-opencode-adapter/src/plugin-install.mjs", import.meta.url).href);
}

async function loadDshProfileLifecycle(): Promise<DshProfileLifecycleModule> {
  return await import(new URL("../../../memorax-code-dsh-adapter/src/profile-lifecycle.mjs", import.meta.url).href);
}

async function readJsonRecord(path: string): Promise<Record<string, unknown> | undefined> {
  if (!existsSync(path)) return undefined;
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function resolveHome(value: string | undefined): string {
  return resolve(value ?? process.env.HOME ?? homedir());
}

function removalFailure(action: string, error: unknown): ClientPluginRemovalFailure {
  return {
    ok: false,
    action,
    reason: "plugin_remove_failed",
    message: error instanceof Error ? error.message : String(error),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
