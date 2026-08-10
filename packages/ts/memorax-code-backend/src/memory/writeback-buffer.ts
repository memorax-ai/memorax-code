import { writebackMessagesContentChars, type WritebackMessage } from "./writeback-chunk.js";
import type {
  MemoryObservabilityHook,
  MemoryObservabilityRelatedTurn,
  MemoryObservabilitySource,
} from "./observability.js";
import { memoryWritebackBufferConfig } from "../provider/memorax/config.js";
import {
  repositoryMemoryScopeCanUpgradeFromDegradedGit,
  type RepositoryMemoryScope,
} from "../repository/scope.js";
import type { TraceContext } from "../trace/context.js";

export type MemoryWritebackBufferDecision = {
  client: "codex" | "claude-code";
  sessionKey: string;
  idempotencyKey: string;
  messages: WritebackMessage[];
};

export type MemoryWritebackBufferScopeUpgrade = Readonly<{
  client: MemoryWritebackBufferDecision["client"];
  sessionKey: string;
  currentScope: RepositoryMemoryScope;
}>;

export type MemoryWritebackBufferedDecision = MemoryWritebackBufferDecision & {
  dedupeKeys: string[];
  flushReason: string;
  turnCount: number;
};

export type MemoryWritebackBufferOptions = {
  sessionKey?: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  memoryObservability?: MemoryObservabilityHook;
  memoryObservabilitySource?: MemoryObservabilitySource;
  repositoryScope?: RepositoryMemoryScope;
  traceContext?: TraceContext;
};

export type MemoryWritebackBufferedOptions = {
  sessionKey: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  memoryObservability?: MemoryObservabilityHook;
  memoryObservabilitySource?: MemoryObservabilitySource;
  repositoryScope: RepositoryMemoryScope;
  relatedTurns?: MemoryObservabilityRelatedTurn[];
  traceContext?: TraceContext;
};

type MemoryWritebackBufferClock = {
  now: () => number;
  setTimeout: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (timer: ReturnType<typeof setTimeout>) => void;
};

export type MemoryWritebackBufferDeps = {
  debug: (message: string, fields?: Record<string, unknown>) => void;
  flush: (decision: MemoryWritebackBufferedDecision, options: MemoryWritebackBufferedOptions) => void;
  hasPendingWriteback: (idempotencyKey: string) => boolean;
  reservePendingWritebacks: (idempotencyKeys: string[]) => void;
  hashText: (text: string) => string;
  clock?: MemoryWritebackBufferClock;
};

export type MemoryWritebackBufferRuntime = {
  enqueue(
    decision: MemoryWritebackBufferDecision,
    options: MemoryWritebackBufferOptions,
    deps: MemoryWritebackBufferDeps,
  ): void;
  discardForScopeUpgrade(upgrade: MemoryWritebackBufferScopeUpgrade): number;
  flushAll(flushReason: string): number;
  close(): void;
};

type MemoryWritebackBufferedTurn = {
  idempotencyKey: string;
  messages: WritebackMessage[];
  traceContext?: TraceContext;
};

type MemoryWritebackBuffer = {
  bufferKey: string;
  client: MemoryWritebackBufferDecision["client"];
  sessionKey: string;
  turns: MemoryWritebackBufferedTurn[];
  turnKeys: Set<string>;
  contentChars: number;
  createdAt: number;
  updatedAt: number;
  idleDeadlineAt?: number;
  timerGeneration: number;
  timer?: ReturnType<typeof setTimeout>;
  clock: MemoryWritebackBufferClock;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  memoryObservability?: MemoryObservabilityHook;
  memoryObservabilitySource?: MemoryObservabilitySource;
  repositoryScope: RepositoryMemoryScope;
  deps: MemoryWritebackBufferDeps;
};

const SYSTEM_CLOCK: MemoryWritebackBufferClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer),
};

export function createMemoryWritebackBufferRuntime(): MemoryWritebackBufferRuntime {
  const writebackBuffers = new Map<string, MemoryWritebackBuffer>();
  return {
    enqueue(decision, options, deps) {
      enqueueMemoryWritebackBufferForRuntime(writebackBuffers, decision, options, deps);
    },
    discardForScopeUpgrade(upgrade) {
      return discardDegradedGitBuffersForUpgrade(writebackBuffers, upgrade);
    },
    flushAll(flushReason) {
      let flushed = 0;
      for (const [bufferKey, buffer] of [...writebackBuffers.entries()]) {
        if (flushMemoryWritebackBuffer(
          writebackBuffers,
          bufferKey,
          flushReason,
          buffer.deps,
        )) {
          flushed += 1;
        }
      }
      return flushed;
    },
    close() {
      for (const buffer of writebackBuffers.values()) {
        if (buffer.timer) buffer.clock.clearTimeout(buffer.timer);
      }
      writebackBuffers.clear();
    },
  };
}

