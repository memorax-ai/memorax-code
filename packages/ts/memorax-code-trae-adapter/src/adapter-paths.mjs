import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, win32 } from "node:path";

export function defaultTraeHome(env = process.env, home = homedir()) {
  return resolve(stringOption(env.TRAE_CN_HOME) ?? stringOption(env.TRAE_HOME) ?? join(home, ".trae-cn"));
}

export function defaultMemoraxCodeHome(env = process.env, home = homedir()) {
  return resolve(stringOption(env.MEMORAX_CODE_HOME) ?? join(home, ".memorax-code"));
}

export function traeHooksPath(traeHome = defaultTraeHome()) {
  return join(traeHome, "hooks.json");
}

export function traeSkillPath(traeHome = defaultTraeHome()) {
  return join(traeHome, "skills", "memorax-code");
}

export function traeAdapterRoot(memoraxCodeHome = defaultMemoraxCodeHome()) {
  return join(memoraxCodeHome, "adapters", "trae");
}

export function traeAdapterStatePath(memoraxCodeHome = defaultMemoraxCodeHome()) {
  return join(traeAdapterRoot(memoraxCodeHome), "state.json");
}

export function traeRuntimeRoot(memoraxCodeHome = defaultMemoraxCodeHome()) {
  return join(traeAdapterRoot(memoraxCodeHome), "runtime", "generations");
}

export function traeInstallationDetected({
  env = process.env,
  home = homedir(),
  platform = process.platform,
  pathExists = existsSync,
} = {}) {
  if (stringOption(env.TRAE_CN_HOME) || stringOption(env.TRAE_HOME)) return true;
  if (pathExists(defaultTraeHome(env, home))) return true;
  return traeApplicationCandidates({ env, home, platform }).some(pathExists);
}

export function traeApplicationCandidates({ env = process.env, home = homedir(), platform = process.platform } = {}) {
  if (platform === "darwin") {
    return [
      "/Applications/Trae CN.app",
      join(home, "Applications", "Trae CN.app"),
      "/Applications/Trae.app",
      join(home, "Applications", "Trae.app"),
    ];
  }
  if (platform === "win32") {
    return [
      env.LOCALAPPDATA && win32.join(env.LOCALAPPDATA, "Programs", "Trae CN"),
      env.LOCALAPPDATA && win32.join(env.LOCALAPPDATA, "Programs", "Trae"),
      env.ProgramFiles && win32.join(env.ProgramFiles, "Trae CN"),
      env.ProgramFiles && win32.join(env.ProgramFiles, "Trae"),
    ].filter(Boolean);
  }
  return [
    join(home, ".local", "share", "applications", "trae.desktop"),
    "/usr/share/applications/trae.desktop",
  ];
}

function stringOption(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
