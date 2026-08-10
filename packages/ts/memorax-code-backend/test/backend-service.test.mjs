import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createBackendState } from "../dist/app/state.js";
import { runBackendStatus } from "../dist/lifecycle/backend/status.js";
import { createBackendServer } from "../dist/server.js";
import { renderDefaultMemoraxCodeConfig } from "../dist/config/memorax-code.js";
import { backendServiceLogs, isProcessAlive, readBackendToken, startBackendService, stopBackendService, terminateProcessTree, writeBackendToken } from "../dist/lifecycle/backend/service.js";
import { buildClaudeMarketplace } from "../../memorax-code-claude-adapter/scripts/build-marketplace.mjs";
import { fetchStreamUntil, freePort, listen, readStreamUntil } from "./helpers.mjs";
import { writeActiveManagedClients } from "../dist/lifecycle/active-clients.js";

async function prepareActiveCodexPlugin(codexHome, skillNames = ["memorax-code"]) {
  const pluginRoot = join(
    codexHome,
    "plugins",
    "cache",
    "memorax-code",
    "memorax-code-codex-adapter",
    "0.0.9",
  );
  await mkdir(join(pluginRoot, ".codex-plugin"), { recursive: true });
  await writeFile(join(pluginRoot, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "memorax-code-codex-adapter" }));
  for (const skillName of skillNames) {
    await mkdir(join(pluginRoot, "skills", skillName), { recursive: true });
    await writeFile(join(pluginRoot, "skills", skillName, "SKILL.md"), `---\nname: ${skillName}\n---\n`);
  }
}

async function prepareClaudePluginCli(home) {
  const marketplacePath = join(home, "lib", "memorax-code-claude-marketplace");
  const adapterRoot = fileURLToPath(new URL("../../memorax-code-claude-adapter", import.meta.url));
  const pluginVersion = JSON.parse(await readFile(join(adapterRoot, ".claude-plugin", "plugin.json"), "utf8")).version;
  const installedMarketplace = await buildClaudeMarketplace({
    outputDir: join(home, "fake-installed-claude-marketplace"),
  });
  const pluginInstallPath = installedMarketplace.pluginRoot;
  const claudeCommand = join(home, "fake-claude.mjs");
  const callsPath = join(home, "claude-plugin-calls.jsonl");
  await mkdir(join(marketplacePath, ".claude-plugin"), { recursive: true });
  await writeFile(join(marketplacePath, ".claude-plugin", "marketplace.json"), "{}\n");
  await mkdir(join(home, "lib", "memorax-code-claude-adapter", "skills", "memorax-code"), { recursive: true });
  await writeFile(
    join(home, "lib", "memorax-code-claude-adapter", "skills", "memorax-code", "SKILL.md"),
    "---\nname: memorax-code\n---\n",
  );
  await writeFile(claudeCommand, [
    "#!/usr/bin/env node",
    "import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    "const args = process.argv.slice(2);",
    "const settingsPath = join(process.env.CLAUDE_CONFIG_DIR, 'settings.json');",
    "const updateSettings = (update) => { if (!existsSync(settingsPath)) return; const settings = JSON.parse(readFileSync(settingsPath, 'utf8')); update(settings); writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\\n'); };",
    "appendFileSync(process.env.FAKE_CLAUDE_PLUGIN_CALLS, JSON.stringify({ args, claudeConfigDir: process.env.CLAUDE_CONFIG_DIR }) + '\\n');",
    "if (args[0] === 'plugin' && args[1] === 'uninstall' && process.env.FAKE_CLAUDE_PLUGIN_UNINSTALL_FAIL === '1') { console.error('injected plugin uninstall failure'); process.exit(1); }",
    "if (args[0] === 'plugin' && args[1] === 'uninstall') { updateSettings((settings) => { if (settings.enabledPlugins) delete settings.enabledPlugins['memorax-code-claude-adapter@memorax-code-local']; }); if (!args.includes('--keep-data')) rmSync(join(process.env.CLAUDE_CONFIG_DIR, 'plugins', 'data', 'memorax-code-claude-adapter-memorax-code-local'), { recursive: true, force: true }); }",
    "if (args.slice(0, 3).join(' ') === 'plugin marketplace remove') updateSettings((settings) => { if (settings.extraKnownMarketplaces) delete settings.extraKnownMarketplaces['memorax-code-local']; });",
    `if (args.join(' ') === 'plugin list --json') console.log(JSON.stringify([{ id: 'memorax-code-claude-adapter@memorax-code-local', enabled: true, version: ${JSON.stringify(pluginVersion)}, installPath: ${JSON.stringify(pluginInstallPath)} }]));`,
    "",
  ].join("\n"));
  await chmod(claudeCommand, 0o755);
  return { callsPath, claudeCommand, marketplacePath, pluginInstallPath };
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function writeManagedClientsConfig(home, { codex, claude }) {
  await mkdir(home, { recursive: true });
  await writeFile(join(home, "config.toml"), [
    "[clients]",
    `codex = ${codex}`,
    `claude = ${claude}`,
    "",
  ].join("\n"));
}

async function prepareUnverifiedLifecycleState(activeClients) {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-lifecycle-unverified-home-"));
  const codexHome = await mkdtemp(join(tmpdir(), "memorax-code-lifecycle-unverified-codex-"));
  const claudeHome = await mkdtemp(join(tmpdir(), "memorax-code-lifecycle-unverified-claude-"));
  const unrelated = createServer((_, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      ok: true,
      service: "unrelated-service",
      instanceId: "unrelated-instance",
      state: { sessionHome: home },
    }));
  });
  const backendUrl = await listen(unrelated);
  const port = Number(new URL(backendUrl).port);
  const runtimeDir = join(home, "runtime", "backend");
  const codexStatePath = join(home, "adapters", "codex", "state.json");
  const claudeStatePath = join(home, "adapters", "claude-code", "state.json");
  const activeClientsPath = join(runtimeDir, "managed-clients.json");
  const pidPath = join(runtimeDir, "backend.pid.json");
  const codexState = `${JSON.stringify({
    version: 1,
    runtime: "codex",
    integration: "hooks",
    enabled: activeClients.codex,
    codexHome,
    backendUrl,
  }, null, 2)}\n`;
  const claudeState = `${JSON.stringify({
    version: 1,
    runtime: "claude-code",
    integration: "hooks",
    enabled: activeClients.claude,
    claudeHome,
    backendUrl,
  }, null, 2)}\n`;
  const activeState = `${JSON.stringify(activeClients)}\n`;
  const pidState = `${JSON.stringify({
    version: 1,
    pid: process.pid,
    instanceId: "expected-instance",
    host: "127.0.0.1",
    port,
    url: backendUrl,
    logPath: join(runtimeDir, "backend.log"),
    startedAt: "2026-07-29T00:00:00.000Z",
  })}\n`;
  await prepareActiveCodexPlugin(codexHome);
  await mkdir(join(home, "adapters", "codex"), { recursive: true });
  await mkdir(join(home, "adapters", "claude-code"), { recursive: true });
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(codexStatePath, codexState);
  await writeFile(claudeStatePath, claudeState);
  await writeFile(activeClientsPath, activeState);
  await writeFile(pidPath, pidState);
  return {
    home,
    codexHome,
    claudeHome,
    unrelated,
    port,
    paths: {
      codexStatePath,
      claudeStatePath,
      activeClientsPath,
      pidPath,
    },
    contents: {
      codexState,
      claudeState,
      activeState,
      pidState,
    },
  };
}

