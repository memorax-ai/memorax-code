import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  defaultCodeBuddyHome,
  disableCodeBuddyAdapter,
  enableCodeBuddyAdapter,
  knownMarketplacesPath,
  marketplaceRoot,
  readCodeBuddyAdapterStatus,
  removeCodeBuddyPluginInstallation,
  codeBuddySettingsPath,
  codeBuddyInstallPath,
} from "../src/config.mjs";
import { codeBuddyHookCommand } from "../src/hook-manifest.mjs";
import { writeCodeBuddyRuntimeObservation } from "../src/runtime-observation.mjs";
import { resolveHookCodeBuddyCommand } from "../../memorax-code-adapter-common/src/clients/codebuddy-command.mjs";

test("prefers the WorkBuddy home on Windows while preserving a legacy CodeBuddy home", () => {
  assert.equal(
    defaultCodeBuddyHome({}, "C:\\Users\\tester", "win32", () => false),
    "C:\\Users\\tester\\.workbuddy",
  );
  assert.equal(
    defaultCodeBuddyHome(
      {},
      "C:\\Users\\tester",
      "win32",
      (path) => path.endsWith("\\.codebuddy"),
    ),
    "C:\\Users\\tester\\.codebuddy",
  );
  assert.equal(
    defaultCodeBuddyHome({}, "C:\\Users\\tester", "win32", () => true),
    "C:\\Users\\tester\\.workbuddy",
  );
  assert.equal(
    defaultCodeBuddyHome(
      { WORKBUDDY_HOME: "D:\\WorkBuddyData" },
      "C:\\Users\\tester",
      "win32",
      () => false,
    ),
    "D:\\WorkBuddyData",
  );
});

test("builds a native Windows Hook command without the WorkBuddy root placeholder", () => {
  assert.equal(
    codeBuddyHookCommand("C:\\Users\\tester\\.codebuddy\\plugins\\memorax", "win32"),
    'node "C:/Users/tester/.codebuddy/plugins/memorax/hooks/runtime-hook.mjs" turn',
  );
});

test("finds WorkBuddy's bare Windows CLI for Repo Memory jobs", () => {
  const command = "C:\\Users\\tester\\AppData\\Local\\Programs\\WorkBuddy\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy";
  assert.equal(resolveHookCodeBuddyCommand({
    env: { LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local" },
    platform: "win32",
    pathExists: (candidate) => candidate === command,
  }), command);
});

test("derives the install cache version from the CodeBuddy plugin manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-codebuddy-version-"));
  const adapterRoot = join(root, "memorax-code-codebuddy-adapter");
  const configPath = join(adapterRoot, "src", "config.mjs");
  const hookManifestPath = join(adapterRoot, "src", "hook-manifest.mjs");
  const runtimeObservationPath = join(adapterRoot, "src", "runtime-observation.mjs");
  const commandPath = join(root, "memorax-code-adapter-common", "src", "clients", "codebuddy-command.mjs");
  await mkdir(join(adapterRoot, "src"), { recursive: true });
  await mkdir(join(adapterRoot, ".codebuddy-plugin"), { recursive: true });
  await mkdir(join(root, "memorax-code-adapter-common", "src", "clients"), { recursive: true });
  await cp(new URL("../src/config.mjs", import.meta.url), configPath);
  await cp(new URL("../src/hook-manifest.mjs", import.meta.url), hookManifestPath);
  await cp(new URL("../src/runtime-observation.mjs", import.meta.url), runtimeObservationPath);
  await cp(new URL("../../memorax-code-adapter-common/src/clients/codebuddy-command.mjs", import.meta.url), commandPath);
  await writeFile(join(adapterRoot, ".codebuddy-plugin", "plugin.json"), '{"version":"9.8.7"}\n');
  const isolated = await import(pathToFileURL(configPath).href);
  assert.equal(isolated.codeBuddyInstallPath(join(root, "home")), join(
    root, "home", "plugins", "cache", "memorax-code-local", "memorax-code-codebuddy-adapter", "9.8.7",
  ));
});

