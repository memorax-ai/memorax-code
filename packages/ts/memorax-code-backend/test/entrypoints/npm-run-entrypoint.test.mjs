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
    join(repoRoot, "packages", "npm", "memorax-code", "lib", "resolve-codebuddy-command.mjs"),
    join(packageRoot, "lib", "resolve-codebuddy-command.mjs"),
  );
  await copyFile(
    join(repoRoot, "packages", "npm", "memorax-code", "lib", "windows-cli-invocation.mjs"),
    join(packageRoot, "lib", "windows-cli-invocation.mjs"),
  );
  await copyFile(
    join(repoRoot, "packages", "npm", "memorax-code", "lib", "resolve-claude-command.mjs"),
    join(packageRoot, "lib", "resolve-claude-command.mjs"),
  );
  await copyFile(
    join(repoRoot, "packages", "npm", "memorax-code", "lib", "vscode-extension-command.mjs"),
    join(packageRoot, "lib", "vscode-extension-command.mjs"),
  );
  await mkdir(join(packageRoot, "bin"), { recursive: true });
  await writeFile(join(packageRoot, "bin", "memorax-code.mjs"), "#!/usr/bin/env node\n");
  await writeFile(join(packageRoot, "package.json"), `${JSON.stringify({
    name: "@memorax/memorax-code",
    version: "0.1.9-test",
    type: "module",
  })}\n`);
  return packageRoot;
}

test("npm wrapper imports backend entrypoints with argv[1] set to the target entrypoint", async () => {
  const packageRoot = await copyNpmEntrypointFixture();
  const observedPath = join(packageRoot, "observed.json");
  const target = join(packageRoot, "lib", "memorax-code-backend", "dist", "memorax-code.js");
  await writeFile(target, [
    "import { writeFileSync } from 'node:fs';",
    "writeFileSync(process.env.MEMORAX_CODE_TEST_OBSERVED_ARGV, JSON.stringify({",
    "  argv1: process.argv[1],",
    "  packageRoot: process.env.MEMORAX_CODE_NPM_PACKAGE_ROOT,",
    "  packageVersion: process.env.MEMORAX_CODE_NPM_PACKAGE_VERSION,",
    "}));",
  ].join("\n"));

  const originalArgv1 = process.argv[1];
  const originalPackageRoot = process.env.MEMORAX_CODE_NPM_PACKAGE_ROOT;
  const originalPackageVersion = process.env.MEMORAX_CODE_NPM_PACKAGE_VERSION;
  process.env.MEMORAX_CODE_TEST_OBSERVED_ARGV = observedPath;
  process.argv[1] = join(packageRoot, "bin", "memorax-code.mjs");
  try {
    const { runBackendEntrypoint } = await import(pathToFileURL(join(packageRoot, "lib", "run-entrypoint.mjs")).href);
    await runBackendEntrypoint("memorax-code.js");
  } finally {
    process.argv[1] = originalArgv1;
    delete process.env.MEMORAX_CODE_TEST_OBSERVED_ARGV;
    if (originalPackageRoot === undefined) delete process.env.MEMORAX_CODE_NPM_PACKAGE_ROOT;
    else process.env.MEMORAX_CODE_NPM_PACKAGE_ROOT = originalPackageRoot;
    if (originalPackageVersion === undefined) delete process.env.MEMORAX_CODE_NPM_PACKAGE_VERSION;
    else process.env.MEMORAX_CODE_NPM_PACKAGE_VERSION = originalPackageVersion;
  }

  const observed = JSON.parse(await readFile(observedPath, "utf8"));
  assert.equal(observed.argv1, await realpath(target));
  assert.equal(observed.packageRoot, await realpath(packageRoot));
  assert.equal(observed.packageVersion, "0.1.9-test");
});
