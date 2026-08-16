import assert from "node:assert/strict";
import test from "node:test";
import {
  beginTrialCredentialRecovery,
  completeTrialCredentialProvisioning,
  createInitialTrialCredentialRecord,
  createTrialCredentialRecoveryRecord,
  parseTrialCredentialRecord,
  serializeTrialCredentialRecord,
  TRIAL_CREDENTIAL_RECORD_VERSION,
  TrialCredentialRecordError,
  validateTrialCredentialRecord,
} from "../../../ts/memorax-code-adapter-common/src/credentials/trial-credential-record.mjs";

const RECORD_KEYS = [
  "version",
  "state",
  "plugin_mark",
  "api_key",
  "account_id",
  "project_id",
  "warn_remaining_threshold",
  "warn_remaining_step",
  "register_url",
  "last_warned_level",
];
const PLUGIN_MARK = `mk_${"a".repeat(32)}`;
const API_KEY = `sk_${"A".repeat(43)}`;
const RECOVERY_API_KEY = `sk_${"B".repeat(43)}`;
const ACCOUNT_ID = "900719925474099312345678901";
const PROJECT_ID = "900719925474099312345678902";
const REGISTER_URL = "https://platform.memorax.net/register";

function initialRecord(overrides = {}) {
  return {
    version: TRIAL_CREDENTIAL_RECORD_VERSION,
    state: "provisioning",
    plugin_mark: PLUGIN_MARK,
    api_key: API_KEY,
    account_id: null,
    project_id: null,
    warn_remaining_threshold: null,
    warn_remaining_step: null,
    register_url: null,
    last_warned_level: null,
    ...overrides,
  };
}

function completeRecord(overrides = {}) {
  return {
    ...initialRecord(),
    state: "ready",
    account_id: ACCOUNT_ID,
    project_id: PROJECT_ID,
    warn_remaining_threshold: 5000,
    warn_remaining_step: 1000,
    register_url: REGISTER_URL,
    last_warned_level: null,
    ...overrides,
  };
}

function expectInvalid(operation, reason, secrets = [API_KEY, RECOVERY_API_KEY]) {
  assert.throws(operation, (error) => {
    assert.ok(error instanceof TrialCredentialRecordError);
    assert.equal(error.code, "TRIAL_CREDENTIAL_RECORD_INVALID");
    assert.equal(error.reason, reason);
    for (const secret of secrets) {
      if (!secret) continue;
      assert.equal(String(error).includes(secret), false);
      assert.equal(String(error.stack).includes(secret), false);
    }
    return true;
  });
}

test("initial provisioning has the exact v1 shape and no server metadata", () => {
  const record = createInitialTrialCredentialRecord({
    pluginMark: PLUGIN_MARK,
    apiKey: API_KEY,
  });

  assert.deepEqual(record, initialRecord());
  assert.deepEqual(Object.keys(record), RECORD_KEYS);
  assert.equal(Object.isFrozen(record), true);
});

test("explicit recovery has a durable new Key before any network request", () => {
  const record = createTrialCredentialRecoveryRecord({
    pluginMark: PLUGIN_MARK,
    apiKey: RECOVERY_API_KEY,
  });

  assert.deepEqual(record, initialRecord({
    state: "recovering",
    api_key: RECOVERY_API_KEY,
  }));
  assert.equal(Object.isFrozen(record), true);
});

test("ready and recovering records retain complete metadata and decimal PublicIds", () => {
  const ready = validateTrialCredentialRecord(completeRecord({ last_warned_level: 4000 }));
  const recovery = validateTrialCredentialRecord({ ...ready, state: "recovering" });

  for (const record of [ready, recovery]) {
    assert.equal(record.account_id, ACCOUNT_ID);
    assert.equal(record.project_id, PROJECT_ID);
    assert.equal(typeof record.account_id, "string");
    assert.equal(typeof record.project_id, "string");
    assert.equal(record.last_warned_level, 4000);
    assert.equal(Object.isFrozen(record), true);
  }
});

test("parse and serialize round-trip one canonical exact-key record", () => {
  const source = completeRecord({ last_warned_level: 1000 });
  const serialized = serializeTrialCredentialRecord(source);
  const parsed = parseTrialCredentialRecord(serialized);

  assert.equal(serialized.endsWith("\n"), true);
  assert.deepEqual(Object.keys(JSON.parse(serialized)), RECORD_KEYS);
  assert.deepEqual(parsed, source);
  assert.equal(Object.isFrozen(parsed), true);
  assert.throws(
    () => parseTrialCredentialRecord(42),
    /input must be a string/,
  );
  expectInvalid(() => parseTrialCredentialRecord("{not-json"), "malformed_json");
});

