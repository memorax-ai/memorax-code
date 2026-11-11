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

const CLAUDE_DESKTOP_MACOS_RUNTIME_SEGMENTS = ["claude.app", "Contents", "MacOS", "claude"];
const CLAUDE_DESKTOP_CODE_PROBE_TIMEOUT_MS = 10_000;
const CLAUDE_DESKTOP_WINDOWS_PACKAGE_NAME = "Claude";
const CLAUDE_DESKTOP_WINDOWS_QUERY_TIMEOUT_MS = 10_000;
const CLAUDE_DESKTOP_WINDOWS_RUNTIME_SEGMENTS = ["claude.exe"];

export function resolveClaudeCommand({
  env = process.env,
  homeDir = homedir(),
  platform = process.platform,
  arch = process.arch,
  desktopCodeRoots = defaultClaudeDesktopCodeRoots(env, homeDir, platform),
  desktopCodeProbe = spawnSync,
  vscodeExtensionRoots = defaultVsCodeExtensionRoots(homeDir),
  windowsAppPackageFamilies,
  windowsAppQuery = spawnSync,
} = {}) {
  const configured = nonEmpty(env.MEMORAX_CODE_CLAUDE_COMMAND);
  if (configured) return { command: configured, source: "configured" };

  if (commandOnPath("claude", env.PATH, platform, env.PATHEXT)) {
    return { command: "claude", source: "path" };
  }

  const desktopCommand = findClaudeDesktopCodeCommand(
    desktopCodeRoots,
    platform,
    env,
    desktopCodeProbe,
  );
  if (desktopCommand) return { command: desktopCommand, source: "app-bundled" };

  const windowsDesktopCommand = resolveWindowsClaudeDesktopCodeCommand({
    env,
    homeDir,
    packageFamilies: windowsAppPackageFamilies,
    platform,
    desktopCodeProbe,
    spawnSyncImpl: windowsAppQuery,
  });
  if (windowsDesktopCommand) return { command: windowsDesktopCommand, source: "app-bundled" };

  const vscodeCommand = findVsCodeExtensionCommand({
    extensionId: "anthropic.claude-code",
    extensionRoots: vscodeExtensionRoots,
    platform,
    arch,
    commandCandidates: (extensionRoot) => [
      join(extensionRoot, "resources", "native-binary", platform === "win32" ? "claude.exe" : "claude"),
    ],
  });
  if (vscodeCommand) return { command: vscodeCommand, source: "vscode-bundled" };

  return { command: "claude", source: "unavailable" };
}

export function ensureClaudeCommandEnv(options = {}) {
  const env = options.env ?? process.env;
  const resolved = resolveClaudeCommand({ ...options, env });
  if (resolved.source !== "unavailable") env.MEMORAX_CODE_CLAUDE_COMMAND = resolved.command;
  return resolved;
}

export function resolveWindowsClaudeDesktopCodeCommand({
  env = process.env,
  homeDir = homedir(),
  packageFamilies,
  platform = process.platform,
  desktopCodeProbe = spawnSync,
  spawnSyncImpl = spawnSync,
} = {}) {
  if (platform !== "win32") return undefined;
  const localAppData = nonEmpty(env.LOCALAPPDATA) ?? join(homeDir, "AppData", "Local");
  const families = packageFamilies ?? queryWindowsClaudeAppPackageFamilies(env, spawnSyncImpl);
  const roots = families.map((family) => join(
    localAppData,
    "Packages",
    family,
    "LocalCache",
    "Roaming",
    "Claude",
    "claude-code",
  ));
  return findClaudeDesktopCodeCommand(roots, platform, env, desktopCodeProbe);
}

function findClaudeDesktopCodeCommand(roots, platform, env, spawnSyncImpl) {
  const runtimeSegments = claudeDesktopRuntimeSegments(platform);
  if (!runtimeSegments) return undefined;
  for (const root of new Set(roots)) {
    let versions;
    try {
      versions = readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
        .map((entry) => entry.name)
        .sort((left, right) => right.localeCompare(left, "en", { numeric: true, sensitivity: "base" }));
    } catch {
      continue;
    }
    for (const version of versions) {
      for (const command of claudeDesktopVersionCommands(join(root, version), runtimeSegments)) {
        if (
          isExecutableCommand(command, platform)
          && claudeDesktopCodeCommandIsRunnable(command, env, spawnSyncImpl)
        ) {
          return command;
        }
      }
    }
  }
  return undefined;
}

// Current desktop builds add a content-hash directory below each version.
function claudeDesktopVersionCommands(versionRoot, runtimeSegments) {
  let children = [];
  try {
    children = readdirSync(versionRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name);
  } catch {
    // An unreadable version directory has no candidates beyond the direct path.
  }
  return [
    join(versionRoot, ...runtimeSegments),
    ...children.map((child) => join(versionRoot, child, ...runtimeSegments)),
  ];
}

function claudeDesktopCodeCommandIsRunnable(command, env, spawnSyncImpl) {
  let result;
  try {
    result = spawnSyncImpl(
      command,
      ["--version"],
      {
        encoding: "utf8",
        env,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: CLAUDE_DESKTOP_CODE_PROBE_TIMEOUT_MS,
        windowsHide: true,
      },
    );
  } catch {
    return false;
  }
  return result.status === 0 && !result.error && !result.signal;
}

function defaultClaudeDesktopCodeRoots(env, homeDir, platform) {
  if (platform === "darwin") {
    return [join(homeDir, "Library", "Application Support", "Claude", "claude-code")];
  }
  if (platform === "win32") {
    const appData = nonEmpty(env.APPDATA) ?? join(homeDir, "AppData", "Roaming");
    return [join(appData, "Claude", "claude-code")];
  }
  return [];
}

function claudeDesktopRuntimeSegments(platform) {
  if (platform === "darwin") return CLAUDE_DESKTOP_MACOS_RUNTIME_SEGMENTS;
  if (platform === "win32") return CLAUDE_DESKTOP_WINDOWS_RUNTIME_SEGMENTS;
  return undefined;
}

function queryWindowsClaudeAppPackageFamilies(env, spawnSyncImpl) {
  const powershell = windowsPowerShellCommand(env);
  const script = [
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
    `Get-AppxPackage -Name '${CLAUDE_DESKTOP_WINDOWS_PACKAGE_NAME}' -ErrorAction SilentlyContinue | ForEach-Object { $_.PackageFamilyName }`,
  ].join("; ");
  let result;
  try {
    result = spawnSyncImpl(
      powershell,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      {
        encoding: "utf8",
        env,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: CLAUDE_DESKTOP_WINDOWS_QUERY_TIMEOUT_MS,
        windowsHide: true,
      },
    );
  } catch {
    return [];
  }
  if (result.status !== 0 || result.error || result.signal) return [];
  return [...new Set(String(result.stdout ?? "")
    .split(/\r?\n/)
    .map((value) => value.replace(/^\uFEFF/, "").trim())
    .filter((value) => /^[A-Za-z0-9][A-Za-z0-9.-]*_[A-Za-z0-9]+$/.test(value)))];
}

function windowsPowerShellCommand(env) {
  const systemRoot = nonEmpty(env.SystemRoot) ?? nonEmpty(env.SYSTEMROOT);
  return systemRoot
    ? win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe";
}

function nonEmpty(value) {
  const normalized = String(value ?? "").trim();
  return normalized || undefined;
}
