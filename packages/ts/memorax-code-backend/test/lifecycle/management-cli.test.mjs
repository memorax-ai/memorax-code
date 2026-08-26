import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createBackendState } from "../../dist/app/state.js";
import { runBackendStatus } from "../../dist/lifecycle/backend/status.js";
import { createBackendServer } from "../../dist/server.js";
import { isProcessAlive } from "../../dist/lifecycle/backend/service.js";
import { freePort, listen } from "../support/helpers.mjs";

import {
  pathExists,
  prepareActiveCodexPlugin,
  prepareClaudePluginCli,
  prepareUnverifiedLifecycleState,
  runCli,
  writeManagedClientsConfig,
} from "./support/backend-service-fixtures.mjs";

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
    const cliPath = fileURLToPath(new URL("../../dist/memorax-code.js", import.meta.url));
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

    const cliPath = fileURLToPath(new URL("../../dist/memorax-code.js", import.meta.url));
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
  const cliPath = fileURLToPath(new URL("../../dist/memorax-code.js", import.meta.url));
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
  const cliPath = fileURLToPath(new URL("../../dist/memorax-code.js", import.meta.url));
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
  const cliPath = fileURLToPath(new URL("../../dist/memorax-code.js", import.meta.url));
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
  const cliPath = fileURLToPath(new URL("../../dist/memorax-code.js", import.meta.url));
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
  const cliPath = fileURLToPath(new URL("../../dist/memorax-code.js", import.meta.url));
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
  const cliPath = fileURLToPath(new URL("../../dist/memorax-code.js", import.meta.url));
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
  const cliPath = fileURLToPath(new URL("../../dist/memorax-code.js", import.meta.url));
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
  const cliPath = fileURLToPath(new URL("../../dist/memorax-code.js", import.meta.url));
  const claudeCli = await prepareClaudePluginCli(home);
  const originalCodexConfig = "codex sentinel\n";
  const originalClaudeSettings = "{\"sentinel\":true}\n";
  await writeFile(join(home, "config.toml"), [
    "[clients]",
    "codex = false",
    "claude = false",
    "dsh = false",
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
      assert.equal(Object.hasOwn(report, "dshAdapter"), false);
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
  const cliPath = fileURLToPath(new URL("../../dist/memorax-code.js", import.meta.url));
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
      dsh: false,
      opencode: false,
    });

    const backendOnlyStop = await runCli(cliPath, [
      "stop", "--json", ...commonArgs, "--clients", "none",
    ], { env });
    assert.equal(backendOnlyStop.code, 0, `${backendOnlyStop.stdout}\n${backendOnlyStop.stderr}`);
    assert.equal(await pathExists(join(home, "runtime", "backend", "backend.pid.json")), false);
    assert.deepEqual(JSON.parse(await readFile(activeClientsPath, "utf8")), {
      codex: true,
      claude: true,
      dsh: false,
      opencode: false,
    });

    const recovered = await runCli(cliPath, ["start", "--json", ...commonArgs], { env });
    assert.equal(recovered.code, 0, `${recovered.stdout}\n${recovered.stderr}`);
    const recoveryReport = JSON.parse(recovered.stdout);
    assert.equal(recoveryReport.codexAdapter.enabled, true);
    assert.equal(recoveryReport.claudeAdapter.enabled, true);
    assert.deepEqual(JSON.parse(await readFile(activeClientsPath, "utf8")), {
      codex: true,
      claude: true,
      dsh: false,
      opencode: false,
    });
  } finally {
    await runCli(cliPath, ["stop", "--json", ...commonArgs, "--clients", "codex,claude"], { env });
    await rm(home, { recursive: true, force: true });
    await rm(codexHome, { recursive: true, force: true });
    await rm(claudeHome, { recursive: true, force: true });
  }
});

test("partial client stop preserves Backend until an explicit Backend-only stop", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-clients-partial-home-"));
  const codexHome = await mkdtemp(join(tmpdir(), "memorax-code-clients-partial-codex-"));
  const port = await freePort();
  const cliPath = fileURLToPath(new URL("../../dist/memorax-code.js", import.meta.url));
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
      dsh: false,
      opencode: false,
    });

    const backendOnlyStopped = await runCli(cliPath, ["stop", "--json", ...commonArgs, "--clients", "none"]);
    assert.equal(backendOnlyStopped.code, 0, `${backendOnlyStopped.stdout}\n${backendOnlyStopped.stderr}`);
    const backendOnlyReport = JSON.parse(backendOnlyStopped.stdout);
    assert.equal(backendOnlyReport.backend.skipped, undefined);
    assert.equal(await pathExists(join(home, "runtime", "backend", "backend.pid.json")), false);
    assert.deepEqual(JSON.parse(await readFile(join(home, "runtime", "backend", "managed-clients.json"), "utf8")), {
      codex: false,
      claude: true,
      dsh: false,
      opencode: false,
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
  const cliPath = fileURLToPath(new URL("../../dist/memorax-code.js", import.meta.url));
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
  const cliPath = fileURLToPath(new URL("../../dist/memorax-code.js", import.meta.url));
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

    const activeClientsPath = join(home, "runtime", "backend", "managed-clients.json");
    const activeClients = { codex: false, claude: true, dsh: false, opencode: false };
    await mkdir(join(home, "runtime", "backend"), { recursive: true });
    await writeFile(activeClientsPath, `${JSON.stringify(activeClients)}\n`);
    const replacement = await runCli(cliPath, ["start", "--json", ...commonArgs], {
      env: { ...env, MEMORAX_CODE_PACKAGE_REPLACEMENT: "1" },
    });
    assert.equal(replacement.code, 1, `${replacement.stdout}\n${replacement.stderr}`);
    assert.match(replacement.stderr, /failed to parse MemoraX Code lifecycle config/);
    assert.deepEqual(JSON.parse(await readFile(activeClientsPath, "utf8")), activeClients);
    assert.equal(await pathExists(join(home, "runtime", "backend", "backend.pid.json")), false);
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
  const cliPath = fileURLToPath(new URL("../../dist/memorax-code.js", import.meta.url));
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
  const cliPath = fileURLToPath(new URL("../../dist/memorax-code.js", import.meta.url));
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
      dsh: false,
      opencode: false,
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
  const cliPath = fileURLToPath(new URL("../../dist/memorax-code.js", import.meta.url));
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
  const cliPath = fileURLToPath(new URL("../../dist/memorax-code.js", import.meta.url));
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
  const cliPath = fileURLToPath(new URL("../../dist/server.js", import.meta.url));
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
