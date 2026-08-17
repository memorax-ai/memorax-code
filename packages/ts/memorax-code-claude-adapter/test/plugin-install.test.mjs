import { strict as assert } from "node:assert";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ensureClaudePluginInstalled, readClaudePluginStatus, removeClaudePluginInstallation } from "../src/plugin-install.mjs";
import { buildClaudeMarketplace } from "../scripts/build-marketplace.mjs";

const pluginSourceRoot = fileURLToPath(new URL("..", import.meta.url));

test("Claude plugin lifecycle uses the official CLI with the selected config home", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-claude-plugin-install-"));
  const claudeHome = join(root, "Claude Home With Spaces");
  const memoraxCodeHome = join(root, "memorax-code");
  const marketplacePath = join(root, "Marketplace With Spaces");
  const claudeCommand = join(root, "fake-claude.mjs");
  const callsPath = join(root, "calls.jsonl");
  try {
    await mkdir(join(marketplacePath, ".claude-plugin"), { recursive: true });
    await writeFile(join(marketplacePath, ".claude-plugin", "marketplace.json"), "{}\n");
    await writeFakeClaude(claudeCommand);

    const installed = ensureClaudePluginInstalled({ claudeHome, memoraxCodeHome, marketplacePath, claudeCommand });
    assert.equal(installed.ok, true);
    assert.equal(installed.restartRequired, true);
    assert.equal(installed.updated, false);
    assert.match(installed.installPath, /memorax-code-claude-adapter/);
    const metadata = JSON.parse(await readFile(join(installed.installPath, ".memorax-code-package.json"), "utf8"));
    assert.equal(metadata.version, 1);
    assert.equal(metadata.memoraxCodeCommand, process.argv[1]);
    assert.equal(metadata.claudeCommand, claudeCommand);
    await writeFile(join(claudeHome, "settings.json"), `${JSON.stringify({
      extraKnownMarketplaces: { "memorax-code-local": { source: { source: "directory", path: marketplacePath } } },
      enabledPlugins: { "memorax-code-claude-adapter@memorax-code-local": true },
    }, null, 2)}\n`);
    const removed = removeClaudePluginInstallation({ claudeHome, memoraxCodeHome, claudeCommand });
    assert.equal(removed.ok, true);

    const calls = (await readFile(callsPath, "utf8")).trim().split("\n").map(JSON.parse);
    assert.deepEqual(calls, [
      { args: ["plugin", "list", "--json"], claudeConfigDir: claudeHome },
      { args: ["plugin", "marketplace", "list", "--json"], claudeConfigDir: claudeHome },
      { args: ["plugin", "marketplace", "add", marketplacePath], claudeConfigDir: claudeHome },
      { args: ["plugin", "install", "memorax-code-claude-adapter@memorax-code-local", "--scope", "user"], claudeConfigDir: claudeHome },
      { args: ["plugin", "list", "--json"], claudeConfigDir: claudeHome },
      { args: ["plugin", "uninstall", "memorax-code-claude-adapter@memorax-code-local", "--scope", "user", "--yes", "--keep-data"], claudeConfigDir: claudeHome },
      { args: ["plugin", "marketplace", "remove", "memorax-code-local"], claudeConfigDir: claudeHome },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude plugin lifecycle resolves a Windows cmd shim without a shell", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-claude-plugin-windows-shim-"));
  const claudeHome = join(root, "Claude Home With Spaces");
  const memoraxCodeHome = join(root, "memorax-code");
  const marketplacePath = join(root, "Marketplace With Spaces");
  const cli = join(root, "claude-cli.mjs");
  const callsPath = join(root, "calls.jsonl");
  const previousCli = process.env.MEMORAX_CODE_CLAUDE_CLI_JS;
  const windowsCliResolution = {
    platform: "win32",
    resolvedCommand: "C:\\npm prefix\\claude.cmd",
    nodePath: process.execPath,
    existsSync: (candidate) => candidate === cli,
  };
  try {
    process.env.MEMORAX_CODE_CLAUDE_CLI_JS = cli;
    await mkdir(join(marketplacePath, ".claude-plugin"), { recursive: true });
    await writeFile(join(marketplacePath, ".claude-plugin", "marketplace.json"), "{}\n");
    await writeFakeClaude(cli);

    const installed = ensureClaudePluginInstalled({
      claudeHome,
      memoraxCodeHome,
      marketplacePath,
      claudeCommand: "claude",
      windowsCliResolution,
    });
    assert.equal(installed.ok, true);
    await writeFile(join(claudeHome, "settings.json"), `${JSON.stringify({
      extraKnownMarketplaces: {
        "memorax-code-local": { source: { source: "directory", path: marketplacePath } },
      },
      enabledPlugins: { "memorax-code-claude-adapter@memorax-code-local": true },
    }, null, 2)}\n`);
    assert.equal(readClaudePluginStatus({
      claudeHome,
      memoraxCodeHome,
      claudeCommand: "claude",
      windowsCliResolution,
    }).ok, true);
    assert.equal(removeClaudePluginInstallation({
      claudeHome,
      memoraxCodeHome,
      claudeCommand: "claude",
      windowsCliResolution,
    }).ok, true);

    const calls = (await readFile(callsPath, "utf8")).trim().split("\n").map(JSON.parse);
    assert.deepEqual(calls.map((call) => call.args), [
      ["plugin", "list", "--json"],
      ["plugin", "marketplace", "list", "--json"],
      ["plugin", "marketplace", "add", marketplacePath],
      ["plugin", "install", "memorax-code-claude-adapter@memorax-code-local", "--scope", "user"],
      ["plugin", "list", "--json"],
      ["plugin", "list", "--json"],
      [
        "plugin",
        "uninstall",
        "memorax-code-claude-adapter@memorax-code-local",
        "--scope",
        "user",
        "--yes",
        "--keep-data",
      ],
      ["plugin", "marketplace", "remove", "memorax-code-local"],
    ]);
  } finally {
    if (previousCli === undefined) delete process.env.MEMORAX_CODE_CLAUDE_CLI_JS;
    else process.env.MEMORAX_CODE_CLAUDE_CLI_JS = previousCli;
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude plugin install reports missing marketplace before invoking the CLI", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-claude-plugin-missing-marketplace-"));
  try {
    const result = ensureClaudePluginInstalled({
      claudeHome: join(root, "claude"),
      memoraxCodeHome: join(root, "memorax-code"),
      marketplacePath: join(root, "missing"),
      claudeCommand: join(root, "missing-claude"),
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "marketplace_missing");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude plugin install reports a falsy marketplace path without throwing", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-claude-plugin-falsy-marketplace-"));
  try {
    const result = ensureClaudePluginInstalled({
      claudeHome: join(root, "claude"),
      memoraxCodeHome: join(root, "memorax-code"),
      marketplacePath: false,
      claudeCommand: join(root, "missing-claude"),
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "marketplace_missing");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude plugin install identifies an unavailable CLI", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-claude-plugin-missing-cli-"));
  const marketplacePath = join(root, "marketplace");
  try {
    await mkdir(join(marketplacePath, ".claude-plugin"), { recursive: true });
    await writeFile(join(marketplacePath, ".claude-plugin", "marketplace.json"), "{}\n");
    const result = ensureClaudePluginInstalled({
      claudeHome: join(root, "claude"),
      memoraxCodeHome: join(root, "memorax-code"),
      marketplacePath,
      claudeCommand: join(root, "missing-claude"),
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "claude_cli_unavailable");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude plugin install preserves an existing marketplace path", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-claude-plugin-existing-marketplace-"));
  const claudeHome = join(root, "claude");
  const marketplacePath = join(root, "custom-marketplace");
  const claudeCommand = join(root, "fake-claude.mjs");
  try {
    await mkdir(join(marketplacePath, ".claude-plugin"), { recursive: true });
    await mkdir(claudeHome, { recursive: true });
    await writeFile(join(marketplacePath, ".claude-plugin", "marketplace.json"), "{}\n");
    await writeFile(join(claudeHome, "settings.json"), `${JSON.stringify({
      extraKnownMarketplaces: {
        "memorax-code-local": { source: { source: "directory", path: marketplacePath } },
      },
    }, null, 2)}\n`);
    await writeFakeClaude(claudeCommand);

    const result = ensureClaudePluginInstalled({ claudeHome, memoraxCodeHome: join(root, "unused-memorax-code"), claudeCommand });
    assert.equal(result.ok, true);
    assert.equal(result.marketplacePath, marketplacePath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude plugin install replaces a stale official CLI marketplace registration", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-claude-plugin-stale-marketplace-"));
  const claudeHome = join(root, "claude");
  const memoraxCodeHome = join(root, "memorax-code");
  const marketplacePath = join(memoraxCodeHome, "lib", "memorax-code-claude-marketplace");
  const staleMarketplacePath = join(root, "deleted-marketplace");
  const claudeCommand = join(root, "fake-claude.mjs");
  const callsPath = join(root, "calls.jsonl");
  try {
    await mkdir(join(marketplacePath, ".claude-plugin"), { recursive: true });
    await mkdir(claudeHome, { recursive: true });
    await writeFile(join(marketplacePath, ".claude-plugin", "marketplace.json"), "{}\n");
    await writeFakeClaude(claudeCommand);
    await writeFile(join(claudeHome, ".fake-plugin-state.json"), JSON.stringify({
      plugins: [{
        id: "memorax-code-claude-adapter@memorax-code-local",
        version: "0.1.0+stale",
        enabled: false,
        installPath: join(claudeHome, "plugins", "cache", "memorax-code-local", "memorax-code-claude-adapter", "stale"),
      }],
      marketplaces: [{
        name: "memorax-code-local",
        source: "directory",
        path: staleMarketplacePath,
        installLocation: staleMarketplacePath,
      }],
    }));

    const result = ensureClaudePluginInstalled({ claudeHome, memoraxCodeHome, claudeCommand });
    assert.equal(result.ok, true);
    assert.equal(result.marketplacePath, marketplacePath);
    assert.equal(result.marketplaceReplaced, true);
    const calls = (await readFile(callsPath, "utf8")).trim().split("\n").map(JSON.parse);
    assert.deepEqual(calls.map((call) => call.args), [
      ["plugin", "list", "--json"],
      ["plugin", "marketplace", "list", "--json"],
      ["plugin", "uninstall", "memorax-code-claude-adapter@memorax-code-local", "--scope", "user", "--yes", "--keep-data"],
      ["plugin", "marketplace", "remove", "memorax-code-local"],
      ["plugin", "marketplace", "add", marketplacePath],
      ["plugin", "install", "memorax-code-claude-adapter@memorax-code-local", "--scope", "user"],
      ["plugin", "list", "--json"],
    ]);
    const state = JSON.parse(await readFile(join(claudeHome, ".fake-plugin-state.json"), "utf8"));
    assert.equal(state.marketplaces[0].path, marketplacePath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude plugin install surfaces CLI failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-claude-plugin-install-failure-"));
  const marketplacePath = join(root, "marketplace");
  const claudeCommand = join(root, "fake-claude.mjs");
  try {
    await mkdir(join(marketplacePath, ".claude-plugin"), { recursive: true });
    await writeFile(join(marketplacePath, ".claude-plugin", "marketplace.json"), "{}\n");
    await writeFile(claudeCommand, [
      "#!/usr/bin/env node",
      "if (process.argv.slice(2).join(' ') === 'plugin list --json') { console.log('[]'); process.exit(0); }",
      "if (process.argv.slice(2).join(' ') === 'plugin marketplace list --json') { console.log('[]'); process.exit(0); }",
      "console.error('intentional plugin install failure');",
      "process.exit(7);",
      "",
    ].join("\n"));
    await chmod(claudeCommand, 0o755);

    const result = ensureClaudePluginInstalled({ claudeHome: join(root, "claude"), marketplacePath, claudeCommand });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "marketplace_add_failed");
    assert.match(result.message, /intentional plugin install failure/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude plugin install preserves a matching shell and requires refresh only when re-enabling", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-claude-plugin-update-"));
  const claudeHome = join(root, "claude");
  const memoraxCodeHome = join(root, "memorax-code");
  const marketplacePath = join(root, "marketplace");
  const claudeCommand = join(root, "fake-claude.mjs");
  const callsPath = join(root, "calls.jsonl");
  try {
    await mkdir(join(marketplacePath, ".claude-plugin"), { recursive: true });
    await writeFile(join(marketplacePath, ".claude-plugin", "marketplace.json"), "{}\n");
    await writeFakeClaude(claudeCommand);
    assert.equal(ensureClaudePluginInstalled({ claudeHome, memoraxCodeHome, marketplacePath, claudeCommand }).ok, true);

    const statePath = join(claudeHome, ".fake-plugin-state.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    await rm(join(state.plugins[0].installPath, "src", "plugin-artifact-contract.mjs"));

    const unchanged = ensureClaudePluginInstalled({
      claudeHome,
      memoraxCodeHome,
      marketplacePath,
      claudeCommand,
    });
    assert.equal(unchanged.ok, true);
    assert.equal(unchanged.updated, false);
    assert.equal(unchanged.shellUnchanged, true);
    assert.equal(unchanged.restartRequired, false);
    assert.match(unchanged.message, /select runtime generations per turn/);

    state.plugins[0].enabled = false;
    await writeFile(statePath, JSON.stringify(state));

    const reenabled = ensureClaudePluginInstalled({ claudeHome, memoraxCodeHome, marketplacePath, claudeCommand });
    assert.equal(reenabled.ok, true);
    assert.equal(reenabled.updated, false);
    assert.equal(reenabled.enabled, true);
    assert.equal(reenabled.shellUnchanged, true);
    assert.equal(reenabled.restartRequired, true);
    assert.match(reenabled.message, /Restart or refresh Claude Code/);
    assert.equal(reenabled.pluginVersion, JSON.parse(await readFile(join(pluginSourceRoot, ".claude-plugin", "plugin.json"), "utf8")).version);

    const calls = (await readFile(callsPath, "utf8")).trim().split("\n").map(JSON.parse);
    assert.deepEqual(calls.slice(-4).map((call) => call.args), [
      ["plugin", "list", "--json"],
      ["plugin", "marketplace", "list", "--json"],
      ["plugin", "enable", "memorax-code-claude-adapter@memorax-code-local", "--scope", "user"],
      ["plugin", "list", "--json"],
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude plugin install refreshes a changed shell and requires a reload", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-claude-plugin-shell-update-"));
  const claudeHome = join(root, "claude");
  const memoraxCodeHome = join(root, "memorax-code");
  const marketplacePath = join(root, "marketplace");
  const claudeCommand = join(root, "fake-claude.mjs");
  const callsPath = join(root, "calls.jsonl");
  try {
    await mkdir(join(marketplacePath, ".claude-plugin"), { recursive: true });
    await writeFile(join(marketplacePath, ".claude-plugin", "marketplace.json"), "{}\n");
    await writeFakeClaude(claudeCommand);
    assert.equal(ensureClaudePluginInstalled({
      claudeHome,
      memoraxCodeHome,
      marketplacePath,
      claudeCommand,
    }).ok, true);

    const state = JSON.parse(await readFile(join(claudeHome, ".fake-plugin-state.json"), "utf8"));
    const shellPath = join(state.plugins[0].installPath, "hooks", "runtime-shell.json");
    const shell = JSON.parse(await readFile(shellPath, "utf8"));
    shell.shellVersion = "0.0.9";
    await writeFile(shellPath, `${JSON.stringify(shell, null, 2)}\n`);

    const updated = ensureClaudePluginInstalled({
      claudeHome,
      memoraxCodeHome,
      marketplacePath,
      claudeCommand,
    });
    assert.equal(updated.ok, true);
    assert.equal(updated.updated, true);
    assert.equal(updated.enabled, true);
    assert.equal(updated.restartRequired, true);
    assert.equal(updated.shellUnchanged, undefined);
    assert.match(updated.message, /Restart or refresh Claude Code/);

    const calls = (await readFile(callsPath, "utf8")).trim().split("\n").map(JSON.parse);
    assert.deepEqual(calls.slice(-5).map((call) => call.args), [
      ["plugin", "list", "--json"],
      ["plugin", "marketplace", "list", "--json"],
      ["plugin", "marketplace", "update", "memorax-code-local"],
      ["plugin", "update", "memorax-code-claude-adapter@memorax-code-local", "--scope", "user"],
      ["plugin", "list", "--json"],
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude plugin install refreshes an incomplete matching shell", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-claude-plugin-incomplete-shell-"));
  const claudeHome = join(root, "claude");
  const memoraxCodeHome = join(root, "memorax-code");
  const marketplacePath = join(root, "marketplace");
  const claudeCommand = join(root, "fake-claude.mjs");
  const callsPath = join(root, "calls.jsonl");
  try {
    await mkdir(join(marketplacePath, ".claude-plugin"), { recursive: true });
    await writeFile(join(marketplacePath, ".claude-plugin", "marketplace.json"), "{}\n");
    await writeFakeClaude(claudeCommand);
    assert.equal(ensureClaudePluginInstalled({
      claudeHome,
      memoraxCodeHome,
      marketplacePath,
      claudeCommand,
    }).ok, true);

    const state = JSON.parse(await readFile(join(claudeHome, ".fake-plugin-state.json"), "utf8"));
    await rm(join(
      state.plugins[0].installPath,
      "memorax-code-adapter-common",
      "src",
      "hooks",
      "memory-skill-reminder-policy.mjs",
    ));

    const updated = ensureClaudePluginInstalled({
      claudeHome,
      memoraxCodeHome,
      marketplacePath,
      claudeCommand,
    });
    assert.equal(updated.ok, true);
    assert.equal(updated.updated, true);
    assert.equal(updated.restartRequired, true);
    assert.equal(updated.shellUnchanged, undefined);

    const calls = (await readFile(callsPath, "utf8")).trim().split("\n").map(JSON.parse);
    assert.deepEqual(calls.slice(-5).map((call) => call.args), [
      ["plugin", "list", "--json"],
      ["plugin", "marketplace", "list", "--json"],
      ["plugin", "marketplace", "update", "memorax-code-local"],
      ["plugin", "update", "memorax-code-claude-adapter@memorax-code-local", "--scope", "user"],
      ["plugin", "list", "--json"],
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude plugin install rejects an incomplete installed artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-claude-plugin-incomplete-"));
  const claudeHome = join(root, "claude");
  const marketplacePath = join(root, "marketplace");
  const installedMarketplace = join(root, "installed-marketplace");
  const claudeCommand = join(root, "fake-claude.mjs");
  try {
    await mkdir(join(marketplacePath, ".claude-plugin"), { recursive: true });
    await writeFile(join(marketplacePath, ".claude-plugin", "marketplace.json"), "{}\n");
    const built = await buildClaudeMarketplace({ outputDir: installedMarketplace });
    await rm(join(built.pluginRoot, "hooks", "runtime-hook.mjs"));
    await rm(join(built.pluginRoot, "skills", "memorax-code"), { recursive: true, force: true });
    const pluginVersion = JSON.parse(
      await readFile(join(pluginSourceRoot, ".claude-plugin", "plugin.json"), "utf8"),
    ).version;
    await writeFakeClaude(claudeCommand, [{
      id: "memorax-code-claude-adapter@memorax-code-local",
      version: pluginVersion,
      enabled: true,
      installPath: built.pluginRoot,
    }]);

    const result = ensureClaudePluginInstalled({
      claudeHome,
      memoraxCodeHome: join(root, "memorax-code"),
      marketplacePath,
      claudeCommand,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "plugin_artifacts_invalid");
    assert.match(result.message, /hooks\/runtime-hook\.mjs/);
    assert.match(result.message, /skills\/memorax-code\/SKILL\.md/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude plugin removal is idempotent when plugin and marketplace are absent", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-claude-plugin-remove-missing-"));
  const claudeCommand = join(root, "fake-claude.mjs");
  try {
    await writeFile(claudeCommand, [
      "#!/usr/bin/env node",
      "console.error('requested plugin or marketplace not found');",
      "process.exit(1);",
      "",
    ].join("\n"));
    await chmod(claudeCommand, 0o755);

    const result = removeClaudePluginInstallation({ claudeHome: join(root, "claude"), memoraxCodeHome: join(root, "memorax-code"), claudeCommand });
    assert.equal(result.ok, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude plugin removal accepts official CLI not-found results for registered entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-claude-plugin-remove-not-found-"));
  const claudeHome = join(root, "claude");
  const claudeCommand = join(root, "fake-claude.mjs");
  try {
    await mkdir(claudeHome, { recursive: true });
    await writeFile(join(claudeHome, "settings.json"), `${JSON.stringify({
      enabledPlugins: { "memorax-code-claude-adapter@memorax-code-local": true },
    }, null, 2)}\n`);
    await writeFile(claudeCommand, [
      "#!/usr/bin/env node",
      "console.error('requested plugin or marketplace not found');",
      "process.exit(1);",
      "",
    ].join("\n"));
    await chmod(claudeCommand, 0o755);

    const result = removeClaudePluginInstallation({ claudeHome, memoraxCodeHome: join(root, "memorax-code"), claudeCommand });
    assert.equal(result.ok, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude plugin removal clears an orphaned marketplace registry", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-claude-plugin-remove-orphaned-marketplace-"));
  const claudeHome = join(root, "claude");
  const memoraxCodeHome = join(root, "memorax-code");
  const marketplacePath = join(root, "marketplace");
  const claudeCommand = join(root, "fake-claude.mjs");
  const callsPath = join(root, "calls.jsonl");
  try {
    await mkdir(join(marketplacePath, ".claude-plugin"), { recursive: true });
    await writeFile(join(marketplacePath, ".claude-plugin", "marketplace.json"), "{}\n");
    await writeFakeClaude(claudeCommand);
    assert.equal(ensureClaudePluginInstalled({ claudeHome, memoraxCodeHome, marketplacePath, claudeCommand }).ok, true);

    await writeFile(callsPath, "");
    await writeFile(claudeCommand, [
      "#!/usr/bin/env node",
      "import { appendFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      "const args = process.argv.slice(2);",
      "appendFileSync(join(process.env.CLAUDE_CONFIG_DIR, '..', 'calls.jsonl'), JSON.stringify(args) + '\\n');",
      "if (args.slice(0, 3).join(' ') === 'plugin marketplace remove' && args.includes('--scope')) {",
      "  console.error(\"Marketplace 'memorax-code-local' is not declared in user settings. Omit --scope to remove it from all scopes.\");",
      "  process.exit(1);",
      "}",
      "",
    ].join("\n"));
    await chmod(claudeCommand, 0o755);

    const result = removeClaudePluginInstallation({ claudeHome, memoraxCodeHome, claudeCommand });
    assert.equal(result.ok, true);
    const calls = (await readFile(callsPath, "utf8")).trim().split("\n").map(JSON.parse);
    assert.deepEqual(calls, [
      ["plugin", "uninstall", "memorax-code-claude-adapter@memorax-code-local", "--scope", "user", "--yes", "--keep-data"],
      ["plugin", "marketplace", "remove", "memorax-code-local"],
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude plugin status detects enabled and missing managed plugins", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-claude-plugin-status-"));
  const claudeHome = join(root, "claude");
  const memoraxCodeHome = join(root, "memorax-code");
  const marketplacePath = join(root, "marketplace");
  const claudeCommand = join(root, "fake-claude.mjs");
  try {
    await mkdir(join(marketplacePath, ".claude-plugin"), { recursive: true });
    await writeFile(join(marketplacePath, ".claude-plugin", "marketplace.json"), "{}\n");
    await writeFakeClaude(claudeCommand);
    assert.equal(ensureClaudePluginInstalled({ claudeHome, memoraxCodeHome, marketplacePath, claudeCommand }).ok, true);

    const enabled = readClaudePluginStatus({ claudeHome, memoraxCodeHome, claudeCommand });
    assert.equal(enabled.ok, true);
    assert.equal(enabled.installed, true);
    assert.equal(enabled.enabled, true);

    await writeFakeClaude(claudeCommand, []);
    const missing = readClaudePluginStatus({ claudeHome, memoraxCodeHome, claudeCommand });
    assert.equal(missing.ok, false);
    assert.equal(missing.reason, "plugin_not_installed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude plugin removal remains retryable after a CLI failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-claude-plugin-remove-retry-"));
  const claudeHome = join(root, "claude");
  const memoraxCodeHome = join(root, "memorax-code");
  const marketplacePath = join(root, "marketplace");
  const claudeCommand = join(root, "fake-claude.mjs");
  try {
    await mkdir(join(marketplacePath, ".claude-plugin"), { recursive: true });
    await writeFile(join(marketplacePath, ".claude-plugin", "marketplace.json"), "{}\n");
    await writeFakeClaude(claudeCommand);
    assert.equal(ensureClaudePluginInstalled({ claudeHome, memoraxCodeHome, marketplacePath, claudeCommand }).ok, true);
    await writeFile(claudeCommand, ["#!/usr/bin/env node", "process.exit(7);", ""].join("\n"));
    await chmod(claudeCommand, 0o755);
    assert.equal(removeClaudePluginInstallation({ claudeHome, memoraxCodeHome, claudeCommand }).ok, false);
    const statusAfterFailure = readClaudePluginStatus({ claudeHome, memoraxCodeHome, claudeCommand });
    assert.equal(statusAfterFailure.managed, true);
    assert.equal(statusAfterFailure.reason, "plugin_status_failed");

    await writeFakeClaude(claudeCommand);
    assert.equal(removeClaudePluginInstallation({ claudeHome, memoraxCodeHome, claudeCommand }).ok, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude plugin state is isolated by Claude home", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-claude-plugin-multi-home-"));
  const memoraxCodeHome = join(root, "memorax-code");
  const marketplacePath = join(root, "marketplace");
  const claudeCommand = join(root, "fake-claude.mjs");
  const claudeHomeA = join(root, "claude-a");
  const claudeHomeB = join(root, "claude-b");
  try {
    await mkdir(join(marketplacePath, ".claude-plugin"), { recursive: true });
    await writeFile(join(marketplacePath, ".claude-plugin", "marketplace.json"), "{}\n");
    await writeFakeClaude(claudeCommand);
    assert.equal(ensureClaudePluginInstalled({ claudeHome: claudeHomeA, memoraxCodeHome, marketplacePath, claudeCommand }).ok, true);
    assert.equal(ensureClaudePluginInstalled({ claudeHome: claudeHomeB, memoraxCodeHome, marketplacePath, claudeCommand }).ok, true);

    assert.equal(removeClaudePluginInstallation({ claudeHome: claudeHomeB, memoraxCodeHome, claudeCommand }).ok, true);
    assert.equal(readClaudePluginStatus({ claudeHome: claudeHomeA, memoraxCodeHome, claudeCommand }).managed, true);
    const statusB = readClaudePluginStatus({ claudeHome: claudeHomeB, memoraxCodeHome, claudeCommand });
    assert.equal(statusB.managed, false);
    assert.equal(statusB.reason, "not_managed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude plugin state uses the real Claude home behind symlinks", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-claude-plugin-symlink-home-"));
  const memoraxCodeHome = join(root, "memorax-code");
  const marketplacePath = join(root, "marketplace");
  const claudeCommand = join(root, "fake-claude.mjs");
  const realClaudeHome = join(root, "claude-real");
  const linkedClaudeHome = join(root, "claude-link");
  try {
    await mkdir(join(marketplacePath, ".claude-plugin"), { recursive: true });
    await mkdir(realClaudeHome, { recursive: true });
    await symlink(realClaudeHome, linkedClaudeHome, "dir");
    await writeFile(join(marketplacePath, ".claude-plugin", "marketplace.json"), "{}\n");
    await writeFakeClaude(claudeCommand);
    assert.equal(ensureClaudePluginInstalled({ claudeHome: linkedClaudeHome, memoraxCodeHome, marketplacePath, claudeCommand }).ok, true);
    assert.equal(readClaudePluginStatus({ claudeHome: realClaudeHome, memoraxCodeHome, claudeCommand }).managed, true);
    assert.equal(removeClaudePluginInstallation({ claudeHome: realClaudeHome, memoraxCodeHome, claudeCommand }).ok, true);
    assert.equal(readClaudePluginStatus({ claudeHome: linkedClaudeHome, memoraxCodeHome, claudeCommand }).managed, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function writeFakeClaude(path, plugins) {
  const pluginVersion = JSON.parse(await readFile(join(pluginSourceRoot, ".claude-plugin", "plugin.json"), "utf8")).version;
  const pluginArtifact = await buildClaudeMarketplace({
    outputDir: join(path, "..", ".fake-claude-marketplace"),
  });
  await writeFile(path, [
    "#!/usr/bin/env node",
    "import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';",
    "import { dirname, join } from 'node:path';",
    "const args = process.argv.slice(2);",
    "const configDir = process.env.CLAUDE_CONFIG_DIR;",
    "mkdirSync(configDir, { recursive: true });",
    "appendFileSync(join(configDir, '..', 'calls.jsonl'), JSON.stringify({ args, claudeConfigDir: configDir }) + '\\n');",
    "const statePath = join(configDir, '.fake-plugin-state.json');",
    "const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { plugins: [], marketplaces: [] };",
    "state.plugins ??= [];",
    "state.marketplaces ??= [];",
    ...(plugins ? [
      `if (args.join(' ') === 'plugin list --json') { console.log(${JSON.stringify(JSON.stringify(plugins))}); process.exit(0); }`,
    ] : [
      "if (args.join(' ') === 'plugin list --json') { console.log(JSON.stringify(state.plugins)); process.exit(0); }",
    ]),
    "if (args.join(' ') === 'plugin marketplace list --json') { console.log(JSON.stringify(state.marketplaces)); process.exit(0); }",
    "if (args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'add') {",
    "  state.marketplaces = [{ name: 'memorax-code-local', source: 'directory', path: args[3], installLocation: args[3] }];",
    "}",
    "if (args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'update') {",
    "  const marketplace = state.marketplaces.find((entry) => entry.name === 'memorax-code-local');",
    "  if (marketplace?.path && !existsSync(marketplace.path)) { console.error(`ENOENT: no such file or directory, open '${marketplace.path}'`); process.exit(1); }",
    "}",
    "if (args[0] === 'plugin' && args[1] === 'marketplace' && (args[2] === 'remove' || args[2] === 'rm')) {",
    "  state.marketplaces = [];",
    "}",
    "if (args[0] === 'plugin' && (args[1] === 'install' || args[1] === 'update')) {",
    `  const version = ${JSON.stringify(pluginVersion)};`,
    "  const installPath = join(configDir, 'plugins', 'cache', 'memorax-code-local', 'memorax-code-claude-adapter', version.replaceAll('+', '-'));",
    "  const enabled = args[1] === 'update' ? state.plugins[0]?.enabled !== false : true;",
    "  rmSync(installPath, { recursive: true, force: true });",
    "  mkdirSync(dirname(installPath), { recursive: true });",
    `  cpSync(${JSON.stringify(pluginArtifact.pluginRoot)}, installPath, { recursive: true });`,
    "  state.plugins = [{ id: 'memorax-code-claude-adapter@memorax-code-local', version, enabled, installPath }];",
    "}",
    "if (args[0] === 'plugin' && args[1] === 'enable') state.plugins = state.plugins.map((plugin) => ({ ...plugin, enabled: true }));",
    "if (args[0] === 'plugin' && (args[1] === 'uninstall' || args[1] === 'remove')) state.plugins = [];",
    "writeFileSync(statePath, JSON.stringify(state));",
    "",
  ].join("\n"));
  await chmod(path, 0o755);
}
