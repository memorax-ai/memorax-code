import type { MemoryDiagnosticLogger } from "./observability.js";
import {
  parseSkillReminderCommand,
  type SkillReminderCommand,
} from "./hook-command.js";
import {
  traceContextFromClaudeHookBody,
  traceContextFromHookBody,
  type TraceContext,
} from "../trace/context.js";
import { recordTraceEvent } from "../trace/store.js";

export type MemoryReminderTraceRecorderOptions = {
  diagnosticLogger?: MemoryDiagnosticLogger;
  env?: Record<string, string | undefined>;
  memoraxCodeHome?: string;
};

export type MemoryReminderTraceRecorder = {
  recordSkillReminder(body: unknown): Promise<{ ok: true }>;
};

export function createMemoryReminderTraceRecorder(
  options: MemoryReminderTraceRecorderOptions = {},
): MemoryReminderTraceRecorder {
  return {
    async recordSkillReminder(body) {
      const parsed = parseSkillReminderCommand(body);
      if (!parsed.ok) {
        options.diagnosticLogger?.("memory_hook.skill_reminder_invalid", {
          error: parsed.error,
        });
        return { ok: true };
      }
      const request = parsed.command;
      const traceContext = traceContextForReminder(request);
      await recordTraceBestEffort("memory_hook.skill_reminder_event", recordTraceEvent({
        memoraxCodeHome: options.memoraxCodeHome,
        env: options.env,
        traceContext,
        type: "skill_reminder",
        source: request.client === "codex" ? "codex-hook" : "claude-hook",
        operation: "reminder",
        ok: true,
        request: {
          triggers: request.triggers,
        },
        response: {
          role: "developer",
          content: request.content,
        },
      }), options.diagnosticLogger);
      options.diagnosticLogger?.("memory_hook.skill_reminder", {
        client: request.client,
        sessionId: request.sessionId,
        turnId: request.client === "codex" ? request.turnId : request.promptId,
        triggers: request.triggers,
        contentChars: request.content.length,
      });
      return { ok: true };
    },
  };
}

function traceContextForReminder(command: SkillReminderCommand): TraceContext | undefined {
  if (command.client === "codex") return traceContextFromHookBody(command);
  return traceContextFromClaudeHookBody(command);
}

async function recordTraceBestEffort(
  label: string,
  promise: Promise<unknown>,
  diagnosticLogger?: MemoryDiagnosticLogger,
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    diagnosticLogger?.("memory_trace.write_failed", {
      label,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
