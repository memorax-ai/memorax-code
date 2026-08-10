import {
  MEMORAX_DEFAULT_BASE_URL,
  MEMORAX_DEFAULT_MEMORY_OUTPUT_LANGUAGE,
  normalizeMemoraxBaseUrl,
  normalizeMemoraxMemoryOutputLanguage,
  type MemoraxMemoryOutputLanguage,
} from "../../../../memorax-code-adapter-common/src/memorax-defaults.mjs";
import {
  defaultMemoraxCodeHome,
  loadMemoraxCodeConfig,
  type MemoraxCodeConfig,
} from "../../config/memorax-code.js";

export { defaultMemoraxCodeHome, memoraxCodeConfigPath, loadMemoraxCodeConfig } from "../../config/memorax-code.js";
export { seedMissingMemoraxCodeConfig } from "../../config/memorax-code.js";
export { MEMORAX_DEFAULT_BASE_URL, MEMORAX_DEFAULT_MEMORY_OUTPUT_LANGUAGE };

export const MEMORAX_PROVIDER_ID = "memory.memorax";
export const MEMORAX_DEFAULT_MEMORY_TYPE_ORDER = ["core", "episodic", "semantic", "procedural", "unclassified"] as const;
export const MEMORAX_DEFAULT_STARTUP_TIMEOUT_MS = 3000;
export const MEMORAX_MIN_STARTUP_TIMEOUT_MS = 100;
export const MEMORAX_MAX_STARTUP_TIMEOUT_MS = 10_000;

export const MEMORY_WRITEBACK_BUFFER_DEFAULT_MAX_TURNS = 8;
export const MEMORY_WRITEBACK_BUFFER_DEFAULT_MAX_AGE_MS = 10 * 60 * 1000;
export const MEMORY_WRITEBACK_BUFFER_DEFAULT_MAX_CHARS = 128_000;
export const MEMORY_WRITEBACK_DEFAULT_MAX_MESSAGE_CHARS = 64_000;
export const MEMORY_WRITEBACK_DEFAULT_CHUNK_MAX_CHARS = 8_000;
export const MEMORY_WRITEBACK_DEFAULT_CHUNK_OVERLAP_RATIO = 0.05;

export const MEMORY_CLI_DEFAULT_SESSION_ID = "memorax-cli";
export const MEMORY_CLI_DEFAULT_MAX_MEMORY_CHARS = 2000;

export type MemoraxAdapterConfig = Readonly<{
  baseUrl: string;
  apiKey: string;
  userId: string;
  memoryOutputLanguage: MemoraxMemoryOutputLanguage;
  topK: number;
  kDense: number;
  kSparse: number;
  timeoutMs: number;
  minScore?: number;
  maxContextChars: number;
  maxItemChars: number;
  memoryTypeOrder: readonly string[];
  renderByMemoryType: boolean;
}>;

export type MemoraxAddOptions = Readonly<{
  contentType?: "dialogue" | "code";
  mode?: "default" | "raw" | "pre_summarized";
}>;

export type MemoryWritebackBufferConfig = Readonly<{
  maxTurns: number;
  maxAgeMs: number;
  maxChars: number;
}>;

export type MemoryWritebackChunkConfig = Readonly<{
  maxChars: number;
  overlapRatio: number;
}>;

export type MemoraxConfigStatus = Readonly<{
  provider: typeof MEMORAX_PROVIDER_ID;
  baseUrl?: string;
  userId?: string;
  configured: boolean;
  search: Readonly<{
    enabled: boolean;
    retrievalEnabled: boolean;
    topK: number;
    kDense: number;
    kSparse: number;
    timeoutMs: number;
    startupTimeoutMs: number;
    minScore?: number;
    maxContextChars: number;
    maxItemChars: number;
    memoryTypeOrder: readonly string[];
    renderByMemoryType: boolean;
  }>;
  writeback: Readonly<{
    globalEnabled: boolean;
    writebackEnabled: boolean;
    writebackBufferEnabled: boolean;
    writebackBuffer: MemoryWritebackBufferConfig;
    writebackMaxMessageChars: number;
    writebackChunkEnabled: boolean;
    writebackChunk: MemoryWritebackChunkConfig;
  }>;
  add: Readonly<{
    contentType?: "dialogue" | "code";
    mode?: "default" | "raw" | "pre_summarized";
    outputLanguage?: MemoraxMemoryOutputLanguage;
  }>;
  cli: Readonly<{
    addEnabled: boolean;
    sessionId: string;
    maxMemoryChars: number;
  }>;
  error?: string;
}>;

