import { DEFAULT_TIMEOUT_MS } from "./config.mjs";

export const DSH_BACKEND_UNREACHABLE = "DSH_BACKEND_UNREACHABLE";
export const DSH_BACKEND_TIMEOUT = "DSH_BACKEND_TIMEOUT";
export const DSH_BACKEND_HTTP_ERROR = "DSH_BACKEND_HTTP_ERROR";
export const DSH_BACKEND_NOT_CONFIGURED = "DSH_BACKEND_NOT_CONFIGURED";

export class DshBackendError extends Error {
  constructor(message, code, options = {}) {
    super(message);
    this.name = "DshBackendError";
    this.code = code;
    if (options.status !== undefined) this.status = options.status;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

export async function postBackend(path, body, options = {}) {
  const backendUrl = options.backendUrl;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!backendUrl) {
    throw new DshBackendError("backend URL is not configured", DSH_BACKEND_NOT_CONFIGURED);
  }
  let response;
  try {
    const headers = { "content-type": "application/json", connection: "close" };
    if (options.token) headers["x-memorax-code-backend-token"] = options.token;
    const url = new URL(path, backendUrl.endsWith("/") ? backendUrl : `${backendUrl}/`);
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      // Never follow redirects: a 307/308 would silently forward the Backend
      // token header and the command body to whatever the redirect targets.
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw dshBackendNetworkError(error);
  }
  const parsed = await response.json().catch(() => undefined);
  if (!response.ok) {
    throw new DshBackendError(
      `Backend rejected ${path} with HTTP ${response.status}`,
      DSH_BACKEND_HTTP_ERROR,
      { status: response.status },
    );
  }
  if (parsed === undefined || parsed === null || typeof parsed !== "object") {
    // A 2xx without a parseable JSON object is not a success: the session
    // bridge reads body.ok/scheduled/reason/discarded from this payload, and
    // swallowing a malformed body here would report every skip/rejection as
    // an accepted dispatch with zero visibility.
    throw new DshBackendError(
      `Backend answered ${path} with HTTP ${response.status} but no JSON body`,
      DSH_BACKEND_HTTP_ERROR,
      { status: response.status },
    );
  }
  return { ok: true, status: response.status, body: parsed };
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

function dshBackendNetworkError(error) {
  const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
  return new DshBackendError(
    timedOut ? "Backend request timed out" : "Backend is unreachable",
    timedOut ? DSH_BACKEND_TIMEOUT : DSH_BACKEND_UNREACHABLE,
    { cause: error },
  );
}
