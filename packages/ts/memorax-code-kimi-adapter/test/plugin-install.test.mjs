import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  disableKimiHooks,
  ensureKimiHooksInstalled,
  readKimiHooksStatus,
  removeKimiHooksInstallation,
} from "../src/plugin-install.mjs";

test("Kimi installer preserves user config and manages only its Hook blocks", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-kimi-install-"));
  const kimiHome = join(root, "kimi");
  const memoraxCodeHome = join(root, "memorax");
  try {
    const configPath = join(kimiHome, "config.toml");
    await mkdir(kimiHome, { recursive: true });
    await writeFile(configPath, "[providers.example]\nmodel = \"local\"\n\n[[hooks]]\nevent = \"Notification\"\ncommand = \"echo keep\"\n");
    const options = { kimiHome, memoraxCodeHome, kimiCommand: process.execPath };
    const installed = ensureKimiHooksInstalled(options);
    assert.equal(installed.enabled, true);
    const config = await readFile(configPath, "utf8");
    assert.match(config, /model = "local"/);
    assert.match(config, /event = "UserPromptSubmit"/);
    assert.equal((config.match(/# MemoraX Code Kimi Adapter/g) ?? []).length, 6);
    assert.equal(await readFile(join(kimiHome, "skills", "memorax-code", "SKILL.md"), "utf8").then((text) => text.includes("memorax-cli")), true);
    assert.equal(readKimiHooksStatus(options).skillCurrent, true);
    assert.equal(readKimiHooksStatus(options).enabled, true);

    disableKimiHooks(options);
    assert.equal(readKimiHooksStatus(options).enabled, false);
    const disabled = await readFile(configPath, "utf8");
    assert.match(disabled, /event = "Notification"/);
    assert.doesNotMatch(disabled, /MemoraX Code Kimi Adapter/);

    const removed = removeKimiHooksInstallation(options);
    assert.equal(removed.removed, true);
    assert.equal(readKimiHooksStatus(options).reason, "not_managed");
    await assert.rejects(readFile(join(kimiHome, "skills", "memorax-code", "SKILL.md")), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Kimi installer refuses to overwrite an existing unmanaged skill", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-kimi-skill-conflict-"));
  const kimiHome = join(root, "kimi");
  const memoraxCodeHome = join(root, "memorax");
  const skillPath = join(kimiHome, "skills", "memorax-code");
  try {
    await mkdir(skillPath, { recursive: true });
    await writeFile(join(skillPath, "SKILL.md"), "# user skill\n");
    const result = ensureKimiHooksInstalled({ kimiHome, memoraxCodeHome, kimiCommand: process.execPath });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "skill_conflict");
    assert.equal(await readFile(join(skillPath, "SKILL.md"), "utf8"), "# user skill\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Kimi installer treats a dangling skill symlink as an unmanaged conflict", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-kimi-skill-symlink-"));
  const kimiHome = join(root, "kimi");
  const memoraxCodeHome = join(root, "memorax");
  const skillPath = join(kimiHome, "skills", "memorax-code");
  try {
    await mkdir(join(kimiHome, "skills"), { recursive: true });
    await symlink(join(root, "missing-skill"), skillPath);
    const result = ensureKimiHooksInstalled({ kimiHome, memoraxCodeHome, kimiCommand: process.execPath });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "skill_conflict");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Kimi uninstall preserves a modified managed skill", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-kimi-skill-ownership-"));
  const kimiHome = join(root, "kimi");
  const memoraxCodeHome = join(root, "memorax");
  const options = { kimiHome, memoraxCodeHome, kimiCommand: process.execPath };
  try {
    ensureKimiHooksInstalled(options);
    const skillFile = join(kimiHome, "skills", "memorax-code", "SKILL.md");
    await writeFile(skillFile, "# user edit\n");
    const result = removeKimiHooksInstallation(options);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "skill_not_managed");
    assert.equal(await readFile(skillFile, "utf8"), "# user edit\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Kimi installer replaces unmarked legacy MemoraX Hook blocks idempotently", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-kimi-legacy-install-"));
  const kimiHome = join(root, "kimi");
  const memoraxCodeHome = join(root, "memorax");
  try {
    const configPath = join(kimiHome, "config.toml");
    await mkdir(kimiHome, { recursive: true });
    await writeFile(configPath, [
      "[providers.example]",
      "model = \"local\"",
      "",
      "[[hooks]]",
      "event = \"UserPromptSubmit\"",
      "command = \"'/usr/bin/node' '/tmp/memorax-code-kimi-adapter/src/hook-runtime.mjs'\"",
      "timeout = 25",
      "",
    ].join("\n"));
    const options = { kimiHome, memoraxCodeHome, kimiCommand: process.execPath };
    ensureKimiHooksInstalled(options);
    const first = await readFile(configPath, "utf8");
    ensureKimiHooksInstalled(options);
    const second = await readFile(configPath, "utf8");
    assert.equal(second, first);
    assert.equal((second.match(/# MemoraX Code Kimi Adapter/g) ?? []).length, 6);
    assert.equal((second.match(/event = \"UserPromptSubmit\"/g) ?? []).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
