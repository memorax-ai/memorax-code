import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { defaultDeepAgentsHome, defaultMemoraxCodeHome, installedMarketplacePath } from "./adapter-paths.mjs";
import { atomicWriteJson, readJsonFile, stringOption } from "./config-utils.mjs";
import {
  DEEPAGENTS_PLUGIN_HOOK_COMMAND_FILES,
  collectDeepAgentsPluginArtifactSources,
  describeDeepAgentsPluginArtifactProblems,
  inspectDeepAgentsPluginArtifact,
} from "./plugin-artifact-contract.mjs";
import { attachDeploymentFailure, deploymentFailure } from "../../memorax-code-adapter-common/src/deployment-failure.mjs";
import { resolveWindowsCliInvocation } from "../../memorax-code-adapter-common/src/windows-cli-invocation.mjs";

const MARKETPLACE_NAME = "memorax-code-deepagents-local";
const PLUGIN_NAME = "memorax-code-deepagents-adapter";
const PLUGIN_ID = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;
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
  "memorax-code-adapter-common/src/backend-command.mjs",
  "memorax-code-adapter-common/src/hooks/capture-cwd-hook.mjs",
  "memorax-code-adapter-common/src/hooks/client-hook-launcher.mjs",
  "memorax-code-adapter-common/src/config-utils.mjs",
  "memorax-code-adapter-common/src/diagnostic-record.mjs",
  "memorax-code-adapter-common/src/setup-completion.mjs",
  "memorax-code-adapter-common/src/hooks/ensure-backend-runner.mjs",
  "memorax-code-adapter-common/src/hooks/hook-diagnostics.mjs",
  "memorax-code-adapter-common/src/hooks/hook-runtime-generation.mjs",
  "memorax-code-adapter-common/src/hooks/memory-skill-reminder-hook.mjs",
  "memorax-code-adapter-common/src/hooks/memory-search-guidance.mjs",
  "memorax-code-adapter-common/src/hooks/memory-skill-reminder-policy.mjs",
  "memorax-code-adapter-common/src/repo-memory/repo-memory-auto-build.mjs",
  "memorax-code-adapter-common/src/repo-memory/repo-memory-job-artifacts.mjs",
  "memorax-code-adapter-common/src/repo-memory/repo-memory-job-marker.mjs",
  "memorax-code-adapter-common/src/repo-memory/repo-memory-repository.mjs",
  "memorax-code-adapter-common/src/repo-memory/repo-memory-shared-bundle.mjs",
  "memorax-code-adapter-common/src/repo-memory/repo-memory-job-context.mjs",
  "memorax-code-adapter-common/src/personal-memory/procedure-memory-context.mjs",
  "memorax-code-adapter-common/src/personal-memory/user-profile-context.mjs",
  "memorax-code-adapter-common/src/runtime-record.mjs",
  "memorax-code-adapter-common/src/windows-directory-retry.mjs",
]);

