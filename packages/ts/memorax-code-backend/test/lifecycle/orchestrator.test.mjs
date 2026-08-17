import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { renderDefaultMemoraxCodeConfig } from "../../dist/config/memorax-code.js";
import { isProcessAlive, terminateProcessTree } from "../../dist/lifecycle/backend/service.js";
import { freePort } from "../support/helpers.mjs";

import {
  pathExists,
  prepareActiveCodexPlugin,
  prepareClaudePluginCli,
  runCli,
  waitForProcessExit,
  writeManagedClientsConfig,
} from "./support/backend-service-fixtures.mjs";

test("memorax-code start and stop preserve custom Codex provider config on the Hook lifecycle", async () => {
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
  const observedPids = new Set();
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
    observedPids.add(JSON.parse(initial.stdout).backend.state.pid);

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
    observedPids.add(report.backend.state.pid);
    const health = await fetch(`http://127.0.0.1:${port}/health`).then(
      (response) => response.json(),
    );
    assert.equal(health.ok, true);
    assert.equal(health.instanceId, report.backend.state.instanceId);
  } finally {
    await rm(codexStatePath, { recursive: true, force: true });
    await runCli(cliPath, ["stop", "--json", ...commonArgs, "--clients", "none"]);
    for (const pid of observedPids) {
      if (!Number.isSafeInteger(pid) || !isProcessAlive(pid)) continue;
      terminateProcessTree(pid);
      await waitForProcessExit(pid);
    }
    await rm(home, { recursive: true, force: true });
    await rm(codexHome, { recursive: true, force: true });
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
    const viewer = await fetch(`http://127.0.0.1:${port}/memory-viewer/api/summary?client=claude-code`)
      .then((response) => response.json());
    assert.equal(viewer.summary.turnCount, 0);
    assert.equal(viewer.activities.length, 0);
    assert.doesNotMatch(JSON.stringify(viewer), /private lifecycle Claude prompt|lifecycle-session|lifecycle-turn/);

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

test("memorax-code start leaves Codex config unchanged before the plugin is installed", async () => {
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
  } finally {
    await runCli(cliPath, ["stop", "--json", "--home", home, "--port", String(port), "--codex-home", codexHome, "--clients", "none"]);
    await rm(home, { recursive: true, force: true });
    await rm(codexHome, { recursive: true, force: true });
  }
});

test("memorax-code start --yes registers a missing Codex plugin but requires activation", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-lifecycle-prompt-plugin-home-"));
  const codexHome = await mkdtemp(join(tmpdir(), "memorax-code-lifecycle-prompt-plugin-codex-"));
  const port = await freePort();
  const cliPath = fileURLToPath(new URL("../../dist/memorax-code.js", import.meta.url));
  await writeFile(join(codexHome, "config.toml"), [
    'model_provider = "custom"',
    "",
    "[model_providers.custom]",
    'base_url = "http://127.0.0.1:9999/v1"',
    'wire_api = "responses"',
    "",
  ].join("\n"));
  try {
    const started = await runCli(cliPath, [
      "start",
      "--yes",
      "--home", home,
      "--port", String(port),
      "--codex-home", codexHome,
      "--marketplace-path", join(home, ".agents", "plugins", "marketplace.json"),
      "--clients", "codex",
    ]);
    assert.equal(started.code, 0, `${started.stdout}\n${started.stderr}`);
    assert.match(started.stdout, /Codex plugin source registered/);
    assert.match(started.stdout, /Activate the MemoraX Code Codex Adapter plugin/);
    assert.match(started.stdout, /^\[MemoraX Code Backend\]: Codex adapter: skipped codex_plugin_activation_required/m);
    assert.match(started.stdout, /one or more adapters are not enabled/);
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

test("memorax-code start seeds the default memory config", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-lifecycle-default-memory-home-"));
  const codexHome = await mkdtemp(join(tmpdir(), "memorax-code-lifecycle-default-memory-codex-"));
  const port = await freePort();
  const cliPath = fileURLToPath(new URL("../../dist/memorax-code.js", import.meta.url));
  await writeFile(join(codexHome, "config.toml"), [
    'model_provider = "custom"',
    "",
    "[model_providers.custom]",
    'name = "Custom"',
    'base_url = "http://127.0.0.1:9999/openai"',
    'wire_api = "responses"',
    "",
  ].join("\n"));
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
    assert.equal(await readFile(join(home, "config.toml"), "utf8"), renderDefaultMemoraxCodeConfig());
  } finally {
    await runCli(cliPath, ["stop", "--json", "--home", home, "--port", String(port), "--codex-home", codexHome, "--clients", "codex"]);
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
