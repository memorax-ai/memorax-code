import assert from "node:assert/strict";
import test from "node:test";
import {
  beginTrialCredentialRecovery,
  completeTrialCredentialProvisioning,
  createInitialTrialCredentialRecord as createInitialRecord,
  createTrialCredentialRecoveryRecord as createRecoveryRecord,
  validateTrialCredentialRecord,
} from "../../../ts/memorax-code-adapter-common/src/credentials/trial-credential-record.mjs";
import { TrialProvisionClientError } from "../lib/trial-provision-client.mjs";
import {
  ensureTrialCredentialReady,
  generateTrialApiKey,
  TrialProvisionFlowError,
} from "../lib/trial-provision-flow.mjs";

const PLUGIN_MARK = "mk_8eddbf5e4d57a29b783ababa63bd16b8";
const API_KEY = `sk_${"A".repeat(43)}`;
const RECOVERY_KEY = `sk_${"B".repeat(43)}`;
const ACCOUNT_ID = "900719925474099300000000001";
const PROJECT_ID = "900719925474099300000000002";
const REGISTER_URL = "https://platform.memorax.net/register";
const PLUGIN_IDENTITY = Object.freeze({
  pluginMark: PLUGIN_MARK,
  appSalt: "@memorax/memorax-code@0.1.2",
  machineIdHash: "9c68dde752b9d1abaa475e2cd895eb0fbc8e29b05e3cab1430c01cc964c38c3d",
  hostname: "developer-laptop",
  platform: "linux",
  arch: "x64",
  macHash: "39d902aba3f789635208452e37cfacc66f2b3673eb4f23a98f1457b832d78a2a",
});

function createInitialTrialCredentialRecord(options = {}) {
  return createInitialRecord({ ...PLUGIN_IDENTITY, ...options });
}

function createTrialCredentialRecoveryRecord(options = {}) {
  return createRecoveryRecord({ ...PLUGIN_IDENTITY, ...options });
}

const recordPort = Object.freeze({
  createInitial: createInitialTrialCredentialRecord,
  complete: completeTrialCredentialProvisioning,
});

function metadata(overrides = {}) {
  return {
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    created: true,
    apiKeyRecovered: false,
    warnRemainingThreshold: 5000,
    warnRemainingStep: 1000,
    registerUrl: REGISTER_URL,
    ...overrides,
  };
}

function challenge(index = 1) {
  return {
    powChallenge: `v1.cGF5bG9hZA${index}.c2lnbmF0dXJl${index}`,
    difficultyBits: 16,
    algorithm: "sha256",
    expiresAt: "2026-08-15T12:05:00Z",
  };
}

function readyRecord({ apiKey = API_KEY } = {}) {
  return completeTrialCredentialProvisioning(
    createInitialTrialCredentialRecord({ pluginMark: PLUGIN_MARK, apiKey }),
    metadata(),
  );
}

function credentialPort(initial = null) {
  let current = initial;
  let provisionLock = Promise.resolve();
  return {
    async withProvisionLock(operation, options = {}) {
      const previous = provisionLock;
      let release;
      provisionLock = new Promise((resolve) => {
        release = resolve;
      });
      let entered = false;
      try {
        await waitForProvisionLock(previous, options);
        entered = true;
        return await operation();
      } finally {
        if (entered) release();
        else void previous.then(release, release);
      }
    },
    async load() {
      return current;
    },
    async createIfAbsent(candidate) {
      if (current !== null) return { record: current, created: false };
      current = validateTrialCredentialRecord(candidate);
      return { record: current, created: true };
    },
    async transition(operation) {
      if (current === null) throw new Error("missing");
      const candidate = operation(current);
      if (candidate !== undefined) current = validateTrialCredentialRecord(candidate);
      return current;
    },
    get current() {
      return current;
    },
    replace(value) {
      current = value;
    },
  };
}

