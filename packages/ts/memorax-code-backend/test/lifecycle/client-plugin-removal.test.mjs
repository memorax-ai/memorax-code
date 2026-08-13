import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { prepareClientPluginRemovalCleanup } from "../../dist/lifecycle/client-plugin-removal.js";

test("package-removal cleanup is prepared before shutdown and removes all client plugins", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-client-plugin-removal-"));
  const home = join(root, "home");
  const memoraxCodeHome = join(home, "memorax-code-home");
  const codexHome = join(home, "codex-home");
  const claudeHome = join(home, "claude-home");
  const openCodeConfigDir = join(home, "opencode-config");
  const codexPluginManifest = join(
    codexHome,
    ".memorax-code",
    "plugins",
    "memorax-code-codex-adapter",
    ".codex-plugin",
    "plugin.json",
  );
  const claudeCommand = join(root, "fake-claude.mjs");
  const claudeCalls = join(root, "claude-calls.jsonl");
  const openCodePlugin = join(openCodeConfigDir, "plugins", "memorax-code.js");
  const openCodeSkill = join(openCodeConfigDir, "skills", "memorax-code");
  const openCodeRepoMemoryHelper = join(openCodeConfigDir, "hooks", "repo-memory-job.mjs");
  const openCodeState = join(memoraxCodeHome, "adapters", "opencode", "state.json");

  try {
    await mkdir(dirname(codexPluginManifest), { recursive: true });
    await mkdir(join(memoraxCodeHome, "adapters", "codex"), { recursive: true });
    await mkdir(join(memoraxCodeHome, "adapters", "claude-code"), { recursive: true });
    await mkdir(dirname(openCodeState), { recursive: true });
    await mkdir(dirname(openCodePlugin), { recursive: true });
    await mkdir(openCodeSkill, { recursive: true });
    await mkdir(dirname(openCodeRepoMemoryHelper), { recursive: true });
    await mkdir(claudeHome, { recursive: true });
    await writeFile(codexPluginManifest, '{"name":"memorax-code-codex-adapter"}\n');
    await writeFile(join(memoraxCodeHome, "adapters", "codex", "state.json"), `${JSON.stringify({
      version: 1,
      codexHome,
    })}\n`);
    await writeFile(join(memoraxCodeHome, "adapters", "claude-code", "state.json"), `${JSON.stringify({
      version: 1,
      claudeHome,
    })}\n`);
    await writeFile(join(claudeHome, "settings.json"), `${JSON.stringify({
      extraKnownMarketplaces: {
        "memorax-code-local": { source: { source: "directory", path: join(root, "marketplace") } },
      },
      enabledPlugins: {
        "memorax-code-claude-adapter@memorax-code-local": true,
      },
    })}\n`);
    await writeFile(openCodePlugin, "// Managed by MemoraX Code. Do not edit.\n");
    await writeFile(join(openCodeSkill, "SKILL.md"), "# MemoraX Code\n");
    await writeFile(openCodeRepoMemoryHelper, "// Managed by MemoraX Code. Do not edit.\n");
    await writeFile(openCodeState, `${JSON.stringify({
      version: 1,
      runtime: "opencode",
      integration: "plugin",
      enabled: true,
      openCodeConfigDir,
      pluginPath: openCodePlugin,
      skillPath: openCodeSkill,
      repoMemoryHelperPath: openCodeRepoMemoryHelper,
      repoMemoryHelperSourcePath: join(root, "repo-memory-job-source.mjs"),
      repoMemoryHelperSourceSha256: "0".repeat(64),
    })}\n`);
    await writeFile(claudeCommand, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(claudeCalls)}, JSON.stringify(process.argv.slice(2)) + "\\n");
`);
    await chmod(claudeCommand, 0o755);

    const cleanup = await prepareClientPluginRemovalCleanup({
      memoraxCodeHome,
      homeDir: home,
      codexCommand: join(root, "missing-codex"),
      claudeCommand,
      openCodeConfigDir,
    });
    const report = await cleanup();

    assert.equal(report.ok, true);
    assert.equal(report.codexPlugin?.ok, true);
    assert.equal(report.claudePlugin?.ok, true);
    assert.equal(report.opencodePlugin?.ok, true);
    await assert.rejects(stat(codexPluginManifest), /ENOENT/);
    await assert.rejects(stat(openCodePlugin), /ENOENT/);
    await assert.rejects(stat(openCodeSkill), /ENOENT/);
    await assert.rejects(stat(openCodeRepoMemoryHelper), /ENOENT/);
    await assert.rejects(stat(openCodeState), /ENOENT/);
    const calls = (await readFile(claudeCalls, "utf8")).trim().split("\n").map(JSON.parse);
    assert.deepEqual(calls, [
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
    await rm(root, { recursive: true, force: true });
  }
});
