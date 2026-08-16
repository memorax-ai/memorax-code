import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { claudeSettingsPath, defaultClaudeHome, defaultMemoraxCodeHome, installedMarketplacePath } from "./adapter-paths.mjs";
import { atomicWriteJson, readJsonFile, stringOption } from "./config-utils.mjs";
import {
  CLAUDE_PLUGIN_HOOK_COMMAND_FILES,
  collectClaudePluginArtifactSources,
  describeClaudePluginArtifactProblems,
  inspectClaudePluginArtifact,
} from "./plugin-artifact-contract.mjs";
import { resolveWindowsCliInvocation } from "../../memorax-code-adapter-common/src/windows-cli-invocation.mjs";

const MARKETPLACE_NAME = "memorax-code-local";
const PLUGIN_ID = "memorax-code-claude-adapter@memorax-code-local";
const ADAPTER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STABLE_SHELL_REQUIRED_FILES = Object.freeze([
  ".claude-plugin/plugin.json",
  "hooks/hooks.json",
  "hooks/runtime-shell.json",
  "hooks/runtime-hook.mjs",
  "hooks/hook-launcher.mjs",
  "runtime-hooks/capture-cwd.mjs",
  "runtime-hooks/ensure-backend.mjs",
  "runtime-hooks/memory-cli-session.mjs",
  "runtime-hooks/memory-skill-reminder.mjs",
  "runtime-hooks/memory-turn.mjs",
  "memorax-code-adapter-common/src/backend-connection.mjs",
  "memorax-code-adapter-common/src/hooks/capture-cwd-hook.mjs",
  "memorax-code-adapter-common/src/hooks/client-hook-launcher.mjs",
  "memorax-code-adapter-common/src/config-utils.mjs",
  "memorax-code-adapter-common/src/hooks/ensure-backend-runner.mjs",
  "memorax-code-adapter-common/src/hooks/hook-runtime-generation.mjs",
  "memorax-code-adapter-common/src/hooks/memory-skill-reminder-hook.mjs",
  "memorax-code-adapter-common/src/hooks/memory-skill-reminder-policy.mjs",
  "memorax-code-adapter-common/src/repo-memory/repo-memory-auto-build.mjs",
  "memorax-code-adapter-common/src/repo-memory/repo-memory-job-context.mjs",
  "memorax-code-adapter-common/src/repo-memory/repo-procedure-memory-context.mjs",
  "memorax-code-adapter-common/src/repo-memory/repo-user-profile-context.mjs",
  "memorax-code-adapter-common/src/runtime-record.mjs",
]);

