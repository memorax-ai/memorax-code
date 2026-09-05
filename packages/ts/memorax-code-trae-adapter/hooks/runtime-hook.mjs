#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeTraeRuntimeObservation } from "../src/runtime-observation.mjs";

const runtimeRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const commonRoot = join(runtimeRoot, "memorax-code-adapter-common", "src");
const { buildRepoProcedureMemoryContext } = await import(pathToFileURL(join(commonRoot, "repo-memory", "repo-procedure-memory-context.mjs")).href);
const { buildRepoUserProfilePreferencesContext } = await import(pathToFileURL(join(commonRoot, "repo-memory", "repo-user-profile-context.mjs")).href);
const { resolveBackendConnection } = await import(pathToFileURL(join(commonRoot, "backend-connection.mjs")).href);
const { postBackendCommand } = await import(pathToFileURL(join(commonRoot, "backend-command.mjs")).href);
const {
  atomicWriteJson,
  readJsonFile,
  withJsonFileLock,
} = await import(pathToFileURL(join(commonRoot, "config-utils.mjs")).href);
const { ensureBackendAvailable, stringValue: commonStringValue } = await import(pathToFileURL(join(commonRoot, "hooks", "ensure-backend-runner.mjs")).href);
const {
  evaluateMemorySkillReminder,
  MEMORY_IMPACT_REMINDER_CONTEXT,
  markSupplementalReminderAfterCompact,
  personalMemoryReminderContext,
} = await import(pathToFileURL(join(commonRoot, "hooks", "memory-skill-reminder-hook.mjs")).href);
const { isRepoMemoryJobWorker } = await import(pathToFileURL(join(commonRoot, "repo-memory", "repo-memory-job-context.mjs")).href);

if (isRepoMemoryJobWorker()) process.exit(0);

const MEMORY_SKILL_INVOCATION = "the `memorax-code` skill";
const REMINDER_TRACE_TIMEOUT_MS = 1000;
const input = await readJsonStdin();
const event = stringValue(input?.hook_event_name) ?? stringValue(input?.hookEventName);
const sessionId = stringValue(input?.session_id) ?? stringValue(input?.sessionId);
if (!event || !sessionId || !["SessionStart", "UserPromptSubmit", "Stop"].includes(event)) process.exit(0);

const packageMetadata = await readRecord(join(runtimeRoot, ".memorax-code-package.json"));
const home = commonStringValue(process.env.MEMORAX_CODE_HOME)
  ?? commonStringValue(packageMetadata.memoraxCodeHome)
  ?? join(homedir(), ".memorax-code");
const traeHome = commonStringValue(process.env.TRAE_CN_HOME)
  ?? commonStringValue(process.env.TRAE_HOME)
  ?? commonStringValue(packageMetadata.traeHome)
  ?? join(homedir(), ".trae-cn");
const runtimeDigest = commonStringValue(packageMetadata.runtimeDigest);
const debugEnabled = process.env.MEMORAX_CODE_TRAE_HOOK_DEBUG === "1";
if (runtimeDigest) {
  try {
    await writeTraeRuntimeObservation({ memoraxCodeHome: home, traeHome, runtimeDigest });
  } catch (error) {
    debug(error);
  }
}

const reminderOptions = {
  adapterDir: "trae",
  debugEnv: "MEMORAX_CODE_TRAE_HOOK_DEBUG",
  memoraxCodeHome: home,
  runtime: "trae",
  supplementalReminderAfterCompact: true,
};
const personalMemoryContextOptions = {
  adapterDir: "trae",
  debugEnv: "MEMORAX_CODE_TRAE_HOOK_DEBUG",
  sessionKeyPrefix: "trae",
};
const activeTurnsPath = join(home, "adapters", "trae", "active-turns.json");

await ensureBackendAvailable({
  ensureBackendValue: process.env.MEMORAX_CODE_TRAE_ENSURE_BACKEND
    ?? process.env.MEMORAX_CODE_TRAE_HOOK_ENSURE_BACKEND,
  healthTimeoutValue: process.env.MEMORAX_CODE_TRAE_ENSURE_TIMEOUT_MS,
  startTimeoutValue: process.env.MEMORAX_CODE_TRAE_START_TIMEOUT_MS,
  memoraxCodeCommand: commonStringValue(process.env.MEMORAX_CODE_TRAE_LIFECYCLE_COMMAND)
    ?? commonStringValue(process.env.MEMORAX_CODE_COMMAND),
  pluginRoot: runtimeRoot,
  resolveHomes: () => ({ memoraxCodeHome: home, traeHome }),
  buildStartArgs: (homes, recoveryArguments) => [
    "start",
    "--home", homes.memoraxCodeHome,
    "--clients", "trae",
    "--trae-home", homes.traeHome,
    ...recoveryArguments,
  ],
  debug,
}, input);

