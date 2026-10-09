#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { dirname, join, resolve } from "node:path";

const assertions = {
  npmInstallOk: false,
  clientProviderConfigPreserved: false,
  pluginInstalled: false,
  pluginHooksTrusted: false,
  pluginVersionExact: false,
  hookAssetsPresent: false,
  ensureBackendHookStarted: false,
  backendHealthy: false,
  adapterReady: false,
  sessionStartHookExecuted: false,
  userPromptHookExecuted: false,
  writebackHookExecuted: false,
  hookAuthForwarded: false,
  workspaceCwdExact: false,
  sessionRegistryExact: false,
  stopRemovedProcess: false,
  restartHealthy: false,
  uninstallRemovedProcess: false,
  uninstallReleasedPort: false,
  uninstallRemovedPlugin: false,
  pluginRegistrationRemoved: false,
  pluginCacheRemoved: false,
  npmPackageRemoved: false,
  managedChildProcessesRemoved: false,
  userStatePreserved: false,
  sentinelBytesPreserved: false,
};

let recorder;
let failure;

try {
  await main();
} catch (error) {
  failure = safeFailureMessage(error);
} finally {
  await recorder?.close();
}

console.log(JSON.stringify(assertions, null, 2));
if (failure || Object.values(assertions).some((value) => value !== true)) {
  console.error(`windows_codex_e2e_failed: ${failure ?? "assertion_failed"}`);
  process.exitCode = 1;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const prefix = resolve(required(options, "prefix"));
  const workspace = resolve(required(options, "workspace"));
  const port = parsePort(options.port ?? "18788");
  const codexCommand = options["codex-command"] ?? "codex";
  const home = resolve(requiredEnv("HOME"));
  const userProfile = resolve(requiredEnv("USERPROFILE"));
  const codexHome = resolve(requiredEnv("CODEX_HOME"));
  const memoraxCodeHome = resolve(requiredEnv("MEMORAX_CODE_HOME"));
  const packageRoot = join(prefix, "node_modules", "@memorax/memorax-code");
  const memoraxCode = join(packageRoot, "bin", "memorax-code.mjs");
  const backendUrl = `http://127.0.0.1:${port}`;
  const childEnv = {
    ...process.env,
    MEMORAX_CODE_BACKEND_PORT: String(port),
    MEMORAX_CODE_BACKEND_URL: backendUrl,
    WINDOWS_CODEX_PROVIDER_KEY: "windows-codex-provider-sentinel",
  };
  process.chdir(workspace);

  assertions.npmInstallOk = await isDirectory(packageRoot);
  if (!assertions.npmInstallOk) throw new Error("installed npm package is missing");
  await requireCodexOnlySelection(memoraxCodeHome);
  await writeClientOwnedProviderConfig(codexHome);

  await runJson(
    memoraxCode,
    [
      "stop",
      "--json",
      "--clients",
      "codex",
      "--codex-home",
      codexHome,
      "--codex-command",
      codexCommand,
      "--port",
      String(port),
    ],
    childEnv,
  );

  const activated = await runJson(
    memoraxCode,
    [
      "codex-plugin",
      "activate",
      "--json",
      "--yes",
      "--codex-home",
      codexHome,
      "--codex-command",
      codexCommand,
      "--workspace",
      workspace,
    ],
    childEnv,
  );
  const pluginRoot = activated.install?.pluginSourcePath;
  assertions.pluginInstalled = activated.ok === true
    && typeof pluginRoot === "string"
    && await isDirectory(pluginRoot);
  assertions.pluginHooksTrusted = Number.isSafeInteger(activated.trustedHooks)
    && activated.trustedHooks > 0
    && activated.trustedHooks === activated.hooks?.length;
  assertions.pluginVersionExact = await pluginVersionMatches(packageRoot, pluginRoot);
  assertions.hookAssetsPresent = await installedHookAssetsPresent(pluginRoot);
  if (!assertions.pluginInstalled
    || !assertions.pluginHooksTrusted
    || !assertions.pluginVersionExact
    || !assertions.hookAssetsPresent) {
    throw new Error("Codex plugin activation contract failed");
  }

  const hookEnv = {
    ...childEnv,
    CODEX_HOME: codexHome,
    MEMORAX_CODE_HOME: memoraxCodeHome,
    PLUGIN_ROOT: pluginRoot,
  };
  const sessionId = "windows-codex-hook-session";
  const transcriptPath = join(workspace, "windows-codex-transcript.jsonl");
  await writeFile(transcriptPath, '{"type":"session_meta","id":"windows-codex-hook-session"}\n');
  const sessionStartInput = {
    hook_event_name: "SessionStart",
    source: "startup",
    session_id: sessionId,
    transcript_path: transcriptPath,
    cwd: workspace,
  };
  const runtimeHook = join(pluginRoot, "hooks", "runtime-hook.mjs");
  const ensureBackendHook = [runtimeHook, "ensure-backend"];
  const ensure = await runHook(
    ensureBackendHook,
    hookEnv,
    sessionStartInput,
  );
  const firstState = await readJson(backendStatePath(memoraxCodeHome));
  assertions.ensureBackendHookStarted = ensure.code === 0 && isSafePid(firstState?.pid);
  const firstHealth = await backendHealth(firstState);
  assertions.backendHealthy = firstHealth?.service === "memorax-code-backend"
    && firstHealth?.instanceId === firstState?.instanceId;

  const status = await runJson(
    memoraxCode,
    [
      "status",
      "--json",
      "--clients",
      "codex",
      "--codex-home",
      codexHome,
      "--port",
      String(port),
    ],
    childEnv,
  );
  assertions.adapterReady = status.ok === true
    && status.codexAdapter?.ok !== false
    && status.codexAdapter?.installed === true
    && status.codexAdapter?.enabled === true
    && status.codexAdapter?.integration === "hooks"
    && status.codexAdapter?.codexSkills?.ok !== false;
  if (!assertions.ensureBackendHookStarted
    || !assertions.backendHealthy
    || !assertions.adapterReady) {
    throw new Error("Codex SessionStart Backend contract failed");
  }

  const captureHook = [runtimeHook, "capture-cwd"];
  const memoryHook = [runtimeHook, "memory-skill-reminder"];
  const writebackHook = [runtimeHook, "memory-writeback"];
  const capturedSession = await runHook(captureHook, hookEnv, sessionStartInput);
  const sessionState = await readJson(codexWorkspacePath(memoraxCodeHome));
  assertions.sessionStartHookExecuted = capturedSession.code === 0
    && sessionState?.latest?.event === "SessionStart"
    && sessionState?.latest?.sessionId === sessionId;

  recorder = await startMemoryHookRecorder();
  const memoryHookEnv = {
    ...hookEnv,
    MEMORAX_CODE_BACKEND_URL: recorder.url,
    MEMORAX_CODE_BACKEND_TOKEN: "windows-hook-token",
    MEMORAX_CODE_CODEX_MEMORY_HOOK_TIMEOUT_MS: "2000",
  };
  const userPromptInput = {
    hook_event_name: "UserPromptSubmit",
    session_id: sessionId,
    turn_id: "windows-codex-turn-1",
    transcript_path: transcriptPath,
    prompt: "Recall the Windows Hook contract.",
    cwd: workspace,
    workspace_kind: "project",
  };
  const capturedPrompt = await runHook(captureHook, hookEnv, userPromptInput);
  const userPrompt = await runHook(memoryHook, memoryHookEnv, userPromptInput);
  const userPromptOutput = parseJson(userPrompt.stdout);
  const turnStart = recorder.requests.find((request) => request.path === "/memory/turn-start");
  const reminder = recorder.requests.find((request) => request.path === "/memory/skill-reminder");
  assertions.userPromptHookExecuted = capturedPrompt.code === 0
    && userPrompt.code === 0
    && userPromptOutput?.hookSpecificOutput?.hookEventName === "UserPromptSubmit"
    && String(userPromptOutput?.hookSpecificOutput?.additionalContext ?? "")
      .includes("MemoraX Code reminder:")
    && userPromptOutput?.systemMessage === "windows Codex pending Add quota notice"
    && turnStart?.body?.sessionId === sessionId
    && turnStart?.body?.turnId === "windows-codex-turn-1"
    && turnStart?.body?.prompt === "Recall the Windows Hook contract."
    && samePath(turnStart?.body?.cwd, workspace)
    && samePath(turnStart?.body?.transcriptPath, transcriptPath)
    && reminder?.body?.version === 1
    && reminder?.body?.client === "codex"
    && reminder?.body?.sessionId === sessionId
    && reminder?.body?.turnId === "windows-codex-turn-1"
    && samePath(reminder?.body?.transcriptPath, transcriptPath);

  const stopInput = {
    hook_event_name: "Stop",
    session_id: sessionId,
    turn_id: "windows-codex-turn-1",
    transcript_path: transcriptPath,
    last_assistant_message: "Codex Hook writeback sentinel.",
    cwd: workspace,
    workspace_kind: "project",
  };
  const capturedStop = await runHook(captureHook, hookEnv, stopInput);
  const writeback = await runHook(writebackHook, memoryHookEnv, stopInput);
  const writebackRequest = recorder.requests.find(
    (request) => request.path === "/memory/writeback",
  );
  assertions.writebackHookExecuted = capturedStop.code === 0
    && writeback.code === 0
    && writebackRequest?.body?.sessionId === sessionId
    && writebackRequest?.body?.turnId === "windows-codex-turn-1"
    && writebackRequest?.body?.lastAssistantMessage === "Codex Hook writeback sentinel."
    && samePath(writebackRequest?.body?.transcriptPath, transcriptPath);

  const projectlessSessionId = "windows-codex-projectless-session";
  const projectlessWorkspace = join(
    userProfile,
    "Documents",
    "Codex",
    "2026-07-29",
    "new-chat",
  );
  const projectlessTranscriptPath = join(
    projectlessWorkspace,
    "windows-codex-projectless-transcript.jsonl",
  );
  await mkdir(projectlessWorkspace, { recursive: true });
  await writeFile(
    projectlessTranscriptPath,
    '{"type":"session_meta","id":"windows-codex-projectless-session"}\n',
  );
  const projectlessPrompt = await runHook(memoryHook, memoryHookEnv, {
    hook_event_name: "UserPromptSubmit",
    session_id: projectlessSessionId,
    turn_id: "windows-codex-projectless-turn-1",
    transcript_path: projectlessTranscriptPath,
    prompt: "Recall the Windows projectless Hook contract.",
    cwd: projectlessWorkspace,
  });
  const projectlessStop = await runHook(writebackHook, memoryHookEnv, {
    hook_event_name: "Stop",
    session_id: projectlessSessionId,
    turn_id: "windows-codex-projectless-turn-1",
    transcript_path: projectlessTranscriptPath,
    last_assistant_message: "Codex projectless Hook writeback sentinel.",
    cwd: projectlessWorkspace,
  });
  const projectlessTurnStart = recorder.requests.find(
    (request) => request.path === "/memory/turn-start"
      && request.body?.sessionId === projectlessSessionId,
  );
  const projectlessReminder = recorder.requests.find(
    (request) => request.path === "/memory/skill-reminder"
      && request.body?.sessionId === projectlessSessionId,
  );
  const projectlessWriteback = recorder.requests.find(
    (request) => request.path === "/memory/writeback"
      && request.body?.sessionId === projectlessSessionId,
  );
  assertions.userPromptHookExecuted = assertions.userPromptHookExecuted
    && projectlessPrompt.code === 0
    && projectlessTurnStart?.body?.workspaceKind === "projectless"
    && samePath(projectlessTurnStart?.body?.cwd, projectlessWorkspace)
    && projectlessReminder?.body?.workspaceKind === "projectless"
    && samePath(projectlessReminder?.body?.cwd, projectlessWorkspace);
  assertions.writebackHookExecuted = assertions.writebackHookExecuted
    && projectlessStop.code === 0
    && projectlessWriteback?.body?.workspaceKind === "projectless"
    && samePath(projectlessWriteback?.body?.cwd, projectlessWorkspace);
  assertions.hookAuthForwarded = recorder.requests.length === 6
    && recorder.requests.every(
      (request) => request.headers["x-memorax-code-backend-token"] === "windows-hook-token",
    );

  const workspaceState = await readJson(codexWorkspacePath(memoraxCodeHome));
  const registry = await readJson(codexSessionRegistryPath(memoraxCodeHome));
  const registered = registry?.sessions?.[sessionId];
  assertions.workspaceCwdExact = workspaceState?.latest?.event === "Stop"
    && workspaceState?.latest?.sessionId === sessionId
    && samePath(workspaceState?.latest?.cwd, workspace);
  assertions.sessionRegistryExact = registered?.codexSessionId === sessionId
    && samePath(registered?.workspace, workspace)
    && samePath(registered?.transcriptPath, transcriptPath);
  if (!assertions.sessionStartHookExecuted
    || !assertions.userPromptHookExecuted
    || !assertions.writebackHookExecuted
    || !assertions.hookAuthForwarded
    || !assertions.workspaceCwdExact
    || !assertions.sessionRegistryExact) {
    throw new Error("installed Codex Hook contract failed");
  }

  await createStateSentinels(memoraxCodeHome, workspace);
  const stopped = await runJson(
    memoraxCode,
    [
      "stop",
      "--json",
      "--clients",
      "codex",
      "--codex-home",
      codexHome,
      "--codex-command",
      codexCommand,
      "--port",
      String(port),
    ],
    childEnv,
  );
  assertions.stopRemovedProcess = stopped.ok === true
    && await waitForExit(firstState.pid)
    && await portCanBind(port);

  const restartedHook = await runHook(
    ensureBackendHook,
    hookEnv,
    sessionStartInput,
  );
  const restartedState = await readJson(backendStatePath(memoraxCodeHome));
  const restartedHealth = await backendHealth(restartedState);
  assertions.restartHealthy = restartedHook.code === 0
    && isSafePid(restartedState?.pid)
    && restartedState.pid !== firstState.pid
    && restartedHealth?.service === "memorax-code-backend"
    && restartedHealth?.instanceId === restartedState.instanceId;

  const uninstalled = await runJson(
    memoraxCode,
    [
      "uninstall",
      "--json",
      "--clients",
      "codex",
      "--codex-home",
      codexHome,
      "--codex-command",
      codexCommand,
      "--port",
      String(port),
    ],
    childEnv,
  );
  assertions.uninstallRemovedProcess = uninstalled.ok === true
    && await waitForExit(restartedState.pid);
  assertions.uninstallReleasedPort = await portCanBind(port);
  assertions.uninstallRemovedPlugin = !await exists(
    join(pluginRoot, ".codex-plugin", "plugin.json"),
  );
  assertions.pluginRegistrationRemoved = await marketplacePluginVersion(home) === undefined
    && !await exists(
      join(codexHome, ".memorax-code", "marketplaces", "memorax-code"),
    );
  assertions.pluginCacheRemoved = (await cachePluginVersions(codexHome)).length === 0;
  assertions.npmPackageRemoved = !await exists(packageRoot)
    && uninstalled.npmPackageRemoval?.ok === true
    && uninstalled.npmPackageRemoval?.skipped !== true;
  assertions.managedChildProcessesRemoved = await noProcessReferencesPrefix(prefix);
  assertions.clientProviderConfigPreserved = await clientOwnedProviderConfigPresent(codexHome);
  assertions.userStatePreserved = await isDirectory(memoraxCodeHome)
    && await codexSessionStateStillPresent(memoraxCodeHome, sessionId, workspace, transcriptPath);
  assertions.sentinelBytesPreserved = await sentinelsMatch(memoraxCodeHome, workspace);
}