export function memoraxConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
  fileConfig?: MemoraxCodeConfig,
): { ok: true; config: MemoraxAdapterConfig } | { ok: false; error: string } {
  const config = configForEnv(env, fileConfig);
  const baseUrl = normalizeMemoraxBaseUrl(stringValue(env.MEMORAX_CODE_MEMORAX_ENDPOINT)
    ?? config.memorax?.endpoint
    ?? MEMORAX_DEFAULT_BASE_URL);
  const apiKey = (stringValue(env.MEMORAX_CODE_MEMORAX_API_KEY) ?? config.memorax?.api_key ?? "").trim();
  const userId = (stringValue(env.MEMORAX_CODE_MEMORAX_USER_ID) ?? config.memorax?.user_id ?? "").trim();
  const outputLanguage = memoraxMemoryOutputLanguage(env, config);
  if (!outputLanguage.ok) return outputLanguage;
  if (!apiKey) return { ok: false, error: "MEMORAX_CODE_MEMORAX_API_KEY is required for memory.memorax" };
  if (!userId) return { ok: false, error: "MEMORAX_CODE_MEMORAX_USER_ID is required for memory.memorax" };
  const searchConfig = memoraxSearchConfig(env, config);
  const minScore = parseScore(env.MEMORAX_CODE_MEMORAX_MIN_SCORE ?? config.memory?.retrieval?.min_score);
  return {
    ok: true,
    config: {
      baseUrl,
      apiKey,
      userId,
      memoryOutputLanguage: outputLanguage.value,
      ...searchConfig,
      ...(minScore === undefined ? {} : { minScore }),
    },
  };
}

function memoraxSearchConfig(
  env: Record<string, string | undefined>,
  config: MemoraxCodeConfig,
): Pick<MemoraxAdapterConfig,
  "topK"
  | "kDense"
  | "kSparse"
  | "timeoutMs"
  | "maxContextChars"
  | "maxItemChars"
  | "memoryTypeOrder"
  | "renderByMemoryType"
> {
  const topK = clampInteger(env.MEMORAX_CODE_MEMORAX_TOP_K ?? config.memory?.retrieval?.top_k, 1, 100, config.memory?.retrieval?.top_k ?? 6);
  return {
    topK,
    kDense: clampInteger(env.MEMORAX_CODE_MEMORAX_K_DENSE ?? config.memory?.retrieval?.k_dense, 0, 100, config.memory?.retrieval?.k_dense ?? topK),
    kSparse: clampInteger(env.MEMORAX_CODE_MEMORAX_K_SPARSE ?? config.memory?.retrieval?.k_sparse, 0, 100, config.memory?.retrieval?.k_sparse ?? topK),
    timeoutMs: clampInteger(env.MEMORAX_CODE_MEMORAX_TIMEOUT_MS ?? config.memorax?.timeout_ms, 1000, 120_000, config.memorax?.timeout_ms ?? 5000),
    maxContextChars: clampInteger(env.MEMORAX_CODE_MEMORAX_MAX_CONTEXT_CHARS ?? config.memory?.retrieval?.max_context_chars, 256, 200_000, config.memory?.retrieval?.max_context_chars ?? 4000),
    maxItemChars: clampInteger(env.MEMORAX_CODE_MEMORAX_MAX_ITEM_CHARS ?? config.memory?.retrieval?.max_item_chars, 64, 50_000, config.memory?.retrieval?.max_item_chars ?? 1000),
    memoryTypeOrder: parseStringList(env.MEMORAX_CODE_MEMORAX_MEMORY_TYPE_ORDER ?? config.memory?.retrieval?.memory_type_order, config.memory?.retrieval?.memory_type_order ?? [...MEMORAX_DEFAULT_MEMORY_TYPE_ORDER]),
    renderByMemoryType: parseBoolean(env.MEMORAX_CODE_MEMORAX_RENDER_BY_MEMORY_TYPE, config.memory?.retrieval?.render_by_memory_type ?? true),
  };
}

export function startupRetrieveTimeoutMs(
  env: Record<string, string | undefined>,
  providerTimeoutMs: number,
  fileConfig?: MemoraxCodeConfig,
): number {
  const config = configForEnv(env, fileConfig);
  const startupCap = clampInteger(
    env.MEMORAX_CODE_MEMORAX_STARTUP_TIMEOUT_MS ?? config.memorax?.startup_timeout_ms,
    MEMORAX_MIN_STARTUP_TIMEOUT_MS,
    MEMORAX_MAX_STARTUP_TIMEOUT_MS,
    config.memorax?.startup_timeout_ms ?? MEMORAX_DEFAULT_STARTUP_TIMEOUT_MS,
  );
  return Math.min(providerTimeoutMs, startupCap);
}

