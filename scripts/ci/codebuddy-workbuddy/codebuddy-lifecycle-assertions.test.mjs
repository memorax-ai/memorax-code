import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { assertCodeBuddySettings, assertLifecycleHooks, assertLifecycleIntegrationAbsent,
  marketplaceName, pluginId, pluginName, selectLifecycleRegistration, snapshotCodeBuddySettings,
  verifyLifecycleIntegration } from "./codebuddy-lifecycle-assertions.mjs";

const owned = { type: "command", timeout: 20,
  command: "node '/isolated/plugins/memorax-code-codebuddy-adapter/hooks/runtime-hook.mjs' managed-user-prompt" };
const foreign = { type: "command", command: "node unrelated-hook.mjs" };
const provider = { model: "fixture-model", env: { CODEBUDDY_BASE_URL: "http://127.0.0.1:1" },
  enabledPlugins: { "other@fixture": false },
  hooks: { UserPromptSubmit: [{ matcher: "fixture", hooks: [foreign] }], Stop: [{ hooks: [foreign] }] } };
const code = (value) => (error) => error.testCode === value;

test("settings protection strips only this integration and retains unrelated Hooks", () => {
  const current = structuredClone(provider);
  current.enabledPlugins[pluginId] = true;
  current.hooks.UserPromptSubmit.push({ hooks: [owned] });
  assertCodeBuddySettings(current, snapshotCodeBuddySettings(provider));
  assert.equal(current.enabledPlugins[pluginId], true);
  const mixed = structuredClone(provider);
  mixed.hooks.UserPromptSubmit[0].hooks.push(owned);
  assert.deepEqual(snapshotCodeBuddySettings(mixed), provider);
});

test("provider overrides and unrelated Hook changes fail settings preservation", () => {
  for (const mutate of [
    (value) => { value.model = "wrong"; },
    (value) => { value.env.CODEBUDDY_API_KEY = "unexpected"; },
    (value) => { value.hooks.Stop = []; },
    (value) => { value.enabledPlugins["other@fixture"] = true; },
  ]) {
    const current = structuredClone(provider);
    mutate(current);
    assert.throws(() => assertCodeBuddySettings(current, snapshotCodeBuddySettings(provider)),
      code("CODEBUDDY_UNRELATED_SETTINGS_CHANGED"));
  }
});

test("empty managed containers are equivalent to absence but malformed settings fail", () => {
  assert.deepEqual(snapshotCodeBuddySettings({ enabledPlugins: { [pluginId]: false },
    hooks: { UserPromptSubmit: [{ hooks: [owned] }] } }), {});
  assert.throws(() => snapshotCodeBuddySettings({ hooks: [] }), code("CODEBUDDY_HOOK_SETTINGS_INVALID"));
  assert.throws(() => snapshotCodeBuddySettings({ enabledPlugins: [] }), code("CODEBUDDY_PLUGIN_SETTINGS_INVALID"));
});

function registration() {
  return {
    registry: { version: 2, plugins: { [pluginId]: [{ scope: "user", version: "0.1.19", enabled: true, installPath: "/cache" }] } },
    known: { [marketplaceName]: { type: "directory", source: { source: "directory", path: "/marketplace" },
      installLocation: "/marketplace", autoUpdate: false } },
    settings: { enabledPlugins: { [pluginId]: true } },
  };
}
function select(value) { return selectLifecycleRegistration(value.registry, value.known, value.settings, "0.1.19"); }

test("native registration requires a single enabled user plugin and a local marketplace", () => {
  assert.deepEqual(select(registration()), { cache: "/cache", marketplace: "/marketplace" });
});

test("stale, disabled, duplicate and non-user plugin registrations fail closed", () => {
  for (const mutate of [
    (value) => { value[0].version = "0.1.18"; },
    (value) => { value[0].enabled = false; },
    (value) => { value[0].scope = "project"; },
    (value) => { value.push({ ...value[0] }); },
  ]) {
    const value = registration();
    mutate(value.registry.plugins[pluginId]);
    assert.throws(() => select(value));
  }
});

test("remote marketplaces and a settings-disabled plugin fail readiness", () => {
  const remote = registration();
  remote.known[marketplaceName].source.source = "git";
  assert.throws(() => select(remote), code("CODEBUDDY_MARKETPLACE_NOT_LOCAL"));
  const disabled = registration();
  disabled.settings.enabledPlugins[pluginId] = false;
  assert.throws(() => select(disabled), code("CODEBUDDY_PLUGIN_DISABLED"));
});

const portable = 'node "$' + '{CODEBUDDY_PLUGIN_ROOT}/hooks/runtime-hook.mjs" turn';
const hookManifest = { hooks: { SessionStart: [{ hooks: [{ type: "command", command: portable }] }],
  Stop: [{ hooks: [{ type: "command", command: portable }] }] } };

test("POSIX Hook manifest matches the packaged commands without copying product helpers", () => {
  assertLifecycleHooks(hookManifest, hookManifest, "/plugin", "linux");
  const damaged = structuredClone(hookManifest);
  damaged.hooks.Stop = [];
  assert.throws(() => assertLifecycleHooks(damaged, hookManifest, "/plugin", "linux"),
    code("CODEBUDDY_HOOK_MANIFEST_MISMATCH"));
});

