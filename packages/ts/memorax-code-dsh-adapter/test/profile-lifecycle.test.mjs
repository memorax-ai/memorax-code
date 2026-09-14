import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  collectDshAdapterStatus,
  withDshPluginLifecycleLock,
} from "../src/profile-lifecycle.mjs";

const HEADLESS_BUNDLE_NAME = "@deepseek-ai/dsh-headless";

test("failed reconciliation restores the prior authority and removes newly installed Profiles", async (t) => {
  const fixture = await createReconciliationFixture(t);
  const {
    root,
    memoraxCodeHome,
    profilesRoot,
    statePath,
    initialOptions,
    installAdapter,
    removeAdapter,
    priorState,
  } = fixture;

  writeProfile(profilesRoot, "alpha");
  writeProfile(profilesRoot, "zulu");
  const mutations = [];
  const failed = await withDshPluginLifecycleLock({
    ...initialOptions,
    memoraxCodeCommand: join(root, "memorax-code-v2.mjs"),
    runDsh(invocation) {
      if (invocation.args[0] === "--version") return { status: 0, stdout: "0.1.0-rc.6\n" };
      const profileName = invocation.args[2];
      const operation = invocation.args[3];
      mutations.push(`${operation}:${profileName}`);
      if (operation === "add" && profileName === "zulu") return { status: 1 };
      if (operation === "add") {
        installAdapter(profileName, invocation.args[4].slice("file:".length));
      } else {
        removeAdapter(profileName);
      }
      return { status: 0 };
    },
  }, (lifecycle) => lifecycle.ensureInstalled());

  assert.equal(failed.ok, false);
  assert.deepEqual(failed.failedProfiles.map(({ failure, ...profile }) => profile), [
    { name: "zulu", reason: "dsh_command_failed", status: 1 },
  ]);
  assert.deepEqual(JSON.parse(readFileSync(statePath, "utf8")), priorState);
  assert.deepEqual(mutations, [
    "add:alpha",
    "add:web",
    "add:zulu",
    "remove:alpha",
    "add:web",
  ]);
  const webManifest = JSON.parse(readFileSync(join(profilesRoot, "web", "package.json"), "utf8"));
  assert.equal(
    webManifest.dependencies["@memorax-code/dsh-memorax-code"],
    `file:${priorState.runtimeBundleRoot}`,
  );
  const alphaManifest = JSON.parse(readFileSync(join(profilesRoot, "alpha", "package.json"), "utf8"));
  assert.equal(Object.hasOwn(alphaManifest.dependencies, "@memorax-code/dsh-memorax-code"), false);
  assert.equal(alphaManifest.dsh.profile.bundles.includes("@memorax-code/dsh-memorax-code"), false);
  assert.equal(existsSync(join(
    profilesRoot,
    "alpha",
    "node_modules",
    "@memorax-code",
    "dsh-memorax-code",
  )), false);
  const generations = readdirSync(join(
    memoraxCodeHome,
    "adapters",
    "dsh",
    "runtime",
    "generations",
  ));
  assert.equal(generations.length, 2);
  assert.equal(generations.includes(priorState.runtimeBundleRoot.split(/[/\\]/).at(-1)), true);

  const status = await withDshPluginLifecycleLock(initialOptions, (lifecycle) => lifecycle.status());
  assert.equal(status.ok, true);
  assert.equal(status.enabled, true);
  assert.equal(status.installed, true);
  assert.deepEqual(status.profiles.map(({ name }) => name), ["web"]);
});


