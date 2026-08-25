import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  atomicWriteJson,
  readJsonFile,
  sha256,
  stringOption,
  withJsonFileLock,
} from "../../memorax-code-adapter-common/src/config-utils.mjs";

const STATE_VERSION = 1;
const MAX_PENDING_PER_SESSION = 32;

export function kimiCorrelationStatePath(memoraxCodeHome = defaultMemoraxCodeHome()) {
  return join(memoraxCodeHome, "adapters", "kimi", "prompt-correlations.json");
}

export function rememberKimiPrompt({ statePath, sessionId, prompt, now = Date.now() }) {
  const normalizedSessionId = stringOption(sessionId);
  const normalizedPrompt = stringOption(prompt);
  if (!statePath || !normalizedSessionId || !normalizedPrompt) return undefined;
  return withJsonFileLock(statePath, () => {
    const state = readState(statePath);
    const pending = Array.isArray(state.sessions[normalizedSessionId])
      ? state.sessions[normalizedSessionId]
      : [];
    const promptHash = sha256(normalizedPrompt);
    const existing = pending.find((entry) => (
      entry?.promptHash === promptHash && !stringOption(entry?.turnId)
    ));
    if (existing) {
      if (stringOption(existing.reminderId)) return existing;
      const upgraded = { ...existing, reminderId: randomUUID() };
      const index = pending.indexOf(existing);
      state.sessions[normalizedSessionId] = pending.toSpliced(index, 1, upgraded);
      atomicWriteJson(statePath, state);
      return upgraded;
    }
    const entry = {
      promptHash,
      reminderId: randomUUID(),
      submittedAt: Number.isFinite(now) ? now : Date.now(),
    };
    state.sessions[normalizedSessionId] = [...pending, entry].slice(-MAX_PENDING_PER_SESSION);
    atomicWriteJson(statePath, state);
    return entry;
  });
}

export function attachKimiTurnId({ statePath, sessionId, prompt, turnId, now = Date.now() }) {
  const normalizedSessionId = stringOption(sessionId);
  const normalizedPrompt = stringOption(prompt);
  const normalizedTurnId = stringOption(turnId);
  if (!statePath || !normalizedSessionId || !normalizedPrompt || !normalizedTurnId) {
    return { matched: false, reason: "identity_missing" };
  }
  return withJsonFileLock(statePath, () => {
    const state = readState(statePath);
    const pending = Array.isArray(state.sessions[normalizedSessionId])
      ? state.sessions[normalizedSessionId]
      : [];
    const promptHash = sha256(normalizedPrompt);
    const index = pending.findIndex((entry) => (
      entry?.promptHash === promptHash && !stringOption(entry?.turnId)
    ));
    if (index < 0) return { matched: false, reason: "prompt_not_found" };
    const entry = pending[index];
    state.sessions[normalizedSessionId] = pending.toSpliced(index, 1, {
      ...entry,
      turnId: normalizedTurnId,
      startedAt: Number.isFinite(now) ? now : Date.now(),
    });
    atomicWriteJson(statePath, state);
    return { matched: true, turnId: normalizedTurnId };
  });
}

export function pendingKimiTurns({ statePath, sessionId }) {
  const normalizedSessionId = stringOption(sessionId);
  if (!statePath || !normalizedSessionId) return [];
  const state = readState(statePath);
  const pending = Array.isArray(state.sessions[normalizedSessionId])
    ? state.sessions[normalizedSessionId]
    : [];
  return pending.filter((entry) => stringOption(entry?.promptHash) && stringOption(entry?.turnId));
}

export function consumeKimiTurn({ statePath, sessionId, promptHash, turnId }) {
  const normalizedSessionId = stringOption(sessionId);
  const normalizedPromptHash = stringOption(promptHash);
  const normalizedTurnId = stringOption(turnId);
  if (!statePath || !normalizedSessionId || !normalizedPromptHash || !normalizedTurnId) return false;
  return withJsonFileLock(statePath, () => {
    const state = readState(statePath);
    const pending = Array.isArray(state.sessions[normalizedSessionId])
      ? state.sessions[normalizedSessionId]
      : [];
    const next = pending.filter((entry) => (
      entry?.promptHash !== normalizedPromptHash || entry?.turnId !== normalizedTurnId
    ));
    if (next.length === pending.length) return false;
    if (next.length) state.sessions[normalizedSessionId] = next;
    else delete state.sessions[normalizedSessionId];
    atomicWriteJson(statePath, state);
    return true;
  });
}

function readState(path) {
  const value = readJsonFile(path)?.value;
  if (!value || value.version !== STATE_VERSION || !value.sessions || typeof value.sessions !== "object") {
    return { version: STATE_VERSION, sessions: {} };
  }
  return { version: STATE_VERSION, sessions: value.sessions };
}

function defaultMemoraxCodeHome() {
  return process.env.MEMORAX_CODE_HOME
    ?? (process.env.HOME ? join(process.env.HOME, ".memorax-code") : ".memorax-code");
}