test("Windows Hook commands bind the exact native plugin path", () => {
  const installed = structuredClone(hookManifest);
  for (const event of ["SessionStart", "Stop"]) {
    installed.hooks[event][0].hooks[0].command = 'node "C:/isolated/plugin/hooks/runtime-hook.mjs" turn';
  }
  assertLifecycleHooks(installed, hookManifest, "C:\\isolated\\plugin", "win32");
  assert.throws(() => assertLifecycleHooks(installed, hookManifest, "C:\\other\\plugin", "win32"),
    code("CODEBUDDY_HOOK_MANIFEST_MISMATCH"));
  assert.equal(hookManifest.hooks.Stop[0].hooks[0].command, portable);
});

test("uninstall absence rejects owned registration, disabled key, marketplace or prompt Hook", () => {
  assertLifecycleIntegrationAbsent({ plugins: {} }, {}, provider);
  for (const [registry, known, settings] of [
    [{ plugins: { [pluginId]: [] } }, {}, {}],
    [{}, { [marketplaceName]: {} }, {}],
    [{}, {}, { enabledPlugins: { [pluginId]: false } }],
    [{}, {}, { hooks: { UserPromptSubmit: [{ hooks: [owned] }] } }],
  ]) assert.throws(() => assertLifecycleIntegrationAbsent(registry, known, settings),
    code("CODEBUDDY_INTEGRATION_REMAINS"));
});

test("installed integration retains lexical Hook commands through a symlinked client home", async () => {
  const fixture = await integrationFixture();
  try {
    const result = await verifyLifecycleIntegration(fixture.options);
    assert.notEqual(result.source, fixture.source);
    assert.equal(result.source, await realpath(fixture.source));
    assert.equal(result.cache, await realpath(fixture.cache));
  } finally { await fixture.close(); }
});

test("WorkBuddy verifies the shared plugin with its own runtime and metadata identity", async () => {
  const fixture = await integrationFixture("workbuddy");
  try {
    const result = await verifyLifecycleIntegration(fixture.options);
    assert.equal(result.source, await realpath(fixture.source));
    assert.equal(result.cache, await realpath(fixture.cache));
    assert.equal(result.version, "0.1.19");
  } finally { await fixture.close(); }
});

test("unsupported lifecycle clients fail before examining an integration", async () => {
  for (const client of [null, "", "claude", "WORKBUDDY"]) {
    await assert.rejects(verifyLifecycleIntegration({ client }), code("NATIVE_CLIENT_INVALID"));
  }
});

for (const client of ["codebuddy", "workbuddy"]) {
  test(client + " rejects another client's adapter runtime", async () => {
    const fixture = await integrationFixture(client);
    try {
      fixture.options.adapter.runtime = client === "codebuddy" ? "workbuddy" : "codebuddy";
      await assert.rejects(verifyLifecycleIntegration(fixture.options), code("CODEBUDDY_ADAPTER_NOT_READY"));
    } finally { await fixture.close(); }
  });

  for (const target of ["source", "cache"]) {
    test(client + " rejects another client's " + target + " metadata", async () => {
      const fixture = await integrationFixture(client);
      try {
        const path = join(fixture[target], ".memorax-code-package.json");
        const metadata = JSON.parse(await readFile(path, "utf8"));
        metadata.client = client === "codebuddy" ? "workbuddy" : "codebuddy";
        await fixture.json(path, metadata);
        await assert.rejects(verifyLifecycleIntegration(fixture.options), code("CODEBUDDY_HOOK_TARGET_MISMATCH"));
      } finally { await fixture.close(); }
    });

    test(client + " rejects a different home or command in " + target + " metadata", async () => {
      const fixture = await integrationFixture(client);
      try {
        const path = join(fixture[target], ".memorax-code-package.json");
        const metadata = JSON.parse(await readFile(path, "utf8"));
        const otherCommand = join(fixture.root, "other-command");
        await writeFile(otherCommand, "// Never executed.\n");
        for (const [field, value] of [
          ["codeBuddyHome", fixture.options.stateHome],
          ["memoraxCodeHome", fixture.options.home],
          ["codeBuddyCommand", otherCommand],
        ]) {
          await fixture.json(path, { ...metadata, [field]: value });
          await assert.rejects(verifyLifecycleIntegration(fixture.options), code("CODEBUDDY_HOOK_TARGET_MISMATCH"), field);
        }
      } finally { await fixture.close(); }
    });
  }
}

test("a global Hook command pointing at a different real target still fails", async () => {
  const fixture = await integrationFixture();
  try {
    const other = join(fixture.root, "other", pluginName, "hooks", "runtime-hook.mjs");
    await mkdir(dirname(other), { recursive: true });
    await writeFile(other, "// A different fixture target.\n");
    const settings = JSON.parse(await readFile(fixture.settingsPath, "utf8"));
    settings.hooks.UserPromptSubmit[0].hooks[0].command = promptCommand(dirname(dirname(other)));
    await fixture.json(fixture.settingsPath, settings);
    await assert.rejects(verifyLifecycleIntegration(fixture.options), code("CODEBUDDY_GLOBAL_PROMPT_HOOK_MISMATCH"));
  } finally { await fixture.close(); }
});

