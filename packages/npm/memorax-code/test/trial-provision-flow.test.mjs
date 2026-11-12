import assert from "node:assert/strict";
import test from "node:test";
import {
  completeTrialCredentialProvisioning,
  createInitialTrialCredentialRecord,
  TrialCredentialRecordError,
} from "../../../ts/memorax-code-adapter-common/src/credentials/trial-credential-record.mjs";
import {
  TrialProvisionClientError,
} from "../lib/trial-provision-client.mjs";
import {
  ensureTrialCredentialReady,
  TrialProvisionFlowError,
} from "../lib/trial-provision-flow.mjs";

import { SecureCredentialBackendError } from "../../../ts/memorax-code-adapter-common/src/credentials/secure-command.mjs";
import {
  ensureTrialSetupCredential,
  trialSetupFailureDetails,
} from "../lib/trial-setup.mjs";

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
    flowError("credential_failure", {
      errorCode: "TRIAL_CREDENTIAL_BACKEND_ERROR",
      stage: "credential_complete",
      failureReason: "credential_failure",
      credentialReason: "storage_failed",
    }),
  );
  assert.equal(store.current.state, "provisioning");
  assert.equal(store.current.api_key, null);

  const result = await runFlow(store, {
    provision: async () => ({ ...RESPONSE, apiKey: SECOND_API_KEY, created: false }),
  });
  assert.equal(result.status, "ready");
  assert.equal(store.current.api_key, SECOND_API_KEY);
});

test("unknown client failures fail closed", async () => {
  await assert.rejects(
    runFlow(memoryCredentialPort(), {
      provision: async () => {
        throw Object.assign(new Error(API_KEY), {
          code: API_KEY, reason: API_KEY, systemCode: API_KEY, credentialReason: API_KEY,
        });
      },
    }),
    flowError("client_failure", {
      errorCode: "TRIAL_PROVISION_FLOW_FAILED",
      stage: "provision",
      failureReason: "client_failure",
    }),
  );
});

test("credential failures retain their stage and known reason inside the provision lock", async () => {
  const locked = memoryCredentialPort();
  locked.port.withProvisionLock = async () => {
    throw Object.assign(new Error(API_KEY), { code: "JSON_FILE_LOCK_TIMEOUT" });
  };
  await assert.rejects(runFlow(locked, { provision: async () => RESPONSE }), flowError("credential_failure", {
    errorCode: "JSON_FILE_LOCK_TIMEOUT",
    stage: "credential_lock",
    failureReason: "credential_failure",
  }));

  const unreadable = memoryCredentialPort();
  unreadable.port.load = async () => { throw new TrialCredentialRecordError("malformed_json"); };
  await assert.rejects(runFlow(unreadable, { provision: async () => RESPONSE }), flowError("credential_failure", {
    errorCode: "TRIAL_CREDENTIAL_RECORD_INVALID",
    stage: "credential_load",
    failureReason: "credential_failure",
    credentialReason: "malformed_json",
  }));

  const releaseError = Object.assign(new Error(API_KEY, {
    cause: Object.assign(new Error(API_KEY), { code: "EACCES" }),
  }), { code: "JSON_FILE_LOCK_RELEASE_FAILED" });
  const failingRelease = async (operation) => {
    try { return await operation(); }
    catch (error) {
      throw Object.assign(new AggregateError([error, releaseError], API_KEY, { cause: error }), {
        code: "JSON_FILE_LOCK_RELEASE_FAILED",
      });
    }
  };
  unreadable.port.load = async () => {
    throw Object.assign(new TrialCredentialRecordError("malformed_json"), {
      cause: Object.assign(new Error(API_KEY), { code: "ENOSPC" }),
    });
  };
  unreadable.port.withProvisionLock = failingRelease;
  await assert.rejects(runFlow(unreadable, { provision: async () => RESPONSE }), flowError("credential_failure", {
    errorCode: "TRIAL_CREDENTIAL_RECORD_INVALID",
    stage: "credential_load",
    failureReason: "credential_failure",
    credentialReason: "malformed_json",
    systemCode: "ENOSPC",
    cleanupErrorCode: "JSON_FILE_LOCK_RELEASE_FAILED",
    cleanupSystemCode: "EACCES",
  }));
  const rejected = memoryCredentialPort();
  rejected.port.withProvisionLock = failingRelease;
  await assert.rejects(runFlow(rejected, {
    provision: async () => { throw new TrialProvisionClientError("server_rejected", { httpStatus: 403 }); },
  }), (error) => {
    assert.ok(error instanceof TrialProvisionClientError);
    assert.deepEqual(trialSetupFailureDetails(error), {
      errorCode: "TRIAL_PROVISION_CLIENT_FAILED", stage: "provision",
      failureReason: "server_rejected", httpStatus: 403,
      cleanupErrorCode: "JSON_FILE_LOCK_RELEASE_FAILED", cleanupSystemCode: "EACCES",
    });
    assert.equal(JSON.stringify(error).includes(API_KEY), false);
    return true;
  });
  const releaseOnly = memoryCredentialPort();
  releaseOnly.port.complete = async () => { throw releaseError; };
  await assert.rejects(runFlow(releaseOnly, { provision: async () => RESPONSE }), flowError("credential_failure", {
    errorCode: "JSON_FILE_LOCK_RELEASE_FAILED", stage: "credential_lock",
    failureReason: "credential_failure", systemCode: "EACCES",
  }));

  await assert.rejects(runFlow(memoryCredentialPort(), { provision: async () => RESPONSE }, {
    generatePluginIdentity: () => ({ ...IDENTITY, machineId: "" }),
  }), flowError("identity_generation_failed", {
    errorCode: "TRIAL_CREDENTIAL_RECORD_INVALID",
    stage: "identity",
    failureReason: "identity_generation_failed",
    credentialReason: "invalid_machine_id",
  }));
});

