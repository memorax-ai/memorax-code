import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const setupCompletionRelativePath = join("runtime", "setup", "setup-completion.json");

test("memorax-code with no setup record prints setup guidance without side effects", async () => {
  const fixture = await createPackageFixture();
  try {
    const result = runCli(fixture, [], { assumeInteractive: true });

    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.error, undefined);
    assert.match(result.stderr, /setup has not been completed\. Run `memorax-code setup` from an interactive terminal/);
    assert.equal(await pathExists(fixture.setupLogPath), false);
    assert.equal(await pathExists(fixture.backendLogPath), false);
  } finally {
    await fixture.cleanup();
  }
});

test("memorax-code with a valid v1 setup record routes no command to status", async () => {
  const fixture = await createPackageFixture();
  try {
    await writeSetupRecord(fixture.memoraxCodeHome, validSetupRecord());

    const result = runCli(fixture);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.error, undefined);
    assert.deepEqual(await readJsonLines(fixture.backendLogPath), [{ args: ["status"] }]);
    assert.equal(await pathExists(fixture.setupLogPath), false);
  } finally {
    await fixture.cleanup();
  }
});

test("memorax-code fails closed for invalid or unsupported setup records", async (t) => {
  for (const scenario of [
    {
      name: "invalid",
      text: "{not-json\n",
      pattern: /setup completion record is invalid \(malformed_json\)/,
    },
    {
      name: "unsupported",
      text: `${JSON.stringify({ ...validSetupRecord(), version: 2 }, null, 2)}\n`,
      pattern: /setup completion record uses unsupported version 2/,
    },
  ]) {
    await t.test(scenario.name, async () => {
      const fixture = await createPackageFixture();
      try {
        await writeSetupRecordText(fixture.memoraxCodeHome, scenario.text);

        const result = runCli(fixture, [], { assumeInteractive: true });

        assert.equal(result.status, 1);
        assert.equal(result.error, undefined);
        assert.match(result.stderr, scenario.pattern);
        assert.match(result.stderr, /Inspect or repair this private record before running setup again/);
        assert.equal(await pathExists(fixture.setupLogPath), false);
        assert.equal(await pathExists(fixture.backendLogPath), false);
      } finally {
        await fixture.cleanup();
      }
    });
  }
});