export function ensureClaudePluginInstalled(options = {}) {
  const claudeHome = options.claudeHome ?? defaultClaudeHome();
  const memoraxCodeHome = options.memoraxCodeHome ?? defaultMemoraxCodeHome();
  const configuredPath = configuredMarketplacePath(claudeHome);
  const marketplacePath = options.marketplacePath
    ?? (marketplaceExists(configuredPath) ? configuredPath : installedMarketplacePath(memoraxCodeHome));
  const claudeCommand = stringOption(options.claudeCommand) ?? process.env.MEMORAX_CODE_CLAUDE_COMMAND ?? "claude";
  if (!marketplacePath || !existsSync(join(marketplacePath, ".claude-plugin", "marketplace.json"))) {
    return {
      ok: false,
      action: "claude-plugin-install",
      reason: "marketplace_missing",
      message: `MemoraX Code Claude marketplace is missing: ${marketplacePath}`,
      claudeHome,
      marketplacePath,
    };
  }

  mkdirSync(claudeHome, { recursive: true });
  const current = listClaudePlugins(claudeCommand, claudeHome, options);
  if (!current.ok) return installFailure("plugin_status_failed", current, claudeHome, marketplacePath);
  const marketplaceStatus = listClaudeMarketplaces(claudeCommand, claudeHome, options);
  if (!marketplaceStatus.ok) {
    return installFailure("marketplace_status_failed", marketplaceStatus, claudeHome, marketplacePath);
  }
  const registeredMarketplace = marketplaceStatus.marketplaces.find((entry) => entry?.name === MARKETPLACE_NAME);
  const marketplaceReplaced = Boolean(
    registeredMarketplace && !marketplaceUsesPath(registeredMarketplace, marketplacePath),
  );
  const previouslyInstalled = current.plugins.find((entry) => entry?.id === PLUGIN_ID);
  const expectedVersion = expectedPluginVersion();
  if (registeredMarketplace
    && !marketplaceReplaced
    && installedPluginShellIsCurrent(previouslyInstalled, expectedVersion)) {
    let installedPlugin = previouslyInstalled;
    const wasEnabled = installedPlugin.enabled === true;
    if (installedPlugin.enabled !== true) {
      const enable = runClaudePluginCommand(
        claudeCommand,
        claudeHome,
        ["plugin", "enable", PLUGIN_ID, "--scope", "user"],
        options,
      );
      if (!enable.ok) return installFailure("plugin_enable_failed", enable, claudeHome, marketplacePath);
      const refreshed = listClaudePlugins(claudeCommand, claudeHome, options);
      if (!refreshed.ok) return installFailure("plugin_verify_failed", refreshed, claudeHome, marketplacePath);
      installedPlugin = refreshed.plugins.find((entry) => entry?.id === PLUGIN_ID);
      if (!installedPluginShellIsCurrent(installedPlugin, expectedVersion)
        || installedPlugin?.enabled !== true) {
        return {
          ok: false,
          action: "claude-plugin-install",
          reason: "plugin_shell_verify_failed",
          message: "Claude did not preserve the current MemoraX Code plugin shell after enablement.",
          claudeHome,
          marketplacePath,
        };
      }
    }
    const installPath = stringOption(installedPlugin.installPath);
    writeInstalledPluginMetadata(installPath, claudeCommand);
    writePluginState({
      claudeHome,
      memoraxCodeHome,
      installPath,
      marketplacePath,
      pluginVersion: expectedVersion,
    });
    return {
      ok: true,
      action: "claude-plugin-install",
      claudeHome,
      marketplacePath,
      marketplace: MARKETPLACE_NAME,
      plugin: PLUGIN_ID,
      pluginVersion: expectedVersion,
      installPath,
      enabled: true,
      updated: false,
      shellUnchanged: true,
      restartRequired: !wasEnabled,
      message: wasEnabled
        ? "Claude plugin shell is current; active sessions keep their loaded shell and select runtime generations per turn."
        : "Claude plugin shell is current and has been enabled. Restart or refresh Claude Code to load it.",
    };
  }
  let installed = previouslyInstalled;
  if (marketplaceReplaced) {
    if (installed) {
      const uninstall = runClaudePluginCommand(
        claudeCommand,
        claudeHome,
        ["plugin", "uninstall", PLUGIN_ID, "--scope", "user", "--yes", "--keep-data"],
        { ...options, allowNotFound: true },
      );
      if (!uninstall.ok) {
        return installFailure("stale_plugin_uninstall_failed", uninstall, claudeHome, marketplacePath);
      }
      installed = undefined;
    }
    const remove = removeClaudeMarketplace(claudeCommand, claudeHome, options);
    if (!remove.ok) return installFailure("marketplace_replace_failed", remove, claudeHome, marketplacePath);
  }
  const marketplaceArgs = registeredMarketplace && !marketplaceReplaced
    ? ["plugin", "marketplace", "update", MARKETPLACE_NAME]
    : ["plugin", "marketplace", "add", marketplacePath];
  const marketplace = runClaudePluginCommand(claudeCommand, claudeHome, marketplaceArgs, options);
  if (!marketplace.ok) {
    return installFailure(
      installed ? "marketplace_update_failed" : "marketplace_add_failed",
      marketplace,
      claudeHome,
      marketplacePath,
    );
  }
  const pluginArgs = installed
    ? ["plugin", "update", PLUGIN_ID, "--scope", "user"]
    : ["plugin", "install", PLUGIN_ID, "--scope", "user"];
  const plugin = runClaudePluginCommand(claudeCommand, claudeHome, pluginArgs, options);
  if (!plugin.ok) {
    return installFailure(
      installed ? "plugin_update_failed" : "plugin_install_failed",
      plugin,
      claudeHome,
      marketplacePath,
    );
  }
  let refreshed = listClaudePlugins(claudeCommand, claudeHome, options);
  if (!refreshed.ok) return installFailure("plugin_verify_failed", refreshed, claudeHome, marketplacePath);
  let installedPlugin = refreshed.plugins.find((entry) => entry?.id === PLUGIN_ID);
  if (installedPlugin && installedPlugin.enabled !== true) {
    const enable = runClaudePluginCommand(
      claudeCommand,
      claudeHome,
      ["plugin", "enable", PLUGIN_ID, "--scope", "user"],
      options,
    );
    if (!enable.ok) return installFailure("plugin_enable_failed", enable, claudeHome, marketplacePath);
    refreshed = listClaudePlugins(claudeCommand, claudeHome, options);
    if (!refreshed.ok) return installFailure("plugin_verify_failed", refreshed, claudeHome, marketplacePath);
    installedPlugin = refreshed.plugins.find((entry) => entry?.id === PLUGIN_ID);
  }
  const verification = verifyInstalledPlugin(installedPlugin, expectedVersion);
  if (!verification.ok) {
    return {
      ok: false,
      action: "claude-plugin-install",
      reason: verification.reason,
      message: verification.message,
      claudeHome,
      marketplacePath,
      expectedVersion,
      installedVersion: stringOption(installedPlugin?.version),
      installPath: stringOption(installedPlugin?.installPath),
    };
  }
  writeInstalledPluginMetadata(verification.installPath, claudeCommand);
  writePluginState({
    claudeHome,
    memoraxCodeHome,
    installPath: verification.installPath,
    marketplacePath,
    pluginVersion: expectedVersion,
  });

  return {
    ok: true,
    action: "claude-plugin-install",
    claudeHome,
    marketplacePath,
    marketplace: MARKETPLACE_NAME,
    plugin: PLUGIN_ID,
    pluginVersion: expectedVersion,
    installPath: verification.installPath,
    enabled: true,
    updated: Boolean(previouslyInstalled),
    ...(marketplaceReplaced ? { marketplaceReplaced: true } : {}),
    restartRequired: true,
    message: "Restart or refresh Claude Code to load the verified MemoraX Code memory Hooks.",
  };
}