test("installs and removes an isolated CodeBuddy plugin registry entry", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-codebuddy-"));
  const memoraxCodeHome = await mkdtemp(join(tmpdir(), "memorax-code-home-"));
  await mkdir(join(home, "plugins"), { recursive: true });
  await mkdir(join(home, "skills", "user-skill"), { recursive: true });
  await writeFile(join(home, "skills", "user-skill", "SKILL.md"), "user-owned\n");
  await writeFile(join(home, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: {
    "user-plugin@user-marketplace": [{ scope: "user", installPath: "/user/plugin", enabled: true }],
  }}));
  const enabled = await enableCodeBuddyAdapter({ codeBuddyHome: home, platform: "win32" });
  assert.equal(enabled.ok, true);
  const enabledStatus = await readCodeBuddyAdapterStatus({
    codeBuddyHome: home,
    memoraxCodeHome,
    platform: "win32",
  });
  assert.equal(enabledStatus.enabled, true);
  assert.equal(enabledStatus.marketplaceReady, true);
  assert.equal(enabledStatus.codebuddySkills.ok, true);
  assert.equal(enabledStatus.codebuddySkills.memoraxCode, true);
  assert.equal(enabledStatus.codebuddyHooks.ok, true);
  assert.equal(enabledStatus.codebuddyHooks.status, "unverified");
  assert.equal(await exists(enabledStatus.codebuddySkills.path), true);
  const installedMetadata = JSON.parse(await readFile(join(codeBuddyInstallPath(home), ".memorax-code-package.json"), "utf8"));
  assert.equal(typeof installedMetadata.codeBuddyCommand, "string");
  assert.equal(installedMetadata.codeBuddyHome, home);
  assert.equal(await exists(join(codeBuddyInstallPath(home), "memorax-code-adapter-common", "src", "repo-memory", "repo-memory-job-supervisor.mjs")), true);
  const pluginManifest = JSON.parse(await readFile(join(marketplaceRoot(home), "plugins", "memorax-code-codebuddy-adapter", ".codebuddy-plugin", "plugin.json"), "utf8"));
  assert.deepEqual(pluginManifest.skills, ["./skills/memorax-code"]);
  assert.equal(codeBuddyInstallPath(home), join(home, "plugins", "cache", "memorax-code-local", "memorax-code-codebuddy-adapter", pluginManifest.version));
  const registry = JSON.parse(await readFile(join(home, "plugins", "installed_plugins.json"), "utf8"));
  assert.equal(registry.version, 2);
  assert.ok(registry.plugins["user-plugin@user-marketplace"]);
  assert.equal(registry.plugins["memorax-code-codebuddy-adapter@memorax-code-local"][0].installPath, codeBuddyInstallPath(home));
  assert.equal(registry.plugins["memorax-code-codebuddy-adapter@memorax-code-local"][0].version, pluginManifest.version);
  const marketplace = JSON.parse(await readFile(join(marketplaceRoot(home), ".codebuddy-plugin", "marketplace.json"), "utf8"));
  assert.equal(marketplace.plugins[0].version, pluginManifest.version);
  const pluginRoot = join(marketplaceRoot(home), "plugins", "memorax-code-codebuddy-adapter");
  const hooksManifest = JSON.parse(await readFile(join(pluginRoot, "hooks", "hooks.json"), "utf8"));
  const expectedHookCommand = codeBuddyHookCommand(pluginRoot, "win32");
  for (const event of ["SessionStart", "UserPromptSubmit", "Stop"]) {
    assert.equal(hooksManifest.hooks[event][0].hooks[0].command, expectedHookCommand);
    assert.doesNotMatch(hooksManifest.hooks[event][0].hooks[0].command, /CODEBUDDY_PLUGIN_ROOT/);
  }
  await writeCodeBuddyRuntimeObservation({
    memoraxCodeHome,
    codeBuddyHome: home,
    pluginRoot,
  });
  const observedStatus = await readCodeBuddyAdapterStatus({
    codeBuddyHome: home,
    memoraxCodeHome,
    platform: "win32",
  });
  assert.equal(observedStatus.codebuddyHooks.status, "observed");
  assert.equal(observedStatus.codebuddyHooks.runtimeObserved, true);
  const known = JSON.parse(await readFile(knownMarketplacesPath(home), "utf8"));
  assert.equal(known["memorax-code-local"].type, "directory");
  const settings = JSON.parse(await readFile(codeBuddySettingsPath(home), "utf8"));
  assert.equal(settings.enabledPlugins["memorax-code-codebuddy-adapter@memorax-code-local"], true);
  await disableCodeBuddyAdapter({ codeBuddyHome: home });
  const disabledStatus = await readCodeBuddyAdapterStatus({ codeBuddyHome: home });
  assert.equal(disabledStatus.enabled, false);
  assert.equal(disabledStatus.marketplaceReady, true);
  assert.equal(disabledStatus.codebuddySkills.ok, true);
  const disabledSettings = JSON.parse(await readFile(codeBuddySettingsPath(home), "utf8"));
  assert.equal(disabledSettings.enabledPlugins["memorax-code-codebuddy-adapter@memorax-code-local"], false);
  await removeCodeBuddyPluginInstallation({ codeBuddyHome: home });
  const removedStatus = await readCodeBuddyAdapterStatus({ codeBuddyHome: home });
  assert.equal(removedStatus.installed, false);
  assert.equal(removedStatus.enabled, false);
  assert.equal(removedStatus.codebuddySkills.ok, false);
  const removedKnown = JSON.parse(await readFile(knownMarketplacesPath(home), "utf8"));
  assert.equal(removedKnown["memorax-code-local"], undefined);
  const removedSettings = JSON.parse(await readFile(codeBuddySettingsPath(home), "utf8"));
  assert.equal(removedSettings.enabledPlugins["memorax-code-codebuddy-adapter@memorax-code-local"], undefined);
  const removedRegistry = JSON.parse(await readFile(join(home, "plugins", "installed_plugins.json"), "utf8"));
  assert.ok(removedRegistry.plugins["user-plugin@user-marketplace"]);
  assert.equal(await exists(marketplaceRoot(home)), false);
  assert.equal(await readFile(join(home, "skills", "user-skill", "SKILL.md"), "utf8"), "user-owned\n");
});

