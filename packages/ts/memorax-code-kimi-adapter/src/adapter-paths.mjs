import { homedir } from "node:os";
import { join } from "node:path";

export function defaultKimiHome(env = process.env) {
  return env.KIMI_CODE_HOME || join(homedir(), ".kimi-code");
}

export function defaultMemoraxCodeHome(env = process.env) {
  return env.MEMORAX_CODE_HOME || join(homedir(), ".memorax-code");
}

export function adapterStatePath(memoraxCodeHome) {
  return join(memoraxCodeHome, "adapters", "kimi", "state.json");
}

export function adapterRuntimePath(memoraxCodeHome) {
  return join(memoraxCodeHome, "adapters", "kimi", "runtime");
}

export function kimiConfigPath(kimiHome = defaultKimiHome()) {
  return join(kimiHome, "config.toml");
}

export function kimiSkillPath(kimiHome = defaultKimiHome()) {
  return join(kimiHome, "skills", "memorax-code");
}