test("Windows DSH plugin installation and rollback preserve pnpm arguments without a shell", async (t) => {
  const fixture = await createReconciliationFixture(t);
  const {
    root, profilesRoot, statePath, initialOptions, installAdapter, removeAdapter,
  } = fixture;
  const dshEntrypoint = join(root, "dsh bin.mjs");
  const nodePath = "C:\\test node\\node.exe";
  const preloads = [];
  const mutations = [];
  let failUpdate = false;
  const options = {
    ...initialOptions,
    dshCommand: dshEntrypoint,
    windowsCliResolution: { platform: "win32", nodePath },
    runDsh(invocation) {
      assert.equal(invocation.command, nodePath);
      if (invocation.args.at(-1) === "--version") {
        assert.deepEqual(invocation.args, [dshEntrypoint, "--version"]);
        return { status: 0, stdout: "0.1.5-rc.1\n" };
      }
      assert.equal(invocation.args[0], "--import");
      assert.match(invocation.args[1], /^data:text\/javascript;base64,/);
      assert.equal(invocation.args[2], dshEntrypoint);
      preloads.push(invocation.args[1]);
      const args = invocation.args.slice(3);
      const profileName = args[2];
      const operation = args[3];
      mutations.push({ operation, profileName, spec: args[4] });
      if (failUpdate && operation === "add" && profileName === "zulu") return { status: 1 };
      if (operation === "add") installAdapter(profileName, args[4].slice("file:".length));
      else removeAdapter(profileName);
      return { status: 0 };
    },
  };
  const installed = await withDshPluginLifecycleLock(options, (lifecycle) => (
    lifecycle.ensureInstalled()
  ));
  assert.equal(installed.ok, true, JSON.stringify(installed));
  assert.equal(preloads.length, 1);
  const priorState = JSON.parse(readFileSync(statePath, "utf8"));

  writeProfile(profilesRoot, "alpha");
  writeProfile(profilesRoot, "zulu");
  mutations.length = 0;
  failUpdate = true;
  const failed = await withDshPluginLifecycleLock({
    ...options,
    memoraxCodeCommand: join(root, "memorax-code-v2.mjs"),
  }, (lifecycle) => lifecycle.ensureInstalled());
  assert.equal(failed.ok, false);
  assert.deepEqual(failed.failedProfiles.map(({ name }) => name), ["zulu"]);
  assert.deepEqual(mutations.map(({ operation, profileName }) => operation + ":" + profileName), [
    "add:alpha", "add:web", "add:zulu", "remove:alpha", "add:web",
  ]);
  assert.equal(mutations.at(-1).spec, "file:" + priorState.runtimeBundleRoot);
  assert.deepEqual(JSON.parse(readFileSync(statePath, "utf8")), priorState);
  assert.equal(preloads.length, 6);
  assert.equal(new Set(preloads).size, 1);

  const scriptPath = join(root, "verify-windows-pnpm-preload.mjs");
  writeFileSync(scriptPath, "await (" + verifyWindowsDshPnpmPreload.toString() + ")(process.argv[2]);\n");
  const checked = spawnSync(process.execPath, [scriptPath, preloads[0]], {
    cwd: root,
    env: { HOME: root, MEMORAX_CODE_HOME: initialOptions.memoraxCodeHome },
    encoding: "utf8",
    timeout: 10_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(checked.status, 0, checked.stderr || checked.error?.message);
});

// Execute the emitted preload in a child so builtin and platform mocks cannot
// affect the test runner or other lifecycle tests.
async function verifyWindowsDshPnpmPreload(preload) {
  const { default: assert } = await import("node:assert/strict");
  const { default: childProcess } = await import("node:child_process");
  const { default: fs } = await import("node:fs");
  const { default: path } = await import("node:path");
  const { syncBuiltinESMExports } = await import("node:module");
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  path.dirname = path.win32.dirname;
  path.join = path.win32.join;
  path.resolve = path.win32.resolve;
  const calls = [];
  const available = new Set();
  const shims = new Map();
  const result = { status: 17, signal: null, stdout: "native output", stderr: "native error" };
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    return result;
  };
  childProcess.spawnSync = spawn;
  fs.existsSync = (candidate) => available.has(candidate);
  fs.statSync = (candidate) => {
    if (available.has(candidate)) return { isFile: () => true };
    throw Object.assign(new Error("missing fixture file"), { code: "ENOENT" });
  };
  const readFile = fs.readFileSync;
  fs.readFileSync = (candidate, ...args) => shims.has(candidate)
    ? shims.get(candidate)
    : readFile(candidate, ...args);
  syncBuiltinESMExports();
  const args = [
    "add",
    "file:C:\\MemoraX home & %MEMORAX_DSH_PATH_PROBE%\\generation",
    "--reporter=append-only",
  ];
  process.argv = [process.execPath, "fake-dsh.js", "plugin", "--profile", "headless", ...args];
  await import(preload);
  const { spawnSync } = await import("node:child_process");
  const originalArgs = [...args];
  const prefix = "C:\\MemoraX Windows 验证 & %MEMORAX_DSH_PATH_PROBE%";
  const nativeCommand = path.join(prefix, "pnpm.exe");
  const shimCommand = path.join(prefix, "pnpm.cmd");
  const pnpmEntrypoint = path.join(prefix, "node_modules", "pnpm", "bin", "pnpm.cjs");
  const options = {
    shell: true,
    cwd: "C:\\DSH 验证 home & %MEMORAX_DSH_PATH_PROBE%",
    env: {
      MEMORAX_DSH_PATH_PROBE: "DECOY",
      Path: '"' + prefix + '";C:\\后备工具',
      Pathext: ".CMD;.EXE",
    },
    stdio: "inherit",
    encoding: "utf8",
    timeout: 1234,
    windowsHide: true,
  };
  for (const fixture of [
    {
      command: shimCommand,
      entrypoint: pnpmEntrypoint,
      shim: '"%_prog%" "%dp0%\\node_modules\\pnpm\\bin\\pnpm.cjs" %*',
    },
    {
      command: shimCommand,
      entrypoint: path.join(prefix, "node_modules", "corepack", "dist", "pnpm.js"),
      shim: '"%_prog%" "%~dp0\\node_modules\\corepack\\dist\\pnpm.js" %*',
      otherEntrypoint: pnpmEntrypoint,
    },
    { command: nativeCommand },
  ]) {
    calls.length = 0;
    available.clear();
    shims.clear();
    available.add(fixture.command);
    available.add(nativeCommand);
    available.add("C:\\后备工具\\pnpm.exe");
    if (fixture.entrypoint) available.add(fixture.entrypoint);
    if (fixture.otherEntrypoint) available.add(fixture.otherEntrypoint);
    if (fixture.shim) shims.set(fixture.command, fixture.shim);
    assert.equal(spawnSync("pnpm", args, options), result);
    assert.deepEqual(calls, [{
      command: fixture.entrypoint ? process.execPath : fixture.command,
      args: fixture.entrypoint ? [fixture.entrypoint, ...args] : args,
      options: { ...options, shell: false },
    }]);
    assert.equal(calls[0].options.env, options.env);
    assert.deepEqual(args, originalArgs);
    assert.equal(options.shell, true);
  }

  const cwdCommand = path.join(options.cwd, "pnpm.exe");
  available.add(cwdCommand);
  calls.length = 0;
  assert.equal(spawnSync("pnpm", args, options), result);
  assert.equal(calls[0].command, cwdCommand);
  options.env.NoDefaultCurrentDirectoryInExePath = "1";
  calls.length = 0;
  assert.equal(spawnSync("pnpm", args, options), result);
  assert.equal(calls[0].command, nativeCommand);
  delete options.env.NoDefaultCurrentDirectoryInExePath;

  for (const [command, invocationArgs, invocationOptions] of [
    ["pnpm", args, { ...options, shell: false }],
    ["other-command", args, options],
    ["pnpm", args.map((value) => '"' + value + '"'), options],
  ]) {
    calls.length = 0;
    assert.equal(spawnSync(command, invocationArgs, invocationOptions), result);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, command);
    assert.equal(calls[0].args, invocationArgs);
    assert.equal(calls[0].options, invocationOptions);
  }

  calls.length = 0;
  available.clear();
  const missing = spawnSync("pnpm", args, options);
  assert.equal(missing.error.code, "ENOENT");
  assert.equal(missing.status, null);
  assert.equal(calls.length, 0);

  available.add(shimCommand);
  shims.set(shimCommand, '"node" "unknown-launcher.js" %*');
  const unresolved = spawnSync("pnpm", args, options);
  assert.equal(unresolved.error.code, "ENOEXEC");
  assert.equal(calls.length, 0);

  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  childProcess.spawnSync = spawn;
  syncBuiltinESMExports();
  await import(preload + "#non-windows");
  assert.equal(childProcess.spawnSync, spawn);
}