if (event === "SessionStart") {
  markSupplementalReminderAfterCompact(reminderOptions, input);
} else if (event === "UserPromptSubmit") {
  const prompt = contentValue(input.prompt);
  if (!prompt) process.exit(0);
  const cwd = stringValue(input.cwd);
  const workspaceKind = stringValue(input.workspace_kind) ?? stringValue(input.workspaceKind);
  const activeTurnPlan = prepareActiveTurn({ sessionId, prompt, cwd, workspaceKind });
  const activeTurn = activeTurnPlan.record;
  const response = await post("/memory/turn-start", {
    version: 1,
    client: "trae",
    sessionId,
    turnId: activeTurn.turnId,
    prompt,
    cwd,
    workspaceKind,
  });
  if (response?.ok !== true || !commitActiveTurn(activeTurnPlan)) process.exit(0);
  const repoMemoryWorktree = stringValue(response?.repoMemoryWorktree);
  const reminderResult = await evaluateMemorySkillReminder({
    ...reminderOptions,
    additionalReminderContext: personalMemoryReminderContext(MEMORY_SKILL_INVOCATION),
    memorySkillInvocation: MEMORY_SKILL_INVOCATION,
    remindOnFirstTurn: true,
    requireTranscriptPath: false,
    ...(repoMemoryWorktree ? {
      memoryImpactContext: MEMORY_IMPACT_REMINDER_CONTEXT,
      buildCadenceReminderContext: (hookInput) => buildRepoProcedureMemoryContext({
        ...hookInput,
        cwd: repoMemoryWorktree,
      }, personalMemoryContextOptions),
      buildPersonalMemoryContext: (hookInput) => buildRepoUserProfilePreferencesContext({
        ...hookInput,
        cwd: repoMemoryWorktree,
      }, personalMemoryContextOptions),
    } : {}),
  }, { ...input, turnId: activeTurn.turnId, workspaceKind });
  const context = [
    stringValue(response?.additionalContext),
    stringValue(reminderResult?.additionalContext),
  ].filter(Boolean).join("\n\n");
  const systemMessage = stringValue(response?.userNotice);
  if (context || systemMessage) {
    process.stdout.write(`${JSON.stringify({
      ...(systemMessage ? { systemMessage } : {}),
      ...(context ? { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context } } : {}),
    })}\n`);
  }
  if (response !== undefined && reminderResult?.reminder) await recordReminder(reminderResult.reminder);
} else {
  const lastAssistantMessage = assistantMessage(input);
  if (!lastAssistantMessage) process.exit(0);
  const activeTurn = readActiveTurn(sessionId);
  if (!activeTurn) process.exit(0);
  const response = await post("/memory/writeback", {
    version: 1,
    client: "trae",
    sessionId,
    turnId: activeTurn.turnId,
    prompt: activeTurn.prompt,
    lastAssistantMessage,
    cwd: activeTurn.cwd ?? stringValue(input.cwd),
    workspaceKind: activeTurn.workspaceKind,
  });
  if (response?.ok === true && response?.scheduled === true) removeActiveTurn(sessionId, activeTurn.turnId);
}

function prepareActiveTurn({ sessionId, prompt, cwd, workspaceKind }) {
  return withJsonFileLock(activeTurnsPath, () => {
    const state = activeTurnState();
    pruneActiveTurns(state);
    const existing = validActiveTurn(state.sessions?.[sessionId], sessionId);
    const now = Date.now();
    const record = existing
      && existing.prompt === prompt
      && existing.cwd === cwd
      && existing.workspaceKind === workspaceKind
      ? { ...existing, updatedAt: now }
      : {
          version: 1,
          sessionId,
          turnId: createTraeTurnId(sessionId, now, prompt),
          prompt,
          ...(cwd ? { cwd } : {}),
          ...(workspaceKind ? { workspaceKind } : {}),
          createdAt: now,
          updatedAt: now,
        };
    return { record, expectedTurnId: existing?.turnId };
  });
}

function commitActiveTurn({ record, expectedTurnId }) {
  return withJsonFileLock(activeTurnsPath, () => {
    const state = activeTurnState();
    pruneActiveTurns(state);
    const current = validActiveTurn(state.sessions?.[record.sessionId], record.sessionId);
    if (current?.turnId !== expectedTurnId && current?.turnId !== record.turnId) return false;
    state.sessions[record.sessionId] = record;
    const now = Date.now();
    state.updatedAt = new Date(now).toISOString();
    pruneActiveTurns(state);
    atomicWriteJson(activeTurnsPath, state);
    return true;
  });
}