test("explicit setup defaults to automatic mode and ignores inherited setup mode", async () => {
  const fixture = await createPackageFixture();
  try {
    await writeSetupRecord(fixture.memoraxCodeHome, validSetupRecord());

    const result = runCli(fixture, ["setup"], {
      assumeInteractive: true,
      extraEnv: {
        MEMORAX_CODE_SETUP_MODE: "existing-account",
        MEMORAX_CODE_SETUP_UPDATE: "1",
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.error, undefined);
    assert.deepEqual(await readJsonLines(fixture.setupLogPath), [{
      args: [],
      home: fixture.memoraxCodeHome,
      setupMode: "automatic",
    }]);
    assert.equal(await pathExists(fixture.backendLogPath), false);
  } finally {
    await fixture.cleanup();
  }
});

test("setup propagates an explicit home to the setup process", async () => {
  const fixture = await createPackageFixture();
  const requestedHome = join(fixture.root, "custom memorax-code home");
  try {
    const result = runCli(fixture, ["setup", "--home", requestedHome], { assumeInteractive: true });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.error, undefined);
    assert.deepEqual(await readJsonLines(fixture.setupLogPath), [{
      args: [],
      home: requestedHome,
      setupMode: "automatic",
    }]);
    assert.equal(await pathExists(join(fixture.memoraxCodeHome, setupCompletionRelativePath)), false);
  } finally {
    await fixture.cleanup();
  }
});

test("setup propagates the setup process exit code", async () => {
  const fixture = await createPackageFixture();
  try {
    const result = runCli(fixture, ["setup"], {
      assumeInteractive: true,
      setupExitCode: 7,
    });

    assert.equal(result.status, 7, result.stderr);
    assert.equal(result.error, undefined);
    assert.deepEqual(await readJsonLines(fixture.setupLogPath), [{
      args: [],
      home: fixture.memoraxCodeHome,
      setupMode: "automatic",
    }]);
    assert.equal(await pathExists(fixture.backendLogPath), false);
  } finally {
    await fixture.cleanup();
  }
});

test("update reviews clients and Hooks or migrates a configured legacy install", {
  skip: process.platform === "win32",
}, async (t) => {
  for (const [name, completed, configured = false] of [
    ["setup incomplete", false],
    ["configured legacy install", false, true],
    ["setup complete", true],
  ]) {
    await t.test(name, async () => {
      const fixture = await createPackageFixture();
      const fakeBin = join(fixture.root, "fake-bin");
      const npmModule = join(fakeBin, "npm.mjs");
      try {
        await mkdir(fakeBin, { recursive: true });
        await writeFile(npmModule, [
          "#!/usr/bin/env node",
          "import { mkdirSync, writeFileSync } from 'node:fs';",
          "import { dirname, join } from 'node:path';",
          "const path = join(process.env.MEMORAX_CODE_HOME, 'runtime', 'backend', 'backend.pid.json');",
          "mkdirSync(dirname(path), { recursive: true });",
          "writeFileSync(path, JSON.stringify({ pid: process.pid }) + '\\n');",
          "",
        ].join("\n"));
        await chmod(npmModule, 0o755);
        await symlink(basename(npmModule), join(fakeBin, "npm"));
        if (completed) {
          await writeSetupRecord(fixture.memoraxCodeHome, validSetupRecord());
        }

        const result = runCli(fixture, ["update"], {
          assumeInteractive: true,
          extraEnv: {
            PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
            ...(configured ? { MEMORAX_CODE_TEST_CONFIGURED: "1" } : {}),
          },
        });

        assert.equal(result.status, 0, result.stderr);
        if (!completed && !configured) {
          assert.match(result.stderr, /package updated; setup has not been completed; run `memorax-code setup` from an interactive terminal/);
          assert.equal(await pathExists(fixture.setupLogPath), false);
        } else if (configured) {
          assert.match(result.stderr, /existing configuration detected; completing the one-time setup migration/);
          assert.deepEqual(await readJsonLines(fixture.setupLogPath), [{
            args: [],
            home: fixture.memoraxCodeHome,
            setupMode: "automatic",
          }]);
        } else {
          assert.match(result.stderr, /reviewing client and Hook changes in the foreground/);
          assert.deepEqual(await readJsonLines(fixture.setupLogPath), [{
            args: [],
            home: fixture.memoraxCodeHome,
            setupMode: "automatic",
            updateMode: "1",
          }]);
        }
      } finally {
        await fixture.cleanup();
      }
    });
  }
});

test("root help documents setup and update", async () => {
  const fixture = await createPackageFixture();
  try {
    const result = runCli(fixture, ["--help"]);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.error, undefined);
    assert.match(result.stdout, /^Usage: memorax-code \[command\] \[options\]/);
    assert.match(result.stdout, /^  setup\s+Run or repair the interactive setup$/m);
    assert.match(result.stdout, /^  account\s+Manage local MemoraX account information$/m);
    assert.match(result.stdout, /^  update\s+Update the globally installed npm package$/m);
    assert.match(result.stdout, /Run `memorax-code setup` to complete first-time setup/);
    assert.equal(await pathExists(fixture.setupLogPath), false);
    assert.equal(await pathExists(fixture.backendLogPath), false);
  } finally {
    await fixture.cleanup();
  }
});

test("account command reveals only the requested local trial Mark ID", async () => {
  const fixture = await createPackageFixture();
  const markId = `mk_${"a".repeat(64)}`;
  const apiKey = `sk_${"S".repeat(43)}`;
  try {
    const result = runCli(fixture, ["account", "--show-mark-id"], {
      extraEnv: {
        MEMORAX_CODE_TEST_MARK_ID: markId,
        MEMORAX_CODE_TEST_API_KEY: apiKey,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.error, undefined);
    assert.equal(result.stdout, `Mark ID: ${markId}\n`);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(apiKey));
    assert.equal(await pathExists(fixture.setupLogPath), false);
    assert.equal(await pathExists(fixture.backendLogPath), false);
  } finally {
    await fixture.cleanup();
  }
});

test("setup help describes automatic, existing-account, and reconfigure modes", async () => {
  const fixture = await createPackageFixture();
  try {
    const result = runCli(fixture, ["setup", "--help"]);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.error, undefined);
    assert.match(result.stdout, /^Usage: memorax-code setup \[--existing-account \| --reconfigure\] \[--home DIR\]/);
    assert.match(result.stdout, /A complete existing\nconfiguration is reused automatically/);
    assert.match(result.stdout, /^  --existing-account\s+Configure an existing account instead of anonymous access$/m);
    assert.match(result.stdout, /^  --reconfigure\s+Re-detect memory preferences instead of reusing configuration$/m);
    assert.equal(await pathExists(fixture.setupLogPath), false);
    assert.equal(await pathExists(fixture.backendLogPath), false);
  } finally {
    await fixture.cleanup();
  }
});

