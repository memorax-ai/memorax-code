import { delimiter } from "node:path";
import { resolveBackendConnection } from "../../memorax-code-adapter-common/src/backend-connection.mjs";
import { readAdapterState } from "../../memorax-code-adapter-common/src/config-utils.mjs";

const TURN_START_TIMEOUT_MS = 12_000;
const WRITEBACK_TIMEOUT_MS = 5_000;
const MAX_PENDING_TURNS = 256;

export function createMemoraxOpenCodePlugin(options = {}) {
  return async ({ client, project, directory, worktree }) => {
    const workspaceRoot = project?.vcs === "git" ? worktree : directory;
    const workspaceKind = project?.vcs === "git" ? "project" : "local";
    const pendingTurns = new Map();
    const inFlight = new Set();

    function track(task) {
      const observed = task.catch((error) => {
        debug(options, "opencode writeback failed", error);
      });
      inFlight.add(observed);
      void observed.finally(() => inFlight.delete(observed));
    }

    async function flushSession(sessionId) {
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

    return {
      "chat.message": async (input, output) => {
        if (!pluginEnabled(options)) return;
        const userMessageId = stringValue(output?.message?.id) ?? stringValue(input?.messageID);
        const sessionId = stringValue(input?.sessionID);
        const prompt = textParts(output?.parts);
        if (!sessionId || !userMessageId || !prompt) return;
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
          if (!pluginEnabled(options)) return;
          const turn = { sessionId, userMessageId };
          pendingTurns.set(turnKey(turn), turn);
          while (pendingTurns.size > MAX_PENDING_TURNS) {
            const oldest = pendingTurns.keys().next().value;
            if (typeof oldest !== "string") break;
            pendingTurns.delete(oldest);
          }
          const additionalContext = stringValue(result?.additionalContext);
          if (additionalContext) {
            const existing = stringValue(output.message.system);
            output.message.system = existing
              ? `${existing}\n\n${additionalContext}`
              : additionalContext;
          }
        } catch (error) {
          debug(options, "opencode turn start failed", error);
        }
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
        if (event?.type === "session.status" && event.properties?.status?.type === "idle") {
          const sessionId = stringValue(event.properties.sessionID);
          if (sessionId) track(flushSession(sessionId));
        }
      },
      async dispose() {
        await Promise.allSettled([...inFlight]);
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

function pluginEnabled(options) {
  const statePath = stringValue(options.statePath);
  if (!statePath) return true;
  const state = readAdapterState(statePath);
  return state?.unreadable !== true
    && state?.version === 1
    && state?.runtime === "opencode"
    && state?.integration === "plugin"
    && state?.enabled === true;
}
