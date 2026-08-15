import assert from "node:assert/strict";
import test from "node:test";
import {
  createTrialProvisionClient,
  TrialProvisionClientError,
} from "../lib/trial-provision-client.mjs";

const SERVICE_BASE_URL = "https://platform.memorax.net";
const PLUGIN_MARK = `mk_${"a".repeat(32)}`;
const API_KEY = `sk_${"A".repeat(43)}`;
const POW_CHALLENGE = "v1.cGF5bG9hZA.c2lnbmF0dXJl";
const ACCOUNT_ID = "900719925474099300000000001";
const PROJECT_ID = "900719925474099300000000002";

function challengeResponse(overrides = {}) {
  return {
    pow_challenge: POW_CHALLENGE,
    difficulty_bits: 16,
    algorithm: "sha256",
    expires_at: "2026-08-15T12:05:00Z",
    ...overrides,
  };
}

function provisionResponse(overrides = {}) {
  return {
    user_id: ACCOUNT_ID,
    project_id: PROJECT_ID,
    api_key: API_KEY,
    key_prefix: "sk_AAAAAAAA",
    plugin_mark: PLUGIN_MARK,
    created: true,
    api_key_recovered: false,
    warn_remaining_threshold: 5000,
    warn_remaining_step: 1000,
    register_url: "https://platform.memorax.net/register",
    ...overrides,
  };
}

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init.headers ?? {}),
    },
  });
}

test("challenge request uses the fixed HTTPS endpoint and validates its response", async () => {
  const requests = [];
  const client = createTrialProvisionClient({
    serviceBaseUrl: SERVICE_BASE_URL,
    env: {},
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return jsonResponse(challengeResponse());
    },
  });

  assert.deepEqual(await client.requestPowChallenge(PLUGIN_MARK), {
    powChallenge: POW_CHALLENGE,
    difficultyBits: 16,
    algorithm: "sha256",
    expiresAt: "2026-08-15T12:05:00Z",
  });
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    "https://platform.memorax.net/account/api/v1/trial/pow-challenge",
  );
  assert.equal(requests[0].init.method, "POST");
  assert.equal(requests[0].init.redirect, "error");
  assert.equal(requests[0].init.cache, "no-store");
  assert.equal(requests[0].init.credentials, "omit");
  assert.equal(requests[0].init.headers.Authorization, undefined);
  assert.equal(requests[0].init.headers["Content-Type"], "application/json");
  assert.equal(requests[0].init.headers.Accept, "application/json");
  assert.deepEqual(JSON.parse(requests[0].init.body), { plugin_mark: PLUGIN_MARK });
});

test("provision sends the exact persisted identity and maps account identity separately", async () => {
  let captured;
  const client = createTrialProvisionClient({
    serviceBaseUrl: SERVICE_BASE_URL,
    env: {},
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return jsonResponse(provisionResponse());
    },
  });

  const result = await client.provision({
    pluginMark: PLUGIN_MARK,
    apiKey: API_KEY,
    powChallenge: POW_CHALLENGE,
    powNonce: "88405",
    recoverApiKey: false,
  });

  assert.deepEqual(result, {
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    created: true,
    apiKeyRecovered: false,
    warnRemainingThreshold: 5000,
    warnRemainingStep: 1000,
    registerUrl: "https://platform.memorax.net/register",
  });
  assert.equal(
    captured.url,
    "https://platform.memorax.net/account/api/v1/trial/provision",
  );
  assert.equal(captured.init.headers.Authorization, undefined);
  assert.deepEqual(JSON.parse(captured.init.body), {
    plugin_mark: PLUGIN_MARK,
    client_api_key: API_KEY,
    pow_challenge: POW_CHALLENGE,
    pow_nonce: "88405",
    recover_api_key: false,
    display_name: null,
  });
  assert.ok(Buffer.byteLength(captured.init.body, "utf8") <= 4096);
  assert.equal(captured.url.includes(API_KEY), false);
  assert.equal(JSON.stringify(captured.init.headers).includes(API_KEY), false);
  assert.equal(JSON.stringify(result).includes(API_KEY), false);
});

test("client rejects unsafe service URLs and disabled TLS verification before networking", async () => {
  for (const [serviceBaseUrl, env] of [
    ["http://platform.memorax.net", {}],
    ["ftp://platform.memorax.net", {}],
    ["https://user:password@platform.memorax.net", {}],
    ["https://platform.memorax.net?next=elsewhere", {}],
    ["https://platform.memorax.net#fragment", {}],
    ["https://platform.memorax.net\0.invalid", {}],
    [SERVICE_BASE_URL, { NODE_TLS_REJECT_UNAUTHORIZED: "0" }],
  ]) {
    let calls = 0;
    assert.throws(
      () => createTrialProvisionClient({
        serviceBaseUrl,
        env,
        fetchImpl: async () => {
          calls += 1;
          return jsonResponse(challengeResponse());
        },
      }),
      (error) => error instanceof TrialProvisionClientError
        && error.code === "TRIAL_PROVISION_CLIENT_FAILED"
        && (error.reason === "invalid_service_url" || error.reason === "tls_unsafe"),
    );
    assert.equal(calls, 0);
  }
});

