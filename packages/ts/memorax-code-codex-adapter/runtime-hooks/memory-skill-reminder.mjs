#!/usr/bin/env node
import {
  PERSONAL_MEMORY_REMINDER_CONTEXT,
  runMemorySkillReminderHook,
} from "../../memorax-code-adapter-common/src/hooks/memory-skill-reminder-hook.mjs";
import { resolveBackendConnection } from "../../memorax-code-adapter-common/src/backend-connection.mjs";
import { readStdinJson, stringOption } from "../../memorax-code-adapter-common/src/config-utils.mjs";
import { scheduleMissingRepoMemoryBuild } from "../../memorax-code-adapter-common/src/repo-memory/repo-memory-auto-build.mjs";
import { isRepoMemoryJobWorker } from "../../memorax-code-adapter-common/src/repo-memory/repo-memory-job-context.mjs";
import { buildRepoProcedureMemoryContext } from "../../memorax-code-adapter-common/src/repo-memory/repo-procedure-memory-context.mjs";
import { buildRepoUserProfilePreferencesContext } from "../../memorax-code-adapter-common/src/repo-memory/repo-user-profile-context.mjs";
import { resolveCodexWorkspaceKind } from "../src/workspace-kind.mjs";

if (isRepoMemoryJobWorker()) process.exit(0);

const personalMemoryContextOptions = {
  adapterDir: "codex",
  debugEnv: "MEMORAX_CODE_CODEX_HOOK_DEBUG",
  sessionKeyPrefix: "codex",
};
const RETRIEVAL_BACKEND_TIMEOUT_MS = 12_000;
const DEFAULT_BACKEND_TIMEOUT_MS = 5_000;

try {
  const input = await readStdinJson();
  const turnStart = turnStartBody(input);
  if (turnStart) {
    const turnStartResult = await recordTurnStart(turnStart);
    scheduleMissingRepoMemoryBuild(turnStartResult.repoMemoryWorktree, {
      debugEnv: "MEMORAX_CODE_CODEX_HOOK_DEBUG",
      pluginRoot: process.env.PLUGIN_ROOT,
    });
    const normalizedInput = turnStart.workspaceKind
      ? { ...input, workspaceKind: turnStart.workspaceKind }
      : input;
    await runMemorySkillReminderHook({
      additionalReminderContext: PERSONAL_MEMORY_REMINDER_CONTEXT,
      adapterDir: "codex",
      baseAdditionalContext: turnStartResult.additionalContext,
      ...(turnStartResult.repoMemoryWorktree ? {
        buildCadenceReminderContext: (hookInput) => buildRepoProcedureMemoryContext({
          ...hookInput,
          cwd: turnStartResult.repoMemoryWorktree,
        }, personalMemoryContextOptions),
        buildPersonalMemoryContext: (hookInput) => buildRepoUserProfilePreferencesContext({
          ...hookInput,
          cwd: turnStartResult.repoMemoryWorktree,
        }, personalMemoryContextOptions),
      } : {}),
      debugEnv: "MEMORAX_CODE_CODEX_HOOK_DEBUG",
      onReminder: turnStartResult.recorded ? recordReminder : undefined,
      remindOnFirstTurn: true,
      requireTranscriptPath: true,
      runtime: "codex",
      supplementalReminderAfterCompact: true,
    }, normalizedInput);
  }
} catch (error) {
  debugHookError(error);
}

function turnStartBody(input) {
  const sessionId = stringOption(input.session_id) ?? stringOption(input.sessionId);
  const prompt = stringOption(input.prompt) ?? stringOption(input.user_prompt) ?? stringOption(input.userPrompt);
  const transcriptPath = stringOption(input.transcript_path) ?? stringOption(input.transcriptPath);
  if (!sessionId || !prompt || !transcriptPath) return undefined;
  return {
    version: 1,
    client: "codex",
    sessionId,
    turnId: stringOption(input.turn_id) ?? stringOption(input.turnId),
    prompt,
    cwd: stringOption(input.cwd),
    workspaceKind: resolveCodexWorkspaceKind(input),
    transcriptPath,
  };
}

async function recordTurnStart(body) {
  try {
    const response = await postBackend("/memory/turn-start", body);
    return {
      recorded: true,
      additionalContext: stringValue(response?.additionalContext),
      repoMemoryWorktree: stringValue(response?.repoMemoryWorktree),
    };
  } catch (error) {
    debugHookError(error);
    return { recorded: false };
  }
}

async function recordReminder(reminder) {
  if (!reminder.turnId || !reminder.transcriptPath) return;
  await postBackend("/memory/skill-reminder", {
    version: 1,
    client: "codex",
    sessionId: reminder.sessionId,
    turnId: reminder.turnId,
    transcriptPath: reminder.transcriptPath,
    cwd: reminder.cwd,
    workspaceKind: reminder.workspaceKind,
    content: reminder.content,
    triggers: reminder.triggers,
  });
}

async function postBackend(path, body) {
  const connection = resolveBackendConnection();
  const timeoutMs = parsePositiveInt(
    process.env.MEMORAX_CODE_CODEX_MEMORY_HOOK_TIMEOUT_MS,
    path === "/memory/turn-start" ? RETRIEVAL_BACKEND_TIMEOUT_MS : DEFAULT_BACKEND_TIMEOUT_MS,
  );
  const headers = { "content-type": "application/json", connection: "close" };
  if (connection.token) headers["x-memorax-code-backend-token"] = connection.token;
  const response = await fetch(new URL(path, connection.url), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`Backend ${path} returned HTTP ${response.status}`);
  return await response.json().catch(() => undefined);
}

function debugHookError(error) {
  if (process.env.MEMORAX_CODE_CODEX_HOOK_DEBUG === "1") {
    console.error(error instanceof Error ? error.message : String(error));
  }
}

function parsePositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
