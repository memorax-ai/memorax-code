import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { renderDefaultMemoraxCodeConfig } from "../../dist/config/memorax-code.js";
import { isProcessAlive } from "../../dist/lifecycle/backend/service.js";
import { withBackendLifecycleLock } from "../../dist/lifecycle/lock.js";
import { freePort } from "../support/helpers.mjs";
import {
  readSetupCompletionRecord,
  writeSetupCompletionRecord,
} from "../../../memorax-code-adapter-common/src/setup-completion.mjs";

import {
  pathExists,
  prepareActiveCodexPlugin,
  prepareClaudePluginCli,
  runCli,
  terminateFixtureBackends,
  writeManagedClientsConfig,
} from "./support/backend-service-fixtures.mjs";

test("Backend lifecycle authority preserves nested operation lock failures", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-lifecycle-lock-owner-"));
  const error = Object.assign(new Error("nested config lock timed out"), { code: "JSON_FILE_LOCK_TIMEOUT" });
  try {
    await assert.rejects(withBackendLifecycleLock({ home }, () => { throw error; }), (actual) => actual === error);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("memorax-code lifecycle installs and disables only managed Trae Hooks", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-lifecycle-trae-"));
  const home = join(root, "memorax-code-home");
  const traeHome = join(root, "trae-home");
  const hooksPath = join(traeHome, "hooks.json");
  const port = await freePort();
  const cliPath = fileURLToPath(new URL("../../dist/memorax-code.js", import.meta.url));
  const userHook = { hooks: [{ type: "command", command: "user-owned-hook" }] };
  await mkdir(traeHome, { recursive: true });
  await writeFile(hooksPath, `${JSON.stringify({
    customSetting: true,
    hooks: { UserPromptSubmit: [userHook] },
  }, null, 2)}\n`);
  const args = [
    "--home", home,
    "--port", String(port),
    "--trae-home", traeHome,
    "--clients", "trae",
  ];
  try {
    const started = await runCli(cliPath, ["start", "--json", ...args]);
    assert.equal(started.code, 0, `${started.stdout}\n${started.stderr}`);
    const startReport = JSON.parse(started.stdout);
    assert.equal(startReport.ok, true);
    assert.equal(startReport.backend.ok, true);
    assert.equal(startReport.traeAdapter.installed, true);
    assert.equal(startReport.traeAdapter.enabled, true);
    assert.equal(startReport.traeAdapter.integration, "hooks");
    assert.equal(startReport.traeAdapter.traeHooks.configured, true);
    assert.equal(startReport.traeAdapter.traeHooks.runtimeObserved, false);
    assert.equal(startReport.traeAdapter.globalHooksActivationRequired, true);
    assert.equal(startReport.traeAdapter.traeSkills.ok, true);

    const installedHooks = JSON.parse(await readFile(hooksPath, "utf8"));
    assert.equal(installedHooks.customSetting, true);
    assert.equal(JSON.stringify(installedHooks).includes("user-owned-hook"), true);
    assert.equal(traeHookCount(installedHooks), 3);
    assert.equal(await pathExists(join(traeHome, "skills", "memorax-code", "SKILL.md")), true);

    const status = await runCli(cliPath, ["status", "--json", ...args]);
    assert.equal(status.code, 0, `${status.stdout}\n${status.stderr}`);
    assert.equal(JSON.parse(status.stdout).traeAdapter.enabled, true);

    const stopped = await runCli(cliPath, ["stop", "--json", ...args]);
    assert.equal(stopped.code, 0, `${stopped.stdout}\n${stopped.stderr}`);
    const stopReport = JSON.parse(stopped.stdout);
    assert.equal(stopReport.ok, true);
    assert.equal(stopReport.traeAdapter.enabled, false);
    const stoppedHooks = JSON.parse(await readFile(hooksPath, "utf8"));
    assert.equal(stoppedHooks.customSetting, true);
    assert.equal(JSON.stringify(stoppedHooks).includes("user-owned-hook"), true);
    assert.equal(traeHookCount(stoppedHooks), 0);
  } finally {
    await runCli(cliPath, ["stop", "--json", ...args]);
    await rm(root, { recursive: true, force: true });
  }
});

function traeHookCount(config) {
  return Object.values(config.hooks).flatMap((groups) => groups)
    .flatMap((group) => group.hooks ?? [])
    .filter(({ command = "" }) => {
      const encoded = / -EncodedCommand ([A-Za-z0-9+/=]+)$/.exec(command)?.[1];
      const script = encoded ? Buffer.from(encoded, "base64").toString("utf16le") : command;
      return script.includes("--memorax-code-trae-hook-v1");
    }).length;
}

test("CodeBuddy and WorkBuddy retain separate homes through partial stop and uninstall", { timeout: 30_000 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "memorax-code-buddy-clients-")));
  const home = join(root, "backend");
  const codeBuddyHome = join(root, "cli-config");
  const workBuddyHome = join(root, "desktop-config");
  const port = await freePort();
  const cliPath = fileURLToPath(new URL("../../dist/memorax-code.js", import.meta.url));
  const args = ["--home", home, "--port", String(port), "--json"];
  const env = { MEMORAX_CODE_CODEBUDDY_COMMAND: process.execPath, MEMORAX_CODE_WORKBUDDY_COMMAND: process.execPath };
  const pluginId = "memorax-code-codebuddy-adapter@memorax-code-local";
  const installationPath = join(home, "adapters", "workbuddy", "installation.json");
  try {
    const legacyPluginRoot = join(workBuddyHome, "plugins", "marketplaces", "memorax-code-local", "plugins", "memorax-code-codebuddy-adapter");
    await mkdir(legacyPluginRoot, { recursive: true });
    await mkdir(home, { recursive: true });
    await writeFile(join(legacyPluginRoot, ".memorax-code-package.json"), JSON.stringify({
      version: 1, codeBuddyHome: workBuddyHome, codeBuddyCommand: "codebuddy",
    }));
    await writeFile(join(home, "config.toml"), [
      "[clients]", "codex = false", "claude = false", "dsh = false", "opencode = false", "trae = false", "codebuddy = true", "",
    ].join("\n"));
    const migrated = await runCli(cliPath, ["start", ...args, "--workbuddy-home", "desktop-config"], { env, cwd: root });
    assert.equal(migrated.code, 0, migrated.stdout + migrated.stderr);
    assert.equal(JSON.parse(migrated.stdout).codebuddyAdapter, undefined);
    assert.equal(JSON.parse(migrated.stdout).workbuddyAdapter.codeBuddyHome, workBuddyHome);
    assert.equal(await pathExists(codeBuddyHome), false);
    const migratedInstallation = JSON.parse(await readFile(installationPath, "utf8"));
    assert.equal(migratedInstallation.legacyClientAlias, true);
    assert.equal(migratedInstallation.codeBuddyCommand, "codebuddy");

    const start = await runCli(cliPath, ["start", ...args, "--clients", "codebuddy,workbuddy",
      "--codebuddy-home", codeBuddyHome, "--workbuddy-home", workBuddyHome], { env });
    assert.equal(start.code, 0, start.stdout + start.stderr);
    const started = JSON.parse(start.stdout);
    assert.equal(started.codebuddyAdapter.runtime, "codebuddy");
    assert.equal(started.workbuddyAdapter.runtime, "workbuddy");
    const legacyHomeStart = await runCli(cliPath, ["start", ...args, "--preserve-clients", "--codebuddy-home", workBuddyHome], { env });
    assert.equal(legacyHomeStart.code, 0, legacyHomeStart.stdout + legacyHomeStart.stderr);
    assert.equal(JSON.parse(legacyHomeStart.stdout).codebuddyAdapter.codeBuddyHome, codeBuddyHome);
    assert.equal(JSON.parse(legacyHomeStart.stdout).workbuddyAdapter.codeBuddyHome, workBuddyHome);
    const workBuddyOnly = await runCli(cliPath, ["start", ...args, "--clients", "workbuddy", "--codebuddy-home", workBuddyHome], { env });
    assert.equal(workBuddyOnly.code, 0, workBuddyOnly.stdout + workBuddyOnly.stderr);
    assert.equal(JSON.parse(workBuddyOnly.stdout).workbuddyAdapter.codeBuddyHome, workBuddyHome);
    assert.equal(JSON.parse(await readFile(join(codeBuddyHome, "settings.json"), "utf8")).enabledPlugins[pluginId], false);
    assert.equal(JSON.parse(await readFile(join(workBuddyHome, "settings.json"), "utf8")).enabledPlugins[pluginId], true);
    for (const selection of [["--clients", "codebuddy"], ["--preserve-clients"]]) {
      const cliOnly = await runCli(cliPath, ["start", ...args, ...selection], { env });
      assert.equal(cliOnly.code, 0, cliOnly.stdout + cliOnly.stderr);
      assert.equal(JSON.parse(cliOnly.stdout).workbuddyAdapter, undefined);
      assert.equal(JSON.parse(await readFile(join(workBuddyHome, "settings.json"), "utf8")).enabledPlugins[pluginId], false);
    }
    const both = await runCli(cliPath, ["start", ...args, "--clients", "codebuddy,workbuddy"], { env });
    assert.equal(both.code, 0, both.stdout + both.stderr);
    const workBuddySettings = await readFile(join(workBuddyHome, "settings.json"), "utf8");
    const stop = await runCli(cliPath, ["stop", ...args, "--clients", "codebuddy"], { env });
    assert.equal(stop.code, 0, stop.stdout + stop.stderr);
    assert.equal(JSON.parse(stop.stdout).backend.reason, "active_clients_remaining");
    assert.equal(await readFile(join(workBuddyHome, "settings.json"), "utf8"), workBuddySettings);
    assert.equal(JSON.parse(await readFile(join(codeBuddyHome, "settings.json"), "utf8")).enabledPlugins[pluginId], false);
    const uninstall = await runCli(cliPath, ["uninstall", ...args, "--clients", "codebuddy", "--no-npm-uninstall"], { env });
    assert.equal(uninstall.code, 0, uninstall.stdout + uninstall.stderr);
    assert.equal(JSON.parse(uninstall.stdout).npmPackageRemoval.reason, "partial_client_uninstall");
    assert.equal(await readFile(join(workBuddyHome, "settings.json"), "utf8"), workBuddySettings);
    assert.equal(await pathExists(join(codeBuddyHome, "plugins", "marketplaces", "memorax-code-local")), false);
    const status = await runCli(cliPath, ["status", ...args], { env });
    assert.equal(status.code, 0, status.stdout + status.stderr);
    assert.equal(JSON.parse(status.stdout).workbuddyAdapter.enabled, true);
    assert.equal(JSON.parse(status.stdout).codebuddyAdapter, undefined);
  } finally {
    await runCli(cliPath, ["stop", ...args, "--clients", "codebuddy,workbuddy"], { env });
    await rm(root, { recursive: true, force: true });
  }
});

