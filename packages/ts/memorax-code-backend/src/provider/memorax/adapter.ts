import {
  MEMORAX_DEFAULT_MEMORY_OUTPUT_LANGUAGE,
  MEMORAX_PROVIDER_ID,
  clampInteger,
  memoraxAddOptionsFromContext,
  memoraxConfigFromEnv,
  parseScore,
} from "./config.js";
import type { MemoraxAdapterConfig, MemoraxAddOptions } from "./config.js";
import {
  memoraxInvocationFailure,
  postMemoraxJson,
  type MemoraxInvocationFailure,
  type MemoraxJsonResponse,
} from "./http.js";
import type { MemoraxQuotaSnapshot } from "./quota.js";
import type {
  MemoryDiagnosticLogger,
  MemoryObservabilityEvent,
  MemoryObservabilityHook,
  MemoryObservabilityRelatedTurn,
  MemoryObservabilitySource,
} from "../../memory/observability.js";
import {
  repositoryMemoryScopeKind,
  type RepositoryMemoryScope,
} from "../../repository/scope.js";
import type { TraceContext } from "../../trace/context.js";
import { isRecord } from "../../shared/record.js";
import { parseNativeMessageTimestamp } from "../../shared/message-time.js";
import { normalizeContentParts, observedMessageContent, type MemoraxMessageContent } from "./content-parts.js";

const SLOT_RESULT_SCHEMA_VERSION = "slot-invocation-result.preview.v1";
const FORWARDED_WRITEBACK_METADATA_KEYS = [
  "memorax_code_memory_reason",
  "memory_type",
  "source_detail",
] as const;
export { memoraxConfigFromEnv } from "./config.js";
export type {
  MemoraxInvocationErrorKind,
  MemoraxInvocationFailure,
} from "./http.js";
export type { MemoraxQuotaSnapshot } from "./quota.js";

export type MemoraxSlotInvocationRequest = {
  provider_family?: string;
  provider_id?: string;
  transport?: string;
  slot?: string;
  operation: string;
  dispatch?: string;
  query?: string;
  content?: string;
  context?: unknown;
};

export type MemoraxAdapterOptions = {
  config?: MemoraxAdapterConfig;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  diagnosticLogger?: MemoryDiagnosticLogger;
  observability?: MemoryObservabilityHook;
  observabilitySource?: MemoryObservabilitySource;
  relatedTurns?: MemoryObservabilityRelatedTurn[];
  repositoryScope?: RepositoryMemoryScope;
  traceContext?: TraceContext;
  writebackAttempt?: {
    attempt: number;
    maxAttempts: number;
  };
};

export type MemoraxInvocationResult =
  | { ok: true; result: Record<string, unknown> & { quota?: MemoraxQuotaSnapshot } }
  | MemoraxInvocationFailure;

type MemoraxContextBlock = {
  type: "memory_context";
  source: "memorax";
  content: string;
  itemCount: number;
};

type MemoraxSearchPayload = {
  query: string;
  user_id: string;
  top_k: number;
  k_dense: number;
  k_sparse: number;
  filters?: unknown;
  min_semantic_similarity?: number;
  sources?: Array<"dialogue" | "document">;
  document_ids?: string[];
  mode?: "fast";
  output_mode?: "facts";
};

type MemoraxAddPayload = {
  messages: Array<{ role: "user" | "assistant"; content: MemoraxMessageContent; timestamp: number }>;
  user_id: string;
  memory_output_language: "zh" | "en";
  mode?: MemoraxAddOptions["mode"];
  content_type?: MemoraxAddOptions["contentType"];
  chunk?: {
    group_id: string;
    index: number;
    count: number;
  };
  session_id?: string;
  metadata: Record<string, unknown>;
  async_mode: true;
  timestamp: number;
};

type MemoraxWritebackMessage = {
  role: "user" | "assistant";
  content: MemoraxMessageContent;
  timestamp?: number;
  timestampSource?: "native" | "observed";
};