async function waitForProvisionLock(previous, options) {
  if (options.signal?.aborted) throw new Error("lock wait aborted");
  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener?.("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    const timeout = Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0
      ? setTimeout(() => finish(new Error("lock wait timed out")), options.timeoutMs)
      : undefined;
    const onAbort = () => finish(new Error("lock wait aborted"));
    options.signal?.addEventListener?.("abort", onAbort, { once: true });
    void previous.then(() => finish(), finish);
    if (options.signal?.aborted) onAbort();
  });
}

function fixedRandomBytes(size) {
  return Uint8Array.from({ length: size }, (_, index) => index);
}

function flowOptions(overrides = {}) {
  return {
    credentialPort: overrides.credentialPort ?? credentialPort(),
    recordPort,
    client: overrides.client ?? {
      requestPowChallenge: async () => challenge(),
      provision: async () => metadata(),
    },
    solvePow: overrides.solvePow ?? (async () => "88405"),
    generatePluginIdentity: overrides.generatePluginIdentity ?? (() => PLUGIN_IDENTITY),
    randomBytes: overrides.randomBytes ?? fixedRandomBytes,
    random: overrides.random ?? (() => 0),
    sleep: overrides.sleep ?? (async () => undefined),
    now: overrides.now ?? (() => 0),
    ...overrides,
  };
}

test("trial API Key generation uses the documented CSPRNG encoding", () => {
  assert.equal(
    generateTrialApiKey(fixedRandomBytes),
    "sk_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
  );
});

test("invalid CSPRNG output fails before credential creation or networking", async () => {
  for (const randomBytes of [
    () => { throw new Error(API_KEY); },
    (size) => new Uint8Array(size - 1),
    (size) => new Uint8Array(size + 1),
    () => "not random bytes",
  ]) {
    let createCalls = 0;
    let networkCalls = 0;
    const store = credentialPort();
    store.createIfAbsent = async () => {
      createCalls += 1;
      throw new Error("unexpected create");
    };
    await assert.rejects(
      ensureTrialCredentialReady(flowOptions({
        credentialPort: store,
        randomBytes,
        client: {
          requestPowChallenge: async () => { networkCalls += 1; },
          provision: async () => { networkCalls += 1; },
        },
      })),
      (error) => error instanceof TrialProvisionFlowError
        && error.reason === "identity_generation_failed"
        && !String(error).includes(API_KEY)
        && !String(error.stack).includes(API_KEY),
    );
    assert.equal(createCalls, 0);
    assert.equal(networkCalls, 0);
  }
});

test("plugin identity generation failure stops before credential creation or networking", async () => {
  let createCalls = 0;
  let networkCalls = 0;
  const store = credentialPort();
  store.createIfAbsent = async () => {
    createCalls += 1;
    throw new Error("unexpected create");
  };

  await assert.rejects(
    ensureTrialCredentialReady(flowOptions({
      credentialPort: store,
      generatePluginIdentity: () => { throw new Error(API_KEY); },
      client: {
        requestPowChallenge: async () => { networkCalls += 1; },
        provision: async () => { networkCalls += 1; },
      },
    })),
    (error) => error instanceof TrialProvisionFlowError
      && error.reason === "identity_generation_failed"
      && !String(error).includes(API_KEY)
      && !String(error.stack).includes(API_KEY),
  );
  assert.equal(createCalls, 0);
  assert.equal(networkCalls, 0);
});

test("first run saves mark and Key before networking, then commits only server metadata", async () => {
  const store = credentialPort();
  const requests = [];
  const client = {
    async requestPowChallenge(pluginMark) {
      assert.equal(store.current?.state, "provisioning");
      assert.equal(store.current?.plugin_mark, pluginMark);
      assert.ok(store.current?.api_key);
      requests.push({ type: "challenge", pluginMark });
      return challenge();
    },
    async provision(request) {
      assert.equal(store.current?.state, "provisioning");
      assert.equal(store.current?.api_key, request.apiKey);
      requests.push({ type: "provision", ...request });
      return metadata();
    },
  };

  const result = await ensureTrialCredentialReady(flowOptions({
    credentialPort: store,
    client,
  }));

  assert.equal(store.current.state, "ready");
  assert.equal(store.current.account_id, ACCOUNT_ID);
  assert.equal(store.current.project_id, PROJECT_ID);
  assert.equal(store.current.api_key, "sk_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8");
  assert.equal(requests[1].recoverApiKey, false);
  assert.equal(requests[1].apiKey, store.current.api_key);
  for (const field of [
    "pluginMark",
    "appSalt",
    "machineIdHash",
    "hostname",
    "platform",
    "arch",
    "macHash",
  ]) {
    assert.equal(requests[1][field], PLUGIN_IDENTITY[field]);
  }
  assert.deepEqual(result, {
    status: "ready",
    provisioned: true,
    pluginMark: store.current.plugin_mark,
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    registerUrl: REGISTER_URL,
  });
  assert.equal(JSON.stringify(result).includes(store.current.api_key), false);
});