test("client configuration cannot weaken request timeout or response size bounds", () => {
  for (const overrides of [
    { challengeTimeoutMs: 120_001 },
    { provisionTimeoutMs: 120_001 },
    { maxResponseBytes: 16_385 },
    { maxResponseBytes: 0 },
  ]) {
    let calls = 0;
    assert.throws(
      () => createTrialProvisionClient({
        serviceBaseUrl: SERVICE_BASE_URL,
        env: {},
        fetchImpl: async () => {
          calls += 1;
          return jsonResponse(challengeResponse());
        },
        ...overrides,
      }),
      (error) => error instanceof TrialProvisionClientError
        && error.reason === "invalid_options",
    );
    assert.equal(calls, 0);
  }
});

test("redirect responses fail without replaying the provision body", async () => {
  const requests = [];
  const client = createTrialProvisionClient({
    serviceBaseUrl: SERVICE_BASE_URL,
    env: {},
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return new Response("", {
        status: 307,
        headers: {
          location: "https://attacker.example/provision",
          "content-type": "application/json",
        },
      });
    },
  });

  await assert.rejects(
    client.provision({
      pluginMark: PLUGIN_MARK,
      apiKey: API_KEY,
      powChallenge: POW_CHALLENGE,
      powNonce: "88405",
      recoverApiKey: false,
    }),
    (error) => error instanceof TrialProvisionClientError
      && error.reason === "unexpected_http_status"
      && !String(error).includes(API_KEY),
  );
  assert.equal(requests.length, 1);
  assert.equal(requests[0].init.redirect, "error");
});

test("response reader accepts the byte limit and rejects one additional decompressed byte", async () => {
  const base = provisionResponse({ future_padding: "" });
  const overhead = Buffer.byteLength(JSON.stringify(base), "utf8");
  const atLimit = provisionResponse({ future_padding: "x".repeat(16_384 - overhead) });
  assert.equal(Buffer.byteLength(JSON.stringify(atLimit), "utf8"), 16_384);

  for (const [body, expectedReason] of [
    [atLimit, undefined],
    [provisionResponse({ future_padding: `${atLimit.future_padding}x` }), "response_too_large"],
  ]) {
    const client = createTrialProvisionClient({
      serviceBaseUrl: SERVICE_BASE_URL,
      env: {},
      fetchImpl: async () => jsonResponse(body),
    });
    if (!expectedReason) {
      assert.equal((await client.provision({
        pluginMark: PLUGIN_MARK,
        apiKey: API_KEY,
        powChallenge: POW_CHALLENGE,
        powNonce: "88405",
        recoverApiKey: false,
      })).accountId, ACCOUNT_ID);
    } else {
      await assert.rejects(
        client.provision({
          pluginMark: PLUGIN_MARK,
          apiKey: API_KEY,
          powChallenge: POW_CHALLENGE,
          powNonce: "88405",
          recoverApiKey: false,
        }),
        (error) => error instanceof TrialProvisionClientError
          && error.reason === expectedReason
          && !String(error).includes(API_KEY),
      );
    }
  }
});

test("response reader enforces the streamed byte limit despite a smaller Content-Length", async () => {
  let cancelCalls = 0;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(16_384));
      controller.enqueue(new Uint8Array(1));
    },
    cancel() {
      cancelCalls += 1;
    },
  });
  const client = createTrialProvisionClient({
    serviceBaseUrl: SERVICE_BASE_URL,
    env: {},
    fetchImpl: async () => new Response(body, {
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-length": "1",
      },
    }),
  });

  await assert.rejects(
    client.requestPowChallenge(PLUGIN_MARK),
    (error) => error instanceof TrialProvisionClientError
      && error.reason === "response_too_large"
      && error.httpStatus === 200,
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelCalls, 1);
});

test("attempt timeout covers a stalled response body", async () => {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("{"));
    },
  });
  const client = createTrialProvisionClient({
    serviceBaseUrl: SERVICE_BASE_URL,
    env: {},
    challengeTimeoutMs: 20,
    fetchImpl: async () => new Response(body, {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  });

  await assert.rejects(
    client.requestPowChallenge(PLUGIN_MARK),
    (error) => error instanceof TrialProvisionClientError && error.reason === "timeout",
  );
});

