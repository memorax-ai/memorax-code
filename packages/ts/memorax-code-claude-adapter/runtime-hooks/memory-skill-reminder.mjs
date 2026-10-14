#!/usr/bin/env node
import {
  MEMORY_IMPACT_REMINDER_CONTEXT,
  personalMemoryReminderContext,
  runMemorySkillReminderHook,
} from "../../memorax-code-adapter-common/src/hooks/memory-skill-reminder-hook.mjs";
import { postBackendCommand } from "../../memorax-code-adapter-common/src/backend-command.mjs";
import { requestMemorySearchGuidance } from "../../memorax-code-adapter-common/src/hooks/memory-search-guidance.mjs";
import { readStdinJson, stringOption } from "../../memorax-code-adapter-common/src/config-utils.mjs";
import { resolveBackendConnection } from "../../memorax-code-adapter-common/src/backend-connection.mjs";
import { scheduleMissingRepoMemoryBuild } from "../../memorax-code-adapter-common/src/repo-memory/repo-memory-auto-build.mjs";
import { isRepoMemoryJobWorker } from "../../memorax-code-adapter-common/src/repo-memory/repo-memory-job-context.mjs";
import { buildProcedureMemoryContext } from "../../memorax-code-adapter-common/src/personal-memory/procedure-memory-context.mjs";
import { buildUserProfilePreferencesContext } from "../../memorax-code-adapter-common/src/personal-memory/user-profile-context.mjs";

const MAX_REMINDER_TRACE_TIMEOUT_MS = 1000;
const MEMORY_SKILL_INVOCATION = "/memorax-code-claude-adapter:memorax-code";

if (isRepoMemoryJobWorker()) process.exit(0);

const personalMemoryContextOptions = {
  adapterDir: "claude-code",
  debugEnv: "MEMORAX_CODE_CLAUDE_HOOK_DEBUG",
  sessionKeyPrefix: "claude",
};

const input = await readStdinJson();
const turnStart = turnStartCommand(input);
const registered = turnStart ? await registerTurnStart(turnStart) : undefined;

await runMemorySkillReminderHook({
  additionalReminderContext: personalMemoryReminderContext(MEMORY_SKILL_INVOCATION),
  adapterDir: "claude-code",
  buildCadenceReminderContext: () => buildProcedureMemoryContext(personalMemoryContextOptions),
  buildPersonalMemoryContext: () => buildUserProfilePreferencesContext(personalMemoryContextOptions),
  debugEnv: "MEMORAX_CODE_CLAUDE_HOOK_DEBUG",
  memoryImpactContext: MEMORY_IMPACT_REMINDER_CONTEXT,
  memorySkillInvocation: MEMORY_SKILL_INVOCATION,
  onReminder: registered ? recordReminder : undefined,
  evaluateSearchGuidance: registered ? () => requestMemorySearchGuidance({ body: turnStart }) : undefined,
  systemMessage: registered?.userNotice,
  remindOnFirstTurn: true,
  runtime: "claude-code",
  supplementalReminderAfterCompact: true,
}, input);

function turnStartCommand(input) {
  const sessionId = stringOption(input.session_id) ?? stringOption(input.sessionId);
  const promptId = stringOption(input.prompt_id) ?? stringOption(input.promptId);
  const transcriptPath = stringOption(input.transcript_path) ?? stringOption(input.transcriptPath);
  const prompt = stringOption(input.prompt);
  if (!sessionId || !promptId || !transcriptPath || !prompt) return undefined;
  return {
    version: 1, client: "claude-code", sessionId, promptId, transcriptPath, prompt,
    cwd: stringOption(input.cwd),
    workspaceKind: stringOption(input.workspace_kind) ?? stringOption(input.workspaceKind),
  };
}

async function registerTurnStart(body) {
  try {
    const response = await postBackendCommand({
      connection: resolveBackendConnection(), path: "/memory/turn-start", body,
      timeoutMs: parsePositiveInt(process.env.MEMORAX_CODE_CLAUDE_MEMORY_HOOK_TIMEOUT_MS, 12_000),
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      return undefined;
    }
    const result = await response.json();
    if (result?.ok !== true) return undefined;
    scheduleMissingRepoMemoryBuild(stringOption(result.repoMemoryWorktree), {
      debugEnv: "MEMORAX_CODE_CLAUDE_HOOK_DEBUG", pluginRoot: process.env.CLAUDE_PLUGIN_ROOT,
    });
    return result;
  } catch { return undefined; }
}

async function recordReminder(reminder) {
  const promptId = reminder.turnId;
  if (!promptId || !reminder.transcriptPath) return;
  const connection = resolveBackendConnection();
  // Optional trace recording must not hold up the reminder for the full memory
  // request timeout; the shared runner still emits context when recording fails.
  const timeoutMs = Math.min(
    parsePositiveInt(
      process.env.MEMORAX_CODE_CLAUDE_MEMORY_HOOK_TIMEOUT_MS,
      MAX_REMINDER_TRACE_TIMEOUT_MS,
    ),
    MAX_REMINDER_TRACE_TIMEOUT_MS,
  );
  const response = await postBackendCommand({
    connection,
    path: "/memory/skill-reminder",
    body: {
      version: 1,
      client: "claude-code",
      sessionId: reminder.sessionId,
      promptId,
      transcriptPath: reminder.transcriptPath,
      cwd: reminder.cwd,
      workspaceKind: reminder.workspaceKind,
      content: reminder.content,
      triggers: reminder.triggers,
    },
    timeoutMs,
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