test("memorax-code status reports needs attention when Codex adapter is not enabled", async () => {
  const sessionHome = await mkdtemp(join(tmpdir(), "memorax-code-status-adapter-home-"));
  const codexHome = await mkdtemp(join(tmpdir(), "memorax-code-status-adapter-codex-"));
  await writeFile(join(codexHome, "config.toml"), [
    'model_provider = "custom"',
    'model = "gpt-5.5"',
    "",
    "[model_providers.custom]",
    'name = "Custom"',
    'base_url = "http://127.0.0.1:9999/openai"',
    'wire_api = "responses"',
    "",
  ].join("\n"));
  const server = createBackendServer(createBackendState("127.0.0.1", {
    sessionHome,
  }));
  const backendUrl = await listen(server);
  try {
    const cliPath = fileURLToPath(new URL("../dist/memorax-code.js", import.meta.url));
    const result = await runCli(cliPath, ["status", "--backend-url", backendUrl, "--home", sessionHome, "--codex-home", codexHome, "--clients", "codex"]);
    assert.equal(result.code, 1);
    assert.match(result.stdout, /^\[MemoraX Code Backend\]: MemoraX Code Backend status: .*Unavailable/m);
    assert.match(result.stdout, /^\[MemoraX Code Backend\]: Backend status: .*Enabled/m);
    assert.match(result.stdout, /^\[MemoraX Code Backend\]: Codex adapter: not enabled/m);
    assert.match(result.stdout, /Run `memorax-code start`, restart or refresh Codex/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Backend status exposes minimal state and the CLI prints a concise summary", async () => {
  const sessionHome = await mkdtemp(join(tmpdir(), "memorax-code-status-human-home-"));
  await writeFile(join(sessionHome, "index.json"), JSON.stringify({
    schema_version: "session-index.v1",
    sessions: [{ id: "unrelated_session" }],
    branches: [{ id: "unrelated_branch" }],
  }, null, 2));
  const server = createBackendServer(createBackendState("127.0.0.1", {
    sessionHome,
  }));
  const backendUrl = await listen(server);
  try {
    const status = await runBackendStatus(backendUrl);
    assert.equal(status.ok, true);
    assert.equal(status.service, "memorax-code-backend");
    assert.equal(status.state?.sessionHome, sessionHome);
    assert.deepEqual(Object.keys(status.state ?? {}).sort(), ["sessionHome"]);

    const cliPath = fileURLToPath(new URL("../dist/memorax-code.js", import.meta.url));
    const result = await runCli(cliPath, [
      "status",
      "--backend-url", backendUrl,
      "--home", sessionHome,
      "--clients", "none",
    ]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /^\[MemoraX Code Backend\]: MemoraX Code Backend status: .*Enabled/m);
    assert.match(result.stdout, /^\[MemoraX Code Backend\]: Backend status: .*Enabled/m);
    assert.doesNotMatch(result.stdout, /^\[MemoraX Code Backend\]: Provider:/m);
    assert.match(result.stdout, /sessions with the stable plugin shell use the active Hook runtime on their next user prompt/i);
    assert.match(result.stdout, /Restart or refresh a client only if its plugin shell was installed, changed, or newly enabled/);
    assert.doesNotMatch(result.stdout, /^\{/m);
    assert.doesNotMatch(result.stdout, /Runtime index:/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("memorax-code lifecycle rejects an invalid connection authority without blocking stop", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-stop-invalid-connection-home-"));
  const authorityDir = join(home, "runtime", "backend");
  const activeClientsPath = join(authorityDir, "managed-clients.json");
  const cliPath = fileURLToPath(new URL("../dist/memorax-code.js", import.meta.url));
  try {
    await mkdir(authorityDir, { recursive: true });
    await writeFile(join(authorityDir, "backend-connection.json"), "{not-json\n");

    const status = await runCli(cliPath, [
      "status",
      "--json",
      "--home", home,
      "--clients", "none",
    ]);
    assert.equal(status.code, 1);
    assert.equal(status.stderr, "");
    const statusReport = JSON.parse(status.stdout);
    assert.equal(statusReport.ok, false);
    assert.equal(statusReport.action, "status");
    assert.equal(statusReport.backend.errorCode, "BACKEND_CONNECTION_AUTHORITY_INVALID");
    assert.match(statusReport.backend.error, /Backend connection authority is invalid/);

    const start = await runCli(cliPath, [
      "start",
      "--json",
      "--home", home,
      "--clients", "none",
    ]);
    assert.equal(start.code, 1, start.stderr);
    const startReport = JSON.parse(start.stdout);
    assert.equal(startReport.ok, false);
    assert.match(startReport.backend.error, /Backend connection authority is invalid/);
    assert.equal(startReport.backend.errorCode, "BACKEND_CONNECTION_AUTHORITY_INVALID");
    assert.equal(await pathExists(activeClientsPath), false);

    const humanStart = await runCli(cliPath, [
      "start",
      "--home", home,
      "--clients", "none",
    ]);
    assert.equal(humanStart.code, 1);
    assert.match(humanStart.stdout, /code=BACKEND_CONNECTION_AUTHORITY_INVALID/);

    const stop = await runCli(cliPath, [
      "stop",
      "--json",
      "--home", home,
      "--clients", "none",
    ]);

    assert.equal(stop.code, 0, stop.stderr);
    const report = JSON.parse(stop.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.action, "stop");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("memorax-code lifecycle reports invalid service state before lifecycle mutation", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-invalid-service-state-home-"));
  const runtimeDir = join(home, "runtime", "backend");
  const pidPath = join(runtimeDir, "backend.pid.json");
  const activeClientsPath = join(runtimeDir, "managed-clients.json");
  const cliPath = fileURLToPath(new URL("../dist/memorax-code.js", import.meta.url));
  try {
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(pidPath, "{not-json\n");

    for (const command of ["status", "start", "stop", "restart"]) {
      const result = await runCli(cliPath, [
        command,
        "--json",
        "--home", home,
        "--clients", "none",
      ]);
      assert.equal(result.code, 1, `${command}: ${result.stdout}\n${result.stderr}`);
      assert.equal(result.stderr, "");
      const report = JSON.parse(result.stdout);
      assert.equal(report.ok, false);
      assert.equal(report.action, command);
      assert.equal(report.backend.errorCode, "BACKEND_SERVICE_STATE_INVALID");
      assert.match(report.backend.error, /Backend service state is invalid/);
      assert.equal(await readFile(pidPath, "utf8"), "{not-json\n");
      assert.equal(await pathExists(activeClientsPath), false);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Backend stop refusal leaves lifecycle adapters and active clients unchanged", {
  timeout: 90_000,
}, async (t) => {
  const cliPath = fileURLToPath(new URL("../dist/memorax-code.js", import.meta.url));
  const cases = [
    {
      name: "unqualified full stop",
      command: "stop",
      activeClients: { codex: true, claude: true },
      clientSelection: undefined,
    },
    {
      name: "start with a deselected client",
      command: "start",
      activeClients: { codex: true, claude: true },
      clientSelection: "codex",
    },
    {
      name: "restart with a partial client selection",
      command: "restart",
      activeClients: { codex: true, claude: true },
      clientSelection: "codex",
    },
    {
      name: "partial stop that exhausts the active client set",
      command: "stop",
      activeClients: { codex: true, claude: false },
      clientSelection: "codex",
    },
  ];
  for (const entry of cases) {
    await t.test(entry.name, { timeout: 20_000 }, async () => {
      const fixture = await prepareUnverifiedLifecycleState(entry.activeClients);
      const {
        home,
        codexHome,
        claudeHome,
        unrelated,
        port,
        paths,
        contents,
      } = fixture;
      try {
        const result = await runCli(cliPath, [
          entry.command,
          "--json",
          "--home", home,
          "--host", "127.0.0.1",
          "--port", String(port),
          "--codex-home", codexHome,
          "--claude-home", claudeHome,
          ...(entry.clientSelection ? ["--clients", entry.clientSelection] : []),
        ]);

        assert.equal(result.code, 1, `${result.stdout}\n${result.stderr}`);
        assert.equal(result.stderr, "");
        const report = JSON.parse(result.stdout);
        assert.equal(report.ok, false);
        assert.equal(report.action, entry.command);
        assert.match(
          report.backend.error,
          process.platform === "win32"
            ? /refusing to force-stop process/
            : /refusing to stop unverified process/,
        );
        assert.equal(Object.hasOwn(report, "codexAdapter"), false);
        assert.equal(Object.hasOwn(report, "claudeAdapter"), false);
        assert.equal(await readFile(paths.codexStatePath, "utf8"), contents.codexState);
        assert.equal(await readFile(paths.claudeStatePath, "utf8"), contents.claudeState);
        assert.equal(await readFile(paths.activeClientsPath, "utf8"), contents.activeState);
        assert.equal(await readFile(paths.pidPath, "utf8"), contents.pidState);
      } finally {
        await new Promise((resolve) => unrelated.close(resolve));
        await rm(home, { recursive: true, force: true });
        await rm(codexHome, { recursive: true, force: true });
        await rm(claudeHome, { recursive: true, force: true });
      }
    });
  }
});

test("memorax-code token reports invalid token state without a stack trace", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-invalid-token-state-home-"));
  const runtimeDir = join(home, "runtime", "backend");
  const cliPath = fileURLToPath(new URL("../dist/memorax-code.js", import.meta.url));
  try {
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(join(runtimeDir, "backend-token.json"), "{not-json\n");
    const result = await runCli(cliPath, ["token", "--show", "--home", home]);
    assert.equal(result.code, 1);
    assert.equal(result.stderr, "");
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, false);
    assert.equal(report.action, "token");
    assert.equal(report.errorCode, "BACKEND_TOKEN_RECORD_INVALID");
    assert.match(report.error, /Backend token record is invalid/);

    const repaired = await runCli(cliPath, ["token", "--rotate", "--home", home]);
    assert.equal(repaired.code, 0, repaired.stderr);
    const repairedRecord = JSON.parse(
      await readFile(join(runtimeDir, "backend-token.json"), "utf8"),
    );
    assert.equal(repairedRecord.version, 1);
    assert.equal(typeof repairedRecord.token, "string");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("memorax-code start rejects an unpersistable explicit token before stopping the current Backend", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-explicit-token-preflight-home-"));
  const port = await freePort();
  const runtimeDir = join(home, "runtime", "backend");
  const pidPath = join(runtimeDir, "backend.pid.json");
  const tokenPath = join(runtimeDir, "backend-token.json");
  const cliPath = fileURLToPath(new URL("../dist/memorax-code.js", import.meta.url));
  try {
    const started = await runCli(cliPath, [
      "start",
      "--json",
      "--home", home,
      "--port", String(port),
      "--clients", "none",
    ], { env: { MEMORAX_CODE_BACKEND_TOKEN: "", MEMORAX_CODE_BACKEND_LOOPBACK_AUTH: "0" } });
    assert.equal(started.code, 0, `${started.stdout}\n${started.stderr}`);
    const stateBefore = JSON.parse(await readFile(pidPath, "utf8"));
    assert.equal(isProcessAlive(stateBefore.pid), true);
    await writeFile(tokenPath, "{not-json\n", { mode: 0o600 });

    for (const [name, extraArgs, env] of [
      ["environment token", [], { MEMORAX_CODE_BACKEND_TOKEN: "explicit-token" }],
      ["command-line token", ["--backend-token", "explicit-token"], { MEMORAX_CODE_BACKEND_TOKEN: "" }],
    ]) {
      await t.test(name, async () => {
        const attempted = await runCli(cliPath, [
          "start",
          "--json",
          "--home", home,
          "--port", String(port),
          "--clients", "none",
          ...extraArgs,
        ], { env });
        assert.equal(attempted.code, 1, attempted.stderr);
        const report = JSON.parse(attempted.stdout);
        assert.equal(report.backend.errorCode, "BACKEND_TOKEN_RECORD_INVALID");
        assert.deepEqual(JSON.parse(await readFile(pidPath, "utf8")), stateBefore);
        assert.equal(isProcessAlive(stateBefore.pid), true);
      });
    }
  } finally {
    await runCli(cliPath, ["stop", "--json", "--home", home, "--clients", "none"]);
    await rm(home, { recursive: true, force: true });
  }
});

test("memorax-code restart validates connection authority before stopping a healthy Backend", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-restart-invalid-connection-home-"));
  const port = await freePort();
  const runtimeDir = join(home, "runtime", "backend");
  const pidPath = join(runtimeDir, "backend.pid.json");
  const authorityPath = join(runtimeDir, "backend-connection.json");
  const cliPath = fileURLToPath(new URL("../dist/memorax-code.js", import.meta.url));
  try {
    const started = await runCli(cliPath, [
      "start",
      "--json",
      "--home", home,
      "--port", String(port),
      "--clients", "none",
    ]);
    assert.equal(started.code, 0, `${started.stdout}\n${started.stderr}`);
    const stateBefore = JSON.parse(await readFile(pidPath, "utf8"));
    assert.equal(isProcessAlive(stateBefore.pid), true);

    await writeFile(authorityPath, "{not-json\n");
    const restarted = await runCli(cliPath, [
      "restart",
      "--json",
      "--home", home,
      "--clients", "none",
    ]);

    assert.equal(restarted.code, 1, restarted.stderr);
    const report = JSON.parse(restarted.stdout);
    assert.equal(report.ok, false);
    assert.equal(report.action, "restart");
    assert.equal(report.backend.errorCode, "BACKEND_CONNECTION_AUTHORITY_INVALID");
    assert.deepEqual(JSON.parse(await readFile(pidPath, "utf8")), stateBefore);
    assert.equal(isProcessAlive(stateBefore.pid), true);
  } finally {
    await runCli(cliPath, ["stop", "--json", "--home", home, "--clients", "none"]);
    await rm(home, { recursive: true, force: true });
  }
});

test("memorax-code status treats Codex-only ready state as enabled when Claude is not configured", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-status-codex-only-home-"));
  const codexHome = await mkdtemp(join(tmpdir(), "memorax-code-status-codex-only-codex-"));
  const port = await freePort();
  const cliPath = fileURLToPath(new URL("../dist/memorax-code.js", import.meta.url));
  await writeFile(join(codexHome, "config.toml"), [
    'model_provider = "custom"',
    'model = "gpt-5.5"',
    "",
    "[model_providers.custom]",
    'name = "Custom"',
    'base_url = "http://127.0.0.1:9999/openai"',
    'wire_api = "responses"',
    "",
  ].join("\n"));
  await prepareActiveCodexPlugin(codexHome);
  try {
    const started = await runCli(cliPath, [
      "start", "--json",
      "--home", home,
      "--port", String(port),
      "--codex-home", codexHome,
      "--clients", "codex",
    ]);
    assert.equal(started.code, 0, `${started.stdout}\n${started.stderr}`);
    const status = await runCli(cliPath, [
      "status",
      "--home", home,
      "--port", String(port),
      "--codex-home", codexHome,
      "--clients", "codex",
    ]);
    assert.equal(status.code, 0, `${status.stdout}\n${status.stderr}`);
    assert.match(status.stdout, /^\[MemoraX Code Backend\]: MemoraX Code Backend status: .*Enabled/m);
    assert.match(status.stdout, /^\[MemoraX Code Backend\]: Codex adapter: ok integration=hooks skills=plugin-managed/m);
    assert.doesNotMatch(status.stdout, /^\[MemoraX Code Backend\]: Claude adapter:/m);
    assert.doesNotMatch(status.stdout, /Claude adapter is not enabled/);
    assert.doesNotMatch(status.stdout, /Run `memorax-code start`, then restart or refresh Claude Code/);
  } finally {
    await runCli(cliPath, ["stop", "--json", "--home", home, "--port", String(port), "--codex-home", codexHome, "--clients", "codex"]);
    await rm(home, { recursive: true, force: true });
    await rm(codexHome, { recursive: true, force: true });
  }
});

test("persisted clients none keeps lifecycle commands adapter-free", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-clients-none-home-"));
  const codexHome = await mkdtemp(join(tmpdir(), "memorax-code-clients-none-codex-"));
  const claudeHome = await mkdtemp(join(tmpdir(), "memorax-code-clients-none-claude-"));
  const port = await freePort();
  const cliPath = fileURLToPath(new URL("../dist/memorax-code.js", import.meta.url));
  const claudeCli = await prepareClaudePluginCli(home);
  const originalCodexConfig = "codex sentinel\n";
  const originalClaudeSettings = "{\"sentinel\":true}\n";
  await writeFile(join(home, "config.toml"), [
    "[clients]",
    "codex = false",
    "claude = false",
    "",
    "[model]",
    'base_url = "http://127.0.0.1:9999"',
    'api_key = "local-test-key"',
    "",
  ].join("\n"));
  await writeFile(join(codexHome, "config.toml"), originalCodexConfig);
  await writeFile(join(claudeHome, "settings.json"), originalClaudeSettings);
  const env = {
    CLAUDE_CONFIG_DIR: claudeHome,
    FAKE_CLAUDE_PLUGIN_CALLS: claudeCli.callsPath,
    MEMORAX_CODE_CLAUDE_COMMAND: claudeCli.claudeCommand,
  };
  const commonArgs = ["--home", home, "--port", String(port), "--codex-home", codexHome, "--claude-home", claudeHome];
  try {
    for (const action of ["start", "status", "stop", "uninstall"]) {
      const result = await runCli(cliPath, [
        action,
        "--json",
        ...commonArgs,
        ...(action === "uninstall" ? ["--no-npm-uninstall"] : []),
      ], { env });
      assert.equal(result.code, 0, `${action}: ${result.stdout}\n${result.stderr}`);
      const report = JSON.parse(result.stdout);
      assert.equal(Object.hasOwn(report, "codexAdapter"), false);
      assert.equal(Object.hasOwn(report, "claudeAdapter"), false);
      assert.equal(Object.hasOwn(report, "codexPlugin"), false);
      assert.equal(await pathExists(claudeCli.callsPath), false, `${action} must not invoke Claude CLI`);
      assert.equal(await readFile(join(codexHome, "config.toml"), "utf8"), originalCodexConfig);
      assert.equal(await readFile(join(claudeHome, "settings.json"), "utf8"), originalClaudeSettings);
    }
  } finally {
    await runCli(cliPath, ["stop", "--json", ...commonArgs, "--clients", "none"], { env });
    await rm(home, { recursive: true, force: true });
    await rm(codexHome, { recursive: true, force: true });
    await rm(claudeHome, { recursive: true, force: true });
  }
});

test("unqualified Backend recovery preserves both configured client integrations", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-clients-shared-recovery-home-"));
  const codexHome = await mkdtemp(join(tmpdir(), "memorax-code-clients-shared-recovery-codex-"));
  const claudeHome = await mkdtemp(join(tmpdir(), "memorax-code-clients-shared-recovery-claude-"));
  const port = await freePort();
  const cliPath = fileURLToPath(new URL("../dist/memorax-code.js", import.meta.url));
  const claudeCli = await prepareClaudePluginCli(home);
  await writeManagedClientsConfig(home, { codex: true, claude: true });
  await writeFile(join(codexHome, "config.toml"), 'model_provider = "openai"\n');
  await writeFile(join(claudeHome, "settings.json"), "{}\n");
  await prepareActiveCodexPlugin(codexHome);
  const env = {
    CLAUDE_CONFIG_DIR: claudeHome,
    FAKE_CLAUDE_PLUGIN_CALLS: claudeCli.callsPath,
    MEMORAX_CODE_CLAUDE_COMMAND: claudeCli.claudeCommand,
  };
  const commonArgs = [
    "--home", home,
    "--port", String(port),
    "--codex-home", codexHome,
    "--claude-home", claudeHome,
  ];
  const activeClientsPath = join(home, "runtime", "backend", "managed-clients.json");
  try {
    const started = await runCli(cliPath, ["start", "--json", ...commonArgs], { env });
    assert.equal(started.code, 0, `${started.stdout}\n${started.stderr}`);
    const startReport = JSON.parse(started.stdout);
    assert.equal(startReport.codexAdapter.enabled, true);
    assert.equal(startReport.claudeAdapter.enabled, true);
    assert.deepEqual(JSON.parse(await readFile(activeClientsPath, "utf8")), {
      codex: true,
      claude: true,
    });

    const backendOnlyStop = await runCli(cliPath, [
      "stop", "--json", ...commonArgs, "--clients", "none",
    ], { env });
    assert.equal(backendOnlyStop.code, 0, `${backendOnlyStop.stdout}\n${backendOnlyStop.stderr}`);
    assert.equal(await pathExists(join(home, "runtime", "backend", "backend.pid.json")), false);
    assert.deepEqual(JSON.parse(await readFile(activeClientsPath, "utf8")), {
      codex: true,
      claude: true,
    });

    const recovered = await runCli(cliPath, ["start", "--json", ...commonArgs], { env });
    assert.equal(recovered.code, 0, `${recovered.stdout}\n${recovered.stderr}`);
    const recoveryReport = JSON.parse(recovered.stdout);
    assert.equal(recoveryReport.codexAdapter.enabled, true);
    assert.equal(recoveryReport.claudeAdapter.enabled, true);
    assert.deepEqual(JSON.parse(await readFile(activeClientsPath, "utf8")), {
      codex: true,
      claude: true,
    });
  } finally {
    await runCli(cliPath, ["stop", "--json", ...commonArgs, "--clients", "all"], { env });
    await rm(home, { recursive: true, force: true });
    await rm(codexHome, { recursive: true, force: true });
    await rm(claudeHome, { recursive: true, force: true });
  }
});

test("partial client stop preserves Backend until an explicit Backend-only stop", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-clients-partial-home-"));
  const codexHome = await mkdtemp(join(tmpdir(), "memorax-code-clients-partial-codex-"));
  const port = await freePort();
  const cliPath = fileURLToPath(new URL("../dist/memorax-code.js", import.meta.url));
  await writeManagedClientsConfig(home, { codex: true, claude: true });
  await writeFile(join(codexHome, "config.toml"), [
    'model_provider = "custom"',
    'model = "gpt-5.5"',
    "",
    "[model_providers.custom]",
    'name = "Custom"',
    'base_url = "http://127.0.0.1:9999/openai"',
    'wire_api = "responses"',
    "",
  ].join("\n"));
  await prepareActiveCodexPlugin(codexHome);
  const commonArgs = ["--home", home, "--port", String(port), "--codex-home", codexHome];
  try {
    const started = await runCli(cliPath, ["start", "--json", ...commonArgs, "--clients", "codex"]);
    assert.equal(started.code, 0, `${started.stdout}\n${started.stderr}`);
    await mkdir(join(home, "runtime", "backend"), { recursive: true });
    await writeFile(join(home, "runtime", "backend", "managed-clients.json"), '{"codex":true,"claude":true}\n');

    const stopped = await runCli(cliPath, ["stop", "--json", ...commonArgs, "--clients", "codex"]);
    assert.equal(stopped.code, 0, `${stopped.stdout}\n${stopped.stderr}`);
    const report = JSON.parse(stopped.stdout);
    assert.equal(report.backend.skipped, true);
    assert.equal(report.backend.reason, "active_clients_remaining");
    assert.ok(report.codexAdapter);
    assert.equal(Object.hasOwn(report, "claudeAdapter"), false);

    const status = await runCli(cliPath, ["status", "--json", ...commonArgs, "--clients", "none"]);
    assert.equal(status.code, 0, `${status.stdout}\n${status.stderr}`);
    assert.equal(JSON.parse(status.stdout).backend.ok, true);
    assert.deepEqual(JSON.parse(await readFile(join(home, "runtime", "backend", "managed-clients.json"), "utf8")), {
      codex: false,
      claude: true,
    });

    const backendOnlyStopped = await runCli(cliPath, ["stop", "--json", ...commonArgs, "--clients", "none"]);
    assert.equal(backendOnlyStopped.code, 0, `${backendOnlyStopped.stdout}\n${backendOnlyStopped.stderr}`);
    const backendOnlyReport = JSON.parse(backendOnlyStopped.stdout);
    assert.equal(backendOnlyReport.backend.skipped, undefined);
    assert.equal(await pathExists(join(home, "runtime", "backend", "backend.pid.json")), false);
    assert.deepEqual(JSON.parse(await readFile(join(home, "runtime", "backend", "managed-clients.json"), "utf8")), {
      codex: false,
      claude: true,
    });
  } finally {
    await runCli(cliPath, ["stop", "--json", ...commonArgs, "--clients", "none"]);
    await rm(home, { recursive: true, force: true });
    await rm(codexHome, { recursive: true, force: true });
  }
});

test("partial stop without an active marker does not invent remaining clients", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-clients-no-active-home-"));
  const codexHome = await mkdtemp(join(tmpdir(), "memorax-code-clients-no-active-codex-"));
  const port = await freePort();
  const cliPath = fileURLToPath(new URL("../dist/memorax-code.js", import.meta.url));
  await writeManagedClientsConfig(home, { codex: true, claude: true });
  try {
    const stopped = await runCli(cliPath, [
      "stop", "--json",
      "--home", home,
      "--port", String(port),
      "--codex-home", codexHome,
      "--clients", "codex",
    ]);
    assert.equal(stopped.code, 0, `${stopped.stdout}\n${stopped.stderr}`);
    const report = JSON.parse(stopped.stdout);
    assert.notEqual(report.backend.reason, "active_clients_remaining");
    assert.equal(await pathExists(join(home, "runtime", "backend", "managed-clients.json")), false);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(codexHome, { recursive: true, force: true });
  }
});

test("memorax-code lifecycle rejects invalid config before mutating clients or Backend", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-invalid-lifecycle-config-home-"));
  const codexHome = await mkdtemp(join(tmpdir(), "memorax-code-invalid-lifecycle-config-codex-"));
  const claudeHome = await mkdtemp(join(tmpdir(), "memorax-code-invalid-lifecycle-config-claude-"));
  const port = await freePort();
  const cliPath = fileURLToPath(new URL("../dist/memorax-code.js", import.meta.url));
  const pluginCli = await prepareClaudePluginCli(home);
  const originalCodexConfig = [
    'model_provider = "custom"',
    "",
    "[model_providers.custom]",
    'name = "Custom"',
    'base_url = "http://127.0.0.1:9999/openai"',
    'wire_api = "responses"',
    "",
  ].join("\n");
  const originalClaudeSettings = "{\"sentinel\":true}\n";
  await writeFile(join(home, "config.toml"), [
    "[clients]",
    "codex = false",
    "claude = false",
    "",
    "broken = [",
    "",
  ].join("\n"));
  await writeFile(join(codexHome, "config.toml"), originalCodexConfig);
  await writeFile(join(claudeHome, "settings.json"), originalClaudeSettings);
  await prepareActiveCodexPlugin(codexHome);
  const env = {
    CLAUDE_CONFIG_DIR: claudeHome,
    FAKE_CLAUDE_PLUGIN_CALLS: pluginCli.callsPath,
    MEMORAX_CODE_CLAUDE_COMMAND: pluginCli.claudeCommand,
  };
  const commonArgs = [
    "--home", home,
    "--port", String(port),
    "--codex-home", codexHome,
    "--claude-home", claudeHome,
  ];
  try {
    const started = await runCli(cliPath, ["start", "--json", ...commonArgs], { env });
    assert.equal(started.code, 1, `${started.stdout}\n${started.stderr}`);
    assert.match(started.stderr, /failed to parse MemoraX Code lifecycle config/);
    assert.equal(await pathExists(join(home, "runtime", "backend", "managed-clients.json")), false);
    assert.equal(await pathExists(join(home, "runtime", "backend", "backend.pid.json")), false);
    assert.equal(await readFile(join(codexHome, "config.toml"), "utf8"), originalCodexConfig);
    assert.equal(await readFile(join(claudeHome, "settings.json"), "utf8"), originalClaudeSettings);
    assert.equal(await pathExists(pluginCli.callsPath), false);
  } finally {
    await runCli(cliPath, ["stop", "--json", ...commonArgs, "--clients", "none"], { env });
    await rm(home, { recursive: true, force: true });
    await rm(codexHome, { recursive: true, force: true });
    await rm(claudeHome, { recursive: true, force: true });
  }
});

test("explicit clients none stops the managed Backend without parsing lifecycle config", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-backend-only-stop-home-"));
  const port = await freePort();
  const cliPath = fileURLToPath(new URL("../dist/memorax-code.js", import.meta.url));
  const commonArgs = ["--home", home, "--port", String(port), "--clients", "none"];
  const invalidConfig = "[clients]\ncodex = [\n";
  try {
    const started = await runCli(cliPath, ["start", "--json", ...commonArgs]);
    assert.equal(started.code, 0, `${started.stdout}\n${started.stderr}`);
    assert.equal(await pathExists(join(home, "runtime", "backend", "backend.pid.json")), true);

    await writeFile(join(home, "config.toml"), invalidConfig);
    const stopped = await runCli(cliPath, ["stop", "--json", ...commonArgs]);
    assert.equal(stopped.code, 0, `${stopped.stdout}\n${stopped.stderr}`);
    assert.equal(await pathExists(join(home, "runtime", "backend", "backend.pid.json")), false);
    assert.equal(await readFile(join(home, "config.toml"), "utf8"), invalidConfig);
  } finally {
    await runCli(cliPath, ["stop", "--json", ...commonArgs]);
    await rm(home, { recursive: true, force: true });
  }
});

test("failed Backend start preserves selected clients and direct Claude settings for unqualified cleanup", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-clients-failed-start-home-"));
  const claudeHome = await mkdtemp(join(tmpdir(), "memorax-code-clients-failed-start-claude-"));
  const cliPath = fileURLToPath(new URL("../dist/memorax-code.js", import.meta.url));
  const pluginCli = await prepareClaudePluginCli(home);
  const originalSettings = `${JSON.stringify({
    env: {
      ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
      ANTHROPIC_API_KEY: "deepseek-secret",
    },
  }, null, 2)}\n`;
  await writeManagedClientsConfig(home, { codex: true, claude: false });
  await writeFile(join(claudeHome, "settings.json"), originalSettings);
  const env = {
    CLAUDE_CONFIG_DIR: claudeHome,
    FAKE_CLAUDE_PLUGIN_CALLS: pluginCli.callsPath,
    MEMORAX_CODE_CLAUDE_COMMAND: pluginCli.claudeCommand,
  };
  const commonArgs = ["--home", home, "--host", "192.0.2.1", "--claude-home", claudeHome];
  try {
    const started = await runCli(cliPath, ["start", "--json", ...commonArgs, "--clients", "claude"], { env });
    assert.equal(started.code, 1, `${started.stdout}\n${started.stderr}`);
    assert.deepEqual(JSON.parse(await readFile(join(home, "runtime", "backend", "managed-clients.json"), "utf8")), {
      codex: false,
      claude: true,
    });
    assert.equal(await readFile(join(claudeHome, "settings.json"), "utf8"), originalSettings);

    const stopped = await runCli(cliPath, ["stop", "--json", ...commonArgs], { env });
    assert.equal(stopped.code, 0, `${stopped.stdout}\n${stopped.stderr}`);
    assert.ok(JSON.parse(stopped.stdout).claudeAdapter);
    const restoredSettings = JSON.parse(await readFile(join(claudeHome, "settings.json"), "utf8"));
    assert.equal(restoredSettings.env.ANTHROPIC_BASE_URL, "https://api.deepseek.com/anthropic");
    assert.equal(restoredSettings.env.ANTHROPIC_API_KEY, "deepseek-secret");
    assert.equal(await pathExists(join(home, "runtime", "backend", "managed-clients.json")), false);
  } finally {
    await runCli(cliPath, ["stop", "--json", ...commonArgs, "--clients", "claude"], { env });
    await rm(home, { recursive: true, force: true });
    await rm(claudeHome, { recursive: true, force: true });
  }
});

test("memorax-code lifecycle CLI prints prefixed user guidance", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-lifecycle-guidance-home-"));
  const port = await freePort();
  const cliPath = fileURLToPath(new URL("../dist/memorax-code.js", import.meta.url));
  try {
    const started = await runCli(cliPath, [
      "start",
      "--home", home,
      "--port", String(port),
      "--clients", "none",
    ]);
    assert.equal(started.code, 0, `${started.stdout}\n${started.stderr}`);
    assert.match(started.stdout, /^\[MemoraX Code Backend\]: Start: .*ok/m);
    assert.match(started.stdout, /^\[MemoraX Code Backend\]: Backend: .*ok.*127\.0\.0\.1/m);
    assert.match(started.stdout, /^\[MemoraX Code Backend\]: .*Backend is running/m);
    assert.match(started.stdout, /^\[MemoraX Code Backend\]: Adapters were not changed for this command\./m);

    const stopped = await runCli(cliPath, [
      "stop",
      "--home", home,
      "--port", String(port),
      "--clients", "none",
    ]);
    assert.equal(stopped.code, 0, `${stopped.stdout}\n${stopped.stderr}`);
    assert.match(stopped.stdout, /^\[MemoraX Code Backend\]: Stop: .*ok/m);
    assert.match(stopped.stdout, /^\[MemoraX Code Backend\]: Backend: .*stopped/m);
    assert.match(stopped.stdout, /^\[MemoraX Code Backend\]: .*Backend is stopped\./m);

    const uninstalled = await runCli(cliPath, [
      "uninstall",
      "--home", home,
      "--port", String(port),
      "--clients", "none",
      "--no-npm-uninstall",
    ]);
    assert.equal(uninstalled.code, 0, `${uninstalled.stdout}\n${uninstalled.stderr}`);
    assert.match(uninstalled.stdout, /^\[MemoraX Code Backend\]: Uninstall: .*ok/m);
    assert.match(uninstalled.stdout, /^\[MemoraX Code Backend\]: Backend: .*stopped/m);
    assert.match(uninstalled.stdout, /^\[MemoraX Code Backend\]: npm package: skipped partial_client_uninstall/m);
    assert.doesNotMatch(uninstalled.stdout, /MemoraX Code has been uninstalled/);
    assert.doesNotMatch(uninstalled.stdout, /Restart or refresh (?:Codex|Claude Code)/);
  } finally {
    await runCli(cliPath, ["stop", "--json", "--home", home, "--port", String(port), "--clients", "none"]);
    await rm(home, { recursive: true, force: true });
  }
});

