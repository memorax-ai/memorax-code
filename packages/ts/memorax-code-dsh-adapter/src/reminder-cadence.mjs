import { join } from "node:path";
import { atomicWriteJson, readJsonFile, withJsonFileLock } from "../memorax-code-adapter-common/src/config-utils.mjs";

/** Cadence metadata only: no prompts, model results, or native content authority. */
export function createDshReminderCadence(memoraxCodeHome) {
  const path = join(memoraxCodeHome, "adapters", "dsh", "reminder-cadence.json");
  function state() {
    const record = readJsonFile(path)?.value;
    return record?.version === 1 && record.sessions && typeof record.sessions === "object" && !Array.isArray(record.sessions)
      ? record : { version: 1, sessions: {} };
  }
  return {
    read(sessionId) {
      try {
        const value = state().sessions[sessionId];
        return Number.isSafeInteger(value?.startSeq) && value.startSeq >= 0
          && Number.isSafeInteger(value?.turn) && value.turn > 0 ? value : undefined;
      } catch { return undefined; }
    },
    commit(sessionId, value) {
      try {
        withJsonFileLock(path, () => {
          const current = state();
          if ((current.sessions[sessionId]?.startSeq ?? -1) >= value.startSeq) return;
          current.sessions[sessionId] = { startSeq: value.startSeq, turn: value.turn, updatedAt: Date.now() };
          const oldest = Object.keys(current.sessions).sort((a, b) =>
            (current.sessions[a]?.updatedAt ?? 0) - (current.sessions[b]?.updatedAt ?? 0));
          for (const id of oldest.slice(0, Math.max(0, oldest.length - 1024))) delete current.sessions[id];
          atomicWriteJson(path, current);
        });
      } catch { /* In-memory cadence remains valid for this plugin instance. */ }
    },
  };
}