async function startMemoryHookRecorder() {
  const requests = [];
  const server = createHttpServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += String(chunk);
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    requests.push({
      path,
      headers: request.headers,
      body: parseJson(raw) ?? {},
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(path === "/memory/turn-start"
      ? { ok: true, userNotice: "windows Codex pending Add quota notice" }
      : { ok: true }));
  });
  await new Promise((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", done);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("memory Hook recorder did not bind");
  return {
    requests,
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((done) => server.close(done)),
  };
}

async function runHook(command, childEnv, input) {
  return await run(process.execPath, command, childEnv, {
    stdin: JSON.stringify(input),
    nodeEntrypoint: false,
    timeoutMs: 45_000,
  });
}

async function runJson(entrypoint, args, childEnv) {
  const result = await run(entrypoint, args, childEnv);
  if (result.code !== 0) throw new Error("MemoraX Code command failed");
  return JSON.parse(result.stdout);
}

function run(entrypoint, args, childEnv, options = {}) {
  return new Promise((done) => {
    const nodeEntrypoint = options.nodeEntrypoint !== false;
    const child = spawn(
      nodeEntrypoint ? process.execPath : entrypoint,
      nodeEntrypoint ? [entrypoint, ...args] : args,
      {
        env: childEnv,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done({ ...result, timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      finish({ code: 124, stdout, stderr: "process_timeout" });
    }, options.timeoutMs ?? 120_000);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", () => finish({ code: 127, stdout, stderr: "process_spawn_failed" }));
    child.on("close", (code) => {
      finish({ code: timedOut ? 124 : (code ?? 1), stdout, stderr });
    });
    child.stdin.end(options.stdin ?? "");
  });
}

async function writeClientOwnedProviderConfig(codexHome) {
  await mkdir(codexHome, { recursive: true });
  await writeFile(join(codexHome, "config.toml"), [
    'model_provider = "windows-client-owned"',
    'model = "windows-e2e"',
    "",
    "[model_providers.windows-client-owned]",
    'name = "Windows client-owned provider sentinel"',
    'base_url = "http://127.0.0.1:9/v1"',
    'wire_api = "responses"',
    'env_key = "WINDOWS_CODEX_PROVIDER_KEY"',
    "requires_openai_auth = false",
    "",
  ].join("\n"));
}

async function clientOwnedProviderConfigPresent(codexHome) {
  const text = await readFile(join(codexHome, "config.toml"), "utf8").catch(() => "");
  return /model_provider\s*=\s*"windows-client-owned"/.test(text)
    && /model\s*=\s*"windows-e2e"/.test(text)
    && /\[model_providers\.windows-client-owned\]/.test(text)
    && /name\s*=\s*"Windows client-owned provider sentinel"/.test(text)
    && /base_url\s*=\s*"http:\/\/127\.0\.0\.1:9\/v1"/.test(text)
    && /wire_api\s*=\s*"responses"/.test(text)
    && /env_key\s*=\s*"WINDOWS_CODEX_PROVIDER_KEY"/.test(text)
    && /requires_openai_auth\s*=\s*false/.test(text);
}

async function requireCodexOnlySelection(memoraxCodeHome) {
  const text = await readFile(join(memoraxCodeHome, "config.toml"), "utf8").catch(() => "");
  const selection = parseClientSelection(text);
  if (selection.codex !== true || selection.claude !== false) {
    throw new Error("Windows Codex E2E requires [clients] codex=true and claude=false");
  }
}

function parseClientSelection(text) {
  let section = "";
  const result = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split("#", 1)[0].trim();
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1].trim();
      continue;
    }
    if (section !== "clients") continue;
    const field = line.match(/^(codex|claude)\s*=\s*(true|false)$/);
    if (field) result[field[1]] = field[2] === "true";
  }
  return result;
}