test("memorax-code uninstall guidance names only the selected Claude client", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-uninstall-guidance-home-"));
  const codexHome = await mkdtemp(join(tmpdir(), "memorax-code-uninstall-guidance-codex-"));
  const claudeHome = await mkdtemp(join(tmpdir(), "memorax-code-uninstall-guidance-claude-"));
  const port = await freePort();
  const cliPath = fileURLToPath(new URL("../dist/memorax-code.js", import.meta.url));
  const pluginCli = await prepareClaudePluginCli(home);
  await writeManagedClientsConfig(home, { codex: true, claude: true });
  await writeFile(join(codexHome, "config.toml"), 'model_provider = "openai"\n');
  await writeFile(join(claudeHome, "settings.json"), "{}\n");
  await prepareActiveCodexPlugin(codexHome);
  const env = {
    CLAUDE_CONFIG_DIR: claudeHome,
    FAKE_CLAUDE_PLUGIN_CALLS: pluginCli.callsPath,
    MEMORAX_CODE_CLAUDE_COMMAND: pluginCli.claudeCommand,
  };
  const commonArgs = [
    "--home", home,
    "--port", String(port),
    "--codex-home", codexHome,
    "--claude-home", claudeHome,
  ];
  try {
    const started = await runCli(cliPath, ["start", "--json", ...commonArgs], { env });
    assert.equal(started.code, 0, `${started.stdout}\n${started.stderr}`);

    const uninstalled = await runCli(cliPath, [
      "uninstall",
      ...commonArgs,
      "--clients", "claude",
      "--no-npm-uninstall",
    ], { env });
    assert.equal(uninstalled.code, 0, `${uninstalled.stdout}\n${uninstalled.stderr}`);
    assert.match(uninstalled.stdout, /^\[MemoraX Code Backend\]: Backend: .*kept running.*127\.0\.0\.1/m);
    assert.match(uninstalled.stdout, /^\[MemoraX Code Backend\]: npm package: skipped partial_client_uninstall/m);
    assert.match(uninstalled.stdout, /MemoraX Code has been uninstalled from Claude Code\./);
    assert.match(uninstalled.stdout, /Restart or refresh Claude Code so it drops the removed adapter plugin\./);
    assert.doesNotMatch(uninstalled.stdout, /uninstalled from this npm installation/);
    assert.doesNotMatch(uninstalled.stdout, /Restart or refresh Codex/);

    const stopped = await runCli(cliPath, ["stop", ...commonArgs, "--clients", "codex"], { env });
    assert.equal(stopped.code, 0, `${stopped.stdout}\n${stopped.stderr}`);
    assert.match(stopped.stdout, /^\[MemoraX Code Backend\]: Backend: .*stopped.*127\.0\.0\.1/m);
  } finally {
    await runCli(cliPath, ["stop", "--json", ...commonArgs, "--clients", "none"], { env });
    await rm(home, { recursive: true, force: true });
    await rm(codexHome, { recursive: true, force: true });
    await rm(claudeHome, { recursive: true, force: true });
  }
});