test("reconciles a managed legacy .codebuddy home when .workbuddy is selected", async () => {
  const profile = await mkdtemp(join(tmpdir(), "memorax-codebuddy-migration-"));
  const workBuddyHome = join(profile, ".workbuddy");
  const legacyHome = join(profile, ".codebuddy");
  const memoraxCodeHome = join(profile, ".memorax-code");
  await mkdir(join(legacyHome, "plugins"), { recursive: true });
  await mkdir(join(legacyHome, "skills", "user-skill"), { recursive: true });
  await writeFile(join(legacyHome, "skills", "user-skill", "SKILL.md"), "user-owned\n");
  await writeFile(codeBuddySettingsPath(legacyHome), JSON.stringify({ enabledPlugins: {
    "user-plugin@user-marketplace": true,
  }}));
  await writeFile(knownMarketplacesPath(legacyHome), JSON.stringify({
    "user-marketplace": { type: "directory", source: { path: "/user/marketplace" } },
  }));
  await writeFile(join(legacyHome, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: {
    "user-plugin@user-marketplace": [{ scope: "user", installPath: "/user/plugin", enabled: true }],
  }}));
  await enableCodeBuddyAdapter({ codeBuddyHome: legacyHome, platform: "win32" });
  await mkdir(join(legacyHome, "plugins", "cache", "memorax-code-local", "memorax-code-codebuddy-adapter", "0.1.9"), { recursive: true });
  await mkdir(join(legacyHome, "plugins", "cache", "memorax-code-codebuddy-adapter", "0.1.9"), { recursive: true });
  await mkdir(workBuddyHome, { recursive: true });

  const legacyStatus = await readCodeBuddyAdapterStatus({
    codeBuddyHome: workBuddyHome,
    memoraxCodeHome,
    platform: "win32",
  });
  assert.equal(legacyStatus.installed, false);
  assert.equal(legacyStatus.legacyManaged, true);
  assert.equal(legacyStatus.legacyCodeBuddyHome, legacyHome);

  const disabled = await disableCodeBuddyAdapter({ codeBuddyHome: workBuddyHome, platform: "win32" });
  assert.equal(disabled.installed, true);
  assert.equal(disabled.legacyManaged, true);
  assert.equal(disabled.legacyCodeBuddyHome, legacyHome);
  const disabledLegacySettings = JSON.parse(await readFile(codeBuddySettingsPath(legacyHome), "utf8"));
  assert.equal(disabledLegacySettings.enabledPlugins["memorax-code-codebuddy-adapter@memorax-code-local"], false);

  await enableCodeBuddyAdapter({
    codeBuddyHome: workBuddyHome,
    memoraxCodeHome,
    platform: "win32",
  });
  assert.equal(await exists(marketplaceRoot(legacyHome)), false);
  assert.equal(await exists(join(legacyHome, "plugins", "cache", "memorax-code-local", "memorax-code-codebuddy-adapter")), false);
  assert.equal(await exists(join(legacyHome, "plugins", "cache", "memorax-code-codebuddy-adapter")), false);
  const migratedLegacySettings = JSON.parse(await readFile(codeBuddySettingsPath(legacyHome), "utf8"));
  assert.equal(migratedLegacySettings.enabledPlugins["memorax-code-codebuddy-adapter@memorax-code-local"], undefined);
  assert.equal(migratedLegacySettings.enabledPlugins["user-plugin@user-marketplace"], true);
  const migratedLegacyKnown = JSON.parse(await readFile(knownMarketplacesPath(legacyHome), "utf8"));
  assert.equal(migratedLegacyKnown["memorax-code-local"], undefined);
  assert.ok(migratedLegacyKnown["user-marketplace"]);
  const migratedLegacyRegistry = JSON.parse(await readFile(join(legacyHome, "plugins", "installed_plugins.json"), "utf8"));
  assert.equal(migratedLegacyRegistry.plugins["memorax-code-codebuddy-adapter@memorax-code-local"], undefined);
  assert.ok(migratedLegacyRegistry.plugins["user-plugin@user-marketplace"]);
  assert.equal(await readFile(join(legacyHome, "skills", "user-skill", "SKILL.md"), "utf8"), "user-owned\n");

  await enableCodeBuddyAdapter({ codeBuddyHome: legacyHome, platform: "win32" });
  const removed = await removeCodeBuddyPluginInstallation({
    codeBuddyHome: workBuddyHome,
    platform: "win32",
  });
  assert.equal(removed.removed, true);
  assert.equal(await exists(marketplaceRoot(workBuddyHome)), false);
  assert.equal(await exists(marketplaceRoot(legacyHome)), false);
  const removedLegacyRegistry = JSON.parse(await readFile(join(legacyHome, "plugins", "installed_plugins.json"), "utf8"));
  assert.equal(removedLegacyRegistry.plugins["memorax-code-codebuddy-adapter@memorax-code-local"], undefined);
  assert.ok(removedLegacyRegistry.plugins["user-plugin@user-marketplace"]);
});

