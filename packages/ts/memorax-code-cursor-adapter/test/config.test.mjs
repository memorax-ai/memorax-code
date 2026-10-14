import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { withJsonFileLockAsync } from "../../memorax-code-adapter-common/src/config-utils.mjs";
import { cursorInstallationDetected, defaultCursorHome } from "../src/adapter-paths.mjs";
import {
  cursorHookCommand, disableCursorAdapter, enableCursorAdapter,
  readCursorAdapterStatus, removeCursorAdapterInstallation,
} from "../src/config.mjs";
import { writeCursorRuntimeObservation } from "../src/runtime-observation.mjs";

const events = ["sessionStart", "beforeSubmitPrompt", "preCompact", "afterAgentResponse", "stop"];
const agentSource = "---\nname: memorax-repo-memory\nmodel: inherit\nis_background: true\n---\n\n<!-- memorax-code-cursor-repo-memory-agent-v1 -->\n\nAgent fixture.\n";

test("Cursor discovery honors home overrides, existing data, and platform installations", () => {
  const home = join(tmpdir(), "cursor-discovery");
  assert.equal(defaultCursorHome({}, home), join(home, ".cursor"));
  assert.equal(defaultCursorHome({ CURSOR_HOME: join(home, "custom") }, home), join(home, "custom"));
  assert.equal(cursorInstallationDetected({ env: {}, home, platform: "darwin",
    pathExists: path => path === "/Applications/Cursor.app" }), true);
  assert.equal(cursorInstallationDetected({ env: {}, home, platform: "linux",
    pathExists: path => path === join(home, ".cursor") }), true);
  assert.equal(cursorInstallationDetected({ env: {}, home, platform: "linux",
    pathExists: () => false }), false);
  assert.equal(cursorInstallationDetected({ env: { CURSOR_HOME: join(home, "custom") },
    pathExists: () => false }), true);
  assert.equal(cursorInstallationDetected({ env: { LOCALAPPDATA: "C:\\Users\\Test\\AppData\\Local" },
    platform: "win32", pathExists: path => path.endsWith("\\Programs\\cursor\\Cursor.exe") }), true);
});

