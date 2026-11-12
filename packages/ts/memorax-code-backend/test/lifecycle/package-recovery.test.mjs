import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { freePort } from "../support/helpers.mjs";
import { packageRecoveryTransitionId, readPackageRecoveryRevision, writePackageRecoveryPermit, assertPackageRecoveryPermit, clearPackageRecoveryPermit } from "../../../memorax-code-adapter-common/src/package-recovery.mjs";
import { pathExists, runCli, writeManagedClientsConfig } from "./support/backend-service-fixtures.mjs";

const cliPath = fileURLToPath(new URL("../../dist/memorax-code.js", import.meta.url));
const transitionId = "35d4b870-1d33-49dc-81d8-d74e1ef0ad91";
const replacementEnv = {
  MEMORAX_CODE_PACKAGE_REPLACEMENT: "1",
  MEMORAX_CODE_PACKAGE_TRANSITION_ID: transitionId,
};

test("package restoration requires the exact current recovery permission", async (t) => {
  for (const [name, record] of [
    ["absent", undefined],
    ["malformed", "{"],
    ["other attempt", JSON.stringify({ version: 1, transitionId: "3acf329a-5629-4b88-bb04-aa3886a351d9" })],
    ["unknown fields", JSON.stringify({ version: 1, transitionId, extra: true })],
    ["unsupported", JSON.stringify({ version: 2, transitionId })],
  ]) {
    await t.test(name, async () => {
      const fixture = await createFixture();
      try {
        if (record !== undefined) await writeFile(fixture.permitPath, record);
        const result = await fixture.run("start", replacementEnv);
        assert.equal(result.code, 1, result.stdout + result.stderr);
        const report = JSON.parse(result.stdout);
        assert.equal(report.failure.stage, "recovery_authority");
        assert.equal(report.failure.errorCode, "PACKAGE_RECOVERY_PERMISSION_INVALID");
        assert.equal(report.diagnostic.recorded, true);
        const recordText = await readFile(report.diagnostic.path, "utf8");
        assert.doesNotMatch(recordText, new RegExp(transitionId));
        assert.equal(recordText.includes(fixture.home), false);
        assert.equal(await pathExists(fixture.pidPath), false);
        if (record !== undefined) assert.equal(await readFile(fixture.permitPath, "utf8"), record);
      } finally {
        await fixture.cleanup();
      }
    });
  }
});

test("replacement stop permits its restore and a later backend-only user stop revokes it", async () => {
  const fixture = await createFixture();
  try {
    const retired = await fixture.run("stop", replacementEnv);
    assert.equal(retired.code, 0, retired.stdout + retired.stderr);
    assert.deepEqual(JSON.parse(await readFile(fixture.permitPath, "utf8")), { version: 1, transitionId });
    const restored = await fixture.run("start", replacementEnv);
    assert.equal(restored.code, 0, restored.stdout + restored.stderr);
    assert.equal(JSON.parse(restored.stdout).backend.ok, true);
    const stopped = await fixture.run("stop");
    assert.equal(stopped.code, 0, stopped.stdout + stopped.stderr);
    assert.match(readPackageRecoveryRevision(fixture.home), /^stopped:/);
    const retry = await fixture.run("start", replacementEnv);
    assert.equal(retry.code, 1);
    assert.equal(JSON.parse(retry.stdout).failure.recordReason, "revision_changed");
    assert.equal(await pathExists(fixture.pidPath), false);
  } finally {
    await fixture.cleanup();
  }
});

test("failed restoration retains permission for the same attempt", async () => {
  const fixture = await createFixture();
  try {
    const retired = await fixture.run("stop", replacementEnv);
    assert.equal(retired.code, 0, retired.stdout + retired.stderr);
    const original = await readFile(fixture.permitPath, "utf8");
    await writeFile(join(fixture.home, "config.toml"), '[clients]\ncodex = "invalid"\n');
    assert.equal((await fixture.run("start", replacementEnv)).code, 1);
    assert.equal(await readFile(fixture.permitPath, "utf8"), original);
    await writeManagedClientsConfig(fixture.home, { codex: false, claude: false });
    assert.equal((await fixture.run("start", replacementEnv)).code, 0);
  } finally {
    await fixture.cleanup();
  }
});