export function ensureDeepAgentsPluginInstalled(options = {}) {
  const deepAgentsHome = options.deepAgentsHome ?? defaultDeepAgentsHome();
  const memoraxCodeHome = options.memoraxCodeHome ?? defaultMemoraxCodeHome();
  const marketplacePath = options.marketplacePath ?? installedMarketplacePath(memoraxCodeHome);
  const deepAgentsCommand = stringOption(options.deepAgentsCommand)
    ?? process.env.MEMORAX_CODE_DEEPAGENTS_COMMAND
    ?? "dcode";
  if (!marketplacePath || !existsSync(join(marketplacePath, ".claude-plugin", "marketplace.json"))) {
    return {
      ok: false,
      action: "deepagents-plugin-install",
      reason: "marketplace_missing",
      failure: deploymentFailure(undefined, "discover", { failureReason: "missing_source" }),
      message: `MemoraX Code Deep Agents marketplace is missing: ${marketplacePath}`,
      deepAgentsHome,
      marketplacePath,
    };
  }

  try { mkdirSync(deepAgentsHome, { recursive: true }); }
  catch (error) { throw attachDeploymentFailure(error, "plugin-stage"); }
  const current = listDeepAgentsPlugins(deepAgentsCommand, deepAgentsHome, options);
  if (!current.ok) return installFailure("plugin_status_failed", current, deepAgentsHome, marketplacePath);
  const installedState = readInstalledPluginEntry(deepAgentsHome, PLUGIN_ID);
  if (installedState.ok === false) {
    return installFailure("plugin_state_invalid", installedState, deepAgentsHome, marketplacePath);
  }
  const marketplaceStatus = listDeepAgentsMarketplaces(deepAgentsCommand, deepAgentsHome, options);
  if (!marketplaceStatus.ok) {
    return installFailure("marketplace_status_failed", marketplaceStatus, deepAgentsHome, marketplacePath);
  }
  const registeredMarketplace = marketplaceStatus.marketplaces.find((entry) => entry?.name === MARKETPLACE_NAME);
  const marketplaceReplaced = Boolean(
    registeredMarketplace && !marketplaceUsesPath(registeredMarketplace, marketplacePath),
  );
  const previouslyInstalled = current.plugins.find((entry) => entry?.id === PLUGIN_ID);
  const expectedVersion = expectedPluginVersion();
  if (registeredMarketplace
    && !marketplaceReplaced
    && installedPluginShellIsCurrent(previouslyInstalled, installedState.entry, expectedVersion)) {
    let installedPlugin = previouslyInstalled;
    const wasEnabled = installedPlugin.enabled === true;
    if (installedPlugin.enabled !== true) {
      const enable = runDeepAgentsPluginCommand(deepAgentsCommand, deepAgentsHome, ["plugin", "enable", PLUGIN_ID], options);
      if (!enable.ok) return installFailure("plugin_enable_failed", enable, deepAgentsHome, marketplacePath);
      const refreshed = listDeepAgentsPlugins(deepAgentsCommand, deepAgentsHome, options);
      if (!refreshed.ok) return installFailure("plugin_verify_failed", refreshed, deepAgentsHome, marketplacePath);
      installedPlugin = refreshed.plugins.find((entry) => entry?.id === PLUGIN_ID);
      const refreshedState = readInstalledPluginEntry(deepAgentsHome, PLUGIN_ID);
      if (refreshedState.ok === false) {
        return installFailure("plugin_state_invalid", refreshedState, deepAgentsHome, marketplacePath);
      }
      if (!installedPluginShellIsCurrent(installedPlugin, refreshedState.entry, expectedVersion)
        || installedPlugin?.enabled !== true) {
        return {
          ok: false,
          action: "deepagents-plugin-install",
          reason: "plugin_shell_verify_failed",
          failure: deploymentFailure(undefined, "verify-native", { failureReason: "verification_failed" }),
          message: "Deep Agents Code did not preserve the current MemoraX Code plugin shell after enablement.",
          deepAgentsHome,
          marketplacePath,
        };
      }
    }
    const installPath = installedState.entry?.installPath;
    if (!installPath) {
      return {
        ok: false,
        action: "deepagents-plugin-install",
        reason: "plugin_install_path_missing",
        failure: deploymentFailure(undefined, "verify-native", { failureReason: "verification_failed" }),
        message: "Deep Agents Code did not record the MemoraX Code plugin install path.",
        deepAgentsHome,
        marketplacePath,
      };
    }
    writeInstalledPluginMetadata(installPath, deepAgentsCommand, memoraxCodeHome);
    writePluginState({ deepAgentsHome, memoraxCodeHome, installPath, marketplacePath, pluginVersion: expectedVersion });
    return {
      ok: true,
      action: "deepagents-plugin-install",
      deepAgentsHome,
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
        ? "Deep Agents Code plugin shell is current; active sessions keep their loaded shell and select runtime generations per turn."
        : "Deep Agents Code plugin shell is current and has been enabled. Start a new dcode session or run /reload to load it.",
    };
  }
  let installed = previouslyInstalled;
  if (marketplaceReplaced) {
    if (installed) {
      const uninstall = runDeepAgentsPluginCommand(
        deepAgentsCommand,
        deepAgentsHome,
        ["plugin", "uninstall", PLUGIN_ID],
        { ...options, allowNotFound: true },
      );
      if (!uninstall.ok) return installFailure("stale_plugin_uninstall_failed", uninstall, deepAgentsHome, marketplacePath);
      installed = undefined;
    }
    const remove = removeDeepAgentsMarketplace(deepAgentsCommand, deepAgentsHome, options);
    if (!remove.ok) return installFailure("marketplace_replace_failed", remove, deepAgentsHome, marketplacePath);
  }
  // dcode exposes add/remove but no update command; a registered current
  // marketplace is reused, while a replaced path is removed and re-added.
  const marketplace = registeredMarketplace && !marketplaceReplaced
    ? { ok: true, skipped: true }
    : runDeepAgentsPluginCommand(
      deepAgentsCommand,
      deepAgentsHome,
      ["plugin", "marketplace", "add", marketplacePath],
      options,
    );
  if (!marketplace.ok) {
    return installFailure(
      installed ? "marketplace_update_failed" : "marketplace_add_failed",
      marketplace,
      deepAgentsHome,
      marketplacePath,
    );
  }
  const pluginArgs = ["plugin", "install", PLUGIN_ID];
  const plugin = runDeepAgentsPluginCommand(deepAgentsCommand, deepAgentsHome, pluginArgs, options);
  if (!plugin.ok) {
    return installFailure(installed ? "plugin_update_failed" : "plugin_install_failed", plugin, deepAgentsHome, marketplacePath);
  }
  let refreshed = listDeepAgentsPlugins(deepAgentsCommand, deepAgentsHome, options);
  if (!refreshed.ok) return installFailure("plugin_verify_failed", refreshed, deepAgentsHome, marketplacePath);
  let installedPlugin = refreshed.plugins.find((entry) => entry?.id === PLUGIN_ID);
  if (installedPlugin && installedPlugin.enabled !== true) {
    const enable = runDeepAgentsPluginCommand(deepAgentsCommand, deepAgentsHome, ["plugin", "enable", PLUGIN_ID], options);
    if (!enable.ok) return installFailure("plugin_enable_failed", enable, deepAgentsHome, marketplacePath);
    refreshed = listDeepAgentsPlugins(deepAgentsCommand, deepAgentsHome, options);
    if (!refreshed.ok) return installFailure("plugin_verify_failed", refreshed, deepAgentsHome, marketplacePath);
    installedPlugin = refreshed.plugins.find((entry) => entry?.id === PLUGIN_ID);
  }
  const finalState = readInstalledPluginEntry(deepAgentsHome, PLUGIN_ID);
  if (finalState.ok === false) {
    return installFailure("plugin_state_invalid", finalState, deepAgentsHome, marketplacePath);
  }
  const verification = verifyInstalledPlugin(installedPlugin, finalState.entry, expectedVersion);
  if (!verification.ok) {
    return {
      ok: false,
      action: "deepagents-plugin-install",
      reason: verification.reason,
      failure: deploymentFailure(verification, "verify-native", { failureReason: "verification_failed" }),
      message: verification.message,
      deepAgentsHome,
      marketplacePath,
      expectedVersion,
      installedVersion: finalState.entry?.version,
      installPath: finalState.entry?.installPath,
    };
  }
  writeInstalledPluginMetadata(verification.installPath, deepAgentsCommand, memoraxCodeHome);
  writePluginState({
    deepAgentsHome,
    memoraxCodeHome,
    installPath: verification.installPath,
    marketplacePath,
    pluginVersion: expectedVersion,
  });

  return {
    ok: true,
    action: "deepagents-plugin-install",
    deepAgentsHome,
    marketplacePath,
    marketplace: MARKETPLACE_NAME,
    plugin: PLUGIN_ID,
    pluginVersion: expectedVersion,
    installPath: verification.installPath,
    enabled: true,
    updated: Boolean(previouslyInstalled),
    ...(marketplaceReplaced ? { marketplaceReplaced: true } : {}),
    restartRequired: true,
    message: "Start a new dcode session or run /reload to load the verified MemoraX Code memory Hooks.",
  };
}