test("Cursor installation owns only its Hook entries, shared Skill, and marked Repo Memory agent", async () => {
  const fixture = await createFixture();
  try {
    const installed = await enableCursorAdapter(fixture.options);
    assert.equal(installed.ok, true);
    assert.equal(installed.enabled, true);
    assert.equal(installed.cursorAgents.ok, true);
    assert.equal(installed.repoMemoryAgentPath, join(fixture.options.cursorHome, "agents", "memorax-repo-memory.md"));
    assert.equal(await readFile(installed.repoMemoryAgentPath, "utf8"), agentSource);
    assert.equal(installed.cursorHooks.configured, true);
    assert.equal(installed.cursorHooks.runtimeObserved, false);
    assert.equal(installed.globalHooksActivationRequired, undefined);
    assert.equal(await readFile(join(installed.skillPath, "SKILL.md"), "utf8"), "# Canonical Skill fixture\n");
    assert.deepEqual(JSON.parse(await readFile(join(installed.skillPath, ".memorax-code-package.json"), "utf8")), {
      version: 1, memoraxCodeHome: fixture.options.memoraxCodeHome, memoraxCodeCommand: fixture.options.memoraxCodeCommand,
    });
    const generationRoot = join(installed.installPath, "..");
    assert.equal(await readFile(join(generationRoot, "hooks", "repo-memory-job.mjs"), "utf8"), "// repo memory job fixture\n");
    assert.equal(await readFile(join(generationRoot, "agents", "memorax-repo-memory.md"), "utf8"), agentSource);
    assert.equal(await readFile(join(generationRoot, "src", "native-repo-memory.mjs"), "utf8"), "// native repo memory fixture\n");
    assert.deepEqual(JSON.parse(await readFile(join(generationRoot, "plugin.json"), "utf8")), {
      "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "memorax-code", description: "Persistent coding memory for Cursor.",
    });
    assert.equal(await readFile(join(generationRoot, "skills", "memorax-code", "SKILL.md"), "utf8"), "# Canonical Skill fixture\n");
    const hooks = await fixture.hooks();
    assert.equal(hooks.version, 1);
    assert.deepEqual(hooks.custom, { thirdPartyExtensibilityEnabled: true });
    assert.deepEqual(hooks.hooks.beforeSubmitPrompt[0], fixture.userHook);
    assert.deepEqual(hooks.hooks.preCompact[0], fixture.userCompactHook);
    assert.deepEqual(hooks.hooks.afterFileEdit, [{ command: "user-after-edit" }]);
    const state = JSON.parse(await readFile(installed.statePath, "utf8"));
    for (const event of events) {
      const managed = hooks.hooks[event].filter(hook => hook.command === state.hookCommand);
      assert.equal(managed.length, 1);
      assert.equal(managed[0].type, "command");
      assert.equal(managed[0].hooks, undefined);
    }
    assert.equal((await enableCursorAdapter(fixture.options)).changed, false);
    const skillMetadataPath = join(installed.skillPath, ".memorax-code-package.json");
    await writeFile(skillMetadataPath, JSON.stringify({ version: 1, memoraxCodeCommand: fixture.options.memoraxCodeCommand }));
    assert.equal((await readCursorAdapterStatus(fixture.options)).cursorSkills.ok, false);
    assert.equal((await enableCursorAdapter(fixture.options)).changed, true);
    assert.equal(JSON.parse(await readFile(skillMetadataPath, "utf8")).memoraxCodeHome, fixture.options.memoraxCodeHome);
    assert.equal((await enableCursorAdapter(fixture.options)).changed, false);
    await rm(generationRoot, { recursive: true });
    await writeFile(installed.statePath, JSON.stringify({ ...state, enabled: false, installPending: true }));
    assert.equal((await enableCursorAdapter(fixture.options)).enabled, true);
    await writeCursorRuntimeObservation({ memoraxCodeHome: fixture.options.memoraxCodeHome,
      cursorHome: fixture.options.cursorHome, runtimeDigest: state.runtimeDigest });
    assert.equal((await readCursorAdapterStatus(fixture.options)).cursorHooks.runtimeObserved, true);

    const unrelated = join(fixture.options.cursorHome, "skills", "user-skill", "SKILL.md");
    await mkdir(join(fixture.options.cursorHome, "skills", "user-skill"), { recursive: true });
    await writeFile(unrelated, "user skill");
    const unrelatedAgent = join(fixture.options.cursorHome, "agents", "user-agent.md");
    await writeFile(unrelatedAgent, "user agent");
    assert.equal((await disableCursorAdapter(fixture.options)).enabled, false);
    assert.deepEqual((await fixture.hooks()).hooks, {
      beforeSubmitPrompt: [fixture.userHook], preCompact: [fixture.userCompactHook], afterFileEdit: [{ command: "user-after-edit" }],
    });
    assert.equal(await readFile(join(installed.skillPath, "SKILL.md"), "utf8"), "# Canonical Skill fixture\n");
    assert.equal(await readFile(installed.repoMemoryAgentPath, "utf8"), agentSource);
    assert.equal((await removeCursorAdapterInstallation(fixture.options)).removed, true);
    await assert.rejects(readFile(join(installed.skillPath, "SKILL.md")), /ENOENT/);
    await assert.rejects(readFile(installed.repoMemoryAgentPath), /ENOENT/);
    assert.equal(await readFile(unrelated, "utf8"), "user skill");
    assert.equal(await readFile(unrelatedAgent, "utf8"), "user agent");
    assert.equal((await readCursorAdapterStatus(fixture.options)).managed, false);
  } finally { await fixture.close(); }
});

