import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { isDeepStrictEqual } from "node:util";

export const pluginName = "memorax-code-codebuddy-adapter";
export const marketplaceName = "memorax-code-local";
export const pluginId = pluginName + "@" + marketplaceName;

export function snapshotCodeBuddySettings(settings) {
  check(record(settings), "CODEBUDDY_SETTINGS_INVALID");
  const snapshot = structuredClone(settings);
  if (snapshot.enabledPlugins !== undefined) {
    check(record(snapshot.enabledPlugins), "CODEBUDDY_PLUGIN_SETTINGS_INVALID");
    delete snapshot.enabledPlugins[pluginId];
    if (!Object.keys(snapshot.enabledPlugins).length) delete snapshot.enabledPlugins;
  }
  if (snapshot.hooks !== undefined) {
    check(record(snapshot.hooks), "CODEBUDDY_HOOK_SETTINGS_INVALID");
    if (snapshot.hooks.UserPromptSubmit !== undefined) {
      check(Array.isArray(snapshot.hooks.UserPromptSubmit), "CODEBUDDY_PROMPT_HOOK_INVALID");
      snapshot.hooks.UserPromptSubmit = snapshot.hooks.UserPromptSubmit.flatMap((group) => {
        if (!Array.isArray(group?.hooks)) return [group];
        const hooks = group.hooks.filter((hook) => !ownedPromptHook(hook));
        if (hooks.length === group.hooks.length) return [group];
        return hooks.length ? [{ ...group, hooks }] : [];
      });
      if (!snapshot.hooks.UserPromptSubmit.length) delete snapshot.hooks.UserPromptSubmit;
    }
    if (!Object.keys(snapshot.hooks).length) delete snapshot.hooks;
  }
  return snapshot;
}

export function assertCodeBuddySettings(settings, expected) {
  check(isDeepStrictEqual(snapshotCodeBuddySettings(settings), expected), "CODEBUDDY_UNRELATED_SETTINGS_CHANGED");
}

export function selectLifecycleRegistration(registry, known, settings, version) {
  check(registry?.version === 2 && record(registry.plugins), "CODEBUDDY_REGISTRY_INVALID");
  const entries = registry.plugins[pluginId];
  check(Array.isArray(entries) && entries.length === 1, "CODEBUDDY_REGISTRATION_NOT_UNIQUE");
  const [entry] = entries;
  check(entry.scope === "user" && entry.version === version && entry.enabled === true
    && typeof entry.installPath === "string" && entry.installPath.length > 0, "CODEBUDDY_REGISTRATION_NOT_READY");
  const marketplace = known?.[marketplaceName];
  check(marketplace?.type === "directory" && marketplace.source?.source === "directory"
    && typeof marketplace.source.path === "string" && marketplace.source.path.length > 0
    && marketplace.installLocation === marketplace.source.path && marketplace.autoUpdate === false,
  "CODEBUDDY_MARKETPLACE_NOT_LOCAL");
  check(settings?.enabledPlugins?.[pluginId] === true, "CODEBUDDY_PLUGIN_DISABLED");
  return { cache: entry.installPath, marketplace: marketplace.source.path };
}

export function assertLifecycleHooks(actual, source, pluginRoot, platform = process.platform) {
  const expected = structuredClone(source);
  check(record(expected.hooks), "CODEBUDDY_HOOK_MANIFEST_INVALID");
  delete expected.hooks.UserPromptSubmit;
  const command = platform === "win32"
    ? 'node "' + win32.join(pluginRoot, "hooks", "runtime-hook.mjs").replaceAll("\\", "/") + '" turn'
    : 'node "$' + '{CODEBUDDY_PLUGIN_ROOT}/hooks/runtime-hook.mjs" turn';
  for (const event of ["SessionStart", "Stop"]) {
    check(Array.isArray(expected.hooks[event]), "CODEBUDDY_REQUIRED_HOOK_MISSING");
    const hooks = expected.hooks[event].flatMap((group) => group.hooks ?? [])
      .filter((hook) => hook.type === "command");
    check(hooks.length > 0, "CODEBUDDY_REQUIRED_HOOK_MISSING");
    for (const hook of hooks) hook.command = command;
  }
  check(isDeepStrictEqual(actual, expected), "CODEBUDDY_HOOK_MANIFEST_MISMATCH");
}

export function assertLifecycleIntegrationAbsent(registry, known, settings) {
  check(!Object.hasOwn(registry?.plugins ?? {}, pluginId)
    && !Object.hasOwn(known ?? {}, marketplaceName)
    && !Object.hasOwn(settings?.enabledPlugins ?? {}, pluginId)
    && !(settings?.hooks?.UserPromptSubmit ?? []).some((group) => group.hooks?.some(ownedPromptHook)),
  "CODEBUDDY_INTEGRATION_REMAINS");
}

