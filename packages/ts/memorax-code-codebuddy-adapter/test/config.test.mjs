import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs, { cp, mkdir, mkdtemp, readFile, realpath, rm, stat, utimes, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  defaultCodeBuddyHome,
  defaultWorkBuddyHome,
  readManagedCodeBuddyTarget,
  resolveCodeBuddyClientSelection,
  disableCodeBuddyAdapter,
  enableCodeBuddyAdapter,
  knownMarketplacesPath,
  marketplaceRoot,
  readCodeBuddyAdapterStatus,
  removeCodeBuddyPluginInstallation,
  codeBuddySettingsPath,
  codeBuddyInstallPath,
} from "../src/config.mjs";
import { codeBuddyHookCommand, codeBuddyUserPromptHookCommand } from "../src/hook-manifest.mjs";
import { writeCodeBuddyRuntimeObservation } from "../src/runtime-observation.mjs";
import { resolveHookCodeBuddyCommand } from "../../memorax-code-adapter-common/src/clients/codebuddy-command.mjs";

test("selects independent native homes and command overrides", () => {
  for (const [platform, home, pathJoin] of [[process.platform, join(tmpdir(), "buddy-discovery-home"), join], ["win32", "C:\\Users\\tester", win32.join]]) {
    const cliHome = pathJoin(home, ".codebuddy");
    const workBuddyHome = pathJoin(home, ".workbuddy");
    assert.equal(defaultCodeBuddyHome({ WORKBUDDY_HOME: "/other/workbuddy" }, home, platform), cliHome);
    assert.equal(defaultWorkBuddyHome({ CODEBUDDY_HOME: "/other/codebuddy" }, home, platform), workBuddyHome);
    assert.equal(defaultCodeBuddyHome({ CODEBUDDY_CONFIG_DIR: "/native/cli" }, home, platform), "/native/cli");
    assert.equal(defaultWorkBuddyHome({ WORKBUDDY_HOME: "/native/workbuddy" }, home, platform), "/native/workbuddy");
  }
  const env = { MEMORAX_CODE_CODEBUDDY_COMMAND: "/cli", MEMORAX_CODE_WORKBUDDY_COMMAND: "/app" };
  assert.equal(resolveHookCodeBuddyCommand({ env, client: "codebuddy" }), "/cli");
  assert.equal(resolveHookCodeBuddyCommand({ env, client: "workbuddy" }), "/app");
  assert.equal(resolveHookCodeBuddyCommand({ env: { WORKBUDDY_CODEBUDDY_PATH: "/app" }, client: "codebuddy" }), "codebuddy");
  assert.throws(() => resolveHookCodeBuddyCommand({ env: { CODEBUDDY_CLI_PATH: "/cli" }, client: "workbuddy", platform: "linux", pathExists: () => false }), /WorkBuddy runtime is unavailable/);
});

test("distinguishes WorkBuddy's compatibility config alias from independent CLI overrides", () => {
  for (const [platform, home, pathJoin] of [["darwin", "/fixture-user", join], ["linux", "/fixture-user", join], ["win32", "C:\\Users\\tester", win32.join]]) {
    const cliHome = pathJoin(home, ".codebuddy");
    const nativeHome = pathJoin(home, "workbuddy-config");
    const alias = platform === "win32" ? `${nativeHome.toUpperCase().replaceAll("\\", "/")}/.` : `${nativeHome}/.`;
    const env = { CODEBUDDY_CONFIG_DIR: alias, WORKBUDDY_CONFIG_DIR: nativeHome };
    assert.equal(defaultCodeBuddyHome(env, home, platform), cliHome);
    assert.equal(defaultWorkBuddyHome(env, home, platform), nativeHome);
    assert.equal(defaultCodeBuddyHome({ CODEBUDDY_CONFIG_DIR: nativeHome }, home, platform), nativeHome);
    assert.equal(defaultCodeBuddyHome({ ...env, CODEBUDDY_CONFIG_DIR: cliHome }, home, platform), cliHome);
    assert.equal(defaultCodeBuddyHome({ ...env, CODEBUDDY_HOME: nativeHome }, home, platform), nativeHome);
    assert.equal(defaultWorkBuddyHome({ ...env, WORKBUDDY_HOME: cliHome }, home, platform), cliHome);
  }
});

test("installs and reuses separate client targets from WorkBuddy's inherited environment", async (t) => {
  const profile = await realpath(await mkdtemp(join(tmpdir(), "memorax-workbuddy-environment-")));
  t.after(() => rm(profile, { recursive: true, force: true }));
  const cliHome = join(profile, ".codebuddy");
  const workBuddyHome = join(profile, ".workbuddy");
  const memoraxCodeHome = join(profile, ".memorax-code");
  const env = { ...process.env, HOME: profile, USERPROFILE: profile, MEMORAX_CODE_HOME: memoraxCodeHome,
    CODEBUDDY_HOME: "", WORKBUDDY_HOME: "", CODEBUDDY_CONFIG_DIR: workBuddyHome, WORKBUDDY_CONFIG_DIR: workBuddyHome,
    MEMORAX_CODE_CODEBUDDY_COMMAND: "fixture-cli", MEMORAX_CODE_WORKBUDDY_COMMAND: "fixture-workbuddy",
  };
  const cli = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
  for (let attempt = 0; attempt < 2; attempt += 1) {
    for (const [client, home] of [["codebuddy", cliHome], ["workbuddy", workBuddyHome]]) {
      const result = spawnSync(process.execPath, [cli, "enable", "--client", client, "--json"], {
        cwd: profile, env, encoding: "utf8", timeout: 15_000,
      });
      assert.equal(result.status, 0, result.stderr);
      const report = JSON.parse(result.stdout);
      assert.equal(report.codeBuddyHome, home);
      assert.equal(report.enabled, true);
      const retained = JSON.parse(await readFile(join(memoraxCodeHome, "adapters", client, "installation.json"), "utf8"));
      assert.equal(retained.client, client);
      assert.equal(retained.codeBuddyHome, home);
      const metadata = JSON.parse(await readFile(join(codeBuddyInstallPath(home), ".memorax-code-package.json"), "utf8"));
      assert.equal(metadata.client, client);
      assert.equal(metadata.codeBuddyHome, home);
    }
  }
});

