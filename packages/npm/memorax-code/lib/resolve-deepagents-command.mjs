import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { commandOnPath, isExecutableCommand } from "./vscode-extension-command.mjs";

// dcode's installer and uv/pipx both place the launcher under a user bin
// directory, which is not guaranteed to be on the PATH inherited by setup.
export function resolveDeepAgentsCommand({
  env = process.env,
  homeDir = homedir(),
  platform = process.platform,
} = {}) {
  const configured = nonEmpty(env.MEMORAX_CODE_DEEPAGENTS_COMMAND);
  if (configured) return { command: configured, source: "configured" };

  if (commandOnPath("dcode", env.PATH, platform, env.PATHEXT)) {
    return { command: "dcode", source: "path" };
  }

  for (const candidate of installationCandidates(env, homeDir, platform)) {
    if (existsSync(candidate) && isExecutableCommand(candidate, platform)) {
      return { command: candidate, source: "user-bin" };
    }
  }

  return { command: "dcode", source: "unavailable" };
}

export function ensureDeepAgentsCommandEnv(options = {}) {
  const env = options.env ?? process.env;
  const resolved = resolveDeepAgentsCommand({ ...options, env });
  if (resolved.source !== "unavailable") env.MEMORAX_CODE_DEEPAGENTS_COMMAND = resolved.command;
  return resolved;
}

function installationCandidates(env, homeDir, platform) {
  const names = platform === "win32" ? ["dcode.exe", "dcode.cmd"] : ["dcode"];
  const roots = new Set([
    nonEmpty(env.DEEPAGENTS_BIN_DIR),
    join(homeDir, ".local", "bin"),
    join(homeDir, ".cargo", "bin"),
    join(homeDir, ".bun", "bin"),
  ].filter(Boolean));
  return [...roots].flatMap((root) => names.map((name) => join(root, name)));
}

function nonEmpty(value) {
  const normalized = String(value ?? "").trim();
  return normalized || undefined;
}
