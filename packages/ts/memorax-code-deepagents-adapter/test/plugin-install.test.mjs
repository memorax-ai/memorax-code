import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ensureDeepAgentsPluginInstalled,
  readDeepAgentsPluginStatus,
  removeDeepAgentsPluginInstallation,
} from "../src/plugin-install.mjs";
import { buildDeepAgentsMarketplace } from "../scripts/build-marketplace.mjs";

const adapterRoot = fileURLToPath(new URL("..", import.meta.url));

test("Deep Agents plugin lifecycle uses dcode with DEEPAGENTS_HOME", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-deepagents-plugin-"));
  const deepAgentsHome = join(root, "Deep Agents Home");
  const memoraxCodeHome = join(root, "memorax-code");
  const marketplace = await buildDeepAgentsMarketplace({
    outputDir: join(root, "Marketplace With Spaces"),
    adapterRoot,
  });
  const marketplacePath = marketplace.marketplaceRoot;
  const pluginInstallPath = marketplace.pluginRoot;
  const dcode = join(root, "fake-dcode.mjs");
  const statePath = join(root, "dcode-state.json");
  const callsPath = join(root, "calls.jsonl");
  try {
    await writeFakeDcode(dcode, statePath, callsPath, pluginInstallPath);

    const installed = ensureDeepAgentsPluginInstalled({
      deepAgentsHome,
      memoraxCodeHome,
      marketplacePath,
      deepAgentsCommand: dcode,
    });
    assert.equal(installed.ok, true, installed.message);
    assert.equal(installed.restartRequired, true);
    assert.equal(installed.pluginVersion, "0.1.22");
    assert.equal(installed.installPath, pluginInstallPath);
    assert.equal(readDeepAgentsPluginStatus({
      deepAgentsHome,
      memoraxCodeHome,
      deepAgentsCommand: dcode,
    }).ok, true);

    const again = ensureDeepAgentsPluginInstalled({
      deepAgentsHome,
      memoraxCodeHome,
      marketplacePath,
      deepAgentsCommand: dcode,
    });
    assert.equal(again.ok, true, again.message);
    assert.equal(again.restartRequired, false);
    assert.equal(again.updated, false);

    const removed = removeDeepAgentsPluginInstallation({
      deepAgentsHome,
      memoraxCodeHome,
      deepAgentsCommand: dcode,
    });
    assert.equal(removed.ok, true);

    const calls = (await readFile(callsPath, "utf8")).trim().split("\n").map(JSON.parse);
    assert.deepEqual(calls.map((call) => call.args), [
      ["plugin", "list", "--json"],
      ["plugin", "marketplace", "list", "--json"],
      ["plugin", "marketplace", "add", marketplacePath],
      ["plugin", "install", "memorax-code-deepagents-adapter@memorax-code-deepagents-local"],
      ["plugin", "list", "--json"],
      ["plugin", "list", "--json"],
      ["plugin", "list", "--json"],
      ["plugin", "marketplace", "list", "--json"],
      ["plugin", "uninstall", "memorax-code-deepagents-adapter@memorax-code-deepagents-local"],
      ["plugin", "marketplace", "remove", "memorax-code-deepagents-local"],
    ]);
    assert.equal(calls.every((call) => call.deepAgentsHome === deepAgentsHome), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function writeFakeDcode(command, statePath, callsPath, installPath) {
  await writeFile(command, [
    "#!/usr/bin/env node",
    'import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";',
    'import { dirname, join } from "node:path";',
    `const statePath = ${JSON.stringify(statePath)};`,
    `const callsPath = ${JSON.stringify(callsPath)};`,
    `const installPath = ${JSON.stringify(installPath)};`,
    "const home = process.env.DEEPAGENTS_HOME;",
    "const installedPluginsPath = join(home, '.state', 'installed_plugins.json');",
    "const args = process.argv.slice(2);",
    "appendFileSync(callsPath, JSON.stringify({ args, deepAgentsHome: home }) + '\\n');",
    "const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { plugins: [], marketplaces: [] };",
    "const write = (command, data) => process.stdout.write(JSON.stringify({ schema_version: 1, command, data }) + '\\n');",
    "if (args[0] === 'plugin' && args[1] === 'list') {",
    "  write('plugin list', state.plugins); process.exit(0);",
    "}",
    "if (args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'list') {",
    "  write('plugin marketplace list', state.marketplaces); process.exit(0);",
    "}",
    "if (args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'add') {",
    "  state.marketplaces = [{ name: 'memorax-code-deepagents-local', source_type: 'directory', source: args[3], install_location: args[3] }];",
    "} else if (args[0] === 'plugin' && args[1] === 'install') {",
    "  state.plugins = [{ id: args[2], description: 'MemoraX Code memory', enabled: true, needs_repair: false }];",
    "  mkdirSync(dirname(installedPluginsPath), { recursive: true });",
    "  writeFileSync(installedPluginsPath, JSON.stringify({ version: 2, plugins: { [args[2]]: [{ installPath, version: '0.1.22' }] } }));",
    "} else if (args[0] === 'plugin' && args[1] === 'enable') {",
    "  for (const plugin of state.plugins) plugin.enabled = true;",
    "} else if (args[0] === 'plugin' && args[1] === 'uninstall') {",
    "  state.plugins = [];",
    "  writeFileSync(installedPluginsPath, JSON.stringify({ version: 2, plugins: {} }));",
    "} else if (args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'remove') {",
    "  state.marketplaces = [];",
    "}",
    "writeFileSync(statePath, JSON.stringify(state));",
    "process.exit(0);",
    "",
  ].join("\n"));
  await chmod(command, 0o755);
}