function enqueueMemoryWritebackBufferForRuntime(
  writebackBuffers: Map<string, MemoryWritebackBuffer>,
  decision: MemoryWritebackBufferDecision,
  options: MemoryWritebackBufferOptions,
  deps: MemoryWritebackBufferDeps,
): void {
  const env = options.env ?? process.env;
  const config = memoryWritebackBufferConfig(env);
  if (!options.repositoryScope) return;
  discardDegradedGitBuffersForUpgrade(
    writebackBuffers,
    {
      client: decision.client,
      sessionKey: decision.sessionKey,
      currentScope: options.repositoryScope,
    },
  );
  const bufferKey = memoryWritebackBufferKey(
    decision.client,
    decision.sessionKey,
    options.repositoryScope,
  );
  let buffer = writebackBuffers.get(bufferKey);
  if (buffer?.turnKeys.has(decision.idempotencyKey)) {
    deps.debug("memory.automatic_writeback", {
      scheduled: false,
      skipReason: "buffer_duplicate_turn",
      sessionKey: decision.sessionKey,
    });
    return;
  }

  const turnContentChars = writebackMessagesContentChars(decision.messages);
  if (buffer && buffer.contentChars + turnContentChars > config.maxChars) {
    flushMemoryWritebackBuffer(writebackBuffers, bufferKey, "char_limit", deps);
    buffer = undefined;
  }
  if (!buffer) {
    buffer = createMemoryWritebackBuffer(
      bufferKey,
      decision.client,
      decision.sessionKey,
      env,
      options,
      options.repositoryScope,
      deps.clock ?? SYSTEM_CLOCK,
      deps,
    );
    writebackBuffers.set(bufferKey, buffer);
  }

  buffer.turns.push({
    idempotencyKey: decision.idempotencyKey,
    messages: decision.messages,
    ...(options.traceContext ? { traceContext: options.traceContext } : {}),
  });
  buffer.turnKeys.add(decision.idempotencyKey);
  buffer.contentChars += turnContentChars;
  const clock = deps.clock ?? SYSTEM_CLOCK;
  buffer.updatedAt = clock.now();
  buffer.env = env;
  buffer.fetchImpl = options.fetchImpl;
  buffer.memoryObservability = options.memoryObservability;
  buffer.memoryObservabilitySource = options.memoryObservabilitySource;
  buffer.deps = deps;
  deps.debug("memory.automatic_writeback", {
    scheduled: false,
    buffered: true,
    sessionKey: decision.sessionKey,
    turnCount: buffer.turns.length,
    messageCount: bufferedMessages(buffer).length,
    contentChars: buffer.contentChars,
  });

  if (buffer.turns.length >= config.maxTurns) {
    flushMemoryWritebackBuffer(writebackBuffers, bufferKey, "turn_limit", deps);
  } else if (buffer.contentChars > config.maxChars) {
    flushMemoryWritebackBuffer(writebackBuffers, bufferKey, "char_limit", deps);
  } else {
    resetMemoryWritebackIdleTimer(writebackBuffers, buffer, config.maxAgeMs, deps);
  }
}

function discardDegradedGitBuffersForUpgrade(
  writebackBuffers: Map<string, MemoryWritebackBuffer>,
  upgrade: MemoryWritebackBufferScopeUpgrade,
): number {
  let discarded = 0;
  for (const [bufferKey, buffer] of writebackBuffers.entries()) {
    if (
      buffer.client !== upgrade.client
      || buffer.sessionKey !== upgrade.sessionKey
      || !repositoryMemoryScopeCanUpgradeFromDegradedGit(buffer.repositoryScope, upgrade.currentScope)
    ) continue;
    writebackBuffers.delete(bufferKey);
    if (buffer.timer) buffer.clock.clearTimeout(buffer.timer);
    buffer.deps.debug("memory.automatic_writeback", {
      scheduled: false,
      skipReason: "buffer_scope_upgraded",
      sessionKey: upgrade.sessionKey,
      discardedTurnCount: buffer.turns.length,
    });
    discarded += 1;
  }
  return discarded;
}

function createMemoryWritebackBuffer(
  bufferKey: string,
  client: MemoryWritebackBufferDecision["client"],
  sessionKey: string,
  env: Record<string, string | undefined>,
  options: MemoryWritebackBufferOptions,
  repositoryScope: RepositoryMemoryScope,
  clock: MemoryWritebackBufferClock,
  deps: MemoryWritebackBufferDeps,
): MemoryWritebackBuffer {
  const now = clock.now();
  const buffer: MemoryWritebackBuffer = {
    bufferKey,
    client,
    sessionKey,
    turns: [],
    turnKeys: new Set(),
    contentChars: 0,
    createdAt: now,
    updatedAt: now,
    timerGeneration: 0,
    clock,
    env,
    fetchImpl: options.fetchImpl,
    memoryObservability: options.memoryObservability,
    memoryObservabilitySource: options.memoryObservabilitySource,
    repositoryScope,
    deps,
  };
  return buffer;
}

