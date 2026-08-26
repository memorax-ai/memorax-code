import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  SecureCredentialBackendError,
} from "../../../ts/memorax-code-adapter-common/src/credentials/secure-command.mjs";
import {
  completeTrialCredentialProvisioning,
  createInitialTrialCredentialRecord,
  serializeTrialCredentialRecord,
  TrialCredentialRecordError,
} from "../../../ts/memorax-code-adapter-common/src/credentials/trial-credential-record.mjs";
import {
  clearTrialCredentialRecord,
  completeTrialCredentialRecord,
  createTrialCredentialRecordIfAbsent,
  createTrialCredentialStorePort,
  loadTrialCredentialRecord,
  trialCredentialNamespace,
  trialCredentialProvisionLockPath,
  withTrialCredentialProvisionLock,
} from "../../../ts/memorax-code-adapter-common/src/credentials/trial-credential-store.mjs";

const API_KEY = `sk_${"C".repeat(43)}`;
const MARK_ID = `mk_${"c".repeat(64)}`;
const OTHER_MARK_ID = `mk_${"d".repeat(64)}`;
const DEVICE = Object.freeze({
  markId: MARK_ID,
  markVersion: 1,
  appSalt: "memorax-plugin-v1",
  machineId: "550e8400-e29b-41d4-a716-446655440000",
  hostname: "developer-laptop",
  platform: "linux",
  arch: "x86_64",
  macHash: "4".repeat(64),
});

test("credential namespace and provision lock stay scoped to MemoraX Code home", async () => {
  const first = trialCredentialNamespace("/private/example/../first-home");
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(first, trialCredentialNamespace("/private/first-home/"));
  assert.notEqual(first, trialCredentialNamespace("/private/second-home"));
  assert.equal(first.includes("first-home"), false);

  await withIsolatedHome(async (home) => {
    assert.equal(
      trialCredentialProvisionLockPath(home),
      join(home, "runtime", "credentials", "trial-provision"),
    );
  });
});

test("credential provision lock serializes callers", async () => {
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
    }, options);
    await firstEntered.promise;
    const second = withTrialCredentialProvisionLock(() => {
      events.push("second-enter");
    }, options);
    await delay(25);
    assert.deepEqual(events, ["first-enter"]);
    releaseFirst.resolve();
    await Promise.all([first, second]);
    assert.deepEqual(events, ["first-enter", "first-exit", "second-enter"]);
  });
});

test("credential store creates, completes, and explicitly clears", async () => {
  await withIsolatedHome(async (home) => {
    const storage = memoryBackend();
    const options = { memoraxCodeHome: home, backend: storage.backend };
    const port = createTrialCredentialStorePort(options);
    const initial = initialCredential();

    assert.deepEqual(await port.createIfAbsent(initial), { record: initial, created: true });
    const ready = await port.complete(initial, READY_METADATA);
    assert.equal(ready.state, "ready");
    assert.equal(ready.api_key, API_KEY);
    assert.deepEqual(await clearTrialCredentialRecord(options), { deleted: true });
    assert.equal(await loadTrialCredentialRecord(options), null);
    assert.deepEqual(await clearTrialCredentialRecord(options), { deleted: false });
  });
});

test("credential creation is atomic and clear is the only identity reset", async () => {
  await withIsolatedHome(async (home) => {
    const storage = memoryBackend(null, 15);
    const options = { memoraxCodeHome: home, backend: storage.backend };
    const first = initialCredential();
    const second = initialCredential({ markId: OTHER_MARK_ID });

    const results = await Promise.all([
      createTrialCredentialRecordIfAbsent(first, options),
      createTrialCredentialRecordIfAbsent(second, options),
    ]);
    assert.deepEqual(results.map((result) => result.created).sort(), [false, true]);
    assert.deepEqual(results[0].record, results[1].record);
    assert.equal(storage.saveCalls, 1);

    await clearTrialCredentialRecord(options);
    assert.deepEqual(await createTrialCredentialRecordIfAbsent(second, options), {
      record: second,
      created: true,
    });
  });
});

test("credential completion requires the exact stored provisioning identity", async () => {
  await withIsolatedHome(async (home) => {
    const initial = initialCredential();
    const storage = memoryBackend(serializeTrialCredentialRecord(initial));
    const options = { memoraxCodeHome: home, backend: storage.backend };
    await assert.rejects(
      completeTrialCredentialRecord(
        initialCredential({ markId: OTHER_MARK_ID }),
        READY_METADATA,
        options,
      ),
      invalidTransitionError,
    );
    assert.equal(storage.saveCalls, 0);

    const ready = await completeTrialCredentialRecord(initial, READY_METADATA, options);
    assert.equal(ready.state, "ready");
    await assert.rejects(
      completeTrialCredentialRecord(initial, READY_METADATA, options),
      invalidTransitionError,
    );
  });
});

test("invalid secure records cannot be overwritten by ordinary creation", async () => {
  await withIsolatedHome(async (home) => {
    const replacement = initialCredential();
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
      await clearTrialCredentialRecord(options);
    }
  });
});

test("credential store fails closed when a write cannot be verified", async () => {
  await withIsolatedHome(async (home) => {
    const discarded = memoryBackend();
    discarded.backend.save = async () => undefined;
    await assert.rejects(
      createTrialCredentialRecordIfAbsent(initialCredential(), {
        memoraxCodeHome: home,
        backend: discarded.backend,
      }),
      (error) => error instanceof SecureCredentialBackendError && error.operation === "save",
    );
  });
});

function initialCredential(overrides = {}) {
  return createInitialTrialCredentialRecord({ ...DEVICE, ...overrides });
}

function readyRecord(base = initialCredential()) {
  return completeTrialCredentialProvisioning(base, READY_METADATA);
}

const READY_METADATA = Object.freeze({
  apiKey: API_KEY,
  accountId: "900719925474099300000000001",
  projectId: "900719925474099300000000002",
});

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

function deferred() {
  let resolve;
  const promise = new Promise((complete) => { resolve = complete; });
  return { promise, resolve };
}

function invalidTransitionError(error) {
  return error instanceof TrialCredentialRecordError
    && error.reason === "invalid_transition";
}