test("create-if-absent race uses the authoritative stored identity", async () => {
  const authoritative = createInitialTrialCredentialRecord({
    pluginMark: PLUGIN_MARK,
    apiKey: API_KEY,
  });
  const store = credentialPort();
  let discardedCandidate;
  let createCalls = 0;
  store.load = async () => null;
  store.createIfAbsent = async (candidate) => {
    createCalls += 1;
    discardedCandidate = candidate;
    store.replace(authoritative);
    return { record: authoritative, created: false };
  };
  const requests = [];
  const client = {
    requestPowChallenge: async (pluginMark) => {
      requests.push({ pluginMark });
      return challenge();
    },
    provision: async (request) => {
      requests.push(request);
      return metadata();
    },
  };

  await ensureTrialCredentialReady(flowOptions({
    credentialPort: store,
    client,
    generatePluginIdentity: () => ({
      ...PLUGIN_IDENTITY,
      pluginMark: `mk_${"b".repeat(32)}`,
    }),
  }));

  assert.equal(createCalls, 1);
  assert.notEqual(discardedCandidate.plugin_mark, PLUGIN_MARK);
  assert.notEqual(discardedCandidate.api_key, API_KEY);
  assert.equal(requests[0].pluginMark, PLUGIN_MARK);
  assert.equal(requests[1].pluginMark, PLUGIN_MARK);
  assert.equal(requests[1].apiKey, API_KEY);
});

test("provisioning replay, successful recovery, and mark-only recovery reach ready", async () => {
  const cases = [
    {
      initial: createInitialTrialCredentialRecord({ pluginMark: PLUGIN_MARK, apiKey: API_KEY }),
      response: metadata({ created: false, apiKeyRecovered: false }),
      recoverApiKey: false,
    },
    {
      initial: beginTrialCredentialRecovery(readyRecord(), { apiKey: RECOVERY_KEY }),
      response: metadata({ created: false, apiKeyRecovered: true }),
      recoverApiKey: true,
    },
    {
      initial: beginTrialCredentialRecovery(readyRecord(), { apiKey: RECOVERY_KEY }),
      response: metadata({ created: false, apiKeyRecovered: false }),
      recoverApiKey: true,
    },
    {
      initial: createTrialCredentialRecoveryRecord({ pluginMark: PLUGIN_MARK, apiKey: RECOVERY_KEY }),
      response: metadata({ created: false, apiKeyRecovered: true }),
      recoverApiKey: true,
    },
  ];

  for (const fixture of cases) {
    const store = credentialPort(fixture.initial);
    let request;
    await ensureTrialCredentialReady(flowOptions({
      credentialPort: store,
      generatePluginIdentity: () => { throw new Error("unexpected identity generation"); },
      client: {
        requestPowChallenge: async () => challenge(),
        provision: async (value) => {
          request = value;
          return fixture.response;
        },
      },
    }));
    assert.equal(request.recoverApiKey, fixture.recoverApiKey);
    assert.equal(store.current.state, "ready");
    assert.equal(store.current.account_id, ACCOUNT_ID);
    assert.equal(store.current.project_id, PROJECT_ID);
  }
});

