//! Local backend health probe used by lifecycle status.

import { resolve } from "node:path";

export type BackendHealthState = {
  sessionHome: string;
};

export type BackendHealthReport = {
  ok: boolean;
  url: string;
  status?: number;
  authRequired?: boolean;
  service?: string;
  instanceId?: string;
  state?: BackendHealthState;
  identity?: BackendStatusIdentity;
  error?: string;
  errorCode?: string;
};

export type BackendStatusReport = BackendHealthReport;

export type ExpectedBackendStatusIdentity = {
  url: string;
  instanceId?: string;
  sessionHome?: string;
};

export type BackendStatusIdentity = {
  urlMatches: boolean;
  instanceIdMatches: boolean;
  sessionHomeMatches: boolean;
};

export async function runBackendStatus(
  backendUrl: string,
  backendToken?: string,
  timeoutMs = 5000,
  expectedIdentity?: ExpectedBackendStatusIdentity,
): Promise<BackendStatusReport> {
  try {
    const response = await fetch(new URL("/health", backendUrl), {
      headers: backendHeaders(backendToken),
      signal: AbortSignal.timeout(Math.max(1, Math.trunc(timeoutMs))),
    });
    const body = await response.json().catch(() => ({})) as {
      ok?: unknown;
      service?: unknown;
      instanceId?: unknown;
      authRequired?: unknown;
      state?: BackendHealthState;
    };
    const service = typeof body.service === "string" ? body.service : undefined;
    const instanceId = typeof body.instanceId === "string" ? body.instanceId : undefined;
    const identity = expectedIdentity
      ? {
          urlMatches: normalizeUrl(backendUrl) === normalizeUrl(expectedIdentity.url),
          instanceIdMatches: !expectedIdentity.instanceId || instanceId === expectedIdentity.instanceId,
          sessionHomeMatches: !expectedIdentity.sessionHome
            || (typeof body.state?.sessionHome === "string"
              && resolve(body.state.sessionHome) === resolve(expectedIdentity.sessionHome)),
        }
      : undefined;
    return {
      ok: response.ok
        && body.ok === true
        && service === "memorax-code-backend"
        && (!identity || (identity.urlMatches && identity.instanceIdMatches && identity.sessionHomeMatches)),
      url: backendUrl,
      status: response.status,
      service,
      instanceId,
      authRequired: typeof body.authRequired === "boolean" ? body.authRequired : undefined,
      state: body.state,
      identity,
    };
  } catch (error) {
    return { ok: false, url: backendUrl, error: error instanceof Error ? error.message : String(error) };
  }
}

function normalizeUrl(value: string): string {
  try {
    return new URL(value).toString().replace(/\/+$/, "");
  } catch {
    return value.replace(/\/+$/, "");
  }
}

function backendHeaders(backendToken?: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...extra,
    connection: "close",
    ...(backendToken ? { authorization: `Bearer ${backendToken}` } : {}),
  };
}