function readActiveTurn(sessionId) {
  return withJsonFileLock(activeTurnsPath, () => {
    const state = activeTurnState();
    pruneActiveTurns(state);
    atomicWriteJson(activeTurnsPath, state);
    return validActiveTurn(state.sessions[sessionId], sessionId);
  });
}

function removeActiveTurn(sessionId, turnId) {
  withJsonFileLock(activeTurnsPath, () => {
    const state = activeTurnState();
    if (state.sessions?.[sessionId]?.turnId === turnId) delete state.sessions[sessionId];
    state.updatedAt = new Date().toISOString();
    atomicWriteJson(activeTurnsPath, state);
  });
}

function activeTurnState() {
  const value = readJsonFile(activeTurnsPath);
  if (value?.unreadable) return { version: 1, runtime: "trae", sessions: {} };
  const state = value?.value;
  if (!isRecord(state) || state.version !== 1 || state.runtime !== "trae" || !isRecord(state.sessions)) {
    return { version: 1, runtime: "trae", sessions: {} };
  }
  return state;
}

function pruneActiveTurns(state) {
  const now = Date.now();
  for (const [id, record] of Object.entries(state.sessions)) {
    const valid = validActiveTurn(record, id);
    if (!valid || now - valid.updatedAt > 24 * 60 * 60 * 1000) delete state.sessions[id];
  }
  const ordered = Object.entries(state.sessions)
    .sort(([, left], [, right]) => Number(left.updatedAt ?? 0) - Number(right.updatedAt ?? 0));
  while (ordered.length > 200) {
    const [id] = ordered.shift();
    delete state.sessions[id];
  }
}

function validActiveTurn(value, sessionId) {
  if (!isRecord(value)
    || value.version !== 1
    || value.sessionId !== sessionId
    || !validTraeTurnId(sessionId, value.turnId, value.prompt)
    || !contentValue(value.prompt)
    || !Number.isSafeInteger(value.createdAt)
    || !Number.isSafeInteger(value.updatedAt)) return undefined;
  return value;
}

function createTraeTurnId(sessionId, createdAt, prompt) {
  const digest = createHash("sha256").update(prompt.trim()).digest("hex");
  return `${sessionId}:${createdAt}:${digest}`;
}

function validTraeTurnId(sessionId, turnId, prompt) {
  if (typeof turnId !== "string" || !turnId.startsWith(`${sessionId}:`)) return false;
  const match = /^([1-9]\d*):([a-f0-9]{64})$/.exec(turnId.slice(sessionId.length + 1));
  return Boolean(match
    && Number.isSafeInteger(Number(match[1]))
    && match[2] === createHash("sha256").update(String(prompt).trim()).digest("hex"));
}

async function recordReminder(reminder) {
  if (!reminder.turnId) return;
  await post("/memory/skill-reminder", {
    version: 1,
    client: "trae",
    sessionId: reminder.sessionId,
    turnId: reminder.turnId,
    cwd: reminder.cwd,
    workspaceKind: reminder.workspaceKind,
    content: reminder.content,
    triggers: reminder.triggers,
  }, REMINDER_TRACE_TIMEOUT_MS);
}

async function post(path, body, timeoutMs = 12_000) {
  let connection;
  try {
    connection = resolveBackendConnection({ memoraxCodeHome: home });
  } catch (error) {
    debug(error);
    return undefined;
  }
  try {
    const response = await postBackendCommand({ connection, path, body, timeoutMs });
    return response.ok ? await response.json().catch(() => undefined) : undefined;
  } catch {
    return undefined;
  }
}

function assistantMessage(value) {
  const last = contentValue(value.last_assistant_message) ?? contentValue(value.lastAssistantMessage);
  const text = contentValue(value.text_content) ?? contentValue(value.textContent);
  if (last && text && last !== text) {
    debug(new Error("Trae Stop payload assistant fields do not match"));
    return undefined;
  }
  return last ?? text;
}

async function readJsonStdin() {
  try {
    let text = "";
    for await (const chunk of process.stdin) text += chunk;
    return JSON.parse(text);
  } catch {
    return {};
  }
}

async function readRecord(path) {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}

function contentValue(value) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function debug(error) {
  if (debugEnabled) console.error(error instanceof Error ? error.message : String(error));
}