test("memorax-code-backend rejects management commands", async () => {
  const cliPath = fileURLToPath(new URL("../dist/server.js", import.meta.url));
  for (const command of [
    "start",
    "token",
    "uninstall",
    "codex-plugin",
    "enable",
    "disable",
    "install",
  ]) {
    const result = await runCli(cliPath, [command]);
    assert.equal(result.code, 1, command);
    assert.match(result.stderr, new RegExp(`memorax-code-backend: unknown command '${command}'`));
  }
});

test("memorax-code start and stop preserve custom Codex provider config on the Hook lifecycle", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-lifecycle-home-"));
  const codexHome = await mkdtemp(join(tmpdir(), "memorax-code-lifecycle-codex-"));
  const port = await freePort();
  const cliPath = fileURLToPath(new URL("../dist/memorax-code.js", import.meta.url));
  const originalBaseUrl = "http://127.0.0.1:9999/openai";
  const originalConfig = [
    'model_provider = "custom"',
    'model = "gpt-5.5"',
    "",
    "[model_providers.custom]",
    'name = "Custom"',
    `base_url = "${originalBaseUrl}"`,
    'wire_api = "responses"',
    "",
  ].join("\n");
  await writeFile(join(codexHome, "config.toml"), originalConfig);
  await prepareActiveCodexPlugin(codexHome);
  try {
    const started = await runCli(cliPath, [
      "start", "--json",
      "--home", home,
      "--port", String(port),
      "--codex-home", codexHome,
      "--clients", "codex",
    ]);
    assert.equal(started.code, 0, `${started.stdout}\n${started.stderr}`);
    const startReport = JSON.parse(started.stdout);
    assert.equal(startReport.ok, true);
    assert.equal(startReport.backend.ok, true);
    assert.equal(startReport.codexAdapter.ok, true);
    assert.equal(startReport.codexAdapter.installed, true);
    assert.equal(startReport.codexAdapter.enabled, true);
    assert.equal(startReport.codexAdapter.integration, "hooks");
    assert.equal(await readFile(join(codexHome, "config.toml"), "utf8"), originalConfig);

    const updated = await runCli(cliPath, [
      "start", "--json",
      "--home", home,
      "--port", String(port),
      "--codex-home", codexHome,
      "--clients", "codex",
    ]);
    assert.equal(updated.code, 0, `${updated.stdout}\n${updated.stderr}`);
    const updateReport = JSON.parse(updated.stdout);
    assert.equal(updateReport.codexAdapter.ok, true);
    assert.equal(updateReport.backend.ok, true);
    const updatedState = JSON.parse(await readFile(join(home, "adapters", "codex", "state.json"), "utf8"));
    assert.equal(updatedState.integration, "hooks");
    assert.equal(updatedState.enabled, true);

    const status = await runCli(cliPath, [
      "status", "--json",
      "--home", home,
      "--port", String(port),
      "--codex-home", codexHome,
      "--clients", "codex",
    ]);
    assert.equal(status.code, 0, `${status.stdout}\n${status.stderr}`);

    const stopped = await runCli(cliPath, [
      "stop", "--json",
      "--home", home,
      "--port", String(port),
      "--codex-home", codexHome,
      "--clients", "codex",
    ]);
    assert.equal(stopped.code, 0, `${stopped.stdout}\n${stopped.stderr}`);
    const stopReport = JSON.parse(stopped.stdout);
    assert.equal(stopReport.ok, true);
    assert.equal(stopReport.backend.ok, true);
    assert.equal(stopReport.codexAdapter.ok, true);
    assert.equal(await readFile(join(codexHome, "config.toml"), "utf8"), originalConfig);
    const stoppedState = JSON.parse(await readFile(join(home, "adapters", "codex", "state.json"), "utf8"));
    assert.equal(stoppedState.integration, "hooks");
    assert.equal(stoppedState.enabled, false);
  } finally {
    await runCli(cliPath, ["stop", "--json", "--home", home, "--port", String(port), "--codex-home", codexHome, "--clients", "codex"]);
  }
});

