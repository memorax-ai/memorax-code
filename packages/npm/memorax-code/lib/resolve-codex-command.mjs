import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, win32 } from "node:path";
import {
  commandOnPath,
  defaultVsCodeExtensionRoots,
  findVsCodeExtensionCommand,
  isExecutableCommand,
} from "./vscode-extension-command.mjs";
import { resolveWindowsCliInvocation } from "./windows-cli-invocation.mjs";

const APP_BUNDLE_NAMES = ["ChatGPT.app", "Codex.app"];
const WINDOWS_CODEX_DISCOVERY_PROBE_TIMEOUT_MS = 2_000;
const WINDOWS_CODEX_APP_RUNTIME_SEGMENTS = ["plugins", ".plugin-appserver", "codex.exe"];

export function resolveCodexCommand({
  env = process.env,
  homeDir = homedir(),
  platform = process.platform,
  arch = process.arch,
  applicationRoots = [join(homeDir, "Applications"), "/Applications"],
  pathCommandAvailable = commandOnPath,
  vscodeExtensionRoots = defaultVsCodeExtensionRoots(homeDir),
  windowsAppProbe = spawnSync,
  windowsAppRuntimePaths,
  windowsPathExists = isExecutableCommand,
  windowsPathProbe = spawnSync,
} = {}) {
  const npmOverride = nonEmpty(env.MEMORAX_CODE_CODEX_COMMAND);
  if (npmOverride) return { command: npmOverride, source: "npm-override" };

  const configured = nonEmpty(env.CODEX_CLI_PATH);
  if (configured) return { command: configured, source: "configured" };

  if (
    pathCommandAvailable("codex", env.PATH, platform, env.PATHEXT)
    && (
      platform !== "win32"
      || windowsCodexPathCommandIsRunnable("codex", env, windowsPathProbe)
    )
  ) {
    return { command: "codex", source: "path" };
  }

  if (platform === "darwin") {
    for (const root of applicationRoots) {
      for (const appName of APP_BUNDLE_NAMES) {
        const command = join(root, appName, "Contents", "Resources", "codex");
        if (isExecutableCommand(command, platform)) return { command, source: "app-bundled" };
      }
    }
  }

  const windowsAppCommand = resolveWindowsCodexAppCommand({
    env,
    homeDir,
    pathExists: windowsPathExists,
    platform,
    runtimePaths: windowsAppRuntimePaths,
    spawnSyncImpl: windowsAppProbe,
  });
  if (windowsAppCommand) return { command: windowsAppCommand, source: "app-bundled" };

  const vscodeCommand = findVsCodeExtensionCommand({
    extensionId: "openai.chatgpt",
    extensionRoots: vscodeExtensionRoots,
    platform,
    arch,
    commandCandidates: (extensionRoot) => codexExtensionCommandCandidates(extensionRoot, platform, arch),
  });
  if (vscodeCommand) return { command: vscodeCommand, source: "vscode-bundled" };

  return { command: "codex", source: "unavailable" };
}

export function resolveWindowsCodexAppCommand({
  env = process.env,
  homeDir = homedir(),
  pathExists = isExecutableCommand,
  platform = process.platform,
  runtimePaths,
  spawnSyncImpl = spawnSync,
} = {}) {
  if (platform !== "win32") return undefined;
  const codexHome = nonEmpty(env.CODEX_HOME) ?? win32.join(homeDir, ".codex");
  const candidates = runtimePaths ?? [win32.join(codexHome, ...WINDOWS_CODEX_APP_RUNTIME_SEGMENTS)];
  for (const command of candidates) {
    if (
      pathExists(command, platform)
      && windowsCodexCommandIsRunnable(command, ["--version"], env, spawnSyncImpl)
    ) {
      return command;
    }
  }
  return undefined;
}

export function ensureCodexCommandEnv(options = {}) {
  const env = options.env ?? process.env;
  const resolved = resolveCodexCommand({ ...options, env });
  if (resolved.source !== "unavailable") env.CODEX_CLI_PATH = resolved.command;
  return resolved;
}

function codexExtensionCommandCandidates(extensionRoot, platform, arch) {
  const executable = platform === "win32" ? "codex.exe" : "codex";
  const binRoot = join(extensionRoot, "bin");
  const preferred = codexPlatformDirectories(platform, arch)
    .map((directory) => join(binRoot, directory, executable));
  let discovered = [];
  try {
    discovered = readdirSync(binRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => join(binRoot, entry.name, executable));
  } catch {
    // The preferred paths still provide deterministic candidates.
  }
  return [...new Set([...preferred, ...discovered])];
}

function codexPlatformDirectories(platform, arch) {
  if (platform === "darwin") {
    if (arch === "arm64") return ["macos-aarch64", "darwin-arm64"];
    if (arch === "x64") return ["macos-x86_64", "macos-x64", "darwin-x64"];
  }
  if (platform === "linux") {
    if (arch === "arm64") return ["linux-aarch64", "linux-arm64"];
    if (arch === "x64") return ["linux-x86_64", "linux-x64"];
  }
  if (platform === "win32") {
    if (arch === "arm64") return ["windows-aarch64", "windows-arm64", "win32-arm64"];
    if (arch === "x64") return ["windows-x86_64", "windows-x64", "win32-x64"];
  }
  return [];
}

function windowsCodexPathCommandIsRunnable(command, env, spawnSyncImpl) {
  let invocation;
  try {
    invocation = resolveWindowsCliInvocation(command, ["--version"], {
      env,
      platform: "win32",
      spawnSync: spawnSyncImpl,
    });
  } catch {
    return false;
  }
  return windowsCodexCommandIsRunnable(invocation.command, invocation.args, env, spawnSyncImpl);
}

function windowsCodexCommandIsRunnable(command, args, env, spawnSyncImpl) {
  let result;
  try {
    result = spawnSyncImpl(
      command,
      args,
      {
        encoding: "utf8",
        env,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: WINDOWS_CODEX_DISCOVERY_PROBE_TIMEOUT_MS,
        windowsHide: true,
      },
    );
  } catch {
    return false;
  }
  return result.status === 0 && !result.error && !result.signal;
}

function nonEmpty(value) {
  const normalized = String(value ?? "").trim();
  return normalized || undefined;
}