test("setup forwards explicit setup modes", async (t) => {
  for (const scenario of [
    { flag: "--existing-account", mode: "existing-account" },
    { flag: "--reconfigure", mode: "reconfigure" },
  ]) {
    await t.test(scenario.mode, async () => {
      const fixture = await createPackageFixture();
      try {
        const result = runCli(fixture, ["setup", scenario.flag], { assumeInteractive: true });

        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(await readJsonLines(fixture.setupLogPath), [{
          args: [],
          home: fixture.memoraxCodeHome,
          setupMode: scenario.mode,
        }]);
      } finally {
        await fixture.cleanup();
      }
    });
  }
});

test("setup rejects conflicting setup modes before starting setup", async () => {
  const fixture = await createPackageFixture();
  try {
    const result = runCli(fixture, ["setup", "--existing-account", "--reconfigure"], {
      assumeInteractive: true,
    });

    assert.equal(result.status, 2);
    assert.match(result.stderr, /--existing-account and --reconfigure cannot be used together/);
    assert.equal(await pathExists(fixture.setupLogPath), false);
  } finally {
    await fixture.cleanup();
  }
});

test("unknown commands are still delegated to the Backend entrypoint", async () => {
  const fixture = await createPackageFixture();
  try {
    const result = runCli(fixture, ["unknown-command"], { backendExitCode: 23 });

    assert.equal(result.status, 23, result.stderr);
    assert.equal(result.error, undefined);
    assert.deepEqual(await readJsonLines(fixture.backendLogPath), [{ args: ["unknown-command"] }]);
    assert.equal(await pathExists(fixture.setupLogPath), false);
  } finally {
    await fixture.cleanup();
  }
});