type MemoraxRunContext = {
  prompt: string;
  sessionId: string;
  branchId?: string;
};

export async function invokeMemoraxMemoryProvider(
  run: MemoraxRunContext,
  request: MemoraxSlotInvocationRequest,
  options: MemoraxAdapterOptions = {},
): Promise<MemoraxInvocationResult> {
  const configResult = options.config ? { ok: true as const, config: options.config } : memoraxConfigFromEnv(options.env);
  if (!configResult.ok) return { ok: false, error: configResult.error };
  const config = configResult.config;
  const providerId = request.provider_id?.trim() || MEMORAX_PROVIDER_ID;
  if (providerId !== MEMORAX_PROVIDER_ID) return { ok: false, error: `unsupported MemoraX provider id ${providerId}` };
  const operation = request.operation;
  if (operation !== "query" && operation !== "writeback") {
    return { ok: false, error: `unsupported MemoraX memory operation ${operation}` };
  }
  if (operation === "writeback") {
    const repositoryScope = repositoryScopeForConfig(config, options.repositoryScope);
    if (!repositoryScope.ok) return repositoryScope;
    return await invokeMemoraxWriteback(run, request, config, repositoryScope.scope, options);
  }

  const query = typeof request.query === "string" && request.query.trim()
    ? request.query.trim()
    : "";
  if (!query) return { ok: false, error: "query is required" };

  const context = isRecord(request.context) ? request.context : {};
  const repositoryScope = repositoryScopeForConfig(config, options.repositoryScope);
  if (!repositoryScope.ok) return repositoryScope;
  const selectionError = validateSearchSelection(context);
  if (selectionError) return { ok: false, error: selectionError };
  const payload = buildMemoraxSearchPayload(config, query, context, repositoryScope.scope);
  try {
    const { body: raw, quota } = await callMemoSearch(config, payload, options.fetchImpl);
    const items = extractMemoraxSearchItems(raw);
    const contextBlocks = renderMemoraxContextBlocks(items, config);
    const promptFragments = contextBlocks.map((block) => ({
      slot: request.slot || "state_context",
      content: block.content,
      source: "memorax",
    }));
    recordMemoryObservabilityEvent(options, {
      operation,
      ok: true,
      request: {
        slot: request.slot || "state_context",
        payload,
      },
      response: {
        receiptId: memoraxReceiptId(raw),
        items,
        contextBlocks,
        promptFragments,
        buckets: extractMemoraxBuckets(raw),
      },
    });
    return {
      ok: true,
      result: {
        schema_version: SLOT_RESULT_SCHEMA_VERSION,
        provider_family: "memory",
        provider_id: providerId,
        slot: request.slot || "state_context",
        operation,
        prompt_fragments: promptFragments,
        ...(quota ? { quota } : {}),
        tool_result_payload: {
          answer: contextBlocks.map((block) => block.content).join("\n\n"),
          items,
          contextBlocks,
          buckets: extractMemoraxBuckets(raw),
        },
        dispatch_receipt: {
          accepted: true,
          receipt_id: memoraxReceiptId(raw),
          summary: `memorax ${operation} returned ${items.length} item(s)`,
        },
      },
    };
  } catch (error) {
    const failure = memoraxInvocationFailure(error);
    recordMemoryObservabilityEvent(options, {
      operation,
      ok: false,
      request: {
        slot: request.slot || "state_context",
        payload,
      },
      error: failure.error,
    });
    return failure;
  }
}

export function memoraxSessionIdForRun(run: { sessionId: string; branchId?: string }): string {
  return run.branchId?.trim() || run.sessionId;
}

