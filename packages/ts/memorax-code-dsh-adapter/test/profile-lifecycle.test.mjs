import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

import { withDshPluginLifecycleLock } from "../src/profile-lifecycle.mjs";

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
  assert.deepEqual(failed.failedProfiles, [
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
    webManifest.dependencies["@memorax-code/dsh-adapter"],
    `file:${priorState.runtimeBundleRoot}`,
  );
  const alphaManifest = JSON.parse(readFileSync(join(profilesRoot, "alpha", "package.json"), "utf8"));
  assert.equal(Object.hasOwn(alphaManifest.dependencies, "@memorax-code/dsh-adapter"), false);
  assert.equal(alphaManifest.dsh.profile.bundles.includes("@memorax-code/dsh-adapter"), false);
  assert.equal(existsSync(join(
    profilesRoot,
    "alpha",
    "node_modules",
    "@memorax-code",
    "dsh-adapter",
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
  assert.deepEqual(failed.failedProfiles, [
    { name: "zulu", reason: "dsh_command_failed", status: 1 },
  ]);
  assert.deepEqual(failed.rollbackFailedProfiles, [
    { name: "alpha", reason: "dsh_command_failed", status: 1 },
  ]);
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(state.enabled, true);
  assert.equal(state.runtimeBundleRoot, priorState.runtimeBundleRoot);
  assert.equal(state.memoraxCodeCommand, priorState.memoraxCodeCommand);
  assert.deepEqual(state.profiles, ["alpha", "web"]);
  const alphaManifest = JSON.parse(readFileSync(join(profilesRoot, "alpha", "package.json"), "utf8"));
  assert.equal(
    alphaManifest.dependencies["@memorax-code/dsh-adapter"],
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
    dependencies: { "@memorax-code/dsh-adapter": `file:${runtimeBundleRoot}` },
    dsh: { profile: { bundles: ["@memorax-code/dsh-adapter"] } },
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
      .dependencies["@memorax-code/dsh-adapter"],
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
      delete manifest.dependencies["@memorax-code/dsh-adapter"];
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
  writeProfile(join(dshHome, "profiles"), "web");

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
  assert.deepEqual(report.failedProfiles, [
    { name: "web", reason: "pnpm_not_found", status: 127 },
  ]);
});

test("materializes, packs, installs, and reuses one per-home runtime generation", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "memorax-code-dsh-runtime-bundle-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const adapterRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const adapterManifest = JSON.parse(readFileSync(join(adapterRoot, "package.json"), "utf8"));
  const memoraxCodeHome = join(root, "memorax-code-home");
  const dshHome = join(root, "dsh-home");
  const profileRoot = join(dshHome, "profiles", "web");
  const profileManifestPath = join(profileRoot, "package.json");
  const packRoot = join(root, "packs");
  mkdirSync(profileRoot, { recursive: true });
  mkdirSync(packRoot, { recursive: true });
  writeJson(profileManifestPath, {
    name: "dsh-profile-web",
    version: "1.0.0",
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: [] } },
  });

  let addCalls = 0;
  let packedFiles;
  const options = {
    adapterRoot,
    dshHome,
    memoraxCodeHome,
    memoraxCodeCommand: join(root, "memorax-code.mjs"),
    runDsh(invocation) {
      if (invocation.args.length === 1 && invocation.args[0] === "--version") {
        return { status: 0, stdout: "0.1.0-rc.6\n" };
      }
      assert.deepEqual(invocation.args.slice(0, 4), ["plugin", "--profile", "web", "add"]);
      addCalls += 1;
      const runtimeBundleRoot = invocation.args[4].slice("file:".length);
      const pack = spawnSync("npm", [
        "pack",
        runtimeBundleRoot,
        "--json",
        `--pack-destination=${packRoot}`,
      ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      assert.equal(pack.status, 0, pack.stderr);
      packedFiles = JSON.parse(pack.stdout)[0].files.map(({ path }) => path).sort();
      const install = spawnSync("npm", [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--package-lock=false",
        invocation.args[4],
      ], { cwd: profileRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      assert.equal(install.status, 0, install.stderr);
      const manifest = JSON.parse(readFileSync(profileManifestPath, "utf8"));
      manifest.dsh.profile.bundles = ["@memorax-code/dsh-adapter"];
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
  assert.equal(addCalls, 1);
  assert.equal(existsSync(join(adapterRoot, ".memorax-code-package.json")), false);

  const statePath = join(memoraxCodeHome, "adapters", "dsh", "state.json");
  const firstState = JSON.parse(readFileSync(statePath, "utf8"));
  assert.match(firstState.runtimeBundleRoot, /[/\\]runtime[/\\]generations[/\\][0-9a-f]{64}$/);
  assert.equal(existsSync(join(firstState.runtimeBundleRoot, "src", "profile-lifecycle.mjs")), false);
  assert.equal(existsSync(join(
    firstState.runtimeBundleRoot,
    "memorax-code-adapter-common",
    "src",
    "windows-cli-invocation.mjs",
  )), true);
  assert.deepEqual(packedFiles, ["package.json", ...adapterManifest.files].sort());
  const installedRoot = join(profileRoot, "node_modules", "@memorax-code", "dsh-adapter");
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
  assert.equal(addCalls, 1);
  assert.equal(secondState.runtimeBundleRoot, firstState.runtimeBundleRoot);
  assert.deepEqual(
    readdirSync(join(memoraxCodeHome, "adapters", "dsh", "runtime", "generations")),
    [firstState.runtimeBundleRoot.split(/[/\\]/).at(-1)],
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
  writeProfile(profilesRoot, "web");

  const installAdapter = (profileName, runtimeBundleRoot) => {
    const profileRoot = join(profilesRoot, profileName);
    const installedRoot = join(profileRoot, "node_modules", "@memorax-code", "dsh-adapter");
    rmSync(installedRoot, { recursive: true, force: true });
    mkdirSync(dirname(installedRoot), { recursive: true });
    cpSync(runtimeBundleRoot, installedRoot, { recursive: true });
    const manifestPath = join(profileRoot, "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.dependencies["@memorax-code/dsh-adapter"] = `file:${runtimeBundleRoot}`;
    if (!manifest.dsh.profile.bundles.includes("@memorax-code/dsh-adapter")) {
      manifest.dsh.profile.bundles.push("@memorax-code/dsh-adapter");
    }
    writeJson(manifestPath, manifest);
  };
  const removeAdapter = (profileName) => {
    const profileRoot = join(profilesRoot, profileName);
    rmSync(join(profileRoot, "node_modules", "@memorax-code", "dsh-adapter"), {
      recursive: true,
      force: true,
    });
    const manifestPath = join(profileRoot, "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    delete manifest.dependencies["@memorax-code/dsh-adapter"];
    manifest.dsh.profile.bundles = manifest.dsh.profile.bundles
      .filter((name) => name !== "@memorax-code/dsh-adapter");
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

function writeProfile(profilesRoot, name) {
  const profileRoot = join(profilesRoot, name);
  mkdirSync(profileRoot, { recursive: true });
  writeJson(join(profileRoot, "package.json"), {
    name: `dsh-profile-${name}`,
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: [] } },
  });
}