test("builds a native Windows Hook command without the WorkBuddy root placeholder", () => {
  assert.equal(
    codeBuddyHookCommand("C:\\Users\\tester\\.codebuddy\\plugins\\memorax", "win32"),
    'node "C:/Users/tester/.codebuddy/plugins/memorax/hooks/runtime-hook.mjs" turn',
  );
  assert.equal(
    codeBuddyUserPromptHookCommand("C:\\Users\\Test User\\.workbuddy\\plugins\\memorax", "win32"),
    'node "C:/Users/Test User/.workbuddy/plugins/memorax/hooks/runtime-hook.mjs" managed-user-prompt',
  );
});

test("quotes the absolute global Hook path for a POSIX shell", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-codebuddy-quoted-"));
  const pluginRoot = join(root, "user's space $home", "memorax-code-codebuddy-adapter");
  await mkdir(join(pluginRoot, "hooks"), { recursive: true });
  await writeFile(join(pluginRoot, "hooks", "runtime-hook.mjs"), "process.stdout.write(process.argv[2]);\n");
  const result = spawnSync("/bin/sh", ["-c", codeBuddyUserPromptHookCommand(pluginRoot)], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "managed-user-prompt");
});

test("finds WorkBuddy's bare Windows CLI for Repo Memory jobs", () => {
  const command = "C:\\Users\\tester\\AppData\\Local\\Programs\\WorkBuddy\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy";
  assert.equal(resolveHookCodeBuddyCommand({
    client: "workbuddy",
    env: { LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local" },
    platform: "win32",
    pathExists: (candidate) => candidate === command,
  }), command);
});

test("derives the install cache version from the CodeBuddy plugin manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-codebuddy-version-"));
  const adapterRoot = join(root, "memorax-code-codebuddy-adapter");
  const configPath = join(adapterRoot, "src", "config.mjs");
  const hookManifestPath = join(adapterRoot, "src", "hook-manifest.mjs");
  const runtimeObservationPath = join(adapterRoot, "src", "runtime-observation.mjs");
  const commandPath = join(root, "memorax-code-adapter-common", "src", "clients", "codebuddy-command.mjs");
  await mkdir(join(adapterRoot, "src"), { recursive: true });
  await mkdir(join(adapterRoot, ".codebuddy-plugin"), { recursive: true });
  await mkdir(join(root, "memorax-code-adapter-common", "src", "clients"), { recursive: true });
  await cp(new URL("../src/config.mjs", import.meta.url), configPath);
  await cp(new URL("../src/hook-manifest.mjs", import.meta.url), hookManifestPath);
  await cp(new URL("../src/runtime-observation.mjs", import.meta.url), runtimeObservationPath);
  await cp(new URL("../../memorax-code-adapter-common/src/clients/codebuddy-command.mjs", import.meta.url), commandPath);
  await cp(
    new URL("../../memorax-code-adapter-common/src/deployment-failure.mjs", import.meta.url),
    join(root, "memorax-code-adapter-common", "src", "deployment-failure.mjs"),
  );
  await cp(
    new URL("../../memorax-code-adapter-common/src/config-utils.mjs", import.meta.url),
    join(root, "memorax-code-adapter-common", "src", "config-utils.mjs"),
  );
  await cp(
    new URL("../../memorax-code-adapter-common/src/runtime-record.mjs", import.meta.url),
    join(root, "memorax-code-adapter-common", "src", "runtime-record.mjs"),
  );
  await cp(
    new URL("../../memorax-code-adapter-common/src/file-tree-match.mjs", import.meta.url),
    join(root, "memorax-code-adapter-common", "src", "file-tree-match.mjs"),
  );
  await writeFile(join(adapterRoot, ".codebuddy-plugin", "plugin.json"), '{"version":"9.8.7"}\n');
  const isolated = await import(pathToFileURL(configPath).href);
  assert.equal(isolated.codeBuddyInstallPath(join(root, "home")), join(
    root, "home", "plugins", "cache", "memorax-code-local", "memorax-code-codebuddy-adapter", "9.8.7",
  ));
});

