import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  adapterStatePath,
  disableCodexAdapter,
  enableCodexAdapter,
  inspectCodexHistory,
  readAdapterState,
  readCodexAdapterStatus,
  readMergedCodexSessions,
  updateCodexSessionRegistry,
} from "../src/config.mjs";

const pluginRoot = fileURLToPath(new URL("..", import.meta.url));
const cliPath = join(pluginRoot, "src", "cli.mjs");

async function fixture(prefix = "memorax-code-codex-hooks-") {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const codexHome = join(root, "codex-home");
  const memoraxCodeHome = join(root, "memorax-code-home");
  await mkdir(codexHome, { recursive: true });
  await mkdir(memoraxCodeHome, { recursive: true });
  return { root, codexHome, memoraxCodeHome };
}

async function writeCachedPlugin(codexHome, name = "memorax-code") {
  const pluginRoot = join(
    codexHome,
    "plugins",
    "cache",
    "memorax-code",
    "memorax-code-codex-adapter",
    "0.1.0",
  );
  await mkdir(join(pluginRoot, ".codex-plugin"), { recursive: true });
  await writeFile(
    join(pluginRoot, ".codex-plugin", "plugin.json"),
    '{"name":"memorax-code-codex-adapter"}\n',
  );
  const skillsRoot = join(pluginRoot, "skills");
  await writePluginSkill(skillsRoot, name);
  return skillsRoot;
}

async function writePluginSkill(rootPath, name = "memorax-code") {
  const sourcePath = join(rootPath, name);
  await mkdir(sourcePath, { recursive: true });
  await writeFile(join(sourcePath, "SKILL.md"), `---\nname: ${name}\n---\n`);
  return sourcePath;
}