function writeInstalledPluginMetadata(installPath, claudeCommand) {
  atomicWriteJson(join(installPath, ".memorax-code-package.json"), {
    version: 1,
    memoraxCodeCommand: process.argv[1],
    claudeCommand,
    writtenAt: new Date().toISOString(),
  });
}

function writePluginState({
  claudeHome,
  memoraxCodeHome,
  installPath,
  marketplacePath,
  pluginVersion,
}) {
  atomicWriteJson(pluginStatePath(memoraxCodeHome, claudeHome), {
    version: 1,
    plugin: PLUGIN_ID,
    pluginVersion,
    installPath,
    marketplace: MARKETPLACE_NAME,
    claudeHome: resolve(claudeHome),
    marketplacePath,
    updatedAt: new Date().toISOString(),
  });
}

function configuredMarketplacePath(claudeHome) {
  const settings = readJsonFile(claudeSettingsPath(claudeHome));
  if (settings?.unreadable) return undefined;
  return stringOption(settings?.value?.extraKnownMarketplaces?.[MARKETPLACE_NAME]?.source?.path);
}

export function removeClaudePluginInstallation(options = {}) {
  const claudeHome = options.claudeHome ?? defaultClaudeHome();
  const memoraxCodeHome = options.memoraxCodeHome ?? defaultMemoraxCodeHome();
  const claudeCommand = stringOption(options.claudeCommand) ?? process.env.MEMORAX_CODE_CLAUDE_COMMAND ?? "claude";
  const statePath = pluginStatePath(memoraxCodeHome, claudeHome);
  if (!hasPluginRegistration(claudeHome) && !existsSync(statePath)) {
    return {
      ok: true,
      action: "claude-plugin-remove",
      skipped: true,
      reason: "not_registered",
      claudeHome,
      marketplace: MARKETPLACE_NAME,
      plugin: PLUGIN_ID,
    };
  }
  mkdirSync(claudeHome, { recursive: true });

  const plugin = runClaudePluginCommand(
    claudeCommand,
    claudeHome,
    ["plugin", "uninstall", PLUGIN_ID, "--scope", "user", "--yes", "--keep-data"],
    { ...options, allowNotFound: true },
  );
  if (!plugin.ok) return removeFailure("plugin_uninstall_failed", plugin, claudeHome);
  const marketplace = removeClaudeMarketplace(claudeCommand, claudeHome, options);
  if (!marketplace.ok) return removeFailure("marketplace_remove_failed", marketplace, claudeHome);
  rmSync(statePath, { force: true });

  return {
    ok: true,
    action: "claude-plugin-remove",
    claudeHome,
    marketplace: MARKETPLACE_NAME,
    plugin: PLUGIN_ID,
  };
}

