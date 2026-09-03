import { existsSync, readFileSync } from "node:fs";
import { chmod, cp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveHookCodeBuddyCommand } from "../../memorax-code-adapter-common/src/clients/codebuddy-command.mjs";
import { withJsonFileLockAsync } from "../../memorax-code-adapter-common/src/config-utils.mjs";
import {
  codeBuddyHookManifestConfigured,
  materializeCodeBuddyHookManifest,
} from "./hook-manifest.mjs";
import {
  codeBuddyRuntimeObservationPath,
  readCodeBuddyRuntimeObservation,
} from "./runtime-observation.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const VERSION = readPluginVersion();
const PLUGIN_NAME = "memorax-code-codebuddy-adapter";
const MARKETPLACE_NAME = "memorax-code-local";
const PLUGIN_ID = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;

export function defaultCodeBuddyHome(
  env = process.env,
  homeDir = homedir(),
  platform = process.platform,
  pathExists = existsSync,
) {
  const configured = env.CODEBUDDY_HOME?.trim() || env.WORKBUDDY_HOME?.trim();
  if (configured) return configured;
  if (platform !== "win32") return join(homeDir, ".workbuddy");
  const workBuddyHome = win32.join(homeDir, ".workbuddy");
  const legacyCodeBuddyHome = win32.join(homeDir, ".codebuddy");
  return pathExists(workBuddyHome) || !pathExists(legacyCodeBuddyHome)
    ? workBuddyHome
    : legacyCodeBuddyHome;
}
// CodeBuddy stores installed plugin caches under the marketplace namespace.
export function codeBuddyInstallPath(home = defaultCodeBuddyHome()) { return join(home, "plugins", "cache", MARKETPLACE_NAME, PLUGIN_NAME, VERSION); }
export function installedRegistryPath(home = defaultCodeBuddyHome()) { return join(home, "plugins", "installed_plugins.json"); }
export function codeBuddySettingsPath(home = defaultCodeBuddyHome()) { return join(home, "settings.json"); }
export function knownMarketplacesPath(home = defaultCodeBuddyHome()) { return join(home, "plugins", "known_marketplaces.json"); }
export function marketplaceRoot(home = defaultCodeBuddyHome()) { return join(home, "plugins", "marketplaces", MARKETPLACE_NAME); }
export function marketplacePluginPath(home = defaultCodeBuddyHome()) { return join(marketplaceRoot(home), "plugins", PLUGIN_NAME); }

export async function enableCodeBuddyAdapter(options = {}) {
  const home = options.codeBuddyHome ?? defaultCodeBuddyHome();
  const platform = options.platform ?? process.platform;
  const memoraxCodeHome = options.memoraxCodeHome ?? defaultMemoraxCodeHome();
  const installPath = options.installPath ?? codeBuddyInstallPath(home);
  const localPluginPath = marketplacePluginPath(home);
  await rm(codeBuddyRuntimeObservationPath(memoraxCodeHome), { force: true });
  await mkdir(dirname(installPath), { recursive: true });
  await rm(installPath, { recursive: true, force: true });
  await rm(legacyCodeBuddyInstallPath(home), { recursive: true, force: true });
  await cp(ROOT, installPath, { recursive: true, force: true, filter: packageCopyFilter(ROOT) });
  await materializeCommonRuntime(installPath);
  await materializeCodeBuddyHookManifest(installPath, platform);
  await writePackageMetadata(installPath, options.codeBuddyCommand, home, options.memoraxCodeCommand);
  await materializeCanonicalSkill(installPath);
  await mkdir(dirname(localPluginPath), { recursive: true });
  await rm(localPluginPath, { recursive: true, force: true });
  await cp(ROOT, localPluginPath, { recursive: true, force: true, filter: packageCopyFilter(ROOT) });
  await materializeCommonRuntime(localPluginPath);
  await materializeCodeBuddyHookManifest(localPluginPath, platform);
  await writePackageMetadata(localPluginPath, options.codeBuddyCommand, home, options.memoraxCodeCommand);
  await materializeCanonicalSkill(localPluginPath);
  await writeMarketplaceManifest(home);
  await updateKnownMarketplace(home, true);
  await updateSettings(home, (settings) => {
    settings.enabledPlugins = recordValue(settings.enabledPlugins);
    settings.enabledPlugins[PLUGIN_ID] = true;
  });
  await updateLegacyRegistry(home, { installPath, enabled: true });
  await removeLegacyManagedInstallation(home, platform);
  return { ok: true, action: "enable", runtime: "codebuddy", integration: "hooks", installed: true, enabled: true, codeBuddyHome: home, installPath, marketplace: MARKETPLACE_NAME, pluginId: PLUGIN_ID, marketplacePath: localPluginPath, codebuddyHooks: { ok: true, configured: true, runtimeObserved: false, status: "unverified" }, codebuddySkills: { ok: true, status: "installed", managed: true, memoraxCode: true, path: join(localPluginPath, "skills", "memorax-code", "SKILL.md") } };
}