test("failed rollback removal retains ownership of the residual Profile", async (t) => {
  const fixture = await createReconciliationFixture(t);
  const {
    root,
    profilesRoot,
    statePath,
    initialOptions,
    installAdapter,
    removeAdapter,
    priorState,
  } = fixture;
  writeProfile(profilesRoot, "alpha");
  writeProfile(profilesRoot, "zulu");

  let newRuntimeBundleRoot;
  const failed = await withDshPluginLifecycleLock({
    ...initialOptions,
    memoraxCodeCommand: join(root, "memorax-code-v2.mjs"),
    runDsh(invocation) {
      if (invocation.args[0] === "--version") return { status: 0, stdout: "0.1.0-rc.6\n" };
      const profileName = invocation.args[2];
      const operation = invocation.args[3];
      if (operation === "add" && profileName === "zulu") return { status: 1 };
      if (operation === "remove" && profileName === "alpha") return { status: 1 };
      if (operation === "add") {
        const runtimeBundleRoot = invocation.args[4].slice("file:".length);
        if (profileName === "alpha") newRuntimeBundleRoot = runtimeBundleRoot;
        installAdapter(profileName, runtimeBundleRoot);
      } else {
        removeAdapter(profileName);
      }
      return { status: 0 };
    },
  }, (lifecycle) => lifecycle.ensureInstalled());

  assert.equal(failed.ok, false);
  assert.deepEqual(failed.failedProfiles.map(({ failure, ...profile }) => profile), [
    { name: "zulu", reason: "dsh_command_failed", status: 1 },
  ]);
  assert.deepEqual(failed.rollbackFailedProfiles.map(({ failure, ...profile }) => profile), [
    { name: "alpha", reason: "dsh_command_failed", status: 1 },
  ]);
  assert.equal(failed.failure.cleanupErrorCode, "CLIENT_CLEANUP_FAILED");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(state.enabled, true);
  assert.equal(state.runtimeBundleRoot, priorState.runtimeBundleRoot);
  assert.equal(state.memoraxCodeCommand, priorState.memoraxCodeCommand);
  assert.deepEqual(state.profiles, ["alpha", "web"]);
  const alphaManifest = JSON.parse(readFileSync(join(profilesRoot, "alpha", "package.json"), "utf8"));
  assert.equal(
    alphaManifest.dependencies["@memorax-code/dsh-memorax-code"],
    `file:${newRuntimeBundleRoot}`,
  );

  const removedProfiles = [];
  const removed = await withDshPluginLifecycleLock({
    ...initialOptions,
    runDsh(invocation) {
      const profileName = invocation.args[2];
      removedProfiles.push(profileName);
      removeAdapter(profileName);
      return { status: 0 };
    },
  }, (lifecycle) => lifecycle.remove());
  assert.equal(removed.ok, true);
  assert.deepEqual(removedProfiles, ["alpha", "web"]);
  assert.equal(existsSync(statePath), false);
});

test("quiesce publishes the inert authority without invoking DSH or removing Profiles", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "memorax-code-dsh-quiesce-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const memoraxCodeHome = join(root, "memorax-code-home");
  const dshHome = join(root, "dsh-home");
  const statePath = join(memoraxCodeHome, "adapters", "dsh", "state.json");
  const oldAdapterRoot = join(root, "previous-package", "lib", "memorax-code-dsh-adapter");
  const runtimeBundleRoot = join(
    memoraxCodeHome,
    "adapters",
    "dsh",
    "runtime",
    "generations",
    "generation-1",
  );
  const profileManifestPath = join(dshHome, "profiles", "web", "package.json");
  mkdirSync(join(dshHome, "profiles", "web"), { recursive: true });
  mkdirSync(join(memoraxCodeHome, "adapters", "dsh"), { recursive: true });
  writeFileSync(profileManifestPath, `${JSON.stringify({
    dependencies: { "@memorax-code/dsh-memorax-code": `file:${runtimeBundleRoot}` },
    dsh: { profile: { bundles: ["@memorax-code/dsh-memorax-code"] } },
  })}\n`);
  writeFileSync(statePath, `${JSON.stringify({
    version: 1,
    runtime: "dsh",
    integration: "plugin",
    enabled: true,
    dshHome,
    memoraxCodeHome,
    adapterRoot: oldAdapterRoot,
    runtimeBundleRoot,
    memoraxCodeCommand: "memorax-code",
    dshCommand: "dsh",
    dshVersion: "0.1.0-rc.6",
    profiles: ["web"],
    updatedAt: "2026-08-15T12:00:00.000Z",
  })}\n`);

  const report = await withDshPluginLifecycleLock({
    dshHome,
    memoraxCodeHome,
    adapterRoot: join(root, "current-package", "lib", "memorax-code-dsh-adapter"),
    runDsh: () => assert.fail("quiesce must not invoke DSH"),
  }, (lifecycle) => lifecycle.quiesce());

  const state = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(report.ok, true);
  assert.equal(report.action, "dsh-plugin-quiesce");
  assert.equal(report.enabled, false);
  assert.equal(report.managed, true);
  assert.equal(report.authorityEnabled, false);
  assert.equal(report.previouslyEnabled, true);
  assert.equal(report.revision, state.updatedAt);
  assert.deepEqual(report.profiles, ["web"]);
  assert.equal(state.enabled, false);
  assert.equal(state.adapterRoot, oldAdapterRoot);
  assert.deepEqual(state.profiles, ["web"]);
  assert.equal(
    JSON.parse(readFileSync(profileManifestPath, "utf8"))
      .dependencies["@memorax-code/dsh-memorax-code"],
    `file:${runtimeBundleRoot}`,
  );

  let removalInvocation;
  const removed = await withDshPluginLifecycleLock({
    dshHome,
    memoraxCodeHome,
    adapterRoot: join(root, "removed-package", "lib", "memorax-code-dsh-adapter"),
    runDsh: (invocation) => {
      removalInvocation = invocation;
      const manifest = JSON.parse(readFileSync(profileManifestPath, "utf8"));
      delete manifest.dependencies["@memorax-code/dsh-memorax-code"];
      manifest.dsh.profile.bundles = [];
      writeFileSync(profileManifestPath, `${JSON.stringify(manifest)}\n`);
      return { status: 0 };
    },
  }, (lifecycle) => lifecycle.remove());

  assert.equal(removed.ok, true);
  assert.equal(removalInvocation.cwd, dshHome);
  assert.equal(existsSync(statePath), false);
});