test("installs and removes an isolated CodeBuddy plugin registry entry", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-codebuddy-"));
  const memoraxCodeHome = await mkdtemp(join(tmpdir(), "memorax-code-home-"));
  await mkdir(join(home, "plugins"), { recursive: true });
  await mkdir(join(home, "skills", "user-skill"), { recursive: true });
  await writeFile(join(home, "skills", "user-skill", "SKILL.md"), "user-owned\n");
  const userPromptGroup = { matcher: "*", hooks: [
    { type: "command", command: "echo user-prompt" },
    { type: "command", command: "echo managed-user-prompt" },
  ] };
  const userSessionStart = [{ hooks: [{ type: "command", command: "echo user-session" }] }];
  await writeFile(codeBuddySettingsPath(home), JSON.stringify({ hooks: {
    SessionStart: userSessionStart,
    UserPromptSubmit: [userPromptGroup, { hooks: [{ type: "command", command: codeBuddyUserPromptHookCommand("/old/memorax-code-codebuddy-adapter") }] }],
  } }));
  await writeFile(join(home, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: {
    "user-plugin@user-marketplace": [{ scope: "user", installPath: "/user/plugin", enabled: true }],
  }}));
  const enabled = await enableCodeBuddyAdapter({ codeBuddyHome: home, platform: "win32" });
  assert.equal(enabled.ok, true);
  const enabledStatus = await readCodeBuddyAdapterStatus({
    codeBuddyHome: home,
    memoraxCodeHome,
    platform: "win32",
  });
  assert.equal(enabledStatus.enabled, true);
  assert.equal(enabledStatus.marketplaceReady, true);
  assert.equal(enabledStatus.codebuddySkills.ok, true);
  assert.equal(enabledStatus.codebuddySkills.memoraxCode, true);
  assert.equal(enabledStatus.codebuddyHooks.ok, true);
  assert.equal(enabledStatus.codebuddyHooks.status, "unverified");
  assert.equal(await exists(enabledStatus.codebuddySkills.path), true);
  const installedMetadata = JSON.parse(await readFile(join(codeBuddyInstallPath(home), ".memorax-code-package.json"), "utf8"));
  assert.equal(typeof installedMetadata.codeBuddyCommand, "string");
  assert.match(installedMetadata.memoraxCodeCommand, /memorax-code\.mjs$/);
  assert.equal(installedMetadata.codeBuddyHome, home);
  assert.equal(await exists(join(codeBuddyInstallPath(home), "memorax-code-adapter-common", "src", "repo-memory", "repo-memory-job-supervisor.mjs")), true);
  const pluginManifest = JSON.parse(await readFile(join(marketplaceRoot(home), "plugins", "memorax-code-codebuddy-adapter", ".codebuddy-plugin", "plugin.json"), "utf8"));
  assert.deepEqual(pluginManifest.skills, ["./skills/memorax-code"]);
  assert.equal(codeBuddyInstallPath(home), join(home, "plugins", "cache", "memorax-code-local", "memorax-code-codebuddy-adapter", pluginManifest.version));
  const registry = JSON.parse(await readFile(join(home, "plugins", "installed_plugins.json"), "utf8"));
  assert.equal(registry.version, 2);
  assert.ok(registry.plugins["user-plugin@user-marketplace"]);
  assert.equal(registry.plugins["memorax-code-codebuddy-adapter@memorax-code-local"][0].installPath, codeBuddyInstallPath(home));
  assert.equal(registry.plugins["memorax-code-codebuddy-adapter@memorax-code-local"][0].version, pluginManifest.version);
  const marketplace = JSON.parse(await readFile(join(marketplaceRoot(home), ".codebuddy-plugin", "marketplace.json"), "utf8"));
  assert.equal(marketplace.plugins[0].version, pluginManifest.version);
  const pluginRoot = join(marketplaceRoot(home), "plugins", "memorax-code-codebuddy-adapter");
  const hooksManifest = JSON.parse(await readFile(join(pluginRoot, "hooks", "hooks.json"), "utf8"));
  const expectedHookCommand = codeBuddyHookCommand(pluginRoot, "win32");
  for (const event of ["SessionStart", "Stop"]) {
    assert.equal(hooksManifest.hooks[event][0].hooks[0].command, expectedHookCommand);
    assert.doesNotMatch(hooksManifest.hooks[event][0].hooks[0].command, /CODEBUDDY_PLUGIN_ROOT/);
  }
  assert.equal(hooksManifest.hooks.UserPromptSubmit, undefined);
  const expectedPromptCommand = codeBuddyUserPromptHookCommand(pluginRoot, "win32");
  await writeCodeBuddyRuntimeObservation({
    memoraxCodeHome,
    codeBuddyHome: home,
    pluginRoot,
  });
  const observedStatus = await readCodeBuddyAdapterStatus({
    codeBuddyHome: home,
    memoraxCodeHome,
    platform: "win32",
  });
  assert.equal(observedStatus.codebuddyHooks.status, "observed");
  assert.equal(observedStatus.codebuddyHooks.runtimeObserved, true);
  const known = JSON.parse(await readFile(knownMarketplacesPath(home), "utf8"));
  assert.equal(known["memorax-code-local"].type, "directory");
  const settings = JSON.parse(await readFile(codeBuddySettingsPath(home), "utf8"));
  assert.equal(settings.enabledPlugins["memorax-code-codebuddy-adapter@memorax-code-local"], true);
  assert.deepEqual(settings.hooks, {
    SessionStart: userSessionStart,
    UserPromptSubmit: [userPromptGroup, { hooks: [{ type: "command", command: expectedPromptCommand, timeout: 15 }] }],
  });
  // Same-version installs replace both old plugin copies and keep one global prompt Hook.
  for (const installedRoot of [pluginRoot, codeBuddyInstallPath(home)]) {
    const oldManifest = JSON.parse(await readFile(join(installedRoot, "hooks", "hooks.json"), "utf8"));
    oldManifest.hooks.UserPromptSubmit = [{ hooks: [{ type: "command", command: codeBuddyHookCommand(installedRoot, "win32") }] }];
    await writeFile(join(installedRoot, "hooks", "hooks.json"), JSON.stringify(oldManifest));
  }
  await enableCodeBuddyAdapter({ codeBuddyHome: home, platform: "win32" });
  assert.deepEqual(JSON.parse(await readFile(codeBuddySettingsPath(home), "utf8")).hooks, settings.hooks);
  for (const installedRoot of [pluginRoot, codeBuddyInstallPath(home)]) {
    assert.equal(JSON.parse(await readFile(join(installedRoot, "hooks", "hooks.json"), "utf8")).hooks.UserPromptSubmit, undefined);
  }
  await disableCodeBuddyAdapter({ codeBuddyHome: home });
  const disabledStatus = await readCodeBuddyAdapterStatus({ codeBuddyHome: home, platform: "win32" });
  assert.equal(disabledStatus.enabled, false);
  assert.equal(disabledStatus.codebuddyHooks.ok, true);
  assert.equal(disabledStatus.marketplaceReady, true);
  assert.equal(disabledStatus.codebuddySkills.ok, true);
  const disabledSettings = JSON.parse(await readFile(codeBuddySettingsPath(home), "utf8"));
  assert.equal(disabledSettings.enabledPlugins["memorax-code-codebuddy-adapter@memorax-code-local"], false);
  assert.deepEqual(disabledSettings.hooks, { SessionStart: userSessionStart, UserPromptSubmit: [userPromptGroup] });
  await removeCodeBuddyPluginInstallation({ codeBuddyHome: home });
  const removedStatus = await readCodeBuddyAdapterStatus({ codeBuddyHome: home });
  assert.equal(removedStatus.installed, false);
  assert.equal(removedStatus.enabled, false);
  assert.equal(removedStatus.codebuddySkills.ok, false);
  const removedKnown = JSON.parse(await readFile(knownMarketplacesPath(home), "utf8"));
  assert.equal(removedKnown["memorax-code-local"], undefined);
  const removedSettings = JSON.parse(await readFile(codeBuddySettingsPath(home), "utf8"));
  assert.equal(removedSettings.enabledPlugins["memorax-code-codebuddy-adapter@memorax-code-local"], undefined);
  assert.deepEqual(removedSettings.hooks, disabledSettings.hooks);
  const removedRegistry = JSON.parse(await readFile(join(home, "plugins", "installed_plugins.json"), "utf8"));
  assert.ok(removedRegistry.plugins["user-plugin@user-marketplace"]);
  assert.equal(await exists(marketplaceRoot(home)), false);
  assert.equal(await readFile(join(home, "skills", "user-skill", "SKILL.md"), "utf8"), "user-owned\n");
});