test("attempt timeout remains authoritative when fetch returns after ignoring abort", async () => {
  let cancelCalls = 0;
  const client = createTrialProvisionClient({
    serviceBaseUrl: SERVICE_BASE_URL,
    env: {},
    challengeTimeoutMs: 20,
    fetchImpl: async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("{"));
        },
        cancel() {
          cancelCalls += 1;
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  await assert.rejects(
    client.requestPowChallenge(PLUGIN_MARK),
    (error) => error instanceof TrialProvisionClientError && error.reason === "timeout",
  );
  assert.equal(cancelCalls, 1);
});

test("stable service errors expose only bounded structured metadata", async () => {
  const client = createTrialProvisionClient({
    serviceBaseUrl: SERVICE_BASE_URL,
    env: {},
    now: () => Date.parse("2026-08-15T12:00:00Z"),
    fetchImpl: async () => jsonResponse({
      code: "trial_capacity_exceeded",
      message: `do not expose ${API_KEY}`,
      details: {
        register_url: "https://platform.memorax.net/register",
        credential: API_KEY,
      },
    }, {
      status: 429,
      headers: { "retry-after": "30" },
    }),
  });

  await assert.rejects(
    client.provision({
      pluginMark: PLUGIN_MARK,
      apiKey: API_KEY,
      powChallenge: POW_CHALLENGE,
      powNonce: "88405",
      recoverApiKey: false,
    }),
    (error) => {
      assert.equal(error instanceof TrialProvisionClientError, true);
      assert.equal(error.reason, "trial_capacity_exceeded");
      assert.equal(error.httpStatus, 429);
      assert.equal(error.retryAfterMs, 30_000);
      assert.equal(error.registerUrl, "https://platform.memorax.net/register");
      assert.equal(String(error).includes(API_KEY), false);
      assert.equal(String(error.stack).includes(API_KEY), false);
      assert.equal(JSON.stringify(error).includes(API_KEY), false);
      return true;
    },
  );
});

test("Retry-After accepts bounded seconds and HTTP dates without trusting invalid values", async () => {
  const now = Date.parse("2026-08-15T12:00:00Z");
  const cases = [
    { value: "0", retryAfterMs: 0 },
    { value: "30", retryAfterMs: 30_000 },
    { value: "60", retryAfterMs: 60_000 },
    { value: "120", retryAfterMs: 120_000 },
    { value: "121", exceeded: true },
    { value: new Date(now + 60_000).toUTCString(), retryAfterMs: 60_000 },
    { value: new Date(now - 60_000).toUTCString(), retryAfterMs: 0 },
    { value: new Date(now + 121_000).toUTCString(), exceeded: true },
    { value: "", invalid: true },
    { value: "-1", invalid: true },
    { value: "1.5", invalid: true },
    { value: "not-a-date", invalid: true },
  ];

  for (const expected of cases) {
    const client = createTrialProvisionClient({
      serviceBaseUrl: SERVICE_BASE_URL,
      env: {},
      now: () => now,
      fetchImpl: async () => jsonResponse({
        code: "rate_limit_exceeded",
      }, {
        status: 429,
        headers: { "retry-after": expected.value },
      }),
    });
    let caught;
    await assert.rejects(
      client.requestPowChallenge(PLUGIN_MARK),
      (error) => {
        caught = error;
        return error instanceof TrialProvisionClientError
          && error.reason === "rate_limit_exceeded"
          && error.httpStatus === 429;
      },
    );
    assert.equal(caught.retryAfterMs, expected.retryAfterMs);
    assert.equal(caught.retryAfterExceeded, expected.exceeded ? true : undefined);
    if (expected.invalid) {
      assert.equal(Object.hasOwn(caught, "retryAfterMs"), false);
      assert.equal(Object.hasOwn(caught, "retryAfterExceeded"), false);
    }
  }
});

test("transport, malformed JSON, and status mismatches never expose response or thrown secrets", async () => {
  for (const [fetchImpl, expectedReason] of [
    [async () => { throw new Error(`network failed with ${API_KEY}`); }, "transport"],
    [async () => new Response(`{${API_KEY}`, {
      status: 200,
      headers: { "content-type": "application/json" },
    }), "invalid_response"],
    [async () => jsonResponse({ code: "trial_disabled", message: API_KEY }, { status: 429 }), "unexpected_http_status"],
  ]) {
    const client = createTrialProvisionClient({
      serviceBaseUrl: SERVICE_BASE_URL,
      env: {},
      fetchImpl,
    });
    await assert.rejects(
      client.requestPowChallenge(PLUGIN_MARK),
      (error) => error instanceof TrialProvisionClientError
        && error.reason === expectedReason
        && !String(error).includes(API_KEY)
        && !String(error.stack).includes(API_KEY)
        && !JSON.stringify(error).includes(API_KEY),
    );
  }
});