export function readClaudePluginStatus(options = {}) {
  const claudeHome = options.claudeHome ?? defaultClaudeHome();
  const memoraxCodeHome = options.memoraxCodeHome ?? defaultMemoraxCodeHome();
  const managed = hasPluginRegistration(claudeHome) || existsSync(pluginStatePath(memoraxCodeHome, claudeHome));
  if (!managed) {
    return { ok: true, action: "claude-plugin-status", installed: false, enabled: false, managed: false, skipped: true, reason: "not_managed" };
  }
  const claudeCommand = stringOption(options.claudeCommand) ?? process.env.MEMORAX_CODE_CLAUDE_COMMAND ?? "claude";
  const result = listClaudePlugins(claudeCommand, claudeHome, options);
  if (!result.ok) return { ok: false, action: "claude-plugin-status", installed: false, enabled: false, managed: true, reason: result.reason, message: result.error };
  const plugin = result.plugins.find((entry) => entry?.id === PLUGIN_ID);
  const installed = Boolean(plugin);
  const enabled = plugin?.enabled === true;
  return {
    ok: installed && enabled,
    action: "claude-plugin-status",
    installed,
    enabled,
    managed: true,
    plugin: PLUGIN_ID,
    ...(plugin?.version ? { pluginVersion: plugin.version } : {}),
    ...(plugin?.installPath ? { installPath: plugin.installPath } : {}),
    ...(!installed ? { reason: "plugin_not_installed", message: "MemoraX Code Claude plugin is not installed." } : {}),
    ...(installed && !enabled ? { reason: "plugin_disabled", message: "MemoraX Code Claude plugin is installed but disabled." } : {}),
  };
}

function marketplaceExists(path) {
  return Boolean(path && existsSync(join(path, ".claude-plugin", "marketplace.json")));
}

function pluginStatePath(memoraxCodeHome, claudeHome) {
  const resolvedHome = resolve(claudeHome);
  let canonicalHome = resolvedHome;
  try {
    canonicalHome = realpathSync(resolvedHome);
  } catch {
    // A not-yet-created home has no symlink identity to preserve.
  }
  const homeKey = createHash("sha256").update(canonicalHome).digest("hex").slice(0, 16);
  return join(memoraxCodeHome, "adapters", "claude-code", "plugins", `${homeKey}.json`);
}

function hasPluginRegistration(claudeHome) {
  const settings = readJsonFile(claudeSettingsPath(claudeHome));
  if (settings?.unreadable) return false;
  const marketplaces = settings?.value?.extraKnownMarketplaces;
  const plugins = settings?.value?.enabledPlugins;
  return Boolean(
    (marketplaces && Object.prototype.hasOwnProperty.call(marketplaces, MARKETPLACE_NAME))
    || (plugins && Object.prototype.hasOwnProperty.call(plugins, PLUGIN_ID)),
  );
}

