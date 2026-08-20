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
