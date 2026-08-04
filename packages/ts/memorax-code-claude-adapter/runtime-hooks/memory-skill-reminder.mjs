#!/usr/bin/env node
import {
  personalMemoryReminderContext,
  runMemorySkillReminderHook,
} from "../../memorax-code-adapter-common/src/hooks/memory-skill-reminder-hook.mjs";
import { resolveBackendConnection } from "../../memorax-code-adapter-common/src/backend-connection.mjs";
import { readStdinJson } from "../../memorax-code-adapter-common/src/config-utils.mjs";
import { scheduleMissingRepoMemoryBuild } from "../../memorax-code-adapter-common/src/repo-memory/repo-memory-auto-build.mjs";
import { isRepoMemoryJobWorker } from "../../memorax-code-adapter-common/src/repo-memory/repo-memory-job-context.mjs";
import { buildRepoProcedureMemoryContext } from "../../memorax-code-adapter-common/src/repo-memory/repo-procedure-memory-context.mjs";
import { buildRepoUserProfilePreferencesContext } from "../../memorax-code-adapter-common/src/repo-memory/repo-user-profile-context.mjs";

const MAX_REMINDER_TRACE_TIMEOUT_MS = 1000;
const MEMORY_SKILL_INVOCATION = "/memorax-code-claude-adapter:memorax-code";

if (isRepoMemoryJobWorker()) process.exit(0);

const personalMemoryContextOptions = {
  adapterDir: "claude-code",
  debugEnv: "MEMORAX_CODE_CLAUDE_HOOK_DEBUG",
  sessionKeyPrefix: "claude",
};

const input = await readStdinJson();
scheduleMissingRepoMemoryBuild(input, {
  adapterDir: "claude-code",
  debugEnv: "MEMORAX_CODE_CLAUDE_HOOK_DEBUG",
  pluginRoot: process.env.CLAUDE_PLUGIN_ROOT,
  sessionKeyPrefix: "claude",
});

await runMemorySkillReminderHook({
  additionalReminderContext: personalMemoryReminderContext(MEMORY_SKILL_INVOCATION),
  adapterDir: "claude-code",
  buildCadenceReminderContext: (hookInput) => buildRepoProcedureMemoryContext(hookInput, personalMemoryContextOptions),
  buildPersonalMemoryContext: (hookInput) => buildRepoUserProfilePreferencesContext(hookInput, personalMemoryContextOptions),
  debugEnv: "MEMORAX_CODE_CLAUDE_HOOK_DEBUG",
  memorySkillInvocation: MEMORY_SKILL_INVOCATION,
  onReminder: recordReminder,
  remindOnFirstTurn: true,
  runtime: "claude-code",
  supplementalReminderAfterCompact: true,
}, input);

async function recordReminder(reminder) {
  const promptId = reminder.turnId;
  if (!promptId || !reminder.transcriptPath) return;
  const connection = resolveBackendConnection();
  const timeoutMs = Math.min(
    parsePositiveInt(
      process.env.MEMORAX_CODE_CLAUDE_MEMORY_HOOK_TIMEOUT_MS,
      MAX_REMINDER_TRACE_TIMEOUT_MS,
    ),
    MAX_REMINDER_TRACE_TIMEOUT_MS,
  );
  const headers = { "content-type": "application/json", connection: "close" };
  if (connection.token) headers["x-memorax-code-backend-token"] = connection.token;
  const response = await fetch(new URL("/memory/skill-reminder", connection.url), {
    method: "POST",
    headers,
    body: JSON.stringify({
      version: 1,
      client: "claude-code",
      sessionId: reminder.sessionId,
      promptId,
      transcriptPath: reminder.transcriptPath,
      cwd: reminder.cwd,
      workspaceKind: reminder.workspaceKind,
      content: reminder.content,
      triggers: reminder.triggers,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    await response.arrayBuffer().catch(() => undefined);
    throw new Error(`Backend /memory/skill-reminder returned HTTP ${response.status}`);
  }
}

function parsePositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
