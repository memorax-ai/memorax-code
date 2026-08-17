import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { defaultOpenCodeConfigDir } from "../src/adapter-paths.mjs";
import {
  defaultMemoraxCodeCommand,
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
    const lifecycleCommand = join(packageRoot, "bin", "memorax-code.mjs");
    await mkdir(adapterRoot, { recursive: true });
    await mkdir(commandBin, { recursive: true });
    await mkdir(join(packageRoot, "bin"), { recursive: true });
    await writeFile(join(commandBin, "memorax-cli"), "#!/bin/sh\n");
    await writeFile(lifecycleCommand, "#!/usr/bin/env node\n");
    assert.equal(defaultOpenCodeCliBinDir(adapterRoot), commandBin);
    assert.equal(defaultMemoraxCodeCommand(adapterRoot), lifecycleCommand);
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
    assert.match(loader, new RegExp(escapeRegex(`"openCodeConfigDir":${JSON.stringify(fixture.openCodeConfigDir)}`)));
    assert.match(loader, new RegExp(escapeRegex(`"memoraxCodeCommand":${JSON.stringify(fixture.memoraxCodeCommand)}`)));
    assert.match(loader, new RegExp(escapeRegex(`"nodePath":${JSON.stringify(process.execPath)}`)));
    assert.match(loader, /"cliBinDir":"\/managed\/bin"/);
    const repoMemoryHelperLoader = await readFile(installed.repoMemoryHelperPath, "utf8");
    assert.match(repoMemoryHelperLoader, /^\/\/ Managed by MemoraX Code/);
    assert.match(
      repoMemoryHelperLoader,
      new RegExp(escapeRegex(JSON.stringify(pathToFileURL(fixture.repoMemoryHelperSourcePath).href))),
    );
    assert.doesNotMatch(repoMemoryHelperLoader, /process\.argv/);
    const helperRun = spawnSync(
      process.execPath,
      [installed.repoMemoryHelperPath, "maintain", "--repo", fixture.root],
      { encoding: "utf8" },
    );
    assert.equal(helperRun.status, 0, helperRun.stderr);
    assert.deepEqual(JSON.parse(helperRun.stdout), ["maintain", "--repo", fixture.root]);
    assert.equal(await readFile(join(installed.skillPath, "SKILL.md"), "utf8"), "# MemoraX Code\n");
    assert.equal(await readFile(join(installed.skillPath, "references", "search.md"), "utf8"), "search\n");
    const state = JSON.parse(await readFile(installed.statePath, "utf8"));
    assert.equal(state.runtime, "opencode");
    assert.equal(state.openCodeConfigDir, fixture.openCodeConfigDir);
    assert.equal(state.repoMemoryHelperPath, installed.repoMemoryHelperPath);
    assert.equal(state.repoMemoryHelperSourcePath, fixture.repoMemoryHelperSourcePath);
    assert.match(state.repoMemoryHelperSourceSha256, /^[a-f0-9]{64}$/);

    const status = readOpenCodePluginStatus(fixture.options);
    assert.equal(status.ok, true);
    assert.equal(status.installed, true);
    assert.equal(status.current, true);
    assert.equal(status.repoMemoryHelperExists, true);
    assert.equal(status.repoMemoryHelperCurrent, true);

    const unchanged = ensureOpenCodePluginInstalled(fixture.options);
    assert.equal(unchanged.ok, true);
    assert.equal(unchanged.changed, false);
    assert.equal(unchanged.restartRequired, false);

    assert.equal(disableOpenCodePlugin(fixture.options).enabled, false);
    const reenabled = ensureOpenCodePluginInstalled(fixture.options);
    assert.equal(reenabled.changed, true);
    assert.equal(reenabled.restartRequired, true);

    await writeFile(fixture.pluginSourcePath, "export function createMemoraxOpenCodePlugin() { return 'updated'; }\n");
    assert.equal(readOpenCodePluginStatus(fixture.options).pluginCurrent, false);
    const updated = ensureOpenCodePluginInstalled(fixture.options);
    assert.equal(updated.changed, true);
    assert.equal(updated.restartRequired, true);
    assert.match(await readFile(updated.pluginPath, "utf8"), /Plugin source SHA-256: [a-f0-9]{64}/);

    await writeFile(
      fixture.repoMemoryHelperSourcePath,
      "process.stdout.write(JSON.stringify(['updated', ...process.argv.slice(2)]));\n",
    );
    assert.equal(readOpenCodePluginStatus(fixture.options).repoMemoryHelperCurrent, false);
    const helperUpdated = ensureOpenCodePluginInstalled(fixture.options);
    assert.equal(helperUpdated.changed, true);
    assert.equal(helperUpdated.restartRequired, false);
    assert.match(
      await readFile(helperUpdated.repoMemoryHelperPath, "utf8"),
      /Repo Memory helper source SHA-256: [a-f0-9]{64}/,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("OpenCode plugin install refuses to overwrite an unmanaged Repo Memory helper", async () => {
  const fixture = await createFixture("helper-conflict");
  const helperPath = join(fixture.openCodeConfigDir, "hooks", "repo-memory-job.mjs");
  try {
    await mkdir(join(fixture.openCodeConfigDir, "hooks"), { recursive: true });
    await writeFile(helperPath, "console.log('user helper');\n");

    const result = ensureOpenCodePluginInstalled(fixture.options);

    assert.equal(result.ok, false);
    assert.equal(result.reason, "repo_memory_helper_conflict");
    assert.equal(result.conflictPath, helperPath);
    assert.equal(await readFile(helperPath, "utf8"), "console.log('user helper');\n");
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

test("OpenCode plugin install refuses to overwrite a recorded loader without its managed marker", async () => {
  const fixture = await createFixture("recorded-loader-conflict");
  try {
    const installed = ensureOpenCodePluginInstalled(fixture.options);
    assert.equal(installed.ok, true);
    const customLoader = "export const UserPlugin = async () => ({});\n";
    await writeFile(installed.pluginPath, customLoader);

    const result = ensureOpenCodePluginInstalled(fixture.options);

    assert.equal(result.ok, false);
    assert.equal(result.reason, "plugin_conflict");
    assert.equal(await readFile(installed.pluginPath, "utf8"), customLoader);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("OpenCode plugin install removes newly created artifacts when state persistence fails", async () => {
  const fixture = await createFixture("state-write-failure");
  const blockedStateDir = join(fixture.options.memoraxCodeHome, "adapters", "opencode");
  const pluginPath = join(fixture.openCodeConfigDir, "plugins", "memorax-code.js");
  const skillPath = join(fixture.openCodeConfigDir, "skills", "memorax-code");
  const helperPath = join(fixture.openCodeConfigDir, "hooks", "repo-memory-job.mjs");
  try {
    await mkdir(join(fixture.options.memoraxCodeHome, "adapters"), { recursive: true });
    await writeFile(blockedStateDir, "not a directory\n");

    assert.throws(() => ensureOpenCodePluginInstalled(fixture.options));
    await assert.rejects(readFile(pluginPath), /ENOENT/);
    await assert.rejects(readFile(join(skillPath, "SKILL.md")), /ENOENT/);
    await assert.rejects(readFile(helperPath), /ENOENT/);

    await rm(blockedStateDir, { force: true });
    assert.equal(ensureOpenCodePluginInstalled(fixture.options).ok, true);
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
    assert.match(
      await readFile(installed.repoMemoryHelperPath, "utf8"),
      /^\/\/ Managed by MemoraX Code/,
    );

    const removed = removeOpenCodePluginInstallation(fixture.options);

    assert.equal(removed.ok, true);
    assert.equal(await readFile(unrelatedConfig, "utf8"), "{ // user config\n}\n");
    await assert.rejects(readFile(installed.pluginPath), /ENOENT/);
    await assert.rejects(readFile(join(installed.skillPath, "SKILL.md")), /ENOENT/);
    await assert.rejects(readFile(installed.repoMemoryHelperPath), /ENOENT/);
    await assert.rejects(readFile(installed.statePath), /ENOENT/);
    assert.equal(readOpenCodePluginStatus(fixture.options).managed, false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("OpenCode plugin removal preserves all artifacts when the recorded helper is unmanaged", async () => {
  const fixture = await createFixture("unmanaged-helper-removal");
  try {
    const installed = ensureOpenCodePluginInstalled(fixture.options);
    await writeFile(installed.repoMemoryHelperPath, "console.log('replacement');\n");

    const removed = removeOpenCodePluginInstallation(fixture.options);

    assert.equal(removed.ok, false);
    assert.equal(removed.reason, "repo_memory_helper_not_managed");
    assert.match(await readFile(installed.pluginPath, "utf8"), /^\/\/ Managed by MemoraX Code/);
    assert.equal(
      await readFile(installed.repoMemoryHelperPath, "utf8"),
      "console.log('replacement');\n",
    );
    assert.equal(JSON.parse(await readFile(installed.statePath, "utf8")).enabled, true);
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
  const repoMemoryHelperSourcePath = join(
    root,
    "Adapter With Spaces",
    "hooks",
    "repo-memory-job.mjs",
  );
  const memoraxCodeCommand = join(root, "Package With Spaces", "bin", "memorax-code.mjs");
  const skillSourcePath = join(root, "canonical-skill");
  await mkdir(join(skillSourcePath, "references"), { recursive: true });
  await mkdir(join(root, "Adapter With Spaces"), { recursive: true });
  await mkdir(join(root, "Adapter With Spaces", "hooks"), { recursive: true });
  await mkdir(join(root, "Package With Spaces", "bin"), { recursive: true });
  await writeFile(pluginSourcePath, "export function createMemoraxOpenCodePlugin() {}\n");
  await writeFile(
    repoMemoryHelperSourcePath,
    "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n",
  );
  await writeFile(memoraxCodeCommand, "#!/usr/bin/env node\n");
  await writeFile(join(skillSourcePath, "SKILL.md"), "# MemoraX Code\n");
  await writeFile(join(skillSourcePath, "references", "search.md"), "search\n");
  return {
    root,
    openCodeConfigDir,
    memoraxCodeCommand,
    pluginSourcePath,
    repoMemoryHelperSourcePath,
    options: {
      openCodeConfigDir,
      memoraxCodeHome,
      pluginSourcePath,
      repoMemoryHelperSourcePath,
      skillSourcePath,
      memoraxCodeCommand,
      cliBinDir: "/managed/bin",
    },
  };
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
