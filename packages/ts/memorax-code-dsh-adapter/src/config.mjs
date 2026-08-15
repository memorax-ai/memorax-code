import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export const DEFAULT_BACKEND_URL = "http://127.0.0.1:8787";
export const DEFAULT_TIMEOUT_MS = 5000;

export const MEMORY_HOOK_COMMAND_VERSION = 1;

// The managed Backend announces its URL (and, in server mode, its token file)
// through an authority record under the MemoraX Code home directory. The
// canonical reader lives in memorax-code-adapter-common
// (backend-connection.mjs); this adapter is a standalone cordis plugin and
// cannot import that package, so the validation rules are mirrored here and
// pinned by the backend contract test. Differences are deliberate: a broken
// authority record must NOT throw inside a fail-silent plugin — it warns and
// falls back, while adapter-common fails fast in CLI contexts.
const BACKEND_CONNECTION_VERSION = 1;
const BACKEND_TOKEN_VERSION = 1;
const BACKEND_CONNECTION_KEYS = new Set(["version", "url", "tokenPath"]);
const BACKEND_TOKEN_KEYS = new Set(["version", "token", "createdAt", "rotatedAt"]);

export function resolveBackendConnection(config = {}, env = process.env, options = {}) {
  const onInvalidBackendUrl = typeof options.onInvalidBackendUrl === "function"
    ? options.onInvalidBackendUrl
    : undefined;
  const onAuthorityIssue = typeof options.onAuthorityIssue === "function"
    ? options.onAuthorityIssue
    : undefined;
  const memoraxCodeHome = stringValue(env.MEMORAX_CODE_HOME)
    ?? join(homedir(), ".memorax-code");
  const authority = readBackendConnectionAuthority(memoraxCodeHome, onAuthorityIssue);

  const configUrl = stringValue(config.backendUrl);
  const envUrl = stringValue(env.MEMORAX_CODE_BACKEND_URL);
  let selected;
  if (normalizeHttpUrl(configUrl)) {
    selected = { url: normalizeHttpUrl(configUrl), source: "config" };
  } else if (configUrl) {
    warnInvalidUrl(configUrl, "config backendUrl");
    selected = undefined;
  }
  if (!selected && normalizeHttpUrl(envUrl)) {
    selected = { url: normalizeHttpUrl(envUrl), source: "environment" };
  } else if (!selected && envUrl) {
    warnInvalidUrl(envUrl, "MEMORAX_CODE_BACKEND_URL");
  }
  if (!selected) {
    const hostPortUrl = backendUrlFromHostPort(env);
    if (hostPortUrl) selected = { url: hostPortUrl, source: "environment" };
  }
  if (!selected && authority) {
    selected = { url: authority.url, source: "authority" };
  }
  if (!selected) selected = { url: DEFAULT_BACKEND_URL, source: "default" };

  const envToken = stringValue(config.backendToken)
    ?? stringValue(env.MEMORAX_CODE_BACKEND_TOKEN);
  // The persisted token is only trusted when the selected URL really came
  // from the authority record: sending the managed token to a user-supplied
  // URL would leak it to an arbitrary destination.
  const persistedToken = !envToken
    && selected.source === "authority"
    && authority?.tokenPath
    ? readBackendToken(authority.tokenPath, memoraxCodeHome, onAuthorityIssue)
    : undefined;
  const token = envToken ?? persistedToken;
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
  return {
    backendUrl: selected.url,
    urlSource: selected.source,
    token,
    tokenSource: envToken ? "environment" : persistedToken ? "authority-file" : "none",
    timeoutMs,
    injectRetrieval,
    debug,
  };

  function warnInvalidUrl(value, source) {
    // An explicitly configured URL that cannot be normalized (missing
    // scheme, wrong scheme, typo) is a misconfiguration: surface it instead
    // of silently falling back to the default loopback URL.
    onInvalidBackendUrl?.(value, source);
  }
}

export function backendConnectionPath(memoraxCodeHome) {
  return join(memoraxCodeHome, "runtime", "backend", "backend-connection.json");
}

export function backendTokenPath(memoraxCodeHome) {
  return join(memoraxCodeHome, "runtime", "backend", "backend-token.json");
}

function readBackendConnectionAuthority(memoraxCodeHome, onAuthorityIssue) {
  const path = backendConnectionPath(memoraxCodeHome);
  let value;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // Absent or unreadable: the managed Backend may simply not have written
    // it yet. Nothing to announce for the common absent case.
    if (!authorityRecordExists(path)) return undefined;
    onAuthorityIssue?.("backend connection record is unreadable", path);
    return undefined;
  }
  if (!isRecord(value)) {
    onAuthorityIssue?.("backend connection record is not an object", path);
    return undefined;
  }
  if (value.version !== BACKEND_CONNECTION_VERSION) {
    onAuthorityIssue?.(`backend connection record version ${String(value.version)} is unsupported`, path);
    return undefined;
  }
  if (Object.keys(value).some((key) => !BACKEND_CONNECTION_KEYS.has(key))) {
    onAuthorityIssue?.("backend connection record has unknown fields", path);
    return undefined;
  }
  const url = normalizedManagedBackendUrl(value.url);
  if (!url) {
    onAuthorityIssue?.("backend connection record URL is invalid", path);
    return undefined;
  }
  let tokenPath;
  if (Object.prototype.hasOwnProperty.call(value, "tokenPath")) {
    tokenPath = canonicalTokenPath(value.tokenPath, memoraxCodeHome);
    if (!tokenPath) {
      onAuthorityIssue?.("backend connection record tokenPath is invalid", path);
      return undefined;
    }
  }
  return { url, ...(tokenPath ? { tokenPath } : {}) };
}

function readBackendToken(expectedPath, memoraxCodeHome, onAuthorityIssue) {
  const path = backendTokenPath(memoraxCodeHome);
  if (resolve(path) !== resolve(expectedPath)) return undefined;
  let value;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
  if (!isRecord(value)) {
    onAuthorityIssue?.("backend token record is not an object", path);
    return undefined;
  }
  if (value.version !== BACKEND_TOKEN_VERSION) {
    onAuthorityIssue?.(`backend token record version ${String(value.version)} is unsupported`, path);
    return undefined;
  }
  if (Object.keys(value).some((key) => !BACKEND_TOKEN_KEYS.has(key))) {
    onAuthorityIssue?.("backend token record has unknown fields", path);
    return undefined;
  }
  const token = stringValue(value.token);
  if (!token) {
    onAuthorityIssue?.("backend token record has no token", path);
    return undefined;
  }
  const createdAt = stringValue(value.createdAt);
  if (!createdAt || !Number.isFinite(Date.parse(createdAt))) {
    onAuthorityIssue?.("backend token record createdAt is invalid", path);
    return undefined;
  }
  return token;
}

function authorityRecordExists(path) {
  try {
    readFileSync(path, "utf8");
    return true;
  } catch (error) {
    return error?.code !== "ENOENT";
  }
}

function canonicalTokenPath(value, memoraxCodeHome) {
  const candidate = stringValue(value);
  if (!candidate || !isAbsolute(candidate)) return undefined;
  const expected = resolve(backendTokenPath(memoraxCodeHome));
  return resolve(candidate) === expected ? expected : undefined;
}

function normalizedManagedBackendUrl(value) {
  const url = normalizeHttpUrl(value);
  if (!url) return undefined;
  const parsed = new URL(url);
  if (parsed.protocol !== "http:"
    || parsed.username
    || parsed.password
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash) return undefined;
  return url;
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

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