test("failed Backend start leaves Codex config unchanged", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-lifecycle-transaction-failure-home-"));
  const codexHome = await mkdtemp(join(tmpdir(), "memorax-code-lifecycle-transaction-failure-codex-"));
  const cliPath = fileURLToPath(new URL("../dist/memorax-code.js", import.meta.url));
  const originalConfig = [
    'model_provider = "custom"',
    "",
    "[model_providers.custom]",
    'base_url = "http://127.0.0.1:9999/v1"',
    'wire_api = "responses"',
    "",
  ].join("\n");
  await writeFile(join(codexHome, "config.toml"), originalConfig);
  await prepareActiveCodexPlugin(codexHome);
  try {
    const started = await runCli(cliPath, [
      "start", "--json",
      "--home", home,
      "--host", "192.0.2.1",
      "--codex-home", codexHome,
      "--clients", "codex",
    ]);

    assert.equal(started.code, 1, `${started.stdout}\n${started.stderr}`);
    assert.equal(await readFile(join(codexHome, "config.toml"), "utf8"), originalConfig);
    const state = JSON.parse(await readFile(join(home, "adapters", "codex", "state.json"), "utf8"));
    assert.equal(state.integration, "hooks");
    assert.equal(state.enabled, false);
  } finally {
    await runCli(cliPath, [
      "stop", "--json",
      "--home", home,
      "--host", "192.0.2.1",
      "--codex-home", codexHome,
      "--clients", "codex",
    ]);
    await rm(home, { recursive: true, force: true });
    await rm(codexHome, { recursive: true, force: true });
  }
});

test("start recovers the Backend when Codex preparation fails after shutdown", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-start-recovery-home-"));
  const codexHome = await mkdtemp(join(tmpdir(), "memorax-code-start-recovery-codex-"));
  const port = await freePort();
  const cliPath = fileURLToPath(new URL("../dist/memorax-code.js", import.meta.url));
  const codexStatePath = join(home, "adapters", "codex", "state.json");
  const observedPids = new Set();
  const commonArgs = [
    "--home", home,
    "--port", String(port),
    "--codex-home", codexHome,
  ];
  await prepareActiveCodexPlugin(codexHome);
  try {
    const initial = await runCli(cliPath, [
      "start", "--json", ...commonArgs, "--clients", "codex",
    ]);
    assert.equal(initial.code, 0, `${initial.stdout}\n${initial.stderr}`);
    observedPids.add(JSON.parse(initial.stdout).backend.state.pid);

    await rm(codexStatePath, { force: true });
    await mkdir(codexStatePath);
    const failed = await runCli(cliPath, [
      "start", "--json", ...commonArgs, "--clients", "codex",
    ]);

    assert.equal(failed.code, 1, `${failed.stdout}\n${failed.stderr}`);
    assert.equal(failed.stderr, "");
    const report = JSON.parse(failed.stdout);
    assert.equal(report.ok, false);
    assert.equal(report.codexAdapter.ok, false);
    assert.equal(report.codexAdapter.reason, "state_unreadable");
    assert.equal(report.backend.ok, true, report.backend.error);
    assert.equal(
      report.backend.reason,
      "codex_adapter_enable_failed_backend_recovered",
    );
    observedPids.add(report.backend.state.pid);
    const health = await fetch(`http://127.0.0.1:${port}/health`).then(
      (response) => response.json(),
    );
    assert.equal(health.ok, true);
    assert.equal(health.instanceId, report.backend.state.instanceId);
  } finally {
    await rm(codexStatePath, { recursive: true, force: true });
    await runCli(cliPath, ["stop", "--json", ...commonArgs, "--clients", "none"]);
    for (const pid of observedPids) {
      if (!Number.isSafeInteger(pid) || !isProcessAlive(pid)) continue;
      terminateProcessTree(pid);
      await waitForProcessExit(pid);
    }
    await rm(home, { recursive: true, force: true });
    await rm(codexHome, { recursive: true, force: true });
  }
});

