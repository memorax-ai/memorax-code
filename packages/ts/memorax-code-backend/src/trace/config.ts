import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadMemoraxCodeConfig, type MemoraxCodeConfig } from "../config/memorax-code.js";
import { isTraceClient, type TraceClient } from "./context.js";

export const TRACE_CLIENTS: readonly TraceClient[] = ["codex", "claude", "dsh", "opencode"];

export type ClientTraceConfig = Readonly<{
  enabled: boolean;
  captureContent: boolean;
  retentionDays: number;
  maxEventChars: number;
  maxFileBytes: number;
}>;

export type CodexTraceConfig = ClientTraceConfig;
export type ClaudeTraceConfig = ClientTraceConfig;
export type DshTraceConfig = ClientTraceConfig;
export type OpenCodeTraceConfig = ClientTraceConfig;

export type ClientTracePaths = Readonly<{
  root: string;
  currentTurnPath: string;
  sessionsRoot: string;
  sessionDir: (sessionId: string) => string;
  sessionCurrentTurnPath: (sessionId: string) => string;
  traceJson: (sessionId: string) => string;
  eventsJsonl: (sessionId: string) => string;
}>;

export type CodexTracePaths = ClientTracePaths;
export type ClaudeTracePaths = ClientTracePaths;
export type DshTracePaths = ClientTracePaths;
export type OpenCodeTracePaths = ClientTracePaths;

export const CODEX_TRACE_DEFAULT_CONFIG: CodexTraceConfig = {
  enabled: true,
  captureContent: true,
  retentionDays: 7,
  maxEventChars: 20_000,
  maxFileBytes: 52_428_800,
};

export const CLAUDE_TRACE_DEFAULT_CONFIG: ClaudeTraceConfig = {
  enabled: true,
  captureContent: true,
  retentionDays: 7,
  maxEventChars: 20_000,
  maxFileBytes: 52_428_800,
};

export const DSH_TRACE_DEFAULT_CONFIG: DshTraceConfig = {
  enabled: true,
  captureContent: true,
  retentionDays: 7,
  maxEventChars: 20_000,
  maxFileBytes: 52_428_800,
};

export const OPENCODE_TRACE_DEFAULT_CONFIG: OpenCodeTraceConfig = {
  enabled: true,
  captureContent: true,
  retentionDays: 7,
  maxEventChars: 20_000,
  maxFileBytes: 52_428_800,
};

const TRACE_DEFAULT_CONFIGS: Readonly<Record<TraceClient, ClientTraceConfig>> = {
  codex: CODEX_TRACE_DEFAULT_CONFIG,
  claude: CLAUDE_TRACE_DEFAULT_CONFIG,
  dsh: DSH_TRACE_DEFAULT_CONFIG,
  opencode: OPENCODE_TRACE_DEFAULT_CONFIG,
};

const TRACE_ENV_PREFIXES: Readonly<Record<TraceClient, string>> = {
  codex: "MEMORAX_CODE_CODEX_TRACE",
  claude: "MEMORAX_CODE_CLAUDE_TRACE",
  dsh: "MEMORAX_CODE_DSH_TRACE",
  opencode: "MEMORAX_CODE_OPENCODE_TRACE",
};

export const TRACE_CLEANUP_DEBOUNCE_MS = 60 * 60 * 1000;
export const TRACE_CURRENT_TURN_TTL_MS = 30 * 60 * 1000;
export const CODEX_TRACE_CLEANUP_DEBOUNCE_MS = TRACE_CLEANUP_DEBOUNCE_MS;
export const CODEX_TRACE_CURRENT_TURN_TTL_MS = TRACE_CURRENT_TURN_TTL_MS;
const WINDOWS_RESERVED_PATH_SEGMENT = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const WINDOWS_REWRITTEN_LABEL_MAX_CHARS = 48;

export function codexTraceConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
  fileConfig?: MemoraxCodeConfig,
): CodexTraceConfig {
  return clientTraceConfigFromEnv("codex", env, fileConfig);
}

export function claudeTraceConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
  fileConfig?: MemoraxCodeConfig,
): ClaudeTraceConfig {
  return clientTraceConfigFromEnv("claude", env, fileConfig);
}

export function dshTraceConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
  fileConfig?: MemoraxCodeConfig,
): DshTraceConfig {
  return clientTraceConfigFromEnv("dsh", env, fileConfig);
}

