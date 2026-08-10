import assert from "node:assert/strict";
import { mkdir, mkdtemp, copyFile, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const repoRoot = dirname(dirname(dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))));

async function copyNpmEntrypointFixture() {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-npm-entrypoint-"));
  const packageRoot = join(root, "package");
  await mkdir(join(packageRoot, "lib", "memorax-code-backend", "dist"), { recursive: true });
  await copyFile(
    join(repoRoot, "packages", "npm", "memorax-code", "lib", "run-entrypoint.mjs"),
    join(packageRoot, "lib", "run-entrypoint.mjs"),
  );
  await copyFile(
    join(repoRoot, "packages", "npm", "memorax-code", "lib", "node-version.mjs"),
    join(packageRoot, "lib", "node-version.mjs"),
  );
  await copyFile(
    join(repoRoot, "packages", "npm", "memorax-code", "lib", "resolve-codex-command.mjs"),
    join(packageRoot, "lib", "resolve-codex-command.mjs"),
  );
  await copyFile(
    join(repoRoot, "packages", "npm", "memorax-code", "lib", "resolve-claude-command.mjs"),
    join(packageRoot, "lib", "resolve-claude-command.mjs"),
  );
  await copyFile(
    join(repoRoot, "packages", "npm", "memorax-code", "lib", "vscode-extension-command.mjs"),
    join(packageRoot, "lib", "vscode-extension-command.mjs"),
  );
  return packageRoot;
}

test("npm wrapper imports backend entrypoints with argv[1] set to the target entrypoint", async () => {
  const packageRoot = await copyNpmEntrypointFixture();
  const observedPath = join(packageRoot, "observed.json");
  const target = join(packageRoot, "lib", "memorax-code-backend", "dist", "memorax-code.js");
  await writeFile(target, [
    "import { writeFileSync } from 'node:fs';",
    "writeFileSync(process.env.MEMORAX_CODE_TEST_OBSERVED_ARGV, JSON.stringify({ argv1: process.argv[1] }));",
  ].join("\n"));

  const originalArgv1 = process.argv[1];
  process.env.MEMORAX_CODE_TEST_OBSERVED_ARGV = observedPath;
  process.argv[1] = join(packageRoot, "bin", "memorax-code.mjs");
  try {
    const { runBackendEntrypoint } = await import(pathToFileURL(join(packageRoot, "lib", "run-entrypoint.mjs")).href);
    await runBackendEntrypoint("memorax-code.js");
  } finally {
    process.argv[1] = originalArgv1;
    delete process.env.MEMORAX_CODE_TEST_OBSERVED_ARGV;
  }

  const observed = JSON.parse(await readFile(observedPath, "utf8"));
  assert.equal(observed.argv1, await realpath(target));
});
