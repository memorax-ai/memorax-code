import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { defaultQoderHome, qoderInstallationDetected } from "../src/adapter-paths.mjs";
import {
  disableQoderAdapter, enableQoderAdapter, qoderHookCommand,
  readQoderAdapterStatus, removeQoderAdapter,
} from "../src/config.mjs";
import { fixture, json, runNode } from "./support.mjs";

test("Qoder uses its native config override and detects the installed desktop", () => {
  const home = process.cwd();
  assert.equal(defaultQoderHome({}, home), join(home, ".qoder"));
  assert.equal(defaultQoderHome({ QODER_CONFIG_DIR: join(home, "custom") }, home), join(home, "custom"));
  assert.equal(defaultQoderHome({ QODER_HOME: join(home, "ignored") }, home), join(home, ".qoder"));
  assert.equal(defaultQoderHome({ QODER_CLI_HOME: join(home, "cli") }, home), join(home, "cli", ".qoder"));
  assert.equal(defaultQoderHome({ QODER_CONFIG_DIR_NAME: ".qodercn" }, home), join(home, ".qodercn"));
  assert.equal(defaultQoderHome({ QODER_CLI_HOME: join(home, "cli"), QODER_CONFIG_DIR_NAME: ".custom" }, home), join(home, "cli", ".custom"));
  assert.equal(defaultQoderHome({ QODER_CONFIG_DIR: join(home, "explicit"), QODER_CLI_HOME: join(home, "cli"), QODER_CONFIG_DIR_NAME: ".custom" }, home), join(home, "explicit"));
  assert.equal(qoderInstallationDetected({ home, env: {}, platform: "darwin", pathExists: (path) => path === "/Applications/Qoder.app" }), true);
  assert.equal(qoderInstallationDetected({ home, env: {}, platform: "linux", pathExists: () => false }), false);
  assert.deepEqual(qoderHookCommand("/runtime with ' and $/hook.mjs", "/node with space"), {
    type: "command", command: "/node with space", args: ["/runtime with ' and $/hook.mjs", "--memorax-code-qoder-hook-v1"],
  });
});

test("enable merges owned entries, deploys a canonical Skill and is idempotent", async (t) => {
  const f = await fixture(t, { install: false });
  const path = join(f.qoderHome, "settings.json");
  const userHook = { type: "command", command: "user-hook", timeout: 9 };
  const original = { model: "user-model", permissions: { allow: ["Read"] }, hooks: {
    UserPromptSubmit: [{ matcher: "*", hooks: [userHook], userField: true }],
    CustomEvent: [{ hooks: [{ type: "command", command: "custom-hook" }] }],
  } };
  await writeFile(path, JSON.stringify(original));
  const installed = await enableQoderAdapter(f.options);
  assert.equal(installed.ok, true);
  assert.equal(installed.enabled, true);
  assert.equal(installed.changed, true);
  assert.equal(installed.qoderHooks.runtimeObserved, false);
  const settings = await json(path);
  assert.equal(settings.model, original.model);
  assert.deepEqual(settings.permissions, original.permissions);
  assert.deepEqual(settings.hooks.CustomEvent, original.hooks.CustomEvent);
  assert.deepEqual(settings.hooks.UserPromptSubmit[0], original.hooks.UserPromptSubmit[0]);
  for (const event of ["SessionStart", "UserPromptSubmit", "QueryEnd", "PreToolUse"]) {
    const groups = settings.hooks[event];
    const owned = groups.flatMap((group) => group.hooks).filter((item) => item.args?.includes("--memorax-code-qoder-hook-v1"));
    assert.equal(owned.length, 1);
    assert.equal(owned[0].command, process.execPath);
    assert.equal(owned[0].args[0], installed.runtimePath);
    assert.equal(owned[0].timeout, { SessionStart: 120, UserPromptSubmit: 150, QueryEnd: 40, PreToolUse: 5 }[event]);
    if (event === "PreToolUse") assert.equal(groups.at(-1).matcher, "Bash");
  }
  assert.equal(settings.hooks.Stop, undefined);
  assert.equal(await readFile(join(installed.skillPath, "SKILL.md"), "utf8"), await readFile(join(f.options.skillSourcePath, "SKILL.md"), "utf8"));
  const metadata = await json(join(installed.skillPath, ".memorax-code-package.json"));
  assert.equal(metadata.memoraxCodeHome, f.memoraxCodeHome);
  assert.equal(metadata.memoraxCodeCommand, f.options.memoraxCodeCommand);
  assert.equal(installed.qoderRepoMemoryAgent.ok, true);
  assert.match(await readFile(installed.qoderRepoMemoryAgent.path, "utf8"), /model: inherit/);
  const unchanged = await enableQoderAdapter(f.options);
  assert.equal(unchanged.changed, false);
  assert.equal(unchanged.runtimePath, installed.runtimePath);
  assert.deepEqual(await json(path), settings);
  if (process.platform !== "win32") assert.equal((await stat(installed.statePath)).mode & 0o777, 0o600);
});

