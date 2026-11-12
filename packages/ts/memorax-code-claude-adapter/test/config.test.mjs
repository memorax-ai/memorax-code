import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, lstat, mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  RUNTIME,
  disableClaudeAdapter,
  enableClaudeAdapter,
  readClaudeAdapterStatus,
} from "../src/config.mjs";
import { buildClaudeMarketplace } from "../scripts/build-marketplace.mjs";

async function prepareClaudePluginSkills(root) {
  const skillsRoot = join(root, "plugin", "skills");
  await mkdir(join(skillsRoot, "memorax-code"), { recursive: true });
  await writeFile(
    join(skillsRoot, "memorax-code", "SKILL.md"),
    "---\nname: memorax-code\n---\n",
  );
  return skillsRoot;
}

test("Claude adapter keeps direct provider settings byte-identical and records Hook integration only", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-claude-direct-hooks-"));
  const claudeHome = join(root, "claude");
  const memoraxCodeHome = join(root, "memorax-code");
  const originalSettings = `${JSON.stringify({
    env: {
      ANTHROPIC_BASE_URL: "https://api.anthropic.com",
      ANTHROPIC_API_KEY: "test-key",
      ANTHROPIC_CUSTOM_HEADERS: "x-user-header: preserved",
    },
  }, null, 2)}\n`;
  try {
    await mkdir(claudeHome, { recursive: true });
    await writeFile(join(claudeHome, "settings.json"), originalSettings);
    const claudePluginSkillsRoot = await prepareClaudePluginSkills(root);

    const enabled = enableClaudeAdapter({
      claudeHome,
      memoraxCodeHome,
      claudePluginSkillsRoot,
      backendUrl: "http://127.0.0.1:8787",
      force: true,
    });
    assert.equal(enabled.ok, true);
    assert.equal(enabled.integration, "hooks");
    assert.equal(enabled.enabled, true);
    assert.equal(await readFile(join(claudeHome, "settings.json"), "utf8"), originalSettings);
    assert.equal(enabled.state.integration, "hooks");
    assert.equal(enabled.state.enabled, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude Hook lifecycle is identical with and without explicit provider settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-claude-provider-agnostic-"));
  try {
    for (const [name, originalSettings] of [
      ["provider", `${JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "https://api.example.test/anthropic",
          ANTHROPIC_API_KEY: "provider-key",
        },
      }, null, 2)}\n`],
      ["builtin", "{}\n"],
    ]) {
      const claudeHome = join(root, name, "claude");
      const memoraxCodeHome = join(root, name, "memorax-code");
      const claudePluginSkillsRoot = await prepareClaudePluginSkills(join(root, name));
      await mkdir(claudeHome, { recursive: true });
      await writeFile(join(claudeHome, "settings.json"), originalSettings);

      const enabled = enableClaudeAdapter({ claudeHome, memoraxCodeHome, claudePluginSkillsRoot });
      assert.equal(enabled.ok, true, name);
      assert.equal(enabled.enabled, true, name);
      assert.equal(enabled.integration, "hooks", name);
      assert.equal(await readFile(join(claudeHome, "settings.json"), "utf8"), originalSettings, name);

      const status = readClaudeAdapterStatus({ claudeHome, memoraxCodeHome });
      assert.equal(status.installed, true, name);
      assert.equal(status.enabled, true, name);
      assert.equal(status.integration, "hooks", name);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("enable and disable toggle Hook state without changing direct provider settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-claude-hooks-round-trip-"));
  const claudeHome = join(root, "claude");
  const memoraxCodeHome = join(root, "memorax-code");
  const originalSettings = `${JSON.stringify({
    env: {
      ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
      ANTHROPIC_AUTH_TOKEN: "provider-token",
      ANTHROPIC_MODEL: "deepseek-v4-pro",
    },
  }, null, 2)}\n`;
  await mkdir(claudeHome, { recursive: true });
  await writeFile(join(claudeHome, "settings.json"), originalSettings);
  try {
    const claudePluginSkillsRoot = await prepareClaudePluginSkills(root);
    const enabled = enableClaudeAdapter({
      claudeHome,
      memoraxCodeHome,
      claudePluginSkillsRoot,
      backendUrl: "http://127.0.0.1:8787",
      force: true,
    });
    assert.equal(enabled.ok, true);
    assert.equal(await readFile(join(claudeHome, "settings.json"), "utf8"), originalSettings);
    const status = readClaudeAdapterStatus({ claudeHome, memoraxCodeHome, backendUrl: "http://127.0.0.1:8787" });
    assert.equal(status.installed, true);
    assert.equal(status.enabled, true);
    assert.equal(status.integration, "hooks");
    assert.equal(status.backendUrlMatches, true);
    assert.equal(JSON.stringify(status).includes("provider-token"), false);
    const mismatched = readClaudeAdapterStatus({
      claudeHome,
      memoraxCodeHome,
      backendUrl: "http://127.0.0.1:8877",
    });
    assert.equal(mismatched.configuredBackendUrl, "http://127.0.0.1:8787");
    assert.equal(mismatched.expectedBackendUrl, "http://127.0.0.1:8877");
    assert.equal(mismatched.backendUrlMatches, false);
    const disabled = disableClaudeAdapter({ claudeHome, memoraxCodeHome });
    assert.equal(disabled.ok, true);
    assert.equal(await readFile(join(claudeHome, "settings.json"), "utf8"), originalSettings);
    const after = readClaudeAdapterStatus({ claudeHome, memoraxCodeHome, backendUrl: "http://127.0.0.1:8787" });
    assert.equal(after.installed, false);
    assert.equal(after.enabled, false);
    assert.equal(after.integration, "hooks");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("disable leaves unmanaged Claude settings unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-claude-disable-unmanaged-"));
  const claudeHome = join(root, "claude");
  const memoraxCodeHome = join(root, "memorax-code");
  const originalSettings = `${JSON.stringify({
    env: { ANTHROPIC_BASE_URL: "https://api.anthropic.com", ANTHROPIC_API_KEY: "test-key" },
  }, null, 2)}\n`;
  await mkdir(claudeHome, { recursive: true });
  await writeFile(join(claudeHome, "settings.json"), originalSettings);
  try {
    const disabled = disableClaudeAdapter({ claudeHome, memoraxCodeHome });
    assert.equal(disabled.ok, true);
    assert.equal(disabled.changed, false);
    assert.equal(await readFile(join(claudeHome, "settings.json"), "utf8"), originalSettings);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude doctor reports an unavailable Backend when the health body stalls", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-claude-doctor-cli-"));
  const claudeHome = join(root, "claude");
  const memoraxCodeHome = join(root, "memorax-code");
  const cliPath = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.write('{"ok":true,');
    const timer = setTimeout(() => response.end('"service":"memorax-code-backend"}'), 7_000);
    response.once("close", () => clearTimeout(timer));
  });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const result = await runCli(cliPath, [
      "doctor",
      "--claude-home", claudeHome,
      "--memorax-code-home", memoraxCodeHome,
      "--backend-url", `http://127.0.0.1:${server.address().port}`,
      "--json",
    ]);
    assert.equal(result.code, 1);
    assert.equal(result.stderr, "");
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.action, "doctor");
    assert.equal(payload.ok, false);
    assert.equal(payload.backend.ok, false);
    assert.equal(payload.backend.status, 200);
    assert.equal(payload.status.claudeHome, claudeHome);
    assert.doesNotMatch(result.stdout + result.stderr, /print is not defined/);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test("memorax-code-claude CLI prints status commands", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-claude-status-cli-"));
  const claudeHome = join(root, "claude");
  const memoraxCodeHome = join(root, "memorax-code");
  const cliPath = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
  try {
    await mkdir(claudeHome, { recursive: true });
    await mkdir(join(memoraxCodeHome, "lib", "memorax-code-claude-adapter", "skills", "memorax-code"), { recursive: true });
    await writeFile(
      join(memoraxCodeHome, "lib", "memorax-code-claude-adapter", "skills", "memorax-code", "SKILL.md"),
      "---\nname: memorax-code\n---\n",
    );
    await writeFile(join(claudeHome, "settings.json"), `${JSON.stringify({
      env: { ANTHROPIC_BASE_URL: "https://api.anthropic.com", ANTHROPIC_API_KEY: "test-key" },
    }, null, 2)}\n`);
    const claudePluginSkillsRoot = await prepareClaudePluginSkills(root);
    const enabled = enableClaudeAdapter({
      claudeHome,
      memoraxCodeHome,
      claudePluginSkillsRoot,
      backendUrl: "http://127.0.0.1:8877",
      force: true,
    });
    assert.equal(enabled.ok, true);

    const status = await runCli(cliPath, [
      "status",
      "--claude-home", claudeHome,
      "--memorax-code-home", memoraxCodeHome,
    ], { MEMORAX_CODE_BACKEND_HOST: "127.0.0.1", MEMORAX_CODE_BACKEND_PORT: "8877" });

    assert.equal(status.code, 0);
    assert.match(status.stdout, /status: ok/);
    assert.match(status.stdout, new RegExp(`claude home: ${escapeRegExp(claudeHome)}`));
    assert.doesNotMatch(status.stderr, /print is not defined/);

    const sessions = await runCli(cliPath, [
      "sessions",
      "--claude-home", claudeHome,
      "--memorax-code-home", memoraxCodeHome,
    ]);
    assert.equal(sessions.code, 0);
    assert.match(sessions.stdout, /session count: 0/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude diagnostics CLI rejects unknown commands", async () => {
  const cliPath = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
  const result = await runCli(cliPath, ["unknown-command"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /^unknown command: unknown-command\n$/);
});

test("local Claude diagnostics ignore invalid Backend authority and malformed URL environment", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-claude-local-invalid-authority-"));
  const claudeHome = join(root, "claude");
  const memoraxCodeHome = join(root, "memorax-code");
  const runtimeDir = join(memoraxCodeHome, "runtime", "backend");
  const cliPath = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
  const env = {
    MEMORAX_CODE_BACKEND_URL: "not-a-url",
    MEMORAX_CODE_BACKEND_HOST: "",
    MEMORAX_CODE_BACKEND_PORT: "",
  };
  try {
    await mkdir(claudeHome, { recursive: true });
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(join(runtimeDir, "backend-connection.json"), "{not-json\n");

    for (const args of [
      ["inspect-history", "--claude-home", claudeHome, "--memorax-code-home", memoraxCodeHome, "--json"],
      ["sessions", "--claude-home", claudeHome, "--memorax-code-home", memoraxCodeHome, "--json"],
      [
        "mark-session",
        "--claude-home", claudeHome,
        "--memorax-code-home", memoraxCodeHome,
        "--session-id", "local-claude-session",
        "--json",
      ],
    ]) {
      const result = await runCli(cliPath, args, env);
      assert.equal(result.code, 0, `${args[0]}: ${result.stderr}`);
      assert.equal(JSON.parse(result.stdout).ok, true);
    }

    const status = await runCli(cliPath, [
      "status",
      "--claude-home", claudeHome,
      "--memorax-code-home", memoraxCodeHome,
      "--json",
    ], env);
    assert.equal(status.code, 1);
    assert.match(status.stderr, /--backend-url must be an http\(s\) URL/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent Claude mark-session commands preserve every registry update", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-claude-concurrent-registry-"));
  const claudeHome = join(root, "claude");
  const memoraxCodeHome = join(root, "memorax-code");
  const cliPath = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
  const sessionIds = Array.from({ length: 12 }, (_, index) => `marked-session-${index + 1}`);
  try {
    await mkdir(claudeHome, { recursive: true });
    const results = await Promise.all(sessionIds.map((sessionId) => runCli(cliPath, [
      "mark-session",
      "--claude-home", claudeHome,
      "--memorax-code-home", memoraxCodeHome,
      "--session-id", sessionId,
      "--title", `Session ${sessionId}`,
    ])));

    for (const result of results) assert.equal(result.code, 0, result.stderr);
    const registry = JSON.parse(await readFile(
      join(memoraxCodeHome, "adapters", "claude-code", "session-registry.json"),
      "utf8",
    ));
    assert.equal(Object.keys(registry.sessions).length, sessionIds.length);
    for (const sessionId of sessionIds) {
      assert.equal(registry.sessions[sessionId].claudeSessionId, sessionId);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("buildClaudeMarketplace generates an installable marketplace from adapter sources", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-claude-marketplace-"));
  const marketplaceRoot = join(root, "marketplace");
  try {
    const result = await buildClaudeMarketplace({ outputDir: marketplaceRoot });
    assert.equal(result.ok, true);
    assert.equal(result.pluginName, "memorax-code-claude-adapter");
    const marketplace = JSON.parse(await readFile(join(marketplaceRoot, ".claude-plugin", "marketplace.json"), "utf8"));
    assert.equal(marketplace.name, "memorax-code-local");
    assert.equal(marketplace.description, "MemoraX Code integration for Claude Code.");
    assert.equal(marketplace.plugins[0].displayName, "MemoraX Code");
    assert.equal(marketplace.plugins[0].description, "Connect Claude Code to MemoraX Code memory.");
    assert.equal(marketplace.plugins[0].source, "./plugins/memorax-code-claude-adapter");

    const pluginRoot = join(marketplaceRoot, "plugins", "memorax-code-claude-adapter");
    const sourcePlugin = JSON.parse(await readFile(new URL("../.claude-plugin/plugin.json", import.meta.url), "utf8"));
    assert.equal(sourcePlugin.description, "Memory skill and local hooks for MemoraX Code in Claude Code.");
    assert.equal("interface" in sourcePlugin, false);
    const generatedPlugin = JSON.parse(await readFile(join(pluginRoot, ".claude-plugin", "plugin.json"), "utf8"));
    assert.deepEqual(generatedPlugin, sourcePlugin);
    await assert.rejects(
      access(join(pluginRoot, "skills", "memorax-code", ".gitignore")),
      { code: "ENOENT" },
    );
    assert.equal(
      (await lstat(join(pluginRoot, "skills", "memorax-code"))).isSymbolicLink(),
      false,
    );
    const help = await runCli(join(pluginRoot, "src", "cli.mjs"), ["help"]);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /memorax-code-claude/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function runCli(cliPath, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], { env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