test("record validation rejects every missing key and every unknown field", () => {
  for (const key of RECORD_KEYS) {
    const candidate = completeRecord();
    delete candidate[key];
    expectInvalid(() => validateTrialCredentialRecord(candidate), "missing_fields");
  }

  for (const extra of [
    { user_id: "must-not-alias-account-id" },
    { future_field: true },
  ]) {
    expectInvalid(
      () => validateTrialCredentialRecord({ ...completeRecord(), ...extra }),
      "unknown_fields",
    );
  }
});

test("record validation rejects invalid roots, versions, and states", () => {
  for (const value of [null, [], "record"]) {
    expectInvalid(() => validateTrialCredentialRecord(value), "invalid_record");
  }
  for (const [version, reason] of [
    [2, "unsupported_version"],
    [0, "invalid_version"],
    ["1", "invalid_version"],
  ]) {
    expectInvalid(
      () => validateTrialCredentialRecord(completeRecord({ version })),
      reason,
    );
  }
  for (const state of ["complete", null]) {
    expectInvalid(
      () => validateTrialCredentialRecord(completeRecord({ state })),
      "invalid_state",
    );
  }
});

test("mark and API Key formats are exact and case-sensitive where required", () => {
  for (const plugin_mark of [
    `mk_${"A".repeat(32)}`,
    `mk_${"a".repeat(31)}`,
    null,
  ]) {
    expectInvalid(
      () => validateTrialCredentialRecord(completeRecord({ plugin_mark })),
      "invalid_plugin_mark",
    );
  }
  for (const api_key of [
    `sk_${"A".repeat(42)}`,
    `sk_${"!".repeat(43)}`,
    `SK_${"A".repeat(43)}`,
    null,
  ]) {
    expectInvalid(
      () => validateTrialCredentialRecord(completeRecord({ api_key })),
      "invalid_api_key",
      [typeof api_key === "string" ? api_key : API_KEY],
    );
  }
});

test("provisioning, recovering, and ready have strict metadata shapes", () => {
  assert.deepEqual(validateTrialCredentialRecord(initialRecord()), initialRecord());
  assert.deepEqual(
    validateTrialCredentialRecord(initialRecord({ state: "recovering" })),
    initialRecord({ state: "recovering" }),
  );
  assert.deepEqual(
    validateTrialCredentialRecord(completeRecord({ state: "recovering" })),
    completeRecord({ state: "recovering" }),
  );
  assert.deepEqual(validateTrialCredentialRecord(completeRecord()), completeRecord());

  expectInvalid(
    () => validateTrialCredentialRecord(initialRecord({ state: "ready" })),
    "invalid_shape",
  );
  expectInvalid(
    () => validateTrialCredentialRecord(completeRecord({ state: "provisioning" })),
    "invalid_shape",
  );
  for (const [overrides, reason] of [
    [{ account_id: ACCOUNT_ID }, "invalid_project_id"],
    [{ account_id: ACCOUNT_ID, project_id: PROJECT_ID }, "invalid_warn_remaining_threshold"],
    [{ last_warned_level: 5000 }, "invalid_account_id"],
  ]) {
    expectInvalid(
      () => validateTrialCredentialRecord(initialRecord({ state: "recovering", ...overrides })),
      reason,
    );
  }
});

test("account and project IDs remain strict decimal strings without Number conversion", () => {
  for (const [field, value, reason] of [
    ["account_id", 9007199254740992, "invalid_account_id"],
    ["account_id", " 123 ", "invalid_account_id"],
    ["project_id", 123, "invalid_project_id"],
    ["project_id", "project-123", "invalid_project_id"],
  ]) {
    expectInvalid(
      () => validateTrialCredentialRecord(completeRecord({ [field]: value })),
      reason,
    );
  }
});

test("quota warning metadata uses safe integer thresholds and positive steps", () => {
  for (const value of [-1, 0.5, "5000"]) {
    expectInvalid(
      () => validateTrialCredentialRecord(completeRecord({ warn_remaining_threshold: value })),
      "invalid_warn_remaining_threshold",
    );
  }
  for (const value of [0, 1.5, "1000"]) {
    expectInvalid(
      () => validateTrialCredentialRecord(completeRecord({ warn_remaining_step: value })),
      "invalid_warn_remaining_step",
    );
  }

  assert.equal(validateTrialCredentialRecord(completeRecord({
    warn_remaining_threshold: 0,
    warn_remaining_step: 1,
  })).warn_remaining_threshold, 0);

  for (const [warn_remaining_threshold, warn_remaining_step] of [
    [500, 1000],
    [5000, 3000],
  ]) {
    expectInvalid(
      () => validateTrialCredentialRecord(completeRecord({
        warn_remaining_threshold,
        warn_remaining_step,
        last_warned_level: null,
      })),
      "invalid_warn_remaining_threshold",
    );
  }
});