async function pluginVersionMatches(packageRoot, pluginRoot) {
  const expectedManifest = await readJson(
    join(packageRoot, "lib", "memorax-code-codex-adapter", ".codex-plugin", "plugin.json"),
  );
  const expectedShell = await readJson(
    join(packageRoot, "lib", "memorax-code-codex-adapter", "hooks", "runtime-shell.json"),
  );
  const pluginVersion = (await readJson(
    join(pluginRoot, ".codex-plugin", "plugin.json"),
  ))?.version;
  const installedShell = await readJson(join(pluginRoot, "hooks", "runtime-shell.json"));
  return typeof expectedManifest?.version === "string"
    && expectedManifest.version === expectedShell?.shellVersion
    && pluginVersion === expectedManifest.version
    && installedShell?.version === expectedShell?.version
    && installedShell?.runtimeAbi === expectedShell?.runtimeAbi
    && installedShell?.shellVersion === expectedShell?.shellVersion;
}

async function installedHookAssetsPresent(pluginRoot) {
  if (typeof pluginRoot !== "string") return false;
  const requiredPaths = [
    ".codex-plugin/plugin.json",
    "assets/composer-icon.png",
    "assets/logo.png",
    "hooks/hooks.json",
    "hooks/runtime-hook.mjs",
    "hooks/runtime-shell.json",
    "runtime-hooks/ensure-backend.mjs",
    "runtime-hooks/memory-skill-reminder.mjs",
    "runtime-hooks/memory-writeback.mjs",
    "memorax-code-adapter-common/src/hooks/client-hook-launcher.mjs",
    "memorax-code-adapter-common/src/clients/codex-plugin-artifact.mjs",
    "memorax-code-adapter-common/src/hooks/hook-runtime-generation.mjs",
    "memorax-code-adapter-common/src/hooks/capture-cwd-hook.mjs",
    "memorax-code-adapter-common/src/runtime-record.mjs",
  ];
  if (!(await Promise.all(
    requiredPaths.map((relativePath) => exists(join(pluginRoot, relativePath))),
  )).every(Boolean)) return false;
  const manifest = await readJson(join(pluginRoot, "hooks", "hooks.json"));
  const serialized = JSON.stringify(manifest);
  return serialized.includes("commandWindows")
    && serialized.includes("runtime-hook.mjs")
    && serialized.includes("ensure-backend")
    && serialized.includes("memory-skill-reminder")
    && serialized.includes("memory-writeback");
}