test("quiesce preserves the not-managed lifecycle result", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "memorax-code-dsh-quiesce-empty-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const report = await withDshPluginLifecycleLock({
    dshHome: join(root, "dsh-home"),
    memoraxCodeHome: join(root, "memorax-code-home"),
    adapterRoot: join(root, "adapter"),
  }, (lifecycle) => lifecycle.quiesce());

  assert.deepEqual(report, {
    ok: true,
    action: "dsh-plugin-quiesce",
    runtime: "dsh",
    installed: false,
    enabled: false,
    managed: false,
    skipped: true,
    reason: "not_managed",
  });
});

test("restores the persisted DSH home when DSH_HOME is not configured", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "memorax-code-dsh-persisted-home-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const homeDir = join(root, "home");
  const memoraxCodeHome = join(homeDir, ".memorax-code");
  const dshHome = join(root, "persisted-dsh-home");
  const adapterRoot = join(root, "adapter");
  const runtimeBundleRoot = join(
    memoraxCodeHome,
    "adapters",
    "dsh",
    "runtime",
    "generations",
    "generation-1",
  );
  const statePath = join(memoraxCodeHome, "adapters", "dsh", "state.json");
  writeProfile(join(dshHome, "profiles"), "web");
  mkdirSync(dirname(statePath), { recursive: true });
  writeJson(statePath, {
    version: 1,
    runtime: "dsh",
    integration: "plugin",
    enabled: false,
    dshHome,
    memoraxCodeHome,
    adapterRoot,
    runtimeBundleRoot,
    memoraxCodeCommand: "memorax-code",
    dshCommand: "dsh",
    dshVersion: "0.1.0-rc.6",
    profiles: ["web"],
    updatedAt: "2026-08-15T12:00:00.000Z",
  });

  const report = await withDshPluginLifecycleLock({
    adapterRoot,
    env: {},
    homeDir,
    memoraxCodeHome,
  }, (lifecycle) => lifecycle.status());

  assert.equal(report.ok, true);
  assert.equal(report.managed, true);
  assert.deepEqual(report.profiles, [{ name: "web", exists: true, installed: false }]);
});

