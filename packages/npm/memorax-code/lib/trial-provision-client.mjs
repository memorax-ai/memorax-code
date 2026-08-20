const DEFAULT_SERVICE_BASE_URL = "https://platform.memorax.net";
const PROVISION_PATH = "/account/api/v1/trial/provision";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 16_384;
const MAX_REQUEST_BYTES = 4_096;
const MAX_RETRY_AFTER_MS = 120_000;
const MARK_ID_PATTERN = /^mk_[0-9a-f]{64}$/;
const API_KEY_PATTERN = /^sk_[A-Za-z0-9_-]{43}$/;
const MACHINE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const JSON_CONTENT_TYPE_PATTERN = /^(?:application\/json|[^;\s]+\/[^;\s]+\+json)(?:\s*;|$)/i;

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
  "rate_limit_exceeded",
  "server_error",
  "server_rejected",
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
    const safeReason = LOCAL_ERROR_REASONS.has(reason) ? reason : "invalid_response";
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
  const timeoutMs = positiveBoundedInteger(options?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const maxResponseBytes = positiveBoundedInteger(
    options?.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    DEFAULT_MAX_RESPONSE_BYTES,
  );
  const now = options?.now ?? Date.now;
  if (typeof now !== "function") throw clientError("invalid_options");

  return Object.freeze({
    async provision(request, requestOptions = {}) {
      const snapshot = snapshotProvisionRequest(request);
      const response = await postJson({
        url: `${serviceBaseUrl}${PROVISION_PATH}`,
        body: {
          mark_id: snapshot.markId,
          mark_version: snapshot.markVersion,
          app_salt: snapshot.appSalt,
          machine_id: snapshot.machineId,
          hostname: snapshot.hostname,
          platform: snapshot.platform,
          arch: snapshot.arch,
          mac_hash: snapshot.macHash,
        },
        timeoutMs,
        maxResponseBytes,
        fetchImpl,
        now,
        signal: requestOptions?.signal,
      });
      try {
        return mapProvisionResponse(response, snapshot.markId);
      } catch (error) {
        if (error instanceof TrialProvisionClientError) throw error;
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
  const body = JSON_CONTENT_TYPE_PATTERN.test(contentType)
    ? tryParseJsonRecord(text)
    : undefined;

  if (status !== 200) {
    throw responseError(status, retryAfter, body, options.now);
  }
  if (!body) throw clientError("invalid_response", { httpStatus: status });
  if (body.success === false) {
    throw responseError(status, retryAfter, body, options.now);
  }
  return body;
}

function responseError(status, retryAfter, body, now) {
  const retryAfterMs = retryAfterFromResponse(retryAfter, body, now);
  if (status === 429) {
    return clientError("rate_limit_exceeded", { httpStatus: status, retryAfterMs });
  }
  if (status >= 500) {
    return clientError("server_error", { httpStatus: status, retryAfterMs });
  }
  return clientError("server_rejected", { httpStatus: status, retryAfterMs });
}

function mapProvisionResponse(envelope, expectedMarkId) {
  if (!isRecord(envelope) || envelope.success !== true || !isRecord(envelope.data)) {
    throw clientError("response_contract", { httpStatus: 200 });
  }
  const data = envelope.data;
  const accountId = decimalPublicId(data.account_id);
  const projectId = decimalPublicId(data.project_id);
  const apiKey = typeof data.api_key === "string" && API_KEY_PATTERN.test(data.api_key)
    ? data.api_key
    : undefined;
  const keyPrefix = typeof data.key_prefix === "string" && data.key_prefix.trim()
    ? data.key_prefix.trim()
    : undefined;
  if (!accountId
    || !projectId
    || data.mark_id !== expectedMarkId
    || !apiKey
    || !keyPrefix
    || !apiKey.startsWith(keyPrefix)
    || typeof data.created !== "boolean") {
    throw clientError("response_contract", { httpStatus: 200 });
  }
  return Object.freeze({
    accountId,
    projectId,
    apiKey,
    created: data.created,
  });
}

function snapshotProvisionRequest(request) {
  let snapshot;
  try {
    snapshot = {
      markId: request?.markId,
      markVersion: request?.markVersion,
      appSalt: request?.appSalt,
      machineId: request?.machineId,
      hostname: request?.hostname,
      platform: request?.platform,
      arch: request?.arch,
      macHash: request?.macHash,
    };
  } catch {
    throw clientError("invalid_request");
  }
  if (typeof snapshot.markId !== "string" || !MARK_ID_PATTERN.test(snapshot.markId)
    || snapshot.markVersion !== 1
    || snapshot.appSalt !== "memorax-plugin-v1"
    || typeof snapshot.machineId !== "string"
    || !MACHINE_ID_PATTERN.test(snapshot.machineId)
    || !validBoundedString(snapshot.hostname, 120)
    || !["windows", "linux", "macos"].includes(snapshot.platform)
    || !["x86_64", "arm64"].includes(snapshot.arch)
    || typeof snapshot.macHash !== "string"
    || !SHA256_PATTERN.test(snapshot.macHash)) {
    throw clientError("invalid_request");
  }
  return snapshot;
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

function retryAfterFromResponse(header, body, now) {
  const fromHeader = parseRetryAfter(header, now);
  if (fromHeader !== undefined) return fromHeader;
  const error = isRecord(body?.error) ? body.error : undefined;
  const seconds = error?.retry_after_seconds;
  if (!Number.isSafeInteger(seconds) || seconds < 0) return undefined;
  const delay = seconds * 1000;
  return Number.isSafeInteger(delay) && delay <= MAX_RETRY_AFTER_MS ? delay : undefined;
}

function parseRetryAfter(value, now) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const text = value.trim();
  let delay;
  if (/^[0-9]+$/.test(text)) {
    const seconds = Number(text);
    if (!Number.isSafeInteger(seconds)) return undefined;
    delay = seconds * 1000;
  } else {
    if (!/[A-Za-z]/.test(text)) return undefined;
    let current;
    try {
      current = now();
    } catch {
      return undefined;
    }
    const at = Date.parse(text);
    if (!Number.isFinite(at) || !Number.isFinite(current)) return undefined;
    delay = Math.max(0, at - current);
  }
  return Number.isSafeInteger(delay) && delay <= MAX_RETRY_AFTER_MS ? delay : undefined;
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

function validBoundedString(value, maxLength) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maxLength
    && !value.includes("\0")
    && value === value.trim();
}

function decimalPublicId(value) {
  return typeof value === "string" && /^[0-9]+$/.test(value) ? value : undefined;
}

function tryParseJsonRecord(text) {
  try {
    const value = JSON.parse(text);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
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
