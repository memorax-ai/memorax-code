import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  readJsonRuntimeRecord,
  RuntimeRecordError,
  writePrivateJsonRecord,
} from "./runtime-record.mjs";

export const BACKEND_CONNECTION_VERSION = 1;
export const BACKEND_TOKEN_VERSION = 1;
export const DEFAULT_BACKEND_URL = "http://127.0.0.1:8787";
const BACKEND_CONNECTION_KEYS = new Set(["version", "url", "tokenPath"]);
const BACKEND_TOKEN_KEYS = new Set(["version", "token", "createdAt", "rotatedAt"]);

export class BackendConnectionAuthorityError extends Error {
  constructor(state, path) {
    const unsupported = state.status === "unsupported";
    super(unsupported
      ? `Backend connection authority uses unsupported version ${state.version}: ${path}; pass an explicit Backend URL or --host/--port to recover`
      : `Backend connection authority is invalid (${state.reason}): ${path}; pass an explicit Backend URL or --host/--port to recover`);
    this.name = "BackendConnectionAuthorityError";
    this.code = unsupported
      ? "BACKEND_CONNECTION_AUTHORITY_UNSUPPORTED"
      : "BACKEND_CONNECTION_AUTHORITY_INVALID";
    this.authorityStatus = state.status;
    this.authorityPath = path;
    if (unsupported) this.version = state.version;
    else this.reason = state.reason;
  }
}

export class BackendTokenRecordError extends RuntimeRecordError {
  constructor(state, path) {
    super({
      name: "Backend token record",
      path,
      state,
      codePrefix: "BACKEND_TOKEN_RECORD",
      recovery: state.status === "unsupported"
        ? "upgrade MemoraX Code or restore a supported token record"
        : "stop the managed Backend and run `memorax-code token --rotate` to replace it",
    });
    this.name = "BackendTokenRecordError";
  }
}

export function backendConnectionPath(memoraxCodeHome = defaultMemoraxCodeHome()) {
  return join(memoraxCodeHome, "runtime", "backend", "backend-connection.json");
}

export function backendTokenPath(memoraxCodeHome = defaultMemoraxCodeHome()) {
  return join(memoraxCodeHome, "runtime", "backend", "backend-token.json");
}

export function readBackendConnectionAuthority(memoraxCodeHome = defaultMemoraxCodeHome()) {
  const path = backendConnectionPath(memoraxCodeHome);
  const state = readJsonRuntimeRecord(path);
  if (state.status !== "present") return state;
  const value = state.value;
  if (value.version !== BACKEND_CONNECTION_VERSION) {
    if (Number.isSafeInteger(value.version) && value.version > 0) {
      return { status: "unsupported", version: value.version };
    }
    return { status: "invalid", reason: "invalid_version" };
  }
  if (Object.keys(value).some((key) => !BACKEND_CONNECTION_KEYS.has(key))) {
    return { status: "invalid", reason: "unknown_fields" };
  }
  const url = normalizedManagedBackendUrl(value.url);
  if (!url) return { status: "invalid", reason: "invalid_url" };
  let tokenPath;
  if (Object.prototype.hasOwnProperty.call(value, "tokenPath")) {
    tokenPath = canonicalTokenPath(value.tokenPath, memoraxCodeHome);
    if (!tokenPath) return { status: "invalid", reason: "invalid_token_path" };
  }
  return {
    status: "valid",
    authority: {
      version: BACKEND_CONNECTION_VERSION,
      url,
      ...(tokenPath ? { tokenPath } : {}),
    },
  };
}