test("retains each client target and never cleans up the other native home", async () => {
  const profile = await mkdtemp(join(tmpdir(), "memorax-codebuddy-independent-"));
  const workBuddyHome = join(profile, ".workbuddy");
  const cliHome = join(profile, ".codebuddy");
  const memoraxCodeHome = join(profile, ".memorax-code");
  const shared = { memoraxCodeHome, platform: "win32" };
  await enableCodeBuddyAdapter({ ...shared, codeBuddyHome: cliHome, codeBuddyCommand: "cli-runtime" });
  await enableCodeBuddyAdapter({ ...shared, client: "workbuddy", codeBuddyHome: workBuddyHome, codeBuddyCommand: "app-runtime" });
  assert.equal((await readManagedCodeBuddyTarget(shared)).codeBuddyHome, cliHome);
  assert.equal((await readManagedCodeBuddyTarget({ ...shared, client: "workbuddy" })).codeBuddyHome, workBuddyHome);
  assert.equal((await readCodeBuddyAdapterStatus(shared)).enabled, true);
  const workBuddy = await readCodeBuddyAdapterStatus({ ...shared, client: "workbuddy" });
  assert.equal(workBuddy.runtime, "workbuddy");
  assert.equal(workBuddy.enabled, true);
  assert.match(workBuddy.codebuddyHooks.observationPath, /workbuddy[/\\]runtime-observed.json$/);
  const metadata = JSON.parse(await readFile(join(codeBuddyInstallPath(workBuddyHome), ".memorax-code-package.json"), "utf8"));
  assert.equal(metadata.client, "workbuddy");
  assert.equal(metadata.codeBuddyHome, workBuddyHome);
  assert.equal(resolveHookCodeBuddyCommand({ pluginRoot: codeBuddyInstallPath(workBuddyHome), env: { MEMORAX_CODE_WORKBUDDY_COMMAND: "changed" } }), "app-runtime");
  await assert.rejects(() => enableCodeBuddyAdapter({ ...shared, client: "workbuddy", codeBuddyHome: cliHome, codeBuddyCommand: "app-runtime" }), /managed for codebuddy/);
  const wrongTarget = { ...shared, client: "workbuddy", codeBuddyHome: cliHome };
  assert.equal((await readCodeBuddyAdapterStatus(wrongTarget)).installed, false);
  assert.equal((await disableCodeBuddyAdapter(wrongTarget)).installed, false);
  assert.equal((await removeCodeBuddyPluginInstallation(wrongTarget)).removed, false);
  const targetRecordPath = join(memoraxCodeHome, "adapters", "workbuddy", "installation.json");
  const targetRecord = await readFile(targetRecordPath, "utf8");
  await writeFile(targetRecordPath, JSON.stringify({ ...JSON.parse(targetRecord), codeBuddyHome: cliHome }));
  await assert.rejects(() => disableCodeBuddyAdapter(wrongTarget), /conflicting workbuddy installation record/);
  await writeFile(targetRecordPath, targetRecord);
  assert.equal((await readCodeBuddyAdapterStatus(shared)).enabled, true);
  await disableCodeBuddyAdapter({ ...shared, client: "workbuddy" });
  assert.equal((await readCodeBuddyAdapterStatus(shared)).enabled, true);
  assert.equal((await readCodeBuddyAdapterStatus({ ...shared, client: "workbuddy" })).enabled, false);
  const workBuddyRemoval = await removeCodeBuddyPluginInstallation({ ...shared, client: "workbuddy" });
  assert.equal(workBuddyRemoval.action, "workbuddy-plugin-remove");
  assert.equal(await exists(marketplaceRoot(workBuddyHome)), false);
  assert.equal(await exists(marketplaceRoot(cliHome)), true);
  await removeCodeBuddyPluginInstallation(shared);
  assert.equal(await exists(marketplaceRoot(cliHome)), false);
});

