import type { AutomaticMemoryWritebackRejectionReason } from "../../memory/automatic-writeback.js";
import {
  createHarnessMemoryRuntime,
  type HarnessMemoryRuntimeOptions,
} from "../../memory/harness-runtime.js";
import type {
  MemoryHookTurnStartResult,
  OpenCodeTurnStartCommand,
  OpenCodeWritebackCommand,
} from "../../memory/hook-command.js";
import type { MemoryDiagnosticLogger } from "../../memory/observability.js";
import type { RepositoryMemoryScopeFailureReason } from "../../repository/scope.js";
import { traceContextFromOpenCodeHookBody, type TraceContext } from "../../trace/context.js";
import {
  markCurrentTraceTurnOutcome,
  recordTraceEvent,
  traceTurnEventId,
} from "../../trace/store.js";
import {
  openCodeMessageTurn,
  type OpenCodeMessageTurnFailureReason,
} from "./message-turn.js";

export type OpenCodeMemoryHookWritebackSkipReason =
  | "turn_metadata_mismatch"
  | "interrupted"
  | "config_missing"
  | OpenCodeMessageTurnFailureReason
  | RepositoryMemoryScopeFailureReason
  | AutomaticMemoryWritebackRejectionReason;

export type OpenCodeMemoryHookWritebackResult =
  | { ok: true; scheduled: true }
  | { ok: true; scheduled: false; reason: OpenCodeMemoryHookWritebackSkipReason };

export type OpenCodeMemoryHookRuntimeOptions = HarnessMemoryRuntimeOptions;

export type OpenCodeMemoryHookRuntime = {
  recordTurnStart(command: OpenCodeTurnStartCommand): Promise<MemoryHookTurnStartResult>;
  writeback(command: OpenCodeWritebackCommand): Promise<OpenCodeMemoryHookWritebackResult>;
  size(): number;
  close(): void;
};

const OPENCODE_MEMORY_TURN_CLIENT = "opencode" as const;