export function memoraxWritebackEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.MEMORAX_CODE_MEMORAX_WRITEBACK_ENABLED !== "false";
}

export function memoryRetrievalEnabled(
  env: Record<string, string | undefined> = process.env,
  fileConfig?: MemoraxCodeConfig,
): boolean {
  const config = configForEnv(env, fileConfig);
  return parseBoolean(env.MEMORAX_CODE_MEMORY_RETRIEVAL_ENABLED, config.memory?.retrieval?.enabled) === true;
}

export function memoryWritebackEnabled(
  env: Record<string, string | undefined> = process.env,
  fileConfig?: MemoraxCodeConfig,
): boolean {
  const config = configForEnv(env, fileConfig);
  return memoraxWritebackEnabled(env)
    && memoryWritebackBufferConfig(env, config).maxTurns !== -1
    && parseBoolean(env.MEMORAX_CODE_MEMORY_WRITEBACK_ENABLED, config.memory?.writeback?.enabled) === true;
}

export function memoryWritebackBufferEnabled(
  env: Record<string, string | undefined> = process.env,
  fileConfig?: MemoraxCodeConfig,
): boolean {
  const config = configForEnv(env, fileConfig);
  return parseBoolean(env.MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_ENABLED, config.memory?.writeback?.buffer_enabled ?? true) !== false;
}

export function memoryWritebackBufferConfig(
  env: Record<string, string | undefined> = process.env,
  fileConfig?: MemoraxCodeConfig,
): MemoryWritebackBufferConfig {
  const config = configForEnv(env, fileConfig);
  return {
    maxTurns: memoryWritebackAddInterval(env.MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_MAX_TURNS ?? config.memory?.writeback?.buffer_max_turns),
    maxAgeMs: positiveInteger(env.MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_MAX_AGE_MS ?? config.memory?.writeback?.buffer_max_age_ms, config.memory?.writeback?.buffer_max_age_ms ?? MEMORY_WRITEBACK_BUFFER_DEFAULT_MAX_AGE_MS),
    maxChars: positiveInteger(env.MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_MAX_CHARS ?? config.memory?.writeback?.buffer_max_chars, config.memory?.writeback?.buffer_max_chars ?? MEMORY_WRITEBACK_BUFFER_DEFAULT_MAX_CHARS),
  };
}

function memoryWritebackAddInterval(value: unknown): number {
  if (String(value ?? "").trim() === "-1") return -1;
  return positiveInteger(value, MEMORY_WRITEBACK_BUFFER_DEFAULT_MAX_TURNS);
}

export function memoryWritebackMaxMessageChars(
  env: Record<string, string | undefined> = process.env,
  fileConfig?: MemoraxCodeConfig,
): number {
  const config = configForEnv(env, fileConfig);
  return positiveInteger(env.MEMORAX_CODE_MEMORY_WRITEBACK_MAX_MESSAGE_CHARS ?? config.memory?.writeback?.max_message_chars, config.memory?.writeback?.max_message_chars ?? MEMORY_WRITEBACK_DEFAULT_MAX_MESSAGE_CHARS);
}

export function memoryWritebackChunkEnabled(
  env: Record<string, string | undefined> = process.env,
  fileConfig?: MemoraxCodeConfig,
): boolean {
  const config = configForEnv(env, fileConfig);
  return parseBoolean(env.MEMORAX_CODE_MEMORY_WRITEBACK_CHUNK_ENABLED, config.memory?.writeback?.chunk_enabled ?? true) !== false;
}

export function memoryWritebackChunkConfig(
  env: Record<string, string | undefined> = process.env,
  fileConfig?: MemoraxCodeConfig,
): MemoryWritebackChunkConfig {
  const config = configForEnv(env, fileConfig);
  return {
    maxChars: positiveInteger(env.MEMORAX_CODE_MEMORY_WRITEBACK_CHUNK_MAX_CHARS ?? config.memory?.writeback?.chunk_max_chars, config.memory?.writeback?.chunk_max_chars ?? MEMORY_WRITEBACK_DEFAULT_CHUNK_MAX_CHARS),
    overlapRatio: boundedRatio(env.MEMORAX_CODE_MEMORY_WRITEBACK_CHUNK_OVERLAP_RATIO ?? config.memory?.writeback?.chunk_overlap_ratio, config.memory?.writeback?.chunk_overlap_ratio ?? MEMORY_WRITEBACK_DEFAULT_CHUNK_OVERLAP_RATIO),
  };
}

