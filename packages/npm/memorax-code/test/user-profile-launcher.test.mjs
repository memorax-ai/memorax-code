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
        const args = ["list", "--home", join(root, "memory with spaces")];
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
        const args = ["add", "--description", '中文 "quotes" $value & ;', "--home", join(root, "memory space")];
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

test("User Profile launcher shares the configured home with direct and materialized runtimes", async (t) => {
  for (const runtime of ["direct", "materialized"]) {
    await t.test(runtime, async (t) => {
      const root = await mkdtemp(join(tmpdir(), "memorax-user-profile-home-"));
      try {
        await writeFile(join(root, "package.json"), JSON.stringify({ type: "module" }));
        const pluginRoot = join(root, runtime === "direct" ? "lib/memorax-code-codex-adapter" : "plugin");
        const launcher = await copyLauncher(pluginRoot);
        const command = join(root, "memorax code.mjs");
        const runtimeBody = "process.stdout.write(JSON.stringify({ args, home: process.env.MEMORAX_CODE_HOME ?? null }) + '\\n');";
        await writeFile(command, `const args = process.argv.slice(3);\n${runtimeBody}\n`);
        if (runtime === "direct") {
          const backend = join(root, "lib", "memorax-code-backend", "dist", "personal-memory", "cli.js");
          await mkdir(dirname(backend), { recursive: true });
          await writeFile(backend, `export function runUserProfileCli(args) { ${runtimeBody} return 0; }\n`);
        }
        const skillMetadata = join(dirname(dirname(launcher)), ".memorax-code-package.json");
        const pluginMetadata = join(pluginRoot, ".memorax-code-package.json");
        const skillHome = join(root, "skill memory");
        const pluginHome = join(root, "plugin memory");
        const environmentHome = join(root, "environment memory");
        const explicitHome = join(root, "explicit memory");
        for (const scenario of [
          { name: "skill metadata precedes package metadata", skillHome, pluginHome, expectedHome: skillHome },
          { name: "package metadata supplies the home", pluginHome, expectedHome: pluginHome },
          { name: "environment precedes metadata", skillHome, pluginHome, envHome: environmentHome, expectedHome: environmentHome },
          { name: "explicit home is forwarded unchanged", skillHome, pluginHome, args: ["list", "--home", explicitHome], expectedHome: skillHome },
          { name: "default home remains runtime-owned", expectedHome: null },
        ]) {
          await t.test(scenario.name, async () => {
            await writeFile(skillMetadata, JSON.stringify({ memoraxCodeHome: scenario.skillHome }));
            await writeFile(pluginMetadata, JSON.stringify({ memoraxCodeCommand: command, memoraxCodeHome: scenario.pluginHome }));
            const args = scenario.args ?? ["list"];
            const result = runLauncher(root, launcher, args, { MEMORAX_CODE_HOME: scenario.envHome });
            assert.equal(result.error, undefined);
            assert.equal(result.status, 0, result.stderr);
            assert.deepEqual(JSON.parse(result.stdout), { args, home: scenario.expectedHome });
          });
        }
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

function runLauncher(root, launcher, args, env = {}) {
  return spawnSync(process.execPath, [launcher, ...args], {
    cwd: root,
    env: { ...process.env, PATH: join(root, "empty-bin"), ...env },
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true,
  });
}
