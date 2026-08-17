import { spawn } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isProcessAlive } from "../../../dist/lifecycle/backend/service.js";
import { buildClaudeMarketplace } from "../../../../memorax-code-claude-adapter/scripts/build-marketplace.mjs";
import { listen } from "../../support/helpers.mjs";
export async function prepareActiveCodexPlugin(codexHome, skillNames = ["memorax-code"]) {
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

export async function prepareClaudePluginCli(home) {
  const marketplacePath = join(home, "lib", "memorax-code-claude-marketplace");
  const adapterRoot = fileURLToPath(new URL("../../../../memorax-code-claude-adapter", import.meta.url));
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

export async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function writeManagedClientsConfig(home, { codex, claude, dsh = false, opencode = false }) {
  await mkdir(home, { recursive: true });
  await writeFile(join(home, "config.toml"), [
    "[clients]",
    `codex = ${codex}`,
    `claude = ${claude}`,
    `dsh = ${dsh}`,
    `opencode = ${opencode}`,
    "",
  ].join("\n"));
}

export async function prepareUnverifiedLifecycleState(activeClients) {
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

export function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

export function runCli(cliPath, args, options = {}) {
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

export async function waitForProcessExit(pid, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && isProcessAlive(pid)) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
