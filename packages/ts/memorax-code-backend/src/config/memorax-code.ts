import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { ensurePrivateConfigDirectory } from "../../../memorax-code-adapter-common/src/memorax-code-config-file.mjs";
import {
  MEMORAX_DEFAULT_BASE_URL,
  MEMORAX_DEFAULT_MEMORY_OUTPUT_LANGUAGE,
  type MemoraxMemoryOutputLanguage,
} from "../../../memorax-code-adapter-common/src/memorax-defaults.mjs";

export type MemoraxCodeConfig = Readonly<{
  clients?: Readonly<{
    codex?: boolean;
    claude?: boolean;
    opencode?: boolean;
  }>;
  memorax?: Readonly<{
    endpoint?: string;
    api_key?: string;
    user_id?: string;
    timeout_ms?: number;
    startup_timeout_ms?: number;
  }>;
  memory?: Readonly<{
    retrieval?: Readonly<{
      enabled?: boolean;
      top_k?: number;
      k_dense?: number;
      k_sparse?: number;
      min_score?: number;
      max_context_chars?: number;
      max_item_chars?: number;
      render_by_memory_type?: boolean;
      memory_type_order?: readonly string[];
    }>;
    writeback?: Readonly<{
      enabled?: boolean;
      buffer_enabled?: boolean;
      buffer_max_turns?: number;
      buffer_max_age_ms?: number;
      buffer_max_chars?: number;
      max_message_chars?: number;
      chunk_enabled?: boolean;
      chunk_max_chars?: number;
      chunk_overlap_ratio?: number;
    }>;
    add?: Readonly<{
      content_type?: "dialogue" | "code";
      mode?: "default" | "raw" | "pre_summarized";
      output_language?: MemoraxMemoryOutputLanguage;
    }>;
    cli?: Readonly<{
      add_enabled?: boolean;
      max_memory_chars?: number;
    }>;
    skill_reminder?: Readonly<{
      interval_turns?: number;
    }>;
    repo_update?: Readonly<{
      policy?:
        | "every-commit"
        | "commit-count"
        | "daily"
        | "pull-request"
        | "pull-request-or-daily"
        | "adaptive";
      commit_threshold?: number;
      cooldown_hours?: number;
    }>;
  }>;
  trace?: Readonly<{
    codex?: Readonly<{
      enabled?: boolean;
      capture_content?: boolean;
      retention_days?: number;
      max_event_chars?: number;
      max_file_bytes?: number;
    }>;
    claude?: Readonly<{
      enabled?: boolean;
      capture_content?: boolean;
      retention_days?: number;
      max_event_chars?: number;
      max_file_bytes?: number;
    }>;
    opencode?: Readonly<{
      enabled?: boolean;
      capture_content?: boolean;
      retention_days?: number;
      max_event_chars?: number;
      max_file_bytes?: number;
    }>;
  }>;
}>;

export function defaultMemoraxCodeHome(env: Record<string, string | undefined> = process.env): string {
  return env.MEMORAX_CODE_HOME?.trim() || join(homedir(), ".memorax-code");
}

export function memoraxCodeConfigPath(memoraxCodeHome = defaultMemoraxCodeHome(process.env)): string {
  return join(memoraxCodeHome, "config.toml");
}

export function renderDefaultMemoraxCodeConfig(): string {
  return [
    "# MemoraX Code local config.",
    "# This file is read from $MEMORAX_CODE_HOME/config.toml.",
    "# Environment variables still override values written here.",
    "# See docs/configuration.md for advanced tuning fields and effective defaults.",
    "",
    "# Client integrations managed by `memorax-code start|status|stop|uninstall`.",
    "[clients]",
    "codex = true",
    "claude = true",
    "opencode = true",
    "",
    "# MemoraX remote-memory connection. Credentials may also come from the environment.",
    "[memorax]",
    `# endpoint = "${MEMORAX_DEFAULT_BASE_URL}" # MemoraX service URL.`,
    '# api_key = "" # MemoraX API key used by the local Backend.',
    '# user_id = "" # MemoraX base user ID; requests derive a workspace-scoped namespace.',
    "",
    "# Automatic Hook retrieval is opt-in.",
    "[memory.retrieval]",
    "enabled = false # Auto-inject retrieved memories into supported client prompts.",
    "",
    "# Automatic writeback sends selected prompts and final answers to MemoraX.",
    "[memory.writeback]",
    "enabled = true # Allow supported client sessions to write memories after replies.",
    "",
    "# Preferred language for newly generated MemoraX memories.",
    "[memory.add]",
    `output_language = "${MEMORAX_DEFAULT_MEMORY_OUTPUT_LANGUAGE}" # Language for newly generated MemoraX memories.`,
    "",
    "# Controls how often Codex, Claude Code, and OpenCode native client sessions see the MemoraX Code skill reminder.",
    "[memory.skill_reminder]",
    "interval_turns = 5 # Show the MemoraX Code skill reminder every N native client turns, starting on the first turn.",
    "",
    "# Relevant repo reads batch generated repo-memory updates by commit count or elapsed time.",
    "[memory.repo_update]",
    'policy = "adaptive" # every-commit / commit-count / daily / pull-request / pull-request-or-daily / adaptive.',
    "commit_threshold = 5 # Pending local commits needed by commit-count and adaptive.",
    "cooldown_hours = 24 # Pending-commit age used by daily, pull-request-or-daily, and adaptive.",
    "",
    "# Local traces may contain prompts, responses, recalled memories, and local paths.",
    "[trace.codex]",
    "enabled = true # Enable local Codex session memory trace collection.",
    "capture_content = true # Store content in local Codex trace events.",
    "",
    "[trace.claude]",
    "enabled = true # Enable local Claude session memory trace collection.",
    "capture_content = true # Store content in local Claude trace events.",
    "",
    "[trace.opencode]",
    "enabled = true # Enable local OpenCode session memory trace collection.",
    "capture_content = true # Store content in local OpenCode trace events.",
    "",
  ].join("\n");
}

