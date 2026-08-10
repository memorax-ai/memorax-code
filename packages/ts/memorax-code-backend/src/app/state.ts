import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { backendEnv } from "../config/backend-env.js";

export type BackendState = {
  sessionHome: string;
  claudeProjectsRoot?: string | false;
  authToken?: string;
  security: BackendSecurityConfig;
};

export type BackendAccessMode = "local" | "server";

export type BackendSecurityConfig = {
  mode: BackendAccessMode;
  allowExternalAccess: boolean;
};

export type BackendStateOptions = {
  sessionHome?: string;
  claudeProjectsRoot?: string | false;
  authToken?: string;
  security?: Partial<BackendSecurityConfig>;
};

export function createBackendState(host = "127.0.0.1", options: BackendStateOptions = {}): BackendState {
  const authToken = options.authToken ?? backendEnv("TOKEN");
  const sessionHome = options.sessionHome ?? process.env.MEMORAX_CODE_HOME ?? join(homedir(), ".memorax-code");
  const claudeProjectsRoot = options.claudeProjectsRoot
    ?? memoryViewerClaudeProjectsRootFromEnv(process.env);
  const security = {
    ...envBackendSecurity(),
    ...options.security,
  };
  validateBackendSecurity(host, authToken, security);
  return {
    sessionHome,
    claudeProjectsRoot,
    authToken,
    security,
  };
}

export function memoryViewerClaudeProjectsRootFromEnv(
  env: Record<string, string | undefined>,
): string | false | undefined {
  const configured = env.MEMORAX_CODE_MEMORY_VIEWER_CLAUDE_PROJECTS_ROOT?.trim();
  if (!configured) return undefined;
  if (configured === "disabled") return false;
  return resolve(configured);
}

function envBackendSecurity(): BackendSecurityConfig {
  const mode = backendEnv("MODE") === "server" ? "server" : "local";
  return {
    mode,
    allowExternalAccess: parseBooleanEnv(backendEnv("ALLOW_EXTERNAL")) ?? mode === "server",
  };
}

function validateBackendSecurity(host: string, authToken: string | undefined, security: BackendSecurityConfig): void {
  if (!isLoopbackHost(host) && !security.allowExternalAccess) {
    const hint = "set MEMORAX_CODE_BACKEND_ALLOW_EXTERNAL=1 and configure MEMORAX_CODE_BACKEND_TOKEN to opt in";
    throw new Error(
      `external Backend host "${host}" is disabled; ${hint}`,
    );
  }
  if ((!isLoopbackHost(host) || security.mode === "server") && !authToken) {
    throw new Error("MEMORAX_CODE_BACKEND_TOKEN is required for server mode or external Backend access");
  }
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function parseBooleanEnv(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on", "enabled"].includes(normalized)) return true;
  if (["0", "false", "no", "off", "disabled"].includes(normalized)) return false;
  return undefined;
}
