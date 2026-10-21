import { realpath } from "node:fs/promises";
import { isQoderManagedTaskWorkspace } from "../../../../memorax-code-adapter-common/src/default-workspace.mjs";
import { createHarnessMemoryRuntime, type HarnessMemoryRuntimeOptions } from "../../memory/harness-runtime.js";
import type { MemoryHookTurnStartResult, QoderTurnStartCommand, QoderWritebackCommand } from "../../memory/hook-command.js";
import type { MemoryTurnState } from "../../memory/turn-coordinator.js";
import { traceContextFromQoderHookBody, type TraceContext } from "../../trace/context.js";
import { markCurrentTraceTurnOutcome, recordTraceEvent, traceTurnEventId } from "../../trace/store.js";
import { readQoderTranscriptTurn } from "./transcript-turn.js";

export type QoderMemoryHookWritebackResult =
  | { ok: true; scheduled: true }
  | { ok: true; scheduled: false; reason: string };

type Turn = {
  command: QoderTurnStartCommand;
  metadata: MemoryTurnState;
  outcome?: "completed" | "interrupted";
};

type Session = { current: Turn; seenTurnIds: Set<string> };
const MAX_SESSION_TURNS = 4096;

export function createQoderMemoryHookRuntime(options: HarnessMemoryRuntimeOptions = {}) {
  const now = options.now ?? (() => Date.now());
  const memory = createHarnessMemoryRuntime({
    client: "qoder", writebackSource: "qoder_hook_writeback",
    diagnosticPrefix: "qoder_memory", traceFailureEvent: "qoder_trace.write_failed",
    turnStartTraceSource: "qoder-hook",
  }, options);
  const sessions = new Map<string, Session>();
  const operations = new Map<string, Promise<unknown>>();
  const limit = Number.isInteger(options.maxEntries) && options.maxEntries! > 0 ? options.maxEntries! : 256;
  let closed = false;

  function validWorkspaceHint(command: QoderTurnStartCommand | QoderWritebackCommand): boolean {
    return command.workspaceKind === undefined || (command.workspaceKind === "projectless"
      && isQoderManagedTaskWorkspace(command.cwd, { env: options.env }));
  }

  function serial<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = operations.get(sessionId) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(operation);
    operations.set(sessionId, pending);
    void pending.finally(() => {
      if (operations.get(sessionId) === pending) operations.delete(sessionId);
    }).catch(() => {});
    return pending;
  }

  function skipped(command: QoderWritebackCommand, reason: string, metadataDisposition = "retained"): QoderMemoryHookWritebackResult {
    options.diagnosticLogger?.("qoder_memory.writeback", {
      sessionId: command.sessionId, turnId: command.turnId, scheduled: false, reason, metadataDisposition,
    });
    return { ok: true, scheduled: false, reason };
  }

  async function trace(operation: Promise<unknown>) {
    try { await operation; }
    catch { options.diagnosticLogger?.("qoder_trace.write_failed", { reason: "trace_write_failed" }); }
  }

  async function endTurn(context: TraceContext | undefined, outcome: "completed" | "interrupted") {
    await trace(recordTraceEvent({
      eventId: traceTurnEventId(context, "turn_end"),
      memoraxCodeHome: options.memoraxCodeHome, env: options.env, traceContext: context,
      type: "turn_end", source: "qoder-hook", operation: "writeback", ok: true, outcome,
    }));
    await trace(markCurrentTraceTurnOutcome(context, outcome, {
      client: "qoder", memoraxCodeHome: options.memoraxCodeHome, env: options.env,
      now: () => new Date(now()),
    }));
  }

  return {
    recordTurnStart(command: QoderTurnStartCommand): Promise<MemoryHookTurnStartResult & { recorded: boolean; reason?: string }> {
      return serial(command.sessionId, async () => {
        if (closed) return { ok: true, recorded: false, reason: "runtime_closed" };
        if (!validWorkspaceHint(command)) return { ok: true, recorded: false, reason: "workspace_scope_mismatch" };
        // Native background notifications also emit UserPromptSubmit, before
        // their origin is persisted. A matching envelope only delays handling;
        // a real human may paste it and must remain eligible after completion.
        if (isTaskNotificationCandidate(command.prompt)) {
          const native = await readQoderTranscriptTurn({
            ...command, afterTurnId: sessions.get(command.sessionId)?.current.command.turnId,
          });
          if (!native.ok) return { ok: true, recorded: false, reason: native.reason };
          if (native.turn.userPrompt !== command.prompt) return { ok: true, recorded: false, reason: "turn_prompt_mismatch" };
          if (native.turn.cwd !== command.cwd) return { ok: true, recorded: false, reason: "workspace_scope_mismatch" };
          if (closed) return { ok: true, recorded: false, reason: "runtime_closed" };
        }
        const session = sessions.get(command.sessionId);
        const previous = session?.current;
        if (previous?.command.turnId === command.turnId) {
          const same = matchingWorkspace(previous.command, command) && previous.command.prompt === command.prompt;
          return { ok: true, recorded: same && !previous.outcome,
            ...(!same ? { reason: "turn_metadata_mismatch" } : {}) };
        }
        // Native request-set IDs are opaque. Retain exact history instead of
        // letting a delayed Submit replace a newer turn or revive a closed one.
        if (session?.seenTurnIds.has(command.turnId)) {
          return { ok: true, recorded: false, reason: "turn_already_observed" };
        }
        if (session && session.seenTurnIds.size >= MAX_SESSION_TURNS) {
          return { ok: true, recorded: false, reason: "session_turn_history_full" };
        }
        if (previous && !previous.outcome) {
          memory.turnCoordinator.discardTurn(previous.metadata, "superseded");
          await endTurn(previous.metadata.traceContext, "interrupted");
          options.diagnosticLogger?.("qoder_memory.turn_discarded", {
            sessionId: command.sessionId, turnId: previous.command.turnId,
            reason: "superseded", metadataDisposition: "discarded",
          });
        }
        const createdAt = now();
        const traceContext = traceContextFromQoderHookBody(command, new Date(createdAt).toISOString());
        const result = await memory.recordTurnStart({
          sessionId: command.sessionId, clientTurnId: command.turnId,
          cwd: command.cwd, workspaceKind: command.workspaceKind, transcriptPath: command.transcriptPath,
          createdAt, traceContext, prompt: command.prompt,
          onTurnRegistered(metadata) {
            sessions.delete(command.sessionId);
            const seenTurnIds = session?.seenTurnIds ?? new Set<string>();
            seenTurnIds.add(command.turnId);
            sessions.set(command.sessionId, { current: { command, metadata }, seenTurnIds });
            while (sessions.size > limit) {
              const oldest = sessions.keys().next().value;
              if (oldest === undefined) break;
              sessions.delete(oldest);
            }
          },
        });
        return { ...result, recorded: true };
      });
    },

    writeback(command: QoderWritebackCommand): Promise<QoderMemoryHookWritebackResult> {
      return serial(command.sessionId, async () => {
        if (closed) return skipped(command, "runtime_closed");
        if (!validWorkspaceHint(command)) return skipped(command, "workspace_scope_mismatch");
        const turn = sessions.get(command.sessionId)?.current;
        // Native content cannot restore the scope binding of a missing start.
        // A new Submit registers the next turn after a Backend restart.
        if (!turn) return skipped(command, "turn_metadata_missing", "absent");
        if (turn.command.turnId !== command.turnId || !matchingWorkspace(turn.command, command)) {
          return skipped(command, "turn_metadata_mismatch");
        }
        if (turn.outcome) return skipped(command, turn.outcome === "completed" ? "already_accepted_locally" : "interrupted", "absent");
        const traceContext = turn.metadata.traceContext;
        if (command.status === "aborted") {
          memory.turnCoordinator.discardTurn(turn.metadata, "interrupted");
          turn.outcome = "interrupted";
          await endTurn(traceContext, "interrupted");
          return skipped(command, "interrupted", "discarded");
        }
        const native = await readQoderTranscriptTurn(command);
        if (!native.ok) return skipped(command, native.reason);
        if (native.turn.userPrompt !== turn.command.prompt) return skipped(command, "turn_prompt_mismatch");
        try {
          const [nativeRoot, startRoot] = await Promise.all([realpath(native.turn.cwd), realpath(turn.command.cwd)]);
          if (nativeRoot !== startRoot) return skipped(command, "workspace_scope_mismatch");
        } catch { return skipped(command, "workspace_scope_unavailable"); }
        if (closed) return skipped(command, "runtime_closed");
        if (!validWorkspaceHint(turn.command)) return skipped(command, "workspace_scope_mismatch");
        const result = await memory.completeTurn({
          sessionId: command.sessionId, clientTurnId: command.turnId, metadata: turn.metadata,
          userText: native.turn.userPrompt, assistantText: native.turn.assistantReply,
          userTimestamp: native.turn.userTimestamp, assistantTimestamp: native.turn.assistantTimestamp,
          traceContext,
          resolveRepositoryMemory: () => memory.resolveRepositoryMemory({
            sessionId: command.sessionId, cwd: turn.command.cwd,
            workspaceKind: turn.command.workspaceKind, requireBoundScope: true,
          }),
        });
        if (!result.scheduled) return skipped(command, result.reason, result.metadataDisposition);
        // Only accepted local enqueue closes a completed turn. Rejected or
        // partially persisted content can be retried with the same identity.
        turn.outcome = "completed";
        await trace(recordTraceEvent({
          eventId: traceTurnEventId(traceContext, "turn_materialized"),
          memoraxCodeHome: options.memoraxCodeHome, env: options.env, traceContext,
          type: "turn_materialized", source: "qoder-hook", operation: "writeback", ok: true,
          request: { prompt: native.turn.userPrompt }, response: { assistant: native.turn.assistantReply },
        }));
        await endTurn(traceContext, "completed");
        options.diagnosticLogger?.("qoder_memory.writeback", {
          sessionId: command.sessionId, turnId: command.turnId, scheduled: true,
          metadataDisposition: result.metadataDisposition, contentSource: "qoder_transcript",
        });
        return { ok: true, scheduled: true };
      });
    },
    size() { return memory.size(); },
    close() { closed = true; sessions.clear(); memory.close(); },
  };
}

function matchingWorkspace(start: QoderTurnStartCommand, other: QoderTurnStartCommand | QoderWritebackCommand) {
  return start.cwd === other.cwd && start.workspaceKind === other.workspaceKind
    && start.transcriptPath === other.transcriptPath;
}

function isTaskNotificationCandidate(prompt: string) {
  return /^\s*<task-notification>[\s\S]*<task-id>[^<>]+<\/task-id>[\s\S]*<\/task-notification>\s*$/.test(prompt);
}