test("removal clears a retained Windows-equivalent target spelling", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-codebuddy-remove-target-"));
  const nativeHome = join(root, "native-home");
  const options = { client: "workbuddy", memoraxCodeHome: join(root, "memorax"), codeBuddyHome: nativeHome, platform: "win32" };
  await enableCodeBuddyAdapter({ ...options, codeBuddyCommand: "fixture-workbuddy" });
  const targetPath = join(options.memoraxCodeHome, "adapters", "workbuddy", "installation.json");
  const retained = JSON.parse(await readFile(targetPath, "utf8"));
  // Vary only the persisted spelling so this Windows comparison runs on case-sensitive hosts too.
  await writeFile(targetPath, JSON.stringify({ ...retained, codeBuddyHome: join(root, "NATIVE-HOME") }));
  const removed = await removeCodeBuddyPluginInstallation(options);
  assert.equal(removed.removed, true);
  assert.equal(await exists(marketplaceRoot(nativeHome)), false);
  assert.equal(await exists(targetPath), false);
  assert.equal(await readManagedCodeBuddyTarget(options), undefined);
});

test("adapter CLI retains an absolute installation target across process cwd and environment changes", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "memorax-codebuddy-relative-target-")));
  const otherCwd = join(root, "other-cwd");
  await mkdir(otherCwd);
  const cli = new URL("../src/cli.mjs", import.meta.url);
  const env = { ...process.env, MEMORAX_CODE_HOME: join(root, "memorax"), MEMORAX_CODE_CODEBUDDY_COMMAND: "fixture-cli" };
  const enabled = spawnSync(process.execPath, [fileURLToPath(cli), "enable", "--codebuddy-home", "relative-native", "--json"], { cwd: root, env, encoding: "utf8" });
  assert.equal(enabled.status, 0, enabled.stderr);
  assert.equal(JSON.parse(enabled.stdout).codeBuddyHome, join(root, "relative-native"));
  const changedEnv = { ...env, CODEBUDDY_HOME: join(root, "changed-home"), MEMORAX_CODE_CODEBUDDY_COMMAND: "other-cli" };
  const status = spawnSync(process.execPath, [fileURLToPath(cli), "status", "--json"], { cwd: otherCwd, env: changedEnv, encoding: "utf8" });
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).codeBuddyHome, join(root, "relative-native"));
  const removed = spawnSync(process.execPath, [fileURLToPath(cli), "remove", "--json"], { cwd: otherCwd, env: changedEnv, encoding: "utf8" });
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(JSON.parse(removed.stdout).removed, true);
  assert.equal(await exists(join(root, "changed-home")), false);
});

