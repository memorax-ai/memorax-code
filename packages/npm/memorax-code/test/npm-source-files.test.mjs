import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  copyDeclaredNpmSourceTree,
  createDeclaredNpmSourceFiles,
  npmMainSourceTrees,
  npmMarketplaceAliases,
} from "../../../../scripts/npm-source-files.mjs";

test("npm source staging copies tracked files only", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-npm-sources-"));
  const source = "packages/ts/memorax-code-codex-adapter/skills/example";
  const destination = join(root, "staged");
  try {
    await mkdir(join(root, source), { recursive: true });
    await writeFile(join(root, source, "SKILL.md"), "tracked\n");
    await writeFile(join(root, source, "temporary-untracked.md"), "must not ship\n");
    const declaredFiles = createDeclaredNpmSourceFiles([`${source}/SKILL.md`]);

    await copyDeclaredNpmSourceTree({ repoRoot: root, source, destination, declaredFiles });

    assert.equal((await stat(join(destination, "SKILL.md"))).isFile(), true);
    assert.equal(
      await stat(join(destination, "temporary-untracked.md")).catch(() => undefined),
      undefined,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("untracked Claude skill sources map to marketplace package aliases", () => {
  assert.deepEqual(
    npmMarketplaceAliases("lib/memorax-code-claude-adapter/skills/memorax-code/temporary.md"),
    [
      "lib/memorax-code-claude-marketplace/plugins/memorax-code-claude-adapter/skills/memorax-code/temporary.md",
    ],
  );
});

test("Codex plugin assets are declared npm source trees", () => {
  assert.ok(npmMainSourceTrees.some((mapping) => (
    mapping.source === "packages/ts/memorax-code-codex-adapter/assets"
    && mapping.destination === "lib/memorax-code-codex-adapter/assets"
  )));
});