async function createStateSentinels(memoraxCodeHome, workspace) {
  const files = [
    ["memory/windows-codex-e2e.bin", "codex-memory-preserve-v1\u0000\u0001"],
    ["user-state/windows-codex-e2e.txt", "codex-user-state-preserve-v1\n"],
  ];
  for (const [relativePath, contents] of files) {
    const path = join(memoraxCodeHome, relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents);
  }
  const hashes = {};
  for (const [path] of files) hashes[path] = hash(await readFile(join(memoraxCodeHome, path)));
  await writeFile(
    join(workspace, "windows-codex-sentinel-hashes.json"),
    `${JSON.stringify(hashes)}\n`,
  );
}

async function sentinelsMatch(memoraxCodeHome, workspace) {
  const expected = await readJson(
    join(workspace, "windows-codex-sentinel-hashes.json"),
  );
  if (!expected || typeof expected !== "object") return false;
  for (const [path, digest] of Object.entries(expected)) {
    const contents = await readFile(join(memoraxCodeHome, path)).catch(() => undefined);
    if (!contents || hash(contents) !== digest) return false;
  }
  return true;
}

async function codexSessionStateStillPresent(memoraxCodeHome, sessionId, workspace, transcriptPath) {
  const state = await readJson(codexWorkspacePath(memoraxCodeHome));
  const registry = await readJson(codexSessionRegistryPath(memoraxCodeHome));
  return state?.latest?.sessionId === sessionId
    && samePath(state?.latest?.cwd, workspace)
    && registry?.sessions?.[sessionId]?.codexSessionId === sessionId
    && samePath(registry?.sessions?.[sessionId]?.transcriptPath, transcriptPath);
}

