import { createBackendForwarder } from "./backend-forwarder.mjs";
import { resolveBackendConnection } from "./config.mjs";
import { createSessionBridge } from "./session-bridge.mjs";

export const name = "memorax-dsh";

export const inject = [];

export function apply(ctx, config) {
  const resolvedConfig = config ?? {};
  const connection = resolveBackendConnection(resolvedConfig, process.env);
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
        const context = bridge.takePendingContext(options?.sessionId);
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
