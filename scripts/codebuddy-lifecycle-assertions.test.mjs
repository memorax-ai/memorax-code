import assert from "node:assert/strict";
import test from "node:test";
import { assertCodeBuddySettings, assertLifecycleHooks, assertLifecycleIntegrationAbsent,
  marketplaceName, pluginId, selectLifecycleRegistration, snapshotCodeBuddySettings } from "./codebuddy-lifecycle-assertions.mjs";

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