export function writeBackendConnectionAuthority(options, runtime) {
  const memoraxCodeHome = stringValue(options?.memoraxCodeHome) ?? defaultMemoraxCodeHome();
  const url = normalizedManagedBackendUrl(options?.url);
  if (!url) throw new Error("Backend connection authority requires a root HTTP URL");
  const suppliedTokenPath = stringValue(options?.tokenPath);
  const tokenPath = suppliedTokenPath
    ? canonicalTokenPath(suppliedTokenPath, memoraxCodeHome)
    : undefined;
  if (suppliedTokenPath && !tokenPath) {
    throw new Error("Backend connection authority tokenPath must reference the canonical Backend token file");
  }
  const record = {
    version: BACKEND_CONNECTION_VERSION,
    url,
    ...(tokenPath ? { tokenPath } : {}),
  };
  const path = backendConnectionPath(memoraxCodeHome);
  return writePrivateJsonRecord(path, record, {
    ...runtime,
    durableBoundary: memoraxCodeHome,
  });
}

export function readBackendTokenRecordState(memoraxCodeHome = defaultMemoraxCodeHome()) {
  const path = backendTokenPath(memoraxCodeHome);
  const state = readJsonRuntimeRecord(path);
  if (state.status !== "present") return state;
  const value = state.value;
  if (value.version !== BACKEND_TOKEN_VERSION) {
    if (Number.isSafeInteger(value.version) && value.version > 0) {
      return { status: "unsupported", version: value.version };
    }
    return { status: "invalid", reason: "invalid_version" };
  }
  if (Object.keys(value).some((key) => !BACKEND_TOKEN_KEYS.has(key))) {
    return { status: "invalid", reason: "unknown_fields" };
  }
  const token = stringValue(value.token);
  if (!token) return { status: "invalid", reason: "invalid_token" };
  const createdAt = timestampValue(value.createdAt);
  if (!createdAt) return { status: "invalid", reason: "invalid_created_at" };
  let rotatedAt;
  if (Object.prototype.hasOwnProperty.call(value, "rotatedAt")) {
    rotatedAt = timestampValue(value.rotatedAt);
    if (!rotatedAt) return { status: "invalid", reason: "invalid_rotated_at" };
  }
  return {
    status: "valid",
    record: {
      version: BACKEND_TOKEN_VERSION,
      token,
      createdAt,
      ...(rotatedAt ? { rotatedAt } : {}),
    },
  };
}

export function writeBackendTokenRecord(options, runtime) {
  const memoraxCodeHome = stringValue(options?.memoraxCodeHome) ?? defaultMemoraxCodeHome();
  const token = stringValue(options?.token);
  if (!token) throw new TypeError("Backend token record requires a non-empty token");
  const createdAt = timestampValue(options?.createdAt);
  if (!createdAt) throw new TypeError("Backend token record requires a valid createdAt timestamp");
  const suppliedRotatedAt = Object.prototype.hasOwnProperty.call(options ?? {}, "rotatedAt");
  const rotatedAt = suppliedRotatedAt ? timestampValue(options.rotatedAt) : undefined;
  if (suppliedRotatedAt && !rotatedAt) {
    throw new TypeError("Backend token record rotatedAt must be a valid timestamp");
  }
  const record = {
    version: BACKEND_TOKEN_VERSION,
    token,
    createdAt,
    ...(rotatedAt ? { rotatedAt } : {}),
  };
  return writePrivateJsonRecord(backendTokenPath(memoraxCodeHome), record, {
    ...runtime,
    durableBoundary: memoraxCodeHome,
  });
}

