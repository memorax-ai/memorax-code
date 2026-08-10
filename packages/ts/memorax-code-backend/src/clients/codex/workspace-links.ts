import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export function resolveCodexWorkspaceRoot(input: {
  sessionHome: string;
  sessionKey: string | undefined;
}): string | undefined {
  const cwd = cwdFromWorkspaceRegistry(input.sessionHome, input.sessionKey);
  return cwd ? safeRealpathDirectory(cwd) : undefined;
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120) || "branch";
}

function cwdFromWorkspaceRegistry(sessionHome: string, sessionKey: string | undefined): string | undefined {
  if (!sessionKey) return undefined;
  const registry = readJsonFile<{ sessions?: Record<string, unknown> }>(
    join(sessionHome, "adapters", "codex", "workspaces.json"),
  );
  const sessions = registry?.sessions;
  if (!sessions || typeof sessions !== "object") return undefined;
  for (const key of workspaceLookupKeys(sessionKey)) {
    const cwd = objectString((sessions[key] as Record<string, unknown> | undefined)?.cwd);
    if (cwd && isAbsolute(cwd)) return cwd;
  }
  return undefined;
}

function workspaceLookupKeys(sessionKey: string): string[] {
  const keys = new Set<string>();
  keys.add(sessionKey);
  if (sessionKey.startsWith("codex_")) keys.add(sessionKey.slice("codex_".length));
  else keys.add(`codex_${sessionKey}`);
  keys.add(sanitizePathSegment(sessionKey));
  return [...keys];
}

function safeRealpathDirectory(path: string): string | undefined {
  try {
    const resolved = realpathSync(resolve(path));
    return statSync(resolved).isDirectory() ? resolved : undefined;
  } catch {
    return undefined;
  }
}

function readJsonFile<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function objectString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
