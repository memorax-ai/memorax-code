import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

async function createPackageFixture(version) {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-update-test-"));
  const commonRoot = join(packageRoot, "..", "..", "ts", "memorax-code-adapter-common", "src");
  await mkdir(join(root, "bin"), { recursive: true });
  await mkdir(join(root, "lib"), { recursive: true });
  await mkdir(join(root, "lib", "memorax-code-adapter-common", "src"), { recursive: true });
  await cp(join(packageRoot, "bin", "memorax-code.mjs"), join(root, "bin", "memorax-code.mjs"));
  await cp(join(packageRoot, "lib", "automatic-update.mjs"), join(root, "lib", "automatic-update.mjs"));
  await cp(join(packageRoot, "lib", "update-diagnostics.mjs"), join(root, "lib", "update-diagnostics.mjs"));
  await cp(join(packageRoot, "lib", "setup-diagnostics.mjs"), join(root, "lib", "setup-diagnostics.mjs"));
  await cp(join(packageRoot, "lib", "client-hook-runtime.mjs"), join(root, "lib", "client-hook-runtime.mjs"));
  await cp(join(packageRoot, "lib", "node-version.mjs"), join(root, "lib", "node-version.mjs"));
  await cp(join(packageRoot, "lib", "npm-invocation.mjs"), join(root, "lib", "npm-invocation.mjs"));
  for (const name of [
    "clients/codebuddy-command.mjs",
    "config-utils.mjs", "diagnostic-record.mjs", "deployment-failure.mjs",
    "automatic-update-state.mjs",
    "runtime-record.mjs",
    "setup-completion.mjs",
  ]) {
    const target = join(root, "lib", "memorax-code-adapter-common", "src", name);
    await mkdir(dirname(target), { recursive: true });
    await cp(join(commonRoot, name), target);
  }
  await cp(join(packageRoot, "lib", "run-entrypoint.mjs"), join(root, "lib", "run-entrypoint.mjs"));
  await cp(join(packageRoot, "lib", "setup-api-key-input.mjs"), join(root, "lib", "setup-api-key-input.mjs"));
  await cp(join(packageRoot, "lib", "resolve-claude-command.mjs"), join(root, "lib", "resolve-claude-command.mjs"));
  await cp(join(packageRoot, "lib", "resolve-codex-command.mjs"), join(root, "lib", "resolve-codex-command.mjs"));
  await cp(join(packageRoot, "lib", "resolve-codebuddy-command.mjs"), join(root, "lib", "resolve-codebuddy-command.mjs"));
  await cp(join(packageRoot, "lib", "windows-cli-invocation.mjs"), join(root, "lib", "windows-cli-invocation.mjs"));
  await cp(join(packageRoot, "lib", "windows-user-path.mjs"), join(root, "lib", "windows-user-path.mjs"));
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

test("memorax-code update rejects conflicting channels and recovery options", async () => {
  const root = await createPackageFixture("0.0.1-preview.1");
  try {
    const result = runUpdate(root, "--preview", "--latest", "--dry-run");
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--preview and --latest cannot be used together/);
    for (const option of ["--preview", "--latest", "--force", "--dry-run", "--automatic"]) {
      const recovery = runUpdate(root, "--recover", option);
      assert.equal(recovery.status, 2);
      assert.match(recovery.stderr, /--recover cannot be combined/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("memorax-code update resolves argument and environment homes before npm changes cwd", {
  skip: process.platform === "win32",
}, async () => {
  const root = await realpath(await createPackageFixture("0.0.1"));
  const fakeBin = join(root, "fake-bin");
  const capturePath = join(root, "npm-invocation.json");
  const userHome = join(root, "user-home");
  const relativeHome = "./custom memorax-code home";
  const memoraxCodeHome = join(root, relativeHome);
  try {
    await mkdir(fakeBin, { recursive: true });
    await mkdir(userHome, { recursive: true });
    const npmStub = join(fakeBin, "npm");
    const npmStubModule = `${npmStub}.mjs`;
    await writeFile(npmStubModule, [
      "#!/usr/bin/env node",
      "import { writeFileSync } from 'node:fs';",
      "writeFileSync(process.env.MEMORAX_CODE_UPDATE_CAPTURE, JSON.stringify({",
      "  args: process.argv.slice(2),",
      "  cwd: process.cwd(),",
      "  memoraxCodeHome: process.env.MEMORAX_CODE_HOME,",
      "}));",
      "",
    ].join("\n"));
    await chmod(npmStubModule, 0o755);
    await symlink(basename(npmStubModule), npmStub);

    for (const [args, envHome] of [
      [["--home", relativeHome], join(root, "wrong-home")],
      [[], relativeHome],
    ]) {
      const result = spawnSync(
        process.execPath,
        [join(root, "bin", "memorax-code.mjs"), "update", ...args],
        {
          cwd: root,
          encoding: "utf8",
          env: {
            ...process.env,
            HOME: userHome,
            PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
            MEMORAX_CODE_UPDATE_CAPTURE: capturePath,
            MEMORAX_CODE_HOME: envHome,
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
        cwd: userHome,
        memoraxCodeHome,
      });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("manual update retains npm failure status and emits a safe diagnostic by default", async (t) => {
  for (const mode of ["spawn", "exit"]) {
    await t.test(mode, async () => {
      const root = await createPackageFixture("0.1.9");
      const home = join(root, "isolated-home");
      try {
        await writeFile(join(root, "lib", "npm-invocation.mjs"), [
          'export async function runNpmCommand() {',
          mode === "spawn"
            ? '  throw Object.assign(new Error("private-npm-error-canary"), { code: "EACCES" });'
            : '  return { exitCode: 7, signal: null };',
          '}',
          'export { runNpmCommand as resolveNpmInvocation, runNpmCommand as resolveNpmExecPath, runNpmCommand as npmCommandCwd, runNpmCommand as waitForChildProcess };',
        ].join("\n"));
        const result = runUpdate(root, "--home", home);
        assert.equal(result.status, mode === "spawn" ? 1 : 7, result.stderr);
        assert.match(result.stderr, /\[UPDATE_INSTALL_FAILED\] install:/);
        assert.doesNotMatch(result.stderr, /private-npm-error-canary/);
        const directory = join(home, "runtime", "diagnostics");
        const files = await readdir(directory);
        assert.equal(files.length, 1);
        const text = await readFile(join(directory, files[0]), "utf8");
        const record = JSON.parse(text);
        assert.equal(record.errorCode, "UPDATE_INSTALL_FAILED");
        assert.equal(record.stage, "install");
        assert.equal(record.systemCode, mode === "spawn" ? "EACCES" : undefined);
        assert.equal(record.commandExitCode, mode === "exit" ? 7 : undefined);
        assert.equal(text.includes(root), false);
        assert.doesNotMatch(text, /private-npm-error-canary/);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("manual and automatic npm failures reuse their lifecycle hook diagnostic", async (t) => {
  for (const [mode, hook] of [["manual", "memorax-code-npm-preinstall.mjs"], ["automatic", "memorax-code-plugin-postinstall.mjs"]]) {
    await t.test(mode, async () => {
      const root = await createPackageFixture("0.1.9");
      const home = join(root, "isolated-home");
      try {
        await cp(join(packageRoot, "bin", hook), join(root, "bin", hook));
        await cp(join(packageRoot, "lib", "package-transition.mjs"), join(root, "lib", "package-transition.mjs"));
        for (const directory of ["backend", "install", "setup"]) await mkdir(join(home, "runtime", directory), { recursive: true });
        await writeFile(join(home, "runtime", "backend", "backend.pid.json"), "{}");
        await writeFile(join(home, "runtime", "install", "package-transition.json"), "{private-transition-canary");
        await writeFile(join(home, "runtime", "setup", "setup-completion.json"), JSON.stringify({
          version: 1, state: "complete", completedAt: "2026-08-30T08:00:00.000Z", completedByVersion: "0.1.9",
        }));
        await writeFile(join(root, "lib", "npm-invocation.mjs"), [
          'import { spawnSync } from "node:child_process";',
          'import { writeFileSync } from "node:fs";',
          'import { fileURLToPath } from "node:url";',
          'export async function runNpmCommand(args, options) {',
          '  writeFileSync(new URL("../relay-path.txt", import.meta.url), options.env.MEMORAX_CODE_UPDATE_DIAGNOSTIC_PATH);',
          `  const child = spawnSync(process.execPath, [fileURLToPath(new URL("../bin/${hook}", import.meta.url))], options);`,
          '  if (child.status !== 1) throw new Error("expected fixture hook failure");',
          '  return { exitCode: 7, signal: null };',
          '}',
          'export function resolveNpmInvocation() { return { command: process.execPath, args: ["-e", \'console.log(JSON.stringify("0.1.10"))\'] }; }',
          'export function npmCommandCwd() { return process.cwd(); }',
          'export function resolveNpmExecPath() {}',
          'export function waitForChildProcess() { throw new Error("setup must not run after install failure"); }',
        ].join("\n"));
        const result = runUpdate(root, ...(mode === "automatic" ? ["--automatic"] : []), "--home", home);
        assert.equal(result.status, mode === "automatic" ? 1 : 7, result.stderr);
        assert.match(result.stderr, /\[PACKAGE_TRANSITION_RECORD_INVALID\] transition_read:.*malformed_json/);
        assert.doesNotMatch(result.stderr, /UPDATE_INSTALL_FAILED|private-transition-canary/);
        const directory = join(home, "runtime", "diagnostics");
        const files = await readdir(directory);
        assert.equal(files.length, 1);
        const text = await readFile(join(directory, files[0]), "utf8");
        const record = JSON.parse(text);
        assert.equal(record.operation, mode === "manual" ? "install.retire" : "install.restore");
        assert.equal(record.recordReason, "malformed_json");
        assert.ok(result.stderr.includes(files[0].slice(0, -5)));
        assert.equal(text.includes(root), false);
        assert.doesNotMatch(text, /private-transition-canary|nonce/);
        const relayPath = await readFile(join(root, "relay-path.txt"), "utf8");
        await assert.rejects(readdir(dirname(relayPath)), { code: "ENOENT" });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
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
