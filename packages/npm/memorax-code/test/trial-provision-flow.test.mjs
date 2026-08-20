import assert from "node:assert/strict";
import test from "node:test";
import {
  completeTrialCredentialProvisioning,
  createInitialTrialCredentialRecord,
} from "../../../ts/memorax-code-adapter-common/src/credentials/trial-credential-record.mjs";
import {
  TrialProvisionClientError,
} from "../lib/trial-provision-client.mjs";
import {
  ensureTrialCredentialReady,
  TrialProvisionFlowError,
} from "../lib/trial-provision-flow.mjs";

const API_KEY = `sk_${"A".repeat(43)}`;
const SECOND_API_KEY = `sk_${"B".repeat(43)}`;
const IDENTITY = Object.freeze({
  markId: "mk_e07c335dfbdd06d4752cf8a17e7d4f82555bf4828d82a8efa7cc5b527d4c858e",
  markVersion: 1,
  appSalt: "memorax-plugin-v1",
  machineId: "550e8400-e29b-41d4-a716-446655440000",
  hostname: "DESKTOP-DEMO",
  platform: "windows",
  arch: "x86_64",
  macHash: "b".repeat(64),
});
const RESPONSE = Object.freeze({
  accountId: "341599238100099072",
  projectId: "347677365196820482",
  apiKey: API_KEY,
  created: true,
});
const RECORD_PORT = Object.freeze({
  createInitial: createInitialTrialCredentialRecord,
  complete: completeTrialCredentialProvisioning,
});

test("fresh provisioning persists identity first and then commits the backend-generated Key", async () => {
  const store = memoryCredentialPort();
  const requests = [];
  const result = await runFlow(store, {
    async provision(request) {
      requests.push(request);
      assert.equal(store.current.state, "provisioning");
      assert.equal(store.current.api_key, null);
      return RESPONSE;
    },
  });

  assert.deepEqual(requests, [IDENTITY]);
  assert.deepEqual(result, {
    status: "ready",
    provisioned: true,
    markId: IDENTITY.markId,
    accountId: RESPONSE.accountId,
    projectId: RESPONSE.projectId,
    apiKey: API_KEY,
  });
  assert.equal(store.current.state, "ready");
  assert.equal(store.current.api_key, API_KEY);
});

test("a ready credential is reused without another provision request", async () => {
  const ready = completeTrialCredentialProvisioning(
    createInitialTrialCredentialRecord(IDENTITY),
    {
      apiKey: API_KEY,
      accountId: RESPONSE.accountId,
      projectId: RESPONSE.projectId,
    },
  );
  const store = memoryCredentialPort(ready);
  const result = await runFlow(store, {
    async provision() {
      throw new Error("must not provision");
    },
  });
  assert.equal(result.provisioned, false);
  assert.equal(result.accountId, RESPONSE.accountId);
  assert.equal(result.apiKey, API_KEY);
});

test("a lost provision response retries the same device identity and stores the replacement Key", async () => {
  const store = memoryCredentialPort();
  const requests = [];
  const sleeps = [];
  let attempts = 0;
  const result = await runFlow(store, {
    async provision(request) {
      requests.push(request);
      attempts += 1;
      if (attempts === 1) throw new TrialProvisionClientError("transport");
      return { ...RESPONSE, apiKey: SECOND_API_KEY, created: false };
    },
  }, {
    sleep: async (delay) => { sleeps.push(delay); },
  });

  assert.equal(attempts, 2);
  assert.deepEqual(requests, [IDENTITY, IDENTITY]);
  assert.deepEqual(sleeps, [1_000]);
  assert.equal(store.current.api_key, SECOND_API_KEY);
  assert.equal(result.provisioned, true);
});

test("a secure-store commit failure leaves provisioning state for a later reapplication", async () => {
  const store = memoryCredentialPort();
  store.failNextTransition = true;
  await assert.rejects(
    runFlow(store, { provision: async () => RESPONSE }),
    flowError("credential_failure"),
  );
  assert.equal(store.current.state, "provisioning");
  assert.equal(store.current.api_key, null);

  const result = await runFlow(store, {
    provision: async () => ({ ...RESPONSE, apiKey: SECOND_API_KEY, created: false }),
  });
  assert.equal(result.status, "ready");
  assert.equal(store.current.api_key, SECOND_API_KEY);
});

test("rate limits use the bounded server delay before retrying", async () => {
  const store = memoryCredentialPort();
  const sleeps = [];
  let attempts = 0;
  await runFlow(store, {
    async provision() {
      attempts += 1;
      if (attempts === 1) {
        throw new TrialProvisionClientError("rate_limit_exceeded", {
          httpStatus: 429,
          retryAfterMs: 2_000,
        });
      }
      return RESPONSE;
    },
  }, {
    sleep: async (delay) => { sleeps.push(delay); },
  });
  assert.deepEqual(sleeps, [2_000]);
  assert.equal(attempts, 2);
});

test("unknown client failures and exhausted HTTP budgets fail closed", async () => {
  await assert.rejects(
    runFlow(memoryCredentialPort(), {
      provision: async () => { throw new Error(API_KEY); },
    }),
    flowError("client_failure"),
  );

  await assert.rejects(
    runFlow(memoryCredentialPort(), {
      provision: async () => { throw new TrialProvisionClientError("transport"); },
    }, {
      maxHttpRequests: 1,
      sleep: async () => undefined,
    }),
    flowError("http_budget_exhausted"),
  );
});

async function runFlow(store, client, overrides = {}) {
  return ensureTrialCredentialReady({
    credentialPort: store.port,
    recordPort: RECORD_PORT,
    client,
    generatePluginIdentity: () => IDENTITY,
    random: () => 0,
    sleep: async () => undefined,
    totalTimeoutMs: 30_000,
    ...overrides,
  });
}

function memoryCredentialPort(initial = null) {
  const state = {
    current: initial,
    failNextTransition: false,
  };
  state.port = {
    async load() {
      return state.current;
    },
    async createIfAbsent(candidate) {
      if (state.current === null) {
        state.current = candidate;
        return { record: candidate, created: true };
      }
      return { record: state.current, created: false };
    },
    async transition(operation) {
      if (state.failNextTransition) {
        state.failNextTransition = false;
        throw new Error("secure store unavailable");
      }
      const next = operation(state.current);
      if (next !== undefined) state.current = next;
      return state.current;
    },
    async withProvisionLock(operation) {
      return operation();
    },
  };
  return state;
}

function flowError(reason) {
  return (error) => {
    assert.ok(error instanceof TrialProvisionFlowError);
    assert.equal(error.reason, reason);
    assert.equal(`${error.message} ${error.stack}`.includes(API_KEY), false);
    return true;
  };
}