test("recognizes legacy WorkBuddy roots without claiming independent CLI installations", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "memorax-codebuddy-legacy-roots-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const homeKeys = ["HOME", "USERPROFILE", "CODEBUDDY_HOME", "CODEBUDDY_CONFIG_DIR", "WORKBUDDY_HOME", "WORKBUDDY_CONFIG_DIR"];
  const previousEnv = { ...process.env };
  t.after(() => {
    for (const key of homeKeys) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
  });
  const clients = { codebuddy: true };
  for (const [name, homeName, overrides, expectedClient] of [
    ["default", ".workbuddy", {}, "workbuddy"],
    ["configured", "custom-native", { configured: true }, "workbuddy"],
    ["environment", "custom-native", { environment: true }, "workbuddy"],
    ["native-environment", "custom-native", { nativeEnvironment: true }, "workbuddy"],
    ["cli", ".codebuddy", {}, "codebuddy"],
    ["explicit-cli", ".workbuddy", { client: "codebuddy" }, "codebuddy"],
  ]) {
    const homeDir = join(root, name);
    const nativeHome = join(homeDir, homeName);
    Object.assign(process.env, { HOME: homeDir, USERPROFILE: homeDir,
      CODEBUDDY_HOME: join(homeDir, ".codebuddy"), CODEBUDDY_CONFIG_DIR: "",
      WORKBUDDY_HOME: overrides.environment ? nativeHome : "",
      WORKBUDDY_CONFIG_DIR: overrides.nativeEnvironment ? nativeHome : "",
    });
    const options = { memoraxCodeHome: join(homeDir, "state"),
      ...(overrides.configured ? { workBuddyHome: nativeHome } : {}),
    };
    const pluginRoot = join(marketplaceRoot(nativeHome), "plugins", "memorax-code-codebuddy-adapter");
    await mkdir(pluginRoot, { recursive: true });
    const metadata = { version: 1, codeBuddyHome: nativeHome, codeBuddyCommand: "/usr/local/bin/codebuddy",
      ...(overrides.client ? { client: overrides.client } : {}),
    };
    await writeFile(join(pluginRoot, ".memorax-code-package.json"), JSON.stringify(metadata));
    assert.deepEqual(await resolveCodeBuddyClientSelection(clients, options),
      expectedClient === "workbuddy" ? { codebuddy: false, workbuddy: true } : clients, name);
    const target = await readManagedCodeBuddyTarget({ ...options, client: expectedClient, codeBuddyHome: nativeHome });
    assert.equal(target?.codeBuddyHome, nativeHome, name);
    assert.equal(target?.codeBuddyCommand, metadata.codeBuddyCommand, name);
    assert.equal(await readManagedCodeBuddyTarget({ ...options,
      client: expectedClient === "workbuddy" ? "codebuddy" : "workbuddy", codeBuddyHome: nativeHome,
    }), undefined, name);
    if (overrides.configured) {
      const enabled = spawnSync(process.execPath, [fileURLToPath(new URL("../src/cli.mjs", import.meta.url)),
        "enable", "--workbuddy-home", homeName, "--json",
      ], { cwd: homeDir, env: { ...process.env, MEMORAX_CODE_HOME: options.memoraxCodeHome }, encoding: "utf8" });
      assert.equal(enabled.status, 0, enabled.stderr);
      assert.equal(JSON.parse(enabled.stdout).codeBuddyHome, nativeHome);
      assert.equal(JSON.parse(await readFile(join(pluginRoot, ".memorax-code-package.json"), "utf8")).client, "workbuddy");
    }
  }
});

test("maps only unqualified owned WorkBuddy metadata to the WorkBuddy selection", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-codebuddy-legacy-selection-"));
  const options = { memoraxCodeHome: join(root, "memorax"), codeBuddyHome: join(root, "cli"), workBuddyHome: join(root, "workbuddy") };
  const clients = { codex: true, claude: false, codebuddy: true };
  assert.equal(await resolveCodeBuddyClientSelection(clients, options), clients);
  const pluginRoot = join(marketplaceRoot(options.workBuddyHome), "plugins", "memorax-code-codebuddy-adapter");
  await mkdir(pluginRoot, { recursive: true });
  const metadata = { version: 1, codeBuddyHome: options.workBuddyHome, codeBuddyCommand: "/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy" };
  await writeFile(join(pluginRoot, ".memorax-code-package.json"), JSON.stringify(metadata));
  assert.deepEqual(await resolveCodeBuddyClientSelection(clients, options), { ...clients, codebuddy: false, workbuddy: true });
  assert.deepEqual(await resolveCodeBuddyClientSelection({ ...clients, workbuddy: false }, options), { ...clients, workbuddy: false });
  await enableCodeBuddyAdapter({ ...options, codeBuddyCommand: "cli-runtime" });
  assert.deepEqual(await resolveCodeBuddyClientSelection(clients, options), { ...clients, workbuddy: true });
  const legacyHomeOptions = { ...options, codeBuddyHome: options.workBuddyHome, workBuddyHome: undefined };
  assert.deepEqual(await resolveCodeBuddyClientSelection(clients, legacyHomeOptions), { ...clients, workbuddy: true }, "old WorkBuddy home flag must not hide the independent CLI target");
  await enableCodeBuddyAdapter({ ...options, client: "workbuddy", codeBuddyHome: options.workBuddyHome });
  assert.equal((await readManagedCodeBuddyTarget({ ...options, client: "workbuddy", codeBuddyHome: options.workBuddyHome })).legacyClientAlias, true);
  assert.deepEqual(await resolveCodeBuddyClientSelection(clients, options), { ...clients, workbuddy: true }, "retain the old selection after rewriting Hook metadata");
  assert.deepEqual(await resolveCodeBuddyClientSelection(clients, legacyHomeOptions), { ...clients, workbuddy: true }, "retain both targets after rewriting old WorkBuddy metadata");
  const freshOptions = { ...options, memoraxCodeHome: join(root, "fresh-memorax") };
  assert.equal(await resolveCodeBuddyClientSelection(clients, freshOptions), clients, "new explicit metadata does not imply an old selection");
});