test("Cursor readiness rejects incomplete or altered immutable runtime generations", async (t) => {
  const cases = [
    ["missing shared runtime", "memorax-code-adapter-common/src/common.mjs", "missing"],
    ["missing database resolver", "src/native-database-path.mjs", "missing"],
    ["modified Hook", "hooks/runtime-hook.mjs", "modified"],
    ["modified plugin manifest", "plugin.json", "modified"],
    ["modified recovery metadata", ".memorax-code-package.json", "metadata"],
    ["modified retained database path", ".memorax-code-package.json", "database-path"],
    ["symlinked shared runtime", "memorax-code-adapter-common/src", "symlink"],
  ];
  for (const [name, relativePath, mutation] of cases) await t.test(name, async () => {
    const fixture = await createFixture();
    try {
      const installed = await enableCursorAdapter(fixture.options);
      assert.equal(installed.enabled, true);
      const state = JSON.parse(await readFile(installed.statePath, "utf8"));
      const target = join(state.runtimeRoot, state.runtimeDigest, relativePath);
      const contentPath = mutation === "symlink" ? join(target, "common.mjs") : target;
      const original = await readFile(contentPath, "utf8");
      if (mutation === "missing") await rm(target);
      else if (mutation === "symlink") {
        const replacement = join(fixture.root, "replacement");
        await rename(target, replacement);
        await symlink(replacement, target, process.platform === "win32" ? "junction" : "dir");
      } else if (mutation === "metadata" || mutation === "database-path") {
        const replacement = mutation === "metadata"
          ? { memoraxCodeCommand: "replaced-command" }
          : { databasePath: join(fixture.root, "replaced-profile", "state.vscdb") };
        await writeFile(target, JSON.stringify({ ...JSON.parse(original), ...replacement }));
      } else await writeFile(target, original + "\n// modified deployed artifact\n");
      const mutatedContent = mutation === "missing" ? undefined : await readFile(contentPath, "utf8");
      const status = await readCursorAdapterStatus(fixture.options);
      assert.equal(status.installed, false);
      assert.equal(status.enabled, false);
      assert.equal(status.current, false);
      assert.equal(status.reason, "artifacts_missing");
      const hooksBefore = await fixture.hooks();
      const stateBefore = await readFile(installed.statePath, "utf8");
      const generationsBefore = await readdir(state.runtimeRoot);
      const repeated = await enableCursorAdapter(fixture.options);
      assert.equal(repeated.ok, false);
      assert.equal(repeated.enabled, false);
      assert.equal(repeated.failure.failureReason, "invalid_record");
      assert.deepEqual(await fixture.hooks(), hooksBefore);
      assert.equal(await readFile(installed.statePath, "utf8"), stateBefore);
      assert.deepEqual(await readdir(state.runtimeRoot), generationsBefore);
      if (mutation === "missing") await assert.rejects(readFile(target), /ENOENT/);
      else assert.equal(await readFile(contentPath, "utf8"), mutatedContent);
    } finally { await fixture.close(); }
  });
});

test("Cursor readiness requires every managed Hook's installed timeout", async () => {
  const fixture = await createFixture();
  try {
    const installed = await enableCursorAdapter(fixture.options);
    const state = JSON.parse(await readFile(installed.statePath, "utf8"));
    const expectedTimeout = (await fixture.hooks()).hooks.stop.at(-1).timeout;
    for (const timeout of [undefined, 15, expectedTimeout + 1]) {
      const manifest = await fixture.hooks();
      const managed = manifest.hooks.stop.find(hook => hook.command === state.hookCommand);
      if (timeout === undefined) delete managed.timeout;
      else managed.timeout = timeout;
      await writeFile(join(fixture.options.cursorHome, "hooks.json"), JSON.stringify(manifest));
      const status = await readCursorAdapterStatus(fixture.options);
      assert.equal(status.installed, true);
      assert.equal(status.enabled, false);
      assert.equal(status.current, false);
      assert.equal(status.cursorHooks.configured, false);
      assert.equal(status.reason, "hooks_not_configured");
      const repaired = await enableCursorAdapter(fixture.options);
      assert.equal(repaired.enabled, true);
      assert.equal(repaired.changed, true);
      const hooks = await fixture.hooks();
      for (const event of events) assert.equal(hooks.hooks[event].at(-1).timeout, expectedTimeout);
      assert.deepEqual(hooks.hooks.beforeSubmitPrompt[0], fixture.userHook);
      assert.deepEqual(hooks.hooks.preCompact[0], fixture.userCompactHook);
    }
  } finally { await fixture.close(); }
});

