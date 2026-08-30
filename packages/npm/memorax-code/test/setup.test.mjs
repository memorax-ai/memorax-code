import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commandOnPath } from "../lib/vscode-extension-command.mjs";

const setupPath = fileURLToPath(new URL("../bin/memorax-code-setup.mjs", import.meta.url));
const adapterCommonSourceRoot = fileURLToPath(new URL(
  "../../../ts/memorax-code-adapter-common/src/",
  import.meta.url,
));
const codexAdapterSourceRoot = fileURLToPath(new URL(
  "../../../ts/memorax-code-codex-adapter/",
  import.meta.url,
));
const clientHookRuntimePath = fileURLToPath(new URL("../lib/client-hook-runtime.mjs", import.meta.url));
const setupReconcilePath = fileURLToPath(new URL("../lib/setup-reconcile.mjs", import.meta.url));
const codexRuntimeShellPath = fileURLToPath(new URL(
  "../../../ts/memorax-code-codex-adapter/hooks/runtime-shell.json",
  import.meta.url,
));
const claudeCommandResolverPath = fileURLToPath(new URL("../lib/resolve-claude-command.mjs", import.meta.url));
const codexCommandResolverPath = fileURLToPath(new URL("../lib/resolve-codex-command.mjs", import.meta.url));
const codeBuddyCommandResolverPath = fileURLToPath(new URL("../lib/resolve-codebuddy-command.mjs", import.meta.url));
const vscodeExtensionCommandPath = fileURLToPath(new URL("../lib/vscode-extension-command.mjs", import.meta.url));
const windowsCliInvocationPath = fileURLToPath(new URL("../lib/windows-cli-invocation.mjs", import.meta.url));
const smolTomlPath = fileURLToPath(new URL("../../../ts/memorax-code-backend/node_modules/smol-toml", import.meta.url));
const memoraxCodePluginId = "memorax-code-codex-adapter@memorax-code";
const trialApiKey = `sk_${"T".repeat(43)}`;

async function writeMockNodeCommand(command, source) {
  const contents = Array.isArray(source) ? source.join("\n") : source;
  if (process.platform === "win32") {
    await writeFile(command, contents, { mode: 0o755 });
    await chmod(command, 0o755);
    return;
  }
  const modulePath = `${command}.mjs`;
  await writeFile(modulePath, contents, { mode: 0o755 });
  await chmod(modulePath, 0o755);
  await symlink(basename(modulePath), command);
}

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

function setupCompletionPath(memoraxCodeHome) {
  return join(memoraxCodeHome, "runtime", "setup", "setup-completion.json");
}

async function assertSetupComplete(run) {
  const completion = JSON.parse(await readFile(setupCompletionPath(run.memoraxCodeHome), "utf8"));
  assert.equal(completion.version, 1);
  assert.equal(completion.state, "complete");
  assert.equal(completion.completedByVersion, "0.0.7-test");
  assert.ok(Number.isFinite(Date.parse(completion.completedAt)));
}

