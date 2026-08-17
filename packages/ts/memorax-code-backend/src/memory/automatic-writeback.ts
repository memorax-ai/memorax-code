import { createHash } from "node:crypto";
import {
  createMemoryWritebackBufferRuntime,
  type MemoryWritebackBufferedDecision,
  type MemoryWritebackBufferedOptions,
  type MemoryWritebackBufferRuntime,
} from "./writeback-buffer.js";
import {
  memoryWritebackAddParts,
  type WritebackMessage,
} from "./writeback-chunk.js";
import {
  invokeMemoraxMemoryProvider,
  type MemoraxInvocationFailure,
} from "../provider/memorax/adapter.js";
import type {
  MemoryDiagnosticLogger,
  MemoryObservabilityHook,
  MemoryObservabilityRelatedTurn,
  MemoryObservabilitySource,
} from "./observability.js";
import {
  memoryWritebackBufferEnabled,
  memoryWritebackEnabled,
  memoryWritebackMaxMessageChars,
} from "../provider/memorax/config.js";
import type { RepositoryMemorySessionScopeUpgrade } from "./repository-session.js";
import type {
  RepositoryMemoryScope,
  RepositoryMemoryScopeFailureReason,
} from "../repository/scope.js";
import type { TraceContext } from "../trace/context.js";
import {
  hasMeaningfulMemoryPayloadText,
  redactMemoryPayloadText,
  type MemoryPayloadRedactionKind,
} from "./payload-redaction.js";

export type AutomaticMemoryWritebackClient = "codex" | "claude-code" | "opencode" | "dsh";

export type AutomaticMemoryWritebackOptions = {
  client: AutomaticMemoryWritebackClient;
  sessionKey?: string;
  userText?: string;
  assistantText?: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  memoryObservability?: MemoryObservabilityHook;
  memoryObservabilitySource?: MemoryObservabilitySource;
  relatedTurns?: MemoryObservabilityRelatedTurn[];
  repositoryScope?: RepositoryMemoryScope;
  repositoryScopeError?: string;
  repositoryScopeReason?: "config_missing" | RepositoryMemoryScopeFailureReason;
  traceContext?: TraceContext;
};

type AutomaticMemoryWritebackDecision = {
  client: AutomaticMemoryWritebackClient;
  sessionKey: string;
  idempotencyKey: string;
  messages: WritebackMessage[];
};

export type AutomaticMemoryWritebackRejectionReason =
  | "runtime_closed"
  | "disabled"
  | "session_missing"
  | "workspace_scope_missing"
  | "user_prompt_empty"
  | "assistant_text_empty"
  | "decision_error"
  | "config_missing"
  | RepositoryMemoryScopeFailureReason;

export type AutomaticMemoryWritebackEnqueueResult =
  | { accepted: true }
  | { accepted: false; reason: AutomaticMemoryWritebackRejectionReason };

export type AutomaticMemoryWritebackEnqueue = (
  options: AutomaticMemoryWritebackOptions,
) => AutomaticMemoryWritebackEnqueueResult;

export type AutomaticMemoryWritebackRuntime = {
  enqueue: AutomaticMemoryWritebackEnqueue;
  discardForScopeUpgrade(upgrade: RepositoryMemorySessionScopeUpgrade): number;
  drain(): Promise<void>;
  close(): void;
};

export type AutomaticMemoryWritebackRuntimeOptions = {
  diagnosticLogger?: MemoryDiagnosticLogger;
};

type AutomaticMemoryWritebackState = {
  diagnosticLogger: MemoryDiagnosticLogger;
  pendingWritebacks: Map<string, number>;
  writebackBuffer: MemoryWritebackBufferRuntime;
  accepting: boolean;
  inFlight: Set<Promise<void>>;
  drainPromise?: Promise<void>;
};

const WRITEBACK_DEDUPE_TTL_MS = 5 * 60 * 1000;
const WRITEBACK_DEDUPE_MAX = 1024;
const AUTOMATIC_MEMORY_WRITEBACK_MAX_ATTEMPTS = 2;
const AUTOMATIC_MEMORY_WRITEBACK_RETRY_DELAY_MS = 100;
const AUTOMATIC_MEMORY_WRITEBACK_MAX_RETRY_DELAY_MS = 5_000;