test("stop preserves setup completion while complete uninstall clears it and preserves config", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-uninstall-completion-home-"));
  const port = await freePort();
  const cliPath = fileURLToPath(new URL("../../dist/memorax-code.js", import.meta.url));
  const config = [
    "[clients]",
    "codex = false",
    "claude = false",
    "dsh = false",
    "opencode = false",
    "",
    "[memorax]",
    'user_id = "saved-user"',
    "",
  ].join("\n");
  await writeFile(join(home, "config.toml"), config);
  writeSetupCompletionRecord({
    memoraxCodeHome: home,
    completedAt: "2026-08-15T08:00:00.000Z",
    completedByVersion: "0.1.5",
  });
  try {
    const stopped = await runCli(cliPath, [
      "stop", "--json",
      "--home", home,
      "--port", String(port),
      "--clients", "none",
    ]);
    assert.equal(stopped.code, 0, `${stopped.stdout}\n${stopped.stderr}`);
    assert.equal(readSetupCompletionRecord(home).status, "valid");

    const uninstalled = await runCli(cliPath, [
      "uninstall", "--json",
      "--home", home,
      "--port", String(port),
      "--clients", "none",
      "--no-npm-uninstall",
    ]);
    assert.equal(uninstalled.code, 0, `${uninstalled.stdout}\n${uninstalled.stderr}`);
    assert.deepEqual(readSetupCompletionRecord(home), { status: "absent" });
    assert.equal(await readFile(join(home, "config.toml"), "utf8"), config);
  } finally {
    await runCli(cliPath, [
      "stop", "--json",
      "--home", home,
      "--port", String(port),
      "--clients", "none",
    ]);
    await rm(home, { recursive: true, force: true });
  }
});

