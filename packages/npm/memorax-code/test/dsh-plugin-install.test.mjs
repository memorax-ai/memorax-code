import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  activateDshPluginInstallation,
  collectDshAdapterStatus,
  disableDshPluginInstallation,
  discoverDshProfiles,
  ensureDshPluginInstalled,
  readDshPluginStatus,
  removeDshPluginInstallation,
} from "../lib/dsh-plugin-install.mjs";

test("DSH lifecycle reconciles existing profiles and preserves a disabled authority across stop", () => {
  const fixture = createFixture(["web", "headless"]);
  const invocations = [];
  try {
    const installed = ensureDshPluginInstalled({
      ...fixture.options,
      memoraxCodeCommand: fixture.memoraxCodeCommand,
      runDsh(invocation) {
        invocations.push(invocation);
        if (invocation.args[0] === "--version") {
          return { status: 0, stdout: "0.1.0-rc.6\n" };
        }
        activateAdapter(fixture.dshHome, invocation.args[2], invocation.args[4]);
        return { status: 0 };
      },
    });

    assert.equal(installed.ok, true);
    assert.equal(installed.enabled, true);
    assert.equal(installed.dshVersion, "0.1.0-rc.6");
    assert.deepEqual(installed.detectedProfiles, ["headless", "web"]);
    assert.deepEqual(installed.installedProfiles, ["headless", "web"]);
    assert.equal(existsSync(join(fixture.dshHome, "skills", "memorax-code")), false);
    assert.deepEqual(invocations.map(({ args }) => args), [
      ["--version"],
      ["plugin", "--profile", "headless", "add", `file:${fixture.adapterRoot}`],
      ["plugin", "--profile", "web", "add", `file:${fixture.adapterRoot}`],
    ]);
    assert.ok(invocations.every((invocation) => invocation.env.DSH_HOME === fixture.dshHome));
    assert.equal(readDshPluginStatus(fixture.options).enabled, true);
    const readyStatus = collectDshAdapterStatus({
      ...fixture.options,
      runDsh: compatibleDsh(() => assert.fail("status must not mutate a DSH profile")),
    });
    assert.equal(readyStatus.enabled, true);
    assert.equal(readyStatus.version, "0.1.0-rc.6");
    assert.deepEqual(readyStatus.profiles.map((profile) => profile.name), ["headless", "web"]);
    const metadata = readJson(join(fixture.adapterRoot, ".memorax-code-package.json"));
    assert.equal(metadata.memoraxCodeCommand, fixture.memoraxCodeCommand);
    assert.equal(metadata.memoraxCodeHome, fixture.memoraxCodeHome);
    assert.equal(metadata.dshHome, fixture.dshHome);
    assert.equal(metadata.dshVersion, "0.1.0-rc.6");
    assert.equal(metadata.sourceAdapterRoot, fixture.adapterRoot);
    assert.equal(readJson(fixture.statePath).dshVersion, "0.1.0-rc.6");

    writeProfile(fixture.dshHome, "later");
    const stateBeforeStatus = readFileSync(fixture.statePath, "utf8");
    const driftStatus = collectDshAdapterStatus({
      ...fixture.options,
      runDsh: compatibleDsh(() => assert.fail("status must not reconcile a DSH profile")),
    });
    assert.equal(driftStatus.enabled, false);
    assert.equal(driftStatus.reason, "profile_drift");
    assert.deepEqual(driftStatus.profiles, [
      { name: "headless", managed: true, exists: true, installed: true },
      { name: "later", managed: false, exists: true, installed: false },
      { name: "web", managed: true, exists: true, installed: true },
    ]);
    assert.equal(readFileSync(fixture.statePath, "utf8"), stateBeforeStatus);

    const disabled = disableDshPluginInstallation({
      ...fixture.options,
      runDsh(invocation) {
        deactivateAdapter(fixture.dshHome, invocation.args[2]);
        return { status: 0 };
      },
    });
    assert.equal(disabled.ok, true);
    assert.equal(disabled.enabled, false);
    assert.equal(existsSync(fixture.statePath), true);
    assert.equal(readJson(fixture.statePath).enabled, false);
    assert.equal(readDshPluginStatus(fixture.options).enabled, false);

    const reconciled = ensureDshPluginInstalled({
      ...fixture.options,
      enabled: false,
      memoraxCodeCommand: fixture.memoraxCodeCommand,
      runDsh: compatibleDsh((invocation) => {
        activateAdapter(fixture.dshHome, invocation.args[2], invocation.args[4]);
        return { status: 0 };
      }),
    });
    assert.equal(reconciled.ok, true);
    assert.equal(reconciled.enabled, false);
    assert.deepEqual(reconciled.state.profiles, ["headless", "later", "web"]);
    const activated = activateDshPluginInstallation(fixture.options);
    assert.equal(activated.ok, true);
    assert.equal(activated.enabled, true);

    const removed = removeDshPluginInstallation({
      ...fixture.options,
      runDsh(invocation) {
        deactivateAdapter(fixture.dshHome, invocation.args[2]);
        return { status: 0 };
      },
    });
    assert.equal(removed.ok, true);
    assert.deepEqual(removed.removedProfiles, ["headless", "later", "web"]);
    assert.equal(existsSync(fixture.statePath), false);
  } finally {
    fixture.cleanup();
  }
});