export function createAutomaticMemoryWritebackRuntime(
  options: AutomaticMemoryWritebackRuntimeOptions = {},
): AutomaticMemoryWritebackRuntime {
  const state: AutomaticMemoryWritebackState = {
    diagnosticLogger: options.diagnosticLogger ?? (() => {}),
    pendingWritebacks: new Map(),
    writebackBuffer: createMemoryWritebackBufferRuntime(),
    accepting: true,
    inFlight: new Set(),
  };
  return {
    enqueue(options) {
      return enqueueAutomaticMemoryWritebackForRuntime(state, options);
    },
    discardForScopeUpgrade(upgrade) {
      return state.writebackBuffer.discardForScopeUpgrade({
        client: upgrade.client,
        sessionKey: upgrade.sessionId,
        currentScope: upgrade.currentScope,
      });
    },
    drain() {
      if (state.drainPromise) return state.drainPromise;
      state.accepting = false;
      state.writebackBuffer.flushAll("shutdown");
      state.drainPromise = Promise.allSettled([...state.inFlight]).then(() => undefined);
      return state.drainPromise;
    },
    close() {
      state.accepting = false;
      state.writebackBuffer.close();
      state.pendingWritebacks.clear();
    },
  };
}

function enqueueAutomaticMemoryWritebackForRuntime(
  state: AutomaticMemoryWritebackState,
  options: AutomaticMemoryWritebackOptions,
): AutomaticMemoryWritebackEnqueueResult {
  if (!state.accepting) {
    state.diagnosticLogger("memory.automatic_writeback", {
      scheduled: false,
      skipReason: "runtime_closed",
      sessionKeyHash: hashOptionalText(options.sessionKey),
    });
    return { accepted: false, reason: "runtime_closed" };
  }
  try {
    const decision = automaticMemoryWritebackDecision(state, options);
    if (!decision.write) {
      state.diagnosticLogger("memory.automatic_writeback", {
        scheduled: false,
        skipReason: decision.skipReason,
        sessionKeyHash: hashOptionalText(options.sessionKey),
      });
      return decision.skipReason === "duplicate_pending"
        ? { accepted: true }
        : { accepted: false, reason: decision.skipReason };
    }
    if (memoryWritebackBufferEnabled(options.env ?? process.env)) {
      state.writebackBuffer.enqueue(decision, options, {
        debug: redactAutomaticMemoryWritebackDiagnosticIdentifiers(state.diagnosticLogger),
        flush: (bufferedDecision, bufferedOptions) => flushAutomaticMemoryWritebackBuffer(
          state,
          bufferedDecision,
          bufferedOptions,
        ),
        hasPendingWriteback: (idempotencyKey) => hasPendingWriteback(state, idempotencyKey),
        reservePendingWritebacks: (idempotencyKeys) => reservePendingWritebacks(state, idempotencyKeys),
        hashText,
      });
      return { accepted: true };
    }
    reservePendingWriteback(state, decision.idempotencyKey);
    state.diagnosticLogger("memory.automatic_writeback", {
      scheduled: true,
      sessionKeyHash: hashText(decision.sessionKey),
      idempotencyKeyHash: hashText(decision.idempotencyKey),
      messageCount: decision.messages.length,
      userChars: decision.messages[0]?.content.length ?? 0,
      assistantChars: decision.messages[1]?.content.length ?? 0,
    });
    trackAutomaticMemoryWriteback(
      state,
      enqueueAutomaticMemoryWritebackAsync(state, decision, options),
    );
    return { accepted: true };
  } catch (error) {
    state.diagnosticLogger("memory.automatic_writeback", {
      scheduled: false,
      skipReason: "decision_error",
      sessionKeyHash: hashOptionalText(options.sessionKey),
      error: error instanceof Error ? error.message : String(error),
    });
    return { accepted: false, reason: "decision_error" };
  }
}

function redactAutomaticMemoryWritebackDiagnosticIdentifiers(
  diagnosticLogger: MemoryDiagnosticLogger,
): MemoryDiagnosticLogger {
  return (message, fields = {}) => {
    const { sessionKey, idempotencyKey, parentIdempotencyKey, ...rest } = fields;
    diagnosticLogger(message, {
      ...rest,
      ...(typeof sessionKey === "string" ? { sessionKeyHash: hashText(sessionKey) } : {}),
      ...(typeof idempotencyKey === "string" ? { idempotencyKeyHash: hashText(idempotencyKey) } : {}),
      ...(typeof parentIdempotencyKey === "string" ? { parentIdempotencyKeyHash: hashText(parentIdempotencyKey) } : {}),
    });
  };
}