test("state-conflicting success flags and Key mismatch fail closed", async () => {
  const initial = createInitialTrialCredentialRecord({ pluginMark: PLUGIN_MARK, apiKey: API_KEY });
  const mismatch = new TrialProvisionClientError("trial_api_key_mismatch", { httpStatus: 409 });
  const unboundedRetry = new TrialProvisionClientError("rate_limit_exceeded", {
    httpStatus: 429,
    retryAfterExceeded: true,
  });
  for (const fixture of [
    {
      initial,
      outcome: metadata({ created: false, apiKeyRecovered: true }),
      expected: "response_state_mismatch",
    },
    {
      initial: beginTrialCredentialRecovery(readyRecord(), { apiKey: RECOVERY_KEY }),
      outcome: metadata({ created: true, apiKeyRecovered: false }),
      expected: "response_state_mismatch",
    },
    { initial, outcome: mismatch, expected: mismatch },
    { initial, outcome: unboundedRetry, expected: unboundedRetry },
  ]) {
    const store = credentialPort(fixture.initial);
    const requests = [];
    await assert.rejects(
      ensureTrialCredentialReady(flowOptions({
        credentialPort: store,
        client: {
          requestPowChallenge: async () => challenge(),
          provision: async (request) => {
            requests.push(request);
            if (fixture.outcome instanceof Error) throw fixture.outcome;
            return fixture.outcome;
          },
        },
      })),
      (error) => fixture.expected instanceof Error
        ? error === fixture.expected
        : error instanceof TrialProvisionFlowError && error.reason === fixture.expected,
    );
    assert.equal(requests.length, 1);
    assert.equal(requests[0].recoverApiKey, fixture.initial.state === "recovering");
    assert.deepEqual(store.current, fixture.initial);
  }
});

test("ready credentials return without randomness, PoW, or network", async () => {
  const store = credentialPort(readyRecord());
  const forbidden = () => { throw new Error(API_KEY); };

  const result = await ensureTrialCredentialReady(flowOptions({
    credentialPort: store,
    client: {
      requestPowChallenge: forbidden,
      provision: forbidden,
    },
    solvePow: forbidden,
    generatePluginIdentity: forbidden,
    randomBytes: forbidden,
  }));

  assert.equal(result.status, "ready");
  assert.equal(result.provisioned, false);
  assert.equal(JSON.stringify(result).includes(API_KEY), false);
});

test("transient provision failures use the same challenge and identity for three retries", async () => {
  const store = credentialPort(createInitialTrialCredentialRecord({
    pluginMark: PLUGIN_MARK,
    apiKey: API_KEY,
  }));
  const requests = [];
  const delays = [];
  let attempt = 0;
  const result = await ensureTrialCredentialReady(flowOptions({
    credentialPort: store,
    client: {
      requestPowChallenge: async () => challenge(),
      provision: async (request) => {
        requests.push({ ...request });
        attempt += 1;
        if (attempt <= 3) throw new TrialProvisionClientError("server_error", { httpStatus: 500 });
        return metadata();
      },
    },
    sleep: async (delay) => { delays.push(delay); },
  }));

  assert.equal(result.status, "ready");
  assert.equal(requests.length, 4);
  assert.deepEqual(delays, [1000, 2000, 4000]);
  assert.deepEqual(new Set(requests.map((request) => request.pluginMark)), new Set([PLUGIN_MARK]));
  assert.deepEqual(new Set(requests.map((request) => request.apiKey)), new Set([API_KEY]));
  assert.deepEqual(new Set(requests.map((request) => request.powChallenge)), new Set([challenge().powChallenge]));
  assert.deepEqual(new Set(requests.map((request) => request.recoverApiKey)), new Set([false]));
});

test("a malformed success is replayed once with the exact same request", async () => {
  for (const succeedsOnReplay of [true, false]) {
    const store = credentialPort(createInitialTrialCredentialRecord({
      pluginMark: PLUGIN_MARK,
      apiKey: API_KEY,
    }));
    const requests = [];
    const uncertain = new TrialProvisionClientError("invalid_response", { httpStatus: 200 });
    const pending = ensureTrialCredentialReady(flowOptions({
      credentialPort: store,
      client: {
        requestPowChallenge: async () => challenge(),
        provision: async (request) => {
          requests.push({ ...request });
          if (requests.length === 1 || !succeedsOnReplay) throw uncertain;
          return metadata({ created: false });
        },
      },
    }));
    if (succeedsOnReplay) {
      assert.equal((await pending).status, "ready");
    } else {
      await assert.rejects(pending, (error) => error === uncertain);
      assert.equal(store.current.state, "provisioning");
    }
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1], requests[0]);
  }
});

