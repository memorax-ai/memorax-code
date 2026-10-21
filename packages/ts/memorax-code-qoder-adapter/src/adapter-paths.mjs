import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function defaultQoderHome(env = process.env, home = homedir()) {
  return resolve(stringOption(env.QODER_CONFIG_DIR)
    ?? join(stringOption(env.QODER_CLI_HOME) ?? home, stringOption(env.QODER_CONFIG_DIR_NAME) ?? ".qoder"));
}

export function defaultMemoraxCodeHome(env = process.env, home = homedir()) {
  return resolve(stringOption(env.MEMORAX_CODE_HOME) ?? join(home, ".memorax-code"));
}

export function qoderSettingsPath(qoderHome = defaultQoderHome()) {
  return join(qoderHome, "settings.json");
}

export function qoderSkillPath(qoderHome = defaultQoderHome()) {
  return join(qoderHome, "skills", "memorax-code");
}

export function qoderAdapterRoot(memoraxCodeHome = defaultMemoraxCodeHome()) {
  return join(memoraxCodeHome, "adapters", "qoder");
}

export function qoderAdapterStatePath(memoraxCodeHome = defaultMemoraxCodeHome()) {
  return join(qoderAdapterRoot(memoraxCodeHome), "state.json");
}

export function qoderRuntimeRoot(memoraxCodeHome = defaultMemoraxCodeHome()) {
  return join(qoderAdapterRoot(memoraxCodeHome), "runtime", "generations");
}

export function qoderInstallationDetected({
  env = process.env,
  home = homedir(),
  platform = process.platform,
  pathExists = existsSync,
} = {}) {
  if (stringOption(env.QODER_CONFIG_DIR) || stringOption(env.QODER_CLI_HOME)
    || stringOption(env.QODER_CONFIG_DIR_NAME) || pathExists(defaultQoderHome(env, home))) return true;
  return platform === "darwin"
    && ["/Applications/Qoder.app", join(home, "Applications", "Qoder.app")].some(pathExists);
}

function stringOption(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