test("Cursor agent updates change immutable runtime identity and repair a missing managed agent", async () => {
  const fixture = await createFixture();
  try {
    const installed = await enableCursorAdapter(fixture.options);
    const first = JSON.parse(await readFile(installed.statePath, "utf8"));
    const nextSource = `${agentSource}\nUpdated instructions.\n`.replaceAll("\n", "\r\n");
    await writeFile(fixture.options.repoMemoryAgentSourcePath, nextSource);
    const updated = await enableCursorAdapter(fixture.options);
    const next = JSON.parse(await readFile(updated.statePath, "utf8"));
    assert.equal(updated.changed, true);
    assert.notEqual(next.runtimeDigest, first.runtimeDigest);
    assert.notEqual(next.repoMemoryAgentDigest, first.repoMemoryAgentDigest);
    assert.equal(await readFile(join(first.runtimeRoot, first.runtimeDigest, "agents", "memorax-repo-memory.md"), "utf8"), agentSource);
    assert.equal(await readFile(updated.repoMemoryAgentPath, "utf8"), nextSource);
    await rm(updated.repoMemoryAgentPath);
    assert.equal((await readCursorAdapterStatus(fixture.options)).enabled, false);
    assert.equal((await enableCursorAdapter(fixture.options)).enabled, true);
    assert.equal(await readFile(updated.repoMemoryAgentPath, "utf8"), nextSource);
  } finally { await fixture.close(); }
});

test("Cursor upgrades pre-agent state without retaining standalone Agent CLI selection", async () => {
  const fixture = await createFixture();
  const previousCommand = process.env.MEMORAX_CODE_CURSOR_AGENT_COMMAND;
  try {
    const installed = await enableCursorAdapter(fixture.options);
    const state = JSON.parse(await readFile(installed.statePath, "utf8"));
    await rm(state.repoMemoryAgentPath);
    delete state.repoMemoryAgentPath;
    delete state.repoMemoryAgentDigest;
    const generationPath = join(state.runtimeRoot, state.runtimeDigest);
    const legacyDigest = "a".repeat(64);
    const legacyGenerationPath = join(state.runtimeRoot, legacyDigest);
    await rm(join(generationPath, "agents", "memorax-repo-memory.md"));
    await rename(generationPath, legacyGenerationPath);
    state.runtimeDigest = legacyDigest;
    state.runtimePath = join(legacyGenerationPath, "hooks", "runtime-hook.mjs");
    state.hookCommand = cursorHookCommand(state.runtimePath);
    await writeFile(installed.statePath, JSON.stringify(state));
    const metadataPath = join(legacyGenerationPath, ".memorax-code-package.json");
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    await writeFile(metadataPath, JSON.stringify({ ...metadata, cursorAgentCommand: "old-cursor-agent" }));
    process.env.MEMORAX_CODE_CURSOR_AGENT_COMMAND = "unused-cursor-agent";
    const updated = await enableCursorAdapter({ ...fixture.options, cursorAgentCommand: "also-unused" });
    assert.equal(updated.enabled, true);
    assert.equal(updated.changed, true);
    assert.equal(updated.cursorAgents.ok, true);
    const nextState = JSON.parse(await readFile(updated.statePath, "utf8"));
    assert.notEqual(nextState.runtimeDigest, legacyDigest);
    const nextMetadata = JSON.parse(await readFile(join(nextState.runtimeRoot, nextState.runtimeDigest, ".memorax-code-package.json"), "utf8"));
    assert.equal(nextMetadata.cursorAgentCommand, undefined);
    assert.equal(nextState.repoMemoryAgentPath, installed.repoMemoryAgentPath);
  } finally {
    if (previousCommand === undefined) delete process.env.MEMORAX_CODE_CURSOR_AGENT_COMMAND;
    else process.env.MEMORAX_CODE_CURSOR_AGENT_COMMAND = previousCommand;
    await fixture.close();
  }
});

