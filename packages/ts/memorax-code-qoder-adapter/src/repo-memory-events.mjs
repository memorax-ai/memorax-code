import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const adapterRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packagedCommon = join(adapterRoot, "memorax-code-adapter-common", "src");
const commonRoot = existsSync(packagedCommon) ? packagedCommon : resolve(adapterRoot, "../memorax-code-adapter-common/src");
const { withJsonFileLock } = await import(pathToFileURL(join(commonRoot, "config-utils.mjs")).href);
const { writePrivateJsonRecord } = await import(pathToFileURL(join(commonRoot, "runtime-record.mjs")).href);

const MAX_RECORD_BYTES = 8 * 1024 * 1024;
const MAX_PROMPT_BYTES = 1024 * 1024;
const MAX_PENDING = 64;
const RETENTION_MS = 24 * 60 * 60 * 1000;

export function isQoderChildHook(input) {
  return input !== null && typeof input === "object"
    && (Object.hasOwn(input, "agent_id") || Object.hasOwn(input, "agent_type"));
}

// This recognizes a candidate for delayed registration, never its author.
// Backend native-human validation must also accept a user pasting this envelope.
export function isQoderTaskNotificationCandidate(prompt) {
  return typeof prompt === "string"
    && /^\s*<task-notification>[\s\S]*<task-id>[^<>]+<\/task-id>[\s\S]*<\/task-notification>\s*$/.test(prompt);
}

export function deferQoderNotification(command, options = {}) {
  if (!isQoderTaskNotificationCandidate(command?.prompt)) return false;
  const start = startCommand(command);
  if (!start || Buffer.byteLength(start.prompt) > MAX_PROMPT_BYTES) throw invalidRecord();
  mutate(options, (records, now) => {
    const key = recordKey(start);
    const previous = records.find((record) => record.key === key);
    if (previous) {
      if (JSON.stringify(previous.command) !== JSON.stringify(start)) throw invalidRecord();
      return;
    }
    if (records.length >= MAX_PENDING) throw invalidRecord();
    records.push({ key, expiresAt: now + RETENTION_MS, command: start });
  });
  return true;
}

// Reading keeps the observation available until Backend registration succeeds.
export function peekQoderNotification(command, options = {}) {
  return observeQoderNotification(command, options, false);
}

// Consume only this Hook observation. Backend Turn metadata is still retained
// until native writeback is accepted; this record is not completion authority.
export function consumeQoderNotification(command, options = {}) {
  return observeQoderNotification(command, options, true);
}

function observeQoderNotification(command, options, consume) {
  if (!commandIdentity(command)) return undefined;
  const path = recordPath(options);
  if (!existsSync(path)) return undefined;
  return mutate(options, (records) => {
    const index = records.findIndex((record) => record.key === recordKey(command));
    if (index < 0) return undefined;
    const start = records[index].command;
    if (start.cwd !== command.cwd || start.transcriptPath !== command.transcriptPath
      || start.workspaceKind !== command.workspaceKind
      || (Object.hasOwn(command, "prompt") && start.prompt !== command.prompt)) return undefined;
    if (consume) records.splice(index, 1);
    return start;
  });
}

function mutate(options, operation) {
  const path = recordPath(options);
  const now = options.now?.() ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) throw invalidRecord();
  return withJsonFileLock(path, () => {
    const records = readRecords(path).filter((record) => record.expiresAt > now);
    const result = operation(records, now);
    if (records.length === 0) rmSync(path, { force: true });
    else {
      const state = { version: 1, client: "qoder", kind: "deferred-task-notifications", records };
      if (Buffer.byteLength(`${JSON.stringify(state, null, 2)}\n`) > MAX_RECORD_BYTES) throw invalidRecord();
      writePrivateJsonRecord(path, state, { durableBoundary: options.memoraxCodeHome });
    }
    return result;
  });
}

function readRecords(path) {
  if (!existsSync(path)) return [];
  const info = statSync(path);
  if (!info.isFile() || info.size > MAX_RECORD_BYTES) throw invalidRecord();
  let state;
  try { state = JSON.parse(readFileSync(path, "utf8")); }
  catch { throw invalidRecord(); }
  if (state?.version !== 1 || state.client !== "qoder" || state.kind !== "deferred-task-notifications"
    || !Array.isArray(state.records) || state.records.length > MAX_PENDING) throw invalidRecord();
  const keys = new Set();
  return state.records.map((record) => {
    const start = startCommand(record?.command);
    if (!start || !isQoderTaskNotificationCandidate(start.prompt) || Buffer.byteLength(start.prompt) > MAX_PROMPT_BYTES
      || record.key !== recordKey(start) || keys.has(record.key)
      || !Number.isSafeInteger(record.expiresAt) || record.expiresAt <= 0) throw invalidRecord();
    keys.add(record.key);
    return { key: record.key, expiresAt: record.expiresAt, command: start };
  });
}

function startCommand(command) {
  if (!commandIdentity(command) || typeof command.prompt !== "string" || !command.prompt.trim()) return undefined;
  return { version: 1, client: "qoder", sessionId: command.sessionId, turnId: command.turnId,
    cwd: command.cwd, transcriptPath: command.transcriptPath, prompt: command.prompt,
    ...(command.workspaceKind === "projectless" ? { workspaceKind: "projectless" } : {}),
  };
}

function commandIdentity(command) {
  return command?.version === 1 && command.client === "qoder"
    && identity(command.sessionId) && identity(command.turnId)
    && absolutePath(command.cwd) && absolutePath(command.transcriptPath)
    && (command.workspaceKind === undefined || command.workspaceKind === "projectless");
}

function recordKey(command) {
  return createHash("sha256").update(JSON.stringify([command.sessionId, command.turnId])).digest("hex");
}

function recordPath(options) {
  if (!absolutePath(options.memoraxCodeHome)) throw invalidRecord();
  return join(options.memoraxCodeHome, "adapters", "qoder", "deferred-task-notifications.json");
}

function identity(value) {
  return typeof value === "string" && value.trim() === value && value.length > 0
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function absolutePath(value) {
  return typeof value === "string" && value.trim() && isAbsolute(value) && !value.includes("\0");
}

function invalidRecord() {
  const error = new Error("Qoder deferred notification record is invalid or full");
  error.code = "QODER_DEFERRED_NOTIFICATION_INVALID";
  return error;
}