test("Codex lifecycle seeds defaults, reports readiness, and preserves custom provider config", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-lifecycle-home-"));
  const codexHome = await mkdtemp(join(tmpdir(), "memorax-code-lifecycle-codex-"));
  const port = await freePort();
  const cliPath = fileURLToPath(new URL("../../dist/memorax-code.js", import.meta.url));
  const originalBaseUrl = "http://127.0.0.1:9999/openai";
  const originalConfig = [
    'model_provider = "custom"',
    'model = "gpt-5.5"',
    "",
    "[model_providers.custom]",
    'name = "Custom"',
    `base_url = "${originalBaseUrl}"`,
    'wire_api = "responses"',
    "",
  ].join("\n");
  await writeFile(join(codexHome, "config.toml"), originalConfig);
  await prepareActiveCodexPlugin(codexHome);
  try {
    const started = await runCli(cliPath, [
      "start", "--json",
      "--home", home,
      "--port", String(port),
      "--codex-home", codexHome,
      "--clients", "codex",
    ]);
    assert.equal(started.code, 0, `${started.stdout}\n${started.stderr}`);
    const startReport = JSON.parse(started.stdout);
    assert.equal(startReport.ok, true);
    assert.equal(startReport.backend.ok, true);
    assert.equal(startReport.codexAdapter.ok, true);
    assert.equal(startReport.codexAdapter.installed, true);
    assert.equal(startReport.codexAdapter.enabled, true);
    assert.equal(startReport.codexAdapter.integration, "hooks");
    assert.equal(await readFile(join(codexHome, "config.toml"), "utf8"), originalConfig);
    assert.equal(await readFile(join(home, "config.toml"), "utf8"), renderDefaultMemoraxCodeConfig());

    const readyStatus = await runCli(cliPath, [
      "status",
      "--home", home,
      "--port", String(port),
      "--codex-home", codexHome,
      "--clients", "codex",
    ]);
    assert.equal(readyStatus.code, 0, `${readyStatus.stdout}\n${readyStatus.stderr}`);
    assert.match(readyStatus.stdout, /^\[MemoraX Code Backend\]: MemoraX Code Backend status: .*Enabled/m);
    assert.match(readyStatus.stdout, /^\[MemoraX Code Backend\]: Codex adapter: ok integration=hooks skills=plugin-managed/m);
    assert.doesNotMatch(readyStatus.stdout, /^\[MemoraX Code Backend\]: Claude adapter:/m);
    assert.doesNotMatch(readyStatus.stdout, /Claude adapter is not enabled/);
    assert.doesNotMatch(readyStatus.stdout, /Run `memorax-code start`, then restart or refresh Claude Code/);

    const updated = await runCli(cliPath, [
      "start", "--json",
      "--home", home,
      "--port", String(port),
      "--codex-home", codexHome,
      "--clients", "codex",
    ]);
    assert.equal(updated.code, 0, `${updated.stdout}\n${updated.stderr}`);
    const updateReport = JSON.parse(updated.stdout);
    assert.equal(updateReport.codexAdapter.ok, true);
    assert.equal(updateReport.backend.ok, true);
    const updatedState = JSON.parse(await readFile(join(home, "adapters", "codex", "state.json"), "utf8"));
    assert.equal(updatedState.integration, "hooks");
    assert.equal(updatedState.enabled, true);

    const status = await runCli(cliPath, [
      "status", "--json",
      "--home", home,
      "--port", String(port),
      "--codex-home", codexHome,
      "--clients", "codex",
    ]);
    assert.equal(status.code, 0, `${status.stdout}\n${status.stderr}`);

    const stopped = await runCli(cliPath, [
      "stop", "--json",
      "--home", home,
      "--port", String(port),
      "--codex-home", codexHome,
      "--clients", "codex",
    ]);
    assert.equal(stopped.code, 0, `${stopped.stdout}\n${stopped.stderr}`);
    const stopReport = JSON.parse(stopped.stdout);
    assert.equal(stopReport.ok, true);
    assert.equal(stopReport.backend.ok, true);
    assert.equal(stopReport.codexAdapter.ok, true);
    assert.equal(await readFile(join(codexHome, "config.toml"), "utf8"), originalConfig);
    const stoppedState = JSON.parse(await readFile(join(home, "adapters", "codex", "state.json"), "utf8"));
    assert.equal(stoppedState.integration, "hooks");
    assert.equal(stoppedState.enabled, false);
  } finally {
    await runCli(cliPath, ["stop", "--json", "--home", home, "--port", String(port), "--codex-home", codexHome, "--clients", "codex"]);
  }
});

