import { chmod, cp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveHookCodeBuddyCommand } from "../../memorax-code-adapter-common/src/clients/codebuddy-command.mjs";

const VERSION = "0.1.4";
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PLUGIN_NAME = "memorax-code-codebuddy-adapter";
const MARKETPLACE_NAME = "memorax-code-local";
const PLUGIN_ID = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;

export function defaultCodeBuddyHome() { return process.env.CODEBUDDY_HOME?.trim() || process.env.WORKBUDDY_HOME?.trim() || join(homedir(), ".workbuddy"); }
// CodeBuddy stores installed plugin caches under the marketplace namespace.
export function codeBuddyInstallPath(home = defaultCodeBuddyHome()) { return join(home, "plugins", "cache", MARKETPLACE_NAME, PLUGIN_NAME, VERSION); }
export function installedRegistryPath(home = defaultCodeBuddyHome()) { return join(home, "plugins", "installed_plugins.json"); }
export function codeBuddySettingsPath(home = defaultCodeBuddyHome()) { return join(home, "settings.json"); }
export function knownMarketplacesPath(home = defaultCodeBuddyHome()) { return join(home, "plugins", "known_marketplaces.json"); }
export function marketplaceRoot(home = defaultCodeBuddyHome()) { return join(home, "plugins", "marketplaces", MARKETPLACE_NAME); }
export function marketplacePluginPath(home = defaultCodeBuddyHome()) { return join(marketplaceRoot(home), "plugins", PLUGIN_NAME); }

export async function enableCodeBuddyAdapter(options = {}) {
  const home = options.codeBuddyHome ?? defaultCodeBuddyHome();
  const installPath = options.installPath ?? codeBuddyInstallPath(home);
  const localPluginPath = marketplacePluginPath(home);
  await mkdir(dirname(installPath), { recursive: true });
  await rm(installPath, { recursive: true, force: true });
  await rm(legacyCodeBuddyInstallPath(home), { recursive: true, force: true });
  await cp(ROOT, installPath, { recursive: true, force: true, filter: (source) => !source.includes("/test/") && !source.includes("/node_modules/") });
  await materializeCommonRuntime(installPath);
  await writePackageMetadata(installPath, options.codeBuddyCommand);
  await materializeCanonicalSkill(installPath);
  await mkdir(dirname(localPluginPath), { recursive: true });
  await rm(localPluginPath, { recursive: true, force: true });
  await cp(ROOT, localPluginPath, { recursive: true, force: true, filter: (source) => !source.includes("/test/") && !source.includes("/node_modules/") });
  await materializeCommonRuntime(localPluginPath);
  await writePackageMetadata(localPluginPath, options.codeBuddyCommand);
  await materializeCanonicalSkill(localPluginPath);
  await writeMarketplaceManifest(home);
  await updateKnownMarketplace(home, true);
  await updateSettings(home, (settings) => {
    settings.enabledPlugins = recordValue(settings.enabledPlugins);
    settings.enabledPlugins[PLUGIN_ID] = true;
  });
  await updateLegacyRegistry(home, { installPath, enabled: true });
  return { ok: true, action: "enable", runtime: "codebuddy", integration: "hooks", installed: true, enabled: true, codeBuddyHome: home, installPath, marketplace: MARKETPLACE_NAME, pluginId: PLUGIN_ID, marketplacePath: localPluginPath, codebuddySkills: { ok: true, status: "installed", managed: true, memoraxCode: true, path: join(localPluginPath, "skills", "memorax-code", "SKILL.md") } };
}

export async function disableCodeBuddyAdapter(options = {}) {
  const home = options.codeBuddyHome ?? defaultCodeBuddyHome();
  const registryPath = installedRegistryPath(home);
  await updateSettings(home, (settings) => {
    settings.enabledPlugins = recordValue(settings.enabledPlugins);
    settings.enabledPlugins[PLUGIN_ID] = false;
  });
  await updateLegacyRegistry(home, { installPath: codeBuddyInstallPath(home), enabled: false });
  return { ok: true, action: "disable", runtime: "codebuddy", installed: true, enabled: false, codeBuddyHome: home, statePath: registryPath, marketplace: MARKETPLACE_NAME, pluginId: PLUGIN_ID };
}

