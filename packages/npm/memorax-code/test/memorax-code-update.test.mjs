import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

async function createPackageFixture(version) {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-update-test-"));
  await mkdir(join(root, "bin"), { recursive: true });
  await mkdir(join(root, "lib"), { recursive: true });
  await cp(join(packageRoot, "bin", "memorax-code.mjs"), join(root, "bin", "memorax-code.mjs"));
  await cp(join(packageRoot, "lib", "client-hook-runtime.mjs"), join(root, "lib", "client-hook-runtime.mjs"));
  await cp(join(packageRoot, "lib", "node-version.mjs"), join(root, "lib", "node-version.mjs"));
  await cp(join(packageRoot, "lib", "npm-invocation.mjs"), join(root, "lib", "npm-invocation.mjs"));
  await cp(join(packageRoot, "lib", "run-entrypoint.mjs"), join(root, "lib", "run-entrypoint.mjs"));
  await cp(join(packageRoot, "lib", "resolve-claude-command.mjs"), join(root, "lib", "resolve-claude-command.mjs"));
  await cp(join(packageRoot, "lib", "resolve-codex-command.mjs"), join(root, "lib", "resolve-codex-command.mjs"));
  await cp(join(packageRoot, "lib", "windows-cli-invocation.mjs"), join(root, "lib", "windows-cli-invocation.mjs"));
  await cp(join(packageRoot, "lib", "vscode-extension-command.mjs"), join(root, "lib", "vscode-extension-command.mjs"));
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  manifest.version = version;
  await writeFile(join(root, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return root;
}

function runUpdate(root, ...args) {
  return spawnSync(process.execPath, [join(root, "bin", "memorax-code.mjs"), "update", ...args], {
    encoding: "utf8",
  });
}

test("memorax-code update preserves the installed release channel", async (t) => {
  for (const [name, version, channel] of [
    ["preview", "0.0.1-preview.1", "preview"],
    ["stable", "0.0.1", "latest"],
  ]) {
    await t.test(name, async () => {
      const root = await createPackageFixture(version);
      try {
        const result = runUpdate(root, "--dry-run");
        assert.equal(result.status, 0, result.stderr);
        assert.equal(
          result.stdout.trim(),
          `npm install -g @memorax/memorax-code@${channel}`,
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("memorax-code update supports explicit channel selection and force", async () => {
  const root = await createPackageFixture("0.0.1-preview.1");
  try {
    const latest = runUpdate(root, "--latest", "--dry-run");
    assert.equal(latest.status, 0, latest.stderr);
    assert.equal(
      latest.stdout.trim(),
      "npm install -g @memorax/memorax-code@latest",
    );

    const previewForce = runUpdate(root, "--force", "--preview", "--dry-run");
    assert.equal(previewForce.status, 0, previewForce.stderr);
    assert.equal(
      previewForce.stdout.trim(),
      "npm install -g @memorax/memorax-code@preview --force",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("memorax-code update rejects conflicting channels", async () => {
  const root = await createPackageFixture("0.0.1-preview.1");
  try {
    const result = runUpdate(root, "--preview", "--latest", "--dry-run");
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--preview and --latest cannot be used together/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("memorax-code update propagates an explicit home to package transition scripts", {
  skip: process.platform === "win32",
}, async () => {
  const root = await createPackageFixture("0.0.1");
  const fakeBin = join(root, "fake-bin");
  const capturePath = join(root, "npm-invocation.json");
  const memoraxCodeHome = join(root, "custom memorax-code home");
  try {
    await mkdir(fakeBin, { recursive: true });
    const npmStub = join(fakeBin, "npm");
    const npmStubModule = `${npmStub}.mjs`;
    await writeFile(npmStubModule, [
      "#!/usr/bin/env node",
      "import { writeFileSync } from 'node:fs';",
      "writeFileSync(process.env.MEMORAX_CODE_UPDATE_CAPTURE, JSON.stringify({",
      "  args: process.argv.slice(2),",
      "  memoraxCodeHome: process.env.MEMORAX_CODE_HOME,",
      "}));",
      "",
    ].join("\n"));
    await chmod(npmStubModule, 0o755);
    await symlink(basename(npmStubModule), npmStub);

    const result = spawnSync(
      process.execPath,
      [join(root, "bin", "memorax-code.mjs"), "update", "--home", memoraxCodeHome],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
          MEMORAX_CODE_UPDATE_CAPTURE: capturePath,
          MEMORAX_CODE_HOME: join(root, "wrong-home"),
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(await readFile(capturePath, "utf8")), {
      args: [
        "install",
        "-g",
        "@memorax/memorax-code@latest",
      ],
      memoraxCodeHome,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("memorax-code update rejects a missing home value", async () => {
  const root = await createPackageFixture("0.0.1");
  try {
    const result = runUpdate(root, "--home");
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--home requires a directory/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