test("reports drift and rejects activation when the managed worker loses its headless bundle", async (t) => {
  const fixture = await createReconciliationFixture(t);
  const {
    profilesRoot,
    initialOptions,
  } = fixture;
  const manifestPath = join(profilesRoot, "web", "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.dsh.profile.bundles = manifest.dsh.profile.bundles
    .filter((name) => name !== HEADLESS_BUNDLE_NAME);
  writeJson(manifestPath, manifest);

  const publicStatus = collectDshAdapterStatus(initialOptions);
  assert.equal(publicStatus.ok, true);
  assert.equal(publicStatus.installed, false);
  assert.equal(publicStatus.enabled, false);
  assert.equal(publicStatus.reason, "profile_drift");

  const activation = await withDshPluginLifecycleLock(initialOptions, (lifecycle) => {
    const status = lifecycle.status();
    assert.equal(status.installed, false);
    assert.equal(status.enabled, false);
    return lifecycle.activate();
  });
  assert.equal(activation.ok, false);
  assert.equal(activation.reason, "managed_profiles_not_installed");
});

test("does not accept a stale headless bundle declaration without an installed module", async (t) => {
  const fixture = await createReconciliationFixture(t);
  const {
    profilesRoot,
    initialOptions,
  } = fixture;
  rmSync(join(profilesRoot, "node_modules", ...HEADLESS_BUNDLE_NAME.split("/")), {
    recursive: true,
    force: true,
  });

  const publicStatus = collectDshAdapterStatus(initialOptions);
  assert.equal(publicStatus.ok, true);
  assert.equal(publicStatus.installed, false);
  assert.equal(publicStatus.enabled, false);
  assert.equal(publicStatus.reason, "profile_drift");

  const activation = await withDshPluginLifecycleLock(initialOptions, (lifecycle) => {
    const status = lifecycle.status();
    assert.equal(status.installed, false);
    assert.equal(status.enabled, false);
    return lifecycle.activate();
  });
  assert.equal(activation.ok, false);
  assert.equal(activation.reason, "managed_profiles_not_installed");
});

test("migrates the managed legacy package identity and restores it if reconciliation fails", async (t) => {
  const fixture = await createReconciliationFixture(t);
  const {
    profilesRoot,
    statePath,
    initialOptions,
    installAdapter,
    removeAdapter,
    priorState,
  } = fixture;
  const legacyPackageName = "@memorax-code/dsh-adapter";
  const currentPackageName = "@memorax-code/dsh-memorax-code";

  removeAdapter("web", currentPackageName);
  const legacyRuntimeBundleRoot = join(dirname(priorState.runtimeBundleRoot), "legacy-generation");
  cpSync(priorState.runtimeBundleRoot, legacyRuntimeBundleRoot, { recursive: true });
  const legacyRuntimeManifestPath = join(legacyRuntimeBundleRoot, "package.json");
  writeJson(legacyRuntimeManifestPath, {
    ...JSON.parse(readFileSync(legacyRuntimeManifestPath, "utf8")),
    name: legacyPackageName,
  });
  const legacyMetadataPath = join(legacyRuntimeBundleRoot, ".memorax-code-package.json");
  writeJson(legacyMetadataPath, {
    ...JSON.parse(readFileSync(legacyMetadataPath, "utf8")),
    runtimeBundleRoot: legacyRuntimeBundleRoot,
  });
  installAdapter("web", legacyRuntimeBundleRoot);
  writeProfile(profilesRoot, "headless", [HEADLESS_BUNDLE_NAME]);
  installAdapter("headless", legacyRuntimeBundleRoot);
  let legacyState = {
    ...priorState,
    runtimeBundleRoot: legacyRuntimeBundleRoot,
    profiles: ["headless", "web"],
    updatedAt: "2026-08-15T13:00:00.000Z",
  };
  writeJson(statePath, legacyState);

  let failWeb = true;
  const migrationOptions = {
    ...initialOptions,
    runDsh(invocation) {
      if (invocation.args[0] === "--version") return { status: 0, stdout: "0.1.0-rc.6\n" };
      const profileName = invocation.args[2];
      const operation = invocation.args[3];
      if (operation === "add") {
        if (failWeb
          && profileName === "web"
          && invocation.args[4] !== `file:${legacyState.runtimeBundleRoot}`) {
          return { status: 1 };
        }
        installAdapter(profileName, invocation.args[4].slice("file:".length));
      } else {
        removeAdapter(profileName, invocation.args[4]);
      }
      return { status: 0 };
    },
  };

  const statusBeforeMigration = collectDshAdapterStatus(migrationOptions);
  assert.equal(statusBeforeMigration.ok, true);
  assert.equal(statusBeforeMigration.installed, true);
  assert.equal(statusBeforeMigration.enabled, true);
  const reactivated = await withDshPluginLifecycleLock(migrationOptions, (lifecycle) => {
    const quiesced = lifecycle.quiesce();
    assert.equal(quiesced.previouslyEnabled, true);
    assert.equal(lifecycle.status().installed, true);
    return lifecycle.activate();
  });
  assert.equal(reactivated.ok, true);
  assert.equal(reactivated.enabled, true);
  legacyState = JSON.parse(readFileSync(statePath, "utf8"));

  const failed = await withDshPluginLifecycleLock(migrationOptions, (lifecycle) => (
    lifecycle.ensureInstalled()
  ));
  assert.equal(failed.ok, false);
  assert.deepEqual(failed.failedProfiles.map(({ failure, ...profile }) => profile), [
    { name: "web", reason: "dsh_command_failed", status: 1 },
  ]);
  assert.equal(failed.rollbackFailedProfiles, undefined);
  assert.deepEqual(JSON.parse(readFileSync(statePath, "utf8")), legacyState);
  for (const profileName of legacyState.profiles) {
    const manifest = JSON.parse(readFileSync(
      join(profilesRoot, profileName, "package.json"),
      "utf8",
    ));
    assert.equal(Object.hasOwn(manifest.dependencies, legacyPackageName), true);
    assert.equal(Object.hasOwn(manifest.dependencies, currentPackageName), false);
  }

  failWeb = false;
  const migrated = await withDshPluginLifecycleLock(migrationOptions, (lifecycle) => (
    lifecycle.ensureInstalled()
  ));
  assert.equal(migrated.ok, true);
  assert.equal(migrated.installed, true);
  assert.equal(migrated.enabled, true);
  for (const profileName of legacyState.profiles) {
    const profileRoot = join(profilesRoot, profileName);
    const manifest = JSON.parse(readFileSync(join(profileRoot, "package.json"), "utf8"));
    assert.equal(Object.hasOwn(manifest.dependencies, legacyPackageName), false);
    assert.equal(Object.hasOwn(manifest.dependencies, currentPackageName), true);
    assert.equal(existsSync(join(
      profileRoot,
      "node_modules",
      ...legacyPackageName.split("/"),
    )), false);
    assert.equal(existsSync(join(
      profileRoot,
      "node_modules",
      ...currentPackageName.split("/"),
    )), true);
  }
  const status = await withDshPluginLifecycleLock(initialOptions, (lifecycle) => lifecycle.status());
  assert.equal(status.ok, true);
  assert.equal(status.installed, true);
  assert.equal(status.enabled, true);
});

test("managed DSH discovery failures are not optional skips", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "memorax-code-dsh-managed-discovery-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const memoraxCodeHome = join(root, "memorax-code-home");
  const dshHome = join(root, "dsh-home");
  const adapterRoot = join(root, "adapter");
  const statePath = join(memoraxCodeHome, "adapters", "dsh", "state.json");
  const runtimeBundleRoot = join(
    memoraxCodeHome,
    "adapters",
    "dsh",
    "runtime",
    "generations",
    "generation-1",
  );
  mkdirSync(dirname(statePath), { recursive: true });
  writeJson(statePath, {
    version: 1,
    runtime: "dsh",
    integration: "plugin",
    enabled: true,
    dshHome,
    memoraxCodeHome,
    adapterRoot,
    runtimeBundleRoot,
    memoraxCodeCommand: "memorax-code",
    dshCommand: "dsh",
    dshVersion: "0.1.0-rc.6",
    profiles: ["web"],
    updatedAt: "2026-08-15T12:00:00.000Z",
  });

  const missingProfiles = await withDshPluginLifecycleLock({
    adapterRoot,
    dshHome,
    memoraxCodeHome,
    runDsh: () => assert.fail("missing managed Profiles must fail before probing DSH"),
  }, (lifecycle) => lifecycle.ensureInstalled({ enabled: false }));
  assert.equal(missingProfiles.ok, false);
  assert.equal(missingProfiles.managed, true);
  assert.equal(missingProfiles.skipped, undefined);
  assert.equal(missingProfiles.reason, "no_existing_profiles");

  const profileRoot = join(dshHome, "profiles", "web");
  mkdirSync(profileRoot, { recursive: true });
  writeJson(join(profileRoot, "package.json"), {
    dependencies: {},
    dsh: { profile: { bundles: [] } },
  });
  writeJson(statePath, {
    ...JSON.parse(readFileSync(statePath, "utf8")),
    enabled: true,
    profiles: ["web"],
  });
  const unavailable = await withDshPluginLifecycleLock({
    adapterRoot,
    dshHome,
    memoraxCodeHome,
    runDsh: () => ({ status: 1, error: Object.assign(new Error("missing dsh"), { code: "ENOENT" }) }),
  }, (lifecycle) => lifecycle.ensureInstalled({ enabled: false }));
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.managed, true);
  assert.equal(unavailable.skipped, undefined);
  assert.equal(unavailable.reason, "dsh_version_unavailable");
  assert.deepEqual(unavailable.failure, {
    errorCode: "CLIENT_NATIVE_COMMAND_FAILED", stage: "native-command", systemCode: "ENOENT",
    commandExitCode: 1, failureReason: "not_found",
  });
  assert.equal(JSON.parse(readFileSync(statePath, "utf8")).enabled, false);
});