export function resolveBackendConnection(options = {}) {
  const env = options.env ?? process.env;
  const memoraxCodeHome = stringValue(options.memoraxCodeHome)
    ?? stringValue(env.MEMORAX_CODE_HOME)
    ?? defaultMemoraxCodeHome();
  const authorityPath = backendConnectionPath(memoraxCodeHome);
  const authorityState = readBackendConnectionAuthority(memoraxCodeHome);
  const authority = authorityState.status === "valid" ? authorityState.authority : undefined;
  const selected = selectedBackendUrl(options.backendUrl, env, authorityState, authorityPath);
  const tokenFromEnvironment = stringValue(options.backendToken)
    ?? stringValue(env.MEMORAX_CODE_BACKEND_TOKEN);
  // A persisted token belongs to its recorded URL. An address override must
  // not silently carry that token to a different Backend.
  const authorityMatches = authority?.url === selected.url;
  const persistedToken = !tokenFromEnvironment && authorityMatches && authority?.tokenPath
    ? readToken(authority.tokenPath, memoraxCodeHome)
    : undefined;
  const parsed = new URL(selected.url);
  return {
    memoraxCodeHome,
    authorityPath,
    authority,
    url: selected.url,
    source: selected.source,
    host: stripIpv6Brackets(parsed.hostname),
    port: Number(parsed.port || (parsed.protocol === "https:" ? "443" : "80")),
    token: tokenFromEnvironment ?? persistedToken,
    tokenSource: tokenFromEnvironment
      ? "environment"
      : persistedToken
        ? "authority-file"
        : "none",
  };
}

export function localBackendRecoveryArguments(connection) {
  let parsed;
  try {
    parsed = new URL(connection?.url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:"
    || parsed.username
    || parsed.password
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash) return undefined;
  const host = stripIpv6Brackets(parsed.hostname);
  const port = Number(parsed.port || "80");
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  if (!isLoopbackHost(host)) return undefined;
  if (connection.source === "default" && connection.url === DEFAULT_BACKEND_URL) return [];
  return ["--host", host, "--port", String(port)];
}

function selectedBackendUrl(explicitUrl, env, authorityState, authorityPath) {
  const optionUrl = normalizedHttpUrl(explicitUrl);
  if (optionUrl) return { url: optionUrl, source: "option" };
  const environmentUrl = normalizedHttpUrl(stringValue(env.MEMORAX_CODE_BACKEND_URL));
  if (environmentUrl) return { url: environmentUrl, source: "environment" };
  const hostPortUrl = backendUrlFromHostPortEnv(env);
  if (hostPortUrl) return { url: hostPortUrl, source: "environment" };
  if (authorityState.status === "valid") {
    return { url: authorityState.authority.url, source: "authority" };
  }
  if (authorityState.status === "absent") {
    return { url: DEFAULT_BACKEND_URL, source: "default" };
  }
  throw new BackendConnectionAuthorityError(authorityState, authorityPath);
}

function backendUrlFromHostPortEnv(env) {
  const rawHost = stringValue(env.MEMORAX_CODE_BACKEND_HOST);
  const rawPort = stringValue(env.MEMORAX_CODE_BACKEND_PORT);
  if (!rawHost && !rawPort) return undefined;
  const host = rawHost ?? "127.0.0.1";
  const port = rawPort ?? "8787";
  const formattedHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return normalizedHttpUrl(`http://${formattedHost}:${port}`);
}

function normalizedHttpUrl(value) {
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

function normalizedManagedBackendUrl(value) {
  const url = normalizedHttpUrl(value);
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

function canonicalTokenPath(value, memoraxCodeHome) {
  const candidate = stringValue(value);
  if (!candidate || !isAbsolute(candidate)) return undefined;
  const expected = resolve(backendTokenPath(memoraxCodeHome));
  return resolve(candidate) === expected ? expected : undefined;
}

function readToken(path, memoraxCodeHome) {
  const state = readBackendTokenRecordState(memoraxCodeHome);
  if (state.status === "valid") return state.record.token;
  throw new BackendTokenRecordError(state, path);
}

function defaultMemoraxCodeHome() {
  return join(homedir(), ".memorax-code");
}

function stripIpv6Brackets(host) {
  return host.replace(/^\[|\]$/g, "");
}

function isLoopbackHost(host) {
  const normalized = stripIpv6Brackets(host.trim().toLowerCase());
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function timestampValue(value) {
  const candidate = stringValue(value);
  return candidate && Number.isFinite(Date.parse(candidate)) ? candidate : undefined;
}