test("memorax-code start preserves custom Claude provider settings while enabling Hooks", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-lifecycle-claude-home-"));
  const claudeHome = await mkdtemp(join(tmpdir(), "memorax-code-lifecycle-claude-config-"));
  const ignoredClaudeHome = await mkdtemp(join(tmpdir(), "memorax-code-lifecycle-claude-ignored-config-"));
  const workspace = join(home, "workspace", "Claude-Repo");
  const port = await freePort();
  const cliPath = fileURLToPath(new URL("../dist/memorax-code.js", import.meta.url));
  const pluginCli = await prepareClaudePluginCli(home);
  const originalSettings = `${JSON.stringify({
    env: {
      ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
      ANTHROPIC_AUTH_TOKEN: "deepseek-secret",
      ANTHROPIC_MODEL: "deepseek-v4-pro",
    },
  }, null, 2)}\n`;
  await Promise.all([
    mkdir(join(workspace, ".git"), { recursive: true }),
    mkdir(join(claudeHome, "projects", "encoded-project"), { recursive: true }),
  ]);
  await writeFile(join(claudeHome, "projects", "encoded-project", "lifecycle-session.jsonl"), `${JSON.stringify({
    type: "user",
    userType: "external",
    sessionId: "lifecycle-session",
    uuid: "lifecycle-user-record",
    promptId: "lifecycle-turn",
    cwd: workspace,
    timestamp: new Date().toISOString(),
    message: { role: "user", content: "private lifecycle Claude prompt" },
  })}\n`, "utf8");
  await writeFile(join(claudeHome, "settings.json"), originalSettings);
  const env = {
    CLAUDE_CONFIG_DIR: ignoredClaudeHome,
    FAKE_CLAUDE_PLUGIN_CALLS: pluginCli.callsPath,
    MEMORAX_CODE_CLAUDE_COMMAND: pluginCli.claudeCommand,
    ANTHROPIC_BASE_URL: "",
  };
  try {
    const started = await runCli(cliPath, [
      "start", "--json",
      "--home", home,
      "--port", String(port),
      "--claude-home", claudeHome,
      "--clients", "claude",
    ], { env });
    assert.equal(started.code, 0, `${started.stdout}\n${started.stderr}`);
    const startReport = JSON.parse(started.stdout);
    assert.equal(startReport.ok, true);
    assert.equal(startReport.backend.ok, true);
    assert.equal(startReport.claudeAdapter.ok, true);
    assert.equal(startReport.claudeAdapter.integration, "hooks");
    assert.equal(startReport.claudeAdapter.claudeSkills.status, "plugin-managed");
    assert.equal(startReport.claudeAdapter.claudeSkills.delivery, "plugin");
    assert.equal(await readFile(join(claudeHome, "settings.json"), "utf8"), originalSettings);
    const adapterState = JSON.parse(await readFile(join(home, "adapters", "claude-code", "state.json"), "utf8"));
    assert.equal(adapterState.integration, "hooks");
    assert.equal(adapterState.enabled, true);
    assert.equal(adapterState.claudeSkillDelivery, "plugin");
    assert.equal(adapterState.claudePluginSkillsRoot, join(pluginCli.pluginInstallPath, "skills"));
    assert.equal(await pathExists(join(claudeHome, "skills", "memorax-code")), false);
    const viewer = await fetch(`http://127.0.0.1:${port}/memory-viewer/api/summary?client=claude-code`)
      .then((response) => response.json());
    assert.equal(viewer.summary.turnCount, 0);
    assert.equal(viewer.activities.length, 0);
    assert.doesNotMatch(JSON.stringify(viewer), /private lifecycle Claude prompt|lifecycle-session|lifecycle-turn/);

    const status = await runCli(cliPath, [
      "status", "--json",
      "--home", home,
      "--port", String(port),
      "--claude-home", claudeHome,
      "--clients", "claude",
    ], { env });
    assert.equal(status.code, 0, `${status.stdout}\n${status.stderr}`);
    const statusReport = JSON.parse(status.stdout);
    assert.equal(statusReport.claudeAdapter.integration, "hooks");
    assert.equal(statusReport.claudeAdapter.claudeSkills.status, "plugin-managed");
    assert.equal(await readFile(join(claudeHome, "settings.json"), "utf8"), originalSettings);
  } finally {
    await runCli(cliPath, [
      "stop", "--json",
      "--home", home,
      "--port", String(port),
      "--claude-home", claudeHome,
      "--clients", "claude",
    ], { env });
    await rm(home, { recursive: true, force: true });
    await rm(claudeHome, { recursive: true, force: true });
    await rm(ignoredClaudeHome, { recursive: true, force: true });
  }
});

test("memorax-code keeps Codex and Backend healthy after a managed Claude runtime is removed", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-lifecycle-removed-claude-home-"));
  const codexHome = await mkdtemp(join(tmpdir(), "memorax-code-lifecycle-removed-claude-codex-"));
  const claudeHome = await mkdtemp(join(tmpdir(), "memorax-code-lifecycle-removed-claude-config-"));
  const workspace = join(home, "workspace", "Claude-Repo");
  const transcriptDirectory = join(claudeHome, "projects", "encoded-project");
  const port = await freePort();
  const cliPath = fileURLToPath(new URL("../dist/memorax-code.js", import.meta.url));
  const pluginCli = await prepareClaudePluginCli(home);
  await prepareActiveCodexPlugin(codexHome);
  await writeManagedClientsConfig(home, { codex: true, claude: true });
  const availableEnv = {
    CLAUDE_CONFIG_DIR: claudeHome,
    FAKE_CLAUDE_PLUGIN_CALLS: pluginCli.callsPath,
    MEMORAX_CODE_CLAUDE_COMMAND: pluginCli.claudeCommand,
  };
  const commonArgs = [
    "--home", home,
    "--port", String(port),
    "--codex-home", codexHome,
    "--claude-home", claudeHome,
    "--clients", "all",
  ];
  try {
    await Promise.all([
      mkdir(join(workspace, ".git"), { recursive: true }),
      mkdir(transcriptDirectory, { recursive: true }),
    ]);
    await writeFile(join(transcriptDirectory, "removed-runtime-session.jsonl"), `${JSON.stringify({
      type: "user",
      userType: "external",
      sessionId: "removed-runtime-session",
      uuid: "removed-runtime-user-record",
      promptId: "removed-runtime-turn",
      cwd: workspace,
      timestamp: new Date().toISOString(),
      message: { role: "user", content: "private removed-runtime Claude prompt" },
    })}\n`, "utf8");
    const initial = await runCli(cliPath, ["start", "--json", ...commonArgs], { env: availableEnv });
    assert.equal(initial.code, 0, `${initial.stdout}\n${initial.stderr}`);

    const missingEnv = {
      ...availableEnv,
      MEMORAX_CODE_CLAUDE_COMMAND: join(home, "missing-claude"),
    };
    const restarted = await runCli(cliPath, ["start", "--json", ...commonArgs], { env: missingEnv });
    assert.equal(restarted.code, 0, `${restarted.stdout}\n${restarted.stderr}`);
    const restartReport = JSON.parse(restarted.stdout);
    assert.equal(restartReport.ok, true);
    assert.equal(restartReport.backend.ok, true);
    assert.equal(restartReport.codexAdapter.ok, true);
    assert.equal(restartReport.claudeAdapter.ok, true);
    assert.equal(restartReport.claudeAdapter.skipped, true);
    assert.equal(restartReport.claudeAdapter.reason, "client_not_detected");

    const status = await runCli(cliPath, ["status", "--json", ...commonArgs], { env: missingEnv });
    assert.equal(status.code, 0, `${status.stdout}\n${status.stderr}`);
    const statusReport = JSON.parse(status.stdout);
    assert.equal(statusReport.ok, true);
    assert.equal(statusReport.backend.ok, true);
    assert.equal(statusReport.codexAdapter.ok, true);
    assert.equal(statusReport.claudeAdapter.skipped, true);
    assert.equal(statusReport.claudeAdapter.reason, "client_not_detected");

    const humanStatus = await runCli(cliPath, ["status", ...commonArgs], { env: missingEnv });
    assert.equal(humanStatus.code, 0, `${humanStatus.stdout}\n${humanStatus.stderr}`);
    assert.match(humanStatus.stdout, /Claude adapter: skipped client_not_detected/);
  } finally {
    await runCli(cliPath, ["stop", "--json", ...commonArgs], { env: availableEnv });
    await rm(home, { recursive: true, force: true });
    await rm(codexHome, { recursive: true, force: true });
    await rm(claudeHome, { recursive: true, force: true });
  }
});

