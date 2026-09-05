import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { npmMainSourceTrees } from "../../../../scripts/npm-source-files.mjs";

const repoRoot = new URL("../../../../", import.meta.url);
const packageEntries = await readdir(new URL("packages/ts/", repoRoot), { withFileTypes: true });
const adapters = packageEntries
  .filter((entry) => entry.isDirectory() && /^memorax-code-.+-adapter$/.test(entry.name))
  .map(({ name }) => ({ name, id: name.slice("memorax-code-".length, -"-adapter".length) }))
  .sort((left, right) => left.id.localeCompare(right.id));

test("harness adapter packages and Backend client directories match", async () => {
  for (const { id } of adapters) {
    assert.match(id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, "harness IDs must use lowercase kebab-case for runtime scan coverage");
  }
  const entries = await readdir(new URL("packages/ts/memorax-code-backend/src/clients/", repoRoot), { withFileTypes: true });
  assert.deepEqual(
    adapters.map(({ id }) => id).sort(),
    entries.filter((entry) => entry.isDirectory()).map(({ name }) => name).sort(),
  );
});

for (const { name, id } of adapters) {
  test(`${id} runtime trees and canonical skill have npm source mappings`, async () => {
    const sourceRoot = `packages/ts/${name}`;
    const entries = await readdir(new URL(`${sourceRoot}/`, repoRoot), { withFileTypes: true });
    const runtimeDirectories = entries.filter((entry) => entry.isDirectory()
      && ["src", "hooks", "runtime-hooks", "scripts"].includes(entry.name));
    assert.ok(runtimeDirectories.some((entry) => entry.name === "src"), `${id}: missing adapter src`);
    for (const directory of runtimeDirectories) {
      assert.deepEqual(
        npmMainSourceTrees.filter(({ destination }) => destination === `lib/${name}/${directory.name}`)
          .map(({ source }) => source),
        [`${sourceRoot}/${directory.name}`],
        `${id}: declare ${directory.name} in npmMainSourceTrees`,
      );
    }
    const skillPath = `lib/${name}/skills/memorax-code/SKILL.md`;
    assert.deepEqual(
      npmMainSourceTrees.filter(({ destination }) => destination.startsWith(`lib/${name}/`)
        && skillPath.startsWith(`${destination}/`))
        .map(({ source, destination }) => `${source}${skillPath.slice(destination.length)}`),
      ["packages/ts/memorax-code-codex-adapter/skills/memorax-code/SKILL.md"],
      `${id}: stage the canonical shared skill exactly once`,
    );
  });
}

test("make test reaches every discovered adapter test suite", async () => {
  const makefile = await readFile(new URL("Makefile", repoRoot), "utf8");
  assert.ok(makefile.match(/^test:([^\n]*)/m)?.[1].split(/\s+/).includes("test-ts"), "make test must depend on test-ts");
  const recipes = new Map([...makefile.matchAll(/^([\w-]+):[^\n]*\n((?:\t[^\n]*(?:\n|$)|\r?\n)*)/gm)]
    .map(([, target, recipe]) => [target, recipe.split(/\r?\n/).map((line) => line.trim())]));
  for (const { name, id } of adapters) {
    const target = `test-${id}-adapter`;
    assert.ok(recipes.get("test-ts")?.includes(`$(MAKE) ${target}`), `${id}: test-ts must invoke ${target}`);
    assert.ok(
      recipes.get(target)?.includes(`$(NPM) test --prefix packages/ts/${name}`),
      `${id}: ${target} must run the adapter package tests`,
    );
    const manifest = JSON.parse(await readFile(new URL(`packages/ts/${name}/package.json`, repoRoot), "utf8"));
    assert.ok(manifest.scripts?.test, `${id}: missing package test script`);
  }
});
