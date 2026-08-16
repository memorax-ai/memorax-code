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
  createInitialTrialCredentialRecord,
  serializeTrialCredentialRecord,
} from "../../../ts/memorax-code-adapter-common/src/credentials/trial-credential-record.mjs";
import {
  clearTrialCredentialRecord,
  createTrialCredentialStorePort,
  createTrialCredentialRecordIfAbsent,
  loadTrialCredentialRecord,
  transitionTrialCredentialRecord,
  trialCredentialNamespace,
  trialCredentialProvisionLockPath,
  withTrialCredentialProvisionLock,
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

test("credential provision lock path stays inside the isolated MemoraX Code home", async () => {
  await withIsolatedHome(async (home) => {
    assert.equal(
      trialCredentialProvisionLockPath(home),
      join(home, "runtime", "credentials", "trial-provision"),
    );
  });
});

test("credential provision lock serializes concurrent provisioning operations", async () => {
  await withIsolatedHome(async (home) => {
    const options = {
      memoraxCodeHome: home,
      provisionLockOptions: { timeoutMs: 1_000, retryMs: 5 },
    };
    const firstEntered = deferred();
    const releaseFirst = deferred();
    const events = [];
    const first = withTrialCredentialProvisionLock(async () => {
      events.push("first-enter");
      firstEntered.resolve();
      await releaseFirst.promise;
      events.push("first-exit");
      return "first";
    }, options);

    await firstEntered.promise;
    const second = withTrialCredentialProvisionLock(async () => {
      events.push("second-enter");
      events.push("second-exit");
      return "second";
    }, options);
    await delay(25);
    assert.deepEqual(events, ["first-enter"]);

    releaseFirst.resolve();
    assert.deepEqual(await Promise.all([first, second]), ["first", "second"]);
    assert.deepEqual(events, [
      "first-enter",
      "first-exit",
      "second-enter",
      "second-exit",
    ]);
  });
});

test("credential clear waits for an in-flight provisioning lock", async () => {
  await withIsolatedHome(async (home) => {
    const storage = memoryBackend(serializeTrialCredentialRecord(readyRecord()));
    const options = {
      memoraxCodeHome: home,
      backend: storage.backend,
      provisionLockOptions: { timeoutMs: 1_000, retryMs: 5 },
    };
    const provisionEntered = deferred();
    const releaseProvision = deferred();
    const provisioning = withTrialCredentialProvisionLock(async () => {
      provisionEntered.resolve();
      await releaseProvision.promise;
    }, options);

    await provisionEntered.promise;
    const clearing = clearTrialCredentialRecord(options);
    await delay(25);
    assert.equal(storage.deleteCalls, 0);

    releaseProvision.resolve();
    await provisioning;
    assert.deepEqual(await clearing, { deleted: true });
    assert.equal(storage.deleteCalls, 1);
    assert.equal(await loadTrialCredentialRecord(options), null);
  });
});

test("credential store port binds storage and forwards per-call provision lock controls", async () => {
  await withIsolatedHome(async (home) => {
    const storage = memoryBackend();
    const options = {
      memoraxCodeHome: home,
      backend: storage.backend,
      provisionLockOptions: { timeoutMs: 1_000, retryMs: 5 },
    };
    const port = createTrialCredentialStorePort(options);
    const initial = createInitialTrialCredentialRecord({
      pluginMark: PLUGIN_MARK,
      apiKey: API_KEY,
    });
    assert.deepEqual(await port.createIfAbsent(initial), { record: initial, created: true });
    assert.deepEqual(await port.load(), initial);

    const holderEntered = deferred();
    const releaseHolder = deferred();
    const holder = withTrialCredentialProvisionLock(async () => {
      holderEntered.resolve();
      await releaseHolder.promise;
    }, options);
    await holderEntered.promise;

    await assert.rejects(
      port.withProvisionLock(() => undefined, { timeoutMs: 20, retryMs: 5 }),
      (error) => error?.code === "JSON_FILE_LOCK_TIMEOUT",
    );
    const controller = new AbortController();
    const waiting = port.withProvisionLock(() => undefined, {
      signal: controller.signal,
      timeoutMs: 500,
      retryMs: 5,
    });
    controller.abort();
    await assert.rejects(waiting, (error) => error?.code === "JSON_FILE_LOCK_ABORTED");

    releaseHolder.resolve();
    await holder;
    const ready = await port.transition((current) => readyRecord(current));
    assert.equal(ready.state, "ready");
    assert.deepEqual(await port.load(), ready);

    let locked = false;
    await port.withProvisionLock(() => { locked = true; });
    assert.equal(locked, true);
  });
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

test("stored transitions cannot replace identity, rotate a retry Key, or skip recovery", async () => {
  const initial = createInitialTrialCredentialRecord({
    pluginMark: PLUGIN_MARK,
    apiKey: API_KEY,
  });
  const ready = { ...readyRecord(initial), last_warned_level: 4000 };
  const recovering = beginTrialCredentialRecovery(ready, { apiKey: RECOVERY_KEY });
  const cases = [
    [ready, { ...ready, plugin_mark: OTHER_PLUGIN_MARK }],
    [ready, { ...ready, api_key: RECOVERY_KEY }],
    [ready, { ...ready, account_id: "900719925474099300000000003" }],
    [ready, { ...ready, project_id: "900719925474099300000000004" }],
    [ready, initial],
    [initial, { ...readyRecord(initial), api_key: OTHER_KEY }],
    [recovering, { ...recovering, api_key: OTHER_KEY }],
    [recovering, { ...readyRecord(recovering), api_key: OTHER_KEY }],
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

test("credential store fails closed on unverified writes and unavailable platforms", async () => {
  await withIsolatedHome(async (home) => {
    const record = createInitialTrialCredentialRecord({ pluginMark: PLUGIN_MARK, apiKey: API_KEY });
    const discarded = memoryBackend();
    discarded.backend.save = async () => undefined;
    await assert.rejects(
      createTrialCredentialRecordIfAbsent(record, {
        memoraxCodeHome: home,
        backend: discarded.backend,
      }),
      (error) => error instanceof SecureCredentialBackendError
        && error.operation === "save",
    );

    await assert.rejects(
      loadTrialCredentialRecord({
        memoraxCodeHome: home,
        platform: "aix",
        env: {},
      }),
      (error) => error instanceof SecureCredentialBackendError
        && error.operation === "initialize",
    );
  });
});

test("credential mutations must be synchronous and cannot persist partial results", async () => {
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
    deleteCalls: 0,
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
        storage.deleteCalls += 1;
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

function deferred() {
  let resolve;
  const promise = new Promise((complete) => { resolve = complete; });
  return { promise, resolve };
}

function invalidTransitionError(error) {
  return error instanceof TrialCredentialRecordError
    && error.reason === "invalid_transition";
}
