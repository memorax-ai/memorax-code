import assert from "node:assert/strict";
import test from "node:test";
import { assertClaudeSettings, assertLifecycleHooks, assertLifecycleIntegrationAbsent,
  assertLifecycleMarketplace, classifyLifecycleRequest, selectLifecyclePlugin, snapshotClaudeSettings } from "./claude-lifecycle-assertions.mjs";

const pluginId = "memorax-code-claude-adapter@memorax-code-local";
const marketplaceName = "memorax-code-local";
const plugin = () => ({ id: pluginId, scope: "user", enabled: true, version: "0.1.19", installPath: "/fixture/plugin" });
const marketplace = () => ({ name: marketplaceName, source: "directory", path: "/fixture/marketplace" });
const settings = () => ({ model: "lifecycle-fixture", env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:32123",
  ANTHROPIC_API_KEY: "synthetic-provider-key" }, permissions: { deny: ["WebSearch", "WebFetch"] },
  enabledPlugins: { "another-plugin@another-marketplace": false },
  extraKnownMarketplaces: { "another-marketplace": { source: { source: "directory", path: "/fixture/other" } } } });
const hooks = () => ({ hooks: { SessionStart: [{ matcher: "startup|resume", hooks: [
  { type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/runtime-hook.mjs" ensure-backend', timeout: 35 },
] }] } });
const shell = () => ({ version: 1, runtimeAbi: 1, shellVersion: "0.1.19" });
const rejects = (run, code) => assert.throws(run, { message: code, testCode: code });

test("Claude lifecycle separates exact connectivity probes from explicitly enabled Search", () => {
  for (const allowSearch of [false, true]) {
    assert.equal(classifyLifecycleRequest("HEAD", "/api/hello", allowSearch), "connectivity");
    assert.equal(classifyLifecycleRequest("POST", "/saved-account/v1/memories/search", allowSearch),
      allowSearch ? "search" : "unexpected");
    for (const [method, path] of [["POST", "/v1/messages"], ["POST", "/v1/messages/count_tokens"],
      ["POST", "/saved-account/v1/memories/add"], ["GET", "/api/hello"], ["HEAD", "/api/hello?query=fixture"],
      ["HEAD", "/api/hello/"], ["HEAD", "/unknown"], ["GET", "/saved-account/v1/memories/search"],
      ["POST", "/saved-account/v1/memories/search?query=fixture"], [undefined, undefined]]) {
      assert.equal(classifyLifecycleRequest(method, path, allowSearch), "unexpected");
    }
  }
  assert.equal(classifyLifecycleRequest("POST", "/saved-account/v1/memories/search", "true"), "unexpected");
});

test("Claude lifecycle selects the exact user plugin beside unrelated native entries", () => {
  const target = plugin();
  assert.equal(selectLifecyclePlugin([{ ...target, id: "another@marketplace" }, target], "0.1.19"), target);
  for (const plugins of [[], [{ ...target, id: `${pluginId}-unrelated` }], [target, { ...target }]]) {
    rejects(() => selectLifecyclePlugin(plugins, "0.1.19"), "CLAUDE_LIFECYCLE_PLUGIN_NOT_UNIQUE");
  }
});

test("Claude lifecycle rejects disabled, wrong-scope, stale or unlocated plugins", () => {
  for (const change of [{ enabled: false }, { scope: "project" }, { scope: undefined },
    { version: "0.1.18" }, { installPath: "" }, { installPath: "  " }, { installPath: null }]) {
    rejects(() => selectLifecyclePlugin([{ ...plugin(), ...change }], "0.1.19"), "CLAUDE_LIFECYCLE_PLUGIN_NOT_READY");
  }
  rejects(() => selectLifecyclePlugin([plugin()], ""), "CLAUDE_LIFECYCLE_PLUGIN_NOT_READY");
});

test("Claude lifecycle requires one local marketplace", () => {
  const target = marketplace();
  assert.equal(assertLifecycleMarketplace([target, { name: "another" }]), target);
  for (const values of [[], [{ ...target, name: `${marketplaceName}-unrelated` }], [target, { ...target }]]) {
    rejects(() => assertLifecycleMarketplace(values), "CLAUDE_LIFECYCLE_MARKETPLACE_NOT_UNIQUE");
  }
  for (const change of [{ source: "github" }, { source: undefined }, { path: "" }, { path: null }]) {
    rejects(() => assertLifecycleMarketplace([{ ...target, ...change }]), "CLAUDE_LIFECYCLE_MARKETPLACE_NOT_LOCAL");
  }
});

test("Claude lifecycle fails closed on malformed native lists", () => {
  for (const value of [undefined, null, {}, [null], [{}], ["private text"]]) {
    rejects(() => selectLifecyclePlugin(value, "0.1.19"), "CLAUDE_LIFECYCLE_PLUGIN_LIST_INVALID");
    rejects(() => assertLifecycleMarketplace(value), "CLAUDE_LIFECYCLE_MARKETPLACE_LIST_INVALID");
    rejects(() => assertLifecycleIntegrationAbsent(value, [], {}), "CLAUDE_LIFECYCLE_REMOVAL_LIST_INVALID");
    rejects(() => assertLifecycleIntegrationAbsent([], value, {}), "CLAUDE_LIFECYCLE_REMOVAL_LIST_INVALID");
  }
});

test("Claude settings permit only the owned native registration to change", () => {
  const original = settings(), snapshot = snapshotClaudeSettings(original), installed = structuredClone(original);
  installed.enabledPlugins[pluginId] = true;
  installed.extraKnownMarketplaces[marketplaceName] = { source: { source: "directory", path: "/fixture/new" } };
  assertClaudeSettings(installed, snapshot);
  assertClaudeSettings(original, snapshot);
  assert.deepEqual(original, settings());
  assertClaudeSettings({ model: "fixture", enabledPlugins: { [pluginId]: true }, extraKnownMarketplaces: {} }, { model: "fixture" });
  installed.env.ANTHROPIC_API_KEY = "changed";
  assert.equal(snapshot.env.ANTHROPIC_API_KEY, original.env.ANTHROPIC_API_KEY);
});

test("Claude settings reject provider changes and preserve unrelated plugin choices", () => {
  const snapshot = snapshotClaudeSettings(settings());
  for (const mutate of [
    (value) => { value.env.ANTHROPIC_API_KEY = "replaced"; },
    (value) => { delete value.env.ANTHROPIC_BASE_URL; },
    (value) => { value.env.CLAUDE_CODE_USE_GATEWAY = "1"; },
    (value) => { value.model = "different"; },
    (value) => { value.permissions.deny = []; },
    (value) => { value.disableAllHooks = true; },
    (value) => { value.enabledPlugins["another-plugin@another-marketplace"] = true; },
    (value) => { delete value.extraKnownMarketplaces["another-marketplace"]; },
  ]) {
    const changed = settings();
    mutate(changed);
    rejects(() => assertClaudeSettings(changed, snapshot), "CLAUDE_LIFECYCLE_SETTINGS_CHANGED");
  }
});

test("Claude settings reject malformed registration containers", () => {
  for (const value of [null, [], "private", { enabledPlugins: null }, { extraKnownMarketplaces: [] }]) {
    rejects(() => snapshotClaudeSettings(value), "CLAUDE_LIFECYCLE_SETTINGS_INVALID");
  }
});

test("Claude Hook comparison requires complete commands, matchers and shell identity", () => {
  assertLifecycleHooks(hooks(), hooks(), shell(), shell());
  for (const mutate of [
    (value) => { value.hooks.SessionStart = []; },
    (value) => { value.hooks.SessionStart[0].matcher = "startup"; },
    (value) => { value.hooks.SessionStart[0].hooks[0].command = "different"; },
    (value) => { value.hooks.SessionStart[0].hooks[0].timeout = 1; },
  ]) {
    const changed = hooks();
    mutate(changed);
    rejects(() => assertLifecycleHooks(changed, hooks(), shell(), shell()), "CLAUDE_LIFECYCLE_HOOKS_CHANGED");
  }
  for (const field of ["version", "runtimeAbi", "shellVersion"]) {
    rejects(() => assertLifecycleHooks(hooks(), hooks(), { ...shell(), [field]: "wrong" }, shell()),
      "CLAUDE_LIFECYCLE_SHELL_CHANGED");
  }
  rejects(() => assertLifecycleHooks({}, {}, shell(), shell()), "CLAUDE_LIFECYCLE_HOOKS_CHANGED");
  rejects(() => assertLifecycleHooks(hooks(), hooks(), {}, {}), "CLAUDE_LIFECYCLE_SHELL_CHANGED");
});

test("Claude uninstall requires both native registration and owned settings to disappear", () => {
  assertLifecycleIntegrationAbsent([{ ...plugin(), id: "another@marketplace" }], [{ name: "another" }], settings());
  for (const [plugins, marketplaces, config] of [
    [[plugin()], [], {}], [[], [marketplace()], {}],
    [[], [], { enabledPlugins: { [pluginId]: false } }],
    [[], [], { extraKnownMarketplaces: { [marketplaceName]: {} } }],
  ]) rejects(() => assertLifecycleIntegrationAbsent(plugins, marketplaces, config), "CLAUDE_LIFECYCLE_REGISTRATION_REMAINS");
});

test("Claude lifecycle errors never include private values", () => {
  const privateText = "private-path-and-credential-canary";
  for (const run of [
    () => selectLifecyclePlugin([{ ...plugin(), installPath: privateText, enabled: false }], "0.1.19"),
    () => assertLifecycleMarketplace([{ ...marketplace(), source: privateText }]),
    () => assertClaudeSettings({ env: { ANTHROPIC_API_KEY: privateText } }, snapshotClaudeSettings(settings())),
    () => assertLifecycleHooks({ hooks: { [privateText]: [] } }, hooks(), shell(), shell()),
  ]) assert.throws(run, (error) => error.message === error.testCode && !error.stack.includes(privateText));
});