for (const target of ["source", "cache"]) {
  test("a symlinked plugin " + target + " outside its allowed root still fails", async () => {
    const fixture = await integrationFixture();
    try {
      const outside = join(fixture.root, "outside-plugin");
      await cp(fixture[target], outside, { recursive: true });
      await rm(fixture[target], { recursive: true });
      await symlink(outside, fixture[target], process.platform === "win32" ? "junction" : "dir");
      await assert.rejects(verifyLifecycleIntegration(fixture.options),
        code(target === "source" ? "CODEBUDDY_PLUGIN_SOURCE_ESCAPED" : "CODEBUDDY_PLUGIN_PATH_MISMATCH"));
    } finally { await fixture.close(); }
  });
}

async function integrationFixture(client) {
  const root = await mkdtemp(join(tmpdir(), "codebuddy-lifecycle-alias-"));
  const close = () => rm(root, { recursive: true, force: true });
  try {
    const home = join(root, "home-alias"), targetHome = join(root, "home-real");
    const packageRoot = join(root, "package"), stateHome = join(root, "state"), command = join(root, "client-fixture");
    await mkdir(targetHome);
    await mkdir(stateHome);
    await writeFile(command, "// Never executed.\n");
    await symlink(targetHome, home, process.platform === "win32" ? "junction" : "dir");
    const marketplace = join(home, "plugins", "marketplaces", marketplaceName);
    const source = join(marketplace, "plugins", pluginName);
    const cache = join(home, "plugins", "cache", marketplaceName, pluginName, "0.1.19");
    const sourceRoot = join(packageRoot, "lib", pluginName);
    const canonicalSkill = join(packageRoot, "lib", "memorax-code-codex-adapter", "skills", "memorax-code");
    const json = async (path, value) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(value));
    };
    for (const path of [source, cache, sourceRoot]) {
      await json(join(path, ".codebuddy-plugin", "plugin.json"), { name: pluginName, version: "0.1.19" });
      const hooks = structuredClone(hookManifest);
      if (process.platform === "win32" && path !== sourceRoot) {
        for (const event of ["SessionStart", "Stop"]) {
          hooks.hooks[event][0].hooks[0].command = 'node "' + join(path, "hooks", "runtime-hook.mjs").replaceAll("\\", "/") + '" turn';
        }
      }
      await json(join(path, "hooks", "hooks.json"), hooks);
      for (const asset of ["hooks/runtime-hook.mjs", "hooks/common-runtime.mjs", "hooks/pending-state.mjs"]) {
        await writeFile(join(path, asset), "// Synthetic asset: " + asset + "\n");
      }
      if (path !== sourceRoot) await json(join(path, ".memorax-code-package.json"),
        { version: 1, client: client ?? "codebuddy", codeBuddyHome: home, memoraxCodeHome: stateHome, codeBuddyCommand: command });
    }
    for (const path of [join(source, "skills", "memorax-code"), join(cache, "skills", "memorax-code"), canonicalSkill]) {
      for (const asset of ["SKILL.md", "references/memorax-search.md", "references/memorax-add.md"]) {
        await mkdir(dirname(join(path, asset)), { recursive: true });
        await writeFile(join(path, asset), "Synthetic Skill fixture: " + asset + "\n");
      }
    }
    const settingsPath = join(home, "settings.json");
    await json(settingsPath, { enabledPlugins: { [pluginId]: true },
      hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: promptCommand(source), timeout: 20 }] }] } });
    await json(join(home, "plugins", "installed_plugins.json"),
      { version: 2, plugins: { [pluginId]: [{ scope: "user", version: "0.1.19", enabled: true, installPath: cache }] } });
    await json(join(home, "plugins", "known_marketplaces.json"),
      { [marketplaceName]: { type: "directory", source: { source: "directory", path: marketplace },
        installLocation: marketplace, autoUpdate: false } });
    await json(join(marketplace, ".codebuddy-plugin", "marketplace.json"),
      { name: marketplaceName, plugins: [{ name: pluginName, source: "./plugins/" + pluginName, version: "0.1.19" }] });
    return { root, source, cache, settingsPath, json, close, options: {
      packageRoot, home, stateHome, command, settingsSnapshot: {},
      ...(client === undefined ? {} : { client }),
      adapter: { ok: true, runtime: client ?? "codebuddy", installed: true, enabled: true, managed: true, integration: "hooks",
        installPath: cache, codebuddyHooks: { configured: true, ok: true },
        codebuddySkills: { ok: true, path: join(source, "skills", "memorax-code", "SKILL.md") } },
    } };
  } catch (error) { await close(); throw error; }
}

function promptCommand(root) {
  const path = join(root, "hooks", "runtime-hook.mjs");
  return process.platform === "win32" ? 'node "' + path.replaceAll("\\", "/") + '" managed-user-prompt'
    : "node '" + path.replaceAll("'", "'\\''") + "' managed-user-prompt";
}