test("an unmanaged existing Profile does not hide an unavailable DSH command", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "memorax-code-dsh-unmanaged-discovery-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dshHome = join(root, "dsh-home");
  const profileRoot = join(dshHome, "profiles", "web");
  mkdirSync(profileRoot, { recursive: true });
  writeJson(join(profileRoot, "package.json"), {
    dependencies: {},
    dsh: { profile: { bundles: [] } },
  });

  const report = await withDshPluginLifecycleLock({
    adapterRoot: join(root, "adapter"),
    dshHome,
    memoraxCodeHome: join(root, "memorax-code-home"),
    runDsh: () => ({ status: 1, error: Object.assign(new Error("missing dsh"), { code: "ENOENT" }) }),
  }, (lifecycle) => lifecycle.ensureInstalled({ enabled: false }));
  assert.equal(report.ok, false);
  assert.equal(report.managed, false);
  assert.equal(report.skipped, undefined);
  assert.equal(report.reason, "dsh_version_unavailable");
});

test("reports pnpm missing from DSH's native Profile plugin manager", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "memorax-code-dsh-pnpm-missing-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const adapterRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const dshHome = join(root, "dsh-home");
  const memoraxCodeHome = join(root, "memorax-code-home");
  writeProfile(join(dshHome, "profiles"), "web", [HEADLESS_BUNDLE_NAME]);

  const report = await withDshPluginLifecycleLock({
    adapterRoot,
    dshHome,
    memoraxCodeHome,
    runDsh(invocation) {
      return invocation.args[0] === "--version"
        ? { status: 0, stdout: "0.1.0-rc.6\n" }
        : {
            status: 127,
            stderr: "dsh: pnpm not found on PATH — install pnpm to manage profile plugins\n",
          };
    },
  }, (lifecycle) => lifecycle.ensureInstalled({ enabled: false }));

  assert.equal(report.ok, false);
  assert.equal(report.reason, "pnpm_not_found");
  assert.deepEqual(report.failedProfiles.map(({ failure, ...profile }) => profile), [
    { name: "web", reason: "pnpm_not_found", status: 127 },
  ]);
  assert.deepEqual(report.failure, {
    errorCode: "CLIENT_NATIVE_COMMAND_FAILED", stage: "native-command", commandExitCode: 127,
    failureReason: "exit_status",
  });
  assert.equal(JSON.stringify(report.failure).includes("pnpm not found"), false);

  const originalRename = fs.renameSync;
  const originalRemove = fs.rmSync;
  const runtimeRoot = join(memoraxCodeHome, "adapters", "dsh", "runtime", "generations");
  const publishError = Object.assign(new Error(`private publication failure ${root}`), { code: "EPERM" });
  fs.renameSync = (source, destination) => {
    if (dirname(destination) === runtimeRoot && source.endsWith(".tmp")) throw publishError;
    return originalRename(source, destination);
  };
  fs.rmSync = (target, ...args) => {
    if (dirname(target) === runtimeRoot && target.endsWith(".tmp")) {
      throw Object.assign(new Error("private cleanup failure"), { code: "EIO" });
    }
    return originalRemove(target, ...args);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(withDshPluginLifecycleLock({
      adapterRoot, dshHome, memoraxCodeHome, memoraxCodeCommand: join(root, "next-cli.mjs"),
      runDsh: () => ({ status: 0, stdout: "0.1.0-rc.6\n" }),
    }, (lifecycle) => lifecycle.ensureInstalled({ enabled: false })), (error) => {
      assert.equal(error, publishError);
      assert.deepEqual(error.failure, {
        errorCode: "CLIENT_RUNTIME_PUBLISH_FAILED", stage: "runtime-publish", systemCode: "EPERM",
        cleanupErrorCode: "CLIENT_CLEANUP_FAILED", cleanupSystemCode: "EIO",
      });
      assert.equal(JSON.stringify(error.failure).includes(root), false);
      return true;
    });
  } finally {
    fs.renameSync = originalRename;
    fs.rmSync = originalRemove;
    syncBuiltinESMExports();
  }
});