test("disable and remove preserve unrelated settings, mixed Hook groups and Skills", async (t) => {
  const f = await fixture(t);
  const path = join(f.qoderHome, "settings.json");
  const settings = await json(path);
  settings.theme = "user-theme";
  settings.hooks.QueryEnd[0].label = "mixed";
  settings.hooks.QueryEnd[0].hooks.push({ type: "command", command: "user-completion" });
  await writeFile(path, JSON.stringify(settings));
  const userSkill = join(f.qoderHome, "skills", "my-skill");
  await mkdir(userSkill); await writeFile(join(userSkill, "SKILL.md"), "user-owned");
  assert.equal((await disableQoderAdapter(f.options)).ok, true);
  assert.equal((await readQoderAdapterStatus(f.options)).enabled, false);
  const disabled = await json(path);
  assert.equal(disabled.theme, "user-theme");
  assert.deepEqual(disabled.hooks, { QueryEnd: [{ label: "mixed", hooks: [{ type: "command", command: "user-completion" }] }] });
  assert.equal(existsSync(f.installed.skillPath), true);
  assert.equal((await enableQoderAdapter(f.options)).enabled, true);
  assert.equal((await removeQoderAdapter(f.options)).removed, true);
  assert.equal(existsSync(f.installed.skillPath), false);
  assert.equal(existsSync(join(f.qoderHome, "agents", "memorax-repo-memory.md")), false);
  assert.equal(await readFile(join(userSkill, "SKILL.md"), "utf8"), "user-owned");
  assert.deepEqual(await json(path), disabled);
  assert.equal((await removeQoderAdapter(f.options)).reason, "not_managed");
});

test("Repo Memory agent ownership protects user definitions and detects edits", async (t) => {
  const fresh = await fixture(t, { install: false });
  const target = join(fresh.qoderHome, "agents", "memorax-repo-memory.md");
  await mkdir(join(fresh.qoderHome, "agents"));
  await writeFile(target, "User-owned agent.\n");
  assert.equal((await enableQoderAdapter(fresh.options)).reason, "agent_conflict");
  assert.equal(existsSync(join(fresh.qoderHome, "settings.json")), false);
  assert.equal(await readFile(target, "utf8"), "User-owned agent.\n");

  const managed = await fixture(t);
  const agentPath = join(managed.qoderHome, "agents", "memorax-repo-memory.md");
  await writeFile(agentPath, "User-edited agent.\n");
  assert.equal((await readQoderAdapterStatus(managed.options)).enabled, false);
  assert.equal((await enableQoderAdapter(managed.options)).reason, "agent_conflict");
  assert.equal((await removeQoderAdapter(managed.options)).reason, "agent_conflict");
  assert.equal(await readFile(agentPath, "utf8"), "User-edited agent.\n");
  assert.equal((await json(managed.installed.statePath)).enabled, false);
});

