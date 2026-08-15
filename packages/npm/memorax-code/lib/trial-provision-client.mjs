import {
  mapTrialProvisionResponse,
  safeTrialRegisterUrl,
} from "./trial-provision-contract.mjs";

const DEFAULT_SERVICE_BASE_URL = "https://platform.memorax.net";
const CHALLENGE_PATH = "/account/api/v1/trial/pow-challenge";
const PROVISION_PATH = "/account/api/v1/trial/provision";
const DEFAULT_CHALLENGE_TIMEOUT_MS = 10_000;
const DEFAULT_PROVISION_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 16_384;
const MAX_REQUEST_BYTES = 4_096;
const MAX_RETRY_AFTER_MS = 120_000;
const PLUGIN_MARK_PATTERN = /^mk_[0-9a-f]{32}$/;
const API_KEY_PATTERN = /^sk_[A-Za-z0-9_-]{43}$/;
const POW_CHALLENGE_PATTERN = /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const POW_NONCE_PATTERN = /^(?:0|[1-9][0-9]{0,18})$/;
const MAX_POW_NONCE = 9_223_372_036_854_775_807n;
const JSON_CONTENT_TYPE_PATTERN = /^(?:application\/json|[^;\s]+\/[^;\s]+\+json)(?:\s*;|$)/i;