test("DSH install never initializes a profile when no valid profile exists", () => {
  const fixture = createFixture([]);
  let called = false;
  try {
    mkdirSync(join(fixture.dshHome, "profiles", "broken"), { recursive: true });
    writeFileSync(join(fixture.dshHome, "profiles", "broken", "package.json"), "{}\n");
    const report = ensureDshPluginInstalled({
      ...fixture.options,
      runDsh() {
        called = true;
        return { status: 0 };
      },
    });
    assert.equal(report.skipped, true);
    assert.equal(report.reason, "no_existing_profiles");
    assert.equal(called, false);
    assert.equal(existsSync(join(fixture.dshHome, "skills")), false);
    assert.equal(existsSync(fixture.statePath), false);
    assert.equal(existsSync(join(fixture.adapterRoot, ".memorax-code-package.json")), false);
    assert.deepEqual(discoverDshProfiles(fixture.options), []);
  } finally {
    fixture.cleanup();
  }
});

test("DSH install fails closed on an unmanaged same-name profile plugin", () => {
  const fixture = createFixture(["web"]);
  let called = false;
  try {
    activateAdapter(fixture.dshHome, "web", `file:${fixture.adapterRoot}`);
    const report = ensureDshPluginInstalled({
      ...fixture.options,
      runDsh(invocation) {
        if (invocation.args[0] === "--version") {
          return { status: 0, stdout: "0.1.0-rc.6\n" };
        }
        called = true;
        return { status: 0 };
      },
    });
    assert.equal(report.ok, false);
    assert.equal(report.reason, "profile_plugin_conflict");
    assert.equal(called, false);
    assert.equal(existsSync(fixture.statePath), false);
  } finally {
    fixture.cleanup();
  }
});

test("DSH lifecycle reuses its persisted command across later processes", () => {
  const fixture = createFixture(["web"]);
  const customDsh = join(fixture.root, "bin", "custom-dsh");
  const commands = [];
  try {
    const installed = ensureDshPluginInstalled({
      ...fixture.options,
      env: {},
      dshCommand: customDsh,
      runDsh: compatibleDsh((invocation) => {
        commands.push(invocation.command);
        activateAdapter(fixture.dshHome, invocation.args[2], invocation.args[4]);
        return { status: 0 };
      }),
    });
    assert.equal(installed.ok, true);
    assert.equal(readJson(fixture.statePath).dshCommand, customDsh);

    const disabled = disableDshPluginInstallation({
      ...fixture.options,
      env: {},
      runDsh(invocation) {
        commands.push(invocation.command);
        deactivateAdapter(fixture.dshHome, invocation.args[2]);
        return { status: 0 };
      },
    });
    assert.equal(disabled.ok, true);

    const restored = ensureDshPluginInstalled({
      ...fixture.options,
      env: {},
      enabled: false,
      runDsh: compatibleDsh((invocation) => {
        commands.push(invocation.command);
        activateAdapter(fixture.dshHome, invocation.args[2], invocation.args[4]);
        return { status: 0 };
      }),
    });
    assert.equal(restored.ok, true);
    assert.equal(restored.state.dshCommand, customDsh);
    assert.deepEqual(commands, [customDsh, customDsh, customDsh]);
  } finally {
    fixture.cleanup();
  }
});