test("reuses complete packaged plugins and repairs changed or incomplete copies", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "memorax-codebuddy-node-modules-"));
  t.after(async () => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  });
  const libraryRoot = join(root, "node_modules", "@memorax", "memorax-code", "lib");
  const adapterRoot = join(libraryRoot, "memorax-code-codebuddy-adapter");
  const commonRoot = join(libraryRoot, "memorax-code-adapter-common", "src");
  await cp(new URL("../", import.meta.url), adapterRoot, { recursive: true });
  await cp(new URL("../../memorax-code-adapter-common/src/", import.meta.url), commonRoot, { recursive: true });
  await cp(
    new URL("../../memorax-code-codex-adapter/skills/memorax-code/", import.meta.url),
    join(adapterRoot, "skills", "memorax-code"),
    { recursive: true },
  );
  const isolated = await import(pathToFileURL(join(adapterRoot, "src", "config.mjs")).href);
  const protectedSkills = new Set();
  const originalRemove = fs.rm;
  t.mock.method(fs, "rm", async (target, ...options) => {
    if (protectedSkills.has(target)) throw new Error("Deleting the copied Skill requires confirmation");
    return originalRemove(target, ...options);
  });
  syncBuiltinESMExports();

  const expectedSkill = await readFile(join(adapterRoot, "skills", "memorax-code", "SKILL.md"), "utf8");
  for (const client of ["codebuddy", "workbuddy"]) {
    const home = join(root, client);
    const pluginRoots = [
      isolated.codeBuddyInstallPath(home),
      join(isolated.marketplaceRoot(home), "plugins", "memorax-code-codebuddy-adapter"),
    ];
    for (const pluginRoot of pluginRoots) protectedSkills.add(join(pluginRoot, "skills", "memorax-code"));
    const options = {
      client,
      codeBuddyHome: home,
      memoraxCodeHome: join(root, "memorax-home"),
      codeBuddyCommand: "/opt/workbuddy/bin/codebuddy",
      platform: "win32",
    };
    await isolated.enableCodeBuddyAdapter(options);
    for (const pluginRoot of pluginRoots) protectedSkills.add(pluginRoot);
    await isolated.enableCodeBuddyAdapter(options);
    await isolated.disableCodeBuddyAdapter(options);
    await isolated.enableCodeBuddyAdapter({ ...options, memoraxCodeCommand: "/new/memorax-code.mjs" });
    for (const pluginRoot of pluginRoots) {
      const metadata = JSON.parse(await readFile(join(pluginRoot, ".memorax-code-package.json"), "utf8"));
      assert.equal(metadata.memoraxCodeCommand, "/new/memorax-code.mjs");
      protectedSkills.delete(pluginRoot);
    }
    await rm(join(pluginRoots[0], "hooks", "runtime-hook.mjs"));
    await writeFile(join(pluginRoots[1], "stale.txt"), "old artifact");
    await isolated.enableCodeBuddyAdapter(options);
    assert.equal(await exists(join(pluginRoots[1], "stale.txt")), false);
    const commonFile = join(commonRoot, "backend-connection.mjs");
    const changedCommon = `${await readFile(commonFile, "utf8")}\n// Changed without a version bump.\n`;
    await writeFile(commonFile, changedCommon);
    await isolated.enableCodeBuddyAdapter(options);
    for (const pluginRoot of pluginRoots) {
      assert.equal(await readFile(join(pluginRoot, "memorax-code-adapter-common", "src", "backend-connection.mjs"), "utf8"), changedCommon);
      protectedSkills.add(pluginRoot);
    }
    await isolated.enableCodeBuddyAdapter(options);
    for (const pluginRoot of pluginRoots) {
      for (const path of [
        join(pluginRoot, ".codebuddy-plugin", "plugin.json"),
        join(pluginRoot, "hooks", "runtime-hook.mjs"),
        join(pluginRoot, "memorax-code-adapter-common", "src", "backend-connection.mjs"),
      ]) {
        assert.equal(await exists(path), true, path);
      }
      assert.equal(await readFile(join(pluginRoot, "skills", "memorax-code", "SKILL.md"), "utf8"), expectedSkill);
    }
  }
});

test("status rejects stale plugin and global prompt Hook configurations", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-codebuddy-invalid-hook-"));
  const home = join(root, "codebuddy-home");
  await enableCodeBuddyAdapter({
    codeBuddyHome: home,
    memoraxCodeHome: join(root, "memorax-code-home"),
    platform: "win32",
  });
  const pluginRoot = join(marketplaceRoot(home), "plugins", "memorax-code-codebuddy-adapter");
  const manifestPath = join(pluginRoot, "hooks", "hooks.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.hooks.SessionStart[0].hooks[0].command = 'node "${CODEBUDDY_PLUGIN_ROOT}/hooks/runtime-hook.mjs" turn';
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  await assertInvalid();

  manifest.hooks.SessionStart[0].hooks[0].command = codeBuddyHookCommand(pluginRoot, "win32");
  manifest.hooks.UserPromptSubmit = [{ hooks: [{ type: "command", command: codeBuddyHookCommand(pluginRoot, "win32") }] }];
  await writeFile(manifestPath, JSON.stringify(manifest));
  await assertInvalid();

  delete manifest.hooks.UserPromptSubmit;
  await writeFile(manifestPath, JSON.stringify(manifest));
  const settings = JSON.parse(await readFile(codeBuddySettingsPath(home), "utf8"));
  settings.hooks.UserPromptSubmit = [];
  await writeFile(codeBuddySettingsPath(home), JSON.stringify(settings));
  await assertInvalid();

  settings.hooks.UserPromptSubmit = [{ hooks: [{ type: "command", command: codeBuddyUserPromptHookCommand(pluginRoot, "win32") }] }];
  settings.hooks.UserPromptSubmit.push(settings.hooks.UserPromptSubmit[0]);
  await writeFile(codeBuddySettingsPath(home), JSON.stringify(settings));
  await assertInvalid();

  async function assertInvalid() {
    const status = await readCodeBuddyAdapterStatus({
      codeBuddyHome: home,
      memoraxCodeHome: join(root, "memorax-code-home"),
      platform: "win32",
    });
    assert.equal(status.codebuddyHooks.ok, false);
    assert.equal(status.codebuddyHooks.status, "invalid");
  }
});

