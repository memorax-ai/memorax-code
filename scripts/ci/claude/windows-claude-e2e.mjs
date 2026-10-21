#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { dirname, join, resolve } from "node:path";

const assertions = {
  npmInstallOk: false,
  clientProviderSettingsPreserved: false,
  pluginInstalled: false,
  pluginEnabled: false,
  pluginVersionExact: false,
  hookAssetsPresent: false,
  initialBackendHealthy: false,
  stopRemovedProcess: false,
  ensureBackendHookStarted: false,
  backendHealthy: false,
  restartHealthy: false,
  adapterReady: false,
  sessionStartHookExecuted: false,
  memoryCliSessionBound: false,
  userPromptTurnStartHookExecuted: false,
  userPromptReminderHookExecuted: false,
  writebackHookExecuted: false,
  hookAuthForwarded: false,
  workspaceCwdExact: false,
  sessionRegistryExact: false,
  uninstallRemovedProcess: false,
  uninstallReleasedPort: false,
  uninstallRemovedPlugin: false,
  pluginRegistrationRemoved: false,
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
  console.error(`windows_claude_e2e_failed: ${failure ?? "assertion_failed"}`);
  process.exitCode = 1;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const prefix = resolve(required(options, "prefix"));
  const workspace = resolve(required(options, "workspace"));
  const port = parsePort(options.port ?? "18789");
  const claudeCommand = options["claude-command"] ?? "claude";
  const claudeHome = resolve(requiredEnv("CLAUDE_CONFIG_DIR"));
  const memoraxCodeHome = resolve(requiredEnv("MEMORAX_CODE_HOME"));
  const packageRoot = join(prefix, "node_modules", "@memorax/memorax-code");
  const memoraxCode = join(packageRoot, "bin", "memorax-code.mjs");
  const backendUrl = `http://127.0.0.1:${port}`;
  const childEnv = {
    ...process.env,
    CLAUDE_CONFIG_DIR: claudeHome,
    MEMORAX_CODE_BACKEND_PORT: String(port),
    MEMORAX_CODE_BACKEND_URL: backendUrl,
    MEMORAX_CODE_CLAUDE_COMMAND: claudeCommand,
  };
  process.chdir(workspace);

  assertions.npmInstallOk = await isDirectory(packageRoot);
  if (!assertions.npmInstallOk) throw new Error("installed npm package is missing");
  await requireClaudeOnlySelection(memoraxCodeHome);
  await writeClientOwnedProviderSettings(claudeHome);

  await runJson(
    memoraxCode,
    [
      "stop",
      "--json",
      "--clients",
      "claude",
      "--claude-home",
      claudeHome,
      "--claude-command",
      claudeCommand,
      "--port",
      String(port),
    ],
    childEnv,
  );

  const started = await runJson(
    memoraxCode,
    [
      "start",
      "--json",
      "--clients",
      "claude",
      "--claude-home",
      claudeHome,
      "--claude-command",
      claudeCommand,
      "--port",
      String(port),
    ],
    childEnv,
  );
  const firstState = await readJson(backendStatePath(memoraxCodeHome));
  const pluginInstall = started.claudeAdapter?.pluginInstall;
  const pluginRoot = pluginInstall?.installPath;
  assertions.pluginInstalled = pluginInstall?.ok === true
    && typeof pluginRoot === "string"
    && await isDirectory(pluginRoot);
  assertions.pluginEnabled = pluginInstall?.enabled === true
    && started.claudeAdapter?.installed === true
    && started.claudeAdapter?.enabled === true;
  assertions.pluginVersionExact = await pluginVersionMatches(
    packageRoot,
    pluginRoot,
    pluginInstall?.pluginVersion,
  );
  assertions.hookAssetsPresent = await installedHookAssetsPresent(pluginRoot);
  const firstHealth = await backendHealth(firstState);
  assertions.initialBackendHealthy = started.backend?.ok === true
    && isSafePid(firstState?.pid)
    && firstHealth?.service === "memorax-code-backend"
    && firstHealth?.instanceId === firstState?.instanceId;
  if (!assertions.pluginInstalled
    || !assertions.pluginEnabled
    || !assertions.pluginVersionExact
    || !assertions.hookAssetsPresent
    || !assertions.initialBackendHealthy) {
    throw new Error("Claude plugin installation contract failed");
  }

  const stopped = await runJson(
    memoraxCode,
    [
      "stop",
      "--json",
      "--clients",
      "claude",
      "--claude-home",
      claudeHome,
      "--claude-command",
      claudeCommand,
      "--port",
      String(port),
    ],
    childEnv,
  );
  assertions.stopRemovedProcess = stopped.ok === true
    && await waitForExit(firstState.pid)
    && await portCanBind(port);
  if (!assertions.stopRemovedProcess) {
    throw new Error("Claude lifecycle stop contract failed");
  }

  const hookEnv = {
    ...childEnv,
    CLAUDE_PLUGIN_ROOT: pluginRoot,
    PLUGIN_ROOT: pluginRoot,
  };
  const sessionId = "windows-claude-hook-session";
  const transcriptPath = join(workspace, "windows-claude-transcript.jsonl");
  await writeFile(transcriptPath, '{"type":"session_meta","id":"windows-claude-hook-session"}\n');
  const sessionStartInput = {
    hook_event_name: "SessionStart",
    source: "startup",
    session_id: sessionId,
    transcript_path: transcriptPath,
    cwd: workspace,
  };
  const runtimeHook = join(pluginRoot, "hooks", "runtime-hook.mjs");
  const ensure = await runHook(
    [runtimeHook, "ensure-backend"],
    hookEnv,
    sessionStartInput,
  );
  const restartedState = await readJson(backendStatePath(memoraxCodeHome));
  assertions.ensureBackendHookStarted = ensure.code === 0 && isSafePid(restartedState?.pid);
  const restartedHealth = await backendHealth(restartedState);
  assertions.backendHealthy = restartedHealth?.service === "memorax-code-backend"
    && restartedHealth?.instanceId === restartedState?.instanceId;
  assertions.restartHealthy = isSafePid(restartedState?.pid)
    && restartedState.pid !== firstState.pid;

  const status = await runJson(
    memoraxCode,
    [
      "status",
      "--json",
      "--clients",
      "claude",
      "--claude-home",
      claudeHome,
      "--claude-command",
      claudeCommand,
      "--port",
      String(port),
    ],
    childEnv,
  );
  assertions.adapterReady = status.ok === true
    && status.claudeAdapter?.ok === true
    && status.claudeAdapter?.installed === true
    && status.claudeAdapter?.enabled === true
    && status.claudeAdapter?.integration === "hooks"
    && status.claudeAdapter?.pluginStatus?.installed === true
    && status.claudeAdapter?.pluginStatus?.enabled === true
    && status.claudeAdapter?.claudeSkills?.ok === true
    && status.claudeAdapter?.claudeSkills?.status === "plugin-managed";
  if (!assertions.ensureBackendHookStarted
    || !assertions.backendHealthy
    || !assertions.restartHealthy
    || !assertions.adapterReady) {
    throw new Error("Claude SessionStart Backend contract failed");
  }

  const captureHook = [runtimeHook, "capture-cwd"];
  const memoryTurnHook = [runtimeHook, "memory-turn"];
  const memoryCliSessionHook = [runtimeHook, "memory-cli-session"];
  const reminderHook = [runtimeHook, "memory-skill-reminder"];
  const capturedSession = await runHook(captureHook, hookEnv, sessionStartInput);
  const sessionEnvFile = join(memoraxCodeHome, "windows-claude-session-env.sh");
  await writeFile(sessionEnvFile, "");
  const boundMemoryCliSession = await runHook(
    memoryCliSessionHook,
    { ...hookEnv, CLAUDE_ENV_FILE: sessionEnvFile },
    sessionStartInput,
  );
  const sessionEnv = await readFile(sessionEnvFile, "utf8");
  const sessionState = await readJson(claudeWorkspacePath(memoraxCodeHome));
  assertions.sessionStartHookExecuted = capturedSession.code === 0
    && sessionState?.latest?.event === "SessionStart"
    && sessionState?.latest?.sessionId === sessionId;
  assertions.memoryCliSessionBound = boundMemoryCliSession.code === 0
    && sessionEnv.includes("MEMORAX_CODE_MEMORY_CLI_TRACE_CLIENT='claude'")
    && sessionEnv.includes(`MEMORAX_CODE_MEMORY_CLI_TRACE_SESSION_ID='${sessionId}'`);

  recorder = await startMemoryHookRecorder();
  const memoryHookEnv = {
    ...hookEnv,
    MEMORAX_CODE_BACKEND_URL: recorder.url,
    MEMORAX_CODE_BACKEND_TOKEN: "windows-hook-token",
    MEMORAX_CODE_CLAUDE_MEMORY_HOOK_TIMEOUT_MS: "2000",
  };
  const userPromptInput = {
    hook_event_name: "UserPromptSubmit",
    session_id: sessionId,
    prompt_id: "windows-claude-prompt-1",
    transcript_path: transcriptPath,
    prompt: "Recall the Windows Claude Hook contract.",
    cwd: workspace,
    workspace_kind: "project",
  };
  const capturedPrompt = await runHook(captureHook, hookEnv, userPromptInput);
  const turnStartHook = await runHook(memoryTurnHook, memoryHookEnv, userPromptInput);
  const reminder = await runHook(reminderHook, memoryHookEnv, userPromptInput);
  const turnStartOutput = parseJson(turnStartHook.stdout);
  const reminderOutput = parseJson(reminder.stdout);
  const turnStart = recorder.requests.find((request) => request.path === "/memory/turn-start");
  const reminderTrace = recorder.requests.find(
    (request) => request.path === "/memory/skill-reminder",
  );
  assertions.userPromptTurnStartHookExecuted = capturedPrompt.code === 0
    && turnStartHook.code === 0
    && turnStartOutput?.systemMessage === "windows Claude pending Add quota notice"
    && turnStartOutput?.hookSpecificOutput === undefined
    && turnStart?.body?.client === "claude-code"
    && turnStart?.body?.sessionId === sessionId
    && turnStart?.body?.promptId === "windows-claude-prompt-1"
    && turnStart?.body?.prompt === "Recall the Windows Claude Hook contract."
    && samePath(turnStart?.body?.cwd, workspace)
    && samePath(turnStart?.body?.transcriptPath, transcriptPath);
  assertions.userPromptReminderHookExecuted = reminder.code === 0
    && reminderOutput?.hookSpecificOutput?.hookEventName === "UserPromptSubmit"
    && String(reminderOutput?.hookSpecificOutput?.additionalContext ?? "")
      .includes("MemoraX Code reminder:")
    && reminderTrace?.body?.version === 1
    && reminderTrace?.body?.client === "claude-code"
    && reminderTrace?.body?.sessionId === sessionId
    && reminderTrace?.body?.promptId === "windows-claude-prompt-1"
    && samePath(reminderTrace?.body?.transcriptPath, transcriptPath);

  const stopInput = {
    hook_event_name: "Stop",
    session_id: sessionId,
    prompt_id: "windows-claude-prompt-1",
    transcript_path: transcriptPath,
    last_assistant_message: "Claude Hook writeback sentinel.",
    cwd: workspace,
    workspace_kind: "project",
  };
  const capturedStop = await runHook(captureHook, hookEnv, stopInput);
  const writeback = await runHook(memoryTurnHook, memoryHookEnv, stopInput);
  const writebackRequest = recorder.requests.find(
    (request) => request.path === "/memory/writeback",
  );
  assertions.writebackHookExecuted = capturedStop.code === 0
    && writeback.code === 0
    && writebackRequest?.body?.client === "claude-code"
    && writebackRequest?.body?.sessionId === sessionId
    && writebackRequest?.body?.promptId === "windows-claude-prompt-1"
    && writebackRequest?.body?.lastAssistantMessage === "Claude Hook writeback sentinel."
    && samePath(writebackRequest?.body?.transcriptPath, transcriptPath);
  assertions.hookAuthForwarded = recorder.requests.length === 3
    && recorder.requests.every(
      (request) => request.headers["x-memorax-code-backend-token"] === "windows-hook-token",
    );

  const workspaceState = await readJson(claudeWorkspacePath(memoraxCodeHome));
  const registry = await readJson(claudeSessionRegistryPath(memoraxCodeHome));
  const registered = registry?.sessions?.[sessionId];
  assertions.workspaceCwdExact = workspaceState?.latest?.event === "Stop"
    && workspaceState?.latest?.sessionId === sessionId
    && samePath(workspaceState?.latest?.cwd, workspace);
  assertions.sessionRegistryExact = registered?.claudeSessionId === sessionId
    && samePath(registered?.workspace, workspace)
    && samePath(registered?.transcriptPath, transcriptPath);
  if (!assertions.sessionStartHookExecuted
    || !assertions.memoryCliSessionBound
    || !assertions.userPromptTurnStartHookExecuted
    || !assertions.userPromptReminderHookExecuted
    || !assertions.writebackHookExecuted
    || !assertions.hookAuthForwarded
    || !assertions.workspaceCwdExact
    || !assertions.sessionRegistryExact) {
    throw new Error("installed Claude Hook contract failed");
  }

  await createStateSentinels(memoraxCodeHome, claudeHome, workspace);
  const uninstalled = await runJson(
    memoraxCode,
    [
      "uninstall",
      "--json",
      "--clients",
      "claude",
      "--claude-home",
      claudeHome,
      "--claude-command",
      claudeCommand,
      "--port",
      String(port),
    ],
    childEnv,
  );
  assertions.uninstallRemovedProcess = uninstalled.ok === true
    && await waitForExit(restartedState.pid);
  assertions.uninstallReleasedPort = await portCanBind(port);
  assertions.uninstallRemovedPlugin = uninstalled.claudeAdapter?.pluginRemove?.ok === true;
  const finalSettings = await readJson(join(claudeHome, "settings.json"));
  assertions.pluginRegistrationRemoved = pluginRegistrationAbsent(finalSettings)
    && (await claudePluginStateRecords(memoraxCodeHome)).length === 0;
  assertions.npmPackageRemoved = !await exists(packageRoot)
    && uninstalled.npmPackageRemoval?.ok === true
    && uninstalled.npmPackageRemoval?.skipped !== true;
  assertions.managedChildProcessesRemoved = await noProcessReferencesPrefix(prefix);
  assertions.clientProviderSettingsPreserved = clientOwnedProviderSettingsPresent(finalSettings);
  assertions.userStatePreserved = await isDirectory(memoraxCodeHome)
    && await isDirectory(claudeHome)
    && await claudeSessionStateStillPresent(
      memoraxCodeHome,
      sessionId,
      workspace,
      transcriptPath,
    );
  assertions.sentinelBytesPreserved = await sentinelsMatch(
    memoraxCodeHome,
    claudeHome,
    workspace,
  );
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
      ? { ok: true, userNotice: "windows Claude pending Add quota notice" }
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

async function writeClientOwnedProviderSettings(claudeHome) {
  await mkdir(claudeHome, { recursive: true });
  await writeFile(join(claudeHome, "settings.json"), `${JSON.stringify({
    env: {
      ANTHROPIC_BASE_URL: "https://windows-client-owned.invalid/anthropic",
      ANTHROPIC_API_KEY: "windows-client-owned-provider-sentinel",
      ANTHROPIC_MODEL: "windows-client-owned-model",
    },
  }, null, 2)}\n`);
}

function clientOwnedProviderSettingsPresent(settings) {
  return settings?.env?.ANTHROPIC_BASE_URL === "https://windows-client-owned.invalid/anthropic"
    && settings?.env?.ANTHROPIC_API_KEY === "windows-client-owned-provider-sentinel"
    && settings?.env?.ANTHROPIC_MODEL === "windows-client-owned-model"
    && settings?.env?.CLAUDE_CODE_USE_GATEWAY === undefined;
}

async function requireClaudeOnlySelection(memoraxCodeHome) {
  const text = await readFile(join(memoraxCodeHome, "config.toml"), "utf8").catch(() => "");
  const selection = parseClientSelection(text);
  if (selection.codex !== false || selection.claude !== true) {
    throw new Error("Windows Claude E2E requires [clients] codex=false and claude=true");
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

async function pluginVersionMatches(packageRoot, pluginRoot, reportedVersion) {
  if (typeof pluginRoot !== "string") return false;
  const expectedManifest = await readJson(
    join(packageRoot, "lib", "memorax-code-claude-adapter", ".claude-plugin", "plugin.json"),
  );
  const expectedShell = await readJson(
    join(packageRoot, "lib", "memorax-code-claude-adapter", "hooks", "runtime-shell.json"),
  );
  const pluginVersion = (await readJson(
    join(pluginRoot, ".claude-plugin", "plugin.json"),
  ))?.version;
  const installedShell = await readJson(join(pluginRoot, "hooks", "runtime-shell.json"));
  return typeof expectedManifest?.version === "string"
    && expectedManifest.version === expectedShell?.shellVersion
    && pluginVersion === expectedManifest.version
    && reportedVersion === expectedManifest.version
    && installedShell?.version === expectedShell?.version
    && installedShell?.runtimeAbi === expectedShell?.runtimeAbi
    && installedShell?.shellVersion === expectedShell?.shellVersion;
}

async function installedHookAssetsPresent(pluginRoot) {
  if (typeof pluginRoot !== "string") return false;
  const requiredPaths = [
    ".claude-plugin/plugin.json",
    "hooks/hooks.json",
    "hooks/runtime-hook.mjs",
    "hooks/runtime-shell.json",
    "runtime-hooks/ensure-backend.mjs",
    "runtime-hooks/memory-turn.mjs",
    "runtime-hooks/memory-cli-session.mjs",
    "runtime-hooks/memory-skill-reminder.mjs",
    "memorax-code-adapter-common/src/hooks/client-hook-launcher.mjs",
    "memorax-code-adapter-common/src/hooks/hook-runtime-generation.mjs",
    "memorax-code-adapter-common/src/hooks/capture-cwd-hook.mjs",
    "memorax-code-adapter-common/src/runtime-record.mjs",
    "skills/memorax-code/SKILL.md",
  ];
  if (!(await Promise.all(
    requiredPaths.map((relativePath) => exists(join(pluginRoot, relativePath))),
  )).every(Boolean)) return false;
  const manifest = await readJson(join(pluginRoot, "hooks", "hooks.json"));
  const serialized = JSON.stringify(manifest);
  return serialized.includes("SessionStart")
    && serialized.includes("UserPromptSubmit")
    && serialized.includes("Stop")
    && serialized.includes("runtime-hook.mjs")
    && serialized.includes("ensure-backend")
    && serialized.includes("memory-turn")
    && serialized.includes("memory-cli-session")
    && serialized.includes("memory-skill-reminder");
}

async function createStateSentinels(memoraxCodeHome, claudeHome, workspace) {
  const files = [
    {
      key: "memorax-code:memory/windows-claude-e2e.bin",
      root: memoraxCodeHome,
      path: "memory/windows-claude-e2e.bin",
      contents: "claude-memory-preserve-v1\u0000\u0001",
    },
    {
      key: "memorax-code:user-state/windows-claude-e2e.txt",
      root: memoraxCodeHome,
      path: "user-state/windows-claude-e2e.txt",
      contents: "claude-user-state-preserve-v1\n",
    },
    {
      key: "claude:plugins/data/memorax-code-claude-adapter-memorax-code-local/state.bin",
      root: claudeHome,
      path: "plugins/data/memorax-code-claude-adapter-memorax-code-local/state.bin",
      contents: "claude-plugin-data-preserve-v1\u0000\u0001",
    },
  ];
  for (const file of files) {
    const path = join(file.root, file.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.contents);
  }
  const hashes = {};
  for (const file of files) {
    hashes[file.key] = hash(await readFile(join(file.root, file.path)));
  }
  await writeFile(
    join(workspace, "windows-claude-sentinel-hashes.json"),
    `${JSON.stringify(hashes)}\n`,
  );
}

async function sentinelsMatch(memoraxCodeHome, claudeHome, workspace) {
  const expected = await readJson(
    join(workspace, "windows-claude-sentinel-hashes.json"),
  );
  if (!expected || typeof expected !== "object") return false;
  for (const [key, digest] of Object.entries(expected)) {
    const separator = key.indexOf(":");
    const rootName = key.slice(0, separator);
    const relativePath = key.slice(separator + 1);
    const root = rootName === "memorax-code"
      ? memoraxCodeHome
      : rootName === "claude"
        ? claudeHome
        : undefined;
    if (!root) return false;
    const contents = await readFile(join(root, relativePath)).catch(() => undefined);
    if (!contents || hash(contents) !== digest) return false;
  }
  return true;
}

async function claudeSessionStateStillPresent(
  memoraxCodeHome,
  sessionId,
  workspace,
  transcriptPath,
) {
  const state = await readJson(claudeWorkspacePath(memoraxCodeHome));
  const registry = await readJson(claudeSessionRegistryPath(memoraxCodeHome));
  return state?.latest?.sessionId === sessionId
    && samePath(state?.latest?.cwd, workspace)
    && registry?.sessions?.[sessionId]?.claudeSessionId === sessionId
    && samePath(registry?.sessions?.[sessionId]?.transcriptPath, transcriptPath);
}

function pluginRegistrationAbsent(settings) {
  if (!settings || typeof settings !== "object") return false;
  return !Object.prototype.hasOwnProperty.call(
    settings.enabledPlugins ?? {},
    "memorax-code-claude-adapter@memorax-code-local",
  ) && !Object.prototype.hasOwnProperty.call(
    settings.extraKnownMarketplaces ?? {},
    "memorax-code-local",
  );
}

async function claudePluginStateRecords(memoraxCodeHome) {
  const root = join(memoraxCodeHome, "adapters", "claude-code", "plugins");
  if (!await isDirectory(root)) return [];
  return (await readdir(root)).filter((name) => name.endsWith(".json"));
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

function claudeWorkspacePath(memoraxCodeHome) {
  return join(memoraxCodeHome, "adapters", "claude-code", "workspaces.json");
}

function claudeSessionRegistryPath(memoraxCodeHome) {
  return join(memoraxCodeHome, "adapters", "claude-code", "session-registry.json");
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
