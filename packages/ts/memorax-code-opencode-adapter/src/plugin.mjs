import { delimiter } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { resolveBackendConnection } from "../../memorax-code-adapter-common/src/backend-connection.mjs";
import { readAdapterState } from "../../memorax-code-adapter-common/src/config-utils.mjs";
import { ensureBackendAvailable } from "../../memorax-code-adapter-common/src/hooks/ensure-backend-runner.mjs";
import {
  evaluateMemorySkillReminder,
  markSupplementalReminderForSession,
  personalMemoryReminderContext,
} from "../../memorax-code-adapter-common/src/hooks/memory-skill-reminder-hook.mjs";
import { buildRepoProcedureMemoryContext } from "../../memorax-code-adapter-common/src/repo-memory/repo-procedure-memory-context.mjs";
import { buildRepoUserProfilePreferencesContext } from "../../memorax-code-adapter-common/src/repo-memory/repo-user-profile-context.mjs";

const DEFAULT_BACKEND_PROMPT_WAIT_TIMEOUT_MS = 5_000;
const TURN_START_TIMEOUT_MS = 12_000;
const REMINDER_TRACE_TIMEOUT_MS = 1_000;
const WRITEBACK_TIMEOUT_MS = 5_000;
const MAX_PENDING_TURNS = 256;
const MEMORY_SKILL_INVOCATION = "the `memorax-code` skill";

