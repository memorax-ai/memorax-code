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
  collectDshAdapterStatus,
  discoverDshProfiles,
  withDshPluginLifecycleLock,
} from "../lib/dsh-plugin-install.mjs";

test("DSH status reports later Profile drift without mutating lifecycle authority", async () => {
  const fixture = createFixture(["web", "headless"]);
  try {
    const installed = await runLifecycle({
      ...fixture.options,
      memoraxCodeCommand: fixture.memoraxCodeCommand,
      runDsh: compatibleDsh((invocation) => {
        activateAdapter(fixture.dshHome, invocation.args[2], invocation.args[4]);
        return { status: 0 };
      }),
    }, "ensureInstalled");

    assert.equal(installed.ok, true);
    assert.equal(installed.enabled, true);

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
  } finally {
    fixture.cleanup();
  }
});

test("DSH install never initializes a profile when no valid profile exists", async () => {
  const fixture = createFixture([]);
  let called = false;
  try {
    mkdirSync(join(fixture.dshHome, "profiles", "broken"), { recursive: true });
    writeFileSync(join(fixture.dshHome, "profiles", "broken", "package.json"), "{}\n");
    const report = await runLifecycle({
      ...fixture.options,
      runDsh() {
        called = true;
        return { status: 0 };
      },
    }, "ensureInstalled");
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

test("DSH install fails closed on an unmanaged same-name profile plugin", async () => {
  const fixture = createFixture(["web"]);
  let called = false;
  try {
    activateAdapter(fixture.dshHome, "web", `file:${fixture.adapterRoot}`);
    const report = await runLifecycle({
      ...fixture.options,
      runDsh(invocation) {
        if (invocation.args[0] === "--version") {
          return { status: 0, stdout: "0.1.0-rc.6\n" };
        }
        called = true;
        return { status: 0 };
      },
    }, "ensureInstalled");
    assert.equal(report.ok, false);
    assert.equal(report.reason, "profile_plugin_conflict");
    assert.equal(called, false);
    assert.equal(existsSync(fixture.statePath), false);
  } finally {
    fixture.cleanup();
  }
});

test("DSH lifecycle owns a partial native add so uninstall and reinstall recover", async () => {
  const fixture = createFixture(["web"]);
  try {
    const failed = await runLifecycle({
      ...fixture.options,
      runDsh: compatibleDsh((invocation) => {
        addAdapterDependency(fixture.dshHome, invocation.args[2], invocation.args[4]);
        return { status: 7 };
      }),
    }, "ensureInstalled");
    assert.equal(failed.ok, false);
    assert.deepEqual(readJson(fixture.statePath).profiles, ["web"]);
    assert.equal(readJson(join(fixture.dshHome, "profiles", "web", "package.json"))
      .dependencies["@memorax-code/dsh-adapter"], `file:${fixture.adapterRoot}`);

    const removed = await runLifecycle({
      ...fixture.options,
      runDsh(invocation) {
        deactivateAdapter(fixture.dshHome, invocation.args[2]);
        return { status: 0 };
      },
    }, "remove");
    assert.equal(removed.ok, true);
    assert.deepEqual(removed.removedProfiles, ["web"]);
    assert.equal(existsSync(fixture.statePath), false);

    const reinstalled = await runLifecycle({
      ...fixture.options,
      runDsh: compatibleDsh((invocation) => {
        activateAdapter(fixture.dshHome, invocation.args[2], invocation.args[4]);
        return { status: 0 };
      }),
    }, "ensureInstalled");
    assert.equal(reinstalled.ok, true);
    assert.deepEqual(readJson(fixture.statePath).profiles, ["web"]);
  } finally {
    fixture.cleanup();
  }
});

test("DSH disable publishes the inert sentinel before reporting native removal failure", async () => {
  const fixture = createFixture(["web"]);
  try {
    const installed = await runLifecycle({
      ...fixture.options,
      runDsh: compatibleDsh((invocation) => {
        activateAdapter(fixture.dshHome, invocation.args[2], invocation.args[4]);
        return { status: 0 };
      }),
    }, "ensureInstalled");
    assert.equal(installed.ok, true);
    const disabled = await runLifecycle({
      ...fixture.options,
      runDsh() {
        assert.equal(readJson(fixture.statePath).enabled, false);
        return { status: 7 };
      },
    }, "disable");
    assert.equal(disabled.ok, false);
    assert.equal(disabled.enabled, false);
    assert.deepEqual(disabled.failedProfiles, [{ name: "web", reason: "dsh_command_failed", status: 7 }]);
    assert.equal(readJson(fixture.statePath).enabled, false);
    assert.equal((await runLifecycle(fixture.options, "status")).enabled, false);
  } finally {
    fixture.cleanup();
  }
});

test("DSH install leaves unsupported versions untouched and disables prior authority", async () => {
  const fresh = createFixture(["web"]);
  try {
    const profilePath = join(fresh.dshHome, "profiles", "web", "package.json");
    activateAdapter(fresh.dshHome, "web", `file:${fresh.adapterRoot}`);
    const before = readFileSync(profilePath, "utf8");
    const unsupported = await runLifecycle({
      ...fresh.options,
      runDsh() {
        return { status: 0, stdout: "0.1.0-rc.7\n" };
      },
    }, "ensureInstalled");
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
    const installed = await runLifecycle({
      ...managed.options,
      runDsh: compatibleDsh((invocation) => {
        activateAdapter(managed.dshHome, invocation.args[2], invocation.args[4]);
        return { status: 0 };
      }),
    }, "ensureInstalled");
    assert.equal(installed.ok, true);
    assert.equal(readJson(managed.statePath).enabled, true);

    const unsupported = await runLifecycle({
      ...managed.options,
      runDsh() {
        return { status: 0, stdout: "0.1.0-rc.7\n" };
      },
    }, "ensureInstalled");
    assert.equal(unsupported.skipped, true);
    assert.equal(readJson(managed.statePath).enabled, false);
    assert.equal((await runLifecycle(managed.options, "status")).enabled, false);
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
  mkdirSync(adapterRoot, { recursive: true });
  mkdirSync(join(root, "bin"), { recursive: true });
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

function runLifecycle(options, operation) {
  return withDshPluginLifecycleLock(options, (lifecycle) => lifecycle[operation]());
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
