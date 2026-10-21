#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

// Exercise an already materialized package without a native client or provider.
const packageRoot = resolve(process.argv[2] ?? "");
assert.ok(process.argv[2], "Usage: node scripts/ci/qoder/qoder-npm-package-smoke.mjs PACKAGE_ROOT");
const packageManifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
assert.equal(packageManifest.name, "@memorax/memorax-code");
assert.equal(packageManifest.bin["memorax-code-qoder"], "bin/memorax-code-qoder.mjs");
const root = await realpath(await mkdtemp(join(tmpdir(), "memorax qoder package smoke-")));
const home = join(root, "home");
const stateHome = join(root, "state");
const qoderHome = join(root, "qoder config");
const env = {
  PATH: [dirname(process.execPath), ...(process.platform === "win32"
    ? [join(process.env.SystemRoot ?? "C:\\Windows", "System32")]
    : ["/usr/bin", "/bin", "/usr/sbin", "/sbin"])].join(delimiter),
  ...(process.platform === "win32" ? {
    SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, ComSpec: process.env.ComSpec,
    PATHEXT: process.env.PATHEXT,
  } : {}),
  HOME: home, USERPROFILE: home, TMPDIR: root, TMP: root, TEMP: root,
  APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local"),
  MEMORAX_CODE_HOME: stateHome, QODER_CONFIG_DIR: qoderHome,
  MEMORAX_CODE_AUTO_UPDATE: "false",
};
const exec = promisify(execFile);
const run = async (command, expectedCode = 0) => {
  let result;
  try {
    result = { code: 0, ...await exec(process.execPath,
      [join(packageRoot, "bin", "memorax-code-qoder.mjs"), command, "--json"],
      { env, cwd: root, timeout: 30_000, encoding: "utf8" }) };
  } catch (error) {
    result = error;
  }
  assert.equal(result.code, expectedCode, `${command}: ${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout);
};
const settingsPath = join(qoderHome, "settings.json");
const userSettings = {
  model: "synthetic-user-model",
  hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "user-owned-hook" }] }] },
};
try {
  await Promise.all([home, qoderHome].map((path) => mkdir(path, { recursive: true, mode: 0o700 })));
  await writeFile(settingsPath, JSON.stringify(userSettings));
  const enabled = await run("enable");
  assert.equal(enabled.ok, true);
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.qoderHooks.configured, true);
  assert.equal(enabled.qoderHooks.runtimeObserved, false);
  assert.equal(enabled.qoderSkills.ok, true);
  assert.equal(enabled.qoderRepoMemoryAgent.ok, true);
  const settings = JSON.parse(await readFile(settingsPath, "utf8"));
  const marker = "--memorax-code-qoder-hook-v1";
  for (const event of ["SessionStart", "UserPromptSubmit", "QueryEnd", "PreToolUse"]) {
    const managed = settings.hooks[event].flatMap((group) => group.hooks)
      .filter((hook) => hook.args?.includes(marker));
    assert.equal(managed.length, 1, `${event} must have one managed Hook`);
    assert.equal(managed[0].command, process.execPath);
    assert.deepEqual(managed[0].args, [enabled.runtimePath, marker]);
  }
  const generation = dirname(dirname(enabled.runtimePath));
  for (const relative of ["hooks/runtime-hook.mjs", "hooks/repo-memory-job.mjs", "src/native-repo-memory.mjs",
    "src/repo-memory-events.mjs", "src/runtime-observation.mjs", "src/memory-cli-context.mjs", "agents/memorax-repo-memory.md"]) {
    assert.equal((await stat(join(generation, relative))).isFile(), true);
  }
  const skillPath = join(qoderHome, "skills", "memorax-code");
  const sourceSkill = join(packageRoot, "lib", "memorax-code-codex-adapter", "skills", "memorax-code");
  for (const relative of ["SKILL.md", "references/memorax-search.md", "references/memorax-add.md"]) {
    assert.equal(await readFile(join(skillPath, relative), "utf8"),
      await readFile(join(sourceSkill, relative), "utf8"));
  }
  assert.equal((await run("enable")).changed, false);
  assert.equal((await run("status")).enabled, true);
  assert.equal((await run("disable")).enabled, false);
  assert.equal((await run("status", 1)).reason, "disabled");
  assert.equal((await stat(join(skillPath, "SKILL.md"))).isFile(), true);
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), userSettings);
  assert.equal((await run("remove")).removed, true);
  await assert.rejects(stat(skillPath), { code: "ENOENT" });
  await assert.rejects(stat(join(qoderHome, "agents", "memorax-repo-memory.md")), { code: "ENOENT" });
  await assert.rejects(stat(join(stateHome, "adapters", "qoder")), { code: "ENOENT" });
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), userSettings);
  console.log("Qoder installed-package lifecycle smoke passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