export function createMemoraxOpenCodePlugin(options = {}) {
  return async ({ client, project, directory, worktree }) => {
    const workspaceRoot = project?.vcs === "git" ? worktree : directory;
    const workspaceKind = project?.vcs === "git" ? "project" : "local";
    const pendingTurns = new Map();
    const inFlight = new Set();
    const reminderOptions = memorySkillReminderOptions(options);
    const reminderEvaluator = options.memorySkillReminderEvaluator ?? evaluateMemorySkillReminder;
    const backendPromptWaitTimeoutMs = positiveInteger(
      options.backendPromptWaitTimeoutValue,
      DEFAULT_BACKEND_PROMPT_WAIT_TIMEOUT_MS,
    );
    let backendEnsurePromise;
    let backendEnsureSettled = false;
    let backendPromptGatePromise;

    function ensureBackendReady() {
      if (!managedPluginEnabled(options)) return Promise.resolve();
      if (!backendEnsurePromise) {
        const ensureOptions = backendEnsureOptions(options);
        if (!ensureOptions) return Promise.resolve();
        backendEnsurePromise = ensureBackendAvailable(ensureOptions)
          .catch((error) => {
            debug(options, "opencode backend recovery failed", error);
          })
          .then(() => {
            backendEnsureSettled = true;
          });
        backendPromptGatePromise = Promise.race([
          backendEnsurePromise.then(() => true),
          delay(backendPromptWaitTimeoutMs, false, { ref: false }),
        ]);
      }
      return backendEnsurePromise;
    }

    async function backendReadyForPrompt() {
      ensureBackendReady();
      if (!backendEnsurePromise || backendEnsureSettled) return true;
      return await backendPromptGatePromise;
    }

    function track(task, failureMessage) {
      const observed = task.catch((error) => {
        debug(options, failureMessage, error);
      });
      inFlight.add(observed);
      void observed.finally(() => inFlight.delete(observed));
    }

    async function flushSession(sessionId) {
      if (!pluginEnabled(options)) return;
      await ensureBackendReady();
      if (!pluginEnabled(options)) return;
      const turns = [...pendingTurns.values()].filter((turn) => turn.sessionId === sessionId);
      if (turns.length === 0) return;
      const response = await client.session.messages({
        path: { id: sessionId },
        query: { directory },
        throwOnError: true,
      });
      if (!pluginEnabled(options)) return;
      const messages = Array.isArray(response?.data) ? response.data : [];
      for (const turn of turns) {
        const user = messages.find((message) => (
          message?.info?.role === "user"
          && message.info.id === turn.userMessageId
          && message.info.sessionID === sessionId
        ));
        const assistant = completedAssistantFor(messages, sessionId, turn.userMessageId);
        if (!user || !assistant) continue;
        const result = await postBackend(options, "/memory/writeback", {
          version: 1,
          client: "opencode",
          sessionId,
          userMessageId: turn.userMessageId,
          assistantMessageId: assistant.info.id,
          messages: [user, assistant],
          cwd: workspaceRoot,
          workspaceKind,
        }, WRITEBACK_TIMEOUT_MS);
        if (result?.ok === true) pendingTurns.delete(turnKey(turn));
      }
    }

    void ensureBackendReady();

    return {
      "chat.message": async (input, output) => {
        if (!pluginEnabled(options)) return;
        const userMessageId = stringValue(output?.message?.id) ?? stringValue(input?.messageID);
        const sessionId = stringValue(input?.sessionID);
        const prompt = textParts(output?.parts);
        if (!sessionId || !userMessageId || !prompt) return;
        const reminderResult = await evaluateReminder(reminderEvaluator, reminderOptions, {
          hookEventName: "UserPromptSubmit",
          sessionId,
          turnId: userMessageId,
          cwd: workspaceRoot,
          workspaceKind,
        }, options);
        if (!await backendReadyForPrompt()) {
          debug(
            options,
            "opencode turn start skipped",
            `Backend recovery exceeded the ${backendPromptWaitTimeoutMs} ms interaction budget`,
          );
          appendSystemContexts(output, reminderResult?.additionalContext);
          return;
        }
        if (!pluginEnabled(options)) return;
        let retrievalContext;
        let turnStartAccepted = false;
        try {
          const result = await postBackend(options, "/memory/turn-start", {
            version: 1,
            client: "opencode",
            sessionId,
            userMessageId,
            prompt,
            cwd: workspaceRoot,
            workspaceKind,
          }, TURN_START_TIMEOUT_MS);
          turnStartAccepted = true;
          if (!pluginEnabled(options)) return;
          const turn = { sessionId, userMessageId };
          pendingTurns.set(turnKey(turn), turn);
          while (pendingTurns.size > MAX_PENDING_TURNS) {
            const oldest = pendingTurns.keys().next().value;
            if (typeof oldest !== "string") break;
            pendingTurns.delete(oldest);
          }
          retrievalContext = stringValue(result?.additionalContext);
        } catch (error) {
          debug(options, "opencode turn start failed", error);
        }
        if (turnStartAccepted && reminderResult?.reminder) {
          track(
            recordReminder(options, reminderResult.reminder),
            "opencode reminder trace failed",
          );
        }
        appendSystemContexts(output, retrievalContext, reminderResult?.additionalContext);
      },
      "shell.env": async (input, output) => {
        if (!pluginEnabled(options)) return;
        output.env.MEMORAX_CODE_MEMORY_CLI_TRACE_CLIENT = "opencode";
        const sessionId = stringValue(input?.sessionID);
        if (sessionId) {
          output.env.MEMORAX_CODE_MEMORY_CLI_TRACE_SESSION_ID = sessionId;
          output.env.MEMORAX_CODE_MEMORY_CLI_SESSION_ID = sessionId;
        }
        const cliBinDir = stringValue(options.cliBinDir);
        if (cliBinDir) {
          const currentPath = output.env.PATH ?? process.env.PATH ?? "";
          const pathEntries = currentPath.split(delimiter).filter(Boolean);
          output.env.PATH = pathEntries.includes(cliBinDir)
            ? currentPath
            : [cliBinDir, ...pathEntries].join(delimiter);
        }
      },
      event({ event }) {
        if (!pluginEnabled(options)) return;
        if (event?.type === "session.compacted") {
          markSupplementalReminderForSession(reminderOptions, event.properties?.sessionID);
          return;
        }
        if (event?.type === "session.status" && event.properties?.status?.type === "idle") {
          const sessionId = stringValue(event.properties.sessionID);
          if (sessionId) track(flushSession(sessionId), "opencode writeback failed");
        }
      },
      async dispose() {
        await Promise.allSettled([
          ...inFlight,
          ...(backendEnsurePromise ? [backendEnsurePromise] : []),
        ]);
      },
    };
  };
}

export const MemoraxOpenCodePlugin = createMemoraxOpenCodePlugin();
export default MemoraxOpenCodePlugin;

function completedAssistantFor(messages, sessionId, userMessageId) {
  return messages
    .filter((message) => (
      message?.info?.role === "assistant"
      && message.info.sessionID === sessionId
      && message.info.parentID === userMessageId
      && Number.isFinite(message.info.time?.completed)
      && message.info.error === undefined
      && message.info.summary !== true
      && !message.parts?.some((part) => part?.type === "compaction")
    ))
    .sort((left, right) => (
      Number(left.info.time.completed) - Number(right.info.time.completed)
      || String(left.info.id).localeCompare(String(right.info.id))
    ))
    .at(-1);
}

