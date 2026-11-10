import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { DEFAULT_BACKEND_URL } from "../../memorax-code-adapter-common/src/backend-connection.mjs";

export const RUNTIME = "deepagents";
export { DEFAULT_BACKEND_URL };
export const DEFAULT_TOKEN_ENV = "MEMORAX_CODE_BACKEND_TOKEN";

// dcode treats DEEPAGENTS_HOME as its user-profile trust boundary. MemoraX Code
// must honor the same value so plugin state and installed assets stay together.
export function defaultDeepAgentsHome(env = process.env) {
  const configured = env.DEEPAGENTS_HOME?.trim();
  if (configured) {
    if (isAbsolute(configured)) return resolve(configured);
    if (configured.startsWith("~/")) return resolve(homedir(), configured.slice(2));
  }
  return join(homedir(), ".deepagents");
}

export function defaultMemoraxCodeHome(env = process.env) {
  return env.MEMORAX_CODE_HOME || join(homedir(), ".memorax-code");
}

export function adapterStatePath(memoraxCodeHome, runtime = RUNTIME) {
  return join(memoraxCodeHome, "adapters", runtime, "state.json");
}

export function adapterWorkspaceStatePath(memoraxCodeHome, runtime = RUNTIME) {
  return join(memoraxCodeHome, "adapters", runtime, "workspaces.json");
}

export function adapterSessionRegistryPath(memoraxCodeHome, runtime = RUNTIME) {
  return join(memoraxCodeHome, "adapters", runtime, "session-registry.json");
}

export function installedMarketplacePath(memoraxCodeHome = defaultMemoraxCodeHome()) {
  if (process.env.MEMORAX_CODE_DEEPAGENTS_MARKETPLACE_ROOT?.trim()) {
    return process.env.MEMORAX_CODE_DEEPAGENTS_MARKETPLACE_ROOT;
  }
  return join(memoraxCodeHome, "lib", "memorax-code-deepagents-marketplace");
}

export function normalizeBackendUrl(value = DEFAULT_BACKEND_URL) {
  return value.replace(/\/+$/, "");
}

export function tempDeepAgentsHome() {
  return join(tmpdir(), `memorax-code-deepagents-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}