export async function verifyLifecycleIntegration({ packageRoot, home, stateHome, command, adapter, settingsSnapshot, client = "codebuddy" }) {
  check(client === "codebuddy" || client === "workbuddy", "NATIVE_CLIENT_INVALID");
  check(adapter?.ok === true && adapter.runtime === client && adapter.installed === true
    && adapter.enabled === true && adapter.managed === true && adapter.integration === "hooks"
    && adapter.codebuddyHooks?.configured === true && adapter.codebuddyHooks.ok === true
    && adapter.codebuddySkills?.ok === true, "CODEBUDDY_ADAPTER_NOT_READY");
  const sourceRoot = join(packageRoot, "lib", pluginName);
  const manifest = await json(join(sourceRoot, ".codebuddy-plugin", "plugin.json"));
  check(manifest.name === pluginName && typeof manifest.version === "string", "CODEBUDDY_SOURCE_MANIFEST_INVALID");
  const settings = await json(join(home, "settings.json"));
  assertCodeBuddySettings(settings, settingsSnapshot);
  const registered = selectLifecycleRegistration(await json(join(home, "plugins", "installed_plugins.json")),
    await json(join(home, "plugins", "known_marketplaces.json")), settings, manifest.version);
  const marketplace = await realpath(registered.marketplace);
  const cache = await realpath(registered.cache);
  const expectedMarketplace = await realpath(join(home, "plugins", "marketplaces", marketplaceName));
  check(marketplace === expectedMarketplace && within(await realpath(home), marketplace)
    && within(await realpath(home), cache) && await realpath(adapter.installPath) === cache,
  "CODEBUDDY_PLUGIN_PATH_MISMATCH");
  const declared = await json(join(marketplace, ".codebuddy-plugin", "marketplace.json"));
  const matches = declared.plugins?.filter((entry) => entry.name === pluginName);
  check(declared.name === marketplaceName && matches?.length === 1
    && matches[0].version === manifest.version && matches[0].source === "./plugins/" + pluginName,
  "CODEBUDDY_MARKETPLACE_MANIFEST_MISMATCH");
  const sourcePath = resolve(registered.marketplace, matches[0].source);
  const source = await realpath(sourcePath);
  check(within(marketplace, source), "CODEBUDDY_PLUGIN_SOURCE_ESCAPED");
  const promptHooks = (settings.hooks?.UserPromptSubmit ?? []).flatMap((group) => group.hooks ?? []).filter(ownedPromptHook);
  // Product commands retain lexical paths; canonical paths only prove identity
  // and containment, including macOS temporary-directory aliases.
  const path = process.platform === "win32" ? join(sourcePath, "hooks", "runtime-hook.mjs").replaceAll("\\", "/")
    : join(sourcePath, "hooks", "runtime-hook.mjs");
  const quoted = process.platform === "win32" ? '"' + path + '"' : "'" + path.replaceAll("'", "'\\''") + "'";
  check(promptHooks.length === 1 && promptHooks[0].command === "node " + quoted + " managed-user-prompt"
    && promptHooks[0].timeout === 20, "CODEBUDDY_GLOBAL_PROMPT_HOOK_MISMATCH");
  for (const [root, commandRoot] of [[cache, resolve(registered.cache)], [source, sourcePath]]) {
    check(isDeepStrictEqual(await json(join(root, ".codebuddy-plugin", "plugin.json")), manifest),
      "CODEBUDDY_INSTALLED_MANIFEST_MISMATCH");
    assertLifecycleHooks(await json(join(root, "hooks", "hooks.json")), await json(join(sourceRoot, "hooks", "hooks.json")), commandRoot);
    const metadata = await json(join(root, ".memorax-code-package.json"));
    check(metadata.version === 1 && metadata.client === client
      && await realpath(metadata.codeBuddyHome) === await realpath(home)
      && await realpath(metadata.memoraxCodeHome) === await realpath(stateHome)
      && await realpath(metadata.codeBuddyCommand) === await realpath(command), "CODEBUDDY_HOOK_TARGET_MISMATCH");
    for (const path of ["hooks/runtime-hook.mjs", "hooks/common-runtime.mjs", "hooks/pending-state.mjs"]) {
      check((await stat(join(root, path))).isFile()
        && await readFile(join(root, path), "utf8") === await readFile(join(sourceRoot, path), "utf8"),
      "CODEBUDDY_HOOK_ASSET_MISMATCH");
    }
    for (const path of ["SKILL.md", "references/memorax-search.md", "references/memorax-add.md"]) {
      check(await readFile(join(root, "skills", "memorax-code", path), "utf8")
        === await readFile(join(packageRoot, "lib", "memorax-code-codex-adapter", "skills", "memorax-code", path), "utf8"),
      "CODEBUDDY_SKILL_ASSET_MISMATCH");
    }
  }
  check(await realpath(dirname(adapter.codebuddySkills.path)) === await realpath(join(source, "skills", "memorax-code")),
    "CODEBUDDY_SKILL_SOURCE_MISMATCH");
  return { source, cache, version: manifest.version };
}

function ownedPromptHook(hook) {
  return hook?.type === "command" && typeof hook.command === "string"
    && hook.command.replaceAll("\\", "/").includes("/" + pluginName + "/hooks/runtime-hook.mjs")
    && /\smanaged-user-prompt\s*$/.test(hook.command);
}
function record(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function check(condition, code) { if (!condition) throw Object.assign(new Error(code), { testCode: code }); }
async function json(path) { return JSON.parse(await readFile(path, "utf8")); }
function within(parent, path) {
  const child = relative(parent, path);
  return child !== "" && child !== ".." && !child.startsWith(".." + sep) && !isAbsolute(child);
}
