import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
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

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const commonRoot = fileURLToPath(new URL("../../../ts/memorax-code-adapter-common/src/", import.meta.url));

test("main CLI keeps DSH inert until Backend success and disables it before stop or uninstall", () => {
  const fixture = createFixture();
  try {
    const started = runCli(fixture, "start");
    assert.equal(started.status, 0, started.stderr);
    assert.equal(readJson(fixture.statePath).enabled, true);
    assert.equal(profileHasAdapter(fixture.profilePath), true);

    const stopped = runCli(fixture, "stop");
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.equal(readJson(fixture.statePath).enabled, false);
    assert.equal(profileHasAdapter(fixture.profilePath), false);

    const restarted = runCli(fixture, "restart");
    assert.equal(restarted.status, 0, restarted.stderr);
    assert.equal(readJson(fixture.statePath).enabled, true);
    assert.equal(profileHasAdapter(fixture.profilePath), true);

    const uninstalled = runCli(fixture, "uninstall");
    assert.equal(uninstalled.status, 0, uninstalled.stderr);
    assert.equal(existsSync(fixture.statePath), false);
    assert.equal(profileHasAdapter(fixture.profilePath), false);

    assert.deepEqual(readFileSync(fixture.backendLog, "utf8").trim().split("\n"), [
      "start enabled=false external=false",
      "stop enabled=false external=false",
      "restart enabled=false external=false",
      "uninstall enabled=false external=false",
    ]);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("targeted Hook-client stop preserves an enabled DSH Backend consumer", () => {
  const fixture = createFixture();
  try {
    assert.equal(runCli(fixture, "start").status, 0);
    const stopped = runCli(fixture, "stop", { args: ["--clients", "codex"] });
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.equal(readJson(fixture.statePath).enabled, true);
    assert.equal(profileHasAdapter(fixture.profilePath), true);
    assert.match(readFileSync(fixture.backendLog, "utf8"), /^stop enabled=true external=true$/m);
  } finally {
    runCli(fixture, "stop");
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("main CLI restores custom DSH authority after its installer environment disappears", () => {
  const fixture = createFixture();
  try {
    assert.equal(runCli(fixture, "start").status, 0);

    const conflicting = runCli(fixture, "stop", {
      env: { DSH_HOME: join(fixture.root, "different-dsh-home") },
    });
    assert.equal(conflicting.status, 1);
    assert.equal(readJson(fixture.statePath).enabled, true);
    assert.equal(profileHasAdapter(fixture.profilePath), true);

    const stopped = runCli(fixture, "stop", { omitDshAuthority: true });
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.equal(readJson(fixture.statePath).enabled, false);
    assert.equal(profileHasAdapter(fixture.profilePath), false);

    const restarted = runCli(fixture, "restart", { omitDshAuthority: true });
    assert.equal(restarted.status, 0, restarted.stderr);
    assert.equal(readJson(fixture.statePath).enabled, true);
    assert.equal(profileHasAdapter(fixture.profilePath), true);

    const uninstalled = runCli(fixture, "uninstall", { omitDshAuthority: true });
    assert.equal(uninstalled.status, 0, uninstalled.stderr);
    assert.equal(existsSync(fixture.statePath), false);
    assert.equal(profileHasAdapter(fixture.profilePath), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a concurrent user stop is ordered after an in-flight DSH Backend recovery", async () => {
  const fixture = createFixture();
  try {
    assert.equal(runCli(fixture, "start").status, 0);
    const revision = readJson(fixture.statePath).updatedAt;
    writeFileSync(fixture.backendLog, "");
    const recovery = spawnCli(fixture, "start", {
      args: ["--clients", "none"],
      env: {
        MEMORAX_CODE_DSH_ADAPTER_RECOVERY: "1",
        MEMORAX_CODE_DSH_ADAPTER_EXPECTED_REVISION: revision,
        MEMORAX_CODE_TEST_BACKEND_DELAY_MS: "250",
      },
    });
    await waitFor(() => readFileIfExists(fixture.backendLog).includes("start-begin"));

    const stopped = runCli(fixture, "stop");
    assert.equal(stopped.status, 0, stopped.stderr);
    const recovered = await recovery;
    assert.equal(recovered.code, 0, recovered.stderr);
    assert.equal(readJson(fixture.statePath).enabled, false);
    assert.equal(profileHasAdapter(fixture.profilePath), false);
    assert.deepEqual(readFileSync(fixture.backendLog, "utf8").trim().split("\n"), [
      "start-begin enabled=false",
      "start-end enabled=false external=false",
      "stop enabled=false external=false",
    ]);

    const stale = runCli(fixture, "start", {
      args: ["--clients", "none"],
      env: {
        MEMORAX_CODE_DSH_ADAPTER_RECOVERY: "1",
        MEMORAX_CODE_DSH_ADAPTER_EXPECTED_REVISION: revision,
      },
    });
    assert.equal(stale.status, 0, stale.stderr);
    assert.equal(readFileSync(fixture.backendLog, "utf8").includes("start-end enabled=true"), false);
    assert.equal(readJson(fixture.statePath).enabled, false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "memorax-code-dsh-lifecycle-"));
  const binRoot = join(root, "bin");
  const libRoot = join(root, "lib");
  const memoraxCodeHome = join(root, "memorax-code-home");
  const dshHome = join(root, "dsh-home");
  const profileRoot = join(dshHome, "profiles", "headless");
  const profilePath = join(profileRoot, "package.json");
  const statePath = join(memoraxCodeHome, "adapters", "dsh", "state.json");
  const backendLog = join(root, "backend.log");
  const dshCommand = join(root, "fake-dsh.mjs");
  mkdirSync(binRoot, { recursive: true });
  mkdirSync(libRoot, { recursive: true });
  mkdirSync(profileRoot, { recursive: true });

  for (const path of [
    "bin/memorax-code.mjs",
    "lib/client-hook-runtime.mjs",
    "lib/dsh-plugin-install.mjs",
    "lib/node-version.mjs",
    "lib/npm-invocation.mjs",
    "lib/resolve-claude-command.mjs",
    "lib/resolve-codex-command.mjs",
    "lib/run-entrypoint.mjs",
    "lib/vscode-extension-command.mjs",
    "lib/windows-cli-invocation.mjs",
  ]) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(packageRoot, path), target);
  }
  for (const path of ["config-utils.mjs", "runtime-record.mjs"]) {
    const target = join(libRoot, "memorax-code-adapter-common", "src", path);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(commonRoot, path), target);
  }

  const adapterRoot = join(libRoot, "memorax-code-dsh-adapter");
  mkdirSync(join(adapterRoot, "skills", "memorax-code"), { recursive: true });
  mkdirSync(join(adapterRoot, "hooks"), { recursive: true });
  writeFileSync(join(adapterRoot, "package.json"), `${JSON.stringify({
    name: "@memorax-code/dsh-adapter",
    version: "0.0.0-test",
    type: "module",
    dsh: { bundle: { patch: "./cordis.patch.yml" } },
  }, null, 2)}\n`);
  writeFileSync(join(adapterRoot, "cordis.patch.yml"), "[]\n");
  writeFileSync(join(adapterRoot, "skills", "memorax-code", "SKILL.md"), "skill\n");
  writeFileSync(join(adapterRoot, "skills", "memorax-code", "dsh-definition.json"), "{}\n");
  writeFileSync(join(adapterRoot, "hooks", "repo-memory-job.mjs"), "// helper\n");
  writeFileSync(profilePath, `${JSON.stringify({
    name: "dsh-profile-headless",
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"] } },
  }, null, 2)}\n`);

  const backendEntrypoint = join(libRoot, "memorax-code-backend", "dist", "memorax-code.js");
  mkdirSync(dirname(backendEntrypoint), { recursive: true });
  writeFileSync(backendEntrypoint, [
    "import { appendFileSync, readFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    "const state = JSON.parse(readFileSync(join(process.env.MEMORAX_CODE_HOME, 'adapters', 'dsh', 'state.json'), 'utf8'));",
    "const delay = Number(process.env.MEMORAX_CODE_TEST_BACKEND_DELAY_MS || 0);",
    `if (delay > 0) appendFileSync(${JSON.stringify(backendLog)}, process.argv[2] + '-begin enabled=' + state.enabled + '\\n');`,
    "if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));",
    `appendFileSync(${JSON.stringify(backendLog)}, process.argv[2] + (delay > 0 ? '-end' : '') + ' enabled=' + state.enabled + ' external=' + (process.env.MEMORAX_CODE_EXTERNAL_BACKEND_CLIENT_ACTIVE === '1') + '\\n');`,
    "process.exit(0);",
    "",
  ].join("\n"));

  writeFileSync(dshCommand, [
    "#!/usr/bin/env node",
    "import { readFileSync, writeFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    "const args = process.argv.slice(2);",
    "const profile = args[args.indexOf('--profile') + 1];",
    "const operation = args[3];",
    "const manifestPath = join(process.env.DSH_HOME, 'profiles', profile, 'package.json');",
    "const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));",
    "if (operation === 'add') {",
    "  manifest.dependencies['@memorax-code/dsh-adapter'] = args[4];",
    "  if (!manifest.dsh.profile.bundles.includes('@memorax-code/dsh-adapter')) manifest.dsh.profile.bundles.push('@memorax-code/dsh-adapter');",
    "} else if (operation === 'remove') {",
    "  delete manifest.dependencies['@memorax-code/dsh-adapter'];",
    "  manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter((name) => name !== '@memorax-code/dsh-adapter');",
    "} else process.exit(2);",
    "writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\\n');",
    "",
  ].join("\n"));
  chmodSync(dshCommand, 0o755);
  writeFileSync(join(root, "package.json"), `${JSON.stringify({
    name: "@memorax/memorax-code-test",
    version: "0.0.0-test",
    type: "module",
  }, null, 2)}\n`);

  return {
    root,
    cli: join(binRoot, "memorax-code.mjs"),
    memoraxCodeHome,
    dshHome,
    dshCommand,
    profilePath,
    statePath,
    backendLog,
  };
}

function runCli(fixture, command, { args = [], env = {}, omitDshAuthority = false } = {}) {
  const childEnv = {
    ...process.env,
    HOME: fixture.root,
    DSH_HOME: fixture.dshHome,
    MEMORAX_CODE_HOME: fixture.memoraxCodeHome,
    MEMORAX_CODE_DSH_COMMAND: fixture.dshCommand,
    MEMORAX_CODE_DEFER_CLIENT_HOOK_RUNTIME_ACTIVATION: "1",
    ...env,
  };
  if (omitDshAuthority) {
    delete childEnv.DSH_HOME;
    delete childEnv.MEMORAX_CODE_DSH_COMMAND;
  }
  return spawnSync(process.execPath, [fixture.cli, command, "--home", fixture.memoraxCodeHome, ...args], {
    encoding: "utf8",
    env: childEnv,
  });
}

function spawnCli(fixture, command, { args = [], env = {} } = {}) {
  const child = spawn(process.execPath, [fixture.cli, command, "--home", fixture.memoraxCodeHome, ...args], {
    env: {
      ...process.env,
      HOME: fixture.root,
      DSH_HOME: fixture.dshHome,
      MEMORAX_CODE_HOME: fixture.memoraxCodeHome,
      MEMORAX_CODE_DSH_COMMAND: fixture.dshCommand,
      MEMORAX_CODE_DEFER_CLIENT_HOOK_RUNTIME_ACTIVATION: "1",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  return new Promise((resolvePromise) => {
    child.on("close", (code, signal) => resolvePromise({ code, signal, stdout, stderr }));
    child.on("error", (error) => resolvePromise({ code: 1, stdout, stderr: `${stderr}${error.message}` }));
  });
}

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for DSH lifecycle fixture");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
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
  return Object.hasOwn(manifest.dependencies, "@memorax-code/dsh-adapter")
    && manifest.dsh.profile.bundles.includes("@memorax-code/dsh-adapter");
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}