test("failed Backend start leaves Codex config unchanged", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-lifecycle-transaction-failure-home-"));
  const codexHome = await mkdtemp(join(tmpdir(), "memorax-code-lifecycle-transaction-failure-codex-"));
  const cliPath = fileURLToPath(new URL("../../dist/memorax-code.js", import.meta.url));
  const originalConfig = [
    'model_provider = "custom"',
    "",
    "[model_providers.custom]",
    'base_url = "http://127.0.0.1:9999/v1"',
    'wire_api = "responses"',
    "",
  ].join("\n");
  await writeFile(join(codexHome, "config.toml"), originalConfig);
  await prepareActiveCodexPlugin(codexHome);
  try {
    const started = await runCli(cliPath, [
      "start", "--json",
      "--home", home,
      "--host", "192.0.2.1",
      "--codex-home", codexHome,
      "--clients", "codex",
    ]);

    assert.equal(started.code, 1, `${started.stdout}\n${started.stderr}`);
    assert.equal(await readFile(join(codexHome, "config.toml"), "utf8"), originalConfig);
    const state = JSON.parse(await readFile(join(home, "adapters", "codex", "state.json"), "utf8"));
    assert.equal(state.integration, "hooks");
    assert.equal(state.enabled, false);
  } finally {
    await runCli(cliPath, [
      "stop", "--json",
      "--home", home,
      "--host", "192.0.2.1",
      "--codex-home", codexHome,
      "--clients", "codex",
    ]);
    await rm(home, { recursive: true, force: true });
    await rm(codexHome, { recursive: true, force: true });
  }
});

test("start recovers the Backend when Codex preparation fails after shutdown", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-start-recovery-home-"));
  const codexHome = await mkdtemp(join(tmpdir(), "memorax-code-start-recovery-codex-"));
  const port = await freePort();
  const cliPath = fileURLToPath(new URL("../../dist/memorax-code.js", import.meta.url));
  const codexStatePath = join(home, "adapters", "codex", "state.json");
  const observedBackends = new Map();
  const commonArgs = [
    "--home", home,
    "--port", String(port),
    "--codex-home", codexHome,
  ];
  await prepareActiveCodexPlugin(codexHome);
  try {
    const initial = await runCli(cliPath, [
      "start", "--json", ...commonArgs, "--clients", "codex",
    ]);
    assert.equal(initial.code, 0, `${initial.stdout}\n${initial.stderr}`);
    const initialState = JSON.parse(initial.stdout).backend.state;
    observedBackends.set(initialState.pid, initialState);

    await rm(codexStatePath, { force: true });
    await mkdir(codexStatePath);
    const failed = await runCli(cliPath, [
      "start", "--json", ...commonArgs, "--clients", "codex",
    ]);

    assert.equal(failed.code, 1, `${failed.stdout}\n${failed.stderr}`);
    assert.equal(failed.stderr, "");
    const report = JSON.parse(failed.stdout);
    assert.equal(report.ok, false);
    assert.equal(report.codexAdapter.ok, false);
    assert.equal(report.codexAdapter.reason, "state_unreadable");
    assert.equal(report.backend.ok, true, report.backend.error);
    assert.equal(
      report.backend.reason,
      "codex_adapter_enable_failed_backend_recovered",
    );
    observedBackends.set(report.backend.state.pid, report.backend.state);
    const health = await fetch(`http://127.0.0.1:${port}/health`).then(
      (response) => response.json(),
    );
    assert.equal(health.ok, true);
    assert.equal(health.instanceId, report.backend.state.instanceId);
  } finally {
    await rm(codexStatePath, { recursive: true, force: true });
    await runCli(cliPath, ["stop", "--json", ...commonArgs, "--clients", "none"]);
    try {
      await terminateFixtureBackends(observedBackends.values());
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(codexHome, { recursive: true, force: true });
    }
  }
});

