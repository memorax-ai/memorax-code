const DEFAULT_SERVICE_BASE_URL = "https://platform.memorax.net";
const PROVISION_PATH = "/account/api/v1/trial/provision";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 16_384;
const MAX_RETRY_AFTER_MS = 120_000;
const MARK_ID_PATTERN = /^mk_[0-9a-f]{64}$/;
const API_KEY_PATTERN = /^sk_[A-Za-z0-9_-]{43}$/;
const MACHINE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ERROR_REASONS = new Set([
  "invalid_options",
  "invalid_service_url",
  "tls_unsafe",
  "invalid_request",
  "aborted",
  "timeout",
  "transport",
  "response_too_large",
  "invalid_response",
  "response_contract",
  "rate_limit_exceeded",
  "server_error",
  "server_rejected",
]);

export class TrialProvisionClientError extends Error {
  constructor(reason, fields = {}) {
    const safeReason = ERROR_REASONS.has(reason) ? reason : "invalid_response";
    super(`Trial provision request failed (${safeReason})`);
    this.name = "TrialProvisionClientError";
    this.code = "TRIAL_PROVISION_CLIENT_FAILED";
    this.reason = safeReason;
    if (Number.isInteger(fields.httpStatus)) this.httpStatus = fields.httpStatus;
    if (Number.isSafeInteger(fields.retryAfterMs)
      && fields.retryAfterMs >= 0
      && fields.retryAfterMs <= MAX_RETRY_AFTER_MS) {
      this.retryAfterMs = fields.retryAfterMs;
    }
  }
}

export function createTrialProvisionClient(options = {}) {
  const serviceBaseUrl = validateServiceBaseUrl(
    options.serviceBaseUrl ?? DEFAULT_SERVICE_BASE_URL,
  );
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw clientError("invalid_options");
  const env = isRecord(options.env) ? options.env : process.env;
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0"
    || env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    throw clientError("tls_unsafe");
  }
  const timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 120_000);
  const maxResponseBytes = positiveInteger(
    options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    DEFAULT_MAX_RESPONSE_BYTES,
  );

  return Object.freeze({
    async provision(request, requestOptions = {}) {
      const snapshot = validateRequest(request);
      const body = JSON.stringify({
        mark_id: snapshot.markId,
        mark_version: snapshot.markVersion,
        app_salt: snapshot.appSalt,
        machine_id: snapshot.machineId,
        hostname: snapshot.hostname,
        platform: snapshot.platform,
        arch: snapshot.arch,
        mac_hash: snapshot.macHash,
      });
      const response = await postJson(
        `${serviceBaseUrl}${PROVISION_PATH}`,
        body,
        {
          fetchImpl,
          maxResponseBytes,
          signal: requestOptions.signal,
          timeoutMs,
        },
      );
      return mapProvisionResponse(response, snapshot.markId);
    },
  });
}

async function postJson(url, body, options) {
  const externalSignal = options.signal;
  if (externalSignal?.aborted) throw clientError("aborted");
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort();
  externalSignal?.addEventListener?.("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs);
  timer.unref?.();

  try {
    const response = await options.fetchImpl(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body,
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal: controller.signal,
    });
    return await readResponse(response, options.maxResponseBytes);
  } catch (error) {
    if (error instanceof TrialProvisionClientError) throw error;
    if (timedOut) throw clientError("timeout");
    if (externalSignal?.aborted) throw clientError("aborted");
    throw clientError("transport");
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener?.("abort", onAbort);
  }
}

async function readResponse(response, maxResponseBytes) {
  const status = response?.status;
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    throw clientError("invalid_response");
  }
  const contentLength = response.headers?.get?.("content-length");
  if (/^[0-9]+$/.test(contentLength ?? "")
    && Number(contentLength) > maxResponseBytes) {
    throw clientError("response_too_large", { httpStatus: status });
  }

  const text = await readResponseBody(response, maxResponseBytes, status);

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    if (status !== 200) throw responseError(status, response);
    throw clientError("invalid_response", { httpStatus: status });
  }
  if (status !== 200) {
    throw responseError(status, response, body);
  }
  if (!isRecord(body)) throw clientError("invalid_response", { httpStatus: status });
  if (body.success !== true) throw responseError(status, response, body);
  return body;
}

