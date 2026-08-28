import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  disableCodeBuddyAdapter,
  enableCodeBuddyAdapter,
  knownMarketplacesPath,
  marketplaceRoot,
  readCodeBuddyAdapterStatus,
  removeCodeBuddyPluginInstallation,
  codeBuddySettingsPath,
  codeBuddyInstallPath,
} from "../src/config.mjs";

test("derives the install cache version from the CodeBuddy plugin manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-codebuddy-version-"));
  const adapterRoot = join(root, "memorax-code-codebuddy-adapter");
  const configPath = join(adapterRoot, "src", "config.mjs");
  const commandPath = join(root, "memorax-code-adapter-common", "src", "clients", "codebuddy-command.mjs");
  await mkdir(join(adapterRoot, "src"), { recursive: true });
  await mkdir(join(adapterRoot, ".codebuddy-plugin"), { recursive: true });
  await mkdir(join(root, "memorax-code-adapter-common", "src", "clients"), { recursive: true });
  await cp(new URL("../src/config.mjs", import.meta.url), configPath);
  await cp(new URL("../../memorax-code-adapter-common/src/clients/codebuddy-command.mjs", import.meta.url), commandPath);
  await writeFile(join(adapterRoot, ".codebuddy-plugin", "plugin.json"), '{"version":"9.8.7"}\n');
  const isolated = await import(pathToFileURL(configPath).href);
  assert.equal(isolated.codeBuddyInstallPath(join(root, "home")), join(
    root, "home", "plugins", "cache", "memorax-code-local", "memorax-code-codebuddy-adapter", "9.8.7",
  ));
});

test("installs and removes an isolated CodeBuddy plugin registry entry", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-codebuddy-"));
  await mkdir(join(home, "plugins"), { recursive: true });
  await mkdir(join(home, "skills", "user-skill"), { recursive: true });
  await writeFile(join(home, "skills", "user-skill", "SKILL.md"), "user-owned\n");
  await writeFile(join(home, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: {
    "user-plugin@user-marketplace": [{ scope: "user", installPath: "/user/plugin", enabled: true }],
  }}));
  const enabled = await enableCodeBuddyAdapter({ codeBuddyHome: home });
  assert.equal(enabled.ok, true);
  const enabledStatus = await readCodeBuddyAdapterStatus({ codeBuddyHome: home });
  assert.equal(enabledStatus.enabled, true);
  assert.equal(enabledStatus.marketplaceReady, true);
  assert.equal(enabledStatus.codebuddySkills.ok, true);
  assert.equal(enabledStatus.codebuddySkills.memoraxCode, true);
  assert.equal(await exists(enabledStatus.codebuddySkills.path), true);
  const installedMetadata = JSON.parse(await readFile(join(codeBuddyInstallPath(home), ".memorax-code-package.json"), "utf8"));
  assert.equal(typeof installedMetadata.codeBuddyCommand, "string");
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