test("Cursor preserves user agent collisions and replacements during install and removal", async () => {
  const fixture = await createFixture();
  try {
    const target = join(fixture.options.cursorHome, "agents", "memorax-repo-memory.md");
    await mkdir(join(fixture.options.cursorHome, "agents"), { recursive: true });
    await writeFile(target, "user-owned agent");
    const before = await fixture.hooks();
    const collision = await enableCursorAdapter(fixture.options);
    assert.equal(collision.reason, "agent_conflict");
    assert.equal(collision.failure.failureReason, "conflict");
    assert.deepEqual(await fixture.hooks(), before);
    assert.equal(await readFile(target, "utf8"), "user-owned agent");
    await rm(target);
    const installed = await enableCursorAdapter(fixture.options);
    await writeFile(target, "user replacement without managed marker");
    assert.equal((await readCursorAdapterStatus(fixture.options)).cursorAgents.ok, false);
    assert.equal((await enableCursorAdapter(fixture.options)).reason, "agent_conflict");
    const removed = await removeCursorAdapterInstallation(fixture.options);
    assert.equal(removed.removed, true);
    assert.equal(removed.preservedAgentPath, target);
    assert.equal(await readFile(target, "utf8"), "user replacement without managed marker");
    await assert.rejects(readFile(installed.statePath), /ENOENT/);
  } finally { await fixture.close(); }
});

test("Cursor does not take ownership of an agent symlink or a file with only a copied marker", async () => {
  const fixture = await createFixture();
  try {
    const target = join(fixture.options.cursorHome, "agents", "memorax-repo-memory.md");
    await mkdir(join(fixture.options.cursorHome, "agents"), { recursive: true });
    await writeFile(target, agentSource);
    assert.equal((await enableCursorAdapter(fixture.options)).reason, "agent_conflict");
    await rm(target);
    await symlink(fixture.options.repoMemoryAgentSourcePath, target);
    assert.equal((await enableCursorAdapter(fixture.options)).reason, "agent_conflict");
    assert.equal(await readFile(fixture.options.repoMemoryAgentSourcePath, "utf8"), agentSource);
  } finally { await fixture.close(); }
});

test("Cursor generations retain recovery paths without rewriting an older runtime", async () => {
  const fixture = await createFixture();
  try {
    const first = await enableCursorAdapter(fixture.options);
    const state = JSON.parse(await readFile(first.statePath, "utf8"));
    const oldRuntime = await readFile(state.runtimePath, "utf8");
    await writeFile(fixture.options.runtimeHookSourcePath, "// newer package runtime fixture\n");
    assert.equal((await readCursorAdapterStatus(fixture.options)).enabled, true);
    const movedCommand = join(fixture.root, "moved-cli.mjs");
    await writeFile(movedCommand, "// never executed\n");
    const changed = await enableCursorAdapter({ ...fixture.options, memoraxCodeCommand: movedCommand });
    const next = JSON.parse(await readFile(changed.statePath, "utf8"));
    assert.notEqual(next.runtimeDigest, state.runtimeDigest);
    assert.equal(await readFile(state.runtimePath, "utf8"), oldRuntime);
    assert.equal(changed.changed, true);
    assert.equal((await enableCursorAdapter({ ...fixture.options, memoraxCodeCommand: movedCommand })).changed, false);
  } finally { await fixture.close(); }
});