test("ordinary stop, restart, and uninstall revoke malformed or leftover recovery permission", async (t) => {
  for (const action of ["stop", "restart", "uninstall"]) {
    await t.test(action, async () => {
      const fixture = await createFixture();
      try {
        await writeFile(fixture.permitPath, "{");
        const result = await fixture.run(action);
        assert.equal(result.code, 0, result.stdout + result.stderr);
        assert.match(readPackageRecoveryRevision(fixture.home), /^stopped:/);
      } finally {
        await fixture.cleanup();
      }
    });
  }
});

test("restored Backend does not pass the transition credential to its future updater", async () => {
  const fixture = await createFixture();
  const packageRoot = join(fixture.root, "package");
  const command = join(packageRoot, "bin", "memorax-code.mjs");
  const observedPath = join(fixture.root, "updater.json");
  try {
    await mkdir(dirname(command), { recursive: true });
    await writeFile(command, [
      'import { writeFileSync } from "node:fs";',
      'writeFileSync(process.env.MEMORAX_CODE_TEST_UPDATE_RECORD, JSON.stringify({ transitionId: process.env.MEMORAX_CODE_PACKAGE_TRANSITION_ID ?? null, stopRevision: process.env.MEMORAX_CODE_PACKAGE_STOP_REVISION ?? null }));',
    ].join("\n"));
    const setupPath = join(fixture.home, "runtime", "setup", "setup-completion.json");
    await mkdir(dirname(setupPath), { recursive: true });
    await writeFile(setupPath, JSON.stringify({ version: 1, state: "complete", completedAt: new Date().toISOString(), completedByVersion: "0.1.17" }));
    assert.equal((await fixture.run("stop", replacementEnv)).code, 0);
    const restored = await fixture.run("start", {
      ...replacementEnv,
      MEMORAX_CODE_AUTO_UPDATE: "1",
      MEMORAX_CODE_AUTOMATIC_UPDATE_PROCESS: "",
      MEMORAX_CODE_NPM_PACKAGE_ROOT: packageRoot,
      MEMORAX_CODE_NPM_PACKAGE_VERSION: "0.1.17",
      MEMORAX_CODE_TEST_UPDATE_RECORD: observedPath,
    });
    assert.equal(restored.code, 0, restored.stdout + restored.stderr);
    for (let attempt = 0; attempt < 100 && !await pathExists(observedPath); attempt += 1) await delay(25);
    assert.deepEqual(JSON.parse(await readFile(observedPath, "utf8")), { transitionId: null, stopRevision: null });
  } finally {
    await fixture.cleanup();
  }
});

test("empty transition identity is unset and invalid nonempty identity is rejected", () => {
  assert.equal(packageRecoveryTransitionId({ MEMORAX_CODE_PACKAGE_TRANSITION_ID: "" }), undefined);
  assert.throws(() => packageRecoveryTransitionId({ MEMORAX_CODE_PACKAGE_TRANSITION_ID: "invalid" }), /valid transition ID/);
});

test("a user stop before retirement prevents a queued replacement from granting permission", async () => {
  const fixture = await createFixture();
  try {
    const revision = readPackageRecoveryRevision(fixture.home);
    assert.equal((await fixture.run("stop")).code, 0);
    const stopped = readPackageRecoveryRevision(fixture.home);
    const retired = await fixture.run("stop", { ...replacementEnv, MEMORAX_CODE_PACKAGE_STOP_REVISION: revision });
    assert.equal(retired.code, 1, retired.stdout + retired.stderr);
    assert.equal(readPackageRecoveryRevision(fixture.home), stopped);
    assert.equal((await fixture.run("start", replacementEnv)).code, 1);
    assert.equal(await pathExists(fixture.pidPath), false);
  } finally {
    await fixture.cleanup();
  }
});