export function buildMemoraxSearchPayload(
  config: MemoraxAdapterConfig,
  query: string,
  context: Record<string, unknown>,
  repositoryScope: RepositoryMemoryScope,
): MemoraxSearchPayload {
  const limit = typeof context.limit === "number" ? context.limit : undefined;
  const minSemanticSimilarity = typeof context.min_semantic_similarity === "number"
    ? parseScore(context.min_semantic_similarity)
    : typeof context.min_score === "number"
      ? parseScore(context.min_score)
      : config.minScore;
  const topK = clampInteger(limit ?? config.topK, 1, 50);
  const kDense = typeof context.k_dense === "number" ? clampInteger(context.k_dense, 0, 50) : clampInteger(config.kDense ?? topK, 0, 50);
  const kSparse = typeof context.k_sparse === "number" ? clampInteger(context.k_sparse, 0, 50) : clampInteger(config.kSparse ?? topK, 0, 50);
  return {
    query,
    user_id: repositoryScope.effectiveUserId,
    top_k: topK,
    k_dense: kDense,
    k_sparse: kSparse,
    ...(context.sources === undefined ? {} : { sources: context.sources as Array<"dialogue" | "document">, mode: "fast" as const, output_mode: "facts" as const }),
    ...(context.document_ids === undefined ? {} : { document_ids: context.document_ids as string[] }),
    ...(isRecord(context.filters) ? { filters: context.filters } : {}),
    ...(minSemanticSimilarity === undefined
      ? {}
      : { min_semantic_similarity: minSemanticSimilarity }),
  };
}

function validateSearchSelection(context: Record<string, unknown>): string | undefined {
  const sources = context.sources;
  if (sources !== undefined && (!Array.isArray(sources) || sources.length < 1 || sources.length > 2
    || sources.some((source) => source !== "dialogue" && source !== "document")
    || new Set(sources).size !== sources.length)) {
    return "sources must contain unique dialogue or document values";
  }
  const ids = context.document_ids;
  if (ids !== undefined && (!Array.isArray(sources) || sources.length !== 1 || sources[0] !== "document"
    || !Array.isArray(ids) || ids.length < 1 || ids.length > 100
    || ids.some((id) => typeof id !== "string" || !id.trim()))) {
    return "document_ids requires 1 to 100 nonblank IDs and sources=['document']";
  }
  return undefined;
}

function observedAddPayload(payload: MemoraxAddPayload): unknown {
  return { ...payload, messages: payload.messages.map((message) => ({
    ...message, content: observedMessageContent(message.content),
  })) };
}

function validateMessageAttachments(
  messages: MemoraxWritebackMessage[], options: MemoraxAddOptions, context: Record<string, unknown>,
): void {
  let files = 0;
  let textChars = 0;
  for (const message of messages) {
    if (typeof message.content === "string") {
      textChars += message.content.length;
      continue;
    }
    for (const part of message.content) {
      if (part.type === "text") textChars += part.text.length;
      if (part.type === "input_image") textChars += part.caption?.length ?? 0;
      if (part.type === "file") {
        files++;
        if (message.role !== "user" || options.contentType === "code" || context.chunk !== undefined) {
          throw new Error("file parts require user messages with dialogue/work/auto content and no code chunks");
        }
      }
      if (part.type !== "text" && options.mode !== undefined && options.mode !== "default") {
        throw new Error("attachments require default mode");
      }
    }
  }
  if (files > 10) throw new Error("writeback supports at most 10 files");
  if (options.contentType === "auto" && textChars > 128_000) {
    throw new Error("auto writeback exceeds the 128000 character budget");
  }
}

export async function callMemoSearch(
  config: MemoraxAdapterConfig,
  payload: MemoraxSearchPayload,
  fetchImpl: typeof fetch = fetch,
): Promise<MemoraxJsonResponse> {
  return postMemoraxJson(config, "/v1/memories/search", payload, fetchImpl);
}

export async function callMemoAdd(
  config: MemoraxAdapterConfig,
  payload: MemoraxAddPayload,
  fetchImpl: typeof fetch = fetch,
): Promise<MemoraxJsonResponse> {
  return postMemoraxJson(config, "/v1/memories/add", payload, fetchImpl);
}

