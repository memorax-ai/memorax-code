import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const validator = fileURLToPath(
  new URL("../../../../scripts/validate-windows-e2e-report.mjs", import.meta.url),
);
const packageHarness = fileURLToPath(
  new URL("../../../../scripts/windows-npm-package-e2e.mjs", import.meta.url),
);

const lifecycleBooleans = [
  "npmInstallOk",
  "packageIdentityExact",
  "productionDependencyReady",
  "allBinShimsRunnable",
  "cmdLifecycleVerified",
  "interruptedInstallRecovered",
  "backendLifecycleThreeCycles",
  "pidChangedOnRestart",
  "stopRemovedProcess",
  "portReleased",
  "updateReady",
  "sentinelCreated",
];

const codexBooleans = [
  "npmInstallOk",
  "clientProviderConfigPreserved",
  "pluginInstalled",
  "pluginHooksTrusted",
  "pluginVersionExact",
  "hookAssetsPresent",
  "ensureBackendHookStarted",
  "backendHealthy",
  "adapterReady",
  "sessionStartHookExecuted",
  "userPromptHookExecuted",
  "writebackHookExecuted",
  "hookAuthForwarded",
  "workspaceCwdExact",
  "sessionRegistryExact",
  "stopRemovedProcess",
  "restartHealthy",
  "uninstallRemovedProcess",
  "uninstallReleasedPort",
  "uninstallRemovedPlugin",
  "pluginRegistrationRemoved",
  "pluginCacheRemoved",
  "npmPackageRemoved",
  "managedChildProcessesRemoved",
  "userStatePreserved",
  "sentinelBytesPreserved",
];

const claudeBooleans = [
  "npmInstallOk",
  "clientProviderSettingsPreserved",
  "pluginInstalled",
  "pluginEnabled",
  "pluginVersionExact",
  "hookAssetsPresent",
  "initialBackendHealthy",
  "stopRemovedProcess",
  "ensureBackendHookStarted",
  "backendHealthy",
  "restartHealthy",
  "adapterReady",
  "sessionStartHookExecuted",
  "userPromptTurnStartHookExecuted",
  "userPromptReminderHookExecuted",
  "writebackHookExecuted",
  "hookAuthForwarded",
  "workspaceCwdExact",
  "sessionRegistryExact",
  "uninstallRemovedProcess",
  "uninstallReleasedPort",
  "uninstallRemovedPlugin",
  "pluginRegistrationRemoved",
  "npmPackageRemoved",
  "managedChildProcessesRemoved",
  "userStatePreserved",
  "sentinelBytesPreserved",
];

test("Windows E2E report validator requires every exact report schema", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-e2e-validator-"));
  const report = join(root, "report.json");
  try {
    await writeFile(report, "{}\n");
    for (const kind of ["lifecycle", "updated", "codex", "claude"]) {
      const result = spawnSync(
        process.execPath,
        [validator, kind, report],
        { encoding: "utf8" },
      );
      assert.notEqual(result.status, 0, kind);
      assert.match(result.stderr, /keys do not match the required schema/, kind);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows lifecycle report validator rejects false assertions and extra fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-lifecycle-validator-"));
  const report = join(root, "report.json");
  const valid = Object.fromEntries(lifecycleBooleans.map((key) => [key, true]));
  valid.installedVersion = "0.0.1-preview.1";
  try {
    await writeFile(report, `${JSON.stringify(valid)}\n`);
    const accepted = spawnSync(
      process.execPath,
      [validator, "lifecycle", report],
      { encoding: "utf8" },
    );
    assert.equal(accepted.status, 0, accepted.stderr);

    valid.portReleased = false;
    await writeFile(report, `${JSON.stringify(valid)}\n`);
    const failed = spawnSync(
      process.execPath,
      [validator, "lifecycle", report],
      { encoding: "utf8" },
    );
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /E2E assertion failed: portReleased/);

    valid.portReleased = true;
    valid.unexpectedField = true;
    await writeFile(report, `${JSON.stringify(valid)}\n`);
    const extra = spawnSync(
      process.execPath,
      [validator, "lifecycle", report],
      { encoding: "utf8" },
    );
    assert.notEqual(extra.status, 0);
    assert.match(extra.stderr, /keys do not match the required schema/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows Codex report accepts only the current Hook lifecycle schema", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-codex-validator-"));
  const report = join(root, "report.json");
  const valid = Object.fromEntries(codexBooleans.map((key) => [key, true]));
  try {
    await writeFile(report, `${JSON.stringify(valid)}\n`);
    const accepted = spawnSync(
      process.execPath,
      [validator, "codex", report],
      { encoding: "utf8" },
    );
    assert.equal(accepted.status, 0, accepted.stderr);

    delete valid.writebackHookExecuted;
    await writeFile(report, `${JSON.stringify(valid)}\n`);
    const missingHook = spawnSync(
      process.execPath,
      [validator, "codex", report],
      { encoding: "utf8" },
    );
    assert.notEqual(missingHook.status, 0);
    assert.match(missingHook.stderr, /keys do not match the required schema/);

  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows Claude report accepts only the current plugin and Hook lifecycle schema", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-claude-validator-"));
  const report = join(root, "report.json");
  const valid = Object.fromEntries(claudeBooleans.map((key) => [key, true]));
  try {
    await writeFile(report, `${JSON.stringify(valid)}\n`);
    const accepted = spawnSync(
      process.execPath,
      [validator, "claude", report],
      { encoding: "utf8" },
    );
    assert.equal(accepted.status, 0, accepted.stderr);

    delete valid.userPromptTurnStartHookExecuted;
    await writeFile(report, `${JSON.stringify(valid)}\n`);
    const missingHook = spawnSync(
      process.execPath,
      [validator, "claude", report],
      { encoding: "utf8" },
    );
    assert.notEqual(missingHook.status, 0);
    assert.match(missingHook.stderr, /keys do not match the required schema/);

  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows package harness accepts kebab-case verification flags", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-package-harness-flags-"));
  const prefix = join(root, "prefix");
  const packageRoot = join(prefix, "node_modules", "@memorax/memorax-code");
  const workspace = join(root, "workspace");
  const memoraxCodeHome = join(root, "memorax-code-home");
  try {
    await mkdir(
      join(packageRoot, "node_modules", "smol-toml"),
      { recursive: true },
    );
    await mkdir(workspace, { recursive: true });
    await writeFile(join(packageRoot, "package.json"), `${JSON.stringify({
      name: "@memorax/memorax-code",
      version: "0.0.1-preview.1",
    })}\n`);
    await writeFile(
      join(packageRoot, "node_modules", "smol-toml", "package.json"),
      "{}\n",
    );
    const result = spawnSync(
      process.execPath,
      [
        packageHarness,
        "--prefix",
        prefix,
        "--workspace",
        workspace,
        "--mode",
        "lifecycle",
        "--port",
        "19879",
        "--bin-shims-verified",
        "true",
        "--cmd-lifecycle-verified",
        "true",
        "--interrupted-install-recovered",
        "true",
      ],
      {
        env: { ...process.env, MEMORAX_CODE_HOME: memoraxCodeHome },
        encoding: "utf8",
      },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /MemoraX Code lifecycle command failed/);
    assert.doesNotMatch(
      result.stderr,
      /allBinShimsRunnable|cmdLifecycleVerified|interruptedInstallRecovered/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
