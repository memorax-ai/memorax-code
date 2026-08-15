import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  SecureCredentialBackendError,
} from "../../../ts/memorax-code-adapter-common/src/credentials/secure-command.mjs";
import {
  TrialCredentialRecordError,
  beginTrialCredentialRecovery,
  completeTrialCredentialProvisioning,
  createInitialTrialCredentialRecord,
  createTrialCredentialRecoveryRecord,
  serializeTrialCredentialRecord,
} from "../../../ts/memorax-code-adapter-common/src/credentials/trial-credential-record.mjs";
import {
  clearTrialCredentialRecord,
  createTrialCredentialRecordIfAbsent,
  loadTrialCredentialRecord,
  transitionTrialCredentialRecord,
  trialCredentialNamespace,
} from "../../../ts/memorax-code-adapter-common/src/credentials/trial-credential-store.mjs";

const API_KEY = `sk_${"C".repeat(43)}`;
const RECOVERY_KEY = `sk_${"D".repeat(43)}`;
const OTHER_KEY = `sk_${"E".repeat(43)}`;
const PLUGIN_MARK = `mk_${"c".repeat(32)}`;
const OTHER_PLUGIN_MARK = `mk_${"d".repeat(32)}`;

test("credential namespaces isolate normalized MemoraX Code homes without exposing paths", () => {
  const first = trialCredentialNamespace("/private/example/../first-home");
  const equivalent = trialCredentialNamespace("/private/first-home/");
  const second = trialCredentialNamespace("/private/second-home");

  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(first, equivalent);
  assert.notEqual(first, second);
  assert.equal(first.includes("first-home"), false);
  assert.equal(
    trialCredentialNamespace("C:\\Users\\Example\\Home", {
      platform: "win32",
      resolveHome: (value) => value,
    }),
    trialCredentialNamespace("c:\\users\\example\\home", {
      platform: "win32",
      resolveHome: (value) => value,
    }),
  );
});

test("credential store creates once, transitions, verifies, and explicitly clears one record", async () => {
  await withIsolatedHome(async (home) => {
    const storage = memoryBackend();
    const options = { memoraxCodeHome: home, backend: storage.backend };
    const initial = createInitialTrialCredentialRecord({ pluginMark: PLUGIN_MARK, apiKey: API_KEY });

    assert.equal(await loadTrialCredentialRecord(options), null);
    assert.deepEqual(await createTrialCredentialRecordIfAbsent(initial, options), {
      record: initial,
      created: true,
    });
    assert.deepEqual(await loadTrialCredentialRecord(options), initial);

    const ready = await transitionTrialCredentialRecord(
      (current) => readyRecord(current),
      options,
    );
    const recovery = await transitionTrialCredentialRecord(
      (current) => beginTrialCredentialRecovery(current, { apiKey: RECOVERY_KEY }),
      options,
    );
    assert.equal(ready.state, "ready");
    assert.equal(recovery.state, "recovering");
    assert.equal(recovery.api_key, RECOVERY_KEY);
    assert.equal(recovery.account_id, "900719925474099300000000001");

    const writesBeforeNoChange = storage.saveCalls;
    assert.deepEqual(
      await transitionTrialCredentialRecord(() => undefined, options),
      recovery,
    );
    assert.equal(storage.saveCalls, writesBeforeNoChange);

    assert.deepEqual(await clearTrialCredentialRecord(options), { deleted: true });
    assert.equal(await loadTrialCredentialRecord(options), null);
    assert.deepEqual(await clearTrialCredentialRecord(options), { deleted: false });
  });
});

test("credential creation is atomic and clear is the only identity reset", async () => {
  await withIsolatedHome(async (home) => {
    const storage = memoryBackend(null, 15);
    const options = { memoraxCodeHome: home, backend: storage.backend };
    const first = createInitialTrialCredentialRecord({
      pluginMark: PLUGIN_MARK,
      apiKey: API_KEY,
    });
    const second = createInitialTrialCredentialRecord({
      pluginMark: OTHER_PLUGIN_MARK,
      apiKey: OTHER_KEY,
    });

    const results = await Promise.all([
      createTrialCredentialRecordIfAbsent(first, options),
      createTrialCredentialRecordIfAbsent(second, options),
    ]);
    assert.deepEqual(results.map((result) => result.created).sort(), [false, true]);
    assert.deepEqual(results[0].record, results[1].record);
    assert.equal(storage.saveCalls, 1);
    assert.deepEqual(await loadTrialCredentialRecord(options), results[0].record);

    await clearTrialCredentialRecord(options);
    assert.deepEqual(await createTrialCredentialRecordIfAbsent(second, options), {
      record: second,
      created: true,
    });
    assert.equal(storage.saveCalls, 2);
  });
});