export function createOpenCodeMemoryHookRuntime(
  options: OpenCodeMemoryHookRuntimeOptions = {},
): OpenCodeMemoryHookRuntime {
  const now = options.now ?? (() => Date.now());
  const memory = createHarnessMemoryRuntime({
    client: OPENCODE_MEMORY_TURN_CLIENT,
    retrievalSource: "opencode_plugin_retrieval",
    writebackSource: "opencode_plugin_writeback",
    diagnosticPrefix: "opencode_memory",
    traceFailureEvent: "opencode_trace.write_failed",
    turnStartTraceSource: "opencode-plugin",
    deduplicateRetrieval: true,
  }, options);
  const { turnCoordinator } = memory;

  return {
    async recordTurnStart(command) {
      turnCoordinator.pruneExpired();
      const createdAt = now();
      const traceContext = traceContextFromOpenCodeHookBody(command, new Date(createdAt).toISOString());
      return await memory.recordTurnStart({
        sessionId: command.sessionId,
        clientTurnId: command.userMessageId,
        cwd: command.cwd,
        workspaceKind: command.workspaceKind,
        createdAt,
        traceContext,
        prompt: command.prompt,
        diagnosticFields: { sessionId: command.sessionId, userMessageId: command.userMessageId },
      });
    },
    async writeback(command) {
      turnCoordinator.pruneExpired();
      const key = openCodeTurnKey(command.sessionId, command.userMessageId);
      const entry = turnCoordinator.getTurn(key);
      const materialized = openCodeMessageTurn(command.messages, command);
      if (!materialized.ok) {
        options.diagnosticLogger?.("opencode_memory.writeback", {
          scheduled: false,
          reason: materialized.reason,
          sessionId: command.sessionId,
          userMessageId: command.userMessageId,
          assistantMessageId: command.assistantMessageId,
        });
        return { ok: true, scheduled: false, reason: materialized.reason };
      }
      if (materialized.turn.outcome === "interrupted") {
        if (!entry) {
          options.diagnosticLogger?.("opencode_memory.writeback", {
            scheduled: false,
            reason: "turn_metadata_mismatch",
            sessionId: command.sessionId,
            userMessageId: command.userMessageId,
            assistantMessageId: command.assistantMessageId,
          });
          return { ok: true, scheduled: false, reason: "turn_metadata_mismatch" };
        }
        const traceContext = entry.traceContext;
        await recordTraceBestEffort("opencode_memory.interrupted_turn_end_event", recordTraceEvent({
          eventId: traceTurnEventId(traceContext, "turn_end"),
          memoraxCodeHome: options.memoraxCodeHome,
          env: options.env,
          traceContext,
          type: "turn_end",
          source: "opencode-plugin",
          operation: "reply",
          ok: true,
          outcome: "interrupted",
          response: {
            assistantMessage: materialized.turn.assistantReply,
          },
        }), options.diagnosticLogger);
        await recordTraceBestEffort(
          "opencode_memory.interrupted_current_turn_close",
          markCurrentTraceTurnOutcome(traceContext, "interrupted", {
            client: "opencode",
            memoraxCodeHome: options.memoraxCodeHome,
            env: options.env,
          }),
          options.diagnosticLogger,
        );
        turnCoordinator.discardTurn(key, "interrupted");
        options.diagnosticLogger?.("opencode_memory.writeback", {
          scheduled: false,
          reason: "interrupted",
          metadataDisposition: "consumed",
          sessionId: command.sessionId,
          userMessageId: command.userMessageId,
          assistantMessageId: command.assistantMessageId,
        });
        return { ok: true, scheduled: false, reason: "interrupted" };
      }
      const traceContext = entry?.traceContext
        ?? traceContextFromOpenCodeHookBody(command, new Date(now()).toISOString());
      await recordTraceBestEffort("opencode_memory.turn_end_event", recordTraceEvent({
        eventId: traceTurnEventId(traceContext, "turn_end"),
        memoraxCodeHome: options.memoraxCodeHome,
        env: options.env,
        traceContext,
        type: "turn_end",
        source: "opencode-plugin",
        operation: "writeback",
        ok: true,
        outcome: materialized.turn.outcome,
        response: {
          content: materialized.turn.assistantReply,
        },
      }), options.diagnosticLogger);
      await recordTraceBestEffort("opencode_memory.current_turn_close", markCurrentTraceTurnOutcome(
        traceContext,
        "completed",
        {
          client: "opencode",
          memoraxCodeHome: options.memoraxCodeHome,
          env: options.env,
        },
      ), options.diagnosticLogger);
      const writeback = await memory.completeTurn({
        sessionId: command.sessionId,
        clientTurnId: command.userMessageId,
        metadata: entry,
        resolveRepositoryMemory: () => memory.resolveRepositoryMemory({
          sessionId: command.sessionId,
          cwd: command.cwd ?? entry?.cwd,
          workspaceKind: command.workspaceKind ?? entry?.workspaceKind,
          requireBoundScope: true,
        }),
        userText: materialized.turn.userPrompt,
        assistantText: materialized.turn.assistantReply,
        traceContext,
      });
      if (!writeback.scheduled) {
        options.diagnosticLogger?.("opencode_memory.writeback", {
          scheduled: false,
          reason: writeback.reason,
          metadataDisposition: writeback.metadataDisposition,
          sessionId: command.sessionId,
          userMessageId: command.userMessageId,
          assistantMessageId: command.assistantMessageId,
        });
        return { ok: true, scheduled: false, reason: writeback.reason };
      }
      options.diagnosticLogger?.("opencode_memory.writeback", {
        scheduled: true,
        metadataDisposition: writeback.metadataDisposition,
        sessionId: command.sessionId,
        userMessageId: command.userMessageId,
        assistantMessageId: command.assistantMessageId,
        promptChars: materialized.turn.userPrompt.length,
        assistantChars: materialized.turn.assistantReply.length,
        contentSource: "opencode_sdk_messages",
      });
      return { ok: true, scheduled: true };
    },
    size() {
      return memory.size();
    },
    close() {
      memory.close();
    },
  };
}

function openCodeTurnKey(sessionId: string, userMessageId: string) {
  return {
    client: OPENCODE_MEMORY_TURN_CLIENT,
    sessionId,
    clientTurnId: userMessageId,
  } as const;
}

async function recordTraceBestEffort(
  label: string,
  promise: Promise<unknown>,
  diagnosticLogger?: MemoryDiagnosticLogger,
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    diagnosticLogger?.("opencode_trace.write_failed", {
      label,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
