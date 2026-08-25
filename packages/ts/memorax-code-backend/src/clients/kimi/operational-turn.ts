import { join } from "node:path";
import {
  atomicWriteJson,
  readJsonFile,
  stringOption,
  withJsonFileLock,
} from "../../../../memorax-code-adapter-common/src/config-utils.mjs";

const STATE_VERSION = 1;

export type KimiOperationalTurn = Readonly<{
  sessionId: string;
  promptId: string;
  cwd: string;
  workspaceKind?: string;
  updatedAt: number;
}>;

export function writeKimiOperationalTurn(
  memoraxCodeHome: string | undefined,
  turn: Omit<KimiOperationalTurn, "updatedAt">,
): void {
  const path = statePath(memoraxCodeHome);
  if (!path || !turn.sessionId || !turn.promptId || !turn.cwd) return;
  withJsonFileLock(path, () => {
    const state = readState(path);
    state.turns[key(turn.sessionId, turn.promptId)] = {
      ...turn,
      updatedAt: Date.now(),
    };
    atomicWriteJson(path, state);
  });
}

export function readKimiOperationalTurn(
  memoraxCodeHome: string | undefined,
  sessionId: string,
  promptId: string,
): KimiOperationalTurn | undefined {
  const path = statePath(memoraxCodeHome);
  if (!path) return undefined;
  const state = readState(path);
  const value = state.turns[key(sessionId, promptId)];
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  if (value.sessionId !== sessionId || value.promptId !== promptId || typeof value.cwd !== "string") return undefined;
  return {
    sessionId,
    promptId,
    cwd: value.cwd,
    ...(typeof value.workspaceKind === "string" ? { workspaceKind: value.workspaceKind } : {}),
    updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : 0,
  };
}

export function clearKimiOperationalTurn(
  memoraxCodeHome: string | undefined,
  sessionId: string,
  promptId: string,
): void {
  const path = statePath(memoraxCodeHome);
  if (!path) return;
  withJsonFileLock(path, () => {
    const state = readState(path);
    delete state.turns[key(sessionId, promptId)];
    if (Object.keys(state.turns).length) atomicWriteJson(path, state);
  });
}

function statePath(memoraxCodeHome: string | undefined): string | undefined {
  const home = stringOption(memoraxCodeHome);
  return home ? join(home, "adapters", "kimi", "operational-turns.json") : undefined;
}

function readState(path: string): { version: number; turns: Record<string, any> } {
  const value = readJsonFile(path)?.value;
  return value && value.version === STATE_VERSION && value.turns
    && typeof value.turns === "object" && !Array.isArray(value.turns)
    ? { version: STATE_VERSION, turns: value.turns }
    : { version: STATE_VERSION, turns: {} };
}

function key(sessionId: string, promptId: string): string {
  return JSON.stringify([sessionId, promptId]);
}
