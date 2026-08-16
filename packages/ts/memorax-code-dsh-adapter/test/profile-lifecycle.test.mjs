import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { withDshPluginLifecycleLock } from "../src/profile-lifecycle.mjs";

test("quiesce publishes the inert authority without invoking DSH or removing Profiles", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "memorax-code-dsh-quiesce-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const memoraxCodeHome = join(root, "memorax-code-home");
  const dshHome = join(root, "dsh-home");
  const statePath = join(memoraxCodeHome, "adapters", "dsh", "state.json");
  const oldAdapterRoot = join(root, "previous-package", "lib", "memorax-code-dsh-adapter");
  const profileManifestPath = join(dshHome, "profiles", "web", "package.json");
  mkdirSync(join(dshHome, "profiles", "web"), { recursive: true });
  mkdirSync(join(memoraxCodeHome, "adapters", "dsh"), { recursive: true });
  writeFileSync(profileManifestPath, `${JSON.stringify({
    dependencies: { "@memorax-code/dsh-adapter": `file:${oldAdapterRoot}` },
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
  assert.equal(report.revision, state.updatedAt);
  assert.deepEqual(report.profiles, ["web"]);
  assert.equal(state.enabled, false);
  assert.equal(state.adapterRoot, oldAdapterRoot);
  assert.deepEqual(state.profiles, ["web"]);
  assert.equal(
    JSON.parse(readFileSync(profileManifestPath, "utf8"))
      .dependencies["@memorax-code/dsh-adapter"],
    `file:${oldAdapterRoot}`,
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
