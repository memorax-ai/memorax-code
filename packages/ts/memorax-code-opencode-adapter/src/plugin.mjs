import { delimiter } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { resolveBackendConnection } from "../../memorax-code-adapter-common/src/backend-connection.mjs";
import { readAdapterState } from "../../memorax-code-adapter-common/src/config-utils.mjs";
import { ensureBackendAvailable } from "../../memorax-code-adapter-common/src/hooks/ensure-backend-runner.mjs";
import { recordWorkspaceEvidence } from "../../memorax-code-adapter-common/src/hooks/capture-cwd-hook.mjs";
import {
  evaluateMemorySkillReminder,
  markSupplementalReminderForSession,
  personalMemoryReminderContext,
} from "../../memorax-code-adapter-common/src/hooks/memory-skill-reminder-hook.mjs";
import { scheduleMissingRepoMemoryBuild } from "../../memorax-code-adapter-common/src/repo-memory/repo-memory-auto-build.mjs";
import { buildRepoProcedureMemoryContext } from "../../memorax-code-adapter-common/src/repo-memory/repo-procedure-memory-context.mjs";
import { buildRepoUserProfilePreferencesContext } from "../../memorax-code-adapter-common/src/repo-memory/repo-user-profile-context.mjs";
import { OPENCODE_REPO_MEMORY_AGENT } from "./repo-memory-server-runner.mjs";

const DEFAULT_BACKEND_PROMPT_WAIT_TIMEOUT_MS = 5_000;
const TURN_START_TIMEOUT_MS = 12_000;
const REMINDER_TRACE_TIMEOUT_MS = 1_000;
const WRITEBACK_TIMEOUT_MS = 5_000;
const MAX_PENDING_TURNS = 256;
const MEMORY_SKILL_INVOCATION = "the `memorax-code` skill";

class BackendHttpResponseError extends Error {
  constructor(path, status) {
    super(`Backend ${path} returned HTTP ${status}`);
    this.status = status;
  }
}

