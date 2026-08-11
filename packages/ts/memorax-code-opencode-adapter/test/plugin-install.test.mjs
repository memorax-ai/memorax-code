import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { defaultOpenCodeConfigDir } from "../src/adapter-paths.mjs";
import {
  defaultOpenCodeCliBinDir,
  disableOpenCodePlugin,
  ensureOpenCodePluginInstalled,
  readOpenCodePluginStatus,
  removeOpenCodePluginInstallation,
} from "../src/plugin-install.mjs";

test("OpenCode config discovery honors its explicit and XDG homes", () => {
  assert.equal(
    defaultOpenCodeConfigDir({ OPENCODE_CONFIG_DIR: "/custom/opencode", XDG_CONFIG_HOME: "/ignored" }, "/home/user"),
    "/custom/opencode",
  );
  assert.equal(
    defaultOpenCodeConfigDir({ XDG_CONFIG_HOME: "/xdg/config" }, "/home/user"),
    "/xdg/config/opencode",
  );
  assert.equal(defaultOpenCodeConfigDir({}, "/home/user"), "/home/user/.config/opencode");
});

test("OpenCode CLI path discovery recognizes the staged npm package layout", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-opencode-staged-layout-"));
  try {
    const packageRoot = join(root, "prefix", "lib", "node_modules", "@memorax", "memorax-code");
    const adapterRoot = join(packageRoot, "lib", "memorax-code-opencode-adapter");
    const commandBin = join(root, "prefix", "bin");
    await mkdir(adapterRoot, { recursive: true });
    await mkdir(commandBin, { recursive: true });
    await writeFile(join(commandBin, "memorax-cli"), "#!/bin/sh\n");
    assert.equal(defaultOpenCodeCliBinDir(adapterRoot), commandBin);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenCode plugin install materializes a managed loader, canonical skill, and state", async () => {
  const fixture = await createFixture("install");
  try {
    const installed = ensureOpenCodePluginInstalled(fixture.options);
    assert.equal(installed.ok, true);
    assert.equal(installed.changed, true);
    assert.equal(installed.restartRequired, true);
    const loader = await readFile(installed.pluginPath, "utf8");
    assert.match(loader, /^\/\/ Managed by MemoraX Code/);
    assert.match(loader, new RegExp(escapeRegex(JSON.stringify(pathToFileURL(fixture.pluginSourcePath).href))));
    assert.match(loader, new RegExp(escapeRegex(`"memoraxCodeHome":${JSON.stringify(fixture.options.memoraxCodeHome)}`)));
    assert.match(loader, /"cliBinDir":"\/managed\/bin"/);
    assert.equal(await readFile(join(installed.skillPath, "SKILL.md"), "utf8"), "# MemoraX Code\n");
    assert.equal(await readFile(join(installed.skillPath, "references", "search.md"), "utf8"), "search\n");
    const state = JSON.parse(await readFile(installed.statePath, "utf8"));
    assert.equal(state.runtime, "opencode");
    assert.equal(state.openCodeConfigDir, fixture.openCodeConfigDir);

    const status = readOpenCodePluginStatus(fixture.options);
    assert.equal(status.ok, true);
    assert.equal(status.installed, true);
    assert.equal(status.current, true);

    const unchanged = ensureOpenCodePluginInstalled(fixture.options);
    assert.equal(unchanged.ok, true);
    assert.equal(unchanged.changed, false);
    assert.equal(unchanged.restartRequired, false);

    await writeFile(fixture.pluginSourcePath, "export function createMemoraxOpenCodePlugin() { return 'updated'; }\n");
    assert.equal(readOpenCodePluginStatus(fixture.options).pluginCurrent, false);
    const updated = ensureOpenCodePluginInstalled(fixture.options);
    assert.equal(updated.changed, true);
    assert.equal(updated.restartRequired, true);
    assert.match(await readFile(updated.pluginPath, "utf8"), /Plugin source SHA-256: [a-f0-9]{64}/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("OpenCode plugin install refuses to overwrite an unmanaged discovery file", async () => {
  const fixture = await createFixture("conflict");
  const pluginPath = join(fixture.openCodeConfigDir, "plugins", "memorax-code.js");
  try {
    await mkdir(join(fixture.openCodeConfigDir, "plugins"), { recursive: true });
    await writeFile(pluginPath, "export const UserPlugin = async () => ({});\n");

    const result = ensureOpenCodePluginInstalled(fixture.options);

    assert.equal(result.ok, false);
    assert.equal(result.reason, "plugin_conflict");
    assert.equal(await readFile(pluginPath, "utf8"), "export const UserPlugin = async () => ({});\n");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("OpenCode plugin removal deletes only the recorded managed artifacts", async () => {
  const fixture = await createFixture("remove");
  try {
    const installed = ensureOpenCodePluginInstalled(fixture.options);
    assert.equal(installed.ok, true);
    const unrelatedConfig = join(fixture.openCodeConfigDir, "opencode.jsonc");
    await writeFile(unrelatedConfig, "{ // user config\n}\n");

    const disabled = disableOpenCodePlugin(fixture.options);
    assert.equal(disabled.ok, true);
    assert.equal(disabled.enabled, false);
    const disabledStatus = readOpenCodePluginStatus(fixture.options);
    assert.equal(disabledStatus.ok, true);
    assert.equal(disabledStatus.reason, "not_enabled");
    assert.match(await readFile(installed.pluginPath, "utf8"), /^\/\/ Managed by MemoraX Code/);

    const removed = removeOpenCodePluginInstallation(fixture.options);

    assert.equal(removed.ok, true);
    assert.equal(await readFile(unrelatedConfig, "utf8"), "{ // user config\n}\n");
    await assert.rejects(readFile(installed.pluginPath), /ENOENT/);
    await assert.rejects(readFile(join(installed.skillPath, "SKILL.md")), /ENOENT/);
    await assert.rejects(readFile(installed.statePath), /ENOENT/);
    assert.equal(readOpenCodePluginStatus(fixture.options).managed, false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("OpenCode plugin removal fails closed for a state with unsafe managed paths", async () => {
  const fixture = await createFixture("unsafe-state");
  const sentinel = join(fixture.root, "do-not-delete");
  const statePath = join(fixture.options.memoraxCodeHome, "adapters", "opencode", "state.json");
  try {
    await mkdir(sentinel, { recursive: true });
    await writeFile(join(sentinel, "sentinel.txt"), "preserve\n");
    await mkdir(join(fixture.options.memoraxCodeHome, "adapters", "opencode"), { recursive: true });
    await writeFile(statePath, JSON.stringify({
      version: 1,
      runtime: "opencode",
      integration: "plugin",
      enabled: true,
      openCodeConfigDir: fixture.openCodeConfigDir,
      pluginPath: join(fixture.openCodeConfigDir, "plugins", "memorax-code.js"),
      skillPath: sentinel,
    }));

    const removed = removeOpenCodePluginInstallation(fixture.options);

    assert.equal(removed.ok, false);
    assert.equal(removed.reason, "state_paths_invalid");
    assert.equal(await readFile(join(sentinel, "sentinel.txt"), "utf8"), "preserve\n");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

async function createFixture(name) {
  const root = await mkdtemp(join(tmpdir(), `memorax-code-opencode-${name}-`));
  const openCodeConfigDir = join(root, "OpenCode Config With Spaces");
  const memoraxCodeHome = join(root, "memorax-code");
  const pluginSourcePath = join(root, "Adapter With Spaces", "plugin.mjs");
  const skillSourcePath = join(root, "canonical-skill");
  await mkdir(join(skillSourcePath, "references"), { recursive: true });
  await mkdir(join(root, "Adapter With Spaces"), { recursive: true });
  await writeFile(pluginSourcePath, "export function createMemoraxOpenCodePlugin() {}\n");
  await writeFile(join(skillSourcePath, "SKILL.md"), "# MemoraX Code\n");
  await writeFile(join(skillSourcePath, "references", "search.md"), "search\n");
  return {
    root,
    openCodeConfigDir,
    pluginSourcePath,
    options: {
      openCodeConfigDir,
      memoraxCodeHome,
      pluginSourcePath,
      skillSourcePath,
      cliBinDir: "/managed/bin",
    },
  };
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
