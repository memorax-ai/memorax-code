import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commandOnPath } from "../lib/vscode-extension-command.mjs";

const postinstallPath = fileURLToPath(new URL("../bin/memorax-code-plugin-postinstall.mjs", import.meta.url));
const adapterCommonSourceRoot = fileURLToPath(new URL(
  "../../../ts/memorax-code-adapter-common/src/",
  import.meta.url,
));
const codexAdapterSourceRoot = fileURLToPath(new URL(
  "../../../ts/memorax-code-codex-adapter/",
  import.meta.url,
));
const clientHookRuntimePath = fileURLToPath(new URL("../lib/client-hook-runtime.mjs", import.meta.url));
const codexRuntimeShellPath = fileURLToPath(new URL(
  "../../../ts/memorax-code-codex-adapter/hooks/runtime-shell.json",
  import.meta.url,
));
const claudeCommandResolverPath = fileURLToPath(new URL("../lib/resolve-claude-command.mjs", import.meta.url));
const codexCommandResolverPath = fileURLToPath(new URL("../lib/resolve-codex-command.mjs", import.meta.url));
const vscodeExtensionCommandPath = fileURLToPath(new URL("../lib/vscode-extension-command.mjs", import.meta.url));
const windowsCliInvocationPath = fileURLToPath(new URL("../lib/windows-cli-invocation.mjs", import.meta.url));
const smolTomlPath = fileURLToPath(new URL("../../../ts/memorax-code-backend/node_modules/smol-toml", import.meta.url));
const memoraxCodePluginId = "memorax-code-codex-adapter@memorax-code";

function pathWithoutCommand(command, pathValue) {
  return String(pathValue ?? "")
    .split(delimiter)
    .filter((root) => root && !commandOnPath(command, root, process.platform, process.env.PATHEXT))
    .join(delimiter);
}

function codexHook(name, currentHash, overrides = {}) {
  return {
    pluginId: memoraxCodePluginId,
    key: `${memoraxCodePluginId}:hooks/hooks.json:${name}`,
    currentHash,
    trustStatus: "untrusted",
    handlerType: "command",
    eventName: "sessionStart",
    command: `node \"$PLUGIN_ROOT/hooks/${name}.mjs\"`,
    statusMessage: `Running ${name}`,
    ...overrides,
  };
}

function tomlSectionText(text, section) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `[${section}]`);
  if (start === -1) return "";
  const end = lines.findIndex((line, index) => index > start && /^\s*\[/.test(line));
  return lines.slice(start, end === -1 ? undefined : end).join("\n");
}

function activeTomlSectionCount(text, section) {
  const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...text.matchAll(new RegExp(`^\\s*\\[${escaped}\\]\\s*(?:#.*)?$`, "gm"))].length;
}

