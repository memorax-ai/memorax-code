import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    const files = new Map();
    addFixtureField(files, RELEASE_VERSION_AUTHORITY, "1.2.3");
    for (const target of RELEASE_VERSION_TARGETS) addFixtureField(files, target, "0.0.0");
    for (const [file, document] of files) {
      const path = join(root, file);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    }

    const checked = await syncReleaseVersion({ root });
    assert.equal(checked.ok, false);
    assert.equal(checked.version, "1.2.3");
    assert.equal(checked.mismatches.length, RELEASE_VERSION_TARGETS.length);

    const written = await syncReleaseVersion({ root, write: true });
    assert.equal(written.ok, true);
    assert.deepEqual(written.changedFiles.sort(), [
      ...new Set(RELEASE_VERSION_TARGETS.map((target) => target.file)),
    ].sort());

    const rechecked = await syncReleaseVersion({ root });
    assert.equal(rechecked.ok, true);
    assert.equal(rechecked.mismatches.length, 0);
    const authority = JSON.parse(await readFile(join(root, RELEASE_VERSION_AUTHORITY.file), "utf8"));
    assert.equal(authority.fixtureMarker, "preserved");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release version targets include every adapter package", () => {
  const targetFiles = RELEASE_VERSION_TARGETS.map((target) => target.file);
  assert.ok(targetFiles.includes("packages/ts/memorax-code-codex-adapter/package.json"));
  assert.ok(targetFiles.includes("packages/ts/memorax-code-claude-adapter/package.json"));
  assert.ok(targetFiles.includes("packages/ts/memorax-code-dsh-adapter/package.json"));
});

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
