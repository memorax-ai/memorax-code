import { createBackendForwarder } from "./backend-forwarder.mjs";
import { resolveBackendConnection } from "./config.mjs";
import { createSessionBridge } from "./session-bridge.mjs";

export const name = "memorax-dsh";

export const inject = [];

const RETRIEVAL_WAIT_MS = 300;

export function apply(ctx, config) {
  const resolvedConfig = config ?? {};
  const initial = resolveBackendConnection(resolvedConfig, process.env);
  const debug = initial.debug
    ? (message, detail) => console.error(`[memorax-dsh] ${message}`, detail ?? "")
    : () => {};

  // The managed Backend may start AFTER this plugin loads, and its token can
  // rotate while DSH keeps running. Freezing the connection at apply() time
  // would strand the adapter on a stale URL/token until the plugin is
  // reloaded, so every hook dispatch re-resolves the connection instead.
  // Resolution reads at most two small JSON files at turn frequency; the
  // invalid-config warnings are deduped so a broken record cannot spam stderr
  // on every dispatch.
  const reportedIssues = new Set();
  const reportOnce = (message) => {
    if (reportedIssues.has(message)) return;
    reportedIssues.add(message);
    console.error(message);
  };
  const dispatch = async (path, body) => {
    const connection = resolveBackendConnection(resolvedConfig, process.env, {
      onInvalidBackendUrl: (value, source) => reportOnce(
        `[memorax-dsh] ignoring invalid ${source} "${value}"; falling back to the next configured Backend URL`,
      ),
      onAuthorityIssue: (reason, recordPath) => reportOnce(
        `[memorax-dsh] ignoring Backend connection record (${reason}: ${recordPath}); falling back to the default Backend URL`,
      ),
    });
    return await createBackendForwarder(connection).forward(path, body);
  };
  const bridge = createSessionBridge({
    dispatch,
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

  // Retrieval injection is decided once at apply(): it comes from static
  // plugin config / environment (not from the rotating authority records), so
  // per-dispatch re-resolution buys nothing here.
  if (initial.injectRetrieval) {
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