function activeTomlSections(text) {
  return [...text.matchAll(/^\s*\[([^\]\r\n]+)\]\s*(?:#.*)?$/gm)]
    .map((match) => match[1])
    .sort();
}

async function startMockMemorax({ status = 200, body = { success: true, data: { items: [] } } } = {}) {
  const requests = [];
  const server = createServer((request, response) => {
    let requestBody = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { requestBody += chunk; });
    request.on("end", () => {
      requests.push({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: requestBody,
      });
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  return {
    requests,
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function runPostinstall({ existingCache = false, explicitCache = false, hookRuntimeFailure, failStartOnce = false, connectionAuthorityFailure = false, runtimeAuthorityFailureCode, officialMode = false, codexConfig, memoraxCodeConfig, memoraxCodeConfigMode, emptyClaudeSettings = false, claudeAvailable = true, claudeVersionFails = false, claudeSettingsText, codexAvailable = true, codexAppOnly = false, vscodeOnly = false, opencodeAvailable = false, opencodeXdgAvailable = false, opencodeCliAvailable = false, skipCodexPluginInstall = false, skipClaudeAdapterInstall = false, skipOpenCodeAdapterInstall = false, unavailableStatus = false, prefixedStatus = false, input = "", interactive = false, npmCommand = "install", memoraxVerify, memoraxEnv = {}, memoryStatusFixture, hookSnapshot = [], hookUpdatePlan = [], hookFullReview = false, hookFullReviewMissing = false, hookSnapshotFails = false, hookCheckFails = false, hookTrustFails = false, ttyOverride } = {}) {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-postinstall-"));
  const binDir = join(root, "bin");
  const codexHome = join(root, "codex-home");
  const claudeHome = join(root, "claude-home");
  const opencodeConfigDir = join(root, "opencode-config");
  const xdgConfigHome = join(root, "xdg-config");
  const memoraxCodeHome = join(root, "memorax-code-home");
  const home = join(root, "home");
  const fakeBin = join(root, "fake-bin");
  const libDir = join(root, "lib");
  const nodeModulesDir = join(root, "node_modules");
  const logPath = join(root, "commands.log");
  const memoraxServer = memoraxVerify ? await startMockMemorax(memoraxVerify) : undefined;
  await mkdir(binDir, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  if (process.platform !== "win32") await symlink(process.execPath, join(fakeBin, "node"));
  await mkdir(libDir, { recursive: true });
  await mkdir(nodeModulesDir, { recursive: true });
  await copyFile(postinstallPath, join(binDir, "memorax-code-plugin-postinstall.mjs"));
  const adapterCommonDir = join(libDir, "memorax-code-adapter-common", "src");
  await mkdir(adapterCommonDir, { recursive: true });
  for (const file of [
    "backend-connection.mjs",
    "hooks/capture-cwd-hook.mjs",
    "hooks/client-hook-launcher.mjs",
    "clients/codex-plugin-artifact.mjs",
    "config-utils.mjs",
    "hooks/ensure-backend-runner.mjs",
    "memorax-code-config-file.mjs",
    "hooks/hook-runtime-generation.mjs",
    "memorax-defaults.mjs",
    "hooks/memory-skill-reminder-hook.mjs",
    "repo-memory/repo-memory-auto-build.mjs",
    "repo-memory/repo-memory-job-context.mjs",
    "repo-memory/repo-procedure-memory-context.mjs",
    "repo-memory/repo-user-profile-context.mjs",
    "runtime-record.mjs",
  ]) {
    const target = join(adapterCommonDir, file);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(adapterCommonSourceRoot, file), target);
  }
  await copyFile(clientHookRuntimePath, join(libDir, "client-hook-runtime.mjs"));
  const codexAdapterDir = join(libDir, "memorax-code-codex-adapter");
  const claudeAdapterDir = join(libDir, "memorax-code-claude-adapter");
  for (const adapterDir of [codexAdapterDir, claudeAdapterDir]) {
    await mkdir(join(adapterDir, "src"), { recursive: true });
    await mkdir(join(adapterDir, "runtime-hooks"), { recursive: true });
    await writeFile(join(adapterDir, "src", "runtime-marker.mjs"), "export const runtimeMarker = 'A';\n");
    await writeFile(join(adapterDir, "runtime-hooks", "runtime-marker.mjs"), "export const runtimeMarker = 'A';\n");
  }
  for (const file of [
    "adapter-paths.mjs",
    "config-utils.mjs",
    "config.mjs",
    "session-registry.mjs",
  ]) {
    await copyFile(join(codexAdapterSourceRoot, "src", file), join(codexAdapterDir, "src", file));
  }
  await mkdir(join(codexAdapterDir, "hooks"), { recursive: true });
  await copyFile(codexRuntimeShellPath, join(codexAdapterDir, "hooks", "runtime-shell.json"));
  const codexShell = JSON.parse(await readFile(codexRuntimeShellPath, "utf8"));
  await mkdir(join(codexAdapterDir, ".codex-plugin"), { recursive: true });
  await writeFile(join(codexAdapterDir, ".codex-plugin", "plugin.json"), `${JSON.stringify({
    name: "memorax-code-codex-adapter",
    version: codexShell.shellVersion,
  })}\n`);
  for (const file of ["hooks.json", "runtime-hook.mjs", "hook-launcher.mjs"]) {
    await writeFile(join(codexAdapterDir, "hooks", file), "{}\n");
  }
  for (const component of [
    "capture-cwd",
    "ensure-backend",
    "memory-skill-reminder",
    "memory-writeback",
  ]) {
    await writeFile(
      join(codexAdapterDir, "runtime-hooks", `${component}.mjs`),
      `export const component = ${JSON.stringify(component)};\n`,
    );
  }
  for (const component of [
    "capture-cwd",
    "ensure-backend",
    "memory-cli-session",
    "memory-skill-reminder",
    "memory-turn",
  ]) {
    await writeFile(
      join(claudeAdapterDir, "runtime-hooks", `${component}.mjs`),
      `export const component = ${JSON.stringify(component)};\n`,
    );
  }
  await writeFile(join(root, "package.json"), `${JSON.stringify({
    name: "@memorax/memorax-code-test",
    version: "0.0.7-test",
    type: "module",
  }, null, 2)}\n`);
  await copyFile(claudeCommandResolverPath, join(libDir, "resolve-claude-command.mjs"));
  await copyFile(codexCommandResolverPath, join(libDir, "resolve-codex-command.mjs"));
  await copyFile(vscodeExtensionCommandPath, join(libDir, "vscode-extension-command.mjs"));
  await copyFile(windowsCliInvocationPath, join(libDir, "windows-cli-invocation.mjs"));
  await symlink(smolTomlPath, join(nodeModulesDir, "smol-toml"), "dir");
  await writeFile(join(binDir, "memorax-code.mjs"), [
    "#!/usr/bin/env node",
    "import { appendFileSync, existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    `appendFileSync(${JSON.stringify(logPath)}, 'memorax-code ' + process.argv.slice(2).join(' ') + '\\n');`,
    `if (process.argv[2] === 'codex-plugin') appendFileSync(${JSON.stringify(logPath)}, 'codex-runtime ' + (process.env.CODEX_CLI_PATH ?? '') + '\\n');`,
    "if (process.argv[2] === '--version') { console.log('memorax-code 0.1.1-test'); process.exit(0); }",
    `const hookSnapshot = ${JSON.stringify(hookSnapshot)};`,
    `const hookUpdatePlan = ${JSON.stringify(hookUpdatePlan)};`,
    "if (process.argv[2] === 'codex-plugin' && process.argv[3] === 'hooks') {",
    `  if (${JSON.stringify(hookSnapshotFails)}) process.exit(7);`,
    "  console.log(JSON.stringify({ ok: true, action: 'codex-plugin-hooks', hooks: hookSnapshot }));",
    "  process.exit(0);",
    "}",
    "if (process.argv[2] === 'codex-plugin' && process.argv[3] === 'trust-hooks') {",
    "  if (process.argv.includes('--check')) {",
    `    if (${JSON.stringify(hookCheckFails)}) process.exit(7);`,
    "    const hookCheckReport = { ok: true, action: 'codex-plugin-trust-hooks', hooks: hookUpdatePlan, trustedHooks: 0 };",
    `    if (!${JSON.stringify(hookFullReviewMissing)}) hookCheckReport.requiresFullReview = ${JSON.stringify(hookFullReview)};`,
    "    console.log(JSON.stringify(hookCheckReport));",
    "    process.exit(0);",
    "  }",
    `  appendFileSync(${JSON.stringify(logPath)}, 'hook-trust-selection ' + (process.env.MEMORAX_CODE_CODEX_HOOK_TRUST_SELECTION_JSON ?? '') + '\\n');`,
    `  if (${JSON.stringify(hookTrustFails)}) process.exit(7);`,
    "  console.log(JSON.stringify({ ok: true, action: 'codex-plugin-trust-hooks', hooks: hookUpdatePlan, trustedHooks: hookUpdatePlan.length }));",
    "  process.exit(0);",
    "}",
    `const failMarker = ${JSON.stringify(join(root, "failed-start-once"))};`,
    "if (process.argv[2] === 'start' && process.env.MEMORAX_CODE_TEST_RUNTIME_AUTHORITY_FAILURE) {",
    "  const code = process.env.MEMORAX_CODE_TEST_RUNTIME_AUTHORITY_FAILURE;",
    "  console.error('[MemoraX Code Backend]: Backend: not ok code=' + code + ' error=Backend runtime authority requires repair');",
    "  process.exit(7);",
    "}",
    "if (process.argv[2] === 'start' && process.env.MEMORAX_CODE_TEST_FAIL_START_ONCE === '1' && !existsSync(failMarker)) {",
    "  writeFileSync(failMarker, '1');",
    "  console.error('fake memorax-code start failure');",
    "  process.exit(7);",
    "}",
    "if (process.argv[2] === 'start') {",
    "  const preservedGeneration = process.env.MEMORAX_CODE_TEST_PRESERVED_HOOK_GENERATION;",
    "  if (preservedGeneration) {",
    "    const generationsRoot = join(process.env.MEMORAX_CODE_HOME, 'runtime', 'client-hooks', 'generations');",
    "    for (const generationId of readdirSync(generationsRoot)) {",
    "      if (generationId !== preservedGeneration) rmSync(join(generationsRoot, generationId, 'generation.json'), { force: true });",
    "    }",
    "  }",
    "  const pendingHookRuntime = process.env.MEMORAX_CODE_PENDING_CLIENT_HOOK_RUNTIME_V1;",
    "  if (pendingHookRuntime) {",
    "    try {",
    `      const runtime = await import(${JSON.stringify(pathToFileURL(join(
      adapterCommonDir,
      "hooks",
      "hook-runtime-generation.mjs",
    )).href)});`,
    "      const pending = JSON.parse(pendingHookRuntime);",
    "      runtime.activateClientHookRuntimeGeneration({",
    "        memoraxCodeHome: pending.memoraxCodeHome,",
    "        generation: pending.generation,",
    "      });",
    "    } catch (error) {",
    "      console.error('Client Hook runtime activation failed: ' + (error?.message ?? String(error)));",
    "      process.exit(7);",
    "    }",
    "  }",
    "  console.error('fake memorax-code start output');",
    "  if (process.env.MEMORAX_CODE_BACKEND_SUPPRESS_GUIDANCE === '1') console.error('suppressed guidance env seen');",
    "}",
    "if (process.argv[2] === 'stop') console.error('fake memorax-code stop output');",
    "const clientsIndex = process.argv.indexOf('--clients');",
    "const clientMode = clientsIndex >= 0 ? process.argv[clientsIndex + 1] : 'all';",
    "const selectedClients = new Set(clientMode === 'all' ? ['codex', 'claude', 'opencode'] : clientMode.split(','));",
    "const codexEnabled = selectedClients.has('codex');",
    "const claudeEnabled = selectedClients.has('claude');",
    "const opencodeEnabled = selectedClients.has('opencode');",
    "if (process.argv[2] === 'status' && process.env.MEMORAX_CODE_TEST_UNAVAILABLE_STATUS === '1') {",
    "  console.error('memorax-code: ok');",
    "  console.error('backend: ok http://127.0.0.1:8787 status=200');",
    "  console.error('codex adapter: not enabled integration=hooks');",
    "  if (claudeEnabled) console.error('claude adapter: ok integration=hooks skills=ok');",
    "  process.exit(0);",
    "}",
    "if (process.argv[2] === 'status') {",
    "  if (process.env.MEMORAX_CODE_TEST_PREFIXED_STATUS === '1') {",
    "    console.error('[MemoraX Code Backend]: MemoraX Code Backend status: \\x1b[34m\\x1b[1mEnabled\\x1b[0m');",
    "    console.error('[MemoraX Code Backend]: Backend status: \\x1b[34m\\x1b[1mEnabled\\x1b[0m http://127.0.0.1:8787 status=200');",
    "    if (codexEnabled) console.error('[MemoraX Code Backend]: Codex adapter: \\x1b[32mok\\x1b[0m integration=hooks skills=plugin-managed');",
    "    if (claudeEnabled) console.error('[MemoraX Code Backend]: Claude adapter: \\x1b[32mok\\x1b[0m integration=hooks skills=ok');",
    "    if (opencodeEnabled) console.error('[MemoraX Code Backend]: OpenCode adapter: \\x1b[32mok\\x1b[0m integration=plugin skills=ok');",
    "    process.exit(0);",
    "  }",
    "  console.error('memorax-code: ok');",
    "  console.error('backend: ok http://127.0.0.1:8787 status=200');",
    "  if (codexEnabled) console.error('codex adapter: ok integration=hooks skills=plugin-managed');",
    "  if (claudeEnabled) console.error('claude adapter: ok integration=hooks skills=ok');",
    "  if (opencodeEnabled) console.error('opencode adapter: ok integration=plugin skills=ok');",
    "}",
    "process.exit(0);",
    "",
  ].join("\n"), { mode: 0o755 });
  await writeFile(join(binDir, "memorax-cli.mjs"), [
    "#!/usr/bin/env node",
    "import { appendFileSync, readFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    `appendFileSync(${JSON.stringify(logPath)}, 'memorax-cli ' + process.argv.slice(2).join(' ') + '\\n');`,
    "if (process.argv[2] !== 'status' || !process.argv.includes('--config-only')) process.exit(2);",
    "if (process.env.MEMORAX_CODE_TEST_MEMORY_STATUS_OUTPUT !== undefined) {",
    "  process.stdout.write(process.env.MEMORAX_CODE_TEST_MEMORY_STATUS_OUTPUT);",
    "  process.exit(Number(process.env.MEMORAX_CODE_TEST_MEMORY_STATUS_EXIT_CODE ?? 0));",
    "}",
    "const { parse } = await import('smol-toml');",
    "let fileConfig = {};",
    "try { fileConfig = parse(readFileSync(join(process.env.MEMORAX_CODE_HOME, 'config.toml'), 'utf8')); } catch {}",
    "const apiKey = String(process.env.MEMORAX_CODE_MEMORAX_API_KEY ?? fileConfig.memorax?.api_key ?? '').trim();",
    "const userId = String(process.env.MEMORAX_CODE_MEMORAX_USER_ID ?? fileConfig.memorax?.user_id ?? '').trim();",
    "const configured = Boolean(apiKey && userId);",
    "const globalEnabled = process.env.MEMORAX_CODE_MEMORAX_WRITEBACK_ENABLED !== 'false';",
    "const directValue = process.env.MEMORAX_CODE_MEMORY_WRITEBACK_ENABLED ?? fileConfig.memory?.writeback?.enabled;",
    "const directConfigured = directValue === true || ['1', 'true', 'yes', 'on'].includes(String(directValue ?? '').toLowerCase());",
    "const maxTurns = Number(process.env.MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_MAX_TURNS ?? fileConfig.memory?.writeback?.buffer_max_turns ?? 8);",
    "const writebackEnabled = globalEnabled && directConfigured && maxTurns !== -1;",
    "console.log(JSON.stringify({",
    "  ok: configured,",
    "  action: 'memory.status',",
    "  provider: 'memory.memorax',",
    "  config: { configured, writeback: { globalEnabled, writebackEnabled } },",
    "  ...(configured ? {} : { error: 'MemoraX credentials are required' }),",
    "}));",
    "process.exit(configured ? 0 : 1);",
    "",
  ].join("\n"), { mode: 0o755 });
  if (codexAvailable) {
    await writeFile(join(fakeBin, "codex"), [
      "#!/usr/bin/env node",
      "import { appendFileSync } from 'node:fs';",
      `appendFileSync(${JSON.stringify(logPath)}, 'codex ' + process.argv.slice(2).join(' ') + '\\n');`,
      "if (process.argv[2] === '--version') console.log('codex 9.9.9-test');",
      "process.exit(0);",
      "",
    ].join("\n"), { mode: 0o755 });
    await chmod(join(fakeBin, "codex"), 0o755);
  }
  if (codexAppOnly) {
    const appCodex = process.platform === "win32"
      ? join(codexHome, "plugins", ".plugin-appserver", "codex.exe")
      : join(home, "Applications", "ChatGPT.app", "Contents", "Resources", "codex");
    await mkdir(dirname(appCodex), { recursive: true });
    if (process.platform === "win32") {
      await copyFile(process.execPath, appCodex);
    } else {
      await writeFile(appCodex, [
        "#!/usr/bin/env node",
        "import { appendFileSync } from 'node:fs';",
        `appendFileSync(${JSON.stringify(logPath)}, 'app-codex ' + process.argv.slice(2).join(' ') + '\\n');`,
        "if (process.argv[2] === '--version') console.log('codex-app 9.9.9-test');",
        "process.exit(0);",
        "",
      ].join("\n"), { mode: 0o755 });
      await chmod(appCodex, 0o755);
    }
  }
  if (vscodeOnly) {
    await writeMockVsCodeRuntimes({ home, logPath });
  }
  if (claudeAvailable) {
    await writeFile(join(fakeBin, "claude"), [
      "#!/usr/bin/env node",
      "import { appendFileSync } from 'node:fs';",
      `appendFileSync(${JSON.stringify(logPath)}, 'claude ' + process.argv.slice(2).join(' ') + '\\n');`,
      `if (process.argv[2] === '--version') { ${claudeVersionFails ? "console.error('broken Claude CLI'); process.exit(7);" : "console.log('claude 9.9.9-test');"} }`,
      "process.exit(0);",
      "",
    ].join("\n"), { mode: 0o755 });
    await chmod(join(fakeBin, "claude"), 0o755);
  }
  if (opencodeCliAvailable) {
    const executable = join(fakeBin, process.platform === "win32" ? "opencode.cmd" : "opencode");
    await writeFile(executable, "#!/usr/bin/env node\nprocess.exit(0);\n", { mode: 0o755 });
    await chmod(executable, 0o755);
  }
  const cacheMarketplace = existingCache ? "personal" : explicitCache ? "memorax-code" : undefined;
  if (cacheMarketplace) {
    const cacheDir = join(codexHome, "plugins", "cache", cacheMarketplace, "memorax-code-codex-adapter", "0.1.0");
    await mkdir(cacheDir, { recursive: true });
  }
  if (officialMode || codexConfig) {
    await mkdir(codexHome, { recursive: true });
    if (officialMode) await writeFile(join(codexHome, "auth.json"), `${JSON.stringify({ OPENAI_API_KEY: "auth-json-key" })}\n`);
    await writeFile(join(codexHome, "config.toml"), codexConfig ?? 'model_provider = "openai"\nmodel = "gpt-5.5"\n');
  }
  const initialMemoraxCodeConfig = memoraxCodeConfig ?? (npmCommand === "update"
    ? "[clients]\ncodex = true\nclaude = true\n"
    : undefined);
  if (initialMemoraxCodeConfig !== undefined) {
    await mkdir(memoraxCodeHome, { recursive: true });
    await writeFile(join(memoraxCodeHome, "config.toml"), initialMemoraxCodeConfig, "utf8");
    if (memoraxCodeConfigMode !== undefined) await chmod(join(memoraxCodeHome, "config.toml"), memoraxCodeConfigMode);
  }
  await mkdir(claudeHome, { recursive: true });
  const claudeSettings = emptyClaudeSettings
    ? {}
    : { env: { ANTHROPIC_BASE_URL: "https://api.anthropic.com", ANTHROPIC_API_KEY: "test-key" } };
  await writeFile(join(claudeHome, "settings.json"), claudeSettingsText ?? `${JSON.stringify(claudeSettings, null, 2)}\n`);
  if (opencodeAvailable) await mkdir(opencodeConfigDir, { recursive: true });
  if (opencodeXdgAvailable) await mkdir(join(xdgConfigHome, "opencode"), { recursive: true });

  let activeHookRuntimeBefore;
  if (hookRuntimeFailure) {
    await writeFile(join(root, "package.json"), `${JSON.stringify({
      name: "@memorax/memorax-code-test",
      version: "0.0.6-test",
      type: "module",
    }, null, 2)}\n`);
    const runtime = await import(pathToFileURL(join(
      adapterCommonDir,
      "hooks",
      "hook-runtime-generation.mjs",
    )).href);
    const generation = runtime.stageClientHookRuntimeGeneration({
      packageRoot: root,
      memoraxCodeHome,
    });
    activeHookRuntimeBefore = runtime.activateClientHookRuntimeGeneration({
      memoraxCodeHome,
      generation,
    });
    await writeFile(join(root, "package.json"), `${JSON.stringify({
      name: "@memorax/memorax-code-test",
      version: "0.0.7-test",
      type: "module",
    }, null, 2)}\n`);
    await writeFile(
      join(codexAdapterDir, "runtime-hooks", "runtime-marker.mjs"),
      "export const runtimeMarker = 'B';\n",
    );
    if (hookRuntimeFailure === "stage") {
      await rm(join(claudeAdapterDir, "runtime-hooks"), { recursive: true, force: true });
    }
  }

  const postinstallEntrypoint = ttyOverride
    ? join(root, "postinstall-runner.mjs")
    : join(binDir, "memorax-code-plugin-postinstall.mjs");
  if (ttyOverride) {
    await writeFile(postinstallEntrypoint, [
      `Object.defineProperty(process.stdin, "isTTY", { value: ${JSON.stringify(ttyOverride.stdin)} });`,
      `Object.defineProperty(process.stderr, "isTTY", { value: ${JSON.stringify(ttyOverride.stderr)} });`,
      'await import("./bin/memorax-code-plugin-postinstall.mjs");',
      "",
    ].join("\n"));
  }
  const childEnv = {
    ...process.env,
    ...(memoraxServer ? {
      MEMORAX_CODE_MEMORAX_ENDPOINT: memoraxServer.url,
    } : {}),
    CODEX_HOME: codexHome,
    HOME: home,
    CLAUDE_CONFIG_DIR: claudeHome,
    OPENCODE_CONFIG_DIR: opencodeAvailable ? opencodeConfigDir : "",
    XDG_CONFIG_HOME: opencodeXdgAvailable ? xdgConfigHome : "",
    MEMORAX_CODE_HOME: memoraxCodeHome,
    PATH: codexAppOnly || vscodeOnly
      ? fakeBin
      : `${fakeBin}${delimiter}${pathWithoutCommand("opencode", process.env.PATH)}`,
    npm_command: npmCommand,
    MEMORAX_CODE_NPM_POSTINSTALL_VERBOSE: "1",
    MEMORAX_CODE_NPM_POSTINSTALL_ASSUME_INTERACTIVE: interactive ? "1" : "0",
    MEMORAX_CODE_SKIP_CODEX_PLUGIN_INSTALL: skipCodexPluginInstall ? "1" : "0",
    MEMORAX_CODE_SKIP_CLAUDE_ADAPTER_INSTALL: skipClaudeAdapterInstall ? "1" : "0",
    MEMORAX_CODE_SKIP_OPENCODE_ADAPTER_INSTALL: skipOpenCodeAdapterInstall ? "1" : "0",
    MEMORAX_CODE_TEST_FAIL_START_ONCE: failStartOnce ? "1" : "0",
    MEMORAX_CODE_TEST_RUNTIME_AUTHORITY_FAILURE: runtimeAuthorityFailureCode
      ?? (connectionAuthorityFailure ? "BACKEND_CONNECTION_AUTHORITY_INVALID" : ""),
    MEMORAX_CODE_TEST_UNAVAILABLE_STATUS: unavailableStatus ? "1" : "0",
    MEMORAX_CODE_TEST_PREFIXED_STATUS: prefixedStatus ? "1" : "0",
    MEMORAX_CODE_TEST_PRESERVED_HOOK_GENERATION: hookRuntimeFailure === "activation"
      ? activeHookRuntimeBefore.generationId
      : "",
  };
  delete childEnv.CODEX_CLI_PATH;
  delete childEnv.MEMORAX_CODE_CODEX_COMMAND;
  delete childEnv.MEMORAX_CODE_CLAUDE_COMMAND;
  delete childEnv.MEMORAX_CODE_MEMORAX_API_KEY;
  delete childEnv.MEMORAX_CODE_MEMORAX_USER_ID;
  delete childEnv.MEMORAX_CODE_MEMORAX_WRITEBACK_ENABLED;
  delete childEnv.MEMORAX_CODE_MEMORY_WRITEBACK_ENABLED;
  delete childEnv.MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_MAX_TURNS;
  delete childEnv.MEMORAX_CODE_TEST_MEMORY_STATUS_OUTPUT;
  delete childEnv.MEMORAX_CODE_TEST_MEMORY_STATUS_EXIT_CODE;
  Object.assign(childEnv, memoraxEnv);
  if (memoryStatusFixture) {
    childEnv.MEMORAX_CODE_TEST_MEMORY_STATUS_OUTPUT = memoryStatusFixture.output;
    childEnv.MEMORAX_CODE_TEST_MEMORY_STATUS_EXIT_CODE = String(memoryStatusFixture.exitCode);
  }
  if (!claudeAvailable && !vscodeOnly) {
    childEnv.MEMORAX_CODE_CLAUDE_COMMAND = join(root, "missing-claude");
  }
  if (!codexAvailable && !codexAppOnly && !vscodeOnly) {
    childEnv.MEMORAX_CODE_CODEX_COMMAND = join(root, "missing-codex");
  }
  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, [postinstallEntrypoint], {
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.end(input);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  await memoraxServer?.close();
  const log = await readFile(logPath, "utf8").catch(() => "");
  return {
    root,
    result,
    log,
    memoraxCodeHome,
    codexHome,
    claudeHome,
    opencodeConfigDir,
    memoraxEndpoint: memoraxServer?.url,
    memoraxRequests: memoraxServer?.requests ?? [],
    activeHookRuntimeBefore,
  };
}

async function writeMockVsCodeRuntimes({ home, logPath }) {
  const targetPlatform = vscodeTargetPlatform();
  const extensionsRoot = join(home, ".vscode", "extensions");
  const codexRoot = join(extensionsRoot, `openai.chatgpt-9.9.9-${targetPlatform}`);
  const claudeRoot = join(extensionsRoot, `anthropic.claude-code-9.9.9-${targetPlatform}`);
  await mkdir(codexRoot, { recursive: true });
  await mkdir(claudeRoot, { recursive: true });
  await writeFile(join(codexRoot, "package.json"), `${JSON.stringify({
    publisher: "openai",
    name: "chatgpt",
    version: "9.9.9",
    __metadata: { targetPlatform },
  })}\n`);
  await writeFile(join(claudeRoot, "package.json"), `${JSON.stringify({
    publisher: "Anthropic",
    name: "claude-code",
    version: "9.9.9",
    __metadata: { targetPlatform },
  })}\n`);

  const codexCommand = join(codexRoot, "bin", codexVsCodePlatformDirectory(), process.platform === "win32" ? "codex.exe" : "codex");
  const claudeCommand = join(claudeRoot, "resources", "native-binary", process.platform === "win32" ? "claude.exe" : "claude");
  await mkdir(dirname(codexCommand), { recursive: true });
  await mkdir(dirname(claudeCommand), { recursive: true });
  if (process.platform === "win32") {
    await copyFile(process.execPath, codexCommand);
    await copyFile(process.execPath, claudeCommand);
    return;
  }
  await writeFile(codexCommand, [
    "#!/usr/bin/env node",
    "import { appendFileSync } from 'node:fs';",
    `appendFileSync(${JSON.stringify(logPath)}, 'vscode-codex ' + process.argv.slice(2).join(' ') + '\\n');`,
    "if (process.argv[2] === '--version') console.log('codex-vscode 9.9.9-test');",
    "process.exit(0);",
    "",
  ].join("\n"), { mode: 0o755 });
  await chmod(codexCommand, 0o755);
  await writeFile(claudeCommand, [
    "#!/usr/bin/env node",
    "import { appendFileSync } from 'node:fs';",
    `appendFileSync(${JSON.stringify(logPath)}, 'vscode-claude ' + process.argv.slice(2).join(' ') + '\\n');`,
    "if (process.argv[2] === '--version') console.log('claude-vscode 9.9.9-test');",
    "process.exit(0);",
    "",
  ].join("\n"), { mode: 0o755 });
  await chmod(claudeCommand, 0o755);
}

function vscodeTargetPlatform() {
  return `${process.platform}-${process.arch}`;
}

function codexVsCodePlatformDirectory() {
  if (process.platform === "darwin") return process.arch === "arm64" ? "macos-aarch64" : "macos-x86_64";
  if (process.platform === "linux") return process.arch === "arm64" ? "linux-aarch64" : "linux-x86_64";
  if (process.platform === "win32") return process.arch === "arm64" ? "windows-aarch64" : "windows-x86_64";
  return `${process.platform}-${process.arch}`;
}

test("postinstall updates an installed Codex plugin without remove/add", async () => {
  const run = await runPostinstall({ existingCache: true });
  try {
    assert.equal(run.result.code, 0, run.result.stderr);
    assert.match(run.log, /^memorax-code --version$/m);
    assert.match(run.log, /^codex --version$/m);
    assert.match(run.log, /^memorax-code codex-plugin install --json$/m);
    assert.equal((run.log.match(/^memorax-code codex-plugin install --json$/gm) ?? []).length, 1);
    assert.doesNotMatch(run.log, /^codex plugin (?:remove|add) /m);
    assert.match(run.log, /^memorax-code start --clients codex,claude$/m);
    assert.match(run.log, /^memorax-code status --clients codex,claude$/m);
    assert.match(run.result.stderr, /\[MemoraX Code Install\]: Checking local install state/);
    assert.match(run.result.stderr, /\[MemoraX Code Install\]: MemoraX Code backend package: memorax-code 0\.1\.1-test/);
    assert.match(run.result.stderr, /\[MemoraX Code Install\]: Existing Codex plugin cache: found \(0\.1\.0\)/);
    assert.match(run.result.stderr, /Starting backend with `memorax-code start`/);
    assert.match(run.result.stderr, /\[MemoraX Code Backend\]: fake memorax-code start output/);
    assert.match(run.result.stderr, /\[MemoraX Code Backend\]: suppressed guidance env seen/);
    assert.match(run.result.stderr, /Backend start completed/);
    assert.match(run.result.stderr, /\[MemoraX Code Install\]: Checking backend status with `memorax-code status`/);
    assert.match(run.result.stderr, /\[MemoraX Code Backend\]: codex adapter: ok integration=hooks skills=plugin-managed/);
    assert.match(run.result.stderr, /\[MemoraX Code Backend\]: claude adapter: ok integration=hooks skills=ok/);
    assert.match(run.result.stderr, /Backend status check completed/);
    assert.match(run.result.stderr, /Backend and selected adapters: .*Enabled/);
    assert.equal((run.result.stderr.match(/Backend and selected adapters:/g) ?? []).length, 1);
    assert.match(run.result.stderr, /Restart or refresh Codex or Claude Code/);
    assert.equal((run.result.stderr.match(/Restart or refresh Codex/g) ?? []).length, 1);
    assert.match(run.result.stderr, /enable the MemoraX Code Codex Adapter plugin/);
    assert.match(run.result.stderr, /--foreground-scripts/i);
    assert.match(run.result.stderr, /\[MemoraX Code Install\]: Common commands:/);
    for (const command of [
      "memorax-code status",
      "memorax-code start",
      "memorax-code stop",
      "memorax-code-codex sessions",
      "memorax-code-claude sessions",
    ]) {
      assert.match(run.result.stderr, new RegExp(`\`${command}\``));
    }
    for (const line of run.result.stderr.split(/\r?\n/).filter(Boolean)) {
      assert.match(line.replace(/\x1b\[[0-9;]*m/g, ""), /^\[MemoraX Code (?:Install|Backend)\]: /);
    }
    assert.equal(
      run.result.stderr.trim().split(/\r?\n/).at(-1),
      "[MemoraX Code Install]: View local memory activity: http://127.0.0.1:8787/memory-viewer",
    );
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("postinstall updates the explicit MemoraX Code marketplace without remove/add", async () => {
  const run = await runPostinstall({ explicitCache: true, npmCommand: "update" });
  try {
    assert.equal(run.result.code, 0, run.result.stderr);
    assert.match(run.result.stderr, /Existing Codex plugin cache: found \(0\.1\.0\)/);
    assert.match(run.log, /^memorax-code codex-plugin install --json$/m);
    assert.doesNotMatch(run.log, /^codex plugin (?:remove|add) /m);
    assert.equal(
      run.result.stderr.trim().split(/\r?\n/).at(-1),
      "[MemoraX Code Install]: View local memory activity: http://127.0.0.1:8787/memory-viewer",
    );
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("postinstall generation staging failure preserves the active runtime", async () => {
  const run = await runPostinstall({
    hookRuntimeFailure: "stage",
    npmCommand: "update",
  });
  try {
    assert.equal(run.result.code, 0, run.result.stderr);
    assert.match(run.result.stderr, /Client Hook runtime staging failed:/);
    assert.match(run.result.stderr, /previously active runtime remains authoritative/);
    assert.doesNotMatch(run.log, /^memorax-code (?:codex-plugin install|start|status)/m);
    const current = JSON.parse(await readFile(
      join(run.memoraxCodeHome, "runtime", "client-hooks", "current.json"),
      "utf8",
    ));
    assert.equal(current.generationId, run.activeHookRuntimeBefore.generationId);
    assert.equal(current.contentDigest, run.activeHookRuntimeBefore.contentDigest);
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("postinstall generation activation failure preserves the active runtime", async () => {
  const run = await runPostinstall({
    hookRuntimeFailure: "activation",
    npmCommand: "update",
  });
  try {
    assert.equal(run.result.code, 0, run.result.stderr);
    assert.match(run.log, /^memorax-code start --clients codex,claude$/m);
    assert.doesNotMatch(run.log, /^memorax-code (?:stop|status) --clients codex,claude$/m);
    assert.match(run.result.stderr, /Client Hook runtime activation failed:/);
    assert.match(run.result.stderr, /previously active runtime remains authoritative/);
    assert.match(run.result.stderr, /Backend and selected adapters: .*Not verified/);
    assert.doesNotMatch(run.result.stderr, /127\.0\.0\.1:8787\/memory-viewer/);
    const current = JSON.parse(await readFile(
      join(run.memoraxCodeHome, "runtime", "client-hooks", "current.json"),
      "utf8",
    ));
    assert.equal(current.generationId, run.activeHookRuntimeBefore.generationId);
    assert.equal(current.contentDigest, run.activeHookRuntimeBefore.contentDigest);
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("postinstall update offers a disabled client while refreshing unchanged Hooks", async () => {
  const oldConfig = [
    "# MemoraX Code local config.",
    "[clients]",
    "codex = true",
    "claude = false",
    "",
    "[custom]",
    "keep = true",
    "",
    "[memorax]",
    'endpoint = "https://custom-memorax.example"',
    "",
  ].join("\n");
  const run = await runPostinstall({
    existingCache: true,
    memoraxCodeConfig: oldConfig,
    interactive: true,
    input: "n\n",
    npmCommand: "update",
  });
  try {
    assert.equal(run.result.code, 0, run.result.stderr);
    assert.match(run.result.stderr, /Package update detected; refreshing MemoraX Code assets and checking client availability/);
    assert.doesNotMatch(run.result.stderr, /Configure MemoraX Code for which clients/);
    assert.doesNotMatch(run.result.stderr, /Connect MemoraX Code to MemoraX now/);
    assert.match(run.result.stderr, /Claude Code runtime is available, but its integration is disabled in \[clients\]\. Enable it now\? \[Y\/n\]/);
    assert.match(run.result.stderr, /Keeping the Claude Code integration disabled/);
    assert.doesNotMatch(run.result.stderr, /Activate and trust MemoraX Code Codex Adapter hooks now/);
    assert.doesNotMatch(run.result.stderr, /Trust these new or changed Codex Hooks/);
    assert.match(run.log, /^memorax-code codex-plugin hooks .*--json$/m);
    assert.match(run.log, /^memorax-code codex-plugin trust-hooks --check .*--json$/m);
    assert.doesNotMatch(run.log, /^memorax-code codex-plugin trust-hooks --yes /m);
    assert.match(run.log, /^memorax-code codex-plugin install --json$/m);
    assert.doesNotMatch(run.log, /^codex plugin (?:remove|add) /m);
    assert.match(run.log, /^memorax-code start --clients codex$/m);
    assert.match(run.log, /^memorax-code status --clients codex$/m);
    const config = await readFile(join(run.memoraxCodeHome, "config.toml"), "utf8");
    assert.match(config, /\[custom\]\nkeep = true/);
    assert.match(config, /\[memorax\]\nendpoint = "https:\/\/custom-memorax\.example"/);
    assert.doesNotMatch(config, /\[memory\.(?:retrieval|writeback|add|cli|repo_update)\]/);
    assert.doesNotMatch(config, /\[trace\.(?:codex|claude)\]/);
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("postinstall update defaults to trusting new Hooks on Enter and trusts only the reviewed selection", async () => {
  const existing = codexHook("existing", "sha256:existing", { trustStatus: "trusted" });
  const added = codexHook("repo-profile", "sha256:new");
  const run = await runPostinstall({
    existingCache: true,
    npmCommand: "update",
    interactive: true,
    input: "\n",
    hookSnapshot: [existing],
    hookUpdatePlan: [added],
  });
  try {
    assert.equal(run.result.code, 0, run.result.stderr);
    assert.match(run.result.stderr, /This MemoraX Code update includes new or changed Codex Hooks that require authorization/);
    assert.match(run.result.stderr, new RegExp(added.key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(run.result.stderr, /event: sessionStart/);
    assert.match(run.result.stderr, /command: node \"\$PLUGIN_ROOT\/hooks\/repo-profile\.mjs\"/);
    assert.match(run.result.stderr, /Trust these new or changed Codex Hooks\? \[Y\/n\]/);
    assert.match(run.result.stderr, /Trusted 1 new or changed MemoraX Code Codex Hook/);
    assert.match(run.log, /^memorax-code codex-plugin trust-hooks --yes .*--json$/m);
    const selectionLine = run.log.split(/\r?\n/).find((line) => line.startsWith("hook-trust-selection "));
    assert(selectionLine);
    assert.deepEqual(JSON.parse(selectionLine.slice("hook-trust-selection ".length)), [added]);
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("postinstall update keeps new Hooks untrusted when assumed-interactive stdin reaches EOF", async () => {
  const existing = codexHook("existing", "sha256:existing", { trustStatus: "trusted" });
  const added = codexHook("repo-profile", "sha256:new");
  const run = await runPostinstall({
    existingCache: true,
    npmCommand: "update",
    interactive: true,
    input: "",
    hookSnapshot: [existing],
    hookUpdatePlan: [added],
  });
  try {
    assert.equal(run.result.code, 0, run.result.stderr);
    assert.match(run.result.stderr, /No Hook authorization response was received/);
    assert.doesNotMatch(run.log, /^memorax-code codex-plugin trust-hooks --yes /m);
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("postinstall update keeps modified Hooks untrusted when authorization is declined", async () => {
  const previous = codexHook("declined", "sha256:before", { trustStatus: "trusted" });
  const changed = codexHook("declined", "sha256:after", { trustStatus: "modified" });
  const run = await runPostinstall({
    existingCache: true,
    npmCommand: "update",
    interactive: true,
    input: "n\n",
    hookSnapshot: [previous],
    hookUpdatePlan: [changed],
  });
  try {
    assert.equal(run.result.code, 0, run.result.stderr);
    assert.match(run.result.stderr, /Hook authorization was declined/);
    assert.match(run.result.stderr, /memorax-code codex-plugin trust-hooks/);
    assert.doesNotMatch(run.log, /^memorax-code codex-plugin trust-hooks --yes /m);
    assert.doesNotMatch(run.log, /^hook-trust-selection /m);
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("postinstall update warns without trusting new Hooks in non-interactive mode", async () => {
  const added = codexHook("non-interactive", "sha256:pending");
  const run = await runPostinstall({
    existingCache: true,
    npmCommand: "update",
    hookSnapshot: [],
    hookUpdatePlan: [added],
  });
  try {
    assert.equal(run.result.code, 0, run.result.stderr);
    assert.match(run.result.stderr, /running without an interactive terminal/);
    assert.match(run.result.stderr, new RegExp(added.key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(run.result.stderr, /memorax-code codex-plugin trust-hooks/);
    assert.doesNotMatch(run.log, /^memorax-code codex-plugin trust-hooks --yes /m);
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("postinstall update does not hide a Hook prompt when stderr is redirected", async () => {
  const added = codexHook("redirected-stderr", "sha256:redirected");
  const run = await runPostinstall({
    existingCache: true,
    npmCommand: "update",
    input: "y\n",
    ttyOverride: { stdin: true, stderr: false },
    hookSnapshot: [],
    hookUpdatePlan: [added],
  });
  try {
    assert.equal(run.result.code, 0, run.result.stderr);
    assert.match(run.result.stderr, /running without an interactive terminal/);
    assert.doesNotMatch(run.result.stderr, /Trust these new or changed Codex Hooks\?/);
    assert.doesNotMatch(run.log, /^memorax-code codex-plugin trust-hooks --yes /m);
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("postinstall update warns and succeeds when the pre-refresh Hook inspection fails", async () => {
  const run = await runPostinstall({
    existingCache: true,
    npmCommand: "update",
    hookSnapshotFails: true,
  });
  try {
    assert.equal(run.result.code, 0, run.result.stderr);
    assert.match(run.result.stderr, /could not be inspected before the plugin cache refresh/);
    assert.match(run.result.stderr, /memorax-code codex-plugin trust-hooks/);
    assert.doesNotMatch(run.log, /^memorax-code codex-plugin trust-hooks --yes /m);
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("postinstall update warns and succeeds when the refreshed Hook inspection fails", async () => {
  const run = await runPostinstall({
    existingCache: true,
    npmCommand: "update",
    hookSnapshot: [],
    hookCheckFails: true,
  });
  try {
    assert.equal(run.result.code, 0, run.result.stderr);
    assert.match(run.result.stderr, /could not be inspected after the plugin cache refresh/);
    assert.match(run.result.stderr, /memorax-code codex-plugin trust-hooks/);
    assert.doesNotMatch(run.log, /^memorax-code codex-plugin trust-hooks --yes /m);
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("postinstall update does not authorize malformed Hook trust reports", async (t) => {
  for (const { name, hook, hookFullReviewMissing = false } of [
    {
      name: "missing-command",
      hook: codexHook("missing-command", "sha256:missing-command", { command: undefined }),
    },
    {
      name: "missing-trust-status",
      hook: codexHook("missing-trust-status", "sha256:missing-trust-status", { trustStatus: undefined }),
    },
    {
      name: "unknown-trust-status",
      hook: codexHook("unknown-trust-status", "sha256:unknown-trust-status", { trustStatus: "future-status" }),
    },
    {
      name: "already-trusted-status",
      hook: codexHook("already-trusted-status", "sha256:already-trusted-status", { trustStatus: "trusted" }),
    },
    {
      name: "managed-status",
      hook: codexHook("managed-status", "sha256:managed-status", { trustStatus: "managed" }),
    },
    {
      name: "missing-full-review-flag",
      hook: codexHook("missing-full-review-flag", "sha256:missing-full-review-flag"),
      hookFullReviewMissing: true,
    },
  ]) {
    await t.test(name, async () => {
      const run = await runPostinstall({
        existingCache: true,
        npmCommand: "update",
        interactive: true,
        input: "y\n",
        hookSnapshot: [],
        hookUpdatePlan: [hook],
        hookFullReviewMissing,
      });
      try {
        assert.equal(run.result.code, 0, run.result.stderr);
        assert.match(run.result.stderr, /could not be inspected after the plugin cache refresh/);
        assert.doesNotMatch(run.result.stderr, /Trust these new or changed Codex Hooks\?/);
        assert.doesNotMatch(run.log, /^memorax-code codex-plugin trust-hooks --yes /m);
      } finally {
        await rm(run.root, { recursive: true, force: true });
      }
    });
  }
});

test("postinstall update requires a full review when the Hook marketplace identity changes", async () => {
  const added = codexHook("identity-change", "sha256:identity");
  const run = await runPostinstall({
    existingCache: true,
    npmCommand: "update",
    interactive: true,
    input: "y\n",
    hookSnapshot: [codexHook("old", "sha256:old", { pluginId: "memorax-code-codex-adapter@personal" })],
    hookUpdatePlan: [added],
    hookFullReview: true,
  });
  try {
    assert.equal(run.result.code, 0, run.result.stderr);
    assert.match(run.result.stderr, /marketplace identity changed/);
    assert.doesNotMatch(run.result.stderr, /Trust these new or changed Codex Hooks\?/);
    assert.doesNotMatch(run.log, /^memorax-code codex-plugin trust-hooks --yes /m);
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("postinstall update succeeds with Hooks untrusted when the reviewed batch cannot be written", async () => {
  const added = codexHook("write-failure", "sha256:write-failure");
  const run = await runPostinstall({
    existingCache: true,
    npmCommand: "update",
    interactive: true,
    input: "y\n",
    hookSnapshot: [],
    hookUpdatePlan: [added],
    hookTrustFails: true,
  });
  try {
    assert.equal(run.result.code, 0, run.result.stderr);
    assert.match(run.result.stderr, /changed again or could not be written/);
    assert.match(run.result.stderr, /memorax-code codex-plugin trust-hooks/);
    assert.match(run.log, /^memorax-code codex-plugin trust-hooks --yes .*--json$/m);
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("postinstall update offers a detected Claude runtime and preserves the Codex-only selection when declined", async () => {
  const run = await runPostinstall({
    existingCache: true,
    memoraxCodeConfig: [
      '["clients"] # Persisted Codex-only selection.',
      '"codex" = true # Keep the managed Codex choice.',
      "'claude' = false # Keep Claude outside this lifecycle.",
      "",
    ].join("\n"),
    interactive: true,
    input: "n\n",
    npmCommand: "update",
  });
  try {
    assert.equal(run.result.code, 0, run.result.stderr);
    assert.match(run.log, /^codex --version$/m);
    assert.match(run.log, /^claude --version$/m);
    assert.match(run.result.stderr, /Claude Code runtime is available, but its integration is disabled in \[clients\]\. Enable it now\? \[Y\/n\]/);
    assert.match(run.result.stderr, /Keeping the Claude Code integration disabled/);
    assert.match(run.log, /^memorax-code start --clients codex$/m);
    assert.match(run.log, /^memorax-code status --clients codex$/m);
    const config = await readFile(join(run.memoraxCodeHome, "config.toml"), "utf8");
    assert.match(config, /^"codex" = true # Keep the managed Codex choice\.$/m);
    assert.match(config, /^'claude' = false # Keep Claude outside this lifecycle\.$/m);
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("postinstall update defaults to enabling a detected Codex runtime on Enter", async () => {
  const run = await runPostinstall({
    input: "\ny\n",
    interactive: true,
    memoraxCodeConfig: [
      "[clients]",
      "codex = false",
      "claude = true",
      "",
    ].join("\n"),
    npmCommand: "update",
  });
  try {
    assert.equal(run.result.code, 0, run.result.stderr);
    assert.match(run.log, /^codex --version$/m);
    assert.match(run.log, /^claude --version$/m);
    assert.match(run.result.stderr, /Codex runtime is available, but its integration is disabled in \[clients\]\. Enable it now\? \[Y\/n\]/);
    assert.match(run.result.stderr, /Enabling the Codex integration/);
    assert.match(run.log, /^memorax-code codex-plugin install --json$/m);
    assert.match(run.result.stderr, /Activate and trust MemoraX Code Codex Adapter hooks now\? \[Y\/n\]/);
    assert.match(run.log, /^memorax-code codex-plugin activate --yes$/m);
    assert.match(run.log, /^memorax-code start --clients codex,claude$/m);
    assert.match(run.log, /^memorax-code status --clients codex,claude$/m);
    const config = await readFile(join(run.memoraxCodeHome, "config.toml"), "utf8");
    assert.match(config, /\[clients\]\nopencode = false\ncodex = true\nclaude = true/);
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("postinstall update keeps a detected disabled client unchanged when non-interactive", async () => {
  const run = await runPostinstall({
    memoraxCodeConfig: [
      "[clients]",
      "codex = false",
      "claude = true",
      "",
    ].join("\n"),
    npmCommand: "update",
  });
  try {
    assert.equal(run.result.code, 0, run.result.stderr);
    assert.match(run.log, /^codex --version$/m);
    assert.match(run.log, /^claude --version$/m);
    assert.match(run.result.stderr, /Codex runtime is available, but its integration remains disabled because this update cannot prompt/);
    assert.doesNotMatch(run.log, /^memorax-code codex-plugin install --json$/m);
    assert.match(run.log, /^memorax-code start --clients claude$/m);
    assert.match(run.log, /^memorax-code status --clients claude$/m);
    const config = await readFile(join(run.memoraxCodeHome, "config.toml"), "utf8");
    assert.match(config, /\[clients\]\nopencode = false\ncodex = false\nclaude = true/);
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("postinstall update lets each detected disabled client be selected independently", async () => {
  const run = await runPostinstall({
    input: "n\ny\n",
    interactive: true,
    memoraxCodeConfig: [
      "[clients]",
      "codex = false",
      "claude = false",
      "",
    ].join("\n"),
    npmCommand: "update",
  });
  try {
    assert.equal(run.result.code, 0, run.result.stderr);
    assert.match(run.result.stderr, /Codex runtime is available, but its integration is disabled in \[clients\]\. Enable it now\? \[Y\/n\]/);
    assert.match(run.result.stderr, /Keeping the Codex integration disabled/);
    assert.match(run.result.stderr, /Claude Code runtime is available, but its integration is disabled in \[clients\]\. Enable it now\? \[Y\/n\]/);
    assert.match(run.result.stderr, /Enabling the Claude Code integration/);
    assert.doesNotMatch(run.log, /^memorax-code codex-plugin install --json$/m);
    assert.match(run.log, /^memorax-code start --clients claude$/m);
    assert.match(run.log, /^memorax-code status --clients claude$/m);
    const config = await readFile(join(run.memoraxCodeHome, "config.toml"), "utf8");
    assert.match(config, /\[clients\]\nopencode = false\ncodex = false\nclaude = true/);
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("postinstall fresh install auto-detects Codex and skips an unavailable Claude runtime", async () => {
  const run = await runPostinstall({
    claudeAvailable: false,
  });
  try {
    assert.equal(run.result.code, 0, run.result.stderr);
    assert.doesNotMatch(run.result.stderr, /Configure MemoraX Code for which clients/);
    assert.match(run.log, /^codex --version$/m);
    assert.match(run.result.stderr, /Claude Code runtime was not detected; skipping its adapter setup/);
    assert.match(run.log, /^memorax-code codex-plugin install --json$/m);
    assert.match(run.log, /^memorax-code start --clients codex$/m);
    assert.match(run.log, /^memorax-code status --clients codex$/m);
    assert.match(run.result.stderr, /Backend and selected adapters: .*Enabled/);
    const config = await readFile(join(run.memoraxCodeHome, "config.toml"), "utf8");
    assert.match(config, /\[clients\][^\r\n]*\r?\ncodex = true[^\r\n]*\r?\nclaude = false[^\r\n]*\r?\nopencode = false/m);
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("postinstall detects OpenCode Desktop from its XDG config directory", async () => {
  const run = await runPostinstall({ opencodeXdgAvailable: true });
  try {
    assert.equal(run.result.code, 0, run.result.stderr);
    assert.match(run.result.stderr, /OpenCode configuration: found/);
    assert.match(run.result.stderr, /OpenCode CLI: not detected/);
    assert.match(run.log, /^memorax-code start --clients all$/m);
    assert.match(run.log, /^memorax-code status --clients all$/m);
    const config = await readFile(join(run.memoraxCodeHome, "config.toml"), "utf8");
    assert.match(tomlSectionText(config, "clients"), /^opencode = true(?:\s+#.*)?$/m);
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("postinstall detects OpenCode CLI without an existing config directory", async () => {
  const run = await runPostinstall({ opencodeCliAvailable: true });
  try {
    assert.equal(run.result.code, 0, run.result.stderr);
    assert.match(run.result.stderr, /OpenCode configuration: not detected/);
    assert.match(run.result.stderr, /OpenCode CLI: found in PATH/);
    assert.match(run.log, /^memorax-code start --clients all$/m);
    const config = await readFile(join(run.memoraxCodeHome, "config.toml"), "utf8");
    assert.match(tomlSectionText(config, "clients"), /^opencode = true(?:\s+#.*)?$/m);
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("postinstall detects OpenCode when Desktop configuration and CLI are both available", async () => {
  const run = await runPostinstall({ opencodeXdgAvailable: true, opencodeCliAvailable: true });
  try {
    assert.equal(run.result.code, 0, run.result.stderr);
    assert.match(run.result.stderr, /OpenCode configuration: found/);
    assert.match(run.result.stderr, /OpenCode CLI: found in PATH/);
    assert.match(run.log, /^memorax-code start --clients all$/m);
    const config = await readFile(join(run.memoraxCodeHome, "config.toml"), "utf8");
    assert.match(tomlSectionText(config, "clients"), /^opencode = true(?:\s+#.*)?$/m);
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("postinstall reinstall re-detects a newly available Claude runtime", async () => {
  const run = await runPostinstall({
    memoraxCodeConfig: [
      "[clients]",
      "codex = true",
      "claude = false",
      "",
    ].join("\n"),
  });
  try {
    assert.equal(run.result.code, 0, run.result.stderr);
    assert.match(run.log, /^codex --version$/m);
    assert.match(run.log, /^claude --version$/m);
    assert.match(run.result.stderr, /Detected supported client runtimes\. Configuring MemoraX Code for Codex and Claude Code\./);
    assert.match(run.log, /^memorax-code start --clients codex,claude$/m);
    assert.match(run.log, /^memorax-code status --clients codex,claude$/m);
    const config = await readFile(join(run.memoraxCodeHome, "config.toml"), "utf8");
    assert.match(config, /\[clients\]\nopencode = false\ncodex = true\nclaude = true/);
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("postinstall update re-detects a legacy empty client selection", async () => {
  const run = await runPostinstall({
    claudeAvailable: false,
    input: "y\ny\n",
    interactive: true,
    memoraxCodeConfig: [
      "[clients]",
      "codex = false",
      "claude = false",
      "",
    ].join("\n"),
    npmCommand: "update",
  });
  try {
    assert.equal(run.result.code, 0, run.result.stderr);
    assert.match(run.log, /^codex --version$/m);
    assert.match(run.result.stderr, /Claude Code runtime was not detected; skipping its adapter setup/);
    assert.match(run.result.stderr, /Codex runtime is available, but its integration is disabled in \[clients\]\. Enable it now\? \[Y\/n\]/);
    assert.match(run.result.stderr, /Enabling the Codex integration/);
    assert.match(run.log, /^memorax-code codex-plugin install --json$/m);
    assert.match(run.result.stderr, /Activate and trust MemoraX Code Codex Adapter hooks now\? \[Y\/n\]/);
    assert.match(run.log, /^memorax-code codex-plugin activate --yes$/m);
    assert.doesNotMatch(run.log, /^memorax-code codex-plugin hooks .*--json$/m);
    assert.doesNotMatch(run.log, /^memorax-code codex-plugin trust-hooks /m);
    assert.match(run.log, /^memorax-code start --clients codex$/m);
    assert.match(run.log, /^memorax-code status --clients codex$/m);
    const config = await readFile(join(run.memoraxCodeHome, "config.toml"), "utf8");
    assert.match(config, /\[clients\]\nopencode = false\ncodex = true\nclaude = false/);
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("postinstall update preserves client intent while skipping an uninstalled Claude runtime", async () => {
  const run = await runPostinstall({
    claudeAvailable: false,
    memoraxCodeConfig: [
      "[clients]",
      "codex = true",
      "claude = true",
      "",
    ].join("\n"),
    npmCommand: "update",
  });
  try {
    assert.equal(run.result.code, 0, run.result.stderr);
    assert.match(run.result.stderr, /Claude Code runtime was not detected; skipping its adapter setup/);
    assert.match(run.log, /^memorax-code start --clients codex$/m);
    assert.match(run.log, /^memorax-code status --clients codex$/m);
    assert.doesNotMatch(run.result.stderr, /Backend and selected adapters: Not verified/);
    const config = await readFile(join(run.memoraxCodeHome, "config.toml"), "utf8");
    assert.match(config, /\[clients\]\nopencode = false\ncodex = true\nclaude = true/);
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("postinstall recognizes prefixed human-readable memorax-code status output", async () => {
  const run = await runPostinstall({ prefixedStatus: true });
  try {
    assert.equal(run.result.code, 0, run.result.stderr);
    assert.match(run.log, /^memorax-code status --clients codex,claude$/m);
    assert.match(run.result.stderr, /\[MemoraX Code Backend\]: Codex adapter: .*ok.* integration=hooks skills=plugin-managed/);
    assert.match(run.result.stderr, /Backend and selected adapters: .*Enabled/);
    assert.doesNotMatch(run.result.stderr, /\[MemoraX Code Backend\]: Backend and selected adapters:/);
    assert.match(run.result.stderr, /Restart or refresh Codex or Claude Code/);
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("postinstall auto-detected Claude-only setup does not inspect Codex login state", async () => {
  const run = await runPostinstall({
    officialMode: true,
    codexAvailable: false,
    interactive: true,
    input: "n\n",
  });
  try {
    assert.equal(run.result.code, 0, run.result.stderr);
    assert.doesNotMatch(run.log, /^codex /m);
    assert.doesNotMatch(run.result.stderr, /Codex login mode:/);
    assert.doesNotMatch(run.result.stderr, /Configure MemoraX Code for which clients/);
    assert.match(run.result.stderr, /Configuring MemoraX Code for Claude Code only/);
    assert.match(run.result.stderr, /Keeping Claude Code provider config unchanged and enabling the shared memory Hook integration/);
    assert.doesNotMatch(run.log, /^memorax-code codex-plugin install --json$/m);
    assert.doesNotMatch(run.log, /^codex plugin remove memorax-code-codex-adapter@personal$/m);
    assert.match(run.log, /^memorax-code start --clients claude$/m);
    assert.match(run.log, /^memorax-code status --clients claude$/m);
    assert.match(run.result.stderr, /Backend and selected adapters: .*Enabled/);
    assert.match(run.result.stderr, /Restart or refresh Claude Code/);
    assert.doesNotMatch(run.result.stderr, /enable the MemoraX Code Codex Adapter plugin/);
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("postinstall skip for Codex plugin still starts backend for Claude Code", async () => {
  const run = await runPostinstall({ skipCodexPluginInstall: true });
  try {
    assert.equal(run.result.code, 0, run.result.stderr);
    assert.match(run.result.stderr, /Codex plugin registration is disabled for this npm postinstall/);
    assert.doesNotMatch(run.log, /^memorax-code codex-plugin install --json$/m);
    assert.doesNotMatch(run.log, /^codex plugin remove memorax-code-codex-adapter@personal$/m);
    assert.match(run.log, /^memorax-code start --clients claude$/m);
    assert.match(run.log, /^memorax-code status --clients claude$/m);
    assert.match(run.result.stderr, /\[MemoraX Code Backend\]: claude adapter: ok integration=hooks skills=ok/);
    assert.match(run.result.stderr, /Backend and selected adapters: .*Enabled/);
    assert.match(run.result.stderr, /Restart or refresh Claude Code/);
    assert.doesNotMatch(run.result.stderr, /enable the MemoraX Code Codex Adapter plugin/);
    assert.doesNotMatch(run.log, /^codex /m);
    const config = await readFile(join(run.memoraxCodeHome, "config.toml"), "utf8");
    assert.match(config, /\[clients\][^\r\n]*\r?\ncodex = false[^\r\n]*\r?\nclaude = true[^\r\n]*\r?\nopencode = false/m);
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("postinstall uses the same Claude Hook lifecycle without explicit provider settings", async () => {
  const run = await runPostinstall({ emptyClaudeSettings: true });
  try {
    assert.equal(run.result.code, 0, run.result.stderr);
    assert.doesNotMatch(run.result.stderr, /Claude Code login mode:|official login|provider\/API key mode/);
    assert.match(run.result.stderr, /Keeping Claude Code provider config unchanged and enabling the shared memory Hook integration/);
    assert.match(run.log, /^memorax-code codex-plugin install --json$/m);
    assert.match(run.log, /^memorax-code start --clients codex,claude$/m);
    assert.match(run.log, /^memorax-code status --clients codex,claude$/m);
    assert.match(run.result.stderr, /\[MemoraX Code Backend\]: codex adapter: ok integration=hooks skills=plugin-managed/);
    assert.match(run.result.stderr, /\[MemoraX Code Backend\]: claude adapter: ok integration=hooks skills=ok/);
    assert.match(run.result.stderr, /Backend and selected adapters: .*Enabled/);
    assert.match(run.result.stderr, /Restart or refresh Codex/);
    assert.match(run.result.stderr, /enable the MemoraX Code Codex Adapter plugin/);
    assert.match(run.result.stderr, /run `memorax-code status`, `memorax-code-codex status`, and `memorax-code-claude status`/);
    assert.equal(await readFile(join(run.claudeHome, "settings.json"), "utf8"), "{}\n");
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("postinstall env can explicitly skip Claude Code adapter setup", async () => {
  const run = await runPostinstall({ skipClaudeAdapterInstall: true });
  try {
    assert.equal(run.result.code, 0, run.result.stderr);
    assert.match(run.result.stderr, /Claude Code adapter setup is disabled for this npm postinstall/);
    assert.match(run.log, /^memorax-code codex-plugin install --json$/m);
    assert.match(run.log, /^memorax-code start --clients codex$/m);
    assert.match(run.log, /^memorax-code status --clients codex$/m);
    assert.match(run.result.stderr, /\[MemoraX Code Backend\]: codex adapter: ok integration=hooks skills=plugin-managed/);
    assert.doesNotMatch(run.result.stderr, /\[MemoraX Code Backend\]: claude adapter: ok integration=hooks skills=ok/);
    assert.match(run.result.stderr, /Restart or refresh Codex/);
    assert.match(run.result.stderr, /run `memorax-code status` and `memorax-code-codex status`/);
    const config = await readFile(join(run.memoraxCodeHome, "config.toml"), "utf8");
    assert.match(config, /\[clients\][^\r\n]*\r?\ncodex = true[^\r\n]*\r?\nclaude = false[^\r\n]*\r?\nopencode = false/m);
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("postinstall skips one non-runnable detected client without blocking the other", async () => {
  const run = await runPostinstall({ claudeVersionFails: true });
  try {
    assert.equal(run.result.code, 0, run.result.stderr);
    assert.match(run.log, /^codex --version$/m);
    assert.match(run.log, /^claude --version$/m);
    assert.match(run.result.stderr, /Claude Code runtime was not detected; skipping its adapter setup/);
    assert.match(run.result.stderr, /Backend and selected adapters: .*Enabled/);
    assert.match(run.log, /^memorax-code start --clients codex$/m);
    assert.match(run.log, /^memorax-code status --clients codex$/m);
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("postinstall enables Codex shared Hooks without inspecting the Codex login mode", async () => {
  const run = await runPostinstall({
    officialMode: true,
    emptyClaudeSettings: true,
    claudeAvailable: false,
    interactive: true,
    input: "n\nn\n",
  });
  try {
    assert.equal(run.result.code, 0, run.result.stderr);
    assert.doesNotMatch(run.result.stderr, /Codex login mode:/);
    assert.doesNotMatch(run.result.stderr, /Claude Code login mode:/);
    assert.match(run.result.stderr, /Configuring MemoraX Code for Codex only/);
    assert.match(run.result.stderr, /enabling the shared memory hook integration/);
    assert.match(run.log, /^memorax-code codex-plugin install --json$/m);
    assert.match(run.log, /^memorax-code start --clients codex$/m);
    assert.match(run.log, /^memorax-code status --clients codex$/m);
    assert.match(run.result.stderr, /Restart or refresh Codex/);
    assert.match(run.result.stderr, /enable the MemoraX Code Codex Adapter plugin/);
    assert.match(run.result.stderr, /memorax-code-codex status/);
    assert.doesNotMatch(run.result.stderr, /memorax-code-claude status/);
    assert.match(run.result.stderr, /memorax-code-codex sessions/);
    assert.doesNotMatch(run.result.stderr, /memorax-code-claude sessions/);
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("postinstall uses the same Codex Hook lifecycle for a custom provider config", async () => {
  const codexConfig = [
    'model_provider = "custom.openai"',
    'model = "gpt-5.5"',
    "",
    '[model_providers."custom.openai"]',
    'base_url = "http://127.0.0.1:9999/openai/v1"',
    'wire_api = "responses"',
    "requires_openai_auth = true",
    "",
  ].join("\n");
  const run = await runPostinstall({
    codexConfig,
    claudeAvailable: false,
    interactive: true,
    input: "n\nn\n",
  });
  try {
    assert.equal(run.result.code, 0, run.result.stderr);
    assert.doesNotMatch(run.result.stderr, /Codex login mode:/);
    assert.match(run.result.stderr, /enabling the shared memory hook integration/);
    assert.match(run.log, /^memorax-code codex-plugin install --json$/m);
    assert.match(run.log, /^memorax-code start --clients codex$/m);
    assert.match(run.log, /^memorax-code status --clients codex$/m);
    assert.equal(await readFile(join(run.codexHome, "config.toml"), "utf8"), codexConfig);
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("postinstall does not auto-install Codex plugin when no cache exists yet", async () => {
  const run = await runPostinstall({ existingCache: false });
  try {
    assert.equal(run.result.code, 0, run.result.stderr);
    assert.match(run.log, /^memorax-code --version$/m);
    assert.match(run.log, /^codex --version$/m);
    assert.match(run.log, /^memorax-code codex-plugin install --json$/m);
    assert.doesNotMatch(run.log, /^codex plugin remove memorax-code-codex-adapter@personal$/m);
    assert.doesNotMatch(run.log, /^codex plugin add memorax-code-codex-adapter@personal$/m);
    assert.match(run.log, /^memorax-code start --clients codex,claude$/m);
    assert.match(run.log, /^memorax-code status --clients codex,claude$/m);
    assert.match(run.result.stderr, /\[MemoraX Code Install\]: Existing Codex plugin cache: not installed/i);
    assert.match(run.result.stderr, /Restart or refresh Codex or Claude Code/i);
    assert.match(run.result.stderr, /--foreground-scripts/i);
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("postinstall uses the Codex App bundled runtime when no standalone CLI is installed", async () => {
  const run = await runPostinstall({
    codexAvailable: false,
    codexAppOnly: true,
    claudeAvailable: false,
    interactive: true,
    input: "n\ny\n",
  });
  try {
    assert.equal(run.result.code, 0, run.result.stderr);
    assert.match(
      run.result.stderr,
      process.platform === "win32"
        ? /Codex App runtime: v\d+\./
        : /Codex App runtime: codex-app 9\.9\.9-test/,
    );
    if (process.platform !== "win32") assert.match(run.log, /^app-codex --version$/m);
    assert.doesNotMatch(run.log, /^codex --version$/m);
    assert.match(run.log, /^memorax-code codex-plugin install --json$/m);
    assert.match(run.log, /^memorax-code codex-plugin activate --yes$/m);
    const expectedRuntime = process.platform === "win32"
      ? join(run.codexHome, "plugins", ".plugin-appserver", "codex.exe")
      : join(run.root, "home", "Applications", "ChatGPT.app", "Contents", "Resources", "codex");
    assert.match(run.log, new RegExp(`^codex-runtime ${expectedRuntime.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
    assert.match(run.log, /^memorax-code start --clients codex$/m);
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("postinstall accepts VS Code bundled runtimes when no standalone CLI is installed", async () => {
  const run = await runPostinstall({
    codexAvailable: false,
    claudeAvailable: false,
    vscodeOnly: true,
  });
  try {
    assert.equal(run.result.code, 0, run.result.stderr);
    assert.match(run.result.stderr, /Codex (?:App|VS Code) runtime: /);
    assert.match(run.result.stderr, /Claude VS Code runtime: /);
    assert.doesNotMatch(run.result.stderr, /setup was selected but no .* runtime is runnable/);
    assert.match(run.log, /^memorax-code codex-plugin install --json$/m);
    assert.match(run.log, /^memorax-code start --clients codex,claude$/m);
    assert.match(run.log, /^memorax-code status --clients codex,claude$/m);
    if (process.platform !== "win32") {
      assert.match(run.log, /^vscode-claude --version$/m);
      if (/Codex VS Code runtime: /.test(run.result.stderr)) {
        assert.match(run.log, /^vscode-codex --version$/m);
        assert.match(run.log, /codex-runtime .*[/\\]\.vscode[/\\]extensions[/\\]openai\.chatgpt-9\.9\.9-/);
      }
    }
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("postinstall seeds default MemoraX Code config on first install when memory setup is skipped", async () => {
  const run = await runPostinstall({ interactive: true, input: "n\nn\n" });
  try {
    assert.equal(run.result.code, 0, run.result.stderr);
    assert.match(run.result.stderr, /MemoraX Code requires MemoraX for its core remote-memory functionality/);
    assert.match(run.result.stderr, /MemoraX memory: Not configured/);
    assert.match(run.result.stderr, /Package installed, MemoraX not configured/);
    const config = await readFile(join(run.memoraxCodeHome, "config.toml"), "utf8");
    assert.doesNotMatch(config, /profile\s*=/);
    assert.doesNotMatch(config, /\[memory\]\s|provider\s*=/);
    assert.match(config, /\[memory\.retrieval\]/);
    assert.match(config, /enabled = false # Auto-inject retrieved memories into supported client prompts\./);
    assert.match(config, /\[memory\.writeback\]/);
    assert.match(config, /enabled = true # Allow supported client sessions to write memories after replies\./);
    assert.match(config, /\[memory\.add\]\r?\noutput_language = "zh" # Language for newly generated MemoraX memories\./);
    assert.match(config, /\[memory\.skill_reminder\]/);
    assert.match(config, /interval_turns = 5 # Show the MemoraX Code skill reminder every N native client turns, starting on the first turn\./);
    assert.match(config, /\[memory\.repo_update\]/);
    assert.match(config, /policy = "adaptive" # every-commit \/ commit-count \/ daily \/ pull-request \/ pull-request-or-daily \/ adaptive\./);
    assert.match(config, /commit_threshold = 5 # Pending local commits needed by commit-count and adaptive\./);
    assert.match(config, /cooldown_hours = 24 # Pending-commit age used by daily, pull-request-or-daily, and adaptive\./);
    assert.match(config, /\[trace\.codex\]/);
    assert.match(config, /capture_content = true # Store content in local Codex trace events\./);
    assert.match(config, /\[trace\.claude\]/);
    assert.match(config, /enabled = true # Enable local Claude session memory trace collection\./);
    assert.match(config, /capture_content = true # Store content in local Claude trace events\./);
    assert.match(config, /\[trace\.opencode\]/);
    assert.match(config, /capture_content = true # Store content in local OpenCode trace events\./);
    assert.deepEqual(activeTomlSections(config), [
      "clients",
      "memorax",
      "memory.add",
      "memory.repo_update",
      "memory.retrieval",
      "memory.skill_reminder",
      "memory.writeback",
      "trace.claude",
      "trace.codex",
      "trace.opencode",
    ]);
    assert.doesNotMatch(
      config,
      /top_k|k_dense|k_sparse|min_score|max_context_chars|max_item_chars|buffer_|chunk_|max_message_chars|timeout_ms|retention_days|max_event_chars|max_file_bytes/,
    );
    assert.equal((await stat(join(run.memoraxCodeHome, "config.toml"))).mode & 0o777, 0o600);
    if (process.platform !== "win32") {
      assert.equal((await stat(run.memoraxCodeHome)).mode & 0o777, 0o700);
    }
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("postinstall can configure only Claude Code", async () => {
  const codexConfig = '# preserve these Codex bytes\r\nmodel_provider = "custom"\r\n';
  const claudeSettingsText = '{\r\n  "env": { "ANTHROPIC_BASE_URL": "https://api.anthropic.com", "ANTHROPIC_API_KEY": "direct-key" }\r\n}\r\n';
  const run = await runPostinstall({
    codexConfig,
    claudeSettingsText,
    codexAvailable: false,
    interactive: true,
    input: "n\n",
  });
  try {
    assert.equal(run.result.code, 0, run.result.stderr);
    assert.doesNotMatch(run.result.stderr, /Configure MemoraX Code for which clients/);
    assert.match(run.result.stderr, /Configuring MemoraX Code for Claude Code only/);
    assert.match(run.result.stderr, /Keeping Claude Code provider config unchanged and enabling the shared memory Hook integration/);
    assert.doesNotMatch(run.log, /^memorax-code codex-plugin install --json$/m);
    assert.match(run.log, /^memorax-code start --clients claude$/m);
    assert.match(run.log, /^memorax-code status --clients claude$/m);
    assert.match(run.result.stderr, /Restart or refresh Claude Code/);
    assert.doesNotMatch(run.result.stderr, /enable the MemoraX Code Codex Adapter plugin/);
    assert.equal(await readFile(join(run.codexHome, "config.toml"), "utf8"), codexConfig);
    assert.equal(await readFile(join(run.claudeHome, "settings.json"), "utf8"), claudeSettingsText);
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("postinstall can configure only Codex", async () => {
  const claudeSettingsText = '{\r\n  "preserve": "these Claude bytes"\r\n}\r\n';
  const run = await runPostinstall({
    claudeSettingsText,
    claudeAvailable: false,
    interactive: true,
    input: "n\ny\n",
  });
  try {
    assert.equal(run.result.code, 0, run.result.stderr);
    assert.doesNotMatch(run.result.stderr, /Configure MemoraX Code for which clients/);
    assert.match(run.result.stderr, /Configuring MemoraX Code for Codex only/);
    assert.match(run.log, /^memorax-code codex-plugin install --json$/m);
    assert.match(run.log, /^memorax-code start --clients codex$/m);
    assert.match(run.log, /^memorax-code status --clients codex$/m);
    assert.match(run.result.stderr, /Restart or refresh Codex/);
    assert.match(run.result.stderr, /enable the MemoraX Code Codex Adapter plugin/);
    assert.doesNotMatch(run.result.stderr, /memorax-code-claude status/);
    assert.doesNotMatch(run.log, /^claude /m);
    assert.equal(await readFile(join(run.claudeHome, "settings.json"), "utf8"), claudeSettingsText);
    const config = await readFile(join(run.memoraxCodeHome, "config.toml"), "utf8");
    assert.match(config, /\[clients\][^\r\n]*\r?\ncodex = true[^\r\n]*\r?\nclaude = false[^\r\n]*\r?\nopencode = false/m);
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("postinstall can write MemoraX memory config before backend start", async () => {
  const run = await runPostinstall({
    interactive: true,
    input: "y\nmemorax-user\nen\nmemorax-secret\nn\n",
    memoraxVerify: {},
  });
  try {
    assert.equal(run.result.code, 0, run.result.stderr);
    assert.match(run.result.stderr, /MemoraX Code requires MemoraX for its core remote-memory functionality/);
    assert.match(run.result.stderr, /automatically send selected user prompts and final assistant answers to MemoraX/);
    assert.match(run.result.stderr, /Newly generated configuration enables automatic writeback/);
    assert.match(run.result.stderr, /If you do not have a MemoraX account\/API key, register at https:\/\/platform\.memorax\.net\//);
    assert.match(run.result.stderr, /Connect MemoraX Code to MemoraX now/);
    assert.equal((run.result.stderr.match(/Connect MemoraX Code to MemoraX now/g) ?? []).length, 1);
    assert.doesNotMatch(run.result.stderr, /Enable automatic writeback|Enable writeback now/);
    assert.match(run.result.stderr, /MemoraX base user ID: <provided>/);
    assert.match(run.result.stderr, /Preferred language \[ZH\/en\] \(used for Memory extraction\): <provided>/);
    assert.match(run.result.stderr, /MemoraX API key: <provided>/);
    assert.doesNotMatch(run.result.stderr, /MemoraX endpoint/);
    assert.match(run.result.stderr, /MemoraX config written to/);
    assert.match(run.result.stderr, /first workspace-scoped memory request from a trusted workspace/);
    assert.match(run.result.stderr, /MemoraX memory: .*Configured/);
    assert.match(run.result.stderr, /Automatic writeback: .*Enabled/);
    assert.match(run.log, /^memorax-code start --clients codex,claude$/m);
    assert.match(run.log, /^memorax-cli status --json --config-only$/m);
    assert.equal(run.memoraxRequests.length, 0);
    const config = await readFile(join(run.memoraxCodeHome, "config.toml"), "utf8");
    assert.match(config, /\[memorax\]/);
    assert.ok(config.includes(`endpoint = "${run.memoraxEndpoint}" # MemoraX service URL.`));
    assert.match(config, /user_id = "memorax-user" # MemoraX base user ID; requests derive a workspace-scoped namespace\./);
    assert.match(config, /api_key = "memorax-secret" # MemoraX API key used by the local Backend\./);
    assert.match(config, /\[memory\.add\]\r?\noutput_language = "en" # Language for newly generated MemoraX memories\./);
    assert.match(
      config,
      /# MemoraX remote-memory connection\. Credentials may also come from the environment\.\r?\n\[memorax\]\r?\nendpoint = /,
    );
    assert.match(
      config,
      /user_id = "memorax-user" # MemoraX base user ID; requests derive a workspace-scoped namespace\.\r?\n\r?\n# Automatic Hook retrieval is opt-in\.\r?\n\[memory\.retrieval\]/,
    );
    assert.match(config, /\[memory\.retrieval\]\nenabled = false # Auto-inject retrieved memories into supported client prompts\./);
    assert.match(config, /\[memory\.skill_reminder\]/);
    assert.match(config, /interval_turns = 5 # Show the MemoraX Code skill reminder every N native client turns, starting on the first turn\./);
    assert.equal(activeTomlSectionCount(config, "memory.writeback"), 1);
    assert.match(config, /enabled = true # Allow supported client sessions to write memories after replies\./);
    assert.match(config, /\[trace\.codex\]/);
    assert.match(config, /enabled = true # Enable local Codex session memory trace collection\./);
    assert.match(config, /capture_content = true # Store content in local Codex trace events\./);
    assert.match(config, /\[trace\.claude\]/);
    assert.match(config, /enabled = true # Enable local Claude session memory trace collection\./);
    assert.match(config, /capture_content = true # Store content in local Claude trace events\./);
    assert.doesNotMatch(
      config,
      /top_k|k_dense|k_sparse|min_score|max_context_chars|max_item_chars|buffer_|chunk_|max_message_chars|timeout_ms|retention_days|max_event_chars|max_file_bytes/,
    );
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("postinstall reports a non-interactive fresh install as MemoraX not configured", async () => {
  const run = await runPostinstall();
  try {
    assert.equal(run.result.code, 0, run.result.stderr);
    assert.doesNotMatch(run.result.stderr, /Connect MemoraX Code to MemoraX now/);
    assert.match(run.result.stderr, /This install cannot prompt for a MemoraX ID and key/);
    assert.match(run.result.stderr, /\[MemoraX Code Install\]: Package: Installed/);
    assert.match(run.result.stderr, /\[MemoraX Code Install\]: MemoraX memory: Not configured/);
    assert.match(run.result.stderr, /Package installed, MemoraX not configured/);
    assert.equal((run.log.match(/^memorax-cli status --json --config-only$/gm) ?? []).length, 1);
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("postinstall does not trust configured JSON from a failed memory status command", async () => {
  const run = await runPostinstall({
    memoryStatusFixture: {
      output: JSON.stringify({
        ok: true,
        action: "memory.status",
        provider: "memory.memorax",
        config: {
          configured: true,
          writeback: { globalEnabled: true, writebackEnabled: true },
        },
      }),
      exitCode: 2,
    },
  });
  try {
    assert.equal(run.result.code, 0, run.result.stderr);
    assert.match(run.result.stderr, /MemoraX memory: Status unavailable/);
    assert.doesNotMatch(run.result.stderr, /MemoraX memory: .*Configured/);
    assert.doesNotMatch(run.result.stderr, /Automatic writeback: .*Enabled/);
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("postinstall reports existing credentials without implicitly enabling writeback", async () => {
  const run = await runPostinstall({
    npmCommand: "update",
    memoraxCodeConfig: [
      "[clients]",
      "codex = true",
      "claude = true",
      "",
      "[memorax]",
      'endpoint = "https://memorax.example"',
      'api_key = "existing-secret"',
      'user_id = "existing-user"',
      "",
    ].join("\n"),
  });
  try {
    assert.equal(run.result.code, 0, run.result.stderr);
    assert.doesNotMatch(run.result.stderr, /Connect MemoraX Code to MemoraX now/);
    assert.doesNotMatch(run.result.stderr, /Preferred language/);
    assert.match(run.result.stderr, /MemoraX memory: .*Configured/);
    assert.match(run.result.stderr, /Automatic writeback: Disabled by effective configuration/);
    assert.doesNotMatch(run.result.stderr, /existing-secret|existing-user/);
    const config = await readFile(join(run.memoraxCodeHome, "config.toml"), "utf8");
    assert.doesNotMatch(config, /output_language/);
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("postinstall recognizes environment-only MemoraX credentials", async () => {
  const run = await runPostinstall({
    memoraxEnv: {
      MEMORAX_CODE_MEMORAX_API_KEY: "environment-secret",
      MEMORAX_CODE_MEMORAX_USER_ID: "environment-user",
    },
  });
  try {
    assert.equal(run.result.code, 0, run.result.stderr);
    assert.match(run.result.stderr, /MemoraX memory: .*Configured/);
    assert.match(run.result.stderr, /Automatic writeback: .*Enabled/);
    assert.doesNotMatch(run.result.stderr, /environment-secret|environment-user/);
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("postinstall preserves an explicit automatic writeback disable", async () => {
  const run = await runPostinstall({
    memoraxCodeConfig: [
      "[clients]",
      "codex = true",
      "claude = true",
      "",
      "[memorax]",
      'api_key = "existing-secret"',
      'user_id = "existing-user"',
      "",
      "[memory.writeback]",
      "enabled = false",
      "",
    ].join("\n"),
  });
  try {
    assert.equal(run.result.code, 0, run.result.stderr);
    assert.match(run.result.stderr, /MemoraX memory: .*Configured/);
    assert.match(run.result.stderr, /Automatic writeback: Disabled by effective configuration/);
    const config = await readFile(join(run.memoraxCodeHome, "config.toml"), "utf8");
    assert.match(tomlSectionText(config, "memory.writeback"), /^enabled = false$/m);
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("postinstall reports the global automatic writeback kill switch", async () => {
  const run = await runPostinstall({
    memoraxEnv: {
      MEMORAX_CODE_MEMORAX_API_KEY: "environment-secret",
      MEMORAX_CODE_MEMORAX_USER_ID: "environment-user",
      MEMORAX_CODE_MEMORAX_WRITEBACK_ENABLED: "false",
    },
  });
  try {
    assert.equal(run.result.code, 0, run.result.stderr);
    assert.match(run.result.stderr, /MemoraX memory: .*Configured/);
    assert.match(run.result.stderr, /Automatic writeback: Disabled by the global kill switch/);
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("postinstall writes the platform endpoint when no override is supplied", async () => {
  const run = await runPostinstall({
    interactive: true,
    input: "y\nmemorax-user\n\nmemorax-secret\nn\n",
  });
  try {
    assert.equal(run.result.code, 0, run.result.stderr);
    assert.match(run.result.stderr, /register at https:\/\/platform\.memorax\.net\//);
    const config = await readFile(join(run.memoraxCodeHome, "config.toml"), "utf8");
    assert.match(config, /endpoint = "https:\/\/platform\.memorax\.net" # MemoraX service URL\./);
    assert.match(config, /output_language = "zh" # Language for newly generated MemoraX memories\./);
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("postinstall does not report empty MemoraX credentials as configured", async () => {
  const run = await runPostinstall({
    interactive: true,
    input: "y\n\nzh\nmemorax-secret\nn\n",
  });
  try {
    assert.equal(run.result.code, 0, run.result.stderr);
    assert.match(run.result.stderr, /MemoraX config was not written because base user ID or API key was empty/);
    assert.match(run.result.stderr, /MemoraX memory: Not configured/);
    assert.doesNotMatch(run.result.stderr, /MemoraX memory: .*Configured/);
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("postinstall rejects an unsupported preferred language", async () => {
  const run = await runPostinstall({
    interactive: true,
    input: "y\nmemorax-user\nfr\nmemorax-secret\nn\n",
  });
  try {
    assert.equal(run.result.code, 0, run.result.stderr);
    assert.match(run.result.stderr, /preferred language must be zh or en/i);
    assert.match(run.result.stderr, /MemoraX memory: Not configured/);
    const config = await readFile(join(run.memoraxCodeHome, "config.toml"), "utf8");
    assert.match(config, /output_language = "zh" # Language for newly generated MemoraX memories\./);
    assert.doesNotMatch(config, /memorax-user|memorax-secret/);
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("postinstall preserves existing optional config instead of backfilling defaults", async () => {
  const existingConfig = [
    "# MemoraX Code local config.",
    "# This file is read from $MEMORAX_CODE_HOME/config.toml.",
    "# Environment variables still override values written here.",
    "",
    "[memory.repo_update]",
    'policy = "daily"',
    "commit_threshold = 9",
    "cooldown_hours = 48",
    "",
    "[custom]",
    "keep = true",
    "",
    "[memorax]",
    'endpoint = "http://old-memorax.test"',
    'api_key = "old-secret"',
    'user_id = "old-user"',
    "",
  ].join("\n");
  const run = await runPostinstall({
    memoraxCodeConfig: existingConfig,
    interactive: true,
    input: "y\nmemorax-user\nen\nmemorax-secret\nn\n",
    memoraxVerify: {},
  });
  try {
    assert.equal(run.result.code, 0, run.result.stderr);
    const config = await readFile(join(run.memoraxCodeHome, "config.toml"), "utf8");
    assert.match(config, /\[custom\]\nkeep = true/);
    assert.deepEqual(activeTomlSections(config), [
      "clients",
      "custom",
      "memorax",
      "memory.add",
      "memory.repo_update",
    ]);
    assert.match(tomlSectionText(config, "memory.repo_update"), /^policy = "daily"$/m);
    assert.match(tomlSectionText(config, "memory.repo_update"), /^commit_threshold = 9$/m);
    assert.match(tomlSectionText(config, "memory.repo_update"), /^cooldown_hours = 48$/m);
    assert.doesNotMatch(config, /top_k|buffer_max_turns|retention_days/);
    assert.ok(config.includes(`endpoint = "${run.memoraxEndpoint}" # MemoraX service URL.`));
    assert.match(config, /api_key = "memorax-secret" # MemoraX API key used by the local Backend\./);
    assert.match(config, /user_id = "memorax-user" # MemoraX base user ID; requests derive a workspace-scoped namespace\./);
    assert.match(config, /\[memory\.add\]\noutput_language = "en" # Language for newly generated MemoraX memories\./);
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("postinstall leaves malformed config byte-identical and emits a redacted warning", async () => {
  const malformed = '[memorax]\napi_key = "preserved-sensitive-secret"\nbroken = [\n';
  const run = await runPostinstall({
    memoraxCodeConfig: malformed,
    interactive: true,
    input: "n\nn\n",
  });
  try {
    assert.equal(run.result.code, 0, run.result.stderr);
    assert.equal(await readFile(join(run.memoraxCodeHome, "config.toml"), "utf8"), malformed);
    const warning = run.result.stderr.split(/\r?\n/).find((line) => line.includes("MemoraX Code config could not be safely updated or verified"));
    assert.ok(warning);
    assert.doesNotMatch(warning, /preserved-sensitive-secret|config\.toml|broken =/);
    assert.deepEqual(await readdir(run.memoraxCodeHome), ["config.toml"]);
    assert.doesNotMatch(run.log, /^memorax-code start/m);
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("postinstall fails closed before config writers when initial seeding fails", async () => {
  const malformed = '[memorax]\napi_key = "preserved-sensitive-secret"\nbroken = [\n';
  const run = await runPostinstall({
    memoraxCodeConfig: malformed,
    interactive: true,
    input: "n\nn\n",
  });
  try {
    assert.equal(run.result.code, 0, run.result.stderr);
    assert.equal(await readFile(join(run.memoraxCodeHome, "config.toml"), "utf8"), malformed);
    assert.doesNotMatch(run.log, /^memorax-code start/m);
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("postinstall preserves existing config mode and owner while updating managed clients", async () => {
  const run = await runPostinstall({
    memoraxCodeConfig: '[memorax]\nuser_id = "mode-user"\n',
    memoraxCodeConfigMode: 0o640,
    interactive: true,
    input: "n\nn\n",
  });
  try {
    assert.equal(run.result.code, 0, run.result.stderr);
    const configStat = await stat(join(run.memoraxCodeHome, "config.toml"));
    assert.equal(configStat.mode & 0o7777, 0o640);
    assert.equal(configStat.uid, process.getuid());
    assert.equal(configStat.gid, process.getgid());
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("postinstall does not probe an unscoped MemoraX namespace", async () => {
  const run = await runPostinstall({
    interactive: true,
    input: "y\nmemorax-user\nzh\nbad-secret\nn\n",
    memoraxVerify: { status: 401, body: { error: "invalid key" } },
  });
  try {
    assert.equal(run.result.code, 0, run.result.stderr);
    assert.match(run.result.stderr, /MemoraX config written to/);
    assert.match(run.result.stderr, /first workspace-scoped memory request from a trusted workspace/);
    assert.doesNotMatch(run.result.stderr, /verification failed|MemoraX HTTP 401/);
    assert.equal(run.memoraxRequests.length, 0);
    const config = await readFile(join(run.memoraxCodeHome, "config.toml"), "utf8");
    assert.ok(config.includes(`endpoint = "${run.memoraxEndpoint}" # MemoraX service URL.`));
    assert.match(config, /api_key = "bad-secret" # MemoraX API key used by the local Backend\./);
    assert.match(config, /user_id = "memorax-user" # MemoraX base user ID; requests derive a workspace-scoped namespace\./);
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("postinstall starts only the common Backend when no supported client is detected", async () => {
  const run = await runPostinstall({
    codexAvailable: false,
    claudeAvailable: false,
  });
  try {
    assert.equal(run.result.code, 0, run.result.stderr);
    assert.doesNotMatch(run.result.stderr, /Configure MemoraX Code for which clients/);
    assert.match(run.result.stderr, /No supported client runtime was detected/);
    assert.match(run.log, /^memorax-code start --clients none$/m);
    assert.match(run.log, /^memorax-code status --clients none$/m);
    assert.doesNotMatch(run.log, /^(codex|claude) /m);
    assert.match(run.result.stderr, /Backend and selected adapters: .*Enabled/);
    assert.doesNotMatch(run.result.stderr, /Restart or refresh Codex/);
    const config = await readFile(join(run.memoraxCodeHome, "config.toml"), "utf8");
    assert.match(config, /\[clients\][^\r\n]*\r?\ncodex = false[^\r\n]*\r?\nclaude = false[^\r\n]*\r?\nopencode = false/m);
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("postinstall recovers from a failed backend start and prints red diagnostics", async () => {
  const run = await runPostinstall({ failStartOnce: true });
  try {
    assert.equal(run.result.code, 0, run.result.stderr);
    assert.match(run.log, /^memorax-code start --clients codex,claude$/m);
    assert.match(run.log, /^memorax-code stop --clients codex,claude$/m);
    assert.match(run.log, /^memorax-code start --clients codex,claude$/m);
    assert.match(run.log, /^memorax-code status --clients codex,claude$/m);
    assert.match(run.result.stderr, /Backend start failed during npm postinstall/);
    assert.match(run.result.stderr, /\[MemoraX Code Backend\]: fake memorax-code start failure/);
    assert.match(run.result.stderr, /Attempting automatic recovery: `memorax-code stop` then `memorax-code start`/);
    assert.match(run.result.stderr, /\[MemoraX Code Backend\]: fake memorax-code stop output/);
    assert.match(run.result.stderr, /Backend start completed after automatic recovery/);
    assert.match(run.result.stderr, /Backend status check completed/);
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("postinstall does not stop adapters after a deterministic connection authority failure", async () => {
  const run = await runPostinstall({ connectionAuthorityFailure: true });
  try {
    assert.equal(run.result.code, 0, run.result.stderr);
    assert.equal((run.log.match(/^memorax-code start --clients codex,claude$/gm) ?? []).length, 1);
    assert.doesNotMatch(run.log, /^memorax-code stop(?: |$)/m);
    assert.doesNotMatch(run.log, /^memorax-code status(?: |$)/m);
    assert.match(run.result.stderr, /BACKEND_CONNECTION_AUTHORITY_INVALID/);
    assert.doesNotMatch(run.result.stderr, /Attempting automatic recovery/);
    assert.match(
      run.result.stderr,
      /memorax-code start --host 127\.0\.0\.1 --port <intended-port>/,
    );
    assert.doesNotMatch(
      run.result.stderr,
      /Suggested recovery: run `memorax-code stop`, then `memorax-code start`/,
    );
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("postinstall does not retry deterministic token or service-state failures", async (t) => {
  for (const code of [
    "BACKEND_TOKEN_RECORD_INVALID",
    "BACKEND_SERVICE_STATE_UNSUPPORTED",
    "BACKEND_SERVICE_STATE_CLEANUP_FAILED",
  ]) {
    await t.test(code, async () => {
      const run = await runPostinstall({ runtimeAuthorityFailureCode: code });
      try {
        assert.equal(run.result.code, 0, run.result.stderr);
        assert.equal((run.log.match(/^memorax-code start --clients codex,claude$/gm) ?? []).length, 1);
        assert.doesNotMatch(run.log, /^memorax-code stop(?: |$)/m);
        assert.doesNotMatch(run.log, /^memorax-code status(?: |$)/m);
        assert.match(run.result.stderr, new RegExp(code));
        assert.doesNotMatch(run.result.stderr, /Attempting automatic recovery/);
      } finally {
        await rm(run.root, { recursive: true, force: true });
      }
    });
  }
});

test("postinstall does not stop a Backend after lifecycle lock contention", async () => {
  const run = await runPostinstall({
    runtimeAuthorityFailureCode: "BACKEND_LIFECYCLE_LOCK_TIMEOUT",
  });
  try {
    assert.equal(run.result.code, 0, run.result.stderr);
    assert.equal((run.log.match(/^memorax-code start --clients codex,claude$/gm) ?? []).length, 1);
    assert.doesNotMatch(run.log, /^memorax-code stop(?: |$)/m);
    assert.doesNotMatch(run.log, /^memorax-code status(?: |$)/m);
    assert.match(run.result.stderr, /BACKEND_LIFECYCLE_LOCK_TIMEOUT/);
    assert.match(run.result.stderr, /another MemoraX Code lifecycle command still owns/);
    assert.match(run.result.stderr, /Let the existing lifecycle command finish/);
    assert.doesNotMatch(run.result.stderr, /Attempting automatic recovery/);
    assert.match(run.result.stderr, /Backend and selected adapters: Not verified/);
    assert.doesNotMatch(run.result.stderr, /Backend and selected adapters: .*Unavailable/);
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("postinstall reports unavailable status and prints red diagnostics instead of usage reminders", async () => {
  const run = await runPostinstall({ unavailableStatus: true });
  try {
    assert.equal(run.result.code, 0, run.result.stderr);
    assert.match(run.log, /^memorax-code status --clients codex,claude$/m);
    assert.match(run.result.stderr, /\[MemoraX Code Backend\]: codex adapter: not enabled integration=hooks/);
    assert.match(run.result.stderr, /\[MemoraX Code Backend\]: claude adapter: ok integration=hooks skills=ok/);
    assert.match(run.result.stderr, /Backend and selected adapters: .*Unavailable/);
    assert.match(run.result.stderr, /MemoraX Code is not enabled for new client sessions/);
    assert.match(run.result.stderr, /Check `memorax-code status`, `memorax-code-codex status`, `memorax-code-claude status`, and `memorax-code-opencode status`/);
    assert.doesNotMatch(run.result.stderr, /Restart or refresh Codex/);
    assert.doesNotMatch(run.result.stderr, /enable the MemoraX Code Codex Adapter plugin/);
    assert.match(run.result.stderr, /\[MemoraX Code Install\]: Common commands:/);
    assert.match(run.result.stderr, /\[MemoraX Code Install\]: - `memorax-code start`: start or refresh the local memory backend and client integrations/);
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});
