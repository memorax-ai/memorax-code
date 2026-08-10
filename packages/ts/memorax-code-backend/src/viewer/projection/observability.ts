import type { MemoryObservabilityHook } from "../../memory/observability.js";
import { recordMemoryViewerEvent } from "../store.js";

export function memoryViewerObservabilityHook(): MemoryObservabilityHook {
  return {
    recordEvent(event) {
      recordMemoryViewerEvent(event);
    },
  };
}