test("DSH lifecycle owns a partial native add so uninstall and reinstall recover", () => {
  const fixture = createFixture(["web"]);
  try {
    const failed = ensureDshPluginInstalled({
      ...fixture.options,
      runDsh: compatibleDsh((invocation) => {
        addAdapterDependency(fixture.dshHome, invocation.args[2], invocation.args[4]);
        return { status: 7 };
      }),
    });
    assert.equal(failed.ok, false);
    assert.deepEqual(failed.state.profiles, ["web"]);
    assert.equal(readJson(join(fixture.dshHome, "profiles", "web", "package.json"))
      .dependencies["@memorax-code/dsh-adapter"], `file:${fixture.adapterRoot}`);

    const removed = removeDshPluginInstallation({
      ...fixture.options,
      runDsh(invocation) {
        deactivateAdapter(fixture.dshHome, invocation.args[2]);
        return { status: 0 };
      },
    });
    assert.equal(removed.ok, true);
    assert.deepEqual(removed.removedProfiles, ["web"]);
    assert.equal(existsSync(fixture.statePath), false);

    const reinstalled = ensureDshPluginInstalled({
      ...fixture.options,
      runDsh: compatibleDsh((invocation) => {
        activateAdapter(fixture.dshHome, invocation.args[2], invocation.args[4]);
        return { status: 0 };
      }),
    });
    assert.equal(reinstalled.ok, true);
    assert.deepEqual(reinstalled.state.profiles, ["web"]);
  } finally {
    fixture.cleanup();
  }
});

test("DSH lifecycle resolves a Windows npm shim without a command shell", () => {
  const fixture = createFixture(["web"]);
  const shim = "C:\\npm\\dsh.cmd";
  const cli = "C:\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js";
  try {
    const installed = ensureDshPluginInstalled({
      ...fixture.options,
      dshCommand: "dsh",
      windowsCliResolution: {
        platform: "win32",
        whereOutput: `${shim}\r\n`,
        nodePath: "C:\\node.exe",
        existsSync: (candidate) => candidate === cli,
      },
      runDsh(invocation) {
        assert.equal(invocation.command, "C:\\node.exe");
        if (invocation.args.at(-1) === "--version") {
          assert.deepEqual(invocation.args, [cli, "--version"]);
          return { status: 0, stdout: "0.1.0-rc.6\n" };
        }
        assert.deepEqual(invocation.args, [
          cli,
          "plugin",
          "--profile",
          "web",
          "add",
          `file:${fixture.adapterRoot}`,
        ]);
        activateAdapter(fixture.dshHome, "web", invocation.args.at(-1));
        return { status: 0 };
      },
    });
    assert.equal(installed.ok, true);
  } finally {
    fixture.cleanup();
  }
});

test("DSH disable publishes the inert sentinel before reporting native removal failure", () => {
  const fixture = createFixture(["web"]);
  try {
    const installed = ensureDshPluginInstalled({
      ...fixture.options,
      runDsh: compatibleDsh((invocation) => {
        activateAdapter(fixture.dshHome, invocation.args[2], invocation.args[4]);
        return { status: 0 };
      }),
    });
    assert.equal(installed.ok, true);
    const disabled = disableDshPluginInstallation({
      ...fixture.options,
      runDsh() {
        assert.equal(readJson(fixture.statePath).enabled, false);
        return { status: 7 };
      },
    });
    assert.equal(disabled.ok, false);
    assert.equal(disabled.enabled, false);
    assert.deepEqual(disabled.failedProfiles, [{ name: "web", reason: "dsh_command_failed", status: 7 }]);
    assert.equal(readJson(fixture.statePath).enabled, false);
    assert.equal(readDshPluginStatus(fixture.options).enabled, false);
  } finally {
    fixture.cleanup();
  }
});

test("DSH install leaves unsupported versions untouched and disables prior authority", () => {
  const fresh = createFixture(["web"]);
  try {
    const profilePath = join(fresh.dshHome, "profiles", "web", "package.json");
    activateAdapter(fresh.dshHome, "web", `file:${fresh.adapterRoot}`);
    const before = readFileSync(profilePath, "utf8");
    const unsupported = ensureDshPluginInstalled({
      ...fresh.options,
      runDsh() {
        return { status: 0, stdout: "0.1.0-rc.7\n" };
      },
    });
    assert.equal(unsupported.ok, true);
    assert.equal(unsupported.skipped, true);
    assert.equal(unsupported.reason, "unsupported_dsh_version");
    assert.equal(unsupported.dshVersion, "0.1.0-rc.7");
    assert.deepEqual(unsupported.supportedDshVersions, ["0.1.0-rc.6"]);
    assert.equal(readFileSync(profilePath, "utf8"), before);
    assert.equal(existsSync(fresh.statePath), false);
    assert.equal(existsSync(join(fresh.adapterRoot, ".memorax-code-package.json")), false);
    const malformed = collectDshAdapterStatus({
      ...fresh.options,
      runDsh() {
        return { status: 0, stdout: "\u001b[31m0.1.0-rc.6\n" };
      },
    });
    assert.equal(malformed.reason, "dsh_version_unavailable");
    assert.equal(Object.hasOwn(malformed, "version"), false);
  } finally {
    fresh.cleanup();
  }

  const managed = createFixture(["web"]);
  try {
    const installed = ensureDshPluginInstalled({
      ...managed.options,
      runDsh: compatibleDsh((invocation) => {
        activateAdapter(managed.dshHome, invocation.args[2], invocation.args[4]);
        return { status: 0 };
      }),
    });
    assert.equal(installed.ok, true);
    assert.equal(readJson(managed.statePath).enabled, true);

    const unsupported = ensureDshPluginInstalled({
      ...managed.options,
      runDsh() {
        return { status: 0, stdout: "0.1.0-rc.7\n" };
      },
    });
    assert.equal(unsupported.skipped, true);
    assert.equal(readJson(managed.statePath).enabled, false);
    assert.equal(readDshPluginStatus(managed.options).enabled, false);
  } finally {
    managed.cleanup();
  }
});