async function marketplacePluginVersion(home) {
  const marketplace = await readJson(join(home, ".agents", "plugins", "marketplace.json"));
  const entry = marketplace?.plugins?.find(
    (plugin) => plugin?.name === "memorax-code-codex-adapter",
  );
  if (typeof entry?.source?.path !== "string") return undefined;
  return (await readJson(
    resolve(home, entry.source.path, ".codex-plugin", "plugin.json"),
  ))?.version;
}

async function cachePluginVersions(codexHome) {
  const versions = [];
  for (const marketplace of ["memorax-code", "personal"]) {
    const root = join(
      codexHome,
      "plugins",
      "cache",
      marketplace,
      "memorax-code-codex-adapter",
    );
    if (!await isDirectory(root)) continue;
    for (const directory of await readdir(root)) {
      if (directory.startsWith(".")) continue;
      const version = (await readJson(
        join(root, directory, ".codex-plugin", "plugin.json"),
      ))?.version;
      if (typeof version === "string") versions.push(version);
    }
  }
  return versions;
}

async function noProcessReferencesPrefix(prefix) {
  if (process.platform !== "win32" || !process.env.SystemRoot) return false;
  const powershell = join(
    process.env.SystemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const result = await run(
    powershell,
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress",
    ],
    process.env,
    { nodeEntrypoint: false, timeoutMs: 30_000 },
  );
  if (result.code !== 0) return false;
  const parsed = JSON.parse(result.stdout || "[]");
  const records = Array.isArray(parsed) ? parsed : [parsed];
  const needle = prefix.toLowerCase();
  return !records.some((record) => record?.ProcessId !== process.pid
    && String(record?.CommandLine ?? "").toLowerCase().includes(needle));
}

