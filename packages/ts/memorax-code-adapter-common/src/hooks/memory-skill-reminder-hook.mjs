import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  atomicWriteJson,
  readJsonFile,
  readStdinJson,
  stringOption,
  withJsonFileLock,
} from "../config-utils.mjs";
import {
  isMemorySkillReminderDue,
  codingMemoryReminderContext,
  personalMemoryReminderContext,
  resolveMemorySkillReminderIntervalTurns,
} from "./memory-skill-reminder-policy.mjs";

export const PERSONAL_MEMORY_REMINDER_CONTEXT = personalMemoryReminderContext();
export {
  MEMORY_IMPACT_REMINDER_CONTEXT,
  personalMemoryReminderContext,
} from "./memory-skill-reminder-policy.mjs";

export async function runMemorySkillReminderHook(options, hookInput) {
  try {
    const input = hookInput ?? await readStdinJson();
    const result = await evaluateMemorySkillReminder(options, input);
    if (!result) return;
    process.stdout.write(`${JSON.stringify({
      ...(result.systemMessage ? { systemMessage: result.systemMessage } : {}),
      ...(result.additionalContext ? { hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: result.additionalContext,
      } } : {}),
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
      const sessionState = next.state.sessions[sessionId];
      const pendingCadence = sessionState?.cadenceReminderPending === true;
      const pendingProfile = sessionState?.initialProfilePending === true;
      if (next.duplicate && !pendingCadence && !pendingProfile) return next;
      const memoryReminderDue = pendingCadence || (!next.duplicate && isMemorySkillReminderDue(
        sessionState?.turnCount,
        intervalTurns,
        options.remindOnFirstTurn !== false,
      ));
      const initialProfileDue = pendingProfile || (memoryReminderDue && sessionState?.turnCount === 1);
      const supplementalReminderDue = options.supplementalReminderAfterCompact === true
        && sessionState?.supplementalReminderPending === true;
      if (pendingCadence) sessionState.cadenceReminderPending = false;
      if (pendingProfile) sessionState.initialProfilePending = false;
      if (supplementalReminderDue) sessionState.supplementalReminderPending = false;
      atomicWriteJson(statePath, next.state);
      return {
        ...next,
        duplicate: false,
        memoryReminderDue,
        initialProfileDue,
        supplementalReminderDue,
      };
    });
    const systemMessage = stringOption(options.systemMessage);
    // Backend notices are already claimed and must survive local reminder deduplication.
    if (update.duplicate) return systemMessage ? { systemMessage } : undefined;
    const { memoryReminderDue, initialProfileDue, supplementalReminderDue } = update;
    let discarded = false;
    const discard = () => {
      if (discarded) return;
      discarded = true;
      if (!memoryReminderDue && !initialProfileDue && !supplementalReminderDue) return;
      // Restore delivery obligations without rolling back another Turn's identity or count.
      markRemindersPendingForSession(options, sessionId, {
        ...(memoryReminderDue ? { cadenceReminderPending: true } : {}),
        ...(initialProfileDue ? { initialProfilePending: true } : {}),
        ...(supplementalReminderDue ? { supplementalReminderPending: true } : {}),
      });
    };
    const cancelled = () => {
      if (!options.signal?.aborted) return false;
      discard();
      return true;
    };
    if (cancelled()) return undefined;
    const searchGuidance = await evaluateSearchGuidance(options, input);
    if (!memoryReminderDue && !initialProfileDue && !supplementalReminderDue && !systemMessage
      && searchGuidance?.decision !== "search") return undefined;
    if (cancelled()) return undefined;
    const cadenceReminderContext = memoryReminderDue
      ? await buildCadenceReminderContext(options, input)
      : undefined;
    const personalMemoryContext = supplementalReminderDue || initialProfileDue
      ? await buildPersonalMemoryContext(options, input)
      : undefined;
    if (cancelled()) return undefined;
    const reminderContext = stringOption(combinedReminderContext(options, {
      memoryReminderDue,
      supplementalReminderDue,
    }, cadenceReminderContext, personalMemoryContext, searchGuidance));
    const triggers = [
      ...(searchGuidance?.ok === true ? ["search_guidance"] : []),
      ...(memoryReminderDue ? ["cadence"] : []),
      ...(supplementalReminderDue ? ["post_compaction"] : []),
    ];
    return {
      ...(options.signal && (memoryReminderDue || initialProfileDue || supplementalReminderDue) ? { discard } : {}),
      ...(systemMessage ? { systemMessage } : {}),
      ...(reminderContext ? { additionalContext: reminderContext } : {}),
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
  markRemindersPendingForSession(options, sessionId, { supplementalReminderPending: true });
}

function markRemindersPendingForSession(options, sessionId, pending) {
  try {
    const normalizedSessionId = stringOption(sessionId);
    if (!normalizedSessionId) return;
    const memoraxCodeHome = resolveMemoraxCodeHome(options);
    const statePath = join(memoraxCodeHome, "adapters", options.adapterDir, "memory-skill-reminders.json");
    withJsonFileLock(statePath, () => {
      const existing = readJsonFile(statePath);
      atomicWriteJson(statePath, markRemindersPending(
        existing?.unreadable ? undefined : existing?.value,
        options.runtime,
        normalizedSessionId,
        pending,
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

async function evaluateSearchGuidance(options, input) {
  if (typeof options.evaluateSearchGuidance !== "function") return undefined;
  try {
    const result = await options.evaluateSearchGuidance(input);
    return result?.ok === true && ["search", "skip"].includes(result.decision) ? result : undefined;
  } catch {
    return undefined;
  }
}

function combinedReminderContext(options, due, cadenceReminderContext, personalMemoryContext, searchGuidance) {
  const contexts = [];
  if (due.memoryReminderDue || searchGuidance?.ok === true) {
    const codingContext = codingMemoryReminderContext(searchGuidance, options.memorySkillInvocation);
    if (codingContext) contexts.push(codingContext);
  }
  if (due.supplementalReminderDue || personalMemoryContext
    || (due.memoryReminderDue && searchGuidance?.ok === true)) {
    const additionalReminderContext = stringOption(options.additionalReminderContext);
    if (additionalReminderContext) contexts.push(additionalReminderContext);
  }
  if (personalMemoryContext || (due.memoryReminderDue && cadenceReminderContext) || searchGuidance?.decision === "search") {
    const memoryImpactContext = stringOption(options.memoryImpactContext);
    if (memoryImpactContext) contexts.push(memoryImpactContext);
  }
  if (personalMemoryContext) contexts.push(personalMemoryContext);
  if (due.memoryReminderDue && cadenceReminderContext) contexts.push(cadenceReminderContext);

  return contexts.join("\n\n");
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

function markRemindersPending(existing, runtime, sessionId, pending) {
  const state = reminderState(existing, runtime);
  const current = state.sessions[sessionId] && typeof state.sessions[sessionId] === "object" && !Array.isArray(state.sessions[sessionId])
    ? state.sessions[sessionId]
    : {};
  state.sessions[sessionId] = {
    ...current,
    ...pending,
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

function reminderIntervalTurns(memoraxCodeHome) {
  return resolveMemorySkillReminderIntervalTurns({
    environmentValue: process.env.MEMORAX_CODE_MEMORY_SKILL_REMINDER_INTERVAL_TURNS,
    configText: configReminderText(join(memoraxCodeHome, "config.toml")),
  });
}

function configReminderText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}