test("bounded Retry-After retries three times with the exact same provision request", async () => {
  const store = credentialPort(createInitialTrialCredentialRecord({
    pluginMark: PLUGIN_MARK,
    apiKey: API_KEY,
  }));
  const requests = [];
  const delays = [];
  const retryAfter = new TrialProvisionClientError("rate_limit_exceeded", {
    httpStatus: 429,
    retryAfterMs: 25_000,
  });

  const result = await ensureTrialCredentialReady(flowOptions({
    credentialPort: store,
    client: {
      requestPowChallenge: async () => challenge(),
      provision: async (request) => {
        requests.push({ ...request });
        if (requests.length <= 3) throw retryAfter;
        return metadata();
      },
    },
    sleep: async (delay) => { delays.push(delay); },
  }));

  assert.equal(result.status, "ready");
  assert.equal(requests.length, 4);
  assert.deepEqual(delays, [25_000, 25_000, 25_000]);
  assert.deepEqual(requests.slice(1), [requests[0], requests[0], requests[0]]);
  assert.equal(requests[0].recoverApiKey, false);
  assert.equal(store.current.api_key, API_KEY);
});

test("pow_expired refreshes the challenge at most twice within one bounded flow", async () => {
  const store = credentialPort(createInitialTrialCredentialRecord({
    pluginMark: PLUGIN_MARK,
    apiKey: API_KEY,
  }));
  let challengeCalls = 0;
  let provisionCalls = 0;
  const seenChallenges = [];
  const error = new TrialProvisionClientError("pow_expired", { httpStatus: 400 });

  await assert.rejects(
    ensureTrialCredentialReady(flowOptions({
      credentialPort: store,
      client: {
        requestPowChallenge: async () => challenge(++challengeCalls),
        provision: async (request) => {
          provisionCalls += 1;
          seenChallenges.push(request.powChallenge);
          throw error;
        },
      },
    })),
    (caught) => caught === error,
  );

  assert.equal(challengeCalls, 3);
  assert.equal(provisionCalls, 3);
  assert.equal(new Set(seenChallenges).size, 3);
  assert.equal(store.current.state, "provisioning");
});

test("internal deadline and caller cancellation have distinct stable reasons", async () => {
  for (const phase of ["challenge", "pow"]) {
    const store = credentialPort(createInitialTrialCredentialRecord({
      pluginMark: PLUGIN_MARK,
      apiKey: API_KEY,
    }));
    const waitForAbort = (signal, error) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(error), { once: true });
    });
    await assert.rejects(
      ensureTrialCredentialReady(flowOptions({
        credentialPort: store,
        now: Date.now,
        totalTimeoutMs: 20,
        client: {
          requestPowChallenge: async (_mark, { signal }) => phase === "challenge"
            ? waitForAbort(signal, new TrialProvisionClientError("aborted"))
            : challenge(),
          provision: async () => metadata(),
        },
        solvePow: phase === "pow"
          ? async (_challenge, _bits, { signal }) => waitForAbort(
              signal,
              new Error("worker aborted"),
            )
          : async () => "88405",
      })),
      (error) => error instanceof TrialProvisionFlowError
        && error.reason === "deadline_exceeded",
    );
  }

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    ensureTrialCredentialReady(flowOptions({
      credentialPort: credentialPort(createInitialTrialCredentialRecord({
        pluginMark: PLUGIN_MARK,
        apiKey: API_KEY,
      })),
      signal: controller.signal,
    })),
    (error) => error instanceof TrialProvisionFlowError && error.reason === "aborted",
  );
});

