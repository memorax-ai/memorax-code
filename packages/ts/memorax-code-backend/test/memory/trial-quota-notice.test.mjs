import assert from "node:assert/strict";
import test from "node:test";
import {
  completeTrialCredentialProvisioning,
  createInitialTrialCredentialRecord,
} from "../../../memorax-code-adapter-common/src/credentials/trial-credential-record.mjs";
import {
  claimTrialQuotaNotice,
} from "../../dist/memory/trial-quota-notice.js";

const API_KEY = `sk_${"Q".repeat(43)}`;
const MARK_ID = `mk_${"a".repeat(64)}`;

test("trial quota notices claim lower levels once and reset after replenishment", async () => {
  let current = readyRecord();
  const transitionCredential = async (operation) => {
    const next = operation(current);
    if (next !== undefined) current = next;
    return current;
  };
  const claim = (remaining) => claimTrialQuotaNotice(
    trialConfig(),
    { featureCode: "memory_write", remaining, limit: 10_000 },
    { env: {}, transitionCredential },
  );

  const first = await claim(4_999);
  assert.match(first, /memory write quota is running low: 4999 of 10000 remaining/i);
  assert.match(first, /https:\/\/platform\.memorax\.net\//);
  assert.match(first, new RegExp(MARK_ID));
  assert.equal(current.last_warned_write_level, 5_000);
  assert.equal(await claim(4_800), undefined);
  assert.equal(current.last_warned_write_level, 5_000);
  assert.match(await claim(3_999), /3999 of 10000/);
  assert.equal(current.last_warned_write_level, 4_000);
  assert.equal(await claim(6_000), undefined);
  assert.equal(current.last_warned_write_level, null);
  assert.match(await claim(5_000), /5000 of 10000/);
});

test("write and search quota reminders are tracked independently", async () => {
  let current = readyRecord();
  const transitionCredential = async (operation) => {
    const next = operation(current);
    if (next !== undefined) current = next;
    return current;
  };
  const options = { env: {}, transitionCredential };
  assert.match(await claimTrialQuotaNotice(
    trialConfig(),
    { featureCode: "memory_write", remaining: 4_500, limit: 10_000 },
    options,
  ), /memory write quota/i);
  assert.match(await claimTrialQuotaNotice(
    trialConfig(),
    { featureCode: "memory_search", remaining: 4_500, limit: 10_000 },
    options,
  ), /memory search quota/i);
  assert.equal(current.last_warned_write_level, 5_000);
  assert.equal(current.last_warned_search_level, 5_000);
});

test("quota exhaustion emits the final zero-level notice", async () => {
  let current = readyRecord();
  const notice = await claimTrialQuotaNotice(
    trialConfig(),
    { featureCode: "memory_search", remaining: 0, limit: 10_000 },
    {
      env: {},
      transitionCredential: async (operation) => {
        current = operation(current) ?? current;
        return current;
      },
    },
  );
  assert.match(notice, /0 of 10000 remaining/);
  assert.equal(current.last_warned_search_level, 0);
});

test("quota notices ignore non-trial credentials and fail open on store errors", async () => {
  let calls = 0;
  assert.equal(await claimTrialQuotaNotice(
    { ...trialConfig(), credentialSource: undefined },
    { featureCode: "memory_search", remaining: 1, limit: 10_000 },
    { transitionCredential: async () => { calls += 1; } },
  ), undefined);
  assert.equal(calls, 0);

  const diagnostics = [];
  assert.equal(await claimTrialQuotaNotice(
    trialConfig(),
    { featureCode: "memory_search", remaining: 1, limit: 10_000 },
    {
      env: {},
      diagnosticLogger: (event) => diagnostics.push(event),
      transitionCredential: async () => { throw new Error("store unavailable"); },
    },
  ), undefined);
  assert.deepEqual(diagnostics, ["memorax_quota_notice.update_failed"]);
});

function readyRecord() {
  return completeTrialCredentialProvisioning(createInitialTrialCredentialRecord({
    markId: MARK_ID,
    markVersion: 1,
    appSalt: "memorax-plugin-v1",
    machineId: "550e8400-e29b-41d4-a716-446655440000",
    hostname: "developer-laptop",
    platform: "linux",
    arch: "x86_64",
    macHash: "c".repeat(64),
  }), {
    apiKey: API_KEY,
    accountId: "1",
    projectId: "2",
  });
}

function trialConfig() {
  return {
    credentialSource: "trial",
    apiKey: API_KEY,
  };
}