function writeInstalledPluginMetadata(installPath, deepAgentsCommand, memoraxCodeHome) {
  try {
    const npmExecPath = stringOption(process.env.MEMORAX_CODE_NPM_EXEC_PATH);
    atomicWriteJson(join(installPath, ".memorax-code-package.json"), {
      version: 1,
      memoraxCodeHome: resolve(memoraxCodeHome),
      memoraxCodeCommand: process.argv[1],
      deepAgentsCommand,
      ...(npmExecPath ? { npmExecPath } : {}),
      writtenAt: new Date().toISOString(),
    });
  } catch (error) {
    throw attachDeploymentFailure(error, "plugin-write");
  }
}

function writePluginState({ deepAgentsHome, memoraxCodeHome, installPath, marketplacePath, pluginVersion }) {
  try {
    atomicWriteJson(pluginStatePath(memoraxCodeHome, deepAgentsHome), {
      version: 1,
      plugin: PLUGIN_ID,
      pluginVersion,
      installPath,
      marketplace: MARKETPLACE_NAME,
      deepAgentsHome: resolve(deepAgentsHome),
      marketplacePath,
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    throw attachDeploymentFailure(error, "state-write");
  }
}

export function removeDeepAgentsPluginInstallation(options = {}) {
  const deepAgentsHome = options.deepAgentsHome ?? defaultDeepAgentsHome();
  const memoraxCodeHome = options.memoraxCodeHome ?? defaultMemoraxCodeHome();
  const deepAgentsCommand = stringOption(options.deepAgentsCommand)
    ?? process.env.MEMORAX_CODE_DEEPAGENTS_COMMAND
    ?? "dcode";
  const statePath = pluginStatePath(memoraxCodeHome, deepAgentsHome);
  if (!existsSync(statePath)) {
    return {
      ok: true,
      action: "deepagents-plugin-remove",
      skipped: true,
      reason: "not_registered",
      deepAgentsHome,
      marketplace: MARKETPLACE_NAME,
      plugin: PLUGIN_ID,
    };
  }
  mkdirSync(deepAgentsHome, { recursive: true });

  const plugin = runDeepAgentsPluginCommand(
    deepAgentsCommand,
    deepAgentsHome,
    ["plugin", "uninstall", PLUGIN_ID],
    { ...options, allowNotFound: true },
  );
  if (!plugin.ok) return removeFailure("plugin_uninstall_failed", plugin, deepAgentsHome);
  const marketplace = removeDeepAgentsMarketplace(deepAgentsCommand, deepAgentsHome, options);
  if (!marketplace.ok) return removeFailure("marketplace_remove_failed", marketplace, deepAgentsHome);
  rmSync(statePath, { force: true });

  return {
    ok: true,
    action: "deepagents-plugin-remove",
    deepAgentsHome,
    marketplace: MARKETPLACE_NAME,
    plugin: PLUGIN_ID,
  };
}

export function readDeepAgentsPluginStatus(options = {}) {
  const deepAgentsHome = options.deepAgentsHome ?? defaultDeepAgentsHome();
  const memoraxCodeHome = options.memoraxCodeHome ?? defaultMemoraxCodeHome();
  const managed = existsSync(pluginStatePath(memoraxCodeHome, deepAgentsHome));
  if (!managed) {
    return { ok: true, action: "deepagents-plugin-status", installed: false, enabled: false, managed: false, skipped: true, reason: "not_managed" };
  }
  const deepAgentsCommand = stringOption(options.deepAgentsCommand)
    ?? process.env.MEMORAX_CODE_DEEPAGENTS_COMMAND
    ?? "dcode";
  const result = listDeepAgentsPlugins(deepAgentsCommand, deepAgentsHome, options);
  if (!result.ok) return { ok: false, action: "deepagents-plugin-status", installed: false, enabled: false, managed: true, reason: result.reason, message: result.error };
  const installedState = readInstalledPluginEntry(deepAgentsHome, PLUGIN_ID);
  if (installedState.ok === false) {
    return { ok: false, action: "deepagents-plugin-status", installed: false, enabled: false, managed: true, reason: installedState.reason, message: installedState.error };
  }
  const plugin = result.plugins.find((entry) => entry?.id === PLUGIN_ID);
  const installed = Boolean(plugin && installedState.entry);
  const enabled = plugin?.enabled === true;
  const needsRepair = plugin?.needs_repair === true;
  return {
    ok: installed && enabled && !needsRepair,
    action: "deepagents-plugin-status",
    installed,
    enabled,
    managed: true,
    plugin: PLUGIN_ID,
    ...(installedState.entry?.version ? { pluginVersion: installedState.entry.version } : {}),
    ...(installedState.entry?.installPath ? { installPath: installedState.entry.installPath } : {}),
    ...(needsRepair ? { needsRepair: true } : {}),
    ...(!installed ? { reason: "plugin_not_installed", message: "MemoraX Code Deep Agents plugin is not installed." } : {}),
    ...(installed && !enabled ? { reason: "plugin_disabled", message: "MemoraX Code Deep Agents plugin is installed but disabled." } : {}),
    ...(installed && enabled && needsRepair ? { reason: "plugin_needs_repair", message: "MemoraX Code Deep Agents plugin files need repair." } : {}),
  };
}

function installedPluginsPath(deepAgentsHome) {
  return join(deepAgentsHome, ".state", "installed_plugins.json");
}

// dcode keeps authoritative install path and manifest version in state, not in
// `plugin list`, whose rows only expose id/description/enabled/needs_repair.
function readInstalledPluginEntry(deepAgentsHome, pluginId) {
  const path = installedPluginsPath(deepAgentsHome);
  if (!existsSync(path)) return { ok: true, entry: undefined };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return {
      ok: false,
      reason: "plugin_state_invalid",
      error: `Deep Agents Code plugin state could not be read: ${error instanceof Error ? error.message : String(error)}`,
      failure: deploymentFailure(error, "plugin-state-read", { failureReason: "invalid_response" }),
    };
  }
  const plugins = isRecord(parsed) && isRecord(parsed.plugins) ? parsed.plugins : undefined;
  if (!plugins) {
    return {
      ok: false,
      reason: "plugin_state_invalid",
      error: "Deep Agents Code plugin state has no plugins object.",
      failure: deploymentFailure(undefined, "plugin-state-read", { failureReason: "invalid_response" }),
    };
  }
  const entries = plugins[pluginId];
  if (!Array.isArray(entries)) return { ok: true, entry: undefined };
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const installPath = stringOption(entry.installPath) ?? stringOption(entry.install_path);
    if (!installPath) continue;
    return {
      ok: true,
      entry: {
        installPath,
        ...(stringOption(entry.version) ? { version: stringOption(entry.version) } : {}),
      },
    };
  }
  return { ok: true, entry: undefined };
}