test("slow credential reads cannot return ready after cancellation or deadline", async () => {
  for (const mode of ["caller", "deadline"]) {
    const store = credentialPort(readyRecord());
    const originalLoad = store.load.bind(store);
    store.load = async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return originalLoad();
    };
    const controller = new AbortController();
    const pending = ensureTrialCredentialReady(flowOptions({
      credentialPort: store,
      now: Date.now,
      totalTimeoutMs: mode === "deadline" ? 20 : 1_000,
      signal: mode === "caller" ? controller.signal : undefined,
    }));
    if (mode === "caller") controller.abort();
    await assert.rejects(
      pending,
      (error) => error instanceof TrialProvisionFlowError
        && error.reason === (mode === "caller" ? "aborted" : "deadline_exceeded"),
    );
  }
});

test("a ready commit remains atomic when the caller deadline expires", async () => {
  const store = credentialPort(createInitialTrialCredentialRecord({
    pluginMark: PLUGIN_MARK,
    apiKey: API_KEY,
  }));
  const originalTransition = store.transition.bind(store);
  store.transition = async (operation) => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    return originalTransition(operation);
  };

  await assert.rejects(
    ensureTrialCredentialReady(flowOptions({
      credentialPort: store,
      now: Date.now,
      totalTimeoutMs: 20,
    })),
    (error) => error instanceof TrialProvisionFlowError
      && error.reason === "deadline_exceeded",
  );
  assert.equal(store.current.state, "ready");
  assert.equal((await ensureTrialCredentialReady(flowOptions({ credentialPort: store }))).provisioned, false);
});

test("mixed retry classes stop at the global HTTP request budget", async () => {
  const store = credentialPort(createInitialTrialCredentialRecord({
    pluginMark: PLUGIN_MARK,
    apiKey: API_KEY,
  }));
  let challengeCalls = 0;
  const provisionRequests = [];
  const delays = [];
  await assert.rejects(
    ensureTrialCredentialReady(flowOptions({
      credentialPort: store,
      client: {
        requestPowChallenge: async () => challenge(++challengeCalls),
        provision: async (request) => {
          provisionRequests.push({ ...request });
          if (provisionRequests.length === 1) {
            throw new TrialProvisionClientError("server_error", { httpStatus: 500 });
          }
          if (provisionRequests.length === 2) {
            throw new TrialProvisionClientError("rate_limit_exceeded", {
              httpStatus: 429,
              retryAfterMs: 0,
            });
          }
          if (provisionRequests.length === 3) {
            throw new TrialProvisionClientError("pow_expired", { httpStatus: 400 });
          }
          throw new TrialProvisionClientError("server_error", { httpStatus: 500 });
        },
      },
      maxHttpRequests: 8,
      sleep: async (delay) => { delays.push(delay); },
    })),
    (error) => error instanceof TrialProvisionFlowError
      && error.reason === "http_budget_exhausted",
  );
  assert.equal(challengeCalls, 2);
  assert.equal(provisionRequests.length, 6);
  assert.equal(challengeCalls + provisionRequests.length, 8);
  assert.deepEqual(delays, [1000, 0, 1000, 2000, 4000]);
  assert.deepEqual(
    new Set(provisionRequests.map((request) => request.pluginMark)),
    new Set([PLUGIN_MARK]),
  );
  assert.deepEqual(
    new Set(provisionRequests.map((request) => request.apiKey)),
    new Set([API_KEY]),
  );
  assert.deepEqual(
    provisionRequests.map((request) => request.powChallenge),
    [
      challenge(1).powChallenge,
      challenge(1).powChallenge,
      challenge(1).powChallenge,
      challenge(2).powChallenge,
      challenge(2).powChallenge,
      challenge(2).powChallenge,
    ],
  );
  assert.equal(provisionRequests.every((request) => request.recoverApiKey === false), true);
  assert.equal(store.current.state, "provisioning");
});

