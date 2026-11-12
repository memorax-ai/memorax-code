import { randomUUID } from "node:crypto";
import { backendDebug } from "../shared/debug-log.js";
import type { MemoryObservabilityEvent, MemoryObservabilityHook } from "../memory/observability.js";
import {
  TRACE_RUNTIME_CLIENTS,
  clientTraceConfigFromEnv,
} from "../trace/config.js";
import { recordTraceEvent } from "../trace/store.js";

export function createBackendMemoryObservability(
  memoraxCodeHome: string,
  existingHook?: MemoryObservabilityHook,
  env: Record<string, string | undefined> = process.env,
): MemoryObservabilityHook | undefined {
  if (existingHook) return existingHook;
  const effectiveEnv = { ...env, MEMORAX_CODE_HOME: memoraxCodeHome };
  return composeMemoryObservabilityHooks([
    sessionTraceObservabilityHook(memoraxCodeHome, effectiveEnv),
  ]);
}

export function composeMemoryObservabilityHooks(hooks: Array<MemoryObservabilityHook | undefined>): MemoryObservabilityHook | undefined {
  const active = hooks.filter((hook): hook is MemoryObservabilityHook => Boolean(hook?.recordEvent));
  if (active.length === 0) return undefined;
  return {
    recordEvent(event) {
      const correlatedEvent = event.eventId
        ? event
        : { ...event, eventId: `memory-observability-${randomUUID()}` };
      // Diagnostic failures must not change memory acceptance or suppress other sinks.
      for (const [sinkIndex, hook] of active.entries()) {
        try {
          hook.recordEvent?.(correlatedEvent);
        } catch (error) {
          backendDebug("memory_observability.sink_failed", {
            sinkIndex,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    },
    async drain() {
      await Promise.all(active.map(async (hook, sinkIndex) => {
        try {
          await hook.drain?.();
        } catch (error) {
          backendDebug("memory_observability.drain_failed", {
            sinkIndex,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }));
    },
  };
}

function sessionTraceObservabilityHook(
  memoraxCodeHome: string,
  env: Record<string, string | undefined>,
): MemoryObservabilityHook {
  // Keep the sink available: file configuration can enable tracing after startup.
  const pending = new Set<Promise<unknown>>();
  return {
    recordEvent(event) {
      const client = event.traceContext?.client;
      if (!client || !TRACE_RUNTIME_CLIENTS.includes(client)) return;
      const config = clientTraceConfigFromEnv(client, env);
      if (!config.enabled) return;
      // Queue local I/O without delaying the memory operation; shutdown uses drain.
      const write = recordTraceEvent({
        memoraxCodeHome,
        env,
        config,
        traceContext: event.traceContext,
        eventId: event.eventId,
        type: sessionTraceEventType(event),
        source: event.source,
        operation: event.operation,
        ok: event.ok,
        relatedTurns: event.relatedTurns,
        request: event.request,
        response: event.response,
        error: event.error,
      }).catch((error) => {
        backendDebug(`${client}_trace.write_failed`, {
          label: "memory_observability",
          error: error instanceof Error ? error.message : String(error),
        });
      }).finally(() => {
        pending.delete(write);
      });
      pending.add(write);
    },
    async drain() {
      // Wait for writes already queued here, including their failure handling.
      await Promise.allSettled([...pending]);
    },
  };
}

function sessionTraceEventType(event: MemoryObservabilityEvent): string {
  if (event.source === "memory_cli" && event.operation === "writeback") return "memory_cli_add";
  if (event.source === "memory_cli") return "memory_cli_search";
  if (event.operation === "writeback") return "memory_writeback";
  return "memory_retrieve";
}