function automaticMemoryWritebackDecision(
  state: AutomaticMemoryWritebackState,
  options: AutomaticMemoryWritebackOptions,
): (
  | ({ write: true } & AutomaticMemoryWritebackDecision)
  | {
    write: false;
    skipReason: AutomaticMemoryWritebackRejectionReason | "duplicate_pending";
  }
) {
  const env = options.env ?? process.env;
  if (!memoryWritebackEnabled(env)) return { write: false, skipReason: "disabled" };
  if (!options.sessionKey?.trim()) return { write: false, skipReason: "session_missing" };
  if (!options.repositoryScope) {
    return {
      write: false,
      skipReason: options.repositoryScopeReason
        ?? (options.repositoryScopeError ? "workspace_scope_unavailable" : "workspace_scope_missing"),
    };
  }

  const sessionKey = options.sessionKey.trim();
  const maxMessageChars = memoryWritebackMaxMessageChars(env);
  const rawUserText = options.userText?.trim() ?? "";
  const rawAssistantText = options.assistantText?.trim() ?? "";
  if (!rawUserText) return { write: false, skipReason: "user_prompt_empty" };
  if (!rawAssistantText) return { write: false, skipReason: "assistant_text_empty" };
  const boundedUserText = limitMessageContent(rawUserText, maxMessageChars, {
    role: "user",
    sessionKey,
  }, state.diagnosticLogger);
  const boundedAssistantText = limitMessageContent(rawAssistantText, maxMessageChars, {
    role: "assistant",
    sessionKey,
  }, state.diagnosticLogger);
  const userRedaction = redactMemoryPayloadText(boundedUserText);
  const assistantRedaction = redactMemoryPayloadText(boundedAssistantText);
  logAutomaticMemoryPayloadRedaction(state, sessionKey, "user", rawUserText, userRedaction);
  logAutomaticMemoryPayloadRedaction(state, sessionKey, "assistant", rawAssistantText, assistantRedaction);
  const userText = limitMessageContent(userRedaction.text, maxMessageChars, {
    role: "user",
    sessionKey,
  }, state.diagnosticLogger);
  const assistantText = limitMessageContent(assistantRedaction.text, maxMessageChars, {
    role: "assistant",
    sessionKey,
  }, state.diagnosticLogger);
  if (!hasMeaningfulMemoryPayloadText(userText)) return { write: false, skipReason: "user_prompt_empty" };
  if (!hasMeaningfulMemoryPayloadText(assistantText)) return { write: false, skipReason: "assistant_text_empty" };

  const idempotencyKey = `automatic:${options.client}:${hashText(options.repositoryScope.effectiveUserId)}:${sessionKey}:${hashText(userText)}:${hashText(assistantText)}`;
  if (hasPendingWriteback(state, idempotencyKey)) return { write: false, skipReason: "duplicate_pending" };
  return {
    write: true,
    client: options.client,
    sessionKey,
    idempotencyKey,
    messages: [
      { role: "user", content: userText },
      { role: "assistant", content: assistantText },
    ],
  };
}

function logAutomaticMemoryPayloadRedaction(
  state: AutomaticMemoryWritebackState,
  sessionKey: string,
  role: WritebackMessage["role"],
  originalText: string,
  result: { text: string; redacted: boolean; counts: Readonly<Partial<Record<MemoryPayloadRedactionKind, number>>> },
): void {
  if (!result.redacted) return;
  state.diagnosticLogger("memory.automatic_writeback.redacted", {
    sessionKeyHash: hashText(sessionKey),
    role,
    originalChars: originalText.length,
    redactedChars: result.text.length,
    counts: result.counts,
  });
}