async function backendHealth(state) {
  if (!state?.url) return undefined;
  try {
    const url = new URL("/health", state.url);
    if (!isLoopbackHostname(url.hostname)) return undefined;
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    return response.ok ? await response.json() : undefined;
  } catch {
    return undefined;
  }
}

function portCanBind(port) {
  return new Promise((done) => {
    const server = createTcpServer();
    server.once("error", () => done(false));
    server.listen(port, "127.0.0.1", () => server.close(() => done(true)));
  });
}

async function processAlive(pid) {
  if (!isSafePid(pid)) return false;
  try {
    process.kill(pid, 0);
    await new Promise((done) => setTimeout(done, 100));
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid, timeoutMs = 10_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!await processAlive(pid)) return true;
    await new Promise((done) => setTimeout(done, 100));
  }
  return !await processAlive(pid);
}

function codexWorkspacePath(memoraxCodeHome) {
  return join(memoraxCodeHome, "adapters", "codex", "workspaces.json");
}

function codexSessionRegistryPath(memoraxCodeHome) {
  return join(memoraxCodeHome, "adapters", "codex", "session-registry.json");
}

function backendStatePath(memoraxCodeHome) {
  return join(memoraxCodeHome, "runtime", "backend", "backend.pid.json");
}

function samePath(actual, expected) {
  if (typeof actual !== "string" || typeof expected !== "string") return false;
  const normalizedActual = resolve(actual);
  const normalizedExpected = resolve(expected);
  return process.platform === "win32"
    ? normalizedActual.toLowerCase() === normalizedExpected.toLowerCase()
    : normalizedActual === normalizedExpected;
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

async function readJson(path) {
  try {
    return JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/, ""));
  } catch {
    return undefined;
  }
}

async function exists(path) {
  return Boolean(await stat(path).catch(() => undefined));
}

async function isDirectory(path) {
  return Boolean((await stat(path).catch(() => undefined))?.isDirectory());
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    result[argv[index].replace(/^--/, "")] = argv[index + 1];
  }
  return result;
}

function required(values, name) {
  if (!values[name]) throw new Error(`--${name} is required`);
  return values[name];
}

function requiredEnv(name) {
  if (!process.env[name]) throw new Error(`${name} is required`);
  return process.env[name];
}

function parsePort(value) {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("--port must be an integer between 1 and 65535");
  }
  return port;
}

function isSafePid(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isLoopbackHostname(value) {
  return value === "127.0.0.1" || value === "localhost" || value === "[::1]";
}

function safeFailureMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/authorization|bearer|api[\s_-]?key|token|password|secret|credential|cookie|[A-Za-z]:[\\/]|\/(?:Users|home)\//i.test(message)) {
    return "details_redacted";
  }
  return message.slice(0, 300);
}
