import { lstatSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveCommonSourceRoot } from "./common-runtime.mjs";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const commonRoot = resolveCommonSourceRoot(pluginRoot);
const { withJsonFileLockAsync } = await import(pathToFileURL(join(commonRoot, "config-utils.mjs")).href);
const { readJsonRuntimeRecord, writePrivateJsonRecord } = await import(pathToFileURL(join(commonRoot, "runtime-record.mjs")).href);

export async function readPending(path) {
  return withPendingLock(path, () => {
    const state = readJsonRuntimeRecord(path).value ?? {};
    prunePendingState(state);
    writePrivateJsonRecord(path, state, { durableBoundary: dirname(path) });
    return state;
  });
}

export async function updatePending(path, mutate) {
  await withPendingLock(path, () => {
    const state = readJsonRuntimeRecord(path).value ?? {};
    prunePendingState(state);
    mutate(state);
    prunePendingState(state);
    writePrivateJsonRecord(path, state, { durableBoundary: dirname(path) });
  });
}

async function withPendingLock(path, operation) {
  try {
    // Keep the legacy lock path: an older Hook's directory blocks acquisition
    // until that Hook releases it. Its age cannot prove that its owner is dead.
    return await withJsonFileLockAsync(path, operation);
  } catch (error) {
    if (error?.code === "JSON_FILE_LOCK_TIMEOUT") {
      let legacyDirectory = false;
      try { legacyDirectory = lstatSync(error.lockPath).isDirectory(); } catch {}
      if (legacyDirectory) {
        error.message += "; legacy CodeBuddy Hook directory lock remains; wait for older Hook processes to finish before removing this directory";
      }
    }
    throw error;
  }
}

function validProvisionalTurnId(sessionId, turnId) {
  const prefix = `${sessionId}:`;
  if (typeof turnId !== "string" || !turnId.startsWith(prefix)) return false;
  const match = /^(0|[1-9]\d*):[0-9a-f]{64}$/.exec(turnId.slice(prefix.length));
  return Boolean(match && Number.isSafeInteger(Number(match[1])));
}

function prunePendingState(state) {
  const now = Date.now();
  const ttl = positiveInteger(process.env.MEMORAX_CODE_CODEBUDDY_PENDING_TTL_MS, 24 * 60 * 60 * 1000);
  const maxEntries = positiveInteger(process.env.MEMORAX_CODE_CODEBUDDY_PENDING_MAX_ENTRIES, 200);
  for (const [sessionId, record] of Object.entries(state)) {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      delete state[sessionId];
      continue;
    }
    if (record.version !== 1 || !validProvisionalTurnId(sessionId, record.turnId) || !stringValue(record.transcriptPath)) {
      delete state[sessionId];
      continue;
    }
    if (!Number.isFinite(record.createdAt) || !Number.isFinite(record.updatedAt) || now - record.updatedAt > ttl) {
      delete state[sessionId];
    }
  }
  const entries = Object.entries(state).sort(([, left], [, right]) => Number(left.updatedAt ?? left.createdAt ?? 0) - Number(right.updatedAt ?? right.createdAt ?? 0));
  while (entries.length > maxEntries) {
    const [sessionId] = entries.shift();
    delete state[sessionId];
  }
}

function stringValue(value) { return typeof value === "string" && value.trim() ? value.trim() : undefined; }

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