async function enqueueAutomaticMemoryWritebackAsync(
  state: AutomaticMemoryWritebackState,
  decision: AutomaticMemoryWritebackDecision & { dedupeKeys?: string[]; flushReason?: string; turnCount?: number },
  options: AutomaticMemoryWritebackOptions,
): Promise<void> {
  try {
    if (decision.messages.some((message) => redactMemoryPayloadText(message.content).redacted)) {
      state.diagnosticLogger("memory.writeback.redaction_rejected", {
        source: options.memoryObservabilitySource ?? "automatic_writeback",
        messageCount: decision.messages.length,
      });
      throw new Error("automatic writeback content must be redacted before provider dispatch");
    }
    const parts = memoryWritebackAddParts(decision, options.env ?? process.env);
    for (const [index, part] of parts.entries()) {
      for (let attempt = 1; attempt <= AUTOMATIC_MEMORY_WRITEBACK_MAX_ATTEMPTS; attempt += 1) {
        const response = await invokeMemoraxMemoryProvider({
          sessionId: decision.sessionKey,
          prompt: part.messages.find((message) => message.role === "user")?.content ?? "",
        }, {
          provider_family: "memory",
          provider_id: "memory.memorax",
          transport: "external_http",
          slot: "state_context",
          operation: "writeback",
          dispatch: "async_best_effort",
          context: {
            idempotencyKey: part.idempotencyKey,
            messages: part.messages,
            contentType: "code",
            mode: "default",
            ...(part.chunk ? { chunk: part.chunk } : {}),
          },
        }, {
          env: options.env,
          fetchImpl: options.fetchImpl,
          observability: options.memoryObservability,
          observabilitySource: options.memoryObservabilitySource ?? "automatic_writeback",
          relatedTurns: options.relatedTurns,
          repositoryScope: options.repositoryScope,
          traceContext: options.traceContext,
          diagnosticLogger: state.diagnosticLogger,
          writebackAttempt: {
            attempt,
            maxAttempts: AUTOMATIC_MEMORY_WRITEBACK_MAX_ATTEMPTS,
          },
        });
        const retryDelayMs = !response.ok && attempt < AUTOMATIC_MEMORY_WRITEBACK_MAX_ATTEMPTS
          ? automaticMemoryWritebackRetryDelayMs(response, attempt)
          : undefined;
        const retrying = retryDelayMs !== undefined;
        state.diagnosticLogger("memory.automatic_writeback", {
          scheduled: true,
          accepted: response.ok,
          sessionKeyHash: hashText(decision.sessionKey),
          idempotencyKeyHash: hashText(part.idempotencyKey),
          parentIdempotencyKeyHash: part.idempotencyKey === decision.idempotencyKey ? undefined : hashText(decision.idempotencyKey),
          flushReason: decision.flushReason,
          turnCount: decision.turnCount,
          partIndex: parts.length > 1 ? index : undefined,
          partCount: parts.length > 1 ? parts.length : undefined,
          attempt,
          maxAttempts: AUTOMATIC_MEMORY_WRITEBACK_MAX_ATTEMPTS,
          retrying,
          retryDelayMs,
          dispatchReceipt: response.ok ? response.result.dispatch_receipt ?? null : undefined,
          error: response.ok ? undefined : response.error,
          errorKind: response.ok ? undefined : response.errorKind,
          httpStatus: response.ok ? undefined : response.httpStatus,
        });
        if (response.ok) break;
        if (!retrying) {
          releasePendingWritebacks(state, [decision.idempotencyKey, ...(decision.dedupeKeys ?? [])]);
          return;
        }
        await delayAutomaticMemoryWritebackRetry(retryDelayMs);
      }
    }
  } catch (error) {
    releasePendingWritebacks(state, [decision.idempotencyKey, ...(decision.dedupeKeys ?? [])]);
    state.diagnosticLogger("memory.automatic_writeback", {
      scheduled: true,
      accepted: false,
      sessionKeyHash: hashText(decision.sessionKey),
      idempotencyKeyHash: hashText(decision.idempotencyKey),
      flushReason: decision.flushReason,
      turnCount: decision.turnCount,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function flushAutomaticMemoryWritebackBuffer(
  state: AutomaticMemoryWritebackState,
  decision: MemoryWritebackBufferedDecision,
  options: MemoryWritebackBufferedOptions,
): void {
  trackAutomaticMemoryWriteback(
    state,
    enqueueAutomaticMemoryWritebackAsync(state, decision, {
      client: decision.client,
      sessionKey: options.sessionKey,
      env: options.env,
      fetchImpl: options.fetchImpl,
      memoryObservability: options.memoryObservability,
      memoryObservabilitySource: options.memoryObservabilitySource,
      relatedTurns: options.relatedTurns,
      repositoryScope: options.repositoryScope,
      traceContext: options.traceContext,
    }),
  );
}

function trackAutomaticMemoryWriteback(
  state: AutomaticMemoryWritebackState,
  writeback: Promise<void>,
): void {
  state.inFlight.add(writeback);
  void writeback.then(
    () => state.inFlight.delete(writeback),
    () => state.inFlight.delete(writeback),
  );
}

function hasPendingWriteback(state: AutomaticMemoryWritebackState, idempotencyKey: string): boolean {
  prunePendingWritebacks(state);
  return state.pendingWritebacks.has(idempotencyKey);
}

function reservePendingWriteback(state: AutomaticMemoryWritebackState, idempotencyKey: string): void {
  reservePendingWritebacks(state, [idempotencyKey]);
}

function reservePendingWritebacks(state: AutomaticMemoryWritebackState, idempotencyKeys: string[]): void {
  prunePendingWritebacks(state);
  const expiresAt = Date.now() + WRITEBACK_DEDUPE_TTL_MS;
  for (const idempotencyKey of idempotencyKeys) {
    state.pendingWritebacks.set(idempotencyKey, expiresAt);
  }
  while (state.pendingWritebacks.size > WRITEBACK_DEDUPE_MAX) {
    const oldest = state.pendingWritebacks.keys().next().value;
    if (typeof oldest !== "string") break;
    state.pendingWritebacks.delete(oldest);
  }
}

function releasePendingWriteback(state: AutomaticMemoryWritebackState, idempotencyKey: string): void {
  state.pendingWritebacks.delete(idempotencyKey);
}

function releasePendingWritebacks(state: AutomaticMemoryWritebackState, idempotencyKeys: string[]): void {
  for (const idempotencyKey of idempotencyKeys) releasePendingWriteback(state, idempotencyKey);
}

function prunePendingWritebacks(state: AutomaticMemoryWritebackState, now = Date.now()): void {
  for (const [key, expiresAt] of state.pendingWritebacks.entries()) {
    if (expiresAt <= now) state.pendingWritebacks.delete(key);
  }
}

function limitMessageContent(
  content: string,
  maxChars: number,
  fields?: { role: WritebackMessage["role"]; sessionKey: string },
  diagnosticLogger: MemoryDiagnosticLogger = () => {},
): string {
  if (content.length <= maxChars) return content;
  const prefix = content.slice(0, maxChars);
  const kept = (/\S$/.test(prefix) && /^\S/.test(content.slice(maxChars)))
    ? prefix.replace(/\S+$/, "").trim()
    : prefix.trim();
  diagnosticLogger("memory.automatic_writeback.truncated", {
    sessionKeyHash: hashOptionalText(fields?.sessionKey),
    role: fields?.role,
    originalChars: content.length,
    keptChars: kept.length,
    maxChars,
  });
  return kept;
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function hashOptionalText(text: string | undefined): string | undefined {
  return text?.trim() ? hashText(text.trim()) : undefined;
}

function automaticMemoryWritebackRetryDelayMs(
  failure: MemoraxInvocationFailure,
  attempt: number,
): number | undefined {
  if (!isRetryableAutomaticMemoryWritebackFailure(failure)) return undefined;
  const requestedDelayMs = failure.retryAfterMs ?? AUTOMATIC_MEMORY_WRITEBACK_RETRY_DELAY_MS * attempt;
  return Math.min(
    AUTOMATIC_MEMORY_WRITEBACK_MAX_RETRY_DELAY_MS,
    Math.max(0, requestedDelayMs),
  );
}

function isRetryableAutomaticMemoryWritebackFailure(failure: MemoraxInvocationFailure): boolean {
  if (failure.errorKind === "timeout" || failure.errorKind === "transport") return true;
  if (failure.errorKind !== "http" || failure.httpStatus === undefined) return false;
  return failure.httpStatus === 408
    || failure.httpStatus === 429
    || failure.httpStatus >= 500;
}

async function delayAutomaticMemoryWritebackRetry(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}
