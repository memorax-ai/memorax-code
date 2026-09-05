#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { resolveCommonSourceRoot } from "./common-runtime.mjs";
import { readPending, updatePending } from "./pending-state.mjs";
import { writeCodeBuddyRuntimeObservation } from "../src/runtime-observation.mjs";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const commonRoot = resolveCommonSourceRoot(pluginRoot);
const { scheduleMissingRepoMemoryBuild } = await import(pathToFileURL(join(commonRoot, "repo-memory", "repo-memory-auto-build.mjs")).href);
const { isRepoMemoryJobWorker } = await import(pathToFileURL(join(commonRoot, "repo-memory", "repo-memory-job-context.mjs")).href);
const { buildRepoProcedureMemoryContext } = await import(pathToFileURL(join(commonRoot, "repo-memory", "repo-procedure-memory-context.mjs")).href);
const { buildRepoUserProfilePreferencesContext } = await import(pathToFileURL(join(commonRoot, "repo-memory", "repo-user-profile-context.mjs")).href);
const { resolveBackendConnection } = await import(pathToFileURL(join(commonRoot, "backend-connection.mjs")).href);
const { postBackendCommand } = await import(pathToFileURL(join(commonRoot, "backend-command.mjs")).href);
const { ensureBackendAvailable, stringValue: commonStringValue } = await import(pathToFileURL(join(commonRoot, "hooks", "ensure-backend-runner.mjs")).href);
const {
  evaluateMemorySkillReminder,
  MEMORY_IMPACT_REMINDER_CONTEXT,
  markSupplementalReminderAfterCompact,
  personalMemoryReminderContext,
} = await import(pathToFileURL(join(commonRoot, "hooks", "memory-skill-reminder-hook.mjs")).href);

if (isRepoMemoryJobWorker()) process.exit(0);

const MEMORY_SKILL_INVOCATION = "the `memorax-code` skill";
const REMINDER_TRACE_TIMEOUT_MS = 1000;

const input = await readJsonStdin();
const event = stringValue(input?.hook_event_name) ?? stringValue(input?.hookEventName);
const sessionId = stringValue(input?.session_id) ?? stringValue(input?.sessionId);
const transcriptPath = stringValue(input?.transcript_path) ?? stringValue(input?.transcriptPath);
if (!event || !sessionId || !transcriptPath) process.exit(0);
const home = process.env.MEMORAX_CODE_HOME?.trim() || join(homedir(), ".memorax-code");
const packageMetadata = await readRecord(join(pluginRoot, ".memorax-code-package.json"));
const codeBuddyHome = commonStringValue(process.env.CODEBUDDY_HOME)
  ?? commonStringValue(process.env.WORKBUDDY_HOME)
  ?? commonStringValue(packageMetadata.codeBuddyHome)
  ?? commonStringValue(input?.codebuddy_home)
  ?? commonStringValue(input?.codeBuddyHome)
  ?? defaultCodeBuddyHome();
