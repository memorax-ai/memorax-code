import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const phases = ["after-config-write", "before-backend-start", "after-backend-start", "saved-account-key-cancel"];
const privateCanary = "private-path-and-credential-canary";

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), "cursor interruption cli-"));
  try {
    const packageRoot = join(root, "package"), ptyRoot = join(root, "terminal"), workspace = join(root, "workspace");
    const scriptRoot = join(root, "scripts", "cursor"), codexScripts = join(root, "scripts", "codex");
    const stateHome = join(root, "state"), cursorHome = join(root, "cursor"), script = join(scriptRoot, "cursor-lifecycle-interruption-cli.mjs");
    for (const path of [packageRoot, ptyRoot, workspace, stateHome, cursorHome, scriptRoot, codexScripts, join(packageRoot, "node_modules/smol-toml")]) {
      await mkdir(path, { recursive: true });
    }
    for (const file of ["cursor-lifecycle-interruption-cli.mjs", "cursor-lifecycle-assertions.mjs"]) {
      await copyFile(new URL(file, import.meta.url), join(scriptRoot, file));
    }
    await copyFile(new URL("../codex/codex-lifecycle-assertions.mjs", import.meta.url), join(codexScripts, "codex-lifecycle-assertions.mjs"));
    await writeFile(join(packageRoot, "package.json"), "{}");
    await writeFile(join(packageRoot, "node_modules/smol-toml/package.json"), '{"main":"index.cjs"}');
    await writeFile(join(packageRoot, "node_modules/smol-toml/index.cjs"), "exports.parse = JSON.parse;");
    await writeFile(join(stateHome, "config.toml"), JSON.stringify({
      memorax: { user_id: "fixture-user", api_key: privateCanary, endpoint: "http://127.0.0.1:12345" },
      clients: { cursor: true }, memory: { writeback: { enabled: false } },
    }));
    await writeFile(join(cursorHome, "hooks.json"), JSON.stringify({ version: 1, hooks: { stop: [{ command: "user-owned-hook" }] } }));
    await writeFile(join(scriptRoot, "cursor-lifecycle-interruption.mjs"), `
      import assert from 'node:assert/strict';
      import { readFile, writeFile } from 'node:fs/promises';
      import { join } from 'node:path';
      export const cursorInterruptionPhases = ${JSON.stringify(phases)};
      export function startCursorSetupInterruption(options) {
        return { result: (async () => {
          const scenario = JSON.parse(await readFile(join(options.workspace, 'scenario.json'), 'utf8'));
          const configPath = join(options.env.MEMORAX_CODE_HOME, 'config.toml');
          const hooksPath = join(options.env.CURSOR_HOME, 'hooks.json');
          const config = JSON.parse(await readFile(configPath, 'utf8'));
          assert.equal(options.key, config.memorax.api_key);
          assert.equal(options.workspace, process.cwd());
          assert.equal(options.packageRoot, scenario.packageRoot);
          assert.equal(options.ptyRoot, scenario.ptyRoot);
          if (scenario.error) throw Object.assign(new Error(scenario.error), { cleanupFailed: scenario.cleanupFailed });
          await options.verifyPreserved();
          if (scenario.mutate === 'config') config.memorax.api_key = 'changed-private-canary';
          await writeFile(configPath, JSON.stringify(config));
          const hooks = JSON.parse(await readFile(hooksPath, 'utf8'));
          if (scenario.mutate === 'hooks') hooks.hooks.stop[0].command = 'changed-private-hook';
          hooks.hooks.stop.push({ command: 'node owned --memorax-code-cursor-hook-v1' });
          await writeFile(hooksPath, JSON.stringify(hooks));
          await options.verifyPreserved();
          await writeFile(join(options.workspace, 'completed.json'), JSON.stringify({ cleanupFinished: true }));
          const phase = options.phase;
          const stageEvidence = phase === 'before-backend-start'
            ? { kind: 'held-native-lifecycle-lock', backendHealthy: false }
            : phase === 'saved-account-key-cancel' ? { kind: 'native-masked-key-prompt', backendHealthy: false }
            : { kind: 'test-preload-pauses-real-installed-cli-child', command: phase === 'after-config-write' ? 'start' : 'status',
                backendHealthy: phase === 'after-backend-start' };
          return { stageReached: true, stageEvidence, completionAbsentAfterInterruption: true,
            interruptedSetupFailed: true, setupProcessesStopped: !scenario.incomplete,
            privateData: ${JSON.stringify(privateCanary)} };
        })() };
      }
    `);
    const env = { HOME: root, USERPROFILE: root, MEMORAX_CODE_HOME: stateHome, CURSOR_HOME: cursorHome };
    if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
    await run({ root, workspace, stateHome, cursorHome, async invoke(scenario = {}, args = [packageRoot, ptyRoot, phases[0]], overrides = {}) {
      await writeFile(join(workspace, "scenario.json"), JSON.stringify({ packageRoot, ptyRoot, ...scenario }));
      let result;
      try { result = { ...(await execFileAsync(process.execPath, [script, ...args], {
        cwd: workspace, env: { ...env, ...overrides }, timeout: 10000, maxBuffer: 16384,
      })), code: 0 }; }
      catch (error) {
        assert.equal(Number.isInteger(error.code), true);
        result = { code: error.code, stdout: error.stdout, stderr: error.stderr };
      }
      assert.equal(result.stderr, "");
      assert.equal(result.stdout.trim().split("\n").length, 1);
      assert.equal(result.stdout.includes(root), false);
      assert.equal(result.stdout.includes(privateCanary), false);
      return { code: result.code, report: JSON.parse(result.stdout) };
    }, packageRoot, ptyRoot });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("interruption CLI delegates each phase, protects snapshots and publishes only completed fixed evidence", async () => {
  for (const phase of phases) await fixture(async ({ invoke, workspace, packageRoot, ptyRoot }) => {
    const { code, report } = await invoke({}, [packageRoot, ptyRoot, phase]);
    assert.equal(code, 0);
    assert.deepEqual(Object.keys(report), ["status", "stageReached", "stageEvidence", "completionAbsentAfterInterruption",
      "interruptedSetupFailed", "setupProcessesStopped"]);
    assert.equal(report.status, "PASS");
    for (const key of ["stageReached", "completionAbsentAfterInterruption", "interruptedSetupFailed", "setupProcessesStopped"]) {
      assert.equal(report[key], true);
    }
    assert.equal(report.stageEvidence.backendHealthy, phase === "after-backend-start");
    assert.deepEqual(JSON.parse(await readFile(join(workspace, "completed.json"), "utf8")), { cleanupFinished: true });
  });
});

test("interruption CLI rejects changed protected configuration and unrelated hooks", async () => {
  for (const [mutate, error] of [["config", "PROTECTED_ACCOUNT_CHANGED_API_KEY"], ["hooks", "CURSOR_LIFECYCLE_UNRELATED_HOOKS_CHANGED"]]) {
    await fixture(async ({ invoke }) => assert.deepEqual(await invoke({ mutate }), {
      code: 1, report: { status: "FAIL", error, cleanupFailed: false },
    }));
  }
});

test("interruption CLI projects only fixed errors and strict cleanup booleans", async () => {
  for (const [error, cleanupFailed, expected] of [
    ["CURSOR_LIFECYCLE_INTERRUPTION_STAGE_NOT_REACHED", true, "CURSOR_LIFECYCLE_INTERRUPTION_STAGE_NOT_REACHED"],
    ["INSTALL_TERMINAL_PROCESS_REMAINS", true, "INSTALL_TERMINAL_PROCESS_REMAINS"],
    ["TERMINAL_DISCLOSED_FIXTURE_CREDENTIAL", false, "TERMINAL_DISCLOSED_FIXTURE_CREDENTIAL"],
    [privateCanary, "true", "CURSOR_LIFECYCLE_INTERRUPTION_FAILED_PRIVATE_OUTPUT_SUPPRESSED"],
    ["INSTALL_PRIVATE/path", false, "CURSOR_LIFECYCLE_INTERRUPTION_FAILED_PRIVATE_OUTPUT_SUPPRESSED"],
  ]) await fixture(async ({ invoke }) => assert.deepEqual(await invoke({ error, cleanupFailed }), {
    code: 1, report: { status: "FAIL", error: expected, cleanupFailed: cleanupFailed === true },
  }));
});

test("interruption CLI rejects missing arguments, isolated homes and incomplete helper evidence", async () => {
  await fixture(async ({ invoke, packageRoot, ptyRoot }) => {
    for (const args of [[], [packageRoot, ptyRoot, "unknown"], [packageRoot, ptyRoot, phases[0], "extra"]]) {
      assert.deepEqual(await invoke({}, args), { code: 1, report: {
        status: "FAIL", error: "CURSOR_LIFECYCLE_INTERRUPTION_ARGUMENTS", cleanupFailed: false,
      } });
    }
    assert.deepEqual(await invoke({}, undefined, { CURSOR_HOME: "" }), { code: 1, report: {
      status: "FAIL", error: "CURSOR_LIFECYCLE_INTERRUPTION_ARGUMENTS", cleanupFailed: false,
    } });
    assert.deepEqual(await invoke({ incomplete: true }), { code: 1, report: {
      status: "FAIL", error: "CURSOR_LIFECYCLE_INTERRUPTION_RESULT_INVALID", cleanupFailed: false,
    } });
  });
});

test("interruption CLI suppresses unreadable or malformed private configuration", async () => {
  await fixture(async ({ invoke, stateHome }) => {
    await writeFile(join(stateHome, "config.toml"), privateCanary);
    assert.deepEqual(await invoke(), { code: 1, report: {
      status: "FAIL", error: "CURSOR_LIFECYCLE_INTERRUPTION_FAILED_PRIVATE_OUTPUT_SUPPRESSED", cleanupFailed: false,
    } });
    await rm(join(stateHome, "config.toml"));
    assert.equal((await invoke()).report.error, "CURSOR_LIFECYCLE_INTERRUPTION_FAILED_PRIVATE_OUTPUT_SUPPRESSED");
  });
});