export function pluginStatePath(memoraxCodeHome, deepAgentsHome) {
  const resolvedHome = resolve(deepAgentsHome);
  let canonicalHome = resolvedHome;
  try {
    canonicalHome = realpathSync(resolvedHome);
  } catch {
    // A not-yet-created home has no symlink identity to preserve.
  }
  const homeKey = createHash("sha256").update(canonicalHome).digest("hex").slice(0, 16);
  return join(memoraxCodeHome, "adapters", "deepagents", "plugins", `${homeKey}.json`);
}

function expectedPluginVersion() {
  const manifest = readJsonFile(join(ADAPTER_ROOT, ".claude-plugin", "plugin.json"));
  const version = stringOption(manifest?.value?.version);
  if (!version) throw new Error("MemoraX Code Deep Agents plugin manifest has no version.");
  return version;
}

function installedPluginShellIsCurrent(plugin, installedEntry, expectedVersion) {
  if (!plugin
    || plugin.enabled !== true
    || plugin.needs_repair === true
    || !installedEntry
    || installedEntry.version !== expectedVersion
    || !stringOption(installedEntry.installPath)) return false;
  const installPath = installedEntry.installPath;
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
  return STABLE_SHELL_REQUIRED_FILES.every((relativePath) => regularFile(join(installPath, ...relativePath.split("/"))));
}

