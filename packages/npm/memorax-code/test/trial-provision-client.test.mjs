import assert from "node:assert/strict";
import test from "node:test";
import {
  createTrialProvisionClient,
  TrialProvisionClientError,
} from "../lib/trial-provision-client.mjs";

const API_KEY = `sk_${"A".repeat(43)}`;
const REQUEST = Object.freeze({
  markId: "mk_e07c335dfbdd06d4752cf8a17e7d4f82555bf4828d82a8efa7cc5b527d4c858e",
  markVersion: 1,
  appSalt: "memorax-plugin-v1",
  machineId: "550e8400-e29b-41d4-a716-446655440000",
  hostname: "DESKTOP-DEMO",
  platform: "windows",
  arch: "x86_64",
  macHash: "b".repeat(64),
});

function successEnvelope(overrides = {}) {
  return {
    success: true,
    data: {
      account_id: "341599238100099072",
      project_id: "347677365196820482",
      mark_id: REQUEST.markId,
      key_prefix: API_KEY.slice(0, 10),
      api_key: API_KEY,
      created: true,
      ...overrides,
    },
    error: null,
    page: null,
  };
}

test("provision rejects invalid local fields before network access", async () => {
  let called = false;
  const client = createTrialProvisionClient({
    env: {},
    fetchImpl: async () => {
      called = true;
      return jsonResponse(successEnvelope());
    },
  });
  for (const overrides of [
    { markId: `mk_${"a".repeat(32)}` },
    { markVersion: 2 },
    { appSalt: "@memorax/memorax-code@0.1.2" },
    { machineId: "contains spaces" },
    { hostname: "" },
    { platform: "win32" },
    { arch: "x64" },
    { macHash: "b".repeat(63) },
  ]) {
    await assert.rejects(
      client.provision({ ...REQUEST, ...overrides }),
      clientError("invalid_request"),
    );
  }
  assert.equal(called, false);
});

test("provision requires the response envelope to contain a fresh matching api_key", async () => {
  for (const overrides of [
    { account_id: 123 },
    { mark_id: `mk_${"f".repeat(64)}` },
    { api_key: null },
    { api_key: `sk_${"short"}` },
    { key_prefix: "sk_other" },
    { created: "true" },
  ]) {
    const client = createTrialProvisionClient({
      env: {},
      fetchImpl: async () => jsonResponse(successEnvelope(overrides)),
    });
    await assert.rejects(client.provision(REQUEST), clientError("response_contract"));
  }
});

test("provision maps response-envelope and HTTP failures without exposing response data", async () => {
  const rejected = createTrialProvisionClient({
    env: {},
    fetchImpl: async () => jsonResponse({
      success: false,
      data: null,
      error: {
        code: "account.trial.provision.mark_mismatch",
        message: API_KEY,
        retry_after_seconds: 3,
      },
    }),
  });
  await assert.rejects(rejected.provision(REQUEST), (error) => {
    assert.ok(error instanceof TrialProvisionClientError);
    assert.equal(error.reason, "server_rejected");
    assert.equal(error.retryAfterMs, 3_000);
    assert.equal(`${error.message} ${error.stack}`.includes(API_KEY), false);
    return true;
  });

  const limited = createTrialProvisionClient({
    env: {},
    fetchImpl: async () => jsonResponse({ success: false, error: null }, {
      status: 429,
      headers: { "retry-after": "2" },
    }),
  });
  await assert.rejects(limited.provision(REQUEST), (error) => {
    assert.equal(error.reason, "rate_limit_exceeded");
    assert.equal(error.httpStatus, 429);
    assert.equal(error.retryAfterMs, 2_000);
    return true;
  });

  const retryAt = new Date(Date.now() + 60_000).toUTCString();
  const dated = createTrialProvisionClient({
    env: {},
    fetchImpl: async () => jsonResponse({ success: false, error: null }, {
      status: 429,
      headers: { "retry-after": retryAt },
    }),
  });
  await assert.rejects(dated.provision(REQUEST), (error) => {
    assert.equal(error.reason, "rate_limit_exceeded");
    assert.ok(error.retryAfterMs > 0 && error.retryAfterMs <= 60_000);
    return true;
  });
});

test("provision maps non-JSON HTTP failures by status", async () => {
  for (const [status, body, reason] of [
    [429, "", "rate_limit_exceeded"],
    [503, "temporarily unavailable", "server_error"],
  ]) {
    const client = createTrialProvisionClient({
      env: {},
      fetchImpl: async () => new Response(body, { status }),
    });
    await assert.rejects(client.provision(REQUEST), clientError(reason));
  }
});

test("provision rejects unsafe service and TLS configuration", () => {
  for (const serviceBaseUrl of [
    "http://platform.memorax.net",
    "https://user:password@platform.memorax.net",
    "https://platform.memorax.net/path",
  ]) {
    assert.throws(
      () => createTrialProvisionClient({ serviceBaseUrl, env: {} }),
      clientError("invalid_service_url"),
    );
  }
  assert.throws(
    () => createTrialProvisionClient({ env: { NODE_TLS_REJECT_UNAUTHORIZED: "0" } }),
    clientError("tls_unsafe"),
  );
  const previousTlsSetting = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  try {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    assert.throws(
      () => createTrialProvisionClient({ env: {} }),
      clientError("tls_unsafe"),
    );
  } finally {
    if (previousTlsSetting === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTlsSetting;
  }
});

test("provision bounds response size", async () => {
  for (const headers of [{ "content-length": "129" }, {}]) {
    const client = createTrialProvisionClient({
      env: {},
      maxResponseBytes: 128,
      fetchImpl: async () => new Response("x".repeat(129), {
        status: 200,
        headers,
      }),
    });
    await assert.rejects(client.provision(REQUEST), clientError("response_too_large"));
  }
});

test("provision preserves timeout and caller aborts while reading the response", async () => {
  const fetchImpl = async (_url, options) => stalledResponse(options.signal);
  const timed = createTrialProvisionClient({ env: {}, fetchImpl, timeoutMs: 10 });
  await assert.rejects(timed.provision(REQUEST), clientError("timeout"));

  const controller = new AbortController();
  const aborted = createTrialProvisionClient({ env: {}, fetchImpl });
  const pending = aborted.provision(REQUEST, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, clientError("aborted"));
});

function jsonResponse(body, options = {}) {
  return new Response(JSON.stringify(body), {
    status: options.status ?? 200,
    headers: {
      "content-type": "application/json",
      ...options.headers,
    },
  });
}

function stalledResponse(signal) {
  return new Response(new ReadableStream({
    start(controller) {
      signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
    },
  }));
}

function clientError(reason) {
  return (error) => {
    assert.ok(error instanceof TrialProvisionClientError);
    assert.equal(error.reason, reason);
    return true;
  };
}
