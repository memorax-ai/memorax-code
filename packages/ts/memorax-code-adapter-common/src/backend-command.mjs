// Connection authority and response policy remain with the caller. Resolve the
// connection for each request so long-lived plugins observe token rotation.
export async function postBackendCommand({
  connection,
  path,
  body,
  timeoutMs,
  signal,
  fetchImpl = globalThis.fetch,
}) {
  const headers = { "content-type": "application/json", connection: "close" };
  if (connection.token) headers["x-memorax-code-backend-token"] = connection.token;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return await fetchImpl(new URL(path, connection.url), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
  });
}