function expectedPluginVersion() {
  const manifest = readJsonFile(join(ADAPTER_ROOT, ".claude-plugin", "plugin.json"));
  const version = stringOption(manifest?.value?.version);
  if (!version) throw new Error("MemoraX Code Claude plugin manifest has no version.");
  return version;
}

function installedPluginShellIsCurrent(plugin, expectedVersion) {
  if (!plugin
    || plugin.version !== expectedVersion
    || !stringOption(plugin.installPath)) {
    return false;
  }
  const installPath = plugin.installPath;
  const expected = readJsonFile(join(ADAPTER_ROOT, "hooks", "runtime-shell.json"))?.value;
  const installed = readJsonFile(join(installPath, "hooks", "runtime-shell.json"))?.value;
  const expectedManifest = readJsonFile(join(ADAPTER_ROOT, ".claude-plugin", "plugin.json"))?.value;
  const installedManifest = readJsonFile(join(installPath, ".claude-plugin", "plugin.json"))?.value;
  const expectedHooks = readJsonFile(join(ADAPTER_ROOT, "hooks", "hooks.json"))?.value;
  const installedHooks = readJsonFile(join(installPath, "hooks", "hooks.json"))?.value;
  if (expected?.version !== 1
    || expectedManifest?.version !== expectedVersion
    || installedManifest?.version !== expectedManifest.version
    || installed?.version !== expected.version
    || installed?.runtimeAbi !== expected.runtimeAbi
    || installed?.shellVersion !== expected.shellVersion
    || !expectedHooks
    || !isDeepStrictEqual(installedHooks, expectedHooks)) {
    return false;
  }
  return STABLE_SHELL_REQUIRED_FILES.every((relativePath) => regularFile(join(
    installPath,
    ...relativePath.split("/"),
  )));
}

function regularFile(path) {
  try {
    const metadata = lstatSync(path);
    return metadata.isFile() && !metadata.isSymbolicLink();
  } catch {
    return false;
  }
}

function listClaudePlugins(command, claudeHome, options = {}) {
  const result = runClaudePluginCommand(
    command,
    claudeHome,
    ["plugin", "list", "--json"],
    { ...options, captureOutput: true },
  );
  if (!result.ok) {
    return { ok: false, reason: result.reason ?? "plugin_status_failed", error: result.error };
  }
  try {
    const plugins = JSON.parse(result.output || "[]");
    if (!Array.isArray(plugins)) throw new Error("plugin list is not an array");
    return { ok: true, plugins };
  } catch {
    return { ok: false, reason: "plugin_status_invalid", error: "Claude CLI returned invalid plugin status JSON." };
  }
}

function listClaudeMarketplaces(command, claudeHome, options = {}) {
  const result = runClaudePluginCommand(
    command,
    claudeHome,
    ["plugin", "marketplace", "list", "--json"],
    { ...options, captureOutput: true },
  );
  if (!result.ok) {
    return { ok: false, reason: result.reason ?? "marketplace_status_failed", error: result.error };
  }
  try {
    const marketplaces = JSON.parse(result.output || "[]");
    if (!Array.isArray(marketplaces)) throw new Error("marketplace list is not an array");
    return { ok: true, marketplaces };
  } catch {
    return {
      ok: false,
      reason: "marketplace_status_invalid",
      error: "Claude CLI returned invalid marketplace status JSON.",
    };
  }
}

function marketplaceUsesPath(marketplace, marketplacePath) {
  if (marketplace?.source !== "directory") return false;
  const registeredPath = stringOption(marketplace.path);
  if (!registeredPath) return false;
  try {
    return realpathSync(registeredPath) === realpathSync(marketplacePath);
  } catch {
    return resolve(registeredPath) === resolve(marketplacePath);
  }
}