test("leaves an uninstalled home untouched and removes an orphaned managed global Hook", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-codebuddy-empty-"));
  const disabled = await disableCodeBuddyAdapter({ codeBuddyHome: home });
  assert.equal(disabled.installed, false);
  assert.equal(await exists(codeBuddySettingsPath(home)), false);
  const removed = await removeCodeBuddyPluginInstallation({ codeBuddyHome: home });
  assert.equal(removed.removed, false);
  assert.equal(await exists(join(home, "plugins", "installed_plugins.json")), false);
  const userGroup = { hooks: [{ type: "command", command: "echo user-prompt" }] };
  await writeFile(codeBuddySettingsPath(home), JSON.stringify({ hooks: { UserPromptSubmit: [
    userGroup,
    { hooks: [{ type: "command", command: codeBuddyUserPromptHookCommand(join(home, "memorax-code-codebuddy-adapter")) }] },
  ] } }));
  assert.equal((await removeCodeBuddyPluginInstallation({ codeBuddyHome: home })).removed, true);
  assert.deepEqual(JSON.parse(await readFile(codeBuddySettingsPath(home), "utf8")).hooks.UserPromptSubmit, [userGroup]);
});

test("malformed CodeBuddy registry fails closed", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-codebuddy-malformed-"));
  await mkdir(join(home, "plugins"), { recursive: true });
  await writeFile(join(home, "plugins", "installed_plugins.json"), "not-json\n");
  await assert.rejects(() => enableCodeBuddyAdapter({ codeBuddyHome: home }), (error) => {
    assert.match(error.message, /JSON|Unexpected token/);
    assert.deepEqual(error.failure, { stage: "config-parse", errorCode: "CLIENT_CONFIG_PARSE_FAILED", failureReason: "invalid_configuration" });
    assert.equal(JSON.stringify(error.failure).includes(home), false);
    return true;
  });
  const otherHome = await mkdtemp(join(tmpdir(), "memorax-codebuddy-malformed-hooks-"));
  const settings = { hooks: { UserPromptSubmit: "malformed" } };
  await writeFile(codeBuddySettingsPath(otherHome), JSON.stringify(settings));
  await assert.rejects(() => enableCodeBuddyAdapter({ codeBuddyHome: otherHome }), (error) => {
    assert.match(error.message, /invalid CodeBuddy UserPromptSubmit Hook settings/);
    assert.deepEqual(error.failure, { stage: "config-parse", errorCode: "CLIENT_CONFIG_PARSE_FAILED", failureReason: "invalid_configuration" });
    return true;
  });
  assert.deepEqual(JSON.parse(await readFile(codeBuddySettingsPath(otherHome), "utf8")), settings);
});

test("failed installation retains its target while cleanup preserves a native home that is a file", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-codebuddy-blocked-home-"));
  const home = join(root, "native-home");
  const memoraxCodeHome = join(root, "memorax");
  await writeFile(home, "user-owned file");
  await assert.rejects(() => enableCodeBuddyAdapter({ codeBuddyHome: home, memoraxCodeHome }), (error) => {
    assert.match(error.message, /ENOTDIR/);
    assert.deepEqual(error.failure, { stage: "plugin-stage", errorCode: "CLIENT_PLUGIN_STAGE_FAILED", systemCode: "ENOTDIR" });
    return true;
  });
  assert.equal((await readManagedCodeBuddyTarget({ memoraxCodeHome })).codeBuddyHome, home);
  assert.equal((await disableCodeBuddyAdapter({ memoraxCodeHome })).installed, false);
  assert.equal((await readCodeBuddyAdapterStatus({ memoraxCodeHome })).installed, false);
  assert.equal((await readManagedCodeBuddyTarget({ memoraxCodeHome })).codeBuddyHome, home);
  assert.equal(await readFile(home, "utf8"), "user-owned file");
});

test("recovers an abandoned legacy registry lock without losing user plugins", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-codebuddy-stale-lock-"));
  const pluginId = "memorax-code-codebuddy-adapter@memorax-code-local";
  const registryPath = join(home, "plugins", "installed_plugins.json");
  const lockPath = `${registryPath}.lock`;
  await mkdir(marketplaceRoot(home), { recursive: true });
  await writeFile(codeBuddySettingsPath(home), JSON.stringify({
    enabledPlugins: { [pluginId]: true },
  }));
  await writeFile(registryPath, JSON.stringify({
    version: 2,
    plugins: {
      "user-plugin@user-marketplace": [{ scope: "user", enabled: true }],
      [pluginId]: [{ scope: "user", enabled: true }],
    },
  }));
  await writeFile(lockPath, "");
  const staleTime = new Date(Date.now() - 60_000);
  await utimes(lockPath, staleTime, staleTime);

  const disabled = await disableCodeBuddyAdapter({ codeBuddyHome: home });

  assert.equal(disabled.ok, true);
  const registry = JSON.parse(await readFile(registryPath, "utf8"));
  assert.ok(registry.plugins["user-plugin@user-marketplace"]);
  assert.equal(registry.plugins[pluginId][0].enabled, false);
  assert.equal(await exists(lockPath), false);
});

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