const SERVER_ERROR_STATUS = new Map([
  ["rate_limit_exceeded", 429],
  ["trial_capacity_exceeded", 429],
  ["trial_ip_capacity_exceeded", 429],
  ["trial_capacity_unavailable", 503],
  ["trial_disabled", 503],
  ["pow_expired", 400],
  ["pow_invalid", 400],
  ["trial_api_key_mismatch", 409],
  ["plugin_mark_already_claimed", 409],
  ["trial_expired", 410],
  ["account_inactive", 403],
]);
const LOCAL_ERROR_REASONS = new Set([
  "invalid_options",
  "invalid_service_url",
  "tls_unsafe",
  "invalid_request",
  "aborted",
  "timeout",
  "transport",
  "tls_failed",
  "response_too_large",
  "invalid_response",
  "response_contract",
  "unexpected_http_status",
  "server_error",
]);
const TLS_ERROR_CODES = new Set([
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

export class TrialProvisionClientError extends Error {
  constructor(reason, fields = {}) {
    const safeReason = SERVER_ERROR_STATUS.has(reason) || LOCAL_ERROR_REASONS.has(reason)
      ? reason
      : "invalid_response";
    super(`Trial provision request failed (${safeReason})`);
    this.name = "TrialProvisionClientError";
    this.code = "TRIAL_PROVISION_CLIENT_FAILED";
    this.reason = safeReason;
    if (Number.isInteger(fields.httpStatus)
      && fields.httpStatus >= 100
      && fields.httpStatus <= 599) {
      this.httpStatus = fields.httpStatus;
    }
    if (Number.isSafeInteger(fields.retryAfterMs)
      && fields.retryAfterMs >= 0
      && fields.retryAfterMs <= MAX_RETRY_AFTER_MS) {
      this.retryAfterMs = fields.retryAfterMs;
    }
    if (fields.retryAfterExceeded === true) this.retryAfterExceeded = true;
    const registerUrl = safeTrialRegisterUrl(fields.registerUrl);
    if (registerUrl) this.registerUrl = registerUrl;
  }
}

export function createTrialProvisionClient(options = {}) {
  const serviceBaseUrl = validateServiceBaseUrl(
    options?.serviceBaseUrl ?? DEFAULT_SERVICE_BASE_URL,
  );
  const fetchImpl = options?.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw clientError("invalid_options");
  const env = isRecord(options?.env) ? options.env : process.env;
  if (readEnvironmentValue(env, "NODE_TLS_REJECT_UNAUTHORIZED") === "0") {
    throw clientError("tls_unsafe");
  }
  const challengeTimeoutMs = positiveBoundedInteger(
    options?.challengeTimeoutMs ?? DEFAULT_CHALLENGE_TIMEOUT_MS,
  );
  const provisionTimeoutMs = positiveBoundedInteger(
    options?.provisionTimeoutMs ?? DEFAULT_PROVISION_TIMEOUT_MS,
  );
  const maxResponseBytes = positiveBoundedInteger(
    options?.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    DEFAULT_MAX_RESPONSE_BYTES,
  );
  const now = options?.now ?? Date.now;
  if (typeof now !== "function") throw clientError("invalid_options");

  return Object.freeze({
    async requestPowChallenge(pluginMark, requestOptions = {}) {
      const mark = validPluginMark(pluginMark);
      const response = await postJson({
        url: `${serviceBaseUrl}${CHALLENGE_PATH}`,
        body: { plugin_mark: mark },
        timeoutMs: challengeTimeoutMs,
        maxResponseBytes,
        fetchImpl,
        now,
        signal: requestOptions?.signal,
      });
      return mapChallengeResponse(response);
    },

    async provision(request, requestOptions = {}) {
      const snapshot = snapshotProvisionRequest(request);
      const response = await postJson({
        url: `${serviceBaseUrl}${PROVISION_PATH}`,
        body: {
          plugin_mark: snapshot.pluginMark,
          client_api_key: snapshot.apiKey,
          pow_challenge: snapshot.powChallenge,
          pow_nonce: snapshot.powNonce,
          recover_api_key: snapshot.recoverApiKey,
          display_name: null,
        },
        timeoutMs: provisionTimeoutMs,
        maxResponseBytes,
        fetchImpl,
        now,
        signal: requestOptions?.signal,
      });
      try {
        return mapTrialProvisionResponse(response, {
          expectedPluginMark: snapshot.pluginMark,
          expectedApiKey: snapshot.apiKey,
        });
      } catch {
        throw clientError("response_contract", { httpStatus: 200 });
      }
    },
  });
}

async function postJson(options) {
  let serialized;
  try {
    serialized = JSON.stringify(options.body);
  } catch {
    throw clientError("invalid_request");
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_REQUEST_BYTES) {
    throw clientError("invalid_request");
  }

  const controller = new AbortController();
  const externalSignal = options.signal;
  if (externalSignal?.aborted) throw clientError("aborted");
  let timedOut = false;
  const onAbort = () => controller.abort();
  externalSignal?.addEventListener?.("abort", onAbort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs);
  timeout.unref?.();

  try {
    const response = await options.fetchImpl(options.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: serialized,
      redirect: "error",
      cache: "no-store",
      credentials: "omit",
      signal: controller.signal,
    });
    return await interpretResponse(response, {
      maxResponseBytes: options.maxResponseBytes,
      now: options.now,
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof TrialProvisionClientError) throw error;
    if (timedOut) throw clientError("timeout");
    if (externalSignal?.aborted) throw clientError("aborted");
    if (isTlsFailure(error)) throw clientError("tls_failed");
    throw clientError("transport");
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener?.("abort", onAbort);
  }
}

async function interpretResponse(response, options) {
  let status;
  let contentType;
  let retryAfter;
  try {
    status = response?.status;
    contentType = response?.headers?.get("content-type") ?? "";
    retryAfter = response?.headers?.get("retry-after");
  } catch {
    throw clientError("invalid_response");
  }
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    throw clientError("invalid_response");
  }

  let text;
  try {
    text = await readBoundedResponseText(response, options);
  } catch (error) {
    if (options.signal?.aborted) throw error;
    if (error instanceof TrialProvisionClientError) {
      throw clientError(error.reason, { httpStatus: status });
    }
    throw clientError("invalid_response", { httpStatus: status });
  }
  if (status === 200) {
    if (!JSON_CONTENT_TYPE_PATTERN.test(contentType)) {
      throw clientError("invalid_response", { httpStatus: status });
    }
    const body = tryParseJsonRecord(text);
    if (!body) throw clientError("invalid_response", { httpStatus: status });
    return body;
  }

  let body;
  if (JSON_CONTENT_TYPE_PATTERN.test(contentType)) {
    body = tryParseJsonRecord(text);
  }
  const serverCode = typeof body?.code === "string" ? body.code : undefined;
  const expectedStatus = SERVER_ERROR_STATUS.get(serverCode);
  if (expectedStatus !== undefined) {
    if (expectedStatus !== status) {
      throw clientError("unexpected_http_status", { httpStatus: status });
    }
    const parsedRetryAfter = parseRetryAfter(retryAfter, options.now);
    throw clientError(serverCode, {
      httpStatus: status,
      retryAfterMs: parsedRetryAfter.value,
      retryAfterExceeded: parsedRetryAfter.exceeded,
      registerUrl: isRecord(body.details) ? body.details.register_url : undefined,
    });
  }
  if (status >= 500) {
    throw clientError("server_error", { httpStatus: status });
  }
  throw clientError("unexpected_http_status", { httpStatus: status });
}

async function readBoundedResponseText(response, options) {
  let reader;
  try {
    const contentLength = response?.headers?.get("content-length");
    if (/^[0-9]+$/.test(contentLength ?? "")
      && Number(contentLength) > options.maxResponseBytes) {
      cancelBody(response?.body);
      throw clientError("response_too_large");
    }
    reader = response?.body?.getReader?.();
  } catch (error) {
    if (error instanceof TrialProvisionClientError) throw error;
    throw clientError("invalid_response");
  }
  if (!reader || typeof reader.read !== "function") throw clientError("invalid_response");
  if (options.signal?.aborted) {
    cancelBody(reader);
    throw new Error("aborted");
  }

  const chunks = [];
  let total = 0;
  let rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(new Error("aborted"));
  options.signal?.addEventListener?.("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  try {
    while (true) {
      const item = await Promise.race([reader.read(), aborted]);
      if (!isRecord(item) || typeof item.done !== "boolean") {
        throw clientError("invalid_response");
      }
      if (item.done) break;
      if (!(item.value instanceof Uint8Array)) throw clientError("invalid_response");
      total += item.value.byteLength;
      if (total > options.maxResponseBytes) {
        cancelBody(reader);
        throw clientError("response_too_large");
      }
      chunks.push(Buffer.from(item.value));
    }
  } finally {
    options.signal?.removeEventListener?.("abort", onAbort);
    if (options.signal?.aborted) cancelBody(reader);
  }

  try {
    return new TextDecoder("utf-8", { fatal: true })
      .decode(Buffer.concat(chunks, total));
  } catch {
    throw clientError("invalid_response");
  }
}

function mapChallengeResponse(value) {
  if (!isRecord(value)) throw clientError("invalid_response");
  const snapshot = {
    powChallenge: value.pow_challenge,
    difficultyBits: value.difficulty_bits,
    algorithm: value.algorithm,
    expiresAt: value.expires_at,
  };
  if (typeof snapshot.powChallenge !== "string"
    || snapshot.powChallenge.length > 1024
    || !POW_CHALLENGE_PATTERN.test(snapshot.powChallenge)
    || !Number.isInteger(snapshot.difficultyBits)
    || snapshot.difficultyBits < 0
    || snapshot.difficultyBits > 28
    || snapshot.algorithm !== "sha256"
    || typeof snapshot.expiresAt !== "string"
    || !snapshot.expiresAt
    || !Number.isFinite(Date.parse(snapshot.expiresAt))) {
    throw clientError("invalid_response");
  }
  return Object.freeze(snapshot);
}

function snapshotProvisionRequest(request) {
  let snapshot;
  try {
    snapshot = {
      pluginMark: request?.pluginMark,
      apiKey: request?.apiKey,
      powChallenge: request?.powChallenge,
      powNonce: request?.powNonce,
      recoverApiKey: request?.recoverApiKey,
    };
  } catch {
    throw clientError("invalid_request");
  }
  snapshot.pluginMark = validPluginMark(snapshot.pluginMark);
  if (typeof snapshot.apiKey !== "string" || !API_KEY_PATTERN.test(snapshot.apiKey)) {
    throw clientError("invalid_request");
  }
  if (typeof snapshot.powChallenge !== "string"
    || snapshot.powChallenge.length > 1024
    || !POW_CHALLENGE_PATTERN.test(snapshot.powChallenge)) {
    throw clientError("invalid_request");
  }
  if (!validPowNonce(snapshot.powNonce) || typeof snapshot.recoverApiKey !== "boolean") {
    throw clientError("invalid_request");
  }
  return snapshot;
}

function validPluginMark(value) {
  if (typeof value !== "string" || !PLUGIN_MARK_PATTERN.test(value)) {
    throw clientError("invalid_request");
  }
  return value;
}

function validPowNonce(value) {
  if (typeof value !== "string" || !POW_NONCE_PATTERN.test(value)) return false;
  try {
    return BigInt(value) <= MAX_POW_NONCE;
  } catch {
    return false;
  }
}

function validateServiceBaseUrl(value) {
  if (typeof value !== "string"
    || !value
    || value !== value.trim()
    || value.includes("\0")) {
    throw clientError("invalid_service_url");
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "https:"
      || !url.hostname
      || url.username
      || url.password
      || url.search
      || url.hash
      || (url.pathname !== "/" && url.pathname !== "")) {
      throw clientError("invalid_service_url");
    }
    return url.origin;
  } catch (error) {
    if (error instanceof TrialProvisionClientError) throw error;
    throw clientError("invalid_service_url");
  }
}

