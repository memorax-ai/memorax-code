import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const entrypoint = fileURLToPath(new URL("./codebuddy-install-interruption-check.mjs", import.meta.url));

async function createFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "native-interruption-prerequisites-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageRoot = join(root, "package"), dependencies = join(root, "dependencies");
  const commonCommand = join(packageRoot, "lib/memorax-code-adapter-common/src/clients/codebuddy-command.mjs");
  await mkdir(dirname(commonCommand), { recursive: true });
  await copyFile(new URL("../../../packages/ts/memorax-code-adapter-common/src/clients/codebuddy-command.mjs", import.meta.url), commonCommand);
  await mkdir(join(dependencies, "node_modules/node-pty"), { recursive: true });
  await writeFile(join(dependencies, "package.json"), "{}");
  // Accepted prerequisites stop before PTY loading, mutation, or native execution.
  await writeFile(join(dependencies, "node_modules/node-pty/package.json"), '{"version":"0.0.0"}');
  const bundledCommand = process.platform === "win32"
    ? join(root, "WorkBuddy/resources/app.asar.unpacked/cli/bin/codebuddy.exe")
    : join(root, "WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy");
  await mkdir(dirname(bundledCommand), { recursive: true });
  await writeFile(bundledCommand, "not an executable fixture\n");
  const env = { HOME: root, USERPROFILE: root, MEMORAX_CODE_HOME: join(root, "state"),
    ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {}) };
  return {
    root, bundledCommand,
    run({ client, version = "1.2.3", command = bundledCommand, extra = [] } = {}) {
      const args = [entrypoint, packageRoot, command, dependencies, version,
        ...(client === undefined ? [] : [client]), ...extra];
      const result = spawnSync(process.execPath, args, { env, encoding: "utf8", timeout: 5_000 });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 1);
      assert.equal(result.stderr, "");
      const report = JSON.parse(result.stdout);
      assert.equal(report.status, "FAIL");
      assert.deepEqual(report.cases, []);
      return report;
    },
  };
}

for (const client of [undefined, "codebuddy", "workbuddy"]) {
  test(`setup interruption accepts ${client ?? "legacy CodeBuddy"} arguments before the PTY gate`, async (t) => {
    const fixture = await createFixture(t);
    const report = fixture.run({ client });
    assert.equal(report.error, "UNEXPECTED_PTY_DEPENDENCY_VERSION");
    assert.equal(report.suite, `${client ?? "codebuddy"}_setup_interruption`);
    assert.equal(report[client === "workbuddy" ? "bundledRuntimeVersion" : "codebuddyVersion"], "1.2.3");
    if (client === "workbuddy") {
      assert.equal(report.codebuddyVersion, undefined);
      assert.equal(report.desktopUIValidated, false);
      assert.equal(report.loginFlowValidated, false);
    }
  });
}

test("setup interruption rejects unsupported clients before command or dependency discovery", async (t) => {
  const fixture = await createFixture(t);
  for (const client of ["", "claude", "WorkBuddy", "../workbuddy"]) {
    assert.equal(fixture.run({ client, command: join(fixture.root, "missing-command") }).error, "NATIVE_CLIENT_INVALID");
  }
});

test("setup interruption rejects excess arguments before any native setup", async (t) => {
  const fixture = await createFixture(t);
  assert.equal(fixture.run({ client: "workbuddy", extra: ["extra"] }).error,
    "EXPECTED_PACKAGE_NATIVE_PTY_PATHS_VERSION_AND_OPTIONAL_CLIENT");
});

for (const client of ["codebuddy", "workbuddy"]) {
  test(`setup interruption requires an exact ${client} runtime version`, async (t) => {
    const fixture = await createFixture(t);
    assert.equal(fixture.run({ client, version: "latest", command: join(fixture.root, "missing-command") }).error,
      `EXPECTED_${client.toUpperCase()}_VERSION_INVALID`);
  });
}

test("WorkBuddy setup interruption rejects an independent CLI before PTY loading", async (t) => {
  const fixture = await createFixture(t);
  assert.equal(fixture.run({ client: "workbuddy", command: process.execPath }).error, "EXPECTED_WORKBUDDY_BUNDLED_RUNTIME");
});

test("WorkBuddy setup interruption checks the canonical runtime behind a bundled-path alias", async (t) => {
  const fixture = await createFixture(t);
  const external = join(fixture.root, "standalone");
  await mkdir(external);
  const commandName = process.platform === "win32" ? "codebuddy.exe" : "codebuddy";
  await writeFile(join(external, commandName), "not an executable fixture\n");
  await rm(dirname(fixture.bundledCommand), { recursive: true });
  await symlink(external, dirname(fixture.bundledCommand), process.platform === "win32" ? "junction" : "dir");
  assert.equal(fixture.run({ client: "workbuddy" }).error, "EXPECTED_WORKBUDDY_BUNDLED_RUNTIME");
});