test("unmanaged or edited memorax-code Skills are never adopted or overwritten", async (t) => {
  const f = await fixture(t, { install: false });
  const target = join(f.qoderHome, "skills", "memorax-code");
  await mkdir(target, { recursive: true }); await writeFile(join(target, "SKILL.md"), "user Skill");
  assert.equal((await enableQoderAdapter(f.options)).reason, "skill_conflict");
  assert.equal(existsSync(join(f.qoderHome, "settings.json")), false);
  assert.equal(await readFile(join(target, "SKILL.md"), "utf8"), "user Skill");
  const managed = await fixture(t);
  await writeFile(join(managed.installed.skillPath, "notes.md"), "user addition");
  assert.equal((await enableQoderAdapter(managed.options)).reason, "skill_conflict");
  assert.equal((await removeQoderAdapter(managed.options)).reason, "skill_conflict");
  assert.equal(await readFile(join(managed.installed.skillPath, "notes.md"), "utf8"), "user addition");
  assert.equal((await json(managed.installed.statePath)).enabled, false);
});

test("invalid settings, state scope changes, and symlinks fail without overwriting user files", async (t) => {
  const f = await fixture(t, { install: false });
  const settings = join(f.qoderHome, "settings.json");
  await writeFile(settings, "{ invalid JSON");
  assert.equal((await enableQoderAdapter(f.options)).ok, false);
  assert.equal(await readFile(settings, "utf8"), "{ invalid JSON");
  const managed = await fixture(t);
  const before = await readFile(managed.installed.statePath, "utf8");
  assert.equal((await enableQoderAdapter({ ...managed.options, qoderHome: join(managed.root, "other-qoder") })).reason, "state_invalid");
  assert.equal(await readFile(managed.installed.statePath, "utf8"), before);
  if (process.platform !== "win32") {
    const linked = await fixture(t, { install: false });
    const outside = join(linked.root, "outside-settings.json");
    await writeFile(outside, "{}"); await symlink(outside, join(linked.qoderHome, "settings.json"));
    assert.equal((await enableQoderAdapter(linked.options)).ok, false);
    assert.equal(await readFile(outside, "utf8"), "{}");
  }
});

test("runtime metadata creates immutable generations and status detects content corruption", async (t) => {
  const f = await fixture(t);
  const oldRuntime = await readFile(f.runtimePath, "utf8");
  const nextCommand = join(f.root, "next-lifecycle.mjs");
  await writeFile(nextCommand, "process.exit(0);\n");
  const next = await enableQoderAdapter({ ...f.options, memoraxCodeCommand: nextCommand });
  assert.notEqual(next.runtimeDigest, f.installed.runtimeDigest);
  assert.equal(await readFile(f.runtimePath, "utf8"), oldRuntime);
  await writeFile(next.runtimePath, "// corrupted managed runtime\n");
  const status = await readQoderAdapterStatus(f.options);
  assert.equal(status.installed, false);
  assert.equal(status.enabled, false);
  assert.equal((await enableQoderAdapter({ ...f.options, memoraxCodeCommand: nextCommand })).ok, false);
});

test("status rejects missing or changed Skill launcher metadata and enable repairs only owned content", async (t) => {
  for (const missing of [true, false]) {
    const f = await fixture(t);
    const metadataPath = join(f.installed.skillPath, ".memorax-code-package.json");
    const skillPath = join(f.installed.skillPath, "SKILL.md");
    const original = await readFile(skillPath, "utf8");
    const metadata = await json(metadataPath);
    if (missing) delete metadata.memoraxCodeCommand;
    else metadata.memoraxCodeCommand = join(f.root, "different-lifecycle.mjs");
    await writeFile(metadataPath, JSON.stringify(metadata));
    const status = await readQoderAdapterStatus(f.options);
    assert.equal(status.installed, false);
    assert.equal(status.enabled, false);
    assert.equal(status.qoderSkills.ok, false);
    assert.equal((await enableQoderAdapter(f.options)).enabled, true);
    assert.equal((await json(metadataPath)).memoraxCodeCommand, f.options.memoraxCodeCommand);
    assert.equal(await readFile(skillPath, "utf8"), original);

    await writeFile(metadataPath, JSON.stringify(metadata));
    await writeFile(skillPath, "User-edited Skill content must survive.\n");
    assert.equal((await enableQoderAdapter(f.options)).reason, "skill_conflict");
    assert.equal(await readFile(skillPath, "utf8"), "User-edited Skill content must survive.\n");
  }
});

