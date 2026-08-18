import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { freePort } from "../support/helpers.mjs";

const cliPath = fileURLToPath(new URL("../../dist/memorax-code.js", import.meta.url));

test("Backend lifecycle stages, activates, retains, and package-retires the DSH participant", async () => {
  const fixture = await createFixture();
  try {
    const started = runCli(fixture, "start", ["--clients", "dsh"]);
    assert.equal(started.status, 0, `${started.stdout}\n${started.stderr}`);
    const startReport = JSON.parse(started.stdout);
    assert.equal(startReport.backend.ok, true);
    assert.equal(startReport.dshAdapter.action, "dsh-plugin-activate");
    assert.equal(startReport.dshAdapter.integration, "plugin");
    assert.equal(startReport.dshAdapter.enabled, true);
    assert.equal(readJson(fixture.statePath).enabled, true);
    assert.equal(profileHasAdapter(fixture.profilePath), true);
    assert.match(readFileSync(fixture.dshLog, "utf8"), /^add-begin enabled=false$/m);

    const status = runCli(fixture, "status", ["--clients", "dsh"]);
    assert.equal(status.status, 0, status.stderr);
    const statusReport = JSON.parse(status.stdout);
    assert.equal(statusReport.dshAdapter.integration, "plugin");
    assert.equal(statusReport.dshAdapter.enabled, true);

    const stateBeforeUpgradeStatus = readFileSync(fixture.statePath, "utf8");
    const upgraded = runCli(fixture, "status", ["--clients", "dsh"], {
      FAKE_DSH_VERSION: "0.1.0-rc.7",
    });
    assert.equal(upgraded.status, 0, upgraded.stderr);
    const upgradedReport = JSON.parse(upgraded.stdout);
    assert.equal(upgradedReport.ok, true);
    assert.equal(upgradedReport.dshAdapter.enabled, true);
    assert.equal(upgradedReport.dshAdapter.version, "0.1.0-rc.7");
    assert.equal(upgradedReport.dshAdapter.dshVersionTested, false);
    assert.equal(readFileSync(fixture.statePath, "utf8"), stateBeforeUpgradeStatus);

    const reconciled = runCli(fixture, "start", ["--clients", "dsh"], {
      FAKE_DSH_VERSION: "0.1.0-rc.7",
    });
    assert.equal(reconciled.status, 0, reconciled.stderr);
    assert.equal(JSON.parse(reconciled.stdout).dshAdapter.enabled, true);
    assert.equal(readJson(fixture.statePath).dshVersion, "0.1.0-rc.7");

    const partial = runCli(fixture, "stop", ["--clients", "codex"]);
    assert.equal(partial.status, 0, partial.stderr);
    assert.equal(JSON.parse(partial.stdout).backend.reason, "active_clients_remaining");
    assert.equal(readJson(fixture.statePath).enabled, true);
    assert.equal(existsSync(fixture.pidPath), true);

    const retired = runCli(fixture, "stop", ["--clients", "none"], {
      MEMORAX_CODE_PACKAGE_REPLACEMENT: "1",
    });
    assert.equal(retired.status, 0, retired.stderr);
    const retireReport = JSON.parse(retired.stdout);
    assert.equal(retireReport.backend.ok, true);
    assert.equal(retireReport.dshAdapter.action, "dsh-plugin-disable");
    assert.equal(Object.hasOwn(retireReport, "codexAdapter"), false);
    assert.equal(Object.hasOwn(retireReport, "claudeAdapter"), false);
    assert.equal(readJson(fixture.statePath).enabled, false);
    assert.equal(profileHasAdapter(fixture.profilePath), false);
    assert.equal(existsSync(fixture.pidPath), false);
    assert.match(readFileSync(fixture.dshLog, "utf8"), /^remove enabled=false$/m);
  } finally {
    runCli(fixture, "stop", ["--clients", "none"]);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("DSH recovery revision is serialized with a concurrent user stop and stale recovery is inert", async () => {
  const fixture = await createFixture();
  try {
    const started = runCli(fixture, "start", ["--clients", "dsh"]);
    assert.equal(started.status, 0, `${started.stdout}\n${started.stderr}`);
    const initialState = readJson(fixture.statePath);
    const reused = runCli(fixture, "start", ["--clients", "none"], {
      MEMORAX_CODE_DSH_ADAPTER_RECOVERY: "1",
      MEMORAX_CODE_DSH_ADAPTER_EXPECTED_REVISION: initialState.updatedAt,
    });
    assert.equal(reused.status, 0, `${reused.stdout}\n${reused.stderr}`);
    const reusedState = readJson(fixture.statePath);
    assert.equal(reusedState.enabled, true);
    assert.equal(reusedState.runtimeBundleRoot, initialState.runtimeBundleRoot);
    const revision = reusedState.updatedAt;
    writeFileSync(fixture.dshLog, "");

    const recovery = spawnCli(fixture, "start", ["--clients", "none"], {
      MEMORAX_CODE_DSH_ADAPTER_RECOVERY: "1",
      MEMORAX_CODE_DSH_ADAPTER_EXPECTED_REVISION: revision,
      FAKE_DSH_VERSION: "0.1.0-rc.7",
      FAKE_DSH_ADD_DELAY_MS: "250",
    });
    await waitFor(() => readFileIfExists(fixture.dshLog).includes("add-begin"));
    const stopped = runCli(fixture, "stop");
    const recovered = await recovery;

    assert.equal(recovered.code, 0, recovered.stderr);
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.equal(readJson(fixture.statePath).enabled, false);
    assert.equal(profileHasAdapter(fixture.profilePath), false);
    assert.equal(existsSync(fixture.pidPath), false);
    const calls = readFileSync(fixture.dshLog, "utf8").trim().split("\n");
    assert.ok(calls.indexOf("add-end enabled=false") < calls.indexOf("remove enabled=false"));

    const stateBeforeStaleRecovery = readFileSync(fixture.statePath, "utf8");
    const stale = runCli(fixture, "start", ["--clients", "none"], {
      MEMORAX_CODE_DSH_ADAPTER_RECOVERY: "1",
      MEMORAX_CODE_DSH_ADAPTER_EXPECTED_REVISION: revision,
    });
    assert.equal(stale.status, 0, stale.stderr);
    assert.equal(JSON.parse(stale.stdout).reason, "dsh_recovery_not_authorized");
    assert.equal(readFileSync(fixture.statePath, "utf8"), stateBeforeStaleRecovery);
    assert.equal(existsSync(fixture.pidPath), false);
  } finally {
    runCli(fixture, "stop", ["--clients", "none"]);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("failed Backend ownership checks restore the previously enabled DSH authority", async () => {
  const fixture = await createFixture();
  let originalServiceState;
  try {
    const started = runCli(fixture, "start", ["--clients", "dsh"]);
    assert.equal(started.status, 0, `${started.stdout}\n${started.stderr}`);
    originalServiceState = readJson(fixture.pidPath);
    writeJson(fixture.pidPath, {
      ...originalServiceState,
      instanceId: "unverified-backend-instance",
    });

    for (const command of ["start", "stop"]) {
      const failed = runCli(fixture, command, ["--clients", "dsh"]);
      assert.equal(failed.status, 1, `${failed.stdout}\n${failed.stderr}`);
      const report = JSON.parse(failed.stdout);
      assert.equal(report.backend.ok, false);
      assert.equal(report.dshAdapter.action, "dsh-plugin-activate");
      assert.equal(report.dshAdapter.enabled, true);
      assert.equal(readJson(fixture.statePath).enabled, true);
      assert.equal(profileHasAdapter(fixture.profilePath), true);
    }
  } finally {
    if (originalServiceState && existsSync(fixture.pidPath)) {
      writeJson(fixture.pidPath, originalServiceState);
    }
    runCli(fixture, "stop", ["--clients", "none"]);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("failed DSH preparation restores the prior authority after Backend recovery", async () => {
  const fixture = await createFixture();
  try {
    const started = runCli(fixture, "start", ["--clients", "dsh"]);
    assert.equal(started.status, 0, `${started.stdout}\n${started.stderr}`);

    const failed = runCli(fixture, "start", ["--clients", "dsh"], {
      FAKE_DSH_VERSION: "not-a-semver",
    });
    assert.equal(failed.status, 1, `${failed.stdout}\n${failed.stderr}`);
    const report = JSON.parse(failed.stdout);
    assert.equal(report.backend.ok, true, report.backend.error);
    assert.equal(
      report.backend.reason,
      "dsh_adapter_enable_failed_backend_recovered",
    );
    assert.equal(report.dshAdapter.action, "dsh-plugin-activate");
    assert.equal(report.dshAdapter.enabled, true);
    assert.equal(readJson(fixture.statePath).enabled, true);
    assert.equal(profileHasAdapter(fixture.profilePath), true);
  } finally {
    runCli(fixture, "stop", ["--clients", "none"]);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("failed DSH deselection restores every previously enabled Profile", async () => {
  const fixture = await createFixture();
  const webProfilePath = join(fixture.dshHome, "profiles", "web", "package.json");
  mkdirSync(dirname(webProfilePath), { recursive: true });
  writeJson(webProfilePath, {
    name: "dsh-profile-web",
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ["@deepseek-ai/dsh-base"] } },
  });
  try {
    const started = runCli(fixture, "start", ["--clients", "dsh"]);
    assert.equal(started.status, 0, `${started.stdout}\n${started.stderr}`);
    assert.equal(profileHasAdapter(fixture.profilePath), true);
    assert.equal(profileHasAdapter(webProfilePath), true);

    const failed = runCli(fixture, "start", ["--clients", "none"], {
      FAKE_DSH_REMOVE_FAIL_PROFILE: "web",
    });
    assert.equal(failed.status, 1, `${failed.stdout}\n${failed.stderr}`);
    const report = JSON.parse(failed.stdout);
    assert.equal(report.backend.ok, true, report.backend.error);
    assert.equal(report.backend.reason, "adapter_disable_failed_backend_recovered");
    assert.equal(report.dshAdapter.action, "dsh-plugin-activate");
    assert.equal(report.dshAdapter.enabled, true);
    assert.deepEqual(report.dshAdapter.profiles, ["headless", "web"]);
    assert.deepEqual(readJson(fixture.statePath).profiles, ["headless", "web"]);
    assert.equal(profileHasAdapter(fixture.profilePath), true);
    assert.equal(profileHasAdapter(webProfilePath), true);
  } finally {
    runCli(fixture, "stop", ["--clients", "none"]);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("DSH-only status reports an optional skip when no Profile exists", async () => {
  const fixture = await createFixture();
  try {
    rmSync(join(fixture.dshHome, "profiles"), { recursive: true, force: true });
    const started = runCli(fixture, "start", ["--clients", "none"]);
    assert.equal(started.status, 0, `${started.stdout}\n${started.stderr}`);

    const status = runHumanCli(fixture, "status", ["--clients", "dsh"]);
    assert.equal(status.status, 0, `${status.stdout}\n${status.stderr}`);
    assert.match(status.stdout, /optional DSH integration was skipped/);
    assert.match(status.stdout, /DSH integration was skipped: no_existing_profiles/);
    assert.doesNotMatch(status.stdout, /ready for new DSH sessions/);
  } finally {
    runCli(fixture, "stop", ["--clients", "none"]);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("an existing DSH Profile with an unavailable command needs attention", async () => {
  const fixture = await createFixture();
  try {
    const status = runHumanCli(fixture, "status", ["--clients", "dsh"], {
      FAKE_DSH_VERSION: "not-a-semver",
    });
    assert.equal(status.status, 1, `${status.stdout}\n${status.stderr}`);
    assert.match(status.stdout, /DSH adapter: not ok dsh_version_unavailable/);
    assert.doesNotMatch(status.stdout, /optional DSH integration was skipped/);
  } finally {
    runCli(fixture, "stop", ["--clients", "none"]);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

async function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "memorax-code-backend-dsh-participant-"));
  const memoraxCodeHome = join(root, "memorax-code-home");
  const dshHome = join(root, "dsh-home");
  const dshAdapterRoot = fileURLToPath(new URL("../../../memorax-code-dsh-adapter", import.meta.url));
  const codexHome = join(root, "codex-home");
  const profileRoot = join(dshHome, "profiles", "headless");
  const profilePath = join(profileRoot, "package.json");
  const statePath = join(memoraxCodeHome, "adapters", "dsh", "state.json");
  const pidPath = join(memoraxCodeHome, "runtime", "backend", "backend.pid.json");
  const dshCommand = join(root, "fake-dsh.mjs");
  const dshLog = join(root, "dsh.log");
  const headlessBundleRoot = join(
    dshHome,
    "profiles",
    "node_modules",
    "@deepseek-ai",
    "dsh-headless",
  );
  mkdirSync(profileRoot, { recursive: true });
  mkdirSync(headlessBundleRoot, { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  writeJson(join(headlessBundleRoot, "package.json"), {
    name: "@deepseek-ai/dsh-headless",
    version: "0.1.0-test",
    main: "index.js",
  });
  writeFileSync(join(headlessBundleRoot, "index.js"), "module.exports = {};\n");
  writeFileSync(profilePath, `${JSON.stringify({
    name: "dsh-profile-headless",
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"] } },
  }, null, 2)}\n`);
  writeFileSync(dshCommand, `#!/usr/bin/env node
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const statePath = join(process.env.MEMORAX_CODE_HOME, "adapters", "dsh", "state.json");
const enabled = () => existsSync(statePath) && JSON.parse(readFileSync(statePath, "utf8")).enabled === true;
if (args.length === 1 && args[0] === "--version") {
  console.log(process.env.FAKE_DSH_VERSION || "0.1.0-rc.6");
  process.exit(0);
}
const profile = args[args.indexOf("--profile") + 1];
const operation = args[3];
const profileRoot = join(process.env.DSH_HOME, "profiles", profile);
const manifestPath = join(profileRoot, "package.json");
const adapterScope = join(profileRoot, "node_modules", "@memorax-code");
const installedAdapterRoot = join(adapterScope, "dsh-memorax-code");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (operation === "add") {
  appendFileSync(process.env.FAKE_DSH_LOG, "add-begin enabled=" + enabled() + "\\n");
  const delay = Number(process.env.FAKE_DSH_ADD_DELAY_MS || 0);
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
  rmSync(installedAdapterRoot, { recursive: true, force: true });
  mkdirSync(adapterScope, { recursive: true });
  cpSync(args[4].slice("file:".length), installedAdapterRoot, { recursive: true });
  manifest.dependencies["@memorax-code/dsh-memorax-code"] = args[4];
  if (!manifest.dsh.profile.bundles.includes("@memorax-code/dsh-memorax-code")) manifest.dsh.profile.bundles.push("@memorax-code/dsh-memorax-code");
  appendFileSync(process.env.FAKE_DSH_LOG, "add-end enabled=" + enabled() + "\\n");
} else if (operation === "remove") {
  appendFileSync(process.env.FAKE_DSH_LOG, "remove enabled=" + enabled() + "\\n");
  if (profile === process.env.FAKE_DSH_REMOVE_FAIL_PROFILE) process.exit(1);
  rmSync(installedAdapterRoot, { recursive: true, force: true });
  delete manifest.dependencies["@memorax-code/dsh-memorax-code"];
  manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter((name) => name !== "@memorax-code/dsh-memorax-code");
} else process.exit(2);
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\\n");
`);
  chmodSync(dshCommand, 0o755);
  return {
    root,
    memoraxCodeHome,
    dshHome,
    dshAdapterRoot,
    codexHome,
    profilePath,
    statePath,
    pidPath,
    dshCommand,
    dshLog,
    port: await freePort(),
  };
}

function runCli(fixture, command, args = [], env = {}) {
  return spawnSync(process.execPath, [cliPath, command, ...commonArgs(fixture), ...args], {
    encoding: "utf8",
    env: childEnv(fixture, env),
  });
}

function spawnCli(fixture, command, args = [], env = {}) {
  const child = spawn(process.execPath, [cliPath, command, ...commonArgs(fixture), ...args], {
    env: childEnv(fixture, env),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  return new Promise((resolve) => {
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
    child.on("error", (error) => resolve({ code: 1, stdout, stderr: `${stderr}${error.message}` }));
  });
}

function runHumanCli(fixture, command, args = [], env = {}) {
  return spawnSync(process.execPath, [
    cliPath,
    command,
    ...commonArgs(fixture).filter((arg) => arg !== "--json"),
    ...args,
  ], {
    encoding: "utf8",
    env: childEnv(fixture, env),
  });
}

function commonArgs(fixture) {
  return [
    "--json",
    "--home", fixture.memoraxCodeHome,
    "--port", String(fixture.port),
    "--codex-home", fixture.codexHome,
    "--dsh-home", fixture.dshHome,
    "--dsh-command", fixture.dshCommand,
    "--dsh-adapter-root", fixture.dshAdapterRoot,
    "--memorax-code-command", cliPath,
  ];
}

function childEnv(fixture, overrides) {
  return {
    ...process.env,
    HOME: fixture.root,
    MEMORAX_CODE_HOME: fixture.memoraxCodeHome,
    DSH_HOME: fixture.dshHome,
    MEMORAX_CODE_DSH_COMMAND: fixture.dshCommand,
    FAKE_DSH_LOG: fixture.dshLog,
    ...overrides,
  };
}

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for DSH lifecycle fixture");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function readFileIfExists(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function profileHasAdapter(path) {
  const manifest = readJson(path);
  return Object.hasOwn(manifest.dependencies, "@memorax-code/dsh-memorax-code")
    && manifest.dsh.profile.bundles.includes("@memorax-code/dsh-memorax-code");
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