test("Cursor generations retain an explicit database path and reject invalid replacements", async () => {
  const fixture = await createFixture();
  const previousDatabasePath = process.env.MEMORAX_CODE_CURSOR_DATABASE_PATH;
  try {
    const databasePath = join(fixture.root, "native-profile", "state.vscdb");
    process.env.MEMORAX_CODE_CURSOR_DATABASE_PATH = databasePath;
    const installed = await enableCursorAdapter(fixture.options);
    assert.equal(installed.ok, true);
    const state = JSON.parse(await readFile(installed.statePath, "utf8"));
    const metadataPath = join(state.runtimeRoot, state.runtimeDigest, ".memorax-code-package.json");
    assert.equal(JSON.parse(await readFile(metadataPath, "utf8")).databasePath, databasePath);
    delete process.env.MEMORAX_CODE_CURSOR_DATABASE_PATH;
    assert.equal((await enableCursorAdapter(fixture.options)).changed, false);
    process.env.MEMORAX_CODE_CURSOR_DATABASE_PATH = "relative.vscdb";
    assert.equal((await enableCursorAdapter(fixture.options)).reason, "database_path_invalid");
    assert.equal(JSON.parse(await readFile(installed.statePath, "utf8")).runtimeDigest, state.runtimeDigest);
    process.env.MEMORAX_CODE_CURSOR_DATABASE_PATH = join(fixture.root, "next-profile", "state.vscdb");
    assert.equal((await enableCursorAdapter(fixture.options)).changed, true);
    assert.equal(JSON.parse(await readFile(metadataPath, "utf8")).databasePath, databasePath);
    process.env.MEMORAX_CODE_CURSOR_DATABASE_PATH = "invalid-cleanup-override";
    assert.equal((await disableCursorAdapter(fixture.options)).ok, true);
    assert.equal((await removeCursorAdapterInstallation(fixture.options)).removed, true);
  } finally {
    if (previousDatabasePath === undefined) delete process.env.MEMORAX_CODE_CURSOR_DATABASE_PATH;
    else process.env.MEMORAX_CODE_CURSOR_DATABASE_PATH = previousDatabasePath;
    await fixture.close();
  }
});

test("Cursor lifecycle retains a recorded custom home when a later command omits the override", async () => {
  const fixture = await createFixture();
  const previousHome = process.env.CURSOR_HOME;
  try {
    delete process.env.CURSOR_HOME;
    const installed = await enableCursorAdapter(fixture.options);
    assert.equal(installed.enabled, true);
    const options = { ...fixture.options, cursorHome: undefined };
    assert.equal((await readCursorAdapterStatus(options)).cursorHome, fixture.options.cursorHome);
    assert.equal((await enableCursorAdapter(options)).changed, false);
    process.env.CURSOR_HOME = join(fixture.root, "conflicting-home");
    assert.equal((await disableCursorAdapter(options)).reason, "state_paths_invalid");
    delete process.env.CURSOR_HOME;
    assert.equal((await disableCursorAdapter(options)).ok, true);
    assert.equal((await removeCursorAdapterInstallation(options)).removed, true);
  } finally {
    if (previousHome === undefined) delete process.env.CURSOR_HOME;
    else process.env.CURSOR_HOME = previousHome;
    await fixture.close();
  }
});

test("Cursor command quoting and marker cleanup support POSIX and encoded Windows launchers", async () => {
  assert.equal(cursorHookCommand("/tmp/$runtime/$(touch marker)/runtime's.mjs", "linux", "/node's"),
    "'/node'\\''s' '/tmp/$runtime/$(touch marker)/runtime'\\''s.mjs' --memorax-code-cursor-hook-v1");
  const command = cursorHookCommand("C:\\Users\\Test User\\runtime.mjs", "win32", "C:\\Program Files\\node.exe");
  const encoded = / -EncodedCommand ([A-Za-z0-9+/=]+)$/.exec(command)?.[1];
  assert.ok(encoded);
  const script = Buffer.from(encoded, "base64").toString("utf16le");
  assert.match(script, /--memorax-code-cursor-hook-v1/);
  assert.match(script, /RedirectStandardInput=\$true/);
  const fixture = await createFixture();
  try {
    assert.equal((await enableCursorAdapter({ ...fixture.options, platform: "win32" })).ok, true);
    for (const event of events) assert.equal((await fixture.hooks()).hooks[event].at(-1).command.includes("-EncodedCommand"), true);
    assert.equal((await disableCursorAdapter(fixture.options)).ok, true);
    assert.deepEqual((await fixture.hooks()).hooks.beforeSubmitPrompt, [fixture.userHook]);
  } finally { await fixture.close(); }
});