test("explicit mark-only recovery persists the new Key before completion", async () => {
  await withIsolatedHome(async (home) => {
    const storage = memoryBackend();
    const options = { memoraxCodeHome: home, backend: storage.backend };
    const recovery = createTrialCredentialRecoveryRecord({
      pluginMark: PLUGIN_MARK,
      apiKey: RECOVERY_KEY,
    });

    assert.deepEqual(await createTrialCredentialRecordIfAbsent(recovery, options), {
      record: recovery,
      created: true,
    });
    assert.equal((await loadTrialCredentialRecord(options)).state, "recovering");

    const completed = await transitionTrialCredentialRecord(
      (current) => completeTrialCredentialProvisioning(current, {
        accountId: "900719925474099300000000001",
        projectId: "900719925474099300000000002",
        warnRemainingThreshold: 5000,
        warnRemainingStep: 1000,
        registerUrl: "https://platform.memorax.net/register",
      }),
      options,
    );
    assert.equal(completed.state, "ready");
    assert.equal(completed.api_key, RECOVERY_KEY);
  });
});

test("stored transitions cannot replace identity, rotate a retry Key, or skip recovery", async () => {
  const initial = createInitialTrialCredentialRecord({
    pluginMark: PLUGIN_MARK,
    apiKey: API_KEY,
  });
  const ready = { ...readyRecord(initial), last_warned_level: 4000 };
  const recovering = beginTrialCredentialRecovery(ready, { apiKey: RECOVERY_KEY });
  const cases = [
    [ready, { ...ready, plugin_mark: OTHER_PLUGIN_MARK }],
    [ready, { ...ready, account_id: "900719925474099300000000099" }],
    [ready, { ...ready, project_id: "900719925474099300000000099" }],
    [ready, { ...ready, api_key: RECOVERY_KEY }],
    [ready, initial],
    [ready, { ...ready, state: "recovering" }],
    [ready, {
      ...recovering,
      register_url: "https://platform.memorax.net/another-register",
    }],
    [ready, {
      ...ready,
      warn_remaining_threshold: 3000,
      last_warned_level: 1000,
    }],
    [initial, { ...readyRecord(initial), api_key: RECOVERY_KEY }],
    [recovering, { ...ready, api_key: OTHER_KEY }],
    [recovering, { ...recovering, api_key: OTHER_KEY }],
  ];

  for (const [current, candidate] of cases) {
    await withIsolatedHome(async (home) => {
      const serialized = serializeTrialCredentialRecord(current);
      const storage = memoryBackend(serialized);
      const options = { memoraxCodeHome: home, backend: storage.backend };
      await assert.rejects(
        transitionTrialCredentialRecord(() => candidate, options),
        invalidTransitionError,
      );
      assert.equal(storage.saveCalls, 0);
      assert.deepEqual(await loadTrialCredentialRecord(options), current);
    });
  }

  await withIsolatedHome(async (home) => {
    const storage = memoryBackend();
    const options = { memoraxCodeHome: home, backend: storage.backend };
    await assert.rejects(
      transitionTrialCredentialRecord(() => initial, options),
      invalidTransitionError,
    );
    assert.equal(storage.saveCalls, 0);
  });
});

test("invalid and unsupported secure records cannot be overwritten by ordinary creation", async () => {
  await withIsolatedHome(async (home) => {
    const replacement = createInitialTrialCredentialRecord({
      pluginMark: PLUGIN_MARK,
      apiKey: API_KEY,
    });
    for (const [serialized, reason] of [
      ["{not-json", "malformed_json"],
      [JSON.stringify({ ...replacement, version: 2 }), "unsupported_version"],
    ]) {
      const storage = memoryBackend(serialized);
      const options = { memoraxCodeHome: home, backend: storage.backend };
      await assert.rejects(
        createTrialCredentialRecordIfAbsent(replacement, options),
        (error) => error instanceof TrialCredentialRecordError && error.reason === reason,
      );
      assert.equal(storage.saveCalls, 0);
      assert.deepEqual(await clearTrialCredentialRecord(options), { deleted: true });
    }
  });
});

