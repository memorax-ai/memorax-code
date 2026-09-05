import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const launcherSource = fileURLToPath(new URL(
  "../../../ts/memorax-code-codex-adapter/skills/memorax-code/scripts/user-profile-memory.mjs",
  import.meta.url,
));

test("User Profile launcher imports the packaged runtime in every skill layout", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "memorax-user-profile-launcher-"));
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ type: "module" }));
    const backend = join(root, "lib", "memorax-code-backend", "dist", "personal-memory", "cli.js");
    await mkdir(dirname(backend), { recursive: true });
    await writeFile(backend, [
      "export function runUserProfileCli(args) {",
      "  process.stdout.write(JSON.stringify(args) + '\\n');",
      "  return 7;",
      "}",
      "",
    ].join("\n"));
    for (const adapterRoot of [
      ...["codex", "claude", "dsh", "opencode", "codebuddy", "trae"]
        .map((name) => `lib/memorax-code-${name}-adapter`),
      "lib/memorax-code-claude-marketplace/plugins/memorax-code-claude-adapter",
    ]) {
      await t.test(adapterRoot, async () => {
        const launcher = await copyLauncher(join(root, adapterRoot));
        const args = ["list", "--repo", join(root, "repo with spaces")];
        const result = runLauncher(root, launcher, args);
        assert.equal(result.error, undefined);
        assert.equal(result.status, 7, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), args);
      });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("materialized User Profile launcher uses skill or plugin package metadata", async (t) => {
  for (const metadataLocation of ["skill", "plugin"]) {
    await t.test(metadataLocation, async () => {
      const root = await mkdtemp(join(tmpdir(), "memorax-user-profile-materialized-"));
      try {
        const pluginRoot = join(root, "installed plugin");
        const launcher = await copyLauncher(pluginRoot);
        const command = join(root, "memorax code.mjs");
        await writeFile(command, [
          "process.stdout.write(JSON.stringify(process.argv.slice(2)) + '\\n');",
          "process.exitCode = 9;",
          "",
        ].join("\n"));
        const metadataRoot = metadataLocation === "skill" ? dirname(dirname(launcher)) : pluginRoot;
        await writeFile(join(metadataRoot, ".memorax-code-package.json"), JSON.stringify({
          memoraxCodeCommand: command,
        }));
        const args = ["add", "--description", '中文 "quotes" $value & ;', "--repo", join(root, "repo space")];
        const result = runLauncher(root, launcher, args);
        assert.equal(result.error, undefined);
        assert.equal(result.status, 9, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), ["user-profile", ...args]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("User Profile launcher reports an unavailable runtime without invoking external tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-user-profile-unavailable-"));
  try {
    const launcher = await copyLauncher(join(root, "plugin"));
    const result = runLauncher(root, launcher, ["list"]);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "User Profile runtime is unavailable; reinstall or rebuild MemoraX Code.\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function copyLauncher(pluginRoot) {
  const launcher = join(pluginRoot, "skills", "memorax-code", "scripts", "user-profile-memory.mjs");
  await mkdir(dirname(launcher), { recursive: true });
  await cp(launcherSource, launcher);
  return launcher;
}

function runLauncher(root, launcher, args) {
  return spawnSync(process.execPath, [launcher, ...args], {
    cwd: root,
    env: { ...process.env, PATH: join(root, "empty-bin") },
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true,
  });
}