export function createMemoraxOpenCodePlugin(options = {}) {
  return async ({ client, project, directory, worktree, serverUrl }) => {
    const workspaceRoot = project?.vcs === "git" ? worktree : directory;
    const workspaceKind = project?.vcs === "git" ? "project" : "local";
    const openCodeServerUrl = urlString(serverUrl);
    const pendingTurns = new Map();
    const sessionFlushes = new Map();
    const inFlight = new Set();
    const genericReminderOptions = memorySkillReminderOptions(options);
    const reminderEvaluator = options.memorySkillReminderEvaluator ?? evaluateMemorySkillReminder;
    const backendPromptWaitTimeoutMs = positiveInteger(
      options.backendPromptWaitTimeoutValue,
      DEFAULT_BACKEND_PROMPT_WAIT_TIMEOUT_MS,
    );
    let backendEnsurePromise;
    let backendEnsureSettled = false;
    let backendPromptGatePromise;

    recordOpenCodeWorkspaceEvidence(options, workspaceRoot, "plugin.load");

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

    async function flushSession(sessionId, target) {
      if (!pluginEnabled(options)) return;
      await ensureBackendReady();
      if (!pluginEnabled(options)) return;
      const turns = target
        ? [pendingTurns.get(turnKey(target))].filter(Boolean)
        : [...pendingTurns.values()].filter((turn) => turn.sessionId === sessionId);
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
        const terminal = terminalTurnFor(
          messages,
          sessionId,
          turn.userMessageId,
          target?.assistantMessageId,
        );
        if (!user || !terminal) continue;
        const { assistant, evidence } = terminal;
        let result;
        try {
          result = await postBackend(options, "/memory/writeback", {
            version: 1,
            client: "opencode",
            sessionId,
            userMessageId: turn.userMessageId,
            assistantMessageId: assistant.info.id,
            messages: evidence,
            cwd: workspaceRoot,
            workspaceKind,
          }, WRITEBACK_TIMEOUT_MS);
        } catch (error) {
          if (!(error instanceof BackendHttpResponseError) || error.status !== 413) throw error;
          pendingTurns.delete(turnKey(turn));
          debug(options, "opencode oversized writeback discarded", error);
          continue;
        }
        if (result?.ok === true && result.reason !== "runtime_closed") {
          pendingTurns.delete(turnKey(turn));
        }
      }
    }

    function queueSessionFlush(sessionId, target) {
      const previous = sessionFlushes.get(sessionId) ?? Promise.resolve();
      const queued = previous
        .catch(() => undefined)
        .then(() => flushSession(sessionId, target));
      sessionFlushes.set(sessionId, queued);
      const clear = () => {
        if (sessionFlushes.get(sessionId) === queued) sessionFlushes.delete(sessionId);
      };
      void queued.then(clear, clear);
      return queued;
    }

    void ensureBackendReady();

    return {
      config: async (config) => {
        if (!pluginEnabled(options)) return;
        config.agent ??= {};
        const configuredAgent = config.agent[OPENCODE_REPO_MEMORY_AGENT];
        config.agent[OPENCODE_REPO_MEMORY_AGENT] = {
          description: "Managed MemoraX Code Repo Memory maintenance agent.",
          mode: "subagent",
          hidden: true,
          ...(configuredAgent && typeof configuredAgent === "object" ? configuredAgent : {}),
        };
      },
      "chat.message": async (input, output) => {
        if (!pluginEnabled(options)) return;
        if (stringValue(input?.agent) === OPENCODE_REPO_MEMORY_AGENT) return;
        const userMessageId = stringValue(output?.message?.id) ?? stringValue(input?.messageID);
        const sessionId = stringValue(input?.sessionID);
        if (Array.isArray(output?.parts) && output.parts.some((part) => part?.type === "compaction")) return;
        const prompt = textParts(output?.parts);
        if (!sessionId || !userMessageId || !prompt) return;
        recordOpenCodeWorkspaceEvidence(options, workspaceRoot, "chat.message", sessionId);
        const reminderInput = {
          hookEventName: "UserPromptSubmit",
          sessionId,
          turnId: userMessageId,
          cwd: workspaceRoot,
          workspaceKind,
        };
        if (!await backendReadyForPrompt()) {
          debug(
            options,
            "opencode turn start skipped",
            `Backend recovery exceeded the ${backendPromptWaitTimeoutMs} ms interaction budget`,
          );
          if (!pluginEnabled(options)) return;
          const reminderResult = await evaluateReminder(
            reminderEvaluator,
            genericReminderOptions,
            reminderInput,
            options,
          );
          if (!pluginEnabled(options)) return;
          appendSystemContexts(output, reminderResult?.additionalContext);
          return;
        }
        if (!pluginEnabled(options)) return;
        let retrievalContext;
        let repositoryWorktree;
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
          void showUserNotice(client, directory, result?.userNotice, options);
          repositoryWorktree = stringValue(result?.repoMemoryWorktree);
          const repoMemoryEnv = openCodeRepoMemoryEnv(options, openCodeServerUrl, sessionId);
          if (repoMemoryEnv) {
            scheduleMissingRepoMemoryBuild(repositoryWorktree, {
              debugEnv: "MEMORAX_CODE_OPENCODE_PLUGIN_DEBUG",
              pluginRoot: options.openCodeConfigDir,
              env: repoMemoryEnv,
              nodePath: options.nodePath,
            });
          }
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
        if (!pluginEnabled(options)) return;
        const reminderResult = await evaluateReminder(
          reminderEvaluator,
          repositoryWorktree
            ? memorySkillReminderOptions(options, repositoryWorktree)
            : genericReminderOptions,
          reminderInput,
          options,
        );
        if (!pluginEnabled(options)) return;
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
        if (openCodeServerUrl) {
          output.env.MEMORAX_CODE_OPENCODE_SERVER_URL = openCodeServerUrl;
          output.env.MEMORAX_CODE_OPENCODE_COMMAND = stringValue(options.openCodeCommand)
            ?? process.execPath;
        }
        const sessionId = stringValue(input?.sessionID);
        delete output.env.MEMORAX_CODE_MEMORY_CLI_TRACE_SESSION_ID;
        delete output.env.MEMORAX_CODE_MEMORY_CLI_SESSION_ID;
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
          markSupplementalReminderForSession(genericReminderOptions, event.properties?.sessionID);
          return;
        }
        if (event?.type === "message.updated") {
          const interrupted = terminalErrorAssistantFromEvent(event, pendingTurns);
          if (interrupted) {
            track(
              queueSessionFlush(
                interrupted.sessionId,
                interrupted.userMessageId ? interrupted : undefined,
              ),
              "opencode interrupted turn finalization failed",
            );
          }
          return;
        }
        if (event?.type === "session.status" && event.properties?.status?.type === "idle") {
          const sessionId = stringValue(event.properties.sessionID);
          if (sessionId) {
            track(queueSessionFlush(sessionId), "opencode writeback failed");
          }
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

function terminalTurnFor(messages, sessionId, userMessageId, assistantMessageId) {
  const lineage = turnLineage(messages, sessionId, userMessageId);
  if (!lineage || lineage.awaitingContinuation) return undefined;
  const assistant = lineage.messages
    .filter((message) => (
      message?.info?.role === "assistant"
      && message.info.sessionID === sessionId
      && message.info.parentID === lineage.terminalUserMessageId
      && (!assistantMessageId || message.info.id === assistantMessageId)
      && Number.isFinite(message.info.time?.completed)
      && message.info.summary !== true
      && !message.parts?.some((part) => part?.type === "compaction")
    ))
    .sort((left, right) => (
      Number(left.info.time.completed) - Number(right.info.time.completed)
      || String(left.info.id).localeCompare(String(right.info.id))
    ))
    .at(-1);
  if (!assistant) return undefined;
  return {
    assistant,
    evidence: uniqueMessages([...lineage.evidence, assistant]),
  };
}

function turnLineage(messages, sessionId, userMessageId) {
  const sessionMessages = messages.filter((message) => (
    message?.info?.sessionID === sessionId
    && stringValue(message.info.id)
    && Array.isArray(message.parts)
  ));
  const startIndex = sessionMessages.findIndex((message) => (
    message.info.role === "user" && message.info.id === userMessageId
  ));
  if (startIndex < 0) return undefined;
  const original = sessionMessages[startIndex];
  const lineageAssistants = new Map();
  const evidence = [original];
  let terminalUserMessageId = userMessageId;
  let awaitingContinuation = false;

  for (const message of sessionMessages.slice(startIndex + 1)) {
    if (message.info.role === "assistant") {
      if (message.info.parentID === terminalUserMessageId) {
        lineageAssistants.set(message.info.id, message);
      }
      continue;
    }
    if (message.info.role !== "user") continue;
    if (hasCompactionPart(message.parts)) {
      const compactionTailId = compactionTailStartId(message, sessionId);
      if (!compactionTailId || awaitingContinuation) return undefined;
      const tail = lineageAssistants.get(compactionTailId);
      if (!tail) return undefined;
      evidence.push(minimalAssistantEvidence(tail), message);
      awaitingContinuation = true;
      continue;
    }
    if (isCompactionContinuation(message, sessionId)) {
      if (!awaitingContinuation) return undefined;
      terminalUserMessageId = message.info.id;
      evidence.push(message);
      awaitingContinuation = false;
      continue;
    }
    break;
  }
  return {
    messages: sessionMessages.slice(startIndex + 1),
    terminalUserMessageId,
    awaitingContinuation,
    evidence,
  };
}

function hasCompactionPart(parts) {
  return parts.some((part) => part?.type === "compaction");
}

function compactionTailStartId(message, sessionId) {
  const messageId = stringValue(message?.info?.id);
  const parts = message?.parts?.filter((part) => (
    part?.type === "compaction"
    && part.sessionID === sessionId
    && part.messageID === messageId
  )) ?? [];
  if (parts.length !== 1) return undefined;
  return stringValue(parts[0].tail_start_id);
}

function minimalAssistantEvidence(message) {
  return {
    info: {
      id: message.info.id,
      sessionID: message.info.sessionID,
      role: message.info.role,
      parentID: message.info.parentID,
    },
    parts: [],
  };
}

function isCompactionContinuation(message, sessionId) {
  const messageId = stringValue(message?.info?.id);
  return message?.parts?.some((part) => (
    part?.type === "text"
    && part.synthetic === true
    && part.metadata?.compaction_continue === true
    && part.sessionID === sessionId
    && part.messageID === messageId
  )) === true;
}

function uniqueMessages(messages) {
  const unique = new Map();
  for (const message of messages) unique.set(message.info.id, message);
  return [...unique.values()];
}

function terminalErrorAssistantFromEvent(event, pendingTurns) {
  const info = event?.properties?.info;
  const sessionId = stringValue(info?.sessionID);
  const userMessageId = stringValue(info?.parentID);
  const assistantMessageId = stringValue(info?.id);
  if (
    info?.role !== "assistant"
    || !stringValue(info?.error?.name)
    || !Number.isFinite(info?.time?.completed)
    || info?.summary === true
    || !sessionId
    || !userMessageId
    || !assistantMessageId
  ) return undefined;
  if (pendingTurns.has(turnKey({ sessionId, userMessageId }))) {
    return { sessionId, userMessageId, assistantMessageId };
  }
  return [...pendingTurns.values()].some((turn) => turn.sessionId === sessionId)
    ? { sessionId }
    : undefined;
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

async function showUserNotice(client, directory, notice, options) {
  const message = stringValue(notice);
  if (!message || typeof client?.tui?.showToast !== "function") return;
  try {
    await client.tui.showToast({
      body: {
        title: "MemoraX Code",
        message,
        variant: "warning",
        duration: 10_000,
      },
      query: { directory },
      throwOnError: true,
    });
  } catch (error) {
    debug(options, "opencode quota reminder failed", error);
  }
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
    throw new BackendHttpResponseError(path, response.status);
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

function urlString(value) {
  try {
    return value instanceof URL
      ? value.href
      : stringValue(value)
        ? new URL(value).href
        : undefined;
  } catch {
    return undefined;
  }
}

function openCodeRepoMemoryEnv(options, serverUrl, sessionId) {
  const memoraxCodeHome = stringValue(options.memoraxCodeHome);
  if (!memoraxCodeHome || !serverUrl) return undefined;
  return {
    ...process.env,
    MEMORAX_CODE_HOME: memoraxCodeHome,
    MEMORAX_CODE_MEMORY_CLI_SESSION_ID: sessionId,
    MEMORAX_CODE_OPENCODE_COMMAND: stringValue(options.openCodeCommand) ?? process.execPath,
    MEMORAX_CODE_OPENCODE_SERVER_URL: serverUrl,
  };
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

function memorySkillReminderOptions(options, repositoryWorktree) {
  const personalMemoryContextOptions = {
    adapterDir: "opencode",
    debugEnv: "MEMORAX_CODE_OPENCODE_PLUGIN_DEBUG",
    sessionKeyPrefix: "opencode",
  };
  return {
    additionalReminderContext: personalMemoryReminderContext(MEMORY_SKILL_INVOCATION),
    adapterDir: "opencode",
    ...(repositoryWorktree ? {
      buildCadenceReminderContext: (input) => buildRepoProcedureMemoryContext({
        ...input,
        cwd: repositoryWorktree,
      }, personalMemoryContextOptions),
      buildPersonalMemoryContext: (input) => buildRepoUserProfilePreferencesContext({
        ...input,
        cwd: repositoryWorktree,
      }, personalMemoryContextOptions),
    } : {}),
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
    nodePath: options.nodePath,
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

function recordOpenCodeWorkspaceEvidence(options, cwd, event, sessionId) {
  if (!managedPluginEnabled(options)) return;
  try {
    recordWorkspaceEvidence({
      adapterDir: "opencode",
      memoraxCodeHome: options.memoraxCodeHome,
      runtime: "opencode",
      sessionKeyPrefix: "opencode",
    }, {
      event,
      session_id: sessionId,
      cwd,
    });
  } catch (error) {
    debug(options, "opencode workspace evidence failed", error);
  }
}