test("setup projects safe initialization and HTTP details while dropping unknown fields", async () => {
  await assert.rejects(ensureTrialSetupCredential({
    credentialApis: {
      createTrialCredentialStorePort() {
        throw new SecureCredentialBackendError({
          backend: "credential-store", operation: "initialize", reason: "backend_unavailable",
        });
      },
    },
  }), flowError("credential_failure", {
    errorCode: "TRIAL_CREDENTIAL_BACKEND_ERROR",
    stage: "credential_load",
    failureReason: "credential_failure",
    credentialReason: "backend_unavailable",
  }));
  assert.deepEqual(trialSetupFailureDetails(new TrialProvisionClientError("rate_limit_exceeded", {
    httpStatus: 429, retryAfterMs: 3_000, systemCode: API_KEY,
  })), {
    errorCode: "TRIAL_PROVISION_CLIENT_FAILED",
    stage: "provision",
    failureReason: "rate_limit_exceeded",
    httpStatus: 429,
    retryAfterMs: 3_000,
  });
  assert.deepEqual(trialSetupFailureDetails(Object.assign(new Error(API_KEY), {
    code: API_KEY, reason: API_KEY, stage: API_KEY, systemCode: API_KEY, apiKey: API_KEY,
  })), { errorCode: "TRIAL_SETUP_FAILED", stage: "unknown" });
});

async function runFlow(store, client, overrides = {}) {
  return ensureTrialCredentialReady({
    credentialPort: store.port,
    recordPort: RECORD_PORT,
    client,
    generatePluginIdentity: () => IDENTITY,
    sleep: async () => undefined,
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
    async complete(current, metadata) {
      if (state.failNextTransition) {
        state.failNextTransition = false;
        throw new SecureCredentialBackendError({
          backend: "credential-store", operation: "save", reason: "storage_failed",
        });
      }
      assert.deepEqual(current, state.current);
      state.current = completeTrialCredentialProvisioning(current, metadata);
      return state.current;
    },
    async withProvisionLock(operation) {
      return operation();
    },
  };
  return state;
}

function flowError(reason, details) {
  return (error) => {
    assert.ok(error instanceof TrialProvisionFlowError);
    assert.equal(error.reason, reason);
    if (details) assert.deepEqual(trialSetupFailureDetails(error), details);
    assert.equal(JSON.stringify(error).includes(API_KEY), false);
    assert.equal(`${error.message} ${error.stack}`.includes(API_KEY), false);
    return true;
  };
}
