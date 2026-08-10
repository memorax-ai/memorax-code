import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  cleanupCodexAfterBackendRemoval,
  isCodexPluginActive,
  isCodexPluginStaged,
  removeCodexPlugin,
} from "../../../dist/clients/codex/plugin-install.js";

const cliPath = fileURLToPath(new URL("../../../dist/memorax-code.js", import.meta.url));
const bundledCodexManifestPath = fileURLToPath(new URL(
  "../../../../memorax-code-codex-adapter/.codex-plugin/plugin.json",
  import.meta.url,
));
const TEST_PREVIOUS_PLUGIN_VERSION = "0.0.9";

async function runMemoraxCode(args, env) {
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function canonicalCodexFixture() {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-codex-versioned-update-"));
  const home = join(root, "home");
  const codexHome = join(home, "codex-home");
  const marketplaceRoot = join(codexHome, ".memorax-code", "marketplaces", "memorax-code");
  const marketplacePath = join(marketplaceRoot, ".agents", "plugins", "marketplace.json");
  const sourceA = join(marketplaceRoot, "plugins", "memorax-code-codex-adapter");
  const cacheRoot = join(
    codexHome,
    "plugins",
    "cache",
    "memorax-code",
    "memorax-code-codex-adapter",
  );
  const cacheA = join(cacheRoot, TEST_PREVIOUS_PLUGIN_VERSION);
  const version = JSON.parse(await readFile(bundledCodexManifestPath, "utf8")).version;
  await mkdir(join(sourceA, ".codex-plugin"), { recursive: true });
  await mkdir(join(cacheA, ".codex-plugin"), { recursive: true });
  await mkdir(join(cacheA, "skills", "memorax-code"), { recursive: true });
  await writeFile(join(sourceA, "sentinel.txt"), "source A\n");
  await writeFile(join(cacheA, "sentinel.txt"), "cache A\n");
  await writeFile(
    join(cacheA, ".codex-plugin", "plugin.json"),
    `${JSON.stringify({ name: "memorax-code-codex-adapter", version: TEST_PREVIOUS_PLUGIN_VERSION })}\n`,
  );
  await writeFile(join(cacheA, "skills", "memorax-code", "SKILL.md"), "---\nname: memorax-code\n---\n");
  await mkdir(join(marketplaceRoot, ".agents", "plugins"), { recursive: true });
  await writeFile(marketplacePath, `${JSON.stringify({
    name: "memorax-code",
    plugins: [{
      name: "memorax-code-codex-adapter",
      source: { source: "local", path: "./plugins/memorax-code-codex-adapter" },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      category: "Productivity",
    }],
  }, null, 2)}\n`);
  return {
    root,
    home,
    codexHome,
    marketplaceRoot,
    marketplacePath,
    sourceA,
    cacheRoot,
    cacheA,
    version,
    env: { HOME: home, CODEX_HOME: codexHome },
  };
}

async function assertPluginCodexCommand(pluginRoot, expected) {
  const moduleUrl = pathToFileURL(join(
    pluginRoot,
    "memorax-code-adapter-common",
    "src",
    "clients",
    "codex-command.mjs",
  ));
  moduleUrl.searchParams.set("root", pluginRoot);
  const { resolveHookCodexCommand } = await import(moduleUrl.href);
  assert.equal(resolveHookCodexCommand({ env: {}, pluginRoot }), expected);
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("Codex plugin readiness requires a manifest and the canonical memory skill", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-codex-plugin-readiness-"));
  const codexHome = join(root, "codex-home");
  const stagedRoot = join(codexHome, ".memorax-code", "plugins", "memorax-code-codex-adapter");
  const activeRoot = join(
    codexHome,
    "plugins",
    "cache",
    "memorax-code",
    "memorax-code-codex-adapter",
    "0.1.0",
  );
  try {
    await mkdir(join(stagedRoot, "skills", "memorax-code"), { recursive: true });
    await writeFile(join(stagedRoot, "skills", "memorax-code", "SKILL.md"), "---\nname: memorax-code\n---\n");
    assert.equal(isCodexPluginStaged({ codexHome }), false);
    await mkdir(join(stagedRoot, ".codex-plugin"), { recursive: true });
    await writeFile(join(stagedRoot, ".codex-plugin", "plugin.json"), "{}\n");
    assert.equal(isCodexPluginStaged({ codexHome }), true);
    assert.equal(isCodexPluginActive({ codexHome }), false);

    await mkdir(join(activeRoot, "skills", "memorax-code"), { recursive: true });
    await writeFile(join(activeRoot, "skills", "memorax-code", "SKILL.md"), "---\nname: memorax-code\n---\n");
    assert.equal(isCodexPluginActive({ codexHome }), false);
    await mkdir(join(activeRoot, ".codex-plugin"), { recursive: true });
    await writeFile(join(activeRoot, ".codex-plugin", "plugin.json"), "{}\n");
    assert.equal(isCodexPluginActive({ codexHome }), true);
    await rm(join(activeRoot, "skills"), { recursive: true, force: true });
    assert.equal(isCodexPluginActive({ codexHome }), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("codex-plugin install uses CODEX_HOME and registers the personal marketplace", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-codex-plugin-install-"));
  const home = join(root, "home");
  const codexHome = join(home, "codex-home");
  const codexCommand = join(root, "Codex.app", "Contents", "Resources", "codex");
  try {
    await mkdir(home, { recursive: true });
    await mkdir(join(root, "Codex.app", "Contents", "Resources"), { recursive: true });
    await writeFile(codexCommand, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const result = await runMemoraxCode(["codex-plugin", "install", "--json"], {
      HOME: home,
      CODEX_HOME: codexHome,
      CODEX_CLI_PATH: codexCommand,
    });

    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.action, "codex-plugin-install");
    assert.equal(report.registrationMode, "bootstrap");
    assert.equal(report.codexHome, codexHome);
    assert.equal(report.startsBackend, false);

    const stagedPluginRoot = join(codexHome, ".memorax-code", "plugins", "memorax-code-codex-adapter");
    const pluginManifest = JSON.parse(await readFile(join(stagedPluginRoot, ".codex-plugin", "plugin.json"), "utf8"));
    assert.equal(pluginManifest.name, "memorax-code-codex-adapter");
    assert.equal(pluginManifest.interface.logo, "./assets/logo.png");
    assert.equal(pluginManifest.interface.composerIcon, "./assets/composer-icon.png");
    await stat(join(stagedPluginRoot, "assets", "logo.png"));
    await stat(join(stagedPluginRoot, "assets", "composer-icon.png"));
    const metadata = JSON.parse(await readFile(join(stagedPluginRoot, ".memorax-code-package.json"), "utf8"));
    assert.equal(metadata.version, 1);
    assert.match(metadata.memoraxCodeCommand, /memorax-code\.js|memorax-code\.mjs/);
    assert.equal(metadata.codexCommand, codexCommand);
    await assertPluginCodexCommand(stagedPluginRoot, codexCommand);

    const stagedPluginData = join(root, "plugin-data-staged");
    await assertCaptureHookRuns({
      pluginRoot: stagedPluginRoot,
      pluginData: stagedPluginData,
      home,
      codexHome,
      root,
      sessionId: "test-session",
    });

    const cachedPluginRoot = join(codexHome, "plugins", "cache", "personal", "memorax-code-codex-adapter", "0.1.0");
    await mkdir(join(codexHome, "plugins", "cache", "personal", "memorax-code-codex-adapter"), { recursive: true });
    await cp(stagedPluginRoot, cachedPluginRoot, { recursive: true });
    await assertPluginCodexCommand(cachedPluginRoot, codexCommand);
    await assertCaptureHookRuns({
      pluginRoot: cachedPluginRoot,
      pluginData: join(root, "plugin-data-cache"),
      home,
      codexHome,
      root,
      sessionId: "test-cache-session",
    });

    const marketplacePath = join(home, ".agents", "plugins", "marketplace.json");
    assert.equal(report.marketplacePath, marketplacePath);
    const marketplace = JSON.parse(await readFile(marketplacePath, "utf8"));
    assert.equal(marketplace.name, "personal");
    assert.deepEqual(marketplace.interface, { displayName: "Personal" });
    assert.deepEqual(marketplace.plugins, [{
      name: "memorax-code-codex-adapter",
      source: {
        source: "local",
        path: "./codex-home/.memorax-code/plugins/memorax-code-codex-adapter",
      },
      policy: {
        installation: "AVAILABLE",
        authentication: "ON_INSTALL",
      },
      category: "Productivity",
    }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("codex-plugin install refreshes an existing explicit CLI marketplace source", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-codex-plugin-refresh-marketplace-"));
  const home = join(root, "home");
  const codexHome = join(home, "codex-home");
  const cliMarketplaceRoot = join(codexHome, ".memorax-code", "marketplaces", "memorax-code");
  const pluginRoot = join(cliMarketplaceRoot, "plugins", "memorax-code-codex-adapter");
  try {
    await mkdir(pluginRoot, { recursive: true });
    await writeFile(join(pluginRoot, "stale.txt"), "stale plugin source\n");

    const result = await runMemoraxCode(["codex-plugin", "install", "--json"], {
      HOME: home,
      CODEX_HOME: codexHome,
    });

    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    await assert.rejects(readFile(join(pluginRoot, "stale.txt"), "utf8"), /ENOENT/);
    const marketplace = JSON.parse(await readFile(join(cliMarketplaceRoot, ".agents", "plugins", "marketplace.json"), "utf8"));
    assert.equal(marketplace.name, "memorax-code");
    const pluginManifest = JSON.parse(await readFile(join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8"));
    assert.equal(pluginManifest.name, "memorax-code-codex-adapter");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("codex-plugin install publishes B before switching the canonical marketplace and preserves A", async () => {
  const fixture = await canonicalCodexFixture();
  try {
    const result = await runMemoraxCode(["codex-plugin", "install", "--json"], fixture.env);
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);

    assert.equal(await readFile(join(fixture.cacheA, "sentinel.txt"), "utf8"), "cache A\n");
    assert.equal(await readFile(join(fixture.sourceA, "sentinel.txt"), "utf8"), "source A\n");
    const cacheB = join(fixture.cacheRoot, fixture.version);
    const sourceB = join(
      fixture.marketplaceRoot,
      "versions",
      fixture.version,
      "plugins",
      "memorax-code-codex-adapter",
    );
    await stat(join(cacheB, "skills", "memorax-code", "SKILL.md"));
    await stat(join(cacheB, "assets", "logo.png"));
    await stat(join(cacheB, "assets", "composer-icon.png"));
    await stat(join(sourceB, "hooks", "runtime-hook.mjs"));
    await stat(join(sourceB, "assets", "logo.png"));
    await stat(join(sourceB, "assets", "composer-icon.png"));
    assert.deepEqual(
      (await readdir(fixture.cacheRoot)).sort(),
      [TEST_PREVIOUS_PLUGIN_VERSION, fixture.version].sort(),
    );

    const marketplace = JSON.parse(await readFile(fixture.marketplacePath, "utf8"));
    assert.equal(
      marketplace.plugins[0].source.path,
      `./versions/${fixture.version}/plugins/memorax-code-codex-adapter`,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("codex-plugin install repairs a missing canonical marketplace entry", async () => {
  const fixture = await canonicalCodexFixture();
  try {
    await writeFile(fixture.marketplacePath, `${JSON.stringify({
      name: "memorax-code",
      interface: { displayName: "MemoraX Code" },
      plugins: [],
    }, null, 2)}\n`);

    const result = await runMemoraxCode(["codex-plugin", "install", "--json"], fixture.env);
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(JSON.parse(result.stdout).registrationMode, "versioned-update");
    assert.equal(await readFile(join(fixture.cacheA, "sentinel.txt"), "utf8"), "cache A\n");

    const marketplace = JSON.parse(await readFile(fixture.marketplacePath, "utf8"));
    assert.deepEqual(marketplace.plugins, [{
      name: "memorax-code-codex-adapter",
      source: {
        source: "local",
        path: `./versions/${fixture.version}/plugins/memorax-code-codex-adapter`,
      },
      policy: {
        installation: "AVAILABLE",
        authentication: "ON_INSTALL",
      },
      category: "Productivity",
    }]);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("codex-plugin install leaves A and its pointer unchanged when B is invalid", async () => {
  const fixture = await canonicalCodexFixture();
  try {
    await mkdir(join(fixture.cacheRoot, fixture.version), { recursive: true });
    await writeFile(join(fixture.cacheRoot, fixture.version, "partial.txt"), "partial B\n");
    const before = await readFile(fixture.marketplacePath, "utf8");

    const result = await runMemoraxCode(["codex-plugin", "install", "--json"], fixture.env);
    assert.equal(result.code, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /Codex plugin artifact/);
    assert.equal(await readFile(fixture.marketplacePath, "utf8"), before);
    assert.equal(await readFile(join(fixture.cacheA, "sentinel.txt"), "utf8"), "cache A\n");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("codex-plugin install never overwrites an existing same-version source or cache", async () => {
  const fixture = await canonicalCodexFixture();
  try {
    const first = await runMemoraxCode(["codex-plugin", "install", "--json"], fixture.env);
    assert.equal(first.code, 0, `${first.stdout}\n${first.stderr}`);
    const cacheB = join(fixture.cacheRoot, fixture.version);
    const sourceB = join(
      fixture.marketplaceRoot,
      "versions",
      fixture.version,
      "plugins",
      "memorax-code-codex-adapter",
    );
    await writeFile(join(cacheB, "same-version-sentinel.txt"), "cache B\n");
    await writeFile(join(sourceB, "same-version-sentinel.txt"), "source B\n");

    const second = await runMemoraxCode(["codex-plugin", "install", "--json"], fixture.env);
    assert.equal(second.code, 0, `${second.stdout}\n${second.stderr}`);
    assert.equal(await readFile(join(cacheB, "same-version-sentinel.txt"), "utf8"), "cache B\n");
    assert.equal(await readFile(join(sourceB, "same-version-sentinel.txt"), "utf8"), "source B\n");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("codex-plugin install defaults Codex home to ~/.codex", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-codex-plugin-default-home-"));
  const home = join(root, "home");
  try {
    await mkdir(home, { recursive: true });
    const result = await runMemoraxCode(["codex-plugin", "install", "--json"], {
      HOME: home,
      CODEX_HOME: "",
    });

    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    const report = JSON.parse(result.stdout);
    assert.equal(report.codexHome, join(home, ".codex"));
    const marketplace = JSON.parse(await readFile(join(home, ".agents", "plugins", "marketplace.json"), "utf8"));
    assert.equal(marketplace.plugins[0].source.path, "./.codex/.memorax-code/plugins/memorax-code-codex-adapter");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("memorax-code uninstall leaves Codex config unchanged and removes the plugin", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-uninstall-cli-"));
  const home = join(root, "home");
  const codexHome = join(home, "codex-home");
  const memoraxCodeHome = join(home, "memorax-code-home");
  const port = await freePort();
  try {
    await mkdir(codexHome, { recursive: true });
    await mkdir(memoraxCodeHome, { recursive: true });
    await writeFile(join(memoraxCodeHome, "config.toml"), [
      "[model]",
      'base_url = "http://127.0.0.1:7777/anthropic"',
      'api_key = "local-secret"',
      'model = "local-config-model"',
      "",
    ].join("\n"));
    const originalCodexConfig = [
      'model_provider = "custom"',
      'model = "gpt-5.5"',
      "",
      "[model_providers.custom]",
      'base_url = "http://127.0.0.1:9999/v1"',
      'wire_api = "responses"',
      "",
    ].join("\n");
    await writeFile(join(codexHome, "config.toml"), originalCodexConfig);

    const install = await runMemoraxCode(["codex-plugin", "install", "--json"], {
      HOME: home,
      CODEX_HOME: codexHome,
    });
    assert.equal(install.code, 0, `${install.stdout}\n${install.stderr}`);

    const start = await runMemoraxCode([
      "start",
      "--home",
      memoraxCodeHome,
      "--codex-home",
      codexHome,
      "--port",
      String(port),
      "--clients",
      "codex",
      "--json",
    ], {
      HOME: home,
      CODEX_HOME: codexHome,
    });
    assert.equal(start.code, 0, `${start.stdout}\n${start.stderr}`);
    assert.equal(await readFile(join(codexHome, "config.toml"), "utf8"), originalCodexConfig);

    const uninstall = await runMemoraxCode([
      "uninstall",
      "--home",
      memoraxCodeHome,
      "--codex-home",
      codexHome,
      "--port",
      String(port),
      "--clients",
      "codex",
      "--json",
    ], {
      HOME: home,
      CODEX_HOME: codexHome,
    });
    assert.equal(uninstall.code, 0, `${uninstall.stdout}\n${uninstall.stderr}`);
    const report = JSON.parse(uninstall.stdout);
    assert.equal(report.action, "uninstall");
    assert.equal(report.ok, true);
    assert.equal(report.removesPlugin, true);
    assert.equal(report.removesUserState, false);

    const config = await readFile(join(codexHome, "config.toml"), "utf8");
    assert.equal(config, originalCodexConfig);
    await assert.rejects(stat(join(codexHome, ".memorax-code", "plugins", "memorax-code-codex-adapter", ".codex-plugin", "plugin.json")), /ENOENT/);
    await assert.rejects(stat(join(codexHome, ".memorax-code", "plugins", "memorax-code-codex-adapter", "assets")), /ENOENT/);
    const marketplace = JSON.parse(await readFile(join(home, ".agents", "plugins", "marketplace.json"), "utf8"));
    assert.deepEqual(marketplace.plugins ?? [], []);
  } finally {
    await runMemoraxCode(["stop", "--home", memoraxCodeHome, "--codex-home", codexHome, "--port", String(port), "--clients", "none"], {
      HOME: home,
      CODEX_HOME: codexHome,
    }).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

async function assertMemoraxCodeNpmPackageRemoval(packageName) {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-uninstall-npm-"));
  const home = join(root, "home");
  const packageRoot = join(root, "node_modules", ...packageName.split("/"));
  const fakeBin = join(root, "bin");
  const npmLog = join(root, "npm.log");
  const fakeNpm = join(fakeBin, "npm");
  try {
    await mkdir(home, { recursive: true });
    await mkdir(join(home, "memorax-code-home"), { recursive: true });
    await writeFile(join(home, "memorax-code-home", "config.toml"), "[clients]\ncodex = false\nclaude = false\n");
    await mkdir(join(packageRoot, "bin"), { recursive: true });
    await mkdir(fakeBin, { recursive: true });
    await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: packageName, version: "0.1.2" }));
    await writeFile(join(packageRoot, "bin", "memorax-code.mjs"), "#!/usr/bin/env node\n");
    await writeFile(fakeNpm, `#!/bin/sh\nprintf '["%s","%s","%s"]\\n' "$1" "$2" "$3" >> ${JSON.stringify(npmLog)}\n`);
    await chmod(fakeNpm, 0o755);

    const uninstall = await runMemoraxCode([
      "uninstall",
      "--home",
      join(home, "memorax-code-home"),
      "--clients",
      "none",
      "--json",
    ], {
      HOME: home,
      PATH: `${fakeBin}:${process.env.PATH}`,
      MEMORAX_CODE_NPM_PACKAGE_ROOT: packageRoot,
      MEMORAX_CODE_NPM_COMMAND: "/bin/sh",
      MEMORAX_CODE_NPM_EXEC_PATH: fakeNpm,
      npm_execpath: "",
    });

    assert.equal(uninstall.code, 0, `${uninstall.stdout}\n${uninstall.stderr}`);
    const report = JSON.parse(uninstall.stdout);
    assert.equal(report.action, "uninstall");
    assert.equal(report.npmPackageRemoval.ok, true);
    assert.equal(report.npmPackageRemoval.packageName, packageName);
    const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace("/", "\\/");
    assert.match(await readFile(npmLog, "utf8"), new RegExp(`^\\["uninstall","-g","${escaped}"\\]$`, "m"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function workspaceRoot() {
  return fileURLToPath(new URL("../../../../..", import.meta.url));
}

async function assertCaptureHookRuns({ pluginRoot, pluginData, home, codexHome, root, sessionId }) {
  const hookResult = await new Promise((resolve) => {
    const hook = spawn(
      process.execPath,
      [join(pluginRoot, "hooks", "runtime-hook.mjs"), "capture-cwd"],
      {
        env: {
          ...process.env,
          HOME: home,
          CODEX_HOME: codexHome,
          MEMORAX_CODE_HOME: join(home, "memorax-code-home"),
          PLUGIN_ROOT: pluginRoot,
          PLUGIN_DATA: pluginData,
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    hook.stdout.on("data", (chunk) => { stdout += String(chunk); });
    hook.stderr.on("data", (chunk) => { stderr += String(chunk); });
    hook.on("close", (code) => resolve({ code, stdout, stderr }));
    hook.stdin.end(JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      session_id: sessionId,
      turn_id: `turn-${sessionId}`,
      transcript_path: join(root, `${sessionId}.jsonl`),
      cwd: workspaceRoot(),
      prompt: "diagnostic prompt",
    }));
  });
  assert.equal(hookResult.code, 0, `${hookResult.stdout}\n${hookResult.stderr}`);
  const pluginWorkspaceState = JSON.parse(await readFile(join(pluginData, "workspaces.json"), "utf8"));
  assert.equal(pluginWorkspaceState.latest.event, "UserPromptSubmit");
  assert.equal(pluginWorkspaceState.latest.sessionId, sessionId);
  assert.equal(pluginWorkspaceState.runtime, "codex");
}

test("memorax-code uninstall removes the npm package when running from an npm package root", async () => {
  await assertMemoraxCodeNpmPackageRemoval("@memorax/memorax-code");
});

test("memorax-code uninstall does not remove the npm package when Backend stop fails", { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-uninstall-stop-fails-"));
  const home = join(root, "home");
  const memoraxCodeHome = join(home, "memorax-code-home");
  const packageRoot = join(root, "node_modules", "@memorax-code", "memorax-code");
  const fakeBin = join(root, "bin");
  const npmLog = join(root, "npm.log");
  const fakeNpm = join(fakeBin, "npm");
  let fakeBackend;
  try {
    await mkdir(join(memoraxCodeHome, "runtime", "backend"), { recursive: true });
    await writeFile(join(memoraxCodeHome, "config.toml"), "[clients]\ncodex = false\nclaude = false\n");
    await mkdir(join(packageRoot, "bin"), { recursive: true });
    await mkdir(fakeBin, { recursive: true });
    await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "@memorax/memorax-code", version: "0.1.2" }));
    await writeFile(join(packageRoot, "bin", "memorax-code.mjs"), "#!/usr/bin/env node\n");
    await writeFile(fakeNpm, `#!/bin/sh\nprintf 'npm uninstall should not run\\n' >> ${JSON.stringify(npmLog)}\n`);
    await chmod(fakeNpm, 0o755);

    fakeBackend = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], {
      stdio: "ignore",
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await writeFile(join(memoraxCodeHome, "runtime", "backend", "backend.pid.json"), `${JSON.stringify({
      pid: fakeBackend.pid,
      host: "127.0.0.1",
      port: 8787,
      url: "http://127.0.0.1:8787",
      logPath: join(memoraxCodeHome, "runtime", "backend", "backend.log"),
      startedAt: new Date().toISOString(),
    }, null, 2)}\n`);

    const uninstall = await runMemoraxCode([
      "uninstall",
      "--home",
      memoraxCodeHome,
      "--clients",
      "none",
      "--json",
    ], {
      HOME: home,
      PATH: `${fakeBin}:${process.env.PATH}`,
      MEMORAX_CODE_NPM_PACKAGE_ROOT: packageRoot,
      MEMORAX_CODE_NPM_COMMAND: "/bin/sh",
      MEMORAX_CODE_NPM_EXEC_PATH: fakeNpm,
      npm_execpath: "",
    });

    assert.equal(uninstall.code, 1, `${uninstall.stdout}\n${uninstall.stderr}`);
    const report = JSON.parse(uninstall.stdout);
    assert.equal(report.action, "uninstall");
    assert.equal(report.ok, false);
    assert.equal(report.backend.ok, false);
    assert.equal(report.npmPackageRemoval.skipped, true);
    assert.equal(report.npmPackageRemoval.reason, "lifecycle_stop_failed");
    await assert.rejects(readFile(npmLog, "utf8"), /ENOENT/);
  } finally {
    fakeBackend?.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});

test("memorax-code uninstall retains the plugin when the Codex Hook adapter cannot be disabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-uninstall-codex-disable-fails-"));
  const home = join(root, "home");
  const memoraxCodeHome = join(home, "memorax-code-home");
  const codexHome = join(home, "codex-home");
  const pluginRoot = join(codexHome, ".memorax-code", "plugins", "memorax-code-codex-adapter");
  const activeClientsPath = join(memoraxCodeHome, "runtime", "backend", "managed-clients.json");
  try {
    await mkdir(join(memoraxCodeHome, "adapters", "codex", "state.json"), { recursive: true });
    await mkdir(join(pluginRoot, ".codex-plugin"), { recursive: true });
    await mkdir(join(memoraxCodeHome, "runtime", "backend"), { recursive: true });
    await writeFile(join(pluginRoot, ".codex-plugin", "plugin.json"), '{"name":"memorax-code-codex-adapter"}\n');
    await writeFile(activeClientsPath, '{"codex":true,"claude":false}\n');

    const uninstall = await runMemoraxCode([
      "uninstall",
      "--home", memoraxCodeHome,
      "--codex-home", codexHome,
      "--clients", "codex",
      "--no-npm-uninstall",
      "--json",
    ], { HOME: home, CODEX_HOME: codexHome });

    assert.equal(uninstall.code, 1, `${uninstall.stdout}\n${uninstall.stderr}`);
    const report = JSON.parse(uninstall.stdout);
    assert.equal(report.action, "uninstall");
    assert.equal(report.ok, false);
    assert.equal(report.codexAdapter.ok, false);
    assert.equal(report.codexPlugin, undefined);
    assert.equal(report.npmPackageRemoval.reason, "lifecycle_stop_failed");
    await stat(join(pluginRoot, ".codex-plugin", "plugin.json"));
    await stat(activeClientsPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("backend removal cleanup removes the Codex plugin without touching config or Hook state", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-backend-removal-plugin-only-"));
  const home = join(root, "home");
  const codexHome = join(home, "codex-home");
  const memoraxCodeHome = join(home, "memorax-code-home");
  const fakeCodex = join(root, "missing-codex");
  const configPath = join(codexHome, "config.toml");
  const statePath = join(memoraxCodeHome, "adapters", "codex", "state.json");
  const config = "codex config sentinel\n";
  const state = `${JSON.stringify({
    version: 1,
    runtime: "codex",
    integration: "hooks",
    enabled: true,
    codexHome,
  }, null, 2)}\n`;
  try {
    await mkdir(join(codexHome, ".memorax-code", "plugins", "memorax-code-codex-adapter", ".codex-plugin"), { recursive: true });
    await mkdir(join(memoraxCodeHome, "adapters", "codex"), { recursive: true });
    await writeFile(join(codexHome, ".memorax-code", "plugins", "memorax-code-codex-adapter", ".codex-plugin", "plugin.json"), JSON.stringify({ name: "memorax-code-codex-adapter" }));
    await writeFile(configPath, config);
    await writeFile(statePath, state);

    const report = await cleanupCodexAfterBackendRemoval({
      memoraxCodeHome,
      codexHome,
      homeDir: home,
      codexCommand: fakeCodex,
    });

    assert.equal(report.ok, true);
    assert.equal(report.codexPlugin.ok, true);
    assert.equal(await readFile(configPath, "utf8"), config);
    assert.equal(await readFile(statePath, "utf8"), state);
    await assert.rejects(stat(join(codexHome, ".memorax-code", "plugins", "memorax-code-codex-adapter", ".codex-plugin", "plugin.json")), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("memorax-code uninstall asks Codex CLI to remove the activated plugin when available", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-uninstall-plugin-remove-"));
  const home = join(root, "home");
  const codexHome = join(home, "codex-home");
  const fakeCodex = join(root, "fake-codex.mjs");
  const codexLog = join(root, "codex.log");
  try {
    await mkdir(home, { recursive: true });
    await writeFile(fakeCodex, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(codexLog)}, JSON.stringify(process.argv.slice(2)) + "\\n");
`);
    await chmod(fakeCodex, 0o755);

    const install = await runMemoraxCode(["codex-plugin", "install", "--codex-home", codexHome, "--json"], {
      HOME: home,
      CODEX_HOME: codexHome,
    });
    assert.equal(install.code, 0, `${install.stdout}\n${install.stderr}`);

    const uninstall = await runMemoraxCode([
      "uninstall",
      "--home",
      join(home, "memorax-code-home"),
      "--codex-home",
      codexHome,
      "--codex-command",
      fakeCodex,
      "--json",
    ], {
      HOME: home,
      CODEX_HOME: codexHome,
    });

    assert.equal(uninstall.code, 0, `${uninstall.stdout}\n${uninstall.stderr}`);
    const report = JSON.parse(uninstall.stdout);
    assert.equal(report.codexPlugin.pluginRemove.ok, true);
    assert.match(await readFile(codexLog, "utf8"), /^\["plugin","remove","memorax-code-codex-adapter@memorax-code"\]$/m);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("codex-plugin removal stops after the Codex CLI is unavailable", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-uninstall-plugin-unavailable-"));
  const home = join(root, "home");
  const codexHome = join(home, "codex-home");
  const fakeCodex = join(root, "fake-codex.mjs");
  const codexLog = join(root, "codex.log");
  try {
    await mkdir(home, { recursive: true });
    await writeFile(fakeCodex, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(codexLog)}, JSON.stringify(process.argv.slice(2)) + "\\n");
console.error("command not found");
process.exit(127);
`);
    await chmod(fakeCodex, 0o755);

    const report = await removeCodexPlugin({
      homeDir: home,
      codexHome,
      codexCommand: fakeCodex,
      workspace: root,
    });

    assert.equal(report.pluginRemove.ok, true);
    assert.equal(report.pluginRemove.skipped, true);
    assert.equal(report.pluginRemove.reason, "codex_cli_unavailable");
    assert.deepEqual(
      (await readFile(codexLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line)),
      [["plugin", "remove", "memorax-code-codex-adapter@memorax-code"]],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("codex-plugin activate installs through Codex CLI and trusts MemoraX Code hooks", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-codex-plugin-activate-"));
  const home = join(root, "home");
  const codexHome = join(home, "codex-home");
  const workspace = join(root, "workspace");
  const fakeCodex = join(root, "fake-codex.mjs");
  try {
    await mkdir(workspace, { recursive: true });
    await mkdir(codexHome, { recursive: true });
    await writeFile(join(codexHome, "config.toml"), "[hooks.state]\n");
    await writeFile(fakeCodex, `#!/usr/bin/env node
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";

appendFileSync(${JSON.stringify(join(root, "codex-calls.log"))}, JSON.stringify(process.argv.slice(2)) + "\\n");
if (process.argv[2] === "plugin" && process.argv[3] === "marketplace" && process.argv[4] === "add") {
  console.log("Added marketplace");
  process.exit(0);
}
if (process.argv[2] === "plugin" && process.argv[3] === "add") {
  console.log("Added plugin");
  process.exit(0);
}
if (process.argv[2] !== "app-server" || process.argv[3] !== "--stdio") process.exit(2);
let hookTrusted = false;
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  appendFileSync(${JSON.stringify(join(root, "codex-rpc.log"))}, JSON.stringify(message) + "\\n");
  if (message.method === "initialize") {
    console.log(JSON.stringify({ id: message.id, result: { ok: true } }));
  } else if (message.method === "hooks/list") {
    console.log(JSON.stringify({
      id: message.id,
      result: {
        data: [{
          cwd: process.cwd(),
          hooks: [{
            pluginId: "memorax-code-codex-adapter@memorax-code",
            key: "memorax-code-codex-adapter@memorax-code:hooks/hooks.json:session_start:0:0",
            currentHash: "sha256:testhash",
            handlerType: "command",
            eventName: "sessionStart",
            command: 'node "$PLUGIN_ROOT/hooks/runtime-hook.mjs" ensure-backend',
            statusMessage: "Checking MemoraX Code backend",
            trustStatus: hookTrusted ? "trusted" : "untrusted"
          }],
          errors: [],
          warnings: []
        }]
      }
    }));
  } else if (message.method === "config/read") {
    console.log(JSON.stringify({
      id: message.id,
      result: {
        config: {},
        origins: {},
        layers: [{
          name: { type: "user", file: ${JSON.stringify(join(codexHome, "config.toml"))}, profile: null },
          version: "sha256:before",
          config: { hooks: { state: {} } }
        }]
      }
    }));
  } else if (message.method === "config/batchWrite") {
    hookTrusted = message.params.edits.some((edit) => edit.value === "sha256:testhash");
    console.log(JSON.stringify({
      id: message.id,
      result: {
        status: "ok",
        version: "sha256:after",
        filePath: ${JSON.stringify(join(codexHome, "config.toml"))},
        overriddenMetadata: null
      }
    }));
  }
});
`);
    await chmod(fakeCodex, 0o755);

    const result = await runMemoraxCode([
      "codex-plugin",
      "activate",
      "--codex-command",
      fakeCodex,
      "--workspace",
      workspace,
      "--yes",
      "--json",
    ], {
      HOME: home,
      CODEX_HOME: codexHome,
    });

    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.action, "codex-plugin-activate");
    assert.equal(report.install.registrationMode, "bootstrap");
    assert.equal(report.trustedHooks, 1);
    assert.equal(report.startsBackend, false);
    const calls = await readFile(join(root, "codex-calls.log"), "utf8");
    assert.match(calls, /"plugin","marketplace","add",.*memorax-code.*,"--json"/);
    assert.match(calls, /"plugin","add","memorax-code-codex-adapter@memorax-code","--json"/);
    const marketplace = JSON.parse(await readFile(join(codexHome, ".memorax-code", "marketplaces", "memorax-code", ".agents", "plugins", "marketplace.json"), "utf8"));
    assert.equal(marketplace.name, "memorax-code");
    assert.equal(marketplace.interface?.displayName, "MemoraX Code");
    const personalMarketplace = JSON.parse(await readFile(join(home, ".agents", "plugins", "marketplace.json"), "utf8"));
    assert.deepEqual(personalMarketplace.plugins, []);
    const rpc = (await readFile(join(root, "codex-rpc.log"), "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line));
    const batch = rpc.find((request) => request.method === "config/batchWrite");
    assert(batch);
    assert.equal(batch.params.expectedVersion, "sha256:before");
    assert.equal(batch.params.reloadUserConfig, true);
    assert.deepEqual(batch.params.edits, [
      {
        keyPath: 'hooks.state."memorax-code-codex-adapter@memorax-code:hooks/hooks.json:session_start:0:0".trusted_hash',
        value: "sha256:testhash",
        mergeStrategy: "upsert",
      },
    ]);

    const canonicalPluginRoot = join(
      codexHome,
      ".memorax-code",
      "marketplaces",
      "memorax-code",
      "plugins",
      "memorax-code-codex-adapter",
    );
    const manifest = JSON.parse(await readFile(join(canonicalPluginRoot, ".codex-plugin", "plugin.json"), "utf8"));
    const cacheRoot = join(
      codexHome,
      "plugins",
      "cache",
      "memorax-code",
      "memorax-code-codex-adapter",
      manifest.version,
    );
    await mkdir(dirname(cacheRoot), { recursive: true });
    await cp(canonicalPluginRoot, cacheRoot, { recursive: true });
    await writeFile(join(cacheRoot, "same-version-sentinel.txt"), "cache B\n");
    const previousCacheRoot = join(dirname(cacheRoot), TEST_PREVIOUS_PLUGIN_VERSION);
    await mkdir(previousCacheRoot, { recursive: true });
    await writeFile(join(previousCacheRoot, "old-version-sentinel.txt"), "cache A\n");
    await writeFile(join(
      codexHome,
      ".memorax-code",
      "marketplaces",
      "memorax-code",
      ".agents",
      "plugins",
      "marketplace.json",
    ), `${JSON.stringify({
      name: "memorax-code",
      interface: { displayName: "MemoraX Code" },
      plugins: [],
    }, null, 2)}\n`);
    await writeFile(join(home, ".agents", "plugins", "marketplace.json"), `${JSON.stringify({
      name: "personal",
      interface: { displayName: "Personal" },
      plugins: [{ name: "unrelated-plugin", custom: "preserved" }],
    }, null, 2)}\n`);

    const repeated = await runMemoraxCode([
      "codex-plugin",
      "activate",
      "--codex-command",
      fakeCodex,
      "--workspace",
      workspace,
      "--yes",
      "--json",
    ], {
      HOME: home,
      CODEX_HOME: codexHome,
    });
    assert.equal(repeated.code, 0, `${repeated.stdout}\n${repeated.stderr}`);
    const repeatedReport = JSON.parse(repeated.stdout);
    assert.equal(repeatedReport.install.registrationMode, "versioned-update");
    assert.deepEqual(repeatedReport.marketplaceAdd, {
      ok: true,
      stdout: "",
      stderr: "",
      skipped: true,
      reason: "versioned_installation_preserved",
    });
    assert.deepEqual(repeatedReport.pluginAdd, repeatedReport.marketplaceAdd);
    assert.equal(await readFile(join(cacheRoot, "same-version-sentinel.txt"), "utf8"), "cache B\n");
    assert.equal(await readFile(join(previousCacheRoot, "old-version-sentinel.txt"), "utf8"), "cache A\n");
    const repeatedCalls = (await readFile(join(root, "codex-calls.log"), "utf8"))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    assert.equal(repeatedCalls.filter((args) => (
      args[0] === "plugin" && args[1] === "marketplace" && args[2] === "add"
    )).length, 1);
    assert.equal(repeatedCalls.filter((args) => (
      args[0] === "plugin" && args[1] === "add"
    )).length, 1);
    const repeatedMarketplace = JSON.parse(await readFile(join(
      codexHome,
      ".memorax-code",
      "marketplaces",
      "memorax-code",
      ".agents",
      "plugins",
      "marketplace.json",
    ), "utf8"));
    assert.equal(repeatedMarketplace.plugins.length, 1);
    assert.equal(repeatedMarketplace.plugins[0].name, "memorax-code-codex-adapter");
    assert.equal(
      repeatedMarketplace.plugins[0].source.path,
      `./versions/${manifest.version}/plugins/memorax-code-codex-adapter`,
    );
    const repeatedPersonalMarketplace = JSON.parse(await readFile(join(
      home,
      ".agents",
      "plugins",
      "marketplace.json",
    ), "utf8"));
    assert.deepEqual(repeatedPersonalMarketplace.plugins, [{
      name: "unrelated-plugin",
      custom: "preserved",
    }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
