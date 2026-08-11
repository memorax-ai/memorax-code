import { existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  atomicWriteJson,
  readJsonFile,
  readStdinJson,
  stringOption,
  withJsonFileLock,
} from "../config-utils.mjs";

export async function runCaptureCwdHook(options) {
  const input = await readStdinJson();
  const record = recordWorkspaceEvidence(options, input);
  if (!record) return;

  if (record.cwd) {
    const pluginDataPath = pluginDataWorkspacePath();
    if (pluginDataPath) writeWorkspaceState(pluginDataPath, record, options);
  }
  writeSessionRegistry(memoraxCodeSessionRegistryPath(options), record, options);
  return input;
}

export function recordWorkspaceEvidence(options, input) {
  const transcriptPath = stringOption(input.transcript_path) ?? stringOption(input.transcriptPath);
  if (options.requireTranscriptPathForTurnEvents && isTurnScopedEvent(input) && !transcriptPath) return;
  const cwd = typeof input.cwd === "string" && input.cwd.trim()
    ? safeRealpath(input.cwd.trim())
    : undefined;

  const record = {
    event: stringOption(input.hook_event_name) ?? stringOption(input.event) ?? stringOption(input.type) ?? "unknown",
    sessionId: stringOption(input.session_id) ?? stringOption(input.sessionId),
    transcriptPath,
    cwd,
    capturedAt: new Date().toISOString(),
  };

  if (cwd) {
    const workspacePath = memoraxCodeWorkspacePath(options);
    if (workspacePath) writeWorkspaceState(workspacePath, record, options);
  }

  return record;
}

function isTurnScopedEvent(input) {
  const event = stringOption(input.hook_event_name) ?? stringOption(input.event) ?? stringOption(input.type);
  return event === "UserPromptSubmit" || event === "Stop";
}

function memoraxCodeWorkspacePath(options) {
  const home = memoraxCodeHome(options);
  return home ? join(home, "adapters", options.adapterDir, "workspaces.json") : undefined;
}

function memoraxCodeSessionRegistryPath(options) {
  const home = memoraxCodeHome(options);
  return home ? join(home, "adapters", options.adapterDir, "session-registry.json") : undefined;
}

function memoraxCodeHome(options) {
  return stringOption(options.memoraxCodeHome)
    ?? process.env.MEMORAX_CODE_HOME
    ?? (process.env.HOME ? join(process.env.HOME, ".memorax-code") : undefined);
}

function pluginDataWorkspacePath() {
  return process.env.PLUGIN_DATA ? join(process.env.PLUGIN_DATA, "workspaces.json") : undefined;
}

function writeWorkspaceState(path, record, options) {
  withJsonFileLock(path, () => {
    const existing = readJsonFile(path);
    if (existing?.unreadable) return;
    const state = existing?.value ?? { version: 1, runtime: options.runtime, sessions: {} };
    state.version = 1;
    state.runtime = options.runtime;
    state.updatedAt = record.capturedAt;
    state.latest = record;
    state.sessions = typeof state.sessions === "object" && state.sessions && !Array.isArray(state.sessions)
      ? state.sessions
      : {};
    for (const key of recordKeys(record, options)) state.sessions[key] = record;
    atomicWriteJson(path, state);
  });
}

function writeSessionRegistry(path, record, options) {
  if (!path) return undefined;
  const keys = recordKeys(record, options);
  if (keys.length === 0) return undefined;
  return withJsonFileLock(path, () => {
    const existing = readJsonFile(path);
    if (existing?.unreadable) return undefined;
    const state = existing?.value ?? { version: 1, runtime: options.runtime, sessions: {} };
    state.version = 1;
    state.runtime = options.runtime;
    state.sessions = typeof state.sessions === "object" && state.sessions && !Array.isArray(state.sessions)
      ? state.sessions
      : {};
    const matchedKey = keys.find((key) => state.sessions[key]);
    const key = matchedKey ?? keys[0];
    const current = state.sessions[key];
    const session = {
      key,
      title: current?.title,
      [options.sessionIdField]: record.sessionId ?? current?.[options.sessionIdField] ?? key,
      transcriptPath: record.transcriptPath ?? current?.transcriptPath,
      workspace: record.cwd ?? current?.workspace,
    };
    state.updatedAt = record.capturedAt;
    state.sessions[key] = session;
    atomicWriteJson(path, state);
  });
}

function recordKeys(record, options) {
  const values = [];
  if (record.sessionId) values.push(record.sessionId);
  if (record.transcriptPath) values.push(record.transcriptPath, basenameWithoutExt(record.transcriptPath));
  const keys = new Set();
  for (const value of values) {
    if (!value) continue;
    keys.add(value);
    if (value.startsWith(`${options.sessionKeyPrefix}_`)) keys.add(value.slice(options.sessionKeyPrefix.length + 1));
    else keys.add(`${options.sessionKeyPrefix}_${value}`);
  }
  return [...keys];
}

function basenameWithoutExt(value) {
  const base = value.split(/[\\/]/).pop() ?? value;
  return base.replace(/\.[^.]+$/, "");
}

function safeRealpath(path) {
  try {
    const resolved = resolve(path);
    return existsSync(resolved) ? realpathSync(resolved) : undefined;
  } catch {
    return undefined;
  }
}