function runCli(args, env = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

async function readPngMetadata(relativePath) {
  const image = await readFile(join(pluginRoot, relativePath));
  assert.deepEqual(
    image.subarray(0, 8),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
  return {
    width: image.readUInt32BE(16),
    height: image.readUInt32BE(20),
    colorType: image[25],
  };
}

test("plugin package exposes the current Hook and memory entrypoints", async () => {
  const manifest = JSON.parse(await readFile(join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8"));
  const packageManifest = JSON.parse(await readFile(join(pluginRoot, "package.json"), "utf8"));
  assert.equal(manifest.version, packageManifest.version);
  assert.equal(manifest.author.name, "MemoraX AI");
  assert.equal(manifest.homepage, "https://code.memorax.net/");
  assert.equal(manifest.skills, "./skills/");
  assert.equal(manifest.hooks, "./hooks/hooks.json");
  assert.equal(manifest.interface.displayName, "MemoraX Code");
  assert.equal(manifest.interface.developerName, "MemoraX AI");
  assert.equal(manifest.interface.category, "Productivity");
  assert.deepEqual(manifest.interface.capabilities, ["Coding Memory"]);
  assert.equal(manifest.interface.websiteURL, "https://code.memorax.net/");
  assert.equal(manifest.interface.logo, "./assets/logo.png");
  assert.equal(manifest.interface.composerIcon, "./assets/composer-icon.png");
  assert.deepEqual(await readPngMetadata("assets/logo.png"), {
    width: 320,
    height: 320,
    colorType: 6,
  });
  assert.deepEqual(await readPngMetadata("assets/composer-icon.png"), {
    width: 64,
    height: 64,
    colorType: 6,
  });
  const hooks = JSON.parse(await readFile(join(pluginRoot, "hooks", "hooks.json"), "utf8"));
  const hookCommands = Object.values(hooks.hooks)
    .flatMap((groups) => groups)
    .flatMap((group) => group.hooks)
    .map((hook) => hook.command);
  assert.ok(hookCommands.includes('node "$PLUGIN_ROOT/hooks/runtime-hook.mjs" ensure-backend'));
  assert.ok(hookCommands.includes('node "$PLUGIN_ROOT/hooks/runtime-hook.mjs" memory-skill-reminder'));
  assert.ok(hookCommands.includes('node "$PLUGIN_ROOT/hooks/runtime-hook.mjs" memory-writeback'));
  await Promise.all([
    "ensure-backend",
    "memory-skill-reminder",
    "memory-writeback",
  ].map((component) => access(join(pluginRoot, "runtime-hooks", `${component}.mjs`))));
  const memorySkill = await readFile(join(pluginRoot, "skills", "memorax-code", "SKILL.md"), "utf8");
  assert.match(memorySkill, /name: memorax-code/);
});

for (const [provider, original] of [
  ["official", 'model_provider = "openai"\n'],
  ["custom", [
    'model_provider = "custom"',
    "[model_providers.custom]",
    'base_url = "https://provider.example/v1"',
    'wire_api = "responses"',
    "",
  ].join("\n")],
]) {
  test(`Hook adapter enable and disable preserve ${provider} Codex provider config`, async (t) => {
    const { root, codexHome, memoraxCodeHome } = await fixture();
    t.after(() => rm(root, { recursive: true, force: true }));
    const configPath = join(codexHome, "config.toml");
    await writeFile(configPath, original);
    await writeCachedPlugin(codexHome);

    const enabled = enableCodexAdapter({ codexHome, memoraxCodeHome });
    assert.equal(enabled.ok, true);
    assert.equal(enabled.enabled, true);
    assert.equal(enabled.integration, "hooks");
    assert.equal(enabled.state.integration, "hooks");
    assert.equal(enabled.state.enabled, true);
    assert.equal(await readFile(configPath, "utf8"), original);
    const disabled = disableCodexAdapter({ codexHome, memoraxCodeHome });
    assert.equal(disabled.ok, true);
    assert.equal(disabled.enabled, false);
    assert.equal(await readFile(configPath, "utf8"), original);
    const state = readAdapterState(adapterStatePath(memoraxCodeHome, "codex"));
    assert.equal(state.integration, "hooks");
    assert.equal(state.enabled, false);
  });
}

test("plugin delivery records plugin-managed skills without direct Codex skill links", async () => {
  const { root, codexHome, memoraxCodeHome } = await fixture();
  const skillsRoot = join(root, "plugin-skills");
  await writePluginSkill(skillsRoot);
  const result = enableCodexAdapter({
    codexHome,
    memoraxCodeHome,
    codexPluginSkillsRoot: skillsRoot,
  });
  assert.equal(result.ok, true);
  assert.equal(result.codexSkills.status, "plugin-managed");
  assert.equal(result.state.codexSkillDelivery, "plugin");
  assert.equal(result.state.codexPluginSkillsRoot, skillsRoot);
  assert.equal(result.state.codexSkillSourcePaths, undefined);
});

test("plugin delivery does not treat staging as active", async () => {
  const { codexHome, memoraxCodeHome } = await fixture();
  await writePluginSkill(join(
    codexHome,
    ".memorax-code",
    "plugins",
    "memorax-code-codex-adapter",
    "skills",
  ));

  const result = enableCodexAdapter({ codexHome, memoraxCodeHome });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "skill_delivery_failed");
  assert.equal(result.codexSkills.status, "missing");
});

test("plugin delivery rejects incomplete active cache artifacts", async () => {
  for (const variant of ["manifest-only", "skill-only"]) {
    const { codexHome, memoraxCodeHome } = await fixture();
    const pluginRoot = join(
      codexHome,
      "plugins",
      "cache",
      "memorax-code",
      "memorax-code-codex-adapter",
      "0.1.0",
    );
    if (variant === "manifest-only") {
      await mkdir(join(pluginRoot, ".codex-plugin"), { recursive: true });
      await writeFile(
        join(pluginRoot, ".codex-plugin", "plugin.json"),
        '{"name":"memorax-code-codex-adapter"}\n',
      );
    } else {
      await writePluginSkill(join(pluginRoot, "skills"));
    }

    const result = enableCodexAdapter({ codexHome, memoraxCodeHome });

    assert.equal(result.ok, false, variant);
    assert.equal(result.reason, "skill_delivery_failed", variant);
    assert.equal(result.codexSkills.status, "missing", variant);
  }
});

test("plugin delivery requires the memorax-code skill", async () => {
  const { codexHome, memoraxCodeHome } = await fixture();
  await writeCachedPlugin(codexHome, "unrelated-skill");

  const result = enableCodexAdapter({ codexHome, memoraxCodeHome });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "skill_delivery_failed");
  assert.equal(result.codexSkills.skills[0].name, "memorax-code");
  assert.equal(result.codexSkills.skills[0].sourceExists, false);
});

test("Hook adapter fails closed on unreadable adapter state", async () => {
  const { codexHome, memoraxCodeHome } = await fixture();
  const statePath = adapterStatePath(memoraxCodeHome, "codex");
  await mkdir(join(memoraxCodeHome, "adapters", "codex"), { recursive: true });
  await writeFile(statePath, "not-json\n");
  const result = enableCodexAdapter({ codexHome, memoraxCodeHome });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "state_unreadable");
  assert.equal(await readFile(statePath, "utf8"), "not-json\n");
});

test("status reports Hook readiness", async () => {
  const { codexHome, memoraxCodeHome } = await fixture();
  await writeCachedPlugin(codexHome);
  enableCodexAdapter({ codexHome, memoraxCodeHome });
  const status = readCodexAdapterStatus({ codexHome, memoraxCodeHome });
  assert.equal(status.ok, true);
  assert.equal(status.enabled, true);
  assert.equal(status.installed, true);
  assert.equal(status.integration, "hooks");
  assert.equal(status.backendUrlMatches, true);

  const mismatched = readCodexAdapterStatus({
    codexHome,
    memoraxCodeHome,
    backendUrl: "http://127.0.0.1:8877",
  });
  assert.equal(mismatched.configuredBackendUrl, "http://127.0.0.1:8787");
  assert.equal(mismatched.expectedBackendUrl, "http://127.0.0.1:8877");
  assert.equal(mismatched.backendUrlMatches, false);
});

test("status CLI describes shared Hooks", async () => {
  const { codexHome, memoraxCodeHome } = await fixture();
  await writeCachedPlugin(codexHome);
  enableCodexAdapter({ codexHome, memoraxCodeHome });
  const status = runCli(["status", "--codex-home", codexHome, "--memorax-code-home", memoraxCodeHome]);
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /status: ok/);
  assert.match(status.stdout, /integration: hooks/);
  assert.match(status.stdout, /provider config: unchanged \(Codex-owned\)/);
});

