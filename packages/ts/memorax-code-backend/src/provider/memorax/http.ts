import type { MemoraxAdapterConfig } from "./config.js";
import { isRecord } from "../../shared/record.js";
import {
  memoraxQuotaFromResponse,
  type MemoraxQuotaSnapshot,
} from "./quota.js";

export type MemoraxInvocationErrorKind = "http" | "timeout" | "transport" | "response";

export type MemoraxInvocationFailure = {
  ok: false;
  error: string;
  errorCode?: string;
  errorKind?: MemoraxInvocationErrorKind;
  httpStatus?: number;
  retryAfterMs?: number;
  systemCode?: string;
};

export type MemoraxJsonResponse = {
  body: unknown;
  quota?: MemoraxQuotaSnapshot;
};

class MemoraxRequestError extends Error {
  constructor(
    message: string,
    readonly errorKind: MemoraxInvocationErrorKind,
    readonly errorCode: string,
    readonly fields: { httpStatus?: number; retryAfterMs?: number; systemCode?: string } = {},
  ) {
    super(message);
  }
}

const SYSTEM_CODE_MESSAGES: Record<string, string> = {
  ENOTFOUND: "MemoraX hostname could not be resolved",
  EAI_AGAIN: "MemoraX hostname resolution temporarily failed",
  ECONNREFUSED: "MemoraX connection was refused",
  ECONNRESET: "MemoraX connection was reset",
  EPIPE: "MemoraX connection closed unexpectedly",
  ENETUNREACH: "MemoraX network is unreachable",
  EHOSTUNREACH: "MemoraX host is unreachable",
  ETIMEDOUT: "MemoraX request timed out",
  ESOCKETTIMEDOUT: "MemoraX request timed out",
  UND_ERR_CONNECT_TIMEOUT: "MemoraX connection timed out",
  UND_ERR_HEADERS_TIMEOUT: "MemoraX response headers timed out",
  UND_ERR_BODY_TIMEOUT: "MemoraX response body timed out",
  UND_ERR_SOCKET: "MemoraX connection closed unexpectedly",
  DEPTH_ZERO_SELF_SIGNED_CERT: "MemoraX TLS certificate validation failed",
  SELF_SIGNED_CERT_IN_CHAIN: "MemoraX TLS certificate validation failed",
  CERT_HAS_EXPIRED: "MemoraX TLS certificate validation failed",
  CERT_NOT_YET_VALID: "MemoraX TLS certificate validation failed",
  ERR_TLS_CERT_ALTNAME_INVALID: "MemoraX TLS certificate validation failed",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "MemoraX TLS certificate validation failed",
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: "MemoraX TLS certificate validation failed",
  ERR_SSL_WRONG_VERSION_NUMBER: "MemoraX TLS handshake failed",
  ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE: "MemoraX TLS handshake failed",
};