test("start recovers the Backend when CodeBuddy preparation fails after shutdown", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-start-codebuddy-recovery-"));
  const home = join(root, "memorax-code-home");
  const codeBuddyHome = join(root, "blocked-codebuddy-home");
  const port = await freePort();
  const cliPath = fileURLToPath(new URL("../../dist/memorax-code.js", import.meta.url));
  const observedBackends = new Map();
  const commonArgs = ["--home", home, "--port", String(port)];
  await writeFile(codeBuddyHome, "not a directory\n");
  try {
    const initial = await runCli(cliPath, [
      "start", "--json", ...commonArgs, "--clients", "none",
    ]);
    assert.equal(initial.code, 0, `${initial.stdout}\n${initial.stderr}`);
    const initialState = JSON.parse(initial.stdout).backend.state;
    observedBackends.set(initialState.pid, initialState);

    const failed = await runCli(cliPath, [
      "start", "--json", ...commonArgs,
      "--codebuddy-home", codeBuddyHome,
      "--clients", "codebuddy",
    ]);

    assert.equal(failed.code, 1, `${failed.stdout}\n${failed.stderr}`);
    assert.equal(failed.stderr, "");
    const report = JSON.parse(failed.stdout);
    assert.equal(report.ok, false);
    assert.equal(report.codebuddyAdapter.ok, false);
    assert.match(report.codebuddyAdapter.error, /ENOTDIR|not a directory/i);
    assert.equal(report.dshAdapter, undefined);
    assert.equal(report.backend.ok, true, report.backend.error);
    assert.equal(
      report.backend.reason,
      "codebuddy_adapter_enable_failed_backend_recovered",
    );
    observedBackends.set(report.backend.state.pid, report.backend.state);
    const health = await fetch(`http://127.0.0.1:${port}/health`).then(
      (response) => response.json(),
    );
    assert.equal(health.ok, true);
    assert.equal(health.instanceId, report.backend.state.instanceId);
  } finally {
    await runCli(cliPath, ["stop", "--json", ...commonArgs, "--clients", "none"]);
    try {
      await terminateFixtureBackends(observedBackends.values());
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("memorax-code start preserves custom Claude provider settings while enabling Hooks", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-lifecycle-claude-home-"));
  const claudeHome = await mkdtemp(join(tmpdir(), "memorax-code-lifecycle-claude-config-"));
  const ignoredClaudeHome = await mkdtemp(join(tmpdir(), "memorax-code-lifecycle-claude-ignored-config-"));
  const workspace = join(home, "workspace", "Claude-Repo");
  const port = await freePort();
  const cliPath = fileURLToPath(new URL("../../dist/memorax-code.js", import.meta.url));
  const pluginCli = await prepareClaudePluginCli(home);
  const originalSettings = `${JSON.stringify({
    env: {
      ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
      ANTHROPIC_AUTH_TOKEN: "deepseek-secret",
      ANTHROPIC_MODEL: "deepseek-v4-pro",
    },
  }, null, 2)}\n`;
  await Promise.all([
    mkdir(join(workspace, ".git"), { recursive: true }),
    mkdir(join(claudeHome, "projects", "encoded-project"), { recursive: true }),
  ]);
  await writeFile(join(claudeHome, "projects", "encoded-project", "lifecycle-session.jsonl"), `${JSON.stringify({
    type: "user",
    userType: "external",
    sessionId: "lifecycle-session",
    uuid: "lifecycle-user-record",
    promptId: "lifecycle-turn",
    cwd: workspace,
    timestamp: new Date().toISOString(),
    message: { role: "user", content: "private lifecycle Claude prompt" },
  })}\n`, "utf8");
  await writeFile(join(claudeHome, "settings.json"), originalSettings);
  const env = {
    CLAUDE_CONFIG_DIR: ignoredClaudeHome,
    FAKE_CLAUDE_PLUGIN_CALLS: pluginCli.callsPath,
    MEMORAX_CODE_CLAUDE_COMMAND: pluginCli.claudeCommand,
    ANTHROPIC_BASE_URL: "",
  };
  try {
    const started = await runCli(cliPath, [
      "start", "--json",
      "--home", home,
      "--port", String(port),
      "--claude-home", claudeHome,
      "--clients", "claude",
    ], { env });
    assert.equal(started.code, 0, `${started.stdout}\n${started.stderr}`);
    const startReport = JSON.parse(started.stdout);
    assert.equal(startReport.ok, true);
    assert.equal(startReport.backend.ok, true);
    assert.equal(startReport.claudeAdapter.ok, true);
    assert.equal(startReport.claudeAdapter.integration, "hooks");
    assert.equal(startReport.claudeAdapter.claudeSkills.status, "plugin-managed");
    assert.equal(startReport.claudeAdapter.claudeSkills.delivery, "plugin");
    assert.equal(await readFile(join(claudeHome, "settings.json"), "utf8"), originalSettings);
    const adapterState = JSON.parse(await readFile(join(home, "adapters", "claude-code", "state.json"), "utf8"));
    assert.equal(adapterState.integration, "hooks");
    assert.equal(adapterState.enabled, true);
    assert.equal(adapterState.claudeSkillDelivery, "plugin");
    assert.equal(adapterState.claudePluginSkillsRoot, join(pluginCli.pluginInstallPath, "skills"));
    assert.equal(await pathExists(join(claudeHome, "skills", "memorax-code")), false);
    const status = await runCli(cliPath, [
      "status", "--json",
      "--home", home,
      "--port", String(port),
      "--claude-home", claudeHome,
      "--clients", "claude",
    ], { env });
    assert.equal(status.code, 0, `${status.stdout}\n${status.stderr}`);
    const statusReport = JSON.parse(status.stdout);
    assert.equal(statusReport.claudeAdapter.integration, "hooks");
    assert.equal(statusReport.claudeAdapter.claudeSkills.status, "plugin-managed");
    assert.equal(await readFile(join(claudeHome, "settings.json"), "utf8"), originalSettings);
  } finally {
    await runCli(cliPath, [
      "stop", "--json",
      "--home", home,
      "--port", String(port),
      "--claude-home", claudeHome,
      "--clients", "claude",
    ], { env });
    await rm(home, { recursive: true, force: true });
    await rm(claudeHome, { recursive: true, force: true });
    await rm(ignoredClaudeHome, { recursive: true, force: true });
  }
});

test("memorax-code keeps Codex and Backend healthy after a managed Claude runtime is removed", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-lifecycle-removed-claude-home-"));
  const codexHome = await mkdtemp(join(tmpdir(), "memorax-code-lifecycle-removed-claude-codex-"));
  const claudeHome = await mkdtemp(join(tmpdir(), "memorax-code-lifecycle-removed-claude-config-"));
  const workspace = join(home, "workspace", "Claude-Repo");
  const transcriptDirectory = join(claudeHome, "projects", "encoded-project");
  const port = await freePort();
  const cliPath = fileURLToPath(new URL("../../dist/memorax-code.js", import.meta.url));
  const pluginCli = await prepareClaudePluginCli(home);
  await prepareActiveCodexPlugin(codexHome);
  await writeManagedClientsConfig(home, { codex: true, claude: true });
  const availableEnv = {
    CLAUDE_CONFIG_DIR: claudeHome,
    FAKE_CLAUDE_PLUGIN_CALLS: pluginCli.callsPath,
    MEMORAX_CODE_CLAUDE_COMMAND: pluginCli.claudeCommand,
  };
  const commonArgs = [
    "--home", home,
    "--port", String(port),
    "--codex-home", codexHome,
    "--claude-home", claudeHome,
    "--clients", "codex,claude",
  ];
  try {
    await Promise.all([
      mkdir(join(workspace, ".git"), { recursive: true }),
      mkdir(transcriptDirectory, { recursive: true }),
    ]);
    await writeFile(join(transcriptDirectory, "removed-runtime-session.jsonl"), `${JSON.stringify({
      type: "user",
      userType: "external",
      sessionId: "removed-runtime-session",
      uuid: "removed-runtime-user-record",
      promptId: "removed-runtime-turn",
      cwd: workspace,
      timestamp: new Date().toISOString(),
      message: { role: "user", content: "private removed-runtime Claude prompt" },
    })}\n`, "utf8");
    const initial = await runCli(cliPath, ["start", "--json", ...commonArgs], { env: availableEnv });
    assert.equal(initial.code, 0, `${initial.stdout}\n${initial.stderr}`);

    const missingEnv = {
      ...availableEnv,
      MEMORAX_CODE_CLAUDE_COMMAND: join(home, "missing-claude"),
    };
    const restarted = await runCli(cliPath, ["start", "--json", ...commonArgs], { env: missingEnv });
    assert.equal(restarted.code, 0, `${restarted.stdout}\n${restarted.stderr}`);
    const restartReport = JSON.parse(restarted.stdout);
    assert.equal(restartReport.ok, true);
    assert.equal(restartReport.backend.ok, true);
    assert.equal(restartReport.codexAdapter.ok, true);
    assert.equal(restartReport.claudeAdapter.ok, true);
    assert.equal(restartReport.claudeAdapter.skipped, true);
    assert.equal(restartReport.claudeAdapter.reason, "client_not_detected");

    const status = await runCli(cliPath, ["status", "--json", ...commonArgs], { env: missingEnv });
    assert.equal(status.code, 0, `${status.stdout}\n${status.stderr}`);
    const statusReport = JSON.parse(status.stdout);
    assert.equal(statusReport.ok, true);
    assert.equal(statusReport.backend.ok, true);
    assert.equal(statusReport.codexAdapter.ok, true);
    assert.equal(statusReport.claudeAdapter.skipped, true);
    assert.equal(statusReport.claudeAdapter.reason, "client_not_detected");

    const humanStatus = await runCli(cliPath, ["status", ...commonArgs], { env: missingEnv });
    assert.equal(humanStatus.code, 0, `${humanStatus.stdout}\n${humanStatus.stderr}`);
    assert.match(humanStatus.stdout, /Claude adapter: skipped client_not_detected/);
  } finally {
    await runCli(cliPath, ["stop", "--json", ...commonArgs], { env: availableEnv });
    await rm(home, { recursive: true, force: true });
    await rm(codexHome, { recursive: true, force: true });
    await rm(claudeHome, { recursive: true, force: true });
  }
});

test("memorax-code uninstall preserves temporary Claude cleanup scope after plugin removal fails", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-uninstall-claude-plugin-retry-home-"));
  const claudeHome = await mkdtemp(join(tmpdir(), "memorax-code-uninstall-claude-plugin-retry-config-"));
  const port = await freePort();
  const cliPath = fileURLToPath(new URL("../../dist/memorax-code.js", import.meta.url));
  const pluginCli = await prepareClaudePluginCli(home);
  const activeClientsPath = join(home, "runtime", "backend", "managed-clients.json");
  await writeManagedClientsConfig(home, { codex: true, claude: false });
  await writeFile(join(claudeHome, "settings.json"), `${JSON.stringify({
    env: {
      ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
      ANTHROPIC_API_KEY: "deepseek-secret",
    },
  }, null, 2)}\n`);
  const env = {
    CLAUDE_CONFIG_DIR: claudeHome,
    FAKE_CLAUDE_PLUGIN_CALLS: pluginCli.callsPath,
    MEMORAX_CODE_CLAUDE_COMMAND: pluginCli.claudeCommand,
  };
  const commonArgs = ["--home", home, "--port", String(port), "--claude-home", claudeHome];
  try {
    const started = await runCli(cliPath, ["start", "--json", ...commonArgs, "--clients", "claude"], { env });
    assert.equal(started.code, 0, `${started.stdout}\n${started.stderr}`);

    const failed = await runCli(cliPath, [
      "uninstall", "--json",
      ...commonArgs,
      "--clients", "claude",
      "--no-npm-uninstall",
    ], { env: { ...env, FAKE_CLAUDE_PLUGIN_UNINSTALL_FAIL: "1" } });
    assert.equal(failed.code, 1, `${failed.stdout}\n${failed.stderr}`);
    assert.equal(JSON.parse(failed.stdout).npmPackageRemoval.reason, "plugin_cleanup_failed");
    assert.deepEqual(JSON.parse(await readFile(activeClientsPath, "utf8")), {
      codex: false,
      claude: true,
      dsh: false,
      opencode: false,
    });

    const retried = await runCli(cliPath, [
      "uninstall", "--json",
      ...commonArgs,
      "--no-npm-uninstall",
    ], { env });
    assert.equal(retried.code, 0, `${retried.stdout}\n${retried.stderr}`);
    assert.equal(JSON.parse(retried.stdout).claudeAdapter.pluginRemove.ok, true);
    const calls = (await readFile(pluginCli.callsPath, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(calls.filter((call) => call.args[0] === "plugin" && call.args[1] === "uninstall").length, 2);
    assert.equal(await pathExists(activeClientsPath), false);
  } finally {
    await runCli(cliPath, ["stop", "--json", ...commonArgs, "--clients", "none"], { env });
    await rm(home, { recursive: true, force: true });
    await rm(claudeHome, { recursive: true, force: true });
  }
});

test("memorax-code uninstall leaves direct Claude provider settings unchanged", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-uninstall-claude-home-"));
  const claudeHome = await mkdtemp(join(tmpdir(), "memorax-code-uninstall-claude-config-"));
  const port = await freePort();
  const cliPath = fileURLToPath(new URL("../../dist/memorax-code.js", import.meta.url));
  const pluginCli = await prepareClaudePluginCli(home);
  await writeFile(join(claudeHome, "settings.json"), `${JSON.stringify({
    env: {
      ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
      ANTHROPIC_API_KEY: "deepseek-secret",
      ANTHROPIC_MODEL: "deepseek-v4-pro",
    },
  }, null, 2)}\n`);
  await mkdir(join(claudeHome, "plugins", "data", "memorax-code-claude-adapter-memorax-code-local"), { recursive: true });
  await writeFile(join(claudeHome, "plugins", "data", "memorax-code-claude-adapter-memorax-code-local", "state.json"), "{}\n");
  const env = {
    CLAUDE_CONFIG_DIR: claudeHome,
    FAKE_CLAUDE_PLUGIN_CALLS: pluginCli.callsPath,
    MEMORAX_CODE_CLAUDE_COMMAND: pluginCli.claudeCommand,
  };
  try {
    const started = await runCli(cliPath, [
      "start", "--json",
      "--home", home,
      "--port", String(port),
      "--clients", "claude",
    ], { env });
    assert.equal(started.code, 0, `${started.stdout}\n${started.stderr}`);

    const activeSettings = JSON.parse(await readFile(join(claudeHome, "settings.json"), "utf8"));
    assert.equal(activeSettings.env.ANTHROPIC_BASE_URL, "https://api.deepseek.com/anthropic");
    assert.equal(activeSettings.env.ANTHROPIC_API_KEY, "deepseek-secret");
    assert.equal(activeSettings.env.ANTHROPIC_AUTH_TOKEN, undefined);

    const uninstalled = await runCli(cliPath, [
      "uninstall", "--json",
      "--home", home,
      "--port", String(port),
      "--clients", "claude",
      "--no-npm-uninstall",
    ], { env });
    assert.equal(uninstalled.code, 0, `${uninstalled.stdout}\n${uninstalled.stderr}`);
    const uninstallReport = JSON.parse(uninstalled.stdout);
    assert.equal(uninstallReport.ok, true);
    assert.equal(uninstallReport.claudeAdapter.ok, true);
    assert.equal(uninstallReport.claudeAdapter.pluginRemove.ok, true);
    assert.equal(uninstallReport.removesPlugin, true);

    const restoredSettings = JSON.parse(await readFile(join(claudeHome, "settings.json"), "utf8"));
    assert.equal(restoredSettings.env.ANTHROPIC_BASE_URL, "https://api.deepseek.com/anthropic");
    assert.equal(restoredSettings.env.ANTHROPIC_API_KEY, "deepseek-secret");
    assert.equal(restoredSettings.env.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(restoredSettings.env.ANTHROPIC_MODEL, "deepseek-v4-pro");
    assert.equal(restoredSettings.extraKnownMarketplaces?.["memorax-code-local"], undefined);
    assert.equal(restoredSettings.enabledPlugins?.["memorax-code-claude-adapter@memorax-code-local"], undefined);
    assert.equal(
      await readFile(join(claudeHome, "plugins", "data", "memorax-code-claude-adapter-memorax-code-local", "state.json"), "utf8"),
      "{}\n",
    );
  } finally {
    await runCli(cliPath, ["stop", "--json", "--home", home, "--port", String(port), "--clients", "claude"], { env });
    await rm(home, { recursive: true, force: true });
    await rm(claudeHome, { recursive: true, force: true });
  }
});

test("Codex lifecycle skips a missing plugin, then registers it with --yes for activation", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-lifecycle-no-plugin-home-"));
  const codexHome = await mkdtemp(join(tmpdir(), "memorax-code-lifecycle-no-plugin-codex-"));
  const port = await freePort();
  const cliPath = fileURLToPath(new URL("../../dist/memorax-code.js", import.meta.url));
  const originalConfig = [
    'model_provider = "custom"',
    "",
    "[model_providers.custom]",
    'base_url = "http://127.0.0.1:9999/v1"',
    'wire_api = "responses"',
    "",
  ].join("\n");
  await writeFile(join(codexHome, "config.toml"), originalConfig);
  try {
    const started = await runCli(cliPath, [
      "start", "--json",
      "--home", home,
      "--port", String(port),
      "--codex-home", codexHome,
      "--clients", "codex",
    ]);
    assert.equal(started.code, 0, `${started.stdout}\n${started.stderr}`);
    const report = JSON.parse(started.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.backend.ok, true);
    assert.equal(report.codexAdapter.ok, true);
    assert.equal(report.codexAdapter.skipped, true);
    assert.equal(report.codexAdapter.reason, "codex_plugin_not_installed");
    assert.equal(await readFile(join(codexHome, "config.toml"), "utf8"), originalConfig);

    const registered = await runCli(cliPath, [
      "start",
      "--yes",
      "--home", home,
      "--port", String(port),
      "--codex-home", codexHome,
      "--marketplace-path", join(home, ".agents", "plugins", "marketplace.json"),
      "--clients", "codex",
    ]);
    assert.equal(registered.code, 0, `${registered.stdout}\n${registered.stderr}`);
    assert.match(registered.stdout, /Codex plugin source registered/);
    assert.match(registered.stdout, /Activate the MemoraX Code Codex Adapter plugin/);
    assert.match(registered.stdout, /^\[MemoraX Code Backend\]: Codex adapter: skipped codex_plugin_activation_required/m);
    assert.match(registered.stdout, /one or more adapters are not enabled/);
    const pluginManifest = JSON.parse(await readFile(join(codexHome, ".memorax-code", "plugins", "memorax-code-codex-adapter", ".codex-plugin", "plugin.json"), "utf8"));
    assert.equal(pluginManifest.name, "memorax-code-codex-adapter");
    const marketplace = JSON.parse(await readFile(join(home, ".agents", "plugins", "marketplace.json"), "utf8"));
    assert.equal(marketplace.plugins[0].name, "memorax-code-codex-adapter");
  } finally {
    await runCli(cliPath, ["stop", "--json", "--home", home, "--port", String(port), "--codex-home", codexHome, "--clients", "codex"]);
    await rm(home, { recursive: true, force: true });
    await rm(codexHome, { recursive: true, force: true });
  }
});

test("package replacement restores only previously active clients", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-package-replacement-home-"));
  const codexHome = await mkdtemp(join(tmpdir(), "memorax-code-package-replacement-codex-"));
  const port = await freePort();
  const cliPath = fileURLToPath(new URL("../../dist/memorax-code.js", import.meta.url));
  const activeClientsPath = join(home, "runtime", "backend", "managed-clients.json");
  const inactiveClients = { codex: false, claude: false, dsh: false, opencode: false };
  await writeManagedClientsConfig(home, { codex: true, claude: false });
  await mkdir(join(home, "runtime", "backend"), { recursive: true });
  await writeFile(activeClientsPath, `${JSON.stringify(inactiveClients)}\n`);
  try {
    const started = await runCli(cliPath, [
      "start", "--json",
      "--home", home,
      "--port", String(port),
      "--codex-home", codexHome,
    ], { env: { MEMORAX_CODE_PACKAGE_REPLACEMENT: "1" } });

    assert.equal(started.code, 0, `${started.stdout}\n${started.stderr}`);
    const report = JSON.parse(started.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.codexAdapter, undefined);
    assert.deepEqual(JSON.parse(await readFile(activeClientsPath, "utf8")), inactiveClients);
  } finally {
    await runCli(cliPath, [
      "stop", "--json",
      "--home", home,
      "--port", String(port),
      "--clients", "none",
    ]);
    await rm(home, { recursive: true, force: true });
    await rm(codexHome, { recursive: true, force: true });
  }
});