test("credential mutation lock prevents concurrent read-modify-write loss", async () => {
  await withIsolatedHome(async (home) => {
    const storage = memoryBackend(serializeTrialCredentialRecord(readyRecord()), 15);
    const options = { memoraxCodeHome: home, backend: storage.backend };
    const lowerWarningLevel = (current) => ({
      ...current,
      last_warned_level: current.last_warned_level === null
        ? current.warn_remaining_threshold
        : current.last_warned_level - current.warn_remaining_step,
    });

    const results = await Promise.all([
      transitionTrialCredentialRecord(lowerWarningLevel, options),
      transitionTrialCredentialRecord(lowerWarningLevel, options),
    ]);

    assert.deepEqual(results.map((record) => record.last_warned_level), [5000, 4000]);
    assert.equal((await loadTrialCredentialRecord(options)).last_warned_level, 4000);
  });
});

test("credential store preserves recovery identity and resets stale warning policy state", async () => {
  await withIsolatedHome(async (home) => {
    const ready = {
      ...readyRecord(),
      last_warned_level: 4000,
    };
    const storage = memoryBackend(serializeTrialCredentialRecord(ready));
    const options = { memoraxCodeHome: home, backend: storage.backend };
    await transitionTrialCredentialRecord(
      (current) => beginTrialCredentialRecovery(current, { apiKey: RECOVERY_KEY }),
      options,
    );

    const writesBeforeRejectedIdentity = storage.saveCalls;
    await assert.rejects(
      transitionTrialCredentialRecord(
        (current) => completeTrialCredentialProvisioning(current, {
          accountId: "900719925474099300000000099",
          projectId: current.project_id,
          warnRemainingThreshold: 3000,
          warnRemainingStep: 1000,
          registerUrl: current.register_url,
        }),
        options,
      ),
      (error) => error instanceof TrialCredentialRecordError
        && error.reason === "invalid_transition",
    );
    assert.equal(storage.saveCalls, writesBeforeRejectedIdentity);

    const completed = await transitionTrialCredentialRecord(
      (current) => completeTrialCredentialProvisioning(current, {
        accountId: current.account_id,
        projectId: current.project_id,
        warnRemainingThreshold: 3000,
        warnRemainingStep: 1000,
        registerUrl: current.register_url,
      }),
      options,
    );
    assert.equal(completed.state, "ready");
    assert.equal(completed.account_id, ready.account_id);
    assert.equal(completed.project_id, ready.project_id);
    assert.equal(completed.last_warned_level, null);
    assert.deepEqual(await loadTrialCredentialRecord(options), completed);
  });
});

test("credential store fails closed on unverified writes, hostile backend errors, and platforms", async () => {
  await withIsolatedHome(async (home) => {
    const record = createInitialTrialCredentialRecord({ pluginMark: PLUGIN_MARK, apiKey: API_KEY });
    const discarded = memoryBackend();
    discarded.backend.save = async () => undefined;
    await assert.rejects(
      createTrialCredentialRecordIfAbsent(record, {
        memoraxCodeHome: home,
        backend: discarded.backend,
      }),
      redactedBackendError("save"),
    );

    const hostile = {
      load: async () => { throw new Error(`${API_KEY} ${PLUGIN_MARK}`); },
      save: async () => undefined,
      delete: async () => false,
    };
    await assert.rejects(
      loadTrialCredentialRecord({ memoraxCodeHome: home, backend: hostile }),
      redactedBackendError("load"),
    );

    const injectedBackendError = new SecureCredentialBackendError({
      backend: "macos-keychain",
      operation: "load",
      reason: "storage_failed",
    });
    injectedBackendError.message = API_KEY;
    injectedBackendError.stack = API_KEY;
    const hostileBackendError = new Proxy(injectedBackendError, {
      get(target, field, receiver) {
        if (field === "reason") throw new Error(API_KEY);
        return Reflect.get(target, field, receiver);
      },
    });
    await assert.rejects(
      loadTrialCredentialRecord({
        memoraxCodeHome: home,
        backend: {
          load: async () => { throw hostileBackendError; },
          save: async () => undefined,
          delete: async () => false,
        },
      }),
      redactedBackendError("load"),
    );

    await assert.rejects(
      loadTrialCredentialRecord({
        memoraxCodeHome: home,
        platform: "aix",
        env: {},
      }),
      redactedBackendError("initialize"),
    );
  });
});

