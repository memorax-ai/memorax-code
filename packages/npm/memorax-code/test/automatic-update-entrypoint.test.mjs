import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("automatic update installs an exact latest version and runs non-interactive reconciliation", {
  skip: process.platform === "win32",
}, async () => {
  const fixture = await createFixture();
  try {
    await writeSetupCompletion(fixture.memoraxCodeHome, "0.1.9");
    const result = runAutomaticUpdate(fixture);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(await readJsonLines(fixture.npmLogPath), [
      ["view", "@memorax/memorax-code@latest", "version", "--json"],
      ["install", "-g", "@memorax/memorax-code@0.1.10"],
    ]);
    assert.deepEqual(await readJsonLines(fixture.setupLogPath), [{
      automaticUpdateMode: "1",
      home: fixture.memoraxCodeHome,
      updateMode: "1",
    }]);
    const state = JSON.parse(await readFile(
      join(fixture.memoraxCodeHome, "runtime", "install", "automatic-update.json"),
      "utf8",
    ));
    assert.equal(state.installedVersion, "0.1.10");
    assert.equal(state.outcome, "updated");
  } finally {
    await fixture.cleanup();
  }
});

test("automatic update respects the explicit opt-out", {
  skip: process.platform === "win32",
}, async () => {
  const fixture = await createFixture();
  try {
    await writeSetupCompletion(fixture.memoraxCodeHome, "0.1.9");
    const result = runAutomaticUpdate(fixture, { MEMORAX_CODE_AUTO_UPDATE: "false" });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(await readJsonLines(fixture.npmLogPath), []);
    assert.deepEqual(await readJsonLines(fixture.setupLogPath), []);
  } finally {
    await fixture.cleanup();
  }
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-automatic-entrypoint-"));
  const memoraxCodeHome = join(root, "memorax-code-home");
  const home = join(root, "home");
  const fakeBin = join(root, "fake-bin");
  const npmLogPath = join(root, "npm.jsonl");
  const setupLogPath = join(root, "setup.jsonl");
  for (const relativePath of [
    "bin/memorax-code.mjs",
    "lib/automatic-update.mjs",
    "lib/client-hook-runtime.mjs",
    "lib/node-version.mjs",
    "lib/npm-invocation.mjs",
    "lib/resolve-claude-command.mjs",
    "lib/resolve-codex-command.mjs",
    "lib/resolve-codebuddy-command.mjs",
    "lib/run-entrypoint.mjs",
    "lib/vscode-extension-command.mjs",
    "lib/windows-cli-invocation.mjs",
  ]) {
    const target = join(root, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await cp(join(packageRoot, relativePath), target);
  }
  const commonRoot = join(packageRoot, "..", "..", "ts", "memorax-code-adapter-common", "src");
  for (const relativePath of ["config-utils.mjs", "runtime-record.mjs", "setup-completion.mjs"]) {
    const target = join(root, "lib", "memorax-code-adapter-common", "src", relativePath);
    await mkdir(dirname(target), { recursive: true });
    await cp(join(commonRoot, relativePath), target);
  }
  await mkdir(fakeBin, { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(join(root, "package.json"), `${JSON.stringify({
    name: "@memorax/memorax-code",
    version: "0.1.9",
    type: "module",
  })}\n`);
  await writeFile(join(root, "bin", "memorax-code-setup.mjs"), [
    "import { appendFileSync } from 'node:fs';",
    "appendFileSync(process.env.MEMORAX_CODE_TEST_SETUP_LOG, JSON.stringify({",
    "  automaticUpdateMode: process.env.MEMORAX_CODE_SETUP_AUTOMATIC_UPDATE,",
    "  home: process.env.MEMORAX_CODE_HOME,",
    "  updateMode: process.env.MEMORAX_CODE_SETUP_UPDATE,",
    "}) + '\\n');",
    "",
  ].join("\n"));
  await writeFile(join(root, "bin", "memorax-cli.mjs"), "process.exit(1);\n");
  const backendEntrypoint = join(root, "lib", "memorax-code-backend", "dist", "memorax-code.js");
  await mkdir(dirname(backendEntrypoint), { recursive: true });
  await writeFile(backendEntrypoint, "process.exit(0);\n");

  const npmModule = join(fakeBin, "npm.mjs");
  await writeFile(npmModule, [
    "#!/usr/bin/env node",
    "import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    "const args = process.argv.slice(2);",
    "appendFileSync(process.env.MEMORAX_CODE_TEST_NPM_LOG, JSON.stringify(args) + '\\n');",
    "if (args[0] === 'view') console.log(JSON.stringify('0.1.10'));",
    "if (args[0] === 'install') {",
    "  const path = join(process.env.MEMORAX_CODE_HOME, 'runtime', 'setup', 'setup-completion.json');",
    "  const record = JSON.parse(readFileSync(path, 'utf8'));",
    "  writeFileSync(path, JSON.stringify({ ...record, completedByVersion: '0.1.10' }) + '\\n');",
    "}",
    "",
  ].join("\n"));
  await chmod(npmModule, 0o755);
  await symlink(basename(npmModule), join(fakeBin, "npm"));
  return {
    root,
    memoraxCodeHome,
    home,
    fakeBin,
    npmLogPath,
    setupLogPath,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

function runAutomaticUpdate(fixture, extraEnv = {}) {
  return spawnSync(process.execPath, [
    join(fixture.root, "bin", "memorax-code.mjs"),
    "update",
    "--automatic",
    "--home",
    fixture.memoraxCodeHome,
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: fixture.home,
      MEMORAX_CODE_TEST_NPM_LOG: fixture.npmLogPath,
      MEMORAX_CODE_TEST_SETUP_LOG: fixture.setupLogPath,
      PATH: `${fixture.fakeBin}${delimiter}${process.env.PATH ?? ""}`,
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5_000,
  });
}

async function writeSetupCompletion(memoraxCodeHome, version) {
  const path = join(memoraxCodeHome, "runtime", "setup", "setup-completion.json");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({
    version: 1,
    state: "complete",
    completedAt: "2026-08-30T08:00:00.000Z",
    completedByVersion: version,
  })}\n`);
}

async function readJsonLines(path) {
  try {
    return (await readFile(path, "utf8"))
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}