async function readResponseBody(response, maxResponseBytes, status) {
  if (response.body == null) return "";
  const reader = response.body.getReader?.();
  if (!reader || typeof reader.read !== "function") {
    throw clientError("invalid_response", { httpStatus: status });
  }
  const chunks = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        throw clientError("invalid_response", { httpStatus: status });
      }
      byteLength += value.byteLength;
      if (byteLength > maxResponseBytes) {
        await reader.cancel().catch(() => undefined);
        throw clientError("response_too_large", { httpStatus: status });
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks, byteLength).toString("utf8");
}

function responseError(status, response, body) {
  const retryAfterMs = retryAfterDelay(response.headers?.get?.("retry-after"), body);
  if (status === 429) {
    return clientError("rate_limit_exceeded", { httpStatus: status, retryAfterMs });
  }
  if (status >= 500) {
    return clientError("server_error", { httpStatus: status, retryAfterMs });
  }
  return clientError("server_rejected", { httpStatus: status, retryAfterMs });
}

function mapProvisionResponse(envelope, expectedMarkId) {
  const data = envelope.data;
  const accountId = decimalPublicId(data?.account_id);
  const projectId = decimalPublicId(data?.project_id);
  const apiKey = typeof data?.api_key === "string" && API_KEY_PATTERN.test(data.api_key)
    ? data.api_key
    : undefined;
  const keyPrefix = typeof data?.key_prefix === "string" ? data.key_prefix.trim() : "";
  if (!accountId
    || !projectId
    || data?.mark_id !== expectedMarkId
    || !apiKey
    || !keyPrefix
    || !apiKey.startsWith(keyPrefix)
    || typeof data?.created !== "boolean") {
    throw clientError("response_contract", { httpStatus: 200 });
  }
  return Object.freeze({
    accountId,
    projectId,
    apiKey,
    created: data.created,
  });
}

function validateRequest(request) {
  const snapshot = {
    markId: request?.markId,
    markVersion: request?.markVersion,
    appSalt: request?.appSalt,
    machineId: request?.machineId,
    hostname: request?.hostname,
    platform: request?.platform,
    arch: request?.arch,
    macHash: request?.macHash,
  };
  if (!MARK_ID_PATTERN.test(snapshot.markId ?? "")
    || snapshot.markVersion !== 1
    || snapshot.appSalt !== "memorax-plugin-v1"
    || !MACHINE_ID_PATTERN.test(snapshot.machineId ?? "")
    || !validText(snapshot.hostname, 120)
    || !["windows", "linux", "macos"].includes(snapshot.platform)
    || !["x86_64", "arm64"].includes(snapshot.arch)
    || !SHA256_PATTERN.test(snapshot.macHash ?? "")) {
    throw clientError("invalid_request");
  }
  return snapshot;
}

function validateServiceBaseUrl(value) {
  try {
    const url = new URL(value);
    if (typeof value !== "string"
      || value !== value.trim()
      || url.protocol !== "https:"
      || !url.hostname
      || url.username
      || url.password
      || url.search
      || url.hash
      || !["", "/"].includes(url.pathname)) {
      throw new Error();
    }
    return url.origin;
  } catch {
    throw clientError("invalid_service_url");
  }
}

function retryAfterDelay(header, body) {
  const headerText = typeof header === "string" ? header.trim() : "";
  let headerDelay;
  if (/^\d+$/.test(headerText)) {
    headerDelay = Number(headerText) * 1000;
  } else if (headerText) {
    const retryAt = Date.parse(headerText);
    if (Number.isFinite(retryAt)) headerDelay = Math.max(0, retryAt - Date.now());
  }
  if (Number.isSafeInteger(headerDelay) && headerDelay <= MAX_RETRY_AFTER_MS) {
    return headerDelay;
  }
  const bodySeconds = isRecord(body) && isRecord(body.error)
    ? body.error.retry_after_seconds
    : undefined;
  const delay = Number.isSafeInteger(bodySeconds) && bodySeconds >= 0
    ? bodySeconds * 1000
    : undefined;
  return Number.isSafeInteger(delay) && delay <= MAX_RETRY_AFTER_MS ? delay : undefined;
}

function validText(value, maximumLength) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximumLength
    && value === value.trim()
    && !value.includes("\0");
}

function decimalPublicId(value) {
  return typeof value === "string" && /^\d+$/.test(value) ? value : undefined;
}

function positiveInteger(value, maximum) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw clientError("invalid_options");
  }
  return value;
}

function clientError(reason, fields) {
  return new TrialProvisionClientError(reason, fields);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