test("memorax-code start refreshes an already-running Backend process", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-lifecycle-refresh-home-"));
  const port = await freePort();
  const cliPath = fileURLToPath(new URL("../../dist/memorax-code.js", import.meta.url));
  try {
    const first = await runCli(cliPath, [
      "start", "--json",
      "--home", home,
      "--port", String(port),
      "--clients", "none",
    ]);
    assert.equal(first.code, 0, `${first.stdout}\n${first.stderr}`);
    const firstReport = JSON.parse(first.stdout);
    const firstPid = firstReport.backend.state.pid;
    assert.equal(firstReport.backend.alreadyRunning, undefined);
    assert.equal(isProcessAlive(firstPid), true);

    const second = await runCli(cliPath, [
      "start", "--json",
      "--home", home,
      "--port", String(port),
      "--clients", "none",
    ]);
    assert.equal(second.code, 0, `${second.stdout}\n${second.stderr}`);
    const secondReport = JSON.parse(second.stdout);
    const secondPid = secondReport.backend.state.pid;
    assert.notEqual(secondPid, firstPid);
    assert.equal(secondReport.backend.alreadyRunning, undefined);
    assert.equal(isProcessAlive(firstPid), false);
    assert.equal(isProcessAlive(secondPid), true);
  } finally {
    await runCli(cliPath, ["stop", "--json", "--home", home, "--port", String(port), "--clients", "none"]);
  }
});