export async function disableCodeBuddyAdapter(options = {}) {
  const home = options.codeBuddyHome ?? defaultCodeBuddyHome();
  const platform = options.platform ?? process.platform;
  const registryPath = installedRegistryPath(home);
  const legacyHome = legacyCodeBuddyHome(home, platform);
  const installed = await managedCodeBuddyInstallationExists(home);
  const legacyInstalled = legacyHome ? await managedCodeBuddyInstallationExists(legacyHome) : false;
  if (!installed && !legacyInstalled) return { ok: true, action: "disable", runtime: "codebuddy", installed: false, enabled: false, codeBuddyHome: home, statePath: registryPath, marketplace: MARKETPLACE_NAME, pluginId: PLUGIN_ID };
  if (installed) await disableManagedCodeBuddyInstallation(home);
  if (legacyInstalled) await disableManagedCodeBuddyInstallation(legacyHome);
  return { ok: true, action: "disable", runtime: "codebuddy", installed: true, enabled: false, codeBuddyHome: home, statePath: registryPath, marketplace: MARKETPLACE_NAME, pluginId: PLUGIN_ID, legacyCodeBuddyHome: legacyInstalled ? legacyHome : undefined, legacyManaged: legacyInstalled };
}

export async function readCodeBuddyAdapterStatus(options = {}) {
  const home = options.codeBuddyHome ?? defaultCodeBuddyHome();
  const platform = options.platform ?? process.platform;
  const memoraxCodeHome = options.memoraxCodeHome ?? defaultMemoraxCodeHome();
  const installPath = codeBuddyInstallPath(home);
  const localPluginPath = marketplacePluginPath(home);
  const settings = await readJsonRecord(codeBuddySettingsPath(home));
  const known = await readJsonRecord(knownMarketplacesPath(home));
  const installedRoots = [];
  for (const root of [localPluginPath, installPath]) {
    if (await pathExists(root)) installedRoots.push(root);
  }
  const installed = installedRoots.length > 0;
  const skillPath = join(localPluginPath, "skills", "memorax-code", "SKILL.md");
  const skillInstalled = await pathExists(skillPath);
  const enabled = settings.enabledPlugins?.[PLUGIN_ID] === true;
  const marketplaceReady = Boolean(known[MARKETPLACE_NAME]);
  const legacyHome = legacyCodeBuddyHome(home, platform);
  const legacyManaged = legacyHome ? await managedCodeBuddyInstallationExists(legacyHome) : false;
  const hookConfigured = installedRoots.length > 0
    && (await Promise.all(installedRoots.map((root) => codeBuddyHookManifestConfigured(root, platform)))).every(Boolean);
  const observation = await readCodeBuddyRuntimeObservation(memoraxCodeHome);
  const runtimeObserved = hookConfigured && observationMatches(observation, home, platform);
  return { ok: true, action: "status", runtime: "codebuddy", integration: "hooks", installed, enabled, managed: installed && marketplaceReady, codeBuddyHome: home, installPath, marketplace: MARKETPLACE_NAME, pluginId: PLUGIN_ID, marketplaceReady, legacyCodeBuddyHome: legacyManaged ? legacyHome : undefined, legacyManaged, codebuddyHooks: { ok: hookConfigured, configured: hookConfigured, runtimeObserved, status: hookConfigured ? (runtimeObserved ? "observed" : "unverified") : "invalid", observationPath: codeBuddyRuntimeObservationPath(memoraxCodeHome) }, codebuddySkills: { ok: skillInstalled, status: skillInstalled ? "installed" : "missing", managed: skillInstalled, memoraxCode: skillInstalled, path: skillPath } };
}

export async function removeCodeBuddyPluginInstallation(options = {}) {
  const home = options.codeBuddyHome ?? defaultCodeBuddyHome();
  const platform = options.platform ?? process.platform;
  const legacyHome = legacyCodeBuddyHome(home, platform);
  const removed = await removeManagedCodeBuddyInstallation(home);
  const legacyRemoved = legacyHome ? await removeManagedCodeBuddyInstallation(legacyHome) : false;
  return { ok: true, action: "codebuddy-plugin-remove", runtime: "codebuddy", installed: false, enabled: false, removed: removed || legacyRemoved, codeBuddyHome: home, statePath: installedRegistryPath(home), marketplace: MARKETPLACE_NAME, pluginId: PLUGIN_ID };
}