function recordMemoryObservabilityEvent(
  options: MemoraxAdapterOptions,
  event: Omit<MemoryObservabilityEvent, "source">,
): void {
  const observability = options.observability;
  if (!observability?.recordEvent) return;
  const source = options.observabilitySource ?? "unknown";
  const request = options.writebackAttempt && isRecord(event.request)
    ? {
        ...event.request,
        attempt: options.writebackAttempt.attempt,
        maxAttempts: options.writebackAttempt.maxAttempts,
      }
    : event.request;
  try {
    observability.recordEvent({
      source,
      ...(options.traceContext ? { traceContext: options.traceContext } : {}),
      ...(options.relatedTurns?.length ? { relatedTurns: options.relatedTurns } : {}),
      ...event,
      ...(request === undefined ? {} : { request }),
    });
  } catch (error) {
    options.diagnosticLogger?.("memory_observability.record_failed", {
      source,
      operation: event.operation,
      ok: event.ok,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function extractMemoraxSearchItems(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (!isRecord(raw)) return [];
  const data = raw.data;
  if (Array.isArray(data)) return data;
  if (isRecord(data) && Array.isArray(data.data)) return data.data;
  return [];
}

function extractMemoraxBuckets(raw: unknown): unknown {
  if (!isRecord(raw) || !isRecord(raw.data)) return null;
  return raw.data.buckets ?? null;
}

async function invokeMemoraxWriteback(
  run: MemoraxRunContext,
  request: MemoraxSlotInvocationRequest,
  config: MemoraxAdapterConfig,
  repositoryScope: RepositoryMemoryScope,
  options: MemoraxAdapterOptions,
): Promise<MemoraxInvocationResult> {
  const env = options.env ?? process.env;
  const context = isRecord(request.context) ? request.context : {};
  const addOptions = memoraxAddOptionsFromContext(context, env);
  if (!addOptions.ok) return { ok: false, error: addOptions.error };
  let messages: MemoraxWritebackMessage[];
  try {
    messages = writebackMessagesFromContext(context, request.content, addOptions.options);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Invalid writeback messages" };
  }
  if (messages.length === 0) return { ok: false, error: "writeback messages are required" };
  const idempotencyKey = writebackIdempotencyKeyFromContext(context);
  if (!idempotencyKey) return { ok: false, error: "writeback idempotency key is required" };
  const payload = buildMemoraxAddPayload(config, run, messages, context, idempotencyKey, repositoryScope, addOptions.options);
  try {
    const { body: raw, quota } = await callMemoAdd(config, payload, options.fetchImpl);
    recordMemoryObservabilityEvent(options, {
      operation: "writeback",
      ok: true,
      request: {
        slot: request.slot || "state_context",
        payload: observedAddPayload(payload),
      },
      response: {
        receiptId: memoraxReceiptId(raw),
        raw,
      },
    });
    return {
      ok: true,
      result: {
        schema_version: SLOT_RESULT_SCHEMA_VERSION,
        provider_family: "memory",
        provider_id: MEMORAX_PROVIDER_ID,
        slot: request.slot || "state_context",
        operation: "writeback",
        prompt_fragments: [],
        ...(quota ? { quota } : {}),
        tool_result_payload: {
          accepted: true,
          receiptId: memoraxReceiptId(raw),
          raw,
        },
        dispatch_receipt: {
          accepted: true,
          receipt_id: memoraxReceiptId(raw),
          summary: `memorax writeback accepted ${messages.length} message(s)`,
        },
      },
    };
  } catch (error) {
    const failure = memoraxInvocationFailure(error);
    recordMemoryObservabilityEvent(options, {
      operation: "writeback",
      ok: false,
      request: {
        slot: request.slot || "state_context",
        payload: observedAddPayload(payload),
      },
      error: failure.error,
    });
    return failure;
  }
}

function buildMemoraxAddPayload(
  config: MemoraxAdapterConfig,
  run: MemoraxRunContext,
  messages: MemoraxWritebackMessage[],
  context: Record<string, unknown>,
  idempotencyKey: string,
  repositoryScope: RepositoryMemoryScope,
  options: MemoraxAddOptions = {},
): MemoraxAddPayload {
  const now = Date.now();
  const extraMetadata = writebackMetadataFromContext(context);
  const chunk = options.contentType === "code" && options.mode === "default"
    ? writebackChunkFromContext(context)
    : undefined;
  // Preserve caller times exactly, including equal fragment timestamps and
  // out-of-order arrival. Array order and chunk indexes already express order.
  const stamped = messages.map((message, index) => ({
    role: message.role,
    content: message.content,
    timestamp: parseNativeMessageTimestamp(message.timestamp) ?? now + index,
  }));
  const scopeKind = repositoryMemoryScopeKind(repositoryScope);
  return {
    messages: stamped,
    user_id: repositoryScope.effectiveUserId,
    memory_output_language: config.memoryOutputLanguage ?? MEMORAX_DEFAULT_MEMORY_OUTPUT_LANGUAGE,
    ...(options.mode ? { mode: options.mode } : {}),
    ...(options.contentType ? { content_type: options.contentType } : {}),
    ...(chunk ? { chunk } : {}),
    session_id: memoraxSessionIdForRun(run),
    // Acceptance acknowledges task submission, not completed memory extraction.
    async_mode: true,
    timestamp: stamped[0]?.timestamp ?? now,
    metadata: {
      source: "memorax-code",
      tags: ["memorax-code"],
      ...extraMetadata,
      ...(messages.some((message) => message.timestampSource) ? {
        memorax_code_timestamp_sources: messages.map((message) => message.timestampSource ?? "unspecified"),
      } : {}),
      memorax_code_memory_scope: memoraxScopeVersion(scopeKind),
      memorax_code_base_user_id: repositoryScope.baseUserId,
      memorax_code_workspace: repositoryScope.repositorySlug,
      idempotency_key: idempotencyKey,
      memorax_code_session_id: run.sessionId,
      ...(run.branchId ? { memorax_code_branch_id: run.branchId } : {}),
    },
  };
}

function memoraxScopeVersion(scopeKind: ReturnType<typeof repositoryMemoryScopeKind>): string {
  if (scopeKind === "git-repository") return "repository-name.v1";
  if (scopeKind === "general") return "general.v1";
  return "workspace-name.v1";
}

function writebackChunkFromContext(context: Record<string, unknown>): MemoraxAddPayload["chunk"] {
  if (!isRecord(context.chunk)) return undefined;
  const groupId = typeof context.chunk.group_id === "string" ? context.chunk.group_id.trim() : "";
  const index = context.chunk.index;
  const count = context.chunk.count;
  if (!groupId || !Number.isInteger(index) || !Number.isInteger(count)) return undefined;
  if (Number(index) < 0 || Number(count) < 2 || Number(index) >= Number(count)) return undefined;
  return { group_id: groupId, index: Number(index), count: Number(count) };
}

function writebackIdempotencyKeyFromContext(context: Record<string, unknown>): string | undefined {
  return typeof context.idempotencyKey === "string" && context.idempotencyKey.trim()
    ? context.idempotencyKey.trim()
    : undefined;
}

function writebackMetadataFromContext(context: Record<string, unknown>): Record<string, string | number | boolean> {
  if (!isRecord(context.metadata)) return {};
  const metadata: Record<string, string | number | boolean> = {};
  for (const key of FORWARDED_WRITEBACK_METADATA_KEYS) {
    const value = context.metadata[key];
    if (typeof value === "string" && value.trim()) metadata[key] = value.trim().slice(0, 2000);
    else if (typeof value === "number" && Number.isFinite(value)) metadata[key] = value;
    else if (typeof value === "boolean") metadata[key] = value;
  }
  return metadata;
}

function repositoryScopeForConfig(
  config: MemoraxAdapterConfig,
  scope: RepositoryMemoryScope | undefined,
): { ok: true; scope: RepositoryMemoryScope } | { ok: false; error: string } {
  if (!scope) return { ok: false, error: "memory scope is required for MemoraX search/add" };
  if (scope.baseUserId !== config.userId) {
    return { ok: false, error: "memory scope base user id does not match MemoraX config" };
  }
  if (!scope.effectiveUserId.trim() || !scope.repositorySlug.trim()) {
    return { ok: false, error: "memory scope is invalid" };
  }
  return { ok: true, scope };
}

function writebackMessagesFromContext(
  context: Record<string, unknown>,
  fallbackContent: unknown,
  options: MemoraxAddOptions,
): MemoraxWritebackMessage[] {
  const preserveWhitespace = options.contentType === "code" && options.mode === "default"
    && writebackChunkFromContext(context) !== undefined;
  if (context.messages !== undefined && !Array.isArray(context.messages)) {
    throw new Error("writeback messages must be an array");
  }
  const rawMessages = Array.isArray(context.messages) ? context.messages : [];
  if (rawMessages.length > 100) throw new Error("writeback supports at most 100 messages");
  const messages = rawMessages.map((message) => normalizeWritebackMessage(message, preserveWhitespace));
  if (messages.some((message) => !message)) {
    // An invalid member must never be silently dropped from a submitted turn.
    throw new Error("writeback messages are required");
  }
  let normalized = messages as MemoraxWritebackMessage[];
  if (context.messages === undefined) {
    const content = typeof fallbackContent === "string" ? fallbackContent.trim() : "";
    normalized = content ? [{ role: "assistant", content }] : [];
  }
  validateMessageAttachments(normalized, options, context);
  return normalized;
}

function normalizeWritebackMessage(value: unknown, preserveWhitespace: boolean): MemoraxWritebackMessage | undefined {
  if (!isRecord(value)) return undefined;
  const role = value.role === "user" || value.role === "assistant" ? value.role : undefined;
  const rawContent = typeof value.content === "string" ? value.content : "";
  // Complete messages were normalized before chunking. A fragment's boundary
  // whitespace, including a whitespace-only fragment, belongs to that message.
  const content = Array.isArray(value.content) ? normalizeContentParts(value.content) : (preserveWhitespace ? rawContent : rawContent.trim());
  if (!role || !content) return undefined;
  const timestamp = typeof value.timestamp === "number" ? parseNativeMessageTimestamp(value.timestamp) : undefined;
  const timestampSource = value.timestampSource === "native" || value.timestampSource === "observed"
    ? (timestamp === undefined ? "observed" : value.timestampSource)
    : undefined;
  return {
    role, content,
    ...(timestamp === undefined ? {} : { timestamp }),
    ...(timestampSource === undefined ? {} : { timestampSource }),
  };
}

function renderMemoraxContextBlocks(items: unknown[], config: MemoraxAdapterConfig): MemoraxContextBlock[] {
  if (items.some((item) => isRecord(item) && item.content_type === "document")) {
    return renderDocumentContext(items, config);
  }
  const renderedItems = items
    .map((item) => ({ item, line: formatMemoryItemLine(item, config.maxItemChars), memoryType: memoryTypeForItem(item) }))
    .filter((item) => item.line);
  if (renderedItems.length === 0) return [];

  const lines = ["<memories>"];
  if (config.renderByMemoryType) {
    const buckets = new Map<string, string[]>();
    for (const type of config.memoryTypeOrder) buckets.set(type, []);
    for (const rendered of renderedItems) {
      if (!buckets.has(rendered.memoryType)) buckets.set(rendered.memoryType, []);
      buckets.get(rendered.memoryType)?.push(rendered.line);
    }
    for (const [type, typeLines] of buckets.entries()) {
      if (typeLines.length === 0) continue;
      lines.push(`  <facts memory_type="${escapeAttribute(type)}">`);
      lines.push(...typeLines);
      lines.push("  </facts>");
    }
  } else {
    lines.push("  <facts>");
    lines.push(...renderedItems.map((item) => item.line));
    lines.push("  </facts>");
  }
  lines.push("</memories>");
  const content = truncate(lines.join("\n"), config.maxContextChars);
  return [{ type: "memory_context", source: "memorax", content, itemCount: renderedItems.length }];
}

function renderDocumentContext(items: unknown[], config: MemoraxAdapterConfig): MemoraxContextBlock[] {
  const opening = "<memories>\n";
  const closing = "</memories>";
  const notice = "<notice>Evidence truncated by context budget; use --json for complete returned chunks.</notice>\n";
  const fragments: string[] = [];
  let length = opening.length + closing.length;
  let omitted = false;
  for (const item of items) {
    if (!isRecord(item)) continue;
    const text = memoryTextForItem(item);
    if (!text) continue;
    let rendered: string;
    if (item.content_type === "document") {
      const metadata = isRecord(item.metadata) ? item.metadata : {};
      const attrs: string[] = [];
      for (const [key, value] of Object.entries({ chunk_id: item.id, document_id: metadata.document_id,
        input_id: metadata.input_id, chunk_index: metadata.chunk_index })) {
        if (typeof value === "string" || typeof value === "number") attrs.push(`${key}="${escapeAttribute(String(value))}"`);
      }
      const heading = Array.isArray(metadata.heading_path) ? metadata.heading_path.filter((part) => typeof part === "string").join(" / ") : "";
      if (heading) attrs.push(`heading="${escapeAttribute(heading)}"`);
      if (Array.isArray(metadata.source_spans)) attrs.push(`source_spans="${escapeAttribute(JSON.stringify(metadata.source_spans))}"`);
      rendered = `<chunk ${attrs.join(" ")}>\n${escapeText(text)}\n</chunk>\n`;
    } else {
      rendered = `${formatMemoryItemLine(item, config.maxItemChars)}\n`;
    }
    // Reserve the complete notice and closing tag; never cut source evidence or
    // escaped markup halfway through a table, code block, or XML entity.
    if (length + rendered.length + notice.length > config.maxContextChars) {
      omitted = true;
      break;
    }
    fragments.push(rendered);
    length += rendered.length;
  }
  const content = opening + fragments.join("") + (omitted ? notice : "") + closing;
  return [{ type: "memory_context", source: "memorax", content, itemCount: fragments.length }];
}

function memoraxReceiptId(raw: unknown): string {
  if (isRecord(raw)) {
    const meta = isRecord(raw.meta) ? raw.meta : undefined;
    const data = isRecord(raw.data) ? raw.data : undefined;
    const id = meta?.request_id ?? data?.task_id;
    if (typeof id === "string" && id.trim()) return `memorax:${id.trim()}`;
  }
  return `memorax:${Date.now()}`;
}

function formatMemoryItemLine(item: unknown, maxItemChars: number): string {
  const text = sanitizeInline(memoryTextForItem(item));
  if (!text) return "";
  const time = memoryTimeForItem(item);
  const prefix = time ? `   -[${time}] ` : "   - ";
  return `${prefix}${escapeText(truncate(text, maxItemChars))}`;
}

function memoryTextForItem(item: unknown): string {
  if (!isRecord(item)) return "";
  for (const key of ["memory", "summary", "content", "text"]) {
    const value = item[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

function memoryTypeForItem(item: unknown): string {
  if (!isRecord(item) || !isRecord(item.metadata)) return "unclassified";
  const type = item.metadata.memory_type;
  return typeof type === "string" && type.trim() ? type.trim().toLowerCase() : "unclassified";
}

function memoryTimeForItem(item: unknown): string {
  if (!isRecord(item)) return "";
  return formatTime(item.updated_at ?? item.created_at);
}

function formatTime(value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  const date = new Date(typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value) : String(value));
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function sanitizeInline(value: string): string {
  return value.replace(/\r?\n+/g, " ").replace(/\s{2,}/g, " ").trim();
}

function truncate(text: string, maxChars: number): string {
  if (!Number.isFinite(maxChars) || maxChars <= 0 || text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}...`;
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