function resetMemoryWritebackIdleTimer(
  writebackBuffers: Map<string, MemoryWritebackBuffer>,
  buffer: MemoryWritebackBuffer,
  maxAgeMs: number,
  deps: MemoryWritebackBufferDeps,
): void {
  if (buffer.timer) buffer.clock.clearTimeout(buffer.timer);
  const clock = deps.clock ?? SYSTEM_CLOCK;
  const generation = buffer.timerGeneration + 1;
  buffer.clock = clock;
  buffer.timerGeneration = generation;
  buffer.idleDeadlineAt = buffer.updatedAt + maxAgeMs;
  const delayMs = Math.max(0, buffer.idleDeadlineAt - clock.now());
  buffer.timer = clock.setTimeout(() => {
    const current = writebackBuffers.get(buffer.bufferKey);
    if (current !== buffer || current.timerGeneration !== generation) return;
    flushMemoryWritebackBuffer(writebackBuffers, buffer.bufferKey, "idle_limit", deps);
  }, delayMs);
  if (typeof buffer.timer.unref === "function") buffer.timer.unref();
}

function flushMemoryWritebackBuffer(
  writebackBuffers: Map<string, MemoryWritebackBuffer>,
  bufferKey: string,
  flushReason: string,
  deps: MemoryWritebackBufferDeps,
): boolean {
  const buffer = writebackBuffers.get(bufferKey);
  if (!buffer) return false;
  writebackBuffers.delete(bufferKey);
  if (buffer.timer) buffer.clock.clearTimeout(buffer.timer);
  if (buffer.turns.length === 0) return false;
  const sessionKey = buffer.sessionKey;
  const messages = bufferedMessages(buffer);
  const scopeHash = deps.hashText(buffer.repositoryScope.effectiveUserId);
  const idempotencyKey = `automatic-buffer:v1:${buffer.client}:${scopeHash}:${sessionKey}:${deps.hashText(messages.map((message) => `${message.role}:${message.content}`).join("\n"))}`;
  const dedupeKeys = [idempotencyKey, ...buffer.turns.map((turn) => turn.idempotencyKey)];
  if (dedupeKeys.some((key) => deps.hasPendingWriteback(key))) return false;
  deps.reservePendingWritebacks(dedupeKeys);
  deps.debug("memory.automatic_writeback", {
    scheduled: true,
    buffered: true,
    sessionKey,
    idempotencyKey,
    flushReason,
    turnCount: buffer.turns.length,
    messageCount: messages.length,
    contentChars: buffer.contentChars,
  });
  deps.flush({
    client: buffer.client,
    sessionKey,
    idempotencyKey,
    messages,
    dedupeKeys,
    flushReason,
    turnCount: buffer.turns.length,
  }, {
    sessionKey,
    env: buffer.env,
    fetchImpl: buffer.fetchImpl,
    memoryObservability: buffer.memoryObservability,
    memoryObservabilitySource: buffer.memoryObservabilitySource,
    repositoryScope: buffer.repositoryScope,
    relatedTurns: relatedTurnsForBuffer(buffer),
    traceContext: sessionTraceContextForBuffer(buffer),
  });
  return true;
}

function memoryWritebackBufferKey(
  client: MemoryWritebackBufferDecision["client"],
  sessionKey: string,
  repositoryScope: RepositoryMemoryScope,
): string {
  return JSON.stringify([
    client,
    repositoryScope.effectiveUserId,
    sessionKey,
  ]);
}

function bufferedMessages(buffer: MemoryWritebackBuffer): WritebackMessage[] {
  return buffer.turns.flatMap((turn) => turn.messages);
}

function relatedTurnsForBuffer(buffer: MemoryWritebackBuffer): MemoryObservabilityRelatedTurn[] | undefined {
  const relatedTurns: MemoryObservabilityRelatedTurn[] = [];
  for (const turn of buffer.turns) {
    const context = turn.traceContext;
    if (!context) continue;
    relatedTurns.push({
      ...(context.turnId ? { turnId: context.turnId } : {}),
      ...(context.requestId ? { requestId: context.requestId } : {}),
      ...(context.nativeRequestId ? { nativeRequestId: context.nativeRequestId } : {}),
      contextOrigin: context.contextOrigin,
      capturedAt: context.capturedAt,
    });
  }
  return relatedTurns.length > 0 ? relatedTurns : undefined;
}

function sessionTraceContextForBuffer(buffer: MemoryWritebackBuffer): TraceContext | undefined {
  const contexts = buffer.turns.flatMap((turn) => turn.traceContext ? [turn.traceContext] : []);
  const context = contexts.find((candidate) => candidate.sessionId === buffer.sessionKey) ?? contexts[0];
  if (!context) return undefined;
  return {
    schemaVersion: context.schemaVersion,
    client: context.client,
    sessionId: context.sessionId,
    ...(context.threadId ? { threadId: context.threadId } : {}),
    ...(context.transcriptPath ? { transcriptPath: context.transcriptPath } : {}),
    ...(context.cwd ? { cwd: context.cwd } : {}),
    ...(context.workspaceKind ? { workspaceKind: context.workspaceKind } : {}),
    contextOrigin: context.contextOrigin,
    capturedAt: context.capturedAt,
  };
}