function regularFile(path) {
  try {
    const metadata = lstatSync(path);
    return metadata.isFile() && !metadata.isSymbolicLink();
  } catch {
    return false;
  }
}

function listDeepAgentsPlugins(command, deepAgentsHome, options = {}) {
  const result = runDeepAgentsPluginCommand(command, deepAgentsHome, ["plugin", "list", "--json"], { ...options, captureOutput: true });
  if (!result.ok) return { ok: false, reason: result.reason ?? "plugin_status_failed", error: result.error, failure: result.failure };
  try {
    const parsed = JSON.parse(result.output || "[]");
    const plugins = normalizePluginList(parsed);
    if (!plugins) throw new Error("plugin list is not an array");
    return { ok: true, plugins };
  } catch {
    return {
      ok: false,
      reason: "plugin_status_invalid",
      error: "Deep Agents Code CLI returned invalid plugin status JSON.",
      failure: deploymentFailure(undefined, "plugin-list", { failureReason: "invalid_response" }),
    };
  }
}

function listDeepAgentsMarketplaces(command, deepAgentsHome, options = {}) {
  const result = runDeepAgentsPluginCommand(command, deepAgentsHome, ["plugin", "marketplace", "list", "--json"], { ...options, captureOutput: true });
  if (!result.ok) return { ok: false, reason: result.reason ?? "marketplace_status_failed", error: result.error, failure: result.failure };
  try {
    const parsed = JSON.parse(result.output || "[]");
    const marketplaces = normalizeMarketplaceList(parsed);
    if (!marketplaces) throw new Error("marketplace list is not an array");
    return { ok: true, marketplaces };
  } catch {
    return {
      ok: false,
      reason: "marketplace_status_invalid",
      failure: deploymentFailure(undefined, "plugin-list", { failureReason: "invalid_response" }),
      error: "Deep Agents Code CLI returned invalid marketplace status JSON.",
    };
  }
}

