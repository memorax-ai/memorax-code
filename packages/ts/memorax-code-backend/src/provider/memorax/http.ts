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
  errorKind?: MemoraxInvocationErrorKind;
  httpStatus?: number;
  retryAfterMs?: number;
};

export type MemoraxJsonResponse = {
  body: unknown;
  quota?: MemoraxQuotaSnapshot;
};

type MemoraxRequestError = Error & {
  memoraxErrorKind?: MemoraxInvocationErrorKind;
  status?: number;
  retryAfterMs?: number;
};

export async function postMemoraxJson(
  config: MemoraxAdapterConfig,
  path: string,
  payload: unknown,
  fetchImpl: typeof fetch,
): Promise<MemoraxJsonResponse> {
  const controller = new AbortController();
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
      await response.arrayBuffer().catch(() => undefined);
      throw createMemoraxRequestError(`MemoraX HTTP ${response.status}`, "http", {
        status: response.status,
        retryAfterMs,
      });
    }
    const body = await response.json().catch(() => null);
    validateMemoraxEnvelope(body);
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

export async function getMemoraxJson(
  config: MemoraxAdapterConfig,
  path: string,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetchImpl(`${config.baseUrl}${path}`, {
      method: "GET",
      headers: {
        Authorization: `Token ${config.apiKey}`,
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
      await response.arrayBuffer().catch(() => undefined);
      throw createMemoraxRequestError(`MemoraX HTTP ${response.status}`, "http", {
        status: response.status,
        retryAfterMs,
      });
    }
    return await response.json().catch(() => null);
  } catch (error) {
    throw normalizeMemoraxRequestError(error, controller.signal.aborted);
  } finally {
    clearTimeout(timeout);
  }
}

export function memoraxInvocationFailure(error: unknown): MemoraxInvocationFailure {
  const requestError = error instanceof Error ? error as MemoraxRequestError : undefined;
  return {
    ok: false,
    error: formatMemoraxError(error),
    ...(requestError?.memoraxErrorKind ? { errorKind: requestError.memoraxErrorKind } : {}),
    ...(Number.isInteger(requestError?.status) ? { httpStatus: requestError?.status } : {}),
    ...(Number.isFinite(requestError?.retryAfterMs) ? { retryAfterMs: requestError?.retryAfterMs } : {}),
  };
}

function createMemoraxRequestError(
  message: string,
  kind: MemoraxInvocationErrorKind,
  fields: { status?: number; retryAfterMs?: number } = {},
): MemoraxRequestError {
  const error = new Error(message) as MemoraxRequestError;
  error.memoraxErrorKind = kind;
  if (fields.status !== undefined) error.status = fields.status;
  if (fields.retryAfterMs !== undefined) error.retryAfterMs = fields.retryAfterMs;
  return error;
}

function normalizeMemoraxRequestError(error: unknown, timedOut: boolean): MemoraxRequestError {
  if (isMemoraxRequestError(error)) return error;
  const kind = timedOut || (error instanceof Error && error.name === "AbortError")
    ? "timeout"
    : "transport";
  return createMemoraxRequestError(formatMemoraxError(error), kind);
}

function isMemoraxRequestError(error: unknown): error is MemoraxRequestError {
  if (!(error instanceof Error)) return false;
  const kind = (error as MemoraxRequestError).memoraxErrorKind;
  return kind === "http"
    || kind === "timeout"
    || kind === "transport"
    || kind === "response";
}

function formatMemoraxError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function parseRetryAfterMs(value: string | null, now = Date.now()): number | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  if (/^\d+$/.test(text)) return Number.parseInt(text, 10) * 1000;
  const at = Date.parse(text);
  if (!Number.isFinite(at)) return undefined;
  return Math.max(0, at - now);
}

function validateMemoraxEnvelope(raw: unknown): void {
  if (!isRecord(raw)) return;
  if (raw.success === false) {
    throw createMemoraxRequestError(memoraxEnvelopeErrorMessage(raw), "response");
  }
  const data = isRecord(raw.data) ? raw.data : undefined;
  const status = typeof data?.status === "string" ? data.status.trim().toLowerCase() : "";
  if (["failed", "error", "cancelled", "canceled"].includes(status)) {
    throw createMemoraxRequestError(memoraxEnvelopeErrorMessage(raw, `MemoraX task ${status}`), "response");
  }
}

function memoraxEnvelopeErrorMessage(raw: Record<string, unknown>, fallback = "MemoraX request failed"): string {
  const error = raw.error;
  if (typeof error === "string" && error.trim()) return error.trim();
  if (isRecord(error)) {
    for (const key of ["message", "detail", "error"]) {
      const value = error[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  const data = isRecord(raw.data) ? raw.data : undefined;
  const message = data?.message ?? data?.error;
  if (typeof message === "string" && message.trim()) return message.trim();
  return fallback;
}