function textParts(parts) {
  if (!Array.isArray(parts)) return "";
  return parts
    .flatMap((part) => (
      part?.type === "text"
      && part.synthetic !== true
      && part.ignored !== true
      && stringValue(part.text)
        ? [part.text.trim()]
        : []
    ))
    .join("\n\n")
    .trim();
}

function turnKey(turn) {
  return JSON.stringify([turn.sessionId, turn.userMessageId]);
}

async function evaluateReminder(evaluator, reminderOptions, input, options) {
  try {
    return await evaluator(reminderOptions, input);
  } catch (error) {
    debug(options, "opencode memory reminder failed", error);
    return undefined;
  }
}

function appendSystemContexts(output, ...contexts) {
  const additions = contexts.map(stringValue).filter(Boolean);
  if (additions.length === 0) return;
  const existing = stringValue(output?.message?.system);
  output.message.system = [existing, ...additions].filter(Boolean).join("\n\n");
}

function recordReminder(options, reminder) {
  if (!reminder.turnId) return Promise.resolve();
  return postBackend(options, "/memory/skill-reminder", {
    version: 1,
    client: "opencode",
    sessionId: reminder.sessionId,
    userMessageId: reminder.turnId,
    cwd: reminder.cwd,
    workspaceKind: reminder.workspaceKind,
    content: reminder.content,
    triggers: reminder.triggers,
  }, REMINDER_TRACE_TIMEOUT_MS);
}

async function postBackend(options, path, body, timeoutMs) {
  const connection = options.backendConnection ?? resolveBackendConnection(options);
  const headers = { "content-type": "application/json", connection: "close" };
  if (connection.token) headers["x-memorax-code-backend-token"] = connection.token;
  const response = await (options.fetchImpl ?? fetch)(new URL(path, connection.url), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    await response.arrayBuffer().catch(() => undefined);
    throw new Error(`Backend ${path} returned HTTP ${response.status}`);
  }
  return await response.json();
}

function debug(options, message, error) {
  if (options.debug !== true && process.env.MEMORAX_CODE_OPENCODE_PLUGIN_DEBUG !== "1") return;
  console.error(`${message}: ${error instanceof Error ? error.message : String(error)}`);
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function pluginEnabled(options) {
  const statePath = stringValue(options.statePath);
  if (!statePath) return true;
  return managedPluginEnabled(options);
}

function managedPluginEnabled(options) {
  const statePath = stringValue(options.statePath);
  if (!statePath) return false;
  const state = readAdapterState(statePath);
  return state?.unreadable !== true
    && state?.version === 1
    && state?.runtime === "opencode"
    && state?.integration === "plugin"
    && state?.enabled === true;
}

function memorySkillReminderOptions(options) {
  const personalMemoryContextOptions = {
    adapterDir: "opencode",
    debugEnv: "MEMORAX_CODE_OPENCODE_PLUGIN_DEBUG",
    sessionKeyPrefix: "opencode",
  };
  return {
    additionalReminderContext: personalMemoryReminderContext(MEMORY_SKILL_INVOCATION),
    adapterDir: "opencode",
    buildCadenceReminderContext: (input) => buildRepoProcedureMemoryContext(input, personalMemoryContextOptions),
    buildPersonalMemoryContext: (input) => buildRepoUserProfilePreferencesContext(input, personalMemoryContextOptions),
    debugEnv: "MEMORAX_CODE_OPENCODE_PLUGIN_DEBUG",
    memoraxCodeHome: options.memoraxCodeHome,
    memorySkillInvocation: MEMORY_SKILL_INVOCATION,
    remindOnFirstTurn: true,
    runtime: "opencode",
    supplementalReminderAfterCompact: true,
  };
}

function backendEnsureOptions(options) {
  const memoraxCodeHome = stringValue(options.memoraxCodeHome);
  const openCodeConfigDir = stringValue(options.openCodeConfigDir);
  const memoraxCodeCommand = stringValue(options.memoraxCodeCommand);
  if (!memoraxCodeHome || !openCodeConfigDir || !memoraxCodeCommand) return undefined;
  return {
    backendConnection: options.backendConnection,
    healthTimeoutValue: options.healthTimeoutValue,
    startTimeoutValue: options.startTimeoutValue,
    memoraxCodeCommand,
    resolveHomes: () => ({ memoraxCodeHome, openCodeConfigDir }),
    buildStartArgs: (homes, recoveryArguments) => [
      "start",
      "--home", homes.memoraxCodeHome,
      "--opencode-config-dir", homes.openCodeConfigDir,
      ...recoveryArguments,
    ],
    debug: (message) => debug(options, "opencode backend recovery skipped", message),
  };
}