// dcode --json writes {"schema_version":1,"command":"...","data":[...]}.
// Older shims may expose a bare array, so both shapes are normalized here.
function envelopeData(value) {
  if (isRecord(value) && Array.isArray(value.data)) return value.data;
  return value;
}

function normalizePluginList(value) {
  const envelope = envelopeData(value);
  const items = Array.isArray(envelope)
    ? envelope
    : isRecord(envelope) && Array.isArray(envelope.plugins) ? envelope.plugins : undefined;
  if (!items) return undefined;
  return items.filter(isRecord).map((item) => {
    const id = stringOption(item.id) ?? stringOption(item.plugin);
    const name = stringOption(item.name) ?? id?.split("@")[0];
    const marketplace = stringOption(item.marketplace) ?? id?.split("@")[1];
    return {
      ...(id ? { id } : {}),
      ...(name ? { name } : {}),
      ...(marketplace ? { marketplace } : {}),
      enabled: item.enabled === true,
      needs_repair: item.needs_repair === true,
      ...(stringOption(item.description) ? { description: stringOption(item.description) } : {}),
    };
  });
}

function normalizeMarketplaceList(value) {
  const envelope = envelopeData(value);
  const items = Array.isArray(envelope)
    ? envelope
    : isRecord(envelope) && Array.isArray(envelope.marketplaces) ? envelope.marketplaces : undefined;
  if (!items) return undefined;
  return items.filter(isRecord).map((item) => ({
    ...(stringOption(item.name) ? { name: stringOption(item.name) } : {}),
    ...(stringOption(item.source_type) ? { sourceType: stringOption(item.source_type) } : {}),
    ...(stringOption(item.source) ? { source: stringOption(item.source) } : {}),
    // dcode exposes the local directory as install_location.
    ...(stringOption(item.install_location) ?? stringOption(item.installLocation) ?? stringOption(item.path)
      ? { path: stringOption(item.install_location) ?? stringOption(item.installLocation) ?? stringOption(item.path) }
      : {}),
  }));
}

function marketplaceUsesPath(marketplace, marketplacePath) {
  const registeredPath = stringOption(marketplace.path) ?? stringOption(marketplace.source);
  if (!registeredPath) return false;
  try {
    return realpathSync(registeredPath) === realpathSync(marketplacePath);
  } catch {
    return resolve(registeredPath) === resolve(marketplacePath);
  }
}

function removeDeepAgentsMarketplace(command, deepAgentsHome, options) {
  return runDeepAgentsPluginCommand(
    command,
    deepAgentsHome,
    ["plugin", "marketplace", "remove", MARKETPLACE_NAME],
    { ...options, allowNotFound: true },
  );
}

