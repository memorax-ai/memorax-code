import { isDeepStrictEqual } from "node:util";

const pluginId = "memorax-code-claude-adapter@memorax-code-local";
const marketplaceName = "memorax-code-local";

export function classifyLifecycleRequest(method, path, allowSearch) {
  if (method === "HEAD" && path === "/api/hello") return "connectivity";
  if (allowSearch === true && method === "POST" && path === "/saved-account/v1/memories/search") return "search";
  return "unexpected";
}

export function selectLifecyclePlugin(plugins, expectedVersion) {
  check(Array.isArray(plugins) && plugins.every((entry) => record(entry) && text(entry.id)),
    "CLAUDE_LIFECYCLE_PLUGIN_LIST_INVALID");
  const matches = plugins.filter((entry) => entry.id === pluginId);
  check(matches.length === 1, "CLAUDE_LIFECYCLE_PLUGIN_NOT_UNIQUE");
  const plugin = matches[0];
  check(plugin.scope === "user" && plugin.enabled === true && text(expectedVersion)
    && plugin.version === expectedVersion && text(plugin.installPath), "CLAUDE_LIFECYCLE_PLUGIN_NOT_READY");
  return plugin;
}

export function assertLifecycleMarketplace(marketplaces) {
  check(Array.isArray(marketplaces) && marketplaces.every((entry) => record(entry) && text(entry.name)),
    "CLAUDE_LIFECYCLE_MARKETPLACE_LIST_INVALID");
  const matches = marketplaces.filter((entry) => entry.name === marketplaceName);
  check(matches.length === 1, "CLAUDE_LIFECYCLE_MARKETPLACE_NOT_UNIQUE");
  check(matches[0].source === "directory" && text(matches[0].path), "CLAUDE_LIFECYCLE_MARKETPLACE_NOT_LOCAL");
  return matches[0];
}

export function snapshotClaudeSettings(settings) {
  check(record(settings), "CLAUDE_LIFECYCLE_SETTINGS_INVALID");
  const snapshot = structuredClone(settings);
  // Only this integration's native registration may change during its lifecycle.
  for (const [key, owned] of [["enabledPlugins", pluginId], ["extraKnownMarketplaces", marketplaceName]]) {
    if (!Object.hasOwn(snapshot, key)) continue;
    check(record(snapshot[key]), "CLAUDE_LIFECYCLE_SETTINGS_INVALID");
    delete snapshot[key][owned];
    if (Object.keys(snapshot[key]).length === 0) delete snapshot[key];
  }
  return snapshot;
}

export function assertClaudeSettings(settings, snapshot) {
  check(isDeepStrictEqual(snapshotClaudeSettings(settings), snapshot), "CLAUDE_LIFECYCLE_SETTINGS_CHANGED");
}

export function assertLifecycleHooks(installedHooks, expectedHooks, installedShell, expectedShell) {
  check(record(expectedHooks?.hooks) && Object.keys(expectedHooks.hooks).length > 0
    && isDeepStrictEqual(installedHooks, expectedHooks), "CLAUDE_LIFECYCLE_HOOKS_CHANGED");
  check(Number.isSafeInteger(expectedShell?.version) && expectedShell.version > 0
    && Number.isSafeInteger(expectedShell.runtimeAbi) && expectedShell.runtimeAbi > 0
    && text(expectedShell.shellVersion) && installedShell?.version === expectedShell.version
    && installedShell.runtimeAbi === expectedShell.runtimeAbi && installedShell.shellVersion === expectedShell.shellVersion,
  "CLAUDE_LIFECYCLE_SHELL_CHANGED");
}

export function assertLifecycleIntegrationAbsent(plugins, marketplaces, settings) {
  check(Array.isArray(plugins) && plugins.every((entry) => record(entry) && text(entry.id))
    && Array.isArray(marketplaces) && marketplaces.every((entry) => record(entry) && text(entry.name)),
  "CLAUDE_LIFECYCLE_REMOVAL_LIST_INVALID");
  snapshotClaudeSettings(settings);
  check(!plugins.some((entry) => entry.id === pluginId)
    && !marketplaces.some((entry) => entry.name === marketplaceName)
    && !Object.hasOwn(settings.enabledPlugins ?? {}, pluginId)
    && !Object.hasOwn(settings.extraKnownMarketplaces ?? {}, marketplaceName), "CLAUDE_LIFECYCLE_REGISTRATION_REMAINS");
}

function record(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function text(value) { return typeof value === "string" && value.trim().length > 0; }
function check(condition, code) {
  if (!condition) throw Object.assign(new Error(code), { testCode: code });
}
