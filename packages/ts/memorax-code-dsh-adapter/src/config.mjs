export const DEFAULT_BACKEND_URL = "http://127.0.0.1:8787";
export const DEFAULT_TIMEOUT_MS = 5000;

export const MEMORY_HOOK_COMMAND_VERSION = 1;

export function resolveBackendConnection(config = {}, env = process.env) {
  const backendUrl = normalizeHttpUrl(config.backendUrl)
    ?? normalizeHttpUrl(env.MEMORAX_CODE_BACKEND_URL)
    ?? backendUrlFromHostPort(env)
    ?? DEFAULT_BACKEND_URL;
  const token = stringValue(config.backendToken)
    ?? stringValue(env.MEMORAX_CODE_BACKEND_TOKEN);
  const timeoutMs = positiveInteger(
    env.MEMORAX_CODE_DSH_HOOK_TIMEOUT_MS,
    config.timeoutMs,
    DEFAULT_TIMEOUT_MS,
  );
  const injectRetrieval = booleanValue(
    env.MEMORAX_CODE_DSH_RETRIEVAL_INJECT,
    config.injectRetrieval,
    false,
  );
  const debug = booleanValue(
    env.MEMORAX_CODE_DSH_HOOK_DEBUG,
    config.debug,
    false,
  );
  return { backendUrl, token, timeoutMs, injectRetrieval, debug };
}

export function normalizeHttpUrl(value) {
  const candidate = stringValue(value);
  if (!candidate) return undefined;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}

export function backendUrlFromHostPort(env) {
  const rawHost = stringValue(env.MEMORAX_CODE_BACKEND_HOST);
  const rawPort = stringValue(env.MEMORAX_CODE_BACKEND_PORT);
  if (!rawHost && !rawPort) return undefined;
  const host = rawHost ?? "127.0.0.1";
  const port = rawPort ?? "8787";
  const formattedHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return normalizeHttpUrl(`http://${formattedHost}:${port}`);
}

export function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function positiveInteger(...values) {
  for (const value of values) {
    if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
    const parsed = typeof value === "string" ? Number(value) : NaN;
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_TIMEOUT_MS;
}

function booleanValue(...values) {
  for (const value of values) {
    if (typeof value === "boolean") return value;
    if (typeof value !== "string") continue;
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
  }
  return false;
}
