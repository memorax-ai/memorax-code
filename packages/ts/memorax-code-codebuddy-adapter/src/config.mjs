import { existsSync, readFileSync } from "node:fs";
import { chmod, cp, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { codeBuddyMetadataClient, defaultCodeBuddyHome, defaultWorkBuddyHome, readCodeBuddyPackageMetadata, resolveHookCodeBuddyCommand } from "../../memorax-code-adapter-common/src/clients/codebuddy-command.mjs";
import { readJsonRuntimeRecord, writePrivateJsonRecord } from "../../memorax-code-adapter-common/src/runtime-record.mjs";
import { withJsonFileLockAsync } from "../../memorax-code-adapter-common/src/config-utils.mjs";
import { attachDeploymentFailure } from "../../memorax-code-adapter-common/src/deployment-failure.mjs";
import { fileTreeMatches } from "../../memorax-code-adapter-common/src/file-tree-match.mjs";
import {
  codeBuddyHookManifestConfigured,
  configureCodeBuddyHookManifest,
  codeBuddyUserPromptHookCommand,
  codeBuddyUserPromptHookConfigured,
  hasManagedCodeBuddyUserPromptHook,
  materializeCodeBuddyHookManifest,
  updateCodeBuddyUserPromptHook,
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

export { defaultCodeBuddyHome, defaultWorkBuddyHome };
// CodeBuddy stores installed plugin caches under the marketplace namespace.
export function codeBuddyInstallPath(home = defaultCodeBuddyHome()) { return join(home, "plugins", "cache", MARKETPLACE_NAME, PLUGIN_NAME, VERSION); }
export function installedRegistryPath(home = defaultCodeBuddyHome()) { return join(home, "plugins", "installed_plugins.json"); }
export function codeBuddySettingsPath(home = defaultCodeBuddyHome()) { return join(home, "settings.json"); }
export function knownMarketplacesPath(home = defaultCodeBuddyHome()) { return join(home, "plugins", "known_marketplaces.json"); }
export function marketplaceRoot(home = defaultCodeBuddyHome()) { return join(home, "plugins", "marketplaces", MARKETPLACE_NAME); }
export function marketplacePluginPath(home = defaultCodeBuddyHome()) { return join(marketplaceRoot(home), "plugins", PLUGIN_NAME); }

export function enableCodeBuddyAdapter(options = {}) { return withManagedTargetLock(options, () => enableAdapter(options)); }
export function disableCodeBuddyAdapter(options = {}) { return withManagedTargetLock(options, () => disableAdapter(options)); }
export function removeCodeBuddyPluginInstallation(options = {}) { return withManagedTargetLock(options, () => removeAdapter(options)); }

export async function readManagedCodeBuddyTarget(options = {}) {
  const client = selectedClient(options);
  const path = managedTargetPath(options);
  const state = readJsonRuntimeRecord(path);
  if (state.status === "invalid") throw attachDeploymentFailure(new Error(`invalid ${client} installation record: ${path}`), "state-read", { failureReason: "invalid_record" });
  if (state.status === "present") {
    const value = state.value;
    if (value.version !== 1 || value.client !== client || !stringValue(value.codeBuddyHome)
      || !stringValue(value.codeBuddyCommand)
      || (value.legacyClientAlias !== undefined && value.legacyClientAlias !== true)) throw attachDeploymentFailure(new Error(`invalid ${client} installation record: ${path}`), "state-read", { failureReason: "invalid_record" });
    if (!options.codeBuddyHome || comparablePath(resolve(options.codeBuddyHome), options.platform ?? process.platform)
      === comparablePath(value.codeBuddyHome, options.platform ?? process.platform)) return value;
  }
  const homes = options.codeBuddyHome ? [resolve(options.codeBuddyHome)] : [
    defaultClientHome(client, options),
    ...(client === "workbuddy" ? [defaultClientHome("codebuddy", options)] : []),
  ];
  for (const home of new Set(homes)) {
    for (const root of [marketplacePluginPath(home), codeBuddyInstallPath(home)]) {
      const metadata = readCodeBuddyPackageMetadata(root);
      if (codeBuddyMetadataClient(metadata, options) !== client || !stringValue(metadata?.codeBuddyCommand)) continue;
      if (metadata.codeBuddyHome && comparablePath(metadata.codeBuddyHome, options.platform ?? process.platform)
        !== comparablePath(home, options.platform ?? process.platform)) continue;
      return { version: 1, client, codeBuddyHome: home, codeBuddyCommand: metadata.codeBuddyCommand,
        ...(client === "workbuddy" && metadata.client === undefined ? { legacyClientAlias: true } : {}),
      };
    }
  }
  return undefined;
}

export async function resolveCodeBuddyClientSelection(clients, options = {}) {
  if (clients?.workbuddy !== undefined || clients?.codebuddy !== true) return clients;
  const workBuddyOptions = { ...options, client: "workbuddy", codeBuddyHome: options.workBuddyHome };
  const target = await readManagedCodeBuddyTarget(workBuddyOptions);
  const candidates = new Set([
    target?.codeBuddyHome,
    options.workBuddyHome ?? defaultClientHome("workbuddy", options),
    options.codeBuddyHome ?? defaultClientHome("codebuddy", options),
  ].filter(Boolean));
  let legacyHome = target?.legacyClientAlias ? target.codeBuddyHome : undefined;
  for (const home of candidates) {
    if (legacyHome) break;
    for (const root of [marketplacePluginPath(home), codeBuddyInstallPath(home)]) {
      const metadata = readCodeBuddyPackageMetadata(root);
      if (metadata?.client !== undefined || codeBuddyMetadataClient(metadata, options) !== "workbuddy") continue;
      if (metadata.codeBuddyHome && comparablePath(metadata.codeBuddyHome, options.platform ?? process.platform)
        !== comparablePath(home, options.platform ?? process.platform)) continue;
      legacyHome = home;
      break;
    }
    if (legacyHome) break;
  }
  if (!legacyHome) return clients;
  const platform = options.platform ?? process.platform;
  const legacyCodeBuddyHome = options.codeBuddyHome
    && comparablePath(resolve(options.codeBuddyHome), platform) === comparablePath(resolve(legacyHome), platform);
  const cli = await readManagedCodeBuddyTarget({
    ...options, client: "codebuddy", codeBuddyHome: legacyCodeBuddyHome ? undefined : options.codeBuddyHome,
  });
  return { ...clients, workbuddy: true, codebuddy: Boolean(cli
    && comparablePath(cli.codeBuddyHome, platform) !== comparablePath(resolve(legacyHome), platform)) };
}

async function resolveTarget(options) {
  const client = selectedClient(options);
  const retained = await readManagedCodeBuddyTarget(options);
  const home = resolve(options.codeBuddyHome ?? retained?.codeBuddyHome ?? defaultClientHome(client, options));
  for (const root of [marketplacePluginPath(home), codeBuddyInstallPath(home)]) {
    const metadataPath = join(root, ".memorax-code-package.json");
    const metadata = readCodeBuddyPackageMetadata(root);
    if (existsSync(metadataPath) && (!metadata || (metadata.client !== undefined && !codeBuddyMetadataClient(metadata, options)))) {
      throw attachDeploymentFailure(new Error(`invalid adapter installation metadata: ${metadataPath}`), "state-read", { failureReason: "invalid_record" });
    }
    if (metadata?.codeBuddyHome && comparablePath(metadata.codeBuddyHome, options.platform ?? process.platform)
      !== comparablePath(home, options.platform ?? process.platform)) throw attachDeploymentFailure(new Error(`conflicting adapter installation home: ${metadataPath}`), "discover", { failureReason: "conflict" });
  }
  const otherClient = client === "codebuddy" ? "workbuddy" : "codebuddy";
  const other = await readManagedCodeBuddyTarget({ ...options, client: otherClient, codeBuddyHome: home });
  const ownRecord = readJsonRuntimeRecord(managedTargetPath(options)).value;
  if (other && ownRecord && comparablePath(ownRecord.codeBuddyHome, options.platform ?? process.platform)
    === comparablePath(home, options.platform ?? process.platform)) {
    throw attachDeploymentFailure(new Error(`conflicting ${client} installation record: ${home} is also managed for ${otherClient}`), "discover", { failureReason: "conflict" });
  }
  return {
    ...(other ? { ownedByOtherClient: otherClient } : {}),
    client,
    codeBuddyHome: home,
    codeBuddyCommand: stringValue(options.codeBuddyCommand) ?? retained?.codeBuddyCommand,
    ...(retained?.legacyClientAlias ? { legacyClientAlias: true } : {}),
  };
}

function selectedClient(options) {
  const client = options.client ?? "codebuddy";
  if (client !== "codebuddy" && client !== "workbuddy") throw attachDeploymentFailure(new Error("invalid CodeBuddy adapter client"), "discover", { failureReason: "invalid_configuration" });
  return client;
}

function defaultClientHome(client, options) {
  return (client === "workbuddy" ? defaultWorkBuddyHome : defaultCodeBuddyHome)(process.env, homedir(), options.platform ?? process.platform);
}

function managedTargetPath(options) {
  return join(options.memoraxCodeHome ?? defaultMemoraxCodeHome(), "adapters", selectedClient(options), "installation.json");
}

async function withManagedTargetLock(options, operation) {
  selectedClient(options);
  const path = join(options.memoraxCodeHome ?? defaultMemoraxCodeHome(), "adapters", "codebuddy-installations.json");
  try { return await withJsonFileLockAsync(path, operation); }
  catch (error) { throw attachDeploymentFailure(error, "lock"); }
}

async function writeManagedTarget(options, value) {
  const path = managedTargetPath(options);
  try { writePrivateJsonRecord(path, value, { durableBoundary: dirname(path) }); }
  catch (error) { throw attachDeploymentFailure(error, "state-write"); }
}

function stringValue(value) { return typeof value === "string" && value.trim() ? value.trim() : undefined; }

async function enableAdapter(options) {
  let stage = "discover";
  try {
    const target = await resolveTarget(options);
    const { client, codeBuddyHome: home } = target;
    if (target.ownedByOtherClient) throw attachDeploymentFailure(new Error(`${home} is managed for ${target.ownedByOtherClient}, not ${client}`), "discover", { failureReason: "conflict" });
    const codeBuddyCommand = target.codeBuddyCommand ?? resolveHookCodeBuddyCommand({ client });
    const platform = options.platform ?? process.platform;
    const memoraxCodeHome = options.memoraxCodeHome ?? defaultMemoraxCodeHome();
    const installPath = options.installPath ?? codeBuddyInstallPath(home);
    const localPluginPath = marketplacePluginPath(home);
    await writeManagedTarget(options, { version: 1, ...target, codeBuddyCommand });
    // Installation alone cannot prove native Hook execution; require a fresh
    // runtime observation instead of carrying one over from the previous install.
    stage = "state-write";
    await rm(codeBuddyRuntimeObservationPath(memoraxCodeHome, client), { force: true });
    stage = "plugin-stage";
    await rm(legacyCodeBuddyInstallPath(home), { recursive: true, force: true });
    for (const destination of [installPath, localPluginPath]) {
      stage = "plugin-stage";
      if (!await installedPluginMatches(destination, platform)) {
        await mkdir(dirname(destination), { recursive: true });
        await rm(destination, { recursive: true, force: true });
        await cp(ROOT, destination, { recursive: true, force: true, filter: packageCopyFilter(ROOT) });
        stage = "runtime-stage";
        await materializeCommonRuntime(destination);
        stage = "hooks-write";
        await materializeCodeBuddyHookManifest(destination, platform);
        stage = "skill-stage";
        await materializeCanonicalSkill(destination);
      }
      stage = "plugin-write";
      await writePackageMetadata(destination, codeBuddyCommand, home, options.memoraxCodeCommand, client);
    }
    stage = "plugin-register";
    await writeMarketplaceManifest(home);
    await updateKnownMarketplace(home, true);
    stage = "config-write";
    await updateSettings(home, (settings) => {
      settings.enabledPlugins = recordValue(settings.enabledPlugins);
      settings.enabledPlugins[PLUGIN_ID] = true;
      updateCodeBuddyUserPromptHook(settings, codeBuddyUserPromptHookCommand(localPluginPath, platform));
    });
    stage = "plugin-register";
    await updateLegacyRegistry(home, { installPath, enabled: true });
    return { ok: true, action: "enable", runtime: client, integration: "hooks", installed: true, enabled: true, codeBuddyHome: home, installPath, marketplace: MARKETPLACE_NAME, pluginId: PLUGIN_ID, marketplacePath: localPluginPath, codebuddyHooks: { ok: true, configured: true, runtimeObserved: false, status: "unverified" }, codebuddySkills: { ok: true, status: "installed", managed: true, memoraxCode: true, path: join(localPluginPath, "skills", "memorax-code", "SKILL.md") } };
  } catch (error) {
    throw attachDeploymentFailure(error, stage);
  }
}

async function disableAdapter(options) {
  const { client, codeBuddyHome: home, ownedByOtherClient } = await resolveTarget(options);
  const registryPath = installedRegistryPath(home);
  const installed = !ownedByOtherClient && await managedCodeBuddyInstallationExists(home);
  if (!installed) return { ok: true, action: "disable", runtime: client, installed: false, enabled: false, codeBuddyHome: home, statePath: registryPath, marketplace: MARKETPLACE_NAME, pluginId: PLUGIN_ID };
  if (installed) await disableManagedCodeBuddyInstallation(home);
  return { ok: true, action: "disable", runtime: client, installed: true, enabled: false, codeBuddyHome: home, statePath: registryPath, marketplace: MARKETPLACE_NAME, pluginId: PLUGIN_ID };
}

export async function readCodeBuddyAdapterStatus(options = {}) {
  const { client, codeBuddyHome: home, ownedByOtherClient } = await resolveTarget(options);
  const platform = options.platform ?? process.platform;
  const memoraxCodeHome = options.memoraxCodeHome ?? defaultMemoraxCodeHome();
  const installPath = codeBuddyInstallPath(home);
  const localPluginPath = marketplacePluginPath(home);
  const nativeHomeAvailable = !ownedByOtherClient && await nativeHomeIsDirectory(home);
  const settings = !nativeHomeAvailable ? {} : await readJsonRecord(codeBuddySettingsPath(home));
  const known = !nativeHomeAvailable ? {} : await readJsonRecord(knownMarketplacesPath(home));
  const installedRoots = [];
  for (const root of [localPluginPath, installPath]) {
    if (!ownedByOtherClient && await pathExists(root)) installedRoots.push(root);
  }
  const installed = installedRoots.length > 0;
  const skillPath = join(localPluginPath, "skills", "memorax-code", "SKILL.md");
  const skillInstalled = !ownedByOtherClient && await pathExists(skillPath);
  const enabled = settings.enabledPlugins?.[PLUGIN_ID] === true;
  const marketplaceReady = Boolean(known[MARKETPLACE_NAME]);
  const hookConfigured = installedRoots.length > 0
    && (await Promise.all(installedRoots.map((root) => codeBuddyHookManifestConfigured(root, platform)))).every(Boolean)
    && codeBuddyUserPromptHookConfigured(settings, codeBuddyUserPromptHookCommand(localPluginPath, platform), enabled);
  const observation = await readCodeBuddyRuntimeObservation(memoraxCodeHome, client);
  const runtimeObserved = hookConfigured && observationMatches(observation, home, platform);
  return { ok: true, action: "status", runtime: client, integration: "hooks", installed, enabled, managed: installed && marketplaceReady, codeBuddyHome: home, installPath, marketplace: MARKETPLACE_NAME, pluginId: PLUGIN_ID, marketplaceReady, codebuddyHooks: { ok: hookConfigured, configured: hookConfigured, runtimeObserved, status: hookConfigured ? (runtimeObserved ? "observed" : "unverified") : "invalid", observationPath: codeBuddyRuntimeObservationPath(memoraxCodeHome, client) }, codebuddySkills: { ok: skillInstalled, status: skillInstalled ? "installed" : "missing", managed: skillInstalled, memoraxCode: skillInstalled, path: skillPath } };
}

async function removeAdapter(options) {
  const { client, codeBuddyHome: home, ownedByOtherClient } = await resolveTarget(options);
  const removed = !ownedByOtherClient && await removeManagedCodeBuddyInstallation(home);
  const retained = await readManagedCodeBuddyTarget({ ...options, codeBuddyHome: undefined });
  const platform = options.platform ?? process.platform;
  if (!ownedByOtherClient && retained
    && comparablePath(retained.codeBuddyHome, platform) === comparablePath(home, platform)) await rm(managedTargetPath(options), { force: true });
  return { ok: true, action: `${client}-plugin-remove`, runtime: client, installed: false, enabled: false, removed, codeBuddyHome: home, statePath: installedRegistryPath(home), marketplace: MARKETPLACE_NAME, pluginId: PLUGIN_ID };
}

async function disableManagedCodeBuddyInstallation(home) {
  await updateSettings(home, (settings) => {
    settings.enabledPlugins = recordValue(settings.enabledPlugins);
    settings.enabledPlugins[PLUGIN_ID] = false;
    updateCodeBuddyUserPromptHook(settings);
  });
  await updateLegacyRegistry(home, { installPath: codeBuddyInstallPath(home), enabled: false });
}

async function removeManagedCodeBuddyInstallation(home) {
  if (!await managedCodeBuddyInstallationExists(home)) return false;
  await updateJsonRecordIfPresent(codeBuddySettingsPath(home), (settings) => {
    settings.enabledPlugins = recordValue(settings.enabledPlugins);
    delete settings.enabledPlugins[PLUGIN_ID];
    updateCodeBuddyUserPromptHook(settings);
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
  if (!await nativeHomeIsDirectory(home)) return false;
  if (await pathExists(marketplaceRoot(home))
    || await pathExists(codeBuddyPluginCacheRoot(home))
    || await pathExists(legacyCodeBuddyPluginCacheRoot(home))) return true;
  const settings = await readJsonRecord(codeBuddySettingsPath(home));
  const known = await readJsonRecord(knownMarketplacesPath(home));
  const registry = await readJsonRecord(installedRegistryPath(home));
  return Object.hasOwn(recordValue(settings.enabledPlugins), PLUGIN_ID)
    || hasManagedCodeBuddyUserPromptHook(settings)
    || Object.hasOwn(known, MARKETPLACE_NAME)
    || Object.hasOwn(recordValue(registry.plugins), PLUGIN_ID);
}

async function nativeHomeIsDirectory(home) {
  try { return (await stat(home)).isDirectory(); }
  catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
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
  try {
    await mkdir(dirname(path), { recursive: true });
    await withJsonFileLockAsync(path, async () => {
      const value = await readJsonRecord(path);
      try { mutate(value); }
      catch (error) { throw attachDeploymentFailure(error, "config-parse", { failureReason: "invalid_configuration" }); }
      await writeJsonFile(path, value);
    }, {
      timeoutMs: 5000,
      // WorkBuddy owns this directory; preserve its permission policy.
      ensurePrivateDirectory: false,
    });
  } catch (error) {
    throw attachDeploymentFailure(error, "lock");
  }
}

async function updateJsonRecordIfPresent(path, mutate) {
  if (await pathExists(path)) await updateJsonRecord(path, mutate);
}

async function readJsonRecord(path) {
  try {
    let content;
    try { content = await readFile(path, "utf8"); }
    catch (error) { throw attachDeploymentFailure(error, "config-read"); }
    let value;
    try { value = JSON.parse(content); }
    catch (error) { throw attachDeploymentFailure(error, "config-parse", { failureReason: "invalid_configuration" }); }
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
    throw attachDeploymentFailure(new Error(`invalid JSON object: ${path}`), "config-parse", { failureReason: "invalid_configuration" });
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}
async function writeJsonFile(path, value) {
  try {
    await mkdir(dirname(path), { recursive: true });
    let mode = 0o600;
    try { mode = (await stat(path)).mode & 0o777; } catch {}
    const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode });
    await chmod(temp, mode);
    await rename(temp, path);
  } catch (error) {
    throw attachDeploymentFailure(error, "config-write");
  }
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

async function installedPluginMatches(destination, platform) {
  const target = await lstat(destination).catch((error) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!target?.isDirectory() || target.isSymbolicLink()) return false;
  const ignore = (path) => path.split("/").some((part) => part === "test" || part === "node_modules");
  const sources = new Map((await readdir(ROOT)).filter((name) => !ignore(name)).map((name) => [name, join(ROOT, name)]));
  sources.set("memorax-code-adapter-common", join(ROOT, "..", "memorax-code-adapter-common"));
  if (!sources.has("skills")) sources.set("skills", join(ROOT, "..", "memorax-code-codex-adapter", "skills"));
  const actual = (await readdir(destination)).filter((name) => name !== ".memorax-code-package.json").sort();
  if (JSON.stringify(actual) !== JSON.stringify([...sources.keys()].sort())) return false;
  for (const [name, source] of sources) {
    if (!await fileTreeMatches(source, join(destination, name), {
      ignore,
      transform: (path, content) => name === "hooks" && path === "hooks.json"
        ? Buffer.from(`${JSON.stringify(configureCodeBuddyHookManifest(JSON.parse(content.toString("utf8")), destination, platform), null, 2)}\n`)
        : content,
    })) return false;
  }
  return true;
}

async function materializeCanonicalSkill(destination) {
  const target = join(destination, "skills", "memorax-code");
  // enableAdapter recreates the plugin tree, including any packaged Skill.
  if (await pathExists(target)) return;
  const source = join(ROOT, "..", "memorax-code-codex-adapter", "skills", "memorax-code");
  if (!await pathExists(source)) throw new Error(`MemoraX Code canonical skill is unavailable: ${source}`);
  await mkdir(dirname(target), { recursive: true });
  await cp(source, target, { recursive: true, force: true });
}

async function writePackageMetadata(destination, configuredCommand, codeBuddyHome, configuredMemoraxCodeCommand, client) {
  const codeBuddyCommand = typeof configuredCommand === "string" && configuredCommand.trim()
    ? configuredCommand.trim()
    : resolveHookCodeBuddyCommand({ client });
  const memoraxCodeCommand = typeof configuredMemoraxCodeCommand === "string" && configuredMemoraxCodeCommand.trim()
    ? configuredMemoraxCodeCommand.trim()
    : defaultMemoraxCodeCommand();
  await writeJsonFile(join(destination, ".memorax-code-package.json"), {
    version: 1,
    client,
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