async function disableManagedCodeBuddyInstallation(home) {
  await updateSettings(home, (settings) => {
    settings.enabledPlugins = recordValue(settings.enabledPlugins);
    settings.enabledPlugins[PLUGIN_ID] = false;
  });
  await updateLegacyRegistry(home, { installPath: codeBuddyInstallPath(home), enabled: false });
}

async function removeLegacyManagedInstallation(home, platform) {
  const legacyHome = legacyCodeBuddyHome(home, platform);
  return legacyHome ? await removeManagedCodeBuddyInstallation(legacyHome) : false;
}

async function removeManagedCodeBuddyInstallation(home) {
  if (!await managedCodeBuddyInstallationExists(home)) return false;
  await updateJsonRecordIfPresent(codeBuddySettingsPath(home), (settings) => {
    settings.enabledPlugins = recordValue(settings.enabledPlugins);
    delete settings.enabledPlugins[PLUGIN_ID];
  });
  await updateJsonRecordIfPresent(knownMarketplacesPath(home), (known) => {
    delete known[MARKETPLACE_NAME];
  });
  await updateJsonRecordIfPresent(installedRegistryPath(home), (value) => {
    value.version = 2;
    value.plugins = recordValue(value.plugins);
    delete value.plugins[PLUGIN_ID];
  });
  await rm(codeBuddyPluginCacheRoot(home), { recursive: true, force: true });
  await rm(legacyCodeBuddyPluginCacheRoot(home), { recursive: true, force: true });
  await rm(marketplaceRoot(home), { recursive: true, force: true });
  return true;
}

async function managedCodeBuddyInstallationExists(home) {
  if (await pathExists(marketplaceRoot(home))
    || await pathExists(codeBuddyPluginCacheRoot(home))
    || await pathExists(legacyCodeBuddyPluginCacheRoot(home))) return true;
  const settings = await readJsonRecord(codeBuddySettingsPath(home));
  const known = await readJsonRecord(knownMarketplacesPath(home));
  const registry = await readJsonRecord(installedRegistryPath(home));
  return Object.hasOwn(recordValue(settings.enabledPlugins), PLUGIN_ID)
    || Object.hasOwn(known, MARKETPLACE_NAME)
    || Object.hasOwn(recordValue(registry.plugins), PLUGIN_ID);
}

function legacyCodeBuddyHome(home, platform) {
  return platform === "win32" && basename(home).toLowerCase() === ".workbuddy"
    ? join(dirname(home), ".codebuddy")
    : undefined;
}

