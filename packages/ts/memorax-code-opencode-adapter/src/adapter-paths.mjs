import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function defaultOpenCodeConfigDir(env = process.env, home = homedir()) {
  const explicit = stringOption(env.OPENCODE_CONFIG_DIR);
  if (explicit) return resolve(explicit);
  const configHome = stringOption(env.XDG_CONFIG_HOME) ?? join(home, ".config");
  return resolve(configHome, "opencode");
}

export function defaultMemoraxCodeHome(env = process.env, home = homedir()) {
  return resolve(stringOption(env.MEMORAX_CODE_HOME) ?? join(home, ".memorax-code"));
}

export function adapterStatePath(memoraxCodeHome = defaultMemoraxCodeHome()) {
  return join(memoraxCodeHome, "adapters", "opencode", "state.json");
}

export function openCodePluginPath(configDir = defaultOpenCodeConfigDir()) {
  return join(configDir, "plugins", "memorax-code.js");
}

export function openCodeSkillPath(configDir = defaultOpenCodeConfigDir()) {
  return join(configDir, "skills", "memorax-code");
}

export function openCodeRepoMemoryHelperPath(configDir = defaultOpenCodeConfigDir()) {
  return join(configDir, "hooks", "repo-memory-job.mjs");
}

function stringOption(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