function createFixture(profiles) {
  const root = mkdtempSync(join(tmpdir(), "memorax-code-dsh-install-"));
  const dshHome = join(root, "dsh-home");
  const memoraxCodeHome = join(root, "memorax-code-home");
  const adapterRoot = join(root, "adapter");
  const memoraxCodeCommand = join(root, "bin", "memorax-code.mjs");
  const statePath = join(memoraxCodeHome, "adapters", "dsh", "state.json");
  mkdirSync(join(adapterRoot, "skills", "memorax-code"), { recursive: true });
  mkdirSync(join(adapterRoot, "hooks"), { recursive: true });
  mkdirSync(join(root, "bin"), { recursive: true });
  writeFileSync(join(adapterRoot, "package.json"), `${JSON.stringify({
    name: "@memorax-code/dsh-adapter",
    version: "0.0.0-test",
    dsh: { bundle: { patch: "./cordis.patch.yml" } },
  }, null, 2)}\n`);
  writeFileSync(join(adapterRoot, "cordis.patch.yml"), "[]\n");
  writeFileSync(join(adapterRoot, "skills", "memorax-code", "SKILL.md"), "canonical skill\n");
  writeFileSync(join(adapterRoot, "skills", "memorax-code", "dsh-definition.json"), "{}\n");
  writeFileSync(join(adapterRoot, "hooks", "repo-memory-job.mjs"), "// helper\n");
  writeFileSync(memoraxCodeCommand, "// cli\n");
  for (const profile of profiles) writeProfile(dshHome, profile);
  return {
    root,
    dshHome,
    memoraxCodeHome,
    adapterRoot,
    memoraxCodeCommand,
    statePath,
    options: {
      dshHome,
      memoraxCodeHome,
      adapterRoot,
      windowsCliResolution: { platform: "linux" },
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function compatibleDsh(runPlugin) {
  return (invocation) => invocation.args.length === 1 && invocation.args[0] === "--version"
    ? { status: 0, stdout: "0.1.0-rc.6\n" }
    : runPlugin(invocation);
}

function writeProfile(dshHome, name, overrides = {}) {
  const profileRoot = join(dshHome, "profiles", name);
  mkdirSync(profileRoot, { recursive: true });
  writeFileSync(join(profileRoot, "package.json"), `${JSON.stringify({
    name: `dsh-profile-${name}`,
    private: true,
    dependencies: overrides.dependencies ?? {},
    dsh: { profile: { bundles: overrides.bundles ?? ["@deepseek-ai/dsh-base"] } },
  }, null, 2)}\n`);
}

function activateAdapter(dshHome, profile, fileSpec) {
  assert.match(fileSpec, /^file:/);
  const path = join(dshHome, "profiles", profile, "package.json");
  const manifest = readJson(path);
  manifest.dependencies["@memorax-code/dsh-adapter"] = fileSpec;
  if (!manifest.dsh.profile.bundles.includes("@memorax-code/dsh-adapter")) {
    manifest.dsh.profile.bundles.push("@memorax-code/dsh-adapter");
  }
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

function addAdapterDependency(dshHome, profile, fileSpec) {
  assert.match(fileSpec, /^file:/);
  const path = join(dshHome, "profiles", profile, "package.json");
  const manifest = readJson(path);
  manifest.dependencies["@memorax-code/dsh-adapter"] = fileSpec;
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

function deactivateAdapter(dshHome, profile) {
  const path = join(dshHome, "profiles", profile, "package.json");
  const manifest = readJson(path);
  delete manifest.dependencies["@memorax-code/dsh-adapter"];
  manifest.dsh.profile.bundles = manifest.dsh.profile.bundles
    .filter((name) => name !== "@memorax-code/dsh-adapter");
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}
