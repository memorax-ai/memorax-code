import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, win32 } from "node:path";

export function defaultCursorHome(env = process.env, home = homedir()) {
  return resolve(stringOption(env.CURSOR_HOME) ?? join(home, ".cursor"));
}

export function defaultMemoraxCodeHome(env = process.env, home = homedir()) {
  return resolve(stringOption(env.MEMORAX_CODE_HOME) ?? join(home, ".memorax-code"));
}

export function cursorHooksPath(cursorHome = defaultCursorHome()) {
  return join(cursorHome, "hooks.json");
}

export function cursorSkillPath(cursorHome = defaultCursorHome()) {
  return join(cursorHome, "skills", "memorax-code");
}

export function cursorRepoMemoryAgentPath(cursorHome = defaultCursorHome()) {
  return join(cursorHome, "agents", "memorax-repo-memory.md");
}

export function cursorAdapterRoot(memoraxCodeHome = defaultMemoraxCodeHome()) {
  return join(memoraxCodeHome, "adapters", "cursor");
}

export function cursorAdapterStatePath(memoraxCodeHome = defaultMemoraxCodeHome()) {
  return join(cursorAdapterRoot(memoraxCodeHome), "state.json");
}

export function cursorRuntimeRoot(memoraxCodeHome = defaultMemoraxCodeHome()) {
  return join(cursorAdapterRoot(memoraxCodeHome), "runtime", "generations");
}

export function cursorInstallationDetected({
  env = process.env,
  home = homedir(),
  platform = process.platform,
  pathExists = existsSync,
} = {}) {
  if (stringOption(env.CURSOR_HOME)) return true;
  if (pathExists(defaultCursorHome(env, home))) return true;
  return cursorApplicationCandidates({ env, home, platform }).some(pathExists);
}

export function cursorApplicationCandidates({ env = process.env, home = homedir(), platform = process.platform } = {}) {
  if (platform === "darwin") {
    return ["/Applications/Cursor.app", join(home, "Applications", "Cursor.app")];
  }
  if (platform === "win32") {
    return [
      env.LOCALAPPDATA && win32.join(env.LOCALAPPDATA, "Programs", "cursor", "Cursor.exe"),
      env.ProgramFiles && win32.join(env.ProgramFiles, "Cursor", "Cursor.exe"),
    ].filter(Boolean);
  }
  return [
    "/usr/bin/cursor", "/usr/local/bin/cursor", "/opt/Cursor/cursor", "/opt/cursor/cursor",
    join(home, ".local", "bin", "cursor"),
    join(home, ".local", "share", "applications", "cursor.desktop"),
    "/usr/share/applications/cursor.desktop",
  ];
}

function stringOption(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