function verifyInstalledPlugin(plugin, installedEntry, expectedVersion) {
  if (!plugin) {
    return { ok: false, reason: "plugin_not_installed", message: "Deep Agents Code did not report the MemoraX Code plugin after installation." };
  }
  if (plugin.needs_repair === true) {
    return { ok: false, reason: "plugin_needs_repair", message: "Deep Agents Code marked the MemoraX Code plugin as needing repair." };
  }
  if (plugin.enabled !== true) {
    return { ok: false, reason: "plugin_disabled", message: "Deep Agents Code reported the MemoraX Code plugin as disabled after enablement." };
  }
  if (!installedEntry?.installPath) {
    return { ok: false, reason: "plugin_install_path_missing", message: "Deep Agents Code did not record the MemoraX Code plugin install path." };
  }
  if (installedEntry.version !== expectedVersion) {
    return {
      ok: false,
      reason: "plugin_version_mismatch",
      message: `Deep Agents Code installed MemoraX Code plugin ${installedEntry.version ?? "unknown"}; expected ${expectedVersion}.`,
    };
  }
  const artifactVerification = verifyInstalledPluginArtifacts(installedEntry.installPath);
  if (!artifactVerification.ok) return artifactVerification;
  return { ok: true, installPath: installedEntry.installPath };
}

function verifyInstalledPluginArtifacts(installPath) {
  let artifactSources;
  try {
    artifactSources = collectDeepAgentsPluginArtifactSources({ adapterRoot: ADAPTER_ROOT });
  } catch (error) {
    return {
      ok: false,
      reason: "plugin_artifact_contract_invalid",
      failure: deploymentFailure(error, "verify", { failureReason: "verification_failed" }),
      message: `MemoraX Code's Deep Agents plugin source contract is invalid: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const artifactInspection = inspectDeepAgentsPluginArtifact(installPath, artifactSources);
  if (!artifactInspection.ok) {
    return {
      ok: false,
      reason: "plugin_artifacts_invalid",
      message: `Deep Agents Code MemoraX Code plugin has incomplete or unsafe installed artifacts: ${describeDeepAgentsPluginArtifactProblems(artifactInspection)}`,
    };
  }
  const hooks = readJsonFile(join(installPath, "hooks", "hooks.json"));
  const serializedHooks = hooks?.value ? JSON.stringify(hooks.value) : "";
  if (DEEPAGENTS_PLUGIN_HOOK_COMMAND_FILES.some((file) => !serializedHooks.includes(file))) {
    return {
      ok: false,
      reason: "plugin_hooks_invalid",
      message: "Deep Agents Code MemoraX Code plugin Hook manifest does not register the memory authority Hooks.",
    };
  }
  return { ok: true };
}

function runDeepAgentsPluginCommand(command, deepAgentsHome, args, options = {}) {
  const stage = args[1] === "marketplace"
    ? (args[2] === "list" ? "plugin-list" : "plugin-register")
    : ({ list: "plugin-list", install: "plugin-install",
      enable: "plugin-enable", disable: "plugin-disable", uninstall: "plugin-remove" }[args[1]] ?? "native-command");
  const env = { ...process.env, DEEPAGENTS_HOME: deepAgentsHome };
  let invocation;
  try {
    invocation = resolveWindowsCliInvocation(command, args, { ...options.windowsCliResolution, env });
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      failure: deploymentFailure(error, stage, { commandResult: { error } }),
    };
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
      ...(result.error.code === "ENOENT" ? { reason: "deepagents_cli_unavailable" } : {}),
      error: result.error.message,
      failure: deploymentFailure(result.error, stage, { commandResult: result }),
    };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      status: result.status,
      error: output || `Deep Agents Code CLI exited with status ${result.status}`,
      failure: deploymentFailure(undefined, stage, { commandResult: result }),
    };
  }
  return { ok: true, status: result.status, ...(options.captureOutput ? { output: result.stdout } : {}) };
}

function installFailure(reason, command, deepAgentsHome, marketplacePath) {
  return {
    ok: false,
    action: "deepagents-plugin-install",
    reason: command.reason ?? reason,
    failure: deploymentFailure(command, "plugin-install"),
    message: command.error,
    deepAgentsHome,
    marketplacePath,
  };
}

function removeFailure(reason, command, deepAgentsHome) {
  return {
    ok: false,
    action: "deepagents-plugin-remove",
    reason,
    failure: deploymentFailure(command, "plugin-remove"),
    message: command.error,
    deepAgentsHome,
  };
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
