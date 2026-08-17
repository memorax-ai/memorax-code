const RETRIEVAL_BACKEND_TIMEOUT_MS = 12_000;
const DEFAULT_BACKEND_TIMEOUT_MS = 5_000;

/** Create the narrow Backend port consumed by the Cordis plugin. */
export function createHttpBackendClient(options) {
  const resolveConnection = options?.resolveConnection;
  const fetchImpl = options?.fetchImpl ?? globalThis.fetch;
  const env = options?.env ?? process.env;
  if (typeof resolveConnection !== "function") {
    throw new TypeError("DSH Backend client requires resolveConnection");
  }
  if (typeof fetchImpl !== "function") throw new TypeError("DSH Backend client requires fetch");

  return Object.freeze({
    recordTurnStart(command, request = {}) {
      return post("/memory/turn-start", command, request.signal);
    },
    recordSkillReminder(command, request = {}) {
      return post("/memory/skill-reminder", command, request.signal);
    },
    writebackTurn(command, request = {}) {
      return post("/memory/writeback", command, request.signal);
    },
  });

  async function post(path, body, callerSignal) {
    const connection = resolveConnection();
    const timeoutMs = positiveInteger(
      env.MEMORAX_CODE_DSH_MEMORY_HOOK_TIMEOUT_MS,
      path === "/memory/turn-start" ? RETRIEVAL_BACKEND_TIMEOUT_MS : DEFAULT_BACKEND_TIMEOUT_MS,
    );
    const headers = { "content-type": "application/json", connection: "close" };
    if (connection.token) headers["x-memorax-code-backend-token"] = connection.token;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, timeoutSignal])
      : timeoutSignal;
    const response = await fetchImpl(new URL(path, connection.url), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) {
      await response.arrayBuffer().catch(() => undefined);
      throw new Error(`MemoraX Code Backend ${path} returned HTTP ${response.status}`);
    }
    return await response.json().catch(() => undefined);
  }
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
