import { resolveBackendConnection } from "../../../memorax-code-adapter-common/src/backend-connection.mjs";
import { postBackendCommand } from "../../../memorax-code-adapter-common/src/backend-command.mjs";
import type { TraceContext } from "../trace/context.js";
import { defaultMemoraxCodeHome } from "../config/memorax-code.js";
import { helpfulSettings } from "./helpful.js";

/** Transfer Search metadata from the short-lived CLI to its authenticated Backend. */
export async function registerHelpfulSearch(
  payload: Record<string, unknown>,
  trace: TraceContext | undefined,
  env: Record<string, string | undefined> = process.env,
  fetchImpl?: typeof fetch,
  searchSettings = helpfulSettings(defaultMemoraxCodeHome(env)),
) {
  if (!trace?.turnId || typeof payload.search_id !== "string") {
    return;
  }
  const home = defaultMemoraxCodeHome(env);
  if (!searchSettings.enabled || !helpfulSettings(home).enabled) {
    return;
  }
  try {
    const connection = resolveBackendConnection({ env, memoraxCodeHome: home });
    const response = await postBackendCommand({
      connection,
      path: "/memory/turn-context",
      timeoutMs: 1500,
      fetchImpl,
      body: {
        version: 1,
        context_turns_k: searchSettings.k,
        client: trace.client === "claude" ? "claude-code" : trace.client,
        sessionId: trace.sessionId,
        clientTurnId: trace.turnId,
        search_id: payload.search_id,
      },
    });
    await response.arrayBuffer();
  } catch {
    /* Registration is optional and must never fail Search. */
  }
}
