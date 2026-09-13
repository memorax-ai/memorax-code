import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
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
      text: '{"secret":"setup-record-canary",not-json\n',
      errorCode: "SETUP_COMPLETION_RECORD_INVALID",
      recordReason: "malformed_json",
      pattern: /setup completion record is invalid \(malformed_json\)/,
    },
    {
      name: "unsupported",
      text: `${JSON.stringify({ ...validSetupRecord(), version: 2 }, null, 2)}\n`,
      pattern: /setup completion record uses unsupported version 2/,
      errorCode: "SETUP_COMPLETION_RECORD_UNSUPPORTED",
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
        const diagnostics = await readSetupDiagnostics(fixture);
        assert.equal(diagnostics.length, 1);
        assert.equal(diagnostics[0].errorCode, scenario.errorCode);
        assert.equal(diagnostics[0].stage, "setup_state");
        assert.equal(diagnostics[0].recordReason, scenario.recordReason);
        assert.ok(result.stderr.includes(`[${scenario.errorCode}] setup_state:`));
        assert.ok(result.stderr.includes(`Diagnostic: ${diagnostics[0].id}`));
        assert.doesNotMatch(`${result.stderr} ${JSON.stringify(diagnostics)}`, /setup-record-canary/);
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

test("setup reports a blocked lock release and retains any preceding setup authority failure", async () => {
  const fixture = await createPackageFixture();
  const entrypoint = join(fixture.root, "entrypoint-tty.mjs");
  const lockPath = `${join(fixture.memoraxCodeHome, setupCompletionRelativePath)}.lock`;
  try {
    await writeFile(entrypoint, [
      "import fs from 'node:fs';",
      "import { syncBuiltinESMExports } from 'node:module';",
      `const lockPath = ${JSON.stringify(lockPath)};`,
      "const originalUnlink = fs.unlinkSync;",
      "fs.unlinkSync = (path) => {",
      "  if (path === lockPath) throw Object.assign(new Error('[safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED] confirmation required'), { code: 'EPERM' });",
      "  return originalUnlink(path);",
      "};",
      "syncBuiltinESMExports();",
      await readFile(entrypoint, "utf8"),
    ].join("\n"));

    const result = runCli(fixture, ["setup", "--existing-account"], {
      assumeInteractive: true,
      stdinIsTTY: true,
    });

    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /\[JSON_FILE_LOCK_RELEASE_FAILED\] lock:/);
    const diagnostics = await readSetupDiagnostics(fixture);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].errorCode, "JSON_FILE_LOCK_RELEASE_FAILED");
    assert.equal(diagnostics[0].stage, "lock");
    assert.equal(diagnostics[0].systemCode, "EPERM");
    assert.ok(result.stderr.includes(`Diagnostic: ${diagnostics[0].id}`));
    assert.equal(result.stderr.includes(lockPath), false);
    assert.equal(JSON.stringify(diagnostics).includes(lockPath), false);
    assert.doesNotMatch(`${result.stderr} ${JSON.stringify(diagnostics)}`, /SAFE_DELETE_BULK_CONFIRM_REQUIRED|confirmation required/);
    assert.equal((await readJsonLines(fixture.setupLogPath)).length, 1);
    assert.equal(await pathExists(lockPath), true);

    await rm(lockPath);
    await writeSetupRecordText(fixture.memoraxCodeHome, '{"secret":"setup-record-canary",not-json\n');
    const failed = runCli(fixture, ["setup", "--existing-account"], {
      assumeInteractive: true,
      stdinIsTTY: true,
    });
    assert.equal(failed.error, undefined);
    assert.equal(failed.status, 1);
    const additional = (await readSetupDiagnostics(fixture)).filter((record) => record.id !== diagnostics[0].id);
    assert.equal(additional.length, 1);
    assert.equal(additional[0].errorCode, "SETUP_COMPLETION_RECORD_INVALID");
    assert.equal(additional[0].stage, "setup_state");
    assert.equal(additional[0].recordReason, "malformed_json");
    assert.equal(additional[0].systemCode, undefined);
    assert.equal(additional[0].cleanupErrorCode, "JSON_FILE_LOCK_RELEASE_FAILED");
    assert.equal(additional[0].cleanupSystemCode, "EPERM");
    assert.match(failed.stderr, /\[SETUP_COMPLETION_RECORD_INVALID\] setup_state:/);
    assert.match(failed.stderr, /Cleanup also failed: JSON_FILE_LOCK_RELEASE_FAILED \(EPERM\)/);
    assert.doesNotMatch(`${failed.stderr} ${JSON.stringify(additional)}`, /setup-record-canary|SAFE_DELETE_BULK_CONFIRM_REQUIRED|confirmation required/);
    assert.equal(JSON.stringify(additional).includes(lockPath), false);
    assert.equal((await readJsonLines(fixture.setupLogPath)).length, 1);
    assert.equal(await pathExists(lockPath), true);
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

test("update reconciles clients and verified Hooks or migrates a configured legacy install", {
  skip: process.platform === "win32",
}, async (t) => {
  for (const [name, completed, configured = false, writeBackendPid = true] of [
    ["setup incomplete", false],
    ["configured legacy install", false, true],
    ["setup complete with restored Backend PID", true],
    ["setup complete with stopped Backend", true, false, false],
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
          "if (process.env.MEMORAX_CODE_TEST_WRITE_BACKEND_PID === '1') {",
          "  const path = join(process.env.MEMORAX_CODE_HOME, 'runtime', 'backend', 'backend.pid.json');",
          "  mkdirSync(dirname(path), { recursive: true });",
          "  writeFileSync(path, JSON.stringify({ pid: process.pid }) + '\\n');",
          "}",
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
            MEMORAX_CODE_TEST_WRITE_BACKEND_PID: writeBackendPid ? "1" : "0",
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
          assert.match(result.stderr, /reconciling clients and verified Codex Hook changes in the foreground/);
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
    assert.match(result.stdout, /^  setup\s+Run or repair setup$/m);
    assert.match(result.stdout, /^  account\s+Manage local MemoraX account information$/m);
    assert.match(result.stdout, /^  update\s+Update the globally installed npm package$/m);
    assert.doesNotMatch(result.stdout, /repo-memory|user-profile/);
    assert.match(result.stdout, /Run `memorax-code setup` to complete first-time setup/);
    assert.equal(await pathExists(fixture.setupLogPath), false);
    assert.equal(await pathExists(fixture.backendLogPath), false);
  } finally {
    await fixture.cleanup();
  }
});

test("user-profile preserves piped helper output and exit status without requiring setup", async () => {
  const fixture = await createPackageFixture();
  try {
    const helperEntrypoint = join(fixture.root, "lib", "memorax-code-backend", "dist", "user-profile.js");
    await writeFile(helperEntrypoint, [
      "process.stdout.write(JSON.stringify({ args: process.argv.slice(3), description: 'x'.repeat(128 * 1024) }) + '\\n');",
      "process.exitCode = 7;",
      "",
    ].join("\n"));
    const args = ["list", "--repo", join(fixture.root, "repo with spaces")];

    const result = runCli(fixture, ["user-profile", ...args]);

    assert.equal(result.error, undefined);
    assert.equal(result.status, 7, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { args, description: "x".repeat(128 * 1024) });
    assert.equal(await pathExists(fixture.setupLogPath), false);
    assert.equal(await pathExists(fixture.backendLogPath), false);
    assert.equal(await pathExists(join(fixture.memoraxCodeHome, setupCompletionRelativePath)), false);
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

test("setup help describes interactive and non-interactive existing-account modes", async () => {
  const fixture = await createPackageFixture();
  try {
    const result = runCli(fixture, ["setup", "--help"]);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.error, undefined);
    assert.match(result.stdout, /^Usage: memorax-code setup \[--existing-account \| --reconfigure\] \[--non-interactive\] \[--home DIR\]/);
    assert.match(result.stdout, /Plain setup reuses a complete configuration/);
    assert.match(result.stdout, /^  --existing-account\s+Configure an existing account instead of anonymous access$/m);
    assert.match(result.stdout, /^  --non-interactive\s+With --existing-account, read the API Key from stdin and use defaults without prompting$/m);
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

test("setup forwards an existing-account API key through private stdin without a TTY", async () => {
  const fixture = await createPackageFixture();
  const apiKey = `sk_${"P".repeat(43)}`;
  try {
    const result = await runCli(fixture, ["setup", "--existing-account", "--non-interactive"], {
      inputChunks: [apiKey.slice(0, 9), apiKey.slice(9), "\r\n"],
      timeout: 10_000,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.error, undefined);
    assert.deepEqual(await readJsonLines(fixture.setupLogPath), [{
      args: ["--non-interactive"],
      home: fixture.memoraxCodeHome,
      setupMode: "existing-account",
      stdinKeyHash: createHash("sha256").update(apiKey).digest("hex"),
      keyInEnvironment: false,
      stdinIsTTY: false,
    }]);
    assert.equal(`${result.stdout}\n${result.stderr}`.includes(apiKey), false);
    assert.equal((await readFile(fixture.setupLogPath, "utf8")).includes(apiKey), false);
    assert.equal(await pathExists(fixture.backendLogPath), false);
  } finally {
    await fixture.cleanup();
  }
});

test("setup rejects invalid API key stdin before starting setup without exposing input", async (t) => {
  const apiKey = `sk_${"I".repeat(43)}`;
  for (const scenario of [
    { name: "missing existing-account mode", args: ["--non-interactive"], input: apiKey },
    { name: "reconfigure mode", args: ["--reconfigure", "--non-interactive"], input: apiKey },
    { name: "key accidentally passed as an argument", args: ["--existing-account", "--non-interactive", apiKey], input: apiKey },
    { name: "empty input", input: "" },
    { name: "multiple lines", input: `${apiKey}\nsecond-line` },
    { name: "NUL", input: `${apiKey}\0` },
    { name: "oversized input", input: `${apiKey}${"x".repeat(16 * 1024)}` },
    { name: "TTY input", input: apiKey, stdinIsTTY: true },
  ]) {
    await t.test(scenario.name, async () => {
      const fixture = await createPackageFixture();
      try {
        const result = runCli(fixture, ["setup", ...(scenario.args ?? ["--existing-account", "--non-interactive"])], {
          input: scenario.input,
          stdinIsTTY: scenario.stdinIsTTY,
        });

        assert.equal(result.error, undefined);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /API key|non-interactive|setup option/i);
        assert.equal(`${result.stdout}\n${result.stderr}`.includes(apiKey), false);
        assert.equal(await pathExists(fixture.setupLogPath), false);
        assert.equal(await pathExists(fixture.backendLogPath), false);
        assert.equal(await pathExists(join(fixture.memoraxCodeHome, "config.toml")), false);
        assert.equal(await pathExists(join(fixture.memoraxCodeHome, setupCompletionRelativePath)), false);
      } finally {
        await fixture.cleanup();
      }
    });
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

async function readSetupDiagnostics(fixture) {
  const directory = join(fixture.memoraxCodeHome, "runtime", "diagnostics");
  const files = (await readdir(directory)).filter((name) => /^mc-.*\.json$/.test(name));
  return await Promise.all(files.map(async (name) => JSON.parse(await readFile(join(directory, name), "utf8"))));
}

async function createPackageFixture() {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-entrypoint-test-"));
  const memoraxCodeHome = join(root, "memorax-code-home");
  const home = join(root, "home");
  const setupLogPath = join(root, "setup-calls.jsonl");
  const backendLogPath = join(root, "backend-calls.jsonl");
  const copiedFiles = [
    "bin/memorax-code.mjs",
    "lib/automatic-update.mjs",
    "lib/client-hook-runtime.mjs",
    "lib/node-version.mjs",
    "lib/npm-invocation.mjs",
    "lib/resolve-claude-command.mjs",
    "lib/resolve-codex-command.mjs",
    "lib/resolve-codebuddy-command.mjs",
    "lib/run-entrypoint.mjs",
    "lib/setup-api-key-input.mjs",
    "lib/setup-diagnostics.mjs",
    "lib/trial-provision-client.mjs",
    "lib/trial-provision-flow.mjs",
    "lib/trial-plugin-mark.mjs",
    "lib/vscode-extension-command.mjs",
    "lib/windows-cli-invocation.mjs",
    "lib/windows-user-path.mjs",
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
  for (const relativePath of [
    "clients/codebuddy-command.mjs",
    "config-utils.mjs",
    "diagnostic-record.mjs", "deployment-failure.mjs",
    "automatic-update-state.mjs",
    "runtime-record.mjs",
    "setup-completion.mjs",
  ]) {
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
    "export { trialProvisionFailureDetails as trialSetupFailureDetails } from './trial-provision-flow.mjs';",
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
    "import { appendFileSync, readFileSync } from 'node:fs';",
    "import { createHash } from 'node:crypto';",
    "const stdinKey = process.argv.includes('--non-interactive') ? readFileSync(0, 'utf8').replace(/\\r?\\n$/, '') : undefined;",
    "appendFileSync(process.env.MEMORAX_CODE_TEST_SETUP_LOG, JSON.stringify({",
    "  args: process.argv.slice(2),",
    "  home: process.env.MEMORAX_CODE_HOME,",
    "  setupMode: process.env.MEMORAX_CODE_SETUP_MODE ?? 'automatic',",
    "  ...(process.env.MEMORAX_CODE_SETUP_UPDATE === undefined ? {} : { updateMode: process.env.MEMORAX_CODE_SETUP_UPDATE }),",
    "  ...(stdinKey === undefined ? {} : {",
    "    stdinKeyHash: createHash('sha256').update(stdinKey).digest('hex'),",
    "    keyInEnvironment: Object.values(process.env).some((value) => value.includes(stdinKey)),",
    "    stdinIsTTY: process.stdin.isTTY === true,",
    "  }),",
    "}) + '\\n');",
    "process.exit(Number(process.env.MEMORAX_CODE_TEST_SETUP_EXIT_CODE ?? 0));",
    "",
  ].join("\n"));
  await writeFile(join(root, "entrypoint-tty.mjs"), [
    "Object.defineProperty(process.stdin, 'isTTY', { value: true });",
    "await import('./bin/memorax-code.mjs');",
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
  input,
  inputChunks,
  stdinIsTTY = false,
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
  const cliArgs = [stdinIsTTY ? join(fixture.root, "entrypoint-tty.mjs") : join(fixture.root, "bin", "memorax-code.mjs"), ...args];
  const options = {
    env,
    stdio: [input === undefined && !inputChunks ? "ignore" : "pipe", "pipe", "pipe"],
    timeout,
  };
  if (inputChunks) {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, cliArgs, options);
      let stdout = "";
      let stderr = "";
      let error;
      let timer;
      child.stdout.on("data", (chunk) => { stdout += String(chunk); });
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.on("error", (value) => { error = value; });
      child.stdin.on("error", () => {});
      child.on("close", (status) => {
        clearTimeout(timer);
        resolve({ status, error, stdout, stderr });
      });
      const writeChunk = (index) => {
        if (index === inputChunks.length) child.stdin.end();
        else {
          child.stdin.write(inputChunks[index]);
          timer = setTimeout(() => writeChunk(index + 1), 40);
        }
      };
      timer = setTimeout(() => writeChunk(0), 300);
    });
  }
  return spawnSync(process.execPath, cliArgs, { ...options, encoding: "utf8", input });
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