test("the canonical User Profile launcher uses the deployed custom personal-memory home", async (t) => {
  const f = await fixture(t, { install: false });
  await writeFile(f.options.memoraxCodeCommand,
    "process.stdout.write(JSON.stringify({home:process.env.MEMORAX_CODE_HOME,args:process.argv.slice(2)}));\n");
  const skillSourcePath = fileURLToPath(new URL("../../memorax-code-codex-adapter/skills/memorax-code", import.meta.url));
  const installed = await enableQoderAdapter({ ...f.options, skillSourcePath });
  assert.equal(installed.enabled, true);
  const result = await runNode([join(installed.skillPath, "scripts", "user-profile-memory.mjs"), "list", "--json"], {
    cwd: f.root,
    env: { PATH: process.env.PATH, HOME: f.home,
      ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot, USERPROFILE: f.home } : {}) },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { home: f.memoraxCodeHome, args: ["user-profile", "list", "--json"] });
});

test("pending installation authority can recover without duplicating native Hooks", async (t) => {
  const f = await fixture(t);
  const state = await json(f.installed.statePath);
  await writeFile(f.installed.statePath, JSON.stringify({ ...state, enabled: false, installPending: true, pendingSkillDigest: state.skillDigest }));
  assert.equal((await readQoderAdapterStatus(f.options)).reason, "install_incomplete");
  const repaired = await enableQoderAdapter(f.options);
  assert.equal(repaired.enabled, true);
  assert.equal((await json(repaired.statePath)).installPending, undefined);
});

test("independent installers serialize one owned Hook entry per event", async (t) => {
  const f = await fixture(t, { install: false });
  const script = `import { enableQoderAdapter } from ${JSON.stringify(new URL("../src/config.mjs", import.meta.url).href)}; console.log(JSON.stringify(await enableQoderAdapter(JSON.parse(process.argv[1]))));`;
  const results = await Promise.all([1, 2].map(() => runNode(["--input-type=module", "--eval", script, JSON.stringify(f.options)], {
    cwd: f.root, env: { PATH: process.env.PATH, HOME: f.home, ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot, USERPROFILE: f.home } : {}) },
  })));
  for (const result of results) { assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).ok, true); }
  const settings = await json(join(f.qoderHome, "settings.json"));
  for (const event of ["SessionStart", "UserPromptSubmit", "QueryEnd", "PreToolUse"]) assert.equal(settings.hooks[event].length, 1);
});

test("the public adapter CLI reports readiness and removes only its isolated installation", async (t) => {
  const f = await fixture(t, { install: false });
  const cli = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
  const env = { PATH: process.env.PATH, HOME: f.home, MEMORAX_CODE_HOME: f.memoraxCodeHome,
    ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot, USERPROFILE: f.home } : {}) };
  const run = (command) => runNode([cli, command, "--qoder-home", f.qoderHome, "--json"], { cwd: f.root, env });
  assert.equal((await run("status")).status, 1);
  const enabled = await run("enable");
  assert.equal(enabled.status, 0, enabled.stderr);
  assert.equal(JSON.parse(enabled.stdout).enabled, true);
  assert.equal((await run("status")).status, 0);
  assert.equal((await run("disable")).status, 0);
  assert.equal((await run("status")).status, 1);
  assert.equal((await run("remove")).status, 0);
  assert.equal(existsSync(join(f.qoderHome, "skills", "memorax-code")), false);
});
