import { recordHookFailure } from "./hooks/hook-diagnostics.mjs";

const HOOK_OPERATIONS = new Map([
  ["/memory/turn-start", "memory.turn-start"],
  ["/memory/writeback", "memory.writeback"],
]);

// Connection authority and response policy remain with the caller. Resolve the
// connection for each request so long-lived plugins observe token rotation.
export async function postBackendCommand({
  connection,
  path,
  body,
  timeoutMs,
  signal,
  memoraxCodeHome,
  fetchImpl = globalThis.fetch,
}) {
  const headers = { "content-type": "application/json", connection: "close" };
  if (connection.token) headers["x-memorax-code-backend-token"] = connection.token;
  // This signal also bounds the caller's response-body read. Cancellation does
  // not undo an accepted command, so this transport must not retry it.
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const diagnostic = { memoraxCodeHome: memoraxCodeHome ?? connection.memoraxCodeHome, client: body?.client, input: body, operation: HOOK_OPERATIONS.get(path) };
  try {
    const response = await fetchImpl(new URL(path, connection.url), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
    });
    if (!response.ok) recordHookFailure({ ...diagnostic, errorCode: "HOOK_BACKEND_HTTP_REJECTED", httpStatus: response.status });
    return response;
  } catch (error) {
    if (!signal?.aborted) {
      const errorCode = timeoutSignal.aborted || error?.name === "TimeoutError"
        ? "HOOK_BACKEND_REQUEST_TIMEOUT" : "HOOK_BACKEND_REQUEST_FAILED";
      recordHookFailure({ ...diagnostic, errorCode, error });
    }
    throw error;
  }
}