test("memorax-code uninstall preserves temporary Claude cleanup scope after plugin removal fails", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-uninstall-claude-plugin-retry-home-"));
  const claudeHome = await mkdtemp(join(tmpdir(), "memorax-code-uninstall-claude-plugin-retry-config-"));
  const port = await freePort();
  const cliPath = fileURLToPath(new URL("../dist/memorax-code.js", import.meta.url));
  const pluginCli = await prepareClaudePluginCli(home);
  const activeClientsPath = join(home, "runtime", "backend", "managed-clients.json");
  await writeManagedClientsConfig(home, { codex: true, claude: false });
  await writeFile(join(claudeHome, "settings.json"), `${JSON.stringify({
    env: {
      ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
      ANTHROPIC_API_KEY: "deepseek-secret",
    },
  }, null, 2)}\n`);
  const env = {
    CLAUDE_CONFIG_DIR: claudeHome,
    FAKE_CLAUDE_PLUGIN_CALLS: pluginCli.callsPath,
    MEMORAX_CODE_CLAUDE_COMMAND: pluginCli.claudeCommand,
  };
  const commonArgs = ["--home", home, "--port", String(port), "--claude-home", claudeHome];
  try {
    const started = await runCli(cliPath, ["start", "--json", ...commonArgs, "--clients", "claude"], { env });
    assert.equal(started.code, 0, `${started.stdout}\n${started.stderr}`);

    const failed = await runCli(cliPath, [
      "uninstall", "--json",
      ...commonArgs,
      "--clients", "claude",
      "--no-npm-uninstall",
    ], { env: { ...env, FAKE_CLAUDE_PLUGIN_UNINSTALL_FAIL: "1" } });
    assert.equal(failed.code, 1, `${failed.stdout}\n${failed.stderr}`);
    assert.equal(JSON.parse(failed.stdout).npmPackageRemoval.reason, "plugin_cleanup_failed");
    assert.deepEqual(JSON.parse(await readFile(activeClientsPath, "utf8")), {
      codex: false,
      claude: true,
    });

    const retried = await runCli(cliPath, [
      "uninstall", "--json",
      ...commonArgs,
      "--no-npm-uninstall",
    ], { env });
    assert.equal(retried.code, 0, `${retried.stdout}\n${retried.stderr}`);
    assert.equal(JSON.parse(retried.stdout).claudeAdapter.pluginRemove.ok, true);
    const calls = (await readFile(pluginCli.callsPath, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(calls.filter((call) => call.args[0] === "plugin" && call.args[1] === "uninstall").length, 2);
    assert.equal(await pathExists(activeClientsPath), false);
  } finally {
    await runCli(cliPath, ["stop", "--json", ...commonArgs, "--clients", "none"], { env });
    await rm(home, { recursive: true, force: true });
    await rm(claudeHome, { recursive: true, force: true });
  }
});

test("memorax-code uninstall leaves direct Claude provider settings unchanged", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-uninstall-claude-home-"));
  const claudeHome = await mkdtemp(join(tmpdir(), "memorax-code-uninstall-claude-config-"));
  const port = await freePort();
  const cliPath = fileURLToPath(new URL("../dist/memorax-code.js", import.meta.url));
  const pluginCli = await prepareClaudePluginCli(home);
  await writeFile(join(claudeHome, "settings.json"), `${JSON.stringify({
    env: {
      ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
      ANTHROPIC_API_KEY: "deepseek-secret",
      ANTHROPIC_MODEL: "deepseek-v4-pro",
    },
  }, null, 2)}\n`);
  await mkdir(join(claudeHome, "plugins", "data", "memorax-code-claude-adapter-memorax-code-local"), { recursive: true });
  await writeFile(join(claudeHome, "plugins", "data", "memorax-code-claude-adapter-memorax-code-local", "state.json"), "{}\n");
  const env = {
    CLAUDE_CONFIG_DIR: claudeHome,
    FAKE_CLAUDE_PLUGIN_CALLS: pluginCli.callsPath,
    MEMORAX_CODE_CLAUDE_COMMAND: pluginCli.claudeCommand,
  };
  try {
    const started = await runCli(cliPath, [
      "start", "--json",
      "--home", home,
      "--port", String(port),
      "--clients", "claude",
    ], { env });
    assert.equal(started.code, 0, `${started.stdout}\n${started.stderr}`);

    const activeSettings = JSON.parse(await readFile(join(claudeHome, "settings.json"), "utf8"));
    assert.equal(activeSettings.env.ANTHROPIC_BASE_URL, "https://api.deepseek.com/anthropic");
    assert.equal(activeSettings.env.ANTHROPIC_API_KEY, "deepseek-secret");
    assert.equal(activeSettings.env.ANTHROPIC_AUTH_TOKEN, undefined);

    const uninstalled = await runCli(cliPath, [
      "uninstall", "--json",
      "--home", home,
      "--port", String(port),
      "--clients", "claude",
      "--no-npm-uninstall",
    ], { env });
    assert.equal(uninstalled.code, 0, `${uninstalled.stdout}\n${uninstalled.stderr}`);
    const uninstallReport = JSON.parse(uninstalled.stdout);
    assert.equal(uninstallReport.ok, true);
    assert.equal(uninstallReport.claudeAdapter.ok, true);
    assert.equal(uninstallReport.claudeAdapter.pluginRemove.ok, true);
    assert.equal(uninstallReport.removesPlugin, true);

    const restoredSettings = JSON.parse(await readFile(join(claudeHome, "settings.json"), "utf8"));
    assert.equal(restoredSettings.env.ANTHROPIC_BASE_URL, "https://api.deepseek.com/anthropic");
    assert.equal(restoredSettings.env.ANTHROPIC_API_KEY, "deepseek-secret");
    assert.equal(restoredSettings.env.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(restoredSettings.env.ANTHROPIC_MODEL, "deepseek-v4-pro");
    assert.equal(restoredSettings.extraKnownMarketplaces?.["memorax-code-local"], undefined);
    assert.equal(restoredSettings.enabledPlugins?.["memorax-code-claude-adapter@memorax-code-local"], undefined);
    assert.equal(
      await readFile(join(claudeHome, "plugins", "data", "memorax-code-claude-adapter-memorax-code-local", "state.json"), "utf8"),
      "{}\n",
    );
  } finally {
    await runCli(cliPath, ["stop", "--json", "--home", home, "--port", String(port), "--clients", "claude"], { env });
    await rm(home, { recursive: true, force: true });
    await rm(claudeHome, { recursive: true, force: true });
  }
});

test("memorax-code start leaves Codex config unchanged before the plugin is installed", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-lifecycle-no-plugin-home-"));
  const codexHome = await mkdtemp(join(tmpdir(), "memorax-code-lifecycle-no-plugin-codex-"));
  const port = await freePort();
  const cliPath = fileURLToPath(new URL("../dist/memorax-code.js", import.meta.url));
  const originalConfig = [
    'model_provider = "custom"',
    "",
    "[model_providers.custom]",
    'base_url = "http://127.0.0.1:9999/v1"',
    'wire_api = "responses"',
    "",
  ].join("\n");
  await writeFile(join(codexHome, "config.toml"), originalConfig);
  try {
    const started = await runCli(cliPath, [
      "start", "--json",
      "--home", home,
      "--port", String(port),
      "--codex-home", codexHome,
      "--clients", "codex",
    ]);
    assert.equal(started.code, 0, `${started.stdout}\n${started.stderr}`);
    const report = JSON.parse(started.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.backend.ok, true);
    assert.equal(report.codexAdapter.ok, true);
    assert.equal(report.codexAdapter.skipped, true);
    assert.equal(report.codexAdapter.reason, "codex_plugin_not_installed");
    assert.equal(await readFile(join(codexHome, "config.toml"), "utf8"), originalConfig);
  } finally {
    await runCli(cliPath, ["stop", "--json", "--home", home, "--port", String(port), "--codex-home", codexHome, "--clients", "none"]);
    await rm(home, { recursive: true, force: true });
    await rm(codexHome, { recursive: true, force: true });
  }
});

test("memorax-code start --yes registers a missing Codex plugin but requires activation", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-lifecycle-prompt-plugin-home-"));
  const codexHome = await mkdtemp(join(tmpdir(), "memorax-code-lifecycle-prompt-plugin-codex-"));
  const port = await freePort();
  const cliPath = fileURLToPath(new URL("../dist/memorax-code.js", import.meta.url));
  await writeFile(join(codexHome, "config.toml"), [
    'model_provider = "custom"',
    "",
    "[model_providers.custom]",
    'base_url = "http://127.0.0.1:9999/v1"',
    'wire_api = "responses"',
    "",
  ].join("\n"));
  try {
    const started = await runCli(cliPath, [
      "start",
      "--yes",
      "--home", home,
      "--port", String(port),
      "--codex-home", codexHome,
      "--marketplace-path", join(home, ".agents", "plugins", "marketplace.json"),
      "--clients", "codex",
    ]);
    assert.equal(started.code, 0, `${started.stdout}\n${started.stderr}`);
    assert.match(started.stdout, /Codex plugin source registered/);
    assert.match(started.stdout, /Activate the MemoraX Code Codex Adapter plugin/);
    assert.match(started.stdout, /^\[MemoraX Code Backend\]: Codex adapter: skipped codex_plugin_activation_required/m);
    assert.match(started.stdout, /one or more adapters are not enabled/);
    const pluginManifest = JSON.parse(await readFile(join(codexHome, ".memorax-code", "plugins", "memorax-code-codex-adapter", ".codex-plugin", "plugin.json"), "utf8"));
    assert.equal(pluginManifest.name, "memorax-code-codex-adapter");
    const marketplace = JSON.parse(await readFile(join(home, ".agents", "plugins", "marketplace.json"), "utf8"));
    assert.equal(marketplace.plugins[0].name, "memorax-code-codex-adapter");
  } finally {
    await runCli(cliPath, ["stop", "--json", "--home", home, "--port", String(port), "--codex-home", codexHome, "--clients", "codex"]);
    await rm(home, { recursive: true, force: true });
    await rm(codexHome, { recursive: true, force: true });
  }
});

test("memorax-code start seeds the default memory config", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-lifecycle-default-memory-home-"));
  const codexHome = await mkdtemp(join(tmpdir(), "memorax-code-lifecycle-default-memory-codex-"));
  const port = await freePort();
  const cliPath = fileURLToPath(new URL("../dist/memorax-code.js", import.meta.url));
  await writeFile(join(codexHome, "config.toml"), [
    'model_provider = "custom"',
    "",
    "[model_providers.custom]",
    'name = "Custom"',
    'base_url = "http://127.0.0.1:9999/openai"',
    'wire_api = "responses"',
    "",
  ].join("\n"));
  await prepareActiveCodexPlugin(codexHome);
  try {
    const started = await runCli(cliPath, [
      "start", "--json",
      "--home", home,
      "--port", String(port),
      "--codex-home", codexHome,
      "--clients", "codex",
    ]);
    assert.equal(started.code, 0, `${started.stdout}\n${started.stderr}`);
    const startReport = JSON.parse(started.stdout);
    assert.equal(startReport.ok, true);
    assert.equal(await readFile(join(home, "config.toml"), "utf8"), renderDefaultMemoraxCodeConfig());
  } finally {
    await runCli(cliPath, ["stop", "--json", "--home", home, "--port", String(port), "--codex-home", codexHome, "--clients", "codex"]);
  }
});

test("memorax-code start refreshes an already-running Backend process", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-lifecycle-refresh-home-"));
  const port = await freePort();
  const cliPath = fileURLToPath(new URL("../dist/memorax-code.js", import.meta.url));
  try {
    const first = await runCli(cliPath, [
      "start", "--json",
      "--home", home,
      "--port", String(port),
      "--clients", "none",
    ]);
    assert.equal(first.code, 0, `${first.stdout}\n${first.stderr}`);
    const firstReport = JSON.parse(first.stdout);
    const firstPid = firstReport.backend.state.pid;
    assert.equal(firstReport.backend.alreadyRunning, undefined);
    assert.equal(isProcessAlive(firstPid), true);

    const second = await runCli(cliPath, [
      "start", "--json",
      "--home", home,
      "--port", String(port),
      "--clients", "none",
    ]);
    assert.equal(second.code, 0, `${second.stdout}\n${second.stderr}`);
    const secondReport = JSON.parse(second.stdout);
    const secondPid = secondReport.backend.state.pid;
    assert.notEqual(secondPid, firstPid);
    assert.equal(secondReport.backend.alreadyRunning, undefined);
    assert.equal(isProcessAlive(firstPid), false);
    assert.equal(isProcessAlive(secondPid), true);
  } finally {
    await runCli(cliPath, ["stop", "--json", "--home", home, "--port", String(port), "--clients", "none"]);
  }
});

test("Backend service manager can start, report logs, and stop a local Backend", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-service-home-"));
  const port = await freePort();
  try {
    const started = await startBackendService({ home, port, timeoutMs: 5000 });
    assert.equal(started.ok, true);
    assert.equal(started.state?.port, port);
    const pidPath = join(home, "runtime", "backend", "backend.pid.json");
    assert.equal(JSON.parse(await readFile(pidPath, "utf8")).version, 1);
    if (process.platform !== "win32") {
      assert.equal((await stat(pidPath)).mode & 0o777, 0o600);
    }
    const status = await runBackendStatus(`http://127.0.0.1:${port}`);
    assert.equal(status.ok, true);
    const logs = backendServiceLogs({ home });
    assert.equal(logs.ok, true);
    assert.match(logs.text ?? "", /memorax-code-backend listening/);
  } finally {
    const stopped = await stopBackendService({ home, port, timeoutMs: 5000 });
    assert.equal(stopped.ok, true);
  }
});