export function memoryCliAddEnabled(
  env: Record<string, string | undefined> = process.env,
  fileConfig?: MemoraxCodeConfig,
): boolean {
  const config = configForEnv(env, fileConfig);
  return parseBoolean(env.MEMORAX_CODE_MEMORY_CLI_ADD_ENABLED, config.memory?.cli?.add_enabled ?? true) === true
    && memoraxWritebackEnabled(env);
}

export function memoryCliSessionId(args: string[] = [], env: Record<string, string | undefined> = process.env): string {
  return argValue(args, "--session-id")?.trim()
    || env.MEMORAX_CODE_MEMORY_CLI_SESSION_ID?.trim()
    || env.MEMORAX_CODE_MEMORAX_SESSION_ID?.trim()
    || MEMORY_CLI_DEFAULT_SESSION_ID;
}

export function memoryCliMaxMemoryChars(
  env: Record<string, string | undefined> = process.env,
  fileConfig?: MemoraxCodeConfig,
): number {
  const config = configForEnv(env, fileConfig);
  return positiveInteger(env.MEMORAX_CODE_MEMORY_CLI_MAX_MEMORY_CHARS ?? config.memory?.cli?.max_memory_chars, config.memory?.cli?.max_memory_chars ?? MEMORY_CLI_DEFAULT_MAX_MEMORY_CHARS);
}

export function memoraxAddOptionsFromContext(
  context: Record<string, unknown>,
  env: Record<string, string | undefined> = process.env,
  fileConfig?: MemoraxCodeConfig,
): { ok: true; options: MemoraxAddOptions } | { ok: false; error: string } {
  const config = configForEnv(env, fileConfig);
  const contentTypeValue = stringValue(context.contentType)
    ?? stringValue(context.content_type)
    ?? stringValue(env.MEMORAX_CODE_MEMORAX_ADD_CONTENT_TYPE)
    ?? config.memory?.add?.content_type;
  const modeValue = stringValue(context.mode)
    ?? stringValue(env.MEMORAX_CODE_MEMORAX_ADD_MODE)
    ?? config.memory?.add?.mode;
  const contentTypeResult = parseAddContentType(contentTypeValue, "content_type");
  if (!contentTypeResult.ok) return contentTypeResult;
  const modeResult = parseAddMode(modeValue, "mode");
  if (!modeResult.ok) return modeResult;

  const contentType = contentTypeResult.value;
  const mode = modeResult.value ?? (contentType ? "default" : undefined);
  return {
    ok: true,
    options: {
      ...(contentType ? { contentType } : {}),
      ...(mode ? { mode } : {}),
    },
  };
}

export function memoryConfigStatus(
  env: Record<string, string | undefined> = process.env,
  fileConfig?: MemoraxCodeConfig,
): MemoraxConfigStatus {
  const config = configForEnv(env, fileConfig);
  const configResult = memoraxConfigFromEnv(env, config);
  const baseConfig = configResult.ok ? configResult.config : undefined;
  const addStatus = memoraxAddStatus(env, config);
  const fallbackSearchConfig = {
    ...memoraxSearchConfig(env, config),
    minScore: parseScore(env.MEMORAX_CODE_MEMORAX_MIN_SCORE ?? config.memory?.retrieval?.min_score),
  };
  const searchConfig = baseConfig ?? fallbackSearchConfig;
  return {
    provider: MEMORAX_PROVIDER_ID,
    ...(baseConfig ? { baseUrl: baseConfig.baseUrl, userId: baseConfig.userId } : {}),
    configured: configResult.ok,
    search: {
      enabled: configResult.ok,
      retrievalEnabled: memoryRetrievalEnabled(env, config),
      topK: searchConfig.topK,
      kDense: searchConfig.kDense,
      kSparse: searchConfig.kSparse,
      timeoutMs: searchConfig.timeoutMs,
      startupTimeoutMs: startupRetrieveTimeoutMs(env, searchConfig.timeoutMs, config),
      ...(searchConfig.minScore === undefined ? {} : { minScore: searchConfig.minScore }),
      maxContextChars: searchConfig.maxContextChars,
      maxItemChars: searchConfig.maxItemChars,
      memoryTypeOrder: searchConfig.memoryTypeOrder,
      renderByMemoryType: searchConfig.renderByMemoryType,
    },
    writeback: {
      globalEnabled: memoraxWritebackEnabled(env),
      writebackEnabled: memoryWritebackEnabled(env, config),
      writebackBufferEnabled: memoryWritebackBufferEnabled(env, config),
      writebackBuffer: memoryWritebackBufferConfig(env, config),
      writebackMaxMessageChars: memoryWritebackMaxMessageChars(env, config),
      writebackChunkEnabled: memoryWritebackChunkEnabled(env, config),
      writebackChunk: memoryWritebackChunkConfig(env, config),
    },
    add: addStatus,
    cli: {
      addEnabled: memoryCliAddEnabled(env, config),
      sessionId: memoryCliSessionId([], env),
      maxMemoryChars: memoryCliMaxMemoryChars(env, config),
    },
    ...(configResult.ok ? {} : { error: configResult.error }),
  };
}