export function openCodeTraceConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
  fileConfig?: MemoraxCodeConfig,
): OpenCodeTraceConfig {
  return clientTraceConfigFromEnv("opencode", env, fileConfig);
}

export function clientTraceConfigFromEnv(
  client: TraceClient,
  env: Record<string, string | undefined> = process.env,
  fileConfig?: MemoraxCodeConfig,
): ClientTraceConfig {
  assertTraceClient(client);
  const config = fileConfig ?? loadMemoraxCodeConfig(memoraxCodeHomeForTrace(env), { warn: () => undefined });
  const section = config.trace?.[client];
  const defaults = TRACE_DEFAULT_CONFIGS[client];
  const prefix = TRACE_ENV_PREFIXES[client];
  return {
    enabled: booleanValue(env[`${prefix}_ENABLED`], section?.enabled ?? defaults.enabled),
    captureContent: booleanValue(env[`${prefix}_CAPTURE_CONTENT`], section?.capture_content ?? defaults.captureContent),
    retentionDays: positiveInteger(env[`${prefix}_RETENTION_DAYS`] ?? section?.retention_days, defaults.retentionDays),
    maxEventChars: positiveInteger(env[`${prefix}_MAX_EVENT_CHARS`] ?? section?.max_event_chars, defaults.maxEventChars),
    maxFileBytes: positiveInteger(env[`${prefix}_MAX_FILE_BYTES`] ?? section?.max_file_bytes, defaults.maxFileBytes),
  };
}

export function memoraxCodeHomeForTrace(env: Record<string, string | undefined> = process.env): string {
  return env.MEMORAX_CODE_HOME?.trim() || join(homedir(), ".memorax-code");
}

export function tracePaths(memoraxCodeHome = memoraxCodeHomeForTrace(process.env)): CodexTracePaths {
  return clientTracePaths("codex", memoraxCodeHome);
}

export function claudeTracePaths(memoraxCodeHome = memoraxCodeHomeForTrace(process.env)): ClaudeTracePaths {
  return clientTracePaths("claude", memoraxCodeHome);
}

export function dshTracePaths(memoraxCodeHome = memoraxCodeHomeForTrace(process.env)): DshTracePaths {
  return clientTracePaths("dsh", memoraxCodeHome);
}

export function openCodeTracePaths(memoraxCodeHome = memoraxCodeHomeForTrace(process.env)): OpenCodeTracePaths {
  return clientTracePaths("opencode", memoraxCodeHome);
}

export function clientTracePaths(
  client: TraceClient,
  memoraxCodeHome = memoraxCodeHomeForTrace(process.env),
): ClientTracePaths {
  assertTraceClient(client);
  const root = join(memoraxCodeHome, "debug", "traces", client);
  const sessionsRoot = join(root, "sessions");
  const sessionDir = (sessionId: string) => join(sessionsRoot, sanitizeTracePathSegment(sessionId));
  return {
    root,
    currentTurnPath: join(root, ".current-turn.json"),
    sessionsRoot,
    sessionDir,
    sessionCurrentTurnPath: (sessionId) => join(sessionDir(sessionId), ".current-turn.json"),
    traceJson: (sessionId) => join(sessionDir(sessionId), "trace.json"),
    eventsJsonl: (sessionId) => join(sessionDir(sessionId), "events.jsonl"),
  };
}

export function sanitizeTracePathSegment(
  value: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const raw = value.trim();
  const normalized = raw.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  const segment = !normalized || normalized === "." || normalized === ".." ? "session" : normalized;
  if (platform !== "win32") return segment;

  const withoutTrailingDotsOrSpaces = segment.replace(/[. ]+$/g, "");
  if (
    withoutTrailingDotsOrSpaces === segment
    && !WINDOWS_RESERVED_PATH_SEGMENT.test(segment)
  ) {
    return segment;
  }

  const label = (withoutTrailingDotsOrSpaces || "session").slice(0, WINDOWS_REWRITTEN_LABEL_MAX_CHARS);
  const hash = createHash("sha256").update(raw).digest("hex").slice(0, 12);
  return `_win_${label}-${hash}`;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function positiveInteger(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().replaceAll("_", "");
  if (!/^[1-9]\d*$/.test(normalized)) return fallback;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

function assertTraceClient(client: unknown): asserts client is TraceClient {
  if (!isTraceClient(client)) throw new TypeError("Unsupported trace client");
}
