import assert from "node:assert/strict";
import test from "node:test";
import {
  completeTrialCredentialProvisioning,
  createInitialTrialCredentialRecord,
  parseTrialCredentialRecord,
  serializeTrialCredentialRecord,
  TrialCredentialRecordError,
  validateTrialCredentialRecord,
} from "../../../ts/memorax-code-adapter-common/src/credentials/trial-credential-record.mjs";

const API_KEY = `sk_${"A".repeat(43)}`;
const IDENTITY = Object.freeze({
  markId: `mk_${"b".repeat(64)}`,
  markVersion: 1,
  appSalt: "memorax-plugin-v1",
  machineId: "550e8400-e29b-41d4-a716-446655440000",
  hostname: "DESKTOP-DEMO",
  platform: "windows",
  arch: "x86_64",
  macHash: "c".repeat(64),
});

function initialRecord() {
  return createInitialTrialCredentialRecord(IDENTITY);
}

function readyRecord() {
  return completeTrialCredentialProvisioning(initialRecord(), {
    apiKey: API_KEY,
    accountId: "341599238100099072",
    projectId: "347677365196820482",
  });
}

test("credential provisioning stores device identity before the backend-generated API Key", () => {
  assert.deepEqual(initialRecord(), {
    version: 1,
    state: "provisioning",
    mark_id: IDENTITY.markId,
    mark_version: 1,
    app_salt: IDENTITY.appSalt,
    machine_id: IDENTITY.machineId,
    hostname: IDENTITY.hostname,
    platform: IDENTITY.platform,
    arch: IDENTITY.arch,
    mac_hash: IDENTITY.macHash,
    api_key: null,
    account_id: null,
    project_id: null,
    last_warned_write_level: null,
    last_warned_search_level: null,
  });
});

test("credential provisioning commits the backend response without changing identity", () => {
  const ready = readyRecord();
  assert.equal(ready.state, "ready");
  assert.equal(ready.api_key, API_KEY);
  assert.equal(ready.account_id, "341599238100099072");
  assert.equal(ready.project_id, "347677365196820482");
  assert.equal(ready.mark_id, IDENTITY.markId);
});

test("credential records serialize deterministically and reject unknown fields", () => {
  const ready = readyRecord();
  assert.deepEqual(parseTrialCredentialRecord(serializeTrialCredentialRecord(ready)), ready);
  assert.throws(
    () => validateTrialCredentialRecord({ ...ready, client_api_key: API_KEY }),
    recordError("unknown_fields"),
  );
});

test("credential records reject invalid identity and state shapes", () => {
  const initial = initialRecord();
  const fixtures = [
    [{ ...initial, mark_id: `mk_${"b".repeat(32)}` }, "invalid_mark_id"],
    [{ ...initial, mark_version: 2 }, "invalid_mark_version"],
    [{ ...initial, app_salt: "package@1.0.0" }, "invalid_app_salt"],
    [{ ...initial, machine_id: "contains spaces" }, "invalid_machine_id"],
    [{ ...initial, hostname: "" }, "invalid_hostname"],
    [{ ...initial, platform: "darwin" }, "invalid_platform"],
    [{ ...initial, arch: "x64" }, "invalid_arch"],
    [{ ...initial, mac_hash: "c".repeat(63) }, "invalid_mac_hash"],
    [{ ...initial, api_key: API_KEY }, "invalid_shape"],
    [{ ...readyRecord(), api_key: null }, "invalid_api_key"],
    [{ ...readyRecord(), account_id: null }, "invalid_account_id"],
  ];
  for (const [record, reason] of fixtures) {
    assert.throws(() => validateTrialCredentialRecord(record), recordError(reason));
  }
});

test("ready credentials accept independent write and search reminder levels", () => {
  const ready = validateTrialCredentialRecord({
    ...readyRecord(),
    last_warned_write_level: 4_000,
    last_warned_search_level: 0,
  });
  assert.equal(ready.last_warned_write_level, 4_000);
  assert.equal(ready.last_warned_search_level, 0);
  assert.throws(
    () => validateTrialCredentialRecord({ ...ready, last_warned_write_level: -1 }),
    recordError("invalid_last_warned_level"),
  );
});

test("only provisioning records can transition to ready", () => {
  assert.throws(
    () => completeTrialCredentialProvisioning(readyRecord(), {
      apiKey: API_KEY,
      accountId: "1",
      projectId: "2",
    }),
    recordError("invalid_transition"),
  );
});

function recordError(reason) {
  return (error) => {
    assert.ok(error instanceof TrialCredentialRecordError);
    assert.equal(error.reason, reason);
    assert.equal(error.message.includes(API_KEY), false);
    return true;
  };
}