test("CLI help lists the current diagnostics", () => {
  const result = runCli(["--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /status\|doctor\|inspect-history/);
});

test("Codex diagnostics CLI rejects unknown commands", () => {
  const result = runCli(["unknown-command"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^unknown command: unknown-command\n$/);
});

test("native session inspection and registry remain outside Codex history", async () => {
  const { codexHome, memoraxCodeHome } = await fixture();
  const sessionsRoot = join(codexHome, "sessions", "2026", "07");
  await mkdir(sessionsRoot, { recursive: true });
  const transcriptPath = join(sessionsRoot, "session-a.jsonl");
  await writeFile(transcriptPath, '{"private":"transcript-content"}\n');

  const inspected = inspectCodexHistory({ codexHome, memoraxCodeHome });
  assert.equal(inspected.readOnly, true);
  assert.equal(inspected.native.sessionCount, 1);
  assert.equal(JSON.stringify(inspected).includes("transcript-content"), false);

  const marked = updateCodexSessionRegistry({
    codexHome,
    memoraxCodeHome,
    sessionId: "session-a",
    transcriptPath,
    workspace: join(codexHome, "workspace"),
  });
  assert.equal(marked.ok, true);
  assert.equal(marked.session.codexSessionId, "session-a");
  assert.equal(marked.session.transcriptPath, transcriptPath);
  const sessions = readMergedCodexSessions({ codexHome, memoraxCodeHome });
  assert.equal(sessions.ok, true);
  assert.equal(sessions.sessionCount, 1);
  assert.equal(sessions.sessions.length, 1);
  assert.equal(sessions.sessions[0].codexSessionId, "session-a");
  const printed = runCli(["sessions", "--codex-home", codexHome, "--memorax-code-home", memoraxCodeHome]);
  assert.equal(printed.status, 0, printed.stderr);
  assert.match(printed.stdout, /session count: 1/);
  assert.equal((await readFile(transcriptPath, "utf8")).includes("transcript-content"), true);
});

test("local Codex diagnostics ignore invalid Backend authority and malformed URL environment", async () => {
  const { root, codexHome, memoraxCodeHome } = await fixture("memorax-code-codex-local-invalid-authority-");
  const runtimeDir = join(memoraxCodeHome, "runtime", "backend");
  const env = {
    MEMORAX_CODE_BACKEND_URL: "not-a-url",
    MEMORAX_CODE_BACKEND_HOST: "",
    MEMORAX_CODE_BACKEND_PORT: "",
  };
  try {
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(join(runtimeDir, "backend-connection.json"), "{not-json\n");

    for (const args of [
      ["inspect-history", "--codex-home", codexHome, "--memorax-code-home", memoraxCodeHome, "--json"],
      ["sessions", "--codex-home", codexHome, "--memorax-code-home", memoraxCodeHome, "--json"],
      [
        "mark-session",
        "--codex-home", codexHome,
        "--memorax-code-home", memoraxCodeHome,
        "--session-id", "local-codex-session",
        "--json",
      ],
    ]) {
      const result = runCli(args, env);
      assert.equal(result.status, 0, `${args[0]}: ${result.stderr}`);
      assert.equal(JSON.parse(result.stdout).ok, true);
    }

    const status = runCli([
      "status",
      "--codex-home", codexHome,
      "--memorax-code-home", memoraxCodeHome,
      "--json",
    ], env);
    assert.equal(status.status, 1);
    assert.match(status.stderr, /--backend-url must be an http\(s\) URL/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent Codex mark-session commands preserve every registry update", async () => {
  const { root, codexHome, memoraxCodeHome } = await fixture("memorax-code-codex-concurrent-registry-");
  const sessionIds = Array.from({ length: 12 }, (_, index) => `marked-session-${index + 1}`);
  try {
    const results = await Promise.all(sessionIds.map((sessionId) => runCliAsync([
      "mark-session",
      "--codex-home", codexHome,
      "--memorax-code-home", memoraxCodeHome,
      "--session-id", sessionId,
      "--title", `Session ${sessionId}`,
    ])));

    for (const result of results) assert.equal(result.code, 0, result.stderr);
    const registry = JSON.parse(await readFile(
      join(memoraxCodeHome, "adapters", "codex", "session-registry.json"),
      "utf8",
    ));
    assert.equal(Object.keys(registry.sessions).length, sessionIds.length);
    for (const sessionId of sessionIds) {
      assert.equal(registry.sessions[sessionId].codexSessionId, sessionId);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function runCliAsync(args, env = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", rejectRun);
    child.on("close", (code) => resolveRun({ code, stdout, stderr }));
  });
}