test("Backend service keeps Claude native Viewer enrichment behind the live managed-client gate", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-service-claude-viewer-home-"));
  const claudeHome = await mkdtemp(join(tmpdir(), "memorax-code-service-claude-viewer-config-"));
  const workspace = join(home, "workspace", "Claude-Repo");
  const projectsRoot = join(claudeHome, "projects");
  const transcriptDirectory = join(projectsRoot, "encoded-project");
  const port = await freePort();
  try {
    await Promise.all([
      mkdir(join(workspace, ".git"), { recursive: true }),
      mkdir(transcriptDirectory, { recursive: true }),
    ]);
    await writeFile(
      join(transcriptDirectory, "native-session.jsonl"),
      `${[
        {
          type: "user",
          userType: "external",
          sessionId: "native-session",
          uuid: "native-user-record",
          promptId: "native-turn",
          cwd: workspace,
          timestamp: new Date().toISOString(),
          message: { role: "user", content: "private managed Claude prompt" },
        },
        {
          type: "assistant",
          sessionId: "native-session",
          uuid: "native-tool-use",
          parentUuid: "native-user-record",
          cwd: workspace,
          timestamp: new Date().toISOString(),
          message: {
            role: "assistant",
            stop_reason: "tool_use",
            content: [{
              type: "tool_use",
              id: "native-memory-search",
              name: "Bash",
              input: {
                command: "memorax-cli search --query private-managed-query",
              },
            }],
          },
        },
        {
          type: "user",
          userType: "external",
          sessionId: "native-session",
          uuid: "native-tool-result",
          parentUuid: "native-tool-use",
          cwd: workspace,
          timestamp: new Date().toISOString(),
          message: {
            role: "user",
            content: [{
              type: "tool_result",
              tool_use_id: "native-memory-search",
              content: [
                "<memories>",
                "  <facts memory_type=\"core\">",
                "   - private managed result",
                "  </facts>",
                "</memories>",
              ].join("\n"),
            }],
          },
        },
        {
          type: "assistant",
          sessionId: "native-session",
          uuid: "native-final-answer",
          parentUuid: "native-tool-result",
          cwd: workspace,
          timestamp: new Date(Date.now() + 1_000).toISOString(),
          message: {
            role: "assistant",
            stop_reason: "end_turn",
            content: [{ type: "text", text: "private managed final answer" }],
          },
        },
      ].map((record) => JSON.stringify(record)).join("\n")}\n`,
      "utf8",
    );
    const traceDirectory = join(home, "debug", "traces", "claude", "sessions", "native-session");
    await mkdir(traceDirectory, { recursive: true });
    await writeFile(join(traceDirectory, "events.jsonl"), `${JSON.stringify({
      type: "turn_start",
      event_id: "managed-hook-start",
      timestamp: new Date().toISOString(),
      trace: {
        client: "claude",
        session_id: "native-session",
        turn_id: "native-turn",
        cwd: workspace,
      },
      operation: "query",
      request: { prompt: "Hook managed Claude prompt." },
    })}\n`, "utf8");
    writeActiveManagedClients(home, { codex: false, claude: true });
    const started = await startBackendService({
      home,
      port,
      timeoutMs: 5000,
      claudeProjectsRoot: projectsRoot,
    });
    assert.equal(started.ok, true);
    const endpoint = `http://127.0.0.1:${port}/memory-viewer/api/summary?client=claude-code`;
    const enabled = await fetch(endpoint).then((response) => response.json());
    assert.equal(enabled.summary.searchOperationCount, 1);
    assert.doesNotMatch(JSON.stringify(enabled), /private managed/);

    writeActiveManagedClients(home, { codex: false, claude: false });
    const disabled = await fetch(endpoint).then((response) => response.json());
    assert.equal(disabled.summary.searchOperationCount, 0);
    assert.doesNotMatch(JSON.stringify(disabled), /private managed/);

    writeActiveManagedClients(home, { codex: false, claude: true });
    const reenabled = await fetch(endpoint).then((response) => response.json());
    assert.equal(reenabled.summary.searchOperationCount, 1);
    assert.doesNotMatch(JSON.stringify(reenabled), /private managed/);
  } finally {
    await stopBackendService({ home, port, timeoutMs: 5000 });
    await rm(home, { recursive: true, force: true });
    await rm(claudeHome, { recursive: true, force: true });
  }
});

test("memorax-code lifecycle serializes concurrent starts without losing PID authority", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-concurrent-start-home-"));
  const port = await freePort();
  const runtimeDir = join(home, "runtime", "backend");
  const pidPath = join(runtimeDir, "backend.pid.json");
  const cliPath = fileURLToPath(new URL("../dist/memorax-code.js", import.meta.url));
  const observedPids = new Set();
  try {
    const args = [
      "start",
      "--json",
      "--home", home,
      "--port", String(port),
      "--clients", "none",
    ];
    const starts = await Promise.all([
      runCli(cliPath, args),
      runCli(cliPath, args),
    ]);
    for (const started of starts) {
      assert.equal(started.code, 0, `${started.stdout}\n${started.stderr}`);
      const report = JSON.parse(started.stdout);
      if (Number.isSafeInteger(report.backend?.state?.pid)) {
        observedPids.add(report.backend.state.pid);
      }
    }
    const state = JSON.parse(await readFile(pidPath, "utf8"));
    observedPids.add(state.pid);
    assert.equal(state.version, 1);
    assert.equal(typeof state.instanceId, "string");
    const health = await fetch(`http://127.0.0.1:${port}/health`).then((response) => response.json());
    assert.equal(health.instanceId, state.instanceId);
    assert.equal(isProcessAlive(state.pid), true);

    const stopped = await runCli(cliPath, [
      "stop",
      "--json",
      "--home", home,
      "--clients", "none",
    ]);
    assert.equal(stopped.code, 0, `${stopped.stdout}\n${stopped.stderr}`);
    assert.equal(await pathExists(pidPath), false);
    assert.equal(isProcessAlive(state.pid), false);
  } finally {
    await runCli(cliPath, ["stop", "--json", "--home", home, "--clients", "none"]);
    for (const pid of observedPids) {
      if (!isProcessAlive(pid)) continue;
      terminateProcessTree(pid);
      await waitForProcessExit(pid);
    }
    await rm(home, { recursive: true, force: true });
  }
});

test("Backend service rejects an unrelated healthy server and clears its pid file", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-service-health-identity-home-"));
  const unrelated = createServer((_, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, service: "unrelated-service" }));
  });
  const url = await listen(unrelated);
  try {
    const status = await runBackendStatus(url);
    assert.equal(status.ok, false);
    const started = await startBackendService({ home, port: Number(new URL(url).port), timeoutMs: 300 });

    assert.equal(started.ok, false);
    assert.match(started.error, /did not become healthy/);
    assert.equal(await pathExists(join(home, "runtime", "backend", "backend.pid.json")), false);
  } finally {
    await new Promise((resolve) => unrelated.close(resolve));
    await rm(home, { recursive: true, force: true });
  }
});

test("Backend service rejects a healthy MemoraX Code Backend for another session home", async () => {
  const expectedHome = await mkdtemp(join(tmpdir(), "memorax-code-service-expected-home-"));
  const otherHome = await mkdtemp(join(tmpdir(), "memorax-code-service-other-home-"));
  const otherBackend = createServer((_, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      ok: true,
      service: "memorax-code-backend",
      state: { sessionHome: otherHome },
    }));
  });
  const url = await listen(otherBackend);
  try {
    const started = await startBackendService({
      home: expectedHome,
      port: Number(new URL(url).port),
      timeoutMs: 300,
    });

    assert.equal(started.ok, false);
    assert.match(started.error, /did not become healthy/);
    assert.equal(await pathExists(join(expectedHome, "runtime", "backend", "backend.pid.json")), false);
  } finally {
    await new Promise((resolve) => otherBackend.close(resolve));
    await rm(expectedHome, { recursive: true, force: true });
    await rm(otherHome, { recursive: true, force: true });
  }
});

test("Backend health probes bound response consumption to the total timeout budget", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-service-health-timeout-home-"));
  const timers = new Set();
  const slowBackend = createServer((_, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.flushHeaders();
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (!response.destroyed) {
        response.end(JSON.stringify({
          ok: true,
          service: "memorax-code-backend",
          state: { sessionHome: home },
        }));
      }
    }, 800);
    timers.add(timer);
    response.on("close", () => {
      clearTimeout(timer);
      timers.delete(timer);
    });
  });
  const url = await listen(slowBackend);
  try {
    const statusStartedAt = Date.now();
    const status = await runBackendStatus(url, undefined, 100);
    const statusElapsedMs = Date.now() - statusStartedAt;

    const startStartedAt = Date.now();
    const started = await startBackendService({
      home,
      port: Number(new URL(url).port),
      timeoutMs: 100,
    });
    const startElapsedMs = Date.now() - startStartedAt;

    assert.equal(status.ok, false);
    assert.ok(statusElapsedMs < 500, `status probe exceeded budget: ${statusElapsedMs}ms`);
    assert.equal(started.ok, false);
    assert.ok(startElapsedMs < 500, `service health check exceeded budget: ${startElapsedMs}ms`);
    assert.equal(await pathExists(join(home, "runtime", "backend", "backend.pid.json")), false);
  } finally {
    for (const timer of timers) clearTimeout(timer);
    slowBackend.closeAllConnections?.();
    await new Promise((resolve) => slowBackend.close(resolve));
    await rm(home, { recursive: true, force: true });
  }
});

test("Backend service can use persisted local token", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-service-token-home-"));
  const port = await freePort();
  const token = writeBackendToken({ home });
  assert.equal(readBackendToken({ home })?.token, token.token);
  const rotated = writeBackendToken({ home }, true);
  assert.notEqual(rotated.token, token.token);
  assert.equal(readBackendToken({ home })?.token, rotated.token);
  const previousLoopbackAuth = process.env.MEMORAX_CODE_BACKEND_LOOPBACK_AUTH;
  process.env.MEMORAX_CODE_BACKEND_LOOPBACK_AUTH = "1";

  try {
    const started = await startBackendService({ home, port, timeoutMs: 5000 });
    assert.equal(started.ok, true);
    const status = await runBackendStatus(`http://127.0.0.1:${port}`);
    assert.equal(status.ok, true);
    assert.equal(status.authRequired, true);
    const cliPath = fileURLToPath(new URL("../dist/memorax-code.js", import.meta.url));
    const blockedRotation = await runCli(cliPath, ["token", "--rotate", "--home", home]);
    assert.equal(blockedRotation.code, 1);
    assert.match(blockedRotation.stdout, /stop the managed Backend before rotating its token/);
    assert.equal(readBackendToken({ home })?.token, rotated.token);

    const memoryHookUrl = new URL("/memory/turn-start", `http://127.0.0.1:${port}`);
    const memoryHookBody = JSON.stringify({
      version: 1,
      client: "codex",
      sessionId: "authenticated-memory-hook",
      prompt: "Authenticate this memory Hook command.",
      transcriptPath: "/tmp/authenticated-memory-hook.jsonl",
    });
    const rejected = await fetch(memoryHookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: memoryHookBody,
    });
    assert.equal(rejected.status, 401);
    const authorized = await fetch(memoryHookUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${rotated.token}`,
        "content-type": "application/json",
      },
      body: memoryHookBody,
    });
    assert.equal(authorized.status, 200);
    const canonicalHeader = await fetch(memoryHookUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-memorax-code-backend-token": rotated.token,
      },
      body: memoryHookBody,
    });
    assert.equal(canonicalHeader.status, 200);
  } finally {
    const stopped = await stopBackendService({ home, port, timeoutMs: 5000 });
    restoreEnv("MEMORAX_CODE_BACKEND_LOOPBACK_AUTH", previousLoopbackAuth);
    assert.equal(stopped.ok, true);
  }
});

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function runCli(cliPath, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function waitForProcessExit(pid, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && isProcessAlive(pid)) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