test("uses the DSH runtime already linked by Profiles and refreshes it on reconciliation", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "memorax-code-dsh-runtime-bundle-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const adapterRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const adapterManifest = JSON.parse(readFileSync(join(adapterRoot, "package.json"), "utf8"));
  const memoraxCodeHome = join(root, "memorax-code-home");
  const dshHome = join(root, "dsh-home");
  const profilesRoot = join(dshHome, "profiles");
  const webRoot = join(profilesRoot, "web");
  const webManifestPath = join(webRoot, "package.json");
  const packRoot = join(root, "packs");
  mkdirSync(webRoot, { recursive: true });
  mkdirSync(packRoot, { recursive: true });
  writeJson(webManifestPath, {
    name: "dsh-profile-web",
    version: "1.0.0",
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: [
      "@deepseek-ai/dsh-base",
      "@deepseek-ai/dsh-web-app",
    ] } },
  });
  const dshPackageRoot = join(
    profilesRoot,
    "node_modules",
    "@deepseek-ai",
    "dsh",
  );
  const dshEntrypoint = join(dshPackageRoot, "lib", "bin.js");
  mkdirSync(dirname(dshEntrypoint), { recursive: true });
  writeJson(join(dshPackageRoot, "package.json"), {
    name: "@deepseek-ai/dsh",
    version: "0.1.0-rc.6",
    bin: { dsh: "lib/bin.js" },
  });
  writeFileSync(dshEntrypoint, "#!/usr/bin/env node\n");

  let directDshVersion;
  let directProbeCalls = 0;
  let addCalls = 0;
  let packedFiles;
  const options = {
    adapterRoot,
    dshHome,
    memoraxCodeHome,
    memoraxCodeCommand: join(root, "memorax-code.mjs"),
    runDsh(invocation) {
      if (invocation.command === "dsh") {
        directProbeCalls += 1;
        assert.deepEqual(invocation.args, ["--version"]);
        if (directDshVersion) {
          return { status: 0, stdout: `${directDshVersion}\n` };
        }
        return {
          status: 1,
          error: Object.assign(new Error("missing dsh"), { code: "ENOENT" }),
        };
      }
      assert.equal(invocation.command, process.execPath);
      assert.equal(invocation.args[0], dshEntrypoint);
      const dshArgs = invocation.args.slice(1);
      assert.deepEqual(
        [dshArgs[0], dshArgs[1], dshArgs[3]],
        ["plugin", "--profile", "add"],
      );
      const profileName = dshArgs[2];
      if (profileName === "headless") {
        writeProfile(profilesRoot, profileName, [
          "@deepseek-ai/dsh-base",
          HEADLESS_BUNDLE_NAME,
        ]);
      }
      const profileRoot = join(profilesRoot, profileName);
      const profileManifestPath = join(profileRoot, "package.json");
      addCalls += 1;
      const runtimeBundleRoot = dshArgs[4].slice("file:".length);
      if (packedFiles === undefined) {
        const pack = spawnSync("npm", [
          "pack",
          runtimeBundleRoot,
          "--json",
          `--pack-destination=${packRoot}`,
        ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        assert.equal(pack.status, 0, pack.stderr);
        packedFiles = JSON.parse(pack.stdout)[0].files.map(({ path }) => path).sort();
      }
      const install = spawnSync("npm", [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--package-lock=false",
        dshArgs[4],
      ], { cwd: profileRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      assert.equal(install.status, 0, install.stderr);
      const manifest = JSON.parse(readFileSync(profileManifestPath, "utf8"));
      if (!manifest.dsh.profile.bundles.includes("@memorax-code/dsh-memorax-code")) {
        manifest.dsh.profile.bundles.push("@memorax-code/dsh-memorax-code");
      }
      writeJson(profileManifestPath, manifest);
      return { status: 0 };
    },
  };

  const first = await withDshPluginLifecycleLock(options, (lifecycle) => (
    lifecycle.ensureInstalled({ enabled: false })
  ));
  assert.equal(first.ok, true);
  assert.equal(first.installed, true);
  assert.equal(first.enabled, false);
  assert.deepEqual(first.detectedProfiles, ["web"]);
  assert.deepEqual(first.installedProfiles, ["headless", "web"]);
  assert.equal(addCalls, 2);
  assert.equal(existsSync(join(adapterRoot, ".memorax-code-package.json")), false);

  const statePath = join(memoraxCodeHome, "adapters", "dsh", "state.json");
  const firstState = JSON.parse(readFileSync(statePath, "utf8"));
  assert.deepEqual(firstState.profiles, ["headless", "web"]);
  assert.equal(firstState.dshCommand, dshEntrypoint);
  assert.equal(firstState.dshVersion, "0.1.0-rc.6");
  assert.equal(directProbeCalls, 1);
  assert.match(firstState.runtimeBundleRoot, /[/\\]runtime[/\\]generations[/\\][0-9a-f]{64}$/);
  assert.equal(existsSync(join(firstState.runtimeBundleRoot, "src", "profile-lifecycle.mjs")), false);
  assert.equal(existsSync(join(
    firstState.runtimeBundleRoot,
    "memorax-code-adapter-common",
    "src",
    "windows-cli-invocation.mjs",
  )), true);
  assert.equal(existsSync(join(
    firstState.runtimeBundleRoot,
    "memorax-code-adapter-common",
    "src",
    "backend-command.mjs",
  )), true);
  assert.deepEqual(packedFiles, ["package.json", ...adapterManifest.files].sort());
  const installedRoot = join(
    profilesRoot,
    "headless",
    "node_modules",
    "@memorax-code",
    "dsh-memorax-code",
  );
  const installed = await import(pathToFileURL(join(installedRoot, "src", "index.mjs")).href);
  assert.equal(installed.name, "memorax-code");
  let contextRead = false;
  const inactiveContext = new Proxy({}, {
    get() {
      contextRead = true;
      throw new Error("disabled DSH integration must not inspect Cordis context");
    },
  });
  assert.doesNotThrow(() => installed.apply(inactiveContext));
  assert.equal(contextRead, false);

  const installedMetadataPath = join(installedRoot, ".memorax-code-package.json");
  const installedMetadata = readFileSync(installedMetadataPath, "utf8");
  writeFileSync(installedMetadataPath, "{}\n");
  assert.doesNotThrow(() => installed.apply(inactiveContext));
  assert.equal(contextRead, false);
  writeFileSync(installedMetadataPath, installedMetadata);

  const second = await withDshPluginLifecycleLock(options, (lifecycle) => (
    lifecycle.ensureInstalled({ enabled: false })
  ));
  const secondState = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(second.ok, true);
  assert.equal(addCalls, 2);
  assert.equal(secondState.runtimeBundleRoot, firstState.runtimeBundleRoot);
  assert.equal(directProbeCalls, 1);
  assert.deepEqual(
    readdirSync(join(memoraxCodeHome, "adapters", "dsh", "runtime", "generations")),
    [firstState.runtimeBundleRoot.split(/[/\\]/).at(-1)],
  );

  const activated = await withDshPluginLifecycleLock(options, (lifecycle) => (
    lifecycle.activate()
  ));
  assert.equal(activated.ok, true, JSON.stringify(activated));
  assert.equal(activated.enabled, true);
  directDshVersion = "0.1.1-rc.2";
  rmSync(dshPackageRoot, { recursive: true, force: true });
  const stale = collectDshAdapterStatus(options);
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, "dsh_profile_runtime_stale");
  assert.equal(directProbeCalls, 1);

  mkdirSync(dirname(dshEntrypoint), { recursive: true });
  writeJson(join(dshPackageRoot, "package.json"), {
    name: "@deepseek-ai/dsh",
    version: "0.1.1-rc.1",
    bin: { dsh: "lib/bin.js" },
  });
  writeFileSync(dshEntrypoint, "#!/usr/bin/env node\n");
  const updated = await withDshPluginLifecycleLock(options, (lifecycle) => (
    lifecycle.ensureInstalled({ enabled: false })
  ));
  const updatedState = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(updated.ok, true);
  assert.equal(addCalls, 4);
  assert.equal(directProbeCalls, 1);
  assert.equal(updatedState.dshCommand, dshEntrypoint);
  assert.equal(updatedState.dshVersion, "0.1.1-rc.1");
  assert.notEqual(updatedState.runtimeBundleRoot, firstState.runtimeBundleRoot);
  assert.deepEqual(
    readdirSync(join(memoraxCodeHome, "adapters", "dsh", "runtime", "generations")),
    [updatedState.runtimeBundleRoot.split(/[/\\]/).at(-1)],
  );
});

async function createReconciliationFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "memorax-code-dsh-reconciliation-rollback-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const adapterRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const memoraxCodeHome = join(root, "memorax-code-home");
  const dshHome = join(root, "dsh-home");
  const profilesRoot = join(dshHome, "profiles");
  const statePath = join(memoraxCodeHome, "adapters", "dsh", "state.json");
  writeProfile(profilesRoot, "web", [HEADLESS_BUNDLE_NAME]);

  const installAdapter = (profileName, runtimeBundleRoot) => {
    const profileRoot = join(profilesRoot, profileName);
    const packageName = JSON.parse(readFileSync(join(runtimeBundleRoot, "package.json"), "utf8")).name;
    const installedRoot = join(profileRoot, "node_modules", ...packageName.split("/"));
    rmSync(installedRoot, { recursive: true, force: true });
    mkdirSync(dirname(installedRoot), { recursive: true });
    cpSync(runtimeBundleRoot, installedRoot, { recursive: true });
    const manifestPath = join(profileRoot, "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.dependencies[packageName] = `file:${runtimeBundleRoot}`;
    if (!manifest.dsh.profile.bundles.includes(packageName)) {
      manifest.dsh.profile.bundles.push(packageName);
    }
    writeJson(manifestPath, manifest);
  };
  const removeAdapter = (profileName, packageName = "@memorax-code/dsh-memorax-code") => {
    const profileRoot = join(profilesRoot, profileName);
    rmSync(join(profileRoot, "node_modules", ...packageName.split("/")), {
      recursive: true,
      force: true,
    });
    const manifestPath = join(profileRoot, "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    delete manifest.dependencies[packageName];
    manifest.dsh.profile.bundles = manifest.dsh.profile.bundles
      .filter((name) => name !== packageName);
    writeJson(manifestPath, manifest);
  };
  const initialOptions = {
    adapterRoot,
    dshHome,
    memoraxCodeHome,
    memoraxCodeCommand: join(root, "memorax-code-v1.mjs"),
    runDsh(invocation) {
      if (invocation.args[0] === "--version") return { status: 0, stdout: "0.1.0-rc.6\n" };
      installAdapter(invocation.args[2], invocation.args[4].slice("file:".length));
      return { status: 0 };
    },
  };
  const installed = await withDshPluginLifecycleLock(initialOptions, (lifecycle) => (
    lifecycle.ensureInstalled()
  ));
  assert.equal(installed.ok, true);
  const priorState = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(priorState.enabled, true);
  assert.deepEqual(priorState.profiles, ["web"]);
  return {
    root,
    memoraxCodeHome,
    profilesRoot,
    statePath,
    initialOptions,
    installAdapter,
    removeAdapter,
    priorState,
  };
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeProfile(profilesRoot, name, bundles = []) {
  const profileRoot = join(profilesRoot, name);
  mkdirSync(profileRoot, { recursive: true });
  writeJson(join(profileRoot, "package.json"), {
    name: `dsh-profile-${name}`,
    private: true,
    dependencies: {},
    dsh: { profile: { bundles } },
  });
  if (bundles.includes(HEADLESS_BUNDLE_NAME)) {
    const headlessRoot = join(profilesRoot, "node_modules", ...HEADLESS_BUNDLE_NAME.split("/"));
    mkdirSync(headlessRoot, { recursive: true });
    writeJson(join(headlessRoot, "package.json"), {
      name: HEADLESS_BUNDLE_NAME,
      version: "0.1.0-test",
      main: "index.js",
    });
    writeFileSync(join(headlessRoot, "index.js"), "module.exports = {};\n");
  }
}