export async function readCodeBuddyAdapterStatus(options = {}) {
  const home = options.codeBuddyHome ?? defaultCodeBuddyHome();
  const installPath = codeBuddyInstallPath(home);
  const settings = await readJsonRecord(codeBuddySettingsPath(home));
  const known = await readJsonRecord(knownMarketplacesPath(home));
  const installed = await pathExists(marketplacePluginPath(home)) || await pathExists(installPath);
  const skillPath = join(marketplacePluginPath(home), "skills", "memorax-code", "SKILL.md");
  const skillInstalled = await pathExists(skillPath);
  const enabled = settings.enabledPlugins?.[PLUGIN_ID] === true;
  const marketplaceReady = Boolean(known[MARKETPLACE_NAME]);
  return { ok: true, action: "status", runtime: "codebuddy", integration: "hooks", installed, enabled, managed: installed && marketplaceReady, codeBuddyHome: home, installPath, marketplace: MARKETPLACE_NAME, pluginId: PLUGIN_ID, marketplaceReady, codebuddySkills: { ok: skillInstalled, status: skillInstalled ? "installed" : "missing", managed: skillInstalled, memoraxCode: skillInstalled, path: skillPath } };
}

export async function removeCodeBuddyPluginInstallation(options = {}) {
  const home = options.codeBuddyHome ?? defaultCodeBuddyHome();
  const status = await disableCodeBuddyAdapter({ codeBuddyHome: home });
  await updateSettings(home, (settings) => {
    settings.enabledPlugins = recordValue(settings.enabledPlugins);
    delete settings.enabledPlugins[PLUGIN_ID];
  });
  await updateKnownMarketplace(home, false);
  const registry = await readRegistry(home);
  delete registry[PLUGIN_ID];
  await writeRegistry(home, registry);
  await rm(codeBuddyInstallPath(home), { recursive: true, force: true });
  await rm(legacyCodeBuddyInstallPath(home), { recursive: true, force: true });
  await rm(marketplaceRoot(home), { recursive: true, force: true });
  return { ...status, action: "codebuddy-plugin-remove", installed: false, enabled: false, removed: true };
}

async function readRegistry(home) { try { const value = JSON.parse(await readFile(installedRegistryPath(home), "utf8")); return value?.plugins && typeof value.plugins === "object" ? value.plugins : {}; } catch { return {}; } }
async function writeRegistry(home, plugins) { await writeJsonFile(installedRegistryPath(home), { version: 2, plugins }); }
async function updateLegacyRegistry(home, { installPath, enabled }) {
  const registry = await readRegistry(home);
  registry[PLUGIN_ID] = [{ scope: "user", installPath, version: VERSION, enabled, installedAt: new Date().toISOString(), lastUpdated: new Date().toISOString() }];
  await writeRegistry(home, registry);
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
  const settings = await readJsonRecord(path);
  mutate(settings);
  await writeJsonFile(path, settings);
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
function legacyCodeBuddyInstallPath(home) { return join(home, "plugins", "cache", PLUGIN_NAME, VERSION); }

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

async function writePackageMetadata(destination, configuredCommand) {
  const codeBuddyCommand = typeof configuredCommand === "string" && configuredCommand.trim()
    ? configuredCommand.trim()
    : resolveHookCodeBuddyCommand();
  await writeJsonFile(join(destination, ".memorax-code-package.json"), {
    version: 1,
    codeBuddyCommand,
  });
}

async function materializeCommonRuntime(destination) {
  const source = join(ROOT, "..", "memorax-code-adapter-common", "src");
  const target = join(destination, "memorax-code-adapter-common", "src");
  await rm(target, { recursive: true, force: true });
  await mkdir(dirname(target), { recursive: true });
  await cp(source, target, { recursive: true, force: true, filter: (path) => !path.includes("/test/") && !path.includes("/node_modules/") });
}
