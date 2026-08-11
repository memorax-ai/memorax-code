import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  atomicWriteJson,
  readJsonFile,
  readStdinJson,
  stringOption,
  withJsonFileLock,
} from "../config-utils.mjs";

const DEFAULT_REMINDER_INTERVAL_TURNS = 5;
const DEFAULT_MEMORY_SKILL_INVOCATION = "$memorax-code";
export const PERSONAL_MEMORY_REMINDER_CONTEXT = personalMemoryReminderContext();

export function personalMemoryReminderContext(memorySkillInvocation) {
  const invocation = stringOption(memorySkillInvocation) ?? DEFAULT_MEMORY_SKILL_INVOCATION;
  return [
    `MemoraX Code personal-memory reminder: Use ${invocation} when the user states a durable current-repo identity or interaction preference, asks to list or recall stored personal memory, or explicitly asks to save, update, forget, or delete it.`,
    "Route reusable action sequences and work rules to procedure memory; do not store repository facts, one-off task details, or secrets.",
  ].join(" ");
}

export async function runMemorySkillReminderHook(options, hookInput) {
  try {
    const input = hookInput ?? await readStdinJson();
    const result = await evaluateMemorySkillReminder(options, input);
    if (!result) return;
    process.stdout.write(`${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: result.additionalContext,
      },
    })}\n`);
    if (result.reminder) await notifyReminder(options, result.reminder);
  } catch (error) {
    debugError(options, error);
  }
}

export async function evaluateMemorySkillReminder(options, input) {
  try {
    const sessionId = stringOption(input.session_id) ?? stringOption(input.sessionId);
    if (!sessionId) return undefined;
    const transcriptPath = stringOption(input.transcript_path) ?? stringOption(input.transcriptPath);
    if (options.requireTranscriptPath && !transcriptPath) return undefined;
    const hookEventName = stringOption(input.hook_event_name) ?? stringOption(input.hookEventName) ?? "UserPromptSubmit";
    if (hookEventName !== "UserPromptSubmit") return undefined;

    const memoraxCodeHome = resolveMemoraxCodeHome(options);
    const statePath = join(memoraxCodeHome, "adapters", options.adapterDir, "memory-skill-reminders.json");
    const turnId = stringOption(input.turn_id)
      ?? stringOption(input.turnId)
      ?? stringOption(input.prompt_id)
      ?? stringOption(input.promptId);
    const intervalTurns = reminderIntervalTurns(memoraxCodeHome);
    const update = withJsonFileLock(statePath, () => {
      const existing = readJsonFile(statePath);
      const next = nextReminderState(
        existing?.unreadable ? undefined : existing?.value,
        options.runtime,
        sessionId,
        turnId,
      );
      if (next.duplicate) return next;
      const sessionState = next.state.sessions[sessionId];
      const memoryReminderDue = shouldRemind(
        sessionState?.turnCount,
        intervalTurns,
        options.remindOnFirstTurn !== false,
      );
      const supplementalReminderDue = options.supplementalReminderAfterCompact === true
        && sessionState?.supplementalReminderPending === true;
      if (supplementalReminderDue) sessionState.supplementalReminderPending = false;
      atomicWriteJson(statePath, next.state);
      return {
        ...next,
        memoryReminderDue,
        supplementalReminderDue,
        turnCount: sessionState?.turnCount,
      };
    });
    if (update.duplicate) return undefined;
    const { memoryReminderDue, supplementalReminderDue } = update;

    const baseAdditionalContext = stringOption(options.baseAdditionalContext);
    if (!baseAdditionalContext && !memoryReminderDue && !supplementalReminderDue) return undefined;
    const cadenceReminderContext = memoryReminderDue
      ? await buildCadenceReminderContext(options, input)
      : undefined;
    const personalMemoryContext = supplementalReminderDue || (memoryReminderDue && update.turnCount === 1)
      ? await buildPersonalMemoryContext(options, input)
      : undefined;
    const reminderContext = stringOption(combinedReminderContext(options, {
      memoryReminderDue,
      supplementalReminderDue,
    }, cadenceReminderContext, personalMemoryContext));
    const additionalContext = [baseAdditionalContext, reminderContext].filter(Boolean).join("\n\n");
    const triggers = [
      ...(memoryReminderDue ? ["cadence"] : []),
      ...(supplementalReminderDue ? ["post_compaction"] : []),
    ];
    return {
      additionalContext,
      ...(reminderContext ? {
        reminder: {
          sessionId,
          turnId,
          transcriptPath,
          cwd: stringOption(input.cwd),
          workspaceKind: stringOption(input.workspace_kind) ?? stringOption(input.workspaceKind),
          content: reminderContext,
          triggers,
        },
      } : {}),
    };
  } catch (error) {
    debugError(options, error);
    return undefined;
  }
}

async function notifyReminder(options, reminder) {
  if (typeof options.onReminder !== "function") return;
  try {
    await options.onReminder(reminder);
  } catch (error) {
    if (process.env[options.debugEnv] === "1") {
      console.error(error instanceof Error ? error.message : String(error));
    }
  }
}

export function markSupplementalReminderAfterCompact(options, input) {
  try {
    const hookEventName = stringOption(input.hook_event_name) ?? stringOption(input.hookEventName);
    if (hookEventName !== "SessionStart" || stringOption(input.source) !== "compact") return;
    const sessionId = stringOption(input.session_id) ?? stringOption(input.sessionId);
    markSupplementalReminderForSession(options, sessionId);
  } catch (error) {
    debugError(options, error);
  }
}

