import { createBackendForwarder } from "./backend-forwarder.mjs";
import { resolveBackendConnection } from "./config.mjs";
import { createSessionBridge } from "./session-bridge.mjs";

export const name = "memorax-dsh";

export const inject = [];

const RETRIEVAL_WAIT_MS = 300;

export function apply(ctx, config) {
  const resolvedConfig = config ?? {};
  const connection = resolveBackendConnection(resolvedConfig, process.env, {
    onInvalidBackendUrl: (value, source) => console.error(
      `[memorax-dsh] ignoring invalid ${source} "${value}"; falling back to the next configured Backend URL`,
    ),
    onAuthorityIssue: (reason, path) => console.error(
      `[memorax-dsh] ignoring Backend connection record (${reason}: ${path}); falling back to the default Backend URL`,
    ),
  });
  const debug = connection.debug
    ? (message, detail) => console.error(`[memorax-dsh] ${message}`, detail ?? "")
    : () => {};
  const bridge = createSessionBridge({
    dispatch: createBackendForwarder(connection).forward,
    debug,
  });

  ctx.on("session/created", (session) => {
    try {
      bridge.onSessionCreated(session);
    } catch (error) {
      debug("session/created handler failed", errorMessage(error));
    }
  });

  ctx.on("session/event", (session, event) => {
    try {
      bridge.onSessionEvent(session, event);
    } catch (error) {
      debug("session/event handler failed", errorMessage(error));
    }
  });

  ctx.on("session/disposed", (session) => {
    try {
      bridge.onSessionDisposed(session);
    } catch (error) {
      debug("session/disposed handler failed", errorMessage(error));
    }
  });

  if (connection.injectRetrieval) {
    ctx.on("llm/stream", async function* (options, next) {
      try {
        const context = await bridge.waitForPendingContext(options?.sessionId, RETRIEVAL_WAIT_MS);
        if (context) {
          options.system = options.system ? `${options.system}\n\n${context}` : context;
        }
      } catch (error) {
        debug("llm/stream injection failed", errorMessage(error));
      }
      yield* next();
    });
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