test("Cursor install rejects unmanaged Skills and malformed or unknown-version manifests", async () => {
  const fixture = await createFixture();
  try {
    const target = join(fixture.options.cursorHome, "skills", "memorax-code");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "SKILL.md"), "user-owned");
    assert.equal((await enableCursorAdapter(fixture.options)).reason, "skill_conflict");
    assert.equal(await readFile(join(target, "SKILL.md"), "utf8"), "user-owned");
    await rm(target, { recursive: true });
    for (const content of ["{ broken", '{"version":2,"hooks":{}}', '{"version":1,"hooks":{"stop":{}}}', '{"version":1,"hooks":{"preCompact":{}}}']) {
      await writeFile(join(fixture.options.cursorHome, "hooks.json"), content);
      const result = await enableCursorAdapter(fixture.options);
      assert.equal(result.reason, "hooks_invalid");
      assert.equal(result.failure.failureReason, "invalid_configuration");
      assert.equal(await readFile(join(fixture.options.cursorHome, "hooks.json"), "utf8"), content);
    }
  } finally { await fixture.close(); }
});

test("Cursor lifecycle waits for its cross-process lock before changing user configuration", async () => {
  const fixture = await createFixture();
  let release;
  let holder;
  let install;
  try {
    let locked;
    const ready = new Promise(resolve => { locked = resolve; });
    const pending = new Promise(resolve => { release = resolve; });
    holder = withJsonFileLockAsync(fixture.options.lifecycleLockTarget, async () => {
      locked(); await pending;
    });
    await ready;
    const before = await fixture.hooks();
    install = enableCursorAdapter(fixture.options);
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.deepEqual(await fixture.hooks(), before);
    release();
    await holder;
    assert.equal((await install).enabled, true);
  } finally {
    release?.();
    await Promise.allSettled([holder, install].filter(Boolean));
    await fixture.close();
  }
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-cursor-config-"));
  const cursorHome = join(root, "Cursor Home");
  const source = join(root, "source");
  const options = {
    cursorHome, memoraxCodeHome: join(root, "state"),
    lifecycleLockTarget: join(root, "locks", "cursor-lifecycle"),
    runtimeHookSourcePath: join(source, "runtime-hook.mjs"),
    repoMemoryJobSourcePath: join(source, "repo-memory-job.mjs"),
    repoMemoryAgentSourcePath: join(source, "memorax-repo-memory.md"),
    nativeRepoMemorySourcePath: join(source, "native-repo-memory.mjs"),
    runtimeObservationSourcePath: join(source, "runtime-observation.mjs"),
    commonSourcePath: join(source, "common"), skillSourcePath: join(source, "skill"),
    memoraxCodeCommand: join(source, "cli.mjs"),
  };
  await Promise.all([cursorHome, options.commonSourcePath, options.skillSourcePath]
    .map(path => mkdir(path, { recursive: true })));
  await Promise.all([
    writeFile(options.runtimeHookSourcePath, "// runtime fixture\n"),
    writeFile(options.repoMemoryJobSourcePath, "// repo memory job fixture\n"),
    writeFile(options.repoMemoryAgentSourcePath, agentSource),
    writeFile(options.nativeRepoMemorySourcePath, "// native repo memory fixture\n"),
    writeFile(options.runtimeObservationSourcePath, "// observation fixture\n"),
    writeFile(options.memoraxCodeCommand, "// never executed\n"),
    writeFile(join(options.commonSourcePath, "common.mjs"), "// shared runtime\n"),
    writeFile(join(options.skillSourcePath, "SKILL.md"), "# Canonical Skill fixture\n"),
  ]);
  const userHook = { command: "user-command", matcher: "UserPromptSubmit", timeout: 5 };
  const userCompactHook = { command: "user-compact-command", timeout: 5 };
  await writeFile(join(cursorHome, "hooks.json"), JSON.stringify({
    version: 1, custom: { thirdPartyExtensibilityEnabled: true },
    hooks: { beforeSubmitPrompt: [userHook], preCompact: [userCompactHook], afterFileEdit: [{ command: "user-after-edit" }] },
  }));
  return { root, options, userHook, userCompactHook,
    hooks: async () => JSON.parse(await readFile(join(cursorHome, "hooks.json"), "utf8")),
    close: () => rm(root, { recursive: true, force: true }),
  };
}