function removeClaudeMarketplace(command, claudeHome, options = {}) {
  return runClaudePluginCommand(
    command,
    claudeHome,
    ["plugin", "marketplace", "remove", MARKETPLACE_NAME],
    { ...options, allowNotFound: true },
  );
}

function verifyInstalledPlugin(plugin, expectedVersion) {
  if (!plugin) {
    return { ok: false, reason: "plugin_not_installed", message: "Claude CLI did not report the MemoraX Code plugin after installation." };
  }
  if (plugin.enabled !== true) {
    return { ok: false, reason: "plugin_disabled", message: "Claude reported the MemoraX Code plugin as disabled after enablement." };
  }
  if (plugin.version !== expectedVersion) {
    return {
      ok: false,
      reason: "plugin_version_mismatch",
      message: `Claude installed MemoraX Code plugin ${plugin.version ?? "unknown"}; expected ${expectedVersion}.`,
    };
  }
  const installPath = stringOption(plugin.installPath);
  if (!installPath) {
    return { ok: false, reason: "plugin_install_path_missing", message: "Claude did not report the MemoraX Code plugin install path." };
  }
  const artifactVerification = verifyInstalledPluginArtifacts(installPath);
  if (!artifactVerification.ok) return artifactVerification;
  return { ok: true, installPath };
}

function verifyInstalledPluginArtifacts(installPath) {
  let artifactSources;
  try {
    artifactSources = collectClaudePluginArtifactSources({ adapterRoot: ADAPTER_ROOT });
  } catch (error) {
    return {
      ok: false,
      reason: "plugin_artifact_contract_invalid",
      message: `MemoraX Code's Claude plugin source contract is invalid: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const artifactInspection = inspectClaudePluginArtifact(installPath, artifactSources);
  if (!artifactInspection.ok) {
    return {
      ok: false,
      reason: "plugin_artifacts_invalid",
      message: `Claude MemoraX Code plugin has incomplete or unsafe installed artifacts: ${describeClaudePluginArtifactProblems(artifactInspection)}`,
    };
  }
  const hooks = readJsonFile(join(installPath, "hooks", "hooks.json"));
  const serializedHooks = hooks?.value ? JSON.stringify(hooks.value) : "";
  if (CLAUDE_PLUGIN_HOOK_COMMAND_FILES.some((file) => !serializedHooks.includes(file))) {
    return {
      ok: false,
      reason: "plugin_hooks_invalid",
      message: "Claude MemoraX Code plugin Hook manifest does not register the memory authority Hooks.",
    };
  }
  return { ok: true };
}

function runClaudePluginCommand(command, claudeHome, args, options = {}) {
  const env = { ...process.env, CLAUDE_CONFIG_DIR: claudeHome };
  let invocation;
  try {
    invocation = resolveWindowsCliInvocation(command, args, {
      ...options.windowsCliResolution,
      env,
    });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  const result = spawnSync(invocation.command, invocation.args, {
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  });
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  if (options.allowNotFound && result.status === 1 && /not found/i.test(output)) {
    return { ok: true, status: result.status, skipped: true };
  }
  if (result.error) {
    return {
      ok: false,
      ...(result.error.code === "ENOENT" ? { reason: "claude_cli_unavailable" } : {}),
      error: result.error.message,
    };
  }
  if (result.status !== 0) {
    return { ok: false, status: result.status, error: output || `Claude CLI exited with status ${result.status}` };
  }
  return { ok: true, status: result.status, ...(options.captureOutput ? { output: result.stdout } : {}) };
}

function installFailure(reason, command, claudeHome, marketplacePath) {
  return {
    ok: false,
    action: "claude-plugin-install",
    reason: command.reason ?? reason,
    message: command.error,
    claudeHome,
    marketplacePath,
  };
}

function removeFailure(reason, command, claudeHome) {
  return {
    ok: false,
    action: "claude-plugin-remove",
    reason,
    message: command.error,
    claudeHome,
  };
}