function configForEnv(
  env: Record<string, string | undefined>,
  fileConfig?: MemoraxCodeConfig,
): MemoraxCodeConfig {
  return fileConfig ?? loadMemoraxCodeConfig(defaultMemoraxCodeHome(env));
}

function memoraxAddStatus(
  env: Record<string, string | undefined>,
  fileConfig?: MemoraxCodeConfig,
): MemoraxConfigStatus["add"] {
  const config = configForEnv(env, fileConfig);
  const contentTypeResult = parseAddContentType(stringValue(env.MEMORAX_CODE_MEMORAX_ADD_CONTENT_TYPE) ?? config.memory?.add?.content_type, "content_type");
  const modeResult = parseAddMode(stringValue(env.MEMORAX_CODE_MEMORAX_ADD_MODE) ?? config.memory?.add?.mode, "mode");
  const outputLanguage = memoraxMemoryOutputLanguage(env, config);
  return {
    ...(contentTypeResult.ok && contentTypeResult.value ? { contentType: contentTypeResult.value } : {}),
    ...(modeResult.ok && modeResult.value ? { mode: modeResult.value } : {}),
    ...(outputLanguage.ok ? { outputLanguage: outputLanguage.value } : {}),
  };
}

function memoraxMemoryOutputLanguage(
  env: Record<string, string | undefined>,
  config: MemoraxCodeConfig,
): { ok: true; value: MemoraxMemoryOutputLanguage } | { ok: false; error: string } {
  const raw = stringValue(env.MEMORAX_CODE_MEMORY_OUTPUT_LANGUAGE)
    ?? stringValue(config.memory?.add?.output_language)
    ?? MEMORAX_DEFAULT_MEMORY_OUTPUT_LANGUAGE;
  const value = normalizeMemoraxMemoryOutputLanguage(raw);
  return value
    ? { ok: true, value }
    : { ok: false, error: "memory output language must be zh or en" };
}

function parseAddContentType(value: string | undefined, label: string): { ok: true; value?: "dialogue" | "code" } | { ok: false; error: string } {
  if (!value) return { ok: true };
  if (value === "dialogue" || value === "code") return { ok: true, value };
  return { ok: false, error: `${label} must be dialogue or code` };
}

function parseAddMode(value: string | undefined, label: string): { ok: true; value?: MemoraxAddOptions["mode"] } | { ok: false; error: string } {
  if (!value) return { ok: true };
  if (value === "default" || value === "raw" || value === "pre_summarized") return { ok: true, value };
  return { ok: false, error: `${label} must be default, raw, or pre_summarized` };
}

export function parseBoolean(value: unknown): boolean | undefined;
export function parseBoolean(value: unknown, fallback: boolean): boolean;
export function parseBoolean(value: unknown, fallback: boolean | undefined): boolean | undefined;
export function parseBoolean(value: unknown, fallback?: boolean): boolean | undefined {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
}

export function positiveInteger(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value).trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function boundedRatio(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value).trim());
  return Number.isFinite(parsed) && parsed >= 0 && parsed < 1 ? parsed : fallback;
}

export function clampInteger(value: unknown, min: number, max: number, fallback = min): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}

export function parseScore(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 1 ? number : undefined;
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function parseStringList(value: unknown, fallback: readonly string[]): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value !== "string" || !value.trim()) return [...fallback];
  const items = value.split(",").map((item) => item.trim()).filter(Boolean);
  return items.length > 0 ? items : [...fallback];
}

function argValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}