export async function seedMissingMemoraxCodeConfig(
  memoraxCodeHome = defaultMemoraxCodeHome(process.env),
): Promise<boolean> {
  const path = memoraxCodeConfigPath(memoraxCodeHome);
  ensurePrivateConfigDirectory(path);
  try {
    await writeFile(path, renderDefaultMemoraxCodeConfig(), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") return false;
    throw error;
  }
}

export function loadMemoraxCodeConfig(
  memoraxCodeHome = defaultMemoraxCodeHome(process.env),
  options: { warn?: (message: string) => void } = {},
): MemoraxCodeConfig {
  const path = memoraxCodeConfigPath(memoraxCodeHome);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return {};
    (options.warn ?? console.warn)(`failed to read MemoraX Code config ${path}: ${errorMessage(error)}`);
    return {};
  }

  try {
    return normalizeMemoraxCodeConfig(parse(text));
  } catch (error) {
    (options.warn ?? console.warn)(`failed to parse MemoraX Code config ${path}: ${errorMessage(error)}`);
    return {};
  }
}

export function loadLifecycleMemoraxCodeConfig(
  memoraxCodeHome = defaultMemoraxCodeHome(process.env),
): MemoraxCodeConfig {
  const path = memoraxCodeConfigPath(memoraxCodeHome);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return {};
    throw new Error(`failed to read MemoraX Code lifecycle config ${path}: ${errorMessage(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = parse(text);
  } catch {
    throw new Error(`failed to parse MemoraX Code lifecycle config ${path}`);
  }
  validateRawLifecycleConfig(parsed, path);
  return normalizeMemoraxCodeConfig(parsed);
}

function normalizeMemoraxCodeConfig(value: unknown): MemoraxCodeConfig {
  const root = recordValue(value);
  const clients = recordValue(root?.clients);
  const memorax = recordValue(root?.memorax);
  const memory = recordValue(root?.memory);
  const trace = recordValue(root?.trace);
  const retrieval = recordValue(memory?.retrieval);
  const writeback = recordValue(memory?.writeback);
  const add = recordValue(memory?.add);
  const cli = recordValue(memory?.cli);
  const skillReminder = recordValue(memory?.skill_reminder);
  const repoUpdate = recordValue(memory?.repo_update);
  const traceCodex = recordValue(trace?.codex);
  const traceClaude = recordValue(trace?.claude);
  const traceOpenCode = recordValue(trace?.opencode);

  return (prune({
    clients: prune({
      codex: booleanField(clients, "codex"),
      claude: booleanField(clients, "claude"),
      opencode: booleanField(clients, "opencode"),
    }),
    memorax: prune({
      endpoint: stringField(memorax, "endpoint"),
      api_key: stringField(memorax, "api_key"),
      user_id: stringField(memorax, "user_id"),
      timeout_ms: numberField(memorax, "timeout_ms"),
      startup_timeout_ms: numberField(memorax, "startup_timeout_ms"),
    }),
    memory: prune({
      retrieval: prune({
        enabled: booleanField(retrieval, "enabled"),
        top_k: numberField(retrieval, "top_k"),
        k_dense: numberField(retrieval, "k_dense"),
        k_sparse: numberField(retrieval, "k_sparse"),
        min_score: numberField(retrieval, "min_score"),
        max_context_chars: numberField(retrieval, "max_context_chars"),
        max_item_chars: numberField(retrieval, "max_item_chars"),
        render_by_memory_type: booleanField(retrieval, "render_by_memory_type"),
        memory_type_order: stringArrayField(retrieval, "memory_type_order"),
      }),
      writeback: prune({
        enabled: booleanField(writeback, "enabled"),
        buffer_enabled: booleanField(writeback, "buffer_enabled"),
        buffer_max_turns: numberField(writeback, "buffer_max_turns"),
        buffer_max_age_ms: numberField(writeback, "buffer_max_age_ms"),
        buffer_max_chars: numberField(writeback, "buffer_max_chars"),
        max_message_chars: numberField(writeback, "max_message_chars"),
        chunk_enabled: booleanField(writeback, "chunk_enabled"),
        chunk_max_chars: numberField(writeback, "chunk_max_chars"),
        chunk_overlap_ratio: numberField(writeback, "chunk_overlap_ratio"),
      }),
      add: prune({
        content_type: stringField(add, "content_type"),
        mode: stringField(add, "mode"),
        output_language: stringField(add, "output_language"),
      }),
      cli: prune({
        add_enabled: booleanField(cli, "add_enabled"),
        max_memory_chars: numberField(cli, "max_memory_chars"),
      }),
      skill_reminder: prune({
        interval_turns: numberField(skillReminder, "interval_turns"),
      }),
      repo_update: prune({
        policy: repoMemoryUpdatePolicyField(repoUpdate, "policy"),
        commit_threshold: numberField(repoUpdate, "commit_threshold"),
        cooldown_hours: numberField(repoUpdate, "cooldown_hours"),
      }),
    }),
    trace: prune({
      codex: prune({
        enabled: booleanField(traceCodex, "enabled"),
        capture_content: booleanField(traceCodex, "capture_content"),
        retention_days: numberField(traceCodex, "retention_days"),
        max_event_chars: numberField(traceCodex, "max_event_chars"),
        max_file_bytes: numberField(traceCodex, "max_file_bytes"),
      }),
      claude: prune({
        enabled: booleanField(traceClaude, "enabled"),
        capture_content: booleanField(traceClaude, "capture_content"),
        retention_days: numberField(traceClaude, "retention_days"),
        max_event_chars: numberField(traceClaude, "max_event_chars"),
        max_file_bytes: numberField(traceClaude, "max_file_bytes"),
      }),
      opencode: prune({
        enabled: booleanField(traceOpenCode, "enabled"),
        capture_content: booleanField(traceOpenCode, "capture_content"),
        retention_days: numberField(traceOpenCode, "retention_days"),
        max_event_chars: numberField(traceOpenCode, "max_event_chars"),
        max_file_bytes: numberField(traceOpenCode, "max_file_bytes"),
      }),
    }),
  }) ?? {}) as MemoraxCodeConfig;
}

function validateRawLifecycleConfig(value: unknown, path: string): void {
  const root = tableValue(value);
  if (!root) throw invalidLifecycleConfig(path, "config root must be a table");

  const rawClients = root.clients;
  if (rawClients !== undefined) {
    const clients = tableValue(rawClients);
    if (!clients) throw invalidLifecycleConfig(path, "clients must be a table");
    for (const field of ["codex", "claude", "opencode"] as const) {
      if (clients[field] !== undefined && typeof clients[field] !== "boolean") {
        throw invalidLifecycleConfig(path, `clients.${field} must be a boolean`);
      }
    }
  }
}

function invalidLifecycleConfig(path: string, detail: string): Error {
  return new Error(`invalid MemoraX Code lifecycle config ${path}: ${detail}`);
}

function tableValue(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? value as Record<string, unknown>
    : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function repoMemoryUpdatePolicyField(
  record: Record<string, unknown> | undefined,
  key: string,
): NonNullable<NonNullable<MemoraxCodeConfig["memory"]>["repo_update"]>["policy"] | undefined {
  const value = stringField(record, key);
  return value === "every-commit"
    || value === "commit-count"
    || value === "daily"
    || value === "pull-request"
    || value === "pull-request-or-daily"
    || value === "adaptive"
    ? value
    : undefined;
}

function numberField(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanField(record: Record<string, unknown> | undefined, key: string): boolean | undefined {
  const value = record?.[key];
  return typeof value === "boolean" ? value : undefined;
}

function stringArrayField(record: Record<string, unknown> | undefined, key: string): string[] | undefined {
  const value = record?.[key];
  if (!Array.isArray(value)) return undefined;
  const items = value.map((item) => typeof item === "string" ? item.trim() : "").filter(Boolean);
  return items.length ? items : undefined;
}

function prune(values: Record<string, unknown>): Record<string, unknown> | undefined {
  const entries = Object.entries(values).filter(([, value]) => value !== undefined);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