test("installs the complete plugin when the package lives under node_modules", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-codebuddy-node-modules-"));
  const libraryRoot = join(root, "node_modules", "@memorax", "memorax-code", "lib");
  const adapterRoot = join(libraryRoot, "memorax-code-codebuddy-adapter");
  const commonRoot = join(libraryRoot, "memorax-code-adapter-common", "src");
  await cp(new URL("../", import.meta.url), adapterRoot, { recursive: true });
  await cp(new URL("../../memorax-code-adapter-common/src/", import.meta.url), commonRoot, { recursive: true });
  await cp(
    new URL("../../memorax-code-codex-adapter/skills/memorax-code/", import.meta.url),
    join(adapterRoot, "skills", "memorax-code"),
    { recursive: true },
  );
  const isolated = await import(pathToFileURL(join(adapterRoot, "src", "config.mjs")).href);
  const home = join(root, "home");

  await isolated.enableCodeBuddyAdapter({
    codeBuddyHome: home,
    codeBuddyCommand: "/opt/workbuddy/bin/codebuddy",
  });

  const pluginRoot = join(isolated.marketplaceRoot(home), "plugins", "memorax-code-codebuddy-adapter");
  for (const path of [
    join(pluginRoot, ".codebuddy-plugin", "plugin.json"),
    join(pluginRoot, "hooks", "runtime-hook.mjs"),
    join(pluginRoot, "memorax-code-adapter-common", "src", "backend-connection.mjs"),
    join(pluginRoot, "skills", "memorax-code", "SKILL.md"),
  ]) {
    assert.equal(await exists(path), true, path);
  }
});

test("status rejects a Windows plugin that still uses the portable root placeholder", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-codebuddy-invalid-hook-"));
  const home = join(root, "codebuddy-home");
  await enableCodeBuddyAdapter({
    codeBuddyHome: home,
    memoraxCodeHome: join(root, "memorax-code-home"),
    platform: "win32",
  });
  const pluginRoot = join(marketplaceRoot(home), "plugins", "memorax-code-codebuddy-adapter");
  const manifestPath = join(pluginRoot, "hooks", "hooks.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.hooks.SessionStart[0].hooks[0].command = 'node "${CODEBUDDY_PLUGIN_ROOT}/hooks/runtime-hook.mjs" turn';
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const status = await readCodeBuddyAdapterStatus({
    codeBuddyHome: home,
    memoraxCodeHome: join(root, "memorax-code-home"),
    platform: "win32",
  });
  assert.equal(status.codebuddyHooks.ok, false);
  assert.equal(status.codebuddyHooks.status, "invalid");
});

test("disable and remove are no-ops for an uninstalled CodeBuddy home", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-codebuddy-empty-"));
  const disabled = await disableCodeBuddyAdapter({ codeBuddyHome: home });
  assert.equal(disabled.installed, false);
  assert.equal(await exists(codeBuddySettingsPath(home)), false);
  const removed = await removeCodeBuddyPluginInstallation({ codeBuddyHome: home });
  assert.equal(removed.removed, false);
  assert.equal(await exists(join(home, "plugins", "installed_plugins.json")), false);
});

test("malformed CodeBuddy registry fails closed", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-codebuddy-malformed-"));
  await mkdir(join(home, "plugins"), { recursive: true });
  await writeFile(join(home, "plugins", "installed_plugins.json"), "not-json\n");
  await assert.rejects(() => enableCodeBuddyAdapter({ codeBuddyHome: home }), /JSON|Unexpected token/);
});

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
