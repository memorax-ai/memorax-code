import { DEFAULT_TIMEOUT_MS } from "./config.mjs";

export async function postBackend(path, body, options = {}) {
  const backendUrl = options.backendUrl;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!backendUrl) return { ok: false, error: "backend URL is not configured" };
  try {
    const headers = { "content-type": "application/json", connection: "close" };
    if (options.token) headers["x-memorax-code-backend-token"] = options.token;
    const url = new URL(path, backendUrl.endsWith("/") ? backendUrl : `${backendUrl}/`);
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const parsed = await response.json().catch(() => undefined);
    return { ok: response.ok, status: response.status, body: parsed };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function createBackendForwarder(connection) {
  return {
    async forward(path, body) {
      return await postBackend(path, body, {
        backendUrl: connection.backendUrl,
        token: connection.token,
        timeoutMs: connection.timeoutMs,
      });
    },
  };
}