test("legacy replacement without a stop snapshot does not grant recovery permission", async () => {
  const fixture = await createFixture();
  try {
    const retired = await fixture.run("stop", { ...replacementEnv, MEMORAX_CODE_PACKAGE_STOP_REVISION: "" });
    assert.equal(retired.code, 0, retired.stdout + retired.stderr);
    assert.equal(readPackageRecoveryRevision(fixture.home), "absent");
    assert.equal((await fixture.run("start", replacementEnv)).code, 1);
    const explicit = await fixture.run("start", { ...replacementEnv, MEMORAX_CODE_PACKAGE_TRANSITION_ID: "" });
    assert.equal(explicit.code, 0, explicit.stdout + explicit.stderr);
  } finally {
    await fixture.cleanup();
  }
});

test("ordinary stop and uninstall support a Home directory alias", async () => {
  const fixture = await createFixture();
  const alias = join(fixture.root, "home-alias");
  try {
    await symlink(fixture.home, alias, process.platform === "win32" ? "junction" : "dir");
    for (const action of ["stop", "uninstall"]) {
      writePackageRecoveryPermit(alias, transitionId);
      assertPackageRecoveryPermit(alias, transitionId);
      const result = await runCli(cliPath, [action, "--json", "--home", alias, "--clients", "none",
        ...(action === "uninstall" ? ["--no-npm-uninstall"] : [])], {
        env: { MEMORAX_CODE_AUTO_UPDATE: "0", MEMORAX_CODE_INSTALL_WATCHDOG: "0" },
      });
      assert.equal(result.code, 0, result.stdout + result.stderr);
      assert.match(readPackageRecoveryRevision(fixture.home), /^stopped:/);
      assert.equal(readPackageRecoveryRevision(alias), readPackageRecoveryRevision(fixture.home));
    }
  } finally {
    await fixture.cleanup();
  }
});

test("recovery permission operations reject directory links before touching external state", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-permission-links-"));
  const home = join(root, "home");
  const alias = join(root, "home-alias");
  const outside = join(root, "outside");
  const outsidePermit = join(outside, "package-recovery.json");
  const original = JSON.stringify({ version: 1, transitionId });
  try {
    await mkdir(join(home, "runtime"), { recursive: true });
    await symlink(home, alias, process.platform === "win32" ? "junction" : "dir");
    await mkdir(outside);
    await writeFile(outsidePermit, original);
    await symlink(outside, join(home, "runtime", "install"), process.platform === "win32" ? "junction" : "dir");
    for (const path of [home, alias]) {
      assert.throws(() => clearPackageRecoveryPermit(path), /invalid_parent_path/);
      assert.throws(() => writePackageRecoveryPermit(path, transitionId), /invalid_parent_path/);
      assert.throws(() => assertPackageRecoveryPermit(path, transitionId), /invalid_parent_path/);
    }
    assert.equal(await readFile(outsidePermit, "utf8"), original);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-package-permission-"));
  const home = join(root, "home");
  const permitPath = join(home, "runtime", "install", "package-recovery.json");
  const pidPath = join(home, "runtime", "backend", "backend.pid.json");
  const port = await freePort();
  await writeManagedClientsConfig(home, { codex: false, claude: false });
  await mkdir(dirname(permitPath), { recursive: true });
  const run = (action, env = {}) => runCli(cliPath, [action, "--json", "--home", home, "--port", String(port), "--clients", "none", ...(action === "uninstall" ? ["--no-npm-uninstall"] : [])], {
    env: { MEMORAX_CODE_AUTO_UPDATE: "0", MEMORAX_CODE_INSTALL_WATCHDOG: "0",
      ...(action === "stop" && env.MEMORAX_CODE_PACKAGE_REPLACEMENT === "1"
        ? { MEMORAX_CODE_PACKAGE_STOP_REVISION: readPackageRecoveryRevision(home) } : {}),
      ...env },
  });
  return {
    root, home, permitPath, pidPath, run,
    async cleanup() {
      try {
        await run("stop");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  };
}