test("credential mutations must be synchronous and cannot persist partial async results", async () => {
  await withIsolatedHome(async (home) => {
    const storage = memoryBackend();
    const options = { memoraxCodeHome: home, backend: storage.backend };
    const initial = createInitialTrialCredentialRecord({
      pluginMark: PLUGIN_MARK,
      apiKey: API_KEY,
    });
    await createTrialCredentialRecordIfAbsent(initial, options);
    await assert.rejects(
      transitionTrialCredentialRecord(async () => readyRecord(initial), options),
      { name: "TypeError", message: "Trial credential mutation must be synchronous" },
    );

    const injectedRecordError = new TrialCredentialRecordError("invalid_api_key");
    injectedRecordError.message = API_KEY;
    injectedRecordError.stack = API_KEY;
    await assert.rejects(
      transitionTrialCredentialRecord(() => { throw injectedRecordError; }, options),
      redactedRecordError("invalid_api_key"),
    );

    const hostileRecordError = new Proxy(injectedRecordError, {
      get(target, field, receiver) {
        if (field === "reason") throw new Error(API_KEY);
        return Reflect.get(target, field, receiver);
      },
    });
    await assert.rejects(
      transitionTrialCredentialRecord(() => { throw hostileRecordError; }, options),
      redactedRecordError("invalid_transition"),
    );

    const hostileThenable = {};
    Object.defineProperty(hostileThenable, "then", {
      get() {
        throw new Error(API_KEY);
      },
    });
    await assert.rejects(
      transitionTrialCredentialRecord(() => hostileThenable, options),
      redactedRecordError("invalid_transition"),
    );

    const unhandled = [];
    const onUnhandledRejection = (reason) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandledRejection);
    try {
      await assert.rejects(
        transitionTrialCredentialRecord(() => Promise.reject(new Error(API_KEY)), options),
        { name: "TypeError", message: "Trial credential mutation must be synchronous" },
      );
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(unhandled, []);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
    assert.equal(storage.saveCalls, 1);
  });
});

function readyRecord(base = undefined) {
  const record = base ?? createInitialTrialCredentialRecord({
    pluginMark: PLUGIN_MARK,
    apiKey: API_KEY,
  });
  return {
    ...record,
    state: "ready",
    account_id: "900719925474099300000000001",
    project_id: "900719925474099300000000002",
    warn_remaining_threshold: 5000,
    warn_remaining_step: 1000,
    register_url: "https://platform.memorax.net/register",
    last_warned_level: null,
  };
}

function memoryBackend(initial = null, delayMs = 0) {
  let serialized = initial;
  const storage = {
    saveCalls: 0,
    backend: {
      async load() {
        await delay(delayMs);
        return serialized;
      },
      async save(value) {
        await delay(delayMs);
        storage.saveCalls += 1;
        serialized = value;
      },
      async delete() {
        await delay(delayMs);
        const deleted = serialized !== null;
        serialized = null;
        return deleted;
      },
    },
  };
  return storage;
}

async function withIsolatedHome(operation) {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-trial-store-"));
  try {
    await operation(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

function delay(milliseconds) {
  return milliseconds > 0
    ? new Promise((resolve) => setTimeout(resolve, milliseconds))
    : undefined;
}

function redactedBackendError(operation) {
  return (error) => {
    assert.ok(error instanceof SecureCredentialBackendError);
    assert.equal(error.code, "TRIAL_CREDENTIAL_BACKEND_ERROR");
    assert.equal(error.operation, operation);
    const publicError = publicErrorText(error);
    assert.equal(publicError.includes(API_KEY), false);
    assert.equal(publicError.includes(PLUGIN_MARK), false);
    return true;
  };
}

function redactedRecordError(reason) {
  return (error) => {
    assert.ok(error instanceof TrialCredentialRecordError);
    assert.equal(error.code, "TRIAL_CREDENTIAL_RECORD_INVALID");
    assert.equal(error.reason, reason);
    const publicError = publicErrorText(error);
    assert.equal(publicError.includes(API_KEY), false);
    assert.equal(publicError.includes(PLUGIN_MARK), false);
    return true;
  };
}

function invalidTransitionError(error) {
  return error instanceof TrialCredentialRecordError
    && error.reason === "invalid_transition";
}

function publicErrorText(error) {
  return [
    error.name,
    error.message,
    error.stack ?? "",
    error.code,
    error.reason,
    error.backend,
    error.operation,
    JSON.stringify(error),
  ].join(" ");
}