test("last warned level is null or a positive configured reminder level", () => {
  for (const value of [null, 5000, 4000, 1000]) {
    assert.equal(
      validateTrialCredentialRecord(completeRecord({ last_warned_level: value }))
        .last_warned_level,
      value,
    );
  }
  for (const value of [0, 500.5, 3500, 6000]) {
    expectInvalid(
      () => validateTrialCredentialRecord(completeRecord({ last_warned_level: value })),
      "invalid_last_warned_level",
    );
  }
  expectInvalid(
    () => validateTrialCredentialRecord(completeRecord({
      warn_remaining_threshold: 0,
      warn_remaining_step: 1,
      last_warned_level: 1,
    })),
    "invalid_last_warned_level",
  );
});

test("register URL is HTTPS without userinfo or embedded API Keys", () => {
  const encodedApiKey = encodeURIComponent(API_KEY).replaceAll("_", "%5F");
  const nestedEncodedApiKey = encodeURIComponent(encodedApiKey);
  let deeplyEncodedApiKey = API_KEY;
  for (let index = 0; index < 12; index += 1) {
    deeplyEncodedApiKey = encodeURIComponent(deeplyEncodedApiKey).replaceAll("_", "%5F");
  }
  for (const register_url of [
    "http://platform.memorax.net/register",
    "https://user:password@platform.memorax.net/register",
    `https://platform.memorax.net/register?key=${API_KEY}`,
    `https://platform.memorax.net/register?key=${nestedEncodedApiKey}`,
    `https://platform.memorax.net/register?key=${deeplyEncodedApiKey}`,
    " https://platform.memorax.net/register",
    "not-a-url",
    null,
  ]) {
    expectInvalid(
      () => validateTrialCredentialRecord(completeRecord({ register_url })),
      "invalid_register_url",
    );
  }
  assert.equal(
    validateTrialCredentialRecord(completeRecord()).register_url,
    REGISTER_URL,
  );
  const ordinarilyEncodedUrl = "https://platform.memorax.net/register?return=%2Fwelcome%20back";
  assert.equal(
    validateTrialCredentialRecord(completeRecord({ register_url: ordinarilyEncodedUrl }))
      .register_url,
    ordinarilyEncodedUrl,
  );
});

test("provision transitions preserve local credentials and retained reminder state", () => {
  const initial = createInitialTrialCredentialRecord({
    pluginMark: PLUGIN_MARK,
    apiKey: API_KEY,
  });
  const ready = completeTrialCredentialProvisioning(initial, {
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    warnRemainingThreshold: 5000,
    warnRemainingStep: 1000,
    registerUrl: REGISTER_URL,
    lastWarnedLevel: 4000,
  });
  assert.deepEqual(ready, completeRecord({ last_warned_level: 4000 }));
  assert.equal(ready.plugin_mark, PLUGIN_MARK);
  assert.equal(ready.api_key, API_KEY);

  const recovery = beginTrialCredentialRecovery(ready, { apiKey: RECOVERY_API_KEY });
  assert.deepEqual(recovery, {
    ...ready,
    state: "recovering",
    api_key: RECOVERY_API_KEY,
  });
  const recovered = completeTrialCredentialProvisioning(recovery, {
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    warnRemainingThreshold: 5000,
    warnRemainingStep: 1000,
    registerUrl: REGISTER_URL,
  });
  assert.equal(recovered.api_key, RECOVERY_API_KEY);
  assert.equal(recovered.plugin_mark, PLUGIN_MARK);
  assert.equal(recovered.last_warned_level, 4000);

  const changedPolicy = completeTrialCredentialProvisioning(recovery, {
    projectId: PROJECT_ID,
    accountId: ACCOUNT_ID,
    warnRemainingThreshold: 3000,
    warnRemainingStep: 1000,
    registerUrl: REGISTER_URL,
  });
  assert.equal(changedPolicy.last_warned_level, null);

  expectInvalid(
    () => completeTrialCredentialProvisioning(recovery, {
      accountId: "900719925474099312345678999",
      projectId: PROJECT_ID,
      warnRemainingThreshold: 5000,
      warnRemainingStep: 1000,
      registerUrl: REGISTER_URL,
    }),
    "invalid_transition",
  );

  expectInvalid(
    () => beginTrialCredentialRecovery(initial, { apiKey: RECOVERY_API_KEY }),
    "invalid_transition",
  );
  expectInvalid(
    () => beginTrialCredentialRecovery(ready, { apiKey: API_KEY }),
    "invalid_transition",
  );
  expectInvalid(
    () => completeTrialCredentialProvisioning(ready, {}),
    "invalid_transition",
  );
});