async function createPackageFixture() {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-entrypoint-test-"));
  const memoraxCodeHome = join(root, "memorax-code-home");
  const home = join(root, "home");
  const setupLogPath = join(root, "setup-calls.jsonl");
  const backendLogPath = join(root, "backend-calls.jsonl");
  const copiedFiles = [
    "bin/memorax-code.mjs",
    "lib/client-hook-runtime.mjs",
    "lib/node-version.mjs",
    "lib/npm-invocation.mjs",
    "lib/resolve-claude-command.mjs",
    "lib/resolve-codex-command.mjs",
    "lib/run-entrypoint.mjs",
    "lib/vscode-extension-command.mjs",
    "lib/windows-cli-invocation.mjs",
  ];
  for (const relativePath of copiedFiles) {
    const target = join(root, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await cp(join(packageRoot, relativePath), target);
  }

  const adapterCommonSource = join(
    packageRoot,
    "..",
    "..",
    "ts",
    "memorax-code-adapter-common",
    "src",
  );
  for (const relativePath of ["config-utils.mjs", "runtime-record.mjs", "setup-completion.mjs"]) {
    const target = join(root, "lib", "memorax-code-adapter-common", "src", relativePath);
    await mkdir(dirname(target), { recursive: true });
    await cp(join(adapterCommonSource, relativePath), target);
  }

  await writeFile(join(root, "package.json"), `${JSON.stringify({
    name: "@memorax/memorax-code-entrypoint-test",
    version: "0.0.0-test",
    type: "module",
  }, null, 2)}\n`);
  await writeFile(join(root, "bin", "memorax-cli.mjs"), [
    "const configured = process.env.MEMORAX_CODE_TEST_CONFIGURED === '1';",
    "console.log(JSON.stringify({",
    "  ok: configured,",
    "  action: 'memory.status',",
    "  provider: 'memory.memorax',",
    "  config: { configured },",
    "}));",
    "process.exit(configured ? 0 : 1);",
    "",
  ].join("\n"));
  await writeFile(join(root, "lib", "trial-setup.mjs"), [
    "export async function loadReadyTrialSetupCredential(options = {}) {",
    "  if (options.memoraxCodeHome !== process.env.MEMORAX_CODE_TEST_EXPECTED_ACCOUNT_HOME) {",
    "    throw new Error('unexpected MemoraX Code home');",
    "  }",
    "  const markId = process.env.MEMORAX_CODE_TEST_MARK_ID;",
    "  if (!markId) return undefined;",
    "  return {",
    "    status: 'ready',",
    "    markId,",
    "    apiKey: process.env.MEMORAX_CODE_TEST_API_KEY,",
    "  };",
    "}",
    "",
  ].join("\n"));
  await writeFile(join(root, "bin", "memorax-code-setup.mjs"), [
    "import { appendFileSync } from 'node:fs';",
    "appendFileSync(process.env.MEMORAX_CODE_TEST_SETUP_LOG, JSON.stringify({",
    "  args: process.argv.slice(2),",
    "  home: process.env.MEMORAX_CODE_HOME,",
    "  setupMode: process.env.MEMORAX_CODE_SETUP_MODE ?? 'automatic',",
    "  ...(process.env.MEMORAX_CODE_SETUP_UPDATE === undefined ? {} : { updateMode: process.env.MEMORAX_CODE_SETUP_UPDATE }),",
    "}) + '\\n');",
    "process.exit(Number(process.env.MEMORAX_CODE_TEST_SETUP_EXIT_CODE ?? 0));",
    "",
  ].join("\n"));
  const backendEntrypoint = join(root, "lib", "memorax-code-backend", "dist", "memorax-code.js");
  await mkdir(dirname(backendEntrypoint), { recursive: true });
  await writeFile(backendEntrypoint, [
    "import { appendFileSync } from 'node:fs';",
    "appendFileSync(process.env.MEMORAX_CODE_TEST_BACKEND_LOG, JSON.stringify({",
    "  args: process.argv.slice(2),",
    "}) + '\\n');",
    "process.exit(Number(process.env.MEMORAX_CODE_TEST_BACKEND_EXIT_CODE ?? 0));",
    "",
  ].join("\n"));

  return {
    root,
    memoraxCodeHome,
    home,
    setupLogPath,
    backendLogPath,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

function runCli(fixture, args = [], {
  assumeInteractive = false,
  backendExitCode = 0,
  extraEnv = {},
  setupExitCode = 0,
  timeout = 5_000,
} = {}) {
  const env = {
    ...process.env,
    HOME: fixture.home,
    MEMORAX_CODE_HOME: fixture.memoraxCodeHome,
    CODEX_HOME: join(fixture.root, "codex-home"),
    CLAUDE_CONFIG_DIR: join(fixture.root, "claude-home"),
    MEMORAX_CODE_CODEX_COMMAND: process.execPath,
    MEMORAX_CODE_CLAUDE_COMMAND: process.execPath,
    MEMORAX_CODE_TEST_SETUP_LOG: fixture.setupLogPath,
    MEMORAX_CODE_TEST_BACKEND_LOG: fixture.backendLogPath,
    MEMORAX_CODE_TEST_SETUP_EXIT_CODE: String(setupExitCode),
    MEMORAX_CODE_TEST_BACKEND_EXIT_CODE: String(backendExitCode),
    MEMORAX_CODE_TEST_EXPECTED_ACCOUNT_HOME: fixture.memoraxCodeHome,
    MEMORAX_CODE_TEST_MARK_ID: "",
    MEMORAX_CODE_TEST_API_KEY: "",
  };
  delete env.MEMORAX_CODE_SETUP_MODE;
  delete env.MEMORAX_CODE_SETUP_UPDATE;
  Object.assign(env, extraEnv);
  if (assumeInteractive) env.MEMORAX_CODE_SETUP_ASSUME_INTERACTIVE = "1";
  else delete env.MEMORAX_CODE_SETUP_ASSUME_INTERACTIVE;
  return spawnSync(
    process.execPath,
    [join(fixture.root, "bin", "memorax-code.mjs"), ...args],
    {
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "pipe"],
      timeout,
    },
  );
}

function validSetupRecord() {
  return {
    version: 1,
    state: "complete",
    completedAt: "2026-08-15T08:00:00.000Z",
    completedByVersion: "0.0.0-test",
  };
}

async function writeSetupRecord(memoraxCodeHome, record) {
  await writeSetupRecordText(memoraxCodeHome, `${JSON.stringify(record, null, 2)}\n`);
}

async function writeSetupRecordText(memoraxCodeHome, text) {
  const path = join(memoraxCodeHome, setupCompletionRelativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

async function readJsonLines(path) {
  return (await readFile(path, "utf8"))
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function pathExists(path) {
  return Boolean(await stat(path).catch(() => undefined));
}
