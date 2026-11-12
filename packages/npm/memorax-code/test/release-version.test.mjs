import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  RELEASE_VERSION_AUTHORITY,
  RELEASE_VERSION_TARGETS,
  syncReleaseVersion,
} from "../../../../scripts/sync-release-version.mjs";

test("release version check detects drift and write aligns only declared targets", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-release-version-"));
  try {
    const files = new Map([
      ["unrelated.json", { version: "9.9.9", fixtureMarker: "preserved" }],
    ]);
    addFixtureField(files, RELEASE_VERSION_AUTHORITY, "1.2.3");
    for (const target of RELEASE_VERSION_TARGETS) addFixtureField(files, target, "0.0.0");
    for (const [file, document] of files) {
      const path = join(root, file);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    }
    const dryRunEntries = process.platform === "win32" ? [] : await prepareDryRunEntries(root);

    const checked = await syncReleaseVersion({ root });
    assert.equal(checked.ok, false);
    assert.equal(checked.version, "1.2.3");
    assert.equal(checked.mismatches.length, RELEASE_VERSION_TARGETS.length);
    for (const [file, document] of files) {
      assert.equal(
        await readFile(join(root, file), "utf8"),
        `${JSON.stringify(document, null, 2)}\n`,
        `${file}: check must leave the original bytes unchanged`,
      );
    }
    for (const run of dryRunEntries) {
      const result = run();
      assert.notEqual(result.status, 0, result.stderr);
      assert.match(result.stderr, /expected 1\.2\.3/);
      assert.doesNotMatch(result.stderr, /fixture build reached/);
    }

    const written = await syncReleaseVersion({ root, write: true });
    assert.equal(written.ok, true);
    assert.deepEqual(written.changedFiles.sort(), [
      ...new Set(RELEASE_VERSION_TARGETS.map((target) => target.file)),
    ].sort());
    for (const target of RELEASE_VERSION_TARGETS) addFixtureField(files, target, "1.2.3");
    for (const [file, document] of files) {
      assert.deepEqual(
        JSON.parse(await readFile(join(root, file), "utf8")),
        document,
        `${file}: write must update only declared version fields`,
      );
    }

    const rechecked = await syncReleaseVersion({ root });
    assert.equal(rechecked.ok, true);
    assert.equal(rechecked.mismatches.length, 0);
    for (const run of dryRunEntries) {
      const result = run();
      assert.match(result.stderr, /fixture build reached/);
      assert.equal((result.stdout.match(/release version 1\.2\.3: all targets match/g) ?? []).length, 1);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function prepareDryRunEntries(root) {
  await mkdir(join(root, "scripts"));
  await mkdir(join(root, "bin"));
  for (const path of ["Makefile", "scripts/npm-publish-dry-run.sh", "scripts/sync-release-version.mjs"]) {
    await copyFile(new URL(`../../../../${path}`, import.meta.url), join(root, path));
  }
  await symlink(process.execPath, join(root, "bin", "node"));
  // Stop at the first build operation so this fixture cannot install or publish.
  await writeFile(join(root, "scripts", "build-npm-packages.sh"),
    "#!/usr/bin/env bash\necho 'fixture build reached' >&2\nexit 73\n", { mode: 0o755 });
  return [
    ["bash", ["scripts/npm-publish-dry-run.sh"]],
    ["make", ["npm-publish-dry-run"]],
  ].map(([command, args]) => () => spawnSync(command, args, {
    cwd: root,
    env: { PATH: `${join(root, "bin")}:/usr/bin:/bin`, HOME: root },
    encoding: "utf8",
    timeout: 5000,
  }));
}

function addFixtureField(files, target, value) {
  const document = files.get(target.file) ?? { fixtureMarker: "preserved" };
  let current = document;
  for (const key of target.field.slice(0, -1)) {
    current[key] ??= {};
    current = current[key];
  }
  current[target.field.at(-1)] = value;
  files.set(target.file, document);
}