export function markSupplementalReminderForSession(options, sessionId) {
  try {
    const normalizedSessionId = stringOption(sessionId);
    if (!normalizedSessionId) return;
    const memoraxCodeHome = resolveMemoraxCodeHome(options);
    const statePath = join(memoraxCodeHome, "adapters", options.adapterDir, "memory-skill-reminders.json");
    withJsonFileLock(statePath, () => {
      const existing = readJsonFile(statePath);
      atomicWriteJson(statePath, markSupplementalReminderPending(
        existing?.unreadable ? undefined : existing?.value,
        options.runtime,
        normalizedSessionId,
      ));
    });
  } catch (error) {
    debugError(options, error);
  }
}

async function buildCadenceReminderContext(options, input) {
  if (typeof options.buildCadenceReminderContext !== "function") return undefined;
  try {
    return stringOption(await options.buildCadenceReminderContext(input));
  } catch (error) {
    if (process.env[options.debugEnv] === "1") {
      console.error(error instanceof Error ? error.message : String(error));
    }
    return undefined;
  }
}

async function buildPersonalMemoryContext(options, input) {
  if (typeof options.buildPersonalMemoryContext !== "function") return undefined;
  try {
    return stringOption(await options.buildPersonalMemoryContext(input));
  } catch (error) {
    if (process.env[options.debugEnv] === "1") {
      console.error(error instanceof Error ? error.message : String(error));
    }
    return undefined;
  }
}

function combinedReminderContext(options, due, cadenceReminderContext, personalMemoryContext) {
  const contexts = [];
  if (due.memoryReminderDue) contexts.push(memoryReminderContext(options));
  if (due.supplementalReminderDue || personalMemoryContext) {
    const additionalReminderContext = stringOption(options.additionalReminderContext);
    if (additionalReminderContext) contexts.push(additionalReminderContext);
  }
  if (personalMemoryContext) contexts.push(personalMemoryContext);
  if (due.memoryReminderDue && cadenceReminderContext) contexts.push(cadenceReminderContext);

  return contexts.join("\n\n");
}

function memoryReminderContext(options) {
  const invocation = stringOption(options.memorySkillInvocation) ?? DEFAULT_MEMORY_SKILL_INVOCATION;
  return `MemoraX Code reminder: proactively invoke ${invocation} whenever coding memory might help, even when uncertain; follow the skill's router to decide whether any memory operation is needed. Also use ${invocation} for repository-scoped personal memory, and classify the authority before reading or writing.`;
}

function defaultMemoraxCodeHome() {
  return process.env.HOME ? join(process.env.HOME, ".memorax-code") : ".memorax-code";
}

function resolveMemoraxCodeHome(options) {
  return stringOption(options.memoraxCodeHome)
    ?? process.env.MEMORAX_CODE_HOME
    ?? defaultMemoraxCodeHome();
}

function debugError(options, error) {
  if (process.env[options.debugEnv] === "1") {
    console.error(error instanceof Error ? error.message : String(error));
  }
}

function nextReminderState(existing, runtime, sessionId, turnId) {
  const state = reminderState(existing, runtime);
  const current = state.sessions[sessionId] && typeof state.sessions[sessionId] === "object" && !Array.isArray(state.sessions[sessionId])
    ? state.sessions[sessionId]
    : {};
  if (turnId && current.lastTurnId === turnId) return { state, duplicate: true };
  const currentCount = Number.isInteger(current.turnCount) && current.turnCount >= 0 ? current.turnCount : 0;
  state.sessions[sessionId] = {
    ...current,
    turnCount: currentCount + 1,
    ...(turnId ? { lastTurnId: turnId } : {}),
    lastSeenAt: state.updatedAt,
  };
  return { state, duplicate: false };
}

function markSupplementalReminderPending(existing, runtime, sessionId) {
  const state = reminderState(existing, runtime);
  const current = state.sessions[sessionId] && typeof state.sessions[sessionId] === "object" && !Array.isArray(state.sessions[sessionId])
    ? state.sessions[sessionId]
    : {};
  state.sessions[sessionId] = {
    ...current,
    supplementalReminderPending: true,
    lastSeenAt: state.updatedAt,
  };
  return state;
}

function reminderState(existing, runtime) {
  const state = existing && typeof existing === "object" && !Array.isArray(existing)
    ? existing
    : { version: 1, runtime, sessions: {} };
  state.version = 1;
  state.runtime = runtime;
  state.updatedAt = new Date().toISOString();
  state.sessions = state.sessions && typeof state.sessions === "object" && !Array.isArray(state.sessions)
    ? state.sessions
    : {};
  return state;
}

function shouldRemind(turnCount, intervalTurns, remindOnFirstTurn) {
  if (!Number.isInteger(turnCount) || turnCount <= 0) return false;
  if (remindOnFirstTurn) return (turnCount - 1) % intervalTurns === 0;
  return turnCount > intervalTurns && (turnCount - 1) % intervalTurns === 0;
}

function reminderIntervalTurns(memoraxCodeHome) {
  return positiveInteger(process.env.MEMORAX_CODE_MEMORY_SKILL_REMINDER_INTERVAL_TURNS)
    ?? configReminderIntervalTurns(join(memoraxCodeHome, "config.toml"))
    ?? DEFAULT_REMINDER_INTERVAL_TURNS;
}

function configReminderIntervalTurns(path) {
  try {
    return parseReminderIntervalTurns(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function parseReminderIntervalTurns(text) {
  let section = "";
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split("#", 1)[0].trim();
    if (!line) continue;
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1].trim();
      continue;
    }
    if (section !== "memory.skill_reminder") continue;
    const fieldMatch = line.match(/^interval_turns\s*=\s*(.+)$/);
    if (fieldMatch) return positiveInteger(fieldMatch[1]);
  }
  return undefined;
}

function positiveInteger(value) {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replaceAll("_", "");
  if (!/^[1-9]\d*$/.test(normalized)) return undefined;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}
