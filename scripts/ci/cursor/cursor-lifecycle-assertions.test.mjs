import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { snapshotCursorHooks, assertCursorHooks, verifyCursorLifecycleIntegration,
  assertCursorLifecycleIntegrationAbsent } from "./cursor-lifecycle-assertions.mjs";

const events = ["sessionStart", "beforeSubmitPrompt", "preCompact", "afterAgentResponse", "stop"];
const marker = "--memorax-code-cursor-hook-v1";
const userHooks = { version: 1, custom: { keep: ["private-canary", 7] }, hooks: {
  stop: [{ command: "user-owned-hook", timeout: 11 }],
  beforeShellExecution: [{ command: "user-owned-shell-hook" }],
} };
const failure = (suffix) => ({ testCode: `CURSOR_LIFECYCLE_${suffix}` });

function manifest(command) {
  const result = structuredClone(userHooks);
  for (const event of events) (result.hooks[event] ??= []).push({ type: "command", command, timeout: 150 });
  return result;
}

test("Cursor Hook snapshots remove only owned event entries, including Windows encoded commands", () => {
  const expected = snapshotCursorHooks(userHooks);
  const encoded = `powershell.exe -NoProfile -EncodedCommand ${Buffer.from(`node '${marker}'`, "utf16le").toString("base64")}`;
  for (const command of [`node runtime-hook.mjs ${marker}`, encoded]) {
    const actual = manifest(command);
    assertCursorHooks(actual, expected);
    assert.deepEqual(snapshotCursorHooks(actual), expected);
    assert.equal(actual.hooks.sessionStart.length, 1, "Snapshotting must not mutate the manifest");
  }
  assertCursorHooks({ version: 1, hooks: {} }, snapshotCursorHooks({}));
  assertCursorHooks({ version: 1 }, snapshotCursorHooks({ version: 1, hooks: { stop: [] } }));
  const foreign = { hooks: { stop: [{ type: "prompt", command: marker }, { command: "powershell -EncodedCommand !!!" }],
    otherEvent: [{ command: marker }] } };
  assert.equal(snapshotCursorHooks(foreign).hooks.stop.length, 2);
  assert.equal(snapshotCursorHooks(foreign).hooks.otherEvent.length, 1);
});