async function readRegistry(home) {
  try {
    const value = JSON.parse(await readFile(installedRegistryPath(home), "utf8"));
    if (value?.plugins && typeof value.plugins === "object" && !Array.isArray(value.plugins)) return value.plugins;
    throw new Error(`invalid CodeBuddy plugin registry: ${installedRegistryPath(home)}`);
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}
async function writeRegistry(home, plugins) { await writeJsonFile(installedRegistryPath(home), { version: 2, plugins }); }
async function updateLegacyRegistry(home, { installPath, enabled }) {
  await updateRegistry(home, (registry) => {
    registry[PLUGIN_ID] = [{ scope: "user", installPath, version: VERSION, enabled, installedAt: new Date().toISOString(), lastUpdated: new Date().toISOString() }];
  });
}
async function writeMarketplaceManifest(home) {
  const path = join(marketplaceRoot(home), ".codebuddy-plugin", "marketplace.json");
  await writeJsonFile(path, {
    name: MARKETPLACE_NAME,
    description: "MemoraX Code local integration marketplace",
    plugins: [{ name: PLUGIN_NAME, source: `./plugins/${PLUGIN_NAME}`, version: VERSION, description: "MemoraX Code memory integration for CodeBuddy and WorkBuddy." }],
  });
}
async function updateKnownMarketplace(home, enabled) {
  const path = knownMarketplacesPath(home);
  const known = await readJsonRecord(path);
  if (enabled) {
    known[MARKETPLACE_NAME] = {
      type: "directory",
      source: { source: "directory", path: marketplaceRoot(home) },
      installLocation: marketplaceRoot(home),
      description: "MemoraX Code local integration marketplace",
      lastUpdated: new Date().toISOString(),
      autoUpdate: false,
    };
  } else {
    delete known[MARKETPLACE_NAME];
  }
  await writeJsonFile(path, known);
}
async function updateSettings(home, mutate) {
  const path = codeBuddySettingsPath(home);
  await updateJsonRecord(path, mutate);
}

async function updateRegistry(home, mutate) {
  const path = installedRegistryPath(home);
  await updateJsonRecord(path, (value) => {
    value.version = 2;
    value.plugins = recordValue(value.plugins);
    mutate(value.plugins);
  });
}

async function updateJsonRecord(path, mutate) {
  await mkdir(dirname(path), { recursive: true });
  await withJsonFileLockAsync(path, async () => {
    const value = await readJsonRecord(path);
    mutate(value);
    await writeJsonFile(path, value);
  }, {
    timeoutMs: 5000,
    // WorkBuddy owns this directory; preserve its permission policy.
    ensurePrivateDirectory: false,
  });
}

async function updateJsonRecordIfPresent(path, mutate) {
  if (await pathExists(path)) await updateJsonRecord(path, mutate);
}

async function readJsonRecord(path) {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
    throw new Error(`invalid JSON object: ${path}`);
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}
async function writeJsonFile(path, value) {
  await mkdir(dirname(path), { recursive: true });
  let mode = 0o600;
  try { mode = (await stat(path)).mode & 0o777; } catch {}
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  await chmod(temp, mode);
  await rename(temp, path);
}
async function pathExists(path) { try { await stat(path); return true; } catch { return false; } }
function recordValue(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
function readPluginVersion() {
  const manifest = JSON.parse(readFileSync(join(ROOT, ".codebuddy-plugin", "plugin.json"), "utf8"));
  if (typeof manifest?.version !== "string" || !manifest.version.trim()) {
    throw new Error("MemoraX Code CodeBuddy plugin manifest has no version.");
  }
  return manifest.version.trim();
}
function legacyCodeBuddyInstallPath(home) { return join(home, "plugins", "cache", PLUGIN_NAME, VERSION); }
function codeBuddyPluginCacheRoot(home) { return dirname(codeBuddyInstallPath(home)); }
function legacyCodeBuddyPluginCacheRoot(home) { return dirname(legacyCodeBuddyInstallPath(home)); }

async function materializeCanonicalSkill(destination) {
  const packagedSkill = join(ROOT, "skills", "memorax-code");
  const canonicalSkill = join(ROOT, "..", "memorax-code-codex-adapter", "skills", "memorax-code");
  const source = await pathExists(packagedSkill) ? packagedSkill : canonicalSkill;
  if (!await pathExists(source)) throw new Error(`MemoraX Code canonical skill is unavailable: ${source}`);
  const target = join(destination, "skills", "memorax-code");
  await rm(target, { recursive: true, force: true });
  await mkdir(dirname(target), { recursive: true });
  await cp(source, target, { recursive: true, force: true });
}

async function writePackageMetadata(destination, configuredCommand, codeBuddyHome, configuredMemoraxCodeCommand) {
  const codeBuddyCommand = typeof configuredCommand === "string" && configuredCommand.trim()
    ? configuredCommand.trim()
    : resolveHookCodeBuddyCommand();
  const memoraxCodeCommand = typeof configuredMemoraxCodeCommand === "string" && configuredMemoraxCodeCommand.trim()
    ? configuredMemoraxCodeCommand.trim()
    : defaultMemoraxCodeCommand();
  await writeJsonFile(join(destination, ".memorax-code-package.json"), {
    version: 1,
    codeBuddyCommand,
    codeBuddyHome,
    ...(memoraxCodeCommand ? { memoraxCodeCommand } : {}),
  });
}

function defaultMemoraxCodeCommand(adapterRoot = ROOT) {
  const packageRoot = resolve(adapterRoot, "..", "..");
  return [
    join(packageRoot, "bin", "memorax-code.mjs"),
    join(packageRoot, "npm", "memorax-code", "bin", "memorax-code.mjs"),
  ].find((path) => existsSync(path));
}

async function materializeCommonRuntime(destination) {
  const source = join(ROOT, "..", "memorax-code-adapter-common", "src");
  const target = join(destination, "memorax-code-adapter-common", "src");
  await rm(target, { recursive: true, force: true });
  await mkdir(dirname(target), { recursive: true });
  await cp(source, target, { recursive: true, force: true, filter: packageCopyFilter(source) });
}

function packageCopyFilter(root) {
  return (source) => !relative(root, source).split(sep).some((part) => part === "test" || part === "node_modules");
}

function defaultMemoraxCodeHome() {
  return process.env.MEMORAX_CODE_HOME?.trim() || join(homedir(), ".memorax-code");
}

function observationMatches(observation, codeBuddyHome, platform) {
  if (observation?.pluginVersion !== VERSION) return false;
  const left = comparablePath(observation.codeBuddyHome, platform);
  const right = comparablePath(codeBuddyHome, platform);
  return left === right;
}

function comparablePath(value, platform) {
  const normalized = String(value ?? "").replaceAll("\\", "/").replace(/\/+$/, "");
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}
