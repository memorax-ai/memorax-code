import { homedir } from "node:os";
import { join, win32 } from "node:path";
import {
  commandOnPath,
  isExecutableCommand,
} from "./vscode-extension-command.mjs";

const WORKBUDDY_APP_NAMES = ["WorkBuddy.app", "CodeBuddy.app"];
const WORKBUDDY_BUNDLED_SEGMENTS = [
  "Contents",
  "Resources",
  "app.asar.unpacked",
  "cli",
  "bin",
  "codebuddy",
];
const WINDOWS_WORKBUDDY_SEGMENTS = [
  "resources",
  "app.asar.unpacked",
  "cli",
  "bin",
  "codebuddy.exe",
];

export function resolveCodeBuddyCommand({
  env = process.env,
  homeDir = homedir(),
  platform = process.platform,
  applicationRoots = [join(homeDir, "Applications"), "/Applications"],
  windowsRoots = defaultWindowsRoots(env, homeDir),
  pathExists = isExecutableCommand,
} = {}) {
  const override = nonEmpty(env.MEMORAX_CODE_CODEBUDDY_COMMAND)
    ?? nonEmpty(env.CODEBUDDY_CLI_PATH)
    ?? nonEmpty(env.WORKBUDDY_CODEBUDDY_PATH);
  if (override) return { command: override, source: "configured" };

  if (commandOnPath("codebuddy", env.PATH, platform, env.PATHEXT)) {
    return { command: platform === "win32" ? "codebuddy.exe" : "codebuddy", source: "path" };
  }

  if (platform === "darwin") {
    for (const root of applicationRoots) {
      for (const appName of WORKBUDDY_APP_NAMES) {
        const command = join(root, appName, ...WORKBUDDY_BUNDLED_SEGMENTS);
        if (pathExists(command, platform)) return { command, source: "app-bundled" };
      }
    }
  }

  if (platform === "win32") {
    for (const root of windowsRoots) {
      const command = win32.join(root, ...WINDOWS_WORKBUDDY_SEGMENTS);
      if (pathExists(command, platform)) return { command, source: "app-bundled" };
    }
  }

  return { command: platform === "win32" ? "codebuddy.exe" : "codebuddy", source: "unavailable" };
}

export function ensureCodeBuddyCommandEnv(options = {}) {
  const env = options.env ?? process.env;
  const resolved = resolveCodeBuddyCommand({ ...options, env });
  if (resolved.source !== "unavailable") env.MEMORAX_CODE_CODEBUDDY_COMMAND = resolved.command;
  return resolved;
}

export function defaultCodeBuddyHome(env = process.env, homeDir = homedir()) {
  return nonEmpty(env.CODEBUDDY_HOME)
    ?? nonEmpty(env.WORKBUDDY_HOME)
    ?? join(homeDir, ".workbuddy");
}

function defaultWindowsRoots(env, homeDir) {
  const roots = [];
  const localAppData = nonEmpty(env.LOCALAPPDATA) ?? join(homeDir, "AppData", "Local");
  const programFiles = nonEmpty(env.ProgramFiles) ?? "C:\\Program Files";
  const programFilesX86 = nonEmpty(env["ProgramFiles(x86)"]) ?? "C:\\Program Files (x86)";
  for (const root of [
    join(localAppData, "WorkBuddy"),
    join(localAppData, "CodeBuddy"),
    join(programFiles, "WorkBuddy"),
    join(programFiles, "CodeBuddy"),
    join(programFilesX86, "WorkBuddy"),
    join(programFilesX86, "CodeBuddy"),
  ]) {
    if (!roots.includes(root)) roots.push(root);
  }
  return roots;
}

function nonEmpty(value) {
  const normalized = String(value ?? "").trim();
  return normalized || undefined;
}