test("Cursor Hook preservation rejects unrelated changes without printing private configuration", () => {
  const expected = snapshotCursorHooks(userHooks);
  for (const mutate of [
    (value) => { value.custom.keep[0] = "changed-private-canary"; },
    (value) => { value.hooks.stop[0].timeout++; },
    (value) => { delete value.hooks.beforeShellExecution; },
    (value) => { value.added = true; },
  ]) {
    const actual = manifest(`node runtime ${marker}`);
    mutate(actual);
    assert.throws(() => assertCursorHooks(actual, expected), (error) => {
      assert.equal(error.testCode, "CURSOR_LIFECYCLE_UNRELATED_HOOKS_CHANGED");
      assert.doesNotMatch(error.message + JSON.stringify(error), /private-canary|user-owned/);
      return true;
    });
  }
  for (const value of [null, [], { version: 2 }, { hooks: [] }, { hooks: { stop: {} } }]) {
    assert.throws(() => snapshotCursorHooks(value), failure("HOOK_MANIFEST_INVALID"));
  }
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "cursor-lifecycle-assertions-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageRoot = join(root, "candidate"), cursorHome = join(root, "cursor"), stateHome = join(root, "state");
  const source = join(packageRoot, "lib", "memorax-code-cursor-adapter");
  const canonicalSkill = join(packageRoot, "lib", "memorax-code-codex-adapter", "skills", "memorax-code");
  const runtimeRoot = join(stateHome, "adapters", "cursor", "runtime", "generations");
  const runtimeDigest = "a".repeat(64), generation = join(runtimeRoot, runtimeDigest);
  const skillPath = join(cursorHome, "skills", "memorax-code");
  const agentPath = join(cursorHome, "agents", "memorax-repo-memory.md");
  const statePath = join(stateHome, "adapters", "cursor", "state.json");
  const write = async (path, value) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, typeof value === "string" ? value : JSON.stringify(value));
  };
  for (const path of ["hooks/runtime-hook.mjs", "hooks/repo-memory-job.mjs", "src/native-repo-memory.mjs",
    "src/runtime-observation.mjs", "src/native-database-path.mjs", "agents/memorax-repo-memory.md"]) {
    await write(join(source, path), `candidate ${path}\n`);
    await write(join(generation, path), `candidate ${path}\n`);
  }
  const common = join(packageRoot, "lib", "memorax-code-adapter-common", "src");
  await write(join(common, "hooks", "fixture.mjs"), "candidate common runtime\n");
  await cp(common, join(generation, "memorax-code-adapter-common", "src"), { recursive: true });
  await write(join(canonicalSkill, "SKILL.md"), "---\nname: memorax-code\n---\nSynthetic Skill.\n");
  await write(join(canonicalSkill, "references", "memorax-search.md"), "Synthetic search reference.\n");
  await write(join(canonicalSkill, "references", "nested", "resource.txt"), "Synthetic nested resource.\n");
  await cp(canonicalSkill, skillPath, { recursive: true });
  await cp(canonicalSkill, join(generation, "skills", "memorax-code"), { recursive: true });
  await write(join(skillPath, ".memorax-code-package.json"), { version: 1, memoraxCodeHome: stateHome });
  await write(agentPath, await readFile(join(source, "agents", "memorax-repo-memory.md"), "utf8"));
  const state = { version: 1, runtime: "cursor", integration: "hooks", enabled: true,
    cursorHome, hooksPath: join(cursorHome, "hooks.json"), skillPath, repoMemoryAgentPath: agentPath,
    runtimeRoot, runtimeDigest, runtimePath: join(generation, "hooks", "runtime-hook.mjs"),
    hookCommand: `node '${join(generation, "hooks", "runtime-hook.mjs")}' ${marker}` };
  await write(statePath, state);
  await write(state.hooksPath, manifest(state.hookCommand));
  const adapter = { ok: true, runtime: "cursor", integration: "hooks", installed: true,
    enabled: true, managed: true, current: true, cursorHome, statePath, installPath: dirname(state.runtimePath),
    skillPath, repoMemoryAgentPath: agentPath,
    cursorHooks: { ok: true, configured: true, runtimeObserved: false },
    cursorSkills: { ok: true, path: join(skillPath, "SKILL.md") },
    cursorAgents: { ok: true, path: agentPath } };
  return { packageRoot, cursorHome, stateHome, adapter, state, statePath, source, generation, skillPath, agentPath, write };
}

test("Cursor lifecycle independently compares candidate runtime, complete Skill trees and agent", async (t) => {
  const value = await fixture(t);
  await verifyCursorLifecycleIntegration(value);
  assertCursorHooks(JSON.parse(await readFile(value.state.hooksPath, "utf8")), snapshotCursorHooks(userHooks));
});

test("Cursor lifecycle verifies encoded Hooks and rejects their uninstall residue", async (t) => {
  const value = await fixture(t);
  value.state.hookCommand = `powershell.exe -EncodedCommand ${Buffer.from(`node "${value.state.runtimePath}" ${marker}`, "utf16le").toString("base64")}`;
  await value.write(value.statePath, value.state);
  await value.write(value.state.hooksPath, manifest(value.state.hookCommand));
  await verifyCursorLifecycleIntegration(value);
  for (const path of [value.skillPath, value.agentPath, join(value.stateHome, "adapters", "cursor")]) {
    await rm(path, { recursive: true, force: true });
  }
  await assert.rejects(assertCursorLifecycleIntegrationAbsent(value), failure("INTEGRATION_REMAINS"));
  await rm(value.state.hooksPath);
  await assertCursorLifecycleIntegrationAbsent(value);
});

test("Cursor lifecycle rejects missing, duplicate, stale or incorrectly shaped managed Hooks", async (t) => {
  const value = await fixture(t);
  for (const mutate of [
    (hooks) => { delete hooks.sessionStart; },
    (hooks) => { hooks.stop.push({ ...hooks.stop.at(-1) }); },
    (hooks) => { hooks.preCompact[0].command += " stale"; },
    (hooks) => { hooks.beforeSubmitPrompt[0].type = "prompt"; },
    (hooks) => { hooks.afterAgentResponse[0].timeout = 1; },
  ]) {
    const changed = manifest(value.state.hookCommand); mutate(changed.hooks);
    await value.write(value.state.hooksPath, changed);
    await assert.rejects(verifyCursorLifecycleIntegration(value), failure("HOOKS_MISMATCH"));
  }
});