test("concurrent flows serialize provisioning and the second reads ready", async () => {
  const store = credentialPort(createInitialTrialCredentialRecord({
    pluginMark: PLUGIN_MARK,
    apiKey: API_KEY,
  }));
  const originalLoad = store.load.bind(store);
  let loadCalls = 0;
  store.load = async () => {
    loadCalls += 1;
    return await originalLoad();
  };

  let releaseFirstProvision;
  const firstProvisionReleased = new Promise((resolve) => {
    releaseFirstProvision = resolve;
  });
  let markFirstProvisionStarted;
  const firstProvisionStarted = new Promise((resolve) => {
    markFirstProvisionStarted = resolve;
  });
  let challengeCalls = 0;
  let provisionCalls = 0;
  const client = {
    requestPowChallenge: async () => {
      challengeCalls += 1;
      return challenge();
    },
    provision: async () => {
      provisionCalls += 1;
      markFirstProvisionStarted();
      await firstProvisionReleased;
      return metadata();
    },
  };

  const first = ensureTrialCredentialReady(flowOptions({ credentialPort: store, client }));
  await firstProvisionStarted;
  const second = ensureTrialCredentialReady(flowOptions({ credentialPort: store, client }));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(loadCalls, 1);
  assert.equal(challengeCalls, 1);
  assert.equal(provisionCalls, 1);
  releaseFirstProvision();

  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.provisioned, true);
  assert.equal(secondResult.provisioned, false);
  assert.equal(loadCalls, 2);
  assert.equal(challengeCalls, 1);
  assert.equal(provisionCalls, 1);
  assert.equal(store.current.state, "ready");
  assert.equal(store.current.project_id, PROJECT_ID);
});

test("provision lock waiting honors the total deadline and caller cancellation", async () => {
  const store = credentialPort(createInitialTrialCredentialRecord({
    pluginMark: PLUGIN_MARK,
    apiKey: API_KEY,
  }));
  let releaseHolder;
  const hold = new Promise((resolve) => { releaseHolder = resolve; });
  let markEntered;
  const entered = new Promise((resolve) => { markEntered = resolve; });
  const holder = ensureTrialCredentialReady(flowOptions({
    credentialPort: store,
    client: {
      requestPowChallenge: async () => challenge(),
      provision: async () => {
        markEntered();
        await hold;
        return metadata();
      },
    },
  }));
  await entered;

  let networkCalls = 0;
  const waitingOptions = {
    credentialPort: store,
    now: Date.now,
    client: {
      requestPowChallenge: async () => { networkCalls += 1; },
      provision: async () => { networkCalls += 1; },
    },
  };
  try {
    await assert.rejects(
      ensureTrialCredentialReady(flowOptions({ ...waitingOptions, totalTimeoutMs: 20 })),
      (error) => error instanceof TrialProvisionFlowError
        && error.reason === "deadline_exceeded",
    );

    const controller = new AbortController();
    const cancelled = ensureTrialCredentialReady(flowOptions({
      ...waitingOptions,
      totalTimeoutMs: 1_000,
      signal: controller.signal,
    }));
    controller.abort();
    await assert.rejects(
      cancelled,
      (error) => error instanceof TrialProvisionFlowError && error.reason === "aborted",
    );
    assert.equal(networkCalls, 0);
  } finally {
    releaseHolder();
  }
  assert.equal((await holder).provisioned, true);
});

test("a stale response cannot overwrite a changed credential snapshot", async () => {
  const store = credentialPort(createInitialTrialCredentialRecord({
    pluginMark: PLUGIN_MARK,
    apiKey: API_KEY,
  }));
  const replacement = completeTrialCredentialProvisioning(
    createInitialTrialCredentialRecord({ hostname: "other-laptop", apiKey: API_KEY }),
    metadata(),
  );
  const originalTransition = store.transition.bind(store);
  store.transition = async (operation) => {
    store.replace(replacement);
    return originalTransition(operation);
  };

  await assert.rejects(
    ensureTrialCredentialReady(flowOptions({ credentialPort: store })),
    (error) => error instanceof TrialProvisionFlowError
      && error.reason === "credential_conflict"
      && !String(error).includes(API_KEY),
  );
  assert.deepEqual(store.current, replacement);
});
