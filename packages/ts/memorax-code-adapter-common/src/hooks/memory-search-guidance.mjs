import { postBackendCommand } from "../backend-command.mjs";
import { resolveBackendConnection } from "../backend-connection.mjs";

export const SEARCH_GUIDANCE_TIMEOUT_MS = 3_000;

/** Request a decision for an already registered, client-qualified native Turn. */
export async function requestMemorySearchGuidance({ body, memoraxCodeHome, signal, connection: suppliedConnection, fetchImpl = globalThis.fetch }) {
  try {
    const connection = suppliedConnection ?? resolveBackendConnection({ memoraxCodeHome });
    const response = await postBackendCommand({
      connection, path: "/memory/search-guidance", body,
      timeoutMs: SEARCH_GUIDANCE_TIMEOUT_MS, signal, memoraxCodeHome, fetchImpl,
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      return undefined;
    }
    const result = await response.json();
    return result?.ok === true && ["search", "skip"].includes(result.decision) ? result : undefined;
  } catch {
    return undefined;
  }
}

/** Session bootstrap has no prompt; this only checks effective local configuration. */
export async function readMemorySearchGuidanceEnabled({ memoraxCodeHome, fetchImpl = globalThis.fetch } = {}) {
  try {
    const connection = resolveBackendConnection({ memoraxCodeHome });
    const headers = { connection: "close" };
    if (connection.token) headers["x-memorax-code-backend-token"] = connection.token;
    const response = await fetchImpl(new URL("/memory/search-guidance", connection.url), {
      headers, signal: AbortSignal.timeout(SEARCH_GUIDANCE_TIMEOUT_MS),
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      return false;
    }
    return (await response.json())?.enabled === true;
  } catch {
    return false;
  }
}