test("Cursor lifecycle rejects dishonest readiness and state or status path substitutions", async (t) => {
  const value = await fixture(t);
  for (const key of ["ok", "installed", "enabled", "managed", "current"]) {
    await assert.rejects(verifyCursorLifecycleIntegration({ ...value, adapter: { ...value.adapter, [key]: false } }), failure("ADAPTER_NOT_READY"));
  }
  for (const key of ["cursorHome", "statePath", "installPath", "skillPath", "repoMemoryAgentPath"]) {
    await assert.rejects(verifyCursorLifecycleIntegration({ ...value, adapter: { ...value.adapter, [key]: join(value.stateHome, "foreign") } }), failure("PATH_MISMATCH"));
  }
  for (const change of [{ cursorHome: value.stateHome }, { runtimeDigest: "../foreign" },
    { runtimePath: join(value.generation, "foreign.mjs") }, { enabled: false }, { installPending: true },
    { hookCommand: "user-owned-hook" }]) {
    await value.write(value.statePath, { ...value.state, ...change });
    await assert.rejects(verifyCursorLifecycleIntegration(value), failure("STATE_INVALID"));
  }
});

test("Cursor lifecycle rejects stale runtime and any missing, altered or added Skill content", async (t) => {
  const value = await fixture(t);
  for (const path of [join(value.generation, "hooks", "runtime-hook.mjs"),
    join(value.generation, "hooks", "repo-memory-job.mjs"),
    join(value.generation, "memorax-code-adapter-common", "src", "hooks", "fixture.mjs"),
    join(value.skillPath, "references", "nested", "resource.txt"),
    join(value.generation, "skills", "memorax-code", "SKILL.md"), value.agentPath]) {
    const original = await readFile(path);
    await writeFile(path, "stale-private-canary");
    await assert.rejects(verifyCursorLifecycleIntegration(value), (error) => {
      assert.equal(error.testCode, "CURSOR_LIFECYCLE_ASSET_MISMATCH");
      assert.doesNotMatch(error.message + JSON.stringify(error), /private-canary|cursor-lifecycle-assertions-/);
      return true;
    });
    await writeFile(path, original);
  }
  const path = join(value.skillPath, "references", "nested", "resource.txt");
  const original = await readFile(path);
  await rm(path);
  await assert.rejects(verifyCursorLifecycleIntegration(value), failure("ASSET_MISMATCH"));
  await writeFile(path, original);
  await writeFile(join(value.skillPath, "unexpected.txt"), "extra");
  await assert.rejects(verifyCursorLifecycleIntegration(value), failure("ASSET_MISMATCH"));
});

test("Cursor lifecycle rejects symlinked deployed content instead of reading another tree", async (t) => {
  const value = await fixture(t);
  const path = join(value.skillPath, "references");
  await rm(path, { recursive: true });
  await symlink(join(value.packageRoot, "lib", "memorax-code-codex-adapter", "skills", "memorax-code", "references"),
    path, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(verifyCursorLifecycleIntegration(value), failure("ASSET_INVALID"));
});

test("Cursor lifecycle uninstall requires every managed artifact absent and leaves unrelated content alone", async (t) => {
  const value = await fixture(t);
  await value.write(value.state.hooksPath, userHooks);
  for (const path of [value.skillPath, value.agentPath, join(value.stateHome, "adapters", "cursor")]) {
    await rm(path, { recursive: true, force: true });
  }
  await value.write(join(value.cursorHome, "skills", "unrelated", "SKILL.md"), "preserve unrelated Skill");
  await value.write(join(value.cursorHome, "agents", "unrelated.md"), "preserve unrelated agent");
  await assertCursorLifecycleIntegrationAbsent(value);
  assertCursorHooks(JSON.parse(await readFile(value.state.hooksPath, "utf8")), snapshotCursorHooks(userHooks));
  for (const path of [join(value.skillPath, "SKILL.md"), value.agentPath,
    join(value.stateHome, "adapters", "cursor", "state.json")]) {
    await value.write(path, "residual");
    await assert.rejects(assertCursorLifecycleIntegrationAbsent(value), failure("INTEGRATION_REMAINS"));
    await rm(path.startsWith(value.skillPath) ? value.skillPath
      : path === value.agentPath ? value.agentPath : join(value.stateHome, "adapters", "cursor"), { recursive: true });
  }
  await value.write(value.state.hooksPath, manifest(value.state.hookCommand));
  await assert.rejects(assertCursorLifecycleIntegrationAbsent(value), failure("INTEGRATION_REMAINS"));
});