function tryParseJsonRecord(text) {
  try {
    const value = JSON.parse(text);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function parseRetryAfter(value, now) {
  if (typeof value !== "string" || !value.trim()) return {};
  const text = value.trim();
  let delay;
  if (/^[0-9]+$/.test(text)) {
    const seconds = Number(text);
    if (!Number.isSafeInteger(seconds)) return { exceeded: true };
    delay = seconds * 1000;
  } else {
    if (!/[A-Za-z]/.test(text)) return {};
    let current;
    try {
      current = now();
    } catch {
      return {};
    }
    const at = Date.parse(text);
    if (!Number.isFinite(at) || !Number.isFinite(current)) return {};
    delay = Math.max(0, at - current);
  }
  if (!Number.isSafeInteger(delay) || delay > MAX_RETRY_AFTER_MS) {
    return { exceeded: true };
  }
  return { value: delay };
}

function positiveBoundedInteger(value, maximum = 120_000) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw clientError("invalid_options");
  }
  return value;
}

function readEnvironmentValue(env, name) {
  try {
    return env[name];
  } catch {
    throw clientError("tls_unsafe");
  }
}

function isTlsFailure(error) {
  try {
    const code = error?.code ?? error?.cause?.code;
    return typeof code === "string"
      && (TLS_ERROR_CODES.has(code) || code.startsWith("ERR_TLS_") || code.startsWith("ERR_SSL_"));
  } catch {
    return false;
  }
}

function cancelBody(target) {
  try {
    const pending = target?.cancel?.();
    if (pending && typeof pending.then === "function") {
      Promise.resolve(pending).catch(() => undefined);
    }
  } catch {
    // Cancellation is best effort; the bounded client error remains authoritative.
  }
}

function clientError(reason, fields) {
  return new TrialProvisionClientError(reason, fields);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