try {
  await writeCodeBuddyRuntimeObservation({ memoraxCodeHome: home, codeBuddyHome, pluginRoot });
} catch (error) {
  if (process.env.MEMORAX_CODE_CODEBUDDY_HOOK_DEBUG === "1") {
    console.error(error instanceof Error ? error.message : String(error));
  }
}
const pendingPath = join(home, "adapters", "codebuddy", "pending.json");
const reminderOptions = {
  adapterDir: "codebuddy",
  debugEnv: "MEMORAX_CODE_CODEBUDDY_HOOK_DEBUG",
  memoraxCodeHome: home,
  runtime: "codebuddy",
  supplementalReminderAfterCompact: true,
};
const personalMemoryContextOptions = {
  adapterDir: "codebuddy",
  debugEnv: "MEMORAX_CODE_CODEBUDDY_HOOK_DEBUG",
  sessionKeyPrefix: "codebuddy",
};
if (event === "SessionStart") await bindMemoryCliTraceSession(sessionId);
await ensureBackendAvailable({
  ensureBackendValue: process.env.MEMORAX_CODE_CODEBUDDY_ENSURE_BACKEND
    ?? process.env.MEMORAX_CODE_CODEBUDDY_HOOK_ENSURE_BACKEND,
  healthTimeoutValue: process.env.MEMORAX_CODE_CODEBUDDY_ENSURE_TIMEOUT_MS,
  startTimeoutValue: process.env.MEMORAX_CODE_CODEBUDDY_START_TIMEOUT_MS,
  memoraxCodeCommand: commonStringValue(process.env.MEMORAX_CODE_CODEBUDDY_LIFECYCLE_COMMAND)
    ?? commonStringValue(process.env.MEMORAX_CODE_COMMAND),
  pluginRoot,
  resolveHomes: () => ({
    memoraxCodeHome: home,
    codeBuddyHome,
  }),
  buildStartArgs: (homes, recoveryArguments) => [
    "start",
    "--home", homes.memoraxCodeHome,
    "--clients", "codebuddy",
    "--codebuddy-home", homes.codeBuddyHome,
    ...recoveryArguments,
  ],
  debug: (message) => { if (process.env.MEMORAX_CODE_CODEBUDDY_HOOK_DEBUG === "1") console.error(message); },
}, input);
if (event === "SessionStart") {
  markSupplementalReminderAfterCompact(reminderOptions, input);
} else if (event === "UserPromptSubmit") {
  const prompt = stringValue(input.prompt);
  if (!prompt) process.exit(0);
  const boundary = await fileBoundary(transcriptPath);
  const turnId = provisionalTurnId(sessionId, boundary, prompt);
  const workspaceKind = stringValue(input.workspace_kind) ?? stringValue(input.workspaceKind);
  await updatePending(pendingPath, (state) => {
    const now = Date.now();
    const existing = state[sessionId];
    state[sessionId] = {
      version: 1,
      turnId,
      transcriptPath,
      cwd: stringValue(input.cwd),
      workspaceKind,
      createdAt: existing?.turnId === turnId ? existing.createdAt : now,
      updatedAt: now,
    };
  });
  const response = await post("/memory/turn-start", { version: 1, client: "codebuddy", sessionId, turnId, transcriptPath, prompt, cwd: stringValue(input.cwd), workspaceKind });
  const repoMemoryWorktree = stringValue(response?.repoMemoryWorktree);
  scheduleMissingRepoMemoryBuild(repoMemoryWorktree, {
    debugEnv: "MEMORAX_CODE_CODEBUDDY_HOOK_DEBUG",
    pluginRoot,
  });
  const reminderResult = await evaluateMemorySkillReminder({
    ...reminderOptions,
    additionalReminderContext: personalMemoryReminderContext(MEMORY_SKILL_INVOCATION),
    memorySkillInvocation: MEMORY_SKILL_INVOCATION,
    remindOnFirstTurn: true,
    requireTranscriptPath: true,
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
  }, { ...input, turnId, workspaceKind });
  const context = [
    stringValue(response?.additionalContext),
    stringValue(reminderResult?.additionalContext),
  ].filter(Boolean).join("\n\n");
  const systemMessage = stringValue(response?.userNotice);
  if (context || systemMessage) process.stdout.write(`${JSON.stringify({
    ...(systemMessage ? { systemMessage } : {}),
    ...(context ? { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context } } : {}),
  })}\n`);
  if (response !== undefined && reminderResult?.reminder) await recordReminder(reminderResult.reminder);
} else if (event === "Stop") {
  const record = (await readPending(pendingPath))[sessionId];
  if (!record || record.transcriptPath !== transcriptPath) process.exit(0);
  const response = await post("/memory/writeback", { version: 1, client: "codebuddy", sessionId, turnId: record.turnId, transcriptPath, cwd: record.cwd ?? stringValue(input.cwd), workspaceKind: record.workspaceKind ?? stringValue(input.workspaceKind) });
  if (response?.ok === true && response?.scheduled === true) {
    await updatePending(pendingPath, (state) => {
      if (state[sessionId]?.turnId === record.turnId) delete state[sessionId];
    });
  }
}

async function recordReminder(reminder) {
  if (!reminder.turnId || !reminder.transcriptPath) return;
  await post("/memory/skill-reminder", {
    version: 1,
    client: "codebuddy",
    sessionId: reminder.sessionId,
    turnId: reminder.turnId,
    transcriptPath: reminder.transcriptPath,
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
    if (process.env.MEMORAX_CODE_CODEBUDDY_HOOK_DEBUG === "1") console.error(error instanceof Error ? error.message : String(error));
    return undefined;
  }
  try {
    const response = await postBackendCommand({ connection, path, body, timeoutMs });
    return response.ok ? await response.json().catch(() => undefined) : undefined;
  } catch {
    return undefined;
  }
}
async function fileBoundary(path) { try { return (await stat(path)).size; } catch { return 0; } }
async function readJsonStdin() { try { let text = ""; for await (const chunk of process.stdin) text += chunk; return JSON.parse(text); } catch { return {}; } }
async function readRecord(path) { try { const value = JSON.parse(await readFile(path, "utf8")); return value && typeof value === "object" && !Array.isArray(value) ? value : {}; } catch { return {}; } }
async function bindMemoryCliTraceSession(sessionId) {
  const envFile = stringValue(process.env.CODEBUDDY_ENV_FILE);
  if (!envFile) return;
  try {
    await appendFile(envFile, [
      "export MEMORAX_CODE_MEMORY_CLI_TRACE_CLIENT='codebuddy'",
      `export MEMORAX_CODE_MEMORY_CLI_TRACE_SESSION_ID=${shellSingleQuote(sessionId)}`,
      "",
    ].join("\n"), "utf8");
  } catch (error) {
    if (process.env.MEMORAX_CODE_CODEBUDDY_HOOK_DEBUG === "1") {
      console.error(error instanceof Error ? error.message : String(error));
    }
  }
}
function shellSingleQuote(value) { return `'${value.replaceAll("'", "'\"'\"'")}'`; }
function stringValue(value) { return typeof value === "string" && value.trim() ? value.trim() : undefined; }

function defaultCodeBuddyHome() {
  const workBuddyHome = join(homedir(), ".workbuddy");
  if (process.platform !== "win32") return workBuddyHome;
  const legacyCodeBuddyHome = join(homedir(), ".codebuddy");
  return existsSync(workBuddyHome) || !existsSync(legacyCodeBuddyHome)
    ? workBuddyHome
    : legacyCodeBuddyHome;
}

function provisionalTurnId(sessionId, boundary, prompt) {
  return `${sessionId}:${boundary}:${createHash("sha256").update(prompt.trim()).digest("hex")}`;
}
