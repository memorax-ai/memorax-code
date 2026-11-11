import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { cursorInstallationDetected } from "./memorax-code-cursor-adapter/src/adapter-paths.mjs";
import { qoderInstallationDetected } from "./memorax-code-qoder-adapter/src/adapter-paths.mjs";
import { traeInstallationDetected } from "./memorax-code-trae-adapter/src/adapter-paths.mjs";
import { resolveClaudeCommand } from "./resolve-claude-command.mjs";
import { resolveCodeBuddyCommand, resolveWorkBuddyCommand } from "./resolve-codebuddy-command.mjs";
import { resolveCodexCommand } from "./resolve-codex-command.mjs";
import { commandOnPath } from "./vscode-extension-command.mjs";
import { resolveWindowsCliInvocation } from "./windows-cli-invocation.mjs";

// These mirror setup's preflights. Setup repeats its own detection before it
// activates anything, so a stale answer here costs one no-op run.
const CLIENT_DETECTORS = {
  codex: (env) => commandRuns(resolveCodexCommand({ env }), env),
  claude: (env) => commandRuns(resolveClaudeCommand({ env }), env),
  opencode: openCodeDetected,
  codebuddy: (env) => commandRuns(resolveCodeBuddyCommand({ env }), env),
  workbuddy: (env) => commandRuns(resolveWorkBuddyCommand({ env }), env),
  trae: (env) => traeInstallationDetected({ env }),
  cursor: (env) => cursorInstallationDetected({ env }),
  qoder: (env) => qoderInstallationDetected({ env }),
};
const SETUP_CLIENTS = Object.keys(CLIENT_DETECTORS);

// A client with no [clients] entry is undecided, which is the only state
// discovery may act on: true is already managed and false is an opt-out.
export function discoverNewClients({ memoraxCodeHome, deferredClients = [], env = process.env }) {
  const clients = readClientSelection(memoraxCodeHome);
  if (!clients) return [];
  return SETUP_CLIENTS.filter((client) => (
    !Object.hasOwn(clients, client)
    && !deferredClients.includes(client)
    && CLIENT_DETECTORS[client](env)
  ));
}

function readClientSelection(memoraxCodeHome) {
  let clients;
  try {
    clients = parse(readFileSync(join(memoraxCodeHome, "config.toml"), "utf8")).clients;
  } catch {
    return undefined;
  }
  if (typeof clients !== "object" || clients === null) return undefined;
  // Matches setup: without a known boolean there is no completed selection.
  return [...SETUP_CLIENTS, "dsh"].some((client) => typeof clients[client] === "boolean")
    ? clients
    : undefined;
}

function commandRuns({ command, source }, env) {
  if (source === "unavailable") return false;
  let invocation;
  try {
    invocation = resolveWindowsCliInvocation(command, ["--version"], { env });
  } catch {
    return false;
  }
  return spawnSync(invocation.command, invocation.args, {
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
    windowsHide: true,
  }).status === 0;
}

function openCodeDetected(env) {
  if (env.OPENCODE_CONFIG_DIR?.trim()) return true;
  const configHome = env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return existsSync(join(configHome, "opencode"))
    || commandOnPath("opencode", env.PATH, process.platform, env.PATHEXT);
}