async function assertSetupIncomplete(run) {
  await assert.rejects(
    readFile(setupCompletionPath(run.memoraxCodeHome), "utf8"),
    (error) => error?.code === "ENOENT",
  );
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

async function runSetup({ existingCache = false, explicitCache = false, hookRuntimeFailure, failStartOnce = false, connectionAuthorityFailure = false, runtimeAuthorityFailureCode, officialMode = false, codexConfig, memoraxCodeConfig, memoraxCodeConfigMode, emptyClaudeSettings = false, claudeAvailable = true, claudeVersionFails = false, claudeSettingsText, codexAvailable = true, codexAppOnly = false, vscodeOnly = false, dshProfiles = [], opencodeAvailable = false, opencodeXdgAvailable = false, opencodeCliAvailable = false, codebuddyAvailable = false, skipCodexPluginInstall = false, skipClaudeAdapterInstall = false, skipOpenCodeAdapterInstall = false, skipCodeBuddyAdapterInstall = false, unavailableStatus = false, prefixedStatus = false, input = "", interactive = true, npmCommand = "install", updateMode = false, setupMode = "automatic", memoraxVerify, memoraxEnv = {}, memoryStatusFixture, trialProvisionFailure = false, hookSnapshot = [], hookUpdatePlan = [], hookFullReview = false, hookFullReviewMissing = false, hookSnapshotFails = false, hookCheckFails = false, hookTrustFails = false, detectedUserId = "memory-user", detectedLanguage = "zh", ttyOverride } = {}) {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-setup-"));
  const binDir = join(root, "bin");
  const codexHome = join(root, "codex-home");
  const claudeHome = join(root, "claude-home");
  const opencodeConfigDir = join(root, "opencode-config");
  const xdgConfigHome = join(root, "xdg-config");
  const memoraxCodeHome = join(root, "memorax-code-home");
  const home = join(root, "home");
  const workbuddyHome = join(home, ".workbuddy");
  const fakeBin = join(root, "fake-bin");
  const libDir = join(root, "lib");
  const nodeModulesDir = join(root, "node_modules");
  const logPath = join(root, "commands.log");
  const memoraxServer = memoraxVerify ? await startMockMemorax(memoraxVerify) : undefined;
  await mkdir(binDir, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  if (process.platform !== "win32") await symlink(process.execPath, join(fakeBin, "node"));
  await mkdir(libDir, { recursive: true });
  await writeFile(join(libDir, "dsh-plugin-install.mjs"), [
    "export function discoverDshProfiles() {",
    "  const code = process.env.MEMORAX_CODE_TEST_DSH_DISCOVERY_ERROR;",
    "  if (code) throw Object.assign(new Error('profile discovery failed'), { code });",
    "  return JSON.parse(process.env.MEMORAX_CODE_TEST_DSH_PROFILES ?? '[]');",
    "}",
    "",
  ].join("\n"));
  await mkdir(nodeModulesDir, { recursive: true });
  await copyFile(setupPath, join(binDir, "memorax-code-setup.mjs"));
  const adapterCommonDir = join(libDir, "memorax-code-adapter-common", "src");
  await mkdir(adapterCommonDir, { recursive: true });
  for (const file of [
    "backend-connection.mjs",
    "hooks/capture-cwd-hook.mjs",
    "hooks/client-hook-launcher.mjs",
    "clients/codex-plugin-artifact.mjs",
    "automatic-update-state.mjs",
    "config-utils.mjs",
    "hooks/ensure-backend-runner.mjs",
    "memorax-code-config-file.mjs",
    "hooks/hook-runtime-generation.mjs",
    "memorax-defaults.mjs",
    "hooks/memory-skill-reminder-hook.mjs",
    "hooks/memory-skill-reminder-policy.mjs",
    "repo-memory/repo-memory-auto-build.mjs",
    "repo-memory/repo-memory-job-context.mjs",
    "repo-memory/repo-procedure-memory-context.mjs",
    "repo-memory/repo-user-profile-context.mjs",
    "runtime-record.mjs",
    "setup-completion.mjs",
  ]) {
    const target = join(adapterCommonDir, file);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(adapterCommonSourceRoot, file), target);
  }
  await copyFile(clientHookRuntimePath, join(libDir, "client-hook-runtime.mjs"));
  await copyFile(setupReconcilePath, join(libDir, "setup-reconcile.mjs"));
  await writeFile(join(libDir, "setup-memory-preferences.mjs"), [
    "export function detectSetupMemoryPreferences() {",
    `  return Object.freeze(${JSON.stringify({
      ...(detectedUserId ? { userId: detectedUserId } : {}),
      ...(detectedLanguage ? { outputLanguage: detectedLanguage } : {}),
    })});`,
    "}",
    "",
  ].join("\n"));
  const trialReadyMarker = join(memoraxCodeHome, "runtime", "credentials", "trial-ready-test");
  await writeFile(join(libDir, "trial-setup.mjs"), [
    "import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';",
    "import { dirname } from 'node:path';",
    "export async function ensureTrialSetupCredential() {",
    `  appendFileSync(${JSON.stringify(logPath)}, 'trial-provision\\n');`,
    `  if (${JSON.stringify(trialProvisionFailure)}) {`,
    "    const error = new Error('redacted trial failure');",
    "    error.reason = 'credential_failure';",
    "    throw error;",
    "  }",
    `  mkdirSync(dirname(${JSON.stringify(trialReadyMarker)}), { recursive: true });`,
    `  writeFileSync(${JSON.stringify(trialReadyMarker)}, 'ready\\n');`,
    `  return { status: 'ready', provisioned: true, accountId: '9001', projectId: '9002', apiKey: ${JSON.stringify(trialApiKey)} };`,
    "}",
    "export async function loadReadyTrialSetupCredential() {",
    `  appendFileSync(${JSON.stringify(logPath)}, 'trial-load\\n');`,
    `  return { status: 'ready', provisioned: false, accountId: '9001', projectId: '9002', apiKey: ${JSON.stringify(trialApiKey)} };`,
    "}",
    "",
  ].join("\n"));
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
  await copyFile(codeBuddyCommandResolverPath, join(libDir, "resolve-codebuddy-command.mjs"));
  await copyFile(vscodeExtensionCommandPath, join(libDir, "vscode-extension-command.mjs"));
  await copyFile(windowsCliInvocationPath, join(libDir, "windows-cli-invocation.mjs"));
  await symlink(smolTomlPath, join(nodeModulesDir, "smol-toml"), "dir");
  await writeFile(join(binDir, "memorax-code.mjs"), [
    "#!/usr/bin/env node",
    "import { appendFileSync, existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    `appendFileSync(${JSON.stringify(logPath)}, 'memorax-code ' + process.argv.slice(2).join(' ') + '\\n');`,
    `if (process.env.MEMORAX_CODE_DSH_ADAPTER_OPTIONAL === '1') appendFileSync(${JSON.stringify(logPath)}, 'dsh-adapter-optional ' + process.argv[2] + '\\n');`,
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
    "const selectedClients = new Set(clientMode === 'all' ? ['codex', 'claude', 'dsh', 'opencode', 'codebuddy'] : clientMode.split(','));",
    "const codexEnabled = selectedClients.has('codex');",
    "const claudeEnabled = selectedClients.has('claude');",
    "const opencodeEnabled = selectedClients.has('opencode');",
    "const codebuddyEnabled = selectedClients.has('codebuddy');",
    "const dshEnabled = selectedClients.has('dsh') && process.env.MEMORAX_CODE_TEST_DSH_ENABLED === '1';",
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
    "    if (codebuddyEnabled) console.error('[MemoraX Code Backend]: CodeBuddy adapter: \\x1b[32mok\\x1b[0m integration=hooks skills=ok');",
    "    if (dshEnabled) console.error('[MemoraX Code Backend]: DSH adapter: \\x1b[32mok\\x1b[0m integration=plugin profiles=ok');",
    "    process.exit(0);",
    "  }",
    "  console.error('memorax-code: ok');",
    "  console.error('backend: ok http://127.0.0.1:8787 status=200');",
    "  if (codexEnabled) console.error('codex adapter: ok integration=hooks skills=plugin-managed');",
    "  if (claudeEnabled) console.error('claude adapter: ok integration=hooks skills=ok');",
    "  if (opencodeEnabled) console.error('opencode adapter: ok integration=plugin skills=ok');",
    "  if (codebuddyEnabled) console.error('codebuddy adapter: ok integration=hooks skills=ok');",
    "  if (dshEnabled) console.error('dsh adapter: ok integration=plugin profiles=ok');",
    "}",
    "process.exit(0);",
    "",
  ].join("\n"), { mode: 0o755 });
  await writeFile(join(binDir, "memorax-cli.mjs"), [
    "#!/usr/bin/env node",
    "import { appendFileSync, existsSync, readFileSync } from 'node:fs';",
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
    `const trialReady = existsSync(${JSON.stringify(trialReadyMarker)});`,
    "const configured = Boolean(userId && (apiKey || trialReady));",
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
    await writeMockNodeCommand(join(fakeBin, "codex"), [
      "#!/usr/bin/env node",
      "import { appendFileSync } from 'node:fs';",
      `appendFileSync(${JSON.stringify(logPath)}, 'codex ' + process.argv.slice(2).join(' ') + '\\n');`,
      "if (process.argv[2] === '--version') console.log('codex 9.9.9-test');",
      "process.exit(0);",
      "",
    ]);
  }
  if (codexAppOnly) {
    const appCodex = process.platform === "win32"
      ? join(codexHome, "plugins", ".plugin-appserver", "codex.exe")
      : join(home, "Applications", "ChatGPT.app", "Contents", "Resources", "codex");
    await mkdir(dirname(appCodex), { recursive: true });
    if (process.platform === "win32") {
      await copyFile(process.execPath, appCodex);
    } else {
      await writeMockNodeCommand(appCodex, [
        "#!/usr/bin/env node",
        "import { appendFileSync } from 'node:fs';",
        `appendFileSync(${JSON.stringify(logPath)}, 'app-codex ' + process.argv.slice(2).join(' ') + '\\n');`,
        "if (process.argv[2] === '--version') console.log('codex-app 9.9.9-test');",
        "process.exit(0);",
        "",
      ]);
    }
  }
  if (vscodeOnly) {
    await writeMockVsCodeRuntimes({ home, logPath });
  }
  if (claudeAvailable) {
    await writeMockNodeCommand(join(fakeBin, "claude"), [
      "#!/usr/bin/env node",
      "import { appendFileSync } from 'node:fs';",
      `appendFileSync(${JSON.stringify(logPath)}, 'claude ' + process.argv.slice(2).join(' ') + '\\n');`,
      `if (process.argv[2] === '--version') { ${claudeVersionFails ? "console.error('broken Claude CLI'); process.exit(7);" : "console.log('claude 9.9.9-test');"} }`,
      "process.exit(0);",
      "",
    ]);
  }
  if (opencodeCliAvailable) {
    const executable = join(fakeBin, process.platform === "win32" ? "opencode.cmd" : "opencode");
    await writeMockNodeCommand(executable, "#!/usr/bin/env node\nprocess.exit(0);\n");
  }
  if (codebuddyAvailable) {
    await mkdir(workbuddyHome, { recursive: true });
    await writeMockNodeCommand(join(fakeBin, "codebuddy"), [
      "#!/usr/bin/env node",
      "import { appendFileSync } from 'node:fs';",
      `appendFileSync(${JSON.stringify(logPath)}, 'codebuddy ' + process.argv.slice(2).join(' ') + '\\n');`,
      "if (process.argv[2] === '--version') console.log('codebuddy 9.9.9-test');",
      "process.exit(0);",
      "",
    ]);
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

  const setupEntrypoint = ttyOverride
    ? join(root, "setup-runner.mjs")
    : join(binDir, "memorax-code-setup.mjs");
  if (ttyOverride) {
    await writeFile(setupEntrypoint, [
      `Object.defineProperty(process.stdin, "isTTY", { value: ${JSON.stringify(ttyOverride.stdin)} });`,
      `Object.defineProperty(process.stderr, "isTTY", { value: ${JSON.stringify(ttyOverride.stderr)} });`,
      'await import("./bin/memorax-code-setup.mjs");',
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
    WORKBUDDY_HOME: workbuddyHome,
    MEMORAX_CODE_HOME: memoraxCodeHome,
    PATH: codexAppOnly || vscodeOnly
      ? fakeBin
      : `${fakeBin}${delimiter}${pathWithoutCommand("opencode", process.env.PATH)}`,
    npm_command: npmCommand,
    MEMORAX_CODE_SETUP_UPDATE: updateMode ? "1" : "0",
    MEMORAX_CODE_SETUP_MODE: setupMode,
    MEMORAX_CODE_SETUP_VERBOSE: "1",
    MEMORAX_CODE_SETUP_ASSUME_INTERACTIVE: interactive ? "1" : "0",
    MEMORAX_CODE_SKIP_CODEX_PLUGIN_INSTALL: skipCodexPluginInstall ? "1" : "0",
    MEMORAX_CODE_SKIP_CLAUDE_ADAPTER_INSTALL: skipClaudeAdapterInstall ? "1" : "0",
    MEMORAX_CODE_SKIP_OPENCODE_ADAPTER_INSTALL: skipOpenCodeAdapterInstall ? "1" : "0",
    MEMORAX_CODE_SKIP_CODEBUDDY_ADAPTER_INSTALL: skipCodeBuddyAdapterInstall ? "1" : "0",
    MEMORAX_CODE_TEST_FAIL_START_ONCE: failStartOnce ? "1" : "0",
    MEMORAX_CODE_TEST_RUNTIME_AUTHORITY_FAILURE: runtimeAuthorityFailureCode
      ?? (connectionAuthorityFailure ? "BACKEND_CONNECTION_AUTHORITY_INVALID" : ""),
    MEMORAX_CODE_TEST_UNAVAILABLE_STATUS: unavailableStatus ? "1" : "0",
    MEMORAX_CODE_TEST_PREFIXED_STATUS: prefixedStatus ? "1" : "0",
    MEMORAX_CODE_TEST_DSH_PROFILES: JSON.stringify(dshProfiles.map((name) => ({ name }))),
    MEMORAX_CODE_TEST_DSH_ENABLED: dshProfiles.length > 0 ? "1" : "0",
    MEMORAX_CODE_TEST_PRESERVED_HOOK_GENERATION: hookRuntimeFailure === "activation"
      ? activeHookRuntimeBefore.generationId
      : "",
  };
  delete childEnv.CODEX_CLI_PATH;
  delete childEnv.MEMORAX_CODE_CODEX_COMMAND;
  delete childEnv.MEMORAX_CODE_CLAUDE_COMMAND;
  delete childEnv.MEMORAX_CODE_CODEBUDDY_COMMAND;
  delete childEnv.CODEBUDDY_CLI_PATH;
  delete childEnv.WORKBUDDY_CODEBUDDY_PATH;
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
  if (!codebuddyAvailable) {
    childEnv.MEMORAX_CODE_CODEBUDDY_COMMAND = join(root, "missing-codebuddy");
  }
  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, [setupEntrypoint], {
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
  await writeMockNodeCommand(codexCommand, [
    "#!/usr/bin/env node",
    "import { appendFileSync } from 'node:fs';",
    `appendFileSync(${JSON.stringify(logPath)}, 'vscode-codex ' + process.argv.slice(2).join(' ') + '\\n');`,
    "if (process.argv[2] === '--version') console.log('codex-vscode 9.9.9-test');",
    "process.exit(0);",
    "",
  ]);
  await writeMockNodeCommand(claudeCommand, [
    "#!/usr/bin/env node",
    "import { appendFileSync } from 'node:fs';",
    `appendFileSync(${JSON.stringify(logPath)}, 'vscode-claude ' + process.argv.slice(2).join(' ') + '\\n');`,
    "if (process.argv[2] === '--version') console.log('claude-vscode 9.9.9-test');",
    "process.exit(0);",
    "",
  ]);
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


test("setup update mode skips MemoraX credentials and silently trusts verified Hook changes", async () => {
  const added = codexHook("update-review", "sha256:update-review");
  const existingConfig = [
    "[clients]",
    "codex = true",
    "claude = false",
    "",
    "[memorax]",
    'endpoint = "https://existing-memorax.example"',
    'api_key = "existing-api-key"',
    'user_id = "existing-user-id"',
    "",
    "[memory.add]",
    'output_language = "en"',
    "",
  ].join("\n");
  const run = await runSetup({
    existingCache: true,
    updateMode: true,
    memoraxCodeConfig: existingConfig,
    interactive: true,
    input: "n\n",
    hookSnapshot: [],
    hookUpdatePlan: [added],
  });
  try {
    assert.equal(run.result.code, 0, run.result.stderr);
    assert.match(run.result.stderr, /Claude Code runtime is available, but its integration is disabled in \[clients\]\. Enable it now\? \[Y\/n\]/);
    assert.match(run.result.stderr, /Keeping the Claude Code integration disabled/);
    assert.doesNotMatch(run.result.stderr, /Trust these new or changed Codex Hooks/);
    assert.match(run.result.stderr, /Trusted 1 new or changed MemoraX Code Codex Hook/);
    assert.doesNotMatch(run.result.stderr, /Existing MemoraX configuration detected/);
    assert.doesNotMatch(run.result.stderr, /Connect MemoraX Code to MemoraX now/);
    assert.doesNotMatch(run.result.stderr, /MemoraX base username/);
    assert.doesNotMatch(run.result.stderr, /Preferred language \[ZH\/en\]/);
    assert.doesNotMatch(run.result.stderr, /MemoraX API key/);
    assert.match(run.log, /^memorax-code codex-plugin hooks .*--json$/m);
    assert.match(run.log, /^memorax-code codex-plugin trust-hooks --check .*--json$/m);
    assert.match(run.log, /^memorax-code codex-plugin trust-hooks --yes .*--json$/m);
    const config = await readFile(join(run.memoraxCodeHome, "config.toml"), "utf8");
    assert.match(config, /api_key = "existing-api-key"/);
    assert.match(config, /user_id = "existing-user-id"/);
    assert.match(config, /output_language = "en"/);
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});


test("setup fresh install auto-detects Codex and skips an unavailable Claude runtime", async () => {
  const run = await runSetup({
    claudeAvailable: false,
  });
  try {
    assert.equal(run.result.code, 0, run.result.stderr);
    assert.doesNotMatch(run.result.stderr, /Configure MemoraX Code for which clients/);
    assert.match(run.log, /^codex --version$/m);
    assert.match(run.result.stderr, /Claude Code runtime was not detected; skipping its adapter setup/);
    assert.match(run.log, /^memorax-code codex-plugin install --json$/m);
    assert.match(run.log, /^memorax-code start --clients codex,dsh$/m);
    assert.match(run.log, /^memorax-code status --clients codex,dsh$/m);
    assert.match(run.log, /^dsh-adapter-optional start$/m);
    assert.match(run.log, /^dsh-adapter-optional status$/m);
    assert.match(run.result.stderr, /Backend and selected adapters: .*Enabled/);
    const config = await readFile(join(run.memoraxCodeHome, "config.toml"), "utf8");
    assert.match(config, /\[clients\][^\r\n]*\r?\ncodex = true[^\r\n]*\r?\nclaude = false[^\r\n]*\r?\ndsh = true[^\r\n]*\r?\nopencode = false/m);
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});


test("setup fresh install auto-detects CodeBuddy and starts the WorkBuddy adapter", async () => {
  const run = await runSetup({
    codexAvailable: false,
    claudeAvailable: false,
    codebuddyAvailable: true,
  });
  try {
    assert.equal(run.result.code, 0, run.result.stderr);
    assert.match(run.log, /^codebuddy --version$/m);
    assert.match(run.result.stderr, /CodeBuddy CLI: codebuddy 9\.9\.9-test/);
    assert.match(run.result.stderr, /WorkBuddy data directory: found/);
    assert.match(run.result.stderr, /Keeping CodeBuddy provider config unchanged and enabling the shared memory Hook integration/);
    assert.match(run.log, /^memorax-code start --clients dsh,codebuddy$/m);
    assert.match(run.log, /^memorax-code status --clients dsh,codebuddy$/m);
    assert.match(run.result.stderr, /CodeBuddy\/WorkBuddy/);
    const config = await readFile(join(run.memoraxCodeHome, "config.toml"), "utf8");
    assert.match(config, /codebuddy = true/);
    assert.match(config, /\[trace\.codebuddy\]/);
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});


test("setup seeds the default MemoraX Code config around trial memory preferences", async () => {
  const run = await runSetup({ interactive: true });
  try {
    assert.equal(run.result.code, 0, run.result.stderr);
    assert.match(run.result.stderr, /MemoraX Code requires MemoraX for its core remote-memory functionality/);
    assert.match(run.result.stderr, /MemoraX memory: .*Configured/);
    const config = await readFile(join(run.memoraxCodeHome, "config.toml"), "utf8");
    assert.match(tomlSectionText(config, "clients"), /^dsh = true(?:\s+#.*)?$/m);
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
    assert.match(config, /\[trace\.dsh\]/);
    assert.match(config, /enabled = true # Enable local DSH session memory trace collection\./);
    assert.match(config, /capture_content = true # Store content in local DSH trace events\./);
    assert.match(config, /\[trace\.opencode\]/);
    assert.match(config, /capture_content = true # Store content in local OpenCode trace events\./);
    assert.match(config, /\[trace\.codebuddy\]/);
    assert.match(config, /capture_content = true # Store content in local CodeBuddy trace events\./);
    assert.deepEqual(activeTomlSections(config), [
      "clients",
      "memorax",
      "memory.add",
      "memory.repo_update",
      "memory.retrieval",
      "memory.skill_reminder",
      "memory.writeback",
      "trace.claude",
      "trace.codebuddy",
      "trace.codex",
      "trace.dsh",
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


test("setup detects memory preferences before writing MemoraX config", async () => {
  const run = await runSetup({
    interactive: true,
    detectedUserId: "memorax-user",
    detectedLanguage: "en",
    memoraxVerify: {},
  });
  try {
    assert.equal(run.result.code, 0, run.result.stderr);
    assert.match(run.result.stderr, /MemoraX Code requires MemoraX for its core remote-memory functionality/);
    assert.match(run.result.stderr, /automatically send selected user prompts and final assistant answers to MemoraX/);
    assert.match(run.result.stderr, /Newly generated configuration enables automatic writeback/);
    assert.doesNotMatch(run.result.stderr, /register|Connect MemoraX Code to MemoraX now/i);
    assert.doesNotMatch(run.result.stderr, /Enable automatic writeback|Enable writeback now/);
    assert.match(run.result.stderr, /Username: memorax-user \(detected from the system account\)/);
    assert.match(run.result.stderr, /Preferred language: en \(detected from system settings\)/);
    assert.doesNotMatch(run.result.stderr, /Username \(used for your memories\)|Preferred language \[ZH\/en\]/);
    assert.doesNotMatch(run.result.stderr, /Do you already have a MemoraX account/);
    assert.doesNotMatch(run.result.stderr, /API key/i);
    assert.match(run.result.stderr, /Secure MemoraX credential is ready/);
    assert.doesNotMatch(run.result.stderr, /MemoraX endpoint/);
    assert.match(run.result.stderr, /MemoraX config written to/);
    assert.match(run.result.stderr, /first workspace-scoped memory request from a trusted workspace/);
    assert.match(run.result.stderr, /MemoraX memory: .*Configured/);
    assert.match(run.result.stderr, /Automatic writeback: .*Enabled/);
    assert.match(run.log, /^memorax-code start --clients codex,claude,dsh$/m);
    assert.match(run.log, /^memorax-cli status --json --config-only$/m);
    assert.ok(run.log.indexOf("trial-provision") < run.log.indexOf("memorax-code start --clients codex,claude,dsh"));
    assert.equal(`${run.result.stdout}\n${run.result.stderr}\n${run.log}`.includes(trialApiKey), false);
    assert.equal(run.memoraxRequests.length, 0);
    const config = await readFile(join(run.memoraxCodeHome, "config.toml"), "utf8");
    assert.match(config, /\[memorax\]/);
    assert.ok(config.includes(`endpoint = "${run.memoraxEndpoint}" # MemoraX service URL.`));
    assert.match(config, /user_id = "memorax-user" # Stable username; requests derive a workspace-scoped namespace\./);
    assert.ok(config.includes(`api_key = "${trialApiKey}" # MemoraX API key used by the local Backend.`));
    assert.doesNotMatch(config, /credential_source/);
    assert.doesNotMatch(config, /9001|9002/);
    assert.match(config, /\[memory\.add\]\r?\noutput_language = "en" # Language for newly generated MemoraX memories\./);
    assert.match(
      config,
      /# MemoraX remote-memory connection\.\r?\n\[memorax\]\r?\nendpoint = /,
    );
    assert.match(
      config,
      /user_id = "memorax-user" # Stable username; requests derive a workspace-scoped namespace\.\r?\napi_key = "sk_[A-Za-z0-9_-]+" # MemoraX API key used by the local Backend\.\r?\n\r?\n# Automatic Hook retrieval is opt-in\.\r?\n\[memory\.retrieval\]/,
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
    assert.match(config, /\[trace\.dsh\]/);
    assert.match(config, /enabled = true # Enable local DSH session memory trace collection\./);
    assert.match(config, /capture_content = true # Store content in local DSH trace events\./);
    assert.doesNotMatch(
      config,
      /top_k|k_dense|k_sparse|min_score|max_context_chars|max_item_chars|buffer_|chunk_|max_message_chars|timeout_ms|retention_days|max_event_chars|max_file_bytes/,
    );
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("setup configures an existing MemoraX account without trial provisioning", async () => {
  const apiKey = `sk_${"R".repeat(43)}`;
  const run = await runSetup({
    interactive: true,
    input: `\n${apiKey}\n`,
    setupMode: "existing-account",
    memoraxCodeConfig: [
      "[clients]",
      "codex = true",
      "claude = true",
      "",
      "[memorax]",
      'endpoint = "https://old-memorax.example"',
      'api_key = "old-secret"',
      'user_id = "old-user"',
      "",
      "[memory.add]",
      'output_language = "zh"',
      "",
    ].join("\n"),
    memoraxCodeConfigMode: 0o600,
    detectedUserId: "registered-user",
    detectedLanguage: "en",
    trialProvisionFailure: true,
  });
  try {
    assert.equal(run.result.code, 0, run.result.stderr);
    assert.match(run.result.stderr, /Username: <default>/);
    assert.doesNotMatch(run.result.stderr, /Do you already have a MemoraX account/);
    assert.doesNotMatch(run.result.stderr, /Reusing the existing MemoraX connection/);
    assert.match(run.result.stderr, /MemoraX API key: <provided>/);
    assert.match(run.result.stderr, /Existing MemoraX account connection configured/);
    assert.doesNotMatch(run.result.stderr, /Creating or restoring a secure MemoraX credential/);
    assert.doesNotMatch(`${run.result.stdout}\n${run.result.stderr}`, new RegExp(apiKey));
    assert.doesNotMatch(run.log, /^trial-provision$/m);
    const config = await readFile(join(run.memoraxCodeHome, "config.toml"), "utf8");
    assert.match(config, /user_id = "registered-user"/);
    assert.match(config, /output_language = "en"/);
    assert.ok(config.includes(`api_key = "${apiKey}" # MemoraX API key used by the local Backend.`));
    assert.doesNotMatch(config, /old-secret|old-user/);
    assert.doesNotMatch(config, /credential_source/);
    assert.equal((await stat(join(run.memoraxCodeHome, "config.toml"))).mode & 0o777, 0o600);
    await assertSetupComplete(run);
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("setup stops before client installation and Backend start when secure trial setup fails", async () => {
  const run = await runSetup({ trialProvisionFailure: true });
  try {
    assert.equal(run.result.code, 1, run.result.stderr);
    assert.match(run.result.stderr, /Secure MemoraX credential setup failed \(credential_failure\)/);
    assert.doesNotMatch(run.result.stderr, /redacted trial failure/);
    assert.match(run.log, /^trial-provision$/m);
    assert.doesNotMatch(run.log, /^memorax-code (?:codex-plugin install|start|status)/m);
    const config = await readFile(join(run.memoraxCodeHome, "config.toml"), "utf8");
    assert.doesNotMatch(config, /^(?!\s*#)\s*(?:user_id|api_key)\s*=/m);
    await assertSetupIncomplete(run);
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("setup rejects a non-interactive fresh run without side effects", async () => {
  const run = await runSetup({ interactive: false });
  try {
    assert.equal(run.result.code, 1, run.result.stderr);
    assert.match(run.result.stderr, /Setup requires an interactive terminal/);
    assert.doesNotMatch(run.result.stderr, /Connect MemoraX Code to MemoraX now/);
    assert.equal(run.log, "");
    await assert.rejects(
      readFile(join(run.memoraxCodeHome, "config.toml"), "utf8"),
      (error) => error?.code === "ENOENT",
    );
    await assertSetupIncomplete(run);
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});


test("interactive setup after reinstall automatically reuses a complete MemoraX configuration", async () => {
  const existingConfig = [
    "[clients]",
    "codex = true",
    "claude = true",
    "",
    "[memorax]",
    'endpoint = "https://memorax.example"',
    'api_key = "existing-secret"',
    'user_id = "existing-user"',
    "",
    "[memory.add]",
    'output_language = "en"',
    "",
    "[memory.writeback]",
    "enabled = false",
    "",
  ].join("\n");
  const run = await runSetup({
    existingCache: false,
    memoraxCodeConfig: existingConfig,
  });
  try {
    assert.equal(run.result.code, 0, run.result.stderr);
    assert.match(run.result.stderr, /Reusing the existing MemoraX connection and memory preferences/);
    assert.doesNotMatch(run.result.stderr, /Use the saved connection and memory preferences/);
    assert.doesNotMatch(run.result.stderr, /Connect MemoraX Code to MemoraX now/);
    assert.doesNotMatch(run.result.stderr, /No MemoraX connection response was received/);
    assert.doesNotMatch(run.result.stderr, /Username|Preferred language|MemoraX API key/);
    assert.doesNotMatch(run.result.stderr, /existing-secret|existing-user/);
    assert.match(run.log, /^memorax-code codex-plugin activate --yes$/m);
    assert.match(run.result.stderr, /MemoraX memory: .*Configured/);
    assert.match(run.result.stderr, /Automatic writeback: Disabled by effective configuration/);
    assert.equal(
      await readFile(join(run.memoraxCodeHome, "config.toml"), "utf8"),
      existingConfig.replace("[clients]\n", "[clients]\ncodebuddy = false\nopencode = false\n"),
    );
    await assertSetupComplete(run);
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});


test("reconfigure mode replaces a reusable MemoraX configuration", async () => {
  const existingConfig = [
    "[clients]",
    "codex = true",
    "claude = true",
    "",
    "[memorax]",
    'endpoint = "https://memorax.example"',
    'api_key = "existing-secret"',
    'user_id = "existing-user"',
    "",
    "[memory.add]",
    'output_language = "en"',
    "",
  ].join("\n");
  const run = await runSetup({
    memoraxCodeConfig: existingConfig,
    setupMode: "reconfigure",
  });
  try {
    assert.equal(run.result.code, 0, run.result.stderr);
    assert.doesNotMatch(run.result.stderr, /Reusing the existing MemoraX connection and memory preferences/);
    assert.doesNotMatch(run.result.stderr, /Use the saved connection and memory preferences/);
    assert.match(run.result.stderr, /Username: memory-user \(detected from the system account\)/);
    const config = await readFile(join(run.memoraxCodeHome, "config.toml"), "utf8");
    assert.match(config, /user_id = "memory-user"/);
    assert.ok(config.includes(`api_key = "${trialApiKey}" # MemoraX API key used by the local Backend.`));
    assert.doesNotMatch(config, /existing-secret/);
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});


test("setup recognizes environment-only MemoraX credentials", async () => {
  const run = await runSetup({
    memoraxEnv: {
      MEMORAX_CODE_MEMORAX_API_KEY: "environment-secret",
      MEMORAX_CODE_MEMORAX_USER_ID: "environment-user",
    },
  });
  try {
    assert.equal(run.result.code, 0, run.result.stderr);
    assert.match(run.result.stderr, /Reusing the existing MemoraX connection and memory preferences/);
    assert.match(run.result.stderr, /MemoraX memory: .*Configured/);
    assert.match(run.result.stderr, /Automatic writeback: .*Enabled/);
    assert.doesNotMatch(run.result.stderr, /environment-secret|environment-user/);
    const config = await readFile(join(run.memoraxCodeHome, "config.toml"), "utf8");
    assert.doesNotMatch(config, /environment-secret|environment-user/);
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});


test("setup writes the platform endpoint when no override is supplied", async () => {
  const run = await runSetup({
    interactive: true,
  });
  try {
    assert.equal(run.result.code, 0, run.result.stderr);
    assert.match(run.result.stderr, /Secure MemoraX credential is ready/);
    const config = await readFile(join(run.memoraxCodeHome, "config.toml"), "utf8");
    assert.match(config, /endpoint = "https:\/\/platform\.memorax\.net" # MemoraX service URL\./);
    assert.match(config, /output_language = "zh" # Language for newly generated MemoraX memories\./);
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});


test("setup leaves malformed config byte-identical and emits a redacted warning", async () => {
  const malformed = '[memorax]\napi_key = "preserved-sensitive-secret"\nbroken = [\n';
  const run = await runSetup({
    memoraxCodeConfig: malformed,
    interactive: true,
  });
  try {
    assert.equal(run.result.code, 1, run.result.stderr);
    assert.equal(await readFile(join(run.memoraxCodeHome, "config.toml"), "utf8"), malformed);
    assert.doesNotMatch(run.result.stderr, /Existing MemoraX configuration detected/);
    assert.doesNotMatch(run.result.stderr, /preserved-sensitive-secret/);
    const warning = run.result.stderr.split(/\r?\n/).find((line) => line.includes("MemoraX Code config could not be safely updated or verified"));
    assert.ok(warning);
    assert.doesNotMatch(warning, /preserved-sensitive-secret|config\.toml|broken =/);
    assert.deepEqual(await readdir(run.memoraxCodeHome), ["config.toml"]);
    assert.doesNotMatch(run.log, /^memorax-code start/m);
    await assertSetupIncomplete(run);
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});


test("setup recovers from a failed backend start and prints red diagnostics", async () => {
  const run = await runSetup({ failStartOnce: true });
  try {
    assert.equal(run.result.code, 0, run.result.stderr);
    assert.match(run.log, /^memorax-code start --clients codex,claude,dsh$/m);
    assert.match(run.log, /^memorax-code stop --clients codex,claude,dsh$/m);
    assert.match(run.log, /^memorax-code start --clients codex,claude,dsh$/m);
    assert.match(run.log, /^memorax-code status --clients codex,claude,dsh$/m);
    assert.match(run.result.stderr, /Backend start failed during setup/);
    assert.match(run.result.stderr, /\[MemoraX Code Backend\]: fake memorax-code start failure/);
    assert.match(run.result.stderr, /Attempting automatic recovery: `memorax-code stop` then `memorax-code start`/);
    assert.match(run.result.stderr, /\[MemoraX Code Backend\]: fake memorax-code stop output/);
    assert.match(run.result.stderr, /Backend start completed after automatic recovery/);
    assert.match(run.result.stderr, /Backend status check completed/);
    await assertSetupComplete(run);
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("setup does not stop adapters after a deterministic connection authority failure", async () => {
  const run = await runSetup({ connectionAuthorityFailure: true });
  try {
    assert.equal(run.result.code, 1, run.result.stderr);
    assert.equal((run.log.match(/^memorax-code start --clients codex,claude,dsh$/gm) ?? []).length, 1);
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
    await assertSetupIncomplete(run);
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});


test("setup reports unavailable status and prints red diagnostics instead of usage reminders", async () => {
  const run = await runSetup({ unavailableStatus: true });
  try {
    assert.equal(run.result.code, 1, run.result.stderr);
    assert.match(run.log, /^memorax-code status --clients codex,claude,dsh$/m);
    assert.match(run.result.stderr, /\[MemoraX Code Backend\]: codex adapter: not enabled integration=hooks/);
    assert.match(run.result.stderr, /\[MemoraX Code Backend\]: claude adapter: ok integration=hooks skills=ok/);
    assert.match(run.result.stderr, /Backend and selected adapters: .*Unavailable/);
    assert.match(run.result.stderr, /MemoraX Code is not enabled for new client sessions/);
    assert.match(run.result.stderr, /Check `memorax-code status`, the selected adapter status commands, and `memorax-code-codebuddy status`/);
    assert.doesNotMatch(run.result.stderr, /Restart or refresh Codex/);
    assert.doesNotMatch(run.result.stderr, /enable the MemoraX Code Codex Adapter plugin/);
    assert.match(run.result.stderr, /\[MemoraX Code Setup\]: Common commands:/);
    assert.match(run.result.stderr, /\[MemoraX Code Setup\]: - `memorax-code start`: start or refresh the local memory backend and client integrations/);
    await assertSetupIncomplete(run);
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("automatic update setup is non-interactive and preserves disabled clients", async () => {
  const added = codexHook("automatic-update", "sha256:automatic-update");
  const existingConfig = [
    "[clients]",
    "codex = true",
    "claude = false",
    "dsh = false",
    "opencode = false",
    "codebuddy = false",
    "",
    "[memorax]",
    'endpoint = "https://existing-memorax.example"',
    'api_key = "existing-api-key"',
    'user_id = "existing-user-id"',
    "",
    "[memory.add]",
    'output_language = "en"',
    "",
  ].join("\n");
  const run = await runSetup({
    codebuddyAvailable: true,
    dshProfiles: ["default"],
    existingCache: true,
    hookSnapshot: [],
    hookUpdatePlan: [added],
    interactive: false,
    memoraxCodeConfig: existingConfig,
    memoraxEnv: { MEMORAX_CODE_SETUP_AUTOMATIC_UPDATE: "1" },
    opencodeAvailable: true,
    updateMode: true,
  });
  try {
    assert.equal(run.result.code, 0, run.result.stderr);
    assert.doesNotMatch(run.result.stderr, /Enable it now\?/);
    assert.doesNotMatch(run.result.stderr, /Trust these new or changed Codex Hooks\?/);
    assert.match(run.result.stderr, /Trusted 1 new or changed MemoraX Code Codex Hook/);
    assert.match(run.log, /^memorax-code start --clients codex$/m);
    assert.match(run.log, /^memorax-code codex-plugin trust-hooks --yes .*--json$/m);
    const config = await readFile(join(run.memoraxCodeHome, "config.toml"), "utf8");
    assert.match(config, /codex = true/);
    assert.match(config, /claude = false/);
    assert.match(config, /dsh = false/);
    assert.match(config, /opencode = false/);
    assert.match(config, /codebuddy = false/);
    await assertSetupComplete(run);
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("automatic update setup preserves configured and legacy DSH client intent", async () => {
  const existingConfig = [
    "[clients]",
    "codex = true",
    "claude = true",
    "opencode = true",
    "codebuddy = true",
    "",
  ].join("\n");
  const run = await runSetup({
    claudeAvailable: false,
    dshProfiles: ["default"],
    existingCache: true,
    interactive: false,
    memoraxCodeConfig: existingConfig,
    memoraxEnv: { MEMORAX_CODE_SETUP_AUTOMATIC_UPDATE: "1" },
    updateMode: true,
  });
  try {
    assert.equal(run.result.code, 0, run.result.stderr);
    assert.match(run.result.stderr, /DeepSeek Harness profiles: found \(default\)/);
    assert.match(run.result.stderr, /Claude Code runtime was not detected; skipping its adapter setup/);
    assert.match(run.result.stderr, /OpenCode runtime or configuration was not detected; skipping its adapter setup/);
    assert.match(run.result.stderr, /CodeBuddy\/WorkBuddy runtime was not detected; skipping its adapter setup/);
    assert.match(run.log, /^memorax-code start --clients all$/m);
    assert.match(run.log, /^memorax-code status --clients all$/m);
    await assertSetupComplete(run);
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("automatic update setup refuses a changed Codex marketplace identity", async () => {
  const existingConfig = [
    "[clients]",
    "codex = true",
    "claude = false",
    "dsh = false",
    "opencode = false",
    "codebuddy = false",
    "",
    "[memorax]",
    'endpoint = "https://existing-memorax.example"',
    'api_key = "existing-api-key"',
    'user_id = "existing-user-id"',
    "",
    "[memory.add]",
    'output_language = "en"',
    "",
  ].join("\n");
  const run = await runSetup({
    existingCache: true,
    hookFullReview: true,
    hookSnapshot: [codexHook("existing", "sha256:existing", { trustStatus: "trusted" })],
    hookUpdatePlan: [codexHook("changed", "sha256:changed")],
    interactive: false,
    memoraxCodeConfig: existingConfig,
    memoraxEnv: { MEMORAX_CODE_SETUP_AUTOMATIC_UPDATE: "1" },
    updateMode: true,
  });
  try {
    assert.equal(run.result.code, 1, run.result.stderr);
    assert.match(run.result.stderr, /marketplace identity changed/);
    assert.match(run.result.stderr, /Automatic update stopped because the current MemoraX Code Codex Hooks could not be verified and trusted/);
    assert.doesNotMatch(run.log, /^memorax-code codex-plugin trust-hooks --yes/m);
    assert.doesNotMatch(run.log, /^memorax-code start/m);
    await assertSetupIncomplete(run);
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});