export async function postMemoraxJson(
  config: MemoraxAdapterConfig,
  path: string,
  payload: unknown,
  fetchImpl: typeof fetch,
): Promise<MemoraxJsonResponse> {
  const controller = new AbortController();
  // The deadline covers headers and body; HTTP success alone is not acceptance.
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetchImpl(`${config.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Token ${config.apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
      // Error bodies may echo private input. Let the caller retry from status
      // and Retry-After without including that content in diagnostics.
      await response.arrayBuffer().catch(() => undefined);
      throw new MemoraxRequestError(`MemoraX HTTP ${response.status}`, "http", "MEMORAX_HTTP_ERROR", {
        httpStatus: response.status,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      });
    }
    const body = await response.json().catch((error: unknown) => {
      // SyntaxError messages can include response fragments. Preserve body
      // timeout/transport failures so the caller's retry policy still applies.
      if (error instanceof SyntaxError) {
        throw new MemoraxRequestError("MemoraX response body must be valid JSON", "response", "MEMORAX_INVALID_JSON");
      }
      throw error;
    });
    validateMemoraxEnvelope(body, path);
    const featureCode = path === "/v1/memories/add"
      ? "memory_write"
      : path === "/v1/memories/search"
        ? "memory_search"
        : undefined;
    const quota = featureCode ? memoraxQuotaFromResponse(body, featureCode) : undefined;
    return { body, ...(quota ? { quota } : {}) };
  } catch (error) {
    throw normalizeMemoraxRequestError(error, controller.signal.aborted);
  } finally {
    clearTimeout(timeout);
  }
}

export function memoraxInvocationFailure(error: unknown): MemoraxInvocationFailure {
  const requestError = normalizeMemoraxRequestError(error, false);
  return {
    ok: false,
    error: requestError.message,
    errorCode: requestError.errorCode,
    errorKind: requestError.errorKind,
    ...requestError.fields,
  };
}

function normalizeMemoraxRequestError(error: unknown, timedOut: boolean): MemoraxRequestError {
  if (error instanceof MemoraxRequestError) return error;
  const systemCode = memoraxSystemCode(error);
  const timeout = timedOut
    || (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name))
    || (systemCode !== undefined && /TIME(?:DOUT|OUT)$/.test(systemCode));
  return new MemoraxRequestError(
    timeout ? "MemoraX request timed out" : systemCode ? SYSTEM_CODE_MESSAGES[systemCode]! : "MemoraX transport failed",
    timeout ? "timeout" : "transport",
    timeout ? "MEMORAX_TIMEOUT" : "MEMORAX_TRANSPORT_ERROR",
    systemCode ? { systemCode } : {},
  );
}

function memoraxSystemCode(error: unknown): string | undefined {
  const pending: unknown[] = [error];
  const visited = new Set<object>();
  // Node fetch can nest socket errors in causes and AggregateError entries.
  // Only known machine codes cross this boundary; messages and other fields do not.
  for (let index = 0; index < pending.length && index < 16; index += 1) {
    const candidate = pending[index];
    if (!isRecord(candidate) || visited.has(candidate)) continue;
    visited.add(candidate);
    if (typeof candidate.code === "string" && Object.hasOwn(SYSTEM_CODE_MESSAGES, candidate.code)) return candidate.code;
    if (candidate.cause) pending.push(candidate.cause);
    if (Array.isArray(candidate.errors)) pending.push(...candidate.errors.slice(0, 16));
  }
  return undefined;
}

function parseRetryAfterMs(value: string | null, now = Date.now()): number | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  if (/^\d+$/.test(text)) {
    const milliseconds = Number.parseInt(text, 10) * 1000;
    return Number.isFinite(milliseconds) ? milliseconds : undefined;
  }
  const at = Date.parse(text);
  if (!Number.isFinite(at)) return undefined;
  return Math.max(0, at - now);
}

function validateMemoraxEnvelope(raw: unknown, path: string): void {
  const data = isRecord(raw) && isRecord(raw.data) ? raw.data : undefined;
  const status = typeof data?.status === "string" ? data.status.trim().toLowerCase() : "";
  if ((isRecord(raw) && raw.success === false) || ["failed", "error", "cancelled", "canceled"].includes(status)) {
    throw new MemoraxRequestError("MemoraX response reported failure", "response", "MEMORAX_RESPONSE_REJECTED");
  }
  const valid = path === "/v1/memories/search"
    ? Array.isArray(raw) || (isRecord(raw) && Array.isArray(raw.data)) || Array.isArray(data?.data)
    : path === "/v1/memories/add"
      ? isRecord(raw) && (raw.success === true || (
        typeof data?.task_id === "string"
        && Boolean(data.task_id.trim())
        && ["accepted", "queued", "completed"].includes(status)
      ))
      : true;
  if (!valid) {
    throw new MemoraxRequestError("MemoraX response has an invalid shape", "response", "MEMORAX_INVALID_RESPONSE");
  }
}
